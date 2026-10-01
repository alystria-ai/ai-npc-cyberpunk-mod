# FIA character histories and conversational range

Authored 2026-10-01 against installed English Cyberpunk 2077 **2.31**.

These are **proposals awaiting independent semantic and hash review**, outside
the approved/adopted claims folder. They have not been sent to Convai, installed
in the game, or made into player conversation memory.

| Character | Public topic claims | Separately private claims | Original delivery examples | Native artifacts | Exact pointer checks |
| --- | ---: | ---: | ---: | ---: | ---: |
| Solomon Reed | 12 | 3 | 8 | 4 | 418 |
| Songbird | 13 | 4 | 8 | 4 | 594 |
| Alex | 17 | 5 | 8 | 6 | 855 |

Files: `native-character-proposals/solomon-reed.json`,
`native-character-proposals/songbird.json`, and
`native-character-proposals/alex.json`.

## Evidence and authoring method

1. Read the existing dossiers to identify thin biography, missing personal
   topics, and unsupported assumptions. Their community-source claims did not
   count as native qualification.
2. Locate relevant native scenes through exact resource links in quest phases.
   Export six bounded resources into the isolated
   `runtime/voice-cast/phantom-main/scenes/intrinsic-fia-oct01` batch with
   `Cast-SceneEvidence.py`. The shared OS CPU gate permits at most two decoder or
   archive jobs, and this serialization worker used one .NET processor.
3. Independently read the exact winning EP1 cooked journal, English onscreen
   codex and five English subtitle resources from the installed archives.
   Decoded size and archive SHA-1 are checked before a fresh serialization with
   pinned WolvenKit 9.0.1. The local receipt is
   `runtime/voice-cast/phantom-main/intrinsic-support/receipt.json`.
4. Bind every claim to its typed `gameJournalCodexEntry` subject, title LocKey,
   and matching exact English title. Codex claims also bind the description
   LocKey and English content. Native scenes join an actual typed actor ID and
   voicetag to a screenplay speaker, screenplay item, recorded dialog VO event,
   embedded `en_us` descriptor/payload variant, and the same-ID shipped subtitle.
   Hashes preserve complete source strings without copying whole passages into
   the prompt.
5. Verify all **1,867 pointers** across public and private claims, all recorded
   raw/JSON SHA-256 pairs, the current installed winning archive metadata, and
   actor-to-screenplay joins. The read-only verification receipt is
   `runtime/voice-cast/phantom-main/intrinsic-support/verification.json`.
   This is technical qualification, **not independent semantic approval**.
6. Write original spoken examples linked only to eligible public claims. No
   speaker-name prefix, quotations, song lyrics, paired transcripts or synthetic
   V conversations. Broad biography questions get a choice of topic or one
   concrete beat, leaving room for back-and-forth.

Pinned serializer SHA-256:
`7ae9c308da2fe003220b55ce4ca9c122b51f0701a67db1618cca3ff4f7ff6738`.

Current native support evidence occupies ignored local research folders. It is
not extra production runtime data. No GPU synthesis, cloud request, game action,
generated knowledge build, roster change, memory write or Git commit occurred
in this lane.

## Exact subject identities

The roster key and native codex ID are **not always the same spelling**.

| Roster key | Typed EP1 codex ID | Title LocKey | English title |
| --- | --- | --- | --- |
| `solomon-reed` | `reed` | `86423` | Solomon Reed |
| `songbird` | `songbird` | `86427` | Songbird |
| `alex` | `alex` | `86391` | Alena "Alex" Xenakis |

Reed requires an explicit reviewed key-to-native-subject mapping. Scene names
`Reed` and `Reed_Holo` bind to voicetag `2553392786132918272`; they are not inferred
by shortening a display name or stripping a suffix. The proposals record exact
codex/title, actor, line and voice references per claim. No roster aliases were
changed. `Reed_Holo` events preserve their actual phone VO expression and
holocall flag; they are useful historical testimony, not clean voice-clone audio.

## Reed: service, competence and cost

The native codex supplies a useful career rather than a generic cautious-agent
paragraph: protective operations, kidnapping negotiations, blackmail, sabotage,
South American coups, and a Night City spy network during the Unification War.
It also explicitly contrasts his purpose in service with fame and medals. The
pack does not invent country names, victims, dates, units or successful outcomes
for present operations.

