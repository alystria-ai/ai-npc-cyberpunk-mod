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
// How violently a clip moves the spine, neck, head and hips (scripts/Measure-GestureBody.py):
// the body twitch a viewer sees while a gesture plays. Optional; same-name fallback across sets.
const bodyFile = path.join(project, 'assets', 'gestures', 'clip-body.json');
const bodyData = fs.existsSync(bodyFile) ? readJson(bodyFile) : {};
const bodyFields = bodyData.fields ?? [];
const bodySets = bodyData.animsets ?? {};
const bodyRow = (row) => Object.fromEntries(bodyFields.map((field, index) => [field, row[index]]));
const bodyByName = new Map();
for (const clips of Object.values(bodySets)) {
    for (const [name, row] of Object.entries(clips)) if (name !== '__loopDrift' && !bodyByName.has(name)) bodyByName.set(name, bodyRow(row));
}
const bodyOf = (animset, name) => {
    const row = bodySets[base(animset).replace(/\.anims$/, '')]?.[name];
    return row && name !== '__loopDrift' ? bodyRow(row) : bodyByName.get(name);
};
const shapeOf = (animset, name) => {
    const row = shapeSets[base(animset).replace(/\.anims$/, '')]?.[name];
    const body = bodyOf(animset, name);
    const shape = row ? { ...shapeRow(row), measured: true } : shapeByName.get(name);
    return shape || body ? { ...(shape ?? {}), ...(body ?? {}) } : undefined;
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
            ['body', t.bodySway && worst('bodySway') > t.bodySway, `hips travel ${worst('bodySway')} cm (a stance shift or step)`],
            ['body', t.spineJerk && worst('spineJerk') > t.spineJerk, `spine whips at ${worst('spineJerk')} deg/s (reads as a twitch)`],
            ['body', t.bodyJerk && worst('bodyJerk') > t.bodyJerk, `spine, neck or head whips at ${worst('bodyJerk')} deg/s (reads as a twitch)`],
        ];
        for (const [fit, hit, reason] of checks) if (hit) return { fit, reason };
        // One hand held out to a side by 20-30 cm (a shrug, a "what", a flick) is ordinary talk, played less often.
        if (worst('side') >= (t.openSide ?? Infinity)) return { fit: 'open' };
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
    // The character's extra idles (a rotation of its own: coffee, cigarette, ...) are held to the same rule.
    for (const key of known.idles ?? []) {
        if (!source.idleWorkspots[key]) fail(`${record}: pool idle ${key} has no workspot`);
        const poolChecked = source.idleSources?.[key];
        if (!poolChecked || !poolChecked[2].split(',').includes(known.rig)) fail(`${record}: pool idle ${key} is not checked on ${known.rig}`);
    }
}
// Prop idles (docs/COMPANION_GESTURES.md, Round 12): each needs a workspot, a checked source and at least one declared
// item with a hand slot, which is what the controller takes out of the slot afterwards. The item records themselves
// come from scripts/Audit-PropIdles.mjs (animation data); here only the shape is enforced.
const HAND_SLOTS = new Set(['AttachmentSlots.WeaponRight', 'AttachmentSlots.WeaponLeft']);
for (const [key, row] of Object.entries(source.propIdles ?? {})) {
    if (key === 'note') continue;
    if (!source.idleWorkspots[key]) fail(`prop idle ${key} has no workspot`);
    if (!source.idleSources?.[key]) fail(`prop idle ${key} has no idleSources row`);
    if (!Array.isArray(row.items) || row.items.length === 0) fail(`prop idle ${key} declares no item`);
    for (const item of row.items) {
        if (!/^Items\.[A-Za-z0-9_]+$/.test(item.item ?? '')) fail(`prop idle ${key}: item ${item.item} is not an Items.* record`);
        if (!HAND_SLOTS.has(item.slot)) fail(`prop idle ${key}: slot ${item.slot} is not a hand slot`);
    }
    // Optional: worn visuals hidden while the idle plays (plain substrings of component names; Round 14).
    if (row.hideComponents !== undefined && (!Array.isArray(row.hideComponents) || row.hideComponents.length === 0
        || row.hideComponents.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9_]{4,}$/.test(name)))) {
        fail(`prop idle ${key}: hideComponents must be a non-empty list of component name fragments`);
    }
}
// Visual similarity group of every idle (Round 16): the controller never follows an idle with one of the same group while
// the pool has another. Every idle workspot needs one, and a group row without a workspot is a typo.
const idleGroups = Object.fromEntries(Object.entries(source.idleGroups ?? {}).filter(([key]) => key !== 'note'));
const groupNotes = source.idleGroupNotes ?? {};
for (const key of Object.keys(source.idleWorkspots)) {
    if (!/^[a-z][a-z_]*$/.test(idleGroups[key] ?? '')) fail(`idle ${key} has no similarity group (idleGroups)`);
    if (!groupNotes[idleGroups[key]]) fail(`idle ${key}: group ${idleGroups[key]} is not described in idleGroupNotes`);
}
for (const key of Object.keys(idleGroups)) if (!source.idleWorkspots[key]) fail(`idleGroups lists ${key}, which has no idle workspot`);
for (const group of Object.keys(groupNotes)) if (!Object.values(idleGroups).includes(group)) fail(`idleGroupNotes describes ${group}, which no idle uses`);
// Pose blends of the idle workspot copies (seconds, Round 16): vanilla is enter 0.5, natural exit 0.5, forced exit 0.2.
const idleBlend = source.idleBlend ?? {};
for (const field of ['enter', 'exitNatural', 'exitForced']) {
    const seconds = Number(idleBlend[field]);
    if (!(seconds >= 0.2 && seconds <= 3)) fail(`idleBlend.${field} must be 0.2-3 s: ${idleBlend[field]}`);
}
for (const [key, row] of Object.entries(source.idleOptions ?? {})) {
    if (key === 'note') continue;
    if (!source.idleWorkspots[key]) fail(`idle option for ${key}, which has no workspot`);
    if (row.omitClips && !Array.isArray(row.omitClips)) fail(`idle option ${key}: omitClips must be a list`);
}
// The generic fallback (companions not in 'characters'): every body type maps to a rig that has a talk family
// and an idle checked on that rig.
for (const [bodyType, rig] of Object.entries(source.generic?.bodyTypes ?? {})) {
    const row = source.generic.rigs?.[rig];
    if (!row) fail(`generic: body type ${bodyType} maps to ${rig}, which has no row`);
    if (bodyType !== bodyType.toLowerCase().replace(/[^a-z0-9]/g, '')) fail(`generic: body type ${bodyType} must be lower case without separators`);
    if (!source.families[row.talk]?.animsets?.[rig] && !(source.families[row.talk]?.like && source.families[source.families[row.talk].like]?.animsets?.[rig])) fail(`generic: family ${row.talk} has no animset for ${rig}`);
    if (!source.idleWorkspots[row.idle]) fail(`generic: idle ${row.idle} has no workspot`);
    const checked = source.idleSources?.[row.idle];
    if (!checked || !checked[2].split(',').includes(rig)) fail(`generic: idle ${row.idle} is not checked on ${rig}`);
    // The random pool of clean idles for this rig (also mixed into catalogued characters when generic.mix is set).
    for (const key of row.idles ?? []) {
        if (!source.idleWorkspots[key]) fail(`generic: pool idle ${key} has no workspot`);
        const poolChecked = source.idleSources?.[key];
        if (!poolChecked || !poolChecked[2].split(',').includes(rig)) fail(`generic: pool idle ${key} is not checked on ${rig}`);
    }
}
const seatWorkspots = source.seatWorkspots ?? {};
for (const [key, depot] of Object.entries(seatWorkspots)) requirePath(depot, `${key} seat workspot`);

