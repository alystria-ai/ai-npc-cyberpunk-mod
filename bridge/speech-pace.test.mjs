import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SpeechPace} from './speech-pace.mjs';

test('the lead follows how slowly a broken line was produced, and the wait limit follows the lead', () => {
  const pace = new SpeechPace();
  assert.equal(pace.lead, 0); assert.equal(pace.holds(0, 0), false);
  // Without a measure the old fixed lead applies.
  pace.note(2); assert.equal(pace.lead, 1.2); assert.equal(pace.waitMs, 1500);
  // 9 s of audio that took 22.5 s to play: produced at 0.4x real time.
  pace.note(17, {seconds: 9, playedMs: 22_500});
  assert.ok(Math.abs(pace.speed - .4) < 1e-9);
  assert.ok(Math.abs(pace.lead - 1.92) < 1e-9, `lead ${pace.lead}`);
  assert.equal(pace.waitMs, 3000, 'capped');
  assert.equal(pace.holds(1.0, 2000), true); assert.equal(pace.holds(2.0, 2000), false); assert.equal(pace.holds(1.0, 3000), false);
  assert.equal(pace.holds(0.5, 100, {complete: true}), false, 'a finished stream never waits');
});

test('a line that broke slightly keeps a short lead, the slowest recent line counts, and whole lines end it', () => {
  const pace = new SpeechPace({keep: 3});
  pace.note(1, {seconds: 10, playedMs: 11_000});
  assert.ok(pace.lead > 1.2 && pace.lead < 1.35);
  pace.note(3, {seconds: 10, playedMs: 40_000}); assert.ok(Math.abs(pace.lead - 2.1) < 1e-9);
  pace.note(0); pace.note(0); assert.ok(pace.lead > 0, 'the slow line is still one of the last three');
  pace.note(0); assert.equal(pace.lead, 0); assert.equal(pace.speed, null);
});

test('lines too short or too fast to measure, and bad input, change nothing but the count', () => {
  const pace = new SpeechPace();
  pace.note(1, {seconds: .5, playedMs: 5000}); assert.equal(pace.speed, null); assert.equal(pace.lead, 1.2);
  pace.note(-1); pace.note(1.5); pace.note('x'); assert.equal(pace.history.length, 1);
  const quick = new SpeechPace(); quick.note(1, {seconds: 5, playedMs: 4000}); assert.equal(quick.speed, null);
});
