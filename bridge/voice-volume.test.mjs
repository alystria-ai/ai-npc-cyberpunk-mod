import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DIALOGUE_MAKEUP_DB, LIMITER_CEILING_DB, MAX_TOTAL_DB, MIN_TOTAL_DB, VOICE_VOLUME, activeMakeupDb, applyGainLimited,
  dbToGain, updateDialogueLevel, updateVoiceVolume, voiceVolumeDb, voiceVolumeDbOf, voiceVolumePercent, voiceVolumePercentNow} from './dialogue-level.mjs';
import {readPcmWav, storeSpeech} from './speech-audio.mjs';
import {playbackControl} from './continuous-pcm-core.mjs';
import {ContinuousPcmPlayer} from './continuous-pcm-player.mjs';
import {VLine} from './v-voice.mjs';
import {TurnClock} from './turn-clock.mjs';

// Nothing here opens an audio device: the WAVs are written to a temporary folder, the player is a fake, and the browser's own
// limiter is covered by dialogue-level-browser.test.mjs (offline rendering).

const sine = (rate, seconds, amplitude, hz = 997) =>
  Float32Array.from({length: Math.round(rate * seconds)}, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / rate));
const peak = samples => samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = samples => Math.sqrt(samples.reduce((s, v) => s + v * v, 0) / samples.length);
function wav16(samples, rate) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return out;
}
const pcmOf = bytes => { const {data} = readPcmWav(bytes); return Float32Array.from({length: data.length / 2}, (_, i) => data.readInt16LE(i * 2) / 32768); };
const reset = () => { updateVoiceVolume({}); updateDialogueLevel(''); };

test('the percent becomes dB: 100 is exactly unity, 200 is +6.02 dB, 50 is -6.02 dB; nonsense means 100', () => {
  try {
    assert.deepEqual(VOICE_VOLUME, {min: 50, max: 200, step: 5, default: 100});
    assert.equal(voiceVolumeDbOf(100), 0);
    assert.ok(Math.abs(voiceVolumeDbOf(200) - 6.0206) < 1e-3 && Math.abs(voiceVolumeDbOf(50) + 6.0206) < 1e-3);
    assert.equal(voiceVolumePercent(undefined), 100); assert.equal(voiceVolumePercent('150'), 100); assert.equal(voiceVolumePercent(NaN), 100);
    assert.equal(voiceVolumePercent(10), 50); assert.equal(voiceVolumePercent(900), 200); assert.equal(voiceVolumePercent(137.4), 137);
    assert.equal(voiceVolumeDb(), 0, 'the default is untouched');
    assert.equal(updateVoiceVolume({voiceVolume: 150}), true); assert.equal(voiceVolumePercentNow(), 150);
    assert.equal(updateVoiceVolume({voiceVolume: 150}), false, 'an unchanged poll reports no change');
    assert.equal(updateVoiceVolume(undefined), false, 'an unreadable settings file keeps the choice'); assert.equal(voiceVolumePercentNow(), 150);
    assert.equal(updateVoiceVolume({}), true); assert.equal(voiceVolumePercentNow(), 100, 'a file without the key is 100');
  } finally { reset(); }
});

test('the voice volume adds to the dialogue level and the sum stays inside what the renderers accept', () => {
  try {
    assert.equal(activeMakeupDb(), DIALOGUE_MAKEUP_DB, '100% leaves the dialogue level exactly as it was');
    updateVoiceVolume({voiceVolume: 200});
    assert.ok(Math.abs(activeMakeupDb() - (DIALOGUE_MAKEUP_DB + 6.0206)) < 1e-3);
    updateDialogueLevel('{"makeupDb": 12}'); assert.ok(Math.abs(activeMakeupDb() - MAX_TOTAL_DB) < 1e-9);
    updateDialogueLevel('{"enabled": false}'); assert.ok(Math.abs(activeMakeupDb() - 6.0206) < 1e-3, 'matching off still takes the boost');
    updateVoiceVolume({voiceVolume: 50}); assert.ok(Math.abs(activeMakeupDb() - MIN_TOTAL_DB) < 1e-9);
    updateVoiceVolume({voiceVolume: 100}); assert.equal(activeMakeupDb(), 0, 'matching off at 100% is the original path');
    // The player's admission takes every value the bridge can produce, and nothing beyond.
    for (const db of [MIN_TOTAL_DB, 0, 6, MAX_TOTAL_DB]) assert.equal(playbackControl({allow: true, paused: false, makeupDb: db}).makeupDb, db);
    for (const db of [MIN_TOTAL_DB - .1, MAX_TOTAL_DB + .1, NaN]) assert.throws(() => playbackControl({allow: true, paused: false, makeupDb: db}));
  } finally { reset(); }
});

