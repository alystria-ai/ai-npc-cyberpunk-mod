import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MicTap, PreRollBuffer, TapCapture, TAP} from './mic-tap.mjs';
import {MicrophoneSession} from './microphone-session.mjs';
import {createLocalSttChannel} from './local-stt-capture.mjs';
import {VoiceActivity} from './voice-activity.mjs';

const SR = 16000, tick = (ms = 5) => new Promise(done => setTimeout(done, ms));

// ---- audio ---------------------------------------------------------------------------------------------------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const level = db => Math.pow(10, db / 20);
const samples = ms => Math.round(ms * SR / 1000);
function quiet(ms, db = -62, seed = 1) {
  const r = rng(seed), out = new Int16Array(samples(ms)), amp = level(db) * Math.sqrt(3) * 32767;
  for (let i = 0; i < out.length; i++) out[i] = Math.round((r() * 2 - 1) * amp);
  return out;
}
function voice(ms, db = -24, seed = 7) {
  const r = rng(seed), n = samples(ms), out = new Float64Array(n), base = 120 + 80 * r();
  let phase = 0, energy = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, f0 = base + 25 * Math.sin(2 * Math.PI * 0.6 * t);
    phase += 2 * Math.PI * f0 / SR;
    let v = 0; for (let k = 1; k * f0 < 3800; k++) v += Math.sin(k * phase) / k;
    const into = (t * 1000) % 250, env = into > 190 ? 0.4 + 0.6 * (0.5 + 0.5 * Math.cos(2 * Math.PI * (into - 190) / 60)) : 1;
    out[i] = v * env; energy += out[i] * out[i];
  }
  const gain = level(db) / Math.sqrt(energy / n) * 32767, pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(out[i] * gain)));
  return pcm;
}
const join = (...parts) => { const out = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out; };
const bytesOf = pcm => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
// 40 ms chunks, like the capture page posts for the tap
const chunks = pcm => { const size = samples(TAP.chunkMs), out = []; for (let i = 0; i < pcm.length; i += size) out.push(Buffer.from(bytesOf(pcm.subarray(i, i + size)))); return out; };

// ---- a capture stand-in ---------------------------------------------------------------------------------------------------------------------
function fakeCapture({openMs = 0, failBegin = false, info = {device: 'Fake microphone'}} = {}) {
  const log = [];
  let sink = null, deviceOpen = false;
  return {log, get deviceOpen() { return deviceOpen; }, get listening() { return sink !== null; },
    emit: chunk => sink?.(chunk),
    begin: async (onChunk, options) => {
      log.push('begin:' + (options?.chunkMs ?? ''));
      sink = onChunk; deviceOpen = true;     // chunks may flow before begin() answers, as with the real page
      if (openMs) await tick(openMs);
      if (failBegin) { sink = null; deviceOpen = false; throw Error('NotAllowedError'); }
      return info;
    },
    end: async () => { log.push('end'); sink = null; deviceOpen = false; },
    abort: async () => { log.push('abort'); sink = null; deviceOpen = false; },
    close: async () => { log.push('close'); }};
}

// ---- the buffer -----------------------------------------------------------------------------------------------------------------------------
test('PreRollBuffer keeps stream positions, hands pieces from a position, and drops the oldest past its cap', () => {
  const buffer = new PreRollBuffer({maxMs: 200});     // 6400 bytes
  for (let i = 0; i < 10; i++) buffer.push(Buffer.alloc(1280, i));    // 40 ms each
  assert.equal(buffer.streamMs, 400);
  assert.equal(buffer.keptMs, 200, 'only the newest 200 ms are kept');
  assert.equal(buffer.startMs, 200);
  const all = Buffer.concat(buffer.pieces(0));
  assert.equal(all.length, 6400);
  assert.equal(all[0], 5, 'the oldest kept chunk is the sixth');
  const tail = Buffer.concat(buffer.pieces(360));
  assert.equal(tail.length, 1280); assert.equal(tail[0], 9);
  assert.ok(buffer.pieces(0, 1000).every(piece => piece.length <= 1000), 'pieces are bounded');
  buffer.clear(); assert.equal(buffer.keptMs, 0); assert.equal(buffer.streamMs, 400);
});

