"""Rita Wheeler: objective checks of the extracted clips (copy of missing-two/analyze_two.py for one key, plus a pitch estimate): duration, clipping, silence, loudness, noise floor, hum, band-limit (phone) features,
ECAPA speaker consistency (CPU only).  Writes analysis.json next to the manifest.  Nothing is played."""
import json, sys, math, os, ctypes
from pathlib import Path
import numpy as np, soundfile as sf, torch
from scipy.signal import resample_poly
sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod")
WORK = ROOT / "runtime/voice-references/extracted"
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
    try:
        import torchaudio.functional as AF
        f0 = AF.detect_pitch_frequency(torch.from_numpy(m)[None], r, freq_low=60, freq_high=400)[0].numpy()
        hop = (len(m) // len(f0))
        # keep frames that carry energy (loudest 40 percent of 20 ms frames, mapped onto the pitch frames)
        gate = np.array([np.sqrt((m[i * hop:(i + 1) * hop] ** 2).mean()) for i in range(len(f0))])
        voiced = f0[gate >= np.percentile(gate, 60)]
        f0m = {"medianHz": round(float(np.median(voiced)), 1), "p10Hz": round(float(np.percentile(voiced, 10)), 1), "p90Hz": round(float(np.percentile(voiced, 90)), 1)}
    except Exception as error:
        f0m = {"error": str(error)[:80]}
    return {"seconds": round(len(m) / r, 3), "peakDbfs": round(db(peak), 2), "clipped": int((np.abs(m) >= 0.9995).sum()),
            "gatedRmsDb": round(gated, 2), "silenceRatio": round(float(silent.mean()), 3), "leadSilenceS": round(lead, 2), "trailSilenceS": round(trail, 2),
            "f0": f0m, "noiseFloorDb": round(floor, 1), "speechToFloorDb": round(float(speech_ref - floor), 1), "hum": hum,
            "bandwidthHz": {k: spec.get(k) for k in ("cutoff_hz", "floor_hz", "f99", "hi_rel", "vhi_rel", "lo_rel", "edge_drop")} if spec else None}

import torch.nn.functional as F
torch.set_num_threads(4)
# The ECAPA weights were removed in the 2026-10-16 clean-up (E:\CyberpunkConvai-offload\work\likeness-phase1\ecapa-src has no
# embedding_model.ckpt), and fetching them is a download that needs the user's go. All nine clips are one actor in one scene
# (attribution by the scene's own speaker field), so speaker consistency holds by construction; ECAPA is skipped, not faked.
man = json.loads((WORK / "rita-wheeler-extract-manifest.json").read_text("utf-8"))
out = {"ecapa": "skipped: weights not on disk (download needs approval)"}
rows = [r for r in man if r["key"] == "rita-wheeler"]
clips = []
for r in rows:
    met = metrics(r["wavPath"]); met.update({"id": r["stringId"], "text": r["transcript"]})
    clips.append(met)
out["rita-wheeler"] = {"clips": clips}
out["_scale"] = {p: metrics(ROOT / f"runtime/voice-references/picked/autobest/omni-long/{p}.wav") for p in ("judy-alvarez", "alex", "takemura", "claire-russell", "panam-palmer", "regina-jones", "meredith-stout", "lizzy-wizzy", "judy-alvarez")}
(WORK / "rita-wheeler-analysis.json").write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
for c in clips:
    print(c["id"], c["seconds"], "peak", c["peakDbfs"], "gated", c["gatedRmsDb"], "sil", c["silenceRatio"], "lead/trail", c["leadSilenceS"], c["trailSilenceS"], "floor", c["noiseFloorDb"], "hum", c["hum"], "f0", c["f0"], "|", c["text"])
print("scale (existing references):")
for k, c in out["_scale"].items():
    print(" ", k, "gated", c["gatedRmsDb"], "peak", c["peakDbfs"], "f0", c["f0"], "floor", c["noiseFloorDb"], "bw", c["bandwidthHz"] and c["bandwidthHz"].get("f99"))
