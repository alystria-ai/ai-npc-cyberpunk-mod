import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inspectGraph, schema, crowdPath, GATE_EXPRESSION} from './Build-FacialGraphs.mjs';

// The depot paths the facial archive may contain: the nine companion graphs, and the four gated crowd copies.
export function archivePaths() {
  return [...schema.graphs.map(name => `cyberpunk_convai\\facial\\${name}.animgraph`),
    ...(schema.crowd?.graphs || []).map(crowdPath)];
}

export function pathHash(path) {
  let value = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(path.toLowerCase())) value = BigInt.asUintN(64, (value ^ BigInt(byte)) * 0x100000001b3n);
  return value.toString();
}

export function verifyArchive(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RDAR' || bytes.readUInt32LE(4) !== 12) throw new Error('Unknown archive format');
  const index = Number(bytes.readBigUInt64LE(8));
  if (!Number.isSafeInteger(index) || index < 20 || index + 28 > bytes.length) throw new Error('Invalid archive index');
  const count = bytes.readUInt32LE(index + 16);
  const paths = archivePaths();
  if (count !== paths.length || index + 28 + count * 56 > bytes.length) throw new Error('Unexpected archive entries');
  const expected = new Set(paths.map(pathHash));
  for (let i = 0; i < count; i++) {
    const entry = bytes.readBigUInt64LE(index + 28 + i * 56).toString();
    if (!expected.delete(entry)) throw new Error('Archive contains an unapproved or duplicate resource path');
  }
  if (expected.size) throw new Error('Archive is missing a speech graph');
  return count;
}

