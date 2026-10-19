"""Measure every usable single-clip candidate of one voice in the picker's pool and report the clean, full-band, calm ones (CPU, read-only).

Reads the manifest decode_voice.py wrote (the pool's WAVs were deleted, so the lines are decoded again), skips the holocall recordings and
flags effect (phone_detect) and combat (combat_flags) clips; measures: sample rate, peak, clipping, LUFS/true peak/PLR/noise floor (loudband.measure_signal), the frequency under which 99 percent of the
energy lies, the share of energy above 4 kHz, the speech ratio, the pitch spread (semitones) and the level spread of the voiced frames
(calm = small spreads).  Also measures reference WAVs given with --ref, for comparison.

Run (CLIP_SEARCH_ROOT = the main checkout, which holds runtime/ and vendor/):
  python analyze_viktor.py <manifest.json from decode_voice.py> <voice key> <out.json> [--ref a.wav b.wav ...]
with vendor/reference-voicestudio/.venv/Scripts/python.exe.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio.functional as AF

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import common      # noqa: E402
import loudband    # noqa: E402


def features(path: str) -> dict:
    data, rate = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    peak = float(np.abs(data).max())
    x24 = AF.resample(torch.from_numpy(mono), rate, 24000).numpy() if rate != 24000 else mono
    out = {"rate": rate, "ch": data.shape[1], "seconds": round(len(mono) / rate, 3), "peak_db": round(20 * np.log10(peak + 1e-9), 2)}
    out["clipped"] = bool(((np.abs(data) >= 0.999).sum()) >= 3)
    out.update({f"m_{k}": v for k, v in loudband.measure_signal(x24).items()})
    from scipy.signal import welch
    f, p = welch(mono, rate, nperseg=2048)
    cum = np.cumsum(p) / p.sum()
    out["f99_hz"] = int(f[min(len(f) - 1, np.searchsorted(cum, 0.99))])
    out["f999_hz"] = int(f[min(len(f) - 1, np.searchsorted(cum, 0.999))])
    out["above4k_pct"] = round(100 * p[f >= 4000].sum() / p.sum(), 3)
    out["above8k_pct"] = round(100 * p[f >= 8000].sum() / p.sum(), 4)
    frame = int(24000 * 0.05)
    n = len(x24) // frame
    lv = 10 * np.log10((x24[: n * frame].reshape(n, frame) ** 2).mean(axis=1) + 1e-12)
    top = lv.max()
    out["speech_ratio"] = round(float((lv > top - 30).mean()), 3)
    out["level_sd_db"] = round(float(lv[lv > top - 20].std()), 2)
    try:
        f0 = AF.detect_pitch_frequency(torch.from_numpy(x24), 24000, frame_time=0.01, freq_low=60, freq_high=400).numpy()
        hop = 240
        rms = np.array([np.sqrt((x24[i * hop:(i + 1) * hop + 480] ** 2).mean() + 1e-12) for i in range(len(f0))])
        keep = (20 * np.log10(rms) > top - 18) & (f0 > 65) & (f0 < 380)
        if keep.sum() > 5:
            semis = 12 * np.log2(f0[keep] / 100.0)
            out["f0_med_hz"] = round(float(np.median(f0[keep])), 1)
            out["f0_range_st"] = round(float(np.percentile(semis, 90) - np.percentile(semis, 10)), 2)
    except Exception as error:
        out["f0_error"] = str(error)[:80]
    return out


def main() -> int:
    """analyze_viktor.py <manifest.json from decode_voice.py> <voice key> <out.json> [--ref a.wav b.wav ...]"""
    manifest, key, out_path = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
    refs = sys.argv[sys.argv.index("--ref") + 1:] if "--ref" in sys.argv else []
    root = Path(__file__).resolve().parents[3]
    effects = json.loads((root / "scripts/phone_detect/effect-exclusions.json").read_text(encoding="utf-8-sig"))["clips"]
    combat = json.loads((root / "scripts/phone_detect/combat-flags.json").read_text(encoding="utf-8-sig"))["clips"]
    rows = []
    for item in json.loads(manifest.read_text(encoding="utf-8")):
        if item["dir"] != "vo" or not (3.0 <= item["seconds"] <= 18.0):      # vo_holocall is the phone-filtered recording
            continue
        ids = [f"{key}/{item['sid']}", f"{key}/{item['sid']}/female", f"{key}/{item['sid']}/male"]
        row = {"sid": item["sid"], "stem": item["stem"], "archive": item["archive"], "text": item["text"], "path": item["file"],
               "fx": next((effects[i]["reasons"] for i in ids if i in effects), None),
               "cb": next((combat[i] for i in ids if i in combat), {}).get("score"),
               "cbflag": next((combat[i] for i in ids if i in combat), {}).get("combat")}
        try:
            row.update(features(item["file"]))
            rows.append(row)
        except Exception as error:
            print("fail", item["file"], error, file=sys.stderr)
    refrows = []
    for ref in refs:
        row = {"ref": ref}
        row.update(features(ref))
        refrows.append(row)
    out_path.write_text(json.dumps({"clips": rows, "refs": refrows}, indent=1, default=float), encoding="utf-8")
    print(len(rows), "clips measured ->", out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
