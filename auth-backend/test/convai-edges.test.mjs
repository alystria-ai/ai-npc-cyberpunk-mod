// What the token endpoint and the Convai client do when Convai misbehaves, and when two requests want the same mint.
// Nothing here uses the network: every upstream is a function handed in as fetchImpl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConvaiError, createConvaiClient } from '../api/_lib/convai.js';
import { pseudonym } from '../api/_lib/crypto.js';
import { FakeStore } from '../testkit/fake-store.mjs';
import { FAKE_API_KEY, SIGNING_SECRET, START, captureErrors, createWorld } from '../testkit/harness.mjs';

const HOUR = 3_600_000;
const CONNECT = 'https://convai.invalid/user/connect';
const REVOKE = 'https://convai.invalid/user/revoke-token';
const UPSTREAM_TEXT = 'upstream-detail-that-must-stay-private';

const healthy = world => async () => Response.json({ apiAuthToken: 'good-token', expirationTime: new Date(world.clock.now + HOUR).toISOString() });
/** A world whose Convai is `state.impl`, swapped by the test, and which counts every call made to it. */
function worldWithUpstream(impl, env = {}) {
  const state = { impl, calls: [] };
  const world = createWorld(env, { handlerOptions: { fetchImpl: async (url, init) => { state.calls.push({ url: String(url), headers: init.headers }); return state.impl(url, init); } } });
  state.recover = () => { state.impl = healthy(world); };
  return { world, state };
}
const hang = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
const client = (fetchImpl, extra = {}) => createConvaiClient({ fetchImpl, connectUrl: CONNECT, revokeUrl: REVOKE, ...extra });
const caught = async promise => promise.then(() => assert.fail('expected a rejection'), error => error);

test('every way Convai can refuse or garble a mint is a 502 with nothing of its text in the answer or the log, and is not cached', async () => {
  const body = status => async () => new Response(JSON.stringify({ detail: `bad key ${FAKE_API_KEY} ${UPSTREAM_TEXT}` }), { status });
  const failures = {
    'unauthorized': [body(401), 'responded 401'],
    'forbidden': [body(403), 'responded 403'],
    'rate limited': [body(429), 'responded 429'],
    'server error': [body(500), 'responded 500'],
    'unavailable': [body(503), 'responded 503'],
    'network down': [async () => { throw new TypeError(`fetch failed for ${FAKE_API_KEY} ${UPSTREAM_TEXT}`); }, 'unreachable'],
    'an error page with status 200': [async () => new Response(`<html>${UPSTREAM_TEXT}</html>`), 'no JSON'],
    'an empty body': [async () => new Response(''), 'no JSON'],
    'JSON null': [async () => new Response('null'), 'no apiAuthToken'],
    'an empty object': [async () => Response.json({}), 'no apiAuthToken'],
    'a blank token': [async () => Response.json({ apiAuthToken: '   ' }), 'no apiAuthToken'],
    'a token that is not text': [async () => Response.json({ apiAuthToken: 12345 }), 'no apiAuthToken'],
    'a token that is an object': [async () => Response.json({ apiAuthToken: { value: 'x' } }), 'no apiAuthToken'],
  };
  for (const [label, [impl, logged]] of Object.entries(failures)) {
    const { world, state } = worldWithUpstream(impl);
    let response;
    const logs = await captureErrors(async () => { response = await world.send(); });
    assert.equal(response.statusCode, 502, label);
    assert.deepEqual(response.json, { error: 'convai_unavailable' }, label);
    assert.equal(response.headers['Retry-After'], '30', label);
    assert.ok(logs.includes(logged), `${label}: the log says only "${logged}", it said: ${logs}`);
    for (const secret of [FAKE_API_KEY, UPSTREAM_TEXT]) assert.ok(!response.text.includes(secret) && !logs.includes(secret), `${label} leaks ${secret}`);
    assert.equal(state.calls[0].headers['CONVAI-API-KEY'], FAKE_API_KEY, 'the key goes to Convai, in a header, and nowhere else');

    state.recover();
    const next = await world.send();
    assert.equal(next.statusCode, 200, `${label}: the next request is not poisoned by the failure`);
    assert.equal(next.json.authToken, 'good-token');
    assert.equal(state.calls.length, 2, `${label}: the failure was not remembered as a token`);
  }
});

