# General revealed quest history

This layer covers quests even when no reviewed decision mapping exists. It
captures **V's actual revealed journal**, including active, succeeded and failed
quests and their revealed objective text/status. It does not convert quest
completion into a particular decision, infer optional outcomes, or produce
long-term memory events. The reviewed world-knowledge rules remain the source
for precise choices, relationships and character-specific knowledge.

## Files and integration API

- `mod/journal-history.lua`: native read-only background collector.
- `bridge/journal-history.mjs`: bounded parser and relevance selection.
- `bridge/journal-history.test.mjs`: real Lua execution and bridge tests.

```lua
local history = dofile('journal-history.lua').new({
    currentGeneration = function() return worldGeneration end,
    currentWorldToken = function() return activationToken end
})

-- Existing gameplay update hook, once per frame:
history:update({generation=worldGeneration, worldToken=activationToken})

-- Each outgoing request or a bounded local status publication:
local snapshot = history:capture({generation=worldGeneration, worldToken=activationToken})

-- On session end, before loads/new game, and CET teardown:
history:reset()
```

Generation is the world/load generation, not a conversation counter. Use the
same generation and activation token as `world-knowledge.lua` and the save
identity coordinator. Capture and update check both bindings before and after
native work. Missing or dead player, pregame, queued journal changes, native
readiness errors and backward clock jumps clear all inventory state.

The collector's `now` injection is **Unix seconds**, defaulting to `os.time`.
Unlike the reviewed-fact collector's lease-only clock, these timestamps cross
the bridge and must be comparable to `Date.now()`. Do not inject an elapsed-time
counter here. Whole-second default clock resolution is reflected in freshness
checks; the bridge tolerates at most one second of future timestamp skew.

```js
import {selectJournalHistory} from './journal-history.mjs';

const result = selectJournalHistory({
  snapshot: input.journalHistory,
  generation: currentWorldGeneration,
  worldToken: currentActivationToken,
  profileKey: input.profileKey,
  query: input.text,
  questCatalog: reviewedQuestCatalog,
  maxChars: 6000,
});
// result.context -> append to dynamic conversation context when nonempty
// result.events is ALWAYS []; do not insert generic journal text into memory.
```

`parseJournalHistory(value)` accepts a JSON string or plain object and returns
normalized ready/unavailable data. `journalHistoryContext(snapshot, options)`
is a convenience returning the selected context string. Optional context must
not prevent a user's chat message from being sent if native capture is missing.
The existing fast tracked-quest adapter can remain available while initial
background history collection is incomplete.

## Native reads and bounded scheduling

Two independent lanes run:

| Lane | Native filter | Refresh after completed scan | Default observation age |
|---|---|---:|---:|
| Active | Active only | 2 seconds | 5 seconds |
| History | Succeeded and Failed | 30 seconds | 180 seconds |

Every update performs at most one root or child page, with eight entries per
page by default (configurable 1–32). History receives every fourth busy update;
when active work is idle, history uses the available updates. Native arrays and
weak entry handles exist only inside the current adapter call. Across frames,
the collector retains hashes, strings, cursors and plain observed data.

The engine API `GetQuests`/`GetChildren` returns a complete native array; it has no
documented pagination parameter. The adapter reacquires it and reads a bounded
slice, then releases it. Thus descriptor reads are bounded, but the underlying
native array-return cost is not a hard wall-clock guarantee. Initial live
qualification must inspect timing on a large save. No native mutation or new
redscript is needed for this implementation.

Nodes are reacquired by their observed unsigned hash. Each child read verifies
the current revealed ancestor chain to the same quest; a hidden phase's active
descendant is not traversed. GetEntryHash is normalized from signed Int32 to its
Uint32 representation. Full native paths are reconstructed from actual parent
`GetId()` values, preserving the `ep1` root when present and omitting only empty
root IDs. Objective paths are explicitly named `questRelativePath`; they are
not guessed global resource paths. Local `GetId()` is never treated as globally
unique; the native hash remains the entry identity.

Only quest/phase/objective/subobjective structure is traversed. Codex, map pins,
phone messages, inactive branches and future objective text are not exported by
this layer. Titles and objective text use `GetLocalizedText`. Missing
localizations, native exceptions, cycles, depth limits and cap hits mark coverage
partial instead of inventing a successful empty result.

