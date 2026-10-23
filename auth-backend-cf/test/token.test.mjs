import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pseudonym, signBody } from '../src/crypto.js';
import { ADMIN_SECRET, FAKE_API_KEY, PSEUDONYM_SECRET, SIGNING_SECRET, asAdmin, captureErrors, createWorld } from '../testkit/world.mjs';

const HOUR = 3_600_000;

test('a signed request gets a token, the allowance and the server time', async () => {
  const world = createWorld();
  const response = await world.send({ turns: 3 });
  assert.equal(response.status, 200);
  assert.equal(response.json.authToken, 'fake-token-1');
  assert.equal(response.json.allowance.used, 3);
  assert.equal(response.json.allowance.limit, 100);
  assert.equal(response.json.dailyInteractionLimit, 100);
  assert.equal(response.json.serverTime, Math.floor(world.clock.now / 1000));
  assert.equal(response.json.allowance.resetAt, '2026-10-15T00:00:00.000Z');
  assert.equal(new Date(response.json.expiresAt).getTime(), world.clock.now + HOUR);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-auth-backend'], 'cloudflare-worker');
  assert.equal(world.convai.state.calls[0].headers['CONVAI-API-KEY'], FAKE_API_KEY);
});

test('shared mode: every install gets the one token, and only one mint is made, even for concurrent requests', async () => {
  const world = createWorld();
  const answers = await Promise.all(Array.from({ length: 5 }, () => world.send({ installId: randomUUID() })));
  assert.deepEqual(answers.map(answer => answer.json.authToken), Array(5).fill('fake-token-1'));
  assert.equal(world.convai.state.mints, 1);
  world.advance(10 * 60_000);
  assert.equal((await world.send({ installId: randomUUID() })).json.authToken, 'fake-token-1');
  assert.equal(world.convai.state.mints, 1);
});

test('shared mode: a token near its end is replaced, and minLifeSeconds widens the margin', async () => {
  const world = createWorld();
  await world.send();
  world.advance(53 * 60_000); // 7 minutes left: inside the 15 minutes a renewing bridge asks for, outside the server's 5
  assert.equal((await world.send()).json.authToken, 'fake-token-1');
  assert.equal((await world.send({ minLife: 900 })).json.authToken, 'fake-token-2');
  assert.equal(world.convai.state.mints, 2);
});

test('the shared token is kept in the store, so another isolate (a new app over the same store) does not mint again', async () => {
  const world = createWorld();
  await world.send();
  const { createApp } = await import('../src/app.js');
  const second = createApp({ now: () => world.clock.now, fetchImpl: world.convai.fetchImpl, stateFor: () => world.stubFor(world.stateEngine), errorsFor: () => null });
  const body = JSON.stringify({ installId: randomUUID(), modVersion: '0.2' });
  const timestamp = String(Math.floor(world.clock.now / 1000));
  const response = await second(new Request('https://x.invalid/api/convai/token', { method: 'POST', body, headers: { 'cf-connecting-ip': '198.51.100.1',
    'x-convai-timestamp': timestamp, 'x-convai-signature': await signBody(SIGNING_SECRET, timestamp, body) } }), world.env);
  assert.equal((await response.json()).authToken, 'fake-token-1');
  assert.equal(world.convai.state.mints, 1);
});

test('refusals: method, signature, stale clock, body', async () => {
  const world = createWorld();
  assert.equal((await world.call('/api/convai/token', { method: 'GET' })).status, 405);
  assert.equal((await world.send({ signature: 'v1=' + '0'.repeat(64) })).json.error, 'unauthorized');
  assert.equal((await world.send({ signature: 'nope' })).status, 401);
  const stale = await world.send({ timestamp: String(Math.floor(world.clock.now / 1000) - 600) });
  assert.equal(stale.status, 401);
  assert.equal(stale.json.error, 'stale');
  assert.equal(stale.json.serverTime, Math.floor(world.clock.now / 1000));
  const body = JSON.stringify({ installId: randomUUID(), modVersion: '0.2', pad: 'x'.repeat(5000) });
  assert.equal((await world.send({ body })).status, 413);
  // A request signed with the error-report secret is not a token request.
  const { REPORT_SECRET } = await import('../testkit/world.mjs');
  const ok = JSON.stringify({ installId: randomUUID(), modVersion: '0.2' });
  const timestamp = String(Math.floor(world.clock.now / 1000));
  assert.equal((await world.send({ body: ok, signature: await signBody(REPORT_SECRET, timestamp, ok) })).status, 401);
  assert.equal(world.convai.state.mints, 0);
});

