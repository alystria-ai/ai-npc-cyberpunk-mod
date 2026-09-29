# Native game evidence for quest decisions and character memory

Audited September 30, 2026. This document records inspected interfaces and assets, proposed capture behavior, and remaining proof requirements. Neither this audit nor the extraction job changes game archives, saves, quest facts, journal states or active game requests.

## 1. Baseline at the start of this audit

`mod/quest-context.lua` captures the active tracked journal entry, walks upward to its containing quest, and reads up to eight active, revealed objectives. It retains no native journal handles between captures. `bridge/quest-context.mjs` validates and turns that snapshot into bounded conversation context. The context explicitly says that current objectives are not completed outcomes and do not prove a companion witnessed earlier events.

That baseline was useful live context, but not a complete quest history or a decision-memory system. It did not enumerate resolved quests, map dialogue branches, establish a playthrough/rollback identity, or turn verified changes into a save-scoped event ledger. The bridge's conversation session identity must not be confused with authoritative save identity. The parallel runtime implementation is tracked separately; this audit's source evidence does not claim its live qualification.

## 2. Inspected local sources

Project root: `C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod`.

| Source | Exact location / revision | What it establishes |
| --- | --- | --- |
| Installed base resources | `E:\SteamLibrary\steamapps\common\Cyberpunk 2077\archive\pc\content\basegame_4_gamedata.archive` | Actual shipped quest graph, phase and scene resources on this machine. |
| Installed expansion resources | `E:\SteamLibrary\steamapps\common\Cyberpunk 2077\archive\pc\ep1\ep1_2_gamedata.archive` | Expansion resources and overrides of some base depot paths. |
| Base English localization | `E:\SteamLibrary\steamapps\common\Cyberpunk 2077\archive\pc\content\lang_en_text.archive` | Localized journal and scene text. |
| Expansion English localization | `E:\SteamLibrary\steamapps\common\Cyberpunk 2077\archive\pc\ep1\lang_en_text.archive` | Expansion text and possible overrides. |
| Game script declarations | `vendor/reference-game-scripts`, commit `fce9ab7e6a608b0d729290d898003589515900e1` | Native journal, quest, time and lifecycle method signatures. This checkout is sparse; use `git show HEAD:<path>`. |
| Codeware source | `C:\Users\akshi\AppData\Local\Temp\codex-cyberpunk-reference\codeware`, commit `613a1cb830ecf33508ffca839d3ea631073504ef` | Native type fields, callbacks and add-on fields. |
| WolvenKit CLI | `vendor/wolvenkit-console-9.0.1/WolvenKit.CLI.exe` | Resource listing, extraction and CR2W JSON serialization. |
| CLI runtime | `vendor/dotnet-runtime-10.0.12` | Set task-local `DOTNET_ROOT` when invoking the CLI. |
| Save metadata inspected read-only | `C:\Users\akshi\Saved Games\CD Projekt Red\Cyberpunk 2077\AutoSave-17\metadata.9.json` | This disk save's metadata, not proof that it is currently loaded. |
| Prior bounded scene extraction | `runtime/exploration-research/scene-json/sts_std_arr_01_room_new.scene.json` | Real scene object structure, actor IDs, dialogue/localization references, graph entry points. |
| Existing local subtitle reader | `scripts/Extract-VoiceReferences.py` | Verified RDAR/CR2W/Oodle reading for an explicit small allowlist; not a general quest parser. |
| Third-party reference | `vendor/reference-ai-npc`, commit `035d4b95c8934a520c0e8d810472ac71ec7a9a7b` | Candidate save-scoped branch/sequence architecture and previously researched quest predicates; all meanings require independent review. |

The inspected save metadata reports game version `2310`, patch `2.31`. A separate installed-asset fingerprint is needed for each supported release; the script checkout name alone does not establish compatibility.

## 3. Archive inventory and extraction scope

Read-only WolvenKit listings found:

| Archive | `.quest` | `.questphase` | `.scene` | `.journal` |
| --- | ---: | ---: | ---: | ---: |
| Base gamedata | 636 | 2,860 | 7,067 | 1 |
| Expansion gamedata | 98 | 978 | 513 | 2 |

