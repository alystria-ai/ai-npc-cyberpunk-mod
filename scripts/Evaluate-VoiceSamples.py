"""Supplement listening with local ASR and speaker-embedding measurements.

These scores do not automatically approve voices. WavLM similarity is measured
against several held-out development recordings, not just the cloning prompt.
No recordings or transcripts are sent to a service.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("HF_HOME", str(ROOT / "vendor/voice-models"))
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
import numpy as np
import torch
from transformers import AutoFeatureExtractor, AutoModelForAudioXVector, AutoProcessor, AutoModelForSpeechSeq2Seq
from omnivoice.utils.audio import load_audio


def words(text):
    return re.sub(r"[^a-z0-9' ]", " ", text.lower().replace("’", "'")).split()


def error_rate(reference, hypothesis):
    expected, actual = words(reference), words(hypothesis)
    previous = list(range(len(actual) + 1))
    for i, word in enumerate(expected, 1):
        current = [i]
        for j, other in enumerate(actual, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (word != other)))
        previous = current
    return previous[-1] / max(len(expected), 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    report_path = args.report.resolve()
    if not report_path.is_relative_to(ROOT / "runtime"):
        parser.error("Expected a private runtime report")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    torch.set_num_threads(4); torch.set_num_interop_threads(2)
    models = json.loads((ROOT / "runtime/voice-training/evaluation-models.json").read_text(encoding="utf-8"))
    sv_path = models["microsoft/wavlm-base-plus-sv"]["path"]
    sv_features = AutoFeatureExtractor.from_pretrained(sv_path, local_files_only=True)
    sv_model = AutoModelForAudioXVector.from_pretrained(sv_path, local_files_only=True).to(args.device).eval()
    def embed(path):
        data = load_audio(str(path), 16000).squeeze(0)
        features = sv_features(data, sampling_rate=16000, return_tensors="pt", padding=True).to(args.device)
        with torch.inference_mode():
            return torch.nn.functional.normalize(sv_model(**features).embeddings, dim=-1).cpu()[0]
    vectors_by_key = {}
    result = {"models": models, "referenceIdsByCharacter": {},
        "note": "Diagnostic comparisons, not voice acceptance. ASR can miss words or repair errors; similarity does not measure acting/naturalness.", "clips": []}
    for clip in report["clips"]:
        key = clip.get("key", report.get("key"))
        if not isinstance(key, str) or not re.fullmatch(r"[a-z0-9-]+", key):
            raise ValueError("Each sample needs an explicit character identity")
        if key not in vectors_by_key:
            dev_file = ROOT / "runtime/voice-references/training" / key / "dev.jsonl"
            dev = [json.loads(line) for line in dev_file.read_text(encoding="utf-8").splitlines()]
            # Fixed selection made without looking at any synthesis scores.
            references = sorted(dev, key=lambda r: hashlib.sha256(r["id"].encode()).hexdigest())[:8]
            vectors_by_key[key] = torch.stack([embed(r["audio_path"]) for r in references])
            result["referenceIdsByCharacter"][key] = [r["id"] for r in references]
        vector = embed(clip["path"])
        scores = (vectors_by_key[key] @ vector).tolist()
        row = dict(clip, key=key, speakerCosineMean=float(np.mean(scores)), speakerCosineByReference=scores)
        result["clips"].append(row)
    del sv_model
    if args.device == "cuda": torch.cuda.empty_cache()
    asr_path = models["openai/whisper-small.en"]["path"]
    processor = AutoProcessor.from_pretrained(asr_path, local_files_only=True)
    asr = AutoModelForSpeechSeq2Seq.from_pretrained(asr_path, local_files_only=True).to(args.device).eval()
    for row in result["clips"]:
        data = load_audio(row["path"], 16000).squeeze(0)
        features = processor(data, sampling_rate=16000, return_tensors="pt", return_attention_mask=True).to(args.device)
        with torch.inference_mode():
            ids = asr.generate(**features, max_new_tokens=200, do_sample=False)
        heard = processor.batch_decode(ids, skip_special_tokens=True)[0].strip()
        row.update({"asrTranscript": heard, "wordErrorRate": error_rate(row["text"], heard)})
        print(json.dumps({k: row[k] for k in ("key", "variant", "name", "speakerCosineMean", "wordErrorRate", "asrTranscript")}), flush=True)
        report_path.with_name("quality-report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
