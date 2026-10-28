import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAdminConfigHandler, createAdminTurnsHandler, createReadyHandler, healthHandler } from '../api/_lib/admin.js';
import { ADMIN_SECRET, FAKE_API_KEY, SIGNING_SECRET, START, createWorld, makeEnv, mockResponse } from '../testkit/harness.mjs';

const call = async (handler, { method = 'GET', url = '/', headers = {} } = {}) => {
  const response = mockResponse();
  await handler({ method, url, headers }, response);
  return response;
};
const asAdmin = { authorization: `Bearer ${ADMIN_SECRET}` };

test('the admin list shows per-install daily totals, heaviest first, by hash only', async () => {
  const world = createWorld();
  const heavy = randomUUID(), light = randomUUID();
  await world.send({ installId: heavy, turns: 80 });
  await world.send({ installId: light, turns: 5 });
  await world.send({ installId: heavy, turns: 10 });
  const handler = createAdminTurnsHandler({ env: world.env, store: world.store, now: () => world.clock.now });
  const response = await call(handler, { url: '/api/admin/turns', headers: asAdmin });
  assert.equal(response.statusCode, 200);
  const body = response.json;
  assert.equal(body.day, '2026-10-14');
  assert.equal(body.installsReporting, 2);
  assert.deepEqual(body.top.map(row => row.turns), [90, 5]);
  assert.match(body.top[0].install, /^[0-9a-f]{24}$/);
  assert.ok(!response.text.includes(heavy) && !response.text.includes(light), 'raw install ids are never shown');
  assert.equal(body.dailyTurnCap, 500);
  assert.equal(body.tokenMintsAttempted, 1);
  const limited = await call(handler, { url: '/api/admin/turns?limit=1&day=2026-10-14', headers: asAdmin });
  assert.equal(limited.json.top.length, 1);
});

