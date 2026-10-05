# Quest-outcome knowledge — verification and expansion (October 5)

## Does the pipeline work end to end?

Yes, on the player's current 2.31 save, with evidence at every step:

| Step | Evidence |
| --- | --- |
| Lua reads native state | A live capture at 2026-10-05T06:07:47Z (`runtime/last-input.json`, cycle 936) was `ready` with 253 facts and 274 journal entries. |
| The reading matches the save | The new offline reader (`research/cyberpunk/scripts/save_snapshot.mjs`) rebuilt the same snapshot from `AutoSave-14`: 527 of 527 observations agree. An October 3 capture agrees with the saves of that time on 293 of 293. |
| Predicates → per-character facts | `evaluate_save_knowledge.mjs` runs the bridge resolver on that snapshot (table below). |
| What reaches Convai | The live turn logged `knowledgePreparedMs`; the context is the resolver's JSON block plus journal, history, battle and style sections. A replica of `conversationContext` gives 3.8k–11k characters per turn (world facts capped at 8000). |

The user's "only a few" was accurate. On the current save, before this work, 175 rules were true but each character could hear only those naming them: Johnny 22, Panam 20, Judy 15, Jackie 12, Reed 12, Songbird 7, Takemura 9, Rogue 7, Alex 1, Hanako 0.

## What was broken and fixed

- **Capture limits.** The Lua collector refused a fact or journal allowlist above 512 and dropped snapshots whose sampling cycle began more than 3 s earlier. The bridge accepted bigger packs, so expanding the pack would have silently disabled collection. Both now share a 1024-per-inventory limit (the bridge rejects larger packs), and the default lease is 5 s from the cycle start.
- **Five existing rules misreported the save.**
  - NetWatch deal: the value is 1 after refusing and 2 after accepting; both rules now require 2.
  - Judy's and Panam's Sun goodbyes fired for whichever partner was present; each now requires that partner's rooftop choice.
  - Jesse's thank-you call fired on quest completion, which also happens if Jesse dies; it is disabled.
- **Relevance.** V's question could not displace unrelated facts in a full budget, and function words matched everything. Function words are now ignored and each matching term weighs 50 points (up to 150).
- **Tests.** Knowledge integration and lifecycle fixtures lacked `movement-log.lua`, so 44 knowledge tests failed before running. The topic-identity test hardcoded old counts. `npm run test:knowledge` is now 519/519.

## Expansion

Ten review lanes covered every unmapped outcome against the installed quest graphs, scenes and cooked journal. Every new rule cites hash-bound exports, and each was checked on nine real saves from five playthroughs. No lane rule contradicts another outcome in any save. Per-outcome dispositions are in `research/cyberpunk/native-reviews/*-20261005.md`.

| | Before | After |
| --- | ---: | ---: |
| Enabled rules | 394 | 768 |
| Outcomes mapped (of 1162) | 382 | 749 |
| …with a rule that can actually fire (not `told-by-v`) | 348 | 715 |
| Fact / journal selectors | 253 / 274 | 355 / 638 |

| Character | Mapped affected outcomes | Speakable affected outcomes | Facts selected on the current save |
| --- | ---: | ---: | ---: |
| Johnny | 57 → 72 | 53 → 71 | 22 → 27 of 293 allowed (was 22) |
| Panam | 47 → 52 | 42 → 46 | 20 → 21 |
| Judy | 40 → 43 | 34 → 37 | 15 → 15 |
| Jackie | 26 → 30 | 24 → 27 | 12 → 14 |
| Reed | 45 → 48 | 30 → 31 | 12 → 13 |
| Songbird | 41 → 45 | 10 → 11 | 7 → 8 |
| Takemura | 20 → 21 | 17 → 17 | 9 → 9 |
| Rogue | 20 → 20 | 19 → 19 | 7 → 7 |

Most new rules concern fixers (contract results stated in the fixer's own debrief), city contacts, Claire, River, the Peralezes, Viktor, Misty and Phantom Liberty contacts. The priority characters' remaining gaps are mostly unrecorded, zero-only or V-only outcomes.

**Johnny co-witness.** Johnny's engram shares V's senses between the Relic's activation and Mikoshi. `research/cyberpunk/native-cowitness.json` therefore lets him hear V-involved participant, witnessed and private rules, except in the prologue and Heist, Playing for Time, and the Devil, Star, Sun and 2079 epilogues. Facts reached this way are labelled as seen through V. On the current save he may hear 293 true outcomes instead of 22; the budget keeps his own arcs first and lets V's question pull in the rest. To disable this, remove the entry and rebuild.

## Remaining unmapped (413)

Each lane review gives every outcome a category: no native signal (optional dialogue, inner choices), zero-only (only a 0/absent fact distinguishes it), shared writer (the same fact or objective on several branches), transient (reset later), told-by-v (a character could know it only if V told them; the runtime has no disclosure receipts), no speaker (only V, a dead character, or a non-roster character knows it), and out of scope or not in 2.31. The 41 existing `told-by-v` rules still never fire, by design.

Two Panam outcomes (refusing the Nash hunt, platonic outcome) have verified predicates but need a reviewed topic-alias row; see `aldecaldos-20261005.md`.

## Audience, spoilers and prompt size

- Rules evaluate only the current snapshot, so nothing from a later point in the story can appear.
- Each rule names its speakers and recipients. In group speech every other listener must be a declared recipient.
- Dead characters gain nothing after their death (Jackie's rules all predate the Heist).
- Fixers know contract results only through their own debriefs.
- World facts are capped at 8000 characters per turn and ranked by active quest, relationship, the character's own arcs and V's question. Busy characters (Johnny, Regina) now fill that cap.

## Live risk to check

The allowlist grew from 527 to 993 observations. The live cycle was under 1 s at 527 observations; the 5 s lease tolerates cycles of up to about 3 s. If a turn reports world knowledge unavailable, the capture cycle is too slow at the current frame rate.
