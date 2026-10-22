// The three secrets of the deployment are separate: the one that signs token requests (shipped as the client request secret), the one that
// signs error reports (shipped separately) and the one that keys the hashes (never shipped). docs/CONVAI_AUTH_BACKEND.md, item 2 of the
// security review of 2026-10-22. Fake values only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { signBody, pseudonym } from '../api/_lib/crypto.js';
import { missingErrorReportSettings, readConfig } from '../api/_lib/config.js';
import { createErrorWorld, installHash } from '../testkit/errors-world.mjs';
import { createWorld, makeEnv, mockResponse, SIGNING_SECRET } from '../testkit/harness.mjs';

const REPORT_SECRET = 'report-secret-for-tests-'.padEnd(48, 'r');
const PSEUDONYM_SECRET = 'pseudonym-secret-for-tests-'.padEnd(48, 'p');
const separate = { ERROR_REPORT_SECRET: REPORT_SECRET, CONVAI_AUTH_PSEUDONYM_SECRET: PSEUDONYM_SECRET };

test('a token request signed with the report secret is refused, and the signing secret still works', async () => {
  const world = createWorld(separate);
  const body = JSON.stringify({ installId: world.defaultInstall, modVersion: '0.2', turnsSinceLast: 0 });
  const timestamp = String(Math.floor(world.clock.now / 1000));
  const withReportSecret = await world.send({ body, timestamp, signature: signBody(REPORT_SECRET, timestamp, body) });
  assert.equal(withReportSecret.statusCode, 401);
  assert.equal((await world.send()).statusCode, 200);
});

test('an error report signed with the token signing secret is refused, and the report secret works', async () => {
  const world = createErrorWorld(separate);
  const body = JSON.stringify(world.body());
  const timestamp = String(Math.floor(world.clock.now / 1000));
  assert.equal((await world.send({}, { body, timestamp, signature: signBody(SIGNING_SECRET, timestamp, body) })).statusCode, 401);
  assert.equal((await world.send({}, { body, timestamp, signature: signBody(REPORT_SECRET, timestamp, body) })).statusCode, 200);
});

test('install and address hashes are keyed by the pseudonym secret, not by either shipped secret', async () => {
  const world = createErrorWorld(separate);
  const body = JSON.stringify(world.body());
  const timestamp = String(Math.floor(world.clock.now / 1000));
  assert.equal((await world.send({}, { body, timestamp, signature: signBody(REPORT_SECRET, timestamp, body) })).statusCode, 200);
  const everything = world.contents();
  assert.ok(everything.includes(pseudonym(PSEUDONYM_SECRET, 'error-install', installHash(1))));
  assert.ok(!everything.includes(pseudonym(REPORT_SECRET, 'error-install', installHash(1))));
  assert.ok(!everything.includes(pseudonym(SIGNING_SECRET, 'error-install', installHash(1))));
  const tokens = createWorld(separate);
  assert.equal((await tokens.send()).statusCode, 200);
  const keys = [...tokens.store.data.keys()].join('\n');
  assert.ok(keys.includes(pseudonym(PSEUDONYM_SECRET, 'install', tokens.defaultInstall)));
  assert.ok(!keys.includes(pseudonym(SIGNING_SECRET, 'install', tokens.defaultInstall)));
});

test('with only the signing secret set, reports and pseudonyms use it (the first deployment layout)', () => {
  const config = readConfig({ CONVAI_AUTH_SIGNING_SECRET: SIGNING_SECRET });
  assert.equal(config.reportSecret, SIGNING_SECRET);
  assert.equal(config.pseudonymSecret, SIGNING_SECRET);
  assert.deepEqual(missingErrorReportSettings(readConfig({ ERROR_REPORT_SECRET: 'short', CONVAI_AUTH_SIGNING_SECRET: SIGNING_SECRET, KV_REST_API_URL: 'https://x.invalid', KV_REST_API_TOKEN: 't' })), ['ERROR_REPORT_SECRET']);
});

test('readyz says whether the three secrets are set and different, and shows no value', async () => {
  const { createReadyHandler } = await import('../api/_lib/admin.js');
  const ask = async extra => {
    const response = mockResponse();
    await createReadyHandler({ env: makeEnv(extra) })({ method: 'GET', url: '/api/readyz', headers: {} }, response);
    return response;
  };
  assert.equal((await ask(separate)).json.secretsSeparate, true);
  assert.equal((await ask({})).json.secretsSeparate, false, 'only the signing secret set: the fallback layout');
  assert.equal((await ask({ ...separate, ERROR_REPORT_SECRET: SIGNING_SECRET })).json.secretsSeparate, false, 'two equal secrets');
  const text = (await ask(separate)).text;
  for (const value of [REPORT_SECRET, PSEUDONYM_SECRET, SIGNING_SECRET]) assert.ok(!text.includes(value));
});
