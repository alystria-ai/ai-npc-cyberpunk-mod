module CyberpunkConvai

@if(ModuleExists("Codeware.UI"))
import Codeware.UI.*

// Movement-key tracker. A movement key that is released while a popup owns input
// never reaches gameplay, so V would keep walking after the popup closes. The game
// delivers MoveX and MoveY (keyboard A/D and W/S plus the gamepad left stick, see
// r6/config/inputContexts.xml "MovementActions") to input listeners only when the
// axis value changes, so this object does no work while the player stands still or
// holds a steady direction. It stores the two latest values and nothing else.
public class ConvaiMoveWatch {
    private let x: Float;
    private let y: Float;

    protected cb func OnAction(action: ListenerAction, consumer: ListenerActionConsumer) -> Bool {
        let name: CName = ListenerAction.GetName(action);
        if Equals(name, n"MoveX") {
            this.x = ListenerAction.GetValue(action);
        } else {
            if Equals(name, n"MoveY") {
                this.y = ListenerAction.GetValue(action);
            };
        };
        return false;
    }

    public final func IsHeld() -> Bool {
        return AbsF(this.x) > 0.15 || AbsF(this.y) > 0.15;
    }

    public final func Forget() -> Void {
        this.x = 0.0;
        this.y = 0.0;
    }
}

@addField(PlayerPuppet)
private let m_convaiMoveWatch: ref<ConvaiMoveWatch>;

@addMethod(PlayerPuppet)
public final func ConvaiMoveWatchStart() -> Void {
    if IsDefined(this.m_convaiMoveWatch) {
        return;
    };
    this.m_convaiMoveWatch = new ConvaiMoveWatch();
    this.RegisterInputListener(this.m_convaiMoveWatch, n"MoveX");
    this.RegisterInputListener(this.m_convaiMoveWatch, n"MoveY");
}

@wrapMethod(PlayerPuppet)
protected cb func OnGameAttached() -> Bool {
    let result: Bool = wrappedMethod();
    this.ConvaiMoveWatchStart();
    return result;
}

@wrapMethod(PlayerPuppet)
protected cb func OnDetach() -> Bool {
    if IsDefined(this.m_convaiMoveWatch) {
        this.UnregisterInputListener(this.m_convaiMoveWatch);
        this.m_convaiMoveWatch = null;
    };
    return wrappedMethod();
}

// True while a movement axis is held away from centre, as far as the game has
// reported. A movement key released while a menu or popup owned input is never
// reported, so this can read held until the next movement event.
@addMethod(PlayerPuppet)
public final func ConvaiMoveHeld() -> Bool {
    return IsDefined(this.m_convaiMoveWatch) && this.m_convaiMoveWatch.IsHeld();
}

// Gives up on a held reading that did not clear (an unseen key-up), so the next
// talk request is not delayed by it.
@addMethod(PlayerPuppet)
public final func ConvaiMoveForget() -> Void {
    if IsDefined(this.m_convaiMoveWatch) {
        this.m_convaiMoveWatch.Forget();
    };
}

// The game owns keyboard focus and the textbox. CET only asks this controller
// to open the composer and collects the result after it closes.
@addField(PlayerPuppet)
private let m_convaiComposerToken: ref<inkGameNotificationToken>;

@addField(PlayerPuppet)
private let m_convaiSubmittedText: String;

@addField(PlayerPuppet)
private let m_convaiSubmissionReady: Bool;

// How the last text box closed, for probe.log (mod/init.lua convaiComposerWatch): "confirm" (a message), "empty" (Enter on an empty
// box), "closed:<n>" (any other result, n = the game's GenericMessageNotificationResult number; Esc is a cancel) or "nodata" (closed
// without a result). Written once per box, read once per box when it closes without a message.
@addField(PlayerPuppet)
private let m_convaiCloseInfo: String;

@if(ModuleExists("Codeware.UI"))
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
    this.m_convaiCloseInfo = "";
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

@if(ModuleExists("Codeware.UI"))
@addMethod(PlayerPuppet)
protected cb func OnConvaiComposerClosed(data: ref<inkGameNotificationData>) -> Bool {
    let result = data as GenericMessageNotificationCloseData;
    this.m_convaiComposerToken = null;
    if !IsDefined(result) {
        this.m_convaiCloseInfo = "nodata";
        return true;
    };
    if Equals(result.result, GenericMessageNotificationResult.Confirm) {
        if StrLen(result.input) > 0 {
            this.m_convaiSubmittedText = result.input;
            this.m_convaiSubmissionReady = true;
            this.m_convaiCloseInfo = "confirm";
        } else {
            this.m_convaiCloseInfo = "empty";
        };
    } else {
        this.m_convaiCloseInfo = "closed:" + IntToString(EnumInt(result.result));
    };
    return true;
}

// Without Codeware's text input box this mod's scripts still compile (a compile error would disable every redscript mod): the box
// cannot open, so the request is refused and mod/setup-check.lua tells the player Codeware is missing.
@if(!ModuleExists("Codeware.UI"))
@addMethod(PlayerPuppet)
public final func ConvaiOpenComposer(characterName: String) -> Bool {
    return false;
}

@addMethod(PlayerPuppet)
public final func ConvaiComposerClosedInfo() -> String {
    return this.m_convaiCloseInfo;
}

@addMethod(PlayerPuppet)
public final func ConvaiHasSubmission() -> Bool {
    return this.m_convaiSubmissionReady;
}

@addMethod(PlayerPuppet)
public final func ConvaiComposerOpen() -> Bool {
    return IsDefined(this.m_convaiComposerToken);
}

// The per-frame world facts onUpdate asks for, in one call instead of eleven. A bit mask, the same answers the separate calls give:
//   1 attached, 2 dead, 4 pre-game (the main menu), 8 game paused, 16 in a menu, 32 composer open, 64 phone open.
// mod/init.lua reads it once per frame (convaiSessionReady) and falls back to the separate calls when this method is missing.
@addMethod(PlayerPuppet)
public final func ConvaiFrameFlags() -> Int32 {
    let flags: Int32 = 0;
    if this.IsAttached() { flags += 1; };
    if this.IsDeadNoStatPool() { flags += 2; };
    let requests: wref<inkISystemRequestsHandler> = GameInstance.GetSystemRequestsHandler();
    if requests.IsPreGame() { flags += 4; };
    if requests.IsGamePaused() { flags += 8; };
    let defs = GetAllBlackboardDefs();
    if GameInstance.GetBlackboardSystem(this.GetGame()).Get(defs.UI_System).GetBool(defs.UI_System.IsInMenu) { flags += 16; };
    if this.ConvaiComposerOpen() { flags += 32; };
    if this.ConvaiPhoneIsOpen() { flags += 64; };
    return flags;
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
