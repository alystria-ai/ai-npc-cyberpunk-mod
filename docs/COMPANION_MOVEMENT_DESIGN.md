# Friend-group movement controller

## User-visible problem and evidence

The September 29 update still turned Judy away when V looked back while she
was arriving. The user clarified that V sees her back. In the recorded stop,
the old controller accepted her position at about 0.9 m/s, cancelled the path,
and saved that point. Native stopping carried her roughly another metre. The
controller then treated that ordinary deceleration as departure from her spot,
ordered a reverse correction, and left her facing the reverse direction.

The new controller treats motion as a continuous operation. Gaze is not a
destination, a travel direction, or evidence that a moving person has stopped.

## Ownership

- `companion-travel.lua`: infer group travel from V's world displacement and
  recent path. Camera direction is used only to place the initial party.
- `companion-space.lua`: stable per-copy lanes, comfortable standing areas,
  separation, and local candidate positions. No game calls.
- `companion-behavior.lua`: one state machine per person, including complete
  arrival and conversation operations. No native commands or camera heading.
- `companion-actuator.lua`: execute one owned movement operation and one gaze
  request; measure native completion/failure and stop-animation motion.
- `companions.lua`: identity, spawning, session lifetime, sensing and ordering.
- `companion-locomotion.lua`: clear the engine's retained facing object only
  for a current ordinary travel command belonging to this mod.

## Behavioral contract

| Situation | Movement | Attention |
| --- | --- | --- |
| Camera turns while V stands | Existing places and travel direction remain valid | A glance may affect eyes/head only |
| Small step or close face inspection inside the resting group | Keep the settled position; V's proximity does not order a retreat | No party-wide rearrangement; normal head/eye attention remains available |
| Two companion copies overlap | Only those overlapping copies may make a small separation step | Keep the rest of the party in place |
| Back up or circle to face a settled person | Fixed gathering anchors distinguish local interaction from leaving; even the rear members wait | Only the addressed person may readjust after V stops |
| Purposeful departure | Stable lanes follow the actual path; pace follows measured speed | Social body turns yield before locomotion starts |
| Sustained corner or U-turn | Follow the new path after displacement establishes it | Camera yaw alone cannot establish a turn |
| Behind the group | Native catch-up, then a planned approach to free side space | Looking back does not interrupt the route |
| Entering the arrival area | Freeze the approach destination; finish the native stop | Eye contact cannot claim the feet |
| Stop animation/coasting | Measure motion, tolerate a safe overshoot, never reverse toward the first arrival sample | Glance only |
| Actually still | Accept the current safe foot position | Sustained nearby attention may start a small step and turn toward V |
| Look away | Keep the settled stance; no alignment to V's facing or the old travel heading | Relax to a side glance after a short loss-of-attention grace period |
| New movement during a social turn | Cancel the owned social operation once, then travel | Remove its facing target before walking |
| Another member joins/leaves | Existing copies retain their lane identities | No global reordering |
| Occupied/narrow side route | Yield or use native navigation recovery; retry with bounded backoff | Do not chase unreachable exact offsets |
| Combat | Release social locomotion to native combat | Clear owned gaze |
| Death, detach, save change | Drop old actor/command references without querying torn-down components | No callbacks may revive a previous session |

## Verification

Tests must include time-series motion with deceleration and overshoot, rather
than assigning an actor directly to its destination. The reported sequence is
walk -> camera glance back before arrival -> coast past the first arrival
sample -> actual stop. Verify no reverse correction and no body-facing request
until the arrival operation has completed. Repeat with different frame times,
multiple copies, interrupted attention, blocked paths and session teardown.

Native rendered gait still requires the user's game check. Numerical tests
and a stable final frame cannot establish that the whole transition looked
natural.

### September 29 source verification

The complete suite passes **107 tests with no skips**, including the installed
MCM API integration. All **21 Lua files** compile. The new motion suite covers
residual movement after native command success at 0.05, 0.1, 0.23 and 0.5 second
updates; departure during direct attention; quiet navigation recovery; local
personal-space yielding; three people including a duplicate through walking,
running and stopping; and eight copies sharing a route-planning budget.

The integration stand-in models acceleration and stopping distance, not the
game's animation. The separate overshoot replay intentionally reports native
success before motion has stopped, reproducing the boundary the previous
tests missed. Neither is visual acceptance.

