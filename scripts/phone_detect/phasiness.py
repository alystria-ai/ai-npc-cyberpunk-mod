"""Phase-quality metrics for speech audio, per frequency band (the 1.5-4 kHz band is the one that sounds "holographic").

All metrics use voiced frames (pitch found by autocorrelation) and an STFT that resolves harmonics (2048 samples at 24 kHz).

  harm_align    Harmonics of a glottal pulse train share one pulse time, so the phase step between neighbouring harmonics
                is nearly constant: |mean exp(j * step)| over the harmonics in the band, averaged over frames.  Lower
                means the harmonics' phases are scattered (a phasey / hollow sound).
  if_consist    Instantaneous-frequency consistency: the phase advance between consecutive frames, per bin, should agree
                across the bins of one harmonic peak (a single sinusoid has one frequency).  1 minus the circular spread
                of the IF estimates over the +-2 bins around each harmonic peak.
  rel_phase_dev (paired only) mean |phase difference| to a reference decode of the same latents, magnitude weighted.

`features(wave)` returns {band: {metric: value}}.  Pure numpy.
"""
from __future__ import annotations

import numpy as np

SR = 24000
N = 2048
HOP = 256
BANDS = {"0.5-1.5k": (500, 1500), "1.5-4k": (1500, 4000), "4-8k": (4000, 8000)}


def _f0(frame_low: np.ndarray) -> float | None:
    r = np.fft.irfft(np.abs(np.fft.rfft(frame_low * np.hanning(len(frame_low)), n=2 * len(frame_low))) ** 2)[: len(frame_low)]
    if r[0] <= 0:
        return None
    r = r / r[0]
    lo, hi = int(SR / 350), int(SR / 70)
    lag = lo + int(np.argmax(r[lo:hi]))
    return SR / lag if r[lag] > 0.55 else None


def features(wave: np.ndarray, rate: int = SR, max_frames: int = 400) -> dict | None:
    from scipy.signal import butter, sosfiltfilt
    w = np.asarray(wave, dtype=np.float32)
    if len(w) < N * 3:
        return None
    low = sosfiltfilt(butter(4, [70, 1000], btype="band", fs=SR, output="sos"), w)
    win = np.hanning(N).astype(np.float32)
    starts = np.arange(0, len(w) - N - HOP, HOP)
    level = np.array([np.sum(w[s:s + N] ** 2) for s in starts])
    keep = starts[level > level.max() * 1e-3]
    keep = keep[:: max(1, len(keep) // max_frames)]
    f = np.fft.rfftfreq(N, 1 / SR)
    acc = {b: {"align": [], "ifc": []} for b in BANDS}
    for s in keep:
        f0 = _f0(low[s:s + 1024])
        if f0 is None:
            continue
        a, b_ = np.fft.rfft(w[s:s + N] * win), np.fft.rfft(w[s + HOP:s + HOP + N] * win)
        for name, (lo, hi) in BANDS.items():
            hs = np.arange(int(np.ceil(lo / f0)), int(hi / f0) + 1)
            if len(hs) < 4:
                continue
            bins = np.round(hs * f0 / (SR / N)).astype(int)
            # refine each harmonic to the local magnitude peak
            peaks = np.array([bn - 2 + int(np.argmax(np.abs(a[bn - 2:bn + 3]))) for bn in bins])
            ph = np.angle(a[peaks])
            # remove the linear term of the nominal frequency so a pulse at the frame centre gives step 0
            step = np.angle(np.exp(1j * np.diff(ph)) * np.exp(1j * np.pi * np.diff(peaks)))   # frame-centre pulse reference
            acc[name]["align"].append(abs(np.exp(1j * step).mean()))
            # IF consistency across +-2 bins around each peak
            dphi = np.angle(b_ * np.conj(a)) - 2 * np.pi * f * HOP / SR
            spread = []
            for p in peaks:
                seg = np.exp(1j * dphi[p - 2:p + 3])
                wts = np.abs(a[p - 2:p + 3])
                spread.append(abs((seg * wts).sum()) / wts.sum())
            acc[name]["ifc"].append(float(np.mean(spread)))
    out = {}
    for name, d in acc.items():
        if len(d["align"]) >= 8:
            out[name] = {"harm_align": float(np.mean(d["align"])), "if_consist": float(np.mean(d["ifc"])), "frames": len(d["align"])}
    return out or None
