import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PlayerKnowledge} from './player-knowledge.mjs';
import {PartyConnections, CONNECTION_LIMIT} from './party-connections.mjs';
import {TransportPool, transportKey} from './transport-pool.mjs';

// Exercise the real route -> party retention -> page-pool seam. No browser,
// provider, player registry, or microphone hardware participates in this test.
const profiles = ['judy', 'panam', 'alex', 'kerry', 'river', 'misty', 'viktor', 'jackie'];
function fixture(t) {
  const guardFor = key => ({endUserId: 'fixture-user', characterId: 'fixture-' + key,
    resetEpoch: 0, characterEpoch: 0});
  const router = new PlayerKnowledge({
    pack: {version: 1, id: 'fixture-pack', revision: 1, gameVersions: ['2.31'], profileKeys: [...profiles, 'resident-female'],
      sources: [], evidence: [], factAllowlist: {}, journalAllowlist: {}, rules: []},
    playerMemory: {route: key => ({endUserId: 'fixture-user', guard: guardFor(key)}),
      isCurrent: guard => guard?.endUserId === 'fixture-user'},
    getBoundary: () => ({worldToken: 'fixture-world', generation: 1}), isWorldCurrent: () => true,
  });
  const disposed = [];
  const pool = new TransportPool({limit: CONNECTION_LIMIT,
    create: async key => ({key}), dispose: async page => { if (page) disposed.push(page); }});
  t.after(() => pool.close());
  const configFor = (profile, scope) => {
    const route = router.configFor(profile, scope);
    return {characterId: 'fixture-' + profile, scope: route.scope, ...route.remoteConfig, ttsEnabled: true};
  };
  const host = {retain: (configs, options) => pool.retain(configs.map(transportKey), options),
    readiness: async () => ({present: false, ready: false})};
  const connections = new PartyConnections({host, configFor, isKnown: key => profiles.includes(key), canWarm: () => false});
  connections.ingest({updated: Date.now(), profiles});
  return {router, pool, connections, configFor, disposed};
}

for (const grouped of [false, true]) {
  test(`${grouped ? 'F9 group' : 'F7 private'} microphone reuses a retained page at the full eleven-page limit`, async t => {
    const f = fixture(t), input = {profileKey: 'judy', requestId: 'fixture-request', source: 'microphone',
      text: 'Voice message', entity: '1ULL', generation: 1,
      ...(grouped ? {group: {id: 'fixture-group', index: 1, total: 3, audience: profiles.slice(0, 3), heard: []}} : {})};
    const prepared = await f.router.prepare(input);
    assert.equal(prepared.route.transport, 'microphone', 'input provenance remains available to memory admission');
    await f.connections.setRequest(prepared.input);
    const configs = f.connections.plan().map(spec => f.configFor(spec.profile, spec.scope));
    assert.equal(configs.length, CONNECTION_LIMIT);
    for (const config of configs) { const lease = await f.pool.acquire(transportKey(config)); await lease.release(); }
    const config = {characterId: 'fixture-judy', scope: prepared.scope, ...prepared.remoteConfig, ttsEnabled: true};
    const key = transportKey(config);
    assert.ok(f.pool.protectedKeys.has(key), 'the invitation/composer retained this exact microphone route');
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 500);
    let recording;
    try { recording = await f.pool.acquire(key, {signal: controller.signal}); }
    finally { clearTimeout(deadline); }
    assert.equal(recording.reused, true);
    for (let poll = 0; poll < 3; poll++) await f.connections.maintain();
    assert.equal(f.pool.entries.get(key)?.value, recording.value, 'maintenance must retain the busy recording page');
    assert.equal(f.pool.entries.get(key)?.busy, true);
    assert.equal(f.pool.stats.created, CONNECTION_LIMIT, 'a microphone does not need a twelfth connection');
    assert.equal(f.disposed.length, 0);
    await recording.release();
    const textLease = await f.pool.acquire(key);
    assert.equal(textLease.value, recording.value, 'a later typed turn can keep the same character session');
    await textLease.release();
  });
}