The bounded live trace now includes V's world position, confirmed travel
direction, camera direction, selected entity, person state, operation ticket,
native completion, current destination and the latest submitted command.
Camera data is recorded only by diagnostics; it never feeds the controller.

Next live check: walk forward, glance back while Judy is still approaching,
stop and let her arrive, then look directly at her. Verify the whole sequence:
no reversal toward an obsolete spot, a natural stop, and only then a small
social footstep/turn. Repeat with a short run and a second companion. Lua-only
installation requires one CET reload; no redscript restart is needed.

Installed and hash verified at **02:34 IST, September 29**. The preceding 18
installed Lua files are preserved in the ignored local rollback directory
`backups/movement-rebuild-20260929-023441/`. The pre-rebuild party consisted of Judy
`11034257ULL` and Johnny `11034258ULL`; both were ready in the old controller.

### First live trace after activation

The user confirmed CET reload at 02:35 IST. Recreated Judy `11053704ULL` and
Johnny `11053706ULL`; both attached, entered settled state and held one owned
native command with no Lua or gaze error. The 90-second trace is preserved in
ignored `runtime/party-motion-rebuild-first-live-september29.json`.

During Judy's second arrival, one approach ticket remained active through
braking at 42.6 seconds (about 1.04 m/s). She continued another 0.45 metres,
then accepted the actual stopped stance at 44.2 seconds. Direct attention
began afterward, moved about 0.16 metres, and reached a measured facing error
of zero at 47.4 seconds. Looking away retained that stance. The native facing
hook checked 21 commands and cleared one stale object without an error.

No moving sample above 0.4 m/s had movement opposed to body facing by more than
100 degrees. One Johnny side-route validation was rejected; he entered native
recovery and later settled. This is measured runtime evidence, **not visual
acceptance**. The user subsequently accepted the glance but reported that
moving fully into position to face a person still moved the group.

### Moving within a gathering

The same trace confirms a second, distinct intention error: at 61.8 seconds V
had backed up roughly 1.9 metres while still addressing Judy. She was about
three metres away. The simple departure distance treated that as travelling,
rotated the formation and moved both people. Another unselected local step
caused the same transition at 76.5 seconds.

Travel now records fixed positions of settled people for the current stop.
Addressing a nearby person, or stepping across the old travel line within the
gathering, enters local interaction. Gaze loss while circling does not move
the group. The area is bounded by both the original stop (four metres) and
proximity to its people (3.4 metres); its anchors never follow V. Leaving that
area restores travel. Ordinary forward departure without social interest
retains the earlier prompt follow behavior.

Standing members, including distant rear rows, wait during local interaction.
Separation between overlapping companions belongs only to the affected people. Once V
stops in a meaningfully different place, the addressed person alone can make
another small social adjustment. It cannot repeat while V remains still.

Regression cases cover backing up during attention, circling with no locked
gaze target, ordinary forward departure, rear rows waiting in an eight-person
party, and one addressed person's adjustment after V stops. The full suite now
passes **112 tests with no skips**; all 21 Lua files compile. Installed and
hash verified at **02:45 IST** with the prior Lua backed up in
`backups/gathering-interaction-20260929-024545/`.

The user confirmed reload at **02:46 IST**, then accepted the complete local
interaction and departure test ("everything good now") and requested the next
feature. Judy `11067216ULL` and Johnny `11067217ULL` were restored for this test.
The 90-second trace is saved locally in
`runtime/party-motion-gathering-accepted-september29.json`.

Both stayed in local interaction from 27.6 seconds; Johnny retained his hold
while Judy alone stepped and turned. At 54.1 seconds both entered travelling,
then catch-up, approach and braking. Johnny settled at 61.1 seconds, Judy by
62.1 seconds, followed by another normal attention step. This closes the
reported stepping-back/rearrangement defect for the two-person live scenario.
Unseen obstacle layouts, larger parties and save/death recovery remain open.

Local Git checkpoint for this accepted controller: `68ae15c`. Installed-file
rollback copies are preserved separately from source history.

### October 3: following after a chauffeur trip and physical detours

The observed post-trip blockage was separate from vehicle ownership. The fleet
had emitted `walking-resumed` and returned to `on-foot`, but Johnny repeatedly
cycled from approach into recovery about 21 metres from V. Both actual endpoint
body checks were clear. The first planar native navigation leg passed through
the parked Porsche; its swept body box hit the `Vehicle` collision group. Native
navigation does not reliably carve parked vehicles out of the pedestrian path.
The old guard stopped unsafe traversal correctly, but recovery discarded that
receipt and tried the same geometry again every six seconds.

