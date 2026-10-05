# Other fixers lane (fo5) - native outcome mapping

Reviewed 2026-10-05 against installed Cyberpunk 2077 2.31 assets. Rules: `research/cyberpunk/native-rules/fixers-others-20261005.json`
(72 rules, prefix `fo5`, 123 evidence rows), written by the rerunnable author script `KIT/lanes/fixers-others-author.mjs`.
Speakers are the contracting fixer only: Padre Ibarra, Muamar Reyes, Wakako Okada and Dino Dinovic. There are no Rogue outcomes in this lane.
Evidence is hash-bound to scene-evidence batches `fo5-01` (32 questphases), `fo5-02` (8 questphases), `fo5-03` (5 scenes: Padre fixer conversation,
q112_00c_wakako, the RCR/ARR debrief holocall scenes, courier outro) and `fo5-04` (mq049). `check-lane fixers-others-20261005` (full) ends with
0 merge/runtime errors, 0 evidence/topic errors, 190 verified pointers and 0 topic contradictions.

## Method

- **Gig outcomes.** A rule requires the gig quest `succeeded` plus an outcome-specific predicate that the fixer's own debrief (SMS / holocall branch,
  recorded in the journal or by a debrief-selecting fact) or the delivered deliverable establishes. Dino, Padre, Muamar and Wakako are the contracting
  parties, so they know the contracted result. They do not get optional details V never reports (who V persuaded, bribes, side conversations); those are
  `told-by-v`.
- **Stealth / combat pairs** use the optional objective's final journal state (`succeeded` vs `failed`), so the two alternatives are exclusive by construction.
- **Kill vs delivered-alive.** Strict kill facts (`killed=1 defeated=0 unconscious=0`: Karubo, Albach, Lucius and the Getting Warmer target) say the
  target died. Four kill rules start from a condition that also passes on defeat (`killed=1 defeated=1`): Gustavo Orta (`rey_01_kill_gustavo`), José Luis
  (`spr_01_jose_luise_killed`), Logan Garcia (`wwd_05_logan_dead`) and Jack Mausser (`dtn_02_kill_mausser`). Their statements say only that the fixer's debrief
  treated the target as dead, and that the record does not prove the target actually died. The delivered-alive alternatives use the delivery objective or
  the post-delivery fact (trunk check, AV disposal "continue" exit), which are different branches.
- **Guinea Pigs / Koch killed was removed.** `dtn_04_joanne_koch_dead` is written in `sts_cct_dtn_04_phase` by a SET node (kill sub-phase node 8) that is
  reachable straight from a `questInteraction` pause condition (node 3) and from the False exits of `target_disposed` / trigger-area checks, not only from the
  `character killed=1 defeated=0` check (node 2). The fact is therefore not a death proof and the rule is recorded as `ambiguous-meaning`. The
  delivered-alive alternative (`dtn_04_target_delivered`, written only after the AV-disposal phase's "continue" exit, with a separate "killed not delivered"
  input socket) stays.
- **Olive Branch** (`olive-branch.delivered`): `jpn_01_debrief_good` is written only on the delivery branch of `sts_wbr_jpn_01b_openworld`. The evidence
  pointer to the phase node passes the full evidence verification.
- **Rules true in save A (AutoSave-14):** Padre 7, Muamar 14, Wakako 10, Dino 4 selected facts, e.g. jeopardy, lifes-work, psychofan, jose.killed,
  conspiracy.told, side-effects acid/booker, the-gig.paid, shrine/until-death unseen, inconvenient.killed and inconvenient.combat. Cross-save truth is
  consistent with no two alternatives of one decision true together.

## Dispositions (all 107 outcomes)

