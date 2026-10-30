import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {PassThrough, Writable} from 'node:stream';
import {tmpdir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {createServer} from 'node:http';
import {LiveVoices, shippedVoicesReader, voicesOf, withPlayerVoice} from './live-voices.mjs';
import {EditorControl} from './character-editor-control.mjs';
import {PlayerVoices, PLAYER_VOICES_FILE, PLAYER_VOICES_FOLDER} from './player-voices.mjs';
import {PocketVoice} from './pocket-voice.mjs';
import {ResidentVoice} from './resident-voice.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {VoxtralVoice} from './voxtral-voice.mjs';
import {MistralScheduler} from './mistral-rate.mjs';
import {createVoiceProfileRegistry, diffVoiceTables, registryFromTable, voiceChangeBatches, voiceTable} from './voice-profile-registry.mjs';
import {speechWav} from './voice-clip-fixture.mjs';
import {silentWav} from './speech-audio.mjs';

// A clip saved or removed in the character editor counts from that character's next line: no restart of the game or the service.
// Everything here is local: files in a temporary folder, scripted workers (no model, no GPU), a local stand-in for the Mistral endpoint.

const tick = () => new Promise(done => setImmediate(done));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const WORDS = 'The player typed these words, and nobody else ever sees them.';
const shipped = (name, extra = {}) => ({reference: `runtime/voice-references/${name}.wav`, sha256: sha(`shipped ${name}`), transcript: `Shipped words of ${name}.`, ...extra});
// A different length is a different file, so a different hash.
const clipOf = (variant, seconds = 5 + variant) => speechWav({seconds, rate: 24000});

async function rig(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'live-voices-'));
  const calls = [];
  let live = null;
  const roster = options.roster ?? ['judy-alvarez', 'sam-hill'];
  const customs = new Set(options.customs ?? []);
  const allowed = key => roster.includes(key) || customs.has(key);
  const players = await PlayerVoices.open({dir, onChanged: key => live?.refresh(key)});
  const tables = {pocket: {'judy-alvarez': shipped('judy'), 'sam-hill': shipped('sam')}, short: {'judy-alvarez': shipped('short-judy')}, long: {'judy-alvarez': shipped('long-judy'), 'sam-hill': shipped('long-sam')}};
  live = new LiveVoices({players, allowed, folder: players.folder, voices: options.voices ?? tables, shipped: options.shipped ?? (async () => tables), fallback: options.fallback,
    apply: update => { calls.push(update); return options.apply ? options.apply(update) : true; }});
  return {dir, players, live, calls, tables, customs, allowed, cleanup: () => rm(dir, {recursive: true, force: true})};
}

// ---- the tables ---------------------------------------------------------------------------------------------------------------

test('withPlayerVoice: a clip replaces the key, no clip restores the shipped voice or removes the key, the other keys are the same objects', () => {
  const voices = {a: shipped('a'), b: shipped('b')};
  const clip = {reference: 'runtime/player-voices/a.wav', sha256: 'c'.repeat(64), transcript: WORDS};
  const withClip = withPlayerVoice(voices, 'a', clip, voices);
  assert.deepEqual(withClip.a, clip);
  assert.equal(withClip.b, voices.b, 'another key is not copied or changed');
  assert.deepEqual(voices.a, shipped('a'), 'the table that was given is not modified');
  assert.deepEqual(withPlayerVoice(withClip, 'a', null, voices).a, voices.a, 'no clip: the shipped descriptor is back');
  assert.equal(Object.hasOwn(withPlayerVoice({...voices, c: clip}, 'c', null, voices), 'c'), false, 'no clip and no shipped voice: the key is gone');
  const fallback = {reference: 'runtime/voice-references/v.wav', sha256: 'd'.repeat(64), transcript: 'V words.'};
  assert.deepEqual(withPlayerVoice({a: clip}, 'a', null, null, fallback).a, fallback, 'no clip, no shipped voice, a fallback: the key keeps the fallback');
  assert.deepEqual(withPlayerVoice(voices, 'a', null, voices, fallback).a, voices.a, 'the shipped voice comes before the fallback');
  assert.deepEqual(withPlayerVoice({a: clip}, 'a', clip, null, fallback).a, clip, 'a clip comes before the fallback');
  assert.equal(voicesOf({voices: {a: 1}}).a, 1);
  assert.equal(voicesOf({}), null);
  assert.equal(voicesOf(null), null);
});

test('voice tables: only the difference is sent, in batches, each with the table the worker holds afterwards', () => {
  const from = {a: shipped('a'), b: shipped('b'), c: {status: 'unprepared'}};
  const to = {a: shipped('a'), b: {...shipped('b'), sha256: 'd'.repeat(64)}, d: shipped('d')};
  const {set, remove} = diffVoiceTables(from, to);
  assert.deepEqual(Object.keys(set).sort(), ['b', 'd']);
  assert.deepEqual(remove, ['c']);
  assert.deepEqual(diffVoiceTables(to, to), {set: {}, remove: []});
  const many = Object.fromEntries(Array.from({length: 45}, (_, at) => [`key-${at}`, shipped(`key-${at}`)]));
  const batches = voiceChangeBatches({}, many);
  assert.deepEqual(batches.map(batch => Object.keys(batch.set).length), [20, 20, 5]);
  assert.equal(Object.keys(batches[0].table).length, 20);
  assert.deepEqual(batches[2].table, many);
  assert.deepEqual(voiceChangeBatches(many, many), []);
  const registry = registryFromTable(voiceTable(createVoiceProfileRegistry({version: 2, provider: 'hybrid', engine: 'omnivoice', voices: {...to, c: {status: 'unprepared'}}})), null);
  assert.deepEqual(registry.keys, ['a', 'b', 'd']);
  assert.equal(registry.status('c'), 'unprepared');
});

// ---- the store tells the voices --------------------------------------------------------------------------------------------