The actuator now retains an obstruction context and searches at most 16 local
escape/far-side bends. A candidate needs native projected points, valid native
paths between its anchors, full swept body clearance in all existing collision
groups, and no player crossing. It retains the original 64-box route bound and
allows at most 16 metres of additional route length. Unknown/moving/foreign
vehicles keep the same collision checks. If no candidate passes, the owned hold
remains; one rejected physical box is sampled per second in rotation. Only a
changed box, actual goal/feet displacement, or restored native availability
restarts verification. Camera direction never invalidates this wait.

Accepted bends are executed as short `AIMoveToCommand` legs (at most 1.8 metres
in plan view and 0.2 metres of height per waypoint) under the same operation
ticket. Each actual leg receives fresh native navigation and physical clearance
before submission. `ignoreNavigation` stays false. Native steering is checked
against the executed corridor and the measured direction of motion. Intermediate
legs use path facing and no stop animation; only the final stance is an arrival.
Native success on an intermediate leg never tells behavior that the entire
approach is complete. Follow detour legs participate in the existing exact
retained-facing cleanup before `SendCommand`, preventing an old social target
from restoring backward walking.

Initial ordinary following still uses native `AIFollowTargetCommand`. Its tested
endpoint is the radial stand-off corresponding to the command's desired
distance, rather than V's occupied centre or an old side-lane anchor. Curved
native routes use the same short waypoint owner. A paused multi-frame route
receipt rechecks its imminent 1.8-metre prefix in the admission frame, both body
ends, and any shifted endpoint connector. A foot displacement over 0.02 metres
rebuilds the path. This prevents a vehicle arriving in an already tested prefix
from being admitted when the remaining suffix finishes.

An `obstructed` behavioral phase preserves the existing ticket during search and
execution. Physical geometry failure does not become another identical recovery
operation. A transient native leg failure, stall, or corridor deviation receives
at most two verified retries after 2/4-second waits; a third failure retains the
hold until the recorded geometry or actual destination changes. Native adapter
availability errors retry verification with a retained five-second backoff and
never grant movement. The aggregate 192 native spatial-query limit is unchanged;
quota exhaustion stays pending, without spending native retry attempts or
releasing the current owner.

Vehicle walking resume also waits for a missing actual mount link, a false
native `IsActorInWorkspot` result, and release of any retained occupant slot.
An early mount-link removal is not proof that the door/exit animation finished.
This uses the same native gate already used by reload cleanup. A declined resume
callback keeps the transport handoff. No workspot is forced or teleported.

The existing party snapshot exposes the cached rejection's stage, group,
leg/box, swept-box dimensions, origin/target, and time/ticket, plus search or
waypoint progress. This is diagnostic state rather than a gameplay popup.
Release, dismissal, combat handoff and abandonment retire pending route work
under the original cancellation/ownership rules.

Source regressions include a native path straight through a parked car with
actual safe waypoint motion; the full party settling after blocked catch-up;
fresh-prefix rejection when a vehicle appears during quota deferral; origin
coasting; bounded transient/repeated native failures; facing ownership during
submission; moving vehicles; asynchronous cancellation; transport workspot
completion; and the accepted glance/local-interaction/coasting behaviors.
These checks establish controller decisions and simulated clearance. Actual
rendered gait and the user's post-chauffeur route still need the live check.

#### Refreshing a cached player-crossing rejection

The subsequent live test identified a different stale receipt. Johnny's current
13-leg side-approach paths stayed at least 1.5487 metres from V, and the radial
stand-off path stayed at least 1.7000 metres away. The live V point and controller
frame matched. The retained rejection was an earlier `player` crossing against
the unchanged 0.75-metre guard, rather than a current car or player obstruction.
That rejection had no physical box for the geometry-change poll, so a side goal
moving less than 1.5 metres could remain held indefinitely.

