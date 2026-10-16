import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DIALOGUE_MAKEUP_DB, activeMakeupDb, applyGainLimited, dbToGain, dialogueLevel, integratedLoudness,
  kWeighting, levelWav, updateDialogueLevel} from './dialogue-level.mjs';
import {readPcmWav, silentWav, storeSpeech} from './speech-audio.mjs';
import {ContinuousPcmPlayer, LIMITER, airCutoff} from './continuous-pcm-player.mjs';
import {playbackControl} from './continuous-pcm-core.mjs';

const sine = (rate, seconds, amplitude, hz = 997) =>
  Float32Array.from({length: Math.round(rate * seconds)}, (_, i) => amplitude * Math.sin(2 * Math.PI * hz * i / rate));
const lufs = (samples, rate) => integratedLoudness([kWeighting(samples, rate)], rate);
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

test('BS.1770 meter: a -20 dBFS 997 Hz mono sine reads -23 LUFS at 24 and 48 kHz', () => {
  for (const rate of [24000, 48000]) assert.ok(Math.abs(lufs(sine(rate, 3, .1), rate) - -23.0) < .15);
  assert.equal(lufs(new Float32Array(48000), 48000), -Infinity);
});

test('levelling adds the makeup gain, holds peaks under the ceiling and keeps length and timing', () => {
  const rate = 24000, quiet = sine(rate, 2, .05), loud = sine(rate, 2, .8);
  const louder = applyGainLimited(quiet, rate, 6);
  assert.ok(Math.abs(lufs(louder, rate) - lufs(quiet, rate) - 6) < .05, 'below the ceiling it is exactly +6 dB');
  const limited = applyGainLimited(loud, rate, 6);
  assert.equal(limited.length, loud.length);
  assert.ok(Math.max(...limited.map(Math.abs)) <= dbToGain(-1) + 1e-6, 'no sample above -1 dBFS');
  // A single click stays at the same sample: the look-ahead is compensated.
  const click = new Float32Array(4800); click[2400] = .9;
  const out = applyGainLimited(click, rate, 6);
  assert.equal(out.indexOf(Math.max(...out)), 2400);
});

