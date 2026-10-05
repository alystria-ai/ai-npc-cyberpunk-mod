"""Build the clip-pool index for scripts/Reference-Picker.mjs (read-only on every input).

Writes <work>/pool-index.json.  Run with vendor/reference-voicestudio/.venv/Scripts/python.exe (it needs
torch to read the research agent's ECAPA embeddings); the picker server runs it for you on first start.

Inputs (never modified):
  * the expanded training dataset's manifests (8,140 TRAIN clips / 79 voices) plus its dev/test/teacher
    manifests, only so that a clip the research agent already chose from another split can be shown;
  * the research agent's evaluation lines, located through its index
    E:/CyberpunkConvai-offload/work/likeness-phase1/out/evaluation-sets.json (panel.json: 67 voices x 2 held-out lines).
    They become each voice's "original line" and are removed from every voice's candidate pool.  (exclude-ids.json in
    the same index lists reference clips for comparison purposes, not held-out lines, so it does not limit the pool);
  * loudness per clip: gated RMS in dBFS over the speech frames (frames within 25 dB of the loudest 50 ms frame),
    cached in <work>/loudness-cache.json; the picker shows it relative to the voice's median;
  * the agent's ECAPA embeddings (multiref_emb.pt) -> "typicality" = cosine to the voice's mean embedding,
    stored as a percentile within the voice (the agent's own "most typical clip" criterion);
  * runtime/pocket-voices.json and runtime/local-voices.json (today's single references) and the proposed
    three-clip configs (*.multiref.json, *.multiref10.json) for each voice's starting sets.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import sys
import time
import wave

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "runtime/voice-data-expansion-20261004/final-corpus-assembly/final-entries/final-entry-v5-001/data"
LIKENESS = Path("E:/CyberpunkConvai-offload/work/likeness-phase1/out")
SPLITS = ("train", "dev", "test", "teacher_conditional", "teacher_regression")
MAX_CLIP_SECONDS = 18.0
MIN_CLIP_SECONDS = 0.8


def gated_rms_db(path: Path) -> float | None:
    """Loudness of the speech frames: RMS (dBFS) of 50 ms frames within 25 dB of the loudest frame."""
    try:
        import numpy as np
        import soundfile as sf

        data, rate = sf.read(str(path), dtype="float32", always_2d=True)
        mono = data.mean(axis=1)
        frame = max(1, int(rate * 0.05))
        count = len(mono) // frame
        if count < 2:
            return None
        energy = (mono[: count * frame].reshape(count, frame) ** 2).mean(axis=1)
        peak = energy.max()
        if peak <= 0:
            return None
        active = energy[energy >= peak * 10 ** (-25 / 10)]
        return round(float(10 * math.log10(active.mean())), 2)
    except Exception:
        return None


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def wav_seconds(path: Path) -> float | None:
    try:
        with wave.open(str(path), "rb") as handle:
            return handle.getnframes() / handle.getframerate()
    except (OSError, wave.Error, EOFError):
        return None


def delivery_kind(row: dict) -> str | None:
    kinds = row.get("delivery_kinds") or []
    if "canonical-phone-performance" in kinds:
        return "phone"
    if "canonical-media-performance" in kinds:
        return "media"
    return None


def clip_path(row: dict) -> str:
    voice = row["id"].split("/")[0]
    return f"audio/{voice}/{row['audio_sha256']}.wav"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    started = time.time()

    rows: dict[str, dict] = {}
    for split in SPLITS:
        for line in (DATA / f"{split}.jsonl").read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                row["_split"] = split
                rows.setdefault(row["id"], row)

    evaluation = read_json(LIKENESS / "evaluation-sets.json")
    panel = read_json(LIKENESS / evaluation["evaluation_lines"]["file"])
    line_ids = set(evaluation["evaluation_lines"]["ids"])
    cache_path = args.out.with_name("loudness-cache.json")
    cache = read_json(cache_path) if cache_path.is_file() else {}

    def loudness(path: Path):
        key = path.stem
        if key not in cache:
            cache[key] = gated_rms_db(path)
        return cache[key]

    embeddings = {}
    try:
        import torch

        raw = torch.load(LIKENESS / "multiref_emb.pt", map_location="cpu")
        for key, value in raw.items():
            vector = value.float()
            embeddings[key] = vector / vector.norm().clamp_min(1e-9)
    except Exception as error:  # typicality is a sorting aid only
        print(f"warning: no embeddings ({error}); typicality will be empty", file=sys.stderr)

    live = {"pocket": read_json(ROOT / "runtime/pocket-voices.json")["voices"],
            "omni": read_json(ROOT / "runtime/local-voices.json")["voices"]}
    proposals = {"pocket": read_json(ROOT / "runtime/pocket-voices.multiref.json")["voices"],
                 "omni": read_json(ROOT / "runtime/local-voices.multiref.json")["voices"]}
    short_path = ROOT / "runtime/local-voices.multiref10.json"
    proposals["omni-short"] = read_json(short_path)["voices"] if short_path.is_file() else {}

    proposed_ids: dict[str, set[str]] = {}
    for engine, voices in proposals.items():
        for key, descriptor in voices.items():
            for clip in descriptor.get("multiref", {}).get("clips", []):
                proposed_ids.setdefault(key, set()).add(clip)

    voice_keys = sorted(set(live["pocket"]) | set(live["omni"]) | {i.split("/")[0] for i, r in rows.items() if r["_split"] == "train"})
    voices = {}
    for key in voice_keys:
        members = []
        for clip_id, row in rows.items():
            if clip_id.split("/")[0] != key or clip_id in line_ids:
                continue
            seconds = row.get("duration") or 0
            wanted = row["_split"] == "train" or clip_id in proposed_ids.get(key, set())
            if not wanted or not MIN_CLIP_SECONDS <= seconds <= MAX_CLIP_SECONDS:
                continue
            if not (DATA / clip_path(row)).is_file():
                continue
            members.append(row)
        # Typicality: cosine to the voice centroid over every embedded clip of the voice, as a percentile.
        embedded = [clip_id for clip_id in embeddings if clip_id.split("/")[0] == key]
        scores = {}
        if len(embedded) >= 3:
            stack = torch.stack([embeddings[clip_id] for clip_id in embedded])
            centroid = stack.mean(0)
            centroid = centroid / centroid.norm().clamp_min(1e-9)
            values = (stack @ centroid).tolist()
            ranked = sorted(values)
            for clip_id, value in zip(embedded, values):
                below = sum(1 for other in ranked if other < value)
                scores[clip_id] = round(100 * below / max(1, len(ranked) - 1), 1)
        clips = []
        for row in members:
            clips.append({"id": row["id"], "d": round(row["duration"], 3), "t": row.get("transcript") or row.get("native_text") or "",
                          "ty": scores.get(row["id"]), "g": row.get("gender_variant"), "k": delivery_kind(row),
                          "s": row["_split"], "p": clip_path(row), "lv": loudness(DATA / clip_path(row))})
        levels = sorted(clip["lv"] for clip in clips if clip["lv"] is not None)
        median = levels[len(levels) // 2] if levels else None
        lines = []
        for target in panel.get(key, {}).get("targets", []):
            path = Path(target["path"])
            lines.append({"id": target["id"], "t": target["transcript"], "d": round(target["duration"], 3),
                          "split": target.get("split"), "path": str(path), "exists": path.is_file()})
        refs = {}
        for engine in ("pocket", "omni"):
            descriptor = live[engine].get(key)
            if not descriptor or not descriptor.get("reference"):
                continue
            path = ROOT / descriptor["reference"]
            refs[engine] = {"reference": descriptor["reference"], "sha256": descriptor["sha256"],
                            "transcript": descriptor["transcript"], "d": round(wav_seconds(path) or 0, 3),
                            "exists": path.is_file(), "lv": loudness(path) if path.is_file() else None}
        starting = {}
        for engine in ("pocket", "omni", "omni-short"):
            multiref = proposals[engine].get(key, {}).get("multiref")
            if multiref:
                starting[engine] = {"clips": multiref["clips"], "seconds": multiref["seconds"]}
        voices[key] = {"clips": clips, "loudMedian": median, "lines": lines, "live": refs, "proposed": starting,
                       "embedded": len(embedded), "typicalityRanked": bool(scores)}

    index = {"version": 1, "built": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "dataRoot": str(DATA),
             "lineIds": sorted(line_ids), "voices": voices,
             "sources": {"evaluationSets": str(LIKENESS / "evaluation-sets.json"), "panel": str(LIKENESS / evaluation["evaluation_lines"]["file"]), "embeddings": str(LIKENESS / "multiref_emb.pt"),
                         "clipsTotal": sum(len(v["clips"]) for v in voices.values())}}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(cache), encoding="utf-8")
    temporary = args.out.with_name(args.out.name + ".tmp")
    temporary.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, args.out)
    print(json.dumps({"voices": len(voices), "clips": index["sources"]["clipsTotal"], "seconds": round(time.time() - started, 1),
                      "out": str(args.out)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