test('PlayerVoices: a saved clip, its changed words and a removed clip each tell the voices once; a hook that fails never fails the save', async () => {
  const r = await rig();
  try {
    const seen = [];
    r.players.onChanged = key => { seen.push(key); };
    await r.players.set('judy-alvarez', clipOf(1), WORDS);
    await r.players.setTranscript('judy-alvarez', 'Other words, also typed by the player.');
    assert.equal(await r.players.clear('judy-alvarez'), true);
    assert.equal(await r.players.clear('judy-alvarez'), false, 'nothing to remove: nobody is told');
    assert.deepEqual(seen, ['judy-alvarez', 'judy-alvarez', 'judy-alvarez']);
    r.players.onChanged = () => { throw Error('the voices are gone'); };
    await r.players.set('sam-hill', clipOf(2), WORDS);
    r.players.onChanged = () => Promise.reject(Error('late failure'));
    assert.equal(await r.players.clear('sam-hill'), true);
    await tick();
  } finally { await r.cleanup(); }
});

test('storage: the clip file, the index and the folder the voices are told about always come from the one state folder', async () => {
  // A player install keeps its data in %LOCALAPPDATA%\AiNpcCyberpunkMod\data; a source checkout in runtime/. Whichever it is, nothing is split.
  for (const home of [join(tmpdir(), 'AiNpcCyberpunkMod', 'data'), join(tmpdir(), 'checkout', 'runtime')]) {
    const dir = await mkdtemp(join(tmpdir(), 'live-voices-home-'));
    const state = resolve(dir, relative(tmpdir(), home));
    try {
      const store = await PlayerVoices.open({dir: state});
      assert.equal(store.folder, join(state, PLAYER_VOICES_FOLDER));
      assert.equal(store.indexPath, join(state, PLAYER_VOICES_FILE));
      assert.equal(store.path('judy-alvarez'), join(state, PLAYER_VOICES_FOLDER, 'judy-alvarez.wav'));
      await store.set('judy-alvarez', clipOf(3), WORDS);
      assert.equal((await stat(store.path('judy-alvarez'))).isFile(), true);
      assert.equal(JSON.parse(await readFile(store.indexPath, 'utf8')).voices['judy-alvarez'].sha256.length, 64);
      // The save and the removal both touch only that one folder.
      assert.deepEqual((await readdir(state)).sort(), [PLAYER_VOICES_FOLDER, PLAYER_VOICES_FILE].sort());
      await store.clear('judy-alvarez');
      assert.deepEqual(await readdir(store.folder), []);
      assert.equal(JSON.parse(await readFile(store.indexPath, 'utf8')).voices['judy-alvarez'], undefined);
      // A store reopened on the same folder finds exactly what was kept; a store on another folder finds nothing of it.
      await store.set('sam-hill', clipOf(4), WORDS);
      assert.equal((await PlayerVoices.open({dir: state})).has('sam-hill'), true);
      assert.equal((await PlayerVoices.open({dir: resolve(dir, 'elsewhere')})).has('sam-hill'), false);
      assert.equal(new PlayerVoices({}).folder, null);
      assert.equal(new PlayerVoices({}).indexPath, null);
    } finally { await rm(dir, {recursive: true, force: true}); }
  }
});

// ---- LiveVoices ------------------------------------------------------------------------------------------------------------

test('LiveVoices: saving a clip puts it in every engine\'s table, and removing it brings the shipped voice back', async () => {
  const r = await rig();
  try {
    await r.players.set('judy-alvarez', clipOf(1), WORDS);
    await r.live.chain;
    assert.equal(r.calls.length, 1);
    const [update] = r.calls, entry = r.players.get('judy-alvarez');
    const clip = {reference: 'runtime/player-voices/judy-alvarez.wav', sha256: entry.sha256, transcript: WORDS};
    assert.deepEqual(update.pocket['judy-alvarez'], clip);
    assert.deepEqual(update.omni.short['judy-alvarez'], clip);
    assert.deepEqual(update.omni.long['judy-alvarez'], clip);
    assert.deepEqual(update.changed, ['judy-alvarez']);
    assert.equal(update.playerVoiceDirectory, r.players.folder);
    // Another character's voice is the very same descriptor as before.
    assert.equal(update.pocket['sam-hill'], r.tables.pocket['sam-hill']);
    assert.equal(update.omni.long['sam-hill'], r.tables.long['sam-hill']);
    assert.equal(Object.hasOwn(update.omni.short, 'sam-hill'), false, 'a voice an engine never had is not invented');
    await r.players.clear('judy-alvarez');
    await r.live.chain;
    const [, removed] = r.calls;
    assert.deepEqual(removed.pocket['judy-alvarez'], r.tables.pocket['judy-alvarez'], 'the shipped voice of Pocket');
    assert.deepEqual(removed.omni.short['judy-alvarez'], r.tables.short['judy-alvarez']);
    assert.deepEqual(removed.omni.long['judy-alvarez'], r.tables.long['judy-alvarez']);
    assert.equal(removed.pocket['sam-hill'], r.tables.pocket['sam-hill']);
  } finally { await r.cleanup(); }
});

test('LiveVoices: a character the player made has no shipped voice, so its key leaves the tables when its clip goes; a deleted character has no clip at all', async () => {
  const key = 'custom-rebecca-abcd';
  const r = await rig({customs: [key]});
  try {
    await r.players.set(key, clipOf(2), WORDS);
    await r.live.chain;
    assert.equal(r.calls.at(-1).pocket[key].reference, `runtime/player-voices/${key}.wav`);
    await r.players.clear(key);
    await r.live.chain;
    assert.equal(Object.hasOwn(r.calls.at(-1).pocket, key), false);
    assert.equal(Object.hasOwn(r.calls.at(-1).omni.long, key), false);
    // The character is deleted while its clip is kept (the delete path clears it, but the order is not assumed): the clip no longer counts.
    await r.players.set(key, clipOf(2), WORDS);
    r.customs.delete(key);
    await r.live.refresh(key);
    assert.equal(Object.hasOwn(r.calls.at(-1).pocket, key), false);
  } finally { await r.cleanup(); }
});

