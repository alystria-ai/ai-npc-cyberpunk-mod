# Silverhand native expansion — October 1, 2026

Reviewed against installed Cyberpunk 2077 2.31. This changes the authored
`native-rules/silverhand.json` only. It does not rebuild or install merged
knowledge, change game facts/saves, edit cloud characters, or seed memory.
Accepted movement, eye contact, blinking, UI and lip sync were not changed.

## Outcome delta and qualification

- Six new rules cover six previously unmapped narrative outcomes: three
  Swedenborg machine choices, bot discovery, V's truth report to Nancy, and
  actual Porsche recovery.
- Silverhand source part: **15 → 21 enabled rules; 13 → 19 distinct mapped
  outcomes** out of 129 researched outcomes. **110 remain unmapped locally.**
- Evidence records: 17 → 27. Positive allowlisted facts: 13 → 20.
- The additions cite 21 native files with **1,118 exact references**, each bound
  to recorded native-binary and exported-JSON SHA256. Strict read-only verifier
  passed with zero errors. These are source-verified, not live-save qualified.
- The original 390 references were subsequently migrated using **fresh native
  extraction and serialization**, preserving every original semantic input.
  Whole-part **strict** verification now passes **1,508 hash-bound references
  on 47 cached artifacts, zero legacy JSON-unbound references**. Old unbound
  JSON was not relabeled by hashing it; the migration below proves equivalence
  to newly authenticated installed-native output.
- An independent reviewer found and corrected a missing explicit bot-diagnosis
  join and a test that only counted its constant expected list. The corrected
  six-outcome candidate independently passed binary/JSON hashing and exact
  pointer/value traversal in Python. Before the provenance migration its SHA256 was
  `7713ed4b5a33bfc0629efdff6b8dc7214d88c15cb93888d2c2795ac38c7dd0ad`.

## Executable semantics

| Narrative outcome | Positive conditions | Native proof | Speakers / audience |
| --- | --- | --- | --- |
| `swedenborg-machine/disconnected` | `mq018_swedenborg_disabled >= 1` AND `mq018_fortuneteller_finished >= 1` | Choice64 ordinal0, screenplay option2, writes node80 exact1. Its closing path changes the machine display and the Bartmoss site to the disconnected state, then reaches End0. | Johnny; private/phone only. |
| `swedenborg-machine/left-running` | `mq018_swedenborg_unchanged >= 1` AND finished | Choice809 ordinal0, option1026 → cut-control872 **normal output0** → access-point interaction disabled1900 → exact writer81. Section249 confirms leaving the operation intact. | Johnny; private/phone only. |
| `swedenborg-machine/altered` | `mq018_swedenborg_trolled >= 1` AND finished | Choice64 ordinal1, option258 → exact writer82; alternative display1911/site1788→1789 and closing section243. Actual native Netrunner build condition gates the option; no old numerical Intelligence threshold is invented. | Johnny; private/phone only. |
| `swedenborg-discovery/bot-identified` | `mq018_fortune_found >= 1` AND finished | Discovery39 includes Johnny's identification; choice109 ordinal0 → exact writer932 → bot discussion137. Mandatory continuation66 explicitly diagnoses the hack and changed algorithm. | Johnny; private/phone only. Nancy has not automatically been told. |
| `nancy-disclosure/truth` | `mq018_swedenborg_exposed >= 1` | Call choice21 ordinal0 → entire spoken report22 → increment writer48 → reward80. V screenplay1281 addresses Nancy and describes the automatic fortune-teller connected to the Net. | Nancy and Johnny as native call participants; private/phone only. |
| `porsche-recovery/recovered` | `sq031_porsche_unlocked >= 1` | Driver-mount guard3959 → one-second delay3211 → actual `EnablePlayerVehicle`3207 → remote-control3923 → increment writer1812. Vehicle is `Vehicle.v_sport2_porsche_911turbo_player`, enable1, active1. | Johnny; private/phone only. Historical recovery, without asserting current location, ownership, or Grayson's survival. |

The three machine choices share the **same conflict topic**,
`swedenborg.machine-state`. Simultaneously positive contradictory choices
withhold that topic; independently established bot discovery can remain.
All rule conditions are positive. Missing/zero observations remain unknown.

The native report uses `participant` perspective because the report writer
already establishes participation in the game call. Runtime `told-by-v` also
requires a separate AI-conversation disclosure receipt, which is neither
necessary nor fabricated here. The rule's statement still says that V told
Nancy. It reveals no private possession information or machine-choice outcome.

