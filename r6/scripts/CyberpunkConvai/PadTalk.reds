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

// How an edge reaches Lua. Never inside the event that produced it (player report on 0.3.3: the game froze, sometimes, on the first hold of the
// left stick click after a load). A hold's Lua is the whole talk path (target choice, party and spawned-character scans, a warm connection, the
// face request, the focus); run inside the game's input listener or the hold's delay callback it is the class of call that froze game 2.31
// while a key was being set (GameVariant.reds ConvaiKeyNotifyInEvent, 25 Oct), and the pad has never been live-tested with it.
// true: the edge is queued and ConvaiPadNotify (which Lua observes) is called from a one-shot DelayCallbackNextFrame, one frame after the event
// has ended. The step touches nothing of the input system and starts no event of its own; the only thing it does is that call. Worst delay
// after the click: one frame.
// false: Lua reads the queue on its 10 Hz tick only (worst delay 0.1 s). Also the fallback when the next-frame call did not run.
public func ConvaiPadNotifyDeferred() -> Bool {
    return true;
}

public class ConvaiPadNotifyStep extends DelayCallback {
    public let player: wref<PlayerPuppet>;

    public func Call() -> Void {
        if IsDefined(this.player) { this.player.ConvaiPadFlush(); };
    }
}

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

// An edge is being handled (a click, a hold timer, a push). Nothing the handlers call can start another one, and a second one that arrives
// anyway is dropped (a press) or only recorded (a release), so no handler is ever entered from inside itself.
@addField(PlayerPuppet)
private let m_convaiPadBusy: Bool;

// A next-frame step is scheduled and has not run.
@addField(PlayerPuppet)
private let m_convaiPadFlushPending: Bool;

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

// Whether Lua may observe ConvaiPadNotify (ConvaiPadNotifyDeferred above). Lua asks once and reads the queue on its tick when this says no.
@addMethod(PlayerPuppet)
public final func ConvaiPadObservable() -> Bool {
    return ConvaiPadNotifyDeferred();
}

// Called one frame after an event was queued (ConvaiPadFlush), and observed by Lua (Observe on this method) so a press and a release are handled
// within a frame. It does nothing itself. Lua also drains the queue on its 10 Hz tick.
@addMethod(PlayerPuppet)
public final func ConvaiPadNotify() -> Void {
}

// The next-frame step: one Notify for everything queued since it was scheduled. Never from inside a handler (a busy flag), and only when something
// is queued. It calls nothing of the input system and queues nothing new, so it cannot start another step.
@addMethod(PlayerPuppet)
public final func ConvaiPadFlush() -> Void {
    this.m_convaiPadFlushPending = false;
    if this.m_convaiPadBusy || ArraySize(this.m_convaiPadEvents) == 0 { return; };
    this.m_convaiPadBusy = true;
    this.ConvaiPadNotify();
    this.m_convaiPadBusy = false;
}

@addMethod(PlayerPuppet)
private final func ConvaiPadPush(value: Int32) -> Void {
    if ArraySize(this.m_convaiPadEvents) >= 8 { ArrayErase(this.m_convaiPadEvents, 0); };
    ArrayPush(this.m_convaiPadEvents, value);
    // One step in the air at a time: every edge queued before it runs is told to Lua by it.
    if !ConvaiPadNotifyDeferred() || this.m_convaiPadFlushPending { return; };
    let delay: ref<DelaySystem> = GameInstance.GetDelaySystem(this.GetGame());
    if !IsDefined(delay) { return; };
    let step = new ConvaiPadNotifyStep();
    step.player = this;
    this.m_convaiPadFlushPending = true;
    delay.DelayCallbackNextFrame(step);
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
    // Never entered from inside itself: a press that arrives while a handler runs is dropped, a release is still honoured below.
    if down && this.m_convaiPadBusy { return; };
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
    if !this.m_convaiPadOn || !this.m_convaiPadDown || generation != this.m_convaiPadGeneration || this.m_convaiPadBusy { return; };
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
