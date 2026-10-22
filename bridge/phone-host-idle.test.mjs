// The phone Chat host (a second hidden Edge, Convai only) lets go of a conversation page nobody used for a few minutes, and of its browser with the last page
// (docs/RESOURCE_LIFECYCLE.md); a Chat that is open keeps its page; the next message opens one again. Offline: a fake page and browser, no Edge, no Convai.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TransportPool, transportKey} from './transport-pool.mjs';
import {RealtimeHost} from './realtime-host.mjs';
import {PHONE_HOST_IDLE_MS} from './phone-warm.mjs';

const config = id => ({key: 'offline-test-key', characterId: id, endUserId: 'offline-player', scope: 'phone:offline-world', ttsEnabled: false});
const fakePage = () => ({closed: false, isClosed() { return this.closed; }, async evaluate() { return {ready: true}; }, async close() { this.closed = true; }});

test('the idle limit of the phone host is a few minutes, between two and five', () => {
  assert.ok(PHONE_HOST_IDLE_MS >= 2 * 60_000 && PHONE_HOST_IDLE_MS <= 5 * 60_000);
});

test('evictIdle closes the pages unused for the limit, never a leased or protected one, and a touched page counts as used', async () => {
  const closed = [];
  const pool = new TransportPool({limit: 5, create: async key => ({key}), dispose: async page => { closed.push(page.key); }});
  const hold = await pool.acquire('held');
  for (const key of ['old', 'protected', 'recent', 'touched']) { const lease = await pool.acquire(key); await lease.release(); }
  pool.protectedKeys = new Set(['protected', 'held']);   // what the party plan protects (retain with protect)
  // Age three of them: 'old' and 'protected' and 'touched' were last used 10 minutes ago, 'recent' a minute ago.
  const now = performance.now();
  pool.entries.get('old').used = now - 600_000; pool.entries.get('protected').used = now - 600_000; pool.entries.get('touched').used = now - 600_000;
  pool.entries.get('recent').used = now - 60_000; pool.entries.get('held').used = now - 600_000;
  pool.touch('touched');
  assert.equal(await pool.evictIdle({idleMs: 180_000, now: performance.now()}), 1);
  assert.deepEqual(closed, ['old']);
  assert.deepEqual([...pool.entries.keys()].sort(), ['held', 'protected', 'recent', 'touched']);
  await hold.release();
  await pool.close();
});

function phoneHost(pages) {
  const host = new RealtimeHost({});
  const closed = {pages: [], browser: 0};
  host.browser = {isConnected: () => true};
  host.pool = new TransportPool({limit: 5, create: async () => fakePage(), dispose: async page => { closed.pages.push(page); await page.close(); }});
  host.close = async () => { closed.browser++; host.browser = null; };
  return {host, closed};
}

test('releaseIdlePages closes an idle page, then the browser with the last one; nothing is released under a running call or before the limit', async () => {
  const {host, closed} = phoneHost();
  for (const id of ['judy', 'panam']) { const lease = await host.pool.acquire(transportKey(config(id))); await lease.release(); }
  // A minute after use: nothing goes.
  assert.deepEqual(await host.releaseIdlePages({idleMs: PHONE_HOST_IDLE_MS}), {pages: 0, browser: false});
  assert.equal(host.pool.entries.size, 2);
  // Judy is quiet for ten minutes, Panam for a minute: only Judy's page goes, and the browser stays for Panam's.
  host.pool.entries.get(transportKey(config('judy'))).used = performance.now() - 600_000;
  host.lastUsedAt = Date.now() - 600_000;
  assert.deepEqual(await host.releaseIdlePages({idleMs: PHONE_HOST_IDLE_MS}), {pages: 1, browser: false});
  assert.equal(closed.pages.length, 1); assert.equal(closed.browser, 0);
  // A call that is running keeps everything.
  host.pool.entries.get(transportKey(config('panam'))).used = performance.now() - 600_000;
  host.running = 1;
  assert.deepEqual(await host.releaseIdlePages({idleMs: PHONE_HOST_IDLE_MS}), {pages: 0, browser: false});
  host.running = 0;
  // Then the last page and the browser, the browser close awaited.
  assert.deepEqual(await host.releaseIdlePages({idleMs: PHONE_HOST_IDLE_MS}), {pages: 1, browser: true});
  assert.equal(closed.browser, 1); assert.equal(host.pool.entries.size, 0);
  // Nothing left to release: a no-op, not an error.
  assert.deepEqual(await host.releaseIdlePages({idleMs: PHONE_HOST_IDLE_MS}), {pages: 0, browser: false});
});

test('a page kept alive by an open Chat (the keep-alive reading) is not idle, and a page that went away is simply absent for the next message', async () => {
  const {host, closed} = phoneHost();
  const key = config('judy');
  const lease = await host.pool.acquire(transportKey(key)); await lease.release();
  host.pool.entries.get(transportKey(key)).used = performance.now() - 600_000;
  host.lastUsedAt = Date.now();
  assert.equal((await host.readiness(key, {keepAlive: true})).present, true);
  assert.equal((await host.releaseIdlePages({idleMs: PHONE_HOST_IDLE_MS})).pages, 0, 'the keep-alive reading counted as use');
  host.pool.entries.get(transportKey(key)).used = performance.now() - 600_000;
  host.lastUsedAt = Date.now() - 600_000;
  assert.equal((await host.releaseIdlePages({idleMs: PHONE_HOST_IDLE_MS})).pages, 1);
  assert.equal(closed.pages.length, 1);
  assert.deepEqual(await host.readiness(key), {present: false, ready: false}, 'the phone warm-up sees no page and opens one on demand');
});
