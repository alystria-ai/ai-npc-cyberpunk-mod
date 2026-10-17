# Companion improvements from a spawner's companion code (2026-10-17)

On 2026-10-17 we read a widely used character spawner's follower, movement, vehicle and combat code. We read it only as data: nothing was run and nothing was copied. This list ranks what our companion modules could learn from it, by player impact against risk. FPS and latency come first: nothing here adds per-frame main-thread work. Every item applies to our own spawned copies only. Spawned characters from other mods get nothing here (`docs/SPAWNED_CHARACTERS.md`), and story NPCs get nothing at all.

## How the spawner does it

- **Following.** It gives each NPC the follower role and puts it in V's attitude group. Its follow command sets a desired distance, matches V's speed, keeps a 2 m tolerance and looks at its target. The distance is a setting (close, nearby, default) and grows with the party size.
- **Catch-up.** A 1 Hz timer re-sends the follow command when a follower is beyond its distance, and turns the follower toward V on arrival.
- **Fast travel.** After the loading screen ends, it AI-teleports everyone 2 m behind V. There is no view check and no navmesh test.
- **Elevators.** Its elevator follow is commented out.
- **Vehicles.**
  - Seats are found by checking standard seat slot names on the vehicle.
  - Followers mount with the AI mount command.
  - A follower with no seat holds position until V gets out, then teleports 5 m behind V.
  - The driver follows V's puppet with the vehicle follow command: kinematic, no traffic, the minimum distance stacked per car (+8 per car, +3 for a bike).
  - Drives to a map pin use a to-node command with forced green lights.
  - It adds an AI agent component to every vehicle in the world.
- **Weapons.** It uses the AI's switch-to-primary or switch-to-secondary weapon command, without unequipping. An explicit equip command with the item ID and a 1 s duration is the second path.
- **Combat.** It sets an aggressive reaction preset, triggers combat at the target through the reaction component, and makes the attitudes hostile both ways. Damage multipliers hook a per-hit engine function.
- **Respawning instead of re-roling.** Crowd NPCs can change AI role only once, so it respawns them rather than converting them. This confirms our choice of non-crowd clones.
- **Poses and freeze.** It uses workspots, time dilation 0, and a reaction-stimulus look-at.

## Ranked list

### 1. A far straggler rejoins even while V looks back (high impact, low risk)

**Problem.**
- The `far` rule (`mod/companions.lua`, the rule selection near line 2088) relocates a follower more than 60 m back after 2 s (`catchUp={distance=60,after=2,...}`, line 1251). It always passes `watched=false`.
- The guard at line 2100 (`if not watched and not hiddenFromPlayer(player,entry.position)`) then logs `waiting-in-view` and returns. A follower that V can still see, for example on a long straight street, is stranded until V turns away, and only the native sprint ramp (`pace`) brings it closer.
- The comment above `catchUp` still says 25 m, but the value is 60 m.

**Technique.**
- The spawner teleports with no view check at all. We keep our out-of-view rule but bound the wait: after `catchUp.watchedAfter` (say 6 s) beyond 60 m, `far` may leave in view, provided the arrival spot itself is hidden.
- `relocate` already chooses a hidden arrival spot behind V. At 60 m or more, the copy is a few pixels tall when it vanishes, which is the least noticeable pop we can have.
- Fix the stale comment at the same time.

**Files.** `mod/companions.lua`: the `catchUp` table and the `farReady` and `watched` choice in the rule selection.

**Risk.** Low. The rule is gated by distance and time, uses the existing relocation and placement checks, and adds no new native calls.

**Verify.**
- Movement trace (`runtime/movement-trace.ndjson`, Developer mode): count `waiting-in-view` events with `rule=far` before and after, and check that `relocated` follows within about 6 s.
- `scripts/Capture-GameWindow.py` at the arrival moment: the follower appears from behind V, not in front.
- Unit tests: extend `bridge/companion-placement.test.mjs` or `bridge/companion-motion.test.mjs` with a watched far follower.

### 2. Filter the MoveTo hook in redscript (FPS, medium risk)

