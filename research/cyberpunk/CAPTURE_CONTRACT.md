# Current-world observation adapter

## Native qualification, September 30

The parent ran `knowledge-capture` in the already running game without reloading
or changing game state. Cyberpunk reported version 2.31. The adapter read the
tracked quest's native hash and active state, the loaded player's lifepath, and
three nonzero allowlisted fact values. The actual emitted snapshot passed
`parseWorldSnapshot`, including its activation token. The ignored receipt is
`runtime/knowledge-capture-live-20260930.json`.

This qualifies those read APIs and serialization on this installation. It does
not qualify every authored fact interpretation, completed-objective path, save
identity roundtrip, or cloud memory operation. The diagnostic deliberately used
unknown identity and did not create memory candidates or send data to Convai.

`mod/world-knowledge.lua` supplies read-only observations for
`bridge/world-knowledge.mjs`. It does not interpret quest choices, scrape prose,
modify the game, resolve character knowledge, or write long-term memory.

## Integration

Create one collector for the loaded mod. Configure its reviewed allowlist once,
then update it from the existing gameplay update hook. Capture a new plain copy
for each conversation recipient or group round.

```lua
local knowledge = dofile('world-knowledge.lua')
local collector = knowledge.new({
    currentGeneration = function() return currentWorldGeneration end,
    currentWorldToken = function() return currentWorldToken end,
    -- A monotonic wall/gameplay clock is preferable to the os.time fallback.
    now = function() return elapsedSeconds end
})

local ok, reason = collector:configure(reviewedPack, {
    gameVersion = '2.31',
    -- Optional exact subsets; required if an inventory contains >512 rows.
    factKeys = selectedFactNames,
    journalKeys = selectedJournalHashes
})

-- Each gameplay update; this call returns status/counts, never native handles.
collector:update({generation = currentWorldGeneration, worldToken = currentWorldToken})

-- Each F6/F7/F8/F9/phone/reaction context. Identity and recipients are supplied
-- now, not retained from the previous speaker or inferred from an NPC model.
local snapshot = collector:capture({
    generation = currentWorldGeneration,
    worldToken = currentWorldToken,
    identity = currentSaveIdentity,
    audience = {channel = 'private', profileKeys = {'judy-alvarez'}}
})

-- On every session end, before a load/new game, and on CET teardown:
collector:reset(nil, 'world-transition')
```

`begin(pack, context)` is a convenience for `configure(pack, context)` followed
by one `update(context)`. It is not a synchronous unbounded sweep.

The generation must be a **world/load generation**, not the existing counter
incremented per chat request. Prefer `save-identity.inspect().generation` after
its native lifecycle code is installed. Pair it with a bounded opaque
`worldToken` derived from the activation/branch identity. A revision or checkpoint
counter that advances during ordinary play is not the world token.

Until native identity is installed, the parent's explicit load/session token may
support dynamic-only capture; identity must remain `unknown` or `session-only`.
The caller must never re-identify a snapshot from an earlier generation after a
load. Use the same generation getter for the capture and the bridge's native
identity heartbeat. `currentGeneration` and `currentWorldToken` callbacks check
the caller's binding before and after native reads and again at capture time.

When supplied, `worldToken` is also emitted on the snapshot and preserved by the
bridge parser. It is an opaque identifier of at most 160 characters. The bridge
coordinator must compare both `generation` and `worldToken` with its current
binding **before** attaching verified identity to a snapshot that originally had
unknown identity. A retained snapshot keeps its original token; activating a
different branch/CET lease with the same numeric generation cannot relabel it.
Snapshots without a token cannot satisfy this activation qualification.

Unknown identity does not hide observed current-world facts. It prevents the
resolver from proposing durable memory events. A verified identity requires
`userId`, `playthroughId`, `branchId`, and `checkpointId`. Those fields come from
the identity owner; this adapter cannot prove them itself.

## Scheduling, freshness and failure

- Default: at most 32 observations per update, with a cooperative 2 ms CPU
  budget checked between observations. A single native call cannot be preempted.
  Limits may be lowered; hard maxima are 128 observations and a 10 ms budget.
- Native journal lookup follows at most 12 ancestors by default (hard maximum
  16). It does not enumerate the complete journal or hold a native traversal
  queue across frames.
- A complete cycle becomes visible together. Partial cycles are never emitted.
  The previous complete cycle may serve while a new cycle is in progress only
  while its original sampling-window lease remains valid.
