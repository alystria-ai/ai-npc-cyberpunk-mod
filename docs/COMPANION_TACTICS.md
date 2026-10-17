# Companion tactics: Fight

## Choosing the target

The mod has no marking key of its own. It reads the game's native marking: tag an
enemy (or anyone) with the scanner (focus mode) as usual. The target is chosen when
you talk to the companion, in this order:

1. **Tagged.** A scanner-tagged NPC within 100 m. With several tags the best is
   ranked, not the nearest: first one that is hostile to V or already in combat, then
   one that can fight (gang, police, cyberpsycho, machine, armed), then anyone else
   (a civilian or bystander); within a tier the NPC V is aiming at, then the most
   recently tagged (the game's tag list keeps the newest tag first), then the
   nearest. The tag is V's decision, so a neutral, civilian or crowd NPC is a valid
   target when nothing better is tagged. Never taken even when tagged: managed
   companions or other player companions, named, quest-bound or scene-controlled
   characters (hostile or not), children, vendors, invulnerable NPCs, and friendly
   NPCs other than police.
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
- `Tactic target: <source> <name> <id> at <m>m, because <why>; skipped civilian=1 ...;
  tagged <name> rejected: <reason> [<signals>]` is the choice, the reason and why
  others were skipped. `<why>` is `hostile over bystander` (tier over tier), `aimed
  at`, `tagged most recently`, `nearest` or `the only valid tag`.
- With two or more tagged candidates (and once for one) a third line,
  `Tactic tagged choice: <name> <tier> [aimed] [tag#N] <m>m > ...; facts: <name>
  [ganger+hostile], ...`, lists them best first with the plain facts read for each, so
  an unfamiliar display name can be told from a civilian record.

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
companion is in combat it runs toward the target. A living target gets its attitudes
back when the fight ends or is cancelled.

### Starting the combat (2026-10-17 fix)

Live 2026-10-17 the order was accepted and the preset, the threat and `TriggerCombat`
all went through, yet she walked up with the weapon out, crouched in the Stealth
state and never fought. A follower that holds a threat which has not noticed her stays
in the Stealth state; nothing in the sequence changed her high-level state. The game
forces a fight with exactly one more call (`npcPuppet.script` OnFinisherEffectorActionOn,
`psychoSquadAVSystem.script`, `bossStealthComponent.script`): attitude, injected
threat, then `NPCPuppet.ChangeHighLevelState(npc, Combat)`. The fight start now ends
with that call (log: `reaction: Combat state asked (was Stealth)`). If `NPCPuppet.IsInCombat` is
still false 1 s later the start is asked again, stronger (`engage stage 2 ...`: the
tracker's `ActivateThreat` and `SetThreatBeliefAccuracy` 1.0, the reaction component's
combat start, the Combat state again), once more at 2 s (stage 3), and at 3 s one line
`engage: combat did not register after 3.1s: state=... stance=... threat=... attitude=out/back
preset=... target-civilian=...` says what the game reads. Without combat after that, she
gives up once she has stood at the target for 4 s, or at 25 s, whichever is first, and the
notice says why in plain words: `<name> can't attack <target>: not a fighter.` (a
civilian or crowd record), `<name> could not reach <target>.`, or `<name> could not start
the fight with <target>.`

The threat is injected persistent (source `CommandInjectThreat`); only that source's
persistence used to be removed, so the threat stayed in her tracker for ever. The end of
the tactic now also removes it (`restore: threat on the target removed (read back gone)`).

### After the tactic: the restore (2026-10-17 fix)

Whenever the tactic ends (no combat, timeout, cancel, target down), apart from a vehicle,
a vanished companion or a replacement tactic, the companion is put back, step by step and
every step logged with its read-back (`Companion tactic: restore: ...`): the preset (above),
the attitudes, our threat, then, every 0.4 s for at most 14 s while the tactic is over:

1. wait while she still tracks any hostile threat (V's own fight; a game-chosen state is
   left alone), then 1 s of calm;
2. `stance Crouch -> Stand` (`NPCPuppet.ChangeStanceState`) unless V is crouched herself, read
   back after 0.6 s, up to 3 tries;
3. `state Stealth|Combat -> Relaxed` (`NPCPuppet.ChangeHighLevelState`), read back, up to 3
   tries (the stance first, the state next: two state signals in one frame can overwrite
   each other);
4. the holster: the equipment owner is armed again (`companion-equipment.lua` `M.rearm`; a copy
   that never reached the combat edge was never armed) and holsters by itself once she is calm
   and Relaxed; 9 s later the hand is read (`weapon read back: holstered`).

While V is crouched the crouch-with-V module keeps the stance and the state. Movement
returns to the follow owner the moment the tactic ends. Polling only runs while a restore is
pending, at 2.5 Hz.

When the fight starts the companion's right hand is read. A real weapon already in
hand is logged (`weapon already drawn (<record>)`); otherwise the draw goes in stages,
each logged as `weapon draw requested (<stage>, hand empty)`:

1. `switch`: the game's switch-to-primary-weapon command with unequip off.
2. After 1 s with the hand still empty (`weapon readback: hand still empty, draw asked
   again`): `equip`, an `AIEquipCommand` with the right-hand slot, the primary item's
   record and a 1 s duration override. With no weapon record to name, this stage is
   skipped.
3. After another 1 s: `slot`, the bare `AIEquipCommand` for `AttachmentSlots.WeaponRight`,
   read back 2 s later (`hand still empty, the combat AI decides`).

Each stage cancels the previous command while it is still running. A stage the game
refuses or does not have (`weapon draw stage <stage> refused`) moves straight on to the
next one; all refused is `weapon draw unavailable`, and it never stops the fight. The
native calls live in `mod/companion-equipment.lua` (`M.draw`) and are shared with the
combat-start draw there: any companion entering combat with an empty hand (not owned by
a tactic) gets the switch command once and, a second later, one explicit equip. The
holster module still only holsters after combat.

## Cancellation and ownership

One tactic at a time. While it runs, `companions.tactics` owns that copy's
movement decision and the actuator still issues every command. V entering a
vehicle, the companion or target disappearing, timeouts and world teardown cancel
it; teardown forgets handles without native calls.

Source: `mod/companion-marking.lua` (target selection), `mod/companion-tactics.lua`,
`bridge/companion-actions.mjs`. Tests: `bridge/companion-tactics.test.mjs`,
`bridge/companion-tactic-actions.test.mjs`, `bridge/gameplay-actions.test.mjs`.
Not yet tested in game (2026-10-17: the reaction start passed once on a different target and failed on the test above; the tag ranking, the Combat state, the engage stages and the restore are on branch `tag-fight-fix` and have not been seen).
