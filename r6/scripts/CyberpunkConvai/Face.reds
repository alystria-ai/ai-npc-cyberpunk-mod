// A separate graph is chosen before native component initialization, for
// dynamic entities tagged by our companion manager and for world NPCs (crowd,
// community, vendors, named characters met in the world) the mod may voice.
// Shared game resources are never patched, zero inputs leave the native face
// unchanged, and this service never owns a live actor or component handle.
public class ConvaiFaceService extends ScriptableService {
  private let m_names: array<String>;
  private let m_graphs: array<ResourceRef>;

  private cb func OnLoad() {
    this.m_names = ConvaiFaceAssets.Names();
    let i = 0;
    while i < ArraySize(this.m_names) {
      ArrayPush(this.m_graphs, ResourceRef.FromPath(ResRef.FromString("cyberpunk_convai\\facial\\" + this.m_names[i] + ".animgraph")));
      i += 1;
    };
    GameInstance.GetCallbackSystem()
      .RegisterCallback(n"Entity/Initialize", this, n"OnCompanionInitialize")
      .AddTarget(DynamicEntityTarget.Tag(n"CyberpunkConvaiCompanion"));
    // World NPCs: one preparation per NPC initialization, never per frame.
    GameInstance.GetCallbackSystem()
      .RegisterCallback(n"Entity/Initialize", this, n"OnWorldInitialize")
      .AddTarget(EntityTarget.Type(n"NPCPuppet"));
    // DynamicEntityTarget is a lifecycle-event filter, not a builder filter.
    // The extraction callback repeats ownership using the builder request ID
    // before touching any newly extracted component instance.
    GameInstance.GetCallbackSystem()
      .RegisterCallback(n"Entity/Extract", this, n"OnCompanionExtract");
  }

  private cb func OnCompanionExtract(event: ref<EntityBuilderEvent>) {
    let builder = event.GetEntityBuilder();
    let dynamic = GameInstance.GetDynamicEntitySystem();
    if !IsDefined(builder) || !IsDefined(dynamic)
      || !dynamic.IsTagged(builder.GetEntityID(), n"CyberpunkConvaiCompanion") { return; };
    // These wrappers expose this builder's extracted component clones, not
    // shared .ent/.app definitions. They also cover appearance-only rebuilds.
    let npc = dynamic.GetEntity(builder.GetEntityID()) as NPCPuppet;
    if builder.HasEntity() {
      let template = builder.GetTemplate();
      if !IsDefined(npc) { npc = template.GetEntity() as NPCPuppet; };
      this.PrepareExtractedComponents(template.GetComponents(), npc);
    };
    if builder.HasAppearance() {
      this.PrepareExtractedComponents(builder.GetAppearance().GetComponents(), npc);
    };
    let appearances = builder.GetCustomAppearances();
    let i = 0;
    while i < ArraySize(appearances) {
      this.PrepareExtractedComponents(appearances[i].GetComponents(), npc);
      i += 1;
    };
  }

  private func PrepareExtractedComponents(components: array<ref<IComponent>>, npc: ref<NPCPuppet>) -> Void {
    let i = 0;
    while i < ArraySize(components) {
      let face = components[i] as AnimatedComponent;
      if IsDefined(face) && Equals(face.GetName(), n"face_rig") {
        let status = this.PrepareFaceComponent(face);
        if IsDefined(npc) {
          npc.ConvaiFacePrepared(StrBeginsWith(status, "prepared:"), status,
            ResRef.ToString(ResourceRef.GetPath(face.graph)));
        };
      };
      i += 1;
    };
  }

  private cb func OnCompanionInitialize(event: ref<EntityLifecycleEvent>) {
    let npc = event.GetEntity() as NPCPuppet;
    if !IsDefined(npc) { return; };
    // The event filter is the first ownership gate. Repeat it here before any
    // assignment so this method is also safe if invoked from another caller.
    let dynamic = GameInstance.GetDynamicEntitySystem();
    if !IsDefined(dynamic) || !dynamic.IsTagged(npc.GetEntityID(), n"CyberpunkConvaiCompanion") { return; };
    npc.ConvaiFacePrepared(false, "initializing");
    let face = npc.FindComponentByName(n"face_rig") as AnimatedComponent;
    let status = this.PrepareFaceComponent(face);
    let graphPath = "";
    if IsDefined(face) { graphPath = ResRef.ToString(ResourceRef.GetPath(face.graph)); };
    npc.ConvaiFacePrepared(StrBeginsWith(status, "prepared:"), status, graphPath);
  }

