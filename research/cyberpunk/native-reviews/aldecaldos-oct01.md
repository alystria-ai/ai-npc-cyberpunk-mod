# Aldecaldo native expansion — October 1, 2026

## Checkpoint and qualification

This is a source review of installed Cyberpunk 2077 **2.31**. Six outcomes were added to `../native-rules/aldecaldos.json` (revision 2), replacing their six `unmapped` placeholders. The lane now has **22 source-verified rules and 100 unmapped outcomes**, with 122 narrative outcome links in total. None is live-qualified by this pass. No game action, save mutation, conversation, memory write, API request, install or commit was performed.

The restart checkpoint has now received independent semantic and executable review. The read-only per-pack verifier passed: **122 rules, 30 evidence records, 53 referenced native files**. The independent gate in `../../../bridge/native-aldecaldos-expansion.test.mjs` passed **23 tests, zero failures and zero skips** with `CYBERPUNK_NATIVE_SOURCE_CHECK=1`. That includes the current-save resolver scenarios, independently recomputed binary/JSON hashes for all **281 new reference pointers across 18 native files**, native socket semantics, all indexed choice writers, and shipped base-plus-EP1 reference closure. The six additions are ready for merged review; none was installed or live-qualified by this lane.

Only the lane JSON and this new review are intended tracked changes. Helpers, raw native resources, localized dialogue joins and audit receipts remain in the ignored task folders:

- `cache/game/scene-evidence/aldecaldos-oct01/`
- `cache/game/scene-evidence/aldecaldos-oct01-nash/`

There are no remaining owned extraction/test processes. The three tool sessions used for the exports and pack verifier completed.

## Added outcomes and knowledge boundaries

| Rule suffix | Exact narrative link | Positive current-save predicates | Who may receive it |
| --- | --- | --- | --- |
| `panam-nash-assistance` | `aldecaldos.ghost.nash/helped` | `q103_helped_panam >= 1` AND revealed `tunnels/defeat_boss` succeeded | Panam, private/phone; V and Panam only |
| `panam-motel-room-shared` | `aldecaldos.ghost.motel/shared-room` | `q103_slept_with_panam >= 1` AND revealed `roadhouse/follow_panam_room` succeeded | Panam, private/phone; V and Panam only |
| `panam-motel-flirt` | `aldecaldos.ghost.motel/flirted` | exact `q103_15_rooms_flirt = 1` AND revealed Ghost Town quest succeeded | Panam, private/phone; V and Panam only |
| `farmhouse-initially-backed-panam` | `aldecaldos.riders.farmhouse/supported-panam` | exact `sq004_sided_with_panam = 1` AND revealed Riders quest succeeded | Panam and Saul; a group is allowed only if every recipient is V, Panam or Saul |
| `farmhouse-backed-saul` | `aldecaldos.riders.farmhouse/supported-saul` | `sq004_saul_like >= 1` AND revealed Riders quest succeeded | Panam and Saul; same restricted group audience |
| `panam-farmhouse-flirt` | `aldecaldos.riders.private-affection/affection-expressed` | exact `sq004_panam_flirted_farm = 1` AND revealed Riders quest succeeded | Panam, private/phone; V and Panam only |

The two farmhouse stances share the topic and exclusive group `aldecaldos.farmhouse-stance`. If both positive receipts occur in a contradictory snapshot, the resolver must suppress both before audience filtering. Motel room sharing and the later flirt are independent compatible facets with distinct topics; either can exist without the other.

No new rule grants Mitch, Dakota, Carol, Bob or Cassidy an event merely because they belong to the clan. In particular, Rogue's response to the Nash route is not inferred from V's decision: her actual call/message receipt is still unreviewed. Dakota's previously verified commissioned-gig outcomes are unchanged.

## Source method and writer audit

The complete winning quest/phase/journal inventory and graph/fact/journal indexes were read without modification. Seven exact scenes were added in two bounded task-owned batches: five scenes totaling 2,065,101 decoded bytes, then two scenes totaling 242,385 bytes. Both manifests reported complete extraction with no missing paths. The first batch includes two Wartime/AV scenes examined as candidates but not used for a new executable rule.

