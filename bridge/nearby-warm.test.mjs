import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NearbyWarm, parseEntities, parseNearby, parseSpawned} from './nearby-warm.mjs';
import {NEARBY_LIMIT, SPAWNED_LIMIT} from './party-connections.mjs';

const flush = () => new Promise(done => setImmediate(done));
function fixture(overrides = {}) {
  let time = 1_000_000;
  const connectionCalls = [], voiceCalls = [];
  const connections = {setNearby: async profiles => { connectionCalls.push([...profiles]); }};
  const state = {busy: false, fail: new Set(), hold: new Map()};
  const warm = new NearbyWarm({connections, now: () => time, canPrepare: () => !state.busy,
    isKnown: profile => profile !== 'stranger',
    prepareVoice: async (profile, {signal}) => {
      voiceCalls.push(profile);
      if (state.hold.has(profile)) await state.hold.get(profile)(signal);
      if (state.fail.has(profile)) throw Error('voice unavailable');
    }, ...overrides});
  const document = (profiles, age = 0) => JSON.stringify({updated: time - age, profiles});
  return {warm, state, connectionCalls, voiceCalls, document, advance: ms => { time += ms; }};
}

test('the published list is validated, deduplicated, limited and refused when stale', () => {
  const now = 100_000;
  assert.deepEqual(parseNearby({updated: now, profiles: ['judy', 'judy']}, {now}), ['judy']);
  assert.deepEqual(parseNearby({updated: now, profiles: ['judy', 'panam']}, {now}), ['judy', 'panam']);
  assert.equal(NEARBY_LIMIT, 2);
  for (const bad of [null, {}, {updated: now, profiles: ['a', 'b', 'c']}, {updated: now, profiles: ['bad/key']},
    {updated: now - 9000, profiles: ['judy']}, {updated: now + 6000, profiles: ['judy']},
    {updated: 'x', profiles: []}, {updated: now, profiles: 'judy'}]) {
    assert.deepEqual(parseNearby(bad, {now}), []);
  }
  assert.deepEqual(parseNearby({updated: now, profiles: ['stranger', 'judy']}, {now, isKnown: p => p !== 'stranger'}), ['judy']);
});

test('a fresh list opens the connections and prepares the voices one at a time', async () => {
  const f = fixture();
  let release;
  f.state.hold.set('judy', () => new Promise(done => { release = done; }));
  await f.warm.apply(f.document(['judy', 'panam']));
  assert.deepEqual(f.connectionCalls.at(-1), ['judy', 'panam']);
  assert.deepEqual(f.voiceCalls, ['judy'], 'two voices were prepared at once');
  await f.warm.apply(f.document(['judy', 'panam']));
  assert.deepEqual(f.voiceCalls, ['judy']);
  release(); await flush();
  await f.warm.apply(f.document(['judy', 'panam']));
  assert.deepEqual(f.voiceCalls, ['judy', 'panam']);
  await flush(); await f.warm.apply(f.document(['judy', 'panam']));
  assert.deepEqual(f.voiceCalls, ['judy', 'panam'], 'a prepared voice was prepared again');
  assert.deepEqual(f.warm.diagnostic().voices, {judy: 'ready', panam: 'ready'});
});

test('voices wait while a turn or the microphone is active', async () => {
  const f = fixture();
  f.state.busy = true;
  await f.warm.apply(f.document(['judy']));
  assert.deepEqual(f.connectionCalls.at(-1), ['judy']);
  assert.deepEqual(f.voiceCalls, []);
  f.state.busy = false;
  await f.warm.apply(f.document(['judy']));
  assert.deepEqual(f.voiceCalls, ['judy']);
});

test('a character that leaves the list is released and its voice work is cancelled', async () => {
  const f = fixture();
  let seen;
  f.state.hold.set('judy', signal => new Promise((_, reject) => { seen = signal; signal.addEventListener('abort', () => reject(Error('cancelled'))); }));
  await f.warm.apply(f.document(['judy']));
  await f.warm.apply(f.document([]));
  assert.equal(seen.aborted, true);
  assert.deepEqual(f.connectionCalls.at(-1), []);
  assert.deepEqual(f.warm.diagnostic().voices, {});
  await flush();
  assert.deepEqual(f.warm.diagnostic().voices, {}, 'a cancelled voice came back as failed');
});

test('a stale or missing list releases everything, so a closed or paused game never keeps a connection', async () => {
  const f = fixture();
  await f.warm.apply(f.document(['judy']));
  await f.warm.apply(f.document(['judy'], 9000));
  assert.deepEqual(f.connectionCalls.at(-1), []);
  await f.warm.apply(f.document(['judy']));
  await f.warm.apply('');
  assert.deepEqual(f.connectionCalls.at(-1), []);
  await f.warm.apply('not json');
  assert.deepEqual(f.warm.diagnostic().profiles, []);
});

