import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {VOXTRAL_TTS3_LANGUAGES, VOXTRAL_TTS1_LANGUAGES, voxtralSpeaks, modelRefused} from './voxtral-languages.mjs';
import {VoxtralVoice, VoxtralError, VOXTRAL_LIMITS, VOXTRAL_MODEL, VOXTRAL_FALLBACK_MODEL, capWav, isContentRefusal, joinWavs, mapStatus, redact, singleClip, SINGLE_CLIP, splitReply, sseEvents} from './voxtral-voice.mjs';
import {createVoiceProfileRegistry} from './voice-profile-registry.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {ownedLocalPcmPacket} from './local-pcm-host.mjs';
import {cloudReferenceOf, describeVoiceRoute, formatVoiceRoute} from './voice-routing-log.mjs';
import {LOCAL_VOICE_KEYS} from './resident-voice.mjs';
import {MistralScheduler, PRIORITY} from './mistral-rate.mjs';
import {Utterance} from './voice-utterance.mjs';
import {fakeClock} from './fixtures/fake-clock.mjs';
import {manualTimers, track, until} from './fixtures/test-waits.mjs';

// No spacing between starts, so a test is not slowed by the one-second precaution the real scheduler keeps (tested in mistral-rate.test.mjs).
const fastScheduler = () => new MistralScheduler({spacingMs: 0});

const KEY = 'k'.repeat(8) + 'Secret0123456789abcdefghijkl';

// A 24 kHz mono PCM16 WAV of `seconds` of a quiet ramp.
function wav(seconds) {
  const frames = Math.round(seconds * 24000), bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let at = 0; at < frames; at++) bytes.writeInt16LE((at % 200) * 10 - 1000, 44 + at * 2);
  return bytes;
}
const REFERENCE = wav(2);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const registryOf = (keys = ['judy-alvarez']) => createVoiceProfileRegistry({version: 2, provider: 'hybrid', engine: 'omnivoice',
  voices: Object.fromEntries(keys.map(key => [key, {reference: `runtime/voice-references/${key}.wav`, sha256: sha(REFERENCE),
    transcript: 'Ready when you are, V.'}]))});

// Known samples, so any decoding mistake (16-bit, big-endian, a lost byte) shows.
function samples(count, offset = 0) {
  const out = new Float32Array(count);
  for (let at = 0; at < count; at++) out[at] = Math.fround(Math.sin((at + offset) / 37) * 0.5 + (at % 5) * 0.01);
  return out;
}
const bytesOf = floats => Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
const delta = bytes => `event: speech.audio.delta\ndata: ${JSON.stringify({type: 'speech.audio.delta', audio_data: bytes.toString('base64')})}\n\n`;
const done = `event: speech.audio.done\ndata: ${JSON.stringify({type: 'speech.audio.done', usage: {prompt_tokens: 200, completion_tokens: 1000}})}\n\n`;
const wait = ms => new Promise(finish => setTimeout(finish, ms));

async function serve(handler) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const record = {headers: request.headers, body: (() => { try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; } })(), socket: request.socket};
      requests.push(record);
      response.on('close', () => { record.closed = true; });
      Promise.resolve(handler(request, response, record)).catch(() => response.destroy());
    });
  });
  await new Promise(finish => server.listen(0, '127.0.0.1', finish));
  return {requests, endpoint: `http://127.0.0.1:${server.address().port}/v1/audio/speech`,
    close: () => { server.closeAllConnections?.(); return new Promise(finish => server.close(finish)); }};
}
const sse = response => response.writeHead(200, {'content-type': 'text/event-stream'});

function voiceFor(server, extra = {}) {
  const reads = [];
  const voice = new VoxtralVoice({getKey: () => KEY, referenceRoot: resolve('fixture-references'), registry: registryOf(),
    endpoint: server.endpoint, read: async path => { reads.push(path); return REFERENCE; }, scheduler: fastScheduler(), ...extra});
  return {voice, reads};
}
const collect = () => { const packets = []; return {packets, onPcm: packet => { packets.push(packet); }}; };

test('the stream is decoded as 32-bit float, split at odd bytes, and re-sliced into 100 ms packets the PCM host accepts', async () => {
  const total = samples(7000), bytes = bytesOf(total);
  const server = await serve(async (request, response) => {
    sse(response);
    // Deltas cut at byte offsets that are not sample boundaries, and one event split in the middle of a line.
    const cuts = [0, 10001, 17003, bytes.length];
    for (let at = 0; at < 3; at++) {
      const text = delta(bytes.subarray(cuts[at], cuts[at + 1]));
      if (at === 1) { response.write(text.slice(0, 40)); await wait(15); response.write(text.slice(40)); } else response.write(text);
    }
    response.end(done);
  });
  try {
    const {voice} = voiceFor(server), sink = collect();
    const result = await voice.synthesizeStream('judy-alvarez', 'Hey V.', sink);
    assert.deepEqual(sink.packets.map(packet => packet.frames), [2400, 2400, 2200]);
    const joined = new Float32Array(7000); let at = 0;
    for (const packet of sink.packets) { joined.set(packet.pcm, at); at += packet.frames; }
    assert.deepEqual(joined, total, 'every sample survives the float32 decode and the re-slicing');
    sink.packets.forEach((packet, index) => {
      assert.equal(packet.index, index + 1); assert.equal(packet.offsetFrames, index * 2400);
      assert.equal(packet.sampleRate, 24000); assert.equal(packet.channels, 1); assert.equal(packet.format, 'f32le');
      assert.ok(packet.pcm instanceof Float32Array && packet.pcm.length === packet.frames);
      assert.equal(packet.profile, 'judy-alvarez'); assert.equal(packet.owner, sink.packets[0].owner);
      assert.equal(packet.modelSha256, sink.packets[0].modelSha256); assert.equal(packet.id, sink.packets[0].id);
      // The PCM host's own validator takes them as Pocket packets.
      const owned = ownedLocalPcmPacket(packet, {token: 'abc', frames: packet.offsetFrames, index: index});
      assert.equal(owned.packet.frames, packet.frames);
    });
    assert.equal(result.frames, 7000); assert.equal(result.chunks, 3); assert.equal(result.truncated, false);
    assert.equal(result.timing.voiceProvider, 'pocket'); assert.equal(result.timing.voiceEngine, 'voxtral');
    assert.equal(voice.degraded, null);
  } finally { await server.close(); }
});

test('a 16-bit reading would not match: the same bytes decoded as int16 differ from the float samples', () => {
  const floats = samples(64), asInt16 = new Int16Array(bytesOf(floats).buffer.slice(0, 128));
  assert.notDeepEqual(Array.from(asInt16.slice(0, 4)).map(value => value / 32768), Array.from(floats.slice(0, 4)));
});

test('the request clones from the OmniVoice long reference, streams raw PCM and carries the key only as a bearer token', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done); });
  try {
    const {voice, reads} = voiceFor(server);
    await voice.synthesizeStream('judy-alvarez', 'First.', collect());
    await voice.synthesizeStream('judy-alvarez', 'Second.', collect());
    const [first, second] = server.requests;
    assert.equal(first.headers.authorization, `Bearer ${KEY}`);
    assert.equal(first.body.model, 'voxtral-mini-tts-3-0', 'Voxtral TTS 3 is asked by name: the -latest alias still points to the March model');
    assert.equal(VOXTRAL_MODEL, 'voxtral-mini-tts-3-0'); assert.equal(VOXTRAL_FALLBACK_MODEL, 'voxtral-mini-tts-latest');
    assert.equal(first.body.response_format, 'pcm');
    assert.equal(first.body.stream, true); assert.equal(first.body.input, 'First.');
    assert.equal(first.body.ref_audio, REFERENCE.toString('base64'));
    assert.equal(second.body.ref_audio, first.body.ref_audio, 'the reference is sent with every call');
    assert.equal(first.body.voice_id, undefined);
    assert.equal(reads.length, 1, 'the encoded reference is built once and kept in memory');
    assert.ok(reads[0].endsWith('judy-alvarez.wav') && reads[0].includes('fixture-references'));
    assert.equal(JSON.stringify(first.body).includes(KEY), false);
  } finally { await server.close(); }
});

test('a reference whose hash changed, or that is missing, is no reference: the call never leaves this computer', async () => {
  const server = await serve((request, response) => { sse(response); response.end(done); });
  try {
    const changed = voiceFor(server, {read: async () => wav(3)});
    await assert.rejects(changed.voice.synthesizeStream('judy-alvarez', 'Hi.', collect()), {kind: 'no-reference'});
    const unknown = voiceFor(server);
    await assert.rejects(unknown.voice.synthesizeStream('someone-else', 'Hi.', collect()), {kind: 'no-reference'});
    const unreadable = voiceFor(server, {read: async () => { throw Error('ENOENT'); }});
    await assert.rejects(unreadable.voice.synthesizeStream('judy-alvarez', 'Hi.', collect()), {kind: 'no-reference'});
    assert.equal(server.requests.length, 0);
    // A voice without a reference is that character's matter, not a reason to tell the player the service is down.
    assert.equal(changed.voice.degraded, null); assert.equal(unknown.voice.degraded, null);
  } finally { await server.close(); }
});

test('no key: nothing is sent and the voice reports it', async () => {
  const server = await serve((request, response) => { sse(response); response.end(done); });
  try {
    const changes = [];
    const {voice} = voiceFor(server, {getKey: () => null, onChange: value => changes.push(value?.reason ?? null)});
    assert.equal(voice.hasKey, false); assert.equal(voice.ready, false);
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hi.', collect()), {kind: 'no-key'});
    assert.equal(server.requests.length, 0); assert.deepEqual(changes, ['no-key']);
  } finally { await server.close(); }
});

test('no first audio within the limit: the call fails with a timeout, delivers nothing and the connection is dropped', async () => {
  // The limit is a timer of the voice, so a manual clock decides when it fires: the test moves it once the request has reached the server (a real
  // 60 ms timer can fire on a loaded machine before the request is even sent). The server holds its answer until the test lets it go.
  let open; const hold = new Promise(resolve => { open = resolve; });
  let answered = false;
  const server = await serve(async (request, response) => { await hold; if (!response.destroyed) { answered = true; sse(response); response.end(done); } });
  try {
    const changes = [], timers = manualTimers();
    const {voice} = voiceFor(server, {...timers.hooks, limits: {firstAudioMs: 60}, onChange: value => changes.push(value?.reason ?? null)});
    const sink = collect();
    const call = track(voice.synthesizeStream('judy-alvarez', 'Hi.', sink));
    await until(() => server.requests.length === 1, 'the request to reach the server');
    await timers.clock.advance(59);
    assert.equal(call.done, false, 'nothing ends the ask before its limit');
    await timers.clock.advance(1);
    await until(() => call.done, 'the ask to end at its limit');
    assert.ok(call.error instanceof VoxtralError && call.error.kind === 'timeout', String(call.error));
    assert.equal(answered, false, 'it gave up at the limit, while the server still held its answer');
    assert.equal(sink.packets.length, 0); assert.equal(voice.degraded.reason, 'timeout');
    await until(() => server.requests[0].closed === true, 'the abandoned request to be aborted');
    // The next reply is tried again (a spike is not a verdict) and clears the report.
    server.requests.length = 0;
    voice.limits = Object.freeze({...voice.limits, firstAudioMs: 2000});
    const fast = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done); });
    voice.endpoint = fast.endpoint;
    await voice.synthesizeStream('judy-alvarez', 'Again.', collect());
    assert.equal(voice.degraded, null); assert.deepEqual(changes, ['timeout', null]);
    await fast.close();
  } finally { open(); await server.close(); }
});

test('a headers-only server that never sends audio also times out', async () => {
  const server = await serve((request, response) => { sse(response); response.flushHeaders(); });
  try {
    // The limit is moved only once the headers have reached the voice, so the state under test (headers, no audio) is the one that is cut.
    const timers = manualTimers();
    let headers = false;
    const fetchImpl = async (...args) => { const response = await globalThis.fetch(...args); headers = true; return response; };
    const {voice} = voiceFor(server, {...timers.hooks, fetchImpl, limits: {firstAudioMs: 60}}), sink = collect();
    const call = track(voice.synthesizeStream('judy-alvarez', 'Hi.', sink));
    await until(() => headers, 'the headers to reach the voice');
    await timers.clock.advance(60);
    await until(() => call.done, 'the ask to end at its limit');
    assert.equal(call.error?.kind, 'timeout', String(call.error));
    assert.equal(sink.packets.length, 0);
  } finally { await server.close(); }
});

test('429 is a limit: the reply falls back, further calls wait out Retry-After without a request, then it recovers', async () => {
  let limited = true;
  const server = await serve((request, response) => {
    if (limited) { response.writeHead(429, {'retry-after': '12', 'content-type': 'application/json'}); response.end('{"message":"rate limited"}'); return; }
    sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done);
  });
  try {
    let time = 1_000_000;
    const paused = [], scheduler = {schedule: task => Promise.resolve().then(() => task({})), noteHeaders() {}, pause: ms => paused.push(ms)};
    const {voice} = voiceFor(server, {clock: () => time, scheduler});
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hi.', collect()), {kind: 'limit', status: 429});
    assert.deepEqual(paused, [12000], 'the shared scheduler holds text requests for the same retry-after');
    assert.equal(voice.degraded.reason, 'limit'); assert.equal(voice.ready, false);
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hi.', collect()), {kind: 'limit'});
    assert.equal(server.requests.length, 1, 'no second request inside the cool-down');
    limited = false; time += 12_001;
    assert.equal(voice.ready, true);
    await voice.synthesizeStream('judy-alvarez', 'Hi.', collect());
    assert.equal(voice.degraded, null);
  } finally { await server.close(); }
});

test('a refused key, a server fault and an unreachable server are reported by kind, and the key is never in a message', async () => {
  for (const [status, kind] of [[401, 'key'], [403, 'key'], [503, 'network'], [400, 'request']]) {
    const server = await serve((request, response) => { response.writeHead(status); response.end(`bad ${KEY}`); });
    try {
      const {voice} = voiceFor(server);
      await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hi.', collect()), error => {
        assert.equal(error.kind, kind); assert.equal(error.message.includes(KEY), false, 'the key is scrubbed'); return true;
      });
    } finally { await server.close(); }
  }
  const dead = await serve(() => {}); const endpoint = dead.endpoint; await dead.close();
  const {voice} = voiceFor({endpoint});
  await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hi.', collect()), {kind: 'network'});
  assert.equal(mapStatus(429, '', {}).kind, 'limit'); assert.equal(redact(`x ${KEY} y`, KEY), 'x [key] y');
});

test('a stream that breaks after audio started ends that reply early instead of failing it or switching voices', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(6000)))); setTimeout(() => response.destroy(), 20); });
  try {
    const {voice} = voiceFor(server), sink = collect();
    const result = await voice.synthesizeStream('judy-alvarez', 'A long reply.', sink);
    assert.equal(result.truncated, true); assert.equal(result.frames, 6000); assert.equal(result.timing.voiceTruncated, true);
    assert.equal(sink.packets.length, 3);
  } finally { await server.close(); }
});

