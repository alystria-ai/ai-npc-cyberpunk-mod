import test from 'node:test';
import assert from 'node:assert/strict';
import { VAD, VoiceActivity, describeThresholds } from './voice-activity.mjs';

const SR = 16000;

// Seeded pseudo-random numbers, so every run sees the same audio.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rms = (db) => Math.pow(10, db / 20);
const ms = (n) => Math.round(n * SR / 1000);

// Float sample arrays (full scale = 1), mixed together and converted to Int16 PCM at the end.
function whiteNoise(durMs, db, seed = 1) {
  const r = rng(seed), out = new Float64Array(ms(durMs)), amp = rms(db) * Math.sqrt(3);
  for (let i = 0; i < out.length; i++) out[i] = (r() * 2 - 1) * amp;
  return out;
}
function silence(durMs) { return new Float64Array(ms(durMs)); }

// Harmonics of 120-200 Hz with a little vibrato, syllables at 4 Hz with a 60 ms dip in each 250 ms.
function voiced(durMs, db, seed = 7) {
  const r = rng(seed), n = ms(durMs), out = new Float64Array(n);
  const base = 120 + 80 * r(), phase0 = r() * 6.28;
  let phase = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f0 = base + 25 * Math.sin(2 * Math.PI * 0.6 * t + phase0);
    phase += 2 * Math.PI * f0 * (1 + 0.015 * Math.sin(2 * Math.PI * 5.5 * t)) / SR;
    let v = 0;
    for (let k = 1; k * f0 < 3800; k++) v += Math.sin(k * phase) / k;
    const into = (t * 1000) % 250;                                    // 0..250 ms inside the syllable
    const env = into > 190 ? 0.4 + 0.6 * (0.5 + 0.5 * Math.cos(2 * Math.PI * (into - 190) / 60)) : 1;
    out[i] = v * env;
    peak += out[i] * out[i];
  }
  const gain = rms(db) / Math.sqrt(peak / n);
  for (let i = 0; i < n; i++) out[i] *= gain;
  return out;
}
// A key click: a few milliseconds of a decaying spike.
function click(durMs, db) {
  const out = new Float64Array(ms(durMs)), r = rng(3);
  for (let i = 0; i < ms(3); i++) out[i] = (r() * 2 - 1) * Math.exp(-i / 30);
  let e = 0;
  for (const v of out) e += v * v;
  const gain = rms(db) / Math.sqrt(e / out.length);
  for (let i = 0; i < out.length; i++) out[i] *= gain;
  return out;
}

function concat(...parts) {
  const out = new Float64Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
function mix(a, b) {
  const out = new Float64Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = (a[i] || 0) + (b[i] || 0);
  return out;
}
function pcm(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), i * 2);
  return buf;
}
// Pushes the audio in chunks of `bytes` bytes and returns every event.
function run(audio, bytes = 1600, options = {}) {
  const vad = new VoiceActivity(options), buf = pcm(audio), events = [];
  for (let at = 0; at < buf.length; at += bytes) events.push(...vad.push(buf.subarray(at, Math.min(buf.length, at + bytes))));
  return { events, vad };
}
const types = (events) => events.map((e) => e.type);

test('pure low noise never fires', () => {
  for (const db of [-80, -70, -60, -55]) {
    const { events } = run(whiteNoise(10000, db, 11));
    assert.deepEqual(events, [], `${db} dBFS`);
  }
  assert.deepEqual(run(silence(5000)).events, []);
});

test('loud white noise (a fan) never fires', () => {
  const { events, vad } = run(whiteNoise(20000, -30, 5));
  assert.deepEqual(events, []);
  assert.equal(vad.state, 'idle');
});

test('loud white noise appearing after quiet never fires', () => {
  const { events } = run(concat(whiteNoise(3000, -65, 2), whiteNoise(15000, -28, 3), whiteNoise(2000, -65, 4)));
  assert.deepEqual(events, []);
});

test('a single 30 ms click never fires, nor a few of them', () => {
  assert.deepEqual(run(concat(whiteNoise(2000, -65, 1), click(30, -12), whiteNoise(2000, -65, 2))).events, []);
  const clicks = concat(whiteNoise(500, -65, 1), click(30, -10), whiteNoise(700, -65, 2), click(30, -8), whiteNoise(700, -65, 3), click(30, -10), whiteNoise(2000, -65, 4));
  assert.deepEqual(run(clicks).events, []);
});

