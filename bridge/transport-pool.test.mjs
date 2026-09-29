import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TransportPool, transportKey} from './transport-pool.mjs';
import {RealtimeHost} from './realtime-host.mjs';

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

test('an exact idle refresh refuses busy leases and preserves unrelated retained entries', async () => {
  const {pool, disposed} = fixture();
  const target = await pool.acquire('judy:private'), group = await pool.acquire('judy:group'), other = await pool.acquire('panam:private');
  await group.release(); await other.release();
  await pool.retain(['judy:private', 'judy:group', 'panam:private'], {protect: true});
  assert.equal(await pool.discardIdle('judy:private'), false); assert.deepEqual(disposed, []);
  assert.equal(pool.entries.get('judy:private').busy, true);
  await target.release();
  assert.equal(await pool.discardIdle('judy:private'), true);
  assert.deepEqual(disposed, [target.value]);
  assert.equal(pool.entries.get('judy:group').value, group.value);
  assert.equal(pool.entries.get('panam:private').value, other.value);
  assert.deepEqual([...pool.protectedKeys], ['judy:private', 'judy:group', 'panam:private']);
  assert.equal(await pool.discardIdle('judy:private'), true); assert.equal(await pool.discardIdle('absent'), true);
  const renewed = await pool.acquire('judy:private');
  assert.notEqual(renewed.value, target.value); assert.equal(renewed.reused, false);
  await renewed.release(); await pool.close();
});

test('idle refresh holds the acquisition lock until disposal finishes', async () => {
  const disposing = deferred(), finish = deferred(); let count = 0;
  const pool = new TransportPool({limit: 1, create: async key => ({key, serial: ++count}),
    dispose: async () => { disposing.resolve(); await finish.promise; }});
  const old = await pool.acquire('judy'); await old.release();
  const refreshing = pool.discardIdle('judy'); await disposing.promise;
  let acquired = false;
  const next = pool.acquire('judy').then(lease => { acquired = true; return lease; });
  await flush(); assert.equal(acquired, false); assert.equal(count, 1);
  finish.resolve(); assert.equal(await refreshing, true);
  const renewed = await next;
  assert.equal(count, 2); assert.notEqual(renewed.value, old.value);
  await renewed.release(); await pool.close();
});

// The real host and pool run against pages that perform no network, SDK or
// browser work. This tests routing/leases at the public transport boundary.
function hostFixture() {
  const host = new RealtimeHost(), pages = [];
  host.start = async () => {};
  host.pool = new TransportPool({limit: 11, create: async key => {
    const page = {key, calls: [], closed: false, sessionID: 'page-session-' + pages.length,
      isClosed() { return this.closed; },
      context: () => ({grantPermissions: async () => {}, clearPermissions: async () => {}}),
      url: () => 'http://127.0.0.1:4321/',
      async evaluate(_fn, payload) {
        this.calls.push(payload);
        if (payload?.method === 'warm') return {connectionMs: 1, connectionReused: this.calls.length > 1};
        if (payload?.method === 'reply' || payload === undefined) return {text: 'Reply', sessionID: this.sessionID, timing: {}};
        if (payload?.characterId) return {device: 'Test microphone'};
        return {ready: true};
      }};
    pages.push(page); return page;
  }, dispose: async page => { if (page) page.closed = true; }});
  return {host, pages};
}

test('host pooling separates users, save branches, audience scopes and TTS routes while reusing an exact identity', async () => {
  const {host, pages} = hostFixture();
  const first = {characterId: 'judy', scope: 'private', ttsEnabled: false,
    endUserId: 'opaque-user-a-branch-one', endUserMetadata: {schema: 'memory-v1'}};
  assert.equal((await host.warm(first)).pageReused, false);
  assert.equal((await host.warm({...first})).pageReused, true);
  const variants = [{endUserId: 'opaque-user-b'}, {endUserId: 'opaque-user-a-branch-two'},
    {endUserId: undefined}, {scope: 'group:judy,panam'}, {ttsEnabled: true}];
  for (const change of variants) {
    assert.deepEqual(await host.readiness({...first, ...change}), {present: false, ready: false});
    assert.equal((await host.warm({...first, ...change})).pageReused, false);
  }
  assert.equal(pages.length, 6);
  assert.equal(new Set(pages.map(page => page.key)).size, 6);
  assert.equal(pages[0].calls[0].config.endUserMetadata, first.endUserMetadata);
  await host.retain([{...first, endUserId: 'opaque-user-a-branch-two'}], {protect: true});
  assert.equal(pages[2].closed, false);
  assert.equal(pages.filter(page => !page.closed).length, 1);
  assert.deepEqual(await host.readiness(first), {present: false, ready: false});
  await host.close();
});

test('a returned or supplied session cannot cross host pages into another user or scope', async () => {
  const {host, pages} = hostFixture();
  const first = {characterId: 'judy', endUserId: 'opaque-user-a', scope: 'private', ttsEnabled: false};
  const reply = await host.reply(first);
  await assert.rejects(host.reply({...first, endUserId: 'opaque-user-b', sessionId: reply.sessionID}), /another user or scope/);
  await assert.rejects(host.reply({...first, scope: 'group:judy,panam', sessionId: reply.sessionID}), /another user or scope/);
  assert.equal(pages.length, 1);
  await host.warm({...first, sessionId: reply.sessionID, ttsEnabled: true});
  assert.equal(pages.length, 2);
  await host.warm({...first, sessionId: 'restored-verified-session'});
  await assert.rejects(host.warm({...first, endUserId: 'opaque-user-b', sessionId: 'restored-verified-session'}), /another user or scope/);
  await host.close();
});

