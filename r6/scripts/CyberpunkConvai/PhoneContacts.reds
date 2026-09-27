module CyberpunkConvai

// Native vector widgets share the phone palette without a texture dependency.
public class ConvaiPhoneArtwork {
    private static func Place(widget: ref<inkWidget>, parent: ref<inkCompoundWidget>, x: Float, y: Float, width: Float, height: Float) -> Void {
        widget.SetSize(new Vector2(width, height));
        widget.SetMargin(new inkMargin(x, y, 0.0, 0.0));
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
        action.SetSize(new Vector2(82.0, 46.0));
        action.SetMargin(new inkMargin(4.0, 0.0, 4.0, 0.0));
        action.SetAffectsLayoutWhenHidden(false);
        action.SetVisible(false);
        action.SetInteractive(true);
        // Outlined keycap followed by a person with a small plus/minus badge.
        ConvaiPhoneArtwork.Bar(action, 1.0, 7.0, 28.0, 2.0);
        ConvaiPhoneArtwork.Bar(action, 1.0, 37.0, 28.0, 2.0);
        ConvaiPhoneArtwork.Bar(action, 1.0, 9.0, 2.0, 28.0);
        ConvaiPhoneArtwork.Bar(action, 27.0, 9.0, 2.0, 28.0);
        ConvaiPhoneArtwork.Bar(action, 8.0, 22.0, 14.0, 2.0);
        if join {
            ConvaiPhoneArtwork.Bar(action, 14.0, 16.0, 2.0, 14.0);
        };
        ConvaiPhoneArtwork.Place(new inkCircle(), action, 45.0, 8.0, 12.0, 12.0);
        ConvaiPhoneArtwork.Place(new inkCircle(), action, 39.0, 23.0, 24.0, 15.0);
        ConvaiPhoneArtwork.Bar(action, 41.0, 30.0, 20.0, 8.0);
        ConvaiPhoneArtwork.Bar(action, 65.0, 21.0, 14.0, 3.0);
        if join {
            ConvaiPhoneArtwork.Bar(action, 70.5, 15.5, 3.0, 14.0);
        };
        return action;
    }
}

@addMethod(PhoneDialerLogicController)
public final func ConvaiSelectedCompanionAction(join: Bool) -> Void {
    if NotEquals(this.m_currentTab, PhoneDialerTabs.Contacts) || !IsDefined(this.m_listController) {
        return;
    };
    let item: ref<PhoneContactItemVirtualController> = this.m_listController.GetSelectedItem() as PhoneContactItemVirtualController;
    if IsDefined(item) {
        item.ConvaiRequestCompanion(join);
    };
}

// Scope raw key callbacks to the same lifetime as the native contact inputs.
// Reopening cannot accumulate listeners, and Messages never triggers a spawn.
@addField(NewHudPhoneGameController)
private let m_convaiPhoneKeys: ref<CallbackSystemHandler>;

@wrapMethod(NewHudPhoneGameController)
public func EnableContactsInput() -> Void {
    wrappedMethod();
    this.ConvaiStopPhoneKeys();
    this.m_convaiPhoneKeys = GameInstance.GetCallbackSystem()
        .RegisterCallback(n"Input/Key", this, n"OnConvaiPhoneKey")
        .AddTarget(InputTarget.Key(EInputKey.IK_Equals, EInputAction.IACT_Press))
        .AddTarget(InputTarget.Key(EInputKey.IK_Minus, EInputAction.IACT_Press))
        .AddTarget(InputTarget.Key(EInputKey.IK_NumPlus, EInputAction.IACT_Press))
        .AddTarget(InputTarget.Key(EInputKey.IK_NumMinus, EInputAction.IACT_Press));
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
    wrappedMethod();
}

@wrapMethod(NewHudPhoneGameController)
protected cb func OnUninitialize() -> Bool {
    this.ConvaiStopPhoneKeys();
    return wrappedMethod();
}

@addMethod(NewHudPhoneGameController)
private cb func OnConvaiPhoneKey(evt: ref<KeyInputEvent>) -> Void {
    if !IsDefined(this.m_convaiPhoneKeys) || NotEquals(this.m_screenType, PhoneScreenType.Contacts)
        || this.m_threadsVisible || this.m_messagesPanelVisible
        || evt.IsControlDown() || evt.IsAltDown() || !IsDefined(this.m_contactListLogicController) {
        return;
    };
    this.m_contactListLogicController.ConvaiSelectedCompanionAction(
        Equals(evt.GetKey(), EInputKey.IK_Equals) || Equals(evt.GetKey(), EInputKey.IK_NumPlus));
}

