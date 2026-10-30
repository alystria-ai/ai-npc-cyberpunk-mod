module CyberpunkConvai

@if(ModuleExists("Codeware.UI"))
import Codeware.UI.*
@if(ModuleExists("Codeware.UI.TextInput"))
import Codeware.UI.TextInput.*

// Search on the phone's Chat list (docs/PHONE_CHAT.md, "Search on the Chat list"). On a keyboard, O (or /) opens a one-line box in the place of the
// phone's tab strip; typing filters the list to the people whose name has a word that starts with each typed word; Enter opens the selected match,
// Esc clears the search and closes the box.
//
// Lua owns the matching (mod/phone-chat.lua searchIds: case and accent insensitive, word starts). The list asks on a change of the text and Lua answers on
// its 10 Hz tick with the ids that match (PlayerPuppet.ConvaiPhoneChatSearchResult), so nothing runs per frame and nothing runs at all while the box is
// closed. The whole Chat list is kept as it was built (m_convaiSearchRows) and the filtered list is filled from it, so a keystroke does not read the journal again.
// Without Codeware's text input these scripts still compile: the box is never built and the key does nothing.

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

    protected func CreateWidgets() -> Void {
        super.CreateWidgets();
        this.m_text.SetFontSize(32);
        this.m_root.SetHeight(64.0);
        this.m_wrapper.SetMargin(new inkMargin(16.0, 14.0, 16.0, 0.0));
    }

    // Enter opens the selected match and Escape clears the search: neither reaches the text. Everything else is the box's own (caret, selection, clipboard).
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
}