test('host idle refresh closes only the exact configuration and preserves session ownership', async () => {
  const {host, pages} = hostFixture();
  const target = {characterId: 'judy', endUserId: 'user-a', scope: 'private', ttsEnabled: false};
  const group = {...target, scope: 'group:judy,panam'}, other = {...target, characterId: 'panam'};
  const first = await host.reply(target);
  await host.warm(group); await host.warm(other); await host.retain([target, group, other], {protect: true});
  const evaluated = deferred(), complete = deferred();
  pages[0].evaluate = () => { evaluated.resolve(); return complete.promise; };
  const pending = host.reply({...target, sessionId: first.sessionID}); await evaluated.promise;
  assert.equal(await host.refreshIdle(target), false); assert.equal(pages[0].closed, false);
  complete.resolve({text: 'Finished reply', sessionID: first.sessionID, timing: {}}); await pending;
  const owners = new Map(host.sessions.owners);
  assert.equal(await host.refreshIdle({...target, ttsEnabled: true}), true);
  assert.equal(pages[0].closed, false, 'a different TTS configuration must not close this page');
  assert.equal(await host.refreshIdle(target), true);
  assert.equal(pages[0].closed, true); assert.equal(pages[1].closed, false); assert.equal(pages[2].closed, false);
  assert.deepEqual(host.sessions.owners, owners); assert.deepEqual(host.retained.keys, [target, group, other].map(transportKey));
  await host.warm({...target, sessionId: first.sessionID});
  assert.equal(pages.length, 4); assert.equal(pages[3].calls[0].config.sessionId, first.sessionID);
  await assert.rejects(host.warm({...target, endUserId: 'another-user', sessionId: first.sessionID}), /another user or scope/);
  await host.close();
  assert.equal(await host.refreshIdle(target), true);
});

test('identified speculative preparation fails before host startup; anonymous preparation still discards its page', async () => {
  const {host, pages} = hostFixture();
  let starts = 0; host.start = async () => { starts++; };
  const config = {characterId: 'judy', ttsEnabled: false};
  await assert.rejects(host.prepare({...config, endUserId: 'opaque-user-a'}), /cannot use speculative preparation/);
  assert.equal(starts, 0); assert.equal(pages.length, 0);
  await host.prepare(config);
  assert.equal(pages.length, 1); assert.equal(pages[0].closed, true);
  assert.equal(pages[0].calls[0].config.sessionId, '-1');
  assert.equal(pages[0].calls[0].config.freshSession, true);
  await host.close();
});

test('microphone routing and its returned session retain the verified user namespace', async () => {
  const {host, pages} = hostFixture();
  const first = {characterId: 'judy', endUserId: 'opaque-user-a', scope: 'private',
    endUserMetadata: {schema: 'memory-v1'}};
  const channel = host.voiceChannel();
  await channel.beginVoice(first);
  assert.deepEqual(pages[0].calls[0], first);
  await assert.rejects(host.beginVoice({...first, endUserId: 'opaque-user-b'}), /already running/);
  assert.equal(pages.length, 1); assert.equal(pages[0].closed, false);
  const reply = await channel.finishVoice();
  await assert.rejects(host.beginVoice({...first, endUserId: 'opaque-user-b', sessionId: reply.sessionID}), /another user or scope/);
  await host.beginVoice({...first, endUserId: 'opaque-user-b'});
  assert.equal(pages.length, 2);
  assert.equal(pages[1].calls[0].endUserId, 'opaque-user-b');
  await host.cancelVoice();
  assert.equal(pages[1].closed, true);
  await host.close();
});

test('queued work keeps its admitted identity if the caller changes its configuration during startup', async () => {
  const {host, pages} = hostFixture(), startup = deferred();
  host.start = () => startup.promise;
  const config = {characterId: 'judy', endUserId: 'opaque-user-a', scope: 'private', ttsEnabled: false};
  const key = transportKey(config), pending = host.warm(config);
  config.endUserId = 'opaque-user-b'; config.scope = 'group:judy,panam'; config.ttsEnabled = true;
  startup.resolve(); await pending;
  assert.equal(pages[0].key, key);
  assert.equal(pages[0].calls[0].config.endUserId, 'opaque-user-a');
  assert.equal(pages[0].calls[0].config.scope, 'private');
  assert.equal(pages[0].calls[0].config.ttsEnabled, false);
  await host.close();
});

test('a late completed evaluation cannot return a reply after its host closes', async () => {
  const {host, pages} = hostFixture();
  const config = {characterId: 'judy', endUserId: 'opaque-user-a'};
  await host.warm(config);
  const evaluated = deferred(), response = deferred();
  pages[0].evaluate = () => { evaluated.resolve(); return response.promise; };
  const pending = host.reply(config); pending.catch(() => {});
  await evaluated.promise; await host.close();
  response.resolve({sessionID: 'late-session', text: 'Obsolete reply', timing: {}});
  await assert.rejects(pending, {name: 'AbortError'});
});

test('invalid supplied identities fail closed without exposing their contents; metadata alone is anonymous', () => {
  const config = {characterId: 'judy'};
  assert.equal(transportKey({...config, endUserMetadata: {private: 'not an identity'}}), transportKey(config));
  for (const endUserId of ['', '   ', 123, {}, ['private-value']]) {
    assert.throws(() => transportKey({...config, endUserId}), error => error.message === 'Invalid conversation user identity');
  }
  assert.throws(() => transportKey({...config, endUserId: 'opaque-user', endUserMetadata: []}), /Invalid conversation user metadata/);
});
