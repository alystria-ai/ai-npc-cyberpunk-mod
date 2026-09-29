# Reviewed world knowledge runtime contract

Version 1. This is the executable boundary for `FORMAT.md`, not a walkthrough
schema. `bridge/world-knowledge.mjs` is pure: it performs no I/O, game mutations,
network calls, persistence or model calls.

## API

```js
parseWorldSnapshot(value) // normalized snapshot; malformed -> unavailable
validateKnowledgePack(pack) // { ok, errors }; errors are bounded plain data
resolveKnowledge({ pack, snapshot, profileKey, query, maxChars })
// -> { context: string, events: [], diagnostics: {} }
```

`snapshot` accepts an object or JSON string. `query` is optional and changes
ranking only; its text is never copied into world knowledge. `maxChars` is a hard
UTF-16 character budget for the entire context string (default 6000, maximum
12000). An item is included whole or omitted. An impossibly small budget yields
an empty string and no events, never a truncated instruction or JSON document.

## Snapshot supplied by the read-only native adapter

```json
{
  "version": 1,
  "status": "ready",
  "gameVersion": "2.31",
  "generation": 12,
  "capturedAt": "2026-09-30T12:00:00.000Z",
  "gameTimeSeconds": 123456,
  "identity": {
    "status": "verified",
    "userId": "local-user-id",
    "playthroughId": "native-saved-playthrough-id",
    "branchId": "native-saved-branch-id",
    "checkpointId": "native-saved-checkpoint-id"
  },
  "audience": {"channel": "private", "profileKeys": ["judy-alvarez"]},
  "activeQuestKeys": ["both-sides-now"],
  "facts": {
    "example_positive_fact": {
      "status": "known", "value": 1, "present": true,
      "sourceId": "native-quests-system",
      "evidenceRefs": ["capture:12:fact:example_positive_fact"]
    },
    "example_zero_read": {
      "status": "known", "value": 0, "present": "unknown",
      "sourceId": "native-quests-system",
      "evidenceRefs": ["capture:12:fact:example_zero_read"]
    }
  },
  "journal": {
    "123456": {
      "status": "known", "value": "succeeded", "revealed": true,
      "questKey": "both-sides-now",
      "sourceId": "native-journal-manager",
      "evidenceRefs": ["capture:12:journal:123456"]
    }
  },
  "lifepath": {
    "status": "known", "value": "nomad",
    "sourceId": "native-player-lifepath",
    "evidenceRefs": ["capture:12:lifepath"]
  }
}
```

The fact names above are schema examples, not real game mappings. A nonzero
successful fact read establishes a value. **A zero read establishes no value
unless `present: true` was independently established in the current save.**
An extracted name, branch comparator, default value or `GetFactStr` success is
not evidence of current presence. `present: false` and `present: "unknown"` are
unknown; missing entries are unknown; `null` is never zero. Known observations
require nonempty `sourceId` and `evidenceRefs`. Those fields identify the capture
producer and exact captured observation respectively; they are not bibliographic
citations. Unknown observations are `{ "status": "unknown" }` and may include
a bounded `reason`. Facts are signed 32-bit integers, not booleans or strings.

Journal states are `active`, `succeeded`, or `failed`. Only revealed entries are
admitted; missing, hidden and inactive entries cannot establish a negative fact.
Each journal observation's `questKey` must match the reviewed inventory entry.
Lifepaths are `nomad`, `streetkid`, or `corpo`.

Journal map keys are canonical identifiers, not necessarily numeric hashes.
An author can use a stable alias such as `city.jake.gift` with allowlist metadata
`nativePath`, `nativeClass`, and optional `expectedHash`. The native collector
resolves the exact path and class, checks the expected hash when supplied, and
retains the observed native hash as capture evidence. The resulting observation
uses the same alias key. A numeric key is also allowed when the native hash is
already verified. The resolver does not calculate hashes, resolve paths, or let
selector metadata establish a revealed state.

