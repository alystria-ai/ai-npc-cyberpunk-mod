# Companion chauffeur

V can ask a managed companion to drive the personally summoned, owned car to
the game's selected destination, including a tracked quest route or map pin.
The selected copy takes the driver seat;
V gets a reserved passenger seat. Other companions fill the remaining seats
and use the existing personal-model carpool and overflow-car controller.
Native Cyberpunk 2.31 AutoDrive owns the lead car's road route.

The request begins while V is on foot near a stopped summoned car. If V is
already driving, the action asks V to step out. It never ejects V, takes over
an unrelated AutoDrive trip, unlocks another car, or changes garage ownership.

## Files and ownership

| File | Responsibility |
| --- | --- |
| `mod/companion-vehicles.lua` | Sole transport movement/seat owner, ordinary party allocation and convoy, chauffeur entry points and lifecycle integration |
| `mod/companion-chauffeur.lua` | Bounded preparation, boarding, departure, cancellation and exit transaction inside that fleet |
| `mod/companion-chauffeur-native.lua` | Installed 2.31 AutoDrive, summoned car, waypoint, player mount and guarded borrowed-car braking APIs |
| `bridge/companion-chauffeur.test.mjs` | Real fleet controller plus delayed native-boundary fixtures |
| `bridge/companion-chauffeur-native.test.mjs` | Native request shapes, live-identity guards and read-only offer inputs |

The chauffeur owns the same `fleet.people[serial]` record used by ordinary
transport. There is no second update loop or parallel walking controller. The
lead car is `fleet.primary`, remains `owned=false`, and is never added to the
deletable overflow-car list. The driver's front-left seat and V's selected
passenger seat are unavailable to the ordinary allocator.

The driver and the rest of the party finish native animated boarding before V
is mounted. This also avoids native follower auto-boarding competing for V's
seat while V enters. Overflow cars use the existing exact follow-command
receipts, braking rules and tagged nonpersistent vehicle cleanup. Departure
waits until every assigned actor has a real matching mount and terminal mount
command. The chauffeur never replaces those follow commands with AutoDrive.

## Public fleet API

```lua
local offer = vehicles.chauffeurOffer(fleet, player, readyEntry)
local ok, reason, currentOffer = vehicles.queueChauffeur(
    fleet, player, readyEntry, expectedOffer)
local accepted, reason = vehicles.cancelChauffeur(fleet, reason)
local snapshot = vehicles.chauffeurSnapshot(fleet)
local mayDismiss, reason = vehicles.canDismissChauffeurDriver(fleet, serial)
local safeToDelete, reason, cleanupReceipt = vehicles.prepareChauffeurShutdown(fleet, reason)
```

`chauffeurOffer` performs fresh read-only native queries. A successful offer has
exactly this JSON-compatible shape; error offers have `available=false` and a
`code`/`reason` and cannot grant an action capability:

```lua
{
    available = true,
    actor = { serial = 1, id = "1001ULL", key = "judy-alvarez" },
    car = { id = "2001ULL", record = "...", name = "..." },
    waypoint = { id = "3001ULL", name = "...", position = {x=1,y=2,z=3} },
    passengerSeat = "seat_front_right"
}
```

`actor.key` is the assigned `entry.profileKey`, not the visual/model key.
Passenger seats are explicitly front-right, back-left or back-right.
`queueChauffeur` rechecks the current actor, car, selected destination ID/coordinates and
passenger seat against `expectedOffer`. Callers must resolve a current ready
managed entry by serial/entity/profile before calling. Lua action consumers
also validate their world generation, request generation and expiry.

Destination capture uses the native AutoDrive destination type, mappin ID and
`GetAutodriveDestination()` position. Supported types are `PlayerTracked` and
`Quest`. A quest route can be selected while `GetManuallyTrackedMappinID()` is
zero; that does not mean the player has no selected destination. The mappin
must resolve, but its visual position is not used as the driving endpoint:
the installed read-only Quest probe showed a roughly 1.1 m vertical difference
between the mappin marker and native route point. The bridge field remains
named `waypoint`, and its exact shape is unchanged.

`None`, missing native destination IDs/mappins, and nonfinite or unbounded
route coordinates are rejected. No unspecified route or Free Roam is started.
The frozen native ID and route coordinates are rechecked before enable and
throughout the trip. LocKey-style destination labels use guarded localization
with a friendly fallback, so a cosmetic label cannot block route admission.