## Normal entry, completion and persistent paths

### Fortune-teller and Nancy

The ordinary `mq018_02_goose.questphase` In1 sequence is Brooklyn141 →
Solar142 → Protein143 → Fortune144. Its nested graph at
`/Data/RootChunk/graph/Data/nodes/11/Data/phaseGraph/Data` enters In1 →
checkpoint5 → guard4 (**content unlocked AND V inside amusement trigger**) →
hub10 → scene2 **Start 0**. Exact entry1 and matching selector are pinned.

Scene2 **End 0** is the sole connected normal input to exact completion
writer20, which sets `mq018_fortuneteller_finished=1`, then unblocks23 → Out1.
This is a completed fortune-teller encounter, not general quest completion,
early router hacking, initialization, or a marker guessed from its name.
Choice markers are set before their final responses/actions, so the finished
predicate is required for all three machine outcomes and discovery.

Closing scene paths are recorded as exact graph/output-socket references:

- Disconnected: 80→739→754→1912→1791→1790→252→957→963→803→967→99→590→2.
- Left intact: 809→872(normal0)→1900→81→745→761→249→760→1386→1385→803→967→99→590→2.
- Altered: 82→742→757→1911→1788→1789→243→92→1395→1379→1380→266→812→811→732→1392→803→967→99→590→2.

Node1900 sends `ForceDisabled` to `AccessPointControllerPS` on the relay;
it disables hacking interaction. It does **not** establish that the actual
fortune-teller operation was shut down. Cut-control872's cancellation outputs
to choice64 are not treated as choosing the disconnected/altered branch.

Persistent `mq018_fortuneteller_persistent.questphase` uses **setup_in**162,
not Start0. In1 → amusement-inside guard3 → scene2 setup_in; an outside-trigger
loop can cancel and restart that persistent setup. Full raw scene reachability
from162 contains32 nodes and none of writers80/81/82/932. It cannot manufacture
the four positive branch facts. Its selector and exact parent connections are
cited separately from normal interaction.

Mandatory section66, screenplay1537/1793, supports the bot statement's hack
and algorithm attribution. Removing66 from the raw graph leaves no path from
writer932 to End2. Scene English and shipped English subtitles are distinct
exact references; phrasing/case/whitespace differences are retained rather than
normalizing one resource into another. Actor and screenplay joins are pinned.

After Fortune Out1, `mq018.questphase` node8 enters resolution phase12 In1.
Nested objective12 → checkpoint13 → add-contact11 → incoming-call guard14 →
scene2 **Start 0**. Scene1→274→286→279 waits for Nancy holocall readiness;
280→283→20→choice21 follows. Report section22 completes before writer48.
Alternate choice ordinal1 follows section23 and has **no positive withholding
writer**. Zero/absence of exposed therefore never proves the withheld outcome.
Interrupted/returned holocall sockets resume the call without directly writing
the report marker.

### Porsche

Ordinary `sq031_adam.questphase` nested In2 node22 invokes scene3 through
**sq031_04_car_lift_in**, matching scene entry1293. It is distinct from the
confrontation selector **sq031_04_grayson_in** entry1. The exact normal quest
connections and release resource chain are pinned.

The installed persistent `sq031_porsche.questphase` fallback is also production
content: positive Grayson-death guard18 → key-inventory guard27 → find-car
journal not Active20 and not Succeeded21 → preparation writer24 → scene22
**sq031_04_car_lift_in**. The inventory item is the actual cargo key; the
fallback marker `sq031_porsche_no_grayson` is **not** a recovery condition.

The ordinary car-lift flow lowers the container, spawns the specific Porsche,
opens/unlocks it and waits for the player to mount as driver. Only then does
3207 enable the player's vehicle;3923 enables remote control;1812 records the
unlock. Writer1812 has one input, from3923;3923 has one input, from3207. Thus
the actual vehicle grant dominates every route to the historical marker.
Johnny's screenplay9217 and native actor2 identify it as his old ride.

Raw graph reachability also allows **Start 11**, **preview_grayson_interrogation**
and **placeholder** to reach the same actual grant chain. They are explicitly
recorded as alternatives, not counted as ordinary release invocation proof.
No claim is made that only the ordinary selector can reach the writer. Preview,
shooting, obituary and reused sockets are not interchangeable with recovery.

