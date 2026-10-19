import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminErrorsHandler } from '../api/_lib/errors-admin.js';
import { asAdmin, createErrorWorld, installHash, signatureOf } from '../testkit/errors-world.mjs';
import { FAKE_API_KEY, SIGNING_SECRET, makeEnv, mockResponse } from '../testkit/harness.mjs';

// Wide limits unless a test narrows one.
const WIDE = { ERROR_REPORTS_INSTALL_PER_DAY: '100000', ERROR_REPORTS_IP_PER_HOUR: '100000', ERROR_REPORTS_STORE_PER_DAY: '100000' };
const ROW = ['firstSeen', 'frame', 'ids', 'kind', 'lastSeen', 'message', 'reports', 'signature', 'stored', 'versions'];

/** Three signatures, one second apart (signature 3 is the newest); signature 1 has two reports, one per install. */
async function seed(world) {
  const sent = [];
  for (const [signature, install, extra] of [[1, 1, {}], [2, 2, { kind: 'redscript-error', message: 'second problem', frame: undefined }],
    [1, 3, { modVersion: '0.2.1' }], [3, 4, { kind: 'bridge-crash', message: 'third problem', modVersion: '0.2.3' }]]) {
    const response = await world.send({ signature: signatureOf(signature), install: installHash(install), ...extra });
    assert.equal(response.json.stored, true);
    sent.push(response.json.id);
    world.advance(1000);
  }
  return sent;
}

