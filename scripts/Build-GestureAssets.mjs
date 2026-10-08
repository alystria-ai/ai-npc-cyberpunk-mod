#!/usr/bin/env node
// Generates the companion gesture resources from serialized vanilla data:
//   - one multi-rig .workspot per talk family (stance), cloned from a vanilla
//     standing workspot, holding a looping idle sequence plus one sequence per
//     gesture clip discovered in that family's animsets;
//   - a spawnable gameObject .ent whose workspot components point at those
//     workspots, at vanilla character idle workspots and at the vanilla NPC
//     sit workspots companions use beside a seated V (docs/COMPANION_SEATING.md);
//   - mod/gesture-catalog.lua, the per-family, per-rig clip catalog for Lua.
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
if (source.version !== 2) fail('unsupported gestures.json version');

const listing = new Set(fs.readFileSync(listingFile, 'utf8').split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean));
const requirePath = (depot, what) => { if (!listing.has(depot.toLowerCase())) fail(`${what} is not in the game archives: ${depot}`); };
const jsonFor = (depot) => {
    const file = path.join(inputs, `${base(depot)}.json`);
    return fs.existsSync(file) ? readJson(file) : null;
};
const cname = (value) => ({ $type: 'CName', $storage: 'string', $value: value });
const resource = (depot, flags = 'Default') => ({ DepotPath: { $type: 'ResourcePath', $storage: 'string', $value: depot }, Flags: flags });
const entryId = (id) => ({ $type: 'workWorkEntryId', id });
const round = (value) => Math.round(value * 1000) / 1000;
const banned = source.banned.map((word) => word.toLowerCase());
const categories = source.categories.map(([name, pattern]) => [name, new RegExp(pattern)]);
const characterOf = (name) => (name.match(/^(judy|johnny|jackie|kerry|takemura|panam)__/) || [])[1];
const transition = (depot) => /_transitions(__ow)?\.anims$/.test(depot);
// Measured hand motion per clip (scripts/Measure-GestureMotion.py), optional.
const motionFile = path.join(project, 'assets', 'gestures', 'clip-motion.json');
const motionData = fs.existsSync(motionFile) ? readJson(motionFile) : {};
const motion = motionData.animsets ?? {};
const idleFeet = motionData.idles ?? {};
// Same-named clips share choreography across rigs; an animset WolvenKit could
// not export (man_big hands at sides) borrows the median reach of its name.
const reachByName = new Map();
for (const clips of Object.values(motion)) {
    for (const [name, row] of Object.entries(clips)) {
        if (!reachByName.has(name)) reachByName.set(name, []);
        reachByName.get(name).push(row[0]);
    }
}
// Feet (hip space) at clip start/end; same-name fallback across sets.
const feetByName = new Map();
for (const clips of Object.values(motion)) {
    for (const [name, row] of Object.entries(clips)) if (row[2] && !feetByName.has(name)) feetByName.set(name, [row[2], row[3]]);
}
const feetOf = (animset, name) => {
    const row = motion[base(animset).replace(/\.anims$/, '')]?.[name];
    if (row && row[2]) return [row[2], row[3]];
    if (/_locomotion/.test(animset) && name === 'idle_stand') {
        const idle = idleFeet[base(animset).replace(/\.anims$/, '')];
        if (idle) return [idle, idle];
    }
    return feetByName.get(name);
};
const legDelta = (a, b) => Math.max(...a.map((value, index) => Math.abs(value - b[index])));
// Clip-vs-loop leg gap measured inside each set that has both names (same
// rig, same proportions); median across sets. Used when the clip's own set
// could not be measured (man_big hands at sides).
const legsByName = (clipName, loopName) => {
    const values = [];
    for (const clips of Object.values(motion)) {
        const clip = clips[clipName]; const loop = clips[loopName];
        if (clip?.[2] && loop?.[2]) values.push(Math.max(legDelta(clip[2], loop[2]), legDelta(clip[3], loop[2])));
    }
    if (!values.length) return undefined;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
};
// Where each clip puts the hands, torso and head (scripts/Measure-GestureShape.py),
// optional: classifies clips for conversation (centred, neutral, directional,
// sweep, turn). Same-name fallback across sets, like reach.
const shapeFile = path.join(project, 'assets', 'gestures', 'clip-shape.json');
const shapeData = fs.existsSync(shapeFile) ? readJson(shapeFile) : {};
const shapeFields = shapeData.fields ?? [];
const shapeSets = shapeData.animsets ?? {};
const shapeRow = (row) => Object.fromEntries(shapeFields.map((field, index) => [field, row[index]]));
const shapeByName = new Map();
for (const clips of Object.values(shapeSets)) {
    for (const [name, row] of Object.entries(clips)) if (!shapeByName.has(name)) shapeByName.set(name, shapeRow(row));
}
const shapeOf = (animset, name) => {
    const row = shapeSets[base(animset).replace(/\.anims$/, '')]?.[name];
    return row ? { ...shapeRow(row), measured: true } : shapeByName.get(name);
};
const fitRules = source.conversationFit ?? { names: [], shape: {} };
const nameRules = (fitRules.names ?? []).map(([pattern, fit, reason]) => [new RegExp(pattern), fit, reason]);
// Conversation fit of one clip from its name and every measured rig: the first
// matching name rule, else the strongest measured problem, else centred/neutral.
function fitOf(name, shapes) {
    const lower = name.toLowerCase();
    for (const [pattern, fit, reason] of nameRules) if (pattern.test(lower)) return { fit, reason };
    const t = fitRules.shape ?? {};
    const worst = (field) => Math.max(...shapes.map((shape) => Number(shape[field] ?? 0)));
    if (shapes.length) {
        const checks = [
            ['directional', worst('point') >= t.point, `points with the index finger for ${worst('point')} s`],
            ['directional', worst('side') >= t.side, `one hand goes ${worst('side')} cm out past its shoulder (indicates a side)`],
            ['directional', worst('cross') >= t.cross, `a hand reaches ${worst('cross')} cm past the other shoulder (indicates a side)`],
            ['directional', worst('back') >= t.back, `a raised hand goes ${worst('back')} cm behind the chest (over the shoulder)`],
            ['directional', worst('stretch') >= t.stretch, `one straight arm held out for ${worst('stretch')} s (reaching or indicating)`],
            ['turn', worst('yaw') >= t.yaw, `turns the torso ${worst('yaw')} degrees away`],
            ['turn', worst('head') >= t.head, `turns the head ${worst('head')} degrees away`],
            ['sweep', worst('high') > t.high, `hands go ${worst('high')} cm above the head`],
            ['sweep', worst('reach') > t.reach, `large arm sweep (${worst('reach')} cm)`],
        ];
        for (const [fit, hit, reason] of checks) if (hit) return { fit, reason };
        const centre = Math.min(...shapes.map((shape) => Number(shape.centre ?? 0)));
        return { fit: centre >= (t.centred ?? .75) ? 'centred' : 'neutral' };
    }
    return { fit: 'neutral' };
}
// Gesture kind: the move without stance, emotion or variant ("yes", "what").
const kindOf = (name) => { const rest = (name.match(/__\d\d__(.+)$/) || [, name])[1]; return rest.split('__')[0]; };
const reachOf = (animset, name) => {
    const row = motion[base(animset).replace(/\.anims$/, '')]?.[name];
    if (row) return row[0];
    const others = reachByName.get(name);
    if (!others) return undefined;
    const sorted = [...others].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

// Clips of an animset list for one rig (first animset wins on duplicate names).
const animsetCache = new Map();
function clipsOf(rigKey, animsets) {
    const rig = source.rigs[rigKey];
    const result = new Map();
    for (const animset of animsets) {
        requirePath(animset, `${rigKey} animset`);
        if (transition(animset)) continue;
        let entries = animsetCache.get(animset);
        if (!entries) {
            const data = jsonFor(animset);
            if (!data) fail(`animset was not extracted: ${animset}`);
            const root = data.Data.RootChunk;
            const declared = root.rig?.DepotPath?.$value;
            if (declared && declared.toLowerCase() !== rig.rig.toLowerCase()) fail(`${animset} targets ${declared}, not ${rig.rig}`);
            entries = root.animations.map((entry) => entry?.Data?.animation?.Data).filter((a) => a?.name?.$value).map((a) => ({
                name: a.name.$value, duration: Number(a.duration ?? a.animBuffer?.Data?.duration ?? 0), motion: a.motionExtraction != null,
                reach: reachOf(animset, a.name.$value), feet: feetOf(animset, a.name.$value), shape: shapeOf(animset, a.name.$value),
                measured: Boolean(motion[base(animset).replace(/\.anims$/, '')]?.[a.name.$value]?.[2]) }));
            animsetCache.set(animset, entries);
        }
        for (const entry of entries) if (!result.has(entry.name)) result.set(entry.name, entry);
    }
    return result;
}

const template = jsonFor(source.template);
if (!template) fail('template workspot was not extracted');
requirePath(source.template, 'template workspot');
for (const [key, depot] of Object.entries(source.idleWorkspots)) requirePath(depot, `${key} idle workspot`);
for (const [record, known] of Object.entries(source.characters)) {
    if (!known.idle) continue;
    if (!source.idleWorkspots[known.idle]) fail(`${record}: idle ${known.idle} has no workspot`);
    const checked = source.idleSources?.[known.idle];
    if (!checked || !checked[2].split(',').includes(known.rig)) fail(`${record}: idle ${known.idle} is not checked on ${known.rig}`);
}
const seatWorkspots = source.seatWorkspots ?? {};
for (const [key, depot] of Object.entries(seatWorkspots)) requirePath(depot, `${key} seat workspot`);

function collectHandles(node, into) {
    if (Array.isArray(node)) { node.forEach((item) => collectHandles(item, into)); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.HandleId === 'string') into.push(node);
    Object.values(node).forEach((value) => collectHandles(value, into));
}

const outputs = [];
const catalogFamilies = {};
const report = [];
for (const [familyKey, family] of Object.entries(source.families)) {
    const rigKeys = Object.keys(family.animsets);
    const perRigClips = {};
    for (const rigKey of rigKeys) {
        requirePath(source.rigs[rigKey].rig, `${rigKey} rig`);
        requirePath(source.rigs[rigKey].bumps, `${rigKey} bump animset`);
        perRigClips[rigKey] = clipsOf(rigKey, family.animsets[rigKey]);
        if (!perRigClips[rigKey].has(family.idle)) fail(`${familyKey}: ${rigKey} has no idle clip ${family.idle}`);
        if (perRigClips[rigKey].get(family.idle).motion) fail(`${familyKey}: idle ${family.idle} moves on ${rigKey}`);
    }
    // Discover clips: family prefix, in place, not banned, categorised.
    const byName = new Map();
    const skipped = { motion: 0, banned: 0, uncategorised: 0 };
    for (const rigKey of rigKeys) {
        for (const clip of perRigClips[rigKey].values()) {
            if (clip.name === family.idle || !family.prefixes.some((prefix) => clip.name.startsWith(prefix))) continue;
            const lower = clip.name.toLowerCase();
            if (banned.some((word) => lower.includes(word))) { skipped.banned++; continue; }
            if (clip.motion) { skipped.motion++; continue; }
            const category = (categories.find(([, pattern]) => pattern.test(lower)) || [])[0];
            if (!category) { skipped.uncategorised++; continue; }
            const item = byName.get(clip.name) ?? { name: clip.name, category, character: characterOf(clip.name), perRig: {} };
            // How far the clip's lower body starts/ends from the loop's (cm). A
            // large gap is blended at the hips and twists or crosses the legs.
            const loop = perRigClips[rigKey].get(family.idle);
            const loopFeet = loop?.feet?.[0];
            let legs = clip.measured && loop?.measured && loopFeet && clip.feet
                ? Math.max(legDelta(clip.feet[0], loopFeet), legDelta(clip.feet[1], loopFeet)) : undefined;
            if (legs === undefined) legs = legsByName(clip.name, family.idle);
            if (legs !== undefined) legs = Math.round(legs * 10) / 10;
            item.perRig[rigKey] = { duration: round(clip.duration), reach: clip.reach, legs, centre: clip.shape?.centre };
            if (clip.shape) (item.shapes ??= []).push(clip.shape);
            byName.set(clip.name, item);
        }
    }
    let nextId = 100;
    const idleId = nextId; nextId += 2;
    const clips = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).map((clip) => {
        const { shapes = [], ...rest } = clip;
        const { fit, reason } = fitOf(clip.name, shapes);
        const result = { ...rest, kind: kindOf(clip.name), fit, exclude: reason, sequenceId: nextId, clipId: nextId + 1 };
        nextId += 2;
        return result;
    });
    if (clips.length === 0) fail(`${familyKey}: no clips`);

    const workspot = clone(template);
    workspot.Header.ArchiveFileName = family.workspot;
    const tree = workspot.Data.RootChunk.workspotTree.Data;
    const templateSets = tree.finalAnimsets;
    tree.finalAnimsets = rigKeys.map((rigKey) => {
        const rig = source.rigs[rigKey];
        const shape = clone(templateSets.find((set) => set.rig.DepotPath.$value.toLowerCase() === rig.rig.toLowerCase()) ?? templateSets[0]);
        const animsets = family.animsets[rigKey];
        shape.rig = resource(rig.rig, 'Soft');
        shape.loadingHandles = [rig.bumps, ...animsets].map((depot) => resource(depot));
        shape.animations.gameplay = [{ $type: 'animAnimSetupEntry', animSet: resource(rig.bumps), priority: 128, variableNames: [] }];
        shape.animations.cinematics = animsets.map((depot) => ({ $type: 'animAnimSetupEntry', animSet: resource(depot), priority: 200, variableNames: [] }));
        shape.animations.hash = '0';
        return shape;
    });
    tree.blacklistVisualTags = { $type: 'redTagList', tags: [] };
    // Pose blends: a slow enter from the companion's own idle into the stance
    // and a slow natural exit back (live feedback: no visible pose pop).
    const blend = source.blend ?? {};
    tree.inertializationDurationEnter = blend.enter ?? tree.inertializationDurationEnter;
    tree.inertializationDurationExitNatural = blend.exitNatural ?? tree.inertializationDurationExitNatural;
    tree.inertializationDurationExitForced = blend.exitForced ?? tree.inertializationDurationExitForced;
    tree.autoTransitionBlendTime = blend.transition ?? tree.autoTransitionBlendTime;
    const rootData = tree.rootEntry.Data;
    const keep = (type) => rootData.list.filter((node) => node.Data.$type === type);
    const templateClip = keep('workSequence')[0].Data.list[0].Data.list[0].Data;
    const animClip = (name, id) => ({ HandleId: '0', Data: { ...clone(templateClip), animName: cname(name), blendOutTime: (source.blend ?? {}).clipOut ?? 0.5, id: entryId(id) } });
    const sequence = (id, list, loop) => ({ HandleId: '0', Data: {
        $type: 'workSequence', category: 'Any', disableAutoTransition: 0, flags: 0, id: entryId(id),
        idleAnim: cname(family.idle), list, loopInfinitely: loop ? 1 : 0, previousLoopInfinitely: 0 } });
    // Template walk entries, exits and bumps belong to the hands-at-sides pose;
    // other stances keep only the fast exit. Crowd Fear reactions never stay.
    const entries = family.templateEntries ? [
        ...keep('workReactionSequence').filter((node) => JSON.stringify(node).includes('bump')),
        ...keep('workEntryAnim')] : [];
    const exits = family.templateEntries ? keep('workExitAnim') : [];
    rootData.list = [
        ...entries,
        sequence(idleId, [animClip(family.idle, idleId + 1)], true),
        ...clips.map((clip) => sequence(clip.sequenceId, [animClip(clip.name, clip.clipId)], false)),
        ...exits, ...keep('workFastExit'),
    ];
    tree.idCounter = nextId;
    const treeHandles = [];
    collectHandles(workspot.Data.RootChunk.workspotTree, treeHandles);
    const outside = [];
    collectHandles({ ...workspot.Data.RootChunk, workspotTree: null }, outside);
    let handle = Math.max(-1, ...outside.map((node) => Number(node.HandleId))) + 1;
    for (const node of treeHandles) node.HandleId = String(handle++);
    if (JSON.stringify(workspot.Data.RootChunk.workspotTree).includes('HandleRefId')) fail('template tree has handle references; renumbering is unsafe');
    outputs.push([`${base(family.workspot)}.json`, workspot]);

    const counts = {};
    for (const clip of clips) counts[clip.category] = (counts[clip.category] || 0) + 1;
    report.push(`${familyKey}: ${clips.length} clips ${JSON.stringify(counts)} skipped ${JSON.stringify(skipped)}`);
    // Conversation fit per rig (talk categories only; idle breaks never play as talk).
    for (const rigKey of rigKeys) {
        const fits = {};
        for (const clip of clips) if (clip.perRig[rigKey] && clip.category !== 'idlebreak') fits[clip.fit] = (fits[clip.fit] || 0) + 1;
        report.push(`${familyKey}/${rigKey} fit ${JSON.stringify(fits)}`);
    }
    catalogFamilies[familyKey] = {
        component: family.component, workspot: family.workspot, rigs: rigKeys, blend: source.blend,
        idle: { name: family.idle, sequenceId: idleId, clipId: idleId + 1,
            perRig: Object.fromEntries(rigKeys.map((rigKey) => [rigKey, { duration: round(perRigClips[rigKey].get(family.idle).duration) }])) },
        clips: clips.map(({ name, category, character, kind, fit, exclude, sequenceId, clipId, perRig }) =>
            ({ name, category, character, kind, fit, exclude, sequenceId, clipId, perRig })),
    };
}