// Facial idle of a workspot (docs/COMPANION_GESTURES.md, "Face override").
// While any workspot runs, the NPC face graph swaps its own facial idle for the
// one named on the workspot's hub node, at full animation weight; the mod's
// speech layer adds only LipsyncPoseOutput deltas and never fades that idle
// (AnimOverrideWeight stays 1). The 'interested' idle and its 'attentive' or
// 'focused' key pose carry lips_together at 0.66-1.0 plus purse, chin raise and
// suck, which kept the lips sealed under an opening jaw. Every workspot the
// mod plays therefore uses the plain neutral idle (the one ambient NPCs and
// the vanilla judy/panam/johnny idles use) and no key pose.
const hubsOf = (workspot) => {
    const hubs = [];
    (function walk(node) {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        if (node.$type === 'animAnimNode_WorkspotHub') hubs.push(node);
        Object.values(node).forEach(walk);
    })(workspot.Data.RootChunk.nodesToInit);
    return hubs;
};
const neutralFace = (workspot, what) => {
    const hubs = hubsOf(workspot);
    if (hubs.length === 0) fail(`${what}: no workspot hub node to set the facial idle on`);
    for (const hub of hubs) {
        hub.facialIdleMaleAnimation = cname('idle__neutral__male');
        hub.facialIdleFemaleAnimation = cname('idle__neutral__female');
        hub.facialIdleKey_MaleAnimation = cname('None');
        hub.facialIdleKey_FemaleAnimation = cname('None');
        hub.facialKeyWeight = 1;
    }
};
const faceNeutral = (workspot) => hubsOf(workspot).every((hub) =>
    hub.facialIdleMaleAnimation?.$value === 'idle__neutral__male' && hub.facialIdleFemaleAnimation?.$value === 'idle__neutral__female'
    && hub.facialIdleKey_MaleAnimation?.$value === 'None' && hub.facialIdleKey_FemaleAnimation?.$value === 'None');
