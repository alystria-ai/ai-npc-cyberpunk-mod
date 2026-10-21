// The sample rate Convai's audio really arrives at, remembered per character (bridge/convai-audio-rates.mjs, bridge/convai-data-audio.mjs rateHint).
// The twin's packets say 24 kHz and carry 44.1 kHz; a turn played live must not be heard slow before the statistics arrive.
import test from 'node:test';
import assert from 'node:assert/strict';
import {ConvaiDataAudio, validRateHint} from './convai-data-audio.mjs';
import {AudioRates} from './convai-audio-rates.mjs';
import {readPcmWav} from './speech-audio.mjs';

const owner = {response_id: 'rate-response', neurosync_turn_id: 1, epoch: 1};
const wire = data => ({label: 'rtvi-ai', type: 'server-message', data});
const pcm = (bytes, extra = {}) => wire({type: 'audio-data', sample_rate: 24000, channels: 1, audio: bytes.toString('base64'), includes_wav_header: false, ...extra});
const face = count => wire({type: 'chunked-neurosync-blendshapes', ...owner, fps: 60, start_frame_index: 0,
  blendshapes: Array.from({length: count}, (_, index) => Array.from({length: 61}, (_, key) => ((index + key) % 8) / 8))});
const stats = (bytes, ms, frames) => wire({type: 'blendshape-turn-stats', ...owner, sequence: 19,
  stats: {total_audio_bytes: bytes, total_blendshapes: frames, fps: 60, total_audio_duration_ms: ms, was_interrupted: false}});
const terminal = () => wire({type: 'bot-turn-completed', ...owner, sequence: 18, was_interrupted: false});
const feed = (collector, message, atMs = 0) => collector.accept(message, {atMs, kind: 0});
const HINT = {declared: 24000, actual: 44100};

// 5,733 ms of 44.1 kHz audio (505,652 bytes) in two packets that say 24 kHz, as in the 2026-10-21 reports.
function turn({bytes = 505652, ms = 5733, frames = 344, rateHint = null} = {}) {
  const c = new ConvaiDataAudio({rateHint}), data = Buffer.alloc(bytes);
  for (let index = 0; index < bytes / 2; index++) data.writeInt16LE([-3000, -1, 0, 1, 3000][index % 5], index * 2);
  const half = Math.floor(bytes / 4) * 2;
  feed(c, face(frames), 10);
  feed(c, pcm(data.subarray(0, half)), 20);
  return {c, data, rest: () => feed(c, pcm(data.subarray(half)), 30),
    finish: () => { feed(c, pcm(data.subarray(half)), 30); feed(c, stats(bytes, ms, frames), 40); feed(c, terminal(), 41); return c; }};
}

test('with a remembered rate the first packet is already taken at 44.1 kHz, before any statistics', () => {
  const {c, data, finish} = turn({rateHint: HINT});
  assert.equal(c.sampleRate, 44100, 'from the first packet');
  assert.equal(c.declaredRate, 24000);
  assert.equal(c.progress().sampleRate, 44100);
  const [first] = c.drainPcm();
  assert.equal(first.offsetFrames, 0);
  finish();
  assert.equal(c.ready, true); assert.equal(c.error, null);
  const result = c.finish();
  assert.equal(result.sampleRate, 44100); assert.deepEqual(result.sampleRateCorrected, HINT);
  assert.equal(result.sampleRateHinted, true); assert.equal(result.sampleRateHintMissed, undefined);
  assert(Math.abs(result.duration - 5.733) < 0.001, 'the duration of the audio, not 10.5 s');
  const decoded = readPcmWav(Buffer.from(result.audio, 'base64'));
  assert.equal(decoded.sampleRate, 44100); assert.deepEqual(decoded.data, data);
});

test('without one the first packet keeps its label until the statistics correct it (the round-3 behaviour is unchanged)', () => {
  const {c, finish} = turn();
  assert.equal(c.sampleRate, 24000);
  finish();
  assert.equal(c.sampleRate, 44100); assert.deepEqual(c.finish().sampleRateCorrected, HINT);
  assert.equal(c.finish().sampleRateHinted, undefined);
});

test('a remembered rate applies only to packets with the label it was learned for, and only when it is a standard one', () => {
  const other = new ConvaiDataAudio({rateHint: HINT});
  feed(other, face(10), 1); feed(other, pcm(Buffer.alloc(3200), {sample_rate: 16000}), 2);
  assert.equal(other.sampleRate, 16000, 'another label: untouched');
  for (const rateHint of [{declared: 24000, actual: 32000}, {declared: 24000, actual: 24000}, {declared: 'x', actual: 44100}, {declared: 4000, actual: 44100}, null, undefined, 'junk']) {
    assert.equal(turn({rateHint}).c.sampleRate, 24000, JSON.stringify(rateHint));
    assert.equal(validRateHint(rateHint), null, JSON.stringify(rateHint));
  }
  assert.deepEqual(validRateHint({...HINT, extra: 1}), HINT);
});

test('a remembered rate that the statistics do not confirm gives way to the rate they fit, and the result says so', () => {
  // The character's audio is labelled right now: 24 kHz data under a 24 kHz label.
  const right = turn({rateHint: HINT, bytes: 288000, ms: 6000, frames: 360});
  assert.equal(right.c.sampleRate, 44100);
  right.finish();
  assert.equal(right.c.ready, true); assert.equal(right.c.sampleRate, 24000); assert.equal(right.c.rateCorrected, null);
  const result = right.c.finish();
  assert.equal(result.sampleRate, 24000); assert.equal(result.sampleRateCorrected, undefined);
  assert.equal(result.sampleRateHintMissed, true); assert.equal(result.sampleRateHinted, undefined);
  // 48 kHz data now.
  const other = turn({rateHint: HINT, bytes: 288000, ms: 3000, frames: 180});
  other.finish();
  assert.deepEqual(other.c.finish().sampleRateCorrected, {declared: 24000, actual: 48000});
  // Neither rate fits: still a fault, and a format one.
  const wrong = turn({rateHint: HINT, bytes: 384000, ms: 6000, frames: 360});
  wrong.rest();
  assert.throws(() => feed(wrong.c, stats(384000, 6000, 360), 40), /declared duration/);
  assert.equal(wrong.c.error.formatFault, true);
});