These are resource counts, not counts of unique playable jobs. One displayed job can cross multiple native graphs; one graph can cover several displayed jobs. Shipped archives also contain test resources, obsolete scene versions, bug-fix graphs, loading-screen logic, media logic and ambient systems. A filename prefix does not prove an asset is reachable in the release graph.

The cooked journals are:

- `base\journal\cooked_journal.journal` in the base archive;
- `base\journal\cooked_journal.journal` in the expansion archive;
- `ep1\journal\cooked_journal.journal` in the expansion archive.

The initial export covers all `.quest`, `.questphase` and cooked journal resources, preserving both physical archive occurrences. It does not export all scenes. The RDAR index audit found 4,575 selected occurrences, 4,573 winning depot paths, 33,876,283 stored bytes and 227,448,341 decoded bytes. The extraction ceiling is 2 GiB of decoded input and 8 GiB of cache output. Raw resources and JSON remain ignored under `research/cyberpunk/cache/game/`.

The extractor treats expansion entries as higher priority than the two selected base archive inputs. This is an explicit base-plus-expansion research scope. It is not a reconstruction of every installed mod overlay or of ArchiveXL journal merging. The production resolver must not claim that modded quest logic is identical to this corpus.

### Reproducible commands

From the project root:

```powershell
# Inventory and budget audit only; no resource payload export.
& .\research\cyberpunk\scripts\extract_game_knowledge.ps1

# Run/resume the bounded export and evidence index.
& .\research\cyberpunk\scripts\extract_game_knowledge.ps1 -Extract

# Rebuild indexes from existing extracted JSON.
& .\research\cyberpunk\scripts\extract_game_knowledge.ps1 -IndexOnly
```

Direct CLI forms, confirmed by the installed 9.0.1 help:

```powershell
$env:DOTNET_ROOT = (Resolve-Path -LiteralPath '.\vendor\dotnet-runtime-10.0.12').Path
$cli = '.\vendor\wolvenkit-console-9.0.1\WolvenKit.CLI.exe'
$archive = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077\archive\pc\content\basegame_4_gamedata.archive'
& $cli archive $archive --list --regex '\.(quest|questphase|journal)$'
& $cli extract $archive --outpath '.\research\cyberpunk\cache\game\raw\base' --regex '(\.quest$|\.questphase$|\\cooked_journal\.journal$)'
& $cli convert serialize '.\research\cyberpunk\cache\game\raw\base' --regex '(\.quest$|\.questphase$|\\cooked_journal\.journal$)'
```

Do not give a shared `--outpath` to batch serialization: WolvenKit serializes to that directory by basename. Different depot directories can contain the same filename. Omitting the option keeps each JSON beside its original resource, preserving paths and avoiding silent overwrites. Extraction and serialization output goes to task-owned logs; no game helper window is opened.

`inventory.json` records archive identity, file size/mtime, path hash, compressed and decoded byte counts, per-entry archive SHA-1, winner status, resource SHA-256 after extraction, and raw/JSON paths. `progress.json` records stage, counts, errors and resumability. `index/summary.json` is the coverage result; an incomplete parse is not success.

### Completed extraction and independent checks

All 4,573 winning resources parsed successfully. The final full-quest index contains:

| Evidence | Count |
| --- | ---: |
| Scoped graph nodes | 410,195 |
| Serialized graph edges | 453,793 |
| Exact fact-field occurrences | 58,890 |
| Distinct fact names | 13,805 |
| Quest/scenario condition objects | 249,462 |
| Cooked journal entries with full paths | 38,623 |
| Journal path references from graphs | 44,632 |
| Resource links | 34,767 |

The dictionary covers literal `factName`, `factName1` and `factName2` fields in these quest/journal resources. It is not a claim that all facts generated by scripts or all scene-only writers have been discovered. No FNV-1a 32-bit collisions or non-ASCII fact symbols were found in this corpus. Separate targeted scene dictionaries retain their own provenance and extend the source material used by reviewed rules.

`scripts/validate_game_knowledge.py` independently checks all indexed source hashes against the manifest, graph/node ownership, journal joins, and reopens sampled exact JSON pointers from every nonempty indexed asset. It found no duplicate graph-scoped node IDs, cross-graph edges, source-hash mismatches or sampled pointer mismatches. Six serialized edges have null source fields in the original shipped JSON; their endpoints stay unresolved. The validation does not repair them by guessing. Fifty parsed resources contain no objects covered by these indexes, mostly empty/test assets. Of 44,632 journal references, 42,936 match a cooked path/class exactly; 1,684 nonempty paths are absent and twelve references are empty. Missing or obsolete paths are explicit review gaps, not permission to substitute similarly named entries.

