import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MistralScheduler, PRIORITY, mistralScheduler, DEFAULT_SPACING_MS, SLOW_SPACING_MS} from './mistral-rate.mjs';
import {fakeClock} from './fixtures/fake-clock.mjs';

// Every wait here runs on a manual clock (bridge/fixtures/fake-clock.mjs): time moves only when a test advances it, so a loaded machine cannot
// change which request starts first or how far apart two starts are.
const withClock = (options = {}, clock = fakeClock()) => ({clock, scheduler: new MistralScheduler({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...options})});
const make = (spacingMs = 40) => withClock({spacingMs});
const headers = values => ({get: name => values[name] ?? null});
const settled = promise => { const state = {done: false}; promise.then(() => { state.done = true; }, () => { state.done = true; }); return state; };

test('by default requests start at once: no spacing, text and speech and text back to back, three together', async () => {
  assert.equal(DEFAULT_SPACING_MS, 0); assert.equal(mistralScheduler.spacingMs, 0);
  const {clock, scheduler} = withClock(), starts = [];
  let running = 0, together = 0;
  const jobs = [PRIORITY.TEXT, PRIORITY.TTS, PRIORITY.TEXT].map(priority =>
    scheduler.schedule(async ({sentAt}) => { starts.push(sentAt); together = Math.max(together, ++running); await clock.sleep(30); running--; }, {priority}));
  await clock.settle();   // no time has passed: all three are already under way
  assert.equal(starts.length, 3, 'all three started with no time passing');
  assert.equal(together, 3, 'three requests ran together');
  assert.equal(new Set(starts).size, 1, `starts were at once: ${starts}`);
  await clock.advance(30); await Promise.all(jobs);
  assert.equal(running, 0);
});

test('with a spacing configured, starts are spaced; a long request does not hold the next one back', async () => {
  const {clock, scheduler} = make(40), starts = [];
  const slow = scheduler.schedule(async ({sentAt}) => { starts.push(sentAt); await clock.sleep(200); return 'slow'; });
  const slowState = settled(slow);
  const next = scheduler.schedule(async ({sentAt}) => { starts.push(sentAt); return 'next'; });
  const third = scheduler.schedule(async ({sentAt}) => { starts.push(sentAt); return 'third'; });
  await clock.advance(39);
  assert.equal(starts.length, 1, 'the second request waits out the spacing');
  await clock.advance(1);
  assert.equal(starts.length, 2, 'and starts when it is over');
  await clock.advance(39);
  assert.equal(starts.length, 2);
  await clock.advance(1);
  assert.equal(starts.length, 3);
  assert.equal(slowState.done, false, 'the second and third started while the first was still running');
  await clock.advance(120);
  assert.deepEqual(await Promise.all([slow, next, third]), ['slow', 'next', 'third']);
  assert.deepEqual([starts[1] - starts[0], starts[2] - starts[1]], [40, 40], `spacing kept: ${starts}`);
});

test('the text reply goes first, then its speech, then background work, whatever the order they were asked in', async () => {
  const {clock, scheduler} = make(40), order = [];
  const first = scheduler.schedule(async () => order.push('occupies the first slot'));
  const background = scheduler.schedule(async () => order.push('background'), {priority: PRIORITY.BACKGROUND});
  const tts = scheduler.schedule(async () => order.push('tts'), {priority: PRIORITY.TTS});
  const text = scheduler.schedule(async () => order.push('text'), {priority: PRIORITY.TEXT});
  const tts2 = scheduler.schedule(async () => order.push('tts 2'), {priority: PRIORITY.TTS});
  await clock.runUntilIdle();
  await Promise.all([first, background, tts, text, tts2]);
  assert.deepEqual(order, ['occupies the first slot', 'text', 'tts', 'tts 2', 'background']);
});

test('a queued request that is aborted never runs and does not disturb the others', async () => {
  const {clock, scheduler} = make(40), ran = [], controller = new AbortController();
  const a = scheduler.schedule(async () => ran.push('a'));
  const b = scheduler.schedule(async () => ran.push('b'), {signal: controller.signal});
  const c = scheduler.schedule(async () => ran.push('c'));
  controller.abort();
  await assert.rejects(b, error => error.name === 'AbortError' || /cancel/i.test(error.message));
  await clock.runUntilIdle();
  await Promise.all([a, c]);
  assert.deepEqual(ran, ['a', 'c']);
  await assert.rejects(scheduler.schedule(async () => 1, {signal: controller.signal}));
});

