# Knowledge service integration

September 30, 2026. This document covers the coordinator in
`bridge/knowledge-service.mjs` and `mod/knowledge-state.lua`. The native identity
contract is in `SAVE_IDENTITY.md`; durable ledger and cloud receipt ownership are
in `MEMORY_RUNTIME.md`; reviewed fact interpretation is in `RUNTIME_CONTRACT.md`.
These modules do not install scripts, open provider connections, enable character
memory settings, or call a cloud API.

The custom native-class implementation failed installed startup qualification and
is quarantined; compile success did not qualify it. Its adapter remains a source
fallback, not an instruction to reinstall it. The quest-fact alternative below is
opt-in and has no installed save/load qualification yet. Default operation keeps
native identity unavailable and supplies current dynamic context where possible.

## Ownership and invariants

- The native save owns campaign, branch, epoch and acknowledged ledger cursor.
- The durable ledger owns the local user ID, immutable episodes, exact audiences,
  branch ancestry and provider receipt queue.
- The coordinator owns the activation handshake and the write-ahead record for a
  single outstanding native command/event. The ledger's exclusive process lock
  prevents two bridge instances from writing one journal concurrently.
- A new native session gets a new **local** branch. A qualified real restoration
  can seal only its proven prefix. Quest-fact bootstrap with an exactly registered
  tuple may carry its local prefix into a fresh unverified branch, without sealing
  or exporting it. A matching campaign, game clock or quest title is not proof.
- A bridge restart in the same native activation resumes the exact cursor. A CET
  runtime replacement using facts conservatively forks a new local branch because
  it cannot prove that no unobserved save load occurred.
- Provider identities are separate: at most three IDs per local user, one initially,
  shared by all characters/scopes and reused across every load. They are for
  explicit REST memory only. Live SDK connections remain anonymous.
- A native cursor advances only after the episode is durably committed. A
  prepared append can recover after a crash only when the exact write-ahead
  event, its evidence, tail position, sequence and native activation agree.
- A completed, text-qualified conversation is stored as quoted statements with
  `delivered-conversation` authority. It is never inferred to be a quest fact or
  a verified biography. Generated, partial and cancelled replies are excluded.
- `AfterSave` is serialization evidence only. It never seals an episode for
  cloud memory. Explicit cloud qualification defaults off, independently of
  local facts and ledger operation.
- `resident-male` and `resident-female` are shared templates. They and groups
  containing them get dynamic context only, with reason
  `ambient-identity-unavailable`. Parent transport code owns their short-lived
  entity-specific anonymous sessions. Named copies share their canonical profile.

## Files and direction

All paths are under the supplied `runtimeDir`.

| File | Writer | Purpose |
| --- | --- | --- |
| `knowledge-command.json` | Bridge | One explicit command with ID, expiry, lease and exact native CAS guard. |
| `knowledge-state.json` | Lua | Fresh native inspection, authoritative capture if available, command acknowledgement and heartbeat. |
| `knowledge-activation.json` | Bridge | Durable preparation/activation record and exact pending append. Never treat it alone as native authority. |
| `knowledge-binding.json` | Bridge | Fresh user-enriched binding for Lua/phone capture, or explicit unavailable state. |
| `knowledge-fact-index.json` | Bridge | Monotonic high-water generation for the optional fact commit protocol. Never rewind with a game save. |
| `knowledge-fact-commits/<generation>.json` | Bridge | Immutable exact prepared tuple and prior inactive bank before any fact write. |
| `knowledge-provider-users-allocation.json` | Bridge | Durable first-allocation receipt for the bounded REST ID pool. |
| `knowledge-provider-users.json` | Bridge | Exact published pool, tied to the ledger user; one initial UUID, maximum three. |

The bridge's default writer fsyncs a complete temporary file before replacing the
destination. Lua closes its temporary file before rename; on Windows a failed
replace can use a missing-file interval. Readers treat missing/partial/oversized
data as unavailable. They never reuse a last-good identity as fresh state.

