# Names for passers-by

2026-10-15, branch `npc-names`. A nameless ordinary NPC (a crowd ped, a gang member, a guard, a shopkeeper the game gives no name) gets a Night City name made from what they are.
The scanner shows it instead of the generic label ("NC Resident", "Pedestrian"), the conversation tells the NPC "Your name is ...", and the subtitle and composer caption use it.
Always on: there is no setting and no menu row (a saved `npcNames` value from an earlier build is ignored). Built and unit-tested; not seen in the game (checks at the end).

## What counts as ordinary (the gate)

The rule the talk path already uses (docs/WORLD_COMPANIONS.md, "The mod never touches game characters"), evaluated by `convaiNpcNames` in `mod/init.lua` through `M.ordinary` in `mod/npc-names.lua`:

1. **Not ours.** A copy the mod spawned (a companion, an archetype copy) already has its name: `convaiWorldPolicy.ours`.
2. **Not protected.** (A named game character that the player may now talk to, `convaiWorldPolicy.story`, is still protected: it keeps its own name on the scanner, docs/WORLD_CHARACTERS.md.) A named roster character, a quest-bound character (`MainQuest`, `SideQuest`, `MinorQuest` on the record, or a `q###` / `sq###` / `mq###` record) and a story record get nothing: `convaiWorldPolicy.protected` (`characterCatalog.protectedReason`).
3. **A generic profile.** The catalog resolves the NPC to an archetype key (`npc-*`) or to `resident-male` / `resident-female`. Anything else (a named profile, no profile) is refused.
4. **An adult human.** Children and machines (drones, androids) are refused (`facts.children`, `facts.human`).
5. **Scanner only: not in combat.** An enemy who is fighting keeps the game's tactical label (`NPCPuppet.IsInCombat`). Combat is momentary: the NPC is named at the next scan once it ends. Talking to someone mid-fight still uses the name.
6. Vehicles never reach this (the hook is on `NPCPuppet`).

The setting is read first. With it off nothing is read, nothing is loaded and the pools are released.

## One source of truth

`mod/npc-names.lua` `nameFor(npc, mode)` is the only place a name is made. Both the scanner hook and `selectConversation` call it, so the same NPC has the same name in both. It is a **pure function** of the entity id, the character record and the traits, cached per entity (512 entries; the cache is only a speed-up, a cleared cache gives the same names).

Seed: `"<entity id>|<record name>"`. Generator: a djb2-style string hash, then an iterated quadratic map modulo 2^31-1 (nonlinear, so neighbouring entity ids do not give neighbouring names; exact arithmetic below 2^53, so LuaJIT and Lua 5.3 agree).

### Traits (`M.profile`)

| Trait | Source | Used for |
| --- | --- | --- |
| gender | `characterCatalog.gender(facts)` (explicit gender, else body rig); unknown = by seed | first-name list; feminine Slavic surname; gendered handles skipped |
| archetype base | the catalog's resolution (`archetype.base`, `.category`) | the culture mix, the handle style, the handle chance (`PROFILES`, one per base of `characters/archetypes.json`; a test checks every base has one) |
| affiliation | `facts.affiliation` | a corporate guard's employer: Arasaka mostly Japanese, Kang Tao mostly Chinese, Militech and Biotechnica their own mixes |
| appearance and record name | `npc:GetCurrentAppearanceName()`, `facts.recordName` | tokens (`gang__valentinos_wa__...`, `corporat_wa_...`, `HomelessMan`, ...) name the faction or station of a resident or an NPC the catalog could not place. Vendors and gang / police / faction bases are trusted over tokens. |

Culture mixes (weights, `MIXES`): Valentinos 100% Latino; Tyger Claws 85% Japanese, 8% Chinese, 7% Korean; Voodoo Boys 94% Haitian (Creole), the rest West African / African American; nomads and Aldecaldos American frontier plus Latino; Maelstrom a Slavic / Nordic / Irish mix; 6th Street American (Irish, frontier, African American, Nordic, corpo-Anglo); Animals mostly African American and Latino; NCPD a wide city mix; corporate workers corpo-Anglo first, then Japanese, South Asian, Chinese, Korean; everyone else the broad Night City mix. Sixteen cultures: african-american, arabic, chinese, corpo-anglo, filipino, french, german-nordic, haitian, irish-working, japanese, korean, latino, nomad-american, slavic, south-asian, west-african.

