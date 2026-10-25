module CyberpunkConvai

// The mod's own key bindings (docs/KEY_BINDINGS.md): Companion Manager > Key bindings. Off until Lua gives this a list of keys (a player who set none
// has nothing registered here).
//
// The keys are read as Codeware key callbacks ("Input/Key"), the same way the manager popup and the phone read theirs (Manager.reds, PhoneContacts.reds),
// because the game's walking-action listener (PadTalk.reds) only hears the actions a button is mapped to, while a binding the player picks can be any key
// or controller button. The game calls the callback when a key goes down and when it comes up, and at no other moment: nothing per frame. Without
// Codeware these scripts still compile (a compile error would disable every redscript mod) and the bindings do nothing; mod/setup-check.lua tells the
// player Codeware is missing and the page says so.
//
// What it reports to Lua (mod/key-bindings.lua), as short texts in a bounded queue:
//   d1..d5       the key bound to slot 1..5 went down (the slots are the five actions, in the order Lua gives them)
//   u1..u5       that key came back up
//   kIK_F7       while a key is being chosen (Set): the key that went down, by the name of the game's EInputKey
// A key pressed while Shift, Ctrl or Alt is held is not a binding of this mod and reports nothing, and a key that stays down reports one d, not one per
// key repeat. Lua decides whether the moment is allowed (menus, scenes, calls, the text box ...) when it takes the event, and runs the same code path
// the Cyber Engine Tweaks key of that action runs.

@addField(PlayerPuppet)
private let m_convaiKeyList: String;

// The key of each slot, and whether it is down now (both by slot; a slot without a binding holds IK_None).
@addField(PlayerPuppet)
private let m_convaiKeySlots: array<EInputKey>;

@addField(PlayerPuppet)
private let m_convaiKeyDown: array<Bool>;

@addField(PlayerPuppet)
private let m_convaiKeyEvents: array<String>;

// The key that was chosen last (Set): it is still down when the new binding starts listening, so its key repeat is not a press until it has come up.
@addField(PlayerPuppet)
private let m_convaiKeyChosen: EInputKey;

@if(ModuleExists("Codeware"))
@addField(PlayerPuppet)
private let m_convaiKeyHandler: ref<CallbackSystemHandler>;

@if(ModuleExists("Codeware"))
@addField(PlayerPuppet)
private let m_convaiKeyCaptureHandler: ref<CallbackSystemHandler>;

// Whether this game has what the bindings need (Codeware); Lua asks once, when the page opens or a binding is set.
@addMethod(PlayerPuppet)
public final func ConvaiKeyBindsReady() -> Bool {
    return ConvaiHasCodeware();
}

// The list this player was last configured with ("" when nothing is registered): Lua compares it with what is saved on its 10 Hz tick, so a new
// player after a load gets its keys registered again.
@addMethod(PlayerPuppet)
public final func ConvaiKeyBindsActive() -> String {
    return this.m_convaiKeyList;
}

@addMethod(PlayerPuppet)
public final func ConvaiKeyBindTake() -> String {
    if ArraySize(this.m_convaiKeyEvents) == 0 { return ""; };
    let value: String = this.m_convaiKeyEvents[0];
    ArrayErase(this.m_convaiKeyEvents, 0);
    return value;
}

// Called after each event is queued, and observed by Lua (Observe on this method) so a key is handled at the moment it goes down or up. It does nothing
// itself. Lua also drains the queue on its 10 Hz tick when the observer could not be installed.
@addMethod(PlayerPuppet)
public final func ConvaiKeyBindNotify() -> Void {
}

@addMethod(PlayerPuppet)
private final func ConvaiKeyBindPush(value: String) -> Void {
    if ArraySize(this.m_convaiKeyEvents) >= 16 { ArrayErase(this.m_convaiKeyEvents, 0); };
    ArrayPush(this.m_convaiKeyEvents, value);
    this.ConvaiKeyBindNotify();
}

// The keys to listen to, as the names of EInputKey in slot order, "-" for a slot without a binding ("IK_F7,-,IK_Pad_LeftShoulder,-,-"). An empty list
// stops listening. A key that is down when the list changes is forgotten (Lua ends its hold when it changes the list).
@if(ModuleExists("Codeware"))
@addMethod(PlayerPuppet)
public final func ConvaiKeyBindsConfigure(list: String) -> Bool {
    this.ConvaiKeyBindsRelease();
    if StrLen(list) == 0 { return true; };
    let names: array<String> = StrSplit(list, ",");
    let any: Bool = false;
    let i: Int32 = 0;
    while i < ArraySize(names) {
        let key: EInputKey = EInputKey.IK_None;
        if NotEquals(names[i], "-") {
            let value: Int64 = EnumValueFromString("EInputKey", names[i]);
            if value > 0l { key = IntEnum<EInputKey>(Cast<Int32>(value)); };
        };
        ArrayPush(this.m_convaiKeySlots, key);
        ArrayPush(this.m_convaiKeyDown, false);
        if NotEquals(key, EInputKey.IK_None) { any = true; };
        i += 1;
    };
    if !any {
        this.ConvaiKeyBindsRelease();
        return true;
    };
    this.m_convaiKeyHandler = ConvaiCallbackSystem().RegisterCallback(n"Input/Key", this, n"OnConvaiBoundKey");
    i = 0;
    while i < ArraySize(this.m_convaiKeySlots) {
        if NotEquals(this.m_convaiKeySlots[i], EInputKey.IK_None) {
            this.m_convaiKeyHandler.AddTarget(ConvaiKeyTarget(this.m_convaiKeySlots[i], EInputAction.IACT_Press));
            if ConvaiKeyTargetsByAction() {
                this.m_convaiKeyHandler.AddTarget(ConvaiKeyTarget(this.m_convaiKeySlots[i], EInputAction.IACT_Release));
            };
        };
        i += 1;
    };
    this.m_convaiKeyList = list;
    return true;
}

