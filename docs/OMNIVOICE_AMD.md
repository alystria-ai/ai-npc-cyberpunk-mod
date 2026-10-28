# OmniVoice on an AMD graphics card (experimental)

OmniVoice was NVIDIA-only until 0.3.3: the OmniVoice pack's PyTorch is a CUDA build. Since 0.3.4 an AMD Radeon card gets **one button in the game** that sets it up: Settings > Voices > **OmniVoice for AMD** > **Set up OmniVoice for AMD**. It downloads AMD's own ROCm build of PyTorch straight from AMD, puts it in the mod's data folder, tests it on the card and, if the test passes, OmniVoice starts on the AMD card by itself. No Python to install, no files to edit, nothing of the NVIDIA route changes.

Still experimental: the setup is built from AMD's package index and tested with stand-ins only (no AMD card here). On 27 Oct 2026 the first AMD player (RX 9070 XT, 16 GB) reported that OmniVoice works on their PC with their own Python (see "What the first AMD player reported"). If you try the in-game setup, tell me how it went (Nexus posts or Discord) and attach a report: Settings > Help > Help and support > **Generate report**.

## Route chosen (28 Oct 2026) and why

The owner asked for "easy for AMD players, ideally from the game UI": auto-detect AMD or NVIDIA, or a separate installation per vendor. Two routes were weighed:

| | In-game setup (chosen) | An OmniPack-AMD on Hugging Face |
|---|---|---|
| What the player does | Presses one button in Settings > Voices | Downloads another 1.5 GB zip per card family and installs it with the mod manager |
| Card family | Picked from the card's name automatically (RX 9070 = gfx1201 ...) | One pack per family (seven), the player has to pick the right one |
| Whose files | AMD's own, from AMD's index (stable.repo.amd.com), exactly the versions AMD's guide names | The mod would rehost AMD's ROCm binaries (licences of every ROCm library to check, Hugging Face storage and bandwidth) |
| Updates | Re-run `packaging/resolve-omni-amd.mjs`, ship the small list in the next Runtime | Rebuild and re-upload seven packs |
| NVIDIA | Untouched | Untouched |

So the game detects the vendor (it already lists the graphics cards for the Help page), shows the AMD page only on a PC with a discrete AMD Radeon card and no NVIDIA card, and installs from AMD itself. `omni-python.txt` (your own Python) stays as the override for players who want their own setup.

## For players

### Where it is

- With the OmniVoice pack installed and an AMD Radeon RX 6000, 7000 or 9000 card (and no NVIDIA card), Settings > Voices has a row **OmniVoice for AMD**, right under the voice list. It appears about 20 seconds after the game starts (the card list is read once then).
- Until the setup is done the voice list reads "Companion voices (OmniVoice on AMD: set up first)" and a character set to OmniVoice reads "OmniVoice · AMD: set up first". Pocket speaks for them meanwhile. A local voice never switches to a cloud voice.
- A PC with an NVIDIA card (also next to an AMD one) sees nothing new. An Intel or AMD integrated-only PC keeps "OmniVoice needs NVIDIA".

### The page

| Row | What it does |
|---|---|
| **Set up OmniVoice for AMD** (Install) | Checks the card, downloads AMD's files with a progress line ("Downloading 740 of 1480 MB (50%)"), unpacks them, tests them on the card. The game keeps running the whole time. Install turns into **Cancel** while it runs (a cancelled download resumes where it stopped next time). Afterwards the row says Ready, or why it did not work, and offers **Reinstall**. |
| **Remove AMD setup** | Deletes everything the setup put on the drive (about 4 GB). OmniVoice then no longer starts on the AMD card. |
| **MIOpen convolutions (AMD)** (on by default) | On: AMD's MIOpen runs the convolutions, with `MIOPEN_FIND_MODE=2` and `MIOPEN_FIND_ENFORCE=1`. Off: PyTorch's own convolutions. Which is faster depends on the card and driver: if voices are slow or stop part-way, try the other one. OmniVoice restarts with the new choice at its next idle moment. AMD cards only: an NVIDIA card is never touched by it. |

### What it downloads

