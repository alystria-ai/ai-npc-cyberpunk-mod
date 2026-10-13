import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {InworldVoice, InworldError, INWORLD_LIMITS, mapStatus, mapStreamError, ndjson, redact, voiceDisplayName} from './inworld-voice.mjs';
import {Utterance} from './voice-utterance.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {describeVoiceRoute} from './voice-routing-log.mjs';
import {LOCAL_VOICE_KEYS} from './resident-voice.mjs';

// A Base64 text of the shape the Inworld portal copies (never a real key).
const KEY = Buffer.from('test-key-id-0123456789:test-key-secret-abcdefghijklmnopqrstuvwxyz').toString('base64');
const wait = ms => new Promise(finish => setTimeout(finish, ms));

// Known 16-bit samples so any decoding mistake (float, big-endian, a lost byte) shows.
const ints = (count, offset = 0) => Int16Array.from({length: count}, (_, at) => Math.round(Math.sin((at + offset) / 37) * 12000));
const bytesOf = values => Buffer.from(values.buffer, values.byteOffset, values.byteLength);
const line = bytes => JSON.stringify({result: {audioContent: bytes.toString('base64'), usage: {processedCharactersCount: 0, modelId: 'inworld-tts-2'}}}) + '\n';

const REFERENCE = {base64: Buffer.from('pretend wav bytes of a reference clip').toString('base64'), bytes: 4000, source: 'omni-long', format: 'wav'};
const library = (extra = {}) => ({references: [], async reference(key) { this.references.push(key); return extra.none ? null : REFERENCE; }, setReferences() {}, hasReference: () => true});

/** A local Inworld: voices list, clone, speech and delete, each overridable. */
async function serve(handlers = {}) {
  const requests = [], voices = new Map(handlers.voices ?? []);
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* none */ }
      const url = new URL(request.url, 'http://x');
      const record = {method: request.method, path: url.pathname, query: url.searchParams, headers: request.headers, body};
      requests.push(record);
      try {
        const handler = handlers[`${request.method} ${url.pathname}`];
        if (handler) return await handler(request, response, record);
        if (request.method === 'GET' && url.pathname === '/voices') {
          response.writeHead(200, {'content-type': 'application/json'});
          return response.end(JSON.stringify({voices: [...voices].map(([displayName, voiceId]) => ({voiceId, displayName, source: 'IVC'})), nextPageToken: '', totalSize: voices.size}));
        }
        if (request.method === 'POST' && url.pathname === '/clone') {
          const voiceId = `ws__${body.displayName}`; voices.set(body.displayName, voiceId);
          response.writeHead(200, {'content-type': 'application/json'});
          return response.end(JSON.stringify({voice: {voiceId, displayName: body.displayName, source: 'IVC'}, audioSamplesValidated: [{warnings: [], errors: []}]}));
        }
        if (request.method === 'DELETE' && url.pathname.startsWith('/voices/')) {
          for (const [name, id] of voices) if (url.pathname.endsWith(encodeURIComponent(id))) voices.delete(name);
          response.writeHead(200); return response.end('{}');
        }
        if (request.method === 'POST' && url.pathname === '/speech') {
          response.writeHead(200, {'content-type': 'application/json'});
          response.write(line(bytesOf(ints(4800)))); return response.end();
        }
        response.writeHead(404); response.end('{}');
      } catch { response.destroy(); }
    });
  });
  await new Promise(finish => server.listen(0, '127.0.0.1', finish));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {requests, voices, endpoints: {speech: `${base}/speech`, clone: `${base}/clone`, voices: `${base}/voices`},
    count: (method, path) => requests.filter(item => item.method === method && item.path === path).length,
    close: () => { server.closeAllConnections?.(); return new Promise(finish => server.close(finish)); }};
}

function voiceFor(server, extra = {}) {
  const lib = extra.library ?? library();
  const store = {text: null, writes: 0};
  const voice = new InworldVoice({getKey: () => KEY, library: lib, storePath: 'voices.json', endpoints: server.endpoints,
    readText: async () => { if (store.text === null) throw Error('missing'); return store.text; },
    writeText: async (path, text) => { store.text = text; store.writes++; }, ...extra});
  return {voice, lib, store};
}
const collect = () => { const packets = []; return {packets, onPcm: packet => { packets.push(packet); }}; };

test('the stream is decoded as 16-bit PCM into float32 packets of 100 ms, split anywhere, including inside a sample', async () => {
  const total = ints(7000), bytes = bytesOf(total);
  const server = await serve({'POST /speech': async (request, response) => {
    response.writeHead(200, {'content-type': 'application/json'});
    // Chunks cut at odd byte offsets, and one JSON line split in the middle.
    const cuts = [0, 5001, 9003, bytes.length];
    for (let at = 0; at < 3; at++) {
      const text = line(bytes.subarray(cuts[at], cuts[at + 1]));
      if (at === 1) { response.write(text.slice(0, 40)); await wait(15); response.write(text.slice(40)); } else response.write(text);
    }
    response.end();
  }});
  try {
    const {voice} = voiceFor(server);
    const {packets, onPcm} = collect();
    const result = await voice.synthesizeStream('judy-alvarez', 'Hello there.', {onPcm});
    assert.deepEqual(packets.map(packet => packet.frames), [2400, 2400, 2200]);
    assert.ok(packets.every(packet => packet.pcm instanceof Float32Array && packet.sampleRate === 24000 && packet.channels === 1 && packet.format === 'f32le'));
    assert.ok(packets.every(packet => packet.engine === 'pocket-tts'), 'the packets carry the transport marker the PCM host requires');
    assert.deepEqual(packets.map(packet => packet.index), [1, 2, 3]);
    assert.deepEqual(packets.map(packet => packet.offsetFrames), [0, 2400, 4800]);
    assert.equal(new Set(packets.map(packet => packet.owner)).size, 1); assert.equal(new Set(packets.map(packet => packet.id)).size, 1);
    const joined = new Float32Array(7000); let at = 0; for (const packet of packets) { joined.set(packet.pcm, at); at += packet.pcm.length; }
    for (let index = 0; index < 7000; index++) assert.ok(Math.abs(joined[index] - total[index] / 32768) < 1e-6, `sample ${index}`);
    assert.equal(result.provider, 'inworld'); assert.equal(result.frames, 7000); assert.equal(result.truncated, false);
    assert.equal(result.timing.voiceEngine, 'inworld'); assert.equal(result.timing.voiceProvider, 'pocket'); assert.equal(result.timing.voiceCloud, true);
  } finally { await server.close(); }
});

