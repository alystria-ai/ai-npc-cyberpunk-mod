import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConvaiKeys} from './convai-key.mjs';
import {TokenSource, loadInstallId, readAuthSettings, signRequest} from './convai-credential.mjs';
import {TurnLimitError, LIMIT_MARKER} from './shared-key-guard.mjs';
import {classifyFailure} from './convai-quota.mjs';
import {RealtimeHost} from './realtime-host.mjs';
// The real backend code, driven by the same signed requests the bridge sends (fake store and fake Convai, no network).
import {createWorld, mockResponse} from '../auth-backend/testkit/harness.mjs';
import {SIGNING_SECRET} from '../auth-backend/testkit/harness.mjs';

// Fake credentials only.
const SHARED = 'embedded-fixture-key-00000000000000';
const PLAYER = 'player-fixture-key-1111111111111111';
const INSTALL = '3b241101-e2bb-4255-8caf-4136c566a962';
const MINUTE = 60_000, HOUR = 3_600_000;
const flush = async () => { for (let round = 0; round < 8; round++) await new Promise(done => setImmediate(done)); };

function fakeTimers() {
  const timers = [];
  let next = 0;
  return {
    timers,
    setTimer(callback, delay) { const id = ++next; timers.push({id, callback, delay, live: true}); return id; },
    clearTimer(id) { const timer = timers.find(row => row.id === id); if (timer) timer.live = false; },
    get live() { return timers.filter(row => row.live); },
    /** Runs the one live timer (the source keeps at most one schedule). */
    async fire() { const [timer] = this.live; assert.ok(timer, 'a timer was scheduled'); timer.live = false; timer.callback(); await flush(); return timer.delay; },
  };
}

/** A fetch that talks to the real token handler in `world`. */
function backendFetch(world, {onRequest} = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({url, init});
    onRequest?.(init);
    const response = mockResponse();
    await world.handler({method: init.method, headers: {...init.headers, 'x-vercel-forwarded-for': '203.0.113.7'}, body: init.body}, response);
    return new Response(response.text, {status: response.statusCode});
  };
  return {fetchImpl, calls};
}

function source(world, extra = {}) {
  const timers = fakeTimers(), logs = [];
  const backend = backendFetch(world);
  const tokens = new TokenSource({url: 'https://auth.example.invalid/api/convai/token', secret: SIGNING_SECRET, installId: INSTALL, version: '0.2',
    fetchImpl: backend.fetchImpl, now: () => world.clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, random: () => 0.5,
    log: message => logs.push(message), ...extra});
  return {tokens, timers, logs, backend};
}
const keysWith = async (tokens, files = {}) => await new ConvaiKeys({sharedKey: SHARED, playerKeyPath: 'own',
  readText: async path => { if (!(path in files)) throw Error('missing'); return files[path]; }, backend: tokens}).load();
const config = {key: SHARED, characterId: 'alex', scope: 'private', text: 'hello'};

test('the install id is a random UUID v4, made once and kept; a damaged file is replaced; an unwritable one still gives an id', async () => {
  const written = [];
  const id = await loadInstallId({path: 'install.json', readText: async () => { throw Error('missing'); }, writeText: async (path, text) => written.push([path, text])});
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(written.length, 1);
  assert.deepEqual(JSON.parse(written[0][1]), {version: 1, installId: id});
  assert.equal(await loadInstallId({path: 'install.json', readText: async () => written[0][1], writeText: async () => assert.fail('no rewrite')}), id);
  const other = await loadInstallId({path: 'install.json', readText: async () => '{"version":1,"installId":"not-a-uuid"}', writeText: async () => {}});
  assert.notEqual(other, 'not-a-uuid');
  assert.match(await loadInstallId({path: 'x', readText: async () => { throw Error('x'); }, writeText: async () => { throw Error('read-only'); }}), /^[0-9a-f-]{36}$/);
});

