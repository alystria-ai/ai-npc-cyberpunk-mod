"""Stage 3: effect/artifact features (effects.py) for every clip of the training dataset.

    python scripts/phone_detect/effects_extract.py [--work E:/CyberpunkConvai-offload/work/phone-detect] [--jobs 20]

Reads the clip list written by extract.py (work/meta.json) and writes work/effects.json.  Read-only on the audio.
"""
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from effects import features  # noqa: E402

MAX_SECONDS = 12.0


def measure(job):
    key, path, start, duration = job
    try:
        info = sf.info(path)
        data, rate = sf.read(path, start=int(start * info.samplerate),
                             frames=int(min(duration, MAX_SECONDS) * info.samplerate), dtype="float32", always_2d=True)
        return key, features(data.mean(axis=1), rate) or {"error": "too short"}
    except Exception as error:
        return key, {"error": str(error)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, default=Path("E:/CyberpunkConvai-offload/work/phone-detect"))
    parser.add_argument("--jobs", type=int, default=20)
    parser.add_argument("--meta", type=Path, default=None, help="clip list (default: WORK/meta.json); an expanded-pool list works too")
    args = parser.parse_args()
    meta = json.loads((args.meta or args.work / "meta.json").read_text(encoding="utf-8"))
    jobs = [(k, m["path"], m["start"], m["duration"]) for k, m in meta.items()]
    results = {}
    with ProcessPoolExecutor(args.jobs) as pool:
        for count, (key, feats) in enumerate(pool.map(measure, jobs, chunksize=16), 1):
            results[key] = feats
            if count % 1000 == 0:
                print(count, "of", len(jobs), flush=True)
    (args.work / "effects.json").write_text(json.dumps(results), encoding="utf-8")
    print("done", len(results), "errors", sum(1 for v in results.values() if "error" in v))
    return 0


if __name__ == "__main__":
    sys.exit(main())