Node ownership is structural: actual native nodes include `questMiscAICommandNode` and legacy `tempshitMapPinManagerNodeDefinition`. Prefix/suffix filtering initially omitted those types and was corrected. The final indexes use node `id` plus `sockets`, retain the containing `questGraphDefinition` pointer, and resolve every non-null indexed socket to its owner. The condition index covers serialized `quest*`/`scn*` types ending in `Condition` or `_ConditionType`, including character-killed and scene conditions; script prerequisites outside those structures remain a separate source domain.

Index publication writes staged JSONL files and a summary commit marker. Windows readers can temporarily deny replacement, so publication retries and preserves a pending manifest. `--publish-only` can complete an already finished generation; it cannot authorize an unfinished new generation with a stale manifest. The source cache is never replaced with flattened basenames.

Full installed container fingerprints are in `cache/game/archive-fingerprints.json`, separately from per-entry SHA-1 and decoded binary SHA-256:

| Archive | Full archive SHA-256 |
| --- | --- |
| `basegame_4_gamedata.archive` | `a2c6ea7b8bb0dceb671d04c702c41824c29e5e1ee518490a42850dac12524dab` |
| `ep1_2_gamedata.archive` | `1edf706261947fb0a80a130e6ce05e75706a1738c032c3e545d49774c7d27ddf` |

### Normal root and structural resource chains

The bounded `scene-evidence/release-root/` batch exports `base\quest\cyberpunk2077.gamedef`. Its typed `gsmGameDefinition` declares `base\quest\cyberpunk2077.quest` at `/Data/RootChunk/mainQuests/0/Data/questFile/DepotPath/$value`, uses world `03_night_city`, and declares spawn tag `#q000_spwn_start`. The decoded gamedef SHA-256 is `3bc1e3a75a1ba9dc582b8c7736a758899001cd15424ed79e1654de8b8ca41bbd`. The exact gamedef path is also present in the installed executable. This establishes a main-quest declaration from native data; an executable string by itself would not establish branch execution.

`scripts/index_release_references.py` follows quest/phase resource references from this root. `index/release-reference-closure.json` records a source-located parent chain for 2,525 winning resources and 1,508 references outside the initial quest/journal inventory. This is **reference closure**, not executable node reachability. Reviewers still check input sockets, condition gates, scene entries, event activation, reset writers and supported initialization routes. An unconnected node or unused version is not proven active by its resource's presence.

Reachable expansion initialization can establish this save's default history. It does not prove the human personally selected that outcome. Use that narrower meaning when the initializer and resulting state are source-verified. Unreachable tests do not automatically invalidate production writers; conflicting reachable writers and state contradictions do require suppression or a more specific predicate.

### Bounded scene and English localization layers

`scripts/extract_scene_evidence.py` accepts only explicit `.scene` paths (or an explicit `--resource-kind gamedef`). It checks decoded budgets before export, preserves both archive occurrences and winners, verifies payload hashes and keeps every source path. Each review batch lives under `cache/game/scene-evidence/<batch>/` with its own manifest and index. `scripts/extract_scene_batches.py` runs at most two hidden workers on named exact-path requests. These batches do not alter the reproducible quest-only inventory. Native rule references prefix their JSON path with `scene-evidence/<batch>/` relative to `cache/game`. At completion of this audit, 93 requested scenes and the game-definition resource had been exported with no missing requested paths. The entire research game cache, including language data and indexes, occupies about 5.01 GiB.

`scripts/index_native_localization.py` extracted and indexed 3,804 English text resources (about 31.2 MiB decoded), with 104,895 subtitle rows and 141,158 onscreen rows. All 246,053 normalized entries were independently resolved back to their exact source JSON pointers and payload SHA-256; SQLite integrity and JSONL agreement passed. Duplicate IDs remain visible: 75,336 duplicate groups were found, with no conflicting text within matching domain/ID groups in the language corpus. Every row retains full language-archive SHA-256, archive-entry SHA-1, binary SHA-256, gender variants and RFC 6901 locators.

