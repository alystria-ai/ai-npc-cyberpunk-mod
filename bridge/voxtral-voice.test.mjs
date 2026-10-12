import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {VoxtralVoice, VoxtralError, VOXTRAL_LIMITS, capWav, joinWavs, mapStatus, redact, splitReply, sseEvents} from './voxtral-voice.mjs';
import {createVoiceProfileRegistry} from './voice-profile-registry.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {ownedLocalPcmPacket} from './local-pcm-host.mjs';
import {cloudReferenceOf, describeVoiceRoute, formatVoiceRoute} from './voice-routing-log.mjs';
import {LOCAL_VOICE_KEYS} from './resident-voice.mjs';
import {MistralScheduler, PRIORITY} from './mistral-rate.mjs';
import {Utterance} from './voice-utterance.mjs';

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

// ---- the voice selection: menu choice, fallback to Pocket, one report ---------------------------------------------------------

const pocketSettings = voices => ({version: 1, provider: 'pocket', engine: 'pocket-tts', voices,
  runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('fixture', key)])),
  model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64),
    inputIdentity: 'e'.repeat(64), selectedStep: 1500}});

function selection(server, {key = KEY, voxtral = {}, pocket = null} = {}) {
  const calls = [], states = [];
  const voices = Object.fromEntries(LOCAL_VOICE_KEYS.map(name => [name, {reference: `runtime/voice-references/${name}.wav`,
    sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.'}]));
  const cloud = new VoxtralVoice({getKey: () => key, referenceRoot: resolve('fixture-references'), endpoint: server.endpoint,
    read: async () => REFERENCE, scheduler: fastScheduler(), ...voxtral});
  const longVoices = Object.fromEntries(LOCAL_VOICE_KEYS.map(name => [name, {reference: `runtime/voice-references/${name}.wav`,
    sha256: sha(REFERENCE), transcript: 'Ready when you are, V.'}]));
  const voice = new VoiceSelection(pocketSettings(voices), {voxtral: cloud, onState: value => states.push(value),
    omniConfigs: {short: {}, long: {version: 2, provider: 'hybrid', engine: 'omnivoice', voices: longVoices}},
    factory: (config, {onState}) => {
      let loaded = false;
      return {get loaded() { return loaded; }, hasProfile: name => Object.hasOwn(config.voices, name), profileReady: name => loaded && Object.hasOwn(config.voices, name),
        async prepareProfile(name) { return {provider: 'pocket', ready: true, profile: name}; },
        async start() { loaded = true; onState({state: 'ready', resident: true}); },
        async synthesizeStream(name, text, options) { calls.push({name, text}); if (pocket) return pocket(name, text, options); await options.onPcm?.({marker: 'pocket'}); return {audio: 'pocket'}; },
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

test('the routing log names the cloud voice; Pocket with a reason only when the cloud voice cannot be asked; an earlier timeout is carried as cloudLast', async () => {
  const server = await serve(async () => { await wait(300); });
  try {
    const h = selection(server, {voxtral: {limits: {firstAudioMs: 40}}});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const describe = () => describeVoiceRoute({voice: h.voice, input: {profileKey: 'judy-alvarez'}, profile: {key: 'judy-alvarez', name: 'Judy'},
      plan: {engine: 'pocket'}, reply: {engine: 'pocket'}, now: () => 0});
    let record = describe();
    assert.equal(record.requested, 'Mistral cloud voice (Voxtral)'); assert.equal(record.used, 'Mistral cloud voice (Voxtral)'); assert.equal(record.fallback, null);
    assert.ok(record.reference, 'the log names the reference the cloud voice clones from');
    await h.voice.synthesizeStream('judy-alvarez', 'Late.', {onPcm() {}});
    // The line for the NEXT reply is written before that reply is voiced: a timeout on this one must not make it claim Pocket (2026-10-13:
    // the line said used=Pocket for a reply that Voxtral then spoke from start to end).
    record = describe();
    assert.equal(record.used, 'Mistral cloud voice (Voxtral)'); assert.equal(record.fallback, null); assert.equal(record.cloudLast, 'timeout');
    const line = formatVoiceRoute(record);
    assert.ok(line.includes('used="Mistral cloud voice (Voxtral)"') && line.includes('cloudLast=timeout') && !line.includes('fallback='), line);
    // No key: the cloud voice cannot be asked at all, so Pocket is what speaks, and the line says why.
    h.cloud.getKey = () => null;
    record = describe();
    assert.equal(record.used, 'Pocket'); assert.equal(record.fallback, 'Mistral cloud voice has no key'); assert.equal(record.cloudLast, undefined);
    assert.ok(formatVoiceRoute(record).includes('fallback="Mistral cloud voice has no key"'));
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
    const scheduler = new MistralScheduler({spacingMs: 250});
    const {voice} = voiceFor(server, {scheduler, limits: {firstAudioMs: 100}});
    const order = [];
    const text = scheduler.schedule(async () => { order.push('text'); }, {priority: PRIORITY.TEXT});
    const started = performance.now();
    const spoken = await voice.synthesizeStream('judy-alvarez', 'Queued behind a text request.', {onPcm() { order.push('audio'); }});
    await text;
    assert.ok(performance.now() - started >= 230, 'it waited for the slot (longer than its own 100 ms first-audio limit)');
    assert.equal(spoken.truncated, false); assert.equal(voice.degraded, null); assert.equal(server.requests.length, 1);
    assert.equal(order[0], 'text');
  } finally { await server.close(); }
});

test('a text request that arrives while the speech is queued goes first', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done); });
  try {
    const scheduler = new MistralScheduler({spacingMs: 150}), order = [];
    const {voice} = voiceFor(server, {scheduler});
    const occupy = scheduler.schedule(async () => { order.push('earlier request'); });
    const speech = voice.synthesizeStream('judy-alvarez', 'Hi.', {onPcm() {}}).then(() => order.push('speech'));
    await wait(20);
    const text = scheduler.schedule(async () => { order.push('text reply'); }, {priority: PRIORITY.TEXT});
    await Promise.all([occupy, speech, text]);
    assert.deepEqual(order, ['earlier request', 'text reply', 'speech']);
  } finally { await server.close(); }
});

test('several group speakers go out one after another, spaced by the scheduler, each as its own single request', async () => {
  const times = [];
  const server = await serve((request, response) => { times.push(performance.now()); sse(response); response.write(delta(bytesOf(samples(2400)))); response.end(done); });
  try {
    const scheduler = new MistralScheduler({spacingMs: 120});
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
    const scheduler = new MistralScheduler({spacingMs: 600});
    const {voice} = voiceFor(server, {scheduler, limits: {maxQueueMs: 60}});
    await scheduler.schedule(async () => {});
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'Too late.', collect()), {kind: 'timeout'});
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

// A server that answers by the text it was sent: `plans[text]` = {delay, deltas: [Float32Array...], then: 'done' | 'drop' | status}.
function planned(plans) {
  const at = {};
  return serve(async (request, response, record) => {
    const plan = plans.find(candidate => record.body?.input === candidate.input);
    at[plan?.name] = performance.now();
    if (!plan) { response.writeHead(400); response.end('unexpected text'); return; }
    if (plan.delay) await wait(plan.delay);
    if (typeof plan.then === 'number') { response.writeHead(plan.then, {'content-type': 'application/json'}); response.end('{"message":"no"}'); return; }
    sse(response);
    for (const [index, samplesOut] of (plan.deltas ?? []).entries()) {
      if (index && plan.gap) await wait(plan.gap);
      response.write(delta(bytesOf(samplesOut)));
    }
    if (plan.then === 'drop') { await wait(plan.dropAfter ?? 0); response.destroy(); return; }
    response.end(done);
  }).then(server => Object.assign(server, {at}));
}
const level = (count, value) => new Float32Array(count).fill(value);
const valuesOf = packets => packets.map(packet => packet.pcm[0]);

test('a long reply goes out as two requests started together, and the audio reaches the player in order as one reply', async () => {
  const server = await planned([
    {name: 'first', input: FIRST, delay: 150, deltas: [level(24000, 0.25), level(24000, 0.25)]},
    {name: 'second', input: REST, deltas: [level(4800, 0.5), level(4800, 0.5)]}]);
  try {
    const logs = [];
    const {voice} = voiceFor(server, {onLog: line => logs.push(line)});
    const sink = collect();
    const result = await voice.synthesizeStream('judy-alvarez', LONG, sink);
    assert.equal(server.requests.length, 2);
    assert.deepEqual(server.requests.map(request => request.body.input).sort(), [FIRST, REST].sort());
    assert.ok(Math.abs(server.at.second - server.at.first) < 100, 'the second request did not wait for the first to finish');
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
      assert.ok(logs.some(line => line.includes('the rest of the reply: ') && line.includes('asking again')), logs.join('|'));
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
    const logs = [];
    const {voice} = voiceFor(server, {limits: {splitMarginMs: 100, tailFirstAudioMs: 150, tailRetryAudioMs: 2000}, onLog: line => logs.push(line)});
    const sink = collect();
    const result = await voice.synthesizeStream('judy-alvarez', LONG, sink);
    assert.equal(asks[REST], 2); assert.equal(result.truncated, false);
    assert.deepEqual([...new Set(valuesOf(sink.packets))], [0.25, 0.5]); assert.equal(result.frames, 4800 + 9600);
    assert.equal(voice.degraded, null, 'a rest that arrived on the second ask is a success');
    assert.ok(logs.some(line => line.includes('asking again')), logs.join('|'));
  } finally { await server.close(); }
  // Both asks hang: the reply ends after the first part within the two limits, not after the server's delay.
  const slow = await planned([
    {name: 'first', input: FIRST, deltas: [level(4800, 0.25)]},
    {name: 'second', input: REST, delay: 3000, deltas: [level(2400, 0.5)]}]);
  try {
    const {voice} = voiceFor(slow, {limits: {splitMarginMs: 100, tailFirstAudioMs: 120, tailRetryAudioMs: 180}});
    const started = performance.now();
    const result = await voice.synthesizeStream('judy-alvarez', LONG, collect());
    assert.equal(result.truncated, true); assert.equal(result.remainder, undefined);
    assert.ok(performance.now() - started < 1500, 'did not wait for the slow request');
    assert.equal(voice.degraded.reason, 'timeout');
  } finally { await slow.close(); }
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
  const server = await planned([
    {name: 'first', input: FIRST, delay: 400, deltas: [level(2400, 0.25)]},
    {name: 'second', input: REST, delay: 400, deltas: [level(2400, 0.5)]}]);
  try {
    const {voice} = voiceFor(server);
    const controller = new AbortController(), sink = collect();
    const speaking = voice.synthesizeStream('judy-alvarez', LONG, {...sink, signal: controller.signal});
    await wait(100); controller.abort();
    await assert.rejects(speaking, error => error.name === 'AbortError' || /cancel/i.test(error.message));
    await wait(100);
    assert.equal(sink.packets.length, 0);
    assert.ok(server.requests.every(request => request.closed), 'both connections were closed');
  } finally { await server.close(); }
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
    const logs = [];
    const h = selection(server, {voxtral: {limits: {tailFirstAudioMs: 120, tailRetryAudioMs: 2000}, onLog: line => logs.push(line)},
      pocket: async () => { throw Error('Pocket must not speak any of this reply'); }});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const utterance = new Utterance(), head = collect(), tail = collect();
    // The tail is asked for in parallel with the head, as soon as its text is known.
    const [headResult, tailResult] = await Promise.all([headOf(h, head, {utterance}), tailOf(h, tail, utterance)]);
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

test('head failing before any audio: Pocket speaks the whole reply, and the tail that the cloud voice already had is dropped', async () => {
  const server = await planned([
    {name: 'head', input: HEAD, then: 503},
    {name: 'tail', input: TAIL, deltas: [level(4800, 0.5)]}]);
  try {
    const h = selection(server, {pocket: pocketPackets(Math.fround(0.9))});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const utterance = new Utterance(), head = collect(), tail = collect();
    await Promise.all([headOf(h, head, {utterance}), tailOf(h, tail, utterance)]);
    assert.equal(utterance.engine, 'pocket');
    assert.deepEqual(h.calls.map(call => call.text), [HEAD, TAIL], 'Pocket spoke both pieces');
    assert.ok(head.packets.every(packet => packet.pcm[0] === Math.fround(0.9)));
    assert.ok(tail.packets.length > 0 && tail.packets.every(packet => packet.pcm[0] === Math.fround(0.9)), 'no cloud audio in the tail');
  } finally { await server.close(); }
});

test('the tail\'s cloud audio is held until the head is known to be in the cloud voice, then handed on in order', async () => {
  const server = await planned([
    {name: 'head', input: HEAD, delay: 350, deltas: [level(2400, 0.25)]},
    {name: 'tail', input: TAIL, deltas: [level(2400, 0.5), level(2400, 0.5)], gap: 20}]);
  try {
    const h = selection(server, {pocket: async () => { throw Error('Pocket must not speak'); }});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const utterance = new Utterance(), head = collect(), tail = collect();
    const speaking = Promise.all([headOf(h, head, {utterance}), tailOf(h, tail, utterance)]);
    await wait(200);
    assert.equal(tail.packets.length, 0, 'the tail answered first, but its audio waits for the head\'s decision');
    assert.equal(utterance.engine, null);
    await speaking;
    assert.equal(utterance.engine, 'voxtral'); assert.equal(head.packets.length, 1); assert.equal(tail.packets.length, 2);
    assert.deepEqual(tail.packets.map(packet => packet.index), [1, 2]);
  } finally { await server.close(); }
});

test('a tail whose head was spoken by Pocket sends nothing to the cloud voice', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(level(2400, 0.5)))); response.end(done); });
  try {
    const h = selection(server, {pocket: pocketPackets(Math.fround(0.9))});
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const utterance = new Utterance(); utterance.decide('pocket');
    const tail = collect();
    await tailOf(h, tail, utterance);
    assert.equal(server.requests.length, 0); assert.deepEqual(h.calls.map(call => call.text), [TAIL]);
    // With the cloud voice not chosen at all, head and tail are Pocket's and nothing else happens.
    h.voice.update({voiceProvider: 'pocket'}, null, false);
    const other = new Utterance(), headSink = collect(), tailSink = collect();
    await headOf(h, headSink, {utterance: other}); await tailOf(h, tailSink, other);
    assert.equal(other.engine, 'pocket'); assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test('cancelling while the tail waits for the head stops the tail\'s request', async () => {
  const server = await planned([{name: 'tail', input: TAIL, delay: 500, deltas: [level(2400, 0.5)]}]);
  try {
    const h = selection(server);
    h.voice.update({voiceProvider: 'voxtral'}, null, false); await h.voice.start();
    const utterance = new Utterance(), controller = new AbortController(), tail = collect();
    const speaking = h.voice.synthesizeStream('judy-alvarez', TAIL, {onPcm: tail.onPcm, signal: controller.signal, utterance, role: 'tail'});
    await wait(80); controller.abort();
    await assert.rejects(speaking, error => error.name === 'AbortError' || /cancel/i.test(error.message));
    await wait(80);
    assert.ok(server.requests.every(request => request.closed), 'the connection was closed');
  } finally { await server.close(); }
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
