# Companion recovery and movement admission

## October 5 native distant follow (user decision)

The retarget capture (`runtime/follow-cycle-retarget-20261005`) still showed a
fresh MoveTo about every 0.3–1.0 s per follower while V sprinted: about 40
submits and one retarget each, with speeds of 2–5 m/s against V's 8. Distant
catch-up walked 4 m certified legs inside a 6 m horizon, handing off up to
2.25 m early, and each new native command restarted locomotion. Exactly one
retarget per actor, then only submits, is consistent with the native MoveTo
keeping its first path and the not-consumed guard disabling retargeting; the
one-event snapshot could not prove which transition fired.

The user chose native following. A clear distant horizon proof now admits one
`AIFollowTargetCommand` instead of waypoint legs. It stays owned while V moves:
the moving-feet guard sweeps ahead every 0.2 s, capped at the next bend of the
last certified route so it does not test the wall the path turns away from,
and the route proof repeats every 0.8 s. A deferred proof is retried within
0.2 s instead of stopping a running follower. A rejected proof or a guard hit
blocks exactly as before. Near routes that bend or shift sideways still walk
certified points.

## October 5 no route across an obstacle

After V hopped a small railing (`runtime/railing-jump-test-20261005`), two
companions got navigation-stage rejections (no native route) and stood blocked
19 and 24 m away indefinitely; stranded recovery only applied beyond 30 m. A
companion with no native route now rejoins after 4 s once more than 6 m away,
when out of view; if V keeps watching it for 12 s it rejoins anyway. The
destination is always out of view. The same trace confirmed the AI teleport
live: two companions left ~690 m behind were relocated once each.

## October 5 catch-up pace and AI teleport

The catch-up retest recorded nine failed relocations per companion: a
transform teleport (`TeleportationFacility.Teleport`) moved an AI-driven copy
only a few metres, and its own locomotion pulled it back. Relocation now sends
an owned `AITeleportCommand` through the actuator, and decisions pause until
the copy is seen at the destination (or 2.5 s pass and a failure is recorded).