Every new reference carries **both source binary SHA-256 and exported JSON SHA-256**, plus an exact RFC 6901 pointer. Typed targets and selected fact-write values are checked by the pack verifier. The verifier currently recomputes binary hashes and pointer/type/expected fields; the additional JSON digests are recorded for independent checking and are not claimed as checked by that existing CLI.

The writer sweep inspected `index/facts.jsonl` plus every currently exported `scene-evidence/*/index/facts.jsonl`. The independent gate repeated that sweep, deduplicating identical source/pointer exports and checking their assignment semantics. There are eight assignments for the six newly allowlisted facts:

| Fact | Production assignment | Other indexed assignment |
| --- | --- | --- |
| `q103_helped_panam` | `q103_11_tunnel_drive.scene`, node 101, additive +1 | `q103_chicken_test.questphase`, node 123, additive +1; absent from shipped-root reference closure |
| `q103_slept_with_panam` | `q103_15_roadhouse_bar.scene`, node 2775, additive +1 | isolated `sq004_riders_quest.quest`, node 14, exact 1; absent from shipped-root reference closure |
| `q103_15_rooms_flirt` | roadhouse scene node 843, exact 1 | None in reviewed indexes |
| `sq004_sided_with_panam` | farmhouse scene node 1990, exact 1 | None in reviewed indexes |
| `sq004_saul_like` | farmhouse scene node 823, additive +1 | None in reviewed indexes |
| `sq004_panam_flirted_farm` | farmhouse scene node 2657, exact 1 | None in reviewed indexes |

No indexed reset, opposite assignment or EP1 initializer writes these six selected receipts. This is explicitly bounded to the complete quest inventory and exported scene corpus: it is not a claim that every scene or script-generated writer in the game was exported. In particular, the shipped root's embedded chicken-test menu references external, unexported `base\quest\test\cp77_chicken_test.scene`; its possible debug/initializer writes are outside this audit. The positive rules apply to normal gameplay history established by the captured receipts, and do not certify a save against arbitrary debug modifications. No absent or zero fact selects an opposite outcome. Debug resources are recorded as alternate writers, not treated as production events. The independent journal guards require a revealed reached stage and prevent using the choice fact alone as full-event proof.

### Release entry and initialization

The existing `al-native.release-entry` retains the shipped `cyberpunk2077.gamedef` → `cyberpunk2077.quest` → main phase evidence. The independent review also read the shipped `ep1.gamedef`, which schedules both `base\quest\cyberpunk2077.quest` and `ep1\quest\ep1.quest`, and traversed their combined exported resource-reference closure. Neither of the two indexed test presets appears in that combined closure. This is reference ancestry, not proof that every referenced branch executes. New `al-native.oct01-ghost-production-entry` adds the production act-1 phase references and normal progression. Act-1's ordinary q101 phase (node 2) exits to XOR167 → hub158 → q103 node15 `In1`. Other debug entry sockets are not used to establish the new events.

The act-1 loaded-history predicates are explicitly inspected: node173 tests `q104_done >= 1`; node174 tests `q103_done >= 1`; node176 tests `ep1_standalone >= 1`; node177 waits for the revealed Songbird-hook objective to succeed. They resume or skip whole arcs rather than writing any of these six choice facts. These gates do not justify claiming a particular human selected a branch. Rules describe only history positively established by the current captured save.

Within q103, normal `In1` progresses through the Rogue/Panam phases. Ghost Town's output `go_tunnel` enters the tunnel phase; `go_roadhouse` enters the delivery phase directly; the successful tunnel phase enters the delivery phase through `from_tunnels`. The delivery scene node3 `End 0` invokes roadhouse-bar node4 at **`Start 0`**, corresponding to scene start node1. The separate `rh_bar` shortcut invokes **`chicken_bar`**, which is not used as the production-entry evidence.

