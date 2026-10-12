"""Objective "how clear is this voice" numbers for audio files (WAV, MP3, anything ffmpeg reads). Offline: no API, no playback.

    python scripts/Measure-VoxtralClarity.py a.wav b.mp3 ... [--json out.json] [--level-dir DIR --level-db -26]

Per file, over SPEECH FRAMES ONLY (1024-sample Hann frames every 256 samples; frames more than 35 dB under the loudest are dropped):
  loud       RMS level in dBFS of the kept frames (so a level difference is not mistaken for a tone difference)
  r85 r95    frequency (Hz) under which 85% / 95% of the long-term-average-spectrum (LTAS) energy lies (spectral rolloff)
  centroid   LTAS-weighted mean frequency (Hz)
  bw40 bw60  highest frequency (Hz) whose smoothed LTAS (200 Hz moving average of power) is within 40 / 60 dB of its peak
  bands      mean power per Hz in 0-1, 1-2, 2-4, 4-6, 6-8, 8-10, 10-12 kHz, in dB relative to the 0-4 kHz mean power per Hz
             (None above the file's Nyquist: the file has no content there by construction)
  hf4 hf8    share of the energy above 4 kHz / 8 kHz, in dB re the whole (hf8 is -120 for a file with nothing above 8 kHz)
  rate       sample rate of the file as decoded (not resampled)
--null A B [--fit-gain]  prints the null test of B against A (residual, SNR overall and per band) instead.
--level-dir writes a copy of each file, gain only, at --level-db RMS (speech frames) as 16-bit 24 kHz-or-native-rate WAV, so the
listening set can be compared for tone rather than volume. Nothing is played.
"""
import json, os, subprocess, sys, tempfile
import numpy as np
from scipy.io import wavfile

FFMPEG = os.environ.get('CYBERPUNK_CONVAI_FFMPEG') or 'ffmpeg'
BANDS = [(0, 1000), (1000, 2000), (2000, 4000), (4000, 6000), (6000, 8000), (8000, 10000), (10000, 12000)]
N, HOP, GATE_DB = 1024, 256, 35.0


def load(path):
    """-> (float64 mono samples, rate). WAV is read directly (int16 / int32 / float32), anything else through ffmpeg at its own rate."""
    if path.lower().endswith('.wav'):
        try:
            rate, data = wavfile.read(path)
        except ValueError:
            data = None
        if data is not None:
            data = np.asarray(data)
            if data.dtype == np.int16: data = data / 32768.0
            elif data.dtype == np.int32: data = data / 2147483648.0
            elif data.dtype == np.uint8: data = (data - 128) / 128.0
            data = data.astype(np.float64)
            return (data.mean(axis=1) if data.ndim > 1 else data), rate
    with tempfile.TemporaryDirectory() as folder:
        out = os.path.join(folder, 'x.wav')
        subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-ac', '1', '-c:a', 'pcm_f32le', out], check=True)
        rate, data = wavfile.read(out)
        return data.astype(np.float64), rate


def frames_of(x):
    count = 1 + (len(x) - N) // HOP
    index = np.arange(N)[None, :] + HOP * np.arange(count)[:, None]
    return x[index]


def speech_mask(frames):
    power = (frames ** 2).mean(axis=1)
    level = 10 * np.log10(power + 1e-20)
    return level >= level.max() - GATE_DB


def analyse(x, rate):
    frames = frames_of(x)
    keep = speech_mask(frames)
    kept = frames[keep]
    loud = 10 * np.log10((kept ** 2).mean() + 1e-20) / 1.0   # dB re full scale (power -> 10 log10), RMS dBFS
    spectrum = np.abs(np.fft.rfft(kept * np.hanning(N), axis=1)) ** 2
    ltas = spectrum.mean(axis=0)
    freqs = np.fft.rfftfreq(N, 1 / rate)
    cumulative = np.cumsum(ltas) / ltas.sum()
    out = {'rate': int(rate), 'seconds': round(len(x) / rate, 2), 'speechFrames': f'{int(keep.sum())}/{len(keep)}', 'loud': round(float(loud), 2)}
    out['r85'] = int(freqs[np.searchsorted(cumulative, 0.85)])
    out['r95'] = int(freqs[np.searchsorted(cumulative, 0.95)])
    out['centroid'] = int((freqs * ltas).sum() / ltas.sum())
    width = max(1, int(round(200 / (rate / N))))
    smooth = np.convolve(ltas, np.ones(width) / width, mode='same')
    smooth_db = 10 * np.log10(smooth + 1e-30)
    peak = smooth_db.max()
    for name, drop in (('bw40', 40), ('bw60', 60)):
        above = np.nonzero(smooth_db >= peak - drop)[0]
        out[name] = int(freqs[above.max()])
    density = lambda lo, hi: ltas[(freqs >= lo) & (freqs < hi)].mean()
    reference = density(0, 4000)
    out['bands'] = [round(float(10 * np.log10(density(lo, hi) / reference)), 1) if hi <= rate / 2 + 1 else None for lo, hi in BANDS]
    out['hf4'] = round(float(10 * np.log10(ltas[freqs >= 4000].sum() / ltas.sum())), 1)   # share of energy above 4 kHz, dB re total
    out['hf8'] = round(float(10 * np.log10(ltas[freqs >= 8000].sum() / ltas.sum() + 1e-12)), 1)   # above 8 kHz
    out['peak'] = round(float(20 * np.log10(np.abs(x).max() + 1e-20)), 2)
    return out


