// The Convai paid tier's plan list: set through the admin config, read publicly by the mod (docs/CONVAI_PAID_TIER.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminConfigHandler } from '../api/_lib/admin.js';
import { createPlansHandler, validPaidPlans, PLANS_KEY } from '../api/_lib/plans.js';
import { ADMIN_SECRET, createWorld, makeEnv, mockResponse } from '../testkit/harness.mjs';

const asAdmin = { authorization: `Bearer ${ADMIN_SECRET}` };
const call = async (handler, { method = 'GET', url = '/api/convai/plans', headers = {}, body } = {}) => {
  const response = mockResponse();
  await handler({ method, url, headers, body }, response);
  return response;
};
const PLANS = {
  plans: [
    { id: 'gamer-monthly', name: 'Gamer', period: 'monthly', price: '$4', priceId: 'price_1UQj9YHC9LzXKZDPTHUfkDuj', interactions: 1000, concurrency: 6 },
    { id: 'pro-yearly', name: 'Gamer Pro', period: 'yearly', price: '$64', priceId: 'price_1UQjPvHC9LzXKZDPXqfCGpP0' },
  ],
  manageUrl: 'https://convai.com/management/billing',
};

test('the admin config stores, shows and removes the plan list, and the public endpoint serves it', async () => {
  const world = createWorld();
  const admin = createAdminConfigHandler({ env: world.env, store: world.store });
  let clock = 1_000_000;
  const plans = createPlansHandler({ env: world.env, store: world.store, now: () => clock });
  assert.deepEqual((await call(plans)).json, { version: 1, config: null }, 'nothing stored: the mod keeps its own list');
  const set = await call(admin, { method: 'POST', url: '/api/admin/config', headers: asAdmin, body: JSON.stringify({ paidPlans: PLANS }) });
  assert.equal(set.statusCode, 200);
  assert.deepEqual(set.json.paidPlans, PLANS);
  assert.equal(set.json.dailyInteractionLimit, 500, 'the daily limit is untouched');
  clock += 61_000; // past the one-minute cache
  const served = await call(plans);
  assert.equal(served.statusCode, 200);
  assert.deepEqual(served.json, { version: 1, config: PLANS });
  const removed = await call(admin, { method: 'POST', url: '/api/admin/config', headers: asAdmin, body: JSON.stringify({ paidPlans: null }) });
  assert.equal(removed.json.paidPlans, null);
  clock += 61_000;
  assert.equal((await call(plans)).json.config, null);
});

test('the public endpoint reads the store at most once a minute per instance and never needs a secret', async () => {
  const world = createWorld();
  await world.store.command(['SET', PLANS_KEY, JSON.stringify(PLANS)]);
  let clock = 5_000;
  const plans = createPlansHandler({ env: world.env, store: world.store, now: () => clock });
  world.store.commands = 0;
  for (let index = 0; index < 5; index += 1) assert.deepEqual((await call(plans)).json.config, PLANS);
  assert.equal(world.store.commands, 1);
  clock += 60_001;
  await call(plans);
  assert.equal(world.store.commands, 2);
  assert.equal((await call(plans, { method: 'POST' })).statusCode, 405);
});

test('a broken or unreachable store gives no list rather than an error, and a stored list that is no longer valid is ignored', async () => {
  const world = createWorld();
  world.store.failing = true;
  const plans = createPlansHandler({ env: world.env, store: world.store });
  const down = await call(plans);
  assert.equal(down.statusCode, 200);
  assert.equal(down.json.config, null);
  world.store.failing = false;
  await world.store.command(['SET', PLANS_KEY, '{"plans": "nope"}']);
  assert.equal((await call(createPlansHandler({ env: world.env, store: world.store }))).json.config, null);
  const env = makeEnv();
  delete env.UPSTASH_REDIS_REST_URL; delete env.KV_REST_API_URL;
  assert.equal((await call(createPlansHandler({ env }))).json.config, null, 'no store configured: no request at all');
});

test('the admin config refuses a plan list that could charge the wrong price or send the key elsewhere', async () => {
  const world = createWorld();
  const admin = createAdminConfigHandler({ env: world.env, store: world.store });
  const duplicatePrice = { plans: [PLANS.plans[0], { ...PLANS.plans[1], priceId: PLANS.plans[0].priceId }] };
  const bad = [
    duplicatePrice,
    { plans: [PLANS.plans[0], { ...PLANS.plans[0], priceId: 'price_otherOTHER1234' }] }, // the same plan id twice
    { plans: [] },
    { plans: [{ ...PLANS.plans[0], priceId: 'sk_live_not_a_price' }] },
    { plans: [{ ...PLANS.plans[0], period: 'weekly' }] },
    { plans: [PLANS.plans[0]], paymentBase: 'https://evil.example.com' },
    { plans: [PLANS.plans[0]], manageUrl: 'http://convai.com/billing' },
    'plans',
  ];
  for (const paidPlans of bad) {
    const response = await call(admin, { method: 'POST', url: '/api/admin/config', headers: asAdmin, body: JSON.stringify({ paidPlans }) });
    assert.equal(response.statusCode, 400, JSON.stringify(paidPlans));
  }
  assert.equal((await call(admin, { url: '/api/admin/config', headers: asAdmin })).json.paidPlans, null, 'nothing was stored');
  assert.equal((await call(admin, { method: 'POST', url: '/api/admin/config', body: JSON.stringify({ paidPlans: PLANS }) })).statusCode, 401);
  assert.equal(validPaidPlans(duplicatePrice), null);
  assert.deepEqual(validPaidPlans({ ...PLANS, extra: 'dropped' }), PLANS, 'unknown fields are not stored');
});