### Release definitions

Fresh `base\quest\cyberpunk2077.gamedef` schedules
`base\quest\cyberpunk2077.quest`. The regular installed `ep1\quest\ep1.gamedef`
schedules that same base root plus `ep1\quest\ep1.quest`; the preorder root
has its own additional-content flag. Exact `mainQuests` arrays are cited.

`ep1_standalone.gamedef` schedules **different** standalone roots. Its presence
is not used to infer the normal base route, socket selection or execution order.
The base/persistent reference chains establish production provenance; only
the runtime's positive observations establish an outcome in a particular save.
Default save history, debug execution or a human's actual button press are not
distinguished merely by a positive game fact.

## Writer and resource integrity audit

`runtime/silverhand-oct01/writers.json` records a fresh search of the main
winning base/EP1 quest fact index plus every scene fact index available at the
audit. **31 indexes** were hash pinned. Duplicate exports are deduplicated by
depot path, exact pointer, value and exactness. All seven new allowlisted facts
have one unique positive writer; no additional initialization, reset, decrement
or preset writer was found in that corpus.

This is a bounded corpus result, not a claim that every shipped scene or
arbitrary game script has been decoded. Later-discovered writers require review.
The rules do not read absent/zero as a rejected branch.

| Fact | Writer node | Assignment semantics |
| --- | --- | --- |
| mq018_swedenborg_disabled | scene80 | exact1 |
| mq018_swedenborg_unchanged | scene81 | exact1 |
| mq018_swedenborg_trolled | scene82 | exact1 |
| mq018_fortune_found | scene932 | exact1 |
| mq018_fortuneteller_finished | nested phase20 | exact1 |
| mq018_swedenborg_exposed | call scene48 | increment1 |
| sq031_porsche_unlocked | Grayson scene1812 | increment1 |

Independent archive audit freshly scanned all **62 installed archives**,
including PC mod archives, and verified **25/25 isolated lane assets** with
one current matching entry each and no competing entry. The three source
archives' directory metadata was stable before/after. Exact installed decoded
payload SHA1/SHA256, cached binary byte equality, exported JSON SHA256 and
`Header.ArchiveFileName` source identity passed. This includes the12 copied
quest/phase resources, three shipped English subtitle resources and three
freshly serialized game definitions. Resource integrity does not replace the
semantic/participant review above.

Receipts are ignored local research files:

- `runtime/silverhand-oct01/current-archive-winners.json`
- `runtime/silverhand-oct01/verification.json`
- `runtime/silverhand-oct01/assembly.json`
- `runtime/silverhand-oct01/writers.json`
- `runtime/silverhand-oct01/semantic-review.md`
- `runtime/silverhand-oct01/resolver.tap`
- `runtime/silverhand-oct01/resolver-source.tap` (promoted authored source)
- `runtime/silverhand-oct01/legacy-migration-current-winners.json`
- `runtime/silverhand-oct01/legacy-migration-comparison.json`
- `runtime/silverhand-oct01/legacy-migration-independent-review.md`
- `runtime/silverhand-oct01/legacy-migration-verification.json`
- `runtime/silverhand-oct01/legacy-migration-resolver-source.tap`

## Authenticated provenance migration

After the six outcome additions, the remaining original 390 JSON-unbound
references were migrated without changing any rule, statement, predicate,
audience, narrative link, source, allowlist or supported profile. Pack revision
increased 2→3 to record the provenance update.

The exact 26 installed winning binaries were freshly extracted into
`cache/game/scene-evidence/silverhand-authenticated-oct01` and serialized by
pinned **WolvenKit.CLI 9.0.1** with the pinned **.NET 10.0.12** runtime. Hidden
subprocesses used one CPU, the shared two-CPU gate, and a distinct
`silverhand-knowledge-migration` output lock. Each remaining serialization
released its CPU slot before the next resource; comparisons held no native slot.
An early batch yielded to queued voice casters after finishing its active
resource. Its 13th orphan output was freshly reserialized on resume, not
authenticated merely by hashing the unrecorded JSON.

All 26 **complete Data trees** match their previous exports exactly under
canonical comparison. All 390 cited pointer values, 141 declared types and
13 original writer objects / 39 expected fields also match. Thirteen small
writer objects now have complete `expectedValue` assertions in addition to
their preserved original `/factName`, `/value`, `/setExactValue` maps. The
native binary hashes stayed identical. JSON source paths and recorded hashes
now refer to the new authenticated exports; no old export was overwritten.

