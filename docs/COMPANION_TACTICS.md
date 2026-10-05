# Companion tactics: Fight and Distract

## Marking a target

Bind **Cyberpunk Convai: mark target for companions** in CET. Aim at a person
and press it; the game's own focus-mode tag highlights them. Press it again on
the same person (or on nobody) to clear the mark. Managed companions, dead and
defeated NPCs cannot be marked, and a mark is dropped beyond 90 m. Without an
explicit mark, exactly one scanner-tagged NPC within 50 m also counts; several
tagged NPCs count as ambiguous.

## Asking a companion

Talk to the companion privately (text or voice) while a target is marked within
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

Source: `mod/companion-marking.lua`, `mod/companion-tactics.lua`,
`mod/tactic-perception.lua`, `mod/gameplay-actions.lua`,
`bridge/companion-actions.mjs`, `bridge/distraction-context.mjs`. Tests:
`bridge/companion-tactics.test.mjs`, `bridge/companion-tactic-actions.test.mjs`,
`bridge/gameplay-actions.test.mjs`. Not yet tested in game.
