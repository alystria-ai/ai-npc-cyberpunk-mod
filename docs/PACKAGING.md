# Release packaging (developer notes)

How the player release is built, what it contains and how it starts. Players read
`packaging/PLAYER_README.md` instead (it ships in every package and is the release notes).

## The packages

| Package | Where players get it | Contents |
|---|---|---|
| `AI-NPC-Cyberpunk-Mod-Scripts-<v>.zip` | Nexus Mods | Text only: the CET Lua mod, redscript, the four JSON catalogs the Lua reads, the empty `runtime/` placeholder files (see "Mod Organizer 2" below), `README.txt` and `release.json`. |
| `AI-NPC-Cyberpunk-Mod-Runtime-Update-<from>-to-<to>.zip` | Hugging Face, beside the full Runtime | From 0.2.3 on, every release: only the Runtime files that were added or changed since the previous Runtime, the new `release.json` and the removal list; extracted over the previous version ("Runtime update zip" below). Not built by `build-release.mjs`: `build-runtime-update.mjs` makes it from the two full Runtime zips. |
| `AI-NPC-Cyberpunk-Mod-Runtime-<v>.zip` | GitHub release of this repository | Everything else needed to play: the RED4ext launcher, bundled Node and Python, the bridge, the Pocket voice and lip-sync models, voice references, game archives and the Audioware reply bank. |
| `AI-NPC-Cyberpunk-Mod-OmniPack-<v>.zip` | Hugging Face | Optional OmniVoice pack, one zip: CUDA Python environment, the VoiceStudio adapter, the OmniVoice model and the OmniVoice references. |
| `AI-NPC-Cyberpunk-Mod-LocalAI-Standard-<v>.zip` | Hugging Face | Optional Local AI pack with Gemma 4 E4B (about 5.3 GB), one zip: the llama-server Vulkan build, the embedding model and the chat model, whole. |
| `AI-NPC-Cyberpunk-Mod-LocalAI-Lite-<v>.zip` | Hugging Face | Optional Local AI pack with Bonsai 2 4B (about 1.4 GB), the same server and embedding model. |
| `AI-NPC-Cyberpunk-Mod-MicPack-European-<v>.zip`, `AI-NPC-Cyberpunk-Mod-MicPack-Asian-<v>.zip` | Hugging Face | The two optional voice-input packs (opt-in build, "Voice-input packs" below): Parakeet TDT 0.6B v3 for European languages, SenseVoice Small for Chinese, Japanese and Korean. Each is one zip with the model files in `app/models/stt/<id>/` and its own notice. |
| `AI-NPC-Cyberpunk-Mod-Mature-Lite-<v>.zip`, `AI-NPC-Cyberpunk-Mod-Mature-Standard-<v>.zip` | Hugging Face | The two optional Mature packs (opt-in build, below), one uncensored model each, each with its own marker (`manifest.mature-lite.json`, `manifest.mature-standard.json`) and the Local AI engine (the `llama` folder, the embedding model and the licence texts, the same files as in the Local AI packs, shared through `addEngine` in `packaging/build-release.mjs`), so either works alone. |

