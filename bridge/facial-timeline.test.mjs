import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BlendshapeQueue} from '../node_modules/@convai/web-sdk/dist/core/BlendshapeQueue.js';
import {drainBlendshapes} from './blendshape-capture.mjs';
import {buildFacialTimeline, buildProviderFacialTimeline, SPEECH_TRACKS} from './facial-timeline.mjs';
import {PcmChunkStream, sliceFaces} from './convai-audio-stream.mjs';

const owner = {requestId: 'reply-1', entity: 'judy-copy-2', generation: 7};
const values = amount => { const result = Array(61).fill(0); result[17] = amount; return result; };
function audio({bits = 16, codec = 1, channels = 1, duration = 1.5, sample} = {}) {
  const rate = 24000, samples = Math.floor(duration * rate), align = channels * bits / 8;
  const data = Buffer.alloc(44 + samples * align);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(codec, 20); data.writeUInt16LE(channels, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * align, 28); data.writeUInt16LE(align, 32);
  data.writeUInt16LE(bits, 34); data.write('data', 36); data.writeUInt32LE(samples * align, 40);
  for (let n = 0; n < samples; n++) {
    const t = n / rate, level = sample ? sample(t)
      : t >= 0.6 && t < 0.9 ? 0 : Math.sin(2 * Math.PI * 240 * t) * 0.2;
    for (let channel = 0; channel < channels; channel++) {
      const offset = 44 + n * align + channel * bits / 8;
      if (codec === 3) data.writeFloatLE(level, offset);
      else data.writeIntLE(Math.round(level * (2 ** (bits - 1) - 1)), offset, bits / 8);
    }
  }
  return data;
}
const weight = (line, sample, track) => line.frames[sample][line.tracks.indexOf(track) + 1];

test('60 Hz provider poses preserve a single-frame jaw and pucker peak at its original audio time', () => {
  const faces = Array.from({length: 61}, (_, frame) => {
    const pose = values(frame === 7 ? .5 : 0);
    pose[20] = frame === 7 ? .8 : 0;
    return {at: frame / 60, values: pose};
  });
  const input = {audio: audio({duration: 1}).toString('base64'), faces,
    facesFormat: 'arkit61', facesTimebase: 'audio-seconds'};
  const before = structuredClone(input), line = buildFacialTimeline(input, owner);
  assert.equal(line.frames.length, 61);
  assert.equal(line.frames[7][0], 7 / 60);
  assert.equal(weight(line, 7, 'jaw_mid_open'), .3);
  assert.equal(weight(line, 7, 'lips_l_purse'), .224);
  assert.equal(weight(line, 6, 'jaw_mid_open'), 0);
  assert.equal(weight(line, 8, 'jaw_mid_open'), 0);
  assert.equal(line.frames.at(-1)[0], 1);
  assert.deepEqual(input, before);
});

test('provider cadence follows source timestamps without stretching sparse or faster timelines', () => {
  for (const [rate, expectedRate] of [[24, 30], [30, 30], [50, 50], [60, 60], [120, 60]]) {
    const line = buildFacialTimeline({audio: audio({duration: 1}).toString('base64'),
      faces: Array.from({length: rate + 1}, (_, frame) => ({at: frame / rate, values: values(frame / rate)})),
      facesFormat: 'arkit61', facesTimebase: 'audio-seconds'}, owner);
    assert.equal(line.frames.length, expectedRate + 1, `source ${rate} Hz`);
    assert.equal(line.frames.at(-1)[0], 1);
    const middle = line.frames.find(frame => frame[0] === .5);
    assert(middle);
    assert.equal(middle[1], .3, `source ${rate} Hz keeps the pose at audio time .5`);
  }
});

test('60 Hz output stays within the native frame budget for a full two-minute reply', () => {
  const faces = Array.from({length: 7201}, (_, frame) => ({at: frame / 60, values: values(.2)}));
  const line = buildFacialTimeline({audio: audio({duration: 120, sample: () => 0}).toString('base64'),
    faces,
    facesFormat: 'arkit61', facesTimebase: 'audio-seconds'}, owner);
  assert.equal(line.frames.length, 7201);
  assert.equal(line.frames.at(-1)[0], 120);
  assert(line.frames.every((frame, index) => index === 0 || frame[0] > line.frames[index - 1][0]));
  assert(line.frames[0].slice(1).every(value => value === 0));
  assert(line.frames.at(-1).slice(1).every(value => value === 0));
  const continuous = buildProviderFacialTimeline({faces, facesFormat: 'arkit61', facesTimebase: 'audio-seconds',
    duration: 120, complete: true}, owner);
  assert.deepEqual(continuous.frames, line.frames);
});

