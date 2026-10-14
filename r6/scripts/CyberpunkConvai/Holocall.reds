module CyberpunkConvai

// Holocalls with the mod's characters (docs/HOLOCALL.md).
//
// The game's own call path is never used: questTriggerCallRequest and PhoneSystem.TriggerCall write the quest fact
// phonecall_player_with_<contact> that quest graphs answer, and the UI_ComDevice.PhoneCallInformation blackboard is read
// by time skip, settings, the D-pad hints, the Sandevistan, scene fast-forward and the phone's own OnInitialize (which
// re-sends a call request). So no quest fact, no blackboard value and no PhoneSystem request is ever written here.
// Only the HUD's call window (HoloAudioCallLogicController, the top-left avatar with name and status) is driven, through
// the same controller methods the game's SetPhoneFunction calls.
//
// Quest calls always win: any call the game shows (OnPhoneCall with IncomingCall/StartCall) preempts the mod call
// before the game's handler runs, the game's handler always runs, and a mod call never starts while the game has one.
//
// A holocall starts from the phone's ordinary Contacts list: when V uses the game's own Call action on a contact that is
// one of the mod's characters (registered by mod/holocall.lua), the one function that would send the game's call request
// (NewHudPhoneGameController.CallSelectedContact, at the end of this file) is replaced by a holocall request. Every other
// contact reaches the game's own function untouched.

@addField(PlayerPuppet)
private let m_convaiHolocallHud: wref<NewHudPhoneGameController>;
// One pending request from the phone (a contact id), taken by mod/holocall.lua once the phone has closed.
@addField(PlayerPuppet)
private let m_convaiHolocallRequest: String;
// Call events for mod/holocall.lua: "hangup", "quest-call", "hud-lost". Bounded; read on the call's own 0.25 s tick.
@addField(PlayerPuppet)
private let m_convaiHolocallEvents: array<String>;
// The contact ids that can take a holocall, registered by mod/holocall.lua (the mod's own characters with a conversation
// profile, never Johnny). Any other contact is left to the game.
@addField(PlayerPuppet)
private let m_convaiHolocallContacts: array<String>;

@addMethod(PlayerPuppet)
public final func ConvaiHolocallAttachHud(hud: ref<NewHudPhoneGameController>) -> Void {
    this.m_convaiHolocallHud = hud;
}

@addMethod(PlayerPuppet)
public final func ConvaiHolocallDetachHud(hud: ref<NewHudPhoneGameController>) -> Void {
    if this.m_convaiHolocallHud == hud {
        this.m_convaiHolocallHud = null;
        this.ConvaiHolocallEvent("hud-lost");
    };
}

@addMethod(PlayerPuppet)
public final func ConvaiHolocallClearContacts() -> Void { ArrayClear(this.m_convaiHolocallContacts); }
@addMethod(PlayerPuppet)
public final func ConvaiHolocallRegisterContact(contact: String) -> Void { ArrayPush(this.m_convaiHolocallContacts, contact); }
@addMethod(PlayerPuppet)
public final func ConvaiHolocallHasContact(contact: String) -> Bool { return ArrayContains(this.m_convaiHolocallContacts, contact); }

@addMethod(PlayerPuppet)
public final func ConvaiHolocallEvent(name: String) -> Void {
    if ArraySize(this.m_convaiHolocallEvents) < 8 && !ArrayContains(this.m_convaiHolocallEvents, name) {
        ArrayPush(this.m_convaiHolocallEvents, name);
    };
}

@addMethod(PlayerPuppet)
public final func ConvaiHolocallTakeEvent() -> String {
    if ArraySize(this.m_convaiHolocallEvents) == 0 { return ""; };
    let name = this.m_convaiHolocallEvents[0];
    ArrayErase(this.m_convaiHolocallEvents, 0);
    return name;
}

// From the phone's Contacts list (the CallSelectedContact wrap below). Only a registered contact can be called. The phone
// closes; mod/holocall.lua starts the call once the world is playable.
@addMethod(PlayerPuppet)
public final func ConvaiHolocallRequest(contact: String) -> Bool {
    if StrLen(contact) == 0 || !this.ConvaiHolocallHasContact(contact) { return false; };
    this.m_convaiHolocallRequest = contact;
    let hud = this.m_convaiHolocallHud;
    if IsDefined(hud) { hud.ConvaiCallCloseContacts(); };
    return true;
}

