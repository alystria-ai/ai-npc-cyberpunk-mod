import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BlendshapeQueue} from '../node_modules/@convai/web-sdk/dist/core/BlendshapeQueue.js';
import {drainBlendshapes} from './blendshape-capture.mjs';
import {buildFacialTimeline, SPEECH_TRACKS} from './facial-timeline.mjs';
import {PcmChunkStream} from './convai-audio-stream.mjs';

const owner = {requestId: 'reply-1', entity: 'judy-copy-2'};
const values = amount => { const result = Array(61).fill(0); result[17] = amount; return result; };
function audio({bits = 16, codec = 1, channels = 1, duration = 1.5} = {}) {
  const rate = 24000, samples = Math.floor(duration * rate), align = channels * bits / 8;
  const data = Buffer.alloc(44 + samples * align);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(codec, 20); data.writeUInt16LE(channels, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * align, 28); data.writeUInt16LE(align, 32);
  data.writeUInt16LE(bits, 34); data.write('data', 36); data.writeUInt32LE(samples * align, 40);
  for (let n = 0; n < samples; n++) {
    const t = n / rate, level = t >= 0.6 && t < 0.9 ? 0 : Math.sin(2 * Math.PI * 240 * t) * 0.2;
    for (let channel = 0; channel < channels; channel++) {
      const offset = 44 + n * align + channel * bits / 8;
      if (codec === 3) data.writeFloatLE(level, offset);
      else data.writeIntLE(Math.round(level * (2 ** (bits - 1) - 1)), offset, bits / 8);
    }
  }
  return data;
}
const weight = (line, sample, track) => line.frames[sample][line.tracks.indexOf(track) + 1];

test('capture preserves every ahead-delivered frame and its indexed timestamp across SDK batches', () => {
  const queue = new BlendshapeQueue(), captured = [];
  queue.startConversation();
  queue.addChunk([values(0.4), values(0.5)], {fps: 30, startFrameIndex: 4, responseId: 'one'});
  drainBlendshapes(queue, captured); assert.equal(captured.length, 0);
  queue.addChunk([0, 0.1, 0.2, 0.3].map(values), {fps: 30, startFrameIndex: 0, responseId: 'one'});
  drainBlendshapes(queue, captured);
  assert.equal(captured.length, 6); assert.equal(queue.length, 0);
  for (let n = 0; n < 6; n++) {
    assert.equal(captured[n].at, n / 30);
    assert.ok(Math.abs(captured[n].values[17] - n / 10) < 1e-6);
  }
  queue.addChunk([values(0.6)], {fps: 30, startFrameIndex: 6, responseId: 'one'});
  drainBlendshapes(queue, captured); assert.equal(captured[6].at, 0.2);
  queue.startConversation();
  queue.addChunk([values(0.9)], {fps: 30, startFrameIndex: 0, responseId: 'two'});
  drainBlendshapes(queue, captured);
  assert.equal(captured.length, 1); assert.ok(captured[0].values[17] > 0.89);
});

test('ARKIT-61 mouth controls follow the actual order, close during silence and exclude gaze', () => {
  const wav = audio(), before = Buffer.from(wav);
  const faces = Array.from({length: 45}, (_, n) => {
    const v = values(0.8); v[18] = n >= 30 ? 1 : 0; v[19] = 0.6; v[20] = 0.4;
    v[24] = 1; v[52] = 1; // Standard-52 jaw index / head yaw must not drive jaw.
    return {at: n / 30, values: v};
  });
  const line = buildFacialTimeline({audio: wav.toString('base64'), faces,
    facesFormat: 'arkit61', facesTimebase: 'audio-seconds'}, owner);
  assert.equal(line.source, 'convai-arkit61'); assert.deepEqual(wav, before);
  assert.equal(weight(line, 6, 'jaw_mid_open'), 0.28);
  assert.equal(weight(line, 6, 'lips_l_funnel'), 0.18);
  assert.equal(weight(line, 6, 'lips_l_purse'), 0.112);
  assert.ok(line.frames[22].slice(1).every(x => x === 0));
  assert.equal(weight(line, 36, 'jaw_mid_open'), 0);
  assert.equal(weight(line, 36, 'lips_together_up'), 0.2);
  assert.ok(line.frames.at(-1).slice(1).every(x => x === 0));
  assert.equal(line.frames.at(-1)[0], 1.5);
  assert.equal(line.tracks.some(x => /eye|head|neck/.test(x)), false);
});

test('local fallback reads PCM 16/24/32 and float stereo without changing any audio bytes', () => {
  for (const format of [{bits: 16}, {bits: 24, channels: 2}, {bits: 32}, {bits: 32, codec: 3, channels: 2}]) {
    const wav = audio(format), before = Buffer.from(wav);
    const line = buildFacialTimeline({audio: wav.toString('base64')}, owner);
    assert.equal(line.source, 'audio-envelope'); assert.deepEqual(wav, before);
    assert.ok(weight(line, 6, 'jaw_mid_open') > 0.2);
    assert.ok(line.frames[22].slice(1).every(x => x === 0));
    assert.ok(line.frames.every(frame => frame.slice(4).every(x => x === 0)));
    assert.equal(line.requestId, owner.requestId); assert.equal(line.entity, owner.entity);
  }
});