test('maxQueueMs: a request that waits too long for its turn is rejected and never sent', async () => {
  const {clock, scheduler} = make(200), ran = [];
  const a = scheduler.schedule(async () => ran.push('a'));
  const b = scheduler.schedule(async () => ran.push('b'), {maxQueueMs: 50});
  const bState = settled(b);
  await a;
  await clock.advance(49);
  assert.equal(bState.done, false, 'still within its 50 ms');
  await clock.advance(1);
  assert.equal(bState.done, true, 'rejected the moment its 50 ms were up, long before its turn at 200 ms');
  await assert.rejects(b, {code: 'queue-timeout'});
  await clock.advance(250);
  assert.deepEqual(ran, ['a']);
});

test('the task is handed the moment it was sent, not the moment it was queued', async () => {
  const {clock, scheduler} = make(80);
  await scheduler.schedule(async () => {});
  const queued = clock.now();
  const handed = scheduler.schedule(async ({sentAt}) => sentAt);
  await clock.runUntilIdle();
  const sent = await handed;
  assert.equal(sent, queued + 80, `sent ${sent - queued} ms after queueing`);
  assert.equal(clock.now(), sent);
});

test('a 429 is retried after retry-after, and nothing else starts meanwhile', async () => {
  const {clock, scheduler} = make(20), log = [];
  let calls = 0;
  const limited = scheduler.schedule(async ({sentAt}) => {
    log.push(['limited', sentAt]);
    if (++calls === 1) throw Object.assign(Error('rate limited'), {status: 429, retryAfterMs: 2500});
    return 'ok';
  }, {retries: 1});
  const other = scheduler.schedule(async ({sentAt}) => { log.push(['other', sentAt]); return 'other'; }, {priority: PRIORITY.TTS});
  await clock.runUntilIdle();
  assert.deepEqual(await Promise.all([limited, other]), ['ok', 'other']);
  assert.deepEqual(log.map(entry => entry[0]), ['limited', 'limited', 'other'], 'the retried text request goes before the speech');
  // (2.5 s: longer than the one second a 429 keeps starts apart anyway, so it is the retry-after that is being waited out)
  assert.ok(log[1][1] - log[0][1] >= 2500, `retried ${log[1][1] - log[0][1]} ms later`);
  assert.ok(log[2][1] >= log[1][1], 'the speech started after the retry');
  assert.ok(scheduler.spacingMs > 20, 'a 429 widens the spacing');
});

test('retries run out, a quota of zero is not retried, and other errors pass straight through', async () => {
  const {clock, scheduler} = make(10);
  let calls = 0;
  const exhausted = assert.rejects(scheduler.schedule(async () => { calls++; throw Object.assign(Error('limit'), {status: 429, retryAfterMs: 5}); }, {retries: 2}), {status: 429});
  await clock.runUntilIdle(); await exhausted;
  assert.equal(calls, 3);
  calls = 0;
  const none = assert.rejects(scheduler.schedule(async () => { calls++; throw Object.assign(Error('none'), {status: 429, zeroQuota: true}); }, {retries: 3}), {zeroQuota: true});
  await clock.runUntilIdle(); await none;
  assert.equal(calls, 1);
  const boom = assert.rejects(scheduler.schedule(async () => { throw Error('boom'); }, {retries: 3}), /boom/);
  await clock.runUntilIdle(); await boom;
});

