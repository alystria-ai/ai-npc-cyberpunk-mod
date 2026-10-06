"""Build the Pocket v2 training payload (policy pocket_crossref_teacher_v1). Local, CPU only.

    python scripts/pocket_training/v2_corpus.py --out E:/CyberpunkConvai-offload/work/pocket-v2/payload [--dry-run]

Inputs (read only):
  * the full-A corpus (all five splits; 48 kHz audio stays on Kaggle in the existing private full-A input dataset),
  * the decoder agent's clean pool list (mimi-dec/v2/pool-train.jsonl) and each voice's pool manifest (subtitle text),
  * the merged effect exclusions (scripts/phone_detect/effect-exclusions.json),
  * the October 5 likeness panel fences (evaluation lines, alts, reference/multi-clip members: the T panel).
Writes:
  * corpus.json: training rows, D/Z panels, reference-eligible pools, the reference bank (clip lists), speaker weights,
  * pool-audio.tar: the pool clips that are used, as 24 kHz mono FLAC (pool/<voice>/<sid>.flac),
  * receipt.json: counts, hours, fences and the input hashes.
Nothing under the inputs is modified. See docs/POCKET_NEXT_RUN_PLAN.md sections 2-3.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import io
import json
import math
import random
import re
import tarfile
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENTRY = ROOT / "runtime/voice-data-expansion-20261004/final-corpus-assembly/final-entries/final-entry-v5-001"
SPLITS = ("train", "dev", "test", "teacher_regression", "teacher_conditional")
POOL_LIST = Path("E:/CyberpunkConvai-offload/work/mimi-dec/v2/pool-train.jsonl")
POOL_ROOT = Path("E:/CyberpunkConvai-offload/work/reference-pool-expanded")
EFFECTS = ROOT / "scripts/phone_detect/effect-exclusions.json"
LIKENESS = Path("E:/CyberpunkConvai-offload/work/likeness-phase1/out")
SHOWN = ROOT / "scripts/reference-picker/shown-voices.json"
POLICY = "pocket_crossref_teacher_v1"
GAP_SECONDS = 0.4                       # runtime join (scripts/clip-search/common.py)
CAPS = {1: 9.0, 2: 10.0, 3: 18.0}       # picker caps: one clip, two clips (short set), three clips (18 s set)
BANK_SETS = 32                          # per voice per clip count
SPEAKER_CAP = 300                       # p(voice) ~ min(clips, 300)
ZERO_SHOT = ("kurt-hansen", "rosalind-myers", "joshua", "fingers")
MAX_TARGET_SECONDS = 20.0
SEED = 20261006


def speaker_key(row: dict) -> str:
    for field in ("character", "speaker", "speaker_id", "character_id"):
        if row.get(field) is not None:
            return str(row[field])
    return "unknown"


def sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 22), b""):
            digest.update(block)
    return digest.hexdigest()


TAGS = re.compile(r"<[^>]*>|\[[^\]]*\]|\{[^}]*\}")


def clean_text(text: str) -> str | None:
    """Rule-based subtitle normalisation. None means: do not train on this row."""
    value = unicodedata.normalize("NFKC", TAGS.sub(" ", str(text)))
    value = (value.replace("\u2019", "'").replace("\u2018", "'").replace("\u201c", '"').replace("\u201d", '"')
             .replace("\u2014", " - ").replace("\u2013", " - "))
    value = re.sub(r"\s+", " ", value).strip()
    if not value or re.search(r"\d", value):
        return None
    letters = [c for c in value if c.isalpha()]
    if not letters or any(ord(c) > 0x24F for c in letters):  # Latin only
        return None
    return value


def scene_of(row: dict) -> str:
    scenes = row.get("scenes") or []
    if scenes:
        return "fa:" + re.split(r"[\\/]", scenes[0])[-1].removesuffix(".scene")
    return "fa:" + str(row.get("scene_id") or row["id"])


def t_panel_fence() -> tuple[set[str], set[str]]:
    """(ids that may never be trained on or used as references, voices in T)."""
    panel = json.loads((LIKENESS / "panel.json").read_text(encoding="utf-8"))
    ids = {t["id"] for e in panel.values() for t in e["targets"]} | {a["id"] for e in panel.values() for a in e["alts"]}
    ids |= set(json.loads((LIKENESS / "exclude-ids.json").read_text(encoding="utf-8")))
    for name in ("sets.json", "sets10.json"):
        for group in json.loads((LIKENESS / "multiref" / name).read_text(encoding="utf-8")).values():
            for engine in group.values():
                for item in engine.values():
                    ids |= {c for c in item.get("clips", []) if c != "runtime-reference"}
    return ids, set(panel)


def load_rows() -> tuple[list[dict], dict]:
    effects = set(json.loads(EFFECTS.read_text(encoding="utf-8"))["clips"])
    fence, _ = t_panel_fence()
    stats = collections.Counter()
    rows: list[dict] = []
    seen: set[str] = set()
    for split in SPLITS:
        for line in (ENTRY / "data" / f"{split}.jsonl").read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            if r["id"] in seen:
                continue
            seen.add(r["id"])
            if r["id"] in effects:
                stats["fa_effect"] += 1; continue
            if r["id"] in fence:
                stats["fa_t_fence"] += 1; continue
            text = clean_text(r.get("training_transcript") or r["transcript"])
            if text is None:
                stats["fa_text"] += 1; continue
            if float(r["duration"]) > MAX_TARGET_SECONDS or float(r["duration"]) < 1.0:
                stats["fa_duration"] += 1; continue
            words = r.get("words") if isinstance(r.get("words"), list) else None
            rows.append({"id": r["id"], "voice": speaker_key(r), "src": "fa", "path": r["path"],
                         "dur": round(float(r["duration"]), 4), "text": text, "scene": scene_of(r),
                         "words": [{"word": w["word"], "start": w.get("start"), "end": w.get("end")} for w in words] if words else None})
    pool_ids = [json.loads(l)["id"] for l in POOL_LIST.read_text(encoding="utf-8").splitlines() if l.strip()]
    manifests: dict[str, dict] = {}
    for clip_id in pool_ids:
        voice = clip_id.split("/")[0]
        if voice not in manifests:
            m = json.loads((POOL_ROOT / voice / "manifest.json").read_text(encoding="utf-8"))
            manifests[voice] = {c["id"]: c for c in m["clips"]}
        c = manifests[voice].get(clip_id)
        if c is None:
            stats["pool_missing"] += 1; continue
        if clip_id in seen:
            stats["pool_duplicate"] += 1; continue
        seen.add(clip_id)
        if clip_id in effects:
            stats["pool_effect"] += 1; continue
        if clip_id in fence:
            stats["pool_t_fence"] += 1; continue
        text = clean_text(c.get("t", ""))
        if text is None:
            stats["pool_text"] += 1; continue
        rows.append({"id": clip_id, "voice": voice, "src": "pool", "path": f"pool/{voice}/{c['sid']}.flac",
                     "local": c["path"], "dur": round(float(c["d"]), 4), "text": text,
                     "scene": "pool:" + str(c.get("stem") or c["sid"]), "words": None})
    return rows, dict(stats)


def joined(durations: list[float]) -> float:
    return sum(durations) + max(0, len(durations) - 1) * GAP_SECONDS


def build_sets(rng: random.Random, clips: list[dict], k: int, count: int) -> list[list[str]]:
    eligible = [c for c in clips if 1.5 <= c["dur"] <= CAPS[1]]
    if len(eligible) < k:
        return []
    out, tries, keys = [], 0, set()
    while len(out) < count and tries < count * 40:
        tries += 1
        pick = rng.sample(eligible, k)
        if joined([c["dur"] for c in pick]) > CAPS[k]:
            continue
        key = tuple(sorted(c["id"] for c in pick))
        if key in keys and tries < count * 20:
            continue
        keys.add(key)
        out.append([c["id"] for c in pick])
    return out


def build(dry_run: bool, out: Path) -> dict:
    rng = random.Random(SEED)
    rows, stats = load_rows()
    by_voice: dict[str, list[dict]] = collections.defaultdict(list)
    for r in rows:
        by_voice[r["voice"]].append(r)
    _, t_voices = t_panel_fence()
    runtime_voices = set(json.loads((ROOT / "runtime/pocket-voices.json").read_text(encoding="utf-8-sig"))["voices"])
    shown = set(json.loads(SHOWN.read_text(encoding="utf-8")))
    panels = {"D": {}, "Z": {}}
    role: dict[str, str] = {}
    # Z: whole voices held out.
    for voice in ZERO_SHOT:
        clips = sorted(by_voice.get(voice, []), key=lambda r: r["id"])
        if len(clips) < 12:
            continue
        rng.shuffle(clips)
        lines = [c for c in clips if 2.5 <= c["dur"] <= 9 and len(c["text"].split()) >= 5][:3]
        refs = next((s for s in build_sets(rng, [c for c in clips if c not in lines], 3, 1)), None)
        if len(lines) < 3 or not refs:
            continue
        panels["Z"][voice] = {"lines": [c["id"] for c in lines], "refs": {"3": refs},
                              "centroid": [c["id"] for c in clips if c not in lines and c["id"] not in refs][:40]}
        for c in clips:
            role[c["id"]] = "Z"
    # D: two new held-out lines per voice with enough clips, plus fenced 1-clip and 3-clip references.
    for voice in sorted(by_voice):
        if voice in panels["Z"]:
            continue
        clips = sorted(by_voice[voice], key=lambda r: r["id"])
        if len(clips) < 20:
            continue
        rng.shuffle(clips)
        prefer = [c for c in clips if c["src"] == "pool"] + [c for c in clips if c["src"] != "pool"]
        lines = [c for c in prefer if 2.5 <= c["dur"] <= 9 and len(c["text"].split()) >= 6][:2]
        if len(lines) < 2:
            continue
        line_scenes = {c["scene"] for c in lines}
        rest = [c for c in clips if c not in lines and c["scene"] not in line_scenes] or [c for c in clips if c not in lines]
        three = build_sets(rng, rest, 3, 1)
        if not three:
            continue
        one = [three[0][0]]
        panels["D"][voice] = {"lines": [c["id"] for c in lines], "refs": {"1": one, "3": three[0]},
                              "shown": voice in shown, "runtime": voice in runtime_voices, "in_t": voice in t_voices}
        for c in lines:
            role[c["id"]] = "D"
        for cid in three[0]:
            role[cid] = "Dref"
    # Training rows, reference-eligible pools and the bank.
    train = [r for r in rows if r["id"] not in role]
    by_train: dict[str, list[dict]] = collections.defaultdict(list)
    for r in train:
        by_train[r["voice"]].append(r)
    bank: dict[str, dict[str, list[list[str]]]] = {}
    for voice, clips in sorted(by_train.items()):
        clips = sorted(clips, key=lambda r: r["id"])
        sets = {str(k): build_sets(rng, clips, k, BANK_SETS) for k in (1, 2, 3)}
        if any(sets.values()):
            bank[voice] = sets
    for voice, entry in panels["D"].items():  # centroids from training clips only (never the line or its refs)
        entry["centroid"] = [c["id"] for c in sorted(by_train.get(voice, []), key=lambda r: r["id"])][:40]
    weights = {voice: min(len(clips), SPEAKER_CAP) for voice, clips in sorted(by_train.items()) if voice in bank}
    used_ids = {r["id"] for r in train} | set(role)
    used_rows = [r for r in rows if r["id"] in used_ids]
    hours = sum(r["dur"] for r in train) / 3600
    receipt = {
        "schema": "pocket_v2_corpus_v1", "policy": POLICY, "seed": SEED,
        "inputs": {"effects_sha256": sha_file(EFFECTS), "pool_list_sha256": sha_file(POOL_LIST),
                   "panel_sha256": sha_file(LIKENESS / "panel.json"), "exclude_ids_sha256": sha_file(LIKENESS / "exclude-ids.json")},
        "filtered": stats, "train_rows": len(train), "train_hours": round(hours, 2),
        "train_by_source": dict(collections.Counter(r["src"] for r in train)),
        "voices_trained": len(weights), "D_voices": len(panels["D"]), "Z_voices": sorted(panels["Z"]),
        "bank_sets": sum(len(s) for v in bank.values() for s in v.values()),
        "aligned_prefix_rows": sum(1 for r in train if r["words"]),
        "weights_sum": sum(weights.values()),
        "passes_per_clip_at_1500_updates_capped_voices": round(1500 * 64 / max(1, sum(weights.values())), 2),
    }
    # Fence checks: nothing fenced is trained on or appears in any bank set.
    fence, _ = t_panel_fence()
    panel_ids = set(role)
    bank_ids = {cid for v in bank.values() for s in v.values() for item in s for cid in item}
    train_ids = {r["id"] for r in train}
    assert not (train_ids & fence) and not (bank_ids & fence), "T fence leaked"
    assert not (train_ids & panel_ids) and not (bank_ids & panel_ids), "D/Z fence leaked"
    assert bank_ids <= train_ids
    receipt["fence_checks"] = "passed"
    if dry_run:
        return receipt
    out.mkdir(parents=True, exist_ok=True)
    pool_used = [r for r in used_rows if r["src"] == "pool"]
    import numpy as np
    import soundfile as sf
    tar_path = out / "pool-audio.tar"
    temporary = tar_path.with_suffix(".tar.partial")
    with tarfile.open(temporary, "w") as tar:
        for i, r in enumerate(pool_used):
            data, rate = sf.read(r["local"], dtype="float32", always_2d=True)
            if rate != 24000:
                raise ValueError(f"{r['id']}: pool clips are expected at 24 kHz")
            buffer = io.BytesIO()
            sf.write(buffer, data.mean(1), 24000, format="FLAC", subtype="PCM_16")
            payload = buffer.getvalue()  # BytesIO.tell() is not the FLAC size after soundfile writes
            info = tarfile.TarInfo(r["path"]); info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))
            if i % 2000 == 0:
                print(json.dumps({"flac": i, "of": len(pool_used)}), flush=True)
    temporary.replace(tar_path)
    for r in used_rows:
        r.pop("local", None)
    corpus = {"schema": "pocket_v2_corpus_v1", "policy": POLICY, "gap_seconds": GAP_SECONDS, "caps": CAPS,
              "rows": used_rows, "roles": role, "panels": panels, "bank": bank, "weights": weights}
    (out / "corpus.json").write_text(json.dumps(corpus, ensure_ascii=False), encoding="utf-8")
    receipt["corpus_sha256"] = sha_file(out / "corpus.json")
    receipt["pool_audio_sha256"] = sha_file(tar_path)
    receipt["pool_clips"] = len(pool_used)
    (out / "receipt.json").write_text(json.dumps(receipt, indent=1), encoding="utf-8")
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("E:/CyberpunkConvai-offload/work/pocket-v2/payload"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    print(json.dumps(build(args.dry_run, args.out), indent=1))