test('Audioware slot WAVs: 100% is the original bytes, 200% never clips, 50% is half amplitude', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-volume-'));
  const rate = 24000;
  try {
    updateDialogueLevel('{"enabled": false}');   // the volume alone, without the dialogue-level gain
    const quiet = wav16(sine(rate, 1.5, .1), rate), loud = wav16(sine(rate, 1.5, .95), rate);
    await storeSpeech(quiet.toString('base64'), directory, 0);
    assert.deepEqual(await readFile(join(directory, 'reply-0.wav')), quiet, '100% with matching off writes the bytes untouched');

    updateVoiceVolume({voiceVolume: 200});
    await storeSpeech(quiet.toString('base64'), directory, 1);
    const doubled = pcmOf(await readFile(join(directory, 'reply-1.wav')));
    assert.ok(Math.abs(rms(doubled) / rms(pcmOf(quiet)) - 2) < .01, 'below the ceiling 200% is exactly twice the amplitude');
    await storeSpeech(loud.toString('base64'), directory, 2);
    const clipped = pcmOf(await readFile(join(directory, 'reply-2.wav')));
    assert.equal(clipped.length, pcmOf(loud).length, 'the length, and so the lip-sync timing, is unchanged');
    assert.ok(peak(clipped) <= dbToGain(LIMITER_CEILING_DB) + 1e-3, `peak ${peak(clipped)} stays under the limiter ceiling`);
    assert.ok(peak(clipped) < .91 && peak(clipped) > .5, 'the limiter holds the peak down instead of flattening it to full scale');

    updateVoiceVolume({voiceVolume: 50});
    await storeSpeech(quiet.toString('base64'), directory, 3);
    assert.ok(Math.abs(rms(pcmOf(await readFile(join(directory, 'reply-3.wav')))) / rms(pcmOf(quiet)) - .5) < .01);
  } finally { reset(); await rm(directory, {recursive: true, force: true}); }
});

test('the worst case (full-scale speech, the most dialogue level, 200%) cannot reach full scale', () => {
  const rate = 24000, source = sine(rate, 1, 1);
  for (const db of [6.0206, DIALOGUE_MAKEUP_DB + 6.0206, MAX_TOTAL_DB]) {
    const out = applyGainLimited(source, rate, db);
    assert.ok(peak(out) <= dbToGain(LIMITER_CEILING_DB) + 1e-6, `${db.toFixed(2)} dB peaks at ${peak(out)}`);
  }
  // A single click keeps its place.
  const click = new Float32Array(4800); click[2400] = 1;
  const out = applyGainLimited(click, rate, MAX_TOTAL_DB);
  assert.equal(out.indexOf(Math.max(...out)), 2400);
});

test("V's voice: the renderer's control carries the Voice volume, and 100% adds nothing", async () => {
  const controlsAt = async percent => {
    updateVoiceVolume({voiceVolume: percent});
    const controls = [];
    const made = new VLine({input: {requestId: 'r1', profileKey: 'judy-alvarez', text: 'Hello Judy.'}, key: 'v-male', text: 'Hello Judy.',
      plan: {engine: 'pocket', language: 'en'}, volume: .6, clock: new TurnClock(), log: () => {},
      play: async (config, producer, options) => {
        controls.push(options.onFrame({receivedFrames: 4800, ended: false}), options.onFrame({receivedFrames: 4800, ended: true}));
      },
      stream: async () => ({}), render: async () => ({})});
    await made.finished;
    return controls;
  };
  try {
    for (const control of await controlsAt(100)) assert.deepEqual(control, {allow: true, paused: false, volume: .6, pan: 0});
    for (const control of await controlsAt(200)) assert.ok(Math.abs(control.makeupDb - 6.0206) < 1e-3 && control.volume === .6);
    for (const control of await controlsAt(50)) assert.ok(Math.abs(control.makeupDb + 6.0206) < 1e-3);
    for (const control of await controlsAt(150)) playbackControl(control);   // and the renderer accepts it
  } finally { reset(); }
});

test('the browser player scales a lower Voice volume even without a limiter node, and never boosts without one', () => {
  let context;
  class Context {
    constructor(options) {
      context = this; this.sampleRate = options.sampleRate; this.currentTime = 0; this.state = 'suspended'; this.destination = {};
      this.audioWorklet = {addModule: async () => {}};
    }
    createGain() { this.gain = this.endpoint('gain'); return this.gain; }
    createStereoPanner() { this.panner = this.endpoint('pan'); return this.panner; }
    endpoint(name) { return {[name]: {value: 0, setValueAtTime(value) { this.value = value; }}, connect() {}, disconnect() {}}; }
  }
  const player = new ContinuousPcmPlayer({AudioContextClass: Context, AudioWorkletNodeClass: class { constructor() { this.port = {postMessage() {}}; } connect() {} },
    now: () => 0, setIntervalFn: () => 1, clearIntervalFn: () => {}});
  player.context = new Context({sampleRate: 24000}); player.panner = player.context.createStereoPanner(); player.gain = player.context.createGain();
  player.node = {connect() {}}; player.connectGraph();
  assert.equal(player.limiter, null, 'the fake context has no compressor, so the graph is the plain one');
  for (const [makeupDb, expected] of [[0, 1], [-6.0206, .5], [6.0206, 1]]) {
    player.admission = {...player.admission, volume: 1, makeupDb}; player.appliedVolume = undefined; player.applyGain();
    assert.ok(Math.abs(context.gain.gain.value - expected) < 1e-3, `${makeupDb} dB gives ${context.gain.gain.value}`);
  }
});
