"""Score rendered samples against the real voice: speaker similarity and how well Whisper reads the words back (offline, no network).

  python score_samples.py <scores.json> <real-clips.json> <samples.json>

real-clips.json : [{"sid", "path"}]  real clean lines of the voice (the similarity target is their mean embedding, leave-the-reference-out)
samples.json    : [{"name", "wav", "text" (the sentence that was synthesized), "exclude": [sid, ...] (clips used in the reference)}]
scores.json     : {name: {"sim": cosine to the real-voice centroid, "read": word-sequence ratio of Whisper's reading to the text, "heard": Whisper text}}

Speaker model: microsoft/wavlm-base-plus-sv x-vector (vendor/voice-models, offline).  Whisper: openai/whisper-small.en (same folder).
Similarity numbers are only comparable inside one run (real lines are other lines of the same voice, not the generated sentence).
Run with vendor/reference-voicestudio/.venv/Scripts/python.exe, CLIP_SEARCH_ROOT = the main checkout.
"""
from __future__ import annotations

import difflib
import glob
import json
import os
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio.functional as AF

ROOT = Path(os.environ.get("CLIP_SEARCH_ROOT") or Path(__file__).resolve().parents[3])
os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
HUB = ROOT / "vendor/voice-models/hub"


def snapshot(model: str) -> str:
    return glob.glob(str(HUB / f"models--{model.replace('/', '--')}" / "snapshots" / "*"))[0]


def load16(path: str) -> np.ndarray:
    data, rate = sf.read(path, dtype="float32", always_2d=True)
    wav = torch.from_numpy(data.mean(axis=1))
    return (AF.resample(wav, rate, 16000) if rate != 16000 else wav).numpy()


def norm(text: str) -> list[str]:
    return re.sub(r"[^a-z' ]", " ", text.lower().replace("–", " ")).split()


def main() -> int:
    out_path, real_path, samples_path = (Path(a) for a in sys.argv[1:4])
    real = json.loads(real_path.read_text(encoding="utf-8"))
    samples = json.loads(samples_path.read_text(encoding="utf-8"))
    from transformers import AutoFeatureExtractor, WavLMForXVector, pipeline
    device = "cuda" if torch.cuda.is_available() else "cpu"
    extractor = AutoFeatureExtractor.from_pretrained(snapshot("microsoft/wavlm-base-plus-sv"))
    model = WavLMForXVector.from_pretrained(snapshot("microsoft/wavlm-base-plus-sv")).to(device).eval()

    def embed(path: str):
        wav = load16(path)[: 16000 * 20]
        inputs = extractor(wav, sampling_rate=16000, return_tensors="pt").to(device)
        with torch.no_grad():
            vector = model(**inputs).embeddings[0]
        return torch.nn.functional.normalize(vector, dim=-1).cpu()

    real_embeddings = {item["sid"]: embed(item["path"]) for item in real}
    asr = pipeline("automatic-speech-recognition", model=snapshot("openai/whisper-small.en"), device=0 if device == "cuda" else -1)
    scores = {}
    for sample in samples:
        keep = [vector for sid, vector in real_embeddings.items() if sid not in set(sample.get("exclude", []))]
        centroid = torch.nn.functional.normalize(torch.stack(keep).mean(0), dim=-1)
        sim = float(embed(sample["wav"]) @ centroid)
        heard = asr({"raw": load16(sample["wav"]), "sampling_rate": 16000})["text"].strip()
        ratio = difflib.SequenceMatcher(None, norm(sample["text"]), norm(heard)).ratio()
        scores[sample["name"]] = {"sim": round(sim, 4), "read": round(ratio, 3), "heard": heard}
        print(sample["name"], scores[sample["name"]]["sim"], scores[sample["name"]]["read"], flush=True)
    out_path.write_text(json.dumps(scores, indent=1, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