For Riders, existing `al-native.sidequest-entry` and `al-native.saul-rescue` retain normal sidequest ancestry. The new farm entry record follows escape node18 `Out1` → cut92 → farm21 `In1`; farm time/restriction nodes261/260/267 lead through objectives258/259 to scene6 **`sq004_08_main_in`**. The separate `Farm_CT`, `MorningAfterIn`, cinematic-debug and scene-preview entrances are not used as proof of a player choice. Completion of the morning-after scene245 reaches quest246's **Succeeded** socket; that revealed quest state guards all three new farmhouse choice rules.

## Exact choice reviews

### Nash assistance

Native scene `q103_11_tunnel_drive.scene` provides a single normal start and distinct `go_tunnel`/`go_roadhouse` ends. The affirmative branch activates the tunnel ride objective at node68 and enters spoken agreement section58. Section58's socket2, after the agreement, invokes node101 to increment `q103_helped_panam`, then ends through `go_tunnel` node2. Panam is the other speaker in that exchange; this is participant knowledge.

The receipt is an agreement, not a completed fight, so the rule additionally requires the exact revealed objective `quests/main_quest/act_01/q103_warhead/tunnels/defeat_boss` to be succeeded. In `q103_04a_tunnels_combat.questphase`, conditions545 and546 join through **AND547** and write `TunnelDone = 1` at512. The parent phase condition401 waits for that receipt, then node364 disables the encounter turrets and node365 succeeds the objective. Both combat conditions explicitly accept **killed OR defeated OR unconscious** actors. Consequently the statement says V joined the raid and the encounter was completed; it does **not** claim V killed Nash. A reward/debug label containing “killed” would not override these actual condition semantics.

Nash refusal remains unmapped. The explicit refusing dialogue exits `go_roadhouse` without its own persistent positive receipt. The later roadhouse comparison against missing/zero `q103_helped_panam` cannot prove that this refusal was selected, nor prove Nash's survival or Rogue's knowledge. Its unmapped reason was updated with this concrete finding.

### Motel room sharing

Bar choice10 option0 offers one room. Section12 explicitly describes **twin beds**, then choice407 either accepts that arrangement or flirts further. The shared routes converge on section410, where Panam books one room with twin beds. This is not evidence of sex.

The room-follow objective succeeds when the player-inside-room trigger25 and Panam's `q103_bar_room` SpawnSet activation1020 join at **AND1256**, which drives journal node42 through input ordinal3 (**Succeeded**). The SpawnSet activation is not an independent position condition proving Panam physically arrived. Node42 activates the upstairs sleep objective1137. Sleep choice1141 leads to goodnight section1144, cinematic tier858, delay856, Panam reactivation861, and the additive shared-room receipt at2775. The rule requires both the positive receipt and revealed room-follow success. The completed flirt flag is not required because the separate-beds-only choice also takes this path.

### Motel flirting

After the initial shared-room proposal, choice407 option0 selects the further flirt. Section406 includes V clarifying interest, Panam acknowledging that she is glad they met, and Panam deferring intimacy because she is tired. Its socket2 event at **29.143 seconds** writes exact `q103_15_rooms_flirt = 1` through node843 after the spoken boundary. This differs from merely renting the shared room. The rule also requires the revealed Ghost Town quest to be succeeded, then limits the memory to V/Panam private or phone conversation.

### Farmhouse support for Panam

Choice1682 option1 enters section805. V criticizes Saul's plan; Panam thanks V; Saul challenges the opinion. Socket2 at **8.057 seconds** sets `sq004_sided_with_panam = 1` at1990. It then enters choice812, whose later options can elaborate from different backgrounds **or retract the statement**. For that reason the authored text explicitly says V **initially** backed Panam. It neither asserts a particular lifepath explanation nor converts the initial stance into permanent loyalty.

The tempting `sq004_panam_like` is deliberately not used: the farm scene has several unrelated increments, including flirt choices. This expansion relies on the exact sided-with receipt instead.

### Farmhouse support for Saul

Choice1682 option0 enters section807 and then explanation choice811. Three affirmative explanations (sections817/818/819) converge at822, where Saul approves and Panam objects. Completed section822 writes additive `sq004_saul_like` at823. The fourth explanation choice retracts V's statement and bypasses this receipt.

