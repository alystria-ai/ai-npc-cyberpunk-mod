import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PartyConnections, parsePartyConnections, connectionKey, CONNECTION_LIMIT} from './party-connections.mjs';
import {RealtimeHost} from './realtime-host.mjs';

const flush = () => new Promise(done => setImmediate(done));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return {promise, resolve, reject}; };
const profiles = ['alex', 'judy', 'panam', 'kerry', 'viktor', 'misty', 'river', 'jackie'];
function fixture() {
  let time = 100000;
  const live = new Map(), calls = [], reports = [], pending = [];
  const host = {fail: false, defer: false,
    async retain(configs, options) {
      assert.equal(options.protect, true); assert.ok(configs.length <= CONNECTION_LIMIT);
      const wanted = new Set(configs.map(config => connectionKey(config.characterId, config.scope)));
      for (const identity of live.keys()) if (!wanted.has(identity)) live.delete(identity);
      host.wanted = wanted;
    },
    async warm(config, {signal}) {
      calls.push({profile: config.characterId, scope: config.scope, at: time, signal});
      if (host.defer) { const wait = deferred(); pending.push(wait); await wait.promise; }
      if (signal.aborted) throw Error('cancelled');
      if (host.fail) throw Error('service unavailable');
      const identity = connectionKey(config.characterId, config.scope);
      if (!live.has(identity)) live.set(identity, {});
      return {connectionMs: 123};
    },
    async readiness(config, {keepAlive}) {
      assert.equal(keepAlive, true);
      const present = live.has(connectionKey(config.characterId, config.scope));
      return {present, ready: present};
    },
  };
  const connections = new PartyConnections({host, now: () => time,
    isKnown: profile => [...profiles, 'nearby'].includes(profile),
    configFor: (profile, scope) => ({key: 'secret-key', characterId: profile, scope, sessionId: 'secret-session'}),
    onState: state => reports.push(state),
  });
  const heartbeat = members => connections.ingest({updated: time, profiles: members});
  const step = async (ms = 500) => { time += ms; await connections.maintain(); await flush(); };
  return {connections, host, live, calls, reports, pending, heartbeat, step, now: () => time};
}

test('party protocol preserves slot order, deduplicates profiles, and rejects oversized or future snapshots', () => {
  assert.deepEqual(parsePartyConnections({updated: 100, profiles: ['panam', 'alex', 'panam']}, 100), {updated: 100, profiles: ['panam', 'alex']});
  for (const bad of [{}, {updated: 6000, profiles: []}, {updated: 100, profiles: [...profiles, 'extra']},
    {updated: 100, profiles: ['bad/key']}, {updated: '100', profiles: []}]) assert.equal(parsePartyConnections(bad, 100), null);
});

test('spawn warms without a composer, duplicate copies reuse identity, dismissal of last copy closes its page', async () => {
  const f = fixture(); f.heartbeat(['alex', 'alex']); await f.step(0);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].scope, 'private');
  const page = f.live.get(connectionKey('alex', 'private'));
  f.heartbeat(['alex']); await f.step();
  assert.equal(f.calls.length, 1); assert.equal(f.live.get(connectionKey('alex', 'private')), page);
  const removed = f.heartbeat([]); await f.step();
  assert.deepEqual(removed.removed, ['alex']); assert.equal(f.live.size, 0);
});

test('all eight private connections coexist with three group pages and survive composer changes', async () => {
  const f = fixture(); f.heartbeat(profiles);
  for (let i = 0; i < 11; i++) { f.heartbeat(profiles); await f.step(); }
  assert.equal(f.live.size, 11);
  const privatePages = profiles.map(profile => f.live.get(connectionKey(profile, 'private')));
  await f.connections.setComposer({scope: 'group:jackie,kerry,misty', audience: ['jackie', 'kerry', 'misty']});
  for (let i = 0; i < 3; i++) { f.heartbeat(profiles); await f.step(); }
  for (let i = 0; i < profiles.length; i++) assert.equal(f.live.get(connectionKey(profiles[i], 'private')), privatePages[i]);
  assert.equal(f.live.size, 11);
  await f.connections.setComposer(null); await f.step();
  for (let i = 0; i < profiles.length; i++) assert.equal(f.live.get(connectionKey(profiles[i], 'private')), privatePages[i]);
  const report = JSON.stringify(f.connections.diagnostic());
  assert.ok(!report.includes('secret-key') && !report.includes('secret-session'));
});

