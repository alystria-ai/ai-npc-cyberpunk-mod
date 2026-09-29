# Quest memory runtime contract

Status: implemented isolated modules; production routing and native integration are owned by the bridge coordinator. This file documents code behavior, not proof of in-game operation or automatic cloud recall.

**Current provider policy:** one persistent REST archive user initially, maximum three per player registry, shared across all characters and reused across saves. Normal live sessions remain anonymous. Historical ledger fields named `endUserId` are local scope keys and must never be sent to Convai. Only the coordinator's separate `restEndUserId` may be used by the explicit REST worker. [Three-ID design and limitations](THREE_ID_MEMORY_DESIGN.md) supersedes the former remote namespace proposal.

**Live API restriction:** a memory-enabled disposable character rejected anonymous connect with HTTP 400. The current helper requires global `memory_settings.enabled:false`, has no character-update endpoint, and remains gated until explicit REST with that flag false is qualified. Earlier positive CRUD results with memory enabled do not establish that combination.

## Ownership

- `bridge/quest-memory.mjs`: durable local user UUID, branch lineage, staged episodes, verified checkpoint prefix, namespace selection and explicit-write outbox. It never contacts Convai or enables a character setting.
- `bridge/convai-memory.mjs`: bounded, opt-in wrapper around the official `MemoryManager` REST endpoints. Construction is inert; `enabled` defaults to false; no write retries.
- Native identity coordinator: proves the active campaign/branch, creates a fresh branch on **every native restore**, journals append intents, advances the native cursor only after durable append, and invalidates routes while uncertain.
- Conversation routing: omits `endUserId` on normal realtime connections, verifies the anonymous server echo, rejects abandoned responses and records actual input/delivery cursor activity. Fresh session streams exclude abandoned dialogue. Private phone and world streams remain separate; this is independent of the capped REST archive identity.
- `bridge/quest-memory-sync.mjs`: optional bounded cloud worker. Claims eligible entries durably, executes one add, records receipt or uncertainty, and reconciles uncertain writes through reads. Native qualification, provider qualification and character enablement are independent gates; constructing it enables none of them.

## Identity and branch cursor

```js
import {QuestMemoryLedger} from './quest-memory.mjs';
const ledger = await QuestMemoryLedger.load({path: absoluteLedgerPath});
// A stable local UUID is generated once, independently of key, entity or Steam ID.
const userId = ledger.userId;

await ledger.bindIdentity({
  authoritative: true,             // or status: 'verified'
  userId,                         // optional; if present must match ledger.userId
  campaignId,                     // playthroughId is an accepted alias
  branchId,
  checkpointId,
});
```

Loading the file does not bind the last world. Until an authoritative identity is bound, `contextFor` returns unavailable and `pending` is empty. Native branch IDs are opaque; branch-local `ledgerSequence` counts locally appended events only. An inherited ancestor prefix does not increase that cursor.

`ledger.identity` returns `{status,userId,campaignId,playthroughId,branchId,checkpointId,ledgerSequence,endUserId,remoteGeneration,epoch,key}`. The historical `endUserId` and `remoteGeneration` names describe local scope/recovery data only. `epoch` is process-local route invalidation state; the other scope inputs persist. `key` is an internal branch digest, not a provider user identity.

### Same native activation resume

```js
const known = ledger.inspectBranch(campaignId, branchId);
// known: null or {campaignId,playthroughId,branchId,ledgerSequence,
// inheritedCount,parent,checkpoints:[{checkpointId,ledgerSequence,verified}]}
await ledger.bindIdentity({authoritative:true, campaignId, branchId,
  checkpointId, resume:true, ledgerSequence:nativeCursor});
```

Resume requires the exact durable local branch cursor. It permits a current unsaved suffix without pretending that suffix was saved. A new checkpoint label supplied during resume does not create a verified checkpoint. The coordinator must establish that this is the same native activation; this API is not permission to resume an abandoned conversation session after save restore. The REST user itself is always reused.

