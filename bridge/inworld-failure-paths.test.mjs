// Failure paths of the Inworld cloud voice (bridge/inworld-voice.mjs) that inworld-voice.test.mjs does not pin: a clone that answers badly,
// a voice list that fails or never ends, a saved-voices file that is garbage or cannot be written, an error line that says the plan is used
// up, a stream that goes quiet or has no audio, and a clone that is refused with the key.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {InworldVoice, InworldError, INWORLD_LIMITS} from './inworld-voice.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {LOCAL_VOICE_KEYS} from './resident-voice.mjs';
import {manualTimers, track, until} from './fixtures/test-waits.mjs';

// A Base64 text of the shape the Inworld portal copies (never a real key).
const KEY = Buffer.from('test-key-id-0123456789:test-key-secret-abcdefghijklmnopqrstuvwxyz').toString('base64');
const wait = ms => new Promise(finish => setTimeout(finish, ms));
const ints = (count, offset = 0) => Int16Array.from({length: count}, (_, at) => Math.round(Math.sin((at + offset) / 37) * 12000));
const bytesOf = values => Buffer.from(values.buffer, values.byteOffset, values.byteLength);
const line = bytes => JSON.stringify({result: {audioContent: bytes.toString('base64')}}) + '\n';
const REFERENCE = {base64: Buffer.from('pretend wav bytes of a reference clip').toString('base64'), bytes: 4000, source: 'omni-long', format: 'wav'};
const library = () => ({async reference() { return REFERENCE; }, setReferences() {}, hasReference: () => true});
const json = (response, status, value) => { response.writeHead(status, {'content-type': 'application/json'}); response.end(typeof value === 'string' ? value : JSON.stringify(value)); };

async function serve(handlers = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* none */ }
      const url = new URL(request.url, 'http://x');
      const record = {method: request.method, path: url.pathname, query: url.searchParams, headers: request.headers, body};
      requests.push(record);
      record.closed = false;
      response.on('close', () => { record.closed = true; });
      try {
        const handler = handlers[`${request.method} ${url.pathname}`];
        if (handler) return await handler(request, response, record);
        if (request.method === 'GET' && url.pathname === '/voices') return json(response, 200, {voices: [], nextPageToken: ''});
        if (request.method === 'POST' && url.pathname === '/clone') return json(response, 200, {voice: {voiceId: `ws__${body.displayName}`}});
        if (request.method === 'POST' && url.pathname === '/speech') { response.writeHead(200); response.write(line(bytesOf(ints(4800)))); return response.end(); }
        response.writeHead(404); response.end('{}');
      } catch { response.destroy(); }
    });
  });
  await new Promise(finish => server.listen(0, '127.0.0.1', finish));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {requests, endpoints: {speech: `${base}/speech`, clone: `${base}/clone`, voices: `${base}/voices`},
    count: (method, path) => requests.filter(item => item.method === method && item.path === path).length,
    close: () => { server.closeAllConnections?.(); return new Promise(finish => server.close(finish)); }};
}

function voiceFor(server, extra = {}) {
  const store = {text: extra.saved ?? null, writes: []};
  const logs = [];
  const voice = new InworldVoice({getKey: () => KEY, library: library(), storePath: 'voices.json', endpoints: server.endpoints, onLog: text => logs.push(text),
    readText: async () => { if (store.text === null) throw Error('missing'); return store.text; },
    writeText: async (path, text) => { if (store.failWrite) throw Error('ENOSPC'); store.text = text; store.writes.push(text); }, ...extra});
  return {voice, store, logs};
}
const collect = () => { const packets = []; return {packets, onPcm: packet => { packets.push(packet); }}; };

// ---- the clone ----------------------------------------------------------------------------------------------------------------------------