Lookup is local and separate by identifier domain:

```sql
-- Database: cache/game/localization/index/lookup.sqlite3 (open read-only)
SELECT source_json FROM entries
WHERE domain = 'onscreen.primaryKey' AND entry_id = '10188';
-- Scene locstring IDs join to domain 'subtitle.stringId'; keep IDs as text.
```

Do not concatenate all game text into prompts or redistribute transcripts. Use short original summaries and source-located evidence for reviewed rules. The local cache remains ignored by Git.

## 4. Verified native read APIs

Method signatures below are from the inspected game script source. Existing CET code already exercises the tracked-entry subset. The broader batch/listener path still needs a bounded native capture qualification.

### Journal identity and state

`scripts/core/systems/journalManager.script` provides:

```text
JournalEntry.GetId() : String
JournalEntry.GetEditorName() : String

JournalManager.GetQuests(context : JournalRequestContext,
                         out entries : array<weak<JournalEntry>>)
JournalManager.GetChildren(parentEntry, filter : JournalRequestStateFilter,
                           out childEntries : array<weak<JournalEntry>>)
JournalManager.GetParentEntry(childEntry) : weak<JournalEntry>
JournalManager.GetEntry(hash : Uint32) : weak<JournalEntry>
JournalManager.GetEntryByString(uniquePath : String, className : String) : weak<JournalEntry>
JournalManager.GetEntryHash(entry) : Int32
JournalManager.GetEntryState(entry) : gameJournalEntryState
JournalManager.GetEntryTimestamp(entry) : GameTime
JournalManager.IsEntryVisited(entry) : Bool
JournalManager.GetTrackedEntry() : weak<JournalEntry>
JournalManager.GetIsObjectiveOptional(entry : weak<JournalQuestObjectiveBase>) : Bool
JournalManager.GetObjectiveCurrentCounter(entry : weak<JournalQuestObjective>) : Int32
JournalManager.GetObjectiveTotalCounter(entry : weak<JournalQuestObjective>) : Int32
JournalManager.GetQuestType(entry) : gameJournalQuestType
JournalManager.IsEp1Entry(entry) : Bool
```

`JournalRequestContext.stateFilter` has four independent booleans: inactive, active, succeeded and failed. For player-facing knowledge, include active/succeeded/failed entries, then apply a reviewed disclosure policy; avoid publishing inactive future objectives. A revealed completed objective is evidence of its own state. It is not proof of a specific optional outcome or of the whole quest succeeding.

Record full reconstructed journal paths plus native hashes and entry classes. `GetId()` alone is not guaranteed globally unique across different parents. Preserve `GetEntryHash()` as its actual signed 32-bit string; never compare it accidentally to an unsigned decimal from another representation without an explicit conversion. Localized display names must not be primary join keys.

For text, use `JournalQuest.GetTitle(journal)`, `JournalQuestObjectiveBase.GetDescription()`, `JournalQuestDescription.GetDescription()` and the localization API as the existing adapter does. Record localization keys alongside rendered text so data stays stable across UI language changes. Journal timestamps indicate a game timestamp supplied by that API; they are not proven real-world choice times or a total ordering of every narrative event.

`RegisterScriptCallback(obj, functionName, gameJournalListenerType.State)` is used by the game's quest-log controller. Its callback is:

```text
OnJournalReady(entryHash : Uint32, className : CName,
               notifyOption : JournalNotifyOption, changeType : JournalChangeType)
```

Treat callbacks as invalidations requiring a fresh read. Unregister with `UnregisterScriptCallback(obj, functionName)` on session teardown. Do not retain journal handles across a save load, and do not observe only UI controllers because the journal can change while that UI is closed.

### Facts

`scripts/core/systems/questSystem.script` exposes:

```text
QuestsSystem.GetFact(factName : CName) : Int32
QuestsSystem.GetFactStr(factName : String) : Int32
QuestsSystem.RegisterListener(factName : CName, listener : IScriptable, funcName : CName) : Uint32
QuestsSystem.UnregisterListener(factName : CName, id : Uint32)
```

