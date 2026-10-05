# Phantom gigs lane (pg5) - native outcome mapping

Reviewed 2026-10-05 against installed Cyberpunk 2077 2.31 assets. Rules: `research/cyberpunk/native-rules/phantom-gigs-20261005.json`
(33 rules covering 27 outcomes, prefix `pg5`, 83 evidence rows, 19 facts, 43 journal selectors),
written by the rerunnable author script `KIT/lanes/phantom-gigs-author.mjs`. Evidence is hash-bound to scene-evidence batches `pg5-01` .. `pg5-04`
(`pg5-05` holds the q305 pre-ambush scenes used to reject the Yoko decline). `check-lane phantom-gigs-20261005` (full): 0 merge/runtime errors,
0 evidence/topic errors, 119 verified pointers, 0 topic contradictions.

## Method

- All 69 outcomes in the lane handoff were traced with `graph.mjs` / `q.mjs`. A predicate is accepted only when it is positive
  (fact >= 1 from a positive writer, or a journal entry/phone message/choice state), branch-specific, durable and has a verified knowledge path for a
  roster speaker. Mr. Hands is the contracting fixer: he knows a gig's result when his own debrief (SMS/holocall variant, recorded natively) states it
  or when the deliverable fact is verified and the quest is completed. Clients and contacts (Alan, Lina, Bill, Nele, Ana/Steven) speak only what
  their own messages or scenes recorded.
- `nika-yankovich` and `hasan-demir` are not roster keys: outcomes whose only audience is one of them are left unmapped (no-speaker). Their predicates
  were verified and remain in the author script for reference.
- Where Hands' debrief holocall is identical across branches (Academy), only his branch-specific SMS variant is used as the second predicate.

## Items resolved in the final pass

- `pg5.shot.netwatch`: the fact is written only inside the scene mq305_05_outcome_mr_hands (node 130), so save-states.json (questphase facts only) shows no
  value; the live saves read it as 1 in A, E0, E2, E3, E4, B, C, D. The route is branch-specific: the scene entry in_bree_sold_data is played by
  mq305_netwatch_encounter, entered from mq305_outcome's out_bree_sold_data, which hangs off the False branch of mq305_bree_dead > 0 (Bree not killed).
  Added the route as evidence (node 160, node 148, the netwatch_encounter scene node, scene start 165). Rule kept; it fires wherever Bree lived, which
  matches shot.bree-alive in A.
- `pg5.dazed.freed.hands`: phase-activation evidence found in mq303_messages.questphase (not mq303.questphase): debrief_ch_freed (node 76) sits behind
  pause 104 (mq303_tool_freed > 0, tool_kissed = 0, shank_killed = 0) and debrief_ch_freed_kiss (node 82) behind pause 73 (shank_killed = 0,
  tool_kissed > 0). Both choice texts say V set Tool free. Cited as extra evidence; rule kept.
- Run This Town / Arasaka investigated: rejected (told-by-v), see table. Black Steel / Yoko coordinates declined: rejected (no-native-signal).

## Rules that fire in save A

symptoms.cooperate (alan, hands), symptoms.alan-report, dazed.sisters (lina, hands), dodger.bill-left-police, jungle.dead-drop.hands, lining.received,
roads.sabotaged, shot.bree-alive, shot.netwatch, town.bennett-jago-alive. They agree with the E0/E4 end-game saves of the same character and with the
other saves where the quest was played (for example sisters never co-fires with fia-clone or fan-letter in any save).

## Outcomes

