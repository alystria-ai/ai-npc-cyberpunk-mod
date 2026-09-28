"""Render an unchanged base and a trained adapter under matched conditions."""
from __future__ import annotations
import argparse
import gc
import hashlib
import json
import os
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("HF_HOME", str(ROOT / "vendor/voice-models"))
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import numpy as np
import soundfile as sf
import torch
from omnivoice.models.omnivoice import OmniVoice
from omnivoice.utils.lora import load_lora_adapter

BASE = ROOT / "vendor/voice-models/hub/models--k2-fsa--OmniVoice/snapshots/c5fdb5ccb189668d56333f77ba2629f4cd7535f4"
PHRASES = [
    ("conversation", "Hey V, slow down a second. We have been running all over Night City, and you still have not told me what is on your mind."),
    ("reassurance", "I know that went badly. You do not have to pretend you are fine around me. Let us find somewhere quiet and talk about it."),
    ("question", "Before we head to Watson, there is something I wanted to ask you. When this job is over, what do you actually want to do next?")
]


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def reference(key):
    selected = read_json(ROOT / "runtime/voice-references/selected-benchmark.json")
    wanted = next(r["stringId"] for r in selected["clips"] if r["key"] == key)
    manifest = read_json(ROOT / "runtime/voice-references/extracted/manifest.json")
    row = next(r for r in manifest["candidates"] if r["key"] == key and r["stringId"] == wanted)
    if hashlib.sha256(Path(row["wavPath"]).read_bytes()).hexdigest() != row["wav"]["sha256"]:
        raise ValueError("Changed voice reference")
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key", choices=("judy-alvarez", "johnny-silverhand", "panam-palmer"), required=True)
    parser.add_argument("--adapter", type=Path, required=True)
    parser.add_argument("--steps", type=int, default=32)
    parser.add_argument("--label", default="pilot-comparison")
    args = parser.parse_args()
    import re
    if not re.fullmatch(r"[a-z0-9-]{1,40}", args.label) or args.steps not in (16, 32, 48, 64):
        parser.error("Invalid label or synthesis step count")
    adapter = args.adapter.resolve()
    if not adapter.is_relative_to(ROOT / "runtime/voice-training") or not (adapter / "adapter_config.json").is_file():
        parser.error("An existing local pilot adapter is required")
    torch.set_num_threads(4)
    torch.set_num_interop_threads(2)
    output = ROOT / "runtime/voice-training" / args.key / args.label
    output.mkdir(parents=True, exist_ok=True)
    ref = reference(args.key)
    report = {"key": args.key, "baseModel": str(BASE), "adapter": str(adapter), "steps": args.steps,
        "reference": {"path": ref["wavPath"], "sha256": ref["wav"]["sha256"], "stringId": ref["stringId"]},
        "conditions": "Same reference, text and seed; speed 1; no output processing, denoising or EQ; offline upstream OmniVoice comparison",
        "listeningAccepted": False, "clips": []}
    for variant in ("base", "trained"):
        model = OmniVoice.from_pretrained(str(BASE), device_map="cuda", dtype=torch.float16,
                                          attn_implementation="sdpa", local_files_only=True)
        if variant == "trained":
            # Training excludes the codec. Its semantic encoder also has
            # q_proj/k_proj/v_proj names, so generic PEFT target matching would
            # otherwise attach untrained adapters there during inference.
            codec = model.audio_tokenizer
            model.audio_tokenizer = None
            try:
                import warnings
                with warnings.catch_warnings():
                    warnings.filterwarnings("error", message="Found missing adapter keys.*")
                    model = load_lora_adapter(model, str(adapter))
            finally:
                model.audio_tokenizer = codec
        model.eval()
        prompt = model.create_voice_clone_prompt(ref["wavPath"], ref_text=ref["transcript"], preprocess_prompt=True)
        prompt.save(str(output / f"{variant}-prompt.pt"))
        for index, (name, text) in enumerate(PHRASES):
            seed = 1042 + index
            torch.manual_seed(seed); np.random.seed(seed)
            started = time.monotonic()
            with torch.inference_mode():
                audio = model.generate(text=text, language="en", voice_clone_prompt=prompt,
                    num_step=args.steps, speed=1, denoise=False, postprocess_output=False)[0]
            torch.cuda.synchronize()
            elapsed = time.monotonic() - started
            if not np.isfinite(audio).all() or not np.any(audio):
                raise ValueError("Invalid generated waveform")
            path = output / f"{variant}-{name}.wav"
            sf.write(path, audio, model.sampling_rate, subtype="PCM_16")
            row = {"key": args.key, "variant": variant, "name": name, "text": text, "seed": seed,
                "path": str(path), "seconds": len(audio) / model.sampling_rate, "generationSeconds": elapsed,
                "sampleRate": model.sampling_rate, "peak": float(np.abs(audio).max()),
                "clippedFloatSamples": int(np.sum(np.abs(audio) >= 1)),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            report["clips"].append(row)
            (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
            print(json.dumps({k: row[k] for k in ("variant", "name", "seconds", "generationSeconds")}), flush=True)
        del model, prompt
        gc.collect(); torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
