# Aldecaldo and Dakota native evidence review

Reviewed against the installed Cyberpunk 2077 **2.31** archive exports on 2026-09-30. This document accompanies `../native-rules/aldecaldos.json`. It is a source review, not a current-save observation or in-game acceptance report.

## Scope and completion boundary

The narrative lane contains 30 quests, 74 decisions and 122 outcome branches. This native pass enables **16 narrowly evidenced outcomes** and retains **106 explicit unmapped outcomes** with individual reasons. The remaining research is not presented as executable coverage.

The seven owned profiles are Panam Palmer, Saul Bright, Mitch Anderson, Carol Emeka, Cassidy Righter, Bob Sagan and Dakota Smith. Executable memories in this pass belong only to Panam, Saul and Dakota. The other four retain their sourced static dossiers and conditional narrative research; they do not acquire witnessed events merely because their models can be spawned or their names occur in a scene actor list.

No gameplay scripts, native binaries, live save facts, cloud character profiles or memory stores were changed by this pass. No Git commit was created by this lane.

## Method and evidence strength

- Used the complete winning quest/phase/journal inventory (4,573 assets), its scoped node/edge/fact indexes, and separately manifested targeted scene exports. The raw copied assets and full transcripts stay in the ignored cache.
- Checked actual assignments, comparison operators, graph-local node IDs, resolved input/output socket names, entry points, positive branch consequences and scene participation. Resource reference closure locates production ancestry; it does not prove a branch executed.
- The shipped `cyberpunk2077.gamedef` explicitly launches `cyberpunk2077.quest`, which invokes the main phase. Production sidequest and open-world routes are distinguished from isolated `.quest` test launchers, debug sockets and performance scenes.
- Every native evidence reference includes the source binary SHA-256, exact exported JSON pointer and pointed type when available. The compiler recomputes the binary hash and checks each pointer/type. These checks detect stale or invented citations; they do not replace the human semantic review below.
- All 18 allowlisted fact names were searched for assignment writers across the complete quest index and every currently exported scene batch. The current scope contains one writer for each except `ina_06_finished` and `ina_06_iris_hired`, which each have two reviewed success writers. No contrary/reset writer was found for these selected receipts in that scope. This is not an assertion that every game scene was exported.
- Additive completion receipts use `gte 1`; exact assignments use `eq 1`. Zero, missing observations, hidden journal entries and another game version do not qualify. No zero-as-false or absent-fact-as-refusal interpretation is authored.
- Exact journal path/class aliases are joined to the winning cooked journal entries. No numeric journal hash is guessed. The native adapter must resolve the selector and observe a revealed current-save state before the rule can qualify.
- For scene meaning, authored prose is original. Scene localization locators are evidence, not copied dialogue. The extraction audit identified one embedded/shipped-text mismatch in the Basilisk scene at `vdEntries/467`; this pack does not rely on that descriptor. The newly extracted transport-delivered and camp-saved scene English entries match the installed subtitle table.

## Disclosure, branches and long-term memory

- Panam's intimacy and Relic explanation remain private to V and Panam. Saul's report conversation remains private to V and Saul. A report to Saul does not itself prove Panam has heard an angry follow-up message.
- Panam witnesses Saul's fatal cinematic. Saul is not granted a memory of his own later death, and absent clan members are not assumed to know it.
- Dakota receives only the completed contract result she commissioned/debriefed. She is not described as standing at the rescue, killing a target, seeing hidden evidence or knowing all of V's optional conversations.
- `aldecaldos.sq027-route` distinguishes `assisted` from `betrayed` independently of the output topics. If contradictory positive data contains both, all affected route facts are suppressed before audience filtering. Useful assisted facets can coexist when consistent.
- Completed q114 initiation and Saul's q116 death participate in `ending.assault-route = aldecaldos`. Opposite positively established ending routes in other lanes suppress contradictory current context and memory candidates. No missing opposing route flag is interpreted as rejection.
- Each dynamic fact remains scoped to the actual captured current world. Historical outcomes are phrased as save-established events, not proof the human manually chose every input; legitimate new-game/EP1 initialization can establish history. None of this authorizes testing or debug setup as an event source.
- Stable outcome candidates still require verified native user/playthrough/branch/checkpoint identity in the resolver. An account ID alone, a newly spawned NPC, a stale previous snapshot or a broad franchise biography is not enough for long-term memory. These authored rules do not write Convai memory directly.

## Enabled outcome matrix

| Rule | Exact branch | Recipient knowledge | Runtime condition |
| --- | --- | --- | --- |
| `aldecaldos.native.panam-plan-disclosed` | `aldecaldos.friends.loyalty/reported-saul` | saul-bright; participant | `{"type":"fact","key":"sq027_panam_ratted_out","op":"eq","value":1}` |
| `aldecaldos.native.panam-basilisk-intimacy` | `aldecaldos.queen.romance/romanced` | panam-palmer; private | `{"all":[{"type":"fact","key":"sq027_panzer_sex","op":"eq","value":1},{"type":"fact","key":"sq027_panam_lover","op":"eq","value":1}]}` |
| `aldecaldos.native.panam-relic-explanation` | `aldecaldos.queen.relic-disclosure/explained-panam` | panam-palmer; private | `{"type":"fact","key":"sq027_panam_knows_about_chip","op":"eq","value":1}` |
| `aldecaldos.native.saul-riders-rescue` | `aldecaldos.riders.rescue/rescued` | saul-bright; participant | `{"all":[{"type":"fact","key":"sq004_saul_rescued","op":"eq","value":1},{"type":"journal","key":"aldecaldos.riders.completed","op":"eq","value":"succeeded"}]}` |
| `aldecaldos.native.v-aldecaldo-initiation` | `aldecaldos.together.initiation/initiated` | panam-palmer, saul-bright; participant | `{"type":"journal","key":"aldecaldos.initiation.completed","op":"eq","value":"succeeded"}` |
| `aldecaldos.native.saul-smasher-death` | `aldecaldos.belly.saul/killed-by-smasher` | panam-palmer; witnessed | `{"type":"fact","key":"q116_saul_dead","op":"eq","value":1}` |
| `aldecaldos.native.dakota-antenna-disabled` | `aldecaldos.flying.antenna/disabled` | dakota-smith; participant | `{"type":"fact","key":"ina_03_finished","op":"eq","value":1}` |
| `aldecaldos.native.dakota-minefield-delivery` | `aldecaldos.minefield.vehicle/delivered` | dakota-smith; participant | `{"type":"fact","key":"ina_07_finished","op":"eq","value":1}` |
| `aldecaldos.native.dakota-trevor-returned` | `aldecaldos.trevor.remains/delivered` | dakota-smith; participant | `{"type":"fact","key":"ina_08_finished","op":"gte","value":1}` |
| `aldecaldos.native.dakota-sparring-delivered` | `aldecaldos.sparring.software/delivered` | dakota-smith; participant | `{"type":"fact","key":"ina_11_finished","op":"eq","value":1}` |
| `aldecaldos.native.dakota-iris-van-delivery` | `aldecaldos.nofixers.rescue/delivered-with-van` | dakota-smith; participant | `{"all":[{"type":"fact","key":"ina_06_car_delivered","op":"gte","value":1},{"type":"fact","key":"ina_06_iris_hired","op":"gte","value":1},{"type":"fact","key":"ina_06_finished","op":"gte","value":1}]}` |
| `aldecaldos.native.dakota-ben-returned` | `aldecaldos.mia.extraction/delivered` | dakota-smith; participant | `{"all":[{"type":"fact","key":"ina_09_finished","op":"gte","value":1},{"type":"fact","key":"ina_09_arrived_to_nomad","op":"gte","value":1}]}` |
| `aldecaldos.native.dakota-bruce-returned` | `aldecaldos.goodbye.extraction/delivered` | dakota-smith; participant | `{"all":[{"type":"fact","key":"ina_05_done","op":"gte","value":1},{"type":"fact","key":"ina_05_archi_talk_ended","op":"gte","value":1}]}` |
| `aldecaldos.native.dakota-radar-delivered` | `aldecaldos.radar.prototype/delivered` | dakota-smith; participant | `{"all":[{"type":"journal","key":"aldecaldos.radar.delivery","op":"eq","value":"succeeded"},{"type":"journal","key":"aldecaldos.radar.completed","op":"eq","value":"succeeded"}]}` |
| `aldecaldos.native.basilisk-convoy-secured` | `aldecaldos.friends.convoy/secured` | panam-palmer, saul-bright; participant | `{"type":"fact","key":"sq027_convoy_hit_done","op":"eq","value":1}` |
| `aldecaldos.native.panam-saul-co-leadership` | `aldecaldos.queen.leadership/co-leaders` | panam-palmer, saul-bright; participant | `{"type":"journal","key":"aldecaldos.panam.leadership","op":"eq","value":"succeeded"}` |

## Exact journal selectors

| Alias | Native class | Native path |
| --- | --- | --- |
| `aldecaldos.riders.completed` | `gameJournalQuest` | `quests/side_quest/sq004_riders_on_the_storm` |
| `aldecaldos.initiation.completed` | `gameJournalQuestObjective` | `quests/main_quest/act_01/q114_01_nomad_initiation/preparations/take_part_in_initiation` |
| `aldecaldos.radar.delivery` | `gameJournalQuestObjective` | `quests/street_stories/badlands/inland_avenue/sts_bls_ina_04/retrieve_the_van/deliver_car` |
| `aldecaldos.radar.completed` | `gameJournalQuest` | `quests/street_stories/badlands/inland_avenue/sts_bls_ina_04` |
| `aldecaldos.panam.leadership` | `gameJournalQuestObjective` | `quests/side_quest/sq027_02_raffen_shiv_attack/05_camp_attack/02a_meet_with_saul` |

