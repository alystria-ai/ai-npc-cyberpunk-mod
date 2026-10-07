import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GroupPrefetch, inputIdentity, validatePrefetch, parsePrewarm} from './group-prefetch.mjs';

const first = {requestId: '100-1-1ULL', generation: 1, entity: '1ULL', name: 'Judy', bodyType: 'female', profileKey: 'judy', text: 'Hello',
  group: {id: 'round-1', index: 1, total: 3, audience: ['judy', 'panam', 'alex'], heard: []}};
const second = {...first, requestId: '100-2-2ULL', generation: 2, entity: '2ULL', name: 'Panam', profileKey: 'panam',
  group: {...first.group, index: 2, heard: [{speaker: 'Judy', text: 'Hey V.'}]}};
const command = {sourceRequestId: first.requestId, input: second};
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return {promise, resolve, reject}; };

test('composer warming accepts only bounded configured audience hints and separates private scope', () => {
  const ids = {judy: 'one', panam: 'two', alex: 'three'};
  assert.equal(parsePrewarm({nonce: 'open-1', group: true, audience: ['panam', 'judy']}, ids).scope, 'group:judy,panam');
  assert.equal(parsePrewarm({nonce: 'open-2', group: false, audience: ['judy']}, ids).scope, 'private');
  for (const hint of [{}, {nonce: '', group: true, audience: ['judy']},
    {nonce: 'x', group: false, audience: ['judy', 'panam']}, {nonce: 'x', group: true, audience: ['unknown']},
    {nonce: 'x', group: true, audience: ['judy', 'judy']}, {nonce: 'x', group: true, audience: ['judy', 'panam', 'alex', 'judy']}]) {
    assert.equal(parsePrewarm(hint, ids), null);
  }
});

test('a prediction requires the published source, same round and audience, and the source reply as heard', () => {
  const source = {input: first, text: 'Hey V.'};
  assert.ok(validatePrefetch(command, source));
  for (const bad of [
    {...command, sourceRequestId: 'old'},
    {...command, input: {...second, group: {...second.group, id: 'other'}}},
    {...command, input: {...second, group: {...second.group, audience: ['judy', 'panam']}}},
    {...command, input: {...second, group: {...second.group, heard: []}}},
    {...command, input: {...second, group: {...second.group, heard: [{speaker: 'Judy', text: 'invented'}]}}},
    {...command, input: {...second, text: 'different request'}},
  ]) assert.equal(validatePrefetch(bad, source), null);
  // An older adapter may still send the retired follow-up field; it is ignored.
  const legacy = validatePrefetch({...command, input: {...second, followUpQuestions: true}}, source);
  assert.ok(legacy); assert.equal('followUpQuestions' in legacy, false);
});

test('cache identity includes entity, generation, speaker, body, exact heard text and backend context', () => {
  const identity = inputIdentity(second, 'context');
  for (const changed of [
    {...second, requestId: '101-3-2ULL', generation: 3},
    {...second, requestId: '100-2-3ULL', entity: '3ULL'},
    {...second, profileKey: 'alex'}, {...second, name: 'other'}, {...second, bodyType: 'other'}, {...second, text: 'changed'},
    {...second, group: {...second.group, heard: [{speaker: 'Judy', text: 'not delivered'}]}},
    {...second, group: {...second.group, audience: ['panam', 'judy', 'alex']}},
  ]) assert.notEqual(inputIdentity(changed, 'context'), identity);
  assert.notEqual(inputIdentity(second, 'new session'), identity);
});

test('ready prediction stays unpublished until an exact submitted input claims it', async () => {
  let clock = 10, calls = 0;
  const cache = new GroupPrefetch({now: () => clock, prepare: async () => { calls++; return {text: 'prepared', sessionID: 'isolated'}; }});
  cache.published(first, 'Hey V.');
  const offered = cache.offer(command, 'full-context');
  assert.equal(cache.offer(command, 'full-context'), offered);
  await offered.promise; assert.equal(calls, 1);
  assert.equal(cache.source.input.requestId, first.requestId); // Preparation does not commit a new source/session.
  clock = 200;
  const result = await cache.claim({...second, sentAt: 100}, 'full-context');
  assert.equal(result.text, 'prepared'); assert.equal(result.preparation.readyOnClaim, true);
  assert.equal(result.preparation.remainingWaitMs, 0);
  assert.equal(cache.claim(second, 'full-context'), null);
});

test('changed listeners or failed playback discard a ready prediction', async () => {
  const cache = new GroupPrefetch({prepare: async () => ({text: 'discard me'})});
  cache.published(first, 'Hey V.'); const offered = cache.offer(command);
  await offered.promise;
  assert.equal(cache.claim({...second, group: {...second.group, heard: []}}), null);
  assert.equal(offered.controller.signal.aborted, true);
});

test('cancelling a pending prediction aborts it and ignores a late response', async () => {
  const pending = deferred(); let signal;
  const cache = new GroupPrefetch({prepare: async (_input, options) => { signal = options.signal; return pending.promise; }});
  cache.published(first, 'Hey V.'); const entry = cache.offer(command); await Promise.resolve();
  cache.invalidate(); assert.equal(signal.aborted, true);
  pending.resolve({text: 'late'}); await entry.promise;
  assert.equal(cache.claim(second), null);
});

test('claim adopts in-flight preparation; clearing the preview does not cancel a submitted turn', async () => {
  const pending = deferred(); let clock = 0;
  const cache = new GroupPrefetch({now: () => clock, prepare: () => pending.promise});
  cache.published(first, 'Hey V.'); const entry = cache.offer(command); await Promise.resolve();
  clock = 2000; const claim = cache.claim(second);
  cache.invalidate(); assert.equal(entry.controller.signal.aborted, false);
  clock = 2400; pending.resolve({text: 'ready'});
  const result = await claim;
  assert.equal(result.preparation.readyOnClaim, false); assert.equal(result.preparation.remainingWaitMs, 400);
  assert.equal(result.preparation.overlappedMs, 2000);
});

test('superseding an actual claimed request cancels its isolated session', async () => {
  const pending = deferred(), controller = new AbortController();
  const cache = new GroupPrefetch({prepare: () => pending.promise});
  cache.published(first, 'Hey V.'); const entry = cache.offer(command); await Promise.resolve();
  const claim = cache.claim(second, '', {signal: controller.signal}); controller.abort();
  await assert.rejects(claim, {name: 'AbortError'}); assert.equal(entry.controller.signal.aborted, true);
  pending.resolve({text: 'late'});
});

test('expired and failed predictions are not reused; a changed source cancels work', async () => {
  let clock = 0;
  const cache = new GroupPrefetch({now: () => clock, maxAgeMs: 100, prepare: async () => { throw Error('offline'); }});
  cache.published(first, 'Hey V.'); const failed = cache.offer(command);
  await assert.rejects(failed.promise, /offline/);
  await assert.rejects(cache.claim(second), /offline/);
  const expiring = cache.offer(command); clock = 101; cache.prune();
  assert.equal(expiring.controller.signal.aborted, true); assert.equal(cache.claim(second), null);
  clock = 102; const oldSource = cache.offer(command); cache.published(second, 'next');
  assert.equal(oldSource.controller.signal.aborted, true);
});
