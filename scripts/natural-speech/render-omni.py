"""Render the natural-speech test lines with the bridge's OmniVoice call (research only; never touches the live bridge).

Same call as bridge/resident-voice-worker.py render(): FP16 CUDA, English, guidance 2.0, speed 1, denoise off,
no post-processing, seed 1042, no CUDA graph.  References are the proposed 18 s three-clip set in
runtime/local-voices.multiref.json.  Writes <out>/omni<steps>/<char>__<line>__<variant>.wav and
<out>/omni<steps>/probe/<char>__<tag>.wav for the tag probe.

Run with vendor/reference-voicestudio/.venv/Scripts/python.exe scripts/natural-speech/render-omni.py --out E:/...
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--steps", type=int, nargs="+", default=[16, 32])
    parser.add_argument("--no-probe", action="store_true")
    parser.add_argument("--filler-probe", action="store_true", help="only the isolated-filler probe, into omni<steps>/fprobe/")
    parser.add_argument("--noise", action="store_true", help="v1 and v2 again with seeds 1043 and 1044, omni16/noise/")
    parser.add_argument("--chunked", action="store_true",
                        help="render each line as the bridge does: phrase by phrase (bridge/speech-stream.mjs), "
                             "seed 1042 per phrase, joined with no gap, into omni<steps>c/")
    args = parser.parse_args()

    live = json.loads((ROOT / "runtime/local-voices.json").read_text(encoding="utf-8-sig"))
    config = json.loads((ROOT / "runtime/local-voices.multiref.json").read_text(encoding="utf-8-sig"))
    model_dir = ROOT / live["model"]
    args.out.mkdir(parents=True, exist_ok=True)
    os.environ.update({
        "HF_HOME": str(ROOT / "vendor/voice-models"), "HF_HUB_OFFLINE": "1",
        "OMNIVOICE_DATA_DIR": str(args.out / "omni-prompt-cache"), "OMNIVOICE_MODEL": str(model_dir),
        "OMNIVOICE_TTS_BACKEND": "omnivoice", "OMNIVOICE_GPU_WORKERS": "1",
        "OMNIVOICE_PRELOAD_TTS_ASR": "0", "OMNIVOICE_ASR_BACKEND": "pytorch-whisper",
        "TORCH_COMPILE_DISABLE": "1", "PYTHONUTF8": "1"})
    sys.path.insert(0, str(ROOT / "vendor/reference-voicestudio/backend"))
    import numpy as np
    import soundfile as sf
    import torch
    from services import tts_backend

    lines = json.loads((HERE / "lines.json").read_text(encoding="utf-8"))
    jobs = []  # (relative path, key, text)
    for key, character in lines["characters"].items():
        for line_id, line in character["lines"].items():
            for variant, text in line["v"].items():
                if variant == "v5_pocket":
                    continue
                jobs.append((f"{key}__{line_id}__{variant}.wav", key, text))
    phrases = json.loads((HERE / "phrases.json").read_text(encoding="utf-8")) if args.chunked else None
    if not args.no_probe and not args.chunked:
        probe = lines["tag_probe"]
        for key in probe["characters"]:
            for tag in probe["tags"]:
                jobs.append((f"probe/{key}__{tag.strip('[]')}.wav", key, probe["carrier"].format(tag=tag)))

    if args.filler_probe:
        fp = lines["filler_probe"]
        jobs = [(f"fprobe/{key}__{slug}.wav", key, text) for key in fp["characters"] for slug, text in fp["texts"].items()]
    if args.noise:
        jobs = [(f"noise/{name[:-4]}__s{seed}.wav", key, text) for name, key, text in jobs
                if name.endswith(("__v1.wav", "__v2.wav")) for seed in (1043, 1044)]
        args.steps = [16]
    started = time.monotonic()
    backend = tts_backend.get_backend_class("omnivoice")()
    backend._ensure_loaded()
    print(json.dumps({"loaded_seconds": round(time.monotonic() - started, 1), "device": backend.execution_device,
                      "dtype": backend.dtype}), flush=True)
    def render(text, key, steps, seed=1042):
        entry = config["voices"][key]
        torch.manual_seed(seed)
        with torch.inference_mode():
            wav = backend.generate(text, ref_audio=str(ROOT / entry["reference"]), ref_text=entry["transcript"],
                                   language="English", num_step=steps, guidance_scale=2.0, speed=1,
                                   denoise=False, postprocess_output=False)
        torch.cuda.synchronize()
        return np.asarray(wav.detach().float().cpu() if hasattr(wav, "detach") else wav).reshape(-1)

    for steps in args.steps:
        for name, key, text in jobs:
            path = args.out / f"omni{steps}{'c' if args.chunked else ''}" / name
            if path.is_file():
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            began = time.perf_counter()
            if args.chunked:
                values = np.concatenate([render(phrase, key, steps) for phrase in phrases[Path(name).stem]])
            else:
                values = render(text, key, steps, int(path.stem.rsplit("__s", 1)[1]) if args.noise else 1042)
            if not values.size or not np.isfinite(values).all():
                raise ValueError("Omni produced empty or non-finite audio")
            sf.write(str(path), values, backend.sample_rate, format="WAV", subtype="PCM_16")
            print(json.dumps({"steps": steps, "file": name, "seconds": round(values.size / backend.sample_rate, 2),
                              "took": round(time.perf_counter() - began, 2)}), flush=True)
    backend.unload()
    return 0


if __name__ == "__main__":
    sys.exit(main())