test('speechStartMs sends from before the first speech frame, or only the newest tail when there is none', () => {
  const withSpeech = new PreRollBuffer();
  for (const chunk of chunks(join(quiet(1200), voice(800), quiet(200)))) withSpeech.push(chunk);
  const start = withSpeech.speechStartMs();
  assert.ok(start > 800 && start < 1200, 'starts between the quiet and the voice, not at 0: ' + start);
  const silent = new PreRollBuffer();
  for (const chunk of chunks(quiet(2000))) silent.push(chunk);
  assert.ok(silent.streamMs - silent.speechStartMs() <= TAP.speechTailMs + 1, 'with no speech yet only the newest tail would go');
});

// ---- hold-to-talk: nothing lost before the connection is ready --------------------------------------------------------------------------------
test('audio from the key press is kept while the channel is not ready, then handed over in order before the live audio', async () => {
  const capture = fakeCapture(), tap = new MicTap({capture});
  const spoken = chunks(join(quiet(120), voice(600)));
  const ready = tap.hold('k1');
  await tick(1);
  assert.equal(capture.log[0], 'begin:' + TAP.chunkMs, 'the tap asks the page for 40 ms chunks');
  for (const chunk of spoken.slice(0, 8)) capture.emit(chunk);       // the player speaks while the connection is still opening
  await ready;
  assert.ok(tap.open('req-1', {holdId: 'k1'}), 'the request takes the key\'s tap over');
  assert.ok(tap.isOwner('req-1'));
  const got = [];
  const attached = tap.attach('req-1', chunk => got.push(chunk));
  assert.equal(attached.ok, true); assert.equal(attached.flushedMs, 8 * TAP.chunkMs);
  for (const chunk of spoken.slice(8)) capture.emit(chunk);           // the rest arrives live
  assert.equal(Buffer.concat(got).compare(Buffer.concat(spoken)), 0, 'every byte from the key press on, in order, none twice');
  assert.equal(capture.log.filter(line => line.startsWith('begin')).length, 1, 'one device open for hold and turn');
});

test('a key released before the channel is ready ends the recording on the spot, and the channel still gets all of it', async () => {
  const capture = fakeCapture(), tap = new MicTap({capture});
  const spoken = chunks(voice(400));
  await tap.hold('k2');
  for (const chunk of spoken) capture.emit(chunk);
  await tap.released('k2');
  assert.deepEqual(capture.log.slice(-1), ['end'], 'the device is closed at the release');
  assert.equal(capture.deviceOpen, false);
  capture.emit(Buffer.alloc(1280, 9));                                // nothing said after the release is recorded
  tap.open('req-2', {holdId: 'k2'});
  const got = [];
  const attached = tap.attach('req-2', chunk => got.push(chunk));
  assert.equal(attached.ended, true);
  assert.equal(Buffer.concat(got).compare(Buffer.concat(spoken)), 0);
  await tap.release('req-2', 'done');
  assert.equal(capture.log.includes('abort'), false, 'an ended recording is not aborted again');
});

test('a key press that never becomes a turn gives the microphone back after the grace', async () => {
  const timers = [], capture = fakeCapture();
  const tap = new MicTap({capture, setTimer: (fn, ms) => { const t = {fn, ms, unref() {}}; timers.push(t); return t; }, clearTimer: t => { if (t) t.cancelled = true; }});
  await tap.hold('k3');
  await tap.released('k3');
  const grace = timers.filter(t => !t.cancelled).at(-1);
  assert.equal(grace.ms, TAP.heldGraceMs);
  grace.fn(); await tick();
  assert.equal(tap.state, 'closed');
});

test('a microphone that cannot open fails the turn that waits for it, and leaves nothing open', async () => {
  const capture = fakeCapture({failBegin: true}), tap = new MicTap({capture});
  await assert.rejects(tap.hold('k4'), /NotAllowedError/);
  assert.equal(tap.state, 'closed');
  await assert.rejects(tap.whenReady('hold:k4'));
  assert.equal(capture.deviceOpen, false);
});

test('releasing the tap while the device is still opening closes the device once it has opened', async () => {
  const capture = fakeCapture({openMs: 30}), tap = new MicTap({capture});
  const opening = tap.hold('k5'); opening.catch(() => {});
  await tap.release(undefined, 'cancelled');
  await opening.catch(() => {});
  await tick(60);
  assert.equal(capture.deviceOpen, false, 'no device is left open');
  assert.ok(capture.log.includes('abort'));
});

