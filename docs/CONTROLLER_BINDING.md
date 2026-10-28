# Controller talk button

Settings > Voices > **Controller talk button** (off by default, in Mod Configuration Menu and Native Settings UI alike; the same row is on **Companion Manager > Key bindings**, see `docs/KEY_BINDINGS.md`). On, **hold the left stick click (L3)** at a character, speak, and let go to send: the same hold-to-talk as the CET talk key (`docs/VOICE_INPUT.md`), by voice, for the private talk only. Facing nobody, the hold talks to the first member of the party (`docs/TALK_FALLBACK.md`). A button for Talk to Johnny by voice is set on Key bindings. The text composer and the group voice key stay on the keyboard (a controller cannot type, and one controller button is all the pad has to give).

Checked 2026-10-24 against game 2.31 (`r6/config/inputUserMappings.xml`, `r6/config/inputContexts.xml`, `r6/cache/final.redscripts`, read only).

## How the input is read

The game's own action for the click, `ToggleSprint`, through `PlayerPuppet.RegisterInputListener` (the call `Composer.reds` already uses for the movement axes). The game calls that listener only when the button changes: pressed, released. Nothing is polled, no Lua runs per frame, and while the setting is off nothing is registered at all.

- `inputUserMappings.xml` maps `IK_Pad_LeftThumb` (and the keyboard's Shift) to `ToggleSprint_Button`; `inputContexts.xml` puts the `ToggleSprint` action in the **Locomotion** context only. That context is the walking controls, so the game does not deliver the action in a menu, a loading screen, a scene that takes the controls, a dialogue choice, a call or a vehicle. This is the first guard, and it is the game's own.
- `r6/scripts/CyberpunkConvai/PadTalk.reds`: the listener (it never consumes the action, so the game's sprint toggle is untouched), a 0.3 s one-shot `DelayCallback` for the hold, and a short queue of edges (`1` = hold reported, `0` = released). The hold counts only if the controller is the last device used (`PlayerLastUsedPad`; the keyboard's sprint key is the same action) and the left stick is at rest (`ConvaiMoveHeld`, the existing movement tracker; a click made to sprint has the stick pushed).
- `mod/pad-binding.lua`: takes the edges (the game's 10 Hz tick drains the redscript's queue, and no Lua runs inside a game event: see "The freeze on the first hold" below), decides whether the moment is allowed and calls the talk key's own code path (`init.lua` `voiceKeyEdge`, key id `pad_voice`, so a keyboard hold and a controller hold never end each other).
- Second guard (Lua, once when the hold is reported, and every 0.25 s while it lasts): not in a menu or with the text box open (`gameplayCanAcquire`), and `battle-observer` reads open gameplay: not in combat, not in any vehicle, not in a scene tier above 1 (a seated V excepted), no dialogue, no dialogue choices, no call, not Johnny or another replacer. A menu that opens under a held click swallows the release; the 0.25 s check then ends the turn (the redscript also says when it no longer sees the click held).

## Why one button, and why L3

Every pad button has a meaning in the game. From the 2.31 files:

| Choice | What the game does with it | Verdict |
|---|---|---|
| **L3 held** | `ToggleSprint` (Locomotion). Standing still it does nothing; it flips the sprint toggle | **Offered, the default.** Needs the stick at rest, which separates it from a sprint click |
| D-pad down held | `PhoneInteract` and `PhoneReject`, a 0.5 s hold opens the phone (`docs/HOLOCALL.md`: a hold used to open the phone on top of the mod's hang-up). It is the pad's phone button | Rejected: it would take the phone from the controller, or open it on every talk |
| LB + RB held | the `IconicCyberware` button group (0.2 s hold): fires Sandevistan, Berserk and the like when equipped. Alone, LB is the scanner and RB the quickhack panel | Rejected |
| L3 + R3 held | the `TogglePhotoMode` button group (photo mode). R3 alone is quick melee, tag and body pick-up | Rejected |
| D-pad up, left, right | consumable (heals), pocket radio, call vehicle | Rejected |
| R3, X, Y, B | quick melee and tag, interaction and reload, weapon wheel, crouch and dodge | Rejected |
| Select, Start | pause menu, hub and map (on a pad these open on a hold) | Rejected |

The listener sees the action, it does not own it (and the walking actions are read by the game's own state machines, so this mod does not try to take one away). So a safe button is one whose game action is harmless when the player stands in front of someone, and the only one is L3. If the sprint toggle should ever matter (V is walking while it is held), the stick-at-rest rule already keeps the hold from starting.

Combos would need raw gamepad key events (Codeware's `Input/Key` target, or the native plugin). Whether Codeware delivers gamepad keys was not verifiable offline, and both combos above collide with real actions anyway. If a second binding is wanted later, the Lua side is already the place: add a preset and a source for it.

## Other buttons and keys: Key bindings

The L3 hold above is one fixed button. For any other controller button (or any keyboard key) and for the other four actions (talk by text, group voice chat, group text chat, the Companion Manager) there is **Companion Manager > Key bindings** (2026-10-25, `docs/KEY_BINDINGS.md`): **Set**, then press the button. That page cannot use this document's mechanism, because `RegisterInputListener` only hears the actions a button is mapped to; it reads the raw key events through Codeware (`r6/scripts/CyberpunkConvai/KeyBinds.reds`), which is why the D-pad, LB and the rest can be chosen there although each of them already means something in the game (the game still sees the button too: the page tells the player to pick one the game does not use). A controller button set there is a hold for the voice actions (down begins, up sends) and a tap for the others. The two features do not depend on each other: the L3 hold keeps working whether or not a key is set, and a key set there on L3 (`IK_Pad_LeftThumb`) acts on the press and release of the click, with no 0.3 s wait and no stick-at-rest rule.

## The freeze on the first hold (player report on 0.3.3, fixed 2026-10-28)

A player: the whole game froze (Ctrl+Alt+Del to leave) on some first holds of L3 after starting a session, other times it worked; a save with a follower present, or Night City Allies followers called over, was the suspicion. No loop over followers was found: the talk path walks only the mod's own party entries, and a Night City Allies follower is never one of them. What the pad did that no other talk input did on game 2.5 was run the whole talk path (target choice, party and spawned-character scans, warm connection, face request, focus) inside the game's own event dispatch: the redscript called `ConvaiPadNotify`, which Lua observed, from the input listener (release) and from the delay system's callback (the 0.3 s hold). That is the class of call that froze game 2.31 while a key was being set (`KeyBinds.reds`, `GameVariant.reds` `ConvaiKeyNotifyInEvent`, 25 Oct), and the pad had never been live-tested. Now:

- No Lua runs inside the event that produced an edge. `PadTalk.reds` queues the edge and `ConvaiPadPush` schedules one `DelayCallbackNextFrame` step (`ConvaiPadNotifyStep`, present in both game builds); that step, one frame later, calls `ConvaiPadNotify`, which Lua observes. The step touches no input system and schedules nothing, so it cannot re-enter the input listener or start another step (one step in the air at a time, a busy flag). Worst delay after the click or the end of the 0.3 s hold: one frame (about 7 to 16 ms at 60 to 144 fps), not the tick's 0.1 s. The 10 Hz tick still drains the same queue, so a step that never runs (a paused game) costs at most 0.1 s. `ConvaiPadNotifyDeferred()` false turns the notification off and leaves the tick alone.
- A busy flag keeps every redscript handler from being entered from inside itself.
- `pad-binding.lua` never handles an edge from inside a handler (`state.inside`), and ignores more than 8 hold starts in 5 s (a person cannot, a loop can).
- `Engagement.reds` `ConvaiTurnCivilian` (the one other loop on the talk path) wraps the heading difference in a bounded loop.

Live check: with the setting on and a follower present (the mod's own, and a Night City Allies one), load a save and hold L3 right away, several times; `probe.log` shows `Controller talk button: the tick reads the queue` and `down (tick)`.

## Live checks (not run yet)

Listed in the TODO.md log entry of 2026-10-24 (controller talk button).

## Files

`r6/scripts/CyberpunkConvai/PadTalk.reds` (needs a game restart), `mod/pad-binding.lua`, `mod/init.lua`, `mod/manager.lua` (`padTalk`), `mod/manager-ui.lua` (the row), `mod/locales/*.lua`, `localization/en.json`, `bridge/pad-binding.test.mjs`, `packaging/release-plan.json`, `scripts/development-files.json`.