@addMethod(PlayerPuppet)
public final func ConvaiHolocallTakeRequest() -> String {
    let contact = this.m_convaiHolocallRequest;
    this.m_convaiHolocallRequest = "";
    return contact;
}

// "ok", or why the call cannot start: "no-hud", "quest-call", "calling-disabled", "unknown-contact".
@addMethod(PlayerPuppet)
public final func ConvaiHolocallBegin(contact: String) -> String {
    let hud = this.m_convaiHolocallHud;
    if !IsDefined(hud) { return "no-hud"; };
    return hud.ConvaiCallBegin(contact);
}

// "audiocall" / "holocall" once the window shows the connected call, "pending" while the window is still being
// created, "ended" when the call is gone (preempted or the HUD was rebuilt).
@addMethod(PlayerPuppet)
public final func ConvaiHolocallConnect(live: Bool) -> String {
    let hud = this.m_convaiHolocallHud;
    if !IsDefined(hud) { return "ended"; };
    return hud.ConvaiCallConnect(live);
}

@addMethod(PlayerPuppet)
public final func ConvaiHolocallEnd() -> Void {
    let hud = this.m_convaiHolocallHud;
    if IsDefined(hud) { hud.ConvaiCallEnd(); };
}

@addMethod(PlayerPuppet)
public final func ConvaiHolocallActive() -> Bool {
    let hud = this.m_convaiHolocallHud;
    return IsDefined(hud) && hud.ConvaiCallActive();
}

@addField(NewHudPhoneGameController)
private let m_convaiCallActive: Bool;
@addField(NewHudPhoneGameController)
private let m_convaiCallContact: wref<JournalContact>;
@addField(NewHudPhoneGameController)
private let m_convaiCallWanted: EHudPhoneFunction;
@addField(NewHudPhoneGameController)
private let m_convaiCallPreempted: Bool;
@addField(NewHudPhoneGameController)
private let m_convaiCallPressed: Bool;
@addField(NewHudPhoneGameController)
private let m_convaiCallHeld: Bool;

@wrapMethod(NewHudPhoneGameController)
protected cb func OnInitialize() -> Bool {
    let result = wrappedMethod();
    if IsDefined(this.m_player) { this.m_player.ConvaiHolocallAttachHud(this); };
    return result;
}

@wrapMethod(NewHudPhoneGameController)
protected cb func OnUninitialize() -> Bool {
    if IsDefined(this.m_player) { this.m_player.ConvaiHolocallDetachHud(this); };
    this.m_convaiCallActive = false;
    return wrappedMethod();
}

@addMethod(NewHudPhoneGameController)
public final func ConvaiCallActive() -> Bool {
    return this.m_convaiCallActive && !this.m_convaiCallPreempted;
}

@addMethod(NewHudPhoneGameController)
public final func ConvaiCallCloseContacts() -> Void {
    this.CloseContactList();
}

@addMethod(NewHudPhoneGameController)
private final func ConvaiCallFindContact(id: String) -> wref<JournalContact> {
    let entries: array<wref<JournalEntry>>;
    let context: JournalRequestContext;
    context.stateFilter.active = true;
    this.m_journalMgr.GetContacts(context, entries);
    for entry in entries {
        let contact = entry as JournalContact;
        if IsDefined(contact) && Equals(contact.GetId(), id) && contact.IsKnown(this.m_journalMgr) { return contact; };
    };
    return null;
}

// The game's own call, ringing or connected, or any call the quest phone manager runs.
@addMethod(NewHudPhoneGameController)
private final func ConvaiCallGameBusy() -> Bool {
    let phase = this.m_CurrentCallInformation.callPhase;
    if Equals(phase, questPhoneCallPhase.IncomingCall) || Equals(phase, questPhoneCallPhase.StartCall) { return true; };
    if IsDefined(this.incomingCallElement.widget) { return true; };
    return IsDefined(this.m_player) && GameInstance.GetPhoneManager(this.m_player.GetGame()).IsPhoneCallActive();
}

@addMethod(NewHudPhoneGameController)
public final func ConvaiCallBegin(id: String) -> String {
    if this.ConvaiCallGameBusy() { return "quest-call"; };
    // A quest that blocks calls (or the phone being disabled) blocks this call too.
    if !IsDefined(this.m_PhoneSystem) || !this.m_PhoneSystem.IsCallingEnabled() { return "calling-disabled"; };
    let contact = this.ConvaiCallFindContact(id);
    if !IsDefined(contact) { return "unknown-contact"; };
    this.m_convaiCallActive = true;
    this.m_convaiCallPreempted = false;
    this.m_convaiCallPressed = false;
    this.m_convaiCallHeld = false;
    this.m_convaiCallContact = contact;
    this.m_convaiCallWanted = EHudPhoneFunction.IncomingCall;
    this.m_audioSystem.Play(n"ui_phone_initiation_call");
    this.ConvaiCallShow();
    return "ok";
}