test('LiveVoices: the keys of V with a fallback stay in the tables when the clip goes, a clip sets them, and a key without a fallback still leaves', async () => {
  const fallbackFor = {'v-male': {reference: 'runtime/voice-references/v-male.wav', sha256: sha('v male'), transcript: 'V male words.'}};
  const seen = [];
  const r = await rig({roster: ['judy-alvarez', 'v-male', 'v-female', 'sam-hill'], fallback: key => { seen.push(key); return fallbackFor[key] ?? null; },
    voices: {pocket: {'judy-alvarez': shipped('judy'), 'v-male': fallbackFor['v-male']}, short: {'v-male': fallbackFor['v-male']}, long: {'v-male': fallbackFor['v-male']}},
    shipped: async () => ({pocket: {'judy-alvarez': shipped('judy')}, short: {}, long: {}})});
  try {
    await r.players.set('v-male', clipOf(3), WORDS);
    await r.live.chain;
    const entry = r.players.get('v-male'), clip = {reference: 'runtime/player-voices/v-male.wav', sha256: entry.sha256, transcript: WORDS};
    for (const table of [r.calls.at(-1).pocket, r.calls.at(-1).omni.short, r.calls.at(-1).omni.long]) assert.deepEqual(table['v-male'], clip);
    assert.deepEqual(seen, [], 'a key with a clip does not ask for the fallback');
    await r.players.clear('v-male');
    await r.live.chain;
    const removed = r.calls.at(-1);
    for (const table of [removed.pocket, removed.omni.short, removed.omni.long]) assert.deepEqual(table['v-male'], fallbackFor['v-male'], 'V keeps a voice: the fallback descriptor');
    assert.deepEqual(seen, ['v-male']);
    assert.deepEqual(removed.pocket['judy-alvarez'], shipped('judy'));
    // A key the fallback has nothing for, and a fallback that throws, leave the table as before.
    await r.players.set('v-female', clipOf(4), WORDS);
    await r.players.clear('v-female');
    await r.live.chain;
    assert.equal(Object.hasOwn(r.calls.at(-1).pocket, 'v-female'), false, 'the fallback has no descriptor for it: the key is gone');
    r.live.fallback = () => { throw new Error('no reference'); };
    await r.players.set('sam-hill', clipOf(1), WORDS);
    await r.players.clear('sam-hill');
    await r.live.chain;
    assert.equal(Object.hasOwn(r.calls.at(-1).pocket, 'sam-hill'), false);
  } finally { await r.cleanup(); }
});

test('LiveVoices: without a fallback a key the shipped files lack leaves the table (unchanged), and the fallback is never used for a character the shipped files have', async () => {
  const r = await rig({roster: ['judy-alvarez', 'v-male'], fallback: () => shipped('never'), voices: {pocket: {'judy-alvarez': shipped('judy')}, short: null, long: null}});
  try {
    await r.players.set('judy-alvarez', clipOf(1), WORDS);
    await r.players.clear('judy-alvarez');
    await r.live.chain;
    assert.deepEqual(r.calls.at(-1).pocket['judy-alvarez'], r.tables.pocket['judy-alvarez'], 'the shipped voice wins over the fallback');
  } finally { await r.cleanup(); }
  const plain = await rig({roster: ['v-male']});
  try {
    await plain.players.set('v-male', clipOf(2), WORDS);
    await plain.players.clear('v-male');
    await plain.live.chain;
    assert.equal(Object.hasOwn(plain.calls.at(-1).pocket, 'v-male'), false, 'no fallback option: the old behaviour');
  } finally { await plain.cleanup(); }
});

test('LiveVoices: a clip whose file no longer matches the index is not used, an engine with no voices is left alone, quick saves end as the last says', async () => {
  const r = await rig({voices: {pocket: {'judy-alvarez': shipped('judy')}, short: null, long: undefined}});
  try {
    await r.players.set('judy-alvarez', clipOf(1), WORDS);
    await r.players.set('judy-alvarez', clipOf(2, 9), 'Second words the player typed.');
    await r.live.chain;
    const last = r.calls.at(-1);
    assert.equal(last.pocket['judy-alvarez'].transcript, 'Second words the player typed.');
    assert.equal(last.pocket['judy-alvarez'].sha256, r.players.get('judy-alvarez').sha256);
    assert.deepEqual(last.omni, {}, 'no OmniVoice table: nothing is sent for it');
    // The file is changed behind the store's back: the index and the file disagree, so the clip is not offered to any engine.
    await rm(r.players.path('judy-alvarez'));
    await r.live.refresh('judy-alvarez');
    assert.deepEqual(r.calls.at(-1).pocket['judy-alvarez'], shipped('judy'));
  } finally { await r.cleanup(); }
});

test('shippedVoicesReader reads the unmerged files and never throws', async () => {
  const files = {'p.json': '﻿{"voices": {"a": 1}}', 's.json': '{"nothing": true}', 'bad.json': '{'};
  const read = async file => { if (!(file in files)) throw Object.assign(Error('missing'), {code: 'ENOENT'}); return files[file]; };
  assert.deepEqual(await shippedVoicesReader({pocket: 'p.json', omni: {short: 's.json', long: 'bad.json'}}, {read})(), {pocket: {a: 1}, short: null, long: null});
  assert.deepEqual(await shippedVoicesReader({pocket: 'gone.json'}, {read})(), {pocket: null, short: null, long: null});
  assert.deepEqual(await shippedVoicesReader(undefined, {read})(), {pocket: null, short: null, long: null});
});

// ---- a scripted Pocket worker and the real clients ------------------------------------------------------------------------------

const pocketSettings = voices => ({version: 1, provider: 'pocket', engine: 'pocket-tts', voices,
  runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('live-fixture', key)])),
  model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64), inputIdentity: 'e'.repeat(64), selectedStep: 1500}});