Default heartbeat tolerance is 5 seconds. Lua emits at least every 500 ms when
the injected clock permits; its default `os.time()*1000` clock has one-second
resolution. Mutations/ack changes publish immediately. Native command expiry is
3 seconds by default, bounded to 10 seconds in the service and 30 seconds in the
Lua envelope validator. Heartbeat timestamps are local IPC liveness evidence,
never a save ID or proof of a completed disk save.

## Lua integration

Construction is inert. No timer, callback, file or native handle is installed at
module load. The existing owner calls `update()` from its update loop and
`invalidate(reason)` on world teardown/CET shutdown.

```lua
local KnowledgeState = dofile('knowledge-state.lua')
local state
state = KnowledgeState.new({
    runtimeDir = 'runtime',
    currentGeneration = function()
        return state.inspect().generation -- native load generation, not request counter
    end
})
state.update()

local nativeInspection = state.inspect() -- read-only; no ledger/user authority
local phoneBinding = state.capture()     -- exact native + fresh bridge user binding
local envelope = state.snapshot()        -- read-consistent generation/token/binding
state.invalidate('world-unavailable')
```

`capture()` returns native `status='available'` and confidence only after a fresh
`knowledge-binding.json` agrees on generation, activation, campaign, branch,
branch epoch and ledger sequence. It adds `localUserId`, `userId`, `playthroughId`,
`checkpointId` and `worldToken`. Failures return unavailable with no reusable IDs.
The fact backend additionally compares `storage`, `runtimeId` and `factHead`.
`inspect()` can be used before a claim to expose the load generation. It does not
claim, seed, resolve or promote anything.

`snapshot()` returns `{status='ready', generation, worldToken, inspection,
identity}` after bracketing binding I/O with native inspection. A changed revision,
cursor, activation or generation rejects that envelope. An unavailable user
binding does not remove the current world generation/token, allowing dynamic
fact capture. Before activation its token is `generation:unclaimed`. During a
verified same-world save it returns `{status='paused',reason='save-in-progress',
generation,worldToken,inspection,identity=unavailable}`. The owner preserves the
original world/session token while skipping collection/new sends for that pause;
it must not claim the identity is available. Faulted or unready native state
returns an unavailable envelope. Use the same
envelope's generation/token for a collection decision; refresh it before sending.

Tests can inject `identityFactory`, `getSystem`, `read`, `write`, `encode`,
`decode`, `now` and `currentGeneration`. `read(path,maxBytes)` returns raw JSON or
nil; `write(path,raw)` returns true only after publication. No native reference is
retained between calls. Repeated command IDs are deduplicated within the bounded
128-entry acknowledgement cache; after a CET reload the native CAS still prevents
an old command from applying twice.

## Bridge API

```js
const service = await KnowledgeService.open({
  runtimeDir,
  ledgerPath,
  pack: reviewedPack,       // exact validated runtime pack, supplied by the caller
  cloudQualified: false,   // enable only after separate native/API qualification
  factIdentityEnabled: false,
  restMemoryEnabled: false,
});

await service.refresh();   // native claim/seed/fork/resume + actual CAS readback
const identity = service.saveIdentity;
const session = service.sessionIdentity(profileKey, 'private', [profileKey]);
const config = service.configFor(profileKey, 'private', [profileKey]); // always null for live conversations

const projection = await service.project({
  snapshot: input.worldKnowledge,
  generation: input.worldKnowledge.generation,
  profileKey,
  channel: 'private',       // private, phone or group
  audience: [profileKey],   // the exact full audience; V is implicit
  query: input.text,
  maxChars: 6000,
});

if (projection.guard && await service.current(projection.guard)) {
  // Parent may use projection.knowledgeContext and documented remoteConfig.
  // Recheck before releasing any awaited result to the game.
}

service.pendingCloud();   // qualified, sealed ledger rows + current guards only
await service.cancel('world-load');
await service.close();
```

`refresh()` serializes coordination work and returns verified identity or a plain
unavailable result. It may await native acknowledgement for the bounded command
timeout. The game update loop must remain independent of this async bridge work.

