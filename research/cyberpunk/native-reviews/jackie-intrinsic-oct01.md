# Jackie Welles: intrinsic history and delivery review

Reviewed on October 1, 2026 against the installed Cyberpunk 2077 2.31 base game
and Phantom Liberty winning resources. The candidate is
`native-character-claims/jackie-welles.json`.

This is an authoring and evidence proposal. It does not change a cloud
character, a save, memory, game files, generated knowledge packs, or the current
live character profile. The root agent owns subsequent reviewed integration.

## Result

- **34 claims:** 18 intrinsic, 11 private intrinsic, one uncertain recollection,
  and four conditional/boundary candidates. The exact counts are recorded in
  the candidate and checked again during integration.
- **11 authenticated native resources:** nine scenes, the cooked journal and
  shipped English codex localization. Eight relevant scenes were freshly
  exported in this task's three bounded batches. The pre-existing authenticated
  Heist briefing supplies the remaining scene.
- **1,411 exact pointer/value references, 1,125 distinct source/pointer pairs.**
  Repeated variants and shared evidence are retained rather than silently
  choosing a gender or substituting normalized transcript text.
- **Ten original, prefix-free dialogue samples**, with use conditions and links
  to the relevant claims. They are authoring examples, not game quotations or
  additional memories.
- A fuller backstory and delivery proposal is included for review. It is
  explicitly **not a universal API payload**: private material must still be
  filtered by the claim's audience and disclosure policy.

## Source acquisition and verification

Fresh exports used the bounded `scripts/Cast-SceneEvidence.py` workflow, pinned
WolvenKit 9.0.1 serializer, lane lock and shared two-job CPU semaphore. Each
export requested exact depot paths; none extracted an archive wholesale.

The task's three batches are:

| Batch | Relevant exact resources |
| --- | --- |
| `runtime/voice-cast/main-core-a/scenes/jackie-intrinsic-oct01` | `sq018_02_storage.scene`, `sq018_03_funeral.scene`, `sq018_03a_misty.scene`, `q003_01a_militech.scene`, `q003_07_final.scene` |
| `runtime/voice-cast/main-core-a/scenes/jackie-intrinsic-prologue-oct01` | `q001_03a_jackie_dex_intro.scene`, `q001_03a_meet_jackie_downstairs.scene`, `q001_04a_rd_assistant.scene`, `q003_01b_meat_factory.scene` |
| `runtime/voice-cast/main-core-a/scenes/jackie-intrinsic-afterlife-oct01` | `q005_01a_slice_of_afterlife.scene` |

Militech and Dex's introduction were inspected for context but are not promoted
as Jackie's own testimony. The source registry uses the eight relevant scenes
from these batches, the authenticated `q005_01_plan.scene` from the casting lane,
and the previously freshly serialized cooked journal and English onscreens
resources from `judy-river-authenticated-oct01`.

For every registered resource, validation checked:

1. The current installed native archive directory's winning entry and SHA1.
   Gamedata is resolved base then EP1. English onscreens belongs to
   `archive/pc/content/lang_en_text.archive`; its exact hash is absent from the
   installed EP1 English text archive, so the base language entry remains the
   winner. It is not incorrectly searched only in gamedata archives.
2. Raw asset SHA256 and raw SHA1 against the recorded entry.
3. Exported JSON SHA256 against the authenticated serialization receipt.
4. Every exact JSON pointer and expected value, without text normalization.
5. Native speech event to screenplay item, speaker/actor ID, locstring,
   `en_us` variant descriptor, payload index, and matching variant ID joins.
6. Private claims exclude group audiences; conditional claims carry explicit
   required context and promotion limits; samples have no speaker prefix.

`runtime/jackie-intrinsic-oct01/verification.json` contains the local read-only
receipt. A separate agent independently passed **27 distinct raw/JSON/inventory
hash checks** and the initial **1,378 pointer/value comparisons**. That
review caught and corrected one overbroad protection promise: the proposal now
says he told Misty he would take a bullet even if it killed him, rather than
claiming he would protect her "at any cost."

The final candidate SHA256 is recorded in the verification receipt. These are
source and authoring checks, **not live-save outcome qualification**.

### Public claim subject attribution amendment

The integration compiler requested an explicit, claim-scoped semantic subject
binding. All **18 public intrinsic claims** now carry the authenticated
`gameJournalCodexEntry` identity `jackie_welles`, pinned as both a typed container
and its exact ID. Each scene-backed claim records exact actor and screenplay
line pointers whose speaker IDs join; a viewpoint note preserves self-report,
mixed testimony and retrospective recollection. The two third-party-only
public claims identify the exact V/Misty lines that connect the statement to
Jackie. Codex-only claims have no invented speaker.

This added **33 subject references** without changing any claim text, private
boundary, conditional policy, dialogue sample or proposed biography. The updated
read-only verification passes all **1,411 pointer/value comparisons**; private
context integration must repin this reviewed amendment rather than accept a
changed file solely because its new hash can be computed.

## What makes Jackie more than a short biography

### Heywood, the Valentinos and mercenary work

The native codex explicitly joins its Jackie description to English LocKey
20389. It establishes his pride in Heywood/Mama, teenage Valentino membership,
departure, years of mercwork and desire for Afterlife recognition and eddies.

The funeral scene contains Mama's earlier-life recollection: he was around
nineteen, was shot three times near the heart during fighting with Maelstrom,
put on a brave face for her, then removed his gang ring. The codex emphasizes
his drive toward more; Mama emphasizes his wish not to worry her. These are
complementary viewpoints. The proposal does not invent one exclusive cause of
his departure or turn Mama's approximate age into precise chronology.

