// A shared Convai key that Convai refuses ("Invalid API key", the owner rotated it on 31 Oct 2026 and installs on 0.4.0 kept the credential
// they had cached from the sign-in backend): the cached credential is dropped, a new one is fetched once, rate limited, and the turn is asked
// once more, with no report and no notice when that works. Fake credentials, a scripted backend and a host without a browser.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConvaiKeys, chainRecovery, credentialRecovery, memoryRecovery} from './convai-key.mjs';
import {TokenSource} from './convai-credential.mjs';
import {QuotaWatch, classifyFailure} from './convai-quota.mjs';
import {RealtimeHost} from './realtime-host.mjs';

const SHARED_DEVELOPER_KEY = 'developer-fixture-key-0000000000000';
const PLAYER = 'player-fixture-key-1111111111111111';
const INSTALL = '3b241101-e2bb-4255-8caf-4136c566a962';
const MINUTE = 60_000, HOUR = 3_600_000;
const flush = async () => { for (let round = 0; round < 8; round++) await new Promise(done => setImmediate(done)); };
const REJECTED = () => Error('convai: page.evaluate: Error: Invalid API key');

/** A clock, timers that never fire by themselves, and a backend that answers from a script of tokens (or failures). */
function world() {
  const state = {now: Date.parse('2026-10-31T08:15:00Z'), answers: [], requests: 0, logs: [], timers: []};
  const fetchImpl = async () => {
    state.requests += 1;
    const answer = state.answers.length > 1 ? state.answers.shift() : state.answers[0];
    if (answer === 'fail') return new Response('<html>bad gateway</html>', {status: 502});
    return new Response(JSON.stringify({authToken: answer, expiresAt: new Date(state.now + HOUR).toISOString(), serverTime: Math.floor(state.now / 1000)}), {status: 200});
  };
  const tokens = new TokenSource({url: 'https://auth.example.invalid/api/convai/token', secret: 'fixture-signing-secret-000000', installId: INSTALL,
    version: '0.4.0', fetchImpl, now: () => state.now, random: () => 0.5, log: line => state.logs.push(line),
    setTimer: (callback, delay) => { const timer = {callback, delay, live: true}; state.timers.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.live = false; }});
  return {state, tokens, advance: ms => { state.now += ms; }};
}
async function started(...answers) {
  const w = world();
  w.state.answers = [...answers];
  w.tokens.start();
  await flush();
  assert.equal(w.tokens.current()?.token, answers[0], 'the first token is held');
  w.state.requests = 0;
  return w;
}
const sharedKeys = async (tokens, {sharedKey = null} = {}) => await new ConvaiKeys({sharedKey, playerKeyPath: 'own', backend: tokens,
  readText: async path => { if (path === 'own') return `api-key=${PLAYER}\n`; throw Error('missing'); }}).load();

/** A host with no browser: runOnce stands in for the page and sees the credential exactly as evaluateSpeech applies it. */
function hostFor(keys, tokens, answerFor) {
  const seen = {tokens: [], failures: [], successes: 0, logs: []};
  const recover = chainRecovery(
    credentialRecovery({keys, classify: classifyFailure, log: line => seen.logs.push(line)}),
    memoryRecovery({keys, classify: classifyFailure}));
  const host = new RealtimeHost({credential: config => keys.credentialFor(config), recover,
    onFailure: error => seen.failures.push(error), onSuccess: () => { seen.successes += 1; }, launchBrowser: () => assert.fail('no browser')});
  host.runOnce = async config => {
    const sent = await host.credential(config);
    const used = sent.authToken ?? sent.key;
    seen.tokens.push(used);
    return answerFor(used, seen.tokens.length);
  };
  return {host, seen};
}

test('refreshRejected drops the cached credential and fetches a new one: fresh, one request', async () => {
  const w = await started('token-old-0001', 'token-new-0002');
  assert.equal(await w.tokens.refreshRejected(), 'fresh');
  assert.equal(w.tokens.current().token, 'token-new-0002');
  assert.equal(w.state.requests, 1);
});

test('the backend handing out the same credential again is "same", and the credential stays held as before', async () => {
  const w = await started('token-old-0001');
  assert.equal(await w.tokens.refreshRejected(), 'same');
  assert.equal(w.tokens.current().token, 'token-old-0001');
  assert.equal(w.state.requests, 1);
});