From AMD's index `https://stable.repo.amd.com/rocm/whl-next/` (the one AMD's PyTorch install guide names), PyTorch 2.14.0 with ROCm 10.1.0 for Python 3.11 (the OmniVoice pack's Python), only the files of the card's family. For an RX 9070 / 9070 XT (gfx1201):

| File (from AMD) | MB |
|---|---|
| rocm_sdk_core-10.1.0-py3-none-win_amd64.whl | 741 |
| rocm_sdk_device_gfx1201-10.1.0-py3-none-win_amd64.whl | 300 |
| amd_torch_device_gfx12_0-2.14.0+rocm10.1.0-cp311-cp311-win_amd64.whl | 164 |
| rocm_sdk_libraries-10.1.0-py3-none-win_amd64.whl | 113 |
| torch-2.14.0+rocm10.1.0-cp311-cp311-win_amd64.whl | 110 |
| amd_torch_device_gfx1201-2.14.0+rocm10.1.0-cp311-cp311-win_amd64.whl | 49 |
| torchaudio-2.11.0.3+rocm10.1.0, torchvision-0.29.0a0+rocm10.1.0 (+ its gfx1201 part), rocm_bootstrap-0.3.0, rocm-10.1.0.tar.gz | 3 |
| **Total** | **about 1.45 GB download, 4.0 GB on the drive** |

| Card family | Cards (Windows names) | Download | On the drive |
|---|---|---|---|
| gfx1201 | RX 9070, RX 9070 XT, Radeon AI PRO R9700 | 1.45 GB | 4.0 GB |
| gfx1200 | RX 9060, RX 9060 XT | 1.50 GB | 4.0 GB |
| gfx1100 | RX 7900 XTX / XT / GRE, RX 7900M, PRO W7800 / W7900 | 1.46 GB | 4.0 GB |
| gfx1101 | RX 7800 XT, RX 7700 (XT), PRO W7700 | 1.46 GB | 4.0 GB |
| gfx1102 | RX 7600 (XT / M), RX 7650 GRE, PRO W7500 / W7600 | 1.46 GB | 4.0 GB |
| gfx1030 | RX 6800 (XT), RX 6900 XT, RX 6950 XT, PRO W6800 | 1.04 GB | 3.4 GB |
| gfx1031 | RX 6700 (XT), RX 6750 XT | 1.04 GB | 3.4 GB |

Another discrete Radeon (an RX 6600, an RX 5000 card) gets the page too, and Install says "AMD's ROCm PyTorch does not support this card yet." OmniVoice still needs about 12 GB of video memory next to the game, the same as on NVIDIA: on an 8 GB card the setup may pass and OmniVoice is then not started (the small-card rules use the memory PyTorch reports).

Every file is checked after the download: its size, and its MD5 against the one AMD's server publishes for it (the ETag), or its SHA-256 when the list has one. A file that does not match is deleted and the setup says so.

### Where it goes

`%LOCALAPPDATA%\AiNpcCyberpunkMod\data\amd\` (short names on purpose: AMD's deepest file path is 164 characters and Windows stops at 260). Nothing in the game folder, nothing in the OmniVoice pack changes. **Remove AMD setup** deletes the whole folder.

### What can go wrong (the page's words)

| The page says | Why |
|---|---|
| The OmniVoice pack is not installed. Install it first. | OmniVoice's model and code come from the pack. |
| This PC has no AMD Radeon card this setup can use. | No discrete AMD card, or an NVIDIA card is there too (that PC uses the NVIDIA route). |
| AMD's ROCm PyTorch does not support this card yet. | A family not in AMD's list. |
| There is not enough free space on drive C:. | It needs the download plus about 4 GB plus 0.5 GB to spare. |
| The download did not finish. / The downloaded files did not check out. | Connection lost, or a file did not match (it was deleted). Try again: a lost download resumes. |
| The setup did not pass the test on your card, so OmniVoice cannot use it. | PyTorch did not see the card or the test sum on it failed. A current AMD graphics driver is the usual fix. Help > Setup check names the exact reason. |
| Your own Python (omni-python.txt) is used instead. | Your own file wins. Delete it to use the in-game setup. |

## What the in-game setup does, step by step

1. **Checking.** The OmniVoice pack is there, the card list has a discrete AMD card and no NVIDIA one, its family is in the pinned list, the drive has room.
2. **Downloading.** AMD's files for that family, one by one, into `data\amd\downloads\` (a `.part` file resumes with an HTTP range request), then checked.
3. **Unpacking.** Into `data\amd\st\`: the top-level files of the pack's `app\omni\python` (python.exe, python311.dll, python311.zip, the `.pyd` files: the interpreter, a few MB) and AMD's wheels unpacked into `st\sp\` with Windows' own `tar.exe`. The `rocm` meta package comes from AMD as a tiny source package: its pure-Python `rocm_sdk` package is copied and given a `.dist-info` from its PKG-INFO, which is what pip's build of it installs. The path file `python311._pth` lists `sp` **before** the pack's own `Lib\site-packages`, so `import torch` finds AMD's PyTorch and every other library (numpy, transformers, OmniVoice's code) is the pack's. Then `setup.json` is written, any older setup is let go and replaced, `st\` becomes `py\` and the downloads are deleted.
4. **Testing.** Exactly the test a player's own `omni-python.txt` gets: PyTorch imports, sees the card, one FP16 sum on it is right, and OmniVoice's code from the pack imports. Only a pass with the ROCm backend counts.
5. **Ready.** OmniVoice starts on the card at once (the earlier "needs CUDA" of this session is undone), with the ROCm settings below.

The service reads the card list once, about 20 seconds after start-up and only with the OmniVoice pack installed (three registry reads, the same the Help page makes). Everything else happens only after a button press, in the background, never on the game's thread and never per frame.

### The speed and stability settings on ROCm

**They change nothing for an NVIDIA card or for the Runtime's own Python.** The worker logs one line when it starts, for example `[rocm] HIP 10.1.0: MIOPEN_FIND_MODE=2, MIOPEN_FIND_ENFORCE=1; convolutions: MIOpen`, and `[priority] high`.

| Setting | Default since 0.3.4 | How to change it |
|---|---|---|
| MIOpen convolutions | On, with `MIOPEN_FIND_MODE=2` (FAST) and `MIOPEN_FIND_ENFORCE=1`, as an RX 9070 XT player suggested. Off: `torch.backends.cudnn.enabled = False` (PyTorch's own convolutions, the 0.3.3 default), with `MIOPEN_FIND_MODE=2`. | The **MIOpen convolutions (AMD)** row in game. `miopen = on` or `miopen = off` in `omni-python.txt` wins over it. |
| MIOpen find mode, find enforcement | `2` and `1` | `miopen-find-mode = NORMAL` (or another mode) in `omni-python.txt`, or set `MIOPEN_FIND_MODE` / `MIOPEN_FIND_ENFORCE` yourself where the game starts: the mod then leaves them alone. |
| Process priority (both routes, NVIDIA too) | High from the worker's start, for good (docs/PROCESS_PRIORITY.md) | **If the game stutters while a voice renders**, `priority = normal` in `priority.txt` in the mod's data folder, or in `omni-python.txt` for your own Python. `priority = below` lowers the worker below normal. |

### Your own Python instead (`omni-python.txt`, kept as the override)

For players who want their own Python with AMD's PyTorch, or another version than the pinned one. It always wins over the in-game setup.

1. Make a Python 3.12 environment (`py -3.12 -m venv .venv`, `.venv\Scripts\activate`).
2. Install AMD's PyTorch with AMD's own command for the card, for the RX 9070 XT:

   ```
   python -m pip install --index-url https://stable.repo.amd.com/rocm/whl-next/ "torch[device-gfx1201]==2.14.0+rocm10.1.0" "torchvision[device-gfx1201]==0.29.0a0+rocm10.1.0" "torchaudio==2.11.0.3+rocm10.1.0"
   ```

   Check with `python -c "import torch; print(torch.cuda.is_available(), torch.version.hip)"` (it should print `True` and a ROCm version).
3. Install OmniVoice's libraries without touching PyTorch: save the list at the end of this page as `omni-requirements.txt` and run `python -m pip install --no-deps -r omni-requirements.txt`.
4. Put the full path of that python.exe on one line in `%LOCALAPPDATA%\AiNpcCyberpunkMod\data\omni-python.txt`. Optional lines after it: `miopen = on|off`, `miopen-find-mode = <mode>`, `priority = high|normal|below`. Lines starting with `#` are ignored. Delete the file to undo.
5. Restart the game and choose an OmniVoice entry. Settings > Help > Setup check has an **OmniVoice Python** row with the result of its test.

### What the first AMD player reported

One player's numbers on one PC (RX 9070 XT, 16 GB, 27 Oct 2026), reported to me, not measured here and not a guarantee:

- Stock (before any ROCm settings): about 10 to 15 seconds per sentence, sometimes the voice stopped part-way, and MIOpen errors "not able to find convolution paths".
- Two remedies they found: `MIOPEN_FIND_MODE=FAST`, or MIOpen's convolutions off (`torch.backends.cudnn.enabled = False`), which they found snappier, under 10 seconds per sentence. 0.3.3 applied both. On 28 Oct they suggested MIOpen on with `MIOPEN_FIND_MODE=2` and `MIOPEN_FIND_ENFORCE=1` as the default and MIOpen off as an AMD-only option: that is 0.3.4's default and the in-game choice.
- The quality presets (16 or 32 steps) barely changed the speed. The game dropped frames while a sentence rendered (the worker's priority is a choice, above).

### Why the voice could stop part-way

A reply is spoken phrase by phrase. When a later phrase failed to render (for example a MIOpen error), the reply used to end there. On the ROCm route the mod asks once more for a phrase that failed before giving up (`[OmniPython] phrase N failed (...), asking again`). A phrase that fails twice still ends the reply, and a cancelled reply is never retried.

### What is untested

On real AMD hardware: the in-game download and unpacking (tested with a fake AMD server and real `tar.exe` on small stand-in files), whether AMD's unpacked wheels load from the borrowed interpreter exactly as from a pip install, every part of OmniVoice on ROCm for Windows (half-precision weights, PyTorch's attention), speed, and video memory next to the game. Please report back.

## For developers

### What blocked AMD (root cause)

1. **The bundled PyTorch is a CUDA wheel.** `app/omni/python` ships `torch-2.8.0+cu128` (`packaging/python/omni.in`). It cannot see a Radeon.
2. **The worker's CUDA gate then ends OmniVoice for the session.** `resident-voice-worker.py` exits with `NO_CUDA_EXIT_CODE` (78), `VoiceSelection.scheduleOmniRetry` sets `omniNoCuda`. Since 0.3.4 `VoiceSelection.checkOwnWorker` undoes it when a Python newly passes its test (the AMD setup finished), so no restart is needed.
3. **Card memory is NVIDIA-only** in the card list (`nvidiaCardMiB`): with a passed test the memory comes from PyTorch (`vramMiB`).
4. **The pack's Python is embeddable** (python 3.11.9 with `python311._pth`): PYTHONPATH is ignored and the worker runs with `-I`. That is why the setup is a second interpreter with its own path file, not an extra folder on the pack's.

Not blockers: the worker's `device.startsWith('cuda')` and FP16 checks (ROCm reports device `cuda`), `torch.cuda.*` memory calls (HIP answers them), `gpu-memory.mjs` (Windows' vendor-neutral counters), `runtime-integrity.mjs`. No flash-attn, xformers, bitsandbytes, Triton or TensorRT.