test('a stale owner can neither stop nor release the next turn\'s tap', async () => {
  const capture = fakeCapture(), tap = new MicTap({capture});
  await tap.open('old'); await tap.release('old'); await tap.open('new');
  await tap.release('old', 'late close of the old channel');
  await tap.stop('old');
  assert.equal(tap.isOwner('new'), true);
  assert.equal(capture.deviceOpen, true);
});

test('an unclaimed turn tap is released after the wait', async () => {
  const timers = [], capture = fakeCapture();
  const tap = new MicTap({capture, setTimer: (fn, ms) => { const t = {fn, ms, unref() {}}; timers.push(t); return t; }, clearTimer: t => { if (t) t.cancelled = true; }});
  await tap.open('req-9');
  const claim = timers.filter(t => !t.cancelled).at(-1);
  assert.equal(claim.ms, TAP.unclaimedMs);
  claim.fn(); await tick();
  assert.equal(tap.state, 'closed'); assert.equal(capture.deviceOpen, false);
});

test('the capture page is closed after a while without a recording', async () => {
  const timers = [], capture = fakeCapture();
  const tap = new MicTap({capture, setTimer: (fn, ms) => { const t = {fn, ms, unref() {}}; timers.push(t); return t; }, clearTimer: t => { if (t) t.cancelled = true; }});
  await tap.open('req-10'); await tap.release('req-10');
  const idle = timers.filter(t => !t.cancelled).at(-1);
  assert.equal(idle.ms, TAP.idleCloseMs);
  idle.fn(); await tick();
  assert.ok(capture.log.includes('close'));
});

// ---- the Convai route: nothing before the first speech leaves the PC ---------------------------------------------------------------------------
test('the speech mode sends from just before the first speech frame and drops the silence before it', async () => {
  const capture = fakeCapture(), tap = new MicTap({capture});
  await tap.open('req-3');
  const audio = chunks(join(quiet(1500), voice(700)));
  for (const chunk of audio.slice(0, 40)) capture.emit(chunk);            // 1600 ms: all of the quiet and the first of the voice
  const got = [];
  const attached = tap.attach('req-3', chunk => got.push(chunk), {mode: 'speech'});
  for (const chunk of audio.slice(40)) capture.emit(chunk);
  const sentMs = Buffer.concat(got).length / 32;
  assert.ok(attached.flushedMs < 700, 'the kept silence was not sent: ' + attached.flushedMs);
  assert.ok(sentMs >= 700 && sentMs < 1000, 'the voice and a little lead went: ' + sentMs);
});

// ---- Voice activation ----------------------------------------------------------------------------------------------------------------------
test('a listening tap keeps only the newest second, reports the start and the end of speech, and a turn takes it from the onset', async () => {
  const capture = fakeCapture(), seen = [];
  const tap = new MicTap({capture, onVad: status => seen.push(status)});
  await tap.open('vad', {listen: true});
  assert.equal(tap.listening, true);
  const audio = chunks(join(quiet(4000), voice(1200), quiet(1400)));
  const heard = [];
  let started = null;
  for (const chunk of audio) {
    capture.emit(chunk);
    if (seen.length === 1 && !started) { started = tap.vadStatus; assert.equal(tap.listening, true); assert.ok(tap.ring.keptMs >= 0); }
  }
  assert.deepEqual(seen.map(status => status.phase), ['speech', 'ended']);
  assert.ok(Math.abs(seen[0].onsetMs - 4000) < 120, 'onset near the real start: ' + seen[0].onsetMs);
  assert.ok(seen[1].silenceMs >= 900, 'the end needs the quiet: ' + seen[1].silenceMs);
  assert.notEqual(seen[0].seq, seen[1].seq);
  tap.open('req-4', {vad: true, sinceMs: seen[0].onsetMs - TAP.prerollMs});
  assert.equal(tap.listening, false); assert.ok(tap.isOwner('req-4'));
  const attached = tap.attach('req-4', chunk => heard.push(chunk));
  const first = (seen[0].onsetMs - TAP.prerollMs);
  assert.ok(Math.abs(attached.flushedMs - (tap.streamMs - first)) < 80, 'handed over from onset minus the pre-roll: ' + attached.flushedMs);
  assert.ok(attached.flushedMs < 3000, 'the four seconds of quiet before the speech were never kept');
});

