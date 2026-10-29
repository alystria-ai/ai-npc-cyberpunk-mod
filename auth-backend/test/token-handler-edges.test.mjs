// Edge and error paths of POST /api/convai/token that token-handler.test.mjs does not pin: what every refusal looks like, a
// deploy with nothing configured, body and signature corner cases, a misbehaving store, and the wait times given to clients.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pseudonym, signBody } from '../api/_lib/crypto.js';
import { addressBucket } from '../api/_lib/http.js';
import { createTokenHandler } from '../api/_lib/token-handler.js';
import { FAKE_API_KEY, SIGNING_SECRET, START, captureErrors, createWorld, makeEnv, mockResponse } from '../testkit/harness.mjs';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const FORGED = 'v1=' + '0'.repeat(64);

const run = async (handler, request) => {
  const response = mockResponse();
  await handler(request, response);
  return response;
};
const streamOf = (chunks, headers = {}) => {
  const stream = Readable.from(chunks);
  stream.method = 'POST';
  stream.headers = headers;
  return stream;
};
const signedHeaders = (world, body) => {
  const timestamp = String(Math.floor(world.clock.now / 1000));
  return { 'x-convai-timestamp': timestamp, 'x-convai-signature': signBody(SIGNING_SECRET, timestamp, body), 'x-vercel-forwarded-for': '203.0.113.9' };
};

test('every refusal is a short JSON answer with the same hardening headers, no cross-origin permission and no stack trace', async () => {
  const answers = [];
  const add = (label, status, response) => answers.push({ label, status, response });
  const logs = await captureErrors(async () => {
    const world = createWorld({ CONVAI_AUTH_MIN_VERSION: '0.2.1', CONVAI_AUTH_INSTALL_PER_HOUR: '1' });
    const now = Math.floor(world.clock.now / 1000);
    add('wrong method', 405, await world.send({ method: 'GET' }));
    add('forged signature', 401, await world.send({ signature: FORGED }));
    add('stale clock', 401, await world.send({ timestamp: String(now - 500) }));
    add('too large', 413, await world.send({ body: 'x'.repeat(5000) }));
    add('bad body', 400, await world.send({ body: 'nope' }));
    add('outdated', 426, await world.send({ version: '0.1' }));
    assert.equal((await world.send({ version: '0.2.1' })).statusCode, 200);
    add('hourly limit', 429, await world.send({ version: '0.2.1' }));

    const blockedId = randomUUID();
    const blocked = createWorld({ CONVAI_AUTH_BLOCKED_INSTALLS: pseudonym(SIGNING_SECRET, 'install', blockedId) });
    blocked.defaultInstall = blockedId;
    add('blocked install', 403, await blocked.send());
    add('daily limit', 429, await createWorld({ CONVAI_AUTH_DAILY_TURN_CAP: '5' }).send({ turns: 5 }));
    add('paused', 503, await createWorld({ CONVAI_AUTH_PAUSED: '1' }).send());
    add('unconfigured', 503, await run(createTokenHandler({ env: {}, now: () => START }), { method: 'POST', headers: {}, body: '{}' }));
    const down = createWorld();
    down.store.failing = true;
    add('store down', 503, await down.send());
    const noConvai = createWorld();
    noConvai.convai.state.failing = true;
    add('Convai down', 502, await noConvai.send());
    const spent = createWorld({ CONVAI_AUTH_MODE: 'per-install', CONVAI_AUTH_MINTS_PER_DAY: '1' });
    await spent.send({ installId: randomUUID() });
    add('mint budget spent', 503, await spent.send({ installId: randomUUID() }));
  });
  assert.ok(!logs.includes(FAKE_API_KEY) && !logs.includes('fake-token'), 'the failures are logged without the key or a token');
  for (const { label, status, response } of answers) {
    assert.equal(response.statusCode, status, label);
    assert.equal(response.headers['Cache-Control'], 'no-store', label);
    assert.equal(response.headers['X-Content-Type-Options'], 'nosniff', label);
    assert.equal(response.headers['X-Frame-Options'], 'DENY', label);
    assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8', label);
    assert.equal(typeof response.json.error, 'string', label);
    assert.ok(!Object.keys(response.headers).some(name => name.toLowerCase().startsWith('access-control-')), `${label} grants no cross-origin access`);
    assert.equal(response.headers.Vary, 'Origin', label);
    assert.ok(!/node_modules|\.m?js:\d|Error:/.test(response.text), `${label} shows no stack or file path: ${response.text}`);
    assert.ok(!response.text.includes(FAKE_API_KEY) && !response.text.includes(SIGNING_SECRET), label);
  }
});

