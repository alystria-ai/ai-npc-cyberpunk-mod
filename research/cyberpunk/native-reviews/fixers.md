# Fixer native mapping review

Reviewed on 2026-09-30 against the installed Cyberpunk 2077 2.31 assets. The pack is source-verified; native capture and live-save qualification are pending. This work changed research artifacts only and did not read a live save, alter gameplay, write cloud memory, or invoke Convai APIs.

## Coverage and verification

| Scope | Count |
| --- | ---: |
| Researched quests | 93 |
| Researched decisions | 177 |
| Researched outcomes | 272 |
| Source-verified executable rules | 45 |
| Quest keys with an executable rule | 28 |
| Cyberpsycho report rules / exact variants | 34 / 36 |
| Additional gig outcome rules | 11 |
| Native journal selectors / fact selectors | 110 / 0 |
| Native evidence records | 78 |
| Hash-checked cited artifacts | 68 |
| Verified native JSON pointers | 955 |
| Outcomes with a reviewed rule | 45 |
| Outcomes still unmapped | 227 |

The native compiler was invoked through its exported read-only functions. Runtime-pack validation and native evidence verification both returned zero errors. Validation checked the winning binary SHA256, exact JSON pointer, declared native types and exact-value assertions, plus every narrative decision/outcome link. These checks establish provenance and structural consistency; authored narrative meaning was reviewed separately.

The pure knowledge resolver passed 263 focused checks: the exact positive observations for each rule; missing observations; unsupported game versions; private-report exclusion from group audiences; session-only identity producing no durable memory candidates; contradictory alive/death reports for each of the 17 cases; and resident archetypes receiving no identity-specific facts or events. This does not qualify the native capture adapter against a running save.

## Interpretation contract

- Each cyberpsycho rule requires a succeeded selected `gameJournalPhoneChoiceEntry` and its exact Regina reply active or succeeded. Capture must establish that the choice was visited and selected; merely seeing a choice in the phone is insufficient.
- Each gig rule requires its exact quest succeeded, the listed objective gates, and an outcome-specific written fixer debrief active or succeeded. A completed quest or an objective title alone never resolves victim survival, method, disclosure or a later fate.
- These are historical exchanges established in the save. A reachable Phantom Liberty initialization can establish that history; it does not prove that the human player personally selected that branch. No unrelated test writer is used as a production outcome.
- A report that someone was alive does not establish their current life state, collection by Regina, treatment, recovery or cure. Killed, defeated and unconscious conditions remain distinct.
- Only positive known journal observations resolve these rules. Missing, inactive, hidden or unavailable entries remain unknown. No zero-valued fact, absence test or `*_done` shortcut is present.
- The contracting fixer receives only their own private or phone exchange. There are no public or group-disclosure rules, no cross-fixer omniscience, and no inference that V told every party member.
- Durable memory candidates still require the runtime's verified user, playthrough, branch and checkpoint identity. A Convai user ID alone is insufficient. Candidates are never memory writes.
- Shared `resident-male` and `resident-female` profiles describe ambient archetypes. They have no executable personal-history rules; a stable individual actor identity plus save/branch identity is required before durable personal memories can be attached.

## Phone selection and retired groups

The inspected pinned game-script checkout is `vendor/reference-game-scripts`, commit `fce9ab7e6a608b0d729290d898003589515900e1`. In `messengerDialogView.script`, `ActivateReply` marks the selected reply visited and succeeded while marking unchosen replies visited and inactive. The native report graphs then wait for the exact succeeded choice before activating the corresponding response. The selected choice and received response together establish the historical report.

Fourteen selected-choice aliases include `allowRetiredChoiceGroup: true`. Each carries `retiredGroupEvidenceRefs` pointing to the exact native graph instruction retiring that choice group. The exception permits only an inactive group ancestor of a succeeded, visited child. Contact and conversation ancestry must still be known and active/succeeded, and the matching Regina reply remains required. It does not promote inactive or merely visible choices into sent messages. All other aliases use the conservative normal ancestry guard.

