"""Loudness band for the clip search: per-clip and per-set measures, and the score bonus (CPU only, plays nothing).

The user wants reference sets that are loud enough, but not too loud: a healthy band, not "louder is always better".

  Set loudness   integrated LUFS (ITU-R BS.1770-4, K-weighted, gated) of the set exactly as it is built (whole clips, 0.4 s gaps,
                 24 kHz mono, no gain), measured with scripts/clip-search/v-voice/loudness.py (the helper the V voice work wrote).
  Band           -22 to -18 LUFS: full bonus.  Between -18 and -16 LUFS the bonus stays at its band value (no extra for louder).
                 Quiet below -22: the bonus falls by QUIET_SLOPE per dB.  Hotter than -16: it falls by HOT_SLOPE per dB.
  Peaks          true peak at or below -3 dBFS; above it the bonus falls by PEAK_SLOPE per dB over.
  Compressed     PLR (true peak minus integrated loudness) under 11 dB sounds squashed or shouted; PLR_SLOPE per dB under.
  Clipping       a clip with clipped samples (full scale, or runs of equal extreme samples) is rejected before anything is scored.
  Noise floor    10th percentile of the 50 ms frame levels (dBFS): reported, and a clip whose floor is above HUM_FLOOR_DB is rejected
                 (a hum or constant noise under the voice; the pool's effect flags catch most of these already).

The bonus is added to the ECAPA likeness in every selection comparison (singles race, greedy growth, final choice).  Its size is
set against ECAPA noise (paired standard errors are 0.01 to 0.03): the whole quiet-to-band swing is a few standard errors, so a
clearly better-sounding likeness can still win, but between near ties the louder clean set wins.
"""
from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

_spec = importlib.util.spec_from_file_location("v_loudness", Path(__file__).resolve().parent / "v-voice" / "loudness.py")
L = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(L)

BAND_LOW, BAND_HIGH, HOT_ABOVE, PEAK_CEILING = -22.0, -18.0, -16.0, -3.0
BONUS = 0.03                       # ECAPA units, inside the band
QUIET_SLOPE = 0.015                # per dB below BAND_LOW
HOT_SLOPE = 0.015                  # per dB above HOT_ABOVE
PEAK_SLOPE = 0.010                 # per dB of true peak above PEAK_CEILING
PLR_MIN, PLR_SLOPE = 11.0, 0.004   # per dB of PLR under PLR_MIN
HUM_FLOOR_DB = -48.0               # reject a clip whose noise floor (10th percentile 50 ms frame level) is above this
RATE = common.REFERENCE_RATE


def measure_signal(x, rate: int = RATE) -> dict:
    """LUFS, true peak, PLR, noise floor and crest of a 24 kHz mono float signal."""
    x = np.asarray(x, dtype=np.float64)
    lufs = L.lufs(x, rate)
    tp = L.true_peak_db(x)
    frame = int(rate * 0.05)
    count = len(x) // frame
    levels = 10 * np.log10((x[: count * frame].reshape(count, frame) ** 2).mean(axis=1) + 1e-12) if count else np.array([-120.0])
    return {"lufs": round(lufs, 2), "tp": round(tp, 2), "plr": round(tp - lufs, 2) if lufs > -69 else None,
            "floor": round(float(np.percentile(levels, 10)), 1), "gated": None if (g := L.gated_rms_db(x, rate)) is None else round(g, 2)}


def clipped(path) -> bool:
    """True when the source file has digital clipping: two or more consecutive samples at (nearly) the clip's own absolute maximum
    while that maximum is at or above -0.1 dBFS."""
    import soundfile as sf
    d, _ = sf.read(str(path), dtype="float32", always_2d=True)
    peak = float(np.abs(d).max())
    if peak < 0.988:
        return False
    hit = np.abs(d) >= peak - 1e-4
    return bool(np.any(hit[1:] & hit[:-1]))


def clip_measures(clips: list, cache_file: Path) -> dict:
    """{clip id: measures + clip flag} for pool clips (cached on disk; the file is keyed by id and size so it never goes stale silently)."""
    cache = json.loads(cache_file.read_text(encoding="utf-8")) if cache_file.is_file() else {}
    changed = False
    for clip in clips:
        key = clip["id"]
        if key in cache:
            continue
        sig = common.load_audio_mono(clip["path"]).numpy()
        row = measure_signal(sig)
        row["clip"] = clipped(clip["path"])
        cache[key] = row
        changed = True
    if changed:
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache_file.with_name(cache_file.name + ".part")
        tmp.write_text(json.dumps(cache), encoding="utf-8")
        tmp.replace(cache_file)
    return cache


def reject_clip(row: dict) -> str | None:
    """Reason a clip may never be a reference candidate, or None."""
    if row.get("clip"):
        return "clipped"
    if row.get("lufs", -70) <= -69:
        return "silent"
    if row.get("floor", -120) > HUM_FLOOR_DB:
        return "noise floor"
    return None


def bonus(lufs: float, tp: float, plr: float | None = None) -> float:
    """The loudness-band bonus of one clip or one set (ECAPA units)."""
    value = BONUS
    if lufs < BAND_LOW:
        value -= QUIET_SLOPE * (BAND_LOW - lufs)
    elif lufs > HOT_ABOVE:
        value -= HOT_SLOPE * (lufs - HOT_ABOVE)
    if tp > PEAK_CEILING:
        value -= PEAK_SLOPE * (tp - PEAK_CEILING)
    if plr is not None and plr < PLR_MIN:
        value -= PLR_SLOPE * (PLR_MIN - plr)
    return value


def bonus_of(row: dict) -> float:
    return bonus(row["lufs"], row["tp"], row.get("plr"))