Independent review separately checked raw SHA256/SHA1, JSON SHA256, source
headers, complete Data, pointers, writer assertions and semantic preservation.
The independent archive audit scanned all 62 installed archives and verified
all 26 fresh targets (9 scenes, 1 quest, 16 questphases), each uniquely present
in the current base gamedata archive with no competing entry. Bounded native
payloads, binary byte equality, archive-entry metadata and source/manifest
stability all passed; native payload work acquired/released the shared slot
per resource.

Strict read-only verification now reports 21 rules, 19 mapped outcomes,
1,508 authenticated references on 47 artifacts, **0 errors and 0 legacy
JSON-unbound references**. Production source exactly matches the independently
reviewed candidate SHA256:
`a9587a4f03b7eafd46b754b0c7f92d6c0aacab9bdd3681abc80dcf41b761e573`.
Source verification remains distinct from actual execution in a loaded save.

## Executed resolver verification

`bridge/native-silverhand-expansion.test.mjs`: **13 tests pass**, comprising
an authenticated-binding/original-writer contract and 12 scenario groups,
with multiple value/audience/channel combinations in each relevant group.
They execute the actual authored source part rather than generated fixtures:

1. Runtime schema and exact set of six added outcome rules.
2. Missing/zero facts and completion alone establish no new Swedenborg outcome.
3. Each machine/discovery marker waits for positive encounter completion.
4. Each completed machine marker maps its distinct branch meaning.
5. All pairwise contradictory machine flags suppress only that conflict topic.
6. Bot discovery does not automatically tell Nancy or Kerry.
7. Positive native report is available to Nancy/Johnny in private and phone
   without fabricated AI-chat disclosure, body possession, or machine-choice data.
8. Zero report is not withholding; machine choice and truth report are independent.
9. Group audiences and historical/nonparticipant copies receive none of the
   new private 2077 knowledge.
10. Mercy/death/cargo preparation alone does not establish Porsche recovery.
11. Actual unlock gives historical recovery independently of Grayson's fate.
12. Broad completion does not invent dog tags, control agreement or Archangel.

No live-save acceptance is claimed and no conversation was sent to seed memory.

## Deliberate remaining gaps

- Nancy's withheld report lacks a reviewed positive writer. The absent exposed
  marker cannot fill it.
- Tapeworm dog-tag receipt and Rogue-control agreement need separate native
  transfer/choice proof; completion, trust or prop presence is insufficient.
- Archangel grant exists in the concert graph but lacks a reviewed post-transfer
  durable predicate. Concert completion does not invent receipt of the weapon.
- Kerry sabotage, escape, diner monologue and followthrough remain independent
  unaudited branches. The partial monologue marker does not replace them.
- The accepted oilfield second chance remains owned by **core-arcs**, without
  duplicating the rule or interpreting its absence as another conversation.
- 2013-era historical personas retain their existing limits; Johnny's subjective
  remembered history is not rewritten as objective omniscience.

## Exact cited artifact hashes

The table below is generated from the references used by the six additions.
Every writer/scene/entry/edge/dialogue join also has its exact pointer, expected
type/value where relevant, and both hashes in the authored evidence records.