Journal aliases resolve the exact native path and native class through `GetEntryByString`. Native hashes are observed from the returned entry; no offline hash was invented. Literal native spelling is preserved, including `wesbrook` in some journal paths and Padre's native contact key `sebastian_padre_perez`.

## Cyberpsycho report coverage

All 17 cases have separate alive-report and death-report rules. The Wasteland has two exact variants per outcome, with and without its Saul reference; their equivalent report meaning shares one rule per outcome. This does not infer Saul's rescue. Smoke on the Water preserves the report that MaxTac found the subject and makes no claim that Regina collected or treated him. The Wasteland death reply is private to Regina and V; it does not disclose the concealed death account to Dakota.

Simultaneously positive alive and death reports for the same case conflict and suppress the entire topic, including durable memory candidates. No winner is selected from timing, wording or current preference.

### Ambiguous label disambiguation

Three case labels require native branch evidence in addition to the installed English text. These were independently traced in peer review. Every cited comparator is actor-specific with `killed = 1`, `defeated = 0`, `unconscious = 0`; the pack includes typed comparator child pointers, exact field values, activation nodes and branch edges.

| Case | Root graph route | Interpretation boundary |
| --- | --- | --- |
| Letter of the Law | 141 True -> 142 lethal; 141 False -> 135 normal | Disambiguates which report choice is offered; it does not itself assert a present victim state. |
| On Deaf Ears | 107 True -> 108 lethal; 107 False -> 84 normal | The exact selected report and its reply remain required. |
| Lt. Mower | 191 True -> 226 -> 195 lethal; 191 False -> 193 normal; 193 Killed -> 195 | Embedded phase pointers distinguish repeated local node IDs; unconsciousness is not death. |

### Case locators

