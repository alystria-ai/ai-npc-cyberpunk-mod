import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {STAGE_FILE, StageMarker, installStageMarker, markBridgeStage, memoryLine, memorySnapshot, readStageMarker} from './stage-marker.mjs';

const folder = () => mkdtemp(join(tmpdir(), 'stage-marker-'));

// A clock and a timer the test drives by hand.
function fixture(overrides = {}) {
  const state = {time: 1_000_000, timers: [], writes: [], syncWrites: []};
  const marker = new StageMarker({stateDirectory: 'D:\data', pid: 77, now: () => state.time,
    setTimer: (fn, wait) => { const timer = {fn, wait}; state.timers.push(timer); return timer; }, clearTimer: timer => { state.timers = state.timers.filter(item => item !== timer); },
    write: async (path, text) => { state.writes.push(JSON.parse(text)); }, writeSync: (path, text) => { state.syncWrites.push(JSON.parse(text)); }, ...overrides});
  return {state, marker};
}

test('a stage is a name and a time; the ones before it are kept, newest last', () => {
  const {state, marker} = fixture();
  marker.mark('turn.received');
  state.time += 1500; marker.mark('turn.llmSent');
  state.time += 500; marker.mark('microphone.start');
  assert.equal(marker.current.name, 'microphone.start');
  assert.deepEqual(marker.previous.map(row => row.name), ['turn.received', 'turn.llmSent']);
  marker.mark('microphone.start');
  assert.equal(marker.previous.length, 2, 'the same stage again changes nothing');
  marker.mark('not a name with spaces'); marker.mark(42); marker.mark('x'.repeat(60));
  assert.equal(marker.current.name, 'microphone.start', 'only short fixed names are taken');
  for (let index = 0; index < 10; index++) marker.mark(`stage.n${index}`);
  assert.equal(marker.previous.length, 5, 'the list is bounded');
});

test('the file is written at most once a second and only when the stage changed', async () => {
  const {state, marker} = fixture();
  marker.mark('a.one');
  assert.equal(state.timers.length, 1);
  assert.equal(state.timers[0].wait, 0, 'the first write goes out at once');
  await state.timers.shift().fn();
  assert.equal(state.writes.length, 1);
  state.time += 100; marker.mark('a.two'); state.time += 100; marker.mark('a.three');
  assert.equal(state.timers.length, 1, 'two changes inside the gap share one write');
  assert.equal(state.timers[0].wait, 900, "the second waits out the rest of the second");
  state.time += 900; await state.timers.shift().fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.writes.length, 2);
  assert.equal(state.writes[1].stage.name, 'a.three');
  await marker.flush();
  assert.equal(state.writes.length, 2, 'nothing changed, nothing written');
  assert.equal(state.writes[1].pid, 77);
});

test('a write that fails never reaches the caller', async () => {
  const {state, marker} = fixture({write: async () => { throw new Error('disk full'); }});
  marker.mark('a.one');
  await state.timers.shift().fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(marker.current.name, 'a.one');
});

test('the closing write says the process ended in JavaScript, with its exit code, and stops later writes', () => {
  const {state, marker} = fixture();
  marker.mark('turn.voiceStart');
  marker.close(1);
  assert.equal(state.syncWrites.length, 1);
  assert.equal(state.syncWrites[0].closed, true); assert.equal(state.syncWrites[0].exitCode, 1);
  assert.equal(state.syncWrites[0].stage.name, 'turn.voiceStart');
  assert.equal(state.timers.length, 0, 'the pending write is cancelled');
  marker.mark('turn.after'); marker.close(0);
  assert.equal(state.syncWrites.length, 1);
});

test('markBridgeStage does nothing until the marker is installed, then marks; the memory line is logged on the interval only', async () => {
  const dir = await folder();
  try {
    markBridgeStage('before.install');
    const lines = [], repeats = [], listeners = new Map();
    const processRef = {on: (name, fn) => listeners.set(name, fn), removeListener: name => listeners.delete(name)};
    const handle = installStageMarker({stateDirectory: dir, log: line => lines.push(line), processRef, intervalMs: 300_000,
      setRepeat: (fn, ms) => { repeats.push({fn, ms}); return {}; }, clearRepeat: () => {},
      snapshot: () => ({rssMiB: 412, heapUsedMiB: 96, heapTotalMiB: 140, externalMiB: 20, heapLimitMiB: 4144}), uptime: () => 2100});
    assert.equal(handle.marker.current.name, 'bridge.start');
    assert.equal(lines.length, 0, 'no memory line at start-up');
    assert.equal(repeats.length, 1); assert.equal(repeats[0].ms, 300_000, 'at most every 5 minutes');
    markBridgeStage('turn.received');
    assert.equal(handle.marker.current.name, 'turn.received');
    repeats[0].fn();
    assert.deepEqual(lines, ['[Memory] rss 412 MiB, heap 96 of 140 MiB (limit 4144 MiB), external 20 MiB, up 35 min']);
    assert.equal(handle.marker.memory.rssMiB, 412);
    listeners.get('exit')(0);
    const written = readStageMarker(dir, process.pid);
    assert.equal(written.closed, true); assert.equal(written.stage.name, 'turn.received'); assert.equal(written.memory.heapLimitMiB, 4144);
    assert.equal(readStageMarker(dir, process.pid + 1), null, 'another process\'s file is not used');
    assert.equal(JSON.parse(await readFile(join(dir, STAGE_FILE), 'utf8')).version, 1);
    handle.stop();
    markBridgeStage('after.stop');
    assert.equal(handle.marker.current.name, 'turn.received');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the memory facts are whole MiB and the line is one short sentence', () => {
  const snapshot = memorySnapshot({memory: () => ({rss: 412 * 1048576 + 5, heapUsed: 96 * 1048576, heapTotal: 140 * 1048576, external: 20 * 1048576}), heapLimit: () => 4144 * 1048576});
  assert.deepEqual(snapshot, {rssMiB: 412, heapUsedMiB: 96, heapTotalMiB: 140, externalMiB: 20, heapLimitMiB: 4144});
  assert.match(memoryLine(snapshot, 60), /^\[Memory\] rss 412 MiB, heap 96 of 140 MiB \(limit 4144 MiB\), external 20 MiB, up 1 min$/);
  const real = memorySnapshot();
  assert.ok(real.rssMiB > 0 && real.heapLimitMiB > 0);
  assert.equal(readStageMarker(join(tmpdir(), 'no-such-folder-here'), 1), null);
});
