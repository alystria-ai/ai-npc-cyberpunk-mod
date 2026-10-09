import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {extendFacialGraph, inspectGraph, schema, featureSource} from '../scripts/Build-FacialGraphs.mjs';

const name = value => ({$type: 'CName', $storage: 'string', $value: value});
const nativeFace = readFileSync(new URL('../r6/scripts/CyberpunkConvai/Face.reds', import.meta.url), 'utf8');
function fixture() {
  return {Header: {}, Data: {RootChunk: {$type: 'animAnimGraph',
    rootNode: {HandleRefId: '0'}, animFeatures: [{name: name('Eyes'), className: name('AnimFeature_LookAt')}],
    nodesToInit: [{HandleId: '0', Data: {$type: 'animAnimNode_Sermo',
      inputLink: {$type: 'animPoseLink', node: {HandleId: '1', Data: {
        $type: 'animAnimNode_EyesTracksLookAt', existingEyeSetting: 0.375}}}}}, {HandleRefId: '1'}]}}};
}

test('speech layer preserves the original graph and its complete gaze input', () => {
  const original = fixture(), before = JSON.stringify(original);
  const result = extendFacialGraph(original);
  assert.equal(JSON.stringify(original), before);
  let input = result.Data.RootChunk.nodesToInit[0].Data.inputLink;
  const seen = new Set();
  while (input.node.Data.$type === 'animAnimNode_FloatTrackModifier') {
    const node = input.node.Data;
    assert.equal(node.operationType, 'Add');
    assert.match(node.floatTrack.name.$value, /LipsyncPoseOutput$/);
    assert.equal(node.floatInputNode.node.Data.group.$value, 'ConvaiFace');
    assert.equal(node.floatInputNode.node.Data.debugInput, 0);
    seen.add(node.floatInputNode.node.Data.name.$value);
    input = node.poseInputNode;
  }
  assert.deepEqual(seen, new Set(schema.tracks));
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
  assert.doesNotMatch(nativeFace, /RegisterCallback\(n"Entity\/(?:Attach|AfterAttach|Reassemble)"/);
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
  assert.match(prepare, /if Equals\(original, preparedPath\) \{ return "prepared:" \+ this\.m_names\[i\]; \};\s*if check \{ return "supported:" \+ this\.m_names\[i\]; \};\s*face\.graph = this\.m_graphs\[i\];/,
    'a prepared graph is never rewritten, and a check of a running component never writes');
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
  assert.match(ready, /if dynamic\.IsManaged\(this\.GetEntityID\(\)\) \{[^}]*if !dynamic\.IsTagged\(this\.GetEntityID\(\), n"CyberpunkConvaiCompanion"\) \{ return false; \};/,
    'a dynamic entity must carry the companion tag');
  assert.match(ready, /this\.FindComponentByName\(n"face_rig"\) as AnimatedComponent/);
  assert.match(ready, /ResourceRef\.IsLoaded\(face\.graph\)/);
  assert.match(ready, /ResourceRef\.IsFailed\(face\.graph\)/);
  assert.match(ready, /Equals\(ResRef\.ToString\(ResourceRef\.GetPath\(face\.graph\)\), this\.m_convaiFaceGraphPath\)/);
  const fields = [...nativeFace.matchAll(/@addField\(NPCPuppet\)\s*private let (\w+): ([^;]+);/g)];
  assert(fields.every(([, , type]) => ['Bool', 'String'].includes(type)), 'no actor/component/resource handle is retained on the puppet');
});

// October 8: a resident-male pedestrian on Pocket kept a still mouth. Crowd and
// community NPCs are not dynamic entities, so their running face_rig has the
// vanilla graph. FPS rules out preparing every spawned NPC: only the talk target
// is prepared, on demand, by rebuilding its own current appearance.
test('world NPC faces are prepared on demand for the talk target only, never at spawn', () => {
  assert.doesNotMatch(nativeFace, /OnWorldInitialize|EntityTarget\.Type\(/, 'no per-spawn preparation of world NPCs');
  assert.equal([...nativeFace.matchAll(/RegisterCallback\(/g)].length, 2, 'only the companion Initialize and the Extract callbacks');
  const extract = nativeFace.slice(nativeFace.indexOf('private cb func OnCompanionExtract'),
    nativeFace.indexOf('private func PrepareExtractedComponents'));
  const pending = extract.indexOf('ArraySize(this.m_worldPending) > 0');
  assert(pending >= 0 && pending < extract.indexOf('builder.HasEntity()'), 'with nothing pending a build costs one size check');
  assert.match(extract, /!builder\.HasEntity\(\)\s*&& builder\.HasAppearance\(\) && this\.ConsumeWorldRequest\(builder\.GetAppearanceName\(\)\)/);
  const request = nativeFace.slice(nativeFace.indexOf('public func RequestWorldFace'),
    nativeFace.indexOf('private func PrepareWorldAppearance'));
  assert.match(request, /if dynamic\.IsManaged\(npc\.GetEntityID\(\)\) \{ return "managed"; \};/);
  assert.match(request, /this\.PrepareFaceComponent\(face, true\)/, 'the running component is only checked');
  assert(request.indexOf('this.ReleaseOldestWorld(npc, appearance)') < request.indexOf('npc.ScheduleAppearanceChange(appearance)'));
  // October 9: a Konpeki receptionist (appearance ..._q004_...) was rebuilt. Quest-owned NPCs and
  // NPCs in a dialogue are never rebuilt. October 10: a scene alone no longer blocks it, because a
  // vendor at its stall is a scene actor; a scene still blocks anyone who is neither crowd nor vendor,
  // and an NPC a quest marked or whose AI is commanded (not autonomous) is skipped before any rebuild.
  const rebuild = request.indexOf('npc.ScheduleAppearanceChange(appearance)');
  for (const guard of ['return "skipped:dialogue"', 'return "skipped:quest"', 'return "skipped:driven"', 'return "skipped:scene"']) {
    assert(request.indexOf(guard) >= 0 && request.indexOf(guard) < rebuild, guard);
  }
  assert.match(request, /scene\.IsEntityInDialogue\(npc\.GetEntityID\(\)\) \{ return "skipped:dialogue"; \};/);
  assert.match(request, /inScene = scene\.IsEntityInScene\(npc\.GetEntityID\(\)\)/);
  assert.match(request, /if npc\.IsQuest\(\) \|\| !npc\.IsOnAutonomousAI\(\) \{ return "skipped:driven"; \};/);
  assert.match(request, /if inScene && !npc\.IsVendor\(\) && !npc\.IsCrowd\(\) \{ return "skipped:scene"; \};/);
  assert.doesNotMatch(request, /IsEntityInScene\(npc\.GetEntityID\(\)\) \|\|/, 'a scene alone must not skip an ambient NPC');
  assert(request.indexOf('ConvaiFaceNoteWorkspot()') > request.indexOf('return "skipped:scene"') && request.indexOf('ConvaiFaceNoteWorkspot()') < rebuild,
    'the workspot is noted once, right before a rebuild that will happen');
  assert.match(request, /QuestBound\(NameToString\(appearance\)\)\s*\|\| ConvaiFaceService\.QuestBound\(TDBID\.ToStringDEBUG\(npc\.GetRecordID\(\)\)\)/);
  assert(request.indexOf('return "skipped:quest"') < request.indexOf('return "skipped:driven"'));
  assert.match(nativeFace, /public final func ConvaiFaceWorkspotNote\(\) -> String/);
  assert.doesNotMatch(request, /face\.graph =/);
  const release = nativeFace.slice(nativeFace.indexOf('private func ReleaseOldestWorld'),
    nativeFace.indexOf('private func PrepareFaceComponent'));
  assert.match(release, /while ArraySize\(this\.m_worldPrepared\) >= 2/, 'at most two world NPCs keep the layer');
  assert.match(release, /!this\.SceneOwns\(old\)/, 'an NPC a quest took since is forgotten, never rebuilt under the scene');
  const sceneOwns = nativeFace.slice(nativeFace.indexOf('private func SceneOwns'), nativeFace.indexOf('private func PrepareFaceComponent'));
  assert.match(sceneOwns, /IsEntityInDialogue\(npc\.GetEntityID\(\)\) \|\| npc\.IsQuest\(\) \|\| !npc\.IsOnAutonomousAI\(\)/);
  const adopt = nativeFace.slice(nativeFace.indexOf('private final func ConvaiFaceAdoptWorld'),
    nativeFace.indexOf('public final func ConvaiFaceRequest'));
  assert(adopt.includes('StrBeginsWith(path, "cyberpunk_convai\\\\facial\\\\")'));
  const apply = nativeFace.slice(nativeFace.indexOf('public final func ConvaiFaceApply('),
    nativeFace.indexOf('public final func ConvaiFaceReset('));
  assert.match(apply, /if !this\.ConvaiFaceReady\(\) \|\| !IsDefined\(feature\) \{ return false; \};/);
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  assert.equal([...init.matchAll(/:ConvaiFaceRequest\(\)/g)].length, 4, 'composer, microphone, group speaker and the dev-only scripted talk only');
  const gaze = init.slice(init.indexOf('local function updateGaze'), init.indexOf('local function updateGaze') + 4000);
  assert.doesNotMatch(gaze, /ConvaiFaceRequest/, 'a glance never rebuilds an NPC');
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
