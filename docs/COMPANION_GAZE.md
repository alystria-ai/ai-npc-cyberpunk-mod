# Adjustable companion eye contact

## Player controls

Companion Manager → Settings → Companion behavior contains two native selectors:

| Setting | Choices | Default |
| --- | --- | --- |
| Eye contact height | 10 cm lower, 5 cm lower, Default, 5 cm higher, 10 cm higher | Default, zero offset |
| Head tracking strength | Eyes only, Less, Gentle, More | Gentle, multiplier 1 |

Gentle retains the accepted focused head weight `0.18` and side-glance weight
`0.05`. Less multiplies those by `0.5`; More by `1.5`, bounded at `0.27` and
`0.075`. Eyes only sets the additional head weight to zero. Standing requests retain
their accepted zero-weight Chest entry; seated requests omit Chest entirely.
The selected companion can still make the existing single
body turn and small attention step while on foot. Seated attention uses only
the eyes and head; the vehicle controller owns body movement.

The selectors use the existing MCM controls and label styling. Their defaults,
drafts, Apply, Revert and reset semantics use MCM's ordinary settings flow.

## Native target semantics

Keep the native target attachment `pla_default_tgt` on the current player.
The third argument of `LookAtAddEvent.SetEntityTarget` is named
`targetOffsetEntity` in the native reflection, while the slot-provider factory
names its offset `localOffset`. It is not an explicit world-height control.

For a nonzero height, the actuator calls
`event.targetPositionProvider:SetWorldOffset(Vector4.new(0, 0, height, 0))`.
That provider exposes a separate world offset in the native SDK. This makes
height world-vertical while the native player attachment still follows V.
At the default zero height, the provider setter is not called: the accepted
target arguments and existing `calculatePositionInParentSpace` policy remain
unchanged.

Primary evidence inspected on September 30, 2026:

- [NativeDB class reflection](https://raw.githubusercontent.com/rayshader/cp2077-nativedb/master/src/assets/reddump/classes.json): `LookAtAddEvent`, `SetEntityTarget`, `targetPositionProvider`, slot-provider factory and `SetWorldOffset` signatures.
- [RED4ext IPositionProvider structure](https://raw.githubusercontent.com/WopsS/RED4ext.SDK/master/include/RED4ext/Scripting/Natives/entIPositionProvider.hpp): independent `worldOffset` field.
- [WolvenKit scene-target schema](https://github.com/WolvenKit/WolvenKit/blob/main/WolvenKit.RED4/Types/Classes/scnAnimTargetBasicData.cs): default `pla_default_tgt` slot and `targetOffsetEntitySpace` naming.
- Installed reference game scripts use the same slot in ordinary reaction
  look requests: `vendor/reference-game-scripts/scripts/core/components/scriptComponents/reactionComponent.script`.

These sources establish the coordinate contract and available methods. They do
not establish the exact attachment position or visual gaze result on every rig.

## Ownership and settings lifecycle

- `manager.lua` validates only the exposed height/strength choices, preserves
  valid saved values, and migrates missing or damaged fields independently to
  their defaults. Unrelated settings and future fields remain intact.
- Apply saves the whole settings transaction before exposing the policy. A
  failed save leaves the previous policy active. The settings getter and choice
  lists return copies, so UI consumers cannot mutate persisted state.
- The manager assigns a pure gaze-settings supplier to the owned companion
  runtime. The normal gameplay update reads it once for the group and passes it
  to each exact-copy actuator. The MCM callback performs no gaze queueing or
  added widget refresh, preserving the stack-safe menu path.
- The actuator's look cache compares style, height and strength. A changed
  configuration prepares its new target before retiring the exact old event.
  It then replaces the owned look once, leaving the movement command/ticket
  untouched. Repeated unchanged updates do not reissue native look events.
- A native removal error retains the original handle and prevents adding a
  second look. Removal retries respect a three-second interval, including
  repeated combat release updates. A queue exception after a possible side effect retains the new
  handle for exact retirement on retry. Another subsystem's look event is not
  removed.
- Combat and dismissal release the owned look. World abandonment drops its
  stale references without querying destroyed actors. New copies read the
  saved policy on their ordinary first update.

## Seated companions

The transport handoff removes the walking look. A separate gaze-only update
can then attend to V after the companion's mount command has finished, its
actual vehicle and seat match the controller, and V is actually mounted in a
different seat of that same car. V must be in the native `Driving` or
`Passenger` state. The same seat must remain eligible for half a second before
the selected companion gets a full eye/head request without a Chest part. The actuator
never senses, cancels, or submits a locomotion command in this seated path.

A passenger's look follows the car's speed: the full look (eyes and a head turn) up to about 8 m/s, the narrow one
(eyes and a small head turn, head weight 0.05) up to about 20 m/s, none faster, each limit with a 2 m/s margin so a
speed that hovers at one never swaps the request. Seated requests are wider than standing ones (full: soft 100 /
hard 150 / back 150 degrees; narrow: 60 / 120 / 150, against 70 / 120 / 120 and 45 / 100 / 120 on foot) because
V sits side by side with her, about 90 degrees off her forward axis, between the standing soft and hard limits
(a look faded to about 60 percent). They are also solved in the car's space (`calculatePositionInParentSpace`),
as the game's own in-vehicle look-at does. Each change of the seated attention (selected or not, the gate that held
it back, the style, a look error) writes one `Companion recovery seated-gaze {...}` line to probe.log, never one per tick.
Live 2026-10-13: Judy did not look at V in a car; `seated-look-skip {"reason":"in a vehicle"}` in the same log is V's
own camera widening (`mod/seated-look.lua`), not her gaze. The failing gate was not logged, which the new line fixes.

Combat, boarding, exit/scene transitions, mount loss, a different car, focus
loss and fast travel remove the owned look. A driver gets no social look above
0.5 m/s or with unknown speed; stopping must satisfy the same settling interval.
Failed look removal retains the exact event and retries on the existing bounded
interval. Walking cannot resume by replacing its actuator while that seated
event remains owned. World teardown discards references without native calls.

Native targeting can omit a passenger, so the selector also considers managed
copies with a confirmed seat in V's current car. These candidates use their
actual `Head` slot world position. Standing candidates keep the existing
selection geometry. An unavailable head slot cannot fabricate a seated target.

The installed 2.31 REDmod sources confirm `NPCPuppet.HasHeadUnderwater`'s
`GetSlotComponent().GetSlotTransform('Head', out WorldTransform)` and
`WorldPosition.ToVector4(WorldTransform.GetWorldPosition(...))` conversion,
`PlayerPuppet.GetCurrentVehicleState`, and the mounting-facility identity fields.
The October 2 read-only seated probe verified the CET call takes **one input**
and returns both success and the transform. Judy's sampled head was about
0.669 m above her root; the previous fixed 1.3 m estimate was above her face.
That probe verifies the native geometry call, not visual head-turn acceptance.
The local readback is retained in
`runtime/verification/seated-head-slot-live-20261002.json`.

The user subsequently confirmed the head turn but reported a hand stuck to the
knee. Their screenshot showed the upper body rotated against the passenger hand
pose. Installed `reactionComponent.script:3505-3507` passes `inVehicle=true` for
mounted actors; `4656-4674` then omits Chest instead of setting its weight to zero.
The seated request now follows that part list, preserving the accepted standing
request and the native seat/hand animation. After the October 2 CET reload the
user confirmed: the arm looks natural while she turns her head. This qualifies
that observed Judy passenger pose, not every vehicle/model combination.

## Verification boundary

Source tests exercise unchanged defaults, world versus local offset arguments,
bounded/malformed input, settings migration and reload, failed-save rollback,
MCM selector/default/reset behavior, unchanged movement commands, native removal
and queue failures, combat cleanup, independent duplicate ownership, dismissal,
and manager-to-real-companion-actuator routing.

Seated regressions also execute the real companion update through boarding,
same-car riding, native combat/transition changes, lost or foreign mount links,
fast travel, failed look removal and walking resumption. The seated actuator
tests make any AI command read/submission fail and verify driver release at
speed. Targeting tests execute the actual `targetAtCrosshair` source with
seated head geometry, native candidate omission, and the standing path.

The settings fixture now records persistence at the successful file rename,
rather than treating JSON serialization as a committed save. This distinguishes
a serialized-but-unwritten policy from the actual prior persisted settings.

September 30 source gate: **136 passed, zero failures/skips** across gaze,
manager, movement, behavior, command ownership, equipment and menu exit checks.
The manager gate executed the installed MCM API modules, including real draft,
Apply, Revert and reset-to-default calls for the two new selectors. The local
test receipt is retained outside Git in
`runtime/gaze-settings-tests-20260930.log`.

No live installation, API request, game input or native visual acceptance is
performed by these tests. The first in-game check should confirm that the two
selectors render with native red labels and cyan option boxes, a changed height
adjusts only the gaze, and Default/Gentle restore the accepted look. Check the
same settings with V standing and crouching before qualifying every camera pose.
