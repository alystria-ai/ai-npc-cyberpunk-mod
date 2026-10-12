import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {VoxtralVoice, VoxtralError, VOXTRAL_LIMITS, capWav, mapStatus, redact, sseEvents} from './voxtral-voice.mjs';
import {createVoiceProfileRegistry} from './voice-profile-registry.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {ownedLocalPcmPacket} from './local-pcm-host.mjs';
import {describeVoiceRoute, formatVoiceRoute} from './voice-routing-log.mjs';
import {LOCAL_VOICE_KEYS} from './resident-voice.mjs';

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
    endpoint: server.endpoint, read: async path => { reads.push(path); return REFERENCE; }, ...extra});
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
    assert.equal(first.body.model, 'voxtral-mini-tts-latest'); assert.equal(first.body.response_format, 'pcm');
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
  const server = await serve(async (request, response) => { await wait(400); if (!response.destroyed) { sse(response); response.end(done); } });
  try {
    const changes = [];
    const {voice} = voiceFor(server, {limits: {firstAudioMs: 60}, onChange: value => changes.push(value?.reason ?? null)});
    const sink = collect(), started = performance.now();
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hi.', sink), error => error instanceof VoxtralError && error.kind === 'timeout');
    assert.ok(performance.now() - started < 300, 'it gave up at the limit, not when the server answered');
    assert.equal(sink.packets.length, 0); assert.equal(voice.degraded.reason, 'timeout');
    await wait(30);
    assert.equal(server.requests[0].closed, true, 'the abandoned request is aborted');
    // The next reply is tried again (a spike is not a verdict) and clears the report.
    server.requests.length = 0;
    voice.limits = Object.freeze({...voice.limits, firstAudioMs: 2000});
    const fast = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done); });
    voice.endpoint = fast.endpoint;
    await voice.synthesizeStream('judy-alvarez', 'Again.', collect());
    assert.equal(voice.degraded, null); assert.deepEqual(changes, ['timeout', null]);
    await fast.close();
  } finally { await server.close(); }
});

test('a headers-only server that never sends audio also times out', async () => {
  const server = await serve((request, response) => { sse(response); response.flushHeaders(); });
  try {
    const {voice} = voiceFor(server, {limits: {firstAudioMs: 60}}), sink = collect();
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hi.', sink), {kind: 'timeout'});
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
    const {voice} = voiceFor(server, {clock: () => time});
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Hi.', collect()), {kind: 'limit', status: 429});
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
  assert.equal(VOXTRAL_LIMITS.firstAudioMs, 4000);
});

// ---- the voice selection: menu choice, fallback to Pocket, one report ---------------------------------------------------------

const pocketSettings = voices => ({version: 1, provider: 'pocket', engine: 'pocket-tts', voices,
  runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('fixture', key)])),
  model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64),
    inputIdentity: 'e'.repeat(64), selectedStep: 1500}});

