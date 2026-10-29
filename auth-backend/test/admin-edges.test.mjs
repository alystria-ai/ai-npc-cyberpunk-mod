// Edge and error paths of the admin, probe and public read endpoints that admin.test.mjs and plans.test.mjs do not pin:
// credential look-alikes, methods and cross-origin preflights, odd request bodies and queries, and a store that is down or absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createAdminConfigHandler, createAdminTurnsHandler, createReadyHandler, healthHandler } from '../api/_lib/admin.js';
import { ENV_NAMES } from '../api/_lib/config.js';
import { createPlansHandler } from '../api/_lib/plans.js';
import { ADMIN_SECRET, FAKE_API_KEY, SIGNING_SECRET, createWorld, makeEnv, mockResponse } from '../testkit/harness.mjs';

const asAdmin = { authorization: `Bearer ${ADMIN_SECRET}` };
const call = async (handler, { method = 'GET', url = '/', headers = {}, body } = {}) => {
  const response = mockResponse();
  await handler({ method, url, headers, body }, response);
  return response;
};
/** A HEAD request the way Node delivers it: the response can see the request that produced it. */
const callHead = async (handler, url) => {
  const request = { method: 'HEAD', url, headers: {} };
  const response = mockResponse();
  response.req = request;
  await handler(request, response);
  return response;
};
const post = (handler, body) => call(handler, { method: 'POST', url: '/api/admin/config', headers: asAdmin, body: typeof body === 'string' ? body : JSON.stringify(body) });
const PLAN_LIST = { plans: [{ id: 'gamer', name: 'Gamer', period: 'monthly', price: '$4', priceId: 'price_abcdefgh12' }] };
const hasCorsHeader = response => Object.keys(response.headers).some(name => name.toLowerCase().startsWith('access-control-'));

test('the admin credential: a missing, wrong, shorter, longer or oddly written one gets one identical 401 and never throws, at every admin call', async () => {
  const world = createWorld();
  const admin = createAdminConfigHandler({ env: world.env, store: world.store });
  const turns = createAdminTurnsHandler({ env: world.env, store: world.store });
  const requests = {
    'turns': headers => call(turns, { url: '/api/admin/turns', headers }),
    'config read': headers => call(admin, { url: '/api/admin/config', headers }),
    'config write': headers => call(admin, { method: 'POST', url: '/api/admin/config', headers, body: JSON.stringify({ dailyInteractionLimit: 5 }) }),
  };
  const credentials = {
    'none': undefined,
    'wrong, same length': `Bearer ${'z'.repeat(ADMIN_SECRET.length)}`,
    'one character short': `Bearer ${ADMIN_SECRET.slice(0, -1)}`,
    'one character long': `Bearer ${ADMIN_SECRET}x`,
    'a prefix of it': `Bearer ${ADMIN_SECRET.slice(0, 10)}`,
    'no scheme': ADMIN_SECRET,
    'another scheme': `Basic ${ADMIN_SECRET}`,
    'two spaces': `Bearer  ${ADMIN_SECRET}`,
    'same number of characters, more bytes': `Bearer ${'é'.repeat(ADMIN_SECRET.length)}`,
    'an empty bearer': 'Bearer ',
  };
  for (const [name, send] of Object.entries(requests)) {
    const seen = new Set();
    let last;
    for (const [label, value] of Object.entries(credentials)) {
      last = await send(value === undefined ? {} : { authorization: value });
      assert.equal(last.statusCode, 401, `${name}: ${label}`);
      seen.add(JSON.stringify([last.statusCode, last.headers, last.text]));
    }
    assert.equal(seen.size, 1, `${name}: every kind of wrong credential gets the same answer, so none tells more than another`);
    assert.deepEqual(last.json, { error: 'unauthorized' });
  }
  assert.equal(world.store.commands, 0, 'nothing is read or written before the credential is accepted');
  assert.equal((await requests.turns(asAdmin)).statusCode, 200);

  // The secret must be at least 32 characters to count as set at all.
  for (const [length, expected] of [[31, 404], [32, 200]]) {
    const env = makeEnv({ CONVAI_AUTH_ADMIN_SECRET: 'a'.repeat(length) });
    const response = await call(createAdminConfigHandler({ env, store: world.store }), { headers: { authorization: `Bearer ${'a'.repeat(length)}` } });
    assert.equal(response.statusCode, expected, `${length} characters`);
  }
});

