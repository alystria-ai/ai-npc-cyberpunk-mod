module CyberpunkConvai

// YouTube on V's TV (docs/YOUTUBE_TV.md).
//
// A TV in one of V's homes (Megabuilding H10 and the four apartments V can buy) gets extra choices next to the game's own
// Turn on / Turn off and channel choices: "YouTube" opens the picker; while a video is open, "pause or play" and "stop".
// Everything else is in mod/youtube-tv.lua (which observes ConvaiYouTubeTvChoice) and the bridge (bridge/youtube-tv-host.mjs).
//
// Only TVControllerPS devices, only a direct interaction (never a quickhack or a remote request), only while the setting is on
// (mod/youtube-tv.lua sets the mode on the player), only inside V's homes (the district the game reports for the apartment), and
// only when the game itself offers Turn on / Turn off on that TV. The game's own choices are never changed or removed. The only
// change to the TV itself: picking YouTube turns the TV's own channel off, as the game's own Turn off would.
//
// Pattern: TV Mute Control (Nexus 14149) wraps MediaDeviceControllerPS.GetActions the same way; the game's sources
// (mediaDeviceController.script, tvController.script, baseDeviceActions.script) are quoted in docs/YOUTUBE_TV.md.

// 0: off (the setting is off or Lua has not started), 1: on, no video, 2: a video session is open.
@addField(PlayerPuppet)
private let m_convaiYouTubeTvMode: Int32;
// The choices' captions in the player's interface language: open, pause or play, stop.
@addField(PlayerPuppet)
private let m_convaiYouTubeTvLabels: array<String>;

@addMethod(PlayerPuppet)
public final func ConvaiYouTubeTvSetMode(mode: Int32) -> Void {
    this.m_convaiYouTubeTvMode = mode < 0 || mode > 2 ? 0 : mode;
}

@addMethod(PlayerPuppet)
public final func ConvaiYouTubeTvMode() -> Int32 {
    return this.m_convaiYouTubeTvMode;
}

@addMethod(PlayerPuppet)
public final func ConvaiYouTubeTvSetLabels(open: String, toggle: String, stop: String) -> Void {
    ArrayClear(this.m_convaiYouTubeTvLabels);
    ArrayPush(this.m_convaiYouTubeTvLabels, open);
    ArrayPush(this.m_convaiYouTubeTvLabels, toggle);
    ArrayPush(this.m_convaiYouTubeTvLabels, stop);
}

@addMethod(PlayerPuppet)
public final func ConvaiYouTubeTvLabel(index: Int32, fallback: String) -> String {
    if index >= 0 && index < ArraySize(this.m_convaiYouTubeTvLabels) && StrLen(this.m_convaiYouTubeTvLabels[index]) > 0 {
        return this.m_convaiYouTubeTvLabels[index];
    };
    return fallback;
}

// The event mod/youtube-tv.lua observes (ObserveAfter): "open", "toggle" or "stop". Nothing else happens here.
@addMethod(PlayerPuppet)
public final func ConvaiYouTubeTvChoice(choice: String) -> Void {}

// V's homes: the district records the game gives each of V's flats (gamedataDistrict names, final.redscripts 2.3).
public static func ConvaiYouTubeTvIsHomeDistrict(name: String) -> Bool {
    return Equals(name, "LittleChina_VApartment") || Equals(name, "Northside_Apartment") || Equals(name, "JapanTown_Apartment")
        || Equals(name, "Glen_Apartment") || Equals(name, "CorpoPlaza_Apartment");
}

// The game keeps the districts V is inside as a stack: a trigger volume pushes its district when V enters it and pops it when V
// leaves, and PreventionSystem.GetCurrentDistrict() answers only the top. The stack is not saved, so after a load inside a flat the
// events can arrive in any order and the top can be the street district (seen in the Corpo Plaza flat: Downtown). The apartment's
// own entry is still somewhere in the stack, so the whole stack is read: the name of V's home district, or "" outside V's homes.
@addMethod(DistrictManager)
public final func ConvaiHomeDistrict() -> String {
    let i = ArraySize(this.m_stack) - 1;
    while i >= 0 {
        let district = this.m_stack[i];
        let record = IsDefined(district) ? district.GetDistrictRecord() : null;
        if IsDefined(record) && ConvaiYouTubeTvIsHomeDistrict(record.EnumName()) { return record.EnumName(); };
        i -= 1;
    };
    return "";
}

