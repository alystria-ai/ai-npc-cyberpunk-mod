# Companion tactics: Fight and Distract

## Choosing the target

The mod has no marking key of its own. It reads the game's native marking: tag an
enemy with the scanner (focus mode) as usual. The target is chosen when you talk
to the companion, in this order:

1. **Tagged.** The closest scanner-tagged valid NPC within 50 m (several tags are
   fine; the nearest wins).
2. **Looked at.** Nobody valid is tagged: the NPC under the crosshair (the game's
   look-at target, else the one closest to the crosshair) if valid and within 30 m.
3. **Nearest.** Otherwise the closest valid NPC within 50 m.

Valid means alive (not dead or defeated) and combat-capable: gang members, police,
corpo and military security, cyberpsychos, drones, mechs, androids, or anyone with
a weapon in hand. The NPC does not have to be hostile yet. Never targets: managed
companions or other player companions, crowd and civilians, children, vendors,
invulnerable NPCs, NPCs under story/scene control, and friendly NPCs other than
police. Tags on those NPCs are ignored. The game signals read are
`IsTaggedinFocusMode`, `IsCrowd`, `IsCharacterCivilian`, `IsCharacterChildren`,
`IsVendor`, `IsInvulnerable` (plus the `IsInvulnerable` stat), `IsOnAutonomousAI`,
`IsPlayerCompanion`, `IsCharacterGanger`/`Police`/`Cyberpsycho`, `GetNPCType`
(Android, Mech, Drone), `ScriptedPuppet.GetWeaponRight` and the attitude toward V,
all present in the 2.31 script cache. A signal that errors is skipped (an
unreadable exclusion never blocks a target, but a target still needs one positive
combat signal). Every choice is logged as `Tactic target: <source> <name> <id> ...
skipped crowd=2 civilian=1`.

Because civilians are not targets, a distraction of a tagged civilian is not
offered; the target must be a combat-capable NPC with a conversation profile.

## Asking a companion

Talk to the companion privately (text or voice) while a target is chosen within
60 m. The request carries a game-captured offer (companion, target, allowed
kinds) and the character sees four Convai actions:

| Action | Behaviour |
| --- | --- |
| Attack Marked Target | Attack now |
| Distract … Then Return | Talk to the target, then walk back to where the plan was made and wait for V |
| Distract … Then Attack | Talk to the target, then attack them |
| Distract … Then Rejoin | Talk to the target, then follow V again |

Clear intent ("go keep that guard busy, then come back here") emits the action
straight away. If V does not say fight or distract, or asks for a distraction
without saying how it ends, the character requests no action and asks in its own
words; V's answer authorizes the matching action on the next turn. Distraction
kinds are offered only when the target has an enabled conversation profile
(named or resident) and nobody is in combat.

## Distraction

The companion walks to 1.7 m from the target, turns to face them, and the target
holds (civilian or crowd outside a workspot) and looks at the companion. Five
lines follow in strict order, companion, target, companion, target, companion,
each an automatic `distraction` turn through the normal request, speech,
subtitle and lip-sync path. The bridge trigger carries the lines heard so far;
the target speaks with its own profile (usually `resident-male`/`-female`). The
fifth line wraps up, or turns cold for the attack ending. A failed line is
retried once; a second failure ends the conversation early.

While the distraction runs, the target and up to 16 NPCs within 12 m of it get
`SenseComponent.SetDetectionMultiplier(V, 0.15)`, re-asserted every 0.25 s
because vanilla `RefreshCombatDetectionMultiplier` rewrites it on visibility
events. Beyond 4 m from V their partial detection meter is reset; a full
detection (100) and NPCs already in combat are left alone. NPCs hostile toward
the companion, and the companion toward them, are set to neutral at agent level.
Every multiplier and attitude is recorded and restored when the conversation
ends or the tactic is cancelled.

## Fight

Agent-level hostility in both directions (never the attitude group, which would
turn V's group against the whole target group), a persistent hostile threat on
the companion's target tracker, then native combat AI owns movement. Until the
companion is in combat it runs toward the target; no combat within 25 s gives
up. A living target gets its attitudes and threat persistence back when the
fight is cancelled.

## Cancellation and ownership

One tactic at a time. While it runs, `companions.tactics` owns that copy's
movement decision and the actuator still issues every command. V entering a
vehicle, combat starting during a distraction, V starting a new manual
conversation (distraction only), the companion or target disappearing, timeouts
and world teardown cancel it; teardown forgets handles without native calls.
Automatic battle/loot reactions and gaze focus wait during the approach and
conversation.

Source: `mod/companion-marking.lua` (target selection), `mod/companion-tactics.lua`,
`mod/tactic-perception.lua`, `mod/gameplay-actions.lua`,
`bridge/companion-actions.mjs`, `bridge/distraction-context.mjs`. Tests:
`bridge/companion-tactics.test.mjs`, `bridge/companion-tactic-actions.test.mjs`,
`bridge/gameplay-actions.test.mjs`. Not yet tested in game.