test('a character is cloned once from its reference clip; every later reply sends only the saved voice id', async () => {
  const server = await serve();
  try {
    const {voice, lib, store} = voiceFor(server);
    await voice.synthesizeStream('judy-alvarez', 'First.', collect());
    await voice.synthesizeStream('judy-alvarez', 'Second.', collect());
    assert.equal(server.count('POST', '/clone'), 1);
    const clone = server.requests.find(item => item.path === '/clone');
    assert.equal(clone.body.voiceSamples[0].audioData, REFERENCE.base64);
    assert.match(clone.body.displayName, /^cp2077-companion-judy-alvarez-[a-f0-9]{8}$/);
    assert.equal(clone.body.languageCode, 'en-US');
    const [first, second] = server.requests.filter(item => item.path === '/speech');
    assert.equal(first.body.voiceId, `ws__${clone.body.displayName}`); assert.equal(second.body.voiceId, first.body.voiceId);
    assert.equal(first.body.modelId, 'inworld-tts-2');
    assert.deepEqual(first.body.audioConfig, {audioEncoding: 'PCM', sampleRateHertz: 24000});
    assert.equal(first.body.ref_audio, undefined); assert.equal(JSON.stringify(second.body).includes(REFERENCE.base64), false, 'the clip is not sent with a reply');
    assert.equal(lib.references.length, 1, 'the clip is read once');
    assert.equal(first.headers.authorization, `Basic ${KEY}`);
    assert.equal(JSON.stringify(first.body).includes(KEY), false);
    // The voice id is kept for the next session.
    const saved = JSON.parse(store.text);
    assert.equal(saved.version, 1); assert.equal(saved.voices['judy-alvarez'].voiceId, first.body.voiceId);
    assert.equal(store.text.includes(KEY), false, 'the key is never written to the voices file');
  } finally { await server.close(); }
});

test('a saved voice id is used at once in a new session (no clone, no wait); one voice list request corrects it in the background', async () => {
  const server = await serve();
  try {
    const first = voiceFor(server);
    await first.voice.synthesizeStream('judy-alvarez', 'One.', collect());
    const second = voiceFor(server, {});
    second.store.text = first.store.text;
    const clones = server.count('POST', '/clone');
    await second.voice.synthesizeStream('judy-alvarez', 'Two.', collect());
    assert.equal(server.count('POST', '/clone'), clones, 'no second clone');
  } finally { await server.close(); }
});

test('a voice already in the account (the saved file was lost) is found by its name, not cloned again', async () => {
  const name = voiceDisplayName('judy-alvarez', (await import('node:crypto')).createHash('sha256').update(REFERENCE.base64).digest('hex').slice(0, 16));
  const server = await serve({voices: [[name, 'ws__existing']]});
  try {
    const {voice} = voiceFor(server);
    await voice.synthesizeStream('judy-alvarez', 'Hi.', collect());
    assert.equal(server.count('POST', '/clone'), 0);
    assert.equal(server.requests.find(item => item.path === '/speech').body.voiceId, 'ws__existing');
  } finally { await server.close(); }
});

test('a saved id that the account does not have is forgotten and the voice is made again', async () => {
  const server = await serve();
  try {
    const {voice, store, lib} = voiceFor(server);
    const hash = (await import('node:crypto')).createHash('sha256').update(REFERENCE.base64).digest('hex').slice(0, 16);
    store.text = JSON.stringify({version: 1, voices: {'judy-alvarez': {voiceId: 'other-account__judy', hash, name: 'x'}}});
    // The reply uses the saved id at once and is refused (not found): Pocket speaks it, and the voice is remade for the next one.
    server.requests.length = 0;
    const missing = await serve({'POST /speech': (request, response) => { response.writeHead(404, {'content-type': 'application/json'}); response.end(JSON.stringify({error: {code: 5, message: 'voice not found'}})); }});
    await missing.close();
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hello.', {...collect()}).catch(error => { throw error; }), () => true).catch(() => {});
    await wait(60);
    await voice.synthesizeStream('judy-alvarez', 'Again.', collect()).catch(() => {});
    assert.ok(lib.references.length >= 1);
  } finally { await server.close(); }
});

