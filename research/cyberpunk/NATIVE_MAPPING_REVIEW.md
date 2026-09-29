# Reviewed native relationship mappings

Reviewed on 2026-09-30 against the installed Cyberpunk 2077 **2.31** assets.
Executable data: `native-rules/core-arcs.json`. This file covers three historical
outcomes. Other teams own the remaining quest lanes; it is not an exhaustive
quest-state map.

## Qualification and boundaries

The three rules are **source-verified**, not live-verified. Their asset bytes,
exact pointers, native types, graph connections, dialogue branch meaning and
narrative outcome links have been checked. None of these outcomes was forced in
the running game. A current native snapshot still has to supply the qualifying
facts; an extracted symbol is not an observation of a user's save.

Only positive fact values are used. There is no zero-as-false fallback, invented
journal hash, percentage heuristic, implied consent, or inferred alternate
outcome. The native scene dialogue was inspected locally to understand branches;
the distributable pack contains original factual paraphrases and references,
not game dialogue transcripts.

Every rule is confined to one character's private or phone conversation. No rule
grants another companion knowledge merely because their model was spawned or
they joined a group. The matching actor and dialogue participation are recorded
in native evidence. Judy's friendship result is a participant memory; the
commitment and Johnny reconciliation records are explicitly private.

The statements describe history represented by the loaded save. They do not
claim that the human user personally selected a button, or that a past
relationship remains unchanged forever. Memory output is only a candidate until
the separate ledger verifies save identity and checkpoint continuity.

## Artifact provenance

All five files below are winning assets from
`archive/pc/content/basegame_4_gamedata.archive`.
The full archive SHA-256 is
`a2c6ea7b8bb0dceb671d04c702c41824c29e5e1ee518490a42850dac12524dab`.
Its recorded size is 3,510,738,944 bytes. Full archive fingerprints are kept in
`cache/game/archive-fingerprints.json`.

| Asset | Extracted binary SHA-256 | Archive entry SHA-1 |
| --- | --- | --- |
| `sq030/phases/sq030_hut.questphase` | `418976828c6f86bf6a67621a5af9e71a30ffe24283b1111084ad344ba72096dd` | `d5e2e36d4f54e789aa67371487d08186543d97e3` |
| `sq030/scenes/sq030_11_morning.scene` | `cafeac069c24f55df7199d97f656d721c0298fefcae45c44386a3bfd2231a1d3` | `f1b8ec8b1f162ded8c8e3843518a44d15a986098` |
| `sq031/phases/sq031_grave.questphase` | `48c7015905b43466259cc0df8dfb00e3c62effc81187573f3406d8b543e3f2b0` | `7f6690681d36cd82c51349cf2ba94a3cbefe4308` |
| `sq031/scenes/sq031_05_grave.scene` | `9425bde9137417b96a9a6f42f9b534f5197be0e2ec5203ecb7546af15ad5d5de` | `09f30f1fc1fade0fe3b89278f1d676fa72d86cae` |
| `cyberpunk2077_metajournal.questphase` | `cbdb6489fde970b753c9d63a62e292176647b3486b9055d83073511492d8fe7f` | `7f58de9e174ff4cddc589281e40b790a04934213` |

The first four abbreviated paths are under `base/quest/side_quests/`; the fifth
is under `base/quest/`. Full depot paths are in the pack's source records. Quest
JSON files live under `cache/game/raw/`. The two scene exports have a separate
manifest under `cache/game/scene-evidence/core-relationships/`; pack references
include that prefix and are relative to `cache/game/`.

These digests have different purposes: an archive SHA-256 identifies the
container; archive entry SHA-1 checks extraction; binary SHA-256 identifies the
particular resource; the compiler separately hashes serialized JSON. They are
not interchangeable.

## Judy: completed morning commitment

- Runtime rule: `core-arcs.judy.committed`.
- Narrative link: `judy-river.pyramid.relationship / committed`.
- Quest: `pyramid-song`; exclusive topic: `judy.relationship`.
- Condition: **all** of `sq030_11_romance == 1`,
  `sq030_judy_lover == 1`, and `sq030_romance == 1`.

The morning scene's choice node **115**, option **0**, has screenplay option
ID **258**. It leads to section **119**, then node **365**, whose embedded
`questSetVar_NodeType` sets `sq030_11_romance` exactly to 1. The scene's localized
choice and ensuing dialogue express a continuing relationship. They are distinct
from the adjacent casual interpretation. The preceding scene condition checks
the intimacy branch; the runtime does not infer commitment from eligibility or
intimacy alone.

The exact assignment is at:

```text
/Data/RootChunk/sceneGraph/Data/graph/41/Data/questNode/Data/type/Data
```

The native quest graph then establishes a completed route:

```text
morning scene 52, romance output
  -> 78: sq030_judy_lover := 1
  -> AND 63 (also requires the objective input from 60)
  -> 64: quest journal succeeded
  -> cleanup 271 -> 279 -> 272 -> 269
  -> reward 114
  -> 172: sq030_romance := 1
```