`saveIdentity` is user-enriched and immediately unavailable when its heartbeat
expires, a command/append is unresolved, the ledger cursor disagrees, or the
service closes. `sessionIdentity()` exposes `localScopeId` for exact local
audience/branch isolation and `restEndUserId` only when the optional bounded pool
is ready. Legacy ledger fields named `endUserId` are local scope identifiers and
must never be passed to Convai. `configFor()` always returns null: live SDK
connections omit `end_user_id` and require a null server echo under the separately
qualified transport policy. The parent owns profile character IDs, voice
configuration and provider settings; no SDK memory-enable field is invented.

`project()` returns:

- `knowledgeContext`: bounded trusted interpretation of this capture only;
- `eventsRecorded`: durable ledger receipts, with no fabricated cloud receipt;
- `saveIdentity`, `guard`, `remoteConfig`, `memoryReason` and optional `recordError`;
- resolver diagnostics and `cloudEligible`, which requires explicit qualification.

The snapshot's identity is never trusted. The service replaces it only when the
capture has the current generation and exact token
`generation:activationId:branchId` for the old adapter, or
`generation:runtimeId:activationId:branchId` for facts. The same getter/token must feed the native
collector and coordinator. Missing tokens permit dynamic facts but no durable
observation or identified route. A different token rejects the capture even if
the numeric generation happens to match.

`project`'s `generation` is the **world/load generation**, not the conversation
request counter. Captures are never merged or reused. During unavailable identity,
current valid facts can still form context. If a load, cancellation, or native
unavailability occurs during an awaited append, the previous context/config is
withheld. A pure disk failure can leave current facts usable after rechecking
that the original world still exists, while memory routes remain unavailable.

`isCurrent(guard)` is a synchronous check against the latest inspected state and
heartbeat; `await current(guard)` refreshes native IPC before checking. Parents
must keep the original request guard across awaits. Obtaining a new guard after
a request became stale does not make its old content current.

`current()` waits up to one second when fresh native state is saving and the
original activation/campaign/branch/cursor remain unchanged. The native save
callbacks advance revision, so commands re-read their CAS guard after the pause.
No cursor command is intentionally published while `saving=true`. If a save
starts in the final publication interval, one rejected CAS can retry after its
exact pre-state survives; it never retries against a different world or cursor.
A longer verified save returns unavailable and withholds routes, while retaining
the existing lease if no append/command is pending. When that exact save ends,
the original guard can become current again without claiming/forking. A load,
fault, stale heartbeat, cancellation or unresolved transaction fails closed.
The `AfterSave` wait is a liveness accommodation, not restored-prefix evidence.

`io` can inject async `read(path)`, `write(path,raw)` and `wait(ms)` methods; `now`
is injectable. Tests use this seam for native IPC and a real temporary ledger.
The service performs no provider calls. `pendingCloud()` returns nothing while
qualification, explicit REST policy or pool readiness is false. Cloud execution/receipt reconciliation belongs to the
parent and ledger's explicit claim/acknowledge/fail interfaces; no receipt is
inferred from a network timeout or absence in a partial provider listing.

### Conversation activity transaction

Transport hooks must use the coordinator, never the ledger directly:

```js
const submitted = await service.recordActivity({
  requestId, profileKey, channel: 'private', audience: [profileKey],
  kind: 'submitted-input', guard: originalRequestGuard,
  userText: originalPlayerText, // optional; never pass automatic/system prompts here
});
if (submitted.status !== 'recorded' || !submitted.sendAllowed
    || !await service.current(submitted.guard)) return;
// Parent may now send this locally tracked request using an anonymous live SDK session.

// Stage the COMPLETE final reply once, not individual streaming fragments:
const generated = await service.recordActivity({
  requestId, profileKey, channel: 'private', audience: [profileKey],
  kind: 'generated-reply', guard: submitted.guard, replyText: finalReplyText,
});

// Only after the native runtime confirms the WHOLE reply completed:
const delivered = await service.recordActivity({
  requestId, profileKey, channel: 'private', audience: [profileKey],
  kind: 'delivered-reply', guard: submitted.guard,
  delivery: {source: 'native-playback', state: 'completed', requestId,
    partial: false, cancelled: false, replyHash: generated.replyHash},
});
```

