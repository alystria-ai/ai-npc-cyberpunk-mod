#!/usr/bin/env node
// Audits vanilla idle workspots for the companion gesture system (docs/COMPANION_GESTURES.md, Round 11):
// every clip a workspot can play must exist in the animsets the workspot loads for the rig, none may carry
// motion extraction (walking), and every prop the workspot or its clips equip is listed with its item and slot,
// so the controller knows exactly what to take off the companion afterwards.
//
// Reads WolvenKit JSON (convert serialize) of the workspots and of the animsets they load; nothing is written
// to the game. Usage:
//   node scripts/Audit-PropIdles.mjs --workspots <json dir> [...] --animsets <json dir> [...] --rig man_base \
//        --names <workspot>[,<workspot>...]   (name without .workspot.json)
// Add --json for machine-readable output. Exit code 1 when a clip is missing or moves the body.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flags = { '--workspots': [], '--animsets': [], '--rig': [], '--names': [] };
let current = null, asJson = false;
for (const token of args) {
    if (token === '--json') { asJson = true; current = null; } else if (token in flags) current = token; else if (current) flags[current].push(token);
}
const workspotDirs = flags['--workspots'], animsetDirs = flags['--animsets'];
const rig = flags['--rig'][0] ?? 'man_base';
const names = flags['--names'].flatMap((a) => a.split(',')).filter(Boolean);
if (workspotDirs.length === 0 || animsetDirs.length === 0 || names.length === 0) {
    console.error('usage: Audit-PropIdles.mjs --workspots <dir>... --animsets <dir>... --rig <rig> --names <workspot>[,<workspot>]');
    process.exit(2);
}
const value = (x) => (x && x.$value !== undefined ? x.$value : x);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const find = (dirs, file) => { for (const dir of dirs) { const p = path.join(dir, file); if (fs.existsSync(p)) return p; } return null; };

// The clips a workspot can play, in tree order, with the loop clip of each sequence.
function collect(workspot) {
    const tree = workspot.Data.RootChunk.workspotTree.Data;
    const clips = new Set(), loops = new Set(), sequences = [];
    (function walk(entry) {
        const x = entry.Data ?? entry;
        if (x.$type === 'workAnimClip') { clips.add(value(x.animName)); return; }
        const idle = value(x.idleAnim);
        if (idle && idle !== 'None' && !String(idle).startsWith('<')) loops.add(idle);
        if (x.$type === 'workSequence') sequences.push(idle);
        for (const child of x.list ?? []) walk(child);
    })(tree.rootEntry);
    const actions = [];
    for (const action of tree.initialActions ?? []) {
        const data = action.Data ?? action;
        if (data.$type === 'workEquipItemToSlotAction') actions.push({ from: 'initialActions', item: value(data.item), slot: value(data.itemSlot) });
    }
    const sets = {};
    for (const set of tree.finalAnimsets ?? []) {
        const rigName = String(value(set.rig.DepotPath)).split('\\').pop().replace(/\.rig$/, '');
        sets[rigName] = [...(set.animations.cinematics ?? []), ...(set.animations.gameplay ?? [])].map((e) => String(value(e.animSet.DepotPath)));
    }
    return { clips, loops, actions, sets, items: tree.itemsPolicy };
}

function eventsOf(container) {
    const out = [];
    (function walk(node) {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        if (typeof node.$type === 'string' && node.$type.startsWith('animAnimEvent_')) {
            const kind = node.$type.replace('animAnimEvent_', '');
            if (kind === 'WorkspotItem') {
                for (const action of node.actions ?? []) {
                    const data = action.Data ?? action;
                    if (data.$type === 'workEquipItemToSlotAction') out.push({ kind, event: value(node.eventName), item: value(data.item), slot: value(data.itemSlot), frame: node.startFrame });
                    else out.push({ kind, event: value(node.eventName), action: data.$type, frame: node.startFrame });
                }
                if (!(node.actions ?? []).length) out.push({ kind, event: value(node.eventName), frame: node.startFrame });
            } else if (kind === 'ItemEffect' || kind === 'Effect') out.push({ kind, effect: value(node.effectName), event: value(node.eventName), frame: node.startFrame });
        }
        Object.values(node).forEach(walk);
    })(container);
    return out;
}

