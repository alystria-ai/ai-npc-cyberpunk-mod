# Native companion tick (plugin system `actuator`)

Port of system 2 in `docs/NATIVE_PORT_BRIEF.md`: the per-companion game reads of the 10 Hz companion tick.

## Live status (read from the dev game's probe.log, 2026-10-16 to 2026-10-21)

- Native and proven in about 30 sessions: `Native core: actuator parity proven over N senses (10 or more with the companion walking)`
  (N from 40 to 4,884), the canary line `parity checked 250 / 500 senses, 0 differences`, and no `PARITY MISMATCH` line in the whole
  log. `actuator.life`, `.sense` and `.state` all ran native.
- **The combat flag is read by Lua, not by the plugin.** Every session logs `actuator capabilities 63 (Lua keeps: inCombat)` and the
  proven line says `combat flag read by Lua (the plugin could not read it)`, and the RED4ext log has `Game access: no static function
  NPCPuppet.IsInCombat with 1 parameters (nothing under that name)`. The `IsInCombat;ScriptedPuppet` claim in "Behaviour" below did not
  survive the game: the plugin finds no function with that script name anywhere on the NPCPuppet class chain. The actuator is
  unaffected (Lua reads the flag, as before); the capabilities are 0x3f, not 0x7f. The same lookup is what `chauffeur` (section A) and
  `faces` (`Safe`) use.