test('continuous provider timelines accept ahead-delivered faces without reading or generating audio', () => {
  const faces = Array.from({length: 121}, (_, frame) => ({at: frame / 60, values: values(frame / 120)}));
  const before = structuredClone(faces), input = {faces, facesFormat: 'arkit61', facesTimebase: 'audio-seconds',
    duration: .513, complete: false};
  Object.defineProperty(input, 'audio', {get() { throw Error('The continuous face builder must not inspect audio'); }});
  const line = buildProviderFacialTimeline(input, owner);
  assert.equal(line.version, 1);
  assert.equal(line.requestId, owner.requestId);
  assert.equal(line.entity, owner.entity);
  assert.equal(line.generation, owner.generation);
  assert.equal(line.source, 'convai-arkit61');
  assert.equal(line.articulation, 'arkit61-open-v3');
  assert.equal(line.continuous, true);
  assert.equal(line.complete, false);
  assert.equal(line.duration, .513);
  assert.equal(line.frames.at(-1)[0], .513);
  assert(line.frames.at(-1)[1] > .2); // The buffered edge remains articulated.
  assert(line.frames.every(frame => frame[0] <= .513));
  assert(line.frames[0].slice(1).every(value => value === 0));
  assert.deepEqual(faces, before);
  const conventional = buildFacialTimeline({faces, facesFormat: 'arkit61', facesTimebase: 'audio-seconds',
    audio: audio({duration: .513}).toString('base64'),
    speechSegment: {version: 1, index: 1, startSeconds: 0, first: true, last: false}}, owner);
  assert.deepEqual(line.frames, conventional.frames);
});

test('growing provider prefixes retain global poses and only confirmed EOF releases the mouth', () => {
  const faces = Array.from({length: 121}, (_, frame) => {
    const pose = values(.2 + frame / 300); pose[19] = .3;
    return {at: frame / 60, values: pose};
  });
  const input = {faces, facesFormat: 'arkit61', facesTimebase: 'audio-seconds', complete: false};
  const before = structuredClone(input);
  const prefixes = [.5, .8, 1.1].map(duration => buildProviderFacialTimeline({...input, duration}, owner));
  for (let index = 1; index < prefixes.length; index++) {
    assert.deepEqual(prefixes[index].frames.slice(0, prefixes[index - 1].frames.length), prefixes[index - 1].frames);
  }
  assert(prefixes.every(line => line.frames.at(-1)[1] > .2));
  const final = buildProviderFacialTimeline({...input, duration: 1.2, complete: true}, owner);
  assert.equal(final.complete, true);
  assert.deepEqual(final.frames.slice(0, prefixes.at(-1).frames.length), prefixes.at(-1).frames);
  assert(final.frames.at(-1).slice(1).every(value => value === 0));
  assert.equal(final.frames.at(-1)[0], 1.2);
  assert.deepEqual(input, before);
});

test('continuous facial preparation rejects incomplete or malformed data without creating an audio fallback', () => {
  const faces = Array.from({length: 61}, (_, frame) => ({at: frame / 60, values: values(.3)}));
  const valid = {faces, facesFormat: 'arkit61', facesTimebase: 'audio-seconds', duration: 1, complete: false};
  for (const change of [{faces: []}, {faces: faces.slice(6)}, {faces: faces.slice(0, 20)},
    {facesFormat: 'arkit52'}, {facesTimebase: 'wall-clock'}, {complete: undefined}, {complete: 'false'},
    {duration: 0}, {duration: -.1}, {duration: NaN}, {duration: Infinity}, {duration: 120.1},
    {faces: [{at: 0, values: values(.3)}, {at: .8, values: values(NaN)}]},
    {faces: [{at: 0, values: values(.3)}, {at: 0, values: values(.3)}]},
    {faces: [...faces, {at: 121, values: values(.3)}]}]) {
    assert.equal(buildProviderFacialTimeline({...valid, ...change}, owner), undefined);
  }
  assert.equal(buildProviderFacialTimeline(valid, undefined), undefined);
  for (const generation of [undefined, -1, 1.5, 2147483648, '7']) {
    assert.equal(buildProviderFacialTimeline(valid, {...owner, generation}), undefined);
  }
  assert.equal(buildProviderFacialTimeline(undefined, owner), undefined);
  // One unsampled tail interval is expected; more missing coverage is not.
  assert(buildProviderFacialTimeline({...valid, faces: faces.slice(0, -1)}, owner));
  assert.equal(buildProviderFacialTimeline({...valid, faces: faces.slice(0, -2)}, owner), undefined);
});