test('a finished stream is read to its end, so the next request reuses its connection (no new DNS, TCP and TLS)', async () => {
  // The body ends a moment after the last event (a separate write, as over a real network): cutting the stream at the event closed the connection.
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(2400)))); response.write(done); setTimeout(() => response.end(), 30); });
  try {
    const {voice} = voiceFor(server);
    await voice.synthesizeStream('judy-alvarez', 'First line.', collect());
    await wait(120);   // the body has ended (30 ms after its last event), inside the drain limit (250 ms)
    await voice.synthesizeStream('judy-alvarez', 'Second line.', collect());
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[1].socket, server.requests[0].socket, 'the second request came over the first one\'s connection');
  } finally { await server.close(); }
});

test('a stream that stays open after its last event is closed after drainMs, and the reply never waits for that', async () => {
  let ended = null;
  const server = await serve((request, response) => {
    sse(response); response.write(delta(bytesOf(samples(2400)))); response.write(done);
    response.on('close', () => { ended = performance.now(); });
  });
  try {
    const {voice} = voiceFor(server, {limits: {drainMs: 150}});
    const started = performance.now(), sink = collect();
    const result = await voice.synthesizeStream('judy-alvarez', 'Hi.', sink);
    const answered = performance.now();
    assert.equal(result.frames, 2400); assert.equal(result.truncated, false); assert.equal(sink.packets.length, 1);
    assert.ok(answered - started < 140, `the reply resolved at its last event (${Math.round(answered - started)} ms), not after the drain`);
    await wait(400);
    assert.ok(ended !== null, 'the open stream was closed');
    assert.ok(ended - answered >= 100, `it was closed at the drain limit (${Math.round(ended - answered)} ms after the reply)`);
  } finally { await server.close(); }
});

test('a speech request to Mistral goes through the text routes\' connection pool (fetchOptions); a test server or another fetch gets none', async () => {
  const pool = {name: 'shared keep-alive pool'}, seen = [], asked = [];
  const body = () => new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode(delta(bytesOf(samples(2400))) + done)); controller.close(); }});
  const fetchImpl = async (url, init) => { seen.push(init); return new Response(body(), {status: 200, headers: {'content-type': 'text/event-stream'}}); };
  const voice = new VoxtralVoice({getKey: () => KEY, referenceRoot: resolve('fixture-references'), registry: registryOf(), read: async () => REFERENCE,
    scheduler: fastScheduler(), fetchImpl, fetchOptions: async (url, impl) => { asked.push([url, impl === fetchImpl]); return {dispatcher: pool}; }});
  await voice.synthesizeStream('judy-alvarez', 'Hi.', collect());
  assert.deepEqual(asked, [['https://api.mistral.ai/v1/audio/speech', true]]);
  assert.equal(seen[0].dispatcher, pool);
  // The default rule (bridge/mistral-client.mjs cloudFetchOptions): only the built-in fetch to api.mistral.ai gets the pool.
  const {cloudFetchOptions} = await import('./mistral-client.mjs');
  assert.deepEqual(await cloudFetchOptions('http://127.0.0.1:9/v1/audio/speech'), {});
  assert.deepEqual(await cloudFetchOptions('https://api.mistral.ai/v1/audio/speech', fetchImpl), {});
  const shared = await cloudFetchOptions('https://api.mistral.ai/v1/audio/speech');
  assert.ok(shared.dispatcher && typeof shared.dispatcher.dispatch === 'function', 'the built-in fetch to Mistral gets the keep-alive Agent');
  assert.equal((await cloudFetchOptions('https://api.mistral.ai/v1/chat/completions')).dispatcher, shared.dispatcher, 'the same pool as the text routes');
});

test('cancelling the reply aborts the request and is neither a fallback nor a degradation', async () => {
  const server = await serve(async (request, response) => { await wait(500); response.destroy(); });
  try {
    const {voice} = voiceFor(server), controller = new AbortController(), sink = collect();
    const call = voice.synthesizeStream('judy-alvarez', 'Hi.', {signal: controller.signal, onPcm: sink.onPcm});
    await wait(40); controller.abort();
    await assert.rejects(call, error => error.name === 'AbortError' || /cancel/i.test(error.message));
    assert.equal(voice.degraded, null); assert.equal(sink.packets.length, 0);
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hi.', {signal: controller.signal, onPcm: sink.onPcm}), {name: 'AbortError'});
  } finally { await server.close(); }
});

test('an error from the PCM consumer is passed on as it is, marked, and does not blame the service', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(5000)))); response.end(done); });
  try {
    const {voice} = voiceFor(server);
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hi.', {onPcm: () => { throw Error('renderer stopped'); }}),
      error => error.sink === true && error.message === 'renderer stopped');
    assert.equal(voice.degraded, null);
  } finally { await server.close(); }
});

test('the events parser handles CRLF, comments, split chunks and a last event without a blank line', async () => {
  const chunks = [': keep-alive\r\n', 'event: x\r\nda', 'ta: {"a"', ':1}\r\n\r\ndata: two\n', '\ndata: three'].map(text => Buffer.from(text));
  const out = []; for await (const value of sseEvents(chunks)) out.push(value);
  assert.deepEqual(out, ['{"a":1}', 'two', 'three']);
});

test('capWav cuts a long reference to the working length and fixes the header; shorter and foreign files are untouched', () => {
  const long = wav(30), cut = capWav(long, 25);
  assert.equal(cut.length, 44 + 25 * 24000 * 2); assert.equal(cut.readUInt32LE(40), 25 * 24000 * 2); assert.equal(cut.readUInt32LE(4), cut.length - 8);
  const short = wav(5); assert.equal(capWav(short, 25), short);
  const other = Buffer.from('not a wav file at all, just bytes'); assert.equal(capWav(other, 25), other);
  assert.equal(VOXTRAL_LIMITS.firstAudioMs, 7000);
});

// ---- where the reference comes from: long set, short set, Pocket, then clips extracted for the character ----------------------

// A mono PCM16 WAV of `seconds` at `rate`, every sample `level` (so a joined file shows which clip each part came from).
function tone(seconds, level, rate = 24000) {
  const frames = Math.round(seconds * rate), bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let at = 0; at < frames; at++) bytes.writeInt16LE(level, 44 + at * 2);
  return bytes;
}
const dataOf = bytes => bytes.subarray(44);

test('joinWavs: clips of one format are joined until the target length; other formats, other file types and too-long clips are skipped', () => {
  const joined = joinWavs([tone(5, 100), tone(5, 200), tone(5, 300), tone(5, 400)], {targetSeconds: 12, maxSeconds: 25});
  assert.equal(joined.toString('latin1', 0, 4), 'RIFF');
  assert.equal(joined.readUInt32LE(24), 24000);
  assert.equal(dataOf(joined).length, 15 * 24000 * 2, 'three 5 s clips reach the 12 s target; the fourth is not read');
  assert.equal(joined.readUInt32LE(40), dataOf(joined).length);
  assert.equal(joined.readUInt32LE(4), joined.length - 8);
  assert.equal(dataOf(joined).readInt16LE(0), 100); assert.equal(dataOf(joined).readInt16LE(5 * 24000 * 2), 200);
  assert.equal(dataOf(joined).readInt16LE(10 * 24000 * 2), 300);
  // Another sample rate, a non-WAV file and an empty clip do not join; a clip that would pass the maximum is left out.
  const mixed = joinWavs([tone(3, 7), tone(3, 8, 48000), Buffer.from('not a wav file at all, but long enough to be looked at'), tone(0, 9), tone(30, 10), tone(4, 11)], {targetSeconds: 12, maxSeconds: 25});
  assert.equal(dataOf(mixed).length, 7 * 24000 * 2); assert.equal(dataOf(mixed).readInt16LE(3 * 24000 * 2), 11);
  // A single clip longer than the maximum is kept (the caller cuts it); nothing usable is null.
  assert.equal(dataOf(joinWavs([tone(30, 5)])).length, 30 * 24000 * 2);
  assert.equal(joinWavs([]), null); assert.equal(joinWavs([Buffer.alloc(10)]), null);
});

function sourceFixture({files = {}, folders = {}, registries}) {
  const reads = [], lists = [];
  const root = resolve('fixture-references');
  const name = path => path.slice(root.length + 1).split(/[\\/]/).join('/');
  const voice = new VoxtralVoice({getKey: () => KEY, referenceRoot: root, registry: registries,
    read: async path => { reads.push(name(path)); const bytes = files[name(path)]; if (!bytes) throw Error('ENOENT'); return bytes; },
    list: async path => { lists.push(name(path)); const names = folders[name(path)]; if (!names) throw Error('ENOENT'); return names; },
    scheduler: fastScheduler()});
  return {voice, reads, lists};
}
const registryFile = (key, file, bytes) => createVoiceProfileRegistry({version: 2, provider: 'hybrid', engine: 'omnivoice',
  voices: {[key]: {reference: `runtime/voice-references/${file}`, sha256: sha(bytes), transcript: 'Ready when you are, V.'}}});

test('the reference of a voice: the OmniVoice long clip, else the short one, else the Pocket one; a clip that fails its hash passes the turn on', async () => {
  const long = tone(2, 1), short = tone(3, 2), pocket = tone(4, 3);
  const registries = [registryFile('judy-alvarez', 'long/judy.wav', long), registryFile('judy-alvarez', 'short/judy.wav', short),
    registryFile('judy-alvarez', 'pocket/judy.wav', pocket)];
  const files = {'long/judy.wav': long, 'short/judy.wav': short, 'pocket/judy.wav': pocket};
  const all = sourceFixture({files, registries});
  const first = await all.voice.reference('judy-alvarez');
  assert.equal(first.base64, long.toString('base64')); assert.equal(first.source, 'omni-long');
  assert.deepEqual(all.reads, ['long/judy.wav']);
  // The long clip is missing: the short one is next.
  const noLong = sourceFixture({files: {...files, 'long/judy.wav': undefined}, registries});
  const second = await noLong.voice.reference('judy-alvarez');
  assert.equal(second.base64, short.toString('base64')); assert.equal(second.source, 'omni-short');
  // The short clip fails its hash as well: Pocket's reference.
  const changed = sourceFixture({files: {...files, 'long/judy.wav': undefined, 'short/judy.wav': tone(3, 99)}, registries});
  const third = await changed.voice.reference('judy-alvarez');
  assert.equal(third.base64, pocket.toString('base64')); assert.equal(third.source, 'pocket');
  assert.deepEqual(changed.reads, ['long/judy.wav', 'short/judy.wav', 'pocket/judy.wav']);
  // A character that is only in the Pocket registry (the other two list it as unprepared) is cloned from the Pocket clip.
  const onlyPocket = sourceFixture({files, registries: [createVoiceProfileRegistry({}), createVoiceProfileRegistry({}), registries[2]]});
  assert.equal((await onlyPocket.voice.reference('judy-alvarez')).source, 'pocket');
});

test('a character with no registered clip is cloned from clips extracted for them; with none at all there is no reference and Pocket speaks', async () => {
  const a = tone(5, 10, 48000), b = tone(5, 20, 48000), c = tone(5, 30, 48000), d = tone(5, 40, 48000);
  const files = {'extracted/8ug8ear/b.wav': b, 'extracted/8ug8ear/a.wav': a, 'extracted/8ug8ear/c.wav': c, 'extracted/8ug8ear/d.wav': d,
    'extracted/8ug8ear/a.txt': Buffer.from('text')};
  const folders = {'extracted/8ug8ear': ['b.wav', 'a.wav', 'a.txt', 'c.wav', 'd.wav']};
  const registries = [createVoiceProfileRegistry({}), createVoiceProfileRegistry({}), createVoiceProfileRegistry({})];
  const fixture = sourceFixture({files, folders, registries});
  const found = await fixture.voice.reference('8ug8ear');
  assert.equal(found.source, 'extracted');
  const joined = Buffer.from(found.base64, 'base64');
  assert.equal(joined.readUInt32LE(24), 48000);
  assert.equal(dataOf(joined).length, 15 * 48000 * 2, 'clips in name order, joined until 12 s is reached (three of the four)');
  assert.equal(dataOf(joined).readInt16LE(0), 10); assert.equal(dataOf(joined).readInt16LE(5 * 48000 * 2), 20);
  assert.equal(dataOf(joined).readInt16LE(10 * 48000 * 2), 30);
  assert.deepEqual(fixture.reads, ['extracted/8ug8ear/a.wav', 'extracted/8ug8ear/b.wav', 'extracted/8ug8ear/c.wav'], 'the fourth clip is not read');
  // Sent to Mistral it is the cap-cut joined file, and the reply is spoken by Voxtral.
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done); });
  try {
    const speaker = sourceFixture({files, folders, registries});
    speaker.voice.endpoint = server.endpoint;
    const result = await speaker.voice.synthesizeStream('8ug8ear', 'Hi there.', collect());
    assert.equal(result.timing.voiceReferenceSource, 'extracted');
    assert.equal(server.requests[0].body.ref_audio, found.base64);
  } finally { await server.close(); }
  // No clip at all for this character: no reference, and nothing leaves this computer.
  const none = sourceFixture({files: {}, folders: {}, registries});
  assert.equal(await none.voice.reference('jake-estevez'), null);
  assert.deepEqual(none.lists, ['extracted/jake-estevez']);
  const empty = sourceFixture({files: {}, folders: {'extracted/jake-estevez': ['readme.txt']}, registries});
  assert.equal(await empty.voice.reference('jake-estevez'), null);
  await assert.rejects(none.voice.synthesizeStream('jake-estevez', 'Hi.', collect()), {kind: 'no-reference'});
});

test('extracted clips are only looked for under the character\'s own folder: not for a second voice of a profile, not for a key that could name another folder', async () => {
  const folders = {'extracted/judy-alvarez': ['a.wav'], 'extracted/judy-alvarez-v2': ['a.wav']};
  const files = {'extracted/judy-alvarez/a.wav': tone(2, 5), 'extracted/judy-alvarez-v2/a.wav': tone(2, 6)};
  const fixture = sourceFixture({files, folders, registries: []});
  assert.equal(await fixture.voice.reference('judy-alvarez-v2'), null, 'a variant is a different voice');
  for (const key of ['../judy-alvarez', 'Judy', 'a/b', '', '..', 'judy alvarez']) assert.equal(await fixture.voice.reference(key), null, JSON.stringify(key));
  assert.deepEqual(fixture.lists, [], 'no folder was listed for them');
  assert.ok(await fixture.voice.reference('judy-alvarez'));
});

// ---- ordinary NPCs: one clip, always the same one ------------------------------------------------------------------------------

// A reference joined the way scripts/archetype-voices does: [seconds, level] parts, level 0 being digital silence (the edges and the seams).
function joinedOf(parts, rate = 24000) {
  const frames = parts.reduce((sum, [seconds]) => sum + Math.round(seconds * rate), 0), bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  let at = 44;
  for (const [seconds, level] of parts) for (let n = Math.round(seconds * rate); n > 0; n--, at += 2) bytes.writeInt16LE(level, at);
  return bytes;
}
// Three lines, each with 0.3 s of silent edges, and 0.4 s between them: a seam of about a second.
const threeLines = (a = 3, b = 5, c = 4) => joinedOf([[0.3, 0], [a, 100], [0.3, 0], [0.4, 0], [0.3, 0], [b, 200], [0.3, 0], [0.4, 0], [0.3, 0], [c, 300], [0.3, 0]]);
const levelsOf = bytes => new Set(Array.from({length: (bytes.length - 44) >> 1}, (_, at) => bytes.readInt16LE(44 + at * 2)));

