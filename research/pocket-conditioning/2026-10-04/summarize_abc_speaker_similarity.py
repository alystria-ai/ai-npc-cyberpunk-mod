"""Summarize paired, character-balanced identity metrics without promoting a model."""
import argparse
import collections
import csv
import hashlib
import json
from pathlib import Path
import numpy as np


def load_rows(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def verify_identity_joins(root):
    """Reject mixed encoders, source panels or partial cross-mode comparisons.

    Original full-v1 receipts predate the explicit mode field; only that root
    mode may omit it. This reads receipts/embeddings and never rewrites them.
    """
    expected_repos = {"wavlm": "microsoft/wavlm-base-plus-sv", "ecapa": "speechbrain/spkrec-ecapa-voxceleb"}
    modes = {"full": root, "long-center": root / "long-center", "extra-only": root / "independent-references"}
    base_receipts = {}
    mode_identities = {}
    manifest_hash = None
    extra_reference_hash = None
    verified_receipts = {}
    for mode, folder in modes.items():
        present = [(folder / f"{enc}-embeddings.jsonl").exists() for enc in expected_repos]
        if mode != "full" and not any(present):
            continue
        if not all(present):
            raise ValueError(f"Incomplete encoder pair for mode {mode}")
        mode_identities[mode] = {}
        for enc, repo in expected_repos.items():
            receipt_path = folder / f"{enc}-receipt.json"
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            if receipt.get("encoder") != enc or receipt.get("model_repo") != repo:
                raise ValueError(f"Encoder identity mismatch: {receipt_path}")
            if receipt.get("mode", "full") != mode:
                raise ValueError(f"Evaluation mode mismatch: {receipt_path}")
            if not receipt.get("model_revision") or not receipt.get("manifest_sha256"):
                raise ValueError(f"Missing model/source identity: {receipt_path}")
            if manifest_hash is None:
                manifest_hash = receipt["manifest_sha256"]
            if receipt["manifest_sha256"] != manifest_hash:
                raise ValueError(f"Source manifest mismatch: {receipt_path}")
            if mode == "full":
                base_receipts[enc] = receipt
            else:
                for field in ["model_repo", "model_revision", "model_files", "manifest_sha256", "device", "dtype"]:
                    if receipt.get(field) != base_receipts[enc].get(field):
                        raise ValueError(f"Cross-mode {field} mismatch: {receipt_path}")
            if mode == "extra-only":
                if not receipt.get("extra_references_sha256"):
                    raise ValueError(f"Missing independent-reference manifest identity: {receipt_path}")
                if extra_reference_hash is None:
                    extra_reference_hash = receipt["extra_references_sha256"]
                if receipt["extra_references_sha256"] != extra_reference_hash:
                    raise ValueError(f"Independent-reference manifest mismatch: {receipt_path}")
            rows = load_rows(folder / f"{enc}-embeddings.jsonl")
            identities = {(r["character"], r["arm"], r["prompt"], r["file"], r["sha256"]) for r in rows}
            if len(identities) != len(rows):
                raise ValueError(f"Duplicate embedding source identity: {folder}/{enc}")
            mode_identities[mode][enc] = identities
            verified_receipts[f"{mode}/{enc}"] = hashlib.sha256(receipt_path.read_bytes()).hexdigest()
        if mode_identities[mode]["wavlm"] != mode_identities[mode]["ecapa"]:
            raise ValueError(f"Cross-encoder audio source mismatch in mode {mode}")
    if "long-center" in mode_identities:
        expected = {r for r in mode_identities["full"]["wavlm"] if r[1] == "reference" or r[2] == 1}
        if mode_identities["long-center"]["wavlm"] != expected:
            raise ValueError("Duration sensitivity is not the same reference/long source panel")
    return {"manifest_sha256": manifest_hash, "extra_references_sha256": extra_reference_hash, "receipt_sha256": verified_receipts}


def evaluate(rows, refs, prompt, selected=None):
    selected = set(selected or refs)
    scores = []
    for r in rows:
        if r["arm"] not in "ABC" or r["character"] not in selected or (prompt is not None and r["prompt"] != prompt):
            continue
        v = np.asarray(r["embedding"])
        scores.append({"character": r["character"], "arm": r["arm"], "prompt": r["prompt"], "cosine": float(np.mean([v @ x for x in refs[r["character"]]]))})
    chars = sorted({s["character"] for s in scores})
    if not chars:
        return None
    means = {a: np.array([np.mean([s["cosine"] for s in scores if s["character"] == c and s["arm"] == a]) for c in chars]) for a in "ABC"}
    rng = np.random.default_rng(20261004)
    draws = rng.integers(0, len(chars), (10000, len(chars)))
    pairs = {}
    for x, y in [("B", "A"), ("C", "A"), ("C", "B")]:
        delta = means[x] - means[y]
        pairs[f"{x}-{y}"] = {"mean_delta": float(delta.mean()), "ci95_character_bootstrap": np.quantile(delta[draws].mean(axis=1), [.025, .975]).tolist(), "positive_characters": int((delta > 0).sum()), "negative_characters": int((delta < 0).sum())}
    return {"characters": chars, "n": len(chars), "generated_clips": len(scores), "mean": {a: float(v.mean()) for a, v in means.items()}, "pairwise": pairs, "per_character": {c: {a: float(means[a][i]) for a in "ABC"} for i, c in enumerate(chars)}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--train-manifest", type=Path, required=True)
    args = parser.parse_args()
    root = args.output
    identity_joins = verify_identity_joins(root)
    train = load_rows(args.train_manifest)
    counts = collections.Counter(r.get("character", r.get("speaker_id")) for r in train)
    result = {"schema": "abc_speaker_similarity_summary_v1", "primary_endpoint": "long prompt, full utterance cosine to exact clone reference, character balanced", "tier": 1, "training_manifest_sha256": hashlib.sha256(args.train_manifest.read_bytes()).hexdigest(), "identity_joins": identity_joins, "models": {}}
    for enc in ["wavlm", "ecapa"]:
        rows = load_rows(root / f"{enc}-embeddings.jsonl")
        assert len(rows) == 168 and len({r['file'] for r in rows}) == 168
        refs = {r["character"]: [np.asarray(r["embedding"])] for r in rows if r["arm"] == "reference"}
        groups = {"zero_training_rows": [c for c in refs if counts[c] == 0], "one_to_fourteen_training_rows": [c for c in refs if 1 <= counts[c] <= 14], "fifteen_plus_training_rows": [c for c in refs if counts[c] >= 15]}
        model = {"full_long_primary": evaluate(rows, refs, 1), "full_short_secondary": evaluate(rows, refs, 0), "full_both_prompts": evaluate(rows, refs, None), "long_by_training_count": {k: evaluate(rows, refs, 1, v) for k, v in groups.items() if v}}
        sensitivity = root / "long-center" / f"{enc}-embeddings.jsonl"
        if sensitivity.exists():
            sr = load_rows(sensitivity)
            assert len(sr) == 96
            rr = {r['character']: [np.asarray(r['embedding'])] for r in sr if r['arm'] == 'reference'}
            model['duration_matched_long_sensitivity'] = evaluate(sr, rr, 1)
        independent = root / "independent-references" / f"{enc}-embeddings.jsonl"
        if independent.exists():
            ir = load_rows(independent)
            assert len(ir) == 14
            rr = collections.defaultdict(list)
            for r in ir:
                rr[r['character']].append(np.asarray(r['embedding']))
            model['independent_reference_long_subset'] = evaluate(rows, rr, 1)
            model['independent_reference_short_subset'] = evaluate(rows, rr, 0)
            genuine = {}
            for ch, vectors in rr.items():
                values = [float(refs[ch][0] @ vector) for vector in vectors]
                genuine[ch] = {'clone_reference_to_other_original_mean': float(np.mean(values)), 'individual_cosines': values, 'original_pair_cosine': float(vectors[0] @ vectors[1]) if len(vectors) == 2 else None}
            model['genuine_reference_calibration'] = {'per_character': genuine, 'mean_clone_reference_to_other_original_cosine': float(np.mean([v['clone_reference_to_other_original_mean'] for v in genuine.values()])), 'scope': 'Nine-character calibration context, different real lines/acting/recording conditions; not a target cutoff or quality score.'}
        result["models"][enc] = model
    chars = result["models"]["wavlm"]["full_long_primary"]["characters"]
    result["train_recordings_per_character"] = {c: counts[c] for c in chars}
    result["encoder_disagreement"] = {}
    for endpoint in ["full_long_primary", "full_short_secondary", "duration_matched_long_sensitivity", "independent_reference_long_subset"]:
        if any(endpoint not in result['models'][e] for e in ['wavlm', 'ecapa']):
            continue
        left = result['models']['wavlm'][endpoint]['per_character']
        right = result['models']['ecapa'][endpoint]['per_character']
        result['encoder_disagreement'][endpoint] = {"different_rank1": [c for c in left if max(left[c], key=left[c].get) != max(right[c], key=right[c].get)], "agreement_count": sum(max(left[c], key=left[c].get) == max(right[c], key=right[c].get) for c in left), "n": len(left)}
    (root / 'comparison-summary.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    flat = []
    for c in chars:
        row = {'character': c, 'tier': 1, 'train_recordings': counts[c]}
        for enc, model in result['models'].items():
            for endpoint, values in model.items():
                if 'mean' not in values or 'per_character' not in values or c not in values['per_character']:
                    continue
                for arm, val in values['per_character'][c].items():
                    row[f'{enc}_{endpoint}_{arm}'] = val
        flat.append(row)
    fields = list(dict.fromkeys(k for r in flat for k in r))
    with (root / 'all-24-character-scores.csv').open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(flat)
    print(json.dumps({enc: {k: {'mean': v['mean'], 'pairwise': v['pairwise'], 'n': v['n']} for k, v in model.items() if 'mean' in v} for enc, model in result['models'].items()}, indent=2))


if __name__ == '__main__':
    main()
