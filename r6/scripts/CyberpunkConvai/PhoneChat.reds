module CyberpunkConvai

import Codeware.UI.*
import Codeware.UI.TextInput.*

// Presentation data only: these rows never become quest journal entries.
public class ConvaiPhoneChatLine extends IScriptable {
    public let text: String;
    public let sent: Bool;
}

public class ConvaiPhoneChatDraft extends IScriptable {
    public let contact: String;
    public let text: String;
}

public class ConvaiPhoneChatInput extends HubTextInput {
    private let m_keys: array<ref<inkKeyInputEvent>>;
    private let m_submit: Bool;
    private let m_owner: wref<PhoneMessagePopupGameController>;

    public static func Create(owner: wref<PhoneMessagePopupGameController>) -> ref<ConvaiPhoneChatInput> {
        let input = new ConvaiPhoneChatInput();
        input.m_owner = owner;
        input.CreateInstance();
        input.SetLetterCase(textLetterCase.OriginalCase);
        input.SetMaxLength(1200);
        input.SetDefaultText("Write a message...");
        return input;
    }

    protected func CreateWidgets() -> Void {
        super.CreateWidgets();
        this.m_text.SetFontSize(32);
        this.m_root.SetHeight(72.0);
        this.m_wrapper.SetMargin(new inkMargin(16.0, 17.0, 16.0, 0.0));
    }

    protected cb func OnInputKey(evt: ref<inkKeyInputEvent>) {
        if Equals(evt.GetKey(), EInputKey.IK_Enter) {
            if Equals(evt.GetAction(), EInputAction.IACT_Press) { this.m_submit = true; };
            return;
        };
        if Equals(evt.GetKey(), EInputKey.IK_Escape) {
            if Equals(evt.GetAction(), EInputAction.IACT_Press) { this.m_owner.ConvaiChatEscape(); };
            return;
        };
        super.OnInputKey(evt);
    }

    protected func ProcessInputEvent(evt: ref<inkKeyInputEvent>) -> Void {
        if this.m_submit { return; };
        if this.m_measurer.IsMeasuring() || ArraySize(this.m_keys) > 0 {
            if ArraySize(this.m_keys) < 256 { ArrayPush(this.m_keys, evt); };
        } else { super.ProcessInputEvent(evt); };
    }

    protected cb func OnHoldTick(anim: ref<inkAnimProxy>) {
        super.OnHoldTick(anim);
        if !this.m_measurer.IsMeasuring() && ArraySize(this.m_keys) > 0 {
            let evt = this.m_keys[0];
            ArrayErase(this.m_keys, 0);
            super.ProcessInputEvent(evt);
        };
        // Enter waits for all previously typed glyphs, including a final paste.
        if this.m_submit && !this.m_measurer.IsMeasuring() && ArraySize(this.m_keys) == 0 {
            this.m_submit = false;
            this.m_owner.ConvaiChatSubmit();
        };
    }

    protected cb func OnReleaseKey(evt: ref<inkPointerEvent>) {
        // Codeware's generic input maps an equipment action to clearing text.
        // In a phone conversation that key must remain an ordinary character.
        if !evt.IsAction(n"unequip_item") { super.OnReleaseKey(evt); };
    }

    protected cb func OnFocusLost(evt: ref<inkEvent>) {
        this.m_submit = false;
        super.OnFocusLost(evt);
    }

    public final func ReplaceDraft(value: String) -> Void {
        ArrayClear(this.m_keys);
        this.m_submit = false;
        this.SetText(value);
        this.SetCaretPosition(UTF8StrLen(value));
    }
}

@addField(PlayerPuppet)
private let m_convaiChatView: wref<PhoneMessagePopupGameController>;
@addField(PlayerPuppet)
private let m_convaiChatDraft: ref<ConvaiPhoneChatDraft>;
@addField(PlayerPuppet)
private let m_convaiChatSubmission: ref<ConvaiPhoneChatDraft>;
@addField(PlayerPuppet)
private let m_convaiChatContacts: array<String>;

