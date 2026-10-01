# Mr. Hands, Regina Jones and Muamar Reyes: intrinsic review

Source review dated October 1, 2026, against installed Cyberpunk 2077 2.31 and
Phantom Liberty winning assets. These are **unadopted proposals**, located in
`native-character-proposals/`. They do not change a cloud profile, generated
knowledge pack, live game, save, voice manifest or memory.

## Scope and result

| Character | Public claims | Private claims excluded from public profile | Original spoken examples | Exact references |
| --- | ---: | ---: | ---: | ---: |
| Mr. Hands | 10 | 2 | 8 | 259 |
| Regina Jones | 12 | 0 | 8 | 215 |
| Muamar Reyes | 12 | 0 | 8 | 218 |
| Total | 34 | 2 | 24 | 692 |

The proposals follow the version 1 Jackie claim schema, with claim-level
disclosure policy, explicit audience, typed codex identity, exact native speaker
attribution and English variants. Each includes proposed public biography and
delivery guidance. Samples are original editorial dialogue, without a character
name prefix, narration or a shared-history assertion.

These counts describe source-authenticated authoring material. They are not
claims that V read the codex, heard the source dialogue, met the fixer or
completed any quest. The root integration agent owns adoption and dynamic
outcome handling.

## Character distinctions

### Mr. Hands

The public portrait emphasizes cultivated commercial confidence, reciprocity,
information security and controlled political exposure. Personal texture comes
from his own tea blend, occasional unexpectedly bodily humor beneath polished
diction, and a patient boxing metaphor for indirect pressure. Praise is earned
professional assessment rather than automatic flattery. His self-presentation
that clients never regret doing business with him remains a boast, not an
objective guarantee.

His former real identity, Petrochem history and family call are recorded only
in two private claims. They are absent from the proposed public biography and
all samples. His child is not named; no spouse identity, family location or
current family plan is invented. No succession scheme, blueprint delivery,
completed gig or relationship of trust with V is imported.

### Regina Jones

Regina's journalism remains part of her fixer identity: independent reporting
at FTF Radio, the News 54 acquisition, a broad contact network and an
investigative view of information. Her concise, dry teasing and media
skepticism distinguish her from Hands' elaborate courtesy.

Her nonlethal preference is compatible with skepticism about the organization
offering experimental therapy. Neither skepticism nor hope establishes a cure,
medical expertise or a rescued person's outcome. She is not a universal
therapist or an omniscient intelligence service. Max's rescue/death, V's
cyberpsycho results and completed Watson gigs are excluded.

### Muamar Reyes

Muamar's portrait keeps his contradictions. He once worked for an unspecified
corporation and now speaks against corporate exploitation. He identifies with
Santo Domingo's working residents and makes profitable business out of that
solidarity. In person he objects to the word "biz"; his holo introduction uses
the same word in an energetic sales pitch. His vehicle-origin story is evasive
self-report rather than verified European provenance.

One important self-review correction changed the initial draft: the codex's
limo-and-smirk passage **undercuts** the people-first image. It does not promise
that he protects workers from violent nonpayment. The corrected claim and
sample preserve the limits of his solidarity instead of inventing enforcement
or sainthood. No employer, rank, medical supply handoff, delivered vehicle or
current agreement with V is supplied.

## Native acquisition and receipts

Fresh isolated batch:

`runtime/voice-cast/fixers-city/scenes/fixers-intrinsic-oct01/`

| Native depot resource | Purpose |
| --- | --- |
| `base\open_world\fixers\el_capitan\scenes\muamar_reyes_default.scene` | District pride, business self-presentation, past defensiveness, vehicle pitch and evasion |
| `base\open_world\fixers\reggie\scenes\reggie_default.scene` | Reporter identity, information trade, dry humor, local perspective and nonlethal/treatment opinions |
| `ep1\quest\main_quests\q303\scenes\q303_04_mr_hands.scene` | Tea, professional standards, reciprocal favors, discretion, metaphor/humor and separate private family call |

All three requested resources exported successfully, with **854,692 decoded
native bytes**, no missing paths. The bounded scene exporter used the pinned
WolvenKit 9.0.1 serializer, isolated lane output and shared two-job CPU semaphore.
No archive-wide extraction, waveform processing, synthesis, GPU worker or
cloud request occurred.

The previously authenticated, freshly serialized cooked journal and shipped
English onscreens localization are reused from
`judy-river-authenticated-oct01`. Their recorded binary, JSON and inventory
hashes are checked again. The English onscreens hash is absent from the EP1
English archive, so the base `lang_en_text.archive` entry is the current winner;
it is not incorrectly resolved only against gamedata archives.