test('a clone that comes back with no voice says why when it can, is not repeated for ten minutes, and is a written reply that leaves the speech voice running', async () => {
  const answers = [{audioSamplesValidated: [{errors: [{text: 'the sample is too noisy'}], warnings: []}]}, 'this is not json', {voice: {}}];
  let step = 0;
  const server = await serve({'POST /clone': (request, response) => json(response, 200, answers[Math.min(step++, answers.length - 1)])});
  try {
    let clock = 9_000_000;
    const {voice} = voiceFor(server, {clock: () => clock});
    const first = await voice.synthesizeStream('judy-alvarez', 'Hello V.', collect()).catch(caught => caught);
    assert.ok(first instanceof InworldError);
    assert.equal(first.kind, 'voice');
    assert.match(first.message, /did not accept the clip: the sample is too noisy/);
    assert.equal(voice.degraded, null, 'a voice that is not made yet is that reply\'s problem');
    assert.equal(voice.ready, true, 'speech itself is not paused');
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Again.', collect()), {kind: 'voice'});
    assert.equal(server.count('POST', '/clone'), 1, 'not offered again inside the retry time');
    clock += INWORLD_LIMITS.cloneRetryMs + 1;
    await assert.rejects(voice.ensureVoice('judy-alvarez'), /answered without a voice/);
    clock += INWORLD_LIMITS.cloneRetryMs + 1;
    await assert.rejects(voice.ensureVoice('judy-alvarez'), /answered without a voice/);
    assert.equal(server.count('POST', '/clone'), 3);
    assert.equal(server.count('POST', '/speech'), 0);
  } finally { await server.close(); }
});

test('a clone that fails on the network or with a server fault is tried again after 30 s; a busy answer (429) after 65 s; neither is a refused clip', async () => {
  let mode = 503;
  const server = await serve({'POST /clone': (request, response, record) => mode === 'down' ? response.destroy()
    : mode === 'ok' ? json(response, 200, {voice: {voiceId: 'ws__ok'}}) : json(response, mode, {error: {code: 8, message: 'busy'}})});
  try {
    let clock = 3_000_000;
    const {voice} = voiceFor(server, {clock: () => clock});
    const fault = await voice.ensureVoice('judy-alvarez').catch(caught => caught);
    assert.equal(fault.kind, 'network');
    await assert.rejects(voice.ensureVoice('judy-alvarez'), {kind: 'network'});
    assert.equal(server.count('POST', '/clone'), 1);
    clock += INWORLD_LIMITS.cloneFaultRetryMs - 1;
    await assert.rejects(voice.ensureVoice('judy-alvarez'));
    assert.equal(server.count('POST', '/clone'), 1, 'one millisecond early');
    clock += 2; mode = 'down';
    await assert.rejects(voice.ensureVoice('judy-alvarez'), {kind: 'network'});
    assert.equal(server.count('POST', '/clone'), 2);
    clock += INWORLD_LIMITS.cloneFaultRetryMs + 1; mode = 429;
    const busy = await voice.ensureVoice('judy-alvarez').catch(caught => caught);
    assert.equal(busy.kind, 'limit');
    clock += INWORLD_LIMITS.cloneFaultRetryMs + 1;
    await assert.rejects(voice.ensureVoice('judy-alvarez'), {kind: 'limit'});
    assert.equal(server.count('POST', '/clone'), 3, 'a busy clone endpoint is left alone for 65 s, not 30');
    clock += INWORLD_LIMITS.cloneBusyRetryMs; mode = 'ok';
    assert.equal(await voice.ensureVoice('judy-alvarez'), 'ws__ok');
  } finally { await server.close(); }
});

test('a clone the key is refused for (401) or the plan cannot pay for (402) pauses the speech voice and is named in the log, with no key in it', async () => {
  for (const [status, kind, pause] of [[401, 'key', INWORLD_LIMITS.keyCooldownMs], [402, 'quota', INWORLD_LIMITS.quotaCooldownMs]]) {
    const server = await serve({'POST /clone': (request, response) => json(response, status, {error: {message: `denied for ${KEY}`}})});
    try {
      let clock = 1_000;
      const {voice, logs} = voiceFor(server, {clock: () => clock});
      const error = await voice.synthesizeStream('judy-alvarez', 'Hello V.', collect()).catch(caught => caught);
      assert.equal(error.kind, kind);
      assert.equal(voice.degraded.reason, kind);
      assert.equal(voice.ready, false);
      clock += pause - 10; assert.equal(voice.ready, false);
      clock += 20; assert.equal(voice.ready, true);
      assert.doesNotMatch(`${error.message}\n${logs.join('')}`, new RegExp(KEY.replace(/[+/=]/g, '.')));
      assert.equal(server.count('POST', '/speech'), 0);
    } finally { await server.close(); }
  }
});