The user asked for speed that rises with distance instead. Vanilla followers do
exactly that (`FollowerTasks.script`, `AIFollowerInterpolateFollowingSpeed`
sets an individual time dilation from distance), but these copies do not run
that behavior task. While natively following, a copy's time dilation now ramps
from 1.0 at 6 m to 1.6 at 30 m (~8.6 m/s at sprint, faster than V's ~8), under
its own reason so it never replaces another effect's dilation.

The next retest kept up but showed a slow-down once a follower arrived: under
6 m the ramp fell to 1.0 and, running alongside V in its lane (a move at sprint
gait rather than native follow), the copy dropped to ~5.4 m/s and lost V again.
Pace now matches V the way a person would: the larger of V's speed over the
copy's natural gait speed and the distance ramp, applied to native following
and to alongside travel while V moves, limited to matching within 3 m, and
changed at most 0.6 per second. It eases back to 1.0 when V stops, in a vehicle
or on dismissal. Out-of-view teleport catch-up
is now a backstop for gaps over 60 m.

## October 5 out-of-view catch-up (user decision)

NPC sprint is capped by its animation at about 5.4 m/s while V runs about 8,
so long sprints leave followers 30–80 m behind. A following companion more
than 25 m back for 1.5 s, and out of view, now rejoins about 4 m behind V
relative to the camera, through `placement.find` with an out-of-view filter
(never in front of the camera), then a 5 s cooldown. Stranded recovery shares
the same out-of-view destination. Both release the owned command before the
teleport: the departure retest showed a teleport under the hold command left
the copy in place. Relocations count only once the copy is seen at the target;
`relocationFailures` records ignored teleports.

## October 5 false blocks at departure

The first native-follow game test (`runtime/follow-native-test-20261005`)
followed smoothly, but Ana started late and Alex, queued behind her, stuttered
for ~5 s. Three checks fired on space the companion could never collide with:
the route was rejected for crossing V while V sprinted away; the guard swept
sideways along the first sensed start-animation shuffle and hit a wall the route
never approaches; and Blue Moon's zero-length feet check hit a destructible prop
she was already touching. Now: a running V (>2.5 m/s) does not reject a route;
the native-follow guard sweeps along the certified route direction; and every
sweep that leaves the feet starts just ahead of the occupied body, so the
volume a companion already stands in is never a reason to stay put. The
zero-length origin checks in admission, waypoint motion and detour search are
gone. Obstacles ahead still block.

## October 5 stranded follower recovery (user decision)

A walker that has been blocked within the last 2 s, has moved less than 1 m
for 6 s, and is more than 30 m from V is re-placed near V once it is out of
view: more than 60° from the camera direction or with line of sight blocked.
The new spot comes from the same `placement.find` an invitation uses,
including standing-body and exit-sweep checks. Attempts are throttled to every
3 s; an unavailable sight query never counts as hidden. The owned safety hold
stays in place and the actuator replans from the new feet. The developer
trace now records `strandedFor`, `relocations` and each copy's last four
actuator events.

## October 5 command continuity

The user's new trace captured clear-route catch-up with repeated command changes
and zero-speed intervals for Alex, Ana and Blue Moon. The controller was issuing
new MoveTo commands at short intermediate points, even though no obstacle was
reported. Capture: `runtime/follow-cycle-20261005-215236`.

Continuing, same-gait waypoint movement now updates the owned active command's
target after complete successor admission. It starts that handoff earlier at
running speed. Gait changes, final arrivals, cancelled handles and blocked routes
retain their normal retirement path. The native MoveTo handler reads this field;
whether each native behavior consumes a live update remains an in-game check.
An ignored target update is recorded and disables further in-place updates for
that actor, falling back to fresh command admission. Three focused source cases
cover command continuity, successive horizons and an obstructed gait change.

The older tiny-budget vehicle fixture currently stops at the motion guard before
its intended successor-preparation setup. It is not counted as a passing check.
No broad movement-suite or rendered-gait acceptance is claimed for this change.

## October 5 native first-point height projection

The native route can start at the actor's XY but slightly above the animated
feet. Chang's measured root was 7.573303 m, the first native point was
7.976767 m, and Static ground was 7.572752 m. A separate native probe found
the full connector from root +0.1 m through the projected standing body clear
in all six collision groups. Only the first native point, within 0.02 m in XY
and more than 0.35 m but no more than 0.65 m above actual feet, may use this
strict swept connector. Actual-foot clearance, projected-body clearance,
current player exclusion and the shared query budget still apply. A plane in
the gap rejects movement. Hanako's recorded 0.213 m root/nav difference stays
under the ordinary 0.35 m walking step band.

The typed first-leg permission follows that exact native leg through waypoint
and moving-corridor checks. It does not raise the step limit for later legs or
grant passage when native route, body or physics verification is unavailable.
Rendered movement remains to be checked in the game.

## October 5 shorter distant-follow prefix

A six-metre catch-up prefix is an intermediate standing point. If that point
is occupied, admission tries four- and two-metre points on the same native
path. The selected point still passes player exclusion, standing-body and
full swept-route clearance. If every prefix is blocked, the rejection enters
the existing bounded detour policy. The final destination retains its normal
standing-body proof.

This source correction addresses a recorded hold at an artificial prefix
endpoint. It does not establish the cause of the separately reported stop/run
cycle or qualify visible movement in the game.

## October 4 distant catch-up correction

Fresh and already moving distant followers now use the existing six-metre
advance horizon, including blocked-route retries. Previously the horizon depended
on a prior recovery ticket; the full remote route could exceed the size or query
budget and repeatedly interrupt catch-up. A stationary player could leave the
same rejected route stuck in retry.

The correction stays in the actuator and reuses its existing corridor checks and
rolling handoffs. Five focused causal checks cover fresh admission, blocked retry,
moving proof deferral, active follower transfer and nearby ordinary follow. Four
reproduce the prior failure; the corrected code preserves an executing Sprint
handle while a successor proof is deferred. Source evidence is
`runtime/verification/follow-bounded-catch-up-20261004.json`. Visible movement
still needs confirmation in normal gameplay after installation.

## October 4 vehicle-exit correction

After confirming the restored Porsche could be used, the user reported repeated
idle/run transitions during catch-up and a missed first departure afterward.
Source inspection found that waypoint execution repeated full-route validation
every 0.8 seconds while the actor was moving. Partial validation invalidated its
origin after 2 cm of movement; a deferred check could cancel movement and issue
an idle hold.

Waypoint execution now keeps its existing corridor checks, live movement
lookahead and successor admission without that redundant full-route refresh.
Recovery intent also survives the settling hold and is rebound to the next
operation ticket. Old command handles and geometry proofs are still discarded.
The existing six-metre route prefix is used for the remaining recovery journey;
a successful direct native follow clears the marker.

This correction is installed in `c50d2d2` and activates through CET Reload All
Mods. No additional automated suite was run, following the user's request to
reduce testing. Its visual outcome awaits ordinary gameplay feedback.

The user subsequently reported both symptoms remained. Further source inspection
found that successor admission validated the same route twice in one update,
with cancellation between the two checks. Exhausting the query budget on the
second check inserted another hold. Admission now consumes the first completed
route only when the update clock, actual NPC position, actual player position
and requested goal are exactly unchanged after cancellation. Any asynchronous
cancellation or changed snapshot still requires fresh validation. A passive
capture showed stationary gameplay only, so it did not establish the active
movement cause or qualify the new visual outcome.

This scoped note describes the October 3 repair. The parent movement and
chauffeur documents remain the feature-level sources. Rendered acceptance is
still required after the Lua install; the tests below establish ownership,
decisions and simulated geometry.

## Recorded causes

The second exit capture kept the native unmount/workspot boundary intact:
`unmount-requested` to `walking-resumed` was 2.121 seconds. After that handoff,
three distinct controller defects appeared:

- While V moved at about 3.8 m/s, the remote follow endpoint shifted over 1.5
  metres before a local detour could reach wider candidates. Candidate 2/16 and
  the holding command repeatedly restarted. Once V stopped, the search finished.
- Every curved-route waypoint used Walk, including the remaining distant
  catch-up route. Native command replacement at dense waypoints also admitted
  needless stop/start transitions. The recording's maximum sampled on-foot speed
  was 1.56 m/s; it did not prove a Run/Sprint animation switch.
- A short height/length rejection had no observable geometry receipt. Native
  stopping animation then moved Johnny about 0.615 metres horizontally and 0.176
  vertically. Fresh projection was only 0.198 metres above his new feet, but the
  old receipt stayed held below its 0.75-metre invalidation threshold.

Camera peeks did not change the recorded travel direction. No on-foot sample
entered local interaction. These defects did not justify changing gathering,
camera, exit-animation or global timer policies.

## Authority and invariants

The movement actuator owns exactly one native command handle for the current
operation ticket. Preparation can retain that command; cancellation retains the
same handle until native terminal acknowledgement. Terminal or unavailable
states are checked against the actual handle, not an earlier feedback sample.
No unowned gap grants default follower movement during deferred verification.

Admission still requires native navigation, actual-foot body fit, player
exclusion and the original Static/Dynamic/Vehicle/Terrain/Collider/Destructible
checks. Body dimensions, the 0.35-metre step band, slope rule, local floor bounds
and shared **192 spatial queries per update** remain unchanged. Navigation is
never ignored, vehicles are never globally excluded, and recovery never
teleports or invokes an unverified native follower.

## Local recovery and distant movement

Recovery separates these execution modes:

| Mode | Destination ownership | Pace and completion |
| --- | --- | --- |
| Escape | Fixed local escape and far-side bends around the recorded nearby obstruction | Cautious Walk; completion starts destination preparation, not whole-follow success |
| Advance | A verified short approach before a remote obstruction, or a bounded travel horizon after recovery | Current measured travel/catch-up gait; refresh at a safe boundary |
| Travel | A verified current path to the requested destination | Current intent gait; only a finite final arrival owns a stop/completion |

A moving distant endpoint updates the escape's latest goal. It does not erase
candidate or local physics-prefix progress. Local candidate endpoints remain
fixed until actor feet, obstacle geometry or the actual operation changes.
Player exclusion is refreshed over retained native legs on every continuation;
its current position does not require rescanning expensive unchanged physics
prefixes. That planner receipt never grants motion by itself.

The escape endpoint hands off under the same ticket only after current
destination preparation succeeds. Remote recovery following uses a verified
six-metre native path horizon instead of certifying an ever-moving distant
endpoint across many quota slices. Only this bounded prefix is submitted to a
movement command. A sufficiently near, fully clear route can use the existing
native follow command. A genuine subsequent obstruction starts another guarded
local recovery.

An in-progress horizon retains its local endpoint while the remote goal changes
along the same general direction. An actual destination bearing change over 45
degrees refreshes that planning receipt. This is measured world geometry;
camera yaw is not a planning input. Ordinary following still needs its original
full clear-route proof, and a horizon never grants an unverified native follower.

Following gait is refreshed from measured V speed and distance while behavior
waits for recovery. Escape Walk does not leak into the rest of the route. The
completed-escape placement context is bound to its exact ticket; an existing
safe `nearGroup` stance can brake naturally instead of crossing V merely to
recover its originally preferred side. New operations, release and abandonment
clear that context.

## Preparing and committing a leg

Travel endpoints can coalesce nearby plan points within a four-metre horizon;
escape endpoints remain within a cautious 2.2-metre command horizon. Every
candidate is freshly checked from actual feet to its endpoint through the native
navigation polyline, complete body clearance and current player exclusion. If a
coalesced shortcut is unsafe, the coordinator tries an earlier original point.
It never authorizes movement from a straight chord merely because the original
curve was clear.

The native returned polyline is the active corridor. Measured motion lookahead
and corridor monitoring continue during movement and preparation. Ordinary
steering along a verified bend is allowed; leaving its certified corridor or
encountering a new physical obstruction stops the exact owned command.

| Phase | Action and ownership |
| --- | --- |
| Preparing | Retain an active current command while validating a bounded successor |
| Retiring | Cancel that exact handle once; retain it through asynchronous/unknown acknowledgement |
| Admitting | Re-read actual feet/V and verify again; quota deferral owns a safety hold and preserves partial verification |
| Moving | Commit the successor before native callbacks, preserving ticket and ownership |
| Handoff | Prepare the latest destination while the escape/advance endpoint remains owned |
| Blocked | Own a quiet hold and apply the recovery policy for the typed current rejection |

Intermediate commands do not ask for native terminal completion or stop
animation. A physically reached or nearly reached waypoint can prepare a
successor before native success. Moving successors omit start animation. Only a
finite final arrival requests stop/completion. Preparation, retirement and
admission remain separate so an asynchronous cancellation or quota continuation
cannot use stale permission or endlessly repeat the original retirement.

## Typed geometry freshness

Step/slope and route-size receipts expose actual from/to points, planar length,
rise, allowed rise and box count/bound. Local floor receipts expose their
unchanged floor limit. These rejection types reverify the current native route
and full physical admission at most once per second. A foot change over 0.02
metres invalidates a geometric receipt immediately, including normal stopping
coast and projection changes below the former 0.75-metre movement threshold.

A genuinely unchanged impossible step or floor transition remains held with
updated diagnostic metadata. Unknown native physics keeps its availability
backoff and owned hold. A fresh valid origin is eligibility for full admission,
not permission to skip a collision, step or floor check.

## Native follow destination projection

The next live capture proved that local escape and distant catch-up worked:
Johnny started the escape while V was moving, then used Sprint and reached a
sampled 5.08 m/s. He stopped at 8.52 metres because the controller changed from
the bounded advance horizon to a full radial stand-off. That raw endpoint used
V's road height and its body box intersected Static support. The native
`FindPointInSphereForCharacter` result at the same XY was 0.147 metres higher;
its body was clear in all six physics groups and its native path was valid.
The camera peek occurred earlier while Johnny continued moving; it did not
change the formation or cause this rejection.

Full normal follow destinations now use the same native 0.55-metre projection
query as side stances, before body and path admission. The result must be a
finite OK point within the existing 0.8-metre projection bound. No fixed Z
offset substitutes for native support. All original body, player, step/slope,
path size and physical group checks still apply. Distant advance horizons use
their actual clipped native path point; they do not need to prove an unused
remote endpoint. Already projected local escape anchors are not projected a
second time.

A height-only projection can retain the existing radial native follower. A
laterally shifted point cannot be promised by that command, so it uses the
existing certified waypoint coordinator. An ongoing radial follower that gains
a lateral projection retires its exact command immediately: the new side
point's proof does not certify the old radial route. Asynchronous retirement
retains that exact handle until terminal acknowledgement; then a safety hold
owns the body while the point coordinator waits for fresh admission and budget.
The diagnostic projection
receipt exposes requested and actual points, radius, shift bound and measured
total/lateral shift. Release and new operation tickets discard that receipt.

Ordinary native follow admission also uses the explicit preparation, retirement
and admission phases. Cancellation may move V, change native projection or
introduce an obstacle before it finishes. After exact terminal acknowledgement,
the actuator re-reads actual feet/V and resolves and validates the current goal
again. Asynchronous cancellation retains the old handle; quota deferral retains
a safety hold. A pre-cancellation route never authorizes the new follower.

A full-follow destination rejection can re-resolve the current projected goal
at most once per second while V stays still. A changed native projection can
therefore clear an obsolete ground intersection. A genuine physical obstruction,
unavailable projection or impossible step stays owned and blocked until the
current route passes complete admission.

## Verification boundary

`bridge/companion-recovery-transactions.test.mjs` includes durable cases that
failed before this repair: continuous V movement during local search, a real
party search with V continuously moving, distant Sprint intent after escape,
sub-metre coasting after step rejection, and a genuinely unchanged invalid
vertical transition. It also covers rolling before native success, terminal
success between sense/apply, quota slices, V entering a retained partial prefix,
arriving vehicles, asynchronous cancellation, active native bends, unknown
physics at handoff, exact-ticket context and release/abandonment.

Existing movement, placement, ownership, chauffeur, vehicle exit/workspot,
reload and camera/gathering cases remain required regression gates. Source
simulation cannot establish rendered gait, natural animation blending or native
road behavior. Those remain the parent's bounded live test after installation.

`bridge/companion-follow-projection.test.mjs` adds the raised-support causal
fixture and covers current projection while held, native exceptions and bounds,
real Static obstacles, an impossible vertical native leg, initial/ongoing lateral
projection, the advance-to-full boundary, synchronous/asynchronous cancellation
changes, an old radial endpoint blocked by a newly parked vehicle while point
admission is deferred, and release/replacement of pending follow admission.

## October 8 doors, lifts and fast travel (`mod/companion-passage.lua`)

Live case (probe.log and movement trace, 2026-10-08 07:28-07:34Z): V fast
travelled to V's building with Judy. Fast travel itself worked: Judy was
re-acquired and appeared about 9 m from V after the loading screen. V then
walked through the building's automatic door, which closed behind V. Judy's
route was rejected at the `navigation` stage 25 m back while V waited in the
lift car. She was counted as stranded for 62 s but never moved: placement
searched only around V, and V stood in a car with no walkable navmesh, so
every attempt failed without a log line. After V rode up 41 m she was teleported
only after 12 s, because the rule waited for the watched-copy timeout.

Live reflection with Codeware, read-only except one door test:

- `PlayerStateMachineDef.IsPlayerInsideElevator` and
  `IsPlayerInsideMovingElevator` are Bools on V's local PlayerStateMachine
  blackboard. Inside is true only in the car, and is read a few times a second
  with no hook.
- `Door.whoOpened` is V after V walks through an automatic door. Doors expose
  `IsLocked`, `IsSealed`, `IsLiftDoor` and `IsOpen` on `DoorControllerPS`.
- `ActionToggleOpen()` queued with `PersistencySystem:QueuePSDeviceEvent`
  opened a closed automatic door in game, and the door closed itself again
  later. `ActionDoorOpeningToken()` returned nil, so companions get no opening
  tokens.
- `LiftDevice` has a `gameMovingPlatform`. Whether an NPC standing in a moving
  car is carried along has not been verified.

The rules, checked at the companion update rate, with the lift sampled at
4 Hz:

- **Door:** after a copy is stranded for 1.5 s, the closest closed door within
  4 m of the line to V is opened, but only when V opened it and it is unlocked,
  unsealed and not a lift door. The door search runs at most every 2 s per copy,
  and the same door is opened at most every 6 s. The follower then re-verifies
  its route after 0.8 s (`actuator.replan`). A no-route follower re-verifies
  every 4 s anyway.
- **Blocked:** a body-check obstruction now strands a copy at 10 m (was 30 m)
  after 8 s. It still never leaves while V is watching. No route at all keeps
  6 m / 4 s, leaving in view after 12 s.
- **Lift ride:** nothing is relocated while the car moves or V's height is still
  changing. A copy standing within 2.5 m of where the car stood when it
  departed is placed beside V as soon as the car stops, in view if needed. Any
  other copy more than 3 m above or below V rejoins 0.75 s after the car stops
  or V steps out, and may appear in view after 2.5 s.
- **Waiting in the car:** if V stands in a stopped car for 2 s and a copy on the
  same floor cannot get in, it is placed beside V inside the car, within
  1.8 m, once per car visit.
- **Floor change without a lift:** a copy more than 3 m above or below V that
  has made no progress for 2.5 s rejoins. A copy still climbing toward V is
  left to walk.
- **Placement fallbacks:** spots around V out of view, then any spot around V
  when the rule allows it, then walkable ground within 2.5 m of a V standing in
  a car, then up to three of V's own footholds from the last 16 on V's floor.
  Each plan runs on its own update so the physics budget is shared.
- **Fast travel:** each re-acquired copy gets a 15 s arrival window. A copy more
  than 12 m from V rejoins after 1 s, out of view, or in view after 3 s.
  `companion-vehicles.lua` used to keep a copy owned forever after its third
  failed fast-travel placement, which disarmed every on-foot recovery. It now
  hands the copy back to walking ownership.

Each decision writes one `Companion recovery <kind> {json}` line to
`runtime/probe.log`, at most once per kind and reason every 8 s per copy. The
kinds are `stranded`, `door`, `door-none`, `waiting-in-view`, `relocated`
(with rule, placement plan, trail and watched), `relocation-failed`,
`lift-departed`, `lift-arrived`, `fast-travel-reacquired` and
`fast-travel-lost`.

`bridge/companion-passage.test.mjs` covers these cases:

- opening the door V used, and walking through it;
- a locked door that stays closed, followed by an out-of-view rejoin;
- a door V never used that is left alone;
- door-search throttling;
- no teleport during a ride, then a rejoin on arrival;
- ride-along in view, and no teleport for a copy the car carried;
- placement inside the car;
- the recorded no-navmesh lift car, rescued from V's trail;
- stairs climbed in progress, and a stalled copy on another floor;
- fast-travel placement, and the hand-back after failed placements.

Not attempted:

- holding V's floor selection until the companion is inside the car;
- verifying in game that an NPC actually rides a moving car;
- the lobby security-scanner gate. The trace shows Static body-sweep hits at
  (-1600.5, 358.7) while the navmesh routes through it. If the gap is narrower
  than the 0.8 m body box, the blocked rule now rescues the copy after 8 s.

## October 8 lift cars without navmesh, and refused moves beside a still V

Live case (probe.log and movement trace, 2026-10-08 08:16-08:18Z, City
Center): V walked into a lift car twice. The second time V stood in it for
65 s. Judy followed to the doorway, 2.8 m from V, and stopped there: her route
was refused at the `navigation` stage and her phase stayed `obstructed`. The
`lift-board` rule fired once per visit, at 08:16:35 and at 08:17:30, and both
attempts failed with "Move onto open, walkable ground". The car floor has no
navmesh. The nearest walkable ground was the doorway, beyond the 2.5 m search
radius around V, so the navmesh placement refused every spot in the car. V's
height stayed at 8.2 m the whole time, and no `lift-departed` line was
written. The car never moved, so the arrival rules never had a chance to run.

In V's apartment (movement trace from 08:25:47Z), Judy's walk to a standing
spot was refused by furniture at the `motion` stage, at her own stance. She
then stood `obstructed` 0.6 m from a still V for 8 minutes. The behaviour
waited for the geometry or the destination to change, and neither did.

The changes:

- **Car spot by physics:** `passage.carSpot` looks for a standing spot 0.95 m
  or 1.3 m from V, trying the side facing the companion first. A spot needs
  car floor under it at V's height (a down ray on Static, Dynamic and Terrain
  collision), no wall between V and the spot (a waist-height ray on Static and
  Dynamic), and room for the body (`clearance.body`). If there is no floor under
  V's own feet, the search ends at once. Each update spends at most 24 physics
  queries, all through the shared query budget. The search runs once per car
  visit.
