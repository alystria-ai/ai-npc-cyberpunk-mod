# River, Rogue and Kerry: intrinsic character material

Reviewed on October 1, 2026 against the installed Cyberpunk 2077 2.31 native
resources. These authoring proposals remain outside the adopted claims folder:

- `native-character-proposals/river-ward.json`
- `native-character-proposals/rogue-amendiares.json`
- `native-character-proposals/kerry-eurodyne.json`

They add no quest outcome predicates, generated packs, character roster changes,
cloud profile writes, player conversations or long-term memory. A character's
background is not proof that the current V has met them or heard the source
scene. The root agent owns review, adoption and subsequent integration.

## Coverage

| Character | Public topic claims | Private candidates excluded from public material | Original examples | Exact native references |
| --- | ---: | ---: | ---: | ---: |
| River Ward | 10 | 3 | 6 | 796 |
| Rogue Amendiares | 12 | 0 | 7 | 680 |
| Kerry Eurodyne | 14 | 1 | 7 | 671 |
| Total | 36 | 4 | 20 | 2,147 |

Each proposal records six source artifacts. Across the proposals there are
fourteen distinct binary/serialized-JSON pairs. The repeated journal and English
codex sources are shared evidence, not separate exports or different versions of
the character.

### River

The public material gives River an identity beyond being a police officer:

- Becoming an NCPD detective mattered to him, while the title did not resolve
  the difficulty of doing right in Night City. This is professional history;
  the current save may change his employment.
- The codex describes persistence under pressure. Its psychological speculation
  is not promoted to a medical diagnosis.
- Joss's actual dialogue identifies him as her brother. The sibling bond is
  selected without carrying over her matchmaking, V attraction or Randy's
  save-dependent rescue.
- His own family/work comment supports valuing time with family. It does not
  establish that this V attended dinner or saved someone.
- His practical cooking, enjoyment of jambalaya, specific ingredients and
  attention to stirring give conversation concrete craft and gentle humor.
  No culinary school, recipe ancestry or measured recipe is invented.
- He can value a modest neighborhood as a place to raise children, and criticize
  Night City while finding a particular elevated view calming. These are his
  assessments, not universal safety claims.

The grocery/farm history, the murder of his parents and his story about a past
partner remain private candidates. Their refs are retained for review, but the
public compiler excludes them. Neither a group invitation nor a direct question
establishes disclosure of those details. Harris's hospital outcome, Crash's
transfer, current PI status and V romance stay outside this intrinsic pack.

### Rogue

The established 2077 subject is the fixer who runs the Afterlife, with a prior
professional mercenary career. The codex's sweeping reputation does not become
literal control over every job or omniscience.

Her ordinary business dialogue supports distinct priorities: paid terms,
operational risk, local expertise, practical improvisation, protecting capable
people from avoidable mistakes, the usefulness of information, and leaving an
operational choice with the person whose neck is on the line. Its clipped,
sometimes impatient cadence is selected without making all friendly interaction
hostile. A request to pinpoint a person and a named acknowledgement of Nix's help
support acknowledging assistance; they do not establish every technical task
Nix performed.

Two claims concern the younger Rogue in Johnny's represented Atlantis
recollection. They explicitly retain that viewpoint: discretion for a client
and objection to him endangering her people. Both pin the actual Rogue
screenplay speaker and the typed Johnny replacement player frame. They do not
turn a represented recollection into an objective recording. The selected frame
does not establish a calendar year, so an exact 2013 date is not promoted from
these receipts alone. The modern fixer is not forced into the unchanged
personality or current relationships of the younger portrayal.

The surrounding romantic accusations, hidden deals, son's identity, current
Hellman transaction, Heist outcome, Panam/Nash outcomes, drive-in date and ending
survival are excluded.

#### Explicit native identity alias

The winning typed codex entry uses **`rogue`**, not `rogue_amendiares`:

```text
/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/20/Data
  $type: gameJournalCodexEntry
  id: rogue
  title/value: LocKey#20435
  entries/0/Data/textContent/value: LocKey#20437
  imageId/$value: UIJournalIcons.c_rogue_old_full
  linkImageId/$value: UIJournalIcons.c_rogue_old
```

The title joins `codex-text` entry 15133, `primaryKey` 20435, English
`femaleVariant` **Rogue**. Every Rogue claim contains the typed subject ID and
the title LocKey/English pointer chain in both `nativeRefs` and
`attribution.subjectTitleRefs`. The source-reviewed compiler must use an
explicit `rogue-amendiares → rogue` binding. No fuzzy name match, fabricated
full-name codex ID or unverified `Character.Rogue` record is substituted.

### Kerry

The public material treats Kerry as a working artist with an independent career:

- SAMURAI and his continuing solo career are distinct parts of his history. The
  codex's rock-god reputation is not an objective talent ranking.
- Pride in Filipino roots is supported; language fluency, hometown and childhood
  customs are not invented.
