# Phantom Liberty expansion checkpoint — October 1, 2026

**Paused before rule authoring and verification for the requested Codex restart.**

`native-rules/phantom.json` is unchanged. This checkpoint adds **zero executable rules and zero mapped outcomes**. The findings below are candidate evidence, not new source-verified mappings. No game actions, cloud requests, character edits, memory writes, installation, shared index writes or commits were performed by this lane.

## Scope and completed review

Read the existing Phantom review, all 24 existing rule narrative links, and the corresponding authored outcome records. Prioritized Alex's contact history and positive surviving contact rather than adding another description of an already-mapped ending.

Bounded fresh exports are retained under ignored `cache/game/scene-evidence/`:

| Batch | Exact resources | Result |
| --- | --- | --- |
| `phantom-oct01` | `q303_02_nighthawks.scene`, `q306_12_holo_alex_call.scene`, `q306_13_epilogue.scene` | All three winning EP1 assets exported and indexed; 3,001,722 decoded bytes |
| `phantom-oct01-evening` | `q304_04e_alex_heart_to_heart.scene` | Exported/indexed; 766,939 decoded bytes |
| `phantom-oct01-postcard` | `q306_postcard_alex.scene` | Exported/indexed; 19,560 decoded bytes |
| `phantom-oct01-release` | `ep1/quest/ep1.gamedef`, `ep1/quest/ep1_standalone.gamedef` | Both shipped definitions exported/indexed; 2,477 decoded bytes |

Each batch has its own inventory, binary SHA256 and archive-entry SHA1. Common game indexes were not modified. The inspector and selected edge records in `phantom-oct01/` are ignored helpers, not runtime code.

## Release-root correction

The existing `index/release-reference-closure.json` starts at `base/quest/cyberpunk2077.quest` and does **not** include the EP1 quest tree. It cannot independently qualify or reject PL assets.

The fresh `ep1/quest/ep1.gamedef` explicitly schedules:

- `base/quest/cyberpunk2077.quest` at `/Data/RootChunk/mainQuests/0/Data`.
- `ep1/quest/ep1.quest` at `/Data/RootChunk/mainQuests/1/Data`.
- The separate optional preorder quest at index 2.

`ep1_standalone.gamedef` is distinct: it schedules `ep1_standalone.quest` and `cyberpunk2077_ep1_standalone.quest`, plus the preorder quest. These are actual shipped definitions; the debug `.quest` files should not substitute for them.

The normal EP1 route is `ep1.quest` start node 1 → node 12 → node 27 → phase node 0 input `Base`. In `ep1.questphase`, Base node 0 waits for `ep1_active` at 14, then uses the normal new-game/production-testing checks to reach hub 22 and main-quest phase node 9 input `Base`. The complete selected raw edges are in ignored `phantom-oct01/release-edges.json`.

`ep1_main_quests` has the actual serial q301 → q302 → q303 → q304 route. Its node 18 checks `q304_songbirds_path`; the false output of `< 1` enters q306's `00_start`. This graph comparator is provenance, **not** a proposed zero-based outcome predicate.

## Candidate 1: Alex's first Moth meeting

Potential rule ID: `phantom.native.alex.first-meeting`.

Existing narrative link: `phantom.damned.alex-met/met`, quest `the-damned`.

Candidate positive conditions:

- `q303_02_nighthawks_back_with_reed == 1`.
- Revealed, succeeded exact objective `ep1/quests/main_quest/q303_baron/02_nighthawks/05_talk_reed_and_alex` (`gameJournalQuestObjective`).

The fresh nighthawks scene has binary SHA256 `ef5b0e80d4adc0f53aa1548b737e7fd5f7a963425fbf7aea9ed63a4d3a426c03`.

