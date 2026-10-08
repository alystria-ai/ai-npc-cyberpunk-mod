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
| Mount and unmount | [AMM `AssignSeats`](https://github.com/MaximiliumM/appearancemenumod/blob/54272353d7e4a5c85ab32248eff3c2d8d2541cd7/Release/bin/x64/plugins/cyber_engine_tweaks/mods/AppearanceMenuMod/Modules/scan.lua), lines 708-734: `AIMountCommand`/`AIUnmountCommand`, `MountEventData`, `Copy()`, NPC AI `SendCommand`; [MountEventData reflection](https://github.com/WopsS/RED4ext.SDK/blob/ad7277714ad30d6885d7050c5ba24fa0102f6920/include/RED4ext/Scripting/Natives/Generated/game/MountEventData.hpp) includes `allowFailsafeTeleport` |
| Follow | [AIVehicleFollowCommand reflection](https://github.com/WopsS/RED4ext.SDK/blob/ad7277714ad30d6885d7050c5ba24fa0102f6920/include/RED4ext/Scripting/Natives/Generated/AI/VehicleFollowCommand.hpp), base `VehicleCommand`, and AMM `SetDriverVehicleToFollow`: target, spacing, stop flag, traffic options, `needDriver`, `useKinematic`; native `VehicleObject.GetAIComponent()` gives the command owner |
| Cancel | [AIComponent](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/fce9ab7e6a608b0d729290d898003589515900e1/scripts/core/components/aiComponent.script): `GetCommandState`, `StopExecutingCommand(cmd, success)`, `CancelCommand(cmd)`; [aiVehicle](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/fce9ab7e6a608b0d729290d898003589515900e1/scripts/cyberpunk/ai/Tasks/aiVehicle.script) cancels the vehicle's exact command in `InterruptVehicleCommand` |
| Stop before exit | `VehicleObject.ForceBrakesUntilStoppedOrFor(Float)`; native `WaitBeforeExiting` checks speed below 0.5 |
| Nonpersistent copies | [Codeware DynamicEntitySpec](https://github.com/psiberx/cp2077-codeware/blob/main/scripts/World/DynamicEntitySpec.reds): `recordID`, optional `appearanceName`, position/orientation, `persistState=false`, `persistSpawn=false`, tags; [DynamicEntitySystem](https://github.com/psiberx/cp2077-codeware/blob/main/scripts/World/DynamicEntitySystem.reds): CreateEntity, IsManaged, IsTagged, DeleteEntity |
| Ground and clearance | AMM `init.lua` uses CET's `SyncRaycastByCollisionGroup(start,end,group,false/true,false/true)` with the Boolean plus `TraceResult` return; native NPC `IsInVehicle` recovery code uses `SpatialQueriesSystem.Overlap(extents,position,EulerAngles,group,out trace)` |
| Fast travel intent and completion | [FastTravelSystem](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/fce9ab7e6a608b0d729290d898003589515900e1/scripts/core/systems/fastTravelSystem.script): `OnPerformFastTravelRequest` calls `PerformFastTravel`, which requires a registered point and a destination different from the `FastTRavelSystem.StartingPoint` blackboard value before `TeleportToNode`; `OnLoadingScreenFinished(value)` completes only for `true`. AMM also observes this completion; [CET Kit GameUI](https://github.com/psiberx/cp2077-cet-kit/blob/main/GameUI.lua) observes the request and completion methods |
| Fresh command reacquisition | `AIComponent.GetEnqueuedOrExecutingCommand(CName, Bool)` and `IsCommandActive(Uint32)` in the same native AI source allow a fresh component handle to be matched against an exact saved command ID. A different command ID is never cancelled |
| Confirmed deletion | [Codeware DynamicEntitySystem.cpp](https://github.com/psiberx/cp2077-codeware/blob/main/src/App/World/DynamicEntitySystem.cpp), `DeleteEntity`: marks the state deleted and starts despawning before returning true. Companion removal waits for `IsManaged(id)==false`; its original fleet receipt remains owned while despawn is pending |

The adapter requests animated mount and unmount (`isInstant=false`), preserves
native HLS checks, disables failsafe mount teleport, and never uses the neutral
occupant override. It asks native traffic routing to follow V with a real
driver and physical movement (`useTraffic=true`, `useKinematic=false`). These
flags are source-supported; the exact road-follow result still needs a live
game check. No broad vehicle component injection is installed.
The native [AIDriveFollowCommandHandler](https://github.com/CDPR-Modding-Documentation/Cyberpunk-Scripts/blob/fce9ab7e6a608b0d729290d898003589515900e1/scripts/cyberpunk/ai/commands/aiDriveCommandHandler.script)
also maps all ten follow fields into behavior arguments (lines 426-459),
confirming that the traffic and physical movement flags are consumed by the
native driving behavior.

## Car model evidence

These pairs are explicit rows in the AMM source database at commit
`54272353d7e4a5c85ab32248eff3c2d8d2541cd7`,
[db.sqlite3](https://github.com/MaximiliumM/appearancemenumod/blob/54272353d7e4a5c85ab32248eff3c2d8d2541cd7/Release/bin/x64/plugins/cyber_engine_tweaks/mods/AppearanceMenuMod/db.sqlite3).
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

AMM's `GetVehicleSeats` explicitly limits the Mackinaw record identified by
`0x04201D05, 47` to front-left, front-right and back-left. Its database maps both
Panam and Claire appearances to this same record. The adapter therefore
excludes back-right even if the generic record claims it, and also requires
`HasOccupantSlot` for every allowed slot. Native boarding animation for all
these appearance/seat combinations remains a live acceptance item.

River's `Vehicle.sobchak_vehicle` uses an authored quest vehicle template and
is not enabled as a preference. Jackie's motorcycles are not additional
carpool cars. No original quest-world car is acquired or altered.

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
