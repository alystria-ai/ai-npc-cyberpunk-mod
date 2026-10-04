# Priority character quest coverage — October 4

The combined development pack contains **394 enabled rules mapping 382 of 1162 researched outcomes**. The previous pack had 197 rules and 190 mapped outcomes. This pass adds 197 rules, closes 190 existing catalog gaps, and adds two new mapped Phantom Liberty decisions. **780 outcomes remain unmapped across the full catalog.**

All eight requested characters received a native-source review. Counts below use each outcome's explicit affected-character list, not every character associated with its quest. A mapped outcome can be restricted to a particular speaker or disclosure audience; it does not mean every affected character knows it. Shared outcomes appear in multiple rows.

| Character | Researched affected outcomes | Mapped outcomes | Unmapped outcomes |
| --- | ---: | ---: | ---: |
| Johnny Silverhand | 93 | 57 | 36 |
| Panam Palmer | 65 | 47 | 18 |
| Judy Alvarez | 50 | 40 | 10 |
| Jackie Welles | 43 | 26 | 17 |
| Solomon Reed | 57 | 45 | 12 |
| Songbird | 56 | 41 | 15 |
| Takemura | 30 | 20 | 10 |
| Rogue Amendiares | 24 | 20 | 4 |

## What changed

- Johnny and Rogue: side arcs, reunion and possession events, Relic memories, and qualified ending routes.
- Panam: camp assistance, Nash and vehicle recovery, Saul rescue, convoy planning, shared visits, and relationship facets.
- Judy: Evelyn's investigation and fate, Clouds outcomes, later messages, the dive visit, and compatible relationship/history facets.
- Jackie and Takemura: lifepath and heist progression, body delivery and mourning receipts, explicit rescue, and subsequent meetings.
- Reed and Songbird: Phantom Liberty choices, qualifying NCX call branches and final custody, Tower treatment consequences, and speaker-specific disclosure.
- Shared endings: qualified route entry and later consequences. Johnny's V memorial requires the completed columbarium objective; entry into Temperance alone does not establish a grave visit.

## Detection and privacy limits

An optional dialogue choice or item exchange may leave no durable, outcome-specific receipt. Generic quest completion is insufficient. The native fact getter returns an integer without proving whether a zero was ever written, so absent/zero facts cannot safely supply the opposite branch. Fatal endings also do not grant a summoned living copy unrestricted first-person knowledge.

Rules retain exact quest-stage prerequisites and public, participant, private, or V-disclosure audience guards. Phone/private knowledge is not automatically shared with a group. Story events are current-save context; this build neither changes game choices nor sends synthetic memory-building conversations.

## Verification and installation

The combined source build reports no errors: 571 cited artifacts, 7,999 hash-bound pointers, and zero legacy-unbound pointers. The actual runtime pack loads under the bridge's schema limits. Its 253 fact and 274 journal selectors each fit the existing 512-observation capture bound. The pack reader limit is now 16 MiB because the expanded compact JSON exceeds the previous 4 MiB bridge limit.

The expanded pack and its Lua reader are installed byte-for-byte in the development game directory, with prior copies retained for rollback. The bridge source uses the matching 16 MiB limit. The game and bridge were closed at this installation; the next normal launch will load the new files. The local installation receipt is `runtime/quest-priority-eight-20261004/installation/receipt.json`. Natural live-save recall remains unverified; source and installed-byte checks do not establish personality fidelity or every gameplay branch.

## Source reviews

- [Judy](../research/cyberpunk/native-reviews/priority-judy-20261004.md) and [Panam](../research/cyberpunk/native-reviews/priority-panam-20261004.md).
- [Compiled native coverage](../research/cyberpunk/generated/native-coverage.json) and [quest catalog](../research/cyberpunk/generated/quest-catalog.json) retain exact rule-to-outcome links.
- Local development receipts under runtime/quest-priority-eight-20261004 retain lane audits, residual dispositions, final direct coverage and pinned input hashes. They are not release dependencies.
