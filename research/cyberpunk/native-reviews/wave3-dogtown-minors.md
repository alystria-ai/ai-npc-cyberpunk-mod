# Wave 3: Briana, Mark Bana and Steven — primary history

Prepared October 1, 2026 against installed English Cyberpunk 2077 **2.31**.
These three source proposals are not adopted, installed or sent to Convai.

| Character | Public topic claims | Private claims | Original delivery examples | Exact pointer checks |
| --- | ---: | ---: | ---: | ---: |
| Briana Dolson | 5 | 1 | 3 | 118 |
| Mark Bana | 4 | 0 | 3 | 192 |
| Steven Santos | 6 | 0 | 3 | 95 |
| Total | 15 | 1 | 9 | 405 |

Proposals are under `native-character-proposals-wave3/`. This lane changes only
`briana-dolson.json`, `mark-bana.json`, `steven-santos.json` and this review. The
isolated support scripts, fresh resources and receipts stay in ignored
`runtime/voice-cast/phantom-gigs/wave3-support/`.

## Exact finalized subjects

| Roster key | Native typed subject | ID | Name/title LocKey | Finalized English |
| --- | --- | --- | --- | --- |
| `briana-dolson` | `gameJournalCodexEntry` | `briana_dawson` | `86358` | Briana Dolson |
| `steven-santos` | `gameJournalCodexEntry` | `steven_santos` | `86384` | Steven Santos |
| `mark-bana` | `gameJournalContact` | `mark_bana` | `82536` | Mark Bana |

Briana's finalized description is **86359**, Steven's **86385**. Earlier text
IDs and alternate draft names are not substituted for the active journal-bound
description. Briana's native ID retains the `dawson` spelling, while its exact
title says Dolson. The canonical roster remains untouched.

The reviewed EP1 journal has no Mark Bana codex entry. The genuine contact has
`PhoneAvatars.Avatar_Bana`, a name bound to finalized English **82536**, and the
actual client-meeting performer `Bana` directly binds
`Character.sts_ep1_08_bana`. It is therefore an explicit Contact plus canonical
record alternative, not a fabricated codex or title inferred from a filename.
Parent compiler qualification must support this typed subject and `name/value`
title field; the existing codex-only route must not be bypassed by falsifying
the proposal's container type.

## Evidence and verification method

1. Read finalized journal subjects and their exact English title/description
   bindings. Only finalized active LocKeys are used for subject ownership.
2. Reuse the previously reviewed gig-scene discovery, then reread exactly six
   current installed resources: EP1 cooked journal, EP1 `onscreens_final`, the
   Briana mourner scene plus its English subtitles, and the Spy in the Jungle
   client meeting plus its English subtitles.
3. Use the verified archive reader and pinned WolvenKit **9.0.1** serializer in
   the lane's own folder. Every resource is bounded, native winning precedence
   is checked, decoded payload size/SHA-1 is verified, and source serialization
   paths plus raw/JSON SHA-256 hashes are retained. These six raw payloads total
   **4,628,409 bytes**, within an explicit 32 MiB limit.
4. Every scene claim binds a typed actual `scnActorDef`, stable actor ID and
   voicetag to the screenplay speaker/item, an actual `scnDialogLineEvent`, its
   context/expression/holocall/custom-event flags, the exact embedded `en_us`
   descriptor, bounds-checked payload index and matching variant ID. The same
   decimal localization ID joins the shipped English subtitle. All selected
   embedded/shipped transcripts agree exactly; no correction is guessed.
5. Claims preserve codex editorial portrayal or named colleague/self-report
   viewpoint. Public biography has no V encounter, contract choice, current
   injury/death or trust receipt. Private history is excluded from public
   sample dependencies and universal compiler material.
6. A fresh read-only check verifies **405 pointer/value/hash references**, all
   source raw/JSON hashes, current installed archive entry winners, exact
   finalized subject titles and typed speaker-to-line joins. Receipt:
   `runtime/voice-cast/phantom-gigs/wave3-support/verification.json`.

Pinned serializer SHA-256:
`7ae9c308da2fe003220b55ce4ca9c122b51f0701a67db1618cca3ff4f7ff6738`.