## Per-event semantic review

### release-entry

The shipped PC gamedef names cyberpunk2077.quest as its main quest. That quest invokes cyberpunk2077.questphase. The shared release-reference-closure was used only to locate resource ancestry; graph inputs and event branches below establish possible execution. This is source reachability, never proof that the current save traversed a branch. Standalone sq0027_queen_of_the_highway.quest, performance tests and debug start graphs are not used as outcome evidence.

Native locators:

- `scene-evidence/release-root/raw/base/base/quest/cyberpunk2077.gamedef.json` → `/Data/RootChunk/mainQuests/0/Data` (`gsmMainQuest`).
- `raw/base/base/quest/cyberpunk2077.quest.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.questphase.json` → `/Data/RootChunk/graph/Data` (`questGraphDefinition`).

### sidequest-entry

The normal Riders return (43.Out1) and an already-completed Riders comparison (190.True, sq004_done >=1) converge at hub191, pass the 12-hour delay125, and enter46.In1. sq027 is the production phase, not the extra-zero standalone quest. These gate facts are not added to the runtime allowlist and do not become memories by themselves. The normal shared phase has separate Testing and In1 inputs; cited production resource ancestry is retained.

Native locators:

- `raw/base/base/quest/side_quests/sidequests.questphase.json` → `/Data/RootChunk/graph/Data/nodes/9/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/side_quests/sidequests.questphase.json` → `/Data/RootChunk/graph/Data/nodes/10/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/side_quests/sidequests.questphase.json` → `/Data/RootChunk/graph/Data/nodes/32/Data` (`questPauseConditionNodeDefinition`).
- `raw/base/base/quest/side_quests/sidequests.questphase.json` → `/Data/RootChunk/graph/Data/nodes/61/Data` (`questConditionNodeDefinition`).
- `raw/base/base/quest/side_quests/sidequests.questphase.json` → `/Data/RootChunk/graph/Data/nodes/62/Data` (`questLogicalHubNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.questphase.json` → `/Data/RootChunk/graph/Data/nodes/7/Data/phaseGraph/Data/nodes/4/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.quest.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).

### report-to-saul

The reporting choice identifies Panam and her accomplices; the alternative leaves their plan alone. The affirmative route sets sq027_disloyal_v and has V tell Saul the theft plan. In the production phase the scene ratted_out output and approach phase join at49 before the talk-to-Saul objective is marked Succeeded. The subsequent chain81 ->83 ->32 ->26 writes sq027_panam_ratted_out exactly1 and grants the betrayal reward. This authorizes Saul as a participant, not Panam as an omniscient listener. Later angry calls/messages are not inferred merely from the report. Assisted sq027 facets share an exclusive route group with this rule.

Native locators:

- `raw/base/base/quest/side_quests/sq027/sq027_queen_of_the_highway.questphase.json` → `/Data/RootChunk/graph/Data/nodes/25/Data/phaseGraph/Data/nodes/9/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/quest/side_quests/sq027/sq027_queen_of_the_highway.questphase.json` → `/Data/RootChunk/graph/Data/nodes/25/Data/phaseGraph/Data/nodes/2/Data` (`questSceneNodeDefinition`).
- `raw/base/base/quest/side_quests/sq027/sq027_queen_of_the_highway.questphase.json` → `/Data/RootChunk/graph/Data/nodes/25/Data/phaseGraph/Data/nodes/18/Data` (`questLogicalAndNodeDefinition`).
- `raw/base/base/quest/side_quests/sq027/sq027_queen_of_the_highway.questphase.json` → `/Data/RootChunk/graph/Data/nodes/25/Data/phaseGraph/Data/nodes/19/Data` (`questJournalNodeDefinition`).
- `raw/base/base/quest/side_quests/sq027/sq027_queen_of_the_highway.questphase.json` → `/Data/RootChunk/graph/Data/nodes/25/Data/phaseGraph/Data/nodes/6/Data` (`questRewardManagerNodeDefinition`).
- `scene-evidence/aldecaldos-native/raw/base/base/quest/side_quests/sq027/scenes/sq027_03_saul_whistleblowing.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/5/Data` (`scnChoiceNode`).
- `scene-evidence/aldecaldos-native/raw/base/base/quest/side_quests/sq027/scenes/sq027_03_saul_whistleblowing.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/10/Data` (`scnQuestNode`).
- `scene-evidence/aldecaldos-native/raw/base/base/quest/side_quests/sq027/scenes/sq027_03_saul_whistleblowing.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/6/Data` (`scnSectionNode`).
- `raw/base/base/quest/side_quests/sq027/sq027_queen_of_the_highway.questphase.json` → `/Data/RootChunk/graph/Data/nodes/25/Data` (`questPhaseNodeDefinition`).

### basilisk-intimacy

The affirmative physical-intimacy choice, not the existence of Panam or a completed quest, is the first predicate. The romance receipt is written after the accepted cinematic branch converges. The rule requires BOTH positive exact facts; it does not infer platonic refusal from missing/zero data. Panam is the scene participant and both the invitation and subsequent encounter are private. Native censorship variants affect presentation, not the accepted choice branch. The embedded localized text is used only as inspected branch context; the audit found one scene/subtitle discrepancy elsewhere at vdEntries467, so neither this pack nor its review claims all embedded strings equal shipped subtitles. Historical intimacy does not establish which ending or current romantic status applies.

Native locators:

- `scene-evidence/core-relationships/raw/base/base/quest/side_quests/sq027/scenes/sq027_06_panzer.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/82/Data` (`scnQuestNode`).
- `scene-evidence/core-relationships/raw/base/base/quest/side_quests/sq027/scenes/sq027_06_panzer.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/125/Data` (`scnQuestNode`).
- `scene-evidence/core-relationships/raw/base/base/quest/side_quests/sq027/scenes/sq027_06_panzer.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/80/Data` (`scnChoiceNode`).
- `scene-evidence/core-relationships/raw/base/base/quest/side_quests/sq027/scenes/sq027_06_panzer.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/145/Data` (`scnHubNode`).
- `scene-evidence/core-relationships/raw/base/base/quest/side_quests/sq027/scenes/sq027_06_panzer.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/521/Data` (`scnSectionNode`).
- `scene-evidence/core-relationships/raw/base/base/quest/side_quests/sq027/scenes/sq027_06_panzer.scene.json` → `/Data/RootChunk/screenplayStore/options/11` (`scnscreenplayChoiceOption`).
- `scene-evidence/core-relationships/raw/base/base/quest/side_quests/sq027/scenes/sq027_06_panzer.scene.json` → `/Data/RootChunk/screenplayStore/options/12` (`scnscreenplayChoiceOption`).
- `raw/base/base/quest/side_quests/sq027/phases/sq027_04_hovertank.questphase.json` → `/Data/RootChunk/graph/Data/nodes/11/Data` (`questSceneNodeDefinition`).
- `raw/base/base/quest/side_quests/sq027/sq027_queen_of_the_highway.questphase.json` → `/Data/RootChunk/graph/Data/nodes/21/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/side_quests/sidequests.questphase.json` → `/Data/RootChunk/graph/Data/nodes/10/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.questphase.json` → `/Data/RootChunk/graph/Data/nodes/7/Data/phaseGraph/Data/nodes/4/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.quest.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).

### panam-relic-disclosure

Panam and V discuss the biochip and the damage it is doing to V. Both explanation branches return to the common conversation section which sets the knowledge receipt. The different sq027_panam_doesnt_know_about_johnny flag is not used: its write is attached to a hub/choice activation and does not independently prove a completed negative disclosure. This rule therefore gives Panam the damaging Relic/construct information but never automatically names Johnny, shares it with the entire camp, or supplies a cure/ending.

Native locators:

- `scene-evidence/core-relationships/raw/base/base/quest/side_quests/sq027/scenes/sq027_09_new_camp_wakeup.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/53/Data` (`scnQuestNode`).
- `scene-evidence/core-relationships/raw/base/base/quest/side_quests/sq027/scenes/sq027_09_new_camp_wakeup.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/26/Data` (`scnSectionNode`).
- `scene-evidence/core-relationships/raw/base/base/quest/side_quests/sq027/scenes/sq027_09_new_camp_wakeup.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/27/Data` (`scnChoiceNode`).
- `scene-evidence/core-relationships/raw/base/base/quest/side_quests/sq027/scenes/sq027_09_new_camp_wakeup.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/28/Data` (`scnSectionNode`).
- `scene-evidence/core-relationships/raw/base/base/quest/side_quests/sq027/scenes/sq027_09_new_camp_wakeup.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/29/Data` (`scnSectionNode`).
- `scene-evidence/core-relationships/raw/base/base/quest/side_quests/sq027/scenes/sq027_09_new_camp_wakeup.scene.json` → `/Data/RootChunk/screenplayStore/lines/41` (`scnscreenplayDialogLine`).
- `scene-evidence/core-relationships/raw/base/base/quest/side_quests/sq027/scenes/sq027_09_new_camp_wakeup.scene.json` → `/Data/RootChunk/screenplayStore/lines/42` (`scnscreenplayDialogLine`).
- `raw/base/base/quest/side_quests/sq027/sq027_queen_of_the_highway.questphase.json` → `/Data/RootChunk/graph/Data/nodes/28/Data/phaseGraph/Data/nodes/3/Data` (`questSceneNodeDefinition`).
- `raw/base/base/quest/side_quests/sq027/sq027_queen_of_the_highway.questphase.json` → `/Data/RootChunk/graph/Data/nodes/28/Data` (`questPhaseNodeDefinition`).

### saul-rescue

