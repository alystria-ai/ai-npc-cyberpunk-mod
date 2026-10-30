import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GameVoiceClips, applyReadyClips, builderFiles, downloadUrl, gameFingerprint, generatedReference, readManifest, EXIT_NO_ENGLISH_VOICE} from './voice-clips.mjs';
import {LiveVoices} from './live-voices.mjs';

// Voice clips built on the player's PC from the game's own voice files: the manifest reader, the on-demand queue, the download fall back and the voice tables.
// The builder (bridge/voice_clip_build.py) is replaced by a script that writes small files; the real one is checked against the shipped clips by
// scripts/voice-extract (docs/VOICE_EXTRACTION.md).

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const wav = seed => Buffer.concat([Buffer.from('RIFF....WAVEfmt ', 'latin1'), Buffer.alloc(40, seed)]);
const spec = seed => ({sha256: sha(wav(seed)), samples: 1000 + seed, lines: [], writer: 'sf'});
const MANIFEST = JSON.stringify({version: 1, voices: {
  'judy-alvarez': {'omni-short': spec(1), 'omni-long': spec(2), pocket: {sameAs: 'omni-long'}},
  'broken': {'omni-short': spec(3)},
  'Bad Key': {'omni-short': spec(4), 'omni-long': spec(4), pocket: spec(4)},
  'no-hash': {'omni-short': {samples: 1}, 'omni-long': {samples: 1}, pocket: {samples: 1}},
}});
const shippedTable = key => ({
  pocket: {reference: `runtime/voice-references/picked/autobest/pocket/${key}.wav`, sha256: 'a'.repeat(64), transcript: 'Pocket words.'},
  short: {reference: `runtime/voice-references/picked/autobest/omni-short/${key}.wav`, sha256: 'b'.repeat(64), transcript: 'Short words.'},
  long: {reference: `runtime/voice-references/picked/autobest/omni-long/${key}.wav`, sha256: 'c'.repeat(64), transcript: 'Long words.'},
});

async function rig(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-clips-'));
  const references = join(dir, 'state', 'voice-references');
  const mirror = join(dir, 'game', 'voices');
  const runs = [];
  const built = [];
  const run = async (command, args) => {
    runs.push({command, args});
    const out = args[args.indexOf('--out') + 1], key = args[args.indexOf('--key') + 1];
    if (options.exit) return {code: options.exit, stdout: '', stderr: options.stderr ?? ''};
    for (const [kind, seed] of [['omni-short', 1], ['omni-long', 2], ['pocket', 2]]) {
      await mkdir(join(out, kind), {recursive: true});
      await writeFile(join(out, kind, `${key}.wav`), wav(options.seed?.[kind] ?? seed));
    }
    return {code: 0, stdout: JSON.stringify({key}), stderr: ''};
  };
  const clips = await GameVoiceClips.open({manifest: readManifest(MANIFEST), gameDirectory: join(dir, 'game'), referenceRoot: references, mirrorRoots: [mirror, references],
    stateDirectory: join(dir, 'state'), python: 'python.exe', script: 'voice_clip_build.py', vgmstream: 'vgmstream-cli.exe', manifestPath: 'manifest.json', run,
    onBuilt: key => built.push(key), download: options.download ?? false, prefer: options.prefer ?? false, shippedPresent: options.shippedPresent});
  return {dir, references, mirror, runs, built, clips, cleanup: () => rm(dir, {recursive: true, force: true})};
}

test('readManifest: sameAs entries are resolved, a voice without the three clips, a bad key or a missing hash is left out', () => {
  const voices = readManifest(MANIFEST);
  assert.deepEqual(Object.keys(voices), ['judy-alvarez']);
  assert.equal(voices['judy-alvarez'].pocket.sha256, voices['judy-alvarez']['omni-long'].sha256);
  assert.deepEqual(Object.keys(readManifest('{"voices": 5}')), []);
  assert.deepEqual(Object.keys(readManifest('﻿{"voices":{}}')), []);
});

