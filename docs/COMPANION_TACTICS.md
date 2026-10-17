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

### The Combat state is not a fight (2026-10-17, second live retest)

Live at 17:53Z the target choice was right (the only tag, a ganger 30 m away) and the log said "native combat engaged" at once, yet she only crouched and stood with the gun out, never approached or shot, and the tactic never ended or restored. Causes: (1) "engaged" was `NPCPuppet.IsInCombat`, which the forced Combat state satisfies on its own while her combat AI has no target; (2) the ganger never noticed V or her, so the combat AI had no opponent; (3) once engaged, `T.update` stopped watching, so the give-up and the restore never ran; and `T.decide` released her movement on that false engagement, so nothing walked her to him.

Now:
1. **Evidence.** Engaged needs her in combat AND her combat AI holding a target: the behavior argument `CombatTarget` (`aiComponent.script`, `npcStateComponent.script` GetCombatTarget), read through `GetAIControllerComponent():GetBehaviorArgument` and `FromVariant`. Ours, or any other (she may be fighting someone beside him), counts; `none` does not. Where the argument cannot be read (logged once: `combat target unreadable (...)`), in combat and not crouched counts. Read at most every 0.25 s while a tactic runs.
2. **Until then she is walked to him** with the move command we already send (Run, which the game turns into a sprint in the Combat state), not released to an idle combat AI. The asks at 1 s and 2 s now also **open the fight on his side**: she is put on his threat list (`AddThreat`, not persistent, as the game's own `InjectThreat`) and his state is set to Combat (the same two steps `OnFinisherEffectorActionOn` makes for the NPC it turns on; attitudes are already hostile both ways). At the end she is taken off his list again (`restore: she is off his threat list (read back gone)`); his own AI ends his fight state.
3. **The watch never stops.** In the fighting phase, a fight that is no longer one (no combat or no combat target) for 3 s sends her back to the approach with the asks and the 4 s-at-the-target give-up starting over (`fight lost (...)`); the overall 180 s limit stays. A status line every 5 s (twelve at most) shows what she and the game read: `status 5s fighting, her combat target is ours, gap 8m: state=... stance=... combat-target=...`.
4. If her old target is still on her list when the restore waits (6 s), it is removed once more.

### A real combat target, and his group (2026-10-17, third live retest)

Live at 18:16Z and 18:18Z the Combat state, the preset, the hostile attitudes and the threat entry all read right, yet `combat-target=none`, and a repeat order saw the forced Combat state fall back to Relaxed, then Stealth with the Cover stance, with her walking away from him. Only her side had been made hostile and told to fight; the target had never started combat against anyone. Three changes, all in `mod/companion-tactics.lua`, none per frame (at the start and on the 1 s and 2 s asks only):

1. **The target is a real opponent.** `N.provoke`: hostile to V (undone at the end if it was not already), and his own reaction component starts combat against V and against her (`TriggerCombat`). A civilian record is never turned on V; it gets the game's combat helper for her side only. Log: `opening (start): he is hostile to V (was ...); his combat start against V asked; ...`.
2. **She holds him as her combat target.** `N.setCombatTarget` sets the behavior argument `CombatTarget` (`aiComponent.script SetBehaviorArgument`, the argument the game's `AICombatTargetHelper.SetNewCombatTarget` sets and every shooting action reads) and reads it back (`opening (start): her combat target set, reads back as the target`, or `reads back different`, or `could not be set: ...`). The AI commands that carry a target (`AIInjectCombatTargetCommand`, `AIShootCommand`) take an `EntityReference`, which holds only a node reference and cannot name a spawned NPC, so no redscript helper was added. The move command (Run) now only runs until she holds a target; then she is released to the engine and a stranded path or a gap that does not close no longer matters.
3. **His group joins.** `N.squadmates`: every squad of the target (`GetSquadMemberComponent():MySquads()`, the combat squad and the community), his squadmates within 40 m (12 at most) who are not companions, civilians or crowd, children, vendors, invulnerable, scene-controlled, named or story characters (`env.protected`), our own copies (`env.owned`) or friendly to V. Each becomes hostile both ways with V and with her (what was different is remembered), goes on her threat list, and his reaction component starts combat against both. One line per round: `squad (start): 10 squadmates listed, 3 pulled in (A, B, C); skipped: civilian 2, far 4, ...`. At the end: attitudes back where changed, off her list (`restore: 3 squadmates released`).

With no fight after the 1 s and 2 s asks, the same asks without the squad repeat every 3 s until the order is given up (`engage again` and `opening (again)`).

The restore also changed: a threat removed from her tracker is read again 1 s later (`restore: target off her threat list ...`; or `still on her threat list ... (her attitude to him ...), removed again`). The earlier immediate `STILL LISTED` was no verdict, her senses can list a hostile in view again at once, so that read is now worded `listed again at once, checked again below`. A weapon still drawn after the 9 s read-back is asked for again once, then holstered with the unequip command itself (the `AIUnequipCommand` the equipment owner sends), never while V is in combat.

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
