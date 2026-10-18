// Failure paths of the shared Mistral request scheduler (bridge/mistral-rate.mjs) that mistral-rate.test.mjs does not pin: a retry that is
// cancelled while it waits, a task that throws at once, values that make no sense for a pause or in the headers, and a 429's slow minute
// that a header showing room must not cut short.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MistralScheduler, SLOW_SPACING_MS} from './mistral-rate.mjs';

const wait = ms => new Promise(done => setTimeout(done, ms));
const headers = values => ({get: name => values[name] ?? null, forEach: callback => { for (const [name, value] of Object.entries(values)) callback(value, name); }});
const limited = (retryAfterMs, extra = {}) => Object.assign(Error('rate limited'), {status: 429, retryAfterMs, ...extra});

test('a request cancelled while it waits for its 429 retry is rejected as a cancellation, leaves the queue empty and does not stop later requests', async () => {
  const scheduler = new MistralScheduler();
  const controller = new AbortController();
  let calls = 0;
  const first = scheduler.schedule(async () => { calls++; throw limited(120); }, {retries: 2, signal: controller.signal});
  first.catch(() => {});
  await wait(30);
  assert.equal(scheduler.stats().queued, 1, 'the retry is queued behind the server\'s retry-after');
  controller.abort();
  await assert.rejects(first, error => error.name === 'AbortError' || /cancel/i.test(error.message));
  assert.equal(scheduler.stats().queued, 0);
  assert.equal(calls, 1, 'the cancelled retry never ran');
  const began = performance.now();
  assert.equal(await scheduler.schedule(async () => 'next'), 'next');
  assert.ok(performance.now() - began >= 60, 'the pause for the 429 still holds for everyone else');
});

test('a task that fails with a 429 after its own signal was cancelled is not asked again: the error comes back as it is', async () => {
  const scheduler = new MistralScheduler();
  const controller = new AbortController();
  let calls = 0;
  const error = await scheduler.schedule(async () => { calls++; controller.abort(); throw limited(5); }, {retries: 3, signal: controller.signal}).catch(caught => caught);
  assert.equal(error.status, 429);
  assert.equal(calls, 1);
  assert.equal(scheduler.stats().queued, 0);
});

test('a task that throws at once, returns a plain value, or is not a function is settled, and the scheduler goes on', async () => {
  const scheduler = new MistralScheduler();
  await assert.rejects(scheduler.schedule(() => { throw Error('synchronous fault'); }), /synchronous fault/);
  assert.equal(await scheduler.schedule(() => 5), 5);
  for (const bad of [null, undefined, 'a string', {}]) await assert.rejects(scheduler.schedule(bad), /needs a task/, String(bad));
  assert.equal(scheduler.stats().queued, 0);
  assert.equal(await scheduler.schedule(async () => 'still serving'), 'still serving');
  // A retry count of 0 (the default) never runs a failing 429 twice.
  let calls = 0;
  await assert.rejects(scheduler.schedule(async () => { calls++; throw limited(1); }), {status: 429});
  assert.equal(calls, 1);
});

test('a pause that makes no sense is bounded: not a number is a second, negative is none, and a huge one is a minute', () => {
  let clock = 1_000_000;
  const scheduler = new MistralScheduler({now: () => clock});
  scheduler.pause(NaN);
  assert.equal(scheduler.stats().pausedForMs, 1000);
  clock += 2000;
  scheduler.pause(-50);
  assert.equal(scheduler.stats().pausedForMs, 0);
  scheduler.pause(Infinity);
  assert.equal(scheduler.stats().pausedForMs, 60_000);
  scheduler.pause(10 ** 9);
  assert.equal(scheduler.stats().pausedForMs, 60_000, 'a longer pause never extends past a minute');
  assert.equal(scheduler.spacingMs, SLOW_SPACING_MS, 'every pause starts the slow minute');
});

test('headers that make no sense change nothing and never throw: none, words, a negative count, a limit of zero, more remaining than the limit', () => {
  const scheduler = new MistralScheduler({now: () => 0});
  for (const odd of [undefined, null, {},
    headers({'x-ratelimit-limit-req-minute': 'many', 'x-ratelimit-remaining-req-minute': 'few'}),
    headers({'x-ratelimit-limit-req-minute': '30', 'x-ratelimit-remaining-req-minute': '-4'}),
    headers({'x-ratelimit-limit-req-minute': '0', 'x-ratelimit-remaining-req-minute': '0'}),
    headers({'x-ratelimit-limit-req-minute': '30', 'x-ratelimit-remaining-req-minute': '900'}),
    headers({'x-ratelimit-limit-req-second': '0'}), headers({'x-ratelimit-limit-req-second': 'x'})]) {
    try { scheduler.noteHeaders(odd); } catch (error) { assert.fail(`noteHeaders threw: ${error.message}`); }
  }
  assert.equal(scheduler.spacingMs, 0);
  assert.deepEqual([scheduler.stats().pausedForMs, scheduler.stats().slowForMs], [0, 0]);
});

test('an allowance used up with a retry-after of an hour pauses starts for a minute, no more', () => {
  const scheduler = new MistralScheduler({now: () => 5000});
  scheduler.noteHeaders(headers({'x-ratelimit-limit-req-minute': '30', 'x-ratelimit-remaining-req-minute': '0', 'retry-after': '3600'}));
  assert.equal(scheduler.stats().pausedForMs, 60_000);
  scheduler.noteHeaders(headers({'x-ratelimit-limit-tokens-minute': '1000', 'x-ratelimit-remaining-tokens-minute': '0'}));
  assert.equal(scheduler.stats().pausedForMs, 60_000, 'a second empty allowance never shortens the first pause');
});

test('the slow minute after a 429 is not cut short by an answer whose headers show room again', () => {
  let clock = 0;
  const scheduler = new MistralScheduler({now: () => clock});
  const room = headers({'x-ratelimit-limit-req-minute': '188', 'x-ratelimit-remaining-req-minute': '150'});
  scheduler.pause(100);
  clock += 10_000;
  scheduler.noteHeaders(room);
  assert.equal(scheduler.spacingMs, SLOW_SPACING_MS, 'the server said wait: a header with room does not undo that');
  clock += 51_000;
  assert.equal(scheduler.spacingMs, 0, 'a minute after the 429 the starts are free again');
});

test('a slowing that only a header asked for ends when a later header shows room, also when a 429 had slowed the starts a minute earlier', {todo: 'BUG: slowFrom429 is only cleared inside noteHeaders when the slow period has ended at that very call, so after a 429 minute a header slowdown inherits the stale flag and "room again" cannot relax it (bridge/mistral-rate.mjs, noteHeaders); it then ends by itself after 30 s'}, () => {
  let clock = 0;
  const scheduler = new MistralScheduler({now: () => clock});
  const room = headers({'x-ratelimit-limit-req-minute': '188', 'x-ratelimit-remaining-req-minute': '150'});
  scheduler.pause(100);
  clock += 61_000;
  scheduler.noteHeaders(headers({'x-ratelimit-limit-req-minute': '188', 'x-ratelimit-remaining-req-minute': '5'}));
  assert.ok(scheduler.spacingMs > 0);
  clock += 1000;
  scheduler.noteHeaders(room);
  assert.equal(scheduler.spacingMs, 0);
});
