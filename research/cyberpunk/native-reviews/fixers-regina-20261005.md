# Regina Jones lane (fr5) — native outcome mapping

Reviewed 2026-10-05 against installed Cyberpunk 2077 2.31 assets. Rules: `research/cyberpunk/native-rules/fixers-regina-20261005.json`
(87 rules, prefix `fr5`), written by the rerunnable author script `KIT/lanes/fixers-regina-author.mjs`. Evidence is hash-bound to
scene-evidence batches `fr5-01` (10 scenes), `fr5-02` (23 questphases), `fr5-03` (Bloody Ritual investigation scene) and the
already-bound cyberpsycho case phases. `check-lane` passes with 0 merge, evidence, or topic errors and 0 contradictions.

## Method

- **Gig outcomes.** Regina is the contracting fixer. A rule requires the gig quest `succeeded` plus either the objective that
  completes the deliverable (traced to the graph node that sets it `Succeeded`) or Regina's outcome-specific debrief SMS. Those
  SMS entries are fallbacks that fire only when the holocall is rejected or the phone is muted, so they are usually absent. Where the
  phase writes a branch fact that the debrief itself reads (`sts_wat_kab_101_kill`, `sts_wat_kab_06_target_unconscious`, `kab_102_perfect`, ...),
  that fact is added as an alternative.
- **Kill vs alive targets.** The kill branches of Monster Hunt, Shark in the Water, Small Man Big Evil and Troublesome Neighbors
  start from `killed=1 defeated=1 unconscious=0`. That is not proof of death, so those statements say Regina *closed the gig as a
  kill / treated the target as dead*. The delivered-alive rules use the delivery objective or post-delivery facts: trunk check,
  fixer car leaving, then the unconscious debrief.
- **Cyberpsycho physical state.** In all 17 cases, the `send_info` step routes the report through a *true-death* check
  (`character killed=1 defeated=0 unconscious=0`). Three cases use `<case>_psycho_killed`, which is itself written only on that check.
  True routes to the lethal report choice and reply. False routes to the alive report choice and reply. A later kill deactivates the
  pending alive choice. So the selected report plus Regina's reply records whether the cyberpsycho was dead when V reported. The
  `neutralization` rules reuse the existing `fixers.ma-*` choice and reply selectors by key, and they cite the routing node. They are
  priority 3 because they overlap with the existing priority-7 report rules. Each `evidence/examined` rule requires the case's required
  "Search the area to collect information." objective to be `succeeded` and either reply to be received. These are priority 2.
- **Psycho Killer survival** combines the 17 per-case report conditions. `all-alive` needs all 17 alive reports (AND).
  `some-deaths` needs any death report (OR). Both are split into two sub-groups to respect the 16-child limit.
- No `told-by-v` rules. All speakers are `regina-jones` on private/phone channels.

## Outcome table