/** A stand-in for bridge/pocket-voice-worker.py: it keeps the table of voices it holds, answers the protocol, and records which reference each reply used. */
function scriptedPocket(settings, {refuseVoices = false} = {}) {
  const table = {...settings.voices}, prepared = [], log = {streams: [], voices: [], prepares: []};
  const spawned = [];
  const lists = () => ({profiles: Object.keys(table).filter(key => !table[key].status), preparedProfiles: [...prepared], unavailableProfiles: {}});
  const spawnImpl = (exe, args) => {
    const owner = args[args.indexOf('--owner') + 1];
    const child = new EventEmitter();
    Object.assign(child, {pid: 700 + spawned.length, kill: () => true, stdout: new PassThrough(), stderr: new PassThrough()});
    const send = frame => child.stdout.write(JSON.stringify({owner, ...frame}) + '\n');
    let streaming = null;
    const handle = request => {
      if (request.op === 'voices') {
        log.voices.push(request);
        if (refuseVoices) { send({op: 'error', id: request.id, message: 'refused', terminal: false, ...lists()}); return; }
        const changed = [];
        for (const [key, descriptor] of Object.entries(request.set ?? {})) { table[key] = descriptor; changed.push(key); }
        for (const key of request.remove ?? []) { delete table[key]; changed.push(key); }
        for (const key of changed) { const at = prepared.indexOf(key); if (at >= 0) prepared.splice(at, 1); }
        send({op: 'voices', id: request.id, changed, ...lists(), referenceHashes: Object.fromEntries(lists().profiles.map(key => [key, table[key].sha256]))});
      } else if (request.op === 'prepare') {
        log.prepares.push(request.profile);
        if (!prepared.includes(request.profile)) prepared.push(request.profile);
        send({op: 'prepared', id: request.id, profile: request.profile, preparationMs: 1, ...lists()});
      } else if (request.op === 'stream') {
        log.streams.push({profile: request.profile, text: request.text, reference: table[request.profile].reference, sha256: table[request.profile].sha256});
        streaming = request;
        const pcm = Buffer.alloc(16); pcm.writeFloatLE(0.1, 0);
        send({op: 'pcm', id: request.id, profile: request.profile, index: 1, offsetFrames: 0, frames: 4, sampleRate: 24000, channels: 1, format: 'f32le',
          pcm: pcm.toString('base64'), yieldMs: 10, copiedReadyMs: 12});
      } else if (request.op === 'ack' && streaming) {
        send({op: 'done', id: streaming.id, profile: streaming.profile, frames: 4, chunks: 1, sampleRate: 24000, channels: 1, preparationMs: 0,
          firstPcmYieldMs: 10, firstPcmCopiedReadyMs: 12, generationMs: 20, ...lists()});
        streaming = null;
      }
    };
    child.stdin = new Writable({write(bytes, encoding, done) { const request = JSON.parse(bytes.toString()); done(); queueMicrotask(() => handle(request)); }});
    spawned.push(child);
    queueMicrotask(() => send({op: 'ready', protocolVersion: 1, engine: 'pocket-tts', device: 'cpu', dtype: 'torch.float32', runtime: 'pytorch', layers: 6,
      decodeSteps: 1, sampleCfg: 1, threads: 2, gpuVramBytes: 0, sourceRevision: '41cbc84af539ea78a804ffca5f9c6edc1a22ce44',
      sourceSha256: 'b86f98955b6c4776bb24a748b321408aba89d3b66f6b911f415ef4f4191a7666', model: settings.model, workerPaths: settings.runtime,
      ...lists(), preparedProfiles: [], referenceHashes: Object.fromEntries(lists().profiles.map(key => [key, table[key].sha256]))}));
    return child;
  };
  return {table, prepared, log, spawnImpl, spawned};
}
const pocketClient = (settings, worker, extra = {}) => new PocketVoice(settings, {project: process.cwd(), configPath: resolve('live-fixture/config.json'),
  pythonExecutable: resolve('live-fixture/python.exe'), spawnImpl: worker.spawnImpl, ...extra});

test('Pocket client: a voice change is sent as the difference only, behind the job in hand, and the other voices keep what was prepared', async () => {
  const settings = pocketSettings({'judy-alvarez': shipped('judy'), 'sam-hill': shipped('sam')});
  const worker = scriptedPocket(settings), client = pocketClient(settings, worker);
  await client.start();
  await client.prepareProfile('judy-alvarez'); await client.prepareProfile('sam-hill');
  assert.deepEqual(worker.prepared, ['judy-alvarez', 'sam-hill']);
  const folder = resolve('live-player-data', 'player-voices');
  const clip = {reference: 'runtime/player-voices/judy-alvarez.wav', sha256: 'c'.repeat(64), transcript: WORDS};
  // A reply is in flight: the change waits for it.
  const packets = []; let release;
  const reply = client.synthesizeStream('judy-alvarez', 'A reply in flight.', {onPcm: async packet => { packets.push(packet); await new Promise(done => { release = done; }); }});
  await tick(); await tick();
  const change = client.setVoices({...settings.voices, 'judy-alvarez': clip}, {playerVoiceDirectory: folder});
  await tick();
  assert.equal(worker.log.voices.length, 0, 'not sent while the reply is being spoken');
  release(); await reply; await change;
  assert.equal(worker.log.streams[0].sha256, sha('shipped judy'), 'the reply in flight kept the voice it started with');
  assert.equal(worker.log.voices.length, 1);
  assert.deepEqual(worker.log.voices[0].set, {'judy-alvarez': clip});
  assert.deepEqual(worker.log.voices[0].remove, []);
  assert.equal(worker.log.voices[0].playerVoiceDirectory, folder);
  assert.deepEqual(worker.prepared, ['sam-hill'], 'only the changed character lost its prepared voice');
  assert.equal(client.hasProfile('judy-alvarez'), true);
  assert.equal(client.registry.profiles['judy-alvarez'].reference, clip.reference);
  assert.equal(client.registry.profiles['sam-hill'].sha256, sha('shipped sam'));
  // The next reply uses the clip. The same change again sends nothing.
  await client.synthesizeStream('judy-alvarez', 'The next line.', {onPcm: () => {}});
  assert.equal(worker.log.streams.at(-1).sha256, 'c'.repeat(64));
  assert.equal(await client.setVoices({...settings.voices, 'judy-alvarez': clip}, {playerVoiceDirectory: folder}), false);
  assert.equal(worker.log.voices.length, 1);
  // Removing the clip sends the shipped descriptor back, without the folder again.
  assert.equal(await client.setVoices(settings.voices, {playerVoiceDirectory: folder}), true);
  assert.deepEqual(worker.log.voices[1].set, {'judy-alvarez': settings.voices['judy-alvarez']});
  assert.equal(worker.log.voices[1].playerVoiceDirectory, undefined);
  await client.synthesizeStream('judy-alvarez', 'And back.', {onPcm: () => {}});
  assert.equal(worker.log.streams.at(-1).sha256, sha('shipped judy'));
  assert.equal(worker.table['sam-hill'].sha256, sha('shipped sam'));
  const closing = client.close(); worker.spawned[0].emit('close', 0); await closing;
});

