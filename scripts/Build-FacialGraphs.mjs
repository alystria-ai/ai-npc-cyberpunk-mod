// Build separate facial graphs from the user's installed game resources.
// Original game resources and generated archives stay outside source control.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve, basename, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

export const schema = JSON.parse(readFileSync(new URL('../assets/facial/controls.json', import.meta.url), 'utf8'));
const cname = value => ({$type: 'CName', $storage: 'string', $value: value});
const trackIndex = name => ({$type: 'animNamedTrackIndex', name: cname(name)});
const link = (type, node) => ({$type: type, node});
const ref = id => ({HandleRefId: String(id)});

export function inspectGraph(document) {
  const handles = new Map(), refs = [], objects = [];
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (value.HandleId !== undefined) {
      if (handles.has(value.HandleId)) throw new Error(`Duplicate handle ${value.HandleId}`);
      handles.set(value.HandleId, value);
    }
    if (value.HandleRefId !== undefined) refs.push(value.HandleRefId);
    if (value.$type) objects.push(value);
    for (const child of Object.values(value)) walk(child);
  }
  walk(document);
  for (const id of refs) if (!handles.has(id) && id !== '-1') throw new Error(`Unresolved graph handle ${id}`);
  return {handles, objects};
}

// The vanilla "a > 0" expression (compiled by the game; all four crowd graphs carry identical token data), and the
// pieces of a vanilla animAnimNode_Switch / animAnimNode_MathExpressionFloat. The gate below copies how the game
// itself builds a two-input switch: a MathExpressionFloat node feeding Switch.weightNode, and a second input that
// reaches the same upstream node as the first (Switch nodes 25, 27 and 427 of woman_average_sermo do exactly that).
export const GATE_EXPRESSION = {returnVarType: 1, tokenData: [2164293632, 16777216, 2701131908], valuesData: [0]};
const none = () => ({$type: 'CName', $storage: 'string', $value: 'None'});
const noColor = () => ({$type: 'Color', Alpha: 0, Blue: 0, Green: 0, Red: 0});
const vis = () => ({visAxes: 0, visMask: null, visNames: 0, visPostPose: 0, visPostPoseColor: noColor(), visPrePose: 0,
  visPrePoseColor: noColor(), visRigPartMask: none(), visWhenActive: 0});