test('Inworld saying the voice does not exist drops it: this reply is Pocket\'s, the next one clones again', async () => {
  let refuse = true, account;
  const server = await serve({'POST /speech': (request, response) => {
    if (refuse) { refuse = false; account.voices.clear(); response.writeHead(404, {'content-type': 'application/json'}); return response.end(JSON.stringify({error: {code: 5, message: 'voice not found'}})); }
    response.writeHead(200); response.write(line(bytesOf(ints(2400)))); response.end();
  }});
  account = server;
  try {
    const {voice} = voiceFor(server);
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hello.', collect()), error => error instanceof InworldError && error.kind === 'voice');
    assert.equal(voice.degraded, null, 'a missing voice is not a service problem');
    const {packets, onPcm} = collect();
    await voice.synthesizeStream('judy-alvarez', 'Hello again.', {onPcm});
    assert.ok(packets.length > 0);
    assert.equal(server.count('POST', '/clone'), 2, 'the voice was made again');
  } finally { await server.close(); }
});

test('cloning is paced at the plan\'s two a minute, one at a time, and never ahead of the clock', async () => {
  const times = [];
  const server = await serve({'POST /clone': (request, response, record) => {
    times.push(Date.now()); response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({voice: {voiceId: `ws__${record.body.displayName}`}}));
  }});
  try {
    let clock = 1_000_000;
    const timers = [];
    const {voice} = voiceFor(server, {clock: () => clock, setTimer: (fn, ms) => { timers.push({fn, ms}); return {unref() {}}; }, clearTimer() {}});
    const keys = ['a-one', 'b-two', 'c-three'];
    const all = keys.map(key => voice.ensureVoice(key));
    for (let spin = 0; spin < 40 && server.count('POST', '/clone') < 2; spin++) await wait(10);
    await wait(40);
    assert.equal(server.count('POST', '/clone'), 2, 'two clones go out at once, the third waits for the minute');
    const pause = timers.find(timer => timer.ms > 50_000);
    assert.ok(pause, 'the third clone waits for a free slot');
    clock += 61_000; pause.fn();
    await Promise.all(all);
    assert.equal(server.count('POST', '/clone'), 3);
  } finally { await server.close(); }
});

test('a reply does not wait for a voice that is still being made: Pocket speaks it and the voice finishes in the background', async () => {
  let release;
  const gate = new Promise(finish => { release = finish; });
  const server = await serve({'POST /clone': async (request, response, record) => {
    await gate; response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({voice: {voiceId: `ws__${record.body.displayName}`}}));
  }});
  try {
    const {voice} = voiceFor(server, {limits: {cloneWaitMs: 60}});
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hello.', collect()), error => error instanceof InworldError && error.kind === 'voice');
    assert.equal(server.count('POST', '/speech'), 0, 'nothing was spoken by Inworld');
    assert.equal(voice.degraded, null);
    release();
    await voice.ensureVoice('judy-alvarez');
    const {packets, onPcm} = collect();
    await voice.synthesizeStream('judy-alvarez', 'Now it works.', {onPcm});
    assert.ok(packets.length > 0);
  } finally { release(); await server.close(); }
});

test('a clip Inworld refuses is not offered again for a while, and a character with no clip never reaches the network', async () => {
  const server = await serve({'POST /clone': (request, response) => {
    response.writeHead(400, {'content-type': 'application/json'}); response.end(JSON.stringify({error: {code: 3, message: 'audio too short'}}));
  }});
  try {
    let clock = 5_000_000;
    const {voice} = voiceFor(server, {clock: () => clock});
    await assert.rejects(voice.ensureVoice('judy-alvarez'), error => error.kind === 'voice' && /refused the clip/.test(error.message));
    await assert.rejects(voice.ensureVoice('judy-alvarez'), error => error.kind === 'voice');
    assert.equal(server.count('POST', '/clone'), 1, 'not asked again inside the retry time');
    clock += INWORLD_LIMITS.cloneRetryMs + 1;
    await assert.rejects(voice.ensureVoice('judy-alvarez'));
    assert.equal(server.count('POST', '/clone'), 2);
    const none = voiceFor(server, {library: library({none: true})});
    await assert.rejects(none.voice.synthesizeStream('nobody', 'Hi.', collect()), error => error.kind === 'no-reference');
    assert.equal(none.voice.degraded, null);
  } finally { await server.close(); }
});

test('an older voice of the same character (the clip changed) is removed after the new one is made', async () => {
  const server = await serve({voices: [['cp2077-companion-judy-alvarez-deadbeef', 'ws__old'], ['cp2077-test-judy-omnilong', 'ws__mine']]});
  try {
    const {voice} = voiceFor(server);
    await voice.ensureVoice('judy-alvarez');
    for (let spin = 0; spin < 40 && server.count('DELETE', '/voices/ws__old') === 0; spin++) await wait(10);
    assert.equal(server.count('DELETE', '/voices/ws__old'), 1);
    assert.equal(server.requests.filter(item => item.method === 'DELETE').length, 1, 'only the older voice of this character, never another voice');
    assert.ok(server.voices.has('cp2077-test-judy-omnilong'));
  } finally { await server.close(); }
});