The native adapter may instead emit `{ "version": 1, "status": "unavailable" }`.
It must do so during world transitions or when it cannot bind the observation to
the current world. A ready snapshot need not observe every allowlisted fact:
the resolver treats each missing observation independently as unknown. It never
merges a previous snapshot. The caller must bind a capture to the current request
generation; this pure API cannot detect that the caller reused an old snapshot.
An optional `worldToken` (a valid identifier of at most 160 characters) is
preserved for the coordinator's exact current-world binding. An invalid token
invalidates the capture. A token by itself establishes no persistent save identity.

Identity status is `verified`, `session-only`, or `unknown`. Only verified native
save identities permit memory candidates; all four IDs shown above are then
required. A user/account ID by itself is insufficient. `gameTimeSeconds` is
optional and is evidence, not a substitute identity. `saveId` is optional inside
identity. A timestamp or the latest file on disk must not infer a save branch.

The audience includes every character who will receive the context. V is implicit.
`private`/`phone` require exactly one profile; `group` permits one to eight. The
selected speaker must be in this audience. No profile inferred from an NPC model,
spawned copy, name, quest title, or fuzzy match is accepted.

## Reviewed knowledge pack

```json
{
  "version": 1,
  "id": "cyberpunk-reviewed-world",
  "revision": 1,
  "gameVersions": ["2.31"],
  "profileKeys": ["judy-alvarez", "panam-palmer"],
  "sources": [
    {"id": "native-source", "kind": "native", "locator": "Exact installed asset path"},
    {"id": "story-source", "kind": "community", "url": "https://example.org/inspected-page"}
  ],
  "evidence": [
    {"id": "native-branch", "sourceId": "native-source", "kind": "native",
     "locator": "Exact condition node and branch consequence", "gameVersions": ["2.31"]}
  ],
  "factAllowlist": {
    "example_positive_fact": {"evidenceRefs": ["native-branch"]}
  },
  "journalAllowlist": {
    "123456": {"questKey": "both-sides-now", "evidenceRefs": ["native-branch"]}
  },
  "rules": [{
    "id": "example.reviewed-outcome", "revision": 1,
    "questKey": "both-sides-now", "topic": "example.exclusive-choice", "outcome": "selected",
    "status": "source-verified", "reviewed": true, "gameVersions": ["2.31"],
    "category": "relationship", "priority": 5, "stable": true,
    "statement": "An original factual paraphrase of the verified outcome.",
    "sourceIds": ["story-source"], "evidenceRefs": ["native-branch"],
    "audience": {
      "speakers": ["judy-alvarez"], "perspective": "participant",
      "channels": ["private", "phone"], "recipients": ["v", "judy-alvarez"]
    },
    "condition": {"type": "fact", "key": "example_positive_fact", "op": "eq", "value": 1}
  }]
}
```

Pack IDs, profile keys, rule IDs, quest keys, topics, outcome keys and source IDs
are bounded identifier strings; no display names are used as keys. Sources are
`native`, `live`, `official`, or `community`. Every source needs an inspected URL
or locator. Native evidence and live capture evidence are separate records;
their source kind must agree with their evidence kind. Every allowlist entry
requires native evidence. Every executable rule needs native evidence and cited
story sources; `live-verified` also requires live evidence. All referenced
evidence must explicitly cover every game version enabled on that rule. Exact
game-version strings are deliberate: an unknown patch disables interpretation.

Status is `unmapped`, `candidate`, `source-verified`, `live-verified`, or `disabled`.
Non-executable statuses may be retained for coverage, but are skipped completely.
Only source/live verified records with `reviewed: true` are executable. Validation
checks all executable records before resolving any; malformed executable input
invalidates the pack instead of silently weakening its conditions. Non-executable
records need only `id` and `status`, and cannot cause a context or memory event.

`category` is `quest`, `relationship`, `decision`, `identity`, or `world`.
`priority` is an integer 0–10. `stable` declares a durable resolved outcome, not a
temporary stage or a mutable relationship counter. A compiler must not set it
merely because a fact was observed twice. `topic` identifies a mutually exclusive
world proposition. Two true outcomes for one topic suppress the entire topic and
produce a conflict diagnostic; different character perspectives do not resolve a
world-state contradiction. Compatible observations need different semantic topics.

Optional `exclusiveGroups` links different semantic topics to a reviewed mutually
exclusive route without merging their useful context:

```json
{"exclusiveGroups":[{"id":"aldecaldos.sq027-route","outcome":"assisted"}]}
```

