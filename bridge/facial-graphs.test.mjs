import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {extendFacialGraph, inspectGraph, schema, featureSource, namedRecords, crowdPath, GATE_EXPRESSION} from '../scripts/Build-FacialGraphs.mjs';
import {verifyGraph, verifyArchive, archivePaths, pathHash} from '../scripts/Verify-FacialGraphs.mjs';

const name = value => ({$type: 'CName', $storage: 'string', $value: value});
const nativeFace = readFileSync(new URL('../r6/scripts/CyberpunkConvai/Face.reds', import.meta.url), 'utf8');
// The solver's own track list (animSermoTestController, present in all nine shipped graphs) is what the builder
// checks the override tracks against.
const solverTracks = () => ({$type: 'animSermoTestController', [schema.owner.envelope]: 0,
  ...Object.fromEntries(schema.owner.faded.map(track => [`${track}AnimOverrideWeight`, 1]))});
// WolvenKit's JSON reader resolves a handle reference only after the handle's definition in document order (a forward
// reference failed "convert deserialize" on October 10, after every structural check here had passed).
function forwardReferences(document) {
  const defined = new Set();
  let forward = 0;
  (function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (value.HandleId !== undefined) defined.add(value.HandleId);
    if (value.HandleRefId !== undefined && value.HandleRefId !== '-1' && !defined.has(value.HandleRefId)) forward++;
    for (const child of Object.values(value)) walk(child);
  })(document);
  return forward;
}
function fixture() {
  return {Header: {}, Data: {RootChunk: {$type: 'animAnimGraph',
    rootNode: {HandleRefId: '0'}, animFeatures: [{name: name('Eyes'), className: name('AnimFeature_LookAt')}],
    nodesToInit: [{HandleId: '0', Data: {$type: 'animAnimNode_Sermo', testController: solverTracks(),
      inputLink: {$type: 'animPoseLink', node: {HandleId: '1', Data: {
        $type: 'animAnimNode_EyesTracksLookAt', existingEyeSetting: 0.375}}}}}, {HandleRefId: '1'}]}}};
}

test('speech layer preserves the original graph and its complete gaze input', () => {
  const original = fixture(), before = JSON.stringify(original);
  const result = extendFacialGraph(original);
  assert.equal(JSON.stringify(original), before);
  let input = result.Data.RootChunk.nodesToInit[0].Data.inputLink;
  const seen = new Set(), ownership = [];
  while (input.node.Data.$type === 'animAnimNode_FloatTrackModifier') {
    const node = input.node.Data;
    if (node.debugName.$value === 'Convai speech owner') { ownership.push(node); input = node.poseInputNode; continue; }
    assert.equal(node.operationType, 'Add');
    assert.match(node.floatTrack.name.$value, /LipsyncPoseOutput$/);
    assert.equal(node.floatInputNode.node.Data.group.$value, 'ConvaiFace');
    assert.equal(node.floatInputNode.node.Data.debugInput, 0);
    seen.add(node.floatInputNode.node.Data.name.$value);
    input = node.poseInputNode;
  }
  assert.deepEqual(seen, new Set(schema.tracks));
  assert.equal(ownership.length, schema.owner.faded.length + 1);
  assert.equal(forwardReferences(result), forwardReferences(original), 'the added nodes define every handle before it is referenced');
  assert.deepEqual(input, original.Data.RootChunk.nodesToInit[0].Data.inputLink);
  assert.deepEqual(result.Data.RootChunk.animFeatures[0], original.Data.RootChunk.animFeatures[0]);
  inspectGraph(result);
});

test('rejects ambiguous, missing and repeated facial solver modifications', () => {
  const missing = fixture(); missing.Data.RootChunk.nodesToInit[0].Data.$type = 'other';
  assert.throws(() => extendFacialGraph(missing), /exactly one/);
  const ambiguous = fixture();
  ambiguous.Data.RootChunk.nodesToInit.push({HandleId: '2', Data: {$type: 'animAnimNode_Sermo'}});
  assert.throws(() => extendFacialGraph(ambiguous), /exactly one/);
  assert.throws(() => extendFacialGraph(extendFacialGraph(fixture())), /already contains/);
});

test('rejects invalid handle graphs before producing a native resource', () => {
  const unresolved = fixture(); unresolved.Data.RootChunk.rootNode.HandleRefId = '99';
  assert.throws(() => extendFacialGraph(unresolved), /Unresolved/);
  const duplicate = fixture(); duplicate.Data.RootChunk.nodesToInit.push({HandleId: '1', Data: {}});
  assert.throws(() => extendFacialGraph(duplicate), /Duplicate/);
});

test('native feature fields and graph declarations share the same schema', () => {
  const source = readFileSync(new URL('../r6/scripts/CyberpunkConvai/FaceFeature.reds', import.meta.url), 'utf8');
  assert.equal(source.replace(/\r\n/g, '\n'), featureSource());
});

