# Companion hotkey input review

Checked 2026-10-01 against the running installation's CET version **v1.37.1** (reported by `cyber_engine_tweaks.log`). A CET `registerHotkey` binding does not reserve its key from native game actions.

The matching [CET source](https://github.com/maximegmd/CyberEngineTweaks/blob/61bd6214f0f5f8748589c9e476538614a13908c0/src/VKBindings.cpp#L554) returns zero from both `RecordKeyDown` and `RecordKeyUp`. Key release queues the Lua hotkey callback through `ExecuteRecording`. [Window::WndProc](https://github.com/maximegmd/CyberEngineTweaks/blob/61bd6214f0f5f8748589c9e476538614a13908c0/src/window/window.cpp#L28) then forwards the event to the game's window procedure. CET's [D3D12 input trap](https://github.com/maximegmd/CyberEngineTweaks/blob/61bd6214f0f5f8748589c9e476538614a13908c0/src/d3d12/D3D12.cpp#L27) can consume input while the overlay captures it; an ordinary registered mod hotkey does not enable that trap.

The installed `r6/config/inputUserMappings.xml` maps `IK_F9` to `QuickLoad_Button`; `inputContexts.xml` maps that button to `QuickLoad`. The user's `UserSettings.json` also explicitly selects `IK_F9` for quickload. The local game script reference, `vendor/reference-game-scripts/scripts/cyberpunk/UI/fullscreen/ingame/inGameMenuGameController.script`, registers `QuickLoad` and calls `DelayedHandleQuickLoad()` on its `BUTTON_RELEASED` action. Together, these paths show that an ordinary F9 companion hotkey would also leave native quickload reachable.

Existing protections do not cover ordinary gameplay F9: `mod/phone-input.lua` guards phone typing and the phone's J/L actions, `PhoneChat.reds` guards its chat view, and `mod/composer-input.lua` manages the owned text field. The voice callback's gameplay checks only control whether voice begins; they do not consume native quickload.

**F10 was free at this check.** No F10/IK_F10 entry appeared in installed `r6/config` XML/JSON or `%LOCALAPPDATA%/CD Projekt Red/Cyberpunk 2077/UserSettings.json`. Decoding every 16-bit key slot of every saved CET binding found no virtual key 121 (F10). F4 manager, F6 text, F7 voice, F8 group text and F10 group voice are optional development recommendations, preserving native F5 quicksave and F9 quickload. The player may choose different keys; the mod does not assign these automatically.

This was a source and configuration check. It did not press conversation hotkeys, open a microphone, or validate an actual group voice recording.
# Player-selected bindings

The player chooses every CET action binding. Registration labels contain action
names only. Runtime hints query CET's mod-scoped `IsBound(actionId)` and
`GetBind(actionId)` when shown, retaining the complete current modifier chord.
Unbound actions or unavailable APIs get an action-based fallback. Nothing caches
a binding during top-level script registration or rewrites the user's choices.

The API is implemented in pinned CET v1.37.1
[LuaSandbox.cpp](https://github.com/maximegmd/CyberEngineTweaks/blob/61bd6214f0f5f8748589c9e476538614a13908c0/src/scripting/LuaSandbox.cpp#L621).
`VKBindings::GetBindString` joins the current chord with ` + `; the overlay edits
that live map before Save persists it. The default recommendations discussed
above are for the optional development setup only, not automatic mod behavior.