- Normal scene entry `in` points to node 1.
- Node 14533, graph index 1249, is the exact positive fact writer. Its operation is `/Data/RootChunk/sceneGraph/Data/graph/1249/Data/questNode/Data/type/Data`.
- Node 5338, graph index 61, completes the actual V/Reed/Alex conversation. It passes input ordinal 3 to journal node 9412, graph index 388. The journal node's socket table identifies ordinal 3 as `Succeeded`.
- Node 9408, graph index 387, only activates the same objective.
- The scene also has a `dbg_silverhand` entry, node 7951, that can send the same success signal. The separate positive back-with-Reed receipt is intended to avoid using that shortcut alone as proof.
- Removing node 5338 makes the succeeded objective unreachable from normal entry 1 in the structural scene graph. The positive receipt is reachable separately on the normal path. This analysis does not by itself prove scheduling of every scene event.
- Scene actor table identifies Alex at index 0 and Reed at index 1. Shipped English subtitle entry 201 matches the relevant Reed wrap-up line (string ID `3233823302591057920`).

Normal parent route: q303 `In1` → node 35 → phase node 8 (`q303_02_nighthawks.questphase`). That phase's ordinary route invokes scene node 8 input `in`; its debug/restoration starts require separate treatment.

Proposed audience: Alex and Reed, private/phone, each as an actual participant. Songbird should not inherit this private meeting automatically. Statement should establish the meeting and Alex learning Reed is alive, without implying a romance or later outcome.

Writer scan completed against all common fact indexes and every currently extracted scene fact index: one positive assignment in this scene, and one phase comparison. Literal raw quest/phase scans found only that comparison. No indexed reset or initializer was found. **Finish the route/initialization audit and save exact refs before enabling.**

## Candidate 2: Alex's completed living farewell

Potential rule ID: `phantom.native.alex.farewell`.

Existing narrative link: `phantom.sympathy.meeting/met`, quest `unfinished-sympathy`.

Candidate stage gates:

- Positive already-reviewed Songbird/NCX history (`q304_songbirds_path`, `q306_reed_killed`, `q306_launchpad_done`, all equal 1).
- `q306_epilogue_alex_welcomes_v == 1`.
- Revealed, succeeded exact objective `ep1/quests/main_quest/q306_somi_epilogue/00_epilogue/05_talk_to_alex` (`gameJournalQuestObjective`).

The fresh epilogue scene has binary SHA256 `cebbb1f5d9eeacc4ab7b0e0098284abfc1695483d27dd75655e2c6a0780916d1`.

- Normal `Start0` entry is node 10.
- Alex's welcome receipt is node 1609, graph index 173; exact positive write.
- Section 607, graph index 50, has her assignment disclosure. Section 612, graph index 54, has her decision to let V's illness run its course.
- Every structural path from normal entry 10 to completed-conversation node 418 passes both 607 and 612. Removal checks were performed independently for each.
- Section 1157, graph index 129, passes input ordinal 3 to journal node 418, graph index 25. Its socket table identifies `Succeeded`. Node 264, graph index 7, only activates this objective.
- Shipped English subtitle entries 61, 66, 67 and 123 corroborate the assignment/waiting content. Scene/installed wording must remain separately cited; some punctuation differs.
- `q306_epilogue_alex.questphase` node 3 invokes `Start0`; its `End 0` output reaches phase output 1. Parent `q306_06_epilogues` phase node 53 completion reaches quest-journal node 26 `Succeeded`.
- The production route arrives through q306 phase node 65 `ReedDead` → phase node 66 `ReedDead`. It must not be inferred solely from the standalone debug `REED dead, SOMI on moon` input.

Proposed audience: Alex alone, private/phone, participant. This is positive evidence of Alex being alive at this later encounter. It should **not** assert an immediate Firestarter survival predicate, Hansen's exact killer, completed retirement, the postcard's delivery, or that V has died. The existing public Firestarter alive outcome also includes Hansen's killing and remains outside this candidate.

Use the existing Firestarter `songbird` and NCX `moon` exclusivity groups. Contradictory Reed/NCX facts must suppress this history.

Writer scan found one positive welcome assignment in the scene and no indexed reset/initializer. Finish the all-route journal review and evidence serialization before enabling.

## Candidate 3: The coin gift

Potential rule ID: `phantom.native.alex.coin-gifted`.

Existing narrative link: `phantom.sympathy.coin/gifted`, quest `unfinished-sympathy`.

