// The OmniVoice model slot after a fast game restart (docs/LOCAL_VOICES.md, "The model slot after a fast restart"; triage of 2026-10-23: a short wait instead of a
// 45 s retry plus an error report). Three cases, each at the level of the wait itself and at the level of the voice client that starts the worker:
// the owner is gone or stopped beating (taken over at once), the owner is alive and lets go soon (waited for, no failure, no report), the owner never lets go
// (no second worker is ever started, the start fails with one cause after the window).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {mkdtempSync, rmSync, writeFileSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResidentVoice, LOCAL_VOICE_KEYS} from './resident-voice.mjs';
import {SLOT_OWNER_FILE, SLOT_OWNED_FAILURE, SLOT_WAIT, SLOT_WAIT_TOTAL_MS, SLOT_WAIT_VARIABLE, awaitModelSlot, judgeSlot, readSlotOwner, slotOwnedFailed, slotOwnerFile}
  from './worker-process.mjs';
import {voiceFailureCause} from './voice-selection.mjs';

// A clock the test moves: `sleep` is the only thing that passes time, and `during(ms, fn)` runs `fn` at that point of the wait.
function world({owner, alive = () => true, wait = SLOT_WAIT} = {}) {
  let time = 1_000_000, record = owner ? {...owner} : null; const sleeps = [], lines = [];
  const events = [];
  const at = (ms, action) => events.push({ms, action});
  return {sleeps, lines, at, set: value => { record = value; },
    options: {file: 'owner.json', wait, now: () => time, alive: pid => alive(pid),
      read: () => { if (!record) throw Object.assign(Error('ENOENT'), {code: 'ENOENT'}); return JSON.stringify({heartbeatAt: time, ...record}); },
      sleep: async ms => { sleeps.push(ms); time += ms; for (const event of events.filter(item => !item.done && item.ms <= time - 1_000_000)) { event.done = true; event.action(); } },
      log: text => lines.push(text)}};
}

test('the owner record is read strictly: no file, a half-written one or a foreign one is no owner', () => {
  const read = text => () => text;
  assert.equal(readSlotOwner('x', {read: () => { throw Error('ENOENT'); }}), null);
  assert.equal(readSlotOwner(null), null);
  for (const text of ['', '{', '[]', '{"pid":0,"heartbeatAt":1}', '{"pid":"7","heartbeatAt":1}', '{"pid":7}', '{"pid":7,"heartbeatAt":"now"}']) assert.equal(readSlotOwner('x', {read: read(text)}), null, text);
  assert.deepEqual(readSlotOwner('x', {read: read('{"pid":7,"heartbeatAt":5,"startedAt":2,"state":"exiting"}')}), {pid: 7, startedAt: 2, heartbeatAt: 5, state: 'exiting'});
  assert.equal(readSlotOwner('x', {read: read('{"pid":7,"heartbeatAt":5,"state":"anything"}')}).state, 'running');
  assert.match(slotOwnerFile({project: join('a', 'b')}), /a.b.runtime.voice-studio-data.resident-model\.owner\.json$/);
  assert.equal(slotOwnerFile({project: 'x', cacheDirectory: join('c', 'd')}), join('c', 'd', SLOT_OWNER_FILE));
  assert.equal(slotOwnerFile({}), null);
});

test('the verdicts: gone and stale are taken over, exiting is waited for, a beating owner is live', () => {
  const owner = {pid: 7, heartbeatAt: 100_000, state: 'running'}, yes = () => true, no = () => false;
  assert.deepEqual(judgeSlot(null), {state: 'free'});
  assert.deepEqual(judgeSlot(owner, {now: 101_000, alive: no}), {state: 'takeover', reason: 'exited', pid: 7});
  assert.deepEqual(judgeSlot(owner, {now: 101_000, alive: yes}), {state: 'live', pid: 7});
  assert.equal(judgeSlot(owner, {now: 100_000 + SLOT_WAIT.staleMs + 1, alive: yes}).reason, 'stale');
  assert.equal(judgeSlot(owner, {now: 100_000 + SLOT_WAIT.staleMs, alive: yes}).state, 'live');
  // An exiting owner is never called stale: the slot is its until its process is gone.
  assert.deepEqual(judgeSlot({...owner, state: 'exiting'}, {now: 900_000, alive: yes}), {state: 'exiting', pid: 7});
});

