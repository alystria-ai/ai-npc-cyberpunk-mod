# Native companion tick (plugin system `actuator`)

Port of system 2 in `docs/NATIVE_PORT_BRIEF.md`: the per-companion game reads of the 10 Hz companion tick.

## What moved

`companions.update` senses each ready companion every tick, and `companion-actuator.lua` reads the
state of the companion's owned AI command. From CET each of those reads is a native call (about 25 us each
in the 2026-10-12 perf probe: 0.86 ms for a tick of 30-40 calls), plus property reads on the returned
Vector4 and command objects.

| Before (per companion per tick) | After |
|---|---|
| `IsAttached`, `IsDeadNoStatPool` | `ConvaiNativeActuator.Life(npc)` |
| `GetWorldPosition`, `GetWorldForward`, `GetAIControllerComponent():GetCommandState(command)`, `command.id`, `NPCPuppet.IsInCombat`, and the speed, heading, player distance and facing maths | `ConvaiNativeActuator.Sense(npc, command, ...)` or `SenseIdle(npc, ...)` |
| `currentCommandState` (`IsAttached`, `GetAIControllerComponent`, `GetCommandState`; runs every tick while a companion is blocked or waiting) | `ConvaiNativeActuator.CommandState(npc, command)` |

That is 7 game calls (and about 7 property reads) down to 2 plugin calls per companion per tick.
`Sense` returns one line of 14 numbers (`flags x y z w fx fy state id speed dx dy gap facing`) that
`mod/companion-tick-native.lua` decodes into the same fields the Lua computed.

Not moved: the route planner, waypoint and clearance maths in `companion-actuator.lua`. They work on
small Lua tables and make no game calls of their own, so marshalling them into C++ would cost more than
it saves. Clearance queries are system 3, command issue and cancel stay in Lua (they are rare and own the
command handles).

## Behaviour

- Same values as the Lua: the maths follows `companion-space.lua` operation for operation in doubles;
  `native/core/tests/fixtures/actuator-sense.json` is recorded from the real `companions.lua` and replayed
  by `actuator_tests.cpp` at 1e-9.
- Every read the plugin cannot make comes back as "unavailable" and Lua makes that one read itself
  (a patch that renames a game function costs speed, never behaviour). The plugin reports which functions it found
  (`Capabilities()`, logged once as `Native core: actuator capabilities N`); without the four body reads
  the system stays on Lua.
- The combat flag is read inside `Sense`, a few milliseconds earlier in the same tick than the Lua read; no game
  state changes in between.
- World policy: Lua passes only the mod-spawned copies in `entries` (state `ready`) and the command it owns.
  The plugin never enumerates NPCs, so ordinary NPCs and game-placed characters are never touched.

## Switches

- `runtime/native-off.txt`: a line `actuator` (or `all`); `convaiNative.off('actuator')` / `.on('actuator')` in the CET console.
- Three native faults switch it off for the session.
- `probe.log` shows `Native core: actuator=native (...)` or `=lua (reason)` on the first use and on every change,
  then `Native core: actuator capabilities N (all)`.
