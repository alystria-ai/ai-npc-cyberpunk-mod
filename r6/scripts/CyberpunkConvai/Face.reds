// A separate graph is chosen before native component initialization:
//  - for dynamic entities tagged by our companion manager (the ungated ConvaiFace graph, as always);
//  - while an add-on watches a face_rig rig (WatchScreenFace: the Delamain cab's seat-back screen face), for the NPC that
//    spawns with that rig and a crowd graph, with the same gated copy (PrepareScreenFace);
//  - for ordinary world NPCs (crowd, vendors, gangs and the other archetype characters), once per NPC, at spawn
//    (OnWorldInitialize), with a gated copy of the same graph: the speech layer sits behind one Switch that stays
//    closed until the mod voices that NPC, so a face that is not speaking evaluates one switch more than vanilla;
//  - for characters another mod or a spawner created (docs/SPAWNED_CHARACTERS.md: managed by the dynamic entity system,
//    none of our tags), at spawn and again at each appearance rebuild (outfit changes rebuild face_rig): the gated crowd
//    copy on a crowd graph, and on Judy's photo-mode graph or the paperdoll pair the companion graph our own copy of that
//    character carries. They are player-made, so the roster and quest filters do not apply to them.
//  - for the game's own named characters (the roster records in NamedRecords: Judy, Jackie, Panam, Rogue and the rest) while
//    "Talk to story characters" is on (SetStoryTalk, set from mod/facial-playback.lua applyStoryTalk, on by default; docs/
//    WORLD_CHARACTERS.md), once at spawn (OnWorldInitialize, PrepareStoryFace): the same preparation as a spawned character, the
//    gated crowd copy on a crowd graph and the companion graph on Judy's photo-mode graph or the paperdoll pair. The speech
//    layer is inert until the mod voices that character, so a scene or the character's own animation sees the vanilla face.
// Other story and quest characters, named roster characters while that setting is off (Johnny included, his record also uses
// man_average_sermo) and every NPC whose face is not one of the four crowd graphs keep the vanilla graph. Shared game resources are never
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
  // The gated copies' paths, to recognise a spawned character's face that an earlier extraction already prepared.
  private let m_crowdGatedPaths: array<String>;
  private let m_named: array<TweakDBID>;
  private let m_verifiedRigs: array<String>;
  // 1 gated (shipping), 2 ungated, 0 off: the last two exist only to measure what the gate saves (docs/FACIAL_ANIMATION.md,
  // "Ordinary NPCs", set from mod/facial-playback.lua by runtime/crowd-face-mode.txt). It applies to NPCs that spawn afterwards.
  private let m_crowdMode: Int32;
  // "Talk to story characters" (docs/WORLD_CHARACTERS.md): the named roster characters the game placed get the speaking face at
  // their spawn and their talk-time guard below. Set by the Lua side before a world loads; on until it says otherwise.
  private let m_storyTalk: Bool;
  // Screen faces (docs/FACIAL_ANIMATION.md, "A face on a screen"): the face_rig rig paths an add-on watches now (the Delamain cab
  // while a cab exists: the NPC the seat-back screens film carries Delamain's own head rig) and, per rig, the last NPC prepared
  // for it. Empty unless an add-on asked (mod/addons.lua handle:watchFace), so without add-ons nothing here ever runs.
  private let m_screenRigs: array<String>;
  private let m_screenIDs: array<EntityID>;
  // Rebuilds of a spawned character's appearance (docs/SPAWNED_CHARACTERS.md, "Appearance changes"). The game builds a
  // rebuild's components with no entity ID (the builder names nobody), so the extraction cannot tell whose face it is.
  // Once a spawned character has been seen (m_spawnedSeen), an extraction that names nobody and carries no entity part
  // leaves its face_rig clones here (weak, at most six) with a key for the entity template; the entity's own
  // Reassemble event, which does name the entity, then prepares the clones of its own template before they initialize.
  // Nothing is kept until a spawned character exists, and no component is held alive. The counters are for the status line.
  private let m_spawnedSeen: Bool;
  private let m_rebuildFaces: array<wref<AnimatedComponent>>;
  private let m_rebuildTemplates: array<Uint64>;
  private let m_rebuildStashed: Int32;
  private let m_rebuildSeen: Int32;
  private let m_rebuildApplied: Int32;
  private let m_rebuildMissed: Int32;

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
      ArrayPush(this.m_crowdGatedPaths, folder + this.m_crowdNames[i] + ".animgraph");
      i += 1;
    };
    let records = ConvaiFaceAssets.NamedRecords();
    i = 0;
    while i < ArraySize(records) {
      ArrayPush(this.m_named, TDBID.Create(records[i]));
      i += 1;
    };
    this.m_crowdMode = 1;
    this.m_storyTalk = true;
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
    // An appearance rebuild names its entity here (and only here): the second half of PrepareRebuiltFace.
    GameInstance.GetCallbackSystem()
      .RegisterCallback(n"Entity/Reassemble", this, n"OnReassemble")
      .AddTarget(EntityTarget.Type(n"NPCPuppet"));
  }

  private cb func OnCompanionExtract(event: ref<EntityBuilderEvent>) {
    let builder = event.GetEntityBuilder();
    let dynamic = GameInstance.GetDynamicEntitySystem();
    if !IsDefined(builder) || !IsDefined(dynamic) { return; };
    // Every entity the game builds reaches this callback: a game-placed one stops at the first lookup. A rebuild of an
    // existing entity's appearance names no entity at all (measured: entity ID 0, no entity part), so it is only noted,
    // and only once a spawned character exists.
    if !dynamic.IsManaged(builder.GetEntityID()) {
      if this.m_spawnedSeen { this.NoteRebuild(builder); };
      return;
    };
    let spawned = false;
    if !dynamic.IsTagged(builder.GetEntityID(), n"CyberpunkConvaiCompanion") {
      // A character another mod or a spawner created: an outfit change rebuilds face_rig with the vanilla graph, so its
      // speaking face is prepared again on every rebuild (the ordinary-NPC layer, inert until the mod voices it).
      if this.m_crowdMode == 0 || !ConvaiFaceService.SpawnedElsewhere(dynamic, builder.GetEntityID()) { return; };
      spawned = true;
      this.m_spawnedSeen = true;
    };
    // These wrappers expose this builder's extracted component clones, not
    // shared .ent/.app definitions. They also cover appearance-only rebuilds.
    let npc = dynamic.GetEntity(builder.GetEntityID()) as NPCPuppet;
    // A holocall's live-picture copy (mod/holocall.lua) is filmed far from V's camera, where the game stops animating a
    // face (measured: it moves at 8 and 11 m, it is frozen at 16 m and beyond). Its animated components are asked to stay
    // at full detail before they attach, as runtime changes are ignored. Only that one copy, for the call's length.
    let holocall = !spawned && dynamic.IsTagged(builder.GetEntityID(), n"CyberpunkConvaiHolocall");
    if builder.HasEntity() {
      let template = builder.GetTemplate();
      if !IsDefined(npc) { npc = template.GetEntity() as NPCPuppet; };
      this.PrepareExtractedComponents(template.GetComponents(), npc, holocall, spawned);
    };
    if builder.HasAppearance() {
      this.PrepareExtractedComponents(builder.GetAppearance().GetComponents(), npc, holocall, spawned);
    };
    let appearances = builder.GetCustomAppearances();
    let i = 0;
    while i < ArraySize(appearances) {
      this.PrepareExtractedComponents(appearances[i].GetComponents(), npc, holocall, spawned);
      i += 1;
    };
  }

  private func PrepareExtractedComponents(components: array<ref<IComponent>>, npc: ref<NPCPuppet>, holocall: Bool, spawned: Bool) -> Void {
    let i = 0;
    while i < ArraySize(components) {
      let face = components[i] as AnimatedComponent;
      if holocall && IsDefined(face) {
        face.clientForcedLod = 0;
        face.clientForcedVisibility = true;
        face.useLongRangeVisibility = true;
      };
      if IsDefined(face) && Equals(face.GetName(), n"face_rig") {
        let status = spawned ? this.PrepareSpawnedFace(face) : this.PrepareFaceComponent(face);
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

  // First half of a spawned character's rebuild: an extraction that names no entity and has no entity part (an appearance
  // change of something that already exists) leaves its face_rig clones, with a key for the entity template, until that
  // entity's Reassemble claims them. Runs only after a spawned character was seen, only for such an extraction (rare: a
  // quest or a mod changing an appearance), reads no strings and holds no component alive.
  private func NoteRebuild(builder: ref<EntityBuilderWrapper>) -> Void {
    if this.m_crowdMode == 0 || builder.HasEntity() || !builder.HasAppearance() { return; };
    if EntityID.IsDefined(builder.GetEntityID()) { return; };
    let template = builder.GetTemplate().GetResource();
    if !IsDefined(template) { return; };
    let key = ResRef.GetHash(template.path);
    let appearance = builder.GetAppearance();
    if IsDefined(appearance) { this.NoteRebuiltFaces(appearance.GetComponents(), key); };
    let customs = builder.GetCustomAppearances();
    let i = 0;
    while i < ArraySize(customs) {
      this.NoteRebuiltFaces(customs[i].GetComponents(), key);
      i += 1;
    };
  }

  private func NoteRebuiltFaces(components: array<ref<IComponent>>, key: Uint64) -> Void {
    let i = 0;
    while i < ArraySize(components) {
      let face = components[i] as AnimatedComponent;
      if IsDefined(face) && Equals(face.GetName(), n"face_rig") {
        // Oldest first out: an entry that no Reassemble claimed (a prefetch, a game character) never accumulates.
        if ArraySize(this.m_rebuildFaces) >= 6 {
          ArrayErase(this.m_rebuildFaces, 0);
          ArrayErase(this.m_rebuildTemplates, 0);
        };
        ArrayPush(this.m_rebuildFaces, face);
        ArrayPush(this.m_rebuildTemplates, key);
        this.m_rebuildStashed += 1;
      };
      i += 1;
    };
  }

  // Second half: the spawned character's own appearance rebuild. The Reassemble event fires after the builder extracted
  // the new components and before they join the entity and initialize, so a face_rig noted for this entity template can
  // still take the speaking graph (exactly as at the first build). Every note of the template is prepared (they only
  // differ when a prefetch and the real rebuild both extracted); the status and graph path go to the puppet from the
  // newest. A game character, our own copy and an entity of another template are never matched.
  private cb func OnReassemble(event: ref<EntityLifecycleEvent>) {
    if !this.m_spawnedSeen || this.m_crowdMode == 0 { return; };
    let npc = event.GetEntity() as NPCPuppet;
    let dynamic = GameInstance.GetDynamicEntitySystem();
    if !IsDefined(npc) || !IsDefined(dynamic) || !ConvaiFaceService.SpawnedElsewhere(dynamic, npc.GetEntityID()) { return; };
    this.m_rebuildSeen += 1;
    if ArraySize(this.m_rebuildFaces) == 0 {
      this.m_rebuildMissed += 1;
      return;
    };
    let key = ResRef.GetHash(npc.GetTemplatePath());
    let status = "";
    let graphPath = "";
    let i = ArraySize(this.m_rebuildFaces) - 1;
    while i >= 0 {
      if this.m_rebuildTemplates[i] == key {
        let face = this.m_rebuildFaces[i];
        if IsDefined(face) {
          let result = this.PrepareSpawnedFace(face);
          if Equals(status, "") {
            status = result;
            graphPath = ResRef.ToString(ResourceRef.GetPath(face.graph));
          };
          this.m_rebuildApplied += 1;
        };
        ArrayErase(this.m_rebuildFaces, i);
        ArrayErase(this.m_rebuildTemplates, i);
      };
      i -= 1;
    };
    if !Equals(status, "") {
      npc.ConvaiFacePrepared(StrBeginsWith(status, "prepared:"), status, graphPath);
    } else {
      this.m_rebuildMissed += 1;
    };
  }

  // What the status line adds when the face was prepared and a rebuild replaced it anyway: how many rebuilds were noted and
  // claimed, so one more live check says where a missing preparation was lost (docs/SPAWNED_CHARACTERS.md).
  public func RebuildCounts() -> String {
    return "noted=" + IntToString(this.m_rebuildStashed) + " claimed=" + IntToString(this.m_rebuildApplied)
      + " reassembled=" + IntToString(this.m_rebuildSeen) + " unmatched=" + IntToString(this.m_rebuildMissed);
  }

  // Ordinary world NPCs, once per spawn, before the face component initializes (so no flash and no rebuild). The game
  // spawns them with a vanilla face graph that has no ConvaiFace input, and a running component's graph cannot be
  // swapped (a same-name appearance change is a no-op, measured 2026-10-10), so the choice is made here or never.
  // Cheap filters first, in order: mode, our own companion copies and other mods' spawns (dynamic entities), the face
  // graph (only the four crowd graphs), the record and the named roster, then the quest tokens. A skipped NPC keeps
  // its vanilla graph and only remembers why. A prepared NPC is written only when the Lua speech owner voices it
  // (ConvaiFaceRequest and the talk-time guards, ConvaiFaceReady).
  private cb func OnWorldInitialize(event: ref<EntityLifecycleEvent>) {
    let screens = ArraySize(this.m_screenRigs) > 0;
    if this.m_crowdMode == 0 && !screens { return; };
    let npc = event.GetEntity() as NPCPuppet;
    if !IsDefined(npc) { return; };
    let dynamic = GameInstance.GetDynamicEntitySystem();
    if !IsDefined(dynamic) { return; };
    // Our own copies take OnCompanionInitialize. A character another mod or a spawner created (docs/SPAWNED_CHARACTERS.md)
    // takes PrepareSpawnedFace: player-made, never a quest's actor, so the roster and quest filters below do not apply (a
    // spawned Judy is meant to talk). Every other dynamic entity is left alone.
    if dynamic.IsManaged(npc.GetEntityID()) {
      if this.m_crowdMode == 0 || !ConvaiFaceService.SpawnedElsewhere(dynamic, npc.GetEntityID()) { return; };
      this.m_spawnedSeen = true;
      let spawnedFace = npc.FindComponentByName(n"face_rig") as AnimatedComponent;
      if !IsDefined(spawnedFace) { return; };
      let spawnedStatus = this.PrepareSpawnedFace(spawnedFace);
      npc.ConvaiFacePrepared(StrBeginsWith(spawnedStatus, "prepared:"), spawnedStatus, ResRef.ToString(ResourceRef.GetPath(spawnedFace.graph)));
      return;
    };
    let face = npc.FindComponentByName(n"face_rig") as AnimatedComponent;
    if !IsDefined(face) { return; };
    let index = this.CrowdIndex(ResRef.ToString(ResourceRef.GetPath(face.graph)));
    if index >= 0 && screens && this.PrepareScreenFace(npc, face, index) { return; };
    // The game's own named characters (Judy, Jackie, Panam ...) whom the player may talk to: whatever their graph, one preparation.
    if this.m_storyTalk && this.m_crowdMode != 0 && this.PrepareStoryFace(npc, face) { return; };
    if index < 0 { return; };
    if this.m_crowdMode == 0 { return; };
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

  // A named roster character the game placed (NamedRecords) gets the speaking face at its spawn, on a crowd graph or on the graph
  // our own copy of that character carries (PrepareSpawnedFace), whatever its record's quest flag: the roster is the list of
  // people the player may talk to, and the talk-time guard (TalkRefusal) and the Lua side keep it out of scenes. True when the
  // record is on the roster (handled, prepared or not); false leaves the ordinary-NPC filters to decide.
  private func PrepareStoryFace(npc: ref<NPCPuppet>, face: ref<AnimatedComponent>) -> Bool {
    let record = npc.GetRecordID();
    if !TDBID.IsValid(record) || !ArrayContains(this.m_named, record) { return false; };
    let status = this.PrepareSpawnedFace(face);
    npc.ConvaiFacePrepared(StrBeginsWith(status, "prepared:"), status, ResRef.ToString(ResourceRef.GetPath(face.graph)));
    return true;
  }

  // Talk to story characters (the setting): applies to characters that spawn afterwards, so a save reload picks a change up.
  public func SetStoryTalk(on: Bool) -> Bool {
    this.m_storyTalk = on;
    return this.m_storyTalk;
  }

  public func StoryTalk() -> Bool {
    return this.m_storyTalk;
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

  // A watched screen face: an NPC whose face_rig runs a crowd graph on a rig an add-on watches gets the gated copy of that graph,
  // whatever its record says (the rig itself names the one character, and the watch lasts only while the add-on's moment does:
  // the Delamain cab's screen NPC is a story character's head filmed for the seat-back screens, so the named and quest filters
  // would keep it vanilla). The gate keeps it exactly vanilla until the add-on's own line plays. True when the rig was watched.
  private func PrepareScreenFace(npc: ref<NPCPuppet>, face: ref<AnimatedComponent>, index: Int32) -> Bool {
    let slot = this.ScreenSlot(ResRef.ToString(ResourceRef.GetPath(face.rig)));
    if slot < 0 { return false; };
    let rig = this.CheckRig(face);
    if !Equals(rig, "") { npc.ConvaiFacePrepared(false, "screen:" + rig); return true; };
    let graph = this.m_crowdGated[index];
    if !ResourceRef.IsLoaded(graph) || ResourceRef.IsFailed(graph) {
      npc.ConvaiFacePrepared(false, "screen:speech-graph-not-loaded");
      return true;
    };
    face.graph = graph;
    this.m_screenIDs[slot] = npc.GetEntityID();
    npc.ConvaiFacePrepared(true, "prepared:" + this.m_crowdNames[index], ResRef.ToString(ResourceRef.GetPath(graph)));
    return true;
  }

  private func ScreenSlot(rig: String) -> Int32 {
    let i = 0;
    while i < ArraySize(this.m_screenRigs) {
      if Equals(this.m_screenRigs[i], rig) { return i; };
      i += 1;
    };
    return -1;
  }

  // Starts or ends the watch of one face_rig rig path (an add-on, through mod/addons.lua). It applies to NPCs that spawn while
  // it lasts; ending it forgets the rig and its NPC (an NPC already prepared keeps its inert, gated graph until it despawns).
  // At most 4 rigs. Returns the number of rigs watched now.
  public func WatchScreenFace(rig: String, watch: Bool) -> Int32 {
    let slot = this.ScreenSlot(rig);
    if watch && slot < 0 && ArraySize(this.m_screenRigs) < 4 && StrEndsWith(rig, ".rig") {
      ArrayPush(this.m_screenRigs, rig);
      let none: EntityID;
      ArrayPush(this.m_screenIDs, none);
    };
    if !watch && slot >= 0 {
      ArrayErase(this.m_screenRigs, slot);
      ArrayErase(this.m_screenIDs, slot);
    };
    return ArraySize(this.m_screenRigs);
  }

  // The last NPC prepared for a watched rig (an undefined ID when none spawned since the watch began, or the rig is not watched).
  public func ScreenFace(rig: String) -> EntityID {
    let slot = this.ScreenSlot(rig);
    let none: EntityID;
    if slot < 0 { return none; };
    return this.m_screenIDs[slot];
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
  public func TalkRefusal(npc: ref<NPCPuppet>, opt spawned: Bool) -> String {
    // A dialogue in progress, one a quest marked or whose AI a quest or scene commands, and one whose appearance or
    // record belongs to a quest. A scene alone is no reason: vendors and community NPCs at their workspots are scene
    // actors, and the spawn filter already kept the story characters out.
    let scene = GameInstance.GetSceneSystem(npc.GetGame()).GetScriptInterface();
    if IsDefined(scene) && scene.IsEntityInDialogue(npc.GetEntityID()) { return "skipped:dialogue"; };
    // A character another mod or a spawner created: only a quest marking it refuses it. Its AI is commanded by that mod
    // (follow, pose), not by a quest, and a quest-named record or appearance is only the model the player chose.
    if spawned {
      if npc.IsQuest() { return "skipped:quest"; };
      return "";
    };
    // A named character of the game that the player may talk to (docs/WORLD_CHARACTERS.md): its quest flag and a quest-named record
    // are what it is, not a scene. Only an AI that a scene or quest commands refuses it here (a dialogue was refused above); the Lua
    // side adds combat, injury, a ride and V's own quest conversation before any reply starts.
    if this.m_storyTalk && ArrayContains(this.m_named, npc.GetRecordID()) {
      if !npc.IsOnAutonomousAI() { return "skipped:driven"; };
      return "";
    };
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

  // A spawned character's face: the gated crowd copy on one of the four crowd graphs (the ordinary-NPC layer and cost),
  // otherwise the companion graph for that face (Judy's photo-mode graph, the paperdoll pair), which is what our own copy
  // of that character carries. A face an earlier extraction already prepared is recognised, never rewritten.
  private func PrepareSpawnedFace(face: ref<AnimatedComponent>) -> String {
    if !IsDefined(face) { return "no-face-rig"; };
    let path = ResRef.ToString(ResourceRef.GetPath(face.graph));
    let i = 0;
    while i < ArraySize(this.m_crowdGatedPaths) {
      if Equals(path, this.m_crowdGatedPaths[i]) { return "prepared:" + this.m_crowdNames[i]; };
      i += 1;
    };
    let index = this.CrowdIndex(path);
    if index < 0 { return this.PrepareFaceComponent(face); };
    let rig = this.CheckRig(face);
    if !Equals(rig, "") { return rig; };
    let graph = this.m_crowdGated[index];
    if this.m_crowdMode == 2 { graph = this.m_crowdPlain[index]; };
    if !ResourceRef.IsLoaded(graph) || ResourceRef.IsFailed(graph) { return "speech-graph-not-loaded"; };
    face.graph = graph;
    return "prepared:" + this.m_crowdNames[index];
  }

  // True for an entity another mod or a spawner created through the dynamic entity system: managed, and carrying none of
  // our own tags (they all start with "CyberpunkConvai"). No other mod's tag is ever named or matched.
  public static func SpawnedElsewhere(dynamic: ref<DynamicEntitySystem>, id: EntityID) -> Bool {
    if !IsDefined(dynamic) || !dynamic.IsManaged(id) { return false; };
    let tags = dynamic.GetTags(id);
    let i = 0;
    while i < ArraySize(tags) {
      if StrBeginsWith(NameToString(tags[i]), "CyberpunkConvai") { return false; };
      i += 1;
    };
    return true;
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

// Whether this dynamic entity is a character another mod or a spawner created (read once, then kept with the puppet).
@addField(NPCPuppet)
private let m_convaiSpawnedKnown: Bool;

@addField(NPCPuppet)
private let m_convaiSpawned: Bool;

@addMethod(NPCPuppet)
private final func ConvaiSpawnedElsewhere(dynamic: ref<DynamicEntitySystem>) -> Bool {
  if !this.m_convaiSpawnedKnown {
    this.m_convaiSpawned = ConvaiFaceService.SpawnedElsewhere(dynamic, this.GetEntityID());
    this.m_convaiSpawnedKnown = true;
  };
  return this.m_convaiSpawned;
}

// The reason a conversation start refused this NPC (a dialogue, a quest, a commanded AI): the layer stays inert and
// unwritten. Empty when it was never refused, or when the latest start cleared it.
@addField(NPCPuppet)
private let m_convaiFaceRefusal: String;

// What the Lua log shows: the refusal while there is one, otherwise how the face was prepared.
@addMethod(NPCPuppet)
public final func ConvaiFaceStatus() -> String {
  if !Equals(this.m_convaiFaceRefusal, "") { return this.m_convaiFaceRefusal; };
  // A face that was prepared but now runs another graph (a rebuild nobody prepared) says so, with the graph it runs and
  // the rebuild counts, instead of keeping the old "prepared" word that ConvaiFaceReady no longer agrees with. Read once
  // per reply, never per frame.
  if this.m_convaiFacePrepared && !Equals(this.m_convaiFaceGraphPath, "") {
    let face = this.FindComponentByName(n"face_rig") as AnimatedComponent;
    if IsDefined(face) {
      let live = ResRef.ToString(ResourceRef.GetPath(face.graph));
      if !Equals(live, this.m_convaiFaceGraphPath) {
        let service = GameInstance.GetScriptableServiceContainer().GetService(n"ConvaiFaceService") as ConvaiFaceService;
        return "stale:" + live + (IsDefined(service) ? " " + service.RebuildCounts() : "");
      };
    };
  };
  return this.m_convaiFaceStatus;
}

@addMethod(NPCPuppet)
public final func ConvaiFaceReady() -> Bool {
  if !this.IsAttached() || this.IsDeadNoStatPool() { return false; };
  let dynamic = GameInstance.GetDynamicEntitySystem();
  if !IsDefined(dynamic) { return false; };
  let world = true;
  if dynamic.IsManaged(this.GetEntityID()) {
    // A dynamic entity must be our companion copy, or a character another mod or a spawner created (then like a world NPC).
    world = !dynamic.IsTagged(this.GetEntityID(), n"CyberpunkConvaiCompanion");
    if world && !this.ConvaiSpawnedElsewhere(dynamic) { return false; };
  };
  if world {
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
  // Our copies are "managed"; a character another mod or a spawner created goes on like a world NPC.
  let spawned = dynamic.IsManaged(this.GetEntityID());
  if spawned && !this.ConvaiSpawnedElsewhere(dynamic) { return "managed"; };
  if !this.m_convaiFacePrepared && !this.ConvaiFaceAdoptWorld() {
    // Skipped at spawn (the reason is remembered), a graph that is not a crowd graph, or an NPC that spawned
    // before the scripts or while the mode was off.
    if !Equals(this.m_convaiFaceStatus, "") { return this.m_convaiFaceStatus; };
    let face = this.FindComponentByName(n"face_rig") as AnimatedComponent;
    if !IsDefined(face) { return "no-face-rig"; };
    return "unprepared:" + ResRef.ToString(ResourceRef.GetPath(face.graph));
  };
  this.m_convaiFaceRefusal = service.TalkRefusal(this, spawned);
  if !Equals(this.m_convaiFaceRefusal, "") { return this.m_convaiFaceRefusal; };
  // A prepared face that a rebuild replaced reports "stale:<graph>" here (ConvaiFaceStatus), so the Lua log says so.
  return this.ConvaiFaceStatus();
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
