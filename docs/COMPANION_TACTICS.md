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

**Where the candidates come from.** A live test on 2026-10-17 (five requests, a gang member tagged and out of combat within 100 m) found only the companion herself: the game's targeting search (`GetTargetParts`) does not report every NPC in range, so a tag on one it missed never counted. The first source is now the game's own tagged-object list, the global blackboard `TaggedObjectsList.taggedObjectsList` that the focus-mode tagging system keeps (read once per request, on demand). An NPC on it is a candidate whether or not the search reports it, within the 100 m tag radius, with the usual exclusions. The search stays the source of untagged NPCs for the aimed and nearest steps. A tag read that says no outweighs a stale list entry; an unreadable read is settled by the list. A look-at that lands on a companion is skipped and the crosshair line is followed to the NPC beside her.

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
  <reader>, tag list K (M missed by the search, F beyond 100m); <name> <distance>m
  tag=yes|no|err; ...` (the list part reads `tag list unreadable (<error>)` when the
  blackboard cannot be read, and is absent when the list is empty) lists the tagged and unreadable
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
the companion's target tracker, and the companion's own reaction component asked
to start combat (`TriggerCombat`), then native combat AI owns movement.

A follower carries the game's Follower reaction preset, which ignores the hostile
stimuli that make an ordinary NPC fight; hostile attitudes alone can leave her
watching. So for the tactic only, the preset is raised to an aggressive combat
preset (`Ganger_Aggressive`, `Mercenary_Aggressive` or `Corpo_Aggressive`, else
the first aggressive non-civilian, non-police preset by name) and the old one is
recorded in the receipt. It is read back after the change. When the tactic ends
(target down, cancel, timeout, vehicle, anything) the old preset is put back,
read back again, and logged, whether or not the target is still alive. A preset
the game chose in the meantime (it re-evaluates presets on state changes) is left
as the game set it. A companion who is gone is not touched. A civilian-record copy
starts combat through `AIActionHelper.TryStartCombatWithTarget` instead, which is
what `TriggerCombat` calls minus a security-breach stimulus.

Every step is optional: a missing component, an unreadable or missing preset, a
refused preset change or a failed combat start is logged (`reaction: ...` lines in
`probe.log`, prefixed `Companion tactic:`) and the fight goes on with the
attitudes and the threat. A start that fails halfway gives back the preset and the
attitudes it had already changed. Companions are not saved with the game
(`persistState=false`), so a save or load never carries the preset across; world
teardown forgets the tactic without native calls and the copies are deleted. Until the
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
Not yet tested in game (2026-10-13: the combat command has never run live; the reaction start was added 2026-10-17 on branch `companion-45` and has not been seen either).
