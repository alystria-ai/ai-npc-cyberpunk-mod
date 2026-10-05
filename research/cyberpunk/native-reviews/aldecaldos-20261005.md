# Aldecaldos lane (al5, 2026-10-05)

Rules: `research/cyberpunk/native-rules/aldecaldos-20261005.json` (written by `lanes/aldecaldos-author.mjs`, prefix `al5`).
Result: 24 of 67 outcomes mapped; 43 unmapped (out-of-scope 2, no-native-signal 8, no-speaker 21, ambiguous-meaning 3, zero-only 4, not-in-2.31 1, shared-writer 1, told-by-v 3).
Two of the unmapped outcomes (ghost.nash/declined, queen.romance/platonic) have verified predicates but are blocked by the topic-alias check.

## Method
- Exported the still-unbound questphases and the missing Dakota-gig scenes/phases into batches al5-05 .. al5-10 (hash-bound) and cited only those.
- Re-verified each handoff predicate in the graph (positive writer, branch-specific route, durability), then examined the Dakota gigs / reward.
- Fact predicates are positive writers only; journal predicates use succeeded, active|succeeded (messages), or failed where the failure is the outcome.
- Speakers are limited to affected characters with a native knowledge path: participant (own scene/message), witnessed (present at the party), private (own message).

## Findings worth knowing
- `priority-panam.native.pilot-destination` (existing, not edited) can never fire: `q104_pilot_gas_station` has no writer in any exported questphase or scene (comparisons only; absent in all 12 saves), so the True branch of q104_tracking_av is dead. The new `al5.wartime.tracks-followed` is the only live alternative of that topic.
- `mq001_abandoned` can also be set by the forced abort when Queen of the Highway starts (`sq027_immediate_abort_mq001`); either way Mitch's send-off was missed, which is all the rule says.
- `mq002_escaped` is also set from mq002_ending (V leaves after the deal but before talking to Carol), so the abandoned rule additionally requires Carol's own reproach message, which is sent only when the quest is not Succeeded.
- Dakota's holocall debrief journal entries are not persisted in saves B/C even where the gig is finished (seen for ina_02 and ina_05), so debrief-text predicates would never resolve; Dakota rules use durable facts/objectives whose branch is the same one the debrief uses. In ina_05 the debrief selector is inverted inside the bruce_left_alone branch (kill -> text "03...optional_done"), hence the `ina_05_archi_talk_ended` guard on both casualty rules (Bruce was delivered to Archibald).
- The Devil call scene (`q201_05_cabin_day_7` node 2402) branches on `sq027_panam_lover`, while the existing `priority-endings.panam.devil-romantic-call` keys on `q115_panam_romance_chosen`; save E2 has lover=1, romance_chosen absent and the call done, so the angry-lover call is not covered by any rule (under-coverage, not a wrong statement).
- `q114_bottle_hit` threshold: the scene treats 11 hits as a pass (Cassidy praises and offers the revolver) although the objective text says 12.
- Duplicate predicates: `goodbye.future-membership` and `together.returning-contacts/bruce-present` share one predicate by design; they are different topics so they cannot contradict.

## Disposition of all 67 outcomes

