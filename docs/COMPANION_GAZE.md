# Adjustable companion eye contact

## Player controls

Companion Manager → Settings → Companion behavior contains two native selectors:

| Setting | Choices | Default |
| --- | --- | --- |
| Eye contact height | 10 cm lower, 5 cm lower, Default, 5 cm higher, 10 cm higher | Default, zero offset |
| Head tracking strength | Eyes only, Less, Gentle, More | Gentle, multiplier 1 |

Gentle retains the accepted focused head weight `0.18` and side-glance weight
`0.05`. Less multiplies those by `0.5`; More by `1.5`, bounded at `0.27` and
`0.075`. Eyes only sets the additional head weight to zero. Chest weight remains
zero in every mode. The selected companion can still make the existing single
body turn and small attention step; these controls do not redefine locomotion.

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

## Verification boundary

Source tests exercise unchanged defaults, world versus local offset arguments,
bounded/malformed input, settings migration and reload, failed-save rollback,
MCM selector/default/reset behavior, unchanged movement commands, native removal
and queue failures, combat cleanup, independent duplicate ownership, dismissal,
and manager-to-real-companion-actuator routing.

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
