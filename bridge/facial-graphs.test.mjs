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
  assert.match(prepare, /if !Equals\(original, preparedPath\) \{ face\.graph = this\.m_graphs\[i\]; \}/);
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
  assert.match(ready, /dynamic\.IsManaged\(this\.GetEntityID\(\)\)\s*&& !dynamic\.IsTagged\(this\.GetEntityID\(\), n"CyberpunkConvaiCompanion"\)/,
    'a dynamic entity must carry the companion tag');
  assert.match(ready, /this\.FindComponentByName\(n"face_rig"\) as AnimatedComponent/);
  assert.match(ready, /ResourceRef\.IsLoaded\(face\.graph\)/);
  assert.match(ready, /ResourceRef\.IsFailed\(face\.graph\)/);
  assert.match(ready, /Equals\(ResRef\.ToString\(ResourceRef\.GetPath\(face\.graph\)\), this\.m_convaiFaceGraphPath\)/);
  const fields = [...nativeFace.matchAll(/@addField\(NPCPuppet\)\s*private let (\w+): ([^;]+);/g)];
  assert(fields.every(([, , type]) => ['Bool', 'String'].includes(type)), 'no actor/component/resource handle is retained on the puppet');
});

// October 8: a resident-male pedestrian on Pocket kept a still mouth. Crowd and
// community NPCs are not dynamic entities, so the companion-only preparation
// left their vanilla face graph without the ConvaiFace input. World NPCs now get
// the same additive layer at initialization; dynamic entities stay with their spawner.
test('world NPCs are prepared once at initialization; other dynamic entities and the apply path stay gated', () => {
  assert.match(nativeFace, /RegisterCallback\(n"Entity\/Initialize", this, n"OnWorldInitialize"\)\s*\.AddTarget\(EntityTarget\.Type\(n"NPCPuppet"\)\)/);
  const world = nativeFace.slice(nativeFace.indexOf('private cb func OnWorldInitialize'),
    nativeFace.indexOf('private func PrepareFaceComponent'));
  assert(world.length > 0);
  const skip = world.indexOf('dynamic.IsManaged(npc.GetEntityID())');
  assert(skip >= 0 && skip < world.indexOf('this.PrepareFaceComponent(face)'), 'dynamic entities are skipped before any change');
  assert.match(world, /npc\.FindComponentByName\(n"face_rig"\) as AnimatedComponent/);
  assert.match(world, /npc\.ConvaiFacePrepared\(ready, status, graphPath\)/);
  assert.doesNotMatch(world, /GetResource\(|nodesToInit|animFeatures|GetComponents\(\)/);
  const apply = nativeFace.slice(nativeFace.indexOf('public final func ConvaiFaceApply('),
    nativeFace.indexOf('public final func ConvaiFaceReset('));
  assert.match(apply, /if !this\.ConvaiFaceReady\(\) \|\| !IsDefined\(feature\) \{ return false; \};/);
});
