"""Spectral band-limit features at 24 kHz for clips that only exist at 24 kHz (the expanded reference pool) and the same
features for the training clips resampled to 24 kHz, so one rule can be checked against the 48 kHz phone detector.

    python scripts/phone_detect/spectral24.py --meta <meta.json> --out <features24.json> [--jobs 16]
"""
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

sys.path.insert(0, str(Path(__file__).resolve().parent))
from spectral import features  # noqa: E402


def measure(job):
    key, path, start, duration = job
    try:
        info = sf.info(path)
        data, rate = sf.read(path, start=int(start * info.samplerate), frames=int(min(duration, 12.0) * info.samplerate),
                             dtype="float32", always_2d=True)
        w = data.mean(axis=1)
        if rate != 24000:
            w = resample_poly(w, 24000, rate).astype(np.float32)
        f = features(w, 24000)
        return key, {k: f[k] for k in ("hi_rel", "vhi_rel", "lo_rel", "edge_drop", "floor_hz", "cutoff_hz")} if f else {"error": "short"}
    except Exception as error:
        return key, {"error": str(error)}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--meta", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--jobs", type=int, default=16)
    a = p.parse_args()
    meta = json.loads(a.meta.read_text(encoding="utf-8"))
    jobs = [(k, m["path"], m["start"], m["duration"]) for k, m in meta.items()]
    with ProcessPoolExecutor(a.jobs) as pool:
        res = dict(pool.map(measure, jobs, chunksize=16))
    a.out.write_text(json.dumps(res), encoding="utf-8")
    print("done", len(res), "errors", sum(1 for v in res.values() if "error" in v))
    return 0


if __name__ == "__main__":
    sys.exit(main())
