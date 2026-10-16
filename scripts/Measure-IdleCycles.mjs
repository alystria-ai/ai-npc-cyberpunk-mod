#!/usr/bin/env node
// Measures the natural cycle of every idle workspot the companion gesture system plays (docs/COMPANION_GESTURES.md,
// Round 15) and writes assets/gestures/idle-cycles.json, which Build-GestureAssets.mjs puts into the catalog.
//
// The cycle of an idle is the length of its loop clip: the idleAnim of the workspot's main sequence, taken from the
// animsets the workspot loads for each rig (the same data the game plays; nothing is guessed). The controller holds an
// idle for whole cycles and leaves at a cycle end. The same scan also records the break list of that sequence
// (clip count range, the pause between clips and the clip lengths) for the doc, but only the loop clip is used.
//
// Reads WolvenKit JSON (convert serialize) of the workspots and of the animsets they load; nothing is written to the
// game. Usage:
//   node scripts/Measure-IdleCycles.mjs --workspots <json dir>... --animsets <json dir>... [--source <gestures.json>] [--out <json>]
// The animset directories are searched recursively. A (rig, idle) pair whose loop clip is in none of them is
// left out and listed, so the controller keeps its random hold for it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = { '--workspots': [], '--animsets': [], '--source': [], '--out': [] };
let current = null;
for (const token of args) { if (token in flags) current = token; else if (current) flags[current].push(token); }
const sourceFile = flags['--source'][0] ?? path.join(project, 'assets', 'gestures', 'gestures.json');
const outFile = flags['--out'][0] ?? path.join(project, 'assets', 'gestures', 'idle-cycles.json');
if (flags['--workspots'].length === 0 || flags['--animsets'].length === 0) {
    console.error('usage: Measure-IdleCycles.mjs --workspots <json dir>... --animsets <json dir>... [--source <gestures.json>] [--out <json>]');
    process.exit(2);
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const value = (x) => (x && x.$value !== undefined ? x.$value : x);
const base = (depot) => depot.split('\\').pop();
const round = (x) => Math.round(x * 100) / 100;
const source = readJson(sourceFile);

const filesUnder = (dir, suffix, into = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) filesUnder(full, suffix, into); else if (entry.name.endsWith(suffix)) into.push(full);
    }
    return into;
};
const animsetFiles = new Map();
for (const dir of flags['--animsets']) for (const file of filesUnder(dir, '.anims.json')) animsetFiles.set(path.basename(file, '.json'), file);
const animsetCache = new Map();
const clipsOfAnimset = (depot) => {
    const name = base(depot);
    if (animsetCache.has(name)) return animsetCache.get(name);
    const file = animsetFiles.get(name);
    let clips = null;
    if (file) {
        clips = new Map();
        for (const entry of readJson(file).Data.RootChunk.animations ?? []) {
            const a = entry?.Data?.animation?.Data;
            const clipName = value(a?.name);
            if (clipName) clips.set(clipName, Number(a.duration ?? a.animBuffer?.Data?.duration ?? 0));
        }
    }
    animsetCache.set(name, clips);
    return clips;
};
const workspotFile = (depot) => {
    for (const dir of flags['--workspots']) { const file = path.join(dir, `${base(depot)}.json`); if (fs.existsSync(file)) return file; }
    return null;
};
const rigKeyOf = (depot) => {
    const found = Object.entries(source.rigs).find(([, row]) => row.rig.toLowerCase() === depot.toLowerCase());
    return found ? found[0] : null;
};
// The animsets (with their priority) a workspot loads for each rig.
function animsetsByRig(tree) {
    const rows = {};
    (function walk(node) {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        if (node.$type === 'workWorkspotAnimsetEntry') {
            const rigKey = rigKeyOf(node.rig?.DepotPath?.$value ?? '');
            if (rigKey) for (const row of [...(node.animations?.cinematics ?? []), ...(node.animations?.gameplay ?? [])]) {
                (rows[rigKey] ??= []).push({ depot: row.animSet.DepotPath.$value, priority: Number(row.priority ?? 0) });
            }
        }
        Object.values(node).forEach(walk);
    })(tree);
    return rows;
}
// The main sequence: the first sequence outside a reaction that has an idle loop clip and a break list; failing that,
// the first with an idle loop clip.
function mainSequence(tree) {
    const found = [];
    (function walk(entry, inReaction) {
        const x = entry?.Data ?? entry;
        if (!x || typeof x !== 'object') return;
        const reaction = inReaction || x.$type === 'workReactionSequence';
        const idle = value(x.idleAnim);
        if (!reaction && x.$type === 'workSequence' && idle && idle !== 'None') found.push(x);
        for (const child of x.list ?? []) walk(child, reaction);
    })(tree.Data.rootEntry, false);
    const hasList = (x) => (x.list ?? []).some((c) => (c.Data ?? c).$type === 'workRandomList');
    return found.find(hasList) ?? found[0] ?? null;
}
const clipNamesOf = (list) => (list.list ?? []).map((c) => c.Data ?? c).filter((c) => c.$type === 'workAnimClip').map((c) => value(c.animName));