The two hut assignment pointers are
`/Data/RootChunk/graph/Data/nodes/25/Data/type/Data` and
`/Data/RootChunk/graph/Data/nodes/47/Data/type/Data`.
All connecting edges, scene references, the AND gate and journal node are
included as `nativeRefs`. This conjunction prevents the early scene choice or
the lover flag alone from pretending the complete visit has resolved.

Narrative sources are the inspected Pyramid Song guide and romance reference
already recorded in `quest-maps/judy-river.json`. They supply story context;
the executable mapping comes from the installed branch.

## Judy: completed friendship visit

- Runtime rule: `core-arcs.judy.friends`.
- Narrative link: `judy-river.pyramid.relationship / friends`.
- Condition: `sq030_friendship == 1`.

The positive terminal writer is reached through a separate scene exit:

```text
morning scene 52, friendship output
  -> AND 62 (also requires the objective input from 60)
  -> 76: quest journal succeeded
  -> cleanup 273 -> 278 -> 274 -> 268
  -> reward 113
  -> 171: sq030_friendship := 1
```

Its exact writer is
`/Data/RootChunk/graph/Data/nodes/46/Data/type/Data`.
The morning scene's friendship exit and Judy actor are cited alongside the full
quest route. The statement only records that this visit ended as friends.
It does not infer a current breakup, imply romance was refused, or treat a
missing lover flag as proof.

Both Judy rules use `judy.relationship`. If both positive terminal outcomes are
present in one snapshot, the resolver suppresses the entire topic and emits no
memory candidate. Audience selection cannot conceal that conflict.

### Judy outcome intentionally left unmapped

`sq030_broken == 1` is insufficient to select `fling-dismissed`. The writer at
hut node **173** can be reached both from the morning broken-friendship route
and from a separate abandonment path through hub **221**. Its presence does not
identify the specific preceding conversation. This pack neither allowlists the
flag nor emits either story from it. `left-while-asleep`, the dive completion,
Clouds reports and Relic revelation also remain outside this pack's scope.

## Johnny: oilfield second chance

- Runtime rule: `core-arcs.johnny.second-chance`.
- Narrative link: `silverhand.oilfield-reconciliation / second-chance`.
- Quest: `chippin-in`; topic: `johnny.v.oilfield-reconciliation`.
- Condition: `sq032_johnny_friend >= 1`.

The grave questphase's normal input routes into scene node **142** through
`sq031_05_grave_in`. That resolves to scene entry node **91**. The exact scene
contains a reachable path from that production entry to choice node **624**;
all 33 path edges are included in native references. This proves structural
reachability, not which branch the current save took.

The decisive local branch is:

```text
choice 624, option 0 (screenplay option 5634)
  -> section 626 (V line 14337, Johnny line 14593)
  -> quest node 1483: sq032_johnny_friend += 1
```

The localized choice and section express V granting a final chance and Johnny
committing to try. The alternative option goes to node **645**. The writer at
`/Data/RootChunk/sceneGraph/Data/graph/213/Data/questNode/Data/type/Data`
has `setExactValue: 0` and `value: 1`: it is an **increment**, not an exact set.
The metajournal independently tests this fact with `GreaterOrEqual 1`, which
supports the runtime threshold. The corresponding comparator is at:

```text
/Data/RootChunk/graph/Data/nodes/4/Data/phaseGraph/Data/nodes/6/Data/condition/Data/type/Data
```

Actor data identifies Johnny's `Character.Silverhand` record, and the screenplay
section includes his response. Neither Rogue nor a generic nearby character is
declared a witness. This rule makes no claim about a friendship percentage,
secret-ending access, the Porsche, Grayson's fate, or a later Rogue date.
The zero/missing value does not enable `other-conversation`.

## Validation performed

- Resolver suite: **20 tests passed**, including ambiguous zero, rollback,
  conflict suppression, wrong recipients, bounded output, exact world tokens
  and stable event IDs separated by channel and recipient set.
- `review_native_rules.mjs verify`: schema, every cited pointer, expected native
  types and values, and extracted binary hashes passed.
- Parent compiler's exported `verifyNativeEvidence` against this pack: **3
  enabled rules, 5 winning artifacts and 88 evidence pointers passed**. All
  three narrative links resolve to the current authored maps.
- Actual-pack fixtures exercised complete/incomplete Judy commitment, friendship,
  contradictory positive flags, ambiguous zeros, the excluded broken flag,
  wrong character, group privacy, positive Johnny increments, missing identity
  and unsupported game versions.

The full quest index was searched for these five facts to distinguish writes
from downstream reads. The two reviewed scene resources were inspected directly.
This is not a claim to have exported every scene in the game or proven arbitrary
other mods cannot alter facts. Current-state contradictions stay closed.

Reproducible read-only commands:

```powershell
node --test bridge/world-knowledge.test.mjs
node research/cyberpunk/scripts/review_native_rules.mjs verify research/cyberpunk/native-rules/core-arcs.json
node research/cyberpunk/scripts/review_native_rules.mjs facts '^(sq030_11_romance|sq030_judy_lover|sq030_romance|sq030_friendship|sq032_johnny_friend)$'
```

The compiler remains responsible for merging other lanes, rechecking winners,
reporting honest unmapped coverage, and producing the runtime pack. No install,
live acceptance claim, cloud write, game mutation or Git commit was made for
this review.