| # | quest / decision | outcome | disposition |
|---|---|---|---|
| 1 | down-on-the-street / parade-intel | provided | MAPPED `fo5.down-street.parade-intel`: 00c_03_talk_wakako succeeded; wakako-okada |
| 2 | the-rescue / client-report | alive-reported | UNMAPPED: no-native-signal - the call_wakako/talk_to_wakako writers were not found in the exported 2.31 q001 phases |
| 3 | getting-warmer / bugbear | rescued | MAPPED `fo5.getting-warmer.rescued`: sts_hey_rey_09 succeeded AND bring_tobias succeeded; wakako-okada |
| 4 | getting-warmer / bugbear | dead | MAPPED `fo5.getting-warmer.dead`: rey_09_target_died >= 1; wakako-okada |
| 5 | lifes-work / vehicle | returned | MAPPED `fo5.lifes-work.car`: sts_hey_gle_06 succeeded AND delicer_car succeeded; padre-ibarra |
| 6 | lifes-work / gang-conflict | lethal-conflict | UNMAPPED: told-by-v - `gle_06_kill_all` is not recorded in Padre's debrief |
| 7 | lifes-work / gang-conflict | no-lethal-conflict | UNMAPPED: told-by-v - same: Padre's debrief does not record the conflict method |
| 8 | sinnerman / contract | joshua-killed | UNMAPPED: told-by-v - Wakako has no outcome-specific message; the sq023 SMS covers Bill's death only |
| 9 | sinnerman / contract | continued-with-joshua | UNMAPPED: told-by-v - Wakako has no outcome-specific message |
| 10 | sinnerman / contract | pursuit-failed | UNMAPPED: told-by-v - Wakako has no outcome-specific message |
| 11 | olive-branch / alex | delivered | MAPPED `fo5.olive-branch.delivered`: sts_wbr_jpn_01 succeeded AND jpn_01_debrief_good >= 1; wakako-okada |
| 12 | error-404 / sabotage | uploaded | MAPPED `fo5.error-404.malware`: sts_std_rcr_04 succeeded AND destroy_server succeeded; muamar-reyes |
| 13 | race-to-the-top / data | acquired | MAPPED `fo5.race-top.data`: sts_std_arr_03 succeeded AND sts_std_arr_03_data_received active/succeeded; muamar-reyes |
| 14 | serious-side-effects / acid | returned | MAPPED `fo5.side-effects.acid`: sts_std_arr_01 succeeded AND drop succeeded; muamar-reyes |
| 15 | serious-side-effects / booker-investigation | searched | MAPPED `fo5.side-effects.booker`: sts_std_arr_01 succeeded AND investigation succeeded; muamar-reyes |
| 16 | breaking-news / tracker | installed | MAPPED `fo5.breaking-news.tracker`: sts_std_arr_05 succeeded AND install_a_tracking_chip succeeded; muamar-reyes |
| 17 | breaking-news / discretion | undetected | MAPPED `fo5.breaking-news.unseen`: sts_std_arr_05 succeeded AND be_unseen succeeded; muamar-reyes |
| 18 | breaking-news / discretion | detected | MAPPED `fo5.breaking-news.seen`: sts_std_arr_05 succeeded AND be_unseen failed; muamar-reyes |
| 19 | family-matters / data | returned | MAPPED `fo5.family-matters.data`: sts_std_rcr_05 succeeded AND deliver succeeded; muamar-reyes |
| 20 | family-matters / family-report | reported | MAPPED `fo5.family-matters.report`: sts_std_rcr_05 succeeded AND investigate succeeded; muamar-reyes |
| 21 | family-matters / rose | incapacitated | UNMAPPED: told-by-v - Muamar's single debrief does not record what happened to Rose |
| 22 | family-matters / rose | killed | UNMAPPED: told-by-v - Muamar's single debrief does not record what happened to Rose |
| 23 | hacking-the-hacker / malware | uploaded | MAPPED `fo5.hacking.upload`: sts_std_arr_11 succeeded AND delete succeeded; muamar-reyes |
| 24 | hacking-the-hacker / lucius | killed | MAPPED `fo5.hacking.lucius-killed`: sts_std_arr_11 succeeded AND arr_11_lucius_dead >= 1; muamar-reyes |
| 25 | hacking-the-hacker / lucius | not-killed | UNMAPPED: zero-only - no positive writer; exclusivity of the not_perfect SMS route is not proven |
| 26 | severance-package / data | returned | MAPPED `fo5.severance.data`: sts_std_arr_10 succeeded AND send_data_sms_arr_10 active/succeeded; muamar-reyes |
| 27 | desperate-measures / truck | delivered | MAPPED `fo5.desperate.truck`: sts_std_arr_12 succeeded AND drive_truck_to_warehouse succeeded; muamar-reyes |
| 28 | desperate-measures / pedro-disclosure | heard | UNMAPPED: told-by-v - the disclosure is not reported to Muamar |
| 29 | for-my-son / logans-fate | killed | MAPPED `fo5.for-my-son.killed`: sts_pac_wwd_05 succeeded AND wwd_05_logan_dead >= 1; muamar-reyes |
| 30 | for-my-son / logans-fate | delivered-alive | MAPPED `fo5.for-my-son.delivered`: sts_pac_wwd_05 succeeded AND get_body_to_trunk succeeded; muamar-reyes |
| 31 | fifth-column / data | acquired | MAPPED `fo5.fifth-column.data`: sts_hey_gle_04 succeeded AND received_data active/succeeded; padre-ibarra |
| 32 | fifth-column / ernesto-access | jackie-recognized | UNMAPPED: told-by-v - `have_a_drink` is not reported to Padre |
| 33 | jeopardy / shard | returned | MAPPED `fo5.jeopardy.shard`: sts_hey_rey_06 succeeded AND drop succeeded; padre-ibarra |
| 34 | on-a-tight-leash / jose | killed | MAPPED `fo5.jose.killed`: sts_hey_spr_01 succeeded AND spr_01_jose_luise_killed >= 1; padre-ibarra |
| 35 | on-a-tight-leash / jose | delivered-alive | MAPPED `fo5.jose.delivered`: sts_hey_spr_01 succeeded AND take_to_fixer succeeded; padre-ibarra |
| 36 | on-a-tight-leash / conspiracy-report | truth-told | MAPPED `fo5.conspiracy.told`: sts_hey_spr_01 succeeded AND talk_padre succeeded AND find_out succeeded; padre-ibarra |
| 37 | on-a-tight-leash / conspiracy-report | withheld | UNMAPPED: told-by-v - the "Nope." choice cannot be told apart from V never finding out |
| 38 | bring-me-the-head-of-gustavo-orta / gustavo | killed | MAPPED `fo5.gustavo.killed`: sts_hey_rey_01 succeeded AND rey_01_kill_gustavo >= 1; padre-ibarra |
| 39 | bring-me-the-head-of-gustavo-orta / gustavo | delivered-alive | MAPPED `fo5.gustavo.delivered`: sts_hey_rey_01 succeeded AND rey_01_defeat_gustavo >= 1; padre-ibarra |
| 40 | bring-me-the-head-of-gustavo-orta / gustavo | agreed-to-leave | UNMAPPED: told-by-v - Padre's debrief reports a suicide, which an existing rule already maps |
| 41 | old-friends / karubo | killed | MAPPED `fo5.karubo.killed`: sts_hey_rey_08 succeeded AND rey_08_karubo_dead >= 1; padre-ibarra |
| 42 | old-friends / karubo | delivered-alive | MAPPED `fo5.karubo.delivered`: sts_hey_rey_08 succeeded AND optional_disposal succeeded; padre-ibarra |
| 43 | old-friends / alarm | undetected | MAPPED `fo5.karubo.silent`: sts_hey_rey_08 succeeded AND take_down_karubo_silently succeeded; padre-ibarra |
| 44 | old-friends / alarm | detected | MAPPED `fo5.karubo.alarm`: sts_hey_rey_08 succeeded AND rey_08_in_combat >= 1; padre-ibarra |
| 45 | psychofan / guitar | returned | MAPPED `fo5.psychofan.guitar`: sts_hey_gle_03 succeeded AND drop succeeded; padre-ibarra |
| 46 | eye-for-an-eye / bribe | accepted | UNMAPPED: told-by-v - the bribe is not reported to Padre |
| 47 | eye-for-an-eye / bribe | refused | UNMAPPED: told-by-v - the bribe is not reported to Padre |
| 48 | eye-for-an-eye / albach | spared | MAPPED `fo5.albach.spared`: sts_hey_gle_01 succeeded AND gle_01_spared >= 1; padre-ibarra |
| 49 | eye-for-an-eye / albach | killed | MAPPED `fo5.albach.killed`: sts_hey_gle_01 succeeded AND gle_01_killed >= 1; padre-ibarra |
| 50 | eye-for-an-eye / albach | delivered-alive | MAPPED `fo5.albach.delivered`: sts_hey_gle_01 succeeded AND gle_01_delivered >= 1; padre-ibarra |
| 51 | sr-ladrillos-private-collection / archive | acquired | MAPPED `fo5.ladrillo.archive`: sts_hey_rey_02 succeeded AND take_datapad succeeded; padre-ibarra |
| 52 | sr-ladrillos-private-collection / stealth | undetected | UNMAPPED: not-in-2.31 - no stealth objective exists; the gang-chase SMS is not a stealth verdict |
| 53 | sr-ladrillos-private-collection / stealth | detected | UNMAPPED: not-in-2.31 - no stealth objective exists; the gang-chase SMS is not a stealth verdict |
| 54 | the-lord-giveth-and-taketh-away / vehicle | returned | MAPPED `fo5.lord-giveth.suv`: sts_hey_spr_03 succeeded AND convey succeeded; padre-ibarra |
| 55 | going-up-or-down / method | persuaded | UNMAPPED: told-by-v - Padre's debrief does not record the method |
| 56 | going-up-or-down / method | taken | UNMAPPED: told-by-v - Padre's debrief does not record the method |
| 57 | going-up-or-down / rods | returned | MAPPED `fo5.going-up.rods`: sts_hey_gle_05 succeeded AND deliver succeeded; padre-ibarra |
| 58 | tyger-and-vulture / chip | returned | MAPPED `fo5.tyger-vulture.chip`: sts_wbr_hil_07 succeeded AND drop_wallet succeeded; wakako-okada |
| 59 | greed-never-pays / device | returned | MAPPED `fo5.greed.device`: sts_wbr_jpn_12 succeeded AND leave_device_in_droppoint succeeded; wakako-okada |
| 60 | until-death-do-us-part / receipts | returned | MAPPED `fo5.until-death.receipts`: sts_wbr_hil_01 succeeded AND drop_point succeeded; wakako-okada |
| 61 | until-death-do-us-part / stealth | undetected | MAPPED `fo5.until-death.unseen`: sts_wbr_hil_01 succeeded AND be_unseen succeeded; wakako-okada |
| 62 | until-death-do-us-part / stealth | detected | MAPPED `fo5.until-death.seen`: sts_wbr_hil_01 succeeded AND be_unseen failed; wakako-okada |
| 63 | a-shrine-defiled / surveillance | installed | MAPPED `fo5.shrine.bug`: sts_wbr_jpn_03 succeeded AND plant_bug_in_honden succeeded; wakako-okada |
| 64 | a-shrine-defiled / stealth | undetected | MAPPED `fo5.shrine.unseen`: sts_wbr_jpn_03 succeeded AND stealth succeeded; wakako-okada |
| 65 | a-shrine-defiled / stealth | detected | MAPPED `fo5.shrine.seen`: sts_wbr_jpn_03 succeeded AND stealth failed; wakako-okada |
| 66 | a-lack-of-empathy / virus | uploaded | MAPPED `fo5.empathy.virus`: sts_cct_dtn_03 succeeded AND infect_main_server succeeded; dino-dinovic |
| 67 | a-lack-of-empathy / combat | avoided | MAPPED `fo5.empathy.no-combat`: sts_cct_dtn_03 succeeded AND avoid_combat succeeded; dino-dinovic |
| 68 | a-lack-of-empathy / combat | occurred | MAPPED `fo5.empathy.combat`: sts_cct_dtn_03 succeeded AND avoid_combat failed; dino-dinovic |
| 69 | an-inconvenient-killer / jack | killed | MAPPED `fo5.inconvenient.killed`: sts_cct_dtn_02 succeeded AND dtn_02_kill_mausser >= 1; dino-dinovic |
| 70 | an-inconvenient-killer / jack | delivered-alive | MAPPED `fo5.inconvenient.delivered`: sts_cct_dtn_02 succeeded AND dtn_02_defeat_mausser >= 1; dino-dinovic |
| 71 | an-inconvenient-killer / combat | avoided | MAPPED `fo5.inconvenient.no-combat`: sts_cct_dtn_02 succeeded AND do_not_start_combat succeeded; dino-dinovic |
| 72 | an-inconvenient-killer / combat | occurred | MAPPED `fo5.inconvenient.combat`: sts_cct_dtn_02 succeeded AND do_not_start_combat failed; dino-dinovic |
| 73 | guinea-pigs / koch | killed | UNMAPPED: ambiguous-meaning - REJECTED after graph check: `dtn_04_joanne_koch_dead` is written (sts_cct_dtn_04_phase kill sub-phase node 8) directly after a `questInteraction` pause condition (node 3, straight from the sub-phase input) and also on the False exits of the `target_disposed` / trigger-area checks; the character `killed=1 defeated=0` check (node 2) is only one of several routes into the writer. The fact does not prove Koch died |
| 74 | guinea-pigs / koch | delivered-alive | MAPPED `fo5.guinea-pigs.delivered`: sts_cct_dtn_04 succeeded AND dtn_04_target_delivered >= 1; dino-dinovic |
| 75 | guinea-pigs / computer-request | allowed | UNMAPPED: told-by-v - the optional plea is not reported to Dino |
| 76 | guinea-pigs / computer-request | refused | UNMAPPED: told-by-v - the optional plea is not reported to Dino |
| 77 | serial-suicide / recording | recovered | MAPPED `fo5.serial-suicide.footage`: sts_cct_cpz_01 succeeded AND sts_cct_cpz_01_data_received active/succeeded; dino-dinovic |
| 78 | the-frolics-of-councilwoman-cole / recording | acquired | MAPPED `fo5.cole.recording`: sts_cct_dtn_05 succeeded AND sts_cct_dtn_05_data_recived active/succeeded; dino-dinovic |
| 79 | the-frolics-of-councilwoman-cole / stealth | undetected | MAPPED `fo5.cole.unseen`: sts_cct_dtn_05 succeeded AND stealth succeeded; dino-dinovic |
| 80 | the-frolics-of-councilwoman-cole / stealth | detected | MAPPED `fo5.cole.seen`: sts_cct_dtn_05 succeeded AND stealth failed; dino-dinovic |
| 81 | ride-captain-ride / offer | offered | MAPPED `fo5.ride-captain.offer`: santo_domingo_reward active/succeeded; muamar-reyes |
| 82 | ride-captain-ride / collection | collected | UNMAPPED: no-speaker - the fixer does not witness V collecting the car |
| 83 | god-bless-this-mess / offer | offered | MAPPED `fo5.god-bless.offer`: heywood_reward active/succeeded; padre-ibarra |
| 84 | god-bless-this-mess / collection | collected | UNMAPPED: no-speaker - the fixer does not witness V collecting the car |
| 85 | professional-widow / offer | offered | MAPPED `fo5.widow.offer`: westbrook_reward active/succeeded; wakako-okada |
| 86 | professional-widow / collection | collected | UNMAPPED: no-speaker - the fixer does not witness the collection |
| 87 | gas-gas-gas / offer | offered | MAPPED `fo5.gas.offer`: city_center_reward active/succeeded; dino-dinovic |
| 88 | gas-gas-gas / collection | collected | UNMAPPED: no-speaker - the fixer does not witness V collecting the car |
| 89 | push-it-to-the-limit / business | introduced | UNMAPPED: ambiguous-meaning - `intro_talk_with_muamar` is inactive in every save |
| 90 | just-another-story / delivery | delivered | UNMAPPED: out-of-scope - courier_test template; repeatable instance; inactive in saves |
| 91 | just-another-story / deadline | met | UNMAPPED: out-of-scope - courier_test template; repeatable instance; inactive in saves |
| 92 | just-another-story / deadline | missed | UNMAPPED: out-of-scope - courier_test template; repeatable instance; inactive in saves |
| 93 | just-another-story / condition | met | UNMAPPED: out-of-scope - courier_test template; repeatable instance; inactive in saves |
| 94 | just-another-story / condition | missed | UNMAPPED: out-of-scope - courier_test template; repeatable instance; inactive in saves |
| 95 | baby-let-me-take-you / ayden | saved | MAPPED `fo5.courier.daniels-saved`: courier_outro_dock succeeded AND sa_ep1_courier_outro_daniels_saved >= 1; muamar-reyes |
| 96 | baby-let-me-take-you / ayden | left-behind-dead | MAPPED `fo5.courier.daniels-dead`: courier_outro_dock succeeded AND save_daniels failed; muamar-reyes |
| 97 | baby-let-me-take-you / cargo | delivered | MAPPED `fo5.courier.cargo`: courier_outro_dock succeeded AND deliver_the_truck succeeded; muamar-reyes |
| 98 | baby-let-me-take-you / cargo | destroyed | MAPPED `fo5.courier.cargo-destroyed`: courier_outro_fail_vehicle_destroyed active/succeeded; muamar-reyes |
| 99 | baby-let-me-take-you / motive | shared | UNMAPPED: no-native-signal - the motive lines are not in the exported end scene |
| 100 | over-the-edge / falco | replied | MAPPED `fo5.over-edge.package`: 09_package active/succeeded; muamar-reyes |
| 101 | over-the-edge / gift | collected | MAPPED `fo5.over-edge.jacket`: mq049_jacket_looted >= 1; muamar-reyes |
| 102 | shape-of-a-pony / report | recovered-reported | MAPPED `fo5.pony.recovered`: job_done succeeded AND porsche_911_cabrio_message3 active/succeeded; muamar-reyes |
| 103 | shape-of-a-pony / refund | paid | UNMAPPED: no-native-signal - no refund text or record |
| 104 | the-gig / payment | paid | MAPPED `fo5.the-gig.paid`: 01_reward succeeded; wakako-okada |
| 105 | the-gig / reward | collected | UNMAPPED: no-speaker - pickup from Cassius Ryder's shop; Wakako does not witness it |
| 106 | the-streetkid / acquaintance | ride-shared | MAPPED `fo5.streetkid.padre-ride`: 08_drive_downtown succeeded; padre-ibarra |
| 107 | heroes / attendance | attended | MAPPED `fo5.heroes.padre`: 04b_talk_with_padre succeeded; padre-ibarra |

Totals: 72 mapped, 35 unmapped (no-native-signal 3, told-by-v 17, zero-only 1, not-in-2.31 2, ambiguous-meaning 2, no-speaker 5, out-of-scope 5).
