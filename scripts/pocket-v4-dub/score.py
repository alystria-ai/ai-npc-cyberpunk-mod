"""Score the Pocket v4 dub-reference renders: ECAPA speaker similarity (same method as the OmniVoice pack check) and intelligibility (ASR).

usage: python -X utf8 -I score.py --renders <dir with <lang>/records.json> --packs <voices/multilingual> --check <deliverables/voice-packs>
           --ecapa-src <dir with hyperparams.yaml> --ecapa-weights <HF snapshot dir> --asr-libs <dir holding sherpa_onnx>
           --asr-model <parakeet-tdt-0.6b-v3-int8 dir> --scratch <writable dir> --out <results.json>

Speaker: ECAPA (speechbrain/spkrec-ecapa-voxceleb) cosine between the three rendered sentences joined with 0.3 s gaps and the pack's dub clip
(cosDub) or the English clip (cosEnglish), exactly as scratchpad pack-check-analyze.py did for OmniVoice. Per-sentence cosDub too.
Intelligibility: Parakeet-TDT-0.6b-v3 int8 (the multilingual recognizer the mod already ships; no multilingual Whisper is installed here)
transcribes each rendered sentence; similarity = 1 - Levenshtein / max(len) on lower-cased text without punctuation. The same score is computed for
the OmniVoice pack-check renders (check/<pack>/check/renders/<key>.<a|b>.s<n>.wav) and for the dub clips against their manifest transcripts.
"""
import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

import numpy as np
import soundfile as sf

p = argparse.ArgumentParser()
for name in ("renders", "packs", "check", "ecapa-src", "ecapa-weights", "asr-libs", "asr-model", "scratch", "out"):
    p.add_argument("--" + name, type=Path, required=True)
a = p.parse_args()
PACK = {"french": "fr", "italian": "it", "german": "de", "spanish": "es-es", "portuguese": "pt-br"}
KEYS = ["panam-palmer", "judy-alvarez", "jackie-welles", "resident-female", "v-male"]

import torch
import torchaudio.functional as AF
from speechbrain.inference.speaker import EncoderClassifier
from speechbrain.utils.fetching import LocalStrategy

torch.set_num_threads(2)
model = EncoderClassifier.from_hparams(source=str(a.ecapa_src), savedir=str(a.scratch / "ecapa"), overrides={"pretrained_path": str(a.ecapa_weights)},
                                       local_strategy=LocalStrategy.COPY, run_opts={"device": "cpu"})


def read16(path):
    data, rate = sf.read(str(path), dtype="float32", always_2d=True)
    wav = torch.from_numpy(data.mean(axis=1))
    return AF.resample(wav, rate, 16000) if rate != 16000 else wav


def embed(path):
    wav = read16(path)
    if len(wav) < 1600:
        wav = torch.nn.functional.pad(wav, (0, 1600 - len(wav)))
    with torch.inference_mode():
        e = model.encode_batch(wav[None]).reshape(-1)
    return torch.nn.functional.normalize(e, dim=0)


def cos(x, y):
    return float((x * y).sum())


sys.path.insert(0, str(a.asr_libs))
import sherpa_onnx  # noqa: E402

m = str(a.asr_model)
asr = sherpa_onnx.OfflineRecognizer.from_transducer(encoder=m + "/encoder.int8.onnx", decoder=m + "/decoder.int8.onnx", joiner=m + "/joiner.int8.onnx",
                                                    tokens=m + "/tokens.txt", num_threads=2, decoding_method="greedy_search", model_type="nemo_transducer")


def transcribe(path):
    data, rate = sf.read(str(path), dtype="float32", always_2d=True)
    stream = asr.create_stream()
    stream.accept_waveform(rate, data.mean(axis=1))
    asr.decode_stream(stream)
    return stream.result.text.strip()


def norm(text):
    text = unicodedata.normalize("NFC", text.lower().replace("’", "'"))
    text = re.sub(r"[^\w\s']", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def lev(x, y):
    prev = list(range(len(y) + 1))
    for i, cx in enumerate(x, 1):
        cur = [i]
        for j, cy in enumerate(y, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (cx != cy)))
        prev = cur
    return prev[-1]


def similarity(reference, heard):
    r, h = norm(reference), norm(heard)
    return 1.0 - lev(r, h) / max(len(r), len(h), 1)


result = {"method": "see docstring", "languages": {}}
for lang, pack in PACK.items():
    data = json.loads((a.renders / lang / "records.json").read_text(encoding="utf-8"))
    omni = json.loads((a.check / pack / "check" / "results.json").read_text(encoding="utf-8"))
    manifest = json.loads((a.packs / pack / "manifest.json").read_text(encoding="utf-8-sig"))["voices"]
    sentences = omni["sentences"]
    rows = {}
    for key in KEYS:
        dub = a.packs / pack / manifest[key]["file"]
        english = a.check / pack / "check" / "ref" / f"{key}.en-ref.wav"
        e_dub, e_en = embed(dub), embed(english)
        row = {"dubVsEnglishRef": cos(e_dub, e_en), "dubAsrSimilarity": similarity(manifest[key]["text"], transcribe(dub))}
        for cond in ("a", "b"):
            joined = a.renders / lang / f"{key}.{cond}.wav"
            e = embed(joined)
            per, asr_rows = [], []
            for n, sentence in enumerate(sentences, 1):
                wav = a.renders / lang / f"{key}.{cond}.s{n}.wav"
                per.append(cos(embed(wav), e_dub))
                heard = transcribe(wav)
                asr_rows.append({"text": sentence, "heard": heard, "similarity": similarity(sentence, heard)})
            row[cond] = {"cosDub": cos(e, e_dub), "cosEnglish": cos(e, e_en), "perSentenceCosDub": per, "asr": asr_rows,
                         "asrMean": float(np.mean([r["similarity"] for r in asr_rows]))}
        # OmniVoice pack check, same characters and sentences, for comparison.
        om = omni["omni"][key]
        omni_asr = []
        for n, sentence in enumerate(sentences, 1):
            wav = a.check / pack / "check" / "renders" / f"{key}.a.s{n}.wav"
            heard = transcribe(wav)
            omni_asr.append({"heard": heard, "similarity": similarity(sentence, heard)})
        row["omnivoice"] = {"cosDub": om["a"]["cosDub"], "cosEnglishCond": om["b"]["cosDub"], "asr": omni_asr,
                            "asrMean": float(np.mean([r["similarity"] for r in omni_asr]))}
        rows[key] = row
        print(lang, key, f"a {row['a']['cosDub']:.3f} b {row['b']['cosDub']:.3f} omni {om['a']['cosDub']:.3f} | asr a {row['a']['asrMean']:.2f} "
              f"b {row['b']['asrMean']:.2f} omni {row['omnivoice']['asrMean']:.2f} dub {row['dubAsrSimilarity']:.2f}", flush=True)
    result["languages"][lang] = {"pack": pack, "sentences": sentences, "voices": rows, "summary": data["summary"],
                                 "timing": data["records"]}
a.out.write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
