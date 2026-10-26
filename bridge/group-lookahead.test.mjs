import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GroupLookahead, BufferedPcm, AheadOwner, lookaheadAllowed, turnKey, validateLookahead, waitUntil} from './group-lookahead.mjs';
import {parseInput} from './protocol.mjs';

const first = {requestId: '100-1-1ULL', generation: 1, entity: '1ULL', name: 'Judy', bodyType: 'female', profileKey: 'judy', text: 'Hello',
  group: {id: 'round-1', index: 1, total: 3, audience: ['judy', 'panam', 'alex'], heard: []}};
const second = {...first, requestId: '100-2-2ULL', generation: 2, entity: '2ULL', name: 'Panam', profileKey: 'panam',
  group: {...first.group, index: 2, heard: [{speaker: 'Judy', text: 'Hey V.'}]}};
const command = {sourceRequestId: first.requestId, input: second};
const live = () => true;
const source = (extra = {}) => ({input: first, text: 'Hey V.', current: async () => true, ...extra});
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return {promise, resolve, reject}; };
const flush = () => new Promise(done => setImmediate(done));

test('the turn key ignores the knowledge snapshots the game recaptures at submission', () => {
  const parsed = parseInput(JSON.stringify(second));
  const resubmitted = parseInput(JSON.stringify({...second, sentAt: 999, journalHistory: undefined}));
  assert.equal(turnKey(parsed), turnKey(resubmitted));
  // The retired follow-up field from an older adapter is dropped, not part of the turn.
  assert.equal(turnKey(parseInput(JSON.stringify({...second, followUpQuestions: true}))), turnKey(parsed));
  for (const change of [{text: 'other'}, {generation: 3, requestId: '100-3-2ULL'}, {profileKey: 'alex'}, {entity: '3ULL', requestId: '100-2-3ULL'},
    {group: {...second.group, heard: [{speaker: 'Judy', text: 'changed'}]}}, {group: {...second.group, audience: ['panam', 'judy']}},
    {name: 'Someone'}]) {
    assert.notEqual(turnKey(parseInput(JSON.stringify({...second, ...change}))), turnKey(parsed), JSON.stringify(change));
  }
});

test('the prediction must follow the live source reply; a microphone source answers its recognized transcript', () => {
  assert.ok(validateLookahead(command, source()));
  assert.equal(validateLookahead(command, null), null);
  assert.equal(validateLookahead(command, {input: first, text: 'Hey V.'}), null, 'a source with no ownership check is refused');
  assert.equal(validateLookahead(command, source({text: 'different words'})), null);
  assert.equal(validateLookahead({...command, sourceRequestId: 'old'}, source()), null);
  const microphone = {input: {...first, text: '[Microphone]'}, userText: 'Hello', current: async () => true, text: 'Hey V.'};
  assert.ok(validateLookahead(command, microphone));
  assert.equal(validateLookahead({...command, input: {...second, text: 'invented'}}, microphone), null);
});

function fixture() {
  let clock = 1000; const started = [];
  const lookahead = new GroupLookahead({now: () => clock, maxHoldMs: 5000,
    start: entry => { const request = {input: entry.input, owner: entry.owner, controller: entry.controller, entry}; started.push(request); return request; }});
  return {lookahead, started, tick: ms => { clock += ms; }};
}

test('a held turn is offered once, claimed by the identical submission and then owned by the submitted file', async () => {
  const f = fixture(), predicted = parseInput(JSON.stringify(second));
  const entry = f.lookahead.offer(predicted);
  assert.equal(f.lookahead.offer(parseInput(JSON.stringify(second))), entry);
  assert.equal(f.started.length, 1); assert.equal(f.lookahead.busy, true); assert.equal(entry.isHeld(), true);
  assert.equal(await entry.owner.current(), true);
  let released = false; entry.waitClaimed().then(() => { released = true; }); await flush(); assert.equal(released, false);
  f.tick(1500);
  const file = {current: async () => true};
  const request = f.lookahead.claim(parseInput(JSON.stringify({...second, sentAt: 5, worldKnowledge: undefined})), file);
  assert.equal(request, f.started[0]); assert.equal(request.receivedAt, 2500);
  await flush(); assert.equal(released, true);
  assert.equal(entry.isHeld(), false); assert.equal(f.lookahead.busy, false);
  assert.equal(await entry.owner.current(), true);
  file.current = async () => false; assert.equal(await entry.owner.current(), false);
  const stats = f.lookahead.stats(entry); assert.equal(stats.holdMs, 1500);
});

