module CyberpunkConvai

// Controller talk button (docs/CONTROLLER_BINDING.md). Off until Lua switches it on (Settings > Voices > Controller talk button).
//
// The hold: the left stick click (L3), read through the game's own action for it, ToggleSprint (r6/config/inputUserMappings.xml
// maps IK_Pad_LeftThumb to ToggleSprint_Button, and inputContexts.xml puts that action in the Locomotion context only). So the
// game calls this listener on the click going down and on it coming up, and at no other moment: nothing per frame, and nothing at
// all while a menu, a scene, a dialogue choice, a call or a vehicle has taken the walking controls away. Registered only while the
// setting is on. The listener never consumes the action: the game's own handling of it (the sprint toggle) is untouched.
//
// What it reports to Lua (mod/pad-binding.lua), as small numbers in a bounded queue:
//   1  the click was held 0.3 s with the left stick at rest and the controller the last device used: V's turn begins
//   0  that held click came back up: V's turn ends
// A click shorter than 0.3 s reports nothing (it is a sprint click), and so does a click made on the keyboard's sprint key
// (the same action) or while the stick is pushed (a click made to sprint). Lua decides whether the moment is allowed (menus, scenes,
// combat, vehicles) when it takes the 1.

public class ConvaiPadTalkHold extends DelayCallback {
    public let player: wref<PlayerPuppet>;
    public let generation: Int32;

    public func Call() -> Void {
        if IsDefined(this.player) { this.player.ConvaiPadHoldElapsed(this.generation); };
    }
}

public class ConvaiPadTalkListener {
    public let player: wref<PlayerPuppet>;

    protected cb func OnAction(action: ListenerAction, consumer: ListenerActionConsumer) -> Bool {
        if !IsDefined(this.player) { return false; };
        let type: gameinputActionType = ListenerAction.GetType(action);
        if Equals(type, gameinputActionType.BUTTON_PRESSED) {
            this.player.ConvaiPadClick(true);
        } else {
            if Equals(type, gameinputActionType.BUTTON_RELEASED) { this.player.ConvaiPadClick(false); };
        };
        return false;
    }
}

@addField(PlayerPuppet)
private let m_convaiPadListener: ref<ConvaiPadTalkListener>;

// The binding is switched on (Lua asks every 10 Hz tick while the setting is on: a new player after a load has it off).
@addField(PlayerPuppet)
private let m_convaiPadOn: Bool;

// The click is down now.
@addField(PlayerPuppet)
private let m_convaiPadDown: Bool;

// A hold that was reported to Lua (a 1 sent) and has not come up yet.
@addField(PlayerPuppet)
private let m_convaiPadTalking: Bool;

// Each click gets a number, so a timer left over from an earlier click never counts for a later one.
@addField(PlayerPuppet)
private let m_convaiPadGeneration: Int32;

@addField(PlayerPuppet)
private let m_convaiPadEvents: array<Int32>;

@addMethod(PlayerPuppet)
public final func ConvaiPadIsOn() -> Bool {
    return this.m_convaiPadOn;
}

// A hold that was reported and has not come up: Lua's safety check reads it (a release lost to a menu is noticed within a tick).
@addMethod(PlayerPuppet)
public final func ConvaiPadHeld() -> Bool {
    return this.m_convaiPadTalking;
}

@addMethod(PlayerPuppet)
public final func ConvaiPadTake() -> Int32 {
    if ArraySize(this.m_convaiPadEvents) == 0 { return -1; };
    let value: Int32 = this.m_convaiPadEvents[0];
    ArrayErase(this.m_convaiPadEvents, 0);
    return value;
}

// Called after each event is queued, and observed by Lua (Observe on this method) so a press and a release are handled at the moment
// they happen. It does nothing itself. Lua also drains the queue on its 10 Hz tick when the observer could not be installed.
@addMethod(PlayerPuppet)
public final func ConvaiPadNotify() -> Void {
}

@addMethod(PlayerPuppet)
private final func ConvaiPadPush(value: Int32) -> Void {
    if ArraySize(this.m_convaiPadEvents) >= 8 { ArrayErase(this.m_convaiPadEvents, 0); };
    ArrayPush(this.m_convaiPadEvents, value);
    this.ConvaiPadNotify();
}

// Switch the binding on or off. On: the listener starts hearing the click. Off: it stops, a click in progress is forgotten, and a
// hold in progress is ended (a 0 is queued), so the microphone is never left open by switching the setting off.
@addMethod(PlayerPuppet)
public final func ConvaiPadConfigure(on: Bool) -> Bool {
    if on {
        if !IsDefined(this.m_convaiPadListener) {
            this.m_convaiPadListener = new ConvaiPadTalkListener();
            this.m_convaiPadListener.player = this;
            this.RegisterInputListener(this.m_convaiPadListener, n"ToggleSprint");
        };
        this.m_convaiPadOn = true;
        return true;
    };
    this.ConvaiPadStop();
    return false;
}

@addMethod(PlayerPuppet)
private final func ConvaiPadStop() -> Void {
    this.m_convaiPadOn = false;
    this.m_convaiPadDown = false;
    this.m_convaiPadGeneration += 1;
    if IsDefined(this.m_convaiPadListener) {
        this.UnregisterInputListener(this.m_convaiPadListener);
        this.m_convaiPadListener.player = null;
        this.m_convaiPadListener = null;
    };
    if this.m_convaiPadTalking {
        this.m_convaiPadTalking = false;
        this.ConvaiPadPush(0);
    };
}

@addMethod(PlayerPuppet)
public final func ConvaiPadClick(down: Bool) -> Void {
    if !this.m_convaiPadOn { return; };
    this.m_convaiPadGeneration += 1;
    if down {
        // The keyboard's sprint key is the same action: only a click made on the controller counts.
        this.m_convaiPadDown = this.PlayerLastUsedPad();
        if !this.m_convaiPadDown { return; };
        let step = new ConvaiPadTalkHold();
        step.player = this;
        step.generation = this.m_convaiPadGeneration;
        GameInstance.GetDelaySystem(this.GetGame()).DelayCallback(step, 0.3, false);
    } else {
        this.m_convaiPadDown = false;
        if this.m_convaiPadTalking {
            this.m_convaiPadTalking = false;
            this.ConvaiPadPush(0);
        };
    };
}

@addMethod(PlayerPuppet)
public final func ConvaiPadHoldElapsed(generation: Int32) -> Void {
    if !this.m_convaiPadOn || !this.m_convaiPadDown || generation != this.m_convaiPadGeneration { return; };
    // A click made while pushing the stick is a sprint click; a controller that is no longer the last device used is not a hold.
    if this.ConvaiMoveHeld() || !this.PlayerLastUsedPad() { return; };
    this.m_convaiPadTalking = true;
    this.ConvaiPadPush(1);
}

@wrapMethod(PlayerPuppet)
protected cb func OnDetach() -> Bool {
    this.ConvaiPadStop();
    return wrappedMethod();
}