| Public case | Native case | Outcome / variant | Wait and reply route |
| --- | --- | --- | --- |
| Cyberpsycho Sighting: Bloody Ritual | ma_wat_nid_15 | alive-reported / standard | 229:Out/236:In -> 236:Out/216:Active |
| Cyberpsycho Sighting: Bloody Ritual | ma_wat_nid_15 | death-reported / standard | 230:Out/215:Active |
| Cyberpsycho Sighting: Demons of War | ma_wat_kab_02 | alive-reported / standard | 96:Out/95:Active |
| Cyberpsycho Sighting: Demons of War | ma_wat_kab_02 | death-reported / standard | 235:Out/240:Active |
| Cyberpsycho Sighting: Discount Doc | ma_std_rcr_11 | alive-reported / standard | 150:Out/252:In -> 252:Out/174:Active |
| Cyberpsycho Sighting: Discount Doc | ma_std_rcr_11 | death-reported / standard | 253:Out/177:Active |
| Cyberpsycho Sighting: House on a Hill | ma_bls_ina_se1_08 | alive-reported / standard | 100:Out/99:Active |
| Cyberpsycho Sighting: House on a Hill | ma_bls_ina_se1_08 | death-reported / standard | 139:Out/141:Active |
| Cyberpsycho Sighting: Letter of the Law | ma_hey_spr_06 | alive-reported / standard | 137:Out/136:Active |
| Cyberpsycho Sighting: Letter of the Law | ma_hey_spr_06 | death-reported / standard | 138:Out/140:Active |
| Cyberpsycho Sighting: Lex Talionis | ma_pac_cvi_15 | alive-reported / standard | 116:Out/115:Active |
| Cyberpsycho Sighting: Lex Talionis | ma_pac_cvi_15 | death-reported / standard | 117:Out/119:Active |
| Cyberpsycho Sighting: Lt. Mower | ma_wat_kab_08 | alive-reported / standard | 4:Out/3:Active |
| Cyberpsycho Sighting: Lt. Mower | ma_wat_kab_08 | death-reported / standard | 4:Out/3:Active |
| Cyberpsycho Sighting: On Deaf Ears | ma_cct_dtn_03 | alive-reported / standard | 86:Out/85:Active |
| Cyberpsycho Sighting: On Deaf Ears | ma_cct_dtn_03 | death-reported / standard | 110:Out/109:Active |
| Cyberpsycho Sighting: Phantom of Night City | ma_cct_dtn_07 | alive-reported / standard | 144:Out/143:Active |
| Cyberpsycho Sighting: Phantom of Night City | ma_cct_dtn_07 | death-reported / standard | 145:Out/147:Active |
| Cyberpsycho Sighting: Seaside Cafe | ma_hey_spr_04 | alive-reported / standard | 264:Out/261:In -> 261:Out/181:Active |
| Cyberpsycho Sighting: Seaside Cafe | ma_hey_spr_04 | death-reported / standard | 265:Out/184:Active |
| Cyberpsycho Sighting: Second Chances | ma_bls_ina_se1_22 | alive-reported / standard | 95:Out/94:Active |
| Cyberpsycho Sighting: Second Chances | ma_bls_ina_se1_22 | death-reported / standard | 175:Out/174:Active |
| Cyberpsycho Sighting: Six Feet Under | ma_wat_nid_22 | alive-reported / standard | 150:Out/216:In -> 216:Out/149:Active |
| Cyberpsycho Sighting: Six Feet Under | ma_wat_nid_22 | death-reported / standard | 180:Out/181:Active |
| Cyberpsycho Sighting: Smoke on the Water | ma_pac_cvi_08 | alive-reported / standard | 262:Out/261:In -> 261:Out/253:Active |
| Cyberpsycho Sighting: Smoke on the Water | ma_pac_cvi_08 | death-reported / standard | 263:Out/254:Active |
| Cyberpsycho Sighting: The Wasteland | ma_bls_ina_se1_07 | alive-reported / standard | 172:Out/215:In -> 215:Out/171:Active |
| Cyberpsycho Sighting: The Wasteland | ma_bls_ina_se1_07 | alive-reported / without-saul-reference | 260:Out/253:In -> 253:Out/254:Active |
| Cyberpsycho Sighting: The Wasteland | ma_bls_ina_se1_07 | death-reported / standard | 108:Out/107:Active |
| Cyberpsycho Sighting: The Wasteland | ma_bls_ina_se1_07 | death-reported / without-saul-reference | 262:Out/251:Active |
| Cyberpsycho Sighting: Ticket to the Major Leagues | ma_wat_lch_06 | alive-reported / standard | 127:Out/126:Active |
| Cyberpsycho Sighting: Ticket to the Major Leagues | ma_wat_lch_06 | death-reported / standard | 130:Out/132:Active |
| Cyberpsycho Sighting: Under the Bridge | ma_std_arr_06 | alive-reported / standard | 227:Out/283:In -> 283:Out/226:Active |
| Cyberpsycho Sighting: Under the Bridge | ma_std_arr_06 | death-reported / standard | 259:Out/258:Active |
| Cyberpsycho Sighting: Where the Bodies Hit the Floor | ma_wat_nid_03 | alive-reported / standard | 117:Out/116:Active |
| Cyberpsycho Sighting: Where the Bodies Hit the Floor | ma_wat_nid_03 | death-reported / standard | 146:Out/145:Active |

Bare node IDs in this table are shorthand only. The pack's resource path and full node/graph pointer identify the actual node, including embedded phases.

## Additional written debrief outcomes

These rules cover 11 gigs across all five fixers. Written debrief variants are explicit alternatives, not an assumption that all completion calls have identical disclosure.

| Quest | Outcome | Additional objectives | Written variants |
| --- | --- | --- | --- |
| concrete-cage-trap | rescued | all: escort_mike | 2 |
| hippocratic-oath | rescued | all: escort_to_car | 1 |
| freedom-of-the-press | rescued | any: escort_max, max_trunk | 2 |
| occupational-hazard | rescued | all: talk | 2 |
| wakakos-favorite | stabilized | all: put_in, talk1 | 1 |
| we-have-your-wife | rescued | all: rescue_bill1 | 1 |
| cuckoos-nest | rescued | all: get_to_the_car | 2 |
| going-away-party | rescued | all: meet_nomad_contact | 1 |
| bring-me-the-head-of-gustavo-orta | suicide-reported | Outcome-specific SMS | 1 |
| olive-branch | freed | all: free_alex | 1 |
| an-inconvenient-killer | agreed-to-leave | all: talk_jack | 1 |

