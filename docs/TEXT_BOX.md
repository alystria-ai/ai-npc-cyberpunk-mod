# The talk text box: leaving it, the draft, and where the settings are (31 Oct 2026)

Two reports from a player on 0.4.0 were first fixed on branch `fix/textbox-freeze-mcm` (the click-out "park"). Part 1 of that work was **reverted the same day**
on branch `fix/textbox-revert-draft` after the owner's live test of 0.10.9. Part 2 (the settings host name) stays.

## 1. The talk box: as before 31 Oct, plus a draft

**What the box is.** The talk box is the game's own `GenericMessageNotification` with Codeware's text field in it (`Composer.reds`
`ConvaiOpenComposer`, dressed by `mod/composer-input.lua`). While it is up the game's popup state owns the keyboard and the mouse
and holds V in place (the world keeps running). That is by design, so typing does not move V.

**Why the park was reverted.** `f69c4d55` wrapped the dialog's `OnHandlePressInput` and closed the box (`Close(Cancel)`, keeping the words) on every `click` whose
target was not inside the dialog. Enter reaches that handler as a `click` too (the live symptom shows it). Unless the player had first clicked into the text field, its target was not in the dialog,
so **Enter parked the box instead of sending**. Live test, 0.10.9: Enter closed the box and kept the message as a draft, and it sent only after a click into the field.
The same live test left V walking forward on its own after a park (below). The click handler, the park, the draft notice and the orphan safety net
(`OnUninitialize` observer, `ConvaiForgetComposer`) are removed. The box behaves exactly as at `f69c4d55^`.

| Way out | Result |
|---|---|
| Enter with words | the game's own confirm: the message is sent (`ConvaiTakeSubmission`), the draft is emptied, V is free |
| Enter on an empty box | closes, one notice ("Your message was not sent...") as before |
| Esc | closes, nothing sent, **the typed words are kept as a draft** (no notice) |
| The game closes the box (pause menu, a scene, a phone call, a load) | the close callback runs, the typed words are kept as a draft |
| The talk key again | refused while the box is up (the token is set), the box stays |
| The Companion Manager Search characters box | same dialog, own state, never a draft, never a talk turn |

**The draft (the one change).** `Composer.reds` `OnConvaiComposerClosed` copies `result.input` into `m_convaiDraft` for every talk-box close that is not a confirm
(Codeware's `Close` fills `input` for any result, Esc included). A confirm empties it. `mod/init.lua` `convaiComposerWatch.closed` remembers whom the words were for
(`keep`: profile key, group or private chat, `os.clock()`, probe line `Composer words kept: ... length=N`, no notice). The talk key opens a new box
(`beginTextNow`), and `convaiComposerWatch.takeDraft` lets the words come back (`composer-input.lua` `putDraft` writes them into the field, once) when the **same character is
addressed the same way within 5 minutes** (`KEEP_S = 300`). For another character, another chat type or after 5 minutes the box opens empty and the words are cleared
(`Kept words dropped: ...`). An Enter on an empty box or a close without a result keeps nothing. A draft the player typed over is never replaced (the field is written once, when the dialog initialises).

**V walking on after the box (live test, 0.10.9).** What the evidence shows. `runtime/probe.log` of the live test: 14 parked closes, one of them (generation 14, 7 s open, 17 characters) was followed within the
same second by a movement exit of the gestures and, four seconds later, by the talk key waiting 1.5 s for the movement axes to be released (`speed=3.85`, the tracker reading held).
In the 170 box opens of the log before the park work, the speed at open was `0.00` every time, and no box ever left V moving. So the latched key appeared only with the changed close path:
the park closed the dialog on the key **press** of Enter (a pointer press event), where the game's own confirm acts on the release. The mechanism the code supports: the engine's movement axes change
only when an input event reaches them, a key event the box (or its closing dialog) consumes never does, and nothing in this mod's scripts can send the missing release (the retail scripts have no input reset: the
dump has no `ReleaseAllInput`, `FakeReleaseButton` is not declared, and the only reset in the scripts, `FPPCameraComponent.ResetCurrentGameplayInput`, belongs to the camera). With the old close path restored there
is nothing left in this mod that consumes or reorders a movement event: `ConvaiMoveWatch` consumes nothing, and the talk box registers no input callback of its own.

What is added so the next live test can prove or refute that: the tracker counts movement events (`ConvaiMoveEvents`, one integer add per event the game reports anyway, no per-frame work),
and every `Composer closed without a message` and `Native input captured` line in probe.log ends with `moveAxis=held|free|n/a moveEvents=<n>`, where `moveEvents` is the number of movement events that
arrived while the box was up. `moveAxis=held` after a close with V standing means a release was lost. That line, with the key the player pressed last, is what a recurrence needs. The talk key's gate
(`convaiTalkGate`, wait up to 1.5 s for a held axis, then open anyway and forget the reading) is unchanged.

**Cost.** Nothing per frame. One integer add per movement event, one native read per box open and close.

**Tests.** `bridge/composer-draft.test.mjs` (the park code is gone from the `.reds`, `.lua` and notices, the draft rules, the field write, the evidence line, the `.reds` close paths) and
`bridge/phone-input.test.mjs` (the tracker). Compiled with `scripts/Compile-Redscript.ps1` for game 2.5 and, with `-GameDirectory` pointing at the 2.31 copy, for game 2.31.

## 2. "I'm using MCM so the mod settings do not show up"

With Mod Configuration Menu 0.10.5 or newer the Companion Manager is a page of MCM only (no Native Settings UI tab, so nothing in the
game's own Settings, by design: MCM would list the tab a second time). The page was listed in MCM as **Companion Manager** under the provider
**AI NPC Cyberpunk Mod**, names a player does not connect with the mod's Nexus page.

- MCM's provider and mod entry are now **AI Companions** (`mod/mcm-host.lua` `LIST_NAME`, a product name, the same in every language), and so is the Native Settings UI tab (`mod/nsui.lua`
  `TAB_LABEL`). The page inside is still called Companion Manager. The notice "Open AI Companions in the Mods list." and the timeout sentence follow.
- The Companion Manager key (F4) opens the page directly. When it cannot (no save loaded, a scene, a text box), it posts `manager-where`:
  "The settings are in Mod Configuration Menu, under AI Companions." or "The settings are on the Mods screen, in the AI Companions tab." (`managerUi.where()` knows which host is up).
- The setup check row of the host (Help page, support report) says where the settings are and the key: "Version 0.10.5. The settings are in Mod Configuration Menu, under AI Companions. Press F4 to open them."
- **Registration can fail or be late.** `registerProvider` is tried at onInit, then every second for 30 tries and every 5 s after (MCM may not be ready when this mod's `onInit` runs). The Native
  Settings UI tab waits 10 s for an MCM that is present and recent enough. If MCM still has not taken the provider, the tab is registered, and removed again if MCM takes the provider later
  (`bridge/mcm-host.test.mjs`, "MCM refuses the provider"). With MCM only (no Native Settings UI) there is no second host: the console line
  `Companion Manager: Mod Configuration Menu would not take the provider: ...` and `runtime/mcm.log` say why.
- Not changed: the hotkey names in CET's Bindings window still start with "AI NPC Cyberpunk Mod:" (CET keys them by id and the owner's bindings are saved under them).
