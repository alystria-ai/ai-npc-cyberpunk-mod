module CyberpunkConvai

@if(ModuleExists("Codeware.UI"))
import Codeware.UI.*
@if(ModuleExists("Codeware.UI.TextInput"))
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

// The Chat tab's text box is Codeware's text input. Without it (Codeware missing, or too old to have Codeware.UI.TextInput) these
// scripts still compile (a compile error would disable every redscript mod): the stand-in class below has the same methods and
// does nothing, no box is ever built, and mod/setup-check.lua tells the player Codeware is missing or too old.
@if(ModuleExists("Codeware.UI.TextInput"))
public class ConvaiPhoneChatInput extends HubTextInput {
    private let m_keys: array<ref<inkKeyInputEvent>>;
    private let m_submit: Bool;
    // The Enter that opened the box is still down when focus arrives: its press (and a repeat) must not send.
    private let m_enterHeld: Bool;
    private let m_owner: wref<PhoneMessagePopupGameController>;

    public static func Create(owner: wref<PhoneMessagePopupGameController>) -> ref<ConvaiPhoneChatInput> {
        let input = new ConvaiPhoneChatInput();
        input.m_owner = owner;
        input.CreateInstance();
        input.SetLetterCase(textLetterCase.OriginalCase);
        input.SetMaxLength(1200);
        // No placeholder text: the box stays empty until the player types.
        input.SetDefaultText("");
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
            if Equals(evt.GetAction(), EInputAction.IACT_Release) { this.m_enterHeld = false; };
            if Equals(evt.GetAction(), EInputAction.IACT_Press) && !this.m_enterHeld { this.m_submit = true; };
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
        this.m_enterHeld = false;
        super.OnFocusLost(evt);
    }

    public final func HoldEnter() -> Void { this.m_enterHeld = true; }
    public final func ReleaseEnter() -> Void { this.m_enterHeld = false; }

    public final func ReplaceDraft(value: String) -> Void {
        ArrayClear(this.m_keys);
        this.m_submit = false;
        this.SetText(value);
        this.SetCaretPosition(UTF8StrLen(value));
    }
}

@if(!ModuleExists("Codeware.UI.TextInput"))
public class ConvaiPhoneChatInput extends IScriptable {
    public static func Create(owner: wref<PhoneMessagePopupGameController>) -> ref<ConvaiPhoneChatInput> {
        return null;
    }
    public final func IsFocused() -> Bool { return false; }
    public final func GetRootWidget() -> ref<inkWidget> { return null; }
    public final func GetText() -> String { return ""; }
    public final func SetWidth(width: Float) -> Void {}
    public final func Reparent(parent: ref<inkCompoundWidget>) -> Void {}
    public final func ReplaceDraft(value: String) -> Void {}
    public final func HoldEnter() -> Void {}
    public final func ReleaseEnter() -> Void {}
    public final func SetDisabled(disabled: Bool) -> Void {}
}

@addField(PlayerPuppet)
private let m_convaiChatView: wref<PhoneMessagePopupGameController>;
@addField(PlayerPuppet)
private let m_convaiChatDraft: ref<ConvaiPhoneChatDraft>;
@addField(PlayerPuppet)
private let m_convaiChatSubmission: ref<ConvaiPhoneChatDraft>;
@addField(PlayerPuppet)
private let m_convaiChatContacts: array<String>;
// The name of each registered contact, same order: the list shows it for a character the game's journal has no entry for.
@addField(PlayerPuppet)
private let m_convaiChatContactNames: array<String>;

@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatClearContacts() -> Void { ArrayClear(this.m_convaiChatContacts); ArrayClear(this.m_convaiChatContactNames); }
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatRegisterContact(contact: String, name: String) -> Void {
    ArrayPush(this.m_convaiChatContacts, contact);
    ArrayPush(this.m_convaiChatContactNames, name);
}
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatContactIds() -> array<String> { return this.m_convaiChatContacts; }
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatContactName(contact: String) -> String {
    let index = ArrayFindFirst(this.m_convaiChatContacts, contact);
    return index >= 0 ? this.m_convaiChatContactNames[index] : "";
}
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
@if(ModuleExists("Codeware.UI.TextInput"))
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
// The contact id of the open chat: the journal entry's, or the character's own for one the journal has no entry for.
@addField(PhoneMessagePopupGameController)
private let m_convaiChatId: String;

