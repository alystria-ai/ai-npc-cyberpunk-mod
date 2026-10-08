# Companions sit with V

When V sits on a couch, bench, chair or bar stool, each nearby companion walks
to a free seat beside V on the same furniture (or the next stool or chair along
it) and sits with the game's own NPC sit animation for that seat type. They
stand up with the native fast exit when V gets up or moves away, or at once
when a fight starts. It is always on: there is no setting (the user's decision,
October 8; an old saved `sitWithYou` value is ignored). The only switch is
internal: an archive without the sit components disables it.
`mod/companion-seating.lua` is the controller.

## What the game offers (October 8 research)

- **V's sit is a workspot.** The player's sit workspots (`base\workspots\player\couch\player__sit_couch_lean_back__sit_around__01`,
  `player\bar\player__sit_barstool_bar_lean_*`, `player\barstool\player__sit_barstool__sit_around__01`, ...)
  play the same seated clips as the generic NPC sit workspots:
  `sit_couch_lean180__rh_on_couch__01`, `sit_barstool_bar_lean0__2h_on_bar__01`,
  `sit_barstool__2h_on_lap__01`, `sit_chair__2h_on_lap__01`. Same clips means the
  same placement convention, so an NPC workspot placed beside V's root sits at
  the same depth and height on the same furniture.
- **NPC sit workspots for all three companion rigs** (woman_base, man_base, man_big), each with
  stand and walk entries from several directions, slow exits and a fast exit with a stand-up clip:
  - couch: `base\workspots\common\couch\generic__sit_couch__sit_around__02.workspot`
  - chair (also benches and chairs at a table): `base\workspots\common\chair\generic__sit_chair__sit_around__01.workspot`
  - bar stool at a counter: `base\workspots\common\bar_and_barstool\generic__sit_barstool_bar_lean_front__sit_around__01.workspot`
  - free stool: `base\workspots\common\barstool\generic__sit_barstool__sit_around__01.workspot`
  (Bench and character-specific sit workspots, e.g. Rogue's or Johnny's, lack one
  or two rigs or have no entries; extracted summaries in
  `E:\CyberpunkConvai-offload\work\seat-workspots\summary.txt`.)
- **Native world seats are not reachable from Lua.** NPCs in the world sit on
  community spots: `worldAISpotNode`s in streamed sectors, not entities. Codeware
  has no spatial node query, `AIUseWorkspotCommand` needs a `NodeRef` we cannot
  find, and the targeting system only returns game objects. So companions sit
  through our own device entity (as gestures do) with the vanilla NPC workspot
  of the seat type, placed at a seat found by raycasts beside V.
- `WorkspotGameSystem.GetWorkspotInstance(entityID)` (Codeware) names V's
  workspot resource and animation; `IsActorInWorkspot(player)` is the cheap test.

## First probe: V's apartment couch (October 8, seat watcher)

V sat on the H10 couch with Judy nearby for about 5 s (`runtime/gesture-probe.log`
`seat-watch`, at 602-613):

- `IsActorInWorkspot(player)` true while seated; **`GetWorkspotInstance` returned
  nil** the whole time (no path, no animation), `GetExtendedInfo` entering/exiting
  always false, scene tier 4 while sitting down and getting up and 3 while seated,
  `PlayerStateMachine.IsInWorkspot` 0 → 1 → 0. So V's couch sit is a scene: the
  first build classified it `unsupported` and would have done nothing.
- V's root never moved while seated: it is the seat root, on the floor (z 48.62,
  rays in front hit 0.01 m). The cushion is 0.44-0.45 m above V's feet, its front
  edge 0.0-0.2 m behind V's root; to V's left it continues to about 1.1 m, then a
  higher armrest or side unit (0.50-0.59 m); to V's right there is only floor (an
  L-shaped section starts 1.2 m right and 0.2-0.5 m in front, facing another way).