// options.gate: true builds the crowd variant. The speech layer then sits behind one Switch that a face which is not
// being voiced never selects: input 0 is the solver's original input, untouched (the vanilla pose), input 1 is the
// same node with the speech layer on top, and the weight is "speech_owner > 0". A face that is not speaking
// evaluates one switch and one comparison more than vanilla.
export function extendFacialGraph(original, options = {}) {
  const gate = options.gate ? schema.crowd?.gate : null;
  if (options.gate && (!gate || !schema.owner || gate.input !== schema.owner.input
      || !Number.isFinite(gate.blendTime) || gate.blendTime < 0 || typeof gate.label !== 'string')) {
    throw new Error('Invalid speech gate schema');
  }
  if (schema.crowd && (!/^[a-z]+$/.test(schema.crowd.folder) || new Set(schema.crowd.graphs).size !== schema.crowd.graphs.length
      || schema.crowd.graphs.some(name => !schema.graphs.includes(name)))) throw new Error('Invalid crowd graph schema');
  if (schema.version !== 1 || new Set(schema.tracks).size !== schema.tracks.length
      || schema.tracks.some(name => !/^[a-z][a-zA-Z0-9_]+$/.test(name))) throw new Error('Invalid face schema');
  if (schema.owner && (!/^[a-z][a-zA-Z0-9_]+$/.test(schema.owner.input) || schema.tracks.includes(schema.owner.input)
      || !/^[a-zA-Z][a-zA-Z0-9]+$/.test(schema.owner.envelope) || new Set(schema.owner.faded).size !== schema.owner.faded.length
      || schema.owner.faded.some(name => !/^[a-z][a-zA-Z0-9_]+$/.test(name) || /^(eye|neck)_/.test(name)))) {
    throw new Error('Invalid speech ownership schema');
  }
  const document = structuredClone(original), root = document.Data?.RootChunk;
  if (root?.$type !== 'animAnimGraph') throw new Error('Expected an animation graph');
  const {handles, objects} = inspectGraph(document);
  const solvers = objects.filter(node => node.$type === 'animAnimNode_Sermo');
  if (solvers.length !== 1 || !solvers[0].inputLink?.node) throw new Error('Expected exactly one connected native facial solver');
  if (root.animFeatures.some(feature => feature.name?.$value === schema.group)) throw new Error('Graph already contains the speech layer');
  let nextId = Math.max(...[...handles.keys()].map(Number)) + 1;
  const alloc = data => ({HandleId: String(nextId++), Data: data});
  const base = type => ({$type: type, id: 4294967295, debugName: cname('Convai speech')});
  // The solver's original input. With the gate it is defined once, inline, as the Switch's input 0, and the speech
  // chain reaches it by reference (a handle reference resolves only after the definition, in document order).
  const originalInput = solvers[0].inputLink;
  const originalNode = originalInput.node;
  let upstream = gate ? link('animPoseLink', ref(originalNode.HandleId ?? originalNode.HandleRefId)) : originalInput;
  const added = [];
  for (const track of schema.tracks) {
    const input = alloc({...base('animAnimNode_FloatInput'), group: cname(schema.group),
      name: cname(track), debugInput: 0});
    const modifier = alloc({...base('animAnimNode_FloatTrackModifier'),
      floatInputNode: link('animFloatLink', input),
      floatTrack: trackIndex(`${track}LipsyncPoseOutput`), inputFloatTrack: trackIndex('None'),
      operationType: 'Add', poseInputNode: upstream});
    upstream = link('animPoseLink', modifier);
    added.push(ref(modifier.HandleId), ref(input.HandleId));
  }
  // Speech ownership (October 10). The deltas above are ADDED to whatever the graph already feeds the solver, and
  // the graph always feeds it a facial idle: the Idle state machine plays a looped idle__<emotion>__<sex> clip (and a
  // workspot, scene or look-at streams its own) whose lips_together / jaw_mid_close / lips_suck keys hold the mouth
  // shut at times, so a written jaw of .1 to .65 sometimes cannot open it. The game's own dialogue lipsync does not
  // add: it also writes <control>AnimOverrideWeight and the lipSyncEnvelope track, and the solver then scales the
  // streamed value of each override-capable control by lerp(1, override, envelope) before adding the lipsync pose
  // (the reconstruction in vendor/reference-cp77-blender .../facial/solver.py). One float input, speech_owner, drives
  // both: envelope += owner and override -= owner, so the idle's mouth is faded by 1 - owner^2 and fully gone at 1,
  // and the graph is unchanged at 0 (envelope 0 skips the stage). Eyes, brows and blinks have no override track.
  const owner = schema.owner;
  if (owner) {
    const test = [...objects].find(node => node.$type === 'animSermoTestController');
    if (!test) throw new Error('Sermo has no track list to check the override tracks against');
    for (const track of [owner.envelope, ...owner.faded.map(name => `${name}AnimOverrideWeight`)]) {
      if (test[track] === undefined) throw new Error(`The solver has no ${track} track`);
    }
    const input = alloc({...base('animAnimNode_FloatInput'), group: cname(schema.group),
      name: cname(owner.input), debugInput: 0});
    // The native JSON reader resolves a handle reference only after the handle's definition, in document order, and
    // the outermost node of a chain comes first: the input is defined inline in the LAST node created and every
    // earlier (deeper) one refers to it.
    const ownerNodes = [];
    const ownerNode = (target, operationType) => {
      const modifier = alloc({...base('animAnimNode_FloatTrackModifier'), debugName: cname('Convai speech owner'),
        floatInputNode: link('animFloatLink', {HandleRefId: input.HandleId}),
        floatTrack: trackIndex(target), inputFloatTrack: trackIndex('None'),
        operationType, poseInputNode: upstream});
      upstream = link('animPoseLink', modifier);
      ownerNodes.push(modifier);
      added.push(ref(modifier.HandleId));
    };
    ownerNode(owner.envelope, 'Add');
    for (const name of owner.faded) ownerNode(`${name}AnimOverrideWeight`, 'Subtract');
    ownerNodes.at(-1).Data.floatInputNode = link('animFloatLink', input);
    added.push(ref(input.HandleId));
    if (gate) {
      // The weight node comes after the inputs in document order, so it refers to the owner input by handle.
      const expression = alloc({$type: 'mathExprExpression', ...structuredClone(GATE_EXPRESSION)});
      const compare = alloc({$type: 'animAnimNode_MathExpressionFloat', debugName: cname(gate.label),
        expressionData: {$type: 'animMathExpressionNodeData', expression,
          floatSockets: [{$type: 'animAnimMathExpressionFloatSocket', expressionVarId: 0, inputFloatTrack: trackIndex('None'),
            link: link('animFloatLink', ref(input.HandleId))}],
          quaternionSockets: [], vectorSockets: []},
        expressionString: 'a > 0', id: 4294967295, poseInfoLogger: null, ...vis()});
      const select = alloc({$type: 'animAnimNode_Switch', blendTime: gate.blendTime, canRequestInertialization: 0,
        debugName: cname(gate.label), id: 4294967295,
        inputNodes: [originalInput, upstream],
        motionProvider: null, numInputs: 2, poseInfoLogger: null, pushDataByTag: none(), syncMethod: null,
        timeWarpingEnabled: 0, ...vis(), weightNode: link('animFloatLink', compare)});
      upstream = link('animPoseLink', select);
      added.push(ref(select.HandleId), ref(compare.HandleId));
    }
  }
  // Speech deltas and ownership go in before the native Sermo solver. Zero inputs leave every existing pose, eye
  // target, head rotation and animation link intact.
  solvers[0].inputLink = upstream;
  root.nodesToInit.push(...added);
  root.animFeatures.push({$type: 'animAnimFeatureEntry', className: cname(schema.feature),
    name: cname(schema.group), debugEnabled: 0, forceAllocate: 1});
  inspectGraph(document);
  return document;
}

