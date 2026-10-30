module CyberpunkConvai

// The phone still owns its modal context and animations. This state owns only
// the third tab and the direct conversation transition; no journal is modified.
public enum ConvaiPhoneChatState {
    Off = 0,
    List = 1,
    Opening = 2,
    Conversation = 3
}

@addField(ContactData)
public let convaiChat: Bool;
// The name as the journal or the roster gives it (the same text as localizedName: the list resolves that one itself, a LocKey included).
@addField(ContactData)
public let convaiPlainName: String;
// A favorite Chat row: the list's sort puts these before the others (SortItem below), whatever the names compare like.
@addField(ContactData)
public let convaiFavorite: Bool;

// The Chat tab's order, explicitly: favorites first, then the game's own order (by name) inside each group. The game sorts when the list is
// filled, that is when the tab opens, so this runs then and never per frame. Rows that are not Chat rows are compared by the game alone.
@wrapMethod(DialerContactDataView)
public func SortItem(left: ref<IScriptable>, right: ref<IScriptable>) -> Bool {
    let first = left as ContactData;
    let second = right as ContactData;
    if IsDefined(first) && IsDefined(second) && first.convaiChat && second.convaiChat && NotEquals(first.convaiFavorite, second.convaiFavorite) {
        return first.convaiFavorite;
    };
    return wrappedMethod(left, right);
}
@addField(JournalNotificationData)
public let convaiChat: Bool;
@addField(JournalNotificationData)
public let convaiChatGeneration: Uint32;
// For a Chat contact the journal has no entry for: her contact id and name (journalEntry is empty then).
@addField(JournalNotificationData)
public let convaiChatId: String;
@addField(JournalNotificationData)
public let convaiChatName: String;

public class ConvaiPhoneTabEvent extends Event {
    public let index: Int32;
}
public class ConvaiPhoneChatOpenEvent extends Event {
    public let contact: ref<ContactData>;
}
public class ConvaiPhoneChatReadyEvent extends Event {
    public let generation: Uint32;
}

// Native speech-bubble glyph (the game's "talk" map icon), drawn like the phone's
// own Messages/Contacts tab icons: an atlas image tinted from the shared palette.
// Messages uses 41x28 (fit to content) and Contacts a 32x32 box; this sits between.
// Its colour is the game's own tab colour: it binds the hub menu style's MenuLabel.MainColor and MainOpacity, as the
// Messages and Contacts icons and labels do, and the tab's state (Default or Selected, set in UpdateHightlight as the
// game's UpdateLabelsStates does for its tabs) picks red and dimmed or the active blue. The style is the one the game's
// tab panel carries (hub_menu_style.inkstyle), inherited because the tab sits inside that panel.
public class ConvaiChatTabArtwork {
    public static func Create() -> ref<inkImage> {
        let icon = new inkImage();
        icon.SetName(n"convaiChatGlyph");
        icon.SetAtlasResource(r"base\\gameplay\\gui\\common\\icons\\mappin_icons.inkatlas");
        icon.SetTexturePart(n"talk");
        icon.SetFitToContent(false);
        icon.SetSize(new Vector2(36.0, 36.0));
        icon.SetHAlign(inkEHorizontalAlign.Center);
        icon.SetVAlign(inkEVerticalAlign.Center);
        icon.SetInteractive(false);
        icon.BindProperty(n"tintColor", n"MenuLabel.MainColor");
        icon.BindProperty(n"opacity", n"MenuLabel.MainOpacity");
        return icon;
    }
}

// The game's own key hints (a key box with the real key for an action) are rebound to the mod's Call action on the Chat
// tab only, and put back, read from the hint itself, as soon as anything else is shown there. Bounded, named-free
// lookup: the display controller is the widget's own, or one of its first descendants'.
public class ConvaiHintBinding {
    public static func Display(root: ref<inkWidget>, depth: Int32) -> ref<inkInputDisplayController> {
        if !IsDefined(root) { return null; };
        let display = root.GetController() as inkInputDisplayController;
        if IsDefined(display) { return display; };
        let parent = root as inkCompoundWidget;
        if depth <= 0 || !IsDefined(parent) { return null; };
        let i = 0;
        while i < parent.GetNumChildren() {
            let found = ConvaiHintBinding.Display(parent.GetWidgetByIndex(i), depth - 1);
            if IsDefined(found) { return found; };
            i += 1;
        };
        return null;
    }
    // The action the hint showed before, or an empty name when there is no display controller (nothing was changed).
    public static func Rebind(root: ref<inkWidget>, action: CName) -> CName {
        let display = ConvaiHintBinding.Display(root, 3);
        if !IsDefined(display) { return n""; };
        let previous = display.GetInputAction();
        if NotEquals(previous, action) { display.SetInputAction(action); };
        return previous;
    }
    // The key box of a hint drawn as a given key of the game's own keyboard art (the key the mod listens to, T, H or F, which the game has no
    // action for). The hint's controller keeps its action; Redraw puts its own box back.
    public static func Glyph(root: ref<inkWidget>, part: CName) -> Void {
        let icon = ConvaiPhoneChatLayout.Find(root, n"inputIcon", 3) as inkImage;
        if !IsDefined(icon) { return; };
        icon.SetAtlasResource(r"base\\gameplay\\gui\\common\\input\\icons_keyboard.inkatlas");
        icon.SetTexturePart(part);
    }
    // Every key hint under a widget as `name=action`, with `(hidden)` for one that is not shown: a bounded walk (depth and a count the caller owns), used once per opening of the Chat list
    // to put the close hint's widget in the log (30 Oct: the hint reads C there, Esc is the key that works, and the widget is not one of the fields the mod reaches).
    public static func Describe(root: ref<inkWidget>, depth: Int32) -> String {
        if !IsDefined(root) { return ""; };
        let text = "";
        let display = root.GetController() as inkInputDisplayController;
        if IsDefined(display) {
            text = NameToString(root.GetName()) + "=" + NameToString(display.GetInputAction()) + (root.IsVisible() ? "" : "(hidden)") + " ";
        };
        let parent = root as inkCompoundWidget;
        if depth <= 0 || !IsDefined(parent) { return text; };
        let i = 0;
        while i < parent.GetNumChildren() {
            text += ConvaiHintBinding.Describe(parent.GetWidgetByIndex(i), depth - 1);
            i += 1;
        };
        return text;
    }
    // The close hints of a keyboard player show Esc, the key that closes the phone's pages here (30 Oct: they read C). Every key hint under `root` bound to the game's cancel action
    // (C) is rebound to the pause-menu action, whose key is Esc; returns how many were. EscToClose puts them back. A bounded walk (depth), done when a page or list is shown, never per frame.
    public static func CloseToEsc(root: ref<inkWidget>, depth: Int32) -> Int32 {
        return ConvaiHintBinding.SwapAction(root, depth, n"cancel", n"OpenPauseMenu");
    }
    public static func EscToClose(root: ref<inkWidget>, depth: Int32) -> Int32 {
        return ConvaiHintBinding.SwapAction(root, depth, n"OpenPauseMenu", n"cancel");
    }
    public static func SwapAction(root: ref<inkWidget>, depth: Int32, from: CName, to: CName) -> Int32 {
        if !IsDefined(root) { return 0; };
        let count = 0;
        let display = root.GetController() as inkInputDisplayController;
        if IsDefined(display) && Equals(display.GetInputAction(), from) { display.SetInputAction(to); count += 1; };
        let parent = root as inkCompoundWidget;
        if depth <= 0 || !IsDefined(parent) { return count; };
        let i = 0;
        while i < parent.GetNumChildren() {
            count += ConvaiHintBinding.SwapAction(parent.GetWidgetByIndex(i), depth - 1, from, to);
            i += 1;
        };
        return count;
    }
    // The hint's own key box again, for the action it is bound to: setting another action and then this one makes the controller draw it anew.
    public static func Redraw(root: ref<inkWidget>) -> Void {
        let display = ConvaiHintBinding.Display(root, 3);
        if !IsDefined(display) { return; };
        let action = display.GetInputAction();
        display.SetInputAction(n"cancel");
        display.SetInputAction(action);
    }
}

