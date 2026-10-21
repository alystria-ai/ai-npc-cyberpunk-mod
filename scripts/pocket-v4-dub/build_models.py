"""Build the local Pocket v4 language models for the dub-reference evaluation.

The public (no-voice-cloning) weights have the 42 Mimi encoder tensors zeroed, and the real cloning weights are in the gated repo
kyutai/pocket-tts. As in the 2026-10-21 evaluation, the encoder tensors of the shipped English student are spliced in. Every other tensor is
Kyutai's own language model. The YAML is Kyutai's, with the weights and tokenizer pointed at local files.

usage: python -X utf8 -I build_models.py <hf-cache dir> <student model.safetensors> <out dir> [language ...]
<hf-cache dir> is the HF_HOME the weights were downloaded to (kyutai/pocket-tts-without-voice-cloning at a7056f50, per-language
model.safetensors + tokenizer.json). pocket-tts 4.0.0 must be importable (its config/*.yaml are read).
"""
import re
import sys
from pathlib import Path

import safetensors.torch as st

HF, STUDENT, OUT = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
LANGS = sys.argv[4:] or ["french", "italian", "german", "spanish", "portuguese"]
CONFIG = Path(__import__("pocket_tts").__file__).parent / "config"
REPO = HF / "hub" / "models--kyutai--pocket-tts-without-voice-cloning" / "snapshots"
ENC = ("mimi.encoder.", "mimi.encoder_transformer.")

student = st.load_file(str(STUDENT))
encoder = {k: v for k, v in student.items() if k.startswith(ENC)}
print("encoder tensors in the student:", len(encoder))


def find(lang, name):
    hits = sorted(REPO.glob(f"*/languages/{lang}/{name}"))
    assert hits, (lang, name)
    return hits[-1]


for lang in LANGS:
    weights = st.load_file(str(find(lang, "model.safetensors")))
    zero = [k for k, v in weights.items() if k.startswith(ENC) and float(v.abs().max()) == 0.0]
    for k in zero:
        assert weights[k].shape == encoder[k].shape, (lang, k)
        weights[k] = encoder[k].clone()
    out = OUT / lang
    out.mkdir(parents=True, exist_ok=True)
    st.save_file({k: v.contiguous() for k, v in weights.items()}, str(out / "model.safetensors"))
    text = (CONFIG / f"{lang}.yaml").read_text(encoding="utf-8")
    text = re.sub(r"^weights_path: .*$", "weights_path: " + (out / "model.safetensors").as_posix(), text, count=1, flags=re.M)
    text = re.sub(r"^weights_path_without_voice_cloning: .*$", "weights_path_without_voice_cloning: null", text, count=1, flags=re.M)
    text = re.sub(r"tokenizer_path: \S+", "tokenizer_path: " + find(lang, "tokenizer.json").as_posix(), text, count=1)
    (out / "inference.yaml").write_text(text, encoding="utf-8")
    print(lang, "spliced", len(zero), "tensors;", round(sum(v.numel() for v in weights.values()) / 1e6, 1), "M params;",
          (out / "model.safetensors").stat().st_size, "bytes")
