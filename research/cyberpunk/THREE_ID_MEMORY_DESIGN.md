# Bounded player identities and save-aware memory

Updated 2026-09-30. This contract supersedes the earlier proposal to send a different Convai end-user ID for every branch or group. Production memory remains gated off pending native save and provider qualification. **Observed correction:** the deployed provider rejects anonymous connections when that character's global LTM setting is enabled (HTTP 400). The remaining candidate is explicit REST with global LTM disabled; its disposable qualification is recorded separately. Local tests are not proof of this compatibility.

## Product invariants

- Use **one persistent provider ID initially** for an actual player's registry. Share it across Judy, Johnny, Panam and every other character. Three is a hard maximum, not a target allocation count.
- Loading a save, forming another group, spawning another copy, changing voice backend, and restarting CET or the bridge never allocate another provider ID.
- Local campaign, branch, exact audience and conversation stream IDs remain distinct. Their count does not consume provider end-user IDs. They are never transmitted as `end_user_id` or `speakerID`.
- All normal live connections omit `end_user_id`, including spawn warmup, prepared connections, microphone, private, group and phone realtime paths. Before accepting a ready connection, verify the provider echo is null. An unexpected identity blocks that connection; it is not silently adopted.
- Global automatic memory remains disabled on gameplay characters. The archive helper never enables or toggles it. A true or missing setting blocks archive admission until its compatibility is resolved.
- The persistent provider ID is used only by explicit memory REST operations and the dedicated empty registration connection required to initialize that ID. No user dialogue, dynamic context, microphone or model-generation request goes through registration.
- Loading an older save selects only its proven local history. Abandoned future records may still exist in the remote archive, but are not retrieved into the conversation.
- No cloud record, model paraphrase, research page or generated reply becomes a witnessed game fact merely because it exists remotely.

## What Convai actually supports

