import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { DEFAULTS, ENV_NAMES, readConfig } from '../api/_lib/config.js';
import { pseudonym, signBody } from '../api/_lib/crypto.js';
import { addressBucket } from '../api/_lib/http.js';
import { createErrorReportHandler } from '../api/_lib/errors.js';
import { DEFAULT_ADDRESS, createErrorWorld, installHash, signatureOf } from '../testkit/errors-world.mjs';
import { ADMIN_SECRET, SIGNING_SECRET, START, captureErrors, makeEnv, mockResponse, streamedRequest } from '../testkit/harness.mjs';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
// Wide limits unless a test narrows one, so each test exercises one protection.
const WIDE = { ERROR_REPORTS_INSTALL_PER_DAY: '100000', ERROR_REPORTS_IP_PER_HOUR: '100000', ERROR_REPORTS_STORE_PER_DAY: '100000' };
const ID = /^\d{13}-[0-9a-f]{6}$/;

/** The kept body of a report id, unpacked straight from the store (not through the admin call). */
const unpack = (world, signature, id) => JSON.parse(gunzipSync(Buffer.from(world.store.exec(['HGET', `er:r:${signature}`, id]), 'base64')).toString('utf8'));
const listing = async world => (await world.ask('/api/admin/errors')).json;

test('a signed report is stored in one store command, answered without echoing it, and read back through the admin call', async () => {
  const world = createErrorWorld();
  const sent = world.body({ extraField: { anything: [1, 2, 3] } });
  const response = await world.send({ extraField: sent.extraField });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.json).sort(), ['id', 'ok', 'stored']);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.stored, true);
  assert.match(response.json.id, ID);
  assert.equal(response.json.id.slice(0, 13), String(START));
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.ok(!response.text.includes(sent.message) && !response.text.includes(sent.install), 'the body is never echoed');
  assert.equal(world.store.commands, 1, 'the whole decision is one script');
  assert.equal(world.store.scripts, 1);

  const list = await listing(world);
  assert.equal(list.total, 1);
  const [entry] = list.signatures;
  assert.equal(entry.signature, sent.signature);
  assert.equal(entry.kind, 'lua-error');
  assert.equal(entry.message, sent.message);
  assert.equal(entry.frame, sent.frame);
  assert.equal(entry.reports, 1);
  assert.equal(entry.stored, 1);
  assert.equal(entry.firstSeen, new Date(START).toISOString());
  assert.equal(entry.lastSeen, new Date(START).toISOString());
  assert.deepEqual(entry.versions, { '0.2.2': 1 });
  assert.deepEqual(entry.ids, [response.json.id]);

  const one = await world.ask(`/api/admin/errors?signature=${sent.signature}&id=${response.json.id}`);
  assert.equal(one.statusCode, 200);
  assert.equal(one.json.signature, sent.signature);
  assert.equal(one.json.id, response.json.id);
  assert.equal(one.json.receivedAt, new Date(START).toISOString());
  // The kept body is the one that was sent, with the client's install hash swapped for the server's second hash.
  assert.deepEqual(one.json.report, { ...sent, install: pseudonym(SIGNING_SECRET, 'error-install', sent.install) });
});

test('a bad or stale signature is refused before the body is looked at, and costs no store command', async () => {
  const world = createErrorWorld();
  const wrong = await world.send({}, { signature: `v1=${'0'.repeat(64)}` });
  assert.equal(wrong.statusCode, 401);
  assert.deepEqual(wrong.json, { error: 'unauthorized' });
  const noPrefix = await world.send({}, { signature: 'a'.repeat(64) });
  assert.equal(noPrefix.statusCode, 401);
  const missing = await world.send({}, { headers: { 'x-convai-signature': '', 'x-convai-timestamp': '' } });
  assert.equal(missing.statusCode, 401);

  const sentBody = JSON.stringify(world.body());
  const timestamp = String(Math.floor(START / 1000));
  const edited = await world.send({}, { body: sentBody.replace('lua-error', 'lua-errox'), signature: signBody(SIGNING_SECRET, timestamp, sentBody) });
  assert.equal(edited.statusCode, 401, 'a body edited after signing is refused');
  const wrongKey = await world.send({}, { signature: signBody(ADMIN_SECRET, timestamp, sentBody), body: sentBody });
  assert.equal(wrongKey.statusCode, 401, 'only the signing secret signs');

  const old = String(Math.floor(START / 1000) - 3 * 60);
  const stale = await world.send({}, { timestamp: old, signature: signBody(SIGNING_SECRET, old, sentBody), body: sentBody });
  assert.equal(stale.statusCode, 401);
  assert.deepEqual(stale.json, { error: 'stale', serverTime: Math.floor(START / 1000) });
  // A signature failure is reported before a field problem is.
  const both = await world.send({}, { body: '{"schema":2}', signature: `v1=${'0'.repeat(64)}` });
  assert.equal(both.statusCode, 401);
  assert.equal(world.store.commands, 0);
});

