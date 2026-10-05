"""Persistent OmniVoice renderer for the reference picker (one model load, many renders).

A separate process that never touches the running bridge, its model slot or its prompt cache.  It mirrors the
render() call and environment of bridge/resident-voice-worker.py (and scripts/Synthesize-OmniSamples.py): the pinned
k2-fsa/OmniVoice snapshot from runtime/local-voices.json in FP16 on CUDA, English, guidance_scale 2.0, speed 1,
denoise off, no post-processing, seed 1042; only the reference clip, its transcript, the text and the step count
come from the request.  The bridge's CUDA-graph replay (a speed optimisation) is not used.

Run with vendor/reference-voicestudio/.venv/Scripts/python.exe --cache <private prompt-cache dir>.
Protocol, one JSON object per line on stdin / stdout:
  -> {"op": "render", "id": 1, "ref": abs wav, "transcript": text, "text": text, "steps": 16|32, "out": abs wav}
  <- {"op": "ready", ...} once, then {"op": "done", "id": 1, "seconds": 3.2, "tookMs": 1800} or {"op": "error", ...}
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
PROTOCOL = sys.stdout          # library chatter on stdout goes to stderr instead, so the protocol stays clean
sys.stdout = sys.stderr


def say(value: dict) -> None:
    PROTOCOL.write(json.dumps(value) + "\n")
    PROTOCOL.flush()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()

    config = json.loads((ROOT / "runtime/local-voices.json").read_text(encoding="utf-8-sig"))
    model_dir = ROOT / config["model"]
    if not (model_dir / "model.safetensors").is_file() or config.get("engine") != "omnivoice":
        raise FileNotFoundError("The configured OmniVoice snapshot is missing")
    args.cache.mkdir(parents=True, exist_ok=True)
    os.environ.update({
        "HF_HOME": str(ROOT / "vendor/voice-models"), "HF_HUB_OFFLINE": "1",
        "OMNIVOICE_DATA_DIR": str(args.cache), "OMNIVOICE_MODEL": str(model_dir),
        "OMNIVOICE_TTS_BACKEND": "omnivoice", "OMNIVOICE_GPU_WORKERS": "1",
        "OMNIVOICE_PRELOAD_TTS_ASR": "0", "OMNIVOICE_ASR_BACKEND": "pytorch-whisper",
        "TORCH_COMPILE_DISABLE": "1", "PYTHONUTF8": "1"})
    for name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "KAGGLE_API_TOKEN"):
        os.environ.pop(name, None)
    sys.path.insert(0, str(ROOT / "vendor/reference-voicestudio/backend"))
    import numpy as np
    import soundfile as sf
    import torch
    from services import tts_backend

    if not torch.cuda.is_available():
        raise RuntimeError("OmniVoice needs CUDA")
    started = time.monotonic()
    backend = tts_backend.get_backend_class("omnivoice")()
    backend._ensure_loaded()
    say({"op": "ready", "loadedSeconds": round(time.monotonic() - started, 1), "device": backend.execution_device,
         "dtype": backend.dtype, "revision": config.get("revision")})
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        if request.get("op") == "exit":
            break
        try:
            steps = int(request["steps"])
            if steps not in (16, 32):
                raise ValueError("steps must be 16 or 32")
            reference = Path(request["ref"])
            if not reference.is_file():
                raise FileNotFoundError("reference clip is missing")
            torch.manual_seed(1042)
            began = time.perf_counter()
            with torch.inference_mode():
                wav = backend.generate(request["text"], ref_audio=str(reference), ref_text=request["transcript"],
                                       language="English", num_step=steps, guidance_scale=2.0, speed=1,
                                       denoise=False, postprocess_output=False)
            torch.cuda.synchronize()
            values = np.asarray(wav.detach().float().cpu() if hasattr(wav, "detach") else wav).reshape(-1)
            if not values.size or not np.isfinite(values).all():
                raise ValueError("OmniVoice produced empty or non-finite audio")
            out = Path(request["out"])
            out.parent.mkdir(parents=True, exist_ok=True)
            temporary = out.with_name(out.name + ".part")
            sf.write(str(temporary), values, backend.sample_rate, format="WAV", subtype="PCM_16")
            os.replace(temporary, out)
            say({"op": "done", "id": request.get("id"), "seconds": round(values.size / backend.sample_rate, 2),
                 "tookMs": round((time.perf_counter() - began) * 1000)})
        except Exception as error:  # one bad request must not end the worker
            say({"op": "error", "id": request.get("id"), "message": f"{type(error).__name__}: {error}"[:500]})
    backend.unload()
    return 0


if __name__ == "__main__":
    sys.exit(main())
