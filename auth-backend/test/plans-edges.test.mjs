// Edge paths of the paid tier's plan list: how the public endpoint caches, which lists are accepted at their limits, and what a
// damaged stored value turns into. plans.test.mjs has the happy path and the main refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS_KEY, createPlansHandler, storedPaidPlans, validPaidPlans } from '../api/_lib/plans.js';
import { createWorld, mockResponse } from '../testkit/harness.mjs';

const call = async handler => {
  const response = mockResponse();
  await handler({ method: 'GET', url: '/api/convai/plans', headers: {} }, response);
  return response;
};
const plan = (over = {}) => ({ id: 'gamer', name: 'Gamer', period: 'monthly', price: '$4', priceId: 'price_abcdefgh', ...over });
const list = (over = {}, ...plans) => ({ plans: plans.length ? plans : [plan()], ...over });
const numbered = count => ({ plans: Array.from({ length: count }, (_, index) => plan({ id: `plan-${index}`, priceId: `price_number${String(index).padStart(4, '0')}` })) });

test('the public plans cache: a failed read is retried at once, "nothing stored" is remembered, the window is exactly its length, and a clock that goes backwards re-reads', async () => {
  const world = createWorld();
  let clock = 100_000;
  let down = true;
  const reads = [];
  const store = { command: async args => { reads.push(args); if (down) throw new Error('down'); return world.store.command(args); } };
  const plans = createPlansHandler({ env: world.env, store, now: () => clock });
  const configOf = async () => (await call(plans)).json.config;

  assert.equal(await configOf(), null);
  assert.equal(reads.length, 1);
  down = false;
  assert.equal(await configOf(), null, 'answered from the store again, not from a remembered failure');
  assert.equal(reads.length, 2);
  await configOf();
  await configOf();
  assert.equal(reads.length, 2, 'a read that found nothing is kept for the minute too');

  const first = list();
  await world.store.command(['SET', PLANS_KEY, JSON.stringify(first)]);
  clock += 59_999;
  assert.equal(await configOf(), null, 'one millisecond short of the minute');
  clock += 1;
  assert.deepEqual(await configOf(), first, 'the minute is over');
  assert.equal(reads.length, 3);

  const second = list({}, plan({ id: 'second', priceId: 'price_secondsecond' }));
  await world.store.command(['SET', PLANS_KEY, JSON.stringify(second)]);
  clock -= 10_000;
  assert.deepEqual(await configOf(), second, 'a clock set back must not freeze an old answer for ever');
  assert.equal(reads.length, 4);
});

