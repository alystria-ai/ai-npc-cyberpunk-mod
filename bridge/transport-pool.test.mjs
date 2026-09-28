import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TransportPool} from './transport-pool.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const flush = () => new Promise(done => setImmediate(done));
function fixture(limit = 3) {
  const live = new Set(), disposed = [], pool = new TransportPool({limit,
    create: async key => { const page = {key}; live.add(page); assert.ok(live.size <= limit); return page; },
    dispose: async page => { if (page) { live.delete(page); disposed.push(page); } },
  });
  return {pool, live, disposed};
}

test('three leased character pages block a fourth; released identity is reused without reconnecting', async () => {
  const {pool, live} = fixture();
  const leases = await Promise.all(['judy:group', 'panam:group', 'alex:group'].map(key => pool.acquire(key)));
  let resolved = false;
  const fourth = pool.acquire('river:group').then(lease => { resolved = true; return lease; });
  await flush(); assert.equal(resolved, false); assert.equal(live.size, 3);
  await leases[0].release();
  const newcomer = await fourth; assert.equal(live.size, 3);
  await newcomer.release(); await leases[1].release();
  const again = await pool.acquire('panam:group');
  assert.equal(again.value, leases[1].value); assert.equal(again.reused, true);
  assert.equal(pool.stats.maximum, 3);
  await again.release(); await leases[2].release(); await pool.close(); assert.equal(live.size, 0);
});

test('cancelling a queued request never creates a page later', async () => {
  const {pool, live} = fixture(1), first = await pool.acquire('judy:private');
  const controller = new AbortController();
  const waiting = pool.acquire('panam:group', {signal: controller.signal});
  await flush(); controller.abort();
  await assert.rejects(waiting, {name: 'AbortError'});
  await first.release(); await flush();
  assert.equal(pool.stats.created, 1); assert.equal(live.size, 1); await pool.close();
});

test('cancellation during page startup disposes its result and shutdown cannot resurrect it', async () => {
  const pending = deferred(), started = deferred(), disposed = [];
  const pool = new TransportPool({create: () => { started.resolve(); return pending.promise; }, dispose: async page => { disposed.push(page); }});
  const controller = new AbortController(), acquiring = pool.acquire('alex:group', {signal: controller.signal});
  await started.promise; controller.abort();
  const closing = pool.close(); pending.resolve({page: 'late'});
  await assert.rejects(acquiring, {name: 'AbortError'}); await closing;
  assert.deepEqual(disposed, [{page: 'late'}]); assert.equal(pool.entries.size, 0);
  await assert.rejects(pool.acquire('other'), {name: 'AbortError'});
});

test('listener scope changes dispose old group pages including an active lease; private pages are distinct', async () => {
  const {pool, live, disposed} = fixture();
  const group = await pool.acquire('judy:group:judy,panam');
  const privateChat = await pool.acquire('judy:private'); await privateChat.release();
  assert.notEqual(group.value, privateChat.value);
  await pool.retain(['judy:private']);
  assert.deepEqual(disposed, [group.value]); assert.equal(live.size, 1);
  await group.release(); // A cancelled turn cannot put its closed page back.
  assert.equal(live.size, 1); await pool.close();
});

test('slow eviction finishes before another page opens', async () => {
  const disposing = deferred(), closed = deferred(); let live = 0, maximum = 0;
  const pool = new TransportPool({limit: 1,
    create: async key => { maximum = Math.max(maximum, ++live); return {key}; },
    dispose: async () => { disposing.resolve(); await closed.promise; live--; },
  });
  const first = await pool.acquire('a'); await first.release();
  const second = pool.acquire('b'); await disposing.promise; assert.equal(live, 1);
  closed.resolve(); const lease = await second; assert.equal(maximum, 1);
  await lease.release(); await pool.close();
});

test('retained party connections cannot be evicted to make room for an unrelated composer', async () => {
  const {pool, live} = fixture(11);
  const party = Array.from({length: 8}, (_, i) => 'private-' + i), groups = ['group-a', 'group-b', 'group-c'];
  const leases = await Promise.all([...party, ...groups].map(key => pool.acquire(key)));
  await Promise.all(leases.map(lease => lease.release()));
  await pool.retain([...party, ...groups], {protect: true});
  const controller = new AbortController();
  const waiting = pool.acquire('nearby-private', {signal: controller.signal});
  await flush(); assert.equal(live.size, 11); assert.equal(pool.stats.evicted, 0);
  await pool.retain([...party, 'group-a', 'group-b', 'nearby-private'], {protect: true});
  const nearby = await waiting;
  for (let i = 0; i < 8; i++) assert.equal(pool.entries.get(party[i]).value, leases[i].value);
  assert.equal(live.size, 11); await nearby.release(); await pool.close();
});
