// Failure paths of the Mistral cloud voice (bridge/voxtral-voice.mjs) that voxtral-voice.test.mjs does not pin: an error event inside the
// audio stream, a stream that ends without its closing event or without audio, a stream that goes quiet after audio began, samples that are
// not numbers, text that cannot be spoken, a reference that is too large, a response with no body, and a refused key that is replaced.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {VoxtralVoice, VoxtralError} from './voxtral-voice.mjs';
import {createVoiceProfileRegistry} from './voice-profile-registry.mjs';
import {MistralScheduler} from './mistral-rate.mjs';
import {manualTimers, track, until} from './fixtures/test-waits.mjs';

const KEY = 'k'.repeat(8) + 'Secret0123456789abcdefghijkl';
const OTHER_KEY = 'n'.repeat(8) + 'Fresh0123456789abcdefghijklm';

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
const registry = createVoiceProfileRegistry({version: 2, provider: 'hybrid', engine: 'omnivoice',
  voices: {'judy-alvarez': {reference: 'runtime/voice-references/judy-alvarez.wav', sha256: createHash('sha256').update(REFERENCE).digest('hex'), transcript: 'Ready when you are, V.'}}});
const samples = (count, offset = 0) => Float32Array.from({length: count}, (_, at) => Math.fround(Math.sin((at + offset) / 37) * 0.5));
const bytesOf = floats => Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
const delta = bytes => `event: speech.audio.delta\ndata: ${JSON.stringify({type: 'speech.audio.delta', audio_data: bytes.toString('base64')})}\n\n`;
const done = `event: speech.audio.done\ndata: ${JSON.stringify({type: 'speech.audio.done'})}\n\n`;

async function serve(handler) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const record = {headers: request.headers};
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
  const logs = [];
  const voice = new VoxtralVoice({getKey: () => KEY, referenceRoot: resolve('fixture-references'), registry, endpoint: server.endpoint,
    read: async () => REFERENCE, scheduler: new MistralScheduler({spacingMs: 0}), onLog: line => logs.push(line), ...extra});
  return {voice, logs};
}
const collect = () => { const packets = []; return {packets, onPcm: packet => { packets.push(packet); }}; };
const joined = packets => { const out = new Float32Array(packets.reduce((sum, packet) => sum + packet.frames, 0)); let at = 0; for (const packet of packets) { out.set(packet.pcm, at); at += packet.frames; } return out; };

// ---- an error inside the audio stream ---------------------------------------------------------------------------------------------------

test('an error event before any audio fails the ask as a refused request with the key scrubbed; after audio it ends the reply early instead', async () => {
  for (const event of [{type: 'error', message: `model overloaded for ${KEY}`}, {error: {message: `quota used up for ${KEY}`}}]) {
    const server = await serve((request, response) => { sse(response); response.end(`data: ${JSON.stringify(event)}\n\n`); });
    try {
      const {voice} = voiceFor(server), sink = collect();
      const error = await voice.synthesizeStream('judy-alvarez', 'Hello V.', sink).catch(caught => caught);
      assert.ok(error instanceof VoxtralError);
      assert.equal(error.kind, 'request');
      assert.doesNotMatch(error.message, new RegExp(KEY));
      assert.equal(sink.packets.length, 0);
    } finally { await server.close(); }
  }
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(6000)))); response.end(`data: ${JSON.stringify({type: 'error', message: 'the backend fell over'})}\n\n`); });
  try {
    const {voice, logs} = voiceFor(server), sink = collect();
    const result = await voice.synthesizeStream('judy-alvarez', 'A longer reply for V.', sink);
    assert.equal(result.truncated, true);
    assert.equal(result.frames, 6000, 'every sample received before the error was handed on, the last partial packet included');
    assert.ok(logs.some(line => /stream ended early/.test(line)), logs.join('|'));
    assert.equal(voice.degraded, null, 'the reply that was heard is not reported as a failure of the voice');
  } finally { await server.close(); }
});

test('a stream that closes without its closing event ends the reply early; one with no audio at all is a refused request, whatever its closing event says', async () => {
  const cut = await serve((request, response) => { sse(response); response.end(delta(bytesOf(samples(5000)))); });
  try {
    const {voice} = voiceFor(cut), sink = collect();
    const result = await voice.synthesizeStream('judy-alvarez', 'A long reply.', sink);
    assert.equal(result.truncated, true);
    assert.equal(result.frames, 5000);
    assert.equal(result.timing.voiceTruncated, true);
  } finally { await cut.close(); }
  for (const body of ['', done, ': only a keep-alive\n\n', `event: speech.audio.delta\ndata: ${JSON.stringify({type: 'speech.audio.delta', audio_data: ''})}\n\n${done}`]) {
    const empty = await serve((request, response) => { sse(response); response.end(body); });
    try {
      const {voice} = voiceFor(empty), sink = collect();
      const error = await voice.synthesizeStream('judy-alvarez', 'Hello V.', sink).catch(caught => caught);
      assert.equal(error.kind, 'request', JSON.stringify(body.slice(0, 40)));
      assert.match(error.message, /answered without audio/);
      assert.equal(sink.packets.length, 0);
    } finally { await empty.close(); }
  }
});

