"""Spectral features that separate phone/holocall-processed speech from ordinary speech.

Everything is measured on the long-term average spectrum (LTAS) of the speech-active frames of a clip, so one
number describes how much energy the clip has above 4 kHz / below 200 Hz relative to its own telephone band, and how
sharp the roll-off is.  Pure numpy/scipy/soundfile, no models.
"""
from __future__ import annotations

import numpy as np

N_FFT = 2048
HOP = 512


def _band(freqs: np.ndarray, spec_db: np.ndarray, lo: float, hi: float) -> float:
    """Mean power (dB) of the bins inside [lo, hi) Hz."""
    mask = (freqs >= lo) & (freqs < hi)
    if not mask.any():
        return float("nan")
    return float(10 * np.log10(np.mean(10 ** (spec_db[mask] / 10)) + 1e-20))


def ltas(wave: np.ndarray, rate: int):
    """LTAS (dB per bin) over speech-active frames; returns (freqs, spec_db, n_active_frames) or None."""
    if len(wave) < N_FFT * 2:
        return None
    window = np.hanning(N_FFT).astype(np.float32)
    count = 1 + (len(wave) - N_FFT) // HOP
    index = np.arange(N_FFT)[None, :] + HOP * np.arange(count)[:, None]
    frames = wave[index] * window
    power = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    energy = power[:, 1:].sum(axis=1)
    if energy.max() <= 0:
        return None
    level = 10 * np.log10(energy + 1e-20)
    active = level > level.max() - 30.0
    # Voiced-speech frames only: drop the quietest third of the active frames so pauses and noise floor do not
    # flatten the high band.
    keep = active & (level > np.percentile(level[active], 33)) if active.sum() >= 6 else active
    if keep.sum() < 3:
        return None
    spec = power[keep].mean(axis=0)
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / rate)
    return freqs, 10 * np.log10(spec + 1e-20), int(keep.sum())


def features(wave: np.ndarray, rate: int) -> dict | None:
    out = ltas(np.asarray(wave, dtype=np.float32), rate)
    if out is None:
        return None
    freqs, db, frames = out
    ref = _band(freqs, db, 300, 3400)           # the telephone band
    nyq = rate / 2
    f = {
        "frames": frames,
        "hi_rel": _band(freqs, db, 4000, 8000) - ref,        # energy above the phone band, dB re the phone band
        "vhi_rel": _band(freqs, db, 8000, min(16000, nyq)) - ref,
        "lo_rel": _band(freqs, db, 50, 200) - _band(freqs, db, 300, 1000),   # missing bass
        "edge_drop": _band(freqs, db, 2800, 3200) - _band(freqs, db, 3800, 4200),    # roll-off sharpness near 3.4 kHz
        "edge_drop2": _band(freqs, db, 2600, 3000) - _band(freqs, db, 3400, 3800),
        "mid_hi": _band(freqs, db, 3400, 4000) - ref,
    }
    # Frequency below which 99% / 99.9% of the energy lies (spectral bandwidth).
    power = 10 ** (db / 10)
    cumulative = np.cumsum(power) / power.sum()
    f["f99"] = float(freqs[np.searchsorted(cumulative, 0.99)])
    f["f999"] = float(freqs[np.searchsorted(cumulative, 0.999)])
    # Cutoff: highest frequency (above 2 kHz) whose smoothed level is still within 45 dB of the phone-band level.
    smooth = np.convolve(db, np.ones(9) / 9, mode="same")
    above = np.where((freqs > 2000) & (smooth > ref - 45))[0]
    f["cutoff_hz"] = float(freqs[above.max()]) if len(above) else 2000.0
    # Floor frequency: lowest frequency above which the smoothed spectrum stays within 8 dB of the file's own noise
    # floor (median level of the top 2.5 kHz).  A telephone/codec band limit puts it near 4-5 kHz; ordinary game
    # speech keeps real content up to the 17-20 kHz codec low-pass.
    top = (freqs >= nyq - 2500) & (freqs < nyq - 100)
    floor = float(np.median(db[top]))
    smooth_up = np.convolve(db, np.ones(15) / 15, mode="same")
    live = np.where((freqs >= 1500) & (smooth_up > floor + 8))[0]
    f["floor_hz"] = float(freqs[live.max()]) if len(live) else 1500.0
    f["floor_db"] = floor - ref
    # Third-octave band levels (dB re the phone band), 100 Hz - 20 kHz: the shape the classifier study uses.
    edges = 100 * 2 ** (np.arange(0, 25) / 3.0)
    edges = edges[edges < min(20000, nyq)]
    f["bands"] = [round(_band(freqs, db, lo, hi) - ref, 2) for lo, hi in zip(edges[:-1], edges[1:])]
    return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in f.items()}
