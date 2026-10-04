# Companion recovery and movement admission

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