### Restore and fork

Codeware `AfterSave` indicates serialization, not completed disk persistence. The original custom ScriptableSystem identity was quarantined after a game startup crash. Its legacy `native-on-restored` proof shape remains supported by pure ledger tests; it is not installed-game qualification. The coordinator's opt-in replacement uses exact quest-fact tuples and an actual `PlayerSystem.OnGameRestored` boundary. Both mechanisms must prove the exact restored prefix. Native restores fork local branches and fresh conversation streams; the REST archive user is unchanged.

```js
await ledger.bindIdentity({authoritative:true, campaignId,
  branchId:newBranchId, checkpointId:newBranchCheckpointId,
  parentBranchId:restoredBranchId,
  forkCheckpointId:restoredCheckpointId,
  forkLedgerSequence:restoredCursor,
  restoredProof:{kind:'native-on-restored', branchId:restoredBranchId,
    ledgerSequence:restoredCursor, checkpointId:restoredCheckpointId}
});
```

Only the proven ancestor prefix is inherited. The child cursor starts at zero, its local scope differs, and abandoned-future events stay on the ancestor. The new child's inherited prefix is eligible because its ancestor proof is verified; this is not a claim that the child itself has already been saved. The proof can establish an ancestor checkpoint for the first time, so the bridge need not have observed the earlier serialization event. The bounded REST ID is reused.

The facts backend's restored proof is `{version:1,kind:'native-facts-restored',source:'PlayerSystem.OnGameRestored',campaignId,branchId,branchEpoch,ledgerSequence,commitGeneration,checkpointId,loadGeneration,runtimeId,factSchema:1,bank,factHead}`. Runtime ID is a nonzero lowercase 32-hex string; branch/load generations are positive Int32; commit generation is 1..1073741823; bank is 0 or 1; `factHead === 2*commitGeneration+bank`; checkpoint ID is `${branchId}:${commitGeneration}:${ledgerSequence}`. The coordinator must validate the exact durable registry tuple and real callback, not just construct an object of this shape. A facts proof cannot be relabelled as a legacy proof.

An unknown-origin current tuple instead uses `currentPrefixProof:{kind:'native-facts-current-prefix',source:'quest-facts-v1',campaignId,branchId,branchEpoch,ledgerSequence,commitGeneration,factHead,runtimeId}` when creating a new child with exact `parentBranchId` and `forkLedgerSequence`. This copies only that local prefix; its inherited checkpoint is unverified and no outbox is produced, even when the parent has an older genuine checkpoint. It cannot resume/rebind an existing child or be mixed with a restored proof. A later actual restore can prove the child's exact prefix. Structural validation alone does not qualify the facts backend.

`checkpoint({kind:'native-on-restored',branchId,ledgerSequence,checkpointId})` can seal the exact active tail when appropriate to a coordinator flow. A proof behind the current tail returns `BRANCH_REQUIRED`; the caller forks instead. Arbitrary strings, timers and `after-save` objects are rejected. Checkpoint IDs are immutable cursor bindings.

### Crash between durable append and native advance

Before appending, the coordinator persists an exact append intent with `fromSequence`, lease and resolver event. After crash it may inspect the durable event while routes remain unbound:

```js
const receipt = ledger.receiptFor({campaignId,branchId,eventId:intent.eventId,
  event:intent.event});
// null or {eventId,episodeId,campaignId,branchId,ledgerSequence,inherited,
// isTail,fingerprint,payloadMatches}
const stored = ledger.readEvent({campaignId,branchId,eventId:intent.eventId});
// null or {event:<detached normalized stored event>,receipt:<same receipt fields>}
```

`payloadMatches` compares the exact normalized event including evidence. Ordinary episode dedupe intentionally ignores capture evidence, but recovery does not. Recovery requires a matching intent/lease, local tail exactly native cursor + 1, matching event ID and sequence, `isTail`, `!inherited`, and `payloadMatches`. Only then may the coordinator complete the exact native CAS. A mismatched or unknown suffix is never adopted. The ledger does not perform native CAS itself.