test('a deploy with nothing configured answers a bare "unconfigured" to everyone and reaches for no store and no Convai', async () => {
  const reached = [];
  const fetchImpl = async url => { reached.push(String(url)); throw new Error('the network must not be used'); };
  const blank = { CONVAI_API_KEY: '   ', CONVAI_AUTH_SIGNING_SECRET: '', UPSTASH_REDIS_REST_URL: '\n', KV_REST_API_URL: ' ', KV_REST_API_TOKEN: '\t' };
  const shortSecret = makeEnv({ CONVAI_AUTH_SIGNING_SECRET: 's'.repeat(31) });
  for (const env of [{}, blank, shortSecret]) {
    const handler = createTokenHandler({ env, fetchImpl, now: () => START });
    for (const request of [{ method: 'POST', headers: {}, body: '' }, { method: 'POST', headers: { 'x-convai-signature': FORGED }, body: '{}' }]) {
      const response = await run(handler, request);
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json, { error: 'unconfigured' }, 'it does not say which setting is missing');
    }
  }
  assert.deepEqual(reached, []);
  // 32 characters is enough: the request then gets as far as the signature check, which a different secret fails.
  const exact = createWorld({ CONVAI_AUTH_SIGNING_SECRET: 's'.repeat(32) });
  assert.equal((await exact.send()).json.error, 'unauthorized');
});

test('the body limit is 4096 bytes, not characters, and is applied before the signature is looked at', async () => {
  const world = createWorld();
  assert.equal((await world.send({ body: 'x'.repeat(4096) })).json.error, 'bad_request', 'exactly at the limit it is read, then fails as not JSON');
  assert.equal((await world.send({ body: 'x'.repeat(4097) })).statusCode, 413);
  assert.equal((await world.send({ body: 'é'.repeat(2048) })).json.error, 'bad_request', '2048 two-byte characters are 4096 bytes');
  assert.equal((await world.send({ body: 'é'.repeat(2049) })).statusCode, 413, '2049 characters are over the limit in bytes');
  const unsigned = await world.send({ body: 'x'.repeat(5000), signature: '' });
  assert.equal(unsigned.statusCode, 413, 'a caller with no signature still hears "too large", not "unauthorized"');
  assert.equal(world.store.commands, 0);
  assert.equal(world.convai.state.mints, 0);
});

test('body fields: anything that is not an object, a v4 install id, a version or a whole turn count is 400, and unknown extras are ignored', async () => {
  const world = createWorld({ CONVAI_AUTH_DAILY_TURN_CAP: '10000' });
  const good = () => ({ installId: randomUUID(), modVersion: '0.2', turnsSinceLast: 0 });
  const versionOne = 'c232ab00-9414-11ec-b3c8-9f6bdeced846';
  const wrongVariant = randomUUID().replace(/^(.{19})./, '$10');
  const wholeBodies = ['', 'null', '"text"', '7', 'true', '﻿' + JSON.stringify(good())];
  for (const body of wholeBodies) {
    const response = await world.send({ body });
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    assert.equal(response.json.error, 'bad_request');
  }
  const badFields = [
    { installId: 5 }, { installId: null }, { installId: [randomUUID()] }, { installId: ` ${randomUUID()}` }, { installId: versionOne }, { installId: wrongVariant },
    { modVersion: 0.2 }, { modVersion: null }, { modVersion: undefined }, { modVersion: '0.2 ' },
    { turnsSinceLast: '5' }, { turnsSinceLast: true }, { turnsSinceLast: 1001 }, { turnsSinceLast: 2 ** 53 },
    { minLifeSeconds: '900' }, { minLifeSeconds: 3601 }, { minLifeSeconds: -1 },
  ];
  for (const override of badFields) {
    const response = await world.send({ body: JSON.stringify({ ...good(), ...override }) });
    assert.equal(response.statusCode, 400, JSON.stringify(override));
  }
  assert.equal(world.store.commands, 0, 'none of these reached the store');

  const edge = await world.send({ body: JSON.stringify({ ...good(), turnsSinceLast: 1000, minLifeSeconds: 3600, extra: { nested: [1] }, minClient: '99' }) });
  assert.equal(edge.statusCode, 200, 'the largest report, the largest ask and unknown fields are fine');
  assert.equal(edge.json.allowance.used, 1000);
  const nulls = await world.send({ body: JSON.stringify({ ...good(), turnsSinceLast: null, minLifeSeconds: null }) });
  assert.equal(nulls.statusCode, 200, 'null counts as "nothing to report"');
  assert.equal(nulls.json.allowance.used, 0);

  // The same install written in capitals is the same install, so changing the case does not dodge the hourly limit.
  const strict = createWorld({ CONVAI_AUTH_INSTALL_PER_HOUR: '1' });
  assert.equal((await strict.send({ installId: strict.defaultInstall })).statusCode, 200);
  assert.equal((await strict.send({ installId: strict.defaultInstall.toUpperCase() })).json.error, 'rate');
});

