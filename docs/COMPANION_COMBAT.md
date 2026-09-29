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

The capability fields also agree with the weaponization path in
[AMM's spawn module](https://github.com/MaximiliumM/appearancemenumod/blob/main/Release/bin/x64/plugins/cyber_engine_tweaks/mods/AppearanceMenuMod/Modules/spawn.lua).
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
