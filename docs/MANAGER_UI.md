# Native companion manager

The F5 screen is implemented in r6/scripts/CyberpunkConvai/Manager.reds with Codeware native widgets. Lua owns the catalogue, filtering, party state, settings, and actions. The screen reuses eight result widgets per refresh and never creates a widget for every game model.

## Lua to native API

Call these methods on PlayerPuppet. Setters prepare one update; call ConvaiManagerRefresh() after writing the full batch.

    ConvaiManagerClearRows()
    ConvaiManagerAddRow(key: String, label: String, note: String, selected: Bool)
    ConvaiManagerSetDetail(title: String, body: String,
        primaryAction: String, primaryLabel: String, primaryEnabled: Bool,
        secondaryAction: String, secondaryLabel: String, secondaryEnabled: Bool)
    ConvaiManagerSetPage(text: String, previous: Bool, next: Bool)
    ConvaiManagerSetTab(tab: String)
    ConvaiManagerSetSearch(text: String)
    ConvaiManagerSetFeedback(text: String)
    ConvaiManagerSetPartyStatus(text: String)
    ConvaiManagerRefresh()
    ConvaiManagerTakeRequest() -> String
    ConvaiManagerIsOpen() -> Bool
    ConvaiOpenManager() -> Bool
    ConvaiCloseManager() -> Bool

Rows with empty keys and rows after the eighth are ignored. Tab values are characters, models, party, and settings. ConvaiManagerSetSearch updates the field without producing a search request. ConvaiManagerSetPartyStatus supplies the compact header status, such as Party: 3/8.

## Native to Lua requests

ConvaiManagerTakeRequest() returns the oldest pending request, or an empty string when the queue is empty:

- tab:characters, tab:models, tab:party, or tab:settings
- search:<original-case text>
- select:<row-key>
- page:previous or page:next
- The exact primary or secondary action string supplied by Lua.

The FIFO holds at most 64 requests. Consecutive search edits are coalesced, adjacent duplicate requests are suppressed, and a full queue reports feedback. Detail text pagination is local to the screen; its internal _detail:previous and _detail:next controls do not reach Lua.

Opening requests the stored tab and search. Clicking a tab clears the search and requests both the new tab and the empty query. Search, result pagination, and selection disable stale detail actions until Lua supplies updated data. The native layer never spawns or dismisses entities.

## Controls and presentation

- Four tabs: Characters, Game models, Your party, and Settings.
- Native OriginalCase search input, limited to 96 characters, with native caret, selection, and clipboard behavior. Input waiting for glyph measurement is queued.
- Mouse selection, result pagination, and primary or secondary actions.
- Up/Down selects a visible row; Left/Right changes result pages; Ctrl+Left/Right changes tabs; Tab switches between search and list; Enter invokes an enabled primary action. Navigation shortcuts yield to the focused search field.
- Long details have their own compact text pages. Long status messages are also preserved in the detail text.
- Escape uses Codeware's native cancel handling. F5 remains owned by the CET hotkey; use ConvaiCloseManager(), then ConvaiOpenManager() when no manager was open.

## Popup ownership

Closing is idempotent. A close requested before Codeware attaches the delayed popup is deferred until OnShow. Detach unregisters raw keyboard input and calls the base lifecycle so Codeware restores its modal context, blur, and radial-menu time dilation. Identity checks prevent a late callback from clearing a newer popup's owner reference. The pending request queue is cleared when the owned popup closes.

Codeware applies its existing radial-menu time dilation while open. Lua must use actual entity readiness before reporting a successful spawn.

## Compatibility

The existing six-slot settings and PlayerPuppet methods remain available: ConvaiManagerName, ConvaiManagerSelected, ConvaiManagerSelect, ConvaiManagerEnabled, ConvaiManagerSetEnabled, ConvaiManagerVoice, ConvaiManagerSetVoice, ConvaiManagerSubtitles, ConvaiManagerSetSubtitles, and ConvaiManagerRevision.

## Verification

The complete repository script set compiled with scripts/Compile-Redscript.ps1 -StagedAudio, exit code 0, on 2026-09-28 at 12:07:07 +0530. The log is vendor/compiler-check-55bb38b3b7974978819230f7d2ca5ac0/compile.log.

In-game visual and interaction acceptance remains pending: different display resolutions, rapid mixed-case typing, tab and result navigation, long details, enabled and disabled actions, and repeated Escape/F5 close and reopen. Compilation does not establish those results.