The statement therefore records the shared practical position on clan survival and corporate support, without choosing an explanation or a lifepath. It does not imply permanent hostility to Panam or a later Biotechnica contract outcome. Both Panam and Saul participated and may discuss it together; adding an uninformed companion to the group suppresses disclosure.

### Private farmhouse flirt

The private exchange at928 reaches choice932. Both overture options0 and1 write exact `sq004_panam_flirted_farm = 1` at2657; the sleep-only option2 does not. Option0 enters section933 and then Panam's boundary response at929. Option1 enters the gentler banter at942. Because the receipt merges those two choices, the rule does not assert that V touched her thigh or selected any particular gesture.

The completed Riders guard establishes the later reached stage. The authored knowledge records an overture, not mutual romance, sex or permission to ignore Panam's boundaries. The audience is private/phone to Panam alone, even though Saul was present earlier in the farmhouse scene.

## Native journal selectors

All paths join exactly to the winning EP1-overridden `base\journal\cooked_journal.journal` and declared native class. A selector's existence is not completion; the runtime must capture its **revealed succeeded** state.

| Alias | Class | Native path |
| --- | --- | --- |
| `aldecaldos.ghost.tunnel-cleared` | `gameJournalQuestObjective` | `quests/main_quest/act_01/q103_warhead/tunnels/defeat_boss` |
| `aldecaldos.ghost.shared-room-entered` | `gameJournalQuestObjective` | `quests/main_quest/act_01/q103_warhead/roadhouse/follow_panam_room` |
| `aldecaldos.ghost.completed` | `gameJournalQuest` | `quests/main_quest/act_01/q103_warhead` |
| Existing `aldecaldos.riders.completed` | `gameJournalQuest` | `quests/side_quest/sq004_riders_on_the_storm` |

## Localization evidence and limitations

Scene-local English descriptor/payload joins were checked against the installed English subtitle SQLite index, opened read-only. Of 552 English descriptors in the seven new scenes, **547 matched** an installed gender variant. Four had a changed installed text and one was absent. All scene items cited as semantic evidence in the six enabled rules were individually asserted to match before authoring their references. The mismatched/absent rows are not used.

The ignored `localization-audit.json` records the exact scene pointer, variant ID, shipped subtitle path, binary hash and pointer. New rule evidence also includes direct installed subtitle references for the reviewed dialogue/choice items. No dialogue transcript was copied into the shipped statements or this review.

The queried AV-crash and Mitch scene receipts are not enough by themselves to enable the much broader remaining Wartime outcomes. `q104_av_crashed` is written around the vehicle going behind a hill; completed participant knowledge and stage gates still need their own complete review. The Mitch scene's completion cannot simply stand in for all casualty disclosures, V-versus-Panam rescue routes, or pilot information. Those outcomes remain unmapped. Neither later camp membership nor a spawned companion substitutes for witnessing them.

## Independent integration gate

Completed before checkpoint:

- Scanned existing executable `narrativeLinks` across **all** native packs, including `core-arcs.json`; none duplicates these six exact decision/outcome pairs.
- Replaced exactly six unmapped records; kept their original narrative links and left other lanes/shared generated files untouched.
- Verified the complete per-pack schema, reference binary hashes, exact pointers, expected types and selected fact values with `node research/cyberpunk/scripts/review_native_rules.mjs verify research/cyberpunk/native-rules/aldecaldos.json`.
- Recorded all selected fact writers and their set/add semantics in ignored `writer-audit.json`; both test writers were checked against the shipped-root reference closure.

The independent reviewer executed the following resolver scenarios rather than accepting authoring assertions. They use offline current-save fixtures and do not modify the game, contact an API or seed memory:

1. Each positive fact plus its exact revealed succeeded stage selects only the intended topic/outcome for an allowed speaker; the selected memory candidate preserves both captured fact and journal evidence.
2. Missing/unknown/absent facts, ambiguous and explicit zero, negative or wrong exact values, missing/hidden/active/failed journals, another quest identity and another selector suppress the rule. No refused/no-romance alternative appears. Additive counters still qualify when greater than one; exact flags do not.
3. Simultaneous positive farmhouse stance receipts suppress both outcomes before private, phone or group audience filtering, including a group with an unauthorized listener.
4. Shared-room and motel-flirt receipts coexist as distinct facets without conflict. Room sharing alone does not imply flirting. An accepted Nash proposal with an active fight objective does not qualify as completed assistance.
5. Private/phone Panam contexts receive the four Panam-only records. Every other authored clan profile and every group context suppresses those records, including a group containing only Panam.
6. A Panam/Saul group may discuss either nonconflicting farmhouse policy outcome. Adding any of the other five authored clan members suppresses it for either speaker because the entire audience is not known to have heard the exchange. Mitch/Dakota alone receive neither stance.
7. Unknown/session-only identity retains correctly scoped dynamic context but produces no eligible long-term-memory candidate. A fresh capture with missing observations never reuses a previous successful call, and string-shaped fact values are rejected.
8. Exact binary and exported JSON digests, typed pointers, expected write fields, reconstructed native journal hierarchy/class, production sockets and indexed writer values all pass. The separate per-pack CLI still does not enforce the extra JSON hash field; the new source gate does.

Run the complete source gate with PowerShell:

```powershell
$env:CYBERPUNK_NATIVE_SOURCE_CHECK = '1'
node --test bridge/native-aldecaldos-expansion.test.mjs
```

The 18 resolver/schema tests run without private native resources on a fresh checkout; the five source-integrity tests require the explicit environment flag and ignored native cache. The parent still owns combined-pack strict verification, shared generated outputs and any runtime rollout. No package build or live install was performed by this lane. No production-rule defect was found; the independent review corrected the physical-arrival wording and made the external debug-scene limitation explicit.

## New-reference hash index

Paths are relative to `cache/game/`. Exact pointers, expected types and selected expected values are in the corresponding `al-native.oct01-*` evidence records in the lane JSON. These are the recorded authoring hashes; source binary hashes passed the per-pack verifier.

