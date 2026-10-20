# Companion chauffeur

A managed companion can drive V's nearby owned car to the selected map destination, including a car restored with a save. Start a trip by asking the character in private text or voice conversation. The Companion Manager shows trip status and **Stop trip**; it has no driving-initiation button.

A live summoned car is preferred. When its summon blackboard is empty or stale,
the native adapter searches within 20 metres for attached, undestroyed player-owned
cars. A unique match to the active garage record wins; otherwise exactly one
eligible car is required. Ambiguity asks the player to select or summon the
intended car. Admission leases that exact entity and record and captures the
actual summon identity/state. A subsequent summon cancels the trip; merely
changing the garage selection does not switch or cancel the borrowed car.

The companion takes the driver seat and waits for V to enter a passenger seat through normal gameplay. The remaining companions fill free seats and use the existing overflow-car controller. The mod never mounts, ejects or switches seats for V, changes garage ownership, or deletes the borrowed lead car.

A passenger-only companion (Alt Cunningham, a digital ghost; `passengerOnly` in `mod/companion-vehicle-catalog.lua`) is
never offered the wheel: the offer is `available=false`, code `does-not-drive`, before any native read, under any chat
profile (the model decides). See `docs/COMPANION_VEHICLES_DESIGN.md`.

Routine preparing, boarding, driving and exit popups are shown only with
**Settings → Development → Developer mode** On. The setting defaults Off.
Current party always retains the trip status; actionable errors remain visible.

## Seated drive (V already sits in their own car)

"Drive me", "you drive", "swap seats" and "take over" also work when V is already sitting in their own stopped car, as driver or as
passenger, with a map destination set. The offer carries `seated: 'driver' | 'passenger'` (absent when V is on foot) and reaches every
provider: Convai's action context and the Mistral/Local/Custom text route (`bridge/companion-actions.mjs`, `bridge/text-actions.mjs`).
A line that is not in the offer (no waypoint, V in a vehicle that is not their own car, a car that is moving, combat, a companion in another
vehicle, or one still boarding the party car) offers nothing, exactly as on foot, and the text-route character says what is needed.

| V | Companion | What happens |
| --- | --- | --- |
| Driver | In a passenger seat | The companion steps out (one animated unmount from this car), V is asked to step out of the driver seat, the companion takes the driver seat through the ordinary driver boarding, V sits in a passenger seat (the companion's old seat, or the next free one), the trip departs |
| Driver | Outside the car | V is asked to step out; then the on-foot driver boarding |
| Passenger | In the driver seat | Straight to the party check and departure; no seat movement |
| Passenger | In another seat, or outside | The companion steps out (if seated), takes the driver seat; V stays where they are |

**No forced seat swap, and why.** The game scripts (installed `tools/redmod/scripts`) show what exists and what does not:

- V's own switch is the player state machine's `switchSeats` state (`cyberpunk/player/psm/vehicleTransition.script`, `DriverSwitchSeatsCondition`,
  `PassangerSwitchSeatsCondition`). It needs the target seat free, so a companion in the front passenger seat blocks it. Worse, a passenger in
  `seat_front_right` with a free `seat_front_left` is switched straight back to the driver seat after 0.2 s (`PassangerSwitchSeatsCondition`),
  so V cannot sit in the passenger seat while the driver seat is empty, which is exactly the gap while the companion walks round. The quest
  parameter `switchSeats` is set only by quests, never by a script, and nothing proves a CET-sent state-machine parameter reaches it.
- An NPC has no animated seat switch. `WorkspotGameSystem.SwitchSeatVehicle` is used only by that player state. Mounting an NPC into an
  occupied slot is refused, and the instant `MountingFacility.Mount` request the game itself uses at the end of the player's switch bypasses the
  player state machine, which tracks driver and passenger separately (V would sit in a passenger slot while the machine still says driver).
- So the mod never mounts, ejects or switches V (the existing rule): V leaves the driver seat with the normal exit, and the companion's seat
  change is the exit-and-board the party already uses (`AIUnmountCommand`, then `AIMountCommand` to `seat_front_left`).

Safety: V is never moved and never left outside by the mod; the car is never left driverless (the companion is the driver before any
command is sent, and a failure before that point hands everyone back to the ordinary party boarding, nothing was driven). Combat, V leaving,
a timeout, a foreign AutoDrive or a new summon end the trip; combat or any failure while the companion is still stepping out or boarding yields
back to the party (`yieldToPlayer`), and the companion re-boards V's car. The 45 s allowance for V to leave the driver seat starts only
after the companion is out. Exit attempts are bounded (three, 12 s each, 25 s total). No per-frame work: the same trip update that
already runs once per fleet tick, a cached mount read per tick, and probe.log lines only at stage changes.

Stages (probe.log, `Companion recovery vehicle-seated-drive`): `queued` (V seat, companion seat, first stage), then each phase:
`exiting-passenger`, `boarding-driver`, `waiting-for-driver-seat`, `waiting-for-player`, `waiting-for-party`, `starting`, `driving`; an end
before the driver seat shows `yielded`. The unmount itself logs as `Companion recovery vehicle-exit` with `decision=seated-drive-step-out`.

Native: with V mounted, the sample's car is exactly the vehicle V sits in when it is one of V's own cars (`carSource='mounted'`), never the
summon or a nearby search result. While V holds the wheel the offer does not require `CommandsFromDriverEnabled` (it is checked again at
departure, with V as a passenger).

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
| Exiting passenger (seated drive only) | One animated unmount from V's car; companion outside every vehicle and native exit finished; 25-second deadline, then the party is handed back |
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
Those walking repairs were subsequently installed in `e0617e0`; the camera peek
did not rotate the formation. Evidence: `runtime/verification/johnny-exit-timing-20261003.json`,
its systems snapshot and `johnny-nav-origin-20261003.json`.

The next complete-trip check confirmed **"Approaches and settles"** after V exited,
walked away and glanced back. The bounded trace ended with Johnny stationary about
1.34 m from V, after actual running catch-up. This closes that post-exit handoff
case; ordinary following retains its earlier acceptance. Evidence:
`runtime/verification/car-exit-follow-user-accepted-20261003.json` and its matched
`car-exit-follow-accepted-trace-20261003.json`.

A separate report says the driver can pause on the door approach until V catches
up. Source inspection found no Lua player-distance wait in boarding. The exact
native mount/move state must be captured before altering that chauffeur handoff.
The already shown drive-request caption also replayed when entering the car;
the subtitle correction preserves unread text and awaits its focused live check.
Overflow convoys, cancellation, reload and fast-travel cleanup remain separate
acceptance cases. Automated fixtures do not establish the game's route quality.
