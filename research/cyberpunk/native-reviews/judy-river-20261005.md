# judy-river lane review (jr5, 2026-10-05)

Rules file: `research/cyberpunk/native-rules/judy-river-20261005.json` (author script: scratchpad `kit/lanes/judy-river-author.mjs`). Outcomes: 79; mapped 29; unmapped 50 (ambiguous-meaning 8, no-native-signal 17, no-speaker 2, out-of-scope 1, shared-writer 4, told-by-v 11, zero-only 7).

## Method

Each predicate is a positive writer (fact >= 1 from a `questSetVar` > 0, or a scene/phase journal state) traced upstream in the exported graphs, with the decisive choice/condition nodes cited as evidence. Branch exclusivity was checked with forward-reachability and block tests (for example: blocking section 71 makes the Elizabeth confession exit unreachable; blocking sections 700/703 makes the Judy holocall flag unreachable; the guess choice 502 is unreachable once `sq021_v_knows_farm` is set). Scene-only facts are invisible to `q.mjs` (always `-`), but the offline save snapshot does read them once they are allowlisted, so truth tables use real save values. Phone choices whose group is retired are not observable (the group goes inactive after a choice), so where a choice drives a reply message the reply is used as the predicate (Claire's 02c). Temperance partner texts live under contacts that the ending removes (E3 shows the contacts inactive), so they are proven through the partner-romance fact plus the reached ending rather than the message entries. Nothing here relies on a zero, absence or `ne`.

Progression outcomes on one exclusive topic (Sandra intel/favor stages) are mapped only at their terminal state, since mapping the earlier stage as well would make two outcomes of one topic true together.

## Save A (current 2.31 save) firing rules

jr5.beast.accept.accepted, jr5.big.route.pursuit, jr5.dream.election.elected, jr5.dream.elizabeth-private.confided, jr5.hunt.harris-afterward.vowed (River: "count me out"), jr5.hunt.location.edgewood-deduced, jr5.law.client-report.holt-blamed, jr5.law.coverup.han-exposed, jr5.spy.biomonitor.destroyed. The E0-E4 saves agree with A on all of these. Zero contradictions on the 9 truth saves.

## Observations on existing rules (not edited)

- `jr-native.claire-race-first-promise` (fact `sq024_claire_spares_sampson`) DOES fire in save C (C:T in the check-lane truth table; the snapshot reads the fact as 1). It shows `-` in `q.mjs` only because the fact is written inside scene sq024_02b (node 285, immediately before node 161 which sets the phase-visible `sq024_continue_but_wont_kill_sampson`), and `q.mjs` cannot see scene-only facts. So the premise that it does not fire in C is a display artifact, not a rule defect.
- `priority-endings.judy.sun-goodbye` uses `q203_fact_lover_says_goodbye`, which is incremented by every partner branch of the penthouse phase (Sobchak, Judy, Kerry, Panam) plus a top-level node (value 2 in E0/E1). It is true in E0 although the penthouse journal there shows Panam as the partner. This looks like a false positive for Judy and deserves a partner-specific predicate.
- `jr-native.hunt-randy-saved`, `jr-native.pisces-*` and the River committed rule were not touched; `sq029_river_lover` is a scene-only fact (morning-after scene) and is absent from every save's phase data.

## Outcome table

| decision | outcome | result |
|---|---|---|
| nocturne.partner-call | river-called | MAPPED `jr5.nocturne.rooftop-river-call` (fact q115_river_romance_chosen >= 1 AND journal 02a1_call_river "Talk to River." succeeded (rooftop holocall completed); speakers river-ward; private) |
| star.partner | river-stays | MAPPED `jr5.star.river-stays` (journal temp_river/say_goodbye "Talk to River." succeeded (reachable only through River's "I'm stayin'. Got to."); speakers river-ward; private) |
| sun.partner | river-waits | UNMAPPED: ambiguous-meaning - River's "I'll be here, waitin' for you to come back" is one section (node 346) of several penthouse branches; no fact or journal write marks it, and talk_sobchak/lover_says_goodbye only prove the morning with River. |
| sun.claire-sendoff | met | MAPPED `jr5.sun.claire-sendoff.met` (journal q203 afterlife/drink "Talk to Claire." succeeded (V picked a toast at the bar); speakers claire-russell; participant) |
| devil.partner-call | river-offers-help | UNMAPPED: ambiguous-meaning - 04_talk_to_river succeeds after holo_v_calls_river_end_done on both the brush-off ("bad time, can't talk") and the offer-help calls; blocking the offer branch still reaches it. |
| temperance.partner-message | judy-worried | MAPPED `jr5.temperance.judy-worried` (fact q115_judy_romance_chosen >= 1 AND journal q204_reborn active|succeeded (Temperance sends Judy's text chain to the chosen partner); speakers judy-alvarez; private) |
| temperance.partner-message | river-searching | MAPPED `jr5.temperance.river-searching` (fact q115_river_romance_chosen >= 1 AND journal q204_reborn active|succeeded (River text chain); speakers river-ward; private) |
| tower.judy-call | heard | MAPPED `jr5.tower.judy-call.heard` (fact q307_call_judy_end >= 1 (scene node reachable only via Judy's "I'm in Pittsburgh... married" sections); speakers judy-alvarez; private) |
| tower.river-call | heard | MAPPED `jr5.tower.river-call.heard` (fact q307_call_river_end >= 1 (reachable only via River's Trauma Team confession section); speakers river-ward; private) |
| black-steel.sandra-contact | hired | UNMAPPED: ambiguous-meaning - A stage that is always true when intel-delivered is (same exclusive topic would contradict); no predicate separates "arranged but not yet delivered" without a zero test. |
| black-steel.sandra-contact | intel-delivered | MAPPED `jr5.steel.sandra-contact.intel-delivered` (journal send_reed_ambush_info_sandra active|succeeded (activated right after V takes Sandra's shard); speakers sandra-dorsett; private) |
| black-steel.sandra-favor | requested | UNMAPPED: ambiguous-meaning - q305_sandra_task_accepted (scene node 108) is true whenever the favor is later fulfilled; mapping both outcomes of the topic would contradict. Only the terminal state fulfilled-confirmed is mapped. |
| black-steel.sandra-favor | fulfilled-confirmed | MAPPED `jr5.steel.sandra-favor.fulfilled-confirmed` (Sandra's message q305_afterquest_happy_sandra active|succeeded (only when 02_sandra_ping succeeded); speakers sandra-dorsett; private) |
| information.introductions | evelyn-met | UNMAPPED: ambiguous-meaning - Same exclusive topic (heist.introductions) as the existing priority-judy.information-judy-met; both introductions are mandatory so both would be true in every save. |
| information.dex-offer | offered | UNMAPPED: out-of-scope - Semantic duplicate of arasaka-heist.evelyn-offer/heard, already mapped by the arasaka-heist lane (ah5.information.evelyn-offer: Evelyn_Cheat_Dex + quest guard); mapping it again would hand Evelyn the same fact twice. |
| information.dex-offer | disclosed-to-dex | UNMAPPED: told-by-v - Evelyn does not automatically learn that V told Dex; no disclosure receipts at runtime. |
| rescue.medical | found | UNMAPPED: no-speaker - Sandra was unconscious/jammed during the extraction; no first-person knowledge. Same exclusive topic (sandra.rescue) as existing jt.rescue.sandra.handed-to-trauma-team. |
| rescue.medical | handed-over | UNMAPPED: no-speaker - Same as found: Sandra has no first-person knowledge of her treatment, and the topic already has the Jackie rule on the same journal predicate (would contradict). |
| spy.katya | spared | UNMAPPED: told-by-v - Katya's fate is V's private resolution; Ana learns it only if told. |
| spy.katya | killed | UNMAPPED: told-by-v - Same; sts_ep1_08_katya_killed is a V-side fact and Ana is not present. |
| spy.biomonitor | destroyed | MAPPED `jr5.spy.biomonitor.destroyed` (fact sts_ep1_08_biomonitor_destroyed >= 1 (choice "[Destroy the biomonitor]" node 741); speakers ana-friedman; participant) |
| spy.biomonitor | drop-point | UNMAPPED: told-by-v - Steven's private drop-point request; Ana does not know V used it. |
| spy.late-disclosure | steven-report | UNMAPPED: told-by-v - Steven's later account is to V only. |
| automatic.woodman | killed-confirmed | UNMAPPED: told-by-v - Judy was not there; also q105_woodman_dead is written in q105_dollhouse and read by the Ex-Factor flow, so it is not an Automatic Love-specific death proof. |
| revolution.commitment | refused | UNMAPPED: no-native-signal - sq026_refused is also written in the Dollhouse (Ex-Factor) phase, and sq026_refused_hiromi is set then reset by sq026_judys; pizza quest completion also occurs on refusal. Pizza scenes are not exported. |
| revolution.relic-disclosure | explained | UNMAPPED: no-native-signal - judy_knows_johnny is written in the Revolution plan and again on the Pyramid pier (prior audit; the sq026_03/sq030 scenes are not exported), so it cannot separate an explanation from symptoms. |
| revolution.relic-disclosure | symptoms-only | UNMAPPED: zero-only - Defined by the absence of the explanation; no positive writer. |
| pisces.payment | refused | UNMAPPED: zero-only - Inverse of sq026_13_maiko_money; sq026_refused_maiko/hiromi are reset by later nodes (transient). |
| pisces.maiko-fate | nonlethal | UNMAPPED: zero-only - Inverse of sq026_maiko_dead; the survived-and-installed state is already mapped on its own topic. |
| pyramid.relic-awareness | link-revelation | UNMAPPED: no-native-signal - judy_knows_johnny is shared with the Revolution disclosure (see above); no pier-only positive marker found. |
| law.bd-evidence | spiked-wreath-tested | MAPPED `jr5.law.bd-evidence.spiked-wreath-tested` (fact sq012_poison_bd_found >= 1 (after optional [Connect] BD attack scene); speakers river-ward; participant) |
| law.coverup | han-exposed | MAPPED `jr5.law.coverup.han-exposed` (journal confront_yu "Confront Detective Han." succeeded (scene 07a exit); speakers river-ward; participant) |
| law.client-report | evidence-shared | MAPPED `jr5.law.client-report.evidence-shared` (fact sq012_fact_accident >= 1 (V reported "accident, NCPD covered it up"); subset of the outcome; speakers jefferson-peralez, elizabeth-peralez; participant) |
| law.client-report | withheld | MAPPED `jr5.law.client-report.withheld` (fact sq012_fact_I_dont_know >= 1 ("Can't draw any real conclusions"); speakers jefferson-peralez, elizabeth-peralez; participant) |
| law.client-report | holt-blamed | MAPPED `jr5.law.client-report.holt-blamed` (fact sq012_fact_holt_killed_mayor >= 1 (V named Holt, admitting no proof); speakers jefferson-peralez, elizabeth-peralez; participant) |
| dream.van | lost | UNMAPPED: told-by-v - V-only pursuit; the Peralezes learn only through later reports, which are mapped separately. |
| dream.van | data-seen | UNMAPPED: told-by-v - V-only event; sharing requires a later report. |
| dream.elizabeth-private | confided | MAPPED `jr5.dream.elizabeth-private.confided` (journal clandestine_elizabeth/speak_to_elizabeth succeeded (scene exit after "Jefferson can't find out", section 71 on every path); speakers elizabeth-peralez; private) |
| dream.later-call | suspicious-call | UNMAPPED: no-native-signal - The truth-route texts voice Jefferson's doubt about his own memories, not suspicion of Elizabeth. |
| dream.later-call | job-offer-call | MAPPED `jr5.dream.later-call.job-offer-call` (Jefferson text 03_jefferson_finale_lie active|succeeded; speakers jefferson-peralez; private) |
| dream.election | elected | MAPPED `jr5.dream.election.elected` (fact sq006_election_results >= 1 (set after conclusion; both news variants report a Peralez win); speakers jefferson-peralez, elizabeth-peralez; public) |
| hunt.location | edgewood-deduced | MAPPED `jr5.hunt.location.edgewood-deduced` (facts sq021_v_knows_farm >= 1 AND sq021_good_farm_chosen >= 1 (guess choice unreachable once knows is set); speakers river-ward; participant) |
| hunt.location | edgewood-guessed | UNMAPPED: shared-writer - Guess node 615 writes the same sq021_good_farm_chosen as the deduced route; deduced is separated only by v_knows_farm, so "guessed" would need a zero test. |
| hunt.location | poppy | MAPPED `jr5.hunt.location.poppy` (fact sq021_bad_farm_chosen >= 1 (only "I vote Poppy Farm."); speakers river-ward; participant) |
| hunt.harris-afterward | vowed | MAPPED `jr5.hunt.harris-afterward.vowed` (any of sq021_no_change_good_end / revenge_good_end / dont_care_good_end >= 1 (choice 163 after River's vow, good-farm branch only); speakers river-ward; participant) |
| hunt.harris-afterward | spared-after-success | UNMAPPED: no-native-signal - No message or scene flag after the vow on the success path; forgiveness text 17 is on the failure path. |
| hunt.joss-briefed | briefed | UNMAPPED: told-by-v - Joss was not present; she is briefed only if V tells her. |
| following.parents | heard | UNMAPPED: no-native-signal - No persisted flag for River's parents story. |
| following.parents | stopped | UNMAPPED: no-native-signal - No persisted flag. |
| following.relationship | friends | MAPPED `jr5.following.relationship.friends` (fact sq029_river_shot_down >= 1 (dinner rebuff routes 406/423); speakers river-ward; participant) |
| following.relationship | intimate | UNMAPPED: ambiguous-meaning - sq029_river_had_sex is valid but also true whenever the existing committed rule is (same exclusive topic); there is no positive not-committed marker. |
| following.relationship | declined-commitment | UNMAPPED: shared-writer - The morning step-away writes only sq021_sobchak_friend, which has other writers. |
| following.career | private-investigator | UNMAPPED: no-native-signal - No persisted flag. |
| disclosure.reading | unread-return | UNMAPPED: zero-only - Defined by mq024_hacked_data_carrier == 0. |
| disclosure.response | lied | UNMAPPED: zero-only - The denial path writes nothing; only the absence of mq024_admit_that_looked marks it. |
| disclosure.response | honest-neutral | UNMAPPED: shared-writer - mq024_admit_that_looked is written for every admission (neutral, respectful, blackmail); the "Nothing" option writes no flag. |
| disclosure.response | respectful | UNMAPPED: shared-writer - The congratulation option writes no flag; admit_that_looked is shared. |
| disclosure.response | runner-rapport | UNMAPPED: no-native-signal - The daemon/technique questions write no fact or journal state. |
| disclosure.survival | alive | UNMAPPED: zero-only - Only the absence of a death marker. |
| disclosure.survival | killed | UNMAPPED: no-native-signal - The defeat condition is killed=1 defeated=1 unconscious=1 (does not prove death); no killed-only fact. |
| show.steven-report | heard | UNMAPPED: told-by-v - V heard Steven; Ana learns it only if told. |
| money.cache | collected | UNMAPPED: told-by-v - Ana learns the cache pickup only if V tells her. |
| beast.accept | accepted | MAPPED `jr5.beast.accept.accepted` (journal quest sq024_city_race succeeded (City Center race exists only after "I'll be your driver"); speakers claire-russell; participant) |
| beast.accept | refused | UNMAPPED: ambiguous-meaning - sq024_quest_declined is written on the meta-quest Failed path, which also covers prevention failures, not only the garage refusal. |
| beast.vehicle-gifts | beast-given | MAPPED `jr5.beast.vehicle-gifts.beast-given` (Claire's text 03_claire_give_car active|succeeded ("I left you the Beast"); covers the leave route only; speakers claire-russell; participant) |
| the-beast-in-me-city-center.placement | won | UNMAPPED: no-native-signal - sq024_*_race_won facts only ever receive 0 and position counters are transient. |
| the-beast-in-me-city-center.placement | qualified | UNMAPPED: no-native-signal - Same; sq024_city_race_enemy_finish is also written by mq056 and never reset. |
| the-beast-in-me-city-center.placement | outside-top-three | UNMAPPED: no-native-signal - Same. |
| the-beast-in-me-badlands.placement | won | UNMAPPED: no-native-signal - Same. |
| the-beast-in-me-badlands.placement | qualified | UNMAPPED: no-native-signal - Same. |
| the-beast-in-me-badlands.placement | outside-top-three | UNMAPPED: no-native-signal - Same. |
| santo.promise | revenge | UNMAPPED: no-native-signal - Section 158 writes only the shared end_stand; phone ch1 is offered on every path, so race-first players can send it too. |
| santo.promise | withdrawn | MAPPED `jr5.santo.promise.withdrawn` (fact sq024_end_at_santo_domingo >= 1 (choice 157/2 -> 321/1 "I'm done"); speakers claire-russell; participant) |
| santo.followup | boundary-reaffirmed | MAPPED `jr5.santo.followup.boundary-reaffirmed` (Claire's reply 02c_claire_beat_race active|succeeded (activated only after V's ch3 on the race-first branch); speakers claire-russell; private) |
| big.route | pursuit | MAPPED `jr5.big.route.pursuit` (journal 06a_follow_sampson active|succeeded; speakers claire-russell; participant) |
| big.route | finish | MAPPED `jr5.big.route.finish` (journal 06b_beat_race active|succeeded; speakers claire-russell; participant) |
| big.finish | won | MAPPED `jr5.big.finish.won` (fact sq024_big_race_won >= 1 (single writer, gated by opponent_finish == 0); speakers claire-russell; participant) |
| big.finish | finished-other | UNMAPPED: zero-only - Inverse of the opponent_finish == 0 gate. |
| hangout.attended | river-visited | UNMAPPED: ambiguous-meaning - mq055_02_river_first_time_done is set after the invitation text exchange (river_text), and save A shows river_hang/kerry_hang/panam_hang all succeeded for partners never hosted, so the hang objective is not per-visit proof; mirroring the Judy rule would risk false attendance. |
