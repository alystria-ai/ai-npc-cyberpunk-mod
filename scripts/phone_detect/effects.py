"""Effect and artifact features for speech clips: comb/flanger ripple, metallic high-band harmonicity, persistent
tones, fixed-rate amplitude modulation, reverb tail and robotic (flat-pitch) delivery.

Used two ways: on the original game clips (to find effect-heavy training data: hologram, braindance, vocoder,
phone, answering-machine processing) and on rendered audio (to check that a decoder does not add the same
signature).  Everything is computed at 24 kHz, the rate the Mimi decoder is trained at, from a mono waveform.

Pure numpy/scipy, no models.  `features(wave, rate)` returns a flat dict of floats.
"""
from __future__ import annotations

import numpy as np
from scipy.signal import resample_poly, medfilt

SR = 24000
N_FFT = 1024
HOP = 256


def _to_24k(wave: np.ndarray, rate: int) -> np.ndarray:
    wave = np.asarray(wave, dtype=np.float32)
    if rate == SR:
        return wave
    from math import gcd
    g = gcd(SR, rate)
    return resample_poly(wave, SR // g, rate // g).astype(np.float32)


def _frames(wave: np.ndarray, n: int, hop: int) -> np.ndarray:
    count = 1 + (len(wave) - n) // hop
    index = np.arange(n)[None, :] + hop * np.arange(count)[:, None]
    return wave[index]


def _speech_mask(level_db: np.ndarray) -> np.ndarray:
    """Frames that carry speech: within 30 dB of the peak and above the quietest third of those."""
    active = level_db > level_db.max() - 30.0
    if active.sum() >= 6:
        return active & (level_db > np.percentile(level_db[active], 33))
    return active


def _cepstral_peak(logspec: np.ndarray, lo: int, hi: int) -> float:
    """Height (in log-spectrum units) of the largest cepstral peak in [lo, hi) above its local trend."""
    x = logspec - logspec.mean()
    x = x * np.hanning(len(x))
    ceps = np.fft.rfft(x, n=4 * len(x)).real / len(x)
    seg = np.abs(ceps[lo:hi])
    if len(seg) < 8:
        return 0.0
    trend = np.convolve(seg, np.ones(9) / 9, mode="same")
    return float((seg - trend).max())


def features(wave: np.ndarray, rate: int) -> dict | None:
    w = _to_24k(wave, rate)
    if len(w) < N_FFT * 4:
        return None
    window = np.hanning(N_FFT).astype(np.float32)
    frames = _frames(w, N_FFT, HOP) * window
    power = np.abs(np.fft.rfft(frames, axis=1)) ** 2 + 1e-12
    level = 10 * np.log10(power[:, 1:].sum(axis=1))
    mask = _speech_mask(level)
    if mask.sum() < 4:
        return None
    freqs = np.fft.rfftfreq(N_FFT, 1 / SR)
    out: dict = {"frames": int(mask.sum()), "seconds": round(len(w) / SR, 2)}

    # 2. Persistent narrow tones in the long-term spectrum.
    seg = _frames(w, 4096, 2048)
    if len(seg):
        p4 = np.abs(np.fft.rfft(seg * np.hanning(4096), axis=1)) ** 2 + 1e-12
        lvl = 10 * np.log10(p4[:, 1:].sum(axis=1))
        keep = _speech_mask(lvl) if len(lvl) >= 4 else np.ones(len(lvl), bool)
        f4 = np.fft.rfftfreq(4096, 1 / SR)
        band4 = (f4 >= 1500) & (f4 < 11000)
        # bins that stay far above their spectral neighbourhood in most frames.
        stack = np.log10(p4[keep])[:, band4]
        floor_ = np.percentile(stack, 25, axis=0)
        tone = floor_ - medfilt(floor_, 81)
        out["tone_db"] = float(10 * tone.max())
    else:
        out["tone_db"] = 0.0

    # 4. Fixed-rate amplitude modulation of the 4-10 kHz band (ring modulator / tremolo / decoder buzz, not tied to pitch).
    hf = _frames(w, 256, 32) * np.hanning(256).astype(np.float32)
    hp = np.abs(np.fft.rfft(hf, axis=1)) ** 2 + 1e-12
    fb = np.fft.rfftfreq(256, 1 / SR)
    env_hf = np.log10(hp[:, (fb >= 4000) & (fb < 10000)].sum(axis=1))
    tot = 10 * np.log10(hp[:, 1:].sum(axis=1))
    act = tot > tot.max() - 30
    rate_env = SR / 32
    run = np.flatnonzero(np.diff(np.r_[0, act.astype(int), 0]))
    n = 256
    spec = np.zeros(n // 2 + 1)
    cnt = 0
    for a_, b_ in zip(run[::2], run[1::2]):
        if b_ - a_ >= n:
            c = env_hf[a_:b_] - env_hf[a_:b_].mean()
            for st in range(0, len(c) - n + 1, n // 2):
                spec += np.abs(np.fft.rfft(c[st:st + n] * np.hanning(n))) ** 2
                cnt += 1
    if cnt:
        spec = np.log10(spec / cnt + 1e-12)
        fm = np.fft.rfftfreq(n, 1 / rate_env)
        sel = (fm >= 25) & (fm < 300)
        local = spec[sel] - medfilt(spec[sel], 15)
        out["am_peak"] = float(local.max())
    else:
        out["am_peak"] = 0.0

    # 4b. Line comb on a fixed grid: contrast of the long-term spectrum at k*s vs between the lines, 3-11 kHz.  The
    #     fine-tuned decoder put lines at multiples of 200 Hz (the 24 kHz / 120 stride of its upsampler).
    if len(seg) >= 3:
        big = _frames(w, 8192, 4096)
        if len(big):
            p8 = np.abs(np.fft.rfft(big * np.hanning(8192), axis=1)) ** 2 + 1e-12
            l8 = 10 * np.log10(p8[:, 1:].sum(axis=1))
            k8 = _speech_mask(l8) if len(l8) >= 4 else np.ones(len(l8), bool)
            f8 = np.fft.rfftfreq(8192, 1 / SR)
            L = 10 * np.log10(p8[k8].mean(axis=0))

            def contrast(sp):
                k = np.arange(np.ceil(3000 / sp), np.floor(11000 / sp))
                if len(k) < 6:
                    return 0.0
                on = np.interp(k * sp, f8, L)
                off = 0.5 * (np.interp((k - .5) * sp, f8, L) + np.interp((k + .5) * sp, f8, L))
                return float(np.mean(on - off))
            out["grid200"] = contrast(200.0)
            sweep = np.arange(100.0, 700.0, 2.0)
            cs = np.array([contrast(sp) for sp in sweep])
            out["comb_best"] = float(cs.max())
            out["comb_best_hz"] = float(sweep[int(cs.argmax())])
        else:
            out["grid200"] = out["comb_best"] = out["comb_best_hz"] = 0.0
    else:
        out["grid200"] = out["comb_best"] = out["comb_best_hz"] = 0.0

    # 5. Reverb tail: median time (ms) for the envelope to fall 20 dB after a speech offset.
    hop_e = 120                                        # 5 ms
    nfr = (len(w) - 240) // hop_e
    if nfr > 40:
        rms = np.sqrt((_frames(w, 240, hop_e) ** 2).mean(1) + 1e-12)
        e = 20 * np.log10(rms)
        e = np.convolve(e, np.ones(3) / 3, mode="same")
        peak = e.max()
        times = []
        i = 2
        while i < len(e) - 60:
            if e[i] > peak - 25 and e[i] >= e[i - 1] and e[i] >= e[i + 1]:
                # find the point 20 dB below within 600 ms
                seg_e = e[i:i + 120]
                below = np.flatnonzero(seg_e < e[i] - 20)
                if len(below) and np.all(e[i:i + below[0]] > e[i] - 20 - 1):
                    # require a real offset: the level stays down for the next 100 ms
                    j = i + below[0]
                    if np.all(e[j:j + 20] < e[i] - 15):
                        times.append(below[0] * 5.0)
                        i = j
                        continue
            i += 1
        out["tail_ms"] = float(np.median(times)) if len(times) >= 2 else float("nan")
    else:
        out["tail_ms"] = float("nan")

    # 6. Flat pitch (robotic): spread of the autocorrelation pitch in semitones over voiced frames.
    lo_lag, hi_lag = int(SR / 400), int(SR / 70)
    f0 = []
    idx = np.flatnonzero(mask)
    for fr in idx[:: max(1, len(idx) // 250)]:
        x = w[fr * HOP: fr * HOP + N_FFT]
        x = x - x.mean()
        spec = np.fft.rfft(x * window, n=2 * N_FFT)
        r = np.fft.irfft(np.abs(spec) ** 2)[:hi_lag + 1]
        if r[0] <= 0:
            continue
        r = r / r[0]
        lag = lo_lag + int(np.argmax(r[lo_lag:hi_lag]))
        if r[lag] > 0.5:
            f0.append(12 * np.log2(SR / lag / 100))
    if len(f0) >= 12:
        out["f0_std_st"] = float(np.std(f0))
        out["voiced_frac"] = round(len(f0) / len(idx[:: max(1, len(idx) // 250)]), 3)
    else:
        out["f0_std_st"] = float("nan")
        out["voiced_frac"] = round(len(f0) / max(1, len(idx[:: max(1, len(idx) // 250)])), 3)
    return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in out.items()}
