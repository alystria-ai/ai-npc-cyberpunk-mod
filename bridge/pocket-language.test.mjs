import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {resolve} from 'node:path';
import {PocketVoice, POCKET_SOURCE_REVISION, POCKET_SOURCE_SHA256} from './pocket-voice.mjs';

// The language swap of the Pocket client against a stand-in worker that speaks the protocol: the commands it sends, in what order, what it does with the answers.
const tick = () => new Promise(done => setImmediate(done));
const english = 'johnny-silverhand', french = 'panam-palmer';
const hash = character => character.repeat(64);
const config = () => ({version: 1, provider: 'pocket', engine: 'pocket-tts',
  runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('pocket-fixtures', key)])),
  model: {sha256: hash('a'), configSha256: hash('b'), tokenizerSha256: hash('c'), receiptSha256: hash('d'), inputIdentity: hash('e'), selectedStep: 1500},
  cpu: {threads: 2}, voices: {[english]: {reference: 'runtime/voice-references/johnny.wav', sha256: hash('f'), transcript: 'One native reference line.'}},
  preparation: {startupProfiles: [], maxCachedProfiles: 2}});
const expected = {sha256: hash('1'), tokenizerSha256: hash('2'), configSha256: hash('3')};
const descriptor = key => ({reference: `runtime/voice-references/multilingual/fr/picked/${key}.wav`, sha256: hash('9'), transcript: 'Salut, ca fait longtemps.'});
const pocketLanguage = (tag = 'fr', folder = 'fr', key = french) => ({tag, folder, expected, voices: {[key]: descriptor(key)}});

function clock() {
  const jobs = new Map(); let time = 0, sequence = 0;
  return {now: () => time, set(callback, delay) { const id = ++sequence; jobs.set(id, {callback, at: time + delay}); return id; }, clear: id => jobs.delete(id),
    advance(ms) { const target = time + ms;
      for (;;) { const next = [...jobs].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break; jobs.delete(next[0]); time = next[1].at; next[1].callback(); } time = target; }, pending: () => jobs.size};
}

function harness({timers} = {}) {
  const requests = [], states = [], logs = [];
  const settings = config();
  const child = new EventEmitter(); child.pid = 987; child.kill = () => true;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({write(bytes, encoding, done) { requests.push(JSON.parse(bytes.toString())); done(); }});
  const client = new PocketVoice(settings, {project: process.cwd(), configPath: resolve('pocket-fixtures/config.json'), pythonExecutable: resolve('pocket-fixtures/python.exe'),
    spawnImpl: () => { queueMicrotask(() => ready()); return child; }, onState: state => states.push(state), onLog: line => logs.push(line),
    ...(timers ? {setTimer: timers.set, clearTimer: timers.clear} : {})});
  const send = frame => child.stdout.write(JSON.stringify({owner: client.owner, ...frame}) + '\n');
  const ready = () => send({op: 'ready', protocolVersion: 1, engine: 'pocket-tts', device: 'cpu', dtype: 'torch.float32', runtime: 'pytorch', layers: 6, decodeSteps: 1, sampleCfg: 1,
    threads: 2, gpuVramBytes: 0, sourceRevision: POCKET_SOURCE_REVISION, sourceSha256: POCKET_SOURCE_SHA256, model: settings.model, workerPaths: settings.runtime,
    profiles: [english], preparedProfiles: [], referenceHashes: {[english]: settings.voices[english].sha256}});
  const lastOf = op => requests.filter(row => row.op === op).at(-1);
  // What the worker holds: the English voices, and a language with its voices.
  const worker = {language: null, voices: {}, englishPrepared: []};
  const frames = () => worker.language ? {profiles: Object.keys(worker.voices), preparedProfiles: worker.prepared ?? [], unavailableProfiles: {}, language: worker.language}
    : {profiles: [english], preparedProfiles: worker.englishPrepared, unavailableProfiles: {}, language: null};
  const answerLanguage = (request, extra = {}) => {
    if (request.language === null) { worker.language = null; worker.voices = {}; }
    else if (request.language !== worker.language) { worker.language = request.language; worker.voices = {...request.voices}; worker.prepared = []; }
    else worker.voices = {...worker.voices, ...request.voices};
    send({op: 'language', id: request.id, loadMs: 900, ...frames(), referenceHashes: worker.language ? Object.fromEntries(Object.entries(worker.voices).map(([key, row]) => [key, row.sha256]))
      : {[english]: settings.voices[english].sha256}, ...extra});
  };
  const answerPrepare = request => {
    if (worker.language) worker.prepared = [...new Set([...(worker.prepared ?? []), request.profile])]; else worker.englishPrepared = [...new Set([...worker.englishPrepared, request.profile])];
    send({op: 'prepared', id: request.id, profile: request.profile, preparationMs: 5, ...frames()});
  };
  const pcm = (request, index = 1, offsetFrames = 0) => {
    const bytes = Buffer.alloc(16); [0, .1, -.1, .2].forEach((value, at) => bytes.writeFloatLE(value, at * 4));
    send({op: 'pcm', id: request.id, profile: request.profile, index, offsetFrames, frames: 4, sampleRate: 24000, channels: 1, format: 'f32le', pcm: bytes.toString('base64'), yieldMs: 40, copiedReadyMs: 45});
  };
  const finish = (request, frames_ = 4) => send({op: 'done', id: request.id, profile: request.profile, frames: frames_, chunks: 1, sampleRate: 24000, channels: 1, preparationMs: 0,
    firstPcmYieldMs: 40, firstPcmCopiedReadyMs: 45, generationMs: 110, ...frames()});
  // Answers whatever the client has asked since `from`, like a worker would.
  async function serve(from = 0, {texts = []} = {}) {
    let at = from;
    for (let spins = 0; spins < 40; spins++) {
      await tick();
      while (at < requests.length) {
        const request = requests[at++];
        if (request.op === 'language') answerLanguage(request);
        else if (request.op === 'prepare') answerPrepare(request);
        else if (request.op === 'stream') { texts.push(request.text); pcm(request); await tick(); finish(request); }
      }
    }
  }
  return {client, child, requests, states, logs, send, worker, answerLanguage, answerPrepare, serve, lastOf, settings, frames,
    close: async () => { const closing = client.close(); child.emit('close', 0); await closing; }};
}