Allowed kinds are `submitted-input`, `generated-reply`, `delivered-reply`, and
`cancelled-turn`. `submitted-input` is durable pre-send intent; it does not claim
the provider received input. A later stage requires the submitted receipt for
that exact request, canonical profile, channel and audience. A recorded
cancellation rejects later generated/delivered stages. Successful delivery
rejects a later contradictory cancellation. Ambient templates remain excluded.

World delivery requires `{source:'native-playback',state:'completed',requestId}`;
phone delivery requires `{source:'phone-ui',state:'accepted',requestId}`. The parent
must construct these only from its actual runtime callback or UI acceptance,
not from generation, file publication, queue insertion or a timer. Partial or
cancelled flags reject the receipt. If chunk counts are supplied, both must be
present and equal. Mismatched request IDs or route types also reject it.

Submitted, generated, cancelled and textless delivery records are always
`transport-activity`, `eligibleForMemory:false`, excluded from character context
and the explicit memory outbox even after save restoration. Metadata allows only
`source`, `code`, `durationMs`, `chunkCount`, `completedChunks`, `totalChunks`, and
`providerTurnId`; arbitrary transcript fields in metadata are rejected.

The explicit optional `userText` and `replyText` fields are different: they stage
the actual original player input and complete generated output for this exact
request/profile/channel/audience. Each stage returns its SHA-256 `userHash` or
`replyHash`; repeat calls cannot change that staged text. Up to 1,200 characters
per side are retained exactly. Longer valid strings (up to 16,000 characters)
retain a hash only and make the conversation ineligible for memory. No truncated
or reconstructed sentence is silently promoted. Invalid control characters and
larger values are rejected before any write. Omit `userText` for automatic
reactions, synthetic group instructions and prompts that the player never said.

When a reply was staged, `delivery.replyHash` must be the hash returned for that
exact request; a wrong or absent hash rejects the delivery. Parent transport maps
the trusted native/phone receipt to its frozen request record, never to a global
latest reply. A receipt without staged input/output still provides transport
accounting, but cannot invent a conversation. Optional `delivery.witnessedBy`
contains only verified witnesses from the original route and must include the
speaker. When omitted, only the speaker is treated as a witness. Being listed in
a planned group does not by itself prove that every member heard the reply.

Only a fully delivered, complete bounded exchange replaces its normal delivery
activity with one `shared-experience`, `authority:'delivered-conversation'` event.
That same event is the delivery receipt; there is no second append or crash gap.
Its text explicitly quotes `V said ...; character replied ...` and labels those
statements as conversation, not verified game facts. Provenance and evidence record canonical
speaker, exact audience, stage IDs and text hashes. The final formatted record is
also bounded to the ledger's 3,000-character limit. The event enters local
character context immediately under the current guard, and becomes eligible for
the explicit memory outbox only when an actual native restored prefix includes
it. Loading an older save excludes all later dialogue, even if it was heard in
the abandoned timeline. A branch change changes only its local scope; its REST
provider ID remains the same.

This coordinator does not import existing transcript files or blindly copy a
provider's automatically accumulated LTM. The parent router owns bounded local
historical context projection under the original verified guard; provider-managed
conversation memory still has separate settings and qualification.

Success returns `{status:'recorded',receipt,guard,cursor,ledgerSequence,
saveIdentity,remoteConfig,sendAllowed,userHash,replyHash,
conversationMemoryRecorded,memoryReason}` after durable write and native CAS.
The coordinator publishes the newly acknowledged user binding before returning,
so Lua does not have to wait for another bridge refresh to see its current cursor.
`sendAllowed` is true only for a **new** submitted-input receipt. Repeating the
same receipt is idempotent and must not trigger another send. A crash
that leaves the first send outcome uncertain does not grant a resend. A refused
or stale activity returns unavailable, null route/guard/cursor and
`sendAllowed:false`; it cannot partially authorize a send.

