import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSpeechStateReader, audioAvailable} from './speech-state-cache.mjs';

const clock = () => { const state = {time: 1000}; return {state, now: () => state.time}; };

test('cached() reads once while the copy is younger than the limit, fresh() always reads', async () => {
  const c = clock();
  let reads = 0;
  const reader = createSpeechStateReader({now: c.now, maxAgeMs: 1000, read: async () => ({n: ++reads, continuousAvailable: true})});
  assert.equal((await reader.cached()).n, 1);
  c.state.time += 999;
  assert.equal((await reader.cached()).n, 1, 'younger than 1 s: no read');
  c.state.time += 2;
  assert.equal((await reader.cached()).n, 2, 'older: read again');
  assert.equal((await reader.fresh()).n, 3, 'fresh() reads whatever the age');
  c.state.time += 10;
  assert.equal((await reader.cached()).n, 3, 'and its read refreshes the copy');
  assert.equal(reads, 3);
});

test('callers that ask while a read runs share it', async () => {
  let reads = 0, release;
  const gate = new Promise(done => { release = done; });
  const reader = createSpeechStateReader({read: async () => { reads++; await gate; return {ok: true}; }});
  const asks = [reader.cached(), reader.cached(), reader.cached()];
  release();
  assert.deepEqual(await Promise.all(asks), [{ok: true}, {ok: true}, {ok: true}]);
  assert.equal(reads, 1);
});

test('a failed read ({}) is not cached, and the last good copy answers while it is younger than the heartbeat limit', async () => {
  const c = clock();
  const answers = [{continuousAvailable: true, updated: 1}, {}, {}, {}];
  const reader = createSpeechStateReader({now: c.now, read: async () => answers.shift()});
  assert.equal((await reader.cached()).continuousAvailable, true);
  c.state.time += 1500;
  assert.equal((await reader.cached()).continuousAvailable, true, 'the file was being replaced: the good copy stands');
  c.state.time += 4000;
  assert.deepEqual(await reader.cached(), {}, 'older than 5 s: the failure is believed');
  assert.deepEqual(await reader.fresh(), {}, 'fresh() reports what it read');
});

test('an older read that finishes late never replaces a newer copy', async () => {
  const c = clock();
  const gates = [];
  const reader = createSpeechStateReader({now: c.now, read: () => new Promise(done => gates.push(done))});
  const first = reader.fresh();
  c.state.time += 5;
  const second = reader.fresh();
  gates[1]({v: 'new'}); await second;
  gates[0]({v: 'old'}); await first;
  assert.equal(reader.peek().value.v, 'new');
});

test('audioAvailable is the audioReady rule on a state already read', () => {
  assert.equal(audioAvailable({available: true, updated: 10_000}, 14_999), true);
  assert.equal(audioAvailable({available: true, updated: 10_000}, 15_000), false, 'a heartbeat 5 s old is dead');
  assert.equal(audioAvailable({available: false, updated: 10_000}, 10_001), false);
  assert.equal(audioAvailable({}, 10_000), false);
  assert.equal(audioAvailable(undefined, 10_000), false);
});

test('the bridge asks the cached reader on the turn path and the fresh one for receipts and the watchdog', () => {
  const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /const readSpeechStateCached = \(\) => speechStateReader\.cached\(\);/);
  assert.match(source, /audioAvailable\(await readSpeechStateCached\(\)\)/);
  assert.match(source, /\(await readSpeechStateCached\(\)\)\.continuousAvailable !== true\) return whole\(\)/);
  assert.doesNotMatch(source, /SpeechSlots|audioDepot/, 'the Audioware slots (and their fresh read) are gone');
  assert.match(source, /const speech = await readSpeechState\(\);\s*\n\s*if \(speech\.available && Date\.now\(\) - speech\.updated < 5000\) lastAudioHeartbeat/);
});