test('pause() holds every start and then keeps about a second between starts for a minute; a per-second header sets the base spacing', async () => {
  let clock = 1_000_000;
  const scheduler = new MistralScheduler({spacingMs: 0, now: () => clock});
  assert.equal(scheduler.spacingMs, 0);
  scheduler.pause(120);
  assert.equal(scheduler.stats().pausedForMs, 120);
  assert.equal(scheduler.spacingMs, SLOW_SPACING_MS);
  clock += 59_000; assert.equal(scheduler.spacingMs, SLOW_SPACING_MS);
  clock += 2_000; assert.equal(scheduler.spacingMs, 0, 'relaxed after a minute');
  scheduler.noteHeaders(headers({'x-ratelimit-limit-req-second': '2'}));
  assert.equal(scheduler.spacingMs, 525);
  scheduler.noteHeaders(headers({'x-ratelimit-limit-req-second': '1'}));
  assert.equal(scheduler.spacingMs, 1050);
  assert.deepEqual(Object.keys(scheduler.stats()).sort(), ['pausedForMs', 'queued', 'slowForMs', 'spacingMs', 'started']);
  // A pause holds a start until it is over.
  const {clock: held, scheduler: real} = withClock();
  real.pause(120);
  let started = false;
  const job = real.schedule(async () => { started = true; });
  await held.advance(119);
  assert.equal(started, false, 'held for the whole pause');
  await held.advance(1);
  await job;
  assert.equal(started, true);
});

test('per-minute headers change nothing while there is room; a nearly used-up allowance slows starts for a while and room again relaxes them', () => {
  let clock = 0;
  const scheduler = new MistralScheduler({now: () => clock});
  const text = (remaining, limit = 188) => headers({'x-ratelimit-limit-req-minute': String(limit), 'x-ratelimit-remaining-req-minute': String(remaining)});
  scheduler.noteHeaders(text(187));
  assert.equal(scheduler.spacingMs, 0);
  scheduler.noteHeaders(text(100));
  assert.equal(scheduler.spacingMs, 0);
  scheduler.noteHeaders(text(18));
  assert.equal(scheduler.spacingMs, Math.ceil(60_000 / 188 * 1.1), 'an even spread of the allowance over the minute');
  clock += 10_000; scheduler.noteHeaders(text(150));
  assert.equal(scheduler.spacingMs, 0, 'room again');
  scheduler.noteHeaders(text(2, 30));
  assert.ok(scheduler.spacingMs >= 250);
  clock += 31_000;
  assert.equal(scheduler.spacingMs, 0, 'relaxes by itself after 30 s');
  // Another allowance (speech characters) nearly used up: about a second.
  scheduler.noteHeaders(headers({'x-ratelimit-limit-chars-minute': '12000', 'x-ratelimit-remaining-chars-minute': '900'}));
  assert.equal(scheduler.spacingMs, SLOW_SPACING_MS);
});

test('an allowance at 0 pauses starts until Retry-After, and a real Headers object is read the same way', async () => {
  const {clock, scheduler} = withClock();
  scheduler.noteHeaders(new Headers({'x-ratelimit-limit-req-minute': '30', 'x-ratelimit-remaining-req-minute': '0', 'retry-after': '0.1'}));
  assert.equal(scheduler.stats().pausedForMs, 100);
  let started = false;
  const job = scheduler.schedule(async () => { started = true; });
  await clock.advance(99);
  assert.equal(started, false, 'held until the Retry-After is over');
  await clock.advance(1);
  await job;
  assert.equal(started, true);
});

test('while slowed, a reply still goes before speech and background work', async () => {
  const {clock, scheduler} = withClock(), order = [];
  scheduler.pause(60);
  const jobs = [[PRIORITY.BACKGROUND, 'background'], [PRIORITY.TTS, 'tts'], [PRIORITY.TEXT, 'text']].map(([priority, name]) =>
    scheduler.schedule(async () => { order.push(name); }, {priority}));
  await clock.runUntilIdle();
  await Promise.all(jobs);
  assert.deepEqual(order, ['text', 'tts', 'background']);
});

// The tests above run on a manual clock. This one keeps the real clock and the real timers (the defaults of the class) in play, with a lower bound only:
// a busy machine can make the wait longer, never shorter, so it cannot fail for load.
test('with the real clock and timers, a spaced start waits out its spacing and a pause holds a start', async () => {
  const scheduler = new MistralScheduler({spacingMs: 40}), starts = [];
  const jobs = [0, 1].map(() => scheduler.schedule(async ({sentAt}) => { starts.push(sentAt); }));
  await Promise.all(jobs);
  assert.ok(starts[1] - starts[0] >= 38, `spacing kept: ${starts}`);
  const began = performance.now();
  scheduler.pause(60);
  await scheduler.schedule(async () => {});
  assert.ok(performance.now() - began >= 55, 'held for the pause');
});