test('rate limit: a second refusal within five minutes asks the backend nothing, the next one after five minutes does', async () => {
  const w = await started('token-old-0001');
  assert.equal(await w.tokens.refreshRejected(), 'same');
  w.advance(4 * MINUTE + 31_000); // past the "fresh a moment ago" window; there was none (same), so only the rate limit decides
  assert.equal(await w.tokens.refreshRejected(), 'limited');
  assert.equal(w.state.requests, 1, 'no second request inside five minutes');
  w.advance(MINUTE);
  w.state.answers = ['token-new-0002'];
  assert.equal(await w.tokens.refreshRejected(), 'fresh');
  assert.equal(w.state.requests, 2);
});

test('a backend that does not answer: unavailable, the refused credential is gone, and a retry storm is held to one request per five minutes', async () => {
  const w = await started('token-old-0001');
  w.state.answers = ['fail'];
  assert.equal(await w.tokens.refreshRejected(), 'unavailable');
  assert.equal(w.tokens.current(), null, 'the refused credential is not served again');
  for (let turn = 0; turn < 20; turn++) assert.equal(await w.tokens.refreshRejected(), 'limited');
  assert.equal(w.state.requests, 1);
});

test('turns that fail at the same moment share one fetch', async () => {
  const w = await started('token-old-0001', 'token-new-0002');
  const results = await Promise.all([w.tokens.refreshRejected(), w.tokens.refreshRejected(), w.tokens.refreshRejected()]);
  assert.deepEqual(results, ['fresh', 'fresh', 'fresh']);
  assert.equal(w.state.requests, 1);
});

test('a turn that fails on the old credential just after the fresh one arrived is told fresh without another request; a refused fresh one ends that', async () => {
  const w = await started('token-old-0001', 'token-new-0002');
  assert.equal(await w.tokens.refreshRejected(), 'fresh');
  w.advance(10_000);
  assert.equal(await w.tokens.refreshRejected(), 'fresh');
  assert.equal(w.state.requests, 1);
  w.tokens.freshWasRejected();
  assert.equal(await w.tokens.refreshRejected(), 'limited');
  assert.equal(w.state.requests, 1);
});

test('the request budget of the hour holds the refetch back', async () => {
  const w = await started('token-0001');
  // Eight requests in the last hour use the install's budget (the backend allows 12 an hour for the schedule and restarts too).
  for (let index = 0; index < 8; index++) { w.advance(6 * MINUTE); w.state.answers = [`token-${index + 2}`]; await w.tokens.refreshRejected(); }
  w.advance(6 * MINUTE);
  const before = w.state.requests;
  assert.equal(await w.tokens.refreshRejected(), 'limited');
  assert.equal(w.state.requests, before);
});

test('a turn refused as "Invalid API key" is asked again once with the fresh credential: it works, no failure is observed', async () => {
  const w = await started('token-old-0001', 'token-new-0002');
  const keys = await sharedKeys(w.tokens);
  const {host, seen} = hostFor(keys, w.tokens, (used) => { if (used === 'token-old-0001') throw REJECTED(); return {text: 'hello', sessionID: 's1'}; });
  const result = await host.reply({characterId: 'alex', scope: 'private', text: 'hi', key: 'unused'});
  assert.equal(result.text, 'hello');
  assert.deepEqual(seen.tokens, ['token-old-0001', 'token-new-0002']);
  assert.equal(seen.failures.length, 0, 'no failure is observed, so no report and no notice');
  assert.equal(seen.successes, 1);
  assert.equal(w.state.requests, 1);
  assert.ok(seen.logs.some(line => /fetched a new one/.test(line)));
  const quota = new QuotaWatch({keys});
  assert.equal(quota.snapshot(), null);
});

test('every rejected wording is retried: realtime access not allowed, "API key is invalid"', async () => {
  for (const text of ['convai: Realtime access not allowed', 'page.evaluate: API key is invalid', 'Invalid API key']) {
    const w = await started('token-old-0001', 'token-new-0002');
    const keys = await sharedKeys(w.tokens);
    const {host, seen} = hostFor(keys, w.tokens, (used) => { if (used === 'token-old-0001') throw Error(text); return {text: 'ok'}; });
    assert.equal((await host.reply({characterId: 'alex', scope: 'private', text: 'hi'})).text, 'ok', text);
    assert.deepEqual(seen.tokens, ['token-old-0001', 'token-new-0002'], text);
  }
});