test('signing corner cases: the timestamp is signed too, stamps must be ten digits, a stale stamp is judged first, and content type is ignored', async () => {
  const world = createWorld();
  const body = JSON.stringify({ installId: world.defaultInstall, modVersion: '0.2', turnsSinceLast: 0 });
  const now = Math.floor(world.clock.now / 1000);

  // A request that was signed for an earlier second cannot be given a fresh stamp to make it replayable.
  const earlier = signBody(SIGNING_SECRET, String(now - 30), body);
  assert.equal((await world.send({ body, timestamp: String(now), signature: earlier })).json.error, 'unauthorized');
  for (const timestamp of ['', String(now * 1000), String(now).slice(1), `${now}.5`, `-${now}`, `0x${now.toString(16)}`]) {
    const response = await world.send({ body, timestamp, signature: signBody(SIGNING_SECRET, timestamp, body) });
    assert.equal(response.statusCode, 401, timestamp);
    assert.equal(response.json.error, 'unauthorized', `${timestamp} is malformed, not merely old`);
  }
  const proper = signBody(SIGNING_SECRET, String(now), body);
  for (const signature of ['v2=' + proper.slice(3), proper.slice(0, -1), proper + '0', proper.slice(3), 'V1=' + proper.slice(3)]) {
    assert.equal((await world.send({ body, signature })).json.error, 'unauthorized', signature.slice(0, 12));
  }
  assert.equal((await run(world.handler, { method: 'POST', body })).json.error, 'unauthorized', 'a request with no headers at all is just refused');
  assert.equal((await run(world.handler, { method: 'POST', headers: { 'x-convai-signature': proper }, body })).json.error, 'unauthorized', 'a signature with no stamp');

  // The clock window is judged from the stamp alone, so a client with a wrong clock learns the time even before it can be verified.
  const stale = await world.send({ timestamp: String(now - 500), signature: FORGED });
  assert.equal(stale.json.error, 'stale');
  assert.equal(stale.json.serverTime, now);
  assert.equal((await world.send({ timestamp: String(now - 500), signature: 'nonsense' })).json.error, 'unauthorized');

  // Someone with no valid signature cannot learn the body rules from the answer.
  assert.equal((await world.send({ body: 'not json', signature: FORGED })).json.error, 'unauthorized');
  assert.equal(world.store.commands, 0);

  for (const type of ['application/json', 'application/x-www-form-urlencoded', 'text/plain; charset=utf-8']) {
    assert.equal((await world.send({ body, headers: { 'content-type': type } })).statusCode, 200, type);
  }
});

