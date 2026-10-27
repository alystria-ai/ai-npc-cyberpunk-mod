// OmniVoice on the mod's own audio path (bridge/omni-pcm.mjs, docs/OMNIVOICE_PCM.md): phrases rendered by the resident worker reach the
// renderer as PCM packets, with no Audioware slot, manifest or file. Every test here runs offline: a fake worker that returns WAVs, and for the
// delivery test the real LocalPcmHost + LocalPcmClient with an offline player and the real continuous-speech lease logic.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createOmniPcmVoice, wavToPcm, PACKET_FRAMES, OMNI_RATE} from './omni-pcm.mjs';
import {splitSpeechText} from './speech-phrases.mjs';
import {encodePcmWav} from './convai-audio-stream.mjs';
import {deliverPocketSpeech} from './pocket-speech.mjs';
import {LocalPcmClient} from './local-pcm-client.mjs';
import {LocalPcmHost} from './local-pcm-host.mjs';
import {ConvaiContinuousSpeech} from './convai-continuous-speech.mjs';
import {ownedPocketFace} from './pocket-facial-stream.mjs';
import {BufferedPcm} from './group-lookahead.mjs';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const tone = (seconds, hertz = 220, rate = OMNI_RATE) => Float32Array.from({length: Math.round(seconds * rate)}, (_, at) => .3 * Math.sin(2 * Math.PI * hertz * at / rate));
const wavOf = (pcm, rate = OMNI_RATE) => encodePcmWav(pcm, rate);
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return {promise, resolve, reject}; };

// A resident worker that answers each phrase with its own tone, after the test lets it.
function fakeWorker({seconds = () => 1, fail = () => false, delay = () => null} = {}) {
  const calls = [];
  const synthesize = async (profile, text, options) => {
    const call = {profile, text, options, index: calls.length}; calls.push(call);
    const gate = delay(call); if (gate) await gate;
    if (options.signal?.aborted) throw Object.assign(Error('cancelled'), {name: 'AbortError'});
    if (fail(call)) throw Error('worker refused');
    return {audio: wavOf(tone(seconds(call), 200 + 40 * call.index)), timing: {voiceProvider: 'omnivoice', voiceSteps: options.steps, voiceGenerationMs: 5}};
  };
  return {calls, synthesize};
}
const LONG = Array.from({length: 14}, (_, n) => 'This is sentence number ' + n + ' of a long reply that keeps going for a while, with a few more words to fill the phrase.').join(' ');
const REPLY = 'Hey V, I have been thinking about what happened last night and none of it adds up. We could head down to the market together, pick up some food and talk about the next move before anyone notices. Do not tell anybody else about this.';

test('a phrase WAV becomes mono 24 kHz float samples without any other change, and other rates are converted', () => {
  const pcm = Float32Array.from({length: 2400}, (_, at) => [-.5, -.25, 0, .25, .5, .75, 0, -.75][at % 8]);
  const out = wavToPcm(wavOf(pcm));
  assert.equal(out.length, pcm.length);
  pcm.forEach((value, at) => assert.ok(Math.abs(out[at] - value) < 1 / 32000, `sample ${at}`));
  const slow = wavToPcm(wavOf(tone(1, 220, 48000), 48000));
  assert.equal(slow.length, OMNI_RATE);
  assert.throws(() => wavToPcm('AAAA'), /WAV/);
});