// ---- the account's voice list and the saved voices -----------------------------------------------------------------------------------

test('a voice list that fails (server fault, garbage, nothing) never stops a clone; one the key is refused for does', async () => {
  for (const list of [(request, response) => json(response, 500, 'oops'), (request, response) => json(response, 200, 'not json at all'), (request, response) => response.destroy()]) {
    const server = await serve({'GET /voices': list});
    try {
      const {voice} = voiceFor(server);
      assert.equal(await voice.ensureVoice('judy-alvarez'), `ws__${server.requests.find(item => item.path === '/clone')?.body.displayName}`);
      assert.equal(server.count('POST', '/clone'), 1);
    } finally { await server.close(); }
  }
  const refused = await serve({'GET /voices': (request, response) => json(response, 401, {error: {message: 'bad key'}})});
  try {
    const {voice} = voiceFor(refused);
    await assert.rejects(voice.ensureVoice('judy-alvarez'), {kind: 'key'});
    assert.equal(refused.count('POST', '/clone'), 0, 'no clone is sent with a key the list refused');
    assert.equal(voice.degraded.reason, 'key');
    assert.equal(voice.ready, false);
  } finally { await refused.close(); }
});

test('a voice list that never ends is read for eight pages and no more', async () => {
  const server = await serve({'GET /voices': (request, response) => json(response, 200, {voices: [{voiceId: 'ws__other', displayName: 'someone else'}], nextPageToken: `page-${Math.random()}`})});
  try {
    const {voice} = voiceFor(server);
    await voice.ensureVoice('judy-alvarez');
    assert.equal(server.count('GET', '/voices'), INWORLD_LIMITS.listPages);
    assert.equal(server.count('POST', '/clone'), 1, 'the voice was not in the pages that were read, so it is made');
  } finally { await server.close(); }
});

test('a saved-voices file that is garbage, of another version, an array or holds broken entries is no saved voice; one that cannot be written is not an error', async () => {
  for (const saved of ['', 'not json', '[]', 'null', JSON.stringify({version: 2, voices: {'judy-alvarez': {voiceId: 'ws__x', hash: 'h'}}}),
    JSON.stringify({version: 1, voices: {'judy-alvarez': {voiceId: 7, hash: 'h'}}}), JSON.stringify({version: 1, voices: {'judy-alvarez': null}}), JSON.stringify({version: 1, voices: 'x'})]) {
    const server = await serve();
    try {
      const {voice, store} = voiceFor(server, {saved});
      store.failWrite = true;
      const id = await voice.ensureVoice('judy-alvarez');
      assert.match(id, /^ws__cp2077-companion-judy-alvarez-/, JSON.stringify(saved));
      assert.equal(server.count('POST', '/clone'), 1, 'cloned, as nothing usable was saved');
      assert.equal(store.writes.length, 0);
      await voice.synthesizeStream('judy-alvarez', 'Still speaks from memory.', collect());
    } finally { await server.close(); }
  }
});

test('a saved voice for a clip that has since changed is not used: the new clip is looked up and made', async () => {
  const server = await serve();
  try {
    const saved = JSON.stringify({version: 1, voices: {'judy-alvarez': {voiceId: 'ws__old', hash: 'a-hash-of-another-clip', name: 'old'}}});
    const {voice, store} = voiceFor(server, {saved});
    const id = await voice.ensureVoice('judy-alvarez');
    assert.notEqual(id, 'ws__old');
    assert.equal(server.count('POST', '/clone'), 1);
    assert.equal(JSON.parse(store.text).voices['judy-alvarez'].voiceId, id);
  } finally { await server.close(); }
});

// ---- the speech stream ------------------------------------------------------------------------------------------------------------------------