The optional packs are hosted in one Hugging Face model repository, `alystria-ai/ai-npc-cyberpunk-mod-packs`, in a folder per
version (`0.2/AI-NPC-Cyberpunk-Mod-OmniPack-0.2.zip`, with `0.2/SHA256SUMS-omni.txt` beside it). Each pack is ONE zip: no `-partNofM` zips
and no `.partN` files inside. GitHub's 2 GiB per-file limit was the only reason for parts, and Hugging Face has no such limit. A model
over 4 GiB (the standard Local AI model, the good Mature model) sits whole in a ZIP64 zip (`packaging/lib/zip.mjs` writes ZIP64 only
where an entry or the archive needs it; Windows Explorer, PowerShell's Expand-Archive, 7-Zip and tar read it). The repository is private
until release day, when it goes public with the GitHub repository. The players' links are in the README's Install section.

Why this split: Nexus Mods scans every upload and holds files that its scanners flag for manual
review (help.nexusmods.com articles 128 and 117); it has no blanket rule against DLLs or
executables, but a text-only file never needs that review and is never quarantined. The Nexus page
must list RED4ext among the requirements (with CET, redscript, Codeware, TweakXL, Audioware and
Native Settings UI): the Runtime package's launcher and native plugin are RED4ext plugins. The large,
binary runtime goes to the GitHub release as plain zips, which is how the core frameworks
(RED4ext, Codeware, TweakXL, Audioware) are distributed too; RED4ext also builds in Actions and
publishes SHA-256 values with each release, which this pipeline does as well.

All of them use game-root-relative paths and merge into one install. Versions must match;
`app/launcher/start-service.mjs` logs a warning when the Scripts `release.json` differs from the
Runtime one.

## Version numbers

Releases are numbered `0.N`: 0.1, 0.2, 0.3, ..., and a hotfix of one release is `0.N.M` (0.2.1).
The first build (2026-10-07, a private-repository test of the pipeline) was made as `2077.1` and
renamed to `v0.1` on 2026-10-16 (title, tag and file names; the files inside were not rebuilt); the version check still accepts the old `2077.N` form. The tag is `v` + the
number (`v0.2`) and the workflow accepts both forms (`v0.2`, `v0.2.1`); a manual run takes the number
without the `v`. The same string goes into the package file names (`AI-NPC-Cyberpunk-Mod-Scripts-0.2.zip`), the release title, both
`release.json` files and the OmniVoice `omni-pack.json`. The only version check at run time is
`start-service.mjs` comparing the Scripts and Runtime strings for equality, so any form works; the
builder accepts two to four numbers with an optional `-pre`/`+build` suffix
(`packaging/lib/version.mjs`, guarded by `release.test.mjs`), and writes a three-part form
(0.2.0) only into `app/package.json`, which npm-style tooling wants as semver. The installed-layout
tool `test-release-install.mjs` matches package files by exact version, so 0.2 never picks up
0.2.1 or 0.20.

## Installed layout

```
red4ext/plugins/AiNpcCyberpunkMod/
  CyberpunkConvai.dll        launcher (native/autostart, compiled in the build)
  launcher.ini               UTF-16: %PLUGIN%\app\node\node.exe --eval <bootstrap> app\launcher\start-service.mjs (packaging/lib/launcher-ini.mjs)
  app/                       the application, replaced by every update
    node/node.exe            official Node.js (node.exe and LICENSE only)
    python/                  official CPython 3.12 embeddable + hash-locked wheels (Pocket worker)
    pocket-tts/              Kyutai pocket-tts source at the pinned revision (tree hash verified)
    bridge/                  production import closure + worker scripts + the supervisor
    node_modules/            playwright and playwright-core only
    assets/                  fresh realtime-client.js bundle + PCM player modules
    characters/, research/   data the bridge reads (roster, world knowledge, quest catalog, intrinsic packs)
    models/pocket/           Pocket student v2 + decoder v2 export
    models/lipsync/          lip-sync model, text stage and lexicon
    models/stt/              Moonshine Tiny English int8 (local speech recognition for the Mistral route; MIT)
    defaults/                templates and managed defaults copied into data/ at start-up (the Pocket list, and the Runtime's own OmniVoice lists)
    launcher/                start-service.mjs, prepare-state.mjs, assemble-parts.mjs, migrate-legacy.mjs, place-packs.mjs, state-home.mjs
    licenses/                third-party notices (Python packages keep theirs in *.dist-info)
    omni/                    the OmniVoice pack, when installed
    local-ai/                the Local AI pack(s), when installed (llama/, models/, licenses/, manifest.*.json)
  voices/                    reference clips (outside app/: the Omni worker requires it)
    prepared/                the bridge's cache of the Mistral voice's references, and the OmniVoice pack's slots (see below)
    prepared-runtime/        the Runtime's pre-built slots for the Pocket clips (read after prepared/, never written)
red4ext/plugins/AiNpcCyberpunkModNative/
  CyberpunkConvaiNative.dll  the native core plugin (native/core, compiled in the build) and its licence texts
bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod/
  *.lua, locales/, *.json    Scripts package
  runtime/                   Lua <-> bridge exchange files (the only folder the service writes in the game folder's CET mod)
    native-off.txt           which native systems stay off (Runtime package, see below)
r6/scripts/CyberpunkConvai/  redscript (Scripts package)
r6/audioware/CyberpunkConvai speech.yml + eight silent reply slots (Runtime)
archive/pc/mod/              convai_facial, convai_gestures, cyberpunk_convai_ambient_driver_guard (Runtime)

%LOCALAPPDATA%/AiNpcCyberpunkMod/   outside the game folder (packaging/runtime/state-home.mjs)
  data/                      player state, created on first start (before this change: mods/AiNpcCyberpunkMod/data)
    game-state/              copies of the player's files in runtime/ (settings, phone chats, ...), written back at start (see "the player's state")
```

RED4ext loads DLLs only from `red4ext/plugins/*.dll` and `red4ext/plugins/<name>/*.dll`
(PluginSystem.cpp stops at depth 1), so the Python, torch and Chrome DLLs under `app/` are never
loaded into the game. Keeping the application there also keeps paths short: the build refuses any
entry whose game-relative path would exceed 255 characters under a 70-character game folder
(the default Steam path is 61). Windows' built-in zip extractor fails beyond 260.

## How it starts

1. RED4ext loads `CyberpunkConvai.dll`. It checks that CET and the CET mod are present, reads
   `launcher.ini` and starts `app\node\node.exe --eval <bootstrap> app\launcher\start-service.mjs` hidden, with a pipe
   whose closing tells the service that the game ended. The bootstrap (`packaging/lib/launcher-ini.mjs`) loads the script where it is,
   or from its real place when Node's stat cannot see it (a Runtime installed as a Mod Organizer 2 mod, below).
2. `start-service.mjs` prepares `data/` (below), joins split files left by an earlier release on the first start
   (verifying their SHA-256; current packs have none), and sets every path explicitly:
   `CYBERPUNK_CONVAI_CLIENT_ASSETS`, the four `CYBERPUNK_CONVAI_OMNI_*`
   paths and `CYBERPUNK_CONVAI_PYTHON` when the pack is installed, the key file and state folder.
   It clears inherited `NODE_OPTIONS`, `PYTHONPATH` and similar overrides. Nothing is looked up on PATH. The one thing the package
   does not carry is a browser: the bridge's hidden browser is the Microsoft Edge that Windows 10 and 11 include, else an installed
   Google Chrome, else another installed Chromium browser (Brave, Vivaldi, Opera and Opera GX, Chromium, Edge and Chrome Beta, Dev and
   Canary, Yandex, Thorium and a few more). `bridge/system-browser.mjs` checks the usual install folders, then the registry's App Paths
   entries (so a browser installed elsewhere is found), once per start and only until one is found. Firefox cannot be used: Playwright
   drives only its own patched Firefox. A developer's `CYBERPUNK_CONVAI_BROWSER` still names an executable instead.
   Chrome for Testing was bundled in 0.2 until Hugging Face's virus scanner flagged its `chrome.dll` (a false positive). If neither
   browser is installed the supervisor reports `browser-missing` (the in-game notice, the Settings status line and Help row that name the missing browser, one line in
   `bridge-service.log`) and starts the bridge by itself once one is installed.
3. It then runs the development supervisor unchanged (`bridge/bridge-supervisor.mjs`): one bridge
   per game session, crash restarts, the status file the in-game Help page reads, and a graceful
   stop when the game exits. `--prepare-only` stops after step 2 and prints a summary.

The embedded Pythons use their `._pth` file (`Lib\site-packages`, `..\bridge`, `import site`), so
they ignore any Python installed on the machine.

### The native plugin and `native-off.txt`

`red4ext/plugins/AiNpcCyberpunkModNative/CyberpunkConvaiNative.dll` is built from `native/core` in the release build
(the CMake project that `scripts/Build-NativeCore.ps1` drives, MSVC from Visual Studio 2022, static CRT, `/Brepro`; the RED4ext SDK
is fetched by CMake at the commit pinned in `native/core/CMakeLists.txt`). The Runtime job of the workflow checks the toolchain
before building and the clean-install test inspects the DLL with `convai_plugin_host.exe` (it checks the file without running game
code). The package works without it: `--no-native` leaves it out and the Lua falls back to its own path for every system
(`mod/native-core.lua`). The plugin's licence texts (RED4ext.SDK, yyjson) sit next to the DLL.

`bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod/runtime/native-off.txt` ships with exactly `actuator`, `vehicles`,
`chauffeur`, `passage` and `faces`: the systems that are not yet proven in the real game start switched off. One name per line,
`#` starts a comment, `all` switches everything off; the plugin polls the file about once a second and the Lua reads it too. A
**missing file means every system is on**, so the file is part of the package, and a player turns a system on by deleting its line.
The list lives in `native.off` in `packaging/release.config.json`; change it there when a system has been proven.

### Local AI packs

Two optional downloads (`docs/LOCAL_AI.md`): `localai-standard` (Gemma 4 E4B) and `localai-lite` (Bonsai 2 4B). Each holds the
`llama-server` Vulkan build b11560 (only the server and its DLLs), the granite embedding model, one chat model, a manifest fragment
(`manifest.standard.json` or `manifest.lite.json`, merged by `bridge/local-ai-pack.mjs`), the licence texts and the notices, under
`red4ext/plugins/AiNpcCyberpunkMod/app/local-ai/`. The two packs repeat the shared server, embedding and notice files byte for byte, so
extracting both only overwrites identical bytes. The chat model ships whole (no parts): `bridge/local-ai-pack.mjs` finds the model file directly, and
`assemble-parts.mjs` only joins parts that an earlier release left behind (it finds no `.parts.json` in a current install and does nothing). Every file is the unmodified upstream file, pinned in the
`localAi` block of `release.config.json` by URL, revision and SHA-256; a developer folder can stand in with `--models local`.
Licences (all redistributable with the licence text, which the packs carry): llama.cpp MIT, the LLVM OpenMP runtime Apache-2.0 with
LLVM exceptions, Gemma 4 E4B Apache-2.0 (Google also publishes a prohibited use policy), Bonsai 2 4B (PrismML, a Qwen3.5-based model) Apache-2.0, granite-embedding
Apache-2.0. `THIRD_PARTY_NOTICES.md` has the table.

### Voice-input packs (`micpack-european`, `micpack-asian`)

Two optional downloads for voice input in other languages (`docs/LOCAL_STT.md`, "The optional packs"), hosted on Hugging Face with the other optional
packs, each ONE zip: `AI-NPC-Cyberpunk-Mod-MicPack-European-<v>.zip` (NVIDIA Parakeet TDT 0.6B v3, int8, pack id `parakeet-tdt-0.6b-v3-int8`, about 0.67 GB; CC-BY-4.0)
and `AI-NPC-Cyberpunk-Mod-MicPack-Asian-<v>.zip` (SenseVoice Small, int8, pack id `sense-voice-int8`, about 0.24 GB; FunASR Model Open Source License 1.1;
Mandarin Chinese, Japanese and Korean; the archive is the original 2024-07-17 one, not the 2025-09-09 Cantonese fine-tune, which cannot read Japanese or Korean). Never on Nexus Mods, never
on the GitHub release, never in the default set, nothing of them in the Runtime package.

- **Layout.** `red4ext/plugins/AiNpcCyberpunkMod/app/models/stt/<pack id>/` holds the model files (the names `bridge/speech-language.mjs` `LOCAL_PACKS` lists;
  `bridge/local-stt.mjs` `resolveLocalSttPaths` looks in `models/stt/<id>/`), `mic-pack.json` (marker: product, package, version, commit, pack id, languages,
  model, source URL, archive SHA-256, licence), `NOTICE.txt` (attribution and licence link) and `LICENSE-mod.txt` (the mod's licence, one copy per pack
  folder). The two packs share no path with each other, and neither shares one with the Runtime's `app/models/stt/moonshine-tiny-en-int8/`, so extracting
  them in any order over a Runtime is safe (`node packaging/check-pack-overlap.mjs check <zip>` says OK).
- **Pins.** `micPacks` in `release.config.json`: per pack the id, package id, title, source archive (URL, size, SHA-256 and the folder it unpacks to), each file
  (size, SHA-256), licence and link, attribution text, languages, the notice file (`packaging/mic-packs/NOTICE-european.txt`, `NOTICE-asian.txt`).
  The files are the unmodified ones of the sherpa-onnx `asr-models` archive; `test_wavs/` and the archive's README are not shipped.
- **Build.** Opt-in, like the Mature packs:
  `node packaging/build-release.mjs --version 0.2.3 --packages micpack-european,micpack-asian` downloads each archive from its pinned GitHub URL (SHA-256 checked),
  lists it with the system `tar` (an entry outside the archive's own folder stops the build; the archive is untrusted data and nothing in it is run), extracts only
  the files the pack ships into a fresh cache folder and checks each against its pin. No secret and no `--models` are needed. `--mic-pack-source DIR` (or the
  environment variable `CYBERPUNK_CONVAI_MIC_PACKS_DEV`) takes the files from a developer folder laid out as `DIR/<pack id>/<file>` instead, each checked against
  the same pins. `--release-config PATH` reads the pins from another file (the packaging test uses it with small stand-in files).
- **Workflow.** The `micpacks` input of the Release workflow (default off, never on a tag push) runs the `micpacks` job, a matrix of `european` and `asian`
  (one runner each), which builds with `--packages micpack-<x>` and uploads with `packaging/upload-packs.py --pack micpack-<x>` (`<v>/<zip>` and
  `<v>/SHA256SUMS-micpack-<x>.txt` in `alystria-ai/ai-npc-cyberpunk-mod-packs`).
- **Extracted one folder too deep.** `place-packs.mjs` also recognises `app/models/stt/<id>/mic-pack.json` of these two ids and moves only that folder (never
  the Runtime's Moonshine folder), with the same safety rules as for the other packs (marker last, empty wrapper folders removed with `rmdir`, a same-size file in
  place keeps it, a different size leaves both). The log names them `MicPack-European` and `MicPack-Asian`.
- **Tests.** `packaging/mic-packs.test.mjs` (builds both packs with stand-in files, and from a generated archive served over HTTP; with
  `CYBERPUNK_CONVAI_MIC_PACKS_DEV` set it also builds the real files), the pack tests at the end of `packaging/place-packs.test.mjs`, and the source tests in
  `packaging/release.test.mjs`.

### Packs extracted one folder too deep (`place-packs.mjs`)

The optional packs are zips whose entries start at the game root. Windows "Extract All" and 7-Zip's "Extract to <zip name>\" wrap
them in a folder named after the zip, so the files land in
`<game>\AI-NPC-Cyberpunk-Mod-LocalAI-Standard-0.2\red4ext\plugins\AiNpcCyberpunkMod\app\local-ai\...` and the mod reports "No model
installed" or "not installed". `packaging/runtime/place-packs.mjs` (shipped as `app/launcher/place-packs.mjs`) moves them into place.
`start-service.mjs` runs it once per game start, before `prepareState` and its pack checks; a failure is logged and never stops the service.

- **Search (bounded):** the game root's direct child folders plus one more level (`X\X\red4ext\...`), the CET mod folder, and the plugin
  folder with one wrapper level. Folders of the game itself (`archive`, `bin`, `engine`, `r6`, `red4ext`, `mods`, `tools`, `Support`,
  `localization`, `REDprelauncher`, `REDmod`, ...) are never searched. A candidate counts only when its
  `red4ext/plugins/AiNpcCyberpunkMod/app/` holds a marker: `local-ai/manifest.*.json` (Local AI and Mature packs),
  `local-ai/mature/`, or `omni/omni-pack.json` (OmniVoice). No recursion beyond that. Nothing to fix costs about 1 ms (a handful of stat/readdir calls).
- **Move:** only the pack folders of the misplaced `app/` (`local-ai/`, `omni/`), plus `voices/` for the OmniVoice pack (its reference clips,
  next to `app/`). Never `launcher`, `bridge` or anything else a Runtime package holds. Rename on the same volume (a folder that does not exist
  yet moves whole); on EXDEV copy, verify the size, then delete. A file already in place with the same size: the stray copy is dropped. A different
  size: both are left alone and one line says so; nothing is ever overwritten. The markers (`manifest.*.json`, `omni-pack.json`) move last, so an
  interrupted move is retried in full at the next start and a pack is never seen half-placed. Empty wrapper folders are then removed with a plain
  `rmdir` (so only when empty, only inside the candidate). Anything unexpected (permissions, a link or odd entry, a failed rename or copy) stops
  everything, leaves the rest where it is, and logs it.
- **Log:** one line per pack in `bridge-service.log` in `data/`: `Moved the <pack> files into place from <wrapper path relative to the game root>`
  (`Local AI standard`, `Local AI lite`, `Mature standard`, `Mature lite`, `OmniVoice`). No in-game notice.
- **Also handled:** `red4ext\...` or `app\...` extracted into `bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod\`, `red4ext\...`
  extracted into `red4ext\plugins\AiNpcCyberpunkMod\` (also inside one wrapper folder there).
- **Not handled:** wrappers three or more folders deep; a pack extracted outside the game folder; a pack unzipped into the wrong place by
  a single file or folder (no marker); files the player renamed; the Scripts and Runtime packages (only the optional packs are placed, because
  the launcher itself comes from the Runtime); a different file already in place (never overwritten); same-size files are trusted without
  hashing (a 5 GB model is not read); links and junctions (stop); pack files in a folder the game owns.
- **Tests:** `packaging/place-packs.test.mjs` (depth 1, 2 and 3, every pack kind, existing same-size and different-size files, nothing to fix with
  timing, game folders and non-pack folders left alone, the CET and plugin folder forms, a refused rename and its retry, EXDEV copy, a bad copy,
  and `start-service.mjs --prepare-only` end to end).

### Pre-built Mistral voice references

Voxtral (the Mistral voice) sends each character's reference clip with every request. The bridge shrinks it (mono, 24 kHz, cut to
about 8.5 s in a pause, then Ogg Vorbis quality 2 made with ffmpeg (MP3 stops at 10.5 to 11.3 kHz and sounded dull); `REFERENCE_PREPARATION` in `bridge/voxtral-reference.mjs`) and keeps the
result in `<references>/prepared`, one slot per voice key, named by a hash of the source clip and those settings. A player without
ffmpeg would send the 408 KB WAV instead of the 38 KB Ogg, so the build makes the slots itself with the bridge's own code
(`VoxtralVoice.build`, the call a conversation makes, so a change of settings there needs no change in the build) and ships them in `voices/prepared/`. `prepare-state.mjs` sets `CYBERPUNK_CONVAI_OMNI_REFERENCES` to `voices/`
for every install (the Omni worker only exists with the pack, so this cannot trip its all-or-none check), which is where the bridge
looks first.

- The **Runtime** package carries the slots for the Pocket clips, in `voices/prepared-runtime/`.
- The **OmniVoice pack** carries the slots for the clips it adds (a Mistral voice clones from the OmniVoice long clip when the pack
  is installed, else the short one, else Pocket's), in `voices/prepared/`; a slot identical to the Runtime package's is not repeated.
  A slot is keyed by the clip's hash (its signature), so the bridge (`createReferencePreparer`: `prepared/` first, then
  `prepared-runtime/`, a hit only when the signature fits) finds the right one whichever folder holds it and whatever the extraction
  order. Of the slots that fit, the best format wins (Ogg, then MP3, then WAV), so a WAV the bridge wrote on a machine without ffmpeg never
  hides the Runtime's Ogg for the same clip. With a mismatch it encodes the clip with ffmpeg (or sends the larger WAV) and writes the slot into `prepared/`; the Runtime's
  folder is never written. (Until 0.2.1 the Runtime's slots were in `prepared/` too: 289 files that the OmniVoice pack also had, with other
  bytes, which is what made Windows report 437 conflicts. See "Packs reused unchanged".)
- The build needs `ffmpeg` on `PATH` (or `CYBERPUNK_CONVAI_FFMPEG`) and fails without it. The workflow installs it.
- Slot files carry a fixed `written` time, so the same inputs give the same package.

### Packs reused unchanged

A new version rebuilds the Scripts and the Runtime, but the optional packs are several GB each, so a version that did not change them
reuses the old zips as server-side copies under the new folder (0.2.1 and 0.2.2 hold the very bytes of 0.2). The Scripts and Runtime of
the new version then meet OLD pack files in the player's game folder. If both carry a path with different bytes, Windows asks "Replace or
skip?", and "Replace" puts an older file over a newer one (0.2.1: the OmniVoice pack's older voice lists over the Runtime's newer ones).

**The rule: the Scripts and the Runtime never carry a path a published pack carries with other bytes.** Then Replace is always safe, which
is what the install steps tell the player. A file both carry must be byte for byte the same (today only the install note). Whatever the Runtime has in a newer version than the pack's copy lives at a path the pack does not
use, and the code looks there first:

| Data | The pack's path (old copy, kept as the fallback) | The Runtime's path (read first) | Code |
|---|---|---|---|
| OmniVoice lists `local-voices.autobest-short.json` and `-long.json` | `app/omni/defaults/` | `app/defaults/` | `readOmniTemplate` in `packaging/runtime/prepare-state.mjs` |
| Mistral voice slots (`<key>.json` + `<key>.ogg`) | `voices/prepared/` | `voices/prepared-runtime/` | `createReferencePreparer({shippedDirectories})` in `bridge/voxtral-reference.mjs` |

The live-list pointer is not a shipped file: `voice-configs.json` in the data folder is rewritten at every start by `prepare-state.mjs`
(Runtime), from the Runtime's list or the pack's. Nothing of it is in the Scripts. The state folder's copies of the lists are generated
from the template, so a newer template reaches the bridge at the next start.

**Updating over an older install.** Nothing deletes an earlier version's files, so "read first" must never let a leftover win:
- Every Runtime carries its own lists in `app/defaults/` (`build-release.mjs` writes them with the pack's text; `check-runtime-contents.mjs`
  fails a Runtime without them), so an older Runtime's lists there are always replaced. `readOmniTemplate` also passes over a list that names
  another OmniVoice model revision than the installed pack's `omni-pack.json` (the voice worker would refuse it), or that is not valid JSON.
- 0.2.1 left its lists in `app/omni/defaults/` (the pack's path; re-extracting the pack puts the pack's older lists back there). Either
  way `app/defaults/` wins while it names the pack's model.
- 0.2.1 left its Runtime slots (Pocket clips) in `prepared/`, and a 0.2.1 player whose extraction order let one package replace the other's
  slots has the other ones there. They are read first but used only when the signature fits, which means the same clip with the same
  settings, so the result is the same reference; the format rule above stops a cached WAV from hiding the Runtime's Ogg.

Also true, and checked: the Runtime and Scripts put nothing in a tree only the OmniVoice pack writes (`app/omni/python/`, `voicestudio/`,
`model/`); the 0.2.1 Runtime's three unused `voices/full-cast-draft/<key>/reference.wav` clips (coach-fred, jim-jarry, life-coach; the pack has them
for its older lists) are left out (`RUNTIME_DROPS`); the five packs share files only byte for byte (the Local AI and Mature engine files, the licence texts); and
the install note (`INSTALL_NOTE` in `build-release.mjs`) is the 574-byte text the Mature packs already contain, so it is fixed until
the packs are rebuilt.

**Checking a build.** `node packaging/check-pack-overlap.mjs check <zip>...` reads only the zip's directory and compares every shared path
with `packaging/pack-listings/packs-0.2.1.json` (path, size and CRC-32 of the five 0.2.1 packs); it exits 1 and groups the offenders by
folder. It reads ZIP64 directories (the OmniVoice pack is one) and also fails a zip that holds one path twice with different bytes (a
patched zip can; `ZipWriter` refuses it); a pack with a path twice cannot be listed. Run it on every Runtime and Scripts zip before upload. `packaging/pack-overlap.test.mjs` runs the same comparison on the real Scripts
build and on the 0.2.1 Runtime's shared files (`runtime-0.2.1-shared.json`, to show the cause and the fix). When the packs are
rebuilt, remake the listing from Hugging Face without downloading them (HTTP range requests: the directory of the 6.5 GB OmniVoice pack is
3.5 MB; a URL is a pack's resolve/main/<version>/<file> link on the Hugging Face page, public, no token):

```
node packaging/check-pack-overlap.mjs listing packaging/pack-listings/packs-<version>.json OmniPack=<zip or URL> LocalAI-Standard=<zip or URL> LocalAI-Lite=<zip or URL> Mature-Standard=<zip or URL> Mature-Lite=<zip or URL>
```

**Checking what a Runtime must contain.** `node packaging/check-runtime-contents.mjs <Runtime zip>...` reads only the zip's directory and fails when V's voice clips (`voices/v-voice/`: the manifest and the clips `assets/v-voice/v-voice.json` names) or the Runtime's own OmniVoice lists in `app/defaults/` are missing (the names come from `packaging/lib/runtime-required.mjs`; the 0.2 and 0.2.1 Runtimes shipped without the clips). `packaging/test-release-install.mjs` checks the same on the extracted install and loads the clips with the packaged bridge's own loader. Run it beside the overlap check on every Runtime zip before upload; `packaging/runtime-contents.test.mjs` keeps both from drifting.

**Removed in 0.2.3:** the double-click `Make support report.bat` (with its bridge entry and offline report code) is no longer built or shipped, because players are not comfortable running a batch file; the in-game report and the automatic error reports are the report paths (`packaging/support-report-packaging.test.mjs` keeps it out).

### Runtime update zip

The Runtime is about 1 GB and most of it (Python, torch, Node, the voice and lip-sync models) does not change between releases. From 0.2.3 on, every
release ships a **Runtime update zip** on Hugging Face next to the full Runtime, named `AI-NPC-Cyberpunk-Mod-Runtime-Update-<from>-to-<to>.zip` (the first:
`...-Update-0.2.2-to-0.2.3.zip`). A player who has the previous Runtime extracts it over that Runtime (Replace is safe: it holds only paths whose bytes
differ, and the packs rule above still holds); a new install, or a player on an older version, uses the full Runtime, which stays. The Scripts are
small and always full.

**What is in it.** Every file the new Runtime has and the previous one did not, or has with other bytes (path, size and CRC-32 are compared, so it does
not matter how either full zip was made); the new `app/release.json`; and `app/defaults/runtime-removals.json`, the removal list.

**Removing what a version no longer ships.** Extracting adds and replaces but never deletes, so a file the new version dropped (a renamed voice clip, a retired
model) would stay in the player's folder. The player never deletes anything: the service does, at its next start, from the list.

- **The list** is `app/defaults/runtime-removals.json`: `{"version": "0.2.3", "removes": ["red4ext/plugins/AiNpcCyberpunkMod/voices/old/clip.wav", ...]}`. Every Runtime carries
  one, the full one too (`build-release.mjs` writes it from `packaging/runtime-removals.json`, the paths declared there, empty at first, and refuses a declared path that the
  same Runtime ships or that the start step may not delete), so a full install over an old one cleans up what is declared. The update zip's list is the
  comparison's result: the paths in the previous Runtime and not in the new one, plus the new Runtime's own declared paths, plus any `--remove` given to the builder. Paths are
  relative to the folder the Runtime was extracted into (the game folder; under Mod Organizer 2 the Runtime's mod folder), forward slashes, as named in the zip.
- **Where it runs.** `packaging/runtime/apply-removals.mjs` (shipped as `app/launcher/apply-removals.mjs`), called by `start-service.mjs` after the log exists and before
  the data is prepared, at every start, also with `--prepare-only` (which reports it under `removals`). It reads the list from its own `app/defaults/`, deletes files only, never blocks the start
  beyond an 8 s budget (the rest waits for the next start; every start is cheap when everything is gone), logs ONE line per start
  (`Runtime removal list 0.2.3: 6 listed, 5 removed, 1 already gone.`) in `bridge-service.log`, is idempotent (a file that is gone is only counted) and never fails the start:
  a problem is logged. A Runtime without the module (a partial extraction) still starts.
- **What it may delete.** Only a relative path with forward slashes and no `..`, `.`, empty part, drive, colon, backslash or control character, that lies under a folder a
  Runtime installs into (`ALLOWED_ROOTS`: the plugin folder `red4ext/plugins/AiNpcCyberpunkMod/`, `red4ext/plugins/AiNpcCyberpunkModNative/`,
  `r6/audioware/CyberpunkConvai/`, and files named `convai_*` or `cyberpunk_convai_*` in `archive/pc/mod/`), and is not `PROTECTED`: the player's `launcher.ini` and `launcher.log`,
  `app/release.json`, the list itself, the optional packs (`app/omni/`, `app/local-ai/`) and a `data/` or `state/` folder in the plugin folder. The player's data folder
  (`%LOCALAPPDATA%\AiNpcCyberpunkMod`) and the CET mod folder (`bin/.../AiNpcCyberpunkMod`, with the settings and `runtime/`) are outside every allowed root. A folder is never
  deleted by name (only files; the folders a removal empties go with it, under the plugin folder, by `rmdir`, which refuses a folder that is not empty), a link that leads out of
  the Runtime's folder is not followed, and a path that is refused is counted and logged, never deleted. This goes a little beyond the plugin folder on purpose: the Runtime ships
  the archives, the reply bank and the native plugin too, and an update may drop one of them.
- **Mod Organizer 2.** The Runtime is a mod folder (`mods\<name>\red4ext\...`) that exists only virtually at the game folder, and the service runs from the REAL place of its
  own files. The install folder is therefore worked out from where `app/` is (four folders up), not from `--game-root`, so the delete is a plain delete of a plain file in the Runtime's own
  mod folder. A file with the same name in the game folder, or in another mod, is never touched (it is simply not there: counted as already gone). A Runtime that is not in the standard
  folder layout (no `red4ext/plugins/AiNpcCyberpunkMod/app` above the script) is left alone and says so in the log.

**Building it.** After the full Runtime of the new version is built:

```
node packaging/build-runtime-update.mjs --old <previous full Runtime zip> --new <new full Runtime zip> --out <folder>
```

`--old` and `--new` may be repeated for a Runtime in several zips; `--from` and `--to` name the versions (default: read from each Runtime's `app/release.json`); `--remove <path>` adds a path to the
list; `--listing <file>` or `--no-listing` chooses the optional-pack listing (default `packaging/pack-listings/packs-0.2.1.json`). It writes the zip, `<name>.files.json` (path, size, SHA-256
of every file, like the full builds) and `<name>.sha256`, prints the counts and the SHA-256, and gives the same bytes for the same inputs. A removed path that the start step may not delete
(for instance the install note in the game folder's top folder) or that an optional pack ships is left in place and printed ("left in place, not in the removal list"); that is expected and
harmless. The full Runtime of the new version carries its own removal list (the declared extras only), which the update's replaces when extracted over: the two differ by design, so
`.files.json` of the full Runtime does not list the update's version of that file. To make a full install over an old one clean up as well, copy the update's removal paths into
`packaging/runtime-removals.json` before building the full Runtime.

**Testing it.** `node --test packaging/runtime-removals.test.mjs packaging/build-runtime-update.test.mjs` (fixture zips and a fake game folder; no real Runtime). The install test has an update
mode that never touches a real game folder:

```
node packaging/test-release-install.mjs --packages <folder with the new Scripts zip, the update zip and the new Runtime's .files.json> --version 0.2.3 \
  --update-from <previous full Runtime zip> --update-from-scripts <previous Scripts zip> [--update-zip <update zip>] [--host <test-host.exe>] [--key-file <file>]
```

It extracts the previous Scripts and Runtime into the stand-in game folder, then the update zip and the new Scripts (as a player does), and starts the service (`start-service --prepare-only`). Then it
checks that the listed files existed and are gone, that the installed removal list is the update's, that every other file matches the new full Runtime's `.files.json` (paths, sizes, SHA-256), that
every file the new Runtime no longer ships is gone (or is listed as left on purpose), and that the plugin folder holds nothing else; the rest of the install test (voice, lip sync, the real launcher DLL) then
runs on that installation. The new full Runtime's zip itself is not needed, only its `.files.json`. Source of truth for the check: `packaging/lib/runtime-removals.mjs`, `packaging/runtime/apply-removals.mjs`.

### Player state (`data/`)

`data/` is `%LOCALAPPDATA%\AiNpcCyberpunkMod\data`, outside the game folder (`packaging/runtime/state-home.mjs`). Mod Organizer 2
runs the game and every process it starts (the launcher's node.exe and its Python workers included) inside its virtual file
system, USVFS, which puts every file created under the game folder into MO2's Overwrite folder; a player reported that after
the service had created its files there, CET stopped loading the mod ("cannot open init.lua"). MO2's Cyberpunk plugin maps only
the game folder (and profile-local saves), so `%LOCALAPPDATA%` is written as is, with or without MO2, Vortex or a manual install.
`runtime/` stays in the CET mod folder because CET lets Lua open files only inside its own mod folder.

### Mod Organizer 2: files that exist from the start

USVFS puts every NEW file created under the game folder in Overwrite (invisible at the next launch), while an existing real file that
is opened for writing, or replaced with `MoveFileExW(REPLACE_EXISTING)` (what `fs.rename` over an existing file does on Windows), stays
in place. So the files the game and the service must share inside the game folder are made to exist in the packages, and both sides only
ever modify or replace them (no player usvfs log was available; the design works with or without one).

- **`packaging/runtime-exchange.json`** classifies every `runtime/` file name the shipped Lua and the bridge use: `exchange` (about 70
  files; shipped as **empty placeholders in the Scripts package** by `scriptsPackage`), `state` (settings, chat history, witness
  receipts, decision ledger, add-on settings, NPC names: never shipped, an update would wipe the player's data; their writers keep the
  temp-file and backup protection, and the service keeps a copy outside the game folder, see "the player's state" below), `optional` (switch and probe files made by hand, and the knowledge-service files that the shipped bridge never
  runs: a missing file is harmless) and `elsewhere` (names that are not in the mod folder). `packaging/runtime-exchange.test.mjs` fails
  when a new `runtime/` name appears unclassified, when shipped Lua that uses exchange files calls `os.remove`/`os.rename` or names a
  `.tmp` (the three files that also write state are listed with the reason), and when the bridge deletes an exchange file.
- **Rules for code that touches an exchange file.** Lua: one `io.open(path, 'wb')`, write, close (no `.tmp`, no `os.remove`, no
  `os.rename`: Windows refuses to rename over an existing file, so the old code deleted and re-created it, which is a new file); a
  "withdrawn" or "consumed" signal is an empty file. Node: `atomicFile` (temp + rename over the placeholder) or a plain write; never
  `rm`/`unlink`. Every reader treats a missing, an empty and a half-written file as "nothing yet". This is also cheaper in the game
  thread (one `io.open` instead of open + remove + rename).
- **`launcher.log`** (opened with `CREATE_ALWAYS` by the launcher in the game process) ships empty in the Runtime package, beside
  `launcher.ini`, so it is an existing file opened for writing.
- **Help reports** (the bridge's zip reports) are written to `%LOCALAPPDATA%\AiNpcCyberpunkMod\reports` (the parent of the service's
  state folder when that folder is called `data` and sits outside the mod folder; else the old `runtime/reports`). The Help page shows
  the path the bridge published in `runtime/support-paths.json`, and `%LOCALAPPDATA%\AiNpcCyberpunkMod\data` and `...\reports` when
  nothing is published. The in-game short report (service not running) is one fixed file, `runtime/convai-report-lua.txt`, rewritten
  in place.
- **Legacy carry-over** (`migrate-legacy.mjs`): an empty file at the new place is a placeholder and takes the old content in place
  (nothing is displaced); the volatile files it purges from the new `runtime/` are emptied, not deleted.
- **Not covered:** the Lua's own temp-file, backup and swap protocol for the `state` files is unchanged (what it leaves in
  `runtime/` is kept by the service's copy, see "the player's state" below); the `.native-tmp` file of the optional native plugin's atomic write; the Audioware reply
  bank (`r6/audioware/CyberpunkConvai`) already ships its slot files and `speech.yml`, and only the transient `reply-pre-*.tmp` is new;
  `knowledge-fact-commits/<generation>.json` (run-time names; dormant); CET's own `AiNpcCyberpunkMod.log`.
- **Live check on MO2** (not done): install Scripts and Runtime physically, start the game from MO2 with the service on, talk to a
  companion, quit; Overwrite should hold only CET's `AiNpcCyberpunkMod.log` and the `state` files. Start again: the mod loads and
  talking works from the first turn.

### Mod Organizer 2: the player's state (settings, phone chats)

The `state` files cannot be shipped as placeholders (a zip extracted over an install would wipe the player's data) and, created by the
game or the service under MO2, they would not survive a launch. So the service keeps a durable copy of each in
`%LOCALAPPDATA%\AiNpcCyberpunkMod\data\game-state\` and writes it back before the game's Lua reads it. The set (`GAME_STATE_FILES` in
`bridge/game-state.mjs`, kept equal to the manifest's `state` class by a test): `settings.json`, `phone-history.json` (each with its
`.previous`), `memory-chat-resets.json`, `witness-receipts.json`, `decision-ledger.json`, `addon-settings.json` and `npc-names.json`.
`npc-names.json` belongs to the set: the Lua used to write it next to `init.lua`, outside the manifest, which under MO2 is a new file in
the mod folder's root; it is now `runtime/npc-names.json` (a store saved next to `init.lua` by an earlier version is read until one exists
there).

- **At start (Runtime package, `start-service.mjs`).** `restoreGameState` runs first, right after the layout is known (and after the check that this process can see the CET mod's `init.lua`, which stops the start before anything is written) and before the
  legacy carry-over, the data move and `prepareState`. Per file: a real, non-empty file always wins and refreshes the copy (when it is more
  than 2 s older than the copy it replaces, that copy is kept in `game-state/older/`, one slot per file); a missing or an empty file gets the
  copy written into it in place (an existing file is modified, never swapped; a missing one is created, which under MO2 lands in Overwrite
  and is visible for this session); JSON that does not parse is neither copied nor restored. A start with nothing to do is two stats per file,
  and a read only when size or time differ (a copy carries the time of the file it came from). Then it writes `runtime/state-restore.json`
  (`{version, state: "done", written, restored, refreshed, errors}`, an exchange file shipped empty in the Scripts package). Without a data
  home outside the game folder (`CYBERPUNK_CONVAI_DATA_HOME` unset and no `%LOCALAPPDATA%`) nothing is restored and no signal is written.
- **While the service runs (Runtime package, `bridge/game-state.mjs` `GameStateSync`).** The 500 ms settings poll stats each file and a
  directory watcher runs the same pass a few milliseconds after a save (`bridge/file-wake.mjs`); only a changed file is read, and it is
  copied only when it is not empty and parses (temporary file, rename, time set). A pass at shutdown copies the Lua's last save. It never
  fills a file in, never deletes a main file's copy, and drops a `.previous` copy only after it saw the backup go. On when the launcher
  sets `CYBERPUNK_CONVAI_GAME_STATE` (the copies folder; only with a data home); a development bridge does nothing.
- **Startup order, and how the restore beats the first read.** The RED4ext launcher starts the service when the game process starts;
  CET loads the mod only once the engine and its scripts are up (seconds to tens of seconds later), so the restore (a few stats and
  writes in a Node process that has just started) almost always finishes first. That is not measured, so the Lua does not rely on it
  (`mod/state-restore.lua`, a global `convaiStateRestore` that `init.lua` sets before anything reads these files): a reader that finds its
  file **missing or empty** asks `waiting()`. While it is true the reader uses defaults in memory only, saves nothing, and asks again
  later; when it turns false the file is read again. A signal counts only if it was written after this game session began
  (`os.time() - os.clock()`; the file is shipped empty and modified in place, so last session's signal is still there at the next launch).
  With no signal at all (an older Runtime, the service not started) waiting ends 120 s after the first question and the reader carries on
  as it always did. A file that is there is never waited for, and nothing is asked per frame.
  `manager.lua`: the settings stay in memory (`settingsDeferred`); `saveSettings` refuses; the next `loadSettings` after the restore reads
  the file, and `initialize` hands the restored voice, subtitle and enabled values to the game again. `phone-chat.lua`: the store is empty
  in memory (`storePending`), nothing binds to a world and nothing is saved until the restore is over, then it is read again (checked on
  the 10 Hz tick). `addons.lua`: the add-ons register with defaults, the commit refuses to write, and the saved values are merged in after
  the restore. `npc-names.lua`: a vendor name is made but not kept. Values other modules cached before a late restore (the story-talk
  setting handed to the face service in `onInit`) are not pushed again.
- **What MO2 does with it.** The service's writes into the mod folder are redirected into Overwrite and are visible during the session
  (USVFS shares the virtual tree between the processes it hooks); at the next launch the files are gone (or, if Overwrite is mapped, there
  and real), and the start-up restore settles them either way. Not measured on MO2 (see the live check below).
- **Packages.** Scripts: `mod/state-restore.lua` (new), `init.lua`, `manager.lua`, `phone-chat.lua`, `addons.lua`, `npc-names.lua`, and the
  empty `runtime/state-restore.json` placeholder. Runtime: `bridge/game-state.mjs` (new), `bridge/file-wake.mjs`, `bridge/convai-bridge.mjs`,
  `packaging/runtime/start-service.mjs`, `packaging/runtime/prepare-state.mjs`. Scripts new with Runtime old: no signal, so a first-ever
  launch (the only time a file is missing) holds the defaults for 120 s, then behaves as before. Runtime new with Scripts old: the restore
  works; an old Lua that happened to read first could save defaults, and that real file then wins (the copy it replaces is kept in `older/`).
- **Not covered.** The Lua's save protocol for these files (temp file, backup, swap) is unchanged; how USVFS treats that swap on a file
  that lives in Overwrite is unproven, and the copy is of whatever ends up on disk. A service that starts after the Lua gave up waiting
  (more than 120 s late) finds the defaults the Lua saved, and that real file wins over the copy (kept in `older/`). Two game installs on
  one Windows account share `game-state/` as they share `data/`. Deleting a state file by hand to reset it now brings the copy back at the
  next start (a missing file is what MO2 leaves behind, so the two cannot be told apart): delete the same file in `game-state/` too, or
  that whole folder.
- **Tests.** `bridge/game-state.test.mjs` (restore order, newer wins, empty files, the sync), `packaging/game-state-restore.test.mjs`
  (the launcher end to end, before the slow work, the signal), `bridge/state-restore-lua.test.mjs` (the module and the three readers),
  `bridge/npc-names.test.mjs` (the vendor file), and the manifest and package tests.
- **Live check, MO2** (not done): install Scripts and Runtime physically; start from MO2, change a setting (a voice option) and send one
  phone message, quit. Start again: the setting and the phone chat are there, and `bridge-service.log` says `Player state in runtime/: ...
  restored (...)`. Overwrite should hold only CET's log and the `state` files. Also look at `game-state/` in the data folder.
- **Live check, normal install:** the same two steps without MO2: nothing changes for the player; `game-state/` holds the copies
  (up to nine small files) and `runtime/state-restore.json` has a recent `written`.

### Mod Organizer 2: the Runtime as a mod folder

A player on the Ultraviolence modlist installed the Runtime and the Scripts as MO2 mods: no Runtime file is in the game folder, and the
game read only the launcher's `starting` in `runtime/bridge-service.json`, for good. The Runtime's real place is then a mod folder in
the MO2 instance (`mods\<name>\red4ext\plugins\AiNpcCyberpunkMod\...`); the launcher, `node.exe` and the service all reach it through
USVFS. What the start does about that (`packaging/virtual-runtime.test.mjs`, `bridge/supervisor-lock-status.test.mjs`,
`packaging/usvfs-compat.test.mjs`, `packaging/usvfs-runtime.test.mjs`):

- **The cause (live MO2 test, 2026-10-19, `deliverables/mo2/REPRO.md`).** MO2 2.5.2 (usvfs 0.5.6.1) on Windows 11 25H2, Scripts and
  Runtime 0.2.2-pre as MO2 mods: the launcher started `node.exe` (injected by usvfs, as every child of the game is) and Node ended at
  once with `Cannot find module ...\app\launcher\start-service.mjs`, exit code 1, before any line of ours ran. The bundled Node 24
  (libuv 1.52) cannot `stat`, `lstat`, `exists` or JavaScript-`realpath` a file that exists only in an MO2 mod folder (ENOENT),
  while `open`, `readFile`, `readdir`, `access` and `realpathSync.native` of the same path work; Node's entry lookup uses stat.
  Most likely libuv's stat goes through the Windows 11 24H2 `GetFileInformationByName` call, which usvfs 0.5.6.1 does not hook. The
  bundled Python 3.12 has the same stat, and usvfs also answers `GetModuleFileNameW` with the virtual path, so Python started from its
  real place still took the virtual folder for its home ("No module named 'encodings'").
- **The fix** (only inside usvfs; a physical install runs none of it, and its launcher.ini change only adds the bootstrap's one stat):
  `launcher.ini` starts Node with a bootstrap that loads `start-service.mjs` from its real place (`realpathSync.native`) when stat
  cannot see it, keeping `process.argv` as before. `start-service.mjs` finds usvfs among its loaded libraries and puts in the stat
  fallbacks of `app/launcher/usvfs-compat.mjs` before it looks at the game folder: `stat`, `lstat`, `exists`, `mkdir -p` and the
  JavaScript `realpath` fall back to an opened handle and `fstat`, `access`, and the path itself, when the plain call says ENOENT (a
  really missing file still says ENOENT). The game side (the CET mod's `runtime/`) stays at its virtual place, where the game, the
  Scripts mod, the Runtime mod and Overwrite meet; the Runtime's own files run from their real place, so Python, llama-server and the
  bridge get real paths. The optional packs are looked up at their virtual place (`app/local-ai`, `app/omni`) and used from their
  real one, so a pack installed as its own MO2 mod is found. The bridge and every Node process it starts get the same fallbacks through
  `NODE_OPTIONS=--import=<file URL of usvfs-compat.mjs>`: the supervisor drops any inherited `NODE_OPTIONS` and puts back only that one
  module, named in `CYBERPUNK_CONVAI_USVFS_IMPORT` (`usvfsCompatImport`). The bundled Pythons' `python3XX._pth` lines become absolute
  real paths (`pinPythonPaths`; the package text is kept beside it as `python3XX._pth.package`, so a moved MO2 instance is pinned
  again and an update's file is taken as the new package text). The `View:` line says `(stat fallbacks on)` and
  `the Runtime is in an MO2 mod folder (<real app>, started as <virtual app>)`.
- **Packs and MO2.** The Local AI and OmniVoice packs work as their own MO2 mods (their roots are resolved separately); the OmniVoice
  pack's voice clips under `voices/` are found only when that pack is merged into the Runtime's MO2 mod (or installed in the game folder),
  because `voices/` is read from the Runtime's real folder.

- **No path comparison on the start path.** `installLayout` (`prepare-state.mjs`) takes the game's folders from `--game-root` and the
  Runtime's from the script's own place; nothing resolves a link or compares a resolved path with the game root.
  `packaging/runtime-layout.mjs` (`realpath`, "cannot redirect into another location") belongs to the bootstrap route
  (`Runtime-Service.mjs`), which `launcher.ini` never starts. The voice workers' checks (`pocket-voice.mjs`, `phone-analysis-config.mjs`,
  `resident-voice.mjs`) canonicalize both sides alike and run only once the bridge is up.
- **A start never ends without a status.** `start-service.mjs` writes `runtime/bridge-service.json` from its first line, in place:
  `starting` / `service-starting` with `source: "service"`, the `stage` it is in (`loading-modules`, `preparing`, `placing-packs`,
  `preparing-state`, `loading-supervisor`) and a `view` (`usvfs no; Runtime outside the game folder; init.lua visible`, so the short
  report carries what the service sees), refreshed every 5 s for at most 5 minutes while it prepares. Its own modules load inside a
  guard, and an error nobody caught ends in `failed` with a `reason`: `install-incomplete` (a file is missing or cannot be read),
  `service-error`, `game-folder-not-visible`. The reason is Node's error code and message with every path cut to its file name, 140
  characters at most. The supervisor writes its own `starting` as soon as it holds the previous session's lock; a wait for that lock
  keeps the start script's last status for 5 s and then says `waiting-for-previous-service` (kept fresh by the heartbeat); its crash
  status carries a reason too.
- **Only the running game's processes write the status.** A player who restarts the game at once (what the failure notice tells them)
  starts the next session while the previous one is still stopping. Every writer puts its game's PID in the file (`gamePid`): a start
  script whose game has ended publishes nothing more (`--game-pid` is checked as the supervisor checks it), and a supervisor whose game
  has ended still reports `stopping` and `stopped` unless the file already holds another game's PID, which it then leaves alone (one
  log line). A failure of the new session's start is therefore not hidden behind the old session's stop
  (`packaging/virtual-runtime.test.mjs`, `bridge/supervisor-lock-status.test.mjs`).
- **The service must see what the game sees.** The launcher starts the service only after it saw the CET mod's `init.lua`; a service
  that cannot see it runs outside the virtual file system (or in another one), and nothing it writes under the game folder would reach
  the game. It logs that and stops (`game-folder-not-visible`, exit code 3) without creating a folder in the game folder. Its first log
  line, `View:`, says whether usvfs is loaded in the process, where the Runtime is relative to the game, and whether `init.lua` and
  `runtime/` are visible.
- **The game says what it can see** (`mod/service-status.lua`, Scripts only, works with any Runtime). A `starting` that only the launcher
  or the start script wrote (`source` `launcher` or `service`) and nothing refreshed is a service coming up for 90 s and a service that
  never came up after that: kind `failed`, code `service-silent`. The notices (the one-time notice, a blocked talk, a request the
  service dropped) keep the plain sentence "could not start. Restart the game, or see Help in Settings.": they are the game's warning
  line, which holds two lines, and that sentence fills them (docs/NOTIFICATIONS.md, "How much a notice can say"). The Help page's
  Conversation service row names the code (`could not start (service-silent)`), and the status's own words, in English, are in
  `failureDetail()` and the rows that have room (`message(kind, detail)`): `service-silent after launcher-started`,
  `install-incomplete at loading-modules: ERR_MODULE_NOT_FOUND: ...`. The short report's second line is
  `PROBLEM: the conversation service did not come up (...)` with those words and where the logs are, and its `service status` section
  prints `stage` and `reason`.
- **Where to look.** `%LOCALAPPDATA%\AiNpcCyberpunkMod\data\bridge-service.log` (the `View:` line; the data home does not depend on MO2),
  `bridge.stderr.log` beside it, and `launcher.log`: in the Runtime mod's folder (`mods\<Runtime mod>\red4ext\plugins\AiNpcCyberpunkMod\`)
  because the packaged one is an existing file, or in `overwrite\red4ext\plugins\AiNpcCyberpunkMod\` when the Runtime has none. The
  launcher takes `%PLUGIN%` from `GetModuleFileNameW` of its own DLL, which usvfs answers with the virtual path (seen in the MO2 test);
  both work while the service is inside the virtual file system, and only the real one when it is not.
- **Not done:** the launcher (native, `CyberpunkConvaiLauncher.c`) cannot say that the process it started ended at once, or with what
  code; that needs a watcher thread and a rebuilt DLL (the MO2 cause above was found from the usvfs debug log and a probe instead). A
  service that runs outside the virtual file system cannot be made to talk to the game by the Runtime alone. Under MO2 the launcher's
  `CREATE_BREAKAWAY_FROM_JOB` is refused (MO2 keeps its own job) and it falls back to a plain start, which is fine.

### Player state (`data/`), continued

- **Override:** `CYBERPUNK_CONVAI_DATA_HOME` (an absolute path) is the folder that holds `data/`, for development or a player who
  wants it elsewhere; a relative value is ignored (one line in `bridge-service.log`). Without `%LOCALAPPDATA%` the data stays in the
  game folder as before. Two game installs on one Windows account share the folder; the generated files are rewritten on every start.
- **Move from the game folder** (`moveGameFolderState`, run by `start-service.mjs` after the old-name carry-over and before
  `prepareState`; one lstat when there is nothing to move). All or nothing: every state file is copied into a staging folder beside
  the new `data/` and verified (size and SHA-256); only then are the copies put in place and the originals removed. Any failure
  (a full disk, an unreadable file, a lock still held by a service from the previous session) leaves the old folder untouched and
  this start uses it; the next start tries again. Generated files and `lipsync-model/` are not copied (they are written fresh),
  volatile files (`*.lock`, `*.pid`, `*.tmp`, `bridge-control.json`) are dropped. When both folders have a file with different
  content the newer one is used and the other goes to `moved-from-game-folder/<time>-replaced|older/`; nothing is deleted
  unverified. The result is one line in `bridge-service.log` and `moved-from-game-folder.json` in the new `data/`.
- **Tests:** `packaging/state-home.test.mjs` (location rules, the move with conflicts, a failed copy, a held lock, and
  `start-service.mjs --prepare-only` end to end); every test that runs `start-service.mjs` sets `CYBERPUNK_CONVAI_DATA_HOME` to a
  temporary folder, so the real `%LOCALAPPDATA%` is never written by tests.


- **Generated, refreshed every start:** `pocket-voices.autobest.json` (absolute paths for this
  install), the two OmniVoice configs (with the pack; from the Runtime's `app/defaults/`, else the pack's `app/omni/defaults/`), `voice-configs.json`, `lipsync-model/`.
- **Managed until edited:** `characters.json` and
  `multilingual-profiles.json` follow the package; once the player edits one it is kept
  (`package-defaults.json` remembers what was written).
- **Player-owned, never touched:** memories, sessions, phone history, settings, logs, and an own
  `convai-key.txt`.

The Convai key is built into the Runtime package at `app/defaults/service.txt` from the
`CONVAI_API_KEY` secret. A valid `data/convai-key.txt` (format `api-key = ...`) always wins, so
anyone can use their own account (with their own `characters.json`). Do not describe the built-in
key in player-facing text. The key is stored scrambled (`convai-key-v1 ...`, not an `api-key = ...` line;
`bridge/key-codec.mjs`) and the bridge limits turns on that key per day (docs/OWN_CONVAI_KEY.md, "Daily limit on the shared plan").

### Carry-over from the old name (CyberpunkConvai)

The mod was called Cyberpunk Convai before 0.2: its folders were `mods/CyberpunkConvai`, `red4ext/plugins/CyberpunkConvai` and
`red4ext/plugins/CyberpunkConvaiNative`. No build under that name was ever public (0.1 was a private test), so player text
says nothing about updating and the packages carry nothing under the old name. The carry-over below exists for the
developer's and private testers' installs; on a player's machine it finds no old folder and costs a few stat calls.

- **Phase A, `adoptLegacyInstall`** (`packaging/runtime/migrate-legacy.mjs`, called by `start-service.mjs` before the data folder is
  read; a few stat calls when there is no old folder). It retires the old copy first (`init.lua` and the DLLs renamed to
  `*.migrated`), then moves the player state into the new folders: rename, or copy plus SHA-256 verification when a rename is
  refused, and the source is removed only after verification. State files (settings, keys, memories, phone history) keep the OLD
  content and the displaced new file goes to `data/legacy-migration/replaced/<tag>/`; package files (packs, voices, `native-off.txt`)
  keep the NEW content; unknown leftovers go to `data/legacy-migration/leftovers/`. Logs, locks, pids and live service files
  are not carried. CET's `bindings.json` key is renamed textually (the numbers exceed 2^53) after a `.pre-ai-npc-rename.bak` copy.
  The report is `data/legacy-migration.json`.
- **Phase B, `cleanupLegacyInstall`** runs 45 s after the start, off the main path, and deletes the old folders. A folder that had
  errors in phase A, or a locked file, only postpones the removal to the next start; nothing is deleted before it was verified.
- **Dev machines:** `scripts/Migrate-LegacyInstall.mjs --game <folder> [--dry-run]` runs both phases at once (it refuses while the
  game runs) and `scripts/Install-DevelopmentMod.ps1` calls it first.
- **Tests:** `packaging/migrate-legacy.test.mjs` (fake game folder with old-folder state, conflicts, copy fallback, failed
  verification, locked files, bindings, and an end-to-end `start-service.mjs --prepare-only`) and `packaging/test-release-install.mjs`.
- Kept on purpose under the old name: `r6/scripts/CyberpunkConvai` and `r6/audioware/CyberpunkConvai` (redscript compiles before
  RED4ext, so a renamed folder would give duplicate classes on an update-over install).

## Building

`packaging/build-release.mjs` packages a git commit (default `HEAD`, exported with
`git archive` and `core.autocrlf=false`), never the working tree, so uncommitted work cannot slip
into a release. Inputs:

- `packaging/release.config.json`: pinned toolchain URLs and SHA-256 values (Node 24.21.0,
  CPython 3.12.10 and 3.11.9 embeddable, pocket-tts and
  VoiceStudio revisions, every OmniVoice model file), package layout and limits.
- `packaging/python/*.lock.txt`: every wheel by URL and SHA-256, installed with `--no-deps
  --require-hashes --only-binary=:all:` for the target platform. pip's generated console-script
  launchers, `__pycache__`, torch headers, link libraries and CMake files are left out.
- `packaging/release-data/`: the default character-ID mappings and the three game archives
  (built from game files with WolvenKit, so CI cannot make them).
- Trained models from the private HF bucket `alystria-ai/cyberpunk-pocket-rolling-checkpoints`,
  `final/` (`packaging/fetch-models.py`, every file checked against `final/MANIFEST.json`), or from
  the developer `runtime/` folder with `--models local`. The Pocket export is also checked against
  the hashes in its voice config, and every reference clip against its descriptor.
- The launcher, compiled from `native/autostart` with MSVC (`/Brepro`, reproducible), and the native plugin from `native/core`
  (`--native PATH` supplies a prebuilt DLL, `--no-native` omits it).
- `ffmpeg`, for the pre-built Mistral voice references.
- The Local AI files (llama.cpp release zip, embedding model, chat models), downloaded from their pinned URLs (no secret needed). The Mature packs use the same llama.cpp zip and embedding model, so those two small files are fetched once for both kinds of pack.
- The optional Mature packs' models (`--packages mature-lite` or `mature-standard`, never in the default set; only the model of the pack being built), from the private bucket's `mature/` mirror
  (`packaging/fetch-models.py --mature --tier lite|good`, SHA-256 checked against `maturePack.tiers`, so a takedown of the community repositories cannot break a build), or from
  their pinned public Hugging Face URLs when the mirror lacks them. `--models local` reads the developer folder instead. `mature/` is outside `final/`, so the
  trained-model fetch never downloads it.

Archives are deterministic (`packaging/lib/zip.mjs`): sorted entries, one timestamp (the commit
time), fixed deflate level, weights stored. The Scripts and Runtime archives each stay under 1.95 GB (GitHub's limit is
2 GiB per asset), a Runtime archive that would pass it rolls over to a `-partNofM` zip, and a single file over that limit stops the build
(nothing is split inside a file any more). The optional packs are always one zip each, written as ZIP64 where needed (`--packages omni`,
`localai-standard`, `localai-lite`, `mature-lite`, `mature-standard`, `micpack-european`, `micpack-asian`). Output:
`dist/release/packages/` with the zips, `*.files.json` (every file's size and SHA-256),
`SHA256SUMS.txt` and `release-manifest.json`.

### Local dry run and install test

```powershell
node packaging/build-release.mjs --version 0.2 --dry-run                 # all five packages
node packaging/build-release.mjs --version 0.2 --dry-run --packages scripts,runtime
node packaging/build-release.mjs --version 0.2 --dry-run --packages localai-standard,localai-lite
node packaging/test-release-install.mjs --version 0.2 --packages dist/release/packages [--omni] [--local-ai] [--key-file runtime/convai-key.txt]
node --test packaging/release.test.mjs
```

The dry run uses the developer `runtime/` models and embeds no key. The install test builds a
stand-in game folder under `%TEMP%` (spaces and non-ASCII in the path), extracts with
`Expand-Archive`, checks every file, then with a PATH of Windows folders only: speaks with the
Pocket voice from the packaged Python, recognises that speech again with the local speech-to-text
worker (packaged Python and `models/stt`), runs the lip-sync model on that audio (and OmniVoice on the
GPU with `--omni`), and loads the real launcher DLL through `native/autostart/test-host.c`, which
must start the packaged service and stop it when the "game" exits. With `--key-file` the key is
copied as the player's own key (never printed) and the bridge must report Ready. Never point it at
the real game folder; it always makes its own.

To try a build in the real game, remove the development launcher first
(`scripts/Uninstall-BridgeAutostart.ps1`), or both launchers start a service.

## GitHub Actions

`.github/workflows/release.yml` runs only from Actions > Release > Run workflow or on a pushed
`v0.N` tag. Job 1 builds and install-tests Scripts + Runtime on `windows-2022` (Visual Studio 2022; `windows-2025` moved to Visual Studio 2026), keeps the Scripts
zip as a workflow artifact (for Nexus), and creates the GitHub release `v0.N` in this same
repository, uploading the packages to it. Job 2 builds the OmniVoice pack and job 3 (a matrix of `standard` and `lite`) the two Local AI
packs; each uploads its zip to the Hugging Face repository `alystria-ai/ai-npc-cyberpunk-mod-packs` (below), not to the GitHub release. Large packages are not stored as workflow artifacts (private-repository artifact storage
is small).

The release is published immediately, not left as a draft (the manual run has a `publish` switch
to skip release creation). While the repository is private, only collaborators can see the release
and its downloads; it becomes visible to everyone when the repository is made public. A manual run
tags the commit it was started from. The optional packs arrive on Hugging Face a while after the Runtime
package is released, because they are built by later jobs. If `v0.N`
already exists, the workflow only re-uploads (`--clobber`) and leaves its title and notes alone.
A new release is created with `--latest`, so the newest build is always marked Latest whatever GitHub's own ranking says.

**Hugging Face upload.** The omni, localai and mature jobs install `huggingface_hub`, check first (`packaging/upload-packs.py --check`) that the `HF_TOKEN` secret can write to the repository, build their pack, and upload it with `packaging/upload-packs.py --version V --pack NAME --packages DIR` (`HfApi.upload_file`, retried, then checked against the local size). The zip goes to `V/<file>.zip` and the build's checksums to `V/SHA256SUMS-NAME.txt` in the same folder. A token that cannot write fails with a message naming the repository and saying the `HF_TOKEN` secret needs write access to it. The uploader refuses a build with more than one zip. The `publish` input also gates these uploads on a manual run (a tag run always uploads).

The optional Mature packs are built by the `mature` job, a matrix of `lite` and `standard` (one runner each; the standard pack carries the model whose tier key is `good`), that runs only when the manual run's `mature` input is ticked (default off; never on a tag push, never uploaded to Nexus or to the GitHub release). Each builds with `--packages mature-lite` or `mature-standard` `--models hf` from the bucket mirror and uploads its zip to Hugging Face. They can also be built and uploaded by hand: `node packaging/build-release.mjs --version 0.N --packages mature-lite` then `python packaging/upload-packs.py --version 0.N --pack mature-lite --packages dist/release/packages`.

The two optional voice-input packs are built by the `micpacks` job, a matrix of `european` and `asian`, that runs only when the manual run's `micpacks` input is ticked (default off; never on a tag push; Hugging Face only). Each builds with `--packages micpack-european` or `micpack-asian` (no secret, no `--models`: the files come from the pinned download) and uploads its zip like the others.

Permissions and secrets: the workflow uses the built-in `GITHUB_TOKEN` with `contents: write`
(no separate releases repository or token). Repository secrets: `HF_TOKEN` (bucket read, and write access to the pack repository) and
`CONVAI_API_KEY`. GitHub masks secrets in logs; the builder also masks the parsed key and never
prints it. The workflow requests `contents: write` itself, so the repository's default workflow
permission can stay read-only.

## Keeping the inputs current

- Mature pack models (lite and good): mirrored under `mature/` in the bucket with a `mature/MANIFEST.json` (path, size, SHA-256); re-mirror them if `maturePack.tiers` changes.
- New models or voice configs: upload them to the bucket's `final/` and update
  `final/MANIFEST.json` (the build only accepts files listed there). `--models local` builds from
  `runtime/` before that.
- New character IDs or rebuilt archives: `node packaging/Refresh-ReleaseData.mjs`, review, commit.
- Python versions: edit `packaging/python/<name>.in`, run `python packaging/python/lock.py <name>`.
- Node, Python: change URL, version and SHA-256 in `release.config.json`.
- Lua files that must not ship: `devOnlyLua` in the config. The build fails if a shipped file
  loads one without a guarded `pcall`.

## Not shipped

Tests, fixtures, research scripts and caches, training data and notebooks, benchmark audio,
`misc/` (developer launchers and benchmark runs), `vendor/`, developer `runtime/`, backups, keys and tokens, the development-only Lua files
(`diagnostics.lua` and the probes it loads, `face-test.lua`, `gesture-probe.lua`), the retired
`KnowledgeState.reds`, Rhubarb (only a last fallback behind the lip-sync model) and the resident
phone analyser (not started when the lip-sync model is present).

## Licences to keep in view

The project's own code is under the AI NPC Cyberpunk Mod Use License (`LICENSE`, modelled on the
licence of the AI NPC Companions System for The Blood of Dawnwalker in the same GitHub
organisation): free use, modification and redistribution, provided distributed modified versions
with AI character conversations keep a selectable Convai option. It is source-available, not
OSI-approved. Each package ships it as `LICENSE.txt` (Scripts: the mod folder; Runtime: the
plugin folder; OmniVoice: `app/omni`), and the Runtime and Omni packages carry
`THIRD-PARTY-NOTICES.txt`, generated by the build. `THIRD_PARTY_NOTICES.md` at the repository
root states the same facts for readers of the repository, and the Runtime package copies it to
`app/licenses/`. Keep both in step when a component, version or licence changes.

Component facts: VoiceStudio is AGPL-3.0-only (the pack carries its licence and the source
location). OmniVoice weights are CC-BY-NC and its audio tokenizer uses the Boson Higgs Audio 2
Community License; both licence files ship with the pack. No browser ships: the hidden browser is the player's Microsoft Edge, else Google Chrome, else another installed Chromium browser (see "How it starts" below). The speech-recognition model is Moonshine Tiny (MIT) run by sherpa-onnx (Apache-2.0); see docs/LOCAL_STT.md. Pocket TTS code is MIT and its
weights CC-BY-4.0 (gated on Hugging Face, with a prohibited-use clause covering voice cloning
without consent); the notices carry the attribution and the change statement the shipped model
needs. The lip-sync lexicon (CMUdict, BSD-2-Clause, plus espeak-ng-generated game words) ships
with its notice. The reference voice clips and the game archives are Cyberpunk 2077 material and
are outside the project licence.

## Superseded

The earlier design in `packaging/release-plan.json`, `packaging/runtime-layout.mjs`,
`runtime-bootstrap.mjs`, `Runtime-Service.mjs`, `Start-Runtime.ps1`, `Create-RuntimeManifest.mjs`
and `RUNTIME_BOOTSTRAP.md` (with `bridge/packaging-plan.test.mjs` and
`packaging/runtime-bootstrap.test.mjs`) is not used by the release build. It stays only until its
tests are removed from `package.json`.