function selection(server, {key = KEY, voxtral = {}} = {}) {
  const calls = [], states = [];
  const voices = Object.fromEntries(LOCAL_VOICE_KEYS.map(name => [name, {reference: `runtime/voice-references/${name}.wav`,
    sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.'}]));
  const cloud = new VoxtralVoice({getKey: () => key, referenceRoot: resolve('fixture-references'), endpoint: server.endpoint,
    read: async () => REFERENCE, ...voxtral});
  const longVoices = Object.fromEntries(LOCAL_VOICE_KEYS.map(name => [name, {reference: `runtime/voice-references/${name}.wav`,
    sha256: sha(REFERENCE), transcript: 'Ready when you are, V.'}]));
  const voice = new VoiceSelection(pocketSettings(voices), {voxtral: cloud, onState: value => states.push(value),
    omniConfigs: {short: {}, long: {version: 2, provider: 'hybrid', engine: 'omnivoice', voices: longVoices}},
    factory: (config, {onState}) => {
      let loaded = false;
      return {get loaded() { return loaded; }, hasProfile: name => Object.hasOwn(config.voices, name), profileReady: name => loaded && Object.hasOwn(config.voices, name),
        async prepareProfile(name) { return {provider: 'pocket', ready: true, profile: name}; },
        async start() { loaded = true; onState({state: 'ready', resident: true}); },
        async synthesizeStream(name, text, options) { calls.push({name, text}); await options.onPcm?.({marker: 'pocket'}); return {audio: 'pocket'}; },
        async close() { loaded = false; onState({state: 'stopped'}); }};
    }});
  return {voice, cloud, calls, states};
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

test('a cloud reply that is late, limited or fails speaks with Pocket instead; the report names why and clears itself', async () => {
  let mode = 'slow';
  const server = await serve(async (request, response) => {
    if (mode === 'slow') { await wait(300); return; }
    if (mode === 'limit') { response.writeHead(429); response.end(); return; }
    sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done);
  });
  try {
    const h = selection(server, {voxtral: {limits: {firstAudioMs: 60}}});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const packets = [];
    const spoken = await h.voice.synthesizeStream('judy-alvarez', 'Late reply.', {onPcm: packet => { packets.push(packet); }});
    assert.equal(spoken.audio, 'pocket'); assert.equal(h.calls.length, 1); assert.deepEqual(packets, [{marker: 'pocket'}]);
    assert.deepEqual(h.voice.cloudFallback, {from: 'voxtral', to: 'pocket', temporary: true, reason: 'timeout'});
    h.voice.publish();
    assert.deepEqual(h.states.at(-1).fallback, {from: 'voxtral', to: 'pocket', temporary: true, reason: 'timeout'});
    assert.equal(h.states.at(-1).cloudVoice, 'voxtral'); assert.equal(h.states.at(-1).voxtral.degraded, 'timeout');
    mode = 'limit';
    await h.voice.synthesizeStream('judy-alvarez', 'Limited.', {onPcm() {}});
    assert.equal(h.calls.length, 2); assert.equal(h.voice.cloudFallback.reason, 'limit');
    // Inside the cool-down the cloud voice is not even asked.
    const before = server.requests.length;
    await h.voice.synthesizeStream('judy-alvarez', 'Still limited.', {onPcm() {}});
    assert.equal(server.requests.length, before); assert.equal(h.calls.length, 3);
    // States published by the voice itself (a fallback must reach Settings without waiting for the next poll).
    assert.equal(h.states.some(state => state.fallback?.reason === 'limit'), true);
    await h.voice.close();
  } finally { await server.close(); }
});

test('without a Mistral key the cloud voice is unavailable and every reply is Pocket; a key added later is used at once', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done); });
  try {
    let key = null;
    const h = selection(server); h.cloud.getKey = () => key;
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    assert.deepEqual(h.voice.cloudFallback, {from: 'voxtral', to: 'pocket', temporary: false, reason: 'no-key'});
    const spoken = await h.voice.synthesizeStream('judy-alvarez', 'No key.', {onPcm() {}});
    assert.equal(spoken.audio, 'pocket'); assert.equal(server.requests.length, 0);
    key = KEY;
    assert.equal(h.voice.cloudFallback, null, 'the key is back, so the report is gone');
    const cloud = await h.voice.synthesizeStream('judy-alvarez', 'With a key.', {onPcm() {}});
    assert.equal(cloud.provider, 'voxtral'); assert.equal(h.voice.cloudFallback, null);
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

test('multilingual conversations keep the cloud voice out: Pocket is skipped, so the route is the Convai voice', async () => {
  const server = await serve((request, response) => { response.end(); });
  try {
    const h = selection(server);
    h.voice.update({voiceProvider: 'voxtral', multilingualConversations: true}, null, false);
    assert.equal(h.voice.provider, 'convai'); assert.equal(h.voice.cloudActive, false);
    await h.voice.close();
  } finally { await server.close(); }
});

test('the routing log names the cloud voice, and Pocket with the reason when it fell back', async () => {
  const server = await serve(async () => { await wait(300); });
  try {
    const h = selection(server, {voxtral: {limits: {firstAudioMs: 40}}});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const describe = () => describeVoiceRoute({voice: h.voice, input: {profileKey: 'judy-alvarez'}, profile: {key: 'judy-alvarez', name: 'Judy'},
      plan: {engine: 'pocket'}, reply: {engine: 'pocket'}, now: () => 0});
    let record = describe();
    assert.equal(record.requested, 'Mistral cloud voice (Voxtral)'); assert.equal(record.used, 'Mistral cloud voice (Voxtral)'); assert.equal(record.fallback, null);
    await h.voice.synthesizeStream('judy-alvarez', 'Late.', {onPcm() {}});
    record = describe();
    assert.equal(record.used, 'Pocket'); assert.equal(record.fallback, 'Mistral cloud voice fell back (timeout)');
    assert.ok(formatVoiceRoute(record).includes('fallback="Mistral cloud voice fell back (timeout)"'));
    await h.voice.close();
  } finally { await server.close(); }
});
