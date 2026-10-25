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
// What it reports to Lua (mod/key-bindings.lua), as short texts in two bounded queues:
//   d1..d5       the key bound to slot 1..5 went down (the slots are the five actions, in the order Lua gives them)
//   u1..u5       that key came back up
//   kIK_F7       while a key is being chosen (Set): the key that went down, by the name of the game's EInputKey (the capture's own queue)
//   x            the capture closed itself: it met more key events or lasted longer than any Set does (the capture's own queue)
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

// The capture (Set) keeps to itself: its results wait in their own queue, which only Lua's 10 Hz tick reads (ConvaiKeyBindCaptureTake). Nothing it hears
// calls into Lua, saves a setting or registers or unregisters a listener while the game is still delivering that key event (game 2.31 froze while a
// key was being set, 25 Oct, with Dark Future's input mods beside it). It counts what it handles and when it started; past either limit it closes
// itself (it ignores every later event and says "x") and Lua unregisters it on its next tick, outside the event.
@addField(PlayerPuppet)
private let m_convaiKeyCaptured: array<String>;

@addField(PlayerPuppet)
private let m_convaiKeyCaptureEvents: Int32;

@addField(PlayerPuppet)
private let m_convaiKeyCaptureStart: Float;

@addField(PlayerPuppet)
private let m_convaiKeyCaptureClosed: Bool;

// A handler of this file is running: an event that arrives inside it (the game delivering another key from the code it calls) is dropped.
@addField(PlayerPuppet)
private let m_convaiKeyBusy: Bool;

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

// Called after each event is queued (game 2.5; GameVariant.reds ConvaiKeyNotifyInEvent), and observed by Lua (Observe on this method) so a key is handled
// at the moment it goes down or up. It does nothing itself. Lua drains the queue on its 10 Hz tick when the observer could not be installed, and on game
// 2.31, where it is not called.
@addMethod(PlayerPuppet)
public final func ConvaiKeyBindNotify() -> Void {
}

// The capture's queue (kIK_.. and x), read by Lua's tick while a Set waits: "" when empty.
@addMethod(PlayerPuppet)
public final func ConvaiKeyBindCaptureTake() -> String {
    if ArraySize(this.m_convaiKeyCaptured) == 0 { return ""; };
    let value: String = this.m_convaiKeyCaptured[0];
    ArrayErase(this.m_convaiKeyCaptured, 0);
    return value;
}

@addMethod(PlayerPuppet)
private final func ConvaiKeyBindPush(value: String) -> Void {
    if ArraySize(this.m_convaiKeyEvents) >= 16 { ArrayErase(this.m_convaiKeyEvents, 0); };
    ArrayPush(this.m_convaiKeyEvents, value);
    // Game 2.31: not from inside the key event (GameVariant.reds); Lua's tick reads the queue.
    if ConvaiKeyNotifyInEvent() { this.ConvaiKeyBindNotify(); };
}

