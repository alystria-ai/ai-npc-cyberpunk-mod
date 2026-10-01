# Wave 3: Nancy, Nix, Smasher, Padre, Wakako and Dino

Reviewed on October 1, 2026 against the installed Cyberpunk 2077 2.31 English
resources. This lane owns only the six new proposals listed below and this
review. The parent owns subject-ledger/compiler changes, adoption, cloud profile
updates and installation. Nothing here creates player dialogue or memory.

## Deliverables and scope

All files are under `research/cyberpunk/native-character-proposals-wave3/`:

| Proposal | Public topic claims | Excluded private or conditional candidates | Original spoken examples | Authored exact references |
| --- | ---: | ---: | ---: | ---: |
| `nancy-hartley.json` | 13 | 1 | 6 | 1,018 |
| `nix.json` | 10 | 2 | 6 | 594 |
| `adam-smasher.json` | 4 | 0 | 4 | 84 |
| `padre-ibarra.json` | 8 | 1 | 5 | 359 |
| `wakako-okada.json` | 6 | 2 | 5 | 254 |
| `dino-dinovic.json` | 9 | 0 | 5 | 278 |
| **Total** | **50** | **6** | **31** | **2,587** |

These are bounded topic details, with explicit limits, rather than lengthy
autobiographies to recite. All public material fits beneath the compiler's
6,000-character per-character limit: Nancy 2,820; Nix 1,866; Smasher 907; Padre
1,608; Wakako 1,308; Dino 1,787. A background detail does not establish that the
current V met the character, heard a source scene or completed its quest.

The examples are original editorial utterances. They contain no speaker-name
prefixes, paired player responses, songs, game dialogue quotations or fabricated
shared memories. Each example depends only on selected public claim IDs.

## Primary source and validation method

The proposals use 24 distinct raw/serialized native artifact pairs. Repeated
journal and English localization references are shared evidence, not additional
independent confirmations. Public claims use 22 pairs; two Nancy files are used
only by the excluded private-history candidate.

Every claim pins its actual individual typed codex or phone-contact subject and
the exact English localized title/name. A scene claim additionally pins:

1. The actual `scnActorDef` or `scnPlayerActorDef`, actor ID, name and native voice.
2. Its matching screenplay speaker, item ID and localization ID.
3. The emitted typed `scnDialogLineEvent`, its screenplay item, timing and VO
   expression/phone flag. Unused captions are not treated as self speech.
4. Matching `en_us` embedded descriptors and payloads, including variant IDs.
5. The same-ID shipped English subtitle's female and male variants, including
   empty variants as such. Exact text hashes avoid embedding full quotations in
   authoring files.

Recorded source SHA256s cover the binary and serialized JSON independently;
archive entry SHA1s cover extracted payloads. The serializer is the pinned
WolvenKit CLI 9.0.1 with SHA256
`7ae9c308da2fe003220b55ce4ca9c122b51f0701a67db1618cca3ff4f7ff6738`.
Exports used the shared lane lock and at most two globally locked CPU jobs, with
hidden processes and exact bounded resource allowlists. No GPU, audio generation,
game mutation or API work was performed.

The authoring pass checked all 2,587 exact pointers and their expected
values/hashes, all scene-to-English joins, all source byte hashes and every
source archive entry SHA1. It does not replace independent semantic review or
compiler qualification.

Evidence folders, retained as local ignored research:

- `runtime/voice-cast/silverhand-cast/scenes/wave3-nancy-nix-smasher/`
- `runtime/voice-cast/silverhand-cast/scenes/wave3-nancy-identity/`
- `runtime/voice-cast/silverhand-cast/scenes/wave3-nancy-nix-smasher-text/`
- `runtime/voice-cast/fixers-city/scenes/wave3-padre-wakako-dino/`
- `runtime/voice-cast/fixers-city/scenes/wave3-padre-wakako-dino-text-flat/`