| Depot path | Binary SHA256 | Exported JSON SHA256 |
| --- | --- | --- |
| base\quest\minor_quests\mq018\scenes\mq018_02_fortuneteller.scene | 34e2a97e11d2bb0f2d9a64d633c2d5b2ba6ca1a7e102a040fe0c6cbb058d1c32 | e6197b6824039d044b6dc50dd7164c5982ddd43743eadb836fc43fb0da168d6c |
| base\quest\minor_quests\mq018\scenes\mq018_03_call02.scene | 5ae72bc3e9a13049888cb893c4ed207d3c170d438d215781e297bfececae3223 | dd923bb98e4577bf26198b08bd5a052dd33e8e221a9285ea575362ede8de76af |
| base\quest\side_quests\sq031\scenes\sq031_04_grayson.scene | 9d1a6b6da1f7ebff5df647329af8a92eb6026b1022a40995055aa0588d84f54e | f25cf2e85dcfa0523c4d591b1a06cf4fc9edad1ca29bc28f0d42a8c3f79c9dd8 |
| base\quest\additional_game_elements.questphase | c67fb292f88384f3f31e8242fc374e8b7afe5553588333c61f6eaec2c1e0b7eb | cca7f8e80bd2ac15c9d0a5b790df60f54efdba2c66f4725cb384cc1cd1a375fa |
| base\quest\cyberpunk2077.quest | b14f15d20e6723b97cf4afe260546c5c6e93c84856c47372fbbb8377b640f449 | 9a6d64cd31fe9930c747738e02f1a9b1e00810cd582ee0a2a321701297752c3e |
| base\quest\cyberpunk2077.questphase | 78d8afd0784575216b090f003610ca973be9d1781bab948c9e4dc12006d750b2 | 172841c70e1295e3a93f2e8940e3b26143f34acec45e815309f178af84d9ecea |
| base\quest\minor_quests\minorquests.questphase | 89e902a6bcc783325642a6dc6d1d856bb144651136c58d423fea6b421efce85a | c7fd55afb98e2ea8a1d81d8b03dd7408aa12ad919c18782b3eb1aa4bbb84819b |
| base\quest\minor_quests\mq018\mq018.questphase | ee1f76f93f85b132a0d8a5c357c6d9860bea16921b215101333e578f7ea128be | 9d1cd9b69f1d1a3dee42b14d23b161dac1a494168a26952a50d66f78c42329c3 |
| base\quest\minor_quests\mq018\phases\mq018_02_goose.questphase | 0d497641c68c9f0ea2bfc6e8b5155880e45fc1ca97c3fe48a07c85f42fcb2a11 | e479d28660359e47336a76ad5db417a64c3a206eac15e2f25abd4052a8008914 |
| base\quest\minor_quests\mq018\phases\mq018_fortuneteller_persistent.questphase | e8c803d46355b2013388492eb56e0b5bb38015f845b162beb8087a1818ee35fe | 7944d11c9cbf04f9cb3b633a45ba63e37ac54f355eeef453c74991cbd0deed97 |
| base\quest\persistent_content.questphase | 7e702dfe44e84719576d6bed8d87f3bda383e308cb45c85fe34de9cc4ca62189 | 531692941c1aaec49acb04096af06412ebee3595534bd8829819a4555f8febbb |
| base\quest\side_quests\sidequests.questphase | 1cf2fc2ba3b538f7496fddf09ff319602f54f6785a925ba36ad3c9b90020f000 | c0d8f482267088e69b56e16b92fc49177c9ad30d8c89328aa2afb409a8dbf00f |
| base\quest\side_quests\sq031\phases\sq031_adam.questphase | 8e48ee6c2b7e3bd3c30dfa2127e88f6b077ca54982ae2785e01250f5d291c4d0 | b01719f444adb3368dfdb3408a1008fd1c9d7510da906aa95580386890adb0c0 |
| base\quest\side_quests\sq031\phases\sq031_porsche.questphase | a96a5b8271fc7c3619fe75f0df135efa33c4a15b447888fdd180512d627ac535 | 1685a6d387f1023604bc2b9b94b6013b80583aeb919cfb682312b6c77e5e9d89 |
| base\quest\side_quests\sq031\sq031.questphase | 94beda33aa89990fee79225f2394fbe40762746ac14ff63026cef6dc642608ee | 15cb033ccf9b2d4e7b9e6771a400a2e46cbb84597c88bcddb5e900c72c1b7ce4 |
| base\localization\en-us\subtitles\quest\sq031\sq031_04_grayson.json | 391830a57d639100044d40a8143238d19734d4a13a3b6128e935c35d366e402e | 85099efb840883437e80c76ffa37d145a5445ab54e17205c18487ddc0f24bf45 |
| base\localization\en-us\subtitles\quest\mq018\mq018_02_fortuneteller.json | 46adaf7148d8d445537f033eafe595a6291a209caa83ca8d638f30ed9aa19f99 | 8c8e96e79ce6607a08aaf8a13ad7f9b9e689ed617b93b4e623007a1a03eb0e1e |
| base\localization\en-us\subtitles\quest\mq018\mq018_03_call02.json | 1f3a64beaf7171ca0582e9461296fceeb26512df70423d0c5c824a442c38a852 | 731b00f3872be8f671169d99575c7566e26f91a94998488eb1215123b4dc37a4 |
| base\quest\cyberpunk2077.gamedef | 3bc1e3a75a1ba9dc582b8c7736a758899001cd15424ed79e1654de8b8ca41bbd | 1f53f25901bf99e09a390597a879d0a27e1d15c952e5e05e933e5607119d27ff |
| ep1\quest\ep1.gamedef | 30b735c237ea2344b3f667752b4f98fdbbe1283808594a51693cfa61aebc6579 | 5629a2eb2857d353c68937c0d9c0ef8d42aa007f324936442f0199f80cc83229 |
| ep1\quest\ep1_standalone.gamedef | 14a5819084afbdb4aeed424a9dc935c36f08ee158265cf202200d8bf2ccb7429 | 239409c4f602101cd36bb8ad606cda35b79e09fe35ba64b591330a66ed99371d |