test('every malformed body is a 400, and none of them costs a store command', async () => {
  const world = createErrorWorld(WIDE);
  const raw = {
    'not JSON': '{"schema":1',
    'empty body': '',
    'an array': '[]',
    'null': 'null',
    'a string': '"report"',
    'a number': '5',
  };
  for (const [name, body] of Object.entries(raw)) {
    const response = await world.send({}, { body });
    assert.equal(response.statusCode, 400, name);
    assert.deepEqual(response.json, { error: 'bad_request' }, name);
  }
  const fields = {
    'schema 2': { schema: 2 },
    'schema as text': { schema: '1' },
    'schema missing': { schema: undefined },
    'install not hex': { install: 'z'.repeat(32) },
    'install upper case': { install: installHash(255).toUpperCase() },
    'install too short': { install: installHash(1).slice(1) },
    'install too long': { install: `${installHash(1)}0` },
    'install a number': { install: 5 },
    'install missing': { install: undefined },
    'signature too short': { signature: signatureOf(1).slice(1) },
    'signature upper case': { signature: signatureOf(255).toUpperCase() },
    'signature missing': { signature: undefined },
    'kind upper case': { kind: 'Lua-Error' },
    'kind one character': { kind: 'a' },
    'kind 41 characters': { kind: 'a'.repeat(41) },
    'kind starting with a digit': { kind: '1ab' },
    'kind with an underscore': { kind: 'lua_error' },
    'kind missing': { kind: undefined },
    'message empty': { message: '' },
    'message 401 characters': { message: 'm'.repeat(401) },
    'message a number': { message: 5 },
    'message missing': { message: undefined },
    'frame 241 characters': { frame: 'f'.repeat(241) },
    'frame a number': { frame: 5 },
    'version not a version': { modVersion: 'v1' },
    'version missing': { modVersion: undefined },
    'version a number': { modVersion: 0.2 },
    'count zero': { count: 0 },
    'count a fraction': { count: 1.5 },
    'count 100001': { count: 100_001 },
    'count as text': { count: '3' },
    'report an array': { report: [] },
    'report text': { report: 'x' },
    'report null': { report: null },
  };
  for (const [name, change] of Object.entries(fields)) {
    const response = await world.send(change);
    assert.equal(response.statusCode, 400, name);
    assert.deepEqual(response.json, { error: 'bad_request' }, name);
  }
  assert.equal(world.store.commands, 0);
});

test('the edges of the allowed ranges are accepted, and unknown top-level fields are kept with the body', async () => {
  const world = createErrorWorld(WIDE);
  const edges = [
    { kind: 'ab', message: 'm', frame: undefined, count: undefined, report: undefined },
    { kind: 'a'.repeat(40), message: 'm'.repeat(400), frame: 'f'.repeat(240), count: 100_000, modVersion: '0.2.2-rc.1' },
    { kind: 'a1-b2', count: 1, report: {} },
  ];
  for (const [index, change] of edges.entries()) {
    const response = await world.send({ ...change, signature: signatureOf(index + 1), install: installHash(index + 1), extra: `field-${index}` });
    assert.equal(response.statusCode, 200, JSON.stringify(change).slice(0, 80));
    assert.equal(response.json.stored, true);
    const kept = unpack(world, signatureOf(index + 1), response.json.id);
    assert.equal(kept.extra, `field-${index}`);
  }
});