@if(!ModuleExists("Codeware"))
@addMethod(PlayerPuppet)
public final func ConvaiKeyBindsConfigure(list: String) -> Bool {
    return false;
}

// While a key is being chosen: every key that goes down is reported (kIK_..), the bound keys report nothing. Lua switches it off when the key is chosen,
// cancelled or no longer wanted.
@if(ModuleExists("Codeware"))
@addMethod(PlayerPuppet)
public final func ConvaiKeyBindsCapture(on: Bool) -> Bool {
    if IsDefined(this.m_convaiKeyCaptureHandler) {
        this.m_convaiKeyCaptureHandler.Unregister();
        this.m_convaiKeyCaptureHandler = null;
    };
    if on {
        this.m_convaiKeyChosen = EInputKey.IK_None;
        this.m_convaiKeyCaptureHandler = ConvaiCallbackSystem().RegisterCallback(n"Input/Key", this, n"OnConvaiCaptureKey");
    };
    return true;
}

@if(!ModuleExists("Codeware"))
@addMethod(PlayerPuppet)
public final func ConvaiKeyBindsCapture(on: Bool) -> Bool {
    return false;
}

@if(ModuleExists("Codeware"))
@addMethod(PlayerPuppet)
private final func ConvaiKeyBindsRelease() -> Void {
    if IsDefined(this.m_convaiKeyHandler) {
        this.m_convaiKeyHandler.Unregister();
        this.m_convaiKeyHandler = null;
    };
    ArrayClear(this.m_convaiKeySlots);
    ArrayClear(this.m_convaiKeyDown);
    this.m_convaiKeyList = "";
}

@if(!ModuleExists("Codeware"))
@addMethod(PlayerPuppet)
private final func ConvaiKeyBindsRelease() -> Void {
}

@if(ModuleExists("Codeware"))
@addMethod(PlayerPuppet)
private cb func OnConvaiBoundKey(evt: ref<KeyInputEvent>) -> Void {
    // The 2.5 key target cannot filter by action (GameVariant.reds), so every action of the bound keys arrives: only a press and a release count.
    let pressed: Bool = Equals(evt.GetAction(), EInputAction.IACT_Press);
    if !pressed && NotEquals(evt.GetAction(), EInputAction.IACT_Release) { return; };
    let key: EInputKey = evt.GetKey();
    let i: Int32 = 0;
    while i < ArraySize(this.m_convaiKeySlots) {
        if Equals(this.m_convaiKeySlots[i], key) {
            if pressed {
                // Not while Shift, Ctrl or Alt is held (Ctrl+C is not a talk key), not again for the key repeat of a key that is already down, and not for
                // the key that was just chosen and has not come up yet.
                if !this.m_convaiKeyDown[i] && NotEquals(key, this.m_convaiKeyChosen) && !evt.IsShiftDown() && !evt.IsControlDown() && !evt.IsAltDown() {
                    this.m_convaiKeyDown[i] = true;
                    this.ConvaiKeyBindPush("d" + IntToString(i + 1));
                };
            } else {
                if Equals(key, this.m_convaiKeyChosen) { this.m_convaiKeyChosen = EInputKey.IK_None; };
                if this.m_convaiKeyDown[i] {
                    this.m_convaiKeyDown[i] = false;
                    this.ConvaiKeyBindPush("u" + IntToString(i + 1));
                };
            };
        };
        i += 1;
    };
}

@if(ModuleExists("Codeware"))
@addMethod(PlayerPuppet)
private cb func OnConvaiCaptureKey(evt: ref<KeyInputEvent>) -> Void {
    if NotEquals(evt.GetAction(), EInputAction.IACT_Press) { return; };
    this.m_convaiKeyChosen = evt.GetKey();
    this.ConvaiKeyBindPush("k" + EnumValueToString("EInputKey", Cast<Int64>(EnumInt(evt.GetKey()))));
}

// Everything stops with the player: the callbacks hold the player, so they are unregistered when it goes.
@addMethod(PlayerPuppet)
private final func ConvaiKeyBindsStop() -> Void {
    this.ConvaiKeyBindsCapture(false);
    this.ConvaiKeyBindsRelease();
    ArrayClear(this.m_convaiKeyEvents);
}

@wrapMethod(PlayerPuppet)
protected cb func OnDetach() -> Bool {
    this.ConvaiKeyBindsStop();
    return wrappedMethod();
}