sq004_saul_rescued is written when Saul is freed and the follower begins, not after the entire escape. To avoid prematurely treating an escape in progress as completed, the rule additionally requires the revealed Riders on the Storm journal to be Succeeded. Native farm scene245.morning_after_out drives that Succeeded input. The journal selector is the exact cooked entry path/class; no numeric hash is guessed. Saul is the freed actor named in the follower sequence and participant in the rescue. The condition does not distinguish quiet versus pursued extraction, V's choice in the farmhouse argument, or romance.

Native locators:

- `raw/base/base/quest/side_quests/sq004/phases/subphases/sq004_follower.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/quest/side_quests/sq004/phases/subphases/sq004_follower.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data` (`questRewardManagerNodeDefinition`).
- `raw/base/base/quest/side_quests/sq004/phases/sq004_03_raffen_shiv_camp.questphase.json` → `/Data/RootChunk/graph/Data/nodes/12/Data` (`questSceneNodeDefinition`).
- `raw/base/base/quest/side_quests/sq004/phases/sq004_03_raffen_shiv_camp.questphase.json` → `/Data/RootChunk/graph/Data/nodes/13/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/side_quests/sq004/phases/sq004_05_farm.questphase.json` → `/Data/RootChunk/graph/Data/nodes/7/Data` (`questSceneNodeDefinition`).
- `raw/base/base/quest/side_quests/sq004/phases/sq004_05_farm.questphase.json` → `/Data/RootChunk/graph/Data/nodes/8/Data` (`questJournalNodeDefinition`).
- `raw/ep1/base/journal/cooked_journal.journal.json` → `/Data/RootChunk/entry/Data/entries/0/Data/entries/5/Data/entries/45/Data` (`gameJournalQuest`).
- `raw/base/base/quest/side_quests/sq004/sq004_riders_on_the_storm.questphase.json` → `/Data/RootChunk/graph/Data/nodes/12/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/side_quests/sidequests.questphase.json` → `/Data/RootChunk/graph/Data/nodes/9/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.questphase.json` → `/Data/RootChunk/graph/Data/nodes/7/Data/phaseGraph/Data/nodes/4/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.quest.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).

### v-initiated

q114_initiation_started and initiation_begun establish only the beginning and are deliberately excluded. Section555 has Panam welcome V to the family and sends its end to703 with input ordinal3; the node explicitly maps ordinal3 to Succeeded. Saul's membership dialogue is present in the same ceremony. Only the completed, revealed objective qualifies. Panam and Saul are mapped as participants; mere inclusion of other NPCs in a scene actor list is not used to grant them memories. The shared group audience is limited to those two people and V.

Native locators:

- `scene-evidence/aldecaldos-native/raw/base/base/quest/main_quests/part1/q114/scenes/q114_04_initiation.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/39/Data` (`scnQuestNode`).
- `scene-evidence/aldecaldos-native/raw/base/base/quest/main_quests/part1/q114/scenes/q114_04_initiation.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/17/Data` (`scnSectionNode`).
- `scene-evidence/aldecaldos-native/raw/base/base/quest/main_quests/part1/q114/scenes/q114_04_initiation.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/39/Data/isockMappings/3` (`CName`).
- `scene-evidence/aldecaldos-native/raw/base/base/quest/main_quests/part1/q114/scenes/q114_04_initiation.scene.json` → `/Data/RootChunk/screenplayStore/lines/28` (`scnscreenplayDialogLine`).
- `scene-evidence/aldecaldos-native/raw/base/base/quest/main_quests/part1/q114/scenes/q114_04_initiation.scene.json` → `/Data/RootChunk/screenplayStore/lines/62` (`scnscreenplayDialogLine`).
- `raw/base/base/quest/main_quests/part1/q114/phases/q114_preparations.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/2/Data` (`questSceneNodeDefinition`).
- `raw/ep1/base/journal/cooked_journal.journal.json` → `/Data/RootChunk/entry/Data/entries/0/Data/entries/1/Data/entries/0/Data/entries/5/Data/entries/1/Data/entries/10/Data` (`gameJournalQuestObjective`).
- `raw/base/base/quest/main_quests/part1/q114/phases/q114_01_main_nomad_camp.questphase.json` → `/Data/RootChunk/graph/Data/nodes/9/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/main_quests/part1/q114/q114_nomads.questphase.json` → `/Data/RootChunk/graph/Data/nodes/0/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/main_quests/part1/act_1.questphase.json` → `/Data/RootChunk/graph/Data/nodes/7/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.quest.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).

### saul-killed

The actual bossfight entry1 reaches the Saul branch through621 (executed gate interaction),605,625 and condition544. That condition compares q114_done >0; its True output invokes Panam and Saul cinematic control. Section538 contains synchronized Smasher-kills-Saul animations; its 28.813-second socket19 activates the Saul ragdoll and exact death receipt415. Panam's direct reaction is section1277, screenplay line38, on the same cinematic branch. The separate aftermath section233, lines37-39 and English descriptor199/vp104, explicitly discusses Smasher killing Saul and Saul's sacrifice. Its speaker is V (player actor6), not Panam. That optional dialogue is semantic corroboration of the death, not a claim that V selected that taunt or Panam heard it in the current save. This is lethal cinematic evidence, unlike the generic defeated/unconscious conditions in Big Pete. Panam is the witness. Saul, Bob and the rest of the clan are not granted posthumous or unobserved knowledge. A standalone test start exists but is not needed for release reachability.

Native locators:

- `scene-evidence/silverhand/raw/base/base/quest/main_quests/part1/q116/scenes/q116_01_adam_smasher.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/24/Data` (`scnQuestNode`).
- `scene-evidence/silverhand/raw/base/base/quest/main_quests/part1/q116/scenes/q116_01_adam_smasher.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/34/Data` (`scnQuestNode`).
- `scene-evidence/silverhand/raw/base/base/quest/main_quests/part1/q116/scenes/q116_01_adam_smasher.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/13/Data` (`scnQuestNode`).
- `scene-evidence/silverhand/raw/base/base/quest/main_quests/part1/q116/scenes/q116_01_adam_smasher.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/14/Data` (`scnQuestNode`).
- `scene-evidence/silverhand/raw/base/base/quest/main_quests/part1/q116/scenes/q116_01_adam_smasher.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/33/Data` (`scnSectionNode`).
- `scene-evidence/silverhand/raw/base/base/quest/main_quests/part1/q116/scenes/q116_01_adam_smasher.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/66/Data` (`scnQuestNode`).
- `scene-evidence/silverhand/raw/base/base/quest/main_quests/part1/q116/scenes/q116_01_adam_smasher.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/165/Data` (`scnSectionNode`).
- `scene-evidence/silverhand/raw/base/base/quest/main_quests/part1/q116/scenes/q116_01_adam_smasher.scene.json` → `/Data/RootChunk/screenplayStore/lines/38` (`scnscreenplayDialogLine`).
- `scene-evidence/silverhand/raw/base/base/quest/main_quests/part1/q116/scenes/q116_01_adam_smasher.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/33/Data/events/37/Data` (`scnPlaySkAnimEvent`).
- `scene-evidence/silverhand/raw/base/base/quest/main_quests/part1/q116/scenes/q116_01_adam_smasher.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/33/Data/events/56/Data` (`scneventsSocket`).
- `raw/base/base/quest/main_quests/part1/q116/phases/q116_smasher.questphase.json` → `/Data/RootChunk/graph/Data/nodes/5/Data` (`questSceneNodeDefinition`).
- `scene-evidence/silverhand/raw/base/base/quest/main_quests/part1/q116/scenes/q116_03b_after_bossfight.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/14/Data` (`scnSectionNode`).
- `scene-evidence/silverhand/raw/base/base/quest/main_quests/part1/q116/scenes/q116_03b_after_bossfight.scene.json` → `/Data/RootChunk/screenplayStore/lines/37` (`scnscreenplayDialogLine`).
- `scene-evidence/silverhand/raw/base/base/quest/main_quests/part1/q116/scenes/q116_03b_after_bossfight.scene.json` → `/Data/RootChunk/screenplayStore/lines/38` (`scnscreenplayDialogLine`).
- `scene-evidence/silverhand/raw/base/base/quest/main_quests/part1/q116/scenes/q116_03b_after_bossfight.scene.json` → `/Data/RootChunk/screenplayStore/lines/39` (`scnscreenplayDialogLine`).
- `scene-evidence/silverhand/raw/base/base/quest/main_quests/part1/q116/scenes/q116_03b_after_bossfight.scene.json` → `/Data/RootChunk/locStore/vdEntries/199` (`scnlocLocStoreEmbeddedVariantDescriptorEntry`).
- `scene-evidence/silverhand/raw/base/base/quest/main_quests/part1/q116/scenes/q116_03b_after_bossfight.scene.json` → `/Data/RootChunk/locStore/vpEntries/104` (`scnlocLocStoreEmbeddedVariantPayloadEntry`).
- `scene-evidence/silverhand/raw/base/base/quest/main_quests/part1/q116/scenes/q116_03b_after_bossfight.scene.json` → `/Data/RootChunk/playerActors/0` (`scnPlayerActorDef`).
- `raw/base/base/quest/main_quests/part1/q116/q116_mikoshi.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/main_quests/part1/act_1.questphase.json` → `/Data/RootChunk/graph/Data/nodes/8/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.quest.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).

### dakota-flying-drugs

Both normal and pacifist receipts lead through the completion reward to the exact finished write. Dakota's holocall and fallback phone messages are explicit nodes on those receipt paths, establishing her knowledge as the commissioning fixer. The successful shortcut for a previously disabled antenna also reaches the same cleanup; it still establishes the contract's disabled antenna outcome, not how V disabled it. No power-cut versus destruction versus overload inference is enabled. Root phase paths were inspected alongside the two success debrief variants. This is a save-established completed contract, not proof of a particular human input.

Native locators:

- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_03/phases/sts_bls_ina_03_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/6/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_03/phases/sts_bls_ina_03_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/15/Data` (`questRewardManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_03/phases/sts_bls_ina_03_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/20/Data` (`questRewardManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_03/phases/sts_bls_ina_03_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/23/Data` (`questSceneNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_03/phases/sts_bls_ina_03_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/31/Data` (`questJournalNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_03/phases/sts_bls_ina_03_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/32/Data` (`questJournalNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_inland_avenue.questphase.json` → `/Data/RootChunk/inplacePhases/22`.
- `raw/base/base/open_world/street_stories/badlands/sts_badlands.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/street_stories/street_stories.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/phases/open_world_content.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/additional_game_elements.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.questphase.json` → `/Data/RootChunk/graph/Data/nodes/7/Data/phaseGraph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.quest.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).

### dakota-minefield

The success and failed outputs of objective phase11 are distinct. Only normal Out1 goes through the contract completion reward and then the cleanup In1 writer. The sts_failed cleanup input reaches the achievement bookkeeping without that write. Thus the exact positive receipt is success-specific, despite common cleanup. The rule covers recovered vehicle delivery only; examining the corpse is a different optional observation. Dakota is the contract principal, not a physical witness to V crossing the mines.

Native locators:

- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_07/phases/sts_bls_ina_07_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/5/Data` (`questRewardManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_07/phases/sts_bls_ina_07_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_07/phases/sts_bls_ina_07_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_07/phases/sts_bls_ina_07_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/2/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_07/phases/sts_bls_ina_07_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/10/Data` (`questInputNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_inland_avenue.questphase.json` → `/Data/RootChunk/inplacePhases/5`.
- `raw/base/base/open_world/street_stories/badlands/sts_badlands.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/street_stories/street_stories.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/phases/open_world_content.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/additional_game_elements.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.questphase.json` → `/Data/RootChunk/graph/Data/nodes/7/Data/phaseGraph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.quest.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).

### dakota-trevor

The native finished receipt is additive, so the runtime requires >=1 rather than assuming one execution. The successful holocall and its Dakota phone-message fallback both route through the completion reward and receipt. The failure token branch joins achievement cleanup later and does not write finished. This qualifies returned remains, not merely finding or identifying Trevor's corpse. Dakota has the result through the job debrief; no other companion is treated as a witness.

Native locators:

- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_08/phases/sts_bls_ina_08_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/15/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_08/phases/sts_bls_ina_08_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/14/Data` (`questSceneNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_08/phases/sts_bls_ina_08_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/28/Data` (`questJournalNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_08/phases/sts_bls_ina_08_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/8/Data` (`questRewardManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_08/phases/sts_bls_ina_08_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/20/Data` (`questGameManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_inland_avenue.questphase.json` → `/Data/RootChunk/inplacePhases/1`.
- `raw/base/base/open_world/street_stories/badlands/sts_badlands.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/street_stories/street_stories.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/phases/open_world_content.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/additional_game_elements.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.questphase.json` → `/Data/RootChunk/graph/Data/nodes/7/Data/phaseGraph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.quest.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).

### dakota-sparring

The receipt follows both the chip-delivery objective and complete quest Succeeded inputs. A different ina_11_robot_delivered fact refers to internal transport/gameplay and was rejected as proof of the software delivery. The mapping is delivery of the requested software for Dakota's contract; it does not claim whether V bought it, stole it, killed anyone, or paid a particular amount.

Native locators:

- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_11/phases/sts_bls_ina_11_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/30/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_11/phases/sts_bls_ina_11_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/9/Data` (`questJournalNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_11/phases/sts_bls_ina_11_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/10/Data` (`questJournalNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_11/phases/sts_bls_ina_11_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/41/Data` (`questPauseConditionNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_inland_avenue.questphase.json` → `/Data/RootChunk/inplacePhases/2`.
- `raw/base/base/open_world/street_stories/badlands/sts_badlands.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/street_stories/street_stories.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/phases/open_world_content.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/additional_game_elements.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.questphase.json` → `/Data/RootChunk/graph/Data/nodes/7/Data/phaseGraph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.quest.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).

### dakota-iris-with-van

The vehicle is identified by the hostage community car reference and force-brake/delivery sequence, followed by the parking objective success. The Iris handover branches write iris_hired and finished after their success/reward paths. Requiring all three positive receipts limits this outcome to Iris saved with the van delivered. The without-van outcome remains unmapped because absent car_delivered is not independent proof that the player declined it. A later follow-up message is a separate event and is not inferred from the rescue.

Native locators:

- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/31/Data/phaseGraph/Data/nodes/12/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/31/Data/phaseGraph/Data/nodes/11/Data` (`questVehicleNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/31/Data/phaseGraph/Data/nodes/19/Data` (`questJournalNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/73/Data` (`questConditionNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/72/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/88/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/70/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/87/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/90/Data` (`questRewardManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/75/Data` (`questJournalNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/7/Data` (`questJournalNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/66/Data` (`questJournalNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_06/phases/sts_bls_ina_06_ow.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/112/Data` (`questPauseConditionNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_inland_avenue.questphase.json` → `/Data/RootChunk/inplacePhases/23`.
- `raw/base/base/open_world/street_stories/badlands/sts_badlands.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/street_stories/street_stories.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/phases/open_world_content.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/additional_game_elements.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.questphase.json` → `/Data/RootChunk/graph/Data/nodes/7/Data/phaseGraph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.quest.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).

### dakota-ben-delivery

The completed quest branches converge on the additive receipt. A separate positive arrival receipt is required to avoid treating a different completion/follow-up path as delivery. The handover control handles Ben's vehicle assignment explicitly (302); the left-car synchronization is about V (240.childIsPlayer=1), with an alternate on-foot path (238.False ->247), and then invokes the meeting-nomad scene. The arrival receipt must not be paraphrased as proof Ben or V necessarily used a car. Dakota knows the contract outcome, but this rule does not expose Jason's betrayal details or infer whether Jason died, was incapacitated, or was avoided. None of those distinctions follow from the two delivery receipts.

Native locators:

- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_09/phases/sts_bls_ina_09_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data/phaseGraph/Data/nodes/34/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_09/phases/sts_bls_ina_09_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data/phaseGraph/Data/nodes/54/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_09/phases/sts_bls_ina_09_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data/phaseGraph/Data/nodes/7/Data` (`questJournalNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_09/phases/sts_bls_ina_09_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data/phaseGraph/Data/nodes/42/Data` (`questJournalNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_09/phases/sts_bls_ina_09_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data/phaseGraph/Data/nodes/1/Data/phaseGraph/Data/nodes/11/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_09/phases/sts_bls_ina_09_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data/phaseGraph/Data/nodes/1/Data/phaseGraph/Data/nodes/59/Data` (`questPauseConditionNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_09/phases/sts_bls_ina_09_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data/phaseGraph/Data/nodes/1/Data/phaseGraph/Data/nodes/10/Data` (`questSceneNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_09/phases/sts_bls_ina_09_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data/phaseGraph/Data/nodes/1/Data/phaseGraph/Data/nodes/62/Data` (`questVehicleNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_09/phases/sts_bls_ina_09_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data/phaseGraph/Data/nodes/90/Data` (`questPauseConditionNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_09/phases/sts_bls_ina_09_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data/phaseGraph/Data/nodes/95/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_09/phases/sts_bls_ina_09_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data/phaseGraph/Data/nodes/97/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_09/phases/sts_bls_ina_09_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data/phaseGraph/Data/nodes/88/Data` (`questConditionNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_inland_avenue.questphase.json` → `/Data/RootChunk/inplacePhases/26`.
- `raw/base/base/open_world/street_stories/badlands/sts_badlands.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/street_stories/street_stories.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/phases/open_world_content.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/additional_game_elements.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.questphase.json` → `/Data/RootChunk/graph/Data/nodes/7/Data/phaseGraph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.quest.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).

### dakota-bruce-delivery

The rule combines the exact completed-quest receipt with the Archibald handover conversation receipt. The actual scene gate requires the take-Bruce-to-meeting-point objective to be Active (7), V inside the Archibald trigger and Bruce within25 metres of V (12). It does not use generic ina_05_finished bookkeeping alone. Bruce's returned-alive result is distinct from the optional no-casualties condition and from later membership at camp. The reviewed predicates establish the handover and completion only; no assumption is made from ina_05_optional_failed=0. Dakota is the commissioning/debrief party, not an asserted on-site witness.

Native locators:

- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_05/phases/sts_bls_ina_05_openworld_phase.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data/phaseGraph/Data/nodes/50/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_05/phases/sts_bls_ina_05_openworld_phase.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data/phaseGraph/Data/nodes/13/Data` (`questJournalNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_05/phases/sts_bls_ina_05_openworld_phase.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data/phaseGraph/Data/nodes/75/Data` (`questJournalNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_05/phases/sts_bls_ina_05_openworld_phase.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/12/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_05/phases/sts_bls_ina_05_openworld_phase.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/3/Data` (`questSceneNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_05/phases/sts_bls_ina_05_openworld_phase.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/2/Data` (`questPauseConditionNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_05/phases/sts_bls_ina_05_openworld_phase.questphase.json` → `/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/4/Data` (`questPauseConditionNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_inland_avenue.questphase.json` → `/Data/RootChunk/inplacePhases/8`.
- `raw/base/base/open_world/street_stories/badlands/sts_badlands.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/street_stories/street_stories.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/phases/open_world_content.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/additional_game_elements.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.questphase.json` → `/Data/RootChunk/graph/Data/nodes/7/Data/phaseGraph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.quest.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).

### dakota-radar-delivery

Condition295 checks the actual antenna-car entity inside the workshop and safe player state. Its output reaches deliver_car through297 on the Succeeded socket. The subsequent exit/unmount and completion paths mark the full quest Succeeded. The rule requires BOTH revealed journal entries succeeded. The same ina_04_finished writer receives a failed quest path (13 ->195), so that tempting fact is deliberately not allowlisted. Exact cooked journal entries establish selector class/path; the adapter must observe their revealed state in the current save. This avoids treating a failed or merely cleaned-up gig as successful prototype delivery.

Native locators:

- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_04/phases/sts_bls_ina_04_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/60/Data` (`questPauseConditionNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_04/phases/sts_bls_ina_04_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/62/Data` (`questCutControlNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_04/phases/sts_bls_ina_04_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/12/Data` (`questJournalNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_04/phases/sts_bls_ina_04_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/14/Data` (`questJournalNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_04/phases/sts_bls_ina_04_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/68/Data` (`questPauseConditionNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_04/phases/sts_bls_ina_04_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/70/Data` (`questJournalNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_04/phases/sts_bls_ina_04_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/27/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_ina_04/phases/sts_bls_ina_04_openworld.questphase.json` → `/Data/RootChunk/graph/Data/nodes/3/Data/phaseGraph/Data/nodes/2/Data` (`questJournalNodeDefinition`).
- `raw/ep1/base/journal/cooked_journal.journal.json` → `/Data/RootChunk/entry/Data/entries/0/Data/entries/6/Data/entries/0/Data/entries/0/Data/entries/6/Data/entries/0/Data/entries/2/Data` (`gameJournalQuestObjective`).
- `raw/ep1/base/journal/cooked_journal.journal.json` → `/Data/RootChunk/entry/Data/entries/0/Data/entries/6/Data/entries/0/Data/entries/0/Data/entries/6/Data` (`gameJournalQuest`).
- `raw/base/base/open_world/street_stories/badlands/inland_avenue/sts_bls_inland_avenue.questphase.json` → `/Data/RootChunk/inplacePhases/21`.
- `raw/base/base/open_world/street_stories/badlands/sts_badlands.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/street_stories/street_stories.questphase.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/open_world/phases/open_world_content.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/additional_game_elements.questphase.json` → `/Data/RootChunk/graph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.questphase.json` → `/Data/RootChunk/graph/Data/nodes/7/Data/phaseGraph/Data/nodes/2/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.quest.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).

### convoy-secured

Saul confronts Panam about the returned Basilisk and she asks to assemble it. Those are actual lines in section350, not an inferred role from the actor table. The production phase enters the Saul reception scene and writes the exact convoy receipt on scene_over_out, after return. Panam and Saul can remember the convoy being secured. Other veterans' names in the scene actor array are insufficient on their own to grant them every debrief detail, so this executable rule is limited to the two dialogue participants. It does not establish later co-leadership, a cancelled corporate deal, intimacy or V's motive in helping.

Native locators:

- `raw/base/base/quest/side_quests/sq027/phases/sq027_04_return.questphase.json` → `/Data/RootChunk/graph/Data/nodes/12/Data/phaseGraph/Data/nodes/5/Data` (`questFactsDBManagerNodeDefinition`).
- `raw/base/base/quest/side_quests/sq027/phases/sq027_04_return.questphase.json` → `/Data/RootChunk/graph/Data/nodes/12/Data/phaseGraph/Data/nodes/4/Data` (`questSceneNodeDefinition`).
- `raw/base/base/quest/side_quests/sq027/phases/sq027_04_return.questphase.json` → `/Data/RootChunk/graph/Data/nodes/12/Data/phaseGraph/Data/nodes/6/Data` (`questFactsDBManagerNodeDefinition`).
- `scene-evidence/aldecaldos-outcomes/raw/base/base/quest/side_quests/sq027/scenes/sq027_05a_transport_delivered.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/25/Data` (`scnSectionNode`).
- `scene-evidence/aldecaldos-outcomes/raw/base/base/quest/side_quests/sq027/scenes/sq027_05a_transport_delivered.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/79/Data` (`scnEndNode`).
- `scene-evidence/aldecaldos-outcomes/raw/base/base/quest/side_quests/sq027/scenes/sq027_05a_transport_delivered.scene.json` → `/Data/RootChunk/screenplayStore/lines/25` (`scnscreenplayDialogLine`).
- `scene-evidence/aldecaldos-outcomes/raw/base/base/quest/side_quests/sq027/scenes/sq027_05a_transport_delivered.scene.json` → `/Data/RootChunk/screenplayStore/lines/35` (`scnscreenplayDialogLine`).
- `scene-evidence/aldecaldos-outcomes/raw/base/base/quest/side_quests/sq027/scenes/sq027_05a_transport_delivered.scene.json` → `/Data/RootChunk/screenplayStore/lines/37` (`scnscreenplayDialogLine`).
- `raw/base/base/quest/side_quests/sq027/sq027_queen_of_the_highway.questphase.json` → `/Data/RootChunk/graph/Data/nodes/8/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/side_quests/sidequests.questphase.json` → `/Data/RootChunk/graph/Data/nodes/10/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.questphase.json` → `/Data/RootChunk/graph/Data/nodes/7/Data/phaseGraph/Data/nodes/4/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.quest.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).

### panam-co-leader

This uses the completed scene objective, not sq027_done. The co-leadership announcement is a Saul line at9.176 seconds and the native objective succeeds after it, at52.618 seconds, via socket2 ordinal4. The destination explicitly maps input ordinal3 to Succeeded. Panam speaks and responds in the same section. Only the revealed objective success qualifies; actor presence, quest activation and camp relocation alone do not. The production camp-attack phase has the normal camp_saved_in entry; a separate CineDebug_BarScene exists but is not the evidence path. The scene does not prove the separate Biotechnica policy outcome, which stays unmapped.

Native locators:

- `scene-evidence/aldecaldos-outcomes/raw/base/base/quest/side_quests/sq027/scenes/sq027_08_camp_saved.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/53/Data` (`scnQuestNode`).
- `scene-evidence/aldecaldos-outcomes/raw/base/base/quest/side_quests/sq027/scenes/sq027_08_camp_saved.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/8/Data` (`scnSectionNode`).
- `scene-evidence/aldecaldos-outcomes/raw/base/base/quest/side_quests/sq027/scenes/sq027_08_camp_saved.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/8/Data/events/28/Data` (`scnDialogLineEvent`).
- `scene-evidence/aldecaldos-outcomes/raw/base/base/quest/side_quests/sq027/scenes/sq027_08_camp_saved.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/8/Data/events/99/Data` (`scneventsSocket`).
- `scene-evidence/aldecaldos-outcomes/raw/base/base/quest/side_quests/sq027/scenes/sq027_08_camp_saved.scene.json` → `/Data/RootChunk/sceneGraph/Data/graph/53/Data/isockMappings/3` (`CName`).
- `scene-evidence/aldecaldos-outcomes/raw/base/base/quest/side_quests/sq027/scenes/sq027_08_camp_saved.scene.json` → `/Data/RootChunk/screenplayStore/lines/7` (`scnscreenplayDialogLine`).
- `raw/base/base/quest/side_quests/sq027/phases/sq027_05_camp_attack.questphase.json` → `/Data/RootChunk/graph/Data/nodes/5/Data/phaseGraph/Data/nodes/2/Data` (`questSceneNodeDefinition`).
- `raw/ep1/base/journal/cooked_journal.journal.json` → `/Data/RootChunk/entry/Data/entries/0/Data/entries/5/Data/entries/9/Data/entries/1/Data/entries/6/Data` (`gameJournalQuestObjective`).
- `raw/base/base/quest/side_quests/sq027/sq027_queen_of_the_highway.questphase.json` → `/Data/RootChunk/graph/Data/nodes/10/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/side_quests/sidequests.questphase.json` → `/Data/RootChunk/graph/Data/nodes/10/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.questphase.json` → `/Data/RootChunk/graph/Data/nodes/7/Data/phaseGraph/Data/nodes/4/Data` (`questPhaseNodeDefinition`).
- `raw/base/base/quest/cyberpunk2077.quest.json` → `/Data/RootChunk/graph/Data/nodes/1/Data` (`questPhaseNodeDefinition`).

## Rejected shortcuts and unresolved distinctions

- `sq027_done` is set by Panam success, alternate ending and failure cleanup. It cannot establish friendship, co-leadership, romance or a cancelled corporate contract.
- `sq027_camp_moved` also has setup/ending writers. Camp relocation is not evidence of V taking the assisted branch.
- `sq004_saul_rescued` occurs when Saul is freed; the rule requires the full successful Riders journal before describing the completed escape.
- `q114_initiation_started` and scene `initiation_begun` occur before the welcome. Only the explicit completed objective after the welcome is used.
- `ina_04_finished` receives both full-quest failure and success paths. Radar Love uses the positive delivery objective plus full-quest succeeded journal instead.
- `ina_02_big_pete_dead` is written by a character condition with `killed`, `defeated` and `unconscious` enabled. It does not prove a lethal outcome. The bribe/spare variants require their original scene branches, not only a repair script.
- `mq001_scorpion_placed` is the decorative figure placement, not Scorpion's funeral. Generic `mq001_done` is not used to infer attendance.
- `sq027_panam_doesnt_know_about_johnny` is not interpreted as an explicit completed negative disclosure. The private Relic rule does not automatically reveal Johnny's identity.
- Missing van delivery, casualty, romance, call or message state never selects the opposite branch. All such alternatives remain unmapped until their own evidence is authored.

## Unmapped outcomes and next evidence needed

These records are retained with status `unmapped`; the runtime skips them. They are listed individually so a future review cannot mistake sourced narrative coverage for native executable coverage.

| Quest | Exact outcome | Missing evidence / reason |
| --- | --- | --- |
| `ghost-town` | `aldecaldos.ghost.camp-help/gear-only` | The truck/gear retrieval is researched in the narrative map, but the reached q103 request branch and recipient knowledge have not been native-reviewed. |
| `ghost-town` | `aldecaldos.ghost.truck/recovered-and-delivered` | No reviewed delivery receipt is authored for the recovered truck and merchandise; a quest title or generic q103 completion would not distinguish this stage. |
| `ghost-town` | `aldecaldos.ghost.nash/helped` | The help-versus-decline choice and resulting Nash fate need the actual reached q103 scene branch. A named death flag alone cannot distinguish this decision. |
| `ghost-town` | `aldecaldos.ghost.nash/declined` | The help-versus-decline choice and resulting Nash fate need the actual reached q103 scene branch. A named death flag alone cannot distinguish this decision. |
| `ghost-town` | `aldecaldos.ghost.motel/shared-room` | Shared room and flirting are separate private choices. No exact affirmative choice receipt has been reviewed for either; silence cannot imply rejection. |
| `ghost-town` | `aldecaldos.ghost.motel/flirted` | Shared room and flirting are separate private choices. No exact affirmative choice receipt has been reviewed for either; silence cannot imply rejection. |
| `lightning-breaks` | `aldecaldos.lightning.av/downed` | The AV takedown stage is sourced in the narrative map, but its native completed objective and who witnessed it are not mapped here. |
| `life-during-wartime` | `aldecaldos.wartime.mitch-rescue/v-helped` | A generic rescued/survived state cannot distinguish V assisting Mitch from Panam doing it herself. Exact q104 branch receipt is pending. |
| `life-during-wartime` | `aldecaldos.wartime.mitch-rescue/panam-alone` | A generic rescued/survived state cannot distinguish V assisting Mitch from Panam doing it herself. Exact q104 branch receipt is pending. |
| `life-during-wartime` | `aldecaldos.wartime.loss/confirmed` | Scorpion and other Aldecaldo losses require native lethal consequence plus recipient knowledge; this is not inferred from q104 progress or the Scorpion figurine flag. |
| `life-during-wartime` | `aldecaldos.wartime.pilot-information/pilot-told` | The pilot conversation and tracking alternative are different knowledge acquisition routes; their positive branch receipts are not reviewed. |
| `life-during-wartime` | `aldecaldos.wartime.pilot-information/tracks-followed` | The pilot conversation and tracking alternative are different knowledge acquisition routes; their positive branch receipts are not reviewed. |
| `life-during-wartime` | `aldecaldos.wartime.hellman-captured/captured` | No reviewed Hellman-capture receipt and Panam/Mitch knowledge boundary is authored in this lane. |
| `riders-on-the-storm` | `aldecaldos.riders.briefing/briefed` | Saul rescue completion does not establish which optional briefing V listened to. The camp briefing scene has not been mapped. |
| `riders-on-the-storm` | `aldecaldos.riders.rescue/failed` | The success has a positive rescued flag plus completed revealed journal guard. A failed rescue needs its own explicit failed branch/state; missing success is unknown. |
| `riders-on-the-storm` | `aldecaldos.riders.extraction-method/unnoticed` | Neither rescued=1 nor full quest success distinguishes unnoticed extraction from pursuit. No positive route-specific receipt is reviewed. |
| `riders-on-the-storm` | `aldecaldos.riders.extraction-method/pursued` | Neither rescued=1 nor full quest success distinguishes unnoticed extraction from pursuit. No positive route-specific receipt is reviewed. |
| `riders-on-the-storm` | `aldecaldos.riders.farmhouse/supported-panam` | Supporting Panam, supporting Saul, and no established position require exact dialogue selection evidence; successful rescue does not reveal the choice. |
| `riders-on-the-storm` | `aldecaldos.riders.farmhouse/supported-saul` | Supporting Panam, supporting Saul, and no established position require exact dialogue selection evidence; successful rescue does not reveal the choice. |
| `riders-on-the-storm` | `aldecaldos.riders.farmhouse/not-established` | Supporting Panam, supporting Saul, and no established position require exact dialogue selection evidence; successful rescue does not reveal the choice. |
| `riders-on-the-storm` | `aldecaldos.riders.private-affection/affection-expressed` | The farmhouse affection choice is private and cannot be inferred from eventual Basilisk romance. Its individual receipt remains unreviewed. |
| `ill-fly-away` | `aldecaldos.fly.farewell/attended` | mq001_scorpion_placed refers to placing the decorative figure, not the funeral. Generic mq001_done also has alternate/debug writers. The farewell versus missed-event native route remains unresolved. |
| `ill-fly-away` | `aldecaldos.fly.farewell/missed` | mq001_scorpion_placed refers to placing the decorative figure, not the funeral. Generic mq001_done also has alternate/debug writers. The farewell versus missed-event native route remains unresolved. |
| `with-a-little-help-from-my-friends` | `aldecaldos.friends.loyalty/assisted` | The Saul-report branch is verified. Assisted and initially declined need their own entered conversation branches; later successful convoy delivery is not used to reconstruct V's original answer. |
| `with-a-little-help-from-my-friends` | `aldecaldos.friends.loyalty/declined-initially` | The Saul-report branch is verified. Assisted and initially declined need their own entered conversation branches; later successful convoy delivery is not used to reconstruct V's original answer. |
| `with-a-little-help-from-my-friends` | `aldecaldos.friends.railway/activated` | Control-tower and locomotive objectives were not reviewed deeply enough to infer which activation V performed. |
| `with-a-little-help-from-my-friends` | `aldecaldos.friends.tower-talk/personal-support` | Personal motives and job-focused replies are private selection branches; convoy success supplies neither exact answer. |
| `with-a-little-help-from-my-friends` | `aldecaldos.friends.tower-talk/job-focused` | Personal motives and job-focused replies are private selection branches; convoy success supplies neither exact answer. |
| `with-a-little-help-from-my-friends` | `aldecaldos.friends.campfire/heard` | A convoy completion is not evidence V heard every optional campfire conversation. The exact listening/branch receipt is unreviewed. |
| `queen-of-the-highway` | `aldecaldos.queen.basilisk-test/completed` | The intimacy and leadership mappings do not separately expose completed movement/weapons training. Exact test completion receipt remains unreviewed. |
| `queen-of-the-highway` | `aldecaldos.queen.romance/platonic` | Only affirmative intimacy followed by the lover receipt is verified. Missing/zero lover data cannot authorize a platonic/refused narrative. |
| `queen-of-the-highway` | `aldecaldos.queen.defense/repelled` | The reached camp-saved dialogue supports its leadership outcome. A standalone combat outcome covering all defenders and possible failure/cleanup routes has not been authored. |
| `queen-of-the-highway` | `aldecaldos.queen.nash/encountered` | Nash's later appearance depends on the earlier optional encounter and survival. No verified native compound predicate is authored. |
| `queen-of-the-highway` | `aldecaldos.queen.relic-disclosure/collapse-witnessed` | The explanation to Panam is verified. A separate witnessed-collapse-only state is not inferred from absent explanation or generic quest completion. |
| `queen-of-the-highway` | `aldecaldos.queen.policy/contract-ended` | The co-leader scene does not itself establish termination of the Biotechnica agreement. Saul's relevant correspondence and state must be mapped separately. |
| `gun-music` | `aldecaldos.gun.deal/intimidated` | Scavenger deal resolution needs distinct intimidation, firefight, and abandonment receipts, plus Carol/Cassidy knowledge. None has a verified native predicate in this pack. |
| `gun-music` | `aldecaldos.gun.deal/firefight` | Scavenger deal resolution needs distinct intimidation, firefight, and abandonment receipts, plus Carol/Cassidy knowledge. None has a verified native predicate in this pack. |
| `gun-music` | `aldecaldos.gun.deal/abandoned` | Scavenger deal resolution needs distinct intimidation, firefight, and abandonment receipts, plus Carol/Cassidy knowledge. None has a verified native predicate in this pack. |
| `gun-music` | `aldecaldos.gun.panam-message/received` | A later Panam message requires actual delivery/revealed-message evidence; resolving the deal does not prove its receipt. |
| `fortunate-son` | `aldecaldos.fortunate.request/accepted` | The request to help Jake requires an entered request/conversation stage. Static Bob/Jake familiarity is not used as injury or acceptance evidence. |
| `fortunate-son` | `aldecaldos.fortunate.malware/discovered` | Finding the infected implant is a knowledge event separate from collecting or delivering the item; no positive discovery branch has been native-reviewed. |
| `fortunate-son` | `aldecaldos.fortunate.malware/not-discovered` | Finding the infected implant is a knowledge event separate from collecting or delivering the item; no positive discovery branch has been native-reviewed. |
| `fortunate-son` | `aldecaldos.fortunate.implant/delivered-informed` | Informed versus uninformed delivery requires affirmative disclosure evidence. An absent warning flag is not known ignorance. |
| `fortunate-son` | `aldecaldos.fortunate.implant/delivered-uninformed` | Informed versus uninformed delivery requires affirmative disclosure evidence. An absent warning flag is not known ignorance. |
| `fortunate-son` | `aldecaldos.fortunate.result/recovered` | Jake's recovered/dead outcomes need explicit consequence branches and Bob's knowledge. A passed timer or quest completion alone is not enough. |
| `fortunate-son` | `aldecaldos.fortunate.result/died` | Jake's recovered/dead outcomes need explicit consequence branches and Bob's knowledge. A passed timer or quest completion alone is not enough. |
| `nocturne-op55n1` | `aldecaldos.nocturne.partner-call/panam` | Partner-call routing requires the actual selected recipient and branch-local call completion; active romance is not proof that V called Panam. |
| `nocturne-op55n1` | `aldecaldos.nocturne.partner-call/other-or-no-call` | Partner-call routing requires the actual selected recipient and branch-local call completion; active romance is not proof that V called Panam. |
| `nocturne-op55n1` | `aldecaldos.nocturne.help/called-panam` | Choosing the Aldecaldo plan needs the rooftop choice/call branch. This pack instead maps later completed initiation and does not backfill the original selection. |
| `nocturne-op55n1` | `aldecaldos.nocturne.help/other-route` | Choosing the Aldecaldo plan needs the rooftop choice/call branch. This pack instead maps later completed initiation and does not backfill the original selection. |
| `we-gotta-live-together` | `aldecaldos.together.assault-plan/committed` | The plan discussion/commitment is not reconstructed from a later ending flag. Its entered choice or completed objective remains unmapped. |
| `we-gotta-live-together` | `aldecaldos.together.alt-link/completed` | Dakota and Carol's net link to Alt requires the specific completed netrunning conversation and participant scope; q114 started is insufficient. |
| `we-gotta-live-together` | `aldecaldos.together.shooting/won` | Cassidy shooting competition win/loss/nonparticipation needs positive outcome receipts. Missing score or prize data must not mean the challenge was skipped. |
| `we-gotta-live-together` | `aldecaldos.together.shooting/lost` | Cassidy shooting competition win/loss/nonparticipation needs positive outcome receipts. Missing score or prize data must not mean the challenge was skipped. |
| `we-gotta-live-together` | `aldecaldos.together.shooting/not-played` | Cassidy shooting competition win/loss/nonparticipation needs positive outcome receipts. Missing score or prize data must not mean the challenge was skipped. |
| `we-gotta-live-together` | `aldecaldos.together.returning-contacts/jake-present` | Earlier gig success does not prove a named rescued person is present in this ending camp; exact returned community branch and recipient knowledge are unreviewed. |
| `we-gotta-live-together` | `aldecaldos.together.returning-contacts/ben-present` | Earlier gig success does not prove a named rescued person is present in this ending camp; exact returned community branch and recipient knowledge are unreviewed. |
| `we-gotta-live-together` | `aldecaldos.together.returning-contacts/bruce-present` | Earlier gig success does not prove a named rescued person is present in this ending camp; exact returned community branch and recipient knowledge are unreviewed. |
| `we-gotta-live-together` | `aldecaldos.together.returning-contacts/anna-present` | Earlier gig success does not prove a named rescued person is present in this ending camp; exact returned community branch and recipient knowledge are unreviewed. |
| `forward-to-death` | `aldecaldos.forward.casualties/bob-and-teddy-dead` | Bob/Teddy casualties require lethal branch and audience evidence. Fact names, de-spawns and combat defeat cannot establish death. |
| `forward-to-death` | `aldecaldos.forward.breach/opened` | No exact tunnel breach completed objective and actor knowledge predicate is authored; generic q114 completion is intentionally not substituted. |
| `belly-of-the-beast` | `aldecaldos.belly.mitch-return/returned-outside` | Mitch returning to the outside fight needs the reached decision/consequence, not merely absence from the boss room. |
| `belly-of-the-beast` | `aldecaldos.belly.alt-casualties/witnessed` | Alt's security intervention and its victims require a specific reached scene and witness restriction. Smasher/Saul state says nothing about them. |
| `belly-of-the-beast` | `aldecaldos.belly.mikoshi-reached/connected` | Connecting to Mikoshi is downstream of the boss fight and needs its own verified objective/scene, not Saul's death alone. |
| `changes` | `aldecaldos.changes.body/v-returned` | Who returns to V's body requires the final Mikoshi choice. Earlier Aldecaldo assistance, romance and Saul's death cannot choose between V and Johnny. |
| `changes` | `aldecaldos.changes.body/johnny-returned` | Who returns to V's body requires the final Mikoshi choice. Earlier Aldecaldo assistance, romance and Saul's death cannot choose between V and Johnny. |
| `all-along-the-watchtower` | `aldecaldos.watchtower.departure/planned` | Planned departure and actual border crossing are distinct ending stages; neither is inferred from selecting Aldecaldo help. |
| `all-along-the-watchtower` | `aldecaldos.watchtower.departure/crossed` | Planned departure and actual border crossing are distinct ending stages; neither is inferred from selecting Aldecaldo help. |
| `all-along-the-watchtower` | `aldecaldos.watchtower.partner/panam-together` | Panam/Judy accompanying V, River/Kerry staying and no partner scene require actual relationship/ending combinations. No absent flag selects a default partner branch. |
| `all-along-the-watchtower` | `aldecaldos.watchtower.partner/judy-leaves` | Panam/Judy accompanying V, River/Kerry staying and no partner scene require actual relationship/ending combinations. No absent flag selects a default partner branch. |
| `all-along-the-watchtower` | `aldecaldos.watchtower.partner/river-stays` | Panam/Judy accompanying V, River/Kerry staying and no partner scene require actual relationship/ending combinations. No absent flag selects a default partner branch. |
| `all-along-the-watchtower` | `aldecaldos.watchtower.partner/kerry-stays` | Panam/Judy accompanying V, River/Kerry staying and no partner scene require actual relationship/ending combinations. No absent flag selects a default partner branch. |
| `all-along-the-watchtower` | `aldecaldos.watchtower.partner/no-partner-scene` | Panam/Judy accompanying V, River/Kerry staying and no partner scene require actual relationship/ending combinations. No absent flag selects a default partner branch. |
| `all-along-the-watchtower` | `aldecaldos.watchtower.mitch-recovery/recovered-enough-to-travel` | Mitch's surviving/recovered travel state needs the epilogue scene; surviving an earlier quest is not sufficient. |
| `path-of-glory` | `aldecaldos.sun.parting/different-roads` | Panam's City/Sun parting is ending-specific and requires the entered romantic dialogue branch; no such rule is authored. |
| `where-is-my-mind` | `aldecaldos.devil.panam-call/called-platonic` | The station call and its platonic/romantic branches require the selected call and explicit conversation state; generic romance or Arasaka ending cannot imply contact. |
| `where-is-my-mind` | `aldecaldos.devil.panam-call/called-romantic` | The station call and its platonic/romantic branches require the selected call and explicit conversation state; generic romance or Arasaka ending cannot imply contact. |
| `new-dawn-fades` | `aldecaldos.temperance.panam-message/romantic-message-observed` | Panam's credits update/threat requires the exact observed message branch, including whose body returned; it is not known to other characters automatically. |
| `new-dawn-fades` | `aldecaldos.temperance.panam-message/platonic-update-observed` | Panam's credits update/threat requires the exact observed message branch, including whose body returned; it is not known to other characters automatically. |
| `things-done-changed` | `aldecaldos.tower.contact/unanswered` | Unanswered Panam contact and Mitch's later boundary message need distinct EP1 call/receipt state. Absence from the game world does not establish deliberate refusal. |
| `things-done-changed` | `aldecaldos.tower.contact/mitch-boundary-message` | Unanswered Panam contact and Mitch's later boundary message need distinct EP1 call/receipt state. Absence from the game world does not establish deliberate refusal. |
| `black-steel-in-the-hour-of-chaos` | `aldecaldos.blacksteel.carol-call/declined-offered-gift` | Carol's declined tracker help/gift offer is a private call branch in Phantom Liberty; a clan affiliation is not evidence the call happened. |
| `black-steel-in-the-hour-of-chaos` | `aldecaldos.blacksteel.gift/offered` | Offered and collected gift states are distinct. No item possession or shared inventory fact is used to invent a personal gift interaction. |
| `black-steel-in-the-hour-of-chaos` | `aldecaldos.blacksteel.gift/collected` | Offered and collected gift states are distinct. No item possession or shared inventory fact is used to invent a personal gift interaction. |
| `gig-dancing-on-a-minefield` | `aldecaldos.minefield.body/examined` | Returning the vehicle does not establish V examined the corpse or learned all associated details. |
| `gig-flying-drugs` | `aldecaldos.flying.method/power-cut` | The common disabled-antenna receipt merges multiple methods. No method-specific completed branch is reviewed. |
| `gig-flying-drugs` | `aldecaldos.flying.method/destroyed` | The common disabled-antenna receipt merges multiple methods. No method-specific completed branch is reviewed. |
| `gig-flying-drugs` | `aldecaldos.flying.method/remote-overload` | The common disabled-antenna receipt merges multiple methods. No method-specific completed branch is reviewed. |
| `gig-big-petes-got-big-problems` | `aldecaldos.pete.resolution/killed` | ina_02_big_pete_dead is written from a condition accepting killed, defeated OR unconscious. It cannot prove killed. Spare/pay/no-pay original scene branches have not been verified; a bugfix spared writer alone is insufficient. |
| `gig-big-petes-got-big-problems` | `aldecaldos.pete.resolution/spared-paid` | ina_02_big_pete_dead is written from a condition accepting killed, defeated OR unconscious. It cannot prove killed. Spare/pay/no-pay original scene branches have not been verified; a bugfix spared writer alone is insufficient. |
| `gig-big-petes-got-big-problems` | `aldecaldos.pete.resolution/spared-unpaid` | ina_02_big_pete_dead is written from a condition accepting killed, defeated OR unconscious. It cannot prove killed. Spare/pay/no-pay original scene branches have not been verified; a bugfix spared writer alone is insufficient. |
| `gig-big-petes-got-big-problems` | `aldecaldos.pete.tiny-mike/recognized` | Recognition of Pete's connection to Tiny Mike is dialogue knowledge, not established by neutralizing or sparing Pete. |
| `gig-no-fixers` | `aldecaldos.nofixers.rescue/delivered-without-van` | With-van rescue has three positive receipts. Without-van rescue requires explicit alternate delivery evidence; a missing/zero car receipt does not qualify. |
| `gig-no-fixers` | `aldecaldos.nofixers.followup/message-received` | The later Iris message requires a delivered/revealed message predicate, not just hired/finished flags. |
| `gig-trevors-last-ride` | `aldecaldos.trevor.remains/identified` | Delivery is verified. Mere identification has no separate reviewed knowledge receipt and must not be backfilled for arbitrary speakers. |
| `gig-mia` | `aldecaldos.mia.betrayal/confirmed` | Ben's rescue and arrival do not prove V or Dakota acquired Jason's betrayal details. Exact discovery/disclosure branch is unreviewed. |
| `gig-mia` | `aldecaldos.mia.jason/killed` | Jason killed, incapacitated and avoided require distinct native effects. Generic combat/cleanup and names ending in dead do not distinguish them. |
| `gig-mia` | `aldecaldos.mia.jason/incapacitated` | Jason killed, incapacitated and avoided require distinct native effects. Generic combat/cleanup and names ending in dead do not distinguish them. |
| `gig-mia` | `aldecaldos.mia.jason/avoided` | Jason killed, incapacitated and avoided require distinct native effects. Generic combat/cleanup and names ending in dead do not distinguish them. |
| `gig-sparring-partner` | `aldecaldos.sparring.software/recovered` | Delivery is verified; acquisition method/payment and mere recovery are not reconstructed from the final receipt. |
| `gig-goodbye-night-city` | `aldecaldos.goodbye.casualties/no-personnel-killed` | No-personnel-killed requires independent zero presence or a positive nonlethal receipt; missing ina_05_optional_failed is not proof. The killed branch also needs exact native semantics. |
| `gig-goodbye-night-city` | `aldecaldos.goodbye.casualties/personnel-killed` | No-personnel-killed requires independent zero presence or a positive nonlethal receipt; missing ina_05_optional_failed is not proof. The killed branch also needs exact native semantics. |
| `gig-goodbye-night-city` | `aldecaldos.goodbye.future-membership/seen-at-camp` | Successful Bruce handover is not evidence of a later ending-camp encounter. |
| `gig-radar-love` | `aldecaldos.radar.prototype/acquired` | Delivery uses two revealed succeeded journal selectors because ina_04_finished also fires on failure. Acquisition alone remains unmapped rather than reusing that unsafe flag. |
| `every-grain-of-sand` | `aldecaldos.reward.recognition/offered` | Dakota's full-gig reward offer and actual collection need separate reward-system/message/item receipts. Finishing a subset of gigs proves neither. |
| `every-grain-of-sand` | `aldecaldos.reward.recognition/collected` | Dakota's full-gig reward offer and actual collection need separate reward-system/message/item receipts. Finishing a subset of gigs proves neither. |

## Source bibliography

The corresponding dossier/quest-map entries retain inspected section names, access date and access limitations. Walkthroughs/transcripts establish narrative meaning; installed assets establish selectors and branch consequences. No external page supplies a guessed native flag.

- `al-panam`: [Panam Palmer](https://cyberpunk.fandom.com/wiki/Panam_Palmer) — Biography; Database Entry; Romancing Panam / Optional Prelude / Endings; Notes. Indexed page text consulted through web search. Direct page fetch was blocked by robots/access restrictions; no bypass attempted. Lore interpretation, not native runtime evidence.
- `al-ronin`: [Cyberpunk 2077 transcript backup](https://arasakas-ronin.netlify.app/) — Ghost Town through Queen of the Highway; We Gotta Live Together; Forward to Death; Belly of the Beast; All Along the Watchtower. Readable transcript consulted for speaker cadence, participation and differing camp attitudes. Incomplete fan transcription of game dialogue with transcription errors and selected branches; no native fact names and no exhaustive branch coverage. No dialogue is reproduced in the authored samples.
- `al-riders`: [Riders on the Storm](https://cyberpunk.fandom.com/wiki/Riders_on_the_Storm) — Objective; Quest Chain; Walkthrough / shelter. Indexed page text consulted through web search. Direct page fetch was blocked by robots/access restrictions; no bypass attempted. Lore interpretation, not native runtime evidence.
- `al-saul`: [Saul Bright](https://cyberpunk.fandom.com/wiki/Saul_Bright) — Biography; 2077; Database Entry; References to correspondence. Indexed page text consulted through web search. Direct page fetch was blocked by robots/access restrictions; no bypass attempted. Lore interpretation, not native runtime evidence.
- `al-friends`: [With a Little Help from My Friends](https://cyberpunk.fandom.com/wiki/With_a_Little_Help_from_My_Friends) — Walkthrough / decline, report to Saul, assist; Objectives. Indexed page text consulted through web search. Direct page fetch was blocked by robots/access restrictions; no bypass attempted. Lore interpretation, not native runtime evidence.
- `al-queen`: [Queen of the Highway](https://cyberpunk.fandom.com/wiki/Queen_of_the_Highway) — Walkthrough; Notes / Nash. Indexed page text consulted through web search. Direct page fetch was blocked by robots/access restrictions; no bypass attempted. Lore interpretation, not native runtime evidence.
- `al-together`: [We Gotta Live Together](https://cyberpunk.fandom.com/wiki/We_Gotta_Live_Together) — Walkthrough / optional nomads, target practice; Objectives. Indexed page text consulted through web search. Direct page fetch was blocked by robots/access restrictions; no bypass attempted. Lore interpretation, not native runtime evidence.
- `al-belly-guide`: [Belly of the Beast](https://gamefaqs.gamespot.com/pc/672376-cyberpunk-2077/faqs/79161/belly-of-the-beast) — Journey to Mikoshi; control room; Adam Smasher. Indexed guide inspected for Mitch's return being non-branching and Panam/Saul's on-site perspective. March 2021 guide; it conflates Changes into Belly of the Beast, corrected here using the separate Changes entry.
- `al-minefield`: [Gig: Dancing on a Minefield](https://cyberpunk.fandom.com/wiki/Gig%3A_Dancing_on_a_Minefield) — Walkthrough; Journal Entry; Objectives; Changelog. Indexed page text consulted through web search. Direct page fetch was blocked by robots/access restrictions; no bypass attempted. Lore interpretation, not native runtime evidence.
- `al-flying`: [Gig: Flying Drugs](https://cyberpunk.fandom.com/wiki/Gig%3A_Flying_Drugs) — Walkthrough; Journal Entry; Objectives. Indexed page text consulted through web search. Direct page fetch was blocked by robots/access restrictions; no bypass attempted. Lore interpretation, not native runtime evidence.
- `al-nofixers`: [Gig: No Fixers](https://cyberpunk.fandom.com/wiki/Gig%3A_No_Fixers) — Walkthrough / own van; Journal Entry; Objectives. Indexed page text consulted through web search. Direct page fetch was blocked by robots/access restrictions; no bypass attempted. Lore interpretation, not native runtime evidence.
- `al-iris`: [Iris Tanner](https://cyberpunk.fandom.com/wiki/Iris_Tanner) — Biography / rescue vehicle; Database Entry. Indexed page text consulted through web search. Direct page fetch was blocked by robots/access restrictions; no bypass attempted. Lore interpretation, not native runtime evidence.
- `al-trevor`: [Gig: Trevor's Last Ride](https://cyberpunk.fandom.com/wiki/Gig%3A_Trevor%27s_Last_Ride) — Objective; Journal Entry; Objectives. Indexed page text consulted through web search. Direct page fetch was blocked by robots/access restrictions; no bypass attempted. Lore interpretation, not native runtime evidence.
- `al-mia`: [Gig: MIA](https://cyberpunk.fandom.com/wiki/Gig%3A_MIA) — Walkthrough; Journal Entry; Objectives. Indexed page text consulted through web search. Direct page fetch was blocked by robots/access restrictions; no bypass attempted. Lore interpretation, not native runtime evidence.
- `al-sparring`: [Gig: Sparring Partner](https://cyberpunk.fandom.com/wiki/Gig%3A_Sparring_Partner) — Journal Entry; Objectives. Indexed page text consulted through web search. Direct page fetch was blocked by robots/access restrictions; no bypass attempted. Lore interpretation, not native runtime evidence.
- `al-goodbye`: [Gig: Goodbye, Night City](https://cyberpunk.fandom.com/wiki/Gig%3A_Goodbye%2C_Night_City) — Journal Entry; Objectives; Notes / nonlethal bonus. Indexed page text consulted through web search. Direct page fetch was blocked by robots/access restrictions; no bypass attempted. Lore interpretation, not native runtime evidence.
- `al-radar`: [Gig: Radar Love](https://cyberpunk.fandom.com/wiki/Gig%3A_Radar_Love) — Walkthrough; Journal Entry; Objectives. Indexed page text consulted. Infobox calls the motel Lone Star while walkthrough calls it Sunshine; objective model P9D/2.161 is consistent. Geographic naming is not used as runtime evidence.

## Verification and limits

Mechanical verification uses `verifyNativeEvidence` from the shared compiler and `validateKnowledgePack` from the resolver. At this revision: 16 executable rules, 18 evidence records, 18 allowlisted facts, 5 exact journal selectors, 40 cited native artifacts and 227 verified hash/type/pointer references; no validation errors.

The actual pack also passed 51 synthetic resolver checks: each executable rule qualifies from its positive fixture, is silent with unknown observations, and is silent with hidden journal/ambiguous-zero observations; additional checks cover contradictory Panam route facts, romance leakage into a group and a different game version. These fixtures validate the authored runtime boundary, not a real save, a live cinematic, localization rendering, cloud memory ingestion or all native collectors.

The current qualification is **source-verified, not live-qualified**. The installed game has not been mutated to force these outcomes. Four named clan profiles still have no native-qualified event in this pack, and 106 researched outcome branches remain explicitly unmapped.
