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

@addMethod(PlayerPuppet)
public final func ConvaiBeginFocus(npc: wref<NPCPuppet>) -> Bool {
    this.ConvaiEndFocus();
    if !IsDefined(npc) || npc.IsDead() || !npc.IsAttached()
        || this.ConvaiManagerIsOpen() {
        return false;
    };
    this.m_convaiFocusNpc = npc;
    let workspots = GameInstance.GetWorkspotSystem(npc.GetGame());
    let inWorkspot = IsDefined(workspots) && workspots.IsActorInWorkspot(npc);
    if (npc.IsCrowd() || npc.IsCharacterCivilian()) && !inWorkspot {
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
    part.weight = npc.IsPlayerCompanion() ? 0.0 : (inWorkspot ? 0.2 : 1.0);
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
