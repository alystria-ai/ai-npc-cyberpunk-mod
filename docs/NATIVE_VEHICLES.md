# Native vehicle group (systems `vehicles`, `chauffeur`, `passage`)

Port of systems 4, 8 and 9 in `docs/NATIVE_PORT_BRIEF.md` to the native core (`native/core/src/systems/`).
Status: built and tested headless (parity replay and shim tests). **Not yet run in the game**: every
game call below is a name looked up through RTTI at run time, so the in-game checks at the end are the
first real proof. A function that does not exist makes the plugin answer "unavailable" and the Lua
keeps running its own code.

**"Passage car" means a lift car (an elevator cabin), not a vehicle.** `passage` finds a standing spot
for a companion inside an elevator car. It reads no vehicle seats and never touches `vehicles`.

## What moved

| Lua entry point | Native | Cost it replaces |
|---|---|---|
| `mod/companion-vehicle-native.lua` `M.inspect(vehicle)` | `ConvaiNativeVehicles.Inspect(entity, owned)` | about 58 CET calls and 35 property reads per car: attached, vehicle, destroyed, AI component, record id, the seat set (`VehSeats`), `HasOccupantSlot`, the mounting info and `IsSeatReserved` of each kept seat, velocity, player gap, player mounted, scene |
| `M.mounting(entry)` (the not-mounted answer) | `ConvaiNativeVehicles.Mounting(npc)` | `IsAttached`, `GetMountingFacility`, `GetMountingInfoSingleWithObjects` and the property reads |
| `mod/companion-chauffeur-native.lua` `M.sample(player, entry, leasedCar, api, operation)` for a leased car | `ConvaiNativeChauffeur.Sample(...)` | 80-120 CET calls, ten times a second while a trip runs: actor validity, player state, car checks, the AI command reads, the AutoDrive system, the tracked destination and its map pin |
| `M.inspectDrive(car, operation)` (also behind `retarget`, `stop`, `brake`, reload cleanup) | `ConvaiNativeChauffeur.Drive(...)` | about 30 CET calls: AI component, three command lookups, five Boolean reads, reservations, the command state, path telemetry |
| `mod/companion-passage.lua` `M.carSpot(...)` | `ConvaiNativePassage.CarSpot(...)` | up to 24 query units per update: floor rays (3 per candidate), wall rays (2), a 6-group body overlap, about 40 `Vector4.new` / `CName.new` / query calls |

Each is one native call. The game's own physics queries still run the same number of times; only the
CET marshalling goes.

What stays in Lua on purpose:

- vehicles: the **mounted** answer of `M.mounting` (its parent `EntityID` is a CET object; the plugin's hash and seat are still compared with the Lua's every time, for free) and a detached entity (the original re-resolves the handle).
- chauffeur: the start-of-trip selection of the owned car (`nearbyOwnedCar`, a targeting query), the blackboard summon reads, the mounting reads (the `vehicles` plugin answers those), the localized waypoint name, `IsCommandActive` (an overloaded game function), the lease's record-id string check, `start`, `retarget`, `stop`, `brake`, `disable` (they act on the game, and are rare).
- passage: the search state (candidate list, next index, car floor) and the per-update query budget (`clearance.newBudget` and friends), as in the clearance port.

World policy: the plugin never enumerates anything. Lua passes only the car the mod made or the
chauffeur leased, and companions it spawned. Ordinary NPCs, game-placed characters and the player's
own driving are never inspected.

## Files