test('stale owner: an owner that has exited, or stopped beating, is taken over at once, with one log line and no wait', async () => {
  for (const [name, owner, alive, words] of [
    ['exited', {pid: 41, state: 'running'}, () => false, /took over the voice slot from worker 41 \(it had exited\)/],
    ['no heartbeat', {pid: 42, state: 'running', heartbeatAt: 1_000_000 - 30_000}, () => true, /from worker 42 \(its heartbeat was 30 s old\)/]]) {
    const w = world({owner, alive});
    const result = await awaitModelSlot(w.options);
    assert.equal(result.ok, true, name); assert.equal(result.waitedMs, 0, name); assert.deepEqual(w.sleeps, [], name);
    assert.equal(w.lines.length, 1, name); assert.match(w.lines[0], words); assert.ok(w.lines[0].endsWith('\n'));
  }
  const free = world({}); const result = await awaitModelSlot(free.options);
  assert.equal(result.ok, true); assert.deepEqual(free.lines, [], 'a slot nobody owned logs nothing');
});

test('live owner that frees soon: the wait ends the moment it is gone, well inside the window, with one line', async () => {
  const w = world({owner: {pid: 51, state: 'running'}});
  w.at(2_600, () => w.set({pid: 51, state: 'exiting'}));
  w.at(3_000, () => w.set(null));
  const result = await awaitModelSlot(w.options);
  assert.equal(result.ok, true);
  assert.ok(result.waitedMs >= 3_000 && result.waitedMs < 3_500, `waited ${result.waitedMs}`);
  assert.ok(result.waitedMs < SLOT_WAIT_TOTAL_MS);
  assert.equal(w.lines.length, 1); assert.match(w.lines[0], /the voice slot was released by worker 51 after 3\.\d s/);
  assert.ok(w.sleeps.every(ms => ms <= SLOT_WAIT.sliceMs), 'a live owner is looked at every slice, so a change is seen within 250 ms');
});

test('an owner that is exiting is looked at every 100 ms, not on the 1 s step, and its exit is taken over without waiting for a heartbeat', async () => {
  let alive = true;
  const w = world({owner: {pid: 52, state: 'exiting'}, alive: () => alive});
  w.at(450, () => { alive = false; });
  const result = await awaitModelSlot(w.options);
  assert.equal(result.ok, true); assert.ok(result.waitedMs <= 500);
  assert.deepEqual([...new Set(w.sleeps)], [SLOT_WAIT.exitPollMs]);
  assert.equal(w.lines.length, 1); assert.match(w.lines[0], /took over the voice slot from worker 52 \(it had exited\) after 0\.5 s/);
});

test('live owner that never frees: tried again on the 1, 2, 4, 8 s schedule, 15 s in all, then not ok', async () => {
  const w = world({owner: {pid: 61, state: 'running'}});
  // Keep the owner beating (the world's heartbeat is always "now"), so only its end could free the slot.
  const result = await awaitModelSlot(w.options);
  assert.equal(result.ok, false); assert.equal(result.verdict.state, 'live'); assert.equal(result.verdict.pid, 61);
  assert.equal(result.waitedMs, SLOT_WAIT_TOTAL_MS); assert.equal(SLOT_WAIT_TOTAL_MS, 15_000);
  assert.deepEqual(SLOT_WAIT.stepsMs, [1000, 2000, 4000, 8000]);
  assert.equal(w.sleeps.reduce((sum, ms) => sum + ms, 0), 15_000);
  assert.deepEqual(w.lines, [], 'no takeover happened, so no takeover line');
});

test('a wait that is cancelled (the voice is closing) ends at once', async () => {
  const w = world({owner: {pid: 62, state: 'running'}}); let closed = false;
  w.options.sleep = async ms => { w.sleeps.push(ms); closed = true; };
  const result = await awaitModelSlot({...w.options, cancelled: () => closed});
  assert.equal(result.ok, false); assert.equal(w.sleeps.length, 1);
});

// ---- the voice client: the worker is started only into a slot nobody owns -------------------------------------------------------------------------------
const SHORT = {...SLOT_WAIT, stepsMs: [20, 40, 80, 160], exitPollMs: 5, sliceMs: 5}, LONG = {...SHORT, stepsMs: [500, 1000, 2000, 4000]};
function client({alive, wait = SHORT} = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'omni-slot-')), file = join(folder, 'runtime', 'voice-studio-data', SLOT_OWNER_FILE);
  const launches = [], logs = [], states = [];
  const child = new EventEmitter();
  child.pid = 9; child.kill = () => true; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new Writable({write(chunk, encoding, done) { done(); }});
  const settings = {provider: 'hybrid', engine: 'omnivoice', voices: Object.fromEntries(LOCAL_VOICE_KEYS.map(key => [key, {reference: `runtime/voice-references/${key}.wav`, sha256: 'a'.repeat(64), transcript: 'Ready.'}]))};
  const voice = new ResidentVoice(settings, {project: folder, configPath: 'c.json', pythonExecutable: undefined,
    onState: state => states.push(state.state), onLog: text => logs.push(text),
    slot: {file, wait, alive},
    spawnImpl: (exe, args, options) => { launches.push(options); queueMicrotask(() => child.stdout.write(JSON.stringify({op: 'ready', profiles: LOCAL_VOICE_KEYS, device: 'cuda:0', dtype: 'torch.float16', runtime: 'pytorch', tensorrt: false, compiled: false, cudaAllocatedMiB: 1, cudaReservedMiB: 2}) + '\n')); return child; }});
  const write = record => { mkdirp(file); writeFileSync(file, JSON.stringify({heartbeatAt: Date.now(), startedAt: Date.now(), ...record})); };
  return {voice, launches, logs, states, write, remove: () => unlinkSync(file), done: () => rmSync(folder, {recursive: true, force: true})};
}
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
const mkdirp = file => mkdirSync(dirname(file), {recursive: true});
const slotLines = c => c.logs.filter(text => text.includes('[OmniSlot]'));

