"""Stage 1: spectral features for every clip of the training dataset (all splits), the live single references and
the proposed multi-clip reference sets.  Read-only on every input; writes JSON under the work folder.

    python scripts/phone_detect/extract.py [--work E:/CyberpunkConvai-offload/work/phone-detect] [--jobs 12]
"""
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from spectral import features  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
ENTRY = ROOT / "runtime/voice-data-expansion-20261004/final-corpus-assembly/final-entries/final-entry-v5-001"
SPLITS = ("train", "dev", "test", "teacher_regression", "teacher_conditional")
MAX_SECONDS = 12.0


def speaker(row: dict) -> str:
    for key in ("character", "speaker", "speaker_id", "character_id"):
        if row.get(key) is not None:
            return str(row[key])
    return row["id"].split("/")[0]


def measure(job):
    key, path, start, duration = job
    try:
        info = sf.info(path)
        first = int(start * info.samplerate)
        count = -1 if duration is None else int(min(duration, MAX_SECONDS) * info.samplerate)
        data, rate = sf.read(path, start=first, frames=count, dtype="float32", always_2d=True)
        return key, features(data.mean(axis=1), rate), rate
    except Exception as error:  # a clip that cannot be read is reported, not fatal
        return key, {"error": str(error)}, None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, default=Path("E:/CyberpunkConvai-offload/work/phone-detect"))
    parser.add_argument("--jobs", type=int, default=12)
    args = parser.parse_args()
    args.work.mkdir(parents=True, exist_ok=True)

    jobs, meta = [], {}
    for split in SPLITS:
        for line in (ENTRY / "data" / f"{split}.jsonl").read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            path = str((ENTRY / row["path"]).resolve())
            delivery = row.get("source_delivery") or {}
            meta[row["id"]] = {
                "speaker": speaker(row), "split": split, "duration": row["duration"],
                "sha": row.get("audio_sha256"), "text": row.get("transcript"),
                "kind": delivery.get("kind") or (row.get("delivery_kinds") or [None])[0],
                "holocall_speaker": delivery.get("isHolocallSpeaker"), "vo_expression": delivery.get("voExpression"),
                "custom_vo_event": delivery.get("customVoEvent"), "scenes": row.get("scenes") or [],
                "delivery_kinds": row.get("delivery_kinds"),
                "native_delivery": row.get("native_delivery_classification"),
                "path": path, "start": float(row.get("start", 0)),
            }
            jobs.append((row["id"], path, float(row.get("start", 0)), float(row["duration"])))
    for name in ("pocket-voices.json", "local-voices.json"):
        voices = json.loads((ROOT / "runtime" / name).read_text(encoding="utf-8-sig"))["voices"]
        for voice, item in voices.items():
            if isinstance(item, dict) and item.get("reference"):
                jobs.append((f"live:{name}:{voice}", str(ROOT / item["reference"]), 0.0, None))
    (args.work / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

    results = {}
    with ProcessPoolExecutor(args.jobs) as pool:
        for count, (key, feats, rate) in enumerate(pool.map(measure, jobs, chunksize=16), 1):
            results[key] = {**(feats or {"error": "too short"}), "rate": rate}
            if count % 1000 == 0:
                print(count, "of", len(jobs), flush=True)
    (args.work / "features.json").write_text(json.dumps(results), encoding="utf-8")
    print("done", len(results), "errors", sum(1 for v in results.values() if "error" in v))
    return 0


if __name__ == "__main__":
    sys.exit(main())
