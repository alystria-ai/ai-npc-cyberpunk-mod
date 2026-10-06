"""Silence-based pause and speech-time measurements for the natural-speech renders (no ASR, numpy only).

For every WAV under <root>/{pocket,omni16,omni32}: 10 ms RMS frames in dB; a frame is silent when it sits more than
GAP_DB below the file's 90th-percentile frame level (and below FLOOR_DB).  Leading and trailing silence is dropped.
Internal silences of at least MIN_PAUSE seconds are pauses.  Each pause is placed in the text by proportional
character alignment (approximate: it names the word before the pause, to within a word or two).

Writes <root>/measurements.json:  {engine: {name: {...}}}
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import sys

import numpy as np
import soundfile as sf

HOP = 0.010
GAP_DB = 38.0
FLOOR_DB = -45.0
MIN_PAUSE = 0.15
HERE = Path(__file__).resolve().parent


def frames_db(values: np.ndarray, rate: int) -> np.ndarray:
    hop = int(rate * HOP)
    count = len(values) // hop
    block = values[: count * hop].reshape(count, hop).astype(np.float64)
    rms = np.sqrt((block ** 2).mean(axis=1) + 1e-12)
    return 20 * np.log10(rms + 1e-9)


def measure(path: Path) -> dict:
    values, rate = sf.read(str(path), dtype="float32")
    if values.ndim > 1:
        values = values.mean(axis=1)
    db = frames_db(values, rate)
    top = float(np.percentile(db, 90))
    silent = (db < top - GAP_DB) | (db < FLOOR_DB)
    voiced = np.flatnonzero(~silent)
    if not voiced.size:
        return {"seconds": len(values) / rate, "pauses": [], "pauseCount": 0}
    first, last = int(voiced[0]), int(voiced[-1])
    pauses, at = [], first
    while at <= last:
        if silent[at]:
            end = at
            while end <= last and silent[end]:
                end += 1
            length = (end - at) * HOP
            if length >= MIN_PAUSE:
                pauses.append({"at": round(at * HOP, 2), "seconds": round(length, 2)})
            at = end
        else:
            at += 1
    span = (last - first + 1) * HOP
    total_pause = sum(p["seconds"] for p in pauses)
    return {"seconds": round(len(values) / rate, 2), "spoken": round(span, 2), "lead": round(first * HOP, 2),
            "tail": round((len(db) - 1 - last) * HOP, 2), "pauseCount": len(pauses),
            "pauseTotal": round(total_pause, 2), "pauseLongest": max((p["seconds"] for p in pauses), default=0.0),
            "speech": round(span - total_pause, 2), "pauses": pauses, "level": round(top, 1)}


def word_before(text: str, fraction: float) -> str:
    """The word at a proportional position of the text (approximate alignment)."""
    words = [(m.start(), m.group()) for m in re.finditer(r"\S+", text)]
    weights = [max(len(re.sub(r"\W", "", w)), 1) for _, w in words]
    cut, running = fraction * sum(weights), 0
    for (_, word), weight in zip(words, weights):
        running += weight
        if running >= cut:
            return word
    return words[-1][1]


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else r"E:\CyberpunkConvai-offload\work\natural-speech")
    lines = json.loads((HERE / "lines.json").read_text(encoding="utf-8"))
    result = {}
    for engine in ("pocket", "omni16", "omni32", "omni16c", "omni32c"):
        folder = root / engine
        result[engine] = {}
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob("*.wav")):
            item = measure(path)
            key, line_id, variant = path.stem.split("__")
            variants = lines["characters"][key]["lines"][line_id]["v"]
            text = variants.get(variant + "_pocket" if engine == "pocket" and variant == "v5" else variant, "")
            for pause in item["pauses"]:
                pause["after"] = word_before(text, min(max((pause["at"] - item["lead"]) / max(item["spoken"], 0.1), 0.0), 1.0))
            result[engine][path.stem] = item
        for path in sorted((folder / "probe").glob("*.wav")):
            result[engine]["probe/" + path.stem] = measure(path)
    (root / "measurements.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(json.dumps({engine: len(items) for engine, items in result.items()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