test('the Convai client reads either spelling of the answer, trims the token and gives an hour of life when the expiry is missing or unreadable', async () => {
  const now = () => 1_800_000_000_000;
  const requests = [];
  const mint = async data => client(async (url, init) => { requests.push({ url, init }); return Response.json(data); }, { now }).mint('the-key');
  assert.deepEqual(await mint({ apiAuthToken: '  t1  ', expirationTime: '2027-01-01T00:00:00Z' }), { token: 't1', expiresAtMs: Date.parse('2027-01-01T00:00:00Z') });
  assert.deepEqual(await mint({ api_auth_token: 't2', expiration_time: 1_900_000_000 }), { token: 't2', expiresAtMs: 1_900_000_000_000 }, 'a small number is seconds');
  assert.deepEqual(await mint({ apiAuthToken: 't3', expirationTime: 1_900_000_000_000 }), { token: 't3', expiresAtMs: 1_900_000_000_000 }, 'a large number is milliseconds');
  assert.deepEqual(await mint({ apiAuthToken: 't4', api_auth_token: 'other' }), { token: 't4', expiresAtMs: now() + HOUR }, 'the camelCase name wins');
  for (const junk of [undefined, null, 0, '', 'tomorrow-ish', {}, []]) {
    assert.equal((await mint({ apiAuthToken: 't5', expirationTime: junk })).expiresAtMs, now() + HOUR, `expiry ${JSON.stringify(junk)}`);
  }
  assert.equal(requests[0].url, CONNECT);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers['CONVAI-API-KEY'], 'the-key');
  assert.equal(requests[0].init.body, '{}');
  assert.ok(requests[0].init.signal instanceof AbortSignal, 'every call can time out');
});

test('Convai client errors are short and generic, a hung Convai times out, and a revoke never throws', async () => {
  const keepAlive = setInterval(() => {}, 10); // an abort timer does not keep node alive by itself
  try {
    const refused = await caught(client(async () => new Response(`key ${FAKE_API_KEY} ${UPSTREAM_TEXT}`, { status: 401 })).mint(FAKE_API_KEY));
    assert.ok(refused instanceof ConvaiError);
    assert.equal(refused.message, 'Convai Connect responded 401');
    const offline = await caught(client(async () => { throw new TypeError(`getaddrinfo ${FAKE_API_KEY}`); }).mint(FAKE_API_KEY));
    assert.equal(offline.message, 'Convai Connect unreachable');
    const slow = await caught(client(hang, { timeoutMs: 20 }).mint(FAKE_API_KEY));
    assert.equal(slow.message, 'Convai Connect unreachable', 'a timeout reads the same as a network failure');
    const garbled = await caught(client(async () => new Response('<html>')).mint(FAKE_API_KEY));
    assert.equal(garbled.message, 'Convai Connect returned no JSON');

    assert.equal(await client(async () => Response.json({})).revoke(FAKE_API_KEY, 't'), true);
    assert.equal(await client(async () => new Response('', { status: 400 })).revoke(FAKE_API_KEY, 't'), false);
    assert.equal(await client(async () => new Response('', { status: 500 })).revoke(FAKE_API_KEY, 't'), false);
    assert.equal(await client(async () => { throw new TypeError('network down'); }).revoke(FAKE_API_KEY, 't'), false);
    assert.equal(await client(hang, { timeoutMs: 20 }).revoke(FAKE_API_KEY, 't'), false);
  } finally {
    clearInterval(keepAlive);
  }
});

