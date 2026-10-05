"""Synthesize listening-page lines with the bridge's OmniVoice route, varying only the steps.

This is a separate process that never touches the running bridge or its model
slot.  It mirrors the render() call and the environment of
bridge/resident-voice-worker.py (version-2 profile config in
runtime/local-voices.json): the pinned k2-fsa/OmniVoice snapshot in FP16 on
CUDA, the voice's own reference clip and verified transcript, English,
guidance_scale 2.0, speed 1, denoise off, no post-processing, seed 1042.  Only
num_step differs (16 and 32 are the two values the bridge allows).  The bridge's
CUDA-graph replay (a speed optimization) is not used.  Its prompt cache goes to a private
directory under the output folder.

Run with vendor/reference-voicestudio/.venv/Scripts/python.exe.
Job file: [{"key": voice, "reference": absolute wav, "transcript": text, "text": text to speak}, ...]
Writes <out>/omni<steps>/<key>.wav.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--steps", type=int, nargs="+", default=[16, 32])
    args = parser.parse_args()

    config = json.loads((ROOT / "runtime/local-voices.json").read_text(encoding="utf-8-sig"))
    model_dir = ROOT / config["model"]
    if not (model_dir / "model.safetensors").is_file() or config.get("engine") != "omnivoice":
        raise FileNotFoundError("The configured OmniVoice snapshot is missing")
    args.out.mkdir(parents=True, exist_ok=True)
    cache = args.out / "omni-prompt-cache"
    os.environ.update({
        "HF_HOME": str(ROOT / "vendor/voice-models"), "HF_HUB_OFFLINE": "1",
        "OMNIVOICE_DATA_DIR": str(cache), "OMNIVOICE_MODEL": str(model_dir),
        "OMNIVOICE_TTS_BACKEND": "omnivoice", "OMNIVOICE_GPU_WORKERS": "1",
        "OMNIVOICE_PRELOAD_TTS_ASR": "0", "OMNIVOICE_ASR_BACKEND": "pytorch-whisper",
        "TORCH_COMPILE_DISABLE": "1", "PYTHONUTF8": "1"})
    sys.path.insert(0, str(ROOT / "vendor/reference-voicestudio/backend"))
    import numpy as np
    import soundfile as sf
    import torch
    from services import tts_backend

    if not torch.cuda.is_available():
        raise RuntimeError("OmniVoice needs CUDA")
    jobs = json.loads(args.jobs.read_text(encoding="utf-8"))
    registry = config["voices"]
    for job in jobs:
        # The reference and transcript must be the bridge's own for this voice.
        entry = registry[job["key"]]
        reference = ROOT / entry["reference"]
        if Path(job["reference"]).resolve() != reference.resolve() or job["transcript"] != entry["transcript"]:
            raise ValueError(f"{job['key']}: job differs from the bridge's Omni profile")
        if hashlib.sha256(reference.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError(f"{job['key']}: reference clip changed")
    started = time.monotonic()
    backend = tts_backend.get_backend_class("omnivoice")()
    backend._ensure_loaded()
    print(json.dumps({"loaded_seconds": round(time.monotonic() - started, 1), "device": backend.execution_device,
                      "dtype": backend.dtype}), flush=True)
    for steps in args.steps:
        folder = args.out / f"omni{steps}"
        folder.mkdir(exist_ok=True)
        for job in jobs:
            path = folder / f"{job['key']}.wav"
            if path.is_file():
                continue
            torch.manual_seed(1042)
            began = time.perf_counter()
            with torch.inference_mode():
                wav = backend.generate(job["text"], ref_audio=job["reference"], ref_text=job["transcript"],
                                       language="English", num_step=steps, guidance_scale=2.0, speed=1,
                                       denoise=False, postprocess_output=False)
            torch.cuda.synchronize()
            values = np.asarray(wav.detach().float().cpu() if hasattr(wav, "detach") else wav).reshape(-1)
            if not values.size or not np.isfinite(values).all():
                raise ValueError("Omni produced empty or non-finite audio")
            sf.write(str(path), values, backend.sample_rate, format="WAV", subtype="PCM_16")
            print(json.dumps({"steps": steps, "voice": job["key"], "seconds": round(values.size / backend.sample_rate, 2),
                              "took": round(time.perf_counter() - began, 2)}), flush=True)
    backend.unload()
    return 0


if __name__ == "__main__":
    sys.exit(main())
