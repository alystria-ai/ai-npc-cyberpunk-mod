# Managed companion combat

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