The native prerequisite implementation in `scripts/core/gameplay/prereqs/factValuePrereq.script` uses `OnFactChanged(factValue : Int32)` with `RegisterListener`. A listener must be tied to an allowlisted fact and released at teardown. The inspected interface has no general `GetAllFacts()` or verified existence check. A read yielding zero cannot distinguish an unknown/misspelled key from an unset or zero-valued valid fact. Therefore extraction membership, stage gates and version compatibility matter as much as the returned number.

Facts are signed integers in the runtime API. Preserve integer values and exact operators; do not reduce every fact to a Boolean. The save parser reads their raw 32-bit representations as unsigned values, so binary-save tooling should retain both raw bits and an explicit signed interpretation.

### Time and session lifecycle

From `scripts/core/systems/gameInstance.script` and `timeSystem.script`:

```text
GameInstance.IsRestoringState(game) : Bool
GameInstance.GetPlaythroughTime(game) : EngineTime
GameInstance.GetGameTime(game) : GameTime
GameInstance.GetSimTime(game) : EngineTime
GameInstance.GetFrameNumber(game) : Uint64
TimeSystem.GetGameTime() : GameTime
TimeSystem.GetGameTimeStamp() : Float
```

Codeware adds `GameTime.seconds : Int32`. The third-party reference uses `EngineTime.ToFloat(GameInstance.GetPlaythroughTime(GetGameInstance()))`; this is a useful rollback/time marker, not a unique identity. Sim time is not an appropriate persistent primary key.

Codeware defines `Session/BeforeStart`, `Session/Start`, `Session/Ready`, `Session/BeforeEnd`, `Session/End`, `Session/BeforeSave`, `Session/AfterSave`, `Session/Pause` and `Session/Resume`. `GameSessionEvent` exposes `IsRestored()` and `IsPreGame()`. Its event object does not expose a verified playthrough ID or save path. Registration timing matters: a per-save ScriptableSystem attaching after a ready event can miss it. The inspected reference handles persistent restore in `OnRestored(saveVersion, gameVersion)` as well as readiness callbacks; that architecture is useful but must be verified in our own native service.

## 5. How to connect facts to real branches

Installed Codeware generated types provide these concrete structures:

| Resource/node | Inspected fields relevant to mapping |
| --- | --- |
| `questQuestResource` | Extends `questQuestPhaseResource`; graph resource. |
| `questPhaseNodeDefinition` | `phaseResource`, embedded `phaseGraph`, phase prefab scope. |
| `questSceneNodeDefinition` | `sceneFile`, interruption operations, scene location. |
| `questFactsDBManagerNodeDefinition` | Typed `type` payload. |
| `questSetVar_NodeType` | `factName`, `value`, `setExactValue`. Record whether it assigns or accumulates. |
| `questFactsDBCondition` | Typed `type` payload. |
| `questVarComparison_ConditionType` | `factName`, `value`, `comparisonType`. |
| `questVarVsVarComparison_ConditionType` | `factName1`, `factName2`, `comparisonType`. |
| `questLogicalCondition` | `operation`, child `conditions`. Preserve the entire tree. |
| `questSwitchNodeDefinition` | `behaviour`, `conditions`. Socket ordinal/branch is part of evidence. |
| `questJournalQuestEntry_NodeType` | Typed journal path; notification, tracking and optional flags. The incoming socket determines the state operation. |
| `questJournalEntryState_ConditionType` | Typed journal path, `state`, `inverted`. |
| `graphGraphConnectionDefinition` | `source` and `destination` socket handles. |
| `questNodeDefinition` | Graph-local `id`; not a CR2W `HandleId`. |

The index stores fact occurrences, condition payloads, node IDs, socket-resolved edges, journal path references and linked resource paths with source archive, asset hash and exact JSON pointers. It intentionally assigns no narrative meaning to names such as `*_failed`, `*_done` or `*_lover` merely because they sound meaningful.

A publishable rule needs a cited path through the correct graph: entry gate → exact comparison or selected choice → corresponding fact write and/or journal state → scene/dialogue or verified quest interpretation. Handle references must resolve within their serialization scope. Embedded phase graphs and external phase resources need separate graph identities even if numeric node IDs repeat. The topology, rather than editor screen position, establishes flow.

