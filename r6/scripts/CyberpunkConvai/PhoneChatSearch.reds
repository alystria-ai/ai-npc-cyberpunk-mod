module CyberpunkConvai

@if(ModuleExists("Codeware.UI"))
import Codeware.UI.*
@if(ModuleExists("Codeware.UI.TextInput"))
import Codeware.UI.TextInput.*

// Search on the phone's Chat list (docs/PHONE_CHAT.md, "Search on the Chat list"). On a keyboard the Chat list has a search row as its first row (above the
// people, the same width, the O key shown in it). O, / or a click on the row puts the keyboard in it. Typing filters the list to the people whose name has a
// word that starts with each typed word. Enter leaves the row for the first match (the usual list keys work then), Esc clears the search and leaves the row.
//
// The row is drawn from plain ink widgets and costs nothing while it rests. Codeware's text input (which runs a 60 Hz animation tick of its own) is made only
// when the search starts and taken away again when it ends. Lua owns the matching (mod/phone-chat.lua searchIds: case and accent insensitive, word starts).
// The list asks on a change of the text and Lua answers on its 10 Hz tick with the ids that match (PlayerPuppet.ConvaiPhoneChatSearchResult), so nothing runs
// per frame. The whole Chat list is kept as it was built (m_convaiSearchRows) and the filtered list is filled from it, so a keystroke does not read the
// journal again. Without Codeware's text input these scripts still compile: no row is built and the key does nothing.
//
// The typing flag (ConvaiSearchTyping, read by mod/phone-input.lua to keep the game's menu keys shut) is true only while the focus really is in a box the player
// can see on the Chat list, or for the few ticks after the Esc that left it (until that Esc has come up). It is checked against the live widgets every time it is
// asked, and the Lua tick (ConvaiSearchTick) lets go of everything if the phone, the list or the box is no longer there. It never outlives the box.

// ---------------------------------------------------------------------------------------------------------------------------------
// The text box

@if(ModuleExists("Codeware.UI.TextInput"))
public class ConvaiPhoneSearchInput extends HubTextInput {
    private let m_keys: array<ref<inkKeyInputEvent>>;
    private let m_owner: wref<NewHudPhoneGameController>;
    // The key that opened the box is still going through the game's input when the box takes the focus: a letter typed by that very press is dropped.
    private let m_guardUntil: Float;

    public static func Create(owner: wref<NewHudPhoneGameController>) -> ref<ConvaiPhoneSearchInput> {
        let input = new ConvaiPhoneSearchInput();
        input.m_owner = owner;
        input.CreateInstance();
        input.SetLetterCase(textLetterCase.OriginalCase);
        input.SetMaxLength(60);
        input.SetDefaultText("");
        return input;
    }

    // The size of a Chat row of the game's list (1000 by 100 in the phone's 4K layout), with the text set like the names in the rows.
    protected func CreateWidgets() -> Void {
        super.CreateWidgets();
        this.m_text.SetFontSize(42);
        this.m_root.SetHeight(100.0);
        this.m_wrapper.SetMargin(new inkMargin(40.0, 28.0, 40.0, 0.0));
    }

    // Enter leaves the row for the first match and Escape clears the search: neither reaches the text. Everything else is the box's own (caret, selection, clipboard).
    protected cb func OnInputKey(evt: ref<inkKeyInputEvent>) {
        if Equals(evt.GetKey(), EInputKey.IK_Enter) {
            if Equals(evt.GetAction(), EInputAction.IACT_Press) { this.m_owner.ConvaiSearchEnter(); };
            return;
        };
        if Equals(evt.GetKey(), EInputKey.IK_Escape) {
            if Equals(evt.GetAction(), EInputAction.IACT_Press) { this.m_owner.ConvaiSearchEscape(); };
            return;
        };
        super.OnInputKey(evt);
    }

    protected func ProcessInputEvent(evt: ref<inkKeyInputEvent>) -> Void {
        if this.m_guardUntil > 0.0 && this.m_owner.ConvaiSearchNow() < this.m_guardUntil
            && (Equals(evt.GetKey(), EInputKey.IK_O) || Equals(evt.GetKey(), EInputKey.IK_Slash)) { return; };
        // The Codeware glyph measurer is busy for a moment after each letter: keys that come meanwhile wait their turn instead of being lost.
        if this.m_measurer.IsMeasuring() || ArraySize(this.m_keys) > 0 {
            if ArraySize(this.m_keys) < 128 { ArrayPush(this.m_keys, evt); };
        } else { super.ProcessInputEvent(evt); };
    }

    protected cb func OnHoldTick(anim: ref<inkAnimProxy>) {
        super.OnHoldTick(anim);
        if !this.m_measurer.IsMeasuring() && ArraySize(this.m_keys) > 0 {
            let evt = this.m_keys[0];
            ArrayErase(this.m_keys, 0);
            super.ProcessInputEvent(evt);
        };
    }

    protected cb func OnReleaseKey(evt: ref<inkPointerEvent>) {
        // Codeware's generic input maps an equipment action to clearing the text; here that key stays an ordinary character.
        if !evt.IsAction(n"unequip_item") { super.OnReleaseKey(evt); };
    }

    public final func Guard(seconds: Float) -> Void { this.m_guardUntil = this.m_owner.ConvaiSearchNow() + seconds; }

    public final func SetSearchText(value: String) -> Void {
        ArrayClear(this.m_keys);
        this.SetText(value);
        this.SetCaretPosition(UTF8StrLen(value));
    }

    // The box is going away: its animation tick (every frame, in Codeware's text input) stops here, so a rested search row costs nothing.
    public final func Stop() -> Void {
        ArrayClear(this.m_keys);
        if IsDefined(this.m_holdTickProxy) {
            this.m_holdTickProxy.Stop();
            this.m_holdTickProxy = null;
        };
    }
}

