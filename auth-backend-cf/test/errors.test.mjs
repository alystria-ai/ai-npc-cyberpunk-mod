import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pseudonym, signBody } from '../src/crypto.js';
import { packReport, unpackReport } from '../src/errors.js';
import { ADMIN_SECRET, PSEUDONYM_SECRET, REPORT_SECRET, SIGNING_SECRET, asAdmin, captureErrors, createWorld, installHash, signatureOf } from '../testkit/world.mjs';

const DAY = 86_400_000;
const list = (world, query = '') => world.call(`/api/admin/errors${query}`, { headers: asAdmin });

test('a report is stored: 200 with an id, the index and the body can be read back unpacked', async () => {
  const world = createWorld();
  const response = await world.report({ report: { detail: 'hello', nested: { a: [1, 2] } } });
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.stored, true);
  assert.match(response.json.id, /^\d{13}-[0-9a-f]{6}$/);
  assert.equal(response.headers['x-auth-backend'], 'cloudflare-worker');
  assert.ok(!response.text.includes('hello'));

  const listing = await list(world);
  assert.equal(listing.json.total, 1);
  const row = listing.json.signatures[0];
  assert.equal(row.signature, signatureOf(1));
  assert.equal(row.kind, 'bridge-crash');
  assert.equal(row.message, 'the bridge stopped');
  assert.equal(row.frame, 'bridge/x.mjs:10');
  assert.equal(row.reports, 1);
  assert.equal(row.stored, 1);
  assert.deepEqual(row.versions, { '0.2.9': 1 });
  assert.deepEqual(row.ids, [response.json.id]);
  assert.equal(row.firstSeen, new Date(world.clock.now).toISOString());

  const one = await list(world, `?signature=${signatureOf(1)}&id=${response.json.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.report.report.nested.a[1], 2);
  assert.equal(one.json.receivedAt, new Date(world.clock.now).toISOString());
  // the stored body carries the server's second hash of the install, not the client's value
  assert.equal(one.json.report.install, await pseudonym(PSEUDONYM_SECRET, 'error-install', installHash(1)));
  assert.notEqual(one.json.report.install, installHash(1));
});

test('packReport and unpackReport round-trip, including non-ASCII text, and unpack refuses a bomb', async () => {
  const text = JSON.stringify({ a: 'zażółć gęślą jaźń 日本語 😀', b: 'x'.repeat(50_000) });
  assert.equal(await unpackReport(await packReport(text)), text);
  await assert.rejects(unpackReport(await packReport('0'.repeat(2_000_000))));
  await assert.rejects(unpackReport(btoa('not gzip')));
});

test('the body is gzip + base64, readable by the Vercel admin format (gunzip of the stored text is the report JSON)', async () => {
  const { gunzipSync } = await import('node:zlib');
  const world = createWorld();
  const { json } = await world.report();
  const stored = world.errorsStorage.data.get(`er:r:${signatureOf(1)}:${json.id}`).v;
  assert.equal(JSON.parse(gunzipSync(Buffer.from(stored, 'base64')).toString('utf8')).signature, signatureOf(1));
});

test('signature: the report secret is needed, the signing secret does not do, stale and unsigned are refused', async () => {
  const world = createWorld();
  const body = JSON.stringify(world.reportBody());
  const timestamp = String(Math.floor(world.clock.now / 1000));
  assert.equal((await world.report({}, { signature: await signBody(SIGNING_SECRET, timestamp, body) })).status, 401);
  assert.equal((await world.report({}, { signature: 'v1=' + '0'.repeat(64) })).json.error, 'unauthorized');
  const stale = await world.report({}, { timestamp: String(Math.floor(world.clock.now / 1000) - 1000), signature: undefined });
  assert.equal(stale.status, 401);
  assert.equal(stale.json.error, 'stale');
  assert.equal((await list(world)).json.total, 0);
});

test('with no separate report secret set, the signing secret signs reports (the layout of the first deployment)', async () => {
  const world = createWorld({ ERROR_REPORT_SECRET: '' });
  const body = JSON.stringify(world.reportBody());
  const timestamp = String(Math.floor(world.clock.now / 1000));
  assert.equal((await world.report({}, { signature: await signBody(SIGNING_SECRET, timestamp, body) })).status, 200);
});

test('refusals: method, off switch, unconfigured, size, fields', async () => {
  const world = createWorld();
  assert.equal((await world.call('/api/errors/report')).status, 405);
  assert.equal((await createWorld({ ERROR_REPORTS_OFF: '1' }).report()).status, 404);
  assert.equal((await createWorld({ ERROR_REPORT_SECRET: 'short', CONVAI_AUTH_SIGNING_SECRET: 'short' }).report()).json.error, 'unconfigured');
  assert.equal((await createWorld({}, { appOptions: { errorsFor: () => null } }).report()).json.error, 'unconfigured');
  assert.equal((await world.report({ report: { big: 'x'.repeat(70_000) } })).status, 413);
  for (const bad of [{ schema: 2 }, { install: 'short' }, { signature: 'zz' }, { kind: 'Bad Kind' }, { message: '' }, { message: 'x'.repeat(401) },
    { modVersion: 'v1' }, { count: 0 }, { report: [] }, { frame: 'x'.repeat(241) }]) {
    assert.equal((await world.report(bad)).json.error, 'bad_request', JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await world.report({}, { rawBody: '[]' })).status, 400); // validly signed, but not a report
  assert.equal((await list(world)).json.total, 0);
  // the Convai key is not needed for reports
  assert.equal((await createWorld({ CONVAI_API_KEY: '' }).report()).status, 200);
});

test('the same signature from the same install is stored once a day and a duplicate counts nowhere', async () => {
  const world = createWorld({ ERROR_REPORTS_INSTALL_PER_DAY: '2' });
  assert.equal((await world.report()).json.stored, true);
  const duplicate = await world.report();
  assert.deepEqual(duplicate.json, { ok: true, stored: false, reason: 'duplicate' });
  // the duplicate did not use up the install's 2 reports a day
  assert.equal((await world.report({ signature: signatureOf(2) })).json.stored, true);
  const limited = await world.report({ signature: signatureOf(3) });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.retryAfterSeconds, 14 * 3600);
  assert.equal((await list(world)).json.signatures.find(row => row.signature === signatureOf(1)).reports, 1);
  world.advance(14 * 3600_000);
  assert.equal((await world.report()).json.stored, true); // a new UTC day
});

test('address limit per hour, an IPv6 caller as its /48', async () => {
  const world = createWorld({ ERROR_REPORTS_IP_PER_HOUR: '2' });
  assert.equal((await world.report({ install: installHash(1), signature: signatureOf(1) }, { ip: '2001:db8:1:1::1' })).status, 200);
  assert.equal((await world.report({ install: installHash(2), signature: signatureOf(2) }, { ip: '2001:db8:1:2::1' })).status, 200);
  const limited = await world.report({ install: installHash(3), signature: signatureOf(3) }, { ip: '2001:db8:1:ffff::1' });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.retryAfterSeconds, 3600);
  assert.equal((await world.report({ install: installHash(3), signature: signatureOf(3) }, { ip: '2001:db8:2::1' })).status, 200);
});

test('the day\'s body budget: later reports are counted in the index but their body is not kept', async () => {
  const world = createWorld({ ERROR_REPORTS_STORE_PER_DAY: '2' });
  const answers = [];
  for (let index = 1; index <= 3; index++) answers.push((await world.report({ install: installHash(index) })).json);
  assert.deepEqual(answers.map(answer => answer.stored), [true, true, false]);
  assert.equal(answers[2].reason, 'counted');
  const row = (await list(world)).json.signatures[0];
  assert.equal(row.reports, 3);
  assert.equal(row.stored, 2);
  assert.equal(row.ids.length, 2);
  const none = createWorld({ ERROR_REPORTS_STORE_PER_DAY: '0' });
  assert.equal((await none.report()).json.reason, 'counted');
  assert.deepEqual((await list(none)).json.signatures[0].ids, []);
});

test('what a signature is follows the majority of its reports, not the first one', async () => {
  const world = createWorld();
  await world.report({ install: installHash(1), message: 'forged first' });
  assert.equal((await list(world)).json.signatures[0].message, 'forged first');
  await world.report({ install: installHash(2), message: 'real text' }); // votes 1 -> 0: replaced
  await world.report({ install: installHash(3), message: 'real text' });
  await world.report({ install: installHash(4), message: 'another' }); // votes 2 -> 1
  assert.equal((await list(world)).json.signatures[0].message, 'real text');
  assert.equal((await list(world)).json.signatures[0].reports, 4);
});

test('versions are counted per version, and the listing is newest version first', async () => {
  const world = createWorld();
  for (const [index, version] of ['0.2.8', '0.2.10', '0.2.9', '0.2.9'].entries()) await world.report({ install: installHash(index + 1), modVersion: version });
  assert.deepEqual(Object.entries((await list(world)).json.signatures[0].versions), [['0.2.10', 1], ['0.2.9', 2], ['0.2.8', 1]]);
});

test('samples per signature: the newest are kept, the earliest few are pinned and never pushed out', async () => {
  const world = createWorld({ ERROR_REPORTS_SAMPLES: '4', ERROR_REPORTS_STORE_PER_DAY: '100' }); // pinned = min(3, 2) = 2
  const ids = [];
  for (let index = 1; index <= 7; index++) {
    ids.push((await world.report({ install: installHash(index) })).json.id);
    world.advance(1000);
  }
  const kept = (await list(world)).json.signatures[0].ids;
  assert.equal(kept.length, 4);
  // newest first: the two newest, then the two earliest ever
  assert.deepEqual(kept, [ids[6], ids[5], ids[1], ids[0]].map(String));
  for (const gone of ids.slice(2, 5)) assert.equal((await list(world, `?signature=${signatureOf(1)}&id=${gone}`)).status, 404);
  assert.equal([...world.errorsStorage.data.keys()].filter(key => key.startsWith('er:r:')).length, 4);
});

test('reports older than the keep time are forgotten when a body is next kept, and the list shows only recent signatures', async () => {
  const world = createWorld({ ERROR_REPORTS_TTL_DAYS: '2', ERROR_REPORTS_INSTALL_PER_DAY: '100' });
  const old = (await world.report({ signature: signatureOf(1) })).json.id;
  world.advance(3 * DAY);
  assert.equal((await list(world)).json.total, 0);
  await world.report({ signature: signatureOf(2), install: installHash(2) });
  const rows = (await list(world)).json.signatures;
  assert.deepEqual(rows.map(row => row.signature), [signatureOf(2)]);
  assert.equal([...world.errorsStorage.data.keys()].some(key => key.includes(signatureOf(1))), false); // index and body swept with the signature
  assert.equal((await list(world, `?signature=${signatureOf(1)}&id=${old}`)).status, 404);
});

test('at most MAX signatures are listed: the least recently seen go first', async () => {
  const world = createWorld({ ERROR_REPORTS_INSTALL_PER_DAY: '100' }, { appOptions: { maxSignatures: 3 } });
  for (let index = 1; index <= 5; index++) {
    await world.report({ signature: signatureOf(index), install: installHash(index) });
    world.advance(1000);
  }
  const listing = (await list(world)).json;
  assert.equal(listing.total, 3);
  assert.deepEqual(listing.signatures.map(row => row.signature), [signatureOf(5), signatureOf(4), signatureOf(3)]);
  assert.equal([...world.errorsStorage.data.keys()].some(key => key.startsWith(`er:i:${signatureOf(1)}`) || key.startsWith(`er:r:${signatureOf(2)}`)), false);
});

test('the listing is newest first and cut at the limit', async () => {
  const world = createWorld({ ERROR_REPORTS_INSTALL_PER_DAY: '100' });
  for (let index = 1; index <= 4; index++) {
    await world.report({ signature: signatureOf(index), install: installHash(index) });
    world.advance(1000);
  }
  const two = (await list(world, '?limit=2')).json;
  assert.equal(two.total, 4);
  assert.deepEqual(two.signatures.map(row => row.signature), [signatureOf(4), signatureOf(3)]);
});

test('admin: secret rules, bad parameters, deleting a body and a whole signature', async () => {
  const world = createWorld();
  const first = (await world.report()).json.id;
  world.advance(1000);
  const second = (await world.report({ install: installHash(2) })).json.id;
  assert.equal((await world.call('/api/admin/errors')).status, 401);
  assert.equal((await createWorld({ CONVAI_AUTH_ADMIN_SECRET: 'short' }).call('/api/admin/errors', { headers: asAdmin })).status, 404);
  assert.equal((await world.call('/api/admin/errors', { method: 'POST', headers: asAdmin })).status, 405);
  for (const query of ['?signature=zz&id=x', `?signature=${signatureOf(1)}`, `?id=${first}`, `?signature=${signatureOf(1)}&id=bad`]) {
    assert.equal((await list(world, query)).status, 400, query);
  }
  const del = path => world.call(`/api/admin/errors${path}`, { method: 'DELETE', headers: asAdmin });
  assert.equal((await del('')).status, 400);
  assert.deepEqual((await del(`?signature=${signatureOf(1)}&id=${first}`)).json, { deleted: 1 });
  assert.deepEqual((await del(`?signature=${signatureOf(1)}&id=${first}`)).json, { deleted: 0 });
  assert.deepEqual((await list(world)).json.signatures[0].ids, [second]);
  assert.deepEqual((await del(`?signature=${signatureOf(1)}`)).json, { deleted: true });
  assert.deepEqual((await del(`?signature=${signatureOf(1)}`)).json, { deleted: false });
  assert.equal((await list(world)).json.total, 0);
  assert.equal([...world.errorsStorage.data.keys()].some(key => key.startsWith('er:r:') || key.startsWith('er:i:')), false);
});

test('a report never echoes its body and the secrets never reach a log', async () => {
  const world = createWorld({}, { appOptions: { errorsFor: () => ({ report: async () => { throw new Error('boom'); } }) } });
  let response;
  const logged = await captureErrors(async () => { response = await world.report({ message: 'private words' }); });
  assert.equal(response.status, 503);
  assert.equal(response.headers['retry-after'], '30');
  for (const secret of [REPORT_SECRET, SIGNING_SECRET, ADMIN_SECRET, PSEUDONYM_SECRET, 'private words']) assert.ok(!logged.includes(secret) && !response.text.includes(secret));
});

test('expired counters of the report store are swept', async () => {
  const world = createWorld();
  await world.report();
  const counters = () => [...world.errorsStorage.data.keys()].filter(key => /^er:(ip|in|day):/.test(key));
  assert.equal(counters().length, 3);
  world.advance(3 * DAY);
  await world.report({ install: installHash(2), signature: signatureOf(2) });
  assert.equal(counters().length, 3); // only the new day's, hour's and install's
});
