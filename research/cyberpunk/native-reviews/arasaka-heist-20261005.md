# arasaka-heist native review (lane file arasaka-heist-20261005, prefix ah5)

Method. Every outcome in the lane was checked against the exported 2.31 scene/questphase graphs (hash-bound batches ah5-01..07 plus earlier priority batches), the cooked journal states and the nine check-lane saves. A predicate is used only when it is a positive journal state or a questSetVar > 0 whose writer is reachable on exactly one branch, is not reset, and (for facts that history-init nodes in mq055/ep1 also write) is guarded by a journal state. Speakers are limited to characters present in the scene or who are the recipient of the record. Jackie only gets pre-death Pickup facts (she dies in The Heist). Totalimmortal and Last Caress objectives exist only in save E2 (Devil route), so those rules never fire in A.

Result: 24 of 75 outcomes mapped (25 rules), 51 unmapped (told-by-v 4, no-speaker 7, zero-only 8, no-native-signal 16, shared-writer 7, ambiguous-meaning 6, out-of-scope 2, transient 1).

Notes for existing rules (not edited):
- `priority-endings.takemura.estate` (hideout-rescue AND hanako-extraction succeeded) should be checked against save E2: Takemura is alive there (q112_takemura_dead=0, he appears in the tower) but Last Caress objective 01_estate/01d_takemura ("Follow Takemura") is absent, so the estate presence cannot be confirmed from that objective.
- q110_08a_netwatch_deal is 2 in every save (writers 712 "=1" and 547 "+=1"), so ahe-native.netwatch-accepted and priority-endings.johnny.netwatch-purge fire everywhere.
- Evelyn_Cheat_Dex and q000_corpo_02_choice_02_done are also written by the standalone-start history nodes (mq055, ep1.questphase), which is why ah5 rules on them also require a journal state.
- q003_brick_dead must not be used as a Brick death marker (q003_end adds to it when brick_saved>0).
- q112_takemura_dead is allowlisted by priority-jackie-takemura-20261004 with its own audit scope; the ah5 rule reuses the key and does not redefine it.