test('AudioRates: a turn of a character learned from is told its rate, others are not, and a turn with no Convai audio gets none', () => {
  const saved = [], logs = [];
  const rates = new AudioRates({initial: {'twin-1': HINT, junk: {declared: 24000, actual: 1}, ['x'.repeat(300)]: HINT}, onChange: value => saved.push(value), log: line => logs.push(line)});
  assert.equal(rates.size, 1);
  assert.deepEqual(rates.forConfig({characterId: 'twin-1', ttsEnabled: true, text: 'hola'}), {characterId: 'twin-1', ttsEnabled: true, text: 'hola', audioRate: HINT});
  assert.equal('audioRate' in rates.forConfig({characterId: 'ordinary', ttsEnabled: true}), false);
  assert.equal('audioRate' in rates.forConfig({characterId: 'twin-1', ttsEnabled: false}), false, 'a local voice speaks: no Convai audio');
  assert.equal('audioRate' in rates.forConfig({ttsEnabled: true}), false);
  assert.equal(rates.forConfig({characterId: 'ordinary', audioRate: HINT}).audioRate, undefined, 'a rate the caller put in is not trusted');
  assert.deepEqual(saved, [], 'reading changes nothing');
});

test('AudioRates.learn: the first correction is remembered and saved once, a repeat is not saved again, and one line is logged', () => {
  const saved = [], logs = [];
  const rates = new AudioRates({onChange: value => saved.push(value), log: line => logs.push(line)});
  const config = {characterId: 'twin-1'}, result = {sampleRate: 44100, sampleRateCorrected: HINT};
  rates.learn(config, result);
  assert.deepEqual(rates.hintFor('twin-1'), HINT);
  assert.deepEqual(saved, [{'twin-1': HINT}]);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes('twin-1'), 'the character id is not in the log line');
  rates.learn(config, {...result, sampleRateHinted: true});
  assert.equal(saved.length, 1); assert.equal(logs.length, 1);
  // Something else changes nothing: a turn with no audio, an unknown character, junk.
  for (const [cfg, res] of [[config, {text: 'only text'}], [{}, result], [config, null], [config, 'x'], [undefined, undefined]]) rates.learn(cfg, res);
  assert.equal(saved.length, 1);
});

test('AudioRates.learn: a rate the statistics did not confirm is forgotten and saved; a label that was always right is left alone', () => {
  const saved = [], rates = new AudioRates({initial: {'twin-1': HINT}, onChange: value => saved.push(value)});
  rates.learn({characterId: 'ordinary'}, {sampleRate: 24000});
  assert.equal(saved.length, 0, 'nothing was known about this one');
  rates.learn({characterId: 'twin-1'}, {sampleRate: 24000, sampleRateHintMissed: true});
  assert.equal(rates.hintFor('twin-1'), null);
  assert.deepEqual(saved, [{}]);
  // A hint that was never applied (the turn's label differed) and a turn at the label's own rate: dropped; a turn at some other rate: kept.
  const again = new AudioRates({initial: {'twin-1': HINT}, onChange: value => saved.push(value)});
  again.learn({characterId: 'twin-1'}, {sampleRate: 16000});
  assert.deepEqual(again.hintFor('twin-1'), HINT);
  again.learn({characterId: 'twin-1'}, {sampleRate: 24000});
  assert.equal(again.hintFor('twin-1'), null);
  // A different correction replaces the old one.
  const swap = new AudioRates({initial: {'twin-1': HINT}, onChange: value => saved.push(value)});
  swap.learn({characterId: 'twin-1'}, {sampleRate: 48000, sampleRateCorrected: {declared: 24000, actual: 48000}});
  assert.deepEqual(swap.hintFor('twin-1'), {declared: 24000, actual: 48000});
});

test('AudioRates: a failing save never fails the turn', () => {
  const rates = new AudioRates({onChange: () => { throw Error('disk full'); }});
  assert.doesNotThrow(() => rates.learn({characterId: 'twin-1'}, {sampleRate: 44100, sampleRateCorrected: HINT}));
});

test('the bridge keeps the memory in the state folder, hands it to the host and saves a change (source pin)', async () => {
  const {readFileSync} = await import('node:fs');
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(bridge, /resolve\(stateDirectory, 'convai-audio-rates\.json'\)/);
  assert.match(bridge, /audioRates: savedAudioRates[\s\S]{0,200}onAudioRate: rates =>/);
  const host = readFileSync(new URL('./realtime-host.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(host, /this\.evaluateSpeech\(lease\.value, method, this\.audioRates\.forConfig\(config\)/);
  assert.match(host, /this\.audioRates\.learn\(config, result\)/);
  assert.match(host, /this\.evaluateSpeech\(lease\.value, 'finishVoice', this\.audioRates\.forConfig\(finishConfig\)/);
  const page = readFileSync(new URL('./realtime-client.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(page, /new ConvaiDataAudio\(\{retiredOwners: retiredAudioOwners, rateHint: config\.audioRate\}\)/);
  assert.match(page, /startStandby\(current\.live, current\.dataAudio\?\.rateHint\?\.actual\)/);
});
