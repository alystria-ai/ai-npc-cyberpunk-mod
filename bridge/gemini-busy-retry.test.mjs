// Google Gemini "busy" answers (docs/GEMINI.md, "Busy answers"): an overloaded or busy answer from Google (HTTP 503 UNAVAILABLE, 500 INTERNAL, a 429 RESOURCE_EXHAUSTED that names no quota, a
// body that says the model is overloaded) is asked again in the same turn after 1 s and then 2 s, at most twice, inside about 8 s and never past the turn's deadline, sharing the hedge's one
// extra request. Quota, key, region and model answers keep their immediate notices. Against a fake fetch and a hand-moved clock: no real network, no real key.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BUSY_BACKOFF_MS, BUSY_WINDOW_MS, hedged} from './hedged-request.mjs';
import {customRoute} from './text-provider-host.mjs';
import {MistralError, errorCodeFor, failureKind, mapFailure, streamChat} from './mistral-client.mjs';

const KEY = 'AQ.' + 'Ab8RN6KjXy_ZqW3-e'.repeat(3).slice(0, 50);
const ORIGIN = 'https://generativelanguage.googleapis.com';
const encoder = new TextEncoder();
const stream = chunks => new ReadableStream({start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); }});
const delta = content => `data: ${JSON.stringify({id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{index: 0, delta: {content}, finish_reason: null}]})}\n\n`;
const answer = (...texts) => ({ok: true, status: 200, headers: new Headers(), body: stream([...texts.map(delta), 'data: [DONE]\n\n'])});
const refuse = (status, body, headers = {}) => ({ok: false, status, headers: new Headers(headers), json: async () => body});
const google = (code, status, message, details) => [{error: {code, message, status, ...(details ? {details} : {})}}];
const unavailable = () => refuse(503, google(503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.'));
const internal = () => refuse(500, google(500, 'INTERNAL', 'An internal error has occurred. Please retry your request after a brief wait.'));
const exhausted = () => refuse(429, google(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).'));
const quota = (quotaId, retryDelay) => refuse(429, google(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota, please check your plan and billing details.', [
  {'@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId}]},
  {'@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay}]));

// A route on the Gemini name over a fake fetch that answers from a list, one entry per request (a function entry is called with the request). Short real backoffs: the logic is
// the same as with 1 s and 2 s, and the exact waits are tested on a hand-moved clock below.
function rig(plan, {name = 'gemini', retries = 1, busyBackoffMs = [5, 10], hedgeMs = 60_000} = {}) {
  const fetched = [], logs = [], provider = {noteLimit() {}, noteSuccess() {}, limit: null};
  const custom = {origin: ORIGIN, model: 'gemini-flash-lite-latest', key: KEY, ready: true, chatUrl: `${ORIGIN}/v1beta/openai/chat/completions`, local: false};
  const fetchImpl = async (url, init) => {
    fetched.push({url, body: JSON.parse(init.body)});
    const next = plan[Math.min(fetched.length - 1, plan.length - 1)];
    return typeof next === 'function' ? next(init) : next;
  };
  const chat = options => streamChat({...options, fetchImpl, provider: 'custom', apiKey: KEY, endpoint: custom.chatUrl, trustedOrigin: ORIGIN, model: custom.model, retries, backoffMs: [5], firstByteMs: 1000, totalMs: 3000});
  const route = customRoute({provider, custom, name, chat, hedgeMs, busyBackoffMs, log: line => logs.push(line)});
  const pieces = [];
  const ask = () => route.chat({messages: [{role: 'user', content: 'hello'}], onDelta: piece => pieces.push(piece)});
  return {route, fetched, logs, pieces, ask};
}
const busyLines = logs => logs.filter(line => /busy/.test(line));

test('the plan: one second, then two, at most two retries, inside eight seconds', () => {
  assert.deepEqual([...BUSY_BACKOFF_MS], [1000, 2000]);
  assert.equal(BUSY_WINDOW_MS, 8000);
});

test('a 503 UNAVAILABLE "overloaded" is asked again and the turn gets its words; one log line for the retry', async () => {
  const r = rig([unavailable(), answer('Sure, ', 'V.')]);
  const result = await r.ask();
  assert.equal(result.text, 'Sure, V.');
  assert.equal(r.fetched.length, 2);
  assert.deepEqual(r.pieces, ['Sure, ', 'V.']);
  assert.equal(busyLines(r.logs).length, 1, r.logs.join('\n'));
  assert.match(r.logs[0], /^\[TextProvider\] Google Gemini: busy \(HTTP 503\), asking again in 0\.0 s \(retry 1 of 2, /);
});

test('a 500 INTERNAL is asked again', async () => {
  const r = rig([internal(), answer('Fine.')]);
  assert.equal((await r.ask()).text, 'Fine.');
  assert.equal(r.fetched.length, 2);
  assert.match(busyLines(r.logs)[0], /busy \(HTTP 500\)/);
});

test('a 429 RESOURCE_EXHAUSTED that names no quota is Google being busy and is asked again', async () => {
  const r = rig([exhausted(), answer('Yes.')]);
  assert.equal((await r.ask()).text, 'Yes.');
  assert.equal(r.fetched.length, 2);
  assert.match(busyLines(r.logs)[0], /busy \(HTTP 429\)/);
});

test('a body that says the model is overloaded is asked again, on 503 and on other 5xx statuses', async () => {
  for (const [status, text] of [[503, 'The model is overloaded. Please try again later.'], [502, 'Model is overloaded, try again'], [504, 'The service is currently experiencing high demand.']]) {
    const r = rig([refuse(status, google(status, 'UNAVAILABLE', text)), answer('Back.')]);
    assert.equal((await r.ask()).text, 'Back.', String(status));
    assert.equal(r.fetched.length, 2, String(status));
  }
});

test('two busy answers then a good one: two retries, two lines, the third request answers', async () => {
  const r = rig([unavailable(), internal(), answer('Third time.')]);
  assert.equal((await r.ask()).text, 'Third time.');
  assert.equal(r.fetched.length, 3);
  assert.equal(busyLines(r.logs).length, 2, r.logs.join('\n'));
  assert.match(busyLines(r.logs)[0], /retry 1 of 2/); assert.match(busyLines(r.logs)[1], /retry 2 of 2/);
});

test('every try busy: three requests in all, never more, and the call ends with the busy error that the gemini-server notice names', async () => {
  for (const make of [unavailable, internal, exhausted]) {
    const r = rig([make]);
    const error = await r.ask().catch(caught => caught);
    assert.ok(error instanceof MistralError);
    assert.equal(r.fetched.length, 3, 'the first request and two retries');
    assert.equal(busyLines(r.logs).length, 2);
    assert.equal(error.kind, 'network');
    // The route notes the failure the way the host does (tagGemini): the notice is the "busy" one, and the player's limit is not touched.
    r.route.failure(error);
    assert.equal(errorCodeFor(error), 'gemini-server');
  }
});

test('no added delay on success: a good first answer sends one request, logs nothing and sets no retry', async () => {
  const r = rig([answer('Hi.')], {busyBackoffMs: [60_000, 60_000]});
  const began = performance.now();
  assert.equal((await r.ask()).text, 'Hi.');
  assert.ok(performance.now() - began < 1000);
  assert.equal(r.fetched.length, 1); assert.deepEqual(r.logs, []);
});

test('quota, key, region and model answers are not asked again: one request each, no busy line, their own kind', async () => {
  const cases = [
    [quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '37s'), 'daily', 1],
    [quota('GenerateContentInputTokensPerModelPerMinute-FreeTier', '45s'), 'limit', 1],
    [refuse(400, google(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [{'@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID'}])), 'key', 1],
    [refuse(403, google(403, 'PERMISSION_DENIED', 'Your API key was reported as leaked.')), 'key', 1],
    [refuse(400, google(400, 'FAILED_PRECONDITION', 'User location is not supported for the API use.')), 'region', 1],
    [refuse(404, google(404, 'NOT_FOUND', 'models/gemini-old is not found for API version v1beta')), 'model', 1],
    // A plain "exceeded your current quota" with no detail is the player's limit, not Google being busy.
    [refuse(429, google(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota, please check your plan and billing details.')), 'limit', 2],
  ];
  for (const [response, kind, requests] of cases) {
    const r = rig([response]);
    const error = await r.ask().catch(caught => caught);
    assert.equal(error.kind, kind, kind);
    assert.equal(failureKind(error), kind);
    assert.equal(error.busy, undefined, kind);
    assert.equal(r.fetched.length, requests, `${kind}: ${r.fetched.length} requests`);
    assert.equal(busyLines(r.logs).length, 0, kind);
  }
});

test('a 429 quota whose RetryInfo is short is still waited out by the request itself (as before), not by the busy retry', async () => {
  const r = rig([quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '0s'), answer('Ok.')]);
  assert.equal((await r.ask()).text, 'Ok.');
  assert.equal(r.fetched.length, 2);
  assert.equal(busyLines(r.logs).length, 0, 'no busy line: it was the per-minute limit');
});

test('the Custom route does not use the busy retry: its own retry loop answers as it always did', async () => {
  const r = rig([unavailable()], {name: 'custom'});
  const error = await r.ask().catch(caught => caught);
  assert.equal(error.kind, 'network');
  assert.equal(r.fetched.length, 2, 'the request loop\'s one retry, nothing more');
  assert.equal(busyLines(r.logs).length, 0);
});

test('the request loop leaves a busy answer to its caller only when asked to (deferBusy)', async () => {
  const run = (deferBusy) => { let count = 0; return {count: () => count, call: streamChat({apiKey: KEY, endpoint: `${ORIGIN}/v1beta/openai/chat/completions`, trustedOrigin: ORIGIN, provider: 'custom', model: 'm', messages: [], retries: 2, backoffMs: [1], deferBusy,
    fetchImpl: async () => { count++; return unavailable(); }}).catch(error => error)}; };
  const asked = run(true); await asked.call; assert.equal(asked.count(), 1);
  const plain = run(false); await plain.call; assert.equal(plain.count(), 3);
});

test('the answers are marked busy only where Google is busy', () => {
  const map = (status, body) => mapFailure(status, body, {provider: 'custom', apiKey: KEY, headers: new Headers()});
  for (const [status, body] of [[503, google(503, 'UNAVAILABLE', 'The model is overloaded.')], [500, google(500, 'INTERNAL', 'An internal error has occurred.')],
    [429, google(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).')], [502, google(502, 'UNAVAILABLE', 'overloaded')]]) {
    const error = map(status, body);
    assert.equal(error.busy, true, `${status}`); assert.equal(error.kind, 'network', `${status}`);
  }
  for (const [status, body] of [[504, google(504, 'DEADLINE_EXCEEDED', 'The request timed out.')], [404, google(404, 'NOT_FOUND', 'models/x is not found')], [400, google(400, 'INVALID_ARGUMENT', 'bad field')],
    [429, google(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota.', [{'@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier'}]}])]]) {
    assert.notEqual(map(status, body).busy, true, `${status}`);
  }
});

// ---- The hedge and the backoff on a hand-moved clock ------------------------------------------------------------------------------------

function clock() {
  let at = 0; const timers = [];
  return {now: () => at, setTimer: (fn, ms) => { const timer = {at: at + ms, fn, live: true}; timers.push(timer); return timer; }, clearTimer: timer => { if (timer) timer.live = false; },
    advance(ms) { const end = at + ms; for (;;) { const due = timers.filter(timer => timer.live && timer.at <= end).sort((a, b) => a.at - b.at)[0]; if (!due) break; at = due.at; due.live = false; due.fn(); } at = end; },
    pending: () => timers.filter(timer => timer.live).length};
}
function fakes() {
  const calls = [];
  const chat = options => new Promise((resolve, reject) => {
    const call = {options, aborted: false, words: text => options.onDelta?.(text, text), finish: value => resolve(value), fail: error => reject(error)};
    options.signal?.addEventListener('abort', () => { call.aborted = true; reject(options.signal.reason ?? new Error('aborted')); });
    calls.push(call);
  });
  return {calls, chat, inFlight: () => calls.filter(call => !call.aborted && !call.done).length};
}
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(done => setImmediate(done)); };
// A call whose failure is awaited later must not count as unhandled meanwhile.
const watched = promise => { promise.catch(() => {}); return promise; };
const busy = (status = 503) => Object.assign(new MistralError('network', `had a server fault (HTTP ${status})`, {provider: 'custom', status, slow: true}), {busy: true});

test('the waits are one second, then two: the second request goes out 1.0 s after the first failed, the third 2.0 s after the second', async () => {
  const t = clock(), f = fakes(), logs = [];
  const call = watched(hedged(f.chat, {log: line => logs.push(line), ...t})({onDelta() {}}));
  await tick();
  f.calls[0].fail(busy()); await tick();
  assert.equal(f.calls.length, 1); t.advance(999); await tick(); assert.equal(f.calls.length, 1, 'not before one second');
  t.advance(1); await tick(); assert.equal(f.calls.length, 2);
  f.calls[1].fail(busy(500)); await tick();
  t.advance(1999); await tick(); assert.equal(f.calls.length, 2, 'not before two seconds');
  t.advance(1); await tick(); assert.equal(f.calls.length, 3);
  f.calls[2].words('Here'); f.calls[2].finish({text: 'Here'});
  assert.equal((await call).text, 'Here');
  assert.deepEqual(logs.map(line => line.replace(/, [\d.]+ s into the turn/, '')), [
    'Google Gemini: busy (HTTP 503), asking again in 1.0 s (retry 1 of 2)', 'Google Gemini: busy (HTTP 500), asking again in 2.0 s (retry 2 of 2)']);
});

test('after the second retry the busy error is the call\'s; a third retry is never made', async () => {
  const t = clock(), f = fakes();
  const call = watched(hedged(f.chat, {log() {}, ...t})({onDelta() {}}));
  const errors = [busy(), busy(), busy()];
  await tick(); f.calls[0].fail(errors[0]); await tick(); t.advance(1000); await tick();
  f.calls[1].fail(errors[1]); await tick(); t.advance(2000); await tick();
  f.calls[2].fail(errors[2]);
  await assert.rejects(call, error => error === errors[2]);
  t.advance(60_000); await tick();
  assert.equal(f.calls.length, 3); assert.equal(t.pending(), 0);
});

test('a busy answer that comes late is not asked again past about eight seconds into the turn', async () => {
  const t = clock(), f = fakes();
  const first = watched(hedged(f.chat, {log() {}, afterMs: 1e9, ...t})({onDelta() {}}));
  await tick(); t.advance(6900); f.calls[0].fail(busy()); await tick();
  t.advance(1000); await tick();
  assert.equal(f.calls.length, 2, '6.9 s + 1 s is within 8 s');
  const error = busy(); t.advance(100); f.calls[1].fail(error); await tick();
  // 7.9 s in, the second wait of 2 s would end at 9.9 s: no.
  await assert.rejects(first, e => e === error);
  assert.equal(f.calls.length, 2);
  const u = clock(), g = fakes();
  const late = watched(hedged(g.chat, {log() {}, afterMs: 1e9, ...u})({onDelta() {}}));
  await tick(); u.advance(7500); const slow = busy(); g.calls[0].fail(slow);
  await assert.rejects(late, e => e === slow);
  assert.equal(g.calls.length, 1, 'a 7.5 s answer plus a 1 s wait passes 8 s: no retry');
});

test('a retry never starts past the turn\'s deadline, or without room for an attempt before it', async () => {
  const t = clock(), f = fakes();
  const call = watched(hedged(f.chat, {log() {}, ...t})({onDelta() {}, deadlineAt: 3500, now: t.now}));
  await tick();
  const error = busy(); f.calls[0].fail(error);
  await assert.rejects(call, e => e === error);
  assert.equal(f.calls.length, 1, '1 s of waiting leaves 2.5 s, less than an attempt needs');
  const u = clock(), g = fakes();
  const roomy = watched(hedged(g.chat, {log() {}, ...u})({onDelta() {}, deadlineAt: 4500, now: u.now}));
  await tick(); g.calls[0].fail(busy()); await tick(); u.advance(1000); await tick();
  assert.equal(g.calls.length, 2, 'with 3.5 s left the retry goes');
  g.calls[1].fail(busy()); await tick();
  assert.equal(g.calls.length, 2, 'the second wait would leave 1.5 s: the busy error ends the call');
  await call.catch(() => {}); roomy.catch(() => {});
});

test('the retries share the hedge: never more than two requests in flight, and the hedge is sent at most once', async () => {
  const t = clock(), f = fakes(), logs = [];
  let live = 0, most = 0;
  const chat = options => { live++; most = Math.max(most, live); return f.chat(options).finally(() => { live--; }); };
  const call = watched(hedged(chat, {log: line => logs.push(line), ...t})({onDelta() {}}));
  await tick();
  t.advance(4000); await tick();
  assert.equal(f.calls.length, 2, 'the hedge');
  // The first request fails busy while the hedge is still in flight: nothing is asked again, the hedge is the second try.
  f.calls[0].fail(busy()); await tick(); t.advance(500); await tick();
  assert.equal(f.calls.length, 2);
  assert.equal(logs.filter(line => /busy/.test(line)).length, 0);
  // The hedge fails busy too: now it is asked again, after one second, with one request in flight.
  f.calls[1].fail(busy()); await tick();
  assert.equal(logs.filter(line => /busy/.test(line)).length, 1);
  t.advance(1000); await tick();
  assert.equal(f.calls.length, 3);
  // This retry is silent for four seconds: the hedge was already used, so no further extra request goes out.
  t.advance(10_000); await tick();
  assert.equal(f.calls.length, 3, 'no second hedge');
  f.calls[2].words('At last'); f.calls[2].finish({text: 'At last'});
  assert.equal((await call).text, 'At last');
  assert.ok(most <= 2, `at most two in flight, saw ${most}`);
});

test('a retry can be hedged once if no hedge was sent yet: silent for four seconds after the retry starts', async () => {
  const t = clock(), f = fakes(), logs = [];
  const call = watched(hedged(f.chat, {log: line => logs.push(line), ...t})({onDelta() {}}));
  await tick(); t.advance(500); f.calls[0].fail(busy()); await tick(); t.advance(1000); await tick();
  assert.equal(f.calls.length, 2, 'the retry');
  t.advance(3999); await tick(); assert.equal(f.calls.length, 2);
  t.advance(1); await tick(); assert.equal(f.calls.length, 3, 'the hedge, four seconds after the retry was sent');
  f.calls[2].words('x'); f.calls[2].finish({text: 'x'});
  assert.equal((await call).text, 'x');
  assert.ok(f.calls[1].aborted, 'the silent retry is cancelled by the winner');
});

test('once a reply has begun nothing is asked again: a busy failure after the first word is the call\'s', async () => {
  const t = clock(), f = fakes(), pieces = [];
  const call = watched(hedged(f.chat, {log() {}, ...t})({onDelta: piece => pieces.push(piece)}));
  await tick(); f.calls[0].words('Half'); const error = busy(); f.calls[0].fail(error);
  await assert.rejects(call, e => e === error);
  t.advance(10_000); await tick();
  assert.equal(f.calls.length, 1); assert.deepEqual(pieces, ['Half']);
});

test('a failure about the account ends the call at once, also between two busy answers', async () => {
  const t = clock(), f = fakes(), logs = [];
  const call = watched(hedged(f.chat, {log: line => logs.push(line), ...t})({onDelta() {}}));
  await tick(); f.calls[0].fail(busy()); await tick(); t.advance(1000); await tick();
  const limit = new MistralError('daily', 'reached its daily limit [custom:daily]', {provider: 'custom'});
  f.calls[1].fail(limit);
  await assert.rejects(call, e => e === limit);
  assert.equal(f.calls.length, 2);
});

test('the turn being stopped ends a pending retry at once, with the stop as the reason', async () => {
  const t = clock(), f = fakes(), controller = new AbortController();
  const call = watched(hedged(f.chat, {log() {}, ...t})({onDelta() {}, signal: controller.signal}));
  await tick(); f.calls[0].fail(busy()); await tick();
  controller.abort(new Error('turn over'));
  await assert.rejects(call, /turn over/);
  t.advance(10_000); await tick();
  assert.equal(f.calls.length, 1); assert.equal(t.pending(), 0);
});

test('a request that is not streamed is passed through: no retry of its own, its own loop answers', async () => {
  const t = clock(), f = fakes();
  const plain = watched(hedged(f.chat, {log() {}, ...t})({messages: []}));
  await tick(); const error = busy(); f.calls[0].fail(error);
  await assert.rejects(plain, e => e === error);
  t.advance(10_000); await tick();
  assert.equal(f.calls.length, 1);
});

test('a network failure that is not busy (no connection) is not asked again by the busy retry', async () => {
  const t = clock(), f = fakes();
  const call = watched(hedged(f.chat, {log() {}, ...t})({onDelta() {}}));
  await tick();
  const error = new MistralError('network', 'could not be reached', {provider: 'custom'});
  f.calls[0].fail(error);
  await assert.rejects(call, e => e === error);
  assert.equal(f.calls.length, 1);
});
