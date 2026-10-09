import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {inspectGraph, schema} from './Build-FacialGraphs.mjs';

if (process.argv[2] === '--archive') {
  const bytes = readFileSync(resolve(process.argv[3]));
  if (bytes.toString('ascii', 0, 4) !== 'RDAR' || bytes.readUInt32LE(4) !== 12) throw new Error('Unknown archive format');
  const index = Number(bytes.readBigUInt64LE(8));
  if (!Number.isSafeInteger(index) || index < 20 || index + 28 > bytes.length) throw new Error('Invalid archive index');
  const count = bytes.readUInt32LE(index + 16);
  if (count !== schema.graphs.length || index + 28 + count * 56 > bytes.length) throw new Error('Unexpected archive entries');
  const hash = path => {
    let value = 0xcbf29ce484222325n;
    for (const byte of Buffer.from(path.toLowerCase())) value = BigInt.asUintN(64, (value ^ BigInt(byte)) * 0x100000001b3n);
    return value.toString();
  };
  const expected = new Set(schema.graphs.map(name => hash(`cyberpunk_convai\\facial\\${name}.animgraph`)));
  for (let i = 0; i < count; i++) {
    const entry = bytes.readBigUInt64LE(index + 28 + i * 56).toString();
    if (!expected.delete(entry)) throw new Error('Archive contains an unapproved or duplicate resource path');
  }
  if (expected.size) throw new Error('Archive is missing a speech graph');
  console.log(`Verified ${count} archive entries, all under cyberpunk_convai\\facial. No base-game overrides.`);
  process.exit(0);
}

const inputDirectory = resolve(process.argv[2] || 'runtime/facial-rig/roundtrip');
const reports = [];
for (const name of schema.graphs) {
  const doc = JSON.parse(readFileSync(resolve(inputDirectory, `${name}.animgraph.json`), 'utf8').replace(/^\uFEFF/, ''));
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
  let current = solvers[0].inputLink.node;
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
  reports.push({graph: name, inputs: inputs.length, connectedControls: controls.length, ownershipNodes: ownership.length, roundtripVerified: true});
}
writeFileSync(resolve('runtime/facial-rig/verification.json'), JSON.stringify(reports, null, 2));
console.log(`Verified ${reports.length} native graph round-trips, ${schema.tracks.length} connected controls each.`);