## Episode admission

```js
await ledger.observe({eventId, factId, kind:'decision', authority:'game-state',
  stable:true, eligibleForMemory:true, text, outcome,
  characterKey:'judy-alvarez', knownBy:['judy-alvarez'],
  witnessedBy:['judy-alvarez'], visibility:'private',
  evidence:[{sourceId:'native-facts',evidenceRefs:['capture:...']}],
  provenance:{packId,packRevision,ruleId,ruleRevision},
  identity:ledger.identity,
});
// => {episodeId,duplicate,checkpointed,ledgerSequence}, after disk persistence
```

Resolver evidence is a claim from a reviewed mapping plus a native snapshot. The ledger validates structure and ownership; it cannot establish that a mapping is factually correct. Stable positive resolved decisions only; pages, biographies and walkthrough outcomes are not experienced memories. `knownBy` is whose knowledge may contain the episode. `witnessedBy` identifies verified witnesses and must be a subset. An informed character need not have personally witnessed an event.

Supported pairs are `decision/game-state`, `shared-experience/delivered-conversation`, `player-statement/player-statement`, and internal `transport-activity/transport-event`. Delivered conversations require `delivery:{requestId,state:'played'}` and at least one canonical witness. Partial/cancelled output is not admitted as heard. Player statements remain statements, never become game facts by repetition.

Deduplication uses normalized semantics, known/witnessed audience, visibility, provenance, outcome and supersession. Capture time, evidence capture ID, physical entity copy and object-key order do not duplicate an episode. Reusing an event ID with a different meaning is an error. Separate Judy entities share the canonical profile's episode history.

`observe` stages unsaved events for local current-world context. It does **not** enqueue cloud memory until a proven checkpoint contains them. Local persistence must succeed before the native cursor advances.

Transport cursor records use:

```js
await ledger.recordActivity({activityId,requestId,characterKey,
  kind:'submitted-input', // also generated-reply, delivered-reply, cancelled-turn
  identity:ledger.identity, metadata:{}});
```

These advance the cursor but never appear in episodic context or cloud outbox. No model call should be started until its input intent is durably tracked and the native cursor lease is resolved.

### Completed conversation history

The coordinator's `recordActivity` optionally stages `userText` on `submitted-input` and `replyText` on `generated-reply`, under the original request, profile, channel, exact audience and guard. SHA256 digests are part of the immutable provenance. The original full strings are retained only within its bounded admission limit; longer text retains a hash and stays ineligible rather than silently truncating a memory. `readEvent` lets a restarted coordinator recover those exact stages without granting a route or delivering anything by itself.

For a fully played world reply or UI-accepted phone reply, the coordinator validates the actual delivery hash against the staged reply and its cancellation state. It writes **one** `shared-experience/delivered-conversation` event under the delivered activity ID, combining delivery accounting and the quoted exchange in one durable append/native CAS. There is no separately appended completion/episode pair that could be torn by a crash. Without complete bounded originals, it writes the ordinary ineligible transport receipt instead.

Quoted text is labelled conversation evidence, not verified game state. Only verified listeners enter `knownBy` and `witnessedBy`; the exact party audience controls group visibility. Partial, generated-only, cancelled, stale or mismatched text does not become a heard conversation. Delivery creates a current local episode; it still needs a native restored checkpoint before explicit cloud projection. On a future load, only delivered episodes inside that proven prefix enter the new branch namespace. This recovers earlier real conversations without inheriting automatic cloud memories of an abandoned future.

## Context and exact group privacy

```js
ledger.contextFor({characterKey:'judy-alvarez',channel:'private'});
ledger.contextFor({characterKey:'judy-alvarez',channel:'phone'});
await ledger.registerGroup(['judy-alvarez','panam-palmer']);
ledger.contextFor({characterKey:'judy-alvarez',channel:'group',
  audience:['judy-alvarez','panam-palmer'],limit:32,maxChars:12000});
```

