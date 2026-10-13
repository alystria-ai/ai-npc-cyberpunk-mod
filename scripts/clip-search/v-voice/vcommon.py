"""Shared audio helpers for the V voice reference scripts (numpy / scipy / soundfile only, CPU only, plays nothing)."""
import math, re
import numpy as np, soundfile as sf
from scipy.signal import resample_poly

RATE, GAP, MARGIN, THRESH_DB = 24000, 0.4, 0.08, -45.0   # GAP: the project standard (scripts/clip-search/common.py GAP_SECONDS), the length the search scored
MONO_KEEP_RATIO = 0.9      # the mean downmix must keep at least 90% of the left channel's RMS, else the channels are decorrelated


def read_native(path):
    """(samples [n, ch] float32, sampleRate)."""
    d, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return d, sr


def pick_channel(d):
    """Left channel only when the stereo channels are decorrelated (a mean downmix would comb-filter the voice, as for Delamain),
    else the mono mean.  Returns (mono float32 at the native rate, info)."""
    if d.shape[1] == 1:
        return d[:, 0], {"channels": 1, "corr": None, "meanRatio": 1.0, "used": "mono"}
    left, right = d[:, 0].astype(np.float64), d[:, 1].astype(np.float64)
    denom = math.sqrt(float((left ** 2).sum() * (right ** 2).sum())) or 1.0
    corr = float((left * right).sum() / denom)
    mean_rms = math.sqrt(float((((left + right) / 2) ** 2).mean()))
    left_rms = math.sqrt(float((left ** 2).mean())) or 1e-9
    ratio = mean_rms / left_rms
    if ratio >= MONO_KEEP_RATIO:
        return ((d[:, 0] + d[:, 1]) / 2).astype(np.float32), {"channels": d.shape[1], "corr": round(corr, 3), "meanRatio": round(ratio, 3), "used": "mean"}
    return d[:, 0], {"channels": d.shape[1], "corr": round(corr, 3), "meanRatio": round(ratio, 3), "used": "left"}


def resample(d, sr, rate=RATE):
    if sr == rate:
        return d.astype(np.float32)
    g = math.gcd(int(sr), int(rate))
    return resample_poly(d, rate // g, sr // g).astype(np.float32)


def load_mono24(path):
    """The clip exactly as the reference build uses it (before trimming): chosen channel, 24 kHz mono float32, plus info."""
    d, sr = read_native(path)
    mono, info = pick_channel(d)
    info["nativeRate"] = sr
    return resample(mono, sr), mono, sr, info


def trim(d):
    """Cut leading/trailing silence below -45 dBFS (10 ms frames), keeping 80 ms of margin."""
    n = len(d) // 240 * 240
    fr = np.sqrt((d[:n].reshape(-1, 240) ** 2).mean(1)) + 1e-9
    loud = np.where(20 * np.log10(fr) > THRESH_DB)[0]
    if not len(loud):
        return d
    lo = max(0, loud[0] * 240 - int(MARGIN * RATE))
    hi = min(len(d), (loud[-1] + 1) * 240 + int(MARGIN * RATE))
    return d[lo:hi]


def db(x):
    return 20 * math.log10(max(float(x), 1e-9))


def f0_stats(m, rate=RATE):
    """Median / 10th / 90th percentile fundamental frequency (Hz) of voiced frames by normalised autocorrelation (70-400 Hz)."""
    fr, hop = int(rate * 0.04), int(rate * 0.02)
    lo, hi = int(rate / 400), int(rate / 70)
    f0s = []
    for s in range(0, len(m) - fr, hop):
        x = m[s:s + fr].astype(np.float64)
        if np.sqrt((x ** 2).mean()) < 0.01:
            continue
        x = x - x.mean()
        ac = np.correlate(x, x, "full")[fr - 1:]
        if ac[0] <= 0:
            continue
        ac = ac / ac[0]
        k = lo + int(np.argmax(ac[lo:hi]))
        if ac[k] > 0.6:
            f0s.append(rate / k)
    if len(f0s) < 5:
        return None
    a = np.array(f0s)
    return {"median": round(float(np.median(a)), 1), "p10": round(float(np.percentile(a, 10)), 1), "p90": round(float(np.percentile(a, 90)), 1),
            "voicedFrames": len(a)}


SPELL = {"'em": "them", "'er": "her", "'im": "him", "'cause": "because", "'kay": "okay", "ok": "okay", "ya": "you", "y'know": "you know",
         "'til": "until", "outta": "out of", "gonna": "going to", "wanna": "want to", "gotta": "got to", "kinda": "kind of",
         "whaddaya": "what do you", "mighta": "might have", "coulda": "could have", "shoulda": "should have"}


def norm(t):
    """Lower-case word list for comparing a subtitle with a recogniser's text: the subtitles spell dropped g's, clipped words and
    contractions the way they are said ("gettin'", "'em", "intersection'll"), the recogniser writes them out, so both sides are
    mapped to the written form first."""
    out = []
    for w in re.sub(r"[^a-z' ]", " ", t.lower().replace("\u2013", " ").replace("\u2019", "'")).split():
        w = SPELL.get(w, w)
        if w.endswith("in'") and len(w) > 4:
            w = w[:-3] + "ing"
        w = re.sub(r"'ll$", " will", w)
        w = re.sub(r"'re$", " are", w)
        w = re.sub(r"'ve$", " have", w)
        w = re.sub(r"'d$", " would", w)
        w = re.sub(r"'s$", "", w)
        out += w.split()
    return out