test('Pocket client: a character with no voice yet gets one, and a key that leaves the table is removed at the worker', async () => {
  const settings = pocketSettings({'judy-alvarez': shipped('judy')});
  const worker = scriptedPocket(settings), client = pocketClient(settings, worker);
  await client.start();
  const clip = {reference: 'runtime/player-voices/custom-rebecca-abcd.wav', sha256: 'e'.repeat(64), transcript: WORDS};
  assert.equal(client.hasProfile('custom-rebecca-abcd'), false);
  await client.setVoices({...settings.voices, 'custom-rebecca-abcd': clip}, {playerVoiceDirectory: resolve('live-player-data', 'player-voices')});
  assert.equal(client.hasProfile('custom-rebecca-abcd'), true);
  await client.synthesizeStream('custom-rebecca-abcd', 'Hello.', {onPcm: () => {}});
  assert.equal(worker.log.streams[0].sha256, 'e'.repeat(64));
  await client.setVoices(settings.voices);
  assert.deepEqual(worker.log.voices.at(-1).remove, ['custom-rebecca-abcd']);
  assert.equal(client.hasProfile('custom-rebecca-abcd'), false);
  assert.equal(client.hasProfile('judy-alvarez'), true);
  const closing = client.close(); worker.spawned[0].emit('close', 0); await closing;
});

test('Pocket client: a refused change leaves the voices as they were, and a change made while the worker loads is sent before the start is done', async () => {
  const settings = pocketSettings({'judy-alvarez': shipped('judy')});
  const refusing = scriptedPocket(settings, {refuseVoices: true}), first = pocketClient(settings, refusing);
  await first.start();
  const clip = {reference: 'runtime/player-voices/judy-alvarez.wav', sha256: 'c'.repeat(64), transcript: WORDS};
  await assert.rejects(first.setVoices({'judy-alvarez': clip}, {playerVoiceDirectory: resolve('live-player-data', 'player-voices')}), /could not be changed/);
  assert.equal(first.registry.profiles['judy-alvarez'].sha256, sha('shipped judy'));
  assert.equal(first.hasProfile('judy-alvarez'), true);
  let closing = first.close(); refusing.spawned[0].emit('close', 0); await closing;
  // Not started yet: the change is kept and sent when the worker is ready, ahead of any reply.
  const worker = scriptedPocket(settings), second = pocketClient(settings, worker);
  assert.equal(await second.setVoices({'judy-alvarez': clip}, {playerVoiceDirectory: resolve('live-player-data', 'player-voices')}), false);
  await second.start();
  assert.equal(worker.log.voices.length, 1, 'sent before start() resolved');
  assert.equal(second.registry.profiles['judy-alvarez'].sha256, 'c'.repeat(64));
  await second.synthesizeStream('judy-alvarez', 'First line.', {onPcm: () => {}});
  assert.equal(worker.log.streams[0].sha256, 'c'.repeat(64));
  closing = second.close(); worker.spawned[0].emit('close', 0); await closing;
});

// ---- the whole chain on Pocket: save, remove, other characters ------------------------------------------------------------------

function chain(settings, worker, extra = {}) {
  const voice = new VoiceSelection(settings, {project: process.cwd(), configPath: resolve('live-fixture/config.json'), pythonExecutable: resolve('live-fixture/python.exe'),
    spawnImpl: worker.spawnImpl, aliases: key => key.startsWith('custom-') ? 'resident-male' : null, ...extra});
  return voice;
}

