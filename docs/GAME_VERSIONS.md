# One mod, two game versions (2.31 and 2.5)

The mod is maintained for two Cyberpunk 2077 versions from ONE source tree. A release is built once per game (`--game 2.31` or `--game 2.5`). The two
builds are separate downloads with different names, so a player cannot mix them without the setup check saying so.

| | 2.31 build | 2.5 build |
|---|---|---|
| Game exe | 3.0.80.51928 | 3.0.88.46235 |
| Version of the first release | 0.3.1 | 0.3.1 |
| Native plugin SDK | RED4ext.SDK `ad727771` (WopsS) | RED4ext.SDK `b139fcbd` (KelpHect/RED4ext.SDK-psiberx: official #227 plus the #228 layouts) |
| Native plugin declares | `RED4EXT_V1_RUNTIME_VERSION_2_31` | `RED4EXT_V1_RUNTIME_VERSION_2_50` |
| File names | `…-Scripts-<v>.zip`, `Runtime-<v>.zip` | `…-Scripts-<v>-for-2.5.zip`, `Runtime-<v>-for-2.5.zip` |
| release.json `game` | `2.31` (a release.json without the field is a 2.31 build) | `2.5` |

## What differs between the builds (and nothing else)

1. `native/core` is compiled twice (`scripts/Build-NativeCore.ps1 -Game 2.31|2.5`, CMake option `CONVAI_GAME`): the SDK pin, the declared runtime and
   `kGameLabel` change. No source line changed for the 2.5 SDK: the plugin only goes through RTTI, `ExecuteFunction` and the SDK's own types, and it built
   and passed its headless tests against the 2.5 SDK as is. It still needs the in-game check (below).
2. `r6/scripts/CyberpunkConvai/GameVariant.reds` is the only redscript that differs. It holds three helpers the rest of the scripts call
   (`ConvaiCallbackSystem()`, `ConvaiServiceContainer()`, `ConvaiKeyTarget(key, action)`). The 2.5 build replaces the file with
   `packaging/game-variants/2.5/r6/scripts/CyberpunkConvai/GameVariant.reds`, which differs in ONE function: Codeware 2.31's
   `InputTarget.Key(key, action)` filters by the key's action, 2.5's own `InputTarget.Key(key, <Float>)` has no action parameter, so the 2.5 target
   passes only the key and the three key handlers (Manager, PhoneChat, PhoneContacts) check `evt.GetAction()` themselves (a compare per key event of
   six keys, no per-frame work). The two getters compile unchanged on 2.5 with redscript 0.5.32 (the "no-argument getter" bug of the modder notes did not
   reproduce), so the overlay holds them as in the 2.31 file.
3. `release.json` of both packages carries `game`.
4. `mod/setup-check.lua` and `bridge/setup-check.mjs` know both builds (see "Wrong build").

The launcher plugin (`CyberpunkConvai.dll`, plain C, no RED4ext.SDK, declares itself runtime independent) is the SAME file in both builds. Everything
else in the Runtime (Node, Python, bridge, models, voices, archives, llama.cpp, vgmstream) and everything else in the Scripts is byte for byte the same.
So the two Runtimes differ in two files: `red4ext/plugins/AiNpcCyberpunkModNative/CyberpunkConvaiNative.dll` and `app/release.json` (checked on two real
dry-run builds of 0.3.1: 8,676 files each, 8,662 identical; the other twelve are pip's `*.dist-info/RECORD` files, which differ between any two builds of the same source). The two Scripts
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

## Names (decided by the owner: one Nexus page, two main files, 0.3.1 for both)

Same version number for both builds (0.3.1 is 0.3.1 for 2.31 and for 2.5), so the packs' "needs the Runtime of 0.2.7 or newer" rules and the step chains
keep working.

Hugging Face (`alystria-ai/ai-npc-cyberpunk-mod-packs`): the root stays the 2.31 build; the 2.5 build has its own folder.
```
Scripts.zip   Runtime.zip   updates/Runtime-Update-<a>-to-<b>.zip              2.31 (unchanged)
game-2.5/Scripts.zip   game-2.5/Runtime.zip   game-2.5/updates/Runtime-Update-<a>-to-<b>-for-2.5.zip
local-ai/  mature/  mic/  voice/  multilingual/                                 shared by both
```
Nexus Mods (one page, decided): two Main files, named so the game is the first thing read, `AI NPC Cyberpunk Mod - Scripts - for game 2.31` (the existing zip) and
`AI NPC Cyberpunk Mod - Scripts - for game 2.5` (`…-Scripts-<v>-for-2.5.zip`), each with its own requirement list in the description.

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
| RED4ext | 1.30.0 | the build of wopss/RED4ext master 47ac01c ("RED4ext 1.30.0 Master 47ac01c 2.5 Unofficial", Nexus 35697: `bin/x64/winmm.dll`, `red4ext/RED4ext.dll`; its log says `v1.30.0+master.1.47ac01c`). 2.5 support is merged upstream and unreleased (latest official release v1.30.0 of 2026-03-09, for 2.31). The Codeware 2.5 zip holds only the Codeware plugin. |
| redscript | 0.5.31 | 0.5.32 |
| Codeware | 1.20.5 | 1.20.6 "2.5 Unofficial" (Nexus 35697) |
| Native Settings UI | 1.96 | 1.97 |
| Mod Configuration Menu | 0.10.5 | 0.10.6-hf1 was in the owner's install and loaded on 2.5 (main menu entry, Companion Manager registered); not otherwise tested |

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

## Phase 2 result (2026-10-24, owner's PC, game 2.5, nothing played)

Installed into the Steam folder (backup of every replaced file and of the saves in `backups/phase2-game25-install-<time>/`): CET 1.38.0, RED4ext master 47ac01c, redscript 0.5.32,
Codeware 1.20.6 (2.5), Native Settings UI 1.97, then the 2.5 Runtime and Scripts of 0.3.1 (built with `--game 2.5 --dry-run`) extracted over it like a player.

* RED4ext log: the launcher, `CyberpunkConvaiNative` (0.1.0) and Codeware 1.20.6 load; no "incompatible" line. All nine native systems register their RTTI classes.
* redscript: the mod's 15 files and Codeware 2.5, MCM and the rest compile (`scc invoked successfully, 26809 source refs`); `final.redscripts.modded` is written. The
  one thing 2.5 broke was `InputTarget.Key(key, action)` (three call sites), fixed as above.
* CET 1.38.0 and the mod: no Lua error; MCM hosts the Companion Manager; Native Settings UI 1.97 initialises; the native core binds (`io`, `clearance`, `vehicles`,
  `faces`; vehicle mounting matched the Lua eight times, then went native); the service answers the setup check with versions match and no game mismatch,
  `Setup check: no critical problem`; auto-connect warmed two NPCs.
* A save (made on 2.31 with mods) loads on 2.5 after the game's "mod verification" prompt; no save file was written.

Not checked (needs a human at the keyboard): everything below.

### Owner's live test (2026-10-24, game 2.5)

The first pass found every talk key, the phone keys and NPC facing dead: `TargetingSystem.GetCrosshairData` on 2.5 is
`(EntityID, wref<GameObject>, out Vector4, out Vector4)` (read from redscript's overload error against the 2.5 `final.redscripts`), where 2.31 has
`(GameObject, out, out)`, and CET answered "requires 2 parameter(s)". All crosshair calls now go through `ConvaiCrosshairData` (top of `mod/init.lua`),
which tries the 2.31 form once and keeps whichever answers, so the Lua stays the same for both builds. After a CET reload, on the owner's 2.5 game:

* items 1, 2, 3, 5 and 6 pass: voice and text replies with voice, lip sync and gestures on a street NPC, the character faces V, the phone Chat tab, J/L and the
  F6 composer, MCM and the Native Settings UI page (game Settings > Mods), the Help page lines OK;
* item 4: the companion rides in the car and gets out with V; an invited street NPC declined in character ("has things to do"), which the owner accepts;
* item 8: frame rate feels the same as 2.31.

Still open: 7 (a new game with CET 1.38.0, a CET problem, documented for players), combat remarks, and the 2.31 side of the crosshair helper on the keeper copy.

### Live-test list for the owner (2.5)

1. Talk to an NPC by voice key and by text key: reply text, voice, lip sync, gestures.
2. Phone: open it, the Chat tab, the J/L keys on a contact, the F6/F8 composer (the three key handlers were changed).
3. Settings > Companion Manager (MCM) and the Native Settings UI page: open, change a setting, Apply.
4. Companion: invite, follow, get in a car (native vehicles), leave; combat remarks.
5. Face/lip sync on an ordinary NPC (Face.reds callbacks: `Entity/Initialize`, `Entity/Extract`, `Entity/Reassemble`, `DynamicEntityTarget` compiled, behaviour unchecked).
6. Help page: the Game version line says OK, the versions line says match.
7. A NEW game: CET 1.38.0 hangs a new game on 2.5 (notes: start without CET, save once, put CET back).
8. Frame rate compared with 2.31 in the same place.
9. Relationship receipts and world knowledge are OFF on 2.5 by design (see the audit): relationship-state.lua, bridge/relationship-routing.mjs, the rules pack and
   characters/world-knowledge.json are pinned to `gameVersions: ["2.31"]`; they need an evidence pass on 2.5 before the pins are widened.
10. The CDPR launcher warned that the NVIDIA driver (581.29) is older than the 621.01 it wants for 2.5; the game started and loaded anyway.

### The 2.31 keeper copy (E:/SteamLibrary/Cyberpunk2077-2.31, game 3.0.80.51928)

It is a full copy with RED4ext 1.30.0, CET 1.37.1 and the 0.3.0 Runtime. It has no `steam_appid.txt`, and `Cyberpunk2077.exe` started on its own asks Steam to
relaunch the game it knows (the Steam folder, now 2.5). Starting it needs `bin/x64/steam_appid.txt` containing `1091500` (a file add in the keeper, with Steam running),
or a Steam shortcut to the keeper's `Cyberpunk2077.exe`. Both installs share the saves in `Saved Games` and the mod's state in `%LOCALAPPDATA%/AiNpcCyberpunkMod`.
Not done: the keeper was not touched.

## The 0.3.1 build (2026-10-24, both games from main 4df5a8d8)

Built with `%TEMP%/release-u4` as for 0.3.0 (the Runtime is the carried base patched with the commit's files, `patch-zip-031.mjs` takes `RELEASE_GAME`), once per game. The two Runtimes differ in exactly two files
(`CyberpunkConvaiNative.dll` and `app/release.json`), the two Scripts in `GameVariant.reds` and `release.json`. Both Runtimes carry the same cumulative removal list.

* **Switch update (`--switch-game`)**: `node packaging/build-runtime-update.mjs --old <0.3.0 Runtime of game 2.31> --new <0.3.1 Runtime for game 2.5> --out DIR --switch-game` builds
  `Runtime-Update-0.3.0-to-0.3.1-for-2.5.zip`: the files that differ between the old 2.31 Runtime and the new 2.5 one (15 files, 0.7 MiB, the 2.5 DLL among them) and the step marker
  `step-0.3.0-to-0.3.1.json`. A player on 0.3.0 for game 2.31 who moved to 2.5 applies it with the 2.5 Scripts instead of downloading the full 2.5 Runtime. Without `--switch-game` an update
  across games is refused. The zip belongs in `game-2.5/updates/`. Only a step like this one is possible: the chain after it (`0.3.1-to-0.3.2-for-2.5`) is a plain 2.5 step.
* **Install test**: `node packaging/test-release-install.mjs --packages DIR --version 0.3.1 --game 2.5 [--update-from <0.3.0 Runtime> --update-from-scripts <0.3.0 Scripts>]` expects the `-for-2.5` names and
  checks that the Scripts and the Runtime both say the game.
