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

export function extendFacialGraph(original) {
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
  let upstream = solvers[0].inputLink;
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
    + schema.tracks.map(track => `n"${track}LipsyncPoseOutput"`).join(', ') + '];\n  }\n}\n';
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
    generated.push({source: basename(path), sourceSha256: createHash('sha256').update(source).digest('hex'),
      originalPath: `base\\animations\\facial\\_facial_graphs\\${name}.animgraph`, depotPath,
      nodes: document.Data.RootChunk.nodesToInit.length, controls: schema.tracks.length});
  }
  mkdirSync(outputDirectory, {recursive: true});
  writeFileSync(resolve(outputDirectory, 'build-manifest.json'), JSON.stringify({version: 1, graphs: generated}, null, 2));
  writeFileSync(new URL('../r6/scripts/CyberpunkConvai/FaceFeature.reds', import.meta.url), featureSource());
  return generated;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const input = process.argv[2] || resolve(project, 'runtime/facial-rig/json');
  const output = process.argv[3] || resolve(project, 'runtime/facial-rig/extended-json');
  console.log(JSON.stringify(build(input, output).map(({depotPath, controls, nodes}) => ({depotPath, controls, nodes})), null, 2));
}
