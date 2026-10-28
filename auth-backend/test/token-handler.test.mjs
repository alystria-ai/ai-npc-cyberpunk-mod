import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { signBody } from '../api/_lib/crypto.js';
import { createTokenHandler } from '../api/_lib/token-handler.js';
import { FAKE_API_KEY, SIGNING_SECRET, captureErrors, createWorld, makeEnv, mockResponse, streamedRequest } from '../testkit/harness.mjs';

const HOUR = 3_600_000;
const MINUTE = 60_000;

test('a signed request gets a token, with its expiry and allowance, in one store command', async () => {
  const world = createWorld();
  const response = await world.send({ turns: 3 });
  assert.equal(response.statusCode, 200);
  const body = response.json;
  assert.equal(body.authToken, 'fake-token-1');
  assert.equal(body.expiresAt, new Date(world.clock.now + HOUR).toISOString());
  assert.deepEqual(body.allowance, { used: 3, limit: 500, resetAt: '2026-10-15T00:00:00.000Z' });
  assert.equal(world.store.commands, 1, 'the whole admission is one script');
  assert.equal(world.convai.state.mints, 1);
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('the Convai key is never in a response and never in a log, nor is a token', async () => {
  const world = createWorld();
  const logs = await captureErrors(async () => {
    const ok = await world.send();
    assert.ok(!ok.text.includes(FAKE_API_KEY));
    world.convai.state.failing = true;
    world.advance(2 * HOUR);
    const failed = await world.send();
    assert.equal(failed.statusCode, 502);
    assert.ok(!failed.text.includes(FAKE_API_KEY));
    world.store.failing = true;
    await world.send();
  });
  assert.ok(logs.length > 0, 'failures are logged');
  assert.ok(!logs.includes(FAKE_API_KEY) && !logs.includes('fake-token'), logs);
  assert.ok(!logs.includes(world.defaultInstall), 'install ids are not logged either');
});

test('shared mode: one Convai token serves every install, minted once and again when five minutes or less remain', async () => {
  const world = createWorld();
  const first = await world.send({ installId: randomUUID(), ip: '198.51.100.1' });
  const second = await world.send({ installId: randomUUID(), ip: '198.51.100.2' });
  assert.equal(first.json.authToken, second.json.authToken);
  assert.equal(world.convai.state.mints, 1);
  world.advance(54 * MINUTE); // 6 minutes left: still cached
  assert.equal((await world.send()).json.authToken, 'fake-token-1');
  world.advance(90_000); // 4.5 minutes left: re-minted
  const fresh = await world.send();
  assert.equal(fresh.json.authToken, 'fake-token-2');
  assert.equal(world.convai.state.mints, 2);
  assert.equal(new Date(fresh.json.expiresAt).getTime(), world.clock.now + HOUR);
});

test('a renewal that asks for at least N minutes of life gets a fresh token, capped at 15 minutes, so it is never handed the same one', async () => {
  const world = createWorld();
  const ask = minLifeSeconds => world.send({ body: JSON.stringify({ installId: world.defaultInstall, modVersion: '0.2', turnsSinceLast: 0, minLifeSeconds }) });
  assert.equal((await ask(900)).json.authToken, 'fake-token-1');
  world.advance(41 * MINUTE); // 19 minutes left
  assert.equal((await ask(900)).json.authToken, 'fake-token-1');
  world.advance(5 * MINUTE); // 14 minutes left: under what the client asked for
  assert.equal((await ask(900)).json.authToken, 'fake-token-2');
  world.advance(41 * MINUTE); // 19 minutes left again
  assert.equal((await ask(3600)).json.authToken, 'fake-token-2', 'a larger ask is capped at 15 minutes');
  const bad = await world.send({ body: JSON.stringify({ installId: world.defaultInstall, modVersion: '0.2', minLifeSeconds: 99999 }) });
  assert.equal(bad.json.error, 'bad_request');
});

test('the re-mint margin is configurable', async () => {
  const world = createWorld({ CONVAI_AUTH_REMINT_MARGIN_SECONDS: '900' });
  await world.send();
  world.advance(46 * MINUTE); // 14 minutes left, under a 15 minute margin
  assert.equal((await world.send()).json.authToken, 'fake-token-2');
});

test('the kill switch answers "paused" before anything else, with no store or Convai call', async () => {
  const world = createWorld({ CONVAI_AUTH_PAUSED: '1' });
  const response = await world.send();
  assert.equal(response.statusCode, 503);
  assert.equal(response.json.error, 'paused');
  assert.equal(world.store.commands, 0);
  assert.equal(world.convai.state.mints, 0);
  const unsigned = await world.send({ signature: 'v1=00' });
  assert.equal(unsigned.json.error, 'paused', 'even an unsigned call is told the service is paused');
});

test('unset settings answer "unconfigured" instead of failing open', async () => {
  for (const missing of ['CONVAI_API_KEY', 'CONVAI_AUTH_SIGNING_SECRET', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
    const env = makeEnv();
    delete env[missing];
    const handler = createTokenHandler({ env, store: createWorld().store, now: () => 0 });
    const response = mockResponse();
    await handler({ method: 'POST', headers: {}, body: '{}' }, response);
    assert.equal(response.statusCode, 503, missing);
    assert.equal(response.json.error, 'unconfigured');
  }
});

test('only POST is accepted', async () => {
  const world = createWorld();
  for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await world.send({ method })).statusCode, 405, method);
});

test('request signing: a missing, wrong or replayed signature is refused, and a stale clock is told the server time', async () => {
  const world = createWorld();
  assert.equal((await world.send({ signature: '' })).json.error, 'unauthorized');
  assert.equal((await world.send({ signature: 'v1=' + '0'.repeat(64) })).json.error, 'unauthorized');
  assert.equal((await world.send({ timestamp: 'abc' })).json.error, 'unauthorized');
  // A signature made for another body does not carry over.
  const timestamp = String(Math.floor(world.clock.now / 1000));
  const other = signBody(SIGNING_SECRET, timestamp, '{"installId":"x"}');
  assert.equal((await world.send({ signature: other })).json.error, 'unauthorized');
  // Wrong secret.
  const wrong = signBody('another-secret'.padEnd(40, 'z'), timestamp, JSON.stringify({ installId: world.defaultInstall, modVersion: '0.2', turnsSinceLast: 0 }));
  assert.equal((await world.send({ signature: wrong })).json.error, 'unauthorized');
  assert.equal(world.store.commands, 0, 'nothing refused here reaches the store');
  assert.equal(world.convai.state.mints, 0);

  // 119 s old is accepted, 121 s is not.
  const near = await world.send({ timestamp: String(Math.floor(world.clock.now / 1000) - 119) });
  assert.equal(near.statusCode, 200);
  const old = await world.send({ timestamp: String(Math.floor(world.clock.now / 1000) - 121) });
  assert.equal(old.statusCode, 401);
  assert.equal(old.json.error, 'stale');
  assert.equal(old.json.serverTime, Math.floor(world.clock.now / 1000));
  const future = await world.send({ timestamp: String(Math.floor(world.clock.now / 1000) + 121) });
  assert.equal(future.json.error, 'stale');
});

test('the body is checked after the signature: bad JSON, install ids, versions and turn counts', async () => {
  const world = createWorld();
  const sign = async body => world.send({ body });
  assert.equal((await sign('not json')).json.error, 'bad_request');
  assert.equal((await sign('[]')).json.error, 'bad_request');
  assert.equal((await sign(JSON.stringify({ installId: 'nope', modVersion: '0.2' }))).json.error, 'bad_request');
  assert.equal((await sign(JSON.stringify({ installId: randomUUID(), modVersion: 'vNext' }))).json.error, 'bad_request');
  assert.equal((await sign(JSON.stringify({ installId: randomUUID(), modVersion: '0.2', turnsSinceLast: -1 }))).json.error, 'bad_request');
  assert.equal((await sign(JSON.stringify({ installId: randomUUID(), modVersion: '0.2', turnsSinceLast: 1.5 }))).json.error, 'bad_request');
  assert.equal((await sign(JSON.stringify({ installId: randomUUID(), modVersion: '0.2', turnsSinceLast: 5000 }))).json.error, 'bad_request');
  assert.equal((await sign('x'.repeat(5000))).statusCode, 413);
  assert.equal(world.store.commands, 0);
  assert.equal((await sign(JSON.stringify({ installId: randomUUID(), modVersion: '0.2.1-rc.1' }))).statusCode, 200);
});

test('a request read from a stream is signed over the exact bytes sent', async () => {
  const world = createWorld();
  const body = JSON.stringify({ installId: randomUUID(), modVersion: '0.2', turnsSinceLast: 0 });
  const timestamp = String(Math.floor(world.clock.now / 1000));
  const response = mockResponse();
  await world.handler(streamedRequest(body, {
    'x-convai-timestamp': timestamp, 'x-convai-signature': signBody(SIGNING_SECRET, timestamp, body), 'x-forwarded-for': '203.0.113.9',
  }), response);
  assert.equal(response.statusCode, 200);
});

test('fail closed: with the store unreachable nobody gets a token and nothing is minted', async () => {
  const world = createWorld();
  world.store.failing = true;
  const response = await world.send();
  assert.equal(response.statusCode, 503);
  assert.equal(response.json.error, 'unavailable');
  assert.ok(!('authToken' in response.json));
  assert.equal(world.convai.state.mints, 0);
  // Even with a valid token already cached in this instance.
  world.store.failing = false;
  assert.equal((await world.send()).statusCode, 200);
  world.store.failing = true;
  assert.equal((await world.send()).statusCode, 503);
});

test('per-install limit: a few tokens an hour, then 429 until the next hour', async () => {
  const world = createWorld({ CONVAI_AUTH_INSTALL_PER_HOUR: '3' });
  for (let call = 0; call < 3; call++) assert.equal((await world.send()).statusCode, 200);
  const refused = await world.send();
  assert.equal(refused.statusCode, 429);
  assert.equal(refused.json.error, 'rate');
  assert.equal(refused.json.limit, 'install', 'the answer names the limit that fired');
  assert.equal(refused.json.retryAfterSeconds, 3600 - 0, 'the hour started on the dot');
  assert.equal(refused.headers['Retry-After'], '3600');
  assert.equal((await world.send({ installId: randomUUID() })).statusCode, 200, 'another install is not affected');
  world.advance(HOUR);
  assert.equal((await world.send()).statusCode, 200);
});

test('per-IP limit: many installs behind one address share an hourly allowance', async () => {
  const world = createWorld({ CONVAI_AUTH_IP_PER_HOUR: '5' });
  for (let call = 0; call < 5; call++) assert.equal((await world.send({ installId: randomUUID() })).statusCode, 200);
  const refused = await world.send({ installId: randomUUID() });
  assert.deepEqual([refused.json.error, refused.json.limit], ['rate', 'address']);
  assert.equal((await world.send({ installId: randomUUID(), ip: '198.51.100.77' })).statusCode, 200, 'another address is fine');
});

test('the address comes from the platform header, not from anything the caller can choose, and a spoofed list is cut to its first entry', async () => {
  const world = createWorld({ CONVAI_AUTH_IP_PER_HOUR: '2' });
  await world.send({ installId: randomUUID(), ip: '203.0.113.50, 10.0.0.1' });
  await world.send({ installId: randomUUID(), ip: '203.0.113.50, 10.0.0.2' });
  assert.equal((await world.send({ installId: randomUUID(), ip: '203.0.113.50, 10.0.0.3' })).json.error, 'rate');
});

test('new install ids per address per day are capped, and a refused id is not remembered', async () => {
  const world = createWorld({ CONVAI_AUTH_NEW_INSTALLS_PER_IP_PER_DAY: '2' });
  const first = randomUUID(), second = randomUUID(), third = randomUUID();
  assert.equal((await world.send({ installId: first })).statusCode, 200);
  assert.equal((await world.send({ installId: second })).statusCode, 200);
  const refused = await world.send({ installId: third });
  assert.equal(refused.statusCode, 429);
  assert.equal(refused.json.error, 'install_limit');
  assert.equal((await world.send({ installId: first })).statusCode, 200, 'a known install keeps working');
  assert.equal((await world.send({ installId: third })).json.error, 'install_limit', 'still refused: it never registered');
  world.advance(24 * HOUR);
  assert.equal((await world.send({ installId: third })).statusCode, 200);
});

test('the global daily mint cap answers "busy" once spent (per-install mode mints for every install)', async () => {
  const world = createWorld({ CONVAI_AUTH_MODE: 'per-install', CONVAI_AUTH_MINTS_PER_DAY: '3' });
  for (let call = 0; call < 3; call++) assert.equal((await world.send({ installId: randomUUID() })).statusCode, 200);
  assert.equal(world.convai.state.mints, 3);
  const busy = await world.send({ installId: randomUUID() });
  assert.equal(busy.statusCode, 503);
  assert.equal(busy.json.error, 'busy');
  assert.equal(world.convai.state.mints, 3, 'no mint past the cap');
  world.advance(24 * HOUR);
  assert.equal((await world.send({ installId: randomUUID() })).statusCode, 200);
});

test('shared mode: a spent mint budget still hands out the token already minted, but cannot mint another', async () => {
  const world = createWorld({ CONVAI_AUTH_MINTS_PER_DAY: '1' });
  assert.equal((await world.send()).statusCode, 200);
  assert.equal((await world.send({ installId: randomUUID() })).statusCode, 200);
  world.advance(56 * MINUTE); // under the margin: needs a mint, the budget is spent
  const late = await world.send({ installId: randomUUID() });
  assert.equal(late.statusCode, 200, 'the old token still has four minutes');
  assert.equal(late.json.authToken, 'fake-token-1');
  assert.equal(world.convai.state.mints, 1);
  world.advance(5 * MINUTE); // expired
  assert.equal((await world.send({ installId: randomUUID() })).json.error, 'busy');
});

test('a Convai failure gives 502, or the still valid shared token when there is one', async () => {
  const world = createWorld();
  world.convai.state.failing = true;
  const none = await world.send();
  assert.equal(none.statusCode, 502);
  assert.equal(none.json.error, 'convai_unavailable');
  world.convai.state.failing = false;
  await world.send();
  world.convai.state.failing = true;
  world.advance(56 * MINUTE);
  const stale = await world.send();
  assert.equal(stale.statusCode, 200);
  assert.equal(stale.json.authToken, 'fake-token-1');
});

test('the minimum version cuts off old clients with a clean answer', async () => {
  const world = createWorld({ CONVAI_AUTH_MIN_VERSION: '0.2.1' });
  const old = await world.send({ version: '0.2' });
  assert.equal(old.statusCode, 426);
  assert.deepEqual(old.json, { error: 'outdated', minClient: '0.2.1' });
  assert.equal((await world.send({ version: '0.2.1' })).statusCode, 200);
  assert.equal((await world.send({ version: '0.10' })).statusCode, 200, 'compared as numbers, not text');
  assert.equal((await world.send({ version: '0.2.1-rc.1' })).statusCode, 200, 'a suffix is ignored');
  assert.equal((await world.send({ version: '0.1.9' })).statusCode, 426);
  assert.equal((await world.send({ version: '0.2.1' })).json.minClient, '0.2.1');
});

test('a blocked install is refused', async () => {
  const world = createWorld();
  await world.send({ turns: 1 });
  const { pseudonym } = await import('../api/_lib/crypto.js');
  const hash = pseudonym(SIGNING_SECRET, 'install', world.defaultInstall);
  const blocked = createWorld({ CONVAI_AUTH_BLOCKED_INSTALLS: `deadbeef, ${hash}` });
  blocked.defaultInstall = world.defaultInstall;
  const response = await blocked.send();
  assert.equal(response.statusCode, 403);
  assert.equal(response.json.error, 'refused');
  assert.equal(blocked.store.commands, 0);
});

test('turn reports add up per install per UTC day, and the day cap refuses new tokens until the next day', async () => {
  const world = createWorld({ CONVAI_AUTH_DAILY_TURN_CAP: '100' });
  const a = world.defaultInstall, b = randomUUID();
  assert.equal((await world.send({ installId: a, turns: 40 })).json.allowance.used, 40);
  assert.equal((await world.send({ installId: a, turns: 50 })).json.allowance.used, 90);
  assert.equal((await world.send({ installId: b, turns: 10 })).json.allowance.used, 10, 'another install is counted separately');
  const capped = await world.send({ installId: a, turns: 10 });
  assert.equal(capped.statusCode, 429);
  assert.equal(capped.json.error, 'daily');
  assert.deepEqual(capped.json.allowance, { used: 100, limit: 100, resetAt: '2026-10-15T00:00:00.000Z' });
  assert.ok(!('authToken' in capped.json));
  assert.equal((await world.send({ installId: a, turns: 0 })).json.error, 'daily', 'it stays refused with nothing new to report');
  assert.equal((await world.send({ installId: b, turns: 5 })).statusCode, 200);
  world.advance(14 * HOUR); // 00:00 UTC next day
  const next = await world.send({ installId: a, turns: 5 });
  assert.equal(next.statusCode, 200);
  assert.equal(next.json.allowance.used, 5);
});

test('shared mode never revokes a token on a daily refusal (it is everyone\'s token)', async () => {
  const world = createWorld({ CONVAI_AUTH_DAILY_TURN_CAP: '10' });
  await world.send({ turns: 0 });
  assert.equal((await world.send({ turns: 10 })).json.error, 'daily');
  assert.deepEqual(world.convai.state.revokes, []);
  assert.equal((await world.send({ installId: randomUUID() })).statusCode, 200);
});

test('per-install mode: each install has its own token, kept for its lifetime, and a repeat costs no mint', async () => {
  const world = createWorld({ CONVAI_AUTH_MODE: 'per-install' });
  const a = world.defaultInstall, b = randomUUID();
  const first = await world.send({ installId: a });
  assert.equal(world.store.commands, 2, 'the admission script and one save of the token');
  const other = await world.send({ installId: b });
  assert.notEqual(first.json.authToken, other.json.authToken);
  const before = world.store.commands, mints = world.convai.state.mints;
  const again = await world.send({ installId: a });
  assert.equal(again.json.authToken, first.json.authToken);
  assert.equal(again.json.expiresAt, first.json.expiresAt);
  assert.equal(world.store.commands - before, 1, 'a cache hit is one command');
  assert.equal(world.convai.state.mints, mints);
  world.advance(56 * MINUTE); // under the margin: this install gets a fresh token
  const renewed = await world.send({ installId: a });
  assert.notEqual(renewed.json.authToken, first.json.authToken);
  assert.equal(new Date(renewed.json.expiresAt).getTime(), world.clock.now + HOUR);
});

test('per-install mode: an install over the cap has its token revoked and removed, once', async () => {
  const world = createWorld({ CONVAI_AUTH_MODE: 'per-install', CONVAI_AUTH_DAILY_TURN_CAP: '20' });
  const a = world.defaultInstall;
  const issued = (await world.send({ installId: a, turns: 5 })).json.authToken;
  const over = await world.send({ installId: a, turns: 15 });
  assert.equal(over.statusCode, 429);
  assert.equal(over.json.error, 'daily');
  assert.deepEqual(world.convai.state.revokes, [issued]);
  const revokeCall = world.convai.state.calls.at(-1);
  assert.match(revokeCall.url, /revoke-token$/);
  assert.equal(JSON.parse(revokeCall.body).apiAuthToken, issued);
  await world.send({ installId: a, turns: 0 });
  assert.equal(world.convai.state.revokes.length, 1, 'nothing left to revoke the second time');
  world.advance(14 * HOUR);
  const fresh = await world.send({ installId: a, turns: 1 });
  assert.equal(fresh.statusCode, 200);
  assert.notEqual(fresh.json.authToken, issued);
});

test('a flooding client is stopped by the in-instance guard without touching the store', async () => {
  const world = createWorld();
  for (let call = 0; call < 60; call++) await world.send({ installId: randomUUID() });
  const before = world.store.commands;
  const flooded = await world.send({ installId: randomUUID() });
  assert.equal(flooded.statusCode, 429);
  assert.equal(world.store.commands, before);
});

test('the default limits are the documented ones', async () => {
  const { readConfig, DEFAULTS } = await import('../api/_lib/config.js');
  const config = readConfig({});
  assert.deepEqual(
    [config.installPerHour, config.ipPerHour, config.newInstallsPerIpPerDay, config.mintsPerDay, config.dailyTurnCap, config.remintMarginSeconds, config.mode],
    [12, 60, 5, 500, 500, 300, 'shared'],
  );
  assert.equal(DEFAULTS.dailyTurnCap, 500);
  assert.equal(readConfig({ CONVAI_AUTH_MODE: 'PER-INSTALL' }).mode, 'per-install');
  assert.equal(readConfig({ CONVAI_AUTH_MODE: 'weird' }).mode, 'shared');
  assert.equal(readConfig({ CONVAI_AUTH_DAILY_TURN_CAP: 'lots' }).dailyTurnCap, 500);
  assert.equal(readConfig({ KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 'y' }).storeUrl, 'https://x');
});
