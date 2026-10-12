"""Objective checks of the extracted clips: duration, clipping, silence, loudness, noise floor, hum, band-limit (phone) features,
ECAPA speaker consistency (CPU only).  Writes analysis.json next to the manifest.  Nothing is played."""
import json, sys, math, os, ctypes
from pathlib import Path
import numpy as np, soundfile as sf
from scipy.signal import resample_poly
sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod")
WORK = Path("E:/CyberpunkConvai-offload/work/clip-search/missing-two")
sys.path.insert(0, str(ROOT / "scripts/phone_detect"))
from spectral import features as spectral_features
ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)

def load(path, rate):
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if sr != rate:
        g = math.gcd(sr, rate); mono = resample_poly(mono, rate // g, sr // g).astype(np.float32)
    return mono

def db(x): return 20 * math.log10(max(x, 1e-9))

def metrics(path):
    m = load(path, 24000); r = 24000
    peak = float(np.abs(m).max())
    fr = int(r * 0.02); n = len(m) // fr
    e = np.sqrt((m[: n * fr].reshape(n, fr) ** 2).mean(axis=1))
    el = 20 * np.log10(e + 1e-9)
    speech_ref = np.percentile(el, 95)
    silent = el < speech_ref - 35           # frames 35 dB under the loud ones
    lead = int(np.argmax(~silent)) * 0.02; trail = int(np.argmax(~silent[::-1])) * 0.02
    f50 = int(r * 0.05); c = len(m) // f50
    en = (m[: c * f50].reshape(c, f50) ** 2).mean(axis=1)
    gated = float(10 * math.log10(en[en >= en.max() * 10 ** (-2.5)].mean()))
    floor = float(np.percentile(el, 10))
    # hum: spectrum of the quietest 15% frames, tonal peaks below 400 Hz relative to the median level in 400-2000 Hz
    q = np.argsort(el)[: max(3, int(0.15 * n))]
    seg = np.concatenate([m[i * fr:(i + 1) * fr] for i in q])
    hum = None
    if len(seg) >= 2048:
        sp = np.abs(np.fft.rfft(seg * np.hanning(len(seg)))) ** 2; fq = np.fft.rfftfreq(len(seg), 1 / r)
        band = (fq > 30) & (fq < 400); ref = np.median(sp[(fq > 400) & (fq < 2000)]) + 1e-20
        i = np.argmax(sp * band); hum = {"peakHz": round(float(fq[i]), 1), "overMedianDb": round(float(10 * math.log10(max(sp[i], 1e-20) / ref)), 1)}
    spec = spectral_features(m, r)
    return {"seconds": round(len(m) / r, 3), "peakDbfs": round(db(peak), 2), "clipped": int((np.abs(m) >= 0.9995).sum()),
            "gatedRmsDb": round(gated, 2), "silenceRatio": round(float(silent.mean()), 3), "leadSilenceS": round(lead, 2), "trailSilenceS": round(trail, 2),
            "noiseFloorDb": round(floor, 1), "speechToFloorDb": round(float(speech_ref - floor), 1), "hum": hum,
            "bandwidthHz": {k: spec.get(k) for k in ("cutoff_hz", "floor_hz", "f99", "hi_rel", "vhi_rel", "lo_rel", "edge_drop")} if spec else None}

import torch, torch.nn.functional as F
torch.set_num_threads(4)
from speechbrain.inference.speaker import EncoderClassifier
from speechbrain.utils.fetching import LocalStrategy
LIK = Path("E:/CyberpunkConvai-offload/work/likeness-phase1")
model = EncoderClassifier.from_hparams(source=str(LIK / "ecapa-src"), savedir=str(LIK / "ecapa"), overrides={"pretrained_path": str(LIK / "ecapa-src")},
                                       local_strategy=LocalStrategy.COPY, run_opts={"device": "cpu"})
def embed(path):
    w = load(path, 16000)
    k = 6 * 16000
    if len(w) > k: s = (len(w) - k) // 2; w = w[s:s + k]
    with torch.inference_mode():
        v = model.encode_batch(torch.from_numpy(w)[None]).reshape(1, -1)
    return F.normalize(v, dim=-1)[0]

man = json.loads((WORK / "extract-manifest.json").read_text("utf-8"))
out = {}
for key in ("jake-estevez", "8ug8ear"):
    rows = [r for r in man if r["key"] == key]
    embs = [embed(r["wavPath"]) for r in rows]
    S = torch.stack(embs); sim = (S @ S.T).numpy()
    cen = S.mean(0)
    clips = []
    for i, r in enumerate(rows):
        others = [j for j in range(len(rows)) if j != i]
        loo = F.normalize(S[others].mean(0), dim=-1)
        met = metrics(r["wavPath"]); met.update({"id": r["stringId"], "text": r["transcript"], "ecapaToOthers": round(float(S[i] @ loo), 4),
                                              "ecapaPairMin": round(float(min(sim[i, j] for j in others)), 4)})
        clips.append(met)
    out[key] = {"clips": clips, "pairwise": np.round(sim, 3).tolist(), "ids": [r["stringId"] for r in rows]}
# baseline across other speakers: six existing omni-long references (other characters)
base = sorted((ROOT / "runtime/voice-references/picked/autobest/omni-long").glob("*.wav"))[::10][:8]
be = torch.stack([embed(p) for p in base]); bs = (be @ be.T).numpy()
out["_otherSpeakersPairMean"] = round(float((bs.sum() - len(base)) / (len(base) * (len(base) - 1))), 4)
out["_otherSpeakersPairMax"] = round(float(np.max(bs - np.eye(len(base)) * 9)), 4)
out["_baseline"] = [p.stem for p in base]
# cross check: each new character against the other speakers
for key in ("jake-estevez", "8ug8ear"):
    ids = out[key]["ids"]; rows = [r for r in man if r["key"] == key]
    S = torch.stack([embed(r["wavPath"]) for r in rows])
    out[key]["vsOtherSpeakersMean"] = round(float((S @ be.T).mean()), 4)
# existing reference metrics for scale (Judy long, Alex long)
out["_scale"] = {p: metrics(ROOT / f"runtime/voice-references/picked/autobest/omni-long/{p}.wav") for p in ("judy-alvarez", "alex", "takemura")}
(WORK / "analysis.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
print(json.dumps(out, indent=1, ensure_ascii=False))