test('a failed voice is retried only after a delay and never breaks the connection', async () => {
  const errors = [];
  const f = fixture({onError: error => errors.push(error.message)});
  f.state.fail.add('judy');
  await f.warm.apply(f.document(['judy'])); await flush();
  assert.equal(f.warm.diagnostic().voices.judy, 'failed');
  assert.deepEqual(errors, ['voice unavailable']);
  await f.warm.apply(f.document(['judy']));
  assert.deepEqual(f.voiceCalls, ['judy'], 'retried immediately');
  f.advance(31_000); f.state.fail.clear();
  await f.warm.apply(f.document(['judy']));
  assert.deepEqual(f.voiceCalls, ['judy', 'judy']);
  await flush();
  assert.equal(f.warm.diagnostic().voices.judy, 'ready');
});

test('a connection error is reported and the next apply tries again; release empties the list', async () => {
  const errors = [];
  let fail = true;
  const calls = [];
  const connections = {setNearby: async profiles => { calls.push(profiles); if (fail) throw Error('retain failed'); }};
  const warm = new NearbyWarm({connections, now: () => 5000, onError: error => errors.push(error.message), prepareVoice: async () => {}});
  await warm.apply(JSON.stringify({updated: 5000, profiles: ['judy']}));
  assert.deepEqual(errors, ['retain failed']);
  fail = false;
  await warm.apply(JSON.stringify({updated: 5000, profiles: ['judy']}));
  assert.equal(calls.length, 2);
  await warm.release();
  assert.deepEqual(calls.at(-1), []);
});

test('an ambient character is listed with its entity and warmed through that body\'s exact route', async () => {
  const routes = [];
  const f = fixture({routeFor: (profile, entity) => profile.startsWith('resident') ? {characterId: profile + '-id', scope: 'private:' + entity} : null});
  f.warm.connections.setNearby = async (profiles, given) => { routes.push({profiles: [...profiles], given}); };
  const now = 1_000_000;
  assert.deepEqual(parseEntities({updated: now, entities: {'resident-male': '123ULL', 'bad/key': '1ULL', judy: 'not-an-id'}}, {now}),
    {'resident-male': '123ULL'});
  assert.deepEqual(parseEntities({updated: now - 9000, entities: {'resident-male': '123ULL'}}, {now}), {}, 'a stale list carries nothing');
  assert.deepEqual(parseEntities({updated: now, profiles: []}, {now}), {}, 'an older document without entities');
  await f.warm.apply(JSON.stringify({updated: now, profiles: ['resident-male', 'judy'], partners: [],
    entities: {'resident-male': '123ULL', judy: '9ULL'}}));
  assert.deepEqual(routes.at(-1).profiles, ['resident-male', 'judy']);
  assert.deepEqual(routes.at(-1).given, {'resident-male': {characterId: 'resident-male-id', scope: 'private:123ULL'}},
    'only an ambient profile gets an entity route; a named one keeps its profile route');
});

// Characters another mod or a spawner created (mod/auto-connect.lua `spawned`): a list of their own beside the two nearby slots.
test('the spawned list is validated, deduplicated, limited to three and refused when stale', () => {
  const now = 100_000;
  assert.equal(SPAWNED_LIMIT, 3);
  assert.deepEqual(parseSpawned({updated: now, spawned: ['judy', 'panam', 'judy']}, {now}), ['judy', 'panam']);
  assert.deepEqual(parseSpawned({updated: now, spawned: ['judy', 'panam', 'kerry']}, {now}), ['judy', 'panam', 'kerry']);
  for (const bad of [null, {}, {updated: now}, {updated: now, spawned: ['a', 'b', 'c', 'd']}, {updated: now, spawned: ['bad/key']},
    {updated: now - 9000, spawned: ['judy']}, {updated: now + 6000, spawned: ['judy']}, {updated: now, spawned: 'judy'}]) {
    assert.deepEqual(parseSpawned(bad, {now}), []);
  }
  assert.deepEqual(parseSpawned({updated: now, spawned: ['stranger', 'judy']}, {now, isKnown: p => p !== 'stranger'}), ['judy']);
  // A document written before this field existed lists none, and the two nearby slots still parse.
  assert.deepEqual(parseSpawned({updated: now, profiles: ['judy'], partners: []}, {now}), []);
  assert.deepEqual(parseNearby({updated: now, profiles: ['judy'], spawned: ['panam', 'kerry', 'viktor']}, {now}), ['judy']);
});

