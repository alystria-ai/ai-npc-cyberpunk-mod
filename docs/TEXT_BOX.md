# The talk text box: leaving it, and where the settings are (31 Oct 2026)

Two reports from a player on 0.4.0, fixed on branch `fix/textbox-freeze-mcm`.

## 1. "I type a message, want to leave, and I am frozen in place but everything around me still moves"

**What the box is.** The talk box is the game's own `GenericMessageNotification` with Codeware's text field in it (`Composer.reds`
`ConvaiOpenComposer`, dressed by `mod/composer-input.lua`). While it is up the game's popup state owns the keyboard and the mouse
and holds V in place (the world keeps running). That is by design, so typing does not move V.

**Every way the box can be left, and what happens now.**

| Way out | Result |
|---|---|
| Enter with words | the message is sent (`ConvaiTakeSubmission`), V is free |
| Enter on an empty box | closes, one notice ("Your message was not sent...") |
| Esc | closes, nothing kept, no notice |
| Click outside the dialog | **new:** the box closes at once and the words are kept (see "Park") |
| The talk key again | refused while the box is up (the token is set), the box stays |
| The game closes the box (pause menu, a scene, a phone call, a load) | the close callback runs and V is free. If it never runs, the safety net below lets the scripts go |
| The Companion Manager Search characters box | same dialog, own state, never parked, never a talk turn |

**Root cause (from the code, the game cannot be run from this branch).** `Codeware.UI.reds` wraps the dialog's `OnHandlePressInput`:
a click on a widget that cannot take focus only runs `RequestSetFocus(null)`. The text field loses the typing focus and the box
**stays up**, still holding V. A player who clicks outside "to leave" ends in exactly the reported state: V frozen, the world moving,
the box on screen without a caret. Nothing in the mod's own scripts left an input block behind: the 0.4.0 search mode keeps its own
token state (`m_convaiComposerMode`, `m_convaiSearchState`) and a `ConvaiForgetSearchBox` that only forgets the token of a box that
never drew. The `DontSendReleaseEvent` guards belong to the phone Chat search (`PhoneChatSearch.reds`), not to this box.

**Park (the fix).** `Composer.reds` wraps `OnHandlePressInput` once more (guarded by `ModuleExists("Codeware.UI")`, like Codeware's own
wrapper). For a talk box (`m_data.isInput`, title `TALK TO ...`) a `click` whose target is not inside the dialog (the widget named
`notification`, found by walking the target's parents) calls `ConvaiParkRequest` and then the game's own `Close(Cancel)`. The close
callback sees the park flag and keeps the typed words in `m_convaiDraft` instead of treating the close as a cancel (`ConvaiComposerClosedInfo`
answers `parked`). The box is closed through the same path as Esc, so the game gives V back and hides the cursor: V can walk and look.
Nothing is submitted.

- `mod/init.lua` `convaiComposerWatch.parked` posts the notice `talk-draft` ("Your message to {name} is kept. Press {key} to type
  again.", 20 s on the warning line) with the key of the chat the box was opened with (talk by text, group text chat, Talk to Johnny by text).
- The same key opens the box again (`beginTextNow`). `convaiComposerWatch.takeDraft` puts the words back (`composer-input.lua` `putDraft`)
  when the same character is addressed the same way within 5 minutes, otherwise drops them. A box that is clicked away with nothing typed keeps nothing and says nothing.
- Sending from a parked box is not possible: there is no box. Enter does not reopen it (the owner's decision: the talk key only).
- Esc still closes a box that is up. A parked draft is not a box, so Esc then opens the game's pause menu as usual. The draft stays for the
  talk key until it expires or another character is addressed.
- The phone Chat search and the Companion Manager Search characters box are unchanged.

**Safety net.** The scripts' token says "open" until the game's close callback runs. If the game tears the dialog down without it, the talk key and the Companion Manager would be refused
for good ("Close the text box first."). `composer-input.lua` notes when a dialog of ours initialises (`shownAt`) and when one is torn down (`goneAt`, an `OnUninitialize` observer that
counts only a box it can read as ours). `convaiComposerWatch.orphan` asks, **only while a talk is active and the game says the box is open**
(the loop that already read that flag every frame, no new work while idle): gone for more than 1.5 s, or never shown for 8 s, and the token is let go
(`ConvaiForgetComposer`, probe.log `Composer box gone while still marked open`). The game's own input state is not touched from here: popping a context the game pushed
would risk the opposite fault, and the game releases it when it closes the box.

**Cost.** One extra branch in a click handler and one observer on a dialog teardown. Nothing per frame while no box is open. While a talk is active, one clock comparison on the frame the existing
flag read already makes.

**Tests.** `bridge/composer-park.test.mjs` (restore, safety net, scripts-side halves, the `.reds` text), compiled with `scripts/Compile-Redscript.ps1` for game 2.5 and 2.31.

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