test('singleClip: the longest of the joined clips, cut at the seams and trimmed, the first one when two are as long; nothing to choose gives null', () => {
  const one = singleClip(threeLines(3, 5, 4));
  assert.equal(one.readUInt32LE(24), 24000); assert.equal(one.readUInt32LE(4), one.length - 8); assert.equal(one.readUInt32LE(40), one.length - 44);
  assert.equal(one.length - 44, 5 * 24000 * 2, 'the 5 s clip, with none of its silent edges');
  assert.deepEqual([...levelsOf(one)], [200], 'every sample comes from that one clip');
  assert.deepEqual([...levelsOf(singleClip(threeLines(4, 4, 3)))], [100], 'equal lengths: the first');
  assert.deepEqual(singleClip(threeLines(3, 5, 4)), one, 'the same file always gives the same clip');
  // A pause inside a line (under the seam length) does not split it.
  const pause = joinedOf([[0.3, 0], [2, 100], [0.5, 0], [2, 100], [0.3, 0], [0.4, 0], [0.3, 0], [3, 200], [0.3, 0]]);
  assert.equal(singleClip(pause).length - 44, (2 + 0.5 + 2) * 24000 * 2, 'a 4.5 s line with its own pause is longer than the 3 s one');
  // Nothing to choose: one clip, a longest clip that is too short to clone from, another file type, 8-bit audio.
  assert.equal(singleClip(joinedOf([[0.3, 0], [6, 100], [0.3, 0]])), null);
  assert.equal(singleClip(threeLines(1.5, 1.2, 1)), null);
  assert.equal(SINGLE_CLIP.minSeconds, 2);
  assert.equal(singleClip(Buffer.from('not a wav file at all, but long enough to be looked at')), null);
  assert.equal(singleClip(Buffer.alloc(10)), null);
  const eight = threeLines(); eight.writeUInt16LE(8, 34);
  assert.equal(singleClip(eight), null);
});

test('an ordinary NPC is cloned from one clip, the same one for every request; a named character keeps its whole reference', async () => {
  const joined = threeLines(3, 5, 4), file = 'archetypes/omni-long/npc-homeless-female-v2.wav';
  const named = joinedOf([[0.3, 0], [3, 100], [1, 0], [5, 200], [0.3, 0]]);
  const registries = [createVoiceProfileRegistry({version: 2, provider: 'hybrid', engine: 'omnivoice', voices: {
    'npc-homeless-female-v2': {reference: `runtime/voice-references/${file}`, sha256: sha(joined), transcript: 'None o\' your biz.'},
    'judy-alvarez': {reference: 'runtime/voice-references/picked/autobest/omni-long/judy-alvarez.wav', sha256: sha(named), transcript: 'Ready when you are, V.'}}})];
  const files = {[file]: joined, 'picked/autobest/omni-long/judy-alvarez.wav': named}, prepared = [], logs = [];
  const root = resolve('fixture-references');
  const voice = new VoxtralVoice({getKey: () => KEY, referenceRoot: root, registry: registries, scheduler: fastScheduler(), onLog: line => logs.push(line),
    read: async path => files[path.slice(root.length + 1).split(/[\\/]/).join('/')] ?? Promise.reject(Error('ENOENT')),
    prepare: async (bytes, options) => { prepared.push({bytes, options}); return null; }});
  const first = await voice.reference('npc-homeless-female-v2');
  const sent = Buffer.from(first.base64, 'base64');
  assert.deepEqual([...levelsOf(sent)], [200]); assert.equal(sent.length - 44, 5 * 24000 * 2);
  assert.equal(first.source, 'omni-long');
  assert.equal(await voice.reference('npc-homeless-female-v2'), first, 'built once per voice: every request and every reply of the conversation sends these bytes');
  // The prepared slot is keyed by the clip, not by the joined file (a slot made from the joined file would be used in its place).
  assert.equal(prepared.length, 1); assert.deepEqual(prepared[0].bytes, sent);
  assert.notEqual(prepared[0].options.sha256, sha(joined)); assert.match(prepared[0].options.sha256, /^[0-9a-f]{64}$/);
  assert.ok(logs.some(line => line.includes('npc-homeless-female-v2: cloned from one clip, 5 s of the')), logs.join(''));
  // A named character is not touched: its reference goes on as the whole file.
  const whole = await voice.reference('judy-alvarez');
  assert.equal(whole.base64, named.toString('base64'));
  assert.equal(prepared[1].options.sha256, sha(named));
});

// ---- the voice selection: menu choice, fallback to Pocket, one report ---------------------------------------------------------

const pocketSettings = voices => ({version: 1, provider: 'pocket', engine: 'pocket-tts', voices,
  runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('fixture', key)])),
  model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64),
    inputIdentity: 'e'.repeat(64), selectedStep: 1500}});

function selection(server, {key = KEY, voxtral = {}, pocket = null, retryMs = 150, extra = {}} = {}) {
  const calls = [], states = [], workers = [];
  const voices = Object.fromEntries(LOCAL_VOICE_KEYS.map(name => [name, {reference: `runtime/voice-references/${name}.wav`,
    sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.'}]));
  const cloud = new VoxtralVoice({getKey: () => key, referenceRoot: resolve('fixture-references'), endpoint: server.endpoint,
    read: async () => REFERENCE, scheduler: fastScheduler(), ...voxtral});
  const longVoices = Object.fromEntries(LOCAL_VOICE_KEYS.map(name => [name, {reference: `runtime/voice-references/${name}.wav`,
    sha256: sha(REFERENCE), transcript: 'Ready when you are, V.'}]));
  const voice = new VoiceSelection(pocketSettings(voices), {voxtral: cloud, onState: value => states.push(value), cloudRetryAudioMs: {voxtral: retryMs}, ...extra,
    omniConfigs: {short: {}, long: {version: 2, provider: 'hybrid', engine: 'omnivoice', voices: longVoices}},
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

test('the Mistral cloud voice rides on Pocket: chosen, it speaks the reply, and Pocket is not asked', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(4800)))); response.end(done); });
  try {
    const h = selection(server);
    assert.equal(h.voice.cloud, null);
    h.voice.update({voiceProvider: 'voxtral'}, null, true);
    assert.equal(h.voice.cloud, null, 'a change waits for a moment with no reply in flight'); assert.equal(h.voice.pending, true);
    h.voice.update({voiceProvider: 'voxtral'}, null, false);
    assert.equal(h.voice.cloud, 'voxtral'); assert.equal(h.voice.provider, 'pocket'); assert.equal(h.voice.requestedProvider, 'pocket');
    assert.equal(h.voice.pending, false); assert.equal(h.voice.cloudActive, true);
    await h.voice.start();
    h.voice.publish();
    assert.equal(h.states.at(-1).cloudVoice, 'voxtral'); assert.equal(h.states.at(-1).fallback, null);
    const packets = [];
    const result = await h.voice.synthesizeStream('judy-alvarez', 'Uh... [laughter] okay.', {onPcm: packet => { packets.push(packet); }});
    assert.equal(result.provider, 'voxtral'); assert.equal(packets.length, 2); assert.equal(h.calls.length, 0);
    assert.equal(server.requests[0].body.input, 'Uh... okay.', 'voice tags never reach the cloud voice');
    // Choosing another voice takes it back.
    h.voice.update({voiceProvider: 'pocket'}, null, false);
    assert.equal(h.voice.cloud, null); assert.equal(h.voice.cloudActive, false);
    await h.voice.synthesizeStream('judy-alvarez', 'Pocket now.', {onPcm() {}});
    assert.equal(h.calls.length, 1);
    await h.voice.close();
  } finally { await server.close(); }
});

test('a first ask that times out and a second one that speaks never announce a switch to the Convai voice (the false "Mistral cloud voice is not ready, using Convai" notice of the 2026-10-20 live test)', async () => {
  let mode = 'slow-once';
  const server = await serve(async (request, response) => {
    if (mode === 'slow-once') { mode = 'ok'; return; }          // the first request is never answered: only the limit ends it
    sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done);
  });
  try {
    const timers = manualTimers();
    const h = selection(server, {voxtral: {...timers.hooks, limits: {firstAudioMs: 60, drainMs: 5000}}, retryMs: 120});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const packets = [];
    const spoken = track(h.voice.synthesizeStream('judy-alvarez', 'A slow first ask.', {onPcm: packet => { packets.push(packet); }}));
    await until(() => server.requests.length === 1, 'the first ask to reach the server');
    await timers.clock.advance(60);
    await until(() => spoken.done, 'the second ask to be answered');
    assert.equal(spoken.error, undefined, String(spoken.error)); assert.equal(spoken.value.provider, 'voxtral'); assert.equal(server.requests.length, 2);
    // The first ask's failure was published (the cloud voice became degraded for a moment), and none of what was published says the companions
    // are on the Convai voice: the game reads `fallback` of every state and turns it into the notice.
    assert.equal(h.states.some(state => state.voxtral?.degraded === 'timeout'), true, 'the hiccup itself was reported to the state');
    assert.equal(h.states.some(state => state.fallback), false, 'no published state announced a fallback');
    h.voice.publish();
    assert.equal(h.states.at(-1).fallback, null); assert.equal(h.states.at(-1).voxtral.degraded, null);
    await h.voice.close();
  } finally { await server.close(); }
});

test('what really blocks the cloud voice (no key, a refused key, a limit cooling down) is still published as the fallback to the Convai voice', async () => {
  const server = await serve((request, response) => { response.writeHead(429, {'retry-after': '30'}); response.end(); });
  try {
    let key = null;
    const h = selection(server); h.cloud.getKey = () => key;
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    h.voice.publish();
    assert.deepEqual(h.states.at(-1).fallback, {from: 'voxtral', to: 'convai', temporary: false, reason: 'no-key'});
    key = KEY;
    h.voice.publish();
    assert.equal(h.states.at(-1).fallback, null, 'the key is back');
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Limited.', {onPcm() {}}), {kind: 'limit'});
    assert.equal(h.states.at(-1).fallback?.reason, 'limit', 'a limit cooling down is a real block');
    assert.equal(h.states.at(-1).fallback?.to, 'convai');
    await h.voice.close();
  } finally { await server.close(); }
});

test('Mature content bars the cloud voice: a saved Voxtral choice is Pocket, nothing reaches the server, a committed cloud voice refuses a reply (the written reply stands), and Voxtral returns when the bar goes', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done); });
  try {
    let barred = true;
    const h = selection(server, {extra: {cloudBarred: () => barred}});
    // Barred from the start: Voxtral is saved, Pocket is the voice, and no worker or request is for the cloud.
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    assert.equal(h.voice.cloud, null); assert.equal(h.voice.cloudWanted, false); assert.equal(h.voice.cloudActive, false);
    assert.equal(h.voice.requestedProvider, 'pocket'); assert.equal(h.voice.provider, 'pocket');
    const local = await h.voice.synthesizeStream('judy-alvarez', 'Pocket speaks.', {onPcm() {}});
    assert.equal(local.audio, 'pocket'); assert.equal(h.calls.length, 1); assert.equal(server.requests.length, 0);
    // The bar goes (Mature content off): the saved choice is Voxtral again, at the next idle moment.
    barred = false;
    h.voice.update({voiceProvider: 'voxtral'}, null, false);
    assert.equal(h.voice.cloud, 'voxtral'); assert.equal(h.voice.cloudActive, true);
    const cloud = await h.voice.synthesizeStream('judy-alvarez', 'Voxtral speaks.', {onPcm() {}});
    assert.equal(cloud.provider, 'voxtral'); assert.equal(server.requests.length, 1);
    // The bar comes back while the cloud voice is committed (before the next idle moment): a reply that still reaches it is not sent.
    barred = true;
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Not to the cloud.', {onPcm() {}}), /Mature content/);
    assert.equal(server.requests.length, 1, 'no request left the computer');
    // The next idle moment commits Pocket.
    h.voice.update({voiceProvider: 'voxtral'}, null, false);
    assert.equal(h.voice.cloud, null); assert.equal(h.voice.cloudActive, false);
    await h.voice.close();
  } finally { await server.close(); }
});

test('a cloud reply that is late is asked again once with a longer wait; one that still fails is a written reply, never a local voice; the report names why and clears itself', async () => {
  // The two limits (60 ms, then 120 ms) are timers of the voice, moved by a manual clock only after the ask they must cut has reached the server:
  // on a loaded machine a real 60 ms limit can cut an ask before it is even sent, and the server would never see it.
  let mode = 'slow';
  const server = await serve(async (request, response) => {
    if (mode === 'slow') return;                                  // never answers: only the limit ends the ask
    if (mode === 'slow-once') { mode = 'ok'; return; }
    if (mode === 'limit') { response.writeHead(429, {'retry-after': '30'}); response.end(); return; }
    sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done);
  });
  try {
    const timers = manualTimers();
    const h = selection(server, {voxtral: {...timers.hooks, limits: {firstAudioMs: 60, drainMs: 5000}}, retryMs: 120});    // drainMs: the background read of a finished stream arms its own timer (not an ask limit): kept out of the 0 to 1000 ms list below
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const packets = [], asked = () => timers.limits().filter(ms => ms < 1000);
    // Both asks are late: nothing is spoken, no local voice stands in, and the caller gets the failure (a written reply).
    const late = track(h.voice.synthesizeStream('judy-alvarez', 'Late reply.', {onPcm: packet => { packets.push(packet); }}));
    await until(() => server.requests.length === 1, 'the first ask to reach the server');
    await timers.clock.advance(60);
    await until(() => server.requests.length === 2, 'the second ask to reach the server');
    assert.equal(late.done, false, 'the first ask is not the end of it');
    await timers.clock.advance(120);
    await until(() => late.done, 'the second ask to end at its limit');
    assert.equal(late.error?.kind, 'timeout', String(late.error));
    assert.equal(server.requests.length, 2, 'asked, then asked once more'); assert.equal(packets.length, 0);
    assert.deepEqual(asked(), [60, 120], 'the second ask waits longer than the first');
    assert.equal(h.calls.length, 0); assert.equal(h.workers.length, 0, 'no local worker was ever created');
    assert.deepEqual(h.voice.cloudFallback, {from: 'voxtral', to: 'convai', temporary: true, reason: 'timeout'});
    h.voice.publish();
    // Not announced as a switch to the Convai voice: the next reply asks the cloud voice again (the 2026-10-20 live test showed "Companions are using
    // Convai for now" after one slow first ask). The reason stays in the state for the support report.
    assert.equal(h.states.at(-1).fallback, null);
    assert.equal(h.states.some(state => state.fallback), false, 'no state published during this test announced a fallback');
    assert.equal(h.states.at(-1).cloudVoice, 'voxtral'); assert.equal(h.states.at(-1).voxtral.degraded, 'timeout');
    // The first ask is late but the longer second one is answered: the reply is spoken, and the report clears.
    mode = 'slow-once'; const before = server.requests.length;
    const second = track(h.voice.synthesizeStream('judy-alvarez', 'Second ask works.', {onPcm: packet => { packets.push(packet); }}));
    await until(() => server.requests.length - before === 1, 'the first ask to reach the server');
    await timers.clock.advance(60);
    await until(() => second.done, 'the second ask to be answered');
    assert.equal(second.error, undefined, String(second.error));
    assert.equal(second.value.provider, 'voxtral'); assert.equal(server.requests.length - before, 2); assert.equal(packets.length, 1);
    assert.deepEqual(asked(), [60, 120, 60, 120]);
    assert.equal(h.voice.cloudFallback, null);
    // A limit is not asked again (the server said when to come back); inside the cool-down the cloud voice is not even asked.
    mode = 'limit'; const limited = server.requests.length;
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Limited.', {onPcm() {}}), {kind: 'limit'});
    assert.equal(server.requests.length - limited, 1); assert.equal(h.voice.cloudFallback.reason, 'limit');
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Still limited.', {onPcm() {}}), /waiting out a limit/);
    assert.equal(server.requests.length - limited, 1);
    assert.equal(h.calls.length, 0); assert.equal(h.workers.length, 0);
    assert.equal(h.states.some(state => state.fallback?.reason === 'limit'), true);
    await h.voice.close();
  } finally { await server.close(); }
});