// Every vanilla idle workspot the mod plays is copied under the mod's own path
// (vanilla files are never overridden, so ambient NPCs keep theirs), with the
// plain neutral facial idle and without its walk-to-stand entry clips. Those
// entry clips (walk_0__to__stand__...__turn*) are picked by the engine on every
// play and land straight in the stance: live on Evelyn (Oct 10, 34 fps, torso
// displacement) a workspot with them lurches the body 15-19 px at the play call,
// one without them (on_hips, jackie_hips, a loop of her own ambient idle) 2-5 px.
const withoutEntries = (workspot, what) => {
    const list = workspot.Data.RootChunk.workspotTree.Data.rootEntry.Data.list;
    const kept = list.filter((node) => node.Data.$type !== 'workEntryAnim');
    workspot.Data.RootChunk.workspotTree.Data.rootEntry.Data.list = kept;
    return list.length - kept.length;
};
const report = [];
const outputs = [];
const faceCopies = new Map();
// Break clips an idle's rig does not carry (scripts/Audit-PropIdles.mjs names them) are removed from the copy: a clip
// missing from the animsets would stall the workspot. The random lists keep at least their clip counts' worth of members.
const omitClips = (workspot, names, what) => {
    const drop = new Set(names);
    let removed = 0;
    (function walk(node) {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node.list)) {
            const kept = node.list.filter((entry) => {
                const data = entry.Data ?? entry;
                const hit = data.$type === 'workAnimClip' && drop.has(data.animName?.$value);
                if (hit) removed++;
                return !hit;
            });
            if (kept.length !== node.list.length) {
                node.list = kept;
                if (node.$type === 'workRandomList') {
                    if (Number(node.maxClips) > kept.length) node.maxClips = kept.length;
                    if (Number(node.minClips) > node.maxClips) node.minClips = node.maxClips;
                }
            }
        }
        Object.values(node).forEach(walk);
    })(workspot.Data.RootChunk.workspotTree);
    if (removed === 0) fail(`${what}: none of the clips to omit was found (${names.join(', ')})`);
    return removed;
};
// An idle whose sequence ends after its few break clips would leave through the workspot's own exit by itself while the
// controller still thinks it is playing (docs/COMPANION_SEATING.md: the seats did exactly that). Each break list directly
// under a sequence that does not already repeat is set to a clip count that is never reached and the sequence repeats;
// the fast exit, the exits and the clips are untouched, so the controller's exit works as before.
const IDLE_ENDLESS_CLIPS = 127; // the clip counts are signed bytes
const endlessIdle = (workspot, what) => {
    let lists = 0;
    (function walk(node) {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        if (node.$type === 'workSequence' && Array.isArray(node.list) && Number(node.loopInfinitely) !== 1) {
            const direct = node.list.map((entry) => entry.Data ?? entry).filter((entry) => entry.$type === 'workRandomList');
            if (direct.length > 0) {
                for (const list of direct) { list.minClips = IDLE_ENDLESS_CLIPS; list.maxClips = IDLE_ENDLESS_CLIPS; lists++; }
                node.loopInfinitely = 1;
            }
        }
        Object.values(node).forEach(walk);
    })(workspot.Data.RootChunk.workspotTree);
    if (lists === 0) fail(`${what}: no break list to repeat`);
    return lists;
};
for (const [what, depot] of Object.entries(source.idleWorkspots).map(([key, d]) => [`${key} idle`, d])) {
    const key = what.replace(/ idle$/, '');
    const json = jsonFor(depot);
    if (!json) fail(`${what} workspot was not extracted: ${depot}`);
    const copy = clone(json);
    if (!faceNeutral(copy)) neutralFace(copy, what);
    const dropped = withoutEntries(copy, what);
    const idleTree = copy.Data.RootChunk.workspotTree.Data;
    idleTree.inertializationDurationEnter = idleBlend.enter;
    idleTree.inertializationDurationExitNatural = idleBlend.exitNatural;
    idleTree.inertializationDurationExitForced = idleBlend.exitForced;
    const options = source.idleOptions?.[key] ?? {};
    const omitted = options.omitClips?.length ? omitClips(copy, options.omitClips, what) : 0;
    const looped = options.endless ? endlessIdle(copy, what) : 0;
    const target = `cyberpunk_convai\\gestures\\convai_idle_${base(depot)}`;
    copy.Header.ArchiveFileName = target;
    outputs.push([`convai_idle_${base(depot)}.json`, copy]);
    faceCopies.set(depot, target);
    report.push(`idle: ${base(depot)} copied to ${target} without ${dropped} entry clip(s)${omitted ? `, ${omitted} omitted break clip(s)` : ''}${looped ? `, ${looped} endless break list(s)` : ''}`);
}
const playable = (depot) => faceCopies.get(depot) ?? depot;

