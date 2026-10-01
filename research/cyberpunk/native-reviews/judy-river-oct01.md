# Judy / River lane: October 1 research checkpoint

Date: 2026-10-01. Installed Cyberpunk 2077 2.31.

## Status

**Paused for the user's Codex restart. Four disabled proposals are saved; no executable rule was added.** The existing `native-rules/judy-river.json` remains unchanged, with its 16 previously reviewed rules. Its baseline SHA-256 is `16ef1c25e918eeb11467f95f781b44608600f6400bcf25d4d5867861b4181a6c`.

This is a research checkpoint, not a claim of runtime or live-save qualification. No game state, cloud profile, conversation, player identity, or Convai memory was changed. The previous lane review remains authoritative for the already qualified outcomes. Judy romance/friendship rules in `core-arcs.json` were checked and excluded from this batch to avoid duplicate coverage.

## Proposed coverage

| Proposed rule | New narrative link | Required positive observation | Knowledge boundary |
| --- | --- | --- | --- |
| `jr-native.disasterpiece-evelyn-extracted` | `judy-river.disasterpiece.recovery/extracted` | `q105_03_done=1` and the specific Disasterpiece quest journal Succeeded | Judy participated; no medical recovery or later survival is inferred. |
| `jr-native.both-evelyn-burial-received` | `judy-river.both.evelyn-death/death-confirmed` | Revealed `contacts/judy/sq026_01_burial/02_judy_msg_burial` | Judy sent V the burial report. Does not establish V's support choices. |
| `jr-native.revolution-overnight` | `judy-river.revolution.overnight/stayed` | Revealed `contacts/judy/sq026_03_sleepover/03_judy_msg_breakfast` | Judy's overnight care and morning message; no romance or breakfast consumption is implied. |
| `jr-native.pyramid-dive-completed` | `judy-river.pyramid.visit/completed` | `sq030_09_pier_done=1` | Shared dive and safe return; no romance, overnight choice, or optional disclosure is inferred. |

If independently approved, these add **four distinct researched outcomes**, taking this lane from 16 to 20 enabled outcomes. Current executable coverage remains 16. All four proposals limit speakers to Judy, with private/phone recipients V and Judy. Evelyn is unresponsive during the rescue, so assigning her knowledge of everything Judy and V did would be unjustified. River, Sandra and minor participants were not padded into this batch.

## Native traces already inspected

- **Extraction:** production floor-02 scene end feeds the specific quest's Succeeded input at node98, cleanup97/99, then the sole indexed positive completion writer111. In the scene, Leave choice2070 feeds departure section2206, leave-objective2018 Succeeded and end611. Actors bind Judy0, Evelyn1 and player V3. Scene dialogue identifies Evelyn and Judy's intervention. The completed quest gate is required alongside the fact.
- **Burial:** sq026 Both Sides Now phase51 completion feeds a 12-game-hour delay67, then burial phase117. Burial input0 waits for the content token and V being outside Judy's area, then activates greeting4 and burial5. Cooked journal LocKey#14597 joins installed English onscreen entry10463, an explicit burial report. A test input and cut-control repair entry also exist and are recorded for final audit. The runtime proposal uses the message receipt itself rather than a broad done flag.
- **Overnight:** production Judy apartment phase22 exposes the plan/end scene. Section1177 offers the couch; choice970 option1 accepts, section1665 confirms, fade2068 and delay2070 precede the restorative/wake-up sequence and message nodes2382/2383/2384. The installed morning, away and breakfast texts all match the cooked records. Only the final revealed message is proposed as the runtime selector.
- **Dive:** the normal sq030 dam12 -> lake13 -> hut14 path enters hut exploration; hut0 ->176 ->177 starts the pier scene. The scene's stay, left_before_morning, sex end and no_stay outputs all feed writer247. The invariant is the earlier dive/return, not which of those later branches happened. Sections1242/1244 describe the loss of consciousness and Judy getting V out; section386 refers to the completed dive. Explicit test/skip inputs still need the final route audit listed below.

The reference-closure chains establish production asset references only. They do not replace internal socket and initializer review. Broad `sq026_01_done` and `sq026_03_done` were deliberately avoided because earlier-stage setup writers exist. `judy_knows_johnny` has distinct scene writers, so it cannot by itself identify Revolution disclosure versus the later neural-link conversation. Revolution's refusal branch also marks its quest Succeeded; that status alone cannot prove acceptance.

## Evidence checkpoint

