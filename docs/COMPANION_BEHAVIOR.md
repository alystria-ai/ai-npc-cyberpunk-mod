# Walking together, attention and safe invitations

This document preserves the earlier experiments and native facing discovery.
The current controller and the later arrival/coasting failure are described in
[COMPANION_MOVEMENT_DESIGN.md](COMPANION_MOVEMENT_DESIGN.md).

## Findings from September 29

The player reported a sideways/backwards glide when companions reached V after
running. The audit found three independent sources of facing: catch-up always
set `lookAtTarget = player`, formation moves set a different facing target,
and gaze could interrupt movement through both the civilian native focus path
and the managed companion controller.

The installed REDmod `AIMoveToCommandHandler` only replaces its facing-entity
mapping for entity specs. A live handler probe confirmed that our ordinary
walking command had `_rotateEntityTowardsFacingTarget = false` while
`_facingTarget` still referenced V (`1ULL`). Disabling the flag alone did not
clear the entity. `companion-locomotion.lua` now clears that typed object
argument after the native handler, only for the exact current travel command
issued by this controller on an owned copy. The conversation step keeps its
intentional facing target; unrelated commands and world NPCs are excluded.

The running game's reflected property is `outFacingTarget`, without the
`m_` prefix used in the bundled REDmod reference scripts. The first field-name
probe failed; runtime reflection established the actual property before the
fix was applied. No handler or execution-context references are retained.

Clearing the target in the live test stopped the repeated turn loop in the
trace: Judy settled facing V, with Johnny stationary separately. This is
measured engine behavior, not final visual acceptance of all walking cases.
The user then requested removal of the standing turn back to the group's
travel direction. That alignment phase has been removed. Small social foot
adjustments remain allowed; companions do not mirror V's camera yaw.

A separate regression reproduced a comfortable side spot being accepted and
then revoked on the next update for being 0.7 m from the exact formation seat.
Accepted spots now remain accepted for that stop. A walking leg also retains
steering ownership instead of being interrupted by repeated pre-turns.

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
| Short route substantially to the side or behind | Turn toward the route before starting a new walking leg. Once walking, navigation owns steering. | Release social glance during that turn; do not repeatedly interrupt the same walking leg to correct yaw. |
| Settling | Cancel the finished approach and hold the accepted spot while the stop animation completes. | Measured speed must stay low for 0.65 seconds before attention takes over. |
| Standing together | Keep feet in place; tolerate variation from the exact slot. | Gentle side glance toward V, with no chest contribution or extreme backward look. |
| V takes a small step inside a resting group | Retain the stop's anchor and heading. Resume the group after V departs the local area, rather than on every movement sample. | The addressed character can turn; the whole group does not re-form around V. |
| V moves very close to a settled companion's face | Stay in the existing stance; do not step backward to restore a player-distance buffer. | Normal eye/head attention remains available. Separation from another overlapping companion is handled independently. |
| V looks directly at a settled member | One approach/turn step of at most 16 cm, then a native rotation if needed. | Full eyes/head attention. Brief gaze loss/reacquisition does not repeat the step at the same stop. |
| V looks away | Keep the comfortable stance reached by the attention step. No automatic turn to V's camera or the group's travel heading. | Return to a subtle glance. No second shuffle to an exact slot; small social foot adjustments are allowed. |
| V moves during eye contact | Release the attention step, hold and rotation before submitting locomotion. | Full attention yields to walking or catching up. |
| Blocked route | Stop repeated formation requests; allow a bounded native follower recovery interval. | Release social facing, then retry ordinary formation. |
| Combat | Release all movement, hold and turn commands owned by the social controller. | Native combat takes ownership, even when V is looking at that character. |
| Death or save unload | Drop actor/command references and queued invitations without invoking old native components. | Resume on a new player attachment. Old temporary copies are not automatically recreated. |

Separate copies keep separate slots. New parking destinations require clearance
from V and the other members; V subsequently approaching a settled person does
not invalidate that stance. Native pathfinding and each model's animation graph still own
the rendered gait; this controller does not manufacture animation or teleport
feet to simulate walking.

## Spawn and session boundaries

`companion-placement.lua` verifies navigation ground at V, tries a bounded set
of nearby positions, and requires a short reachable route on the same floor.
It also checks the full standing body against native world/vehicle collision
groups. If none qualifies, the invitation reports a reason. Actual attached
position and body clearance are checked again before assigning the follower
role. [Clearance policy and native evidence](COMPANION_CLEARANCE.md) describe
larger model spacing, safe alternatives and the remaining gameplay checks.

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

The subsequent facing/stance update passes **95 tests**, with no skips,
including the installed MCM API gate. New regressions cover the retained native
entity, exact-command ownership during `SendCommand`, unrelated commands,
save-boundary ownership, explicit attention targets, accepted loose parking,
no repeated turn during one walking leg, and no look-away alignment turn.
All 18 Lua files compile. These are command/lifecycle checks, not visual proof.

F4 entry, Iris spawning and the one-copy Johnny visibility repair are confirmed
by the user. After the combined Lua update and CET reload, the user confirmed a
fresh Johnny is visible and the post-join confirmation appears (Judy and Johnny
both reached ready in the log). The next test reported repeated turning; the
retained-facing probe and cleanup above were performed in response. Save reload,
the removal of standing alignment and the complete run/stop/look sequence still
need live acceptance. Intermittent moonwalking is not marked solved.

Installed files were SHA-256 verified; the prior Lua is saved in ignored
`backups/companion-controls-20260929-013041/`. Local implementation checkpoint:
`e1b146d`. No native script restart was needed for this update.

The following stance/facing revision was installed and SHA-256 verified at
01:55 IST on September 29, with the preceding live Lua backed up under
`backups/movement-facing-20260929-015546/`. Checkpoint: `955b1d9`.
The user confirmed the CET reload; the log confirms reinitialization at
01:56:34 IST. Fresh Judy (`11034257ULL`) and Johnny (`11034258ULL`) both reached
ready. The permanent exact-command hook subsequently checked eight ordinary
walking commands and cleared two stale targets, with no error. The latest
trace shows both settled after movement and no active route-turn. This verifies
the native command-ID ownership gate as well as the cleanup. The old broad
test-copy probe was discarded by the reload. User visual acceptance of the
revised look/run/stop sequence remains pending.