test('spawned characters reach the connections beside the nearby slots, keep a voice each and are released with the list', async () => {
  const spawnedCalls = [], nearbyCalls = [], partnerCalls = [], voiceCalls = [];
  let time = 1_000_000;
  const connections = {setNearby: async profiles => { nearbyCalls.push([...profiles]); },
    setPartners: async profiles => { partnerCalls.push([...profiles]); },
    setSpawned: async profiles => { spawnedCalls.push([...profiles]); }};
  const warm = new NearbyWarm({connections, now: () => time, prepareVoice: async profile => { voiceCalls.push(profile); }});
  const document = (extra, age = 0) => JSON.stringify({updated: time - age, profiles: [], partners: [], ...extra});
  await warm.apply(document({profiles: ['kerry'], spawned: ['judy', 'panam']}));
  assert.deepEqual(spawnedCalls.at(-1), ['judy', 'panam']); assert.deepEqual(nearbyCalls.at(-1), ['kerry']);
  assert.deepEqual(warm.diagnostic().spawned, ['judy', 'panam']);
  // A voice each, one at a time, spawned characters before the plain nearby ones.
  assert.deepEqual(voiceCalls, ['judy']);
  await flush(); await warm.apply(document({profiles: ['kerry'], spawned: ['judy', 'panam']}));
  await flush(); await warm.apply(document({profiles: ['kerry'], spawned: ['judy', 'panam']}));
  assert.deepEqual(voiceCalls, ['judy', 'panam', 'kerry']);
  // A character V now talks to is a partner, not a spawned one as well; the list shrinks.
  await warm.apply(document({partners: ['panam'], spawned: ['judy', 'panam']}));
  assert.deepEqual(spawnedCalls.at(-1), ['judy']); assert.deepEqual(partnerCalls.at(-1), ['panam']);
  // The game stopped listing them: connections and voices are released, nothing stays prepared.
  await warm.apply(document({}));
  assert.deepEqual(spawnedCalls.at(-1), []); assert.deepEqual(warm.diagnostic().voices, {});
  // A list that stops being refreshed counts as empty.
  await warm.apply(document({spawned: ['judy']})); assert.deepEqual(spawnedCalls.at(-1), ['judy']);
  time += 20_000; await warm.apply(document({spawned: ['judy']}, 20_000));
  assert.deepEqual(spawnedCalls.at(-1), []);
  await warm.apply(document({spawned: ['panam']}));
  await warm.release();
  assert.deepEqual(spawnedCalls.at(-1), []); assert.deepEqual(warm.diagnostic().spawned, []);
  // Connections without a spawned lane (an older object) still work.
  const plain = new NearbyWarm({connections: {setNearby: async () => {}}, now: () => time, prepareVoice: async () => {}});
  await plain.apply(document({spawned: ['judy']})); await plain.release();
});

// A connections object with setAmbient gets the partner, spawned and nearby lists in ONE call (a profile that changes role keeps its
// page); one without it gets the three setters in turn, as before.
test('the three lists reach the connections as one plan change when they can take it, and one by one when they cannot', async () => {
  const calls = [];
  const ambient = {setAmbient: async value => { calls.push(['ambient', value]); }, setNearby: async () => { calls.push(['nearby']); },
    setPartners: async () => { calls.push(['partners']); }, setSpawned: async () => { calls.push(['spawned']); }};
  const warm = new NearbyWarm({connections: ambient, now: () => 5000, prepareVoice: async () => {}, routeFor: profile => profile === 'resident-male' ? {characterId: 'r', scope: 's'} : null});
  await warm.apply(JSON.stringify({updated: 5000, profiles: ['kerry', 'resident-male'], partners: ['judy'], spawned: ['panam', 'judy'], entities: {'resident-male': '12ULL'}}));
  assert.deepEqual(calls.map(call => call[0]), ['ambient'], 'one call, no separate setters');
  assert.deepEqual(calls[0][1].partners, ['judy']); assert.deepEqual(calls[0][1].spawned, ['panam'], 'a partner is not also spawned');
  assert.deepEqual(calls[0][1].nearby, ['kerry', 'resident-male']); assert.deepEqual(calls[0][1].routes, {'resident-male': {characterId: 'r', scope: 's'}});
  await warm.release();
  assert.deepEqual(calls.map(call => call[0]), ['ambient', 'ambient']); assert.deepEqual(calls[1][1], {});
  // A failure is reported, not thrown.
  const errors = [];
  const failing = new NearbyWarm({connections: {setAmbient: async () => { throw Error('retain failed'); }}, now: () => 5000,
    onError: error => errors.push(error.message), prepareVoice: async () => {}});
  await failing.apply(JSON.stringify({updated: 5000, profiles: [], spawned: ['judy']}));
  assert.deepEqual(errors, ['retain failed']);
  // Without setAmbient: the three setters in turn.
  const order = [];
  const plain = new NearbyWarm({connections: {setNearby: async () => { order.push('nearby'); }, setPartners: async () => { order.push('partners'); },
    setSpawned: async () => { order.push('spawned'); }}, now: () => 5000, prepareVoice: async () => {}});
  await plain.apply(JSON.stringify({updated: 5000, profiles: ['kerry'], partners: [], spawned: []}));
  assert.deepEqual(order, ['partners', 'spawned', 'nearby']);
});