Player rejections now carry the checked player position, offending native leg,
distance and margin. A player displacement over 0.02 metres invalidates that
receipt even if the frozen side goal is unchanged. While both remain still,
the same operation ticket reverifies native projection/navigation and complete
body clearance at most once per second. Continued crossings retain the exact
hold; quota exhaustion continues the typed pending verification without issuing
movement. Only a completely verified clear route releases the rejection, and
normal admission checks still precede the replacement native command. A new
physics or availability failure transfers to its corresponding guarded recovery
policy. Partial route receipts also invalidate when V changes position, so an
old player-clear prefix cannot be reused after V steps into that path.

Source cases reproduce both a sub-1.5-metre V move and a native route change with
the same V/side goal, plus continued real crossing and query-quota deferral. The
player margin and the accepted camera/glance behavior remain unchanged. After
reloading this correction, the user confirmed post-trip following works, with
a lingering pause beside the car. A read-only audit found no fixed five-second
post-exit delay. The native exit/workspot handoff took 2.095 seconds; the later
settled interval cannot be diagnosed without V's movement onset. The next
capture compares transport release, V's departure, route admission and actual
NPC movement before changing any timing or clearance guard.

The subsequent 90-second capture separated those stages. The native exit took
2.121 seconds. While V moved at about 3.8 m/s, destination changes repeatedly
reset the detour to candidate 2 of 16. The search progressed after V stopped,
then executed 34- and 30-waypoint routes at a forced walking pace. A later
short-leg height rejection retained no recovery geometry. Johnny coasted
0.615 metres horizontally and 0.176 metres vertically, leaving a fresh native
projection only 0.198 metres above his feet, but the old rejection still held
him 13.33 metres away. Camera direction remained stable and no local social
interaction was recorded. Read-only executable replays reproduced search
starvation, distant forced walking and the stale post-coast hold. The repair
preserves a local obstacle escape while V moves, revalidates the distant goal,
restores catch-up pace and records recoverable height-check failures.

The installed `e0617e0` projection/handoff update passed the subsequent complete
trip check: V exited normally, walked away, then glanced at Johnny, and the user
confirmed **"Approaches and settles"**. The 90-second read-only trace captured
running catch-up and a final settled position about 1.34 m from V. Evidence:
`runtime/verification/car-exit-follow-user-accepted-20261003.json` and
`car-exit-follow-accepted-trace-20261003.json`. This accepts the reproduced
post-exit failure; normal following and the accepted camera interactions remain
the baseline. A later driver-door approach pause is a separate boarding case.

### October 4: continuing movement after vehicle exit

The later report of alternating idle/run and a missed first departure remains a
separate regression from the earlier accepted trip. Source review found that a
fully checked route was checked again for its first waypoint after cancelling
the previous command. Exhausted query budget could therefore insert an idle
hold at that handoff. The first waypoint now reuses only the exact same-update,
unchanged-feet/player route prefix, with a fresh body check at its endpoint.
Asynchronous cancellation or changed positions still require fresh admission.

A recovery move can also retain its arrival ticket while V starts moving. That
path previously invalidated partial route checks on tiny goal/player changes,
even though following recovery already used a fixed local prefix. Recovery
moves now use the same bounded six-metre approach while V moves, rechecking
current player exclusion on every continuation. These prefixes remain continuing
movement rather than final arrivals. Ordinary on-foot decisions are unchanged.

The vehicle exit itself releases mount/workspot ownership and recreates the
walking controllers. No additional follower-role reset or guessed delay was
added. These are source corrections with Lua syntax validation; the previous
stationary trace did not reproduce the reported motion and is not acceptance.

### September 30: close face inspection (accepted behavior)

The user requested that a companion stay put when V approaches her face. The
earlier personal-space sensor classified V within 0.72 metres as an intrusion;
after 0.6 seconds the controller submitted a 0.5-metre move away. That caused
the retreat even though group travel correctly remained in local interaction.

The separation sensor now considers only overlapping owned companions. V's
close approach does not create a retreat destination. Distinct spawn positions,
path clearance, the accepted small direct-attention step, actual departure,
and combat ownership keep their existing behavior. At close range, direct
attention uses the existing stance instead of adding an approach step.

Two executable Lua regressions fail on the old code and pass on the correction:
V holds at 0.68, 0.35, and 0.08 metres, both with and without a selected gaze
target, without starting a walking command. A separate case retains separation
between overlapping companions without moving the third person. These checks
verify command decisions. After CET reload on September 30, the user walked
up to the companion's face and confirmed she did not back away. Normal following
after departure retains source coverage and earlier live acceptance; the latest
report specifically confirms close approach.
# Waypoint motion guard — October 4, 2026

