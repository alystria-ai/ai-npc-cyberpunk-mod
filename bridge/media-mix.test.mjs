// bridge/media-mix.mjs: the fade, duck and pan maths of the media channel.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MEDIA, clamp, clampFade, clampPan, clampVolume, duckAt, duckTarget, gainAt, panFor, rampTo, secondsOf, startEnvelope, stopPlan} from './media-mix.mjs';

const near = (a, b, message, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} is not ${b}`);

test('clamps: a number is held inside its range and anything else becomes the low end', () => {
  assert.equal(clampVolume(2), 1); assert.equal(clampVolume(-1), 0); assert.equal(clampVolume(0.4), 0.4);
  assert.equal(clampVolume(NaN), 0); assert.equal(clampVolume(undefined), 0); assert.equal(clampVolume('0.5'), 0);
  assert.equal(clampPan(3), 1); assert.equal(clampPan(-3), -1); assert.equal(clampPan(0.25), 0.25);
  assert.equal(clampFade(99), MEDIA.maxFade); assert.equal(clampFade(-2), 0);
  assert.equal(clamp(5, 1, 3), 3);
});

test('a start with no fade is one step at the volume', () => {
  assert.deepEqual(startEnvelope({now: 10, volume: 0.6}), [{time: 10, value: 0.6, ramp: false}]);
  assert.deepEqual(startEnvelope({now: 10, volume: 7, fadeIn: 0.01}), [{time: 10, value: 1, ramp: false}], 'a fade shorter than the click guard is none');
});

test('a fade in rises from silence to the volume in the time asked', () => {
  const points = startEnvelope({now: 5, volume: 0.8, fadeIn: 2});
  assert.deepEqual(points, [{time: 5, value: 0, ramp: false}, {time: 7, value: 0.8, ramp: true}]);
  near(gainAt(points, 5), 0, 'start'); near(gainAt(points, 6), 0.4, 'half way'); near(gainAt(points, 7), 0.8, 'end'); near(gainAt(points, 30), 0.8, 'after');
  near(gainAt(points, 4), 0, 'before the start nothing is heard', 1e-9);
});

test('a one-shot fades out so that it ends at its last sample, and a loop never does', () => {
  const points = startEnvelope({now: 0, volume: 1, fadeIn: 1, fadeOut: 2, duration: 10});
  near(gainAt(points, 5), 1, 'the middle'); near(gainAt(points, 9), 0.5, 'one second into the fade out'); near(gainAt(points, 10), 0, 'the last sample');
  const loop = startEnvelope({now: 0, volume: 1, fadeOut: 2, duration: 10, loop: true});
  assert.deepEqual(loop, [{time: 0, value: 1, ramp: false}], 'a loop has no end to fade into');
  const short = startEnvelope({now: 0, volume: 1, fadeOut: 5, duration: 2});
  near(gainAt(short, 1), 0.5, 'a fade out longer than the sound starts at its start');
  assert.deepEqual(startEnvelope({now: 0, volume: 1, fadeOut: 2, duration: null}), [{time: 0, value: 1, ramp: false}], 'a length not known: no fade out');
});

test('a fade goes from where the sound is to the target, never shorter than the click guard', () => {
  const points = rampTo({now: 3, current: 0.5, target: 0.1, seconds: 4});
  near(gainAt(points, 3), 0.5, 'from the current level'); near(gainAt(points, 5), 0.3, 'half way'); near(gainAt(points, 7), 0.1, 'to the target');
  assert.equal(rampTo({now: 0, current: 1, target: 0, seconds: 0})[1].time, MEDIA.minFade);
  assert.equal(rampTo({now: 0, current: 1, target: 0, seconds: 99})[1].time, MEDIA.maxFade);
  assert.equal(rampTo({now: 0, current: 4, target: 9, seconds: 1})[0].value, 1, 'a level is a gain, held at 1');
});

test('a stop fades to silence and says when the source may be stopped', () => {
  const plan = stopPlan({now: 20, current: 0.8, fadeOut: 2});
  assert.equal(plan.stopAt, 22);
  near(gainAt(plan.points, 21), 0.4, 'half way down'); near(gainAt(plan.points, 22), 0, 'silent at the stop');
  assert.equal(stopPlan({now: 0, current: 1, fadeOut: 0}).stopAt, MEDIA.minFade, 'even a stop with no fade is not a click');
});

test('ducking: under speech the bed falls to the duck gain within the attack time, and comes back within the release time', () => {
  const down = duckTarget(true), up = duckTarget(false);
  assert.equal(down.target, MEDIA.duckGain); assert.equal(up.target, 1);
  // after the attack time the bed has covered 95 percent of the way down (a time constant is a third of it)
  const reached = duckAt(1, down.target, down.timeConstant, MEDIA.duckAttack);
  assert.ok(reached - down.target < 0.06 * (1 - down.target), `after the attack: ${reached}`);
  near(duckAt(1, down.target, down.timeConstant, 0), 1, 'no change at once');
  const back = duckAt(down.target, 1, up.timeConstant, MEDIA.duckRelease);
  assert.ok(1 - back < 0.06 * (1 - down.target), `after the release: ${back}`);
  assert.ok(MEDIA.duckAttack < MEDIA.duckRelease, 'down quickly, up slowly');
  assert.ok(MEDIA.duckGain > 0 && MEDIA.duckGain < 0.5, 'clearly lower, not silent');
});

test('pan: only a copy takes the game\'s pan, everything else is centred', () => {
  assert.equal(panFor('copy', -0.7), -0.7); assert.equal(panFor('copy', 5), 1); assert.equal(panFor('copy', undefined), 0, 'no lease pan: flat');
  assert.equal(panFor('copy', NaN), 0);
  for (const at of ['v', 'bed', 'place:motel', undefined]) assert.equal(panFor(at, 0.9), 0, String(at));
});

test('gainAt reads step and ramp points the way Web Audio does', () => {
  const points = [{time: 1, value: 0.2, ramp: false}, {time: 3, value: 1, ramp: true}, {time: 4, value: 0.5, ramp: false}];
  near(gainAt(points, 0, 0.9), 0.9, 'before the first point: the initial value'); near(gainAt(points, 1), 0.2, 'a step'); near(gainAt(points, 2), 0.6, 'a ramp');
  near(gainAt(points, 3.5), 1, 'held after a ramp'); near(gainAt(points, 4), 0.5, 'the next step');
  assert.equal(gainAt([], 5, 0.3), 0.3);
});

test('seconds of a sound', () => { assert.equal(secondsOf(96000), 2); assert.equal(secondsOf(24000, 24000), 1); });