test('the admin call is hidden without a real admin secret, refuses the wrong one, and allows only GET and DELETE', async () => {
  const world = createErrorWorld();
  assert.equal((await world.ask('/api/admin/errors', { headers: {} })).statusCode, 401);
  assert.equal((await world.ask('/api/admin/errors', { headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  assert.equal((await world.ask('/api/admin/errors', { headers: { authorization: `Bearer ${SIGNING_SECRET}` } })).statusCode, 401, 'the signing secret is not the admin secret');
  assert.equal((await world.ask('/api/admin/errors', { headers: { authorization: asAdmin.authorization.replace('Bearer', 'Basic') } })).statusCode, 401);
  assert.equal((await world.ask(`/api/admin/errors?signature=${signatureOf(1)}`, { method: 'DELETE', headers: {} })).statusCode, 401, 'DELETE needs it too');
  for (const method of ['POST', 'PUT', 'PATCH']) {
    const response = await world.ask('/api/admin/errors', { method });
    assert.equal(response.statusCode, 405, method);
    assert.equal(response.headers.Allow, 'GET, DELETE');
  }
  for (const secret of ['', 'short']) {
    const hidden = createErrorWorld({ CONVAI_AUTH_ADMIN_SECRET: secret });
    assert.equal((await hidden.ask('/api/admin/errors')).statusCode, 404);
    assert.equal((await hidden.ask('/api/admin/errors', { headers: { authorization: `Bearer ${secret}` } })).statusCode, 404, 'a short secret is never accepted');
    assert.equal((await hidden.ask(`/api/admin/errors?signature=${signatureOf(1)}`, { method: 'DELETE' })).statusCode, 404);
  }
  assert.equal(world.store.commands, 0, 'refusals cost no store command');
});

test('the list shows the signatures by when each was last seen, newest first, with what they are, their counts, versions and body ids', async () => {
  const world = createErrorWorld(WIDE);
  const ids = await seed(world);
  const before = world.store.commands;
  const response = await world.ask('/api/admin/errors');
  assert.equal(response.statusCode, 200);
  assert.equal(world.store.commands - before, 2 + 2 * 3, 'two commands, then two for each signature listed');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  const body = response.json;
  assert.equal(body.total, 3);
  // Signature 1 was seen again after signature 2, so it is listed before it.
  assert.deepEqual(body.signatures.map(row => row.signature), [signatureOf(3), signatureOf(1), signatureOf(2)]);
  for (const row of body.signatures) assert.deepEqual(Object.keys(row).sort(), ROW);

  const [third, first, second] = body.signatures;
  assert.deepEqual({ kind: third.kind, message: third.message, reports: third.reports, stored: third.stored, versions: third.versions, ids: third.ids },
    { kind: 'bridge-crash', message: 'third problem', reports: 1, stored: 1, versions: { '0.2.3': 1 }, ids: [ids[3]] });
  assert.equal(second.kind, 'redscript-error');
  assert.equal(second.frame, null, 'no frame is null, not an empty text');
  assert.equal(first.frame, 'mod/example.lua:12');
  assert.equal(first.reports, 2);
  assert.deepEqual(first.versions, { '0.2.2': 1, '0.2.1': 1 });
  assert.deepEqual(first.ids, [ids[2], ids[0]], 'ids newest first');
  assert.equal(first.firstSeen, new Date(world.clock.now - 4000).toISOString());
  assert.equal(first.lastSeen, new Date(world.clock.now - 2000).toISOString());
  for (const secret of [SIGNING_SECRET, FAKE_API_KEY, 'fake-store-token']) assert.ok(!response.text.includes(secret));
  for (let install = 1; install <= 4; install++) assert.ok(!response.text.includes(installHash(install)), 'no install hash in a list');
});

test('an empty store lists nothing for two commands', async () => {
  const world = createErrorWorld();
  const response = await world.ask('/api/admin/errors');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json, { total: 0, signatures: [] });
  assert.equal(world.store.commands, 2);
});

test('limit is clamped to 1..200 and defaults to 100', async () => {
  const world = createErrorWorld(WIDE);
  await seed(world);
  const asked = [];
  const original = world.store.pipeline.bind(world.store);
  world.store.pipeline = async commands => {
    if (commands[0][0] === 'ZREVRANGE') asked.push(commands[0].slice(0, 4).join(' '));
    return original(commands);
  };
  assert.equal((await world.ask('/api/admin/errors?limit=2')).json.signatures.length, 2);
  assert.equal((await world.ask('/api/admin/errors?limit=1')).json.signatures.length, 1);
  assert.equal((await world.ask('/api/admin/errors?limit=1')).json.total, 3, 'total is the whole list, not the page');
  for (const limit of ['1000', '201', '0', '-5', 'many', '']) await world.ask(`/api/admin/errors?limit=${limit}`);
  await world.ask('/api/admin/errors');
  assert.deepEqual(asked, [
    'ZREVRANGE er:sigs 0 1', 'ZREVRANGE er:sigs 0 0', 'ZREVRANGE er:sigs 0 0',
    'ZREVRANGE er:sigs 0 199', 'ZREVRANGE er:sigs 0 199', 'ZREVRANGE er:sigs 0 99', 'ZREVRANGE er:sigs 0 0', 'ZREVRANGE er:sigs 0 99', 'ZREVRANGE er:sigs 0 99',
    'ZREVRANGE er:sigs 0 99',
  ]);
});

test('a signature whose index has expired is skipped, and the list reads either form of HGETALL', async () => {
  const world = createErrorWorld(WIDE);
  await seed(world);
  world.store.data.delete(`er:i:${signatureOf(2)}`);
  const skipped = (await world.ask('/api/admin/errors')).json;
  assert.equal(skipped.total, 3);
  assert.deepEqual(skipped.signatures.map(row => row.signature), [signatureOf(3), signatureOf(1)]);

  const plain = (await world.ask('/api/admin/errors')).json;
  // The same answer when the store hands the hash back as an object instead of the flat list Upstash's REST interface uses.
  const original = world.store.pipeline.bind(world.store);
  world.store.pipeline = async commands => (await original(commands)).map((result, index) => {
    if (commands[index][0] !== 'HGETALL') return result;
    const object = {};
    for (let at = 0; at < result.length; at += 2) object[result[at]] = result[at + 1];
    return object;
  });
  assert.deepEqual((await world.ask('/api/admin/errors')).json, plain);
});

test('one body is fetched unpacked, with when it arrived; unknown ones are 404 and malformed ones 400', async () => {
  const world = createErrorWorld(WIDE);
  const ids = await seed(world);
  const found = await world.ask(`/api/admin/errors?signature=${signatureOf(1)}&id=${ids[2]}`);
  assert.equal(found.statusCode, 200);
  assert.deepEqual(Object.keys(found.json).sort(), ['id', 'receivedAt', 'report', 'signature']);
  assert.equal(found.json.receivedAt, new Date(Number(ids[2].slice(0, 13))).toISOString());
  assert.equal(found.json.report.signature, signatureOf(1));
  assert.equal(found.json.report.modVersion, '0.2.1');
  assert.deepEqual(found.json.report.report, { note: 'opaque to the server', lines: ['one', 'two'] });
  assert.ok(!found.text.includes(installHash(3)), 'the install hash the client sent is not in a kept body');

  assert.equal((await world.ask(`/api/admin/errors?signature=${signatureOf(1)}&id=${ids[3]}`)).statusCode, 404, 'an id of another signature');
  assert.deepEqual((await world.ask(`/api/admin/errors?signature=${signatureOf(9)}&id=${ids[0]}`)).json, { error: 'not_found' });
  assert.equal((await world.ask(`/api/admin/errors?signature=${signatureOf(1)}&id=0000000000000-abcdef`)).statusCode, 404);

  const bad = [
    `signature=${signatureOf(1)}`, // an id is needed to fetch a body
    `id=${ids[0]}`,
    `signature=${signatureOf(1).slice(1)}&id=${ids[0]}`,
    `signature=${signatureOf(255).toUpperCase()}&id=${ids[0]}`,
    `signature=${signatureOf(1)}&id=${ids[0].slice(1)}`,
    `signature=${signatureOf(1)}&id=${ids[0].replace('-', '_')}`,
    `signature=${signatureOf(1)}&id=${ids[0]}x`,
    `signature=&id=`,
    `signature=${encodeURIComponent('er:i:x')}&id=${ids[0]}`,
  ];
  for (const query of bad) {
    const response = await world.ask(`/api/admin/errors?${query}`);
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json.error, 'bad_request');
  }
});

test('a record that does not unpack is reported as corrupt, not as a crash', async () => {
  const world = createErrorWorld(WIDE);
  const [id] = await seed(world);
  world.store.exec(['HSET', `er:r:${signatureOf(1)}`, id, 'this is not base64 gzip']);
  const response = await world.ask(`/api/admin/errors?signature=${signatureOf(1)}&id=${id}`);
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json, { error: 'corrupt' });
});

test('DELETE with an id forgets that one body only', async () => {
  const world = createErrorWorld(WIDE);
  const ids = await seed(world);
  const response = await world.ask(`/api/admin/errors?signature=${signatureOf(1)}&id=${ids[0]}`, { method: 'DELETE' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json, { deleted: 1 });
  assert.deepEqual((await world.ask(`/api/admin/errors?signature=${signatureOf(1)}&id=${ids[0]}`, { method: 'DELETE' })).json, { deleted: 0 }, 'again: nothing left to delete');
  assert.equal((await world.ask(`/api/admin/errors?signature=${signatureOf(1)}&id=${ids[0]}`)).statusCode, 404);
  assert.equal((await world.ask(`/api/admin/errors?signature=${signatureOf(1)}&id=${ids[2]}`)).statusCode, 200, 'the other body of the signature stays');
  const row = (await world.ask('/api/admin/errors')).json.signatures.find(item => item.signature === signatureOf(1));
  assert.deepEqual(row.ids, [ids[2]]);
  assert.equal(row.reports, 2, 'the counts are history and stay');
});

test('DELETE with only a signature forgets the signature everywhere', async () => {
  const world = createErrorWorld(WIDE);
  const ids = await seed(world);
  const response = await world.ask(`/api/admin/errors?signature=${signatureOf(1)}`, { method: 'DELETE' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json, { deleted: true });
  for (const key of ['er:i', 'er:r', 'er:o']) assert.equal(world.store.data.has(`${key}:${signatureOf(1)}`), false, key);
  const list = (await world.ask('/api/admin/errors')).json;
  assert.equal(list.total, 2);
  assert.deepEqual(list.signatures.map(row => row.signature), [signatureOf(3), signatureOf(2)]);
  assert.equal((await world.ask(`/api/admin/errors?signature=${signatureOf(1)}&id=${ids[0]}`)).statusCode, 404);
  assert.deepEqual((await world.ask(`/api/admin/errors?signature=${signatureOf(1)}`, { method: 'DELETE' })).json, { deleted: false });
  assert.deepEqual((await world.ask(`/api/admin/errors?signature=${signatureOf(7)}`, { method: 'DELETE' })).json, { deleted: false }, 'a signature that was never there');
  // Reports of the same signature are taken again afterwards.
  assert.equal((await world.send({ signature: signatureOf(1), install: installHash(9) })).json.stored, true);
});

test('DELETE needs a well-formed signature (and id, when given)', async () => {
  const world = createErrorWorld(WIDE);
  const ids = await seed(world);
  for (const query of ['', `id=${ids[0]}`, 'signature=nope', `signature=${signatureOf(1)}&id=nope`, `signature=${signatureOf(1)}&id=`]) {
    const response = await world.ask(`/api/admin/errors?${query}`, { method: 'DELETE' });
    assert.equal(response.statusCode, 400, query);
  }
  assert.equal((await world.ask('/api/admin/errors')).json.total, 3, 'nothing was deleted');
});

test('a store that is down is 503 for every admin call', async () => {
  const world = createErrorWorld(WIDE);
  const [id] = await seed(world);
  world.store.failing = true;
  for (const [url, method] of [['/api/admin/errors', 'GET'], [`/api/admin/errors?signature=${signatureOf(1)}&id=${id}`, 'GET'],
    [`/api/admin/errors?signature=${signatureOf(1)}`, 'DELETE'], [`/api/admin/errors?signature=${signatureOf(1)}&id=${id}`, 'DELETE']]) {
    const response = await world.ask(url, { method });
    assert.equal(response.statusCode, 503, `${method} ${url}`);
    assert.deepEqual(response.json, { error: 'unavailable' });
  }
});

test('the admin call builds its own store from the settings when none is injected, and fails closed when it cannot reach it', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), authorization: init.headers.Authorization });
    throw new Error('network down');
  };
  const handler = createAdminErrorsHandler({ env: makeEnv(), fetchImpl });
  const response = mockResponse();
  await handler({ method: 'GET', url: '/api/admin/errors', headers: asAdmin }, response);
  assert.equal(response.statusCode, 503);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://store.invalid/pipeline');
});