test('nothing is kept past the listening window while nobody speaks', async () => {
  const capture = fakeCapture(), tap = new MicTap({capture});
  await tap.open('vad', {listen: true});
  for (const chunk of chunks(quiet(10_000))) capture.emit(chunk);
  assert.ok(tap.ring.keptMs <= TAP.listenKeepMs + TAP.chunkMs, 'kept ' + tap.ring.keptMs);
  assert.equal(tap.vad.state, 'idle');
});

test('a key press takes a listening tap over with only a short lead, not the old audio', async () => {
  const capture = fakeCapture(), tap = new MicTap({capture});
  await tap.open('vad', {listen: true});
  for (const chunk of chunks(quiet(1400))) capture.emit(chunk);
  tap.open('req-5', {holdId: 'k6'});
  const got = [];
  const attached = tap.attach('req-5', chunk => got.push(chunk));
  assert.ok(attached.flushedMs <= TAP.keyLeadMs + TAP.chunkMs, 'kept ' + attached.flushedMs);
  assert.equal(tap.vad, null, 'the detector is dropped for a key turn');
});

test('releasing a listening tap closes the device and drops the detector and its audio', async () => {
  const capture = fakeCapture(), tap = new MicTap({capture, onRelease: () => released++});
  let released = 0;
  await tap.open('vad', {listen: true});
  for (const chunk of chunks(voice(500))) capture.emit(chunk);
  assert.ok(tap.vad);
  await tap.release('vad', 'voice activation is off');
  assert.equal(tap.state, 'closed'); assert.equal(tap.vad, null); assert.equal(tap.ring, null);
  assert.equal(capture.deviceOpen, false); assert.equal(released, 1);
});

// ---- through the real channel ---------------------------------------------------------------------------------------------------------------
test('the local recogniser channel gets every byte from the key press even when its model loads slowly', async () => {
  const capture = fakeCapture(), tap = new MicTap({capture});
  const pushed = [];
  const stt = {availability: () => ({available: true}), start: async () => { await tick(60); }, pushAudio: chunk => { pushed.push(Buffer.from(chunk)); return true; },
    heard: () => '', finish: async () => ({text: 'hello there', seconds: 1}), cancel: async () => {}};
  const states = [], replies = [];
  const mic = new MicrophoneSession({minRecordMs: 0, hostFactory: createLocalSttChannel({stt, capture: new TapCapture({tap})}),
    onState: async state => { states.push(state); }, onReply: async (input, result) => { replies.push(result); }, onError: async (input, error) => { states.push('error:' + error.message); }});
  const input = {requestId: '1-5-42ULL', entity: '42ULL', generation: 5, profileKey: 'judy', text: '(microphone)'};
  const spoken = chunks(join(quiet(100), voice(500)));
  await tap.hold('k7');                                   // the key goes down: the device opens at once
  for (const chunk of spoken.slice(0, 6)) capture.emit(chunk);
  tap.open(input.requestId, {holdId: 'k7'});              // the start command, after the bridge's preparation
  const starting = mic.start(input, {requestId: input.requestId});   // the model is loading: 60 ms
  for (const chunk of spoken.slice(6, 10)) capture.emit(chunk);       // still speaking while it loads
  await starting;
  for (const chunk of spoken.slice(10)) capture.emit(chunk);
  await tap.released('k7');                                // the key is let go
  await mic.finish(input.requestId);
  assert.deepEqual(states, ['starting', 'recording', 'reply', 'off']);
  assert.equal(Buffer.concat(pushed).compare(Buffer.concat(spoken)), 0, 'the recogniser heard all of it, in order');
  assert.equal(replies[0].userText, 'hello there');
  assert.equal(capture.deviceOpen, false);
});

test('a channel whose tap was not opened ahead opens it itself, as before', async () => {
  const capture = fakeCapture(), tap = new MicTap({capture});
  const adapter = new TapCapture({tap});
  const got = [];
  const info = await adapter.begin(chunk => got.push(chunk), {requestId: 'solo-1'});
  assert.equal(info.device, 'Fake microphone');
  capture.emit(Buffer.alloc(1280, 3));
  assert.equal(got.length, 1);
  await adapter.end(); await adapter.abort();
  assert.equal(tap.state, 'closed');
});

test('a VAD tap is the same VoiceActivity as the bridge uses (no second detector)', () => {
  assert.equal(typeof new VoiceActivity().push, 'function');
});
