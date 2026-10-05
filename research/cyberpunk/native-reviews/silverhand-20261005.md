# Silverhand lane (sh5) - native outcome mapping

Reviewed 2026-10-05 against installed Cyberpunk 2077 2.31 assets. Rules: `research/cyberpunk/native-rules/silverhand-20261005.json`
(20 rules, prefix `sh5`, 32 evidence rows, 10 facts, 11 journal selectors), written by the rerunnable author script
`KIT/lanes/silverhand-author.mjs`. Evidence is hash-bound to scene-evidence batches `sh5-01` (q307_03a_friends_holocall, q101_07_ripperdoc),
`sh5-02` (q203_01/02/03 scenes, used only to confirm `q203_coffee_empty` is written in the Kerry scene alone) and `sh5-03` (q103_11_tunnel_drive,
re-exported because the aldecaldos copy was unbound). `check-lane silverhand-20261005` (full) ends with 0 merge/runtime errors, 0 evidence/topic
errors, 68 verified pointers and 0 topic contradictions.

## Method

- Every outcome in the lane handoff (62) was traced upstream with `graph.mjs` / `q.mjs`. A predicate is accepted only when it is positive
  (fact >= 1 from a positive `questSetVar`, or journal `succeeded` / `active|succeeded`), branch-specific, durable and has a verified knowledge path
  for a roster speaker. Fact names were treated as hints and confirmed by the graph route or the entry's English text.
- Speakers are the characters present in the scene or joint objective (Johnny for the Johnny-in-V's-head beats; Kerry for his own calls and scenes;
  Nancy and Panam for their own storylines). Kerry's morning, orbital, tower and rooftop calls are private to Kerry.
- Adam Smasher kills: the Aldecaldo and Rogue routes use `q116_smashero_deado` (written in `q116_03b_after_bossfight` only after a player-hit condition;
  the walk-away branch writes nothing). The solo route uses `q116_smasher_shot` (written after the defeat in `q115_solo_smasher`). Each is
  stage-guarded by its route marker so the three kill alternatives never co-fire. The Arasaka-route kill shares a journal node with the spare
  choice and has no fact, so it is unmapped.
- "Spared / declined / not-X" outcomes are almost always zero-only or an absence of the positive branch, so they stay unmapped.
- Johnny's `forever.farewell-conciliatory` requires `sq032_johnny_friend` (grave scene) plus the Nusa boarding and `q307_2079`.
- Rules firing in save A: nash-detour-assisted, boat.no-yacht-intimacy, rebel.diner-coffee, resurrection.johnny-proposal, resurrection.relic-diagnosis,
  second-conflict.brick. None contradicts the A/E-save stories (E3 is the Rogue route, so only `knockin.smasher-killed` fires there; E0 is the solo
  route, so only `reaper.smasher-killed` fires there).

## Suspicious existing rule (not edited)

- `silverhand.backstage-reconciled` is keyed on `sq017_selfie`. That fact is written at choice 583 of `sq017_10` (the group-selfie suggestion), so it
  covers only the group-selfie subset of the "Kerry and Us Cracks reconciled" outcome, not the whole reconciliation. The new rules
  `sh5.uscracks.group-selfie` and `sh5.offleash.premiere-reconciled` use the same fact with different, narrower statements and stage guards. The existing
  rule's statement should be checked against that narrower meaning.
- The brief says E0/E1 are the Sun ending via the Rogue route, but the saves show `q115_did_it_solo=1` and no `q115_rogue_in_av`: E0/E1 are the solo
  route and E3 is the Rogue route.

## Dispositions (all 62 outcomes)

