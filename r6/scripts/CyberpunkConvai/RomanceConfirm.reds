// The one question of the romance animations (docs/ROMANCE_ANIMATIONS.md): "Kiss Judy?" with the game's own message box, Confirm or Cancel.
// The box only reports how it closed; mod/init.lua (convaiRomanceAsk) opens it on a request and reads the state while it is open. Nothing here
// runs per frame: the box is opened once per request and the listener fires once when it closes.
//
// m_convaiAskState: "" (nothing), "open" (the box is up), "yes" (Confirm), "no" (Cancel, Esc, or any other close).
@addField(PlayerPuppet)
private let m_convaiAskToken: ref<inkGameNotificationToken>;

@addField(PlayerPuppet)
private let m_convaiAskState: String;

@addMethod(PlayerPuppet)
public final func ConvaiAskOpen(title: String, message: String) -> Bool {
    if IsDefined(this.m_convaiAskToken) {
        return false;
    };
    let layer = GameInstance.GetInkSystem().GetLayer(n"inkGameNotificationsLayer");
    if !IsDefined(layer) {
        return false;
    };
    let controller = layer.GetGameController() as worlduiIGameController;
    if !IsDefined(controller) {
        return false;
    };
    this.m_convaiAskState = "open";
    this.m_convaiAskToken = GenericMessageNotification.Show(controller, title, message, GenericMessageNotificationType.ConfirmCancel);
    if !IsDefined(this.m_convaiAskToken) {
        this.m_convaiAskState = "";
        return false;
    };
    this.m_convaiAskToken.RegisterListener(this, n"OnConvaiAskClosed");
    return true;
}

@addMethod(PlayerPuppet)
protected cb func OnConvaiAskClosed(data: ref<inkGameNotificationData>) -> Bool {
    let result = data as GenericMessageNotificationCloseData;
    this.m_convaiAskToken = null;
    if IsDefined(result) && Equals(result.result, GenericMessageNotificationResult.Confirm) {
        this.m_convaiAskState = "yes";
    } else {
        this.m_convaiAskState = "no";
    };
    return true;
}

@addMethod(PlayerPuppet)
public final func ConvaiAskState() -> String {
    return this.m_convaiAskState;
}

@addMethod(PlayerPuppet)
public final func ConvaiAskClear() -> Void {
    if !IsDefined(this.m_convaiAskToken) {
        this.m_convaiAskState = "";
    };
}