test('voice client, stale owner: the worker starts in the same call, with one takeover line and no failure', async () => {
  const c = client({alive: () => false});
  c.write({pid: 71, state: 'running'});
  const ready = c.voice.start();
  assert.equal(c.launches.length, 1, 'started at once, not after a wait');
  await ready;
  assert.equal(slotLines(c).length, 1); assert.match(slotLines(c)[0], /took over the voice slot from worker 71 \(it had exited\)/);
  assert.ok(!c.states.includes('error')); assert.equal(c.voice.failure, undefined);
  assert.ok(Number(c.launches[0].env[SLOT_WAIT_VARIABLE]) <= 15 && Number(c.launches[0].env[SLOT_WAIT_VARIABLE]) >= 2, 'the worker is told how much of the window is left');
  c.done();
});

test('voice client, no record at all: the worker starts at once and nothing is logged', async () => {
  const c = client({alive: () => true});
  await c.voice.start();
  assert.equal(c.launches.length, 1); assert.deepEqual(slotLines(c), []);
  c.done();
});

test('voice client, live owner that frees soon: one worker, started after the owner is gone, no failure (so no error report and no 45 s retry)', async () => {
  let alive = true;
  const c = client({alive: () => alive, wait: LONG});
  c.write({pid: 72, state: 'running'});
  const ready = c.voice.start();
  assert.equal(c.launches.length, 0, 'a live owner: nothing is started yet');
  setTimeout(() => { alive = false; }, 60);
  await ready;
  assert.equal(c.launches.length, 1, 'exactly one worker');
  assert.equal(slotLines(c).length, 1); assert.match(slotLines(c)[0], /took over the voice slot from worker 72 \(it had exited\) after \d\.\d s/);
  assert.ok(!c.states.includes('error')); assert.equal(c.voice.failure, undefined);
  assert.ok(Number(c.launches[0].env[SLOT_WAIT_VARIABLE]) <= 15);
  c.done();
});

test('voice client, owner that lets go by removing its record: the same, with the release line', async () => {
  const c = client({alive: () => true, wait: LONG});
  c.write({pid: 73, state: 'running'});
  const ready = c.voice.start();
  setTimeout(() => c.remove(), 60);
  await ready;
  assert.equal(c.launches.length, 1); assert.match(slotLines(c)[0], /the voice slot was released by worker 73 after/);
  assert.equal(c.voice.failure, undefined);
  c.done();
});

test('voice client, live owner that never frees: no worker is ever started, and the start fails once with the one cause after the window', async () => {
  const c = client({alive: () => true});
  c.write({pid: 74, state: 'running'});
  // The record keeps beating, as a live worker does.
  const beat = setInterval(() => c.write({pid: 74, state: 'running'}), 10);
  try {
    await assert.rejects(c.voice.start(), error => { assert.match(error.message, new RegExp(SLOT_OWNED_FAILURE)); assert.match(error.message, /pid 74/); return true; });
    assert.equal(c.launches.length, 0, 'two workers are never started on one slot');
    assert.ok(slotOwnedFailed(c.voice.failure.message));
    assert.equal(voiceFailureCause(c.voice.failure.message), 'slot-owned');
    assert.equal(voiceFailureCause('Local voice worker exited (1): RuntimeError: Another resident voice worker owns the shared model slot'), 'slot-owned');
    assert.equal(voiceFailureCause('Local voice worker exited (1)'), 'unknown');
    assert.ok(c.states.includes('error'));
  } finally { clearInterval(beat); c.done(); }
});

test('voice client, closed while the slot is waited for: nothing is started and the start is cancelled', async () => {
  const c = client({alive: () => true});
  c.write({pid: 75, state: 'running'});
  const beat = setInterval(() => c.write({pid: 75, state: 'running'}), 10);
  try {
    const ready = c.voice.start();
    const rejected = assert.rejects(ready, /./);
    await c.voice.close();
    await rejected;
    await new Promise(done => setTimeout(done, 400));
    assert.equal(c.launches.length, 0);
  } finally { clearInterval(beat); c.done(); }
});