test('whole chain (Pocket): saving a clip makes the very next line use it, removing it brings the shipped voice back, other characters are untouched', async () => {
  const settings = pocketSettings({'judy-alvarez': shipped('judy'), 'sam-hill': shipped('sam')});
  const worker = scriptedPocket(settings);
  const voice = chain(settings, worker);
  const r = await rig({voices: {pocket: settings.voices, short: null, long: null}, apply: update => voice.setVoices(update)});
  try {
    voice.request({voiceProvider: 'pocket'}); voice.applyWhenIdle(false);
    await voice.start();
    await voice.prepareProfile('judy-alvarez'); await voice.prepareProfile('sam-hill');
    await voice.synthesizeStream('judy-alvarez', 'Before.', {onPcm: () => {}});
    assert.equal(worker.log.streams.at(-1).sha256, sha('shipped judy'));
    await r.players.set('judy-alvarez', clipOf(1), WORDS);
    await r.live.chain; await tick(); await tick();
    const entry = r.players.get('judy-alvarez');
    await voice.synthesizeStream('judy-alvarez', 'After the save.', {onPcm: () => {}});
    assert.equal(worker.log.streams.at(-1).sha256, entry.sha256, 'the next line is spoken with the clip');
    assert.equal(worker.log.streams.at(-1).reference, 'runtime/player-voices/judy-alvarez.wav');
    // Only that character was sent and only that character was prepared again.
    assert.equal(worker.log.voices.length, 1);
    assert.deepEqual(Object.keys(worker.log.voices[0].set), ['judy-alvarez']);
    assert.ok(worker.prepared.includes('sam-hill'));
    assert.equal(worker.log.prepares.filter(key => key === 'sam-hill').length, 1, 'sam-hill was not prepared again');
    assert.equal(worker.table['sam-hill'].sha256, sha('shipped sam'));
    await voice.synthesizeStream('sam-hill', 'Somebody else.', {onPcm: () => {}});
    assert.equal(worker.log.streams.at(-1).sha256, sha('shipped sam'));
    // Removed: the shipped voice again.
    await r.players.clear('judy-alvarez');
    await r.live.chain; await tick(); await tick();
    await voice.synthesizeStream('judy-alvarez', 'After the removal.', {onPcm: () => {}});
    assert.equal(worker.log.streams.at(-1).sha256, sha('shipped judy'), 'the shipped voice is back');
    assert.equal(worker.log.streams.at(-1).reference, 'runtime/voice-references/judy.wav');
    assert.equal(worker.spawned.length, 1, 'the worker was never restarted');
    const closing = voice.close(); await tick(); worker.spawned.forEach(child => child.emit('close', 0)); await closing;
  } finally { await r.cleanup(); }
});

test('whole chain (Pocket): a change made while a reply is in flight waits for the idle moment, and a character made later gets its voice', async () => {
  const settings = pocketSettings({'judy-alvarez': shipped('judy')});
  const worker = scriptedPocket(settings);
  const voice = chain(settings, worker);
  const key = 'custom-rebecca-abcd';
  const r = await rig({customs: [key], roster: ['judy-alvarez'], voices: {pocket: settings.voices, short: null, long: null}, apply: update => voice.setVoices(update)});
  try {
    voice.request({voiceProvider: 'pocket'}); voice.applyWhenIdle(false);
    await voice.start();
    assert.equal(voice.usesProfile(key), false);
    assert.equal(voice.voiceOf(key), 'resident-male', 'before the clip the voice of its gender speaks it');
    voice.update({voiceProvider: 'pocket'}, null, true);   // a reply is in flight
    await r.players.set(key, clipOf(2), WORDS);
    await r.live.chain; await tick();
    assert.equal(voice.voicesPending, true, 'held back while the reply is in flight');
    assert.equal(worker.log.voices.length, 0);
    assert.equal(voice.voiceOf(key), 'resident-male');
    assert.equal(voice.update({voiceProvider: 'pocket'}, null, true), false);
    assert.equal(voice.voicesPending, true);
    assert.equal(voice.update({voiceProvider: 'pocket'}, null, false), true, 'applied at the first idle poll (the bridge then drops its prefetched replies)');
    assert.equal(voice.voicesPending, false);
    await tick(); await tick();
    voice.update({voiceProvider: 'pocket'}, null, false);   // the standard availability commit
    assert.equal(voice.voiceOf(key), key);
    assert.equal(voice.usesProfile(key), true);
    assert.ok(voice.routeKeys.includes(key));
    await voice.synthesizeStream(key, 'Hello from Rebecca.', {onPcm: () => {}});
    assert.equal(worker.log.streams.at(-1).sha256, r.players.get(key).sha256);
    // The character is deleted: its clip goes, and it speaks with the voice of its gender again at once.
    r.customs.delete(key);
    await r.players.clear(key);
    await r.live.chain; await tick(); await tick();
    voice.update({voiceProvider: 'pocket'}, null, false);
    assert.equal(voice.voiceOf(key), 'resident-male');
    assert.equal(worker.table[key], undefined);
    const closing = voice.close(); await tick(); worker.spawned.forEach(child => child.emit('close', 0)); await closing;
  } finally { await r.cleanup(); }
});

// ---- the OmniVoice client ---------------------------------------------------------------------------------------------------------

const omniSettings = voices => ({version: 2, provider: 'hybrid', engine: 'omnivoice', steps: 16, voices, preparation: {mode: 'lazy', startupProfiles: [], maxCachedProfiles: 4}});
const hashesOf = (table, field) => Object.fromEntries(Object.entries(table).filter(([, value]) => !value.status).map(([key, value]) => [key,
  field === 'transcript' ? createHash('sha256').update(value.transcript, 'utf8').digest('hex') : value.sha256]));

/** A stand-in for bridge/resident-voice-worker.py (protocol 2). */
function scriptedOmni(settings) {
  const table = {...settings.voices}, prepared = [], log = {synths: [], voices: [], prepares: []}, spawned = [];
  const ready = () => Object.keys(table).filter(key => !table[key].status);
  const spawnImpl = () => {
    const child = new EventEmitter();
    Object.assign(child, {pid: 900 + spawned.length, kill: () => true, stdout: new PassThrough(), stderr: new PassThrough()});
    const send = frame => child.stdout.write(JSON.stringify(frame) + '\n');
    const handle = request => {
      if (request.op === 'voices') {
        log.voices.push(request);
        const changed = [];
        for (const [key, descriptor] of Object.entries(request.set ?? {})) { table[key] = descriptor; changed.push(key); }
        for (const key of request.remove ?? []) { delete table[key]; changed.push(key); }
        for (const key of changed) { const at = prepared.indexOf(key); if (at >= 0) prepared.splice(at, 1); }
        send({op: 'voices', id: request.id, changed, profiles: ready(), preparedProfiles: [...prepared], referenceHashes: hashesOf(table), transcriptHashes: hashesOf(table, 'transcript')});
      } else if (request.op === 'prepare') {
        log.prepares.push(request.profile);
        if (!prepared.includes(request.profile)) prepared.push(request.profile);
        send({op: 'prepared', id: request.id, profile: request.profile, generationMs: 5, preparedProfiles: [...prepared]});
      } else if (request.op === 'synthesize') {
        log.synths.push({profile: request.profile, sha256: table[request.profile].sha256, reference: table[request.profile].reference});
        send({op: 'audio', id: request.id, profile: request.profile, steps: request.steps, audio: silentWav().toString('base64'), generationMs: 9, preparedProfiles: [...prepared]});
      }
    };
    child.stdin = new Writable({write(bytes, encoding, done) { const request = JSON.parse(bytes.toString()); done(); queueMicrotask(() => handle(request)); }});
    spawned.push(child);
    queueMicrotask(() => send({op: 'ready', protocolVersion: 2, profiles: ready(), preparedProfiles: [], referenceHashes: hashesOf(table), transcriptHashes: hashesOf(table, 'transcript'),
      device: 'cuda:0', dtype: 'torch.float16', runtime: 'pytorch', tensorrt: false, compiled: false}));
    return child;
  };
  return {table, prepared, log, spawnImpl, spawned};
}