test('packets are numbered from 1, offset by frame, at most 2 s each, one owner, and carry the phrase audio exactly in order', async () => {
  const worker = fakeWorker({seconds: call => call.index === 0 ? 5 : 1.5});
  const voice = createOmniPcmVoice({synthesize: worker.synthesize, steps: () => 16});
  const packets = [], utterance = {decided: [], decide(name) { this.decided.push(name); }};
  const response = await voice.synthesizeStream('judy-alvarez', REPLY, {onPcm: packet => packets.push(packet), utterance, role: 'head', language: 'de'});
  assert.ok(worker.calls.length >= 2, 'the reply is rendered in several phrases');
  assert.deepEqual(utterance.decided, ['pocket'], 'OmniVoice is a local voice, never a cloud engine');
  assert.ok(worker.calls.every(call => call.options.steps === 16 && call.options.language === 'de' && call.profile === 'judy-alvarez'));
  let frames = 0;
  packets.forEach((packet, at) => {
    assert.equal(packet.index, at + 1); assert.equal(packet.offsetFrames, frames);
    assert.ok(packet.frames <= PACKET_FRAMES && packet.frames === packet.pcm.length && packet.frames > 0);
    assert.equal(packet.engine, 'pocket-tts'); assert.equal(packet.sampleRate, 24000); assert.equal(packet.channels, 1); assert.equal(packet.format, 'f32le');
    assert.equal(packet.owner, packets[0].owner); assert.equal(packet.id, packets[0].id);
    assert.match(packet.owner, /^[a-f0-9]{32}$/); assert.match(packet.modelSha256, /^[a-f0-9]{64}$/);
    frames += packet.frames;
  });
  assert.equal(response.frames, frames); assert.equal(response.chunks, packets.length); assert.equal(response.truncated, false);
  assert.equal(response.timing.voiceProvider, 'omni');
  // Sample identity: the phrase WAVs, concatenated, are what the renderer is given (a 16-bit file is exact to its own resolution).
  const expected = [];
  for (let at = 0; at < worker.calls.length; at++) expected.push(...tone(at === 0 ? 5 : 1.5, 200 + 40 * at));
  const heard = Float32Array.from(packets.flatMap(packet => [...packet.pcm]));
  assert.equal(heard.length, expected.length);
  for (let at = 0; at < heard.length; at += 997) assert.ok(Math.abs(heard[at] - expected[at]) < 1 / 16000);
});

test('the next phrase is queued behind the first at once, and not further than two ahead of what has been sent', async () => {
  const gates = [deferred(), deferred(), deferred(), deferred(), deferred(), deferred()];
  const worker = fakeWorker({delay: call => gates[call.index]?.promise});
  const voice = createOmniPcmVoice({synthesize: worker.synthesize});
  const sent = [];
  const running = voice.synthesizeStream('judy', REPLY, {onPcm: packet => sent.push(packet)});
  running.catch(() => {});
  await sleep(10);
  assert.equal(worker.calls.length, 2, 'phrase 1 and phrase 2 are queued on the worker, nothing more');
  gates[0].resolve(); await sleep(15);
  assert.ok(sent.length > 0, 'the first phrase is on its way as soon as it is rendered');
  assert.equal(worker.calls.length, 3, 'one more is queued as the first is sent');
  gates.forEach(gate => gate.resolve());
  await running;
});

test('a reply stays a bounded lead ahead of what has been heard: a paused game does not render a long reply to its end', async () => {
  const worker = fakeWorker({seconds: () => 8});
  const progress = {emitted: 0, heard: 0};
  const voice = createOmniPcmVoice({synthesize: worker.synthesize, maxLeadSeconds: 14, pollMs: 5});
  const running = voice.synthesizeStream('judy', LONG, {onPcm: () => {}, progress});
  await sleep(60);
  const early = worker.calls.length;
  assert.ok(early <= 3, `rendering stopped at ${early} phrases while nothing is heard`);
  const release = setInterval(() => { progress.heard = progress.emitted; }, 5);
  await running; clearInterval(release);
  assert.ok(worker.calls.length > early, 'rendering went on once the audio was heard');
});

test('a first phrase that fails is an error; a later one ends the reply there and keeps what was sent', async () => {
  const none = createOmniPcmVoice({synthesize: fakeWorker({fail: () => true}).synthesize});
  await assert.rejects(none.synthesizeStream('judy', REPLY, {onPcm: () => {}}), /worker refused/);
  const part = createOmniPcmVoice({synthesize: fakeWorker({fail: call => call.index === 1}).synthesize});
  const packets = [];
  const response = await part.synthesizeStream('judy', REPLY, {onPcm: packet => packets.push(packet)});
  assert.equal(response.truncated, true); assert.equal(response.timing.voiceTailFailed, true);
  assert.equal(response.frames, packets.reduce((total, packet) => total + packet.frames, 0));
});