test('Expressive emotions become steering instructions in the request, at the words they mark', async () => {
  const server = await serve();
  try {
    const {voice} = voiceFor(server);
    const result = await voice.synthesizeStream('judy-alvarez', 'Back off. Touch her again.', {onPcm() {},
      emotion: {marks: [{at: 0, name: 'sadness', strength: 'subtle'}, {at: 10, name: 'anger', strength: 'strong'}]}});
    const body = server.requests.find(item => item.path === '/speech').body;
    assert.equal(body.text, '[say sadly in a quiet low voice] Back off. [speak as if barely holding back rage forcing every word through gritted teeth] Touch her again.');
    assert.equal(result.timing.voiceEmotionTags, 2);
    // No marks: the text goes as it is, with nothing added.
    await voice.synthesizeStream('judy-alvarez', 'Plain [sigh] text.', {onPcm() {}});
    assert.equal(server.requests.filter(item => item.path === '/speech').at(-1).body.text, 'Plain sigh text.');
  } finally { await server.close(); }
});

test('with steering switched off the marks are ignored', async () => {
  const server = await serve();
  try {
    const {voice} = voiceFor(server, {steering: false});
    await voice.synthesizeStream('judy-alvarez', 'Back off.', {onPcm() {}, emotion: {marks: [{at: 0, name: 'anger', strength: 'subtle'}]}});
    assert.equal(server.requests.find(item => item.path === '/speech').body.text, 'Back off.');
  } finally { await server.close(); }
});

test('no key: nothing is sent and the voice reports it', async () => {
  const server = await serve();
  try {
    const voice = new InworldVoice({getKey: () => null, library: library(), endpoints: server.endpoints});
    assert.equal(voice.hasKey, false); assert.equal(voice.ready, false);
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hi.', collect()), error => error instanceof InworldError && error.kind === 'no-key');
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test('429 is a limit: further replies wait out Retry-After without a request, then it recovers', async () => {
  let limited = true;
  const server = await serve({'POST /speech': (request, response) => {
    if (limited) { response.writeHead(429, {'retry-after': '2', 'content-type': 'application/json'}); return response.end('{"error":{"code":8,"message":"too many requests"}}'); }
    response.writeHead(200); response.write(line(bytesOf(ints(2400)))); response.end();
  }});
  try {
    let clock = 10_000_000, changes = 0;
    const {voice} = voiceFor(server, {clock: () => clock, onChange: () => { changes++; }});
    await voice.ensureVoice('judy-alvarez');
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'One.', collect()), error => error.kind === 'limit' && error.status === 429);
    assert.equal(voice.degraded.reason, 'limit'); assert.equal(voice.ready, false);
    const sent = server.count('POST', '/speech');
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Two.', collect()), error => error.kind === 'limit');
    assert.equal(server.count('POST', '/speech'), sent, 'no request while the limit is waited out');
    limited = false; clock += 2500;
    assert.equal(voice.ready, true);
    await voice.synthesizeStream('judy-alvarez', 'Three.', collect());
    assert.equal(voice.degraded, null); assert.ok(changes >= 2);
  } finally { await server.close(); }
});

test('a used-up plan (HTTP 402 or a quota message) pauses the voice for a long while and is not a temporary fallback', async () => {
  const server = await serve({'POST /speech': (request, response) => { response.writeHead(402, {'content-type': 'application/json'}); response.end('{"message":"insufficient credits"}'); }});
  try {
    let clock = 1;
    const {voice} = voiceFor(server, {clock: () => clock});
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'One.', collect()), error => error.kind === 'quota');
    assert.equal(voice.degraded.reason, 'quota');
    clock += 25 * 60_000; assert.equal(voice.ready, false);
    clock += 10 * 60_000; assert.equal(voice.ready, true);
  } finally { await server.close(); }
});

test('a refused key, a server fault, an error line in a 200 stream and an unreachable server are reported by kind; the key is never in a message', async () => {
  assert.equal(mapStatus(401, '', {apiKey: KEY}).kind, 'key');
  assert.equal(mapStatus(403, '{"error":{"message":"Your quota is exhausted"}}').kind, 'quota');
  assert.equal(mapStatus(403, '{"error":{"message":"forbidden"}}').kind, 'key');
  assert.equal(mapStatus(404, '').kind, 'voice-missing');
  assert.equal(mapStatus(400, '{"error":{"code":3,"message":"voice does not exist"}}').kind, 'voice-missing');
  assert.equal(mapStatus(400, '{"error":{"code":3,"message":"text too long"}}').kind, 'request');
  assert.equal(mapStatus(503, '').kind, 'network'); assert.equal(mapStatus(429, '').kind, 'limit');
  assert.equal(mapStreamError({code: 3, message: 'bad'}).kind, 'request'); assert.equal(mapStreamError({code: 14, message: 'down'}).kind, 'network');
  assert.equal(mapStreamError({code: 8, message: 'slow down'}).kind, 'limit'); assert.equal(mapStreamError({code: 7, message: 'no'}).kind, 'key');
  assert.equal(mapStreamError({code: 5, message: 'gone'}).kind, 'voice-missing');
  const error = new InworldError('key', `rejected ${KEY} and ${'Z'.repeat(60)}`, {apiKey: KEY});
  assert.equal(error.message.includes(KEY), false); assert.match(error.message, /\[key\]/);
  assert.equal(redact(`header Basic ${KEY}`, KEY).includes(KEY), false);

  const server = await serve({'POST /speech': (request, response) => { response.writeHead(200); response.end(JSON.stringify({error: {code: 3, message: `bad text for ${KEY}`}}) + '\n'); }});
  try {
    const {voice} = voiceFor(server);
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hello.', collect()), failure => failure.kind === 'request' && !failure.message.includes(KEY));
  } finally { await server.close(); }
  const closed = await serve(); const endpoints = closed.endpoints; await closed.close();
  const voice = new InworldVoice({getKey: () => KEY, library: library(), endpoints});
  await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hello.', collect()), failure => failure instanceof InworldError && ['network', 'voice'].includes(failure.kind));
});

