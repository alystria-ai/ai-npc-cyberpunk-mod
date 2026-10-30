// The prepared voice of a scripted quest line (bridge/prepared-voice.mjs, docs/QUEST_PRIMITIVES.md section 4): a pack's WAV file as the PCM packets every voice produces.
// Offline: a fake sink for the packet contract, and for the delivery the real deliverPocketSpeech + LocalPcmHost + an offline renderer + the continuous-speech lease.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {createPreparedVoice, decodePreparedWav, readPreparedFile, PREPARED_MAX_SECONDS, PREPARED_RATE} from './prepared-voice.mjs';
import {PACKET_FRAMES, OMNI_RATE} from './omni-pcm.mjs';
import {encodePcmWav} from './convai-audio-stream.mjs';
import {deliverPocketSpeech} from './pocket-speech.mjs';
import {LocalPcmClient} from './local-pcm-client.mjs';
import {LocalPcmHost} from './local-pcm-host.mjs';
import {ConvaiContinuousSpeech} from './convai-continuous-speech.mjs';
import {ownedPocketFace} from './pocket-facial-stream.mjs';

const tone = (seconds, hertz = 220, rate = OMNI_RATE) => Float32Array.from({length: Math.round(seconds * rate)}, (_, at) => .3 * Math.sin(2 * Math.PI * hertz * at / rate));
// A 16-bit PCM WAV of any rate and channel count (the encoder of the repo writes mono only).
function wavOf(samples, {rate = OMNI_RATE, channels = 1} = {}) {
  const frames = samples.length, bytes = Buffer.alloc(44 + frames * channels * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(frames * channels * 2, 40);
  for (let at = 0; at < frames; at++) for (let channel = 0; channel < channels; channel++) bytes.writeInt16LE(Math.round(samples[at] * 32767), 44 + (at * channels + channel) * 2);
  return bytes;
}
const voiceOf = bytes => createPreparedVoice({load: async () => bytes});

test('a prepared WAV is numbered from 1, offset by frame, at most 2 s a packet, one owner, and carries the file exactly in order', async () => {
  const source = tone(5.5, 200);
  const voice = voiceOf(wavOf(source));
  const packets = [], utterance = {decided: [], decide(name) { this.decided.push(name); }}, progress = {emitted: 0, heard: 0};
  const response = await voice.synthesizeStream('panam-palmer', 'Hey V.', {onPcm: packet => packets.push(packet), utterance, role: 'head', progress});
  assert.deepEqual(utterance.decided, ['pocket'], 'a prepared line is no cloud voice');
  assert.equal(packets.length, 3);
  let frames = 0;
  packets.forEach((packet, at) => {
    assert.equal(packet.index, at + 1); assert.equal(packet.offsetFrames, frames);
    assert.ok(packet.frames <= PACKET_FRAMES && packet.frames === packet.pcm.length && packet.frames > 0);
    assert.equal(packet.version, 1); assert.equal(packet.engine, 'pocket-tts'); assert.equal(packet.sampleRate, 24000);
    assert.equal(packet.channels, 1); assert.equal(packet.format, 'f32le'); assert.equal(packet.profile, 'panam-palmer');
    assert.equal(packet.owner, packets[0].owner); assert.equal(packet.id, packets[0].id);
    assert.match(packet.owner, /^[a-f0-9]{32}$/); assert.match(packet.modelSha256, /^[a-f0-9]{64}$/);
    assert.ok(Math.abs(packet.startSeconds - frames / 24000) < 1e-9);
    frames += packet.frames;
  });
  assert.deepEqual(response, {frames, chunks: 3, duration: frames / 24000, truncated: false, timing: {voiceProvider: 'prepared', voiceEngine: 'prepared'}});
  assert.equal(progress.emitted, response.duration);
  const heard = Float32Array.from(packets.flatMap(packet => [...packet.pcm]));
  assert.equal(heard.length, source.length);
  for (let at = 0; at < heard.length; at += 997) assert.ok(Math.abs(heard[at] - source[at]) < 1 / 16000, `sample ${at}`);
});

test('another sample rate and stereo are converted to 24 kHz mono, and the length in seconds is kept', async () => {
  const mono = tone(1, 300, 44100);
  const packets = [];
  await voiceOf(wavOf(mono, {rate: 44100, channels: 2})).synthesizeStream('judy-alvarez', 'x', {onPcm: packet => packets.push(packet)});
  const frames = packets.reduce((sum, packet) => sum + packet.frames, 0);
  assert.equal(frames, 24000);
  assert.equal(packets[0].sampleRate, 24000);
  // A file already decoded (the bridge reads it once, before the speech lease) is played as it is.
  const decoded = decodePreparedWav(wavOf(tone(.5)));
  const again = [];
  await createPreparedVoice({load: async () => decoded}).synthesizeStream('judy-alvarez', 'x', {onPcm: packet => again.push(packet)});
  assert.equal(again.reduce((sum, packet) => sum + packet.frames, 0), 12000);
});

test('a file that is not usable throws a plain Error: empty, not a WAV, too long, a loader that fails; nothing is sent', async () => {
  const sunk = [], onPcm = packet => sunk.push(packet);
  const refused = async (bytes, pattern) => {
    await assert.rejects(voiceOf(bytes).synthesizeStream('judy-alvarez', 'x', {onPcm}), error => error instanceof Error && error.name === 'Error' && pattern.test(error.message));
  };
  await refused(Buffer.alloc(0), /empty/);
  await refused(Buffer.from('this is an ogg or a text file, not a wav at all, not even close to it'), /PCM WAV/);
  await refused(wavOf(tone(PREPARED_MAX_SECONDS + 1)), /longer than 60 seconds/);
  await assert.rejects(createPreparedVoice({load: async () => { throw Error('gone'); }}).synthesizeStream('judy-alvarez', 'x', {onPcm}), /gone/);
  await assert.rejects(createPreparedVoice({load: async () => { throw 'not an error object'; }}).synthesizeStream('judy-alvarez', 'x', {onPcm}), /cannot be read/);
  assert.deepEqual(sunk, []);
  // Exactly 60 s is the longest that plays.
  const packets = [];
  await voiceOf(wavOf(tone(PREPARED_MAX_SECONDS))).synthesizeStream('judy-alvarez', 'x', {onPcm: packet => packets.push(packet)});
  assert.equal(packets.reduce((sum, packet) => sum + packet.frames, 0), PREPARED_MAX_SECONDS * PREPARED_RATE);
  await assert.rejects(voiceOf(wavOf(tone(1))).synthesizeStream('judy-alvarez', 'x', {}), /PCM sink/);
  assert.throws(() => createPreparedVoice({}), /loader/);
  assert.throws(() => createPreparedVoice({load: async () => null, rate: 48000}), /24000/);
});

test('cancelling stops the packets at once, and a signal that is already aborted sends nothing and does not load the file', async () => {
  const controller = new AbortController(), packets = [];
  let loads = 0;
  const voice = createPreparedVoice({load: async () => { loads++; return wavOf(tone(7)); }});
  await assert.rejects(voice.synthesizeStream('panam-palmer', 'x', {signal: controller.signal, onPcm: packet => { packets.push(packet); controller.abort(); }}), error => error.name === 'AbortError' || /cancel/i.test(error.message));
  assert.equal(packets.length, 1, 'no packet after the abort');
  const sent = [];
  controller.abort();
  const before = loads;
  await assert.rejects(voice.synthesizeStream('panam-palmer', 'x', {signal: controller.signal, onPcm: packet => sent.push(packet)}));
  assert.deepEqual(sent, []); assert.equal(loads, before);
});

test('the file of a line is read from disk: a regular WAV is read, a missing path, a folder and no path are plain errors', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'prepared-voice-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const file = join(dir, 'P1.walk.01.wav');
  await writeFile(file, wavOf(tone(1)));
  const bytes = await readPreparedFile(file);
  assert.equal(decodePreparedWav(bytes).length, 24000);
  await assert.rejects(readPreparedFile(join(dir, 'nothing.wav')), /cannot be read/);
  await mkdir(join(dir, 'folder'));
  await assert.rejects(readPreparedFile(join(dir, 'folder')), /not a file/);
  await assert.rejects(readPreparedFile(''), /needs an audio file/);
  await assert.rejects(readPreparedFile(undefined), /needs an audio file/);
});