@if(!ModuleExists("Codeware.UI.TextInput"))
public class ConvaiPhoneSearchInput extends IScriptable {
    public static func Create(owner: wref<NewHudPhoneGameController>) -> ref<ConvaiPhoneSearchInput> {
        return null;
    }
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
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatSearchView(view: wref<NewHudPhoneGameController>) -> Void { this.m_convaiSearchView = view; }
// True while the player types in the search box (or has just pressed Esc in it): phone-input.lua then keeps the game's menu keys shut.
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatSearchTyping() -> Bool {
    return IsDefined(this.m_convaiSearchView) && this.m_convaiSearchView.ConvaiSearchTyping();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The Chat list

@addField(NewHudPhoneGameController)
private let m_convaiSearchBox: ref<ConvaiPhoneSearchInput>;
// The box is open (shown in the place of the tab strip). A filter is in force once an answer has come for the text.
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
@addField(NewHudPhoneGameController)
private let m_convaiSearchStrip: wref<inkWidget>;
// Enter was pressed before the answer for the text came: the first row of the answer is opened.
@addField(NewHudPhoneGameController)
private let m_convaiSearchOpenOnAnswer: Bool;
// The engine time until which an Esc that closed the box is still the box's (its game action must not close the phone).
@addField(NewHudPhoneGameController)
private let m_convaiSearchGuardUntil: Float;
@addField(NewHudPhoneGameController)
private let m_convaiSearchMuted: Bool;

@addMethod(NewHudPhoneGameController)
public final func ConvaiSearchNow() -> Float {
    if !IsDefined(this.m_player) { return 0.0; };
    return EngineTime.ToFloat(GameInstance.GetEngineTime(this.m_player.GetGame()));
}

// The player is typing in the box: it has the focus on the Chat list, or the Esc that closed it has only just been pressed.
@addMethod(NewHudPhoneGameController)
public final func ConvaiSearchTyping() -> Bool {
    if this.m_convaiSearchGuardUntil > 0.0 && this.ConvaiSearchNow() < this.m_convaiSearchGuardUntil { return true; };
    return this.m_convaiSearchOpen && Equals(this.m_convaiChatState, ConvaiPhoneChatState.List) && this.ConvaiSearchBoxFocused();
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

// The box is made once, beside the phone's tab strip (same parent, same place), and shown in place of it while the search is open.
@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxMake() -> Bool {
    if IsDefined(this.m_convaiSearchBox) { return true; };
    let strip = this.m_contactListLogicController.ConvaiSearchStrip();
    let parent = IsDefined(strip) ? strip.GetParentWidget() as inkCompoundWidget : null;
    if !IsDefined(parent) { return false; };
    let box = ConvaiPhoneSearchInput.Create(this);
    box.SetWidth(780.0);
    let root = box.GetRootWidget();
    root.SetName(n"convaiPhoneSearch");
    root.SetMargin(strip.GetMargin());
    root.SetHAlign(inkEHorizontalAlign.Left);
    root.SetVAlign(strip.GetVAlign());
    root.SetAffectsLayoutWhenHidden(false);
    root.SetVisible(false);
    let at = parent.GetNumChildren();
    let i = 0;
    while i < parent.GetNumChildren() {
        if parent.GetWidgetByIndex(i) == strip { at = i; };
        i += 1;
    };
    box.Reparent(parent, at);
    box.RegisterToCallback(n"OnInput", this, n"OnConvaiSearchInput");
    this.m_convaiSearchStrip = strip;
    this.m_convaiSearchBox = box;
    return true;
}
@if(!ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxMake() -> Bool {
    return false;
}

// Shows the box (and hides the tab strip) or the other way round. With focus, the player types at once.
@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxShow(visible: Bool, focus: Bool) -> Void {
    if !IsDefined(this.m_convaiSearchBox) { return; };
    this.m_convaiSearchBox.GetRootWidget().SetVisible(visible);
    if IsDefined(this.m_convaiSearchStrip) { this.m_convaiSearchStrip.SetVisible(!visible); };
    if visible && focus {
        this.m_convaiSearchBox.Guard(0.3);
        this.RequestSetFocus(this.m_convaiSearchBox.GetRootWidget());
    };
    if !visible && this.m_convaiSearchBox.IsFocused() { this.RequestSetFocus(null); };
}
@if(!ModuleExists("Codeware.UI.TextInput"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBoxShow(visible: Bool, focus: Bool) -> Void {
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

@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchOpen() -> Void {
    if !IsDefined(this.m_player) || !IsDefined(this.m_contactListLogicController) || NotEquals(this.m_convaiChatState, ConvaiPhoneChatState.List) { return; };
    // The key box of a keyboard: a pad has no such key and no hint for it.
    if !this.m_player.PlayerLastUsedKBM() { return; };
    if !this.ConvaiSearchBoxMake() { return; };
    if !this.m_convaiSearchOpen {
        this.m_convaiSearchOpen = true;
        this.m_convaiSearchFilter = false;
        this.m_convaiSearchOpenOnAnswer = false;
        this.m_convaiSearchSeq = -1;
        ArrayClear(this.m_convaiSearchIds);
        this.m_player.ConvaiPhoneChatSearchView(this);
        this.m_player.ConvaiPhoneChatTrace("search: opened");
    };
    this.ConvaiSearchBoxShow(true, true);
}

// The text changed (the box's own OnInput): an empty text shows the whole list at once, any other text is asked of Lua.
@addMethod(NewHudPhoneGameController)
private cb func OnConvaiSearchInput(widget: wref<inkWidget>) -> Bool {
    if !this.m_convaiSearchOpen || this.m_convaiSearchMuted || !IsDefined(this.m_player) { return false; };
    let text = this.ConvaiSearchBoxText();
    if StrLen(text) == 0 {
        this.m_convaiSearchSeq = -1;
        this.m_convaiSearchFilter = false;
        this.m_convaiSearchOpenOnAnswer = false;
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
    if this.m_convaiSearchOpenOnAnswer {
        this.m_convaiSearchOpenOnAnswer = false;
        this.ConvaiOpenChat(this.m_contactListLogicController.ConvaiChatContactAt(0u), true);
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
    if this.m_convaiSearchOpen && this.m_convaiSearchFilter { return this.ConvaiSearchFilterRows(); };
    return rows;
}

// Enter in the box: the selected match opens, as T does. While the answer for the last typed letter is on its way the first row of the answer is the match.
@addMethod(NewHudPhoneGameController)
public final func ConvaiSearchEnter() -> Void {
    if !this.m_convaiSearchOpen || NotEquals(this.m_convaiChatState, ConvaiPhoneChatState.List) { return; };
    if this.m_convaiSearchSeq > 0 && !this.m_convaiSearchFilter {
        this.m_convaiSearchOpenOnAnswer = true;
        return;
    };
    let selected = this.m_contactListLogicController.GetSelectedContactData();
    if IsDefined(selected) && selected.convaiChat { this.ConvaiOpenChat(selected, true); };
}

// Esc in the box: the search is cleared and the box closes; the Esc must not also close the phone (the guard keeps its game action and Back away for a moment).
@addMethod(NewHudPhoneGameController)
public final func ConvaiSearchEscape() -> Void {
    if !this.m_convaiSearchOpen { return; };
    this.m_convaiSearchGuardUntil = this.ConvaiSearchNow() + 0.4;
    this.ConvaiSearchClose(true);
}

// Closes the search: the text is cleared, the whole list is back (built again around the selected contact when `rebuild`), and the tab strip is shown.
@addMethod(NewHudPhoneGameController)
public final func ConvaiSearchClose(rebuild: Bool) -> Void {
    if !this.m_convaiSearchOpen { return; };
    let selectId = "";
    if rebuild && IsDefined(this.m_contactListLogicController) {
        let selected = this.m_contactListLogicController.GetSelectedContactData();
        if IsDefined(selected) { selectId = selected.id; };
    };
    this.m_convaiSearchOpen = false;
    this.m_convaiSearchFilter = false;
    this.m_convaiSearchOpenOnAnswer = false;
    this.m_convaiSearchSeq = -1;
    ArrayClear(this.m_convaiSearchIds);
    this.ConvaiSearchBoxClear();
    this.ConvaiSearchBoxShow(false, false);
    if IsDefined(this.m_player) {
        this.m_player.ConvaiPhoneChatSearchView(null);
        this.m_player.ConvaiPhoneChatTrace("search: closed");
    };
    if rebuild && IsDefined(this.m_contactListLogicController) && Equals(this.m_convaiChatState, ConvaiPhoneChatState.List) { this.ConvaiShowChatContacts(selectId); };
}

// The game's Back (C, and Esc when it is not in the box): with the search open it closes the search first, as Esc in the box does.
@addMethod(NewHudPhoneGameController)
private final func ConvaiSearchBackHandled() -> Bool {
    if this.m_convaiSearchGuardUntil > 0.0 && this.ConvaiSearchNow() < this.m_convaiSearchGuardUntil { return true; };
    if this.m_convaiSearchOpen && Equals(this.m_convaiChatState, ConvaiPhoneChatState.List) {
        this.m_convaiSearchGuardUntil = this.ConvaiSearchNow() + 0.4;
        this.ConvaiSearchClose(true);
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

// ---------------------------------------------------------------------------------------------------------------------------------
// The list of the phone

@addMethod(PhoneDialerLogicController)
public final func ConvaiSearchStrip() -> wref<inkWidget> {
    return IsDefined(this.m_menuSelectorCtrl) ? this.m_menuSelectorCtrl.GetRootWidget() : null;
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
