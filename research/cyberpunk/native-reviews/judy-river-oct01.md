# Judy / River lane: October 1 source expansion

Date: 2026-10-01. Installed Cyberpunk 2077 2.31.

## Status

**Four additions are now source-verified in revision2 of `native-rules/judy-river.json`; root integration review is pending.** This lane has20 rules. Its prior16 rules are structurally unchanged. Baseline SHA-256: `16ef1c25e918eeb11467f95f781b44608600f6400bcf25d4d5867861b4181a6c`; completed lane SHA-256: `de0a496412c822cf2892c400821b9f1a532e93ec363dd3c849a7552df2aa4186`.

This is source qualification, not runtime or live-save acceptance. Shared generated outputs were not written and nothing was installed or sent to Convai. No game state, cloud profile, conversation, player identity, or memory was changed. Judy romance/friendship rules in `core-arcs.json` are excluded to avoid duplicate coverage.

## Final guards added after the restart

- **Overnight:** the breakfast SMS activates before the wake sequence. The executable rule now also requires revealed `quests/side_quest/sq026_03_pizza/01_pizza_night/stay_night`, class `gameJournalQuestObjective`, Succeeded. This fixes the initial proposal's ordering gap. Unique chain:2384 ->2072 ->2073 ->2078 ->2662 ->2099 ->2081 ->2080 ->2084 ->wake2086 ->2096 input ordinal3, mapped to Succeeded. The wake section lasts9733ms; its timed workspot branch does not return to2096. The final text excludes accepting the Clouds plan, romance, eating breakfast and Johnny disclosure.
- **Dive:** `sq030_09_pier_done` is shared by a hut/sex test shortcut. The executable rule now additionally requires `sq030_lake_exploration>=1`. A fresh scene exposes the sole indexed positive increment2521 after mandatory underwater collapse2318. Completed pier alone, or positive lake history with unfinished pier, is suppressed.
- **Disasterpiece:** exact-path indexing returns eight questJournal references, of which five only track the quest. The three actual state writers are rescue98 and two EP1 initialization/repair nodes setting Succeeded. Keep the independent positive `q105_03_done` fact: completed journal state alone can be manufactured by initialization.
- **Burial:** delivered SMS is reported as Judy's message to V. It does not assert V read it or chose a particular support reply.

The following earlier checkpoint sections retain the originally proposed routes and anchors. Where their provisional predicates differ, the final guards above and the serialized rules are authoritative.

## Executable coverage

| Rule | New narrative link | Required positive observation | Knowledge boundary |
| --- | --- | --- | --- |
| `jr-native.disasterpiece-evelyn-extracted` | `judy-river.disasterpiece.recovery/extracted` | `q105_03_done=1` and the specific Disasterpiece quest journal Succeeded | Judy participated; no medical recovery or later survival is inferred. |
| `jr-native.both-evelyn-burial-received` | `judy-river.both.evelyn-death/death-confirmed` | Revealed `contacts/judy/sq026_01_burial/02_judy_msg_burial` | Judy sent V the burial report. Does not establish V's support choices. October 4: the reviewed native topic is `evelyn.story_status.burial`, a compatible burial facet; ID, link, condition, statement and audience are preserved. |
| `jr-native.revolution-overnight` | `judy-river.revolution.overnight/stayed` | Revealed breakfast SMS **and stay_night objective Succeeded** | Judy's completed overnight care and morning message; no planning agreement, romance, breakfast consumption or Johnny disclosure is implied. |
| `jr-native.pyramid-dive-completed` | `judy-river.pyramid.visit/completed` | `sq030_lake_exploration>=1` **and** `sq030_09_pier_done=1` | Shared dive and safe return; no romance, overnight choice, or optional disclosure is inferred. October 4: `judy.dive_visit.completed` is a compatible earlier stage of a later separately recorded departure; the original condition, statement, ID and link are unchanged. |

These add **four distinct researched outcomes**, taking this lane from16 to20 source-verified rules. All four restrict speakers to Judy, with private/phone recipients V and Judy. Group disclosure receipts cannot widen them. Evelyn is unresponsive during the rescue, so assigning her knowledge of everything Judy and V did would be unjustified. River, Sandra and minor participants were not padded into this batch.

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

## Final release/writer/async review

The fresh normal `ep1/quest/ep1.gamedef` schedules `base/quest/cyberpunk2077.quest`. The previously cited base reference ancestry then reaches these production phases. This is authored release inclusion, not a claim of runtime execution.

Extraction's Leave2070 branches to departure2206 and parallel workspot/door cleanup. Departure completion ->fade2409 ->leave-objective2018 Succeeded ->1889 ->3878 ->end611. Parallel3935/3760/3850 branches have no route to that end. Production phase6 invokes start/start_combat; exposed get_up and Start6 scene entries are unconnected there.