A peer-review correction narrowed Concrete Cage Trap and Cuckoo's Nest to rescue/arrival and the fixer's acknowledgement. Their alternative SMS explicitly permits the rescued person to reach transport without V escorting every step. A succeeded escort objective therefore establishes the stage together with the debrief, not V's physical performance of the title action. Hippocratic Oath likewise describes Lucy reaching safety and leaves the patient's treatment unresolved.

Other limits are deliberate: Max Jones may be transported unconscious, so safety does not imply voluntary travel; Hal's rescue says nothing about whether Anna was killed; Chang Hoon Nam's post-shard responsiveness does not establish a permanent cure; Padre's report about Gustavo is a reported suicide rather than V witnessing it or killing him; Wakako's acceptance of Alex's release says nothing about Alex's or Sergei's later fate; and Dino accepting Jack's promise to leave does not establish his future location or death.

## Release provenance and remaining native work

The release declaration points from the inspected `cyberpunk2077.gamedef` to `base\quest\cyberpunk2077.quest`. The structural reference closure connects the cited phases to this released root. A resource reference establishes release membership, not execution of every graph node. Conditions, real socket activation flow and positive current-save journal observations determine the usable branch. `CutSource`/`CutDestination` is never followed as ordinary execution flow.

Installed English localization is cited through its winning archive entry and exact JSON pointer. Scene `db_db` payloads are not treated as deployed English. The five exported rescue-debrief scenes are available for further work, but their mere extraction adds no executable coverage.

Exact gaps:

1. Answered holocalls with no equivalent written debrief remain unknown for the 11 gig rules, even if V heard a semantically similar result. A future rule needs exact reached scene/variant plus the fixer's disclosure, not only the completed quest.
2. Direct current victim-state and evidence-examination outcomes for all 17 cyberpsycho cases remain unmapped. The report rule records what reached Regina; it is not a second independent physical-state rule.
3. The 227 exact narrative outcomes listed below have no reviewed executable rule in this lane. The research catalog retains `runtime.status: unmapped`; the separate native pack supplies only the explicitly linked outcomes.
4. Native capture is not yet qualified in a live save. Selected-choice visited state, retired-group ancestry and received-message visibility must pass that independent gate before claiming installed end-to-end memory support.
5. Persistent individual resident identity and repeatable contract instance identity remain unresolved. A generic resident profile or shared vehicle-delivery quest key cannot become a personal or per-delivery ledger.

## Exact unmapped outcome inventory

Each row uses the catalog's exact decision ID and missing outcome keys. This list is the set difference between the 272 researched outcomes and the 45 linked reviewed outcomes; it does not imply those outcomes are impossible, false or observed in the loaded save.

### Regina gigs