Waypoint execution now checks its current certified `commandRoute` instead of
projecting the measured velocity in a straight line through the next bend.
Ordinary following retains its existing tangent check. The waypoint guard
projects actual feet onto a monotonically advancing route distance, interpolates
height, and bounds the search by displacement since the previous check. It
cannot jump to a distant parallel or return leg simply because that leg is
spatially closer. Consecutive numerically collinear native legs are combined for
queries; real corners remain separate.

Every due check includes the actual standing body, the connector from actual
feet, a clipped path prefix ending within the current command route, and a short
measured-steering probe capped at the next corner. Collision groups and hard-hit
rejection are unchanged. The complete query cost is checked before any moving
guard queries run. Budget deferral still retires movement into the existing
safety hold; it never licenses unchecked continuation or reuse of stale physics
results. The shared 192-query limit is unchanged.

`actuator.guardMotion(state, context)` allows the companion update to service
existing waypoint guards before route planners spend the shared budget. It skips
equipment-suspended holds and uses the normal 0.2-second guard clock, so the
ordinary apply pass does not repeat the same guard in that update. Scheduling
priority is integrated by `companions.lua`; the actuator does not allocate a
second budget.

A small native-style overlap check covered a clear bend beside a car, a real
obstacle on the remaining path, query exhaustion, multiple small sloped legs,
and a nearby parallel return leg. These checks establish the source correction,
not live resolution of the reported car-exit idle/run cycle. The endpoint-body
check following asynchronous command retirement remains conservative; this
change does not bypass that admission check or claim to remove every possible
quota-related pause.

### October 4: first-spawn report and stale lane evidence

The user subsequently saw the same stop/start symptom after Hanako's first
spawn. A passive capture then recorded her stationary for 90 seconds, 1.93 m
from stationary V, still trying to reach an old lane target across V. The
path correctly failed the 0.75 m player exclusion (measured 0.646 m). Her actual
stance passed `nearGroup`; it failed the stricter preferred-side alignment.
The obstruction early return prevented the normal settle/departure decisions.
This capture establishes that stale-goal hold, not the reported running cadence.

For owned non-facing movement rejected by a player crossing, a stopped nearby
copy may now accept its actual stance after normal stillness. This only retires
movement into a hold. Actual departure can replace obsolete arrival completion,
pace or movement type before retaining a blocked search. Unchanged travel intent
keeps its search and ticket. Recovery admission also covers player/navigation
rejections on newly spawned copies, rather than requiring an earlier physical
detour. Ordinary unblocked decisions and collision margins are unchanged.

A small replay using the recorded geometry failed on the previous behavior
source and passes with the correction. It also checks departure from blocked
arrival, preservation of same-intent searches and continued holding for actual
geometry obstructions. Lua 5.1 syntax passes. Native motion remains subject to
ordinary gameplay feedback; no repeat car trip was requested.

### October 4: live ground intersection at the animation root

A subsequent passive sample found Hanako and Alex stopped 14 m and 20 m from V,
with a `Static` rejection from the current-position full-body check. A read-only
native probe measured Hanako's animation-root Z as 7.386871 and the walkable
navigation point at the same XY as 7.600006. The standing box began at root+0.1,
inside the support-height band, and reported a hit. The existing walking band
(root+0.35 to root+2.2) was clear in every collision group. Nearby real static
obstacles and the vehicle still reported hits with that band.

The new waypoint guard had introduced an overly strict full-body check at this
animation root; two earlier recovery checks had the same assumption. All three
actual-current-position checks now use the existing zero-length swept walking
box. Radius, top/head clearance, six collision groups, query cost and failure
semantics are unchanged. Projected destinations and spawn positions retain the
full standing-body check. No speed, follow distance or global collision margin
was changed. The temporary native probe helper was restored byte-for-byte.

### Developer movement trace

When Developer mode is enabled, the integration calls `movement-log.update` with
the current delta and `companions.movementSnapshot`. The snapshot copies cached
player and every tracked companion's motion, decision, command, route progress,
projection, last rejection and last command event. It makes no native queries.
At most two samples per second are appended to `runtime/movement-trace.ndjson`.
The active trace and its atomic rollover
`runtime/movement-trace.previous.ndjson` are each limited to 2 MiB. Valid files
survive a CET reload; disabling Developer mode stops sampling and file access.