| # | decision | outcome | disposition |
|---|---|---|---|
| 1 | ghost-town / nash-detour | assisted | MAPPED `sh5.ghost-town.nash-detour-assisted`: `q103_helped_panam >= 1` (q103_11 node 101, after choice 56/0); Johnny |
| 2 | ghost-town / nash-detour | declined | UNMAPPED: no-native-signal - refusal 56/1 only activates the roadhouse/ride objective, which the accept path also reaches |
| 3 | nocturne-op55n1 / final-route | suicide | UNMAPPED: no-speaker - fatal ending, no living continuity |
| 4 | nocturne-op55n1 / final-route | nusa | MAPPED `sh5.nocturne.final-route-nusa`: journal `q307_before_tomorrow/00_hook/04_enter_av` succeeded; Johnny |
| 5 | nocturne-op55n1 / rooftop-kerry-call | called | MAPPED `sh5.nocturne.rooftop-kerry-call`: journal `q115_ripperdoc/02a2_call_kerry` succeeded; Kerry (private) |
| 6 | belly-of-the-beast / aldecaldo-route-smasher-fate | killed | MAPPED `sh5.belly.smasher-killed`: `q116_smashero_deado >= 1` + Aldecaldo route marker; Panam, Johnny |
| 7 | belly-of-the-beast / aldecaldo-route-smasher-fate | spared | UNMAPPED: zero-only - the walk-away branch writes nothing |
| 8 | changes / mikoshi-jackie | engram | UNMAPPED: no-speaker - no roster character is affected (Jackie's knowledge ends at the Heist) |
| 9 | changes / mikoshi-jackie | pendant | UNMAPPED: no-speaker - no roster character is affected |
| 10 | path-of-glory / rogue-afterlife | absent-after-death | UNMAPPED: no-speaker - no roster character is affected |
| 11 | path-of-glory / kerry-sendoff | present | MAPPED `sh5.sun.kerry-morning`: journal `q203_legend/penthouse/talk_kerry` active or succeeded + `q203_coffee_empty >= 1` (written in the Kerry scene after the talk); Kerry |
| 12 | path-of-glory / crystal-palace-job | departed | UNMAPPED: no-speaker - no roster character is affected |
| 13 | where-is-my-mind / orbital-contract | signed | UNMAPPED: no-speaker - no roster character is affected |
| 14 | where-is-my-mind / orbital-contract | earth | UNMAPPED: no-speaker - no roster character is affected |
| 15 | where-is-my-mind / orbital-envoy | takemura | UNMAPPED: no-speaker - `goro-takemura` is not a roster key (Takemura's visit is already covered by `priority-endings.takemura.orbital-visitor`) |
| 16 | where-is-my-mind / orbital-envoy | hellman | UNMAPPED: no-speaker - `anders-hellman` is not a roster key |
| 17 | where-is-my-mind / orbital-kerry-call | spoke | MAPPED `sh5.orbital.kerry-call`: journal `q201_heir/06_cabin_day_3/02_talk_to_kerry` succeeded; Kerry |
| 18 | new-dawn-fades / temperance-memorials | v-and-rogue | UNMAPPED: no-native-signal - the Rogue-niche choice (q204_08 choice 9) only removes an item and converges at nodes 41/72 |
| 19 | things-done-changed / surgery-outcome | cured-with-cost | UNMAPPED: no-speaker - no roster character is affected |
| 20 | things-done-changed / kerry-contact | spoke | MAPPED `sh5.tower.kerry-call`: `q307_call_kerry_end >= 1` (q307_03a_friends_holocall node 634) + `q307_2079`; Kerry |
| 21 | things-done-changed / tower-return | returned | UNMAPPED: no-speaker - no roster character is affected |
| 22 | playing-for-time / relic-diagnosis | heard | MAPPED `sh5.resurrection.relic-diagnosis`: journal `q101_resurrection/takemura/talk_with_johnny` succeeded, evidence q101_07_ripperdoc choice 1331 -> 1268 (all options); Johnny |
| 23 | playing-for-time / diner-cooperation | proposed | MAPPED `sh5.resurrection.johnny-proposal`: same journal entry, reached only after the "help each other ... start with Rogue" section (q101_08 node 560 after 603); Johnny |
| 24 | transmission / voodoo-outcome | peaceful-departure | UNMAPPED: zero-only - the peaceful branch writes no positive fact |
| 25 | transmission / voodoo-outcome | v-initiated-fight | UNMAPPED: no-native-signal - `q110_voodoo_queen_dead` is shared with the history and Netwatch outcomes |
| 26 | totalimmortal / arasaka-route-smasher-fate | killed | UNMAPPED: shared-writer - q113_13_adam_smasher choice 21 and the killed condition 61 both feed journal 227 `03b_decide_adam`; no fact (also affects only Smasher, not a roster speaker) |
| 27 | totalimmortal / arasaka-route-smasher-fate | spared | UNMAPPED: shared-writer - same node as #26; no distinct positive signal |
| 28 | totalimmortal / arasaka-assault-companion | present | UNMAPPED: no-speaker - `goro-takemura` is not a roster key |
| 29 | totalimmortal / arasaka-assault-companion | absent | UNMAPPED: no-speaker - no roster character is affected (also absence-only) |
| 30 | totalimmortal / yorinobu-confronted | completed | UNMAPPED: no-speaker - no roster character is affected |
| 31 | second-conflict / totentanz-leadership | brick | MAPPED `sh5.second-conflict.brick`: journal `sq011_johnny/04_nancy/01_talk_to_nancy1` succeeded (sq011_07b_thugs node 870, after the Brick section 846); Nancy, Johnny (witnessed) |
| 32 | second-conflict / totentanz-leadership | patricia | MAPPED `sh5.second-conflict.patricia`: journal `01_talk_to_patricia_about_nancy` succeeded + `sq011_patricia_combat_path >= 1` (written only after brick_saved is False); Nancy, Johnny (witnessed) |
| 33 | second-conflict / nancy-data | recovered | MAPPED `sh5.second-conflict.nancy-data`: `sq011_nancy_files_received >= 1` (sq011_07a_royce node 2977, data-copy choice 427/0) + `jr-priority.nancy.escape`; Nancy |
| 34 | i-dont-wanna-hear-it / uscracks-photo | taken | MAPPED `sh5.uscracks.group-selfie`: `sq017_selfie >= 1` (sq017_10 node 547, choice 583 options 1/2) + riot_club quest succeeded; Kerry, Blue Moon (Red Menace and Purple Force are not given the rule - no verified knowledge path) |
| 35 | psychofan / psychofan-pants | recovered | UNMAPPED: no-native-signal - item pickup, no objective or fact |
| 36 | who-wants-to-live-forever / surgery-departure | boarded | MAPPED `sh5.forever.surgery-boarded`: journal `04_enter_av` succeeded; Johnny |
| 37 | who-wants-to-live-forever / surgery-departure | postponed | UNMAPPED: transient - `02c_leave_rooftop` can be followed by boarding, so it would co-fire with `boarded` |
| 38 | who-wants-to-live-forever / surgery-goodbye | conciliatory | MAPPED `sh5.forever.farewell-conciliatory`: `sq032_johnny_friend >= 1` (grave scene node 1483) + `04_enter_av` succeeded + `q307_2079 >= 1`; Johnny (private) |
| 39 | who-wants-to-live-forever / surgery-goodbye | hostile | UNMAPPED: zero-only - False branch of `sq032_johnny_friend` |
| 40 | love-like-fire / kerry-farewell-tone | encouraging | UNMAPPED: zero-only - `q101_kerry_insult` is 0 at node 1154; the encouraging branch has no positive fact |
| 41 | tapeworm / rogue-control-agreement | agreed | UNMAPPED: no-native-signal - sq032_07_finale choices 64/65 converge at node 244 with no fact |
| 42 | tapeworm / rogue-control-agreement | declined | UNMAPPED: no-native-signal - same convergence as #41 |
| 43 | chippin-in / grayson-interrogation | heard | UNMAPPED: no-native-signal - optional choice 133/2, no fact |
| 44 | chippin-in / oilfield-reconciliation | other-conversation | UNMAPPED: zero-only - `sq031_05_refused` precedes choice 605, which can still reach the friend branch; "Too late" 607 writes nothing |
| 45 | chippin-in / rogue-date-invitation | declined | UNMAPPED: no-native-signal - "Forgot about that" 697/1 writes no fact and rejoins the main flow |
| 46 | blistering-love / drive-in-intimacy | not-initiated | UNMAPPED: zero-only |
| 47 | a-like-supreme / archangel-gift | received | UNMAPPED: no-native-signal - item grant only |
| 48 | rebel-rebel / diner-followthrough | completed | MAPPED `sh5.rebel.diner-coffee`: journal `sq017_kerry/caliente/have_breakfast` succeeded (sq017_06 node 670); Kerry |
| 49 | rebel-rebel / diner-followthrough | abandoned | UNMAPPED: ambiguous-meaning - the `fail_cleanup` In_highwaymen failure happens before the coffee meeting |
| 50 | off-the-leash / collaboration-event | present | MAPPED `sh5.offleash.premiere-reconciled`: `sq017_selfie >= 1` + `sq017_02_lounge` quest succeeded; Kerry |
| 51 | off-the-leash / terrace-kiss | not-kissed | UNMAPPED: zero-only - decline 468/206 writes no fact |
| 52 | boat-drinks / yacht-intimacy | occurred | UNMAPPED: no-native-signal - `sq028_kerry_sex` is written at scene start, before the [Kiss]/[Stop] choice 10 |
| 53 | boat-drinks / yacht-intimacy | not-occurred | MAPPED `sh5.boat.no-yacht-intimacy`: journal `sq028_kerry_romance/cruiser/talk_kerry2` succeeded (sq028_02_cruiser nodes 18/22; the sex path exits via `sex_ending` and never touches it); Kerry (private) |
| 54 | killing-in-the-name / nancy-disclosure | withheld | UNMAPPED: zero-only - mq018_03 choice 21/1 writes no fact |
| 55 | family-heirloom / family-shoes | recovered | UNMAPPED: no-native-signal - item pickup, no objective or fact |
| 56 | the-union-strikes-back / union-collateral | others-killed | UNMAPPED: ambiguous-meaning - `rcr_01_hurt_civilians` is a health-threshold hurt, not a death |
| 57 | nasty-hangover / kang-tao-payment | not-accepted | UNMAPPED: ambiguous-meaning - `arr_06_combat_kang_tao` can start before or independently of the offer |
| 58 | knockin-on-heavens-door / rogue-route-smasher-fate | killed | MAPPED `sh5.knockin.smasher-killed`: `q116_smashero_deado >= 1` + `q115_rogue_in_av >= 1`; Johnny |
| 59 | knockin-on-heavens-door / rogue-route-smasher-fate | spared | UNMAPPED: zero-only - walk-away writes nothing |
| 60 | dont-fear-the-reaper / solo-assault-result | fatal-failure | UNMAPPED: no-speaker - fatal ending |
| 61 | dont-fear-the-reaper / solo-route-smasher-fate | killed | MAPPED `sh5.reaper.smasher-killed`: `q116_smasher_shot >= 1` (q115_solo_smasher node 19, hit after the defeat) + `q115_did_it_solo`; Johnny |
| 62 | dont-fear-the-reaper / solo-route-smasher-fate | spared | UNMAPPED: zero-only - walk-away writes nothing |

Totals: 20 mapped, 42 unmapped (no-native-signal 11, zero-only 10, no-speaker 15, shared-writer 2, transient 1, ambiguous-meaning 3).