test('backend mode is off unless switched on and fully configured', async () => {
  const off = await readAuthSettings({env: {}});
  assert.equal(off.enabled, false); assert.equal(off.problem, null); assert.equal(off.fallback, true);
  const noUrl = await readAuthSettings({env: {CYBERPUNK_CONVAI_AUTH_BACKEND: '1', CYBERPUNK_CONVAI_AUTH_SECRET: 's'.repeat(32)}});
  assert.equal(noUrl.enabled, false); assert.match(noUrl.problem, /address/);
  const plain = await readAuthSettings({env: {CYBERPUNK_CONVAI_AUTH_BACKEND: '1', CYBERPUNK_CONVAI_AUTH_URL: 'http://example.com/t', CYBERPUNK_CONVAI_AUTH_SECRET: 's'.repeat(32)}});
  assert.equal(plain.enabled, false, 'a key-bearing service address must be https');
  const noSecret = await readAuthSettings({env: {CYBERPUNK_CONVAI_AUTH_BACKEND: '1', CYBERPUNK_CONVAI_AUTH_URL: 'https://a.example/t'}});
  assert.equal(noSecret.enabled, false); assert.match(noSecret.problem, /secret/);
  const on = await readAuthSettings({env: {CYBERPUNK_CONVAI_AUTH_BACKEND: 'on', CYBERPUNK_CONVAI_AUTH_URL: 'https://a.example/t', CYBERPUNK_CONVAI_AUTH_SECRET: 's'.repeat(32), CYBERPUNK_CONVAI_AUTH_FALLBACK: '0'}});
  assert.equal(on.enabled, true); assert.equal(on.fallback, false); assert.equal(on.url, 'https://a.example/t');
  const local = await readAuthSettings({env: {CYBERPUNK_CONVAI_AUTH_BACKEND: '1', CYBERPUNK_CONVAI_AUTH_URL: 'http://127.0.0.1:3000/t', CYBERPUNK_CONVAI_AUTH_SECRET: 's'.repeat(32)}});
  assert.equal(local.enabled, true, 'a local test server may use http');
  const fromFile = await readAuthSettings({env: {}, path: 'cfg', readText: async () => JSON.stringify({enabled: true, url: 'https://a.example/t', secret: 's'.repeat(32), fallback: false})});
  assert.equal(fromFile.enabled, true); assert.equal(fromFile.fallback, false);
  const envWins = await readAuthSettings({env: {CYBERPUNK_CONVAI_AUTH_BACKEND: '0'}, path: 'cfg', readText: async () => JSON.stringify({enabled: true, url: 'https://a.example/t', secret: 's'.repeat(32)})});
  assert.equal(envWins.enabled, false);
  assert.equal((await readAuthSettings({env: {}, path: 'cfg', readText: async () => 'garbage'})).enabled, false);
});

test('the request is signed the way the backend checks it, and the backend accepts it', async () => {
  const world = createWorld();
  const {tokens, backend} = source(world);
  tokens.noteTurn(); tokens.noteTurn();
  tokens.start();
  await flush();
  const {url, init} = backend.calls[0];
  assert.equal(url, 'https://auth.example.invalid/api/convai/token');
  assert.equal(init.method, 'POST');
  const body = JSON.parse(init.body);
  assert.deepEqual(body, {installId: INSTALL, modVersion: '0.2', turnsSinceLast: 2, minLifeSeconds: 900});
  assert.equal(init.headers['x-convai-signature'], signRequest(SIGNING_SECRET, init.headers['x-convai-timestamp'], init.body));
  assert.equal(tokens.current().token, 'fake-token-1');
  assert.equal(tokens.pending, 0, 'the report was accepted');
  assert.equal(JSON.stringify(init).includes(SIGNING_SECRET), false, 'the secret itself is never sent');
});

test('it fetches in the background at start, never blocks start(), and renews 8 to 10 minutes before expiry', async () => {
  const world = createWorld();
  const {tokens, timers, backend} = source(world);
  const started = tokens.start();
  assert.equal(started, tokens, 'start returns at once');
  assert.equal(tokens.current(), null, 'nothing yet: the fetch is in flight');
  await flush();
  assert.equal(tokens.current().token, 'fake-token-1');
  assert.equal(timers.live.length, 1);
  // random() = 0.5 -> 9 minutes before the hour is up
  assert.equal(timers.live[0].delay, HOUR - 9 * MINUTE);
  world.advance(HOUR - 9 * MINUTE);
  tokens.noteTurn(); tokens.noteTurn(); tokens.noteTurn();
  await timers.fire();
  assert.equal(backend.calls.length, 2);
  assert.equal(JSON.parse(backend.calls[1].init.body).turnsSinceLast, 3);
  assert.equal(tokens.current().token, 'fake-token-2', 'a renewal returns a new token, not the old one');
  assert.equal(tokens.pending, 0);
  assert.equal(timers.live.length, 1);
  assert.equal(timers.live[0].delay, HOUR - 9 * MINUTE);
  // Turns counted while a request is in flight are kept for the next one.
  world.advance(HOUR - 9 * MINUTE);
  const firing = timers.fire();
  tokens.noteTurn();
  await firing;
  assert.equal(tokens.pending, 1);
  tokens.stop();
  assert.equal(timers.live.length, 0, 'stop cancels the renewal');
});

