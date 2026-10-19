// Convai paid tier (docs/CONVAI_PAID_TIER.md). Every Convai and backend endpoint is mocked: no request leaves this process, no checkout
// is created and no card is involved. The fake fetch throws on any address it was not told about.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEFAULT_PAID_TIER, KNOWN_PAID_PLANS, PAID_CONNECTIONS, PLAN_TIMING, PaidTierControl, WATCH, isFreePlan, isPaidPlanName, parsePaidTierCommand, parsePlans, plansUrlFor, readPlanState,
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
  // A checkout address goes to the system's URL handler as one argument: nothing that could be read as more than one address passes.
  for (const bad of ['http://checkout.stripe.com/x', 'https://stripe.com.evil.example/x', 'javascript:alert(1)', 'file:///C:/x', 'https://user:pw@checkout.stripe.com/', 42, null,
    'https://checkout.stripe.com/x "C:\\Windows\\System32\\calc.exe"', 'https://checkout.stripe.com/x\tfile:///C:/x', 'https://checkout.stripe.com/a|b', 'https://checkout.stripe.com/a^b']) {
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
async function harness({routes = {}, key = KEY, plansUrl = null, options = {}} = {}) {
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
    clearTimer: timer => { timer.cleared = true; }, ...options}).open();
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

// Connections on a paid plan (docs/CONVAI_PAID_TIER.md, "Conversations at once"): six on a confirmed paid Gamer plan, one otherwise.
const DETAILS = 'POST https://payment.convai.com/get-user-details';
const tick = async world => { await world.control.poll(); await world.control.planReading; };

test('the plan is read only while the player key is in use, once, and a paid plan allows six connections', async () => {
  let inUse = false, plan = 'GamerPlanV2';
  const world = await harness({routes: {[DETAILS]: () => detailsAnswer(plan)}, options: {wantPlan: () => inUse}});
  try {
    await tick(world);
    assert.equal(world.calls.length, 0, 'the shared key is in use: no plan read');
    assert.equal(world.control.connectionLimit(), 1);
    inUse = true;
    await tick(world);
    assert.equal(world.calls.length, 1);
    assert.equal(world.control.connectionLimit(), PAID_CONNECTIONS);
    assert.equal(PAID_CONNECTIONS, 6);
    for (let index = 0; index < 20; index++) await tick(world);
    assert.equal(world.calls.length, 1, 'polling does not read the plan again');
    world.advance(PLAN_TIMING.refreshMs + 1);
    plan = 'Free';
    await tick(world);
    assert.equal(world.calls.length, 2, 'refreshed after six hours');
    assert.equal(world.control.connectionLimit(), 1, 'a free plan has one connection');
  } finally { await world.cleanup(); }
});

test('a failed plan read falls back to one connection and retries after ten minutes, not before', async () => {
  let fail = false;
  const world = await harness({routes: {[DETAILS]: () => fail ? {status: 500, json: {ERROR: 'down'}} : detailsAnswer('GamerPlanV2')},
    options: {wantPlan: () => true}});
  try {
    await tick(world);
    assert.equal(world.control.connectionLimit(), 6);
    fail = true;
    world.advance(PLAN_TIMING.refreshMs + 1);
    await tick(world);
    assert.equal(world.calls.length, 2);
    assert.equal(world.control.connectionLimit(), 1, 'an unread plan counts as free');
    world.advance(PLAN_TIMING.retryMs - 1000);
    await tick(world);
    assert.equal(world.calls.length, 2, 'no retry inside ten minutes');
    fail = false;
    world.advance(2000);
    await tick(world);
    assert.equal(world.calls.length, 3);
    assert.equal(world.control.connectionLimit(), 6);
  } finally { await world.cleanup(); }
});

