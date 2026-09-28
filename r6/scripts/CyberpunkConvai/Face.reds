// A separate graph is chosen before native component initialization, only for
// dynamic entities tagged by our companion manager. Shared game resources are
// never patched, and this service never owns a live actor or component handle.
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
    if !IsDefined(face) {
      npc.ConvaiFacePrepared(false, "no-face-rig");
      return;
    };
    let original = ResRef.ToString(ResourceRef.GetPath(face.graph));
    let rig = ResourceRef.GetResource(face.rig) as animRig;
    if !IsDefined(rig) {
      npc.ConvaiFacePrepared(false, "rig-not-loaded");
      return;
    };
    let tracks = ConvaiFaceAssets.RequiredTracks();
    let t = 0;
    while t < ArraySize(tracks) {
      if !ArrayContains(rig.trackNames, tracks[t]) {
        npc.ConvaiFacePrepared(false, "unsupported-rig");
        return;
      };
      t += 1;
    };
    let i = 0;
    while i < ArraySize(this.m_names) {
      if Equals(original, "base\\animations\\facial\\_facial_graphs\\" + this.m_names[i] + ".animgraph") {
        if !ResourceRef.IsLoaded(this.m_graphs[i]) || ResourceRef.IsFailed(this.m_graphs[i]) {
          npc.ConvaiFacePrepared(false, "speech-graph-not-loaded");
          return;
        };
        face.graph = this.m_graphs[i];
        npc.ConvaiFacePrepared(true, "prepared:" + this.m_names[i]);
        return;
      };
      i += 1;
    };
    npc.ConvaiFacePrepared(false, "unsupported-graph:" + original);
  }
}

@addField(NPCPuppet)
private let m_convaiFacePrepared: Bool;

@addField(NPCPuppet)
private let m_convaiFaceStatus: String;

@addMethod(NPCPuppet)
public final func ConvaiFacePrepared(ready: Bool, status: String) -> Void {
  this.m_convaiFacePrepared = ready;
  this.m_convaiFaceStatus = status;
}

@addMethod(NPCPuppet)
public final func ConvaiFaceStatus() -> String {
  return this.m_convaiFaceStatus;
}

@addMethod(NPCPuppet)
public final func ConvaiFaceReady() -> Bool {
  return this.m_convaiFacePrepared && this.IsAttached() && !this.IsDeadNoStatPool();
}

@addMethod(NPCPuppet)
public final func ConvaiFaceApply(feature: ref<ConvaiFaceFeature>) -> Bool {
  if !this.ConvaiFaceReady() || !IsDefined(feature) { return false; };
  let dynamic = GameInstance.GetDynamicEntitySystem();
  if !IsDefined(dynamic) || !dynamic.IsTagged(this.GetEntityID(), n"CyberpunkConvaiCompanion") { return false; };
  AnimationControllerComponent.ApplyFeature(this, n"ConvaiFace", feature);
  return true;
}

@addMethod(NPCPuppet)
public final func ConvaiFaceReset() -> Bool {
  return this.ConvaiFaceApply(new ConvaiFaceFeature());
}