The result contains `{status,identity,endUserId,characterKey,channel,revision,episodes}`. Each episode includes text, provenance, evidence, authority, witnessed flag and checkpointed flag. Whole episodes fit within the requested budget; transport activity and superseded episodes are omitted. Character-specific context never selects another character's private knowledge.

The local scope key is `cp2077-` plus a SHA256 digest of scope version, local user UUID, recovery generation, campaign, branch, and privacy scope. Despite its legacy `endUserId` field name, this value never goes to a provider. Private world and phone share this local privacy scope; their live session stream keys remain different. The coordinator's durable REST registry is separate and starts with one UUID shared by all scopes and characters.

Group scope includes the **exact sorted canonical audience**, at most eight distinct profiles. Judy + Panam differs from Judy + Johnny. Missing audience and a speaker not in the audience are rejected. An episode enters group context only if `visibility:'group-safe'` and every current member is in the episode's explicit `audience`. If omitted, audience defaults conservatively to `knownBy`. Public facts can permit more listeners without falsely marking them as witnesses or knowledge owners. Only registered exact groups receive local outbox projections, and only for character owners who are members. The provider archive ID is shared; the local filter prevents a universal group history from being injected. Group membership changes require fresh scoped sessions, even when the speaker stays the same.

## Explicit-write outbox

```js
const entry = ledger.pending({limit:32,includeUncertain:false})[0];
const restEndUserId = coordinator.sessionIdentity(profileKey).restEndUserId;
const lease = await ledger.claim(entry.id,{characterId:remoteProfileId,restEndUserId});
try {
  const result = await adapter.add({characterId:lease.characterId,
    endUserId:lease.restEndUserId, memories:[lease.text]});
  await ledger.acknowledge(lease,{characterId:lease.characterId,
    endUserId:lease.restEndUserId,memories:result.memories});
} catch (error) {
  await ledger.fail(lease,{ambiguous:error.writeUncertain !== false,
    code:error.code ?? 'operation-failed'});
}
```

Claim persists an attempt UUID and its actual `restEndUserId` before dispatch, separately from the local `endUserId` scope. A receipt must match attempt, character and REST destination. An old-branch receipt is retained against its old branch and returns `active:false`; it cannot acknowledge a new branch entry. An inherited episode can still reuse its earlier exact receipt through `archiveFor` when the restored prefix proves that episode. Process interruption converts in-flight entries into uncertain entries during load.

After an ambiguous add, `adapter.scan` and `ledger.reconcile(entry.id,{characterId,endUserId,memories,complete})` can recognize an exact normalized text match. An empty list, even a complete scan, cannot prove a timed-out write will not commit later, so it never permits automatic retry. Direct successful add receipts may contain provider paraphrases and multiple IDs; the ledger stores them without assuming one input equals one remote record.

Only a definitively rejected write can be made pending by the explicit `retryRejected(entry.id)` operation, capped at three total attempts. There is no automatic retry, automatic deletion or automatic character-memory toggle. Superseded not-yet-sent records retire; existing provider records require a future explicit correction policy, not invented rollback guarantees.

`pending({limit,includeUncertain,onlyUncertain,afterId})` additionally supports bounded queue rotation. `onlyUncertain:true` requires `includeUncertain:true`; `afterId` selects the next eligible record and wraps once. It does not change record state or grant retry permission. Defaults retain the original pending-first query contract.

## Guarded cloud worker

```js
import {QuestMemorySync} from './quest-memory-sync.mjs';
const sync = new QuestMemorySync({
  service,                          // the native KnowledgeService coordinator
  adapter,                          // explicit ConvaiMemoryAdapter; enabled separately
  providerQualificationPath,        // validated local qualification receipt, not a switch
  enabled: false,
  nativeQualified: false,
  resolveCharacter,
  registerScope,
  maxEntries: 4,                    // 1..16 per pump, both queues combined
  maxDurationMs: 15000,             // 10..60000, callback/network deadline
  maxScanPages: 4,                  // 1..20; 100 records per page in adapter
  maxReadbackAgeMs: 300000,          // 1000..86400000
});
const result = await sync.pump({signal});
sync.setPolicy({enabled, nativeQualified});
sync.cancel();
await sync.close();
```

