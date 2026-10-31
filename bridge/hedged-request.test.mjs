// The hedged request of the Google Gemini provider (bridge/hedged-request.mjs): a streamed reply with no first word after 4 s is sent once more, the first to answer wins and the
// other is cancelled at once; one extra request at most; only Gemini; one log line per hedge; a failure about the account ends the call.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HEDGE_AFTER_MS, hedged} from './hedged-request.mjs';
import {customRoute} from './text-provider-host.mjs';
import {MistralError} from './mistral-client.mjs';

// A clock and timers the test moves by hand.
function clock() {
  let at = 0; const timers = [];
  return {now: () => at, setTimer: (fn, ms) => { const timer = {at: at + ms, fn, live: true}; timers.push(timer); return timer; }, clearTimer: timer => { if (timer) timer.live = false; },
    advance(ms) { at += ms; for (const timer of timers) if (timer.live && timer.at <= at) { timer.live = false; timer.fn(); } }};
}
// A chat whose requests the test answers by hand: calls[i] = {options, aborted, words(text), finish(value), fail(error)}.
function rig() {
  const calls = [];
  const chat = options => new Promise((resolve, reject) => {
    const call = {options, aborted: false, words: text => options.onDelta?.(text, text), finish: value => resolve(value), fail: error => reject(error)};
    options.signal?.addEventListener('abort', () => { call.aborted = true; reject(options.signal.reason ?? new Error('aborted')); });
    calls.push(call);
  });
  return {calls, chat};
}
const tick = () => new Promise(done => setImmediate(done));
const network = (message = 'no answer in time') => new MistralError('network', message, {provider: 'custom', slow: true});

test('the delay is four seconds', () => assert.equal(HEDGE_AFTER_MS, 4000));

test('a first word within four seconds sends nothing extra', async () => {
  const t = clock(), r = rig(), logs = [], pieces = [];
  const call = hedged(r.chat, {log: line => logs.push(line), ...t})({onDelta: piece => pieces.push(piece), messages: []});
  await tick();
  t.advance(3900);
  r.calls[0].words('Hi');
  t.advance(10_000);
  r.calls[0].finish({text: 'Hi there'});
  assert.equal((await call).text, 'Hi there');
  assert.equal(r.calls.length, 1); assert.deepEqual(pieces, ['Hi']); assert.deepEqual(logs, []);
});

test('no first word after four seconds: the same request is sent once more, the second answers first and wins, the first is cancelled, one line says so', async () => {
  const t = clock(), r = rig(), logs = [], pieces = [];
  const options = {onDelta: piece => pieces.push(piece), messages: [{role: 'user', content: 'hello'}], model: 'm', extraBody: {a: 1}};
  const call = hedged(r.chat, {log: line => logs.push(line), ...t})(options);
  t.advance(4000);
  await tick();
  assert.equal(r.calls.length, 2, 'one extra request');
  assert.deepEqual(r.calls[1].options.messages, options.messages); assert.equal(r.calls[1].options.model, 'm'); assert.deepEqual(r.calls[1].options.extraBody, {a: 1});
  t.advance(2200);
  r.calls[1].words('Yo');
  assert.equal(r.calls[0].aborted, true, 'the loser is cancelled at once, when the winner gives its first word');
  r.calls[0].words('late');        // a cancelled request that still talks is not heard
  r.calls[1].words(' V');
  r.calls[1].finish({text: 'Yo V'});
  assert.equal((await call).text, 'Yo V');
  assert.deepEqual(pieces, ['Yo', ' V']);
  assert.equal(logs.length, 2, logs.join('\n'));
  assert.match(logs[0], /no first word after 4\.0 s, the same request is sent once more/);
  assert.match(logs[1], /the second request gave the first word at 6\.2 s and won/);
  assert.equal(r.calls.length, 2, 'never a third');
});

test('the first request answering after the second was sent wins, and the second is cancelled', async () => {
  const t = clock(), r = rig(), logs = [], pieces = [];
  const call = hedged(r.chat, {log: line => logs.push(line), ...t})({onDelta: piece => pieces.push(piece)});
  t.advance(4000); await tick();
  t.advance(500);
  r.calls[0].words('First');
  assert.equal(r.calls[1].aborted, true);
  r.calls[0].finish({text: 'First'});
  assert.equal((await call).text, 'First'); assert.deepEqual(pieces, ['First']);
  assert.match(logs.at(-1), /the first request gave the first word at 4\.5 s and won/);
  assert.equal(logs.length, 2);
});