- Judy stood 0.46 m left of and 1.15 m in front of V in behaviour phase
  `obstructed` with `ws:false`. The movement trace shows why: since ~25 s after the
  CET reload, before V sat, her move to a standing slot was refused by the motion
  clearance sweep (a Static box 1.27 m up, i.e. furniture or a shelf between her and
  the slot) and she waited for the geometry to change. That is the follow
  behaviour; it does not block seating (below).

Changes from it:

- **Furniture classification** when the workspot has no readable name
  (`M.classifyGeometry`, one update, about 12 rays): V's own seat surface 0.30,
  0.15 or 0.05 m behind the root; above 0.62 m a stool, or a bar stool with a
  counter (0.9-1.3 m) 0.4 m in front; otherwise a couch (the surface continues
  0.5 m to a side and a backrest 0.45 m further back is 0.12 m higher), a bench
  (continues, no backrest), a chair at a table (a 0.15-1.0 m surface in front) or
  a chair. A named workspot that `M.classify` rejects (a car, a device) still
  never seats anyone. Probe line `seat-classified` with `h0`, `sides`,
  `backrest`, `front`.
- **Settle and stand-up on the PSM**: seated once `IsInWorkspot` has been 1 for
  0.5 s; 1 → 0 while V is still in the workspot is V getting up, so companions
  stand together with V.
- **Depth and height**: seat samples 0.30 m behind the root for a couch (was
  0.15, which can miss a cushion whose front edge is 0.2 m back), 0.25 m for
  chairs and benches, 0.05 m for stools; same-seat tolerance 0.07 m for couches
  and benches (cushions are flat; the 0.50 m unit next to this couch is not a
  seat). The device stays on V's root line at V's floor height, where V's own
  workspot plays. On this couch: one seat, 0.66 m to V's left.
- **Obstructed companions**: the seat walk is a new ticket, so the actuator's old
  rejection is cleared. If the actuator still refuses it, or never takes it (its
  feedback stays on another ticket for 2 s), a companion within 1.8 m of the seat
  slides the rest; arrival distance 0.55 m. Judy, 1.2 m from the seat above, would
  sit with a ~0.9 s slide.

## Live run (October 8, 20:08Z): she did not sit

Archive and Lua installed, apartment couch: `seat-classified` **bench**
(`backrest` 0.63 over `h0` 0.44, `sides` 1) so the chair workspot was chosen,
one seat at −0.66, then `seat-abandoned` "route failed" 3 s later. The movement
trace: Judy stood 2.0 m from the seat (2.15 m from V) and the actuator refused
the single walk-up point at stage `destination` (the body box there overlapped
Static geometry, the same refusal her own standing slot got just before);
2.0 m was beyond the 1.8 m slide limit, so she gave up. Fixed: a backrest 0.12 m
above the cushion reads as a couch; walk-up retries at other distances and
angles, then a slide-in from up to 3 m, waiting for V to look away when the
slide is long (step 5).

## Live run 2 (October 8, 20:23-20:24Z): she sat, but stood up stuck

`seat-classified` couch, walk-up try 1 refused, try 2 reached, `seat-play`
slide 0.5, `seat-seated`: she sat beside V. When V stood, `seat-exit` and
`seat-finished` came in the same update: the fast exit left her root exactly on
the seat root (-1602.34, 356.24), at floor height but against the couch, so
every follow route was refused (Static, stages `path` and `destination`) and
she stayed there, "standing on the couch". The actuator's unstick step
(`8024797`) never fired: it reacts only to `origin` or `motion` refusals at her
feet, not `path`/`destination`. It also cannot put her on furniture: its
targets come from the navmesh within 0.3 m height and pass a body clearance
check.

Fixed: after the exit animation she **steps out** before following resumes
(phase `standing`, the body still held by seating). Stand spots, in order: the
spot she stood on when she arrived (if within 1.6 m of the seat), the walk-up
point she reached, then fresh walk-up points in front; each needs floor (one
ray) and room for her body (one clearance check). A short straight walk
(`actuator.board`, no navigation) takes her there; if she has not arrived
after 2.5 s, an AI teleport puts her on the same spot facing V's way. She is
handed back to following only when her feet are within 0.25 m of the floor
under her and her body has room; otherwise the next spot (at most six). Probe
lines `seat-step-out`, `seat-stand-teleport`, `seat-stand-rejected`,
`seat-stood`. Transport or an unobserved copy is released at once as before.

