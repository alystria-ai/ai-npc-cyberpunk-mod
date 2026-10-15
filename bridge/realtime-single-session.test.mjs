import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RealtimeHost} from './realtime-host.mjs';

// A player's own free Convai key allows one conversation connection at a time (docs/OWN_CONVAI_KEY.md).
const pool = keys => {
  const discarded = [];
  return {discarded, entries: new Map(keys.map(key => [key, {key}])), discardIdle: async key => { discarded.push(key); }};
};

test('while single-session, a request first closes the other idle connections here and in the peer host', async () => {
  const peer = new RealtimeHost({}); peer.pool = pool(['peer-a']);
  let single = true;
  const host = new RealtimeHost({exclusive: {enabled: () => single, peers: () => [peer], retryMs: 1}});
  host.pool = pool(['mine', 'other']);
  await host.yieldOtherSessions('mine');
  assert.deepEqual(host.pool.discarded, ['other']);
  assert.deepEqual(peer.pool.discarded, ['peer-a']);
  single = false;
  await host.yieldOtherSessions('mine');
  assert.deepEqual(host.pool.discarded, ['other'], 'nothing is closed on the shared key');
  await new RealtimeHost({}).yieldOtherSessions('x');
});

// A paid Gamer plan on the player's key allows six connections (docs/CONVAI_PAID_TIER.md): only the excess is closed,
// least recently used first, never a busy connection, never the requested one.
const timedPool = rows => {
  const discarded = [];
  return {discarded, entries: new Map(rows.map(([key, used, busy = false]) => [key, {key, used, busy}])),
    discardIdle: async key => { const entry = rows.find(row => row[0] === key); if (entry?.[2]) return false; discarded.push(key); return true; }};
};

test('with a limit of six, a request closes only the idle connections beyond the cap, oldest first', async () => {
  const peer = new RealtimeHost({}); peer.pool = timedPool([['peer-a', 1], ['peer-b', 7]]);
  let limit = 6;
  const host = new RealtimeHost({exclusive: {enabled: () => true, limit: () => limit, peers: () => [peer], retryMs: 1}});
  host.pool = timedPool([['mine', 0], ['b', 3, true], ['c', 4], ['d', 5]]);
  await host.yieldOtherSessions('mine');
  assert.deepEqual([...host.pool.discarded, ...peer.pool.discarded], [], 'mine plus five others fit under six');
  host.pool.entries.set('f', {key: 'f', used: 8});
  await host.yieldOtherSessions('mine');
  assert.deepEqual(peer.pool.discarded, ['peer-a'], 'the least recently used idle connection goes');
  assert.deepEqual(host.pool.discarded, []);
  limit = 3;
  peer.pool.entries.delete('peer-a');
  await host.yieldOtherSessions('mine');
  assert.deepEqual(host.pool.discarded, ['c', 'd'], 'the busy one stays even when it is the oldest');
  assert.deepEqual(peer.pool.discarded, ['peer-a', 'peer-b'], 'peers count toward the same cap');
  for (const broken of [() => { throw Error('plan'); }, () => NaN, () => 0]) {
    const one = new RealtimeHost({exclusive: {enabled: () => true, limit: broken, peers: () => [], retryMs: 1}});
    one.pool = timedPool([['mine', 0], ['x', 1], ['y', 2]]);
    await one.yieldOtherSessions('mine');
    assert.deepEqual(one.pool.discarded, ['x', 'y'], 'a broken limit means one connection');
  }
});

test('a concurrency-limit answer is retried once while single-session, never otherwise', async () => {
  for (const [single, expectedCalls] of [[true, 2], [false, 1]]) {
    let calls = 0;
    const host = new RealtimeHost({exclusive: {enabled: () => single, peers: () => [], retryMs: 1}});
    host.runOnce = async () => { calls++; throw Error('Concurrency limit reached'); };
    await assert.rejects(host.run({}, 'reply'), /Concurrency limit/);
    assert.equal(calls, expectedCalls);
  }
  let calls = 0;
  const host = new RealtimeHost({exclusive: {enabled: () => true, peers: () => [], retryMs: 1}});
  host.runOnce = async () => { if (++calls === 1) throw Error('Concurrency limit reached'); return {text: 'ok'}; };
  assert.deepEqual(await host.run({}, 'reply'), {text: 'ok'});
  host.runOnce = async () => { throw Error('HTTP 500'); };
  calls = 0;
  await assert.rejects(host.run({}, 'reply'), /HTTP 500/);
});

