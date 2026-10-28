"""Render the natural-speech test lines with Pocket student 5,000 + the fine-tuned Mimi decoder (CPU, research only).

Mirrors bridge/pocket-voice-worker.py: TTSModel.load_model (temp from runtime/pocket-voices.multiref.json, one flow
decode step, eos threshold -1.0, no noise clamp, float32 on CPU), the reference prepared with
get_state_for_audio_prompt(path, truncate=False) and speech from generate_audio_stream(state, text,
frames_after_eos=1, copy_state=True).  The export is the decoder-A one (no receipt, so the bridge's hash gate is not
used; the model file is loaded directly).  Also records the chunks upstream splits each text into.

Run with vendor/pocket-tts-env/Scripts/python.exe scripts/natural-speech/render-pocket.py --out E:/...
Writes <out>/pocket/<char>__<line>__<variant>.wav and pocket/chunks.json.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
EXPORT = Path(r"E:\CyberpunkConvai-offload\work\mimi-dec\exports\s5000-raw-decA")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--filler-probe", action="store_true", help="only the isolated-filler probe, into pocket/fprobe/")
    parser.add_argument("--noise", action="store_true",
                        help="re-render v1 and v2 of every line with two more random seeds, into pocket/noise/ "
                             "(the main renders are unseeded, as the bridge is, so this is the run-to-run spread)")
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()

    os.environ.update(CUDA_VISIBLE_DEVICES="-1", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                      HF_HUB_DISABLE_TELEMETRY="1", TOKENIZERS_PARALLELISM="false",
                      OMP_NUM_THREADS=str(args.threads), MKL_NUM_THREADS=str(args.threads))
    for name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
        os.environ.pop(name, None)
    sys.path.insert(0, str(ROOT / "vendor/pocket-tts-training/source"))
    import numpy as np
    import soundfile as sf
    import torch
    import yaml
    from pocket_tts import TTSModel
    from pocket_tts.models.text_chunking import split_into_best_sentences
    torch.set_num_threads(args.threads)

    pocket_config = json.loads((ROOT / "runtime/pocket-voices.multiref.json").read_text(encoding="utf-8-sig"))
    temperature = pocket_config["sampling"]["temperature"]
    inference = yaml.safe_load((EXPORT / "inference.yaml").read_text(encoding="utf-8-sig"))
    inference["weights_path"] = str(EXPORT / "model.safetensors")
    inference["weights_path_without_voice_cloning"] = None
    inference["flow_lm"]["weights_path"] = None
    inference["mimi"]["weights_path"] = None
    inference["flow_lm"]["lookup_table"]["tokenizer_path"] = str(EXPORT / "tokenizer.json")

    lines = json.loads((HERE / "lines.json").read_text(encoding="utf-8"))
    jobs = []
    for key, character in lines["characters"].items():
        for line_id, line in character["lines"].items():
            for variant, text in line["v"].items():
                if variant == "v5":
                    continue
                name = variant.replace("_pocket", "")
                jobs.append((f"{key}__{line_id}__{name}.wav", key, text))
    if args.filler_probe:
        fp = lines["filler_probe"]
        jobs = [(f"fprobe/{key}__{slug}.wav", key, text) for key in fp["characters"] for slug, text in fp["texts"].items()]
    if args.noise:
        jobs = [(f"noise/{name[:-4]}__s{seed}.wav", key, text) for name, key, text in jobs
                if name.endswith(("__v1.wav", "__v2.wav")) for seed in (2, 3)]
    out = args.out / "pocket"
    out.mkdir(parents=True, exist_ok=True)

    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="pocket-natural-") as temporary:
        relocated = Path(temporary) / "inference.yaml"
        relocated.write_text(yaml.safe_dump(inference, sort_keys=False), encoding="utf-8")
        model = TTSModel.load_model(config=relocated, temp=temperature, sampler_decode_steps=1,
                                    eos_threshold=-1.0, noise_clamp=None)
    print(json.dumps({"loaded_seconds": round(time.monotonic() - started, 1), "temperature": temperature,
                      "replace_characters": getattr(model, "replace_characters", None)}), flush=True)
    states = {}
    chunks_log = {}
    for name, key, text in jobs:
        path = out / name
        if key not in states:
            began = time.perf_counter()
            reference = json.loads((ROOT / "runtime/pocket-voices.multiref.json").read_text(encoding="utf-8-sig"))
            states[key] = model.get_state_for_audio_prompt(str(ROOT / reference["voices"][key]["reference"]), truncate=False)
            print(json.dumps({"prepared": key, "took": round(time.perf_counter() - began, 2)}), flush=True)
        chunks_log[name] = split_into_best_sentences(
            model.flow_lm.conditioner.tokenizer, text, 50, model.pad_with_spaces_for_short_inputs,
            remove_semicolons=model.remove_semicolons, append_terminal_punctuation=model.append_terminal_punctuation,
            capitalize_first_letter=model.capitalize_first_letter, replace_characters=model.replace_characters)
        if path.is_file():
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        began = time.perf_counter()
        if args.noise:
            torch.manual_seed(int(path.stem.rsplit("__s", 1)[1]))
        parts = [chunk.detach().float().cpu().numpy().reshape(-1)
                 for chunk in model.generate_audio_stream(states[key], text, frames_after_eos=1, copy_state=True)]
        values = np.concatenate(parts)
        if not values.size or not np.isfinite(values).all():
            raise ValueError("Pocket produced empty or non-finite audio")
        sf.write(str(path), np.clip(values, -1, 1), 24000, format="WAV", subtype="PCM_16")
        print(json.dumps({"file": name, "seconds": round(values.size / 24000, 2),
                          "took": round(time.perf_counter() - began, 2)}), flush=True)
    if not args.noise:
        (out / ("fprobe-chunks.json" if args.filler_probe else "chunks.json")).write_text(json.dumps(chunks_log, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