test('a body of exactly 65536 bytes is taken and one byte more is 413, signed or not', async () => {
  const world = createErrorWorld();
  const bytes = fields => Buffer.byteLength(JSON.stringify(world.body(fields)));
  const padTo = size => ({ pad: 'p'.repeat(size - bytes({ pad: '' })) });
  assert.equal(bytes(padTo(65_536)), 65_536);
  const exact = await world.send(padTo(65_536));
  assert.equal(exact.statusCode, 200);
  assert.equal(exact.json.stored, true);
  assert.equal(unpack(world, signatureOf(1), exact.json.id).pad.length, padTo(65_536).pad.length);

  const commands = world.store.commands;
  const over = await world.send(padTo(65_537));
  assert.equal(over.statusCode, 413);
  assert.deepEqual(over.json, { error: 'too_large' });
  const unsigned = await world.send({}, { body: JSON.stringify(world.body(padTo(70_000))), signature: `v1=${'0'.repeat(64)}` });
  assert.equal(unsigned.statusCode, 413);
  assert.equal(world.store.commands, commands);
});

test('a streamed body is read as the platform delivers it, and a stream that fails is a 400, not a crash', async () => {
  const world = createErrorWorld();
  const body = JSON.stringify(world.body());
  const timestamp = String(Math.floor(START / 1000));
  const headers = { 'x-convai-timestamp': timestamp, 'x-convai-signature': signBody(SIGNING_SECRET, timestamp, body), 'x-vercel-forwarded-for': DEFAULT_ADDRESS };
  const streamed = mockResponse();
  await world.handler(streamedRequest(body, headers), streamed);
  assert.equal(streamed.statusCode, 200);
  assert.equal(streamed.json.stored, true);

  const broken = Readable.from((async function* () { yield Buffer.from('{"schema"'); throw new Error('connection reset'); })());
  broken.method = 'POST';
  broken.headers = headers;
  const failed = mockResponse();
  await world.handler(broken, failed);
  assert.equal(failed.statusCode, 400);
  assert.deepEqual(failed.json, { error: 'bad_request' });
});

test('only POST is answered; anything else is 405 with Allow', async () => {
  const world = createErrorWorld();
  for (const method of ['GET', 'PUT', 'DELETE', 'HEAD']) {
    const response = await world.send({}, { method });
    assert.equal(response.statusCode, 405, method);
    assert.equal(response.headers.Allow, 'POST');
  }
  assert.equal(world.store.commands, 0);
});

test('a signature is taken once per install per UTC day (a duplicate counts nowhere), and again the next day', async () => {
  const world = createErrorWorld(WIDE);
  const first = await world.send();
  assert.equal(first.json.stored, true);
  const again = await world.send();
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json, { ok: true, stored: false, reason: 'duplicate' });
  assert.equal((await listing(world)).signatures[0].reports, 1, 'the duplicate was not counted');
  assert.equal(world.store.data.get(`er:in:${pseudonym(SIGNING_SECRET, 'error-install', installHash(1))}:2026-10-14`).value.get('n'), '1', 'nor against the install\'s daily limit');

  // Another install with the same signature is a different report; another signature from the same install too.
  assert.equal((await world.send({ install: installHash(2) })).json.stored, true);
  assert.equal((await world.send({ signature: signatureOf(2) })).json.stored, true);
  assert.equal((await listing(world)).signatures.find(row => row.signature === signatureOf(1)).reports, 2);

  world.advance(14 * HOUR + MINUTE); // past UTC midnight
  const nextDay = await world.send();
  assert.equal(nextDay.json.stored, true, 'the same install may report the same signature on the next UTC day');
  assert.equal((await world.send()).json.reason, 'duplicate');
});

test('an install may send only so many different reports a UTC day', async () => {
  const world = createErrorWorld({ ...WIDE, ERROR_REPORTS_INSTALL_PER_DAY: '3' });
  for (const number of [1, 2, 3]) assert.equal((await world.send({ signature: signatureOf(number) })).json.stored, true);
  const refused = await world.send({ signature: signatureOf(4) });
  assert.equal(refused.statusCode, 429);
  assert.deepEqual(refused.json, { error: 'rate', retryAfterSeconds: 14 * 3600 });
  assert.equal(refused.headers['Retry-After'], String(14 * 3600));
  assert.equal((await listing(world)).total, 3, 'the refused report left no trace in the index');
  assert.equal((await world.send({ signature: signatureOf(1) })).json.reason, 'duplicate', 'a duplicate is still answered as one');
  assert.equal((await world.send({ signature: signatureOf(4), install: installHash(2) })).json.stored, true, 'another install is unaffected');
  world.advance(14 * HOUR + MINUTE);
  assert.equal((await world.send({ signature: signatureOf(4) })).json.stored, true, 'a new day starts again');
});

