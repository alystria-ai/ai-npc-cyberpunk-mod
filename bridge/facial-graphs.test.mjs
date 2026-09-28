import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {extendFacialGraph, inspectGraph, schema, featureSource} from '../scripts/Build-FacialGraphs.mjs';

const name = value => ({$type: 'CName', $storage: 'string', $value: value});
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