test('a different submission cancels the held turn: new message, other speaker or changed audience', async () => {
  for (const change of [{text: 'a new message'}, {profileKey: 'alex', requestId: '100-2-2ULL'},
    {group: {...second.group, audience: ['judy', 'panam']}}]) {
    const f = fixture(), entry = f.lookahead.offer(parseInput(JSON.stringify(second)));
    const rejection = assert.rejects(entry.waitClaimed(), {name: 'AbortError'});
    assert.equal(f.lookahead.claim(parseInput(JSON.stringify({...second, ...change})), {current: live}), null);
    await rejection;
    assert.equal(entry.controller.signal.aborted, true); assert.equal(entry.state, 'cancelled');
    assert.equal(await entry.owner.current(), false); assert.equal(f.lookahead.busy, false);
  }
});

test('cancel, replacement, failure and expiry retire the held turn without leaving a claimable entry', async () => {
  const f = fixture();
  const a = f.lookahead.offer(parseInput(JSON.stringify(second)));
  const other = parseInput(JSON.stringify({...second, requestId: '100-3-2ULL', generation: 3}));
  const b = f.lookahead.offer(other);
  assert.equal(a.state, 'cancelled'); assert.equal(a.controller.signal.aborted, true); assert.notEqual(a, b);
  f.lookahead.fail(b); assert.equal(b.state, 'failed'); assert.equal(b.controller.signal.aborted, true);
  assert.equal(f.lookahead.claim(other, {current: live}), null, 'a failed look-ahead is never adopted');
  const c = f.lookahead.offer(other); f.tick(5001); f.lookahead.prune();
  assert.equal(c.state, 'cancelled'); assert.equal(f.lookahead.busy, false);
  const d = f.lookahead.offer(other); assert.equal(f.lookahead.cancel(), true); assert.equal(d.state, 'cancelled');
  assert.equal(f.lookahead.cancel(), false);
  await assert.rejects(d.waitClaimed(), {name: 'AbortError'});
});

test('a claimed turn can no longer be cancelled as a look-ahead; its own controller owns it', () => {
  const f = fixture(), entry = f.lookahead.offer(parseInput(JSON.stringify(second)));
  f.lookahead.claim(parseInput(JSON.stringify(second)), {current: live});
  assert.equal(f.lookahead.cancel(), false); assert.equal(entry.controller.signal.aborted, false);
  f.lookahead.fail(entry); assert.equal(entry.state, 'claimed');
});

test('the held owner is true while held, follows the file after the claim and false once retired', async () => {
  const owner = new AheadOwner();
  assert.equal(await owner.current(), true);
  owner.bind({current: async () => true}); assert.equal(await owner.current(), true);
  owner.retire(); assert.equal(await owner.current(), false);
});

test('waitUntil polls, times out and honours cancellation', async () => {
  let ready = false; const waiting = waitUntil(() => ready, {pollMs: 5});
  await new Promise(done => setTimeout(done, 20)); ready = true; assert.equal(await waiting, true);
  assert.equal(await waitUntil(() => false, {pollMs: 5, timeoutMs: 20}), false);
  const controller = new AbortController(), pending = waitUntil(() => false, {pollMs: 5, signal: controller.signal});
  controller.abort(); await assert.rejects(pending, {name: 'AbortError'});
  await assert.rejects(waitUntil(() => false, {signal: AbortSignal.abort()}), {name: 'AbortError'});
});

