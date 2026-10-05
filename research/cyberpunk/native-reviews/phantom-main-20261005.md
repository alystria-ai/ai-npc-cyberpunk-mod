# Phantom main lane (pm5) - native outcome mapping

Reviewed 2026-10-05 against installed Cyberpunk 2077 2.31 assets. Rules: `research/cyberpunk/native-rules/phantom-main-20261005.json`
(23 rules, prefix `pm5`, 38 evidence rows, 10 facts, 13 journal selectors), written by the rerunnable author script
`KIT/lanes/phantom-main-author.mjs`. Evidence is hash-bound to scene-evidence batches `pm5-01` .. `pm5-05` (and the existing hash-bound
`pg5-01`, `priority-phantom-*`, `phantom-authenticated-oct01`, `phantom-reviewed-oct01`, `phantom-native` batches). `pm5-05` re-exports
`mq306_04b_angie_meeting.scene`, whose only earlier export (`phantom-aaron`) had no JSON hash.
`check-lane phantom-main-20261005` (full): 0 merge/runtime errors, 0 evidence/topic errors, 79 verified pointers, 0 topic contradictions.

## Method

- All 44 outcomes in the lane handoff were traced upstream with `graph.mjs` / `q.mjs` and the exported scenes. A predicate is accepted only when it is
  positive (fact >= 1 from a positive `questSetVar`, or journal `succeeded` / `active|succeeded`), branch-specific, durable and has a verified
  knowledge path for a roster speaker. Fact names were treated as hints and confirmed by the scene or graph route.
- Phone messages are `questJournalEntry_NodeType` nodes, not `questJournalQuestEntry_NodeType`; the author script carries its own `journalNodes`
  that matches both (the shared helper only matched objective entries).
- Reed/Songbird/Alex/Myers only appear together from Dog Eat Dog on; outcomes earlier than that (Lucretia Overdrive squat scene) have no roster
  speaker who was present.