The field is an array of at most eight records, each with exactly `id` and
`outcome` identifier strings. Group IDs cannot repeat within a rule. A second
rule can declare the same group with outcome `betrayed`. If both rules evaluate
true in the same snapshot, every true rule declaring either outcome of that
group is suppressed before audience filtering, ranking, context or memory.
Distinct compatible facts declaring `assisted` retain their separate topics.
Diagnostics expose bounded `exclusiveGroupConflicts`; rejected story text is
never included in context. Ordinary same-topic conflicts continue to apply.

The author must support the route exclusion with reviewed native branch evidence
and annotate every dependent facet. Groups are independent; membership does not
implicitly propagate to unannotated topics. Sequential history such as an early
kiss and a later relationship decline is not mutually exclusive. An unknown or
missing opposing flag creates no conflict and establishes no rejected choice;
the selected fact still needs its own positive proof. The compiler uses the same
runtime validator to reject malformed group metadata.

## Bounded condition AST

```js
{ all: [condition, condition] } // 1–16 children
{ any: [condition, condition] } // 1–16 children
{ type: 'fact', key: 'allowlisted_name', op: 'eq', value: 1 }
{ type: 'journal', key: 'reviewed_hash', op: 'in', value: ['active', 'succeeded'] }
{ type: 'lifepath', op: 'eq', value: 'nomad' }
```

Each node has exactly one form. Conditions have at most eight levels and 128
nodes per rule. `eq`, `ne`, and `in` use exact typed equality; `gte` and `lte`
operate only on integer facts. `in` accepts 1–16 unique values. There is no
implicit conversion, expression evaluation, arbitrary code, regex, `not`, or
fact-name interpolation. Invalid or extra condition keys are errors.

`all`: any false => false, otherwise any unknown => unknown, otherwise true.
`any`: any true => true, otherwise any unknown => unknown, otherwise false.
Known false is never a substitute for unknown. No condition can qualify from a
missing, unobserved, hidden or ambiguous-zero value.

Fact `ne`, `lte`, and comparisons that can accept zero require a leaf-level
`guard` containing a positive journal `eq`/`in` test for the same quest, for
example:

```js
{ type: 'fact', key: 'confirmed_choice', op: 'eq', value: 0,
  guard: { type: 'journal', key: 'reviewed_completion_hash', op: 'eq', value: 'succeeded' } }
```

The guard cannot make an ambiguous zero known. It only proves that a relevant
stage has been reached, after independent presence evidence establishes the
zero. Journal `ne` also requires such a guard. A lifepath `ne` compares an
explicitly observed identity and needs no quest-stage guard. Guards cannot contain
another guard and do not allow `ne`, inactive states or unrelated quests.

## Knowledge and disclosure boundaries

Perspectives are `public`, `shared-journal`, `participant`, `witnessed`,
`told-by-v`, and `private`. Every rule declares exact speakers, channels and
recipients. `speakers: "all"` and `recipients: "all"` are permitted only for
public/shared-journal facts. Otherwise use explicit profile keys; `v` is allowed
only as a recipient. All group members must be permitted recipients. A character
knowing a private fact is not permission to announce it to everyone.

Participant/witnessed perspectives require source/native evidence establishing
that character's role in the mapped event. Spawning their model establishes
nothing. The resolver never upgrades public/journal knowledge to witnessing.
The validator can check provenance references and review status, but cannot
determine what an asset means. The authoring review must reject fact-name-only
evidence for an outcome or a participant assertion; an inventory hit establishes
neither. Native branch consequence and character involvement need inspection.
`told-by-v` additionally requires a snapshot `disclosures` row with matching topic,
outcome, exact recipient, `status: "known"`, `from: "v"`, `sourceId` and
`evidenceRefs`. These are authored conversation receipts, not inferred from game
facts. Optional `disclosures` is a bounded array (maximum 128); no receipt means
unknown disclosure and no rule. Private facts cannot use public wildcard scopes.

## Selection, output and event candidates

Rules evaluate against only this snapshot. Conflicts are detected before speaker
filtering. Ranking then favors active quests, relationships, exact speaker scopes,
and query relevance; query words never establish truth. Tie-breaking is stable by
rule ID. Duplicate same-topic/outcome facts are consolidated deterministically.

