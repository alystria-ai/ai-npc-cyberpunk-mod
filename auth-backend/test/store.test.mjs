import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIT_SCRIPT } from '../api/_lib/admit.js';
import { StoreError, createUpstashStore } from '../api/_lib/store.js';
import { checkSignature, pseudonym, signBody } from '../api/_lib/crypto.js';
import { compareVersions, parseVersion } from '../api/_lib/version.js';
import { readRawBody } from '../api/_lib/http.js';

function fakeUpstash(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), auth: init.headers.Authorization, body });
    const answer = await handler(body, String(url));
    return Response.json(answer.body, { status: answer.status ?? 200 });
  };
  return { fetchImpl, calls };
}

test('commands go to the REST address with the bearer token, as a JSON array', async () => {
  const { fetchImpl, calls } = fakeUpstash(() => ({ body: { result: 'PONG' } }));
  const store = createUpstashStore({ url: 'https://example.invalid/', token: 'tok', fetchImpl });
  assert.equal(await store.command(['PING']), 'PONG');
  assert.deepEqual(calls[0], { url: 'https://example.invalid', auth: 'Bearer tok', body: ['PING'] });
});

test('a script is sent with EVAL once, then by hash, and falls back to EVAL when the server lost it', async () => {
  let loaded = false;
  const { fetchImpl, calls } = fakeUpstash(body => {
    if (body[0] === 'EVALSHA' && !loaded) return { status: 400, body: { error: 'NOSCRIPT No matching script' } };
    loaded = true;
    return { body: { result: ['ok', 1, ''] } };
  });
  const store = createUpstashStore({ url: 'https://example.invalid', token: 't', fetchImpl });
  await store.evalScript(ADMIT_SCRIPT, ['k1', 'k2'], [1, 'two']);
  await store.evalScript(ADMIT_SCRIPT, ['k1', 'k2'], [1, 'two']);
  assert.deepEqual(calls.map(call => call.body[0]), ['EVAL', 'EVALSHA']);
  assert.deepEqual(calls[1].body.slice(2), ['2', 'k1', 'k2', '1', 'two']);
  loaded = false; // the server restarted and forgot the script
  await store.evalScript(ADMIT_SCRIPT, ['k1', 'k2'], [1, 'two']);
  assert.deepEqual(calls.slice(2).map(call => call.body[0]), ['EVALSHA', 'EVAL']);
});

test('every failure becomes a StoreError (network, HTTP error, error reply, bad JSON)', async () => {
  const cases = [
    async () => { throw new TypeError('fetch failed'); },
    async () => new Response('{"error":"ERR boom"}', { status: 500 }),
    async () => Response.json({ error: 'WRONGPASS' }),
    async () => new Response('not json', { status: 200 }),
  ];
  for (const fetchImpl of cases) {
    const store = createUpstashStore({ url: 'https://example.invalid', token: 't', fetchImpl });
    await assert.rejects(store.command(['PING']), StoreError);
  }
  const store = createUpstashStore({ url: 'https://example.invalid', token: 't',
    fetchImpl: async () => Response.json([{ result: 1 }]) });
  await assert.rejects(store.pipeline([['GET', 'a'], ['GET', 'b']]), StoreError);
});

test('the pipeline is one request', async () => {
  const { fetchImpl, calls } = fakeUpstash(body => ({ body: body.map((_, index) => ({ result: index })) }));
  const store = createUpstashStore({ url: 'https://example.invalid', token: 't', fetchImpl });
  assert.deepEqual(await store.pipeline([['GET', 'a'], ['GET', 'b']]), [0, 1]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/pipeline$/);
});

test('signatures: format, window, and tampering', () => {
  const now = 1_790_000_000_000;
  const timestamp = String(Math.floor(now / 1000));
  const signature = signBody('s'.repeat(40), timestamp, '{"a":1}');
  assert.match(signature, /^v1=[0-9a-f]{64}$/);
  const check = overrides => checkSignature({ secret: 's'.repeat(40), timestamp, signature, body: '{"a":1}', nowMs: now, ...overrides });
  assert.equal(check({}), 'ok');
  assert.equal(check({ body: '{"a":2}' }), 'bad');
  assert.equal(check({ secret: 'q'.repeat(40) }), 'bad');
  assert.equal(check({ nowMs: now + 121_000 }), 'stale');
  assert.equal(check({ nowMs: now + 120_000 }), 'ok');
  assert.equal(check({ signature: undefined }), 'bad');
  assert.equal(check({ signature: signature.slice(3) }), 'bad');
  assert.equal(check({ timestamp: '12' }), 'bad');
});

test('pseudonyms are stable, keyed and kind-separated', () => {
  const a = pseudonym('k'.repeat(40), 'ip', '203.0.113.1');
  assert.equal(a, pseudonym('k'.repeat(40), 'ip', '203.0.113.1'));
  assert.notEqual(a, pseudonym('k'.repeat(40), 'install', '203.0.113.1'));
  assert.notEqual(a, pseudonym('j'.repeat(40), 'ip', '203.0.113.1'));
  assert.match(a, /^[0-9a-f]{24}$/);
});

test('version parsing and comparison', () => {
  assert.deepEqual(parseVersion('0.2'), [0, 2]);
  assert.deepEqual(parseVersion('2077.1.1'), [2077, 1, 1]);
  assert.equal(parseVersion('0.2-rc.1')[1], 2);
  for (const bad of ['', 'v0.2', '1', '1.2.3.4.5', '0.2 ', null, 7]) assert.equal(parseVersion(bad), null, String(bad));
  assert.equal(compareVersions('0.2', '0.2.0'), 0);
  assert.ok(compareVersions('0.10', '0.9') > 0);
  assert.ok(compareVersions('0.2', '0.2.1') < 0);
  assert.equal(compareVersions('x', '0.2'), null);
});

test('the raw body reader limits size and passes text through', async () => {
  assert.equal(await readRawBody({ body: 'abc' }), 'abc');
  assert.equal(await readRawBody({ body: Buffer.from('abc') }), 'abc');
  assert.equal(await readRawBody({ body: 'x'.repeat(5000) }), null);
  assert.equal(await readRawBody({}), '');
});