- Default maximum age is 3 seconds measured from the **start** of sampling,
  not publication. Maximum configurable age is 5 seconds. Refresh begins 0.25
  seconds after a completed cycle. Expired cycles are discarded.
- `now` should be the parent's nondecreasing elapsed clock. The fallback is
  `os.time`, a wall clock with whole-second resolution. Backward jumps invalidate
  all observations; forward jumps can expire them. `cpuNow` defaults to
  `os.clock` and is used only for the cooperative work budget.
- Each updated fact/journal result replaces its prior value, including failures.
  A fresh read failure cannot preserve an old known outcome indefinitely.
- Unavailable/dead/detached player, pregame, queued journal state changes,
  throwing readiness APIs, changed world identity, reset, and invalid clocks
  clear the capture. They never fall back to the previous save.
- The game does not expose an atomic snapshot transaction for these reads. A
  result is a bounded observation window, not proof that every field was read
  at one instant. Outcome conflict detection and checkpoint qualification remain
  the resolver/ledger's responsibility.

## Input allowlists

The parent must validate the full pack with `validateKnowledgePack` before
deployment. This adapter validates read selectors and version compatibility,
not the semantic truth of a condition or a community source.

`configure` requires version 1, an exact matching `gameVersions` entry, and
`factAllowlist`/`journalAllowlist` maps. Each inventory has at most 4096 entries.
Each read selection has at most 512 facts and 512 journal entries. Larger
inventories require an explicit subset; there is no alphabetical truncation of
fact/decision observations. Selecting a nonallowlisted name fails closed.

Each inventory row needs nonempty bounded `evidenceRefs`. Journal rows need a
`questKey` and either a signed/unsigned 32-bit decimal hash as their map key or a
stable alias accompanied by a reviewed exact `nativePath` and `nativeClass`.
Capture-only metadata may accompany the resolver fields:

```json
{
  "-1234567": {
    "questKey": "reviewed-public-quest-key",
    "evidenceRefs": ["native-reviewed-journal-entry"],
    "nativePath": "quests/reviewed/path/to/objective",
    "nativeClass": "gameJournalQuestObjective",
    "questHash": "987654"
  }
}
```

`nativePath` and `nativeClass` must appear together. The path is looked up by the
native API, then the returned entry's hash and class are checked. Supported
classes are quest, phase, objective, subobjective, phone choice, and phone message. Optional `questHash`
checks the ancestor quest as well. Hash lookup without a path is supported;
reviewed full paths are useful where source joins need stronger disambiguation.
An alias such as `city.jake.gift` requires no invented hash. Optional
`expectedHash` checks a truly known native hash; otherwise the exact native path
and class select the entry. The observed hash is recorded in capture evidence.

Captures exceeding the bridge's 256 KiB byte budget fail closed rather than
truncate a condition's evidence. At most 32 observed active quest keys are sent
as ranking hints; journal/fact observations remain complete for the selected
inventory. The adapter reads no localized descriptions, future objectives,
dialogue, or scraped text. If an empty `activeQuestKeys` list would serialize as
`{}` in CET, it is omitted; the bridge normalizes absence to `[]`.

## What a fact read establishes

Native `GetFactStr(name)` returns a signed `Int32`. A successful nonzero read is
a known value. Missing, throwing, nonintegral, boolean, string, and out-of-range
results are unknown.

Zero from `GetFactStr` is always emitted as
`{status: 'unknown', reason: 'fact-zero-presence-unknown'}`. Knowing that a fact
name appears in a shipped quest graph does not prove the current save contains
it. A related completed journal objective does not make an ambiguous zero known.

A future independently verified native presence source can be injected through
`adapter.readFact(name, generation)`, returning `value, proof`, where proof must
contain all of:

```lua
{status='verified', fact=name, value=0, generation=currentWorldGeneration,
 worldToken=currentWorldToken, sourceId='independent-native-presence-source',
 evidenceRefs={'receipt-identifying-this-current-save-observation'}}
```

**The default game adapter has no such presence source and never returns this
proof.** This seam exists for a future qualified implementation and tests. It
must not be satisfied from a cached save file, extracted symbol, comparator,
`GetFactStr` success, or a guessed default. Receipts are bound to both generation
and activation token.

## Journal visibility and lifepath

The native adapter admits only `Active`, `Succeeded`, and `Failed` entry states.
It follows the complete bounded parent chain to a quest and requires every
ancestor to be in those revealed states too. Inactive entries/ancestors, missing
parents, cycles, depth overflow, class/hash mismatches, and nonquest entries
produce unknown observations. This is deliberately conservative where unusual
quest assets hide a parent while retaining a child state.