test('an address may send only so many reports an hour, whatever the installs', async () => {
  const world = createErrorWorld({ ...WIDE, ERROR_REPORTS_IP_PER_HOUR: '2' });
  assert.equal((await world.send({ install: installHash(1), signature: signatureOf(1) })).json.stored, true);
  assert.equal((await world.send({ install: installHash(2), signature: signatureOf(2) })).json.stored, true);
  const refused = await world.send({ install: installHash(3), signature: signatureOf(3) });
  assert.equal(refused.statusCode, 429);
  assert.deepEqual(refused.json, { error: 'rate', retryAfterSeconds: 3600 });
  assert.equal(refused.headers['Retry-After'], '3600');
  assert.equal((await world.send({ install: installHash(4), signature: signatureOf(4) }, { ip: '198.51.100.9' })).json.stored, true, 'another address is unaffected');
  world.advance(HOUR);
  assert.equal((await world.send({ install: installHash(3), signature: signatureOf(3) })).json.stored, true, 'the next hour starts again');
});

test('the per-instance flood guard answers the 61st request in a minute without spending a store command', async () => {
  const world = createErrorWorld(WIDE);
  for (let number = 1; number <= 60; number++) {
    assert.equal((await world.send({ signature: signatureOf(number), install: installHash(number) })).statusCode, 200);
  }
  const commands = world.store.commands;
  const flooded = await world.send({ signature: signatureOf(61), install: installHash(61) });
  assert.equal(flooded.statusCode, 429);
  assert.deepEqual(flooded.json, { error: 'rate', retryAfterSeconds: 60 });
  assert.equal(flooded.headers['Retry-After'], '60');
  assert.equal(world.store.commands, commands, 'no Redis command for a flooded request');
  assert.equal((await world.send({ signature: signatureOf(62) }, { ip: '198.51.100.9' })).statusCode, 200, 'another address is unaffected');
  world.advance(61_000);
  assert.equal((await world.send({ signature: signatureOf(63), install: installHash(63) })).statusCode, 200);
  // A request refused for a field problem is not counted against the guard.
  for (let number = 0; number < 80; number++) await world.send({ kind: 'BAD' }, { ip: '198.51.100.20' });
  assert.equal((await world.send({}, { ip: '198.51.100.20' })).statusCode, 200);
});

test('when the day\'s budget of bodies is spent the report is still counted in the index, but no body is kept', async () => {
  const world = createErrorWorld({ ...WIDE, ERROR_REPORTS_STORE_PER_DAY: '2' });
  assert.equal((await world.send({ install: installHash(1) })).json.stored, true);
  assert.equal((await world.send({ install: installHash(2) })).json.stored, true);
  const spent = await world.send({ install: installHash(3) });
  assert.equal(spent.statusCode, 200);
  assert.deepEqual(spent.json, { ok: true, stored: false, reason: 'counted' });
  const fresh = await world.send({ install: installHash(4), signature: signatureOf(2), message: 'a second problem' });
  assert.deepEqual(fresh.json, { ok: true, stored: false, reason: 'counted' });

  const list = await listing(world);
  assert.equal(list.total, 2);
  const [newest, older] = list.signatures; // both seen in the same millisecond: ties list the higher signature first
  const first = [newest, older].find(row => row.signature === signatureOf(1));
  const second = [newest, older].find(row => row.signature === signatureOf(2));
  assert.equal(first.reports, 3, 'all three reports were counted');
  assert.equal(first.stored, 2);
  assert.equal(first.ids.length, 2, 'only two bodies exist');
  assert.equal(second.reports, 1);
  assert.equal(second.stored, 0);
  assert.deepEqual(second.ids, []);
  assert.equal(second.message, 'a second problem');
  assert.equal(world.store.data.has(`er:r:${signatureOf(2)}`), false, 'no body hash for a signature that never had one kept');

  world.advance(14 * HOUR + MINUTE);
  assert.equal((await world.send({ install: installHash(5) })).json.stored, true, 'the budget is per UTC day');
});