| Quest | Decision ID | Unmapped outcomes |
| --- | --- | --- |
| Hippocratic Oath | `fixers.hippocratic-oath.patient` | `assisted`, `left-treatment` |
| Many Ways to Skin a Cat | `fixers.many-ways-to-skin-a-cat.handover` | `delivered` |
| Monster Hunt | `fixers.monster-hunt.target` | `killed`, `delivered-alive` |
| Playing for Keeps | `fixers.playing-for-keeps.recovery-method` | `blackmail`, `taken` |
| Playing for Keeps | `fixers.playing-for-keeps.handover` | `returned` |
| Rite of Passage | `fixers.rite-of-passage.data` | `acquired` |
| Dirty Biz | `fixers.dirty-biz.recording` | `returned` |
| Dirty Biz | `fixers.dirty-biz.gottfrid` | `alive`, `killed` |
| Dirty Biz | `fixers.dirty-biz.fredrik` | `alive`, `killed` |
| Troublesome Neighbors | `fixers.troublesome-neighbors.target` | `killed`, `delivered-alive` |
| Welcome to America, Comrade | `fixers.welcome-to-america-comrade.tracker` | `installed` |
| Welcome to America, Comrade | `fixers.welcome-to-america-comrade.discretion` | `undetected`, `detected` |
| Backs Against the Wall | `fixers.backs-against-the-wall.encounter` | `deescalated`, `neutralized` |
| Backs Against the Wall | `fixers.backs-against-the-wall.handover` | `returned` |
| Catch a Tyger's Toe | `fixers.catch-a-tygers-toe.upload` | `uploaded` |
| Woman of La Mancha | `fixers.woman-of-la-mancha.anna` | `stood-down`, `nomad-exit`, `killed`, `incapacitated` |
| Flight of the Cheetah | `fixers.flight-of-the-cheetah.extraction` | `rescued` |
| Flight of the Cheetah | `fixers.flight-of-the-cheetah.transport-choice` | `his-car`, `other-transport` |
| Shark in the Water | `fixers.shark-in-the-water.target` | `killed`, `delivered-alive` |
| Last Login | `fixers.last-login.laptop` | `returned` |
| Last Login | `fixers.last-login.alois-evidence` | `body-identified` |
| Last Login | `fixers.last-login.charles` | `discount-accepted`, `bribe-refused` |
| Last Login | `fixers.last-login.charles-fate` | `neutralized` |
| Small Man, Big Evil | `fixers.small-man-big-evil.target` | `killed`, `delivered-alive` |
| Bloodsport | `fixers.bloodsport.extraction` | `rescued` |
| Bloodsport | `fixers.bloodsport.sponsor-disclosure` | `told`, `withheld` |
| Bloodsport | `fixers.bloodsport.stealth` | `undetected`, `detected` |
| Scrolls before Swine | `fixers.scrolls-before-swine.footage` | `viewed` |
| Scrolls before Swine | `fixers.scrolls-before-swine.aaron-resolution` | `delivered-unquestioned`, `blackmailed`, `exposed-without-demand`, `killed`, `incapacitated` |
| Freedom of the Press | `fixers.freedom-of-the-press.max` | `dead` |
| Lousy Kleppers | `fixers.lousy-kleppers.databank` | `returned` |
| Fixer, Merc, Soldier, Spy | `fixers.fixer-merc-soldier-spy.shard` | `secured` |
| Fixer, Merc, Soldier, Spy | `fixers.fixer-merc-soldier-spy.stealth` | `undetected`, `detected` |
| The Heisenberg Principle | `fixers.the-heisenberg-principle.method` | `physical-destruction`, `malware` |
| Occupational Hazard | `fixers.occupational-hazard.anna` | `incapacitated`, `killed` |

### Muamar gigs

| Quest | Decision ID | Unmapped outcomes |
| --- | --- | --- |
| Error 404 | `fixers.error-404.sabotage` | `uploaded` |
| Race to the Top | `fixers.race-to-the-top.data` | `acquired` |
| Serious Side Effects | `fixers.serious-side-effects.acid` | `returned` |
| Serious Side Effects | `fixers.serious-side-effects.booker-investigation` | `searched` |
| Breaking News | `fixers.breaking-news.tracker` | `installed` |
| Breaking News | `fixers.breaking-news.discretion` | `undetected`, `detected` |
| Family Matters | `fixers.family-matters.data` | `returned` |
| Family Matters | `fixers.family-matters.family-report` | `reported` |
| Family Matters | `fixers.family-matters.rose` | `incapacitated`, `killed` |
| Hacking the Hacker | `fixers.hacking-the-hacker.malware` | `uploaded` |
| Hacking the Hacker | `fixers.hacking-the-hacker.lucius` | `killed`, `not-killed` |
| Severance Package | `fixers.severance-package.data` | `returned` |
| Desperate Measures | `fixers.desperate-measures.truck` | `delivered` |
| Desperate Measures | `fixers.desperate-measures.pedro-disclosure` | `heard` |
| For My Son | `fixers.for-my-son.logans-fate` | `killed`, `delivered-alive` |

### Padre gigs

