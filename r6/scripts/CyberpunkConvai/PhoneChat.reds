module CyberpunkConvai

@if(ModuleExists("Codeware.UI"))
import Codeware.UI.*
@if(ModuleExists("Codeware.UI.TextInput"))
import Codeware.UI.TextInput.*

// Presentation data only: these rows never become quest journal entries.
public class ConvaiPhoneChatLine extends IScriptable {
    public let text: String;
    public let sent: Bool;
    // An optional picture shown under the text (docs/PHONE_IMAGES.md): the depot path of an .inkatlas from the optional picture archive, the name
    // of its part, and the picture's size in pixels (for the shape of the frame). All empty/zero for the ordinary text-only line.
    public let imageAtlas: String;
    public let imagePart: String;
    public let imageWidth: Int32;
    public let imageHeight: Int32;
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
    // The box was focused by itself when the chat opened (not by an Enter of the player's): the Enter that opened the chat may still be down,
    // or repeating, so no Enter counts as a send until this engine time (seconds). A time stamp read on a key press, not a timer.
    private let m_enterGuardUntil: Float;
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
            if Equals(evt.GetAction(), EInputAction.IACT_Press) && !this.m_enterHeld
                && (this.m_enterGuardUntil <= 0.0 || this.m_owner.ConvaiChatNow() >= this.m_enterGuardUntil) { this.m_submit = true; };
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
        this.m_enterGuardUntil = 0.0;
        super.OnFocusLost(evt);
    }

    public final func HoldEnter() -> Void { this.m_enterHeld = true; }
    public final func ReleaseEnter() -> Void { this.m_enterHeld = false; }
    public final func GuardEnter(seconds: Float) -> Void { this.m_enterGuardUntil = this.m_owner.ConvaiChatNow() + seconds; }

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
    public final func GuardEnter(seconds: Float) -> Void {}
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

// The favorite contacts (the characters starred in Characters to invite): the Chat list puts them first (SortItem in PhoneChatTabs.reds) and
// shows their name as any other row's. Set from Lua when the favorites change; read only when the list is built.
@addField(PlayerPuppet)
private let m_convaiChatFavorites: array<String>;
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatClearFavorites() -> Void { ArrayClear(this.m_convaiChatFavorites); }
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatAddFavorite(contact: String) -> Void { ArrayPush(this.m_convaiChatFavorites, contact); }
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatIsFavorite(contact: String) -> Bool { return ArrayContains(this.m_convaiChatFavorites, contact); }

// The Chat contacts that are in the party (a copy present or an invitation being prepared): the row shows Dismiss (L) for these and Invite (J)
// for the others. Set from Lua while the phone is open, when the party changes; a J or L press also updates it at once.
@addField(PlayerPuppet)
private let m_convaiChatParty: array<String>;
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatClearParty() -> Void { ArrayClear(this.m_convaiChatParty); }
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatAddParty(contact: String) -> Void { ArrayPush(this.m_convaiChatParty, contact); }
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatInParty(contact: String) -> Bool { return ArrayContains(this.m_convaiChatParty, contact); }
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatSetParty(contact: String, inParty: Bool) -> Void {
    ArrayRemove(this.m_convaiChatParty, contact);
    if inParty { ArrayPush(this.m_convaiChatParty, contact); };
}

// The F key on the Chat list turns a contact's favorite on or off. The list shows the change at once from this array; the request goes on
// to Lua (mod/phone-chat.lua takes it on its 10 Hz tick), which keeps it in favorites.lua and sends the whole list back. A request is one
// string: "1" (on) or "0" (off), then the contact id. Written only on a key press, never per frame.
@addField(PlayerPuppet)
private let m_convaiChatFavoriteRequests: array<String>;
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatSetFavorite(contact: String, on: Bool) -> Void {
    ArrayRemove(this.m_convaiChatFavorites, contact);
    if on { ArrayPush(this.m_convaiChatFavorites, contact); };
    if ArraySize(this.m_convaiChatFavoriteRequests) < 16 { ArrayPush(this.m_convaiChatFavoriteRequests, (on ? "1" : "0") + contact); };
}
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatTakeFavoriteRequest() -> String {
    if ArraySize(this.m_convaiChatFavoriteRequests) == 0 { return ""; };
    let request = this.m_convaiChatFavoriteRequests[0];
    ArrayErase(this.m_convaiChatFavoriteRequests, 0);
    return request;
}