test('a character with no shipped clip is built once, at below normal priority in a process of its own, and kept', async () => {
  const r = await rig({shippedPresent: async () => false});
  try {
    assert.equal(await r.clips.needs('judy-alvarez', shippedTable('judy-alvarez')), true);
    assert.equal(await r.clips.needs('someone-else', shippedTable('someone-else')), false, 'a character the manifest does not know is not touched');
    const first = r.clips.ensure('judy-alvarez');
    const second = r.clips.ensure('judy-alvarez');
    assert.equal(first, second, 'a second ask while it is being made is the same job');
    assert.equal(await first, 'ready');
    assert.equal(r.runs.length, 1);
    assert.deepEqual(r.runs[0].args.slice(0, 2), ['voice_clip_build.py', 'build']);
    assert.deepEqual(r.built, ['judy-alvarez']);
    assert.equal(await r.clips.ensure('judy-alvarez'), 'ready');
    assert.equal(r.runs.length, 1, 'ready is not built again');
    assert.equal(await r.clips.needs('judy-alvarez', shippedTable('judy-alvarez')), false);
    for (const root of [r.references, r.mirror]) assert.equal(existsSync(join(root, 'generated', 'pocket', 'judy-alvarez.wav')), true, 'the clip is in every folder a worker reads');
    // a new service reads the index and does not build again
    const again = await GameVoiceClips.open({manifest: readManifest(MANIFEST), referenceRoot: r.references, stateDirectory: join(r.dir, 'state'), run: async () => { throw Error('no build'); }});
    assert.deepEqual(again.readyKeys(), ['judy-alvarez']);
  } finally { await r.cleanup(); }
});

test('with the shipped clips on disk nothing is built, unless the game clips are asked for', async () => {
  const there = await rig({shippedPresent: async () => true});
  try { assert.equal(await there.clips.needs('judy-alvarez', shippedTable('judy-alvarez')), false); } finally { await there.cleanup(); }
  const asked = await rig({shippedPresent: async () => true, prefer: true});
  try { assert.equal(await asked.clips.needs('judy-alvarez', shippedTable('judy-alvarez')), true); } finally { await asked.cleanup(); }
});

test('the voice tables name the generated clips with their own hash and the words of the shipped descriptor', async () => {
  const r = await rig({shippedPresent: async () => false});
  try {
    assert.equal(r.clips.descriptors('judy-alvarez', shippedTable('judy-alvarez')), null, 'not ready: nothing to name');
    await r.clips.ensure('judy-alvarez');
    const named = r.clips.descriptors('judy-alvarez', shippedTable('judy-alvarez'));
    assert.equal(named.short.reference, generatedReference('omni-short', 'judy-alvarez'));
    assert.equal(named.short.sha256, sha(wav(1)));
    assert.equal(named.long.sha256, sha(wav(2)));
    assert.equal(named.pocket.transcript, 'Pocket words.');
    assert.equal(r.clips.descriptors('judy-alvarez', {pocket: null, short: null, long: null}), null, 'no words to give: the shipped voice stays');
  } finally { await r.cleanup(); }
});