| decision | outcome | result |
| --- | --- | --- |
| hippocratic-oath.patient | assisted | UNMAPPED: told-by-v. `blood_inject` succeeded is V-side. Regina's debrief ("Lucy's safe") says nothing about the patient. |
| hippocratic-oath.patient | left-treatment | UNMAPPED: told-by-v. The optional blood objective failing is V-side, and no Regina record covers it. |
| many-ways-to-skin-a-cat.handover | delivered | MAPPED `fr5.many-ways-to-skin-a-cat.delivered`: quest S + (`convey` S [delivery_status=2 at drop, no combat/wanted] or success SMS). Speaker: Regina. |
| monster-hunt.target | killed | MAPPED `fr5.monster-hunt.killed`: quest S + (kill SMS or `kab_07_jotaro_killed`≥1 [killed/defeated, not unconscious]). Wording: "closed as a kill". |
| monster-hunt.target | delivered-alive | MAPPED `fr5.monster-hunt.delivered-alive`: quest S + (`deliver_jotaro` S or subdue SMS). |
| playing-for-keeps.recovery-method | blackmail | UNMAPPED: told-by-v. The optional `blackmaill` objective is V-side, and the debrief does not record the method. |
| playing-for-keeps.recovery-method | taken | UNMAPPED: told-by-v. Same as blackmail. |
| playing-for-keeps.handover | returned | MAPPED `fr5.playing-for-keeps.returned`: quest S + (`exit` "Deposit the implant" S or perfect SMS). The `holoacll_debrief_notperfect` entry has no activator in 2.31. |
| rite-of-passage.data | acquired | MAPPED `fr5.rite-of-passage.acquired`: quest S + (`steal_recording` S or "Data received" / "Got the data" SMS). |
| dirty-biz.recording | returned | MAPPED `fr5.dirty-biz.returned`: quest S + (`get_to_droppoint` S or success SMS). |
| dirty-biz.gottfrid | alive | UNMAPPED: no-native-signal / told-by-v. There is no per-character state fact, only alert flags, and the debrief is silent. |
| dirty-biz.gottfrid | killed | UNMAPPED: no-native-signal / told-by-v. Same. |
| dirty-biz.fredrik | alive | UNMAPPED: no-native-signal / told-by-v. Same. |
| dirty-biz.fredrik | killed | UNMAPPED: no-native-signal / told-by-v. Same. |
| troublesome-neighbors.target | killed | MAPPED `fr5.troublesome-neighbors.killed`: quest S + (`sts_wat_kab_107_kill`≥1 or kill SMS). Kill/defeat caveat. |
| troublesome-neighbors.target | delivered-alive | MAPPED `fr5.troublesome-neighbors.delivered-alive`: quest S + (`deliver` S [trunk] or unconscious SMS). |
| welcome-to-america-comrade.tracker | installed | MAPPED `fr5.welcome-to-america-comrade.installed`: quest S + `plant_tracker` S. |
| welcome-to-america-comrade.discretion | undetected | MAPPED `fr5.welcome-to-america-comrade.undetected`: quest S + (`sts_wat_kab_102_perfect`≥1, perfect SMS, or the "Quiet and smooth" bonus SMS). |
| welcome-to-america-comrade.discretion | detected | MAPPED `fr5.welcome-to-america-comrade.detected`: quest S + (`sts_wat_kab_102_not_perfect`≥1 [kab_102_combat>0] or not-perfect SMS). |
| backs-against-the-wall.encounter | deescalated | UNMAPPED: told-by-v. Hare's handling is V-side (`kab_03_peace` is zero-only), and the debrief is generic. |
| backs-against-the-wall.encounter | neutralized | UNMAPPED: told-by-v. Same. |
| backs-against-the-wall.handover | returned | MAPPED `fr5.backs-against-the-wall.returned`: quest S + (`retrieve` S or debrief SMS). |
| catch-a-tygers-toe.upload | uploaded | MAPPED `fr5.catch-a-tygers-toe.uploaded`: quest S + (`upload_software` S or debrief SMS). |
| woman-of-la-mancha.anna | stood-down | MAPPED `fr5.woman-of-la-mancha.stood-down`: quest S + scene fact `kab_08_hamill_plans_vengeance`≥1 (the post-persuasion branch, separate from the nomad route). The statement says only that she was persuaded, which is what Regina's debrief knows. |
| woman-of-la-mancha.anna | nomad-exit | UNMAPPED: told-by-v. `kab_08_hamill_becomes_nomad` exists, but Regina's persuaded debrief does not distinguish the nomad route, and Anna is not a roster character. |
| woman-of-la-mancha.anna | killed | UNMAPPED: shared-writer. `kab_08_anna_dead` and the kill debrief fire on killed OR defeated OR unconscious. |
| woman-of-la-mancha.anna | incapacitated | UNMAPPED: shared-writer. Same writer. No delivery objective activator was found. |
| flight-of-the-cheetah.extraction | rescued | MAPPED `fr5.flight-of-the-cheetah.rescued`: quest S + (`escort_haruo_to_nomad` S or perfect SMS). The not-perfect SMS has no activator in the cited phase. |
| flight-of-the-cheetah.transport-choice | his-car | UNMAPPED: told-by-v. Optional `go_to_car` is V-side, and Regina's debrief is silent. |
| flight-of-the-cheetah.transport-choice | other-transport | UNMAPPED: no-native-signal. Only the absence of `go_to_car` or an on-foot flag; no positive record. |
| shark-in-the-water.target | killed | MAPPED `fr5.shark-in-the-water.killed`: quest S + (`sts_wat_kab_06_target_killed`≥1 or kill SMS). Kill/defeat caveat. |
| shark-in-the-water.target | delivered-alive | MAPPED `fr5.shark-in-the-water.delivered-alive`: quest S + (`sts_wat_kab_06_target_unconscious`≥1 [written after the unconscious debrief] or unconscious SMS). |
| last-login.laptop | returned | MAPPED `fr5.last-login.returned`: quest S + (`deliver_shard` S or debrief SMS). |
| last-login.alois-evidence | body-identified | UNMAPPED: no-speaker. A V-only observation that Regina never records. |
| last-login.charles | discount-accepted | UNMAPPED: told-by-v. A scene choice with Charles; Regina has no record. |
| last-login.charles | bribe-refused | UNMAPPED: told-by-v. Same. |
| last-login.charles-fate | neutralized | UNMAPPED: no-speaker. `kab_05_ripperdoc_killed` exists, but no Regina record and no roster witness. |
| small-man-big-evil.target | killed | MAPPED `fr5.small-man-big-evil.killed`: quest S + (`sts_wat_kab_101_kill`≥1 or kill SMS). Kill/defeat caveat. |
| small-man-big-evil.target | delivered-alive | MAPPED `fr5.small-man-big-evil.delivered-alive`: quest S + (`sts_wat_kab_101_unconscious`≥1 [after trunk delivery] or unconscious SMS). |
| bloodsport.extraction | rescued | MAPPED `fr5.bloodsport.rescued`: quest S + (`escort_roh_to_car` S or the optional / non-optional debrief SMS). |
| bloodsport.sponsor-disclosure | told | UNMAPPED: told-by-v / no-speaker. The disclosure is to Roh (not on the roster), and Regina has no record. |
| bloodsport.sponsor-disclosure | withheld | UNMAPPED: told-by-v / no-speaker. Same. |
| bloodsport.stealth | undetected | MAPPED `fr5.bloodsport.undetected`: quest S + (`optional_alarm` S [set after Roh reaches the car with alarm≠1] or optional SMS). |
| bloodsport.stealth | detected | MAPPED `fr5.bloodsport.detected`: quest S + (`optional_alarm` F or non-optional SMS). |
| scrolls-before-swine.footage | viewed | UNMAPPED: told-by-v. `nid_07_recording_seen` is V-side. The V-to-Regina `debrief_answer_1` choice has no activator in 2.31. |
| scrolls-before-swine.aaron-resolution | delivered-unquestioned | UNMAPPED: ambiguous-meaning. Regina's "Aaron's happy" debrief fires for every non-hostile ending, including blackmail and confrontation. |
| scrolls-before-swine.aaron-resolution | blackmailed | UNMAPPED: told-by-v. Scene choice only; Regina's debrief is the same "happy" variant. |
| scrolls-before-swine.aaron-resolution | exposed-without-demand | UNMAPPED: told-by-v. Same. |
| scrolls-before-swine.aaron-resolution | killed | MAPPED `fr5.scrolls-before-swine.aaron-killed`: aaron-killed SMS, or `nid_07_aaron_dead`≥1 [killed=1 defeated=0 unconscious=0] + quest S. |
| scrolls-before-swine.aaron-resolution | incapacitated | MAPPED `fr5.scrolls-before-swine.aaron-incapacitated`: aaron-unconscious SMS only (hostile and not dead at debrief time). The `nid_07_aaron_unconscious` fact could later co-exist with a kill, so it is not used. |
| freedom-of-the-press.max | dead | UNMAPPED: ambiguous-meaning. The fail debriefs ("I know about Max. I know what happened" / "left him there") do not state death, and the failure routing has more than one cause. |
| lousy-kleppers.databank | returned | MAPPED `fr5.lousy-kleppers.returned`: quest S + (`deliver_files` S or "Thanks for the shard!" SMS). |
| fixer-merc-soldier-spy.shard | secured | MAPPED `fr5.fixer-merc-soldier-spy.secured`: quest S + `deliver` S. |
| fixer-merc-soldier-spy.stealth | undetected | MAPPED `fr5.fixer-merc-soldier-spy.undetected`: quest S + `do_not_trigger_combat` S. It is set only after delivery, from the no-combat debrief. |
| fixer-merc-soldier-spy.stealth | detected | MAPPED `fr5.fixer-merc-soldier-spy.detected`: quest S + (`do_not_trigger_combat` F [alarm devices] or combat SMS). |
| the-heisenberg-principle.method | physical-destruction | UNMAPPED: told-by-v. No method-specific record, and Regina's debrief is generic. |
| the-heisenberg-principle.method | malware | UNMAPPED: told-by-v. Same. |
| occupational-hazard.anna | incapacitated | UNMAPPED: shared-writer. `nid_01_psycho_dead` is written on killed OR defeated OR unconscious. |
| occupational-hazard.anna | killed | UNMAPPED: shared-writer. Same. |
| cyberpsycho-sighting-* (17 cases).neutralization | alive | MAPPED `fr5.<quest>.alive` (×17): existing alive report choice S + Regina reply, routed by the true-death check False branch. |
| cyberpsycho-sighting-* (17 cases).neutralization | dead | MAPPED `fr5.<quest>.dead` (×17): existing death report choice S + Regina reply, routed by the true-death check True branch (or `<case>_psycho_killed`). |
| cyberpsycho-sighting-* (17 cases).evidence | examined | MAPPED `fr5.<quest>.evidence` (×17): the required "Search the area to collect information." objective S + either Regina reply. Bloody Ritual's objective is driven inside its investigation scene. |
| last-call.offer | offered | MAPPED `fr5.last-call.offered`: Regina's farewell message `regina_global_msg/watson_reward` active/S ("gift waiting for you in your stash"). |
| last-call.collection | collected | UNMAPPED: no-speaker. `get_reward` succeeds when V takes the item from the stash; Regina has no record. |
| psycho-killer.reports | all-reported | MAPPED `fr5.psycho-killer.all-reported`: quest S + `01_help_regina` S + `02_talk_regina` S (activated after ow_psychos_done > 16). |
| psycho-killer.survival | all-alive | MAPPED `fr5.psycho-killer.all-alive`: all 17 alive report choice+reply pairs. |
| psycho-killer.survival | some-deaths | MAPPED `fr5.psycho-killer.some-deaths`: any of the 17 death report choice+reply pairs. |
| machine-gun.custody | returned | MAPPED `fr5.machine-gun.returned`: quest S + `01_deliver_skippy` S + `03_talk_to_regina` S. |
| machine-gun.custody | retained | UNMAPPED: told-by-v. The "No. I'm keeping you." choice only sets a transient expression fact, and Regina never receives Skippy. |
| machine-gun.diagnostic | daisy-reset | MAPPED `fr5.machine-gun.daisy-reset`: quest S + `03_talk_to_regina` S + scene fact `mq007_skippy_turned_pacifist`≥1 (scene 04 routes it to the pacifist / factory-reset diagnostic). |
| machine-gun.diagnostic | further-test | UNMAPPED: zero-only. The killer diagnostic needs `turned_pacifist` absent and `aim_at_head`≥1, which no quest asset writes positively. |
| machine-gun.later-offer | no-ai-offered | MAPPED `fr5.machine-gun.no-ai-offered`: Regina's SMS `mq007_giving_back_skippy/03_want_him_back` active/S (gated on mq007_done≥1). |