- **Where the flag really lives (read from `r6/cache/final.redscripts`, 2026-10-21; header, 6 tables, 20-byte definitions
  `name parent offset size flags`, function bodies decoded for their references).** It IS a static function of NPCPuppet,
  `IsInCombat;ScriptedPuppet` (body flags: static, final; one parameter, a ScriptedPuppet), and its body is
  `IntEnum(npc.GetPuppetStateBlackboard().GetInt(GetAllBlackboardDefs().PuppetState.HighLevel)) == gamedataNPCHighLevelState.Combat`.
  Two members say the same thing: `NPCPuppet.IsPuppetInCombat()` (no parameters; its whole body is `IsInCombat(this)`; the base
  `ScriptedPuppet.IsPuppetInCombat()` has a 3-byte body, read as a plain return of false) and `ScriptedPuppet.GetHighLevelStateFromBlackboard()`
  (the same blackboard read, answering the `gamedataNPCHighLevelState` enum). PlayerPuppet's `IsInCombat;` and StealthMappin's
  `IsInCombat` are other functions. So the definition is there and the game's RTTI lookup by the class chain does not show it
  (why is not known offline: script-defined statics may only be listed in the game's function lists).
- **The fix (branch `feat/natives-on`).** `convai::game::PuppetInCombat` (`native/core/src/plugin/GameAccess.hpp`) reads the flag
  through the first route that resolves, once, in this order: (1) the static on the class chain, (2) the same static in the game's
  list of every class function (full name `NPCPuppet::IsInCombat;...`), (3) the same static as a global function (RTTI table and
  list), (4) the member `NPCPuppet.IsPuppetInCombat()` (chain, then list; only NPCPuppet's own, the base one always answers false),
  (5) the member `ScriptedPuppet.GetHighLevelStateFromBlackboard()` compared with the value of `gamedataNPCHighLevelState.Combat`.
  The RED4ext log says once which route resolved (`Game access: combat flag read through <route>: <function>`) or, when none did,
  every candidate tried plus what the NPCPuppet chain and the function lists do hold under the names (`Game access: combat flag:
  no route resolved ...`, 4 lines); `ConvaiNative.GameProbe()` and `Status()` carry `"combat":{"route":...}`. With no route the flag
  is unknown, as today: the actuator's flag, the faces `Safe` check (-1) and the chauffeur's calm flag are left to Lua. The
  chauffeur section A no longer fails the whole sample for it (calm is `?` and the shim asks `NPCPuppet.IsInCombat` itself).
  `StaticFunction` gained the same two list lookups for every static of a script class (PlayerPuppet.GetCurrentVehicleState,
  StatusEffectSystem.ObjectHasStatusEffectWithTag), read at the first miss of a name and every 256th.
- **Safety nets for a route that reads wrongly.** The actuator's parity proof compares the plugin's flag with Lua's on every counted
  sense; combat differences no longer count toward the three that switch the whole actuator off: after three, only the plugin's
  combat read goes back to Lua (`Native core: actuator combat flag: the plugin and the game differ ...`) and the proof goes on. The
  faces `Safe` answers newly reach the scene and injury checks, so the first 40 are compared with the Lua check (the Lua answer is
  used; a difference puts `faces` on Lua).
- Never A/B-measured, and no native-path number survives: `runtime/perf-probe.json` keeps only the last 5 minutes, which (2026-10-20,
  23:12Z) had no companion (no `actuator=native` line that session) and no `tickNative.*` row. The Lua path measured `companions.update`
  7.6 to 8.8 ms/s (2026-10-12 captures, `docs/PERFORMANCE_NATIVE_PLAN.md`); the 10-13 note that proven native read 1.5 to 2 ms/s higher
  at matched FPS was not a controlled comparison.
- The last session with a companion and the actuator was 2026-10-20 12:46Z (canary: 500 senses, 0 differences).

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
  state changes in between. It is the static `NPCPuppet.IsInCombat(puppet)`, registered by the game as
  `IsInCombat;ScriptedPuppet` (live 2026-10-13: a lookup by the plain name found nothing, so Lua read the flag
  every tick); `convai::game::StaticFunction` finds it by script name and parameter count. Log:
  `Game access: static NPCPuppet.IsInCombat resolved as IsInCombat;ScriptedPuppet`, then `Actuator: combat flag read
  through NPCPuppet.IsInCombat;ScriptedPuppet`, and `Actuator: capabilities 0x7f (all)`. The combat flag is part
  of the parity proof: every counted sense compares it with `NPCPuppet.IsInCombat`, a mismatch is logged as
  `PARITY MISMATCH in combat`, and the proven line says `combat flag read by the plugin, compared N times` (or
  `read by Lua (the plugin could not read it)`).
- World policy: Lua passes only the mod-spawned copies in `entries` (state `ready`) and the command it owns.
  The plugin never enumerates NPCs, so ordinary NPCs and game-placed characters are never touched.

## Switches

- `runtime/native-off.txt`: a line `actuator` (or `all`). The CET console cannot reach `convaiNative` (each CET mod has its own
  environment), so this file is the only route. The plugin re-reads it about once a second. Sub-switches send one part back to
  the game's own reads and leave the others native: `actuator.life`, `actuator.sense`, `actuator.state`.
- `runtime/native-verify.txt`: a line `actuator` (or `all`; `#` starts a comment) keeps the Lua reads in use and compares every
  plugin read with them.
- Parity proof: the plugin's reads are not used until 40 senses (10 of them with the companion walking faster than 0.5 m/s) matched
  the Lua reads with zero differences; then `Native core: actuator parity proven over N senses (M with the companion walking); the
  plugin reads are in use`. Afterwards every 100th sense is compared (canary). A difference logs
  `Native core: actuator PARITY MISMATCH <field>: plugin X, Lua Y`; the third one switches the system off for the session
  (`Native core: actuator=lua (native call failed: parity: ...)`).
- While the proof runs every plugin read is made twice (plugin and Lua), so a companion that stands still would keep
  the window open at about twice the plain cost. After the first 40 senses only the walking is missing, and the
  window narrows to one sense, one life read and one state read in four unless the companion walks (same checks, a
  quarter of the cost). A proven window is never reopened.
- Perf rows (Developer mode, `runtime/perf-probe.json`): `tickNative.life`, `tickNative.sense`,
  `tickNative.commandState` (the shim's own cost, window and proven), next to `companions.update`. To A/B the
  actuator, put `actuator` into `runtime/native-off.txt` for 60 s with the companion doing the same thing, compare
  `companions.update` at the same FPS (it scales with the frame rate), and remove the line.
- Three native faults switch it off for the session.
- `probe.log` shows `Native core: actuator=native (...)` or `=lua (reason)` on the first use and on every change,
  then `Native core: actuator capabilities N (all)`.