test('plan lists at their limits: counts, ids, names, prices, price ids, optional numbers, addresses and paths', () => {
  const accepts = (value, label) => assert.ok(validPaidPlans(value), label ?? JSON.stringify(value).slice(0, 120));
  const refuses = (value, label) => assert.equal(validPaidPlans(value), null, label ?? JSON.stringify(value).slice(0, 120));
  const withPlan = over => list({}, plan(over));

  accepts(numbered(1), 'one plan');
  accepts(numbered(8), 'eight plans');
  refuses(numbered(9), 'nine plans');
  for (const bad of [null, undefined, 'plans', 7, [], {}, { plans: {} }, { plans: 'x' }, { plans: [null] }, { plans: [[]] }]) refuses(bad, `top level ${JSON.stringify(bad)}`);

  for (const id of ['a', '0', 'a'.repeat(40), 'gamer-2']) accepts(withPlan({ id }), `id ${id}`);
  for (const id of ['', 'a'.repeat(41), 'Gamer', '-gamer', 'gamer_x', 'gamer.x', 'ga mer', undefined]) refuses(withPlan({ id }), `id ${id}`);
  for (const name of ['G', `A${'b'.repeat(31)}`, 'Gamer Pro+', 'v1.2']) accepts(withPlan({ name }), `name ${name}`);
  for (const name of ['', 'b'.repeat(33), ' Gamer', '<b>Gamer</b>', 'Gamer!', undefined]) refuses(withPlan({ name }), `name ${name}`);
  for (const period of ['Monthly', 'weekly', '', undefined]) refuses(withPlan({ period }), `period ${period}`);

  for (const price of ['$4', '4', '€5,99', '4.00 USD', '£1234', '12 $']) accepts(withPlan({ price }), `price ${price}`);
  for (const price of ['free', '$', '$4.5', '$12345', '-$4', '$4 dollars', '', 4, null, undefined]) refuses(withPlan({ price }), `price ${price}`);
  assert.equal(validPaidPlans(withPlan({ price: '  $4  ' })).plans[0].price, '$4', 'padding is trimmed before it is stored');

  accepts(withPlan({ priceId: `price_${'a'.repeat(8)}` }));
  accepts(withPlan({ priceId: `price_${'a'.repeat(64)}` }));
  for (const priceId of [`price_${'a'.repeat(7)}`, `price_${'a'.repeat(65)}`, 'price_abc-defgh', 'prod_abcdefgh', undefined]) refuses(withPlan({ priceId }), `price id ${priceId}`);

  // A number that does not fit is dropped quietly: the plan is still a good plan without it.
  const kept = validPaidPlans(withPlan({ interactions: 10_000_000, concurrency: 1000 })).plans[0];
  assert.deepEqual([kept.interactions, kept.concurrency], [10_000_000, 1000]);
  for (const value of [0, -1, 1.5, '1000', null, 10_000_001]) {
    const dropped = validPaidPlans(withPlan({ interactions: value, concurrency: value })).plans[0];
    assert.ok(!('interactions' in dropped) && !('concurrency' in dropped), `${JSON.stringify(value)} is not stored`);
  }

  assert.equal(validPaidPlans(list({ manageUrl: 'https://sub.convai.com/path/' })).manageUrl, 'https://sub.convai.com/path', 'a trailing slash is removed');
  assert.equal(validPaidPlans(list({ keyPageUrl: 'https://convai.com/' })).keyPageUrl, 'https://convai.com');
  for (const url of ['https://convai.com.evil.com/x', 'https://notconvai.com', 'http://convai.com', 'https://user:pw@convai.com/x', 'javascript:alert(1)',
    `https://convai.com/${'a'.repeat(300)}`, '', 42, null]) refuses(list({ successUrl: url }), `address ${url}`);
  for (const checkoutPath of ['/a', '/checkout/start_2-b']) assert.equal(validPaidPlans(list({ checkoutPath })).checkoutPath, checkoutPath);
  for (const checkoutPath of ['checkout', '/', '/../etc', '/a b', `/${'a'.repeat(81)}`, 5, null]) refuses(list({ checkoutPath }), `path ${checkoutPath}`);
  assert.deepEqual(validPaidPlans(list({ detailsPaths: ['/a', '/b', '/c'] })).detailsPaths, ['/a', '/b', '/c']);
  for (const detailsPaths of [[], ['/a', '/b', '/c', '/d'], ['/a', 5], 'details', {}, null]) refuses(list({ detailsPaths }), `paths ${JSON.stringify(detailsPaths)}`);

  const trimmed = validPaidPlans({ extra: 'x', plans: [{ ...plan(), extra: 'y' }] });
  assert.deepEqual(Object.keys(trimmed), ['plans']);
  assert.deepEqual(Object.keys(trimmed.plans[0]), ['id', 'name', 'period', 'price', 'priceId']);
});

test('a stored value that is damaged, hand-edited or from an older rule set reads back as "no list" and never throws', () => {
  const junk = [undefined, null, '', 0, 5, {}, [], 'null', '[]', '"text"', '{', '{"plans":[]}', '{"plans":"nope"}', JSON.stringify(numbered(9)),
    JSON.stringify(list({ manageUrl: 'https://evil.example.com' })), JSON.stringify(list({}, plan({ priceId: 'sk_live_secret' })))];
  for (const raw of junk) assert.equal(storedPaidPlans(raw), null, JSON.stringify(raw)?.slice(0, 80));
  const withExtras = JSON.stringify({ ...list(), note: 'old field', plans: [{ ...plan(), legacy: true }] });
  assert.deepEqual(storedPaidPlans(withExtras), list(), 'fields the rules no longer know are dropped on the way out');
});

test('plan ids, names and price ids must be text', () => {
  const refused = [{ id: 5 }, { id: true }, { id: ['gamer'] }, { name: 7 }, { name: ['Gamer'] }, { priceId: ['price_abcdefgh'] }];
  for (const override of refused) {
    assert.equal(validPaidPlans(list({}, plan(override))), null, JSON.stringify(override));
  }
});
