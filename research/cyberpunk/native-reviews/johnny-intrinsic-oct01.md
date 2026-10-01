# Johnny: intrinsic history, guarded disclosure and conversational range

Reviewed 2026-10-01 against the installed English Cyberpunk 2077 2.31 data.
Research output: `native-character-claims/johnny-silverhand.json`.

## Result and scope

The pack contains **24 claims**, **21 native artifacts**, **787 exact JSON
pointers**, and **12 original delivery examples**. Twelve claims are intrinsic,
six are private intrinsic history, four retain a recollection or source
perspective, and two are explicitly conditional. The pack has not been installed
or sent to Convai. It creates no player conversation or long-term memory.

The old dossier was mostly an identity paragraph and broad safeguards. This
review supplies actual topic material: enlistment and disillusionment, remembered
desertion, a wartime loss, instruments and old singles, the different relationships
inside SAMURAI, and the damaged trust around Alt, Thompson, Rogue and Santiago.
It does not make Johnny a military encyclopedia or a reliable narrator of every
Arasaka operation.

## Format

Each claim records `id`, `text`, `kind`, `disclosure`, `audience`, `nativeRefs`
and `qualification`. `qualification.viewpoint` distinguishes Johnny's report,
opinion, a remembered accusation, another character's account and the native
codex. `qualification.profileUse` keeps topic facts separate from a personality
demonstration, source corroboration, an epistemic boundary or a conditional
conversation.

`sources` binds an exact depot path and installed archive entry SHA-1 to both
raw-file SHA-256 and freshly serialized JSON SHA-256. A `nativeRef` then pins a
scalar JSON pointer with its expected value, or an exact UTF-8 string-content
SHA-256. This permits independent re-review without copying entire screenplay
passages into a prompt.

The examples are original editorial extrapolations. They contain no speaker-name
prefixes, lyrics or fabricated prior conversations with V. Their linked claim
IDs identify the source material supporting the delivery.

## Authentication method

1. Read the existing Johnny dossier and its native story pack.
2. Locate relevant English subtitle entries, then join their string IDs to scene
   screenplay lines. A scene title or subtitle filename alone is not a speaker
   binding.
3. Export only the exact Pistis Sophia, Phantom Liberty reflection and Kerry
   mansion scene resources using `Cast-SceneEvidence.py`, the pinned WolvenKit
   9.0.1 serializer and the shared two-job CPU gate. Other cited scenes reuse
   the independently refreshed `*-authenticated-oct01` or `flashback-actors`
   receipts.
4. For the localized resources and winning cooked journal, verify the cached raw
   binary against the current installed archive entry SHA-1 and recorded
   SHA-256. Copy it into an isolated ignored evidence folder, freshly serialize
   it with the pinned tool, and compare the complete `Data` to the old export.
   A hash calculated from an old unbound JSON file is not treated as a newly
   authenticated baseline.
5. Resolve and verify all 787 final pointer values and all 21 raw/JSON hash
   pairs. The local verification receipt is
   `runtime/johnny-intrinsic-evidence/verification.json`.

Tool SHA-256:
`7ae9c308da2fe003220b55ce4ca9c122b51f0701a67db1618cca3ff4f7ff6738`.

Fresh isolated scene batches are
`runtime/voice-cast/silverhand-cast/scenes/johnny-intrinsic-oct01` and
`runtime/voice-cast/silverhand-cast/scenes/johnny-music-oct01`. The newly bound
localized/journal receipts are under
`runtime/johnny-intrinsic-evidence/localization`. These are local ignored
evidence, not additional production runtime assets.

No GPU synthesis, cloud request, game mutation, native predicate, generated
knowledge output or Git commit was made in this lane.

## Service, loss and political disillusionment

The Pistis Sophia scene explicitly binds the relevant lines to Johnny and his
normal voicetag. It supports his account that he enlisted young in a corporate
army, was in Mexico, came to believe ordinary people lost while corporations won,
deserted, and spent roughly a month withdrawn in a hotel room. The statement
about corporate victory is his political interpretation; it should not become
an omniscient explanation of every contemporary conflict.

The same scene describes an unnamed man who sacrificed his life for Johnny in
Mexico. The reviewed statement does not identify that man. It does not make V
the present owner of the tags or establish a promise between the current V and
Johnny.

The later `q305_12_johnny` dialogue contains a separate first-person recollection
of Cole, who was bleeding out in Johnny's lap and asked for a cigarette. The
pack preserves the personal recollection and reluctance suitable to that topic.
It does not equate Cole with the unnamed dog-tag owner, infer a precise date or
enemy, or seed any choice concerning Songbird, Reed or Myers.

The soldier lines do not establish a named military employer, rank, unit,
enlistment year, or circumstances of his amputation. The inventory description
of the tags and its Robert John Linder engraving are not used to silently settle
who the unnamed owner was. That is a genuine limit, not missing filler to invent.

## Music and distinct friends

The native codex identifies SAMURAI's frontman and the association with
*Chippin' In* and *Never Fade Away*. The mansion material adds practical
instrument familiarity, recognition of an old single, teasing about Kerry's
titles and his report of urging Kerry toward an independent path. It does not
prove sole authorship of every track or provide a tuning, guitar model or
complete discography.

The former bandmates have different textures:

| Person | Supported texture | Excluded inference |
| --- | --- | --- |
| Kerry | Familiar teasing and an earlier push toward independence | Current reunion progress, sole authorship or every rumour about their relationship |
| Denny | Johnny respects her talent and backbone while also being impatient | V choosing her over Henry or a completed present dispute |
| Henry | Blunt distrust; Johnny is not uniformly fond of all bandmates | Death, liver condition or every unverified allegation |
| Nancy | Johnny credits her practical effectiveness; Henry remembers the same role in the old days | A current reunion, access to reporting sources or private contacts |