test('without a Mistral key the cloud voice is unavailable, the turn goes to the Convai voice, and nothing local is loaded; a key added later is used at once', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done); });
  try {
    let key = null;
    const h = selection(server); h.cloud.getKey = () => key;
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    assert.deepEqual(h.voice.cloudFallback, {from: 'voxtral', to: 'convai', temporary: false, reason: 'no-key'});
    assert.equal(h.voice.cloudKeyless, true, 'the bridge sends this turn to the Convai cloud voice');
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'No key.', {onPcm() {}}), /no key/);
    assert.equal(server.requests.length, 0); assert.equal(h.calls.length, 0); assert.equal(h.workers.length, 0);
    key = KEY;
    assert.equal(h.voice.cloudFallback, null, 'the key is back, so the report is gone'); assert.equal(h.voice.cloudKeyless, false);
    const cloud = await h.voice.synthesizeStream('judy-alvarez', 'With a key.', {onPcm() {}});
    assert.equal(cloud.provider, 'voxtral'); assert.equal(h.voice.cloudFallback, null);
    assert.equal(h.workers.length, 0);
    await h.voice.close();
  } finally { await server.close(); }
});

test('a cloud voice starts no local worker: not on the choice, not when characters are prepared, not for a reply; a running one is retired', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done); });
  try {
    const h = selection(server);
    // Pocket is the choice first and its worker runs.
    h.voice.update({voiceProvider: 'pocket'}, null, false); await h.voice.start();
    assert.equal(h.workers.length, 1); assert.equal(h.voice.clientBackend, 'pocket');
    // The cloud voice is chosen (committed at an idle moment): the worker is retired and no other one is created.
    h.voice.update({voiceProvider: 'voxtral'}, null, false);
    assert.equal(h.voice.cloudActive, true); assert.equal(h.voice.client, null, 'the Pocket worker is gone');
    await h.voice.retiring;
    assert.equal(h.voice.targetBackend, null);
    const receipt = await h.voice.prepareProfile('judy-alvarez');
    assert.equal(receipt.ready, true); assert.equal(receipt.cloudVoice, 'voxtral'); assert.equal(h.voice.profileReady('judy-alvarez'), true);
    await h.voice.start();
    const result = await h.voice.synthesizeStream('judy-alvarez', 'Hello.', {onPcm() {}});
    assert.equal(result.provider, 'voxtral');
    for (let poll = 0; poll < 3; poll++) h.voice.update({voiceProvider: 'voxtral'}, null, false);
    assert.equal(h.workers.length, 1, 'only the first Pocket worker was ever created'); assert.equal(h.voice.client, null);
    assert.equal(h.states.at(-1).state, 'remote'); assert.equal(h.states.at(-1).workerBackend, null);
    // A failed Pocket earlier does not take the route from the cloud voice.
    h.voice.failedBackends.add('pocket');
    h.voice.update({voiceProvider: 'voxtral'}, null, false);
    assert.equal(h.voice.provider, 'pocket'); assert.equal(h.voice.cloudActive, true);
    await h.voice.close();
  } finally { await server.close(); }
});

test('switching to the cloud voice: the first audio does not wait for any local worker and no Pocket worker is created', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done); });
  try {
    const h = selection(server);
    h.voice.update({voiceProvider: 'voxtral'}, null, false);
    // Not "fast enough" in milliseconds (a local worker is a fake that starts at once, so a clock could not tell): at the moment the first audio
    // reaches the player no worker has been asked for, and none ever is.
    let workersAtFirstAudio = null;
    await h.voice.synthesizeStream('judy-alvarez', 'Right after the switch.', {onPcm: () => { workersAtFirstAudio ??= h.workers.length; }});
    assert.equal(workersAtFirstAudio, 0, 'the first audio did not wait for (or start) a local worker');
    assert.equal(h.workers.length, 0);
    await h.voice.close();
  } finally { await server.close(); }
});

test('a consumer error or a cancelled reply is not a fallback to Pocket', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done); });
  try {
    const h = selection(server);
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Hi.', {onPcm: () => { throw Error('renderer stopped'); }}), /renderer stopped/);
    assert.equal(h.calls.length, 0);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Hi.', {signal: controller.signal, onPcm() {}}), {name: 'AbortError'});
    assert.equal(h.calls.length, 0);
    await h.voice.close();
  } finally { await server.close(); }
});

test('the Voxtral voice speaks the language of the text, and a Pocket choice stays on Pocket (an old multilingualConversations is not read)', async () => {
  const server = await serve((request, response) => { response.end(); });
  try {
    const h = selection(server);
    h.voice.update({voiceProvider: 'voxtral', multilingualConversations: true}, null, false);
    assert.equal(h.voice.provider, 'pocket'); assert.equal(h.voice.cloudActive, true); assert.equal(h.voice.cloud, 'voxtral');
    assert.equal(h.cloud.speaks('es'), true); assert.equal(h.cloud.speaks('cs'), false, 'Czech is not one of the languages Mistral names for Voxtral TTS 3');
    h.voice.update({voiceProvider: 'pocket', multilingualConversations: true}, null, false);
    assert.equal(h.voice.provider, 'pocket'); assert.equal(h.voice.cloudActive, false);
    await h.voice.close();
  } finally { await server.close(); }
});

test('the routing log names the cloud voice; with a reason only when the cloud voice cannot be asked (never a local voice); an earlier timeout is carried as cloudLast', async () => {
  const server = await serve(async () => { await wait(300); });
  try {
    const h = selection(server, {voxtral: {limits: {firstAudioMs: 40}}});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const describe = () => describeVoiceRoute({voice: h.voice, input: {profileKey: 'judy-alvarez'}, profile: {key: 'judy-alvarez', name: 'Judy'},
      plan: {engine: 'pocket'}, reply: {engine: 'pocket'}, now: () => 0});
    let record = describe();
    assert.equal(record.requested, 'Mistral cloud voice (Voxtral)'); assert.equal(record.used, 'Mistral cloud voice (Voxtral)'); assert.equal(record.fallback, null);
    assert.ok(record.reference, 'the log names the reference the cloud voice clones from');
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Late.', {onPcm() {}}), {kind: 'timeout'});
    // The line for the NEXT reply is written before that reply is voiced: a timeout on this one must not make it claim Pocket (2026-10-13:
    // the line said used=Pocket for a reply that Voxtral then spoke from start to end).
    record = describe();
    assert.equal(record.used, 'Mistral cloud voice (Voxtral)'); assert.equal(record.fallback, null); assert.equal(record.cloudLast, 'timeout');
    const line = formatVoiceRoute(record);
    assert.ok(line.includes('used="Mistral cloud voice (Voxtral)"') && line.includes('cloudLast=timeout') && !line.includes('fallback='), line);
    // No key: the cloud voice cannot be asked at all. The turn goes to the Convai voice (engine 'convai'); a reply that still reached the
    // cloud route is written only. No local voice is named, and the line says why.
    h.cloud.getKey = () => null;
    record = describe();
    assert.equal(record.used, 'none (written reply only)'); assert.equal(record.fallback, 'Mistral cloud voice has no key'); assert.equal(record.cloudLast, undefined);
    assert.ok(formatVoiceRoute(record).includes('fallback="Mistral cloud voice has no key"'));
    const convai = describeVoiceRoute({voice: h.voice, input: {profileKey: 'judy-alvarez'}, profile: {key: 'judy-alvarez', name: 'Judy', voiceName: 'Anna'},
      plan: {engine: 'convai'}, reply: {engine: 'convai'}, now: () => 0});
    assert.equal(convai.used, 'Convai cloud (Anna)'); assert.equal(convai.fallback, 'Mistral cloud voice has no key');
    await h.voice.close();
  } finally { await server.close(); }
});

// ---- the shared Mistral scheduler: one request per reply, text first, the timeout counts from the send ------------------------

test('a reply of several sentences is one streamed request, never one per sentence', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(9000)))); response.end(done); });
  try {
    const {voice} = voiceFor(server);
    await voice.synthesizeStream('judy-alvarez', 'First sentence. Second one, longer. And a third? Yes! Done.', collect());
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].body.input, 'First sentence. Second one, longer. And a third? Yes! Done.');
  } finally { await server.close(); }
});

test('behind another Mistral request the voice waits its turn, and its first-audio limit starts at the send, not at the queueing', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done); });
  try {
    // One manual clock for the scheduler's 250 ms slot and the voice's 100 ms limit: the slot opens when the test moves the clock past it, and a
    // limit counted from the queueing (not from the send) would fire on the way there. Nothing depends on how fast the machine is.
    const timers = manualTimers(), {clock} = timers, start = clock.now();
    const scheduler = new MistralScheduler({spacingMs: 250, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
    const {voice} = voiceFor(server, {...timers.hooks, scheduler, limits: {firstAudioMs: 100}});
    const order = [];
    const text = scheduler.schedule(async () => { order.push('text'); }, {priority: PRIORITY.TEXT});
    const spoken = track(voice.synthesizeStream('judy-alvarez', 'Queued behind a text request.', {onPcm() { order.push('audio'); }}));
    await until(() => scheduler.stats().queued === 1, 'the speech request to wait for its slot');
    await clock.advance(249);
    assert.equal(server.requests.length, 0, 'it waits for the slot (longer than its own 100 ms first-audio limit)'); assert.equal(spoken.done, false);
    await clock.advance(1);
    await until(() => spoken.done, 'the speech to be answered');
    await text;
    assert.equal(spoken.error, undefined, String(spoken.error));
    assert.equal(spoken.value.truncated, false); assert.equal(voice.degraded, null); assert.equal(server.requests.length, 1);
    assert.equal(order[0], 'text');
    assert.deepEqual(timers.armed.filter(timer => timer.ms === 100).map(timer => timer.at - start), [250], 'the first-audio limit was set at the send, not at the queueing');
  } finally { await server.close(); }
});

test('a text request that arrives while the speech is queued goes first', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done); });
  try {
    // The scheduler's slots (150 ms apart) are on a manual clock: the text request is asked once the speech is known to be waiting in the queue,
    // however long that takes, and the slots open only when the test moves the clock.
    const clock = fakeClock(), order = [];
    const scheduler = new MistralScheduler({spacingMs: 150, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
    const {voice} = voiceFor(server, {scheduler});
    const occupy = scheduler.schedule(async () => { order.push('earlier request'); });
    const speech = voice.synthesizeStream('judy-alvarez', 'Hi.', {onPcm() {}}).then(() => order.push('speech'));
    await until(() => scheduler.stats().queued === 1, 'the speech request to wait in the queue');
    const text = scheduler.schedule(async () => { order.push('text reply'); }, {priority: PRIORITY.TEXT});
    assert.equal(scheduler.stats().queued, 2);
    await clock.advance(150);                 // the next slot: the text request, though it came later
    assert.deepEqual(order, ['earlier request', 'text reply']);
    await clock.advance(150);                 // and then the speech
    await Promise.all([occupy, speech, text]);
    assert.deepEqual(order, ['earlier request', 'text reply', 'speech']);
  } finally { await server.close(); }
});

test('several group speakers go out one after another, spaced by the scheduler, each as its own single request', async () => {
  // The spacing is the scheduler's: measure when it releases each request, not when the local server happens to see it
  // (that arrival time carries scheduling jitter of tens of milliseconds on a loaded machine).
  const times = [];
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done); });
  try {
    const scheduler = new MistralScheduler({spacingMs: 120});
    const schedule = scheduler.schedule.bind(scheduler);
    scheduler.schedule = (task, options) => schedule(() => { times.push(performance.now()); return task(); }, options);
    const {voice} = voiceFor(server, {scheduler});
    await Promise.all(['one', 'two', 'three'].map(name => voice.synthesizeStream('judy-alvarez', `Line ${name}.`, collect())));
    assert.equal(server.requests.length, 3);
    assert.ok(times[1] - times[0] >= 100 && times[2] - times[1] >= 100, `spaced: ${times.map(t => Math.round(t - times[0]))}`);
    assert.deepEqual(server.requests.map(request => request.body.input).sort(), ['Line one.', 'Line three.', 'Line two.']);
  } finally { await server.close(); }
});

