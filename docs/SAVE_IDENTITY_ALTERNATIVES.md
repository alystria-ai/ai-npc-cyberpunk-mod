# Save identity alternatives after the native registration crash

Experimental implementation and source audit, 2026-09-30. No game facts, save
files, native code, or installed runtime bindings were changed for this work. The existing
`KnowledgeState.reds` component remains quarantined. See
[the current protocol and crash evidence](../research/cyberpunk/SAVE_IDENTITY.md).

## Recommendation

The opt-in adapter in `mod/fact-identity.lua` avoids registering a new native
class. Its writes and restore-proof qualification both **default off**, pending
the controlled integration checks below. The public API supplies scalar
integer reads/writes, with no transaction, compare-and-swap, existence query, or
documented serialization lock. Fact names become 32-bit hashes in saves, so a
distinct text prefix does not by itself prove that writing a fact cannot collide
with a vanilla fact.

The strongest candidate has three parts:

1. Two bounded banks of strictly mod-owned facts, with one final scalar commit
   head and exact verification against an immutable, previously flushed local
   record. Do not accept a checksum as the sole integrity check.
2. A real engine restore receipt, captured before identity writes, using
   `PlayerSystem.OnGameRestored` if its CET observation is live-qualified. A read
   in `PlayerPuppet.OnGameAttached` is useful world readiness evidence, not restore
   proof.
3. Save/load lifecycle fences carried by the already-existing face service if
   CET alone cannot establish them. This adds no new service or game system, but
   still requires a native edit and one restart. It does not prove that the
   underlying Codeware startup race has been repaired.

Until the gates below pass, dynamic game context can continue, while this
candidate's durable identity and cloud promotion remain unavailable. Do not turn a loaded
integer, a timer, a file timestamp, or a CET reload into a fabricated restore
receipt.

## Evidence and its limits

