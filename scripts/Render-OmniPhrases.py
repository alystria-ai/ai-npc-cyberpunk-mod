"""Render the phrases of replies with the bridge's OmniVoice route and keep every phrase as its own WAV, with the time each one took.

For listening and timing checks of how a reply is cut and joined (bridge/speech-phrases.mjs, bridge/omni-join.mjs). The same call as
bridge/resident-voice-worker.py render(): the pinned k2-fsa/OmniVoice snapshot in FP16 on CUDA, the voice's own reference clip and verified transcript,
English, guidance_scale 2.0, speed 1, denoise off, no post-processing, seed 1042 for each phrase. The worker's CUDA-graph replay is not used (it is a
speed optimisation, times here are a little slower). It never touches the running bridge or its model slot.

Run with <checkout>/vendor/reference-voicestudio/.venv/Scripts/python.exe, from a checkout that has runtime/local-voices.json and vendor/ (the
development checkout; pass it as --root when this file is in a worktree).

Job file: [{"name": "01-before", "key": "judy-alvarez", "phrases": ["First phrase.", "Second phrase."]}, ...]
Writes <out>/<name>/p01.wav, p02.wav ... and <out>/timings.json: per job the phrase texts, the seconds of audio and the seconds each render took.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--steps", type=int, default=32, choices=[16, 32])
    parser.add_argument("--memory-gib", type=float, default=0.0, help="cap this process's CUDA memory (0: no cap)")
    args = parser.parse_args()
    root = args.root.resolve()

    config = json.loads((root / "runtime/local-voices.json").read_text(encoding="utf-8-sig"))
    model_dir = root / config["model"]
    if not (model_dir / "model.safetensors").is_file() or config.get("engine") != "omnivoice":
        raise FileNotFoundError("The configured OmniVoice snapshot is missing")
    args.out.mkdir(parents=True, exist_ok=True)
    os.environ.update({
        "HF_HOME": str(root / "vendor/voice-models"), "HF_HUB_OFFLINE": "1",
        "OMNIVOICE_DATA_DIR": str(args.out / "omni-prompt-cache"), "OMNIVOICE_MODEL": str(model_dir),
        "OMNIVOICE_TTS_BACKEND": "omnivoice", "OMNIVOICE_GPU_WORKERS": "1",
        "OMNIVOICE_PRELOAD_TTS_ASR": "0", "OMNIVOICE_ASR_BACKEND": "pytorch-whisper",
        "TORCH_COMPILE_DISABLE": "1", "PYTHONUTF8": "1"})
    sys.path.insert(0, str(root / "vendor/reference-voicestudio/backend"))
    import numpy as np
    import soundfile as sf
    import torch
    from services import tts_backend

    if not torch.cuda.is_available():
        raise RuntimeError("OmniVoice needs CUDA")
    if args.memory_gib > 0:
        total = torch.cuda.get_device_properties(0).total_memory
        torch.cuda.set_per_process_memory_fraction(min(1.0, args.memory_gib * 1024**3 / total))
    jobs = json.loads(args.jobs.read_text(encoding="utf-8"))
    registry = config["voices"]
    for job in jobs:
        entry = registry[job["key"]]
        if hashlib.sha256((root / entry["reference"]).read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError(f"{job['key']}: reference clip changed")
    started = time.monotonic()
    backend = tts_backend.get_backend_class("omnivoice")()
    backend._ensure_loaded()
    print(json.dumps({"loaded_seconds": round(time.monotonic() - started, 1), "device": backend.execution_device, "dtype": str(backend.dtype)}), flush=True)

    def render(key, text):
        entry = registry[key]
        torch.manual_seed(1042)
        began = time.perf_counter()
        with torch.inference_mode():
            wav = backend.generate(text, ref_audio=str(root / entry["reference"]), ref_text=entry["transcript"],
                                   language="English", num_step=args.steps, guidance_scale=2.0, speed=1,
                                   denoise=False, postprocess_output=False)
        torch.cuda.synchronize()
        values = np.asarray(wav.detach().float().cpu() if hasattr(wav, "detach") else wav).reshape(-1)
        if not values.size or not np.isfinite(values).all():
            raise ValueError("Omni produced empty or non-finite audio")
        return values, time.perf_counter() - began

    # The first render of a process pays for the prompt cache and kernel set-up: one throw-away render per voice, as the game's worker does at start.
    for key in dict.fromkeys(job["key"] for job in jobs):
        render(key, "Warming up the voice.")
    report = []
    for job in jobs:
        folder = args.out / job["name"]
        folder.mkdir(exist_ok=True)
        rows = []
        for index, text in enumerate(job["phrases"], 1):
            values, took = render(job["key"], text)
            sf.write(str(folder / f"p{index:02d}.wav"), values, backend.sample_rate, format="WAV", subtype="PCM_16")
            rows.append({"text": text, "seconds": round(values.size / backend.sample_rate, 3), "took": round(took, 3)})
            print(json.dumps({"job": job["name"], "phrase": index, **rows[-1]}), flush=True)
        report.append({"name": job["name"], "key": job["key"], "steps": args.steps, "phrases": rows})
    (args.out / "timings.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    backend.unload()
    return 0


if __name__ == "__main__":
    sys.exit(main())
