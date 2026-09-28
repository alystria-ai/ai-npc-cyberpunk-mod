"""Render local listening samples through VoiceStudio's actual engine adapter.

Run with VoiceStudio's Python environment. This bypasses its HTTP application
startup (which preloads OmniVoice even when evaluating a different engine).
It does not enable the candidate in the game or change production settings.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "vendor/reference-voicestudio"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", choices=["voxcpm2"], default="voxcpm2")
    parser.add_argument("--keys", default="johnny-silverhand,judy-alvarez,panam-palmer")
    parser.add_argument("--steps", type=int, default=10)
    parser.add_argument("--label", default="first-review")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9-]{1,40}", args.label) or not 1 <= args.steps <= 64:
        parser.error("Invalid label or generation steps")
    keys = args.keys.split(",")
    selected = json.loads((ROOT / "runtime/voice-references/selected-benchmark.json").read_text("utf-8"))
    references = {clip["key"]: clip for clip in selected["clips"]}
    for key in keys:
        ref = references[key]
        if not ref["source"]["sha1Verified"] or not ref["transcript"].strip():
            raise ValueError(f"Unverified source for {key}")
        if hashlib.sha256(Path(ref["wavPath"]).read_bytes()).hexdigest() != ref["wav"]["sha256"]:
            raise ValueError(f"Changed source for {key}")

    model = json.loads((ROOT / "runtime/voxcpm2-model.json").read_text("utf-8"))
    output = ROOT / "runtime/voice-comparison" / f"{args.engine}-{args.steps}steps-{args.label}"
    output.mkdir(parents=True, exist_ok=True)
    if (output / "report.json").exists():
        raise FileExistsError("Use a new label to preserve the previous listening samples")

    os.environ.update({
        "HF_HOME": str(ROOT / "vendor/voice-models"),
        "OMNIVOICE_DATA_DIR": str(ROOT / "runtime/voice-studio-data"),
        "OMNIVOICE_GPU_WORKERS": "1",
        "OMNIVOICE_TTS_BACKEND": args.engine,
        "OMNIVOICE_VOXCPM2_DIR": str(ROOT / "vendor/voxcpm2-runtime"),
        "OMNIVOICE_VOXCPM_MODEL": model["directory"],
        # Avoid optional Triton/Inductor compilation on this Windows setup.
        # This affects execution speed; it does not add an audio effect.
        "TORCH_COMPILE_DISABLE": "1",
        "PYTHONUTF8": "1",
    })
    sys.path.insert(0, str(SOURCE / "backend"))
    import numpy as np
    import soundfile as sf
    from services.tts_backend import get_backend_class

    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    backend_class = get_backend_class(args.engine)
    ready, reason = backend_class.is_available()
    if not ready:
        raise RuntimeError(reason)
    backend = backend_class()
    revision = subprocess.check_output(["git", "-C", str(SOURCE), "rev-parse", "HEAD"], text=True).strip()
    text = "Hey V, slow down a second. We have been running all over Night City, and you still have not told me what is on your mind."
    report = {
        "engine": args.engine, "voiceStudioRevision": revision, "model": model,
        "adapter": backend_class.__name__, "steps": args.steps, "guidance": 2.0,
        "path": "Actual VoiceStudio engine adapter and its isolated subprocess; not the HTTP route",
        "processing": "No mastering, denoising, EQ, pitch, speed or volume changes. VoiceStudio's adapter trims reference edges and long output silence; native mono 48 kHz PCM16 encoding.",
        "seed": None, "seedNote": "VoiceStudio's VoxCPM2 adapter does not forward a fixed seed",
        "listeningAccepted": False, "clips": [],
    }

    def save() -> None:
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    save()
    try:
        for key in keys:
            ref = references[key]
            started = time.perf_counter()
            wav = backend.generate(text, ref_audio=ref["wavPath"], ref_text=ref["transcript"],
                                   language="English", num_step=args.steps, guidance_scale=2.0)
            elapsed = time.perf_counter() - started
            samples = wav.detach().float().cpu().numpy().reshape(-1)
            if not samples.size or not np.isfinite(samples).all():
                raise ValueError("The candidate produced invalid audio")
            path = output / f"{key}.wav"
            sf.write(path, samples, backend.sample_rate, subtype="PCM_16")
            row = {
                "key": key, "name": "conversation", "variant": args.engine, "text": text,
                "path": str(path), "seconds": samples.size / backend.sample_rate,
                "sampleRate": backend.sample_rate, "generationSeconds": elapsed,
                "includesColdLoad": not report["clips"],
                "peak": float(np.abs(samples).max()),
                "saturatedPcmSamples": int(np.count_nonzero(np.abs(samples) >= 32766 / 32768)),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "referenceSha256": ref["wav"]["sha256"], "referenceStringId": ref["stringId"],
            }
            report["clips"].append(row)
            save()
            print(json.dumps(row), flush=True)
        backend.health_check()
        report["residentModelMiB"] = getattr(backend, "_vram_mb", None)
        report["completed"] = True
        save()
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        save()
        raise
    finally:
        backend.unload()


if __name__ == "__main__":
    main()