@if(!ModuleExists("Codeware.UI.TextInput"))
public class ConvaiPhoneSearchInput extends IScriptable {
    public static func Create(owner: wref<NewHudPhoneGameController>) -> ref<ConvaiPhoneSearchInput> {
        return null;
    }
}

// A click on the resting row: handled by the phone (the row's own widgets are plain ink, the box does not exist yet).
public class ConvaiSearchOpenEvent extends Event {
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The player: the request to Lua and its answer (mod/phone-chat.lua takeSearch)

@addField(PlayerPuppet)
private let m_convaiSearchSeq: Int32;
@addField(PlayerPuppet)
private let m_convaiSearchQuery: String;
@addField(PlayerPuppet)
private let m_convaiSearchJournal: String;
@addField(PlayerPuppet)
private let m_convaiSearchView: wref<NewHudPhoneGameController>;

// A new question: the typed text and the names the journal gives its contacts ("id", a tab, "name", a line each). Returns the number of the question
// (it only grows, whatever list asks), which the answer carries back.
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatSearchAsk(query: String, journal: String) -> Int32 {
    this.m_convaiSearchSeq += 1;
    this.m_convaiSearchQuery = query;
    this.m_convaiSearchJournal = journal;
    return this.m_convaiSearchSeq;
}
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatSearchSeq() -> Int32 { return this.m_convaiSearchSeq; }
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatSearchQuery() -> String { return this.m_convaiSearchQuery; }
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatSearchJournal() -> String { return this.m_convaiSearchJournal; }
// The answer: the ids of the matching contacts, one per line. Handed to the list that asked; nothing else holds it.
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatSearchResult(seq: Int32, ids: String) -> Void {
    if IsDefined(this.m_convaiSearchView) { this.m_convaiSearchView.ConvaiSearchApply(seq, ids); };
}
// The list that owns the search. It is set when a search starts and stays set (a weak reference) until the phone's controller is taken down: the typing
// flag must be answerable by the list for as long as the list can be typing, and for the Esc that leaves it, after the search itself is over.
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatSearchView(view: wref<NewHudPhoneGameController>) -> Void { this.m_convaiSearchView = view; }
// True while the player types in the search box (or has just pressed Esc in it): phone-input.lua then keeps the game's menu keys shut.
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatSearchTyping() -> Bool {
    return IsDefined(this.m_convaiSearchView) && this.m_convaiSearchView.ConvaiSearchTyping();
}
// Lua's 10 Hz tick (ConvaiPhoneChatTick): the search lets go of everything that outlived its box.
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatSearchTick() -> Void {
    if IsDefined(this.m_convaiSearchView) { this.m_convaiSearchView.ConvaiSearchTick(); };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The Chat list

@addField(NewHudPhoneGameController)
private let m_convaiSearchBox: ref<ConvaiPhoneSearchInput>;
// A search is going on: the box exists (made when it starts, taken away when it ends). A filter is in force once an answer has come for the text.
@addField(NewHudPhoneGameController)
private let m_convaiSearchOpen: Bool;
@addField(NewHudPhoneGameController)
private let m_convaiSearchFilter: Bool;
// The number of the last question asked (an answer for another number is dropped) and the matching ids of the last answer.
@addField(NewHudPhoneGameController)
private let m_convaiSearchSeq: Int32;
@addField(NewHudPhoneGameController)
private let m_convaiSearchIds: array<String>;
// The whole Chat list as the last build made it, and the journal names of its rows for Lua ("id", a tab, "name", a line each).
@addField(NewHudPhoneGameController)
private let m_convaiSearchRows: array<ref<IScriptable>>;
@addField(NewHudPhoneGameController)
private let m_convaiSearchJournal: String;
// Enter was pressed before the answer for the text came: the row is left for the first row of the answer.
@addField(NewHudPhoneGameController)
private let m_convaiSearchLeaveOnAnswer: Bool;
// The Esc or Enter that left the box: true from its press until it has come up again (the release is seen by the list's key callback) and two Lua ticks more,
// and never for more than six ticks. While it is true the game's Esc, Enter and Back are the search's (they must not close the phone, open the pause menu or open the
// chat of the row the selection has just gone to).
@addField(NewHudPhoneGameController)
private let m_convaiSearchLeaving: Bool;
@addField(NewHudPhoneGameController)
private let m_convaiSearchLeavingTicks: Int32;
@addField(NewHudPhoneGameController)
private let m_convaiSearchLeavingFrames: Int32;
// The engine time of that key: the flag is also dropped when it is older than a second and a half, if no tick has come to end it.
@addField(NewHudPhoneGameController)
private let m_convaiSearchLeavingAt: Float;
// The box is to be taken away at the next tick (it was left from inside its own key callback, where it cannot be removed), and the ticks the box has been
// without the focus and without text (a search nobody is using ends by itself).
@addField(NewHudPhoneGameController)
private let m_convaiSearchDrop: Bool;
@addField(NewHudPhoneGameController)
private let m_convaiSearchIdle: Int32;
@addField(NewHudPhoneGameController)
private let m_convaiSearchMuted: Bool;

@addMethod(NewHudPhoneGameController)
public final func ConvaiSearchNow() -> Float {
    if !IsDefined(this.m_player) { return 0.0; };
    return EngineTime.ToFloat(GameInstance.GetEngineTime(this.m_player.GetGame()));
}

// The player is typing in the box: the focus is in it, on the Chat list, in a phone the player can see, or the Esc that left it has not come up yet.
@addMethod(NewHudPhoneGameController)
public final func ConvaiSearchTyping() -> Bool {
    if this.m_convaiSearchLeaving {
        if this.ConvaiSearchNow() - this.m_convaiSearchLeavingAt < 1.5 { return true; };
        this.m_convaiSearchLeaving = false;
    };
    return this.m_convaiSearchOpen && Equals(this.m_convaiChatState, ConvaiPhoneChatState.List) && this.ConvaiSearchBoxFocused() && this.ConvaiSearchOnScreen();
}

// The Chat list is up and on the screen: the phone is open, no menu has hidden it (the game hides the phone's window while a menu is open), the dialer is shown.
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchOnScreen() -> Bool {
    if !IsDefined(this.m_player) || !IsDefined(this.m_contactListLogicController) || !this.m_player.ConvaiPhoneIsOpen() { return false; };
    return this.m_contactListLogicController.ConvaiSearchOnScreen() && this.GetRootWidget().IsVisible();
}

@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchAvailable() -> Bool {
    return true;
}
@if(!ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchAvailable() -> Bool {
    return false;
}

@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxFocused() -> Bool {
    return IsDefined(this.m_convaiSearchBox) && this.m_convaiSearchBox.IsFocused();
}
@if(!ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxFocused() -> Bool {
    return false;
}

// The box is made when the search starts, inside the search row (above the row's own look, below its word and key), and shown at once.
@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxMake() -> Bool {
    if IsDefined(this.m_convaiSearchBox) { return true; };
    if !IsDefined(this.m_contactListLogicController) { return false; };
    let row = this.m_contactListLogicController.ConvaiSearchRow();
    if !IsDefined(row) { return false; };
    let box = ConvaiPhoneSearchInput.Create(this);
    box.SetWidth(1000.0);
    let root = box.GetRootWidget();
    root.SetName(n"convaiPhoneSearch");
    root.SetHAlign(inkEHorizontalAlign.Left);
    root.SetVAlign(inkEVerticalAlign.Top);
    root.SetMargin(new inkMargin(0.0, 0.0, 0.0, 0.0));
    box.Reparent(row, 2);
    box.RegisterToCallback(n"OnInput", this, n"OnConvaiSearchInput");
    this.m_convaiSearchBox = box;
    return true;
}
@if(!ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxMake() -> Bool {
    return false;
}

// The box is taken away: its tick stops, it loses the focus and leaves the row. Not from inside its own key callback (ConvaiSearchTick does that one).
@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxDrop() -> Void {
    this.m_convaiSearchDrop = false;
    if !IsDefined(this.m_convaiSearchBox) { return; };
    let box = this.m_convaiSearchBox;
    this.m_convaiSearchBox = null;
    box.Stop();
    if box.IsFocused() { this.RequestSetFocus(null); };
    let root = box.GetRootWidget();
    let row = IsDefined(this.m_contactListLogicController) ? this.m_contactListLogicController.ConvaiSearchRow() : null;
    if IsDefined(row) && IsDefined(root) { row.RemoveChild(root); };
}
@if(!ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxDrop() -> Void {
    this.m_convaiSearchDrop = false;
}

// The box belongs to a list that is gone: its tick stops and it is forgotten (nothing to remove, the list took it along).
@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxForget() -> Void {
    if IsDefined(this.m_convaiSearchBox) { this.m_convaiSearchBox.Stop(); };
    this.m_convaiSearchBox = null;
}
@if(!ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxForget() -> Void {
    this.m_convaiSearchBox = null;
}

// Focus in the box now (the player types at once), or off it while it waits to be taken away.
@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxFocus(focus: Bool) -> Void {
    if !IsDefined(this.m_convaiSearchBox) { return; };
    if focus {
        this.m_convaiSearchBox.Guard(0.3);
        this.RequestSetFocus(this.m_convaiSearchBox.GetRootWidget());
    } else {
        if this.m_convaiSearchBox.IsFocused() { this.RequestSetFocus(null); };
    };
}
@if(!ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxFocus(focus: Bool) -> Void {
}

@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxText() -> String {
    return IsDefined(this.m_convaiSearchBox) ? this.m_convaiSearchBox.GetText() : "";
}
@if(!ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxText() -> String {
    return "";
}

@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxClear() -> Void {
    if !IsDefined(this.m_convaiSearchBox) { return; };
    this.m_convaiSearchMuted = true;
    this.m_convaiSearchBox.SetSearchText("");
    this.m_convaiSearchMuted = false;
}
@if(!ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxClear() -> Void {
}

// The search row of the Chat list, shown when the list is built for a keyboard (and only when Codeware's text input is there to type in).
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchRowSync() -> Void {
    if !IsDefined(this.m_contactListLogicController) { return; };
    let show = this.ConvaiSearchAvailable() && IsDefined(this.m_player) && this.m_player.PlayerLastUsedKBM();
    this.m_contactListLogicController.ConvaiSearchRowShow(show);
    if show { this.m_contactListLogicController.ConvaiSearchRowLook(this.m_convaiSearchOpen, StrLen(this.ConvaiSearchBoxText()) == 0); };
}

// A click on the resting row.
@addMethod(NewHudPhoneGameController)
private cb func OnConvaiSearchOpenEvent(evt: ref<ConvaiSearchOpenEvent>) -> Bool {
    this.ConvaiSearchOpen();
    return true;
}

// The key that opens the search (O or /), and Up and Down while the player types (the list's own keys do not reach a list whose focus is in the box).
// Returns true when the key is the search's: opened or taken by the box.
@if(ModuleExists("Codeware"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchKey(key: EInputKey) -> Bool {
    if this.ConvaiSearchTyping() {
        if Equals(key, EInputKey.IK_Up) { this.m_contactListLogicController.ConvaiSearchMove(-1); };
        if Equals(key, EInputKey.IK_Down) { this.m_contactListLogicController.ConvaiSearchMove(1); };
        return true;
    };
    if Equals(key, EInputKey.IK_O) || Equals(key, EInputKey.IK_Slash) {
        this.ConvaiSearchOpen();
        return true;
    };
    return false;
}

// Starts the search (or puts the keyboard back in its box): the row is made if it is not there, the box is made inside it and takes the focus.
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchOpen() -> Void {
    if !IsDefined(this.m_player) || !IsDefined(this.m_contactListLogicController) || NotEquals(this.m_convaiChatState, ConvaiPhoneChatState.List) { return; };
    // The key box of a keyboard: a pad has no such key and no hint for it.
    if !this.m_player.PlayerLastUsedKBM() || !this.ConvaiSearchAvailable() { return; };
    this.m_contactListLogicController.ConvaiSearchRowShow(true);
    if !this.ConvaiSearchBoxMake() { return; };
    this.m_convaiSearchDrop = false;
    this.m_convaiSearchIdle = 0;
    if !this.m_convaiSearchOpen {
        this.m_convaiSearchOpen = true;
        this.m_convaiSearchFilter = false;
        this.m_convaiSearchLeaveOnAnswer = false;
        this.m_convaiSearchSeq = -1;
        ArrayClear(this.m_convaiSearchIds);
        this.m_player.ConvaiPhoneChatSearchView(this);
        this.m_player.ConvaiPhoneChatTrace("search: opened");
    };
    this.m_contactListLogicController.ConvaiSearchRowLook(true, StrLen(this.ConvaiSearchBoxText()) == 0);
    this.ConvaiSearchBoxFocus(true);
}

// The text changed (the box's own OnInput): an empty text shows the whole list at once, any other text is asked of Lua.
@addMethod(NewHudPhoneGameController)
private cb func OnConvaiSearchInput(widget: wref<inkWidget>) -> Bool {
    if !this.m_convaiSearchOpen || this.m_convaiSearchMuted || !IsDefined(this.m_player) { return false; };
    let text = this.ConvaiSearchBoxText();
    this.m_contactListLogicController.ConvaiSearchRowLook(true, StrLen(text) == 0);
    if StrLen(text) == 0 {
        this.m_convaiSearchSeq = -1;
        this.m_convaiSearchFilter = false;
        this.m_convaiSearchLeaveOnAnswer = false;
        ArrayClear(this.m_convaiSearchIds);
        this.m_contactListLogicController.ConvaiRefillChat(this.m_convaiSearchRows);
        return true;
    };
    this.m_convaiSearchSeq = this.m_player.ConvaiPhoneChatSearchAsk(text, this.m_convaiSearchJournal);
    return true;
}

// Lua's answer: a line per matching contact id. Dropped when the text has changed since (another question is on its way).
@addMethod(NewHudPhoneGameController)
public final func ConvaiSearchApply(seq: Int32, ids: String) -> Void {
    if !this.m_convaiSearchOpen || seq != this.m_convaiSearchSeq || !IsDefined(this.m_contactListLogicController) { return; };
    this.m_convaiSearchIds = StrSplit(ids, "\n");
    this.m_convaiSearchFilter = true;
    if NotEquals(this.m_convaiChatState, ConvaiPhoneChatState.List) { return; };
    this.m_contactListLogicController.ConvaiRefillChat(this.ConvaiSearchFilterRows());
    if this.m_convaiSearchLeaveOnAnswer {
        this.m_convaiSearchLeaveOnAnswer = false;
        this.ConvaiSearchLeave(false);
    };
}

@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchFilterRows() -> array<ref<IScriptable>> {
    let kept: array<ref<IScriptable>>;
    for row in this.m_convaiSearchRows {
        let contact = row as ContactData;
        if IsDefined(contact) && ArrayContains(this.m_convaiSearchIds, contact.id) { ArrayPush(kept, row); };
    };
    return kept;
}

// Called by the Chat list's build (ConvaiShowChatContacts) with every row it made: keeps them, and gives back the rows to show (those of the search while one is in force).
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchRowsBuilt(rows: array<ref<IScriptable>>) -> array<ref<IScriptable>> {
    this.m_convaiSearchRows = rows;
    let names = "";
    for row in rows {
        let contact = row as ContactData;
        if IsDefined(contact) && contact.hash != 0 && StrLen(contact.convaiPlainName) > 0 { names += contact.id + "\t" + contact.convaiPlainName + "\n"; };
    };
    this.m_convaiSearchJournal = names;
    if this.m_convaiSearchOpen && this.m_convaiSearchFilter && IsDefined(this.m_convaiSearchBox) { return this.ConvaiSearchFilterRows(); };
    return rows;
}

// Enter in the box: the row is left and the selection goes to the first match, the keyboard is the list's again (T chat, H call, F favorite, Up and Down). No chat opens.
// While the answer for the last typed letter is on its way the first row of the answer is the match. With no match Enter does nothing.
@addMethod(NewHudPhoneGameController)
public final func ConvaiSearchEnter() -> Void {
    if !this.m_convaiSearchOpen || NotEquals(this.m_convaiChatState, ConvaiPhoneChatState.List) { return; };
    if this.m_convaiSearchSeq > 0 && !this.m_convaiSearchFilter {
        this.m_convaiSearchLeaveOnAnswer = true;
        return;
    };
    this.ConvaiSearchLeave(true);
}

// The row is left for the first row of the list. The game's own Enter (its confirm, which opens the chat of the selected row) is the search's until the Enter has come up,
// as the Esc is. The search stays in force (the text stays in the row, not focused) until Esc or Back, or ends by itself when the row holds no text.
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchLeave(keyDown: Bool) -> Void {
    if !IsDefined(this.m_contactListLogicController) { return; };
    let first = this.m_contactListLogicController.ConvaiChatContactAt(0u);
    if !IsDefined(first) { return; };
    if keyDown {
        this.m_convaiSearchLeaving = true;
        this.m_convaiSearchLeavingAt = this.ConvaiSearchNow();
        this.m_convaiSearchLeavingTicks = 0;
        this.m_convaiSearchLeavingFrames = 0;
    };
    this.m_contactListLogicController.ConvaiSearchSelectFirst();
    this.ConvaiSearchBoxFocus(false);
    this.m_contactListLogicController.ConvaiSearchRowLook(false, StrLen(this.ConvaiSearchBoxText()) == 0);
    if IsDefined(this.m_player) { this.m_player.ConvaiPhoneChatTrace("search: left the row for the first match"); };
}

// Esc in the box: the search is cleared and the box is left (the whole list is back around the selected person). That Esc must not also close the phone or open the
// pause menu: it is the search's until it has come up again (m_convaiSearchLeaving, which the game's actions and phone-input.lua both honour through the typing flag).
// The box itself is taken away at the next tick, not here: this runs inside its own key callback.
@addMethod(NewHudPhoneGameController)
public final func ConvaiSearchEscape() -> Void {
    if !this.m_convaiSearchOpen { return; };
    this.m_convaiSearchLeaving = true;
    this.m_convaiSearchLeavingAt = this.ConvaiSearchNow();
    this.m_convaiSearchLeavingTicks = 0;
    this.m_convaiSearchLeavingFrames = 0;
    this.ConvaiSearchEnd(true, true);
}

// The Esc key came up (the list's key callback): two Lua ticks more and the Esc is the game's again.
@addMethod(NewHudPhoneGameController)
public final func ConvaiSearchKeyReleased() -> Void {
    if this.m_convaiSearchLeaving && this.m_convaiSearchLeavingFrames == 0 { this.m_convaiSearchLeavingFrames = 2; };
}

// The search ends: the text is cleared, the box loses the focus (and is taken away now, or at the next tick when `later`), and the whole list is back
// (built again around the selected contact when `rebuild`). The row stays, at rest.
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchEnd(rebuild: Bool, later: Bool) -> Void {
    if !this.m_convaiSearchOpen && !this.m_convaiSearchDrop && !IsDefined(this.m_convaiSearchBox) { return; };
    let selectId = "";
    if rebuild && IsDefined(this.m_contactListLogicController) {
        let selected = this.m_contactListLogicController.GetSelectedContactData();
        if IsDefined(selected) { selectId = selected.id; };
    };
    let wasOpen = this.m_convaiSearchOpen;
    this.m_convaiSearchOpen = false;
    this.m_convaiSearchFilter = false;
    this.m_convaiSearchLeaveOnAnswer = false;
    this.m_convaiSearchSeq = -1;
    this.m_convaiSearchIdle = 0;
    ArrayClear(this.m_convaiSearchIds);
    this.ConvaiSearchBoxClear();
    this.ConvaiSearchBoxFocus(false);
    if later { this.m_convaiSearchDrop = true; } else { this.ConvaiSearchBoxDrop(); };
    if IsDefined(this.m_contactListLogicController) { this.m_contactListLogicController.ConvaiSearchRowLook(false, true); };
    if wasOpen && IsDefined(this.m_player) { this.m_player.ConvaiPhoneChatTrace("search: closed"); };
    if rebuild && IsDefined(this.m_contactListLogicController) && Equals(this.m_convaiChatState, ConvaiPhoneChatState.List) { this.ConvaiShowChatContacts(selectId); };
}

// Everything the search holds is let go, and the row goes away (a tab change, the phone closing, a load, anything that leaves the Chat list). Nothing is rebuilt.
// Costs nothing when there is no search and no row.
@addMethod(NewHudPhoneGameController)
public final func ConvaiSearchClose(rebuild: Bool) -> Void {
    this.m_convaiSearchLeaving = false;
    this.m_convaiSearchLeavingTicks = 0;
    this.m_convaiSearchLeavingFrames = 0;
    this.ConvaiSearchEnd(rebuild, false);
    if IsDefined(this.m_contactListLogicController) { this.m_contactListLogicController.ConvaiSearchRowShow(false); };
    this.ConvaiSearchReset();
}

// The phone's controller is being taken down (a load, leaving the game): the search lets go of everything and the player forgets the list.
@addMethod(NewHudPhoneGameController)
public final func ConvaiSearchUninitialize() -> Void {
    this.ConvaiSearchClose(false);
    if IsDefined(this.m_player) { this.m_player.ConvaiPhoneChatSearchView(null); };
}

// Nothing of an earlier search survives: every field of the phone's controller that a search uses is put back. Closing the search for good (ConvaiSearchClose) does it,
// and the game sets the screen type (SetScreenType, wrapped in PhoneChatTabs.reds) when it spawns the list of a newly opened phone, which closes it too, so a new list
// never meets the state of an old one. The full list is then built from the journal as on a first opening.
@addMethod(NewHudPhoneGameController)
public final func ConvaiSearchReset() -> Void {
    this.m_convaiSearchOpen = false;
    this.m_convaiSearchFilter = false;
    this.m_convaiSearchLeaveOnAnswer = false;
    this.m_convaiSearchSeq = -1;
    this.m_convaiSearchIdle = 0;
    this.m_convaiSearchDrop = false;
    this.m_convaiSearchMuted = false;
    this.m_convaiSearchLeaving = false;
    this.m_convaiSearchLeavingTicks = 0;
    this.m_convaiSearchLeavingFrames = 0;
    ArrayClear(this.m_convaiSearchIds);
    ArrayClear(this.m_convaiSearchRows);
    this.m_convaiSearchJournal = "";
    this.ConvaiSearchBoxForget();
}

// Lua's 10 Hz tick. The failsafes live here: the Esc flag ends by itself, a box left from its own callback is taken away, a search nobody uses ends, and
// a search whose phone or list is no longer on the screen is let go of whole, whatever closed it.
@addMethod(NewHudPhoneGameController)
public final func ConvaiSearchTick() -> Void {
    if this.m_convaiSearchLeaving {
        this.m_convaiSearchLeavingTicks += 1;
        if this.m_convaiSearchLeavingFrames > 0 {
            this.m_convaiSearchLeavingFrames -= 1;
            if this.m_convaiSearchLeavingFrames == 0 { this.m_convaiSearchLeaving = false; };
        } else {
            if this.m_convaiSearchLeavingTicks >= 6 { this.m_convaiSearchLeaving = false; };
        };
    };
    if !this.m_convaiSearchOpen && !this.m_convaiSearchDrop && !IsDefined(this.m_convaiSearchBox) { return; };
    if !this.ConvaiSearchOnScreen() {
        this.ConvaiSearchClose(false);
        return;
    };
    if this.m_convaiSearchDrop {
        this.ConvaiSearchBoxDrop();
        return;
    };
    if this.m_convaiSearchOpen && Equals(this.m_convaiChatState, ConvaiPhoneChatState.List) {
        if !this.ConvaiSearchBoxFocused() && StrLen(this.ConvaiSearchBoxText()) == 0 {
            this.m_convaiSearchIdle += 1;
            if this.m_convaiSearchIdle >= 3 { this.ConvaiSearchEnd(false, false); };
        } else { this.m_convaiSearchIdle = 0; };
    };
}

// The game's Back (C, and Esc when it is not in the box): with a search in force it ends the search first, as Esc in the box does. The Esc that has just left the box
// is not a Back.
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBackHandled() -> Bool {
    if this.m_convaiSearchLeaving { return true; };
    if this.m_convaiSearchOpen && Equals(this.m_convaiChatState, ConvaiPhoneChatState.List) {
        this.ConvaiSearchEnd(true, false);
        return true;
    };
    return false;
}

@wrapMethod(NewHudPhoneGameController)
public func Back() -> Void {
    if this.ConvaiSearchBackHandled() { return; };
    wrappedMethod();
}

// While the player types in the box the phone's list must not act on the keys: A and D change tab, F and R open a chat, V calls. A release is swallowed
// only for the actions that open or call (their release is the game's click); every other release, and the wheel, go to the game as before.
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchSwallows(action: ListenerAction) -> Bool {
    if !this.ConvaiSearchTyping() { return false; };
    let type = ListenerAction.GetType(action);
    if Equals(type, gameinputActionType.BUTTON_PRESSED) || Equals(type, gameinputActionType.REPEAT) { return true; };
    if !Equals(type, gameinputActionType.BUTTON_RELEASED) { return false; };
    let name = ListenerAction.GetName(action);
    return Equals(name, n"click") || Equals(name, n"proceed") || Equals(name, n"call") || Equals(name, n"cancel") || Equals(name, n"OpenPauseMenu")
        || Equals(name, n"secondaryAction") || Equals(name, n"showAll") || Equals(name, n"popup_goto") || Equals(name, n"popup_goto_messenger");
}

// The Esc that the search swallows must not come up as the game's: the phone itself marks the press of the pause action this way (its list input does
// DontSendReleaseEvent on it), so no release reaches the pause menu, which opens on the release. A press the search swallows without this leaves a release behind that
// opens the pause menu over the open phone (30 Oct live test: the pause menu opened and then ignored every click and key).
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchHoldsPause(action: ListenerAction, consumer: ListenerActionConsumer) -> Void {
    if Equals(ListenerAction.GetName(action), n"OpenPauseMenu") && Equals(ListenerAction.GetType(action), gameinputActionType.BUTTON_PRESSED) {
        ListenerActionConsumer.DontSendReleaseEvent(consumer);
    };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The list of the phone

// The look of the row. The hint ("Type a name to search") and the key are plain ink, the hint is put in the interface language by mod/phone-chat-style.lua (convaiSearchPlaceholder).
@addField(PhoneDialerLogicController)
private let m_convaiSearchRow: wref<inkCanvas>;
@addField(PhoneDialerLogicController)
private let m_convaiSearchPlaceholder: wref<inkText>;
@addField(PhoneDialerLogicController)
private let m_convaiSearchCap: wref<inkImage>;
// The list's scroll area and scroll bar are moved down by the height of the row while the row shows, and put back when it goes.
@addField(PhoneDialerLogicController)
private let m_convaiSearchArea: wref<inkWidget>;
@addField(PhoneDialerLogicController)
private let m_convaiSearchShifted: Bool;
@addField(PhoneDialerLogicController)
private let m_convaiSearchAreaMargin: inkMargin;
@addField(PhoneDialerLogicController)
private let m_convaiSearchBarMargin: inkMargin;

// The row, made once beside the list's scroll area (in the panel that holds it, in front of the gradient mask that fades the list so the row is not faded):
// the dark bar and the thin line of a field, the hint and the O key. It is 1000 by 100 like a Chat row, at the left of the scroll area's width.
@addMethod(PhoneDialerLogicController)
private final func ConvaiSearchRowMake() -> Bool {
    if IsDefined(this.m_convaiSearchRow) { return true; };
    let list = inkWidgetRef.Get(this.m_contactsList);
    let area = IsDefined(list) ? list.GetParentWidget() : null;
    let holder = IsDefined(area) ? area.GetParentWidget() as inkCompoundWidget : null;
    if !IsDefined(holder) { return false; };
    let row = new inkCanvas();
    row.SetName(n"convaiPhoneSearchRow");
    row.SetSize(new Vector2(1100.0, 100.0));
    row.SetHAlign(inkEHorizontalAlign.Right);
    row.SetVAlign(inkEVerticalAlign.Top);
    row.SetMargin(new inkMargin(0.0, 0.0, area.GetMargin().right, 0.0));
    row.SetInteractive(true);
    row.SetAffectsLayoutWhenHidden(false);
    row.SetVisible(false);
    let bar = new inkRectangle();
    bar.SetName(n"convaiSearchRowBar");
    bar.SetSize(new Vector2(1000.0, 100.0));
    bar.SetHAlign(inkEHorizontalAlign.Left);
    bar.SetVAlign(inkEVerticalAlign.Top);
    bar.SetInteractive(false);
    bar.SetStyle(r"base\\gameplay\\gui\\common\\main_colors.inkstyle");
    bar.BindProperty(n"tintColor", n"MainColors.Fullscreen_PrimaryBackgroundDarkest");
    bar.SetOpacity(0.55);
    bar.Reparent(row);
    let line = new inkRectangle();
    line.SetName(n"convaiSearchRowLine");
    line.SetSize(new Vector2(1000.0, 2.0));
    line.SetHAlign(inkEHorizontalAlign.Left);
    line.SetVAlign(inkEVerticalAlign.Bottom);
    line.SetInteractive(false);
    line.SetStyle(r"base\\gameplay\\gui\\common\\main_colors.inkstyle");
    line.BindProperty(n"tintColor", n"MainColors.Blue");
    line.SetOpacity(0.45);
    line.Reparent(row);
    // The box goes in at index 2 (ConvaiSearchBoxMake), under the word and the key.
    let word = new inkText();
    word.SetName(n"convaiSearchPlaceholder");
    word.SetFontFamily("base\\gameplay\\gui\\fonts\\raj\\raj.inkfontfamily");
    word.SetFontStyle(n"Medium");
    word.SetFontSize(42);
    word.SetFitToContent(true);
    word.SetHAlign(inkEHorizontalAlign.Left);
    word.SetVAlign(inkEVerticalAlign.Center);
    word.SetMargin(new inkMargin(40.0, 0.0, 0.0, 0.0));
    word.SetInteractive(false);
    word.SetStyle(r"base\\gameplay\\gui\\common\\main_colors.inkstyle");
    word.BindProperty(n"tintColor", n"MainColors.Blue");
    word.SetOpacity(0.8);
    word.SetText("Type a name to search");
    word.Reparent(row);
    let cap = ConvaiFavoriteArt.KeyCap(n"kb_o");
    cap.SetHAlign(inkEHorizontalAlign.Left);
    cap.SetVAlign(inkEVerticalAlign.Top);
    cap.SetMargin(new inkMargin(906.0, 18.0, 0.0, 0.0));
    cap.Reparent(row);
    row.Reparent(holder, 0);
    row.RegisterToCallback(n"OnRelease", this, n"OnConvaiSearchRowClick");
    this.m_convaiSearchRow = row;
    this.m_convaiSearchPlaceholder = word;
    this.m_convaiSearchCap = cap;
    this.m_convaiSearchArea = area;
    return true;
}

@addMethod(PhoneDialerLogicController)
private cb func OnConvaiSearchRowClick(evt: ref<inkPointerEvent>) -> Bool {
    if evt.IsAction(n"click") {
        this.QueueEvent(new ConvaiSearchOpenEvent());
        evt.Handle();
    };
    return true;
}

// Shows the row (made on first use) and moves the list down by its height, or hides it and puts the list back. Costs nothing when there is no row to hide.
@addMethod(PhoneDialerLogicController)
public final func ConvaiSearchRowShow(visible: Bool) -> Void {
    if !visible && !IsDefined(this.m_convaiSearchRow) { return; };
    if visible && !this.ConvaiSearchRowMake() { return; };
    this.m_convaiSearchRow.SetVisible(visible);
    this.ConvaiSearchShift(visible);
}

@addMethod(PhoneDialerLogicController)
private final func ConvaiSearchShift(on: Bool) -> Void {
    if Equals(on, this.m_convaiSearchShifted) || !IsDefined(this.m_convaiSearchArea) { return; };
    let bar = inkWidgetRef.Get(this.m_scrollBarWidget);
    // Only the margin moves (the row's 100 and a gap of 12 below it). The size of the scroll area is never read or set: on a list that has just been spawned it
    // is not laid out yet, and a size taken then left the list with no room for any row (31 Oct live test, the Chat tab after reopening the phone).
    if on {
        let margin = this.m_convaiSearchArea.GetMargin();
        this.m_convaiSearchAreaMargin = margin;
        this.m_convaiSearchArea.SetMargin(new inkMargin(margin.left, margin.top + 112.0, margin.right, margin.bottom));
        if IsDefined(bar) {
            let barMargin = bar.GetMargin();
            this.m_convaiSearchBarMargin = barMargin;
            bar.SetMargin(new inkMargin(barMargin.left, barMargin.top + 112.0, barMargin.right, barMargin.bottom));
        };
    } else {
        this.m_convaiSearchArea.SetMargin(this.m_convaiSearchAreaMargin);
        if IsDefined(bar) { bar.SetMargin(this.m_convaiSearchBarMargin); };
    };
    this.m_convaiSearchShifted = on;
    let player = GetPlayer(GetGameInstance()) as PlayerPuppet;
    if on && IsDefined(player) { player.ConvaiPhoneChatTrace("search row: list moved down, scroll area margin top " + FloatToString(this.m_convaiSearchAreaMargin.top) + " + 112"); };
}

// The row at rest or in use: the hint shows while there is no text (dim while the box has the keyboard), the O key while the row rests.
@addMethod(PhoneDialerLogicController)
public final func ConvaiSearchRowLook(active: Bool, empty: Bool) -> Void {
    if IsDefined(this.m_convaiSearchPlaceholder) {
        this.m_convaiSearchPlaceholder.SetVisible(empty);
        this.m_convaiSearchPlaceholder.SetOpacity(active ? 0.45 : 0.8);
    };
    if IsDefined(this.m_convaiSearchCap) { this.m_convaiSearchCap.SetVisible(!active); };
}

// The box is made inside this canvas.
@addMethod(PhoneDialerLogicController)
public final func ConvaiSearchRow() -> wref<inkCompoundWidget> {
    return this.m_convaiSearchRow;
}

// The row is on the screen: it and everything above it up to the top of the phone's window are shown (the dialer hides itself when the list closes,
// and the game hides the phone's window while a menu is open).
@addMethod(PhoneDialerLogicController)
public final func ConvaiSearchOnScreen() -> Bool {
    let widget: wref<inkWidget> = this.m_convaiSearchRow;
    if !IsDefined(widget) { return false; };
    let steps = 0;
    while IsDefined(widget) && steps < 40 {
        if !widget.IsVisible() { return false; };
        widget = widget.GetParentWidget();
        steps += 1;
    };
    return true;
}

// The Chat list filled again with these rows (already the matches, or all of them), the first row selected.
@addMethod(PhoneDialerLogicController)
public final func ConvaiRefillChat(rows: array<ref<IScriptable>>) -> Void {
    this.PopulateListData(rows);
    this.m_indexToSelect = 0u;
    inkWidgetRef.SetVisible(this.m_nothingToReadMessageWidget, ArraySize(rows) == 0);
}

// The row at this place of the sorted list (null when there is none).
@addMethod(PhoneDialerLogicController)
public final func ConvaiChatContactAt(index: Uint32) -> ref<ContactData> {
    if index >= this.m_dataView.Size() { return null; };
    return this.m_dataView.GetItem(index) as ContactData;
}

// The selection goes to the first row of the list.
@addMethod(PhoneDialerLogicController)
public final func ConvaiSearchSelectFirst() -> Void {
    if this.m_dataView.Size() == 0u { return; };
    let list = inkWidgetRef.GetController(this.m_contactsList) as inkVirtualListController;
    if !IsDefined(list) { return; };
    list.SelectItem(0u);
    list.ScrollToIndex(0u);
}

// Up and Down while the player types: the selection moves one row, the list wraps as the game's does.
@addMethod(PhoneDialerLogicController)
public final func ConvaiSearchMove(step: Int32) -> Void {
    let size = Cast<Int32>(this.m_dataView.Size());
    if size <= 0 { return; };
    let at = Cast<Int32>(this.GetSelectedContactIndex()) + step;
    if at < 0 { at = size - 1; };
    if at >= size { at = 0; };
    let list = inkWidgetRef.GetController(this.m_contactsList) as inkVirtualListController;
    if !IsDefined(list) { return; };
    list.SelectItem(Cast<Uint32>(at));
    list.ScrollToIndex(Cast<Uint32>(at));
}

// The bottom bar's search hint on a keyboard: the O key of the game's keyboard art and the word Search, made once beside the favorite hint (the game's own
// Show all hint, which the Chat tab uses for F) and shown only on the Chat list. mod/phone-chat-style.lua puts the word in the interface language.
@addField(PhoneDialerLogicController)
private let m_convaiSearchHint: wref<inkHorizontalPanel>;

@addMethod(PhoneDialerLogicController)
public final func ConvaiSearchHintShow(visible: Bool) -> Void {
    if !IsDefined(this.m_convaiSearchHint) {
        if !visible { return; };
        let anchor = inkWidgetRef.Get(this.m_showAllButtonWidget);
        let holder = IsDefined(anchor) ? anchor.GetParentWidget() as inkCompoundWidget : null;
        if !IsDefined(holder) { return; };
        let hint = new inkHorizontalPanel();
        hint.SetName(n"convaiSearchHint");
        hint.SetFitToContent(true);
        hint.SetVAlign(inkEVerticalAlign.Center);
        hint.SetMargin(new inkMargin(28.0, 0.0, 0.0, 0.0));
        hint.SetChildMargin(new inkMargin(0.0, 0.0, 8.0, 0.0));
        hint.SetInteractive(false);
        ConvaiFavoriteArt.KeyCap(n"kb_o").Reparent(hint);
        let label = new inkText();
        label.SetName(n"convaiSearchHintLabel");
        label.SetFontFamily("base\\gameplay\\gui\\fonts\\raj\\raj.inkfontfamily");
        label.SetFontStyle(n"Medium");
        label.SetFontSize(32);
        label.SetFitToContent(true);
        label.SetVAlign(inkEVerticalAlign.Center);
        label.SetStyle(r"base\\gameplay\\gui\\common\\main_colors.inkstyle");
        label.BindProperty(n"tintColor", n"MainColors.Blue");
        label.SetText("Search");
        label.Reparent(hint);
        let at = holder.GetNumChildren();
        let i = 0;
        while i < holder.GetNumChildren() {
            if holder.GetWidgetByIndex(i) == anchor { at = i + 1; };
            i += 1;
        };
        hint.Reparent(holder, at);
        this.m_convaiSearchHint = hint;
    };
    this.m_convaiSearchHint.SetVisible(visible);
}