test('a turn never causes a request: 1000 credential lookups after start make no fetch and wait for nothing', async () => {
  const world = createWorld();
  const {tokens, timers, backend} = source(world);
  const keys = await keysWith(tokens);
  tokens.start(); await flush();
  const requests = backend.calls.length, timersBefore = timers.timers.length;
  for (let turn = 0; turn < 1000; turn++) {
    tokens.noteTurn();
    keys.assertAllowed();
    const sent = await keys.credentialFor(config);
    assert.equal(sent.authToken, 'fake-token-1');
  }
  assert.equal(backend.calls.length, requests, 'no request on any turn');
  assert.equal(timers.timers.length, timersBefore, 'no timer, so no wait, on any turn');
  assert.equal(tokens.pending, 1000, 'the turns are only counted, for the next renewal');
  assert.ok(tokens.current(), 'current() is a plain synchronous read');
});

test('with a token the connection config carries authToken and no key; the key stays in memory only', async () => {
  const world = createWorld();
  const {tokens} = source(world);
  const keys = await keysWith(tokens);
  tokens.start(); await flush();
  const sent = await keys.credentialFor(config);
  assert.equal(sent.authToken, 'fake-token-1');
  assert.equal('key' in sent, false);
  assert.equal(sent.characterId, 'alex');
  assert.deepEqual(await keys.credential(), {authToken: 'fake-token-1'});
  assert.equal(keys.usesBackend, true);
  assert.ok(keys.secrets().includes('fake-token-1') && keys.secrets().includes(SIGNING_SECRET) && keys.secrets().includes(SHARED), 'reports scrub all three');
});

test('a first connection waits for the first fetch only while it is running, then proceeds', async () => {
  const world = createWorld();
  let release;
  const gate = new Promise(done => { release = done; });
  const backend = backendFetch(world, {onRequest: () => gate});
  const slow = async (url, init) => { await gate; return backend.fetchImpl(url, init); };
  const timers = fakeTimers();
  const tokens = new TokenSource({url: 'https://auth.example.invalid/t', secret: SIGNING_SECRET, installId: INSTALL, fetchImpl: slow,
    now: () => world.clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, random: () => 0.5});
  const keys = await keysWith(tokens);
  tokens.start();
  const pending = keys.credentialFor(config);
  await flush();
  release();
  const sent = await pending;
  assert.equal(sent.authToken, 'fake-token-1');
  assert.equal(await tokens.ready(), true, 'with a token held ready() answers at once');
});

test('ready() gives up after its limit and the embedded key stands in for that connection', async () => {
  const timers = fakeTimers(), logs = [];
  const tokens = new TokenSource({url: 'https://auth.example.invalid/t', secret: SIGNING_SECRET, installId: INSTALL, log: message => logs.push(message),
    fetchImpl: () => new Promise(() => {}), setTimer: timers.setTimer, clearTimer: timers.clearTimer, now: () => 0});
  const keys = await keysWith(tokens);
  tokens.start();
  const waiting = keys.credentialFor(config);
  await flush();
  const limit = timers.live.find(timer => timer.delay === 4000);
  assert.ok(limit, 'at most four seconds');
  limit.callback();
  const sent = await waiting;
  assert.equal(sent.key, SHARED);
  assert.equal(sent.authToken, undefined);
  assert.equal(logs.length, 1);
});