**Problem.**
- `mod/companion-locomotion.lua:43` observes `AIMoveToCommandHandler.UpdateCommand`. That runs every AI tick for every NPC in the world that is walking on a MoveTo command.
- The Lua handler returns early on `M.active`, but `docs/PERFORMANCE_NATIVE_PLAN.md` (table row 10, line 171) records that each call still pays the CET trampoline. With a party it also does a `GetOwner` and an ownership loop for each walking NPC.
- The hook has no measured row yet (line 67), and the planned redscript filter (line 290) was never built.

**Technique (ours).**
- The spawner has no per-frame hooks at all: its follow logic is a 1 Hz timer. That is the bar.
- Add a Bool field to `AIMoveToCommand` that our motor sets on the commands it creates, through one redscript helper.
- A `@wrapMethod(AIMoveToCommandHandler) UpdateCommand` calls the original, then calls an empty mod-only static method only when the flag is set. Lua observes that method instead of the engine one.
- Vanilla NPCs then cost one Bool read in native script and never enter Lua.
- The same pattern can follow for the reaction-manager hooks in `mod/vanilla-reactions.lua`, as a separate item.

**Files.**
- New `r6/scripts/CyberpunkConvai/Locomotion.reds`, added to the packaging lists
- `mod/companion-locomotion.lua`: observe the mod-only method, and mark the commands where `ownsCommand` tracks them
- `bridge/companion-motion.test.mjs` contracts

**Risk.**
- Medium: it wraps a hot engine method. The wrapper must always call `wrappedMethod` first and must never change its result.
- The old hook stays behind a kill switch for one release.

**Verify.**
- The perf probe (`mod/perf-probe.lua`, Developer mode): frame-time and hook rows with 3 companions walking through a crowd, before and after.
- Movement trace: catch-up pace values unchanged.
- `scripts/Compile-Redscript.ps1`.

### 3. Weapon draw through the AI's own switch-to-primary command (medium-high impact, low risk)

**Problem.**
- `N.drawWeapon` (`mod/companion-tactics.lua` around line 100) sends a bare `AIEquipCommand` with only the right-hand slot. This guess has never been tested live (`TODO.md` line 280).
- Alex fled when V was attacked on 2026-10-11 (`TODO.md` line 630). The armed clone fixed the abilities, but nothing makes an empty-handed companion draw once combat begins.

**Technique.**
- Send the switch-to-primary-weapon command first, with unequip off. If the hand is still empty after about 1 s (`N.weapon` reads it), send an explicit equip with the clone's primary item ID and a short duration override. The bare slot equip becomes the last resort.
- Send one draw when a companion enters combat empty-handed. This is event-driven (combat-state change), not polled.

**Files.** `mod/companion-tactics.lua` (native adapter, draw and cancel), `mod/companion-equipment.lua` (primary item lookup for the clone), `bridge/companion-tactic-actions.test.mjs`, `bridge/companion-equipment.test.mjs`.

**Risk.** Low. These are the game's own AI commands, they are cancellable through the existing `N.cancelDraw`, and nothing runs per frame.

**Verify.**
- `probe.log` lines starting `Companion tactic:` show the draw path taken and the read-back.
- `scripts/Capture-GameWindow.py` shows the weapon in hand.
- There is no scripted combat probe today. Adding a `scripts/Send-TacticProbe.ps1` in the style of `Send-GestureProbe.ps1` needs the user's approval before it sends game input.

### 4. Start the tactic attack through the reaction component (high impact, medium risk)

**Problem.** The tactic's combat command has never run live (`docs/COMPANION_TACTICS.md` line 84). Today it relies on hostile attitudes alone (`companion-tactics.lua`, `companionToTarget` / `targetToCompanion`). Attitudes alone often leave a follower watching instead of attacking.

**Technique.**
- Keep the attitude change, and also ask the companion's reaction component to enter combat with the target. Raise its reaction preset to an aggressive one for the tactic's duration.
- Record the old preset in the tactic receipt and restore it when the tactic ends, the same way attitudes are restored now.

**Files.** `mod/companion-tactics.lua` (receipt plus native adapter), `bridge/companion-tactics.test.mjs`.

**Status (2026-10-17).** Built on branch `companion-45`: aggressive preset, `TriggerCombat`, restore on every end, `reaction:` log lines (`docs/COMPANION_TACTICS.md`, "Fight"). Not seen in the game.

