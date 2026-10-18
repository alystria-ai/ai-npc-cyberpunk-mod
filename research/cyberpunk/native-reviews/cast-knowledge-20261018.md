# Cast knowledge: native rules for eight existing characters (2026-10-18)

Characters: `adam-smasher`, `mark-bana`, `r3n0`, `santiago`, `sergei-karasinsky`, `spider-murphy`, `thompson`, `evelyn-parker`.
Before: 0, 0, 0, 0, 0, 0, 0 and 1 compiled rules with the character as a speaker. After: 5, 3, 1, 2, 2, 1, 2 and 6.
Pack: `research/cyberpunk/native-rules/zz-cast-knowledge-20261018.json` (14 new rules; the `zz-` prefix keeps it last in the builder's sorted merge, so no existing source, evidence or allowlist row changes position in `characters/world-knowledge.json`). Five existing rules gained speakers (below). Two topic aliases were added to `native-topic-aliases.json` for the Evelyn shared-journal rules.

## Method
- Audience additions first: an existing source-verified rule whose scene evidence puts the character in the scene. Presence was checked in the scene actor lists and in the screenplay speaker/addressee counts of the exported scenes (see "Scene facts").
- New rules copy the condition, evidence rows, sources and allowlist rows of the reviewed rule they restate (identical rows, no new predicate). Only two evidence rows are new: `ck5.ev.q004-evelyn-with-v` and `ck5.ev.q108-escape-party` (hash-bound pointers into the scene and questphase exports, with `expected` name checks).
- New exports (batches under `cache/game/scene-evidence/`, WolvenKit CLI 9.0.1): `cast-q108-20261018` (q108 phases), `cast-q108-scenes-20261018` (15 q108 scenes), `cast-q108-towerphases-20261018` (tower sub-phases, not cited).
- Every rule links to an existing catalog decision and outcome (the builder requires one), so a rule exists only where the catalog already names the outcome.

## Audience additions (existing rules)
| Rule | Added | Why |
| --- | --- | --- |
| `priority-endings.johnny.saul-killed` | adam-smasher (speaker, recipient) | He is the killer; `q116_01_adam_smasher` has him as an actor, speaker and addressee. |
| `sh5.belly.smasher-killed` | adam-smasher | `q116_03b_after_bossfight`: Smasher speaks 8 lines and is addressed 21 times; the rule's own evidence is the post-fight hit conditions on him. |
| `sh5.reaper.smasher-killed` | adam-smasher | `q115_12d_mikoshi`: Smasher is an actor; the evidence is the post-shot dialogue. |
| `priority-judy.information-judy-met` | evelyn-parker | `q004_03_this_is_judy` actors: Evelyn, Judy, Tbug, player; she brought V (9 of her lines are in the scene). |
| `ahe-native.alt-contact` (told-by-v) | spider-murphy, thompson | The rule already lists outsiders who hear it only after V tells them; Spider and Thompson both knew Alt (dossier relationships) and the statement claims no witnessing. |

## New rules
Smasher (participant, private/phone): `adam-smasher.knockin.killed-rogue` (fact `q116_rogue_dead`, copy of `silverhand.rogue-killed` without the Johnny sentence, same exclusive route group); `adam-smasher.knockin.finished-off` (facts `q116_smashero_deado` and `q115_rogue_in_av`, copy of `sh5.knockin.smasher-killed` without "Johnny in control"). A Smasher copy has no reason to know Johnny controlled V's body (dossier unknown list).
Evelyn: `evelyn-parker.information.met-v` (participant; fact `q004_judy_met` + journal Information completed; links `judy-river.information.introductions/evelyn-met`, which was unmapped). Three shared-journal rules (`disasterpiece.extracted`, `automatic-love.booth-seen`, `double-life.assignment`): conditions and evidence copied from the Judy rules, wording says "the current save's journal records ...", the origin text the runtime adds is "V shared the current-save journal; not witnessed". The booth and assignment rules need pinned aliases (their catalog decisions are aliased domains); they reuse the Judy rules' native topics.
Told-by-V (the character was not there; the rule fires only after a matching disclosure receipt):
- Bana: `mark-bana.spy-jungle.biomonitor-to-ana`, `-destroyed`, `-drop-point` (the three exclusive `bana.evidence.disposition` outcomes; conditions copied from the Steven rules). Bana was dead before V's search, so a participant rule would be false.
- Sergei: `sergei-karasinsky.olive-branch.delivered` and `.released` (conditions from `fo5.olive-branch.delivered` and the Wakako freed-debrief rule). He is not at the diner handover.
- R3n0: `r3n0.spellbound.tablet-sold` (fact `mq015_tablet_sold`; she is not part of the sale to Nix).
- Santiago and Thompson: `cast.never-fade.memory-2013-escape-party` (journal and fact of `priority-endings.johnny.alt-memory`; new scene evidence: Rogue, Santiago, Johnny and Thompson are the actors of `q108_14a_escape` and `q108_14b_lift`, both run by the `q108_04_atlantis` phase). It is Johnny's represented memory, so it is told-by-V and says so. Santiago also gets `santiago.belly-of-the-beast.saul-killed` (copy of the Saul rule; dossier: he was not present).

## Scene facts used (screenplay speaker counts)
`q116_03b_after_bossfight` smasher 8/21; `q113_13_adam_smasher` smasher 10 (Total Immortal; not used, see below); `q004_02_meeting_evelyn` Evelyn 98; `sts_wbr_jpn_01_meeting_sergei` sergei 18; `mq015_03_restaurant` the seller (R3n0) 16.

## Judgement calls
- Smasher knowing his own defeat and death rules: kept, because the dossier lists "after defeat / explicit finishing kill" as participant knowledge so a copy cannot claim unbroken survival, and Smasher speaks in the post-fight scene.
- Evelyn's death (`judy-river.both.evelyn-death`) not given to her: a copy told of her own death is the out-of-story extension the dossier warns about.
- Santiago and Thompson as participants in the 2013 rescue: only told-by-V, following the Alt precedent that Johnny's memory scenes are not the character's own experience.
- Pack file renamed from the requested `cast-knowledge-20261018.json` to `zz-cast-knowledge-20261018.json` to avoid a 130,000-line reorder diff in the compiled pack (the builder keeps first-seen order and sorts pack files by name).

## Could not support with evidence (left out, no `unmapped` filler)
- Spider Murphy: no native scene in the cache names him. In the Soulkiller/2023 memory scenes the only candidate is an unnamed `netrunner` actor who does not speak, so the Love Like Fire memory is not claimed. Only the Alt contact rule.
- Thompson / Santiago 2023 memory (Love Like Fire): same gap.
- Smasher in Total Immortal: the journal has `03_defeat_adam` and `03b_decide_adam`, but no fact or objective state separates "spared" from "killed"; no rule written. Smasher in The Heist (`q005_07_vip_apartment`): he is an actor but speaks no line, so not claimed.
- R3n0 as participant: the restaurant scene branches (pay, corpo negotiation, laptop theft, combat) and the quest graph analysis needed to prove which branch ran was not finished; every `city-contacts.reno.*` and `heywood.nix.spellbook-acquisition` outcome stays unmapped. Her single rule is the told-by-V sale.
- Sergei as participant (the meeting scene with 18 of his lines): the catalog has no "met Sergei" outcome, and the delivered/released outcomes belong to branches he does not witness.
- Mark Bana `identity-reveal/katya-revealed` and Katya fate: no branch-proof predicate in the cache.