- Ignored authoring file: `runtime/judy-expansion-oct01/checkpoint.json`. It is **deliberately not a runtime pack**; every proposal has `enabled:false`, `reviewed:false`, and a pending-review status.
- Original selected trace plan: `runtime/judy-expansion-oct01/evidence-plan.json`.
- Fresh evidence manifests: `research/cyberpunk/cache/game/scene-evidence/judy-reviewed-oct01/inventory.json` and `judy-subtitles-oct01/inventory.json`.
- 21 bounded native artifacts were copied only after checking the cached binary SHA-256 and current installed archive entry SHA-1; WolvenKit 9.0.1 freshly serialized them into the task's own evidence folders. The manifests recorded JSON hashes before candidate writing. Shared inventories and generated outputs were not changed.
- The checkpoint writer verified **110 JSON pointers/types or scalar values, all associated binary hashes, and all fresh JSON hashes**.
- Fourteen selected English dialogue joins across rescue, planning and pier scenes matched installed subtitle entries, with **zero missing and zero changed**. Evidence retains each localized pointer. The two SMS joins were checked against cooked journal keys and installed onscreen entries.
- Full native asset/hash table: `runtime/judy-expansion-oct01/artifact-hashes.md`.

## Exact anchor receipts

### Disasterpiece completed writer

- JSON: `scene-evidence/judy-reviewed-oct01/raw/base/base/quest/main_quests/part1/q105/phases/q105_braindance_floor_02.questphase.json`
- Pointer: `/Data/RootChunk/graph/Data/nodes/12/Data`
- Binary SHA-256: `c12ab08ce5438214bb7af553f7c5961b8522f8e6f93ba731f4e236b56b5eb34f`
- Fresh JSON SHA-256: `830ae45699a3d5c534d4e05f10988b8892cd58360e344055bf99554a0619c2d9`

### Burial message activation

- JSON: `scene-evidence/judy-reviewed-oct01/raw/base/base/quest/side_quests/sq026/phases/sq026_msg_01_burial.questphase.json`
- Pointer: `/Data/RootChunk/graph/Data/nodes/5/Data`
- Binary SHA-256: `fa2b4db4149ccf40287ebbe03abdb967854071803921fdb7d7f520ec64b0e851`
- Fresh JSON SHA-256: `bdc39476551ee520a1689425812fe1264833e93b434c5466b6df3b9c9f1b89d5`

### Burial message text

- JSON: `scene-evidence/judy-reviewed-oct01/raw/base/base/localization/en-us/onscreens/onscreens_final.json.json`
- Pointer: `/Data/RootChunk/root/Data/entries/10463`
- Binary SHA-256: `73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b`
- Fresh JSON SHA-256: `4667c767cc3a4e2696a19cad3944a8d1da22ae6e497a16d41ef7af96a80d826d`

### Morning message activation

- JSON: `scene-evidence/judy-reviewed-oct01/raw/base/base/quest/side_quests/sq026/scenes/sq026_08_plan.scene.json`
- Pointer: `/Data/RootChunk/sceneGraph/Data/graph/250/Data`
- Binary SHA-256: `984ea5b1abc0ce8abc93697d8b66e469633a36ed4a06ea4add0212357a63c829`
- Fresh JSON SHA-256: `5063e1a1d2dd5e7fa1692b40d6a762d6f5dbbd861b515297389bd7d937561cb9`

### Morning message text

- JSON: `scene-evidence/judy-reviewed-oct01/raw/base/base/localization/en-us/onscreens/onscreens_final.json.json`
- Pointer: `/Data/RootChunk/root/Data/entries/10479`
- Binary SHA-256: `73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b`
- Fresh JSON SHA-256: `4667c767cc3a4e2696a19cad3944a8d1da22ae6e497a16d41ef7af96a80d826d`

### Post-dive completion writer

- JSON: `scene-evidence/judy-reviewed-oct01/raw/base/base/quest/side_quests/sq030/phases/sq030_hut.questphase.json`
- Pointer: `/Data/RootChunk/graph/Data/nodes/103/Data`
- Binary SHA-256: `418976828c6f86bf6a67621a5af9e71a30ffe24283b1111084ad344ba72096dd`
- Fresh JSON SHA-256: `f1accee12cb1d12d519096103d2c5313549d8ea13c0a3d1a01cd5f258899eaf5`

## Remaining before enabling

1. Complete the alternate-writer/initializer audit for the two facts, three journal selectors, repair nodes and scene/test inputs. The bounded main and currently exported scene fact indexes found one positive writer per proposed fact. This is not a claim that every unexported scene has been searched.
2. Finish reviewing saved production routes, especially asynchronous scene outputs, so completion cannot precede the intended event. Preserve the distinction between real normal input and exposed test/checkpoint input.
3. Add the exact cooked Disasterpiece journal pointer to final executable evidence. Its row is already saved in `runtime/judy-expansion-oct01/rescue-journal.jsonl`.
4. Independently review statements and recipient knowledge; then append final source/evidence/allowlist/rule entries to the existing lane pack without altering its valid 16 rules.
5. Run per-pack schema/native-evidence verification and focused pure resolver checks for missing/zero facts, unrevealed messages, wrong recipients, unknown game version, cumulative rescue/death history, and the separate completion gate.
6. Root must assess collector integration for `gameJournalQuest` and `gameJournalPhoneMessage`. Both classes exist in prior packs, but this research did not exercise the new aliases in the live collector. Do not weaken the predicate if a selector is unsupported.

There are **no owned workers or probes running** at this checkpoint. Extraction/serialization commands exited before the pause instruction. Nothing was installed, sent to Convai, or committed by this subagent.
