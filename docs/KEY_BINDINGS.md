# Key bindings

**Companion Manager > Key bindings** (a button on Home between **Character editor** and **Settings**, in Mod Configuration Menu and Native Settings UI alike). The mod's five actions can be given a keyboard key or a controller button from inside the game, with no restart and no trip to Cyber Engine Tweaks (CET):

| Action | How the key acts | Runs |
|---|---|---|
| Talk by voice | hold it, speak, let go to send | `init.lua` `voiceKeyEdge('voice', false, down)` |
| Talk by text | tap it: the text box opens | `beginText(false)` |
| Group voice chat | hold it, speak, let go to send | `voiceKeyEdge('group_voice', true, down)` |
| Group text chat | tap it | `beginText(true)` |
| Companion Manager | tap it | `openManager()` |

The page also holds the **Controller talk button** (the same setting as Settings > Voices, see `docs/CONTROLLER_BINDING.md`) and, for each action, a line **In Cyber Engine Tweaks** with the key the player gave it in CET's Bindings window.

The CET bindings (`registerHotkey` / `registerInput` in `init.lua`) are unchanged and keep working. Nothing is set by default, so nothing changes for a player who never opens the page.

## What the player does

For each action: **Set**, then press the key or controller button. The line under **Back** says "Press the key or controller button for Talk by voice. Esc or B cancels." and the button reads **Cancel** meanwhile. The choice is saved at once ("Talk by voice is set to F7.") and works at once. **Clear** removes it. Esc (keyboard) or B (controller) cancels a Set; a Set nobody answers ends after 12 seconds; leaving the page drops it. A key another action of the mod already has is refused ("F7 is already used for Talk by voice. Choose another."). **Restore defaults** (NSUI's own button, the host's footer button in MCM) clears all five and turns the Controller talk button off.

Choosable: letters, digits, F1 to F24, the arrows and navigation keys, the number pad, punctuation, Space, Enter, Tab, Backspace, Insert, Delete, Caps/Num/Scroll lock, Pause, Print screen, and the controller's A, B, X, Y, LB, RB, LT, RT, L3, R3, D-pad and View/Menu buttons (B cancels, so B itself cannot be bound). Not offered: Shift, Ctrl and Alt (they are how a shortcut is told from a key), the mouse, the sticks and Esc. The game still sees the key too: the page says to pick one the game does not use (the game's own action for a key is not taken away).

## How it works

- **Storage**: `settings.keyBindings` in `runtime/settings.json`, `{action = 'IK_F7'}` with the game's own name for the key (`EInputKey`). Default `{}`. `mod/manager.lua` keeps only the five actions, only names that look like a game key (`IK_...`), and no key twice (a hand-edited file is cleaned on load); `M.keyBindings()` reads it, `M.setKeyBinding(player, action, name)` writes one binding in one validated `applySettings` save, and `applySettings({keyBindings = {voice = false, ...}})` clears.
- **Listening**: `r6/scripts/CyberpunkConvai/KeyBinds.reds`, Codeware `Input/Key` callbacks (the same mechanism the manager popup and the phone already use; `PadTalk.reds` only hears the actions a button is mapped to, so it cannot hear an arbitrary key). The game calls the callback when a key goes down and when it comes up: nothing per frame, no timer, no polling. A callback with targets for the chosen keys is registered only while at least one binding is set; while a Set waits, a second callback without targets (every key) is registered, and it is removed when the Set ends. A key pressed with Shift, Ctrl or Alt held is not a binding, a key repeat is not a second press, and the key that was just chosen is not pressed again until it has come up. Events go into a bounded queue (`d1`..`d5` down, `u1`..`u5` up, `kIK_F7` a key during Set) and `ConvaiKeyBindNotify` is called, which Lua observes (`Observe`), so a key is handled at the moment it happens; the 10 Hz tick drains the same queue if the observer could not be installed.
- **Deciding**: `mod/key-bindings.lua`, loaded by `init.lua` (`convaiKeyBindsModule`) only when a binding is saved or the page opens. It is ticked from the 10 Hz tick (`convaiKeyBindsTick`): with nothing saved and no Set in progress that is one table check. It registers the saved keys with the redscript half (the half reports what it holds, so a new player after a load gets them again) and runs the actions through the very functions the CET keys run. So the gating is the CET keys' own: `voiceKeyEdge` / `toggleVoice` / `beginText` refuse in menus, with the text box open, without a target, and so on, and `openManager` refuses where MCM would (V seated in a scene tier 3 gets the same notice). The one addition: nothing acts while V types in the phone's chat box (`ConvaiPhoneChatTyping`), where the keys reach the game too.
- **Hold and tap**: the voice actions use the CET key's own ids (`voice`, `group_voice`), so a CET key and an own key on the same action never start two recordings (`voiceKeyEdge` ignores the second down and the second up). The tap actions run when the key comes **up**, as a CET hotkey does (so the key's character is not typed into the box it opens).
- **One press runs once**: when the same key is bound in CET and here, both fire as it comes up, a few milliseconds apart. `convaiTapOnce(action)` (in the three CET hotkeys and in the module) lets the first through and drops the second within 0.4 s. With the module not loaded the CET hotkeys run as before.
- **Set**: `M.beginCapture` asks the redscript half to report every key (`ConvaiKeyBindsCapture(true)`) and waits. Escape and the controller's B cancel; a key that cannot be bound (a modifier, the mouse, a stick) is ignored and the Set goes on waiting; presses within 0.4 s of pressing Set are ignored (a held Enter repeating). The saved key is registered at once (not at the next tick), so the release of the key just chosen is heard, and the bound keys do nothing for half a second after a choice. The result comes back through `managerUi.keyBindResult`, which sets the line under **Back** and redraws the page.
- **Game versions**: the key target is the one place the builds differ. `GameVariant.reds` has `ConvaiKeyTarget(key, action)` (Codeware 2.31 filters by action; the 2.5 target does not) and now `ConvaiKeyTargetsByAction()` (true on 2.31, false on 2.5): `KeyBinds.reds` adds a press and a release target per key on 2.31, one target per key on 2.5, and checks the action in the handler on both. Both builds compile (`scripts/Compile-Redscript.ps1 -GameVersion 2.5` and `-GameVersion 2.31 -GameDirectory <the 2.31 folder>`), also against a game without Codeware (the methods that need it have plain stand-ins; the page then says "Key bindings need Codeware").