test('bad fields are 400', async () => {
  const world = createWorld();
  for (const fields of [{ installId: 'not-a-uuid', modVersion: '0.2' }, { installId: randomUUID(), modVersion: 'x' },
    { installId: randomUUID(), modVersion: '0.2', turnsSinceLast: -1 }, { installId: randomUUID(), modVersion: '0.2', turnsSinceLast: 1001 },
    { installId: randomUUID(), modVersion: '0.2', turnsSinceLast: 1.5 }, { installId: randomUUID(), modVersion: '0.2', minLifeSeconds: 3601 }]) {
    assert.equal((await world.send({ body: JSON.stringify(fields) })).json.error, 'bad_request', JSON.stringify(fields));
  }
  assert.equal((await world.send({ body: '[]' })).status, 400);
  assert.equal((await world.send({ body: 'not json' })).status, 400);
});

test('paused and unconfigured answer before anything else', async () => {
  const paused = createWorld({ CONVAI_AUTH_PAUSED: '1' });
  const answer = await paused.send();
  assert.equal(answer.status, 503);
  assert.equal(answer.json.error, 'paused');
  assert.equal(answer.headers['retry-after'], '900');
  const missing = createWorld({ CONVAI_API_KEY: '' });
  assert.equal((await missing.send()).json.error, 'unconfigured');
  const shortSecret = createWorld({ CONVAI_AUTH_SIGNING_SECRET: 'short' });
  assert.equal((await shortSecret.send()).json.error, 'unconfigured');
  const noStore = createWorld({}, { appOptions: { stateFor: () => null } });
  assert.equal((await noStore.send()).json.error, 'unconfigured');
});

test('minimum version: 426 below, accepted at and above', async () => {
  const world = createWorld({ CONVAI_AUTH_MIN_VERSION: '0.2.9' });
  const old = await world.send({ version: '0.2.8' });
  assert.equal(old.status, 426);
  assert.equal(old.json.minClient, '0.2.9');
  assert.equal((await world.send({ version: '0.2.9' })).status, 200);
  assert.equal((await world.send({ version: '0.3' })).json.minClient, '0.2.9');
});

test('a blocked install (its keyed hash) is refused', async () => {
  const install = randomUUID();
  const blocked = await pseudonym(PSEUDONYM_SECRET, 'install', install);
  const world = createWorld({ CONVAI_AUTH_BLOCKED_INSTALLS: `x ${blocked}` });
  const answer = await world.send({ installId: install });
  assert.equal(answer.status, 403);
  assert.equal(answer.json.error, 'refused');
  assert.equal((await world.send()).status, 200);
});

test('per-install hourly limit, with the retry time at the next hour; it opens again then', async () => {
  const world = createWorld({ CONVAI_AUTH_INSTALL_PER_HOUR: '3' });
  for (let index = 0; index < 3; index++) assert.equal((await world.send()).status, 200);
  const limited = await world.send();
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error, 'rate');
  assert.equal(limited.json.retryAfterSeconds, 3600);
  assert.equal(limited.headers['retry-after'], '3600');
  world.advance(HOUR);
  assert.equal((await world.send()).status, 200);
});

test('per-address hourly limit counts every install behind the address, and an IPv6 caller as its /64', async () => {
  const world = createWorld({ CONVAI_AUTH_IP_PER_HOUR: '3' });
  for (let index = 0; index < 3; index++) assert.equal((await world.send({ installId: randomUUID(), ip: `2001:db8:1:2:${index}::${index}` })).status, 200);
  assert.equal((await world.send({ installId: randomUUID(), ip: '2001:db8:1:2:ffff::1' })).status, 429);
  assert.equal((await world.send({ installId: randomUUID(), ip: '2001:db8:1:3::1' })).status, 200);
  // an IPv4 address written as IPv6 is the IPv4 one
  const v4 = createWorld({ CONVAI_AUTH_IP_PER_HOUR: '1' });
  assert.equal((await v4.send({ ip: '198.51.100.9' })).status, 200);
  assert.equal((await v4.send({ installId: randomUUID(), ip: '::ffff:198.51.100.9' })).status, 429);
});