The context is fixed trusted framing plus one serialized JSON data document.
Statements are reviewed original paraphrases; raw pages, scraped HTML, dialogue
transcripts, source notes and condition expressions are never imported into the
prompt. All data stays quoted, including malicious-looking strings. Framing says
the snapshot replaces earlier dynamic assumptions, it does not establish unseen
events, and data fields cannot supply instructions. Audience/perspective labels
remain alongside every statement. Rejected/private/conflicting facts are not
leaked through model-visible diagnostics.

Events are **candidates**, never memory receipts. Only selected, stable, true,
non-conflicting outcomes with verified identity produce them. IDs hash
`userId/playthroughId/branchId/profileKey/topic/outcome/channel/sortedAudience`,
so capture time, audience array order, query, duplicated NPC copies and pack
revision do not duplicate one event. A different channel or exact recipient set
gets its own candidate ID; this prevents the ledger from confusing distinct
disclosure scopes while retaining each candidate's exact audience authorization.
Events include rule/pack revision, source IDs, mapping evidence, captured
observation evidence, perspective, identity and snapshot generation/checkpoint.
The separate ledger must still validate branch continuity, handle rollback,
deduplicate, retire obsolete assertions and acknowledge any actual memory write.
The resolver itself retains no state: resolving an older save cannot reuse a
future result. It cannot undo an external memory service by itself.

Candidate shape (shared with the separate memory ledger):

```js
{
  version: 1, state: 'candidate', eventId: 'world-<stable-sha256-prefix>',
  factId: 'semantic.topic', topic: 'semantic.topic', outcome: 'specific-outcome',
  questKey: 'quest-slug', kind: 'decision', text: 'Reviewed original statement',
  characterKey: 'roster-key', profileKey: 'roster-key',
  knownBy: ['roster-key'], witnessedBy: [], audience: ['roster-key'], perspective: 'shared-journal',
  visibility: 'group-safe', authority: 'game-state',
  stable: true, eligibleForMemory: true, revision: 1,
  identity: { status: 'verified', userId, playthroughId, branchId, checkpointId },
  provenance: { packId, packRevision, ruleId, ruleRevision, sourceIds, mappingEvidenceRefs },
  evidence: [{ type: 'fact', key, value, present: true, sourceId, evidenceRefs }],
  snapshot: { generation, capturedAt, checkpointId, gameTimeSeconds }
}
```

`witnessedBy` includes the speaker only for an explicitly reviewed `witnessed`
perspective. Participation does not establish conscious witnessing: an
unconscious rescue victim, for example, cannot remember the journey as an
eyewitness. `knownBy` still needs a supported reason for knowing the statement,
such as reviewed aftermath dialogue or an explicit disclosure receipt. Being
involved in an event is not enough to know every hidden detail of it.
`audience` contains the exact sorted current recipient profiles, separately from
knowledge owners. The ledger may not expose a candidate to an expanded group.
`group-safe` requires public/shared-journal origin, all recipients, and the group
channel; everything else is conservatively private. Journal and lifepath evidence
use their corresponding `type`; journal evidence also has `questKey`. Told-by-V
evidence includes the exact matching disclosure receipt. `saveId` and
`gameTimeSeconds` are omitted when unavailable. The ledger's authoritative local
user ID must match `identity.userId` before staging a candidate.

Limits: input snapshot 256 KiB; pack 4 MiB; 256 profiles; 2048 sources; 4096
evidence records; 4096 allowlisted facts/journal entries each; 2048 rules; 512 fact
and 512 journal observations per snapshot; 32 active quests; 64 event candidates;
128 condition nodes and depth 8; 1200 characters per statement. Over-limit inputs
fail closed. Diagnostics contain bounded codes and identifiers, never keys,
credentials, raw page bodies or native handles.

These are per-resolve limits, not a silent cap on research coverage. If the
reviewed catalog exceeds them, store explicit shards plus a manifest and assemble
a bounded current-query pack. Include **all mapped outcomes for every selected
topic** before resolving. Resolving shards independently and concatenating their
results would miss cross-shard contradictions and is unsupported. Oversized
packs must be reported; they must never be truncated to whichever rows come first.