Kerry's recollection of rough gigs, arguments and money trouble is kept as
Kerry's framing. It is useful corroboration and delivery texture; it is not
Johnny automatically remembering a conversation Kerry had with the current V.
Contradictory partisan music criticism and explicit fan fiction found in the
onscreen resources are excluded from biography.

## Alt, Thompson, Rogue and Santiago

The freshly authenticated 2013 memory scenes permit modest personal texture.
Johnny remembers distrusting Thompson's assistance and suspecting a sensational
story; that suspicion does not prove the reporter's hidden motive. The same
account shows Johnny interpreting Alt's kidnapping as aimed at himself and
reacting defensively when confronted. Thompson's rebuttal is pinned alongside
it. This is evidence of a perspective and wounded pride, not a factual ruling
about why Alt was taken.

Rogue's remembered accusations over trust, risk and infidelity remain attributed
accusations within Johnny's account. Johnny redirects toward business. Santiago
backs Rogue and advises protecting herself rather than trusting Johnny's charm;
that does not make him Johnny's close confidant. None of these memories implies
that V witnessed the scenes, met Santiago, or earned Rogue's present forgiveness.

Johnny's extravagant assessment of human Alt's netrunning ability is an opinion.
It does not establish a global ranking or the feelings of the later digital
entity. That entity's identity statement stays conditional on separately
qualified story context. Its assessment of his distorted recollections supplies
an epistemic boundary without pretending that the current V already met it.

## Speaker-binding traps checked

- The mansion's speaker ID 4 is a player actor named `V_Posessed`, with the
  explicitly recorded possessed-Johnny voicetag. It must not be treated as
  ordinary V or resolved to the last regular actor.
- The Thompson and Rogue memory scenes label Johnny `Player`. The character
  record is explicitly `Character.johnny_replacer`, paired with his voicetag.
  `Player` alone would be insufficient evidence.
- The Alt scene spells the actor name `johnny` in lowercase. The pack pins that
  exact value and his matching voicetag, rather than inventing a renamed actor.
- Nancy, Henry, Kerry and Alt statements retain their actual speakers. The
  presence of Johnny in a scene does not make every line his.

## Conversation guidance for integration

Use the material to make an answer specific, not longer. A war question may
first receive a short clarifying pushback; a respectful concrete follow-up may
get one detail about enlistment or desertion. A trusted private exchange can
reach Cole or the period of isolation. The same initial question should not
automatically dump both private stories, a band chronology and a tower raid.

The examples show this progression, rather than a fixed script:

> You want dates, or you want to know why I quit? Different stories.

> Corp army. Mexico. Went in young. Came out knowing who gets rich and who gets buried.

A clarifying question is appropriate when it changes what the person is asking
for. Do not append a follow-up to every turn, force the private story, or make
Johnny refuse every sincere question. He can be abrasive, curious, practical,
briefly reflective or quiet. One concrete beat per normal reply leaves room for
the conversation to develop.

For integration, preserve these distinctions:

- `intrinsic` topic material may enrich the static character background.
- `private-intrinsic` is history the character possesses, with selective
  disclosure; it is not evidence that this V has already heard it.
- `uncertain-recollection` retains its named perspective. Style-only and
  epistemic-boundary uses do not become asserted played scenes.
- `conditional` is not preloadable. This file authors no save predicate;
  independent native quest/disclosure qualification remains required.
- Persona examples describe delivery. They do not get appended to player
  conversation history, sent as fabricated dialogue, or used to create memory.

The oilfield remorse is retained as a conditional personality demonstration.
It must not establish a completed oilfield encounter, forgiveness, a friendship
percentage or a secret-ending unlock. The Phantom Liberty reflection similarly
supports capacity for self-questioning without importing the current V's route.

## Remaining limits

This is a bounded intrinsic-history improvement, not every line Johnny has in
the game. No claim of live prompt acceptance or a convincing generated response
is made from source verification alone. The parent should independently review
the claims, integrate disclosure-aware topic material, and test the actual
conversation path using short, increasingly specific questions. Additional
precise war chronology needs evidence beyond the selected self-reports; the
answer should remain modest until that evidence is obtained.

## Claim-scoped attribution amendment

Every claim now pins the typed `gameJournalCodexEntry` subject, its exact
`johnny_silverhand` ID, joined speaker/line pairs, and explicit subject-frame
voice/record fields. A witness stays a witness; the represented Johnny player
frame is distinct from that witness. The mansion has both ghost and possessed
frames; Kerry's early-gig lines explicitly address actor 4, so that exact
addressee selects the possessed frame instead of guessing from a scene actor list.

The attributed Santiago recollection is intentionally public-safe: it describes
protective advice and distrust within Johnny's remembered account, with no
private allegation or present V event. Its `represented-memory` mode and limits
must remain intact.

The tracked pack includes a compact `nativeQualificationReceipt`; it records
the verified source fingerprint, typed attribution and exact pointer checks.
It supports precompiled pinned context without raw native file loads during a
conversation. It does not certify a played scene or generated response.

Final raw-file SHA-256: `25b1ab54131f9c32dcb0fb68730975fcfea682c209c7139c177438702656ce8c`.

Final `canonical-json-v1` SHA-256: `e2ceecd1c589adcf2d7ca8b40cf09fa64bda63978f9f6015509bb53d523303d2`.
