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
