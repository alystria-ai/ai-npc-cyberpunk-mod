// The Worker must behave like the Vercel service. These tests run both on the same inputs and compare the answers.
// The pure helpers are compared directly; the token endpoint and the error reports are driven through the same random scenario on both
// (the Vercel side needs `fengari`, the Lua VM its tests use, from the repository's node_modules: without it those tests are skipped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import * as workerCrypto from '../src/crypto.js';
import { addressBucket as workerBucket } from '../src/http.js';
import { storedPaidPlans as workerStored, validPaidPlans as workerValid } from '../src/plans.js';
import { compareVersions as workerCompare, parseVersion as workerParse } from '../src/version.js';
import * as workerWorld from '../testkit/world.mjs';

const vercel = {};
let vercelWorlds = null;
try {
  Object.assign(vercel, await import('../../auth-backend/api/_lib/version.js'), await import('../../auth-backend/api/_lib/http.js'),
    await import('../../auth-backend/api/_lib/crypto.js'), await import('../../auth-backend/api/_lib/plans.js'));
  vercelWorlds = { token: await import('../../auth-backend/testkit/harness.mjs'), errors: await import('../../auth-backend/testkit/errors-world.mjs') };
} catch (error) {
  if (!vercel.parseVersion) throw error; // the helpers have no dependencies: failing to load them is a real failure
}
const needsVercelWorld = vercelWorlds ? {} : { skip: 'fengari is not installed here (the Vercel tests need it too)' };

test('versions parse and compare the same', () => {
  const samples = ['0.2', '0.2.1', '0.2.10', '0.2-rc.1', '1.0.0.1', '0.2.9+build', 'x', '', null, 7, '0.', '1.2.3.4.5', '0.2-' + 'a'.repeat(40), '999999.999999'];
  for (const sample of samples) assert.deepEqual(workerParse(sample), vercel.parseVersion(sample), String(sample));
  for (const a of samples) for (const b of samples) assert.equal(workerCompare(a, b), vercel.compareVersions(a, b), `${a} vs ${b}`);
});

test('address buckets are the same', () => {
  const samples = ['203.0.113.7', '2001:db8:1:2:3:4:5:6', '2001:db8::1', '::1', '::ffff:198.51.100.9', '::ffff:c633:6409', '[2001:db8::2]', 'fe80::1%eth0',
    '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8:9', 'not an address', ':::', '', 'unknown', '2001:db8:0:0:0:0:0:0', '::'];
  for (const sample of samples) {
    for (const prefixGroups of [3, 4]) assert.equal(workerBucket(sample, { prefixGroups }), vercel.addressBucket(sample, { prefixGroups }), `${sample}/${prefixGroups}`);
  }
});

test('signatures and pseudonyms are the same values', async () => {
  const secret = workerWorld.SIGNING_SECRET;
  for (const [timestamp, body] of [['1760436000', '{}'], ['1760436000', 'zażółć 日本語 😀'], ['1760436001', '']]) {
    assert.equal(await workerCrypto.signBody(secret, timestamp, body), vercel.signBody(secret, timestamp, body));
  }
  for (const [kind, value] of [['install', randomUUID()], ['ip', '2001:db8:1:2::/64'], ['error-ip', '203.0.113.7'], ['error-install', 'é']]) {
    assert.equal(await workerCrypto.pseudonym(secret, kind, value), vercel.pseudonym(secret, kind, value));
  }
  // and the format the bridge uses: v1= + hex HMAC-SHA256 over "<timestamp>.<body>"
  assert.equal(await workerCrypto.signBody(secret, '1760436000', 'x'), 'v1=' + createHmac('sha256', secret).update('1760436000.x').digest('hex'));
  const now = 1760436000_000;
  for (const [timestamp, expected] of [['1760436000', 'ok'], ['1760436121', 'stale'], ['1760435879', 'stale'], ['12', 'bad'], [undefined, 'bad']]) {
    const signature = await workerCrypto.signBody(secret, timestamp ?? '1', 'b');
    assert.equal(await workerCrypto.checkSignature({ secret, timestamp, signature, body: 'b', nowMs: now }), expected);
    assert.equal(vercel.checkSignature({ secret, timestamp, signature, body: 'b', nowMs: now }), expected);
  }
});

test('paid plan validation accepts and refuses the same lists', () => {
  const good = { plans: [{ id: 'basic', name: 'Basic', period: 'monthly', price: '$5.00', priceId: 'price_ABCDEFGH12', interactions: 5000 },
    { id: 'pro', name: 'Pro 2', period: 'yearly', price: '€50', priceId: 'price_ZYXWVUTS99', concurrency: 3 }],
  paymentBase: 'https://convai.com/pay/', checkoutPath: '/checkout', detailsPaths: ['/a', '/b'], extra: 1 };
  const samples = [good, { plans: [] }, null, [], { plans: [good.plans[0], good.plans[0]] }, { ...good, paymentBase: 'http://convai.com' },
    { ...good, paymentBase: 'https://evil.example/x' }, { ...good, checkoutPath: 'nope' }, { ...good, detailsPaths: [] },
    { plans: [{ ...good.plans[0], price: 5 }] }, { plans: [{ ...good.plans[0], period: 'weekly' }] }, { plans: [{ ...good.plans[0], priceId: 'x' }] },
    { plans: Array.from({ length: 9 }, (_, index) => ({ ...good.plans[0], id: `p${index}`, priceId: `price_ABCDEFGH${index}0` })) }];
  for (const sample of samples) {
    assert.deepEqual(workerValid(sample), vercel.validPaidPlans(sample), JSON.stringify(sample)?.slice(0, 60));
    const text = JSON.stringify(sample);
    assert.deepEqual(workerStored(text), vercel.storedPaidPlans(text));
  }
  for (const raw of [undefined, '', 'nope', '{}']) assert.deepEqual(workerStored(raw), vercel.storedPaidPlans(raw));
});