test('OmniVoice client: a voice change goes to the running worker as the difference only, in line behind the job in hand', async () => {
  const settings = omniSettings({'judy-alvarez': shipped('judy'), 'sam-hill': shipped('sam')});
  const worker = scriptedOmni(settings);
  const client = new ResidentVoice(settings, {project: process.cwd(), configPath: 'local-config.json', spawnImpl: worker.spawnImpl});
  await client.start();
  await client.prepareProfile('judy-alvarez'); await client.prepareProfile('sam-hill');
  assert.deepEqual(worker.prepared, ['judy-alvarez', 'sam-hill']);
  const clip = {reference: 'runtime/player-voices/judy-alvarez.wav', sha256: 'c'.repeat(64), transcript: WORDS};
  const folder = resolve('live-player-data', 'player-voices');
  await client.synthesize('judy-alvarez', 'Before.');
  assert.equal(worker.log.synths.at(-1).sha256, sha('shipped judy'));
  assert.equal(await client.setVoices({...settings.voices, 'judy-alvarez': clip}, {playerVoiceDirectory: folder}), true);
  assert.deepEqual(worker.log.voices[0].set, {'judy-alvarez': clip});
  assert.equal(worker.log.voices[0].playerVoiceDirectory, folder);
  assert.deepEqual(worker.prepared, ['sam-hill'], 'only that character lost its prompt');
  await client.synthesize('judy-alvarez', 'After the save.');
  assert.equal(worker.log.synths.at(-1).sha256, 'c'.repeat(64));
  assert.equal(worker.log.prepares.filter(key => key === 'sam-hill').length, 1);
  assert.equal(await client.setVoices({...settings.voices, 'judy-alvarez': clip}, {playerVoiceDirectory: folder}), false, 'nothing to send');
  await client.setVoices(settings.voices, {playerVoiceDirectory: folder});
  await client.synthesize('judy-alvarez', 'After the removal.');
  assert.equal(worker.log.synths.at(-1).sha256, sha('shipped judy'));
  assert.equal(worker.spawned.length, 1);
  const closing = client.close(); worker.spawned[0].emit('close', 0); await closing;
});

test('OmniVoice client: a change made before the worker is ready is sent before the start is done', async () => {
  const settings = omniSettings({'judy-alvarez': shipped('judy')});
  const worker = scriptedOmni(settings);
  const client = new ResidentVoice(settings, {project: process.cwd(), configPath: 'local-config.json', spawnImpl: worker.spawnImpl});
  const clip = {reference: 'runtime/player-voices/judy-alvarez.wav', sha256: 'c'.repeat(64), transcript: WORDS};
  await client.setVoices({'judy-alvarez': clip}, {playerVoiceDirectory: resolve('live-player-data', 'player-voices')});
  await client.start();
  assert.equal(worker.log.voices.length, 1);
  await client.synthesize('judy-alvarez', 'First line.');
  assert.equal(worker.log.synths[0].sha256, 'c'.repeat(64));
  const closing = client.close(); worker.spawned[0].emit('close', 0); await closing;
});

// ---- the cloud voices ----------------------------------------------------------------------------------------------------------

async function cloudStub() {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, {'content-type': 'text/event-stream'});
      const pcm = Buffer.alloc(4800 * 4);
      response.write(`event: speech.audio.delta\ndata: ${JSON.stringify({type: 'speech.audio.delta', audio_data: pcm.toString('base64')})}\n\n`);
      response.end(`event: speech.audio.done\ndata: ${JSON.stringify({type: 'speech.audio.done', usage: {prompt_tokens: 1, completion_tokens: 1}})}\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {requests, endpoint: `http://127.0.0.1:${server.address().port}/v1/audio/speech`, close: () => { server.closeAllConnections?.(); return new Promise(done => server.close(done)); }};
}

