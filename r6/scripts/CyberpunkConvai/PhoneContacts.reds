module CyberpunkConvai

// Native vector widgets share the phone palette without a texture dependency.
public class ConvaiPhoneArtwork {
    private static func Place(widget: ref<inkWidget>, parent: ref<inkCompoundWidget>, x: Float, y: Float, width: Float, height: Float) -> Void {
        widget.SetSize(new Vector2(width, height));
        widget.SetMargin(new inkMargin(x, y, 0.0, 0.0));
        widget.SetHAlign(inkEHorizontalAlign.Left);
        widget.SetVAlign(inkEVerticalAlign.Top);
        widget.SetAnchor(inkEAnchor.TopLeft);
        widget.SetAnchorPoint(new Vector2(0.0, 0.0));
        widget.SetStyle(r"base\\gameplay\\gui\\common\\main_colors.inkstyle");
        widget.BindProperty(n"tintColor", n"MainColors.Blue");
        widget.SetInteractive(false);
        widget.Reparent(parent);
    }

    private static func Bar(parent: ref<inkCompoundWidget>, x: Float, y: Float, width: Float, height: Float) -> Void {
        ConvaiPhoneArtwork.Place(new inkRectangle(), parent, x, y, width, height);
    }

    public static func Make(name: CName, join: Bool) -> ref<inkCanvas> {
        let action: ref<inkCanvas> = new inkCanvas();
        action.SetName(name);
        action.SetSize(new Vector2(112.0, 64.0));
        action.SetVAlign(inkEVerticalAlign.Center);
        action.SetAffectsLayoutWhenHidden(false);
        action.SetVisible(false);
        action.SetInteractive(false);
        // Use the actual keyboard atlas at the native R/F hint dimensions.
        let key: ref<inkImage> = new inkImage();
        key.SetAtlasResource(r"base\\gameplay\\gui\\common\\input\\icons_keyboard.inkatlas");
        key.SetTexturePart(join ? n"kb_j" : n"kb_l");
        ConvaiPhoneArtwork.Place(key, action, 0.0, 0.0, 64.0, 64.0);
        ConvaiPhoneArtwork.Place(new inkCircle(), action, 74.0, 10.0, 15.0, 15.0);
        ConvaiPhoneArtwork.Place(new inkCircle(), action, 66.0, 29.0, 29.0, 19.0);
        ConvaiPhoneArtwork.Bar(action, 69.0, 38.0, 23.0, 12.0);
        ConvaiPhoneArtwork.Bar(action, 95.0, 25.0, 16.0, 3.0);
        if join {
            ConvaiPhoneArtwork.Bar(action, 101.5, 18.5, 3.0, 16.0);
        };
        return action;
    }
}

@addMethod(PhoneDialerLogicController)
public final func ConvaiSelectedCompanionAction(join: Bool) -> Bool {
    if NotEquals(this.m_currentTab, PhoneDialerTabs.Contacts) || !IsDefined(this.m_listController) {
        return false;
    };
    let item: ref<PhoneContactItemVirtualController> = this.m_listController.GetSelectedItem() as PhoneContactItemVirtualController;
    if IsDefined(item) {
        return item.ConvaiRequestCompanion(join);
    };
    return false;
}

// Scope raw key callbacks to the same lifetime as the native contact inputs.
// Reopening cannot accumulate listeners, and Messages never triggers a spawn.
@addField(NewHudPhoneGameController)
private let m_convaiPhoneKeys: ref<CallbackSystemHandler>;

@wrapMethod(NewHudPhoneGameController)
public func EnableContactsInput() -> Void {
    wrappedMethod();
    if IsDefined(this.m_player) {
        this.m_player.ConvaiPhoneSetOpen(true);
    };
    // Presses made while the list was not listening (before it opened, or
    // while a Chat conversation had focus) must not authorize repeats.
    ArrayClear(this.m_convaiPressedDirections);
    this.ConvaiStopPhoneKeys();
    this.m_convaiPhoneKeys = GameInstance.GetCallbackSystem()
        .RegisterCallback(n"Input/Key", this, n"OnConvaiPhoneKey")
        .AddTarget(InputTarget.Key(EInputKey.IK_J, EInputAction.IACT_Press))
        .AddTarget(InputTarget.Key(EInputKey.IK_L, EInputAction.IACT_Press));
}

