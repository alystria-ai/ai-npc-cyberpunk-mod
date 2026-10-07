import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PartyConnections, connectionKey, CONNECTION_LIMIT, PARTNER_LIMIT, NEARBY_LIMIT} from './party-connections.mjs';
import {NearbyWarm, parsePartners} from './nearby-warm.mjs';

// Conversation partners (mod/auto-connect.lua): a world character V just talked to keeps the private connection
// its conversation used, in its own role outside the two nearby slots.
const flush = () => new Promise(done => setImmediate(done));
const party = ['alex', 'judy', 'panam', 'kerry', 'viktor', 'misty', 'river', 'jackie'];
function fixture() {
  let time = 100000;
  const live = new Map(), warms = [], closed = [];
  const host = {
    async retain(configs, options) {
      assert.equal(options.protect, true); assert.ok(configs.length <= CONNECTION_LIMIT, 'over the connection limit');
      const wanted = new Set(configs.map(config => connectionKey(config.characterId, config.scope)));
      for (const identity of live.keys()) if (!wanted.has(identity)) { live.delete(identity); closed.push(identity); }
    },
    async warm(config) {
      const identity = connectionKey(config.characterId, config.scope);
      warms.push(identity);
      if (!live.has(identity)) live.set(identity, {});
      return {connectionMs: 1};
    },
    async readiness(config) { return {present: live.has(connectionKey(config.characterId, config.scope)), ready: true, busy: false}; },
    async refreshIdle() { return true; },
  };
  const connections = new PartyConnections({host, now: () => time, isKnown: profile => profile !== 'stranger',
    configFor: (profile, scope) => ({key: 'k', characterId: profile, scope, sessionId: 's-' + profile})});
  const heartbeat = members => connections.ingest({updated: time, profiles: members});
  const step = async (ms = 600) => { time += ms; await connections.maintain(); await flush(); };
  const roles = () => connections.plan().map(spec => [spec.profile, spec.role]);
  return {connections, live, warms, closed, heartbeat, step, roles};
}

test('a partner keeps the connection its conversation opened: no second connection, no close in between', async () => {
  const f = fixture(); f.heartbeat(['alex']);
  // The conversation with a world character (the request target) opens its private connection.
  await f.connections.setRequest({profileKey: 'dex'});
  for (let i = 0; i < 4; i++) await f.step();
  assert.deepEqual(f.warms.filter(identity => identity === connectionKey('dex', 'private')).length, 1);
  // The game lists it as a partner while talking; then the request ends (the next one is someone else's).
  await f.connections.setPartners(['dex']);
  await f.connections.setRequest(null);
  for (let i = 0; i < 6; i++) await f.step();
  assert.deepEqual(f.roles(), [['alex', 'party'], ['dex', 'partner']]);
  assert.equal(f.warms.filter(identity => identity === connectionKey('dex', 'private')).length, 1, 'a second connection was opened');
  assert(!f.closed.includes(connectionKey('dex', 'private')), 'the conversation connection was closed and reopened');
  // Released by the game: the page closes.
  await f.connections.setPartners([]);
  assert(!f.live.has(connectionKey('dex', 'private')));
});

test('partners rank below the party and the current target and above nearby characters; the total stays bounded', async () => {
  const f = fixture(); f.heartbeat(['alex']);
  await f.connections.setNearby(['nora', 'otto']);
  await f.connections.setPartners(['dex', 'eve', 'fay']);
  assert.equal(PARTNER_LIMIT, 2); assert.equal(NEARBY_LIMIT, 2);
  assert.deepEqual(f.roles(), [['alex', 'party'], ['dex', 'partner'], ['eve', 'partner'], ['nora', 'nearby'], ['otto', 'nearby']]);
  // A partner who is also the current target keeps the stronger role; a party member stays party.
  await f.connections.setComposer({scope: 'private', audience: ['eve']});
  assert.deepEqual(f.roles().find(([profile]) => profile === 'eve'), ['eve', 'target']);
  await f.connections.setPartners(['alex']);
  assert.deepEqual(f.roles().filter(([profile]) => profile === 'alex'), [['alex', 'party']]);
  // A full party: all eight private connections stay; partners and nearby share what is left.
  const full = fixture(); full.heartbeat(party);
  await full.connections.setPartners(['dex', 'eve']); await full.connections.setNearby(['nora', 'otto']);
  const specs = full.connections.plan();
  for (const member of party) assert(specs.some(spec => spec.profile === member && spec.role === 'party'));
  assert(specs.length <= CONNECTION_LIMIT);
  assert.deepEqual(specs.filter(spec => spec.role === 'partner').map(spec => spec.profile), ['dex', 'eve']);
  assert.deepEqual(specs.filter(spec => spec.role === 'nearby').map(spec => spec.profile), ['nora']);
  assert.throws(() => f.connections.setPartners(['bad/key']), /Invalid conversation partners/);
  // A stale party heartbeat drops partners like nearby characters.
  assert.deepEqual(f.connections.diagnostic().partners, ['alex']);
});

test('the published partners are applied before the nearby list and their voices are prepared first', async () => {
  let time = 1_000_000;
  const calls = [], voices = [];
  const connections = {setNearby: async profiles => { calls.push(['nearby', ...profiles]); },
    setPartners: async profiles => { calls.push(['partners', ...profiles]); }};
  const warm = new NearbyWarm({connections, now: () => time, isKnown: profile => profile !== 'stranger',
    prepareVoice: async profile => { voices.push(profile); }});
  // A character listed in both is only a partner (one owner).
  await warm.apply(JSON.stringify({updated: time, profiles: ['nora', 'dex'], partners: ['dex']}));
  assert.deepEqual(calls, [['partners', 'dex'], ['nearby', 'nora']]);
  assert.deepEqual(voices, ['dex'], 'the partner voice first, one at a time');
  await flush(); await warm.apply(JSON.stringify({updated: time, profiles: ['nora', 'dex'], partners: ['dex']}));
  assert.deepEqual(voices, ['dex', 'nora']);
  assert.deepEqual(warm.diagnostic().partners, ['dex']);
  // Validation: an older document has no partners; too many, invalid or stale ones are refused.
  const now = 5000;
  assert.deepEqual(parsePartners({updated: now, profiles: []}, {now}), []);
  assert.deepEqual(parsePartners({updated: now, partners: ['a', 'b', 'c']}, {now}), []);
  assert.deepEqual(parsePartners({updated: now, partners: ['bad/key']}, {now}), []);
  assert.deepEqual(parsePartners({updated: now - 9000, partners: ['a']}, {now}), []);
  assert.deepEqual(parsePartners({updated: now, partners: ['stranger', 'a']}, {now, isKnown: p => p !== 'stranger'}), ['a']);
  // A lost game releases partners too.
  time += 60_000; await warm.apply(JSON.stringify({updated: 1_000_000, profiles: ['nora'], partners: ['dex']}));
  assert.deepEqual(calls.at(-2), ['partners']); assert.deepEqual(calls.at(-1), ['nearby']);
  await warm.release(); assert.deepEqual(warm.diagnostic(), {profiles: [], partners: [], voices: {}});
});
