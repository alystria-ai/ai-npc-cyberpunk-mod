# Takemura, Hanako and Evelyn: intrinsic topic proposals

Reviewed against the installed Cyberpunk 2077 2.31 winning native resources on
October 1, 2026. These are **unadopted authoring proposals**, held in
`research/cyberpunk/native-character-proposals/`. They change no cloud profile,
runtime memory, save, game file, roster or generated knowledge pack.

## Scope and current result

| Character | Public topics | Protected claims | Original spoken samples | Hash-bound sources | Exact pointer/value references |
| --- | ---: | ---: | ---: | ---: | ---: |
| Takemura | 14 | 3 | 8 | 8 | 1,036 |
| Hanako Arasaka | 11 | 3 | 8 | 10 | 709 |
| Evelyn Parker | 11 | 5 | 8 | 6 | 1,082 |

Protected material includes narrowly private history and conditional admissions;
it is deliberately ineligible for universal public topic material. The editorial
public biography and every sample use public claims only. The common compiler
still needs its explicit reviewed Takemura/Evelyn codex identity mappings before
the three proposals can be qualified together. Independent semantic and
provenance review passed; no adoption has occurred.

## What gives each character an individual voice

### Takemura

His rooftop conversation provides concrete personal history: Chiba-11's slums,
shirts washed in a chemically foul canal, selection as a child for corporate
soldiering, regular meals and discipline, education, academy achievement, special
forces and Saburo's personal selection. These are **his memories and reports**.
They do not certify an objective military dossier, recruitment policy, moral
innocence or Arasaka's universal benevolence.

The proposal preserves gratitude born from deprivation alongside pride in
principles, corporate-order arguments, impatience, dry humor and limits to local
operational knowledge. Food is an individual topic: onigiri with cod, salmon or
umeboshi, coupled with a sharp dislike of processed local food. Grandmother's
stories remain folklore. Neither a cat spirit nor Saburo's supposed insight into
souls becomes an objective world fact.

The private wish to leave everything and become a nomad, an intimate anecdote
about Saburo's protein bar, and his account of Hanako's intercession for Yorinobu
stay excluded from public biography and samples. The nomad admission is not a
new allegiance or a current decision.

### Hanako

Her own account of being raised as the family's heart supports continuity,
stability and duty. It is paired with her stated agency and acceptance of her
place, rather than making her a passive aristocrat. Hospitality, plain questions,
short firm answers and an opinion about the resilience of symbols give her
delivery a recognizable shape without inventing a present negotiation.

The public codex **deliberately distinguishes speculation from known identity**.
Her protected upbringing, digital contact with the outside world and role in her
brother's return retain their source attribution and uncertainty. The biographer
admits not knowing what she does privately. His remarks support public reserve;
they cannot prove a specific netrunning activity. Ziggy's provocative suggestions
and murder jokes are not accepted as biographical facts.

Her candid judgment of her father, private familiarity with his meticulous habits
and the outcome-dependent estate admission remain protected. Mikoshi, constructs,
board testimony, a particular operation, the fate of Oda and every ending remain
outside static biography.

### Evelyn

Evelyn's corporate polish is appearance, not a verified rank or bank balance.
Her individual craft is reading prospective colleagues, evaluating reputation,
setting professional standards, controlling disclosure, hard bargaining and
knowing how braindance analysis can catch otherwise missed details. She has dry
charm and a taste for good fresh food. Her opinion of fixers and her high-stakes
rationale remain personal appraisals rather than facts about everybody.

The proposal allows her to decline, redirect, tease or test a claim. It avoids
both a constant seductress and a generic victim portrait. Her technical knowledge
does not make her Judy's equal in braindance engineering.

Judy's trusted friendship receives no invented romantic label. Yorinobu's private
association, recording means, a covert fixer-bypass offer and the hope of being
underestimated stay protected. No current heist, accepted payout, Voodoo Boys or
NetWatch arrangement, rescue, death, survival or later Judy quest is inferred.
The actress aspiration in existing secondary-source prose was not authenticated
by this inspected native set; this proposal does not promote it.

## Exact identity bindings

All claims include the typed `gameJournalCodexEntry` subject, its localized title
chain, actual expectations and source binary/JSON hashes. No name resemblance or
fuzzy alias is used.

The shared subject prefix is:

`/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/`

| Roster key | Exact codex subject | Subject suffix | Title LocKey | English onscreens entry | Exact English title |
| --- | --- | --- | --- | --- | --- |
| `takemura` | `goro_takemura` | `18/Data/id` | `20381` | `15100` | Goro Takemura |
| `hanako-arasaka` | `hanako_arasaka` | `26/Data/id` | `20384` | `15102` | Hanako Arasaka |
| `evelyn-parker` | `eveyly_parker` | `11/Data/id` | `20375` | `15097` | Evelyn Parker |

`eveyly_parker` is the shipped typo. Its description is separately named
`evelyn_parker_desc` and its image records are Evelyn-specific. The compiler must
accept only this independently reviewed binding, not arbitrary aliases.

The journal is the current EP1 winner for `base\journal\cooked_journal.journal`:

- Binary SHA256: `55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b`
- JSON SHA256: `558dd73748d9c20b78f33d3be7a63bf8f9ad5e67820e02342e8a4e52550181c3`

The current base English onscreens resource supplies titles and codex content:

- Binary SHA256: `73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b`
- JSON SHA256: `78020f02c5e238eefbdec6e43b2ee6010f7242c31fe15d38b8932b287e0361c5`

These are the already freshly serialized, independently authenticated sources
also used in the finalized Jackie proposal, with bytes rechecked in this task.

## Source acquisition and speech attribution

The task exported ten exact native scenes through `Cast-SceneEvidence.py`, using
the pinned WolvenKit 9.0.1 executable, its checked SHA256, one casting-lane lock
and the shared two-job CPU semaphore. The Heist-era Evelyn briefing was already
freshly exported in the main-core-a lane and was reused with its exact current
provenance. No archive-wide extraction occurred.

| Evidence batch | Relevant scenes |
| --- | --- |
| `runtime/voice-cast/main-core-b/scenes/arasaka-intrinsic-oct01` | `q112_04_takemura`, `q112_01_market_02`, `q112_03_reconnaissance`, `q112_10_safe_house` |
| `runtime/voice-cast/main-core-b/scenes/arasaka-intrinsic-more-oct01` | `q115_00b_hanako`, `q113_04_hanako_estate`, `q113_06_saburo_office`, `q113_01_hanako_biographer_interview`, `q101_02_hanako_background`, `q004_06_see_you_later_evelyn` |
| Reused `runtime/voice-cast/main-core-a/scenes/native-initial-20261001` | `q004_02_meeting_evelyn` |

The first batch also requested a nonexistent `q113_01_embers.scene`. The manifest
records that missing path and is not misrepresented as a complete request set.
The four actual exported resources have separately verified binary, JSON and
winning archive receipts. The actual Embers conversation is
`q115_00b_hanako.scene`, acquired successfully in the second batch. The safe-house
and media-background scenes were inspected but did not add public claims.

Eleven corresponding shipped English subtitle resources were freshly decoded
from the current winning text archives and serialized in the task-owned ignored
`runtime/voice-cast/main-core-b/intrinsic-work/subtitles/` folder. This work uses
the same lane lock, CPU gate and pinned native serializer. The manifest records
the exact native entry SHA1, raw/JSON SHA256, source path and tool hash.

Every selected scene line records:

1. Actual typed actor name, ID, voice tag and native record fields when present.
2. The exact `scnscreenplayDialogLine`, speaker ID, item ID and localization ID.
3. An actual emitted `scnDialogLineEvent` referring to that item, including voice
   context, expression and holocall status.
4. The exact `en_us` descriptor and its payload index/variant linkage.
5. Exact current shipped subtitle string ID and nonempty text variants.

Unused screenplay line 45 in reconnaissance has no dialog event and was removed
from the proposal; the actual emitted duplicate at line 87 is used. No textual
line becomes evidence solely because it exists in a screenplay table.

## English variants and original examples

Original values are retained in every reference. Some native embedded English
and shipped subtitle text differ only in typography or delivery editing. The
generator accepts U+2026 versus three ASCII periods. Three selected Evelyn lines
have individually recorded, semantically reviewed variants:

- Line 107: expanded `must have` versus contracted `must've`.
- Line 166: expanded `I would` versus contracted `I'd`.
- Line 115: hyphenated `all-in` versus spaced `all in`.

These are explicit per-line receipts, not a general normalization permission.
The `Hm.` prefix variation at line 101 and the `you`/`ya` variation at line 64
were excluded rather than silently rewriting their original text.

All 24 examples are original, short spoken utterances with public claim links.
They contain no character-name prefix, game quotation, narrated action,
fabricated shared history or automatic follow-up behavior. They show a delivery
option, not a mandatory trigger or a new memory.

## Verification and adoption status

The authoring check re-read every source, verified raw SHA256 and native SHA1,
verified serialized JSON SHA256 and WolvenKit/game version, resolved all exact
pointer values and required the actual emitted event and English joins.

Independent read-only review then verified:

- All **2,827 exact pointer/value references**, recorded raw/JSON hashes and
  current installed archive winners.
- **24 unique inspected resources:** eleven scenes, eleven freshly serialized
  subtitles, the cooked journal and English onscreens, including inspected but
  unused evidence.
- **47 typed subject/title bindings and 119 speaker chains** across 117 distinct
  lines, including protected claims.
- All eleven protected rows excluded from public biography and all 24 samples
  linked only to public claims.
- The corrected Evelyn appearance claim, explicitly pinned text variants,
  unused reconnaissance line and genuine Embers source.

The existing common compiler accepts all eleven Hanako public claims and all
eight samples, excluding her three protected rows. Its Takemura/Evelyn identity
support is being handled independently by the compiler owner; these proposals
must not bypass that gate with a fuzzy name match.

The parent owns compiler integration, promotion and any later payload changes.
Protected claims must remain excluded until real disclosure/current-save
prerequisites exist. No production or cloud profile should receive the complete
unfiltered proposal as a biography.