@addMethod(PhoneMessagePopupGameController)
public final func ConvaiChatContact() -> String {
    if !this.m_isFocused || !this.m_data.convaiChat { return ""; };
    return this.m_convaiChatId;
}
@addMethod(PhoneMessagePopupGameController)
public final func ConvaiChatTyping() -> Bool {
    return this.m_convaiChatEscape || (IsDefined(this.m_convaiChatInput) && this.m_convaiChatInput.IsFocused());
}

@wrapMethod(PhoneMessagePopupGameController)
private func SetupData() -> Void {
    this.ConvaiChatSaveDraft();
    this.m_convaiChatInitialized = false;
    this.m_convaiChatEnabled = false;
    this.m_convaiChatBusy = false;
    this.ConvaiChatBlur();
    this.m_dialogViewController.ConvaiChatMode(this.m_data.convaiChat, this.m_journalMgr);
    if !this.m_data.convaiChat {
        inkWidgetRef.SetVisible(this.m_hintClose, true);
        this.ConvaiChatPath(false);
        wrappedMethod();
        return;
    };
    // AI chat has no quest message, attachment or read receipt. In particular,
    // the native SetupData changes journal state, so it must not run here.
    this.m_contactEntry = this.m_data.journalEntry as JournalContact;
    this.m_convaiChatId = IsDefined(this.m_contactEntry) ? this.m_contactEntry.GetId() : this.m_data.convaiChatId;
    this.m_entry = null;
    this.m_attachment = null;
    this.m_attachmentHash = 0u;
    this.m_activeEntry = null;
    this.m_journalEntryHash = 0;
    if IsDefined(this.m_contactEntry) {
        inkTextRef.SetText(this.m_title, this.m_contactEntry.GetLocalizedName(this.m_journalMgr));
        InkImageUtils.RequestAvatarOrUnknown(this, this.m_avatarImage, this.m_contactEntry.GetAvatarID(this.m_journalMgr));
    } else {
        // A character with no journal entry: her name and the game's unknown-caller picture.
        inkTextRef.SetText(this.m_title, this.m_data.convaiChatName);
        InkImageUtils.RequestAvatarOrUnknown(this, this.m_avatarImage, t"");
    };
    inkWidgetRef.SetVisible(this.m_menuBackgrouns, false);
    inkWidgetRef.SetVisible(this.m_hintTrack, false);
    // The game's own Call hint stays hidden here: the game's call is a quest call, and the composer panel would cover
    // it. An open conversation shows no Call hint at all (calls start from the Chat list: its row icon and Call (V)).
    inkWidgetRef.SetVisible(this.m_hintCall, false);
    inkWidgetRef.SetVisible(this.m_hintReply, false);
    // The native "C CLOSE" hint is replaced by our own line (Esc closes here, as well as C).
    inkWidgetRef.SetVisible(this.m_hintClose, false);
    inkWidgetRef.SetVisible(this.m_scrollReply, false);
    inkWidgetRef.SetVisible(this.m_hintMessenger, false);
    inkWidgetRef.SetVisible(this.m_contactsPath, false);
    inkWidgetRef.SetVisible(this.m_messagesPath, true);
    this.ConvaiChatPath(true);
    this.SetFocus(false);
    let ready = new ConvaiPhoneChatReadyEvent();
    ready.generation = this.m_data.convaiChatGeneration;
    this.QueueEvent(ready);
}

@wrapMethod(PhoneMessagePopupGameController)
private func SetFocus(isFocused: Bool) -> Void {
    if !isFocused { this.ConvaiChatSaveDraft(); this.ConvaiChatBlur(); };
    wrappedMethod(isFocused);
    this.m_convaiChatEscape = false;
    let player = this.m_player as PlayerPuppet;
    if IsDefined(player) && this.m_data.convaiChat {
        if isFocused { player.m_convaiChatView = this; }
        else { if player.m_convaiChatView == this { player.m_convaiChatView = null; }; };
        if isFocused {
            this.ConvaiChatCreate();
        };
    };
    if IsDefined(this.m_convaiChatPanel) { this.m_convaiChatPanel.SetVisible(isFocused && this.m_data.convaiChat); };
}

