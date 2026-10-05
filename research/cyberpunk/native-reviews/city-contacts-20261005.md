# City contacts (wave cc5, 2026-10-05): native outcome review

Lane file: `native-rules/city-contacts-20261005.json` (prefix `cc5`), written by `kit/lanes/city-contacts-author.mjs`.
Input: 63 unmapped outcomes from `lanes/city-contacts.json`. Result: **25 mapped, 38 unmapped**.

## Method

- Every predicate is a positive fact writer or journal state traced in an exported, hash-bound scene or questphase.
  New exports: `scene-evidence/cc5-01` (31 scenes) and `cc5-02` (`mq056_00_main.questphase`). Assets already hash-bound in
  other batches were cited in place: `sq017_10_us_crack_intro`, `mq019_06_finale`, `sts_ep1_08_client_ending`/`_phase`,
  `mq303.questphase`, `mq303_03_finale`, `q305_02d_chang`, and `sts_bls_ina_06_ow`.
- Scene journal nodes were read with their input-socket state: the `isockStamp.ordinal` indexes `isockMappings`, so
  ordinal 3 means Succeeded. Telemetry or "named" facts are used only when the writer sits on one choice option.
- Where one catalog topic holds cumulative stages (Nam's job), only one stage is mapped. Two true outcomes on one topic
  would suppress each other at runtime.
- Phone-message selectors need every ancestor revealed up to the contact. Steven Santos's contact is `inactive` in the
  saves, so his invitation message cannot be read. It was dropped from the drop-point rule.
- `check-lane city-contacts-20261005` (full): merge/runtime errors 0, evidence/topic errors 0, 88 verified pointers, topic
  contradictions 0.

## Rules that fire in save A (Corporate male)

`blue.stalker-left-to-police`, `coach.av-call`, `jim.invite-accepted`, `rachel.buyout-refused`, `rachel.crucifixion-performed`,
`rachel.joined-joshua`, `rachel.toolina-offer`, `shank.tool-sister`, `steven.biomonitor-drop-point`, `violence.liam-body-found`.
They are consistent with A's journal: 06c_jail S, coach call facts, Jim `01_yes` S, the drop-point objective S followed by
The Show Must Go On, `sq023_show_is_hit`, and the twin epilogue.

## Outcome table

| decision | outcome | disposition |
| --- | --- | --- |
| city-contacts.nam.maxtac-job | engaged | UNMAPPED: ambiguous-meaning. This is a cumulative stage of the same topic as departure-discussed, and both being true would suppress the topic. The recruitment is already covered for Reed and Songbird by `phantom.convoy-intel`. |
| city-contacts.nam.maxtac-job | data-delivered-injured | UNMAPPED: ambiguous-meaning. Same stage problem. The data handover and aphasia are folded into the `cc5.nam.skip-town` statement. |
| city-contacts.nam.maxtac-job | departure-discussed | MAPPED `cc5.nam.skip-town`. `q305_nomad_help>=1` (q305_02d_chang writer 199, reached only via "You gotta skip town." after [Take shard]). Speaker: chang-hoon-nam. |
| city-contacts.coach.intro-call | answered | MAPPED `cc5.coach.av-call`. `q000_corpo_03b_call_started>=1` (writer 653 after the coach holocall connects, which feeds section 123 "Hello, V."). Speaker: life-coach. |
| city-contacts.warmer.disconnection | fatal-disconnection | UNMAPPED: no-speaker. `rey_09_target_died` fires on any killed=1 of 8ug8ear (quest Failed), not specifically an unsafe unplug. The only speaker is dead. |
| city-contacts.nam.recovery | vendor-established | UNMAPPED: no-native-signal. No vendor-state fact or journal entry exists; only `jpn_05_nam_endings` (already mapped as recovered). |
| city-contacts.iris.vehicle | left-behind | MAPPED `cc5.iris.car-left`. `opt_get_iris_car` failed: condition 276 fails it when the car is not delivered at the Dakota meeting, and condition 45 fails it if the car is destroyed. Paired with `ina_06_iris_hired>=1`. Speakers: iris-tanner, dakota-smith. |
| city-contacts.jake.shop-violence | violent-approach | UNMAPPED: told-by-v. Jake was not present, and neither his messages nor Padre's debrief record the method. |
| city-contacts.jake.quadra-gift | alternate-acquisition | UNMAPPED: told-by-v. The Muamar `vehicle_info` route exists, but Jake is "out of the picture" and receives no record. |
| city-contacts.blue.band-resolution | reconciled | MAPPED `cc5.blue.band-reconciled`. `sq017_selfie>=1` (sq017_10 writer 547 after reconciliation section 122, in which blue_moon speaks). Speaker: blue-moon. Kerry is already covered on topic `kerry.uscracks.resolution`. |
| city-contacts.blue.band-resolution | coerced | MAPPED `cc5.blue.band-coerced`. `sq017_us_cracks_no_deal>=1` (writer 378 after coercion section 362, Blue Moon: "Cancel the show"). Speaker: blue-moon. |
| city-contacts.blue.stalker-identification | griselda-confirmed | UNMAPPED: told-by-v. No marker shows Blue Moon learning the legal name or the Green Cloud alias. |
| city-contacts.blue.stalker-identification | wrong-person-reported | UNMAPPED: told-by-v. No playable accusation receipt. |
| city-contacts.blue.protection | killed-on-route | UNMAPPED: no-speaker. Blue Moon is dead. Root quest Failed is shared with defeated/unconscious outcomes. |
| city-contacts.blue.protection | later-death-reported | UNMAPPED: no-speaker. Blue Moon is dead. |
| city-contacts.blue.protection | operation-abandoned | UNMAPPED: shared-writer. Root mq028 Failed is set both by the leave-area trigger and by Blue_Moon killed/defeated/unconscious. |
| city-contacts.blue.stalker-disposition | nonlethal | MAPPED `cc5.blue.stalker-left-to-police`. Journal `06c_jail` succeeded (node 426 from choice 399 "Maybe we'd better leave it to the badges"). A later kill resets it to Inactive (node 423). Speaker: blue-moon. |
| city-contacts.blue.stalker-disposition | lethal | MAPPED `cc5.blue.stalker-killed`. Journal `06b_kill` succeeded (node 420, reached only via condition 397: stalker killed=1 defeated=0 unconscious=0 during the decision). Speaker: blue-moon. |
| city-contacts.violence.evidence | copy-plot-heard | UNMAPPED: shared-writer. `mq019_full_story` is set by Liam's own explanation (=1) and by the camera eavesdrop (+=1), so it cannot show whether Liam knew. Lizzy learns only via the recording, which is already mapped. |
| city-contacts.violence.evidence | affair-assumed | UNMAPPED: no-native-signal. The only marker would be an absence. |
| city-contacts.violence.bribe | not-accepted | UNMAPPED: no-native-signal. "No way." reaches only `03a_confront_liam` Succeeded, which other options share. |
| city-contacts.violence.motel-death | body-discovered | MAPPED `cc5.violence.liam-body-found`. Journal `06_finale/02_go_to_notell` succeeded (scene node 19 at entry; the conversation over Liam's body follows). Speaker: lizzy-wizzy. |
| city-contacts.violence.disposal | help-refused | UNMAPPED: no-native-signal. Refusal ends through scene out_failed, which sets the quest Succeeded. Only the absence of `04_move_body` distinguishes it. |
| city-contacts.violence.public-bd | broadcast-observed | UNMAPPED: no-native-signal. No viewing receipt. |
| city-contacts.lizzy.black-sapphire | cordial | UNMAPPED: no-native-signal. q303 holds only Lizzy concert facts, and no ep1 asset reads mq019 outcomes except the phone-contact restore. |
| city-contacts.lizzy.black-sapphire | rebuffed | UNMAPPED: no-native-signal. Same as cordial. |
| city-contacts.lizzy.black-sapphire | headgear-gift | UNMAPPED: no-native-signal. Same as cordial. |
| city-contacts.reno.transaction | paid-asking | UNMAPPED: shared-writer. The pay and negotiate branches both reach node 376 and then `05_reno_msg_stash`. |
| city-contacts.reno.transaction | negotiated-corpo | UNMAPPED: shared-writer. Same as paid-asking. |
| city-contacts.reno.transaction | coordinates-stolen | UNMAPPED: no-speaker. `02_restaurant/04_steal_data` succeeded is clean, but R3n0 is defeated (killed/defeated/unconscious) before the computer theft, so no living witness is verified. |
| city-contacts.reno.fate | incapacitated | UNMAPPED: ambiguous-meaning. The defeat condition is killed=1 defeated=1 unconscious=1. |
| city-contacts.reno.fate | dead | UNMAPPED: ambiguous-meaning. Same as incapacitated. |
| city-contacts.rachel.sinnerman-entry | joined | MAPPED `cc5.rachel.joined-joshua`. Journal `hook/14_join_joshua` succeeded (after-chase node 18, from "All right. I'll go with you."; Rachel is present). Speaker: rachel-casich. |
| city-contacts.rachel.sinnerman-entry | joshua-neutralized | MAPPED `cc5.rachel.joshua-neutralized`. Journal `hook/kill_joshua` succeeded (node 2428 via joshua killed=1 or the combat route after he is shot). The statement does not claim death. Speaker: rachel-casich (witnessed). |
| city-contacts.rachel.sinnerman-entry | left | UNMAPPED: no-native-signal. Refusal lines can be re-asked. `telem_hook_leave` covers one line only, and 14_join Failed comes from the attack branch. |
| city-contacts.rachel.buyout | accepted | MAPPED `cc5.rachel.buyout-accepted`. `sq023_v_takes_bribe` or `sq023_v_takes_corpo_bribe` (choice 655 options 1/2). Speaker: rachel-casich. |
| city-contacts.rachel.buyout | refused | MAPPED `cc5.rachel.buyout-refused`. `sq023_telem_no_bribe` (writer 5269 only from option 0 "No way."). Speaker: rachel-casich. |
| city-contacts.rachel.joshua-influence | supported | UNMAPPED: ambiguous-meaning. Cumulative doubt counters. |
| city-contacts.rachel.joshua-influence | challenged | UNMAPPED: ambiguous-meaning. Cumulative doubt counters. |
| city-contacts.rachel.final-participation | performed | MAPPED `cc5.rachel.crucifixion-performed`. `sq023_telem_bd_yes_nailing` plus `objectives/nail` succeeded (only after [Hammer nail]; quitting sets Failed). Speaker: rachel-casich. |
| city-contacts.rachel.final-participation | observed | MAPPED `cc5.rachel.crucifixion-observed`. `sq023_telem_bd_not_nailing` plus `objectives/participate` succeeded (857 False branch, v_nails=0). Speaker: rachel-casich. |
| city-contacts.rachel.final-participation | departed | MAPPED `cc5.rachel.crucifixion-departed`. `sq023_crucifixion_refused` (writer 597 only from "Not about to even watch."). Speaker: rachel-casich. |
| city-contacts.sergei.captive | delivered | UNMAPPED: told-by-v. Sergei receives no native record. Wakako's debrief belongs to the fixers-others lane topic `fixers.olive-branch.alex`. |
| city-contacts.sergei.captive | released | UNMAPPED: told-by-v. Same as delivered. |
| city-contacts.sergei.aftermath | sergei-body-found | UNMAPPED: no-speaker. Sergei is dead. |
| city-contacts.sergei.aftermath | alex-body-found | UNMAPPED: no-speaker. Sergei is not present at the discovery. |
| city-contacts.jim.race-access | invited | MAPPED `cc5.jim.invite-declined`. Phone choice `02_response/02_no` succeeded: the invitation was received and declined. This keeps it exclusive with accepted. Speaker: jim-jarry. |
| city-contacts.jim.race-access | accepted | MAPPED `cc5.jim.invite-accepted`. Phone choice `02_response/01_yes` succeeded (pause 7 then sends 03_answer_yes). Speaker: jim-jarry. |
| city-contacts.jim.race-result | won | UNMAPPED: ambiguous-meaning. Repeatable races with no run identity; "Finish the race" is not a placing. |
| city-contacts.jim.race-result | completed-other-place | UNMAPPED: ambiguous-meaning. Same as won. |
| city-contacts.bana.identity-reveal | katya-revealed | UNMAPPED: no-speaker. Bana is dead and Steven is absent from the target meeting. Ana is already covered by `jr-native.ana-heard-revelation`. |
| city-contacts.bana.katya-fate | spared | UNMAPPED: no-speaker. Bana is dead. Ana's version sits in the judy-river lane. |
| city-contacts.bana.katya-fate | killed | UNMAPPED: no-speaker. Same as spared. |
| city-contacts.bana.evidence | given-ana | MAPPED `cc5.steven.biomonitor-to-ana`. `sts_ep1_08_biomonitor_ana` (client_ending writers 652/649, in the final meeting where Steven speaks). Speaker: steven-santos. Ana is covered on `ana.bana_evidence`. |
| city-contacts.bana.evidence | destroyed | MAPPED `cc5.steven.biomonitor-destroyed`. `sts_ep1_08_biomonitor_destroyed` (writer 741, "[Destroy the biomonitor]") plus `final_meeting/talk_with_the_agent` succeeded (node 516). The drop-point route never reaches the meeting. Speaker: steven-santos. |
| city-contacts.bana.evidence | drop-point | MAPPED `cc5.steven.biomonitor-drop-point`. Journal `final_meeting/leave_biomonitor_droppoint` succeeded (phase: after Steven's "LEAVE THE BIOMON AT THE DROP POINT" message). Speaker: steven-santos (private). |
| city-contacts.bana.aftermath-report | steven-report | UNMAPPED: ambiguous-meaning. The only later Steven meeting (The Show Must Go On) is invited on the destroyed/drop route, not after exposure. Steven's contact is inactive, so his messages cannot be read. |
| city-contacts.shank.tool-treatment | letter-recovery | MAPPED `cc5.shank.tool-letter`. `mq303_finale_shock` (choice 2033 option 2). Speaker: shank. |
| city-contacts.shank.tool-treatment | sister-performance | MAPPED `cc5.shank.tool-sister`. `mq303_finale_sisters` (option 0). Speaker: shank. |
| city-contacts.shank.tool-treatment | clone-performance | MAPPED `cc5.shank.tool-clone`. `mq303_finale_cia` (option 1). Speaker: shank. |
| city-contacts.shank.rachel-contact | offer-received | MAPPED `cc5.rachel.toolina-offer`. Message `contacts/rachel/mq303_reference/01_start` active (gated on sq023_show_is_hit). Speaker: rachel-casich (private). |
| city-contacts.shank.rachel-contact | hostile-contact | MAPPED `cc5.rachel.toolina-hostile`. Message `01_start_bad` active (gated on sq023_show_is_shit). Speaker: rachel-casich (private). |
| city-contacts.jake.recognition | recognized-later | UNMAPPED: told-by-v. Jake is not present at Stadium Love. |

Unmapped by category: told-by-v 7, no-speaker 9, shared-writer 4, no-native-signal 9, ambiguous-meaning 9.

## Notes on existing rules and catalog

- The catalog duplicates several events across topics:
  - `city-contacts.blue.band-resolution` and `silverhand.backstage-resolution`. This lane gives only Blue Moon the city topic, using the same writers as silverhand.
  - `city-contacts.bana.evidence` and `judy-river.spy.biomonitor`. Steven gets the city topic here; Ana stays with judy-river.
  - `city-contacts.sergei.captive` and `fixers.olive-branch.alex`.

  A future topic merge should keep these speaker splits.
- `sts_ep1_08_biomonitor_destroyed` is written both at the drop point (phase) and in the meeting (scene). Any rule using it
  alone cannot distinguish the two outcomes.
- Phone messages under contacts that are `inactive` in saves (Steven Santos) never resolve offline. Rules depending on such
  messages are silently unknown.