- `native/core/src/systems/vehicles/`: `core/VehiclesCore.*` (decisions and wire text), `VehicleReflect.*` (name-based game calls shared by the group: a cached function per call site, a return value with the right lifetime, global-system and static-function helpers), `VehiclesGame.*`, `VehiclesNatives.cpp`.
- `native/core/src/systems/chauffeur/`: `core/ChauffeurCore.*`, `ChauffeurGame.*`, `ChauffeurNatives.cpp`.
- `native/core/src/systems/passage/`: `core/PassageCore.*` (the search loop over `clearance::Probe`, the same interface and `CheckBody` that `clearance` uses), `PassageNatives.cpp` (uses `clearance::GameProbe`).
- Tests: `native/core/tests/{vehicles,chauffeur,passage}_tests.cpp`, `Wire.hpp`, fixtures `vehicles-inspect.json`, `vehicles-mounting.json`, `chauffeur-sample.json`, `chauffeur-drive.json`, `passage-carspot.json`.
- Recorders and shim tests: `bridge/native-recorder.mjs` (shared helpers), `bridge/companion-vehicle-native.test.mjs`, `bridge/chauffeur-native-parity.test.mjs`, `bridge/companion-passage-native.test.mjs`. A recorder runs the ORIGINAL Lua against a fake game and writes the raw reads and the wire text; the committed fixture must equal the Lua's output, so a Lua change that breaks parity fails `npm test`. `CONVAI_WRITE_FIXTURES=1` rewrites them.
- Lua changes: each module got an "Optional native path" section at the end; `companion-clearance.lua` gained `M.remaining`, `M.spend(used, deferred)` and `M.spent()`; `companion-passage.lua` got its candidate builder split out (`buildCandidates`, same code); `companion-chauffeur-native.lua` got `nameFrom` split out of `destinationName` (same code).

## Wire formats

Space-separated tokens. Flags are 0/1, ids are decimal hashes (0 = nil; the shim appends CET's type
suffix, read once from a real hash), numbers are `%.17g` with the words `nan`, `inf`, `-inf`, and `-` is
a nil number or text. The grammar lives in the `*Core.hpp` headers; the fixtures hold the text for
every recorded case.

- **vehicles**: `V <status>` (0 not a vehicle, 1 no AI, 3 detached) or `V 2 <invalid> <aiPresent> <playerMounted> <scene> <speed> <playerGap> <seatCount>` then `<name> <occupant> <reserved>` per seat. `M -` (not mounted) or `M <parentHash> <seat>`.
- **chauffeur** `Sample`: sections `A P C [D] U W` (D only when the leased car is live; S, the summon read, stays in Lua). `A <attached> <dead> <valid> <calm>`, `P <id> <passenger> <combat>`, `C <live> <id> <carValid> <posValid> <x> <y> <z>`, `D 0|1|2` (AI missing, control information unreadable, no command identity) or `D 3 <ready> <reservations> <busy> <foreign> <ownedActive> <state> <commandId> <currentId> <remaining> <currentClass>` (state `-` none, `?` ask `IsCommandActive`, else 0-6), `U <enabled> <delamain> <available> <laneValid> <destType> <freeRoam> <remaining> <vehicle> <destId>`, `W 0` or `W 1 <id> <px> <py> <pz> <mx> <my> <mz> <quest> <rawName>` (the raw name is the rest of the text). A section the plugin could not read is `<tag> !`. `Drive`: `0` (not the live leased car), `1 D ...`, or `""`.
- **passage**: `<status> <used> <deferred> <index> <hasFloor> <floor>` then ` x y z` (0 spot), ` reason` (1 none: 1 no-car-floor, 2 physics-unavailable), nothing (2 pending); `4 <used> <code>` is a failed game call.

Behaviour is the Lua's: the decision logic is a line-for-line port and the fixtures replay the recorded
Lua outputs (`chauffeur`: 49 sample cases and 42 drive cases covering every actor, AutoDrive, destination
and command-state branch; `passage`: 50 cases, 66 updates, every outcome and budget wait; `vehicles`:
every status and the Mackinaw seat rule).

## Safety

- Kill switches: a line `vehicles`, `chauffeur` or `passage` in `runtime/native-off.txt`, or `convaiNative.off('<name>')` / `convaiNative.on('<name>')` in the CET console. Three faults inside a system's natives switch that system off.
- An unreadable answer or a throwing native calls `convaiNative.fail('<name>', ...)`: the module stays on Lua for the session and probe.log says why. An answer of `""` (or, for chauffeur, a section marked `!`) runs the original for that call; 20 such answers in a row from the same entry point also fail the system. `passage` runs the plugin's own queries once in the world (`SelfTest`, shared with `clearance`) before its first use and retries while there is no world.
- Verify: the first 8 answers of each entry point run BOTH paths and compare them (`passage` also compares the queries charged to the budget); any difference calls `convaiNative.fail`, logs the first differing field to probe.log (`Native core: <name> MISMATCH ...`) and returns the Lua's answer. `convaiNative.vehiclesVerify`, `chauffeurVerify` and `passageVerify` set to `true` keep comparing every call. Counters: `convaiNative.vehiclesStats`, `chauffeurStats`, `passageStats`; `ConvaiNativeVehicles.Stats()`, `ConvaiNativeChauffeur.Stats()` and `ConvaiNativePassage.Stats()` print the plugin side.
- The mounted answer of `vehicles.mounting` is the Lua's, with the plugin's hash and seat cross-checked on every call.
- Behaviour differences by design: none in results. The chauffeur caches a car's display name per record id (the Lua looked it up on every sample); a record that is missing or has no type makes the plugin fail the section so the Lua runs and throws exactly as before.