For quest entries, `IsEntryVisited` is not used: opening a UI entry does not establish witnessing,
participation, or another character's knowledge. A succeeded objective is only
a succeeded objective; interpreting it as a relationship or decision requires
the separately reviewed native mapping.

The narrow phone selector additionally accepts exact `gameJournalPhoneChoiceEntry`
paths only when the choice is `Succeeded` and visited. In the inspected native
`messengerDialogView.script` `ActivateReply`, all unchosen replies become visited
and `Inactive`, while the selected reply becomes visited and `Succeeded`. Visited
alone is never selection evidence. Exact `gameJournalPhoneMessage` paths may be
`Active` or `Succeeded`, including unread messages. Both types require a bounded
active/succeeded phone conversation/choice-group chain ending at a known
`gameJournalContact`. Hidden parents, unselected choices, failed messages and
unknown contacts remain unknown. No phone title or message text is read.
These are narrow sent/received journal receipts, not proof that a report's claim
is objectively true; the mapping must preserve that distinction. Phone capture
is source-backed and VM-tested; live qualification remains pending.

Some verified quest branches retire a used `gameJournalPhoneChoiceGroup` to
Inactive after V sends the report. Only those selectors may set
`allowRetiredChoiceGroup: true` with nonempty `retiredGroupEvidenceRefs`, each
also present in the selector's reviewed native `evidenceRefs`. This permits an
inactive group ancestor only under a Succeeded+visited choice leaf. It never
permits an inactive/unselected leaf or hidden conversation/contact. The mapped
Regina report rules additionally require her exact matching reply to be active
or succeeded; the receipt remains a report, not independent victim-fate proof.

Lifepath comes from the loaded player's `PlayerDevelopmentSystem.GetLifePath`,
compared with the native `Nomad`, `StreetKid`, and `Corporate` enum values.
Invalid, unsupported/modded, missing, or throwing results remain unknown. The
adapter does not read character-creation UI state or the latest save on disk.

## Native source evidence

Inspected local source snapshot:
`vendor/reference-game-scripts`, commit
`fce9ab7e6a608b0d729290d898003589515900e1`.

- `scripts/core/systems/journalManager.script`, lines 409–427: native
  `GetParentEntry`, `GetEntry(Uint32)`, `GetEntryByString(String,String)`,
  `GetEntryState`, signed `GetEntryHash`, and `HasAnyDelayedStateChanges`.
- Same file, `JournalQuest`, `JournalQuestPhase`, and
  `JournalQuestObjectiveBase` class declarations establish supported hierarchy.
- `scripts/cyberpunk/UI/fullscreen/codex/codexUtils.script:504` and
  `scripts/cyberpunk/UI/interactions/looting.script:826` demonstrate
  `gameJournal...` class names in native string-path lookups.
- `scripts/cyberpunk/systems/playerDevelopmentSystem.script:4088`:
  exported `GetLifePath(owner)` reads that owner's development data and returns
  `gamedataLifePath.Invalid` when it is absent. Its existing progression branches
  compare `StreetKid`, `Nomad`, and `Corporate`.
- `scripts/core/systems/questSystem.script:25`: native
  `GetFactStr(factName: String): Int32`.
- The existing project `mod/quest-context.lua` and its earlier live evidence use
  CET `Game.GetJournalManager`, `GetEntryState`, `GetEntryHash`, and ancestor
  lookup. `GAME_DATA_AUDIT.md` documents `QuestsSystem.GetFactStr` and the absence
  of a verified runtime fact-presence enumeration API.

Source-backed signatures and VM tests do **not** constitute live-game acceptance
of this new adapter. The parent should inspect one installed ready snapshot,
including actual journal state/hash and lifepath, before treating the integration
as live-verified. No installation, diagnostics request, game mutation, save-file
change, or cloud write was performed by this module's implementation task.

## Verification

Run:

```powershell
node --test bridge/world-knowledge-capture.test.mjs
```

Tests execute the real Lua module through Fengari and pass an actual emitted
snapshot through the bridge parser. They cover ambiguous zero and independent
presence proof, revealed/hidden/completed journal state, signed hashes and full
paths, ancestor bounds/cycles, per-update work budgets, selection and byte caps,
world generation/activation changes, mid-read unload, sampling-window expiry,
native failures, clock regression, immutable per-audience capture, and missing
identity. Native objects remain inside adapter call frames; all retained data
is bounded plain selector/observation data.