// Read on demand only (a TV's choices being built, the once-a-second check while a video is open); never per frame.
@addMethod(PreventionSystem)
public final func ConvaiHomeDistrict() -> String {
    if !IsDefined(this.m_districtManager) { return ""; };
    return this.m_districtManager.ConvaiHomeDistrict();
}

public static func ConvaiYouTubeTvAtHome(game: GameInstance) -> Bool {
    let prevention = GameInstance.GetScriptableSystemsContainer(game).Get(n"PreventionSystem") as PreventionSystem;
    return IsDefined(prevention) && StrLen(prevention.ConvaiHomeDistrict()) > 0;
}

public class ConvaiYouTubeTvAction extends ActionBool {
    // "open", "toggle" or "stop".
    public let m_convaiChoice: String;

    public final func SetProperties(choice: String) -> Void {
        this.m_convaiChoice = choice;
        this.actionName = StringToName("ConvaiYouTubeTv_" + choice);
        this.prop = DeviceActionPropertyFunctions.SetUpProperty_Bool(this.actionName, true, this.actionName, this.actionName);
    }

    // An existing interaction record of the TV (its own "Next" choice) gives the choice its input and layout; the caption is ours.
    public func GetTweakDBChoiceRecord() -> String {
        return "Next";
    }

    public final func SetConvaiCaption(caption: String) -> Void {
        this.interactionChoice.caption = caption;
        InteractionChoiceCaption.Clear(this.interactionChoice.captionParts);
        InteractionChoiceCaption.AddTextPart(this.interactionChoice.captionParts, caption);
    }
}

@addMethod(TVControllerPS)
public final func ActionConvaiYouTubeTv(choice: String, caption: String) -> ref<ConvaiYouTubeTvAction> {
    let action = new ConvaiYouTubeTvAction();
    action.clearanceLevel = DefaultActionsParametersHolder.GetInteractiveClearance();
    action.SetUp(this);
    action.SetProperties(choice);
    action.AddDeviceName(this.m_deviceName);
    action.CreateActionWidgetPackage();
    action.CreateInteraction();
    action.SetConvaiCaption(caption);
    return action;
}

@addMethod(TVControllerPS)
public final func OnConvaiYouTubeTvAction(evt: ref<ConvaiYouTubeTvAction>) -> EntityNotificationType {
    let player = GetPlayer(this.GetGameInstance());
    if IsDefined(player) { player.ConvaiYouTubeTvChoice(evt.m_convaiChoice); };
    // The TV's own channel goes off while YouTube plays, as the game's own Turn off would do it.
    if Equals(evt.m_convaiChoice, "open") && this.IsON() {
        this.SetDeviceState(EDeviceStatus.OFF);
        let notifier = new ActionNotifier();
        notifier.SetNone();
        this.Notify(notifier, evt);
        return EntityNotificationType.SendThisEventToEntity;
    };
    return EntityNotificationType.DoNotNotifyEntity;
}

@addMethod(TV)
protected cb func OnConvaiYouTubeTvAction(evt: ref<ConvaiYouTubeTvAction>) -> Bool {
    if !this.GetDevicePS().IsON() { this.TurnOffDevice(); };
}

@wrapMethod(MediaDeviceControllerPS)
public func GetActions(out actions: array<ref<DeviceAction>>, context: GetActionsContext) -> Bool {
    let result = wrappedMethod(actions, context);
    // Only where the game itself offers choices on this TV (a TV it keeps non-interactive stays that way).
    let tv = this as TVControllerPS;
    if !result || !IsDefined(tv) || NotEquals(context.requestType, gamedeviceRequestType.Direct) { return result; };
    let game = this.GetGameInstance();
    let player = GetPlayer(game);
    if !IsDefined(player) { return result; };
    let mode = player.ConvaiYouTubeTvMode();
    if mode == 0 || !ToggleON.IsDefaultConditionMet(this, context) || !ConvaiYouTubeTvAtHome(game) { return result; };
    if mode == 2 {
        ArrayPush(actions, tv.ActionConvaiYouTubeTv("toggle", player.ConvaiYouTubeTvLabel(1, "YouTube: pause or play")));
        ArrayPush(actions, tv.ActionConvaiYouTubeTv("stop", player.ConvaiYouTubeTvLabel(2, "YouTube: stop")));
    };
    ArrayPush(actions, tv.ActionConvaiYouTubeTv("open", player.ConvaiYouTubeTvLabel(0, "YouTube")));
    return true;
}