test('a request without the Cloudflare address header shares one strict bucket', async () => {
  const world = createWorld({ CONVAI_AUTH_IP_PER_HOUR: '2' });
  const send = installId => {
    const body = JSON.stringify({ installId, modVersion: '0.2', turnsSinceLast: 0 });
    return signBody(SIGNING_SECRET, String(Math.floor(world.clock.now / 1000)), body).then(signature => world.handle(new Request('https://x.invalid/api/convai/token', {
      method: 'POST', body, headers: { 'x-convai-timestamp': String(Math.floor(world.clock.now / 1000)), 'x-convai-signature': signature, 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 200)}` } }), world.env));
  };
  assert.equal((await send(randomUUID())).status, 200);
  assert.equal((await send(randomUUID())).status, 200);
  assert.equal((await send(randomUUID())).status, 429); // x-forwarded-for is not trusted
});

test('new installs per address per day: the sixth new install is refused, a known install is not counted again', async () => {
  const world = createWorld({ CONVAI_AUTH_NEW_INSTALLS_PER_IP_PER_DAY: '2' });
  const first = randomUUID();
  assert.equal((await world.send({ installId: first })).status, 200);
  assert.equal((await world.send({ installId: randomUUID() })).status, 200);
  const third = await world.send({ installId: randomUUID() });
  assert.equal(third.status, 429);
  assert.equal(third.json.error, 'install_limit');
  assert.equal(third.json.retryAfterSeconds, 14 * 3600);
  // the refused install was not remembered, so it still counts as new; the first one is known and passes
  assert.equal((await world.send({ installId: first })).status, 200);
  world.advance(14 * HOUR);
  assert.equal((await world.send({ installId: randomUUID() })).status, 200);
});

test('daily cap: reported turns add up, the request that reaches the cap is refused, the next UTC day starts again', async () => {
  const world = createWorld({ CONVAI_AUTH_DAILY_TURN_CAP: '10' });
  assert.equal((await world.send({ turns: 4 })).json.allowance.used, 4);
  assert.equal((await world.send({ turns: 5 })).json.allowance.used, 9);
  const over = await world.send({ turns: 1 });
  assert.equal(over.status, 429);
  assert.equal(over.json.error, 'daily');
  assert.equal(over.json.allowance.used, 10);
  assert.equal(over.json.dailyInteractionLimit, 10);
  assert.equal(over.json.resetAt, '2026-10-15T00:00:00.000Z');
  world.advance(14 * HOUR);
  const next = await world.send({ turns: 2 });
  assert.equal(next.status, 200);
  assert.equal(next.json.allowance.used, 2);
});

test('the stored daily limit (admin config) wins over the environment, and removing it brings the environment back', async () => {
  const world = createWorld({ CONVAI_AUTH_DAILY_TURN_CAP: '10' });
  const post = body => world.call('/api/admin/config', { method: 'POST', headers: asAdmin, body: JSON.stringify(body) });
  assert.equal((await post({ dailyInteractionLimit: 150 })).json.dailyInteractionLimit, 150);
  assert.equal((await world.send({ turns: 20 })).json.dailyInteractionLimit, 150);
  assert.equal((await post({ dailyInteractionLimit: null })).json.dailyInteractionLimit, 10);
  assert.equal((await world.send({ turns: 1 })).status, 429);
});

test('mint budget: when spent and no shared token is valid, 503 busy; a valid shared token is still served', async () => {
  const world = createWorld({ CONVAI_AUTH_MINTS_PER_DAY: '1' });
  assert.equal((await world.send()).status, 200);
  world.advance(HOUR - 90_000); // 90 s left: valid, but inside the 5-minute margin so it wants a mint
  const served = await world.send();
  assert.equal(served.status, 200);
  assert.equal(served.json.authToken, 'fake-token-1');
  world.advance(40_000); // 50 s left: under the 60 s a stale token must still have
  const busy = await world.send();
  assert.equal(busy.status, 503);
  assert.equal(busy.json.error, 'busy');
  assert.equal(busy.json.retryAfterSeconds, 900);
  assert.equal(world.convai.state.mints, 1);
});

test('Convai failing: 502, or the shared token that is still valid', async () => {
  const world = createWorld();
  world.convai.state.failing = true;
  const failed = await world.send();
  assert.equal(failed.status, 502);
  assert.equal(failed.json.error, 'convai_unavailable');
  world.convai.state.failing = false;
  assert.equal((await world.send()).status, 200);
  world.advance(HOUR - 120_000);
  world.convai.state.failing = true;
  assert.equal((await world.send()).json.authToken, 'fake-token-1');
});

test('the key and the secrets never reach a log or a response', async () => {
  const world = createWorld();
  world.convai.state.failing = true;
  let response;
  const logged = await captureErrors(async () => { response = await world.send(); });
  for (const secret of [FAKE_API_KEY, SIGNING_SECRET, ADMIN_SECRET, PSEUDONYM_SECRET]) {
    assert.ok(!logged.includes(secret) && !response.text.includes(secret));
  }
});

test('the store failing fails closed with 503 and Retry-After 30', async () => {
  const world = createWorld({}, { appOptions: { stateFor: () => ({ admit: async () => { throw new Error('boom'); } }) } });
  let response;
  const logged = await captureErrors(async () => { response = await world.send(); });
  assert.equal(response.status, 503);
  assert.equal(response.json.error, 'unavailable');
  assert.equal(response.headers['retry-after'], '30');
  assert.match(logged, /store unavailable/);
});

test('the per-isolate flood guard answers 429 after 60 requests a minute from one address, without touching the store', async () => {
  const world = createWorld();
  for (let index = 0; index < 60; index++) await world.send();
  const calls = world.stateStorage.calls.get;
  const flooded = await world.send();
  assert.equal(flooded.status, 429);
  assert.equal(flooded.json.retryAfterSeconds, 60);
  assert.equal(world.stateStorage.calls.get, calls);
});

// --- per-install mode ----------------------------------------------------------------------------------------------------------

test('per-install mode: each install has its own token, a repeat returns it from the store', async () => {
  const world = createWorld({ CONVAI_AUTH_MODE: 'per-install' });
  const one = randomUUID();
  assert.equal((await world.send({ installId: one })).json.authToken, 'fake-token-1');
  assert.equal((await world.send({ installId: randomUUID() })).json.authToken, 'fake-token-2');
  assert.equal((await world.send({ installId: one })).json.authToken, 'fake-token-1');
  assert.equal(world.convai.state.mints, 2);
  world.advance(56 * 60_000);
  assert.equal((await world.send({ installId: one })).json.authToken, 'fake-token-3');
});

test('per-install mode: at the daily cap the install\'s token is revoked and forgotten', async () => {
  const world = createWorld({ CONVAI_AUTH_MODE: 'per-install', CONVAI_AUTH_DAILY_TURN_CAP: '5' });
  assert.equal((await world.send({ turns: 1 })).status, 200);
  const over = await world.send({ turns: 4 });
  assert.equal(over.status, 429);
  assert.deepEqual(world.convai.state.revokes, ['fake-token-1']);
  assert.ok(![...world.stateStorage.data.keys()].some(key => key.startsWith('tok:')));
});

test('per-install mode: concurrent requests of one install mint once', async () => {
  const world = createWorld({ CONVAI_AUTH_MODE: 'per-install' });
  const install = randomUUID();
  const answers = await Promise.all([world.send({ installId: install }), world.send({ installId: install }), world.send({ installId: install })]);
  assert.deepEqual(answers.map(answer => answer.status), [200, 200, 200]);
  assert.equal(world.convai.state.mints, 1);
});

// --- storage -------------------------------------------------------------------------------------------------------------------

test('expired counters are swept, at most every 6 hours, and current ones stay', async () => {
  const world = createWorld();
  await world.send();
  const firstHour = `:${Math.floor(world.clock.now / HOUR)}`;
  const hourly = () => [...world.stateStorage.data.keys()].filter(key => (key.startsWith('ip:') || key.startsWith('in:')) && key.endsWith(firstHour));
  assert.equal(hourly().length, 2);
  world.advance(4 * HOUR); // over their 2 hours but under 6 hours since the sweep: still there, though ignored
  await world.send({ installId: randomUUID(), ip: '198.51.100.20' });
  assert.equal(hourly().length, 2);
  world.advance(3 * HOUR); // 7 hours since the sweep
  await world.send({ installId: randomUUID(), ip: '198.51.100.21' });
  assert.equal(hourly().length, 0);
  assert.ok([...world.stateStorage.data.keys()].some(key => key.startsWith('turns:2026-10-14')));
});

test('a token request costs one batched read and at most two writes of the store', async () => {
  const world = createWorld();
  await world.send(); // first: also sweeps
  const before = { ...world.stateStorage.calls };
  await world.send();
  const used = Object.fromEntries(Object.entries(world.stateStorage.calls).map(([name, value]) => [name, value - before[name]]));
  assert.equal(used.get, 1);
  assert.ok(used.put <= 1 && used.delete === 0 && used.list === 0, JSON.stringify(used));
});

test('routes: health, ready, unknown paths, HEAD', async () => {
  const world = createWorld();
  assert.deepEqual((await world.call('/api/healthz')).json, { status: 'ok' });
  const ready = await world.call('/api/readyz');
  assert.equal(ready.status, 200);
  assert.equal(ready.json.status, 'ready');
  assert.equal(ready.json.secretsSeparate, true);
  assert.equal(ready.json.env.CONVAI_API_KEY, true);
  assert.ok(!ready.text.includes(FAKE_API_KEY));
  const notReady = await world.call('/api/readyz', { envOverride: { ...world.env, CONVAI_API_KEY: '' } });
  assert.equal(notReady.status, 503);
  assert.equal((await world.call('/api/readyz?ping=1', { headers: asAdmin })).json.store, 'ok');
  assert.equal((await world.call('/api/readyz?ping=1')).json.store, undefined);
  assert.equal((await world.call('/api/nothing')).status, 404);
  const head = await world.call('/api/healthz', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal((await world.call('/api/healthz', { method: 'POST' })).status, 405);
});

test('admin turns: needs the admin secret, lists the day\'s installs by turns', async () => {
  const world = createWorld();
  const heavy = randomUUID();
  await world.send({ installId: heavy, turns: 7 });
  await world.send({ installId: randomUUID(), turns: 2 });
  assert.equal((await world.call('/api/admin/turns')).status, 401);
  assert.equal((await world.call('/api/admin/turns', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const none = createWorld({ CONVAI_AUTH_ADMIN_SECRET: '' });
  assert.equal((await none.call('/api/admin/turns', { headers: asAdmin })).status, 404);
  const report = await world.call('/api/admin/turns', { headers: asAdmin });
  assert.equal(report.status, 200);
  assert.equal(report.json.day, '2026-10-14');
  assert.equal(report.json.installsReporting, 2);
  assert.equal(report.json.tokenMintsAttempted, 1);
  assert.equal(report.json.dailyTurnCap, 100);
  assert.deepEqual(report.json.top.map(row => row.turns), [7, 2]);
  assert.equal(report.json.top[0].install, await pseudonym(PSEUDONYM_SECRET, 'install', heavy));
});

test('admin config: validation, the paid plans list, and the public plans endpoint', async () => {
  const world = createWorld();
  const post = body => world.call('/api/admin/config', { method: 'POST', headers: asAdmin, body: typeof body === 'string' ? body : JSON.stringify(body) });
  for (const bad of [{}, { dailyInteractionLimit: 0 }, { dailyInteractionLimit: 10001 }, { dailyInteractionLimit: 1.5 }, { dailyInteractionLimit: 'x' }]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await post('nope')).status, 400);
  assert.deepEqual((await world.call('/api/convai/plans')).json, { version: 1, config: null });
  const plans = { plans: [{ id: 'basic', name: 'Basic', period: 'monthly', price: '$5.00', priceId: 'price_ABCDEFGH12' }], junk: 1 };
  assert.equal((await post({ paidPlans: { plans: [] } })).json.error, 'bad_plans');
  const stored = await post({ paidPlans: plans });
  assert.equal(stored.status, 200);
  assert.equal(stored.json.paidPlans.plans[0].id, 'basic');
  assert.equal(stored.json.paidPlans.junk, undefined);
  world.advance(61_000); // the plans are cached for a minute per isolate
  assert.equal((await world.call('/api/convai/plans')).json.config.plans[0].priceId, 'price_ABCDEFGH12');
  assert.equal((await post({ paidPlans: null })).json.paidPlans, null);
  const read = await world.call('/api/admin/config', { headers: asAdmin });
  assert.equal(read.json.environmentDefault, 100);
  assert.equal(read.json.min, 1);
  assert.equal(read.json.max, 10000);
});
