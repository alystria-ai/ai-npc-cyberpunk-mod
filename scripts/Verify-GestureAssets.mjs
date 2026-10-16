#!/usr/bin/env node
// Round-trip check: the binary resources WolvenKit wrote must still contain
// what the generator asked for (clip names, rig animsets, entity components).
import fs from 'node:fs';
import path from 'node:path';

function arg(name) { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : null; }
const roundtrip = arg('roundtrip');
const generated = arg('generated');
if (!roundtrip || !generated) { console.error('usage: Verify-GestureAssets.mjs --roundtrip <dir> --generated <dir>'); process.exit(2); }
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^﻿/, ''));
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

function walk(node, visit) {
    if (Array.isArray(node)) { node.forEach((item) => walk(item, visit)); return; }
    if (!node || typeof node !== 'object') return;
    visit(node);
    Object.values(node).forEach((value) => walk(value, visit));
}
function summarizeWorkspot(json) {
    const tree = json.Data.RootChunk.workspotTree.Data;
    const clips = [];
    walk(tree.rootEntry, (node) => { if (node.$type === 'workAnimClip') clips.push(`${node.id.id}:${node.animName.$value}`); });
    const sets = tree.finalAnimsets.map((set) => [set.rig.DepotPath.$value,
        set.animations.cinematics.map((entry) => entry.animSet.DepotPath.$value).join('|'),
        set.loadingHandles.map((entry) => entry.DepotPath.$value).join('|')].join('>'));
    return { clips: clips.sort(), sets, slot: tree.animGraphSlotName.$value, idCounter: tree.idCounter,
        blend: [tree.inertializationDurationEnter, tree.inertializationDurationExitNatural, tree.inertializationDurationExitForced]
            .map((value) => Math.round(Number(value) * 1000) / 1000) };
}
function summarizeEntity(json) {
    const root = json.Data.RootChunk;
    return {
        type: root.entity.Data.$type,
        components: root.components.map((c) => `${c.$type}:${c.name.$value}:${c.workspotResource.DepotPath.$value}:${c.id}`),
        compiled: root.compiledData.Data.Chunks.map((c) => c.$type),
    };
}
const files = fs.readdirSync(generated).filter((name) => name.endsWith('.json'));
const workspots = files.filter((name) => name.endsWith('.workspot.json'));
const entityFile = files.find((name) => name.endsWith('.ent.json'));
if (!entityFile || workspots.length === 0) { console.error('generated resources are missing'); process.exit(1); }
for (const [file, summarize] of [...workspots.map((name) => [name, summarizeWorkspot]), [entityFile, summarizeEntity]]) {
    const before = summarize(read(generated, file));
    const after = summarize(read(roundtrip, file));
    check(JSON.stringify(before) === JSON.stringify(after), `${file} changed in round trip:\n  wanted ${JSON.stringify(before)}\n  got    ${JSON.stringify(after)}`);
}
const entity = summarizeEntity(read(roundtrip, entityFile));
check(entity.type === 'gameObject', 'device root entity must be a gameObject');
check(entity.components.every((c) => c.startsWith('workWorkspotResourceComponent:')), 'device must contain workspot components only');
check(entity.compiled[0] === 'gameObject' && entity.compiled.length === entity.components.length + 1, 'compiled data does not match components');
// Every workspot the mod ships plays the plain neutral facial idle, no key pose
// (a different one kept the lips sealed under the speech layer).
for (const name of workspots) {
    const hubs = [];
    walk(read(roundtrip, name).Data.RootChunk.nodesToInit, (node) => { if (node.$type === 'animAnimNode_WorkspotHub') hubs.push(node); });
    check(hubs.length > 0, `${name} has no workspot hub`);
    for (const hub of hubs) {
        check(hub.facialIdleMaleAnimation?.$value === 'idle__neutral__male' && hub.facialIdleFemaleAnimation?.$value === 'idle__neutral__female'
            && hub.facialIdleKey_MaleAnimation?.$value === 'None' && hub.facialIdleKey_FemaleAnimation?.$value === 'None',
            `${name} must use the neutral facial idle with no key pose`);
    }
}
// No stance or idle workspot keeps the template's walk-to-stand entry clips: the engine plays
// one on every enter, it lands straight in the stance and lurches the body 15-19 px
// (docs/COMPANION_GESTURES.md, Round 5d). Seat workspots keep their own entries.
for (const name of workspots.filter((file) => !file.startsWith('convai_seat_'))) {
    let entries = 0;
    walk(read(roundtrip, name).Data.RootChunk.workspotTree, (node) => { if (node.$type === 'workEntryAnim') entries++; });
    check(entries === 0, `${name} keeps ${entries} workEntryAnim clip(s); the enter must start on its first sequence`);
}
// Idle workspot copies carry the pose blends gestures.json declares (idleBlend, Round 16; vanilla is 0.5 / 0.5 / 0.2 s), and
// the round trip through the binary keeps them.
const wantedBlend = JSON.parse(fs.readFileSync(new URL('../assets/gestures/gestures.json', import.meta.url), 'utf8').replace(/^﻿/, '')).idleBlend;
const round3 = (value) => Math.round(Number(value) * 1000) / 1000;
for (const name of workspots.filter((file) => file.startsWith('convai_idle_'))) {
    const tree = read(roundtrip, name).Data.RootChunk.workspotTree.Data;
    check(round3(tree.inertializationDurationEnter) === round3(wantedBlend.enter)
        && round3(tree.inertializationDurationExitNatural) === round3(wantedBlend.exitNatural)
        && round3(tree.inertializationDurationExitForced) === round3(wantedBlend.exitForced), `${name} must carry the idle pose blends of gestures.json`);
}
// Sit workspots must never end by themselves (a vanilla one runs 4-9 fidgets
// and leaves after 60-105 s): every random list needs a clip count that is
// never reached and its sequence must repeat; the entity must play only these.
const seatFiles = workspots.filter((name) => name.startsWith('convai_seat_'));
check(seatFiles.length >= 1, 'no endless sit workspots in the archive');
for (const name of seatFiles) {
    let lists = 0;
    (function visit(node, parent) {
        if (Array.isArray(node)) { node.forEach((item) => visit(item, parent)); return; }
        if (!node || typeof node !== 'object') return;
        if (node.$type === 'workRandomList') {
            lists++;
            check(Number(node.minClips) >= 100 && Number(node.maxClips) >= 100, `${name}: random list ends after ${node.minClips}-${node.maxClips} clips`);
            check(parent && Number(parent.loopInfinitely) === 1, `${name}: the sequence holding a random list must repeat`);
        }
        const next = typeof node.$type === 'string' && node.$type.startsWith('work') ? node : parent;
        Object.values(node).forEach((value) => visit(value, next));
    })(read(roundtrip, name).Data.RootChunk.workspotTree, null);
    check(lists >= 1, `${name} has no random list`);
}
const sitComponents = entity.components.filter((c) => c.split(':')[1].startsWith('convai_sit_'));
check(sitComponents.length >= 1 && sitComponents.every((c) => c.includes('convai_seat_')), `sit components must play the endless copies: ${sitComponents.join(', ')}`);
let clipTotal = 0;
for (const name of workspots) {
    const workspot = summarizeWorkspot(read(roundtrip, name));
    check(workspot.slot === 'WORKSPOT', `${name} must target the WORKSPOT graph slot`);
    // A vanilla idle copy can be a bare idle loop (q000 jackie hips) with no clip nodes of its own.
    let sequences = 0;
    walk(read(roundtrip, name).Data.RootChunk.workspotTree, (node) => { if (node.$type === 'workSequence') sequences++; });
    check(name.startsWith('convai_idle_') ? sequences >= 1 : workspot.clips.length >= 2, `${name} has no clips`);
    clipTotal += workspot.clips.length;
}
check(entity.components.length >= workspots.length, 'every workspot needs a device component');
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`gesture verify: ${workspots.length} workspots, ${clipTotal} clips, ${entity.components.length} components`);
