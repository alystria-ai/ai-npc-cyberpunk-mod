# Release packaging (developer notes)

How the player release is built, what it contains and how it starts. Players read
`packaging/PLAYER_README.md` instead (it ships in every package and is the release notes).

## The packages

| Package | Where players get it | Contents |
|---|---|---|
| `AI-NPC-LLM-Companions-<v>.zip` | Nexus Mods (the main file for game 2.5) and Hugging Face (`AI-NPC-LLM-Companions.zip`) | The FULL INSTALL (0.3.4, owner decision 2026-10-28): the update and the Runtime base below in ONE zip, extracted into the game folder. The main file for a new player. Not built by `build-release.mjs`: `build-full.mjs` makes it from the two zips ("The Full install package" below). |
| `AI-NPC-LLM-Companions-Update-<from>-to-<v>.zip` (the former `AI-NPC-Cyberpunk-Mod-Scripts-<v>.zip`; package id `scripts`) | Nexus Mods (the update file) and Hugging Face (`AI-NPC-LLM-Companions-Update.zip`) | The CET Lua mod, redscript, the four JSON catalogs the Lua reads, one static `runtime/README.txt` (no file the game rewrites ships, see "Files the game rewrites" below), `README.txt` and `release.json`, all text; and from 0.3.4 ALL of the mod's own code in `red4ext/plugins/AiNpcCyberpunkCode/`: the launcher and native DLLs, `install-code.mjs` and the code copy in `app/` ("Code in the Scripts" below). |
| `Runtime-Update-<from>-to-<to>.zip` | Hugging Face, in the `updates/` folder. **No longer offered since 0.3.4** (the folder stays, nothing new goes in, no text points to it): an install below the update's `<from>` takes the full install instead. Before 0.3.4 every step was kept (before 0.2.8 the last few sat beside the full Runtime) | From 0.2.3 on, every release: only the Runtime files that were added or changed since the previous Runtime, the new `release.json` and the removal list; extracted over the previous version ("Runtime update zip" below). Not built by `build-release.mjs`: `build-runtime-update.mjs` makes it from the two full Runtime zips. |
| `Runtime-<v>.zip` | GitHub release of this repository (asset `Runtime-<v>.zip`), mirrored to the Hugging Face repository as `runtime/Runtime.zip` (0.3.4 moved it from the root: only Vortex and Mod Organizer 2 players, who add the update and the Runtime as two mods, still take it alone. It is also the second input of the full install) | From 0.3.4 the Runtime BASE, installed once ("Code in the Scripts" below): no launcher, native plugin or code of ours any more (a do-nothing marker plugin keeps Vortex accepting it). Bundled Node and Python, the llama.cpp engine of Local AI (`app/llama-cpp/`, about 82.5 MiB, 29.8 MiB zipped), the vgmstream decoder of V voice mods (`app/vgmstream/`, 8.1 MB, 3.4 MB zipped), the Pocket voice and lip-sync models, voice references and game archives (the Audioware reply bank of older Runtimes is gone: every voice plays through the browser renderer). |
| `OmniPack-OmniVoice-0.6B-<v>.zip` | Hugging Face | Optional OmniVoice pack, one zip (about 5.3 GB since 0.2.9): CUDA Python environment, the VoiceStudio adapter, the OmniVoice model (the language model as float16) and the OmniVoice references the Runtime does not carry ("The OmniVoice pack" below). |
| `LocalAI-Standard-Gemma-4-E4B-<v>.zip` | Hugging Face | Optional Local AI pack with Gemma 4 E4B (about 5.3 GB), one zip: the embedding model and the chat model, whole. Models only since 0.2.9 (`localAi.server.inPacks` is false): the llama-server engine is in the Runtime, so the pack needs the Runtime of 0.2.7 or newer. |
| `LocalAI-Lite-Bonsai-2-4B-<v>.zip` | Hugging Face | Optional Local AI pack with Bonsai 2 4B (about 1.3 GB), the same embedding model, models only. |
| `MicPack-European-Parakeet-TDT-0.6B-v3-<v>.zip`, `MicPack-Asian-SenseVoice-Small-234M-<v>.zip` | Hugging Face | The two optional voice-input packs (opt-in build, "Voice-input packs" below): Parakeet TDT 0.6B v3 for European languages, SenseVoice Small for Chinese, Japanese and Korean. Each is one zip with the model files in `app/models/stt/<id>/` and its own notice. |
| `Mature-Lite-Qwen3.5-4B-<v>.zip`, `Mature-Standard-Gemma-4-E4B-<v>.zip` | Hugging Face | The two optional Mature packs (opt-in build, below), one uncensored model each, each with its own marker (`manifest.mature-lite.json`, `manifest.mature-standard.json`), the embedding model and the licence texts (the same files as in the Local AI packs, shared through `addEngine` in `packaging/build-release.mjs`), so either works alone on the Runtime's engine (the Runtime of 0.2.7 or newer). |

