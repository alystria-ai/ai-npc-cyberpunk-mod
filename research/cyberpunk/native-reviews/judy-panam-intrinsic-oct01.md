# Judy and Panam intrinsic authoring review — 2026-10-01

## Scope and result

These are **authoring proposals**, kept outside `native-character-claims`:

- `native-character-proposals/judy-alvarez.json`
- `native-character-proposals/panam-palmer.json`

The proposals deepen each character's ordinary history, work, values and conversational delivery. They do not preload meetings, romance, rescues, endings, player choices or shared experiences. No roster generation, cloud profile update, game installation, GPU synthesis, memory seeding or Git commit was performed by this work lane.

| Character | Public topic claims | Private claims | Conditional development | Original samples | Native sources |
| --- | ---: | ---: | ---: | ---: | ---: |
| Judy Alvarez | 18 | 3 | 1 | 8 | 7 |
| Panam Palmer | 15 | 3 | 2 | 8 | 9 |

The two packs share the same authenticated cooked journal and English codex text: **14 distinct raw/JSON artifact pairs**, including **12 freshly exported spoken scenes**. Public claim text plus its scope limits is approximately 4.5k characters for Judy and 3.6k for Panam, beneath the existing compiler's 6k-character limit. This is bounded topic material, not a biography to recite every turn.

## Evidence format

The proposals use the finalized Johnny schema and the existing intrinsic compiler's exact subject/speaker requirements:

1. Every claim pins a typed `gameJournalCodexEntry` subject. Judy uses `judy_alvarez`, Panam uses `panam_palmer`. This subject identity cannot be reassigned through a similarly named actor.
2. A codex claim joins that subject's `textContent` LocKey to the exact English on-screen entry and variant.
3. A spoken claim joins the actual typed actor, actor ID and voice tag to its screenplay line. Every cited line includes an actual `scnDialogLineEvent` referring to that screenplay item, and the cited `en_us` descriptor resolves to its exact `vpeIndex` and text hash.
4. Source objects record the installed winning archive, FNV depot hash, archive entry SHA-1, raw SHA-256, freshly serialized JSON SHA-256 and pinned WolvenKit tool hash. New scene sources additionally bind the completed isolated inventory hash.
5. Recollections and opinions remain attributed. Interpersonal/cadence interpretations explicitly identify themselves as editorial inference from that character's speech.

Scenes where the actor's record field is zero are not presented as proof of a literal record name. Typed canonical codex subject, actor identity, native voice and screenplay/event joins provide the scoped attribution. No zero-valued `specRecordId` is converted into a fabricated `Character.*` string.

## Character-specific material

### Judy

Public material covers gifted BD editing and technical work, professional independence, Mox affiliation and resistance to injustice; sensory calibration, custom workshop equipment, raw versus packaged recordings, editing attention and emotions, and her view of BDs as art. It also supports practical aftercare, access boundaries, quick dry interruptions, childhood Laguna Bend, her grandfather's technical mentorship, rollerblade street hockey and junkyard games, nostalgic Flo's Diner burgers, grandparents in Oregon, playful treasure exaggeration and curiosity about church acoustics.

These are distinct topics, not additional aliases for a single tragic biography. The samples let her answer with concrete work, affection, ordinary memories and a short joke. They are original utterances; no `Judy:` prefix or paired `V:` line occurs in them.

Private rows hold parental loss/absence, Jenni Chapman and the emotionally difficult homecoming. The homecoming additionally needs actual loaded-save qualification because the disclosure is scene-timed. The later two-actor BD experiment stays conditional; the first workshop encounter must not magically grant her that later development.

### Panam

Public material covers her Aldecaldo background, the historical clash with Saul and attempt at Night City merc work, old friendships with Mitch and Scorpion, migration to California, family disagreements, prolonged road life, skepticism about corporate bargains and government favors, self-reliance, selective personal boundaries, hands-on repair cadence, familiar needling, mock-formal reviews, dry understatement and concrete task instructions.

