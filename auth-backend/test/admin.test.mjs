import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAdminTurnsHandler, createReadyHandler, healthHandler } from '../api/_lib/admin.js';
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
  assert.equal(body.dailyTurnCap, 100);
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