// One graph: the speech inputs exist, and the chain in front of the native solver is exactly what the builder makes.
// gated = the crowd copy: the solver's input is one Switch whose input 0 is the original input and whose input 1 is the
// speech chain on top of that same node, selected by "speech_owner > 0".
export function verifyGraph(doc, name, {gated = false} = {}) {
  const {handles, objects} = inspectGraph(doc);
  const owner = schema.owner;
  const inputs = objects.filter(x => x.$type === 'animAnimNode_FloatInput' && x.group?.$value === schema.group);
  const actual = new Set(inputs.map(x => x.name.$value));
  const expectedInputs = schema.tracks.length + (owner ? 1 : 0);
  if (inputs.length !== expectedInputs || schema.tracks.some(track => !actual.has(track)) || (owner && !actual.has(owner.input))) {
    throw new Error(`${name}: native round-trip lost facial inputs`);
  }
  const solvers = objects.filter(x => x.$type === 'animAnimNode_Sermo');
  if (solvers.length !== 1) throw new Error(`${name}: wrong solver count`);
  const resolveNode = link => link?.Data ? link : handles.get(link?.HandleRefId);
  const idOf = link => link?.HandleId ?? link?.HandleRefId;
  let current = solvers[0].inputLink.node;
  let passthrough;
  let gate;
  if (gated) {
    const select = resolveNode(current)?.Data;
    const label = schema.crowd.gate.label;
    if (select?.$type !== 'animAnimNode_Switch' || select.debugName?.$value !== label) {
      throw new Error(`${name}: the solver input is not the speech gate`);
    }
    if (select.numInputs !== 2 || select.inputNodes?.length !== 2
        || Math.abs(select.blendTime - schema.crowd.gate.blendTime) > 1e-6) throw new Error(`${name}: the speech gate is not a two-input switch`);
    const compare = resolveNode(select.weightNode?.node)?.Data;
    const socket = compare?.expressionData?.floatSockets;
    const expression = compare?.expressionData?.expression;
    const expressionData = expression?.Data || handles.get(expression?.HandleRefId)?.Data;
    if (compare?.$type !== 'animAnimNode_MathExpressionFloat' || compare.expressionString !== 'a > 0'
        || socket?.length !== 1 || socket[0].expressionVarId !== 0
        || JSON.stringify(expressionData?.tokenData) !== JSON.stringify(GATE_EXPRESSION.tokenData)
        || JSON.stringify(expressionData?.valuesData) !== JSON.stringify(GATE_EXPRESSION.valuesData)
        || expressionData?.returnVarType !== GATE_EXPRESSION.returnVarType) {
      throw new Error(`${name}: the speech gate does not compare an input with zero`);
    }
    const source = resolveNode(socket[0].link?.node)?.Data;
    if (source?.$type !== 'animAnimNode_FloatInput' || source.name?.$value !== owner.input || source.group?.$value !== schema.group) {
      throw new Error(`${name}: the speech gate does not read ${owner.input}`);
    }
    passthrough = select.inputNodes[0].node;
    current = select.inputNodes[1].node;
    gate = 1;
  }
  const controls = [], ownership = [];
  const ownerInputs = new Set();
  while (current) {
    const node = current.Data || handles.get(current.HandleRefId)?.Data;
    const label = node?.debugName?.$value;
    if (node?.$type !== 'animAnimNode_FloatTrackModifier' || (label !== 'Convai speech' && label !== 'Convai speech owner')) break;
    if (label === 'Convai speech') {
      if (node.operationType !== 'Add') throw new Error(`${name}: speech would override the idle face`);
      controls.push(node.floatTrack.name.$value);
    } else {
      // Ownership: the owner input raises the envelope and lowers each override weight. Anything else would
      // rewrite the idle face in a way the solver does not expect.
      const target = node.floatTrack.name.$value;
      const wanted = target === owner?.envelope ? 'Add' : 'Subtract';
      if (!owner || node.operationType !== wanted || (target !== owner.envelope && !target.endsWith('AnimOverrideWeight'))) {
        throw new Error(`${name}: unexpected speech ownership node on ${target}`);
      }
      const source = node.floatInputNode.node;
      const input = source.Data || handles.get(source.HandleRefId)?.Data;
      ownerInputs.add(input?.name?.$value);
      ownership.push(target);
    }
    current = node.poseInputNode.node;
  }
  if (gated) {
    // The chain ends on the very node the vanilla pose comes from: input 0 passes the original pose through.
    const bottom = resolveNode(current), vanilla = resolveNode(passthrough);
    if (!bottom || bottom !== vanilla) throw new Error(`${name}: the speech chain and the passthrough do not share the original input`);
    const label = vanilla.Data?.debugName?.$value;
    if (label === 'Convai speech' || label === 'Convai speech owner') throw new Error(`${name}: the passthrough carries speech nodes`);
  }
  if (controls.length !== schema.tracks.length || schema.tracks.some(track => !controls.includes(`${track}LipsyncPoseOutput`))) {
    throw new Error(`${name}: controls are not connected before the native facial solver`);
  }
  if (owner) {
    const faded = owner.faded.map(track => `${track}AnimOverrideWeight`);
    if (ownership.length !== faded.length + 1 || !ownership.includes(owner.envelope) || faded.some(track => !ownership.includes(track))
        || ownerInputs.size !== 1 || !ownerInputs.has(owner.input)) {
      throw new Error(`${name}: speech ownership is not connected before the native facial solver`);
    }
  }
  const declared = doc.Data.RootChunk.animFeatures.filter(x => x.name?.$value === schema.group);
  if (declared.length !== 1 || declared[0].className.$value !== schema.feature) throw new Error(`${name}: feature declaration mismatch`);
  const switches = objects.filter(x => x.$type === 'animAnimNode_Switch' && x.debugName?.$value === schema.crowd?.gate?.label);
  if (switches.length !== (gated ? 1 : 0)) throw new Error(`${name}: unexpected number of speech gates`);
  return {graph: name, gated, inputs: inputs.length, connectedControls: controls.length, ownershipNodes: ownership.length,
    gates: gate || 0, roundtripVerified: true};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--archive') {
    const count = verifyArchive(readFileSync(resolve(process.argv[3])));
    console.log(`Verified ${count} archive entries, all under cyberpunk_convai\\facial. No base-game overrides.`);
    process.exit(0);
  }
  const inputDirectory = resolve(process.argv[2] || 'runtime/facial-rig/roundtrip');
  const read = path => JSON.parse(readFileSync(resolve(inputDirectory, path), 'utf8').replace(/^﻿/, ''));
  const reports = [];
  for (const name of schema.graphs) reports.push(verifyGraph(read(`${name}.animgraph.json`), name));
  for (const name of schema.crowd?.graphs || []) {
    reports.push(verifyGraph(read(`${schema.crowd.folder}/${name}.animgraph.json`), `${schema.crowd.folder}/${name}`, {gated: true}));
  }
  writeFileSync(resolve('runtime/facial-rig/verification.json'), JSON.stringify(reports, null, 2));
  console.log(`Verified ${reports.length} native graph round-trips (${schema.crowd?.graphs.length || 0} gated), ${schema.tracks.length} connected controls each.`);
}