test('a store budget of 0 keeps nothing and still counts', async () => {
  const world = createErrorWorld({ ...WIDE, ERROR_REPORTS_STORE_PER_DAY: '0' });
  assert.equal((await world.send()).json.reason, 'counted');
  const [entry] = (await listing(world)).signatures;
  assert.equal(entry.reports, 1);
  assert.equal(entry.stored, 0);
});

test('a signature keeps only the newest few bodies; older ones are evicted', async () => {
  const world = createErrorWorld({ ...WIDE, ERROR_REPORTS_SAMPLES: '3' });
  const ids = [];
  for (let number = 1; number <= 5; number++) {
    ids.push((await world.send({ install: installHash(number) })).json.id);
    world.advance(1000);
  }
  const [entry] = (await listing(world)).signatures;
  assert.equal(entry.reports, 5);
  assert.equal(entry.stored, 5, 'five bodies were kept at the time');
  assert.deepEqual(entry.ids, [ids[4], ids[3], ids[2]], 'the newest three, newest first');
  for (const gone of [ids[0], ids[1]]) {
    assert.equal((await world.ask(`/api/admin/errors?signature=${signatureOf(1)}&id=${gone}`)).statusCode, 404);
  }
  assert.equal((await world.ask(`/api/admin/errors?signature=${signatureOf(1)}&id=${ids[2]}`)).statusCode, 200);
  assert.equal(world.store.data.get(`er:r:${signatureOf(1)}`).value.size, 3);
});

test('every key expires: after the lifetime (30 days) the index is empty', async () => {
  const world = createErrorWorld(WIDE);
  await world.send();
  await world.send({ signature: signatureOf(2), install: installHash(2) });
  world.advance(30 * DAY - MINUTE);
  assert.equal((await listing(world)).total, 2, 'still there just before');
  world.advance(2 * MINUTE);
  const after = await listing(world);
  assert.deepEqual(after, { total: 0, signatures: [] });
  for (const key of [...world.store.data.keys()]) world.store.exec(['EXISTS', key]); // reading drops what has expired
  assert.equal(world.store.data.size, 0);
});

test('the lifetime of each key, and the setting that changes it', async () => {
  const world = createErrorWorld({ ...WIDE, ERROR_REPORTS_TTL_DAYS: '7' });
  await world.send();
  const ttl = key => world.store.exec(['TTL', key]);
  const sig = signatureOf(1), install = pseudonym(SIGNING_SECRET, 'error-install', installHash(1)), address = pseudonym(SIGNING_SECRET, 'error-ip', DEFAULT_ADDRESS);
  assert.equal(ttl(`er:ip:${address}:${Math.floor(START / HOUR)}`), 7200);
  assert.equal(ttl(`er:in:${install}:2026-10-14`), 172_800);
  assert.equal(ttl('er:day:2026-10-14'), 172_800);
  for (const key of [`er:i:${sig}`, `er:r:${sig}`, `er:o:${sig}`, 'er:sigs']) assert.equal(ttl(key), 7 * 86_400, key);

  assert.equal(readConfig({ ERROR_REPORTS_TTL_DAYS: '0' }).errorTtlDays, 1);
  assert.equal(readConfig({ ERROR_REPORTS_TTL_DAYS: '500' }).errorTtlDays, 90);
  assert.equal(readConfig({ ERROR_REPORTS_TTL_DAYS: 'soon' }).errorTtlDays, 30);
});