| decision | outcome | result |
|---|---|---|
| phantom.steel.yoko-disclosure | shared | MAPPED `pg5.steel.coords-shared` (mr-hands; private): phone choice contacts/mr_hands/q305/q305_ambush_info/01_info_fromv succeeded (V's text "sending the coords as promised") |
| phantom.steel.yoko-disclosure | declined | UNMAPPED: no-native-signal - no refusal choice exists: the only coordinate prompt is the 08_message_mr_hands objective, which fails when the convoy arrives, and the phone group q305_ambush_info has a single entry. The pre-ambush scenes (q305_04_pre_ambush_meeting, q305_04a_waiting_pre_ambush, exported in pg5-05) contain no coordinate decline |
| phantom.dazed.early-resolution | freed | MAPPED `pg5.dazed.freed.hands` (mr-hands; private): any of V's phone choices debrief_ch_freed/{debrief,debrief_alt} or debrief_ch_freed_kiss/{debrief,debrief_makeout} succeeded (mq303_messages nodes 76/82 behind pauses 104/73: tool_freed>0 or tool_kissed>0, shank_killed=0). Both texts say V freed Tool |
| phantom.dazed.lina-recruitment | paid | MAPPED `pg5.dazed.paid.lina` (lina-malina; private): Lina's text-transfer thread money_transfer/money_01 succeeded (the in-scene "[Pay]" shares a fact with "Can't pay", so only the text transfer is used) |
| phantom.dazed.lina-recruitment | corpo | UNMAPPED: no-native-signal - mansion choices 120:1-3 / 114:1 write no unique fact |
| phantom.dazed.lina-recruitment | celebrity-proof | UNMAPPED: no-native-signal - same mansion choices, no unique fact |
| phantom.dazed.lina-recruitment | schedule-edited | UNMAPPED: no-native-signal - same mansion choices, no unique fact |
| phantom.dazed.performance | sisters | MAPPED `pg5.dazed.sisters.lina` (lina-malina), `pg5.dazed.sisters.hands` (mr-hands; private): fact mq303_finale_sisters >= 1 (finale choice 2033:0) + quest done; Lina also needs her twins/01_start message, Hands needs V's debrief_ch_twin phone choice |
| phantom.dazed.performance | fia-clone | MAPPED `pg5.dazed.fia-clone.lina` (lina-malina), `pg5.dazed.fia-clone.hands` (mr-hands; private): fact mq303_finale_cia >= 1 (choice 2033:1) + quest done / debrief_ch_clone phone choice (Hands) |
| phantom.dazed.performance | fan-letter | MAPPED `pg5.dazed.fan-letter.lina` (lina-malina), `pg5.dazed.fan-letter.hands` (mr-hands; private): fact mq303_finale_shock >= 1 (choice 2033:2) + quest done / debrief_ch_cured phone choice (Hands) |
| phantom.town.arasaka | investigated | UNMAPPED: told-by-v - checked (Run This Town): the only Arasaka signal for Hands is mq304_told_hands_ab_bennett_arasaka (mq304_04_report_holocall node 54), V repeating Jago's claim; that option is offered only when mq304_bennett_meeting_done = 0, i.e. when V did NOT meet Bennett, so it is not an investigation. The investigation itself (the optional Bennett meeting, where Bennett admits the Arasaka deal) has no Hands presence, and Hands hears of it only through the optional "Met with Bennett, too" report choice, which has no unique writer. Paco/Babs are not involved |
| phantom.town.succession | bennett-jago-alive | MAPPED `pg5.town.bennett-jago-alive` (mr-hands; private): Hands' bennett_good follow-up message (mq304.questphase switch makes the four follow-ups exclusive) |
| phantom.town.succession | bennett-jago-dead | MAPPED `pg5.town.bennett-jago-dead` (mr-hands; private): Hands' bennett_bad or bennett_contacts follow-up message |
| phantom.town.succession | jago-bennett-dead | MAPPED `pg5.town.jago-bennett-dead` (mr-hands; private): Hands' jago_bad follow-up message |
| phantom.town.succession | jago-bennett-alive | MAPPED `pg5.town.jago-bennett-alive` (mr-hands; private): Hands' jago_terra follow-up message |
| phantom.symptoms.resolution | cooperate | MAPPED `pg5.symptoms.cooperate.alan` (alan-noel), `pg5.symptoms.cooperate.hands` (mr-hands): fact sts_ep1_12_milko_alive >= 1 (fed only by final scene exit "End peace", choice 221:0) + quest succeeded |
| phantom.symptoms.resolution | fight-alan | UNMAPPED: shared-writer - both fight routes only write milko_dead (killed/defeated/unconscious); Alan's fate is not recorded |
| phantom.symptoms.resolution | shoot-milko | UNMAPPED: shared-writer - same milko_dead writer |
| phantom.symptoms.followup | success-reported | MAPPED `pg5.symptoms.alan-report` (alan-noel; private): Alan's wst_ep1_02 (or _corpo_blueline) report message active/succeeded |
| phantom.dodger.force | none-confirmed | UNMAPPED: zero-only - absence of kills has no positive writer |
| phantom.dodger.force | killed | UNMAPPED: no-speaker - kill_count is lethal-only but mixes pre-rescue guards Bill did not witness; Hands' debrief does not read it |
| phantom.dodger.resolution | peaceful | UNMAPPED: no-native-signal - no positive peaceful writer |
| phantom.dodger.resolution | dodger-killed | UNMAPPED: ambiguous-meaning - dodger_dead = killed/defeated/unconscious |
| phantom.dodger.resolution | officers-not-confirmed-safe | UNMAPPED: no-native-signal - no record |
| phantom.dodger.bill-followup | still-police | UNMAPPED: no-native-signal - no positive record (Bill's message exists only for the left-police branch) |
| phantom.dodger.bill-followup | left-police | MAPPED `pg5.dodger.bill-left-police` (bill-mitchell): Bill's bill_invitation message active/succeeded ("Laid down my badge...") |
| phantom.foreman.evidence | investigated | UNMAPPED: no-speaker - important_clues_seen is set in every save; Briana not shown present |
| phantom.foreman.rinder-plan | execute | UNMAPPED: no-speaker - sts_ep1_03_wagner_death_chosen (choices 488:1/582:1/558:2) exists, but Briana and Hands are absent from the standoff and Regina is not in affects |
| phantom.foreman.rinder-plan | stash | UNMAPPED: no-speaker - sts_ep1_03_garage_revealed exists; same absent audience |
| phantom.foreman.rinder-plan | rehabilitation | UNMAPPED: no-speaker - sts_ep1_03_wagner_called_regina exists; same absent audience |
| phantom.foreman.rinder-fate | dead | UNMAPPED: ambiguous-meaning - wagner_dead = killed/defeated/unconscious and is set even on the stash route (save C) |
| phantom.foreman.rinder-fate | spared | UNMAPPED: ambiguous-meaning - no positive survival writer |
| phantom.foreman.rinder-fate | rehab-arranged | UNMAPPED: ambiguous-meaning - no distinguishing record; Hands' Foreman debrief has a single variant ("Took care of 'im") whatever happened |
| phantom.foreman.briana-report | death-reported | UNMAPPED: no-native-signal - mourner choice 282 "Rinder's dead." vs "I didn't let you down." both only write dogtag_delivered |
| phantom.roads.bomb | sabotaged | MAPPED `pg5.roads.sabotaged` (nele-springer, mr-hands): journal sts_ep1_07/plant_gps succeeded + fact sts_ep1_07_bomb_disabled >= 1 (bomb_interaction "Detonator Swaped") + quest succeeded |
| phantom.roads.accusation | heard | UNMAPPED: ambiguous-meaning - no fact; the fast-combat route may skip section 34 |
| phantom.roads.client | surrendered | UNMAPPED: shared-writer - nele_captured is also written in the gameplay phase |
| phantom.roads.farewell | amicable | UNMAPPED: no-native-signal - choice 763 options converge |
| phantom.jungle.bana | revealed | UNMAPPED: told-by-v - audio_mark_bana_reveal is transient; the agents learn it only from V |
| phantom.jungle.katya | spared | UNMAPPED: ambiguous-meaning - katya_killed = killed/defeated/unconscious; save C has both the deal flag wst_ep1_21_active and katya_killed |
| phantom.jungle.katya | killed | UNMAPPED: ambiguous-meaning - same katya_killed writer |
| phantom.jungle.biomonitor | given-ana | MAPPED `pg5.jungle.given-ana` (ana-friedman, steven-santos), `pg5.jungle.given-ana.hands` (mr-hands): fact sts_ep1_08_biomonitor_ana >= 1 (client_ending 649/652 <- choice 483:0 / 707) + quest succeeded; Hands variant cites debrief cond 158 else-branch |
| phantom.jungle.biomonitor | dead-drop | MAPPED `pg5.jungle.dead-drop.hands` (mr-hands), `pg5.jungle.dead-drop.steven` (steven-santos): journal final_meeting/leave_biomonitor_droppoint succeeded + quest succeeded (Steven variant also needs his biomonitor_destroyed_meeting_invitation message) |
| phantom.jungle.biomonitor | destroyed | MAPPED `pg5.jungle.destroyed` (ana-friedman, steven-santos): fact sts_ep1_08_biomonitor_destroyed >= 1 (client_ending 741 <- choice 483:1) + journal talk_with_the_agent succeeded + quest succeeded (the drop-point route shares the fact but never reaches talk_with_the_agent) |
| phantom.saints.resolution | both-alive | MAPPED `pg5.saints.both-alive.hands` (mr-hands): fact sts_ep1_01_nika_alive >= 1 (openworld 219 <- final "nika_alive" exit <- choice 103:0) + quest succeeded |
| phantom.saints.resolution | nika-neutralized | UNMAPPED: no-speaker - predicate verified (kill_nika succeeded via anderson_saved node 15) but the only affected non-Hands character is Nika, who is not a roster key; Hands is not told |
| phantom.saints.resolution | anthony-dead | MAPPED `pg5.saints.anthony-dead` (mr-hands): fact sts_ep1_01_failed >= 1 (openworld 89 <- final "failed" exit, after SET anderson_dead) + quest succeeded; debrief cond 101 |
| phantom.saints.account | heard | UNMAPPED: no-speaker - predicate verified (ep1_sts01_andersons_method >= 1) but the hearer is Nika, not a roster key |
| phantom.prototype.disposition | zetatech | UNMAPPED: no-native-signal - choice 315:0 has no unique writer |
| phantom.prototype.disposition | hands-safe | MAPPED `pg5.prototype.hands-safe` (mr-hands): fact sts_ep1_04_mr_hands_holo_convinced >= 1 (hasan_final 365 <- choice 315:1) + quest succeeded |
| phantom.prototype.disposition | alone | UNMAPPED: no-speaker - Hasan Demir is not a roster key (sts_ep1_04_hasan_let_go / _let_go_earlier verified) |
| phantom.prototype.later-state | shop | UNMAPPED: ambiguous-meaning - wst_ep1_05 shows a meeting and a gun, not a shop |
| phantom.prototype.later-state | impoverished | UNMAPPED: no-native-signal - not observed: wst_ep1_06 is only a Hands SMS about an implant sale |
| phantom.ownway.visit | visited | UNMAPPED: no-speaker - Hasan Demir is not a roster key (go_to_hasan_apartment + take_the_gun verified) |
| phantom.hearts.evidence | inspected | UNMAPPED: no-speaker - sts_ep1_06_tape_seen exists but Hands was not present |
| phantom.hearts.testimony | deleted | MAPPED `pg5.hearts.deleted` (mr-hands): fact sts_ep1_06_testimony_withdrawn >= 1 (george node 451; the deal path writes 0 at 450) + quest succeeded; debrief cond 193 |
| phantom.hearts.testimony | anonymized | UNMAPPED: zero-only - testimony_withdrawn = 0 on this branch; testimony_agree is missing even in save A |
| phantom.hearts.discretion | quiet | UNMAPPED: zero-only - quiet is the absence of the combat flags |
| phantom.hearts.discretion | alarm | MAPPED `pg5.hearts.alarm` (mr-hands): fact sts_ep1_06_ground_floor_combat or upper_floor_combat >= 1 + quest succeeded; debrief cond 188 "such a mess at the Heavy Hearts" |
| phantom.academy.data | full | MAPPED `pg5.academy.full.hands` (mr-hands): fact sts_ep1_13_fiona_deal_refuse (fiona 994 <- choice 653:1) + Hands' SMS debrief_deal_refuse active (holocall lines are identical, only the SMS distinguishes) |
| phantom.academy.data | controlled | MAPPED `pg5.academy.controlled.hands` (mr-hands): fact sts_ep1_13_fiona_deal_done (fiona 1315 <- 653:0/2) + Hands' SMS debrief_deal_done active |
| phantom.academy.tommie | promised | UNMAPPED: no-speaker - sts_ep1_13_tommie_dreams_come_true (choice 653:2); only Hands is affected and he is not told |
| phantom.academy.fiona | alive | UNMAPPED: zero-only - fiona_dead_end = 0 on the survival path |
| phantom.academy.fiona | dead | UNMAPPED: ambiguous-meaning - fiona_dead_end = killed/defeated/unconscious |
| phantom.shot.resolution | bree-alive | MAPPED `pg5.shot.bree-alive` (mr-hands): journal 04_lab_confrontation/kill_dante succeeded + Hands' bree_went_to_away message active (mq305_outcome: sent on the False branch of mq305_bree_dead) + quest succeeded |
| phantom.shot.resolution | dante-alive | UNMAPPED: no-native-signal - no positive Dante-survival writer |
| phantom.shot.resolution | both-dead | UNMAPPED: ambiguous-meaning - mq305_both_killed exists but Hands' knowledge path is not established |
| phantom.shot.netwatch | reported | MAPPED `pg5.shot.netwatch` (mr-hands): fact mq305_mr_hands_sends_message_about_bree >= 1. Sole positive writer is scene node 130 of mq305_05_outcome_mr_hands, entered only at in_bree_sold_data (scene start 165 -> NetWatch warning section 134 -> write). That entry is played by mq305_netwatch_encounter, reached through mq305_outcome output out_bree_sold_data on the False branch of mq305_bree_dead > 0. save-states.json had no value because the writer is inside a scene; the live saves read it as 1 (A, E0, E2, B, C, D) - explained |
| phantom.lining.reward | received | MAPPED `pg5.lining.received` (mr-hands): Hands' combat_zone_reward message active + journal combat_zone_reward/talk_with_hands succeeded |

Totals: 27 outcomes mapped (33 rules), 42 unmapped (no-native-signal 12, told-by-v 2, shared-writer 3, zero-only 4, no-speaker 11, ambiguous-meaning 10).