// The favorite mark of the hints on the Chat list: the game's own favorite star (the Ripperdoc's, ripperdoc/assets/cw_bars_assets.inkatlas, part
// fav_star), gold when the contact is a favorite and the hints' blue when not, and the keyboard art's F key.
public class ConvaiFavoriteArt {
    public static func Blue() -> HDRColor {
        let color: HDRColor;
        color.Red = 0.368627459;
        color.Green = 0.964705944;
        color.Blue = 1.0;
        color.Alpha = 1.0;
        return color;
    }
    public static func Gold() -> HDRColor {
        let color: HDRColor;
        color.Red = 1.1192;
        color.Green = 0.8441;
        color.Blue = 0.2565;
        color.Alpha = 1.0;
        return color;
    }
    public static func Star(width: Float, height: Float) -> ref<inkImage> {
        let star = new inkImage();
        star.SetName(n"convaiFavoriteStar");
        star.SetAtlasResource(r"base\\gameplay\\gui\\fullscreen\\ripperdoc\\assets\\cw_bars_assets.inkatlas");
        star.SetTexturePart(n"fav_star");
        star.SetFitToContent(false);
        star.SetSize(new Vector2(width, height));
        star.SetHAlign(inkEHorizontalAlign.Center);
        star.SetVAlign(inkEVerticalAlign.Center);
        star.SetInteractive(false);
        star.SetTintColor(ConvaiFavoriteArt.Blue());
        return star;
    }
    public static func KeyCap(part: CName) -> ref<inkImage> {
        let key = new inkImage();
        key.SetName(n"convaiFavoriteKey");
        key.SetAtlasResource(r"base\\gameplay\\gui\\common\\input\\icons_keyboard.inkatlas");
        key.SetTexturePart(part);
        key.SetFitToContent(false);
        key.SetSize(new Vector2(64.0, 64.0));
        key.SetHAlign(inkEHorizontalAlign.Center);
        key.SetVAlign(inkEVerticalAlign.Center);
        key.SetInteractive(false);
        key.SetTintColor(ConvaiFavoriteArt.Blue());
        return key;
    }
    public static func Tint(star: ref<inkImage>, favorite: Bool) -> Void {
        if IsDefined(star) { star.SetTintColor(favorite ? ConvaiFavoriteArt.Gold() : ConvaiFavoriteArt.Blue()); };
    }
}

@addField(NewHudPhoneGameController)
private let m_convaiChatState: ConvaiPhoneChatState;
@addField(NewHudPhoneGameController)
private let m_convaiChatGeneration: Uint32;
// The engine time (seconds) the last opening was started: a second press counts as "the first one was lost" only after a second has passed.
@addField(NewHudPhoneGameController)
private let m_convaiChatOpenedAt: Float;

@addMethod(NewHudPhoneGameController)
private final func ConvaiPhoneTabIndex() -> Int32 {
    if NotEquals(this.m_convaiChatState, ConvaiPhoneChatState.Off) { return 2; };
    return Equals(this.m_screenType, PhoneScreenType.Unread) ? 0 : 1;
}

@addMethod(NewHudPhoneGameController)
private final func ConvaiSelectPhoneTab(index: Int32) -> Void {
    if !IsDefined(this.m_contactListLogicController) || this.m_messagesPanelVisible { return; };
    if index == this.ConvaiPhoneTabIndex() && !this.m_threadsVisible { return; };
    this.m_convaiChatGeneration += 1u;
    this.m_convaiChatState = ConvaiPhoneChatState.Off;
    this.ConvaiSearchClose(false);
    this.m_messageToOpenHash = 0;
    if this.m_threadsVisible {
        this.m_threadsVisible = false;
        this.m_contactListLogicController.PopList();
    };
    this.m_isSingleThread = false;
    this.m_contactListLogicController.ShowTitle(false);
    this.ShowSmsMessager(false);
    this.m_audioSystem.Play(n"ui_gui_tab_change");
    if index == 2 {
        this.ConvaiShowChatContacts();
    } else {
        this.SetScreenType(index == 0 ? PhoneScreenType.Unread : PhoneScreenType.Contacts);
    };
}

@addMethod(NewHudPhoneGameController)
private final func ConvaiShowChatContacts(opt selectId: String) -> Void {
    let contacts: array<ref<IScriptable>>;
    let entries: array<wref<JournalEntry>>;
    let context: JournalRequestContext;
    let listed: array<String>;
    context.stateFilter.active = true;
    this.m_journalMgr.GetContacts(context, entries);
    // Read active, known contacts directly, including those with no quest SMS.
    for entry in entries {
        let contact = entry as JournalContact;
        if IsDefined(contact) && contact.IsKnown(this.m_journalMgr)
            && this.m_player.ConvaiPhoneChatHasContact(contact.GetId()) {
            let row = new ContactData();
            row.convaiChat = true;
            row.type = MessengerContactType.Contact;
            row.id = contact.GetId();
            row.contactId = row.id;
            row.hash = this.m_journalMgr.GetEntryHash(contact);
            row.convaiPlainName = contact.GetLocalizedName(this.m_journalMgr);
            row.convaiFavorite = this.m_player.ConvaiPhoneChatIsFavorite(row.id);
            row.localizedName = row.convaiPlainName;
            row.avatarID = contact.GetAvatarID(this.m_journalMgr);
            // This is a display row. Activation below always opens AI chat.
            row.isCallable = true;
            ArrayPush(contacts, row);
            ArrayPush(listed, row.id);
        };
    };
    // Every other registered character (a profile the game's journal has no contact for) is listed by her own name, sorted in
    // with the rest by name. Her row has no journal hash: opening it carries her id and name instead (ConvaiOpenChat).
    // The shipped phone contacts are registered without a name and appear only once the journal unlocks them.
    for id in this.m_player.ConvaiPhoneChatContactIds() {
        let name = this.m_player.ConvaiPhoneChatContactName(id);
        if !ArrayContains(listed, id) && StrLen(name) > 0 {
            let row = new ContactData();
            row.convaiChat = true;
            row.type = MessengerContactType.Contact;
            row.id = id;
            row.contactId = id;
            row.hash = 0;
            row.convaiPlainName = name;
            row.convaiFavorite = this.m_player.ConvaiPhoneChatIsFavorite(id);
            row.localizedName = name;
            row.isCallable = true;
            ArrayPush(contacts, row);
        };
    };
    this.m_screenType = PhoneScreenType.Contacts;
    this.m_convaiChatState = ConvaiPhoneChatState.List;
    this.m_contactListLogicController.SetSortMethod(ContactsSortMethod.ByName);
    // With a search open (PhoneChatSearch.reds) only its matches are listed; the whole list is kept for the next change of the text.
    let shown = this.ConvaiSearchRowsBuilt(contacts);
    this.m_contactListLogicController.PopulateListData(shown);
    // A list built again for one contact (her favorite changed) keeps the selection on her, wherever the new order puts her.
    if StrLen(selectId) > 0 { this.m_contactListLogicController.ConvaiSelectChatContact(selectId); };
    this.m_contactListLogicController.ConvaiShowChatTab(ArraySize(shown) == 0);
}