The Moth scene adds his account of leading the cell and handling Alex, orders to
go to ground, taking the fall behind a cover story, and surviving partly through
luck. His explanation remains a **self-report**; Alex's contrary belief is not
silently erased. More sensitive details—Myers leaving him for dead, the Arasaka
cover story, inability to return home, and an unsuccessful relationship—are
separate private material. No partner identity or present relationship state is
invented.

Original examples use understatement, direct distinctions, limited admissions
and practical experience. They do not make every answer a mission briefing,
patriotic speech, therapy paragraph or automatic follow-up question.

## Songbird: skill with an ordinary former life

The codex supports freelance ambition, solo work, dangerous commissions,
equipment and entertainment spending, the NUSA oath and codename, prototype
access, and the adjustment to orders and team work. Specific covert support
activities include masking signatures and removing digital footprints. This
does not grant omniscience, unrestricted hacking ability, or every classified
technical detail.

The rooftop scene supplies ordinary personal texture: Brooklyn, an old Night
City assignment, a fire escape, street music, a scopdog seller and bonfire smoke
on a Thursday. This is **Songbird's recollection**, not a newly fabricated player
memory. It may be disclosed in a small relevant amount; it should not trigger a
recital of the full rooftop confession.

Her report of recruitment at nineteen after a failed Militech intrusion,
fragmenting memory, her mother's lost voice, moments of losing control, and
separation from Brooklyn remain separately private. The line about her home
burning down is treated as figurative loss: it is not proof of arson or physical
destruction. No clinical diagnosis or named unseen entity is invented.

Two q305 recollection resources were exported for comparison. The flatline
scene stages multiple Reed/Songbird actors inside a hallucination frame; the
minor recollections mostly contain nonverbal distress and computer sounds.
They were **not** promoted as an objective recruitment transcript, personality
dialogue, or a current V memory. The clear first-person rooftop account is used
instead. Lucas details are left out because this bounded selection did not
authenticate enough support to expand that relationship honestly.

Two embedded/shipped English differences occur in selected lines. One adds a
comma and expands `startin'` to `starting`; another encodes a stutter explicitly.
Both full string hashes and the difference review are recorded in
`englishVariantReview`. Their string IDs match, and neither change alters the
claim. The review does not pretend the bytes are identical or repair native
text globally.

## Alex: performance and life beyond a cover

The codex binds Alena Xenakis, Los Angeles, the BD-studio recruitment front,
Reed's mentorship, metanthropic specialization, classified domestic/foreign
work, and the Unification War posting. Childhood poverty and parental addiction
are private, not colorful filler to recite to every acquaintance.

Her Moth account adds seven years on the same assignment, local arms/technology
dealers, her reason for joining, and the desired warm Riviera life. These are
history and aspiration; they do not say retirement or a diplomatic posting was
granted. Her normal preference for musicals, dancing, honest make-believe,
acting as an honorable craft, and Norma Desmond in *Sunset Boulevard* provide
more range than bartender banter and weary spy aphorisms.

The stage dream remains a dream. She says she had not acted for more than an
audience of one; no professional filmography is invented. Burnout, nerves, the
old self under her masks and her grievance against Reed are private details.
Nothing implies that the current V attended the evening, danced with her,
became romantically involved, received a farewell or later read a postcard.

## Story and knowledge boundaries

- No V trust, prior meeting, FIA oath or completed operation is preloaded.
- No Songbird cure confession, actual fate, launch or Cynosure resolution.
- No Reed death, Alex death/survival branch, farewell, coin gift, Monte Carlo
  outcome or Player Tower ending.
- A summoned model does not rewrite the canonical state of any of those events.
- Private testimony is not shared knowledge among Reed, Alex and Songbird.
- Historical source perspective, uncertain interpretation and sensitive
  disclosure remain attached to their claims. Current-save awareness continues
  to require independently reviewed runtime predicates or real conversation.

## Promotion gate

Independent review identified two wording risks and the proposals were corrected:
Reed survived the collapse of the **Night City FIA operation**, not destruction
of the city; the dirty-work example describes dirty orders without inferring
personal shame from a codex that does not establish it. Native evidence, claim
counts and privacy boundaries are unchanged. All pointer and sample checks pass
on the corrected files; final independent approval remains the parent's gate.

Parent review must independently check claim meaning and archive/hash integrity,
including Reed's explicit native subject and speaker alias support, before
moving these files into the adopted claims folder. The public compiler should
select the bounded public topic claims and their original examples only;
separately private claims are not authorized for unconditional prompt insertion.