The early codex is treated as a historical crossroads, never a command to keep her estranged after the save changes her circumstances. An old friendship does not assert Scorpion is currently alive or present. Her road-life claim imports the general first-person background, expressly excluding the source's shared-history clause about sleeping under a roof with V.

Early clan loneliness and angry criticism of Saul remain private and source-era qualified. Camp stargazing wordplay remains private rather than becoming assumed romance or astronomy expertise. Basilisk teaching and credit to Mitch/Bob remain conditional; the party gains no vehicle, training history or neural intimacy from static authoring.

## Fresh acquisition and source decisions

Only the completed `aldecaldos` casting lane's new isolated subdirectories were used:

- `runtime/voice-cast/aldecaldos/scenes/judy-panam-intrinsic-oct01` — five Judy scenes; 1,593,230 decoded bytes.
- `runtime/voice-cast/aldecaldos/scenes/judy-panam-intrinsic-pan-scenes-oct01` — four Panam scenes; 3,809,023 decoded bytes.
- `runtime/voice-cast/aldecaldos/scenes/judy-panam-intrinsic-early-pan-oct01` — three early/default Panam scenes; 775,428 decoded bytes.

`scripts/Cast-SceneEvidence.py` resolved current installed winners, used the shared two-CPU OS gate, and freshly serialized each requested exact resource with pinned WolvenKit 9.0.1. All batches completed with no missing paths. Accepted voice reference WAVs, audio manifests and other casting outputs were untouched.

The canonical cooked journal is the current EP1 winner for the base journal depot path. The English codex text is the authenticated base English on-screen resource. Panam's default scene wins from **basegame_4_gamedata.archive**, even though it contains Phantom Liberty-related dialogue; it must not be mislabeled as an EP1 archive override.

Shipped subtitle resources were examined during read-only candidate discovery where available. The proposal's exact spoken-word proof uses the freshly authenticated scene's embedded English variant, avoiding retroactive qualification of older unbound subtitle exports. Panam's early roadhouse line 27 has a small embedded/shipped wording difference and is not used.

## Independent review and corrections

A separate read-only reviewer inspected semantic entailment and all rows, including rows the public compiler deliberately skips.

| Check | Judy | Panam |
| --- | ---: | ---: |
| Exact value/hash pointers across every claim | 1,152 | 714 |
| Typed actor → screenplay → English variant → spoken-event joins | 59 | 32 |
| Current winning archive/raw/JSON source pairs | 7 | 9 |
| Public compiler claims selected | 18 | 15 |
| Public compiler samples selected | 8 | 8 |
| Public compiler reference checks, including attribution checks | 978 | 535 |

Review corrected two unsupported implications before completion:

- Judy's chosen device was described as “older”; the cited dialogue proves particular model/scanware/matrix choices, not its age. The adjective was removed.
- Panam was said to leave the clan “for a time”; the early codex alone does not prove a later return. That phrase was removed.

The reviewer confirmed exact SHA-256 pairs, raw SHA-1s, current RDAR winners, inventory receipts, typed subjects, cited English text joins and plain original samples. Public adoption has no remaining review blocker. This is source qualification, **not** an installed/live game acceptance result.

## Promotion boundaries

The existing intrinsic compiler selects only the 18/15 public claims and their eight eligible samples. It excludes all six private rows and all three conditional rows. Their presence in the proposal is not authorization to flatten them into API bio, group context or player memory.

Private or later-development promotion needs separately reviewed runtime prerequisites and channel policy. In particular, do not loosen clan-era/homecoming conditions merely to make a conversation more detailed. Current verified save facts override past framing; absent context proves no event or disclosure.

No Panam birthplace/parents/military history, personal ownership of every vehicle modification, Judy's Maiko history, or invented credentials were added to reach a target count. The farmhouse chinook/insomnia line and shoe joke were not converted into literal biographical facts. Default native blinking and accepted eye contact, movement and lip-sync were untouched.
