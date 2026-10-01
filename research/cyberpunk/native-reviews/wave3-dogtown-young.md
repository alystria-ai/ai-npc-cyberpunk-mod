# Aaron, Paco and Babs: public personal history proposals

Prepared against installed English Cyberpunk 2077 **2.31** on October 1, 2026.
These files remain unadopted. Parent review owns promotion, compiler subject
qualification and any eventual cloud profile update.

| Character | Public claims | Separate private claims | Original samples | Exact native pointers |
| --- | ---: | ---: | ---: | ---: |
| Aaron Waines (`aaron`) | 11 | 2 | 6 | 476 |
| Paco Torres | 6 | 0 | 6 | 170 |
| Barbara "Babs" Okoye | 8 | 2 | 6 | 181 |

Files: `native-character-proposals-wave3/aaron.json`,
`native-character-proposals-wave3/paco-torres.json`, and
`native-character-proposals-wave3/babs-okoye.json`.

## Native subject identities

All three have genuine **`gameJournalCodexEntry`** subjects in the authenticated
EP1 cooked journal. No phone contact or record was relabeled as a codex entry.

| Roster key | Native codex ID | Title LocKey | Exact English title | Body LocKey |
| --- | --- | --- | --- | --- |
| `aaron` | `aaron` | `87733` | Aaron Waines | `87734` |
| `paco-torres` | `paco` | `91120` | Paco Torres | `91121` |
| `babs-okoye` | `babs` | `91122` | Barbara "Babs" Okoye | `91123` |

Subject pointers share
`/Data/RootChunk/entry/Data/entries/2/Data/entries/1/Data/entries/2/Data/entries/`:
Aaron is index **18**, Paco **21**, and Babs **22**, each followed by `/Data`.
Every claim cites the typed subject, native ID, title LocKey and its exact English
title. Codex claims also cite the subject's description LocKey and the matching
English content. Full source strings are hashed rather than copied as long
prompt passages.

Actual scene speakers are independently bound by typed actor, screenplay item
and recorded VO event:

| Scene | Actor | Actor pointer | Voicetag |
| --- | --- | --- | --- |
| `mq306_01_intro.scene` | Aaron | `/Data/RootChunk/actors/0` | `2918414563693977600` |
| `mq301_01_fireplace.scene` | Paco | `/Data/RootChunk/actors/0` | `2958152608508186624` |
| `mq301_01_fireplace.scene` | Babs | `/Data/RootChunk/actors/1` | `2958153248038883328` |

Aaron's scene is the EP1 mq306 boxer, whose real codex title is **Aaron Waines**.
Base-game Aaron McCarlson is expressly excluded. No shortened-name or WEM-prefix
heuristic substitutes for the subject/title/speaker evidence.

## Source and verification method

1. Reused the authenticated `phantom-main/scenes/ordinary-dialogues` intro and
   fireplace scenes, and `phantom-main/intrinsic-support` EP1 journal/onscreen
   receipts. Rechecked raw SHA-256, raw archive SHA-1, JSON SHA-256, native root
   types and the serialization source filename before authoring.
2. Exported two exact additional Aaron scenes through the tested
   `Cast-SceneEvidence.py` wrapper, into the isolated
   `runtime/voice-cast/minor-generic/scenes/wave3-dogtown-extra` batch. Both were
   present; their native payloads total **993,016 bytes**. The shared OS gate
   bounds archive/serialization work to two CPU workers globally.
3. Authenticated four exact shipped English subtitle resources in the lane's
   own `wave3-dogtown/support` folder, using winning installed archive entries,
   decoded size/SHA-1 checks and pinned WolvenKit **9.0.1** serialization.
   One serializer processor was used. This was native text/resource work, not
   WEM decoding or audio processing.
4. For scene claims, joined the actual actor ID to screenplay `speaker.id`, the
   line `itemId` to its `scnDialogLineEvent`, and recorded the real VO expression,
   context and holocall flag. Bounds-checked each `en_us` descriptor's `vpeIndex`
   and equal `variantId`, then matched the exact decimal localization ID to the
   shipped English subtitle. **No English variant differences occurred in the
   selected claims.**
5. Independently verified **827 exact pointers across eight unique raw/JSON
   artifact pairs**, including public and private rows, and **20 actor/speaker
   joins**. Current installed winning archive directory hashes were checked for
   every source. All checks passed, with zero pointer/hash errors.