test('another key, an expired plan or an old answer is one connection until the plan is read again', async () => {
  const world = await harness({routes: {[DETAILS]: () => detailsAnswer('GamerPlanV2', '2026-10-15T13:00:00')}, options: {wantPlan: () => false}});
  try {
    await world.send('check');
    assert.equal(world.control.connectionLimit(), 6, 'a page check counts too');
    world.keys.player = 'player-other-key-0123456789abcdef';
    assert.equal(world.control.connectionLimit(), 1, 'the answer was for another key');
    world.keys.player = KEY;
    assert.equal(world.control.connectionLimit(), 6);
    world.advance(3600_000 + 1);
    assert.equal(world.control.connectionLimit(), 1, 'the plan expired');
    world.keys.player = null;
    assert.equal(world.control.connectionLimit(), 1);
  } finally { await world.cleanup(); }
  const old = await harness({routes: {[DETAILS]: () => detailsAnswer('GamerPlanV2')}});
  try {
    await old.send('check');
    assert.equal(old.control.connectionLimit(), 6);
    old.advance(PLAN_TIMING.trustMs + 1);
    assert.equal(old.control.connectionLimit(), 1, 'an answer older than twelve hours is not trusted');
  } finally { await old.cleanup(); }
});

test('the plan state file never carries the key, even with the plan read in the background', async () => {
  const world = await harness({routes: {[DETAILS]: () => detailsAnswer('GamerPlanV2')}, options: {wantPlan: () => true}});
  try {
    await tick(world);
    const last = world.published.at(-1);
    assert.equal(last.plan.paid, true);
    assert.ok(!JSON.stringify(world.published).includes(KEY));
    assert.ok(!JSON.stringify(world.published).includes('player@example.com'));
  } finally { await world.cleanup(); }
});

/** A fake Sign in with Convai session: settle it from the test. */
function fakeSession() {
  const session = {cancelled: false};
  session.opened = new Promise((resolve, reject) => { session.open = resolve; session.failOpen = reject; });
  session.key = new Promise((resolve, reject) => { session.give = resolve; session.fail = reject; });
  session.key.catch(() => {});
  session.cancel = () => { session.cancelled = true; session.fail(Object.assign(Error('cancelled'), {code: 'cancelled'})); };
  return session;
}
const settle = async world => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); await world.control.writing; };

test('Sign in with Convai: the page gets "signing-in" at once, then the key is checked and saved like Paste ("saved")', async () => {
  const saved = [], checked = [], sessions = [];
  const signIn = () => { const session = fakeSession(); sessions.push(session); session.open(); return session; };
  const world = await harness({key: null, options: {signIn, saveKey: async key => { saved.push(key); world.keys.player = key; },
    validate: async key => { checked.push(key); return 'valid'; }}});
  try {
    assert.deepEqual((await world.send('sign-in')).result, {id: 'c1', state: 'signing-in'});
    assert.equal(world.opened.length, 0, 'the sign-in opens its own page, not the key page');
    sessions[0].give('player-signed-in-key-0123456789');
    await settle(world);
    const last = world.published.at(-1);
    assert.deepEqual(last.result, {id: 'c1', state: 'saved'});
    assert.equal(last.keySaved, true);
    assert.deepEqual(saved, ['player-signed-in-key-0123456789']);
    assert.deepEqual(checked, saved);
    assert.ok(!JSON.stringify(world.published).includes('player-signed-in-key'), 'the key never reaches the state file');
  } finally { world.control.close(); await world.cleanup(); }
});

test('Sign in with Convai: a refused key, a timeout, a failure and a browser that will not open each have their own result', async () => {
  const cases = [
    {act: session => { session.open(); session.give('player-signed-in-key-0123456789'); }, validate: 'invalid', state: 'invalid-key'},
    {act: session => { session.open(); session.fail(Object.assign(Error('t'), {code: 'timeout'})); }, state: 'signin-timeout'},
    {act: session => { session.open(); session.fail(Object.assign(Error('x'), {code: 'unavailable'})); }, state: 'signin-failed'},
  ];
  for (const item of cases) {
    const saved = [];
    const world = await harness({key: null, options: {signIn: () => { const session = fakeSession(); queueMicrotask(() => item.act(session)); return session; },
      saveKey: async key => { saved.push(key); }, validate: async () => item.validate ?? 'valid'}});
    try {
      await world.send('sign-in');
      await settle(world);
      assert.equal(world.published.at(-1).result.state, item.state, item.state);
      assert.deepEqual(saved, [], 'nothing saved');
    } finally { world.control.close(); await world.cleanup(); }
  }
  const world = await harness({key: null, options: {signIn: () => { const session = fakeSession(); session.failOpen(Object.assign(Error('o'), {code: 'open-failed'})); return session; },
    saveKey: async () => { throw Error('never'); }}});
  try { assert.equal((await world.send('sign-in')).result.state, 'open-failed'); } finally { await world.cleanup(); }
});