test('Audioware slot WAVs carry the level; matching off writes the original bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dialogue-level-'));
  try {
    const source = wav16(sine(24000, 1.5, .1), 24000);
    await storeSpeech(source.toString('base64'), directory, 1, {makeupDb: 0});
    assert.deepEqual(await readFile(join(directory, 'reply-1.wav')), source);
    const stored = await storeSpeech(source.toString('base64'), directory, 2, {makeupDb: 6});
    assert.equal(stored.duration, 1.5);
    const gained = lufs(pcmOf(await readFile(join(directory, 'reply-2.wav'))), 24000) - lufs(pcmOf(source), 24000);
    assert.ok(Math.abs(gained - 6) < .1, `gain ${gained}`);
    assert.deepEqual(levelWav(readPcmWav(silentWav()), 6), silentWav());
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('runtime/dialogue-level.json switches matching off, sets a calibrated level, and is clamped', () => {
  try {
    assert.equal(updateDialogueLevel(''), false);
    assert.deepEqual(dialogueLevel(), {enabled: true, makeupDb: DIALOGUE_MAKEUP_DB});
    assert.equal(updateDialogueLevel('{"enabled": false}'), true);
    assert.equal(activeMakeupDb(), 0);
    updateDialogueLevel('{"enabled": true, "makeupDb": 8.5}'); assert.equal(activeMakeupDb(), 8.5);
    updateDialogueLevel('{"makeupDb": 40}'); assert.equal(activeMakeupDb(), 12);
    // A partial write keeps the previous choice instead of resetting it.
    assert.equal(updateDialogueLevel('{"enab'), false); assert.equal(activeMakeupDb(), 12);
  } finally { updateDialogueLevel(''); }
});

test('playback control accepts the level fields and rejects nonsense', () => {
  assert.deepEqual(playbackControl({allow: true, paused: false, volume: .5, pan: 0}),
    {allow: true, paused: false, volume: .5, pan: 0, makeupDb: 0, distance: null, delayMs: 0});
  assert.equal(playbackControl({allow: true, paused: false, makeupDb: 6, distance: 3.5}).distance, 3.5);
  for (const bad of [{makeupDb: -7}, {makeupDb: 19}, {makeupDb: NaN}, {distance: -1}, {distance: Infinity}])
    assert.throws(() => playbackControl({allow: true, paused: false, ...bad}));
  assert.equal(airCutoff(2, 12000), 12000);
  assert.ok(Math.abs(airCutoff(30, 24000) - 5000) < 1);
});

function graphFixture() {
  const param = value => ({value, setValueAtTime(v) { this.value = v; }, setTargetAtTime(v) { this.value = v; this.smoothed = true; }});
  const node = extra => ({...extra, outputs: [], connect(target) { this.outputs.push(target); },
    disconnect() { this.outputs = []; }});
  let context;
  class Context {
    constructor({sampleRate}) {
      context = this; this.sampleRate = sampleRate; this.currentTime = 0; this.state = 'suspended';
      this.destination = node({name: 'destination'}); this.baseLatency = 0; this.outputLatency = 0;
      this.audioWorklet = {addModule: async () => {}};
    }
    createGain() { return (this.gain = node({name: 'gain', gain: param(1)})); }
    createStereoPanner() { return (this.panner = node({name: 'panner', pan: param(0)})); }
    createBiquadFilter() { return (this.air = node({name: 'air', Q: param(1), frequency: param(350)})); }
    createDynamicsCompressor() {
      return (this.limiter = node({name: 'limiter', threshold: param(-24), knee: param(30), ratio: param(12), attack: param(.003), release: param(.25)}));
    }
    async resume() { this.state = 'running'; }
    getOutputTimestamp() { return {contextTime: 0, performanceTime: 0}; }
    async close() { this.state = 'closed'; }
  }
  class Worklet {
    constructor(_, __, {processorOptions}) {
      this.token = processorOptions.token; this.outputs = [];
      this.port = {postMessage: message => queueMicrotask(() => this.port.onmessage?.({data: {type: 'state', token: this.token,
        id: message.id, history: [], snapshot: {state: 'ready', playedFrames: 0, receivedFrames: 0, bufferedFrames: 0,
          sampleRate: processorOptions.sampleRate, channels: processorOptions.channels, underruns: 0}}})), close() {}};
    }
    connect(target) { this.outputs.push(target); }
    disconnect() {}
  }
  const player = new ContinuousPcmPlayer({AudioContextClass: Context, AudioWorkletNodeClass: Worklet, setIntervalFn: () => 1, clearIntervalFn: () => {}});
  return {player, get context() { return context; }};
}

test('the browser renderer routes through the limiter only while makeup is active', async () => {
  const f = graphFixture();
  await f.player.open({sampleRate: 24000, channels: 1, token: 'level'});
  const c = f.context;
  assert.deepEqual([c.panner.outputs[0].name, c.air.outputs[0].name, c.gain.outputs[0].name], ['air', 'gain', 'destination']);
  assert.equal(c.air.frequency.value, 12000, 'the low-pass starts fully open (identity at Nyquist)');
  f.player.control({allow: true, paused: false, volume: .5, pan: .3, makeupDb: 6, distance: 30});
  assert.equal(c.gain.outputs[0].name, 'limiter'); assert.equal(c.limiter.outputs[0].name, 'destination');
  assert.equal(c.limiter.threshold.value, LIMITER.threshold); assert.equal(c.limiter.ratio.value, LIMITER.ratio);
  assert.ok(Math.abs(c.gain.gain.value - .5 * dbToGain(6 - LIMITER.makeupDb)) < 1e-9);
  assert.ok(Math.abs(c.air.frequency.value - 5000) < 1);
  // Matching off: gain goes straight to the device again, at the game's volume.
  f.player.control({allow: true, paused: false, volume: .5, pan: .3, makeupDb: 0, distance: 30});
  assert.equal(c.gain.outputs[0].name, 'destination'); assert.equal(c.gain.gain.value, .5);
  assert.equal(c.air.frequency.value, 12000);
  await f.player.stop();
});
