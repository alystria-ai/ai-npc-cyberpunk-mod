# OmniVoice on an AMD graphics card (experimental, untested)

Added 2026-10-25 after a player request: an RX 9070 XT owner runs OmniVoice on its own with AMD's ROCm build of PyTorch, but the mod never tried their card.

**Untested on real AMD hardware.** We have no AMD card. Everything below is built from AMD's install guide and tested with stand-ins only. If you try it, please tell us how it went (Nexus posts or Discord) and attach a report: Settings > Help > Help and support > **Generate report**. The report now says which backend your Python found (CUDA, ROCm or none) and why it was refused, if it was.

## For players

### Why OmniVoice does not start on an AMD card

The OmniVoice pack brings its own Python with a CUDA build of PyTorch (torch 2.8.0+cu128). A CUDA build can only see NVIDIA cards. On an AMD card it finds no graphics card, the voice worker stops with "needs CUDA", and the mod does not try OmniVoice again until the game restarts. Your companions then speak with Pocket, or their replies show as text. Never with a cloud voice.

The mod cannot simply ship AMD's PyTorch: it is several gigabytes, it has to match your card, and we cannot test it. Instead you can point the mod at **your own Python** that already has AMD's PyTorch in it.

### What you need

- An AMD Radeon card that AMD's ROCm for Windows supports. AMD lists the RX 9070 XT (gfx1201) among the supported cards. Check AMD's page: https://rocm.docs.amd.com/projects/ai-ecosystem/en/latest/frameworks/pytorch/install.html
- A current AMD graphics driver (AMD's compatibility list on that page names the version).
- Python 3.12 from python.org (AMD's guide allows 3.11 to 3.14, but some libraries OmniVoice uses may have no ready-made files for 3.13 or 3.14 yet. 3.12 is the safe pick).
- The mod's **OmniVoice pack**, installed as usual. The voice model and OmniVoice's own code still come from it. Only PyTorch and the plain libraries come from your Python.
- About 12 GB of video memory or more, the same as on NVIDIA (OmniVoice runs next to the game). An RX 9070 XT has 16 GB.

### Steps

1. **Make a Python environment.** Open a terminal in a folder of your choice (for example `C:\omni-rocm`) and run:

   ```
   py -3.12 -m venv .venv
   .venv\Scripts\activate
   ```

2. **Install AMD's PyTorch** with AMD's own command for your card. For the RX 9070 XT (gfx1201) AMD's guide gives (PyTorch 2.14.0 with ROCm 10.1.0, as of 25 Oct 2026, check the page for newer versions):

   ```
   python -m pip install --index-url https://stable.repo.amd.com/rocm/whl-next/ "torch[device-gfx1201]==2.14.0+rocm10.1.0" "torchvision[device-gfx1201]==0.29.0a0+rocm10.1.0" "torchaudio==2.11.0.3+rocm10.1.0"
   ```

   For another card, use the `device-all` line on AMD's page instead. Check it works:

   ```
   python -c "import torch; print(torch.cuda.is_available(), torch.version.hip)"
   ```

   It should print `True` and a ROCm version. (ROCm builds answer through the same `torch.cuda` functions, which is why this works with OmniVoice's code at all.)

3. **Install OmniVoice's libraries without touching PyTorch.** Save the list at the end of this page as `omni-requirements.txt` and run, in the same activated terminal:

   ```
   python -m pip install --no-deps -r omni-requirements.txt
   ```

   `--no-deps` matters: it installs exactly these versions and never replaces AMD's PyTorch with another one. You do **not** need to install OmniVoice itself: the mod uses the copy in its pack.

4. **Tell the mod where your Python is.** Create a text file named `omni-python.txt` in the mod's data folder:

   ```
   %LOCALAPPDATA%\AiNpcCyberpunkMod\data\omni-python.txt
   ```

   (paste `%LOCALAPPDATA%\AiNpcCyberpunkMod\data` into the Explorer address bar to open the folder). Put the full path of your python.exe on one line, for example:

   ```
   C:\omni-rocm\.venv\Scripts\python.exe
   ```

   Lines starting with `#` are ignored. To undo everything, delete the file.

5. **Restart the game**, choose an OmniVoice entry in Settings > Voices, and open Settings > Help. The setup check has an **OmniVoice Python** row.

### What to expect

- The mod tests your Python first, in the background: it imports PyTorch, reads the card's name and video memory, runs one tiny sum on the card and loads OmniVoice's code with your libraries. This can take up to a minute the first time. Only a Python that passes is used.
- The Help row then says, for example, "Your own Python (omni-python.txt) runs OmniVoice with ROCm on AMD Radeon RX 9070 XT, 15.9 GB. Experimental." If the test failed, it says why: no PyTorch, no graphics card found, the test on the card failed, a missing module (with its name), and so on. In that case nothing changes from today: OmniVoice falls back the same way as before (Pocket or text, never a cloud voice).
- The first OmniVoice start takes two to three minutes, as on NVIDIA. If it works, it may be slower than on a comparable NVIDIA card: a speed-up the mod uses on NVIDIA (CUDA graph replay) is turned off on ROCm, because it is untested there.
- If it gets to the voice and then fails (for example an error deep in PyTorch), the voice falls back as above and the reason is in the report.

### What is untested

All of it, on real AMD hardware. In particular: whether every part of OmniVoice runs on ROCm for Windows (it uses half-precision weights and PyTorch's attention functions), how fast it is, and how it shares video memory with the game. Please report back, it helps every AMD player.

## For developers

### What blocked AMD (root cause)

1. **The bundled PyTorch is a CUDA wheel.** `app/omni/python` ships `torch-2.8.0+cu128` (`packaging/python/omni.in`, `omni.lock.txt`). It cannot see a Radeon.
2. **The worker's CUDA gate then ends OmniVoice for the session.** `bridge/resident-voice-worker.py` exits with `NO_CUDA_EXIT_CODE` (78) when `torch.cuda.is_available()` is false. `bridge/resident-voice.mjs` turns that into `NO_CUDA_FAILURE`, and `VoiceSelection.scheduleOmniRetry` sets `omniNoCuda` (never retried, fallback reason `omni-no-nvidia`).
3. **The menu hint.** `gpu-vendors.mjs lacksNvidia` makes `omniNoNvidia` true for an AMD-only card list ("OmniVoice needs NVIDIA"). It does not block the start, it only words the menu.
4. **Card memory is NVIDIA-only.** `nvidiaCardMiB` returns null for an AMD card, so the small-card rules (`isSmallCard`, `underNeeded`) claimed nothing on AMD.
5. **No way to use another Python.** The launcher sets `CYBERPUNK_CONVAI_PYTHON` to the pack's python.exe (`packaging/runtime/prepare-state.mjs serviceEnvironment`) and clears any inherited one. And a portable worker refuses an `omnivoice` package outside the application directory (`validate_portable_source`), so even a swapped interpreter with its own OmniVoice install would be refused.

What was **not** a blocker: the worker's `device.startsWith('cuda')` and FP16 checks (a ROCm PyTorch reports device `cuda`), `torch.cuda.*` memory calls (HIP answers them), `TORCH_COMPILE_DISABLE=1`, the graphics-memory counters (`gpu-memory.mjs` reads Windows' vendor-neutral GPU counters, not nvidia-smi), and `runtime-integrity.mjs` (it only reports changed code files, never refuses, and does not cover `app/omni/python`). No flash-attn, xformers, bitsandbytes, Triton or TensorRT is used by the worker.

### The override

- **File:** `<data>/omni-python.txt` (`stateDirectory`, normally `%LOCALAPPDATA%\AiNpcCyberpunkMod\data`). One absolute path to `python.exe`. No settings menu entry, on purpose: one place, nothing for the other players to see. Code: `bridge/omni-own-python.mjs`.
- **Self-test:** `runOwnPythonSelfTest` runs `python -I -` with `SELF_TEST_SOURCE` on stdin (isolated: no PYTHONPATH, no user site). It reports `torch.__version__`, `torch.version.hip` / `torch.version.cuda`, `torch.cuda.is_available()`, the device name and total memory from `torch.cuda.get_device_properties(0)` (never nvidia-smi), one FP16 sum on `cuda`, and whether `numpy`, `soundfile` and the pack's `omnivoice.models.omnivoice` import. `ownPythonVerdict` turns the report into `{usable, backend: 'rocm'|'cuda'|'none', reason}`. Refusal codes: `not-absolute`, `not-found`, `not-python`, `no-pack`, `start-failed`, `timed-out` (120 s), `bad-output`, `no-torch`, `no-gpu`, `op-failed`, `missing-module` (+ module), `omnivoice-failed`.
- **When it runs:** on demand only. The first time OmniVoice is wanted (beside the lazy card list in `convai-bridge.mjs lookUpGraphics`: OmniVoice waits for both through `omniCardPending`), or when the Help page's setup check asks (capped at 8 s there, then the row says "being tested"). Never at start-up (only the small file is read then, so the menu does not say "needs NVIDIA" while the test may still pass) and never on a turn.
- **Worker:** `VoiceSelection.omniWorkerHooks` gives a worker the player's python.exe only for a passed test, plus `CYBERPUNK_CONVAI_OMNI_OWN_PYTHON=1` and `CYBERPUNK_CONVAI_OMNI_SOURCE` (the pack's `app/omni/python/Lib/site-packages/omnivoice`). The worker (`use_packaged_omnivoice`) checks that folder (absolute, no links, inside the application directory or the named pack, the two source files present) and installs a meta-path finder for `omnivoice` only, so `validate_portable_source` checks the same packaged copy as before. A player's own OmniVoice install is never imported. The CUDA graph replay is off by default on a HIP build (`cuda_graph_wanted`, `CYBERPUNK_CONVAI_CUDA_GRAPH=1` turns it on). The worker logs one `[gpu]` line with the backend, card and memory.
- **Admission:** with a passed test the card memory comes from PyTorch (`vramMiB`), so `isSmallCard` / `underNeeded` / the 8 GB no-start rule work on AMD like on NVIDIA. `omniNoNvidia` is false while the own Python is used or still pending. A worker that still exits 78 sets `omniNoCuda` as before.
- **Fallback:** any refusal keeps the Runtime's Python, so a failure ends exactly as today (Pocket or text, never cloud: docs rule "a local voice failure never goes to the cloud").
- **Messages:** Help > Setup check row `omni-python` (`bridge/setup-check.mjs`, `mod/setup-check.lua`), one English line in `probe.log` per changed answer (`Setup check: omni-python used backend=rocm card=... memoryMiB=...` or `... refused backend=... reason=...`), the bridge log line `[OmniPython] ...`, `local-voice-state.json omniPython` and the support report's `summary.json` (`providers.omniPython`). A refused own Python is the player's setup: no automatic error report (`error-events.mjs setupChecked`).
- **Tests:** `bridge/omni-own-python.test.mjs` (ROCm, CUDA and CPU-only reports, a broken path, a hung or garbled self-test, no pack), `bridge/voice-selection.test.mjs` (worker hooks, the NVIDIA hint, the graph retry), `bridge/setup-check.test.mjs` and `bridge/setup-check-lua.test.mjs` (the row and probe.log), `scripts/test_resident_voice_paths.py` (the packaged-source finder, an OmniVoice copy outside the application directory refused, the ROCm graph default, the backend line).

## omni-requirements.txt

The OmniVoice pack's libraries (`packaging/python/omni.in`) without `torch`, `torchaudio`, `torchvision` (they come from AMD) and `nvidia-ml-py` (NVIDIA only):

```
accelerate==1.14.0
alembic==1.19.1
annotated-doc==0.0.5
anyio==4.14.2
asteroid-filterbanks==0.4.0
av==15.1.0
brotli==1.2.0
certifi==2026.7.22
cffi==2.1.1
charset-normalizer==3.5.1
click==8.4.2
colorama==0.4.6
colorlog==6.12.0
contourpy==1.3.3
cycler==0.12.1
defusedxml==0.7.1
einops==0.8.2
filelock==3.32.3
fonttools==4.63.0
fsspec==2026.7.0
greenlet==3.5.5
h11==0.16.0
hf-xet==1.6.0
httpcore==1.0.9
httpx==0.28.1
huggingface_hub==1.28.0
HyperPyYAML==1.2.3
idna==3.19
Jinja2==3.1.6
joblib==1.5.3
julius==0.2.8
kiwisolver==1.5.0
lightning==2.6.6
lightning-utilities==0.15.3
Mako==1.4.1
markdown-it-py==4.2.0
MarkupSafe==3.0.3
matplotlib==3.11.1
mdurl==0.1.2
mpmath==1.3.0
narwhals==2.25.0
networkx==3.6.1
numpy==2.2.6
omegaconf==2.3.1
optuna==4.9.0
packaging==26.3
pandas==2.2.3
pillow==12.3.0
primePy==1.3
protobuf==7.36.0
psutil==7.2.2
pyannote.audio==3.4.0
pyannote.core==5.0.0
pyannote.database==5.1.3
pyannote.metrics==3.2.1
pyannote.pipeline==3.0.1
pycparser==3.0
pydub==0.25.1
Pygments==2.21.0
pyparsing==3.3.2
python-dateutil==2.9.0.post0
pytorch-lightning==2.6.6
pytorch-metric-learning==2.9.0
pytz==2026.3.post1
PyYAML==6.0.3
regex==2026.7.19
requests==2.34.2
rich==15.0.0
ruamel.yaml==0.18.17
ruamel.yaml.clib==0.2.15
safetensors==0.8.0
scikit-learn==1.9.0
scipy==1.17.1
semver==3.0.4
sentencepiece==0.2.2
setuptools==79.0.1
shellingham==1.5.4
six==1.17.0
sniffio==1.3.1
socksio==1.0.0
sortedcontainers==2.4.0
soundfile==0.14.0
speechbrain==1.1.0
SQLAlchemy==2.0.52
sympy==1.14.0
tabulate==0.10.0
tensorboardX==2.6.5
threadpoolctl==3.6.0
tokenizers==0.22.2
torch-audiomentations==0.12.0
torch_pitch_shift==1.2.5
torchmetrics==1.9.0
tqdm==4.70.0
transformers==5.15.1
typer==0.27.1
typing_extensions==4.16.0
tzdata==2026.3
urllib3==2.7.0
```