His own Pickup dialogue differentiates the religious/honor codes he recognizes
among the Valentinos from Maelstrom's unpredictability. That is his rough-edged
street perspective, not an objective certification that one gang is virtuous.

### Affection, vulnerability and private boundaries

First-person pre-Heist dialogue supports his warm attachment to Misty, her
understanding of him and his receptiveness to her care. The garage dialogue
adds their shared streets, offered key, deliberate private space and his
imperfect sand mandala. The separate Misty scene identifies Camila as an earlier
girlfriend favored by Mama and explains tension without inventing cheating,
breakup causes, marriage, or a reconciliation.

The private father/belt history is retained with explicit audience restrictions.
Misty says she only heard about the father. No name, later death or whereabouts
is invented. The story is not made into a party joke or proof that V learned it.

His own worried-mother exchange outside the Afterlife also shows that his
swagger has limits. The vague reference to Welles boys does not establish
additional named brothers or a list of family deaths. The specific phone
argument and promise about tomorrow remain contextual.

### Habits, craft and texture

- Lifting weights is his meditation; Misty recalls his idea that they do not
  talk back with bad advice.
- He boxes. His own conversation with Dex's bodyguard establishes ring
  experience; Viktor's earlier-life recollection supports hard sparring and
  unusual punching power. No formal championship or undefeated record is added.
- He first rode a bike at fifteen and liked engines. That supports pleasure in
  tinkering and machinery, without promoting V's fuel-injection/remapping advice
  into Jackie being an expert mechanic.
- The specific treasured book is **For Whom the Bell Tolls**, reread before big
  jobs, with affection for Hemingway's toughness. The remembered "dozen" is
  conversational testimony rather than an audited count.
- His hearty appetite, chili and Mama's sopa de fideos association come from his
  own dialogue. Tequila, the strategic reserve and his sentimental signature
  drink recipe add taste without forcing food/drink talk into every exchange.
- The old woman's story about the lucky bottle stays a qualified recollection;
  its alleged rarity and stolen-recipe origin are not promoted to verified
  world history.

## Delivery findings

The old sample set leaned toward polished reassurance, gentle advice and
therapist-like concern. The native character is more uneven and more alive:

- He boasts, exaggerates, needles V and performs confidence.
- He wants the money and recognition openly, and objects when the people taking
  bullets receive too small a share.
- He questions impossible access plans and dangerous omissions, yet can be
  dazzled by the opportunity he is evaluating.
- His warmth is direct and physical: company, appreciation, teasing, a meal,
  a celebration. Affection can briefly take the swagger out of his voice.
- He can be impatient or coarse. Occasional profanity belongs where it fits;
  constant profanity or Spanish seasoning would turn him into a caricature.
- He romanticizes being remembered, including spectacular death, while saying
  the legend must first be lived. That is a blind spot, not suicidal intent or
  knowledge of his future.

An independent delivery reviewer corroborated these traits and supplied
original cadence examples. Samples use V/choom safely; gendered Spanish address
needs established context. There is no phonetic accent spelling and no
`Jackie:`/name prefix.

## Boundaries that must survive integration

| Candidate | Required handling |
| --- | --- |
| ARCH purchase after Dorsett payout, financed partly with a small loan | Dynamic only. It needs positive Rescue/Pickup-era history; spawn does not establish the purchase or give V a bike. |
| Exhaust/injection advice and later modification | V's selected technical/lifepath dialogue and a downstream receipt are required. It is not default Jackie expertise or universal shared history. |
| The three first meetings with V | Mutually exclusive lifepaths plus matching positive established events. The eulogy's alternative lines do not prove any branch in the current save. |
| Death, remains, ofrenda, offering, Misty reconciliation and bike gift | Later save-dependent events. A living copy never remembers attending its funeral. They require a separate explicit presence/knowledge policy if discussed. |
| T-Bug and the crew | Working collaboration, not kinship, romance or childhood friendship. Their first realspace briefing is conditional shared history; no present survival or connection is inferred. |
| Private father/family and relationship details | Claim-level audience/disclosure filtering must remain effective when prompts are built. Merely adding a privacy paragraph to a universal bio is insufficient. |

The candidate authors **no new runtime outcome rule** and therefore does not
raise Jackie's mapped-quest count. Facts missing or zero do not establish a
negative branch, and an invitation does not prove a relationship disclosure.

## Development method and limits

1. Read the existing dossier/profile to identify shallow areas and unsupported
   delivery assumptions.
2. Find exact installed source paths through existing quest/resource receipts;
   export only bounded missing resources under the casting lock.
3. Join native actor, speech event, screenplay and shipped localization evidence
   rather than trusting a fan transcript or a suggestive filename.
4. Separate autobiographical authoring, private personal knowledge, reported
   uncertain stories and conditional shared history before writing prose.
5. Write original cadence examples from character patterns, not copied lines.
6. Run hash/pointer/current-winner checks and independent semantic review before
   proposing integration.

Some duplicated screenplay entries in the Heist briefing had **no native speech
event**. The audit rejects those and pins the referenced entries instead. The
presence of text in a screenplay array alone is not a sufficient join.

The audit does not claim every node is reachable through every normal release
entry or that any dialogue ran in the current save. It uses delivered native
speech definitions and the authored codex as character evidence. Ordinary
production reachability and positive current observations are separate gates
for any later executable outcome rule.

No GPU, synthesis, cloud request, memory seeding, game-state mutation, helper UI,
or Git commit was performed in this lane. `scripts/Test-GameInput.ps1` was not
accessed.
