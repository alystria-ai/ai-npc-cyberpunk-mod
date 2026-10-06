#!/usr/bin/env node
// Generates the companion gesture resources from serialized vanilla data:
//   - a multi-rig .workspot cloned from a vanilla standing workspot, holding one
//     looping idle sequence plus one sequence per gesture clip;
//   - a spawnable gameObject .ent whose workspot components point at that
//     workspot and at vanilla character idle workspots;
//   - mod/gesture-catalog.lua, the per-rig clip availability the Lua side uses.
// Every animset/rig/workspot path is checked against the archive listing and
// every clip against the extracted animsets of each rig. Nothing is guessed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : fallback;
}
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputs = arg('inputs');
const out = arg('out');
const listingFile = arg('listing');
const catalogOut = arg('catalog', path.join(project, 'mod', 'gesture-catalog.lua'));
const sourceFile = arg('source', path.join(project, 'assets', 'gestures', 'gestures.json'));
if (!inputs || !out || !listingFile) {
    console.error('usage: Build-GestureAssets.mjs --inputs <json dir> --out <json out dir> --listing <paths.txt> [--catalog <lua>]');
    process.exit(2);
}
const fail = (message) => { console.error(`gesture build: ${message}`); process.exit(1); };
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const clone = (value) => JSON.parse(JSON.stringify(value));
const base = (depot) => depot.split('\\').pop();
const source = readJson(sourceFile);
if (source.version !== 1) fail('unsupported gestures.json version');

const listing = new Set(fs.readFileSync(listingFile, 'utf8').split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean));
const requirePath = (depot, what) => { if (!listing.has(depot.toLowerCase())) fail(`${what} is not in the game archives: ${depot}`); };
const jsonFor = (depot) => {
    const file = path.join(inputs, `${base(depot)}.json`);
    return fs.existsSync(file) ? readJson(file) : null;
};

// Resource helpers in WolvenKit 9 JSON shape.
const cname = (value) => ({ $type: 'CName', $storage: 'string', $value: value });
const resource = (depot, flags = 'Default') => ({ DepotPath: { $type: 'ResourcePath', $storage: 'string', $value: depot }, Flags: flags });
const entryId = (id) => ({ $type: 'workWorkEntryId', id });

// 1. Clip availability per rig, from the extracted animsets.
const rigClips = {};
for (const [rigKey, rig] of Object.entries(source.rigs)) {
    requirePath(rig.rig, `${rigKey} rig`);
    requirePath(rig.bumps, `${rigKey} bump animset`);
    rigClips[rigKey] = new Map();
    for (const animset of rig.animsets) {
        requirePath(animset, `${rigKey} animset`);
        if (/_transitions\.anims$/.test(animset)) continue; // entry/exit only; not a clip source
        const data = jsonFor(animset);
        if (!data) fail(`animset was not extracted: ${animset}`);
        const root = data.Data.RootChunk;
        const declared = root.rig?.DepotPath?.$value;
        if (declared && declared.toLowerCase() !== rig.rig.toLowerCase()) fail(`${animset} targets ${declared}, not ${rig.rig}`);
        for (const entry of root.animations) {
            const animation = entry?.Data?.animation?.Data;
            const name = animation?.name?.$value;
            if (!name || rigClips[rigKey].has(name)) continue; // first animset wins, as in the setup order
            rigClips[rigKey].set(name, {
                duration: Number(animation.duration ?? animation.animBuffer?.Data?.duration ?? 0),
                motion: animation.motionExtraction != null,
                animset,
            });
        }
    }
    if (!rigClips[rigKey].has(source.idle)) fail(`${rigKey} has no idle clip ${source.idle}`);
}
const rigNames = Object.keys(source.rigs);
const clips = [];
const warnings = [];
let nextId = 100;
const idleId = nextId; nextId += 2; // sequence id, clip id
for (const clip of source.clips) {
    const required = clip.rigs ?? rigNames;
    const perRig = {};
    for (const rigKey of rigNames) {
        const found = rigClips[rigKey].get(clip.name);
        if (!found && required.includes(rigKey)) fail(`${clip.name} is missing on ${rigKey}`);
        if (found) {
            perRig[rigKey] = { duration: Math.round(found.duration * 1000) / 1000, motion: found.motion };
            if (found.motion) warnings.push(`${clip.name} on ${rigKey} carries motion extraction`);
        }
    }
    clips.push({ ...clip, sequenceId: nextId, clipId: nextId + 1, perRig });
    nextId += 2;
}
for (const [key, depot] of Object.entries(source.idleWorkspots)) requirePath(depot, `${key} idle workspot`);
requirePath(source.template, 'template workspot');