Burial test input8 bypasses normal content/location checks. Outer Txt_burial108 enters that test socket, but its parent sidequests socket is unconnected. A real repair145 ->cut146 cancels delay67 and starts burial117 In1. Cinematic-bugfix phase25 checks the repair flag, `sq026_01_done>=1`, and greeting Inactive. That still delivers Judy's authored report; it cannot establish human support choices. Exact q204 reference is a condition, not another writer. Burial bulk21 disables choices, not the report.

Overnight's placeholder2 entry jumps into1665 but is unconnected at production scene22. Section1665 timed outputs3/4 launch only workspots; concurrent fade2068 output4331 resets the camera and never returns to SMS. Every incoming edge in the post-breakfast wake chain is unique. Objective2096's sole incoming is wake2086 regular end ->ordinal3 Succeeded. Exact objective path indexes find no other individual writer; reviewed ancestor bulk updates set Active quests Failed rather than manufacturing Succeeded objectives.

Normal sq030 In1 follows setup11 ->dam12 ->lake13 ->hut14 exploration. The separate standalone `sq030.quest` exposes a chicken-test scene into hut/test/sex input24; it has no indexed caller and is outside the released reference closure. Its shortcuts are not reconstructed as player choices.

Fresh lake scene `sq030_06_lake_exploration.scene` proves a positive invariant. Section2318 plays the11.2-second `q030__idle_swim__heart_attack__01` on performer1793, mapped to `#player`/V. Completion socket(0,0) ->5699 ->2521 (increment lake history) ->4413 ->2524 ->2526 ->1954 ->3196 ->4206 ->Terminating End1/1260. Timed3454/5724/4540 branches dead-end. Removing2318 or any terminal-chain node prevents End1; every scene entry reaching End1 passes the collapse and increment. Lake phase exploration then feeds hut/pier. Existing pier recovery section1244 supplies Judy's authored account of lifting V out; it does not prove the optional recap was selected.

Across31 current facts indexes, the lake/pier keys have three occurrences: one lake increment, one exact pier assignment and one pier comparison. No initializer/reset or alternate writer was observed. The q105 fact similarly has one exact positive assignment. This covers the indexed4573 native quest/phase/journal artifacts plus bounded scene indexes; it does **not** claim every unexported scene, console edit or external mod was searched.

## Final receipts and executed scenarios

- Strict direct `verifyNativeEvidence` import passed: **156 exact pointers across32 artifacts**, four valid narrative links, zero errors, zero legacy/unbound JSON pointers. The original21 fresh exports and14 selected English joins remain included. Full receipt: `runtime/judy-expansion-oct01/final-native-verify.json`. The shared build CLI was not run.
- New fresh manifests: `cache/game/scene-evidence/judy-release-final-oct01`, `judy-writers-final-oct01`, `judy-dive-final-oct01`, `judy-lake-final-oct01`. Existing/current installed archive-entry SHA1 and raw SHA256 were checked before serialization; JSON hashes were recorded before final citation. Full32-artifact hash table: `runtime/judy-expansion-oct01/final-artifact-hashes.md`. Every cited hash/pointer also lives in the source pack.
- `review_native_rules.mjs verify native-rules/judy-river.json` passed:20 rules,20 evidence entries,67 native JSON files including prior rules.
- `node --test bridge/native-judy-expansion.test.mjs`: **12 passed**, zero failures/skips. Real resolver scenarios include positive private/phone routes, missing/zero, unfinished/failed/wrong quest stages, unrevealed receipts, breakfast-before-wake, pier-test shortcut, refusal/shared-disclosure ambiguity, cumulative rescue/death, wrong speaker/group privacy, contradictory outcomes, unknown version and fresh rollback capture.
- Existing collector supports the exact-path `gameJournalQuest`, `gameJournalQuestObjective` and `gameJournalPhoneMessage` selectors and requires their parent-reveal checks. Actual new alias behavior in a live save remains unverified.

| Fresh final anchor | Binary SHA-256 | Recorded JSON SHA-256 |
| --- | --- | --- |
| Released EP1 gamedef | `30b735c237ea2344b3f667752b4f98fdbbe1283808594a51693cfa61aebc6579` | `4f24cc027024d390ac5972c8cec8a49b6a3f800820b95aaff4b93c6810b4fa40` |
| Lake-collapse scene | `f59a872ccaad8c49877b928a433b469902155a33d5aff79891ba1bd953f1d9ff` | `25e45e00cdb3b229e936463eac80e3ef763fe53a7a99d3a2fda901d5dc6d11e7` |

Dive removal/caller checks: `cache/game/scene-evidence/judy-dive-final-oct01/review.json`. Disasterpiece operation/socket receipts: `runtime/judy-expansion-oct01/disasterpiece-journal-states.json`.

## Root integration remaining

1. Independently review the final source semantics, actor/recipient restrictions and combined wake/dive gates.
2. Merge stable lane parts, run strict global provenance/coverage and integration gates, then decide on runtime rollout.
3. Verify the new aliases against actual live saves without changing game facts or weakening unknown predicates.

There are **no owned workers or probes running**. Extraction/serialization commands and both read-only route subagents finished. Nothing was installed, sent to Convai, or committed by this lane.
