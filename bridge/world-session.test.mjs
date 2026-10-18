import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readWorldSession} from './world-session.mjs';

const NOW = 100000;
const ready = {version: 1, token: 'fixture-world', generation: 1, ready: true, updated: NOW};
const missing = () => Object.assign(Error('Windows replacement gap'), {code: 'ENOENT'});
function fixture(values, now = () => NOW) {
  const calls = [], waits = [];
  return {calls, waits, run: () => readWorldSession('fixture-world-session.json', {now,
    read: async (path, encoding) => {
      calls.push([path, encoding]); const value = values[Math.min(calls.length - 1, values.length - 1)];
      if (value instanceof Error) throw value;
      return typeof value === 'string' ? value : JSON.stringify(value);
    }, wait: async ms => { waits.push(ms); }})};
}

test('short missing and partial heartbeat reads recover within two bounded retries', async () => {
  const f = fixture([missing(), '{"version":1,', ready]);
  assert.deepEqual(await f.run(), ready);
  assert.equal(f.calls.length, 3); assert.deepEqual(f.waits, [15, 15]);
});

test('explicit unavailable or changed worlds are returned immediately even after one replacement gap', async () => {
  for (const value of [{...ready, ready: false}, {...ready, token: 'next-world', generation: 2}]) {
    const direct = fixture([value]); assert.deepEqual(await direct.run(), value);
    assert.equal(direct.calls.length, 1); assert.deepEqual(direct.waits, []);
    const afterGap = fixture([missing(), value]); assert.deepEqual(await afterGap.run(), value);
    assert.equal(afterGap.calls.length, 2); assert.deepEqual(afterGap.waits, [15]);
  }
});

test('unreadable heartbeats fail closed after 30ms and never restore a previous world', async () => {
  for (const failure of [missing(), '{']) {
    const f = fixture([failure]); assert.equal(await f.run(), null);
    assert.equal(f.calls.length, 3); assert.deepEqual(f.waits, [15, 15]);
  }
  const permission = fixture([Object.assign(Error('Denied'), {code: 'EACCES'})]);
  assert.equal(await permission.run(), null); assert.equal(permission.calls.length, 1);
  assert.deepEqual(permission.waits, []);
});

test('expired, future and invalid leases fail closed without retrying valid JSON', async () => {
  for (const value of [{...ready, updated: NOW - 5000}, {...ready, updated: NOW + 1001},
    {...ready, generation: 0}, {...ready, ready: 'true'}, null]) {
    const f = fixture([value]); assert.equal(await f.run(), null);
    assert.equal(f.calls.length, 1); assert.deepEqual(f.waits, []);
  }
  let now = NOW;
  const f = fixture([missing(), ready], () => { now += 5000; return now; });
  assert.equal(await f.run(), null, 'age is checked after successful retry, not before the read');
});

test('bridge world polling uses the bounded reader before evaluating reset ownership', () => {
  const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  const poll = source.slice(source.indexOf('async function pollKnowledge()'), source.indexOf('// An existing request belongs'));
  assert.match(poll, /await readWorldSession\(resolve\(runtime, 'world-session\.json'\)\)/);
  assert.doesNotMatch(poll, /readFile\(resolve\(runtime, 'world-session\.json'/);
  assert.match(poll, /priorWorld && priorWorld !== nextWorld/);
  assert.match(poll, /await resetLiveRoutes\(\)/);
});

test('an empty heartbeat file (the shipped placeholder) means no session yet and returns at once, with no retry', async () => {
  const empty = fixture(['']);
  assert.equal(await empty.run(), null);
  assert.equal(empty.calls.length, 1); assert.deepEqual(empty.waits, []);
  const spaces = fixture([' ']); assert.equal(await spaces.run(), null);
  assert.equal(spaces.calls.length, 1); assert.deepEqual(spaces.waits, []);
  // a missing or half-written file still gets its bounded retries
  const torn = fixture(['{"version":1,', ready]); assert.deepEqual(await torn.run(), ready);
  assert.deepEqual(torn.waits, [15]);
});