test('bodies and signatures older than the lifetime are dropped as new ones arrive', async () => {
  const world = createErrorWorld(WIDE);
  const old = await world.send({ install: installHash(1) });
  world.advance(29 * DAY);
  const middle = await world.send({ install: installHash(2) });
  const otherAtMiddle = await world.send({ install: installHash(2), signature: signatureOf(2), message: 'seen once, 29 days in' });
  assert.deepEqual((await listing(world)).signatures.find(row => row.signature === signatureOf(1)).ids, [middle.json.id, old.json.id]);
  world.advance(2 * DAY); // 31 days after the first report; the keys were refreshed 2 days ago so they are all alive
  const fresh = await world.send({ install: installHash(3) });
  const [entry] = (await listing(world)).signatures.filter(row => row.signature === signatureOf(1));
  assert.deepEqual(entry.ids, [fresh.json.id, middle.json.id], 'the first body is older than 30 days and was dropped on insert');
  assert.equal((await world.ask(`/api/admin/errors?signature=${signatureOf(1)}&id=${old.json.id}`)).statusCode, 404);
  assert.equal(world.store.data.get(`er:r:${signatureOf(1)}`).value.size, 2);
  assert.equal(otherAtMiddle.json.stored, true);

  // A signature last seen long ago leaves the list when another report arrives, and one inside the lifetime stays.
  const world2 = createErrorWorld({ ...WIDE, ERROR_REPORTS_TTL_DAYS: '10' });
  await world2.send({ signature: signatureOf(1) });
  world2.advance(9 * DAY);
  await world2.send({ signature: signatureOf(2), install: installHash(2) });
  world2.advance(2 * DAY);
  await world2.send({ signature: signatureOf(3), install: installHash(3) });
  const kept = (await listing(world2)).signatures.map(row => row.signature);
  assert.deepEqual(kept, [signatureOf(3), signatureOf(2)]);
  assert.equal(world2.store.exec(['ZCARD', 'er:sigs']), 2);
});

test('the list of signatures is capped, dropping the least recently seen', async () => {
  const world = createErrorWorld(WIDE, { handlerOptions: { maxSignatures: 3 } });
  for (let number = 1; number <= 5; number++) {
    await world.send({ signature: signatureOf(number), install: installHash(number) });
    world.advance(1000);
  }
  const list = await listing(world);
  assert.equal(list.total, 3);
  assert.deepEqual(list.signatures.map(row => row.signature), [signatureOf(5), signatureOf(4), signatureOf(3)]);
});

test('versions are counted per version, newest version first, and the index hash cannot grow without bound', async () => {
  const world = createErrorWorld(WIDE);
  const versions = ['0.2.1', '0.2.2', '0.2.2', '0.10', '0.2.2'];
  for (const [index, modVersion] of versions.entries()) await world.send({ modVersion, install: installHash(index + 1) });
  const [entry] = (await listing(world)).signatures;
  assert.deepEqual(entry.versions, { '0.10': 1, '0.2.2': 3, '0.2.1': 1 });
  assert.deepEqual(Object.keys(entry.versions), ['0.10', '0.2.2', '0.2.1'], 'compared as numbers: 0.10 is above 0.9');

  const wide = createErrorWorld(WIDE);
  for (let number = 1; number <= 80; number++) {
    await wide.send({ modVersion: `0.1.${number}`, install: installHash(number) }, { ip: `198.51.100.${number}` });
  }
  const hash = wide.store.data.get(`er:i:${signatureOf(1)}`).value;
  assert.equal(hash.size, 48, 'the index hash stops growing at 48 fields');
  const capped = (await listing(wide)).signatures[0];
  assert.equal(capped.reports, 80, 'every report is still counted');
  assert.equal(Object.keys(capped.versions).length, 41);
  // A version already in the hash keeps counting after the cap is reached.
  await wide.send({ modVersion: '0.1.1', install: installHash(200) });
  assert.equal((await listing(wide)).signatures[0].versions['0.1.1'], 2);
  assert.equal(wide.store.data.get(`er:i:${signatureOf(1)}`).value.size, 48);
});

test('the message and frame kept in the index are cut by characters, never in the middle of one', async () => {
  const world = createErrorWorld(WIDE);
  const message = '😀'.repeat(150) + 'x'.repeat(100); // 400 UTF-16 units, 250 characters
  await world.send({ message, frame: 'f'.repeat(240) });
  let [entry] = (await listing(world)).signatures;
  assert.equal(entry.message, '😀'.repeat(150) + 'x'.repeat(50));
  assert.equal(entry.frame.length, 160);
  await world.send({ signature: signatureOf(2), message: 'half \ud800 pair', frame: undefined });
  entry = (await listing(world)).signatures.find(row => row.signature === signatureOf(2));
  assert.equal(entry.message, 'half � pair', 'a lone half of a pair cannot be stored as text');
  assert.equal(entry.frame, null);
});