test('quiet consonant closure survives voiced neighbours without an RMS-driven neutral flash', () => {
  const wav = audio({duration: .6, sample: at => Math.sin(2 * Math.PI * 240 * at)
    * (at >= .26 && at < .34 ? .001 : .2)});
  const faces = Array.from({length: 19}, (_, frame) => {
    const at = frame / 30, pose = values(.6);
    if (at >= .26 && at < .34) pose[18] = 1;
    return {at, values: pose};
  });
  const input = {audio: wav.toString('base64'), faces, facesFormat: 'arkit61', facesTimebase: 'audio-seconds'};
  const before = structuredClone(input), line = buildFacialTimeline(input, owner);
  assert(weight(line, 7, 'jaw_mid_open') > .2);
  assert.equal(weight(line, 9, 'jaw_mid_open'), 0);
  assert.equal(weight(line, 9, 'lips_together_up'), .2);
  assert.equal(weight(line, 9, 'lips_together_dn'), .2);
  assert(weight(line, 11, 'jaw_mid_open') > .2);
  assert.deepEqual(input, before);
});

test('whole and split ARKit timelines retain identical quiet articulation through a PCM file boundary', () => {
  const wav = audio({duration: 1.6, sample: at => Math.sin(2 * Math.PI * 240 * at)
    * (at >= .74 && at < .88 ? .001 : at < .8 ? .2 : .05)});
  const faces = Array.from({length: 49}, (_, frame) => {
    const at = frame / 30, pose = values(.45);
    pose[18] = at >= .74 && at < .88 ? 1 : 0;
    pose[19] = .3; pose[20] = .2;
    return {at, values: pose};
  });
  const common = {facesFormat: 'arkit61', facesTimebase: 'audio-seconds'};
  const whole = buildFacialTimeline({...common, audio: wav.toString('base64'), faces}, owner);
  const split = [0, .8].map((startSeconds, part) => {
    const pcm = wav.subarray(44 + Math.round(startSeconds * 48000), 44 + Math.round((startSeconds + .8) * 48000));
    const bytes = Buffer.concat([wav.subarray(0, 44), pcm]);
    bytes.writeUInt32LE(bytes.length - 8, 4); bytes.writeUInt32LE(pcm.length, 40);
    return buildFacialTimeline({...common, audio: bytes.toString('base64'),
      faces: sliceFaces(faces, startSeconds, startSeconds + .8),
      speechSegment: {version: 1, index: part + 1, startSeconds, first: part === 0, last: part === 1}}, owner);
  });
  assert.equal(weight(whole, 24, 'lips_together_up'), .2);
  for (let part = 0; part < split.length; part++) {
    for (let frame = 0; frame < split[part].frames.length; frame++) {
      // The final fade can round a floating-point half-unit differently when
      // expressed as local time. Agreement must stay within stored precision.
      split[part].frames[frame].slice(1).forEach((value, track) => {
        assert(Math.abs(value - whole.frames[part * 24 + frame][track + 1]) <= .000100001,
          `part ${part + 1}, frame ${frame}, track ${track}`);
      });
    }
  }
  assert.deepEqual(split[0].frames.at(-1).slice(1), split[1].frames[0].slice(1));
});

