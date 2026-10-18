# Companion vehicles

## Requested behavior

V's current road vehicle gets the first available passenger seats. Remaining
managed companions share additional cars. An unassigned companion with a
source-backed personal model gets preference as the next driver; the other
unassigned people fill that car before another is created. Capacity comes from
the installed vehicle and its current occupants, including seats reserved by
native AI. Ordinary passenger joining does not allocate the driver seat in V's
car. An explicitly accepted chauffeur request leases that seat to the selected
companion and waits for V to enter a passenger seat manually; see
[Companion chauffeur](COMPANION_CHAUFFEUR.md).

For example, eight companions beside a four-seat car use three seats beside V,
four seats in the first overflow car, and the driver seat in a second overflow
car. A two-seat car beside V offers one passenger seat. Panam's and Claire's
Mackinaw record has a known three-seat exception, so neither is counted as a
four-seat car.

This subsystem operates only on copies already owned by `companions.lua` and
new, tagged, nonpersistent vehicle copies. It does not assign roles to quest
NPCs, change garage ownership, persist vehicles, or recreate the party after a
save reload. An explicitly observed fast travel request carries the current
party's model, conversation profile and copy serial to its destination. Existing
managed copies are reacquired and relocated after the world returns. A copy
whose old managed entity no longer exists may be recreated through the normal
floor and clearance checks. This permission exists only for that fast travel;
ordinary save restoration, death, and unarmed detach discard it.

## Files and ownership

| File | Responsibility |
| --- | --- |
| `mod/companion-vehicles.lua` | Allocation, state transitions, bounded retry, walking handoff, cleanup, cached diagnostics |
| `mod/companion-vehicle-native.lua` | Mounted-seat sensing, physical clearance, Codeware spawn/delete, exact command handles, native driving and fast-travel relocation |
| `mod/companion-vehicle-catalog.lua` | Explicit source-backed character/car/appearance pairs and ordinary fallback |
| `bridge/companion-vehicles.test.mjs` | Executable Lua state and native-boundary tests with delayed native completion |
| `bridge/companion-vehicle-integration.test.mjs` | Real companion update, equipment handoff, delayed deletion, transit identity, and safe recovery tests |

`companions.lua` remains the authority for actor identity and lifetime. The
vehicle controller owns a person's movement between a successful release of
walking/equipment commands and the resume callback. It owns only vehicle entity
IDs created by its adapter, plus each exact mount, unmount, and follow command
handle. Ordinary passenger joining never drives, brakes or deletes a borrowed
primary car. The chauffeur controller may drive and retire its exact owned
vehicle command after an explicit conversation request and fresh seat/route
checks. It never deletes the borrowed car or moves V between seats. V can use a
car created by the mod; regular carpool control yields to V, and deletion stays
prohibited while V occupies it.

## States and interruption rules

| State | Completion evidence | Interruption/failure |
| --- | --- | --- |
| On foot | No transport movement owner | A mounted road vehicle starts a journey |
| Releasing | Equipment and walking commands have terminal native states | Uncertain cancellation retains the current owner |
| Waiting for seat | Verified capacity, current occupancy, native reservation, and local reservation agree | Unknown capacity blocks overflow creation |
| Boarding | Actual parent vehicle/slot plus terminal mount command | Moving vehicle, scene animation, or combat postpones boarding |
| Riding | Actual mount remains in the assigned vehicle | A different vehicle finishes the exit transaction before replanning |
| Convoy | Every assigned occupant, including the driver, is actually mounted | Native command failure or 20 seconds stationary more than 45 m behind V cancels and retries |
| Exiting | Follow cancellation, stopped car, unmount completion, and no actual mounting | No walking command is resumed while native ownership remains uncertain |
| Recovering | Existing actor is unmounted, destination is walkable on V's floor, teleport submitted | Failed placement/attachment retains an explicit recovery error |
| Session abandoned | References cleared without native calls | No late callback or saved party is restored |