@addMethod(NewHudPhoneGameController)
public final func ConvaiCallConnect(live: Bool) -> String {
    if !this.m_convaiCallActive || this.m_convaiCallPreempted { return "ended"; };
    let wanted = live ? EHudPhoneFunction.Holocall : EHudPhoneFunction.Audiocall;
    if NotEquals(this.m_convaiCallWanted, wanted) {
        if Equals(this.m_convaiCallWanted, EHudPhoneFunction.IncomingCall) {
            this.m_audioSystem.Play(n"ui_phone_initiation_call_stop");
            this.m_audioSystem.Play(n"ui_phone_incoming_call_positive");
        };
        this.m_convaiCallWanted = wanted;
    };
    this.ConvaiCallShow();
    if !IsDefined(this.m_holoAudioCallLogicController) { return "pending"; };
    return live ? "holocall" : "audiocall";
}

@addMethod(NewHudPhoneGameController)
public final func ConvaiCallEnd() -> Void {
    if !this.m_convaiCallActive { return; };
    let ringing = Equals(this.m_convaiCallWanted, EHudPhoneFunction.IncomingCall);
    this.m_convaiCallActive = false;
    this.m_convaiCallWanted = EHudPhoneFunction.Inactive;
    if this.m_convaiCallPreempted {
        // The game's call owns the window now; it closes it itself when that call ends.
        this.m_convaiCallPreempted = false;
        this.m_convaiCallContact = null;
        return;
    };
    this.m_audioSystem.Play(ringing ? n"ui_phone_initiation_call_stop" : n"ui_phone_incoming_call_stop");
    if IsDefined(this.holoAudioCallElement.request) && !IsDefined(this.holoAudioCallElement.widget) {
        this.holoAudioCallElement.request.Cancel();
    };
    if IsDefined(this.m_holoAudioCallLogicController) && IsDefined(this.m_convaiCallContact) {
        let avatar = this.m_convaiCallContact.GetAvatarID(this.m_journalMgr);
        let name = this.m_convaiCallContact.GetLocalizedName(this.m_journalMgr);
        this.m_CurrentFunction = EHudPhoneFunction.Inactive;
        // Disconnecting, then the window hides and OnHoloAudioCallFinished removes it, as after a game call.
        this.m_holoAudioCallLogicController.ShowEndCallContact(avatar, name);
    };
    this.m_convaiCallContact = null;
}

// Bring the call window to the wanted state: spawn it when it does not exist (OnHoloAudioCallSpawned below finishes),
// otherwise call the same controller method the game's SetPhoneFunction would. The portrait stays visible in a voice
// call (StartAudiocall showAvatar=true): there is no live picture to replace it.
@addMethod(NewHudPhoneGameController)
private final func ConvaiCallShow() -> Void {
    if !this.m_convaiCallActive || this.m_convaiCallPreempted || !IsDefined(this.m_convaiCallContact) { return; };
    if !IsDefined(this.m_holoAudioCallLogicController) {
        if !IsDefined(this.holoAudioCallElement.request) && !IsDefined(this.holoAudioCallElement.widget) {
            this.holoAudioCallElement.request = this.AsyncSpawnFromLocal(inkWidgetRef.Get(this.holoAudioCallElement.slot),
                this.holoAudioCallElement.libraryID, this, n"OnHoloAudioCallSpawned");
        };
        return;
    };
    this.m_CurrentPhoneCallContact = this.m_convaiCallContact;
    if Equals(this.m_CurrentFunction, this.m_convaiCallWanted) { return; };
    let avatar = this.m_convaiCallContact.GetAvatarID(this.m_journalMgr);
    let name = this.m_convaiCallContact.GetLocalizedName(this.m_journalMgr);
    switch this.m_convaiCallWanted {
        case EHudPhoneFunction.IncomingCall:
            this.m_holoAudioCallLogicController.ShowIncomingContact(avatar, name);
            break;
        case EHudPhoneFunction.Audiocall:
            this.m_holoAudioCallLogicController.StartAudiocall(avatar, name, true);
            break;
        case EHudPhoneFunction.Holocall:
            this.m_holoAudioCallLogicController.StartHolocall(avatar, name);
            break;
        default:
            return;
    };
    this.m_CurrentFunction = this.m_convaiCallWanted;
    this.m_holoAudioCallLogicController.Show();
}

