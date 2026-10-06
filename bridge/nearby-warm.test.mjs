import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NearbyWarm, parseNearby} from './nearby-warm.mjs';
import {NEARBY_LIMIT} from './party-connections.mjs';

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