### The pieces

- **Pinned list:** `bridge/omni-amd-wheels.mjs`, written by `node packaging/resolve-omni-amd.mjs [--hash]`. It reads AMD's simple index, follows the Requires-Dist lines of `torch[device-<gfx>]`, `torchaudio` and `torchvision[device-<gfx>]` like pip for `cp311`/`win_amd64` (each wheel's METADATA through two or three HTTP range reads, the `rocm` source package of 27 KB whole), skips what the pack has (`FROM_PACK`: numpy, sympy, networkx, jinja2, fsspec, filelock, typing-extensions, setuptools, pillow, markupsafe, mpmath) and records size, unpacked size and ETag per file. `--hash` downloads everything once (several GB) and records SHA-256, which the game then checks instead of the ETag MD5. A module, not JSON, so the Runtime build ships it with the bridge's import closure. Families: `TARGETS` (gfx1201, gfx1200, gfx1100, gfx1101, gfx1102, gfx1030, gfx1031). AMD's `whl-next` index is "next": re-run the resolver before a release, and if AMD removed these versions the download fails with "did not finish".
- **Layout:** `bridge/omni-amd-layout.mjs` (`amdPaths`, `pthText`, `prepareInterpreter`, `syncAmdPython`, `readAmdSetup`). `setup.json` is written last: without it nothing in `data\amd` is used.
- **Job and IPC:** `bridge/omni-amd-setup.mjs` `OmniAmdSetup`: `runtime/omni-amd-command.json` (`{version: 1, id, action: install | cancel | remove, issuedAt}`) in, `runtime/omni-amd-state.json` out (`{version, updated, offered, installed, arch, card, downloadMiB, diskMiB, ownPython, job: {id, action, state: checking | downloading | unpacking | testing | done | failed | cancelled | removed, doneMiB, totalMiB, code}, test: {state: used | refused | testing, backend, device, vramMiB}}`). Failure codes: `no-pack`, `not-amd`, `unsupported-card`, `no-space`, `download-failed`, `checksum`, `unpack-failed`, `test-failed`, `not-ready`, `unknown`. A cancelled job answers with the cancel command's id. `amdArch(name)` maps Windows card names to families, `amdCard(cards)` uses `gpu-vendors.mjs amdRoute`. Both exchange files are in `packaging/runtime-exchange.json` (shipped placeholders the game writes in place).
- **Game side:** `mod/omni-amd.lua` (state cleaning, rows, commands, the latest-command rule) and `mod/manager-ui.lua` (the Voices row, the page, the MIOpen row). `amdMiopen` is an ordinary saved setting (`mod/manager.lua`, default true).
- **The test and the worker:** `omni-own-python.mjs readOwnPythonSetting` returns the setup's Python as `{configured, managed: true, path}` when there is no `omni-python.txt`. `resolveOwnPython` runs `syncAmdPython` first (the path file follows a moved game folder or a new pack, the interpreter is copied again when the pack's changed), then the same self-test. `managed` is carried into the voice state, the support report, the log line (`OmniVoice uses the AMD setup: ...`) and the Help row ("The AMD setup (Settings > Voices > OmniVoice for AMD) runs OmniVoice with ROCm on ..."). The bridge (`convai-bridge.mjs`) passes `recheck` (`checkOwnPython({force: true})`) and `release` (the setup's Python is no longer given to a worker, `VoiceSelection.releaseOmniWorkers` lets the running one go) before files are replaced or removed.
- **MIOpen:** `rocmWorkerEnvironment(own, processEnv, {miopen})` gives a ROCm worker `CYBERPUNK_CONVAI_ROCM_MIOPEN=1|0`, `MIOPEN_FIND_MODE=2` and, with MIOpen on, `MIOPEN_FIND_ENFORCE=1` (a variable already in the bridge's environment is the player's; `omni-python.txt` lines win over the setting, `miopenWanted`). `{}` for CUDA or the Runtime's Python. `VoiceSelection.workerKey` includes the Python and the MIOpen choice, so a changed choice replaces a ROCm worker at the next idle moment (`clientStale`). In the worker `tune_rocm` applies the same defaults when the variables are missing (MIOpen on unless `CYBERPUNK_CONVAI_ROCM_MIOPEN=0`), `keep_rocm_convolutions` re-asserts "off" after the model load only when it is off.
- **Fallback:** any refusal keeps the Runtime's Python, so a failure ends as before (Pocket or text, never cloud). A refused AMD setup is the player's setup: no automatic error report.
- **Tests:** `bridge/omni-amd-setup.test.mjs` (card names, the pinned list, checksums, commands, resumed and cancelled downloads, the path file, the interpreter copy, `omni-python.txt` winning, unpacking with the real `tar.exe`, the whole job against a fake AMD server and a fake pack, every failure code, cancel), `bridge/omni-amd-lua.test.mjs` (the page), `bridge/omni-own-python.test.mjs` (`rocmWorkerEnvironment`, `miopenWanted`), `bridge/voice-selection.test.mjs` (a setup that passes after "no CUDA", the MIOpen choice replacing a ROCm worker and not a CUDA one), `bridge/setup-check-lua.test.mjs` (the AMD setup rows), `scripts/test_resident_voice_paths.py` (`tune_rocm`, `keep_rocm_convolutions`).
- **Live checks still needed (an AMD card):** one install end to end on an RX 9070 XT (download, unpack, `[OmniPython] OmniVoice uses the AMD setup` in the log, a voice), MIOpen on against off on the same card, Cancel and resume, Remove (folder gone, OmniVoice back to Pocket), and a PC with an NVIDIA card showing no AMD row.

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