| Quest | Decision ID | Unmapped outcomes |
| --- | --- | --- |
| Fifth Column | `fixers.fifth-column.data` | `acquired` |
| Fifth Column | `fixers.fifth-column.ernesto-access` | `jackie-recognized` |
| Jeopardy | `fixers.jeopardy.shard` | `returned` |
| Life's Work | `fixers.lifes-work.vehicle` | `returned` |
| Life's Work | `fixers.lifes-work.gang-conflict` | `lethal-conflict`, `no-lethal-conflict` |
| On a Tight Leash | `fixers.on-a-tight-leash.jose` | `killed`, `delivered-alive` |
| On a Tight Leash | `fixers.on-a-tight-leash.conspiracy-report` | `truth-told`, `withheld` |
| Bring Me the Head of Gustavo Orta | `fixers.bring-me-the-head-of-gustavo-orta.gustavo` | `killed`, `delivered-alive`, `agreed-to-leave` |
| Old Friends | `fixers.old-friends.karubo` | `killed`, `delivered-alive` |
| Old Friends | `fixers.old-friends.alarm` | `undetected`, `detected` |
| Psychofan | `fixers.psychofan.guitar` | `returned` |
| Eye for an Eye | `fixers.eye-for-an-eye.bribe` | `accepted`, `refused` |
| Eye for an Eye | `fixers.eye-for-an-eye.albach` | `spared`, `killed`, `delivered-alive` |
| Sr. Ladrillo's Private Collection | `fixers.sr-ladrillos-private-collection.archive` | `acquired` |
| Sr. Ladrillo's Private Collection | `fixers.sr-ladrillos-private-collection.stealth` | `undetected`, `detected` |
| The Lord Giveth and Taketh Away | `fixers.the-lord-giveth-and-taketh-away.vehicle` | `returned` |
| Going Up or Down? | `fixers.going-up-or-down.method` | `persuaded`, `taken` |
| Going Up or Down? | `fixers.going-up-or-down.rods` | `returned` |

### Wakako gigs

| Quest | Decision ID | Unmapped outcomes |
| --- | --- | --- |
| Tyger and Vulture | `fixers.tyger-and-vulture.chip` | `returned` |
| Greed Never Pays | `fixers.greed-never-pays.device` | `returned` |
| Olive Branch | `fixers.olive-branch.alex` | `delivered` |
| Until Death Do Us Part | `fixers.until-death-do-us-part.receipts` | `returned` |
| Until Death Do Us Part | `fixers.until-death-do-us-part.stealth` | `undetected`, `detected` |
| Getting Warmer... | `fixers.getting-warmer.bugbear` | `rescued`, `dead` |
| A Shrine Defiled | `fixers.a-shrine-defiled.surveillance` | `installed` |
| A Shrine Defiled | `fixers.a-shrine-defiled.stealth` | `undetected`, `detected` |

### Dino gigs

| Quest | Decision ID | Unmapped outcomes |
| --- | --- | --- |
| A Lack of Empathy | `fixers.a-lack-of-empathy.virus` | `uploaded` |
| A Lack of Empathy | `fixers.a-lack-of-empathy.combat` | `avoided`, `occurred` |
| An Inconvenient Killer | `fixers.an-inconvenient-killer.jack` | `killed`, `delivered-alive` |
| An Inconvenient Killer | `fixers.an-inconvenient-killer.combat` | `avoided`, `occurred` |
| Guinea Pigs | `fixers.guinea-pigs.koch` | `killed`, `delivered-alive` |
| Guinea Pigs | `fixers.guinea-pigs.computer-request` | `allowed`, `refused` |
| Serial Suicide | `fixers.serial-suicide.recording` | `recovered` |
| The Frolics of Councilwoman Cole | `fixers.the-frolics-of-councilwoman-cole.recording` | `acquired` |
| The Frolics of Councilwoman Cole | `fixers.the-frolics-of-councilwoman-cole.stealth` | `undetected`, `detected` |

### Cyberpsycho direct-state and evidence outcomes