test('fallback: an unreachable backend lets the embedded key stand in, reported once and only in the log; retries back off', async () => {
  const world = createWorld();
  let reachable = false;
  const backend = backendFetch(world);
  const timers = fakeTimers(), logs = [];
  const tokens = new TokenSource({url: 'https://auth.example.invalid/t', secret: SIGNING_SECRET, installId: INSTALL, fallback: true,
    fetchImpl: (url, init) => reachable ? backend.fetchImpl(url, init) : Promise.reject(new TypeError('fetch failed')),
    now: () => world.clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, random: () => 0.5, log: message => logs.push(message)});
  const keys = await keysWith(tokens);
  tokens.start(); await flush();
  const first = await keys.credentialFor(config);
  const second = await keys.credentialFor(config);
  assert.equal(first.key, SHARED); assert.equal(second.key, SHARED);
  assert.equal(first.authToken, undefined);
  assert.equal(logs.filter(line => /embedded key/.test(line)).length, 1, 'the fallback is reported once per episode');
  assert.ok(logs.every(line => !line.includes(SHARED)), 'the key is never printed');
  const delays = [timers.live[0].delay];
  for (let step = 0; step < 5; step++) { delays.push(await timers.fire() && timers.live[0].delay); }
  assert.deepEqual(delays, [5000, 15000, 60000, 300000, 300000, 300000]);
  reachable = true;
  await timers.fire();
  assert.equal((await keys.credentialFor(config)).authToken, 'fake-token-1');
  assert.ok(logs.some(line => /answered again/.test(line)));
  const again = await keys.credentialFor(config);
  assert.equal(again.authToken, 'fake-token-1');
  assert.equal(logs.filter(line => /embedded key/.test(line)).length, 1, 'no second report');
});

test('fallback switched off: an unreachable backend means no turn, with a plain error', async () => {
  const timers = fakeTimers();
  const tokens = new TokenSource({url: 'https://auth.example.invalid/t', secret: SIGNING_SECRET, installId: INSTALL, fallback: false,
    fetchImpl: () => Promise.reject(new TypeError('fetch failed')), now: () => 0, setTimer: timers.setTimer, clearTimer: timers.clearTimer});
  const keys = await keysWith(tokens);
  tokens.start(); await flush();
  await assert.rejects(keys.credentialFor(config), /sign-in is unavailable \(unreachable\) \[convai-auth:unreachable\]/);
  await assert.rejects(keys.credential(), /unavailable/);
});

test('server errors and broken answers count as an unreachable backend, so the embedded key may stand in', async () => {
  for (const make of [() => new Response('<html>nope</html>', {status: 404}), () => new Response('{}', {status: 502}),
    () => Response.json({error: 'unavailable'}, {status: 503}), () => Response.json({error: 'unauthorized'}, {status: 401}),
    () => Response.json({authToken: 'x'}, {status: 200}), () => Response.json({error: 'bad_request'}, {status: 400})]) {
    const timers = fakeTimers();
    const tokens = new TokenSource({url: 'https://auth.example.invalid/t', secret: SIGNING_SECRET, installId: INSTALL,
      fetchImpl: async () => make(), now: () => 0, setTimer: timers.setTimer, clearTimer: timers.clearTimer});
    const keys = await keysWith(tokens);
    tokens.start(); await flush();
    assert.equal((await keys.credentialFor(config)).key, SHARED);
  }
});

test('a backend that REFUSES is obeyed: the daily allowance blocks turns with the same notice as the local gate, and never falls back', async () => {
  const world = createWorld({CONVAI_AUTH_DAILY_TURN_CAP: '10'});
  const {tokens, timers, logs} = source(world);
  const keys = await keysWith(tokens);
  tokens.start(); await flush();
  assert.equal(tokens.current().token, 'fake-token-1');
  for (let turn = 0; turn < 10; turn++) tokens.noteTurn();
  world.advance(HOUR - 9 * MINUTE);
  await timers.fire(); // the renewal reports 10 turns: the allowance is used
  assert.equal(tokens.snapshot().lastKind, 'daily');
  assert.equal(tokens.pending, 0, 'the backend recorded those turns');
  assert.throws(() => keys.assertAllowed(), error => error instanceof TurnLimitError && error.kind === 'daily' && LIMIT_MARKER.test(error.message));
  assert.equal(classifyFailure((() => { try { keys.assertAllowed(); } catch (error) { return error; } })()), 'daily');
  // The old token has run out: still no fallback to the embedded key.
  world.advance(10 * MINUTE);
  await assert.rejects(keys.credentialFor(config), error => error instanceof TurnLimitError);
  assert.ok(logs.every(line => !/embedded key/.test(line)));
  // It retries when the day resets, and turns are allowed again.
  const [retry] = timers.live;
  assert.ok(retry.delay > 0 && retry.delay < 24 * HOUR + MINUTE * 2);
  world.advance(14 * HOUR);
  await timers.fire();
  assert.equal(tokens.snapshot().lastKind, 'ok');
  keys.assertAllowed();
  assert.equal((await keys.credentialFor(config)).authToken.startsWith('fake-token-'), true);
});

