// Convai paid tier (docs/CONVAI_PAID_TIER.md). Every Convai and backend endpoint is mocked: no request leaves this process, no checkout
// is created and no card is involved. The fake fetch throws on any address it was not told about.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEFAULT_PAID_TIER, PaidTierControl, WATCH, isFreePlan, parsePaidTierCommand, parsePlans, plansUrlFor, readPlanState,
  requestCheckout, resolvePaidTier, safeCheckoutUrl} from './convai-paid-tier.mjs';

const KEY = 'player-test-key-0123456789abcdef';
const STRIPE = 'https://checkout.stripe.com/c/pay/cs_test_fake#fidkdWxOYHwnPyd1blpxYHZxWjA0';

/** A fetch that answers only the routes it is given: {'POST https://…/path': (body, headers) => ({status, json})}. Records every call. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET', route = `${method} ${url}`;
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({route, headers, body});
    const handler = routes[route];
    if (!handler) throw new Error(`unexpected request ${route}`);
    const answer = await handler(body, headers);
    if (answer instanceof Error) throw answer;
    return new Response(answer.json === undefined ? '' : JSON.stringify(answer.json), {status: answer.status ?? 200,
      headers: {'Content-Type': 'application/json'}});
  };
  return {fetchImpl, calls};
}

const checkoutRoute = (answer = {status: 200, json: {checkout_url: STRIPE, customer_id: 'cus_fake', 'Reference ID': 'r1'}}) =>
  ({'POST https://payment.convai.com/new-transaction': () => answer});
const detailsAnswer = (plan, expiry = '2027-01-01T00:00:00') => ({status: 200, json: {STATUS: 'Successful', plan_name: plan, expiry_ts: expiry,
  email: 'player@example.com', api_key: KEY, customer_id: 'cus_fake', username: 'someone'}});

test('the built-in plans: four, each price id once, the yearly Pro price differs from the monthly one', () => {
  const plans = resolvePaidTier().plans;
  assert.deepEqual(plans.map(plan => plan.id), ['gamer-monthly', 'gamer-yearly', 'pro-monthly', 'pro-yearly']);
  assert.equal(new Set(plans.map(plan => plan.priceId)).size, 4);
  assert.deepEqual(plans.map(plan => [plan.price, plan.period]), [['$4', 'monthly'], ['$32', 'yearly'], ['$8', 'monthly'], ['$64', 'yearly']]);
  assert.equal(DEFAULT_PAID_TIER.paymentBase, 'https://payment.convai.com');
});

test('a plan whose price id repeats an earlier one is dropped, so one charge never carries two prices', () => {
  const [monthly, yearly] = DEFAULT_PAID_TIER.plans.slice(2);
  const plans = parsePlans([monthly, {...yearly, priceId: monthly.priceId}]);
  assert.deepEqual(plans.map(plan => plan.id), ['pro-monthly']);
  assert.deepEqual(parsePlans([{...monthly, priceId: 'sk_live_secret'}, {...monthly, period: 'weekly'}, 'x', null]), []);
});

test('a server override is used only where it is valid; the key can never be pointed away from convai.com', () => {
  const override = {plans: [{id: 'gamer-monthly', name: 'Gamer', period: 'monthly', price: '$5', priceId: 'price_NEWNEWNEW123'}],
    paymentBase: 'https://evil.example.com', manageUrl: 'https://convai.com/billing', keyPageUrl: 'http://convai.com/'};
  const config = resolvePaidTier(override);
  assert.equal(config.paymentBase, 'https://payment.convai.com', 'a foreign payment host is ignored');
  assert.equal(config.manageUrl, 'https://convai.com/billing');
  assert.equal(config.keyPageUrl, DEFAULT_PAID_TIER.keyPageUrl, 'http is ignored');
  assert.deepEqual(config.plans.map(plan => plan.price), ['$5']);
  assert.equal(resolvePaidTier({plans: []}).plans.length, 4, 'an empty list keeps the built-in plans');
});

test('only an https Stripe or Convai page may be opened', () => {
  assert.equal(safeCheckoutUrl(STRIPE), STRIPE);
  assert.equal(safeCheckoutUrl('https://convai.com/pricing'), 'https://convai.com/pricing');
  for (const bad of ['http://checkout.stripe.com/x', 'https://stripe.com.evil.example/x', 'javascript:alert(1)', 'file:///C:/x', 'https://user:pw@checkout.stripe.com/', 42, null]) {
    assert.equal(safeCheckoutUrl(bad), null, String(bad));
  }
});

test('the checkout request sends the key as CONVAI-API-KEY to the payment service only, with the price id', async () => {
  const {fetchImpl, calls} = fakeFetch(checkoutRoute());
  const answer = await requestCheckout({key: KEY, priceId: 'price_1UQj9YHC9LzXKZDPTHUfkDuj', fetchImpl});
  assert.deepEqual(answer, {ok: true, url: STRIPE});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['convai-api-key'], KEY);
  assert.deepEqual(calls[0].body, {price_id: 'price_1UQj9YHC9LzXKZDPTHUfkDuj'});
  assert.ok(!JSON.stringify(calls[0].body).includes(KEY), 'the key is not in the body');
});

test('checkout failures map to reasons the page can word', async () => {
  const cases = [[{status: 401, json: {ERROR: 'Invalid API key provided'}}, 'invalid-key'], [{status: 500, json: {ERROR: 'x'}}, 'unavailable'],
    [{status: 422, json: {detail: []}}, 'refused'], [{status: 200, json: {checkout_url: 'https://evil.example/pay'}}, 'bad-answer'],
    [{status: 200, json: {}}, 'bad-answer'], [new Error('offline'), 'unreachable']];
  for (const [answer, reason] of cases) {
    const {fetchImpl} = fakeFetch(checkoutRoute(answer));
    assert.deepEqual(await requestCheckout({key: KEY, priceId: 'price_1UQj9YHC9LzXKZDPTHUfkDuj', fetchImpl}), {ok: false, reason});
  }
});

test('the plan is read from the main path, or the /beta one while the main one is missing; only the plan fields are kept', async () => {
  const {fetchImpl, calls} = fakeFetch({
    'POST https://payment.convai.com/get-user-details': () => ({status: 404, json: {detail: 'Not Found'}}),
    'POST https://payment.convai.com/beta/get-user-details': () => detailsAnswer('GamerPlanV2'),
  });
  const state = await readPlanState({key: KEY, fetchImpl, now: () => Date.UTC(2026, 9, 15)});
  assert.deepEqual(state, {plan: 'GamerPlanV2', expiresAt: '2027-01-01T00:00:00.000Z', paid: true});
  assert.deepEqual(calls.map(call => call.body), [{api_key: KEY}, {api_key: KEY}]);
  assert.ok(!JSON.stringify(state).includes('example.com'), 'the e-mail address is dropped');
});

test('a free plan or an expired one is not a paid plan; a failed read is null', async () => {
  for (const name of ['Free', 'FreePlanV2', 'trial', '-1', '', null]) assert.equal(isFreePlan(name), true, String(name));
  assert.equal(isFreePlan('GamerProPlanV2'), false);
  const expired = fakeFetch({'POST https://payment.convai.com/get-user-details': () => detailsAnswer('GamerPlanV2', '2026-01-01T00:00:00')});
  assert.equal((await readPlanState({key: KEY, fetchImpl: expired.fetchImpl, now: () => Date.UTC(2026, 9, 15)})).paid, false);
  const down = fakeFetch({'POST https://payment.convai.com/get-user-details': () => ({status: 500, json: {ERROR: 'x'}})});
  assert.equal(await readPlanState({key: KEY, fetchImpl: down.fetchImpl}), null);
});

test('commands: fresh, well formed, a known action, a plan id for buy', () => {
  const now = 1_000_000;
  const raw = value => JSON.stringify({version: 1, id: 'p1', issuedAt: now, ...value});
  assert.deepEqual(parsePaidTierCommand(raw({action: 'buy', plan: 'gamer-monthly'}), now), {id: 'p1', action: 'buy', plan: 'gamer-monthly'});
  assert.deepEqual(parsePaidTierCommand(raw({action: 'manage'}), now), {id: 'p1', action: 'manage'});
  assert.equal(parsePaidTierCommand(raw({action: 'buy'}), now), null);
  assert.equal(parsePaidTierCommand(raw({action: 'delete-everything'}), now), null);
  assert.equal(parsePaidTierCommand(raw({action: 'manage'}), now + 31_000), null, 'a stale command is never replayed');
  assert.equal(parsePaidTierCommand('{', now), null);
  assert.equal(plansUrlFor('https://auth.example.vercel.app/api/convai/token'), 'https://auth.example.vercel.app/api/convai/plans');
  assert.equal(plansUrlFor('http://insecure/api'), null);
});

/** A control over a temporary runtime folder, a fake clock and timers that run only when the test says so. */
async function harness({routes = {}, key = KEY, plansUrl = null} = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'paid-tier-'));
  const commandPath = join(folder, 'paid-tier-command.json');
  const published = [], opened = [], timers = [];
  let clock = Date.UTC(2026, 9, 15, 12);
  const {fetchImpl, calls} = fakeFetch(routes);
  const keys = {player: key};
  const control = await new PaidTierControl({keys, commandPath, plansUrl, fetchImpl, now: () => clock,
    publish: async value => { published.push(JSON.parse(JSON.stringify(value))); },
    openBrowser: async url => { opened.push(url); },
    setTimer: (fn, ms) => { const timer = {fn, ms, cleared: false}; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; }}).open();
  let sequence = 0;
  const send = async (action, extra = {}) => {
    sequence += 1;
    await writeFile(commandPath, JSON.stringify({version: 1, id: `c${sequence}`, action, issuedAt: clock, ...extra}));
    await control.poll();
    return published.at(-1);
  };
  const runTimer = async () => {
    const timer = timers.filter(item => !item.cleared && !item.ran).at(-1);
    if (!timer) return null;
    timer.ran = true; clock += timer.ms; timer.fn();
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    await control.writing;
    return timer;
  };
  return {control, send, runTimer, published, opened, timers, calls, keys, advance: ms => { clock += ms; },
    cleanup: () => rm(folder, {recursive: true, force: true})};
}

