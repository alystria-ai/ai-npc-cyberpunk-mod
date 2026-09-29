import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GameLaunchIdentity} from './game-launch.mjs';

test('launch identity is queried once per adapter world and survives save/CET identity changes', async () => {
  let now = 10000, calls = 0;
  const output = [];
  const resolver = new GameLaunchIdentity({now: () => now,
    identify: async () => { calls++; return '42-123456'; }, publish: async v => output.push(v)});
  const state = world => ({active: true, world, updated: now});
  await resolver.update(state('first'));
  now += 10000; await resolver.update(state('first'));
  assert.equal(calls, 1);
  await resolver.update(state('second'));
  assert.equal(calls, 2);
  assert.deepEqual(output.map(v => [v.world, v.launch]), [['first', '42-123456'], ['second', '42-123456']]);
});

test('missing processes retry with a bound; stale/unloaded states cannot authorize erasure', async () => {
  let now = 20000, calls = 0;
  const output = [];
  const resolver = new GameLaunchIdentity({now: () => now, identify: async () => {
    if (++calls === 1) throw Error('Not ready');
    return '43-999999';
  }, publish: async v => output.push(v)});
  const state = () => ({active: true, world: 'new', updated: now});
  await resolver.update(null);
  await resolver.update({...state(), active: false});
  await resolver.update({...state(), updated: 0});
  assert.equal(calls, 0);
  await assert.rejects(resolver.update(state()), /Not ready/);
  now += 100; await resolver.update(state());
  assert.equal(calls, 1); assert.equal(output.length, 0);
  now += 3000; await resolver.update(state());
  assert.equal(output[0].launch, '43-999999');
});

test('a failed identity write is retried instead of being recorded as complete', async () => {
  let now = 10000, writes = 0;
  const resolver = new GameLaunchIdentity({now: () => now, identify: async () => '44-987654',
    publish: async () => { if (++writes === 1) throw Error('Busy'); }});
  const state = {active: true, world: 'new', updated: now};
  await assert.rejects(resolver.update(state), /Busy/);
  now += 3000; await resolver.update({...state, updated: now});
  assert.equal(writes, 2); assert.equal(resolver.world, 'new');
});
