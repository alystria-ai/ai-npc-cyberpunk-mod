"""Acoustic cues for the isolated-filler probe (numpy only, no ASR).

For each <root>/<engine>/fprobe/*.wav: voiced span (silence-trimmed), spectral centroid, share of energy below 1 kHz
(a closed-mouth hum sits low; an open vowel word does not), voiced fraction (autocorrelation pitch), and loudness
relative to the file's peak.  Real words (ctl-ham, ctl-home, ctl-hum) are the comparison.  The numbers cannot say what
a clip sounds like, only whether it looks like a hum, a vowel, a breath or noise; listening decides.

Writes <root>/fprobe.json.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys

import numpy as np
import soundfile as sf

HOP = 0.010


def analyse(path: Path) -> dict:
    values, rate = sf.read(str(path), dtype="float32")
    if values.ndim > 1:
        values = values.mean(axis=1)
    hop = int(rate * HOP)
    count = len(values) // hop
    rms = np.sqrt((values[: count * hop].reshape(count, hop).astype(np.float64) ** 2).mean(axis=1) + 1e-12)
    db = 20 * np.log10(rms + 1e-9)
    top = db.max()
    live = np.flatnonzero(db > top - 35)
    if not live.size:
        return {"seconds": len(values) / rate, "span": 0.0}
    first, last = int(live[0]), int(live[-1])
    seg = values[first * hop:(last + 1) * hop].astype(np.float64)
    spectrum = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) ** 2
    freqs = np.fft.rfftfreq(len(seg), 1 / rate)
    centroid = float((freqs * spectrum).sum() / spectrum.sum())
    low = float(spectrum[freqs < 1000].sum() / spectrum.sum())
    window = int(0.04 * rate)
    voiced = total = 0
    for at in range(0, max(len(seg) - window, 1), window // 2):
        frame = seg[at:at + window]
        if len(frame) < window or np.sqrt((frame ** 2).mean()) < 10 ** ((top - 35) / 20):
            continue
        frame = frame - frame.mean()
        corr = np.correlate(frame, frame, "full")[window - 1:]
        corr = corr / (corr[0] + 1e-12)
        lo, hi = int(rate / 400), int(rate / 70)
        total += 1
        voiced += bool(corr[lo:hi].max() > 0.5)
    return {"seconds": round(len(values) / rate, 2), "span": round((last - first + 1) * HOP, 2),
            "centroidHz": round(centroid), "below1k": round(low, 2), "voicedFraction": round(voiced / total, 2) if total else 0.0}


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else r"E:\CyberpunkConvai-offload\work\natural-speech")
    result = {}
    for engine in ("pocket", "omni16", "omni32"):
        result[engine] = {path.stem: analyse(path) for path in sorted((root / engine / "fprobe").glob("*.wav"))}
    (root / "fprobe.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(json.dumps({k: len(v) for k, v in result.items()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