// The F key is also the game's confirm (`click`), which opens a chat. While F is down, and for a moment after it comes up (the game's own click
// of the release), a click on the Chat list is the favorite key's and opens nothing. Time of the last F event, engine seconds.
@addField(PlayerPuppet)
private let m_convaiChatFavoriteKeyAt: Float;
@addField(PlayerPuppet)
private let m_convaiChatFavoriteKeyDown: Bool;
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatFavoriteKey(down: Bool) -> Void {
    this.m_convaiChatFavoriteKeyDown = down;
    this.m_convaiChatFavoriteKeyAt = EngineTime.ToFloat(GameInstance.GetEngineTime(this.GetGame()));
}
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatFavoriteKeyActive() -> Bool {
    if this.m_convaiChatFavoriteKeyDown { return true; };
    if this.m_convaiChatFavoriteKeyAt <= 0.0 { return false; };
    let age = EngineTime.ToFloat(GameInstance.GetEngineTime(this.GetGame())) - this.m_convaiChatFavoriteKeyAt;
    return age >= 0.0 && age < 0.35;
}

@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatContact() -> String {
    return IsDefined(this.m_convaiChatView) ? this.m_convaiChatView.ConvaiChatContact() : "";
}
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatTyping() -> Bool {
    return (IsDefined(this.m_convaiChatView) && this.m_convaiChatView.ConvaiChatTyping()) || this.ConvaiPhoneChatSearchTyping();
}
// One line per step of opening a chat (the press, the page, the focus), for the probe log: mod/phone-chat.lua takes them on its 10 Hz tick and
// logs them. Bounded, written only when a chat is opened or closed, never per frame.
@addField(PlayerPuppet)
private let m_convaiChatTrace: array<String>;
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatTrace(line: String) -> Void {
    if ArraySize(this.m_convaiChatTrace) < 16 { ArrayPush(this.m_convaiChatTrace, line); };
}
@addMethod(PlayerPuppet)
public final func ConvaiPhoneChatTakeTrace() -> String {
    if ArraySize(this.m_convaiChatTrace) == 0 { return ""; };
    let line = this.m_convaiChatTrace[0];
    ArrayErase(this.m_convaiChatTrace, 0);
    return line;
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
// Opening a character's chat puts the keyboard focus in the message box by itself, once per opening (ConvaiChatAutoFocus): armed when the
// chat page gets the focus, spent by the first attempt, and gone when the page loses the focus.
@addField(PhoneMessagePopupGameController)
private let m_convaiChatAutoFocus: Bool;
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
    // The native close hint stays, and shows the game's Esc key on a keyboard (Esc is what closes the chat here, 30 Oct: it read C).
    inkWidgetRef.SetVisible(this.m_hintClose, true);
    this.ConvaiChatCloseKey();
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

// The close hint of an AI chat shows Esc on a keyboard: every hint of the page bound to the game's cancel action (C) is rebound to the pause-menu action, whose key is Esc.
// The trace says what was found, once per opening. A pad keeps the game's own key.
@addMethod(PhoneMessagePopupGameController)
private final func ConvaiChatCloseKey() -> Void {
    let player = this.m_player as PlayerPuppet;
    if !IsDefined(player) || !player.PlayerLastUsedKBM() { return; };
    inkWidgetRef.SetVisible(this.m_hintClose, true);
    let changed = ConvaiHintBinding.CloseToEsc(this.GetRootWidget(), 8);
    if changed == 0 { changed = ConvaiHintBinding.CloseToEsc(inkWidgetRef.Get(this.m_hintClose), 4); };
    if changed == 0 { player.ConvaiPhoneChatTrace("close hint: no cancel hint found on the chat page; hints: " + StrMid(ConvaiHintBinding.Describe(this.GetRootWidget(), 8), 0, 150)); };
}

@wrapMethod(PhoneMessagePopupGameController)
private func SetFocus(isFocused: Bool) -> Void {
    if !isFocused { this.ConvaiChatSaveDraft(); this.ConvaiChatBlur(); };
    wrappedMethod(isFocused);
    // The game may draw its close hint again when the page gains or loses the focus: in an AI chat it names Esc every time.
    if this.m_data.convaiChat { this.ConvaiChatCloseKey(); };
    this.m_convaiChatEscape = false;
    this.m_convaiChatAutoFocus = isFocused && this.m_data.convaiChat;
    let player = this.m_player as PlayerPuppet;
    if IsDefined(player) && this.m_data.convaiChat {
        if isFocused { player.m_convaiChatView = this; }
        else { if player.m_convaiChatView == this { player.m_convaiChatView = null; }; };
        if isFocused {
            this.ConvaiChatCreate();
            player.ConvaiPhoneChatTrace("page focused contact=" + this.m_convaiChatId);
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

// Seconds of the engine clock (it does not slow with the phone's time dilation).
@addMethod(PhoneMessagePopupGameController)
public final func ConvaiChatNow() -> Float {
    return EngineTime.ToFloat(GameInstance.GetEngineTime(this.m_player.GetGame()));
}

// The first paint of an open chat that can be written to puts the focus in the message box, as the Enter key does, so the player types at once.
// Only on the chat page itself (m_isFocused: never on the Chat list, where J, L and V belong to the rows), only for a keyboard and mouse player (a
// pad has no Esc to leave a box that swallows every action), and only once per opening: after Esc has stopped the typing the page waits for Enter as
// before, and a second Esc closes the chat. The Enter that opened the chat may still be down, so no Enter sends for the first half second.
// Called from the paint Lua asks for (ConvaiChatPresent), never per frame.
@if(ModuleExists("Codeware.UI.TextInput"))
@addMethod(PhoneMessagePopupGameController)
private final func ConvaiChatAutoFocus() -> Void {
    if !this.m_convaiChatAutoFocus { return; };
    if !this.m_data.convaiChat || !this.m_isFocused || !this.m_convaiChatEnabled || !IsDefined(this.m_convaiChatInput) { return; };
    this.m_convaiChatAutoFocus = false;
    let player = this.m_player as PlayerPuppet;
    if this.m_convaiChatInput.IsFocused() || !this.m_phoneSystem.IsTextingEnabled() || !this.m_player.PlayerLastUsedKBM() {
        if IsDefined(player) { player.ConvaiPhoneChatTrace("autofocus skipped contact=" + this.m_convaiChatId + (this.m_convaiChatInput.IsFocused() ? " (already typing)" : this.m_phoneSystem.IsTextingEnabled() ? " (pad)" : " (texting off)")); };
        return;
    };
    this.m_convaiChatInput.GuardEnter(0.5);
    this.RequestSetFocus(this.m_convaiChatInput.GetRootWidget());
    this.m_dialogViewController.ConvaiChatScroll();
    if IsDefined(player) { player.ConvaiPhoneChatTrace("autofocus asked contact=" + this.m_convaiChatId); };
}

@if(!ModuleExists("Codeware.UI.TextInput"))
@addMethod(PhoneMessagePopupGameController)
private final func ConvaiChatAutoFocus() -> Void {
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
    this.ConvaiChatAutoFocus();
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
    // The row is recycled by the list: the picture slot is hidden first, so a text-only line never shows the picture of an earlier one.
    inkImageRef.SetVisible(this.m_image, false);
    // The third string of SetMessageView is the contact's name (the game's own rows pass it and never show it), not a picture.
    this.SetMessageView(line.text, line.sent ? MessageViewType.Sent : MessageViewType.Received, "");
    if StrLen(line.imageAtlas) > 0 && StrLen(line.imagePart) > 0 { this.ConvaiChatShowImage(line); };
}

// The game's message row has a picture slot under the text (`photo`, 450 x 450, it is in the same panel as the text, so the bubble grows with it).
// The picture is set once, when the row is built from the line, never per frame. The frame keeps the picture's shape inside 450 wide and 600 tall.
// An atlas that is not there (the optional picture archive is not installed) leaves the slot empty and the row as a text line.
@addMethod(MessangerItemRenderer)
private final func ConvaiChatShowImage(line: ref<ConvaiPhoneChatLine>) -> Void {
    let image = inkImageRef.Get(this.m_image) as inkImage;
    if !IsDefined(image) { return; };
    let width = Cast<Float>(line.imageWidth);
    let height = Cast<Float>(line.imageHeight);
    if width < 1.0 || height < 1.0 { width = 450.0; height = 450.0; };
    let scale = MinF(450.0 / width, 600.0 / height);
    image.SetAtlasResource(ResRef.FromString(line.imageAtlas));
    image.SetTexturePart(StringToName(line.imagePart));
    image.SetFitToContent(false);
    image.SetSize(new Vector2(width * scale, height * scale));
    image.SetVisible(true);
}
