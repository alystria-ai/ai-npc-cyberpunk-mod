import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runwayMs, RUNWAY_MAX_MS, RUNWAY_MIN_MS} from './omni-runway.mjs';
import {SpeechPace} from './speech-pace.mjs';

const chars = count => 'x'.repeat(count);

test('a reply with nothing more to render, or whose rest is ready before the first part has played, is not held', () => {
  assert.equal(runwayMs({renderMs: 1500, firstSeconds: 3, firstChars: 40, later: []}), 0);
  // 3 s of speech played while a 23-word rest (about 7 s of speech) takes 2 s to render: it is ready in time.
  assert.equal(runwayMs({renderMs: 1500, firstSeconds: 3.5, firstChars: 60, later: [chars(120)]}), 0);
  assert.equal(runwayMs({renderMs: 0, firstSeconds: 3, firstChars: 40, later: [chars(100)]}), 0, 'no measurement, no hold');
  assert.equal(runwayMs({renderMs: 1500, firstSeconds: 0, firstChars: 40, later: [chars(100)]}), 0);
});

test('a short first part and a long rest hold the first sound by the shortfall, never more than the limit', () => {
  // 1.3 s of speech (21 chars); the rest, 100 chars, renders in about 1.9 s on a GPU that took 1.7 s for the first part: it is 0.6 s late.
  const late = runwayMs({renderMs: 1700, firstSeconds: 1.3, firstChars: 21, later: [chars(100)]});
  assert.ok(late >= 400 && late <= 1100, `${late} ms`);
  // The slower the GPU, the longer the hold, up to the limit.
  const slow = runwayMs({renderMs: 3500, firstSeconds: 1.3, firstChars: 21, later: [chars(100)]});
  assert.ok(slow > late); assert.equal(slow, RUNWAY_MAX_MS);
  // Small shortfalls are not worth a delay.
  const near = runwayMs({renderMs: 900, firstSeconds: 1.3, firstChars: 21, later: [chars(21)]});
  assert.ok(near === 0 || near >= RUNWAY_MIN_MS);
});

test('every later phrase is checked, the queue is serial: two renders behind a short first part add up', () => {
  const one = runwayMs({renderMs: 1500, firstSeconds: 2, firstChars: 30, later: [chars(60)]});
  const two = runwayMs({renderMs: 1500, firstSeconds: 2, firstChars: 30, later: [chars(60), chars(60)]});
  assert.ok(two >= one);
});

test('the pace holds the first sound for the runway, then lets go; a complete reply is never held', () => {
  const pace = new SpeechPace();
  assert.equal(pace.holds(0.5, 0), false, 'nothing set: no hold (and no broken line behind it)');
  pace.runwayMs = 800;
  assert.equal(pace.holds(0.5, 100), true);
  assert.equal(pace.holds(5, 799), true, 'buffered audio does not end the hold: the rest is what is awaited');
  assert.equal(pace.holds(0.5, 800), false);
  assert.equal(pace.holds(0.5, 100, {complete: true}), false);
  pace.runwayMs = 0;
  assert.equal(pace.holds(0.5, 100), false);
});