  // Ambient and archetype NPCs are spawned by the game, not by the companion
  // manager, so their face_rig ran the vanilla graph with no ConvaiFace input
  // and the mod's lip sync could never reach them. They get the same additive
  // layer here, before native component initialization; nothing is written to
  // it until the Lua speech owner voices this exact NPC. Dynamic entities stay
  // with their spawner: our companions use OnCompanionInitialize, and other
  // mods' copies are not ours to change.
  private cb func OnWorldInitialize(event: ref<EntityLifecycleEvent>) {
    let npc = event.GetEntity() as NPCPuppet;
    if !IsDefined(npc) { return; };
    let dynamic = GameInstance.GetDynamicEntitySystem();
    if !IsDefined(dynamic) || dynamic.IsManaged(npc.GetEntityID()) { return; };
    let face = npc.FindComponentByName(n"face_rig") as AnimatedComponent;
    if !IsDefined(face) { return; };
    let status = this.PrepareFaceComponent(face);
    let ready = StrBeginsWith(status, "prepared:");
    let graphPath = "";
    if ready { graphPath = ResRef.ToString(ResourceRef.GetPath(face.graph)); };
    npc.ConvaiFacePrepared(ready, status, graphPath);
  }

  private func PrepareFaceComponent(face: ref<AnimatedComponent>) -> String {
    if !IsDefined(face) {
      return "no-face-rig";
    };
    let original = ResRef.ToString(ResourceRef.GetPath(face.graph));
    let rig = ResourceRef.GetResource(face.rig) as animRig;
    if !IsDefined(rig) {
      return "rig-not-loaded";
    };
    let tracks = ConvaiFaceAssets.RequiredTracks();
    let t = 0;
    while t < ArraySize(tracks) {
      if !ArrayContains(rig.trackNames, tracks[t]) {
        return "unsupported-rig";
      };
      t += 1;
    };
    let i = 0;
    while i < ArraySize(this.m_names) {
      let preparedPath = "cyberpunk_convai\\facial\\" + this.m_names[i] + ".animgraph";
      if Equals(original, preparedPath)
        || Equals(original, "base\\animations\\facial\\_facial_graphs\\" + this.m_names[i] + ".animgraph") {
        if !ResourceRef.IsLoaded(this.m_graphs[i]) || ResourceRef.IsFailed(this.m_graphs[i]) {
          return "speech-graph-not-loaded";
        };
        // Initialize can follow an already prepared extraction. Do not rewrite
        // that instance or modify the loaded graph resource itself.
        if !Equals(original, preparedPath) { face.graph = this.m_graphs[i]; };
        return "prepared:" + this.m_names[i];
      };
      i += 1;
    };
    return "unsupported-graph:" + original;
  }
}

@addField(NPCPuppet)
private let m_convaiFacePrepared: Bool;

@addField(NPCPuppet)
private let m_convaiFaceStatus: String;

@addMethod(NPCPuppet)
public final func ConvaiFacePrepared(ready: Bool, status: String, opt graphPath: String) -> Void {
  this.m_convaiFacePrepared = ready;
  this.m_convaiFaceStatus = status;
  this.m_convaiFaceGraphPath = ready ? graphPath : "";
}

@addField(NPCPuppet)
private let m_convaiFaceGraphPath: String;

@addMethod(NPCPuppet)
public final func ConvaiFaceStatus() -> String {
  return this.m_convaiFaceStatus;
}

@addMethod(NPCPuppet)
public final func ConvaiFaceReady() -> Bool {
  if !this.m_convaiFacePrepared || !this.IsAttached() || this.IsDeadNoStatPool()
    || Equals(this.m_convaiFaceGraphPath, "") { return false; };
  let dynamic = GameInstance.GetDynamicEntitySystem();
  if !IsDefined(dynamic) { return false; };
  // A dynamic entity must be our companion copy. A world NPC is never dynamic,
  // and only ConvaiFaceService.OnWorldInitialize sets its prepared flag.
  if dynamic.IsManaged(this.GetEntityID())
    && !dynamic.IsTagged(this.GetEntityID(), n"CyberpunkConvaiCompanion") { return false; };
  // Appearance changes can replace face_rig after the first initialization.
  // A previously prepared flag never certifies the replacement component.
  let face = this.FindComponentByName(n"face_rig") as AnimatedComponent;
  return IsDefined(face) && ResourceRef.IsLoaded(face.graph) && !ResourceRef.IsFailed(face.graph)
    && Equals(ResRef.ToString(ResourceRef.GetPath(face.graph)), this.m_convaiFaceGraphPath);
}

@addMethod(NPCPuppet)
public final func ConvaiFaceApply(feature: ref<ConvaiFaceFeature>) -> Bool {
  // Readiness carries the ownership check (companion tag or prepared world NPC).
  if !this.ConvaiFaceReady() || !IsDefined(feature) { return false; };
  AnimationControllerComponent.ApplyFeature(this, n"ConvaiFace", feature);
  return true;
}

@addMethod(NPCPuppet)
public final func ConvaiFaceReset() -> Bool {
  return this.ConvaiFaceApply(new ConvaiFaceFeature());
}
