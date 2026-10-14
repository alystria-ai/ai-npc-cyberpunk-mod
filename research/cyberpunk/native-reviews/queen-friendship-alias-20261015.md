# Queen of the Highway: the friendship hook joins the Panam romance topic

Date: 2026-10-15. Scope: one rule, `db.queen-friendship-hook` (decision `aldecaldos.queen.romance`, outcome `platonic`). No game, save, provider, voice or conversation-memory mutation was performed; saves were read only.

## Why an alias

The decision `aldecaldos.queen.romance` already has a reviewed rule under a native topic: `aldecaldos.native.panam-basilisk-intimacy` (outcome `romanced`, topic `aldecaldos.panam-basilisk-intimacy`, catalog topic `panam.romance`, see [the topic identity audit](topic-identity-audit-oct03.md)). The topic identity check refuses a rule that uses the catalog topic next to a reviewed native domain, because the resolver would then see two unrelated topics for one decision and miss a contradiction. A new rule for the other outcome has to join the native domain.

## Treatment

| Native rule | Native topic | Linked catalog topic | Reviewed treatment |
| --- | --- | --- | --- |
| `db.queen-friendship-hook` | `aldecaldos.panam-basilisk-intimacy` | `panam.romance` | mutually-exclusive-stance |

The two outcomes are exclusive in the game's own script. The questphase `q114_msg_panam_ending_hook` (node 1, `sq027_panam_lover > 0`) sends the lover messages on the True side and `02_msg_panam_friend` on the False side. The existing `romanced` rule requires `sq027_panam_lover` equal to 1, so they cannot both hold. With one shared topic and two outcomes, the resolver suppresses both if a contradictory snapshot ever shows them together (the same stance-domain treatment as the two farmhouse stances).

## Evidence

- Journal: the friendship message `contacts/panam/q114_panam_ending_hook_friendship/02_msg_panam_friend` is already in the pack (`al5.panam.friendship-hook`, hash-bound evidence `al5.ev.journal.d3d6cfe53b1b` with the questphase condition node and the cooked-journal entry), and the rule `al5.devil.called-platonic` already reads it.
- Real saves (110 read offline by `research/cyberpunk/scripts/decision_rows_offline_check.mjs`): the message is active in 6 saves, none of which has `sq027_panam_lover`; `sq027_panam_lover` is 1 in 72 saves, none of which has the message; 32 saves have neither (the quest is not reached). Disjoint in every save.

## Limits kept in the statement

The hook is sent to anyone who reaches q114 without the lover fact, including a V who skipped the Panam job, so the statement says only that Panam sent her friendly check-in messages, the friends version of her ending hook, and does not claim that the Queen of the Highway job was completed.