@addMethod(NewHudPhoneGameController)
private final func ConvaiStopPhoneKeys() -> Void {
    if IsDefined(this.m_convaiPhoneKeys) {
        this.m_convaiPhoneKeys.Unregister();
        this.m_convaiPhoneKeys = null;
    };
}

@wrapMethod(NewHudPhoneGameController)
public func DisableContactsInput() -> Void {
    this.ConvaiStopPhoneKeys();
    ArrayClear(this.m_convaiPressedDirections);
    wrappedMethod();
}

// Native list navigation honours REPEAT from every held direction as soon as
// any phone action has been pressed: m_repeatingScrollActionEnabled is a single
// flag. It exists because the gamepad phone button, D-pad Down, is also
// popup_moveDown, so a direction held before the list opened keeps repeating
// into it. On keyboard W/S, Q/E and the arrows are gameplay keys too. A
// direction still held, or never seen released, when the phone opened starts
// repeating every 0.05 s on the first unrelated press (an arrow, S or the mouse
// wheel), and this list wraps (cycleNavigation), so the selection races through
// every contact. Repeat only a direction whose own press this list received.
@addField(NewHudPhoneGameController)
private let m_convaiPressedDirections: array<CName>;

@addMethod(NewHudPhoneGameController)
private final func ConvaiIsListDirection(name: CName) -> Bool {
    return Equals(name, n"popup_moveDown") || Equals(name, n"popup_moveUp")
        || Equals(name, n"popup_moveUp_left_stick_down") || Equals(name, n"popup_moveUp_left_stick_up");
}

@wrapMethod(NewHudPhoneGameController)
protected cb func OnContactListAction(action: ListenerAction, consumer: ListenerActionConsumer) -> Bool {
    let name: CName = ListenerAction.GetName(action);
    if this.ConvaiIsListDirection(name) && IsDefined(this.m_player) {
        let type: gameinputActionType = ListenerAction.GetType(action);
        if Equals(type, gameinputActionType.BUTTON_PRESSED) {
            if !ArrayContains(this.m_convaiPressedDirections, name) {
                ArrayPush(this.m_convaiPressedDirections, name);
            };
            this.m_player.ConvaiPhoneCountNavigation(0);
        } else {
            if Equals(type, gameinputActionType.BUTTON_RELEASED) {
                ArrayRemove(this.m_convaiPressedDirections, name);
            } else {
                if Equals(type, gameinputActionType.REPEAT) && this.m_repeatingScrollActionEnabled {
                    if !ArrayContains(this.m_convaiPressedDirections, name) {
                        this.m_player.ConvaiPhoneCountNavigation(2);
                        return false;
                    };
                    this.m_player.ConvaiPhoneCountNavigation(1);
                };
            };
        };
    };
    return wrappedMethod(action, consumer);
}

@wrapMethod(NewHudPhoneGameController)
protected cb func OnUninitialize() -> Bool {
    this.ConvaiStopPhoneKeys();
    if IsDefined(this.m_player) {
        this.m_player.ConvaiPhoneSetOpen(false);
    };
    return wrappedMethod();
}

@wrapMethod(NewHudPhoneGameController)
protected cb func OnContactListClosed() -> Bool {
    if IsDefined(this.m_player) {
        this.m_player.ConvaiPhoneSetOpen(false);
    };
    return wrappedMethod();
}

@addMethod(NewHudPhoneGameController)
private cb func OnConvaiPhoneKey(evt: ref<KeyInputEvent>) -> Void {
    if !IsDefined(this.m_convaiPhoneKeys) || NotEquals(this.m_screenType, PhoneScreenType.Contacts)
        || this.m_threadsVisible || this.m_messagesPanelVisible
        || evt.IsControlDown() || evt.IsAltDown() || !IsDefined(this.m_contactListLogicController) {
        return;
    };
    if this.m_contactListLogicController.ConvaiSelectedCompanionAction(Equals(evt.GetKey(), EInputKey.IK_J)) {
        this.m_audioSystem.Play(n"ui_phone_incoming_call_positive");
    };
}