// 2. Workspot: vanilla template, our animsets and tree.
const template = jsonFor(source.template);
if (!template) fail('template workspot was not extracted');
const workspot = clone(template);
workspot.Header.ArchiveFileName = source.workspot;
const tree = workspot.Data.RootChunk.workspotTree.Data;
const templateSets = tree.finalAnimsets;
tree.finalAnimsets = rigNames.map((rigKey) => {
    const rig = source.rigs[rigKey];
    const shape = clone(templateSets.find((set) => set.rig.DepotPath.$value.toLowerCase() === rig.rig.toLowerCase()) ?? templateSets[0]);
    shape.rig = resource(rig.rig, 'Soft');
    shape.loadingHandles = [rig.bumps, ...rig.animsets].map((depot) => resource(depot));
    shape.animations.gameplay = [{ $type: 'animAnimSetupEntry', animSet: resource(rig.bumps), priority: 128, variableNames: [] }];
    shape.animations.cinematics = rig.animsets.map((depot) => ({ $type: 'animAnimSetupEntry', animSet: resource(depot), priority: 200, variableNames: [] }));
    shape.animations.hash = '0';
    return shape;
});
tree.blacklistVisualTags = { $type: 'redTagList', tags: [] };

const rootData = tree.rootEntry.Data;
const kept = rootData.list.filter((node) => ['workReactionSequence', 'workEntryAnim', 'workExitAnim', 'workFastExit'].includes(node.Data.$type));
// Vanilla crowd Fear reactions must not play on a companion; keep bumps only.
const reactions = kept.filter((node) => node.Data.$type !== 'workReactionSequence' || JSON.stringify(node).includes('bump'));
const templateClip = rootData.list.find((node) => node.Data.$type === 'workSequence').Data.list[0].Data.list[0].Data;
const animClip = (name, id) => ({ HandleId: '0', Data: { ...clone(templateClip), animName: cname(name), blendOutTime: 0.5, id: entryId(id) } });
const sequence = (id, list, loop) => ({ HandleId: '0', Data: {
    $type: 'workSequence', category: 'Any', disableAutoTransition: 0, flags: 0, id: entryId(id),
    idleAnim: cname(source.idle), list, loopInfinitely: loop ? 1 : 0, previousLoopInfinitely: 0 } });
rootData.list = [
    ...reactions.filter((node) => node.Data.$type === 'workReactionSequence'),
    ...kept.filter((node) => node.Data.$type === 'workEntryAnim'),
    sequence(idleId, [animClip(source.idle, idleId + 1)], true),
    ...clips.map((clip) => sequence(clip.sequenceId, [animClip(clip.name, clip.clipId)], false)),
    ...kept.filter((node) => node.Data.$type === 'workExitAnim' || node.Data.$type === 'workFastExit'),
];
tree.idCounter = nextId;

// Handles: keep ids outside the tree, renumber everything inside it.
function collectHandles(node, into) {
    if (Array.isArray(node)) { node.forEach((item) => collectHandles(item, into)); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.HandleId === 'string') into.push(node);
    Object.values(node).forEach((value) => collectHandles(value, into));
}
const treeHandles = [];
collectHandles(workspot.Data.RootChunk.workspotTree, treeHandles);
const outside = [];
collectHandles({ ...workspot.Data.RootChunk, workspotTree: null }, outside);
let handle = Math.max(-1, ...outside.map((node) => Number(node.HandleId))) + 1;
for (const node of treeHandles) node.HandleId = String(handle++);
if (JSON.stringify(workspot.Data.RootChunk.workspotTree).includes('HandleRefId')) fail('template tree has handle references; renumbering is unsafe');