// A small seeded generator, so a failing scenario can be replayed.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const scenarioEnv = {
  CONVAI_AUTH_PSEUDONYM_SECRET: workerWorld.PSEUDONYM_SECRET, ERROR_REPORT_SECRET: workerWorld.REPORT_SECRET,
  CONVAI_AUTH_IP_PER_HOUR: '9', CONVAI_AUTH_INSTALL_PER_HOUR: '5', CONVAI_AUTH_NEW_INSTALLS_PER_IP_PER_DAY: '4',
  CONVAI_AUTH_DAILY_TURN_CAP: '40', CONVAI_AUTH_MINTS_PER_DAY: '7',
};
const UUIDS = Array.from({ length: 7 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
const ADDRESSES = ['203.0.113.7', '203.0.113.8', '2001:db8:5:6:1::1', '2001:db8:5:6:2::9', '198.51.100.4'];

for (const mode of ['shared', 'per-install']) {
  test(`token endpoint, ${mode} mode: the same status and body for 400 random requests`, needsVercelWorld, async () => {
    const env = { ...scenarioEnv, CONVAI_AUTH_MODE: mode };
    for (const seed of [1, 2, 3]) {
      const worker = workerWorld.createWorld(env);
      const theirs = vercelWorlds.token.createWorld(env);
      const next = random(seed);
      for (let step = 0; step < 400 / 3; step++) {
        const fields = {
          installId: UUIDS[Math.floor(next() * UUIDS.length)], ip: ADDRESSES[Math.floor(next() * ADDRESSES.length)],
          turns: Math.floor(next() * 12), version: next() < 0.9 ? '0.2.9' : '0.2',
        };
        const minLife = next() < 0.3 ? 900 : undefined;
        const body = JSON.stringify({ installId: fields.installId, modVersion: fields.version, turnsSinceLast: fields.turns, ...(minLife ? { minLifeSeconds: minLife } : {}) });
        const gap = next() < 0.6 ? Math.floor(next() * 90_000) : Math.floor(next() * 2_400_000);
        worker.advance(gap);
        theirs.advance(gap);
        const mine = await worker.send({ ...fields, body });
        const other = await theirs.send({ ...fields, body });
        assert.equal(mine.status, other.statusCode, `seed ${seed} step ${step}`);
        assert.deepEqual(mine.json, other.json, `seed ${seed} step ${step}`);
        assert.equal(mine.headers['retry-after'], other.headers['Retry-After'], `seed ${seed} step ${step}`);
      }
      assert.equal(worker.convai.state.mints, theirs.convai.state.mints, `mints, seed ${seed}`);
      assert.deepEqual(worker.convai.state.revokes, theirs.convai.state.revokes, `revokes, seed ${seed}`);
    }
  });
}

test('error reports: the same answers and the same listing for 300 random reports', needsVercelWorld, async () => {
  // No separate report secret on either side, so the one signing secret signs the reports (the Vercel test world does that).
  const env = { ...scenarioEnv, ERROR_REPORT_SECRET: '', ERROR_REPORTS_IP_PER_HOUR: '6', ERROR_REPORTS_INSTALL_PER_DAY: '5',
    ERROR_REPORTS_STORE_PER_DAY: '9', ERROR_REPORTS_SAMPLES: '4' };
  const timeOf = json => (json && json.id ? { ...json, id: json.id.slice(0, 13) } : json);
  for (const seed of [11, 12, 13]) {
    const worker = workerWorld.createWorld(env);
    const theirs = vercelWorlds.errors.createErrorWorld(env);
    const next = random(seed);
    const pick = list => list[Math.floor(next() * list.length)];
    for (let step = 0; step < 100; step++) {
      const fields = {
        install: workerWorld.installHash(1 + Math.floor(next() * 5)), signature: workerWorld.signatureOf(1 + Math.floor(next() * 4)),
        kind: pick(['lua-error', 'bridge-crash']), message: pick(['one', 'two', 'one', 'three']), frame: pick(['a.lua:1', 'b.lua:2', undefined]),
        modVersion: pick(['0.2.8', '0.2.9', '0.2.10']),
      };
      const ip = pick(['203.0.113.7', '2001:db8:1:1::1', '2001:db8:1:2::1', '198.51.100.4']);
      const gap = next() < 0.7 ? Math.floor(next() * 120_000) : Math.floor(next() * 20_000_000);
      worker.advance(gap);
      theirs.advance(gap);
      const body = JSON.stringify(Object.fromEntries(Object.entries({ schema: 1, report: { n: step }, ...fields }).filter(([, value]) => value !== undefined)));
      const timestamp = String(Math.floor(worker.clock.now / 1000));
      const signature = await workerCrypto.signBody(workerWorld.SIGNING_SECRET, timestamp, body);
      const mine = await worker.report({}, { rawBody: body, ip, signature, timestamp });
      const other = await theirs.send({}, { body, ip, signature, timestamp });
      assert.equal(mine.status, other.statusCode, `seed ${seed} step ${step}`);
      assert.deepEqual(timeOf(mine.json), timeOf(other.json), `seed ${seed} step ${step}`);
    }
    const mine = (await worker.call('/api/admin/errors?limit=200', { headers: workerWorld.asAdmin })).json;
    const other = (await theirs.ask('/api/admin/errors?limit=200')).json;
    const shape = listing => ({ total: listing.total, signatures: listing.signatures.map(row => ({ ...row, ids: row.ids.map(id => id.slice(0, 13)) })) });
    assert.deepEqual(shape(mine), shape(other), `listing, seed ${seed}`);
  }
});