@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatClearContacts() -> Void { ArrayClear(this.m_convaiChatContacts); }
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatRegisterContact(contact: String) -> Void { ArrayPush(this.m_convaiChatContacts, contact); }
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatHasContact(contact: String) -> Bool { return ArrayContains(this.m_convaiChatContacts, contact); }

@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatContact() -> String {
    return IsDefined(this.m_convaiChatView) ? this.m_convaiChatView.ConvaiChatContact() : "";
}
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatTyping() -> Bool {
    return IsDefined(this.m_convaiChatView) && this.m_convaiChatView.ConvaiChatTyping();
}
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatTick() -> Void {
    if IsDefined(this.m_convaiChatView) { this.m_convaiChatView.ConvaiChatAdvanceGuard(); };
}
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatDraft() -> ref<ConvaiPhoneChatDraft> {
    if IsDefined(this.m_convaiChatView) { this.m_convaiChatView.ConvaiChatSaveDraft(); };
    return this.m_convaiChatDraft;
}
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatTakeSubmission() -> ref<ConvaiPhoneChatDraft> {
    let submission = this.m_convaiChatSubmission;
    this.m_convaiChatSubmission = null;
    return submission;
}
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatPresent(contact: String, lines: array<ref<ConvaiPhoneChatLine>>, status: String, draft: String, enabled: Bool, busy: Bool, resetDraft: Bool) -> Void {
    if IsDefined(this.m_convaiChatView) && Equals(contact, this.m_convaiChatView.ConvaiChatContact()) {
        this.m_convaiChatView.ConvaiChatPresent(lines, status, draft, enabled, busy, resetDraft);
    };
}

@addField(PhoneMessagePopupGameController)
private let m_convaiChatInput: ref<ConvaiPhoneChatInput>;
@addField(PhoneMessagePopupGameController)
private let m_convaiChatPanel: wref<inkVerticalPanel>;
@addField(PhoneMessagePopupGameController)
private let m_convaiChatHint: wref<inkText>;
@addField(PhoneMessagePopupGameController)
private let m_convaiChatKeys: ref<CallbackSystemHandler>;
@addField(PhoneMessagePopupGameController)
private let m_convaiChatEnabled: Bool;
@addField(PhoneMessagePopupGameController)
private let m_convaiChatBusy: Bool;
@addField(PhoneMessagePopupGameController)
private let m_convaiChatInitialized: Bool;
@addField(PhoneMessagePopupGameController)
private let m_convaiChatEscape: Bool;
@addField(PhoneMessagePopupGameController)
private let m_convaiChatEscapeFrames: Int32;

@addMethod(PhoneMessagePopupGameController)
public final func ConvaiChatContact() -> String {
    if !this.m_isFocused || !IsDefined(this.m_contactEntry) || !this.m_data.openedFromPhone { return ""; };
    return this.m_contactEntry.GetId();
}
@addMethod(PhoneMessagePopupGameController)
public final func ConvaiChatTyping() -> Bool {
    return this.m_convaiChatEscape || (IsDefined(this.m_convaiChatInput) && this.m_convaiChatInput.IsFocused());
}

@wrapMethod(PhoneMessagePopupGameController)
private func SetupData() -> Void {
    this.ConvaiChatSaveDraft();
    this.m_convaiChatInitialized = false;
    this.ConvaiChatBlur();
    if IsDefined(this.m_dialogViewController) { this.m_dialogViewController.ConvaiChatClear(); };
    wrappedMethod();
}

@wrapMethod(PhoneMessagePopupGameController)
private func SetFocus(isFocused: Bool) -> Void {
    if !isFocused { this.ConvaiChatSaveDraft(); this.ConvaiChatBlur(); };
    wrappedMethod(isFocused);
    this.m_convaiChatEscape = false;
    let player = this.m_player as PlayerPuppet;
    if IsDefined(player) && this.m_data.openedFromPhone {
        player.m_convaiChatView = isFocused ? this : null;
        if isFocused {
            this.ConvaiChatCreate();
        };
    };
    if IsDefined(this.m_convaiChatPanel) { this.m_convaiChatPanel.SetVisible(isFocused); };
}

