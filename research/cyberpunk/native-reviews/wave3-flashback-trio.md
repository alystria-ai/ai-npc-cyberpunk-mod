# Wave 3: Santiago, Spider Murphy and Thompson

Reviewed **2026-10-01** against the installed Cyberpunk **2.31** English native
assets. These are authoring proposals outside the approved claim folder. Parent
semantic review and explicit adoption remain required.

## Deliverables

| Profile | Claims | Original examples | Exact claim references | Historical scope |
| --- | ---: | ---: | ---: | --- |
| Santiago | 6 | 6 | 378 | Existing 2013-era reconstruction |
| Thompson | 5 | 5 | 275 | Existing 2013-era reconstruction |
| Spider Murphy | 5 | 5 | 270 | Existing 2023-era reconstruction |

Proposals are `native-character-proposals-wave3/santiago.json`,
`native-character-proposals-wave3/thompson.json` and
`native-character-proposals-wave3/spider-murphy.json`. There are **923** exact
references across **16** claims, joining **27** selected historical speech lines.
Every example is newly authored, prefix-free and linked to included claims.
No lyrics, paired player dialogue or synthetic conversation history are used.

Eight distinct binary/serialized source pairs support this lane: the current
winning cooked journal, installed English onscreen text, three historical
scenes, and their three independently freshly exported English subtitle assets.
All binary SHA256/SHA1, serialized SHA256 and serialization input paths were
verified against their recorded pinned-tool receipts. Each emitted line also
has its actual actor, screenplay speaker/item, typed VO event, explicit `en_us`
descriptor, bounded matching payload variant and same-ID shipped subtitle.
English text is hash-bound in proposals; no dialogue is silently repaired.

## Individual identities and actual speakers

These people have **genuine individual phone contacts**, not individual codex
entries in the inspected cooked journal. The proposal uses the Wave 3
`journal-contact` subject contract, without inventing a codex subject. Contact
presence authenticates an identity; it does not establish current availability,
survival, disclosure, friendship, or a meeting with this V.

Common source pairs:

| Native artifact | Binary SHA256 | Serialized SHA256 |
| --- | --- | --- |
| `base\journal\cooked_journal.journal`, winning EP1 archive | `55b6e39e338a1b3c116af074b00cfb9d5745f7d495f59541f8ea49d0b182832b` | `0d6e12fd9503f68c4cc405f19b49b6b708bb24a15f66c8ce92b01235d6b5240b` |
| `base\localization\en-us\onscreens\onscreens_final.json` | `73bf09f994681bb6306daf19c3ca63622634f285d851b3f0346f21369323302b` | `acf260ca5575b8628dc5161dad9b7b46004a1b1afcf3e71facb532eb31f77a92` |

The exact journal prefixes below start at
`/Data/RootChunk/entry/Data/entries/3/Data/entries/`:

| Person | Typed journal contact | Name link | Exact English entry | Actual historical speaker |
| --- | --- | --- | --- | --- |
| Santiago | `34/Data/id` = `santiago` | `34/Data/name/value` = `LocKey#10900` | `/Data/RootChunk/root/Data/entries/7187`, primary key `10900`, female variant Santiago | `q108_14_rogue.scene`, `/Data/RootChunk/actors/1`, actor name `Santiago`, voice `1197872723565494272` |
| Thompson | `12/Data/id` = `thompson` | `12/Data/name/value` = `LocKey#10921` | `/Data/RootChunk/root/Data/entries/7203`, primary key `10921`, female variant Thompson | `q108_11_thompson.scene`, actor `0` named `thompson`; `q108_14_rogue.scene`, actor `3` named `Thompson`; voice `1103967280742240840` |
| Spider Murphy | `11/Data/id` = `spider_murphy` | `11/Data/name/value` = `LocKey#22060` | `/Data/RootChunk/root/Data/entries/16275`, primary key `22060`, female variant Spider Murphy | `q101_06c_memories_p2.scene`, actor `7` named `netrunner_phone`, voice `1624173162010259956`; active `findInContext` record `Character.q101_spider_murphy` |

All table identities additionally pin real `$type`, voice, acquisition plan,
typed acquisition parameters and original contact avatar. Full actor, event,
line, raw/serialized source and hash receipts are in the ignored authoring file:
`runtime/voice-cast/silverhand-cast/intrinsic-flashback-wave3/binding-receipts.json`.

### Exact historical frame

All selected scenes identify the historical Johnny player by the literal typed
record `Character.johnny_replacer` and voice `1103967280742240508`:

- `q108_14_rogue.scene`: `/Data/RootChunk/playerActors/0`, player name `Player`.
- `q108_11_thompson.scene`: `/Data/RootChunk/playerActors/0`, player name `Player`.
- `q101_06c_memories_p2.scene`: `/Data/RootChunk/playerActors/0`, player name
  `Johnny`. Its separate modern `Player` actor is not borrowed as the frame.

The proposals use `third-party-report` attribution to preserve **the subject's
portrayal in Johnny's represented recollection**. No subjective tower sequence
becomes independently authenticated neutral history. The existing editorial
2013/2023 persona boundaries prevent later omniscience; these particular
contact/actor joins alone do **not** independently prove a displayed calendar
year. That limit is explicit in every proposal's exclusions.