Several companions: each takes its own seat (a seat is taken by one companion
for the session), a companion with no free seat keeps its normal standing
place, and each seated one stands up and steps out to its own arrival spot.

## Live run 3 (October 8, 20:33Z): stop-start on the way

She sat and stood up cleanly, but stopped a couple of times on the way:
walk-up tries 1-4 were refused one after another ("No clear local walking
route", the actuator's navmesh projection and destination body check), each a
stop and a new walk, and try 5 (1.35 m out) worked; she then slid 0.5 s over
about a metre. Fixed:

- **Pre-check before moving** (phase `choosing`, she keeps her normal stance):
  each walk-up point needs floor (one ray), a navmesh point within 0.8 m (the
  same `FindPointInSphereForCharacter` the actuator uses), V's 0.95 m
  keep-out, no other companion's walk-up within 0.8 m, and room for her body
  (`companion-clearance` body check). A straight clear line from her (rays at
  0.5 and 1.2 m) ranks first and ends the check at once (a straight route is
  one smooth walk, no waypoint legs); shorter reaches rank before longer ones.
  Three points per update, six updates at most. Probe line `seat-walk-checked`
  (good, rejected, straight, last reason).
- **One refusal within 2.5 m of the seat goes to the slide** (waiting up to
  3 s for V to look away when it is longer than 1.2 m) instead of more walks.
  Farther away, the next pre-checked point is issued as the next decision,
  with no hold in between (unjudged points are checked then, a few at most).
- **Slide speed by distance** for every arrival: 0.5 s + 0.35 s per metre
  beyond 0.75 m, at most 1.4 s.

## Live run 4 (October 8, 20:47Z): she stood still

With the pre-check, 3.94 m out: `seat-walk-checked` good 1, rejected 9 (last
"no room"), the one walk refused, `seat-abandoned` route failed. The room check
is stricter than the real walk (the old build's fifth, unchecked point had
worked), and nothing was left to try. Fixed:

- **Fallbacks:** points that failed only the room check (floor and navmesh
  fine) are kept; with fewer than 3 good points they join the list after the
  good ones (`fallbacks` in `seat-walk-checked`, `fallback` in `seat-walk`).
- **Close in by following:** out of walk-up points farther than 2.5 m from the
  seat, seating gives no decision (phase `closing`), so her normal following
  brings her toward V, which works; within 2.5 m she slides in (a slide longer
  than 1.2 m waits up to 3 s for V to look away). After 6 s of closing in, a
  slide from up to 3 m is allowed. Probe line `seat-closing`.
- **Give up only after a real effort:** up to five walks, then up to 12 s of
  closing in; `seat-abandoned` now names every release before she sat.

## Live run 5 (October 8, 20:54Z): twisted legs after standing, no follow

Sitting worked in one go (try 1 straight, slide 0.78 s). On standing,
`seat-exit` and `seat-step-out` came in the same second: `IsActorInWorkspot`
turns false as soon as the fast exit starts, so the straight step walked her
(0.6-0.9 m/s from 20:54:30) while the stand-up clip was still playing. At
20:54:34 the follow behaviour's normal turn toward V (`attend_turn`,
AIRotateTo) ran on that mixed state and her shins crossed. Then every follow
route from the spot she reached (-1602.51, 357.78) was refused: the native
path's second leg met Static geometry 0.75 m away at 1.45 m height (stage
`path`), detours were exhausted, and the actuator's unstick step does not react
to `path` refusals; she stood there for minutes (movement-trace
20:55-20:56). Her arms-crossed pose is Judy's vanilla idle, not a gesture
stance. A read-only probe afterwards: no workspot, no workspot or slot
animation flags, follow `blocked`.

Fixed (seating only):

