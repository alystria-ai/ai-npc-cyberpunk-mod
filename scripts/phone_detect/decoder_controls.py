"""Listening controls for a decoder artifact: remove one candidate cause at a time from the same audio.

    python scripts/phone_detect/decoder_controls.py --suspect decA.wav --clean pretrained.wav --out folder [--real real.wav]

`suspect` and `clean` are the SAME latents decoded by the suspect decoder and by the reference decoder (sample aligned).
Each control keeps everything of the suspect except one thing:
  01 suspect, 02 clean                    the pair
  03 lines-out         persistent narrow lines on a 200 Hz grid equalised away
  04 highs-from-clean  suspect below 4 kHz, clean above (gain matched to the suspect's high band)
  05 lows-from-clean   clean below 4 kHz, suspect above  (the suspect's high band alone on the clean voice)
  06 mids-from-clean   suspect with 1.5-4 kHz from the clean decode
  07 phase-from-clean  suspect magnitudes, clean phases (STFT 1024)
  08 magnitude-only    clean magnitudes, suspect phases
  09 lowpass-6k        suspect low-passed at 6 kHz
  10 highs-as-noise    suspect above 4 kHz replaced by noise with the same smoothed envelope (no fine structure)
  11 tails-shortened   2:1 downward expander below -20 dB re the local peak (reverb-like tails and floor noise pulled down)
  12 clean-brightened  clean voice with the suspect's long-term spectrum applied (EQ only)
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.ndimage import uniform_filter, uniform_filter1d
from scipy.signal import istft, medfilt, stft

SR = 24000
N = 1024
HOP = N // 4


def spec(x):
    return stft(x, SR, nperseg=N, noverlap=N - HOP)[2]


def inv(Z, n):
    return istft(Z, SR, nperseg=N, noverlap=N - HOP)[1][:n].astype(np.float32)


def freqs():
    return np.fft.rfftfreq(N, 1 / SR)


def crossover_mask(f, hz, width=300.0):
    """1 above hz, 0 below, with a smooth transition."""
    return np.clip((f - (hz - width / 2)) / width, 0, 1)[:, None]


def band_gain(a, b, f, lo):
    m = f >= lo
    return float(np.sqrt((np.abs(a[m]) ** 2).sum() / ((np.abs(b[m]) ** 2).sum() + 1e-12)))


def lines_out(x, spacing=200.0):
    n = 8192
    idx = np.arange(n)[None] + n // 2 * np.arange(1 + (len(x) - n) // (n // 2))[:, None]
    p = np.abs(np.fft.rfft(x[idx] * np.hanning(n), axis=1)) ** 2 + 1e-12
    lvl = 10 * np.log10(p.sum(1))
    keep = lvl > lvl.max() - 30
    ff = np.fft.rfftfreq(n, 1 / SR)
    L = 10 * np.log10(p[keep].mean(0))
    Z = spec(x)
    f = freqs()
    gain = np.ones_like(f)
    for k in range(int(np.ceil(1600 / spacing)), int(10800 / spacing) + 1):
        c = k * spacing
        on = np.interp(c, ff, L)
        off = 0.5 * (np.interp(c - spacing / 2, ff, L) + np.interp(c + spacing / 2, ff, L))
        excess = max(0.0, on - off - 0.3)
        gain *= 10 ** (-excess * np.exp(-0.5 * ((f - c) / 7.0) ** 2) / 20)
    return inv(Z * gain[:, None], len(x))


def controls(suspect, clean):
    n = min(len(suspect), len(clean))
    s, c = suspect[:n], clean[:n]
    S, C = spec(s), spec(c)
    f = freqs()
    out = {"01_suspect": s, "02_clean": c, "03_lines-out": lines_out(s)}
    hi = crossover_mask(f, 4000)
    g = band_gain(S, C, f, 4000)
    out["04_highs-from-clean"] = inv(S * (1 - hi) + C * g * hi, n)
    out["05_lows-from-clean"] = inv(C * (1 - hi) + S / g * hi, n)
    mid = crossover_mask(f, 1500) * (1 - crossover_mask(f, 4000))
    gm = float(np.sqrt((np.abs(S[(f >= 1500) & (f < 4000)]) ** 2).sum() / ((np.abs(C[(f >= 1500) & (f < 4000)]) ** 2).sum() + 1e-12)))
    out["06_mids-from-clean"] = inv(S * (1 - mid) + C * gm * mid, n)
    out["07_phase-from-clean"] = inv(np.abs(S) * np.exp(1j * np.angle(C)), n)
    out["08_magnitude-only-from-clean"] = inv(np.abs(C) * np.exp(1j * np.angle(S)), n)
    out["09_lowpass-6k"] = inv(S * (1 - crossover_mask(f, 6000, 600)), n)
    rng = np.random.default_rng(0)
    env = uniform_filter(np.abs(S), size=(9, 5), mode="nearest")      # smooth over frequency and time
    noise = rng.standard_normal(S.shape) + 1j * rng.standard_normal(S.shape)
    noise = noise / np.sqrt(2) * env
    out["10_highs-as-noise"] = inv(S * (1 - hi) + noise * hi, n)
    env_t = 20 * np.log10(np.sqrt(uniform_filter1d(s.astype(np.float64) ** 2, 480)) + 1e-9)
    from scipy.ndimage import maximum_filter1d
    ref = maximum_filter1d(env_t, 7200, mode="nearest")             # loudest level within +-150 ms
    under = ref - env_t
    atten = np.clip((under - 20) * 1.0, 0, 30)                      # 2:1 downward expander below -20 dB re local peak
    atten = uniform_filter1d(atten, 480)
    out["11_tails-shortened"] = (s * 10 ** (-atten / 20)).astype(np.float32)
    ltas_s = np.log10((np.abs(S) ** 2).mean(1) + 1e-12)
    ltas_c = np.log10((np.abs(C) ** 2).mean(1) + 1e-12)
    eq = 10 ** (np.clip(medfilt(ltas_s - ltas_c, 9), -2, 2) / 2)
    out["12_clean-brightened"] = inv(C * eq[:, None], n)
    peak = max(np.abs(v).max() for v in out.values())
    return {k: v * min(1.0, 0.95 / peak) for k, v in out.items()}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--suspect", type=Path, required=True)
    p.add_argument("--clean", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--prefix", default="")
    a = p.parse_args()
    s, sr = sf.read(a.suspect, dtype="float32")
    c, _ = sf.read(a.clean, dtype="float32")
    assert sr == SR
    a.out.mkdir(parents=True, exist_ok=True)
    for name, wav in controls(s, c).items():
        sf.write(a.out / f"{a.prefix}{name}.wav", wav, SR, subtype="PCM_16")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