There is no interval and no automatic launch. The parent controls when a compact pump runs. Concurrent calls return `status:'busy'` and create no extra queue. Pending writes and uncertain reads alternate, with a cursor for each queue; an unmapped profile or persistent 404 cannot permanently block later entries. Cursors are process-local scheduling state, not native save cursors. Existing in-flight records are never reclaimed by a concurrent pump.

Every provider operation requires all of the following: worker `enabled`, explicit `nativeQualified`, `service.cloudQualified`, enabled adapter, live native guard, qualified provider receipt including anonymous-mode/disabled-memory REST evidence, recent owned character readback with automatic memory false, exact local scope match, bounded REST UUID with policy `explicit-rest-anonymous-live-v1`, and verified SDK user registration. Revoking a policy invalidates further dispatch. These are explicit integration gates, not evidence produced merely by setting a boolean.

The qualification receipt is bounded to 128 KiB and validated against the completed disposable-profile check: separate profile fields, selected model readback, enabled memory readback, successful user registration, distinct A/B list/add/get results, denied cross-user lookup, empty cleanup lists and confirmed profile deletion. It additionally requires `anonymousLiveQualification` with version 1, completed/source run/model, reused users, zero new IDs, verified null anonymous echo, closed connection, registration echo, explicit REST success and profile removal. Its model binds the accepted character readback. The existing ignored receipt is `runtime/memory-qualification/receipt.json`. This is local evidence, not an authenticated provider certificate; the application controls who may create or replace it.

`resolveCharacter(profileKey,{signal})` must return:

```js
{
  profileKey, characterId,
  verified: true, owned: true,
  source: 'convai-character-get',
  memoryEnabled: false,            // global automatic memory must remain off
  model: qualification.model,
  verifiedAt: Date.now(),           // numeric milliseconds or ISO date
}
```

This is a readback certificate supplied by the parent from an actual current owned-profile lookup. Catalog presence or a locally desired setting is insufficient. The worker cannot accept a memory-enabled profile: the deployed backend rejects anonymous conversations for it. Character remapping cannot reinterpret an uncertain write that was dispatched against another character ID.

`registerScope({profileKey,characterId,channel,audience,endUserId,localScopeId,providerPolicy,guard,signal})` must register/warm only the **dedicated empty registration connection** for the bounded REST ID and return:

```js
{ready:true, registration:{verified:true,endUserId,characterId}}
```

The SDK user value comes from the server's connection echo copied into `client.state.endUserId`. The character value is the connected configuration's public `client.characterId`, not a separate server echo. Both must match the requested pair. Anonymous, missing or mismatched values fail before claim/add. Registration is reused only within the current pump; callbacks own connection disposal and must honor cancellation. Registration runs before both add and reconciliation; fresh-user 404 remains an error and is never treated as empty memory.

For a new projection, the worker durably claims the entry, refreshes the original native guard, then dispatches one POST. An accepted response is recorded against that original lease even if a load happened during the request; it cannot acknowledge an inherited child entry. Cancellation after dispatch or an ambiguous provider failure becomes `uncertain`. A definitive rejection becomes `failed`. Neither is automatically resubmitted.

For uncertainty, the worker scans only the known character/end-user pair with the page budget, compares normalized exact text and a valid remote ID, then independently gets that record in the same scope. Only positive matching evidence acknowledges it. Complete empty scans, incomplete scans, provider 404, paraphrases and mismatched IDs never grant retry permission. A late read settles only its original record.