// ---- The whole delivery: deliverPocketSpeech + real host + offline renderer + lease ----

class OfflinePlayer {
  constructor() { this.frames = 0; this.chunks = []; this.state = 'awaiting-admission'; this.ended = false; this.error = null; this.controls = []; }
  async open(value) { this.token = value.token; }
  append(bytes, offset) { assert.equal(offset, this.frames); this.chunks.push(Buffer.from(bytes)); this.frames += bytes.length / 2; return Promise.resolve(); }
  snapshot() {
    if (this.state === 'playing') { this.heard = Math.min(this.frames, (this.heard ?? 0) + 2400); if (this.sealed && this.heard >= this.frames) { this.ended = true; this.state = 'ended'; } }
    return {state: this.state, sampleRate: 24000, channels: 1, receivedFrames: this.frames, playedFrames: this.heard ?? 0,
      positionSeconds: (this.heard ?? 0) / 24000, bufferedFrames: this.frames - (this.heard ?? 0), ended: this.ended, error: this.error, underruns: 0};
  }
  control(value) { this.controls.push({...value}); if (value.allow && this.state !== 'ended') this.state = 'playing'; }
  async end(frames) { assert.equal(frames, this.frames); this.sealed = true; }
  finish() { this.ended = true; this.state = 'ended'; }
  async stop() { this.stopped = true; }
}

