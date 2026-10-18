"""Lucy Kushinada: objective bed/pitch metrics for each caption cue of the downloaded English-dub clips (step B of the external flow).

For each cue (start/end from the official English captions) it measures, on the decoded stereo WAV from analyze_external.py:
the 90th-percentile speech level, the quietest 10 percent of frames INSIDE the cue and in the 0.3 s before and after (a music or effects bed
shows up as a floor near the speech level), the stereo side/mid ratio, the median pitch, and the share of frames above 160 Hz.
Nothing is played or cut.  Usage: python -I cue_metrics.py <work_dir> <name>=<vtt file> ...
The VTT files are downloaded data: read as plain text only.
"""
import math, os, re, sys, json
sys.stdout.reconfigure(encoding="utf-8")
import numpy as np, soundfile as sf, torch
import torchaudio.functional as AF

work = sys.argv[1]
def db(x): return 20 * math.log10(max(float(x), 1e-9))
def ts(s):
    p = s.split(":"); p = [float(x) for x in p]
    return p[0] * 60 + p[1] if len(p) == 2 else p[0] * 3600 + p[1] * 60 + p[2]
def frames_rms(x, sr, hop=0.01, win=0.025):
    h, w = int(sr * hop), int(sr * win)
    n = max(0, (len(x) - w) // h + 1)
    idx = np.arange(n)[:, None] * h + np.arange(w)[None, :]
    return np.sqrt((x[idx] ** 2).mean(axis=1) + 1e-12)
def cues(path):
    out = []
    for b in re.split(r"\n\n+", open(path, encoding="utf-8").read()):
        m = re.search(r"(\d+:\d+[:.]\d+(?:\.\d+)?) --> (\d+:\d+[:.]\d+(?:\.\d+)?)", b)
        if not m: continue
        txt = re.sub(r"<[^>]+>", "", " ".join(l for l in b.split("\n") if "-->" not in l and not l.strip().isdigit())).strip()
        out.append((ts(m.group(1)), ts(m.group(2)), txt))
    return out
res = {}
for arg in sys.argv[2:]:
    name, vtt = arg.split("=", 1)
    data, sr = sf.read(os.path.join(work, name + ".wav"), dtype="float32", always_2d=True)
    mid, side = data.mean(axis=1), (data[:, 0] - data[:, 1]) / 2
    rm, rs = frames_rms(mid, sr), frames_rms(side, sr)
    f0 = AF.detect_pitch_frequency(torch.from_numpy(mid)[None], sr, freq_low=70, freq_high=500)[0].numpy()
    hopf = len(mid) / len(f0)
    rows = []
    for s, e, t in cues(vtt):
        a, b = int(s * 100), int(e * 100)
        seg = rm[a:b]
        if len(seg) < 20: continue
        lvl = db(np.percentile(seg, 90)); inner = db(np.percentile(seg, 10))
        pre = rm[max(0, a - 30):a]; post = rm[b:b + 30]
        sm = db(np.sqrt((rs[a:b] ** 2).mean())) - db(np.sqrt((rm[a:b] ** 2).mean()))
        ff = f0[int(s * sr / hopf):int(e * sr / hopf)]
        loud = rm[a:b] > np.percentile(seg, 50)  # compare only the loud half's frames
        fl = f0[int(s * sr / hopf):int(e * sr / hopf)]
        v = ff[(ff > 75) & (ff < 495)]
        rows.append(dict(s=s, e=e, t=t, level=round(lvl, 1), innerFloor=round(inner, 1), preFloor=round(db(pre.min()), 1) if len(pre) else None, postFloor=round(db(post.min()), 1) if len(post) else None,
                         sideMid=round(sm, 1), f0=round(float(np.median(v)), 0) if len(v) > 5 else None, hi=round(float((v > 160).mean()), 2) if len(v) > 5 else None))
    res[name] = rows
    print("====", name)
    for r in rows:
        print(f"{r['s']:6.1f}-{r['e']:6.1f} lvl {r['level']:6.1f} inFloor {r['innerFloor']:6.1f} pre {r['preFloor']} post {r['postFloor']} side-mid {r['sideMid']:6.1f} f0 {r['f0']} hi {r['hi']} | {r['t']}")
json.dump(res, open(os.path.join(work, "cue-metrics.json"), "w", encoding="utf-8"), indent=1)
