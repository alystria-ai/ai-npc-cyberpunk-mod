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
//    "Talk to story characters" is on (SetStoryTalk, set from mod/facial-playback.lua applyStoryTalk, off by default; docs/
//    WORLD_CHARACTERS.md), once at spawn (OnWorldInitialize, PrepareStoryFace): the same preparation as a spawned character, the
//    gated crowd copy on a crowd graph and the companion graph on Judy's photo-mode graph or the paperdoll pair. The speech
//    layer is inert until the mod voices that character, so a scene or the character's own animation sees the vanilla face.
// An appearance change after any of that (another mod swapping a character's model or outfit, a quest changing a look) rebuilds
// face_rig with the vanilla graph. Such a rebuild is prepared again, for each kind above (OnReassemble: our copies, characters
// another mod spawned, the game's own ordinary and named characters), by the same rules each kind had at its first build. If it cannot
// be, ConvaiFaceStatus says "stale:<graph the face runs now>" and ConvaiFaceDetail names the appearance, the template and the graph.
// Other story and quest characters, named roster characters while that setting is off (Johnny included, his record also uses
// man_average_sermo) and every NPC whose face is not one of the four crowd graphs keep the vanilla graph. Shared game resources are never
// patched, zero inputs leave the native face unchanged, and this service keeps entity IDs and strings only, never a
// live actor or component. There is no per-frame work here: one callback per NPC spawn, one call per conversation.
// The speaking face needs Codeware (its script services, entity callbacks and resource references). Without Codeware the service and
// the methods that use it are left out and each NPCPuppet method below has a plain stand-in at the end of this file, so these scripts
// still compile (a compile error would disable every redscript mod) and the face simply never gets prepared.
// mod/setup-check.lua tells the player Codeware is missing.
@if(ModuleExists("Codeware"))
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
  // Rebuilds of a character's appearance (docs/SPAWNED_CHARACTERS.md, "Appearance changes"; docs/FACIAL_ANIMATION.md, "A replaced
  // model"). The game builds a rebuild's components with no entity ID (the builder names nobody), so the extraction cannot tell whose
  // face it is. Once something exists whose face a rebuild could replace (m_watchRebuilds: one of our copies, a spawned character, a
  // world or story NPC this service prepared), an extraction that names nobody and carries no entity part leaves its face_rig clones
  // here (weak, at most six) with a key for the entity template; the entity's own Reassemble event, which does name the entity,
  // then prepares the clones of its own template before they initialize, by the rules of that entity's kind (FaceOwner).
  // Nothing is kept until then, and no component is held alive. The counters are for the status line: they say where a face that
  // stayed vanilla was lost, per kind (index 1 our copy, 2 spawned elsewhere, 3 game-placed).
  private let m_spawnedSeen: Bool;
  private let m_watchRebuilds: Bool;
  private let m_rebuildFaces: array<wref<AnimatedComponent>>;
  private let m_rebuildTemplates: array<Uint64>;
  private let m_rebuildStashed: Int32;
  private let m_rebuildSeen: Int32;
  private let m_rebuildApplied: Int32;
  private let m_rebuildMissed: Int32;
  private let m_rebuildKinds: array<Int32>;
  private let m_reassembleEvents: Int32;

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
    this.m_storyTalk = false;
    ArrayResize(this.m_rebuildKinds, 6);
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
    // and only once something exists that a rebuild could take the speaking face from (one of ours, a spawned character,
    // a prepared world or story NPC).
    if !dynamic.IsManaged(builder.GetEntityID()) {
      if this.m_watchRebuilds { this.NoteRebuild(builder); };
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
    // One of our copies or a spawned character is being built: a later rebuild of its look is worth catching (OnReassemble).
    this.m_watchRebuilds = true;
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
    this.m_watchRebuilds = true;
    let face = npc.FindComponentByName(n"face_rig") as AnimatedComponent;
    let status = this.PrepareFaceComponent(face);
    let graphPath = "";
    if IsDefined(face) { graphPath = ResRef.ToString(ResourceRef.GetPath(face.graph)); };
    npc.ConvaiFacePrepared(StrBeginsWith(status, "prepared:"), status, graphPath);
  }

  // First half of a character's rebuild: an extraction that names no entity and has no entity part (an appearance change of
  // something that already exists) leaves its face_rig clones, with a key for the entity template, until that entity's
  // Reassemble claims them. Runs only once something to protect exists (m_watchRebuilds), only for such an extraction (rare: a
  // quest or a mod changing an appearance), reads no strings and holds no component alive. The crowd mode is not asked here:
  // our own copies do not depend on it, and the claim applies it to the other kinds.
  private func NoteRebuild(builder: ref<EntityBuilderWrapper>) -> Void {
    if builder.HasEntity() || !builder.HasAppearance() { return; };
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

  // Second half: the character's own appearance rebuild. The Reassemble event fires after the builder extracted the new
  // components and before they join the entity and initialize, so a face_rig noted for this entity template can still take the
  // speaking graph (exactly as at the first build). Every note of the template is prepared (they only differ when a prefetch
  // and the real rebuild both extracted); the status and graph path go to the puppet from the newest. Which preparation a
  // note gets is the rule its entity's kind had at its first build (FaceOwner, PrepareRebuiltFace): our copy, a character another
  // mod spawned, or one the game placed (the same filters as at its spawn). An entity of another template is never matched.
  private cb func OnReassemble(event: ref<EntityLifecycleEvent>) {
    if !this.m_watchRebuilds { return; };
    this.m_reassembleEvents += 1;
    // Nothing waits unless an extraction named nobody and left its clones: the common event ends here, on one array read.
    if ArraySize(this.m_rebuildFaces) == 0 { return; };
    let npc = event.GetEntity() as NPCPuppet;
    let dynamic = GameInstance.GetDynamicEntitySystem();
    if !IsDefined(npc) || !IsDefined(dynamic) { return; };
    let owner = ConvaiFaceService.FaceOwner(dynamic, npc.GetEntityID());
    // The crowd mode "off" (the FPS comparison) leaves every ordinary NPC and every other mod's character as the game made it;
    // our own copies do not depend on it.
    if owner == 0 || (owner != 1 && this.m_crowdMode == 0) { return; };
    this.m_rebuildSeen += 1;
    this.m_rebuildKinds[owner - 1] += 1;
    let key = ResRef.GetHash(npc.GetTemplatePath());
    let status = "";
    let graphPath = "";
    let i = ArraySize(this.m_rebuildFaces) - 1;
    while i >= 0 {
      if this.m_rebuildTemplates[i] == key {
        let face = this.m_rebuildFaces[i];
        if IsDefined(face) {
          let result = this.PrepareRebuiltFace(npc, face, owner);
          if Equals(status, "") && !Equals(result, "") {
            status = result;
            graphPath = ResRef.ToString(ResourceRef.GetPath(face.graph));
          };
          this.m_rebuildApplied += 1;
          this.m_rebuildKinds[owner + 2] += 1;
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

  // The preparation a rebuilt face gets: the rule of its entity's kind, written on the clone before it initializes. "" leaves the
  // face as the game built it and the status as it was (a game-placed NPC the spawn rules do not touch).
  private func PrepareRebuiltFace(npc: ref<NPCPuppet>, face: ref<AnimatedComponent>, owner: Int32) -> String {
    if owner == 1 { return this.PrepareFaceComponent(face); };
    if owner == 2 { return this.PrepareSpawnedFace(face); };
    return this.PrepareGameFace(npc, face);
  }

  // A character the game placed whose face was rebuilt: the rules it had at its spawn (OnWorldInitialize), in the same order. A
  // named roster character while "Talk to story characters" is on takes the spawned-character preparation; any other takes the
  // crowd preparation (record and quest filters included) when its graph is one of the four crowd graphs. "" otherwise.
  private func PrepareGameFace(npc: ref<NPCPuppet>, face: ref<AnimatedComponent>) -> String {
    if this.m_storyTalk {
      let record = npc.GetRecordID();
      if TDBID.IsValid(record) && ArrayContains(this.m_named, record) { return this.PrepareSpawnedFace(face); };
    };
    let index = this.CrowdIndex(ResRef.ToString(ResourceRef.GetPath(face.graph)));
    if index < 0 { return ""; };
    return this.PrepareCrowdFace(npc, face, index);
  }

  // Whose face this entity's is: 1 one of our copies, 2 a character another mod or a spawner created, 3 a character the game
  // placed, 0 none of those (another of our entities, such as a tagged helper). Managed lookups only, no strings.
  public static func FaceOwner(dynamic: ref<DynamicEntitySystem>, id: EntityID) -> Int32 {
    if !dynamic.IsManaged(id) { return 3; };
    if dynamic.IsTagged(id, n"CyberpunkConvaiCompanion") { return 1; };
    if ConvaiFaceService.SpawnedElsewhere(dynamic, id) { return 2; };
    return 0;
  }

  // What the status line adds when the face was prepared and a rebuild replaced it anyway: how many rebuilds were noted and
  // claimed, so one more live check says where a missing preparation was lost (docs/SPAWNED_CHARACTERS.md). "events" counts
  // every NPC reassembly since something to protect existed; "noted" the entity-less extractions that left face clones;
  // "reassembled" the reassemblies of a watched kind that found clones waiting, "kinds" those and their claims per kind (our
  // copies, spawned elsewhere, game-placed). So events=0 says the engine never fired the event, noted=0 with events above 0 says
  // no rebuild ever reached the extraction as nameless, and noted above 0 with claimed=0 says the template keys differ.
  public func RebuildCounts() -> String {
    return "noted=" + IntToString(this.m_rebuildStashed) + " claimed=" + IntToString(this.m_rebuildApplied)
      + " reassembled=" + IntToString(this.m_rebuildSeen) + " unmatched=" + IntToString(this.m_rebuildMissed)
      + " kinds=ours:" + IntToString(this.m_rebuildKinds[0]) + "/" + IntToString(this.m_rebuildKinds[3])
      + ",spawned:" + IntToString(this.m_rebuildKinds[1]) + "/" + IntToString(this.m_rebuildKinds[4])
      + ",game:" + IntToString(this.m_rebuildKinds[2]) + "/" + IntToString(this.m_rebuildKinds[5])
      + " events=" + IntToString(this.m_reassembleEvents);
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
    let status = this.PrepareCrowdFace(npc, face, index);
    if StrBeginsWith(status, "prepared:") {
      npc.ConvaiFacePrepared(true, status, ResRef.ToString(ResourceRef.GetPath(face.graph)));
      this.m_watchRebuilds = true;
    } else {
      npc.ConvaiFacePrepared(false, status);
    };
  }

  // The ordinary crowd NPC's preparation, the same at its spawn and after a rebuild of its face: the record and roster filters,
  // the rig check, then the gated copy of its crowd graph. Returns "prepared:<graph>" (the graph is written) or the reason it
  // stays as the game built it (skipped:no-record, skipped:named, rig-not-loaded, unsupported-rig, speech-graph-not-loaded).
  // A quest-bound character (a q###/sq###/mq### record or appearance: the Afterlife bouncer) is prepared like anyone else: the
  // speech layer is inert until the mod voices that character, so a scene or the character's own animation sees the vanilla
  // face, and the talk-time guard (TalkRefusal) keeps the mouth shut while the game has the character in a scene or a dialogue.
  private func PrepareCrowdFace(npc: ref<NPCPuppet>, face: ref<AnimatedComponent>, index: Int32) -> String {
    let record = npc.GetRecordID();
    let recordValid = TDBID.IsValid(record);
    let reason = ConvaiFaceService.CrowdSkipReason(recordValid, recordValid && ArrayContains(this.m_named, record));
    if !Equals(reason, "") { return reason; };
    let rig = this.CheckRig(face);
    if !Equals(rig, "") { return rig; };
    let graph = this.m_crowdGated[index];
    if this.m_crowdMode == 2 { graph = this.m_crowdPlain[index]; };
    if !ResourceRef.IsLoaded(graph) || ResourceRef.IsFailed(graph) { return "speech-graph-not-loaded"; };
    face.graph = graph;
    return "prepared:" + this.m_crowdNames[index];
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
    if StrBeginsWith(status, "prepared:") { this.m_watchRebuilds = true; };
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

  // For the log line of a failed face request (NPCPuppet.ConvaiFaceDetail), never read on a normal talk: does this face's rig carry
  // the lip-sync tracks, and the first one it lacks. A model whose rig another mod replaced shows "missing:<track>" here.
  public func RigReport(face: ref<AnimatedComponent>) -> String {
    let rig = ResourceRef.GetResource(face.rig) as animRig;
    if !IsDefined(rig) { return "tracks=rig-not-loaded"; };
    let tracks = ConvaiFaceAssets.RequiredTracks();
    let t = 0;
    while t < ArraySize(tracks) {
      if !ArrayContains(rig.trackNames, tracks[t]) { return "tracks=missing:" + NameToString(tracks[t]); };
      t += 1;
    };
    return "tracks=ok";
  }

  // The state of the mod's own graphs in convai_facial.archive (the nine companion graphs and the four crowd copies): a game that
  // never mounted the archive reports "loaded:0 failed:13", which is what "speech-graph-not-loaded" means. For the log only.
  public func GraphReport() -> String {
    let loaded = 0;
    let failed = 0;
    let waiting = 0;
    let i = 0;
    while i < ArraySize(this.m_graphs) {
      if ResourceRef.IsFailed(this.m_graphs[i]) { failed += 1; } else { if ResourceRef.IsLoaded(this.m_graphs[i]) { loaded += 1; } else { waiting += 1; }; };
      i += 1;
    };
    i = 0;
    while i < ArraySize(this.m_crowdGated) {
      if ResourceRef.IsFailed(this.m_crowdGated[i]) { failed += 1; } else { if ResourceRef.IsLoaded(this.m_crowdGated[i]) { loaded += 1; } else { waiting += 1; }; };
      i += 1;
    };
    return "mod-graphs=loaded:" + IntToString(loaded) + " failed:" + IntToString(failed) + " waiting:" + IntToString(waiting);
  }

  // Why an NPC with a crowd graph stays vanilla, or "" when it is ordinary: no readable record (fail closed, so a story
  // character is never touched by mistake) or a named roster record. The named roster is the one thing the graph cannot tell
  // apart: Johnny's record uses man_average_sermo. A quest token in the appearance or record (q004, sq021, mq003...) is no
  // reason any more (2026-10-22: the Afterlife bouncer's appearance is gang__generic_mb__q005__emmerick and his mouth stayed
  // still): whether the game is using the character is decided at talk time, from what the game reports (TalkRefusal).
  public static func CrowdSkipReason(recordValid: Bool, named: Bool) -> String {
    if !recordValid { return "skipped:no-record"; };
    if named { return "skipped:named"; };
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

  // The talk-time guards, once per conversation start for an NPC that carries the layer. The spawn filter decides nothing
  // about quests any more, so this is where the game's use of the character is read: such an NPC is only refused here (it keeps
  // an inert, switched-off graph, never written), its voice still plays.
  public func TalkRefusal(npc: ref<NPCPuppet>, opt spawned: Bool) -> String {
    // A dialogue in progress, and one a quest marked or whose AI a quest or scene commands, unless the character stands at a
    // workspot. A scene alone is no reason: vendors, community NPCs and a quest's bouncer at their workspots are scene actors.
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
    // An ordinary or quest-bound character of the game (the template, the appearance and the record say nothing about whether the
    // game is using the character now): refused for a quest marking or an AI a quest or scene commands, unless it stands at a
    // workspot, which is how the game keeps a bouncer, a vendor or a receptionist at their post (2026-10-22: the Afterlife
    // bouncer stood idle at his, no scene, and his mouth was left still). V's own scene, quest conversation and call are checked on
    // the Lua side (mod/world-talk.lua, for a quest-bound character), and the game dialogue above.
    let atPost = GameInstance.GetWorkspotSystem(npc.GetGame()).IsActorInWorkspot(npc);
    if !atPost && (npc.IsQuest() || !npc.IsOnAutonomousAI()) { return "skipped:driven"; };
    return "";
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

@if(ModuleExists("Codeware"))
@addField(NPCPuppet)
private let m_convaiFacePrepared: Bool;

@if(ModuleExists("Codeware"))
@addField(NPCPuppet)
private let m_convaiFaceStatus: String;

@if(ModuleExists("Codeware"))
@addMethod(NPCPuppet)
public final func ConvaiFacePrepared(ready: Bool, status: String, opt graphPath: String) -> Void {
  this.m_convaiFacePrepared = ready;
  this.m_convaiFaceStatus = status;
  this.m_convaiFaceGraphPath = ready ? graphPath : "";
}

@if(ModuleExists("Codeware"))
@addField(NPCPuppet)
private let m_convaiFaceGraphPath: String;

// Whether this dynamic entity is a character another mod or a spawner created (read once, then kept with the puppet).
@if(ModuleExists("Codeware"))
@addField(NPCPuppet)
private let m_convaiSpawnedKnown: Bool;

@if(ModuleExists("Codeware"))
@addField(NPCPuppet)
private let m_convaiSpawned: Bool;

@if(ModuleExists("Codeware"))
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
@if(ModuleExists("Codeware"))
@addField(NPCPuppet)
private let m_convaiFaceRefusal: String;

// What the Lua log shows: the refusal while there is one, otherwise how the face was prepared.
@if(ModuleExists("Codeware"))
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

@if(ModuleExists("Codeware"))
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
@if(ModuleExists("Codeware"))
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
// "prepared:<graph>" when the mouth can follow the voice, otherwise why not (never an empty word, so the log always has one).
@if(ModuleExists("Codeware"))
@addMethod(NPCPuppet)
public final func ConvaiFaceRequest() -> String {
  let service = GameInstance.GetScriptableServiceContainer().GetService(n"ConvaiFaceService") as ConvaiFaceService;
  if !IsDefined(service) { return "service-unavailable"; };
  let dynamic = GameInstance.GetDynamicEntitySystem();
  if !this.IsAttached() || !IsDefined(dynamic) { return "unavailable"; };
  // Our own copies were prepared at their own build and have no talk-time guard. The answer is that preparation, or
  // "stale:<graph>" when another mod's appearance change rebuilt the face since (this used to answer "managed" and the log
  // said nothing, so a copy whose lips stayed still had no line). A character another mod or a spawner created goes on like a
  // world NPC.
  let spawned = dynamic.IsManaged(this.GetEntityID());
  if spawned && !this.ConvaiSpawnedElsewhere(dynamic) {
    let ours = this.ConvaiFaceStatus();
    if !Equals(ours, "") { return ours; };
    let ownFace = this.FindComponentByName(n"face_rig") as AnimatedComponent;
    if !IsDefined(ownFace) { return "no-face-rig"; };
    return "unprepared:" + ResRef.ToString(ResourceRef.GetPath(ownFace.graph));
  };
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

// One line of facts for the log when a face request or a reply ends without a speaking face: what kind of character this is
// (companion: one of our copies, spawned: another mod's character, world: one the game placed), its record, its current
// appearance, the entity template it was built from, the face graph and rig it runs now, whether that rig has the 59 lip-sync
// tracks, and the state of the mod's own graphs (13 expected: nine companion graphs and four crowd copies). The appearance,
// template and graph are where a model another mod replaced shows itself. Read only when Lua is about to log a failure (a talk
// start, a reply), never per frame.
@if(ModuleExists("Codeware"))
@addMethod(NPCPuppet)
public final func ConvaiFaceDetail() -> String {
  let kind = "world";
  let dynamic = GameInstance.GetDynamicEntitySystem();
  if IsDefined(dynamic) {
    let owner = ConvaiFaceService.FaceOwner(dynamic, this.GetEntityID());
    if owner == 1 { kind = "companion"; };
    if owner == 2 { kind = "spawned"; };
    if owner == 0 { kind = "other"; };
  };
  let text = "kind=" + kind + " record=" + TDBID.ToStringDEBUG(this.GetRecordID())
    + " appearance=" + NameToString(this.GetCurrentAppearanceName())
    + " template=" + ResRef.ToString(this.GetTemplatePath());
  let face = this.FindComponentByName(n"face_rig") as AnimatedComponent;
  if !IsDefined(face) { return text + " face_rig=none"; };
  text = text + " graph=" + ResRef.ToString(ResourceRef.GetPath(face.graph))
    + " rig=" + ResRef.ToString(ResourceRef.GetPath(face.rig));
  let service = GameInstance.GetScriptableServiceContainer().GetService(n"ConvaiFaceService") as ConvaiFaceService;
  if IsDefined(service) { text = text + " " + service.RigReport(face) + " " + service.GraphReport(); };
  return text;
}

@if(ModuleExists("Codeware"))
@addMethod(NPCPuppet)
public final func ConvaiFaceApply(feature: ref<ConvaiFaceFeature>) -> Bool {
  // Readiness carries the ownership check (companion tag or prepared world NPC).
  if !this.ConvaiFaceReady() || !IsDefined(feature) { return false; };
  AnimationControllerComponent.ApplyFeature(this, n"ConvaiFace", feature);
  return true;
}

@if(ModuleExists("Codeware"))
@addMethod(NPCPuppet)
public final func ConvaiFaceReset() -> Bool {
  return this.ConvaiFaceApply(new ConvaiFaceFeature());
}

// Stand-ins without Codeware: nothing was prepared, so the face is never ready and Lua writes no mouth movement.
@if(!ModuleExists("Codeware"))
@addMethod(NPCPuppet)
public final func ConvaiFaceStatus() -> String {
  return "codeware-missing";
}

@if(!ModuleExists("Codeware"))
@addMethod(NPCPuppet)
public final func ConvaiFaceReady() -> Bool {
  return false;
}

@if(!ModuleExists("Codeware"))
@addMethod(NPCPuppet)
public final func ConvaiFaceRequest() -> String {
  return "codeware-missing";
}

@if(!ModuleExists("Codeware"))
@addMethod(NPCPuppet)
public final func ConvaiFaceApply(feature: ref<ConvaiFaceFeature>) -> Bool {
  return false;
}

@if(!ModuleExists("Codeware"))
@addMethod(NPCPuppet)
public final func ConvaiFaceReset() -> Bool {
  return false;
}

@if(!ModuleExists("Codeware"))
@addMethod(NPCPuppet)
public final func ConvaiFaceDetail() -> String {
  return "codeware-missing";
}