test('buying without a saved key asks for one and calls nothing', async () => {
  const world = await harness({key: null});
  try {
    const state = await world.send('buy', {plan: 'gamer-monthly'});
    assert.deepEqual(state.result, {id: 'c1', state: 'no-key'});
    assert.equal(state.keySaved, false);
    assert.equal(world.calls.length, 0);
    assert.equal(world.opened.length, 0);
  } finally { await world.cleanup(); }
});

test('a purchase opens Stripe, follows the plan lightly and reports it active once Convai shows it', async () => {
  let plan = 'Free';
  const world = await harness({routes: {...checkoutRoute(),
    'POST https://payment.convai.com/get-user-details': () => detailsAnswer(plan)}});
  try {
    const state = await world.send('buy', {plan: 'gamer-yearly'});
    assert.deepEqual(state.result, {id: 'c1', state: 'opened'});
    assert.deepEqual(world.opened, [STRIPE]);
    assert.equal(state.watch.state, 'watching');
    assert.equal(state.watch.plan, 'gamer-yearly');
    const checkout = world.calls.find(call => call.route.endsWith('/new-transaction'));
    assert.equal(checkout.body.price_id, 'price_1UQjA5HC9LzXKZDPPqOe4ji3');
    // Not yet paid: the next look is 6 s later, and nothing else runs in between.
    assert.equal((await world.runTimer()).ms, WATCH.fastMs);
    assert.equal(world.published.at(-1)?.watch?.state ?? 'watching', 'watching');
    plan = 'GamerPlanV2';
    await world.runTimer();
    const after = world.published.at(-1);
    assert.equal(after.watch.state, 'active');
    assert.deepEqual(after.plan, {name: 'GamerPlanV2', paid: true, checkedAt: after.plan.checkedAt});
    assert.equal(world.timers.filter(timer => !timer.cleared && !timer.ran).length, 0, 'no timer is left once confirmed');
    // Nothing secret reaches the status file.
    for (const value of world.published) {
      const text = JSON.stringify(value);
      assert.ok(!text.includes(KEY) && !text.includes('price_') && !text.includes('example.com') && !text.includes('cs_test'), text);
    }
  } finally { await world.cleanup(); }
});