const packet = (index, at) => ({index, offsetFrames: at, frames: 4, pcm: Float32Array.from([at, at + 1, at + 2, at + 3])});

test('buffered Pocket PCM is owned, drained in order, then continues live without gaps or repeats', async () => {
  const gate = deferred(), shared = new Float32Array(4);
  const synth = new BufferedPcm({synthesize: async (onPcm) => {
    for (const at of [0, 4]) { shared.set([at, at + 1, at + 2, at + 3]); await onPcm({index: at / 4 + 1, offsetFrames: at, frames: 4, pcm: shared}); }
    await gate.promise;
    await onPcm(packet(3, 8)); await onPcm(packet(4, 12));
    return {frames: 16};
  }});
  synth.start(); await flush();
  assert.equal(synth.packets.length, 2); assert.equal(synth.frames, 8);
  assert.deepEqual([...synth.packets[0].pcm], [0, 1, 2, 3], 'the worker reusing its sample buffer cannot change buffered audio');
  const seen = []; const drained = synth.drain(async value => { seen.push(value.index); await flush(); });
  await flush(); gate.resolve();
  assert.deepEqual(await drained, {frames: 16});
  assert.deepEqual(seen, [1, 2, 3, 4]);
});

test('buffered synthesis stops when its turn is cancelled or its playback ends early', async () => {
  const parent = new AbortController(); let signal;
  const synth = new BufferedPcm({signal: parent.signal, synthesize: (onPcm, options) => new Promise((_, reject) => {
    signal = options.signal; signal.addEventListener('abort', () => reject(Error('stopped')), {once: true});
  })});
  const done = synth.start(); await flush(); parent.abort();
  await assert.rejects(done, /stopped/); assert.equal(signal.aborted, true);
  const local = new AbortController(); let second;
  const other = new BufferedPcm({synthesize: (onPcm, options) => new Promise((_, reject) => {
    second = options.signal; second.addEventListener('abort', () => reject(Error('playback ended')), {once: true});
  })});
  other.start(); const draining = other.drain(async () => {}, {signal: local.signal}); await flush(); local.abort();
  await assert.rejects(draining, /playback ended/); assert.equal(second.aborted, true);
  const pending = new BufferedPcm({synthesize: () => new Promise(() => {})});
  pending.start(); pending.packets.push({}); pending.discard(); assert.equal(pending.packets.length, 0);
  assert.equal(pending.controller.signal.aborted, true);
});

test('a source mismatch produces no turn and no held entry', () => {
  const f = fixture();
  assert.equal(validateLookahead({...command, input: {...second, group: {...second.group, id: 'other'}}}, source()), null);
  assert.equal(f.lookahead.busy, false);
});

// Seen live on 2026-10-17: a player's own key on a confirmed paid plan (six connections) ran every group speaker change serially,
// because the bridge turned look-ahead off for any player's key. The gate is the connections the plan allows, not whose key it is.
test('look-ahead runs on the shared key and on a player key whose plan holds two or more connections, never on one', () => {
  assert.equal(lookaheadAllowed({singleSession: false}), true, 'the shared key');
  assert.equal(lookaheadAllowed(), true, 'the default is the shared key');
  assert.equal(lookaheadAllowed({singleSession: true, connectionLimit: 6}), true, 'a confirmed paid plan');
  assert.equal(lookaheadAllowed({singleSession: true, connectionLimit: 2}), true);
  assert.equal(lookaheadAllowed({singleSession: true, connectionLimit: 1}), false, 'a free, unknown or unread plan holds one connection');
  assert.equal(lookaheadAllowed({singleSession: true}), false, 'no limit known counts as one');
  for (const limit of [0, -1, NaN, undefined, null, '6']) {
    assert.equal(lookaheadAllowed({singleSession: true, connectionLimit: limit}), false, 'not a usable limit: ' + String(limit));
  }
  assert.equal(lookaheadAllowed({singleSession: false, textProvider: true}), false, 'Mistral or the local AI: no Convai connection to run ahead on');
  assert.equal(lookaheadAllowed({singleSession: true, connectionLimit: 6, textProvider: true}), false);
});

