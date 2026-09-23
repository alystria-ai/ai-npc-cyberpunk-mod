module CyberpunkConvai

import Codeware.UI.*

// The game owns keyboard focus and the textbox. CET only asks this controller
// to open the composer and collects the result after it closes.
@addField(PlayerPuppet)
private let m_convaiComposerToken: ref<inkGameNotificationToken>;

@addField(PlayerPuppet)
private let m_convaiSubmittedText: String;

@addField(PlayerPuppet)
private let m_convaiSubmissionReady: Bool;

@addMethod(PlayerPuppet)
public final func ConvaiOpenComposer(characterName: String) -> Bool {
    if IsDefined(this.m_convaiComposerToken) {
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

    this.m_convaiSubmissionReady = false;
    this.m_convaiSubmittedText = "";
    this.m_convaiComposerToken = GenericMessageNotification.ShowInput(
        controller,
        "TALK TO " + characterName,
        "Type your message to the character.",
        GenericMessageNotificationType.ConfirmCancel
    );
    if !IsDefined(this.m_convaiComposerToken) {
        return false;
    };
    this.m_convaiComposerToken.RegisterListener(this, n"OnConvaiComposerClosed");
    return true;
}

@addMethod(PlayerPuppet)
protected cb func OnConvaiComposerClosed(data: ref<inkGameNotificationData>) -> Bool {
    let result = data as GenericMessageNotificationCloseData;
    this.m_convaiComposerToken = null;
    if IsDefined(result) && Equals(result.result, GenericMessageNotificationResult.Confirm) {
        if StrLen(result.input) > 0 {
            this.m_convaiSubmittedText = result.input;
            this.m_convaiSubmissionReady = true;
        };
    };
    return true;
}

@addMethod(PlayerPuppet)
public final func ConvaiHasSubmission() -> Bool {
    return this.m_convaiSubmissionReady;
}

@addMethod(PlayerPuppet)
public final func ConvaiComposerOpen() -> Bool {
    return IsDefined(this.m_convaiComposerToken);
}

@addMethod(PlayerPuppet)
public final func ConvaiTakeSubmission() -> String {
    this.m_convaiSubmissionReady = false;
    let submitted = this.m_convaiSubmittedText;
    this.m_convaiSubmittedText = "";
    return submitted;
}

@addMethod(PlayerPuppet)
public final func ConvaiShowReply(speaker: String, reply: String) -> Void {
    let notification: SimpleScreenMessage;
    notification.isShown = true;
    notification.duration = 8.0;
    notification.message = speaker + ": " + reply;
    notification.type = SimpleMessageType.Neutral;
    GameInstance.GetBlackboardSystem(this.GetGame())
        .Get(GetAllBlackboardDefs().UI_Notifications)
        .SetVariant(GetAllBlackboardDefs().UI_Notifications.WarningMessage, ToVariant(notification), true);
}