| decision | outcome | disposition |
|---|---|---|
| aldecaldos.ghost.nash | declined | UNMAPPED: out-of-scope - predicate is solid (Rogue's q103_clean_deal text is sent only when q103_helped_panam is 0) but the decision already has a reviewed topic-alias domain (`aldecaldos.native.panam-nash-assistance` -> `panam.nash-assistance`); an exact-catalog-topic alternative is rejected by the topic-identity check and a joined topic needs a row in `native-topic-aliases.json`, which this lane may not edit. Candidate: journal `contacts/rogue/q103/q103_clean_deal` active|succeeded, speakers panam-palmer + rogue-amendiares (fires in no save, all saves helped). Reproduce with `AL5_BLOCKED=1 node lanes/aldecaldos-author.mjs`. |
| aldecaldos.wartime.mitch-rescue | panam-alone | UNMAPPED: no-native-signal - Mitch's rescue is positive in every save and no writer records a Panam-alone rescue. |
| aldecaldos.wartime.pilot-information | tracks-followed | MAPPED `al5.wartime.tracks-followed` (journal objective `finding_courier/scan_tire_tracks` succeeded (only writer in the False branch of the q104_pilot_gas_station test); panam-palmer; fires in all saves) |
| aldecaldos.riders.farmhouse | not-established | UNMAPPED: no-speaker - non-outcome with empty affects. |
| aldecaldos.fly.farewell | attended | MAPPED `al5.farewell.attended` (quest `mq001_scorpion` succeeded (only after the cliff scene ends); mitch-anderson (private); fires A,E*,B,C,F) |
| aldecaldos.fly.farewell | missed | MAPPED `al5.farewell.missed` (fact `mq001_abandoned` >= 1 (single writer on the abandon path, quest Failed); mitch-anderson (private); fires D) |
| aldecaldos.friends.loyalty | declined-initially | UNMAPPED: no-native-signal - the refusal at choice 576 has no persistent writer and V can still join at the station. |
| aldecaldos.friends.tower-talk | personal-support | UNMAPPED: ambiguous-meaning - sq027_panam_impulsive comes from two different exchanges (confirmed by the prior review). |
| aldecaldos.friends.campfire | heard | UNMAPPED: no-native-signal - the Scorpion/Saul account is an optional option at choice 331 with no writer. |
| aldecaldos.queen.romance | platonic | UNMAPPED: out-of-scope - predicate is solid (Panam's friendship hook text `q114_panam_ending_hook_friendship/02_msg_panam_friend` exists only on the False side of `sq027_panam_lover > 0`; fires B,F) but the decision has a reviewed topic-alias domain (`aldecaldos.native.panam-basilisk-intimacy`), so the same alias-row blocker applies as for ghost.nash/declined. It is already used as the guard of `al5.devil.called-platonic`. Reproduce with `AL5_BLOCKED=1`. |
| aldecaldos.queen.nash | encountered | UNMAPPED: no-native-signal - no persistent encounter marker. |
| aldecaldos.queen.policy | contract-ended | UNMAPPED: no-native-signal - Saul's "We are done here" is an email (`onscreens/emails/.../saul_vs_biotecnica`), which the runtime cannot capture. |
| aldecaldos.gun.deal | intimidated | MAPPED `al5.gun.deal-intimidated` (fact `mq002_deal_proceeded` >= 1 (single writer, reached only from V's implant-threat line) + quest `mq002_veterans` succeeded; carol-emeka, cassidy-righter; fires A,E*,B,C,D) |
| aldecaldos.gun.deal | firefight | MAPPED `al5.gun.deal-firefight` (objective `03_fight` succeeded (active only on combat, succeeded after scavs defeated); carol-emeka, cassidy-righter; fires in no save) |
| aldecaldos.gun.deal | abandoned | MAPPED `al5.gun.deal-abandoned` (fact `mq002_escaped` >= 1 (leave-area exits that fail the quest) + Carol's own `mq002_escaped` message (sent only when the quest is not Succeeded); carol-emeka; fires in no save) |
| aldecaldos.gun.panam-message | received | MAPPED `al5.gun.panam-message` (Cassidy's `sq004_followup/02_quote` message active|succeeded (gated on sq004_var_kissed_panam == 1); cassidy-righter (private); fires A,E0,E1,D; statement does not name Gun Music) |
| aldecaldos.fortunate.request | accepted | MAPPED `al5.fortunate.request-accepted` (objective `04_meeting` active|succeeded (starts only after the briefing accept); bob-sagan; fires A,E*,B,C,D) |
| aldecaldos.fortunate.malware | discovered | UNMAPPED: no-speaker - empty affects (the signal would be mq021_happy_ending, used by the delivered-informed rule). |
| aldecaldos.fortunate.malware | not-discovered | UNMAPPED: no-speaker - empty affects; also zero-only. |
| aldecaldos.fortunate.implant | delivered-informed | MAPPED `al5.fortunate.implant-informed` (fact `mq021_happy_ending` >= 1 (doctor reveal + shard) + objective `08_outcome` succeeded (set when V sets the implant down for Bob); bob-sagan; fires A,E*,C) |
| aldecaldos.fortunate.implant | delivered-uninformed | UNMAPPED: zero-only - would need mq021_happy_ending absent. |
| aldecaldos.fortunate.result | recovered | MAPPED `al5.fortunate.result-recovered` (facts `mq021_happy_ending` >= 1 and `mq021_bob_ending_approached` >= 1 (Bob's "easin' into it" line) + quest succeeded; bob-sagan; fires C) |
| aldecaldos.fortunate.result | died | UNMAPPED: zero-only - would need mq021_happy_ending absent while Bob was approached (saves B,D,D2 look like this but absence cannot be used). |
| aldecaldos.nocturne.partner-call | other-or-no-call | UNMAPPED: no-speaker - empty affects. |
| aldecaldos.nocturne.help | other-route | UNMAPPED: no-speaker - empty affects. |
| aldecaldos.together.alt-link | completed | MAPPED `al5.together.alt-link` (objectives `dakota_carol_wrap` and `talk_alt` succeeded; carol-emeka, dakota-smith (told they did not hear the Alt talk); fires E4) |
| aldecaldos.together.shooting | won | MAPPED `al5.together.shooting-won` (fact `q114_bottle_hit` >= 11 (the scene's pass line) + objective `shoot_bottles` succeeded; cassidy-righter; E4 has 7 hits so it does not fire) |
| aldecaldos.together.shooting | lost | UNMAPPED: zero-only - would need q114_bottle_hit <= 10 (E4 has 7 but only via a comparison, no positive writer for "lost"). |
| aldecaldos.together.shooting | not-played | UNMAPPED: no-speaker - empty affects. |
| aldecaldos.together.returning-contacts | jake-present | MAPPED `al5.together.jake-present` (fact `mq021_happy_ending` >= 1 + party objective `talk_panam` succeeded (q114_party spawns Jake only on happy > 0); bob-sagan (witnessed); fires E4) |
| aldecaldos.together.returning-contacts | ben-present | UNMAPPED: no-speaker - empty affects. |
| aldecaldos.together.returning-contacts | bruce-present | MAPPED `al5.together.bruce-present` (fact `ina_05_done` >= 1 + party objective `talk_panam` succeeded (q114_party spawns Bruce only on ina_05_done > 0); dakota-smith (witnessed: Dakota is at the party); fires in no save (E4 lacks ina_05_done)) |
| aldecaldos.together.returning-contacts | anna-present | UNMAPPED: no-speaker - empty affects. |
| aldecaldos.belly.alt-casualties | witnessed | UNMAPPED: no-native-signal - q114_13_alt_plugged_in has no casualty dialogue or marker. |
| aldecaldos.changes.body | johnny-returned | UNMAPPED: no-speaker - empty affects. |
| aldecaldos.watchtower.partner | river-stays | MAPPED `al5.watchtower.river-stays` (objective `temp_river/say_goodbye` succeeded after River's "I can't go with you"; river-ward (private); fires in no save) |
| aldecaldos.watchtower.partner | kerry-stays | MAPPED `al5.watchtower.kerry-stays` (objective `temp_river/talk_kerry` succeeded after Kerry's "I can't leave"; kerry-eurodyne (private); fires in no save) |
| aldecaldos.watchtower.partner | no-partner-scene | UNMAPPED: no-speaker - empty affects. |
| aldecaldos.devil.panam-call | called-platonic | MAPPED `al5.devil.called-platonic` (existing key `endings.devil.panam-orbital-call` succeeded + Panam's friendship hook text active|succeeded (lover flag False => friendly greeting in q201_05_cabin_day_7); panam-palmer (private); fires in no save) |
| aldecaldos.temperance.panam-message | romantic-message-observed | MAPPED `al5.temperance.panam-texts` (Panam's `q204/05_panam_msg_ill_find_you` message active|succeeded (subphase only on q115_panam_romance_chosen > 0); panam-palmer (private); fires E3) |
| aldecaldos.temperance.panam-message | platonic-update-observed | UNMAPPED: not-in-2.31 - only the romance-gated Panam q204 messages exist. |
| aldecaldos.tower.contact | unanswered | UNMAPPED: no-speaker - the call hits "outside service area" (q307_call_panam_end); Panam never receives it. |
| aldecaldos.tower.contact | mitch-boundary-message | UNMAPPED: shared-writer - the final board `q307_ending_03_mitch` is gated on q307_panam_called, written by both the pre-coma text and the post-coma call, and plays post-credits with no durable marker (also transient). |
| aldecaldos.blacksteel.carol-call | declined-offered-gift | MAPPED `al5.blacksteel.carol-declined-gift` (fact `q305_asked_carol_help` >= 1 (only after the Carol_main_call_out exit = her refusals) + Carol's `q305_ambush_gift/01_carol_additional_question` message active|succeeded; carol-emeka; fires in no save) |
| aldecaldos.blacksteel.gift | collected | UNMAPPED: told-by-v - objective pick_carol_gift exists but Carol has no knowledge path to the pickup. |
| aldecaldos.minefield.body | examined | UNMAPPED: no-speaker - empty affects. |
| aldecaldos.flying.method | power-cut | UNMAPPED: no-speaker - empty affects. |
| aldecaldos.flying.method | destroyed | UNMAPPED: no-speaker - empty affects. |
| aldecaldos.flying.method | remote-overload | UNMAPPED: ambiguous-meaning - Dakota's `sts_bls_ina_03_debrief_shortcut` text is selected by `#ina_03_proper` (a trigger area at the outpost was never entered), which does not isolate a remote hack; objective `netrunner_destroy` has no questphase writer I could find and is absent in every save (also catalog told-by-v). |
| aldecaldos.pete.resolution | killed | UNMAPPED: ambiguous-meaning - `ina_02_big_pete_dead` is set by a condition with killed=1 defeated=1 unconscious=1, so it also covers a knocked-out Pete (and the debrief reuses it); the debrief journal entries are not persisted in saves B/C. |
| aldecaldos.pete.resolution | spared-paid | UNMAPPED: no-native-signal - `ina_02_big_pete_spared` is written by the spare choices ("Deal." and "Fine, but I don't want your money") alike; the payment is only a questGiveReward node (185) on the "Eddies. Now." path with no fact. |
| aldecaldos.pete.resolution | spared-unpaid | UNMAPPED: no-native-signal - same as spared-paid: no durable marker separates paid from unpaid. |
| aldecaldos.pete.tiny-mike | recognized | UNMAPPED: no-speaker - empty affects. |
| aldecaldos.nofixers.rescue | delivered-without-van | UNMAPPED: zero-only - needs ina_06_car_delivered absent; Dakota's only debrief text (`sts_bls_ina_06_debrief`, "leaving her high and dry") belongs to the `ina_06_tanner_left_alone` branch (Iris abandoned), not to "delivered without the van". |
| aldecaldos.nofixers.followup | message-received | MAPPED `al5.nofixers.iris-thanks` (Iris Tanner's `ina_06_optional_objective_reward` message active|succeeded (sent after the gig on the car_delivered > 0 chain); iris-tanner (private); fires A,E0,E4,B,F (contact inactive in E2/E3)) |
| aldecaldos.trevor.remains | identified | UNMAPPED: no-speaker - empty affects. |
| aldecaldos.mia.betrayal | confirmed | UNMAPPED: told-by-v - Dakota's ina_09 debrief texts ("Benedict's safe", "carelessness...") do not mention Jason's betrayal; that finding lives only in V's Jason scene. |
| aldecaldos.mia.jason | killed | UNMAPPED: no-speaker - empty affects. |
| aldecaldos.mia.jason | incapacitated | UNMAPPED: no-speaker - empty affects. |
| aldecaldos.mia.jason | avoided | UNMAPPED: no-speaker - empty affects. |
| aldecaldos.sparring.software | recovered | UNMAPPED: no-speaker - empty affects. |
| aldecaldos.goodbye.casualties | no-personnel-killed | MAPPED `al5.goodbye.no-personnel-killed` (objective `dont_kill_militech` succeeded + facts `ina_05_finished` and `ina_05_archi_talk_ended` >= 1; dakota-smith; fires C) |
| aldecaldos.goodbye.casualties | personnel-killed | MAPPED `al5.goodbye.personnel-killed` (objective `dont_kill_militech` failed (set when a listed guard/worker is killed=1 defeated=0) + `ina_05_finished` and `ina_05_archi_talk_ended` >= 1; dakota-smith; fires B) |
| aldecaldos.goodbye.future-membership | seen-at-camp | MAPPED `al5.goodbye.seen-at-camp` (same predicate as bruce-present (`ina_05_done` >= 1 + party `talk_panam`), different topic `bruce.aldecaldo-membership`; dakota-smith (witnessed); fires in no save) |
| aldecaldos.radar.prototype | acquired | UNMAPPED: no-speaker - empty affects. |
| aldecaldos.reward.recognition | offered | MAPPED `al5.reward.offered` (Dakota's `dakota_global_msg/badlands_reward` message active|succeeded; dakota-smith; fires B,C) |
| aldecaldos.reward.recognition | collected | UNMAPPED: told-by-v - objective `get_reward` succeeds when V mounts the gift vehicle in the garage; Dakota has no knowledge path to the pickup. |