The installed Web SDK 1.7.0 documents an omitted `endUserId` as anonymous, with neither memory nor cross-session tracking. The actual connect serializer includes `end_user_id` only when supplied. The official Connect contract specifies a null response identity when the request omitted it. Multi-character roster rooms require a nonblank ID; this mod uses separately orchestrated single-character connections. These general documents did not establish the additional LTM-enabled restriction found by the real probe. [SDK types](https://unpkg.com/@convai/web-sdk@1.7.0/dist/core/types.d.ts), [Connect API](https://github.com/Conv-AI/Convai-Documentation/blob/911cc4104b6eec6187d17e342a59b0bafd8b0303/api-reference/core-api-reference/live-apis-beta/connect-api.md)

The corrected disposable probe's request omitted identity and dynamic context, but HTTP 400 required an end-user ID because global character memory was enabled. Its profile was deleted and absence verified; no test end-user was created and no conversation was sent. Therefore the formerly proposed same-profile combination of anonymous live sessions and globally enabled memory is **rejected**, not qualified. Explicit REST access with the global flag false must be proven before this architecture can be enabled. [Probe evidence](ANONYMOUS_MEMORY_QUALIFICATION.md)

This is not a claim that a live connection is stateless. Its `character_session_id` retains conversational history when reused. Save rollback and audience changes must select fresh sessions or an exact permitted local session; replacing dynamic context alone does not erase prior turns. Character session IDs are not end-user IDs. Omit the identity property entirely: the string `"-1"` is an identity if placed in `endUserId`, even though this integration uses it as a fresh **character-session** sentinel.

No independent per-session automatic-memory read or write flag was found in the audited Connect fields, SDK `ConvaiConfig`, or explicit serializer. `run_llm:false`, `keep_in_context:false` and context reset are not memory opt-outs. Character `memory_settings.enabled` is a global setting affecting that character's integrations and is not suitable as a lock around one player's save load. Disabling it does not remove existing memories. [Global character control](https://github.com/Conv-AI/Convai-Documentation/blob/main/plugins-and-integrations/unity-plugin-beta-overview/features/long-term-memory/enabling-memory-on-characters.md)

Standalone `MemoryManager` supports explicit scoped add/list/get/delete independently of a live client. Records use the pair `(character_id, end_user_id)`, so sharing one user ID does not combine every character's records into one character history. `deleteAll` is asynchronous. The API has no documented branch selector, extraction-drain barrier, conditional generation, atomic replace or caller idempotency key. [Official memory guide](https://github.com/Conv-AI/Convai-Documentation/blob/911cc4104b6eec6187d17e342a59b0bafd8b0303/plugins-and-integrations/web-plugins/convai-web-sdk/long-term-memory.md)

Local source pointers: `node_modules/@convai/web-sdk/dist/core/types.d.ts:399–419`, `ConvaiClient.js:448–537` for request fields, `ConvaiClient.js:577` for the server identity echo, and `MemoryManager.js:120–242` for exact CRUD and asynchronous deletion behavior. These are source observations, not new undocumented provider options.

## Why clear-and-reseed cannot safely implement rollback

Consider an identified conversation from a later save. Its extraction may still be running when the user loads an earlier save. Clearing the old memory and then listing an empty result does not prove the extraction is finished. An old extraction can append a future fact after that list; an asynchronous deletion can also finish after newly seeded records arrive. A fixed delay or repeated empty list is not a server quiescence receipt.

A local lease prevents a late response from modifying the wrong local branch. It cannot cancel a provider's asynchronous extraction job. Rotating through three IDs merely postpones reuse and would eventually reproduce this race. Creating a fourth ID, cloning characters as namespaces or asking the model to ignore future facts violates the contract or fails to exclude the information.

If explicit archive access is admitted with global memory disabled, anonymous live sessions avoid that dependency. Normal dialogue never enables automatic retrieval or extraction for the persistent archive ID. Old explicit POSTs can complete late, but their receipts remain attached to their original local episode and branch. They do not grant prompt access. If the provider rejects REST in that mode, the supported fallback is local memory; no shadow characters, ID cycling or production flag changes are implied.

## Durable provider registry

The coordinator owns the bounded registry, not `QuestMemoryLedger`:

1. Opening or refreshing the service only reads an existing registry. It never allocates a provider ID implicitly.
2. Explicit initialization reserves one UUID in a durable allocation receipt before publishing the registry. Interrupted publication recovers the same reserved UUID.
3. The registry binds the exact local player UUID, validates at most three distinct provider UUIDs and selects one existing slot. The current implementation has no rotation or extra-slot creation API.
4. Save and group changes leave the registry untouched. It is shared across profiles and preserved when game-local history is reset.
5. Corrupt, contradictory or unowned registry data fails closed. A missing registry can be recovered from its exact durable allocation receipt; it is not replaced with a freshly generated identity.

The application can enforce the bound for its persistent player registry. It cannot recognize the same physical person after both the registry and its recovery identity have been deliberately deleted, or across unrelated installations without a shared identity source. Preserve/import the registry across reinstall or migration; do not advertise an unverifiable account-wide guarantee. There is no automatic reset-to-three fallback. Existing disposable API test identities are not production player identities and are never adopted for production.

Coordinator API and state: `initializeRestPool({allowNewAllocation:true})` explicitly permits the first one-ID reservation; its no-argument form only reuses or reconstructs an existing reservation. The constructor defaults `restMemoryEnabled:false`. `sessionIdentity(...).restEndUserId` and `providerPolicy:'explicit-rest-anonymous-live-v1'` expose the bounded REST destination when admitted. See [KNOWLEDGE_SERVICE.md](KNOWLEDGE_SERVICE.md) for the exact persisted layout and recovery gates.

## Local truth, cloud archive, and recall

The durable ledger owns complete local evidence: authoritative campaign and branch, immutable restored prefix, delivered conversation receipts, canonical knowledge owners, exact audience, supersession and provenance. Research biographies and walkthroughs inform reviewed mappings; they are never proof that a player's save made those choices.

An unsaved current event can appear in the current local dynamic context. Explicit cloud projection requires a proven restored checkpoint containing that event. A current native tuple from an unknown CET activation may prove a prefix exists locally, but cannot prove it was saved; its inherited checkpoint remains unverified and produces no cloud work.

Cloud storage is an optional archive of eligible episodes, not the authoritative story selector. Local `contextFor` supplies reviewed current-world knowledge even if networking fails. `archiveFor` exposes only acknowledged archive records whose original local episode is both checkpointed and visible in the current branch and audience. It compares the receipt's normalized text with the original episode, excluding provider paraphrases or merged narratives. A subsequent REST get must match the exact character, stable provider ID, memory ID and expected text before its content is usable. Prefer the original locally qualified text rather than substituting provider wording.

```js
const scoped = ledger.archiveFor({
  characterKey: 'judy-alvarez',
  characterId: mappedRemoteCharacterId,
  restEndUserId: registry.selectedId,
  channel: 'group',
  audience: ['judy-alvarez', 'panam-palmer'],
});
// episodes contain original text/evidence and exact {characterId,memoryId} receipts.
// An empty result is not permission to inject all records from /memory/list.
```

Copies of one canonical character share records. Each other character is queried under its own character ID. Private world and phone histories are locally selected for that same character but retain separate live session streams. A group query excludes any episode not explicitly authorized for all current listeners. The same stable provider ID can hold records from other groups because the provider never automatically injects that archive into live conversations.

Losing the local ledger loses the evidence needed to interpret an archive safely. Freeform cloud text is not sufficient to reconstruct save boundaries, witnesses or decisions. Keep records inert until their manifest is restored; do not guess from timestamps or a character's generated recollection.

## Dispatch and late completion contract

`pendingCloud` maps a local outbox entry to the current stable provider ID. Historical `entry.endUserId` remains a **local scope key**. The worker requires a separate UUID `restEndUserId` and the explicit anonymous-live policy; local scope hashes cannot pass as provider identities.

```js
const lease = await ledger.claim(entry.id, {characterId, restEndUserId});
const reply = await adapter.add({characterId, endUserId: restEndUserId,
  memories: [lease.text], signal});
await ledger.acknowledge(lease, {characterId, endUserId: restEndUserId,
  memories: reply.memories});
```

The original attempt persists its actual REST destination. A late accepted result settles only that attempt. An uncertain record whose saved destination differs from the current slot is withheld; remapping cannot reinterpret it. Ambiguous POSTs are never blindly retried. Reconciliation checks an exact positive record and scoped get; incomplete scans and even complete absence do not prove that the original POST cannot still finish.

The helper closes its dedicated registration host after every pump. Results use `archiveOnly:true`, `requiresIdleRefresh:false` and `conversationScopes:[]`. Successful seeding must not reconnect a normal host with an identified archive ID. Normal active utterances remain untouched.

The archive may contain duplicate semantic records from independently projected branches; correctness comes from the local manifest, not a claim that provider storage is a transactional database. Bounded compaction and cross-branch archive deduplication can be added without changing user identities. No automatic whole-bucket delete is used for save rollback.

## Qualification before production

Required independent gates are native save-prefix proof, durable bounded registry, anonymous wire omission and null-echo verification, explicit REST registration/read/write isolation **with global memory false**, and owned character/model/disabled-memory readback. Booleans cannot substitute for those observations.

The worker accepts the earlier explicit REST qualification only with additional `anonymousLiveQualification` evidence: `mode:'memory-disabled-explicit-rest-v1'`, `liveCharacterMemoryEnabled:false`, `explicitRestWithMemoryDisabled:true`, plus successful anonymous echo, reused users, CRUD and cleanup checks. The disposable tests reuse existing synthetic A/B IDs, create no new test end-user identity, send no dialogue, and remove only their owned test profile and records. See the [enabled-profile restriction](ANONYMOUS_MEMORY_QUALIFICATION.md) and [memory-disabled qualification](ANONYMOUS_MEMORY_DISABLED_QUALIFICATION.md) for observed results and limits.

Provider documentation supports the design; a null-echo probe does not measure every internal server process or prove generated-message cancellation semantics. The mod avoids depending on those semantics for persistent archive recall. Source/headless proofs remain distinct from installed-game save/load acceptance.
