# Native clearance queries (system `clearance`)

Port of `mod/companion-clearance.lua` and the two spatial raycasts of `mod/companions.lua` to the
native core (`native/core/src/systems/clearance`). Recipe: `docs/NATIVE_PORT_BRIEF.md`, system 3.

## What moved

| Lua entry point | Native | Cost it replaces |
|---|---|---|
| `clearance.body(feet, dimensions)` | `ConvaiNativeClearance.Body` | 16 CET calls (3 constructors, `GetSpatialQueriesSystem`, 6 `CName.new`, 6 `Overlap`) |
| `clearance.segment(from, to, dimensions, progress, projection)` | `Segment` | 15 CET calls per box (2 `Vector4.new`, `GetSpatialQueriesSystem`, 6 + 6) plus 3 for the rotation |
| `clearance.recheck(rejection)` | `Box` | as body |
| `clearance.sightClear(from, to)` (was inline in `companions.visibleFromCrosshair`) | `Sight` | 2 `Vector4.new`, 6 `CName.new`, 6 raycasts, `GetSpatialQueriesSystem` |
| `clearance.floorZ(at, maxDrop)` (was inline in `companions.floorBelow`) | `Floor` | `GetSpatialQueriesSystem`, 2 `Vector4.new`, `CName.new`, 1 raycast |

Each check is one native call. The game's own `Overlap` and raycast still run once per group, so
the physics work is unchanged; only the CET marshalling goes. `Segment` runs every box of a leg in
the one call and stops at the budget exactly as the Lua did.

What stays Lua: the per-update query budget (`newBudget`, `useBudget`, `available`, `take`: a plain
table shared by several `dofile` copies), `profile`, `segmentBoxes`, `isPoint`, and every decision
that uses a result. The shim passes the plugin what is left of the budget and adds the queries the
plugin reports to `budget.used` (and counts `budget.deferred` for a deferred box).

World policy: the natives take coordinates only. Nothing here enumerates NPCs or picks targets.

## Files

- `core/ClearanceCore.hpp/.cpp`, `ClearanceMath.cpp`, `ClearanceFormat.cpp`: pure logic and the wire text, tested headless against a fake `Probe`.
- `ClearanceGame.hpp/.cpp`: the `Probe` over `SpatialQueriesSystem` (`Overlap`, `SyncRaycastByCollisionGroup` through `RED4ext::ExecuteFunction`, every parameter supplied) and `SelfTest`.
- `ClearanceNatives.cpp`: registration of `ConvaiNativeClearance` and `CONVAI_SYSTEM(clearance, ...)`.
- `tests/clearance_tests.cpp`, `tests/fixtures/clearance-boxes.json`, `clearance-rays.json`: parity replay.
- `bridge/companion-clearance-native.test.mjs`: the recorder (runs the original Lua, writes the fixtures with `CONVAI_WRITE_FIXTURES=1`) and the shim checks.

## Wire format

Every native returns one String of space-separated numbers (the grammar is in `ClearanceCore.hpp`).
`"<status> <used> ..."`: status 0 clear, 1 blocked (group, centre, half extents, rotation, and for a
segment the box and box count), 2 deferred (segment: the box to resume at), 3 unavailable (invalid
input), 4 fallback (a game call failed), 5 geometry (route too long or too steep, no query made).
Doubles are `%.17g`. The fixtures hold the text for every recorded case; the shim test feeds it
through the shim and requires the original results, budget and cursor.

## Safety

- Kill switch: a line `clearance` in `runtime/native-off.txt`, or `convaiNative.off('clearance')` / `convaiNative.on('clearance')` in the CET console. Three faults inside the natives also switch it off.
- A native that raises, answers unreadably or reports a failed game call (status 4) calls `convaiNative.fail('clearance', ...)`: the module stays on Lua for the session and probe.log says why. Queries the plugin already made are still charged to the budget.
- Before the first native use the shim runs `SelfTest` (a speck of sky must hit nothing in any group, a 30 m box and a ray down from V must hit something) and compares the plugin's box orientation with `Quaternion.ToEulerAngles(Quaternion.BuildFromDirectionVector(...))` for eight directions. Any difference keeps the Lua path. No world yet (`wait`) retries every 2 s, and fails after five waits.
- Arguments the plugin does not take (a non-finite rotation, a fractional cursor) run the original Lua without switching anything off. Invalid positions and shapes are answered like the Lua (`false`, "could not verify...", `{unavailable=true}`) without a native call.
- Behaviour differences by design: none in results. A non-Boolean `Overlap` answer cannot occur natively; a failed call falls back to the Lua path instead of reporting "could not verify".

## Verify mode and statistics

- `convaiNative.clearanceVerify = true` (CET console): every call runs BOTH paths, returns the Lua answer, and logs `Native core: clearance MISMATCH in <fn>: ...` to probe.log for any difference in result, rejection group/box, queries spent or segment cursor (first 20), plus a summary line every 250 calls.
- `convaiNative.clearanceStats` = `{native, lua, fallback, compared, mismatches}`.
- `print(ConvaiNativeClearance.Stats())`: native call counts, queries, and the time spent inside the game's own query calls (`micros`, `maxMicros`).
- Developer mode (perf-probe) times `clearance.body`, `clearance.segment`, `clearance.recheck`, `clearance.sightClear` and `clearance.floorZ`.

## Estimate

From the call counts and the measured CET cost of 10-60 microseconds a call (`docs/NATIVE_REWRITE_PLAN.md`): 0.15-0.9 ms saved per 2 m box. While walking the perf plan measured 30-60 `Overlap` calls a second per companion (5-10 boxes): about 3-5 ms/s per walking companion. A frame that spends the full 192-query budget (32 boxes) saves roughly 5-28 ms of CET calls. The native side measured headless at 0.11 microseconds for a body check plus a 3-box segment (without the game's queries). The first in-game numbers are the A/B below.

## In-game check

1. Install, restart the game, load a save. probe.log: `Native core: clearance=native (plugin 0.1.0, api 1)` once a companion exists, then `clearance self-test passed`.
2. Verify mode: console `convaiNative.clearanceVerify = true`; invite a companion in a room with furniture, walk through a door, and drive a short distance. After a minute: `print(convaiNative.clearanceStats.compared, convaiNative.clearanceStats.mismatches)`. Mismatches must be 0 (a car or NPC moving between the two runs can cause the odd one; read the logged detail).
3. Turn verify off (`convaiNative.clearanceVerify = false`) and play normally: companions place, walk, stop at doors and squeeze through gaps as before.
4. A/B: Developer mode on, walk 60 s with the companion following, read `runtime/perf-probe.json` rows `clearance.segment` and `clearance.body`; then `convaiNative.off('clearance')`, repeat the same walk, compare; `convaiNative.on('clearance')` to restore.