test('a line that waits too long in the queue falls back to Pocket without ever being sent', async () => {
  const server = await serve((request, response) => { sse(response); response.end(done); });
  try {
    // The 600 ms slot and the 60 ms queue limit are on one manual clock: the clock is moved past the limit and nowhere near the slot, so the line
    // can only have left the queue because of its limit.
    const clock = fakeClock();
    const scheduler = new MistralScheduler({spacingMs: 600, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
    const {voice} = voiceFor(server, {scheduler, limits: {maxQueueMs: 60}});
    await scheduler.schedule(async () => {});
    const call = track(voice.synthesizeStream('judy-alvarez', 'Too late.', collect()));
    await until(() => scheduler.stats().queued === 1, 'the line to wait in the queue');
    await clock.advance(60);
    await until(() => call.done, 'the line to leave the queue');
    assert.equal(call.error?.kind, 'timeout', String(call.error));
    assert.equal(scheduler.stats().started, 1, 'the slot was never reached');
    assert.equal(server.requests.length, 0); assert.equal(voice.degraded.reason, 'timeout');
  } finally { await server.close(); }
});

test('the voice selection hands Voxtral the long set, the short set and the Pocket set, in that order', async () => {
  const server = await serve((request, response) => { sse(response); response.end(done); });
  try {
    const {voice, cloud} = selection(server);
    assert.equal(cloud.registries.length, 3);
    assert.ok(cloud.registries[0].profiles['judy-alvarez'], 'long set first (this fixture lists the voices there)');
    assert.equal(cloud.registries[1].keys.length, 0, 'the short set is empty in this fixture');
    assert.ok(cloud.registries[2].profiles['judy-alvarez'], 'the Pocket set last');
    await voice.close?.();
  } finally { await server.close(); }
});

// ---- long replies: the first sentence and the rest as two requests sent together --------------------------------------------

const FIRST = 'I did not expect to see you down here, V.';
const REST = 'Anyway, there is a long story behind all of this and I will tell it to you slowly, because you deserve to hear all of it.';
const LONG = `${FIRST} ${REST}`;

test('splitReply: a short reply is one request; a long one splits after the first sentence that holds enough, else at a clause break; a tiny rest is not split off', () => {
  assert.deepEqual(splitReply('Hello there, V.'), ['Hello there, V.']);
  assert.deepEqual(splitReply(LONG), [FIRST, REST]);
  // A short opening joins the next sentence, so the first request is not just "Hey V.".
  const opening = `Hey V. ${FIRST} ${REST}`;
  assert.deepEqual(splitReply(opening), [`Hey V. ${FIRST}`, REST]);
  // Ellipses, question marks, closing quotes and line breaks end a sentence; a decimal point and an abbreviation without a space do not.
  assert.deepEqual(splitReply(`Is that really what you want to do with the rest of your night?" ${REST} ${REST}`), ['Is that really what you want to do with the rest of your night?"', `${REST} ${REST}`]);
  assert.deepEqual(splitReply(`Well... that is something to think about for a while, isn't it? ${REST} ${REST}`)[0], 'Well... that is something to think about for a while, isn\'t it?');
  assert.deepEqual(splitReply(`The cost is 3.5 million eddies and then some more besides that,\n${REST} ${REST}`)[0], 'The cost is 3.5 million eddies and then some more besides that,');
  // No sentence end in reach: the last comma before 120 characters.
  const run = 'we went down to the old market and then across the river, past the burned out towers and the gangs on the corner, and all along the road ' + REST;
  const [head, tail] = splitReply(run);
  assert.ok(head.endsWith('corner,') && head.length <= 120 && run.startsWith(head) && `${head} ${tail}` === run, head);
  // Nothing to cut at, or too little left over: one request.
  assert.equal(splitReply('x'.repeat(200)).length, 1);
  assert.equal(splitReply(`${'a'.repeat(150)}. ok.`).length, 1);
  assert.equal(splitReply(undefined).length, 1);
});

// A server that answers by the text it was sent: `plans[text]` = {delay, hold, after, deltas: [Float32Array...], then: 'done' | 'drop' | status}.
//   delay: a real pause before answering (use it only where the pause is just there to make the server slow).
//   hold: the answer is withheld until the test calls `server.release()`.  after: 'name': the answer waits until the request of that other plan
//   has been answered in full. These two let a test order the server's answers without timing them. Each wait ends by itself after 10 s, so a build
//   that breaks what a test is guarding fails the test instead of hanging it.
// `server.events` lists, in order, '<name> arrived' and '<name> answering' for every request.
function planned(plans) {
  const events = [], latches = {};
  const latch = name => latches[name] ??= (() => { let open; const promise = new Promise(resolve => { open = resolve; }); return {promise, open}; })();
  const ceiling = () => new Promise(finish => setTimeout(finish, 10_000).unref());
  const answer = async (plan, response) => {
    if (plan.delay) await wait(plan.delay);
    if (plan.hold) await Promise.race([latch('release').promise, ceiling()]);
    if (plan.after) await Promise.race([latch(plan.after).promise, ceiling()]);
    events.push(`${plan.name} answering`);
    if (typeof plan.then === 'number') { response.writeHead(plan.then, {'content-type': 'application/json'}); response.end(plan.body ?? '{"message":"no"}'); return; }
    sse(response);
    for (const [index, samplesOut] of (plan.deltas ?? []).entries()) {
      if (index && plan.gap) await wait(plan.gap);
      response.write(delta(bytesOf(samplesOut)));
    }
    if (plan.then === 'drop') { await wait(plan.dropAfter ?? 0); response.destroy(); return; }
    response.end(done);
  };
  return serve(async (request, response, record) => {
    const plan = plans.find(candidate => record.body?.input === candidate.input);
    if (!plan) { response.writeHead(400); response.end('unexpected text'); return; }
    events.push(`${plan.name} arrived`);
    try { await answer(plan, response); } finally { latch(plan.name).open(); }
  }).then(server => Object.assign(server, {events, release: () => latch('release').open()}));
}
const level = (count, value) => new Float32Array(count).fill(value);
const valuesOf = packets => packets.map(packet => packet.pcm[0]);

test('a long reply goes out as two requests started together, and the audio reaches the player in order as one reply', async () => {
  // The first part answers only after the second part has been answered in full, so the second request cannot have waited for the first.
  const server = await planned([
    {name: 'first', input: FIRST, after: 'second', deltas: [level(24000, 0.25), level(24000, 0.25)]},
    {name: 'second', input: REST, deltas: [level(4800, 0.5), level(4800, 0.5)]}]);
  try {
    const logs = [];
    const {voice} = voiceFor(server, {onLog: line => logs.push(line)});
    const sink = collect();
    const result = await voice.synthesizeStream('judy-alvarez', LONG, sink);
    assert.equal(server.requests.length, 2);
    assert.deepEqual(server.requests.map(request => request.body.input).sort(), [FIRST, REST].sort());
    assert.ok(server.events.indexOf('second arrived') < server.events.indexOf('first answering'), `the second request did not wait for the first to finish: ${server.events}`);
    // The second part answered first, but its audio waits for the first part's: 0.25 for 2 s, then 0.5.
    const values = valuesOf(sink.packets);
    assert.deepEqual([...new Set(values)], [0.25, 0.5]);
    assert.equal(values.indexOf(0.5), 20, 'ten 100 ms packets per second of the first part, two seconds');
    sink.packets.forEach((packet, at) => {
      assert.equal(packet.index, at + 1); assert.equal(packet.owner, sink.packets[0].owner); assert.equal(packet.id, sink.packets[0].id);
      assert.equal(packet.offsetFrames, sink.packets.slice(0, at).reduce((sum, earlier) => sum + earlier.frames, 0));
    });
    assert.equal(result.frames, 48000 + 9600); assert.equal(result.chunks, sink.packets.length);
    assert.equal(result.truncated, false); assert.equal(result.remainder, undefined); assert.equal(result.timing.voiceRequests, 2);
    assert.ok(logs.some(line => /\[Voxtral\] first audio \d+ms, chars \d+/.test(line)), logs.join('|'));
    assert.ok(logs.some(line => line.includes(`chars ${LONG.length}`)));
    assert.equal(voice.degraded, null);
  } finally { await server.close(); }
});

test('a short reply stays one request', async () => {
  const server = await planned([{name: 'only', input: 'Hello there, V.', deltas: [level(2400, 0.1)]}]);
  try {
    const {voice} = voiceFor(server);
    const result = await voice.synthesizeStream('judy-alvarez', 'Hello there, V.', collect());
    assert.equal(server.requests.length, 1); assert.equal(result.timing.voiceRequests, 1);
  } finally { await server.close(); }
});

test('a second part that is slower than the first part\'s audio is played as it arrives, once the first part is done', async () => {
  const server = await planned([
    {name: 'first', input: FIRST, deltas: [level(9600, 0.25)]},
    {name: 'second', input: REST, delay: 120, gap: 60, deltas: [level(4800, 0.5), level(4800, 0.5), level(4800, 0.5)]}]);
  try {
    const {voice} = voiceFor(server, {limits: {splitMarginMs: 100}});
    const sink = collect();
    const result = await voice.synthesizeStream('judy-alvarez', LONG, sink);
    assert.deepEqual([...new Set(valuesOf(sink.packets))], [0.25, 0.5]);
    assert.equal(result.frames, 9600 + 14400); assert.equal(result.truncated, false);
  } finally { await server.close(); }
});

test('the first part failing sends the whole reply to Pocket and drops the second request', async () => {
  const server = await planned([
    {name: 'first', input: FIRST, then: 503},
    {name: 'second', input: REST, delay: 300, deltas: [level(2400, 0.5)]}]);
  try {
    const {voice} = voiceFor(server);
    const sink = collect();
    await assert.rejects(voice.synthesizeStream('judy-alvarez', LONG, sink), {kind: 'network'});
    assert.equal(sink.packets.length, 0, 'nothing of the second part is played without the first');
    assert.equal(voice.degraded.reason, 'network');
  } finally { await server.close(); }
});

test('the second part failing before its audio: it is asked for again once, then the reply ends after the first part; Pocket never speaks the rest', async () => {
  for (const second of [{then: 500}, {delay: 10, deltas: [], then: 'drop', dropAfter: 0}]) {
    const server = await planned([
      {name: 'first', input: FIRST, deltas: [level(24000, 0.25), level(24000, 0.25)], gap: 40},
      {name: 'second', input: REST, ...second}]);
    try {
      const logs = [];
      const {voice} = voiceFor(server, {onLog: line => logs.push(line)});
      const sink = collect();
      const result = await voice.synthesizeStream('judy-alvarez', LONG, sink);
      assert.equal(result.remainder, undefined, 'there is no rest for another voice to speak'); assert.equal(result.continuation, undefined);
      assert.equal(result.truncated, true);
      assert.deepEqual([...new Set(valuesOf(sink.packets))], [0.25], 'only the first part was played');
      assert.equal(result.frames, 48000);
      assert.equal(server.requests.filter(request => request.body.input === REST).length, 2, 'the second part was asked for twice');
      assert.ok(voice.degraded, 'the player is told once that the cloud voice is not ready');
      assert.ok(logs.some(line => line.includes('asking again')), logs.join('|'));
      assert.ok(logs.some(line => line.includes('the rest of the reply could not be spoken') && line.includes('the voice is not switched')), logs.join('|'));
      assert.ok(!logs.some(line => line.includes('fell back to Pocket')), logs.join('|'));
    } finally { await server.close(); }
  }
});

test('a second part with no audio when the first part is nearly over is waited for, asked for again, and never given to Pocket', async () => {
  // The first ask never answers, the second does: the rest is spoken, in the same voice, after a gap.
  const asks = {};
  const server = await serve(async (request, response, record) => {
    const input = record.body.input;
    asks[input] = (asks[input] ?? 0) + 1;
    if (input === REST && asks[input] === 1) return;            // hangs
    sse(response);
    response.write(delta(bytesOf(level(input === FIRST ? 4800 : 9600, input === FIRST ? 0.25 : 0.5))));
    response.end(done);
  });
  try {
    // The 150 ms limit of the first ask of the rest is a timer of the voice on a manual clock, moved once that ask has reached the server (a real
    // 150 ms limit can cut it on a loaded machine before it is sent, and the server would count one ask, and hang it, where the test expects two).
    const logs = [], timers = manualTimers();
    const {voice} = voiceFor(server, {...timers.hooks, limits: {splitMarginMs: 100, tailFirstAudioMs: 150, tailRetryAudioMs: 2000}, onLog: line => logs.push(line)});
    const sink = collect();
    const reply = track(voice.synthesizeStream('judy-alvarez', LONG, sink));
    await until(() => asks[REST] === 1, 'the first ask of the rest to reach the server');
    await timers.clock.advance(150);
    await until(() => reply.done, 'the reply to end');
    assert.equal(reply.error, undefined, String(reply.error));
    const result = reply.value;
    assert.deepEqual(timers.limits().filter(ms => ms === 150 || ms === 2000), [150, 2000], 'the second ask of the rest waits longer');
    assert.equal(asks[REST], 2); assert.equal(result.truncated, false);
    assert.deepEqual([...new Set(valuesOf(sink.packets))], [0.25, 0.5]); assert.equal(result.frames, 4800 + 9600);
    assert.equal(voice.degraded, null, 'a rest that arrived on the second ask is a success');
    assert.ok(logs.some(line => line.includes('asking again')), logs.join('|'));
  } finally { await server.close(); }
  // Both asks hang: the reply ends after the first part within the two limits, not when the server finally answers. The server holds its
  // answer until the test releases it, and the two limits are on a manual clock moved once each ask has reached the server.
  const slow = await planned([
    {name: 'first', input: FIRST, deltas: [level(4800, 0.25)]},
    {name: 'second', input: REST, hold: true, deltas: [level(2400, 0.5)]}]);
  try {
    const timers = manualTimers();
    const {voice} = voiceFor(slow, {...timers.hooks, limits: {splitMarginMs: 100, tailFirstAudioMs: 120, tailRetryAudioMs: 180}});
    const reply = track(voice.synthesizeStream('judy-alvarez', LONG, collect()));
    const restAsks = () => slow.events.filter(event => event === 'second arrived').length;
    await until(() => restAsks() === 1, 'the first ask of the rest to reach the server');
    await timers.clock.advance(120);
    await until(() => restAsks() === 2, 'the second ask of the rest to reach the server');
    assert.equal(reply.done, false);
    await timers.clock.advance(180);
    await until(() => reply.done, 'the reply to end');
    assert.equal(reply.error, undefined, String(reply.error));
    const result = reply.value;
    assert.equal(result.truncated, true); assert.equal(result.remainder, undefined);
    assert.equal(slow.events.includes('second answering'), false, 'it did not wait for the slow request');
    assert.deepEqual(timers.limits().filter(ms => ms === 120 || ms === 180), [120, 180]);
    assert.equal(voice.degraded.reason, 'timeout');
  } finally { slow.release(); await slow.close(); }
});

test('a second part that fails after its audio has started ends the reply there; nothing is spoken twice', async () => {
  const server = await planned([
    {name: 'first', input: FIRST, deltas: [level(4800, 0.25)]},
    {name: 'second', input: REST, deltas: [level(4800, 0.5), level(4800, 0.5)], gap: 150, then: 'drop', dropAfter: 400}]);
  try {
    const {voice} = voiceFor(server, {limits: {splitMarginMs: 100}});
    const sink = collect();
    const result = await voice.synthesizeStream('judy-alvarez', LONG, sink);
    assert.equal(result.truncated, true); assert.equal(result.remainder, undefined);
    assert.deepEqual([...new Set(valuesOf(sink.packets))], [0.25, 0.5]);
  } finally { await server.close(); }
});

test('cancelling a split reply stops both requests', async () => {
  // Both requests are held by the server until both have arrived; the reply is cancelled then, so there are two live connections to close.
  const server = await planned([
    {name: 'first', input: FIRST, hold: true, deltas: [level(2400, 0.25)]},
    {name: 'second', input: REST, hold: true, deltas: [level(2400, 0.5)]}]);
  try {
    const {voice} = voiceFor(server);
    const controller = new AbortController(), sink = collect();
    const speaking = voice.synthesizeStream('judy-alvarez', LONG, {...sink, signal: controller.signal});
    await until(() => server.requests.length === 2, 'both requests to reach the server');
    controller.abort();
    await assert.rejects(speaking, error => error.name === 'AbortError' || /cancel/i.test(error.message));
    await until(() => server.requests.every(request => request.closed), 'both connections to be closed');
    assert.equal(sink.packets.length, 0);
    assert.equal(server.events.some(event => event.endsWith('answering')), false, 'they were cut while the server still held its answers');
  } finally { server.release(); await server.close(); }
});

test('the voice selection never finishes a split reply with Pocket: the second request failing ends the reply after the first part', async () => {
  const server = await planned([
    {name: 'first', input: FIRST, deltas: [level(24000, 0.25)]},
    {name: 'second', input: REST, then: 500}]);
  try {
    const packets = [];
    const h = selection(server, {pocket: async () => { throw Error('Pocket must not be asked for the rest of a reply the cloud voice began'); }});
    h.voice.update({voiceProvider: 'voxtral'}, null, false);
    await h.voice.start();
    const result = await h.voice.synthesizeStream('judy-alvarez', LONG, {onPcm: packet => { packets.push(packet); }});
    assert.equal(h.calls.length, 0, 'Pocket was not asked');
    assert.equal(packets.length, 10); assert.ok(packets.every(packet => packet.pcm[0] === 0.25));
    assert.equal(result.truncated, true); assert.equal(result.frames, 24000); assert.equal(h.cloud.degraded.reason, 'network');
  } finally { await server.close(); }
});

// ---- one reply, one voice: a streamed first sentence (head) and the rest (tail) -----------------------------------------------------

const HEAD = 'Hey V, good to see you here again.';
const TAIL = 'What can I do for you tonight, now that you are here, and do you want a drink first?';
const headOf = (h, sink, extra = {}) => h.voice.synthesizeStream('judy-alvarez', HEAD, {onPcm: sink.onPcm, utterance: extra.utterance, role: 'head'});
const tailOf = (h, sink, utterance) => h.voice.synthesizeStream('judy-alvarez', TAIL, {onPcm: sink.onPcm, utterance, role: 'tail'});
const pocketPackets = value => async (name, text, options) => {
  for (const index of [1, 2]) await options.onPcm({version: 1, engine: 'pocket-tts', profile: name, owner: 'f'.repeat(32), id: 9, index,
    sampleRate: 24000, channels: 1, pcm: level(2400, value), format: 'f32le', offsetFrames: (index - 1) * 2400, frames: 2400,
    timebase: 'audio-seconds', startSeconds: (index - 1) * 0.1, modelSha256: 'f'.repeat(64)});
  return {provider: 'pocket', frames: 4800, chunks: 2, duration: 0.2, timing: {voiceProvider: 'pocket'}};
};

test('head and tail in the cloud voice: the tail is asked for again after a timeout and Pocket never speaks any of the reply', async () => {
  const asks = {};
  const server = await serve(async (request, response, record) => {
    const input = record.body.input;
    asks[input] = (asks[input] ?? 0) + 1;
    if (input === TAIL && asks[input] === 1) return;             // the first ask of the tail hangs (a server-side spike)
    sse(response);
    response.write(delta(bytesOf(level(input === HEAD ? 4800 : 9600, input === HEAD ? 0.25 : 0.5))));
    response.end(done);
  });
  try {
    // The 120 ms limit of the tail's first ask is a timer of the voice on a manual clock, moved once that ask has reached the server (a real
    // 120 ms limit can cut it on a loaded machine before it is sent, and the server would count one ask, and hang it, where the test expects two).
    const logs = [], timers = manualTimers();
    const h = selection(server, {voxtral: {...timers.hooks, limits: {tailFirstAudioMs: 120, tailRetryAudioMs: 2000}, onLog: line => logs.push(line)},
      pocket: async () => { throw Error('Pocket must not speak any of this reply'); }});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const utterance = new Utterance(), head = collect(), tail = collect();
    // The tail is asked for in parallel with the head, as soon as its text is known.
    const speaking = Promise.all([headOf(h, head, {utterance}), tailOf(h, tail, utterance)]);
    await until(() => asks[TAIL] === 1, 'the first ask of the tail to reach the server');
    await timers.clock.advance(120);
    const [headResult, tailResult] = await speaking;
    assert.deepEqual(timers.limits().filter(ms => ms === 120 || ms === 2000), [120, 2000], 'the second ask of the tail waits longer');
    assert.equal(utterance.engine, 'voxtral');
    assert.deepEqual([...new Set(valuesOf(head.packets))], [0.25]); assert.deepEqual([...new Set(valuesOf(tail.packets))], [0.5]);
    assert.equal(headResult.provider, 'voxtral'); assert.equal(tailResult.provider, 'voxtral'); assert.equal(h.calls.length, 0);
    assert.equal(asks[TAIL], 2, 'the tail was asked for twice'); assert.equal(asks[HEAD], 1);
    assert.ok(logs.some(line => line.includes('asking again')), logs.join('|'));
    assert.equal(h.voice.cloudFallback, null, 'a tail that arrived on the second ask is not a failure');
  } finally { await server.close(); }
});

test('head in the cloud voice, tail failing twice: the tail fails (the reply ends after the head), and Pocket is not asked', async () => {
  const server = await planned([
    {name: 'head', input: HEAD, deltas: [level(4800, 0.25)]},
    {name: 'tail', input: TAIL, then: 503}]);
  try {
    const logs = [];
    const h = selection(server, {voxtral: {onLog: line => logs.push(line)}, pocket: async () => { throw Error('Pocket must not speak the tail'); }});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const utterance = new Utterance(), head = collect(), tail = collect();
    const settled = await Promise.allSettled([headOf(h, head, {utterance}), tailOf(h, tail, utterance)]);
    assert.equal(settled[0].status, 'fulfilled'); assert.equal(settled[1].status, 'rejected');
    assert.equal(settled[1].reason.kind, 'network'); assert.equal(tail.packets.length, 0); assert.equal(head.packets.length, 2);
    assert.equal(h.calls.length, 0, 'the reply was not switched to Pocket');
    assert.equal(server.requests.filter(request => request.body.input === TAIL).length, 2, 'asked for twice');
    assert.ok(logs.some(line => line.includes('the voice is not switched')), logs.join('|'));
  } finally { await server.close(); }
});

test('head failing before any audio: nothing speaks the reply (it is written), and the tail that the cloud voice already had is dropped', async () => {
  const server = await planned([
    {name: 'head', input: HEAD, then: 503},
    {name: 'tail', input: TAIL, deltas: [level(4800, 0.5)]}]);
  try {
    const h = selection(server, {pocket: pocketPackets(Math.fround(0.9))});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const utterance = new Utterance(), head = collect(), tail = collect();
    const [headResult, tailResult] = await Promise.allSettled([headOf(h, head, {utterance}), tailOf(h, tail, utterance)]);
    assert.equal(headResult.status, 'rejected'); assert.equal(tailResult.status, 'rejected');
    assert.equal(utterance.engine, 'pocket', 'the lock says the cloud voice did not speak');
    assert.equal(h.calls.length, 0, 'no local voice was asked'); assert.equal(h.workers.length, 0);
    assert.equal(head.packets.length, 0); assert.equal(tail.packets.length, 0, 'no cloud audio in the tail');
  } finally { await server.close(); }
});

test('the tail\'s cloud audio is held until the head is known to be in the cloud voice, then handed on in order', async () => {
  // The head's answer is withheld by the server until the test has seen the whole tail arrive at the voice (its "first audio" line is logged
  // when the tail request has been read to the end); only then is the head let go.
  const server = await planned([
    {name: 'head', input: HEAD, hold: true, deltas: [level(2400, 0.25)]},
    {name: 'tail', input: TAIL, deltas: [level(2400, 0.5), level(2400, 0.5)], gap: 20}]);
  try {
    const logs = [];
    const h = selection(server, {voxtral: {onLog: line => logs.push(line)}, pocket: async () => { throw Error('Pocket must not speak'); }});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const utterance = new Utterance(), head = collect(), tail = collect();
    const speaking = Promise.all([headOf(h, head, {utterance}), tailOf(h, tail, utterance)]);
    await until(() => logs.some(line => line.includes(`chars ${TAIL.length}`)), 'the whole tail to arrive');
    assert.equal(tail.packets.length, 0, 'the tail answered first, but its audio waits for the head\'s decision');
    assert.equal(utterance.engine, null);
    server.release();
    await speaking;
    assert.equal(utterance.engine, 'voxtral'); assert.equal(head.packets.length, 1); assert.equal(tail.packets.length, 2);
    assert.deepEqual(tail.packets.map(packet => packet.index), [1, 2]);
  } finally { server.release(); await server.close(); }
});

test('a tail whose head was not spoken by the cloud voice sends nothing to it and is not spoken at all', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(level(2400, 0.5)))); response.end(done); });
  try {
    const h = selection(server, {pocket: pocketPackets(Math.fround(0.9))});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const utterance = new Utterance(); utterance.decide('pocket');
    const tail = collect();
    await assert.rejects(tailOf(h, tail, utterance), /did not speak the first part/);
    assert.equal(server.requests.length, 0); assert.equal(h.calls.length, 0); assert.equal(tail.packets.length, 0);
    // With the cloud voice not chosen at all, head and tail are Pocket's and nothing else happens.
    h.voice.update({voiceProvider: 'pocket'}, null, false);
    const other = new Utterance(), headSink = collect(), tailSink = collect();
    await headOf(h, headSink, {utterance: other}); await tailOf(h, tailSink, other);
    assert.equal(other.engine, 'pocket'); assert.equal(server.requests.length, 0); assert.equal(h.calls.length, 2);
  } finally { await server.close(); }
});

