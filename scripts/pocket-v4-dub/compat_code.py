"""Does the shipped worker's pinned pocket-tts source (3.3.0) run a v4 language model? Renders one fixed line with a fixed seed.
usage: python -X utf8 -I compat_code.py <models dir> <lang> <wav> <out wav> [<pocket-tts source dir to put first on sys.path>]
Run once with the 4.0.0 package (no 5th argument) and once with the pinned 3.3.0 source; compare the two WAVs."""
import os, sys
from pathlib import Path
for k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[k] = "4"
os.environ.update(CUDA_VISIBLE_DEVICES="-1", HF_HUB_OFFLINE="1", PYTHONDONTWRITEBYTECODE="1")
if len(sys.argv) > 5:
    sys.path.insert(0, sys.argv[5])
import numpy as np, soundfile as sf, torch
torch.set_num_threads(4); torch.set_num_interop_threads(1)
import pocket_tts
from pocket_tts import TTSModel
print("code", Path(pocket_tts.__file__).parent, getattr(pocket_tts, "__version__", ""))
m = TTSModel.load_model(config=Path(sys.argv[1]) / sys.argv[2] / "inference.yaml", temp=0.3, sampler_decode_steps=1, eos_threshold=-1.0, noise_clamp=None)
with torch.no_grad():
    state = m.get_state_for_audio_prompt(Path(sys.argv[3]), truncate=False)
    torch.manual_seed(1234)
    pcm = np.concatenate([c.numpy().reshape(-1) for c in m.generate_audio_stream(state, "Night City est calme ce soir, allons boire un verre.", frames_after_eos=1, copy_state=True)])
sf.write(sys.argv[4], pcm, 24000, subtype="FLOAT")
print("audio s", len(pcm) / 24000)