@addMethod(PhoneMessagePopupGameController)
private final func ConvaiChatCreate() -> Void {
    if !IsDefined(this.m_convaiChatKeys) {
        this.m_convaiChatKeys = GameInstance.GetCallbackSystem().RegisterCallback(n"Input/Key", this, n"OnConvaiChatKey")
            .AddTarget(InputTarget.Key(EInputKey.IK_Enter, EInputAction.IACT_Press))
            .AddTarget(InputTarget.Key(EInputKey.IK_Escape, EInputAction.IACT_Release));
    };
    if IsDefined(this.m_convaiChatPanel) { return; };
    let parent = this.m_dialogViewController.ConvaiChatParent();
    if !IsDefined(parent) { return; };
    let panel = new inkVerticalPanel();
    panel.SetName(n"convaiPhoneComposer");
    panel.SetHAlign(inkEHorizontalAlign.Fill);
    panel.SetFitToContent(true);
    panel.SetMargin(new inkMargin(0.0, 24.0, 0.0, 20.0));
    panel.Reparent(parent);
    this.m_convaiChatPanel = panel;
    this.m_convaiChatInput = ConvaiPhoneChatInput.Create(this);
    this.m_convaiChatInput.SetWidth(720.0);
    this.m_convaiChatInput.Reparent(panel);
    let hint = new inkText();
    hint.SetName(n"convaiPhoneComposerHint");
    hint.SetFontFamily("base\\gameplay\\gui\\fonts\\raj\\raj.inkfontfamily");
    hint.SetFontStyle(n"Medium");
    hint.SetFontSize(26);
    hint.SetStyle(r"base\\gameplay\\gui\\common\\main_colors.inkstyle");
    hint.BindProperty(n"tintColor", n"MainColors.Blue");
    hint.SetMargin(new inkMargin(4.0, 8.0, 0.0, 0.0));
    hint.SetText("ENTER  Write message   /   ESC  Stop typing");
    hint.Reparent(panel);
    this.m_convaiChatHint = hint;
}

@addMethod(PhoneMessagePopupGameController)
private cb func OnConvaiChatKey(evt: ref<KeyInputEvent>) -> Void {
    if Equals(evt.GetKey(), EInputKey.IK_Escape) {
        // Native menu actions also receive key release. Keep this transition
        // consumed until a later adapter frame, so Escape cannot open Pause.
        if this.m_convaiChatEscape { this.m_convaiChatEscapeFrames = 2; };
        return;
    };
    if !this.m_isFocused || !this.m_convaiChatEnabled || !this.m_phoneSystem.IsTextingEnabled()
        || !IsDefined(this.m_convaiChatInput) || this.m_convaiChatInput.IsFocused() { return; };
    // Set focus is queued by ink. Consume this opening Enter immediately so it
    // cannot also activate an authored reply choice in the same input frame.
    this.m_convaiChatEscape = true;
    this.m_convaiChatEscapeFrames = 2;
    this.RequestSetFocus(this.m_convaiChatInput.GetRootWidget());
    this.m_dialogViewController.ConvaiChatScroll();
}

@addMethod(PhoneMessagePopupGameController)
public final func ConvaiChatSaveDraft() -> Void {
    let player = this.m_player as PlayerPuppet;
    if IsDefined(player) && IsDefined(this.m_contactEntry) && IsDefined(this.m_convaiChatInput) && this.m_convaiChatInitialized {
        let draft = new ConvaiPhoneChatDraft();
        draft.contact = this.m_contactEntry.GetId();
        draft.text = this.m_convaiChatInput.GetText();
        player.m_convaiChatDraft = draft;
    };
}

@addMethod(PhoneMessagePopupGameController)
public final func ConvaiChatBlur() -> Void {
    if IsDefined(this.m_convaiChatInput) && this.m_convaiChatInput.IsFocused() {
        this.ConvaiChatSaveDraft();
        this.RequestSetFocus(null);
    };
}