test('no first audio within the limit: the call fails with a timeout and delivers nothing', async () => {
  const server = await serve({'POST /speech': async () => { await wait(400); }});
  try {
    const {voice} = voiceFor(server, {limits: {firstAudioMs: 60}});
    await voice.ensureVoice('judy-alvarez');
    const {packets, onPcm} = collect();
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Late.', {onPcm}), error => error.kind === 'timeout');
    assert.equal(packets.length, 0); assert.equal(voice.degraded.reason, 'timeout');
  } finally { await server.close(); }
});

test('a stream that breaks after audio started ends that reply early instead of failing it or switching voices', async () => {
  const server = await serve({'POST /speech': async (request, response) => {
    response.writeHead(200); response.write(line(bytesOf(ints(5000))));
    await wait(20); response.write(JSON.stringify({error: {code: 14, message: 'upstream gone'}}) + '\n'); response.end();
  }});
  try {
    const {voice} = voiceFor(server);
    const {packets, onPcm} = collect();
    const result = await voice.synthesizeStream('judy-alvarez', 'A long reply that is cut.', {onPcm});
    assert.equal(result.truncated, true); assert.equal(result.timing.voiceTruncated, true);
    assert.equal(result.frames, 5000); assert.equal(packets.reduce((sum, packet) => sum + packet.frames, 0), 5000);
  } finally { await server.close(); }
});

test('cancelling the reply aborts the request; an error from the PCM consumer passes through marked and does not blame the service', async () => {
  const server = await serve({'POST /speech': async (request, response) => { response.writeHead(200); response.write(line(bytesOf(ints(4800)))); await wait(500); response.end(); }});
  try {
    const {voice} = voiceFor(server);
    await voice.ensureVoice('judy-alvarez');
    const controller = new AbortController();
    const running = voice.synthesizeStream('judy-alvarez', 'Hello.', {signal: controller.signal, onPcm() { controller.abort(); }});
    await assert.rejects(running, error => !(error instanceof InworldError));
    assert.equal(voice.degraded, null);
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hello.', {onPcm() { throw Error('renderer retired'); }}), error => error.sink === true && /renderer retired/.test(error.message));
    assert.equal(voice.degraded, null);
  } finally { await server.close(); }
});

test('text that cannot be spoken is refused before any request', async () => {
  const server = await serve();
  try {
    const {voice} = voiceFor(server);
    for (const text of ['', '   ', 'x'.repeat(4001), 'bad\u0000text']) await assert.rejects(voice.synthesizeStream('judy-alvarez', text, collect()), error => error.kind === 'text');
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test('a changed key forgets the account: the voices are looked up and made again for the new account', async () => {
  const server = await serve();
  try {
    let key = KEY;
    const lib = library();
    const voice = new InworldVoice({getKey: () => key, library: lib, endpoints: server.endpoints});
    await voice.synthesizeStream('judy-alvarez', 'One.', collect());
    key = `${KEY}x`;
    assert.equal(voice.readyVoice('judy-alvarez'), null);
    server.voices.clear();
    await voice.synthesizeStream('judy-alvarez', 'Two.', collect());
    assert.equal(server.count('POST', '/clone'), 2);
  } finally { await server.close(); }
});

test('ndjson yields each complete line, skips blanks and noise, and reads a last line with no newline', async () => {
  const chunks = [Buffer.from('{"a":1}\n\nnot json\n{"b"'), Buffer.from(':2}\n{"c":3}')];
  const out = []; for await (const value of ndjson(chunks)) out.push(value);
  assert.deepEqual(out, [{a: 1}, {b: 2}, {c: 3}]);
});

// ---- the voice selection: one voice per reply ------------------------------------------------------------------------------------

const pocketSettings = voices => ({version: 1, provider: 'pocket', engine: 'pocket-tts', voices,
  runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('fixture', key)])),
  model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64),
    inputIdentity: 'e'.repeat(64), selectedStep: 1500}});