test('an account that already had a paid plan is confirmed only when its plan or expiry changes', async () => {
  let expiry = '2026-11-01T00:00:00';
  const world = await harness({routes: {...checkoutRoute(),
    'POST https://payment.convai.com/get-user-details': () => detailsAnswer('GamerPlanV2', expiry)}});
  try {
    await world.send('buy', {plan: 'gamer-yearly'});
    await world.runTimer();
    assert.equal(world.control.watch.state, 'watching', 'the old plan is not taken for the new one');
    expiry = '2027-10-15T00:00:00';
    await world.runTimer();
    assert.equal(world.control.watch.state, 'active');
  } finally { await world.cleanup(); }
});

test('the plan check stops after five minutes without a confirmation, slowing down after the first minute', async () => {
  const world = await harness({routes: {...checkoutRoute(), 'POST https://payment.convai.com/get-user-details': () => detailsAnswer('Free')}});
  try {
    await world.send('buy', {plan: 'pro-monthly'});
    const delays = [];
    for (let step = 0; step < 40 && world.control.watch.state === 'watching'; step += 1) {
      const timer = await world.runTimer();
      if (!timer) break;
      delays.push(timer.ms);
    }
    assert.equal(world.control.watch.state, 'timeout');
    assert.equal(world.published.at(-1).watch.state, 'timeout');
    assert.ok(delays.length <= 23, `${delays.length} reads in five minutes`);
    assert.equal(delays[0], WATCH.fastMs);
    assert.equal(delays.at(-1), WATCH.slowMs);
  } finally { await world.cleanup(); }
});

