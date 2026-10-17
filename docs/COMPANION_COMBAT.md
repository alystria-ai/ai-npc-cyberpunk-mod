# Managed companion combat

## Holster after combat — September 30

The user reported Judy still holding her gun after combat or respawning. Live
reads found the nearby copy relaxed, autonomous and out of combat, with no
hostile threat, but a Chao pistol still physically attached to her right hand.
Relaxed state alone did not establish that the weapon was holstered.

`mod/companion-equipment.lua` adds an equipment owner per managed copy. Fresh
attachment and new combat arm a cleanup check. It waits for a stable, stationary
hold, no player/NPC combat, no player entity threat or NPC hostile threat,
relaxed autonomous AI, a normal upper body, and no authored scene/dialogue.
It then asks the native
`AIUnequipCommand` to holster one occupied hand at a time, using the default
animation. It verifies actual slot clearance, allows at most two attempts per
hand, and bounds each command to six seconds. Renewed combat or story ownership
cancels only its own equipment command. World teardown abandons references
without accessing native components.

The follower role, inventory and combat loadout are preserved. A bounded native
probe found that unequip stayed Enqueued while the
existing owned hold was Executing. It ended after 15 seconds and cancelled its
own queued commands. Evidence is retained locally in
`runtime/equipment-probe-queued.json`. This exposed an engine command handoff
requirement that the isolated fixtures could not establish.

The movement actuator now suspends only its exact owned idle hold, confirms
that command has stopped, and yields to the equipment owner. It retains the
original movement ticket and reports suspension rather than a movement failure.
After verified slot clearance, it restores a hold at the actual stance and runs
the current movement decision. Walking away, renewed combat, authored dialogue
or a new movement decision ends the handoff. If equipment cancellation fails,
the owner retains the command reference and observes its terminal state without
blocking movement or repeatedly sending cancellation requests.

Twenty-two equipment/actuator integration checks and 42 existing movement and
record checks pass; all four affected Lua modules parse. These cover exact
command ownership, delayed cancellation, departure, combat, teardown and hand
clearance. The temporary probe has been retired. Production acceptance is
recorded below after the subsequent threat-filter correction.
Checkpoint `679e801` was installed and hash-verified at 01:00 IST on September 30.
The previous adapters are retained under
`backups/loot-equipment-before-20260930-010043/`. CET activation passed, and the
fresh copy initially had empty hands. The subsequent user check still showed a
drawn weapon: the user clarified that V had been hit by a car. The capture found
both actors out of combat, Judy relaxed with Normal upper body and no threat,
but V's broad threat query still true. V's visible, entity-only and visible-entity
queries were all false. Evidence: `runtime/equipment-player-threat-20260930.json`.

The player guard now checks `HasHostileThreat(player, false, true)`, excluding
location-only memories while retaining nonvisible hostile entities. The NPC
threat and both combat/scene gates are unchanged. Twenty-four equipment checks
pass, including the captured location-memory sequence and cancellation on a
returning hostile entity. The filter matches the native autonomous combat
condition's entity-only, visibility-independent check in
`scripts/cyberpunk/ai/Conditions/aiAutonomousConditions.script:8-24,211` of the
local reference. The impact is a plausible source of the location memory;
its precise creation event was not captured.

**Live acceptance:** after CET activation of `7ccdfd2`, the user confirmed
"she holstered all good" and requested moving on. Both active managed Judys
(`11072108ULL` and `11071767ULL`) independently reported exactly one
`AIUnequipCommand` with Success, both hand slots empty, equipment complete,
no movement suspension, and resumed executing standing holds at zero speed.
Evidence: `runtime/equipment-holster-accepted-20260930.json`. The earlier empty-car
shot only entered V's combat state while Judy remained unarmed; that run was
not counted as a holster test. A proposed scripted draw probe was stopped before
implementation because the production path had now been verified.
Use `party-weapon-state:<nonce>` for read-only hand attachments, combat/scene
gates, movement state and equipment ownership.

## Holster while V keeps moving — October 8

The user saw Judy keep her weapon drawn for a long time after a fight, until she finally holstered it. The movement trace of that session shows why. The fight ended at 13:47:17 and V kept walking; Judy's follow behaviour was `catch_up`, `alongside` or `approach` almost the whole time, and her first stretch of calm standing was 13:49:13. The holster handoff needs `idle`, which was "V is standing still and she has a settled hold" (`not groupFrame.moving`), so it waited (`Wait until settled`) for as long as V walked, about two minutes.

Fix, still through the native `AIUnequipCommand`:

- `mod/companion-equipment.lua` keeps a calm clock (no combat, no hostile entity). With a weapon still drawn after 3 s of calm it raises `wantsStop`. That is a bounded request: at most 8 s to reach the holster, then 20 s before it asks again. The holster command keeps its own 6 s limit. Any combat, threat, scene or dismissal withdraws it. The check is the existing 4 Hz equipment tick, only for an armed copy; nothing new runs per frame.
- `mod/companions.lua` turns `wantsStop` into a hold decision for that copy (a departing companion, a tactic or a body animation keep their own say) and counts a stopped copy as idle for holstering even though V walks on. The copy follows again the moment the weapon is away or the stop is abandoned.
- Her own feet must be still for 1 s (instead of 2.5 s of V standing), so she holsters about 5 s after combat ends while V walks, and about 2.75 s when V is standing.
- An engine that still reports the calm companion as Alerted is treated as relaxed after 6 s of calm. Any other state keeps blocking.
- The movement trace (`runtime/movement-trace.ndjson`) now carries `holster` per copy (`phase`, `reason`, `stop`, `armed`), so a drawn weapon can be explained from the log.

Tests: `bridge/companion-equipment.test.mjs` (stop request timing, withdrawal, bound and cooldown, Alerted, and a real companions/actuator run where V keeps walking and she stands, holsters and follows again; that run fails on the old code with `waiting/Wait until settled`).

## Johnny fleeing — September 29

The user observed Johnny running away while Judy fought. Source inspection found
a concrete capability difference in the installed REDmod data:

- `primarycharacters.tweak`: `Silverhand : Quest_NPC_Base`, with no weapon pool
  or combat archetype override.
- `base_records.tweak`: `Quest_NPC_Base` adds crouch and sprint; it does not
  inherit the shooting/hand-use abilities from `Gameplay_NPC_Base`.
- `secondarycharacters.tweak`: Judy inherits a combatant, overrides her
  archetype to `ArchetypeData.GenericRangedT2`, and equips a Chao pistol.
- `tertiarycharacters.tweak`: Grayson's primary pool equips
  `Items.Preset_Silverhand_3516` on the right-hand weapon slot.

These files are under the installed game's
`tools/redmod/tweaks/base/gameplay/static_data/database/characters/` tree.
They explain a missing prerequisite for fighting; the native runtime and visible
combat result still need verification.

## Alex ran away — October 11

The user was attacked by gangers and Alex ran away (a movement trace showed both copies in native combat, our commands released, sprinting directly away from V; `Automatic battle reaction` then released with `speaker-missing`). The same defect as Johnny: in the installed REDmod data `alex : Quest_NPC_Base` (`ep1/.../primary_characters.tweak`) has the `Invulnerable` tag, `reactionPreset = NoReaction` and `GenericRangedT2`, but `Quest_NPC_Base` adds only `CanCrouch` and `CanSprint`; the shooting and hand abilities live in `Gameplay_NPC_Base`, which she does not inherit, and she has no `primaryEquipment`. The game's no-weapon combat branch (`NoWeaponCombatConditions`, `aiAutonomousConditions.script`) is the likely place the unarmed copy flees; that last step is inferred from the observed behaviour and the Johnny precedent, not read from a script.

`mod/companion-records.lua` now generalizes the Johnny adaptation. Any spawn record (after the crowd clone, if one was needed) that has none of `CanShootWhileMoving`, `CanCloseCombat` or `HasChargeJump` is cloned into `CyberpunkConvai.Armed_<name>`, keeps its own abilities and gains Judy's ranged set, archetype, primary (Chao pistol) and secondary equipment. Records that already fight, or whose abilities cannot be read, are never touched, and a clone that fails leaves the original record in use (the copy still spawns). Shared game records are only read. Existing copies need a re-invite. Which roster characters are affected depends on their base record; check the probe log for `Armed_` names after spawning.

## Alt Cunningham: combat and invulnerability — October 15

**Combat.** `Character.Alt` is `Alt : Quest_NPC_Base` (`secondarycharacters.tweak`): crouch and sprint only, no tags, no
combat abilities, no weapon, so she takes the generic armed clone above (`CyberpunkConvai.Armed_Alt`, Judy's
ranged set, archetype and Chao pistol, her own template and identity kept; logged as `Companion spawn record: ...
(armed clone)`). The combat system has no per-character tactics: Fight (`docs/COMPANION_TACTICS.md`) is the one tactic
and every companion runs it the same way, so there is nowhere to hang a netrunner behaviour. A netrunner archetype
(`ArchetypeData.NetrunnerT2` exists in the game data) was considered and not used: its AI is written for hostile
hackers, nobody has seen it run on an ally, and an unseen guess that could leave her standing still in a fight is worse
than a human-era Alt with a sidearm. The generic clone is therefore the sane choice, and she cannot die in it (below).
Not seen in the game; the live check is in the TODO log.

