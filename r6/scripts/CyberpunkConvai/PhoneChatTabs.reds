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
@addField(JournalNotificationData)
public let convaiChat: Bool;
@addField(JournalNotificationData)
public let convaiChatGeneration: Uint32;

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
        icon.SetStyle(r"base\\gameplay\\gui\\common\\main_colors.inkstyle");
        icon.BindProperty(n"tintColor", n"MainColors.Red");
        return icon;
    }
    public static func Select(icon: wref<inkWidget>, selected: Bool) -> Void {
        if IsDefined(icon) {
            icon.BindProperty(n"tintColor", selected ? n"MainColors.Blue" : n"MainColors.Red");
        };
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
}

@addField(NewHudPhoneGameController)
private let m_convaiChatState: ConvaiPhoneChatState;
@addField(NewHudPhoneGameController)
private let m_convaiChatGeneration: Uint32;

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
private final func ConvaiShowChatContacts() -> Void {
    let contacts: array<ref<IScriptable>>;
    let entries: array<wref<JournalEntry>>;
    let context: JournalRequestContext;
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
            row.localizedName = contact.GetLocalizedName(this.m_journalMgr);
            row.avatarID = contact.GetAvatarID(this.m_journalMgr);
            // This is a display row. Activation below always opens AI chat.
            row.isCallable = true;
            ArrayPush(contacts, row);
        };
    };
    this.m_screenType = PhoneScreenType.Contacts;
    this.m_convaiChatState = ConvaiPhoneChatState.List;
    this.m_contactListLogicController.SetSortMethod(ContactsSortMethod.ByName);
    this.m_contactListLogicController.PopulateListData(contacts);
    this.m_contactListLogicController.ConvaiShowChatTab(ArraySize(contacts) == 0);
}

@addMethod(NewHudPhoneGameController)
private cb func OnConvaiPhoneTab(evt: ref<ConvaiPhoneTabEvent>) -> Bool {
    this.ConvaiSelectPhoneTab(evt.index);
    return true;
}

