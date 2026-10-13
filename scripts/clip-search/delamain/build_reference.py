"""Build the Delamain add-on voice reference from clips extracted by extract_delamain.py.

Usage: python scripts/clip-search/delamain/build_reference.py EXTRACT_DIR OUT_DIR STRINGID [STRINGID ...]
Each clip: LEFT channel only (the two stereo channels are decorrelated, about 6 ms apart with inverted polarity, so a mean
downmix would comb-filter the voice), resample to 24 kHz (scipy polyphase), trim leading/trailing silence below
-45 dBFS (10 ms frames) keeping 80 ms of margin, then joined with 0.25 s of silence; 16-bit PCM, no other processing.
Writes OUT_DIR/delamain.wav and OUT_DIR/delamain-reference.json (status/notes are filled in by hand afterwards).
"""
import json, sys
from pathlib import Path
import numpy as np, soundfile as sf
from scipy.signal import resample_poly

RATE, GAP, MARGIN, THRESH_DB = 24000, 0.25, 0.08, -45.0
src, out, ids = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3:]
man = {m["stringId"]: m for m in json.loads((src / "extract-manifest.json").read_text("utf-8"))}


def load(path):
    d, sr = sf.read(path, dtype="float32")
    if d.ndim > 1:
        d = d[:, 0]
    assert sr % RATE == 0 or RATE % sr == 0, sr
    return resample_poly(d, RATE, sr).astype(np.float32) if sr != RATE else d


def trim(d):
    n = len(d) // 240 * 240
    fr = np.sqrt((d[:n].reshape(-1, 240) ** 2).mean(1)) + 1e-9
    loud = np.where(20 * np.log10(fr) > THRESH_DB)[0]
    lo = max(0, loud[0] * 240 - int(MARGIN * RATE))
    hi = min(len(d), (loud[-1] + 1) * 240 + int(MARGIN * RATE))
    return d[lo:hi]


parts, sources = [], []
for sid in ids:
    m = man[sid]
    d = trim(load(m["wavPath"]))
    if parts:
        parts.append(np.zeros(int(GAP * RATE), dtype=np.float32))
    parts.append(d)
    sources.append({"stringId": int(sid), "wem": m["wemPath"].split("\\")[-1], "seconds": round(len(d) / RATE, 3), "text": m["transcript"]})
audio = np.concatenate(parts)
out.mkdir(parents=True, exist_ok=True)
sf.write(out / "delamain.wav", audio, RATE, subtype="PCM_16")
ref = {"transcript": " ".join(s["text"] for s in sources), "sources": sources, "status": "", "notes": "",
       "seconds": round(len(audio) / RATE, 3), "sampleRate": RATE, "peakDbfs": round(float(20 * np.log10(np.abs(audio).max())), 2)}
(out / "delamain-reference.json").write_text(json.dumps(ref, ensure_ascii=False, indent=2) + "\n", "utf-8")
print(json.dumps(ref, ensure_ascii=False, indent=2))