test('cancelling while the tail waits for the head stops the tail\'s request', async () => {
  const server = await planned([{name: 'tail', input: TAIL, hold: true, deltas: [level(2400, 0.5)]}]);
  try {
    const h = selection(server);
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const utterance = new Utterance(), controller = new AbortController(), tail = collect();
    const speaking = h.voice.synthesizeStream('judy-alvarez', TAIL, {onPcm: tail.onPcm, signal: controller.signal, utterance, role: 'tail'});
    await until(() => server.requests.length === 1, 'the tail request to reach the server');
    controller.abort();
    await assert.rejects(speaking, error => error.name === 'AbortError' || /cancel/i.test(error.message));
    await until(() => server.requests.every(request => request.closed), 'the connection to be closed');
    assert.equal(server.events.includes('tail answering'), false, 'it was cut while the server still held its answer');
  } finally { server.release(); await server.close(); }
});

test('the routing log names the reference the cloud voice clones from (long, else short, else Pocket), not the Pocket one it rides on', () => {
  const entry = set => ({profiles: {alex: {reference: `runtime/voice-references/picked/autobest/${set}/alex.wav`}}});
  const voice = {omniVariants: {long: {registry: {profiles: {}}}, short: {registry: entry('omni-short')}}, registries: {pocket: entry('pocket')}};
  const sources = {omni: {short: {voices: {alex: {pick: {seconds: 9.5}}}}}, pocket: {voices: {alex: {pick: {seconds: 16.59}}}}};
  assert.deepEqual(cloudReferenceOf(voice, 'alex', sources), {set: 'picked/autobest/omni-short', seconds: 9.5});
  voice.omniVariants.long.registry = entry('omni-long');
  assert.equal(cloudReferenceOf(voice, 'alex', sources).set, 'picked/autobest/omni-long');
  voice.omniVariants.long.registry = {profiles: {}}; voice.omniVariants.short.registry = {profiles: {}};
  assert.deepEqual(cloudReferenceOf(voice, 'alex', sources), {set: 'picked/autobest/pocket', seconds: 16.59});
  assert.equal(cloudReferenceOf(voice, 'someone', sources), null);
});

test('an Ogg reference the server refuses is prepared as MP3 from then on, and the reply that met the refusal falls to Pocket', async () => {
  const server = await serve((request, response) => { response.writeHead(400, {'content-type': 'application/json'});
    response.end(JSON.stringify({object: 'error', message: 'Failed to load audio file. Verify that the given file is valid mp3 or wav.', code: '3291'})); });
  const asked = [];
  const prepare = async (bytes, options) => { asked.push(!!options.safeFormat);
    return {bytes: Buffer.concat([Buffer.from(options.safeFormat ? 'ID3' : 'OggS'), Buffer.alloc(300, 1)]), format: options.safeFormat ? 'mp3' : 'ogg', seconds: 2, cached: false}; };
  const logs = [];
  const {voice} = voiceFor(server, {prepare, onLog: line => logs.push(line)});
  try {
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hello there, V.', {onPcm: () => {}}), error => error instanceof VoxtralError && error.kind === 'request' && error.status === 400);
    assert.equal(voice.safeFormat, true); assert.match(logs.join(), /Ogg reference was refused; the references are prepared as MP3/);
    assert.equal((await voice.reference('judy-alvarez')).format, 'mp3');
    assert.deepEqual(asked, [false, true]);
  } finally { await server.close(); }
});

test('a 400 for another reason, or for an MP3 reference, does not switch the reference format', async () => {
  const server = await serve((request, response) => { response.writeHead(400, {'content-type': 'application/json'}); response.end(JSON.stringify({message: 'The text is empty'})); });
  const make = format => voiceFor(server, {prepare: async () => ({bytes: Buffer.concat([Buffer.from(format === 'ogg' ? 'OggS' : 'ID3'), Buffer.alloc(300, 1)]), format, seconds: 2})}).voice;
  try {
    for (const format of ['ogg', 'mp3']) {
      const voice = make(format);
      await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hello there, V.', {onPcm: () => {}}), error => error.kind === 'request');
      assert.equal(voice.safeFormat, false);
    }
  } finally { await server.close(); }
});

test('the lip-sync analysis stays wanted for the cloud voice (it analyses audio) while no local voice model is loaded', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done); });
  try {
    const wanted = [];
    const h = selection(server, {extra: {phoneAnalysis: {setWanted: value => wanted.push(value), retire: async () => {}, close: async () => {}}}});
    h.voice.update({voiceProvider: 'voxtral'}, null, false);
    assert.equal(wanted.at(-1), true, 'lip sync is wanted'); assert.equal(h.workers.length, 0, 'but no local voice worker');
    h.voice.update({voiceProvider: 'convai'}, null, false);
    assert.equal(wanted.at(-1), false);
    await h.voice.close();
  } finally { await server.close(); }
});

// ---- a hiccup is not a bad key (2026-10-17: one HTTP 403 in a group round silenced two voices) -------------------------------------

// A simulated Mistral that answers the first `failures` requests with `status` (then audio), and counts the requests.
async function flaky(status, failures, headers = {}, body = '{"message":"hiccup"}') {
  let seen = 0;
  const server = await serve((request, response) => {
    if (seen++ < failures) { response.writeHead(status, {'content-type': 'application/json', ...headers}); response.end(body); return; }
    sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done);
  });
  return server;
}
const quick = {limits: {retryWaitMs: 5}};

test('a 5xx, a 408, a 403 or a short 429 is asked again at once and the reply is spoken in the cloud voice, with no report and no cool-down', async () => {
  for (const [status, headers] of [[503, {}], [500, {}], [408, {}], [403, {}], [429, {'retry-after': '0'}], [429, {'retry-after': '1'}]]) {
    const server = await flaky(status, 1, headers);
    try {
      const scheduler = {schedule: task => Promise.resolve().then(() => task({})), noteHeaders() {}, pause() {}};
      const logs = [];
      const {voice} = voiceFor(server, {...quick, scheduler, onLog: line => logs.push(line)});
      const sink = collect();
      const result = await voice.synthesizeStream('judy-alvarez', 'Hello V.', sink);
      assert.equal(server.requests.length, 2, `HTTP ${status}: asked again once`);
      assert.equal(result.frames, 2400); assert.equal(sink.packets.length, 1);
      assert.equal(voice.degraded, null, `HTTP ${status} left no report`); assert.equal(voice.ready, true);
      assert.ok(logs.some(line => line.includes('asking again')), logs.join('|'));
    } finally { await server.close(); }
  }
});