const animsetCache = new Map();
function animset(depot) {
    const file = path.basename(depot.replace(/\\/g, '/')) + '.json';
    if (animsetCache.has(file)) return animsetCache.get(file);
    const found = find(animsetDirs, file);
    let result = null;
    if (found) {
        const json = readJson(found);
        result = new Map();
        // The JSON dirs are flat: two animsets with one file name (woman and man copies of a Johnny set) overwrite
        // each other, so the rig the file really belongs to is kept and compared with the audited rig.
        result.rigName = String(value(json.Data.RootChunk.rig.DepotPath)).split('\\').pop().replace(/\.rig$/, '');
        for (const a of json.Data.RootChunk.animations) {
            const d = a.Data, data = d.animation.Data;
            result.set(value(data.name), { duration: Number(data.duration ?? 0), motion: data.motionExtraction != null, events: eventsOf(d.events) });
        }
    }
    animsetCache.set(file, result);
    return result;
}

const report = [];
let bad = 0;
for (const name of names) {
    const file = find(workspotDirs, `${name}.workspot.json`);
    if (!file) { console.error(`workspot not found: ${name}`); bad++; continue; }
    const ws = collect(readJson(file));
    const depots = ws.sets[rig];
    const row = { workspot: name, rig, items: ws.items, loops: [...ws.loops], clips: [...ws.clips], animsets: (depots ?? []).map((d) => path.basename(d.replace(/\\/g, '/'))), missingAnimsets: [], missingClips: [], motion: [], equips: [...ws.actions], effects: new Set(), played: [] };
    if (!depots) { row.error = `no animsets for ${rig}`; bad++; report.push(row); continue; }
    const sets = depots.map((d) => ({ depot: d, clips: animset(d) }));
    for (const s of sets) {
        const file = path.basename(s.depot.replace(/\\/g, '/'));
        if (!s.clips) row.missingAnimsets.push(file);
        else if (s.clips.rigName !== rig) { row.missingAnimsets.push(`${file} (the extracted copy belongs to ${s.clips.rigName})`); s.clips = null; }
    }
    // Clips the workspot plays (loop sequences and break clips); transition or bump sets are not needed.
    for (const clip of [...ws.loops, ...ws.clips]) {
        const hit = sets.find((s) => s.clips?.has(clip));
        if (!hit) { row.missingClips.push(clip); continue; }
        const info = hit.clips.get(clip);
        row.played.push({ clip, seconds: Math.round(info.duration * 10) / 10 });
        if (info.motion) row.motion.push(clip);
        for (const e of info.events) {
            if (e.item) row.equips.push({ from: clip, event: e.event, item: e.item, slot: e.slot, frame: e.frame });
            else if (e.effect) row.effects.add(e.effect);
            else if (e.kind === 'WorkspotItem') row.equips.push({ from: clip, event: e.event, note: e.action ?? 'no action', frame: e.frame });
        }
    }
    row.effects = [...row.effects].sort();
    const unique = new Map();
    for (const e of row.equips) unique.set(`${e.item ?? e.note}|${e.slot ?? ''}`, e);
    row.props = [...unique.values()].filter((e) => e.item).map((e) => ({ item: e.item, slot: e.slot, event: e.event, from: e.from ?? e.from }));
    if (row.missingClips.length || row.motion.length || row.missingAnimsets.length) bad++;
    report.push(row);
}
if (asJson) console.log(JSON.stringify(report, null, 1));
else {
    for (const row of report) {
        console.log(`== ${row.workspot} (${row.rig}) ${row.error ?? ''}`);
        console.log(`   animsets: ${row.animsets.join(', ')}`);
        console.log(`   loops: ${row.loops.join(', ')}`);
        console.log(`   break clips: ${row.clips.length}; played total ${row.played.length}`);
        if (row.missingAnimsets?.length) console.log(`   MISSING ANIMSETS (not extracted): ${row.missingAnimsets.join(', ')}`);
        if (row.missingClips?.length) console.log(`   MISSING CLIPS: ${row.missingClips.join(', ')}`);
        if (row.motion?.length) console.log(`   MOTION EXTRACTION (the body would walk): ${row.motion.join(', ')}`);
        console.log(`   props: ${(row.props ?? []).map((p) => `${p.item} -> ${p.slot} (${p.event})`).join('; ') || 'none'}`);
        console.log(`   effects: ${(row.effects ?? []).join(', ') || 'none'}`);
    }
}
process.exit(bad ? 1 : 0);
