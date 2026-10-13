# Companion tactics: Fight

## Choosing the target

The mod has no marking key of its own. It reads the game's native marking: tag an
enemy (or anyone) with the scanner (focus mode) as usual. The target is chosen when
you talk to the companion, in this order:

1. **Tagged.** The closest scanner-tagged NPC within 100 m (several tags are fine;
   the nearest wins). The tag is V's decision, so a neutral, civilian or crowd NPC is
   a valid target. A named, quest-bound or scene-controlled character is taken only
   when it is already hostile to V and in combat. Never taken even when tagged:
   managed companions or other player companions, children, vendors, invulnerable
   NPCs, and friendly NPCs other than police.
2. **Looked at.** Nobody valid is tagged: the NPC under the crosshair (the game's
   look-at target, else the one closest to the crosshair line, within about 12
   degrees) if it is within 30 m and shows combat evidence: a gang member, police,
   corpo or military security, cyberpsycho, drone, mech, android, an NPC carrying a
   weapon, or anyone already hostile to V. Civilians, children, vendors, named or
   quest-bound characters, invulnerable and scene-controlled NPCs and friendly
   non-police NPCs fail here. A crowd flag alone does not disqualify an aimed NPC.
3. **Nearest hostile.** Otherwise the closest valid NPC within 50 m that is already
   hostile to V.

The tag reader tries `IsTaggedinFocusMode` and then `IsTaggedInFocusMode`, and the
log names the one that answered or the error. The other signals read are `IsCrowd`,
`IsCharacterCivilian`, `IsCharacterChildren`, `IsVendor`, `IsInvulnerable` (plus the
`IsInvulnerable` stat), `IsOnAutonomousAI`, `IsPlayerCompanion`,
`IsCharacterGanger`/`Police`/`Cyberpsycho`, `GetNPCType` (Android, Mech, Drone),
`ScriptedPuppet.GetWeaponRight`, `NPCPuppet.IsInCombat` and the attitude toward V. A
signal that errors is skipped (an unreadable exclusion never blocks a target; an
aimed or nearest target still needs one positive combat signal).

Each request writes two lines to `probe.log`:

- `Tactic candidates: N NPCs within 100m, T tagged, E tag reads failed (<error>), via
  <reader>; <name> <distance>m tag=yes|no|err; ...` lists the tagged and unreadable
  NPCs first, then the nearest, up to six. A tagged enemy missing from this line was
  outside the 100 m query; `tag=no` on an NPC V tagged means the tag read said false;
  `tag=err` means the read failed.
- `Tactic target: <source> <name> <id> at <m>m; skipped civilian=1 ...; tagged <name>
  rejected: <reason> [<signals>]` is the choice and why others were skipped.

When nothing valid is found the offer is withheld and the character is told so
(`tacticUnavailable: "no-target"`), so she declines instead of claiming to attack.

## Asking a companion

Talk to the companion privately (text or voice) while a target is chosen within
100 m. The request carries a game-captured offer (companion, target, allowed kind)
and the character sees one Convai action, Attack Marked Target. Clear intent ("go
get that guy") emits the action straight away; if V's intent is unclear the
character asks in her own words, and V's answer authorizes the action on the next
turn.

## Fight

Agent-level hostility in both directions (never the attitude group, which would
turn V's group against the whole target group), a persistent hostile threat on
the companion's target tracker, then native combat AI owns movement. Until the
companion is in combat it runs toward the target; no combat within 25 s gives
up. A living target gets its attitudes and threat persistence back when the
fight ends or is cancelled.

When the fight starts the companion's right hand is read. A real weapon already in
hand is logged (`weapon already drawn (<record>)`); otherwise the game's
`AIEquipCommand` for `AttachmentSlots.WeaponRight` is sent (`weapon draw requested`)
and the hand is read back 1.5 s later (`weapon readback: drawn (<record>)`). An empty
hand gets one more request and a second readback 2 s later; after that the combat AI
decides (`hand still empty, the combat AI decides`). A refused or unavailable
command is logged and never stops the fight. The holster module draws nothing; it
only holsters after combat.

## Cancellation and ownership

One tactic at a time. While it runs, `companions.tactics` owns that copy's
movement decision and the actuator still issues every command. V entering a
vehicle, the companion or target disappearing, timeouts and world teardown cancel
it; teardown forgets handles without native calls.

Source: `mod/companion-marking.lua` (target selection), `mod/companion-tactics.lua`,
`bridge/companion-actions.mjs`. Tests: `bridge/companion-tactics.test.mjs`,
`bridge/companion-tactic-actions.test.mjs`, `bridge/gameplay-actions.test.mjs`.
Not yet tested in game (2026-10-13: the combat command has never run live).