// A character another mod or a spawner created speaks under a roster profile like any other (docs/SPAWNED_CHARACTERS.md): the bridge
// sees an entity id and a profile key, so the next speaker being such a character, or the one being heard, changes nothing here.
test('a prediction for a spawned character as the next speaker, or after one, is validated and held like any other', () => {
  const spawnedEntity = '4294967295ULL';
  const spawnedSecond = {...second, entity: spawnedEntity, requestId: '100-2-' + spawnedEntity};
  assert.ok(validateLookahead({sourceRequestId: first.requestId, input: spawnedSecond}, source()), 'the next speaker is the spawned one');
  const spawnedFirst = {...first, entity: spawnedEntity, requestId: '100-1-' + spawnedEntity};
  assert.ok(validateLookahead({sourceRequestId: spawnedFirst.requestId, input: second}, source({input: spawnedFirst})), 'the speaker heard is the spawned one');
  const f = fixture();
  const entry = f.lookahead.offer(parseInput(JSON.stringify(spawnedSecond)));
  assert.equal(f.lookahead.busy, true); assert.equal(entry.isHeld(), true);
  const claimed = f.lookahead.claim(parseInput(JSON.stringify(spawnedSecond)), {current: async () => true});
  assert.ok(claimed, 'the identical submission claims it'); assert.equal(f.lookahead.busy, false);
});

// Performance: the 60 ms look-ahead poll now runs for the text providers too; it must not read an unchanged file 17 times a second.
test('the prediction file is read when it changed, not on every poll', async () => {
  const {createStatCachedReader} = await import('./group-lookahead.mjs');
  let stats = 0, reads = 0, info = {mtimeMs: 1000.5, size: 2}, body = '{}', missing = false, failRead = false;
  const read = createStatCachedReader({
    stat: async () => { stats += 1; if (missing) throw new Error('ENOENT'); return {...info}; },
    read: async () => { reads += 1; if (failRead) throw new Error('EBUSY'); return body; },
  });
  for (let index = 0; index < 50; index += 1) assert.equal(await read('f'), '{}');
  assert.equal(stats, 50); assert.equal(reads, 1, 'an unchanged file was read ' + reads + ' times');
  // the game wrote a command: a new modification time and size
  body = '{"kind":"ahead"}'; info = {mtimeMs: 1100.25, size: 16};
  assert.equal(await read('f'), '{"kind":"ahead"}'); assert.equal(await read('f'), '{"kind":"ahead"}'); assert.equal(reads, 2);
  // the same size written again later is a change too (the time moved)
  body = '{"kind":"hehad"}'; info = {mtimeMs: 1200.75, size: 16};
  assert.equal(await read('f'), '{"kind":"hehad"}'); assert.equal(reads, 3);
  // a failed read says '' and is not remembered: the next poll reads again
  body = 'ok'; info = {mtimeMs: 1300, size: 2}; failRead = true;
  assert.equal(await read('f'), ''); failRead = false;
  assert.equal(await read('f'), 'ok'); assert.equal(reads, 5);
  // a missing file is '' and, when it comes back with the old time and size, is read again
  missing = true; assert.equal(await read('f'), ''); missing = false;
  assert.equal(await read('f'), 'ok'); assert.equal(reads, 6);
});

test('the bridge reads the prediction file through the stat-cached reader', async () => {
  const {readFileSync} = await import('node:fs');
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /const readPrefetch = createStatCachedReader\(\{stat, read: path => readFile\(path, 'utf8'\)\}\)/);
  assert.match(bridge, /const raw = await readPrefetch\(prefetchPath\);/);
  assert.doesNotMatch(bridge, /readFile\(prefetchPath/);
});