- **Wait for full release** (phase `leaving`, body still held): no workspot,
  no extended workspot state (active, entering, exiting, in motion) and no
  puppet `WorkspotAnimationInProgress` / `SlotAnimationInProgress` for 0.2 s,
  and at least 1.4 s after the exit request (0.3 s for the instant combat
  exit); at most 5 s. Probe line `seat-left`. Only then the step out; no
  rotation is applied by seating (the straight step keeps her facing; any turn
  toward V afterwards is the follow behaviour's normal locomotion turn).
- **Most open stand spot**: while she stands up, stand spots are judged two
  per update (floor, body room, then openness: clear straight lines 1.2 m
  long at 0.5 and 1.2 m toward V and to three sides) and the most open one
  wins; ties keep the order arrival, walk-up, fresh points. `seat-step-out`
  carries `open`.

Still open for companion movement: from a spot where every follow route is
refused at stage `path`, nothing moves her (detours exhausted, unstick only
fires on `origin`/`motion`).

## Live run 6 (October 8, 21:02Z): she gave up in the dead zone

4.37 m out, walk tries 1-3 refused, `seat-closing` at 21:02:35, but in the
movement dead zone by the couch every follow route is refused too, so closing
in made no progress and `seat-abandoned` came at 21:02:47. Fixed with the
lift's out-of-view placement:

- **Closing in that stalls** (no 0.3 m of progress toward the seat in 3 s)
  goes to phase `placing` (body held): the target is the pre-checked walk-up
  point nearest the seat (else a room-check fallback, else a fresh point with
  floor).
- **Placed out of view:** at 2 Hz, only while waiting, the lift's check: V's
  camera more than 60° off both her and the spot, or a blocked line from V's
  eyes (1.6 m) to her chest (1.2 m). Then an AI teleport onto the spot, facing
  the seat; after 0.8 s the usual stop, slide and sit. Probe lines
  `seat-placing`, `seat-placed`.
- **V keeps looking:** after 10 s, the short slide from where she stands when
  within 3 m (`seat-placing-slide`); farther away she keeps waiting.
- **Never gives up while V stays seated** (the close-in timeout is gone).

## Mechanism

`convai_gestures.archive` now also carries four components on the gesture
device entity, pointing directly at the vanilla workspots above:
`convai_sit_couch`, `convai_sit_chair`, `convai_sit_bar`, `convai_sit_stool`
(`assets/gestures/gestures.json` `seatWorkspots`; `mod/gesture-catalog.lua`
`seatComponents`). An older archive without them disables seating: the
controller checks the spawned device for the component before playing
(`seat-disabled`), so a Lua install before the game restart costs one walk to a
seat and nothing else.

1. **Detect V sitting.** Every 0.25 s at most, one `IsActorInWorkspot(player)`
   call while V stands. When it turns true, the workspot path and animation are
   read when the game exposes them and classified (`M.classify`): couch, bench,
   chair, chair at a table, bar stool at a counter, free stool. Vehicles
   (mounted, or a car/AV workspot), the ground, kerbs, rails, beds, wheelchairs
   and other named workspots are ignored. A scene sit has no name and is
   classified from the furniture after settling (above).
2. **Settle.** PSM `IsInWorkspot` 1 for 0.5 s (or, where it cannot be read, in
   the workspot and past its entry for 0.9 s); V's root position, forward and
   orientation then become the seat anchor.
3. **Find seats once.** Downward raycasts (Static and Dynamic) every 0.1 m
   along V's right axis from 0.45 m out to the furniture span (2.1 m for a
   couch), 0.1-0.15 m behind the root, one side per update (at most ~36 rays
   per update, two updates per sit). A sample is seat surface when its height
   above V's feet is in the seat band and within 0.12-0.15 m of V's own seat
   surface (so armrests, tables and the floor are not seats). Continuous seats
   (couch, bench) get centres at 0.66 m pitch along the surface; discrete ones
   (stools, chairs) take the middle of each separate run. Nearest to V first.