Guards deliberately omit native revision and ledger cursor: legitimate appends
within one activation must not invalidate their own pending request. Guards do
include world generation, activation, branch, local user, local ledger generation
and coordinator invalidation epoch. Facts additionally include storage/runtimeId;
factHead and commit generation remain transaction checks, not request identities.
Use the returned guard/cursor for
bookkeeping, preserve that request guard across awaits, and call `current()`
before subsequent external work or output delivery. Never replace a stale guard
with a newly fetched guard from a different request/world.

Before a qualified explicit REST worker writes to the bounded user ID, its
dedicated no-dialogue host must verify registration of that exact ID. Provider
qualification observed `404 End user not found` for unregistered users. This
registration host is separate from ordinary live SDK sessions.

## Bounded REST identity pool

This policy is `explicit-rest-anonymous-live-v1`. `restMemoryEnabled` defaults
false and is independent of `cloudQualified`. Normal open, refresh, restore,
character spawn, group changes and CET/bridge restarts never allocate an ID.
**Current provider limitation:** the September 30 qualification probe found that
a character with Long Term Memory enabled rejects an anonymous connect with
HTTP 400 (`end_user_id` is required). Therefore the proposed same-profile REST
archive plus anonymous live conversation route is not qualified. Whether explicit
REST memory works while that character's automatic LTM is disabled needs separate
verification. This coordinator does not enable either mode or work around the
failed provider gate.
First setup is an explicit operation on an already initialized service:

```js
// Only a deliberate first-user setup may allow a new local allocation.
// Ordinary startup does not call this and never sets allowNewAllocation.
const pool = await service.initializeRestPool({allowNewAllocation: true});
// {policy, enabled, ready, limit:3, allocated:1, reason:'ready'}
```

The allocation receipt is written durably before the published pool. Both contain
the exact ledger user, UUID list and selected slot. No cloud call occurs here.
A missing published file recovers the exact UUID from its receipt. Corrupt,
mismatched, foreign-user or over-cap records fail closed; they are not replaced.
There is no eviction, LRU rotation or automatic replacement API. The one UUID is
shared across named characters, multiple copies, private/phone conversations and
all group rosters. Three is an absolute stored ceiling, not a rolling window.

If both files disappear while this service knows a pool existed, initialization
refuses with `REST_POOL_LOST_RESTORE_REQUIRED`. After complete loss of every local
registry/backup across reinstall, software cannot reconstruct prior provider IDs
or prove this actual person never allocated them. Normal startup stays anonymous;
restore the original registry/receipt. A deliberate new-allocation override must
never be used as recovery for an existing player. Preserve these two files and
the local ledger together when migrating/reinstalling.

`pendingCloud()` requires the qualified policy and valid pool, then adds
`restEndUserId`, `providerPolicy` and the current guard to ledger entries. Their
existing `endUserId` remains an internal local scope for lease bookkeeping.
An uncertain attempt already addressed to another REST ID is omitted rather than
remapped. The worker must use **only `restEndUserId`** for REST/registration and
verify both scope and destination again before calls and receipts.

Remote memories are an explicit archive, not automatically recalled conversation
state. Restores create fresh ordinary SDK sessions but reuse the REST UUID. Only
records matched to acknowledged local receipts, the current qualified restored
prefix, character and exact audience can be injected as dynamic context.
Unverified remote summaries, abandoned future history and late old-branch writes
remain excluded. No broad clear/reseed transaction is needed or implemented.

## Optional quest-fact commit protocol

See `../../docs/SAVE_IDENTITY_ALTERNATIVES.md` for the actual Lua driver and primary
source evidence. Parent injects `FactIdentity.identityFactory` into the unchanged
Lua coordinator boundary. `factIdentityEnabled:true` is an explicit bridge gate;
driver `writeQualified` and `restoreQualified` are separate default-off gates.
No new native class is installed. Native single-fact setters are **not atomic
multi-field CAS**; this is a single-writer guarded commit protocol.