test('valid provider poses own quiet audio while missing trailing frames and completion still return to neutral', () => {
  const faces = Array.from({length: 23}, (_, frame) => ({at: frame / 30, values: values(.6)}));
  const line = buildFacialTimeline({audio: audio({duration: 1, sample: () => 0}).toString('base64'),
    faces, facesFormat: 'arkit61', facesTimebase: 'audio-seconds'}, owner);
  assert.equal(line.source, 'convai-arkit61');
  assert(weight(line, 6, 'jaw_mid_open') > .2); // No inferred rest over a provider-owned pose.
  assert(line.frames[26].slice(1).every(value => value === 0)); // >100ms beyond the last captured pose.
  assert(line.frames[0].slice(1).every(value => value === 0));
  assert(line.frames.at(-1).slice(1).every(value => value === 0));
});

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

test('ARKIT-61 mouth controls follow the actual order, preserve provider rest and exclude gaze', () => {
  const wav = audio(), before = Buffer.from(wav);
  const faces = Array.from({length: 45}, (_, n) => {
    if (n >= 18 && n < 27) return {at: n / 30, values: values(0)};
    const v = values(0.8); v[18] = n >= 30 ? 1 : 0; v[19] = 0.6; v[20] = 0.4;
    v[24] = 1; v[52] = 1; // Standard-52 jaw index / head yaw must not drive jaw.
    return {at: n / 30, values: v};
  });
  const line = buildFacialTimeline({audio: wav.toString('base64'), faces,
    facesFormat: 'arkit61', facesTimebase: 'audio-seconds'}, owner);
  assert.equal(line.source, 'convai-arkit61'); assert.deepEqual(wav, before);
  assert.equal(line.articulation, 'arkit61-open-v3');
  assert.equal(weight(line, 6, 'jaw_mid_open'), 0.3692);
  assert.equal(weight(line, 6, 'lips_l_funnel'), 0.18);
  assert.equal(weight(line, 6, 'lips_l_purse'), 0.112);
  assert.ok(line.frames[22].slice(1).every(x => x === 0));
  assert.equal(weight(line, 36, 'jaw_mid_open'), 0);
  assert.equal(weight(line, 36, 'lips_together_up'), 0.2);
  assert.ok(line.frames.at(-1).slice(1).every(x => x === 0));
  assert.equal(line.frames.at(-1)[0], 1.5);
  assert.equal(line.tracks.some(x => /eye|head|neck/.test(x)), false);
});

test('Convai opening strengthens small and medium jaw motion without forcing rest or exceeding local vowel travel', () => {
  const make = (jaw, closed = 0) => {
    const pose = values(jaw); pose[18] = closed;
    return buildFacialTimeline({audio: audio().toString('base64'), facesFormat: 'arkit61', facesTimebase: 'audio-seconds',
      faces: Array.from({length: 45}, (_, frame) => ({at: frame / 30, values: [...pose]}))}, owner);
  };
  const amounts = [0, .1, .35, .8, 1];
  const lines = amounts.map(value => make(value));
  assert.deepEqual(lines.map(line => weight(line, 6, 'jaw_mid_open')), [0, .1, .2471, .3692, .4]);
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index], jaw = weight(line, 6, 'jaw_mid_open');
    assert(jaw > .35 * amounts[index]);
    assert(jaw > weight(lines[index - 1], 6, 'jaw_mid_open'));
    assert.equal(weight(line, 22, 'jaw_mid_open'), jaw); // Quiet PCM cannot erase a valid provider pose.
    assert(line.frames[0].slice(1).every(value => value === 0));
    assert(line.frames.at(-1).slice(1).every(value => value === 0));
  }
  assert.equal(weight(make(.35, .5), 6, 'jaw_mid_open'), .1235);
  assert.equal(weight(make(.35, 1), 6, 'jaw_mid_open'), 0);
  assert.equal(weight(make(.35, 1), 6, 'lips_apart_up'), 0);
  assert.equal(weight(make(.35, 1), 6, 'lips_apart_dn'), 0);
  assert.equal(weight(make(.35, 1), 6, 'lips_together_up'), .2);
  assert.equal(weight(make(.35, 1), 6, 'lips_together_dn'), .2);
});