test('an error line that says the plan is used up, before any audio, pauses the voice for the long cool-down; after audio it ends the reply early instead', async () => {
  const quota = await serve({'POST /speech': (request, response) => { response.writeHead(200); response.end(JSON.stringify({error: {code: 8, message: 'Your free credits are used up'}}) + '\n'); }});
  try {
    let clock = 4_000_000;
    const {voice} = voiceFor(quota, {clock: () => clock});
    await voice.ensureVoice('judy-alvarez');
    const error = await voice.synthesizeStream('judy-alvarez', 'Hello V.', collect()).catch(caught => caught);
    assert.equal(error.kind, 'quota');
    clock += INWORLD_LIMITS.quotaCooldownMs - 5; assert.equal(voice.ready, false);
    clock += 10; assert.equal(voice.ready, true);
  } finally { await quota.close(); }
  const late = await serve({'POST /speech': async (request, response) => {
    response.writeHead(200); response.write(line(bytesOf(ints(5000)))); await wait(10);
    response.end(JSON.stringify({error: {code: 8, message: 'Your free credits are used up'}}) + '\n');
  }});
  try {
    const {voice} = voiceFor(late), sink = collect();
    const result = await voice.synthesizeStream('judy-alvarez', 'A longer reply.', sink);
    assert.equal(result.truncated, true);
    assert.equal(result.frames, 5000);
    assert.equal(voice.degraded, null, 'the reply that was heard is not reported as a failure');
    assert.equal(voice.ready, true);
  } finally { await late.close(); }
});

test('a stream that goes quiet after its audio began is cut at the stall limit; a stream with no body, no audio or only noise is an error before any audio', async () => {
  const quiet = await serve({'POST /speech': (request, response) => { response.writeHead(200); response.write(line(bytesOf(ints(5000)))); /* then silence */ }});
  try {
    // The stall limit is a timer of the voice on a manual clock, moved once the audio has been handed on and the voice is waiting for more. The
    // server never writes again, so nothing but the limit can end the reply: it ends when the clock reaches 60 ms, not a moment before.
    const timers = manualTimers();
    const {voice} = voiceFor(quiet, {...timers.hooks, limits: {stallMs: 60}}), sink = collect();
    await voice.ensureVoice('judy-alvarez');
    const call = track(voice.synthesizeStream('judy-alvarez', 'A long reply.', sink));
    await until(() => timers.limits().includes(60), 'the stall limit to be set after the first audio');
    await timers.clock.advance(59);
    assert.equal(call.done, false, 'left open until the stall limit');
    await timers.clock.advance(1);
    await until(() => call.done, 'the reply to end at the stall limit');
    assert.equal(call.error, undefined, String(call.error));
    assert.equal(call.value.truncated, true);
    assert.equal(call.value.frames, 5000);
    await until(() => quiet.requests.find(item => item.path === '/speech')?.closed === true, 'the request to be dropped');
  } finally { await quiet.close(); }
  for (const body of ['', '\n\n', 'noise\nmore noise\n', JSON.stringify({result: {audioContent: ''}}) + '\n', JSON.stringify({result: {usage: {}}}) + '\n']) {
    const empty = await serve({'POST /speech': (request, response) => { response.writeHead(200); response.end(body); }});
    try {
      const {voice} = voiceFor(empty);
      await voice.ensureVoice('judy-alvarez');
      const sink = collect();
      const error = await voice.synthesizeStream('judy-alvarez', 'Hello V.', sink).catch(caught => caught);
      assert.equal(error.kind, 'request', JSON.stringify(body));
      assert.match(error.message, /answered without audio/);
      assert.equal(sink.packets.length, 0);
    } finally { await empty.close(); }
  }
  const noBody = voiceFor({endpoints: {speech: 'http://127.0.0.1:9/speech', clone: 'http://127.0.0.1:9/clone', voices: 'http://127.0.0.1:9/voices'}},
    {saved: JSON.stringify({version: 1, voices: {}}), fetchImpl: async (url) => /clone|voices/.test(url) ? new Response('{"voice":{"voiceId":"ws__x"}}', {status: 200}) : {ok: true, status: 200, headers: new Headers(), body: null}});
  await noBody.voice.ensureVoice('judy-alvarez');
  const error = await noBody.voice.synthesizeStream('judy-alvarez', 'Hello V.', collect()).catch(caught => caught);
  assert.equal(error.kind, 'request');
  assert.match(error.message, /answered without a stream/);
});