// Each virtual contact row is recycled by the game's phone list. Keep the
// controls on the row controller and refresh visibility whenever its data moves.
@addField(PhoneContactItemVirtualController)
private let m_convaiJoin: wref<inkCanvas>;

@addField(PhoneContactItemVirtualController)
private let m_convaiLeave: wref<inkCanvas>;

@addField(PhoneContactItemVirtualController)
private let m_convaiSelected: Bool;

@addField(PhoneContactItemVirtualController)
private let m_convaiLabelWidth: Float;

@addField(PhoneContactItemVirtualController)
private let m_convaiFeedback: wref<inkText>;

// Immediate J/L confirmation in the selected row. The HUD notice cannot be it:
// the HUD "warning" entry is not visible in the ModalPopup game context that the
// open contact list pushes, so it can only appear after the phone closes. The
// line hangs from a zero-size canvas placed after the name in its vertical
// column: the column keeps its height, so the name, the fixed 1000x100 row and
// the list never move, and the line lines up under the name.
@addMethod(PhoneContactItemVirtualController)
private final func ConvaiShowActionFeedback(message: String) -> Void {
    if !IsDefined(this.m_convaiFeedback) {
        let label: wref<inkWidget> = inkWidgetRef.Get(this.m_label);
        let column: ref<inkCompoundWidget> = IsDefined(label) ? label.GetParentWidget() as inkCompoundWidget : null;
        if !IsDefined(column) {
            return;
        };
        let anchor: ref<inkCanvas> = new inkCanvas();
        anchor.SetName(n"convaiActionFeedbackAnchor");
        anchor.SetSize(new Vector2(0.0, 0.0));
        anchor.SetHAlign(inkEHorizontalAlign.Left);
        anchor.SetVAlign(inkEVerticalAlign.Top);
        anchor.SetInteractive(false);
        anchor.Reparent(column);
        let feedback: ref<inkText> = new inkText();
        feedback.SetName(n"convaiActionFeedback");
        feedback.SetFontFamily("base\\gameplay\\gui\\fonts\\raj\\raj.inkfontfamily");
        feedback.SetFontStyle(n"Medium");
        feedback.SetFontSize(22);
        feedback.SetSize(new Vector2(600.0, 26.0));
        // Start just inside the 66-unit name box, below the 50-point glyphs.
        feedback.SetMargin(new inkMargin(0.0, -9.0, 0.0, 0.0));
        feedback.SetHAlign(inkEHorizontalAlign.Left);
        feedback.SetVAlign(inkEVerticalAlign.Top);
        feedback.SetAnchor(inkEAnchor.TopLeft);
        feedback.SetAnchorPoint(new Vector2(0.0, 0.0));
        feedback.SetStyle(r"base\\gameplay\\gui\\common\\main_colors.inkstyle");
        feedback.BindProperty(n"tintColor", n"MainColors.Blue");
        feedback.SetInteractive(false);
        feedback.Reparent(anchor);
        this.m_convaiFeedback = feedback;
    };
    this.m_convaiFeedback.SetText(message);
    this.m_convaiFeedback.SetVisible(StrLen(message) > 0);
}

@addMethod(PhoneContactItemVirtualController)
private final func ConvaiLayoutActions(selected: Bool) -> Void {
    this.m_convaiSelected = selected;
    // Feedback belongs to one press on one contact; recycled rows start clean.
    if IsDefined(this.m_convaiFeedback) {
        this.m_convaiFeedback.SetVisible(false);
    };
    let visible: Bool = selected && StrLen(this.ConvaiContactKey()) > 0;
    let player: ref<PlayerPuppet> = GetPlayer(GetGameInstance()) as PlayerPuppet;
    let available: Bool = IsDefined(player) && player.ConvaiPhoneContactAvailable(this.ConvaiContactKey());
    let label: wref<inkWidget> = inkWidgetRef.Get(this.m_label);
    if IsDefined(label) {
        if this.m_convaiLabelWidth <= 0.0 {
            this.m_convaiLabelWidth = label.GetWidth();
        };
        // The native label has a fixed 600-unit width. Reserve two 112-unit
        // action cells, then restore its original width when the row is recycled.
        label.SetWidth(visible ? MaxF(1.0, this.m_convaiLabelWidth - 224.0) : this.m_convaiLabelWidth);
    };
    if IsDefined(this.m_convaiJoin) {
        this.m_convaiJoin.SetVisible(visible);
        this.m_convaiJoin.SetOpacity(available ? 1.0 : 0.3);
    };
    if IsDefined(this.m_convaiLeave) {
        this.m_convaiLeave.SetVisible(visible);
        this.m_convaiLeave.SetOpacity(available ? 1.0 : 0.3);
    };
}

