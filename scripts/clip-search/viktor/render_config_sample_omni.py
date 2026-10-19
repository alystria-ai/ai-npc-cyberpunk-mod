"""Render one sample line per OmniVoice reference set of a voice FROM THE LIVE CONFIGS, offline (no game, no bridge, no resident worker, GPU).

Mirrors scripts/clip-search/lucy/render_sample_omni.py: the pinned k2-fsa/OmniVoice snapshot named in the config, the voice's entry from
runtime/local-voices.autobest-long.json (Ultra / Quality: 32 steps) and -short.json (Balanced: 16 steps), the reference hash checked, guidance_scale 2.0,
speed 1, denoise off, no post-processing, seed 1042.  It proves the live entry (WAV + words + hash) works end to end.

  python render_config_sample_omni.py <voice key> <out dir> "<text>"      (CLIP_SEARCH_ROOT = the main checkout)
Writes <out dir>/omni-long-32.wav and omni-short-16.wav.  Run with vendor/reference-voicestudio/.venv/Scripts/python.exe.
"""
import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(os.environ["CLIP_SEARCH_ROOT"])
key, out_dir, text = sys.argv[1], Path(sys.argv[2]), sys.argv[3]
out_dir.mkdir(parents=True, exist_ok=True)
sets = {"long": ("local-voices.autobest-long.json", 32), "short": ("local-voices.autobest-short.json", 16)}
loaded = {}
for kind, (file, steps) in sets.items():
    voices = json.loads((ROOT / "runtime" / file).read_text(encoding="utf-8-sig"))
    entry = voices["voices"][key]
    ref = ROOT / entry["reference"]
    if hashlib.sha256(ref.read_bytes()).hexdigest() != entry["sha256"]:
        raise ValueError(f"{kind}: reference clip changed")
    loaded[kind] = (voices, entry, ref, steps)
model_dir = ROOT / loaded["long"][0]["model"]
if not (model_dir / "model.safetensors").is_file() or loaded["long"][0].get("engine") != "omnivoice":
    raise FileNotFoundError("The configured OmniVoice snapshot is missing")
cache = tempfile.mkdtemp(prefix="viktor-omni-sample-")
os.environ.update({"HF_HOME": str(ROOT / "vendor/voice-models"), "HF_HUB_OFFLINE": "1", "OMNIVOICE_DATA_DIR": cache,
    "OMNIVOICE_MODEL": str(model_dir), "OMNIVOICE_TTS_BACKEND": "omnivoice", "OMNIVOICE_GPU_WORKERS": "1", "OMNIVOICE_PRELOAD_TTS_ASR": "0",
    "OMNIVOICE_ASR_BACKEND": "pytorch-whisper", "TORCH_COMPILE_DISABLE": "1", "PYTHONUTF8": "1"})
sys.path.insert(0, str(ROOT / "vendor/reference-voicestudio/backend"))
import numpy as np, soundfile as sf, torch
from services import tts_backend
free, total = torch.cuda.mem_get_info()
print(json.dumps({"gpu_free_mib": free // 2**20}), flush=True)
if free < 4.5 * 2**30:
    raise RuntimeError("The GPU is busy (under 4.5 GB free); not rendering")
backend = tts_backend.get_backend_class("omnivoice")()
backend._ensure_loaded()
try:
    for kind, (voices, entry, ref, steps) in loaded.items():
        began = time.monotonic()
        torch.manual_seed(1042)
        with torch.inference_mode():
            wav = backend.generate(text, ref_audio=str(ref), ref_text=entry["transcript"], language="English", num_step=steps,
                                   guidance_scale=2.0, speed=1, denoise=False, postprocess_output=False)
        torch.cuda.synchronize()
        values = np.asarray(wav.detach().float().cpu() if hasattr(wav, "detach") else wav).reshape(-1)
        assert values.size and np.isfinite(values).all()
        out = out_dir / f"omni-{kind}-{steps}.wav"
        sf.write(str(out), values, backend.sample_rate, format="WAV", subtype="PCM_16")
        print(json.dumps({"wrote": str(out), "seconds": round(values.size / backend.sample_rate, 2), "wall_s": round(time.monotonic() - began, 1)}), flush=True)
finally:
    backend.unload()