### Pools and handles

`characters/npc-name-pools.json` (about 13,000 entries): per culture about 200 male and 200 female first names and 300 surnames (Korean has 203 surnames), 40 culture handles, plus ten gang handle styles (maelstrom, animals, moxes, valentinos, tyger-claws, voodoo-boys, 6th-street, scavengers, nomad, street-generic) and the list of blocked named-character full names. Drafted by a Haiku swarm, merged and filtered by the coordinator, reviewed here (given names and surnames removed from the Tyger Claws, street and Valentinos handle lists, accent-folded duplicates and one named handle removed). `scripts/Build-NpcNamePools.mjs` checks the data (letters only, no duplicates after accent folding, no handle that is a named character) and writes `mod/npc-name-pools.lua`; `--check` fails when the Lua is stale.

The Lua pools are loaded once, on the first scan or talk to an ordinary NPC (about 120 kB), not at startup, and released when the setting is turned off.

Format: `First Last`, or `First 'Handle' Last` on a share of them: gangs about 28%, vendors and street locals 14 to 30% by kind, residents about 10 to 20%, corporate 3 to 5%, NCPD never. A handle is skipped when it equals the first or last name or is plainly the other gender's.

Never a named game character: the generator re-rolls (up to seven times) when `First Last` equals a blocked full name, and the build rejects a handle that is one. Never a well-known real person either: the blocked list also holds about 120 famous names, among them the seven pairs the pools could actually form (Jennifer Lopez, Selena Gomez, Hideo Kojima, Shigeru Miyamoto, Haruki Murakami, Gordon Ramsay, Lewis Hamilton; found by checking a list of famous names against every culture's first names and surnames).

## Vendors keep their name across sessions

A one-shop vendor (the catalog's `memoryKey`: a vendor with a record of their own, like `wat_kab_ripperdoc_01`) is seeded by that record, not the entity, and the name is stored in `runtime/npc-names.json` with the other player state of the CET mod (an earlier version kept it next to `init.lua`; that file is still read until the new one exists; the service keeps a copy outside the game folder so the names survive under Mod Organizer 2, docs/PACKAGING.md; 128 shops at most, the oldest dropped; no two stored shops share a name). A later session, a respawned entity or a changed pool gives the same shopkeeper the same name. Crowd peds and shared street-stall records are never written to disk.

## The scanner hook

Game path (script dump 2.x, `NPCPuppet.CompileScannerChunks`, `scripts/cyberpunk/NPC/NPCPuppet.script`): when the scanner asks for an NPC the game fills `UI_ScannerModules.ScannerName` with a `ScannerName` chunk: `Set(name)` for a plain name, or text params `TEXT_PRIMARY` (the name) and `TEXT_SECONDARY` (the archetype) when an archetype is shown. For a civilian the name is the record's `DisplayName` ("NC Resident"); an empty primary means only the archetype shows.

Hook: Lua `ObserveAfter('NPCPuppet', 'CompileScannerChunks', ...)` (installed in `onInit`, `mod/npc-names.lua` `install`). It runs when the scanner compiles that NPC, never per frame, and the answer is cached per entity. After the game has written its chunk, Lua calls `npc:ConvaiApplyScannerName(name)` (`r6/scripts/CyberpunkConvai/NpcNames.reds`, the only redscript of the feature): it reads the chunk back, updates `TEXT_PRIMARY` in place (or `Set`) and writes the variant again. The archetype line, level, health and every other chunk stay the game's own. The game's function is not wrapped or replaced, so a game update that changes it cannot break the compile; at worst the chunk is left alone.

Why a Lua observer and not a `@wrapMethod`: the name must be the same one the conversation uses, and that generator, its tests and the gate live in Lua (`convaiWorldPolicy` is Lua). Redscript cannot call Lua synchronously.

## The conversation

`selectConversation` (`mod/init.lua`) calls `nameFor(npc, 'talk')` for an ordinary NPC and sets `primary.name` (the composer title, the subtitle speaker, the notices) and `primary.archetype.npcName`. The bridge (`bridge/protocol.mjs`) parses `npcName` (letters of any script, spaces, apostrophes, hyphens, dots; 60 characters; nothing else passes) and `archetypeContext` says:

> Your name is Rico 'Chrome' Alvarez. Say it when someone asks who you are or what to call you, and never change it.
> You are an ordinary Valentinos ganger, not a story character.

The identity is unchanged: sessions stay keyed by the actor **entity** (and a one-shop vendor by its record), so two peds who share a name stay two peds; the name is display text. The profile key, memory (`session-only` for ambient profiles) and vendor memory are untouched.

## Sample names

Valentinos: Javier Soto, Marisol Soto, Nallely Portillo. Tyger Claws: Naoki Goto, Takashi Noguchi, Kanji Kawakami. Voodoo Boys: Ketlie Benjamin, Jessie Yacinthe, Clemence Ortilus. Nomad: Tomas Roebuck, Dejan 'Gila' Lis, Jeb 'Stray' Soto. Corpo: Verity Jardine, Margarete Verhoeven, Olivia Ellery. Arasaka guard: Takashi Noguchi, Kenta Tomioka. NCPD: Wulan Basco, Stephanie Santiago. Ripperdoc: Peng Tsai, Gopal 'Frankie' Banerjee. Maelstrom: Dejan 'Ironhook' Lis, Hannes Ström, Milan 'Sinter' Lazarev. Mox: Solène Jacquet, Emilia 'Ultra' Mayorga. Animals: Bakary 'Jaguar' Nyamekye, Eugene Roundtree. Valentinos with a handle: Norberto 'Beto' Lozano, Federico 'Miel' Mayorga.

## Files

| File | Role |
| --- | --- |
| `mod/npc-names.lua` | Generator, trait mapping (`PROFILES`, `MIXES`, `TOKENS`), the gate (`M.ordinary`), the service (`nameFor`, `onScan`, `install`, vendor file). |
| `mod/npc-name-pools.lua` | Generated pools (do not edit). |
| `characters/npc-name-pools.json` | Source of the pools and the blocked names. |
| `scripts/Build-NpcNamePools.mjs` | Validates the data, writes the Lua, `--check`. |
| `r6/scripts/CyberpunkConvai/NpcNames.reds` | `NPCPuppet.ConvaiApplyScannerName` (needs a game restart). |
| `mod/init.lua`, `mod/manager.lua`, `mod/manager-ui.lua`, `mod/locales/*.lua` | Wiring (`convaiNpcNames`, the scanner observer, the talk-path name); no setting, no menu row, no strings. |
| `bridge/protocol.mjs` | `npcName` parsing and the context lines. |
| `bridge/npc-names.test.mjs` | 25 tests: pools, determinism, trait mapping, no repeats in 500, no named-character names in 12,000, the gate, the service, scanner hook, vendor file and cap, context line, the setting gone. |

## Install

`mod/npc-names.lua`, `mod/npc-name-pools.lua` and all other committed `mod/` files (CET reload), `r6/scripts/CyberpunkConvai/NpcNames.reds` (**game restart**). No bridge change needed for the scanner; the "Your name is ..." line needs a bridge restart. Both are in `scripts/development-files.json` and `packaging/release-plan.json`.

## Live checks (none done yet)

1. Walk up to a crowd ped and scan: the label shows a name (and the archetype line below it, if the game shows one), not "NC Resident". Scan the same ped again and after walking away and back: the same name. `probe.log` has one `NPC name: entity=... base=... culture=... name=...` line per new ped.
2. Talk to that ped and ask their name: they say the scanner's name, and the subtitle speaker shows it.
3. Scan a gang member (Valentinos, Tyger Claws, Voodoo Boys, nomad): the name fits the faction. If the culture looks wrong for a record, the `probe.log` line shows the appearance name and culture; tune `TOKENS`.
4. Scan a story or named character (Judy, a quest NPC), a companion, a vehicle, an enemy in combat: the game's own label, unchanged.
5. A shopkeeper (a one-shop ripperdoc or vendor): the name is the same after a restart of the game. `npc-names.json` appears next to the CET mod files.
6. Settings > Interface: there is no "Names for passers-by" row; names are always on.
7. `NPCPuppet.CompileScannerChunks` observer: if scanning shows no name and `probe.log` says "the scanner chunk was not changed", the chunk has no `ScannerName` for that NPC (the preset hides names) or CET could not hook the function; the log line says which answer came back.