test('voiced speech after low noise fires exactly one start at the right time', () => {
  const startMs = 2000;
  const audio = concat(whiteNoise(startMs, -65, 1), voiced(3000, -25));
  const { events, vad } = run(audio);
  assert.equal(events.length, 1);
  const [start] = events;
  assert.equal(start.type, 'start');
  assert.ok(Math.abs(start.onsetMs - startMs) <= 90, `onsetMs ${start.onsetMs}`);
  const lag = start.detectedMs - start.onsetMs;
  assert.ok(lag >= 230 && lag <= 330, `detectedMs - onsetMs = ${lag}`);
  assert.equal(vad.state, 'speech');
});

test('a mid-utterance pause of 700 ms does not end it, 1000 ms does (once)', () => {
  const speech = voiced(2000, -25, 7), tail = voiced(2000, -25, 8);
  const noPause = run(concat(whiteNoise(1000, -65, 1), speech, whiteNoise(700, -65, 2), tail, whiteNoise(300, -65, 3)));
  assert.deepEqual(types(noPause.events), ['start']);
  assert.equal(noPause.vad.state, 'speech');

  const realEnd = 1000 + 2000;
  const ended = run(concat(whiteNoise(1000, -65, 1), speech, whiteNoise(1000, -65, 2), whiteNoise(2000, -65, 3)));
  assert.deepEqual(types(ended.events), ['start', 'end']);
  const end = ended.events[1];
  assert.ok(Math.abs(end.endMs - realEnd) <= 150, `endMs ${end.endMs}`);
  assert.ok(end.silenceMs >= 900 && end.silenceMs <= 960, `silenceMs ${end.silenceMs}`);
  assert.ok(end.speechMs > 1500 && end.speechMs <= 2100, `speechMs ${end.speechMs}`);
  assert.equal(ended.vad.state, 'idle');
});

test('two utterances give start, end, start, end', () => {
  const audio = concat(whiteNoise(1500, -65, 1), voiced(1800, -26, 7), whiteNoise(1600, -65, 2), voiced(2200, -22, 9), whiteNoise(1500, -65, 3));
  const { events } = run(audio);
  assert.deepEqual(types(events), ['start', 'end', 'start', 'end']);
  assert.ok(events[2].onsetMs > events[1].endMs);
});

test('speech over room noise at -45 dBFS fires (the floor adapts)', () => {
  const room = whiteNoise(16000, -45, 21);
  const audio = concat(room.subarray(0, ms(10000)), mix(voiced(3000, -25, 7), room.subarray(ms(10000), ms(13000))), room.subarray(ms(13000)));
  const { events, vad } = run(audio);
  assert.deepEqual(types(events), ['start', 'end']);
  assert.ok(Math.abs(events[0].onsetMs - 10000) <= 150, `onsetMs ${events[0].onsetMs}`);
  assert.ok(vad.noiseFloorDb > -55 && vad.noiseFloorDb <= -35, `floor ${vad.noiseFloorDb}`);
});

test('the noise floor follows quiet down fast and loud up slowly, within the clamp', () => {
  const vad = new VoiceActivity();
  assert.equal(vad.noiseFloorDb, -60);
  vad.push(pcm(whiteNoise(5000, -45, 1)));
  assert.ok(vad.noiseFloorDb > -60 && vad.noiseFloorDb < -54, `5 s of -45 dB raised the floor to ${vad.noiseFloorDb}`);   // about 1 dB/s
  vad.push(pcm(whiteNoise(1000, -75, 2)));
  assert.ok(vad.noiseFloorDb < -70, `floor ${vad.noiseFloorDb}`);
  vad.push(pcm(silence(2000)));
  assert.ok(vad.noiseFloorDb >= -80);
  const loud = new VoiceActivity();
  loud.push(pcm(whiteNoise(60000, -20, 3)));
  assert.equal(loud.noiseFloorDb, -35);
});

test('chunk size does not change the events', () => {
  const audio = concat(whiteNoise(1200, -65, 1), voiced(1800, -25, 7), whiteNoise(1500, -65, 2), voiced(1500, -24, 9), whiteNoise(1500, -65, 3));
  const reference = run(audio, 1600).events;
  assert.deepEqual(types(reference), ['start', 'end', 'start', 'end']);
  for (const bytes of [2, 441, 3, 882, 1, 6400, 99999]) {
    assert.deepEqual(run(audio, bytes).events, reference, `chunk of ${bytes} bytes`);
  }
});