4. **Check a seat when it is assigned** (a few rays): no wall between V and the
   seat (a ray at 0.9 m), no other NPC within 0.45 m of it (one targeting query
   per sit, our companions excluded), and floor (not a table) at a walk-up point
   0.75, 1.05 or 0.55 m in front (couch, chair, bench) or behind (stools, bar,
   chair at a table). Seat rays use Static and Dynamic collision; floor rays
   also Terrain (some interior floors are Dynamic, outdoor floors Terrain).
5. **Walk.** A companion within 6 m takes the free seat closest to V (its own
   distance breaks ties, so two companions take opposite sides). The controller
   gives the companions loop a decision override, before `behavior.decide`: a
   normal Walk move to a walk-up point (the actuator plans and checks it like
   any other move). Walk-up points lie around the seat's approach side at
   0.75, 1.05 and 1.35 m and 0°, ±30° and ±55°, outside V's 0.95 m keep-out,
   nearest to the companion first, each with floor under it (one ray when
   tried). A walk refused for 0.6 s (or never taken by the actuator for
   1.5 s): within 1.2 m of the seat she slides straight in; otherwise the next
   point, up to five. Out of points within 3 m of the seat she slides in; a
   slide longer than 1.2 m first waits up to 3 s for V to look away (camera
   more than 40° off her). Farther than 3 m she gives up (`route failed`).
   Slide time 0.5 s + 0.35 s per metre, at most 1.4 s.
6. **Sit.** The move retires to a hold, then `PlayInDevice` with
   `PlayAtResourcePosition` and a 0.5 s slide: the workspot picks the entry for
   the companion's approach and the companion sits down. While the workspot
   holds the body, movement waits (the same body-owner contract as gestures).
   The companion looks at V (`side`, `full` while V talks to them; no chest
   part, as in cars).
7. **Stand up.** When V's PSM `IsInWorkspot` drops to 0, V's workspot reports exiting, V leaves the workspot, or
   V's root moves 1 m from the anchor: the native fast exit with default
   arguments, which plays the sit workspot's stand-up clip. Combat (V or the
   companion): the instant fast exit. Still inside after 3 s: one
   `StopInDevice`; after 6 s it gives up and cools down. Never
   `StopNpcInWorkspot` (it wedged the AI queue, docs/COMPANION_GESTURES.md).
   The device is deleted and following resumes on the next update.
8. **Edge cases.** No free seat: the companion keeps its normal standing place
   near V. Several companions: each gets a different seat. A companion taken by
   transport, a tactic, a departure or recovery travel stands up instantly.
   A failed sit (no entry, device
   timeout, refused route) cools that companion down for 30 s.

Talking while seated is fine: lip sync and expressions are facial and keep
working. Body gestures do not run in a seat yet (the gesture controller never
starts in a workspot it did not open). Seated talk clips exist for some seats:
`generic_female_average__sit_chair__2h_on_lap__01.anims` has 146 clips (talk,
yes/no, shrug, describe, what, ...), the bar-stool counter pose 5 `talk__0N`,
the couch pose almost none (`rh_flick`, `this_or_that`). Next stage: a seated
chair/stool talk family built from the sit workspot (its entries and exits
kept) and clip jumps while seated, behind the Body gestures setting.

## Ownership

`init.lua` builds the controller next to the gesture controller and dispatches
`companions.bodyAnimation`:

- `tick`: seating first, then gestures, then the probe;
- `steer(entry, context)`: seating only, called by `companions.lua` before
  `behavior.decide` for copies no tactic or departure owns;
- `observe`: the probe (when it drives a copy), then seating, then gestures;
  a seated copy is never offered to gestures;
- `release` / `abandon`: all three.

Globals `convaiSeating` / `convaiSeatingOptions` let the probe hot reload it.

## Cost

No per-frame work and no file I/O. While V stands: one native call at most four
times a second, nothing else. Per sit: ~80 raycasts over three updates, one
targeting query, a few rays per assigned seat, one device spawn per companion.
Seated: one `IsActorInWorkspot` per companion per update (the companions loop
runs at 10 Hz).

## Probe lines