// Sit workspots that never end by themselves (docs/COMPANION_SEATING.md, "The
// seat that ended on its own"). A vanilla NPC sit workspot plays one random
// list of 4-9 idle fidgets with a pause between them (couch 6-9 clips 3 s
// apart, counter stool 5-8 at 2 s, chair 4-7 at 6 s, stool 4-6 at 4 s) and then
// leaves through its exit: live, every seat ended 60-105 s after she sat while
// V still sat. Each seat workspot is copied under the mod's own path with the
// list set to a clip count that is never reached and the main sequence set to
// repeat; her exits, fast exit, entries and fidgets are untouched, so she
// still stands up the moment V does. Neutral facial idle as for every
// workspot the mod plays.
const ENDLESS_CLIPS = 127; // the clip counts are signed bytes (255 does not convert)
const endless = (workspot, what) => {
    let lists = 0;
    let loops = 0;
    (function walk(node, parent) {
        if (Array.isArray(node)) { node.forEach((item) => walk(item, parent)); return; }
        if (!node || typeof node !== 'object') return;
        if (node.$type === 'workRandomList') {
            node.minClips = ENDLESS_CLIPS;
            node.maxClips = ENDLESS_CLIPS;
            lists++;
            if (parent && parent.$type === 'workSequence') { parent.loopInfinitely = 1; loops++; }
        }
        const next = typeof node.$type === 'string' && node.$type.startsWith('work') ? node : parent;
        Object.values(node).forEach((value) => walk(value, next));
    })(workspot.Data.RootChunk.workspotTree, null);
    if (lists === 0 || loops !== lists) fail(`${what}: found ${lists} random lists and ${loops} sequences to repeat, expected at least one of each and equal counts`);
    return lists;
};
const seatCopies = new Map();
for (const [key, depot] of Object.entries(seatWorkspots)) {
    const json = jsonFor(depot);
    if (!json) fail(`${key} seat workspot was not extracted: ${depot}`);
    const copy = clone(json);
    if (!faceNeutral(copy)) neutralFace(copy, `${key} seat`);
    const lists = endless(copy, `${key} seat`);
    const target = `cyberpunk_convai\\gestures\\convai_seat_${base(depot)}`;
    copy.Header.ArchiveFileName = target;
    outputs.push([`convai_seat_${base(depot)}.json`, copy]);
    seatCopies.set(depot, target);
    console.log(`gesture build: ${key} seat copied to ${target} with ${lists} endless fidget list(s)`);
}
const seatPlayable = (depot) => seatCopies.get(depot) ?? fail(`no endless copy of ${depot}`);

function collectHandles(node, into) {
    if (Array.isArray(node)) { node.forEach((item) => collectHandles(item, into)); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.HandleId === 'string') into.push(node);
    Object.values(node).forEach((value) => collectHandles(value, into));
}