@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(PhoneMessagePopupGameController)
private final func ConvaiChatCreate() -> Void {
    if !IsDefined(this.m_convaiChatKeys) {
        this.m_convaiChatKeys = ConvaiCallbackSystem().RegisterCallback(n"Input/Key", this, n"OnConvaiChatKey")
            .AddTarget(ConvaiKeyTarget(EInputKey.IK_Enter, EInputAction.IACT_Press))
            .AddTarget(ConvaiKeyTarget(EInputKey.IK_Escape, EInputAction.IACT_Release));
        if ConvaiKeyTargetsByAction() {
            this.m_convaiChatKeys.AddTarget(ConvaiKeyTarget(EInputKey.IK_Enter, EInputAction.IACT_Release));
        };
    };
    if IsDefined(this.m_convaiChatPanel) { return; };
    let parent = this.m_dialogViewController.ConvaiChatParent();
    if !IsDefined(parent) { return; };
    let panel = new inkVerticalPanel();
    panel.SetName(n"convaiPhoneComposer");
    panel.SetHAlign(inkEHorizontalAlign.Fill);
    panel.SetFitToContent(true);
    panel.SetVAlign(inkEVerticalAlign.Bottom);
    panel.SetAnchor(inkEAnchor.BottomFillHorizontaly);
    panel.SetAnchorPoint(new Vector2(0.0, 1.0));
    panel.SetMargin(new inkMargin(20.0, 0.0, 35.0, 20.0));
    panel.SetAffectsLayoutWhenHidden(false);
    panel.Reparent(parent);
    this.m_convaiChatPanel = panel;
    this.m_convaiChatInput = ConvaiPhoneChatInput.Create(this);
    this.m_convaiChatInput.SetWidth(1230.0);
    this.m_convaiChatInput.Reparent(panel);
    let hint = new inkText();
    hint.SetName(n"convaiPhoneComposerHint");
    hint.SetFontFamily("base\\gameplay\\gui\\fonts\\raj\\raj.inkfontfamily");
    hint.SetFontStyle(n"Medium");
    hint.SetFontSize(26);
    hint.SetStyle(r"base\\gameplay\\gui\\common\\main_colors.inkstyle");
    hint.BindProperty(n"tintColor", n"MainColors.Blue");
    hint.SetMargin(new inkMargin(4.0, 8.0, 0.0, 0.0));
    hint.SetText("ENTER  Write message   /   ESC  Close");
    hint.Reparent(panel);
    this.m_convaiChatHint = hint;
}

@if(!ModuleExists("Codeware.UI.TextInput"))
@addMethod(PhoneMessagePopupGameController)
private final func ConvaiChatCreate() -> Void {
}

@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(PhoneMessagePopupGameController)
private cb func OnConvaiChatKey(evt: ref<KeyInputEvent>) -> Void {
    // The Enter that opened the box ends here: from its release on, Enter in the box sends.
    if Equals(evt.GetKey(), EInputKey.IK_Enter) && Equals(evt.GetAction(), EInputAction.IACT_Release) {
        if IsDefined(this.m_convaiChatInput) { this.m_convaiChatInput.ReleaseEnter(); };
        return;
    };
    // Enter counts on its press and Escape on its release. The 2.5 key target cannot filter by action (GameVariant.reds), so the action is checked here.
    if NotEquals(evt.GetAction(), Equals(evt.GetKey(), EInputKey.IK_Escape) ? EInputAction.IACT_Release : EInputAction.IACT_Press) { return; };
    if Equals(evt.GetKey(), EInputKey.IK_Escape) {
        // Native menu actions also receive key release. Keep this transition
        // consumed until a later adapter frame, so Escape cannot open Pause.
        if this.m_convaiChatEscape { this.m_convaiChatEscapeFrames = 2; };
        return;
    };
    if !this.m_data.convaiChat || !this.m_isFocused || !this.m_convaiChatEnabled || !this.m_phoneSystem.IsTextingEnabled()
        || !IsDefined(this.m_convaiChatInput) || this.m_convaiChatInput.IsFocused() { return; };
    // Set focus is queued by ink. Consume this opening Enter immediately so it
    // cannot also activate an authored reply choice in the same input frame.
    this.m_convaiChatEscape = true;
    this.m_convaiChatEscapeFrames = 2;
    // The box gets focus while this Enter is still down: it must not also send what the box holds.
    this.m_convaiChatInput.HoldEnter();
    this.RequestSetFocus(this.m_convaiChatInput.GetRootWidget());
    this.m_dialogViewController.ConvaiChatScroll();
}