Use the release roots and reachable phase/scene links to resolve `versions/gold`, `versions/patch*` and similarly named assets. Exported-but-unreferenced test content belongs in the inventory and coverage report, but must not silently become release semantics. Preserve negative and conflicting evidence: multiple writers, increments, resets, alternate endings, bug-fix writers, timed resets and cases where journal success and a decision fact are separate effects.

### Scene and character joins

The existing scene JSON proves `scnSceneResource` contains `actors`, `playerActors`, `entryPoints`, `sceneGraph`, `screenplayStore`, `locStore` and other scene-local resources. A `scnscreenplayDialogLine` contains `speaker`, `addressee`, `itemId`, `locstringId`, gender usage and lipsync animation names. `locStore.vdEntries` maps localization-string IDs to variant IDs and locale descriptors. These are distinct identifier domains.

The inspected `localeId` is an explicit serialized enum name. Require `en_us`; do not assume an ordinal or use `db_db` because its content looks English. Each descriptor's `vpeIndex` indexes `locStore.vpEntries` from zero and its `variantId` must match the payload. Scene `locstringId.ruid` joins to the external subtitle `stringId` as an exact decimal string. The 93-scene cross-check verified all 30,102 descriptor/payload joins but found 151 embedded-text differences and 44 absent subtitle IDs among 8,889 English descriptors. Thus scene text is not automatically the installed display text. Preserve both sources, prefer the shipped language asset where content differs, and explicitly qualify missing IDs. The latest batch-level results are in `localization/queries/scene-join-summary.json`; exact joins and candidate evidence remain local in `scene-joins.jsonl`. `scripts/audit_scene_localization.py` refreshes this audit from all explicit winning-scene manifests without extracting new assets.

The actor ID joins a dialogue line to a scene actor definition; an actor definition then needs a validated join to the story character or entity template. Actor zero is not universally Johnny, and an invalid/self addressee is not proof of a solo observation. The prior Arroyo scene investigation found apparent solo V lines in entry graphs that also contain Johnny. Do not infer witness status from a dialogue file's directory name or its participant list alone: prove the relevant participant was in the executed branch.

Targeted extraction follows only scene references required for reviewed quest decisions and character arcs, recording exact branch/choice locators. Localization establishes what a selected choice and response say; it does not prove which branch ran in a loaded save. Avoid redistributing entire game transcripts; publish original summaries and evidence locators instead.

## 6. Save identity and rollback

The inspected `metadata.9.json` contains `playthroughID`, `playthroughTime`, `playTime`, `trackedQuestEntry`, `activeQuests`, `finishedQuests`, `lifePath`, `facts`, build/game versions, point-of-no-return/endgame flags and additional content IDs. Only 79 named `name=value` facts appear in this sample. This is a metadata subset, not a full facts database. No raw player identifier is reproduced in this document.

`inkISystemRequestsHandler.GetLatestSaveMetadata()` returns `LatestSaveMetadataInfo`, whose inspected native fields are location, tracked-quest title, lifepath, play time, playthrough time and loading-screen ID. Codeware additionally exposes game version and additional content IDs. It does not expose the disk metadata's `playthroughID`. Neither the newest file modification time nor the latest-save API proves which older save the player loaded.

WolvenKit's save `FactsTableParser` exposes fact hashes and values. Its `FactResolver` requires a dictionary; use names extracted from exact resource fields, compute FNV-1a 32-bit hashes, preserve collisions and unresolved hashes. Its current `JournalManagerParser` still labels substantial data unknown. A successful binary parse would not, by itself, establish all journal semantics. The audit has not loaded or rewritten `sav.dat`.

Recommended durable design:

1. Stable installation/user ID is separate from save identity, native character identity and temporary companion entity ID.
2. A small save-persistent ScriptableSystem owns a branch ID and committed event sequence. Local files store immutable event records and branch ancestry. This makes earlier saves point to earlier ledger positions.
3. Loading a previous sequence forks before adding new events. Do not append a changed outcome to the future branch or ask a shared long-term memory service to pretend both contradictory futures happened.
4. Initial installation into old saves needs a conservative baseline snapshot. It does not justify inventing the order of old choices, what was told to each companion, or when an event occurred.
5. Until save identity/branch ownership is qualified, allow transient dynamic context but withhold permanent quest-memory promotion. A generated user ID alone cannot distinguish two playthroughs or two branches of one playthrough.
6. Phone, private and group conversations need audience records. Seeing V's journal establishes `shared-journal` knowledge; it does not grant every character private witness memories.