test('a reply in Russian: the swap carries the tokenizer name and every hash the worker checks, and the text goes to the worker as written', async () => {
  const h = harness(), texts = [];
  await h.client.start();
  const russian = {sha256: hash('1'), tokenizerName: 'tokenizer.model', tokenizerSha256: hash('2'), configSha256: hash('3'), stressSha256: hash('4')};
  const row = {reference: `runtime/voice-references/multilingual/ru/picked/${french}.wav`, sha256: hash('9'), transcript: 'Привет, давно не виделись.'};
  const reply = h.client.synthesizeStream(french, 'Ночной город сегодня тихий.', {onPcm: () => {}, pocketLanguage: {tag: 'ru', folder: 'ru', expected: russian, voices: {[french]: row}}});
  await h.serve(0, {texts});
  const result = await reply;
  const swap = h.requests[0];
  assert.equal(swap.op, 'language');
  assert.equal(swap.language, 'ru');
  assert.deepEqual(swap.expected, russian, 'the worker is told the tokenizer file and the table to check');
  assert.deepEqual(swap.voices, {[french]: row});
  assert.deepEqual(texts, ['Ночной город сегодня тихий.'], 'the stress marks are added in the worker, not by the bridge');
  assert.equal(result.language, 'ru');
  assert.equal(h.client.language, 'ru');
});

test('a reply in a language: the model is swapped in first, the voice is the pack clip, the text is respelled, and the next reply in it needs no swap', async () => {
  const h = harness(), packets = [], texts = [];
  await h.client.start();
  const first = h.client.synthesizeStream(french, 'Night City est calme ce soir.', {onPcm: packet => packets.push(packet), pocketLanguage: pocketLanguage('it', 'it')});
  await h.serve(0, {texts});
  const result = await first;
  const kinds = h.requests.map(row => row.op).filter(op => op !== 'ack');
  assert.deepEqual(kinds, ['language', 'prepare', 'stream'], 'swap, then the voice, then the reply');
  const swap = h.requests[0];
  assert.equal(swap.language, 'it');
  assert.deepEqual(swap.expected, expected);
  assert.deepEqual(swap.voices, {[french]: descriptor(french)});
  assert.equal(swap.urgent, true, 'a reply waits on it');
  assert.deepEqual(texts, ['Nait Siti est calme ce soir.'], 'Italian: "Night City" is respelled in the text Pocket is given');
  assert.equal(packets.length, 1);
  assert.equal(packets[0].modelSha256, expected.sha256, 'the packets say which model spoke');
  assert.equal(result.modelSha256, expected.sha256);
  assert.equal(result.language, 'it');
  assert.equal(h.client.language, 'it');
  const count = h.requests.length;
  const second = h.client.synthesizeStream(french, 'Un autre.', {onPcm: () => {}, pocketLanguage: pocketLanguage('it', 'it')});
  await h.serve(count);
  await second;
  assert.deepEqual(h.requests.slice(count).map(row => row.op).filter(op => op !== 'ack'), ['prepare', 'stream'], 'the same language is already resident');
  await h.close();
});