test('a replay inside the clock window is not stopped, but every copy counts toward the hourly limit and adds its turns', async () => {
  const world = createWorld({ CONVAI_AUTH_INSTALL_PER_HOUR: '3' });
  const body = JSON.stringify({ installId: world.defaultInstall, modVersion: '0.2', turnsSinceLast: 10 });
  const timestamp = String(Math.floor(world.clock.now / 1000));
  const signature = signBody(SIGNING_SECRET, timestamp, body);
  const replay = () => world.send({ body, timestamp, signature });
  for (const used of [10, 20, 30]) assert.equal((await replay()).json.allowance.used, used);
  const refused = await replay();
  assert.equal(refused.statusCode, 429);
  assert.equal(refused.json.error, 'rate');
  world.advance(HOUR);
  const next = await world.send({ turns: 0 });
  assert.equal(next.json.allowance.used, 30, 'the refused copy recorded nothing');
});

test('a streamed body is refused at the size limit before any signature check, and multi-byte text split across chunks still verifies', async () => {
  const world = createWorld();
  const big = await run(world.handler, streamOf([Buffer.alloc(3000, 97), Buffer.alloc(3000, 97)]));
  assert.equal(big.statusCode, 413);
  assert.equal(world.store.commands, 0);

  const body = JSON.stringify({ installId: randomUUID(), modVersion: '0.2', turnsSinceLast: 0, note: 'café €' });
  const bytes = Buffer.from(body);
  const euro = bytes.indexOf(0xe2); // the first of the three bytes of the euro sign
  const chunks = [bytes.subarray(0, euro + 1), bytes.subarray(euro + 1, euro + 2), bytes.subarray(euro + 2)];
  const split = await run(world.handler, streamOf(chunks, signedHeaders(world, body)));
  assert.equal(split.statusCode, 200);

  // When the platform has already parsed the body, only a request signed over the compact re-serialisation can match.
  const parsed = { installId: randomUUID(), modVersion: '0.2', turnsSinceLast: 0 };
  const compact = JSON.stringify(parsed);
  assert.equal((await run(world.handler, { method: 'POST', headers: signedHeaders(world, compact), body: parsed })).statusCode, 200);
  const pretty = JSON.stringify(parsed, null, 2);
  assert.equal((await run(world.handler, { method: 'POST', headers: signedHeaders(world, pretty), body: parsed })).statusCode, 401);
});

test('a store that throws or answers nonsense is a 503 "unavailable" that carries none of its text, mints nothing and logs nothing sensitive', async () => {
  const leak = `${FAKE_API_KEY} fake-store-token https://store.invalid/pipeline`;
  const answers = {
    'throws with secrets in its message': async () => { throw new Error(leak); },
    'null': async () => null,
    'undefined': async () => undefined,
    'empty list': async () => [],
    'plain text': async () => 'OK',
    'a number where the code goes': async () => [1, 0, ''],
    'an object': async () => ({ result: ['ok', 0, ''] }),
    'a code nobody knows': async () => ['weird', 0, '', 100],
  };
  for (const [label, evalScript] of Object.entries(answers)) {
    const store = { evalScript, command: async () => { throw new Error('no other command is expected'); } };
    const world = createWorld({}, { handlerOptions: { store } });
    let response;
    const logs = await captureErrors(async () => { response = await world.send(); });
    assert.equal(response.statusCode, 503, label);
    assert.deepEqual(response.json, { error: 'unavailable' }, label);
    assert.equal(response.headers['Retry-After'], '30', label);
    assert.equal(world.convai.state.mints, 0, label);
    for (const secret of [FAKE_API_KEY, 'fake-store-token', 'store.invalid']) {
      assert.ok(!response.text.includes(secret) && !logs.includes(secret), `${label} leaks ${secret}`);
    }
  }
});

test('the wait a client is told to observe is the real time left in the hour or the day, never under one second', async () => {
  const world = createWorld({ CONVAI_AUTH_INSTALL_PER_HOUR: '1', CONVAI_AUTH_NEW_INSTALLS_PER_IP_PER_DAY: '1' });
  assert.equal((await world.send()).statusCode, 200);
  world.advance(30 * MINUTE); // 10:30
  const middle = await world.send();
  assert.equal(middle.json.error, 'rate');
  assert.equal(middle.json.retryAfterSeconds, 1800);
  assert.equal(middle.headers['Retry-After'], '1800');
  const stranger = await world.send({ installId: randomUUID() });
  assert.equal(stranger.json.error, 'install_limit');
  assert.equal(stranger.json.retryAfterSeconds, 13.5 * 3600, 'until 00:00 UTC');
  assert.equal(stranger.headers['Retry-After'], String(13.5 * 3600));
  world.advance(29 * MINUTE + 59_500); // half a second before 11:00
  const last = await world.send();
  assert.equal(last.json.retryAfterSeconds, 1);
  assert.equal(last.headers['Retry-After'], '1');
});