@wrapMethod(NewHudPhoneGameController)
protected cb func OnContactListAction(action: ListenerAction, consumer: ListenerActionConsumer) -> Bool {
    let name = ListenerAction.GetName(action);
    if Equals(ListenerAction.GetType(action), gameinputActionType.BUTTON_PRESSED) {
        let left = Equals(name, n"popup_moveLeft") || Equals(name, n"popup_prior");
        let right = Equals(name, n"popup_moveRight") || Equals(name, n"popup_next");
        if left || right {
            this.ConvaiSelectPhoneTab((this.ConvaiPhoneTabIndex() + (left ? 2 : 1)) % 3);
            ListenerActionConsumer.Consume(consumer);
            return true;
        };
        if Equals(this.m_convaiChatState, ConvaiPhoneChatState.List) {
            // The Call key of a Chat row (the game's `call` action, V on a keyboard, Triangle on a pad, the key the Call
            // hint shows). On a pad Triangle is also showAll, which means nothing on this tab.
            if Equals(name, n"call") {
                this.ConvaiChatListHolocall(this.m_contactListLogicController.GetSelectedContactData());
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
}
@wrapMethod(NewHudPhoneGameController)
public func DisableContactsInput() -> Void {
    if IsDefined(this.m_player) { this.m_player.UnregisterInputListener(this, n"call"); };
    wrappedMethod();
}

@wrapMethod(NewHudPhoneGameController)
public func SelectOtherTab() -> Void {
    this.ConvaiSelectPhoneTab((this.ConvaiPhoneTabIndex() + 1) % 3);
}

@wrapMethod(NewHudPhoneGameController)
public func SetScreenType(type: PhoneScreenType) -> Void {
    this.m_convaiChatState = ConvaiPhoneChatState.Off;
    this.m_convaiChatGeneration += 1u;
    wrappedMethod(type);
}

@wrapMethod(NewHudPhoneGameController)
public func AcceptAction() -> Void {
    if NotEquals(this.m_convaiChatState, ConvaiPhoneChatState.Off) {
        this.ConvaiOpenChat(this.m_contactListLogicController.GetSelectedContactData());
        return;
    };
    wrappedMethod();
}
// On the Chat list both the accept action (F, Enter, click) and the secondary action (the game's Messages key, R, the
// envelope on the row) open the text chat. The call has its own key, `call` (V, Triangle), handled in OnContactListAction.
@wrapMethod(NewHudPhoneGameController)
public func AlternativeAcceptAction() -> Void {
    if NotEquals(this.m_convaiChatState, ConvaiPhoneChatState.Off) {
        this.ConvaiOpenChat(this.m_contactListLogicController.GetSelectedContactData());
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
private final func ConvaiOpenChat(contact: wref<ContactData>) -> Void {
    if NotEquals(this.m_convaiChatState, ConvaiPhoneChatState.List) || !IsDefined(contact)
        || !contact.convaiChat || !this.m_player.ConvaiPhoneChatHasContact(contact.id) { return; };
    this.m_convaiChatState = ConvaiPhoneChatState.Opening;
    this.m_convaiChatGeneration += 1u;
    this.m_messageToOpenHash = 0;
    let data = new JournalNotificationData();
    data.convaiChat = true;
    data.convaiChatGeneration = this.m_convaiChatGeneration;
    data.journalEntry = this.m_journalMgr.GetEntry(Cast<Uint32>(contact.hash));
    data.type = MessengerContactType.SingleThread;
    data.mode = JournalNotificationMode.HUD;
    data.openedFromPhone = true;
    data.source = PhoneScreenType.Contacts;
    data.contactNameLocKey = StringToName(contact.localizedName);
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
    this.m_convaiChatGeneration += 1u;
    return wrappedMethod();
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

@wrapMethod(PhoneDialerLogicController)
private func RefreshInputHints(contactData: wref<ContactData>) -> Void {
    wrappedMethod(contactData);
    if IsDefined(contactData) && contactData.convaiChat {
        inkTextRef.SetText(this.m_acceptButtonLabel, "Chat");
        inkWidgetRef.SetVisible(this.m_acceptButtonWidget, true);
        // The second bottom hint (the game's Messages hint, R) is the Call hint here: the game's own key hint rebound to
        // the `call` action, so it shows the real key (V, Triangle), with the game's own translated Call label. R itself
        // still opens the chat; its envelope is on the row.
        if !this.m_convaiCallHintBound {
            let previous = ConvaiHintBinding.Rebind(inkWidgetRef.Get(this.m_action2ButtonWidget), n"call");
            if NotEquals(previous, n"") { this.m_convaiCallHintAction = previous; this.m_convaiCallHintBound = true; };
        };
        inkTextRef.SetLocalizedTextScript(this.m_action2ButtonLabel, "LocKey#22196");
        inkWidgetRef.SetVisible(this.m_action2ButtonWidget, true);
        inkWidgetRef.SetVisible(this.m_showAllButtonWidget, false);
    } else {
        // Anything else on this list: the hint is the game's again, bound to what it was bound to.
        if this.m_convaiCallHintBound {
            ConvaiHintBinding.Rebind(inkWidgetRef.Get(this.m_action2ButtonWidget), this.m_convaiCallHintAction);
            this.m_convaiCallHintBound = false;
        };
    };
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
    label.SetStyle(r"base\\gameplay\\gui\\common\\main_colors.inkstyle");
    label.BindProperty(n"tintColor", n"MainColors.Red");
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
    if IsDefined(this.m_convaiChatLabel) {
        this.m_convaiChatLabel.BindProperty(n"tintColor", index == 4 ? n"MainColors.Blue" : n"MainColors.Red");
        ConvaiChatTabArtwork.Select(this.m_convaiChatGlyph, index == 4);
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

@wrapMethod(PhoneContactItemVirtualController)
protected cb func OnDataChanged(value: Variant) -> Bool {
    let result = wrappedMethod(value);
    if IsDefined(this.m_contactData) && this.m_contactData.convaiChat {
        // A Chat row has two icons on the selected row: the game's own chat hint (R and the envelope: opens the chat) and
        // the game's own call hint (a key box and the phone) rebound to `call`, so it shows the real call key (V, Triangle).
        if !this.m_convaiCallHintBound {
            let previous = ConvaiHintBinding.Rebind(inkWidgetRef.Get(this.m_callInputHint), n"call");
            if NotEquals(previous, n"") { this.m_convaiCallHintAction = previous; this.m_convaiCallHintBound = true; };
        };
        inkWidgetRef.SetVisible(this.m_callInputHint, true);
        inkWidgetRef.SetVisible(this.m_chatInputHint, true);
        inkWidgetRef.SetVisible(this.m_separtor, true);
    } else {
        // This row view is recycled by the game's own lists: any other contact gets the game's hint back as it was.
        if this.m_convaiCallHintBound {
            ConvaiHintBinding.Rebind(inkWidgetRef.Get(this.m_callInputHint), this.m_convaiCallHintAction);
            this.m_convaiCallHintBound = false;
        };
    };
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
        let open = new ConvaiPhoneChatOpenEvent();
        open.contact = this.m_contactData;
        this.QueueEvent(open);
        evt.Handle();
        return true;
    };
    return false;
}