test('the quick second ask is bounded: it waits at most the retry budget, and a Retry-After longer than that is not waited for', async () => {
  const voice = new VoxtralVoice({getKey: () => KEY, scheduler: fastScheduler()});
  const error = (status, retryAfterMs) => new VoxtralError(status === 429 ? 'limit' : 'network', 'x', {status, retryAfterMs});
  assert.equal(voice.retryWait(error(503), 0), VOXTRAL_LIMITS.retryWaitMs);
  assert.ok(VOXTRAL_LIMITS.retryWaitMs <= VOXTRAL_LIMITS.retryBudgetMs && VOXTRAL_LIMITS.retryBudgetMs <= 1000, 'about a second at most');
  assert.equal(voice.retryWait(error(429, 800), 0), 800);
  assert.equal(voice.retryWait(error(429, 12000), 0), null, 'a long Retry-After is the cool-down\'s business');
  assert.equal(voice.retryWait(error(429), 0), VOXTRAL_LIMITS.retryWaitMs);
  assert.equal(voice.retryWait(error(503), 1), null, 'one quick second ask, not a loop');
  assert.equal(voice.retryWait(new VoxtralError('key', 'x', {status: 401}), 0), null, 'a 401 is a refused key: never again');
  assert.equal(voice.retryWait(new VoxtralError('request', 'x', {status: 400}), 0), null);
  assert.equal(voice.retryWait(new VoxtralError('timeout', 'x'), 0), null, 'a timeout is the voice selection\'s own longer second ask');
  const server = await flaky(503, 1);
  try {
    // The wait before the second ask is a timer of the voice on a manual clock: the claim is the length of the wait it sets (the default 300 ms,
    // inside the budget) and that the second ask is not sent before it is over, not how long a loaded machine takes to get through it.
    const timers = manualTimers();
    const {voice: timed} = voiceFor(server, timers.hooks);
    const call = track(timed.synthesizeStream('judy-alvarez', 'Hello V.', collect()));
    await until(() => timers.limits().includes(VOXTRAL_LIMITS.retryWaitMs), 'the quick second ask to be waiting');
    assert.ok(VOXTRAL_LIMITS.retryWaitMs < VOXTRAL_LIMITS.retryBudgetMs, 'the retry wait is inside the budget');
    assert.equal(server.requests.length, 1);
    await timers.clock.advance(VOXTRAL_LIMITS.retryWaitMs - 1);
    assert.equal(server.requests.length, 1, 'not asked again before the wait is over'); assert.equal(call.done, false);
    await timers.clock.advance(1);
    await until(() => call.done, 'the second ask to be answered');
    assert.equal(call.error, undefined, String(call.error));
    assert.equal(server.requests.length, 2);
  } finally { await server.close(); }
});

test('a 401 is a refused key: one request, reported as a key problem, with a 60 s cool-down; the message carries what the server said and never the key', async () => {
  const server = await flaky(401, 99, {}, `{"message":"Unauthorized ${KEY}"}`);
  try {
    let time = 5_000_000;
    const {voice} = voiceFor(server, {...quick, clock: () => time});
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hello V.', collect()), error => {
      assert.equal(error.kind, 'key'); assert.equal(error.status, 401); assert.equal(error.retried, undefined);
      assert.ok(error.message.includes('HTTP 401: {"message":"Unauthorized [key]"}'), error.message); assert.equal(error.message.includes(KEY), false);
      return true;
    });
    assert.equal(server.requests.length, 1, 'a refused key is not asked again');
    assert.equal(voice.degraded.reason, 'key'); assert.equal(voice.ready, false);
    time += VOXTRAL_LIMITS.keyCooldownMs - 1; assert.equal(voice.ready, false);
    time += 2; assert.equal(voice.ready, true, 'asked again after the cool-down');
  } finally { await server.close(); }
});

test('a 403 that is still there on the quick second ask is reported as a refused key, with the shorter 20 s cool-down', async () => {
  const server = await flaky(403, 99, {}, '<html><body><h1>403</h1> Forbidden by the gateway</body></html>');
  try {
    let time = 7_000_000;
    const {voice} = voiceFor(server, {...quick, clock: () => time});
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hello V.', collect()), error => {
      assert.equal(error.kind, 'key'); assert.equal(error.status, 403); assert.equal(error.retried, true);
      assert.ok(error.message.includes('HTTP 403: 403 Forbidden by the gateway'), error.message);
      return true;
    });
    assert.equal(server.requests.length, 3, 'the v3 id twice (the quick second ask), then the older model once: a repeated 403 can be the plan refusing v3'); assert.equal(voice.degraded.reason, 'key');
    assert.deepEqual(server.requests.map(request => request.body.model), [VOXTRAL_MODEL, VOXTRAL_MODEL, VOXTRAL_FALLBACK_MODEL]);
    assert.equal(voice.model, VOXTRAL_MODEL, 'the older model did not answer either: nothing changed');
    time += VOXTRAL_LIMITS.forbiddenCooldownMs - 1; assert.equal(voice.ready, false);
    time += 2; assert.equal(voice.ready, true);
  } finally { await server.close(); }
});

// ---- a guardrail refusal is about that line's text, not the key (a 403 "Request blocked by guardrail policy" paused the voice for 20 s) ----

const GUARDRAIL_BODIES = ['Request blocked by guardrail policy', '{"message":"Request blocked by guardrail policy"}',
  '{"object":"error","message":"Request blocked by guardrail policy","type":"guardrail_violation","code":"3000"}',
  'REQUEST BLOCKED BY GUARDRAIL POLICY', 'Guardrail triggered', '{"error":{"message":"Content blocked by policy"}}', 'Request blocked'];
const REFUSED_LINE = '[Voxtral] refused this line (guardrail); shown as text\n';

test('a 403 whose own body names the guardrail (or says blocked) is a content refusal; a gateway page, a blamed key and every other status keep their meaning', () => {
  for (const body of GUARDRAIL_BODIES) {
    assert.equal(isContentRefusal(403, body), true, body);
    const error = mapStatus(403, `${body} ${KEY}`, {apiKey: KEY});
    assert.equal(error.kind, 'content', body); assert.equal(error.status, 403);
    assert.ok(error.message.endsWith('[voxtral:content]')); assert.equal(/key/i.test(error.message), false, `no key wording: ${error.message}`);
    assert.equal(error.message.includes(KEY), false);
  }
  for (const body of ['', undefined, '{"message":"Forbidden"}', '{"message":"hiccup"}', 'Forbidden by the gateway',
    '<html><body><h1>Sorry, you have been blocked</h1> This website is using a security service</body></html>',
    '<!DOCTYPE html><title>Attention Required</title> You are blocked', 'Your API key has been blocked', '{"message":"Account blocked"}',
    'Access blocked for this IP address', 'This organization is blocked', 'unblocked', 'blockedness']) {
    assert.equal(isContentRefusal(403, body), false, String(body));
    const error = mapStatus(403, body, {apiKey: KEY});
    assert.equal(error.kind, 'key', `a 403 saying ${JSON.stringify(body)} is what it was: a key problem`);
    assert.ok(error.message.includes('did not accept the API key (HTTP 403'), error.message);
  }
  // Only a 403: the same words under another status are what that status already meant.
  assert.equal(mapStatus(401, 'Request blocked by guardrail policy').kind, 'key');
  assert.equal(mapStatus(429, 'Request blocked by guardrail policy').kind, 'limit');
  assert.equal(mapStatus(503, 'Request blocked by guardrail policy').kind, 'network');
  assert.equal(mapStatus(400, 'Request blocked by guardrail policy').kind, 'request');
});

test('a guardrail 403 is that reply\'s problem only: one request (no second ask), no pause, no tightened gate, no report, one log line, a written reply, and the next reply is asked as usual', async () => {
  for (const body of GUARDRAIL_BODIES) {
    const server = await flaky(403, 1, {}, body);
    try {
      let time = 13_000_000;
      const logs = [];
      const {voice} = voiceFor(server, {limits: {retryWaitMs: 5}, clock: () => time, onLog: line => logs.push(line)});
      const refused = collect();
      await assert.rejects(voice.synthesizeStream('judy-alvarez', 'A line the guardrail dislikes.', refused), error => {
        assert.equal(error.kind, 'content', body); assert.equal(error.status, 403); assert.equal(error.retried, undefined);
        assert.equal(/key/i.test(error.message), false, `no key wording: ${error.message}`); assert.equal(error.message.includes(KEY), false);
        return true;
      });
      assert.equal(server.requests.length, 1, `${body}: a content refusal is not asked again`);
      assert.equal(refused.packets.length, 0, 'the reply is written text only');
      assert.equal(voice.until, 0, 'the voice is not paused'); assert.equal(voice.ready, true);
      assert.equal(voice.degraded, null, 'no fallback to another voice is reported for a reply-level refusal'); assert.equal(voice.fellBack, 0);
      assert.equal(voice.gate.cap, VOXTRAL_LIMITS.maxConcurrent, 'not a burst limit: the gate is not tightened');
      assert.deepEqual(logs, [REFUSED_LINE], 'exactly one line, with no key wording and no second ask');
      // The next reply's voice goes straight out, with no wait.
      const next = collect();
      const result = await voice.synthesizeStream('judy-alvarez', 'A line it likes.', next);
      assert.equal(server.requests.length, 2); assert.equal(result.provider, 'voxtral'); assert.equal(next.packets.length, 1);
      assert.equal(voice.degraded, null);
    } finally { await server.close(); }
  }
});

test('through the voice selection a guardrail 403 is written text for that reply: no third ask, no Convai-voice fallback state, no local voice, and the next turn speaks in the cloud voice', async () => {
  const server = await flaky(403, 1, {}, '{"message":"Request blocked by guardrail policy"}');
  try {
    const logs = [];
    const h = selection(server, {voxtral: {...quick, onLog: line => logs.push(line)}});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'A line the guardrail dislikes.', {onPcm() {}}), {kind: 'content', status: 403});
    assert.equal(server.requests.length, 1, 'neither the voice\'s quick second ask nor the voice selection\'s longer one');
    assert.deepEqual(logs, [REFUSED_LINE]);
    assert.equal(h.calls.length, 0); assert.equal(h.workers.length, 0, 'never a local voice');
    assert.equal(h.voice.cloudFallback, null, 'the Convai voice is not announced: the next turn is still the cloud voice');
    assert.equal(h.voice.cloudKeyless, false); assert.equal(h.voice.cloudBlocked, null); assert.equal(h.voice.cloudLast, null);
    h.voice.publish();
    assert.equal(h.states.at(-1).fallback, null); assert.equal(h.states.at(-1).voxtral.degraded, null);
    const record = describeVoiceRoute({voice: h.voice, input: {profileKey: 'judy-alvarez'}, profile: {key: 'judy-alvarez', name: 'Judy'},
      plan: {engine: 'pocket'}, reply: {engine: 'pocket'}, now: () => 0});
    assert.equal(record.fallback, null); assert.equal(record.used, 'Mistral cloud voice (Voxtral)');
    assert.equal((await h.voice.synthesizeStream('judy-alvarez', 'Next turn.', {onPcm() {}})).provider, 'voxtral');
    assert.equal(server.requests.length, 2);
    await h.voice.close();
  } finally { await server.close(); }
});

test('the rest of a reply refused by the guardrail: not asked again, the reply ends after the part already heard, one log line, no pause', async () => {
  const server = await planned([
    {name: 'head', input: HEAD, deltas: [level(4800, 0.25)]},
    {name: 'tail', input: TAIL, then: 403, body: '{"message":"Request blocked by guardrail policy"}'}]);
  try {
    const logs = [];
    const h = selection(server, {voxtral: {onLog: line => logs.push(line)}, pocket: async () => { throw Error('Pocket must not speak the tail'); }});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const utterance = new Utterance(), head = collect(), tail = collect();
    const settled = await Promise.allSettled([headOf(h, head, {utterance}), tailOf(h, tail, utterance)]);
    assert.equal(settled[0].status, 'fulfilled'); assert.equal(settled[1].status, 'rejected'); assert.equal(settled[1].reason.kind, 'content');
    assert.equal(server.requests.filter(request => request.body.input === TAIL).length, 1, 'the refused rest is asked for once');
    assert.equal(tail.packets.length, 0); assert.equal(head.packets.length, 2); assert.equal(h.calls.length, 0);
    const refusals = logs.filter(line => /refused/.test(line));
    assert.equal(refusals.length, 1, logs.join('|')); assert.ok(refusals[0].includes('the reply ends after the part already heard'), refusals[0]);
    assert.equal(logs.some(line => /key|asking again/i.test(line)), false, logs.join('|'));
    assert.equal(h.cloud.until, 0); assert.equal(h.cloud.ready, true); assert.equal(h.cloud.gate.cap, VOXTRAL_LIMITS.maxConcurrent);
    assert.equal(h.voice.cloudFallback, null);
  } finally { await server.close(); }
});

test('a 403 with other wording is still a key problem (one quick second ask, the burst gate tightened, 20 s pause only when it repeats); a 401 that mentions the guardrail is still a refused key', async () => {
  for (const body of ['{"message":"Forbidden"}', 'Forbidden by the gateway', 'Your API key has been blocked',
    '<html><body>Sorry, you have been blocked</body></html>']) {
    const server = await flaky(403, 99, {}, body);
    try {
      let time = 15_000_000;
      const logs = [];
      const {voice} = voiceFor(server, {...quick, clock: () => time, onLog: line => logs.push(line)});
      await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hello V.', collect()), {kind: 'key', status: 403, retried: true});
      assert.equal(server.requests.length, 3, `${body}: one quick second ask, then the older model once`);
      assert.equal(voice.degraded.reason, 'key'); assert.equal(voice.gate.cap, VOXTRAL_LIMITS.tightConcurrent, 'a 403 may be a burst limit');
      assert.equal(logs.filter(line => line.includes('asking again')).length, 1);
      assert.ok(logs.some(line => line.includes('did not accept the API key (HTTP 403')), logs.join('|'));
      time += VOXTRAL_LIMITS.forbiddenCooldownMs - 1; assert.equal(voice.ready, false);
      time += 2; assert.equal(voice.ready, true);
    } finally { await server.close(); }
  }
  const server = await flaky(401, 99, {}, 'Request blocked by guardrail policy');
  try {
    let time = 17_000_000;
    const {voice} = voiceFor(server, {...quick, clock: () => time});
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hello V.', collect()), {kind: 'key', status: 401});
    assert.equal(server.requests.length, 1); assert.equal(voice.degraded.reason, 'key');
    time += VOXTRAL_LIMITS.keyCooldownMs - 1; assert.equal(voice.ready, false);
    time += 2; assert.equal(voice.ready, true);
  } finally { await server.close(); }
});

test('a 503 that keeps failing is asked for twice (not more), and the reply is written: no local voice', async () => {
  const server = await flaky(503, 99);
  try {
    const h = selection(server, {voxtral: quick});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Hello V.', {onPcm() {}}), {kind: 'network', retried: true});
    assert.equal(server.requests.length, 2, 'the quick second ask, and no third from the voice selection');
    assert.equal(h.calls.length, 0); assert.equal(h.workers.length, 0);
    await h.voice.close();
  } finally { await server.close(); }
});

test('the 2026-10-17 round: a 403 in the middle of a group round no longer silences the next voices (retry, same key, no report)', async () => {
  // The log of that round: Jackie's reply got one HTTP 403 ("did not accept the API key"), the key was then treated as refused for 60 s, and
  // the next two speakers (Judy, Alex) were written replies with the routing line naming "fell back (key)". The key was fine four minutes later.
  const server = await flaky(403, 1);
  try {
    const h = selection(server, {voxtral: quick});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const speak = name => h.voice.synthesizeStream('judy-alvarez', `${name} answers.`, {onPcm() {}});
    const first = await speak('Jackie');
    assert.equal(first.provider, 'voxtral', 'the first speaker got through on the quick second ask');
    for (const name of ['Judy', 'Alex']) assert.equal((await speak(name)).provider, 'voxtral');
    assert.equal(h.voice.cloudFallback, null); assert.equal(h.voice.cloudKeyless, false);
    const record = describeVoiceRoute({voice: h.voice, input: {profileKey: 'judy-alvarez'}, profile: {key: 'judy-alvarez', name: 'Judy'},
      plan: {engine: 'pocket'}, reply: {engine: 'pocket'}, now: () => 0});
    assert.equal(record.fallback, null); assert.equal(record.used, 'Mistral cloud voice (Voxtral)');
    await h.voice.close();
  } finally { await server.close(); }
});