**Risk.** Medium: the companion could stay aggressive if the restore is missed. The existing receipt and recovery paths (`docs/COMPANION_RECOVERY_TRANSACTIONS.md`) must cover the preset, including a save or load mid-tactic.

**Verify.**
- `probe.log` tactic lines: preset set, combat started, preset restored.
- Movement trace: the companion closes on the target.
- `scripts/Capture-GameWindow.py`.

### 5. Combat readiness at attach: level scaling and an attitude read-back (medium impact, needs a probe first)

**Problem.** Companions are spawned from records whose level and stats are fixed by the record. The spawner scales each follower to V's level when it makes it a follower. Our attach code (`mod/companions.lua`, spawn and attach near lines 377-486) neither scales nor reads back the attitude group it sets.

**Technique.**
- When attaching, use the game's NPC manager scale-to-player call on our copy.
- Read back the attitude towards V once, and log it when it is wrong.
- Both are one-shot calls at attach.

**Files.** `mod/companions.lua` (attach), `bridge/companion-records.test.mjs`.

**Status (2026-10-17).** Built on branch `companion-45`, in `mod/companion-records.lua` (`prepare`) with a one-line call from `attachFollower` (`docs/COMPANION_COMBAT.md`, "Combat readiness at attach"). Not seen in the game.

**Risk.** Low to medium. First check live that scaling does not reset the armed clone's equipment.

**Verify.** One live attach in Developer mode, with `probe.log` showing the level before and after. Then a short fight, watched through `scripts/Capture-GameWindow.py`.

### 6. Convoy follow A/B: kinematic, no traffic (low impact, low risk)

**Problem.**
- The overflow convoy (`mod/companion-vehicle-native.lua:290-304`) follows V's car with traffic on and kinematic off, at `distanceMin=10+ordinal*8`. It is confirmed working (`TODO.md` line 1321).
- Following the puppet failed on 2026-10-05, so this is only about smoothness.

**Technique.** As an A/B setting under Developer options:
- the spawner's kinematic, no-traffic follow, still targeting V's car
- a smaller stacking step for bikes

**Files.** `mod/companion-vehicle-native.lua`, `bridge/companion-vehicle-native.test.mjs`.

**Risk.** Low behind a setting, but kinematic driving can clip through traffic, which is why it stays an A/B.

**Verify.** The movement trace's convoy gap over a 2 km drive, and a capture of the convoy at a junction.

### 7. Turn toward V on arrival (small, low risk)

The spawner turns a follower toward V when it reaches its distance. Our idle-drift fix (`TODO.md` line 173, branch `companion-idle-stay`) already stops re-planning, so a one-shot turn on arrival there is cheap. Builders should check that it does not fight the gaze module (`docs/COMPANION_GAZE.md`).

## Already equivalent or better

- **Fast travel.** Ours is event-driven too (`mod/init.lua`, the fast-travel observers) and uses our hidden placement rather than a blind teleport.
- **Seats.** Our seat list comes from the vehicle's own mounting slots, with occupants (`companion-vehicle-native.lua` around line 75), so modded cars are covered without a name list.
- **No-seat followers.** We spawn party cars, and a cab overflow walks on after the exit (`companion-vehicles.lua` around line 205).
- **Elevators.** The spawner disabled its own. Ours rides or rejoins out of view.
- **Crowd NPCs.** Our non-crowd clones match the respawn lesson above.

## Rejected

- **An AI component on every vehicle in the world.** It costs FPS and stability everywhere, and our party cars already carry native driving AI.
- **Damage multipliers through a per-hit engine hook.** That is Lua per hit, and the tuning is not ours.
- **Workspot poses, time-dilation freeze and a reaction-stimulus look-at.** They conflict with our gestures, seating and gaze, and the freeze changes the game's time.
- **Blind teleports.** We keep the out-of-view rule and only bound the wait (item 1).

## Ready for builders

- **Items 1, 3 and 6:** Sonnet. They are precise and local, with unit tests in the existing fengari style.
- **Item 2:** Sonnet, plus a reviewer. It must be measured with the perf probe before and after.
- **Items 4 and 5:** Sonnet, after a live probe agreed with the user. The tactic needs a probe script, which is new game input.
- **Item 7:** Haiku can draft it from this brief, and Sonnet reviews it against the gaze module.
