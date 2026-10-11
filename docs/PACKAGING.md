# Release packaging (developer notes)

How the player release is built, what it contains and how it starts. Players read
`packaging/PLAYER_README.md` instead (it ships in every package and is the release notes).

## The three packages

| Package | Where players get it | Contents |
|---|---|---|
| `CyberpunkConvai-Scripts-<v>.zip` | Nexus Mods | Text only: the CET Lua mod, redscript, the four JSON catalogs the Lua reads, `README.txt` and `release.json`. |
| `CyberpunkConvai-Runtime-<v>.zip` | GitHub Releases of this repository | Everything else needed to play: the RED4ext launcher, bundled Node, Chrome for Testing and Python, the bridge, the Pocket voice and lip-sync models, voice references, game archives and the Audioware reply bank. |
| `CyberpunkConvai-OmniPack-<v>-partNofM.zip` | GitHub | Optional OmniVoice pack: CUDA Python environment, the VoiceStudio adapter, the OmniVoice model and the OmniVoice references. |

Why this split: Nexus Mods scans every upload and holds files that its scanners flag for manual
review (help.nexusmods.com articles 128 and 117); it has no blanket rule against DLLs or
executables, but a text-only file never needs that review and is never quarantined. The large,
binary runtime goes to GitHub Releases as plain zips, which is how the core frameworks
(RED4ext, Codeware, TweakXL, Audioware) are distributed too; RED4ext also builds in Actions and
publishes SHA-256 values with each release, which this pipeline does as well.

All three use game-root-relative paths and merge into one install. Versions must match;
`app/launcher/start-service.mjs` logs a warning when the Scripts `release.json` differs from the
Runtime one.

## Version numbers

Releases are numbered `0.N`: 0.1, 0.2, 0.3, ..., and a hotfix of one release is `0.N.M` (0.2.1).
The first build, `v2077.1` (2026-10-07, a private-repository test of the pipeline), used the earlier
`2077.N` scheme and stays as it is; the version check still accepts that form. The tag is `v` + the
number (`v0.2`) and the workflow accepts both forms (`v0.2`, `v0.2.1`); a manual run takes the number
without the `v`. The same string goes into the package file names (`CyberpunkConvai-Scripts-0.2.zip`), the release title, both
`release.json` files and the OmniVoice `omni-pack.json`. The only version check at run time is
`start-service.mjs` comparing the Scripts and Runtime strings for equality, so any form works; the
builder accepts two to four numbers with an optional `-pre`/`+build` suffix
(`packaging/lib/version.mjs`, guarded by `release.test.mjs`), and writes a three-part form
(0.2.0) only into `app/package.json`, which npm-style tooling wants as semver. The installed-layout
tool `test-release-install.mjs` matches package files by exact version, so 0.2 never picks up
0.2.1 or 0.20.

## Installed layout

