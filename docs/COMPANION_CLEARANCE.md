# Companion placement clearance

`companion-placement.lua` used to accept a navigation point and a short path on
V's floor. A parked vehicle or movable prop can occupy that valid navmesh.
`companion-clearance.lua` now checks the standing body before creation, and
`attachFollower` repeats the body and person-spacing check at the actual engine
position before assigning the owned follower role.

Placement retains the floor, path length and route-height limits. It tries at
most 23 positions: seven around the preferred formation slot, then two rings
around V. It reserves pending copies as well as attached ones. No clear fit,
missing spatial API or non-Boolean native result refuses placement with a
reason. It never substitutes an unchecked teleport. Vehicle/fast-travel
recovery uses the same placement function and body profile. Entity creation
still sets both persistence flags to false.

A standing fit is not enough. On October 5 Blue Moon was placed where her
standing box was clear but every walking sweep, even 0.13 m, hit Static
0.63 m or more above the floor; she never left the spot. A candidate now
also needs a clear swept exit: up to 1.5 m back along its native route toward
V, using the same `clearance.segment` sweep as walking. This adds one box
(six queries) per accepted candidate, inside the shared frame budget.
Evidence: `runtime/follow-cycle-retarget-20261005`,
`runtime/blue-moon-support-20261005.json`.

The standing volume uses a 0.4 m half width and a 2.1 m height for recognized
roster humanoids. Smasher record/variant names, model names and roster keys, and
unrecognized model-browser entries use a conservative 0.9 m half width and
3.0 m height. These are clearance policies, not measured mesh bounds; the typed
pre-spawn record API does not expose universal rig dimensions. Assigning a
different conversation profile to a copy does not change its body profile.
Person spacing uses both bodies' radii plus 0.1 m, and larger bodies keep more
space from V. The profile survives a vehicle handoff and fast travel.

The query is centered in **world space** at feet + half height + 0.1 m, with half
extents `(radius, radius, height / 2, 0)` and Euler rotation. It checks `Static`,
`Dynamic`, `Vehicle`, `Terrain`, `Collider` and `Destructible`. The Boolean from
`Overlap` is the collision result. A returned `TraceResult` can contain infinity
coordinates even for a valid hit; its coordinates never decide clearance.
There is no guessed character collision group or collision disabling. V and
managed companions are checked through their positions and body profiles.

The walking actuator shares this adapter. It checks a continuous oriented box
along each nav route leg, splitting at 2 m length or 0.2 m rise, with a maximum
of 64 subdivisions. The path volume allows a 0.35 m foot band for steps; standing
destinations use the stricter 0.1 m band. Native navigation remains responsible
for floor support, steps and the walk path.

## Native evidence and verification

The October 2 integration adds one shared budget of 192 native overlap/raycast
queries per CET update, started before manager queues drain. The same explicit
Lua budget object is injected into each separately loaded adapter. A long path
keeps its cursor and resumes next update; a deferred check preserves the owned
hold, invitation and retry counters. Direct controller callers also create a
bounded frame. Eight clear, flat six-metre follow admissions fit within the
budget. These are verified query counts, not a gameplay timing benchmark.

The combined October 2 source gate passed 1,947 tests with current native source
and installed MCM checks enabled. It includes regression tests for geometry,
deferred work, queue ownership and ordinary companion behavior. Installed
spawning and walking still need the user's live check.

The exact installed 2.31 sources under
`E:\SteamLibrary\steamapps\common\Cyberpunk 2077\tools\redmod\scripts` were read:

- `core/systems/spatialQueriesSystem.script:9` declares the typed `Overlap`
  API. `SpatialQueriesHelper.HasSpaceInFront` uses half extents, center above
  feet, Euler rotation and `!hit` for free space.
- `cyberpunk/ai/Tasks/aiStatusEffectTask.script:519-540` uses the same standing
  fit geometry against `Static`, `Dynamic` and `Vehicle`.
- `cyberpunk/ai/commands/aiFindTeleportPositionForTakedown.script:126-130`
  supplies the additional `Terrain`, `Collider` and `Destructible` groups.

The read-only in-game receipt
`runtime/verification/clearance-live-20261002.json` confirms actual CET Boolean
returns for all six groups. The Porsche center hit `Vehicle` for both body
profiles; V and nearby pavement were clear. A larger nearby volume also hit
`Dynamic` and `Collider`. This confirms binding and sampled geometry behavior;
it does not qualify the changed installed invitation or movement flow.
The supplementary read-only receipt
`runtime/verification/clearance-live-managed-20261002.json` samples the actual
managed Judy at her feet. Both body profiles return false for all six groups,
with no native-call errors, so the tested actor does not collide with herself
through these world queries.

`bridge/companion-placement.test.mjs` executes production Lua against geometric
solid-box intersections with deliberately open navmesh. The two core cases
failed before the fix: a parked-car spawn and creation on a fully blocked
floor. Coverage includes six collision groups, feet/head/side extents, native
Boolean and unavailable-result handling, engine displacement, car arrival
before attachment, pending/large body reservations, floor preservation and
vehicle recovery. Live invitation, unusual rigs and sloped/stair locations
still require gameplay verification.