## The Cyber Engine Tweaks line

CET stores a binding in `bin/x64/plugins/cyber_engine_tweaks/bindings.json` as one 64-bit number per action of a mod: four 16-bit slots of Windows virtual-key codes, the first key in the top 16 bits (F6 alone is `0x0075` followed by 48 zero bits; a chord such as Ctrl + J has the modifier first). The numbers exceed 2^53, so `mod/key-bindings.lua` (`decodeBind`, `decodeCet`) reads them as text and divides by 65536 four times. CET reads the file when the game starts and writes it when the game ends; **the mod never writes it**.

Two sources, in this order:

1. CET's own live answer, `IsBound(id)` and `GetBind(id)` (the calls the interface-language hints already use, `docs/COMPANION_HOTKEY_INPUT.md`): it shows a binding changed in CET's overlay this session at once, and is exactly CET's text ("F6", "Ctrl + J").
2. `bindings.json`, read through the CET sandbox's `io.open` (`../../bindings.json`, at most every 5 seconds), only when CET gives no such call. **CET's sandbox may refuse to open a file outside the mod's own folder**, in which case this source silently gives nothing; the decode is tested on the real file shape (`bridge/key-bindings.test.mjs`).

## Files

`r6/scripts/CyberpunkConvai/KeyBinds.reds` and `GameVariant.reds` (both builds; needs a game restart), `mod/key-bindings.lua`, `mod/init.lua` (`convaiKeyBindsModule`, `convaiKeyBindsTick`, `convaiTapOnce`), `mod/manager.lua` (`keyBindings`, `setKeyBinding`, the `keyBindings` setting), `mod/manager-ui.lua` (the page, `keyBindResult`, Restore defaults), `mod/mcm-host.lua` and `mod/nsui.lua` (Restore defaults on the page), `mod/locales/*.lua`, `localization/en.json`, `scripts/Extract-UiCatalog.mjs`, `bridge/key-bindings.test.mjs`, `bridge/mcm-host.test.mjs`, `bridge/nsui-manager.test.mjs`, `bridge/manager.test.mjs`, `packaging/release-plan.json`, `scripts/development-files.json`.

## Not verified without the game

- That Codeware's `Input/Key` delivers **controller buttons** (the mod's other uses are keyboard keys), and that a callback without targets receives every key. If the gamepad does not arrive, a Set for a controller button simply keeps waiting and times out; keyboard keys are unaffected.
- That the key press reaches Codeware while the Companion Manager page is open (the Set), on both hosts.
- The CET line from the file (the sandbox question above).
