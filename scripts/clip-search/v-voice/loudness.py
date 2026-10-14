"""Loudness helpers for the V voice reference clips (numpy / scipy / soundfile only, CPU only, plays nothing).

  lufs(x, rate)          ITU-R BS.1770-4 integrated loudness of a mono signal (K-weighting, 400 ms blocks, absolute gate -70 LUFS,
                         relative gate -10 LU).  Mono counts as one front channel (no 3 dB sum), as in pyloudnorm.
  gated_rms_db(x, rate)  the picker's own measure (scripts/reference-picker/build-index.py gated_rms_db): RMS in dBFS of the 50 ms frames
                         within 25 dB of the loudest frame.  This is the "lv" the pool index and the companion references are held to
                         (the pool median is about -23 dB), so it is the level a reference is normalised to.
  true_peak_db(x)        4x oversampled peak in dBFS.
  normalise(x, target_db, ...)  one linear gain so gated_rms_db hits the target; the gain is lowered when it would push the 4x true peak
                         over the ceiling (-1 dBFS), so nothing clips and the shape of the voice is untouched (no compressor, no limiter).
"""
import math
import numpy as np
from scipy.signal import resample_poly, sosfilt, tf2sos


def _k_filters(rate):
    # BS.1770-4 K-weighting: a high-shelf (+4 dB, ~1.68 kHz) then a high-pass (~38 Hz); coefficients re-derived for any sample rate.
    f0, G, Q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    K = math.tan(math.pi * f0 / rate); Vh = 10 ** (G / 20); Vb = Vh ** 0.4996667741545416
    a0 = 1 + K / Q + K * K
    shelf = tf2sos([(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0],
                   [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0], analog=False)
    f0, Q = 38.13547087602444, 0.5003270373238773
    K = math.tan(math.pi * f0 / rate)
    hp = tf2sos([1, -2, 1], [1, 2 * (K * K - 1) / (1 + K / Q + K * K), (1 - K / Q + K * K) / (1 + K / Q + K * K)], analog=False)
    return np.vstack([shelf, hp])


def lufs(x, rate):
    x = np.asarray(x, dtype=np.float64)
    y = sosfilt(_k_filters(rate), x)
    block, hop = int(0.4 * rate), int(0.1 * rate)
    if len(y) < block:
        return -70.0
    z = np.array([np.mean(y[s:s + block] ** 2) for s in range(0, len(y) - block + 1, hop)])
    l = -0.691 + 10 * np.log10(z + 1e-20)
    keep = z[l > -70.0]
    if not len(keep):
        return -70.0
    rel = -0.691 + 10 * math.log10(keep.mean()) - 10.0
    keep = z[l > rel]
    return float(-0.691 + 10 * math.log10(keep.mean())) if len(keep) else -70.0


def gated_rms_db(x, rate):
    x = np.asarray(x, dtype=np.float64)
    frame = max(1, int(rate * 0.05)); count = len(x) // frame
    if count < 2:
        return None
    e = (x[: count * frame].reshape(count, frame) ** 2).mean(axis=1)
    if e.max() <= 0:
        return None
    sel = e[e >= e.max() * 10 ** (-2.5)]
    return float(10 * math.log10(sel.mean()))


def true_peak_db(x):
    up = resample_poly(np.asarray(x, dtype=np.float64), 4, 1)
    return float(20 * math.log10(max(np.abs(up).max(), 1e-9)))


def normalise(x, target_db, ceiling_db=-1.0):
    """(normalised float32, info).  Gain brings gated_rms_db to target_db; capped so the true peak stays at or under ceiling_db."""
    x = np.asarray(x, dtype=np.float64)
    cur = gated_rms_db(x, 24000)
    want = target_db - cur
    room = ceiling_db - true_peak_db(x)
    gain = min(want, room)
    y = (x * 10 ** (gain / 20)).astype(np.float32)
    return y, {"gainDb": round(gain, 2), "wantedDb": round(want, 2), "peakLimited": bool(room < want), "gatedRmsDb": round(gated_rms_db(y, 24000), 2),
               "lufs": round(lufs(y, 24000), 2), "truePeakDb": round(true_peak_db(y), 2)}


def describe(x, rate=24000):
    return {"lufs": round(lufs(x, rate), 2), "gatedRmsDb": round(gated_rms_db(x, rate), 2), "peakDb": round(20 * math.log10(max(float(np.abs(x).max()), 1e-9)), 2),
            "truePeakDb": round(true_peak_db(x), 2)}
