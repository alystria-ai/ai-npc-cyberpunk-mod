# Release packaging (developer notes)

How the player release is built, what it contains and how it starts. Players read
`packaging/PLAYER_README.md` instead (it ships in every package and is the release notes).

## The packages

| Package | Where players get it | Contents |
|---|---|---|
| `AI-NPC-Cyberpunk-Mod-Scripts-<v>.zip` | Nexus Mods | Text only: the CET Lua mod, redscript, the four JSON catalogs the Lua reads, `README.txt` and `release.json`. |
| `AI-NPC-Cyberpunk-Mod-Runtime-<v>.zip` | GitHub release of this repository | Everything else needed to play: the RED4ext launcher, bundled Node and Python, the bridge, the Pocket voice and lip-sync models, voice references, game archives and the Audioware reply bank. |
| `AI-NPC-Cyberpunk-Mod-OmniPack-<v>.zip` | Hugging Face | Optional OmniVoice pack, one zip: CUDA Python environment, the VoiceStudio adapter, the OmniVoice model and the OmniVoice references. |
| `AI-NPC-Cyberpunk-Mod-LocalAI-Standard-<v>.zip` | Hugging Face | Optional Local AI pack with Gemma 4 E4B (about 5.3 GB), one zip: the llama-server Vulkan build, the embedding model and the chat model, whole. |
| `AI-NPC-Cyberpunk-Mod-LocalAI-Lite-<v>.zip` | Hugging Face | Optional Local AI pack with Bonsai 2 4B (about 1.4 GB), the same server and embedding model. |
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
Mod Configuration Menu): the Runtime package's launcher and native plugin are RED4ext plugins. The large,
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
  launcher.ini               UTF-16: %PLUGIN%\app\node\node.exe app\launcher\start-service.mjs
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
    defaults/                templates and managed defaults copied into data/ at start-up
    launcher/                start-service.mjs, prepare-state.mjs, assemble-parts.mjs, migrate-legacy.mjs, place-packs.mjs
    licenses/                third-party notices (Python packages keep theirs in *.dist-info)
    omni/                    the OmniVoice pack, when installed
    local-ai/                the Local AI pack(s), when installed (llama/, models/, licenses/, manifest.*.json)
  voices/                    reference clips (outside app/: the Omni worker requires it)
    prepared/                the Mistral voice's references, already cut and encoded (see below)
red4ext/plugins/AiNpcCyberpunkModNative/
  CyberpunkConvaiNative.dll  the native core plugin (native/core, compiled in the build) and its licence texts
bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod/
  *.lua, locales/, *.json    Scripts package
  data/                      player state, created on first start
  runtime/                   Lua <-> bridge exchange files
    native-off.txt           which native systems stay off (Runtime package, see below)
r6/scripts/CyberpunkConvai/  redscript (Scripts package)
r6/audioware/CyberpunkConvai speech.yml + eight silent reply slots (Runtime)
archive/pc/mod/              convai_facial, convai_gestures, cyberpunk_convai_ambient_driver_guard (Runtime)
```

RED4ext loads DLLs only from `red4ext/plugins/*.dll` and `red4ext/plugins/<name>/*.dll`
(PluginSystem.cpp stops at depth 1), so the Python, torch and Chrome DLLs under `app/` are never
loaded into the game. Keeping the application there also keeps paths short: the build refuses any
entry whose game-relative path would exceed 255 characters under a 70-character game folder
(the default Steam path is 61). Windows' built-in zip extractor fails beyond 260.

## How it starts

1. RED4ext loads `CyberpunkConvai.dll`. It checks that CET and the CET mod are present, reads
   `launcher.ini` and starts `app\node\node.exe app\launcher\start-service.mjs` hidden, with a pipe
   whose closing tells the service that the game ended.
2. `start-service.mjs` prepares `data/` (below), joins split files left by an earlier release on the first start
   (verifying their SHA-256; current packs have none), and sets every path explicitly:
   `CYBERPUNK_CONVAI_CLIENT_ASSETS`, the four `CYBERPUNK_CONVAI_OMNI_*`
   paths and `CYBERPUNK_CONVAI_PYTHON` when the pack is installed, the key file and state folder.
   It clears inherited `NODE_OPTIONS`, `PYTHONPATH` and similar overrides. Nothing is looked up on PATH. The one thing the package
   does not carry is a browser: the bridge's hidden browser is the Microsoft Edge that Windows 10 and 11 include, else an installed
   Google Chrome (`bridge/system-browser.mjs`; a developer's `CYBERPUNK_CONVAI_BROWSER` still names an executable instead).
   Chrome for Testing was bundled in 0.2 until Hugging Face's virus scanner flagged its `chrome.dll` (a false positive). If neither
   browser is installed the supervisor reports `browser-missing` (the in-game "service could not start" notice, one line in
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
- **Log:** one line per pack in `data/bridge-service.log`: `Moved the <pack> files into place from <wrapper path relative to the game root>`
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

- The **Runtime** package carries the slots for the Pocket clips.
- The **OmniVoice pack** carries the slots for the clips it adds (a Mistral voice clones from the OmniVoice long clip when the pack
  is installed, else the short one, else Pocket's); a slot identical to the Runtime package's is not repeated. A slot is keyed by the
  clip's hash, so a key whose clip differs overwrites the Runtime's. Extract the Runtime first and the OmniVoice pack second; the
  other order only costs an ffmpeg re-encode (or the larger WAV) for those keys until the bridge rewrites the slot.
- The build needs `ffmpeg` on `PATH` (or `CYBERPUNK_CONVAI_FFMPEG`) and fails without it. The workflow installs it.
- Slot files carry a fixed `written` time, so the same inputs give the same package.

### Player state (`data/`)

- **Generated, refreshed every start:** `pocket-voices.autobest.json` (absolute paths for this
  install), the two OmniVoice configs (with the pack), `voice-configs.json`, `lipsync-model/`.
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
`localai-standard`, `localai-lite`, `mature-lite`, `mature-standard`). Output:
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
Community License; both licence files ship with the pack. No browser ships: the hidden browser is the player's Microsoft Edge, else Google Chrome (see "How it starts" below). The speech-recognition model is Moonshine Tiny (MIT) run by sherpa-onnx (Apache-2.0); see docs/LOCAL_STT.md. Pocket TTS code is MIT and its
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
