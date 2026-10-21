"""Does a respelling make the v4 language models say "Night City" the English way? Renders the pack-check sentence 2 (cloned from the dub clip) with
"Night City" respelled, one language per call, then transcribes it with Parakeet and reports whether "night city" (or the respelling) was heard.

usage: python -X utf8 -I night_city.py <lang> <pack> <respelling> <models dir> <packs dir> <check dir> <asr libs> <asr model> <out json>
"""
import json
import os
import sys
from pathlib import Path

lang, pack, respell = sys.argv[1:4]
models, packs, check, asr_libs, asr_model, out = (Path(x) for x in sys.argv[4:10])
for k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[k] = "4"
os.environ.update(CUDA_VISIBLE_DEVICES="-1", HF_HUB_OFFLINE="1", PYTHONDONTWRITEBYTECODE="1")
import soundfile as sf
import torch

torch.set_num_threads(4)
torch.set_num_interop_threads(1)
sys.path.insert(0, str(asr_libs))
import numpy as np
import sherpa_onnx
from pocket_tts import TTSModel

sentence = json.loads((check / pack / "check" / "results.json").read_text(encoding="utf-8"))["sentences"][1]
manifest = json.loads((packs / pack / "manifest.json").read_text(encoding="utf-8-sig"))["voices"]
model = TTSModel.load_model(config=models / lang / "inference.yaml", temp=0.3, sampler_decode_steps=1, eos_threshold=-1.0, noise_clamp=None)
m = str(asr_model)
asr = sherpa_onnx.OfflineRecognizer.from_transducer(encoder=m + "/encoder.int8.onnx", decoder=m + "/decoder.int8.onnx", joiner=m + "/joiner.int8.onnx",
                                                    tokens=m + "/tokens.txt", num_threads=2, decoding_method="greedy_search", model_type="nemo_transducer")
text = sentence.replace("Night City", respell)
rows = []
for key in ["panam-palmer", "judy-alvarez", "jackie-welles", "resident-female", "v-male"]:
    with torch.no_grad():
        state = model.get_state_for_audio_prompt(packs / pack / manifest[key]["file"], truncate=False)
        torch.manual_seed(1002)
        pcm = np.concatenate([c.numpy().reshape(-1) for c in model.generate_audio_stream(state, text, frames_after_eos=1, copy_state=True)])
    stream = asr.create_stream()
    stream.accept_waveform(24000, pcm.astype("float32"))
    asr.decode_stream(stream)
    heard = stream.result.text.strip()
    low = heard.lower()
    rows.append({"key": key, "heard": heard, "saysName": any(w in low for w in ("night city", respell.lower()))})
    print(lang, key, rows[-1], flush=True)
out.write_text(json.dumps({"lang": lang, "text": text, "rows": rows}, indent=1, ensure_ascii=False), encoding="utf-8")
