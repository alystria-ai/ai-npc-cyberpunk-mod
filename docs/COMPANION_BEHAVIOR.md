# Walking together, attention and safe invitations

## Findings from September 29

The player reported a sideways/backwards glide when companions reached V after
running. The audit found three independent sources of facing: catch-up always
set `lookAtTarget = player`, formation moves set a different facing target,
and gaze could interrupt movement through both the civilian native focus path
and the managed companion controller.

The installed REDmod `AIMoveToCommandHandler` only replaces its facing-entity
mapping for entity specs. Our conversation step set V as that entity; a later
world-point facing spec did not clear it. Rejoining now explicitly disables
`rotateEntityTowardsFacingTarget`. Only the accepted small conversation step
may face V while moving its feet. Ordinary paths own body direction.

The user confirmed F4 opens MCM, initially thought Johnny appeared on a lower
road, then clarified that Johnny seemed absent while Iris spawned normally.
The runtime found two Johnny copies beside V at the correct height. Both had
loaded meshes and an enabled `gamePhantomEntityComponent`. Disabling that
controller and sending `enteventsSetVisibility(visible = true)` on just one
owned copy made Johnny visible; the user confirmed this without a reload.
`companion-appearance.lua` now performs that preparation before reporting a
copy ready. Ordinary components and story/quest entities are untouched.

After V fell and died during the initial test, loading a save crashed. The dump reports
an access violation in `Cyberpunk2077.exe+0x53f9d4`, without identifying a Lua call.
The audit found retained actor/command references across unload and native
command queries in menu snapshots. Those paths are corrected; the precise
crash cause remains unconfirmed until an in-game reload check.

## Behavior cases

| Situation | Feet and body | Attention and transition |
| --- | --- | --- |
| Walking together | Stable side lanes, loose comfortable spacing; native navigation turns along the path. | Gentle eyes/head glance within a reasonable angle. Camera yaw never rotates formation slots. |
| Running or falling behind | Persistent native sprint/follow, with slightly different following distances by row. | Release social look-at and body turns. Distance hysteresis prevents rapid command switching. |
| Rejoining after catch-up | Walk into an acceptable spot for that copy's lane, facing along the route. | Defer direct gaze until arrival. |
| Short route substantially to the side or behind | Turn toward the route before starting locomotion. Native short-path walking can otherwise choose a backward/strafe gait even without a look-at. | Release social glance during that turn; bounded failure yields to native navigation recovery. |
| Settling | Cancel the finished approach and hold the accepted spot while the stop animation completes. | Measured speed must stay low for 0.65 seconds before attention takes over. |
| Standing together | Keep feet in place; tolerate variation from the exact slot. | Gentle side glance toward V, with no chest contribution or extreme backward look. |
| V takes a small step inside a resting group | Retain the stop's anchor and heading. Resume the group after V departs the local area, rather than on every movement sample. | The addressed character can turn; the whole group does not re-form around V. |
| V looks directly at a settled member | One approach/turn step of at most 16 cm, then a native rotation if needed. | Full eyes/head attention. Brief gaze loss/reacquisition does not repeat the step at the same stop. |
| V looks away | Keep the spot reached by the attention step; rotate back toward the group's travel heading once. | Return to a subtle glance. No second shuffle to an exact slot. |
| V moves during eye contact | Release the attention step, hold and rotation before submitting locomotion. | Full attention yields to walking or catching up. |
| Blocked route | Stop repeated formation requests; allow a bounded native follower recovery interval. | Release social facing, then retry ordinary formation. |
| Combat | Release all movement, hold and turn commands owned by the social controller. | Native combat takes ownership, even when V is looking at that character. |
| Death or save unload | Drop actor/command references and queued invitations without invoking old native components. | Resume on a new player attachment. Old temporary copies are not automatically recreated. |

Separate copies keep separate slots. Parking requires clearance from V and the
other members. Native pathfinding and each model's animation graph still own
the rendered gait; this controller does not manufacture animation or teleport
feet to simulate walking.

## Spawn and session boundaries

`companion-placement.lua` verifies navigation ground at V, tries a bounded set
of nearby positions, and requires a short reachable route on the same floor.
If none qualifies, the invitation reports a reason. Actual attached position is
checked again before assigning the follower role.

Copies explicitly disable `persistSpawn` and `persistState`, as documented in
[Codeware's DynamicEntitySpec](https://github.com/psiberx/cp2077-codeware/blob/main/scripts/World/DynamicEntitySpec.reds).
Death/detach callbacks suspend updates and drop references. Attach/control
callbacks permit a new session, followed by attached/alive/pregame checks.
Pause alone does not clear a party. Queued invitations cannot cross a save
boundary even when the logical player ID is reused.

## Evidence and remaining live checks

`party-list:<unique nonce>` writes the current phase/reason, last twelve
transitions, distances, speeds and spawn/current heights per copy. Snapshot
generation makes no native AI command queries.

Five old-code failures reproduced command-ownership defects before the changes.
The executable Lua harness covers catch-up, arrival, eye contact, departure,
gaze reacquisition, combat, camera-only turns, duplicate copies, blocked routes,
unavailable ground, disconnected floors, misplaced engine spawns and unload
with unusable native handles. These checks prove command selection/cleanup,
not visual animation.

September 29: **90 tests passed**, including the installed MCM API integration.
Additional tests reproduced both a short backward route without a preceding
turn and a 0.6 m step by V relocating the whole resting group. Both now pass.
The live motion trace also recorded backward root motion with our social
look-at disabled; field selection alone had not solved every native gait.

F4 entry, Iris spawning and the one-copy Johnny visibility repair are confirmed
by the user. Fresh Johnny invitations, save reload and the latest route-turn /
local-movement behavior still need live acceptance. The user explicitly reported
intermittent moonwalking after the first ownership fix; it is not marked solved.