test('Sign in with Convai: a new sign-in or the service stopping cancels the one waiting; without a sign-in the key page opens', async () => {
  const sessions = [];
  const world = await harness({key: null, options: {signIn: () => { const session = fakeSession(); session.open(); sessions.push(session); return session; },
    saveKey: async () => { throw Error('never'); }}});
  try {
    await world.send('sign-in');
    await world.send('sign-in');
    assert.equal(sessions[0].cancelled, true);
    assert.equal(sessions[1].cancelled, false);
    await settle(world);
    assert.deepEqual(world.published.at(-1).result, {id: 'c2', state: 'signing-in'}, 'the cancelled one publishes nothing');
    assert.equal((await world.send('key-page')).result.state, 'opened', 'Get your Convai API key still just opens the page');
    world.control.close();
    assert.equal(sessions[1].cancelled, true);
  } finally { await world.cleanup(); }
  const plain = await harness({key: null});
  try {
    assert.equal((await plain.send('sign-in')).result.state, 'opened');
    assert.deepEqual(plain.opened, ['https://convai.com']);
  } finally { await plain.cleanup(); }
});

// The plan_name values of Convai's V2 plans, seen on a live purchase of GamerPlanV2-Monthly (2026-10-16).
test('the four V2 plan names are paid by name; free, trial and empty names are not; an unknown name that is not free is still paid', async () => {
  assert.deepEqual(KNOWN_PAID_PLANS, ['GamerPlanV2-Monthly', 'GamerPlanV2-Yearly', 'GamerProPlanV2-Monthly', 'GamerProPlanV2-Yearly']);
  for (const name of KNOWN_PAID_PLANS) assert.equal(isPaidPlanName(name), true, name);
  for (const name of ['Free', 'FreePlanV2', 'trial', '-1', 'none', '', null, undefined, 42]) assert.equal(isPaidPlanName(name), false, String(name));
  assert.equal(isPaidPlanName('SomeFuturePlan'), true, 'the fallback: not free or trial means paid');
  for (const name of KNOWN_PAID_PLANS) {
    const fetched = fakeFetch({[DETAILS]: () => detailsAnswer(name)});
    const state = await readPlanState({key: KEY, fetchImpl: fetched.fetchImpl, now: () => Date.UTC(2026, 9, 16)});
    assert.equal(state.paid, true, name);
    assert.equal(state.plan, name);
  }
});

test('the quotas of the built-in plans: Gamer 500 interactions a month, Gamer Pro 1000', () => {
  const quota = Object.fromEntries(resolvePaidTier().plans.map(plan => [plan.id, plan.interactions]));
  assert.deepEqual(quota, {'gamer-monthly': 500, 'gamer-yearly': 500, 'pro-monthly': 1000, 'pro-yearly': 1000});
});

test('a key on GamerPlanV2-Monthly switches the limit from one to six and logs one line for each change', async () => {
  let plan = 'GamerPlanV2-Monthly';
  const lines = [];
  const world = await harness({routes: {[DETAILS]: () => detailsAnswer(plan)}, options: {wantPlan: () => true, log: line => lines.push(line)}});
  try {
    assert.equal(world.control.connectionLimit(), 1, 'one before the plan is read');
    await tick(world);
    assert.equal(world.control.connectionLimit(), PAID_CONNECTIONS);
    assert.deepEqual(lines, ['paid Convai plan: up to 6 conversations at once']);
    for (let index = 0; index < 5; index++) await tick(world);
    assert.equal(lines.length, 1, 'no repeat while nothing changes');
    world.advance(PLAN_TIMING.refreshMs + 1);
    plan = 'Free';
    await tick(world);
    assert.equal(world.control.connectionLimit(), 1);
    assert.deepEqual(lines, ['paid Convai plan: up to 6 conversations at once', 'Convai plan: one conversation at a time']);
  } finally { await world.cleanup(); }
});
