# One mod, two game versions (2.31 and 2.5)

The mod is maintained for two Cyberpunk 2077 versions from ONE source tree. A release is built once per game (`--game 2.31` or `--game 2.5`). The two
builds are separate downloads with different names, so a player cannot mix them without the setup check saying so.

| | 2.31 build | 2.5 build |
|---|---|---|
| Game exe | 3.0.80.51928 | 3.0.88.46235 |
| Native plugin SDK | RED4ext.SDK `ad727771` (WopsS) | RED4ext.SDK `b139fcbd` (KelpHect/RED4ext.SDK-psiberx: official #227 plus the #228 layouts) |
| Native plugin declares | `RED4EXT_V1_RUNTIME_VERSION_2_31` | `RED4EXT_V1_RUNTIME_VERSION_2_50` |
| File names | `…-Scripts-<v>.zip`, `Runtime-<v>.zip` | `…-Scripts-<v>-for-2.5.zip`, `Runtime-<v>-for-2.5.zip` |
| release.json `game` | `2.31` (a release.json without the field is a 2.31 build) | `2.5` |

## What differs between the builds (and nothing else)

1. `native/core` is compiled twice (`scripts/Build-NativeCore.ps1 -Game 2.31|2.5`, CMake option `CONVAI_GAME`): the SDK pin, the declared runtime and
   `kGameLabel` change. No source line changed for the 2.5 SDK: the plugin only goes through RTTI, `ExecuteFunction` and the SDK's own types, and it built
   and passed its headless tests against the 2.5 SDK as is. It still needs the in-game check (below).
2. `r6/scripts/CyberpunkConvai/GameVariant.reds` is the only redscript that differs: 2.31 calls Codeware's `GameInstance.GetCallbackSystem()`; the 2.5 build
   replaces the file with `packaging/game-variants/2.5/r6/scripts/CyberpunkConvai/GameVariant.reds`, which passes `GetGameInstance()` (2.5's own
   getters have an optional game-instance parameter, and redscript 0.5.32 cannot resolve a call that leaves it out). Every caller uses
   `ConvaiCallbackSystem()` / `ConvaiServiceContainer()`. If the 2.5 compile shows the no-argument form works, delete the overlay.
3. `release.json` of both packages carries `game`.
4. `mod/setup-check.lua` and `bridge/setup-check.mjs` know both builds (see "Wrong build").

The launcher plugin (`CyberpunkConvai.dll`, plain C, no RED4ext.SDK, declares itself runtime independent) is the SAME file in both builds. Everything
else in the Runtime (Node, Python, bridge, models, voices, archives, llama.cpp, vgmstream) and everything else in the Scripts is byte for byte the same.
So the two Runtimes differ in two files: `red4ext/plugins/AiNpcCyberpunkModNative/CyberpunkConvaiNative.dll` and `app/release.json`. The two Scripts
differ in `GameVariant.reds` and `release.json`. The optional packs (Local AI, Mature, microphone, OmniVoice, language packs) hold no game-dependent
file and are shared.

## Building

```
node packaging/build-release.mjs --version 0.3.1 --game 2.5 --packages scripts,runtime     (2.5)
node packaging/build-release.mjs --version 0.3.1 --packages scripts,runtime,omni,...        (2.31, as before)
python packaging/upload-packs.py --version 0.3.1 --pack runtime --packages DIR --game 2.5   (uploads to game-2.5/Runtime.zip)
node packaging/build-runtime-update.mjs --old <2.5 Runtime> --new <2.5 Runtime> --out DIR   (-> Runtime-Update-<a>-to-<b>-for-2.5.zip)
powershell scripts/Build-NativeCore.ps1 -Game 2.5 -SdkDirectory <RED4ext.SDK checkout at b139fcbd>
powershell scripts/Install-DevelopmentMod.ps1 -GameVersion 2.5 / scripts/Compile-Redscript.ps1 -GameVersion 2.5
```

`--game 2.5` builds only `scripts` and `runtime` (the other packs are refused). An update zip is built within one game (two Runtimes of different games are
refused), and the update chains of the two games are independent (`app/defaults/runtime-steps`).

## Proposed names (to be decided by the owner)

Same version number for both builds (0.3.1 is 0.3.1 for 2.31 and for 2.5), so the packs' "needs the Runtime of 0.2.7 or newer" rules and the step chains
keep working.

Hugging Face (`alystria-ai/ai-npc-cyberpunk-mod-packs`): the root stays the 2.31 build; the 2.5 build has its own folder.
```
Scripts.zip   Runtime.zip   updates/Runtime-Update-<a>-to-<b>.zip              2.31 (unchanged)
game-2.5/Scripts.zip   game-2.5/Runtime.zip   game-2.5/updates/Runtime-Update-<a>-to-<b>-for-2.5.zip
local-ai/  mature/  mic/  voice/  multilingual/                                 shared by both
```
Nexus Mods (one page): two Main files, named so the game is the first thing read, `AI NPC Cyberpunk Mod - Scripts - for game 2.31` (the existing zip) and
`AI NPC Cyberpunk Mod - Scripts - for game 2.5` (`…-Scripts-<v>-for-2.5.zip`), each with its own requirement list in the description. The alternative is a
separate Nexus page for 2.5 (cleaner requirements and tracking, split endorsements and posts).

A player who moves from 2.31 to 2.5 downloads the 2.5 Scripts and Runtime (the 2.5 Runtime is a full zip). A small "switch" zip (the two files that differ)
is possible later if wanted.

## Wrong build

* Scripts and Runtime of one version but different games: `bridge/setup-check.mjs` answers `versions: game-mismatch`; the Help page line names both games and
  the Runtime to get. `start-service.mjs` logs the same.
* Scripts built for one game on the other game: the Help page `Game version` line is a Problem ("These files are the mod build for game X. Install the build
  made for game Y …"). The first-load notice is not changed (a new notice text needs 15 translated, fit-measured versions); the redscript-did-not-load notice
  already names the build's own game.
* A native plugin of the wrong game is refused by RED4ext (next section), so the mod runs on its Lua path.

## RED4ext's behaviour with a plugin built for another game (read from wopss/RED4ext master 47ac01c and tag v1.30.0)

`PluginSystem::Load` does `LoadLibraryEx`, calls `Supports` and `Query`, and compares the plugin's runtime with the exe's file version. A mismatch is one
`spdlog::warn` line ("is incompatible with the current patch") and the plugin's name goes on an incompatible list; the DLL is unloaded before `Main` runs.
There is no dialog. The list is used only when script validation has already failed, then the popup names the plugin. So a wrong-game
`CyberpunkConvaiNative.dll` is silent, registers no RTTI class (the registration happens in `Main`), and cannot clash with the right one. Dual shipping
two DLLs in separate plugin folders would also work for that reason, but one build per game is simpler for players and keeps the file names honest; it is the
fallback if the owner changes his mind. The launcher is runtime independent and loads on both.

RED4ext itself differs per game: v1.30.0 for 2.31, master (minimum game 2.50) for 2.5.

## Requirements per game

| | 2.31 build | 2.5 build |
|---|---|---|
| Cyber Engine Tweaks | 1.37.1 | 1.38.0 (official, "Game version 2.5") |
| RED4ext | 1.30.0 | wopss/RED4ext master 47ac01c or newer: 2.5 support is merged and unreleased (latest official release is v1.30.0 of 2026-03-09, for 2.31). The Codeware 2.5 zip (Nexus 35697) holds only the Codeware plugin; the notes zip says RED4ext is "built unmodified from master 47ac01c". Whether the Nexus page offers a RED4ext file could not be read (HTTP 403). |
| redscript | 0.5.31 | 0.5.32 |
| Codeware | 1.20.5 | 1.20.6 "2.5 Unofficial" (Nexus 35697) |
| Native Settings UI | 1.96 | 1.97 |
| Mod Configuration Menu | 0.10.5 | unknown for 2.5 (no copy on disk) |

2.5 caveats from the modder notes: CET 1.38.0 hangs a NEW game (start the new game without CET, save once, put CET back); the mirror customisation list is empty
in vanilla 2.5; redscript 0.5.32 needs `GetGameInstance()` passed to 2.5's optional-parameter getters (done in the overlay).

## Static audit for 2.5 (no 2.5 game was available)

* Callback and service getters: 14 call sites in Face, KnowledgeState, Manager, PhoneChat, PhoneContacts, now behind the two helpers. Face.reds and
  KnowledgeState.reds call them inside `ScriptableService` code (`OnLoad`, static `Get`): test first that `GetGameInstance()` is valid there on 2.5.
* Codeware-only names Face.reds uses that 2.5 may not provide as before: `DynamicEntityTarget`, `EntityTarget.Type`, `EntityLifecycleEvent`,
  `GetDynamicEntitySystem`, events `Entity/Initialize`, `Entity/Extract`, `Entity/Reassemble`. The 2.5 compile decides.
* Wrapped methods (all `@wrapMethod`, no replace, no native func, no `EquipmentSystemPlayerData`): NewHudPhoneGameController (21 wraps, highest risk),
  PhoneMessagePopupGameController (8), MessengerDialogViewController (4), PhoneContactItemVirtualController (5), PhoneDialerLogicController (2),
  PhoneDialerSelectionController (2), JournalEntryListItemController, AIMoveToCommandHandler.UpdateCommand, GameObject.PlayVoiceOver, PlayerPuppet
  OnGameAttached/OnDetach. A removed target is a compile error that disables every redscript mod; the Phase 2 compile against the 2.5 cache finds it.
* Gates that refuse any game but 2.31 (left as they are until verified on 2.5; the 2.5 build runs without these features): `mod/relationship-state.lua:83` and
  `bridge/relationship-routing.mjs:80` (the 11 romance quest facts: no auto romantic style, no Johnny remarks), `mod/world-knowledge.lua` + `bridge/world-knowledge.mjs`
  + `characters/world-knowledge.json` (every rule and evidence row lists `gameVersions: ["2.31"]`: world knowledge is off on 2.5 until the data is
  regenerated or the rows are checked).
* CET reflection to re-probe live: the AI command classes and navigation calls of companion-actuator/placement, chauffeur and vehicle natives, workspot and
  gesture calls, spatial queries, passage blackboards and door devices, the subtitles chatter controller, phone widget trees.

## In-game check of the native plugin (2.5)

Load the game with only RED4ext + the 2.5 Codeware and this plugin: the RED4ext log must show "CyberpunkConvaiNative … has been loaded" and `ConvaiNative`
must answer `CheckVersion`; then each native system as in `docs/NATIVE_REWRITE_PLAN.md`. The headless tests (`ctest`) and the file inspector run on both builds.
