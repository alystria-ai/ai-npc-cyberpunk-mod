module CyberpunkConvai

// Each virtual contact row is recycled by the game's phone list. Keep the
// controls on the row controller and refresh visibility whenever its data moves.
@addField(PhoneContactItemVirtualController)
private let m_convaiJoin: wref<inkText>;

@addField(PhoneContactItemVirtualController)
private let m_convaiLeave: wref<inkText>;

@addMethod(PhoneContactItemVirtualController)
private final func ConvaiContactKey() -> String {
    let contact: ref<ContactData> = this.GetContactData();
    if !IsDefined(contact) {
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
private final func ConvaiMakeContactAction(name: CName, label: String, rightMargin: Float) -> ref<inkText> {
    let row: ref<inkCompoundWidget> = this.GetRootWidget() as inkCompoundWidget;
    if !IsDefined(row) {
        return null;
    };
    let action: ref<inkText> = new inkText();
    action.SetName(name);
    action.SetText(label);
    action.SetFontFamily("base\\gameplay\\gui\\fonts\\raj\\raj.inkfontfamily");
    action.SetFontStyle(n"Semi-Bold");
    action.SetFontSize(28);
    action.SetSize(new Vector2(56.0, 46.0));
    action.SetAnchor(inkEAnchor.CenterRight);
    action.SetAnchorPoint(new Vector2(1.0, 0.5));
    action.SetMargin(new inkMargin(0.0, 0.0, rightMargin, 0.0));
    action.SetStyle(r"base\\gameplay\\gui\\common\\main_colors.inkstyle");
    action.BindProperty(n"tintColor", n"MainColors.Blue");
    action.SetInteractive(true);
    action.RegisterToCallback(n"OnRelease", this, n"OnConvaiPhoneAction");
    action.Reparent(row);
    return action;
}

@wrapMethod(PhoneContactItemVirtualController)
protected cb func OnDataChanged(value: Variant) -> Bool {
    let result: Bool = wrappedMethod(value);
    if !IsDefined(this.m_convaiJoin) {
        this.m_convaiJoin = this.ConvaiMakeContactAction(n"convaiJoin", "[+]", 180.0);
        this.m_convaiLeave = this.ConvaiMakeContactAction(n"convaiLeave", "[-]", 240.0);
    };
    let eligible: Bool = StrLen(this.ConvaiContactKey()) > 0;
    if IsDefined(this.m_convaiJoin) {
        this.m_convaiJoin.SetVisible(eligible);
    };
    if IsDefined(this.m_convaiLeave) {
        this.m_convaiLeave.SetVisible(eligible);
    };
    return result;
}

@addMethod(PhoneContactItemVirtualController)
protected cb func OnConvaiPhoneAction(evt: ref<inkPointerEvent>) -> Bool {
    if !evt.IsAction(n"click") {
        return false;
    };
    let key: String = this.ConvaiContactKey();
    let player: ref<PlayerPuppet> = GetPlayer(GetGameInstance()) as PlayerPuppet;
    if StrLen(key) == 0 || !IsDefined(player) {
        return false;
    };
    player.ConvaiPhoneQueue(key, evt.GetCurrentTarget() == this.m_convaiJoin);
    evt.Handle();
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