test('the in-instance flood guard counts only signed requests, asks for 60 seconds, forgets after a minute and is kept per address', async () => {
  const world = createWorld();
  for (let call = 0; call < 70; call++) assert.equal((await world.send({ signature: FORGED })).statusCode, 401);
  // Forged requests from a player's own address used none of its allowance, so nobody can lock a player out by forging.
  for (let call = 0; call < 60; call++) assert.equal((await world.send()).statusCode, 200, `signed request ${call + 1}`);
  const flooded = await world.send();
  assert.equal(flooded.statusCode, 429);
  assert.deepEqual(flooded.json, { error: 'rate', retryAfterSeconds: 60 });
  assert.equal(flooded.headers['Retry-After'], '60');
  assert.equal((await world.send({ ip: '198.51.100.9' })).statusCode, 200, 'another address is not affected');
  world.advance(60_000);
  assert.equal((await world.send()).statusCode, 200, 'the minute is over');
});

test('who counts as one caller: the platform address beats a header the caller can set, and a request with no address shares one strict bucket', async () => {
  const world = createWorld({ CONVAI_AUTH_IP_PER_HOUR: '2' });
  for (const spoof of ['10.0.0.1', '10.0.0.2']) {
    assert.equal((await world.send({ installId: randomUUID(), headers: { 'x-forwarded-for': spoof } })).statusCode, 200);
  }
  const third = await world.send({ installId: randomUUID(), headers: { 'x-forwarded-for': '10.0.0.3' } });
  assert.equal(third.json.error, 'rate', 'x-forwarded-for is ignored while the platform header is present');

  const forwarded = createWorld({ CONVAI_AUTH_IP_PER_HOUR: '1' });
  const via = ip => forwarded.send({ installId: randomUUID(), headers: { 'x-vercel-forwarded-for': '', 'x-forwarded-for': ip } });
  assert.equal((await via('198.51.100.1')).statusCode, 200, 'without the platform header, x-forwarded-for is used');
  assert.equal((await via('198.51.100.2')).statusCode, 200);
  assert.equal((await via('198.51.100.1')).json.error, 'rate');

  const lost = createWorld({ CONVAI_AUTH_IP_PER_HOUR: '2' });
  const anonymous = () => lost.send({ installId: randomUUID(), headers: { 'x-vercel-forwarded-for': '' } });
  assert.equal((await anonymous()).statusCode, 200);
  assert.equal((await anonymous()).statusCode, 200);
  assert.equal((await anonymous()).json.error, 'rate', 'every request with no address at all shares one bucket');
});

