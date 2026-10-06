"""Stage 3b: digital-processing tells that need the raw 16-bit samples or both channels.

    python scripts/phone_detect/effects_extra.py [--work E:/CyberpunkConvai-offload/work/phone-detect] [--jobs 20]

Per clip (writes work/effects_extra.json):
  channels, lr_corr   stereo clips: correlation of left and right (a stereo-widened/chorused/holo mix is far from 1)
  eff_bits            16 minus the trailing zero bits shared by all samples (bit-crusher: < 16)
  repeat_frac         share of speech frames that repeat an earlier frame (>= 60 ms back) almost exactly: glitch loops/stutter
"""
from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import soundfile as sf

MAX_SECONDS = 12.0


def measure(job):
    key, path, start, duration = job
    try:
        info = sf.info(path)
        data, rate = sf.read(path, start=int(start * info.samplerate), frames=int(min(duration, MAX_SECONDS) * info.samplerate),
                             dtype="int16", always_2d=True)
        out = {"channels": int(data.shape[1])}
        if data.shape[1] == 2:
            a, b = data[:, 0].astype(np.float64), data[:, 1].astype(np.float64)
            denom = np.sqrt((a * a).sum() * (b * b).sum())
            out["lr_corr"] = float((a * b).sum() / denom) if denom > 0 else 1.0
        nz = np.abs(data[data != 0]).astype(np.int64)
        if len(nz):
            common = int(np.bitwise_or.reduce(nz))
            out["eff_bits"] = 16 - ((common & -common).bit_length() - 1)
        mono = data.astype(np.float32).mean(axis=1) / 32768
        n, hop = 1024, 256
        if len(mono) > n * 4:
            count = 1 + (len(mono) - n) // hop
            frames = mono[np.arange(n)[None, :] + hop * np.arange(count)[:, None]] * np.hanning(n).astype(np.float32)
            mag = np.log10(np.abs(np.fft.rfft(frames, axis=1))[:, 4:300] + 1e-6)
            level = 10 * np.log10((frames ** 2).sum(1) + 1e-12)
            speech = level > level.max() - 25
            mag = mag - mag.mean(1, keepdims=True)
            unit = mag / (np.linalg.norm(mag, axis=1, keepdims=True) + 1e-9)
            sim = unit @ unit.T
            idx = np.arange(count)
            far = (idx[:, None] - idx[None, :]) >= 6
            best = np.where(far, sim, -1).max(axis=1)
            out["repeat_frac"] = float((best[speech] > 0.995).mean()) if speech.any() else 0.0
        return key, out
    except Exception as error:
        return key, {"error": str(error)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, default=Path("E:/CyberpunkConvai-offload/work/phone-detect"))
    parser.add_argument("--jobs", type=int, default=20)
    args = parser.parse_args()
    meta = json.loads((args.work / "meta.json").read_text(encoding="utf-8"))
    jobs = [(k, m["path"], m["start"], m["duration"]) for k, m in meta.items()]
    results = {}
    with ProcessPoolExecutor(args.jobs) as pool:
        for count, (key, feats) in enumerate(pool.map(measure, jobs, chunksize=16), 1):
            results[key] = feats
            if count % 2000 == 0:
                print(count, "of", len(jobs), flush=True)
    (args.work / "effects_extra.json").write_text(json.dumps(results), encoding="utf-8")
    print("done", len(results), "errors", sum(1 for v in results.values() if "error" in v))
    return 0


if __name__ == "__main__":
    sys.exit(main())
