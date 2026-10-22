import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {listEndUsers, validateKey} from './convai-key.mjs';
import {ConvaiMemoryAdapter} from './convai-memory.mjs';
import {createConvaiClient} from '../auth-backend/api/_lib/convai.js';

// Security review 2026-10-22, finding 11: fetch strips Authorization on a redirect to another host but not custom headers such as
// CONVAI-API-KEY or API-AUTH-TOKEN, so every call that carries one refuses to follow a redirect. A fake key only.
const KEY = 'redirect-fixture-key-2222222222222222';

/** Two loopback servers on two ports (two origins): the first answers every request with a 302 to the second, which records what reaches it. */
async function redirectingPair() {
  const reached = [];
  const target = createServer((request, response) => { reached.push({url: request.url, headers: request.headers}); response.writeHead(200, {'content-type': 'application/json'}).end('{}'); });
  await new Promise(done => target.listen(0, '127.0.0.1', done));
  const targetUrl = `http://127.0.0.1:${target.address().port}/stolen`;
  const front = createServer((request, response) => { request.resume(); response.writeHead(302, {Location: targetUrl}).end(); });
  await new Promise(done => front.listen(0, '127.0.0.1', done));
  const frontOrigin = `http://127.0.0.1:${front.address().port}`;
  // A fetch that sends whatever the code asks for to the front server instead of Convai, with the real fetch's redirect handling.
  const fetchImpl = (url, init) => fetch(frontOrigin + new URL(url).pathname, init);
  const close = () => Promise.all([front, target].map(server => new Promise(done => { server.closeAllConnections?.(); server.close(done); })));
  return {fetchImpl, reached, close};
}

test('validateKey and listEndUsers never follow a redirect with the key header', async () => {
  const pair = await redirectingPair();
  try {
    assert.equal(await validateKey(KEY, {fetchImpl: pair.fetchImpl}), 'unknown');
    assert.equal(await listEndUsers(KEY, {fetchImpl: pair.fetchImpl}), null);
    assert.deepEqual(pair.reached, [], 'the other host never got a request');
  } finally { await pair.close(); }
});

test('the memory calls never follow a redirect with the key header', async () => {
  const pair = await redirectingPair();
  try {
    const memory = new ConvaiMemoryAdapter({key: KEY, enabled: true, fetchImpl: pair.fetchImpl});
    await assert.rejects(memory.request('/memory/list', {character_id: 'c', end_user_id: 'u'}));
    assert.deepEqual(pair.reached, [], 'the other host never got a request');
  } finally { await pair.close(); }
});

test('every call that carries a Convai header says redirect: error', async () => {
  const seen = [];
  const capture = async (url, init) => { seen.push({url: String(url), redirect: init?.redirect}); return new Response('{}', {status: 500}); };
  await validateKey(KEY, {fetchImpl: capture});
  await listEndUsers(KEY, {fetchImpl: capture});
  await assert.rejects(new ConvaiMemoryAdapter({key: KEY, enabled: true, fetchImpl: capture}).request('/memory/list', {}));
  const client = createConvaiClient({fetchImpl: capture, connectUrl: 'https://api.convai.com/user/connect', revokeUrl: 'https://api.convai.com/user/revoke'});
  await assert.rejects(client.mint(KEY));
  await client.revoke(KEY, 'token');
  assert.ok(seen.length >= 5, JSON.stringify(seen));
  for (const call of seen) assert.equal(call.redirect, 'error', call.url);
});
