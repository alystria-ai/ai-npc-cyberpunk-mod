# Save identity, checkpoint proof, and rollback protocol

September 30, 2026. Source-backed implementation; native game qualification is
blocked by a startup crash, documented below. Keep the native component excluded
from installs until that boundary is resolved. This subsystem does not identify a loaded save from its filename,
modification time, journal title, game clock, most recent disk metadata, or PID.

An isolated, opt-in alternative now exists in `mod/fact-identity.lua`; it uses a
fixed audited mod-owned fact namespace and no new native class. See
[the alternative protocol and qualification gates](../../docs/SAVE_IDENTITY_ALTERNATIVES.md).
Its game writes and restore-proof qualification default off. The native class
described below remains quarantined; it was not repaired or reinstalled here.

## What is implemented

- `r6/scripts/CyberpunkConvai/KnowledgeState.reds`: a mod-owned persistent
  `ScriptableSystem`, plus a nonpersistent Codeware lifecycle service.
- `mod/save-identity.lua`: an injected, side-effect-free Lua adapter. It acquires
  native handles only inside a call and emits bounded, plain data.
- `bridge/save-identity.test.mjs`: lifecycle/protocol tests of the real Lua adapter
  against a source-guided native boundary fake. These are not native save tests.

There is no automatic seeding, quest-fact write, external save-file edit, timer
based promotion, provider call, or file polling in these modules. The native file
only writes its own persistent fields in the game's ordinary serialization path.
The parent integration coordinator must supply a bridge-generated lease and
commands after resolving the durable local ledger.

## Evidence inspected