The fixed 43 names store two banks and a final head `2*commitGeneration+bank`.
Before seed/fork/advance, the bridge consumes a never-reused commit generation,
durably records the complete prepared tuple plus previous inactive bank and
expected head, then publishes the command. Generations consumed by failed or
abandoned writes leave gaps. They never rewind with the game save. Unknown active
or inactive bank contents, missing registry entries and changed tuples reject
writes instead of guessing ownership. Every command includes storage, runtimeId,
native generation/revision, activation and expected factHead.

The adapter invalidates the inactive seal, writes generation first and then the
payload, seals it, verifies every value, and flips head last. Actual readback must
match the full durable tuple before the service exposes an enriched binding.
A retained append intention can finish an exact partial inactive write after
verifying/resuming its unchanged old cursor. A lost acknowledgement after a head
flip can reconcile only the same runtime/generation/lease's transient pending
commit plus its exact durable ledger receipt. A new CET runtime may not recreate
that transient receipt. It conservatively forks the verified current tuple's
local prefix; an unexplained partial destination stays unavailable.

For a restored session the service first validates the registry, claims a new
lease with confirmed records, then consumes the driver's readback proof. Only
the actual `PlayerSystem.OnGameRestored` callback can create
`native-facts-restored`; bootstrap/attach and a `restoredCandidate` cannot. If no
qualified proof exists, an exact current tuple may create
`native-facts-current-prefix`: a new local child with unverified inherited history
and no sealed/outbox promotion. Existing parent checkpoints are left intact.
Only a later genuine, qualified restored prefix can seal that child's history.

The native schema/registry/load boundary remains unqualified in the installed
game. Collision audit has explicit corpus gaps; a zero value is not proof that a
name never existed. These tests do not waive source audit or installed lifecycle
qualification. Both identity backends preserve dynamic context when unavailable.

## Recovery behavior

| Observed state | Action |
| --- | --- |
| Empty native identity | Generate independent cryptographic 128-bit campaign/branch/lease IDs, durably create branch, then native seed/readback. |
| Genuinely restored native session | Claim a fresh activation; durably fork the proved restored prefix; read back before exposing local memory. Reuse the REST ID. |
| Fact bootstrap/CET replacement with exact registered tuple | New local branch inherits only the current prefix, unverified and unsealed. No fabricated restored proof. |
| Restored identity without valid prefix proof | Isolate in a new empty branch. Do not invent inherited events. |
| Proof references missing local history | Memory stays unavailable; current facts can continue. |
| Same activation and exact durable/native cursor | Resume existing branch without issuing a new claim/fork. |
| Crash after append, before native advance | Reconcile exact prepared event and tail receipt; only then complete consecutive native CAS. |
| Unjournalled extra local tail | Refuse resume with `ORPHAN_LEDGER_TAIL`; never advance blindly. |
| Native load races a pending command | Abandon its old activation intention; old suffix stays on the old branch. |
| Unavailable, expired heartbeat, cancellation or CAS failure | Unbind local routes, publish unavailable binding, and withhold stale request output. |
| AfterSave serialization receipt | Diagnostics only; no ledger sealing or cloud promotion. |
| Brief verified same-world autosave | Wait up to one second and re-read CAS; preserve the original lease/guard while withholding new routes during the pause. |

Do not call ledger `observe` or `recordActivity` directly from a transport hook:
that would bypass the coordinator's durable/native cursor transaction.

## Verification boundary

Focused coordinator fixtures exercise real Lua and a real temporary disk ledger,
including two campaigns, rollback, same-activation restart, stale CAS, exact
audiences, expired heartbeat, append failure, crash recovery, ambient templates,
cancelled awaits, bounded conversation staging, exact completion hashes/witnesses,
conversation rollback/crash recovery, autosave pause/CAS races and bridge-to-Lua
binding validation. Cross-language fact fixtures execute the actual Lua adapter
against native scalar fakes and the actual disk ledger, including interrupted
bank/head publication. Pool fixtures exercise repeated/older loads, subsequent
branches, group/copy scopes, both restarts and missing/corrupt/over-cap records.
Native calls are fakes in
these tests. No game installation, save mutation, cloud call or native roundtrip
was performed by this implementation task. Installed save/load qualification
remains a separate required gate before cloud qualification can be enabled.