test('a prepared line is played by the continuous renderer: admission at the first audio, the exact samples, the game lease, a delivery receipt, no live voice', async t => {
  const input = {requestId: 'prepared-line-1', entity: '17ULL', generation: 2, profileKey: 'panam-palmer', source: 'typed'};
  const profile = {key: input.profileKey}, text = 'You actually came. Here. It is terrible, drink it anyway.';
  const players = [], documents = [], replies = [];
  let sequence = 0;
  const host = new LocalPcmHost({pollMs: 5, timeoutMs: 20000, cleanupTimeoutMs: 5000, createPage: async () => {
    const client = new LocalPcmClient({createPlayer: () => { const player = new OfflinePlayer(); players.push(player); return player; }});
    return {closed: false, window: {localPcm: client}, isClosed() { return this.closed; },
      async close() { this.closed = true; },
      async evaluate(fn, payload) { return runInNewContext(`(${fn.toString()})(payload)`, {window: this.window, payload}); }};
  }});
  t.after(() => host.close());
  const current = async () => true; current.sync = () => true;
  const speech = new ConvaiContinuousSpeech({input, profile, current, token: 'prepared-line-token', faceBuilder: ownedPocketFace,
    writeState: async value => { documents.push(value); return true; }, writeReply: async value => { replies.push(value); return true; },
    readControl: async () => JSON.stringify({version: 1, id: 'prepared-line-token', requestId: input.requestId, entity: input.entity,
      generation: input.generation, sequence: ++sequence, updated: Date.now(), allow: true, paused: false, volume: .8, pan: .1, distance: 2}),
    onGenerated: async () => {}});
  const source = tone(3.2, 180);
  const voice = voiceOf(wavOf(source));
  const reply = await deliverPocketSpeech({input, profile, result: {text, model: 'scripted', finishReason: 'stop', transport: 'local', timing: {}}, current, signal: undefined,
    voice, host: {playLocalPcm: (...args) => host.play(...args)}, speech});
  assert.equal(reply.continuous, true); assert.equal(reply.audio, undefined);
  assert.equal(reply.liveDelivery.published, true); assert.equal(reply.liveDelivery.ended, true);
  assert.equal(reply.timing.voiceProvider, 'prepared');
  assert.equal(reply.text, text);
  assert.equal(replies.length, 1, 'the line is admitted once, at the first audio');
  assert.equal(documents.at(-1).complete, true);
  const player = players[0];
  assert.ok(player.controls.some(control => control.allow === true && control.volume === .8 && control.pan === .1), 'the game lease reaches the renderer');
  assert.equal(player.frames, source.length, 'every sample of the file reached the renderer, and only those');
  assert.equal(player.sealed, true);
});