| Source | What it establishes | Limits |
| --- | --- | --- |
| [Game `ScriptableSystem` definition](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/fce9ab7e6a608b0d729290d898003589515900e1/scripts/core/systems/scriptableSystem.script) | Container lookup; exported `OnAttach`, `OnDetach`, `OnRestored(saveVersion: Int32, gameVersion: Int32)` lifecycle; native `WasRestored`. | Declaration does not prove the installed game's callback ordering in this mod. |
| [Game `DataTrackingSystem`](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/fce9ab7e6a608b0d729290d898003589515900e1/scripts/cyberpunk/systems/dataTrackingSystem.script) | Existing game system uses persistent integer fields and persistent arrays. | Does not prove a new system's roundtrip. |
| [Codeware lifecycle documentation](https://github.com/psiberx/cp2077-codeware/wiki) | Services survive sessions; system persistence is save-bound; `BeforeSave` callback blocks serialization until it returns; `AfterSave` follows saving; persistent `String` unsupported. | Wiki version may differ from installed 1.20.5; implementation was checked separately. |
| [Codeware 1.20.5 `CallbackSystem.cpp`](https://github.com/psiberx/cp2077-codeware/blob/613a1cb830ecf33508ffca839d3ea631073504ef/src/App/Callback/CallbackSystem.cpp) | `OnBeforeGameSave` dispatches `Session/BeforeSave`; `OnAfterGameSave` dispatches `Session/AfterSave`; `OnGameRestored` dispatches `Session/Ready`; `OnGameLoad` sets the restored flag. Service callbacks survive session cleanup. | `AfterSave` supplies no disk-success result. Do not equate it with a successful file write. |
| [Codeware `GameSessionEvent`](https://github.com/psiberx/cp2077-codeware/blob/613a1cb830ecf33508ffca839d3ea631073504ef/src/App/Callback/Events/GameSessionEvent.hpp) | Payload contains pregame/restored flags, with no save path, checkpoint ID, or success field. | Cannot certify durable completion by itself. |
| [AI NPC conversation store](https://github.com/Sebajuste/CP77_ai_npc/blob/035d4b95c8934a520c0e8d810472ac71ec7a9a7b/src/r6/scripts/ai_npc/AiNpcConversationStore.reds) | A concrete existing mod stores integer branch/sequence pointers in a ScriptableSystem; it resolves saved state in `OnRestored`. Its comments describe missing `Session/Ready` when subscribing from late `OnAttach`. | This is an implementation example, not certification of our code. Its fallback first-write resolution is deliberately not adopted. |

Local reference game revision: `fce9ab7e6a608b0d729290d898003589515900e1`.
Local AI NPC revision: `035d4b95c8934a520c0e8d810472ac71ec7a9a7b`.
Installed Codeware scripts report version **1.20.5**, matching release commit
`613a1cb830ecf33508ffca839d3ea631073504ef`. Installed declaration hashes:

- `Codeware.Global.reds` SHA256:
  `94a460a4ecf31c79be3168535bda14490a1f3d1846188e422dee639c356c6c3b`
- `Codeware.reds` SHA256:
  `b681f34c4db2220b3f7451ddb312725207079b39dbf2ce25ec218acc519291fb`

No verified live `playthroughID` was found or invented. A freshly loaded save
without our persisted identity is uninitialized. Assigning it a new campaign is
safe isolation; assuming it belongs to another old save because V has the same
name, quest, or lifepath is not.

## Persistent footprint and ownership

IDs are random **32 lowercase hexadecimal digits**, generated by the bridge's
cryptographic RNG and never reused. Native storage encodes each ID as eight
nonnegative `Int32` limbs in `[0,65535]`, preserving all 128 bits without Lua's
floating-point/64-bit conversion issues or unsupported persistent strings.

| Saved field | Meaning |
| --- | --- |
| `m_schema` | Persistent format, currently 1. Zero means no identity. |
| `m_campaign` | One mod-owned playthrough identity. |
| `m_branch` | One immutable-history lineage in the local ledger. |
| `m_branchEpoch` | Starts at 1; only an explicit fork may increase it. |
| `m_ledgerSequence` | Last durably appended local operation acknowledged by native CAS. |
| `m_checkpointSequence` | Bounded counter stamped at a native BeforeSave boundary. |
| `m_checkpointBranch`, `m_checkpointBranchEpoch`, `m_checkpointLedgerSequence` | Exact ledger cursor included at that serialization boundary. |

The bridge stores ancestry, local user ID, event payloads, deduplication,
knowledge/audience policy, and remote receipts. Native code stores no biography,
transcript, credentials, NPC entity handle, or cloud user identifier. Persistent
field types must not change after shipping; future versions add fields and an
explicit migration instead of silently resetting unsupported schemas.

`generation` is a **process-local native session counter**, never a campaign ID.
It changes at `Session/BeforeStart`, including loading the same save. `revision`
is a transient CAS counter for native mutations/save edges. `activationId` is a
bridge-generated random lease, cleared when the native session ends. These values
belong in delivery/cancellation guards, not permanent user namespaces.

## Lifecycle and proof levels

1. The lifecycle service subscribes in `OnLoad`, before game sessions. It retains
   the most recent Ready signal so a system attached later can synchronize without
   guessing. The service persists no state and holds no game-object references.
2. A loaded system waits for **both** the native Ready signal and its own
   `OnRestored`. New unsaved games require Ready but do not pretend to be restored.
3. `OnRestored` copies the actual saved ledger cursor into a transient immutable
   receipt. It marks checkpoint proof valid only when the restored branch, epoch,
   and cursor exactly match the persisted checkpoint fields.
4. The bridge claims a lease, reads the saved cursor, resolves it against its
   durable ledger, then explicitly resumes or forks. Until resolution, normal
   capture is unavailable and a native save does not stamp a new checkpoint.
5. `BeforeSave` freezes mutations and stamps only the already-acknowledged cursor.
   It does no disk, network, quest lookup, or waiting. `AfterSave` releases the
   freeze and reports **serialization-finished**, not disk success.
6. `BeforeEnd`/`OnDetach` invalidate readiness and the lease. No cached native
   handle survives into a new world.

| Reported evidence | What consumers may do |
| --- | --- |
| No native readback / unclaimed / unresolved / saving / faulted | No reusable memory identity. Dynamic-only context may continue under separate short-lived world guards. |
| `confidence: native-live` | Route the running, read-back identity and local live cursor. Do not infer disk durability. |
| `confidence: native-restored` | The current cursor equals the actual loaded prefix. Future live mutations downgrade current confidence. |
| `checkpoint.proof: serialization-candidate` or `serialization-finished` | Diagnostic candidate only. Never promotes remote memory. |
| `restoredProof.kind: native-on-restored` | Certifies only the explicit immutable restored prefix for ledger checkpointing. |

An older restored proof remains available after live appends or a fork because
it still proves that older prefix. It must **never** be relabelled as proof for
the new branch or new live events. Repeated reads do not create new checkpoints.
Native counters exhaust by refusing progress; they never wrap into old IDs.

## Exact Lua integration

The module does not poll or touch files. An integration coordinator owns atomic
`knowledge-command.json` / `knowledge-state.json` I/O and world invalidation.
It must validate the envelope, retain command IDs for reconciliation, and stop
publishing previous snapshots on read failure. Do not preserve a last-good identity
as if it were current after detach or an unavailable read.

```lua
local Identity = dofile('save-identity.lua')
local driver = Identity.new({
    activationId = bridgeActivationId, -- random 32-lowercase-hex value
    getSystem = function()
        -- Caller checks attached gameplay/world state before reading.
        return Game.GetScriptableSystemsContainer():Get('CyberpunkConvai.ConvaiKnowledgeState')
    end
})

local inspected = driver.inspect() -- read only, plain data, no identity authorization
local claim = driver.apply({kind = 'claim', expected = inspected.expected})
-- All later commands use the fresh expected guard returned by inspect/readback.
```

`expected = {generation, revision, activationId}` is mandatory. An inspected
uninitialized identity has an empty native `activationId` before claim. The driver
has its separately injected new activation. A command is rejected if the native
guard changed, not retried with a newly refreshed guard.

`inspect()` also exposes `restoredProof` before ledger resolution, when the native
restore receipt is valid. This permits recording the exact parent checkpoint
before creating a rollback branch. Inspection remains a read-only resolution
input; it does not authorize conversation routing from an unresolved identity.

Commands after claim:

```lua
driver.apply({kind='seed', expected=guard, campaignId=newCampaign, branchId=newBranch})
driver.apply({kind='resume', expected=guard})
driver.apply({kind='fork', expected=guard, branchId=newBranch, branchEpoch=higherEpoch})
driver.apply({kind='advance', expected=guard, ledgerSequence=oldSequence+1})
```

- **Seed:** only a completely empty native record. The bridge first creates a
  durable empty campaign/branch. Native readback must echo the exact IDs.
- **Resume:** only after the bridge proves its available ledger head equals the
  loaded cursor and no newer history/remote tail requires isolation.
- **Fork:** the bridge first durably creates a new branch whose parent is the
  captured old branch plus its exact local cursor. Native switches IDs and resets
  local sequence to zero. Inherited entries are not counted in that local sequence.
- **Advance:** append the episode/operation durably **before** sending the native
  increment. Only consecutive increments are accepted. A crash between append
  and native CAS leaves an orphan tail, not a save pointing beyond the journal.

Each command returns `{ok, reason?, inspected?, snapshot?}`. A `true` native Bool
is followed by full readback. `native-command-uncertain` means the call/readback
was interrupted; inspect and reconcile the exact cursor before deciding whether
to resend anything. The adapter never retries automatically.

`driver.capture()` returns the available form below only after ready, claim,
valid schema, and ledger resolution. Unavailable results contain no reusable
campaign identity.

```js
{
  version: 1, status: 'available', authoritative: true,
  confidence: 'native-live',
  campaignId: '32-hex-digits', branchId: '32-hex-digits',
  branchEpoch: 2, ledgerSequence: 0,
  generation: 4, revision: 3, activationId: '32-hex-digits',
  // Optional, immutable proof for a previously restored prefix:
  restoredProof: {
    kind: 'native-on-restored', branchId: 'parent-32-hex-digits',
    ledgerSequence: 7, checkpointId: 'parent-32-hex-digits:3:7'
  }
}
```

Checkpoint IDs encode `branchId:checkpointSequence:ledgerSequence`. All three
parts are validated. `restoredProof` aligns with the ledger's
`bindIdentity({authoritative,campaignId,branchId,checkpointId,parentBranchId?,
forkLedgerSequence?,restoredProof?})` contract. A `BRANCH_REQUIRED` result must be
resolved through a new durable branch and native Fork before warming identified
companion connections. The bridge enriches the capture with its separate stable
`localUserId`; the native adapter does not generate or infer that user.

Stable transcript/memory scope is `{localUserId,campaignId,branchId,character,
audience}`. Transient request/publication guards also include activation and
generation. Resolve identity before companion prewarming; cancel and rekey all
world/private/group/phone work on load or branch change. A filename-based phone
history key or old unscoped provider session must not be reattached implicitly.

## Verification and remaining qualification

Performed: Lua 5.1 syntax check; **17** focused adapter/probe tests covering missing
native state, malformed IDs/counters, unknown schema, exact readback, stale CAS,
new/pre-mod saves, bridge replacement, save freezes, AfterSave nonpromotion,
immutable restore proof, older-prefix forks, ambiguous writes, detach, and high-bit
128-bit token roundtrip. Tests use no game, credential, network, or real save.

The parent also completed isolated redscript compilation successfully (scc exit
0; `vendor/compiler-check-308b0b78916749469e099de32e12974f/compile.log`, September
30, 2026, 03:00:29 IST). The log reports compilation complete and output into the
isolated staging cache. Compilation does not qualify persistence.

The parent attempted an isolated install of `KnowledgeState.reds` and the unused
Lua adapter. Startup crashed before normal plugin script initialization. Removing
only `KnowledgeState.reds` restored startup and the user loaded the same save
normally. The adapter remained installed but unused. No native identity was
seeded, and no serialization roundtrip or remote-memory qualification occurred.
The parent owns installation and any later live qualification.

Required controlled game check before enabling durable promotion:

1. Read an uninitialized native system after the actual loaded save is ready;
   seed and read back new IDs. Verify a second campaign never inherits them.
2. Durably append cursor 1; native advance; perform an ordinary game save; record
   BeforeSave/AfterSave receipts. Confirm no cloud eligibility yet.
3. Append cursor 2, then load the earlier save. Verify the native pointer restores
   cursor 1, the old activation is rejected, and proof names only checkpoint 1.
4. Fork to a new branch, cursor 0 with parent prefix 1; confirm local context,
   phone history, warmed sessions and late results cannot expose cursor 2.
5. Save and reload the fork; verify IDs/epoch/sequence survive a full process
   restart and a CET-only reload cannot create a false restore receipt.

The immediate blocker is the native registration crash below. After resolving
it, the native save/load roundtrip and installed callback ordering still require
qualification. There is
also no source-backed disk-success signal in the inspected Codeware payload.
Until qualification, keep durable cloud promotion disabled. A future verified
save-success signal may permit earlier promotion; neither a delay nor checking
the newest save file is an acceptable substitute.

## Read-only live qualification probe

`mod/save-identity-probe.lua` is an explicit bounded inspection tool. The parent
adds this routing branch to `diagnostics.lua` when installing the probe:

```lua
if request:match('^save%-identity:') then
    return dofile('save-identity-probe.lua')
end
```

The request is **only** `save-identity:inspect:<unique nonce>`, with an 8–64
character alphanumeric/hyphen/underscore nonce. It writes plain diagnostics to
`runtime/save-identity-probe.json`: adapter before/readback, exact restored proof,
known native method types, a whitelist of scalar field types/values, and bounded
token-array shape information. It does not stringify native objects, retain
handles, enumerate arbitrary game objects, read a command file, or call any
mutating identity method. Invalid/mutating actions are rejected before game access.

This extra raw-type view explains `native-read-failed` without weakening the
adapter: for example, missing fields, unexpected native numeric types, or token
arrays with the wrong shape remain unavailable and visible diagnostically.

Do **not** add `seed` or `advance` probe operations outside the coordinator.
Advancing a save-owned cursor without the corresponding durable bridge journal
would create exactly the broken pointer this subsystem prevents. For the live
roundtrip, first inspect the uninitialized system, then install/run the actual
`mod/knowledge-state.lua` and `bridge/knowledge-service.mjs` coordinator against
its real isolated application ledger. Let its durable preparation seed the native
identity. Exercise advances through its normal durable append API, not direct CET
commands. The parent exclusively owns live request/command files and game control.

After coordinator seed/append, ask for an ordinary manual save and a reload only
when ready to verify native restore. The probe can inspect before and after those
user actions. It does not initiate a save, load, autosave, or game restart.

## September 30 startup qualification failure

This is an observed failure, not a successful native integration. The installed
combination was Cyberpunk 2.31, RED4ext 1.30.0, and Codeware 1.20.5. The local report
is `C:\Users\akshi\AppData\Local\REDEngine\ReportQueue\Cyberpunk2077-20260930-033026-17504-20244`.
The parent isolated the regression to adding this native source: removing only
`KnowledgeState.reds` restored startup and same-save loading. This establishes a
trigger under that run's initialization order; it does not establish that one of
our redscript callbacks caused the native fault.

Read-only dump analysis used the installed binaries' x64 PE unwind metadata,
including chained unwind records, and pinned source. The exception is a write to
address `0x4` at `Codeware.dll+0x4d16a`, instruction `mov [rcx+4], r8d` with zero
`rcx`. The recovered faulting call chain is:

1. Codeware `HashMap::Reserve`, `+0x4d16a`.
2. Hash-map insertion, return `+0x36d63`.
3. `SystemBuilder<StaticEntitySystem>::RegisterSystem`, return `+0xeb19b`.
4. `TypeInfoRegistrar::OnDescribe`'s pending callback loop, return `+0xf999`.
5. Native RTTI startup jobs, game returns `+0x1485ff`, `+0x1477f4`,
   `+0x1481d2`, `+0x148101`, `+0x147f18`, `+0x1489a0`, `+0x148cdb`.

The `StaticEntitySystem` identification is supported by its RTTI CName hash
`0xa7a41658434ebb1d`, the matching constructor, and the two game-instance map
insertions. It is Codeware's own native system. The faulting stack does not contain
our `OnLoad`, `OnAttach`, or a script-VM call. A second RTTI worker was inside
Codeware's native `CClass::CreateInstance` hook for
`gameJournalPointOfInterestMappin`, identified from the class hash
`0x20e05c1aa7eacebe`; that is also not one of our classes.

At the failing rehash, requested new capacity was **6** while the map read from
the dump had count **298** and capacity **318**. The new six-entry free list was
exhausted while traversing the old map. This is inconsistent with an ordinary
single-threaded reserve: its entry guard should return when requested capacity
does not exceed current capacity. The evidence supports initialization overlap
or corruption between that guard and traversal. It does not identify the other
writer conclusively, so concurrency remains a cause candidate rather than a
fully reproduced source-level diagnosis.

Relevant primary source:

- [Codeware SystemBuilder registration](https://github.com/psiberx/cp2077-codeware/blob/613a1cb830ecf33508ffca839d3ea631073504ef/lib/Red/TypeInfo/Definition.hpp#L976):
  checks for a framework, initializes a custom system, then inserts into
  `systemMap`, `systemImplementations`, and `systemInstances` without a lock.
- [Codeware pending RTTI callback loop](https://github.com/psiberx/cp2077-codeware/blob/613a1cb830ecf33508ffca839d3ea631073504ef/lib/Red/TypeInfo/Registrar.hpp#L64):
  moves and invokes the pending describe callbacks.
- [Pinned SDK HashMap reserve](https://github.com/psiberx/RED4ext.SDK/blob/6ea7425adf23203027d3b8d21838a29fc765691c/include/RED4ext/HashMap.hpp#L329):
  checks capacity, allocates the requested size, then reads the live old capacity,
  index table, and node list during rehash.
- [Codeware script lifecycle hooks](https://github.com/psiberx/cp2077-codeware/blob/613a1cb830ecf33508ffca839d3ea631073504ef/src/App/Scripting/ScriptingService.cpp#L44):
  service `OnLoad` follows ScriptBundle destruction; `OnInitialize` follows game
  instance initialization. The [official callback documentation](https://github.com/psiberx/cp2077-codeware/wiki#game-events)
  explicitly supports `GetCallbackSystem()` during service `OnLoad`.

Moving our registration to a different callback could change timing but is not
a proven correction for this stack. The existing face service already uses the
documented `OnLoad` callback path. No speculative native code rewrite, plugin
binary patch, external save edit, or library downgrade was applied during this
analysis. Keep the native component quarantined, durable identity unavailable,
and remote memory promotion disabled. A controlled inert-declaration isolation
test or a source-level Codeware registration fix can investigate the trigger
further; neither should be described as repaired before startup and save/load
qualification succeed.