test('paused, outdated, refused, busy and rate answers are obeyed too; none lets the embedded key through', async () => {
  const cases = [
    ['paused', 503, {error: 'paused'}], ['outdated', 426, {error: 'outdated', minClient: '0.3'}], ['refused', 403, {error: 'refused'}],
    ['busy', 503, {error: 'busy'}], ['rate', 429, {error: 'rate', retryAfterSeconds: 120}],
  ];
  for (const [kind, status, body] of cases) {
    const timers = fakeTimers();
    const tokens = new TokenSource({url: 'https://auth.example.invalid/t', secret: SIGNING_SECRET, installId: INSTALL, fallback: true,
      fetchImpl: async () => Response.json(body, {status}), now: () => 0, setTimer: timers.setTimer, clearTimer: timers.clearTimer});
    const keys = await keysWith(tokens);
    tokens.start(); await flush();
    assert.equal(tokens.snapshot().lastKind, kind);
    await assert.rejects(keys.credentialFor(config), error => /\[convai-(auth|quota):/.test(error.message), kind);
    assert.equal(tokens.fallbackAllowed(), false, kind);
  }
  const timers = fakeTimers();
  const tokens = new TokenSource({url: 'https://auth.example.invalid/t', secret: SIGNING_SECRET, installId: INSTALL,
    fetchImpl: async () => Response.json({error: 'rate', retryAfterSeconds: 120}, {status: 429}), now: () => 0, setTimer: timers.setTimer, clearTimer: timers.clearTimer});
  tokens.start(); await flush();
  assert.equal(timers.live[0].delay, 120_000, 'the backend says when to ask again');
});

test('reported turns are counted once: a busy answer does not repeat them, a report is at most 1000, and self-inflicted rate limits fall back', async () => {
  const bodies = [];
  const answers = [[503, {error: 'busy', retryAfterSeconds: 900}], [503, {error: 'busy', retryAfterSeconds: 900}]];
  const timers = fakeTimers();
  const tokens = new TokenSource({url: 'https://auth.example.invalid/t', secret: SIGNING_SECRET, installId: INSTALL, fallback: true,
    fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); const [status, body] = answers.shift() ?? [503, {error: 'busy'}]; return Response.json(body, {status}); },
    now: () => 0, setTimer: timers.setTimer, clearTimer: timers.clearTimer});
  for (let turn = 0; turn < 40; turn++) tokens.noteTurn();
  tokens.start(); await flush();
  await timers.fire();
  assert.deepEqual(bodies.map(body => body.turnsSinceLast), [40, 0], 'the backend counted the 40 before it said busy');
  // A long outage: the pending count is sent in reports the backend accepts.
  const more = new TokenSource({url: 'https://auth.example.invalid/t', secret: SIGNING_SECRET, installId: INSTALL,
    fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); return Response.json({error: 'bad_request'}, {status: 400}); },
    now: () => 0, setTimer: fakeTimers().setTimer, clearTimer: () => {}});
  for (let turn = 0; turn < 5000; turn++) more.noteTurn();
  bodies.length = 0; more.start(); await flush();
  assert.equal(bodies[0].turnsSinceLast, 1000);
  // Failed attempts, then the backend's per-install hourly limit that those attempts used up: the embedded key stands in.
  const fails = new TokenSource({url: 'https://auth.example.invalid/t', secret: SIGNING_SECRET, installId: INSTALL, fallback: true,
    fetchImpl: async () => calls++ < 2 ? Response.json({error: 'convai_unavailable'}, {status: 502}) : Response.json({error: 'rate', retryAfterSeconds: 3000}, {status: 429}),
    now: () => 0, setTimer: timers.setTimer, clearTimer: timers.clearTimer});
  let calls = 0;
  fails.start(); await flush(); await timers.fire(); await timers.fire();
  assert.equal(fails.fallbackAllowed(), true);
  // A first answer of "rate" with nothing failed before is still obeyed (covered above).
});