| Native/export path | Binary SHA-256 | JSON SHA-256 |
| --- | --- | --- |
| `localization/raw/base/base/localization/en-us/subtitles/quest/q103/q103_11_tunnel_drive.json.json` | `a415036c4d372c26378d58a4b8f93974191e80525f7f619d0db3c4a7818af6d0` | `03cc27903261646a1b136de1f0a96c4f6a8334964561a712473fb6e94436187e` |
| `localization/raw/base/base/localization/en-us/subtitles/quest/q103/q103_15_roadhouse_bar.json.json` | `739c0e1c7833ed76215ac4fdd7e3f0a8e89822b1996c9a9c91f39644c7735c4f` | `962dc85cb321ee7c21b25e89f09744339813ffc8c61e941977685748144a05a9` |
| `localization/raw/base/base/localization/en-us/subtitles/quest/sq004/sq004_08_farm.json.json` | `4d8c047d8e709f42d56eec1195153afcdd99bdcdcddc1a9829552313c632f3ba` | `cb1d015863564625a64141f88ad8c7698093fef6f936f4eeb45c692e0f562fcf` |
| `raw/base/base/quest/cyberpunk2077.questphase.json` | `78d8afd0784575216b090f003610ca973be9d1781bab948c9e4dc12006d750b2` | `9cc265cc1e6b66f28192713658d829b274338917174a15e3392c210d33761df7` |
| `raw/base/base/quest/main_quests/part1/act_1.questphase.json` | `3259983b6e1a5e1127fc580d34d1b3f2c53619e4db09047791603a785c10c661` | `b2d92152860c551df1ab1b1ce82e6efb54025e1c88d0c7470ade15ffa177c389` |
| `raw/base/base/quest/main_quests/part1/q103/phases/q103_03_ghost_town.questphase.json` | `ae0562a821a68326002e461b4a972a252fe8fac5e36f77cd3d226b0adc8bb695` | `7e09cfa40eba3519447b4249025da544ddda3e788932d81683dee08eaa88a096` |
| `raw/base/base/quest/main_quests/part1/q103/phases/q103_04_tunnels.questphase.json` | `3af9a5e3909e5ee96a7c5ff9edc8c39543e23c46bff2135cd69c713e1d9cecc2` | `cc3def73304e53d22e7e71e19f4537deacc38c28ff34e6cfd7269bc7028d3268` |
| `raw/base/base/quest/main_quests/part1/q103/phases/q103_04a_tunnels_combat.questphase.json` | `410ab49bdef38ed0a5acf667c1abd161bd44d876b1943eb6f105dc38cc41488b` | `e3e1f73f8104bbc9354037816b60dd803c54627bd6cb104838146e65be957b45` |
| `raw/base/base/quest/main_quests/part1/q103/phases/q103_05_roadhouse.questphase.json` | `2649527048218221765dc86bdbd1377049f9c1de6f4f1634a3dd23ffdf508524` | `a56eb644da02cf0797600a8186dcd18528a3547cb9eb2698a6822c459907a6e0` |
| `raw/base/base/quest/main_quests/part1/q103/q103.questphase.json` | `0b5629c65de9d883d85268ea4ab76ecaa0d1823c7d9ec23dcf6647ae47bca377` | `16712e6c77c94540731f4222f23a772046ea7b3ecf0e325f5081f4e97796ec4b` |
| `raw/base/base/quest/main_quests/part1/q103/test/q103_chicken_test.questphase.json` | `eada3f46dcf18731e0a44f74f24d9e6919824f4dfafe0c6cdc12ecbfa86a903d` | `9045df34233d2f00531a30f9d92d934a1497e8aa470c39c1e266c8e4a197bccc` |
| `raw/base/base/quest/side_quests/sq004/phases/sq004_05_farm.questphase.json` | `f128a4f4a7e1ba39511bf32b9b0a2ced1e4a79c8e93433c4ef84c3e3130df30e` | `e64e58e6815a3094f7b5481dfac88edc2895ac0beea8de4bf6f52ebdf52c0989` |
| `raw/base/base/quest/side_quests/sq004/sq004_riders_on_the_storm.questphase.json` | `156c2b19eea1f8a5ebc17fbadde609b6772d32d9560acc5a76724f4212d10537` | `419ef65d85e442946334362a2f9569bbac6f93ea0472387d310e746eac778779` |
| `raw/base/base/quest/side_quests/sq004/sq004_riders_quest.quest.json` | `40333639eb049c02fd4054313a45805ec0d2b5a8fc1ae2f782730e921ff0cd3e` | `11a730888112f8a9f8708b1f3c221e0b10c3f0445c03c4a2ff64a13ef6dd46a1` |
| `raw/ep1/base/journal/cooked_journal.journal.json` | `55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b` | `1c90b9bc1492ce287e55248b55e93216184ed61d49ffc00eeedb97918d1f44ec` |
| `scene-evidence/aldecaldos-oct01-nash/raw/base/base/quest/main_quests/part1/q103/scenes/q103_11_tunnel_drive.scene.json` | `78b4380aa569d60580acf7a2d05f3b0c1b7dc05f27593f2c59dc17207ea5b77e` | `f38313579dac631597d5d5436f4fd28de2b15a82aaca615cad5a893edbdc1d05` |
| `scene-evidence/aldecaldos-oct01/raw/base/base/quest/main_quests/part1/q103/scenes/q103_15_roadhouse_bar.scene.json` | `a2e44f93910dc8ee83ebf635ae0bfa595b7e5a1d6f8fa96f75aac8fa1a96a75e` | `45d158b4927e07dc032dad7a34e6caaa7ecae28dfbec19b538c16992ea1d5481` |
| `scene-evidence/aldecaldos-oct01/raw/base/base/quest/side_quests/sq004/scenes/sq004_08_farm.scene.json` | `43d1fee3a3403be89874e7e6ba69cc087387b7a555f56fc3ff67c8f4a20a71ef` | `ea390431e593165a4664617e8b2b2f87ad77d6b22aa51a0cb64ef5e510facb01` |