test('ERROR_REPORTS_OFF answers 404 before anything else, so the bridge stops asking', async () => {
  for (const value of ['1', 'true', 'yes', 'on', ' ON ']) {
    const world = createErrorWorld({ ERROR_REPORTS_OFF: value });
    const response = await world.send();
    assert.equal(response.statusCode, 404, value);
    assert.deepEqual(response.json, { error: 'not_found' });
    assert.equal(world.store.commands, 0);
  }
  const blank = createErrorWorld({ ERROR_REPORTS_OFF: '' });
  assert.equal((await blank.send()).statusCode, 200);
  assert.equal((await createErrorWorld({ ERROR_REPORTS_OFF: '0' }).send()).statusCode, 200);
  // Off wins over a missing setting, and a wrong method still gets its 405 first.
  const bare = createErrorWorld({ ERROR_REPORTS_OFF: '1', UPSTASH_REDIS_REST_URL: '' });
  assert.equal((await bare.send()).statusCode, 404);
  assert.equal((await bare.send({}, { method: 'GET' })).statusCode, 405);
});

test('a deploy with only the signing secret and the store takes reports: the Convai key is not needed', async () => {
  const world = createErrorWorld({ CONVAI_API_KEY: '', CONVAI_AUTH_ADMIN_SECRET: '' });
  assert.equal(world.env.CONVAI_API_KEY, '');
  const response = await world.send();
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.stored, true);
});

test('missing settings are 503 unconfigured', async () => {
  const cases = {
    'no signing secret': { CONVAI_AUTH_SIGNING_SECRET: '' },
    'a short signing secret': { CONVAI_AUTH_SIGNING_SECRET: 'short' },
    'no store address': { UPSTASH_REDIS_REST_URL: '' },
    'no store token': { UPSTASH_REDIS_REST_TOKEN: '' },
  };
  for (const [name, change] of Object.entries(cases)) {
    const world = createErrorWorld(change);
    const response = await world.send();
    assert.equal(response.statusCode, 503, name);
    assert.deepEqual(response.json, { error: 'unconfigured' }, name);
    assert.equal(world.store.commands, 0, name);
  }
});

test('a store that is down is 503 unavailable with Retry-After, logged without any report text, and fails closed', async () => {
  const world = createErrorWorld();
  world.store.failing = true;
  const logs = await captureErrors(async () => {
    const response = await world.send();
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json, { error: 'unavailable' });
    assert.equal(response.headers['Retry-After'], '30');
  });
  assert.ok(logs.includes('[error-reports] store unavailable'));
  for (const secret of [installHash(1), DEFAULT_ADDRESS, 'attempt to index', SIGNING_SECRET]) assert.ok(!logs.includes(secret), `the log must not hold ${secret}`);

  const odd = mockResponse();
  const handler = createErrorReportHandler({ env: makeEnv(), store: { evalScript: async () => 'not an array' }, now: () => START });
  const bodyText = JSON.stringify(world.body());
  const timestamp = String(Math.floor(START / 1000));
  await captureErrors(() => handler({ method: 'POST', headers: { 'x-convai-timestamp': timestamp, 'x-convai-signature': signBody(SIGNING_SECRET, timestamp, bodyText) }, body: bodyText }, odd));
  assert.equal(odd.statusCode, 503);
});