test('an IPv6 caller counts as its /64: stepping through the addresses of one line does not get round the per-address limits', async () => {
  assert.equal(addressBucket('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(addressBucket('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
  assert.equal(addressBucket('[2001:db8:1:2:3:4:5:6]'), '2001:db8:1:2::/64');
  assert.equal(addressBucket('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(addressBucket('::ffff:198.51.100.5'), '198.51.100.5', 'an IPv4 address written as IPv6 is the IPv4 address');
  assert.equal(addressBucket('::ffff:c633:6405'), '198.51.100.5');
  assert.equal(addressBucket('198.51.100.5'), '198.51.100.5');
  for (const odd of ['unknown', '', 'not:an::address::', '1:2:3:4:5:6:7:8:9', '2001:db8::zz']) assert.equal(addressBucket(odd), odd, odd);

  const world = createWorld({ CONVAI_AUTH_IP_PER_HOUR: '2' });
  for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2::2']) assert.equal((await world.send({ installId: randomUUID(), ip })).statusCode, 200, ip);
  const stepped = await world.send({ installId: randomUUID(), ip: '2001:db8:1:2:aaaa:bbbb:cccc:dddd' });
  assert.equal(stepped.json.error, 'rate', 'another address of the same /64 is the same caller');
  assert.equal((await world.send({ installId: randomUUID(), ip: '2001:db8:1:3::1' })).statusCode, 200, 'the next /64 is another caller');

  const mapped = createWorld({ CONVAI_AUTH_IP_PER_HOUR: '1' });
  assert.equal((await mapped.send({ installId: randomUUID(), ip: '198.51.100.5' })).statusCode, 200);
  assert.equal((await mapped.send({ installId: randomUUID(), ip: '::ffff:198.51.100.5' })).json.error, 'rate');
});

test('a request body that fails while being read (the client went away) gets a controlled answer instead of a rejected handler', async () => {
  const world = createWorld();
  const broken = new Readable({ read() { this.destroy(new Error('aborted')); } });
  broken.method = 'POST';
  broken.headers = {};
  const response = mockResponse();
  await world.handler(broken, response);
  assert.ok(response.statusCode >= 400 && response.statusCode < 600, 'some error status was written');
  assert.equal(typeof response.json.error, 'string');
});

const EXTENSION = 'chrome-extension://acfemddbfagijogenkmibnbhejamckgf';
const PREFLIGHT = { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-convai-timestamp,x-convai-signature' };

test('an extension preflight gets 204 with its own origin echoed; a web page or a look-alike origin gets 204 and no permission', async () => {
  const world = createWorld();
  const ok = await world.send({ method: 'OPTIONS', headers: { origin: EXTENSION, ...PREFLIGHT } });
  assert.equal(ok.statusCode, 204);
  assert.equal(ok.text, '');
  assert.equal(ok.headers['Access-Control-Allow-Origin'], EXTENSION);
  assert.equal(ok.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
  assert.equal(ok.headers['Access-Control-Allow-Headers'], 'Content-Type, x-convai-timestamp, x-convai-signature');
  assert.equal(ok.headers['Access-Control-Max-Age'], '86400');
  assert.equal(ok.headers.Vary, 'Origin');
  assert.equal(ok.headers['Access-Control-Allow-Credentials'], undefined);
  assert.equal(world.store.commands, 0, 'a preflight costs no store command');
  for (const origin of ['https://example.org', 'chrome-extension://ACFEMDDBFAGIJOGENKMIBNBHEJAMCKGF', 'chrome-extension://acfemddbfagijogenkmibnbhejamckgz',
    'chrome-extension://acfemddbfagijogenkmibnbhejamckgf.evil.org', 'moz-extension://acfemddbfagijogenkmibnbhejamckgf', 'null', '']) {
    const refused = await world.send({ method: 'OPTIONS', headers: { origin, ...PREFLIGHT } });
    assert.equal(refused.statusCode, 204, origin);
    assert.equal(refused.headers['Access-Control-Allow-Origin'], undefined, origin);
    assert.equal(refused.headers.Vary, 'Origin', origin);
  }
});

test('every answer to an extension, the token and each refusal, carries its origin so the extension can read the body', async () => {
  const headers = { origin: EXTENSION };
  const world = createWorld({ CONVAI_AUTH_MIN_VERSION: '0.2.1' });
  const now = Math.floor(world.clock.now / 1000);
  const answers = [
    ['token', 200, await world.send({ headers, version: '0.2.1' })],
    ['stale', 401, await world.send({ headers, timestamp: String(now - 500) })],
    ['forged', 401, await world.send({ headers, signature: 'v1=' + '0'.repeat(64) })],
    ['outdated', 426, await world.send({ headers, version: '0.1' })],
    ['daily', 429, await createWorld({ CONVAI_AUTH_DAILY_TURN_CAP: '5' }).send({ headers, turns: 5 })],
    ['paused', 503, await createWorld({ CONVAI_AUTH_PAUSED: '1' }).send({ headers })],
    ['wrong method', 405, await world.send({ headers, method: 'GET' })],
  ];
  for (const [label, status, response] of answers) {
    assert.equal(response.statusCode, status, label);
    assert.equal(response.headers['Access-Control-Allow-Origin'], EXTENSION, label);
    assert.equal(response.headers.Vary, 'Origin', label);
    assert.equal(response.headers['Access-Control-Allow-Credentials'], undefined, label);
  }
  assert.equal(answers[1][2].json.error, 'stale');
  assert.equal(typeof answers[1][2].json.serverTime, 'number');
});