@addMethod(PhoneMessagePopupGameController)
public final func ConvaiChatSaveDraft() -> Void {
    let player = this.m_player as PlayerPuppet;
    if IsDefined(player) && StrLen(this.m_convaiChatId) > 0 && IsDefined(this.m_convaiChatInput) && this.m_convaiChatInitialized {
        let draft = new ConvaiPhoneChatDraft();
        draft.contact = this.m_convaiChatId;
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
    request.contact = this.m_convaiChatId;
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

// While the player types, the popup swallows the keys the game would act on.
// A key-up is different: the game must see the release of a key that was already
// held when typing began (V strafing right until D is pressed again), so a release
// is consumed only when it belongs to one of the menu actions this popup listens
// for (OpenPauseMenu would otherwise open the pause menu when Esc comes up).
@addMethod(PhoneMessagePopupGameController)
private final func ConvaiChatSwallowsAction(action: ListenerAction) -> Bool {
    if !ListenerAction.IsButtonJustReleased(action) { return true; };
    let name = ListenerAction.GetName(action);
    return Equals(name, n"OpenPauseMenu") || Equals(name, n"cancel") || Equals(name, n"phone_open_journal")
        || Equals(name, n"click") || Equals(name, n"call");
}
// The popup's pointer callback runs after every key-up (OnPostOnRelease). Only the
// actions its own handler reacts to are swallowed; any other key-up passes untouched.
@addMethod(PhoneMessagePopupGameController)
private final func ConvaiChatSwallowsRelease(evt: ref<inkPointerEvent>) -> Bool {
    return evt.IsAction(n"cancel") || evt.IsAction(n"phone_open_journal") || evt.IsAction(n"up_button")
        || evt.IsAction(n"down_button") || evt.IsAction(n"click") || evt.IsAction(n"toggle_menu");
}

@wrapMethod(PhoneMessagePopupGameController)
protected cb func OnAction(action: ListenerAction, consumer: ListenerActionConsumer) -> Bool {
    if this.ConvaiChatTyping() {
        if this.ConvaiChatSwallowsAction(action) { ListenerActionConsumer.Consume(consumer); };
        return false;
    };
    if this.m_data.convaiChat && this.m_isFocused && Equals(ListenerAction.GetName(action), n"OpenPauseMenu") {
        // Esc outside the box closes the conversation as the game's own Close (C, the `cancel` action) does. The typing guard
        // above keeps the Esc that ended typing from reaching this; only a fresh Esc press gets here. The pause menu stays shut.
        if Equals(ListenerAction.GetType(action), gameinputActionType.BUTTON_PRESSED) { this.RequestUnfocus(); };
        ListenerActionConsumer.Consume(consumer);
        ListenerActionConsumer.DontSendReleaseEvent(consumer);
        return false;
    };
    if this.m_data.convaiChat && (Equals(ListenerAction.GetName(action), n"call")
        || Equals(ListenerAction.GetName(action), n"phone_open_journal")) {
        // The game's Call never runs for a mod character (it would send a quest call request): the Call key starts a
        // holocall instead (Holocall.reds), on the press as the game's own handler does, and only while this
        // conversation has the focus (the game leaves its `call` listener registered after the focus moves back to the
        // list). F is not the Call key: it is the game's confirm (`click`). No hint shows this key here (the Chat list
        // shows it); it stays so V does the same in a conversation as on its row.
        if Equals(ListenerAction.GetName(action), n"call") && this.m_isFocused
            && Equals(ListenerAction.GetType(action), gameinputActionType.BUTTON_PRESSED) {
            this.ConvaiChatHolocall();
        };
        ListenerActionConsumer.Consume(consumer);
        return false;
    };
    return wrappedMethod(action, consumer);
}
@wrapMethod(PhoneMessagePopupGameController)
protected cb func OnHandleMenuInput(evt: ref<inkPointerEvent>) -> Bool {
    if this.ConvaiChatTyping() {
        if this.ConvaiChatSwallowsRelease(evt) { evt.Handle(); evt.Consume(); };
        return false;
    };
    return wrappedMethod(evt);
}
@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(PhoneMessagePopupGameController)
private final func ConvaiChatReleaseKeys() -> Void {
    if IsDefined(this.m_convaiChatKeys) { this.m_convaiChatKeys.Unregister(); this.m_convaiChatKeys = null; };
}

@if(!ModuleExists("Codeware.UI.TextInput"))
@addMethod(PhoneMessagePopupGameController)
private final func ConvaiChatReleaseKeys() -> Void {
}

@wrapMethod(PhoneMessagePopupGameController)
protected cb func OnUninitialize() -> Bool {
    this.ConvaiChatSaveDraft();
    this.ConvaiChatBlur();
    this.ConvaiChatReleaseKeys();
    let player = this.m_player as PlayerPuppet;
    if IsDefined(player) && player.m_convaiChatView == this { player.m_convaiChatView = null; };
    if this.m_data.convaiChat {
        this.DisableInput();
        this.m_blackboard.SetBool(this.m_blackboardDef.isDisplayingMessage, false, true);
        this.m_journalMgr.UnregisterScriptCallback(this, n"OnChoiceEntryStateChanged");
        return true;
    };
    return wrappedMethod();
}

@wrapMethod(PhoneMessagePopupGameController)
protected cb func OnGotFocus(evt: ref<FocusSmsMessagerEvent>) -> Bool {
    if this.m_data.convaiChat {
        this.SetFocus(true);
        GameInstance.GetAudioSystem(this.m_player.GetGame()).Play(n"ui_menu_hover");
        this.EnableInput();
        return true;
    };
    return wrappedMethod(evt);
}
@wrapMethod(PhoneMessagePopupGameController)
protected cb func OnChoiceEntryStateChanged(entryHash: Uint32, className: CName, notifyOption: JournalNotifyOption, changeType: JournalChangeType) -> Bool {
    if this.m_data.convaiChat { return false; };
    return wrappedMethod(entryHash, className, notifyOption, changeType);
}
@wrapMethod(PhoneMessagePopupGameController)
protected cb func OnDelayedDotsAnimation(evt: ref<TypingDelayEvent>) -> Bool {
    if this.m_data.convaiChat { return false; };
    return wrappedMethod(evt);
}

// Bounded, named-widget lookup: the paths below come from the live HUD tree.
public class ConvaiPhoneChatLayout {
    public static func Find(root: ref<inkWidget>, name: CName, depth: Int32) -> ref<inkWidget> {
        if !IsDefined(root) { return null; };
        if Equals(root.GetName(), name) { return root; };
        let parent = root as inkCompoundWidget;
        if depth <= 0 || !IsDefined(parent) { return null; };
        let i = 0;
        while i < parent.GetNumChildren() {
            let found = ConvaiPhoneChatLayout.Find(parent.GetWidgetByIndex(i), name, depth - 1);
            if IsDefined(found) { return found; };
            i += 1;
        };
        return null;
    }
}
@addField(PhoneMessagePopupGameController)
private let m_convaiPathText: String;
@addMethod(PhoneMessagePopupGameController)
private final func ConvaiChatPath(chat: Bool) -> Void {
    let text = ConvaiPhoneChatLayout.Find(inkWidgetRef.Get(this.m_messagesPath), n"txtValue", 3) as inkText;
    if !IsDefined(text) { return; };
    if chat {
        if StrLen(this.m_convaiPathText) == 0 { this.m_convaiPathText = text.GetText(); };
        text.SetText("CHAT");
    } else {
        if StrLen(this.m_convaiPathText) > 0 { text.SetText(this.m_convaiPathText); };
    };
}

@addField(MessengerDialogViewController)
private let m_convaiChatLines: array<ref<ConvaiPhoneChatLine>>;
@addField(MessengerDialogViewController)
private let m_convaiChatOnly: Bool;
@addField(MessengerDialogViewController)
private let m_convaiScrollMargin: inkMargin;
@addField(MessengerDialogViewController)
private let m_convaiSliderMargin: inkMargin;
@addMethod(MessengerDialogViewController)
public final func ConvaiChatParent() -> ref<inkCompoundWidget> {
    return ConvaiPhoneChatLayout.Find(this.GetRootWidget(), n"Conversation", 4) as inkCompoundWidget;
}
@addMethod(MessengerDialogViewController)
public final func ConvaiChatMode(chat: Bool, journal: wref<JournalManager>) -> Void {
    ArrayClear(this.m_convaiChatLines);
    let viewport = ConvaiPhoneChatLayout.Find(this.GetRootWidget(), n"MessagesScrollArea", 5);
    let slider = ConvaiPhoneChatLayout.Find(this.GetRootWidget(), n"Slider", 5);
    if chat && !this.m_convaiChatOnly {
        this.m_convaiScrollMargin = viewport.GetMargin();
        this.m_convaiSliderMargin = slider.GetMargin();
        let margin = this.m_convaiScrollMargin;
        margin.bottom += 156.0;
        viewport.SetMargin(margin);
        margin = this.m_convaiSliderMargin;
        margin.bottom += 156.0;
        slider.SetMargin(margin);
        this.DetachJournalManager();
    };
    if !chat && this.m_convaiChatOnly {
        viewport.SetMargin(this.m_convaiScrollMargin);
        slider.SetMargin(this.m_convaiSliderMargin);
        this.AttachJournalManager(journal);
    };
    this.m_convaiChatOnly = chat;
    if chat {
        this.StopDotsAnimation();
        ArrayClear(this.m_messages);
        ArrayClear(this.m_replyOptions);
        this.m_parentEntry = null;
        this.m_parentHash = 0;
        this.m_contactHash = 0;
        this.m_conversationHash = 0;
        this.UpdateData(false, false);
    };
}
@addMethod(MessengerDialogViewController)
public final func ConvaiChatScroll() -> Void { this.m_scrollController.SetScrollPosition(1.0); }
@addMethod(MessengerDialogViewController)
public final func ConvaiChatSetLines(lines: array<ref<ConvaiPhoneChatLine>>) -> Void {
    this.m_convaiChatLines = lines;
    this.UpdateData(false, false);
}
// Detaching journal listeners cannot retract events already queued by the
// native messenger. Those events also drive typing, sound and visited state.
@wrapMethod(MessengerDialogViewController)
protected cb func OnJournalUpdate(entryHash: Uint32, className: CName, notifyOption: JournalNotifyOption, changeType: JournalChangeType) -> Bool {
    if this.m_convaiChatOnly { return false; };
    return wrappedMethod(entryHash, className, notifyOption, changeType);
}
@wrapMethod(MessengerDialogViewController)
protected cb func OnJournalUpdateDelayed(entryHash: Uint32, className: CName, notifyOption: JournalNotifyOption, changeType: JournalChangeType, delay: Float) -> Bool {
    if this.m_convaiChatOnly { return false; };
    return wrappedMethod(entryHash, className, notifyOption, changeType, delay);
}
@wrapMethod(MessengerDialogViewController)
protected cb func OnDelayedJournalUpdate(evt: ref<DelayedJournalUpdate>) -> Bool {
    if this.m_convaiChatOnly { return false; };
    return wrappedMethod(evt);
}
@wrapMethod(MessengerDialogViewController)
public func UpdateData(animateLastMessage: Bool, setVisited: Bool) -> Void {
    if !this.m_convaiChatOnly { wrappedMethod(animateLastMessage, setVisited); return; };
    // Clear() alone defers widget refresh. An empty AI history has no later
    // PushDataList call, so recycled quest SMS would otherwise remain visible.
    this.m_messagesListController.Clear(true);
    this.m_choicesListController.Clear(true);
    inkCompoundRef.SetVisible(this.m_replayFluff, false);
    inkWidgetRef.SetVisible(this.m_typingFluff, false);
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