| decision | outcome | MAPPED rule-id (predicate in words; speakers; perspective) or UNMAPPED: category - reason |
|---|---|---|
| hanako-offer | heard | MAPPED `ah5.embers.hanako-offer` (journal quests/meta/02_sickness/q115/04_talk_hanako succeeded; hanako-arasaka; participant) |
| ending-route | other-route | UNMAPPED: told-by-v - Takemura and Hanako are absent from the private rooftop choice; no native record exists for them. |
| orbital-visitor | hellman | UNMAPPED: no-speaker - no affected roster character. |
| corpo-career | corpo | MAPPED `ah5.corpo-rat.corpo` (journal 03_talk_jenkins (q000_corpo/office) succeeded; arthur-jenkins, frank-nostra; participant) |
| corpo-career | other-lifepath | MAPPED `ah5.corpo-rat.other-lifepath` (quest q000_nomad OR q000_street_kid active/succeeded; arthur-jenkins, frank-nostra; participant) |
| frank-prologue | completed | MAPPED `ah5.corpo-rat.frank-chat` (fact q000_corpo_02_choice_02_done>=1 AND lobby/03a_talk_friend succeeded; frank-nostra; participant) |
| frank-prologue | brief-or-skipped | UNMAPPED: zero-only - q000_corpo_02_cut_short exists but 03a_talk_friend also succeeds on the cut-short path, so absence of the full chat is not a positive signal. |
| jenkins-order | received | MAPPED `ah5.corpo-rat.jenkins-order` (journals 03_talk_jenkins + 05_take_shard + 05a_take_money succeeded; arthur-jenkins; participant) |
| war-pigs-lure | message-only | UNMAPPED: told-by-v - Frank is not part of a message-only branch; only V would tell him. |
| war-pigs-lure | confronted | MAPPED `ah5.war-pigs.confronted` (journal 04_confront_frank succeeded AND quest mq041_corpo succeeded; frank-nostra, johnny-silverhand; participant) |
| frank-fate | walked-away | UNMAPPED: no-native-signal - mq041 scene conditions are combined killed=1/defeated=1/unconscious=1; no per-fate fact or journal entry; Johnny epilogue variants are identical. |
| frank-fate | incapacitated | UNMAPPED: no-native-signal - same as walked-away. |
| frank-fate | killed | UNMAPPED: no-native-signal - killed=1 together with defeated=1 does not prove death. |
| frank-fate | self-inflicted-death | UNMAPPED: no-native-signal - same combined-condition problem; no suicide marker. |
| dex-contract | briefed | MAPPED `ah5.ride.dex-briefing` (journal q001_02_dex/dex/ride_with_dex succeeded; dexter-deshawn; participant) |
| evelyn-offer | heard | MAPPED `ah5.information.evelyn-offer` (fact Evelyn_Cheat_Dex>=1 AND quest q004_braindance succeeded; evelyn-parker; private) |
| stout-meeting | met | MAPPED `ah5.pickup.stout-meeting` (fact q003_militech_met>=1 AND militech/02_meet_militech1 succeeded; meredith-stout; participant) |
| stout-meeting | not-met | UNMAPPED: zero-only - only absence of q003_militech_met / the failed-meeting journal entries (never observed in any save) would indicate it. |
| militech-chip-cleaned | malware-removed | UNMAPPED: no-speaker - no affected roster character. |
| militech-chip-copied | malware-copied | UNMAPPED: no-speaker - no affected roster character. |
| royce-fate | alive | UNMAPPED: shared-writer - q003_royce_dead is written in q003_03_deal (8612), q003_04d_shootout_militech (301) and the boss fight; there is no alive marker. |
| royce-fate | killed-by-militech | UNMAPPED: shared-writer - same q003_royce_dead writers (militech route node 301 is not separable from the other kills) and the catalog knowledge is told-by-v. |
| brick-fate | rescued | MAPPED `ah5.pickup.brick-rescued` (fact q003_brick_saved>=1 AND quest q003_maelstrom succeeded; jackie-welles; witnessed) |
| brick-fate | trap-killed | UNMAPPED: shared-writer - q003_brick_dead is also added by q003_end node 325 whenever brick_saved>0, so it does not prove death. |
| brick-fate | left-unrescued | UNMAPPED: no-native-signal - q003_03_deal brick_killed_in writes nothing; absence of brick_saved is zero-only. |
| dumdum-fate | alive | UNMAPPED: ambiguous-meaning - no alive marker; q003_dumdum_dead is 0 in every save. |
| dumdum-fate | killed | UNMAPPED: ambiguous-meaning - q003_dumdum_dead (q003_04d_shootout_militech 180/380/1736, q003_militech_combat 54) is set on "character DumDum killed=1 defeated=1 unconscious=1", which does not prove death; zero in every save. |
| dumdum-fate | incapacitated | UNMAPPED: ambiguous-meaning - the same combined condition cannot separate incapacitated from killed. |
| gilchrist-evidence | read | UNMAPPED: no-speaker - no affected roster character (q003_convoy_signatures has no questphase writer anyway). |
| gilchrist-stout-disclosure | told-stout | MAPPED `ah5.pickup.gilchrist-told-stout` (fact q003_sold_signatures>=1; meredith-stout; participant) |
| gilchrist-confrontation | confronted-gilchrist | MAPPED `ah5.pickup.gilchrist-confronted` (fact q003_anthony_intimidated>=1; jackie-welles; witnessed) |
| pickup-gate-contact | no-meeting | UNMAPPED: no-native-signal - only zero of q003_militech_met or Failed journal states (never observed in any save, and they also cover a missed rendezvous after agreeing); topic militech.investigation.winner is shared with jt.pickup-gate-contact.* so a weak rule could contradict them. |
| stout-invitation | received | MAPPED `ah5.stout.invitation` (phone message q003_04_msg_sex_invite active/succeeded; meredith-stout; private) |
| stout-invitation-response | accepted | MAPPED `ah5.stout.motel-arrival` (journal q003_stout/01_go_to_notell succeeded; meredith-stout; private) |
| stout-encounter | not-established | UNMAPPED: zero-only - absence of q003_stout_sex_done. |
| report-evelyn | withheld | UNMAPPED: zero-only - only q005_01_dex_knows (disclosed) is positive. |
| heist-cut | thirty | UNMAPPED: zero-only - q005_01_plan choice options 0/1 write no fact; only 35% (dex_takes_45) and 40% (dex_takes_60) are positive and already covered by jt.heist-cut.*. |
| bug-death-report | death-reported | UNMAPPED: no-speaker - T-Bug is dead; no affected roster speaker. |
| jackie-body | family | UNMAPPED: out-of-scope - Jackie died before the choice; Mama's receipt is already covered by jt.jackie.body-disposition.family-received (same message) and the heywood body-instruction rules are told-by-v. |
| jackie-body | viktor | MAPPED `ah5.jackie.body-viktor` (Delamain message viktor_vektor active/succeeded; viktor-vektor; participant) |
| jackie-body | wait | UNMAPPED: out-of-scope - the wait route only produces the no_info message Delamain sends after the fact; Jackie is dead and Mama learns nothing at choice time. |
| dex-betrayal | shot-v | UNMAPPED: ambiguous-meaning - borderline reviewed: talk_dex ("Talk to Dex") and q101 victor are unconditional beats, not branches, and no native record or text states that Dex shot V; the shooting is scripted without a fact or journal line. |
| dex-betrayal | not-reached | UNMAPPED: zero-only - absence only. |
| takemura-ride | separate | UNMAPPED: no-native-signal - every save rode together (jt.takemura-ride.together covers it); no separate-ride writer. |
| takemura-background-shared | childhood-discussed | UNMAPPED: no-native-signal - q112_04_takemura only writes q112_04_bakeneko (the cat story), not childhood. |
| takemura-background-shared | not-established | UNMAPPED: zero-only - absence only. |
| oda-fate | spared | UNMAPPED: no-native-signal - only the positive q112_oda_dead (already used by jt.oda-fate.killed) exists; no Oda-alive marker, and the catalog knowledge is told-by-v. |
| hanako-proxy-disclosure | hellman | UNMAPPED: shared-writer - q112_11_shotgun nodes 69/82/89 all do q112_hanako_info_given += 1 whichever disclosure V chose. |
| hanako-alt-disclosure | alt | UNMAPPED: shared-writer - same shared q112_hanako_info_given writers. |
| hanako-relic-disclosure | limited | UNMAPPED: shared-writer - same shared q112_hanako_info_given writers. |
| placide-deal | briefed | MAPPED `ah5.placide.mall-brief` (quest q110_01_voodooboys succeeded; placide; participant) |
| netwatch-choice | rejected | UNMAPPED: shared-writer - q110_netwatch_agent_killed is written both on the reject path (node 3156) and when V hits the agent after accepting (3163); netwatch_deal is 2 in every save. |
| placide-malware | payload-survived | UNMAPPED: ambiguous-meaning - surviving the payload is only implied by later progress; q110_08a_virus records the warning, not the outcome. |
| mall-return | returned | MAPPED `ah5.placide.returned` (journal q110_voodoo/04_confrontation/02_talk_to_placide succeeded; placide; participant) |
| voodoo-runners | survived | UNMAPPED: told-by-v - Placide knows nothing that proves it and no native record exists. |
| voodoo-runners | flatlined | UNMAPPED: told-by-v - borderline reviewed (Placide pair): the deal fact (q110_08a_netwatch_deal=2 in all saves) does select the purge dialogue in q110_12_voodoo_queen, but Placide was not at the purge, q110_15_vdb_fight has no deal condition, and the catalog knowledge is told-by-v. |
| crypt-exit | peaceful | UNMAPPED: no-native-signal - Placide dies in every save (01c_deal_with_placide/01d_loot_door_key succeeded); no peaceful-exit record. |
| crypt-exit | v-attacked | UNMAPPED: no-native-signal - who initiated violence is not recorded; the fight is unconditional. |
| crypt-exit | netwatch-hostility | UNMAPPED: ambiguous-meaning - borderline reviewed (Placide pair): the Crypt fight scene q110_15_vdb_fight is not gated on the NetWatch deal and happens in every save; Placide cannot be shown to know V's deal. |
| placide-fate | alive-peace | UNMAPPED: no-native-signal - Placide is killed in every save. |
| placide-fate | incapacitated | UNMAPPED: no-native-signal - no incapacitated marker. |
| placide-fate | killed | UNMAPPED: no-speaker - q110_placide_killed has killed=1 defeated=0 unconscious=0, but the only affected speaker is the dead Placide. |
| devil-takemura-presence | absent | MAPPED `ah5.estate.takemura-absent` (fact q112_takemura_dead>=1 AND 06c_hellman + 01_estate/02_talk_hanako succeeded (no save fires); hanako-arasaka; participant) |
| saburo-construct | seen | MAPPED `ah5.tower.saburo-engram` (journal q113_corpo/02_arasaka_tower/00c2_talk succeeded; hanako-arasaka; participant) |
| jackie-construct | not-encountered | UNMAPPED: zero-only - absence of endings.devil.jackie-construct-conversation; a spawned Jackie is not this construct. |
| board-testimony | given | MAPPED `ah5.tower.board-testimony` (journals 01_meeting ("Give your testimony") + 02_survive succeeded; hanako-arasaka; witnessed) |
| smasher-fate | spared | UNMAPPED: no-native-signal - q113_13_adam_smasher has a single option (03b_decide_adam succeeds for any decision); no fate fact. |
| smasher-fate | killed | UNMAPPED: no-native-signal - same single-option scene. |
| yorinobu-confronted | heard | MAPPED `ah5.tower.yorinobu-heard` (journals 05_confront_yorinobu + 05b_hanako succeeded; yorinobu-arasaka; participant) ; `ah5.tower.yorinobu-held` (journals 05_confront_yorinobu + 05b_hanako succeeded; hanako-arasaka; participant) |
| takemura-assistance | accepted | UNMAPPED: no-native-signal - the tower choice (q113_11_top_atrium choice 294) is about open attack vs sly and quiet, not accepting help; the open-attack option writes nothing. |
| takemura-assistance | declined | UNMAPPED: transient - q113_atrium_takemura_stealth is reset to 0 by q113_atrium_combat and is absent in every save; Takemura still goes with V in the stealth option, so "declined" would be false. |
| maelstrom-leadership | brick | MAPPED `ah5.totentanz.brick` (journal sq011 04_nancy/01_talk_to_nancy1 ("Talk to Nancy and Brick.") succeeded; nancy-hartley, johnny-silverhand; participant) |
| maelstrom-leadership | royce | MAPPED `ah5.totentanz.royce` (journal sq011 04_nancy/04_talk_to_dumdum_royce succeeded; nancy-hartley, johnny-silverhand; participant) |
| maelstrom-leadership | patricia | MAPPED `ah5.totentanz.patricia` (journal sq011 04_nancy/01_talk_to_patricia_about_nancy succeeded; nancy-hartley, johnny-silverhand; participant) |
| bug-gift | received | UNMAPPED: no-speaker - T-Bug is dead; told-by-v. |