The first scene batch also records one unavailable requested Smasher depot. Its
five selected resource pairs independently passed extraction and serialization;
the missing resource contributes no claims or identity proof. An initial fixer
subtitle batch used nonexistent nested paths and exported zero payloads; it is
retained only as negative discovery evidence. The corrected flat subtitle batch
contains all three exact shipped resources. No missing or guessed file is
credited as a source.

The common winning cooked journal and English onscreens pairs are reused from
the already verified intrinsic evidence collection. Their recorded raw and JSON
hashes remain unchanged.

## Nancy: journalist, musician and one identity

Nancy has no individual `gameJournalCodexEntry` in the winning journal. It would
be incorrect to invent `nancy_hartley` as a codex subject. Her real subject is:

```text
/Data/RootChunk/entry/Data/entries/3/Data/entries/59/Data
  $type: gameJournalContact
  id: nancy
  name/value: LocKey#10876
  avatarID/$value: PhoneAvatars.Avatar_Nancy
```

The English name is entry 7163, primary key 10876, **Nancy Hartley**. The proposal
uses `subjectRef.kind: journal-contact`, according to
`runtime/wave3-subject-contract.md`.

**Bes Isis is explicitly the same person**, rather than an identity inferred
merely from a shared voice:

- The typed `mq018_writer` wait objective has description LocKey 10298. English
  entry 6603 explicitly identifies Bes Isis as Nancy.
- `mq018_01_call.scene` contains both named actors `Nancy` and `Bes_Isis`, each
  with native voice 1381176181915344896. The Bes_Isis voicemail identifies its
  recipient as Nance. This is actual emitted phone speech.
- `sq011_07a_royce.scene` individually binds Nancy and her emitted line 123 about
  her work appearing on N54 News.
- The typed published `generic_samurai_history` onscreen, description LocKey
  18529, reports Nancy's earlier keyboard work and subsequent Bes Isis/N54
  career. That claim preserves the published narrator's perspective, with
  Nancy's band-membership and N54 speech as independent contextual confirmation.
  None of the article's surrounding private history or rumors is promoted.

Her wider public topics concern the lived craft of reporting: footage and
editing, musical questions, following a more substantial story, checking leads,
technical and local inquiries, admitting uncertainty, useful industry access,
improvisation and protecting reporting files. Her musical perspective includes
the old band and attention to period details, without importing a completed
reunion, instrument gift, rescue or relationship with this V.

The phone dialogue's earlier Swedenborg theories remain provisional and are
not treated as established history. Confidential locations, source identities
and unpublished Maelstrom material are excluded. Johnny's report about her
violent marriage and jail term is an excluded third-party private candidate,
not a self-confession or light group topic.

## Nix: competent curiosity with limits

Nix has a genuine individual codex subject, `nix`, with English title **Nix**.
The native scene speaker `nix`, voice 1791017447710433280, is joined directly to
both Afterlife scenes and their spoken events.

Public material covers difficult technical work, study of surviving Bartmoss
knowledge, earned working trust with Rogue, enthusiasm for old technology,
explicit warnings about data-loss risk, curiosity and care with historical
hardware. His services are valuable work; his relaxed idiom coexists with
professional boundaries. His bargaining is sales talk, not an authenticated
estimate of an artifact's true value.

The old corporate stint remains excluded from universal public material,
including any employer, proprietary assignment or leak. No rockerboy history,
personal Bartmoss friendship, complete Old Net knowledge or guaranteed technical
success is invented. The distinct deck-recovery branches remain conditional;
meeting Nix does not make V his rescuer or establish a life debt.

The unmodified authoring compiler currently verifies Nix's ten public claims,
six examples and **536 selected references**, correctly rejecting the corporate
and recovery candidates from public context.

## Smasher: chrome and violence without invented invincibility

The genuine codex subject is `adam_smasher`, title **Adam Smasher**. Native actor
`smasher`, voice 1558641050515300352, needs the explicit reviewed subject alias.

The four public topics are deliberately supported rather than padded: full-body
conversion; Arasaka enforcement and operational autonomy; the codex's report of
his 2023 killing of Silverhand; and organic contempt in his actual speech. His
taunt is used only as a delivery/worldview source. It imports neither its
particular victim nor a reached ending confrontation.