test('a clock that is off is corrected from the backend\'s server time and the request is repeated at once', async () => {
  const world = createWorld();
  const {tokens, timers, backend} = source(world, {now: () => world.clock.now - 10 * MINUTE});
  tokens.start(); await flush();
  assert.equal(backend.calls.length, 1);
  assert.equal(tokens.snapshot().lastKind, 'stale');
  assert.equal(tokens.current(), null);
  assert.equal(timers.live[0].delay, 0, 'asked again at once, not after a back-off');
  await timers.fire();
  assert.equal(backend.calls.length, 2, 'signed again with the server\'s time');
  assert.equal(tokens.snapshot().lastKind, 'ok');
  assert.equal(tokens.current().token, 'fake-token-1');
});

test('a backend that returns the same token (an older deployment) is asked again only a few minutes before expiry', async () => {
  const timers = fakeTimers(), clock = {now: 1_000_000};
  const expiresAt = new Date(clock.now + 20 * MINUTE).toISOString();
  const tokens = new TokenSource({url: 'https://auth.example.invalid/t', secret: SIGNING_SECRET, installId: INSTALL,
    fetchImpl: async () => Response.json({authToken: 'same-token-value', expiresAt}), now: () => clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, random: () => 0});
  tokens.start(); await flush();
  assert.equal(timers.live[0].delay, 12 * MINUTE, 'life 20 min minus the 8 minute lead');
  clock.now += 12 * MINUTE;
  await timers.fire();
  assert.equal(timers.live[0].delay, 4 * MINUTE, 'same token again: next try at 4 minutes before it ends');
});

test('a player\'s own key is untouched: the backend is never asked for it, and its credential is the key', async () => {
  const world = createWorld();
  const {tokens, backend} = source(world);
  const keys = await keysWith(tokens, {own: `api-key=${PLAYER}\n`});
  keys.setPreference(true); keys.apply();
  assert.equal(keys.source, 'player');
  assert.equal(keys.usesBackend, false);
  const own = {key: PLAYER, characterId: 'alex'};
  assert.equal(await keys.credentialFor(own), own, 'the very same config, nothing replaced');
  assert.deepEqual(await keys.credential(), {apiKey: PLAYER});
  keys.assertAllowed(); // a backend refusal never applies to a player's own key
  assert.equal(backend.calls.length, 0);
  // And without backend mode at all nothing changes for the shared key either.
  const plain = await new ConvaiKeys({sharedKey: SHARED, playerKeyPath: 'x', readText: async () => { throw Error('none'); }}).load();
  assert.equal(await plain.credentialFor(config), config);
  assert.deepEqual(await plain.credential(), {apiKey: SHARED});
});

test('a snapshot never contains a token or the secret', async () => {
  const world = createWorld();
  const {tokens} = source(world);
  tokens.start(); await flush();
  const text = JSON.stringify(tokens.snapshot()) + JSON.stringify(tokens);
  assert.ok(!text.includes('fake-token') && !text.includes(SIGNING_SECRET));
  assert.equal(tokens.snapshot().installTail, INSTALL.slice(-4));
});

test('the host asks for the credential when it calls a page, so a renewed token is used without reconnecting anything', async () => {
  const seen = [];
  const page = {evaluate: async (fn, argument) => { seen.push(argument.config); return {sessionID: 's'}; }};
  let token = 'token-one';
  const host = new RealtimeHost({credential: async config => { const {key, ...rest} = config; return {...rest, authToken: token}; }, launchBrowser: () => assert.fail('no browser')});
  await host.evaluateSpeech(page, 'warm', {key: SHARED, characterId: 'alex', ttsEnabled: false});
  token = 'token-two';
  await host.evaluateSpeech(page, 'warm', {key: SHARED, characterId: 'alex', ttsEnabled: false});
  assert.deepEqual(seen.map(config => config.authToken), ['token-one', 'token-two']);
  assert.ok(seen.every(config => !('key' in config)));
  const plain = new RealtimeHost({launchBrowser: () => assert.fail('no browser')});
  await plain.evaluateSpeech(page, 'warm', {key: SHARED, characterId: 'alex', ttsEnabled: false});
  assert.equal(seen[2].key, SHARED, 'without a credential hook the config is sent as it always was');
});