test('every answer that reaches the store costs exactly one billed command', async () => {
  const world = createErrorWorld({ ERROR_REPORTS_INSTALL_PER_DAY: '2', ERROR_REPORTS_IP_PER_HOUR: '6', ERROR_REPORTS_STORE_PER_DAY: '1' });
  const cost = async (fields, extra) => {
    const before = world.store.commands;
    const response = await world.send(fields, extra);
    return [response.json.reason ?? (response.json.stored ? 'stored' : response.json.error), world.store.commands - before];
  };
  assert.deepEqual(await cost({}), ['stored', 1]);
  assert.deepEqual(await cost({}), ['duplicate', 1]);
  assert.deepEqual(await cost({ signature: signatureOf(2) }), ['counted', 1]);
  assert.deepEqual(await cost({ signature: signatureOf(3) }), ['rate', 1]); // the install's third different report today
  assert.deepEqual(await cost({ signature: signatureOf(4), install: installHash(2) }), ['counted', 1]);
  assert.deepEqual(await cost({ signature: signatureOf(5), install: installHash(3) }), ['counted', 1]);
  assert.deepEqual(await cost({ signature: signatureOf(6), install: installHash(4) }), ['rate', 1]); // address: 7th request this hour
  assert.equal(world.store.scripts, world.store.commands, 'only scripts were billed');
});

test('no install id, hash the client sent, or address is in any key or value, and every key has a lifetime', async () => {
  const world = createErrorWorld({ ...WIDE, ERROR_REPORTS_SAMPLES: '2', ERROR_REPORTS_STORE_PER_DAY: '4' });
  const addresses = [DEFAULT_ADDRESS, '198.51.100.9', '2001:db8::7'];
  let number = 0;
  for (const address of addresses) {
    for (const signature of [1, 2]) {
      number += 1;
      await world.send({ install: installHash(number), signature: signatureOf(signature) }, { ip: address });
    }
  }
  await world.send({ install: installHash(1), signature: signatureOf(1) }); // a duplicate
  assert.ok(world.store.data.size > 8);

  const everything = world.contents();
  for (let sent = 1; sent <= number; sent++) {
    assert.ok(!everything.includes(installHash(sent)), 'the install hash the client sent is nowhere in the store');
    assert.ok(everything.includes(pseudonym(SIGNING_SECRET, 'error-install', installHash(sent))), 'its second hash is the key');
  }
  for (const address of addresses) {
    assert.ok(!everything.includes(address), 'no address');
    // The rate limits count an IPv6 address as its /64 network (http.js addressBucket); that bucket is what is hashed.
    assert.ok(everything.includes(pseudonym(SIGNING_SECRET, 'error-ip', addressBucket(address))));
  }
  // The kept bodies hold the second hash too.
  let bodies = 0;
  for (const [key, entry] of world.store.data) {
    assert.ok(key.startsWith('er:'), key);
    assert.notEqual(entry.expiresAt, null, `${key} has a lifetime`);
    if (!key.startsWith('er:r:')) continue;
    for (const packed of entry.value.values()) {
      bodies += 1;
      const text = gunzipSync(Buffer.from(packed, 'base64')).toString('utf8');
      assert.ok(!text.includes('203.0.113') && !text.includes('198.51.100'));
      for (let sent = 1; sent <= number; sent++) assert.ok(!text.includes(installHash(sent)));
      assert.match(JSON.parse(text).install, /^[0-9a-f]{24}$/);
    }
  }
  assert.ok(bodies >= 3);
});

test('the settings have the documented defaults, ranges and names, and are listed for /readyz', () => {
  const config = readConfig({});
  assert.deepEqual([config.errorReportsOff, config.errorInstallPerDay, config.errorIpPerHour, config.errorStorePerDay, config.errorSamples, config.errorTtlDays],
    [false, 10, 30, 300, 10, 30]);
  assert.equal(DEFAULTS.errorStorePerDay, 300);
  for (const name of ['ERROR_REPORTS_OFF', 'ERROR_REPORTS_INSTALL_PER_DAY', 'ERROR_REPORTS_IP_PER_HOUR', 'ERROR_REPORTS_STORE_PER_DAY', 'ERROR_REPORTS_SAMPLES', 'ERROR_REPORTS_TTL_DAYS']) {
    assert.ok(ENV_NAMES.includes(name), name);
  }
  const set = readConfig({ ERROR_REPORTS_INSTALL_PER_DAY: '0', ERROR_REPORTS_IP_PER_HOUR: 'many', ERROR_REPORTS_STORE_PER_DAY: '0', ERROR_REPORTS_SAMPLES: '5000' });
  assert.equal(set.errorInstallPerDay, 1);
  assert.equal(set.errorIpPerHour, 30);
  assert.equal(set.errorStorePerDay, 0);
  assert.equal(set.errorSamples, 100);
});
