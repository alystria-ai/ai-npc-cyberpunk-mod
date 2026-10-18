"""Render one sample line in Lucy Kushinada's OmniVoice voice, offline (no game, no bridge, no resident worker).

Mirrors render() in scripts/Render-TagListening.py: the pinned k2-fsa/OmniVoice snapshot from the live config, her live omni-long reference from
runtime/local-voices.autobest-long.json (hash checked), guidance_scale 2.0, speed 1, denoise off, no post-processing, seed 1042, the config's step count.
Run with vendor/reference-voicestudio/.venv/Scripts/python.exe:  python render_sample_omni.py <out.wav> "<text>" [long|short]
"""
import hashlib, json, os, sys, tempfile, time
from pathlib import Path
sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod")
out, text = Path(sys.argv[1]), sys.argv[2]
kind = sys.argv[3] if len(sys.argv) > 3 else "long"
KEY = "lucy-kushinada"
config = json.loads((ROOT / "runtime/voice-configs.json").read_text(encoding="utf-8-sig"))
voices = json.loads((ROOT / "runtime" / config["omni"][kind]).read_text(encoding="utf-8-sig"))
model_dir = ROOT / voices["model"]
if not (model_dir / "model.safetensors").is_file() or voices.get("engine") != "omnivoice":
    raise FileNotFoundError("The configured OmniVoice snapshot is missing")
entry = voices["voices"][KEY]
ref = ROOT / entry["reference"]
if hashlib.sha256(ref.read_bytes()).hexdigest() != entry["sha256"]:
    raise ValueError("reference clip changed")
steps = voices.get("steps", 16)
cache = tempfile.mkdtemp(prefix="lucy-omni-sample-")
os.environ.update({"HF_HOME": str(ROOT / "vendor/voice-models"), "HF_HUB_OFFLINE": "1", "OMNIVOICE_DATA_DIR": cache,
    "OMNIVOICE_MODEL": str(model_dir), "OMNIVOICE_TTS_BACKEND": "omnivoice", "OMNIVOICE_GPU_WORKERS": "1", "OMNIVOICE_PRELOAD_TTS_ASR": "0",
    "OMNIVOICE_ASR_BACKEND": "pytorch-whisper", "TORCH_COMPILE_DISABLE": "1", "PYTHONUTF8": "1"})
sys.path.insert(0, str(ROOT / "vendor/reference-voicestudio/backend"))
import numpy as np, soundfile as sf, torch
from services import tts_backend
if not torch.cuda.is_available():
    raise RuntimeError("OmniVoice needs CUDA")
free, total = torch.cuda.mem_get_info()
print(json.dumps({"gpu_free_mib": free // 2**20, "gpu_total_mib": total // 2**20, "steps": steps, "reference": kind}), flush=True)
if free < 4.5 * 2**30:
    raise RuntimeError("The GPU is busy (under 4.5 GB free); not rendering")
t0 = time.monotonic()
backend = tts_backend.get_backend_class("omnivoice")()
backend._ensure_loaded()
print(json.dumps({"loaded_seconds": round(time.monotonic() - t0, 1), "device": backend.execution_device, "dtype": str(backend.dtype)}), flush=True)
torch.manual_seed(1042)
with torch.inference_mode():
    wav = backend.generate(text, ref_audio=str(ref), ref_text=entry["transcript"], language="English", num_step=steps,
                           guidance_scale=2.0, speed=1, denoise=False, postprocess_output=False)
torch.cuda.synchronize()
values = np.asarray(wav.detach().float().cpu() if hasattr(wav, "detach") else wav).reshape(-1)
assert values.size and np.isfinite(values).all()
sf.write(str(out), values, backend.sample_rate, format="WAV", subtype="PCM_16")
print(json.dumps({"wrote": str(out), "seconds": round(values.size / backend.sample_rate, 2), "peak": round(float(np.abs(values).max()), 3)}))
backend.unload()