// Native execution still requires the isolated redscript compiler and the
// in-game graph/capture check. These contracts protect the supported lifecycle
// seams and ownership/resource boundaries; they do not prove visible motion.
test('new appearance component clones are prepared during extraction behind the dynamic companion tag', () => {
  assert.match(nativeFace, /RegisterCallback\(n"Entity\/Extract", this, n"OnCompanionExtract"\)/);
  assert.match(nativeFace, /RegisterCallback\(n"Entity\/Initialize", this, n"OnCompanionInitialize"\)/);
  // Reassemble is registered once, for a spawned character's appearance rebuild only (see the rebuild contract below).
  assert.doesNotMatch(nativeFace, /RegisterCallback\(n"Entity\/(?:Attach|AfterAttach)"/);
  const extract = nativeFace.slice(nativeFace.indexOf('private cb func OnCompanionExtract'),
    nativeFace.indexOf('private func PrepareExtractedComponents'));
  const gate = extract.indexOf('dynamic.IsTagged(builder.GetEntityID(), n"CyberpunkConvaiCompanion")');
  assert(gate >= 0 && gate < extract.indexOf('PrepareExtractedComponents('));
  assert.match(extract, /template\.GetComponents\(\)/);
  assert.match(extract, /builder\.GetAppearance\(\)\.GetComponents\(\)/);
  assert.match(extract, /builder\.GetCustomAppearances\(\)/);
  assert.match(extract, /appearances\[i\]\.GetComponents\(\)/);
  assert.doesNotMatch(extract, /GetDefinition\(|GetResource\(/, 'shared template/appearance definitions are never edited');
  const prepare = nativeFace.slice(nativeFace.indexOf('private func PrepareExtractedComponents'),
    nativeFace.indexOf('private cb func OnCompanionInitialize'));
  assert.match(prepare, /components\[i\] as AnimatedComponent/);
  assert.match(prepare, /Equals\(face\.GetName\(\), n"face_rig"\)/);
});

test('initialization recognizes already prepared graphs without layering or modifying the shared solver', () => {
  const prepare = nativeFace.slice(nativeFace.indexOf('private func PrepareFaceComponent'),
    nativeFace.indexOf('@addField(NPCPuppet)'));
  assert.match(prepare, /Equals\(original, preparedPath\)/);
  assert.match(prepare, /if Equals\(original, preparedPath\) \{ return "prepared:" \+ this\.m_names\[i\]; \};\s*face\.graph = this\.m_graphs\[i\];/,
    'a prepared graph is never rewritten');
  assert.match(prepare, /ArrayContains\(rig\.trackNames, tracks\[t\]\)/);
  assert.match(prepare, /ResourceRef\.IsLoaded\(this\.m_graphs\[i\]\)/);
  assert.match(prepare, /ResourceRef\.IsFailed\(this\.m_graphs\[i\]\)/);
  assert.doesNotMatch(prepare, /GetResource\(face\.graph\)|nodesToInit|animFeatures/);
});

test('latched preparation alone cannot pass readiness after face_rig graph replacement', () => {
  const ready = nativeFace.slice(nativeFace.indexOf('public final func ConvaiFaceReady()'),
    nativeFace.indexOf('public final func ConvaiFaceApply('));
  assert.match(ready, /this\.m_convaiFacePrepared/);
  assert.match(ready, /this\.IsAttached\(\)/);
  assert.match(ready, /this\.IsDeadNoStatPool\(\)/);
  assert.match(ready, /if dynamic\.IsManaged\(this\.GetEntityID\(\)\) \{[^}]*world = !dynamic\.IsTagged\(this\.GetEntityID\(\), n"CyberpunkConvaiCompanion"\);\s*if world && !this\.ConvaiSpawnedElsewhere\(dynamic\) \{ return false; \};/,
    'a dynamic entity must carry the companion tag, or be a character another mod or a spawner created');
  assert.match(ready, /this\.FindComponentByName\(n"face_rig"\) as AnimatedComponent/);
  assert.match(ready, /ResourceRef\.IsLoaded\(face\.graph\)/);
  assert.match(ready, /ResourceRef\.IsFailed\(face\.graph\)/);
  assert.match(ready, /Equals\(ResRef\.ToString\(ResourceRef\.GetPath\(face\.graph\)\), this\.m_convaiFaceGraphPath\)/);
  const fields = [...nativeFace.matchAll(/@addField\(NPCPuppet\)\s*private let (\w+): ([^;]+);/g)];
  assert(fields.every(([, , type]) => ['Bool', 'String'].includes(type)), 'no actor/component/resource handle is retained on the puppet');
});

// October 14: ordinary NPCs (crowd, vendors, gangs, archetype characters) are prepared ONCE, at their own spawn, with a
// gated copy of the crowd graph. The on-demand route (rebuild the NPC's own appearance when V talks to it) never worked:
// a same-name appearance change is a no-op (measured 2026-10-10), so it is gone. FPS rules: one callback per NPC spawn,
// nothing per frame, nothing for an NPC that is not one of the four crowd graphs.
const body = (source, from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start + from.length);
  assert(start >= 0 && end > start, `${from} ... ${to}`);
  return source.slice(start, end);
};
test('ordinary NPCs are prepared once at spawn, behind filters, with no per-frame work and no rebuild', () => {
  const callbacks = [...nativeFace.matchAll(/RegisterCallback\(n"(Entity\/\w+)", this, n"(\w+)"\)/g)].map(match => `${match[1]} ${match[2]}`);
  assert.deepEqual(callbacks, ['Entity/Initialize OnCompanionInitialize', 'Entity/Initialize OnWorldInitialize', 'Entity/Extract OnCompanionExtract',
    'Entity/Reassemble OnReassemble'],
    'the companion initialize and extract callbacks, one per-NPC-spawn callback, and the spawned character rebuild claim');
  assert.match(nativeFace, /RegisterCallback\(n"Entity\/Initialize", this, n"OnWorldInitialize"\)\s*\.AddTarget\(EntityTarget\.Type\(n"NPCPuppet"\)\)/,
    'the callback system filters to NPCPuppet before the script runs');
  // Nothing per frame, nothing delayed, nothing rebuilt.
  assert.doesNotMatch(nativeFace, /OnUpdate|UpdateScriptableService|GetDelaySystem|DelayCallback|DelayEvent|ScheduleAppearanceChange|Entity\/(?:Attach|AfterAttach|Update)/);
  assert.doesNotMatch(nativeFace, /m_worldPending|m_worldPrepared|RequestWorldFace|WorldRebuildKeepsLook|ReleaseOldestWorld|NoteWorkspot/, 'the on-demand rebuild machinery is retired');
  const world = body(nativeFace, 'private cb func OnWorldInitialize', 'private func CrowdIndex');
  const order = needles => needles.map(needle => {
    const at = world.indexOf(needle);
    assert(at >= 0, needle);
    return at;
  });
  const positions = order(['if this.m_crowdMode == 0 && !screens { return; };', 'event.GetEntity() as NPCPuppet', 'dynamic.IsManaged(npc.GetEntityID())',
    'this.CrowdIndex(', 'npc.GetRecordID()', 'ConvaiFaceService.CrowdSkipReason(', 'this.CheckRig(face)', 'ResourceRef.IsLoaded(graph)', 'face.graph = graph;',
    'npc.ConvaiFacePrepared(true, "prepared:" + this.m_crowdNames[index]']);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'mode, type, dynamic spawns, crowd graph, record and tokens, rig, load, then the swap');
  assert.equal([...world.matchAll(/face\.graph = /g)].length, 1, 'one graph write, after every filter');
  assert.match(world, /graph = this\.m_crowdPlain\[index\]/, 'the ungated copy exists only for the FPS comparison mode');
  assert.match(world, /this\.m_crowdGated\[index\]/);
  assert.match(world, /if dynamic\.IsManaged\(npc\.GetEntityID\(\)\) \{\s*if this\.m_crowdMode == 0 \|\| !ConvaiFaceService\.SpawnedElsewhere\(dynamic, npc\.GetEntityID\(\)\) \{ return; \};[\s\S]*?this\.PrepareSpawnedFace\(spawnedFace\);[\s\S]*?return;\s*\};/,
    'our companions are never touched here; a character another mod or a spawner created takes its own path and returns');
  assert.doesNotMatch(world, /TDBID\.ToStringDEBUG\(record\)[\s\S]*TDBID\.ToStringDEBUG\(record\)/, 'strings are read once, and only after the cheap checks passed');
  assert(world.indexOf('ArrayContains(this.m_named, record)') < world.indexOf('NameToString(npc.GetCurrentAppearanceName())'), 'the roster check comes before any string work');
  // The rig's track check is cached per rig path.
  const rig = body(nativeFace, 'private func CheckRig', 'public static func CrowdSkipReason');
  assert(rig.indexOf('ArrayContains(this.m_verifiedRigs, path)') < rig.indexOf('ArrayContains(rig.trackNames'), 'a verified rig is not checked again');
  assert.match(rig, /ArrayPush\(this\.m_verifiedRigs, path\)/);
  // The graphs: four crowd graphs, the vanilla paths exact, gated copies in the crowd folder.
  const onLoad = body(nativeFace, 'private cb func OnLoad', 'private cb func OnCompanionExtract');
  assert.match(onLoad, /ConvaiFaceAssets\.CrowdNames\(\)/);
  assert.match(onLoad, /let folder = ConvaiFaceAssets\.CrowdFolder\(\);/);
  assert.match(onLoad, /"base\\\\animations\\\\facial\\\\_facial_graphs\\\\" \+ this\.m_crowdNames\[i\] \+ "\.animgraph"/);
  assert.match(onLoad, /TDBID\.Create\(records\[i\]\)/, 'the roster hashes are built once at load');
  // Judy and the player stay vanilla: only the four crowd names are crowd graphs.
  assert.deepEqual(schema.crowd.graphs, ['man_average_sermo', 'man_big_sermo', 'man_fat_sermo', 'woman_average_sermo']);
  assert.match(featureSource(), /CrowdNames\(\) -> array<String> \{\s*return \["man_average_sermo", "man_big_sermo", "man_fat_sermo", "woman_average_sermo"\];/);
});

test('conversation start reports the spawn decision and keeps the talk-time guards; a scene alone is no reason', () => {
  const request = body(nativeFace, 'public final func ConvaiFaceRequest()', 'public final func ConvaiFaceApply(');
  assert.match(request, /let spawned = dynamic\.IsManaged\(this\.GetEntityID\(\)\);\s*if spawned && !this\.ConvaiSpawnedElsewhere\(dynamic\) \{ return "managed"; \};/);
  assert.match(request, /service\.TalkRefusal\(this, spawned\)/);
  assert.match(request, /return "unprepared:" \+ ResRef\.ToString\(ResourceRef\.GetPath\(face\.graph\)\)/, 'a face that is not ours says which graph it has');
  assert.doesNotMatch(request, /face\.graph =|ScheduleAppearanceChange|PrepareFaceComponent/);
  const guards = body(nativeFace, 'public func TalkRefusal', 'public static func QuestBound');
  for (const guard of ['return "skipped:dialogue"', 'return "skipped:quest"', 'return "skipped:driven"']) assert(guards.includes(guard), guard);
  assert.match(guards, /scene\.IsEntityInDialogue\(npc\.GetEntityID\(\)\) \{ return "skipped:dialogue"; \};/);
  assert.match(guards, /if npc\.IsQuest\(\) \|\| !npc\.IsOnAutonomousAI\(\) \{ return "skipped:driven"; \};/);
  assert(guards.indexOf('skipped:dialogue') < guards.indexOf('skipped:quest') && guards.indexOf('skipped:quest') < guards.indexOf('skipped:driven'));
  assert.match(guards, /QuestBound\(NameToString\(npc\.GetCurrentAppearanceName\(\)\)\)\s*\|\| ConvaiFaceService\.QuestBound\(TDBID\.ToStringDEBUG\(npc\.GetRecordID\(\)\)\)/);
  assert.doesNotMatch(guards, /IsEntityInScene|skipped:scene|IsVendor|IsCrowd/, 'vendors and community NPCs are scene actors: the scene guard is gone');
  assert.doesNotMatch(nativeFace, /skipped:scene/);
  // A refused NPC is never written: readiness checks the refusal, and the status the log shows is the refusal.
  const ready = body(nativeFace, 'public final func ConvaiFaceReady()', 'private final func ConvaiFaceAdoptWorld');
  assert.match(ready, /if !Equals\(this\.m_convaiFaceRefusal, ""\) \{ return false; \};/);
  assert(ready.indexOf('m_convaiFaceRefusal') < ready.indexOf('ConvaiFaceAdoptWorld()'), 'adoption cannot undo a refusal');
  assert.match(body(nativeFace, 'public final func ConvaiFaceStatus()', 'public final func ConvaiFaceReady()'), /m_convaiFaceRefusal/);
  const adopt = body(nativeFace, 'private final func ConvaiFaceAdoptWorld', 'public final func ConvaiFaceRequest');
  assert(adopt.includes('StrBeginsWith(path, "cyberpunk_convai\\\\facial\\\\")'));
  const apply = body(nativeFace, 'public final func ConvaiFaceApply(', 'public final func ConvaiFaceReset(');
  assert.match(apply, /if !this\.ConvaiFaceReady\(\) \|\| !IsDefined\(feature\) \{ return false; \};/);
  assert.match(nativeFace.slice(nativeFace.indexOf('public final func ConvaiFaceReset(')), /return this\.ConvaiFaceApply\(new ConvaiFaceFeature\(\)\);/,
    'the reset is a fresh all-zero feature: speech_owner 0 closes the gate');
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  assert.equal([...init.matchAll(/:ConvaiFaceRequest\(\)/g)].length, 5,
    'composer, microphone, group speaker, the dev-only scripted talk and (phase 2) a spawned character speaking a battle or loot reaction');
  assert.match(init, /if person\.spawned then pcall\(function\(\) return person\.npc:ConvaiFaceRequest\(\) end\) end/,
    'the reaction site is for a spawned speaker only: our companions have their own face');
  const gaze = init.slice(init.indexOf('local function updateGaze'), init.indexOf('local function updateGaze') + 4000);
  assert.doesNotMatch(gaze, /ConvaiFaceRequest/, 'a glance never touches an NPC face');
});

/// October 17 (docs/SPAWNED_CHARACTERS.md): a character another mod or a spawner created through the dynamic entity system
// gets a speaking face. Recognition is generic: managed, and none of our own "CyberpunkConvai" tags. No other mod's tag,
// record or path is ever named. Its face is prepared at spawn and again at every appearance rebuild (outfit changes).
test('spawned characters: generic recognition, a face at spawn and at each rebuild, quest marking the only extra refusal', () => {
  const spawned = body(nativeFace, 'public static func SpawnedElsewhere', 'private func PrepareFaceComponent');
  assert.match(spawned, /if !IsDefined\(dynamic\) \|\| !dynamic\.IsManaged\(id\) \{ return false; \};/);
  assert.match(spawned, /dynamic\.GetTags\(id\)/);
  assert.match(spawned, /StrBeginsWith\(NameToString\(tags\[i\]\), "CyberpunkConvai"\) \{ return false; \}/, 'any tag of ours excludes it');
  // Only our own tag prefix is ever named in a tag check anywhere in the face service.
  for (const [, tag] of nativeFace.matchAll(/IsTagged\([^,]+, n"(\w+)"\)/g)) assert(tag.startsWith('CyberpunkConvai'), tag);
  // Extraction: a game-placed entity stops at the managed lookup; a spawned one is prepared, never as a holocall.
  const extract = body(nativeFace, 'private cb func OnCompanionExtract', 'private func PrepareExtractedComponents');
  assert(extract.indexOf('!dynamic.IsManaged(builder.GetEntityID())') < extract.indexOf('IsTagged('), 'the managed lookup comes first');
  assert.match(extract, /if this\.m_crowdMode == 0 \|\| !ConvaiFaceService\.SpawnedElsewhere\(dynamic, builder\.GetEntityID\(\)\) \{ return; \};\s*spawned = true;/);
  assert.match(extract, /let holocall = !spawned && /);
  assert.equal([...extract.matchAll(/npc, holocall, spawned\);/g)].length, 3);
  const prepareExtracted = body(nativeFace, 'private func PrepareExtractedComponents', 'private cb func OnCompanionInitialize');
  assert.match(prepareExtracted, /spawned \? this\.PrepareSpawnedFace\(face\) : this\.PrepareFaceComponent\(face\)/);
  // The spawned face: an already prepared gated copy is recognised, a crowd graph gets the gated copy after the rig and
  // load checks, anything else (Judy's photo-mode graph, the paperdoll pair) the companion graph of our own copy.
  const face = body(nativeFace, 'private func PrepareSpawnedFace', 'public static func SpawnedElsewhere');
  const positions = ['this.m_crowdGatedPaths[i]', 'this.CrowdIndex(path)', 'return this.PrepareFaceComponent(face)', 'this.CheckRig(face)',
    'let graph = this.m_crowdGated[index];', 'ResourceRef.IsLoaded(graph)', 'face.graph = graph;'].map(needle => {
    const at = face.indexOf(needle);
    assert(at >= 0, needle);
    return at;
  });
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.equal([...face.matchAll(/face\.graph = /g)].length, 1);
  assert.match(face, /if this\.m_crowdMode == 2 \{ graph = this\.m_crowdPlain\[index\]; \};/);
  assert.doesNotMatch(face, /m_named|CrowdSkipReason|QuestBound/, 'the roster and quest filters do not apply to a player-made character');
  assert.match(body(nativeFace, 'private cb func OnLoad', 'private cb func OnCompanionExtract'),
    /ArrayPush\(this\.m_crowdGatedPaths, folder \+ this\.m_crowdNames\[i\] \+ "\.animgraph"\);/);
  // Talk time: a spawned character is refused only by a dialogue or a quest marking it, before the world NPC's guards.
  const guards = body(nativeFace, 'public func TalkRefusal', 'public static func QuestBound');
  assert.match(guards, /public func TalkRefusal\(npc: ref<NPCPuppet>, opt spawned: Bool\) -> String/);
  assert.match(guards, /if spawned \{\s*if npc\.IsQuest\(\) \{ return "skipped:quest"; \};\s*return "";\s*\};/);
  assert(guards.indexOf('skipped:dialogue') < guards.indexOf('if spawned {') && guards.indexOf('if spawned {') < guards.indexOf('QuestBound('));
  // The puppet remembers the answer as two Bool fields; nothing per frame, no handle kept.
  const remember = body(nativeFace, 'private final func ConvaiSpawnedElsewhere', '// The reason a conversation start refused');
  assert.match(remember, /if !this\.m_convaiSpawnedKnown \{\s*this\.m_convaiSpawned = ConvaiFaceService\.SpawnedElsewhere\(dynamic, this\.GetEntityID\(\)\);\s*this\.m_convaiSpawnedKnown = true;/);
  const ready = body(nativeFace, 'public final func ConvaiFaceReady()', 'private final func ConvaiFaceAdoptWorld');
  assert(ready.indexOf('ConvaiSpawnedElsewhere(dynamic)') < ready.indexOf('if world {'), 'a spawned character then passes the world NPC checks');
  assert.match(ready, /if world \{\s*if !Equals\(this\.m_convaiFaceRefusal, ""\) \{ return false; \};\s*if !this\.m_convaiFacePrepared && !this\.ConvaiFaceAdoptWorld\(\) \{ return false; \};/);
});

// October 17, live result: a spawned character's lips did not move (`face=false/prepared:<graph>` in the probe log). The spawner
// rebuilds the appearance right after spawning (ScheduleAppearanceChange), the rebuild replaces face_rig with the vanilla graph, and
// the extraction of such a rebuild names no entity (entity ID 0, no entity part: docs/FACIAL_ANIMATION.md, the Johnny trace), so
// the managed lookup in OnCompanionExtract never matched it and nothing prepared the new face. The Reassemble event does name the
// entity and fires after the builder extracted the new components, before they join the entity and initialize.
test('a spawned character appearance rebuild: noted at extraction, claimed by its own entity at Reassemble, nothing else touched', () => {
  const extract = body(nativeFace, 'private cb func OnCompanionExtract', 'private func PrepareExtractedComponents');
  // The managed lookup still comes first; an extraction that names nobody is only noted, and only once a spawned character exists.
  assert.match(extract, /if !dynamic\.IsManaged\(builder\.GetEntityID\(\)\) \{\s*if this\.m_spawnedSeen \{ this\.NoteRebuild\(builder\); \};\s*return;\s*\};/);
  assert(extract.indexOf('this.NoteRebuild(builder)') < extract.indexOf('IsTagged('), 'a game-placed entity stops at the managed lookup');
  assert.match(extract, /spawned = true;\s*this\.m_spawnedSeen = true;/);
  // The first half: what is noted, in what order the guards run, and that it only reads.
  const note = body(nativeFace, 'private func NoteRebuild', 'private cb func OnReassemble');
  const inOrder = (text, needles) => {
    const at = needles.map(needle => {
      const found = text.indexOf(needle);
      assert(found >= 0, needle);
      return found;
    });
    assert.deepEqual([...at].sort((a, b) => a - b), at, needles.join(' < '));
  };
  inOrder(note, ['this.m_crowdMode == 0', 'builder.HasEntity()', '!builder.HasAppearance()', 'EntityID.IsDefined(builder.GetEntityID())',
    'builder.GetTemplate().GetResource()', 'ResRef.GetHash(template.path)', 'appearance.GetComponents()', 'builder.GetCustomAppearances()']);
  assert.match(note, /if this\.m_crowdMode == 0 \|\| builder\.HasEntity\(\) \|\| !builder\.HasAppearance\(\) \{ return; \};/,
    'a first build (entity part), a mode that is off and a builder without an appearance are never noted');
  assert.doesNotMatch(note, /\.graph\s*=|ConvaiFacePrepared|ScheduleAppearanceChange|GetDefinition\(|GetTemplatePath\(\)/,
    'noting writes nothing, and never reads the template path through the wrapper (it dereferences the template without a check)');
  assert.match(note, /Equals\(face\.GetName\(\), n"face_rig"\)/);
  assert.match(note, /if ArraySize\(this\.m_rebuildFaces\) >= 6 \{\s*ArrayErase\(this\.m_rebuildFaces, 0\);\s*ArrayErase\(this\.m_rebuildTemplates, 0\);\s*\};/,
    'bounded: the oldest note leaves first');
  assert.match(nativeFace, /private let m_rebuildFaces: array<wref<AnimatedComponent>>;/, 'weak: no component is kept alive');
  assert.match(nativeFace, /private let m_rebuildTemplates: array<Uint64>;/);
  // The second half.
  const claim = body(nativeFace, 'private cb func OnReassemble', 'public func RebuildCounts');
  inOrder(claim, ['!this.m_spawnedSeen || this.m_crowdMode == 0', 'event.GetEntity() as NPCPuppet',
    'ConvaiFaceService.SpawnedElsewhere(dynamic, npc.GetEntityID())', 'ArraySize(this.m_rebuildFaces) == 0', 'ResRef.GetHash(npc.GetTemplatePath())', 'this.m_rebuildTemplates[i] == key',
    'this.PrepareSpawnedFace(face)', 'ArrayErase(this.m_rebuildFaces, i)', 'npc.ConvaiFacePrepared(']);
  assert.match(claim, /let i = ArraySize\(this\.m_rebuildFaces\) - 1;\s*while i >= 0 \{/, 'newest first');
  assert.match(claim, /if Equals\(status, ""\) \{\s*status = result;\s*graphPath = ResRef\.ToString\(ResourceRef\.GetPath\(face\.graph\)\);\s*\};/,
    'the puppet gets the newest note status and the graph path of the face that was prepared');
  assert.match(claim, /if !Equals\(status, ""\) \{\s*npc\.ConvaiFacePrepared\(StrBeginsWith\(status, "prepared:"\), status, graphPath\);\s*\} else \{\s*this\.m_rebuildMissed \+= 1;\s*\};/);
  assert.doesNotMatch(claim, /IsTagged\(|face\.graph = |ScheduleAppearanceChange/, 'our own copies are not claimed here, and the graph is written only by PrepareSpawnedFace');
  // Registered once, filtered to NPCPuppet by the callback system, in OnLoad (never from inside another callback).
  assert.match(nativeFace, /RegisterCallback\(n"Entity\/Reassemble", this, n"OnReassemble"\)\s*\.AddTarget\(EntityTarget\.Type\(n"NPCPuppet"\)\)/);
  assert.equal([...nativeFace.matchAll(/RegisterCallback\(n"Entity\/Reassemble"/g)].length, 1);
  assert(body(nativeFace, 'private cb func OnLoad', 'private cb func OnCompanionExtract').includes('n"OnReassemble"'));
  // A spawned character seen at its first build or at Initialize switches the notes on; nothing else does.
  assert.equal([...nativeFace.matchAll(/this\.m_spawnedSeen = true;/g)].length, 2);
  const world = body(nativeFace, 'private cb func OnWorldInitialize', 'private func CrowdIndex');
  assert.match(world, /SpawnedElsewhere\(dynamic, npc\.GetEntityID\(\)\) \{ return; \};\s*this\.m_spawnedSeen = true;/);
  // The status tells the truth: a prepared face that now runs another graph is "stale:<graph>" with the rebuild counts, and the
  // talk-start request reports it (so the Lua log line "Face request: ... status=stale:..." appears).
  const status = body(nativeFace, 'public final func ConvaiFaceStatus()', 'public final func ConvaiFaceReady()');
  assert.match(status, /this\.m_convaiFacePrepared && !Equals\(this\.m_convaiFaceGraphPath, ""\)/);
  assert.match(status, /return "stale:" \+ live \+ \(IsDefined\(service\) \? " " \+ service\.RebuildCounts\(\) : ""\);/);
  assert.match(body(nativeFace, 'public final func ConvaiFaceRequest()', 'public final func ConvaiFaceApply('), /return this\.ConvaiFaceStatus\(\);/);
  assert.match(nativeFace, /public func RebuildCounts\(\) -> String \{\s*return "noted=" \+ IntToString\(this\.m_rebuildStashed\)/);
  // Our own companion extraction and the ordinary-NPC spawn path are unchanged by all of this.
  assert.match(extract, /if !dynamic\.IsTagged\(builder\.GetEntityID\(\), n"CyberpunkConvaiCompanion"\) \{/);
  // No per-frame work.
  assert.doesNotMatch(nativeFace, /OnUpdate|UpdateScriptableService/);
});

// The filter, run as written: CrowdSkipReason and QuestBound are mechanical transliterations of their redscript bodies
// (let/while/if and four string natives only). Story characters, named roster characters and Johnny stay vanilla.
const redscript = nativeFace.replace(/\r\n/g, '\n');
const transliterate = (signature, parameters) => {
  const from = redscript.indexOf(signature);
  assert(from >= 0, signature);
  const text = redscript.slice(redscript.indexOf('{', from) + 1, redscript.indexOf('\n  }', from));
  const js = text.replace(/\};/g, '}').replace(/\b(if|while) ([\s\S]*?) \{/g, '$1 ($2) {').replace(/ConvaiFaceService\.QuestBound\(/g, 'questBound(');
  return new Function(...parameters, js);
};
const questBoundJs = transliterate('public static func QuestBound(text: String) -> Bool {', ['text', 'StrLen', 'StrMid', 'StrContains', 'Equals']);
const questBound = text => questBoundJs(text, s => s.length, (s, i, n) => s.substr(i, n), (s, x) => x !== '' && s.includes(x), (a, b) => a === b);
const skipJs = transliterate('public static func CrowdSkipReason(', ['recordValid', 'named', 'appearance', 'record', 'questBound']);
const skipReason = (recordValid, named, appearance = '', record = '') => skipJs(recordValid, named, appearance, record, questBound);
const redscriptNamed = new Set([...featureSource().match(/NamedRecords\(\) -> array<String> \{\s*return \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map(match => match[1]));
test('the spawn filter keeps story characters, named roster characters and Johnny vanilla, and lets ordinary NPCs through', () => {
  // The decision for a record, as OnWorldInitialize makes it: roster first, then the strings.
  const decide = (record, appearance) => {
    const named = redscriptNamed.has(record);
    let reason = skipReason(true, named);
    if (reason === '') reason = skipReason(true, false, appearance, record);
    return reason;
  };
  assert.equal(skipReason(false, false), 'skipped:no-record', 'an unreadable record fails closed');
  assert.equal(decide('Character.Silverhand', 'johnny_silverhand'), 'skipped:named', 'Johnny: his record uses man_average_sermo');
  for (const record of ['Character.Smasher', 'Character.Alt', 'Character.Judy', 'Character.Jackie', 'Character.wakako_okada', 'Character.reggie']) {
    assert.equal(decide(record, 'whatever'), 'skipped:named', record);
  }
  // Quest tokens in the appearance or the record, even for a record the roster does not list.
  assert.equal(decide('Character.LowlifeMale', 'citizen__arasaka_corpo_wa__q004__konpeki_receptionist_04'), 'skipped:quest');
  assert.equal(decide('Character.sq021_unlisted_vendor', 'lowlife_ma__01'), 'skipped:quest');
  assert.equal(decide('Character.mq003_guard', 'x'), 'skipped:quest');
  assert.equal(decide('Character.q101_johnny_bartender', 'x'), 'skipped:quest', 'a quest-placed Johnny');
  for (const record of ['Character.LowlifeMale', 'Character.CorpoMan', 'Character.HomelessMan', 'Character.StoopKing', 'Character.WorkerMale',
    'Character.LowlifeWoman', 'Character.cct_dtn_food_02', 'Character.wat_kab_foodshop_04']) {
    assert.equal(decide(record, 'citizen__lowlife_ma__01'), '', record);
  }
  // The roster list is the character data, not a guess: every record of every profile, phone contact and managed copy.
  const named = new Set(namedRecords());
  assert.deepEqual([...redscriptNamed].sort(), [...named].sort(), 'FaceFeature.reds carries the roster as generated');
  for (const record of ['Character.Silverhand', 'Character.Smasher', 'Character.Alt']) assert(named.has(record), record);
  const read = file => JSON.parse(readFileSync(new URL(`../characters/${file}`, import.meta.url), 'utf8').replace(/^﻿/, ''));
  for (const row of read('roster.json')) for (const record of row.records || []) assert(named.has(record), `roster ${row.key} ${record}`);
  for (const row of read('manager-characters.json')) assert(named.has(row.record), row.key);
  for (const row of read('phone-contacts.json')) if (row.record) assert(named.has(row.record), row.contact);
  assert(named.size >= 75, `the roster has ${named.size} records`);
  for (const record of ['Character.LowlifeMale', 'Character.CorpoMan', 'Character.HomelessMan', 'Character.StoopKing']) {
    assert.equal(named.has(record), false, `${record} is an ordinary crowd record`);
  }
});

// The native quest-token check, run as written (a mechanical transliteration of
// its redscript body, which uses only let/while/if and four string natives).
test('QuestBound recognizes quest appearance and record tokens and leaves crowd names alone', () => {
  const start = nativeFace.indexOf('public static func QuestBound(text: String) -> Bool {');
  const source = nativeFace.replace(/\r\n/g, '\n');
  const from = source.indexOf('public static func QuestBound(text: String) -> Bool {');
  const body = source.slice(source.indexOf('{', from) + 1, source.indexOf('\n  }', from));
  assert(start >= 0 && body.includes('return false;'));
  const js = body.replace(/\};/g, '}').replace(/\b(if|while) ([\s\S]*?) \{/g, '$1 ($2) {');
  const questBound = new Function('text', 'StrLen', 'StrMid', 'StrContains', 'Equals', js);
  const run = text => questBound(text, s => s.length, (s, i, n) => s.substr(i, n), (s, x) => x !== '' && s.includes(x), (a, b) => a === b);
  for (const name of ['citizen__arasaka_corpo_wa__q004__konpeki_receptionist_04', 'Character.sq021_river', 'mq003_vendor', 'q101_x', 'Character.q115_guard'])
    assert.equal(run(name), true, name);
  for (const name of ['citizen__lowlife_ma__01', 'Character.Watson_Resident_Male', 'squad_7', 'iq100', 'aq123_b', 'Character.ma_q12'])
    assert.equal(run(name), false, name);
});

// October 10: the speech deltas were only ADDED to whatever facial idle the graph feeds the solver (a looped
// idle__<emotion> clip, a workspot's, a scene's), and an idle holding lips_together or jaw_mid_close sealed a written
// jaw, sometimes. The game's own dialogue lipsync also writes <control>AnimOverrideWeight and lipSyncEnvelope, and
// the solver scales the streamed value by lerp(1, override, envelope) before adding the lipsync pose. One owner input
// raises the envelope and lowers each override weight, so 0 is the native graph and 1 gives the mouth to the writer.
test('speech ownership fades the idle mouth with one shared input and leaves eyes, brows and the rest alone', () => {
  const result = extendFacialGraph(fixture()), {handles} = inspectGraph(result);
  const idOf = data => [...handles].find(([, entry]) => entry.Data === data)[0];
  const solver = result.Data.RootChunk.nodesToInit[0].Data;
  const owners = [];
  for (let at = solver.inputLink; at.node.Data.$type === 'animAnimNode_FloatTrackModifier'; at = at.node.Data.poseInputNode) {
    if (at.node.Data.debugName.$value === 'Convai speech owner') owners.push(at.node.Data);
  }
  const envelope = owners.filter(node => node.floatTrack.name.$value === schema.owner.envelope);
  assert.equal(envelope.length, 1);
  assert.equal(envelope[0].operationType, 'Add');
  const faded = owners.filter(node => node !== envelope[0]);
  assert.deepEqual(faded.map(node => node.floatTrack.name.$value).sort(),
    schema.owner.faded.map(track => `${track}AnimOverrideWeight`).sort());
  for (const node of faded) {
    assert.equal(node.operationType, 'Subtract', 'the override weight starts at 1 and falls with the owner');
    assert.equal(node.inputFloatTrack.name.$value, 'None');
  }
  // One FloatInput, defined once and referenced by every ownership node.
  const names = new Set(owners.map(node => {
    const target = node.floatInputNode.node;
    return (target.Data || handles.get(target.HandleRefId).Data).name.$value;
  }));
  assert.deepEqual([...names], [schema.owner.input]);
  const definitions = [...handles.values()].filter(node => node.Data.$type === 'animAnimNode_FloatInput' && node.Data.name.$value === schema.owner.input);
  assert.equal(definitions.length, 1);
  const initialized = result.Data.RootChunk.nodesToInit.map(entry => entry.HandleRefId);
  for (const id of [definitions[0].HandleId, ...owners.map(idOf)]) assert(initialized.includes(id), `node ${id} is initialized`);
  // Ownership never touches the lids, brows, neck, tongue or nose, and the feature is not a rig track.
  assert(schema.owner.faded.every(track => /^(jaw|lips|cheek)_/.test(track)), 'only jaw, lips and cheeks fade');
  assert(schema.owner.faded.every(track => !/sticky|cutScene/.test(track)));
  assert.equal(schema.tracks.includes(schema.owner.input), false);
  for (const track of ['jaw_mid_open', 'jaw_mid_close', 'lips_together_up', 'lips_together_dn', 'lips_suck_dn', 'lips_l_purse', 'lips_chin_raise']) {
    assert(schema.owner.faded.includes(track), `${track} fades`);
  }
  assert.equal(schema.owner.faded.some(track => /blink|brows|widen|squint/.test(track)), false);
  assert.match(featureSource(), new RegExp(`public let ${schema.owner.input}: Float;`));
  assert.equal(featureSource().includes(`n"${schema.owner.input}LipsyncPoseOutput"`), false, 'the owner is not a required rig track');
});

test('speech ownership is refused when the solver does not have the tracks it would write', () => {
  const noList = fixture(); delete noList.Data.RootChunk.nodesToInit[0].Data.testController;
  assert.throws(() => extendFacialGraph(noList), /no track list/);
  const missing = fixture(); delete missing.Data.RootChunk.nodesToInit[0].Data.testController.jaw_mid_closeAnimOverrideWeight;
  assert.throws(() => extendFacialGraph(missing), /jaw_mid_closeAnimOverrideWeight/);
  const noEnvelope = fixture(); delete noEnvelope.Data.RootChunk.nodesToInit[0].Data.testController[schema.owner.envelope];
  assert.throws(() => extendFacialGraph(noEnvelope), new RegExp(schema.owner.envelope));
});

const shipped = new URL('../runtime/facial-rig/json/woman_average_sermo.animgraph.json', import.meta.url);
test('every extracted game graph exposes the ownership tracks', {skip: !existsSync(shipped)}, () => {
  for (const graph of schema.graphs) {
    const source = readFileSync(new URL(`../runtime/facial-rig/json/${graph}.animgraph.json`, import.meta.url), 'utf8');
    const result = extendFacialGraph(JSON.parse(source.replace(/^﻿/, '')));
    const {objects} = inspectGraph(result);
    const owners = objects.filter(node => node.$type === 'animAnimNode_FloatTrackModifier' && node.debugName?.$value === 'Convai speech owner');
    assert.equal(owners.length, schema.owner.faded.length + 1, graph);
    const inputs = objects.filter(node => node.$type === 'animAnimNode_FloatInput' && node.group?.$value === 'ConvaiFace');
    assert.equal(inputs.length, schema.tracks.length + 1, graph);
    assert.equal(forwardReferences(result), 0, graph);
  }
});

// October 14: the crowd copy of the four graphs. The speech layer sits behind one Switch that a face that is not being
// voiced never selects. The game builds the same shape itself (Switch nodes 25, 27 and 427 of woman_average_sermo: input 0
// is a node, input 1 is that node plus more), so a face that is not speaking evaluates one switch more than vanilla.
const nodeTypes = document => {
  const counts = {};
  for (const node of inspectGraph(document).objects) counts[node.$type] = (counts[node.$type] || 0) + 1;
  return counts;
};
// Graph nodes and the expression objects only: links, colors and names are plumbing that follow the nodes.
const typeDiff = (a, b) => {
  const diff = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (/^(animAnimNode_|mathExpr|animMathExpression|animAnimMathExpression)/.test(key) && (a[key] || 0) !== (b[key] || 0)) diff[key] = (b[key] || 0) - (a[key] || 0);
  }
  return diff;
};
const gateNodeTypes = {animAnimNode_Switch: 1, animAnimNode_MathExpressionFloat: 1, mathExprExpression: 1, animMathExpressionNodeData: 1, animAnimMathExpressionFloatSocket: 1};

test('the crowd graph puts the speech layer behind one switch that speech_owner > 0 opens and leaves input 0 as the vanilla pose', () => {
  const original = fixture(), before = JSON.stringify(original);
  const result = extendFacialGraph(original, {gate: true});
  assert.equal(JSON.stringify(original), before, 'the source graph is never edited');
  const {handles} = inspectGraph(result);
  const solver = result.Data.RootChunk.nodesToInit[0].Data;
  const select = solver.inputLink.node.Data;
  assert.equal(select.$type, 'animAnimNode_Switch');
  assert.equal(select.numInputs, 2);
  assert.equal(select.inputNodes.length, 2);
  assert.equal(select.blendTime, schema.crowd.gate.blendTime, 'no blend: the switch opens on the first speaking frame');
  assert.deepEqual(select.inputNodes[0], original.Data.RootChunk.nodesToInit[0].Data.inputLink, 'input 0 is the solver\'s original input, untouched');
  let at = select.inputNodes[1], speech = 0, owners = 0;
  while (at.node.Data?.$type === 'animAnimNode_FloatTrackModifier') {
    if (at.node.Data.debugName.$value === 'Convai speech owner') owners++; else speech++;
    at = at.node.Data.poseInputNode;
  }
  assert.deepEqual(at, {$type: 'animPoseLink', node: {HandleRefId: '1'}}, 'input 1 ends on the very node input 0 is');
  assert.equal(speech, schema.tracks.length);
  assert.equal(owners, schema.owner.faded.length + 1);
  const compare = select.weightNode.node.Data;
  assert.equal(compare.$type, 'animAnimNode_MathExpressionFloat');
  assert.equal(compare.expressionString, 'a > 0');
  assert.deepEqual({returnVarType: compare.expressionData.expression.Data.returnVarType, tokenData: compare.expressionData.expression.Data.tokenData,
    valuesData: compare.expressionData.expression.Data.valuesData}, GATE_EXPRESSION, 'the game\'s own compiled "a > 0"');
  assert.equal(compare.expressionData.floatSockets.length, 1);
  assert.equal(compare.expressionData.floatSockets[0].expressionVarId, 0);
  const source = handles.get(compare.expressionData.floatSockets[0].link.node.HandleRefId).Data;
  assert.equal(source.$type, 'animAnimNode_FloatInput');
  assert.equal(source.name.$value, schema.owner.input, 'the gate reads speech_owner, which the writer holds above zero while the reply is heard');
  assert.equal(source.group.$value, 'ConvaiFace');
  assert.equal(forwardReferences(result), forwardReferences(original), 'every handle is defined before it is referenced');
  const initialized = result.Data.RootChunk.nodesToInit.map(entry => entry.HandleRefId);
  const ids = [...handles].filter(([, entry]) => entry.Data === select || entry.Data === compare).map(([id]) => id);
  assert.equal(ids.length, 2);
  for (const id of ids) assert(initialized.includes(id), `node ${id} is initialized`);
  // Same nodes as the companion graph plus the gate, nothing else.
  const companion = extendFacialGraph(fixture());
  assert.deepEqual(typeDiff(nodeTypes(companion), nodeTypes(result)), gateNodeTypes);
  assert.equal(nodeTypes(companion).animAnimNode_Switch, undefined, 'the companion graph has no switch');
  assert.equal(result.Data.RootChunk.animFeatures.filter(feature => feature.name.$value === 'ConvaiFace').length, 1);
});

test('the gate changes nothing for the companion graphs and refuses a schema that cannot gate', () => {
  assert.deepEqual(extendFacialGraph(fixture(), {gate: false}), extendFacialGraph(fixture()));
  assert.deepEqual(extendFacialGraph(fixture(), {}), extendFacialGraph(fixture()));
  assert.equal(schema.crowd.gate.input, schema.owner.input);
  assert.deepEqual(schema.crowd.graphs.filter(name => !schema.graphs.includes(name)), []);
  for (const name of schema.crowd.graphs) assert.match(crowdPath(name), /^cyberpunk_convai\\facial\\crowd\\[a-z_]+_sermo\.animgraph$/);
  assert.equal(new Set([...schema.graphs.map(name => `cyberpunk_convai\\facial\\${name}.animgraph`), ...schema.crowd.graphs.map(crowdPath)]).size, 13,
    'nine companion graphs and four crowd copies never share a path');
});

test('graph verification accepts the built shapes and rejects a gate that is not exactly the designed one', () => {
  const plain = extendFacialGraph(fixture()), gated = () => extendFacialGraph(fixture(), {gate: true});
  assert.equal(verifyGraph(plain, 'companion').gates, 0);
  const report = verifyGraph(gated(), 'crowd', {gated: true});
  assert.deepEqual([report.gates, report.connectedControls, report.ownershipNodes], [1, schema.tracks.length, schema.owner.faded.length + 1]);
  assert.throws(() => verifyGraph(gated(), 'x'), /controls are not connected/, 'a gated graph is not a companion graph');
  assert.throws(() => verifyGraph(extendFacialGraph(fixture()), 'x', {gated: true}), /not the speech gate/);
  const mutate = change => { const doc = gated(); change(doc.Data.RootChunk.nodesToInit[0].Data.inputLink.node.Data); return doc; };
  assert.throws(() => verifyGraph(mutate(select => { select.numInputs = 3; }), 'x', {gated: true}), /two-input switch/);
  assert.throws(() => verifyGraph(mutate(select => { select.blendTime = 0.5; }), 'x', {gated: true}), /two-input switch/);
  assert.throws(() => verifyGraph(mutate(select => { select.weightNode.node.Data.expressionString = 'a < 0'; }), 'x', {gated: true}), /compare an input with zero/);
  assert.throws(() => verifyGraph(mutate(select => { select.weightNode.node.Data.expressionData.expression.Data.tokenData = [1, 2, 3]; }), 'x', {gated: true}), /compare an input with zero/);
  assert.throws(() => verifyGraph(mutate(select => { select.inputNodes.reverse(); }), 'x', {gated: true}), /do not share the original input/);
  assert.throws(() => verifyGraph(mutate(select => {
    select.weightNode.node.Data.expressionData.floatSockets[0].link.node = {HandleRefId: '1'};
  }), 'x', {gated: true}), /does not read speech_owner/);
});

// The archive layout the facial build verifies: nine companion graphs and four crowd copies, nothing at a base-game path.
test('archive verification accepts exactly the thirteen approved depot paths', () => {
  const archive = paths => {
    const index = 40, bytes = Buffer.alloc(index + 28 + paths.length * 56);
    bytes.write('RDAR', 0, 'ascii'); bytes.writeUInt32LE(12, 4); bytes.writeBigUInt64LE(BigInt(index), 8);
    bytes.writeUInt32LE(paths.length, index + 16);
    paths.forEach((path, i) => bytes.writeBigUInt64LE(BigInt(pathHash(path)), index + 28 + i * 56));
    return bytes;
  };
  const approved = archivePaths();
  assert.equal(approved.length, 13);
  assert.equal(verifyArchive(archive(approved)), 13);
  assert.throws(() => verifyArchive(archive(approved.slice(1))), /Unexpected archive entries/);
  assert.throws(() => verifyArchive(archive([...approved.slice(1), 'base\\animations\\facial\\_facial_graphs\\man_average_sermo.animgraph'])), /unapproved/);
  assert.throws(() => verifyArchive(archive([...approved.slice(1), approved[1]])), /unapproved or duplicate/);
});

// The real extracted graphs (the user's own game files, not in git). The same four vanilla graphs, three ways.
test('on the extracted game graphs the crowd copy is the companion graph plus exactly one gate, and input 0 is the vanilla input', {skip: !existsSync(shipped)}, () => {
  for (const graph of schema.crowd.graphs) {
    const vanilla = JSON.parse(readFileSync(new URL(`../runtime/facial-rig/json/${graph}.animgraph.json`, import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
    const companion = extendFacialGraph(vanilla), crowd = extendFacialGraph(vanilla, {gate: true});
    assert.deepEqual(typeDiff(nodeTypes(companion), nodeTypes(crowd)), gateNodeTypes, graph);
    const vanillaSolver = inspectGraph(vanilla).objects.find(node => node.$type === 'animAnimNode_Sermo');
    const crowdSolver = inspectGraph(crowd).objects.find(node => node.$type === 'animAnimNode_Sermo');
    const select = crowdSolver.inputLink.node.Data;
    assert.equal(JSON.stringify(select.inputNodes[0]), JSON.stringify(vanillaSolver.inputLink), `${graph}: input 0 is the vanilla solver input, byte for byte`);
    assert.equal(forwardReferences(crowd), 0, graph);
    assert.equal(verifyGraph(crowd, graph, {gated: true}).gates, 1);
    assert.equal(verifyGraph(companion, graph).gates, 0);
    // The vanilla graph already holds the "a > 0" the gate reuses, with identical compiled data.
    const reference = inspectGraph(vanilla).objects.filter(node => node.$type === 'animAnimNode_MathExpressionFloat' && node.expressionString === 'a > 0');
    assert(reference.length > 0, graph);
    for (const node of reference) {
      const data = node.expressionData.expression.Data || inspectGraph(vanilla).handles.get(node.expressionData.expression.HandleRefId).Data;
      assert.deepEqual({returnVarType: data.returnVarType, tokenData: data.tokenData, valuesData: data.valuesData}, GATE_EXPRESSION, graph);
    }
  }
});
