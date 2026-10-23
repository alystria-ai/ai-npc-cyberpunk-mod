module CyberpunkConvai

// An interaction owns one civilian's temporary hold and look-at. All commands
// are released together when the conversation ends or the target changes.
public class ConvaiTurnStep extends DelayCallback {
    public let player: wref<PlayerPuppet>;
    public let npc: wref<NPCPuppet>;
    public let generation: Int32;
    public let yaw: Float;

    public func Call() {
        if !IsDefined(this.player) || !IsDefined(this.npc)
            || !this.player.ConvaiFocusMatches(this.npc, this.generation) {
            return;
        };
        let rotation: EulerAngles;
        rotation.Pitch = 0.0;
        rotation.Roll = 0.0;
        rotation.Yaw = this.yaw;
        GameInstance.GetTeleportationFacility(this.npc.GetGame())
            .Teleport(this.npc, this.npc.GetWorldPosition(), rotation);
    }
}

@addField(PlayerPuppet)
private let m_convaiFocusNpc: wref<NPCPuppet>;

@addField(PlayerPuppet)
private let m_convaiFocusHold: ref<AIHoldPositionCommand>;

@addField(PlayerPuppet)
private let m_convaiFocusLookAt: ref<LookAtAddEvent>;

@addField(PlayerPuppet)
private let m_convaiFocusGeneration: Int32;

@addMethod(PlayerPuppet)
public final func ConvaiFocusMatches(npc: wref<NPCPuppet>, generation: Int32) -> Bool {
    return IsDefined(npc) && this.m_convaiFocusNpc == npc
        && this.m_convaiFocusGeneration == generation;
}

@addMethod(PlayerPuppet)
public final func ConvaiCanFocus() -> Bool {
    return !GameInstance.GetBlackboardSystem(this.GetGame())
        .Get(GetAllBlackboardDefs().UI_System)
        .GetBool(GetAllBlackboardDefs().UI_System.IsInMenu)
        && !this.ConvaiManagerIsOpen()
        && !this.ConvaiComposerOpen();
}

@addMethod(PlayerPuppet)
public final func ConvaiEndFocus() -> Void {
    let npc: wref<NPCPuppet> = this.m_convaiFocusNpc;
    this.m_convaiFocusGeneration += 1;
    this.m_convaiFocusNpc = null;
    if IsDefined(npc) {
        if IsDefined(this.m_convaiFocusLookAt) {
            LookAtRemoveEvent.QueueRemoveLookatEvent(npc, this.m_convaiFocusLookAt);
        };
        if IsDefined(this.m_convaiFocusHold) {
            let controller = npc.GetAIControllerComponent();
            if IsDefined(controller) {
                let state = controller.GetCommandState(this.m_convaiFocusHold);
                if Equals(state, AICommandState.Executing) {
                    controller.StopExecutingCommand(this.m_convaiFocusHold, true);
                } else {
                    if Equals(state, AICommandState.Enqueued) {
                        controller.CancelCommand(this.m_convaiFocusHold);
                    };
                };
            };
        };
    };
    this.m_convaiFocusLookAt = null;
    this.m_convaiFocusHold = null;
}

// keepAI: a character another mod or a spawner created (docs/SPAWNED_CHARACTERS.md). That mod owns its body, so it gets
// eye contact only: no hold command, no turn and no chest twist that could fight its follow or pose commands.
@addMethod(PlayerPuppet)
public final func ConvaiBeginFocus(npc: wref<NPCPuppet>, opt keepAI: Bool) -> Bool {
    this.ConvaiEndFocus();
    if !IsDefined(npc) || npc.IsDead() || !npc.IsAttached()
        || this.ConvaiManagerIsOpen() {
        return false;
    };
    this.m_convaiFocusNpc = npc;
    let workspots = GameInstance.GetWorkspotSystem(npc.GetGame());
    let inWorkspot = IsDefined(workspots) && workspots.IsActorInWorkspot(npc);
    if !keepAI && (npc.IsCrowd() || npc.IsCharacterCivilian()) && !inWorkspot {
        let hold = new AIHoldPositionCommand();
        hold.duration = 40.0;
        this.m_convaiFocusHold = hold;
        AIComponent.SendCommand(npc, hold);
        this.ConvaiTurnCivilian(npc);
    };
    let lookAt = new LookAtAddEvent();
    lookAt.SetEntityTarget(this, n"pla_default_tgt", Vector4.EmptyVector());
    lookAt.SetStyle(animLookAtStyle.Normal);
    lookAt.request.limits.softLimitDegrees = 360.0;
    lookAt.request.limits.hardLimitDegrees = 270.0;
    lookAt.request.limits.backLimitDegrees = 210.0;
    lookAt.request.limits.hardLimitDistance = GetLookAtLimitDistanceValue(animLookAtLimitDistanceType.None);
    lookAt.request.calculatePositionInParentSpace = true;
    lookAt.bodyPart = n"Eyes";
    let parts: array<LookAtPartRequest>;
    let part: LookAtPartRequest;
    part.partName = n"Head";
    part.weight = 0.1;
    part.suppress = 1.0;
    part.mode = 0;
    ArrayPush(parts, part);
    part.partName = n"Chest";
    // The managed actor turns with its AI command. Driving the chest toward V
    // at full weight at the same time visibly twists the upper body and feet.
    part.weight = (keepAI || npc.IsPlayerCompanion()) ? 0.0 : (inWorkspot ? 0.2 : 1.0);
    part.suppress = 0.0;
    part.mode = 0;
    ArrayPush(parts, part);
    lookAt.SetAdditionalPartsArray(parts);
    npc.QueueEvent(lookAt);
    this.m_convaiFocusLookAt = lookAt;
    return true;
}