- **Walking in:** V stands in a stopped car for 1 s (was 2 s). A copy on V's
  floor that is blocked more than 1.8 m from V, or still more than 2.5 m away,
  first gets the car spot. If the straight body sweep to that spot is clear and
  the spot is within 5 m, she walks there with an `AIMoveToCommand` with
  `ignoreNavigation=true` (`actuator.board`). If she does not arrive within
  the walking time plus 2 s, or the sweep is blocked, she is teleported to the
  spot. Whether the engine honours `ignoreNavigation` has not been seen live,
  so the teleport is the fallback. If no car spot exists, the old navmesh
  placement beside V still runs.
- **In the car:** while V stays in the same car visit and she stands within
  3.5 m of V and 1.5 m of V's height, she holds still (`actuator.stay`, one
  `AIHoldPositionCommand`). The behaviour cannot walk her back out to a rest
  point on the navmesh.
- **Riding:** if the car carries her, nothing else happens. If it leaves
  without her (she stood in it, but V is now more than 3 m above or below), at
  arrival she is placed at a car spot beside V on the new floor, where V last
  saw her. If that fails, the old `lift-arrival` rule runs.
- **Stepping out:** when V leaves the car, she walks out with the same
  straight walk to V's newest foothold within 6 m on her floor. The trail
  skips points inside the car, so this is where V stepped off. If the walk
  fails, ordinary recovery owns her again.
