"""Read-only, CPU speaker-identity comparison of matched A/B/C listening WAVs.

Cosine scores are NOT naturalness, graininess, or perceptual-quality scores.
Run each encoder separately; embeddings and source hashes make aggregation auditable.
"""
import argparse
import csv
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import time

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, obj):
    Path(path).write_text(json.dumps(obj, indent=2), encoding="utf-8")


def files(manifest):
    for ch in manifest["characters"]:
        yield ch, "reference", None, ch["reference"]
        for arm in "ABC":
            for item in ch[arm]:
                yield ch, arm, item["text_index"], item


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--encoder", choices=["wavlm", "ecapa"], required=True)
    p.add_argument("--revision", help="Hugging Face revision; use the exact commit SHA from a prior receipt for reproducible reruns.")
    p.add_argument("--threads", type=int, default=2)
    p.add_argument("--mode", choices=["full", "long-center", "extra-only"], default="full")
    p.add_argument("--model-cache", type=Path)
    p.add_argument("--extra-references", type=Path)
    args = p.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    manifest_path = args.input / "samples.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    jobs = list(files(manifest))
    if args.mode == "long-center":
        jobs = [j for j in jobs if j[1] == "reference" or j[2] == 1]
    elif args.mode == "extra-only":
        jobs = []
    windows = {ch["id"]: min(6.0, ch["reference"]["duration_seconds"], *(item["audio_duration_seconds"] for arm in "ABC" for item in ch[arm] if item["text_index"] == 1)) for ch in manifest["characters"]}
    if args.extra_references:
        extra = json.loads(args.extra_references.read_text(encoding="utf-8"))
        by_char = {ch["id"]: ch for ch in manifest["characters"]}
        jobs += [(by_char[r["character"]], "heldout", None, r) for r in extra["references"]]
    if (args.output / f"{args.encoder}-embeddings.jsonl").exists():
        raise RuntimeError("Existing embedding output: preserve it and use another output folder.")
    import torch
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    # Initialize Torch introspection before SpeechBrain registers lazy optional modules.
    import torch.distributed.tensor
    from huggingface_hub import HfApi, snapshot_download
    repo = {"wavlm": "microsoft/wavlm-base-plus-sv", "ecapa": "speechbrain/spkrec-ecapa-voxceleb"}[args.encoder]
    revision = HfApi().model_info(repo, revision=args.revision or "main").sha
    allow = ["config.json", "preprocessor_config.json", "pytorch_model.bin", "model.safetensors", "README.md"] if args.encoder == "wavlm" else ["hyperparams.yaml", "embedding_model.ckpt", "classifier.ckpt", "mean_var_norm_emb.ckpt", "README.md", "custom.py"]
    print(json.dumps({"phase": "download", "encoder": args.encoder, "revision": revision}), flush=True)
    snapshot = Path(snapshot_download(repo, revision=revision, allow_patterns=allow, cache_dir=args.model_cache or args.output / "model-cache"))
    if args.encoder == "wavlm":
        from transformers import Wav2Vec2FeatureExtractor, WavLMForXVector
        processor = Wav2Vec2FeatureExtractor.from_pretrained(snapshot)
        model = WavLMForXVector.from_pretrained(snapshot).cpu().eval()

        def embed(audio):
            inputs = processor(audio, sampling_rate=16000, return_tensors="pt")
            return model(**inputs).embeddings[0]
    else:
        from speechbrain.inference.speaker import EncoderClassifier
        from speechbrain.utils.fetching import LocalStrategy
        model = EncoderClassifier.from_hparams(source=str(snapshot), savedir=str(args.output / "ecapa-local"), run_opts={"device": "cpu"}, local_strategy=LocalStrategy.COPY)
        model.eval()

        def embed(audio):
            return model.encode_batch(torch.from_numpy(audio).unsqueeze(0)).reshape(-1)
    receipt = {"encoder": args.encoder, "model_repo": repo, "model_revision": revision, "device": "cpu", "dtype": "float32", "threads": args.threads, "manifest_sha256": sha(manifest_path), "script_sha256": sha(__file__), "preprocessing": "soundfile float32 decode; channel mean; scipy resample_poly to16kHz; full utterance; no trim/denoise/loudness processing", "versions": {k: importlib.metadata.version(k) for k in ["torch", "transformers", "speechbrain", "soundfile", "numpy", "scipy"]}, "model_files": {x.name: sha(x) for x in snapshot.iterdir() if x.is_file()}}
    receipt.update({"requested_revision": args.revision or "main", "mode": args.mode, "extra_references_sha256": sha(args.extra_references) if args.extra_references else None, "center_window_seconds_by_character": windows if args.mode == "long-center" else None})
    if args.mode == "long-center":
        receipt['preprocessing'] = receipt['preprocessing'].replace('full utterance', 'center window; duration matched within character across reference and A/B/C long clips')
    write_json(args.output / f"{args.encoder}-receipt.json", receipt)
    rows = []
    started = time.monotonic()
    with torch.inference_mode():
        for i, (ch, arm, prompt, item) in enumerate(jobs):
            path = args.input / item["file"]
            digest = sha(path)
            assert digest == item.get("audio_sha256", item.get("sha256")), f"Source hash mismatch: {path}"
            audio, sr = sf.read(path, dtype="float32", always_2d=True)
            mono = audio.mean(axis=1)
            assert np.isfinite(mono).all()
            original_seconds = len(mono) / sr
            if sr != 16000:
                import math
                gcd = math.gcd(sr, 16000)
                mono = resample_poly(mono, 16000 // gcd, sr // gcd).astype(np.float32)
            if args.mode == "long-center":
                size = min(len(mono), int(windows[ch["id"]] * 16000))
                start = (len(mono) - size) // 2
                mono = mono[start:start + size]
            vector = embed(mono).detach().cpu().numpy()
            vector /= np.linalg.norm(vector)
            row = {"character": ch["id"], "name": ch["display_name"], "tier": 1, "arm": arm, "prompt": prompt, "file": item["file"], "sha256": digest, "duration_seconds": original_seconds, "metric_input_seconds": len(mono) / 16000, "C_reference_only_fallback": ch["C_reference_only_fallback"], "embedding": vector.tolist()}
            rows.append(row)
            with (args.output / f"{args.encoder}-embeddings.jsonl").open("a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
            print(json.dumps({"phase": "embedded", "encoder": args.encoder, "done": i + 1, "total": len(jobs), "character": ch["id"], "arm": arm, "elapsed_seconds": round(time.monotonic() - started, 2)}), flush=True)
    if args.mode != "extra-only":
        aggregate(args.output, args.encoder, rows)
    else:
        print(json.dumps({"phase": "complete", "encoder": args.encoder, "extra_references": len(rows)}), flush=True)


def aggregate(output, encoder, rows):
    refs = {r["character"]: np.asarray(r["embedding"]) for r in rows if r["arm"] == "reference"}
    scores = []
    for row in rows:
        if row["arm"] not in "ABC":
            continue
        vector = np.asarray(row["embedding"])
        own = float(vector @ refs[row["character"]])
        impostors = {k: float(vector @ v) for k, v in refs.items() if k != row["character"]}
        strongest = max(impostors, key=impostors.get)
        scores.append({k: v for k, v in row.items() if k != "embedding"} | {"cosine_to_clone_reference": own, "max_other_cast_cosine": impostors[strongest], "nearest_other_character": strongest, "identity_margin": own - impostors[strongest], "own_reference_top1": own > impostors[strongest]})
    with (output / f"{encoder}-scores.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(scores[0]))
        writer.writeheader()
        writer.writerows(scores)
    chars = sorted(refs)
    means = {arm: np.array([np.mean([r["cosine_to_clone_reference"] for r in scores if r["arm"] == arm and r["character"] == ch]) for ch in chars]) for arm in "ABC"}
    rng = np.random.default_rng(20261004)
    draws = rng.integers(0, len(chars), size=(10000, len(chars)))
    pairs = {}
    for x, y in [("B", "A"), ("C", "A"), ("C", "B")]:
        delta = means[x] - means[y]
        boot = delta[draws].mean(axis=1)
        pairs[f"{x}-{y}"] = {"mean_cosine_delta": float(delta.mean()), "character_bootstrap_95_percentile_interval": np.quantile(boot, [.025, .975]).tolist(), "characters_positive": int((delta > 0).sum()), "characters_negative": int((delta < 0).sum()), "by_character": dict(zip(chars, delta.tolist()))}
    summary = {"encoder": encoder, "characters": len(chars), "generated_clips": len(scores), "prompts_per_character": len({r['prompt'] for r in scores}), "seeds_per_prompt": 1, "reference_type": "same original reference used for cloning, NOT independent held-out voice recordings", "character_balanced_mean_cosine": {a: float(v.mean()) for a, v in means.items()}, "character_balanced_mean_identity_margin": {a: float(np.mean([r["identity_margin"] for r in scores if r["arm"] == a])) for a in "ABC"}, "top1_count": {a: sum(r["own_reference_top1"] for r in scores if r["arm"] == a) for a in "ABC"}, "paired_differences": pairs, "limits": ["Speaker identity proxy only; not naturalness, graininess, pacing, WER or human preference.", "One cloning reference per character; same reference is used to generate and evaluate, so optimistic reference dependence is possible.", "Two prompts and one seed each cannot estimate generation variance.", "Bootstrap resamples characters, preserving paired prompts. Tier 1 cast is fixed, not a random population sample.", "All24 evaluated characters are Tier1; no inference to Tier2/3 quality.", "Wakako and Padre have reference-only fallback in C."]}
    write_json(output / f"{encoder}-summary.json", summary)
    print(json.dumps({"phase": "complete", "encoder": encoder, "mean_cosine": summary["character_balanced_mean_cosine"], "top1": summary["top1_count"]}), flush=True)


if __name__ == "__main__":
    main()