- Night City can be his flawed creative muse. Public fame does not erase his
  preference for personal privacy.
- His account of early gigs, guitars and strings taking priority over food, and
  meals and coffee at Caliente supplies concrete musical history without a
  fabricated discography or band ledger.
- Double espresso, Jamaican blend, without sugar is a specific source taste.
  It is not an immutable ban on other drinks.
- MSM Records is his stated label. The adjacent Arasaka/Yorinobu studio and
  cookout joke is excluded from literal employment or friendship claims.
- He distinguishes song rights from ownership of him as a person, and can admit
  fame and money as motives while resisting the idea of becoming a corporate
  product. The current Us Cracks dispute and its resolution stay gated.
- Actual played speech supports both profane bluntness and concern for someone
  else's condition. This is conversational range, not automatic intimacy with V.

His private family/settlement candidate names Louise and refers to children and
Tokyo assets, but does not infer ages, names, custody arrangements or present
residence. The Louise/ex-wife line is specifically marked
`Vo_Expression_InnerDialog`; the proposal does not present all that material as
ordinary spoken testimony or proof of audible disclosure to V. The entire
candidate remains excluded from the public pack.

## Sources and authoring method

Four exact ordinary scenes and six English subtitle resources were freshly
exported into isolated batches. Two previously freshly authenticated scenes and
the two authenticated winning codex resources were reused under their original
recorded binary and JSON hashes.

New evidence:

```text
runtime/voice-cast/river-peralez/scenes/intrinsic-river-oct01/
  sq029_02a_arrival.scene
  sq029_04a_dinner.scene

runtime/voice-cast/silverhand-cast/scenes/intrinsic-rogue-kerry-oct01/
  q103_03_rogue.scene
  sq017_06_capitan_caliente.scene

runtime/voice-cast/river-peralez/scenes/intrinsic-localization-oct01/
  matching English subtitles for those four scenes
  sq011_01_kerry_mansion.json
  q108_14_rogue.json
```

The extractor uses pinned WolvenKit 9.0.1 and the existing shared two-CPU OS
locks. The private localization wrapper restricts its module instance to the
two installed English archives and six exact depot paths; it changes no shared
extractor or inventory. No archive-wide export, GPU work, synthesis or game
automation was used.

For every source, verification checks the current archive directory winner,
depot FNV path hash, directory SHA-1, extracted size and SHA-1, raw SHA-256,
recorded serialized JSON SHA-256, serializer version, game version and the
serializer's exact source filename. Base/EP1 precedence is checked for both game
data and English localization archives.

Each scene-supported claim joins:

1. A typed codex subject ID and localized title.
2. The actual typed `scnActorDef`, actor ID, voice tag and acquisition metadata.
3. Every selected typed `scnscreenplayDialogLine`, its speaker, item ID and
   localization ID.
4. Actual `scnDialogLineEvent` references to those screenplay item IDs, including
   VO expression, context and holocall metadata.
5. English locale/variant descriptors and their exact embedded content.
6. Matching shipped English subtitle IDs and both gender variants.

Witness speech remains assigned to its witness. Original editorial examples
are linked only to eligible public claims, contain no name prefixes or paired
player transcripts, and do not reuse song lyrics or construct fake player
memory. At most seven examples are authored for any of these characters.

## Review corrections and validation

Independent review checked claim meaning as well as pointer values. Corrections
made before handoff:

- Added the father's death line to River's private parental-murder evidence;
  the original subset established the mother, robbers and motive but omitted
  that explicit part of the account.
- Narrowed Rogue's intelligence-help claim and added the actual request. A
  solitary acknowledgement of Nix was insufficient for a broader technical
  assistance claim.
- Removed an exact year from Rogue's recalled-era text and added the Johnny
  replacement frame. A player frame establishes representation, not a date.
- Preserved the inner-dialog qualification on Kerry's family candidate.
- Added actually played profanity to Kerry's delivery-range evidence. The
  initially suggested unused screenplay line had no matching VO event and was
  rejected instead of being treated as played speech.

Current read-only verification passes **2,147 exact references** across all
forty claims, including the four private candidates. It verifies fourteen
unique binary/JSON pairs against all four relevant installed archive directories.
The final independent review also verified **63 actual actor/screenplay/VO joins**
covering **58 distinct played lines**, matching embedded/shipped English variants
and all twenty original examples. No semantic findings remain after the listed
corrections.
The receipt is:
`runtime/voice-cast/river-peralez/intrinsic-river-rogue-kerry/verification.json`.

The current public compiler selects River's ten claims/six examples and Kerry's
fourteen claims/seven examples; it excludes the four private candidates. Rogue
requires the explicit reviewed native codex alias described above. The root
compiler owner is adding that binding; no alternate subject is used to bypass
the check. Final adoption must rerun the real compiler after the alias lands.

No installed-game or audible character acceptance is claimed from this source
review. All three files remain authoring proposals until the root's reviewed
integration.