def null_test(path_a, path_b, fit_gain=False):
    """Null test B against A (same length, aligned): the residual B - A in dB re A, overall and per band (speech frames of A only).
    fit_gain removes a plain level difference first (least-squares gain), for chains that add makeup or the pan law."""
    a, rate = load(path_a)
    b, rate_b = load(path_b)
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    gain = float((a * b).sum() / (b * b).sum()) if fit_gain else 1.0
    residual = a - b * gain
    keep = speech_mask(frames_of(a))
    fa, fr = frames_of(a)[keep], frames_of(residual)[keep]
    window = np.hanning(N)
    pa = (np.abs(np.fft.rfft(fa * window, axis=1)) ** 2).mean(axis=0)
    pr = (np.abs(np.fft.rfft(fr * window, axis=1)) ** 2).mean(axis=0) + 1e-30
    freqs = np.fft.rfftfreq(N, 1 / rate)
    out = {'gainApplied': round(20 * np.log10(gain), 4), 'overallSnrDb': round(float(10 * np.log10((fa ** 2).sum() / ((fr ** 2).sum() + 1e-30))), 1)}
    out['bandSnrDb'] = {f'{lo // 1000}-{hi // 1000}k': round(float(10 * np.log10(pa[(freqs >= lo) & (freqs < hi)].sum() / pr[(freqs >= lo) & (freqs < hi)].sum())), 1) for lo, hi in BANDS}
    out['residualLoudDb'] = round(float(10 * np.log10((fr ** 2).mean() + 1e-30)), 1)
    return out


def main(argv):
    if argv and argv[0] == '--null':      # python Measure-VoxtralClarity.py --null raw.wav other.wav [--fit-gain]
        print(json.dumps(null_test(argv[1], argv[2], '--fit-gain' in argv)))
        return
    files, json_path, level_dir, level_db = [], None, None, -26.0
    it = iter(argv)
    for arg in it:
        if arg == '--json': json_path = next(it)
        elif arg == '--level-dir': level_dir = next(it)
        elif arg == '--level-db': level_db = float(next(it))
        else: files.append(arg)
    rows = {}
    for path in files:
        x, rate = load(path)
        row = analyse(x, rate)
        rows[os.path.basename(path)] = row
        if level_dir:
            os.makedirs(level_dir, exist_ok=True)
            gain = 10 ** ((level_db - row['loud']) / 20)
            y = np.clip(x * gain, -1, 1)
            if np.abs(x * gain).max() > 1: print(f'warning: {path} clips at {level_db} dB', file=sys.stderr)
            base = os.path.splitext(os.path.basename(path))[0]
            wavfile.write(os.path.join(level_dir, base + '-lvl.wav'), rate, np.round(y * 32767).astype(np.int16))
            row['levelGainDb'] = round(20 * np.log10(gain), 2)
    header = f"{'file':44} {'rate':>6} {'loud':>7} {'r85':>6} {'r95':>6} {'cent':>6} {'bw40':>6} {'bw60':>6} {'hf4':>6} {'hf8':>6}   bands dB rel 0-4k: 0-1 1-2 2-4 4-6 6-8 8-10 10-12"
    print(header)
    for name, r in rows.items():
        bands = ' '.join(f'{b:5.1f}' if b is not None else '    -' for b in r['bands'])
        print(f"{name[:44]:44} {r['rate']:6} {r['loud']:7.2f} {r['r85']:6} {r['r95']:6} {r['centroid']:6} {r['bw40']:6} {r['bw60']:6} {r['hf4']:6.1f} {r['hf8']:6.1f}   {bands}")
    if json_path:
        with open(json_path, 'w') as handle: json.dump(rows, handle, indent=1)


if __name__ == '__main__':
    main(sys.argv[1:])