Bounds per lane: 1024 quest rows by default (maximum 2048), 8192 traversal nodes
(maximum 16384), 4096 objectives (maximum 8192), 128 objectives per quest (maximum
256), 12 traversal levels (maximum 16), and an approximate 1.5 MB retained-data
budget. Captured input is separately limited to 4 MiB and 4096 quests/16384
objectives at the bridge. Oversized or malformed input fails closed.

## Freshness and coverage meaning

Each snapshot contains `generation`, `worldToken`, `capturedAtMs`, separate lane
coverage and the latest observed quest/objective rows. Tracking is independently
`known`, `untracked`, or `unknown`. A failed tracking read is never `untracked`.

Lane coverage is `pending`, `partial`, `complete`, or `expired`. During the first
scan, already-read positive observations may be published with `scanning:true`,
partial inventory and incomplete objective sets. A previous completed inventory
may remain available during refresh only within its lease. Expired active data
is omitted, even if it was encountered during the slower history scan. When
both lanes contain a quest, the later observation wins.

Coverage includes the sampling window, observed root count, the native page
total where available, omitted work and detected ordering/count instability.
`complete` means the bounded traversal finished without an observed omission;
it is **not** an atomic database snapshot or proof of every quest ever shipped.
Root arrays can change while the world runs. Count changes and duplicate entries
are reported, but absence never establishes an outcome even after a complete
scan. Loading another save invalidates both lanes immediately.

The bridge requires the expected generation. When either side has an activation
token, both must match exactly. Publication older than ten seconds is rejected.
Per-row/lane ages are checked again with hard upper bounds of 15 seconds for
active data and 300 seconds for historical observations. The native defaults
are stricter. These are explicitly dated observations, never a claim that all
fields were read simultaneously.

## What reaches a character

The bridge ranks only relevant rows: the tracked quest, active jobs, query
matches in titles/objectives, and quests associated with this profile in the
reviewed catalog. Catalog title matches can help **ranking only**; they do not
establish branch identity or a character's participation. Queries never create
facts. Unrelated completed history is excluded.

At most six quests and sixteen objectives per selected quest reach the prompt,
subject to a hard 6000-character default budget (maximum 12000). Each JSON item
is included whole; no instructions or JSON are cut midway. The document reports
how many objectives were observed and whether the displayed subset is complete.
The parser strips unexpected fields and keeps game text quoted as data.

Prompt framing states that this is V's shared journal, not eyewitness memory.
A quest or objective marked Succeeded is not proof of a victim's fate, a romantic
relationship, a hidden branch, or the truth of every phrase in an objective.
Missing and omitted entries remain unknown. Reviewed decision context must
remain authoritative wherever it supplies a more precise interpretation.

No arbitrary completed quest is promoted into Convai memory through this layer.
Precise stable events still require reviewed native mappings, audience rules,
branch identity and checkpoint qualification in the memory subsystem.

## Source evidence and verification

Inspected `vendor/reference-game-scripts` commit
`fce9ab7e6a608b0d729290d898003589515900e1`:

- `scripts/core/systems/journalManager.script`: `JournalRequestContext`, state
  filter fields, `GetQuests`, `GetChildren`, `GetEntry`, `GetEntryHash`,
  `GetParentEntry`, `GetTrackedEntry`, quest/title and objective/description APIs.
- `scripts/cyberpunk/UI/fullscreen/quest_log/questLog.script:152–161`: the game
  requests active quests and separately appends Succeeded and Failed entries.
- `scripts/cyberpunk/UI/fullscreen/quest_log/questLogUtils.script:GetDescriptions`
  explicitly excludes Inactive while including Active/Succeeded/Failed.
- `scripts/cyberpunk/UI/fullscreen/quest_log/questLogDetailsPanel.script:155–160`
  and `questLogElements.script:300` localize description strings.
- Existing `mod/diagnostics.lua` uses the same CET `JournalRequestContext.new`
  construction and tuple-return handling for native journal arrays. Direct
  GetQuests live qualification for this module remains pending.

Run `node --test bridge/journal-history.test.mjs`. Tests execute the real Lua
module, validate emitted snapshots with the JS parser, and cover bounded paging,
partial inventories, hidden descendants, completed states, paths, stale loads
and activations, lease expiry, native failures, cycles/caps, query/profile
selection, complete JSON budgets, and unknown-versus-untracked behavior.

Implementation tests do not claim live-game acceptance. This task installed no
files, emitted no diagnostics request, changed no saves, called no cloud API,
and created no commit.