test('LiveVoices uses a generated clip when the player has none of their own, and the shipped descriptor otherwise', async () => {
  const r = await rig({shippedPresent: async () => false});
  try {
    const tables = {pocket: {'judy-alvarez': shippedTable('judy-alvarez').pocket}, short: {'judy-alvarez': shippedTable('judy-alvarez').short}, long: {'judy-alvarez': shippedTable('judy-alvarez').long}};
    const calls = [];
    const players = {extras: async () => []};
    const live = new LiveVoices({players, folder: join(r.dir, 'player'), voices: tables, shipped: async () => tables, apply: update => { calls.push(update); return true; },
      generated: (key, shipped) => r.clips.descriptors(key, shipped)});
    await live.refresh('judy-alvarez');
    assert.equal(calls.at(-1).pocket['judy-alvarez'].reference, tables.pocket['judy-alvarez'].reference, 'not built yet: the shipped descriptor');
    await r.clips.ensure('judy-alvarez');
    await live.refresh('judy-alvarez');
    assert.equal(calls.at(-1).pocket['judy-alvarez'].reference, generatedReference('pocket', 'judy-alvarez'));
    assert.equal(calls.at(-1).omni.short['judy-alvarez'].reference, generatedReference('omni-short', 'judy-alvarez'));
    assert.equal(calls.at(-1).omni.long['judy-alvarez'].sha256, sha(wav(2)));
    const own = new LiveVoices({players: {extras: async () => [{sha256: 'd'.repeat(64), transcript: 'Mine.'}]}, allowed: () => true, folder: 'x', voices: tables, shipped: async () => tables,
      apply: update => { calls.push(update); return true; }, generated: () => { throw Error('the player clip comes first'); }});
    await own.refresh('judy-alvarez');
    assert.match(calls.at(-1).pocket['judy-alvarez'].reference, /^runtime\/player-voices\//);
  } finally { await r.cleanup(); }
});

test('a game with no English voice files downloads the clips from Hugging Face, checked against the manifest hash', async () => {
  const asked = [];
  const fetchImpl = async url => {
    asked.push(url);
    const kind = url.split('/').at(-2);
    return {ok: true, status: 200, arrayBuffer: async () => { const bytes = wav(kind === 'omni-short' ? 1 : 2); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length); }};
  };
  const r = await rig({shippedPresent: async () => false, exit: EXIT_NO_ENGLISH_VOICE, download: {fetch: fetchImpl}});
  try {
    assert.equal(await r.clips.ensure('judy-alvarez'), 'ready');
    assert.deepEqual(asked.map(url => url.split('voice-clips/')[1]), ['pocket/judy-alvarez.wav', 'omni-short/judy-alvarez.wav', 'omni-long/judy-alvarez.wav']);
    assert.equal(asked[1], downloadUrl('omni-short', 'judy-alvarez'));
    assert.equal(r.clips.report().downloaded, 1);
    assert.equal((await readFile(join(r.references, 'generated', 'pocket', 'judy-alvarez.wav'))).length, wav(2).length);
  } finally { await r.cleanup(); }
  const wrong = await rig({shippedPresent: async () => false, exit: EXIT_NO_ENGLISH_VOICE, download: {fetch: async () => ({ok: true, status: 200, arrayBuffer: async () => new Uint8Array(wav(9)).buffer})}});
  try {
    assert.equal(await wrong.clips.ensure('judy-alvarez'), 'unavailable', 'a file that is not the manifest hash is not used');
    assert.equal(existsSync(join(wrong.references, 'generated', 'omni-short', 'judy-alvarez.wav')), false);
  } finally { await wrong.cleanup(); }
});

test('a failed build is not tried again at every line, and never throws into the caller', async () => {
  const r = await rig({shippedPresent: async () => false, exit: 2, stderr: 'a line is not in this game version\n'});
  try {
    assert.equal(await r.clips.ensure('judy-alvarez'), 'unavailable');
    assert.equal(await r.clips.ensure('judy-alvarez'), 'unavailable');
    assert.equal(r.runs.length, 1);
    assert.equal(await r.clips.needs('judy-alvarez', shippedTable('judy-alvarez')), false);
    assert.equal(await r.clips.ensure('nobody'), 'unknown');
  } finally { await r.cleanup(); }
});

