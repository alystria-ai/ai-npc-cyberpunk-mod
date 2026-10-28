module CyberpunkConvai

// Eddies between V and the characters (docs/EDDIES.md, mod/eddies.lua): the confirmation pop-up. The game's own Yes/No message box
// (GenericMessageNotification, the one the game uses for its own questions) on the notifications layer, like the text composer
// (Composer.reds). CET asks for it once per proposal and reads the answer on its tick while the box is open; no eddies move here: Lua
// moves them after a Yes, with every check made again. Nothing runs while no box is open.

@addField(PlayerPuppet)
private let m_convaiEddiesToken: ref<inkGameNotificationToken>;

// 0 while no answer is known (or no box was opened), 1 Yes, 2 any other close (No, Esc, the box went away).
@addField(PlayerPuppet)
private let m_convaiEddiesAnswer: Int32;

@addMethod(PlayerPuppet)
public final func ConvaiEddiesAsk(title: String, message: String) -> Bool {
    if IsDefined(this.m_convaiEddiesToken) {
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
    this.m_convaiEddiesAnswer = 0;
    this.m_convaiEddiesToken = GenericMessageNotification.Show(controller, title, message, GenericMessageNotificationType.YesNo);
    if !IsDefined(this.m_convaiEddiesToken) {
        return false;
    };
    this.m_convaiEddiesToken.RegisterListener(this, n"OnConvaiEddiesClosed");
    return true;
}

@addMethod(PlayerPuppet)
protected cb func OnConvaiEddiesClosed(data: ref<inkGameNotificationData>) -> Bool {
    let result = data as GenericMessageNotificationCloseData;
    this.m_convaiEddiesToken = null;
    if IsDefined(result) && (Equals(result.result, GenericMessageNotificationResult.Yes) || Equals(result.result, GenericMessageNotificationResult.Confirm)) {
        this.m_convaiEddiesAnswer = 1;
    } else {
        this.m_convaiEddiesAnswer = 2;
    };
    return true;
}

// The answer of the last box, read once: 0 none yet (or still open), 1 Yes, 2 No. Reading a 1 or 2 clears it.
@addMethod(PlayerPuppet)
public final func ConvaiEddiesAnswer() -> Int32 {
    let answer = this.m_convaiEddiesAnswer;
    if answer != 0 {
        this.m_convaiEddiesAnswer = 0;
    };
    return answer;
}

@addMethod(PlayerPuppet)
public final func ConvaiEddiesOpen() -> Bool {
    return IsDefined(this.m_convaiEddiesToken);
}
