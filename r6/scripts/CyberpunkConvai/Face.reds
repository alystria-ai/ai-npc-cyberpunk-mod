// A separate graph is chosen before native component initialization:
//  - for dynamic entities tagged by our companion manager (the ungated ConvaiFace graph, as always);
//  - for ordinary world NPCs (crowd, vendors, gangs and the other archetype characters), once per NPC, at spawn
//    (OnWorldInitialize), with a gated copy of the same graph: the speech layer sits behind one Switch that stays
//    closed until the mod voices that NPC, so a face that is not speaking evaluates one switch more than vanilla.
// Story and quest characters, named roster characters (Johnny included, his record also uses man_average_sermo) and
// every NPC whose face is not one of the four crowd graphs keep the vanilla graph. Shared game resources are never
// patched, zero inputs leave the native face unchanged, and this service keeps entity IDs and strings only, never a
// live actor or component. There is no per-frame work here: one callback per NPC spawn, one call per conversation.
public class ConvaiFaceService extends ScriptableService {
  private let m_names: array<String>;
  private let m_graphs: array<ResourceRef>;
  // Ordinary NPCs: the gated copies (shipping), the ungated companion graphs (an FPS comparison only), the record IDs
  // of the named roster (generated from the character data into FaceFeature.reds) and the rigs already checked.
  private let m_crowdNames: array<String>;
  private let m_crowdGated: array<ResourceRef>;
  private let m_crowdPlain: array<ResourceRef>;
  private let m_crowdVanilla: array<String>;
  private let m_named: array<TweakDBID>;
  private let m_verifiedRigs: array<String>;
  // 1 gated (shipping), 2 ungated, 0 off: the last two exist only to measure what the gate saves (docs/FACIAL_ANIMATION.md,
  // "Ordinary NPCs", set from mod/facial-playback.lua by runtime/crowd-face-mode.txt). It applies to NPCs that spawn afterwards.
  private let m_crowdMode: Int32;

