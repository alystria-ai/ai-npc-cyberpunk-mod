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

Start a trip by asking the companion in private text or voice conversation.
The Companion Manager shows active trip status and a Stop trip action; it has
no driving initiation button or deferred driving request. The companion waits
for V to enter a passenger seat manually before departure.

## Files and ownership

| File | Responsibility |
| --- | --- |
| `mod/companion-vehicles.lua` | Sole transport movement/seat owner, ordinary party allocation and convoy, chauffeur entry points and lifecycle integration |
| `mod/companion-chauffeur.lua` | Bounded preparation, boarding, departure, cancellation and exit transaction inside that fleet |
| `mod/companion-chauffeur-native.lua` | Installed 2.31 AutoDrive, summoned car, waypoint, player mount and guarded borrowed-car braking APIs |
| `bridge/companion-chauffeur.test.mjs` | Real fleet controller plus delayed native-boundary fixtures |
| `bridge/companion-chauffeur-native.test.mjs` | Native request shapes, live-identity guards and read-only offer inputs |
| `bridge/chauffeur-game-integration.test.mjs` | Managed actor binding, protected dismissal and active-trip manager cancellation |

The chauffeur owns the same `fleet.people[serial]` record used by ordinary
transport. There is no second update loop or parallel walking controller. The
lead car is `fleet.primary`, remains `owned=false`, and is never added to the
deletable overflow-car list. The driver's front-left seat and V's selected
passenger seat are unavailable to the ordinary allocator.

Only the selected driver is acquired and boarded while V is on foot. Other
companions retain their ordinary collision-aware walking owner, and no overflow
cars are created during this wait. The driver waits for V to enter a passenger
seat through normal gameplay. The mod never mounts, unmounts, teleports or
switches seats for V. After observing V's actual passenger mounting and native
`Passenger` state, the fleet acquires the remaining companions and allocates
the free lead-car seats and overflow cars. It preserves V's reserved or actually
chosen passenger slot. Overflow cars use the existing exact
follow-command receipts, braking rules and tagged nonpersistent vehicle
cleanup. Departure waits for V's actual passenger mount and `Passenger` state,
and for every assigned companion's real mount and terminal mount command.

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
Each fleet person row also exposes `commandState`, `commandActive` and
`commandAge`. The state is cached from the existing mount/unmount command
checks; age is time since the last request. Snapshots never query a native
command. This distinguishes a real driver-seat mount whose command still
executes from a command that reached a terminal state.

## State and interruption rules

| Phase | Required evidence / transition |
| --- | --- |
| Releasing | Existing walking and equipment commands release; 12-second deadline |
| Boarding driver | Animated exact driver mount plus terminal command; 25-second deadline |
| Waiting for player | Driver is seated; observe V boarding manually into a valid passenger seat; up to five minutes while V remains within 40 m |
| Waiting for party | V is in an observed passenger seat and native `Passenger` state; all assigned actors seated, with a 75-second party deadline |
| Starting | Ordinary `EnableAutoDriveRequest`, once; observe native enabled state for this exact car/destination within 5 seconds |
| Driving | Exact actor/profile, car, waypoint and mounts stay current; native availability remains true |
| Stopping | Guarded disable, brake, and fresh native-disabled/stopped evidence; each submission bounded to three attempts |
| Waiting for player exit | Driver and car retained until V leaves; no forced player exit or automatic seat takeover |
| Exiting driver/party | Retire exact convoy commands, stop cars, animated NPC exits, then resume walking and remove only empty owned overflow cars |
| Taken over by V | V chose the driver seat; retire this trip's native requests, yield without braking against V, and retain ordinary party transport |

Stationary/no-progress driving is stopped after 35 seconds; maximum trip time
is 30 minutes. Native distance is a local traffic-slot path that can initialize
at zero or reset upward. Confirmed movement and decreasing local distance both
count as progress. No native route restart is attempted.

Waypoint changes, a different summoned car, combat, driver loss, lost ownership,
native interruption, an incompatible seat change, or a scene cancel the trip.
A failed waypoint/UI read still attempts guarded native shutdown using the
exact car lease. Uncertain command release, an active foreign AutoDrive journey,
or missing stopped evidence retains ownership and an explicit error.

There is no player `Mount()` request in the chauffeur adapter. The waiting
stage observes actual mounting and gives V time to enter manually. Walking
more than 40 m away, changing the selected destination or waiting five minutes
cancels the request without moving V. The manager can show one friendly
"Get in the passenger seat" notice when the driver is ready; no key is assumed.