The pump deadline bounds callbacks and network even if an injected implementation ignores its signal. Local atomic claim/settlement commits are allowed to finish; interrupting their disk write would break recovery. If a misbehaving callback ignores cancellation, it may still run in its own environment, but its late result is not used for a fresh branch. `close()` cancels/drains only this worker; it does not close the injected service, adapter or realtime host. Result/status diagnostics contain counts and sanitized reason codes, never memory text or credentials.

Normal live sessions remain anonymous; newly seeded archive memories are not automatically loaded there. The parent supplies only the locally selected dynamic context. It must not reconnect normal dialogue with the REST ID after successful seeding. The dedicated registration host is discarded and never reused to answer a user. This avoids dependence on asynchronous automatic extraction or deletion during rollback.

### Optional production composition

`bridge/knowledge-cloud.mjs` exports `KnowledgeCloud`. Its constructor is inert, including when the credential is absent. It composes the adapter and worker with owned-profile verification and a dedicated registration host:

```js
const cloud = new KnowledgeCloud({
  coordinator: knowledge,
  key, ids,                        // exact canonical profileKey -> remote character ID
  policy: {
    version: 1, enabled: false,
    nativeQualified: false, providerQualified: false,
    selectedModel: 'fast-gemma-4-31b-it',
  },
  qualificationPath,
  // Optional injection seams; defaults use the bounded Core REST wrapper,
  // ConvaiMemoryAdapter, and a newly constructed hidden RealtimeHost.
  hostFactory,                     // ({signal}) -> dedicated host with warm/close
  request,                         // (Core endpoint, body, {signal}) -> parsed response
  fetchImpl,                       // memory API and default Core transport
});
const result = await cloud.pump({signal});
cloud.setPolicy(fullPolicySnapshot);
cloud.cancel();
await cloud.close();
```

The helper independently requires `coordinator.cloudQualified` and a live exact guard. It never changes those flags, identifies a save, writes game state, changes a character setting or runs a background interval. The old `enableOwnedProfiles` option is ignored and the character-update path has been removed. The native identity implementation is still subject to installed-game qualification; API and unit-test results do not authorize setting `nativeQualified:true`.

For each pending profile, a fresh account `/character/list` must contain exactly that mapped ID and its `personalised_prompt_config.MODEL` must match the qualified model and any explicitly selected model. `/character/get` must return that same ID and an exact biography line `[CyberpunkConvai profile v2:<canonical-key>]`. Ambiguous mappings, ambient templates, missing markers and foreign IDs are rejected. No profile is discovered by name or silently adopted.

`memory_settings.enabled` must read back as exactly false. True returns `CHARACTER_AUTOMATIC_MEMORY_ENABLED`; missing or malformed settings also block. No automatic repair or toggle is attempted. Core requests are restricted to `/character/list` and `/character/get`, preserving biography, voice, speaking style, model and all memory settings. The historical official toggle wire remains documented in the API audit for diagnostic probes, but is not available through this archive helper.

Registration calls only `warm`, with exact `endUserId`, `sessionId:'-1'`, `ttsEnabled:false` and a dedicated registration scope. It sends no user message, prompt, microphone or generated reply. That dedicated host is closed after every pump, including cancellation and failure. Late host creation is closed when it arrives. Unfinished or failed disposal prevents another host from accumulating. The pump deadline bounds work; `cleanupTimeoutMs` (default 2500, maximum 10000) separately bounds waiting for disposal and reports unresolved cleanup without claiming the resource is gone.

Successful add or positive reconciliation returns `touchedScopes`, without memory text:

```js
{profileKey, characterId, endUserId, localScopeId, channel, audience, guard, obsolete,
 providerPolicy:'explicit-rest-anonymous-live-v1',
 conversationScopes: [], requiresIdleRefresh: false, archiveOnly: true}
```

The result is archive accounting, not an instruction to invalidate any normal connection. `obsolete:true` means the accepted write belongs to an abandoned local scope. The helper **does not interrupt, replace or close any normal utterance**, and it never passes the REST user to a normal dialogue host. Local sessions still change on authoritative save/audience boundaries independently of archive writes.