test('a prepared line that cannot be played before its first sample does not fail the turn: the delivery answers the written line', async t => {
  const input = {requestId: 'prepared-line-2', entity: '18ULL', generation: 3, profileKey: 'panam-palmer', source: 'typed'};
  const profile = {key: input.profileKey};
  const host = new LocalPcmHost({pollMs: 5, timeoutMs: 20000, cleanupTimeoutMs: 5000, createPage: async () => {
    const client = new LocalPcmClient({createPlayer: () => new OfflinePlayer()});
    return {closed: false, window: {localPcm: client}, isClosed() { return this.closed; }, async close() { this.closed = true; },
      async evaluate(fn, payload) { return runInNewContext(`(${fn.toString()})(payload)`, {window: this.window, payload}); }};
  }});
  t.after(() => host.close());
  const current = async () => true; current.sync = () => true;
  const speech = new ConvaiContinuousSpeech({input, profile, current, token: 'prepared-line-token-2', faceBuilder: ownedPocketFace,
    writeState: async () => true, writeReply: async () => true, readControl: async () => '{}', onGenerated: async () => {}});
  const reply = await deliverPocketSpeech({input, profile, result: {text: 'Written only.', model: 'scripted', timing: {}}, current, signal: undefined,
    voice: createPreparedVoice({load: async () => Buffer.from('not a wav')}), host: {playLocalPcm: (...args) => host.play(...args)}, speech});
  assert.equal(reply.text, 'Written only.');
  assert.equal(reply.audio, undefined); assert.deepEqual(reply.faces, []);
  assert.ok(!reply.continuous);
});

test('a decoder option turns any file (an Ogg, say) into the samples that are sent, and its failure is a plain Error with nothing sent', async () => {
  const asked = [], packets = [];
  const voice = createPreparedVoice({load: async () => Buffer.from('OggS fake file'), decode: async (bytes, options) => { asked.push([bytes.toString(), options]); return tone(.5); }});
  await voice.synthesizeStream('judy-alvarez', 'x', {onPcm: packet => packets.push(packet)});
  assert.deepEqual(asked, [['OggS fake file', {maxSeconds: PREPARED_MAX_SECONDS}]]);
  assert.equal(packets.reduce((sum, packet) => sum + packet.frames, 0), 12000);
  assert.equal(packets[0].sampleRate, 24000);
  const sunk = [], onPcm = packet => sunk.push(packet);
  const failing = createPreparedVoice({load: async () => Buffer.from('x'), decode: async () => { throw Error('needs ffmpeg'); }});
  await assert.rejects(failing.synthesizeStream('judy-alvarez', 'x', {onPcm}), /needs ffmpeg/);
  await assert.rejects(createPreparedVoice({load: async () => Buffer.from('x'), decode: async () => { throw 'odd'; }}).synthesizeStream('judy-alvarez', 'x', {onPcm}), /cannot be decoded/);
  await assert.rejects(createPreparedVoice({load: async () => Buffer.from('x'), decode: async () => tone(PREPARED_MAX_SECONDS + 1)}).synthesizeStream('judy-alvarez', 'x', {onPcm}), /longer than 60 seconds/);
  await assert.rejects(createPreparedVoice({load: async () => Buffer.from('x'), decode: async () => new Float32Array(0)}).synthesizeStream('judy-alvarez', 'x', {onPcm}), /empty/);
  assert.deepEqual(sunk, []);
  assert.throws(() => createPreparedVoice({load: async () => null, decode: 'ffmpeg'}), /decoder must be a function/);
  // Samples already decoded skip the decoder; a cancelled signal stops before the decoder is asked.
  let calls = 0;
  const skip = createPreparedVoice({load: async () => tone(.1), decode: async () => { calls++; return tone(.1); }});
  await skip.synthesizeStream('judy-alvarez', 'x', {onPcm: () => {}});
  assert.equal(calls, 0);
});