V may choose a different available front-right, back-left or back-right seat.
The current internal reservation changes only after actual player occupancy
is confirmed. If an NPC has an uncommitted reservation for that seat, its exact
mount command must retire before the NPC is reassigned. The original action
offer remains immutable; `snapshot.passengerSeat` reports the current observed
seat. Choosing the driver seat cancels chauffeur intent and yields to V after
the companion vacates that slot. No player exit, reseat, or automatic driving
request is issued during that handoff.

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

The installed `tools/redmod/tweaks/base/gameplay/static_data/database/ai/actions/library/`
contains the follower vehicle policy. `followeractions.tweak:1864-1884` defines
`FollowerActions.ExitVehicle` as `IsFollower AND NotDriver AND NotFollowerInVehicle`
before it queues `ExitVehicle`. `commonconditionchecks.tweak:15342-15349` makes
`NotDriver` the inverse of `AIDriverCond`; its implementation in
`scripts/core/ai/actions/tweakAIConditionChecks.script:2948-2954` tests the NPC's
actual driver mounting. Judy in the driver seat is therefore excluded from
this relaxed follower exit rule without any role replacement or extra Hold
command. Non-driver passengers are eligible while V is on foot, which is why
their transport acquisition and boarding wait until V is aboard.

CDPR's [2.31 patch notes](https://www.cyberpunk.net/en/news/51794/patch-2-31)
describe the updated route driving and overtaking. The implementation submits
native requests rather than reproducing that pathfinding in Lua. The old AMM
`scan.lua:955` fast-travel-marker/NodeRef method is not used for arbitrary pins.

## Verification

### Conversation action delivery, October 2

The installed driving request reached the identified private bridge and its
silent runtime `context-update` received a successful acknowledgment. The
verified provider then emitted one `Drive To Waypoint` action without a target.
The old parser rejected it, so the native fleet remained idle; the actor's
look-at controller had not received or blocked a driving command.

Legacy Convai semantic actions permit an omitted target. The bridge now
advertises a request-specific name (`Drive To Waypoint drive-<nonce>`) and accepts
a targetless proposal only when that complete name matches the current one-use
capability. A supplied nonempty target must also match. The previous base name
plus exact target remains supported. Unknown fields, tool-call projections,
batches, stale names, expired requests, unrelated participants and unreliable
delivery cannot authorize driving. The nonce stays in protocol context, with
an explicit instruction to omit it from speech; game controls retain their
friendly labels. The frozen native actor/car/route remains the
authority, independently of any model fields.

The model context includes the car and selected destination labels from that
frozen offer and states that the route is already ready. It asks for a new map
selection only when V explicitly requests a different destination. These
presentation labels cannot change the native coordinates or identity.

After the targetless action fix, the live bridge accepted and published the
driving packet, but the native consumer still rejected it. A read-only native
offer round trip through CET's own `json.encode`/`json.decode` differed at all
three `waypoint.position` coordinates. The exact receipt had kept native
floating-point values while the bridge received rounded values. Capture now
freezes that bounded serialized representation and sends the same copy to the
bridge. Packet equality remains exact; changed coordinates and identities
remain rejected. The fleet still obtains a fresh native route before queueing,
with its existing 0.25 m position check. This is representation normalization,
not a wider route tolerance.

PID-bound `runtime/bridge-control.json` diagnostics inspect existing browser
pages only. They report action eligibility, context acknowledgment, proposal
counts and matching booleans; they omit credentials, player/provider/session
identifiers, capabilities and dialogue. No conversation, microphone or game
action is created by collecting a snapshot.

The ordinary Judy Core readback had an empty saved action list. The documented
singular `action` update and a bounded plural compatibility check both returned
success without changing any field in the readback. Neither is treated as a
successful configuration change. An isolated anonymous connection comparison
was rejected with HTTP 400 before conversation and therefore provides no
evidence about action initialization. Runtime protocol evidence and actual
installed action delivery remain the acceptance criteria.

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

The new checks cover stale offers, exact identities and profiles, manual
boarding/activation, alternate passenger seats, V taking over, walking away,
waiting deadlines, whole-party carpool and two overflow cars, native request
guards, bounded stop attempts, foreign AutoDrive takeover, native arrival,
route-distance resets, sample failures, cancellation, deletion exclusion,
save/death/fast-travel interruption and pre-shutdown driver protection.

These are executable Lua and source/API boundary checks. Actual 2.31 animated
entry, passenger camera, road routing, overflow driving, arrival and stop/exit
behavior remain live game acceptance items until observed on the installed mod.