const catalogFamilies = {};
const aliases = [];
const resolved = (family) => {
    if (!family.like) return family;
    const parent = source.families[family.like];
    if (!parent || parent.like) fail(`family variant of ${family.like}: the parent must be a plain family`);
    return { ...clone(parent), ...family, animsets: family.animsets ?? clone(parent.animsets) };
};
for (const [familyKey, familySource] of Object.entries(source.families)) {
    const family = resolved(familySource);
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
    // A variant of another family (like) keeps that family's sequence ids, so its clip list is identical.
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
    neutralFace(workspot, `${familyKey} workspot`);
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
    const sequence = (id, list, loop, idleAnim = family.idle) => ({ HandleId: '0', Data: {
        $type: 'workSequence', category: 'Any', disableAutoTransition: 0, flags: 0, id: entryId(id),
        idleAnim: cname(idleAnim), list, loopInfinitely: loop ? 1 : 0, previousLoopInfinitely: 0 } });
    // Template exits and bumps belong to the hands-at-sides pose; other stances keep only the
    // fast exit. Crowd Fear reactions never stay. The template's walk-to-stand entry clips are
    // never kept: the engine plays one on every enter and it lands straight in the stance,
    // which lurched the body 15-19 px (Round 5d, live). The stance loop is the first sequence: an ambient idle
    // played first and crossed to the stance made a visible 4-5 cm slide (Round 5f, live).
    const entries = family.templateEntries ? [
        ...keep('workReactionSequence').filter((node) => JSON.stringify(node).includes('bump'))] : [];
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
    if (family.like) {
        // Same clips as the parent family: share the Lua table instead of writing it out again.
        if (JSON.stringify(catalogFamilies[familyKey].clips) !== JSON.stringify(catalogFamilies[family.like]?.clips)) fail(`${familyKey}: clip list differs from ${family.like}`);
        aliases.push([familyKey, family.like]);
    }
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
    ...Object.entries(source.idleWorkspots).map(([key, depot]) => [`convai_idle_${key}`, playable(depot)]),
    ...Object.entries(seatWorkspots).map(([key, depot]) => [`convai_sit_${key}`, seatPlayable(depot)])];
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
// Natural cycle (seconds of the loop clip) of each idle per rig, measured by scripts/Measure-IdleCycles.mjs from the same
// extracted workspots and animsets (Round 15). The controller holds an idle for whole cycles; an idle missing here keeps
// the random hold. The measured file is optional, like the motion data.
const cyclesFile = path.join(project, 'assets', 'gestures', 'idle-cycles.json');
const idleCycles = {};
for (const [key, row] of Object.entries(fs.existsSync(cyclesFile) ? readJson(cyclesFile).idles ?? {} : {})) {
    if (!source.idleWorkspots[key]) fail(`idle-cycles.json lists ${key}, which has no idle workspot`);
    const perRig = Object.fromEntries(Object.entries(row.cycle ?? {}).filter(([rig, seconds]) => source.rigs[rig] && Number(seconds) > 0));
    if (Object.keys(perRig).length > 0) idleCycles[key] = perRig;
}
const catalog = {
    version: 2,
    device: source.device,
    families: catalogFamilies,
    idleComponents: Object.fromEntries(Object.keys(source.idleWorkspots).map((key) => [key, `convai_idle_${key}`])),
    // Per idle: character (own clips), character workspot (shared clips) or generic, and the rigs it was checked on.
    idleSources: Object.fromEntries(Object.entries(source.idleSources ?? {}).map(([key, [kind, what, rigs]]) => [key, { kind, what, rigs: rigs.split(',') }])),
    idleCycles,
    // Visual similarity group per idle (idleGroups in gestures.json): an idle is never followed by one of its own group
    // while the pool has another (mod/companion-gestures.lua).
    idleGroups,
    // Pose blends baked into the idle workspot copies; the controller waits for the blend-out after an exit.
    idleBlend: { enter: idleBlend.enter, exitNatural: idleBlend.exitNatural, exitForced: idleBlend.exitForced },
    // Idles that put an item in a hand (animation data, scripts/Audit-PropIdles.mjs): what the controller takes off afterwards.
    propIdles: Object.fromEntries(Object.entries(source.propIdles ?? {}).filter(([key]) => key !== 'note')
        .map(([key, row]) => [key, { prop: row.prop, items: row.items.map((item) => ({ item: item.item, slot: item.slot })),
            ...(row.hideComponents ? { hideComponents: row.hideComponents } : {}) }])),
    seatComponents: Object.fromEntries(Object.keys(seatWorkspots).map((key) => [key, `convai_sit_${key}`])),
    characters: source.characters,
    // Fallback for records not in 'characters': body type -> rig -> talk family and idle (mod/companion-gestures.lua).
    generic: source.generic ? { bodyTypes: source.generic.bodyTypes, rigs: source.generic.rigs, mix: source.generic.mix === true,
        never: Object.fromEntries((source.generic.never ?? []).map((record) => [record, true])) } : undefined,
};
for (const [key] of aliases) delete catalog.families[key].clips;
const aliasLines = aliases.map(([key, parent]) => `catalog.families.${key}.clips = catalog.families.${parent}.clips`);
const aliasBlock = aliasLines.length ? `-- Variants of another family share its clip list.\n${aliasLines.join('\n')}\n` : '';
fs.writeFileSync(catalogOut, `-- Generated by scripts/Build-GestureAssets.mjs from assets/gestures/gestures.json\n-- and the game's extracted animsets. Do not edit by hand.\nlocal catalog = ${lua(catalog)}\n${aliasBlock}return catalog\n`);
for (const line of report) console.log(`gesture build: ${line}`);
console.log(`gesture build: ${Object.keys(catalogFamilies).length} families, ${components.length} workspot components`);