@addMethod(PhoneMessagePopupGameController)
public final func ConvaiChatEscape() -> Void {
    this.m_convaiChatEscape = true;
    this.m_convaiChatEscapeFrames = 0;
    this.ConvaiChatBlur();
}

@addMethod(PhoneMessagePopupGameController)
public final func ConvaiChatAdvanceGuard() -> Void {
    if this.m_convaiChatEscapeFrames > 0 {
        this.m_convaiChatEscapeFrames -= 1;
        if this.m_convaiChatEscapeFrames == 0 { this.m_convaiChatEscape = false; };
    };
}

@addMethod(PhoneMessagePopupGameController)
public final func ConvaiChatSubmit() -> Void {
    let player = this.m_player as PlayerPuppet;
    if !IsDefined(player) || !this.m_convaiChatEnabled || !this.m_isFocused || this.m_convaiChatBusy
        || !this.m_phoneSystem.IsTextingEnabled() || !this.m_convaiChatInput.IsFocused()
        || IsDefined(player.m_convaiChatSubmission) { return; };
    let text = this.m_convaiChatInput.GetText();
    if StrLen(text) == 0 { return; };
    let request = new ConvaiPhoneChatDraft();
    request.contact = this.m_contactEntry.GetId();
    request.text = text;
    player.m_convaiChatSubmission = request;
    this.m_convaiChatBusy = true;
}

@addMethod(PhoneMessagePopupGameController)
public final func ConvaiChatPresent(lines: array<ref<ConvaiPhoneChatLine>>, status: String, draft: String, enabled: Bool, busy: Bool, resetDraft: Bool) -> Void {
    this.ConvaiChatCreate();
    if !IsDefined(this.m_convaiChatInput) { return; };
    if resetDraft || !this.m_convaiChatInitialized { this.m_convaiChatInput.ReplaceDraft(draft); };
    this.m_convaiChatInitialized = true;
    this.m_convaiChatEnabled = enabled;
    this.m_convaiChatBusy = busy;
    this.m_convaiChatInput.SetDisabled(!enabled);
    this.m_convaiChatHint.SetText(StrLen(status) > 0 ? status : "ENTER  Write / Send   /   ESC  Stop typing");
    this.m_dialogViewController.ConvaiChatSetLines(lines);
}

@wrapMethod(PhoneMessagePopupGameController)
protected cb func OnAction(action: ListenerAction, consumer: ListenerActionConsumer) -> Bool {
    if this.ConvaiChatTyping() {
        ListenerActionConsumer.Consume(consumer);
        return false;
    };
    return wrappedMethod(action, consumer);
}
@wrapMethod(PhoneMessagePopupGameController)
protected cb func OnHandleMenuInput(evt: ref<inkPointerEvent>) -> Bool {
    if this.ConvaiChatTyping() { evt.Handle(); evt.Consume(); return false; };
    return wrappedMethod(evt);
}
@wrapMethod(PhoneMessagePopupGameController)
protected cb func OnUninitialize() -> Bool {
    this.ConvaiChatSaveDraft();
    this.ConvaiChatBlur();
    if IsDefined(this.m_convaiChatKeys) { this.m_convaiChatKeys.Unregister(); this.m_convaiChatKeys = null; };
    let player = this.m_player as PlayerPuppet;
    if IsDefined(player) { player.m_convaiChatView = null; };
    return wrappedMethod();
}