test('the daily limit the backend reports reaches the bridge with the token; bad values are ignored; a raised limit lets a blocked install through', async () => {
  const world = createWorld({CONVAI_AUTH_DAILY_TURN_CAP: '10'});
  const heard = [];
  const {tokens, timers} = source(world, {onLimit: value => heard.push(value)});
  const keys = await keysWith(tokens);
  tokens.start(); await flush();
  assert.deepEqual(heard, [10]);
  assert.equal(tokens.snapshot().dailyLimit, 10);
  // The owner changes the limit in the store (what POST /api/admin/config does) and the next token carries the new number.
  await world.store.command(['SET', 'cfg:dailyInteractionLimit', '25']);
  world.advance(HOUR - 9 * MINUTE);
  await timers.fire();
  assert.deepEqual(heard, [10, 25]);
  assert.equal(tokens.snapshot().allowance.limit, 25);
  // A junk stored value never reaches the bridge as junk: the backend falls back to its environment's number.
  await world.store.command(['SET', 'cfg:dailyInteractionLimit', 'junk']);
  world.advance(HOUR - 9 * MINUTE);
  await timers.fire();
  assert.equal(tokens.dailyLimit, 10);
  // Used up, then raised: the install is let through at the next half-hourly check, not at midnight.
  for (let turn = 0; turn < 10; turn++) tokens.noteTurn();
  world.advance(HOUR - 9 * MINUTE);
  await timers.fire();
  assert.equal(tokens.snapshot().lastKind, 'daily');
  assert.equal(tokens.snapshot().dailyLimit, 10, 'the refusal carries the limit too');
  assert.throws(() => keys.assertAllowed(), error => error.kind === 'daily');
  const [recheck] = timers.live;
  assert.ok(recheck.delay <= 31 * MINUTE, 'it asks again within half an hour');
  await world.store.command(['SET', 'cfg:dailyInteractionLimit', '40']);
  world.advance(31 * MINUTE);
  await timers.fire();
  assert.equal(tokens.snapshot().lastKind, 'ok');
  keys.assertAllowed();
  assert.deepEqual(heard.slice(-1), [40]);
});

test('a malformed limit in an answer is ignored and the last good one stays', async () => {
  for (const bad of [0, -4, 99999, 1.5, 'lots', null, {}]) {
    const heard = [];
    const timers = fakeTimers();
    let answers = 0;
    const tokens = new TokenSource({url: 'https://auth.example.invalid/t', secret: SIGNING_SECRET, installId: INSTALL, now: () => 0,
      setTimer: timers.setTimer, clearTimer: timers.clearTimer, onLimit: value => heard.push(value),
      fetchImpl: async () => Response.json({authToken: 'fake-token-xyz-' + (++answers), expiresAt: new Date(3_600_000).toISOString(),
        ...(answers === 1 ? {dailyInteractionLimit: 150} : {dailyInteractionLimit: bad, allowance: {used: 0, limit: bad}})})});
    tokens.start(); await flush();
    await timers.fire();
    assert.deepEqual(heard, [150], `${JSON.stringify(bad)} is not a limit`);
    assert.equal(tokens.dailyLimit, 150);
  }
});

test('an older deployment that sends only allowance.limit still sets the limit', async () => {
  const heard = [], timers = fakeTimers();
  const tokens = new TokenSource({url: 'https://auth.example.invalid/t', secret: SIGNING_SECRET, installId: INSTALL, now: () => 0,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer, onLimit: value => heard.push(value),
    fetchImpl: async () => Response.json({authToken: 'fake-token-old-1', expiresAt: new Date(3_600_000).toISOString(), allowance: {used: 3, limit: 100}})});
  tokens.start(); await flush();
  assert.deepEqual(heard, [100]);
});