@wrapMethod(NewHudPhoneGameController)
protected cb func OnHoloAudioCallSpawned(widget: ref<inkWidget>, userData: ref<IScriptable>) -> Bool {
    let result = wrappedMethod(widget, userData);
    this.ConvaiCallShow();
    return result;
}

// The game's call information changed. A real call (ringing or started) preempts the mod call: the window is handed
// back before the game's handler runs, so the handler shows the quest contact exactly as it would without the mod.
// An end-of-call update with no game call (a load, or the game clearing a call while the mod call is up) must not
// close the mod window with a null contact: the handler still runs, but sees the window as idle.
@wrapMethod(NewHudPhoneGameController)
protected cb func OnPhoneCall(value: Variant) -> Bool {
    if !this.m_convaiCallActive || this.m_convaiCallPreempted { return wrappedMethod(value); };
    let info = FromVariant<PhoneCallInformation>(value);
    if Equals(info.callPhase, questPhoneCallPhase.IncomingCall) || Equals(info.callPhase, questPhoneCallPhase.StartCall) {
        this.m_convaiCallPreempted = true;
        if Equals(this.m_convaiCallWanted, EHudPhoneFunction.IncomingCall) {
            this.m_audioSystem.Play(n"ui_phone_initiation_call_stop");
        };
        this.m_CurrentFunction = EHudPhoneFunction.Inactive;
        if IsDefined(this.m_player) { this.m_player.ConvaiHolocallEvent("quest-call"); };
        return wrappedMethod(value);
    };
    let shown = this.m_CurrentFunction;
    this.m_CurrentFunction = EHudPhoneFunction.Inactive;
    let result = wrappedMethod(value);
    this.m_CurrentFunction = shown;
    this.m_CurrentPhoneCallContact = this.m_convaiCallContact;
    return result;
}

// Hang up: a tap of the phone button (PhoneInteract released without the hold that opens the phone), or the hold that
// rejects a call (PhoneReject). The game's handler always runs: with no game call ringing these do nothing there.
@wrapMethod(NewHudPhoneGameController)
protected cb func OnAction(action: ListenerAction, consumer: ListenerActionConsumer) -> Bool {
    if this.m_convaiCallActive && !this.m_convaiCallPreempted && IsDefined(this.m_player)
        && !IsDefined(this.m_contactListLogicController) {
        let name = ListenerAction.GetName(action);
        let type = ListenerAction.GetType(action);
        if Equals(name, n"PhoneInteract") {
            if Equals(type, gameinputActionType.BUTTON_PRESSED) {
                this.m_convaiCallPressed = true;
                this.m_convaiCallHeld = false;
            } else {
                if Equals(type, gameinputActionType.BUTTON_HOLD_COMPLETE) {
                    this.m_convaiCallHeld = true;
                } else {
                    if Equals(type, gameinputActionType.BUTTON_RELEASED) {
                        if this.m_convaiCallPressed && !this.m_convaiCallHeld {
                            this.m_player.ConvaiHolocallEvent("hangup");
                        };
                        this.m_convaiCallPressed = false;
                        this.m_convaiCallHeld = false;
                    };
                };
            };
        } else {
            if Equals(name, n"PhoneReject") && Equals(type, gameinputActionType.BUTTON_HOLD_COMPLETE) {
                this.m_player.ConvaiHolocallEvent("hangup");
            };
        };
    };
    return wrappedMethod(action, consumer);
}

// The game's Call action on a Contacts row (the Call key, or the secondary action on the Messages tab) ends in this one
// function, after the game has checked that the contact is callable and that calls are enabled. For one of the mod's
// characters the call becomes a holocall: no call request is sent and nothing else of the game's call path runs. Any
// other contact, and every contact while none are registered, goes to the game's own function unchanged.
@wrapMethod(NewHudPhoneGameController)
public func CallSelectedContact(contactData: wref<ContactData>) -> Void {
    if IsDefined(contactData) && !contactData.convaiChat && IsDefined(this.m_player)
        && this.m_player.ConvaiHolocallRequest(contactData.contactId) {
        return;
    };
    wrappedMethod(contactData);
}