// 3. Entity: a gameObject with only workspot components (no collider/visuals).
const dummy = jsonFor('base\\quest\\side_quests\\sq029\\entities\\sq029_ent_interaction_dummy.ent');
const trunk = jsonFor('base\\vehicles\\common\\gameplay\\trunk_body_disposal\\vehicle_trunk_disposal_workspots.ent');
if (!dummy || !trunk) fail('entity templates were not extracted');
const entity = clone(dummy);
entity.Header.ArchiveFileName = source.device;
const componentShape = trunk.Data.RootChunk.components[0];
const zeroPosition = { $type: 'WorldPosition', x: { $type: 'FixedPoint', Bits: 0 }, y: { $type: 'FixedPoint', Bits: 0 }, z: { $type: 'FixedPoint', Bits: 0 } };
function cruid(name) {
    // Deterministic 64-bit component id (FNV-1a), high bit clear like vanilla ids.
    let hash = 0xcbf29ce484222325n;
    for (const byte of Buffer.from(`cyberpunk_convai:${name}`)) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
    return (hash & 0x7fffffffffffffffn).toString();
}
const componentList = [[source.gestureComponent, source.workspot],
    ...Object.entries(source.idleWorkspots).map(([key, depot]) => [`convai_idle_${key}`, depot])];
const components = componentList.map(([name, depot]) => {
    const component = clone(componentShape);
    component.id = cruid(name);
    component.name = cname(name);
    component.localTransform.Position = clone(zeroPosition);
    component.localTransform.Orientation = { $type: 'Quaternion', i: 0, j: 0, k: 0, r: 1 };
    component.workspotResource = resource(depot);
    return component;
});
const rootEntity = entity.Data.RootChunk;
rootEntity.components = components;
rootEntity.compiledData.Data.Chunks = [clone(rootEntity.entity.Data), ...clone(components)];
rootEntity.compiledData.Data.CruidDict = Object.fromEntries([['0', '0'], ...components.map((component, index) => [String(index + 1), component.id])]);
rootEntity.resolvedDependencies = [];

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, `${base(source.workspot)}.json`), JSON.stringify(workspot, null, 2));
fs.writeFileSync(path.join(out, `${base(source.device)}.json`), JSON.stringify(entity, null, 2));

// 4. Lua catalog (generated; committed like FaceFeature.reds).
const lua = (value, indent = '') => {
    if (value === null || value === undefined) return 'nil';
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'string') return JSON.stringify(value);
    const next = `${indent}    `;
    if (Array.isArray(value)) return `{\n${value.map((item) => `${next}${lua(item, next)},`).join('\n')}\n${indent}}`;
    return `{\n${Object.entries(value).filter(([, item]) => item !== null && item !== undefined).map(([key, item]) => `${next}${/^[A-Za-z_]\w*$/.test(key) ? key : `[${JSON.stringify(key)}]`} = ${lua(item, next)},`).join('\n')}\n${indent}}`;
};
const catalog = {
    version: 1,
    device: source.device,
    workspot: source.workspot,
    component: source.gestureComponent,
    idle: { name: source.idle, sequenceId: idleId, clipId: idleId + 1,
        perRig: Object.fromEntries(rigNames.map((rigKey) => [rigKey, { duration: Math.round(rigClips[rigKey].get(source.idle).duration * 1000) / 1000 }])) },
    idleComponents: Object.fromEntries(Object.keys(source.idleWorkspots).map((key) => [key, `convai_idle_${key}`])),
    rigs: rigNames,
    clips: clips.map(({ name, category, character, sequenceId, clipId, perRig }) => ({ name, category, character, sequenceId, clipId, perRig })),
};
fs.writeFileSync(catalogOut, `-- Generated by scripts/Build-GestureAssets.mjs from assets/gestures/gestures.json\n-- and the game's extracted animsets. Do not edit by hand.\nreturn ${lua(catalog)}\n`);
for (const warning of warnings) console.log(`warning: ${warning}`);
console.log(`gesture build: ${clips.length} clips, ${components.length} workspot components, ${rigNames.length} rigs`);