test('an aborted request is not retried', async () => {
  let calls = 0;
  const controller = new AbortController();
  const host = new RealtimeHost({exclusive: {enabled: () => true, peers: () => [], retryMs: 1}});
  host.runOnce = async () => { calls++; controller.abort(); throw Error('Concurrency limit reached'); };
  await assert.rejects(host.run({}, 'reply', {signal: controller.signal}), /Concurrency limit/);
  assert.equal(calls, 1);
});

test('only a finished reply counts as a success; failures reach the observer; an observer cannot fail a reply', async () => {
  const seen = {success: 0, failures: []};
  const host = new RealtimeHost({onSuccess: () => { seen.success++; }, onFailure: error => seen.failures.push(error.message)});
  host.runOnce = async () => ({text: 'ok'});
  await host.run({}, 'reply'); assert.equal(seen.success, 1);
  await host.run({}, 'warm'); assert.equal(seen.success, 1, 'opening a connection proves nothing about the plan');
  host.runOnce = async () => { throw Error('Convai usage limit reached [convai-quota:interaction]'); };
  await assert.rejects(host.run({}, 'reply'));
  assert.deepEqual(seen.failures, ['Convai usage limit reached [convai-quota:interaction]']);
  const careless = new RealtimeHost({onSuccess: () => { throw Error('observer'); }, onFailure: () => { throw Error('observer'); }});
  careless.runOnce = async () => ({text: 'ok'});
  assert.deepEqual(await careless.run({}, 'reply'), {text: 'ok'});
  careless.runOnce = async () => { throw Error('real failure'); };
  await assert.rejects(careless.run({}, 'reply'), /real failure/);
});

test('a recover hook gets one changed attempt after a failure; its change is what runs again', async () => {
  const seen = [];
  const host = new RealtimeHost({recover: (error, config) => { seen.push(error.message); return config.endUserId ? {...config, endUserId: undefined} : undefined; }});
  const attempts = [];
  host.runOnce = async config => {
    attempts.push(config.endUserId ?? null);
    if (config.endUserId) throw Error('LTM speaker limit reached');
    return {text: 'ok'};
  };
  assert.deepEqual(await host.run({endUserId: 'user-1'}, 'reply'), {text: 'ok'});
  assert.deepEqual(attempts, ['user-1', null]);
  assert.deepEqual(seen, ['LTM speaker limit reached']);
});

test('recover that changes nothing, or keeps failing, ends in the original failure after bounded attempts', async () => {
  let calls = 0;
  const unchanged = new RealtimeHost({recover: () => undefined});
  unchanged.runOnce = async () => { calls++; throw Error('first failure'); };
  await assert.rejects(unchanged.run({}, 'reply'), /first failure/); assert.equal(calls, 1);
  calls = 0;
  const looping = new RealtimeHost({recover: config => ({...config})});
  looping.runOnce = async () => { calls++; throw Error(`failure ${calls}`); };
  await assert.rejects(looping.run({}, 'reply'), /failure 3/); assert.ok(calls <= 3, `${calls} attempts`);
  // A throwing hook never hides the real failure.
  const throwing = new RealtimeHost({recover: () => { throw Error('hook'); }});
  throwing.runOnce = async () => { throw Error('real'); };
  await assert.rejects(throwing.run({}, 'reply'), /real/);
});

test('the final outcome after recovery reaches the observers once', async () => {
  const seen = {success: 0, failures: []};
  const host = new RealtimeHost({recover: config => ({...config, endUserId: undefined}),
    onSuccess: () => { seen.success++; }, onFailure: error => seen.failures.push(error.message)});
  host.runOnce = async config => { if (config.endUserId) throw Error('LTM speaker limit reached'); return {text: 'ok'}; };
  await host.run({endUserId: 'user-1'}, 'reply');
  assert.deepEqual(seen, {success: 1, failures: []}, 'the recovered refusal is not a failure');
});

test('an async recover hook is awaited, and a rejecting one never hides the real failure', async () => {
  const host = new RealtimeHost({recover: async (error, config) => { await new Promise(resolve => setTimeout(resolve, 5)); return {...config, endUserId: 'adopted'}; }});
  const attempts = [];
  host.runOnce = async config => { attempts.push(config.endUserId); if (config.endUserId !== 'adopted') throw Error('LTM speaker limit reached'); return {text: 'ok'}; };
  assert.deepEqual(await host.run({endUserId: 'user-1'}, 'reply'), {text: 'ok'});
  assert.deepEqual(attempts, ['user-1', 'adopted']);
  const rejecting = new RealtimeHost({recover: async () => { throw Error('hook'); }});
  rejecting.runOnce = async () => { throw Error('real'); };
  await assert.rejects(rejecting.run({}, 'reply'), /real/);
});