@addMethod(PhoneContactItemVirtualController)
private final func ConvaiContactKey() -> String {
    let contact: ref<ContactData> = this.GetContactData();
    if !IsDefined(contact) || contact.convaiChat || NotEquals(contact.type, MessengerContactType.Contact) {
        return "";
    };
    return contact.id;
}

@addMethod(PhoneContactItemVirtualController)
private final func ConvaiMakeContactAction(name: CName, join: Bool, index: Int32) -> ref<inkCanvas> {
    let callHint: wref<inkWidget> = inkWidgetRef.Get(this.m_callInputHint);
    let row: ref<inkCompoundWidget> = IsDefined(callHint)
        ? callHint.GetParentWidget() as inkCompoundWidget
        : null;
    if !IsDefined(row) {
        return null;
    };
    let action: ref<inkCanvas> = ConvaiPhoneArtwork.Make(name, join);
    action.Reparent(row, index);
    return action;
}

@wrapMethod(PhoneContactItemVirtualController)
protected cb func OnDataChanged(value: Variant) -> Bool {
    let result: Bool = wrappedMethod(value);
    if !IsDefined(this.m_convaiJoin) {
        this.m_convaiJoin = this.ConvaiMakeContactAction(n"convaiJoin", true, 0);
    };
    if !IsDefined(this.m_convaiLeave) {
        this.m_convaiLeave = this.ConvaiMakeContactAction(n"convaiLeave", false, 1);
    };
    this.ConvaiLayoutActions(this.IsSelected());
    return result;
}

@wrapMethod(PhoneContactItemVirtualController)
protected cb func OnSelected(itemController: wref<inkVirtualCompoundItemController>, discreteNav: Bool) -> Bool {
    let result: Bool = wrappedMethod(itemController, discreteNav);
    this.ConvaiLayoutActions(true);
    return result;
}

@wrapMethod(PhoneContactItemVirtualController)
protected cb func OnDeselected(itemController: wref<inkVirtualCompoundItemController>) -> Bool {
    let result: Bool = wrappedMethod(itemController);
    this.ConvaiLayoutActions(false);
    return result;
}

@addMethod(PhoneContactItemVirtualController)
public final func ConvaiRequestCompanion(join: Bool) -> Bool {
    let key: String = this.ConvaiContactKey();
    let player: ref<PlayerPuppet> = GetPlayer(GetGameInstance()) as PlayerPuppet;
    if !this.m_convaiSelected || StrLen(key) == 0 || !IsDefined(player) {
        return false;
    };
    let accepted: Bool = player.ConvaiPhoneQueue(key, join);
    this.ConvaiShowActionFeedback(accepted
        ? (join ? "INVITE QUEUED - CLOSE PHONE" : "DISMISS QUEUED - CLOSE PHONE")
        : (player.ConvaiPhoneContactAvailable(key) ? "CLOSE PHONE TO CONTINUE" : "COMPANION UNAVAILABLE"));
    return accepted;
}

@addField(PlayerPuppet)
private let m_convaiPhoneRequests: array<String>;

@addField(PlayerPuppet)
private let m_convaiPhoneOpen: Bool;

// Per phone session: list presses, honoured repeats, and repeats ignored
// because their direction was never pressed inside the list.
@addField(PlayerPuppet)
private let m_convaiPhonePresses: Int32;

@addField(PlayerPuppet)
private let m_convaiPhoneRepeats: Int32;

@addField(PlayerPuppet)
private let m_convaiPhoneIgnoredRepeats: Int32;

