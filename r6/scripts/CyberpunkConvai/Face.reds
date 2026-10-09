// A separate graph is chosen before native component initialization, for
// dynamic entities tagged by our companion manager, and on demand for the one
// or two world NPCs V actually talks to (ConvaiFaceRequest). Every other NPC
// keeps its vanilla face graph and pays nothing. Shared game resources are
// never patched, zero inputs leave the native face unchanged, and this service
// keeps entity IDs and appearance names only, never a live actor or component.
public class ConvaiFaceService extends ScriptableService {
  private let m_names: array<String>;
  private let m_graphs: array<ResourceRef>;
  // Appearance rebuilds requested for talk targets, consumed by the extraction
  // callback; and the world NPCs whose face currently carries the layer.
  private let m_worldPending: array<CName>;
  private let m_worldPrepared: array<EntityID>;

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
    // DynamicEntityTarget is a lifecycle-event filter, not a builder filter.
    // The extraction callback repeats ownership using the builder request ID
    // before touching any newly extracted component instance.
    GameInstance.GetCallbackSystem()
      .RegisterCallback(n"Entity/Extract", this, n"OnCompanionExtract");
  }

  private cb func OnCompanionExtract(event: ref<EntityBuilderEvent>) {
    let builder = event.GetEntityBuilder();
    // A talk target's own requested appearance rebuild. With nothing pending,
    // the normal case, this costs one array size check per build.
    if ArraySize(this.m_worldPending) > 0 && IsDefined(builder) && !builder.HasEntity()
      && builder.HasAppearance() && this.ConsumeWorldRequest(builder.GetAppearanceName()) {
      this.PrepareWorldAppearance(builder);
      return;
    };
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

  // On demand, once per talk target. Ambient and archetype NPCs are spawned by
  // the game, so their running face_rig has the vanilla graph with no
  // ConvaiFace input, and a running component's graph cannot be swapped in
  // place. Rebuilding the NPC's CURRENT appearance re-extracts face_rig (the
  // same seam that replaced Johnny's prepared face on October 2), and the
  // extraction callback above prepares that one rebuild. At most two world
  // NPCs keep the layer; a third request returns the oldest to vanilla.
  public func RequestWorldFace(npc: ref<NPCPuppet>) -> String {
    let dynamic = GameInstance.GetDynamicEntitySystem();
    if !IsDefined(npc) || !npc.IsAttached() || !IsDefined(dynamic) { return "unavailable"; };
    if dynamic.IsManaged(npc.GetEntityID()) { return "managed"; };
    let face = npc.FindComponentByName(n"face_rig") as AnimatedComponent;
    let status = this.PrepareFaceComponent(face, true);
    if StrBeginsWith(status, "prepared:") { this.RememberWorld(npc.GetEntityID()); return status; };
    if !StrBeginsWith(status, "supported:") { return status; };
    // Never rebuild an NPC a quest owns or a scene drives: one in a dialogue, one a
    // quest marked or whose AI a quest or scene commands, or one whose appearance or
    // record belongs to a quest (q004, sq021, mq003..., e.g. the Konpeki receptionists
    // of The Heist). Their voice still plays.
    let scene = GameInstance.GetSceneSystem(npc.GetGame()).GetScriptInterface();
    let inScene = false;
    if IsDefined(scene) {
      if scene.IsEntityInDialogue(npc.GetEntityID()) { return "skipped:dialogue"; };
      inScene = scene.IsEntityInScene(npc.GetEntityID());
    };
    let appearance = npc.GetCurrentAppearanceName();
    if ConvaiFaceService.QuestBound(NameToString(appearance))
      || ConvaiFaceService.QuestBound(TDBID.ToStringDEBUG(npc.GetRecordID())) { return "skipped:quest"; };
    if npc.IsQuest() || !npc.IsOnAutonomousAI() { return "skipped:driven"; };
    // IsEntityInScene is true for plenty of ordinary gameplay (vendors and other
    // community NPCs at their workspots are scene actors), so a scene alone no longer
    // blocks the rebuild. It still does for anyone who is not a crowd or vendor NPC,
    // i.e. every story character, who belong to quests.
    if inScene && !npc.IsVendor() && !npc.IsCrowd() { return "skipped:scene"; };
    npc.ConvaiFaceNoteWorkspot();
    if this.HasWorldRequest(appearance) { return "requested:" + NameToString(appearance); };
    this.ReleaseOldestWorld(npc, appearance);
    if ArraySize(this.m_worldPending) >= 4 { ArrayErase(this.m_worldPending, 0); };
    ArrayPush(this.m_worldPending, appearance);
    this.RememberWorld(npc.GetEntityID());
    npc.ScheduleAppearanceChange(appearance);
    return "requested:" + NameToString(appearance);
  }

  // True for a quest token: "q", "sq" or "mq" right after "_" or "." or at the
  // start, then three digits ("..._q004_...", "Character.sq021_..."). Runs once
  // per conversation start, on two short strings.
  public static func QuestBound(text: String) -> Bool {
    let digits = "0123456789";
    let length = StrLen(text);
    let i = 0;
    while i + 3 < length {
      if Equals(StrMid(text, i, 1), "q")
        && StrContains(digits, StrMid(text, i + 1, 1)) && StrContains(digits, StrMid(text, i + 2, 1))
        && StrContains(digits, StrMid(text, i + 3, 1)) {
        let start = i;
        if start > 0 && (Equals(StrMid(text, start - 1, 1), "s") || Equals(StrMid(text, start - 1, 1), "m")) { start -= 1; };
        if start == 0 || Equals(StrMid(text, start - 1, 1), "_") || Equals(StrMid(text, start - 1, 1), ".") { return true; };
      };
      i += 1;
    };
    return false;
  }

  private func PrepareWorldAppearance(builder: ref<EntityBuilderWrapper>) -> Void {
    let none: ref<NPCPuppet>;
    this.PrepareExtractedComponents(builder.GetAppearance().GetComponents(), none);
  }

  private func HasWorldRequest(appearance: CName) -> Bool {
    let i = 0;
    while i < ArraySize(this.m_worldPending) {
      if Equals(this.m_worldPending[i], appearance) { return true; };
      i += 1;
    };
    return false;
  }

  private func ConsumeWorldRequest(appearance: CName) -> Bool {
    let i = 0;
    while i < ArraySize(this.m_worldPending) {
      if Equals(this.m_worldPending[i], appearance) { ArrayErase(this.m_worldPending, i); return true; };
      i += 1;
    };
    return false;
  }

  private func RememberWorld(id: EntityID) -> Void {
    if !ArrayContains(this.m_worldPrepared, id) { ArrayPush(this.m_worldPrepared, id); };
  }

  // Keeps the layer on at most two world NPCs: the oldest is rebuilt with its
  // vanilla graph (nothing pending matches it). One that shares the new
  // appearance name is only forgotten, so it cannot consume the new request.
  private func ReleaseOldestWorld(next: ref<NPCPuppet>, appearance: CName) -> Void {
    while ArraySize(this.m_worldPrepared) >= 2 {
      let id = this.m_worldPrepared[0];
      ArrayErase(this.m_worldPrepared, 0);
      let old = GameInstance.FindEntityByID(next.GetGame(), id) as NPCPuppet;
      if IsDefined(old) && old.IsAttached() && !Equals(old.GetEntityID(), next.GetEntityID()) {
        let name = old.GetCurrentAppearanceName();
        if !Equals(name, appearance) && !this.HasWorldRequest(name) && !this.SceneOwns(old) {
          old.ConvaiFacePrepared(false, "released");
          old.ScheduleAppearanceChange(name);
        };
      };
    };
  }

  // A quest or dialogue may have taken an NPC since it was prepared. Its layer has
  // zero inputs and does nothing, so such an NPC is only forgotten, never rebuilt
  // under the scene.
  private func SceneOwns(npc: ref<NPCPuppet>) -> Bool {
    let scene = GameInstance.GetSceneSystem(npc.GetGame()).GetScriptInterface();
    return !IsDefined(scene) || scene.IsEntityInDialogue(npc.GetEntityID()) || npc.IsQuest() || !npc.IsOnAutonomousAI();
  }

  private func PrepareFaceComponent(face: ref<AnimatedComponent>, opt check: Bool) -> String {
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
        // A check of a running component (check = true) never writes its graph.
        if Equals(original, preparedPath) { return "prepared:" + this.m_names[i]; };
        if check { return "supported:" + this.m_names[i]; };
        face.graph = this.m_graphs[i];
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

// Whether the NPC stood in a workspot when its rebuild was requested ("in" or
// "out"; empty when none was). One native read per request, never per frame.
@addField(NPCPuppet)
private let m_convaiFaceWorkspot: String;

@addMethod(NPCPuppet)
public final func ConvaiFaceNoteWorkspot() -> Void {
  this.m_convaiFaceWorkspot = GameInstance.GetWorkspotSystem(this.GetGame()).IsActorInWorkspot(this) ? "in" : "out";
}

// "in>in" for a vendor that kept its workspot through the rebuild, "in>out" for one
// that lost it, empty when this NPC was never rebuilt. Read once per reply for the log.
@addMethod(NPCPuppet)
public final func ConvaiFaceWorkspotNote() -> String {
  if Equals(this.m_convaiFaceWorkspot, "") { return ""; };
  return this.m_convaiFaceWorkspot + ">" + (GameInstance.GetWorkspotSystem(this.GetGame()).IsActorInWorkspot(this) ? "in" : "out");
}

@addMethod(NPCPuppet)
public final func ConvaiFaceStatus() -> String {
  return this.m_convaiFaceStatus;
}

@addMethod(NPCPuppet)
public final func ConvaiFaceReady() -> Bool {
  if !this.IsAttached() || this.IsDeadNoStatPool() { return false; };
  let dynamic = GameInstance.GetDynamicEntitySystem();
  if !IsDefined(dynamic) { return false; };
  if dynamic.IsManaged(this.GetEntityID()) {
    // A dynamic entity must be our companion copy.
    if !dynamic.IsTagged(this.GetEntityID(), n"CyberpunkConvaiCompanion") { return false; };
  } else {
    if !this.m_convaiFacePrepared && !this.ConvaiFaceAdoptWorld() { return false; };
  };
  if !this.m_convaiFacePrepared || Equals(this.m_convaiFaceGraphPath, "") { return false; };
  // Appearance changes can replace face_rig after the first initialization.
  // A previously prepared flag never certifies the replacement component.
  let face = this.FindComponentByName(n"face_rig") as AnimatedComponent;
  return IsDefined(face) && ResourceRef.IsLoaded(face.graph) && !ResourceRef.IsFailed(face.graph)
    && Equals(ResRef.ToString(ResourceRef.GetPath(face.graph)), this.m_convaiFaceGraphPath);
}

// A world NPC is prepared only by its own requested rebuild, which leaves our
// graph on the running face_rig; the extraction had no puppet to flag. Called
// only for the current speaker while it is not yet prepared.
@addMethod(NPCPuppet)
private final func ConvaiFaceAdoptWorld() -> Bool {
  let face = this.FindComponentByName(n"face_rig") as AnimatedComponent;
  if !IsDefined(face) || !ResourceRef.IsLoaded(face.graph) || ResourceRef.IsFailed(face.graph) { return false; };
  let path = ResRef.ToString(ResourceRef.GetPath(face.graph));
  if !StrBeginsWith(path, "cyberpunk_convai\\facial\\") { return false; };
  this.ConvaiFacePrepared(true, "prepared:world", path);
  return true;
}

// The talk target asks for the layer (init.lua, when a conversation opens).
// Returns a short status; repeated calls for a prepared NPC change nothing.
@addMethod(NPCPuppet)
public final func ConvaiFaceRequest() -> String {
  let service = GameInstance.GetScriptableServiceContainer().GetService(n"ConvaiFaceService") as ConvaiFaceService;
  if !IsDefined(service) { return "service-unavailable"; };
  let status = service.RequestWorldFace(this);
  if !this.m_convaiFacePrepared { this.m_convaiFaceStatus = status; };
  return status;
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