test('a nearby private target uses the optional group allocation without evicting eight party connections', async () => {
  const f = fixture(); f.heartbeat(profiles);
  await f.connections.setComposer({scope: 'private', audience: ['nearby']});
  const plan = f.connections.plan();
  assert.equal(plan.length, 11); assert.equal(plan.filter(row => row.scope === 'private').length, 9);
  assert.equal(plan.filter(row => row.role === 'group').length, 2);
});

test('setup is staggered and capped at two pending attempts; removed startup cannot return', async () => {
  const f = fixture(); f.host.defer = true; f.heartbeat(['alex', 'judy', 'panam']);
  await f.step(0); await f.step(499); assert.equal(f.calls.length, 1);
  await f.step(1); await f.step(500); assert.equal(f.calls.length, 2);
  assert.equal(f.connections.diagnostic().connecting, 2);
  f.heartbeat(['judy', 'panam']); await f.step();
  assert.equal(f.calls[0].signal.aborted, true);
  f.pending[0].resolve(); await flush();
  assert.equal(f.live.has(connectionKey('alex', 'private')), false);
  await f.connections.clear(); for (const wait of f.pending) wait.resolve(); await flush();
});

test('persistent failure backs off to five minutes and recovers automatically while the party remains present', async () => {
  const f = fixture(); f.host.fail = true; f.heartbeat(['alex']); await f.step(0);
  assert.equal(f.calls.length, 1);
  for (let i = 0; i < 14; i++) { f.heartbeat(['alex']); await f.step(2000); }
  assert.equal(f.calls.length, 1);
  f.heartbeat(['alex']); await f.step(2000);
  assert.equal(f.calls.length, 2);
  for (let i = 0; i < 30; i++) { f.heartbeat(['alex']); await f.step(2000); }
  assert.equal(f.calls.length, 3); assert.equal(f.connections.diagnostic().connections[0].state, 'cooldown');
  assert.equal(f.connections.diagnostic().connections[0].retryAt, f.now() + 300000);
  for (let i = 0; i < 20; i++) { f.heartbeat(['alex']); await f.step(2000); }
  assert.equal(f.calls.length, 3);
  f.host.fail = false;
  for (let i = 0; i < 130; i++) { f.heartbeat(['alex']); await f.step(2000); }
  assert.equal(f.calls.length, 4); assert.equal(f.connections.diagnostic().connections[0].state, 'ready');
});

test('stale heartbeat clears party and group resources; an empty fresh party clears the last spawn', async () => {
  const f = fixture(); f.heartbeat(['alex', 'judy']); await f.step(0); await f.step(500);
  assert.equal(f.live.size, 2);
  await f.step(6501); assert.equal(f.connections.stale, true); assert.equal(f.live.size, 0);
  f.heartbeat(['alex']); await f.step(); assert.equal(f.live.size, 1);
  f.heartbeat([]); await f.step(); assert.equal(f.live.size, 0);
});

test('voice session cleanup only closes its own lease and leaves party browser ownership intact', async () => {
  const host = new RealtimeHost(); let closed = 0, grants = 0, discarded;
  const page = {url: () => 'http://127.0.0.1:1', context: () => ({grantPermissions: async () => { grants++; }, clearPermissions: async () => {}}),
    evaluate: async fn => String(fn).includes('beginVoice') ? {device: 'fake'} : {text: 'reply'}};
  host.start = async () => {}; host.close = async () => { closed++; };
  host.pool = {acquire: async () => ({value: page, release: async options => { discarded = options.discard; }})};
  const channel = host.voiceChannel();
  assert.equal(grants, 0);
  await channel.beginVoice({characterId: 'alex', scope: 'private'});
  await channel.finishVoice(); await channel.close();
  assert.equal(grants, 1); assert.equal(discarded, false); assert.equal(closed, 0);
});
