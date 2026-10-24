import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readWorldSession, lateWorld, worldBoundary, LATE_WORLD_LIMIT_MS, MIC_LEASE_MS} from './world-session.mjs';

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
  assert.match(poll, /await readWorldSession\(resolve\(runtime, 'world-session\.json'\), \{held: worldSession\?\.ready === true, lapse\}\)/);
  assert.doesNotMatch(poll, /readFile\(resolve\(runtime, 'world-session\.json'/);
  assert.match(poll, /priorWorld && priorWorld !== nextWorld/);
  assert.match(poll, /await resetLiveRoutes\(\)/);
});

test('an empty heartbeat file (the shipped placeholder) means no session yet and returns at once when none was held', async () => {
  const empty = fixture(['']);
  assert.equal(await empty.run(), null);
  assert.equal(empty.calls.length, 1); assert.deepEqual(empty.waits, []);
  const spaces = fixture([' ']); assert.equal(await spaces.run(), null);
  assert.equal(spaces.calls.length, 1); assert.deepEqual(spaces.waits, []);
  // a missing or half-written file still gets its bounded retries
  const torn = fixture(['{"version":1,', ready]); assert.deepEqual(await torn.run(), ready);
  assert.deepEqual(torn.waits, [15]);
});

test('an empty read while a ready session was held gets one 15 ms retry (the truncate-then-write instant), then counts as no session', async () => {
  const run = (values) => { const f = fixture(values); return {f, result: readWorldSession('fixture-world-session.json', {now: () => NOW, held: true,
    read: async (path, encoding) => { f.calls.push([path, encoding]); const value = values[Math.min(f.calls.length - 1, values.length - 1)];
      return typeof value === 'string' ? value : JSON.stringify(value); }, wait: async ms => { f.waits.push(ms); }})}; };
  const recovered = run(['', ready]); assert.deepEqual(await recovered.result, ready);
  assert.equal(recovered.f.calls.length, 2); assert.deepEqual(recovered.f.waits, [15]);
  const stillEmpty = run(['']); assert.equal(await stillEmpty.result, null);
  assert.equal(stillEmpty.f.calls.length, 2); assert.deepEqual(stillEmpty.f.waits, [15]);
});

// ---- a stalled game is a late world, not a changed one -------------------------------------------------------------------------------------------------
// Live 2026-10-24: the game stopped updating for 5.3 s and then for 17 s (its own movement trace has no sample in those spans). The heartbeat expired,
// pollKnowledge read "no world", reset every route and cancelled the player's voice turn with nothing said to the game; the next press found the bridge
// still resetting ("Conversation world changed", shown as "Microphone unavailable").
test('an expired heartbeat is still refused, and handed back as late so the caller can tell a stalled game from a gone world', async () => {
  const late = {...ready, updated: NOW - 17000};
  const lapse = {};
  const f = fixture([late]);
  const result = await readWorldSession('fixture-world-session.json', {now: () => NOW, lapse,
    read: async () => JSON.stringify(late), wait: async () => {}});
  assert.equal(result, null, 'fail closed as before');
  assert.deepEqual(lapse.value, late);
  assert.equal(f.calls.length, 0);
  // an unreadable or invalid file is not "late"
  const invalid = {};
  assert.equal(await readWorldSession('x', {now: () => NOW, lapse: invalid, read: async () => JSON.stringify({...late, generation: 0}), wait: async () => {}}), null);
  assert.equal(invalid.value, undefined);
});

test('a late heartbeat of the same ready world is that world; a different, unavailable or very old one is not', () => {
  const prior = ready;
  const late = {...ready, updated: NOW - 17000};
  assert.equal(lateWorld(late, prior, NOW), late);
  assert.equal(lateWorld({...late, token: 'next-world'}, prior, NOW), null, 'another world is a change');
  assert.equal(lateWorld({...late, generation: 2}, prior, NOW), null);
  assert.equal(lateWorld({...late, ready: false}, prior, NOW), null, 'an explicit unavailable is a change');
  assert.equal(lateWorld(late, {...prior, ready: false}, NOW), null, 'nothing was held');
  assert.equal(lateWorld(late, null, NOW), null);
  assert.equal(lateWorld({...ready, updated: NOW - LATE_WORLD_LIMIT_MS}, prior, NOW), null, 'two minutes late the world is gone');
  assert.equal(lateWorld({...ready, updated: NOW - LATE_WORLD_LIMIT_MS + 1}, prior, NOW)?.token, 'fixture-world');
});

test('the world boundary uses the 5 s lease, and the 30 s lease only for a voice turn that is running', () => {
  const at = ms => ({...ready, updated: NOW - ms});
  assert.deepEqual(worldBoundary(at(4999), false, NOW), {worldToken: 'fixture-world', generation: 1});
  assert.equal(worldBoundary(at(5000), false, NOW), null);
  assert.equal(worldBoundary(at(17000), false, NOW), null, 'a typed turn, a warm-up or a new talk does not run on a stalled game');
  assert.deepEqual(worldBoundary(at(17000), true, NOW), {worldToken: 'fixture-world', generation: 1}, 'a recording rides out a 17 s stall');
  assert.equal(worldBoundary(at(MIC_LEASE_MS), true, NOW), null);
  assert.equal(worldBoundary({...at(100), ready: false}, true, NOW), null, 'an unavailable world is never tolerated');
  assert.equal(worldBoundary(null, true, NOW), null);
});

test('the bridge follows a late world without a reset, lets a recording ride it out, and says so to the game when it ends a turn', () => {
  const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  const poll = source.slice(source.indexOf('async function pollKnowledge()'), source.indexOf('// An existing request belongs'));
  assert.match(poll, /readWorldSession\(resolve\(runtime, 'world-session\.json'\), \{held: worldSession\?\.ready === true, lapse\}\)/);
  assert.match(poll, /lateWorld\(lapse\.value, worldSession\)/);
  assert.match(poll, /priorWorld && priorWorld !== nextWorld/, 'a real change still resets');
  assert.match(source, /const currentBoundary = \(\) => worldBoundary\(worldSession, micTurnRunning\(\)\)/);
  assert.match(source, /micTurnRunning = \(\) => mic\.current !== null/);
  // The two places that end a running turn for its world (the finish and the poll's check) tell the game, and the poll's check allows the long lease for the speech service too.
  assert.match(source, /async function abandonMicrophone\(why\) \{[\s\S]*?micStateLast = \{state: 'error', reason: 'connection', requestId: current\.requestId\};[\s\S]*?await publishMicState\(\)/);
  assert.equal([...source.matchAll(/await abandonMicrophone\(/g)].length, 3);
  assert.match(source, /!await audioReady\(runtime, MIC_LEASE_MS\)\) await abandonMicrophone\(/);
});