Local reproducible verification helpers and receipt are kept in the ignored
lane folder:

- `intrinsic-builder.py`: bounded authoring helper for these three proposals.
- `intrinsic-verify.py`: read-only source, pointer and semantic join checks.
- `intrinsic-verification.json`: pinned proposal hashes, artifact receipts and
  exact actor alias evidence.

Verification checks all five unique native sources:

1. Depot FNV64 and current installed winning directory SHA1.
2. Raw SHA1 against the directory and raw SHA256 against the source registry.
3. Recorded serialized JSON SHA256 and inventory SHA256.
4. Pinned serializer header and game version.
5. All **692 exact pointer/value comparisons**, including private claims.
6. All **47 actor-to-screenplay joins**, native speech-event item IDs and
   exact `en_us` descriptor-to-payload variant IDs.
7. Typed codex subject and localized title chain for every claim.
8. Private audience exclusion and public-only claim links for all 24 examples.

Native punctuation is preserved exactly. No blanket Unicode repair, normalized
transcript substitution or guessed actor alias is used.

## Explicit subject bindings required by integration

Muamar's shipped codex ID is `el_capitan`, rather than a mechanically derived
`muamar_reyes`. The exact typed entry is:

`/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/0/Data/entries/2/Data`

Its `title/value` is `LocKey#20091`, joined to the current English onscreens
entry 14943, exact title **Muamar “El Capitan” Reyes**. Every Muamar claim records
that chain through `attribution.subjectTitleRefs` and exact native references.
The compiler must use a reviewed explicit binding, rather than fuzzy matching.

Scene actor receipts:

| Character | Actor name | Actor pointer | Voice tag | Acquisition |
| --- | --- | --- | --- | --- |
| Hands | `Mr_Hands` | Hands source `/Data/RootChunk/actors/0` | `1254681766112239616` | `spawnSet`, `mr_hands_combat_zone`, `#mr_hands_combat_zone` |
| Regina | `regina` | Regina source `/Data/RootChunk/actors/0` | `1609919435757879296` | `spawnSet`, `reggie`, `#reggie` |
| Regina holo | `regina_holo` | Regina source `/Data/RootChunk/actors/1` | `1609919435757879296` | `spawnSet`, `reggie_holo`, `#reggie_holo` |
| Muamar | `muamar_reyes` | Muamar source `/Data/RootChunk/actors/0` | `1609922889482010624` | `spawnSet`, `el_capitan`, `#el_capitan` |
| Muamar holo | `muamar_holo` | Muamar source `/Data/RootChunk/actors/1` | `1609922889482010624` | `spawnSet`, `muamar_holo`, `#muamar_holo` |

All these actors have `specCharacterRecordId` equal to zero. The proposals do
**not** label that field a direct Character-record binding. Their attribution
uses the independent typed codex/localized title plus exact speaker, native
event and English variant evidence.

At initial draft verification, the common compiler correctly rejected the
unreviewed Hands and holo aliases and Muamar codex alias. No roster aliases or
injected compiler inputs were used to manufacture a pass. Alias support belongs
to the root-owned reviewed compiler changes. The final independent review and
compiler results are recorded below when available.

## Independent review and adoption status

Independent source/hash and semantic review found no remaining authored
blocker. It independently passed **17 distinct file/hash checks**, all **692
exact pointers**, all **47 native speaker/line/event/localization joins**, typed
codex subject/title chains and current installed winning archive checks. It
also confirmed the corrected Muamar satire, Hands' private exclusions and all
24 original prefix-free examples. No reviewer file changes occurred.

Reviewed proposal SHA256 pins:

| Proposal | SHA256 |
| --- | --- |
| `mr-hands.json` | `7903b6222de3451e1ae73fbb249ea0cffa32c0081c11d637b8d158ca5867d2bc` |
| `regina-jones.json` | `d790fe25335e84f85708aff9e7bb3d4cf2117dc4a53daa02a040094b7a6d8084` |
| `muamar-reyes.json` | `5e47f6c6419b4689b47fdca1841d38e1bbdfba285eae4614973cb54374cabc4c` |

These files remain in the proposals folder. Common compiler alias
qualification, root review and deliberate adoption are required before they
enter production profile material. This review is source qualification, not
live-save knowledge verification.

Public claims use short relevant topic material; do not concatenate the whole
biography into every reply. The sources qualify character knowledge and
delivery, not any audience's disclosure, a current-save outcome or a Convai
memory. Private Hands claims need a separately reviewed private-context policy
before use. No memory requests or synthetic conversations were sent.