test('sharing the microphone route does not weaken dismissal cancellation', async t => {
  const f = fixture(t);
  const prepared = await f.router.prepare({profileKey: 'judy', requestId: 'fixture-request', source: 'microphone',
    text: 'Voice message', entity: '1ULL', generation: 1});
  await f.connections.setRequest(prepared.input);
  const key = transportKey({characterId: 'fixture-judy', scope: prepared.scope, ...prepared.remoteConfig, ttsEnabled: true});
  const recording = await f.pool.acquire(key);
  f.connections.ingest({updated: Date.now(), profiles: profiles.slice(1)});
  await f.connections.maintain();
  assert.equal(f.pool.entries.has(key), false);
  assert.deepEqual(f.disposed, [recording.value], 'dismissal still disposes the active lease, rather than skipping all busy pages');
  await recording.release();
});

for (const source of [undefined, 'microphone']) {
  test(`an entity-bound resident ${source || 'text'} request survives maintenance without exceeding the party page cap`, async t => {
    const f = fixture(t);
    await f.connections.maintain();
    for (const spec of f.connections.plan()) {
      const lease = await f.pool.acquire(transportKey(f.configFor(spec.profile, spec.scope))); await lease.release();
    }
    assert.equal(f.pool.entries.size, CONNECTION_LIMIT);
    const prepared = await f.router.prepare({profileKey: 'resident-female', requestId: 'fixture-resident',
      text: 'Hello', entity: '14ULL', generation: 1, source});
    assert.equal(prepared.sendAllowed, true);
    assert.equal(f.router.configFor('resident-female', 'private'), null, 'an ambient route cannot be guessed without its entity');
    const config = {key: 'fixture-secret', characterId: 'fixture-resident-female', scope: prepared.scope,
      ...prepared.remoteConfig, ttsEnabled: true};
    await f.connections.setRequest(prepared.input, config);
    const plan = f.connections.plan();
    assert.equal(plan.length, CONNECTION_LIMIT);
    assert.equal(plan.filter(spec => spec.role === 'party').length, 8);
    assert.equal(plan.filter(spec => spec.role === 'group').length, 2);
    assert.equal(f.disposed.length, 1, 'only one optional group page is retired for the selected resident');
    const key = transportKey(config), lease = await f.pool.acquire(key);
    for (let poll = 0; poll < 3; poll++) await f.connections.maintain();
    assert.equal(f.pool.entries.get(key)?.value, lease.value);
    assert.equal(f.pool.entries.get(key)?.busy, true);
    assert.equal(f.pool.stats.maximum, CONNECTION_LIMIT);
    const report = JSON.stringify(f.connections.diagnostic());
    assert.doesNotMatch(report, /fixture-secret|fixture-user|private:world:/, 'exact configuration is not exposed in connection diagnostics');
    await f.connections.clear();
    assert.equal(f.pool.entries.size, 0, 'world cancellation still disposes an active resident page');
    await lease.release();
  });
}

test('selecting another physical resident replaces the exact page rather than reusing the shared profile session', async t => {
  const f = fixture(t), leases = [];
  for (const entity of ['14ULL', '15ULL']) {
    const prepared = await f.router.prepare({profileKey: 'resident-female', requestId: 'fixture-' + entity,
      text: 'Hello', entity, generation: 1});
    const config = {characterId: 'fixture-resident-female', scope: prepared.scope, ...prepared.remoteConfig, ttsEnabled: true};
    await f.connections.setRequest(prepared.input, config);
    leases.push(await f.pool.acquire(transportKey(config)));
    await f.connections.maintain();
  }
  assert.notEqual(leases[0].value.key, leases[1].value.key);
  assert.equal(f.pool.entries.has(leases[0].value.key), false);
  assert.equal(f.pool.entries.get(leases[1].value.key)?.value, leases[1].value);
  assert.deepEqual(f.disposed, [leases[0].value]);
  for (const lease of leases) await lease.release();
});