@addMethod(NewHudPhoneGameController)
private cb func OnConvaiPhoneTab(evt: ref<ConvaiPhoneTabEvent>) -> Bool {
    this.ConvaiSelectPhoneTab(evt.index);
    return true;
}

@wrapMethod(NewHudPhoneGameController)
protected cb func OnContactListAction(action: ListenerAction, consumer: ListenerActionConsumer) -> Bool {
    let name = ListenerAction.GetName(action);
    // Typing in the search box: the keys are letters, not the list's tab, open and call keys (PhoneChatSearch.reds).
    if this.ConvaiSearchSwallows(action) {
        ListenerActionConsumer.Consume(consumer);
        return false;
    };
    if Equals(ListenerAction.GetType(action), gameinputActionType.BUTTON_PRESSED) {
        let left = Equals(name, n"popup_moveLeft") || Equals(name, n"popup_prior");
        let right = Equals(name, n"popup_moveRight") || Equals(name, n"popup_next");
        if left || right {
            this.ConvaiSelectPhoneTab((this.ConvaiPhoneTabIndex() + (left ? 2 : 1)) % 3);
            ListenerActionConsumer.Consume(consumer);
            return true;
        };
        if Equals(this.m_convaiChatState, ConvaiPhoneChatState.List) {
            // The Call key of a Chat row on a pad is the game's `call` action (Triangle, the key the Call hint shows); it is also
            // showAll, which means nothing on this tab. On a keyboard the call key is H (OnConvaiChatListKey): the game's V, which
            // is the same action, does nothing here.
            if Equals(name, n"call") {
                if !this.m_player.PlayerLastUsedKBM() {
                    this.ConvaiChatListHolocall(this.m_contactListLogicController.GetSelectedContactData());
                };
                ListenerActionConsumer.Consume(consumer);
                return true;
            };
            // F is the game's confirm (`click`) as well as the mod's favorite key: the press that turned a favorite on or off opens no chat.
            if Equals(name, n"click") && this.m_player.ConvaiPhoneChatFavoriteKeyActive() {
                ListenerActionConsumer.Consume(consumer);
                return true;
            };
            if Equals(name, n"showAll") {
                ListenerActionConsumer.Consume(consumer);
                return true;
            };
        };
    };
    return wrappedMethod(action, consumer);
}

// The Contacts list does not listen for `call` by itself. Registered with the list's other inputs, so it is on exactly
// while the list has the input; it is acted on only on the Chat tab (OnContactListAction) and ignored by the game's
// handler everywhere else.
@wrapMethod(NewHudPhoneGameController)
public func EnableContactsInput() -> Void {
    wrappedMethod();
    if IsDefined(this.m_player) { this.m_player.RegisterInputListener(this, n"call"); };
    this.ConvaiChatListKeysStart();
}
@wrapMethod(NewHudPhoneGameController)
public func DisableContactsInput() -> Void {
    this.ConvaiChatListKeysStop();
    if IsDefined(this.m_player) { this.m_player.UnregisterInputListener(this, n"call"); };
    wrappedMethod();
}
@wrapMethod(NewHudPhoneGameController)
protected cb func OnUninitialize() -> Bool {
    this.ConvaiChatListKeysStop();
    this.ConvaiSearchClose(false);
    return wrappedMethod();
}

// The Chat list's keys on a keyboard: T opens the text chat, H calls, F turns the favorite on or off. The game has no action for them on this
// screen (T and H are not bound in the phone's input context, F is its confirm), so they are Codeware key callbacks, registered with the list's
// own inputs like the J and L keys (PhoneContacts.reds) and acted on only while the Chat list is up: in a conversation they are letters.
// Without Codeware these scripts still compile and the keys do nothing (Enter, a click and R open the chat as before).
@addField(NewHudPhoneGameController)
private let m_convaiChatListKeys: ref<CallbackSystemHandler>;
@addField(NewHudPhoneGameController)
private let m_convaiChatKeyDownT: Bool;
@addField(NewHudPhoneGameController)
private let m_convaiChatKeyDownH: Bool;
@addField(NewHudPhoneGameController)
private let m_convaiChatKeyDownF: Bool;