The existing AI-NPC reference implements persistent integer branch/sequence fields and a per-save ScriptableSystem. It is a useful architecture example rather than proof our current bridge already has this behavior. In particular, its comment claiming the Panam `sq027` directory was absent is contradicted by this installation's inventory, which contains `base\quest\side_quests\sq027\sq0027_queen_of_the_highway.quest`; third-party mapping notes must be revalidated against the installed release.

## 7. Recommended capture contract

The parent authoring schema is `FORMAT.md`. A native snapshot should additionally carry:

- schema, collector and mapping version; exact game build/DLC fingerprint;
- session generation and restoring/ready state;
- separately qualified user, playthrough and branch/sequence identity evidence;
- capture start/end frame and monotonic timestamps, game time and playthrough time;
- journal entry path/hash/class, state, localized key/text, optional/counter data, timestamp and disclosure state;
- requested allowlisted fact, raw signed value or explicit unavailable result, read time, source-map version and membership evidence;
- completeness, truncation, errors and retry status.

Read in bounded batches after readiness and on debounced invalidations. Keep large dictionaries and source material outside per-message prompts. If a journal/fact invalidation occurs during a multi-frame capture, discard or retry the affected slice rather than publish mixed before/after evidence. Reset caches on save change and re-read before composing a reply. Native objects must never be serialized or retained across loads.

Runtime rules should have three outcomes: established, disproven, unknown. A rejected read, incomplete snapshot, unrecognized version, missing prerequisite, unresolved hash collision, competing fact values or reset in progress must produce unknown. Evaluated claims should retain rule ID, source version, snapshot ID, time and audience. Memory promotion then consumes only verified events with idempotency keys, revision/retraction behavior, and a save-scoped lineage. An API context-update success is not evidence that long-term memory was stored.

## 8. Qualification gates

- Re-extraction is deterministic by source fingerprint; interrupted exports resume without replacing another depot path.
- All winning resources are present, hash-checked and parsed, or explicit gaps are emitted.
- Graph edge endpoints and referenced handles resolve; source locators can be reopened to reproduce every indexed record.
- Full native journal traversal is verified against visible active/completed entries without changing visited/tracked state.
- Fact reads are qualified for a bounded allowlist, including a legitimate zero, a known positive value and an intentionally unavailable source result.
- At least one multi-condition decision is independently reviewed through the actual graph and linked scene text; its alternate outcomes stay mutually exclusive.
- Save reload, older-save rollback, two playthroughs, restart, duplicated companion copies and offline service failures preserve identity and do not leak future events.
- Unknown/missing version data and unreviewed mappings cannot enter dynamic claims or permanent memory.

## Sources consulted

- [Game journal interface, pinned source](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/fce9ab7e6a608b0d729290d898003589515900e1/scripts/core/systems/journalManager.script).
- [Game facts interface, pinned source](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/fce9ab7e6a608b0d729290d898003589515900e1/scripts/core/systems/questSystem.script).
- [Codeware session event](https://github.com/psiberx/cp2077-codeware/blob/main/scripts/Callback/Events/GameSessionEvent.reds) and [callback implementation](https://github.com/psiberx/cp2077-codeware/blob/main/src/App/Callback/CallbackSystem.cpp).
- [WolvenKit serializer implementation](https://github.com/WolvenKit/WolvenKit/blob/main/WolvenKit.Modkit/RED4/Tasks/Cr2wTask.cs).
- [WolvenKit facts parser](https://github.com/WolvenKit/WolvenKit/blob/main/WolvenKit.RED4/Save/Parser/FactsTableParser.cs) and [journal save parser](https://github.com/WolvenKit/WolvenKit/blob/main/WolvenKit.RED4/Save/Parser/JournalManagerParser.cs).
- [Quest-authoring identifier domains](https://hlky.github.io/cyberpunk-quest-authoring/foundations/identifier-domains.html), supplementary explanation independently checked against local typed resources.
- [AI-NPC reference source](https://github.com/Sebajuste/CP77_ai_npc), independently inspected local revision noted above.
