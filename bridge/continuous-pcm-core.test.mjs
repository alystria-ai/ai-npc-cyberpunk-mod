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

test('standby is silent with no lease for a slow provider, admits nothing, and takes no audio', () => {
  const sound = core({standby: true});
  // Far past both the 500 ms hold and the 2 s expiry, up to the 70 s standby ceiling.
  for (const seconds of [0, .6, 2.5, 30, 69]) {
    const {outputs} = render(sound, 4, seconds, seconds * 1000);
    assert.equal(sound.state, 'standby'); assert.equal(sound.error, null); assert.deepEqual([...outputs[0]], [0, 0, 0, 0]);
  }
  // An allowing control cannot admit it, hold() is a no-op, and invalid controls are still rejected.
  sound.control(allowed, 69000); sound.hold();
  assert.equal(sound.allow, false); assert.equal(sound.externalHold, false);
  assert.throws(() => sound.control({allow: 'yes', paused: false}, 69001), /Invalid playback admission/);
  assert.throws(() => sound.append(pcm([1, 2, 3]), 0), /before the stream was armed/);
  assert.equal(sound.state, 'error'); assert.equal(sound.stopped, true);
  assert.equal(sound.receivedFrames, 0);
});

test('arming ends standby: the ordinary 2s lease starts then and still needs an allowing control', () => {
  const sound = core({standby: true}); render(sound, 4, 40, 40000);
  sound.arm(40000); assert.equal(sound.standby, false); assert.equal(sound.state, 'awaiting-admission');
  sound.append(pcm([42, 43, 44]), 0);
  render(sound, 1, 40.1, 40100); assert.equal(sound.playedFrames, 0, 'arming alone admits nothing');
  sound.control(allowed, 40200);
  assert.equal(render(sound, 1, 40.2, 40200).outputs[0][0], 42 / 32768);
  render(sound, 1, 42.3, 42300); assert.equal(sound.state, 'error'); assert.match(sound.error, /expired/);
  assert.throws(() => sound.arm(50000), /expired/); // an expired stream cannot be revived
  assert.equal(sound.state, 'error');
  const late = core({standby: true, nowMs: 5000});
  assert.throws(() => late.arm(4000), /clock regressed/);
  const plain = core(); plain.arm(1); assert.equal(plain.state, 'awaiting-admission');
  const stopped = core({standby: true}); stopped.stop();
  assert.throws(() => stopped.arm(0), /closed/);
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

// 2026-10-22 review: 59 of 62 "the voice broke" lines were Pocket on a busy CPU, which refilled the start's 0.4 s every time (17 breaks in 30 s).
const slow = (options = {}) => new ContinuousPcmCore({sampleRate: 8000, channels: 1, startupSeconds: .4, ...options});
const breakOnce = (sound, at) => { // plays what is buffered and runs dry
  let guard = 0; while (sound.bufferedFrames > 0 && guard++ < 10000) render(sound, 128, undefined, at);
  render(sound, 128, undefined, at); // the render that finds nothing left
};
test('each break of a line asks for a bigger refill before the voice plays on (0.4 -> 0.8 -> 1.6 -> 3.2 -> 4 s), and a line that never breaks keeps the start\'s 0.4 s', () => {
  const sound = slow(), second = 8000; sound.control(allowed, 0);
  let offset = 0; const give = frames => { sound.append(pcm(Array(frames).fill(7)), offset); offset += frames; };
  give(3200); render(sound, 128, undefined, 0); assert.equal(sound.snapshot().refillSeconds, .4, 'no break, no growth');
  const targets = [];
  for (let step = 0; step < 5; step++) {
    breakOnce(sound, 1);
    targets.push(sound.snapshot().refillSeconds);
    // One start's worth is no longer enough to play on.
    const before = sound.playedFrames; give(3200); render(sound, 128, undefined, 1);
    if (step < 4) assert.equal(sound.playedFrames, before, `refill ${step + 1} waits for more than 0.4 s`);
    give(40000); // plenty: it plays on again
    render(sound, 128, undefined, 1); assert.ok(sound.playedFrames > before);
  }
  assert.deepEqual(targets, [.8, 1.6, 3.2, 4, 4]); assert.equal(sound.underruns, 5); assert.ok(second > 0);
});

test('a refill is sized from the measured arrival speed: audio arriving at 0.05x real time asks for the carry time of one refill at once', () => {
  const sound = slow(); sound.control(allowed, 0);
  sound.append(pcm(Array(3200).fill(1)), 0, 0);        // 0.4 s of audio at t = 0
  sound.append(pcm(Array(800).fill(1)), 3200, 1900);   // only 0.1 s more after 1.9 s
  assert.ok(Math.abs(sound.arrivalSpeed() - 0.1 / 1.9) < 1e-9);
  sound.control(allowed, 1900); render(sound, 128, undefined, 1900); breakOnce(sound, 1900);
  assert.equal(sound.underruns, 1);
  const seconds = sound.snapshot().refillSeconds;
  assert.ok(seconds > 2.3 && seconds < 2.4, `the refill is ${seconds} s`); // 2.5 s x (1 - 0.0526)
});

test('audio arriving faster than it plays measures as such and grows the refill only by doubling', () => {
  const sound = slow(); sound.control(allowed, 0);
  sound.append(pcm(Array(3200).fill(1)), 0, 0); sound.append(pcm(Array(16000).fill(1)), 3200, 1000);
  assert.equal(sound.arrivalSpeed(), 2);
  sound.control(allowed, 1000); render(sound, 128, undefined, 1000); breakOnce(sound, 1000); assert.equal(sound.snapshot().refillSeconds, .8);
  assert.equal(slow().arrivalSpeed(), null, 'nothing to measure before a second packet');
});

test('a refill never waits longer than refillWaitMs once the amount of the start is there', () => {
  const sound = slow(); sound.control(allowed, 0);
  sound.append(pcm(Array(3200).fill(1)), 0, 0); render(sound, 128, undefined, 0); sound.control(allowed, 100); breakOnce(sound, 100);
  sound.append(pcm(Array(3200).fill(2)), sound.receivedFrames, 200);   // the start's 0.4 s, but the refill asks for 0.8 s
  const before = sound.playedFrames; let resumedAt = null;
  for (let at = 400; at <= PCM_LIMITS.refillWaitMs + 800 && resumedAt === null; at += 400) {
    sound.control(allowed, at); render(sound, 128, undefined, at);
    if (sound.playedFrames > before) resumedAt = at;
  }
  assert.ok(resumedAt >= PCM_LIMITS.refillWaitMs + 100 && resumedAt <= PCM_LIMITS.refillWaitMs + 500, `resumed on what it had at ${resumedAt} ms`);
});