test('with retries (the AMD route) a phrase whose render failed is asked for again, first or later; without them nothing changes', async () => {
  const phrases = splitSpeechText(REPLY), SECOND = phrases[1], seen = [];
  assert.ok(phrases.length >= 3);
  const failFirstTry = pick => { const tries = new Map(); return fakeWorker({fail: call => { const n = (tries.get(call.text) ?? 0) + 1; tries.set(call.text, n); return pick(call) && n === 1; }}); };
  const timesAsked = (worker, text) => worker.calls.filter(call => call.text === text).length;
  // The second phrase fails on its first try only (a stray PyTorch error; the worker keeps running).
  const worker = failFirstTry(call => call.text === SECOND);
  const voice = createOmniPcmVoice({synthesize: worker.synthesize, retries: () => 1, onRetry: info => seen.push(info.index)});
  const response = await voice.synthesizeStream('judy', REPLY, {onPcm: () => {}});
  assert.equal(response.truncated, false, 'the reply is not cut off'); assert.deepEqual(seen, [1]); assert.equal(timesAsked(worker, SECOND), 2);
  assert.equal(response.timing.voicePhrases, phrases.length);
  // The first phrase too.
  const first = failFirstTry(call => call.index === 0);
  assert.equal((await createOmniPcmVoice({synthesize: first.synthesize, retries: () => 1}).synthesizeStream('judy', REPLY, {onPcm: () => {}})).truncated, false);
  // A phrase that keeps failing ends the reply after the allowed tries.
  const stubborn = fakeWorker({fail: call => call.text === SECOND});
  assert.equal((await createOmniPcmVoice({synthesize: stubborn.synthesize, retries: () => 1}).synthesizeStream('judy', REPLY, {onPcm: () => {}})).truncated, true);
  assert.equal(timesAsked(stubborn, SECOND), 2);
  // Default: no retry (NVIDIA and everything else).
  const plain = fakeWorker({fail: call => call.text === SECOND});
  assert.equal((await createOmniPcmVoice({synthesize: plain.synthesize}).synthesizeStream('judy', REPLY, {onPcm: () => {}})).truncated, true);
  assert.equal(timesAsked(plain, SECOND), 1);
  // A retries() that throws or answers nonsense means none; the budget is capped at two.
  for (const bad of [() => { throw Error('x'); }, () => 'many', () => -3]) {
    const w = fakeWorker({fail: call => call.text === SECOND});
    assert.equal((await createOmniPcmVoice({synthesize: w.synthesize, retries: bad}).synthesizeStream('judy', REPLY, {onPcm: () => {}})).truncated, true);
    assert.equal(timesAsked(w, SECOND), 1);
  }
  const capped = fakeWorker({fail: call => call.text === SECOND});
  await createOmniPcmVoice({synthesize: capped.synthesize, retries: () => 9}).synthesizeStream('judy', REPLY, {onPcm: () => {}});
  assert.equal(timesAsked(capped, SECOND), 3);
});

test('a cancelled reply is never retried', async () => {
  const controller = new AbortController(), gate = deferred();
  const worker = fakeWorker({delay: call => call.index === 0 ? gate.promise : null});
  const voice = createOmniPcmVoice({synthesize: worker.synthesize, retries: () => 2});
  const running = voice.synthesizeStream('judy', REPLY, {signal: controller.signal, onPcm: () => {}}); running.catch(() => {});
  await sleep(10);
  controller.abort(Object.assign(Error('cancelled'), {name: 'AbortError'}));
  gate.resolve();
  await assert.rejects(running);
  assert.equal(worker.calls.length, 2, 'the two phrases queued at the start; the cancelled one was not asked for again');
});

test('cancelling stops the queued phrases and sends nothing more', async () => {
  const gate = deferred();
  const worker = fakeWorker({delay: call => call.index === 0 ? gate.promise : null});
  const controller = new AbortController(), sent = [];
  const voice = createOmniPcmVoice({synthesize: worker.synthesize});
  const running = voice.synthesizeStream('judy', REPLY, {signal: controller.signal, onPcm: packet => sent.push(packet)});
  running.catch(() => {});
  await sleep(10);
  controller.abort(Object.assign(Error('cancelled'), {name: 'AbortError'}));
  gate.resolve();
  await assert.rejects(running);
  assert.equal(sent.length, 0);
  assert.ok(worker.calls.every(call => call.options.signal.aborted), 'every queued job was told to stop');
});

test('voice tags reach OmniVoice only through voicedPhrases, and a wrong answer falls back to the plain phrases', async () => {
  const worker = fakeWorker();
  const tagged = createOmniPcmVoice({synthesize: worker.synthesize, voicedPhrases: (phrases, {role}) => phrases.map(phrase => `[${role}] ${phrase}`)});
  await tagged.synthesizeStream('judy', REPLY, {role: 'tail', onPcm: () => {}});
  assert.ok(worker.calls.every(call => call.text.startsWith('[tail] ')));
  const wrong = fakeWorker();
  const plain = createOmniPcmVoice({synthesize: wrong.synthesize, voicedPhrases: () => ['only one']});
  await plain.synthesizeStream('judy', REPLY, {onPcm: () => {}});
  assert.ok(wrong.calls.every(call => !call.text.includes('only one')));
});