## Estimate (not measured)

From the call counts and the 25 microseconds per CET call of the 2026-10-12 perf probe
(`docs/NATIVE_REWRITE_PLAN.md`):

| Entry point | Calls before -> after | Saved | When it runs |
|---|---|---|---|
| `vehicles.inspect` | about 58 + 35 property reads -> 2 | about 1.4 ms a call | once per tick of a chauffeur trip (10 Hz), and whenever seats are managed |
| `vehicles.mounting` (not mounted) | 3 + reads -> 1 | about 0.05-0.1 ms a call | twice per chauffeur sample |
| `chauffeur.sample` (leased car) | 80-120 -> about 12 | 1.7-2.7 ms a sample (the inner `inspect` and `inspectDrive` included) | 10 Hz during a trip: about 17-27 ms/s |
| `chauffeur.inspectDrive` | about 30 -> 4 | about 0.65 ms a call | retarget, stop, brake, reload cleanup; once per sample |
| `passage.carSpot` | up to 40 -> 1 | up to 1 ms an update | each update while a companion boards a lift car (seconds at a time) |

Outside a chauffeur trip and a lift boarding these systems do not run, so the idle frame cost is
unchanged (no new per-frame work was added: the shims run only when their entry point is called).
The native side itself costs about 1-5 microseconds per call plus the game's own function calls.

## In-game checks

1. Install the plugin build (`dist\native-core\CyberpunkConvaiNative.dll`) and the Lua, start the game, load a save with a companion. probe.log: `Native core: vehicles=native`, `chauffeur=native` and `passage=native` appear the first time each module runs.
2. **vehicles**: ride in a car with a companion (or let the chauffeur offer a ride). `convaiNative.vehiclesVerify = true`, play a minute, then `print(convaiNative.vehiclesStats.compared, convaiNative.vehiclesStats.mismatches)`: mismatches must be 0. A line `vehicles inspect matched the Lua 8 times, now native` shows the plugin was trusted. `ConvaiNativeVehicles.Stats()` shows `inspectReady` counting up.
3. **chauffeur**: ask a companion to drive you to a map pin. Watch probe.log for `chauffeur sample matched the Lua 8 times, now native` and `chauffeur inspectDrive matched the Lua 8 times, now native`. During the trip: change the pin (retarget), stop the trip, brake, leave the car. With `convaiNative.chauffeurVerify = true` check `print(convaiNative.chauffeurStats.compared, convaiNative.chauffeurStats.mismatches)` is 0; read any `MISMATCH` line (the first differing field is named). Also try a Quest objective as the destination. `ConvaiNativeChauffeur.Stats()` shows `sampleFailedSections` (should stay 0: a non-zero value names a game function that does not exist in this build).
4. **passage**: take a companion into an elevator (Dogtown or Afterlife lifts). probe.log: `passage self-test passed`, then `passage carSpot matched the Lua 8 times, now native`. The companion must stand beside you in the car as before. `passageStats.mismatches` must be 0.
5. **A/B for each system**: Developer mode on, do the same 60 s (a trip, a lift ride), read `runtime/perf-probe.json` rows `vehicles.inspect`, `vehicles.mounting`, `chauffeur.sample`, `chauffeur.inspectDrive`, `passage.carSpot`; then `convaiNative.off('<name>')` in the console (flip it mid-session, no restart), repeat the same activity, compare the same rows, and `convaiNative.on('<name>')` to restore. The two paths give the same behaviour; only the row times differ.
6. If anything looks wrong, `convaiNative.off('<name>')` returns that system to Lua at once, and the probe.log lines say which call failed.
