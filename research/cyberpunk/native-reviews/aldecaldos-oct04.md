# Aldecaldo received-message addition â€” October 4

## Ready scope

One source-verified outcome in `../native-rules/aldecaldos-oct04.json`: `aldecaldos.blacksteel.gift/offered`, exact catalog topic `carol.maxtac-gift`.

Carol may recall that she sent V a message announcing a small courier gift with a drop on Potomac Street. The current-save gate is the exact revealed `gameJournalPhoneMessage` at `contacts/carol/q305_ambush_gift/03_carol_sending_courier`, with state `active` or `succeeded`. Hidden, missing, inactive and failed entries do not qualify. The existing runtime requires a revealed observation; no completion flag, elapsed time, spawn state or public biography substitutes for the receipt.

Audience is Carol and V only, in private or phone conversation. The statement describes Carol's own sent message. It does not imply that the human read it, that V collected it, which gift was selected, or that other companions know about it. No MaxTac/Black Steel outcome, refusal-call branch, Cynosure knowledge or future action is inferred.

## Exact native join

The winning EP1 override of `base/journal/cooked_journal.journal` identifies the contact as Carol, the entry class as `gameJournalPhoneMessage`, its sender as `NPC`, and text as `LocKey#87521`. The installed English `ep1/localization/en-us/onscreens/onscreens_final.json` entry at index5533 has primaryKey87521 and explicitly describes the courier and Potomac Street drop.

In the winning `ep1/quest/main_quests/q305/phases/q305_01_task.questphase`, root node-array18 owns the gift graph. Its journal node11 (array8) activates this exact message. The two incoming connections both enter `Active`: solo choice-state node6 (array5) directly, or netrunning choice-state node5 (array4) through fact writer31 (array17). The choice-state conditions require their respective exact journal choice entries to be `Succeeded`. The packet binds the node definitions and both incoming connection objects, rather than deriving semantics from node names. This is corroboration of the message's authored delivery; the activation condition remains the observed message itself.

## Hashed sources

The first draft incorrectly hashed legacy unbound JSON in place. Parent review caught this provenance blocker before integration. The corrected packet uses previously authenticated `aldecaldos-authenticated-oct01` journal and `phantom-authenticated-oct01` localization exports; their recorded raw/JSON hashes were recomputed and their complete `Data` objects matched the original cached sources exactly. Only the q305 phase required a new bounded export, `aldecaldos-carol-oct04`, using the existing archive-verifying exporter and WolvenKit serializer. It completed 1/1 assets; its newly recorded serialization also exactly matches the old full `Data` object.

The corrected ten pointers bind contact id `carol`, conversation/message ids, NPC sender, LocKey87521, localization primaryKey87521 and exact female/male text fields; choice-state paths and Succeeded state; writer node11's exact message path/class; both incoming connection objects; and the Active input socket. The English text UTF-8 SHA-256 is `2ae6c2d05350584f69b817dd250761238d8223602483dfacb454ac303cc10fe9`. Compiler predicates verify exact text bytes, not just a localization container type.

| File | Raw SHA-256 | JSON SHA-256 |
|---|---|---|
| `scene-evidence/aldecaldos-authenticated-oct01/raw/ep1/base/journal/cooked_journal.journal.json` | `55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b` | `36cca62a368d097d568564ae1ff5ef19b86d20c81ca7d4c92d2340fc5548461a` |
| `scene-evidence/phantom-authenticated-oct01/raw/ep1/ep1/localization/en-us/onscreens/onscreens_final.json.json` | `2d4a7e03def886c609be3f6306077ff2a7a17dc0ff77916defe6fe36441ada7d` | `4cd3d29f97d360cfcc079364837fb5f58bd90a7d9f06977f1a21580336d09c89` |
| `scene-evidence/aldecaldos-carol-oct04/raw/ep1/ep1/quest/main_quests/q305/phases/q305_01_task.questphase.json` | `9e74c37e9e9fccdeabe205221ab967ff309af3fd8af79302ad1e8b1993112e64` | `1a349b97aa71c962d31567ea3f6be30d9cc3b28ac6e45e0f59cea9f4b9f2e6bf` |

## Explicit gaps

- Gift collection remains unmapped. A dispatcher message proves neither pickup nor exact item. The q305 objective has success, inactive and cleanup operations which this bounded pass does not qualify for sender knowledge.
- Carol's refusal to obtain MaxTac data remains unmapped. The gift message alone does not establish the exact private call branch.
- Cassidy's Panam message was found under `contacts/cassidy/sq004_followup/01_watch_it`, written by `sq004_messages.questphase` node83. Its LocKey18623 expresses hope for V and Panam. The existing catalog places the researched message under Gun Music; this source does not establish Gun Music or its deal resolution. No runtime rule was forced into that mismatched quest attribution.
- Queen of the Highway training, camp combat, Biotechnica termination and other unmapped outcomes remain untouched. The Saul post-quest SMS mentioning a Biotechnica job that did not work out is not the specific termination correspondence cited by the catalog.

## Validation boundary

This lane authored its new packet and this review, plus the bounded ignored one-asset native export used to repair provenance. No test suite, game action, cloud write, installation, generated-pack change or commit. Parent will perform the single strict merged source compilation. This is source qualification, not live-save or audible-memory acceptance.
