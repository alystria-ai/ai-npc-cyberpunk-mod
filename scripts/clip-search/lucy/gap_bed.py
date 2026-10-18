"""Lucy Kushinada: what is in the gaps between the captioned lines?  Step C of the external flow.

For every gap of 0.8 s or more between caption cues (with 0.1 s margin), report the gap's mean level, its spectral flatness (noise is flat, music
and hum are peaky) and its strongest narrow peak above the median spectrum.  A gap near digital silence means a clean dialogue bed;
a gap around -30 dB with a tonal peak means music or ambience runs under the speech.   Usage: python -I gap_bed.py <wav> <cues.json> <name>
"""
import json, math, sys
sys.stdout.reconfigure(encoding="utf-8")
import numpy as np, soundfile as sf
wav, cuejson, name = sys.argv[1:4]
data, sr = sf.read(wav, dtype="float32", always_2d=True)
mid = data.mean(axis=1)
cues = json.load(open(cuejson, encoding="utf-8"))[name]
edges = [(c["s"], c["e"]) for c in cues]
def db(x): return 20 * math.log10(max(float(x), 1e-9))
print("name", name, "seconds", round(len(mid) / sr, 1))
for (s0, e0), (s1, e1) in zip(edges, edges[1:]):
    a, b = e0 + 0.1, s1 - 0.1
    if b - a < 0.8: continue
    x = mid[int(a * sr):int(b * sr)]
    n = 4096; hop = 2048
    spec = np.array([np.abs(np.fft.rfft(x[i:i + n] * np.hanning(n))) ** 2 for i in range(0, len(x) - n, hop)])
    if not len(spec): continue
    ps = spec.mean(axis=0) + 1e-18
    fl = np.exp(np.log(ps[5:2000]).mean()) / ps[5:2000].mean()
    sm = np.convolve(np.log(ps), np.ones(41) / 41, mode="same")
    peak = float((np.log(ps) - sm)[5:2000].max()) * 10 / math.log(10)
    freqs = np.fft.rfftfreq(n, 1 / sr)
    lowfrac = ps[freqs < 200].sum() / ps.sum()
    print(f"gap {a:6.1f}-{b:6.1f} ({b-a:4.1f}s) level {db(np.sqrt((x**2).mean())):6.1f} dB flatness {fl:.3f} peak {peak:4.1f} dB lowfrac {lowfrac:.2f}")