Use the completed farewell conditions above plus `q306_alex_coin_given == 1`.

- Choice 618, graph index 55, option ordinal 3 is the return-token choice.
- It reaches section 1144, graph index 126, where V offers the presidential token and Alex receives it.
- Section completion reaches item-removal node 1148, graph index 127. It removes `Items.q302_president_coin` from the player.
- That operation reaches fact node 1937, graph index 206, exact `q306_alex_coin_given = 1`.
- Shipped English subtitle entries 147–149 corroborate the transfer; the corresponding source lines are distinct from the branch option.
- Current indexed corpus has one writer. Persistent content and the postcard scene compare the flag but do not write it.

Proposed audience: Alex alone, private/phone, participant. Absence or zero must not enable the public `kept` outcome. No exact positive refusal receipt has been established.

## Deliberately unenabled findings

### Evening/dance

`q304_04e_v_dances_withalex` is a **mutable action-state flag**: scene node 1216 writes 1 and node 2904 writes 0. It cannot be used alone as durable proof that V danced. The separate `q304_04e_v_danced_again` positive writer (node 2707) covers later join paths, not all initial dances. `q304_04e_heart_to_heart_done` is reached from several exits, so it also cannot prove dancing. The authored combined drink-and-dance outcome remains unmapped pending a durable predicate that covers its actual meaning.

### Postcard/runtime extension candidate

The current schema accepts quests/objectives/phone messages and choices, but rejects `gameJournalOnscreen`. The postcard's native receipt/read path is an onscreen shard, not a phone message.

Exact selectors:

- `ep1/onscreens/shards/quests/main_quests/q306/q306_postcard_alex`.
- `ep1/onscreens/shards/quests/main_quests/q306/q306_postcard_alex1`.
- Both have class `gameJournalOnscreen`.

Fresh `q306_postcard_alex.scene` normal entry 1 → choice 4. The selected pickup branches add `Items.q306_postcard_alex` (node 15) or `Items.q306_postcard_alex_v02` (node 69), then wait for **`questJournalEntryVisited_ConditionType`, `visited = 1`**, at nodes 41 and 75 respectively. The corresponding exact path objects are:

- `/Data/RootChunk/sceneGraph/Data/graph/9/Data/questNode/Data/condition/Data/type/Data/path/Data`.
- `/Data/RootChunk/sceneGraph/Data/graph/18/Data/questNode/Data/condition/Data/type/Data/path/Data`.

The cooked EP1 journal entries exist at:

- `/Data/RootChunk/entry/Data/entries/7/Data/entries/2/Data/entries/1/Data/entries/1/Data/entries/1/Data/entries/34/Data`.
- The same parent path, `entries/35/Data`.

Title localization is `92464`; descriptions are `92466` and `93140`. The latter texts have not yet been read/corroborated in this checkpoint. The parent persistent phase spawns a postcard at V's apartment after the epilogue, but spawning it does **not** establish receipt or reading. A justified runtime extension would need a bounded, positively captured `visited` state and appropriate revealed-state handling for exactly these selectors; merely whitelisting the class or using generic quest completion is insufficient.

## Remaining work after restart

1. Finish branch/reset/initialization and journal-transition audits for the three main candidates, including normal production starts and saved-history semantics.
2. Serialize exact source/type/value/edge pointers and hashes into the owned native pack. Record fresh JSON hashes separately from legacy exports; do not retroactively claim old export integrity.
3. Add only the three defensible public links, unless additional outcomes receive equally specific proof. Current executable delta is zero.
4. Run read-only `verifyNativeEvidence` with combined inventories and local authored decisions; **do not run the builder CLI**, which writes shared generated files.
5. Run bounded actual-resolver tests for positive paths, absent/ambiguous zero, hidden or incomplete journals, wrong audience, session-only memory suppression and conflicting endings.
6. Root can independently assess the postcard collector extension. No runtime/schema file belongs to this lane.

All extraction processes completed before this checkpoint. No game/capture worker was started by this agent. No new probe or work should start until the root resumes after the requested restart.