test('a refused checkout opens nothing and starts no plan check', async () => {
  const world = await harness({routes: {...checkoutRoute({status: 401, json: {ERROR: 'Invalid API key provided'}}),
    'POST https://payment.convai.com/get-user-details': () => detailsAnswer('Free')}});
  try {
    const state = await world.send('buy', {plan: 'gamer-monthly'});
    assert.equal(state.result.state, 'invalid-key');
    assert.equal(world.opened.length, 0);
    assert.equal(world.timers.length, 0);
  } finally { await world.cleanup(); }
});

test('manage and get-a-key open Convai pages and call no endpoint; an unknown plan is refused', async () => {
  const world = await harness({routes: {'POST https://payment.convai.com/get-user-details': () => detailsAnswer('Free')}});
  try {
    assert.equal((await world.send('manage')).result.state, 'opened');
    assert.equal((await world.send('key-page')).result.state, 'opened');
    assert.deepEqual(world.opened, ['https://convai.com/management/billing', 'https://convai.com']);
    assert.equal(world.calls.length, 0);
    assert.equal((await world.send('buy', {plan: 'platinum'})).result.state, 'no-plan');
  } finally { await world.cleanup(); }
});

test('opening the page reads the backend list and the plan once; a check reads the plan again', async () => {
  const override = {plans: [{id: 'gamer-monthly', name: 'Gamer', period: 'monthly', price: '$4', priceId: 'price_1UQj9YHC9LzXKZDPTHUfkDuj', interactions: 1200, concurrency: 6}]};
  const world = await harness({plansUrl: 'https://auth.example.vercel.app/api/convai/plans', routes: {
    'GET https://auth.example.vercel.app/api/convai/plans': () => ({status: 200, json: {version: 1, config: override}}),
    'POST https://payment.convai.com/get-user-details': () => detailsAnswer('GamerPlanV2')}});
  try {
    const state = await world.send('refresh');
    assert.equal(state.result.state, 'ready');
    assert.deepEqual(state.plans, [{id: 'gamer-monthly', name: 'Gamer', period: 'monthly', price: '$4', interactions: 1200, concurrency: 6}]);
    assert.deepEqual(state.plan, {name: 'GamerPlanV2', paid: true, checkedAt: state.plan.checkedAt});
    await world.send('refresh');
    assert.equal(world.calls.length, 2, 'a second open within a minute calls nothing');
    assert.equal((await world.send('check')).result.state, 'active');
    assert.equal(world.calls.length, 3);
  } finally { await world.cleanup(); }
});

test('an old command left in the file is not replayed at start, and close leaves no timer', async () => {
  const world = await harness({routes: {...checkoutRoute(), 'POST https://payment.convai.com/get-user-details': () => detailsAnswer('Free')}});
  try {
    await world.send('buy', {plan: 'gamer-monthly'});
    const live = world.timers.filter(timer => !timer.cleared && !timer.ran);
    assert.equal(live.length, 1);
    world.control.close();
    assert.equal(live[0].cleared, true);
    const raw = await readFile(world.control.commandPath, 'utf8');
    const again = await new PaidTierControl({keys: world.keys, commandPath: world.control.commandPath, publish: async () => {},
      fetchImpl: () => { throw new Error('no request expected'); }, openBrowser: async () => { throw new Error('nothing opens'); }}).open();
    assert.equal(again.observed, raw);
    await again.poll();
    assert.equal(again.result, null);
    again.close();
  } finally { await world.cleanup(); }
});