At most two mount/unmount/follow submissions occur per update. Boarding uses a
20-second deadline, exit uses 12 seconds, attachment uses 12 seconds. Each
boarding, exit, failed spawn/attachment, route, and recovery operation has at
most three attempts. Creation is serial: the controller inspects and fills one
new car before creating the next. The owned car count is a runaway guard, not a
party limit: at least eight cars (V's and seven more, seating 31 companions),
growing to two plus one car per four people travelling, so a party of any size
gets the cars it needs while a car that cannot seat anyone still stops creation.

Native `NotExecuting` is still an owned command state. Cancellation is sent once
for the exact handle; terminal state must subsequently be observed. A binding
error after `SendCommand` retains the handle. A failed cancellation cannot
silently grant walking to another controller. The diagnostic event list is
bounded to 32 entries.

Deleting a car requires its own creation receipt, the Codeware managed flag,
the `CyberpunkConvaiPartyVehicle` tag, no player, and no occupants. A car that
detached before occupant inspection is retained. Cleanup retries are bounded
and visible in the cached snapshot. The controller never dismisses an unknown
passenger to make a car deletable.

## Native API evidence

The local native script reference is commit
`fce9ab7e6a608b0d729290d898003589515900e1`, dated 2025-07-26. It is a source
reference, not evidence that an installed binding or animation has passed.
The reflected command layouts were checked against RED4ext SDK commit
`ad7277714ad30d6885d7050c5ba24fa0102f6920`.

| Use | Source and exact contract |
| --- | --- |
| Seat records | [VehicleComponent](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/fce9ab7e6a608b0d729290d898003589515900e1/scripts/core/components/scriptComponents/vehicleComponent.script), `GetSeats`: `GetRecord().VehDataPackage().VehSeatSet().VehSeats(out seats)`; each `VehicleSeat_Record.SeatName()` supplies the slot |
| Physical slots and occupants | [VehicleObject](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/fce9ab7e6a608b0d729290d898003589515900e1/scripts/core/gameplay/vehicles.script): `HasOccupantSlot(CName)`; `VehicleComponent.IsSlotOccupied` uses `GetMountingInfoSingleWithIds(emptyChildID, vehicleID, MountingSlotId)` and `childId`; native `GetFirstAvailableSlot` also tests `vehicle.GetAIComponent().IsSeatReserved(slotName)` |
| Actual mounting | `GetMountingInfoSingleWithObjects(npc)` returns `MountingInfo.parentId` and `slotId.id`; [reflected MountingInfo](https://github.com/WopsS/RED4ext.SDK/blob/ad7277714ad30d6885d7050c5ba24fa0102f6920/include/RED4ext/Scripting/Natives/Generated/game/mounting/MountingInfo.hpp) confirms the fields |
| Mount and unmount | `AIMountCommand`/`AIUnmountCommand`, `MountEventData`, `Copy()`, NPC AI `SendCommand`; [MountEventData reflection](https://github.com/WopsS/RED4ext.SDK/blob/ad7277714ad30d6885d7050c5ba24fa0102f6920/include/RED4ext/Scripting/Natives/Generated/game/MountEventData.hpp) includes `allowFailsafeTeleport` |
| Follow | [AIVehicleFollowCommand reflection](https://github.com/WopsS/RED4ext.SDK/blob/ad7277714ad30d6885d7050c5ba24fa0102f6920/include/RED4ext/Scripting/Natives/Generated/AI/VehicleFollowCommand.hpp), base `VehicleCommand`: target, spacing, stop flag, traffic options, `needDriver`, `useKinematic`; native `VehicleObject.GetAIComponent()` gives the command owner |
| Cancel | [AIComponent](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/fce9ab7e6a608b0d729290d898003589515900e1/scripts/core/components/aiComponent.script): `GetCommandState`, `StopExecutingCommand(cmd, success)`, `CancelCommand(cmd)`; [aiVehicle](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/fce9ab7e6a608b0d729290d898003589515900e1/scripts/cyberpunk/ai/Tasks/aiVehicle.script) cancels the vehicle's exact command in `InterruptVehicleCommand` |
| Stop before exit | `VehicleObject.ForceBrakesUntilStoppedOrFor(Float)`; native `WaitBeforeExiting` checks speed below 0.5 |
| Nonpersistent copies | [Codeware DynamicEntitySpec](https://github.com/psiberx/cp2077-codeware/blob/main/scripts/World/DynamicEntitySpec.reds): `recordID`, optional `appearanceName`, position/orientation, `persistState=false`, `persistSpawn=false`, tags; [DynamicEntitySystem](https://github.com/psiberx/cp2077-codeware/blob/main/scripts/World/DynamicEntitySystem.reds): CreateEntity, IsManaged, IsTagged, DeleteEntity |
| Ground and clearance | CET's `SyncRaycastByCollisionGroup(start,end,group,false/true,false/true)` (Boolean plus `TraceResult` return); native NPC `IsInVehicle` recovery code uses `SpatialQueriesSystem.Overlap(extents,position,EulerAngles,group,out trace)` |
| Fast travel intent and completion | [FastTravelSystem](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/fce9ab7e6a608b0d729290d898003589515900e1/scripts/core/systems/fastTravelSystem.script): `OnPerformFastTravelRequest` calls `PerformFastTravel`, which requires a registered point and a destination different from the `FastTRavelSystem.StartingPoint` blackboard value before `TeleportToNode`; `OnLoadingScreenFinished(value)` completes only for `true`. [CET Kit GameUI](https://github.com/psiberx/cp2077-cet-kit/blob/main/GameUI.lua) observes the request and completion methods |
| Fresh command reacquisition | `AIComponent.GetEnqueuedOrExecutingCommand(CName, Bool)` and `IsCommandActive(Uint32)` in the same native AI source allow a fresh component handle to be matched against an exact saved command ID. A different command ID is never cancelled |
| Confirmed deletion | [Codeware DynamicEntitySystem.cpp](https://github.com/psiberx/cp2077-codeware/blob/main/src/App/World/DynamicEntitySystem.cpp), `DeleteEntity`: marks the state deleted and starts despawning before returning true. Companion removal waits for `IsManaged(id)==false`; its original fleet receipt remains owned while despawn is pending |

The adapter requests animated mount and unmount (`isInstant=false`), preserves
native HLS checks, disables failsafe mount teleport, and never uses the neutral
occupant override. It asks native traffic routing to follow V with a real
driver and physical movement (`useTraffic=true`, `useKinematic=false`). These
flags are source-supported; the exact road-follow result still needs a live
game check. No broad vehicle component injection is installed.

Convoy follow A/B (Developer mode only, 2026-10-17): `runtime/convoy-follow-mode.txt`
holding `smooth` switches the same follow command to `useTraffic=false`,
`trafficTryNeighborsForStart/End=false`, `useKinematic=true`, and stacks a bike 3 m
per place instead of 8 (target still V's car). The file is read once per follow request
and only while Developer mode is on; anything else is the confirmed `default`. Kinematic
driving can clip through traffic, which is why it stays an A/B. To judge it, compare the
movement trace's convoy gap over a 2 km drive and capture the convoy at a junction.
The native [AIDriveFollowCommandHandler](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/fce9ab7e6a608b0d729290d898003589515900e1/scripts/cyberpunk/ai/commands/aiDriveCommandHandler.script)
also maps all ten follow fields into behavior arguments (lines 426-459),
confirming that the traffic and physical movement flags are consumed by the
native driving behavior.

## Car model evidence

These pairs come from a community vehicle database.
Its downloaded SHA-256 is
`DBA28847A86378415998CD208947635AB956102C1EB5BF1980BF8C4044DF8FC8`.
The names, records, and appearance parameters came from those rows; the
controller does not guess records by concatenating character names.

| Managed model | Vehicle record | Appearance |
| --- | --- | --- |
| Panam | `Vehicle.v_standard3_thorton_mackinaw_ncu_player` | `thorton_mackinaw_nomad_panams_truck` |
| Claire | Same Mackinaw record | `thorton_mackinaw_nomad_deathrace_01` |
| Judy | `Vehicle.v_standard25_villefort_columbus_player` | `villefort_columbus__basic_judys_van` |
| Kerry | `Vehicle.v_sport1_rayfield_aerondight_player` | `rayfield_aerondight__basic_kerry` |
| Johnny | `Vehicle.v_sport2_porsche_911turbo_player` | `porsche_911turbo__basic_johnny` |
| Rogue | `Vehicle.v_sport2_quadra_type66_player` | `quadra_type66__basic_rogue_01` |
| Ordinary fallback | `Vehicle.v_standard2_archer_hella_player` | Record default |

Preference follows the managed model key or original character record, never a
newly assigned conversation profile. A passenger with a personal car still
carpools when an earlier car has room. Record existence/type, mounted slots and
native vehicle AI are checked at runtime. The `_player` suffix does not add
these dynamic copies to V's garage.

The Mackinaw record identified by
`0x04201D05, 47` is limited to front-left, front-right and back-left. Panam's and
Claire's appearances both map to this same record. The adapter therefore
excludes back-right even if the generic record claims it, and also requires
`HasOccupantSlot` for every allowed slot. Native boarding animation for all
these appearance/seat combinations remains a live acceptance item.

River's `Vehicle.sobchak_vehicle` uses an authored quest vehicle template and
is not enabled as a preference. Jackie's motorcycles are not additional
carpool cars. No original quest-world car is acquired or altered.

### Alt Cunningham: a passenger, never a driver

Alt Cunningham (`Character.Alt`, key `alt-cunningham`) is a digital ghost. She
has no vehicle record in the game (no row in the vehicle database above, and
the game gives her no car in any quest), and a ghost behind a wheel is out of
character, so she gets no car of her own instead of the Hella. The catalog marks
her `passengerOnly` (by managed model key or original record, like the car
preferences, so a copy of her model keeps it under any chat profile):

- She rides along in V's car. Waiting passengers who never drive are seated
  first, so she takes a seat beside V before anyone who could drive an overflow
  car; everyone else keeps serial order.
- Overflow cars are driven only by a companion who drives. If she is the only
  one still waiting, no car is created for her (a car nobody drives is useless):
  she keeps waiting for a free seat, and the planner says
  "Waiting for a free passenger seat: this companion does not drive."
  A seat that frees up, or a party car that another companion drives, is hers.
  Alone and with no seat anywhere she stays on foot and follows V as any
  companion does when no seat exists.
- The chauffeur never offers her the wheel: the offer is refused with code
  `does-not-drive` before any native read (`docs/COMPANION_CHAUFFEUR.md`).

Tests: `bridge/companion-vehicles.test.mjs` (catalog choice, first seat in V's
car, seat in another companion's car, lone passenger-only companion) and
`bridge/companion-chauffeur.test.mjs` (the refused offer under any profile).
Not seen in the game.

## Placement and navigation limits

An overflow car is created only while V's car is nearly stopped. Four bounded
candidate offsets behind it are checked. Five footprint rays must find a
nearby, near-level supporting floor; a conservative body box must be clear of
static, dynamic, terrain, collider, destructible, vehicle and character groups.
This rejects unsupported ledges, another floor and occupied spawn volumes.
Waiting for V's car to stop defers creation without spending a spawn attempt;
the existing hard limit still applies to failed placement and attachment.
It does not prove that an arbitrary flat surface is a lane in the vehicle road
graph. Native traffic AI handles routing after spawn, with bounded failure and
stuck retries; the controller never teleports a convoy car through an obstacle.

The pedestrian fast-travel recovery uses the existing `companion-placement`
checks, including same-floor native navigation and separation between recovery
destinations. After the third failed placement the actor is handed back to
walking ownership (October 8), and the on-foot fast-travel arrival and catch-up
rules place it near V with an AI teleport
(docs/COMPANION_RECOVERY_TRANSACTIONS.md). There is no assumption that a
coordinate near V is a safe standing or driving point.

## Integration contract

`companions.lua` creates one controller for the companion session:

```lua
local vehicles = dofile('companion-vehicles.lua')
local fleet = vehicles.new()
local vehicleHooks = {
    release = function(entry)
        equipment.release(entry.equipment)
        if entry.equipment and entry.equipment.phase ~= 'released' then return false end
        return actuator.release(entry.motor)
    end,
    resumed = function(entry)
        entry.motor = actuator.new(entry.npc)
        entry.equipment = equipment.new(entry.npc)
        entry.person = behavior.new(entry.serial)
        entry.position = nil
    end,
}
vehicles.update(fleet, player, readyEntries, step, vehicleHooks)
```

`readyEntries` contains only alive, attached copies owned by `companions.lua`,
with their existing `serial`, `key`, `record`, `entityID`, `npc`, and `slot`.
The fleet service runs at the existing 10 Hz interval. It still runs with an
empty list after the final Dismiss, before the `groupFrame == nil` or empty
walking-order early return, so outstanding cars are cleaned up.

While `vehicles.owns(fleet, entry.serial)` is true, ordinary behavior,
equipment updates and walking actuator sensing/command issuance are skipped for that member. Transport's
release callback owns walking/equipment cancellation until terminal state.
A separate gaze-only path can attend after completed boarding and a fresh exact
same-car mount check. It uses eyes and head with zero chest weight, suppresses
driver attention above 0.5 m/s, and releases during combat and vehicle
transitions. The resume callback first retires that exact seated look, then
creates fresh behavior, equipment and walking state at the actor's current
stance. See [COMPANION_GAZE.md](COMPANION_GAZE.md) for the guards and native
head-slot targeting evidence.
`vehicles.snapshot(fleet, serial)` is a cached diagnostic, with no native calls.

Dismissal confirms the exact Codeware managed flag and companion tag before
touching an actor. `DeleteEntity()==true` moves the entry to `leaving`; update
polls `IsManaged` before calling `vehicles.remove(fleet, serial)`. A failed
dismissal retains its receipt. A detached/dead native owner can also release its
receipt. The controller cancels and reallocates a removed driver's surviving
carpool. Unexpected foreign mounting retains movement ownership until native
dismount, so walking never resumes into another actor's vehicle.

`vehicles.abandon(fleet)` belongs in `companions.abandon()` before native world
teardown references are discarded. It makes no native calls. The existing
save/death/session guards remain authoritative.

`init.lua` observes `FastTravelSystem.OnPerformFastTravelRequest` **before**
native execution. It verifies the current player, a registered destination,
and a changed starting point using the same native fields. The before hook
calls `companions.beginFastTravel()`: it requests exact command release while
the owners are valid, then retains only plain party/car descriptors, value IDs,
and command class/ID receipts. NPC, system, role, look, AI and command handles
are discarded before teleportation. `PlayerPuppet.OnDetach` during this armed
interval preserves those descriptors; the callback makes no native calls.

The descriptor also retains the numeric result of the copy's one-time physical
appearance preparation. Zero means preparation completed with no phantom
controller; only a missing result means the copy entered transit before its
ordinary attachment finished. A surviving pending copy waits for current
attachment, ownership and compatible AI checks, then completes the same
physical appearance procedure before gaining a follower role or becoming
ready. A preparation failure remains failed and uses the ordinary tagged-copy
deletion guard. Missing copies still use normal creation and attachment. Native
face-graph preparation remains owned by the existing tagged extraction and
initialization callbacks, including an appearance rebuild; Lua recovery does
not replace or assume readiness of the facial graph.

Only a subsequent `OnLoadingScreenFinished(true)` activates recovery. The next
world-ready companion updates obtain the current DynamicEntitySystem and
check every saved entity's managed flag and ownership tag. Fresh native
components may expose a matching old command ID; cancellation completion is
confirmed before new walking ownership. An unresolved gaze release, changed
tag, pending command, or missing attachment leaves an explicit failure rather
than creating a competing controller. Actor attachment and command retirement
have a 12-second recovery window. Missing-copy placement gets three attempts.

Surviving companions unmount their recorded car, then use the existing
pedestrian placement checks. Missing copies call the same internal creation
path as invitations, retaining the original model, canonical conversation
profile, serial and slot; its public entry point still requires normal memory
and connection preparation. Old cars are reacquired only from the explicit
created-car receipts and retain all ordinary empty/managed/tag/player guards.

Save restoration and death always erase the travel intent, even if a request
was previously armed. A loading completion on its own is inert. An unfinished
request expires after 120 seconds without recreating anything. There is no
saved party file and no automatic restoration after loading a save.

The companion fixture loads the vehicle modules. The parent task owns the
development manifest and package test-script registration for both vehicle test
files.

## Other mods' riders (2026-10-19, branches `fix/nca-seats` and `fix/nca-seats-2`)

**Live bug (2026-10-18, 20:29Z).** V got into V's car with our Rosalind Myers and three Night City Allies (NCA) followers: Lucy, Rita and NCA's Judy. Judy did not get in, and the other three sat in one spot. `probe.log` shows our fleet put Rosalind in `seat_front_right`.

**Cause.** NCA mounts its followers when V gets in, and it never looks at who sits where. Its seat plan (read from NCA's source, nothing copied): the seats are the car's `seat_front_right`, `seat_back_left` and `seat_back_right` minus V's own; every rider's favourite seat first, then `seat_front_right` to the rider with the best relationship, then the rest from the free list in the vehicle's seat order; a rider without a seat is dismissed from the drive. Our fleet chose a seat at the same moment from what was free *then*: NCA's followers had not mounted yet, so `seat_front_right` looked free and we reserved and mounted into it. Two mount commands then ran for one slot. The existing checks could not see it: the occupant and reservation reads only show a seat once somebody has started to mount.

**Fix (our companions only; NCA's followers are never touched).**
- `mod/companion-vehicle-native.lua` `M.foreignRiders(player, vehicle)`: once per boarding, counts the followers another mod seats in V's car and returns the count plus a report (one row per nearby spawned character: who, distance, counted or not and why, and the entity IDs of those counted). It asks the spawned-character service (`mod/spawned-characters.lua`, the same recognition as every other spawned character: managed by the dynamic entity system, not ours, not a quest actor; one targeting query plus one lookup per remembered ID, radius 50 m) and counts the ones that are alive, attached, not a drone or mech, standing outside every vehicle, and either follow V (`IsPlayerCompanion`, the engine's follower role) or are friendly to V in V's attitude group. Nothing of NCA's is named or matched (no tag, record or namespace), nothing is sent. A bike, a missing service or a failed read count none. The service is read as a bare global of the mod environment first (`rawget(_G, ...)` alone found nothing in the game, see the second live check below).
- `mod/companion-vehicles.lua`, the plan: when the first companion needs a seat in V's car, `sampleForeign` asks that question once and `foreignPlan` fixes the seats the other mod's default order would use (`seat_front_right` first, then the next free passenger seats in the car's seat order, one per rider, from the seats free at that moment). `available` keeps them out of every choice. The plan never moves: a seat that fills up must not push the hold onto the next one. V's car only, never an overflow car of ours.
- The wait (second round): the plan can be wrong (favourite seats; a mod that does not follow that order; followers the engine's follower AI mounts by itself, which is what NCA's debug-spawned followers get). So while any counted rider still stands outside a vehicle, our companions send no mount command, spawn no overflow car and decide no seat for good. `M.foreignPending(ids)` is polled twice a second (a lookup and a mount read per counted rider); the wait ends when all of them are seated or gone, or after 12 s. The seats are then chosen from what is really occupied or reserved (the plan is released), which the pre-mount check in `board` enforces anyway: a seat taken in the meantime sends the companion on to the next free one.
- A companion left without a seat takes the ordinary no-free-seat path, unchanged: a companion who can drive gets an overflow car (the convoy), a passenger-only one (Alt) waits for a seat; a seat that stays empty is hers once the wait is over.
- A companion the engine's follower AI seated in V's car while the fleet planned another car (or none) for her is adopted where she sits (`allocate`, using the mount `board` read last tick, no extra native read).
- Exits: a person mounted in a car of the fleet other than the one planned for her is unmounted from the car she is really in (before, `leave` waited forever for a "foreign vehicle" that was V's own car), and three refused unmounts are retried in rounds ten seconds apart, three rounds at most (before: `exit-failed` for good).
- Cost: one targeting query and a few reads once per boarding, plus the twice-a-second poll while the wait lasts (at most 12 s), nothing per frame, no new hook.

**Probe lines** (`Companion recovery ...`, written by `fleet.report`, wired in `mod/companions.lua`; one line per decision, never per tick):
- `vehicle-boarding {riders, held, waiting, why, error, taken, people:[{name, seat, car}], foreign:[{who, distance, counted, why}]}`: written once per boarding, right after the first seat choice, also when nobody was counted (then `foreign` lists who was seen and why each was left out, and `why`/`error` say if the read did not run).
- `vehicle-seat {name, seat, car}`: every later seat choice (a reseat after a seat was taken, an adoption).
- `vehicle-settled {why = seated|timeout|unreadable, waited}`: the wait is over.
- `vehicle-exit-start {reason, people:[{name, seat, phase, mounted}]}` and `vehicle-exit {name, decision, seat, ...}`: decisions `unmount-requested-<attempt>-<round>`, `exits-from-actual-car`, `waits-for-car`, `waits-for-foreign-vehicle`, `exit-failed-<round>`.

**Second live check (2026-10-19 21:05Z): it did not work.** Setup: our Alex (spawn record `CyberpunkConvai.Armed_alex`) plus NCA's Lucy, Rita and Judy, all spawned with NCA's debug command `NCA:ForceSpawnCharacter(...)`. V got in at 21:05:02Z; the user saw every character overlap in the passenger seat, and Alex and Judy still in the car when V got out. What the files show: `probe.log` had no vehicle line at all (the fleet logged nothing), so whether `foreignRiders` ran and what it counted could not be read; the service did see the three followers at 8.0 to 9.8 m ("Spawned character not counted: ... out-of-range", written by an 8 m query a second earlier), so recognition was fine. Findings:
- The count was most likely 0: the first version read the service with `rawget(_G, 'convaiSpawnedCharacters')`. Inside CET a loaded module's `_G` need not be the environment init.lua assigns its globals in (the same pattern for `convaiTeleportLog` has never produced a "Companion teleport" line in this log), while a bare global read is what every other module uses (`convaiLocomotion`). This is the leading suspect, not a proven cause. Fixed, and pinned as a source contract.
- Debug-spawned NCA followers are not in NCA's squad: `ForceSpawnCharacter` calls `NpcManager.Spawn`, and only the join-squad path adds a follower to the squad that `EnterVehicle` seats. NCA's follow behaviour gives each of them the engine's follower role, so the engine's follower AI mounts them in V's car on its own, with no seat plan, and they can overlap each other: that is NCA's and the engine's business, not ours. Our own copies have the same follower role, so the engine may seat Alex too. That is why the plan alone cannot be enough and the wait and the adoption were added.
- Alex still seated at the exit is our exit logic, with two gaps found by reading `leave`: a person mounted in a fleet car other than her planned one waited for ever, and a refused unmount was given up after three tries. A seat denied by the first version's plan could itself have caused the first (the fleet planned an overflow car for her while the engine seated her in V's car). Which of the two happened cannot be told from the log; the new `vehicle-exit` lines will say.
- NCA's Judy staying outside is NCA's own choice when its seats run out and not ours to fix.

**Limits.** NCA's favourite seats are not readable, so a favourite outside the default plan can still land a rider in a seat we took (the occupant re-check catches it only once the rider has started to mount; the wait covers the usual case). A follower that arrives after the wait, or one NCA decides to seat after V has already been driving (a catch-up after a teleport), is not planned for. A rider NCA ends up dismissing or one that drives its own car still counts, so we can leave a seat empty for up to 12 s. NCA's own setting "allow passengers" being off has the same cost.

**Tests.** `bridge/companion-vehicles.test.mjs` (the plan: one, two, three and too many riders, the expiry, the once-only plan, the re-check before the mount, V's car only, a failed or missing read, a second boarding; the wait: no mount and no overflow car while a counted rider walks, the 12 s limit, a seat taken meanwhile, the boarding, seat, settled and exit lines, adoption of a companion the engine seated, the exit from the actual car, the retry rounds) and `bridge/companion-foreign-riders.test.mjs` (the native read and `foreignPending`, the follower signal, the report, the bare global read).

## Delamain cab

Since patch 2.3 V can call the self-driving Delamain cab (`Vehicle.v_standard2_villefort_cortes_delamain_player`,
possibly also `Vehicle.v_delamain_taxi`). The controller used to treat it like any car V sits in: it filled the
seats and then spawned overflow cars behind a taxi that drives itself, and it only began the exit when V's vehicle
changed, which is about 5 s after the cab has already driven away with the companions inside. The main mod stays
generic and needs no add-on for any of this.

- `companion-vehicle-native.lua` `M.isTaxi(vehicle)` is true when the attached entity's record is one of the two
  records above. `M.inspect` is unchanged (the native plugin parity fixtures mirror it).
- The controller caches `car.taxi` once per car (a missing `api.isTaxi` means false). A taxi seats guests back left,
  front right, then back right (last: the game's own Johnny can be seated there beside V, on top of a companion), and never
  the driver seat (AutoDrive drives it).
- With a taxi as the primary car `allocate` never spawns or follows overflow cars. A companion with no free seat
  stays owned with the error "The Delamain cab has no free seat for this companion." and walks on after the exit.
- `M.taxiArrived` starts the exit with reason `taxi-arrived` while V is still seated. It runs from
  `M.chauffeurAutodriveToggled(s,false)` when no chauffeur trip is active (a chauffeur trip keeps its own handling).
  `s.taxiExit` holds the cab id so the fleet does not begin a new journey while V still sits in the cab it just left;
  it clears when V's primary car is gone or different, and in `M.abandon`.
- `companion-chauffeur-native.lua` `ownedCar` refuses the two cab records, so the chauffeur never leases the cab.

Live checks still needed: the record id of the cab V actually receives (and whether `v_delamain_taxi` is ever used);
whether a back door is still open for the companion between V's mount and the ride start; whether `OnAutodriveToggled(false)`
fires at arrival (otherwise the exit starts too late); whether a scene flag on the cab blocks the exit (`leave` waits
while `car.info.scene` is set).

## Verification status

On October 1, 2026, the isolated vehicle suite passes 23 tests and the companion
vehicle integration suite passes eight. The world lifecycle suite passes nine
tests, including fast travel intent/completion, teardown, ordinary save/death
invalidation, and expression-context boundaries. Cases cover capacity, native
occupants/reservations, source car preferences, carpool ordering, delayed mount,
uncertain cancellation, vehicle change, driver deletion, failed attachment,
combat postponement, blocked routes, cleanup ownership, fast travel and session
abandonment. Adapter tests also reject unsupported/occupied car placement and
verify nonpersistent spawn flags.

These checks establish source behavior and contracts, not installed game
acceptance. This work did not install files, send input, mutate the running
game, or change the accepted walking/gaze/lip-sync controllers. Acceptance
must first verify live read-only capacity/mounting APIs, then normal animated
boarding, driving, dismount, car switching and fast-travel event ordering with
the user. In particular, physical road routing and each special vehicle's
boarding animations are not established by these tests.

On October 3, the current vehicle and real companion integration suites pass
50 checks. New transit regressions exercise a pending copy's delayed attachment
and physical appearance mapping, preserve a completed zero preparation result,
and reject/clean up failed preparation without granting a new movement owner.
The first and third regressions failed before the recovery correction. This
closes that source defect; it does not establish live overflow convoy or
fast-travel acceptance.

### October 4 source corrections

An overflow car now requires its designated driver to be observed in
`seat_front_left` before convoy movement begins. If native follower boarding
puts that driver into a passenger seat first, the controller retires only its
own command, requests an animated exit from that same car, waits for the exit
workspot to finish, and retries the driver seat within the existing attempt
limit. Ordinary passenger seat adoption remains available. Foreign cars and
their occupants are not changed.

Fast-travel recovery records each successful relocation once. A delayed gaze or
walking handoff can no longer teleport the same actor repeatedly, consume the
remaining placement attempts, and prevent the handoff from finishing. The
recovery marker is reset only when a new exit/recovery transaction starts.
Relocation also waits for the native exit workspot to finish after the mount
link disappears, rather than moving an actor during its vehicle-exit animation.
Vehicle inspection also reacquires the exact saved entity ID after a cached
native handle detaches, so a streamed vehicle does not remain permanently
unavailable because of a stale handle.

Two small executable checks covered the wrong-seat driver correction and a
successful fast-travel relocation whose walking handoff is delayed. No new test
framework, install, game action, or broad test run was added. Actual multi-car
boarding/convoy/exit and active-party fast travel still need gameplay acceptance;
the code checks do not establish native animation or routing behavior.