// Whether ConvaiKeyBindNotify is called as a key event happens (game 2.5), or Lua must read the queue on its tick (game 2.31). Lua asks once.
@addMethod(PlayerPuppet)
public final func ConvaiKeyBindsObservable() -> Bool {
    return ConvaiKeyNotifyInEvent();
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

// While a key is being chosen: the keys a binding may use (the EInputKey names Lua lists, comma separated: the keys and buttons it offers, and Escape
// to cancel) report when they go down (kIK_..), the bound keys report nothing. An empty list stops. Lua stops it when the key is chosen, cancelled or
// no longer wanted, always from its tick. The listener has a target for each listed key, as every other key listener of the mod has: no listener of
// this mod hears every key of the game.
@if(ModuleExists("Codeware"))
@addMethod(PlayerPuppet)
public final func ConvaiKeyBindsCapture(keys: String) -> Bool {
    if IsDefined(this.m_convaiKeyCaptureHandler) {
        this.m_convaiKeyCaptureHandler.Unregister();
        this.m_convaiKeyCaptureHandler = null;
    };
    ArrayClear(this.m_convaiKeyCaptured);
    this.m_convaiKeyCaptureClosed = false;
    if StrLen(keys) == 0 { return true; };
    let names: array<String> = StrSplit(keys, ",");
    let handler: ref<CallbackSystemHandler> = ConvaiCallbackSystem().RegisterCallback(n"Input/Key", this, n"OnConvaiCaptureKey");
    let count: Int32 = 0;
    let i: Int32 = 0;
    while i < ArraySize(names) && i < 256 {
        let value: Int64 = EnumValueFromString("EInputKey", names[i]);
        if value > 0l {
            let key: EInputKey = IntEnum<EInputKey>(Cast<Int32>(value));
            handler.AddTarget(ConvaiKeyTarget(key, EInputAction.IACT_Press));
            // The release too: the chosen key that comes up before its binding listens is not left counted as still down.
            if ConvaiKeyTargetsByAction() { handler.AddTarget(ConvaiKeyTarget(key, EInputAction.IACT_Release)); };
            count += 1;
        };
        i += 1;
    };
    if count == 0 {
        handler.Unregister();
        return false;
    };
    this.m_convaiKeyChosen = EInputKey.IK_None;
    this.m_convaiKeyCaptureEvents = 0;
    this.m_convaiKeyCaptureStart = EngineTime.ToFloat(GameInstance.GetEngineTime(this.GetGame()));
    this.m_convaiKeyCaptureHandler = handler;
    return true;
}

@if(!ModuleExists("Codeware"))
@addMethod(PlayerPuppet)
public final func ConvaiKeyBindsCapture(keys: String) -> Bool {
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
    if this.m_convaiKeyBusy { return; };
    this.m_convaiKeyBusy = true;
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
    this.m_convaiKeyBusy = false;
}

// A Set needs a few key events and Lua gives up after 12 s: past 64 events or 30 s the capture closes itself.
@if(ModuleExists("Codeware"))
@addMethod(PlayerPuppet)
private cb func OnConvaiCaptureKey(evt: ref<KeyInputEvent>) -> Void {
    if this.m_convaiKeyCaptureClosed || this.m_convaiKeyBusy { return; };
    this.m_convaiKeyBusy = true;
    this.m_convaiKeyCaptureEvents += 1;
    let action: EInputAction = evt.GetAction();
    let key: EInputKey = evt.GetKey();
    let age: Float = EngineTime.ToFloat(GameInstance.GetEngineTime(this.GetGame())) - this.m_convaiKeyCaptureStart;
    if this.m_convaiKeyCaptureEvents > 64 || age > 30.0 || age < 0.0 {
        this.m_convaiKeyCaptureClosed = true;
        ArrayPush(this.m_convaiKeyCaptured, "x");
    } else {
        if Equals(action, EInputAction.IACT_Press) {
            let value: String = "k" + EnumValueToString("EInputKey", Cast<Int64>(EnumInt(key)));
            let size: Int32 = ArraySize(this.m_convaiKeyCaptured);
            // A key held down repeats its press: one entry for it while Lua has not read the last one.
            if size < 8 && (size == 0 || NotEquals(this.m_convaiKeyCaptured[size - 1], value)) {
                this.m_convaiKeyChosen = key;
                ArrayPush(this.m_convaiKeyCaptured, value);
            };
        } else {
            if Equals(action, EInputAction.IACT_Release) && Equals(key, this.m_convaiKeyChosen) { this.m_convaiKeyChosen = EInputKey.IK_None; };
        };
    };
    this.m_convaiKeyBusy = false;
}

// Everything stops with the player: the callbacks hold the player, so they are unregistered when it goes.
@addMethod(PlayerPuppet)
private final func ConvaiKeyBindsStop() -> Void {
    this.ConvaiKeyBindsCapture("");
    this.ConvaiKeyBindsRelease();
    ArrayClear(this.m_convaiKeyEvents);
}

@wrapMethod(PlayerPuppet)
protected cb func OnDetach() -> Bool {
    this.ConvaiKeyBindsStop();
    return wrappedMethod();
}