Fearful narration does not prove objective invincibility. His converted body
does not establish a diagnosis, organic percentage or equipment specification.
The lane does not invent a New York gang episode, military dates, reconstruction
bargain or resolution of the Morgan Blackhand confrontation. No boss defeat,
Rogue/Saul death, V executing him, survival after a chosen ending or knowledge of
Johnny currently sharing V's mind becomes baseline biography.

## Padre: faith, honor and practical limits

The roster key remains `padre-ibarra`; the real typed codex ID/title are **padre /
Padre**. It identifies Sebastian Ibarra. Actual in-person native speaker `Padre`,
voice 1609919701408317440, needs the reviewed alias; the roster is not renamed.

The codex establishes priesthood associated with the Valentinos, the transition
to fixer work after Moto Cielo, Heywood roots, dealings beyond one gang and his
code about balancing power. No specific role in the bloodbath, date, victims or
secret allegiance is invented.

His own dialogue gives faith a personal rather than supernatural-certainty
perspective, permits personal questions without promising answers, and treats
respect as a practical protection rather than complete territorial control. His
restrained religious humor remains humor. The Mamá Welles assurances depend on
post-Heist context and stay excluded: neither Jackie death nor an old friendship
with this V is assumed.

## Wakako: business and family without a murder confession

The subject is the genuine `wakako_okada` codex, title **Wakako Okada**. The exact
speaker `wakako_okada`, voice 1630416502798118912, needs explicit alias review.

The public material covers the Westbrook pachinko business, formal politeness,
pressure and expected competence. Her own statements support Tyger Claw ties
through her late husbands and being the mother of nine sons. It supplies no
invented ranks, names, ages, locations or faction roles. Her ripperdoc judgment
distinguishes cheap service from sound practice without asserting current
survival, availability or endorsement.

The codex explicitly speculates about her husbands. Its rumors remain an
excluded attributed candidate; her dry mention of five deceased husbands does
not establish the cause of death. Neither guilt nor innocence is inferred from
tone. Sandra's reward, the smart-gun imprint, automatic familiarity and completed
contracts remain save-dependent.

## Dino: fixer and musician, with hearsay clearly marked

The real codex ID/title are **dino_dinovic / Dino Dinovic**. The roster key is
unchanged. Actual scene speaker `dyno`, voice 1609920229118869504, requires the
reviewed spelling alias.

Public details cover his City Center work, Gloryhole Bandits bass role, varied
requests, mixed company and bar. The codex's joke about nobody hearing him play
does not become literal inability or a claim he never performed. Rowdy bar
narration is atmosphere, not inevitable harm.

The two Silverhand details are separate:

- Dino says he attended a gig while intoxicated and explicitly rejects personal
  acquaintance with Johnny. This is his limited recollection.
- The backstage captive/encore story is introduced as something he heard. It is
  retained as hearsay, never rewritten as Dino's eyewitness report or objective
  history.

His wish to play more does not schedule a reunion; confident nightlife talk does
not guarantee a Kerry-party invitation or current-V favor. Knowing many people
does not become literal knowledge of everybody.

## Coordinator handoff and remaining qualification

Exact subject, localized-title, actor, voice, event and raw/JSON hash receipts
for all six are collated locally at:

`runtime/voice-cast/silverhand-cast/wave3-subject-review-receipts.json`

At the initial compiler smoke check, Nix passed. The other five had only the
expected missing subject/alias qualifications: Nancy's new typed contact path,
Padre's short native codex ID, and Smasher/Wakako/Dino actor spellings. They were
reported to the compiler coordinator with the exact receipts; no fuzzy match,
invented codex ID or roster rewrite was used to force a pass.

After the coordinator extends the reviewed ledger/contact branch, compile these
six proposals together and confirm the expected 50 public claims and six
rejected private/conditional candidates. A successful compilation is still
source qualification, not parent adoption, in-game behavior or cloud publication.