test('whole chain (Voxtral): the very next request sends the new clip, removing it sends the shipped one, other characters keep their reference', async () => {
  const stub = await cloudStub();
  const shippedBytes = {judy: Buffer.from(clipOf(9, 5)), sam: Buffer.from(clipOf(8, 7))};
  const descriptors = {'judy-alvarez': {reference: 'runtime/voice-references/judy.wav', sha256: sha(shippedBytes.judy), transcript: 'Shipped judy.'},
    'sam-hill': {reference: 'runtime/voice-references/sam.wav', sha256: sha(shippedBytes.sam), transcript: 'Shipped sam.'}};
  const r = await rig({voices: {pocket: null, short: null, long: descriptors}, shipped: async () => ({long: descriptors})});
  const voxtral = new VoxtralVoice({getKey: () => 'k'.repeat(8) + 'Secret0123456789abcdefghijkl', referenceRoot: resolve('live-references'), playerRoot: r.players.folder,
    endpoint: stub.endpoint, scheduler: new MistralScheduler({spacingMs: 0}),
    read: async path => {
      if (path.endsWith('judy.wav') && path.includes('live-references')) return shippedBytes.judy;
      if (path.endsWith('sam.wav') && path.includes('live-references')) return shippedBytes.sam;
      return readFile(path);
    }});
  const omniLong = omniSettings(descriptors);
  const voice = new VoiceSelection({}, {omniConfigs: {short: {}, long: omniLong}, voxtral, aliases: () => null});
  r.live.apply = update => voice.setVoices(update);
  try {
    const spoken = async key => { stub.requests.length = 0; await voxtral.synthesizeStream(key, 'A line to speak.', {onPcm: () => {}}); return Buffer.from(stub.requests.at(-1).ref_audio, 'base64'); };
    assert.deepEqual(await spoken('judy-alvarez'), shippedBytes.judy);
    assert.deepEqual(await spoken('sam-hill'), shippedBytes.sam);
    const samReference = voxtral.references.get('sam-hill');
    await r.players.set('judy-alvarez', clipOf(1, 12), WORDS);
    await r.live.chain;
    const clip = await readFile(r.players.path('judy-alvarez'));
    assert.deepEqual(await spoken('judy-alvarez'), clip, 'the next request sends the player\'s clip');
    assert.equal(voxtral.references.get('sam-hill'), samReference, 'another character\'s cached reference is the same promise as before');
    assert.deepEqual(await spoken('sam-hill'), shippedBytes.sam);
    // Words changed only: the clip is the same, nothing breaks.
    await r.players.setTranscript('judy-alvarez', 'Other words, typed again.');
    await r.live.chain;
    assert.deepEqual(await spoken('judy-alvarez'), clip);
    await r.players.clear('judy-alvarez');
    await r.live.chain;
    assert.deepEqual(await spoken('judy-alvarez'), shippedBytes.judy, 'the shipped voice is back');
    assert.equal(voxtral.references.get('sam-hill'), samReference);
  } finally { await stub.close(); await r.cleanup(); }
});

test('Voxtral: replaceReferences forgets only the changed characters and keeps the registries current', () => {
  const registry = createVoiceProfileRegistry({version: 2, provider: 'hybrid', engine: 'omnivoice', voices: {a: shipped('a'), b: shipped('b')}});
  const voxtral = new VoxtralVoice({getKey: () => null, referenceRoot: resolve('x'), registry});
  voxtral.references.set('a', Promise.resolve({base64: 'a'})); voxtral.references.set('b', Promise.resolve({base64: 'b'}));
  const next = createVoiceProfileRegistry({version: 2, provider: 'hybrid', engine: 'omnivoice', voices: {a: shipped('a'), b: shipped('b'), c: shipped('c')}});
  assert.deepEqual(voxtral.replaceReferences([next], ['a', 'c']), ['a']);
  assert.equal(voxtral.references.has('a'), false);
  assert.equal(voxtral.references.has('b'), true);
  assert.equal(voxtral.hasReference('c'), true, 'the new registry is the one it reads');
  assert.equal(voxtral.hasCachedReference('b'), true);
});

// ---- one place for a player's clips, even with two services around ------------------------------------------------------------------

test('one click is answered by one service: a service with another data folder leaves a click the first one claimed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'live-voices-claim-'));
  const commandPath = join(dir, 'editor-command.json'), statusPath = join(dir, 'editor-status.json');
  let clock = 1_700_000_000_000;
  const opened = [], logged = [];
  const make = async name => {
    const entry = {started: 0, control: null};
    entry.control = await EditorControl.open({server: {start: async () => { entry.started++; return `http://127.0.0.1:1/${name}`; }, stop: async () => {}},
      commandPath, statusPath, now: () => clock, home: name, open: async url => { opened.push(url); }, log: message => logged.push(message)});
    return entry;
  };
  try {
    const installed = await make('0123456789ab'), development = await make('ba9876543210');
    await writeFile(commandPath, JSON.stringify({version: 1, id: 'c1', action: 'open', issuedAt: clock}));
    await installed.control.poll();
    await development.control.poll();
    assert.deepEqual(opened, ['http://127.0.0.1:1/0123456789ab']);
    assert.equal(development.started, 0, 'the second service never started its editor for that click');
    assert.match(logged.join('\n'), /another data folder/);
    assert.deepEqual(JSON.parse(await readFile(statusPath, 'utf8')), {version: 1, id: 'c1', state: 'open', updated: clock, home: '0123456789ab'});
    // The next click is a new id: whichever service is alive answers it.
    clock += 5000;
    await writeFile(commandPath, JSON.stringify({version: 1, id: 'c2', action: 'open', issuedAt: clock}));
    await development.control.poll();
    assert.equal(development.started, 1);
    // A claim that is old (its service is long gone) does not block a click with the same id from another service.
    await writeFile(statusPath, JSON.stringify({version: 1, id: 'c3', state: 'open', updated: clock - 60_000, home: '0123456789ab'}));
    await writeFile(commandPath, JSON.stringify({version: 1, id: 'c3', action: 'open', issuedAt: clock}));
    await installed.control.poll();
    assert.equal(installed.started, 2, 'an old claim is ignored');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the bridge gives the store, the voice workers and the cloud voices one state folder, and tells the voices about every change', async () => {
  const source = await readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /PlayerVoices\.open\(\{dir: stateDirectory,/);
  assert.equal((source.match(/playerRoot: playerVoices\.folder/g) ?? []).length, 2, 'Voxtral and Inworld read the clips from the store\'s folder');
  assert.match(source, /playerVoiceDirectory: playerVoices\.folder/);
  assert.match(source, /onChanged: key =>/);
  assert.match(source, /localVoice\.setVoices\(update\)/);
  assert.match(source, /home: createHash\('sha256'\)\.update\(stateDirectory/);
  // Nothing else builds a clip path or an index path of its own.
  for (const name of ['character-editor.mjs', 'character-editor-server.mjs', 'custom-characters.mjs', 'live-voices.mjs']) {
    const text = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /join\([^)]*player-voices|resolve\([^)]*player-voices\.json/, name);
  }
});