@addMethod(PlayerPuppet)
private final func ConvaiTurnCivilian(npc: wref<NPCPuppet>) -> Void {
    let direction: Vector4 = this.GetWorldPosition() - npc.GetWorldPosition();
    direction.Z = 0.0;
    let forward: Vector4 = npc.GetWorldForward();
    let from: Float = Vector4.Heading(forward);
    let difference: Float = Vector4.Heading(direction) - from;
    while difference > 180.0 { difference -= 360.0; };
    while difference < -180.0 { difference += 360.0; };
    if AbsF(difference) < 12.0 { return; };
    let stepIndex: Int32 = 1;
    while stepIndex <= 6 {
        let step = new ConvaiTurnStep();
        step.player = this;
        step.npc = npc;
        step.generation = this.m_convaiFocusGeneration;
        step.yaw = from + difference * (Cast<Float>(stepIndex) / 6.0);
        GameInstance.GetDelaySystem(this.GetGame())
            .DelayCallback(step, Cast<Float>(stepIndex) * 0.06, false);
        stepIndex += 1;
    };
}

// The game's own ambient barks (the voiceset lines an NPC says when V looks at, walks up to or bumps it: 'greeting', 'fear_foll',
// 'stlh_curious_grunt', 'bump') must not play over an AI voice line. Every one of them is sent through GameObject.PlayVoiceOver (the
// reaction component's look-at, comfort-zone and bump handlers). While V talks to an NPC and while an AI line plays, the mod keeps a
// window open (ConvaiBarkHold from mod/vanilla-reactions.lua, one call per conversation event, never per frame); inside it those four
// contexts are dropped for every NPC within ConvaiBarkGate.Radius() of V, and only the sound is dropped: the look-at, the stimulus
// and the NPC's AI are the game's own. Combat lines, pain and death sounds, quest and scene dialogue (not sent through here) and the
// game's own NPC conversations are never touched, and nothing is muted while V or the NPC is in combat. The window ends by itself.
@addField(PlayerPuppet)
private let m_convaiBarkUntil: Float;

@addMethod(PlayerPuppet)
public final func ConvaiBarkHold(seconds: Float) -> Void {
    let until: Float = EngineTime.ToFloat(GameInstance.GetSimTime(this.GetGame())) + seconds;
    if until > this.m_convaiBarkUntil { this.m_convaiBarkUntil = until; };
}

// The window ends `seconds` from now, also when it was longer.
@addMethod(PlayerPuppet)
public final func ConvaiBarkRelease(seconds: Float) -> Void {
    this.m_convaiBarkUntil = EngineTime.ToFloat(GameInstance.GetSimTime(this.GetGame())) + seconds;
}

@addMethod(PlayerPuppet)
public final func ConvaiBarkOpen() -> Bool {
    return EngineTime.ToFloat(GameInstance.GetSimTime(this.GetGame())) < this.m_convaiBarkUntil;
}

public abstract class ConvaiBarkGate {
    public static func Radius() -> Float {
        return 15.0;
    }

    // The four ambient contexts, nothing else.
    public static func Ambient(voName: CName) -> Bool {
        return Equals(voName, n"greeting") || Equals(voName, n"fear_foll")
            || Equals(voName, n"stlh_curious_grunt") || Equals(voName, n"bump");
    }

    // True when the NPC's ambient line is to be dropped now. Cheap order: the window first (one float compare), then the distance.
    public static func Muted(npc: ref<GameObject>) -> Bool {
        if !IsDefined(npc) { return false; };
        let player: ref<PlayerPuppet> = GameInstance.GetPlayerSystem(npc.GetGame()).GetLocalPlayerMainGameObject() as PlayerPuppet;
        if !IsDefined(player) || Equals(player, npc) || !player.ConvaiBarkOpen() { return false; };
        if Vector4.DistanceSquared(npc.GetWorldPosition(), player.GetWorldPosition()) > ConvaiBarkGate.Radius() * ConvaiBarkGate.Radius() {
            return false;
        };
        if Equals(PlayerPuppet.GetCurrentCombatState(player), gamePSMCombat.InCombat) { return false; };
        let puppet: ref<ScriptedPuppet> = npc as ScriptedPuppet;
        return IsDefined(puppet) && !NPCPuppet.IsInCombat(puppet);
    }
}

@wrapMethod(GameObject)
public static func PlayVoiceOver(self: ref<GameObject>, voName: CName, debugInitialContext: CName, opt delay: Float, opt answeringEntityId: EntityID, opt ignoreFrustumCheck: Bool) -> Void {
    if ConvaiBarkGate.Ambient(voName) && ConvaiBarkGate.Muted(self) { return; };
    wrappedMethod(self, voName, debugInitialContext, delay, answeringEntityId, ignoreFrustumCheck);
}