const result = {};
const missing = [];
for (const [key, depot] of Object.entries(source.idleWorkspots)) {
    const file = workspotFile(depot);
    if (!file) { missing.push(`${key}: workspot not extracted`); continue; }
    const tree = readJson(file).Data.RootChunk.workspotTree;
    const sequence = mainSequence(tree);
    if (!sequence) { missing.push(`${key}: no sequence with a loop clip`); continue; }
    const idle = value(sequence.idleAnim);
    const rows = animsetsByRig(readJson(file).Data.RootChunk);
    const list = (sequence.list ?? []).map((c) => c.Data ?? c).find((c) => c.$type === 'workRandomList');
    const perRig = {};
    for (const rigKey of Object.keys(source.rigs)) {
        const sets = (rows[rigKey] ?? []).sort((a, b) => b.priority - a.priority);
        // The workspot names a loop clip the animset may carry under a gendered prefix (dirt__ -> dirtgirl__, dirtboy__).
        const names = [idle, idle.replace(/^dirt__/, rigKey === 'woman_base' ? 'dirtgirl__' : 'dirtboy__')];
        let seconds = null;
        for (const set of sets) {
            const clips = clipsOfAnimset(set.depot);
            const hit = clips && names.find((name) => clips.has(name));
            if (hit) { seconds = clips.get(hit); break; }
        }
        if (seconds && seconds > 0) perRig[rigKey] = round(seconds);
        else if (sets.length) missing.push(`${key} on ${rigKey}: loop clip ${idle} not found in ${sets.length} animset(s)`);
    }
    if (Object.keys(perRig).length === 0) continue;
    const breaks = list ? clipNamesOf(list) : [];
    result[key] = {
        loop: idle,
        cycle: perRig,
        ...(list ? { breaks: { clips: [Number(list.minClips), Number(list.maxClips)], pause: [Number(list.pauseBetweenLength ?? 0), Number(list.pauseLengthDeviation ?? 0)], count: breaks.length } } : {}),
    };
}
const output = {
    note: 'Measured by scripts/Measure-IdleCycles.mjs from the extracted workspots and the animsets they load (Round 15). cycle: seconds of the idle loop clip (the idleAnim of the workspot main sequence) per rig; the controller holds an idle for whole cycles. breaks: the random break list of that sequence (clips per run min-max, pause between clips = first +- second). An idle or rig that is missing here keeps the random hold.',
    idles: result,
};
fs.writeFileSync(outFile, `${JSON.stringify(output, null, 2)}\n`);
console.log(`idle cycles: ${Object.keys(result).length} idles written to ${outFile}`);
for (const line of missing) console.log(`idle cycles: missing: ${line}`);