The coordinator runs only from existing `vehicles.update`. Cached snapshots
make no native calls and are also present as `vehicleSnapshot().chauffeur`.
They expose phase, offer identity, native enabled/vehicle/distance readings,
actual driver/player seats, speed, reason, outcome and bounded attempt counts.

## State and interruption rules

| Phase | Required evidence / transition |
| --- | --- |
| Releasing | Existing walking and equipment commands release; 12-second deadline |
| Boarding driver | Animated exact driver mount plus terminal command; 25-second deadline |
| Boarding player | Whole party seated first, then one animated native player mount; 75 seconds for party, 25 seconds for V |
| Waiting for party | V is in the actual reserved passenger seat and native `Passenger` state; all actors seated |
| Starting | Ordinary `EnableAutoDriveRequest`, once; observe native enabled state for this exact car/destination within 5 seconds |
| Driving | Exact actor/profile, car, waypoint and mounts stay current; native availability remains true |
| Stopping | Guarded disable, brake, and fresh native-disabled/stopped evidence; each submission bounded to three attempts |
| Waiting for player exit | Driver and car retained until V leaves; no forced player exit or automatic seat takeover |
| Exiting driver/party | Retire exact convoy commands, stop cars, animated NPC exits, then resume walking and remove only empty owned overflow cars |

Stationary/no-progress driving is stopped after 35 seconds; maximum trip time
is 30 minutes. Native distance is a local traffic-slot path that can initialize
at zero or reset upward. Confirmed movement and decreasing local distance both
count as progress. No native route restart is attempted.

Waypoint changes, a different summoned car, combat, driver loss, lost ownership,
native interruption, an incompatible seat change, or a scene cancel the trip.
A failed waypoint/UI read still attempts guarded native shutdown using the
exact car lease. Uncertain command release, an active foreign AutoDrive journey,
or missing stopped evidence retains ownership and an explicit error.

Native player `Mount()` returns void and has no exposed cancellable command
receipt. If submission throws or never produces an observed mount, the driver
is retained rather than allowing a late V mount into an empty driver seat.
Entering the car and stepping out resolves that state. There is one player
mount submission; it is never retried in the background.

## Required application hooks

These callbacks only record evidence; they do not move entities. The native
method signatures are exact installed 2.31 declarations:

```lua
-- OnAutodriveToggled(enabled : Bool, isDelamain : Bool)
ObserveAfter('AutoDriveSystem', 'OnAutodriveToggled', function(self, enabled, isDelamain)
    vehicles.chauffeurAutodriveToggled(fleet, enabled)
end)

-- OnStopAutoDriveOnDestinationReachedRequest(request : StopAutoDriveOnDestinationReachedRequest)
ObserveBefore('AutoDriveSystem', 'OnStopAutoDriveOnDestinationReachedRequest', function(self, request)
    local car = self:GetAutodriveVehicle()
    if self:GetAutodriveEnabled() and car then
        vehicles.chauffeurArrived(fleet, tostring(car:GetEntityID().hash))
    end
end)
```

Use the existing `companions` wrappers in application code because the fleet is
private there. Arrival observation must run before the original handler clears
tracking and disables AutoDrive. Only a matching native arrival event qualifies
`completed`; a vanished waypoint or a small remaining distance does not.
The off-edge observation prevents adopting or disabling a new trip after
native off/on transitions between update samples.

Guard selected-driver dismissal **before** clearing its AI role, equipment or
requesting deletion. `canDismissChauffeurDriver` returns false while that driver
is retained. Ordinary `removing`/`remove` hooks still handle later completed
actor deletion and unexpected death/detach.

Existing `vehicles.suspend` stops chauffeur driving while the old world is
valid, then stores only ordinary mount/convoy cleanup receipts. It never stores
or restores a chauffeur intent. Save/death/detach `abandon` makes zero native
calls and drops the trip. No waypoint is recreated after arrival or cancellation.

Before a mod shutdown/reload, call `prepareChauffeurShutdown` only while the
world is still valid. It stops the owned lead/convoy driving and returns false
plus a plain actor/car cleanup receipt while the driver remains protected.
The caller must retain/report that receipt and skip driver deletion. A forced
CET Reload All Mods destroys the old Lua owner before asynchronous exit can be
completed; automatic recovery of those outstanding native receipts is not
implemented. Finish the trip and step out before reload for complete cleanup.
Never claim that an unavoidable reload completed the actor cleanup merely
because the native stop request was queued.

## Installed source evidence