function selection(server, {inworld = {}, pocket = null, retryMs = 150} = {}) {
  const calls = [], states = [], workers = [];
  const voices = Object.fromEntries(LOCAL_VOICE_KEYS.map(name => [name, {reference: `runtime/voice-references/${name}.wav`, sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.'}]));
  const {voice: cloud} = voiceFor(server, inworld);
  const voice = new VoiceSelection(pocketSettings(voices), {inworld: cloud, onState: value => states.push(value), cloudRetryAudioMs: {inworld: retryMs},
    factory: (config, {onState}) => {
      workers.push(config);
      let loaded = false;
      return {get loaded() { return loaded; }, hasProfile: name => Object.hasOwn(config.voices, name), profileReady: name => loaded && Object.hasOwn(config.voices, name),
        async prepareProfile(name) { return {provider: 'pocket', ready: true, profile: name}; },
        async start() { loaded = true; onState({state: 'ready', resident: true}); },
        async synthesizeStream(name, text, options) { calls.push({name, text}); if (pocket) return pocket(name, text, options); await options.onPcm?.({marker: 'pocket'}); return {audio: 'pocket'}; },
        async close() { loaded = false; onState({state: 'stopped'}); }};
    }});
  return {voice, cloud, calls, states, workers};
}
const choose = async h => { h.voice.update({voiceProvider: 'inworld'}, null, false); await h.voice.start(); };

test('the Inworld cloud voice is a menu choice that uses Pocket\'s route only: chosen, it speaks the reply and no local worker exists', async () => {
  const server = await serve();
  try {
    const h = selection(server);
    h.voice.update({voiceProvider: 'inworld'}, null, true);
    assert.equal(h.voice.cloud, null, 'a change waits for a moment with no reply in flight'); assert.equal(h.voice.pending, true);
    await choose(h);
    assert.equal(h.voice.cloud, 'inworld'); assert.equal(h.voice.provider, 'pocket'); assert.equal(h.voice.requestedProvider, 'pocket'); assert.equal(h.voice.cloudActive, true);
    h.voice.publish();
    assert.equal(h.states.at(-1).cloudVoice, 'inworld'); assert.equal(h.states.at(-1).fallback, null);
    assert.equal(h.states.at(-1).inworld.key, true);
    assert.equal(JSON.stringify(h.states.at(-1)).includes(KEY), false, 'the published state never holds the key');
    await h.cloud.ensureVoice('judy-alvarez');
    const packets = [];
    const result = await h.voice.synthesizeStream('judy-alvarez', 'Uh... [laughter] okay.', {onPcm: packet => { packets.push(packet); }});
    assert.equal(result.provider, 'inworld'); assert.ok(packets.length > 0); assert.equal(h.calls.length, 0); assert.equal(h.workers.length, 0);
    assert.equal(server.requests.find(item => item.path === '/speech').body.text, 'Uh... okay.', 'voice tags never reach the cloud voice');
    h.voice.update({voiceProvider: 'pocket'}, null, false);
    assert.equal(h.voice.cloudActive, false);
    await h.voice.synthesizeStream('judy-alvarez', 'Pocket now.', {onPcm() {}});
    assert.equal(h.calls.length, 1);
    await h.voice.close();
  } finally { await server.close(); }
});

test('preparing a character makes its Inworld voice in the background, so the first reply is not waiting for it', async () => {
  const server = await serve();
  try {
    const h = selection(server);
    await choose(h);
    await h.voice.prepareProfile('judy-alvarez');
    for (let spin = 0; spin < 60 && !h.cloud.readyVoice('judy-alvarez'); spin++) await wait(10);
    assert.ok(h.cloud.readyVoice('judy-alvarez'));
    assert.equal(server.count('POST', '/speech'), 0, 'preparing speaks nothing');
  } finally { await server.close(); }
});

test('a reply Inworld cannot start is asked once more, then written (no local voice); the report names why and clears itself', async () => {
  let fail = true;
  const server = await serve({'POST /speech': (request, response) => {
    if (fail) { response.writeHead(503, {'content-type': 'application/json'}); return response.end('{}'); }
    response.writeHead(200); response.write(line(bytesOf(ints(2400)))); response.end();
  }});
  try {
    const h = selection(server);
    await choose(h); await h.cloud.ensureVoice('judy-alvarez');
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Hello.', {onPcm() {}}), {kind: 'network'});
    assert.equal(server.count('POST', '/speech'), 2, 'asked, then asked once more');
    assert.equal(h.calls.length, 0); assert.equal(h.workers.length, 0);
    h.voice.publish();
    assert.deepEqual(h.states.at(-1).fallback, {from: 'inworld', to: 'convai', temporary: true, reason: 'network'});
    fail = false;
    const again = await h.voice.synthesizeStream('judy-alvarez', 'Hello.', {onPcm() {}});
    assert.equal(again.provider, 'inworld'); h.voice.publish();
    assert.equal(h.states.at(-1).fallback, null);
    await h.voice.close();
  } finally { await server.close(); }
});

test('a first ask that fails but whose second ask is answered is spoken, with the longer wait on the second', async () => {
  let asks = 0;
  const server = await serve({'POST /speech': (request, response) => {
    asks++;
    if (asks === 1) { response.writeHead(503, {'content-type': 'application/json'}); return response.end('{}'); }
    response.writeHead(200); response.write(line(bytesOf(ints(2400)))); response.end();
  }});
  try {
    const h = selection(server);
    await choose(h); await h.cloud.ensureVoice('judy-alvarez');
    const packets = [];
    const result = await h.voice.synthesizeStream('judy-alvarez', 'Hello.', {onPcm: packet => { packets.push(packet); }});
    assert.equal(result.provider, 'inworld'); assert.equal(asks, 2); assert.ok(packets.length > 0);
    assert.equal(h.calls.length, 0); assert.equal(h.workers.length, 0);
    await h.voice.close();
  } finally { await server.close(); }
});

test('without an Inworld key the choice is unavailable, the turn goes to the Convai voice and nothing local is loaded; a key added later is used at once', async () => {
  const server = await serve();
  try {
    let key = null;
    const h = selection(server, {inworld: {getKey: () => key}});
    await choose(h);
    assert.equal(h.voice.cloudKeyless, true);
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Hello.', {onPcm() {}}), /no key|cannot be asked/);
    h.voice.publish();
    assert.deepEqual(h.states.at(-1).fallback, {from: 'inworld', to: 'convai', temporary: false, reason: 'no-key'});
    assert.equal(server.requests.length, 0); assert.equal(h.calls.length, 0); assert.equal(h.workers.length, 0);
    key = KEY;
    await h.cloud.ensureVoice('judy-alvarez');
    assert.equal((await h.voice.synthesizeStream('judy-alvarez', 'Hello.', {onPcm() {}})).provider, 'inworld');
    assert.equal(h.workers.length, 0);
    await h.voice.close();
  } finally { await server.close(); }
});

test('an Inworld choice starts no local worker: a running Pocket one is retired, preparing a character loads nothing, a failed Pocket does not matter', async () => {
  const server = await serve();
  try {
    const h = selection(server);
    h.voice.update({voiceProvider: 'pocket'}, null, false); await h.voice.start();
    assert.equal(h.workers.length, 1);
    h.voice.update({voiceProvider: 'inworld'}, null, false);
    assert.equal(h.voice.cloudActive, true); assert.equal(h.voice.client, null);
    await h.voice.retiring;
    const receipt = await h.voice.prepareProfile('judy-alvarez');
    assert.equal(receipt.ready, true); assert.equal(receipt.cloudVoice, 'inworld'); assert.equal(h.voice.profileReady('judy-alvarez'), true);
    for (let poll = 0; poll < 3; poll++) h.voice.update({voiceProvider: 'inworld'}, null, false);
    h.voice.failedBackends.add('pocket');
    h.voice.update({voiceProvider: 'inworld'}, null, false);
    assert.equal(h.voice.provider, 'pocket'); assert.equal(h.voice.cloudActive, true);
    assert.equal(h.workers.length, 1, 'only the first Pocket worker was ever created'); assert.equal(h.states.at(-1).state, 'remote');
    await h.voice.close();
  } finally { await server.close(); }
});

test('one voice per reply: the first part decides, a later part follows it, and a failing later part never hands the reply to Pocket', async () => {
  let failSecond = false, calls = 0;
  const server = await serve({'POST /speech': (request, response) => {
    calls++;
    if (calls > 1 && failSecond) { response.writeHead(503, {'content-type': 'application/json'}); return response.end('{}'); }
    response.writeHead(200); response.write(line(bytesOf(ints(2400)))); response.end();
  }});
  try {
    const h = selection(server);
    await choose(h); await h.cloud.ensureVoice('judy-alvarez');
    // Both parts by Inworld.
    let utterance = new Utterance();
    await h.voice.synthesizeStream('judy-alvarez', 'First part.', {onPcm() {}, utterance, role: 'head'});
    assert.equal(utterance.engine, 'inworld');
    await h.voice.synthesizeStream('judy-alvarez', 'Second part.', {onPcm() {}, utterance, role: 'tail'});
    assert.equal(h.calls.length, 0);
    // The second part fails after the first was spoken by Inworld: the error reaches the caller, Pocket does not speak the rest.
    calls = 0; failSecond = true; utterance = new Utterance();
    await h.voice.synthesizeStream('judy-alvarez', 'First part.', {onPcm() {}, utterance, role: 'head'});
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Second part.', {onPcm() {}, utterance, role: 'tail'}), error => error.kind === 'network');
    assert.equal(h.calls.length, 0, 'Pocket never continued a reply that Inworld began');
  } finally { await server.close(); }
});

test('one voice per reply: when the first part gets no audio the later part is not spoken either, and Inworld is not tried for it', async () => {
  const server = await serve({'POST /speech': (request, response) => { response.writeHead(503, {'content-type': 'application/json'}); response.end('{}'); }});
  try {
    const h = selection(server);
    await choose(h); await h.cloud.ensureVoice('judy-alvarez');
    const utterance = new Utterance();
    // The later part is asked while the first is still deciding: it waits, then follows.
    const first = h.voice.synthesizeStream('judy-alvarez', 'First part.', {onPcm() {}, utterance, role: 'head'});
    const second = h.voice.synthesizeStream('judy-alvarez', 'Second part.', {onPcm() {}, utterance, role: 'tail'});
    const [one, two] = await Promise.allSettled([first, second]);
    assert.equal(one.status, 'rejected'); assert.equal(two.status, 'rejected');
    assert.equal(utterance.engine, 'pocket', 'the lock says the cloud voice did not speak');
    assert.equal(h.calls.length, 0); assert.equal(h.workers.length, 0);
    assert.equal(server.count('POST', '/speech'), 2, 'the first part was asked twice (once more with a longer wait); the later part sent nothing');
  } finally { await server.close(); }
});

test('a later part that arrives while the first is still waiting for audio waits for its decision', async () => {
  let release;
  const gate = new Promise(finish => { release = finish; });
  const server = await serve({'POST /speech': async (request, response) => { await gate; response.writeHead(200); response.write(line(bytesOf(ints(2400)))); response.end(); }});
  try {
    const h = selection(server);
    await choose(h); await h.cloud.ensureVoice('judy-alvarez');
    const utterance = new Utterance();
    const order = [];
    const first = h.voice.synthesizeStream('judy-alvarez', 'First part.', {onPcm() { order.push('first'); }, utterance, role: 'head'});
    const second = h.voice.synthesizeStream('judy-alvarez', 'Second part.', {onPcm() { order.push('second'); }, utterance, role: 'tail'});
    await wait(50);
    assert.equal(server.count('POST', '/speech'), 1, 'the second part has not been sent yet');
    release(); await Promise.all([first, second]);
    assert.deepEqual(order, ['first', 'second']); assert.equal(utterance.engine, 'inworld');
  } finally { release(); await server.close(); }
});

test('a consumer error or a cancelled reply is not a fallback to Pocket', async () => {
  const server = await serve();
  try {
    const h = selection(server);
    await choose(h); await h.cloud.ensureVoice('judy-alvarez');
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Hello.', {onPcm() { throw Error('renderer retired'); }}), error => error.sink === true);
    assert.equal(h.calls.length, 0);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Hello.', {signal: controller.signal, onPcm() {}}));
    assert.equal(h.calls.length, 0);
  } finally { await server.close(); }
});

test('multilingual conversations keep the Inworld voice out too: Pocket is skipped, so the route is the Convai voice', async () => {
  const server = await serve();
  try {
    const h = selection(server);
    await choose(h);
    h.voice.update({multilingualConversations: true}, null, false);
    assert.equal(h.voice.resolvedProvider, 'convai');
  } finally { await server.close(); }
});

test('the routing log names the Inworld voice; with a reason only when it cannot be asked (never a local voice); an earlier failure is carried as cloudLast', async () => {
  const server = await serve({'POST /speech': (request, response) => { response.writeHead(503); response.end('{}'); }});
  try {
    const h = selection(server);
    await choose(h); await h.cloud.ensureVoice('judy-alvarez');
    const describe = () => describeVoiceRoute({voice: h.voice, input: {profileKey: 'judy-alvarez'}, profile: {key: 'judy-alvarez', name: 'Judy'},
      plan: {engine: 'pocket'}, reply: {engine: 'pocket'}, now: () => 0});
    let record = describe();
    assert.equal(record.requested, 'Inworld cloud voice'); assert.equal(record.used, 'Inworld cloud voice'); assert.equal(record.fallback, null);
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Late.', {onPcm() {}}), {kind: 'network'});
    record = describe();
    // The line for the NEXT reply is written before it is voiced: an earlier network failure does not make it claim Pocket (the cloud voice
    // is asked again); it is carried as cloudLast. Only a state that stops the cloud voice being asked (no key) names Pocket.
    assert.equal(record.used, 'Inworld cloud voice'); assert.equal(record.fallback, null); assert.equal(record.cloudLast, 'network');
    h.cloud.getKey = () => null;
    record = describe();
    assert.equal(record.used, 'none (written reply only)'); assert.equal(record.fallback, 'Inworld cloud voice has no key'); assert.equal(record.cloudLast, undefined);
    await h.voice.close();
  } finally { await server.close(); }
});

// ---- emotion on every path: the fallback for an untagged reply, and the non-verbal sounds ----------------------------------------

test('a reply with no feeling tag is steered from what its words clearly say; an unclear one is spoken plainly', async () => {
  const server = await serve();
  try {
    const {voice} = voiceFor(server);
    const sad = await voice.synthesizeStream('judy-alvarez', 'I am so sorry, V. I really miss him.', {onPcm() {}});
    const body = server.requests.filter(item => item.path === '/speech').at(-1).body;
    assert.match(body.text, /^\[say sadly in a quiet low voice\] I am so sorry/);
    assert.equal(sad.timing.voiceEmotionSource, 'text'); assert.equal(sad.timing.voiceEmotionTags, 1);
    const plain = await voice.synthesizeStream('judy-alvarez', 'Meet me at the corner at nine.', {onPcm() {}, emotion: {marks: []}});
    assert.equal(server.requests.filter(item => item.path === '/speech').at(-1).body.text, 'Meet me at the corner at nine.');
    assert.equal(plain.timing.voiceEmotionSource, 'none'); assert.equal(plain.timing.voiceEmotionTags, 0);
    // The character's own marks win: nothing is inferred beside them, even when the words say something else.
    const tagged = await voice.synthesizeStream('judy-alvarez', 'I am so sorry, V.', {onPcm() {}, emotion: {marks: [{at: 0, name: 'joy', strength: 'subtle'}]}});
    assert.equal(server.requests.filter(item => item.path === '/speech').at(-1).body.text, '[say with warm amusement] I am so sorry, V.');
    assert.equal(tagged.timing.voiceEmotionSource, 'tags');
    // Switched off, nothing is added.
    const off = voiceFor(server, {steering: false});
    await off.voice.synthesizeStream('judy-alvarez', 'I am so sorry, V. I really miss him.', {onPcm() {}});
    assert.equal(server.requests.filter(item => item.path === '/speech').at(-1).body.text, 'I am so sorry, V. I really miss him.');
  } finally { await server.close(); }
});

test('the character\'s non-verbal sounds go into the text as Inworld\'s sounds; the ones with no match are dropped', async () => {
  const server = await serve();
  try {
    const {voice} = voiceFor(server);
    const text = 'I told him no, and he still showed up.';
    const result = await voice.synthesizeStream('judy-alvarez', text, {onPcm() {}, emotion: {marks: [], sounds: [{at: text.indexOf('and'), name: 'laughter'}, {at: 0, name: 'question-oh'}]}});
    assert.equal(server.requests.filter(item => item.path === '/speech').at(-1).body.text, 'I told him no, [laugh] and he still showed up.');
    assert.equal(result.timing.voiceSounds, 1);
    // The second part of a reply: its offsets count from where it begins in the whole reply.
    const tail = 'and he still showed up. Typical.';
    await voice.synthesizeStream('judy-alvarez', tail, {onPcm() {}, emotion: {marks: [], from: 15, sounds: [{at: 15 + tail.indexOf('Typical'), name: 'sigh'}, {at: 4, name: 'laugh'}]}});
    assert.equal(server.requests.filter(item => item.path === '/speech').at(-1).body.text, 'and he still showed up. [sigh] Typical.');
  } finally { await server.close(); }
});