// Each virtual contact row is recycled by the game's phone list. Keep the
// controls on the row controller and refresh visibility whenever its data moves.
@addField(PhoneContactItemVirtualController)
private let m_convaiJoin: wref<inkCanvas>;

@addField(PhoneContactItemVirtualController)
private let m_convaiLeave: wref<inkCanvas>;

@addField(PhoneContactItemVirtualController)
private let m_convaiSelected: Bool;

@addMethod(PhoneContactItemVirtualController)
private final func ConvaiContactKey() -> String {
    let contact: ref<ContactData> = this.GetContactData();
    if !IsDefined(contact) || NotEquals(contact.type, MessengerContactType.Contact) {
        return "";
    };
    switch contact.id {
        case "judy": return "judy-alvarez";
        case "panam": return "panam-palmer";
        case "victor_vector": return "viktor-vektor";
        case "misty": return "misty-olszewski";
    };
    return "";
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
    action.RegisterToCallback(n"OnRelease", this, n"OnConvaiPhoneAction");
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
    this.m_convaiSelected = this.IsSelected();
    let eligible: Bool = StrLen(this.ConvaiContactKey()) > 0;
    if IsDefined(this.m_convaiJoin) {
        this.m_convaiJoin.SetVisible(eligible && this.m_convaiSelected);
    };
    if IsDefined(this.m_convaiLeave) {
        this.m_convaiLeave.SetVisible(eligible && this.m_convaiSelected);
    };
    return result;
}

@wrapMethod(PhoneContactItemVirtualController)
protected cb func OnSelected(itemController: wref<inkVirtualCompoundItemController>, discreteNav: Bool) -> Bool {
    let result: Bool = wrappedMethod(itemController, discreteNav);
    this.m_convaiSelected = true;
    let eligible: Bool = StrLen(this.ConvaiContactKey()) > 0;
    if IsDefined(this.m_convaiJoin) {
        this.m_convaiJoin.SetVisible(eligible);
    };
    if IsDefined(this.m_convaiLeave) {
        this.m_convaiLeave.SetVisible(eligible);
    };
    return result;
}

@wrapMethod(PhoneContactItemVirtualController)
protected cb func OnDeselected(itemController: wref<inkVirtualCompoundItemController>) -> Bool {
    let result: Bool = wrappedMethod(itemController);
    this.m_convaiSelected = false;
    if IsDefined(this.m_convaiJoin) {
        this.m_convaiJoin.SetVisible(false);
    };
    if IsDefined(this.m_convaiLeave) {
        this.m_convaiLeave.SetVisible(false);
    };
    return result;
}

@addMethod(PhoneContactItemVirtualController)
protected cb func OnConvaiPhoneAction(evt: ref<inkPointerEvent>) -> Bool {
    if !evt.IsAction(n"click") || !this.m_convaiSelected {
        return false;
    };
    let target: wref<inkWidget> = evt.GetCurrentTarget();
    if target != this.m_convaiJoin && target != this.m_convaiLeave {
        return false;
    };
    this.ConvaiRequestCompanion(target == this.m_convaiJoin);
    evt.Handle();
    return true;
}

@addMethod(PhoneContactItemVirtualController)
public final func ConvaiRequestCompanion(join: Bool) -> Bool {
    let key: String = this.ConvaiContactKey();
    let player: ref<PlayerPuppet> = GetPlayer(GetGameInstance()) as PlayerPuppet;
    if !this.m_convaiSelected || StrLen(key) == 0 || !IsDefined(player) {
        return false;
    };
    player.ConvaiPhoneQueue(key, join);
    return true;
}

@addField(PlayerPuppet)
private let m_convaiPhoneRequests: array<String>;

@addMethod(PlayerPuppet)
public final func ConvaiPhoneQueue(key: String, join: Bool) -> Void {
    if ArraySize(this.m_convaiPhoneRequests) < 8 {
        ArrayPush(this.m_convaiPhoneRequests, (join ? "+" : "-") + key);
    };
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