test('a key removed or replaced while a clone waits for its slot is not used for that clone: nothing is sent with it', async () => {
  const server = await serve();
  try {
    let key = KEY, clock = 1_000_000;
    const timers = [];
    const {voice} = voiceFor(server, {getKey: () => key, clock: () => clock, setTimer: (fn, ms) => { timers.push({fn, ms}); return {unref() {}}; }, clearTimer() {}});
    // Two clones use the plan's minute; the third waits for a slot.
    const first = [voice.ensureVoice('a-one'), voice.ensureVoice('b-two')];
    await until(() => server.count('POST', '/clone') >= 2, 'the first two clones to be sent');
    const third = voice.ensureVoice('c-three');
    third.catch(() => {});
    await until(() => timers.some(timer => timer.ms > 50_000), 'the third clone to wait for its slot');
    await Promise.all(first);
    key = null;   // the player removed the Inworld key while the third clone waited
    clock += 61_000;
    timers.find(timer => timer.ms > 50_000).fn();
    const error = await third.catch(caught => caught);
    assert.equal(error.kind, 'no-key');
    assert.match(error.message, /key changed while the voice was being made/);
    assert.equal(server.count('POST', '/clone'), 2, 'the third clone was never sent with the old key');
  } finally { await server.close(); }
});

// ---- through the voice selection: each failure is asked for the number of times it can be mended, and no local voice ever stands in ----------------------

const pocketSettings = voices => ({version: 1, provider: 'pocket', engine: 'pocket-tts', voices,
  runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('fixture', key)])),
  model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64),
    inputIdentity: 'e'.repeat(64), selectedStep: 1500}});

function selection(server, extra = {}) {
  const states = [], workers = [];
  const voices = Object.fromEntries(LOCAL_VOICE_KEYS.map(name => [name, {reference: `runtime/voice-references/${name}.wav`, sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.'}]));
  const {voice: cloud} = voiceFor(server, extra);
  const voice = new VoiceSelection(pocketSettings(voices), {inworld: cloud, onState: value => states.push(value), cloudRetryAudioMs: {inworld: 150},
    factory: config => { workers.push(config); throw Error('a cloud voice never creates a local worker'); }});
  return {voice, cloud, states, workers};
}

test('a reply Inworld refuses for a limit, a used-up plan or a refused key is asked once (not mended by asking again), later replies are not sent while it cools down, and nothing local speaks', async () => {
  for (const [status, body, headers, temporary, reason] of [[429, {error: {code: 8, message: 'slow down'}}, {'retry-after': '30'}, true, 'limit'],
    [402, {message: 'insufficient credits'}, {}, false, 'quota'], [401, {error: {message: 'bad key'}}, {}, false, 'key']]) {
    const server = await serve({'POST /speech': (request, response) => { response.writeHead(status, {'content-type': 'application/json', ...headers}); response.end(JSON.stringify(body)); }});
    try {
      const h = selection(server);
      h.voice.update({voiceProvider: 'inworld'}, null, false);
      await h.voice.start();
      await h.cloud.ensureVoice('judy-alvarez');
      await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Hello V.', {onPcm() {}}), {kind: reason});
      assert.equal(server.count('POST', '/speech'), 1, `${status}: one request`);
      await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Hello again.', {onPcm() {}}));
      assert.equal(server.count('POST', '/speech'), 1, `${status}: nothing is sent while it cools down`);
      h.voice.publish();
      const state = h.states.at(-1);
      assert.deepEqual(state.fallback, {from: 'inworld', to: 'convai', temporary, reason}, `${status}: the report says whether it comes back by itself`);
      assert.equal(h.workers.length, 0);
      assert.doesNotMatch(JSON.stringify(state), new RegExp(KEY.replace(/[+/=]/g, '.')));
      await h.voice.close();
    } finally { await server.close(); }
  }
});