```
red4ext/plugins/CyberpunkConvai/
  CyberpunkConvai.dll        launcher (native/autostart, compiled in the build)
  launcher.ini               UTF-16: %PLUGIN%\app\node\node.exe app\launcher\start-service.mjs
  app/                       the application, replaced by every update
    node/node.exe            official Node.js (node.exe and LICENSE only)
    browser/chrome-win64/    official Chrome for Testing, the build Playwright 1.58.2 targets
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
    launcher/                start-service.mjs, prepare-state.mjs, assemble-parts.mjs
    licenses/                third-party notices (Python packages keep theirs in *.dist-info)
    omni/                    the OmniVoice pack, when installed
  voices/                    reference clips (outside app/: the Omni worker requires it)
bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai/
  *.lua, locales/, *.json    Scripts package
  data/                      player state, created on first start
  runtime/                   Lua <-> bridge exchange files
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
2. `start-service.mjs` prepares `data/` (below), joins split OmniVoice files on the first start
   after extraction (verifying their SHA-256), and sets every path explicitly:
   `CYBERPUNK_CONVAI_BROWSER`, `CYBERPUNK_CONVAI_CLIENT_ASSETS`, the four `CYBERPUNK_CONVAI_OMNI_*`
   paths and `CYBERPUNK_CONVAI_PYTHON` when the pack is installed, the key file and state folder.
   It clears inherited `NODE_OPTIONS`, `PYTHONPATH` and similar overrides. Nothing is looked up on PATH.
3. It then runs the development supervisor unchanged (`bridge/bridge-supervisor.mjs`): one bridge
   per game session, crash restarts, the status file the in-game Help page reads, and a graceful
   stop when the game exits. `--prepare-only` stops after step 2 and prints a summary.

The embedded Pythons use their `._pth` file (`Lib\site-packages`, `..\bridge`, `import site`), so
they ignore any Python installed on the machine.

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

## Building

`packaging/build-release.mjs` packages a git commit (default `HEAD`, exported with
`git archive` and `core.autocrlf=false`), never the working tree, so uncommitted work cannot slip
into a release. Inputs:

- `packaging/release.config.json`: pinned toolchain URLs and SHA-256 values (Node 24.21.0,
  CPython 3.12.10 and 3.11.9 embeddable, Chrome for Testing 145.0.7632.6, pocket-tts and
  VoiceStudio revisions, every OmniVoice model file), package layout and limits.
- `packaging/python/*.lock.txt`: every wheel by URL and SHA-256, installed with `--no-deps
  --require-hashes --only-binary=:all:` for the target platform. pip's generated console-script
  launchers, `__pycache__`, torch headers, link libraries and CMake files are left out.
- `packaging/release-data/`: the default character-ID mappings and the three game archives
  (built from game files with WolvenKit, so CI cannot make them).
- Trained models from the private HF bucket `akshitireddy/cyberpunk-pocket-rolling-checkpoints`,
  `final/` (`packaging/fetch-models.py`, every file checked against `final/MANIFEST.json`), or from
  the developer `runtime/` folder with `--models local`. The Pocket export is also checked against
  the hashes in its voice config, and every reference clip against its descriptor.
- The launcher, compiled from `native/autostart` with MSVC (`/Brepro`, reproducible).

Archives are deterministic (`packaging/lib/zip.mjs`): sorted entries, one timestamp (the commit
time), fixed deflate level, weights stored. Each archive stays under 1.95 GB (GitHub's limit is
2 GiB per asset) and 65,535 entries; files over 1 GB (only OmniVoice's 2.45 GB `model.safetensors`)
are split into `.partN` byte ranges with a `.parts.json`, joined on first start. Output:
`dist/release/packages/` with the zips, `*.files.json` (every file's size and SHA-256),
`SHA256SUMS.txt` and `release-manifest.json`.

### Local dry run and install test

```powershell
node packaging/build-release.mjs --version 0.2 --dry-run                 # Scripts + Runtime + Omni
node packaging/build-release.mjs --version 0.2 --dry-run --packages scripts,runtime
node packaging/test-release-install.mjs --version 0.2 --packages dist/release/packages [--omni] [--key-file runtime/convai-key.txt]
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
`v0.N` tag. Job 1 builds and install-tests Scripts + Runtime on `windows-2025`, keeps the Scripts
zip as a workflow artifact (for Nexus), and creates the GitHub release `v0.N` in this same
repository, uploading the packages to it. Job 2 builds the OmniVoice pack and adds it to the same
release. Large packages are not stored as workflow artifacts (private-repository artifact storage
is small).

The release is published immediately, not left as a draft (the manual run has a `publish` switch
to skip release creation). While the repository is private, only collaborators can see the release
and its downloads; it becomes visible to everyone when the repository is made public. A manual run
tags the commit it was started from. The OmniVoice pack arrives a while after the Runtime
package, because it is built by the second job, so a release can briefly lack it. If `v0.N`
already exists, the workflow only re-uploads (`--clobber`) and leaves its title and notes alone.
A new release is created with `--latest`: GitHub otherwise ranks "Latest" by version number as well as date, and `v0.2` is lower than the legacy `v2077.1`.

Permissions and secrets: the workflow uses the built-in `GITHUB_TOKEN` with `contents: write`
(no separate releases repository or token). Repository secrets: `HF_TOKEN` (bucket read) and
`CONVAI_API_KEY`. GitHub masks secrets in logs; the builder also masks the parsed key and never
prints it. The workflow requests `contents: write` itself, so the repository's default workflow
permission can stay read-only.

## Keeping the inputs current

- New models or voice configs: upload them to the bucket's `final/` and update
  `final/MANIFEST.json` (the build only accepts files listed there). `--models local` builds from
  `runtime/` before that.
- New character IDs or rebuilt archives: `node packaging/Refresh-ReleaseData.mjs`, review, commit.
- Python versions: edit `packaging/python/<name>.in`, run `python packaging/python/lock.py <name>`.
- Node, Python, Chrome: change URL, version and SHA-256 in `release.config.json` (Chrome must match
  `node_modules/playwright-core/browsers.json`).
- Lua files that must not ship: `devOnlyLua` in the config. The build fails if a shipped file
  loads one without a guarded `pcall`.

## Not shipped

Tests, fixtures, research scripts and caches, training data and notebooks, benchmark audio,
`misc/` (developer launchers and benchmark runs), `vendor/`, developer `runtime/`, backups, keys and tokens, the development-only Lua files
(`diagnostics.lua` and the probes it loads, `face-test.lua`, `gesture-probe.lua`), the retired
`KnowledgeState.reds`, Rhubarb (only a last fallback behind the lip-sync model) and the resident
phone analyser (not started when the lip-sync model is present).

## Licences to keep in view

The project's own code is under the Cyberpunk Convai Use License (`LICENSE`, modelled on the
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
Community License; both licence files ship with the pack. Chrome for Testing ships without a
licence file in its zip; the notices point to the Chromium licence. The speech-recognition model is Moonshine Tiny (MIT) run by sherpa-onnx (Apache-2.0); see docs/LOCAL_STT.md. Pocket TTS code is MIT and its
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