test('a stream that goes quiet after its audio began is cut at the stall limit and the reply ends there; the request is dropped', async () => {
  const server = await serve((request, response) => { sse(response); response.write(delta(bytesOf(samples(5000)))); /* then silence */ });
  try {
    // The stall limit is a timer of the voice on a manual clock, moved once the audio has been handed on and the voice is waiting for more. The
    // server never writes again, so nothing but the limit can end the reply: it ends when the clock reaches 60 ms, not a moment before.
    const timers = manualTimers();
    const {voice} = voiceFor(server, {...timers.hooks, limits: {stallMs: 60}}), sink = collect();
    const call = track(voice.synthesizeStream('judy-alvarez', 'A long reply for V.', sink));
    await until(() => timers.limits().includes(60), 'the stall limit to be set after the first audio');
    assert.equal(sink.packets.length, 2, 'the audio that arrived was handed on before the voice began to wait for more');
    await timers.clock.advance(59);
    assert.equal(call.done, false, 'left open until the stall limit');
    await timers.clock.advance(1);
    await until(() => call.done, 'the reply to end at the stall limit');
    assert.equal(call.error, undefined, String(call.error));
    assert.equal(call.value.truncated, true);
    assert.equal(call.value.frames, 5000);
    await until(() => server.requests[0].closed === true, 'the request to be dropped');
  } finally { await server.close(); }
});

test('events that are not JSON, events of another type and a delta with no audio are skipped; a sample that is not a number is silence', async () => {
  const floats = samples(2400);
  floats[3] = NaN; floats[4] = Infinity; floats[5] = -Infinity;
  const server = await serve((request, response) => {
    sse(response);
    response.write('data: this is not json\n\n');
    response.write(`data: ${JSON.stringify({type: 'speech.usage', tokens: 12})}\n\n`);
    response.write(`data: ${JSON.stringify({type: 'speech.audio.delta'})}\n\n`);
    response.write(`data: ${JSON.stringify({type: 'speech.audio.delta', audio_data: 12345})}\n\n`);
    response.write(delta(bytesOf(floats)));
    response.end(done);
  });
  try {
    const {voice} = voiceFor(server), sink = collect();
    const result = await voice.synthesizeStream('judy-alvarez', 'Hello V.', sink);
    assert.equal(result.truncated, false);
    const heard = joined(sink.packets);
    assert.equal(heard.length, 2400);
    assert.deepEqual(Array.from(heard.slice(3, 6)), [0, 0, 0]);
    assert.equal(heard[2], floats[2], 'the samples around them are untouched');
    assert.ok(heard.every(Number.isFinite));
  } finally { await server.close(); }
});

test('a response with no body is a refused request and leaves no report of a failing voice that was never heard', async () => {
  const fetchImpl = async () => ({ok: true, status: 200, headers: new Headers(), body: null});
  const {voice} = voiceFor({endpoint: 'http://127.0.0.1:9/v1/audio/speech'}, {fetchImpl});
  const error = await voice.synthesizeStream('judy-alvarez', 'Hello V.', collect()).catch(caught => caught);
  assert.equal(error.kind, 'request');
  assert.match(error.message, /answered without a stream/);
  assert.equal(voice.degraded.reason, 'request', 'it is reported, as every refusal that came with no audio is');
});

// ---- what cannot be spoken, and what is never sent ---------------------------------------------------------------------------------------

test('text that cannot be spoken (empty, only blanks, a control character, over 4,000 characters, not a string) is that reply\'s problem: nothing is sent, nothing is paused', async () => {
  const server = await serve((request, response) => { sse(response); response.end(delta(bytesOf(samples(2400))) + done); });
  try {
    const {voice} = voiceFor(server);
    for (const text of ['', '   \n\t', 'Hey\u0007V.', 'Hey\u0000V.', 'a'.repeat(4001), null, undefined, 42, {}]) {
      const error = await voice.synthesizeStream('judy-alvarez', text, collect()).catch(caught => caught);
      assert.equal(error.kind, 'text', JSON.stringify(text)?.slice(0, 30));
    }
    assert.equal(server.requests.length, 0);
    assert.equal(voice.degraded, null);
    assert.equal(voice.until, 0);
    assert.equal(voice.ready, true);
    // A line break and a tab are ordinary text.
    const sink = collect();
    await voice.synthesizeStream('judy-alvarez', 'Hey V.\n\tListen.', sink);
    assert.equal(server.requests.length, 1);
    assert.equal(sink.packets.length, 1);
  } finally { await server.close(); }
});