## Migrated original artifact hashes

These fresh exports authenticate the original 390 references without changing their complete Data or rule meanings. The exact references point into scene-evidence/silverhand-authenticated-oct01/.

| Depot path | Binary SHA256 | Fresh JSON SHA256 |
| --- | --- | --- |
| base\quest\cyberpunk2077.quest | b14f15d20e6723b97cf4afe260546c5c6e93c84856c47372fbbb8377b640f449 | 1fa07c6fc64ad4435adb50258123aea5080d84f835c350b326b3ab097f0abe46 |
| base\quest\cyberpunk2077.questphase | 78d8afd0784575216b090f003610ca973be9d1781bab948c9e4dc12006d750b2 | f91aaf8b9a07a06c55e4565835c8ca80ffbe8dc201464b331b8a090c85ba2970 |
| base\quest\main_quests\part1\act_1.questphase | 3259983b6e1a5e1127fc580d34d1b3f2c53619e4db09047791603a785c10c661 | d6d7aeef250d28c288ad05ec3cdff3cdf500917cc797539c10a6d4db6927bb8b |
| base\quest\main_quests\part1\q116\phases\q116_smasher.questphase | 700dfdcc4a345553fb48dcb3e6b7053e67770e3862c0d0571f77e244f90da3ca | 60260adee82267ce8ccbfa2c1e345855bf103216635fe9c49cb7cc1fb15f5812 |
| base\quest\main_quests\part1\q116\q116_mikoshi.questphase | 2330712e14e1fe52c80f3236e0a4ee1e5f82c323f8d03b7d2e8dbc53921bc872 | 7fd2a7f19688aa95e88b958d1939c0fcf41583c018bc9b412ed01a81dcc0e9ba |
| base\quest\main_quests\part1\q116\scenes\q116_01_adam_smasher.scene | 7642406d5e724bfd0fa1c662a7934507d68364a022157291aa9492c92f751eb1 | 64f6dbbd5fa9dfc87d5ebeff1dd083c98d0b1a644bf66dd3437b047841105a7e |
| base\quest\main_quests\part1\q116\scenes\q116_03b_after_bossfight.scene | ab7fd4a0d8dd6e6223df7db328daeb4dd0a7820e6b331f6db173023fbcee05c7 | 7deb7e040604dd664f18244feb0fcd28276c4d999e6d7ce6a0c909008c40cac6 |
| base\quest\side_quests\sidequests.questphase | 1cf2fc2ba3b538f7496fddf09ff319602f54f6785a925ba36ad3c9b90020f000 | 77891aca360aabdf7f25493ca57178320cc61aabfadd2ec96d6d6e62fe942676 |
| base\quest\side_quests\sq011\phases\sq011_concert.questphase | 4c23d1a289ec13305a977f9ea5a84c7f6833fe15c8322bd72d6fa87b6c0dffd0 | 626ff82a8721b2990752f1e28340a0a9888d4278a2c30285b01afd7d358f7ad8 |
| base\quest\side_quests\sq011\phases\sq011_denny.questphase | f43183d4e703b83a7d792a122f951da7ddb8b7cd22156aa88071ac9dbaef6acc | 5115cf25023be81e271f32633c60016458fe19d0cc2c471af465b077ff170683 |
| base\quest\side_quests\sq011\scenes\sq011_08b_denny_henry.scene | 43f62deb4160dc6b09a8d5be53882669920ab6db781e473e6b57b3c21263f226 | 9dede44215087c4f5d494b0a38ce739a763c61640c8c5e0822d197cbe4e2062e |
| base\quest\side_quests\sq011\scenes\sq011_10_concert.scene | cbdae241c5cc5bff475fa8c709c91b8f5bbe4a45022608c52842a76aa7e3be94 | 142b49e2ae0c2c5da309bf4b70269615d4b4aac328cc536c52005fda424702af |
| base\quest\side_quests\sq011\sq011.questphase | 29e0464772f77576914bebcc2134146335877963c4f5f3b4839735188a41c9a3 | 48ca00500f33925e01aaa454e170439056addc1e44f8dedbee2fd3e9932fadd5 |
| base\quest\side_quests\sq017\phases\sq017_02c_club_attack.questphase | 10876269aa34a467391a5bdf7ba64912db5eb86a6ddaa1217c7abd94c4bc73eb | 4133ad23a275269f0f785d19627e26fdb650214bfebef4e33a670b4eaec0d45b |
| base\quest\side_quests\sq017\phases\sq017_03b_premiere_concert.questphase | 588d11c5c4048f6f51b391fced01e186b4e82176220b1ae87f284b993ea69007 | 8751f421835fe342313021bcab59028e954520eccc9327a1de00a0233f32ec4a |
| base\quest\side_quests\sq017\scenes\sq017_10_us_crack_intro.scene | b4b55ee1eac2f0511a431373c01eb80412a622cf22c3c1c435c706687a5c76ce | 4316ff0ab011697af33b637b6d7ae299933c07a1c0ff3d0e992b48653cdc0a68 |
| base\quest\side_quests\sq017\scenes\sq017_18_premiere.scene | 6d8ff01c80f80ba6fa9a4d210a8b88a8458df9ae0a94360cbe68e59fcf0a1caa | 4eb1c0e7d3c2ff3ec0075031a26b16c1a1b7f1f3bed9323149dbd2790095a37c |
| base\quest\side_quests\sq017\sq017.questphase | 1be5976a66e2736a49a408ed7e84b715353635220b090930c56ff35408050f34 | 68a26746d0e91538f930db80e969192b3f9f5b7eddd030e6ee5e74ed02d27954 |
| base\quest\side_quests\sq028\phases\sq028_03_beach.questphase | 4c90253133590384fe9460796de9952bcd1692739a81005dcaa4a4a305d5d8d7 | 162824faf4f130088ff6fedfc1cc7099ce1e04e515bb95e02a9d37e819a3ef54 |
| base\quest\side_quests\sq028\scenes\sq028_07_trashy_beach.scene | 1bb663aabc3292a2789b1bc6e8c2ce20ff81242a9b2d66c91ecf4a97bd2c2cbe | fff001d4ef96c31856b605226add3220c3f157d854195aea06a2ae5c9d326219 |
| base\quest\side_quests\sq028\sq028.questphase | 048e782bb7151adea2597cb3d0886d37e089bd73fcb71ab2be1f7d6139649b5c | db7759d3ba290b9559dbf6ea4ce3f5250fc8dd437989f924b9511f57da16f3f9 |
| base\quest\side_quests\sq031\phases\sq031_adam.questphase | 8e48ee6c2b7e3bd3c30dfa2127e88f6b077ca54982ae2785e01250f5d291c4d0 | f891c802df87857064d96ece2a716aebfb544de2534f5f29b2278a6e0c2b4347 |
| base\quest\side_quests\sq031\phases\sq031_bushidox.questphase | 49e3a6656aacb91df9f7a07c12ed12586c3df7de0da7e0d0b2e2e0b75489d2c0 | ca0f40520e0e42cef996af7da8dc3963422acc58d341b174016035273eb74fdb |
| base\quest\side_quests\sq031\scenes\sq031_04_grayson.scene | 9d1a6b6da1f7ebff5df647329af8a92eb6026b1022a40995055aa0588d84f54e | 6486fac708382ba5fab9ad88b065290e57d5626715cf8caeb7251251a414567f |
| base\quest\side_quests\sq031\scenes\sq031_08_movie.scene | 33be817d6b9243891ac5f43dd64df1b5c67706042d5eceed68af3e52f924b260 | 81e29215f2d405fac0cb0908f03c4ca009027504bcde130598be30b0a62c02a0 |
| base\quest\side_quests\sq031\sq031.questphase | 94beda33aa89990fee79225f2394fbe40762746ac14ff63026cef6dc642608ee | f408dcc23893f59ed4d256f66db1b516c629f2327521813c56af4ce90b160a73 |