test('builds run one at a time in the order asked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-clips-order-'));
  try {
    const manifest = readManifest(JSON.stringify({voices: {'a-one': {'omni-short': spec(1), 'omni-long': spec(2), pocket: spec(2)}, 'b-two': {'omni-short': spec(1), 'omni-long': spec(2), pocket: spec(2)}}}));
    let active = 0, peak = 0;
    const order = [];
    const run = async (command, args) => {
      active++; peak = Math.max(peak, active);
      const key = args[args.indexOf('--key') + 1], out = args[args.indexOf('--out') + 1];
      order.push(key);
      await new Promise(done => setTimeout(done, 15));
      for (const [kind, seed] of [['omni-short', 1], ['omni-long', 2], ['pocket', 2]]) { await mkdir(join(out, kind), {recursive: true}); await writeFile(join(out, kind, `${key}.wav`), wav(seed)); }
      active--;
      return {code: 0, stdout: '', stderr: ''};
    };
    const clips = await GameVoiceClips.open({manifest, gameDirectory: dir, referenceRoot: join(dir, 'refs'), stateDirectory: join(dir, 'state'), python: 'p', script: 's', manifestPath: 'm', run});
    const results = await Promise.all([clips.ensure('b-two'), clips.ensure('a-one')]);
    assert.deepEqual(results, ['ready', 'ready']);
    assert.deepEqual(order, ['b-two', 'a-one']);
    assert.equal(peak, 1);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('gameFingerprint is a stat per archive and says none for a missing one; builderFiles names only what exists', async () => {
  const text = await gameFingerprint('X:/game', {stat: async path => { if (path.includes('ep1')) throw Error('no'); return {size: 5, mtimeMs: 7}; }});
  assert.equal(text, 'content:5:7|ep1:none');
  const files = builderFiles({project: '/P', runtimePython: 'R/python.exe', exists: path => path === 'R/python.exe' || path.replace(/\\/g, '/').endsWith('/P/bridge/voice_clip_build.py')});
  assert.equal(files.python, 'R/python.exe');
  assert.match(files.script.replace(/\\/g, '/'), /\/P\/bridge\/voice_clip_build\.py$/);
  assert.equal(files.vgmstream, null);
});

test('wanted() looks at a character once per session, builds only what is missing, and never throws', async () => {
  const missing = await rig({shippedPresent: async () => false});
  try {
    const tables = {pocket: {'judy-alvarez': shippedTable('judy-alvarez').pocket}, short: {'judy-alvarez': shippedTable('judy-alvarez').short}, long: {'judy-alvarez': shippedTable('judy-alvarez').long}};
    let reads = 0;
    const shipped = async () => { reads++; return tables; };
    assert.equal(await missing.clips.wanted('nobody', {shipped}), 'unknown');
    assert.equal(reads, 0, 'a character the manifest does not know costs no read');
    const both = await Promise.all([missing.clips.wanted('judy-alvarez', {shipped, reason: 'talk'}), missing.clips.wanted('judy-alvarez', {shipped, reason: 'invitation'})]);
    assert.deepEqual(both, ['ready', 'ready']);
    assert.equal(missing.runs.length, 1);
    assert.equal(await missing.clips.wanted('judy-alvarez', {shipped}), 'ready');
    assert.equal(reads, 1);
    const broken = await rig({shippedPresent: async () => false});
    try { assert.equal(await broken.clips.wanted('judy-alvarez', {shipped: async () => { throw Error('unreadable'); }}), 'not needed'); } finally { await broken.cleanup(); }
  } finally { await missing.cleanup(); }
  const shippedHere = await rig({shippedPresent: async () => true});
  try {
    assert.equal(await shippedHere.clips.wanted('judy-alvarez', {shipped: async () => ({pocket: {'judy-alvarez': shippedTable('judy-alvarez').pocket}, short: {'judy-alvarez': shippedTable('judy-alvarez').short}, long: {'judy-alvarez': shippedTable('judy-alvarez').long}})}), 'not needed');
    assert.equal(shippedHere.runs.length, 0, 'the shipped clips are there: no process is started');
  } finally { await shippedHere.cleanup(); }
});

test('applyReadyClips names the built clips in the start-up tables and leaves the own clip of the player alone', async () => {
  const r = await rig({shippedPresent: async () => false});
  try {
    await r.clips.ensure('judy-alvarez');
    const mk = () => ({pocket: {'judy-alvarez': shippedTable('judy-alvarez').pocket, other: shippedTable('other').pocket}, short: {'judy-alvarez': shippedTable('judy-alvarez').short}, long: {'judy-alvarez': shippedTable('judy-alvarez').long}});
    const tables = mk();
    assert.deepEqual(applyReadyClips(r.clips, tables), ['judy-alvarez']);
    assert.equal(tables.pocket['judy-alvarez'].reference, generatedReference('pocket', 'judy-alvarez'));
    assert.equal(tables.pocket['judy-alvarez'].transcript, 'Pocket words.');
    assert.equal(tables.short['judy-alvarez'].sha256, sha(wav(1)));
    assert.equal(tables.pocket.other.reference, shippedTable('other').pocket.reference, 'another key is not touched');
    const own = mk();
    own.pocket['judy-alvarez'] = {reference: 'runtime/player-voices/judy-alvarez.wav', sha256: 'e'.repeat(64), transcript: 'Mine.'};
    assert.deepEqual(applyReadyClips(r.clips, own), []);
    assert.match(own.pocket['judy-alvarez'].reference, /^runtime\/player-voices\//);
    assert.deepEqual(applyReadyClips(r.clips, {pocket: null, short: null, long: null}), [], 'engines that are not set up are left out');
  } finally { await r.cleanup(); }
});