test('the same credential again: today\'s behaviour, one attempt, the failure reaches the observer once', async () => {
  const w = await started('token-old-0001');
  const keys = await sharedKeys(w.tokens);
  const {host, seen} = hostFor(keys, w.tokens, () => { throw REJECTED(); });
  await assert.rejects(host.reply({characterId: 'alex', scope: 'private', text: 'hi'}), /Invalid API key/);
  assert.deepEqual(seen.tokens, ['token-old-0001'], 'not asked again with the same credential');
  assert.equal(seen.failures.length, 1);
  assert.ok(seen.logs.some(line => /same one again/.test(line)));
});

test('a fresh credential that is refused too: asked once more at most, the failure is observed once', async () => {
  const w = await started('token-old-0001', 'token-new-0002');
  const keys = await sharedKeys(w.tokens);
  const {host, seen} = hostFor(keys, w.tokens, () => { throw REJECTED(); });
  await assert.rejects(host.reply({characterId: 'alex', scope: 'private', text: 'hi'}), /Invalid API key/);
  assert.deepEqual(seen.tokens, ['token-old-0001', 'token-new-0002']);
  assert.equal(seen.failures.length, 1);
  assert.equal(w.state.requests, 1);
  // the next turn of the outage does not ask the backend again, and is not asked twice
  seen.tokens.length = 0;
  await assert.rejects(host.reply({characterId: 'alex', scope: 'private', text: 'again'}), /Invalid API key/);
  assert.equal(w.state.requests, 1, 'the backend is not hammered');
  assert.deepEqual(seen.tokens, ['token-new-0002']);
});

test('a player\'s own key is never refreshed or asked again this way', async () => {
  const w = await started('token-old-0001', 'token-new-0002');
  const keys = await sharedKeys(w.tokens);
  keys.setPreference(true); keys.apply();
  assert.equal(keys.source, 'player');
  const {host, seen} = hostFor(keys, w.tokens, () => { throw REJECTED(); });
  await assert.rejects(host.reply({characterId: 'alex', scope: 'private', text: 'hi', key: keys.current()}), /Invalid API key/);
  assert.deepEqual(seen.tokens, [PLAYER], 'one attempt, with the player\'s key');
  assert.equal(seen.failures.length, 1);
  assert.equal(w.state.requests, 0, 'the sign-in backend was not asked');
  assert.equal(await credentialRecovery({keys, classify: classifyFailure})(REJECTED(), {characterId: 'alex'}), undefined);
});

test('without a sign-in backend (a developer key) there is nothing to fetch and nothing is retried', async () => {
  const keys = await new ConvaiKeys({sharedKey: SHARED_DEVELOPER_KEY, playerKeyPath: 'own', readText: async () => { throw Error('missing'); }}).load();
  assert.equal(keys.usesBackend, false);
  assert.equal(await credentialRecovery({keys, classify: classifyFailure})(REJECTED(), {characterId: 'alex'}), undefined);
});

test('other failures are not this hook\'s: a plan limit, a busy plan, a speaker limit and a plain error pass through', async () => {
  const w = await started('token-old-0001', 'token-new-0002');
  const keys = await sharedKeys(w.tokens);
  const recover = credentialRecovery({keys, classify: classifyFailure});
  for (const text of ['[convai-quota:interaction] used up', 'Concurrency limit reached', 'LTM speaker limit reached', 'socket hang up', '']) {
    assert.equal(await recover(Error(text), {characterId: 'alex'}), undefined, text);
  }
  assert.equal(w.state.requests, 0);
});

test('the chain: the credential hook goes first, a player\'s memory-user recovery still works behind it', async () => {
  const calls = [];
  const chain = chainRecovery(async () => { calls.push('first'); return undefined; }, async (error, config) => { calls.push('second'); return {...config, changed: true}; },
    async () => { calls.push('third'); return {}; });
  assert.deepEqual(await chain(Error('x'), {a: 1}), {a: 1, changed: true});
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(await chainRecovery(async () => undefined)(Error('x'), {}), undefined);
});