test('the admin list needs the admin secret, and is hidden when none is set', async () => {
  const world = createWorld();
  const handler = createAdminTurnsHandler({ env: world.env, store: world.store });
  assert.equal((await call(handler)).statusCode, 401);
  assert.equal((await call(handler, { headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  assert.equal((await call(handler, { headers: { authorization: `Bearer ${SIGNING_SECRET}` } })).statusCode, 401, 'the signing secret is not the admin secret');
  assert.equal((await call(handler, { method: 'POST', headers: asAdmin })).statusCode, 405);
  const env = makeEnv();
  delete env.CONVAI_AUTH_ADMIN_SECRET;
  assert.equal((await call(createAdminTurnsHandler({ env, store: world.store }), { headers: asAdmin })).statusCode, 404);
  env.CONVAI_AUTH_ADMIN_SECRET = 'short';
  assert.equal((await call(createAdminTurnsHandler({ env, store: world.store }), { headers: { authorization: 'Bearer short' } })).statusCode, 404, 'a short secret is never accepted');
});

test('the admin list fails closed when the store is down', async () => {
  const world = createWorld();
  world.store.failing = true;
  const handler = createAdminTurnsHandler({ env: world.env, store: world.store, now: () => START });
  assert.equal((await call(handler, { headers: asAdmin })).statusCode, 503);
});

test('/readyz reports only booleans, never a value, and touches no store by default', async () => {
  const world = createWorld({ CONVAI_AUTH_MIN_VERSION: '0.2.1' });
  const handler = createReadyHandler({ env: world.env, store: world.store });
  const response = await call(handler, { url: '/api/readyz' });
  assert.equal(response.statusCode, 200);
  const body = response.json;
  assert.equal(body.status, 'ready');
  assert.equal(body.env.CONVAI_API_KEY, true);
  assert.equal(body.env.CONVAI_AUTH_ADMIN_SECRET, true);
  assert.equal(body.env.KV_REST_API_URL, false);
  assert.equal(body.env.CONVAI_AUTH_BLOCKED_INSTALLS, false);
  assert.ok(Object.values(body.env).every(value => typeof value === 'boolean'));
  for (const secret of [FAKE_API_KEY, SIGNING_SECRET, ADMIN_SECRET, 'fake-store-token', 'store.invalid', '0.2.1']) {
    assert.ok(!response.text.includes(secret), `the report must not contain ${secret}`);
  }
  assert.equal(world.store.commands, 0);
  const publicPing = await call(handler, { url: '/api/readyz?ping=1' });
  assert.equal(publicPing.json.store, undefined, 'the public cannot make the service spend a Redis command');
  assert.equal(world.store.commands, 0);
});

test('/readyz?ping=1 with the admin secret spends exactly one PING', async () => {
  const world = createWorld();
  const handler = createReadyHandler({ env: world.env, store: world.store });
  const response = await call(handler, { url: '/api/readyz?ping=1', headers: asAdmin });
  assert.equal(response.json.store, 'ok');
  assert.deepEqual(world.store.log, ['PING']);
  world.store.failing = true;
  const down = await call(handler, { url: '/api/readyz?ping=1', headers: asAdmin });
  assert.equal(down.statusCode, 503);
  assert.equal(down.json.store, 'unreachable');
});

test('/readyz says not_ready when a required setting is missing', async () => {
  const env = makeEnv();
  delete env.CONVAI_API_KEY;
  const response = await call(createReadyHandler({ env }), { url: '/api/readyz' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json.status, 'not_ready');
  assert.equal(response.json.env.CONVAI_API_KEY, false);
});

test('/healthz never touches the store or Convai', async () => {
  const response = await call(healthHandler, { url: '/api/healthz' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json, { status: 'ok' });
  assert.equal((await call(healthHandler, { method: 'POST' })).statusCode, 405);
});

const post = (handler, body, headers = asAdmin) => call(handler, { method: 'POST', url: '/api/admin/config', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const callWithBody = async (handler, { method, headers, body }) => {
  const response = mockResponse();
  await handler({ method, url: '/api/admin/config', headers, body }, response);
  return response;
};

test('the admin config sets, shows and removes the daily limit, and the token endpoint uses it at once', async () => {
  const world = createWorld({ CONVAI_AUTH_DAILY_TURN_CAP: '100' });
  const handler = createAdminConfigHandler({ env: world.env, store: world.store });
  const shown = await call(handler, { url: '/api/admin/config', headers: asAdmin });
  assert.deepEqual(shown.json, { dailyInteractionLimit: 100, stored: null, environmentDefault: 100, min: 1, max: 10000, paidPlans: null });
  const set = await callWithBody(handler, { method: 'POST', headers: asAdmin, body: JSON.stringify({ dailyInteractionLimit: 150 }) });
  assert.equal(set.statusCode, 200);
  assert.equal(set.json.dailyInteractionLimit, 150);
  assert.equal(set.json.stored, 150);
  const first = await world.send({ turns: 120 });
  assert.equal(first.statusCode, 200, 'under the new limit of 150');
  assert.equal(first.json.dailyInteractionLimit, 150);
  assert.deepEqual(first.json.allowance, { used: 120, limit: 150, resetAt: '2026-10-15T00:00:00.000Z' });
  const capped = await world.send({ turns: 30 });
  assert.equal(capped.statusCode, 429);
  assert.equal(capped.json.error, 'daily');
  assert.equal(capped.json.allowance.limit, 150);
  const lowered = await callWithBody(handler, { method: 'POST', headers: asAdmin, body: JSON.stringify({ dailyInteractionLimit: 20 }) });
  assert.equal(lowered.json.dailyInteractionLimit, 20);
  const refused = await world.send({ installId: randomUUID(), turns: 25 });
  assert.equal(refused.statusCode, 429, 'a lowered limit applies to the next request');
  assert.equal(refused.json.allowance.limit, 20);
  const removed = await callWithBody(handler, { method: 'POST', headers: asAdmin, body: JSON.stringify({ dailyInteractionLimit: null }) });
  assert.deepEqual(removed.json, { dailyInteractionLimit: 100, stored: null, environmentDefault: 100, min: 1, max: 10000, paidPlans: null });
  const back = await world.send({ installId: randomUUID(), turns: 50 });
  assert.equal(back.json.allowance.limit, 100);
  const turns = await call(createAdminTurnsHandler({ env: world.env, store: world.store, now: () => world.clock.now }), { headers: asAdmin });
  assert.equal(turns.json.dailyTurnCap, 100);
});

test('the daily limit costs no extra store command on a token request', async () => {
  const world = createWorld();
  await world.send({ turns: 1 });
  world.store.commands = 0;
  const handler = createAdminConfigHandler({ env: world.env, store: world.store });
  await callWithBody(handler, { method: 'POST', headers: asAdmin, body: JSON.stringify({ dailyInteractionLimit: 200 }) });
  world.store.commands = 0;
  assert.equal((await world.send({ turns: 1 })).statusCode, 200);
  assert.equal(world.store.commands, 1, 'one script, however many limits it reads');
});

test('the admin config refuses bad values, bad bodies, the wrong secret and the wrong method', async () => {
  const world = createWorld();
  const handler = createAdminConfigHandler({ env: world.env, store: world.store });
  for (const bad of [0, -5, 10001, 1.5, 'lots', true, [], {}]) {
    const response = await callWithBody(handler, { method: 'POST', headers: asAdmin, body: JSON.stringify({ dailyInteractionLimit: bad }) });
    assert.equal(response.statusCode, 400, `${JSON.stringify(bad)} is refused`);
  }
  assert.equal((await callWithBody(handler, { method: 'POST', headers: asAdmin, body: 'not json' })).statusCode, 400);
  assert.equal((await callWithBody(handler, { method: 'POST', headers: asAdmin, body: '{}' })).statusCode, 400);
  assert.equal((await callWithBody(handler, { method: 'POST', headers: asAdmin, body: JSON.stringify({ dailyInteractionLimit: '175' }) })).json.dailyInteractionLimit, 175, 'a whole number in a string is accepted');
  assert.equal((await callWithBody(handler, { method: 'POST', headers: {}, body: JSON.stringify({ dailyInteractionLimit: 5 }) })).statusCode, 401);
  assert.equal((await callWithBody(handler, { method: 'POST', headers: { authorization: `Bearer ${SIGNING_SECRET}` }, body: JSON.stringify({ dailyInteractionLimit: 5 }) })).statusCode, 401);
  assert.equal((await call(handler, { method: 'PUT', headers: asAdmin })).statusCode, 405);
  assert.equal((await call(handler, { headers: asAdmin })).json.dailyInteractionLimit, 175, 'the refused requests changed nothing');
  const env = makeEnv();
  delete env.CONVAI_AUTH_ADMIN_SECRET;
  assert.equal((await call(createAdminConfigHandler({ env, store: world.store }), { headers: asAdmin })).statusCode, 404);
  world.store.failing = true;
  assert.equal((await call(handler, { headers: asAdmin })).statusCode, 503);
});

test('a stored value outside the accepted range is ignored by the token endpoint', async () => {
  const world = createWorld({ CONVAI_AUTH_DAILY_TURN_CAP: '100' });
  for (const junk of ['0', '-3', '99999', 'abc', '12.5']) {
    await world.store.command(['SET', 'cfg:dailyInteractionLimit', junk]);
    const response = await world.send({ installId: randomUUID(), turns: 1 });
    assert.equal(response.json.allowance.limit, 100, `${junk} falls back to the environment's value`);
  }
});