test('another voice in the resident language is added without a new swap; another language is a new swap', async () => {
  const h = harness();
  await h.client.start();
  const one = h.client.synthesizeStream(french, 'Salut.', {onPcm: () => {}, pocketLanguage: pocketLanguage()});
  await h.serve(0); await one;
  let count = h.requests.length;
  const two = h.client.synthesizeStream('judy-alvarez', 'Salut.', {onPcm: () => {}, pocketLanguage: pocketLanguage('fr', 'fr', 'judy-alvarez')});
  await h.serve(count); await two;
  const added = h.requests.slice(count);
  assert.equal(added[0].op, 'language', 'the worker is told the new voice');
  assert.equal(added[0].language, 'fr');
  assert.deepEqual(Object.keys(added[0].voices), ['judy-alvarez']);
  count = h.requests.length;
  const german = h.client.synthesizeStream(french, 'Hallo.', {onPcm: () => {}, pocketLanguage: pocketLanguage('de', 'de')});
  await h.serve(count); await german;
  assert.equal(h.requests.slice(count)[0].language, 'de');
  assert.equal(h.client.language, 'de');
  await h.close();
});

test('an English reply after a language swaps the student back; the English path with no language resident sends nothing extra', async () => {
  const h = harness();
  await h.client.start();
  const plain = h.client.synthesizeStream(english, 'English first.', {onPcm: () => {}});
  await h.serve(0); await plain;
  assert.deepEqual(h.requests.map(row => row.op).filter(op => op !== 'ack'), ['prepare', 'stream'], 'no language command for an English reply');
  let count = h.requests.length;
  const spoken = h.client.synthesizeStream(french, 'Salut.', {onPcm: () => {}, pocketLanguage: pocketLanguage()});
  await h.serve(count); await spoken;
  count = h.requests.length;
  const back = h.client.synthesizeStream(english, 'English again.', {onPcm: () => {}});
  await h.serve(count); await back;
  const sent = h.requests.slice(count);
  assert.deepEqual(sent.map(row => row.op).filter(op => op !== 'ack'), ['language', 'prepare', 'stream']);
  assert.equal(sent[0].language, null);
  assert.equal(sent[0].urgent, true, 'the English swap a reply waits for runs at normal priority, like the language one');
  assert.equal(h.client.language, null);
  await h.close();
});

test('the last language used stays loaded: no timer swaps it back, however long nothing is said', async () => {
  const timers = clock();
  const h = harness({timers});
  await h.client.start();
  const spoken = h.client.synthesizeStream(french, 'Salut.', {onPcm: () => {}, pocketLanguage: pocketLanguage()});
  await h.serve(0); await spoken;
  const count = h.requests.length;
  timers.advance(3 * 60 * 60 * 1000);
  await tick();
  assert.equal(h.requests.length, count, 'nothing was sent in three hours');
  assert.equal(h.client.language, 'fr');
  await h.close();
});

test('warming an English voice that is already prepared does not swap the language out; one that is not prepared does', async () => {
  const h = harness();
  await h.client.start();
  const prepared = h.client.prepareProfile(english);
  await h.serve(0); await prepared;
  let count = h.requests.length;
  const spoken = h.client.synthesizeStream(french, 'Salut.', {onPcm: () => {}, pocketLanguage: pocketLanguage()});
  await h.serve(count); await spoken;
  assert.equal(h.client.language, 'fr');
  count = h.requests.length;
  const warm = await h.client.prepareProfile(english);
  assert.equal(h.requests.length, count, 'the English voice is still prepared in the worker: nothing is asked');
  assert.equal(warm.provider, 'pocket');
  assert.equal(h.client.language, 'fr');
  await h.close();
});

test('while a language is resident an English warm-up swaps nothing, and a voice prepared in the language view counts as ready', async () => {
  const h = harness();
  await h.client.start();
  const spoken = h.client.synthesizeStream(french, 'Salut.', {onPcm: () => {}, pocketLanguage: pocketLanguage()});
  await h.serve(0); await spoken;
  assert.equal(h.client.residentLanguage, 'fr');
  const count = h.requests.length;
  // nearby warm-up, composer: the English voice is not prepared, but the French model stays (no swap out, no swap back, no hash of the model again)
  const warm = await h.client.prepareProfile(english);
  assert.equal(h.requests.length, count, 'nothing is sent to the worker');
  assert.equal(warm.ready, false); assert.equal(warm.deferred, true);
  assert.equal(h.client.language, 'fr');
  // a character prepared through the language view is ready for an invitation, and asking for it again sends nothing
  assert.equal(h.client.profileReady(french), true);
  const again = await h.client.prepareProfile(french, {required: true});
  assert.equal(again.ready, true); assert.equal(h.requests.length, count);
  // a caller that cannot go on without the English voice (an invitation of a character with no clip in the language's pack) still gets it
  const needed = h.client.prepareProfile(english, {required: true});
  await h.serve(count); const receipt = await needed;
  assert.equal(receipt.ready, true);
  assert.deepEqual(h.requests.slice(count).map(row => row.op), ['language', 'prepare']);
  assert.equal(h.requests[count].language, null);
  await h.close();
});

