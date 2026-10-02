# Companion chauffeur

A managed companion can drive V's personally summoned, owned car to the selected map destination. Start a trip by asking the character in private text or voice conversation. The Companion Manager shows trip status and **Stop trip**; it has no driving-initiation button.

The companion takes the driver seat and waits for V to enter a passenger seat through normal gameplay. The remaining companions fill free seats and use the existing overflow-car controller. The mod never mounts, ejects or switches seats for V, changes garage ownership, or deletes the borrowed lead car.

Routine preparing, boarding, driving and exit popups are shown only with
**Settings → Development → Developer mode** On. The setting defaults Off.
Current party always retains the trip status; actionable errors remain visible.

## Native NPC driving

The lead car uses Cyberpunk 2.31's `AIVehicleDriveToPointAutonomousCommand` on its vehicle AI component. It does not enable AutoDrive, simulate the game's AutoDrive key, or use Delamain mode.

The native destination getters remain the source of the selected quest/map marker and its road endpoint. Reading that endpoint does not enable AutoDrive. A quest marker's visual position is not substituted for the road endpoint.

| Setting | Production value |
| --- | --- |
| Maximum speed | 8 m/s |
| Minimum speed | -1, native policy |
| Minimum distance to target | 5 m |
| Forced starting speed | -1, no forced launch |
| Driver required | Yes |
| Kinematic movement | Off |
| Clear traffic on path | Off |
| Drive down the road indefinitely | Off |

The constructor's measured defaults were maximum/minimum speed 26/12, no driver requirement and traffic clearing On. Every relevant setting is assigned explicitly.

## Files and ownership

| File | Responsibility |
| --- | --- |
| `mod/companion-vehicles.lua` | Sole seat/movement owner, party allocation, overflow vehicles, convoy and fast-travel integration |
| `mod/companion-chauffeur.lua` | Trip transaction, destination revisions, departure, arrival, interruption and stop obligation |
| `mod/companion-chauffeur-native.lua` | Actual vehicle/seat/command checks and guarded NPC command submission, update, retirement and braking |
| `mod/companion-reload-cleanup.lua` | Retirement-only receipt for the borrowed car command and retained driver |
| `bridge/companion-chauffeur.test.mjs` | Real fleet plus delayed/failed native-boundary fixtures |
| `bridge/companion-chauffeur-native.test.mjs` | RTTI constructor, post-send identity, exact ownership, updates and guarded native calls |
| `bridge/chauffeur-game-integration.test.mjs` | Managed actor binding, manager intents and protected dismissal |
| `bridge/companion-reload-cleanup.test.mjs` | Receipt validation, command retirement, stop evidence and driver cleanup |

There is one update owner. The driver uses the ordinary fleet's `people[serial]` record. The borrowed lead car stays `owned=false` and outside the deletable overflow-car list.

Only the selected driver is acquired while V waits on foot. The foot/look/equipment owners release before one animated `AIMountCommand` takes over the approach, door and entry animation. There is no intermediate social-turn target or failsafe teleport. The remaining party is acquired after V's actual passenger mount and native `Passenger` state are observed.

## Native command identity

Submission follows the installed AI-component contract:

```lua
local handle = command:Copy()
local accepted = car:GetAIComponent():SendCommand(handle)
local id = tonumber(handle.id) -- capture AFTER SendCommand
```

Before submission, the copied handle's ID is the unassigned unsigned sentinel `4294967295`. That value can never become a receipt. The adapter preserves an assigned handle even when submission throws after a side effect, so the transaction can retire it instead of losing its owner.

Destination updates use the measured RTTI class **`AIDriveToPointAutonomousUpdate`**. `NewObject('DriveToPointAutonomousUpdate')`, using the source-language alias, returned nil in the installed game.

`SetDriveToPointAutonomousUpdate(update)` takes no command ID. Before calling it, the adapter verifies that the current drive-to-point command's class/ID matches the owned receipt, that V and the selected driver still occupy the leased seats, and that foreign driving or a scene has not taken control. All update fields are assigned explicitly.

## Destinations and revisions

The initial public conversation offer remains immutable. Admission still rechecks its actor, car, passenger slot and destination against the current world.

After admission, V may change the selected map marker, switch between a quest and a custom marker, or move a custom marker. These changes advance the destination revision inside the same trip. Road-endpoint changes also retarget the owned command. Gradual drift is compared with the last revision's anchor rather than discarded by comparison with each preceding frame. Updates are limited to one per 0.2 seconds.

If a new destination races the old command's native completion, the trip waits for the old command to be terminal and the car physically stopped, then submits the latest revision. It does not declare arrival at the old destination. Clearing the destination cancels the trip safely. A completed or explicitly cancelled trip is not automatically restarted by a later map selection.

## State and interruption rules

| Phase | Required evidence |
| --- | --- |
| Releasing | Exact walking/equipment owners release; 12-second deadline |
| Boarding driver | Actual driver mount plus terminal animated mount command; 25-second deadline |
| Waiting for driver seat | Accidental V driver-seat entry during stopped approach retires the NPC mount and allows 45 seconds total to vacate/release the reservation |
| Waiting for player | Driver is seated; V boards a passenger slot manually; up to five minutes within 40 m |
| Waiting for party | Every assigned passenger/overflow driver finishes native boarding; 75-second deadline |
| Starting | Submit one owned vehicle command; observe its current class/ID and native state within five seconds |
| Driving | Actor/car/seats remain valid; latest destination revision is applied; native command owns the route |
| Stopping | Retire only the exact owned command, retain the fixed-car stop obligation, and observe a physically stopped car |
| Waiting for player exit | Retain the driver until V exits; no forced player movement |
| Exiting driver/party | Retire convoy commands, finish animated NPC exits, resume walking and delete only empty owned overflow cars |
| Taken over by V | Retire the old owned command and yield without braking, reseating or ejecting V |