| Quest | Decision ID | Unmapped outcomes |
| --- | --- | --- |
| Cyberpsycho Sighting: Bloody Ritual | `fixers.cyberpsycho-sighting-bloody-ritual.neutralization` | `alive`, `dead` |
| Cyberpsycho Sighting: Bloody Ritual | `fixers.cyberpsycho-sighting-bloody-ritual.evidence` | `examined` |
| Cyberpsycho Sighting: Demons of War | `fixers.cyberpsycho-sighting-demons-of-war.neutralization` | `alive`, `dead` |
| Cyberpsycho Sighting: Demons of War | `fixers.cyberpsycho-sighting-demons-of-war.evidence` | `examined` |
| Cyberpsycho Sighting: Lt. Mower | `fixers.cyberpsycho-sighting-lt-mower.neutralization` | `alive`, `dead` |
| Cyberpsycho Sighting: Lt. Mower | `fixers.cyberpsycho-sighting-lt-mower.evidence` | `examined` |
| Cyberpsycho Sighting: Six Feet Under | `fixers.cyberpsycho-sighting-six-feet-under.neutralization` | `alive`, `dead` |
| Cyberpsycho Sighting: Six Feet Under | `fixers.cyberpsycho-sighting-six-feet-under.evidence` | `examined` |
| Cyberpsycho Sighting: Ticket to the Major Leagues | `fixers.cyberpsycho-sighting-ticket-to-the-major-leagues.neutralization` | `alive`, `dead` |
| Cyberpsycho Sighting: Ticket to the Major Leagues | `fixers.cyberpsycho-sighting-ticket-to-the-major-leagues.evidence` | `examined` |
| Cyberpsycho Sighting: Where the Bodies Hit the Floor | `fixers.cyberpsycho-sighting-where-the-bodies-hit-the-floor.neutralization` | `alive`, `dead` |
| Cyberpsycho Sighting: Where the Bodies Hit the Floor | `fixers.cyberpsycho-sighting-where-the-bodies-hit-the-floor.evidence` | `examined` |
| Cyberpsycho Sighting: On Deaf Ears | `fixers.cyberpsycho-sighting-on-deaf-ears.neutralization` | `alive`, `dead` |
| Cyberpsycho Sighting: On Deaf Ears | `fixers.cyberpsycho-sighting-on-deaf-ears.evidence` | `examined` |
| Cyberpsycho Sighting: Phantom of Night City | `fixers.cyberpsycho-sighting-phantom-of-night-city.neutralization` | `alive`, `dead` |
| Cyberpsycho Sighting: Phantom of Night City | `fixers.cyberpsycho-sighting-phantom-of-night-city.evidence` | `examined` |
| Cyberpsycho Sighting: Letter of the Law | `fixers.cyberpsycho-sighting-letter-of-the-law.neutralization` | `alive`, `dead` |
| Cyberpsycho Sighting: Letter of the Law | `fixers.cyberpsycho-sighting-letter-of-the-law.evidence` | `examined` |
| Cyberpsycho Sighting: Seaside Cafe | `fixers.cyberpsycho-sighting-seaside-cafe.neutralization` | `alive`, `dead` |
| Cyberpsycho Sighting: Seaside Cafe | `fixers.cyberpsycho-sighting-seaside-cafe.evidence` | `examined` |
| Cyberpsycho Sighting: Smoke on the Water | `fixers.cyberpsycho-sighting-smoke-on-the-water.neutralization` | `alive`, `dead` |
| Cyberpsycho Sighting: Smoke on the Water | `fixers.cyberpsycho-sighting-smoke-on-the-water.evidence` | `examined` |
| Cyberpsycho Sighting: Lex Talionis | `fixers.cyberpsycho-sighting-lex-talionis.neutralization` | `alive`, `dead` |
| Cyberpsycho Sighting: Lex Talionis | `fixers.cyberpsycho-sighting-lex-talionis.evidence` | `examined` |
| Cyberpsycho Sighting: Under the Bridge | `fixers.cyberpsycho-sighting-under-the-bridge.neutralization` | `alive`, `dead` |
| Cyberpsycho Sighting: Under the Bridge | `fixers.cyberpsycho-sighting-under-the-bridge.evidence` | `examined` |
| Cyberpsycho Sighting: Discount Doc | `fixers.cyberpsycho-sighting-discount-doc.neutralization` | `alive`, `dead` |
| Cyberpsycho Sighting: Discount Doc | `fixers.cyberpsycho-sighting-discount-doc.evidence` | `examined` |
| Cyberpsycho Sighting: The Wasteland | `fixers.cyberpsycho-sighting-the-wasteland.neutralization` | `alive`, `dead` |
| Cyberpsycho Sighting: The Wasteland | `fixers.cyberpsycho-sighting-the-wasteland.evidence` | `examined` |
| Cyberpsycho Sighting: House on a Hill | `fixers.cyberpsycho-sighting-house-on-a-hill.neutralization` | `alive`, `dead` |
| Cyberpsycho Sighting: House on a Hill | `fixers.cyberpsycho-sighting-house-on-a-hill.evidence` | `examined` |
| Cyberpsycho Sighting: Second Chances | `fixers.cyberpsycho-sighting-second-chances.neutralization` | `alive`, `dead` |
| Cyberpsycho Sighting: Second Chances | `fixers.cyberpsycho-sighting-second-chances.evidence` | `examined` |

