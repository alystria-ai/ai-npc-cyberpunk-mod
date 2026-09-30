import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ContinuousPcmCore, PcmClockHistory, PcmQuantumClock, PCM_LIMITS} from './continuous-pcm-core.mjs';

const pcm = samples => {
  const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
};
const allowed = {allow: true, paused: false};
const core = options => new ContinuousPcmCore({sampleRate: 8000, channels: 1, startupSeconds: 0, ...options});
function render(sound, frames, time = sound.playedFrames / sound.sampleRate, now = time * 1000) {
  const outputs = Array.from({length: sound.channels}, () => new Float32Array(frames).fill(9));
  const segment = {...sound.render(outputs, time, now)};
  return {outputs, segment};
}

test('packet and ring-wrap boundaries preserve every PCM16 sample exactly', () => {
  const input = Array.from({length: 1000}, (_, i) => ((i * 7919) % 65536) - 32768);
  const whole = core(), packeted = core({capacityFrames: 53});
  whole.control(allowed, 0); packeted.control(allowed, 0);
  whole.append(pcm(input), 0); whole.end(input.length);
  const expected = [...render(whole, input.length).outputs[0]], actual = [];
  let offset = 0;
  while (offset < input.length) {
    const count = Math.min(17 + (offset % 19), input.length - offset);
    packeted.append(pcm(input.slice(offset, offset + count)), offset);
    if (offset + count === input.length) packeted.end(input.length);
    actual.push(...render(packeted, count).outputs[0]); offset += count;
  }
  assert.deepEqual(actual, expected);
  assert.equal(packeted.playedFrames, input.length);
  assert.equal(packeted.bufferedFrames, 0);
  assert.equal(packeted.underruns, 0);
});

test('stereo, little endian signs, and byte views retain source channels', () => {
  const sound = core({channels: 2}); sound.control(allowed, 0);
  const source = pcm([-32768, 32767, -1, 1, 0, 12345]);
  const padded = new Uint8Array(source.length + 6); padded.set(source, 4);
  sound.append(padded.subarray(4, 4 + source.length), 0); source.fill(0); sound.end(3);
  const {outputs} = render(sound, 5);
  assert.deepEqual([...outputs[0]], [-1, -1 / 32768, 0, 0, 0]);
  assert.deepEqual([...outputs[1]], [32767 / 32768, 1 / 32768, 12345 / 32768, 0, 0]);
  assert.equal(sound.state, 'drained');
});

test('400ms startup is admitted once, and only exact available samples play', () => {
  const sound = core({startupSeconds: .4});
  sound.append(pcm(Array(3199).fill(123)), 0); sound.control(allowed, 0);
  assert.ok(render(sound, 128).outputs[0].every(x => x === 0));
  assert.equal(sound.playedFrames, 0); assert.equal(sound.underruns, 0);
  sound.append(pcm([456]), 3199);
  assert.equal(render(sound, 128).outputs[0][0], 123 / 32768);
  assert.equal(sound.playedFrames, 128);
});

test('short EOF bypasses startup buffer and preserves the exact final tail', () => {
  const sound = core({sampleRate: 24000, startupSeconds: .4}); sound.control(allowed, 0);
  sound.append(pcm([100, 200, 300]), 0); sound.end(3);
  const {outputs, segment} = render(sound, 128);
  assert.deepEqual([...outputs[0].slice(0, 5)], [100 / 32768, 200 / 32768, 300 / 32768, 0, 0]);
  assert.equal(segment.to, 3); assert.equal(segment.advancingEnd, 3 / 24000);
  assert.equal(sound.state, 'drained'); assert.equal(sound.underruns, 0);
});

test('underrun freezes the source clock and resumes without repeat or loss', () => {
  const sound = core(); sound.control(allowed, 0); sound.append(pcm([1, 2, 3]), 0);
  assert.deepEqual([...render(sound, 5).outputs[0]], [1 / 32768, 2 / 32768, 3 / 32768, 0, 0]);
  assert.equal(sound.underruns, 1);
  render(sound, 8, .001); render(sound, 8, .002);
  assert.equal(sound.playedFrames, 3); assert.equal(sound.underruns, 1);
  sound.append(pcm([4, 5]), 3); sound.end(5);
  assert.deepEqual([...render(sound, 3, .003).outputs[0]], [4 / 32768, 5 / 32768, 0]);
  assert.equal(sound.playedFrames, 5); assert.equal(sound.state, 'drained');
});

test('withholding admission and pausing consume no PCM', () => {
  const sound = core(); sound.append(pcm([6, 7, 8]), 0); sound.end(3);
  render(sound, 10); assert.equal(sound.playedFrames, 0);
  sound.control({...allowed, paused: true}, 10);
  render(sound, 10, .01); assert.equal(sound.state, 'paused'); assert.equal(sound.playedFrames, 0);
  sound.control(allowed, 20);
  assert.equal(render(sound, 1, .02).outputs[0][0], 6 / 32768);
});