@if(ModuleExists("Codeware"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiChatListKeysStart() -> Void {
    this.ConvaiChatListKeysStop();
    this.m_convaiChatListKeys = ConvaiCallbackSystem().RegisterCallback(n"Input/Key", this, n"OnConvaiChatListKey")
        .AddTarget(ConvaiKeyTarget(EInputKey.IK_T, EInputAction.IACT_Press))
        .AddTarget(ConvaiKeyTarget(EInputKey.IK_H, EInputAction.IACT_Press))
        .AddTarget(ConvaiKeyTarget(EInputKey.IK_F, EInputAction.IACT_Press))
        .AddTarget(ConvaiKeyTarget(EInputKey.IK_O, EInputAction.IACT_Press))
        .AddTarget(ConvaiKeyTarget(EInputKey.IK_Slash, EInputAction.IACT_Press))
        .AddTarget(ConvaiKeyTarget(EInputKey.IK_Up, EInputAction.IACT_Press))
        .AddTarget(ConvaiKeyTarget(EInputKey.IK_Down, EInputAction.IACT_Press));
    // A key target of the game 2.31 filters by the action, so the releases (which end a hold, see OnConvaiChatListKey) need targets of their own.
    if ConvaiKeyTargetsByAction() {
        this.m_convaiChatListKeys.AddTarget(ConvaiKeyTarget(EInputKey.IK_T, EInputAction.IACT_Release));
        this.m_convaiChatListKeys.AddTarget(ConvaiKeyTarget(EInputKey.IK_H, EInputAction.IACT_Release));
        this.m_convaiChatListKeys.AddTarget(ConvaiKeyTarget(EInputKey.IK_F, EInputAction.IACT_Release));
    };
}

@if(!ModuleExists("Codeware"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiChatListKeysStart() -> Void {
}

@if(ModuleExists("Codeware"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiChatListKeysStop() -> Void {
    if IsDefined(this.m_convaiChatListKeys) {
        this.m_convaiChatListKeys.Unregister();
        this.m_convaiChatListKeys = null;
    };
    this.m_convaiChatKeyDownT = false;
    this.m_convaiChatKeyDownH = false;
    this.m_convaiChatKeyDownF = false;
    if IsDefined(this.m_player) { this.m_player.ConvaiPhoneChatFavoriteKey(false); };
}

@if(!ModuleExists("Codeware"))
@addMethod(NewHudPhoneGameController)
private final func ConvaiChatListKeysStop() -> Void {
}

@if(ModuleExists("Codeware"))
@addMethod(NewHudPhoneGameController)
private cb func OnConvaiChatListKey(evt: ref<KeyInputEvent>) -> Void {
    // The key target of the game 2.5 cannot filter by action (GameVariant.reds): only a press and a release count. A held key repeats its press, so a
    // key that is down acts once, until its release.
    let key = evt.GetKey();
    let pressed = Equals(evt.GetAction(), EInputAction.IACT_Press);
    if !pressed && NotEquals(evt.GetAction(), EInputAction.IACT_Release) { return; };
    if !pressed {
        if Equals(key, EInputKey.IK_T) { this.m_convaiChatKeyDownT = false; };
        if Equals(key, EInputKey.IK_H) { this.m_convaiChatKeyDownH = false; };
        if Equals(key, EInputKey.IK_F) {
            this.m_convaiChatKeyDownF = false;
            if IsDefined(this.m_player) { this.m_player.ConvaiPhoneChatFavoriteKey(false); };
        };
        return;
    };
    if !IsDefined(this.m_player) || !IsDefined(this.m_contactListLogicController) || evt.IsShiftDown() || evt.IsControlDown() || evt.IsAltDown() { return; };
    // Only the Chat list: a conversation (or its opening) owns the keyboard, and the other tabs are the game's.
    if NotEquals(this.m_convaiChatState, ConvaiPhoneChatState.List) { return; };
    // The search (PhoneChatSearch.reds): O or / opens it, and while the player types in its box every key is the box's (T, H and F are letters then).
    if this.ConvaiSearchKey(key) { return; };
    if Equals(key, EInputKey.IK_Up) || Equals(key, EInputKey.IK_Down) { return; };
    let selected = this.m_contactListLogicController.GetSelectedContactData();
    if !IsDefined(selected) || !selected.convaiChat { return; };
    if Equals(key, EInputKey.IK_T) {
        if !this.m_convaiChatKeyDownT {
            this.m_convaiChatKeyDownT = true;
            this.ConvaiOpenChat(selected, true);
        };
    } else {
        if Equals(key, EInputKey.IK_H) {
            if !this.m_convaiChatKeyDownH {
                this.m_convaiChatKeyDownH = true;
                this.ConvaiChatListHolocall(selected);
            };
        } else {
            if Equals(key, EInputKey.IK_F) {
                // Marked before anything else: the game's own click of this key follows (OnContactListAction) and must open nothing.
                this.m_player.ConvaiPhoneChatFavoriteKey(true);
                if !this.m_convaiChatKeyDownF {
                    this.m_convaiChatKeyDownF = true;
                    this.ConvaiChatListFavorite(selected);
                };
            };
        };
    };
}

// F on a Chat row: the favorite is turned on or off. The list shows it at once (the game's list is built again with the new order and mark, the
// selection stays on her), and the change is handed to Lua to be kept (PlayerPuppet.ConvaiPhoneChatSetFavorite).
@addMethod(NewHudPhoneGameController)
public final func ConvaiChatListFavorite(contact: wref<ContactData>) -> Void {
    if !IsDefined(contact) || !contact.convaiChat || !IsDefined(this.m_player) { return; };
    let id = contact.id;
    let on = !this.m_player.ConvaiPhoneChatIsFavorite(id);
    this.m_player.ConvaiPhoneChatSetFavorite(id, on);
    this.m_audioSystem.Play(on ? n"ui_menu_map_pin_created" : n"ui_menu_hover");
    this.ConvaiShowChatContacts(id);
}

@wrapMethod(NewHudPhoneGameController)
public func SelectOtherTab() -> Void {
    this.ConvaiSelectPhoneTab((this.ConvaiPhoneTabIndex() + 1) % 3);
}

@wrapMethod(NewHudPhoneGameController)
public func SetScreenType(type: PhoneScreenType) -> Void {
    this.m_convaiChatState = ConvaiPhoneChatState.Off;
    this.ConvaiSearchClose(false);
    this.m_convaiChatGeneration += 1u;
    wrappedMethod(type);
}

// A Chat row is selected: only the Chat tab shows one (a row is ours when it carries the flag), so the list is the Chat list whatever the state says.
@addMethod(NewHudPhoneGameController)
private final func ConvaiSelectedIsChatRow() -> Bool {
    if !IsDefined(this.m_contactListLogicController) { return false; };
    let selected = this.m_contactListLogicController.GetSelectedContactData();
    return IsDefined(selected) && selected.convaiChat;
}

@wrapMethod(NewHudPhoneGameController)
public func AcceptAction() -> Void {
    if NotEquals(this.m_convaiChatState, ConvaiPhoneChatState.Off) || this.ConvaiSelectedIsChatRow() {
        this.ConvaiOpenChat(this.m_contactListLogicController.GetSelectedContactData(), true);
        return;
    };
    wrappedMethod();
}
// On the Chat list both the accept action (F, Enter, click; the envelope's hint on the row shows it) and the secondary
// action (the game's Messages key, R) open the text chat. The call has its own key, `call` (V, Triangle), handled in OnContactListAction.
@wrapMethod(NewHudPhoneGameController)
public func AlternativeAcceptAction() -> Void {
    if NotEquals(this.m_convaiChatState, ConvaiPhoneChatState.Off) || this.ConvaiSelectedIsChatRow() {
        this.ConvaiOpenChat(this.m_contactListLogicController.GetSelectedContactData(), true);
        return;
    };
    wrappedMethod();
}

@addMethod(NewHudPhoneGameController)
private cb func OnConvaiPhoneChatOpen(evt: ref<ConvaiPhoneChatOpenEvent>) -> Bool {
    this.ConvaiOpenChat(evt.contact);
    return true;
}

@addMethod(NewHudPhoneGameController)
private final func ConvaiOpenChat(contact: wref<ContactData>, opt fromKey: Bool) -> Void {
    if !IsDefined(contact) || !contact.convaiChat { return; };
    // The Chat tab is the only place a Chat row is shown, so a Chat row under the cursor means the list is up, whatever the state says: it is
    // put right instead of the press being lost (the state is reset by anything that sets the screen type, and only the tab's own code sets it back).
    if Equals(this.m_convaiChatState, ConvaiPhoneChatState.Off) {
        this.m_player.ConvaiPhoneChatTrace("open: state was off with a Chat row selected, put back to the list contact=" + contact.id);
        this.m_convaiChatState = ConvaiPhoneChatState.List;
    };
    // A key press a full second after the previous one, with the page still not ready, starts the opening again: the older attempt's events carry
    // the old generation and are dropped, so only this one counts. Without this the second press of a lost first one was ignored. A click's release
    // (which follows the press by milliseconds) and a quick double press are not a retry.
    let now = EngineTime.ToFloat(GameInstance.GetEngineTime(this.m_player.GetGame()));
    if Equals(this.m_convaiChatState, ConvaiPhoneChatState.Opening) && fromKey && now - this.m_convaiChatOpenedAt >= 1.0 {
        this.m_player.ConvaiPhoneChatTrace("open: pressed again, the page never reported ready, started again contact=" + contact.id);
        this.m_convaiChatState = ConvaiPhoneChatState.List;
    };
    if NotEquals(this.m_convaiChatState, ConvaiPhoneChatState.List) {
        this.m_player.ConvaiPhoneChatTrace("open ignored: the page is already open contact=" + contact.id);
        return;
    };
    if !this.m_player.ConvaiPhoneChatHasContact(contact.id) {
        this.m_player.ConvaiPhoneChatTrace("open ignored: not a registered contact contact=" + contact.id);
        return;
    };
    this.m_player.ConvaiPhoneChatTrace("open: contact=" + contact.id + " journal=" + (contact.hash != 0 ? "yes" : "no")
        + " path=" + (this.m_messagesPanelSpawned ? "refresh" : "spawn"));
    this.m_convaiChatState = ConvaiPhoneChatState.Opening;
    this.m_convaiChatOpenedAt = now;
    this.m_convaiChatGeneration += 1u;
    this.m_messageToOpenHash = 0;
    let data = new JournalNotificationData();
    data.convaiChat = true;
    data.convaiChatGeneration = this.m_convaiChatGeneration;
    if contact.hash != 0 { data.journalEntry = this.m_journalMgr.GetEntry(Cast<Uint32>(contact.hash)); };
    data.convaiChatId = contact.id;
    let plain = StrLen(contact.convaiPlainName) > 0 ? contact.convaiPlainName : contact.localizedName;
    data.convaiChatName = plain;
    data.type = MessengerContactType.SingleThread;
    data.mode = JournalNotificationMode.HUD;
    data.openedFromPhone = true;
    data.source = PhoneScreenType.Contacts;
    data.contactNameLocKey = StringToName(plain);
    if this.m_messagesPanelSpawned {
        let refresh = new RefreshSmsMessagerEvent();
        refresh.m_data = data;
        this.QueueEvent(refresh);
    } else {
        let open = new OpenSmsMessengerEvent();
        open.m_data = data;
        this.QueueEvent(open);
    };
}

@addMethod(NewHudPhoneGameController)
private cb func OnConvaiPhoneChatReady(evt: ref<ConvaiPhoneChatReadyEvent>) -> Bool {
    if !(IsDefined(this.m_contactListLogicController) && Equals(this.m_convaiChatState, ConvaiPhoneChatState.Opening)
        && evt.generation == this.m_convaiChatGeneration) {
        this.m_player.ConvaiPhoneChatTrace("page ready but not wanted: generation=" + IntToString(Cast<Int32>(evt.generation)) + " current="
            + IntToString(Cast<Int32>(this.m_convaiChatGeneration)) + " state=" + IntToString(EnumInt(this.m_convaiChatState)));
    };
    if IsDefined(this.m_contactListLogicController)
        && Equals(this.m_convaiChatState, ConvaiPhoneChatState.Opening)
        && evt.generation == this.m_convaiChatGeneration {
        this.m_messagesPanelSpawned = true;
        this.m_convaiChatState = ConvaiPhoneChatState.Conversation;
        this.FocusSmsMessenger();
    } else {
        // A tab/cancel action may precede asynchronous widget creation. Never
        // focus that stale request; restore an active native message preview.
        if IsDefined(this.m_contactListLogicController) && Equals(this.m_convaiChatState, ConvaiPhoneChatState.Off)
            && Equals(this.m_screenType, PhoneScreenType.Unread) {
            let selected = this.m_contactListLogicController.GetSelectedContactData();
            if IsDefined(selected) { this.RefreshSmsMessager(selected); };
        };
    };
    return true;
}

@wrapMethod(NewHudPhoneGameController)
protected cb func OnOpenSmsMessenger(evt: ref<OpenSmsMessengerEvent>) -> Bool {
    let data = evt.m_data as JournalNotificationData;
    if IsDefined(data) && data.convaiChat && (data.convaiChatGeneration != this.m_convaiChatGeneration
        || !IsDefined(this.m_contactListLogicController)) { return false; };
    return wrappedMethod(evt);
}

@wrapMethod(NewHudPhoneGameController)
protected cb func OnContactSelectionChanged(evt: ref<ContactSelectionChangedEvent>) -> Bool {
    if NotEquals(this.m_convaiChatState, ConvaiPhoneChatState.Off) { return true; };
    return wrappedMethod(evt);
}

@wrapMethod(NewHudPhoneGameController)
protected cb func OnSmsMessageLostFocus(evt: ref<UnfocusSmsMessagerEvent>) -> Bool {
    if Equals(this.m_convaiChatState, ConvaiPhoneChatState.Conversation) && IsDefined(this.m_contactListLogicController) {
        this.m_player.ConvaiPhoneChatTrace("page closed, back on the list");
        this.m_convaiChatState = ConvaiPhoneChatState.List;
        this.contactsElement.widget.SetOpacity(1.0);
        this.EnableContactsInput();
        this.m_audioSystem.Play(n"ui_menu_map_pin_on");
        this.MoveMessengerLeft(true);
        this.ShowSmsMessager(false);
        this.m_contactListLogicController.ShowInputHints(true);
        this.m_contactListLogicController.RefreshSelectedContact();
        return true;
    };
    return wrappedMethod(evt);
}

@wrapMethod(NewHudPhoneGameController)
protected cb func OnContactListClosed() -> Bool {
    this.m_convaiChatState = ConvaiPhoneChatState.Off;
    this.ConvaiSearchClose(false);
    this.m_convaiChatGeneration += 1u;
    return wrappedMethod();
}

// After PopulateListData: the list's selection goes to the contact with this id (the data view is already sorted), the first row when she is not there.
@addMethod(PhoneDialerLogicController)
public final func ConvaiSelectChatContact(id: String) -> Void {
    let size = this.m_dataView.Size();
    let i = 0u;
    while i < size {
        let item = this.m_dataView.GetItem(i) as ContactData;
        if IsDefined(item) && Equals(item.id, id) {
            this.m_indexToSelect = i;
            return;
        };
        i += 1u;
    };
}

@addMethod(PhoneDialerLogicController)
public final func ConvaiShowChatTab(empty: Bool) -> Void {
    this.SwtichTabs(PhoneDialerTabs.Contacts);
    this.m_menuSelectorCtrl.ScrollTo(4);
    inkWidgetRef.SetVisible(this.m_nothingToReadMessageWidget, empty);
}

@addField(PhoneDialerLogicController)
private let m_convaiCallHintBound: Bool;
@addField(PhoneDialerLogicController)
private let m_convaiCallHintAction: CName;
// The bottom hints show the keys of a keyboard (T, H, F) in place of the game's own key boxes: set when they do, so they are drawn again as the
// game draws them when the hints go back to a pad or to another list.
@addField(PhoneDialerLogicController)
private let m_convaiKeyGlyphs: Bool;
@addField(PhoneDialerLogicController)
private let m_convaiShowAllText: String;
@addField(PhoneDialerLogicController)
private let m_convaiShowAllSaved: Bool;
@addField(PhoneDialerLogicController)
private let m_convaiFavoriteStar: wref<inkImage>;

// The hints of the phone window, written to the log once per session the first time the Chat list is shown (ConvaiHintBinding.Describe).
@addField(PhoneDialerLogicController)
private let m_convaiHintsTraced: Bool;
@addField(PhoneDialerLogicController)
private let m_convaiCloseEsc: Bool;
@addField(PhoneDialerLogicController)
private let m_convaiCloseRoot: wref<inkWidget>;

@wrapMethod(PhoneDialerLogicController)
private func RefreshInputHints(contactData: wref<ContactData>) -> Void {
    wrappedMethod(contactData);
    if IsDefined(contactData) && contactData.convaiChat {
        let player = GetPlayer(GetGameInstance()) as PlayerPuppet;
        // The bottom bar's close hint: Esc on a keyboard (it read C). The hint is found by its action (cancel) under the list, then under the whole phone window.
        if IsDefined(player) && player.PlayerLastUsedKBM() {
            let top = this.GetRootWidget();
            let found = ConvaiHintBinding.CloseToEsc(top, 8);
            if found == 0 {
                let up = 0;
                while up < 6 && IsDefined(top) && IsDefined(top.GetParentWidget()) {
                    top = top.GetParentWidget();
                    up += 1;
                };
                found = ConvaiHintBinding.CloseToEsc(top, 9);
            };
            this.m_convaiCloseEsc = IsDefined(top) && found > 0;
            if this.m_convaiCloseEsc { this.m_convaiCloseRoot = top; };
            if !this.m_convaiHintsTraced {
                this.m_convaiHintsTraced = true;
                player.ConvaiPhoneChatTrace("Chat list close hint: rebound " + IntToString(found) + " cancel hint(s) to Esc");
                if found == 0 {
                    let described = ConvaiHintBinding.Describe(inkWidgetRef.Get(this.m_inputHintsPanel), 6);
                    let at = 0;
                    while at < StrLen(described) && at < 540 {
                        player.ConvaiPhoneChatTrace("Chat list hints: " + StrMid(described, at, 180));
                        at += 180;
                    };
                };
            };
        };
        let keyboard = !IsDefined(player) || player.PlayerLastUsedKBM();
        inkTextRef.SetText(this.m_acceptButtonLabel, "Chat");
        inkWidgetRef.SetVisible(this.m_acceptButtonWidget, true);
        // The second bottom hint (the game's Messages hint, R) is the Call hint here: the game's own key hint rebound to
        // the `call` action, so it shows the real key (Triangle on a pad), with the game's own translated Call label. R still
        // opens the chat too, and the row's envelope shows the chat key, as the Chat hint does.
        if !this.m_convaiCallHintBound {
            let previous = ConvaiHintBinding.Rebind(inkWidgetRef.Get(this.m_action2ButtonWidget), n"call");
            if NotEquals(previous, n"") { this.m_convaiCallHintAction = previous; this.m_convaiCallHintBound = true; };
        };
        inkTextRef.SetLocalizedTextScript(this.m_action2ButtonLabel, "LocKey#22196");
        inkWidgetRef.SetVisible(this.m_action2ButtonWidget, true);
        if keyboard {
            // On a keyboard: Chat is T, Call is H, and the third hint (the game's Show all hint, which the Chat tab does not use) is the
            // favorite key, F, with a star. The keys are drawn from the game's keyboard art (ConvaiHintBinding.Glyph); the keys themselves are
            // listened to in OnConvaiChatListKey.
            ConvaiHintBinding.Glyph(inkWidgetRef.Get(this.m_acceptButtonWidget), n"kb_t");
            ConvaiHintBinding.Glyph(inkWidgetRef.Get(this.m_action2ButtonWidget), n"kb_h");
            if !this.m_convaiShowAllSaved {
                this.m_convaiShowAllText = inkTextRef.GetText(this.m_showAllLabel);
                this.m_convaiShowAllSaved = true;
            };
            inkTextRef.SetText(this.m_showAllLabel, "Favorite");
            ConvaiHintBinding.Glyph(inkWidgetRef.Get(this.m_showAllButtonWidget), n"kb_f");
            this.ConvaiFavoriteStarShow(contactData.convaiFavorite);
            inkWidgetRef.SetVisible(this.m_showAllButtonWidget, true);
            this.ConvaiSearchHintShow(true);
            this.m_convaiKeyGlyphs = true;
        } else {
            this.ConvaiKeyGlyphsRestore();
            inkWidgetRef.SetVisible(this.m_showAllButtonWidget, false);
        };
    } else {
        // Anything else on this list: the hint is the game's again, bound to what it was bound to (the close hint too: C).
        if this.m_convaiCloseEsc {
            ConvaiHintBinding.EscToClose(this.m_convaiCloseRoot, 9);
            this.m_convaiCloseEsc = false;
        };
        if this.m_convaiCallHintBound {
            ConvaiHintBinding.Rebind(inkWidgetRef.Get(this.m_action2ButtonWidget), this.m_convaiCallHintAction);
            this.m_convaiCallHintBound = false;
        };
        this.ConvaiKeyGlyphsRestore();
    };
}

// The three bottom hints as the game draws them (key boxes, the Show all label, no star).
@addMethod(PhoneDialerLogicController)
private final func ConvaiKeyGlyphsRestore() -> Void {
    this.ConvaiSearchHintShow(false);
    if !this.m_convaiKeyGlyphs { return; };
    this.m_convaiKeyGlyphs = false;
    ConvaiHintBinding.Redraw(inkWidgetRef.Get(this.m_acceptButtonWidget));
    ConvaiHintBinding.Redraw(inkWidgetRef.Get(this.m_action2ButtonWidget));
    ConvaiHintBinding.Redraw(inkWidgetRef.Get(this.m_showAllButtonWidget));
    if this.m_convaiShowAllSaved { inkTextRef.SetText(this.m_showAllLabel, this.m_convaiShowAllText); };
    if IsDefined(this.m_convaiFavoriteStar) { this.m_convaiFavoriteStar.SetVisible(false); };
}

// The star between the favorite hint's key and its label, made once.
@addMethod(PhoneDialerLogicController)
private final func ConvaiFavoriteStarShow(favorite: Bool) -> Void {
    if !IsDefined(this.m_convaiFavoriteStar) {
        let hint = inkWidgetRef.Get(this.m_showAllButtonWidget) as inkCompoundWidget;
        if !IsDefined(hint) { return; };
        let star = ConvaiFavoriteArt.Star(44.0, 40.0);
        star.SetMargin(new inkMargin(4.0, 0.0, 4.0, 0.0));
        star.Reparent(hint, 1);
        this.m_convaiFavoriteStar = star;
    };
    ConvaiFavoriteArt.Tint(this.m_convaiFavoriteStar, favorite);
    this.m_convaiFavoriteStar.SetVisible(true);
}

// Append after the native four children (Messages, Contacts, arrow, thread).
// Their indices and the quest-message navigation remain owned by the game.
@addField(PhoneDialerSelectionController)
private let m_convaiChatTab: wref<inkHorizontalPanel>;
@addField(PhoneDialerSelectionController)
private let m_convaiChatLabel: wref<inkText>;
@addField(PhoneDialerSelectionController)
private let m_convaiChatGlyph: wref<inkImage>;

@wrapMethod(PhoneDialerSelectionController)
public func SetupWidgets() -> Void {
    wrappedMethod();
    if IsDefined(this.m_convaiChatTab) { return; };
    let tab = new inkHorizontalPanel();
    tab.SetName(n"convaiChatTab");
    tab.SetFitToContent(true);
    tab.SetVAlign(inkEVerticalAlign.Center);
    tab.SetMargin(new inkMargin(40.0, 0.0, 20.0, 0.0));
    tab.SetInteractive(true);
    tab.SetAffectsLayoutWhenHidden(false);
    tab.SetState(n"Default");
    tab.Reparent(inkCompoundRef.Get(this.m_container) as inkCompoundWidget);
    let icon = ConvaiChatTabArtwork.Create();
    icon.Reparent(tab);
    this.m_convaiChatGlyph = icon;
    let label = new inkText();
    label.SetText("CHAT");
    label.SetFontFamily("base\\gameplay\\gui\\fonts\\raj\\raj.inkfontfamily");
    label.SetFontStyle(n"Semi-Bold");
    label.SetFontSize(48);
    label.SetFitToContent(true);
    label.SetVAlign(inkEVerticalAlign.Center);
    label.SetMargin(new inkMargin(10.0, 0.0, 0.0, 0.0));
    label.BindProperty(n"tintColor", n"MenuLabel.MainColor");
    label.BindProperty(n"opacity", n"MenuLabel.MainOpacity");
    label.Reparent(tab);
    tab.RegisterToCallback(n"OnRelease", this, n"OnConvaiChatTabClick");
    this.m_convaiChatTab = tab;
    this.m_convaiChatLabel = label;
    let messages = inkCompoundRef.GetWidgetByIndex(this.m_container, 0);
    let contacts = inkCompoundRef.GetWidgetByIndex(this.m_container, 1);
    messages.SetInteractive(true);
    contacts.SetInteractive(true);
    messages.RegisterToCallback(n"OnRelease", this, n"OnConvaiMessagesTabClick");
    contacts.RegisterToCallback(n"OnRelease", this, n"OnConvaiContactsTabClick");
}

@addMethod(PhoneDialerSelectionController)
private cb func OnConvaiChatTabClick(evt: ref<inkPointerEvent>) -> Bool {
    if evt.IsAction(n"click") {
        let change = new ConvaiPhoneTabEvent();
        change.index = 2;
        this.QueueEvent(change);
        evt.Handle();
    };
    return true;
}
@addMethod(PhoneDialerSelectionController)
private cb func OnConvaiMessagesTabClick(evt: ref<inkPointerEvent>) -> Bool {
    if evt.IsAction(n"click") {
        let change = new ConvaiPhoneTabEvent();
        change.index = 0;
        this.QueueEvent(change);
        evt.Handle();
    };
    return true;
}
@addMethod(PhoneDialerSelectionController)
private cb func OnConvaiContactsTabClick(evt: ref<inkPointerEvent>) -> Bool {
    if evt.IsAction(n"click") {
        let change = new ConvaiPhoneTabEvent();
        change.index = 1;
        this.QueueEvent(change);
        evt.Handle();
    };
    return true;
}

@wrapMethod(PhoneDialerSelectionController)
protected func UpdateHightlight(index: Int32, opt instant: Bool) -> Void {
    if IsDefined(this.m_convaiChatTab) {
        this.m_convaiChatTab.SetState(index == 4 ? n"Selected" : n"Default");
    };
    if index != 4 { wrappedMethod(index, instant); return; };
    for controller in this.m_widgetsControllers {
        if IsDefined(controller) { controller.SetTextState(n"Default"); };
    };
    let parent = inkCompoundRef.Get(this.m_container) as inkCompoundWidget;
    let position = parent.GetChildPosition(this.m_convaiChatTab);
    this.m_highlightInitialized = true;
    this.AnimateLineTranslation(inkWidgetRef.Get(this.m_line), position.X, 0.2);
    this.AnimateLineSize(inkWidgetRef.Get(this.m_line), this.m_convaiChatTab.GetDesiredWidth() + 2.0, 0.2);
}

@wrapMethod(PhoneDialerLogicController)
public func ShowTitle(visible: Bool) -> Void {
    wrappedMethod(visible);
    this.m_menuSelectorCtrl.ConvaiShowChatLabel(!visible);
}
@addMethod(PhoneDialerSelectionController)
public final func ConvaiShowChatLabel(visible: Bool) -> Void {
    if IsDefined(this.m_convaiChatTab) { this.m_convaiChatTab.SetVisible(visible); };
}

@addField(PhoneContactItemVirtualController)
private let m_convaiCallHintBound: Bool;
@addField(PhoneContactItemVirtualController)
private let m_convaiCallHintAction: CName;
@addField(PhoneContactItemVirtualController)
private let m_convaiChatHintBound: Bool;
@addField(PhoneContactItemVirtualController)
private let m_convaiChatHintAction: CName;
// The row's chat and call hints show the keys of a keyboard (T, H) in place of the game's key boxes: set when they do.
@addField(PhoneContactItemVirtualController)
private let m_convaiRowGlyphs: Bool;
// The favorite hint of the row (F and the star), before the chat hint's place in the selected row; made once, on the first Chat row.
@addField(PhoneContactItemVirtualController)
private let m_convaiFavoriteCell: wref<inkHorizontalPanel>;
@addField(PhoneContactItemVirtualController)
private let m_convaiFavoriteCellStar: wref<inkImage>;

@wrapMethod(PhoneContactItemVirtualController)
protected cb func OnDataChanged(value: Variant) -> Bool {
    let result = wrappedMethod(value);
    if IsDefined(this.m_contactData) && this.m_contactData.convaiChat {
        let player = GetPlayer(GetGameInstance()) as PlayerPuppet;
        let keyboard = !IsDefined(player) || player.PlayerLastUsedKBM();
        // A Chat row has two icons on the selected row: the game's own chat hint (the envelope) and the game's own call
        // hint (the phone), each rebound to the key that does it here. The chat hint shows `proceed`, the action the
        // bottom bar's Chat hint shows (Cross on a pad), which opens the chat (its `click` reaches AcceptAction); the game
        // binds it to `secondaryAction` (R). The call hint shows `call`, the real call key (Triangle on a pad).
        if !this.m_convaiChatHintBound {
            let previous = ConvaiHintBinding.Rebind(inkWidgetRef.Get(this.m_chatInputHint), n"proceed");
            if NotEquals(previous, n"") { this.m_convaiChatHintAction = previous; this.m_convaiChatHintBound = true; };
        };
        if !this.m_convaiCallHintBound {
            let previous = ConvaiHintBinding.Rebind(inkWidgetRef.Get(this.m_callInputHint), n"call");
            if NotEquals(previous, n"") { this.m_convaiCallHintAction = previous; this.m_convaiCallHintBound = true; };
        };
        if keyboard {
            // On a keyboard the chat key is T and the call key is H (OnConvaiChatListKey), drawn from the game's keyboard art; F, the favorite key,
            // has a hint of its own, with a star.
            ConvaiHintBinding.Glyph(inkWidgetRef.Get(this.m_chatInputHint), n"kb_t");
            ConvaiHintBinding.Glyph(inkWidgetRef.Get(this.m_callInputHint), n"kb_h");
            this.m_convaiRowGlyphs = true;
            this.ConvaiFavoriteCellMake();
        } else {
            this.ConvaiRowGlyphsRestore();
        };
        inkWidgetRef.SetVisible(this.m_callInputHint, true);
        inkWidgetRef.SetVisible(this.m_chatInputHint, true);
        inkWidgetRef.SetVisible(this.m_separtor, true);
        this.ConvaiFavoriteCellShow(keyboard && this.IsSelected());
    } else {
        // This row view is recycled by the game's own lists: any other contact gets the game's hints back as they were.
        if this.m_convaiChatHintBound {
            ConvaiHintBinding.Rebind(inkWidgetRef.Get(this.m_chatInputHint), this.m_convaiChatHintAction);
            this.m_convaiChatHintBound = false;
        };
        if this.m_convaiCallHintBound {
            ConvaiHintBinding.Rebind(inkWidgetRef.Get(this.m_callInputHint), this.m_convaiCallHintAction);
            this.m_convaiCallHintBound = false;
        };
        this.ConvaiRowGlyphsRestore();
        this.ConvaiFavoriteCellShow(false);
    };
    return result;
}

// The game's own key boxes of the chat and call hints again (the keys were T and H).
@addMethod(PhoneContactItemVirtualController)
private final func ConvaiRowGlyphsRestore() -> Void {
    if !this.m_convaiRowGlyphs { return; };
    this.m_convaiRowGlyphs = false;
    ConvaiHintBinding.Redraw(inkWidgetRef.Get(this.m_chatInputHint));
    ConvaiHintBinding.Redraw(inkWidgetRef.Get(this.m_callInputHint));
}

// The favorite hint, in the row's hint holder just before the chat hint: the F key of the keyboard art and the star, in the hints' own size and spacing.
@addMethod(PhoneContactItemVirtualController)
private final func ConvaiFavoriteCellMake() -> Void {
    if IsDefined(this.m_convaiFavoriteCell) { return; };
    let chat = inkWidgetRef.Get(this.m_chatInputHint);
    let holder = IsDefined(chat) ? chat.GetParentWidget() as inkCompoundWidget : null;
    if !IsDefined(holder) { return; };
    let cell = new inkHorizontalPanel();
    cell.SetName(n"convaiFavoriteHint");
    cell.SetFitToContent(true);
    cell.SetHAlign(inkEHorizontalAlign.Right);
    cell.SetVAlign(inkEVerticalAlign.Center);
    cell.SetChildMargin(new inkMargin(0.0, 0.0, 8.0, 0.0));
    cell.SetAffectsLayoutWhenHidden(false);
    cell.SetVisible(false);
    cell.SetInteractive(false);
    ConvaiFavoriteArt.KeyCap(n"kb_f").Reparent(cell);
    let star = ConvaiFavoriteArt.Star(48.0, 44.0);
    star.Reparent(cell);
    let at = holder.GetNumChildren();
    let i = 0;
    while i < holder.GetNumChildren() {
        if holder.GetWidgetByIndex(i) == chat { at = i; };
        i += 1;
    };
    cell.Reparent(holder, at);
    this.m_convaiFavoriteCell = cell;
    this.m_convaiFavoriteCellStar = star;
}

@addMethod(PhoneContactItemVirtualController)
private final func ConvaiFavoriteCellShow(visible: Bool) -> Void {
    if !IsDefined(this.m_convaiFavoriteCell) { return; };
    if visible && IsDefined(this.m_contactData) { ConvaiFavoriteArt.Tint(this.m_convaiFavoriteCellStar, this.m_contactData.convaiFavorite); };
    this.m_convaiFavoriteCell.SetVisible(visible);
}

// The favorite hint shows with the selection, like the game's own hints of the row.
@wrapMethod(PhoneContactItemVirtualController)
protected cb func OnSelected(itemController: wref<inkVirtualCompoundItemController>, discreteNav: Bool) -> Bool {
    let result = wrappedMethod(itemController, discreteNav);
    if this.m_convaiRowGlyphs && IsDefined(this.m_contactData) && this.m_contactData.convaiChat { this.ConvaiFavoriteCellShow(true); };
    return result;
}
@wrapMethod(PhoneContactItemVirtualController)
protected cb func OnDeselected(itemController: wref<inkVirtualCompoundItemController>) -> Bool {
    let result = wrappedMethod(itemController);
    this.ConvaiFavoriteCellShow(false);
    return result;
}

@wrapMethod(PhoneContactItemVirtualController)
protected cb func OnInitialize() -> Bool {
    let result = wrappedMethod();
    this.RegisterToCallback(n"OnRelease", this, n"OnConvaiChatContactClick");
    return result;
}
@addMethod(PhoneContactItemVirtualController)
private cb func OnConvaiChatContactClick(evt: ref<inkPointerEvent>) -> Bool {
    if evt.IsAction(n"click") && IsDefined(this.m_contactData) && this.m_contactData.convaiChat {
        // The release of the favorite key (F is the game's confirm too) is not a click on the row.
        let player = GetPlayer(GetGameInstance()) as PlayerPuppet;
        if IsDefined(player) && player.ConvaiPhoneChatFavoriteKeyActive() {
            evt.Handle();
            return true;
        };
        let open = new ConvaiPhoneChatOpenEvent();
        open.contact = this.m_contactData;
        this.QueueEvent(open);
        evt.Handle();
        return true;
    };
    return false;
}