test('a real bad key (401) is a key problem: the voice stops being asked, the turn goes to the Convai voice, and the log line says key; it recovers after the cool-down', async () => {
  let good = false;
  const server = await serve((request, response) => {
    if (!good) { response.writeHead(401, {'content-type': 'application/json'}); response.end('{"message":"Unauthorized"}'); return; }
    sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done);
  });
  try {
    let time = 9_000_000;
    const h = selection(server, {voxtral: {...quick, clock: () => time}});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Hello V.', {onPcm() {}}), {kind: 'key', status: 401});
    assert.equal(server.requests.length, 1);
    assert.deepEqual(h.voice.cloudFallback, {from: 'voxtral', to: 'convai', temporary: false, reason: 'key'});
    assert.equal(h.voice.cloudKeyless, true, 'the next turn is spoken by the Convai voice, not left silent');
    const convai = describeVoiceRoute({voice: h.voice, input: {profileKey: 'judy-alvarez'}, profile: {key: 'judy-alvarez', name: 'Judy', voiceName: 'Anna'},
      plan: {engine: 'convai'}, reply: {engine: 'convai'}, now: () => 0});
    assert.equal(convai.used, 'Convai cloud (Anna)'); assert.equal(convai.fallback, 'Mistral cloud voice fell back (key)');
    assert.equal(h.calls.length, 0, 'never a local voice');
    good = true; time += VOXTRAL_LIMITS.keyCooldownMs + 1;
    assert.equal(h.voice.cloudKeyless, false, 'the cool-down is over: the cloud voice is tried again');
    assert.equal((await h.voice.synthesizeStream('judy-alvarez', 'Back.', {onPcm() {}})).provider, 'voxtral');
    assert.equal(h.voice.cloudFallback, null);
    await h.voice.close();
  } finally { await server.close(); }
});

test('a long 429 sends the turns to the Convai voice for the cool-down instead of leaving them as text', async () => {
  const server = await serve((request, response) => { response.writeHead(429, {'retry-after': '20'}); response.end(); });
  try {
    let time = 3_000_000;
    const h = selection(server, {voxtral: {...quick, clock: () => time}});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    await assert.rejects(h.voice.synthesizeStream('judy-alvarez', 'Hello V.', {onPcm() {}}), {kind: 'limit'});
    assert.equal(server.requests.length, 1, 'a Retry-After of 20 s is not waited for');
    assert.equal(h.voice.cloudKeyless, true);
    time += 20_001; assert.equal(h.voice.cloudKeyless, false);
    await h.voice.close();
  } finally { await server.close(); }
});

// A simulated Mistral with a burst guard: more than `allowed` requests in flight at once get an HTTP 403 (the way a gateway can refuse a burst).
async function burstGuarded(allowed, streamMs = 60) {
  let inFlight = 0, peak = 0, refused = 0;
  const server = await serve(async (request, response) => {
    inFlight++; peak = Math.max(peak, inFlight);
    try {
      if (inFlight > allowed) { refused++; response.writeHead(403, {'content-type': 'application/json'}); response.end('{"message":"Forbidden"}'); return; }
      sse(response); response.write(delta(bytesOf(samples(2400)))); await wait(streamMs); response.end(done);
    } finally { inFlight--; }
  });
  return Object.assign(server, {stats: () => ({peak, refused})});
}

test('a group round asking for several voices at once (speaker, V line, held next speaker) never reports a false key problem', async () => {
  const server = await burstGuarded(2);
  try {
    const {voice} = voiceFor(server, {limits: {retryWaitMs: 40}});
    const speak = (name, ahead) => voice.synthesizeStream('judy-alvarez', `${name} answers.`, {onPcm() {}, ahead});
    // Three for the speaker being heard and the V line, three held for the next speakers, all in the same instant.
    const settled = await Promise.allSettled([speak('A'), speak('B'), speak('C'), speak('D', true), speak('E', true), speak('F', true)]);
    assert.deepEqual(settled.map(entry => entry.status), Array(6).fill('fulfilled'), JSON.stringify(settled.map(entry => entry.reason?.message)));
    assert.equal(voice.degraded, null, 'no key problem was reported'); assert.equal(voice.ready, true);
    assert.ok(server.stats().peak <= 4, `at most the cap in flight at once (peak ${server.stats().peak})`);
  } finally { await server.close(); }
});

test('after a refusal the voice keeps fewer speech requests in flight for a while, so a burst limit is not hit again', async () => {
  const server = await burstGuarded(2, 80);
  try {
    let time = 11_000_000;
    const {voice} = voiceFor(server, {...quick, clock: () => time});
    voice.gate.tighten();                       // what a refusal does
    assert.equal(voice.gate.cap, VOXTRAL_LIMITS.tightConcurrent);
    const settled = await Promise.allSettled(['A', 'B', 'C', 'D'].map(name => voice.synthesizeStream('judy-alvarez', `${name} answers.`, {onPcm() {}})));
    assert.deepEqual(settled.map(entry => entry.status), Array(4).fill('fulfilled'));
    assert.equal(server.stats().refused, 0, 'two at a time never trips a limit of two'); assert.ok(server.stats().peak <= 2);
    time += VOXTRAL_LIMITS.tightMs + 1; assert.equal(voice.gate.cap, VOXTRAL_LIMITS.maxConcurrent, 'the cap returns by itself');
  } finally { await server.close(); }
});

test('the held next speaker is marked ahead and never takes the slots the speaker being heard needs', async () => {
  // Every reply the server gets starts streaming and then waits for its own latch, so what is running stays running while the test looks at it;
  // the test looks when the requests it expects have arrived, however long that takes, and lets the replies go one at a time.
  const latches = {};
  for (const name of ['ahead-1', 'ahead-2', 'speaker']) { let open; latches[name] = {promise: new Promise(resolve => { open = resolve; }), open}; }
  const nameOf = record => record.body.input.split(' ')[0];
  const server = await serve(async (request, response, record) => {
    sse(response); response.write(delta(bytesOf(samples(2400))));
    await latches[nameOf(record)].promise;
    response.end(done);
  });
  try {
    const {voice} = voiceFor(server);
    const order = [], arrived = () => server.requests.map(nameOf);
    const speak = (name, ahead) => voice.synthesizeStream('judy-alvarez', `${name} answers.`, {onPcm() {}, ahead}).then(() => order.push(name));
    // Two look-ahead replies: only one runs at a time. The speaker arriving after them still starts at once.
    const pending = [speak('ahead-1', true), speak('ahead-2', true)];
    await until(() => voice.gate.stats().waiting === 1 && server.requests.length === 1, 'one look-ahead to run and the other to wait');
    assert.equal(voice.gate.stats().runningAhead, 1); assert.equal(voice.gate.stats().waiting, 1, 'the second look-ahead waits for the first');
    assert.deepEqual(arrived(), ['ahead-1'], 'only the first look-ahead was sent');
    const speaker = speak('speaker');
    await until(() => server.requests.length === 2, 'the speaker to be sent');
    assert.deepEqual(arrived(), ['ahead-1', 'speaker'], 'the speaker being heard started at once, beside the look-ahead');
    assert.equal(voice.gate.stats().waiting, 1, 'the second look-ahead is still waiting');
    // The speaker's reply ends first; the look-ahead ones follow, the second only after the first has finished.
    latches.speaker.open();
    await speaker;
    assert.deepEqual(arrived(), ['ahead-1', 'speaker'], 'a finished speaker does not let the second look-ahead past the first');
    latches['ahead-1'].open();
    await until(() => server.requests.length === 3, 'the second look-ahead to be sent');
    latches['ahead-2'].open();
    await Promise.all(pending);
    assert.deepEqual(order, ['speaker', 'ahead-1', 'ahead-2']);
  } finally { Object.values(latches).forEach(latch => latch.open()); await server.close(); }
});


// ---- Voxtral TTS 3: the v3 id, and the older alias when the account refuses it ------------------------------------------------------

// A server that refuses one model id the way `refuse` says and speaks for any other.
const refusing = (refuse, rejected = VOXTRAL_MODEL) => serve((request, response, record) => {
  if (record.body?.model === rejected) { const [status, body] = refuse(); response.writeHead(status, {'content-type': 'application/json'}); response.end(body); return; }
  sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done);
});

test('the account refuses the v3 id (404, 402, or an invalid model): the same line is asked of the older model at once, spoken, with one log line; the next replies go straight to it', async () => {
  for (const refuse of [() => [404, '{"message":"Not found"}'], () => [402, '{"message":"Payment required"}'], () => [400, '{"message":"Invalid model: voxtral-mini-tts-3-0"}']]) {
    const server = await refusing(refuse);
    try {
      const logs = [];
      let time = 20_000_000;
      const {voice} = voiceFor(server, {...quick, clock: () => time, onLog: line => logs.push(line)});
      assert.equal(voice.model, VOXTRAL_MODEL); assert.equal(voice.speaks('pl'), true); assert.equal(voice.speaks('fr'), true);
      const first = collect();
      const result = await voice.synthesizeStream('judy-alvarez', 'Hello V.', first);
      assert.equal(result.truncated, false); assert.ok(first.packets.length > 0, 'the line was spoken');
      assert.deepEqual(server.requests.map(request => request.body.model), [VOXTRAL_MODEL, VOXTRAL_FALLBACK_MODEL]);
      assert.equal(voice.model, VOXTRAL_FALLBACK_MODEL); assert.equal(voice.degraded, null, 'a refused model is not a refused key');
      assert.equal(voice.speaks('fr'), true); assert.equal(voice.speaks('pl'), false, 'the older model speaks 9 languages: not Polish');
      await voice.synthesizeStream('judy-alvarez', 'Again.', collect());
      assert.deepEqual(server.requests.slice(2).map(request => request.body.model), [VOXTRAL_FALLBACK_MODEL]);
      assert.equal(logs.filter(line => /was refused for this key/.test(line)).length, 1, logs.join('|'));
      time += VOXTRAL_LIMITS.modelRetryMs + 1;
      assert.equal(voice.model, VOXTRAL_MODEL, 'after the retry time v3 is asked again'); assert.equal(voice.speaks('pl'), true);
      await voice.synthesizeStream('judy-alvarez', 'Third.', collect());
      assert.deepEqual(server.requests.slice(3).map(request => request.body.model), [VOXTRAL_MODEL, VOXTRAL_FALLBACK_MODEL], 'refused again: the older model answers in the same ask');
      assert.equal(logs.filter(line => /was refused for this key/.test(line)).length, 1, 'the line is not repeated');
    } finally { await server.close(); }
  }
});

test('a 403 that repeats on v3 while the older model answers is the plan refusing v3: the line is spoken; a single 403 hiccup stays on v3', async () => {
  const server = await refusing(() => [403, '{"message":"Forbidden"}']);
  try {
    const {voice} = voiceFor(server, quick);
    const sink = collect();
    await voice.synthesizeStream('judy-alvarez', 'Hello V.', sink);
    assert.ok(sink.packets.length > 0);
    assert.deepEqual(server.requests.map(request => request.body.model), [VOXTRAL_MODEL, VOXTRAL_MODEL, VOXTRAL_FALLBACK_MODEL]);
    assert.equal(voice.model, VOXTRAL_FALLBACK_MODEL);
  } finally { await server.close(); }
  const hiccup = await flaky(403, 1);
  try {
    const {voice} = voiceFor(hiccup, quick);
    await voice.synthesizeStream('judy-alvarez', 'Hello V.', collect());
    assert.deepEqual(hiccup.requests.map(request => request.body.model), [VOXTRAL_MODEL, VOXTRAL_MODEL]);
    assert.equal(voice.model, VOXTRAL_MODEL, 'one 403 that goes away on the quick second ask is a hiccup, not a plan');
  } finally { await hiccup.close(); }
});

test('both models refused (a missing plan or a bad key): the error is thrown as before and the voice does not change model; a limit, a server fault and a guardrail refusal never try the alias', async () => {
  const both = await serve((request, response) => { response.writeHead(404, {'content-type': 'application/json'}); response.end('{"message":"Not found"}'); });
  try {
    const {voice} = voiceFor(both, quick);
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hello V.', collect()), {kind: 'request', status: 404});
    assert.deepEqual(both.requests.map(request => request.body.model), [VOXTRAL_MODEL, VOXTRAL_FALLBACK_MODEL]);
    assert.equal(voice.model, VOXTRAL_MODEL);
  } finally { await both.close(); }
  for (const [status, body, kind] of [[429, '{"message":"slow"}', 'limit'], [503, 'down', 'network'], [403, '{"message":"Request blocked by guardrail policy"}', 'content'], [401, '{"message":"bad key"}', 'key']]) {
    const server = await serve((request, response) => { response.writeHead(status, {'content-type': 'application/json', 'retry-after': '30'}); response.end(body); });
    try {
      const {voice} = voiceFor(server, quick);
      await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hello V.', collect()), {kind}, String(status));
      assert.ok(server.requests.every(request => request.body.model === VOXTRAL_MODEL), `${status}: only the v3 id is ever sent`);
      assert.equal(voice.model, VOXTRAL_MODEL);
    } finally { await server.close(); }
  }
});

test('Voxtral speaks the language of the text: the request carries no language field, and the language lists are Mistral\'s own (22 for v3, 9 for the older model)', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done); });
  try {
    const {voice} = voiceFor(server);
    await voice.synthesizeStream('judy-alvarez', 'Hola, como estas?', collect());
    assert.equal(server.requests[0].body.input, 'Hola, como estas?');
    assert.deepEqual(Object.keys(server.requests[0].body).sort(), ['input', 'model', 'ref_audio', 'response_format', 'stream']);
  } finally { await server.close(); }
  assert.equal(VOXTRAL_TTS3_LANGUAGES.length, 22); assert.equal(VOXTRAL_TTS1_LANGUAGES.length, 9);
  for (const language of ['en', 'fr', 'es', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'uk', 'tr', 'hu', 'ar', 'hi', 'ja', 'ko', 'zh', 'el']) assert.equal(voxtralSpeaks(language), true, language);
  for (const language of ['cs', 'sv', 'he', 'th']) assert.equal(voxtralSpeaks(language), false, language + ': not named by Mistral for TTS 3');
  for (const language of ['pl', 'ru', 'uk', 'tr', 'ja', 'ko', 'zh']) assert.equal(voxtralSpeaks(language, VOXTRAL_FALLBACK_MODEL), false, language + ' on the older model');
  assert.equal(voxtralSpeaks('en', VOXTRAL_FALLBACK_MODEL), true); assert.equal(voxtralSpeaks(null), true); assert.equal(voxtralSpeaks('fr', VOXTRAL_FALLBACK_MODEL), true);
  assert.equal(modelRefused({status: 404, kind: 'request'}), true); assert.equal(modelRefused({status: 403, kind: 'key'}), false); assert.equal(modelRefused({status: 403, kind: 'key'}, 1), true);
  assert.equal(modelRefused({status: 403, kind: 'content'}, 1), false); assert.equal(modelRefused({status: 429, kind: 'limit'}, 1), false);
});