// Records of the named roster: every character the mod gives a profile or a phone contact, and the managed copies. The
// crowd preparation (Face.reds) never touches them: Johnny's record uses man_average_sermo, and a named character met
// in the world is a story character. A record may carry one clone prefix: Night City Allies spawns its followers from
// NCA.Character.<name> (docs/NCA_FOLLOWERS_PLAN.md). Sorted, so the generated source is stable.
export function namedRecords() {
  const read = name => JSON.parse(readFileSync(new URL(`../characters/${name}`, import.meta.url), 'utf8').replace(/^﻿/, ''));
  const records = new Set();
  for (const row of read('roster.json')) for (const record of row.records || []) records.add(record);
  for (const row of read('manager-characters.json')) if (row.record) records.add(row.record);
  for (const row of read('phone-contacts.json')) if (row.record) records.add(row.record);
  for (const record of records) if (!/^(?:[A-Za-z][A-Za-z0-9_]*\.)?Character\.[A-Za-z0-9_]+$/.test(record)) throw new Error(`Unexpected record name ${record}`);
  return [...records].sort();
}

export function crowdPath(name) {
  return `cyberpunk_convai\\facial\\${schema.crowd.folder}\\${name}.animgraph`;
}

export function featureSource() {
  return '// Generated from assets/facial/controls.json by Build-FacialGraphs.mjs.\n'
    + '// Zero values preserve the native face; this feature is applied only to owned copies.\n'
    + `public class ${schema.feature} extends AnimFeature {\n`
    + schema.tracks.map(track => `  public let ${track}: Float;`).join('\n') + '\n'
    + (schema.owner ? `  public let ${schema.owner.input}: Float;\n` : '') + '}\n\n'
    + 'public abstract class ConvaiFaceAssets {\n'
    + '  public static func Names() -> array<String> {\n    return ['
    + schema.graphs.map(name => `"${name}"`).join(', ') + '];\n  }\n'
    + '  public static func RequiredTracks() -> array<CName> {\n    return ['
    + schema.tracks.map(track => `n"${track}LipsyncPoseOutput"`).join(', ') + '];\n  }\n'
    // The crowd graphs (ordinary NPCs): gated copies of the first four graphs, assigned at spawn by Face.reds.
    + '  public static func CrowdNames() -> array<String> {\n    return ['
    + schema.crowd.graphs.map(name => `"${name}"`).join(', ') + '];\n  }\n'
    + '  public static func CrowdFolder() -> String {\n    return "'
    + `cyberpunk_convai\\\\facial\\\\${schema.crowd.folder}\\\\` + '";\n  }\n'
    + '  public static func NamedRecords() -> array<String> {\n    return ['
    + namedRecords().map(record => `"${record}"`).join(', ') + '];\n  }\n}\n';
}