6. Checked final-schema normalization and actual original-dialogue prefix
   validation. All three normalize and all 18 samples are plain spoken words
   without names, speaker labels, paired player lines or stage directions.

Receipts and reusable lane scripts are under ignored
`runtime/voice-cast/minor-generic/wave3-dogtown/`:
`discovery.json`, `build-summary.json`, `verification.json`,
`compiler-check.json`, and `support/receipt.json`.

Pinned WolvenKit executable SHA-256:
`7ae9c308da2fe003220b55ce4ca9c122b51f0701a67db1618cca3ff4f7ff6738`.

## Aaron: a boxer with a childhood and a career choice

Public material covers his Dogtown roots, earlier Animals affiliation, their
initial support of coaching and implants, his decision to concentrate on boxing,
training with Razor, and his assessment of distance, technique and punching
power. Reserved delivery is a codex description, not a psychiatric diagnosis or
a requirement to make him humorless.

The exposition walk supplies his own recollections of his father's construction
work, time spent in Dogtown, the move outside the wall after the development went
bust, and his father's ambitions for Terra Cognita. These remain **Aaron's
testimony**. The source says construction "here" during the expo walk; it does
not itself prove the specific **Anatomicon** building, employer or year. The
proposal expressly blocks those embellishments. The father's hopes are not
converted into a claim that the planned exposition was completed.

The control chip, fixed bouts and Angie's power remain separate **private**
history. They are not in universal public compiler material and do not prove
that V learned the story, helped at the clinic, removed the chip, reached an
agreement, saved Aaron, or determined his later fight result. No survival,
escape or death is preloaded.

Original samples give a concrete boxing observation, a brief family recollection,
an admission about career choice and a topic choice for overly broad biography
questions. They do not invent a championship record or turn every answer into a
boxing metaphor.

## Paco: energy and performance without false Hansen history

Public material stays within his rookie status, opportunistic confidence,
impulsiveness, sociability and taste for immersive storytelling. Descriptions of
naivety are source-bound tendencies, not a claim that he is deliberately foolish
or incapable of learning.

The fireplace's ordinary **Paco** actor invites conversation and introduces
Deep Dive as a way of pulling the listener into his performance. His explicit
instruction to imagine being Hansen is retained as a **storytelling frame**.
No performed Hansen feat, thought or narration is adopted as Paco's objective
history, Hansen's biography, or a memory that the current V consumed Deep Dive.

Generator plans, Yuri framing, contacts, later employment, Nairobi, rescue,
escape and death remain excluded from the static proposal. The samples allow
his confident performance to soften when challenged and give him room for
ordinary conversation beyond the quest crisis.

## Babs: independent priorities as well as friendship

Her native codex supports her full name, several years in BARGHEST, pragmatic
judgment, preference for a quiet life and her place as **Paco's best choom**.
The source describes her importance to Paco; it does not rank all her other
friendships. The older-sister role is figurative and gives no biological kinship,
romance or parental authority.

Her actual fireplace replies support narrowly labeled authoring inferences:
she challenges vague assurances and notices the risk of discussing sensitive
business in public. These are bounded delivery tendencies, not omniscience,
paranoia or a requirement to lecture in every response.

Being framed by an ex over infected braindances, and that ex's disappearance,
are separate **private** rows. No guilt, named ex, death, revenge or resolution
is invented. Her samples express friendship and practical concern while leaving
her own priorities and decisions intact. They do not make her exist solely to
rescue Paco.

## Compiler adoption status

The current production compiler accepts Aaron's **11 public claims and six
samples**, verifying **436 public references/attribution checks**. His two
private rows remain excluded.

Paco and Babs currently fail the compiler's **native subject identity** check:
the canonical roster keys differ from their actual codex IDs. Each proposal
provides an explicit `subjectBindingProposal`, title proof and source-hashed
actor/voicetag receipts for parent qualification. The compiler owner was given
the exact IDs, titles and native speaker pointers. No fake codex IDs, roster
aliases, permissive subject matcher or shared compiler edits were used here.

These are technical/source checks, **not independent semantic adoption**.
No shared knowledge build, roster edit, cloud request, GPU work, audio edit,
game/save action, conversation memory write, installation or commit occurred.