Native `Success` is necessary for arrival. The car must also be stopped within 7 m of the **current** destination, and no manual cancellation may be pending. AutoDrive arrival/toggle events do not complete an NPC-command trip. Manual stop uses the native failure/retirement path; cancellation cannot fabricate arrival.

When Cyberpunk clears a custom marker on arrival, the owned command's last
applied target remains available for that terminal distance check. Completion
still requires `Success`, a stopped car, matching destination/drive revisions,
and current actor, seat, car and scene ownership. Clearing a marker during an
executing trip or far from the confirmed target remains cancellation.

Car movement and decreasing local path distance count as progress. A stationary route stops after 35 seconds without progress; total trip time is capped at 30 minutes. Native local path distance may initialize at zero or reset upward when a traffic segment loads.

Combat, driver/actor loss, a changed borrowed car binding, incompatible seat changes, a scene or foreign vehicle activity stop the trip. The exact command can be retired without disabling an unrelated AutoDrive/AI journey. Braking is withheld for V driving, scenes, foreign commands or a different driver. An unavailable observation retains the owner and an error instead of claiming cleanup.

## Stop obligation and retry behavior

The fixed-car stopping obligation survives native `Success`, `Interrupted`, `Failure` and command retirement. A terminal command can leave a car coasting; its handle disappearing is not stopped evidence.

Retirement is sent to the exact owned handle. Native calls return Bool. A refusal or exception before acknowledgment can be retried, at most three times, while ownership still matches. A post-call terminal observation reconciles exceptions after a side effect. An acknowledged pending submission is not repeated. Braking has a separate bounded allowance and ownership checks; denial by a foreign owner does not consume that allowance.

A warning deadline does not grant permission to delete a retained driver or forget an active vehicle command. Cleanup remains pending until native retirement and safe stopped/exit evidence are available.

## Reload and fast travel

Before CET shutdown, the controller requests retirement and records a cleanup-only receipt containing the car command separately from the driver's mount/unmount command. Recovery never sends a new driving command, reconstructs a waypoint, invites a character or resumes a trip. See [COMPANION_RELOAD_CLEANUP.md](COMPANION_RELOAD_CLEANUP.md).

Fast travel interrupts the trip while the old world is valid. The ordinary vehicle receipt carries only exact command identities for retirement after the transition. Save/death/world abandonment drops handles without native reads or mutations and never restores chauffeur intent.

## Installed source and verification

The installed source root is `E:\SteamLibrary\steamapps\common\Cyberpunk 2077\tools\redmod\scripts`.

| Source | Contract |
| --- | --- |
| `core/ai/aiCommand.script:215-219,280-289` | Vehicle command inheritance and drive-to-point fields |
| `core/components/aiComponent.script:8-18` | Send, exact-handle cancellation, command state and current-command lookup |
| `core/components/aiComponent.script:105-128,152-155` | Destination-update fields and vehicle-agent update method |
| `cyberpunk/ai/Tasks/aiVehicle.script:535-668` | Native NPC driver submits/updates the mounted vehicle command and observes Success/Failure |
| `core/systems/preventionSystem.script:4557-4587` | Native coordinate-based vehicle command submission |
| `core/gameplay/vehicles.script:95-105,109-120` | Local path progress, guarded brakes and vehicle AI/control readers |
| `core/systems/mountingFacility.script:44-78` | Actual native mounts and seat identities |

A bounded live prototype with the already seated Johnny/Porsche drove **175.654 m in 30 seconds**, with a maximum-speed setting of 8 m/s. The actual handle ID was verified after submission, and the update constructor name was resolved through live RTTI reflection.

The October 3 user check confirmed direct Johnny boarding, manual passenger
entry, driving and a changed waypoint. The same owned command remained
Executing while destination/drive revision advanced from 1 to 2. The custom
marker disappeared on arrival, and Johnny exited; the trace then exposed a
parked-car navigation obstruction that prevented following. Arrival-marker
classification and post-exit recovery fixes were installed together. After the
cached player-clearance correction, the user confirmed that Johnny follows
again after exiting, with an extra pause beside the car. The observed native
exit-to-walking handoff took 2.095 seconds. The remaining pause needs a trace
of V's departure before it can be attributed to the movement controller;
the native exit/workspot guard remains in place. The subsequent complete-trip
trace confirmed arrival classification: the transaction reached
`completed` with reason `Destination reached. Step out when ready.` That same
repeat exposed detour search starvation while V walked away, forced walking on
a distant catch-up route and a stale short-leg height rejection after coasting.
Those walking repairs are in progress; the camera peek did not rotate the
formation. Evidence: `runtime/verification/johnny-exit-timing-20261003.json`,
its systems snapshot and `johnny-nav-origin-20261003.json`.
Overflow convoys, cancellation, reload and fast-travel cleanup remain separate
acceptance cases. Automated fixtures do not establish the game's route quality.