test('malformed, incomplete and unknown facial formats fall back without discarding the voice', () => {
  const result = {audio: audio({duration: 1.0667}).toString('base64'),
    facesFormat: 'arkit61', facesTimebase: 'audio-seconds'};
  for (const faces of [[], [{at: 0, values: values(0.3)}, {at: 0, values: values(0.4)}],
    [{at: 0, values: Array(52).fill(0)}, {at: 1, values: Array(52).fill(0)}],
    [{at: 0, values: values(NaN)}, {at: 1, values: values(1)}],
    [{at: 0, values: values(0.3)}, {at: 0.1, values: values(0.4)}]]) {
    const line = buildFacialTimeline({...result, faces}, owner);
    assert.equal(line.source, 'audio-envelope');
    assert.ok(line.frames.every((frame, n) => n === 0 || frame[0] > line.frames[n - 1][0]));
    assert.equal(line.tracks.length, SPEECH_TRACKS.length);
  }
});

test('ARKIT continuation keeps the actual mouth pose across native files and eases only the utterance ends', () => {
  const wav = audio({duration: 1}).toString('base64');
  const faces = Array.from({length: 31}, (_, index) => ({at: index / 30, values: values(.8)}));
  const common = {audio: wav, faces, facesFormat: 'arkit61', facesTimebase: 'audio-seconds'};
  const segments = [
    {version: 1, index: 1, startSeconds: 0, first: true, last: false},
    {version: 1, index: 2, startSeconds: 1, first: false, last: false},
    {version: 1, index: 3, startSeconds: 2, first: false, last: true},
  ];
  const lines = segments.map(speechSegment => buildFacialTimeline({...common, speechSegment}, owner));
  const jaw = lines[0].tracks.indexOf('jaw_mid_open') + 1;
  assert.equal(lines[0].frames[0][jaw], 0);
  assert.equal(lines[0].frames.at(-1)[jaw], .28);
  assert.equal(lines[1].frames[0][jaw], .28);
  assert.equal(lines[1].frames.at(-1)[jaw], .28);
  assert.equal(lines[2].frames[0][jaw], .28);
  assert.equal(lines[2].frames.at(-1)[jaw], 0);
  assert(lines[2].frames.at(-2)[jaw] < .28);
  assert.deepEqual(lines.map(line => line.segment), segments);
  assert(lines.every(line => line.frames[22].slice(1).every(value => value === 0))); // Real silence still closes the mouth.
});

test('audio-envelope fallback does not create artificial neutral frames at continuation file edges', () => {
  const wav = audio({duration: 1}).toString('base64');
  const line = buildFacialTimeline({audio: wav,
    speechSegment: {version: 1, index: 2, startSeconds: 1, first: false, last: false}}, owner);
  const jaw = line.tracks.indexOf('jaw_mid_open') + 1;
  assert.equal(line.source, 'audio-envelope');
  assert(line.frames[0][jaw] > .3);
  assert(line.frames.at(-1)[jaw] > .3);
  assert(line.frames[22].slice(1).every(value => value === 0));
  assert(line.frames.every(row => row.slice(1).every(value => Number.isFinite(value) && value >= 0 && value <= .5)));
});

test('malformed boundary claims cannot opt out of facial cleanup', () => {
  const common = {audio: audio({duration: 1}).toString('base64')};
  for (const speechSegment of [null, {}, {version: 1, index: 1, startSeconds: 0, first: false, last: false},
    {version: 1, index: 2, startSeconds: 0, first: false, last: false},
    {version: 1, index: 2, startSeconds: 1, first: false, last: 'false'},
    {version: 1, index: 129, startSeconds: 119, first: false, last: true},
    {version: 1, index: 2, startSeconds: 120, first: false, last: true}]) {
    assert.throws(() => buildFacialTimeline({...common, speechSegment}, owner), /Invalid facial segment/);
  }
  const ordinary = buildFacialTimeline(common, owner);
  assert.equal(ordinary.segment, undefined);
  assert(ordinary.frames[0].slice(1).every(value => value === 0));
  assert(ordinary.frames.at(-1).slice(1).every(value => value === 0));
});

test('real PCM producer flags only the captured final tail and builds connected facial boundaries', async () => {
  const segments = [], stream = new PcmChunkStream({sampleRate: 8000, emit: async chunk => segments.push(chunk)});
  const faces = Array.from({length: 97}, (_, index) => ({at: index / 30, values: values(.7)}));
  const metadata = {text: 'This is one ongoing spoken sentence.', textComplete: true, faces, captions: []};
  stream.update(metadata); stream.push(new Float32Array(8000 * 3).fill(.1));
  await stream.pump();
  assert.equal(segments.length, 2);
  assert(segments.every(chunk => chunk.speechSegment.last === false));
  await stream.finish(metadata);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map(chunk => chunk.speechSegment.first), [true, false, false]);
  assert.deepEqual(segments.map(chunk => chunk.speechSegment.last), [false, false, true]);
  const lines = segments.map(chunk => buildFacialTimeline(chunk, owner));
  const jaw = lines[0].tracks.indexOf('jaw_mid_open') + 1;
  for (let index = 1; index < lines.length; index++) {
    assert.equal(lines[index - 1].frames.at(-1)[jaw], lines[index].frames[0][jaw]);
    assert(lines[index].frames[0][jaw] > 0);
  }
  assert.equal(lines.at(-1).frames.at(-1)[jaw], 0);
});