@addField(MessengerDialogViewController)
private let m_convaiChatLines: array<ref<ConvaiPhoneChatLine>>;
@addMethod(MessengerDialogViewController)
public final func ConvaiChatParent() -> ref<inkCompoundWidget> {
    return inkCompoundRef.Get(this.m_messagesList).GetParentWidget() as inkCompoundWidget;
}
@addMethod(MessengerDialogViewController)
public final func ConvaiChatClear() -> Void { ArrayClear(this.m_convaiChatLines); }
@addMethod(MessengerDialogViewController)
public final func ConvaiChatScroll() -> Void { this.m_scrollController.SetScrollPosition(1.0); }
@addMethod(MessengerDialogViewController)
public final func ConvaiChatSetLines(lines: array<ref<ConvaiPhoneChatLine>>) -> Void {
    this.m_convaiChatLines = lines;
    this.UpdateData(false, false);
}
@wrapMethod(MessengerDialogViewController)
public func UpdateData(animateLastMessage: Bool, setVisited: Bool) -> Void {
    wrappedMethod(animateLastMessage, setVisited);
    let items: array<ref<IScriptable>>;
    for line in this.m_convaiChatLines { ArrayPush(items, line); };
    if ArraySize(items) > 0 { this.m_messagesListController.PushDataList(items, true); };
    this.ConvaiChatScroll();
}
@wrapMethod(JournalEntryListItemController)
protected cb func OnDataChanged(value: ref<IScriptable>) -> Bool {
    let line = value as ConvaiPhoneChatLine;
    let renderer = this as MessangerItemRenderer;
    if IsDefined(line) && IsDefined(renderer) { renderer.ConvaiChatRender(line); return true; };
    return wrappedMethod(value);
}
@addMethod(MessangerItemRenderer)
public final func ConvaiChatRender(line: ref<ConvaiPhoneChatLine>) -> Void {
    inkImageRef.SetVisible(this.m_image, false);
    this.SetMessageView(line.text, line.sent ? MessageViewType.Sent : MessageViewType.Received, "");
}

// A supported, already unlocked contact can have no authored SMS yet. Create
// only an ephemeral UI row so the normal phone panel can open; no journal data
// is created, unlocked, visited or used as a synthetic quest reply.
@wrapMethod(NewHudPhoneGameController)
public func ExecuteAction() -> Void {
    if IsDefined(this.m_contactListLogicController) {
        let contact = this.m_contactListLogicController.GetSelectedContactData();
        if IsDefined(contact) && Equals(contact.type, MessengerContactType.Contact)
            && !contact.hasMessages && !contact.playerCanReply
            && this.m_player.ConvaiPhoneChatHasContact(contact.id) {
            this.ShowSelectedContactMessages(contact);
            return;
        };
    };
    wrappedMethod();
}
@wrapMethod(NewHudPhoneGameController)
public func ShowSelectedContactMessages(contactData: wref<ContactData>) -> Void {
    let messages = MessengerUtils.GetMessageDataArrayForContact(this.m_journalMgr, contactData.hash, true, true);
    if ArraySize(messages) == 0 && this.m_player.ConvaiPhoneChatHasContact(contactData.id) {
        let row = new ContactData();
        row.id = contactData.id;
        row.contactId = contactData.id;
        row.hash = contactData.hash;
        row.localizedName = contactData.localizedName;
        row.localizedPreview = "Messages";
        row.hasValidTitle = true;
        row.isCallable = contactData.isCallable;
        row.type = MessengerContactType.SingleThread;
        ArrayPush(messages, row);
        this.m_threadsVisible = true;
        this.m_isSingleThread = true;
        this.m_contactListLogicController.PushList(messages, ContactsSortMethod.ByTime);
        this.m_contactListLogicController.SetTitle(contactData.localizedName);
        this.m_contactListLogicController.ShowTitle(true);
        return;
    };
    wrappedMethod(contactData);
}
@wrapMethod(PhoneContactItemVirtualController)
protected cb func OnDataChanged(value: Variant) -> Bool {
    let result = wrappedMethod(value);
    let player = GetPlayer(GetGameInstance()) as PlayerPuppet;
    if IsDefined(player) && IsDefined(this.m_contactData) && Equals(this.m_contactData.type, MessengerContactType.Contact)
        && player.ConvaiPhoneChatHasContact(this.m_contactData.id) {
        inkWidgetRef.SetVisible(this.m_chatInputHint, true);
    };
    return result;
}