The running executable reports ProductVersion `2.31`, FileVersion `3.0.5294808`.
The installed source root is
`E:\SteamLibrary\steamapps\common\Cyberpunk 2077\tools\redmod\scripts`.
Its `core/systems/autoDriveSystem.script` is 22,772 bytes, SHA-256
`6810E4F776C9FDAC2E884CF1D193FDA8254163006A347F5326DE83E6E249B8BF`.
The vendored GitHub script snapshot is 2.3 and lacks several 2.31 changes.

| Installed source | Evidence |
| --- | --- |
| `core/systems/autoDriveSystem.script:130-141` | Native enabled/free-roam/destination/vehicle/lane readers and native setter signatures |
| Same file, `156-212` | `GetAutodriveAvailable` accepts `gamePSMVehicle.Passenger`; requires actual player ownership, valid lane, health and other native guards |
| Same file, `315-340` | Ordinary enable request uses native checks; disable request disables but does not itself brake |
| Same file, `371-403` | Native arrival brakes, untracks/removes destination and disables AutoDrive |
| `cyberpunk/UI/widgets/autodrive/autodrive.script:129-151,305-325` | HUD action `HoldAutodrive` submits the same request, but its input hint only permits V driving; key simulation is unsuitable for passengers |
| `core/blackboard/blackboardDefinitions.script:797-802` | Exact summoned world car ID is `VehicleSummonData.SummonedVehicleEntityID` |
| `cyberpunk/UI/widgets/notifications/vehicle_summon_notification.script:192-209` | Native UI resolves that ID with `FindEntityByID` |
| `core/systems/autoDriveSystem.script:116-141`, `core/systems/mappinSystem.script:34` | `PlayerTracked` and `Quest` are explicit native destination types; resolve `GetAutodriveDestinationMappinID()` with `GetMappin`, and freeze the native `GetAutodriveDestination()` point |
| `cyberpunk/ai/commands/aiDriveCommandHandler.script:220-250` | Native AutoDrive reads current destination and updates the traffic drive target |
| `core/systems/mountingFacility.script:44-78` | Exact mounting info, request and native mount signatures |
| `cyberpunk/player/psm/vehicleTransition.script:873-911` | V in front-right automatically switches to an available driver seat after 0.2 seconds; keep driver until V exits |
| `core/gameplay/vehicles.script:104-105` | `ForceBrakesUntilStoppedOrFor(Float, optional callback)` |
| `core/data/tweakDBRecords.script:9771`, `core/ui/uiTextUtils.script:3` | Vehicle `DisplayName()` returns `CName`; `GetLocalizedTextByKey(CName)` resolves it. CET uses `Game.GetLocalizedTextByKey`, with record-ID fallback on cosmetic lookup failure. Blackboard definitions use the established `Game.GetAllBlackboardDefs()` binding. |

CDPR's [2.31 patch notes](https://www.cyberpunk.net/en/news/51794/patch-2-31)
describe the updated route driving and overtaking. The implementation submits
native requests rather than reproducing that pathfinding in Lua. The old AMM
`scan.lua:955` fast-travel-marker/NodeRef method is not used for arbitrary pins.

## Verification

The October 2 read-only game probe verified the current owned Porsche, actual
empty seats, managed Judy identity and native selected Quest destination while
the manual tracker was empty. Both Quest and PlayerTracked destinations use the
native route endpoint; the mappin's visual height is not substituted for the road
target. This qualified the getter bindings without starting a journey.

The combined source gate passed 1,947 tests with native-source and installed MCM
checks enabled. Private chat action delivery uses a unique per-request target
in the documented silent context update; it does not reconnect normal replies
or wait for actions before audio. Lua revalidates its own frozen actor/car/route
offer before consuming the action. Actual provider action emission and driving
remain separate live checks.

Run the focused, headless checks:

```powershell
node --test bridge/companion-chauffeur.test.mjs bridge/companion-chauffeur-native.test.mjs bridge/companion-vehicles.test.mjs bridge/companion-vehicle-integration.test.mjs
```

The new checks cover stale offers, exact identities and profiles, delayed
boarding/activation, whole-party carpool and two overflow cars, native request
guards, bounded stop attempts, foreign AutoDrive takeover, native arrival,
route-distance resets, sample failures, cancellation, deletion exclusion,
save/death/fast-travel interruption and pre-shutdown driver protection.

These are executable Lua and source/API boundary checks. Actual 2.31 animated
entry, passenger camera, road routing, overflow driving, arrival and stop/exit
behavior remain live game acceptance items until observed on the installed mod.