test('a silent request that fails on the network waits for the other; both failing ends with the first failure and one line', async () => {
  const t = clock(), r = rig(), logs = [];
  const call = hedged(r.chat, {log: line => logs.push(line), ...t})({onDelta() {}});
  t.advance(4000); await tick();
  const first = network('first'), second = network('second');
  r.calls[0].fail(first); await tick();
  r.calls[1].fail(second);
  await assert.rejects(call, error => error === first);
  assert.match(logs.at(-1), /neither request answered \(network, network\)/);
  // The second answers after the first failed.
  const u = clock(), s = rig(), words = [];
  const again = hedged(s.chat, {log() {}, ...u})({onDelta: piece => words.push(piece)});
  u.advance(4000); await tick();
  s.calls[0].fail(network()); await tick();
  s.calls[1].words('ok'); s.calls[1].finish({text: 'ok'});
  assert.equal((await again).text, 'ok'); assert.deepEqual(words, ['ok']);
});

test('a failure about the account from either request ends the call at once with that failure and cancels the other (the route notes it as it always did)', async () => {
  for (const kind of ['limit', 'daily', 'key', 'credits', 'region']) {
    const t = clock(), r = rig();
    const call = hedged(r.chat, {log() {}, ...t})({onDelta() {}});
    t.advance(4000); await tick();
    const error = new MistralError(kind, `refused [custom:${kind}]`, {provider: 'custom'});
    r.calls[1].fail(error);
    await assert.rejects(call, e => e === error, kind);
    assert.equal(r.calls[0].aborted, true, kind);
  }
  // Before the delay: no hedge, the failure is the call's.
  const t = clock(), r = rig();
  const call = hedged(r.chat, {log() {}, ...t})({onDelta() {}});
  const error = new MistralError('key', 'refused', {provider: 'custom'});
  await tick();
  r.calls[0].fail(error);
  await assert.rejects(call, e => e === error);
  t.advance(10_000); await tick();
  assert.equal(r.calls.length, 1, 'a failed request is not hedged');
});

test('the winner failing after its first word fails the call; a stopped turn ends both requests; a request that is not streamed or already stopped is passed through untouched', async () => {
  const t = clock(), r = rig();
  const call = hedged(r.chat, {log() {}, ...t})({onDelta() {}});
  t.advance(4000); await tick();
  r.calls[1].words('half');
  const cut = network('went quiet');
  r.calls[1].fail(cut);
  await assert.rejects(call, e => e === cut);
  assert.equal(r.calls.length, 2);
  // The caller's own signal.
  const controller = new AbortController(), u = clock(), s = rig();
  const stopped = hedged(s.chat, {log() {}, ...u})({onDelta() {}, signal: controller.signal});
  u.advance(4000); await tick();
  controller.abort(new Error('turn over'));
  await assert.rejects(stopped, /turn over/);
  assert.ok(s.calls.every(call => call.aborted));
  // No onDelta (the action decision, a summary, facts): the plain call, never a second request.
  const v = clock(), q = rig();
  const plain = hedged(q.chat, {log() {}, ...v})({messages: []});
  v.advance(30_000); await tick();
  assert.equal(q.calls.length, 1);
  q.calls[0].finish({text: 'x'});
  assert.equal((await plain).text, 'x');
});

test('only the Google Gemini route hedges: the Custom route sends one request however long it is silent', async () => {
  for (const name of ['gemini', 'custom']) {
    const r = rig(), logs = [];
    const provider = {noteLimit() {}, noteSuccess() {}, limit: null};
    const custom = {origin: 'https://example.test', model: 'm', key: 'k', ready: true, chatUrl: 'https://example.test/v1/chat/completions', local: false};
    const route = customRoute({provider, custom, name, chat: r.chat, log: line => logs.push(line), hedgeMs: 20});
    const call = route.chat({onDelta() {}, messages: []});
    await new Promise(done => setTimeout(done, 80));
    assert.equal(r.calls.length, name === 'gemini' ? 2 : 1, name);
    if (name === 'gemini') assert.ok(logs.some(line => /^\[TextProvider\] Google Gemini: no first word after 0\.0 s/.test(line)), logs.join('\n'));
    for (const c of r.calls) c.fail(network());
    await call.catch(() => {});
  }
});