- **Left behind:** a copy that never got in still rejoins out of view. The
  placement waits until V steps out onto walkable ground.
- **Ride detection:** a ride is the moving flag, or, until that flag has been
  seen set once, V's height changing while V is in the car.
- **Across floors:** a copy more than 3 m above or below V whose height gap has
  not closed by 0.75 m in 8 s also rejoins, even if she keeps walking about.
- **Refused moves** (`companion-behavior.lua`): while V stands still, an
  `obstructed` copy within 2.5 m of V accepts her stance after 2 s. Farther
  away, she retries through native navigation (`recover`, then a new side
  point) at most every 3 s, with backoff up to 6 s. After three failures she
  waits in place within 5.5 m. The planted-car obstacle test now allows at most
  seven retries in 20 s, where it used to demand one ticket forever.

New probe kinds: `lift-boarding`, `lift-boarded`, `lift-exited`,
`lift-exit-failed` and `lift-car-spot`. Relocations into a car carry
`how=car` or `how=walk-timeout`.

New tests in `bridge/companion-passage.test.mjs` model a car with walls and no
navmesh:

- she walks in with no teleport, and stays beside V;
- she rides along, then walks out after V on the new floor;
- a walk the engine ignores ends in a teleport into the car;
- the car leaves without her, and she is back in the car at arrival;
- left behind, she appears out of view once V steps out;
- the floor backstop for a follower walking about below V;
- the apartment case of a refused move beside a still V.

All but the left-behind case fail against the previous code.