export function build(inputDirectory, outputDirectory) {
  const generated = [];
  for (const name of schema.graphs) {
    const path = resolve(inputDirectory, `${name}.animgraph.json`);
    const source = readFileSync(path, 'utf8');
    const original = JSON.parse(source.replace(/^\uFEFF/, ''));
    const document = extendFacialGraph(original);
    const depotPath = `cyberpunk_convai\\facial\\${name}.animgraph`;
    // WolvenKit deserialization uses this header only as metadata. Output
    // resources are written under the explicit archive directory below.
    document.Header.ArchiveFileName = depotPath;
    const target = resolve(outputDirectory, `${name}.animgraph.json`);
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, JSON.stringify(document));
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    const originalPath = `base\\animations\\facial\\_facial_graphs\\${name}.animgraph`;
    generated.push({source: basename(path), sourceSha256, originalPath, depotPath,
      nodes: document.Data.RootChunk.nodesToInit.length, controls: schema.tracks.length});
    // The crowd copy of the same four graphs, behind the speech gate, in its own folder of the archive.
    if (schema.crowd?.graphs.includes(name)) {
      const gated = extendFacialGraph(original, {gate: true});
      const gatedPath = crowdPath(name);
      gated.Header.ArchiveFileName = gatedPath;
      const gatedTarget = resolve(outputDirectory, schema.crowd.folder, `${name}.animgraph.json`);
      mkdirSync(dirname(gatedTarget), {recursive: true});
      writeFileSync(gatedTarget, JSON.stringify(gated));
      generated.push({source: basename(path), sourceSha256, originalPath, depotPath: gatedPath, gated: true,
        nodes: gated.Data.RootChunk.nodesToInit.length, controls: schema.tracks.length});
    }
  }
  mkdirSync(outputDirectory, {recursive: true});
  writeFileSync(resolve(outputDirectory, 'build-manifest.json'), JSON.stringify({version: 1, graphs: generated}, null, 2));
  writeFileSync(new URL('../r6/scripts/CyberpunkConvai/FaceFeature.reds', import.meta.url), featureSource());
  return generated;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  // "--reds": rewrite only FaceFeature.reds (after a roster change; needs no game files).
  if (process.argv[2] === '--reds') {
    writeFileSync(new URL('../r6/scripts/CyberpunkConvai/FaceFeature.reds', import.meta.url), featureSource());
    console.log('Wrote r6/scripts/CyberpunkConvai/FaceFeature.reds');
    process.exit(0);
  }
  const input = process.argv[2] || resolve(project, 'runtime/facial-rig/json');
  const output = process.argv[3] || resolve(project, 'runtime/facial-rig/extended-json');
  console.log(JSON.stringify(build(input, output).map(({depotPath, controls, nodes}) => ({depotPath, controls, nodes})), null, 2));
}