- Rules that fire in save A (the player's current save): `birds.reed-told-escape-plan`, `damaged.songbird-begged-to-die`,
  `easy.angie-defeated`, `show.steven-meeting`, `show.steven-payment`, `symptoms.alan-revealed`, `corpo.alan-reward`,
  `mistakes.bill-hotdog-stand`, `balls.plan-frame-yuri`, `balls.result-paco-executed`. Their E0..E4 / B / C / D values are consistent with those
  playthroughs (for example frame-yuri and paco-executed always co-fire; nomad-help and both-kenya fire together in C; alex-alive and
  hansen-killed-by-alex fire together in B and D).

## Errors in prior reviews found while mapping

- `q302_oath_pledged` (q302_04_squot node 4638, after the full pledge) is a positive writer and is 1 in save A. The prior residual review said it
  appeared only as a zero comparison. The outcome stays unmapped only because Myers, the sole witness, is not a roster character.
- The prior review's claim of a "bypass" path in q305_10 (Songbird finale) was not confirmed. Every path to the `q305_songbird_alive` writer passes
  her plea ("I'm begging you"), so `q305_songbird_alive` is a valid positive predicate for `damaged.request/heard`.
- Existing rule `phantom.native.firestarter.alex-dead` is `told-by-v`, so the runtime never fires it. Reed was present on the Reed branch, which may
  justify a participant variant (not authored here; out of this lane's scope to edit).
- Existing Songbird `told-by-v` rules for the plea are redundant with `pm5.damaged.songbird-begged-to-die`.
- `q304_04e_v_danced_again` is used for the Alex evening; `v_dances_withalex` is NOT usable because node 2904 resets it.
- `easy.angie-defeated`: the writer (`mq306_animals_dead`) fires when Angie and the animals are killed, defeated or unconscious, so the statement
  says "defeated" and does not claim a death.

## Outcomes

| decision | outcome | result |
|---|---|---|
| phantom.changed.judy-call | heard | MAPPED `pm5.changed.judy-call-heard`: fact `q307_call_judy_end` >= 1 (q307_03a node 637; every route passes the Pittsburgh/married line), judy-alvarez (private) |
| phantom.name.roulette | v-lost | UNMAPPED: no-native-signal - the all-in loss branch (randomizer 3927/4287) has no specific positive writer |
| phantom.easy.angie | killed | MAPPED `pm5.easy.angie-defeated`: `mq306_animals_dead` >= 1 + journal 05_talk_aaron succeeded (statement says "defeated"), aaron |
| phantom.easy.fate | murdered | UNMAPPED: no-speaker - Aaron is dead; Coach Fred is out of lane |
| phantom.easy.fate | controlled | MAPPED `pm5.easy.fate-controlled`: journal mq306_dumpster/04b_angie_meeting/03talk_to_angie succeeded (scene node 204 socket Succeeded), aaron |
| phantom.show.meeting | heard | MAPPED `pm5.show.steven-meeting`: journal talk_with_steven succeeded (section 124 is mandatory), steven-santos (private). Ana Friedman not added: she is not shown present |
| phantom.show.payment | received | MAPPED `pm5.show.steven-payment`: same journal (section 124 + GiveReward node 191, no refusal option), steven-santos |
| phantom.intro.entry | normal | UNMAPPED: out-of-scope - save provenance metadata, no quest writer |
| phantom.intro.entry | skip | UNMAPPED: out-of-scope - same; only `ep1_standalone` exists |
| phantom.lucretia.intruders | killed | UNMAPPED: no-speaker - squat scene has only Myers and Johnny; Reed not yet met, Songbird absent |
| phantom.lucretia.oath | sworn | UNMAPPED: no-speaker - `q302_oath_pledged` is a valid positive signal (A=1) but Myers is the only witness and is not on the roster |
| phantom.lucretia.oath | declined | UNMAPPED: zero-only + no-speaker |
| phantom.birds.reed-disclosure | told | MAPPED `pm5.birds.reed-told-escape-plan`: fact `q304_told_reed` >= 1 (q304_04d node 2083, only from choice 3568 opt 1), solomon-reed. Alex and Songbird not added: not shown present |
| phantom.birds.reed-disclosure | withheld | UNMAPPED: zero-only - choice 3568 opt 0 has no writer |
| phantom.birds.alex-evening | shared | MAPPED `pm5.birds.alex-dance`: fact `q304_04e_v_danced_again` >= 1 (q304_04e node 2707, Join Alex branches), alex |
| phantom.firestarter.alex-fate | alive | MAPPED `pm5.firestarter.alex-alive`: `q304_songbirds_path` + `q304_lab_done` + `holo_alex_calls_v_complete` >= 1 (q306_06_epilogues node 228, after Alex's holocall), alex |
| phantom.firestarter.hansen | killed-by-alex | MAPPED `pm5.firestarter.hansen-killed-by-alex`: `q304_songbirds_path` + `q304_lab_done` + `q304_kurt_dead` >= 1 (lab scene: choice 503 [Give signal to Alex] -> "Target down" -> songbirds_path), alex. Mr. Hands not added: no verified knowledge path |
| phantom.damaged.request | heard | MAPPED `pm5.damaged.songbird-begged-to-die`: fact `q305_songbird_alive` >= 1 (every path to writer 659 passes the plea), songbird (private) |
| phantom.damaged.blueprint | erebus | UNMAPPED: no-native-signal - inventory only |
| phantom.damaged.blueprint | canto | UNMAPPED: no-native-signal - inventory only |
| phantom.silence.medal | refused | UNMAPPED: zero-only - choice 131 opt 2 has no writer |
| phantom.sympathy.coin | kept | UNMAPPED: zero-only |
| phantom.monte.postcard | received | UNMAPPED: no-native-signal - onscreen shard, a class the runtime cannot capture |
| phantom.forever.treatment | deferred | UNMAPPED: transient - `q307_call_reed_refused` is later superseded by the confirmed flag |
| phantom.balls.plan | frame-yuri | MAPPED `pm5.balls.plan-frame-yuri`: fact `mq301_03_frame_jurij` >= 1 (mq301_03_delivery node 1589, choice 1809 opt 0), paco-torres + babs-okoye |
| phantom.balls.plan | smuggle-paco | MAPPED `pm5.balls.plan-smuggle-paco`: fact `mq301_03_run_paco` >= 1 (node 1585, after Babs stays and Paco agrees), paco-torres + babs-okoye |
| phantom.balls.plan | nomad-help | MAPPED `pm5.balls.plan-nomad-help`: Paco phone msg mq301_01_msg_on_the_run active/succeeded (mq301_06_contacts, non-river branch), paco-torres + babs-okoye |
| phantom.balls.plan | replace-generators | MAPPED `pm5.balls.plan-replace-generators`: Paco phone msg mq301_02_msg_helped_out active/succeeded (mq301_06_contacts cond 107 river_help True branch), paco-torres + babs-okoye |
| phantom.balls.result | paco-executed | MAPPED `pm5.balls.result-paco-executed`: journal 02a_search_squot1 succeeded + V's phone choice "They got him, Babs" succeeded, babs-okoye only (Paco is dead) |
| phantom.balls.result | paco-scav | MAPPED `pm5.balls.result-paco-scav`: fact `mq301_paco_afterlife_done` >= 1 (mq301_05_run node 4518, after "Got in with scavs"), paco-torres only |
| phantom.balls.result | both-kenya | MAPPED `pm5.balls.result-both-kenya`: Paco phone msg mq301_01_msg_nairobi active/succeeded, paco-torres + babs-okoye |
| phantom.balls.result | both-barghest | MAPPED `pm5.balls.result-both-barghest`: same predicate as replace-generators (Paco's good-news / thank-you messages), paco-torres + babs-okoye |
| phantom.symptoms.alan-revealed | revealed | MAPPED `pm5.symptoms.alan-revealed`: journal sts_ep1_12/05b_talk_to_target succeeded (sts_ep1_12_phase node 146, cooperation route; other routes set Failed), alan-noel (private) |
| phantom.corpo.reward | received | MAPPED `pm5.corpo.alan-reward`: Alan's wst_ep1_02 reward message (either variant) active/succeeded, alan-noel (private) |
| phantom.mistakes.business | opened | MAPPED `pm5.mistakes.bill-hotdog-stand`: journal wst_ep1_11/talk_bill succeeded (only after hotdog_finished > 0), bill-mitchell |
| phantom.mistakes.payment | accepted | UNMAPPED: no-native-signal - both choice-21 branches reach hotdog_finished; GiveReward is not a fact |
| phantom.mistakes.payment | declined | UNMAPPED: no-native-signal - same |
| phantom.foreman.rinder-followup | message-received | UNMAPPED: no-speaker - private Rinder-V texts; Briana is not a party and Rinder is not on the roster |
| phantom.foreman.rinder-followup | contact-encouraged | UNMAPPED: no-speaker - same |
| phantom.foreman.rinder-followup | contact-discouraged | UNMAPPED: no-speaker - same |
| phantom.foreman.briana-discovery | confronted | MAPPED `pm5.foreman.briana-confronted`: fact `hana_default_angry_dialogue_finished` >= 1 (sts_03_hana_default node 64, after "letting Rinder live"), briana-dolson |
| phantom.oneway.ambush | ambushed | UNMAPPED: no-speaker - Nele was impersonated and not present |
| phantom.oneway.evidence | read | UNMAPPED: no-speaker - evidence is onscreen shards |
| phantom.jungle.steven-request | received | MAPPED `pm5.jungle.steven-request`: Steven's phone msg destroy_biomonitor active/succeeded, steven-santos (private) |

Totals: 23 mapped, 21 unmapped (no-native-signal 6, zero-only 4 (oath.declined also no-speaker), no-speaker 8, transient 1, out-of-scope 2).