## Public material selected

### Santiago

Selected native screenplay indices in `q108_14_rogue.scene`:

- `5, 6`: clan travel beyond the city and the possibility of a life beyond its
  jobs. The invitation's intimacy is addressed to Rogue and is excluded from
  the public claim; none transfers to V.
- `26, 27, 32`: a concrete job, payment and terms instead of boasting.
- `31`: getting paid up front when a client gives cause for distrust.
- `35`: taking a professional partner's distrust seriously.
- `38, 40`: resisting a friendship discount and distinguishing work from unpaid
  work. Line `40` has native `Vo_Expression_Phone`; the receipt preserves that
  delivery exactly. It is narrative evidence, not a dry voice candidate.
- `34, 42, 43`: reading an extravagant fee as potential risk and requiring the
  person offering it to share exposure.

This adds personality and practical conversation topics without inventing
modern Aldecaldo leadership, a current camp, Panam acquaintance, family identity
or a paid contract with V. The profile is not reduced to a demand for money in
every friendly conversation.

### Thompson

Selected native screenplay indices:

- `q108_11_thompson.scene` `3, 4`: concrete observations about unusually fast
  reflexes and technology when estimating a threat.
- `12`: prioritizing a corporation's motive over romantic gossip.
- `24, 26`: asking a doubter for a real counter-explanation.
- `35, 49`: a field-reporting story and a lost lead, preserving his own account
  as subjective. No current case file or private corporate intelligence is
  granted.
- `q108_14_rogue.scene` `56`: a clear practical limit on waiting.

The lane does not promote a murder verdict about his wife, Alt's confidential
technical work, unqualified Soulkiller claims, modern WNS contacts or survival.
The portrayed 2023 Thompson in `q101` is not merged into his 2013 persona.

One possible additional risk/teamwork claim was **not included**: the English
embedded payload for `q108_11_thompson.scene` line `40` begins with a colloquial
contraction while the same-ID shipped subtitle uses its uncontracted form. Both
receipts are genuine; they are not byte-identical. Rather than silently normalize
them or label agreement exact, the present claim set uses other agreeing lines.

### Spider Murphy

Only the **directly identified remote actor 7** in
`q101_06c_memories_p2.scene` is used:

- `4`: ICEbreaker origin and subnet protocol attention.
- `6`: occasional playful technical metaphor.
- `14`: clear task-completion and exit instruction.
- `71, 73, 80`: reporting a temporary barrier, a breach and changing route
  conditions.
- `72`: urgency combined with personal encouragement.

Remote/phone delivery remains explicit native narrative evidence. It establishes
neither clean voice-reference readiness nor a complete netrunner biography.
No post-2023 fate, modern Arasaka access, Alt/Bartmoss omniscience or definitive
Recluse identity is added.

The clean-looking generic community actor `5` remains **excluded**. Matching
voice tags, the scene/community `netrunner` spelling and the journal follow
objective do not supply the still-unresolved NodeRef-to-world-resource edge.
The directly bound phone speaker does not retroactively repair that gap.

## Source and development methods

Pinned tool: `WolvenKit.CLI 9.0.1`, SHA256
`7ae9c308da2fe003220b55ce4ca9c122b51f0701a67db1618cca3ff4f7ff6738`.

The existing `flashback-actors` scene exports were reused only with their
recorded binary and serialization receipts. An isolated fresh English subtitle
export is at
`runtime/voice-cast/silverhand-cast/scenes/intrinsic-flashback-wave3-localization/`.
It contains exactly **three** requested winners, **18,114 decoded bytes**,
no missing paths, and retains raw, serialized, archive-winner and pinned-tool
receipts. The helper restricts its in-process exporter to those exact `.json`
paths and the English text archives; shared source code is unchanged.

Exports run under the existing OS lane lock and shared **two-job CPU gate**.
The authoring script in the ignored
`runtime/voice-cast/silverhand-cast/intrinsic-flashback-wave3/` folder performs
only read-only source verification and owned proposal writes. It verifies
recorded bytes, typed contacts, name localization, exact actor/speaker IDs,
screenplay items, actual emitted spoken/phone events, explicit English
descriptor-to-payload indices and matching same-ID shipped English subtitles.
It preserves the Johnny frame on every claim, records text hashes and does not
infer speakers from audio filenames.

Verification completed:

- All eight source pairs pass recorded SHA256/SHA1/JSON source-path checks.
- All **923** claim references resolve to the exact expected value or UTF-8
  value hash.
- All selected **27** speech joins and their shipped subtitle agreements pass.
- All three proposals pass `normalizeIntrinsicCharacterPack`.
- All **16** original examples pass `assertPlainSampleDialogues` and refer only
  to claims included in their own proposal.

These checks authenticate authoring structure and inspected evidence. They are
not an integrated build, independent semantic adoption or in-game test.
No shared builder, roster, cloud API, memory, save, game, GPU, voice casting,
audio processing, global manifest or commit action occurred in this lane.