  private cb func OnLoad() {
    this.m_names = ConvaiFaceAssets.Names();
    let i = 0;
    while i < ArraySize(this.m_names) {
      ArrayPush(this.m_graphs, ResourceRef.FromPath(ResRef.FromString("cyberpunk_convai\\facial\\" + this.m_names[i] + ".animgraph")));
      i += 1;
    };
    this.m_crowdNames = ConvaiFaceAssets.CrowdNames();
    let folder = ConvaiFaceAssets.CrowdFolder();
    i = 0;
    while i < ArraySize(this.m_crowdNames) {
      ArrayPush(this.m_crowdGated, ResourceRef.FromPath(ResRef.FromString(folder + this.m_crowdNames[i] + ".animgraph")));
      ArrayPush(this.m_crowdPlain, ResourceRef.FromPath(ResRef.FromString("cyberpunk_convai\\facial\\" + this.m_crowdNames[i] + ".animgraph")));
      ArrayPush(this.m_crowdVanilla, "base\\animations\\facial\\_facial_graphs\\" + this.m_crowdNames[i] + ".animgraph");
      i += 1;
    };
    let records = ConvaiFaceAssets.NamedRecords();
    i = 0;
    while i < ArraySize(records) {
      ArrayPush(this.m_named, TDBID.Create(records[i]));
      i += 1;
    };
    this.m_crowdMode = 1;
    GameInstance.GetCallbackSystem()
      .RegisterCallback(n"Entity/Initialize", this, n"OnCompanionInitialize")
      .AddTarget(DynamicEntityTarget.Tag(n"CyberpunkConvaiCompanion"));
    // Ordinary NPCs: one callback per NPC spawn, filtered to the NPCPuppet type by the callback system itself.
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

  // Ordinary world NPCs, once per spawn, before the face component initializes (so no flash and no rebuild). The game
  // spawns them with a vanilla face graph that has no ConvaiFace input, and a running component's graph cannot be
  // swapped (a same-name appearance change is a no-op, measured 2026-10-10), so the choice is made here or never.
  // Cheap filters first, in order: mode, our own companion copies and other mods' spawns (dynamic entities), the face
  // graph (only the four crowd graphs), the record and the named roster, then the quest tokens. A skipped NPC keeps
  // its vanilla graph and only remembers why. A prepared NPC is written only when the Lua speech owner voices it
  // (ConvaiFaceRequest and the talk-time guards, ConvaiFaceReady).
  private cb func OnWorldInitialize(event: ref<EntityLifecycleEvent>) {
    if this.m_crowdMode == 0 { return; };
    let npc = event.GetEntity() as NPCPuppet;
    if !IsDefined(npc) { return; };
    let dynamic = GameInstance.GetDynamicEntitySystem();
    if !IsDefined(dynamic) || dynamic.IsManaged(npc.GetEntityID()) { return; };
    let face = npc.FindComponentByName(n"face_rig") as AnimatedComponent;
    if !IsDefined(face) { return; };
    let index = this.CrowdIndex(ResRef.ToString(ResourceRef.GetPath(face.graph)));
    if index < 0 { return; };
    let record = npc.GetRecordID();
    let recordValid = TDBID.IsValid(record);
    let reason = ConvaiFaceService.CrowdSkipReason(recordValid, recordValid && ArrayContains(this.m_named, record), "", "");
    if Equals(reason, "") {
      reason = ConvaiFaceService.CrowdSkipReason(true, false, NameToString(npc.GetCurrentAppearanceName()), TDBID.ToStringDEBUG(record));
    };
    if !Equals(reason, "") { npc.ConvaiFacePrepared(false, reason); return; };
    let rig = this.CheckRig(face);
    if !Equals(rig, "") { npc.ConvaiFacePrepared(false, rig); return; };
    let graph = this.m_crowdGated[index];
    if this.m_crowdMode == 2 { graph = this.m_crowdPlain[index]; };
    if !ResourceRef.IsLoaded(graph) || ResourceRef.IsFailed(graph) {
      npc.ConvaiFacePrepared(false, "speech-graph-not-loaded");
      return;
    };
    face.graph = graph;
    npc.ConvaiFacePrepared(true, "prepared:" + this.m_crowdNames[index], ResRef.ToString(ResourceRef.GetPath(graph)));
  }

  // The crowd graph (0 to 3) that a face graph path names, or -1. Only the vanilla path counts: anything else (the
  // player's and Judy's photo-mode graphs, other rigs, a face that already runs one of our graphs) is not touched.
  private func CrowdIndex(path: String) -> Int32 {
    let i = 0;
    while i < ArraySize(this.m_crowdVanilla) {
      if Equals(path, this.m_crowdVanilla[i]) { return i; };
      i += 1;
    };
    return -1;
  }

  // The 59 lipsync tracks must exist on the rig; checked once per rig path, not per NPC.
  private func CheckRig(face: ref<AnimatedComponent>) -> String {
    let path = ResRef.ToString(ResourceRef.GetPath(face.rig));
    if ArrayContains(this.m_verifiedRigs, path) { return ""; };
    let rig = ResourceRef.GetResource(face.rig) as animRig;
    if !IsDefined(rig) { return "rig-not-loaded"; };
    let tracks = ConvaiFaceAssets.RequiredTracks();
    let t = 0;
    while t < ArraySize(tracks) {
      if !ArrayContains(rig.trackNames, tracks[t]) { return "unsupported-rig"; };
      t += 1;
    };
    ArrayPush(this.m_verifiedRigs, path);
    return "";
  }

  // Why an NPC with a crowd graph stays vanilla, or "" when it is ordinary: no readable record (fail closed, so a story
  // character is never touched by mistake), a named roster record, or a quest token in the appearance or the record
  // (q004, sq021, mq003...). The named roster is the one thing the graph and the tokens cannot tell apart: Johnny's
  // record uses man_average_sermo. The strings are only read for an NPC the cheap checks passed.
  public static func CrowdSkipReason(recordValid: Bool, named: Bool, appearance: String, record: String) -> String {
    if !recordValid { return "skipped:no-record"; };
    if named { return "skipped:named"; };
    if ConvaiFaceService.QuestBound(appearance) || ConvaiFaceService.QuestBound(record) { return "skipped:quest"; };
    return "";
  }

  // Development switch for the FPS comparison: "off" (no ordinary NPC is touched, vanilla), "ungated" (the speech layer
  // on every ordinary face, always evaluated) or "gated" (shipping). Applies to NPCs that spawn after the call, so
  // reload the save. Any other word changes nothing. Returns the mode now in effect.
  public func SetCrowdMode(mode: String) -> String {
    if Equals(mode, "off") { this.m_crowdMode = 0; };
    if Equals(mode, "gated") { this.m_crowdMode = 1; };
    if Equals(mode, "ungated") { this.m_crowdMode = 2; };
    return this.CrowdMode();
  }

  public func CrowdMode() -> String {
    if this.m_crowdMode == 0 { return "off"; };
    if this.m_crowdMode == 2 { return "ungated"; };
    return "gated";
  }

  // The talk-time guards, once per conversation start for an NPC that carries the layer. They cannot matter for an NPC
  // the spawn filter let through, except for a quest that took it since or a record the filter could not know: such an
  // NPC is only refused here (it keeps an inert, switched-off graph, never written), its voice still plays.
  public func TalkRefusal(npc: ref<NPCPuppet>) -> String {
    // A dialogue in progress, one a quest marked or whose AI a quest or scene commands, and one whose appearance or
    // record belongs to a quest. A scene alone is no reason: vendors and community NPCs at their workspots are scene
    // actors, and the spawn filter already kept the story characters out.
    let scene = GameInstance.GetSceneSystem(npc.GetGame()).GetScriptInterface();
    if IsDefined(scene) && scene.IsEntityInDialogue(npc.GetEntityID()) { return "skipped:dialogue"; };
    if ConvaiFaceService.QuestBound(NameToString(npc.GetCurrentAppearanceName()))
      || ConvaiFaceService.QuestBound(TDBID.ToStringDEBUG(npc.GetRecordID())) { return "skipped:quest"; };
    if npc.IsQuest() || !npc.IsOnAutonomousAI() { return "skipped:driven"; };
    return "";
  }

  // True for a quest token: "q", "sq" or "mq" right after "_" or "." or at the
  // start, then three digits ("..._q004_...", "Character.sq021_..."). Runs once
  // per NPC spawn and once per conversation start, on two short strings.
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
        if Equals(original, preparedPath) { return "prepared:" + this.m_names[i]; };
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

// The reason a conversation start refused this NPC (a dialogue, a quest, a commanded AI): the layer stays inert and
// unwritten. Empty when it was never refused, or when the latest start cleared it.
@addField(NPCPuppet)
private let m_convaiFaceRefusal: String;

// What the Lua log shows: the refusal while there is one, otherwise how the face was prepared.
@addMethod(NPCPuppet)
public final func ConvaiFaceStatus() -> String {
  if !Equals(this.m_convaiFaceRefusal, "") { return this.m_convaiFaceRefusal; };
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
    if !Equals(this.m_convaiFaceRefusal, "") { return false; };
    if !this.m_convaiFacePrepared && !this.ConvaiFaceAdoptWorld() { return false; };
  };
  if !this.m_convaiFacePrepared || Equals(this.m_convaiFaceGraphPath, "") { return false; };
  // Appearance changes can replace face_rig after the first initialization.
  // A previously prepared flag never certifies the replacement component.
  let face = this.FindComponentByName(n"face_rig") as AnimatedComponent;
  return IsDefined(face) && ResourceRef.IsLoaded(face.graph) && !ResourceRef.IsFailed(face.graph)
    && Equals(ResRef.ToString(ResourceRef.GetPath(face.graph)), this.m_convaiFaceGraphPath);
}

// A world NPC is prepared at its spawn (OnWorldInitialize), which sets the flag. This only recognizes a face that
// already runs one of our graphs without the flag (an NPC prepared before a script reload). Called only for the
// current speaker while it is not yet prepared.
@addMethod(NPCPuppet)
private final func ConvaiFaceAdoptWorld() -> Bool {
  let face = this.FindComponentByName(n"face_rig") as AnimatedComponent;
  if !IsDefined(face) || !ResourceRef.IsLoaded(face.graph) || ResourceRef.IsFailed(face.graph) { return false; };
  let path = ResRef.ToString(ResourceRef.GetPath(face.graph));
  if !StrBeginsWith(path, "cyberpunk_convai\\facial\\") { return false; };
  this.ConvaiFacePrepared(true, "prepared:world", path);
  return true;
}

// The talk target asks for the layer (init.lua, when a conversation opens). Nothing is built here: an ordinary NPC
// was prepared at its spawn or it was not, and the answer is the status of that decision plus the talk-time guards.
// "managed" for a dynamic entity, "prepared:<graph>" when the mouth can follow the voice, otherwise why not.
@addMethod(NPCPuppet)
public final func ConvaiFaceRequest() -> String {
  let service = GameInstance.GetScriptableServiceContainer().GetService(n"ConvaiFaceService") as ConvaiFaceService;
  if !IsDefined(service) { return "service-unavailable"; };
  let dynamic = GameInstance.GetDynamicEntitySystem();
  if !this.IsAttached() || !IsDefined(dynamic) { return "unavailable"; };
  if dynamic.IsManaged(this.GetEntityID()) { return "managed"; };
  if !this.m_convaiFacePrepared && !this.ConvaiFaceAdoptWorld() {
    // Skipped at spawn (the reason is remembered), a graph that is not a crowd graph, or an NPC that spawned
    // before the scripts or while the mode was off.
    if !Equals(this.m_convaiFaceStatus, "") { return this.m_convaiFaceStatus; };
    let face = this.FindComponentByName(n"face_rig") as AnimatedComponent;
    if !IsDefined(face) { return "no-face-rig"; };
    return "unprepared:" + ResRef.ToString(ResourceRef.GetPath(face.graph));
  };
  this.m_convaiFaceRefusal = service.TalkRefusal(this);
  if !Equals(this.m_convaiFaceRefusal, "") { return this.m_convaiFaceRefusal; };
  return this.m_convaiFaceStatus;
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