The optional packs are hosted in one Hugging Face model repository, `alystria-ai/ai-npc-cyberpunk-mod-packs`, sorted into folders: the full install and the update at the root (`AI-NPC-LLM-Companions.zip`, `AI-NPC-LLM-Companions-Update.zip`), `runtime/` (the Runtime alone),
`local-ai/` (the two Local AI packs), `mature/` (the two Mature packs), `mic/` (the two microphone packs), `voice/` (the OmniVoice pack), `updates/` and `multilingual/`.
On Hugging Face the file names carry no `AI-NPC-Cyberpunk-Mod-` prefix and no version (`AI-NPC-LLM-Companions.zip`, `AI-NPC-LLM-Companions-Update.zip`, `runtime/Runtime.zip`, `voice/OmniPack-OmniVoice-0.6B.zip`, `updates/Runtime-Update-<from>-to-<to>.zip`, `multilingual/Voices-<Language>.zip`, `multilingual/PocketTTS-Model-100M-<Language>.zip`): the version goes only in the commit message of the upload. The build keeps the version in the file name of its output folder (`OmniPack-OmniVoice-0.6B-<v>.zip`, `Runtime-<v>.zip`, with a `.files.json` of the same name), and `packaging/upload-packs.py` publishes each pack under its unversioned name in its folder. Each pack is ONE zip: no `-partNofM` zips
and no `.partN` files inside. GitHub's 2 GiB per-file limit was the only reason for parts, and Hugging Face has no such limit. A model
over 4 GiB (the standard Local AI model, the good Mature model) sits whole in a ZIP64 zip (`packaging/lib/zip.mjs` writes ZIP64 only
where an entry or the archive needs it; Windows Explorer, PowerShell's Expand-Archive, 7-Zip and tar read it). The repository is private
until release day, when it goes public with the GitHub repository. The players' links are in the README's Install section.

Why this split: Nexus Mods scans every upload and holds files that its scanners flag for manual
review (help.nexusmods.com articles 128 and 117); it has no blanket rule against DLLs or
executables, but a text-only file never needs that review and is never quarantined. The Nexus page
must list RED4ext among the requirements (with CET, redscript, Codeware and
Native Settings UI or Mod Configuration Menu): the Runtime package's launcher and native plugin are RED4ext plugins. The large,
binary runtime goes to the GitHub release as plain zips, which is how the core frameworks
(RED4ext, Codeware) are distributed too. Audioware and TweakXL are not requirements any more
(2026-10-22): the mod ships no tweak files and plays all voices through its own audio path.

All of them use game-root-relative paths and merge into one install. From 0.3.4 the versions need not match: the Scripts name the oldest
Runtime base they run on (`runtimeBase`), and the setup check names it when the base is older ("Code in the Scripts" below). Before 0.3.4
`app/launcher/start-service.mjs` warned when the Scripts `release.json` differed from the Runtime one (it still does for Scripts without `runtimeBase`).

## The Full install package (0.3.4)

Owner decision (2026-10-28, "yes full and script update, i guess we can do the same on huggingface instead of keeping script and runtime separate"): for each game version, Nexus Mods and
Hugging Face both offer exactly two files, and a new player takes one.

| File (a build) | On Hugging Face | Who takes it |
|---|---|---|
| `AI-NPC-LLM-Companions-<v>[-for-2.31].zip` | `AI-NPC-LLM-Companions.zip`, `game-2.31/AI-NPC-LLM-Companions.zip` | A new install, and an install older than the update's `<from>` (or where Settings > Help says the Runtime is too old). On Nexus the main file (2.5) and an optional file (2.31), titled "AI NPC LLM Companions". |
| `AI-NPC-LLM-Companions-Update-<from>-to-<v>[-for-2.31].zip` | `AI-NPC-LLM-Companions-Update.zip`, `game-2.31/AI-NPC-LLM-Companions-Update.zip` | An install that already has the Runtime base `<from>` or newer. It is the former Scripts zip, byte for byte the same package (package id `scripts`, `release.json` `package: "scripts"`; the internal folder names `AiNpcCyberpunkCode` and so on are unchanged). Nexus title "Update `<from>` to `<v>`". |

`<from>` is `runtimeBase.required`, the oldest Runtime base the update runs on, when that is the release just before (0.3.3 for 0.3.4, so `Update-0.3.3-to-0.3.4`). When the base is older than the previous
release (a later release on the same base) the update covers several releases and `<from>` is `any` (`Update-any-to-0.3.5`). The rule is `updateFrom` in `packaging/lib/full-package.mjs`;
`runtimeBase.previousRelease` in `release.config.json` is the release before the one being built, set by the release script with every version (a build stops when it is missing or newer than `required`).
The update is a full code copy, so it works from any install at or above `<from>`. Below it the full install replaces everything in one step: that is the answer for a Runtime of 0.3.2 or older, and the
reason the Runtime update zips (`updates/`) are no longer offered (the 0.3.3 step is 1.5 MiB, but a chain of steps was the commonest source of mismatched installs, and the full install is one download).

**The builder.** `node packaging/build-full.mjs --version <v> [--game 2.31] [--packages DIR]` reads the update zip and the Runtime base zip of the same version and game that `build-release.mjs --packages scripts,runtime`
wrote into `dist/release/packages/` and writes `AI-NPC-LLM-Companions-<v>[-for-2.31].zip` and a `.files.json` of the same name beside them (and a `full` record in `release-manifest.json`). It reads only the two zips: no
source tree, no download. What it checks (`planFull` in `packaging/lib/full-package.mjs`, run before anything is written, and the result is read back afterwards):

- the two are what they say (`release.json` package `scripts` and `runtime` kind `base`), the same version and the same game, and the Runtime is at least `runtimeBase`;
- **no overlap**: a path in both (compared without regard to case) stops the build, even with identical bytes. The only path both carry is the install note;
- the split holds: no code path or file of the code folder in the Runtime base, nothing in the Runtime's plugin folder in the update;
- the guards of both builds again over the union: `shippedButWritten` (nothing shipped is ever written, replaced or deleted by our own code: the Vortex rule, with the update's `code.json` "removes" and the Runtime's removal list), the final entry guard
  (`packaging/lib/package-guards.mjs`, also used by `build-release.mjs`: no `misc/`, no unexpected RED4ext plugin file, no development launcher, no key or token file) and the path length;
- the zip stays under `limits.assetBytes` (one upload; the Runtime base is about 1.1 GB).

Every entry is copied byte for byte (the same deflate level as the original builds, so the content is the same and the same inputs give the same zip). The **install note** exists once: the standard note (the same bytes in both
packages, fixed because the optional packs carry it too) is dropped, and the Full zip carries `HOW TO INSTALL - AI NPC LLM Companions full install - extract into your Cyberpunk 2077 folder.txt` worded for it. It has its own file name so
that extracting a pack or the update over a full install adds the standard note beside it and Windows never asks about one name with two texts. The note also says that Vortex and Mod Organizer 2 take the update and the Runtime as two mods.

**Why Vortex and Mod Organizer 2 keep the Runtime alone.** Both replace a whole mod when a new zip is added over it ("Replace the existing mod"): the full install as one mod would lose the Runtime (and its optional packs) with every update. So these players add
the update as one mod and `runtime/Runtime.zip` as another, exactly as before, and every text that names the full install says "not with Vortex or Mod Organizer 2". The in-game rows for them (`mod-manager`, the MO2 hint) say the same.
`runtime/Runtime.zip` is also the second input of the full install, so the same file is published for both. (The standalone Runtime keeps `Runtime-<v>.zip` for the GitHub release.)

**Hugging Face layout.** Before 0.3.4: `Scripts.zip`, `Runtime.zip`, `updates/` at the root and the same in `game-2.31/`. From 0.3.4: `AI-NPC-LLM-Companions.zip` and `AI-NPC-LLM-Companions-Update.zip` at the root, `runtime/Runtime.zip`,
`game-2.31/` the same three; `updates/` and `game-2.31/updates/` are left as they are (nothing is deleted) and no longer offered. `packaging/upload-packs.py --pack full|update|runtime [--game 2.31]` uploads them; `--also-old-name`
also publishes the update at `Scripts.zip` and the Runtime at the root `Runtime.zip`, so the links of 0.3.3 and older texts keep working for a while (the same server-side copy trick as for the pack names). `packaging/hf-layout.test.mjs` and
`packaging/build-full.test.mjs` guard all of it.

**Release flow.** `build-release.mjs --packages scripts,runtime` (per game), `test-release-install.mjs`, then `build-full.mjs --version <v>` (per game), then upload: the full install and the update to Nexus (owner) and Hugging Face. `.github/workflows/release.yml`
runs `build-full.mjs` after the install test and keeps the full install and the update as the Nexus artifact. The install test checks the update and the Runtime as the two halves; it does not yet extract the full zip itself (it is their union, which `build-full.test.mjs` proves entry by entry).

**Not checked here.** Nexus Mods accepted a test update zip with the DLLs and the vision exe. A 1.1 GB zip that also holds `node.exe`, a Python environment and the vgmstream tools has not been uploaded to Nexus yet, and Nexus's scanner may hold it for review (the older reason for the text-only split, below).

## Code in the Scripts (from 0.3.4)

Owner decision (2026-10-28): everything we write or change between releases ships in the Scripts; the Runtime keeps the large, rarely changing
parts. Why: 9 of 22 error reports in the week before were players whose Scripts and Runtime were of different versions (a new Scripts zip from
Nexus, the Runtime update zips never applied). Now a Scripts download always brings matching code, and the Runtime is needed again only when a
base component changes.

**What is where.**

| Scripts (Nexus, usually installed with Vortex; about 7.6 MiB zipped, was 3.2) | Runtime base (Hugging Face, installed by hand; about 1.1 GB) |
|---|---|
| `bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod/` (CET Lua, locales, catalogs, `runtime/` placeholders, `release.json`) and `r6/scripts/CyberpunkConvai/` (redscript), text only as before | `red4ext/plugins/AiNpcCyberpunkMod/app/`: `node/`, `python/`, `pocket-tts/`, `node_modules/` (Playwright), `llama-cpp/`, `vgmstream/`, `models/` (Pocket, lip sync, Moonshine), `licenses/` |
| `red4ext/plugins/AiNpcCyberpunkCode/CyberpunkConvai.dll`: the launcher (native/autostart, 1.1.0) | `red4ext/plugins/AiNpcCyberpunkMod/voices/` (reference clips, prepared Mistral slots, V's voice) |
| `red4ext/plugins/AiNpcCyberpunkCode/CyberpunkConvaiNative.dll` + its two licence texts: the native plugin, built for the variant's game | `app/defaults/`: the Pocket and OmniVoice voice lists (they describe the base's voices and models), `convai-auth.json` (sign-in settings), `error-reports.json` (owner-added), `runtime-removals.json`, `runtime-steps/`; `app/release.json` (`kind: "base"`) |
| `red4ext/plugins/AiNpcCyberpunkCode/install-code.mjs`, `code.json` (the list), `README.txt`, `LICENSE.txt`, `THIRD-PARTY-NOTICES.txt` | `archive/pc/mod/`: the three game archives |
| `red4ext/plugins/AiNpcCyberpunkCode/app/`: one complete copy of the code, laid out as in the Runtime's `app/`: `bridge/` (closure + Python workers), `launcher/` (start-service and its modules), `assets/` (client bundle, PCM modules), `licenses/client/`, `characters/`, `research/` (the data the bridge reads), `vision/CyberpunkConvaiVision.exe`, `defaults/characters.json`, `defaults/multilingual-profiles.json`, `defaults/runtime-code-files.json`, `package.json` (24 MiB unzipped, 271 files) | `red4ext/plugins/AiNpcCyberpunkMod/CyberpunkConvaiBase.dll`: a RED4ext plugin that does nothing (native/autostart built with `CONVAI_BASE_MARKER`), so Vortex's Cyberpunk extension still accepts the Runtime zip (it refuses a zip whose DLLs all lie deeper than `red4ext/plugins/<name>/`) |

The rule for what is code: `packaging/lib/code-payload.mjs` (`CODE_PREFIXES`, `CODE_FILES`); `install-code.mjs` and `apply-removals.mjs` carry the same
lists and `packaging/code-payload.test.mjs` holds them equal. The build refuses a code path in the Runtime base and a non-code path in the Scripts'
`app/`. No package ships `launcher.ini`, `launcher.log` or `runtime/native-off.txt` any more (the launcher's built-in settings apply; a missing kill
switch means every native system is on; a player's own `launcher.ini` beside the Scripts' DLL still overrides). The Scripts' game-side files stay
text only (the check in `scriptsPackage` covers everything outside `red4ext/plugins/AiNpcCyberpunkCode/`).

**Size.** The code folder is 24 MiB unzipped (characters 11 MiB, bridge 6 MiB, research 5 MiB, client bundle 1.6 MiB), so the Scripts zip goes from
3.2 MiB to 7.6 MiB, comfortable for Nexus and Vortex. The large "ours" content stays in the base: the voices (reference clips, about 0.6 GB with
the prepared slots), the trained Pocket and lip-sync models and the voice lists that describe them. A release that adds or re-records voices or
retrains a model is a base change (a Runtime update zip, and `runtimeBase` raised). If voices change most releases, the next step is a separate
small "voices" download on its own versioned folder; not done now.

**How it starts.** RED4ext lists every plugin first and then loads them in folder order. The Scripts' folder, `AiNpcCyberpunkCode`, sorts before
`AiNpcCyberpunkMod` and `AiNpcCyberpunkModNative` on NTFS, so:

1. The Scripts' launcher loads first. Before anything else it **retires an older Runtime's two DLLs** (0.3.3 and older shipped
   `red4ext/plugins/AiNpcCyberpunkMod/CyberpunkConvai.dll` and `red4ext/plugins/AiNpcCyberpunkModNative/CyberpunkConvaiNative.dll`): each is renamed to
   `<name>.retired` (a rename works on a DLL that is loaded, too). RED4ext then fails to load the old paths (a log line, no dialog), so only one
   launcher and one native plugin run. If the old launcher was loaded first anyway (a FAT/exFAT drive lists folders in creation order) the Scripts'
   launcher starts nothing this session (the old one did; it is retired for the next start), and if it could not rename it, it stands down too, so
   two services never start. The Scripts' native plugin stands down by itself (`AnotherCopyServes` in `native/core/src/plugin/Main.cpp`) while an
   older copy is loaded or still at its old path, so two native plugins never run.
2. It starts the Runtime base's `app\node\node.exe` (`%GAME%\red4ext\plugins\AiNpcCyberpunkMod\app\node\node.exe`) with the usual bootstrap on
   `%PLUGIN%\install-code.mjs`. No Node there (no Runtime base) is `launcher-program-missing`: the game says the Runtime is missing.
3. `install-code.mjs` makes the Runtime's `app/` copy of the code equal to the Scripts' copy. Nothing to do (the Runtime's
   `app/defaults/scripts-code.json` names the same release and commit and every file has its listed size): two reads and one stat per file, about
   10 ms. Otherwise every listed file whose bytes differ is replaced (temporary file renamed over it; a file Windows will not replace, such as a
   picture helper still running from a closing session, is renamed aside first and removed at a later start), files the previous copy listed and
   this one does not are deleted, code files of older Runtimes that no release has any more (`code.json` "removes", from the code entries of
   `packaging/runtime-removals.json`) are deleted, and the list is written last. Every Scripts file is checked against `code.json` before the first
   write, so damaged Scripts change nothing. The first start after an update copies about 270 files (a second or so). It also deletes the `.retired`
   DLLs of an earlier start. Problems end in the status the game reads (`install-incomplete`, stage `installing-code`, with a short reason).
4. It then runs the Runtime's `app/launcher/start-service.mjs` (the copy it just installed) in the same process, with `process.argv[1]` set to the
   path an older launcher would have started, so start-service and everything after it (the supervisor, the bridge, the Python workers, all paths
   relative to `app/`) are exactly as before. start-service logs what install-code did.

Why copy into the base instead of running the code from the Scripts' folder: the bridge, the Python workers and their path checks all assume one
`app/` folder that holds the code and the models, Python, Playwright and the engine (the workers refuse assets outside their application folder,
Python's `._pth` names `..\bridge`, `import 'playwright'` resolves from the code's folder). The copy keeps all of that unchanged, which is what a
same-day release needs; the Scripts' copy is the source and is never written.

**Versions and the update chain.** The Runtime's `app/release.json` is the base's version. The Scripts' `release.json` and `code.json` name
`runtimeBase`: the oldest base they run on (`runtimeBase.required` in `release.config.json`, 0.3.3 for 0.3.4). Raise it only in a release that
changes the base; that release ships a Runtime update zip as before (`build-runtime-update.mjs`, `updates/`), and every other release ships none.
The setup check's `versions` row (`bridge/setup-check.mjs`): the code installed in the Runtime must be the Scripts' release (else `mismatch`), the
two must be for the same game (`game-mismatch`), and the base must be at least `runtimeBase` (else `base-old`, with `required`); the update-step
chain is checked as before. The Help row says "Scripts 0.3.4 on Runtime base 0.3.3." or names the base needed, and the first-load notice says
"The Runtime is older than {required}. Get the full install zip." A base that is too old still starts (best effort). Removal lists never delete
code (`apply-removals.mjs` refuses a code path: "code the Scripts install"), so an update zip that compares a Runtime with code to a base without it
leaves the code to install-code.

**Migration from 0.3.3 and older (no Runtime download needed when the base is 0.3.3).** The player installs the new Scripts over the old ones. At the
next start the Scripts' launcher retires the old DLLs, install-code copies the code over the old Runtime's copy (the first start lists no previous
copy, so it deletes nothing but the declared old files), and the service runs the new code. No player data moves (it is in
`%LOCALAPPDATA%\AiNpcCyberpunkMod`). The old Runtime's `launcher.ini` and `launcher.log` stay, unused, and so do the old native folder's licence and
README texts. Checked on this PC (2026-10-28): the real 0.3.3 Runtime (2.5) with the 0.3.3 Scripts, then the 0.3.4 Scripts extracted over them, started
through the test host and the real launcher: both old DLLs retired before they loaded, 267 files copied, the bridge reached Ready. A player who later
extracts an older full Runtime again gets its DLLs retired again and its code replaced again at the next start.

**Vortex.** The Scripts zip is claimed by the Cyberpunk extension's multi-type installer (CET mod + RED4ext plugin folder + redscript), which copies
every file of `red4ext/plugins/**` and of the CET mod folder to the same path; two DLLs in one plugin folder and the nested `app/**` files are
accepted, and the root `HOW TO INSTALL` note is moved to its extra-files folder as before (a loose `.json` at the zip root would send it to the
fallback dialog: there is none). The Scripts' folder is one the Runtime never ships, so Vortex deploys and purges only its own files. A Runtime from
0.3.3 that Vortex deployed: the launcher's rename of the old DLL and install-code's replaced code files are "external changes" at the next deploy
(once per release that changes code, and once for the 2.5 archive removal, see "Files the game rewrites (Vortex)" below); keeping them is right ("Save all
changes" or "Use newer file for all changes", and for the deleted archive "Save all changes" too: "Revert" would link the archive back, and the next start deletes
it again). Reverting a code file only means the next start copies it again: install-code compares the modification time recorded at the copy as well as the size,
hashes a file whose time differs, and copies it when the bytes are the old ones. A 0.3.4 Runtime base ships no code, so none of this applies to it. Vortex's tag files (`__folder_managed_by_vortex`) in the code
folders are ignored (install-code reads the list, never the folder).

**Mod Organizer 2.** Scripts as a mod: the launcher is loaded from the virtual path; the bootstrap runs install-code.mjs from its real place, so the
code is read from the Scripts mod's real folder. The Runtime's `app/` is resolved to its real place (a Runtime installed as a mod: its mod folder,
outside the game folder, written directly), so the copy lands in the Runtime's own mod folder and start-service runs from there as before. A
Runtime installed in the game folder itself: existing files are replaced in place (a rename over an existing file stays in place under usvfs), and a
file that is NEW in a release lands in MO2's Overwrite, which the bundled Node's resolution cannot stat; `usvfs-compat.mjs` adds a resolve hook
(`moduleFallback`, `module.registerHooks`) that answers such an import with the file when it opens, for the service and every Node child. A new
Python worker module in that one setup is not covered (Python's import stats the file); none is new in 0.3.4. install-code installs the
Scripts' own usvfs fallbacks before it reads anything.

**Both games.** The code is the same for 2.5 and 2.31; the native plugin is built per game and ships in each variant's Scripts (`-for-2.31`), and
`code.json` names the game. The Runtime base is still built per game (the archives differ: `fix/driver-guard-2.31-only` makes the driver guard
archive 2.31-only). 2.5 bases from 0.3.3 and earlier still hold that archive, which lays a stale 2.31 quest phase over 2.5's own, so the Scripts
remove it on game 2.5 (`GAME_REMOVALS` / `removeGameFiles` in `install-code.mjs`): before the code copy, through the Runtime removal step's own rules
(`refusalFor` and `installRootOf` of `apply-removals.mjs`, so under Mod Organizer 2 it goes from the Runtime's own mod folder), one log line when it is
removed, tried again at the next start when Windows holds it. No update zip is needed and `runtimeBase` stays 0.3.3; a 2.31 game keeps the archive.

**Interplay with held branches.** `fix/vortex-runtime-files` is merged (branch `fix/vortex-0.3.4`): no placeholder files, and the rule of "Files the game rewrites (Vortex)"
now covers the code folder too. `feat/pack-model-names` renames pack files (pack builders and `upload-packs.py`); no shared lines expected beyond the header
comment of `build-release.mjs`. `fix/driver-guard-2.31-only` changes `releaseData.archives` per game in `release.config.json` (the archives stay in the
Runtime base; the Scripts remove the archive from older 2.5 bases, see "Both games", so `runtimeBase` does not change for it).

**Tests.** `packaging/code-payload.test.mjs` (the copy, damaged Scripts, removals, leftovers, the hand-off as the launcher runs it, the failure
status, the usvfs resolve fallback, the shared rules), `bridge/autostart-plugin.test.mjs` (the built-in settings, the retirement of an older
Runtime's two DLLs), `packaging/scripts-package-layout.test.mjs` (the code folder and `code.json`), `bridge/setup-check.test.mjs` and
`bridge/setup-check-lua.test.mjs` (`base-old`, the base row and notice), `packaging/runtime-removals.test.mjs`, `packaging/build-runtime-update.test.mjs`, `packaging/vortex-no-rewrites.test.mjs` (nothing a package ships is written
or deleted by our own code, "Files the game rewrites (Vortex)").
`packaging/test-release-install.mjs` starts the service through install-code.mjs and checks the code folder.

**Live checks owed** (see the report of 2026-10-28): fresh install (new base + new Scripts), upgrade from 0.3.3 on 2.5 and on 2.31 (Scripts only),
Scripts with Vortex over a hand-installed 0.3.3 Runtime, MO2 with both as mods.

## Pack file names

Since 0.3.4 every model pack carries the model's name and parameter count in its file name, with the tier word kept: `<Type>-<Tier>-<Model>-<Params>.zip`
(owner decision 2026-10-28). The names are the `packFiles` block of `packaging/release.config.json`, the one source: `packaging/lib/pack-names.mjs` (the builder, the
install test, the rebuild and Pocket model tools) and `packaging/upload-packs.py` read it, and `packaging/release.test.mjs` keeps it equal to the model names pinned in the same file.

| Pack | Hugging Face path since 0.3.4 | Path before (0.3.3 and older) |
|---|---|---|
| OmniVoice (OmniVoice 0.6B) | `voice/OmniPack-OmniVoice-0.6B.zip` | `voice/OmniPack.zip` |
| Local AI standard (Gemma 4 E4B) | `local-ai/LocalAI-Standard-Gemma-4-E4B.zip` | `local-ai/LocalAI-Standard.zip` |
| Local AI lite (Bonsai 2 4B) | `local-ai/LocalAI-Lite-Bonsai-2-4B.zip` | `local-ai/LocalAI-Lite.zip` |
| Mature standard (Gemma 4 E4B fine-tune) | `mature/Mature-Standard-Gemma-4-E4B.zip` | `mature/Mature-Standard.zip` |
| Mature lite (Qwen3.5 4B fine-tune) | `mature/Mature-Lite-Qwen3.5-4B.zip` | `mature/Mature-Lite.zip` |
| Microphone, European (Parakeet TDT 0.6B v3) | `mic/MicPack-European-Parakeet-TDT-0.6B-v3.zip` | `mic/MicPack-European.zip` |
| Microphone, Asian (SenseVoice Small, 234M) | `mic/MicPack-Asian-SenseVoice-Small-234M.zip` | `mic/MicPack-Asian.zip` |
| PocketTTS model per language (Pocket TTS 100M) | `multilingual/PocketTTS-Model-100M-<Language>.zip` | `multilingual/PocketTTS-Model-<Language>.zip` |

The Scripts, Runtime, `Voices-<Language>` (voice packs, no model) and `Runtime-Update` zips keep their names. A build writes `<title>-<version>.zip` with the new title and
publishes it as `<folder>/<title>.zip`. What did not change:

- **Detection never read a zip's name.** The packs are found by the markers and folders inside them (`manifest.*.json`, `omni-pack.json`, `mic-pack.json`,
  `pocket-model.json`, `app/models/stt/<id>/`), so a pack a player installed under an old name, or in a folder called after an old name (`place-packs.mjs`,
  `setup-check.mjs`), is found and works exactly as before, and a new-name pack is found the same way. Nothing inside a pack was renamed: the model files keep the names
  the loader and the manifests pin, and the Local AI model list shows the model name and size from the manifest.
- **The uploader accepts both.** It looks for the new name first and then for the old one in a build folder, and publishes under the new name either way.

**Migration for the next release (0.3.4).**

1. Build and upload as usual; the packs now carry the new names in the build folder and on Hugging Face. Do not rename anything on Hugging Face by hand.
2. Upload each pack with `--also-old-name` once (or copy the old path on Hugging Face server side): Hugging Face stores identical content once, and every link in the
   released 0.3.3 texts (Nexus page, player README, model card, the GitHub README before this change) keeps working. Remove the old paths after the Nexus page and the
   README are updated and a release or two has passed.
3. Texts that link a pack must use the new paths in the same release: `README.md`, `docs/NEXUS_PAGE.md`, `packaging/PLAYER_README.md`, `packaging/HF_MODEL_CARD.md`,
   `packaging/HF_MULTILINGUAL_README.md`, `docs/POCKET_LANGUAGE_MODELS.md`. They were changed on the branch; push `main` only after the new files are on Hugging Face (or
   with the old paths still there), or the links 404 in between. The released 0.3.3 texts in `deliverables/` are not touched.
4. The Nexus file descriptions and the "Get the Runtime from Hugging Face" line say the pack names when they list them; use the new names there too.
5. A player who downloads a pack from a link in the 0.3.3 texts gets a file under the old name (it works; nothing to do), and one who downloads under a new name gets the same
   content. Replying to a player: the file may be called either, and it extracts to the same place.

## Two game versions

The Scripts and Runtime are built once per game (`--game 2.5`, the default, or `--game 2.31`, the older game), from one source tree; the 2.31 build's files carry `-for-2.31`, its
`release.json` files say `"game": "2.31"`, and it sits in `game-2.31/` on Hugging Face (the 2.5 build is at the top). The optional packs are shared. See `docs/GAME_VERSIONS.md`.

## Version numbers

Releases are numbered `0.N`: 0.1, 0.2, 0.3, ..., and a hotfix of one release is `0.N.M` (0.2.1).
The first build (2026-10-07, a private-repository test of the pipeline) was made as `2077.1` and
renamed to `v0.1` on 2026-10-16 (title, tag and file names; the files inside were not rebuilt); the version check still accepts the old `2077.N` form. The tag is `v` + the
number (`v0.2`) and the workflow accepts both forms (`v0.2`, `v0.2.1`); a manual run takes the number
without the `v`. The same string goes into the package file names (`AI-NPC-Cyberpunk-Mod-Scripts-0.2.zip`, `Runtime-0.2.zip` and so on), the release title, both
`release.json` files and the OmniVoice `omni-pack.json`. The only version check at run time is
`start-service.mjs` comparing the Scripts and Runtime strings for equality, so any form works; the
builder accepts two to four numbers with an optional `-pre`/`+build` suffix
(`packaging/lib/version.mjs`, guarded by `release.test.mjs`), and writes a three-part form
(0.2.0) only into `app/package.json`, which npm-style tooling wants as semver. The installed-layout
tool `test-release-install.mjs` matches package files by exact version, so 0.2 never picks up
0.2.1 or 0.20.

## Installed layout

```
red4ext/plugins/AiNpcCyberpunkCode/   Scripts, from 0.3.4 ("Code in the Scripts")
  CyberpunkConvai.dll        launcher 1.1.0 (native/autostart): %GAME%\red4ext\plugins\AiNpcCyberpunkMod\app\node\node.exe --eval <bootstrap> %PLUGIN%\install-code.mjs
  CyberpunkConvaiNative.dll  the native core plugin (native/core, built per game) and its licence texts
  install-code.mjs, code.json   copies app/ below into the Runtime's app/, then runs its launcher/start-service.mjs
  app/                       the code: bridge/, launcher/, assets/, characters/, research/, vision/, licenses/client/, defaults/ (3 files), package.json
red4ext/plugins/AiNpcCyberpunkMod/    Runtime base (0.3.3 and older: also CyberpunkConvai.dll and launcher.ini, retired by the Scripts' launcher)
  CyberpunkConvaiBase.dll    marker plugin that does nothing (for Vortex's installer)
  app/                       the application: the base's parts, and the code install-code.mjs copies in (listed in app/defaults/scripts-code.json)
    node/node.exe            official Node.js (node.exe and LICENSE only)
    python/                  official CPython 3.12 embeddable + hash-locked wheels (Pocket worker)
    pocket-tts/              Kyutai pocket-tts: the pocket_tts/ package and LICENSE of the pinned revision (the build verifies the whole upstream tree's hash; 53 of its 140 files ship)
    llama-cpp/               the llama.cpp engine of Local AI: llama-server, llama-fit-params and the libraries they load (26 files; the Runtime update zip delivers a new build)
    vgmstream/               vgmstream-cli.exe and the ten libraries it loads (the decoder of a player's V voice mod; 11 files, unmodified official release)
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
    local-ai/                the Local AI pack(s), when installed (models/, licenses/, manifest.*.json; llama/ in a pack that still carries its own engine)
  voices/                    reference clips (outside app/: the Omni worker requires it)
    prepared/                the bridge's cache of the Mistral voice's references, and the OmniVoice pack's slots (see below)
    prepared-runtime/        the Runtime's pre-built slots for the Pocket clips (read after prepared/, never written)
red4ext/plugins/AiNpcCyberpunkModNative/   0.3.3 and older only: the old native plugin, renamed to .retired by the Scripts' launcher
bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod/
  *.lua, locales/, *.json    Scripts package
  runtime/                   Lua <-> bridge exchange files (the only folder the service writes in the game folder's CET mod)
    native-off.txt           the native kill switch, no system listed from 0.2.7 (Runtime package, see below)
r6/scripts/CyberpunkConvai/  redscript (Scripts package)
(r6/audioware/CyberpunkConvai, speech.yml and eight silent reply slots, was shipped by Runtimes before 2026-10-22 and is no longer used)
archive/pc/mod/              convai_facial, convai_gestures, cyberpunk_convai_ambient_driver_guard (Runtime; the driver guard in the 2.31 Runtime only)

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

0. From 0.3.4 the launcher is the Scripts' (`red4ext/plugins/AiNpcCyberpunkCode/`): it first retires an older Runtime's launcher and native plugin,
   starts the Runtime base's Node on `install-code.mjs`, which copies the Scripts' code into `app/` and then runs `app/launcher/start-service.mjs` in
   the same process exactly as below ("Code in the Scripts").
1. RED4ext loads `CyberpunkConvai.dll`. It checks that CET and the CET mod are present, reads
   `launcher.ini` and starts `app\node\node.exe --eval <bootstrap> app\launcher\start-service.mjs` hidden, with a pipe
   whose closing tells the service that the game ended. launcher.ini is optional from launcher 1.0.1 (0.2.4): without it, or with one that
   names no program, the launcher starts exactly what the shipped file says (`DEFAULT_*` in `native/autostart/CyberpunkConvaiLauncher.c`, held
   equal to `packaging/lib/launcher-ini.mjs` by `bridge/autostart-plugin.test.mjs`); an older launcher publishes `launcher-not-configured`.
   The bootstrap (`packaging/lib/launcher-ini.mjs`) loads the script where it is,
   or from its real place when Node's stat cannot see it (a Runtime installed as a Mod Organizer 2 mod, below).
2. `start-service.mjs` prepares `data/` (below), joins split files left by an earlier release on the first start
   (verifying their SHA-256; current packs have none), and sets every path explicitly:
   `CYBERPUNK_CONVAI_CLIENT_ASSETS`, the four `CYBERPUNK_CONVAI_OMNI_*`
   paths and `CYBERPUNK_CONVAI_PYTHON` when the pack is installed, the key file and state folder.
   It clears inherited `NODE_OPTIONS`, `PYTHONPATH` and similar overrides. Nothing is looked up on PATH. The one thing the package
   does not carry is a browser: the bridge's hidden browser is the Microsoft Edge that Windows 10 and 11 include, else an installed
   Google Chrome, else another installed Chromium browser (Brave, Vivaldi, Opera and Opera GX, Chromium, Edge and Chrome Beta, Dev and
   Canary, Yandex, Thorium and a few more). `bridge/system-browser.mjs` checks the usual install folders, then the registry's App Paths
   entries (so a browser installed elsewhere is found), then the browser Windows opens links with (the https UserChoice ProgId and its open
   command) and the Start menu browser clients (`HKCU`/`HKLM` `SOFTWARE\Clients\StartMenuInternet\*\shell\open\command`), each accepted only
   when its program is a known Chromium one, once per start and only until one is found. Firefox cannot be used: Playwright
   drives only its own patched Firefox. A developer's `CYBERPUNK_CONVAI_BROWSER` still names an executable instead, and so does the
   player's `browser.txt`: a plain text file in `red4ext\plugins\AiNpcCyberpunkMod\` beside `launcher.ini` (never shipped; `PROTECTED` in
   `apply-removals.mjs`, so an update never removes it) holding one line, the full path of a Chromium program or of its folder (an
   optional `BrowserPath=` before it, quotes, and `;` or `#` comment lines are accepted). `start-service.mjs` reads it, checks the file
   is there and sets `CYBERPUNK_CONVAI_BROWSER` from it (a variable already set wins); a file that names nothing usable is one log line
   and the usual lookup goes on. A browser that is found but will not start is `BROWSER_START_FAILED`: the log says "Brave was found but
   would not start: <reason>" once, and a turn fails with the game notice `browser-failed` naming it (not an error report).
   Chrome for Testing was bundled in 0.2 until Hugging Face's virus scanner flagged its `chrome.dll` (a false positive). If neither
   browser is installed the supervisor reports `browser-missing` (the in-game notice, the Settings status line and Help row that name the missing browser, one line in
   `bridge-service.log`) and starts the bridge by itself once one is installed.
3. It then runs the development supervisor unchanged (`bridge/bridge-supervisor.mjs`): one bridge
   per game session, crash restarts, the status file the in-game Help page reads, and a graceful
   stop when the game exits. `--prepare-only` stops after step 2 and prints a summary.

The embedded Pythons use their `._pth` file (`Lib\site-packages`, `..\bridge`, `import site`), so
they ignore any Python installed on the machine.

### The native plugin and `native-off.txt`

`red4ext/plugins/AiNpcCyberpunkCode/CyberpunkConvaiNative.dll` (in the Scripts from 0.3.4; `red4ext/plugins/AiNpcCyberpunkModNative/` in the Runtime before) is built from `native/core` in the release build
(the CMake project that `scripts/Build-NativeCore.ps1` drives, MSVC from Visual Studio 2022, static CRT, `/Brepro`; the RED4ext SDK
is fetched by CMake at the commit pinned in `native/core/CMakeLists.txt`). The Runtime job of the workflow checks the toolchain
before building and the clean-install test inspects the DLL with `convai_plugin_host.exe` (it checks the file without running game
code). The package works without it: `--no-native` leaves it out and the Lua falls back to its own path for every system
(`mod/native-core.lua`). The plugin's licence texts (RED4ext.SDK, yyjson) sit next to the DLL.

`bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod/runtime/native-off.txt` is the kill switch. Up to 0.3.3 it shipped in every Runtime
package that carried the plugin; from 0.3.4 no package ships it (the list was empty, and a missing file means every system is on). Through 0.2.6 it listed `actuator`, `vehicles`, `chauffeur`, `passage` and `faces`, the systems not
yet proven in the real game, which started switched off. From 0.2.7 the list is empty (`native.off` in
`packaging/release.config.json` is `[]`), so the file holds only its comment header (`packaging/lib/native-off.mjs` writes it) and
every system is on. One name per line, `#` starts a comment, `all` switches everything off; the plugin polls the file about once a
second and the Lua reads it too. A **missing file means every system is on**, so a player or a developer switches a system off by
adding its name on a line. The file stays in the package so the switch is documented where it is used, and so an update replaces
an older file that still listed systems. To ship a system off again, put its name in `native.off` (the header then says so).

### Local AI packs

Two optional downloads (`docs/LOCAL_AI.md`): `localai-standard` (Gemma 4 E4B) and `localai-lite` (Bonsai 2 4B). Each holds the
the granite embedding model, one chat model, a manifest fragment
(`manifest.standard.json` or `manifest.lite.json`, merged by `bridge/local-ai-pack.mjs`), the licence texts and the notices, under
`red4ext/plugins/AiNpcCyberpunkMod/app/local-ai/`. The two packs repeat the shared server, embedding and notice files byte for byte, so
extracting both only overwrites identical bytes. The chat model ships whole (no parts): `bridge/local-ai-pack.mjs` finds the model file directly, and
`assemble-parts.mjs` only joins parts that an earlier release left behind (it finds no `.parts.json` in a current install and does nothing). Every file is the unmodified upstream file, pinned in the
`localAi` block of `release.config.json` by URL, revision and SHA-256; a developer folder can stand in with `--models local`.
**The engine is in the Runtime (2026-10-21, `packaging/engine-in-runtime.test.mjs`).** The `llama-server` Vulkan build (b11782: the server, `llama-fit-params.exe` for the
free-memory fit, and their DLLs, 26 files, 82.5 MiB, 29.8 MiB zipped) is built into the Runtime by `addRuntimeEngine` in `build-release.mjs`, at `app/llama-cpp/`, from the same pinned
download, hash and keep/drop/require lists the packs used (`localAi.server`; `runtimeFolder` names the folder, `bridge/local-ai-pack.mjs` `RUNTIME_ENGINE_FOLDER`). The Runtime update zip then
delivers an engine fix like any other changed file (a Runtime update from 0.2.6 adds the 26 files), and `packaging/lib/runtime-required.mjs` makes `check-runtime-contents.mjs` and the
install test refuse a Runtime without them. The bridge uses the Runtime's engine first and the copy inside a pack as the fall-back (docs/LOCAL_AI.md, "The engine is in the Runtime");
`apply-removals` already protects `app/local-ai/`, so a pack's own `llama/` is never deleted. **The packs:** 0.2.7 to 0.2.8 kept a copy of the engine in the packs' `llama/` folder
(`localAi.server.inPacks` true), so a pack downloaded by a player who had not updated the Runtime still ran. **Since 0.2.9 (2026-10-22) `inPacks` is false:** the four Local AI and Mature packs
carry models only (30.9 MB smaller each, 85.7 MB less on disk: 25 files, the engine and its two licence texts), their manifests and markers name no `server`, and they need the Runtime of
0.2.7 or newer (the packs' notices, the Mature README, the model card and the Nexus requirements say so). The old packs still work with the new Runtime, and a new pack beside an old one is
fine (the Runtime's engine is used first). A new pack on a Runtime older than 0.2.7 reads as "the Local AI pack is not installed" (no engine to run it).
`packaging/check-pack-overlap.mjs` now checks that no pack ships a file the Runtime ships ("Packs reused unchanged", below). Without the engine's DLLs a pack can also be added with Vortex ("Packs and Vortex" below).

Licences (all redistributable with the licence text, which the packs carry): llama.cpp MIT, the LLVM OpenMP runtime Apache-2.0 with
LLVM exceptions, Gemma 4 E4B Apache-2.0 (Google also publishes a prohibited use policy), Bonsai 2 4B (PrismML, a Qwen3.5-based model) Apache-2.0, granite-embedding
Apache-2.0. `THIRD_PARTY_NOTICES.md` has the table.

### vgmstream in the Runtime

The Runtime carries `vgmstream-cli.exe` and ten libraries it loads, in `app/vgmstream/` (11 files, 8.1 MB, 3.4 MB zipped), so the bridge can decode the Wwise voice-over of a
player's V voice mod and build V's voice reference from it (one line at a time, on the player's own PC; the process exits when the build is done). The files are the unmodified files
of the official vgmstream Windows release **r2055** (`vgmstream-cli.exe -h` prints "r2055 (Sep 28 2025)"): `vgmstream-cli.exe`, `avcodec-vgmstream-59.dll`, `avformat-vgmstream-59.dll`,
`avutil-vgmstream-57.dll`, `libatrac9.dll`, `libcelt-0061.dll`, `libcelt-0110.dll`, `libg719_decode.dll`, `libmpg123-0.dll`, `libspeex-1.dll`, `libvorbis.dll`. The release's
`swresample` and `zlib-ng2` DLLs, the Winamp and XMPlay plugins and the other helper DLLs are not needed and are not shipped.

- **Pin:** `toolchain.vgmstream` in `release.config.json` (version, build date, licence, release and source URLs, `runtimeFolder`, `licenceFolder`, `vendorFolder`, and `files`: each
  file's size and SHA-256).
- **Input (nothing is downloaded):** `addRuntimeVgmstream` in `build-release.mjs` reads the 11 files from `vendor/vgmstream/` of the working checkout (`vendor/` is git-ignored, so
  it is read from the checkout and not from the exported commit, like `assets/v-voice/*.wav`) and stops the build on a missing file or one that differs from the pin. **A release is built
  on a PC whose `vendor/vgmstream/` has those files**: copy the folder from the machine that has it (the CI release workflow has no source for them, so it cannot build the Runtime
  until the files are in the runner; it needs the files added to its inputs first).
- **Licences:** `packaging/licenses/vgmstream/COPYING` (ISC, the project's own licence text) and `NOTICE-bundled-libraries.txt` (the libraries, their licences, the source location) are
  committed and go to `app/licenses/vgmstream/`; the build adds two lines to `app/licenses/THIRD-PARTY-NOTICES.txt`, and `THIRD_PARTY_NOTICES.md` has the table rows. FFmpeg (avcodec,
  avformat, avutil) and mpg123 are LGPL-2.1-or-later: they are the unmodified release DLLs, loaded dynamically, so a compatible build can replace them; their sources and build scripts
  are in https://github.com/vgmstream/vgmstream at the tag r2055. libVorbis, Speex and CELT are BSD-3-Clause, LibAtrac9 is MIT, and the vgmstream release gives no licence text for
  `libg719_decode.dll` (the notice says so).
- **Checks:** `packaging/lib/runtime-required.mjs` requires the 11 files (group "vgmstream decoder") and the two licence files (group "vgmstream licences"), so
  `check-runtime-contents.mjs` and the install test refuse a Runtime without them; the install test also starts `app/vgmstream/vgmstream-cli.exe -h` from the extracted install and expects
  the pinned release's banner. The Runtime update zip delivers the folder like any other new or changed file (a Runtime update from 0.2.7 adds the 13 files); nothing in the start step
  protects it, so a later Runtime may drop a library with a removal entry. Tests: `packaging/vgmstream-in-runtime.test.mjs`.
- **Updating vgmstream:** replace the files in `vendor/vgmstream/` with the new official release's, update `version`, `build`, `release`, `source` and the sizes and hashes in
  `toolchain.vgmstream`, the version in `COPYING`/`NOTICE-bundled-libraries.txt` and `THIRD_PARTY_NOTICES.md`, and the library versions if they changed.

### Voice-input packs (`micpack-european`, `micpack-asian`)

Two optional downloads for voice input in other languages (`docs/LOCAL_STT.md`, "The optional packs"), hosted on Hugging Face with the other optional
packs, each ONE zip: `MicPack-European-Parakeet-TDT-0.6B-v3-<v>.zip` (NVIDIA Parakeet TDT 0.6B v3, int8, pack id `parakeet-tdt-0.6b-v3-int8`, about 0.67 GB; CC-BY-4.0)
and `MicPack-Asian-SenseVoice-Small-234M-<v>.zip` (SenseVoice Small, int8, pack id `sense-voice-int8`, about 0.24 GB; FunASR Model Open Source License 1.1;
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
  (one runner each), which builds with `--packages micpack-<x>` and uploads with `packaging/upload-packs.py --pack micpack-<x>` (`mic/<zip>` in
  `alystria-ai/ai-npc-cyberpunk-mod-packs`, without a version in the name).
- **Extracted one folder too deep.** `place-packs.mjs` also recognises `app/models/stt/<id>/mic-pack.json` of these two ids and moves only that folder (never
  the Runtime's Moonshine folder), with the same safety rules as for the other packs (marker last, empty wrapper folders removed with `rmdir`, a same-size file in
  place keeps it, a different size leaves both). The log names them `MicPack-European` and `MicPack-Asian`.
- **Tests.** `packaging/mic-packs.test.mjs` (builds both packs with stand-in files, and from a generated archive served over HTTP; with
  `CYBERPUNK_CONVAI_MIC_PACKS_DEV` set it also builds the real files), the pack tests at the end of `packaging/place-packs.test.mjs`, and the source tests in
  `packaging/release.test.mjs`.

### Packs and Vortex (a pack must hold no `.dll`)

Discord, 2026-10-23: adding the Local AI Standard pack to Vortex (Cyberpunk 2077 extension v0.13.0, `E1337Kat/cyberpunk2077_ext_redux`) stopped with
`Error: Red4Ext installer failed to generate any instructions! at Object.installRed4ExtMod`. What the extension does (read from its source, `src/installers.ts`,
`src/installer.red4ext.ts`, `src/installer.fallback.ts`; nothing was downloaded):
- It asks its installers in a fixed order (core mods, ASI, multi-type, **RED4ext**, REDmod, AMM, CET, redscript, Audioware, TweakXL, INI, JSON, XML, preset, archive) and the
  first whose test says "supported" installs. The last one, the fallback, supports everything. Vortex's own FOMOD installer (priority 20) runs before all of them.
- The RED4ext test (`testForRed4ExtMod`) says "supported" for **any zip that has a file ending in `.dll` at any depth**. Its install then knows four layouts, and each needs a
  `.dll` directly in `red4ext/plugins/`, directly in a folder of it (`red4ext/plugins/<name>/x.dll`), at the top of the zip, or directly in one top-level folder. A DLL deeper than
  that (ours: `red4ext/plugins/AiNpcCyberpunkMod/app/local-ai/llama/ggml-*.dll`, 22 of them in each Local AI and Mature pack, and the Python of the OmniVoice pack) matches none, so the
  install fails with the message above and does not fall back.
- A zip with **no `.dll`** is not claimed by the RED4ext test, and nothing else in the list recognises a pack's files (no `r6/scripts`, `r6/tweaks`, CET mod folder, `archive/pc/mod`,
  REDmod `info.json` or protected game config). It reaches the fallback installer, which asks the player "install anyway?" once (a dialog, with Cancel) and then copies every file to the
  same path under the game folder, which is what a pack wants.

**What the pack build must do:** no pack zip may contain a file ending in `.dll` (any case, any folder). For the Local AI and Mature packs that is `localAi.server.inPacks: false`
(see "Local AI packs": the engine and its DLLs are in the Runtime since 0.2.7, a pack then carries models, manifest, licences and notices only). Run
`node packaging/check-vortex-layout.mjs <pack zip or Hugging Face URL>...` on each pack before upload; it lists the DLLs and exits 1 when there are any
(`packaging/check-vortex-layout.test.mjs`). **Open:** the OmniVoice pack carries Python (`app/omni/python/`, with `python3xx.dll` and the `.dll` files of its libraries), so it fails the
same check; either move that tree into a Runtime-side download, or tell players to extract it by hand (the model card says so for any pack Vortex refuses). Two routes were
looked at and not taken: a `fomod/ModuleConfig.xml` in the zip (Vortex's FOMOD installer would copy the files as they are before the extension looks at them, but every player who
extracts by hand gets a stray `fomod/` folder in the game folder, and Mod Organizer 2 would open its FOMOD wizard, a change to the installs checked in `mo2-split-packs.test.mjs`); and a
placeholder `.dll` directly in the plugin folder (RED4ext would try to load it at every start).

### Packs extracted one folder too deep (`place-packs.mjs`)

The optional packs are zips whose entries start at the game root. Windows "Extract All" and 7-Zip's "Extract to <zip name>\" wrap
them in a folder named after the zip, so the files land in
`<game>\LocalAI-Standard-0.2\red4ext\plugins\AiNpcCyberpunkMod\app\local-ai\...` and the mod reports "No model
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

### The OmniVoice pack

One zip, `voice/OmniPack-OmniVoice-0.6B.zip` on Hugging Face (`omni` in `build-release.mjs`): the CUDA Python 3.11 environment (`app/omni/python/`), the VoiceStudio adapter (`app/omni/voicestudio/`), the OmniVoice
model (`app/omni/model/`), the reference clips of the voices it was frozen with (`voices/archetypes/omni-long`, `omni-short`, `voices/picked/autobest/omni-long`, `omni-short`), the Mistral voice's
prepared slots for them (`voices/prepared/`), its own copies of the voice lists (`app/omni/defaults/`, the read-second fall-back), the notices and the marker `app/omni/omni-pack.json`.

**The leaner pack of 0.2.9 (2026-10-22, 6,585.5 MB zipped before, 5,341 MB after; 8,693 MB on disk before, about 7,400 MB after).** Four changes, all pinned or ruled in code:

- **The language model is float16** (`app/omni/model/model.safetensors`, 1,225,189,208 bytes instead of 2,450,344,112). The worker loads it as float16 (the VoiceStudio adapter's `model_manager`
  passes `dtype=torch.float16`, and `bridge/resident-voice-worker.py` refuses a model that did not load as `torch.float16`), so the float32 file was read, rounded and thrown away at every start.
  `packaging/convert-omni-fp16.py` rounds every float32 tensor to the nearest float16 (what the loader does: `tensor.to(torch.float16)`), keeps the integer tensor and the metadata, refuses a finite
  value that would overflow, and checks its own output tensor by tensor. It is deterministic, so `release.config.json` pins the result (`toolchain.omniModel.converted`: size and SHA-256) beside the
  upstream file's pin (`files`): the build checks the upstream file against its hash, converts it with the pack's own Python and checks the result against the second pin. Loaded with
  `dtype=torch.float16`, the old and the new file give the same tensors bit for bit (checked with `omnivoice.OmniVoice.from_pretrained` on both).
- **The audio tokenizer stays float32** (`app/omni/model/audio_tokenizer/model.safetensors`, 805,665,628 bytes, the unmodified upstream file). OmniVoice loads it with no dtype, so it runs as float32 (its
  `config.json` says `"dtype": "float32"`; transformers takes that), and a float16 file would change the audio instead of only the download. The other model files (`config.json`, the text tokenizer, the
  licences) are unmodified upstream files too. The pack's notice (`app/omni/THIRD-PARTY-NOTICES.txt`) says which file was changed and how, with both hashes (CC-BY-NC asks for the change to be stated), and the
  marker `omni-pack.json` records `precision` (`model` float16, `audioTokenizer` float32) and `modelFileSha256`. "Every model file is the unmodified upstream file" is true of every pack but this one.
- **Left out** (`packaging/lib/omni-pack-rules.mjs`, one rule set for the builder and the rebuild tool): the `tests/` and `test/` folders of the Python packages (4,099 files, 66.7 MB on disk together with the next
  two items; `testing` packages such as `torch.testing` stay), the copies of `fbgemm.dll` and `asmjit.dll` in `torch/bin/` (identical to the ones in `torch/lib/`, which is where torch loads them from), and
  the three draft clips of the first cast (`voices/full-cast-draft/`, named only by the 0.2.1 lists). The install note (`HOW TO INSTALL ...txt`) is added, like in every package the builder makes.
- **The 120 Omni clips of the newest voices stay in the Runtime.** The Runtime carries a long and a short Omni clip for the 60 voices added after the pack was frozen (11 + 11 archetype clips, 49 + 49
  picked ones, 45.5 MB zipped; `packaging/pack-listings/runtime-omni-clips-0.2.9.json`). The Mistral voice (Voxtral) reads them for players without this pack: `bridge/voxtral-voice.mjs` takes the Omni
  long clip, else the short one, else the Pocket clip. Moving them into the pack would give those 60 voices Pocket references on every PC without the pack, a worse Mistral voice for the
  players who never install it, to save them 45.5 MB. So the Runtime keeps them and the pack leaves them out (`omniPack.runtimeClips` in `release.config.json`: a build from scratch skips exactly those
  paths and stops if its clip differs from the listed size and CRC-32), which also means the two never ship the same file. Without the pack Mistral still has Omni references for those 60 and Pocket ones
  for the other 252, as before; with the pack all 312 voices have Omni ones (60 from the Runtime, 252 from the pack). The pack works only on top of the Runtime anyway (the launcher, the worker, the lists).

**What was checked (2026-10-22, RTX 4080 Laptop, the owner's laptop reported as in Silent mode, the Windows plan Balanced; timings are for comparison only).** (1) The install test (`packaging/test-release-install.mjs --omni`, a clean stand-in game folder with the real Scripts, Runtime and this pack): 29 of 29 checks, OmniVoice on `cuda:0` speaks. It also caught a mistake of the first leaner build: numpy.testing imports `numpy._core.tests._natype`, which scipy's import chain needs, so the worker died importing transformers' `AutoFeatureExtractor`; that one file stays (`TEST_FILES_KEPT`). (2) Old and new model loaded the way the worker loads them (`dtype=torch.float16`): 840 tensors, 0 mismatches bit for bit, every language model tensor float16 in both, the audio tokenizer float32 in both. (3) The real `ResidentVoice` rendered 5 characters (judy-alvarez, jackie-welles, johnny-silverhand, kerry-eurodyne, meredith-stout) with 2 lines each from the old pack and from the new one, twice each: all 10 outputs are byte-identical across the four runs (same SHA-256), so the ECAPA cosine (the repo's `scripts/pocket_training/likeness.py` guard) between old and new is exactly 1.0000 for every pair, and against each voice's reference clip 0.66 to 0.85, mean 0.77, for both. (4) Back to back, old, new, old, new, 5 voices, two lines each, 16 steps: a line renders in 0.80 s on average (old 0.80 and 0.79, new 0.83 and 0.82 for the first line of each voice; 0.84 and 0.80 against 0.85 and 0.82 for the second), voice preparation 1.0 to 1.1 s. The new pack rendered about 25 ms (3%) slower than the old one in both pairs; the weights on the card are identical bit for bit and the outputs too, so it is not the model (the runs came from two folders, and a few runs cannot tell a 3% difference from a laptop's noise). The worker start (process, imports, model load, CUDA graph) was 53.7 s, 25.2 s, 19.6 s, 22.2 s: the first run read the 2.4 GB file from a cold disk cache, so the start is no clean comparison, the new file is half as many bytes to read. Time to first audio of OmniVoice is the whole line (the worker returns each line whole).

**How it is made.** `node packaging/build-release.mjs --packages omni --models hf ...` builds it from scratch (a fresh pip install of the hash-locked environment, the pinned model files, the private
bucket's current lists and clips). The pack's contents have not changed since 0.2.1 (the packs are "reused unchanged", below), so the 0.2.9 file was made from the existing zip with
`node packaging/rebuild-omni-pack.mjs --from <OmniPack zip> --out <folder> --version 0.2.9 --python <app/omni/python/python.exe of an installed pack>`: it extracts the entries it keeps (each checked against its
CRC-32), converts the model (the old file must be the pinned upstream file), applies the same leave-out rules, writes the notices, marker and install note the way the builder does and writes one sorted
zip with the builder's writer (`OmniPack-OmniVoice-0.6B-<v>.zip` and `.files.json`). It stops when the old pack already holds a clip the Runtime carries. `packaging/omni-pack-rules.test.mjs` covers the rules, the pins and a
small synthetic pack through the tool.

### OmniVoice for AMD (seven small packs in `voice/amd/`, 0.3.4)

AMD players press Settings > Voices > OmniVoice for AMD > Install, and the bridge downloads **one pack for the card's family** from Hugging Face, `voice/amd/OmniAMD-<family>-PyTorch-<v>-ROCm-<v>.zip`
(decided by the owner on 28 Oct 2026), unpacks it into `%LOCALAPPDATA%\AiNpcCyberpunkMod\data\amd\` and tests it (docs/OMNIVOICE_AMD.md). The packs hold AMD's ROCm PyTorch wheels unchanged;
AMD's index (`https://stable.repo.amd.com/rocm/whl-next/`) stays as the fallback when a pack is missing or wrong. They are not part of a release build (no entry in `release.config.json`, not in the
Runtime, not on Nexus): they are built and uploaded when the pinned PyTorch changes, and at the first release that has the button.

What a release carries is the pinned list `bridge/omni-amd-wheels.mjs` and the pack list `bridge/omni-amd-packs.mjs` (both modules, so they ship with the bridge's import closure in the Runtime, no `appData` entry).
Before the release that has the button, or whenever AMD's PyTorch changes:

1. `node packaging/resolve-omni-amd.mjs` (metadata only: HTTP range reads of each wheel's METADATA and the 27 KB `rocm` source package; about a minute). It follows AMD's Requires-Dist lines for
   `torch[device-<gfx>]==ROOTS.torch`, `torchaudio`, `torchvision[device-<gfx>]` for the pack's Python (`cp311`, `win_amd64`) and every family in `TARGETS`, leaves out what the pack has (`FROM_PACK`)
   and records size, unpacked size and AMD's ETag (an MD5 the game checks for files uploaded in one part). A newer PyTorch from AMD means changing `ROOTS` in the script (and checking it still pairs with
   the pack's libraries: docs/OMNIVOICE_AMD.md, omni-requirements.txt). The pack names follow `ROOTS.torch` (PyTorch 2.14, ROCm 10.1), so a new PyTorch gives new file names and old players' packs are never overwritten.
2. `node packaging/build-omni-amd-packs.mjs --plan` shows the packs and their sizes (nothing is downloaded): gfx1201 1480 MiB, gfx1200 1541, gfx1100 1500, gfx1101 1496, gfx1102 1494, gfx1030 1062, gfx1031 1062,
   about 9.4 GB to upload, about 3.0 GB downloaded from AMD because the same torch and ROCm files are in several packs.
3. `node packaging/build-omni-amd-packs.mjs --out <folder> [--target gfx1201,gfx1100] [--downloads <folder>] [--no-list]` downloads each family's files from AMD (resumed, size and checksum checked, shared between
   families), writes `OmniAMD-<family>-PyTorch-<v>-ROCm-<v>.zip` (files stored whole in the pinned order, then `omni-amd-pack.json` with each file's size and SHA-256; the same files give the same zip), reads it
   back, and writes each zip's size and SHA-256 into `bridge/omni-amd-packs.mjs` (`--no-list` only prints them). The pinned list may stay without `--hash`: the pack's SHA-256 is what the game checks.
4. `python packaging/upload-packs.py --version <release> --pack omni-amd --packages <folder>` uploads every `OmniAMD-*.zip` in the folder to `voice/amd/` (`--dry-run` lists them) and checks the sizes on Hugging Face.
   The Hugging Face token comes from the environment as for the other packs and is never printed.
5. Commit the changed lists **after** the upload (a list that names a pack that is not on Hugging Face only costs the player the fallback to AMD, but keep it true). The model card (`packaging/HF_MODEL_CARD.md`)
   already describes the `voice/amd/` folder.

`bridge/omni-amd-setup.test.mjs` checks the list's shape (every family has torch, torchaudio, torchvision, the rocm SDK core, libraries and device parts, https URLs on AMD's host, nothing from the pack) and that
a pack list entry matches the pinned files; `packaging/build-omni-amd-packs.test.mjs` covers the builder. The two exchange files (`omni-amd-command.json`, `omni-amd-state.json`) are in
`packaging/runtime-exchange.json`. Nothing is added to the OmniVoice pack or the Runtime update zip beyond the two small lists. ROCm's libraries are open source under their own licences (the wheels carry them
inside, and the packs keep the wheels whole); check them once before the packs go public.

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

**Since 0.2.9 the rule is stricter: the Runtime and the Scripts ship NO file a pack ships**, not even byte for byte (`check-pack-overlap.mjs check` is strict by default; the install note, the same
574 bytes in every package, is the one exception). Now the Omni clips the Runtime carries are left out of the pack, the Local AI and Mature packs carry no copy of the engine the Runtime carries, and the listing of the rebuilt packs (`packs-0.2.9.json`) with the Runtime's files in the pack
folders (`runtime-0.2.9-pack-folders.json`) is tested for it. The packs may still share files with each other (the embedding model and the licence texts, so each works alone): that is byte
for byte the same, never involves the Runtime, and is the same as before.

Also true, and checked: the Runtime and Scripts put nothing in a tree only the OmniVoice pack writes (`app/omni/python/`, `voicestudio/`,
`model/`); the 0.2.1 Runtime's three unused `voices/full-cast-draft/<key>/reference.wav` clips (coach-fred, jim-jarry, life-coach; the pack has them
for its older lists) are left out (`RUNTIME_DROPS`); the five packs share files only byte for byte (the Local AI and Mature engine files, the licence texts); and
the install note (`INSTALL_NOTE` in `build-release.mjs`) is the 574-byte text the Mature packs already contain, so it is fixed until
the packs are rebuilt.

**Checking a build.** `node packaging/check-pack-overlap.mjs check <zip>...` reads only the zip's directory and compares every shared path
with `packaging/pack-listings/packs-0.2.9.json` (path, size and CRC-32 of the five packs rebuilt for 0.2.9; `--listing` names another, and `--allow-identical` is the old lenient rule, used with
`packs-0.2.1.json`, whose packs the old Runtimes share files with); it exits 1 and groups the offenders by folder. It reads ZIP64 directories (the OmniVoice pack is one) and also fails a zip that holds one path twice with different bytes (a
patched zip can; `ZipWriter` refuses it); a pack with a path twice cannot be listed. Run it on every Runtime and Scripts zip before upload. `packaging/pack-overlap.test.mjs` runs the same comparison on the real Scripts
build and on the 0.2.1 Runtime's shared files (`runtime-0.2.1-shared.json`, to show the cause and the fix). When the packs are
rebuilt, remake the listing from Hugging Face without downloading them (HTTP range requests: the directory of the 6.5 GB OmniVoice pack is
3.5 MB; a URL is a pack's resolve/main/<folder>/<file> link on the Hugging Face page, public, no token):

```
node packaging/check-pack-overlap.mjs listing packaging/pack-listings/packs-<version>.json OmniPack=<zip or URL> LocalAI-Standard=<zip or URL> LocalAI-Lite=<zip or URL> Mature-Standard=<zip or URL> Mature-Lite=<zip or URL>
```

**Checking what a Runtime must contain.** `node packaging/check-runtime-contents.mjs <Runtime zip>...` reads only the zip's directory and fails when V's voice clips (`voices/v-voice/`: the manifest and the clips `assets/v-voice/v-voice.json` names) or the Runtime's own OmniVoice lists in `app/defaults/` are missing (the names come from `packaging/lib/runtime-required.mjs`; the 0.2 and 0.2.1 Runtimes shipped without the clips). `packaging/test-release-install.mjs` checks the same on the extracted install and loads the clips with the packaged bridge's own loader. Run it beside the overlap check on every Runtime zip before upload; `packaging/runtime-contents.test.mjs` keeps both from drifting.

**Removed in 0.2.3:** the double-click `Make support report.bat` (with its bridge entry and offline report code) is no longer built or shipped, because players are not comfortable running a batch file; the in-game report and the automatic error reports are the report paths (`packaging/support-report-packaging.test.mjs` keeps it out). Players use Generate report in the game (Settings > Help). The three paths (`Make support report.bat`, `app/bridge/make-support-report.mjs`, `app/bridge/offline-support-report.mjs`) are in `packaging/runtime-removals.json` since 0.2.9, so a full Runtime extracted over a 0.2.2 install deletes them at the next start too (the 0.2.2 to 0.2.3 update step had them in its comparison list already). No Runtime or Scripts zip carries a `.bat`, `.cmd` or `.vbs` file (`packaging/runtime-contents.test.mjs`).

**What the Runtime leaves out (0.2.9).** Files nothing loads, found by reading the code that runs and by looking at what the voice and microphone workers load. The rules are in `packaging/lib/runtime-prune.mjs`, used by `build-release.mjs` and pinned by `packaging/runtime-prune.test.mjs`:

| Left out | Size and files in the 0.2.8 Runtime | Why nothing loads it |
|---|---|---|
| `app/python/Lib/site-packages/Scripts/` (the sherpa-onnx-core wheel's data folder: `onnxruntime.dll`, the sherpa-onnx C and C++ API DLLs and import libraries) | 8.4 MB zipped, 22.5 MB, 5 files | Byte for byte what `sherpa_onnx/lib/` holds, and `sherpa_onnx` loads that folder. Nothing in the repository or in the packages names `Scripts/` (pip's `RECORD` lists it, which only an uninstall reads). |
| `app/python/Lib/site-packages/torch/bin/` (`fbgemm.dll`, `asmjit.dll`) | 1.3 MB zipped, 6.1 MB, 2 files | Identical to the two in `torch/lib/`. `torch/__init__.py` puts `torch/lib` (never `torch/bin`) on the DLL search path and pre-loads every DLL in it. |
| `tests/` folders inside the Python packages (numpy, scipy, sympy, networkx, mpmath, setuptools, torch's fx passes and others) | 10.6 MB zipped, 38.5 MB, 2,348 files | A scan of the other 5,541 Python files finds no import of a tests package (only `mpmath.runtests()`, which nothing calls, and a scipy development script). `torch/testing`, `numpy/testing` and `sympy/testing` are real packages other code imports and stay. |
| `app/pocket-tts/` except `pocket_tts/` and `LICENSE` (upstream tests, training code, docs, Docker and CI files, lock file, contributor notes) | 0.8 MB zipped, 1.5 MB, 87 files | The Pocket worker puts the folder on `sys.path` and imports `pocket_tts` only. The build still checks the whole upstream tree against the pinned digest and the list in `bridge/pocket_voice_runtime.py`; the worker's own source check (`source_shipped()` there) looks at the 53 files that ship and ignores the rest. |
| `app/node_modules/playwright-core/bin/` (17 `.ps1` and `.sh` scripts that `playwright install` runs) and the TypeScript declarations (`*.d.ts`) of `playwright` and `playwright-core` | 0.4 MB zipped, 2.1 MB, 25 files | The bridge never installs a browser (it starts the system Edge or Chrome) and Node never reads `.d.ts` files. |

The OmniPack is not changed by this: its Python (3.11, CUDA torch) is built by the same installer but nobody has run OmniVoice without these files, so it takes the same rules at its next rebuild, after a run on a CUDA machine (`torch/bin` and the tests folders are there too: 15.2 MB and 4,096 files).

How it reaches a player who has the files: the update zip's removal list holds every path the old Runtime had and the new one has not (about 2,400 paths for this change), the start step deletes them one by one under the folders a Runtime installs into (`app/python/`, `app/pocket-tts/` and `app/node_modules/` are all under `app/`) and removes the folders it empties. A list this long is applied within one start (the budget is eight seconds and the rest waits for the next start; `packaging/runtime-prune.test.mjs` runs the chain on fixture zips, and `packaging/test-release-install.mjs --update-from` runs it on the real ones). A player on an older Runtime who extracts the full Runtime keeps the old files (extracting adds, never deletes) and they are harmless. What is not removed from an existing install: the Lua files the Scripts zip no longer carries (`devOnlyLua`, below), because the start step only deletes under the Runtime's folders.

### Runtime update zip

From 0.3.4 the code is in the Scripts and a release ships a Runtime update zip only when it changes the base (and raises `runtimeBase`); the chain
below works as before for those, and removal lists never delete code ("Code in the Scripts").

The Runtime is about 1 GB and most of it (Python, torch, Node, the voice and lip-sync models) does not change between releases. From 0.2.3 on, every
release ships a **Runtime update zip** on Hugging Face, in the `updates/` folder of the repository (from 0.2.8; every step is kept and `updates/README.md` lists them), named `Runtime-Update-<from>-to-<to>.zip` (the first:
`...-Update-0.2.2-to-0.2.3.zip`). A player applies the update zips of the folder one by one, starting from their version, each extracted over their Runtime (Replace is safe: a zip holds only paths whose bytes
differ, and the packs rule above still holds); a new install, or a player who is not sure of the version, uses the full Runtime, which stays. The Scripts are
small and always full.

**What is in it.** Every file the new Runtime has and the previous one did not, or has with other bytes (path, size and CRC-32 are compared, so it does
not matter how either full zip was made); the new `app/release.json`; and `app/defaults/runtime-removals.json`, the removal list.

**Step markers (added 2026-10-22).** An update zip is a difference, so a player who applies only the last one has a `release.json` that looks right and files that are not.
Every Runtime therefore carries small markers in `app/defaults/runtime-steps/` (`bridge/runtime-steps.mjs`): the full Runtime writes `base.json` (`{"base": "0.2.8"}`, written by
`build-release.mjs`), and every update zip adds its own `step-<from>-to-<to>.json` (`{"from": "0.2.7", "to": "0.2.8"}`, written by `build-runtime-update.mjs`, which never copies
the markers of the two full Runtimes it compares). The files differ per step so applied zips never overwrite one another: the folder lists the steps applied so far. The setup
check (`bridge/setup-check.mjs`, row `versions`) walks base, step, step and compares where the chain ends with `release.json`: a break gives `chain-gap` with the missing
step named (the next marker's `from`, or the Runtime version), a marker newer than `release.json` gives `chain-order`. The in-game text tells the player to apply the update zips
from the Hugging Face updates folder one by one, starting from their version (no version number in the instruction). A Runtime from before the markers (0.2.8 and older) has no
`base.json`: its first step's `from` starts the chain, so only a gap after that is seen. **Any other tool that builds update zips** (the scratch patch builder outside the repository)
must add `app/defaults/runtime-steps/step-<from>-to-<to>.json` with `{"from", "to"}` (the Runtime versions of the two full Runtimes) to every zip, and must not copy `base.json` from either full Runtime.
Two cases the markers cannot see: a player on 0.2.8 or older who skips the FIRST marked zip (the chain then starts at the next one; the code-file list `runtime-code-files.json` of the error reports partly covers it), and a rollback (an older full Runtime extracted over a newer one leaves the newer step files; since 28 Oct 2026 the row stays `match` then, because the base marker the full Runtime wrote is the Runtime's own version and the replaced files are all that version ships. Before that the row read `chain-order` and extracting the full Runtime again could not clear it). `chain-order` is left for an older update zip applied after a newer one: its text says some files come from a newer update and to apply the zips in order or extract the full Runtime again, and the full Runtime now clears it.

**Removing what a version no longer ships.** Extracting adds and replaces but never deletes, so a file the new version dropped (a renamed voice clip, a retired
model) would stay in the player's folder. The player never deletes anything: the service does, at its next start, from the list.

- **The code list** (added 2026-10-22) is `app/defaults/runtime-code-files.json`, the hashes of the Runtime's own code files (`bridge/`, `launcher/`, `assets/`; docs/ERROR_REPORTS.md, "Runtime files that are not ours"). `build-release.mjs` writes it last; it is not part of the removal logic and changes at every release, so every update zip carries it.
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
list; `--listing <file>` or `--no-listing` chooses the optional-pack listing (default `packaging/pack-listings/packs-0.2.1.json`). It writes the zip and `<name>.files.json` (path, size, SHA-256
of every file, like the full builds), prints the counts and the SHA-256 of the zip (no loose checksum file), and gives the same bytes for the same inputs. A removed path that the start step may not delete
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

### Files the game rewrites (Vortex)

No package ships a file that the game or the service rewrites while playing. Vortex records every file it installs and, at the next
deploy, asks about each one that changed outside it; the Scripts package used to carry about 70 empty placeholder files in `runtime/`
(and the Runtime an empty `launcher.log`) that the mod rewrote at once, so a Vortex player was asked about all of them. Now:

- **The Scripts package ships one file in `runtime/`:** the static `README.txt` (`RUNTIME_FOLDER_NOTE` in `packaging/lib/runtime-exchange.mjs`).
  The folder has to exist because CET lets the Lua open files only inside its mod folder and `io.open` does not create folders; the note is
  written by nobody, so the mod manager never sees it change. No package ships `runtime/native-off.txt` (only a person edits it; a missing file
  switches nothing off) or a `launcher.log` (the launcher creates it beside its own DLL, in the Scripts' code folder).
- **The rule, for both packages.** No file in the Scripts zip or in a Runtime base zip is ever written, replaced or deleted by the mod, the launcher,
  `install-code.mjs` or the service. `shippedButWritten` (`packaging/lib/package-writes.mjs`) lists every shipped path one of those writers touches:
  `runtime/` besides the note, `launcher.log` (code folder and plugin folder), the Runtime's code copy and its list and error note, `.old-<pid>` and
  `.code-<pid>.tmp` leftovers, code files `code.json` "removes" or a removal list deletes, `GAME_REMOVALS` of the game, an older Runtime's two DLLs
  (`RETIRED_DLLS`, which the launcher renames to `.retired`), and the mod's first-name folders (`migrate-legacy.mjs`). Both package builders refuse to finish
  with a hit. `install-code.mjs` and the launcher only ever read the Scripts' own files (`code.json`, `app/`, the DLLs, the installer): the shipped DLLs are
  never renamed, only an older Runtime's. `packaging/vortex-no-rewrites.test.mjs` builds the real Scripts lists for 2.5 and 2.31, crosses them (and a
  Runtime base list) with every writer's list, runs `install-code` over the extracted Scripts and a base and compares every shipped file before and
  after, and reads the launcher and native plugin sources for what they write.
- **What Vortex checks** (Nexus-Mods/Vortex, read 2026-10-28): at each deploy `checkForExternalChanges` (`mod_management/util/externalChanges.ts`) asks the
  deployment method `externalChanges` (`mod_management/LinkingDeployment.ts`) about every file in the LAST deployment manifest only. For the hardlink
  method (`hardlink_activator/index.ts`, `isLink`) a file is intact when `nlink > 1` and its inode equals the staged file's. So: a file written IN PLACE
  keeps its inode and raises nothing (the staged copy changes with it); a file REPLACED (temp file renamed over it, which is what every writer of ours does)
  has a new inode: "File content modified" (`refchange`, default action "Use newer file"); a file DELETED: "Links were deleted" (`deleted`, default "Revert
  change (restore file)", which links it back); a staged file deleted: "Source files were deleted"; a NEW file nobody deployed raises nothing (not in the
  manifest), which is why writing new files is fine. The dialog is "External Changes": "Mod files were changed outside Vortex. You can undo these changes now
  or apply them permanently." with the buttons Cancel and Confirm, and per type "Save change (use deployed file)" / "Revert change (use staging file)" / "Use
  newer file" (and "Save all changes" and the like for every file at once).
- **A base Vortex installed from 0.3.3.** Its code files, the two old DLLs (renamed by the launcher) and, on 2.5, the guard archive are files Vortex
  deployed, so the first start of 0.3.4 and every later release that changes code makes Vortex ask once (install-code replaces by rename). Writing those code
  files in place would avoid the question for hardlinked files but is not atomic, so it is not done; the player picks "Save all changes".
- **Every file is created at its first write.** Every Lua reader tests the result of `io.open` and every Node reader treats a missing file
  like an empty one, as they did before the placeholders (`bridge/startup-exchange-placeholders.test.mjs` starts a real bridge over no
  exchange files at all, and over empty ones, which is what an older install still has).
- **`runtimeWrittenShipped`** (`packaging/lib/runtime-exchange.mjs`) lists anything in a package's `runtime/` besides the two static files, and
  `launcher.log`; `scriptsPackage` and `runtimePackage` refuse to finish while it is not empty, and `scripts-package-layout.test.mjs` and
  `runtime-exchange.test.mjs` check the built zip and the function. A new rewritten file needs no packaging step; a file that ships
  must not be one the game writes.
- **Updates.** An install made before keeps its empty files: nothing deletes them, they are rewritten in place as always, and a new
  Scripts zip does not touch them (it does not contain them). The Runtime update zip is built from two Runtimes, so `launcher.log` is
  simply not in it (it is in `PROTECTED` of `apply-removals.mjs`, so the removal list never deletes an old one).
- **Mod Organizer 2.** The first write of such a file lands in Overwrite, like every other file the Runtime and the packs create there.
  The next section describes why the files were once shipped; it is the history of the earlier design, which the Vortex change gave up. The
  parts of it that are still in force are the rules for code that touches an exchange file and the state restore. Not tested on MO2 since.

### Mod Organizer 2: files that exist from the start (earlier design: the placeholders are no longer shipped)

USVFS puts every NEW file created under the game folder in Overwrite (invisible at the next launch), while an existing real file that
is opened for writing, or replaced with `MoveFileExW(REPLACE_EXISTING)` (what `fs.rename` over an existing file does on Windows), stays
in place. So the files the game and the service must share inside the game folder had been made to exist in the packages, and both sides
only ever modify or replace them (no player usvfs log was available; the design works with or without one).

- **`packaging/runtime-exchange.json`** classifies every `runtime/` file name the shipped Lua and the bridge use: `exchange` (about 70
  files; **no longer shipped**, they were empty placeholders in the Scripts package), `state` (settings, chat history, witness
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
- **`launcher.log`** (opened with `CREATE_ALWAYS` by the launcher in the game process) no longer ships in the Runtime package (it
  used to ship empty beside `launcher.ini`).
- **Help reports** (the bridge's zip reports) are written to `%LOCALAPPDATA%\AiNpcCyberpunkMod\reports` (the parent of the service's
  state folder when that folder is called `data` and sits outside the mod folder; else the old `runtime/reports`). The Help page shows
  the path the bridge published in `runtime/support-paths.json`, and `%LOCALAPPDATA%\AiNpcCyberpunkMod\data` and `...\reports` when
  nothing is published. The in-game short report (service not running) is one fixed file, `runtime/convai-report-lua.txt`, rewritten
  in place.
- **Legacy carry-over** (`migrate-legacy.mjs`): an empty file at the new place is a placeholder and takes the old content in place
  (nothing is displaced); the volatile files it purges from the new `runtime/` are emptied, not deleted.
- **Not covered:** the Lua's own temp-file, backup and swap protocol for the `state` files is unchanged (what it leaves in
  `runtime/` is kept by the service's copy, see "the player's state" below); the `.native-tmp` file of the optional native plugin's atomic write; the Audioware reply
  bank (`r6/audioware/CyberpunkConvai`, shipped by Runtimes before 2026-10-22) already shipped its slot files and `speech.yml`, and only the transient `reply-pre-*.tmp` was new;
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
  `runtime/state-restore.json` exchange file (created by the service; not shipped since the Vortex change). Runtime: `bridge/game-state.mjs` (new), `bridge/file-wake.mjs`, `bridge/convai-bridge.mjs`,
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
  bridge get real paths. The optional packs are looked up at their virtual place (`app/local-ai`, `app/omni`), so a pack installed
  as its own MO2 mod is found; how each is then used is under "Packs and MO2" below. The bridge and every Node process it starts get the same fallbacks through
  `NODE_OPTIONS=--import=<file URL of usvfs-compat.mjs>`: the supervisor drops any inherited `NODE_OPTIONS` and puts back only that one
  module, named in `CYBERPUNK_CONVAI_USVFS_IMPORT` (`usvfsCompatImport`). The bundled Pythons' `python3XX._pth` lines become absolute
  real paths (`pinPythonPaths`; the package text is kept beside it as `python3XX._pth.package`, so a moved MO2 instance is pinned
  again and an update's file is taken as the new package text). The `View:` line says `(stat fallbacks on)` and
  `the Runtime is in an MO2 mod folder (<real app>, started as <virtual app>)`.
- **Update zips and language packs as separate mods (investigated 2026-10-22, from the code; not run in MO2).** The service runs from the REAL folder of
  the `launcher/start-service.mjs` the virtual file system serves (`appDirectory` in `start-service.mjs`), and it imports its own files from there, because the bundled
  Node's `stat` cannot see a file that exists only in a mod folder. So: (a) a Runtime update installed as its own mod whose zip does not hold `start-service.mjs` (the
  usual case) leaves the base Runtime's `bridge/` and `launcher/` in use and the update's changed files are never read: the Scripts and Runtime versions then disagree
  (`release.json` is read from the base Runtime) and the setup check shows the mismatch; (b) an update that does hold `start-service.mjs` makes the service run from the
  update mod's folder, where the unchanged siblings do not exist: `install-incomplete`; (c) the multilingual packs and PocketTTS models are read from the Runtime
  mod's own `voices/` folder (`referenceDirectory`, the real folder), so a pack in a mod of its own is not found and that language silently stays English. The Local AI, Mature,
  OmniVoice and microphone packs ARE looked up at their virtual place and used from their real one, so they can be separate mods. What is done about it: the setup
  check's Mod manager note and the versions row tell a Mod Organizer 2 player to extract update zips (and language packs) into the Runtime's own mod folder (`mo2Hint` in
  `mod/setup-check.lua`), and the README says the same. Not done: layering several Runtime mods (a loader that resolves every import through the virtual path) needs a live
  MO2 test, and the MO2 test instance was not run in this pass. A live check owed: install an update zip as its own mod, start the game, read the setup check.
- **A file that exists twice (2026-10-22, `packaging/usvfs-shadow.test.mjs`).** When a path is a real file in the game folder and MO2 holds a
  copy in front of it (a mod with the same path, or Overwrite, where the game and the service put every file they created before an install
  shipped its placeholders), open, read, write and rename reach the copy in front while Node's plain `stat` answers for the real file: its
  size and time never change (a support report showed 14 exchange files with the install day's time and a day-old content; reproduced in an
  MO2 test). The request poll (`tick` in `convai-bridge.mjs`) skips the read while the stat of `runtime/last-input.json` is the one it saw, so
  no turn was ever read and the game said the service did not get the message. Under usvfs `stat` (sync, callback and promise forms, not
  `lstat`) now asks an opened handle first, which answers for the file the process can open; `shadowedFiles` lists the doubled files of
  `runtime/` in `bridge-service.log` at start (`Mod Organizer 2: N file(s) of runtime/ exist twice ...`). The fix for the player is also to
  clear the copy: delete the Scripts' `runtime/` files from MO2's Overwrite folder (or the older mod), so one copy is left.
- **Bridge writes across drives (2026-10-22).** The bridge writes its files to a temporary name and renames it over the placeholder. A new
  file under the game folder goes to MO2's Overwrite, so with the game on one drive and MO2 on another the rename fails with EXDEV (seen in
  the same MO2 test). `atomicFile` (`bridge/guarded-file.mjs`) then writes the placeholder in place and removes the temporary file.
- **Packs and MO2.** The Local AI, Mature and OmniVoice packs work as their own MO2 mods (their roots are resolved separately); the OmniVoice
  pack's voice clips under `voices/` are found only when that pack is merged into the Runtime's MO2 mod (or installed in the game folder),
  because `voices/` is read from the Runtime's real folder.
  - **Local AI and Mature packs are resolved file by file (2026-10-20, `packaging/mo2-split-packs.test.mjs`).** Every pack unpacks into the same
    `app/local-ai` (`manifest.standard.json`, `manifest.mature-standard.json`, `models/`, `llama/`), so under MO2 the packs are usually separate
    mods that USVFS merges into one virtual folder. Mapping that folder with `locate()` / `realpathSync.native` gives ONE mod's real folder (the
    mod that wins for the folder), and the service read the pack from there: the other mod's marker and model were invisible (with Mature on
    one model in the row, with Mature off "Only Mature models found"). Now `start-service.mjs` hands the bridge the VIRTUAL `app/local-ai` in
    `CYBERPUNK_CONVAI_LOCAL_AI` (the stat fallbacks list and read it merged, so every marker is found whichever mod holds it) and the pack
    modules (`bridge/local-ai-pack.mjs`, `bridge/mature-pack.mjs`, the mod folder of `bridge/custom-models.mjs`) map each file a manifest names to
    its own real place with `realPathFor` (the file's `realpathSync.native`, only when `CYBERPUNK_CONVAI_USVFS=1`; the identity otherwise, so a
    physical install is unchanged). The engine processes get real absolute file paths. `llama-server.exe` and its DLLs must be neighbours in one
    real folder (Windows looks beside the real exe): if both packs ship `llama/` and MO2 would give the exe from one mod and a DLL from the
    other, the server is taken from the folder with the most of the DLLs the merged `llama/` lists (the winning exe's folder, else the folder
    of any marker that names a server; ties go to the winner). OmniVoice is one pack in one mod, so its real root is kept.
  - **The engine is a Runtime file, so it is never split (2026-10-21).** `app/llama-cpp/` is in the Runtime's own mod folder; the service gives the bridge
    its real path (`CYBERPUNK_CONVAI_LOCAL_ENGINE = layout.engine`, from the real `appDirectory`), the server, its DLLs and `llama-fit-params.exe` are neighbours there whatever
    mods the packs are in, and the file-by-file DLL choice above only matters for an old pack that still carries its own `llama/`. The packs' merged virtual folder is
    still handed over as before for their markers and models (`packaging/engine-in-runtime.test.mjs`, the MO2 cases: both models-only packs on the Runtime mod's engine, a Mature pack
    alone, old packs beside the new Runtime mod, and old packs without it).
  - **Voice-input (microphone) packs are resolved the same way (2026-10-20, `packaging/mo2-mic-packs.test.mjs`).** MicPack-European and MicPack-Asian unpack
    into `app/models/stt/<id>`, which the service used to read only from the Runtime's own real app folder, so a pack installed as its own MO2 mod was
    missed. Under MO2 `start-service.mjs` now puts the VIRTUAL `app/models/stt` in `CYBERPUNK_CONVAI_STT_PACKS` (`layout.sttPacks`; set only
    then, a physical install adds no field and no variable), where every mod's `<id>` folders are listed merged. `resolveLocalSttPaths`
    (`bridge/local-stt.mjs`, with `CYBERPUNK_CONVAI_USVFS=1`) maps each model file to its real place with `realPathFor`, then picks the real folder
    that holds the most of the model's files (each candidate folder is asked for all of them itself, so a stray file of the same model in a mod of
    higher priority cannot hide a complete model; a tie goes to the folder of the model's first file) and gives THAT folder to the Python worker, which
    reads all of a model's files from one folder. A model complete in no single folder is reported unavailable (`model-missing`), as an
    incomplete download is. The Runtime's own `models/stt/<id>` (a pack merged into the Runtime's mod) is still the second place looked at. The service
    log has `Mod Organizer 2: voice-input pack models, where each runs from (...)`: one line per pack found, with its real folder and whether all its files are in it.
    The English model (Moonshine) is part of the Runtime and is unchanged.
  - **The voice workers (Pocket, V's helper, OmniVoice)** check that their assets lie inside their folders and that no link redirects them.
    Both used to compare `Path.resolve()` results, and under USVFS the resolved path of a file is the mod folder that holds it, which is not
    where its folder resolves to when the folder is a merge of several mods (an update mod over the Runtime), and the OmniVoice pack is a mod
    of its own, outside the Runtime's folder. A player on MO2 (0.2.4, same code in 0.2.5) got no voice at all: Pocket "export asset is missing
    or linked", OmniVoice "Portable voice assets must remain in the application directory". Now, when `CYBERPUNK_CONVAI_USVFS=1`
    (every process the service starts under MO2), both workers compare the paths as spelled (absolute, `..` collapsed, never resolved) and
    still refuse a symlink or junction inside the Runtime's `app` folder; the pinned SHA-256 checks read the real bytes as before. The OmniVoice worker also
    takes the pack's own folder as a second approved root for its model, adapter and Python package: `start-service.mjs` names it in
    `CYBERPUNK_CONVAI_OMNI_PACK` (`serviceEnvironment(..., {usvfs})`; only under usvfs), and the persistent voice data must stay apart from it too.
    A physical install sets neither variable and every check is as before. **Links above the `app` folder are accepted** (a junctioned Steam
    library, a moved Documents, OneDrive, MO2, the Runtime root itself): both workers find the resolved `app` folder and refuse only a link
    below it (model folders, packages, Python, the OmniVoice source), a link that leaves it, or a link from outside that leads into it. The player's
    data folders (outside `app`) may sit behind a link but must not themselves be one. Pocket's message names a link inside the app folder as
    "linked directories inside the app folder (junction, N folders above it)"; OmniVoice's is "Linked directories inside the application directory
    are not supported". The portable worker still refuses an OmniVoice package outside the pack. Tests: `scripts/test_pocket_voice_runtime.py` (`UsvfsPaths`),
    `scripts/test_resident_voice_paths.py` (`UsvfsVoicePaths`, `AppLinks`), `scripts/test_pocket_voice_runtime.py` (`AppLinks`), `packaging/mo2-voice-workers.test.mjs`, `bridge/pocket-voice.test.mjs`. The phone-analysis worker is unchanged: nothing in the
    player install writes its `phone-analysis.json`, so it is not started for players.
  - **Where the files were found** is in the service log (`Mod Organizer 2: Local AI pack files, where each really is (...)`: one line per marker,
    model, the server with whether its DLLs are beside it, the embedding model) and in the support report's `localAi.packFiles` (`foundIn`: the MO2
    mod folder's name, never a path; `engine`: the server's and the embedding model's mod and whether the DLLs sit beside the server). A physical
    install has none of these fields.

- **No path comparison on the start path.** `installLayout` (`prepare-state.mjs`) takes the game's folders from `--game-root` and the
  Runtime's from the script's own place; nothing resolves a link or compares a resolved path with the game root.
  `packaging/runtime-layout.mjs` (`realpath`, "cannot redirect into another location") belongs to the bootstrap route
  (`Runtime-Service.mjs`), which `launcher.ini` never starts. The voice workers' checks (`pocket-voice.mjs`, `phone-analysis-config.mjs`,
  `resident-voice.mjs`) canonicalize both sides alike and run only once the bridge is up. The Python workers' own path checks
  (`bridge/pocket_voice_runtime.py`, `bridge/resident-voice-worker.py`) compared `Path.resolve()` results, which under MO2 differ (below, "The voice workers").
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

**No Convai key is built into the Runtime** (from 0.2.9; up to 0.2.8 it was `app/defaults/service.txt`). The Runtime carries the token
backend's address and client request secret instead, as `app/defaults/convai-auth.json`
(`{"version": 1, "enabled": true, "url": "https://<backend>/api/convai/token", "secret": "...", "fallback": false}`), and the bridge
signs in to the shared Convai account with short-lived tokens from that backend (docs/CONVAI_AUTH_BACKEND.md, "Build status (2026-10-22)").
The build reads them from `CONVAI_AUTH_URL` (a repository variable in CI) and `CONVAI_AUTH_CLIENT_SECRET` (a secret), or from
`--auth-url` and `--auth-secret-env NAME`; a non-dry-run build of the Runtime without both fails, and `--key-env` / `--key-file` are
refused. The secret is never printed. It is not the error reports' secret: `app/defaults/error-reports.json` is a separate file that the
owner adds by hand. The bridge limits turns on the shared account per day (docs/OWN_CONVAI_KEY.md, "Daily limit on the shared plan").
A plain `data/convai-key.txt` (format `api-key = ...`) is a developer's or a player's own key: it is used directly, with no backend and no
daily cap, unless the data folder's `convai-auth.json` (or the environment) switches the backend on. A player's own key set in the settings
is unaffected. A `convai-key.txt` that holds the packed key of a release up to 0.2.8 is removed at the next start, and the old
`defaults/service.txt` is deleted through `packaging/runtime-removals.json`. Do not describe the shared account's sign-in in player-facing text.

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
- Kept on purpose under the old name: `r6/scripts/CyberpunkConvai` (redscript compiles before
  RED4ext, so a renamed folder would give duplicate classes on an update-over install); `r6/audioware/CyberpunkConvai` was kept the same way
  while it still shipped.

## Building

`packaging/build-release.mjs` packages a git commit (default `HEAD`, exported with
`git archive` and `core.autocrlf=false`), never the working tree, so uncommitted work cannot slip
into a release. Inputs:

- `packaging/release.config.json`: pinned toolchain URLs and SHA-256 values (Node 24.21.0,
  CPython 3.12.10 and 3.11.9 embeddable, pocket-tts and
  VoiceStudio revisions, every OmniVoice model file), package layout and limits.
- `packaging/python/*.lock.txt`: every wheel by URL and SHA-256, installed with `--no-deps
  --require-hashes --only-binary=:all:` for the target platform. pip's generated console-script
  launchers, `__pycache__`, torch headers, link libraries and CMake files are left out, and so
  is what "What the Runtime leaves out" (below) lists.
- `packaging/release-data/`: the default character-ID mappings and the three game archives
  (built from game files with WolvenKit, so CI cannot make them).
- Trained models from the private HF bucket `alystria-ai/cyberpunk-pocket-rolling-checkpoints`,
  `final/` (`packaging/fetch-models.py`, every file checked against `final/MANIFEST.json`), or from
  the developer `runtime/` folder with `--models local`. The Pocket export is also checked against
  the hashes in its voice config, and every reference clip against its descriptor.
- The launcher, compiled from `native/autostart` with MSVC (`/Brepro`, reproducible), and the native plugin from `native/core`
  (`--native PATH` supplies a prebuilt DLL, `--no-native` omits it).
- `ffmpeg`, for the pre-built Mistral voice references.
- `vendor/vgmstream/` (git-ignored, from the official vgmstream release; the 11 files pinned in `toolchain.vgmstream`), for the Runtime ("vgmstream in the Runtime" above).
- The Local AI files (llama.cpp release zip, embedding model, chat models), downloaded from their pinned URLs (no secret needed). The Runtime, the Local AI packs and the Mature packs use the same llama.cpp zip and the packs the same embedding model, so those small files are fetched once. A Runtime build needs the llama.cpp zip (36.8 MB) as well; with `--models local` it is read from the developer folder's `dl-llama-vulkan/vulkan.zip` and checked against the pinned hash.
- The optional Mature packs' models (`--packages mature-lite` or `mature-standard`, never in the default set; only the model of the pack being built), from the private bucket's `mature/` mirror
  (`packaging/fetch-models.py --mature --tier lite|good`, SHA-256 checked against `maturePack.tiers`, so a takedown of the community repositories cannot break a build), or from
  their pinned public Hugging Face URLs when the mirror lacks them. `--models local` reads the developer folder instead. `mature/` is outside `final/`, so the
  trained-model fetch never downloads it.

Archives are deterministic (`packaging/lib/zip.mjs`): sorted entries, one timestamp (the commit
time), fixed deflate level, weights stored. The Scripts and Runtime archives each stay under 1.95 GB (GitHub's limit is
2 GiB per asset), a Runtime archive that would pass it rolls over to a `-partNofM` zip, and a single file over that limit stops the build
(nothing is split inside a file any more). The optional packs are always one zip each, written as ZIP64 where needed (`--packages omni`,
`localai-standard`, `localai-lite`, `mature-lite`, `mature-standard`, `micpack-european`, `micpack-asian`). Output:
`dist/release/packages/` with the zips, `*.files.json` (every file's size and SHA-256)
and `release-manifest.json`.

### Local dry run and install test

```powershell
node packaging/build-release.mjs --version 0.2 --dry-run                 # all five packages
node packaging/build-release.mjs --version 0.2 --dry-run --packages scripts,runtime
node packaging/build-release.mjs --version 0.2 --dry-run --packages localai-standard,localai-lite
node packaging/test-release-install.mjs --version 0.2 --packages dist/release/packages [--omni] [--local-ai] [--key-file runtime/convai-key.txt]
node --test packaging/release.test.mjs
```

The dry run uses the developer `runtime/` models and may leave out the token backend's address and secret (a real build of the Runtime may not; nothing ever embeds a key). The install test builds a
stand-in game folder under `%TEMP%` (spaces and non-ASCII in the path), extracts with
`Expand-Archive`, checks every file, then with a PATH of Windows folders only: speaks with the
Pocket voice from the packaged Python, recognises that speech again with the local speech-to-text
worker (packaged Python and `models/stt`), runs the lip-sync model on that audio (and OmniVoice on the
GPU with `--omni`), and loads the real launcher DLL through `native/autostart/test-host.c`, which
must start the packaged service and stop it when the "game" exits. A Runtime built with the backend settings carries no key and no
`defaults/service.txt` (checked), has `convai-auth.json` on without a fallback, and the bridge must report Ready from it; a dry-run build without
them asks for setup instead. With `--key-file` the key is copied as the player's own key (never printed) and the bridge must report Ready. Never point it at
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

**Hugging Face upload.** The omni, localai and mature jobs install `huggingface_hub`, check first (`packaging/upload-packs.py --check`) that the `HF_TOKEN` secret can write to the repository, build their pack, and upload it with `packaging/upload-packs.py --version V --pack NAME --packages DIR` (`HfApi.upload_file`, retried, then checked against the local size). The zip goes to its folder of the repository (`voice/`, `local-ai/`, `mature/` or `mic/`) under its unversioned file name, for example `voice/OmniPack-OmniVoice-0.6B.zip`, and the version `V` is in the commit message only. A token that cannot write fails with a message naming the repository and saying the `HF_TOKEN` secret needs write access to it. The uploader takes the pack's zip by its exact build name and refuses a build in parts or without that zip. The `publish` input also gates these uploads on a manual run (a tag run always uploads).

**Moving to the 0.2.9 layout.** The repository was flat before 0.2.9 (every pack at the root under `AI-NPC-Cyberpunk-Mod-<Name>.zip`, `SHA256SUMS-*.txt` beside them). `scripts/hf-reorganize-0.2.9.py` makes the change in ONE commit: server-side copies (`CommitOperationCopy`) to the folders and names above (including `updates/` and `multilingual/`, whose files lose the prefix, and the Pocket zips that became `PocketTTS-Model-<Language>.zip` (and `PocketTTS-Model-100M-<Language>.zip` since 0.3.4)), deletes of the old paths, deletes of every `SHA256SUMS*` file, and the three README files (`packaging/HF_MODEL_CARD.md`, `HF_UPDATES_README.md`, `HF_MULTILINGUAL_README.md`) written in place of the old ones. It is a dry run by default and prints the planned operations; `--apply` makes the commit (refused when the repository changed since the plan). The token is read from `runtime/huggingface-alystria-token.txt` and never printed. Run it once, right before the Nexus page is updated with the new links (`deliverables/release-0.2.9/NEXUS_LINK_CHANGES.md`). After that the release step adds its own row to `updates/README.md` and uploads the new packs with `packaging/upload-packs.py`.

The optional Mature packs are built by the `mature` job, a matrix of `lite` and `standard` (one runner each; the standard pack carries the model whose tier key is `good`), that runs only when the manual run's `mature` input is ticked (default off; never on a tag push, never uploaded to Nexus or to the GitHub release). Each builds with `--packages mature-lite` or `mature-standard` `--models hf` from the bucket mirror and uploads its zip to Hugging Face. They can also be built and uploaded by hand: `node packaging/build-release.mjs --version 0.N --packages mature-lite` then `python packaging/upload-packs.py --version 0.N --pack mature-lite --packages dist/release/packages`.

The two optional voice-input packs are built by the `micpacks` job, a matrix of `european` and `asian`, that runs only when the manual run's `micpacks` input is ticked (default off; never on a tag push; Hugging Face only). Each builds with `--packages micpack-european` or `micpack-asian` (no secret, no `--models`: the files come from the pinned download) and uploads its zip like the others.

Permissions and secrets: the workflow uses the built-in `GITHUB_TOKEN` with `contents: write`
(no separate releases repository or token). Repository secrets: `HF_TOKEN` (bucket read, and write access to the pack repository) and
`CONVAI_AUTH_CLIENT_SECRET` (the token backend's client request secret); repository variables: `CONVAI_AUTH_URL` (the backend's
address) and, optional, `CONVAI_AUTH_BACKUP_URL` (the second backend, the Cloudflare Worker `auth-backend-cf/`; shipped as `backupUrl` in `convai-auth.json`, empty means one backend). There is no Convai key secret any more. GitHub masks secrets in logs; the builder also masks the client secret (`::add-mask::`) and never
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
(`diagnostics.lua` and the probes it loads, `face-test.lua`, `gesture-probe.lua`, and since 0.2.9 `johnny-probe.lua` with its two feature files `johnny-relic-probe.lua` and `combat-feats-probe.lua`, `fact-identity.lua` and `knowledge-state.lua`), the retired
`KnowledgeState.reds` and the resident phone analyser (not started when the lip-sync model is present).
There is no Rhubarb Lip Sync fallback (owner decision 2026-10-21; shipping it would add 62 MB): the bridge no longer looks for it, the
Runtime does not carry it, and a line the lip-sync model gives no cues for plays on its audio envelope on the developer's machine exactly as on a player's.

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
