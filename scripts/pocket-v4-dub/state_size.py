"""Reference-encode time and prepared-state size for one pack clip with the French v4 model (4 threads), 3 runs.
usage: python -X utf8 -I state_size.py <models dir> <wav> <state out>"""
import os, sys, time
from pathlib import Path
for k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[k] = "4"
os.environ.update(CUDA_VISIBLE_DEVICES="-1", HF_HUB_OFFLINE="1", PYTHONDONTWRITEBYTECODE="1")
import soundfile as sf, torch
torch.set_num_threads(4); torch.set_num_interop_threads(1)
from pocket_tts import TTSModel, export_model_state
m = TTSModel.load_model(config=Path(sys.argv[1]) / "french" / "inference.yaml", temp=0.3, sampler_decode_steps=1, eos_threshold=-1.0, noise_clamp=None)
wav = Path(sys.argv[2])
print("clip seconds", sf.info(str(wav)).duration)
for i in range(3):
    t = time.perf_counter()
    with torch.no_grad():
        s = m.get_state_for_audio_prompt(wav, truncate=False)
    print("prep ms", round((time.perf_counter() - t) * 1000))
export_model_state(s, Path(sys.argv[3]))
print("state file bytes", Path(sys.argv[3]).stat().st_size)