// Entity: a gameObject with only workspot components (no collider/visuals).
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
const componentList = [
    ...Object.values(source.families).map((family) => [family.component, family.workspot]),
    ...Object.entries(source.idleWorkspots).map(([key, depot]) => [`convai_idle_${key}`, depot]),
    ...Object.entries(seatWorkspots).map(([key, depot]) => [`convai_sit_${key}`, depot])];
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
outputs.push([`${base(source.device)}.json`, entity]);

fs.mkdirSync(out, { recursive: true });
for (const [name, value] of outputs) fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2));

// Lua catalog (generated; committed like FaceFeature.reds).
const lua = (value, indent = '') => {
    if (value === null || value === undefined) return 'nil';
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(round(value));
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'string') return JSON.stringify(value);
    const next = `${indent}    `;
    if (Array.isArray(value)) return `{\n${value.map((item) => `${next}${lua(item, next)},`).join('\n')}\n${indent}}`;
    return `{\n${Object.entries(value).filter(([, item]) => item !== null && item !== undefined).map(([key, item]) => `${next}${/^[A-Za-z_]\w*$/.test(key) ? key : `[${JSON.stringify(key)}]`} = ${lua(item, next)},`).join('\n')}\n${indent}}`;
};
const catalog = {
    version: 2,
    device: source.device,
    families: catalogFamilies,
    idleComponents: Object.fromEntries(Object.keys(source.idleWorkspots).map((key) => [key, `convai_idle_${key}`])),
    // Per idle: character (own clips), character workspot (shared clips) or generic, and the rigs it was checked on.
    idleSources: Object.fromEntries(Object.entries(source.idleSources ?? {}).map(([key, [kind, what, rigs]]) => [key, { kind, what, rigs: rigs.split(',') }])),
    experimentalIdles: source.experimentalIdles ?? [],
    seatComponents: Object.fromEntries(Object.keys(seatWorkspots).map((key) => [key, `convai_sit_${key}`])),
    characters: source.characters,
};
fs.writeFileSync(catalogOut, `-- Generated by scripts/Build-GestureAssets.mjs from assets/gestures/gestures.json\n-- and the game's extracted animsets. Do not edit by hand.\nreturn ${lua(catalog)}\n`);
for (const line of report) console.log(`gesture build: ${line}`);
console.log(`gesture build: ${Object.keys(catalogFamilies).length} families, ${components.length} workspot components`);