test('the jaw shoulder stays monotonic through a continuous vowel and yields to every lip closure', () => {
  const wav = audio({duration: 1.2}).toString('base64');
  for (const closure of [0, .25, .5, .75, 1]) {
    const faces = Array.from({length: 65}, (_, frame) => {
      const pose = values(frame / 64); pose[18] = closure;
      return {at: frame / 60, values: pose};
    });
    const line = buildFacialTimeline({audio: wav, faces, facesFormat: 'arkit61', facesTimebase: 'audio-seconds'}, owner);
    for (let frame = 4; frame <= 64; frame++) {
      assert(weight(line, frame, 'jaw_mid_open') >= weight(line, frame - 1, 'jaw_mid_open'));
      assert(weight(line, frame, 'jaw_mid_open') <= .4 * (1 - closure) + .0001);
      assert(Math.abs(weight(line, frame, 'lips_together_up') - .2 * closure) < .0001);
      assert.equal(weight(line, frame, 'lips_l_upper_raise'), 0);
      assert.equal(weight(line, frame, 'lips_r_upper_raise'), 0);
      if (closure === 1) assert.equal(weight(line, frame, 'jaw_mid_open'), 0);
    }
  }
});

test('Convai aperture calibration keeps upper-lip caps and unrelated articulation unchanged for every speaker', () => {
  const pose = values(.25);
  pose[19] = .6; pose[20] = .4; pose[29] = .3; pose[30] = .5;
  pose[37] = .4; pose[38] = .6; pose[39] = .2; pose[40] = .4;
  const input = {audio: audio().toString('base64'), facesFormat: 'arkit61', facesTimebase: 'audio-seconds',
    faces: Array.from({length: 45}, (_, frame) => ({at: frame / 30, values: [...pose]}))};
  const before = structuredClone(input), judy = buildFacialTimeline(input, owner);
  const johnny = buildFacialTimeline(input, {...owner, entity: 'johnny-copy-1'});
  assert.deepEqual(input, before); // Neither waveform nor provider values are rewritten.
  assert.deepEqual(judy.frames, johnny.frames); // No per-speaker or per-file peak normalization.
  assert.equal(weight(judy, 6, 'lips_apart_up'), .041);
  assert.equal(weight(judy, 6, 'lips_apart_dn'), .0848);
  for (const [track, expected] of Object.entries({lips_l_funnel: .18, lips_r_funnel: .18,
    lips_l_purse: .112, lips_r_purse: .112, lips_l_stretch: .06, lips_r_stretch: .10,
    lips_l_upper_raise: 0, lips_r_upper_raise: 0, tongue_mid_tip_up: 0,
    lips_l_corner_stretch: 0, lips_r_corner_stretch: 0})) assert.equal(weight(judy, 6, track), expected);
  for (const amount of [-100, 0, .05, .25, .8, 1, 100]) {
    const saturated = {...input, faces: input.faces.map(frame => ({at: frame.at,
      values: frame.values.map((value, index) => [17, 37, 38, 39, 40].includes(index) ? amount : value)}))};
    const line = buildFacialTimeline(saturated, owner);
    for (let frame = 0; frame < line.frames.length; frame++) {
      assert(weight(line, frame, 'jaw_mid_open') >= 0 && weight(line, frame, 'jaw_mid_open') <= .4);
      assert(weight(line, frame, 'lips_apart_up') >= 0 && weight(line, frame, 'lips_apart_up') <= .12);
      assert(weight(line, frame, 'lips_apart_dn') >= 0 && weight(line, frame, 'lips_apart_dn') <= .16);
    }
  }
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
  assert.equal(lines[0].frames.at(-1)[jaw], .3692);
  assert.equal(lines[1].frames[0][jaw], .3692);
  assert.equal(lines[1].frames.at(-1)[jaw], .3692);
  assert.equal(lines[2].frames[0][jaw], .3692);
  assert.equal(lines[2].frames.at(-1)[jaw], 0);
  assert(lines[2].frames.at(-2)[jaw] < .3692);
  assert.deepEqual(lines.map(line => line.segment), segments);
  assert(lines.every(line => weight(line, 22, 'jaw_mid_open') === .3692));
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
  const last = buildFacialTimeline({...common,
    speechSegment: {version: 1, index: 128, startSeconds: 119, first: false, last: true}}, owner);
  assert.equal(last.segment.index, 128);
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