The 17 cyberpsycho cases in the three ×17 rows are: Bloody Ritual, Demons of War, Lt. Mower, Six Feet Under, Ticket to the Major Leagues,
Where the Bodies Hit the Floor, On Deaf Ears, Phantom of Night City, Letter of the Law, Seaside Cafe, Smoke on the Water, Lex Talionis,
Under the Bridge, Discount Doc, The Wasteland (both Saul variants), House on a Hill and Second Chances.

## Totals

87 mapped / 33 unmapped. Unmapped by category: told-by-v 18 (including the two Bloodsport sponsor rows, which are also
no-speaker), no-native-signal 5 (four Dirty Biz rows, also told-by-v, plus other-transport), shared-writer 4, no-speaker 3,
ambiguous-meaning 2, zero-only 1.

## Notes and residual risks

- If V sends an alive report and then kills the subject, the existing alive and death report rules could both become true, and so
  could the matching neutralization rules and Psycho Killer survival rules. The runtime suppresses the topic in that case; none of
  the 9 test saves shows it.
- Woman of La Mancha `stood-down` could co-exist with a later kill of Anna (an unlikely edge). That outcome is otherwise unmapped, so
  no contradiction can arise.
- The existing `fixers.md` review states that the report rules are not physical-state rules. This lane shows that the report
  variant is selected by a true-death check, which is why the neutralization rules are now mapped. The existing rules were not edited.