test('stale admission holds at 500ms, fresh admission can resume, 2s expires permanently', () => {
  const sound = core(); sound.append(pcm([42, 43, 44]), 0); sound.control(allowed, 0);
  render(sound, 1, .5); assert.equal(sound.state, 'lease-held'); assert.equal(sound.playedFrames, 0);
  sound.control(allowed, 700);
  assert.equal(render(sound, 1, .7).outputs[0][0], 42 / 32768);
  render(sound, 1, 2.7); assert.equal(sound.state, 'error'); assert.match(sound.error, /expired/);
  assert.throws(() => sound.control(allowed, 2701), /expired/);
  const late = core(); assert.throws(() => late.control(allowed, 2000), /expired/);
});

test('bad ordering, format, overflow and EOF never partially append or fabricate samples', () => {
  for (const mutate of [s => s.append(pcm([1]), 1), s => s.append(new Uint8Array(1), 0),
    s => s.append(pcm([1, 2, 3]), 0), s => s.end(1)]) {
    const sound = core({capacityFrames: 2});
    assert.throws(() => mutate(sound)); assert.equal(sound.receivedFrames, 0);
    assert.equal(sound.state, 'error'); assert.ok(render(sound, 3).outputs[0].every(x => x === 0));
  }
  const limited = core();
  assert.throws(() => limited.append(new Uint8Array((limited.maxFrames + 1) * 2), 0), /limit/);
  assert.equal(limited.receivedFrames, 0);
  assert.equal(PCM_LIMITS.maxBytes, 24000000);
});

test('cancel is idempotent and terminal, with no queued audio escaping', () => {
  const sound = core(); sound.control(allowed, 0); sound.append(pcm([99, 98]), 0);
  sound.stop(); sound.stop();
  assert.ok(render(sound, 20).outputs[0].every(x => x === 0));
  assert.equal(sound.playedFrames, 0); assert.throws(() => sound.append(pcm([1]), 2), /closed/);
});

test('device clock history includes partial-quantum starvation, holds and final tail', () => {
  const history = new PcmClockHistory(4);
  history.push(0, .1, 0, 800, .1);
  history.push(.1, .2, 800, 1000, .125);
  history.push(.2, .3, 1000, 1000, .2);
  history.push(.3, .4, 1000, 1800, .4);
  assert.equal(history.at(.05), 400);
  assert.equal(history.at(.15), 1000);
  assert.equal(history.at(.25), 1000);
  assert.ok(Math.abs(history.at(.35) - 1400) < .0001);
  history.push(.4, .5, 1800, 1800, .4);
  assert.equal(history.at(.6), 1800);
  assert.throws(() => history.push(.45, .6, 1800, 1800, .45), /contiguous/);
});

test('the observed repeated browser quantum preserves all PCM and strict source continuity', () => {
  const rate = 24000, rawFrame = 163456, offset = 161280;
  const clock = new PcmQuantumClock(rate), history = new PcmClockHistory();
  const input = Array.from({length: 384}, (_, i) => (i * 997 % 65536) - 32768);
  const sound = core({sampleRate: rate, nowMs: rawFrame / rate * 1000});
  sound.control(allowed, clock.controlTime(rawFrame) * 1000);
  sound.append(pcm(input), 0); sound.end(input.length);
  const actual = [], segments = [];
  for (const reportedFrame of [rawFrame, rawFrame, rawFrame + 256]) {
    const {outputs, segment} = render(sound, 128, clock.next(reportedFrame, 128));
    actual.push(...outputs[0]); segments.push(segment);
    history.push(segment.start, segment.end, segment.from + offset, segment.to + offset, segment.advancingEnd);
  }
  // These are the exact first offending live trace values. Only context time is
  // remapped; the next source sample still follows 161408 without any gap/repeat.
  assert.equal(segments[0].start, 6.810666666666667);
  assert.equal(segments[0].end, 6.816000000000001);
  assert.equal(segments[1].start, (rawFrame + 128) / rate);
  assert.equal(segments[1].from + offset, 161408);
  assert.equal(segments[1].to + offset, 161536);
  assert.deepEqual(actual, input.map(value => value / 32768));
  assert.equal(sound.playedFrames, input.length); assert.equal(sound.underruns, 0);
  assert.equal(clock.corrections, 1); assert.equal(clock.repeatedQuanta, 1);
  assert.equal(clock.maxLeadFrames, 128); assert.equal(clock.leadFrames, 0);
  assert.equal(history.at(segments[2].end), offset + input.length);
  assert.throws(() => history.push(segments[2].end, segments[2].end + .01,
    offset + input.length + 1, offset + input.length + 2, segments[2].end + .01), /contiguous/);
});

test('quantum corrections do not accumulate an offset after the browser catches up', () => {
  const clock = new PcmQuantumClock(24000);
  const raw = [1024, 1024, 1152, 1408, 1536];
  assert.deepEqual(raw.map(frame => clock.next(frame, 128)), [1024, 1152, 1280, 1408, 1536].map(frame => frame / 24000));
  assert.equal(clock.corrections, 2); assert.equal(clock.repeatedQuanta, 1);
  assert.equal(clock.maxLeadFrames, 128); assert.equal(clock.leadFrames, 0);
  assert.equal(clock.controlTime(1536), 1536 / 24000);
  assert.throws(() => clock.next(1408, 128), error => {
    assert.equal(error.clockDiagnostic.previousRawFrame, 1536);
    assert.equal(error.clockDiagnostic.nextRawFrame, 1408);
    return /regressed/.test(error.message);
  });
});