test('accepts Buffer, Uint8Array and Int16Array views alike (including odd offsets)', () => {
  const audio = concat(whiteNoise(1000, -65, 1), voiced(1500, -25, 7), whiteNoise(1500, -65, 2));
  const buf = pcm(audio), reference = run(audio).events;
  const run2 = (make) => { const v = new VoiceActivity(), ev = []; for (let at = 0; at < buf.length; at += 1600) ev.push(...v.push(make(buf.subarray(at, at + 1600)))); return ev; };
  assert.deepEqual(run2((b) => new Uint8Array(b)), reference);
  assert.deepEqual(run2((b) => new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length))), reference);
  // A Buffer view that starts at an odd byte offset of its ArrayBuffer.
  const shifted = Buffer.alloc(buf.length + 1);
  buf.copy(shifted, 1);
  const v = new VoiceActivity(), ev = [];
  for (let at = 1; at < shifted.length; at += 1600) ev.push(...v.push(shifted.subarray(at, Math.min(shifted.length, at + 1600))));
  assert.deepEqual(ev, reference);
});

test('streamMs counts audio, state and reset behave', () => {
  const vad = new VoiceActivity();
  assert.equal(vad.state, 'idle');
  assert.equal(vad.streamMs, 0);
  vad.push(pcm(whiteNoise(1000, -45, 1)));
  vad.push(Buffer.from([1, 2, 3]));                       // 1.5 samples: the half sample is kept
  assert.equal(vad.streamMs, (16000 + 1) * 1000 / SR);
  vad.push(Buffer.from([4]));
  assert.equal(vad.streamMs, (16000 + 2) * 1000 / SR);
  const floor = vad.noiseFloorDb;
  assert.ok(floor > -60);

  const events = vad.push(pcm(voiced(1500, -25, 7)));
  assert.equal(events.length, 1);
  assert.equal(vad.state, 'speech');
  vad.reset();
  assert.equal(vad.state, 'idle');
  assert.equal(vad.streamMs, 0);
  assert.equal(vad.noiseFloorDb, floor);                  // kept
  vad.reset({ floor: true });
  assert.equal(vad.noiseFloorDb, -60);
  // Starts again from scratch after a reset: stream time restarts at 0.
  const again = vad.push(pcm(concat(whiteNoise(500, -65, 1), voiced(1500, -25, 7))));
  assert.equal(again.length, 1);
  assert.ok(Math.abs(again[0].onsetMs - 500) <= 90);
});

test('options override defaults', () => {
  const audio = concat(whiteNoise(1000, -65, 1), voiced(1500, -25, 7), whiteNoise(2500, -65, 2));
  const slow = run(audio, 1600, { endSilenceMs: 2000 }).events;
  assert.deepEqual(types(slow), ['start', 'end']);
  assert.ok(slow[1].silenceMs >= 2000 && slow[1].silenceMs < 2060, `silenceMs ${slow[1].silenceMs}`);
  const never = run(whiteNoise(2000, -65, 1), 1600, { onsetFrames: 1, voicedThreshold: 2 }).events;
  assert.deepEqual(never, []);
});

test('describeThresholds names the numbers', () => {
  const text = describeThresholds();
  for (const value of [VAD.gateFloorDb, VAD.marginDb, VAD.onsetFrames, VAD.onsetWindow, VAD.hangoverMs, VAD.endSilenceMs, VAD.prerollMs, VAD.voicedThreshold]) {
    assert.ok(text.includes(String(value)), `${value} in "${text}"`);
  }
  assert.ok(describeThresholds({ endSilenceMs: 1234 }).includes('1234'));
  assert.equal(typeof text, 'string');
  assert.equal(Object.isFrozen(VAD), true);
});

test('60 s of audio is processed cheaply', () => {
  const audio = pcm(concat(...Array.from({ length: 6 }, (_, i) => concat(whiteNoise(2500, -55, 30 + i), voiced(4500, -24 - i, 40 + i), whiteNoise(3000, -30, 50 + i)))));
  assert.equal(audio.length / 2 / SR, 60);
  const vad = new VoiceActivity();
  const t0 = process.hrtime.bigint();
  for (let at = 0; at < audio.length; at += 1600) vad.push(audio.subarray(at, at + 1600));
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`60 s of audio in ${elapsed.toFixed(0)} ms`);
  assert.ok(elapsed < 3000, `${elapsed} ms`);
});
