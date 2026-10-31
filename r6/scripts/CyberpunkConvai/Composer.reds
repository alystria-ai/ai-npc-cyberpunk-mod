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
    // Movement events the game has reported so far. Evidence only (probe.log, convaiComposerWatch.moveEvidence): the difference between
    // a text box opening and closing says whether movement keys reached gameplay while it was up.
    private let events: Int32;

    protected cb func OnAction(action: ListenerAction, consumer: ListenerActionConsumer) -> Bool {
        let name: CName = ListenerAction.GetName(action);
        this.events += 1;
        if Equals(name, n"MoveX") {
            this.x = ListenerAction.GetValue(action);
        } else {
            if Equals(name, n"MoveY") {
                this.y = ListenerAction.GetValue(action);
            };
        };
        return false;
    }

    public final func Events() -> Int32 {
        return this.events;
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

// How many movement events the game has reported (0 when the tracker is not installed).
@addMethod(PlayerPuppet)
public final func ConvaiMoveEvents() -> Int32 {
    return IsDefined(this.m_convaiMoveWatch) ? this.m_convaiMoveWatch.Events() : 0;
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

// Which kind of box the token belongs to: "talk" (a message to a character, the default) or "search" (the Companion Manager's Search
// characters box). A search box shares the token, so every "a box is open" check holds for it too (the talk key does not open a second
// one), but its words go to m_convaiSearchText and never to m_convaiSubmittedText: nothing here can turn a search into a talk turn.
// The state is "" (nothing), "open", "confirm" (the words are in m_convaiSearchText) or "cancel"; mod/manager-ui.lua reads it while it waits.
@addField(PlayerPuppet)
private let m_convaiComposerMode: String;

@addField(PlayerPuppet)
private let m_convaiSearchState: String;

@addField(PlayerPuppet)
private let m_convaiSearchText: String;

// Words typed and not sent: the box closed any way but a send (Esc, the game closing it). m_convaiDraft holds them until the talk key opens
// the box again (mod/init.lua beginTextNow decides whether they fit: the same character, within a few minutes), and a send or an Enter on
// an empty box empties it. Only the box's own words are kept, nothing is shown.
@addField(PlayerPuppet)
private let m_convaiDraft: String;

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

    this.m_convaiComposerMode = "talk";
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

// The Companion Manager's Search characters box: the same native box, titled and marked as a search (mod/composer-input.lua shows it
// as "Search characters"). It takes no character and starts no conversation. Returns false when a box is already open or cannot open.
@if(ModuleExists("Codeware.UI"))
@addMethod(PlayerPuppet)
public final func ConvaiOpenSearchBox() -> Bool {
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

    this.m_convaiComposerMode = "search";
    this.m_convaiSearchState = "open";
    this.m_convaiSearchText = "";
    this.m_convaiComposerToken = GenericMessageNotification.ShowInput(
        controller,
        "Search characters",
        "Type part of a name.",
        GenericMessageNotificationType.ConfirmCancel
    );
    if !IsDefined(this.m_convaiComposerToken) {
        this.m_convaiSearchState = "";
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
    if Equals(this.m_convaiComposerMode, "search") {
        // A search box never touches the talk fields: Confirm keeps the words (an empty box clears the search), anything else is a cancel.
        if IsDefined(result) && Equals(result.result, GenericMessageNotificationResult.Confirm) {
            this.m_convaiSearchText = result.input;
            this.m_convaiSearchState = "confirm";
        } else {
            this.m_convaiSearchState = "cancel";
        };
        return true;
    };
    if !IsDefined(result) {
        this.m_convaiCloseInfo = "nodata";
        return true;
    };
    if Equals(result.result, GenericMessageNotificationResult.Confirm) {
        this.m_convaiDraft = "";
        if StrLen(result.input) > 0 {
            this.m_convaiSubmittedText = result.input;
            this.m_convaiSubmissionReady = true;
            this.m_convaiCloseInfo = "confirm";
        } else {
            this.m_convaiCloseInfo = "empty";
        };
    } else {
        // Esc or the game closing the box: what was typed stays for the next box.
        this.m_convaiDraft = result.input;
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

@if(!ModuleExists("Codeware.UI"))
@addMethod(PlayerPuppet)
public final func ConvaiOpenSearchBox() -> Bool {
    return false;
}

// "" (no search box), "open", "confirm" or "cancel". A search box that was confirmed or cancelled keeps its state until it is taken.
@addMethod(PlayerPuppet)
public final func ConvaiSearchBoxState() -> String {
    return this.m_convaiSearchState;
}

// The words of a confirmed search box, once; the state goes back to "". A "cancel" is cleared the same way.
@addMethod(PlayerPuppet)
public final func ConvaiTakeSearchText() -> String {
    let text = this.m_convaiSearchText;
    this.m_convaiSearchText = "";
    if !Equals(this.m_convaiSearchState, "open") {
        this.m_convaiSearchState = "";
    };
    return text;
}

// A search box that never showed (the notification layer did not draw it) is forgotten, so the talk key and the manager are not blocked by it.
@addMethod(PlayerPuppet)
public final func ConvaiForgetSearchBox() -> Void {
    if Equals(this.m_convaiComposerMode, "search") {
        this.m_convaiComposerToken = null;
        this.m_convaiSearchState = "";
        this.m_convaiSearchText = "";
    };
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

// The words the last box left unsent ("" when none).
@addMethod(PlayerPuppet)
public final func ConvaiDraftText() -> String {
    return this.m_convaiDraft;
}

// The kept words, once: the box that opens next shows them.
@addMethod(PlayerPuppet)
public final func ConvaiTakeDraft() -> String {
    let text = this.m_convaiDraft;
    this.m_convaiDraft = "";
    return text;
}

@addMethod(PlayerPuppet)
public final func ConvaiClearDraft() -> Void {
    this.m_convaiDraft = "";
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