| Source | Established fact | Remaining gap |
| --- | --- | --- |
| [Game QuestsSystem declaration](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/fce9ab7e6a608b0d729290d898003589515900e1/scripts/core/systems/questSystem.script) | `GetFact`/`GetFactStr` return `Int32`; `SetFact`/`SetFactStr` write one `Int32`; listeners can observe changes. | The native implementation is not present. No atomic multi-fact update, ownership, enumeration, or save lock is declared. |
| [WolvenKit FactsTable parser](https://github.com/WolvenKit/WolvenKit/blob/b900c6bb645d0a60c0e5ad791fc87166465f8aca/WolvenKit.RED4/Save/Parser/FactsTableParser.cs) | Save records contain 32-bit name hashes and integer values. String conversion computes FNV-1a32. | A save parser is evidence of the format, not the engine's concurrency or callback ordering. |
| [WolvenKit FactsDB parser](https://github.com/WolvenKit/WolvenKit/blob/b900c6bb645d0a60c0e5ad791fc87166465f8aca/WolvenKit.RED4/Save/Parser/FactsDBParser.cs) | FactsDB contains one or more saved fact tables. | It does not prove which fact table is active at an arbitrary gameplay callback. |
| [Game PlayerSystem](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/fce9ab7e6a608b0d729290d898003589515900e1/scripts/core/systems/playerSystem.script) | The vanilla `OnGameRestored` body reads a quest fact to restore V/Johnny possession. This is concrete evidence that facts are usable at that restoration callback. | CET observation of this exact method and its ordering against all load routes still need an installed test. |
| [Game GameObject lifecycle](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/fce9ab7e6a608b0d729290d898003589515900e1/scripts/core/entity/gameObject.script) | `OnGameAttached` is an entity attachment event. | It does not certify a save was restored. Attachment also occurs outside save loading. |
| [CET observer contract](https://wiki.redmodding.org/cyber-engine-tweaks/patch-notes) | `ObserveAfter` can observe script methods after their body; native/script type names are supported. | A general observer API is not proof that a particular engine lifecycle callback is delivered on every load. |
| [Codeware callback contract](https://github.com/psiberx/cp2077-codeware/wiki#game-events) and [pinned CallbackSystem](https://github.com/psiberx/cp2077-codeware/blob/613a1cb830ecf33508ffca839d3ea631073504ef/src/App/Callback/CallbackSystem.cpp) | `Session/BeforeSave` blocks saving until its handler returns; Ready follows session restoration; BeforeEnd precedes disposal. | AfterSave has no disk-success result. An observed serialization boundary alone cannot authorize remote promotion. |

The game script revision above is the repository's existing pinned local
reference. WolvenKit was inspected at the pinned revision shown in its links.
No external save editor is proposed or used.

## Comparison

| Storage | Startup footprint | Native write consistency | Restore evidence | Main cost/risk |
| --- | --- | --- | --- | --- |
| Current new ScriptableSystem | New system and lifecycle service | One native CAS method owns all fields; BeforeSave freeze | Its own `OnRestored` copies the saved fields | Installed startup failed in Codeware registration; keep quarantined. |
| Facts using only CET | No additional redscript type | Must implement a single writer and an explicit multiword commit protocol | Candidate `ObserveAfter(PlayerSystem.OnGameRestored)` | No qualified save fence; CET reload loses callback state; 32-bit fact-name collisions. |
| Facts plus existing face-service lifecycle | No additional service/system; extra methods/fields on an existing service | Transient native save fence plus the same fact commit protocol | Native retained receipt from actual restore callback | Requires native qualification; facts still have collision and transaction limitations. |
| Own persistent fields added to an existing save-bound ScriptableSystem | No new game-system instance | Could retain the current native CAS design | Wrap that existing system's actual OnRestored without altering its behavior | Separate design needing serializer compatibility and field-migration proof; not implemented or certified here. |

The last option may avoid the newly registered system while preserving a typed
native transaction. It should be compared with facts before committing to a more
complex fact protocol. Adding persistent fields to a vanilla class must preserve
the class's original lifecycle and must never write its existing fields.

## Names and collision ownership

Every name is from the fixed manifest using `cyberpunkconvai_mem_v1_`. Commands select an
operation, never supply an arbitrary fact name. No name beginning with a vanilla
quest identifier is allowed, and no vanilla fact is used as a scratch variable,
generation counter, readiness signal, or identity seed.

Before enabling writes:

- Compute FNV-1a32 for every candidate name and reject collisions within the
  mod's own set.
- Compare those hashes with the reviewed facts extracted from the installed game
  archives, DLC, scripts, and known installed reference/mod resources. Preserve
  the archive fingerprints and the collision audit with the release.
- Treat any unexplained existing payload as occupied/corrupt; do not overwrite it
  merely because the mod expects that slot to be unused.
- Re-run the audit when game resources or the fact schema change.

**Residual gap:** the public scalar read API cannot distinguish an absent fact
from an existing zero-valued fact, prove ownership of a hash, or enumerate all
future dynamically constructed names. A nonzero-read check and a textual prefix
therefore do not constitute an absolute noncollision guarantee. If “never write
a vanilla fact” requires a proof covering all unknown future mods as well, this
API cannot supply it; choose save-owned typed fields instead. Known-fact collision
auditing reduces a concrete risk but must not be described as eliminating it.

### Recorded collision audit

`node scripts/Audit-FactIdentity.mjs` generated
`research/cyberpunk/fact-identity-audit.json`. It found **zero hash collisions**
for the 43 owned names against **14,317 distinct known fact names** from:

- 21 extracted fact dictionaries covering the indexed base/DLC quests and
  journal plus the currently extracted scene batches.
- 2,077 game scripts at the pinned reference commit, scanning complete literal
  fact-API arguments through Git so the sparse checkout does not hide files.
- 145 installed redscript/CET Lua source files, also scanning literal arguments.

The artifact records input fingerprints, names/hashes, the full installed-source
manifest, and a deterministic corpus digest. Dynamic names, unextracted assets,
binary plugin behavior, and future mods remain explicit coverage gaps. Regenerate
and review this artifact when the resource/mod scope changes. Its qualification
flags remain false; zero observed collisions does not enable game writes.

## Multiword commit implementation

The live read-only probe on September 30 read all 43 proposed facts as zero in
normal gameplay and registered the `PlayerSystem.OnGameRestored` observer.
Registration is not callback-delivery or persistence proof. The installed
probe writes only its local report, retains at most 12 snapshots, and expires
after 30 minutes. It does not claim an identity or write any game fact. Actual
save-restored delivery and subsequent write/save/load qualification remain open.

The pure Lua adapter assumes one coordinator writer, guarded synchronous native
calls, and an immutable durable record registry. Construction/loading performs
no game calls or file I/O. Only its 43 fixed names can reach a native setter.

### Data layout

Use one scalar `head` and two fixed banks, 43 facts total:

- `head`: zero for untouched state, otherwise `2 * commitGeneration + bank`.
- Each bank: schema, eight campaign limbs, eight branch limbs, branch epoch,
  local ledger sequence, commit generation, and seal.

Each opaque ID remains 128 bits, represented by eight nonnegative 16-bit limbs.
Counters remain bounded nonnegative `Int32`. `commitGeneration` is in
`[1, 1073741823]`, so the encoded head fits a positive signed 32-bit integer.
Do not wrap or recycle generations.

The bridge allocates each commit generation from an append-only registry across
all campaigns/branches in that local installation, not from the loaded save's
counter. A rollback must not reissue the generation already used by its abandoned
future. Each registry entry permanently contains the complete native tuple, full
opaque IDs, parent prefix, command intent, and content digest. On copied or
missing registries, a nonzero native pointer must fail closed until its complete
record is available and matches; there is no adoption by numeric similarity.

### Write order

1. Verify the current world lease and stable native tuple. Append the memory
   operation and exact intended native commit record to the durable registry and
   flush them before issuing a command to the game.
2. Require the same world, expected head, activation, and a non-saving state.
   Select the inactive bank. Refuse unexpected values or another in-flight writer.
3. Set that bank's seal to zero, then write its **new commit generation first**,
   followed by the remaining payload. Check all
   numeric bounds and read back every payload field.
4. Set its seal to the new commit generation only after that exact readback
   matches. Read it back again.
5. Recheck world, expected old head, saving state, and command ownership. Write
   the new encoded `head` last.
6. Read the selected bank through the normal stable-reader algorithm. A native
   setter return or a successful IPC write is not an acknowledgement by itself.

Only step 5 makes the bank current. Failure before it leaves the previous active
bank authoritative. Lost acknowledgement after it requires exact readback and
registry reconciliation, not an automatic repeat or a new generation.

A partially written inactive bank is recoverable only against the same durable
prepared record and an explicitly confirmed previous bank (or all-zero empty
bank). Every scalar must match an exact prefix of that known write order.
An unrelated mixture, an unknown generation, or an unexplained nonzero owner is
never overwritten. A head-write attempt is treated as uncertain even if the
setter throws; it may have performed the write before reporting an error.

After a lost head acknowledgement, the runtime retains a bounded
`pendingCommit` receipt. A narrow `resume` may finish reconciliation only when
the current full tuple, prepared record, generation, runtime and activation all
match that receipt. It performs no fact write. Changing the load, runtime, or
activation clears the receipt; a new observer cannot reconstruct it from disk.

The native fact API has **no CAS**. An expected-head comparison is only an
application-level guard under the exclusive-writer assumption. Keep one bridge
owner, one serialized command chain, and one current Lua/native activation. Stop
old closures on CET shutdown and reject stale envelopes after a world/activation
change. Before every scalar mutation and after the final readback, recheck world
availability, runtime/load generation, revision, activation and old/new head.
Recheck after acquiring native access too: that call could deliver a lifecycle
callback. Do not label a read-then-write pair as an engine CAS operation.

### Stable reader

Read head, selected seal, the complete selected payload, selected seal again,
then head again. The implementation also reads the inactive bank for bounded
ownership/recovery inspection. Require both head reads to match, both seals and payload
generation to match the decoded generation, supported schema, valid bounds, and
valid nonzero opaque IDs. There is no retry inside the driver; instability becomes
unavailable and the coordinator chooses whether to retry a later inspection.

The bridge then compares **every field** with the immutable prepared record for
that generation. A CRC/hash match alone is insufficient. No matching record,
different branch/campaign/sequence, or a missing registry means unavailable.
Unused-bank garbage never overrides a valid selected bank. An invalid selected
bank must not silently fall back to an older bank, because that would manufacture
a rollback not chosen by the loaded save.

### Saving and interleaving

A double-read seqlock protects a live reader; it does not automatically make the
engine's multi-field serializer transactional. A save can read a final head after
some earlier payload fields, or capture an inactive bank while it is rewritten.

The exact-record check is therefore mandatory even after an actual load. A torn
saved combination either matches a complete previously prepared tuple or is
rejected. Never-reused generations prevent the ABA case where a bank returns to
an old-looking stamp after two writes. The chosen tuple must also have been
committed by the mod's writer, not merely prepared on disk.

The preferred additional protection is a native transient saving fence in the
existing service: BeforeSave prevents new cursor writes until AfterSave/End.
If save initiation interrupts an unfinished bank write, leave the old head in
place, stop before committing the new head, and reconcile afterward. No file,
network, ledger flush, or waiting is allowed inside the native save callback.
Do not invent a save pause from elapsed time or a screen icon.

**Qualification gap:** native `SetFact` serialization ordering and the writer's
callback interleaving have not been proved by the public declarations. Before
shipping, a controlled test must show that saves at each interruption point
restore either the old complete commit, the new complete commit, or a rejected
incomplete state. A valid-looking mixed prefix is a release blocker.

## Why a single 31-bit pointer is not the default recommendation

One positive integer referencing a flushed immutable local record minimizes the
write to a single native value. It is attractive for save interleaving, and could
be useful inside an already verified immutable native campaign namespace.

On its own, however, it is too weak for this mod's save identity contract. Two
independently copied installations/ledgers can allocate the same handle for
different records; a imported save can then resolve to unrelated local history.
A counter makes that conflict likely, and a random 31-bit value does not provide
the desired opaque 128-bit namespace. A user-specific fact name also collapses to
the engine's 32-bit hash. It is not a substitute for checking native campaign and
branch IDs. Avoid this shortcut unless its ownership namespace and clone/import
behavior have their own explicit proof.

## Actual load versus CET reload

| Event | Allowed interpretation | Memory action |
| --- | --- | --- |
| Actual `PlayerSystem.OnGameRestored`, observed after the vanilla body, before any identity write in this load | Candidate restore receipt for the exact facts read in that callback | Validate complete tuple and registry, then authorize only that restored prefix after live qualification. |
| Codeware Ready with `IsRestored() == true`, observed natively after session start | Alternative candidate engine restore boundary | Same exact-prefix checks; record provenance explicitly. |
| PlayerPuppet OnGameAttached / OnTakeControl | Player/world attachment or possession | Invalidate/re-establish world lease as needed; no restore promotion. |
| CET `onInit` during an already loaded world | A new Lua runtime sees current live facts | Always a new runtime token and conservative local branch fork at the exact current prefix; no new restore proof. |
| Bridge restart with unknown activation ownership | Native state may include unsaved live events | Reconcile exact current tuple and immutable journal. Fork at that prefix when ownership is uncertain. |
| Returning from a menu, a delay, repeated identical reads, or BeforeSave/AfterSave | Readiness or serialization observations | No fresh-loaded-prefix proof. |
| New game or pre-mod save with genuinely untouched native identity | No known campaign yet | Prepare a new isolated campaign; do not infer lineage from V's attributes or the latest save metadata. |

An observed `OnGameRestored` callback must be captured at the boundary, with a
fresh generation and an immutable plain snapshot. Reading the facts later and
labelling them with an earlier restore event would promote intervening unsaved
events. Register only after CET onInit, before a user loads a save. If registration
was late, wait for the next actual load instead of pretending it happened.

A conservative fork after an unknown restart may inherit only the prefix named
by the currently read native tuple. Local replay of that prefix is allowed once
the binding is verified. It does not certify that all inherited events are saved
or remote-eligible. Existing genuine ancestor proofs remain limited to their own
prefixes. Unreferenced journal tails and earlier provider sessions stay isolated.

Do not use player entity IDs, process IDs, wall-clock timestamps, playtime, latest
disk metadata, or quest titles as permanent campaign identity.

## Adapter and coordinator contract

```lua
local runtime = FactIdentity.new({
  runtimeId = freshRuntimeNonce, -- nonzero 32 lowercase hex; transient only
  getFacts = function() return currentQuestSystem end, -- reacquired per operation
  isWorldAvailable = function() return worldIsUsable end,
  writeQualified = false,
  restoreQualified = false,
  collisionAudit = reviewedArtifact
})
local driver = runtime.identityFactory({activationId = bridgeLease})
```

The integration owns observer registration and invokes these entry points:

- `attachCurrentWorld()` / `onAttached()` establishes an **unverified live**
  generation. It never claims a load occurred.
- `onRestored()` is called only from the real
  `ObserveAfter('PlayerSystem', 'OnGameRestored', ...)` callback. It starts a new
  generation and copies the tuple immediately. A failed boundary read cannot be
  repaired later into a restore receipt.
- `invalidate()` discards the lease, pending commit, and restored candidate.
- `onBeforeSave()` / `onAfterSave()` fence writes when the qualified callback
  source is wired. They never establish restore proof or disk-save success.

`inspect()` is read-only. It returns `status='inspected'`, `authoritative=false`,
`storage='quest-facts-v1'`, `runtimeId`, `generation`, `revision`, `activationId`,
`factHead`, the selected tuple, `origin`, `requiresFork`, `resolved`, `saving`,
`faulted`, `restoreQualified`, and `expected`. An empty identity has `schema=0`.
The `banks` array is ordered bank 0 then bank 1; each entry has `bank`, `empty`,
the fixed 21-integer `raw` payload, and `valid`/`record` for a nonempty bank.
Inspection returns no native handles.

The exact prepared/confirmed record shape is:

```js
{schema: 1, bank: 0 /* or 1 */, campaignId, branchId,
 branchEpoch, ledgerSequence, commitGeneration}
```

`driver.apply(command)` accepts `claim`, `seed`, `fork`, `advance`, or `resume`.
Every command carries `expected={runtimeId,generation,revision,activationId,factHead}`
and `confirmedRecords`, at most eight complete records validated against the
bridge's immutable registry. The injected driver activation is the new lease for
`claim` and must match the current lease for all other actions. Mutation commands
also carry the exact `preparedRecord`; `seed` has campaign/branch IDs, `fork` has
branch ID/epoch, and `advance` has the next local sequence. `previousBank` is
required to recover a partial inactive write. A `resume` for a pending head
commit additionally carries that same `preparedRecord`.

The coordinator claims first using the registry-confirmed records. Before claim,
`restoredCandidate` is only an immutable observation, never proof. After claim,
the matching actual receipt can become `restoredProof` if restoration is
qualified. An unknown-origin runtime must fork; exact native tuple equality with
the latest ledger tail does not permit reusing a possibly contaminated branch.

`capture()` exposes `status='available', authoritative=true` only after the
registry/native readback handshake resolves the identity. It retains any genuine
ancestor `restoredProof` as a separate frozen prefix. It never describes a later
unsaved advance as restored.

## Distinct restored proof

The existing ledger accepts `kind: native-on-restored` specifically for the
quarantined save-owned system receipt. The fact adapter uses this separate
versioned proof, accepted only by an explicit registry-aware validator:

```js
{
  version: 1,
  kind: 'native-facts-restored',
  source: 'PlayerSystem.OnGameRestored',
  campaignId, branchId, branchEpoch, ledgerSequence,
  commitGeneration, bank, factHead: 2 * commitGeneration + bank,
  checkpointId: `${branchId}:${commitGeneration}:${ledgerSequence}`,
  loadGeneration, runtimeId, factSchema: 1,
}
```

The driver emits this only when `restoreQualified=true` and the immutable
boundary tuple is among the exact registry-confirmed records. Qualification must
establish callback provenance, exact tuple capture, schema/hash manifest, commit
ownership, and native readback. A digest cannot authenticate itself or replace
complete tuple equality. Once admitted, the proof only
authorizes the named branch prefix. Live advances and child forks cannot reuse it
as proof for their new events.

## Qualification plan and decision gates

No game write is authorized by this document. Integration review should prepare
one combined controlled qualification, not repeatedly ask
the user to restart for speculative alternatives.

1. **Ownership:** fixed fact-name/hash manifest passes the installed resource
   collision audit; unresolved collision coverage is recorded explicitly.
2. **Lifecycle capture:** a read-only observer records actual load, same-save
   reload, new game, possession, fast travel, menu return, and CET reload. Only
   actual restored sessions may emit restoration evidence. No synthesized call
   to the game's lifecycle method is permitted.
3. **Commit fault model:** enumerate interruption before/after every bank write,
   head write, save boundary, acknowledgement, and bridge/CET restart. Check that
   no mixed tuple or abandoned future tail becomes available.
4. **Native roundtrip:** on an explicitly owned test namespace and manual save,
   prove token limbs/cursor restoration, then advance, reload the older save,
   fork, and verify the later tail stays absent.
5. **Clone/import:** two divergent ledger copies or a save without its ledger
   must never bind to a coincidentally matching integer. Missing native record
   data remains unavailable.
6. **Remote boundary:** keep cloud writes disabled until native qualification
   passes; then separately check that only delivered and genuinely restored
   prefixes are projected into the scoped Convai identity.

Current evidence: **16 focused automated tests pass** against the actual Lua
adapter, including interruption before/after each of its 23 scalar writes, lost
head acknowledgement, stale guards, unknown ownership, mixed serializer
snapshots, partial recovery, and immutable loaded-prefix proof. These tests do
not qualify engine callback delivery or game serialization. The collision audit
passes within its documented scope. Native writes, actual restore observation,
the manual save/load/rollback roundtrip, and cloud promotion remain unqualified.
