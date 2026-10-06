"""Persistent Pocket renderer for the clip search (CPU, research only; never touches the running bridge).

Mirrors bridge/pocket-voice-worker.py: TTSModel.load_model (temperature from the live config, one flow decode step,
eos threshold -1.0, no noise clamp, float32 on CPU), the reference prepared with
get_state_for_audio_prompt(path, truncate=False), and speech from generate_audio_stream(state, text,
frames_after_eos=1, copy_state=True).  The export (the "decoder") is a parameter: any directory holding
inference.yaml, model.safetensors and tokenizer.json (default: runtime/pocket-student-full-a-s5000-raw, the old decoder).
The only addition is torch.manual_seed(seed) before every render, so renders are reproducible and repeats differ.

Run with vendor/pocket-tts-env/Scripts/python.exe scripts/clip-search/pocket_worker.py --export <dir>
Protocol, one JSON object per line on stdin / stdout (library chatter is sent to stderr):
  -> {"op": "render", "id": 1, "ref": abs wav, "text": text, "seed": 1042, "out": abs wav}
  <- {"op": "ready", ...} once, then {"op": "done", "id": 1, "seconds": 3.2, "tookMs": 1800, "prepMs": 0} or {"op": "error", ...}
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
PROTOCOL = sys.stdout
sys.stdout = sys.stderr


def say(value: dict) -> None:
    PROTOCOL.write(json.dumps(value) + "\n")
    PROTOCOL.flush()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--export", type=Path, default=ROOT / "runtime/pocket-student-full-a-s5000-raw")
    parser.add_argument("--weights", type=Path, help="model weights to use instead of <export>/model.safetensors (e.g. the stock base)")
    parser.add_argument("--threads", type=int, default=3)
    parser.add_argument("--cache", type=int, default=6, help="prepared reference states kept in memory")
    args = parser.parse_args()

    os.environ.update(CUDA_VISIBLE_DEVICES="-1", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                      HF_HUB_DISABLE_TELEMETRY="1", TOKENIZERS_PARALLELISM="false", PYTHONDONTWRITEBYTECODE="1",
                      OMP_NUM_THREADS=str(args.threads), MKL_NUM_THREADS=str(args.threads),
                      OPENBLAS_NUM_THREADS=str(args.threads))
    for name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "KAGGLE_API_TOKEN"):
        os.environ.pop(name, None)
    sys.path.insert(0, str(ROOT / "vendor/pocket-tts-training/source"))
    from collections import OrderedDict
    import numpy as np
    import soundfile as sf
    import torch
    import yaml
    from pocket_tts import TTSModel
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)

    live = json.loads((ROOT / "runtime/pocket-voices.json").read_text(encoding="utf-8-sig"))
    temperature = live["sampling"]["temperature"]
    export = args.export
    inference = yaml.safe_load((export / "inference.yaml").read_text(encoding="utf-8-sig"))
    inference["weights_path"] = str(args.weights or export / "model.safetensors")
    inference["weights_path_without_voice_cloning"] = None
    inference["flow_lm"]["weights_path"] = None
    inference["mimi"]["weights_path"] = None
    inference["flow_lm"]["lookup_table"]["tokenizer_path"] = str(export / "tokenizer.json")
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="pocket-clip-search-") as temporary:
        relocated = Path(temporary) / "inference.yaml"
        relocated.write_text(yaml.safe_dump(inference, sort_keys=False), encoding="utf-8")
        model = TTSModel.load_model(config=relocated, temp=temperature, sampler_decode_steps=1,
                                    eos_threshold=-1.0, noise_clamp=None)
    if not model.has_voice_cloning or model.sample_rate != 24000:
        raise RuntimeError("Pocket export lacks the expected reference-conditioned audio")
    say({"op": "ready", "loadedSeconds": round(time.monotonic() - started, 1), "export": str(export),
         "temperature": temperature, "threads": args.threads})
    states: OrderedDict = OrderedDict()
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        if request.get("op") == "exit":
            break
        try:
            reference = str(request["ref"])
            began = time.perf_counter()
            if reference not in states:
                states[reference] = model.get_state_for_audio_prompt(reference, truncate=False)
                while len(states) > args.cache:
                    states.popitem(last=False)
            else:
                states.move_to_end(reference)
            prepared = time.perf_counter()
            torch.manual_seed(int(request.get("seed", 1042)))
            with torch.no_grad():
                parts = [chunk.detach().float().cpu().numpy().reshape(-1)
                         for chunk in model.generate_audio_stream(states[reference], request["text"],
                                                                  frames_after_eos=1, copy_state=True)]
            values = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
            if not values.size or not np.isfinite(values).all():
                raise ValueError("Pocket produced empty or non-finite audio")
            out = Path(request["out"])
            out.parent.mkdir(parents=True, exist_ok=True)
            temporary_out = out.with_name(out.name + ".part")
            sf.write(str(temporary_out), np.clip(values, -1, 1), 24000, format="WAV", subtype="PCM_16")
            os.replace(temporary_out, out)
            say({"op": "done", "id": request.get("id"), "seconds": round(values.size / 24000, 2),
                 "tookMs": round((time.perf_counter() - began) * 1000), "prepMs": round((prepared - began) * 1000)})
        except Exception as error:
            say({"op": "error", "id": request.get("id"), "message": f"{type(error).__name__}: {error}"[:500]})
    return 0


if __name__ == "__main__":
    sys.exit(main())
