import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TurnClock, STAGES, markStage, withClock, currentClock} from './turn-clock.mjs';

const fakeNow = start => { let value = start; const now = () => value; now.advance = ms => { value += ms; }; return now; };

test('a snapshot lists the marks after the origin, in time order, with steps that add up to the whole', () => {
  const now = fakeNow(10_000);
  const clock = new TurnClock({origin: 10_000, now});
  clock.mark('inputWritten', 9_970);
  clock.mark('received');
  now.advance(90); clock.mark('knowledge');
  now.advance(70); clock.mark('transport');
  now.advance(1800); clock.mark('fullText');
  now.advance(1600); clock.mark('ttsSent');
  const snap = clock.snapshot();
  assert.deepEqual(snap.order, ['inputWritten', 'received', 'knowledge', 'transport', 'fullText', 'ttsSent']);
  assert.equal(snap.marks.inputWritten, -30);
  assert.equal(snap.marks.received, 0);
  assert.equal(snap.marks.ttsSent, 3560);
  assert.equal(snap.steps.length, 5);
  assert.equal(snap.steps.reduce((sum, step) => sum + step.ms, 0), snap.totalMs);
  assert.deepEqual(snap.steps.at(-1), {from: 'fullText', to: 'ttsSent', ms: 1600});
  assert.equal(snap.totalMs, 3590);
});

test('the first mark of a name wins, remark replaces it, and a mark with an explicit time uses it', () => {
  const now = fakeNow(0);
  const clock = new TurnClock({origin: 0, now});
  now.advance(5); clock.mark('firstToken');
  now.advance(5); clock.mark('firstToken');
  assert.equal(clock.at('firstToken'), 5);
  clock.remark('firstToken');
  assert.equal(clock.at('firstToken'), 10);
  clock.mark('published', 77);
  assert.equal(clock.at('published'), 77);
  assert.equal(clock.mark('published', 99), 77);
});

test('markStage reaches the clock of the running turn only and is harmless without one', async () => {
  assert.equal(markStage('llmSent'), undefined);
  assert.equal(currentClock(), undefined);
  const first = new TurnClock({origin: 0, now: () => 1}), second = new TurnClock({origin: 0, now: () => 2});
  await Promise.all([
    withClock(first, async () => { await Promise.resolve(); markStage('llmSent'); await new Promise(done => setTimeout(done, 5)); markStage('fullText'); }),
    withClock(second, async () => { markStage('llmSent'); }),
  ]);
  assert.equal(first.at('llmSent'), 1);
  assert.equal(first.at('fullText'), 1);
  assert.equal(second.at('llmSent'), 2);
  assert.equal(second.has('fullText'), false);
});

test('the stall watcher records a blocked event loop and stops by itself', async () => {
  const clock = new TurnClock();
  clock.watch({intervalMs: 5, minMs: 40, maxMs: 300});
  await new Promise(done => setTimeout(done, 20));
  const until = performance.now() + 120;
  while (performance.now() < until) { /* block the loop */ }
  await new Promise(done => setTimeout(done, 30));
  clock.stop();
  const stalls = clock.snapshot().stalls;
  assert.ok(stalls?.length >= 1, 'a stall was recorded');
  // A busy machine adds stalls of its own (the watcher is meant to see those too): the first one recorded can be one of them (46 and 57 ms were seen).
  // The busy loop cannot be shorter than it ran, so the longest stall is the one it made.
  const longest = Math.max(...stalls.map(stall => stall.ms));
  assert.ok(longest >= 60, `the stall was about 120 ms (${stalls.map(stall => stall.ms)})`);
  assert.equal(clock.watching, null);
});

test('the stage list names every stage once', () => {
  assert.equal(new Set(STAGES).size, STAGES.length);
  assert.ok(STAGES.indexOf('received') < STAGES.indexOf('published'));
});
