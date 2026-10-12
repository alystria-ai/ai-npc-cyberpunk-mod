import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MistralScheduler, PRIORITY, mistralScheduler, DEFAULT_SPACING_MS, SLOW_SPACING_MS} from './mistral-rate.mjs';

const wait = ms => new Promise(done => setTimeout(done, ms));
const make = (spacingMs = 40) => new MistralScheduler({spacingMs});
const headers = values => ({get: name => values[name] ?? null});

test('by default requests start at once: no spacing, text and speech and text back to back, three together', async () => {
  assert.equal(DEFAULT_SPACING_MS, 0); assert.equal(mistralScheduler.spacingMs, 0);
  const scheduler = new MistralScheduler(), starts = [], begin = performance.now();
  await Promise.all([PRIORITY.TEXT, PRIORITY.TTS, PRIORITY.TEXT].map(priority =>
    scheduler.schedule(async ({sentAt}) => { starts.push(sentAt); await wait(30); }, {priority})));
  assert.ok(performance.now() - begin < 120, 'three requests ran together');
  assert.ok(Math.max(...starts) - Math.min(...starts) < 20, `starts were at once: ${starts}`);
});

test('with a spacing configured, starts are spaced; a long request does not hold the next one back', async () => {
  const scheduler = make(40), starts = [];
  const slow = scheduler.schedule(async ({sentAt}) => { starts.push(sentAt); await wait(200); return 'slow'; });
  const next = scheduler.schedule(async ({sentAt}) => { starts.push(sentAt); return 'next'; });
  const third = scheduler.schedule(async ({sentAt}) => { starts.push(sentAt); return 'third'; });
  assert.deepEqual(await Promise.all([slow, next, third]), ['slow', 'next', 'third']);
  assert.ok(starts[1] - starts[0] >= 38 && starts[2] - starts[1] >= 38, `spacing kept: ${starts}`);
  assert.ok(starts[2] - starts[0] < 200, 'the second and third started while the first was still running');
});

test('the text reply goes first, then its speech, then background work, whatever the order they were asked in', async () => {
  const scheduler = make(40), order = [];
  const first = scheduler.schedule(async () => order.push('occupies the first slot'));
  const background = scheduler.schedule(async () => order.push('background'), {priority: PRIORITY.BACKGROUND});
  const tts = scheduler.schedule(async () => order.push('tts'), {priority: PRIORITY.TTS});
  const text = scheduler.schedule(async () => order.push('text'), {priority: PRIORITY.TEXT});
  const tts2 = scheduler.schedule(async () => order.push('tts 2'), {priority: PRIORITY.TTS});
  await Promise.all([first, background, tts, text, tts2]);
  assert.deepEqual(order, ['occupies the first slot', 'text', 'tts', 'tts 2', 'background']);
});

test('a queued request that is aborted never runs and does not disturb the others', async () => {
  const scheduler = make(40), ran = [], controller = new AbortController();
  const a = scheduler.schedule(async () => ran.push('a'));
  const b = scheduler.schedule(async () => ran.push('b'), {signal: controller.signal});
  const c = scheduler.schedule(async () => ran.push('c'));
  controller.abort();
  await assert.rejects(b, error => error.name === 'AbortError' || /cancel/i.test(error.message));
  await Promise.all([a, c]);
  assert.deepEqual(ran, ['a', 'c']);
  await assert.rejects(scheduler.schedule(async () => 1, {signal: controller.signal}));
});

test('maxQueueMs: a request that waits too long for its turn is rejected and never sent', async () => {
  const scheduler = make(200), ran = [];
  const a = scheduler.schedule(async () => ran.push('a'));
  const b = scheduler.schedule(async () => ran.push('b'), {maxQueueMs: 50});
  await a;
  await assert.rejects(b, {code: 'queue-timeout'});
  await wait(250);
  assert.deepEqual(ran, ['a']);
});

test('the task is handed the moment it was sent, not the moment it was queued', async () => {
  const scheduler = make(80);
  await scheduler.schedule(async () => {});
  const queued = Date.now();
  const sent = await scheduler.schedule(async ({sentAt}) => sentAt);
  assert.ok(sent - queued >= 60, `sent ${Math.round(sent - queued)} ms after queueing`);
});

test('a 429 is retried after retry-after, and nothing else starts meanwhile', async () => {
  const scheduler = make(20), log = [];
  let calls = 0;
  const limited = scheduler.schedule(async ({sentAt}) => {
    log.push(['limited', sentAt]);
    if (++calls === 1) throw Object.assign(Error('rate limited'), {status: 429, retryAfterMs: 150});
    return 'ok';
  }, {retries: 1});
  const other = scheduler.schedule(async ({sentAt}) => { log.push(['other', sentAt]); return 'other'; }, {priority: PRIORITY.TTS});
  assert.deepEqual(await Promise.all([limited, other]), ['ok', 'other']);
  assert.deepEqual(log.map(entry => entry[0]), ['limited', 'limited', 'other'], 'the retried text request goes before the speech');
  assert.ok(log[1][1] - log[0][1] >= 145, `retried ${Math.round(log[1][1] - log[0][1])} ms later`);
  assert.ok(scheduler.spacingMs > 20, 'a 429 widens the spacing');
});

test('retries run out, a quota of zero is not retried, and other errors pass straight through', async () => {
  const scheduler = make(10);
  let calls = 0;
  await assert.rejects(scheduler.schedule(async () => { calls++; throw Object.assign(Error('limit'), {status: 429, retryAfterMs: 5}); }, {retries: 2}), {status: 429});
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(scheduler.schedule(async () => { calls++; throw Object.assign(Error('none'), {status: 429, zeroQuota: true}); }, {retries: 3}), {zeroQuota: true});
  assert.equal(calls, 1);
  await assert.rejects(scheduler.schedule(async () => { throw Error('boom'); }, {retries: 3}), /boom/);
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
  // A real pause holds a start.
  const real = new MistralScheduler(), begin = performance.now();
  real.pause(120);
  await real.schedule(async () => {});
  assert.ok(performance.now() - begin >= 115);
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
  const scheduler = new MistralScheduler();
  scheduler.noteHeaders(new Headers({'x-ratelimit-limit-req-minute': '30', 'x-ratelimit-remaining-req-minute': '0', 'retry-after': '0.1'}));
  assert.ok(scheduler.stats().pausedForMs > 50 && scheduler.stats().pausedForMs <= 100);
  const begin = performance.now();
  await scheduler.schedule(async () => {});
  assert.ok(performance.now() - begin >= 90);
});

test('while slowed, a reply still goes before speech and background work', async () => {
  const scheduler = new MistralScheduler(), order = [];
  scheduler.pause(60);
  const jobs = [[PRIORITY.BACKGROUND, 'background'], [PRIORITY.TTS, 'tts'], [PRIORITY.TEXT, 'text']].map(([priority, name]) =>
    scheduler.schedule(async () => { order.push(name); }, {priority}));
  await Promise.all(jobs);
  assert.deepEqual(order, ['text', 'tts', 'background']);
});