test('a reference clip larger than the limit is no reference: nothing is sent, and the voice is not reported as failing', async () => {
  const server = await serve((request, response) => { sse(response); response.end(done); });
  try {
    const {voice} = voiceFor(server, {limits: {maxReferenceBytes: 1000}});
    const error = await voice.synthesizeStream('judy-alvarez', 'Hello V.', collect()).catch(caught => caught);
    assert.equal(error.kind, 'no-reference');
    assert.equal(server.requests.length, 0);
    assert.equal(voice.degraded, null);
    // A clip that can be made smaller by the preparer is sent in its smaller form, and one the preparer fails on is sent as it is.
    const small = voiceFor(server, {limits: {maxReferenceBytes: 10_000_000}, prepare: async () => { throw Error('encoder missing'); }});
    await small.voice.synthesizeStream('judy-alvarez', 'Hello V.', collect()).catch(() => {});
    assert.equal(server.requests.length, 1, 'a preparer that fails never stops the call');
  } finally { await server.close(); }
});

test('the voice asks for the key once per call: a key removed between two replies stops the next one before anything is sent', async () => {
  const server = await serve((request, response) => { sse(response); response.end(delta(bytesOf(samples(2400))) + done); });
  try {
    let key = KEY;
    const {voice} = voiceFor(server, {getKey: () => key});
    await voice.synthesizeStream('judy-alvarez', 'One.', collect());
    key = '';
    const error = await voice.synthesizeStream('judy-alvarez', 'Two.', collect()).catch(caught => caught);
    assert.equal(error.kind, 'no-key');
    assert.equal(server.requests.length, 1);
    assert.equal(voice.ready, false);
    key = OTHER_KEY;
    await voice.synthesizeStream('judy-alvarez', 'Three.', collect());
    assert.equal(server.requests.at(-1).headers.authorization, `Bearer ${OTHER_KEY}`);
    assert.equal(voice.degraded, null);
  } finally { await server.close(); }
});

// ---- a refused key that is replaced -----------------------------------------------------------------------------------------------------

test('after a refused key (HTTP 401) the player saves another key: the new key is tried at once, not after the 60 s that belonged to the old one', async () => {
  let refuse = true;
  const server = await serve((request, response) => {
    if (refuse && request.headers.authorization === `Bearer ${KEY}`) { response.writeHead(401, {'content-type': 'application/json'}); response.end('{"message":"Unauthorized"}'); return; }
    sse(response); response.end(delta(bytesOf(samples(2400))) + done);
  });
  try {
    let key = KEY, time = 1_000_000;
    const {voice} = voiceFor(server, {getKey: () => key, clock: () => time});
    await assert.rejects(voice.synthesizeStream('judy-alvarez', 'One.', collect()), {kind: 'key'});
    assert.equal(voice.ready, false);
    key = OTHER_KEY; time += 2000;
    assert.equal(voice.ready, true, 'a key nobody has refused is ready');
    refuse = false;
    const sink = collect();
    await voice.synthesizeStream('judy-alvarez', 'Two.', sink);
    assert.equal(sink.packets.length, 1);
  } finally { await server.close(); }
});

test('a 401 that comes back for the old key after the player saved another one does not pause the new key', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const server = await serve(async (request, response) => {
    if (request.headers.authorization === `Bearer ${KEY}`) { await gate; response.writeHead(401, {'content-type': 'application/json'}); response.end('{"message":"Unauthorized"}'); return; }
    sse(response); response.end(delta(bytesOf(samples(2400))) + done);
  });
  try {
    let key = KEY;
    const {voice} = voiceFor(server, {getKey: () => key, clock: () => 1_000_000});
    const pending = voice.synthesizeStream('judy-alvarez', 'One.', collect()).catch(caught => caught);
    await until(() => server.requests.length >= 1, 'the first request to reach the server');
    key = OTHER_KEY;
    assert.equal(voice.ready, true, 'the new key is seen while the old request is still out');
    release();
    assert.equal((await pending).kind, 'key');
    assert.equal(voice.ready, true, 'a refusal of the old key does not pause the new key');
  } finally { release?.(); await server.close(); }
});