@addMethod(PlayerPuppet)
public final func ConvaiPhoneSetOpen(open: Bool) -> Void {
    if open && !this.m_convaiPhoneOpen {
        this.m_convaiPhonePresses = 0;
        this.m_convaiPhoneRepeats = 0;
        this.m_convaiPhoneIgnoredRepeats = 0;
    };
    this.m_convaiPhoneOpen = open;
}

@addMethod(PlayerPuppet)
public final func ConvaiPhoneCountNavigation(kind: Int32) -> Void {
    if kind == 0 {
        this.m_convaiPhonePresses += 1;
    } else {
        if kind == 1 {
            this.m_convaiPhoneRepeats += 1;
        } else {
            this.m_convaiPhoneIgnoredRepeats += 1;
        };
    };
}

@addMethod(PlayerPuppet)
public final func ConvaiPhoneNavigationStats() -> String {
    if this.m_convaiPhonePresses + this.m_convaiPhoneRepeats + this.m_convaiPhoneIgnoredRepeats == 0 {
        return "";
    };
    return "presses=" + IntToString(this.m_convaiPhonePresses)
        + " repeats=" + IntToString(this.m_convaiPhoneRepeats)
        + " ignoredRepeats=" + IntToString(this.m_convaiPhoneIgnoredRepeats);
}

@addMethod(PlayerPuppet)
public final func ConvaiPhoneIsOpen() -> Bool {
    return this.m_convaiPhoneOpen;
}

@addField(PlayerPuppet)
private let m_convaiPhoneContactIds: array<String>;

@addField(PlayerPuppet)
private let m_convaiPhoneContactNames: array<String>;

@addField(PlayerPuppet)
private let m_convaiPhoneContactErrors: array<String>;

@addMethod(PlayerPuppet)
public final func ConvaiPhoneClearContacts() -> Void {
    ArrayClear(this.m_convaiPhoneContactIds);
    ArrayClear(this.m_convaiPhoneContactNames);
    ArrayClear(this.m_convaiPhoneContactErrors);
}

@addMethod(PlayerPuppet)
public final func ConvaiPhoneRegisterContact(id: String, name: String, reason: String) -> Void {
    ArrayPush(this.m_convaiPhoneContactIds, id);
    ArrayPush(this.m_convaiPhoneContactNames, name);
    ArrayPush(this.m_convaiPhoneContactErrors, reason);
}

@addMethod(PlayerPuppet)
public final func ConvaiPhoneContactAvailable(id: String) -> Bool {
    let index: Int32 = ArrayFindFirst(this.m_convaiPhoneContactIds, id);
    return index >= 0 && StrLen(this.m_convaiPhoneContactErrors[index]) == 0;
}

@addMethod(PlayerPuppet)
public final func ConvaiPhoneFeedback(message: String) -> Void {
    this.SetWarningMessage(message, SimpleMessageType.Neutral);
}

@addMethod(PlayerPuppet)
public final func ConvaiPhoneQueue(key: String, join: Bool) -> Bool {
    let index: Int32 = ArrayFindFirst(this.m_convaiPhoneContactIds, key);
    if index < 0 {
        this.ConvaiPhoneFeedback("This contact has no companion mapping yet.");
        return false;
    };
    if StrLen(this.m_convaiPhoneContactErrors[index]) > 0 {
        this.ConvaiPhoneFeedback(this.m_convaiPhoneContactErrors[index]);
        return false;
    };
    if ArraySize(this.m_convaiPhoneRequests) < 8 {
        ArrayPush(this.m_convaiPhoneRequests, (join ? "+" : "-") + key);
        this.ConvaiPhoneFeedback(this.m_convaiPhoneContactNames[index] + (join ? ": invite queued." : ": dismiss queued."));
        return true;
    };
    this.ConvaiPhoneFeedback("Close the phone to finish the pending companion requests.");
    return false;
}

@addMethod(PlayerPuppet)
public final func ConvaiPhoneTakeRequest() -> String {
    if ArraySize(this.m_convaiPhoneRequests) == 0 {
        return "";
    };
    let request: String = this.m_convaiPhoneRequests[0];
    ArrayErase(this.m_convaiPhoneRequests, 0);
    return request;
}