test('a look-ahead (held) OmniVoice reply is buffered as PCM and drained in order into the speaker that claims it', async () => {
  const worker = fakeWorker({seconds: () => 2.5});
  const voice = createOmniPcmVoice({synthesize: worker.synthesize});
  const buffered = new BufferedPcm({synthesize: (onPcm, options) => voice.synthesizeStream('judy', REPLY, {...options, onPcm, ahead: true})});
  await buffered.start();
  const drained = [];
  await buffered.drain(packet => { drained.push(packet.index); });
  assert.deepEqual(drained, drained.map((_, at) => at + 1));
  assert.ok(drained.length >= 3);
});

// ---- The whole delivery: deliverPocketSpeech + real host + offline renderer + lease ----

class OfflinePlayer {
  constructor() { this.frames = 0; this.chunks = []; this.state = 'awaiting-admission'; this.ended = false; this.error = null; this.controls = []; }
  async open(value) { this.token = value.token; }
  append(bytes, offset) { assert.equal(offset, this.frames); this.chunks.push(Buffer.from(bytes)); this.frames += bytes.length / 2; return Promise.resolve(); }
  // A device that plays at once what the game allows: every poll of its clock is 100 ms more of what was received.
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

test('an OmniVoice reply is played by the continuous renderer: admission, exact samples, a delivery receipt, and nothing is written for Audioware', async t => {
  const input = {requestId: 'omni-own-path', entity: '17ULL', generation: 2, profileKey: 'judy-alvarez', source: 'typed'};
  const profile = {key: input.profileKey}, result = {text: REPLY, sessionID: 'one-session', timing: {}};
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
  const speech = new ConvaiContinuousSpeech({input, profile, current, token: 'omni-own-path-token', faceBuilder: ownedPocketFace,
    writeState: async value => { documents.push(value); return true; }, writeReply: async value => { replies.push(value); return true; },
    readControl: async () => JSON.stringify({version: 1, id: 'omni-own-path-token', requestId: input.requestId, entity: input.entity,
      generation: input.generation, sequence: ++sequence, updated: Date.now(), allow: true, paused: false, volume: .9, pan: -.2, distance: 3}),
    onGenerated: async () => {}});
  const worker = fakeWorker({seconds: () => 1.2});
  const voice = createOmniPcmVoice({synthesize: worker.synthesize});
  const reply = await deliverPocketSpeech({input, profile, result, current, signal: undefined, voice, host: {playLocalPcm: (...args) => host.play(...args)}, speech});
  assert.equal(reply.continuous, true); assert.equal(reply.audio, undefined);
  assert.equal(reply.liveDelivery.published, true); assert.equal(reply.liveDelivery.ended, true);
  assert.equal(reply.timing.voiceProvider, 'omni');
  assert.equal(replies.length, 1, 'the reply is admitted once, at the first audio');
  assert.equal(documents.at(-1).complete, true);
  const player = players[0];
  assert.ok(player.controls.some(control => control.allow === true && control.volume === .9 && control.pan === -.2), 'the game lease reaches the renderer');
  assert.ok(player.frames >= worker.calls.length * 28000, 'every phrase reached the renderer');
  assert.equal(player.sealed, true);
});

test('the bridge no longer writes an Audioware depot, slots or a stream manifest, and a Convai reply without continuous playback is written text', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!/SpeechSlots|SpeechStream|prepareSpeech|initializeAudioDepot|speech-stream\.json|storeSpeech/.test(bridge));
  assert.match(bridge, /removeAudioDepot\(game\)/, 'what older versions left in r6/audioware is cleared');
  // The complete-WAV Convai route is gone: with no continuous adapter the turn asks for no audio at all and says why.
  const fallback = bridge.slice(bridge.indexOf('async function convaiReply'), bridge.indexOf('async function respondStreamed'));
  assert.match(fallback, /state\.continuousAvailable !== true\)[\s\S]*?ttsEnabled: false[\s\S]*?audioError: 'Local streaming is unavailable/);
  assert.match(bridge, /\['pocket', 'omni'\]\.includes\(turnVoice\(input\)\.engine\)/, 'the renderer page is warmed for OmniVoice too');
  assert.match(bridge, /voice: engineVoice/, 'OmniVoice is delivered by the same function as Pocket');
});