test('requests that arrive together share one Convai mint, in shared mode and for one install in per-install mode, whether it works or fails', async () => {
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const gated = status => {
    let release;
    const open = new Promise(resolve => { release = resolve; });
    const state = { connects: 0 };
    const fetchImpl = async () => {
      state.connects += 1;
      await open;
      if (status !== 200) return new Response('{}', { status });
      return Response.json({ apiAuthToken: 'shared-token', expirationTime: new Date(START + HOUR).toISOString() });
    };
    return { fetchImpl, state, release };
  };

  const working = gated(200);
  const world = createWorld({}, { handlerOptions: { fetchImpl: working.fetchImpl } });
  const together = Array.from({ length: 5 }, (_, index) => world.send({ installId: randomUUID(), ip: `198.51.100.${index + 1}` }));
  await settle(); // all five are past the store and waiting for Convai
  working.release();
  const answers = await Promise.all(together);
  assert.equal(working.state.connects, 1);
  assert.deepEqual(answers.map(answer => answer.statusCode), [200, 200, 200, 200, 200]);
  assert.equal(new Set(answers.map(answer => answer.json.authToken)).size, 1);

  const broken = gated(500);
  const down = createWorld({}, { handlerOptions: { fetchImpl: broken.fetchImpl } });
  const failing = Array.from({ length: 4 }, (_, index) => down.send({ installId: randomUUID(), ip: `198.51.100.${index + 1}` }));
  await settle();
  broken.release();
  let results;
  await captureErrors(async () => { results = await Promise.all(failing); });
  assert.equal(broken.state.connects, 1, 'one failed attempt serves all four');
  assert.deepEqual(results.map(answer => answer.statusCode), [502, 502, 502, 502]);

  const perInstall = gated(200);
  const own = createWorld({ CONVAI_AUTH_MODE: 'per-install' }, { handlerOptions: { fetchImpl: perInstall.fetchImpl } });
  const install = randomUUID();
  const retries = Array.from({ length: 3 }, () => own.send({ installId: install }));
  await settle();
  perInstall.release();
  const same = await Promise.all(retries);
  assert.equal(perInstall.state.connects, 1, 'one install asking three times at once costs one mint');
  assert.equal(new Set(same.map(answer => answer.json.authToken)).size, 1);
  assert.equal((await own.send({ installId: install })).json.authToken, same[0].json.authToken, 'and the saved token serves the next call');
  assert.equal(perInstall.state.connects, 1);
});

test('per-install mode: a token that cannot be saved is still handed out, and a revoke Convai will not take still ends in a clean 429', async () => {
  // The save is a plain command; the admission script keeps working.
  const fake = new FakeStore({ now: () => START });
  const store = { evalScript: (...args) => fake.evalScript(...args), command: async () => { throw new Error('SET failed, token fake-token-1'); } };
  const unsaved = createWorld({ CONVAI_AUTH_MODE: 'per-install' }, { handlerOptions: { store } });
  let first, second;
  const logs = await captureErrors(async () => {
    first = await unsaved.send();
    second = await unsaved.send();
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json.authToken, 'fake-token-1');
  assert.ok(logs.includes('could not save a token'), logs);
  assert.ok(!logs.includes('fake-token'), 'the log never holds the token');
  assert.equal(second.json.authToken, 'fake-token-2', 'nothing was kept, so the next call mints again');

  for (const revokeFails of [{ status: 500 }, 'throw']) {
    const revoked = [];
    const fetchImpl = async (url, init) => {
      if (String(url).endsWith('/user/connect')) return Response.json({ apiAuthToken: 'per-install-token', expirationTime: new Date(START + HOUR).toISOString() });
      revoked.push(JSON.parse(init.body).apiAuthToken);
      if (revokeFails === 'throw') throw new TypeError('network down');
      return new Response('{}', revokeFails);
    };
    const world = createWorld({ CONVAI_AUTH_MODE: 'per-install', CONVAI_AUTH_DAILY_TURN_CAP: '20' }, { handlerOptions: { fetchImpl } });
    assert.equal((await world.send({ turns: 5 })).statusCode, 200);
    const over = await world.send({ turns: 15 });
    assert.equal(over.statusCode, 429, JSON.stringify(revokeFails));
    assert.equal(over.json.error, 'daily');
    assert.ok(!over.text.includes('per-install-token'), 'the refusal never carries a token');
    assert.deepEqual(revoked, ['per-install-token'], 'the revoke was attempted once');
    const key = `tok:${pseudonym(SIGNING_SECRET, 'install', world.defaultInstall)}`;
    assert.equal(await world.store.command(['GET', key]), null, 'our saved copy is dropped even though Convai kept the token alive');
  }
});