**Invulnerability.** Johnny's and Alex's records carry the `Invulnerable` tag. The installed
`cyberpunk/managers/npcManager.script` (`SetNPCImmortalityMode`, run when the puppet initialises) turns that tag into
`GodModeSystem:AddGodMode(entity, gameGodModeType.Invulnerable, 'Default')`, and the clone inherits the tag. Alt's record
has no tags, and writing a flat that does not exist is not safe through `TweakDB:SetFlat` in this install, so her copy
makes the same game call itself: `companion-records.lua` `M.protect(entityID, modelRecordID)` runs once from
`attachFollower` (source name `CyberpunkConvaiProtection`, because the script's `UnInit` clears only `'Default'`), reads
`HasGodMode` back, and logs `Companion protection: invulnerable granted` (or `not granted (<reason>)`; a refusal never
stops the copy joining). `deleteOwnedCopy` calls `M.unprotect` once before `DeleteEntity`, while the entity still
exists. A fast-travel recreation attaches again and is protected again. The model record decides (`Character.Alt`), so a
copy of her model is protected under any chat profile and no other character is. Only mod-spawned copies are touched;
the story Alt is not. There is no per-frame work: one system call at attach, one at removal. To protect another model,
add its record to `invulnerableModels` in `mod/companion-records.lua`.

Tests: `bridge/companion-records.test.mjs` (armed clone for her record, one grant at attach, release before deletion,
profile independence, refused/unconfirmed/missing system, fast travel).

## Combat readiness at attach: level and attitude — October 17

Written on branch `companion-45` (item 5 of `docs/COMPANION_IMPROVEMENTS_2026-10-17.md`); unit-tested, not seen in the game.

A copy comes from a record whose level and stats are fixed by the record. When `attachFollower` (`mod/companions.lua`) has set the follower role, `spawnRecords.prepare` (`mod/companion-records.lua`) runs once for that copy:

- **Only our own copy.** The entity must carry our spawn tag (`CyberpunkConvaiCompanion`). A character of the game, a quest actor or one that another mod spawned (`docs/SPAWNED_CHARACTERS.md`) is never scaled and is not even read.
- **Level.** The game's own `NPCManager.ScaleToPlayer` (a private script function; the puppet keeps the manager in `m_NPCManager`). It removes the copy's PowerLevel modifiers and adds V's PowerLevel and Level. If the manager cannot be reached, the same stat calls are made directly. The level is read before and after: `Companion readiness: <name> level 7 -> 30 (V 30) via npc-manager` (or `via stats`). Equipment is not touched by either path. It happens once per attach, so a copy recreated by fast travel is scaled again as a new entity.
- **Attitude.** The follower role puts the copy into V's attitude group. The group and the attitude towards V are read back once: `attitude ok, group ... (V: ...), towards V AIA_Friendly`. A difference is read again 1 s later, once, from the existing tick (no timer, no per-frame work): `attitude ok on re-read` or `attitude MISMATCH`. Nothing is corrected; a mismatch is only logged.
- **Off switch.** Create `runtime/companion-scaling-off` to skip the scaling (read at each attach); the attitude read-back still happens.

Live check: `TODO.md`, entry of 2026-10-17 (`companion-45`).

## Scoped adaptation

`mod/companion-records.lua` resolves the selected model before entity creation.
Only `Character.Silverhand` is adapted; selecting another model with Johnny's
conversation profile does not change that model's combat data.

The module clones Johnny into `CyberpunkConvai.JohnnyCompanion`, retaining his
template, identity, stats and appearance. It changes four fields on the private
record: Judy's abilities, ranged archetype and secondary equipment, and Grayson's
primary Malorian equipment pool. Shared game records and equipment pools are
read only. All donors are checked before mutation; readback must agree before
an entity can spawn. Subsequent copies reuse the prepared record.

The existing follower role handles allegiance and native combat. The accepted
movement controller already releases its own commands/gaze when the actor
enters combat. This change does not introduce attack targets, automatic fights,
new movement rules, invulnerability, or changes to quest Johnny.

The capability fields also agree with the game's own weaponization path.
The implementation here uses a private clone rather than modifying the selected
game record in place.

## Verification

- Four executable Lua tests pass: private-copy routing with unchanged donors,
  duplicate copies, model/profile separation, missing records, native write
  failure/readback mismatch, retry, and native-combat ownership.
- The existing movement and facial asset checks pass (46 combined checks).
- Full suite: 119 passed, zero failures, one environment-dependent MCM check
  skipped. All 23 Lua modules compile. Installed and hash-verified at 03:40 IST;
  the game was relaunched and native startup compilation passed.
- `party-combat-state:<nonce>` captures original/private record fields, equipment
  items, live companion role, high-level state and weapon-use stats.
- **Native readback passed:** fresh Johnny `11036018ULL` uses the private record,
  has the Malorian pool, follower role, and five checked weapon/hand abilities at
  `1`, matching Judy. The original Johnny, Judy and Grayson combat fields match
  their pre-spawn values. Evidence: ignored
  `runtime/johnny-combat-prepared-20260929.json`.
- **Visual fighting accepted:** the user tested a fight with these fresh copies
  and confirmed "Johnny fights now." Broader combat balance and recovery across
  deaths/save loads remain separate tasks. Existing copies require reinvitation
  to use the new spawn record.

The movement rollback tag is `movement-accepted-2026-09-29` (`61a703d`). The
pre-native-install game backup is
`backups/native-face-before-install-20260929-032612/`.