Extraction/serialization used the shared two-CPU OS gate and exclusive lane
lock, with one .NET processor. The completed support command owns no remaining
worker. No audio was decoded, altered or synthesized by this history work.
There was no GPU, cloud, game/save/memory action, global build, roster edit,
child agent or Git commit.

## Briana: community care without borrowed motherhood

The finalized codex supports a practical local organizer: solving residents'
daily problems created her standing; people seek her help over food, missing
children and bereavement. Her generosity is explicitly directed toward people
she considers her own, and strangers remain suspicious. The proposal avoids
inventing municipal office, corporate rank, unlimited resources or instant V
trust.

The actual mourner scene actor is **`briana`**, voicetag
`3262300873080205312`, with community entry **`hana`**. V addresses her as Briana,
she confirms, and later introduces herself as Briana. The other actor,
**`mother`/Martha**, has a different voicetag and is Jason Foreman's mother.
Neither Martha's generic voice nor her personal loss is assigned to Briana.

One public scene claim describes Briana's approach of learning who someone is
before working with them. It does not say this player completed that
introduction. Her recollection that the Tygers pursued her six years earlier
and she fled to Dogtown remains **private**. No cause of that pursuit, gang
membership, offense, birthplace or attack is inferred.

Rinder's location/fate, investigation, dog-tag delivery, payment and V's
contract conduct are excluded from primary history. Positive current-save
rules, with their own knowledge/audience gating, would be required for those.

## Mark Bana: a limited authentic profile

Mark has no reviewed codex biography. Ana's attributed client-meeting description
supports his stated age of **37**, **12 years at the agency**, and **combat
training**. Steven's explicit Brazilian Intelligence Agency introduction in
the same meeting establishes the employer context. The claim retains both
colleagues' viewpoints and their exact source/event/English joins. The genuine
Contact and canonical `Bana` record establish the intended subject.

This evidence does not supply childhood, family, home city, hobbies, an army
unit, war service, weapon specialty, kill count or colorful espionage exploits.
Four public facts and three modest editorial cadence examples are sufficient;
the pack does not inflate the available material into a major-character life
story. His dialogue examples make no claim to a well-established calm native
cadence, because the authentic spoken material is a distressed recording.

The target-meeting `bana_voice` and `bana_impersonated` are deliberately
excluded. Katya's deception, identity and interrogation cannot become Mark's
personal memories. The authentic client-scene distress recording has
`Vo_Expression_Phone` and custom `vo_q305_bunker_screen`; it neither qualifies a
clean cloned voice nor an ordinary personality baseline. His disappearance,
captivity, injury, death, SovOil negotiations, agency suppression and V finding
his biomonitor require separately reviewed save/audience knowledge and are not
preloaded here. Mark Bana is distinct from Mark Muratovich.

## Steven: professional role, not an invented life

The finalized codex identifies a risk assessment specialist in Brazil's
intelligence service and supplies a bounded editorial portrayal: patriotism,
professional discretion, reluctance around unpleasant or morally charged
choices, familiar rationalizations and limited efforts to ease a murky
conscience. These general characterizations are not a diagnosis or a guarantee
that he always lies, is fearless, or will make one specific decision.

The client meeting's actual actor **`Steven`**, voicetag
`3262212739462098944`, says his agency scans potential contractors. The proposal
retains this as his professional account, while withholding any claim about a
scan of the current player, findings or clearance. Employment does not establish
birthplace, nationality, rank, career length, training, unit, family or combat
history.

Bana's case, the biomonitor, agency suppression, SovOil negotiations, V's choice
and a later stadium meeting remain operational or current-save material. Ana's
anger is not silently transformed into Steven's thoughts. Three original
delivery examples use concise risk framing and qualified pragmatism rather
than copied lines or a long invented career monologue.

## Parent review and adoption boundary

All three proposals remain outside `native-character-claims/`. The source
verification above is technical authoring proof, not independent semantic
approval or installed live behavior. Parent review must qualify Briana's
native ID/title/actor alias and Mark's genuine Contact/record alternative before
compilation or adoption. Public sample IDs depend only on public claims; no
sample has a speaker-name prefix or paired V transcript. No reference or source
dialogue is inserted into a player's long-term memory.