test('every endpoint names its allowed methods on a 405, answers a browser preflight with a 405 too (the token endpoint: 204 for extensions, token-handler-edges) and never grants a web page cross-origin access', async () => {
  const world = createWorld();
  const options = { env: world.env, store: world.store };
  const endpoints = [
    { name: 'healthz', handler: healthHandler, allow: 'GET, HEAD', also: ['POST'] },
    { name: 'readyz', handler: createReadyHandler(options), allow: 'GET, HEAD', also: ['POST'] },
    { name: 'plans', handler: createPlansHandler(options), allow: 'GET, HEAD', also: ['POST'] },
    { name: 'admin turns', handler: createAdminTurnsHandler(options), allow: 'GET', also: ['POST', 'HEAD'] },
    { name: 'admin config', handler: createAdminConfigHandler(options), allow: 'GET, POST', also: ['HEAD'] },
    { name: 'token', handler: world.handler, allow: 'POST, OPTIONS', also: ['GET', 'HEAD'], preflightAnswered: true },
  ];
  const preflight = { origin: 'https://example.org', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' };
  for (const { name, handler, allow, also, preflightAnswered } of endpoints) {
    for (const method of [...(preflightAnswered ? [] : ['OPTIONS']), 'PUT', 'PATCH', 'DELETE', ...also]) {
      const response = await call(handler, { method, headers: preflight });
      assert.equal(response.statusCode, 405, `${name} ${method}`);
      assert.equal(response.headers.Allow, allow, `${name} ${method}`);
      assert.deepEqual(response.json, { error: 'method_not_allowed' }, `${name} ${method}`);
      assert.ok(!hasCorsHeader(response), `${name} ${method} grants nothing cross-origin`);
    }
  }
  assert.equal(world.store.commands, 0, 'a wrong method never reaches the store');

  for (const [handler, url] of [[healthHandler, '/api/healthz'], [createReadyHandler(options), '/api/readyz'], [createPlansHandler(options), '/api/convai/plans']]) {
    const head = await callHead(handler, url);
    assert.equal(head.statusCode, 200, url);
    assert.equal(head.text, '', 'a HEAD answer has headers and no body');
    assert.equal(head.headers['Cache-Control'], 'no-store');
    assert.ok(!('Content-Type' in head.headers), 'there is no body to describe');
    const crossOrigin = await call(handler, { url, headers: { origin: 'https://example.org' } });
    assert.equal(crossOrigin.statusCode, 200);
    assert.ok(!hasCorsHeader(crossOrigin), `${url} stays unreadable to other web pages`);
  }
  const wrongHead = await callHead(world.handler, '/api/convai/token');
  assert.deepEqual([wrongHead.statusCode, wrongHead.text, wrongHead.headers.Allow], [405, '', 'POST, OPTIONS']);
  const notReadyHead = await callHead(createReadyHandler({ env: {} }), '/api/readyz');
  assert.deepEqual([notReadyHead.statusCode, notReadyHead.text], [503, '']);
});

test('the admin config body: empty, wrong-typed or oversized bodies are 400 and change nothing, a bad half stops the good half, and the bounds are inclusive', async () => {
  const world = createWorld();
  const handler = createAdminConfigHandler({ env: world.env, store: world.store });
  const read = async () => (await call(handler, { url: '/api/admin/config', headers: asAdmin })).json;
  const sized = (size, limit) => {
    const empty = JSON.stringify({ dailyInteractionLimit: limit, pad: '' });
    const text = JSON.stringify({ dailyInteractionLimit: limit, pad: 'x'.repeat(size - empty.length) });
    assert.equal(Buffer.byteLength(text), size);
    return text;
  };

  for (const body of ['', 'null', '[]', '"dailyInteractionLimit"', '7', '{"other": 1}', '{"dailyInteractionLimit": 5']) {
    const response = await post(handler, body);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    assert.equal(response.json.error, 'bad_request');
    assert.equal(typeof response.json.message, 'string');
  }
  assert.equal((await post(handler, sized(8192, 5))).json.stored, 5, 'a body of exactly 8192 bytes is read');
  const tooBig = await post(handler, sized(8193, 6));
  assert.equal(tooBig.statusCode, 400, 'one byte more is refused, as an unreadable body');
  assert.equal(tooBig.json.error, 'bad_request');
  assert.equal((await read()).stored, 5, 'the oversized request applied nothing');

  const before = await read();
  const badPlans = await post(handler, { dailyInteractionLimit: 150, paidPlans: { plans: [] } });
  assert.equal(badPlans.json.error, 'bad_plans');
  const badLimit = await post(handler, { dailyInteractionLimit: 99999, paidPlans: PLAN_LIST });
  assert.equal(badLimit.json.error, 'out_of_range');
  assert.deepEqual(badLimit.json, { error: 'out_of_range', min: 1, max: 10000 });
  assert.deepEqual(await read(), before, 'when one half is refused the other half is not applied either');

  const both = await post(handler, { dailyInteractionLimit: 150, paidPlans: PLAN_LIST });
  assert.equal(both.json.stored, 150);
  assert.deepEqual(both.json.paidPlans, PLAN_LIST);
  const capOnly = await post(handler, '{"dailyInteractionLimit": null}');
  assert.equal(capOnly.json.stored, null);
  assert.deepEqual(capOnly.json.paidPlans, PLAN_LIST, 'removing the limit leaves the plans alone');

  for (const accepted of [1, 10000, ' 42 ', '0042']) {
    const response = await post(handler, { dailyInteractionLimit: accepted });
    assert.equal(response.statusCode, 200, JSON.stringify(accepted));
    assert.equal(response.json.stored, Number(String(accepted).trim()));
  }
  for (const refused of [0, 10001, '', '1e3', '0x10', '1_000', '42.0', '-1', false]) {
    assert.equal((await post(handler, { dailyInteractionLimit: refused })).statusCode, 400, JSON.stringify(refused));
  }
  assert.equal((await read()).stored, 42, 'only the last accepted value stands');
});

test('the admin turns list cleans its limit and day before they reach the store, and survives an address it cannot parse', async () => {
  const world = createWorld();
  const seen = [];
  const store = { pipeline: async commands => { seen.push(commands); return world.store.pipeline(commands); } };
  const handler = createAdminTurnsHandler({ env: world.env, store, now: () => world.clock.now });
  const ask = async url => {
    const response = await call(handler, { url, headers: asAdmin });
    assert.equal(response.statusCode, 200, url);
    const [, key, from, to] = seen.at(-1)[0];
    return { day: response.json.day, key, range: [from, to] };
  };
  assert.deepEqual(await ask('/api/admin/turns'), { day: '2026-10-14', key: 'turns:2026-10-14', range: ['0', '49'] });
  for (const [limit, last] of [['abc', '49'], ['0', '49'], ['-5', '0'], ['1', '0'], ['7.9', '6'], ['200', '199'], ['99999', '199']]) {
    assert.deepEqual((await ask(`/api/admin/turns?limit=${limit}`)).range, ['0', last], `limit=${limit}`);
  }
  assert.equal((await ask('/api/admin/turns?day=2026-10-01')).key, 'turns:2026-10-01');
  for (const day of ['yesterday', '2026-10-1', '2026-10-01%0A', '..%2F..%2Fcfg', '20261001', '']) {
    const answer = await ask(`/api/admin/turns?day=${day}`);
    assert.equal(answer.key, 'turns:2026-10-14', `day=${day} falls back to today (UTC)`);
  }
  const unparsable = await ask('http://[');
  assert.deepEqual([unparsable.day, unparsable.range], ['2026-10-14', ['0', '49']]);

  for (const answer of [null, undefined]) {
    const broken = createAdminTurnsHandler({ env: world.env, store: { pipeline: async () => answer } });
    assert.deepEqual((await call(broken, { headers: asAdmin })).json, { error: 'unavailable' }, `a store answering ${answer}`);
  }
});

test('with the store failing or absent the admin calls answer a plain 503, the public ones a null list, and none repeats upstream text', async () => {
  const leak = [FAKE_API_KEY, 'fake-store-token', 'https://store.invalid/pipeline'];
  const throwing = async () => { throw new Error(leak.join(' ')); };
  const options = { env: makeEnv(), store: { command: throwing, pipeline: throwing, evalScript: throwing } };
  const config = createAdminConfigHandler(options);
  const answers = {
    'turns': await call(createAdminTurnsHandler(options), { url: '/api/admin/turns', headers: asAdmin }),
    'config read': await call(config, { url: '/api/admin/config', headers: asAdmin }),
    'config set limit': await post(config, { dailyInteractionLimit: 5 }),
    'config remove limit': await post(config, { dailyInteractionLimit: null }),
    'config set plans': await post(config, { paidPlans: PLAN_LIST }),
    'ready ping': await call(createReadyHandler(options), { url: '/api/readyz?ping=1', headers: asAdmin }),
    'plans': await call(createPlansHandler(options), { url: '/api/convai/plans' }),
  };
  for (const [name, response] of Object.entries(answers)) {
    assert.equal(response.statusCode, name === 'plans' ? 200 : 503, name);
    for (const part of leak) assert.ok(!response.text.includes(part), `${name} repeats ${part}`);
  }
  for (const name of ['turns', 'config read', 'config set limit', 'config remove limit', 'config set plans']) {
    assert.deepEqual(answers[name].json, { error: 'unavailable' }, name);
  }
  assert.equal(answers['ready ping'].json.store, 'unreachable');
  assert.equal(answers.plans.json.config, null);

  // A deploy that has the admin secret but no Redis: bad input is still told off first, and the rest is "unavailable".
  const fetched = [];
  const fetchImpl = async url => { fetched.push(String(url)); throw new TypeError('Failed to parse URL'); };
  const bare = { env: { CONVAI_AUTH_ADMIN_SECRET: ADMIN_SECRET }, fetchImpl };
  assert.deepEqual((await call(createAdminTurnsHandler(bare), { headers: asAdmin })).json, { error: 'unavailable' });
  assert.deepEqual((await call(createAdminConfigHandler(bare), { headers: asAdmin })).json, { error: 'unavailable' });
  assert.equal((await post(createAdminConfigHandler(bare), '{}')).statusCode, 400);
  assert.equal((await post(createAdminConfigHandler(bare), { dailyInteractionLimit: 5 })).statusCode, 503);
  const ready = await call(createReadyHandler(bare), { url: '/api/readyz?ping=1', headers: asAdmin });
  assert.equal(ready.statusCode, 503);
  assert.equal(ready.json.status, 'not_ready');
  assert.ok(!('store' in ready.json), 'with no store settings there is nothing to ping');
  assert.equal((await call(createPlansHandler(bare), {})).json.config, null);
  assert.ok(fetched.every(url => !/^https?:/i.test(url)), 'no real address was ever contacted');

  // A Redis that answers, but with nothing the code can read, is the same 503.
  const garbled = createAdminConfigHandler({ env: makeEnv(), store: { command: async () => 'OK', pipeline: async () => null } });
  assert.deepEqual((await call(garbled, { headers: asAdmin })).json, { error: 'unavailable' });
  assert.deepEqual((await post(garbled, { dailyInteractionLimit: 5 })).json, { error: 'unavailable' });
});

test('/readyz edges: a blank deploy is all false, a store outage is invisible to the public, and an odd PING reply is named but not repeated', async () => {
  const blank = await call(createReadyHandler({ env: {} }), { url: '/api/readyz' });
  assert.equal(blank.statusCode, 503);
  assert.deepEqual([blank.json.status, blank.json.mode, blank.json.paused], ['not_ready', 'shared', false]);
  assert.deepEqual(Object.keys(blank.json.env), [...ENV_NAMES]);
  assert.ok(Object.values(blank.json.env).every(value => value === false));

  const odd = await call(createReadyHandler({ env: makeEnv({ CONVAI_AUTH_MIN_VERSION: '   ', CONVAI_AUTH_PAUSED: '0' }) }), { url: '/api/readyz' });
  assert.equal(odd.json.env.CONVAI_AUTH_MIN_VERSION, false, 'blank space is not a value');
  assert.equal(odd.json.env.CONVAI_AUTH_PAUSED, true, 'it is set...');
  assert.equal(odd.json.paused, false, '...but "0" does not pause anything');
  assert.equal((await call(createReadyHandler({ env: makeEnv({ CONVAI_AUTH_PAUSED: ' On ' }) }), { url: '/api/readyz' })).json.paused, true);

  const touched = [];
  const down = { command: async args => { touched.push(args); throw new Error('down'); } };
  const handler = createReadyHandler({ env: makeEnv(), store: down });
  const quiet = [
    ['/api/readyz', {}],
    ['/api/readyz?ping=1', {}],
    ['/api/readyz?ping=1', { authorization: `Bearer ${SIGNING_SECRET}` }],
    ['/api/readyz?ping=true', asAdmin],
    ['/api/readyz?ping=0', asAdmin],
    ['/api/readyz?PING=1', asAdmin],
  ];
  for (const [url, headers] of quiet) {
    const response = await call(handler, { url, headers });
    assert.equal(response.statusCode, 200, `${url} cannot tell the public that the store is down`);
    assert.ok(!('store' in response.json), url);
  }
  assert.deepEqual(touched, [], 'only ping=1 with the admin secret reaches the store');
  const probe = await call(handler, { url: '/api/readyz?ping=1', headers: asAdmin });
  assert.equal(touched.length, 1);
  assert.deepEqual([probe.statusCode, probe.json.store], [503, 'unreachable']);

  const strange = createReadyHandler({ env: makeEnv(), store: { command: async () => 'NOPE' } });
  const reply = await call(strange, { url: '/api/readyz?ping=1', headers: asAdmin });
  assert.equal(reply.json.store, 'unexpected');
  assert.ok(!reply.text.includes('NOPE'));
});

test('an admin write whose body fails while being read (the client went away) gets the 400 of any unreadable body instead of a rejected handler', async () => {
  const world = createWorld();
  const admin = createAdminConfigHandler({ env: world.env, store: world.store });
  const broken = new Readable({ read() { this.destroy(new Error('aborted')); } });
  broken.method = 'POST';
  broken.url = '/api/admin/config';
  broken.headers = asAdmin;
  const response = mockResponse();
  await admin(broken, response);
  assert.equal(response.statusCode, 400);
  assert.equal(response.json.error, 'bad_request');
  assert.equal(world.store.commands, 0, 'nothing was written');
});
