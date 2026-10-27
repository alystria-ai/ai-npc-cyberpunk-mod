# One mod, two game versions (2.5 and 2.31)

The mod is maintained for two Cyberpunk 2077 versions from ONE source tree. **Game 2.5 is the default** (the current game, the normal download, no suffix in any
file name) and **game 2.31 is the older option** for players who stay on it (`-for-2.31` in the file names, its own `game-2.31/` folder on Hugging Face, its own
optional file on Nexus Mods). A release is built once per game (`--game 2.5`, the default, or `--game 2.31`). The two builds are separate downloads with different
names, so a player cannot mix them without the setup check saying so. (Until release 0.3.1 was restructured on 2026-10-24 the names were the other way round: 2.31 was the
unsuffixed default and 2.5 the `-for-2.5` option. The source tree is still the 2.31 one: the 2.5 build lays `packaging/game-variants/2.5/` over it.)

| | 2.5 build (default) | 2.31 build (older game) |
|---|---|---|
| Game exe | 3.0.88.46235 | 3.0.80.51928 |
| Version of the first release | 0.3.1 | 0.3.1 (0.3.0 and older were 2.31 only) |
| Native plugin SDK | RED4ext.SDK `b139fcbd` (KelpHect/RED4ext.SDK-psiberx: official #227 plus the #228 layouts) | RED4ext.SDK `ad727771` (WopsS) |
| Native plugin declares | `RED4EXT_V1_RUNTIME_VERSION_2_50` | `RED4EXT_V1_RUNTIME_VERSION_2_31` |
| File names | `…-Scripts-<v>.zip`, `Runtime-<v>.zip` | `…-Scripts-<v>-for-2.31.zip`, `Runtime-<v>-for-2.31.zip` |
| release.json `game` | `2.5` | `2.31` (a release.json without the field is a 2.31 build, `LEGACY_GAME` in `packaging/lib/game-variants.mjs`) |

## What differs between the builds (and nothing else)

1. `native/core` is compiled twice (`scripts/Build-NativeCore.ps1 -Game 2.31|2.5`, CMake option `CONVAI_GAME`): the SDK pin, the declared runtime and
   `kGameLabel` change. No source line changed for the 2.5 SDK: the plugin only goes through RTTI, `ExecuteFunction` and the SDK's own types, and it built
   and passed its headless tests against the 2.5 SDK as is. It still needs the in-game check (below).
2. `r6/scripts/CyberpunkConvai/GameVariant.reds` is the only redscript that differs. It holds four helpers the rest of the scripts call
   (`ConvaiCallbackSystem()`, `ConvaiServiceContainer()`, `ConvaiKeyTarget(key, action)`, `ConvaiKeyTargetsByAction()`: true on 2.31, false on 2.5, because a 2.5 target gets every action of the key; `KeyBinds.reds` adds one target per key there and a press and a release target on 2.31). The source tree holds the 2.31 file, and the 2.5 build (the default) replaces it with
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
node packaging/build-release.mjs --version 0.3.1 --packages scripts,runtime,omni,...        (2.5, the default)
node packaging/build-release.mjs --version 0.3.1 --game 2.31 --packages scripts,runtime     (2.31, the older game)
python packaging/upload-packs.py --version 0.3.1 --pack runtime --packages DIR --game 2.31  (uploads to game-2.31/Runtime.zip, the default goes to Runtime.zip)
node packaging/build-runtime-update.mjs --old <2.31 Runtime> --new <2.31 Runtime> --out DIR (-> Runtime-Update-<a>-to-<b>-for-2.31.zip, a 2.5 step has no suffix)
powershell scripts/Build-NativeCore.ps1 -Game 2.5 -SdkDirectory <RED4ext.SDK checkout at b139fcbd>     (the script's own default is still 2.31)
powershell scripts/Install-DevelopmentMod.ps1 -GameVersion 2.31 / scripts/Compile-Redscript.ps1 -GameVersion 2.31     (both default to 2.5)
```

`--game 2.31` builds only `scripts` and `runtime` (the other packs are refused). An update zip is built within one game (two Runtimes of different games are
refused), and the update chains of the two games are independent (`app/defaults/runtime-steps`).

## Names (decided by the owner on 2026-10-24: game 2.5 is the default, 2.31 the older option, one Nexus page, 0.3.1 for both)

Same version number for both builds (0.3.1 is 0.3.1 for 2.5 and for 2.31), so the packs' "needs the Runtime of 0.2.7 or newer" rules and the step chains
keep working.

Hugging Face (`alystria-ai/ai-npc-cyberpunk-mod-packs`): the root is the 2.5 build (the default), the older 2.31 build has its own folder.
```
Scripts.zip   Runtime.zip   updates/Runtime-Update-<a>-to-<b>.zip              2.5 (the default). updates/ holds Runtime-Update-0.3.0-to-0.3.1-for-2.5.zip, the switch step
game-2.31/Scripts.zip   game-2.31/Runtime.zip   game-2.31/updates/Runtime-Update-<a>-to-<b>.zip    2.31: the whole chain 0.2.2 to 0.3.1 as it was published (no suffix),
                                                                                                   later 2.31 steps are named ...-for-2.31.zip
local-ai/  mature/  mic/  voice/  multilingual/                                 shared by both
```
Nexus Mods (one page): the Main file is the 2.5 build, `AI NPC Cyberpunk Mod - Scripts` (`Scripts.zip`). The 2.31 build is an Optional file,
`AI NPC Cyberpunk Mod - Scripts - for game 2.31 (older game version)` (`Scripts-for-game-2.31.zip`), and the description lists the requirements of 2.5 first and those of 2.31 as the alternative.

A player who moves from 2.31 to 2.5 downloads the 2.5 Scripts and Runtime (the 2.5 Runtime is a full zip), or on 0.3.0 applies the one switch zip (below).

## Release 0.3.2 on both games

0.3.2 is one source built twice, so the features are the same on 2.5 and 2.31: content packs (the Medieval AI NPCs add-on), Model browser search, extra sampling controls, the editable Mature layer, the Key bindings page (Johnny's own talk keys, the talk key falling back to the first party member), immersive invitations (on foot or by car), housemates and companion outfits (both off by default), companions settling in V's flat, twelve Dynamic info switches (Music and TV is new, Other mods' state is off by default), companions speaking up, Phone Chat for every character with a profile, and the experimental OmniVoice route on AMD Radeon cards (untested on AMD hardware). The new features were built from source and tests and have not been seen in a running game on either version.

What differs between the games is the requirement set, as in 0.3.1: 2.5 uses the official RED4ext 1.31.0 or newer and the official Codeware 1.21.0, 2.31 uses RED4ext 1.30.0 and Codeware 1.20.5 (both from Nexus Mods). The update step 0.3.1 to 0.3.2 is a plain step for 2.5 and is named `-for-2.31` for 2.31.

## Wrong build

* **The three games and the `build` check (2026-10-27).** Six installs on 27 Oct paired the 2.5 Scripts with the 2.31 Runtime and the game said nothing useful. Each half knows
  its own game: the Scripts from `release.json` `game` (written by the build, none is the 2.31 build; `buildOf()` in `mod/setup-check.lua`), the Runtime from
  `app/release.json` `game` (the bridge reads it and puts `scriptsGame` and `runtimeGame` in EVERY `versions` answer of `runtime/setup-check.json`, `bridge/setup-check.mjs`;
  a service of 0.3.1 and older names its game only in `game-mismatch`, so for those the Lua reads the Runtime's `app/release.json` itself, through the game folder in
  `runtime/bridge-service.json`) and the running game from `GetGameVersion` (2.50 is 2.5). `buildCheck()` compares the three once per run of the checks (12 s after
  the first world is ready, and when the Help page opens: no per-frame work, at most one extra small file read) and gives the game-side check `build`:

  | Scripts | Runtime | Game | code | the notice says |
  | --- | --- | --- | --- | --- |
  | S | R | S (R is the other game) | `runtime-wrong` | The Runtime is for game R, yours is S. Get the Runtime for S from Hugging Face. |
  | S | R | R (S is the other game) | `scripts-wrong` | The Scripts are for game S, yours is R. Get the Scripts for R from Nexus Mods. |
  | S | S, or not known | G, the other game | `both-wrong` (`scripts-wrong` when the Runtime is not known) | This mod is for game S, yours is G. Get the Scripts and Runtime for G. |
  | S | R (differ) | neither (a game version no build is for, or unreadable) | `differ` | Scripts are for game S, Runtime for R. They must match. See Help in Settings. |
  | S | S or not known | S, or a game no build is for, or unreadable | ok / unknown | nothing (a game no build is for is only the Game version note) |

  `build` is a critical problem, second in the order of the first-load notice (after RED4ext, before redscript: Scripts of the wrong game are a likely reason for a
  failed compile). The notice is the normal startup notice (one per session, the warning line, two lines at most in all 15 languages), so it shows where the missing
  Runtime or Codeware notices show. The Help page row "Build for your game" has the long text (which Hugging Face folder, which Nexus file); the "Scripts and Runtime"
  row steps aside when the Runtime is for another game, because update zips of the wrong game would mislead. The console and `probe.log` get one English line with
  `(scripts=2.5 runtime=2.31 game=2.5)`.
* **When the notice shows (fixed 2026-10-27).** The first live test of the notice (Scripts 2.5 over a 2.31 game and Runtime, CET reloaded, then a save loaded from the pause menu) showed
  nothing: the 12 s had run out in the menu, the notice was released one frame after the save was restored and written to the warning line before the HUD that draws it
  existed (`mcm.log` had the line, nothing was on screen). Now every first-load notice waits until gameplay has been on screen for 8 s in a row (`SETTLE_S`, `readySince`
  in `M.tick`; a pause, a menu or a loading screen in between starts the 8 s again), so in a running world it shows about 12 s after the world is ready, and after a load
  about 8 s after the world is back. A CET reload is a new session for the Lua: the notice is due again each time. A pure game mismatch is also one problem, not two: the
  `versions` problem is dropped from `problems()` when `build` already names it (the probe line reads `Setup check: problems: build`).
* **Error reports.** The setup line `build: problem runtime-wrong (scripts=2.5 runtime=2.31 game=2.5)` (or `build: ok match (...)`) is in every report of the session, the
  game records a `setup-problem` event `build <code>` with the same detail, every report's `versions` holds `scriptsGame` and `runtimeGame`, and the bridge's own
  `versions game-mismatch` event carries both games. Triage: look for `build: problem` in `setup`, or `scriptsGame` different from `runtimeGame` in `versions`.
* Scripts built for one game on the other game: besides the `build` row, the Help page `Game version` line is a Problem ("These files are the mod build for game X.
  Install the build made for game Y …"); the redscript-did-not-load notice already names the build's own game.
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

| | 2.5 build (default) | 2.31 build (older game) |
|---|---|---|
| Cyber Engine Tweaks | 1.38.0 (official, "Game version 2.5") | 1.37.1 |
| RED4ext | 1.31.0, the official release for 2.5 (Nexus 2380, 24 Oct), tested live on 2.5 on 25 Oct: all three plugins load. It refuses 2.31 ("ensure your game is updated to patch 2.5 or newer"). Before it: the build of wopss/RED4ext master 47ac01c ("RED4ext 1.30.0 Master 47ac01c 2.5 Unofficial", Nexus 35697: `bin/x64/winmm.dll`, `red4ext/RED4ext.dll`; its log says `v1.30.0+master.1.47ac01c`). 2.5 support is merged upstream and unreleased (latest official release v1.30.0 of 2026-03-09, for 2.31). The Codeware 2.5 zip holds only the Codeware plugin. | 1.30.0 |
| redscript | 0.5.32 | 0.5.31 |
| Codeware | 1.21.0 (official, Nexus 7780, 25 Oct; replaces the unofficial 1.20.6 from github.com/alystria-ai/codeware-game-2.5) | 1.20.5 |
| Native Settings UI | 1.97 | 1.96 |
| Mod Configuration Menu | 0.10.6-hf1, tested live on 2.5 by the owner (24 Oct): the Companion Manager opens, a setting changed and applied | 0.10.5 |

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
* Gates that refused any game but 2.31 (the audit of the first 2.5 build left them as they were, so that build ran without these features): `mod/relationship-state.lua`
  and `bridge/relationship-routing.mjs` (the 11 romance quest facts: the automatic romantic style and Johnny's remarks) and `mod/world-knowledge.lua` +
  `bridge/world-knowledge.mjs` + `characters/world-knowledge.json` (every rule and evidence row listed `gameVersions: ["2.31"]`). Both are ON for 2.5 since the
  evidence pass in "Relationship receipts and world knowledge on 2.5" below.
* CET reflection to re-probe live: the AI command classes and navigation calls of companion-actuator/placement, chauffeur and vehicle natives, workspot and
  gesture calls, spatial queries, passage blackboards and door devices, the subtitles chatter controller, phone widget trees.

## Relationship receipts and world knowledge on 2.5 (2026-10-24, read-only against the installed game 2.5 and the 2.31 keeper copy)

Both systems read only the game's quest data, so the question was whether every quest fact, journal entry and scripted call they depend on is the same on 2.5. No game folder
was written to and no game was started. The evidence is reproducible with `node research/cyberpunk/scripts/check_game_2_5.mjs <stage>` (stages `cited`, `changed`,
`extract`, `facts`, `citations`, `journal`, `localization`; WolvenKit CLI extracts into a work folder) and the result is recorded in `research/cyberpunk/game-2.5-check.json`.

**Where the pins were** (all of them):

| Pin | What it did |
|---|---|
| `mod/relationship-state.lua` | refused any `GetGameVersion()` but `'2.31'` (`unsupported-game-version`, no fact read) |
| `bridge/relationship-routing.mjs` `parseRelationshipState` | refused a snapshot whose `gameVersion` was not `'2.31'` |
| `mod/world-knowledge.lua` `configure` | the pack's `gameVersions` had to contain the game's version text |
| `bridge/world-knowledge.mjs` | the pack, every evidence row and every rule carry `gameVersions` (validated, the evidence must cover each rule's list), and `resolveKnowledge` answers `unsupported-game-version` unless pack and rule list the snapshot's version |
| `characters/world-knowledge.json` (and its generated copy `research/cyberpunk/generated/world-knowledge.json`) | `gameVersions` on the pack, 1318 evidence rows and 860 rules was `["2.31"]` |

`bridge/intrinsic-character-context.mjs` also names `2.31`, but only as the declared version of its authored character packs (it never compares it with the running game), so it
is not a gate and was left alone.

**What they depend on, and the evidence for 2.5**

1. *Quest data cited by the 1318 evidence rows and the fact writers* (796 resources: quests, phases, scenes, the cooked journals, English on-screen text). Compared by archive entry
   hash (the SHA-1 in the RDAR directory of every archive), 2.5 against 2.31: 750 are byte for byte identical, 46 differ. Two of the 46 differ only in the base archive while the
   Phantom Liberty archive still holds the 2.31 bytes and wins (`sts_wat_kabuki`, `ma_std_arr_06`). The other 44 were extracted and checked point by point: every cited JSON pointer
   still resolves with the same node type and the same expected values, and every fact writer still writes the same value (208 pointers in changed resources, 208 ok on 2.5, and the
   same 208 on 2.31 as the control).
2. *Nothing new writes the facts.* This looked at the whole game data, not only the cited files: 12153 quest, phase, scene and journal resources exist in both games and 214 differ in
   their effective version (ep1 over base). All 214 were extracted from both games and their fact reads and writes compared. 169 have no fact change, the others touch 55 fact
   names, and 1 of those is a fact the rules use: `mq057.questphase` (Motorbreath) gained a read of `sq029_river_lover == 1`. It is a read. No writer of any of the 366 facts the
   rules use changed, nor of the 11 relationship facts (the resources that write them are among the 750 identical ones).
3. *Journal entries.* The 638 allowlisted entries are looked up by path and class (`GetEntryByString`): all 638 exist on 2.5 with the same class. The journal grew (38623 to 39819
   entries: a tutorial course, a new tarot minor quest, more codex links, and one removed entry, `mq060_nitro/wait/06_message/message_questmappin`, which is not used). That moves
   the positions the evidence cites, so the 669 journal evidence references were compared by path instead: all 669 entries are identical on 2.5.
4. *English text the evidence quotes.* 187 on-screen strings, compared by primary key: identical. (The on-screen file itself changed, but not for these keys.)
5. *Scripted calls.* A probe `.reds` compiled with `scc.exe -compile <dir> -customCacheDir <copy>` against a copy of the 2.5 `final.redscripts` and, as the control, of the 2.31
   one: `QuestsSystem.GetFactStr(String): Int32`, `JournalManager` `HasAnyDelayedStateChanges`, `GetEntryByString(String, String)`, `GetEntry`, `GetEntryHash`, `GetEntryState`,
   `GetEntryTimestamp`, `GetParentEntry`, `IsEntryVisited`, `JournalContact.IsKnown`, `TimeSystem.GetGameTime` / `GetGameTimeStamp`, `GameTime.GetSeconds`,
   `PlayerDevelopmentSystem.GetLifePath`, the enums `gameJournalEntryState` and `gamedataLifePath`, `inkISystemRequestsHandler.IsPreGame` / `GetGameVersion`. All compile on both
   with the same signatures (a deliberately wrong call in the same harness fails, so the probe does catch a change; `GetEntryHash` returns an Int32 in the scripts, which the
   Lua already turns into an unsigned hash). The owner's 2.5 session also shows the journal side live: its `runtime/knowledge-active.json` holds quests with state, native path
   and `gameTimeSeconds` read through `Game.GetJournalManager()`.
6. *The game's version text.* The save metadata of the owner's 2.5 game says `buildPatch "2.5"` and `gameVersion 2500` (2.31: `"2.31"`, `2310`). No earlier run wrote down what
   `GetGameVersion()` returns on 2.5 (only that the Help page's Game version line says OK), so Lua reads `2.5`, `2.50` and `2.5.0` all as `2.5`, as `mod/setup-check.lua` does,
   and passes `2.5` on. Any other patch (2.51, 2.6, 3.0) stays unsupported on purpose.

**What changed**

* `mod/relationship-state.lua`: the version gate is `{2.31, 2.5}` after the canonical name above, and the snapshot says `gameVersion = "2.5"` on 2.5.
* `bridge/relationship-routing.mjs`: `RELATIONSHIP_GAME_VERSIONS = ['2.31', '2.5']`.
* `mod/world-knowledge.lua` `configure`: reads the game's version through the same canonical name before looking it up in the pack.
* `characters/world-knowledge.json`: `gameVersions` is `["2.31", "2.5"]` on the pack, on all 1318 evidence rows and on all 859 executable rules (and the one disabled rule that has a list).
  It is built, not hand-edited: `research/cyberpunk/game-2.5-check.json` lists the checked evidence ids and `build_native_pack.mjs` (`widenGameVersion`, run after the evidence
  verification so the reviewed topic aliases that pin each authored rule's hash still match) adds `2.5` to those rows and to every rule whose evidence rows are all listed. A new
  row stays on 2.31 until the check is repeated for it, and `bridge/game-25-check.test.mjs` fails when an executable rule or evidence row lacks 2.5 or the list drifts.
* No per-frame work was added: the version text is read once per capture (every 2 s for the receipts, as before) and once at `configure`.
* The Scripts carry the pack and the Lua, the Runtime carries the pack and the bridge, so both packages of both games change.

**What stays off:** nothing. What could not be seen offline is a running 2.5 game executing these calls through CET 1.38.0 (the live check is item 9 of the list above). If a call
failed there, both systems already fail closed: the receipts publish `native-fact-unavailable` and the style stays ordinary, and the world collector reads nothing.

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
9. Relationship receipts and world knowledge are ON for 2.5 (section "Relationship receipts and world knowledge on 2.5" below). In a game, after a save has loaded,
   `runtime/relationship-state.json` in the mod folder says `"status":"ready"` and `"gameVersion":"2.5"` within a few seconds (it said `unavailable` while they were off),
   and `runtime/knowledge-status.json` no longer answers `unsupported-game-version`. A romance save then gives Judy, Panam, River, Kerry or Stout the romantic style on Auto,
   and a quest fact that became set makes Johnny speak up (Johnny setting on).
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
  `Runtime-Update-0.3.0-to-0.3.1-for-2.5.zip`: the files that differ between the old 2.31 Runtime and the new 2.5 one (24 files, 1.7 MiB, the 2.5 DLL among them) and the step marker
  `step-0.3.0-to-0.3.1.json`. A player on 0.3.0 for game 2.31 who moved to 2.5 applies it with the 2.5 Scripts instead of downloading the full 2.5 Runtime. Without `--switch-game` an update
  across games is refused. The zip belongs in `updates/` (the 2.5 default's folder). Only a step like this one is possible: the chain after it (`0.3.1-to-0.3.2`, no suffix) is a plain 2.5 step.
* **Install test**: `node packaging/test-release-install.mjs --packages DIR --version 0.3.1 [--game 2.31] [--update-from <0.3.0 Runtime> --update-from-scripts <0.3.0 Scripts>]` expects the names of the game (`-for-2.31` for 2.31) and
  checks that the Scripts and the Runtime both say the game.