### Selecting archive receipts safely

`ledger.archiveFor({characterKey,characterId?,restEndUserId,channel,audience?,limit,maxChars})` applies the same current local branch, canonical owner and audience selection as `contextFor`, then requires checkpointed episodes and exact acknowledged archive receipts. Results contain the original episode text/evidence plus `{characterId,memoryId}` receipt references. Provider paraphrases are retained for accounting but excluded from trusted recall. An inherited episode may reuse an ancestor's receipt; a later abandoned episode cannot. A remote get must match its exact pair, ID and expected text; do not inject whole bucket listings. If the local manifest is missing, the archive cannot prove save lineage or witnesses by itself.

## REST adapter interface

```js
const adapter = new ConvaiMemoryAdapter({key,enabled:false,
  timeoutMs:15000,maxResponseBytes:1024*1024,fetchImpl:fetch});
adapter.add({characterId,endUserId,memories,signal});
adapter.list({characterId,endUserId,page:1,pageSize:50,signal});
adapter.get({characterId,endUserId,memoryId,signal});
adapter.delete({characterId,endUserId,memoryId,signal});
adapter.deleteAll({characterId,endUserId,signal});
adapter.scan({characterId,endUserId,maxPages:20,signal});
```

The exact base is `https://api.convai.com`; all five endpoints are JSON POST with `CONVAI-API-KEY`. Request body fields are official snake_case identity keys. Time and response bytes are bounded, including transports that ignore cancellation. Credentials and provider error bodies are omitted from errors/JSON diagnostics. `deleteAll` acknowledges scheduling only (`verifiedEmpty:false`). `scan.complete:false` signals a pagination budget limit.

Provider prerequisite observed during disposable qualification: a fresh unregistered `end_user_id` returns HTTP 404 with “End user not found”; a successful official `/connect` with that identity registers it, after which listing returns an empty result. Initialize the exact scoped user through a supported connection before attempting seed projection. A 404 on a never-connected identity is not evidence of an empty memory list or an unavailable memory API. Account-specific registration or admission errors remain explicit failures. No undocumented beta flag is added; installed Web SDK 1.7.0 sends none for these endpoints.

## Persistence and operational limits

Each file is a checksummed JSON envelope, written to a unique temporary file, fsynced and atomically renamed. The prior valid envelope is retained as `.bak`. A single-owner process lock prevents concurrent writers; a dead owner can be recovered, unknown ownership fails closed. The checksum detects accidental damage, not hostile local modification.

Stale-lock recovery itself uses an exclusive `.reclaim` guard to prevent competing reclaimers from deleting a new owner's lock. An interrupted reclaimer leaves an explicit `LOCK_RECOVERY_BUSY` condition for owner inspection; it is never removed based on age alone.

Recovering a valid older backup preserves the local user UUID but rotates the historical `remoteGeneration` local scope component and retires old outbox entries. It never allocates another provider ID; the independent bounded registry is preserved. Complete corruption fails closed. No prior active identity silently resumes. Explicit limits (32 MiB ledger, 50,000 episodes, 256 branches, 100,000 outbox entries, 64 registered groups per branch) fail rather than silently evicting history. Compaction/export migration is future work.

`status()` provides local counts and `remoteExecution:'not-owned-by-ledger'`; it cannot establish cloud enablement or recall. `close()` drains local writes and releases its lock. Production should keep this ledger in ignored runtime storage, not a checked-in research corpus.

## Qualification boundary

Focused Node tests establish deterministic local behavior, exact adapter requests and guarded worker races, including stable REST destinations across different local scopes, old-prefix filtering, provider paraphrase rejection and policy revocation. No live provider calls are made by those tests. Disposable-profile qualifications separately check explicit REST ownership and anonymous connection behavior. Neither proves native save restoration, listener delivery, or installed-game conversational recall. Those require coordinated game evidence before claiming completion.