With Developer mode on, `runtime/probe.log` gets `Seating <kind> {...}` lines:
`player-workspot` (path, anim, kind or `unsupported`), `player-sat`,
`seats-found` (V's seat height `h0`, count, NPCs near, and the full lateral
profile, `+0.6:0.42` = 0.6 m to V's right, surface 0.42 m above V's feet),
`seat-rejected` (`wall between`, `occupied`, `no floor to walk up`),
`seat-none`, `seat-assigned`, `seat-arrived`, `seat-play`, `seat-seated`,
`seat-exit`, `seat-escalated`, `seat-finished` / `seat-abandoned` with a reason,
`player-stood`. The gesture probe has `seating` (snapshot) and `reload-seating`.

Development research probes: `scripts\Send-GestureProbe.ps1 "run <name>"` runs
`runtime/<name>.lua` (a function of words and the probe) without a CET reload;
a probe may install a watcher (`probe.watchers[name] = fn`) that runs on each
companions update until it errors.

## Tests

`npm run test:gestures` includes `bridge/companion-seating.test.mjs` (Fengari):
classification by name and by furniture (the probed apartment couch), seat finding on couches/stools/armrests, the full sit and stand
flow, V getting up, combat (instant), several companions on different seats, no
seat, wall / occupied / table-in-front, vehicles and unsupported workspots, an old archive, a refused walk near and far, transport/unobserved
release, a walk the actuator never takes, the PSM settle and stand-up, the live apartment run (every walk-up refused 2 m out, slide after V looks away), the bounded wait, the step out after standing (arrival spot, teleport after a stuck step, a spot without room skipped), three companions on a two-seat couch, the walk-up pre-check (no refusals), a far refusal followed directly by the next walk, the 20:47Z replay (1 good / 9 no room, every walk refused, ends seated), the close-in timeout, no step while the workspot is busy, the most open stand spot, the fast combat exit, the 21:02Z replay (refusals, no progress closing in, placed out of view, seated), the never-give-up wait, the 10 s slide, and the standing cost (≤ 4 reads a second, no rays). 33 tests.

## To check in game

Install: **game restart** for the rebuilt `archive/pc/mod/convai_gestures.archive`
(from `runtime\gestures\package\`), plus `mod/companion-seating.lua`,
`gesture-catalog.lua`, `gesture-probe.lua`, `companions.lua`, `init.lua`,
`manager.lua`, `mcm.lua` and the 15 locales. Developer mode on for the lines.

1. V's apartment couch: sit with one companion standing nearby. `player-workspot`
   says `unnamed: classify by the furniture`, `seat-classified` kind `couch`
   with `h0` about 0.45; `seats-found` count 1 (0.66 m left); the companion
   walks around to the front and sits next to V, at the same depth and height
   (not floating, not inside the cushion or the backrest), facing the same way.
2. Talk to her while seated: lip sync and expressions work; she looks at V.
3. Stand up: she stands with the stand-up clip (`seat-exit` "V is getting up"
   or "V stood up") and follows again within about a second; no stuck
   `Enqueued` command (she walks when V walks away).
4. Sit at the far end of the couch: she takes the seat on the open side; with
   two companions, one on each side or two along the couch.
5. A bar counter stool (e.g. Lizzie's or the Afterlife), a free stool and a
   chair: the right pose for each (`seat-play` component), hands on the counter
   only at a counter.
6. A seat next to a wall or an armrest only: `seat-rejected` / `seat-none`, she
   stands nearby.
7. A seat where an NPC sits: she does not sit on them (`occupied`).
8. Start a fight while seated (or draw and shoot): instant stand-up.
9. Sit in a car: nothing from seating (vehicles are excluded).
10. Settings > Companion behavior has no Sit with you row, and the Characters
    sidebar's Behavior line does not name it.
11. FPS while V stands and while seated: unchanged.

If she floats or sinks, the seat depth/height is off: the `seats-found` profile
and `h0` say where the cushion is relative to V's root; the per-kind `back`
offset in `M.kinds` and the device placement are the knobs. If V's sit is not
classified (`unsupported`), the `player-workspot` path/anim tells which words
to add to `M.classify`.