### Other jobs and repeatable activities

| Quest | Decision ID | Unmapped outcomes |
| --- | --- | --- |
| Last Call | `fixers.last-call.offer` | `offered` |
| Last Call | `fixers.last-call.collection` | `collected` |
| Ride Captain Ride | `fixers.ride-captain-ride.offer` | `offered` |
| Ride Captain Ride | `fixers.ride-captain-ride.collection` | `collected` |
| God Bless This Mess | `fixers.god-bless-this-mess.offer` | `offered` |
| God Bless This Mess | `fixers.god-bless-this-mess.collection` | `collected` |
| Professional Widow | `fixers.professional-widow.offer` | `offered` |
| Professional Widow | `fixers.professional-widow.collection` | `collected` |
| Gas Gas Gas | `fixers.gas-gas-gas.offer` | `offered` |
| Gas Gas Gas | `fixers.gas-gas-gas.collection` | `collected` |
| Psycho Killer | `fixers.psycho-killer.reports` | `all-reported` |
| Psycho Killer | `fixers.psycho-killer.survival` | `all-alive`, `some-deaths` |
| Machine Gun | `fixers.machine-gun.custody` | `returned`, `retained` |
| Machine Gun | `fixers.machine-gun.diagnostic` | `daisy-reset`, `further-test` |
| Machine Gun | `fixers.machine-gun.later-offer` | `no-ai-offered` |
| Push It to the Limit | `fixers.push-it-to-the-limit.business` | `introduced` |
| Just Another Story | `fixers.just-another-story.delivery` | `delivered` |
| Just Another Story | `fixers.just-another-story.deadline` | `met`, `missed` |
| Just Another Story | `fixers.just-another-story.condition` | `met`, `missed` |
| Baby Let Me Take You | `fixers.baby-let-me-take-you.ayden` | `saved`, `left-behind-dead` |
| Baby Let Me Take You | `fixers.baby-let-me-take-you.cargo` | `delivered`, `destroyed` |
| Baby Let Me Take You | `fixers.baby-let-me-take-you.motive` | `shared` |
| Over the Edge | `fixers.over-the-edge.falco` | `replied` |
| Over the Edge | `fixers.over-the-edge.gift` | `collected` |
| Shape of a Pony | `fixers.shape-of-a-pony.report` | `recovered-reported` |
| Shape of a Pony | `fixers.shape-of-a-pony.refund` | `paid` |
| The Rescue | `fixers.the-rescue.client-report` | `alive-reported` |
| The Gig | `fixers.the-gig.payment` | `paid` |
| The Gig | `fixers.the-gig.reward` | `collected` |
| Down on the Street | `fixers.down-on-the-street.parade-intel` | `provided` |
| Sinnerman | `fixers.sinnerman.contract` | `joshua-killed`, `continued-with-joshua`, `pursuit-failed` |
| The Streetkid | `fixers.the-streetkid.acquaintance` | `ride-shared` |
| Heroes | `fixers.heroes.attendance` | `attended` |

## Authorized dossier correction

The static cross-review found that Muamar's prior Falco association and keepsake arrangement were implied before Over the Edge. The baseline now leaves that prior association unestablished. The exchange and jacket collection use separate exact conditional outcomes, and the unconditional private-knowledge entry was removed. This correction does not add native coverage for either outcome. UTF-8 accent spelling was restored and checked after the edit.
