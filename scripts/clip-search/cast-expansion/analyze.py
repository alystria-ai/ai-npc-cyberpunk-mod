"""Objective checks of one character's extracted clips (nothing is played): duration, peak, clipping, gated loudness, silence,
noise floor, band limit (phone/holocall processing), a pitch estimate, a WavLM speaker-verification consistency score, and a
Whisper small.en transcript compared with the installed subtitle.  CPU only, low process priority.

The ECAPA weights the 2026-10-13 recipe used were removed in the 2026-10-16 clean-up (fetching them needs approval); the
WavLM base-plus-sv model already on disk (vendor/voice-models/hub) gives the same kind of number: the mean cosine of a clip's
x-vector to the other clips of the set ("typicality").  Scene-level attribution is the identity proof; this only flags outliers
(effects, shouting, another voice).

Writes WORK/<key>/analysis.json.  Usage: python analyze.py --key bryce-mosley [--no-asr]
"""
from __future__ import annotations

import argparse
import ctypes
import difflib
import glob
import math
import os
import re
import sys

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
import numpy as np
import soundfile as sf
import torch
from scipy.signal import resample_poly

from cx_common import MAIN, read_json, work_dir, write_json

sys.path.insert(0, str(MAIN / "scripts/phone_detect"))
from spectral import features as spectral_features  # noqa: E402

if os.name == "nt":
    ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)
torch.set_num_threads(4)
HUB = MAIN / "vendor/voice-models/hub"


def load(path, rate):
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if sr != rate:
        g = math.gcd(sr, rate)
        mono = resample_poly(mono, rate // g, sr // g).astype(np.float32)
    return mono


def db(x):
    return 20 * math.log10(max(x, 1e-9))


def metrics(path):
    m = load(path, 24000)
    r = 24000
    peak = float(np.abs(m).max())
    fr = int(r * 0.02)
    n = len(m) // fr
    e = np.sqrt((m[: n * fr].reshape(n, fr) ** 2).mean(axis=1))
    el = 20 * np.log10(e + 1e-9)
    silent = el < np.percentile(el, 95) - 35
    f50 = int(r * 0.05)
    c = len(m) // f50
    en = (m[: c * f50].reshape(c, f50) ** 2).mean(axis=1)
    gated = float(10 * math.log10(en[en >= en.max() * 10 ** (-2.5)].mean()))
    spec = spectral_features(m, r) or {}
    f0m = None
    try:
        import torchaudio.functional as AF
        f0 = AF.detect_pitch_frequency(torch.from_numpy(m)[None], r, freq_low=60, freq_high=400)[0].numpy()
        hop = max(1, len(m) // len(f0))
        gate = np.array([np.sqrt((m[i * hop:(i + 1) * hop] ** 2).mean()) for i in range(len(f0))])
        voiced = f0[gate >= np.percentile(gate, 60)]
        f0m = round(float(np.median(voiced)), 1)
    except Exception:
        pass
    return {"seconds": round(len(m) / r, 3), "peakDbfs": round(db(peak), 2), "clipped": int((np.abs(m) >= 0.9995).sum()),
            "gatedRmsDb": round(gated, 2), "silenceRatio": round(float(silent.mean()), 3),
            "noiseFloorDb": round(float(np.percentile(el, 10)), 1), "f0MedianHz": f0m,
            "hiRel": None if spec.get("hi_rel") is None else round(float(spec["hi_rel"]), 1),
            "f99": spec.get("f99"), "edgeDrop": None if spec.get("edge_drop") is None else round(float(spec["edge_drop"]), 1)}


def wavlm_typicality(paths):
    from transformers import AutoFeatureExtractor, WavLMForXVector
    snap = glob.glob(str(HUB / "models--microsoft--wavlm-base-plus-sv/snapshots/*"))[0]
    fe = AutoFeatureExtractor.from_pretrained(snap)
    model = WavLMForXVector.from_pretrained(snap).eval()
    embs = []
    with torch.no_grad():
        for p in paths:
            audio = load(p, 16000)
            inputs = fe(audio, sampling_rate=16000, return_tensors="pt")
            embs.append(torch.nn.functional.normalize(model(**inputs).embeddings, dim=-1)[0])
    E = torch.stack(embs)
    sim = (E @ E.T).numpy()
    n = len(paths)
    return [round(float((sim[i].sum() - 1) / max(1, n - 1)), 3) for i in range(n)], sim


def norm(t):
    return re.sub(r"[^a-z0-9' ]", " ", (t or "").lower().replace("–", " ").replace("—", " ").replace("’", "'")).split()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--key", required=True)
    parser.add_argument("--no-asr", action="store_true")
    args = parser.parse_args()
    manifest = read_json(work_dir(args.key) / "manifest.json")
    clips = []
    for row in manifest:
        met = metrics(row["wavPath"])
        met.update({"id": row["stringId"], "text": row["transcript"], "scene": row["scene"], "wavPath": row["wavPath"]})
        clips.append(met)
    typ, sim = wavlm_typicality([c["wavPath"] for c in clips])
    for c, t in zip(clips, typ):
        c["typicality"] = t
    if not args.no_asr:
        from transformers import pipeline
        snap = glob.glob(str(HUB / "models--openai--whisper-small.en/snapshots/*"))[0]
        asr = pipeline("automatic-speech-recognition", model=snap, device=-1)
        for c in clips:
            heard = asr({"raw": load(c["wavPath"], 16000), "sampling_rate": 16000})["text"].strip()
            c["asr"] = heard
            c["asrSimilarity"] = round(difflib.SequenceMatcher(None, norm(c["text"]), norm(heard)).ratio(), 2)
    out = {"key": args.key, "speakerModel": "microsoft/wavlm-base-plus-sv (x-vector cosine)", "clips": clips,
           "typicalityMedian": float(np.median(typ)) if typ else None}
    write_json(work_dir(args.key) / "analysis.json", out)
    for c in clips:
        print(f"{c['id']} {c['seconds']}s peak {c['peakDbfs']} gated {c['gatedRmsDb']} sil {c['silenceRatio']} hi {c['hiRel']} "
              f"f0 {c['f0MedianHz']} typ {c['typicality']} asr {c.get('asrSimilarity')} | {c['text'][:70]}")
    print("typicality median", out["typicalityMedian"])


if __name__ == "__main__":
    main()