test('prepareLanguage swaps the model in and prepares the voice ahead of the reply, urgent only when asked', async () => {
  const h = harness();
  await h.client.start();
  const ahead = h.client.prepareLanguage(french, pocketLanguage());
  await h.serve(0);
  const receipt = await ahead;
  assert.deepEqual(h.requests.slice(0).map(row => row.op), ['language', 'prepare']);
  assert.equal(h.requests[0].urgent, undefined);
  assert.equal(receipt.ready, true);
  const turn = h.client.prepareLanguage(french, pocketLanguage('it', 'it'), {urgent: true});
  await h.serve(2); await turn;
  assert.equal(h.requests.find(row => row.op === 'language' && row.language === 'it').urgent, true, 'a turn-start swap a reply waits for is urgent');
  assert.equal(receipt.language, 'fr');
  assert.equal((await h.client.prepareLanguage(french, null)).ready, false);
  await h.close();
});

test('a language the worker refuses leaves the English student, rejects the reply as refused and says why; the next reply is not blocked', async () => {
  const h = harness();
  await h.client.start();
  const spoken = h.client.synthesizeStream(french, 'Salut.', {onPcm: () => {}, pocketLanguage: pocketLanguage()});
  const failure = assert.rejects(spoken, error => error.refused === true && error.pocketLanguage === 'fr' && /could not be loaded \(ValueError: PocketTTS model asset differs/.test(error.message));
  await tick(); await tick();
  const request = h.lastOf('language');
  h.send({op: 'error', id: request.id, message: 'PocketTTS model could not be loaded.', terminal: false, reason: 'ValueError: PocketTTS model asset differs from its identity',
    ...h.frames()});
  await failure;
  assert.equal(h.client.language, null);
  const count = h.requests.length;
  const next = h.client.synthesizeStream(english, 'English still works.', {onPcm: () => {}});
  await h.serve(count); await next;
  assert.deepEqual(h.requests.slice(count).map(row => row.op).filter(op => op !== 'ack'), ['prepare', 'stream'], 'the student was never left');
  await h.close();
});

test('an answer that names another language than the one asked for is a protocol failure', async () => {
  const h = harness();
  await h.client.start();
  const spoken = h.client.synthesizeStream(french, 'Salut.', {onPcm: () => {}, pocketLanguage: pocketLanguage()});
  const failure = assert.rejects(spoken);
  await tick(); await tick();
  const request = h.lastOf('language');
  h.send({op: 'language', id: request.id, loadMs: 1, profiles: [french], preparedProfiles: [], unavailableProfiles: {}, language: 'de', referenceHashes: {[french]: hash('9')}});
  await failure;
});

test('hashes the worker confirms must be the ones sent', async () => {
  const h = harness();
  await h.client.start();
  const spoken = h.client.synthesizeStream(french, 'Salut.', {onPcm: () => {}, pocketLanguage: pocketLanguage()});
  const failure = assert.rejects(spoken);
  await tick(); await tick();
  const request = h.lastOf('language');
  h.send({op: 'language', id: request.id, loadMs: 1, profiles: [french], preparedProfiles: [], unavailableProfiles: {}, language: 'fr', referenceHashes: {[french]: hash('0')}});
  await failure;
});

test('a worker that exits forgets its language; a reply needs a valid language description', async () => {
  const h = harness();
  await h.client.start();
  const spoken = h.client.synthesizeStream(french, 'Salut.', {onPcm: () => {}, pocketLanguage: pocketLanguage()});
  await h.serve(0); await spoken;
  assert.equal(h.client.language, 'fr');
  assert.equal(h.client.publish && h.states.at(-1).language, 'fr', 'the voice state says which language is resident');
  await h.close();
  assert.equal(h.client.language, null);
  await assert.rejects(h.client.synthesizeStream(french, 'Salut.', {onPcm: () => {}, pocketLanguage: pocketLanguage()}));
});

test('text that is empty, oversized or has control characters is refused before any swap', async () => {
  const h = harness();
  await h.client.start();
  for (const text of ['', '   ', 'a\u0000b', 'x'.repeat(12_001)]) await assert.rejects(h.client.synthesizeStream(french, text, {onPcm: () => {}, pocketLanguage: pocketLanguage()}), /valid reply text/);
  assert.equal(h.requests.length, 0, 'nothing was sent');
  await h.close();
});
