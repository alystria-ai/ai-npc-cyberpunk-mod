// The supervisor's state machine (bridge/bridge-supervisor.mjs) with the real DEFAULT_TIMINGS and a clock the test moves
// (bridge/supervisor-world.mjs): the backoff after each exit, the five exits in ten minutes that end the restarts, the cool-down
// retry, the 180-second ready timeout, what is adopted and what is not, what an explicit stop does, and how each way the game can
// end drains the bridge. bridge-supervisor.test.mjs runs the same supervisor against real processes with short timings.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {readFile, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {BridgeSupervisor, DEFAULT_TIMINGS, READY_MARKER} from './bridge-supervisor.mjs';
import {FAKE_KEY, GAME_PID, createWorld} from './supervisor-world.mjs';

const opts = {timeout: 300_000};
const readyFor = async (world, index) => {
  await world.untilSpawned(index + 1);
  return world.untilStatus(status => status.state === 'ready' && status.bridgePid === world.spawned[index].child.pid, `bridge ${index + 1} did not become ready`);
};
const exitedAfter = world => world.untilStatus(status => status.state === 'restarting' && status.code === 'bridge-exited', 'the exit was not reported');
const messages = async (world, pattern) => (await world.logText()).split('\n').filter(line => pattern.test(line));

test('the documented numbers are the defaults: five exits in ten minutes, 2/5/10/20/30 s backoff, a 3-minute cool-down, a 3-minute ready wait', () => {
  assert.equal(DEFAULT_TIMINGS.maxCrashes, 5); assert.equal(DEFAULT_TIMINGS.crashWindowMs, 600_000);
  assert.deepEqual(DEFAULT_TIMINGS.backoffMs, [2000, 5000, 10_000, 20_000, 30_000]);
  assert.equal(DEFAULT_TIMINGS.crashCooldownMs, 180_000); assert.equal(DEFAULT_TIMINGS.readyTimeoutMs, 180_000);
  assert.equal(DEFAULT_TIMINGS.shutdownGraceMs, 45_000);
});

test('exits are retried after 2, 5, 10 and 20 seconds, the fifth exit in ten minutes ends the restarts, and the cool-down tries once more', opts, async t => {
  const w = await createWorld(t);
  w.supervise();
  for (const [index, backoff] of [2000, 5000, 10_000, 20_000].entries()) {
    await readyFor(w, index);
    w.spawned[index].child.exit(4);
    const status = await exitedAfter(w);
    assert.equal(status.restarts, index + 1);
    assert.equal((await messages(w, /Restarting the bridge in/)).at(-1).split('Restarting the bridge in ')[1], `${backoff / 1000} s.`);
    w.advance(backoff - 1); await w.turn(4);
    assert.equal(w.spawned.length, index + 1, `not restarted one millisecond early (${backoff} ms)`);
    w.advance(1);
    await w.untilSpawned(index + 2);
  }
  await readyFor(w, 4);
  w.spawned[4].child.exit(4);
  const failed = await w.untilStatus(status => status.state === 'failed', 'the fifth exit did not end the restarts');
  assert.equal(failed.code, 'bridge-crashed'); assert.equal(failed.bridgePid, null); assert.equal(failed.restarts, 5);
  assert.match((await messages(w, /Giving up/))[0], /after 5 exits in 10 minutes\. Check bridge\.stderr\.log/);
  w.advance(DEFAULT_TIMINGS.crashCooldownMs - 1); await w.turn(4);
  assert.equal(w.spawned.length, 5, 'no sixth bridge before the cool-down is over');
  w.advance(1);
  await w.untilSpawned(6);
  assert.match((await messages(w, /Trying the bridge again after the crash cool-down/))[0], /cool-down/);
  // The earlier five exits are still inside the ten minutes: one more exit ends the restarts again, with no backoff.
  w.spawned[5].child.exit(4);
  await w.untilStatus(status => status.state === 'failed' && status.restarts === 6, 'the exit after the cool-down was retried again');
  await w.turn(4);
  assert.equal(w.spawned.length, 6);
});

test('exits more than ten minutes apart never add up: every restart waits only the first backoff', opts, async t => {
  const w = await createWorld(t);
  w.supervise();
  for (let index = 0; index < 7; index++) {
    await readyFor(w, index);
    w.spawned[index].child.exit(4);
    await exitedAfter(w);
    w.advance(DEFAULT_TIMINGS.backoffMs[0]);
    await w.untilSpawned(index + 2);
    w.advance(DEFAULT_TIMINGS.crashWindowMs + 1);
  }
  const waits = (await messages(w, /Restarting the bridge in/)).map(line => line.split('Restarting the bridge in ')[1]);
  assert.deepEqual(waits, Array(7).fill('2 s.'));
  const ready = await readyFor(w, 7);
  assert.equal(ready.restarts, 7);
  assert.equal(w.history.some(status => status.state === 'failed'), false);
});

test('a bridge that never prints the ready line is restarted after 180 s by its own stop, which is not read as an explicit stop', opts, async t => {
  const w = await createWorld(t);
  w.script.push({ready: false});
  w.supervise();
  await w.untilSpawned(1);
  const starting = await w.untilStatus(status => status.state === 'starting' && status.code === 'bridge-starting', 'no starting status');
  w.advance(DEFAULT_TIMINGS.readyTimeoutMs - 1); await w.turn(4);
  assert.deepEqual(w.controlWrites, [], 'no stop request before the time is up');
  assert.equal((await w.status()).state, 'starting');
  w.advance(2);
  await exitedAfter(w);
  const request = JSON.parse(w.controlWrites[0]);
  assert.equal(request.action, 'shutdown'); assert.equal(request.pid, w.spawned[0].child.pid);
  assert.match((await messages(w, /did not report ready within 180 s; restarting it/))[0], /restarting it/);
  w.advance(DEFAULT_TIMINGS.backoffMs[0]);
  await readyFor(w, 1);
  assert.equal(w.history.some(status => status.state === 'stopped'), false, 'the supervisor\'s own stop never left the bridge stopped');
  assert.equal(starting.since <= (await w.status()).since, true);
});

test('the ready line an earlier bridge left in the same log does not make the next bridge ready', opts, async t => {
  const w = await createWorld(t);
  w.script.push({ready: true}, {ready: false});
  w.supervise();
  await readyFor(w, 0);
  assert.match(await readFile(w.stdoutPath, 'utf8'), new RegExp(READY_MARKER.replace(/[[\]]/g, '\\$&')));
  w.spawned[0].child.exit(4);
  await exitedAfter(w);
  w.advance(DEFAULT_TIMINGS.backoffMs[0]);
  await w.untilSpawned(2);
  await w.turn(6);
  const status = await w.status();
  assert.equal(status.state, 'restarting'); assert.equal(status.code, 'bridge-restarting');
  assert.equal(status.bridgePid, w.spawned[1].child.pid);
});

test('a ready line split across two writes, behind more than 64 KiB of other output, is still found', opts, async t => {
  const w = await createWorld(t);
  w.script.push({ready: false});
  w.supervise();
  await w.untilSpawned(1);
  const half = Math.floor(READY_MARKER.length / 2);
  appendFileSync(w.stdoutPath, `${'startup noise line\n'.repeat(5000)}${READY_MARKER.slice(0, half)}`);
  await w.turn(5);
  assert.equal((await w.status()).state, 'starting', 'half a ready line is not ready');
  appendFileSync(w.stdoutPath, `${READY_MARKER.slice(half)}\n`);
  const ready = await w.untilStatus(status => status.state === 'ready', 'the split ready line was not recognised');
  assert.equal(ready.code, 'bridge-ready');
});

test('only a fresh, live, running bridge of this game is adopted', opts, async t => {
  const w = await createWorld(t);
  const supervisor = new BridgeSupervisor({project: w.project, stateDirectory: w.state, keyFile: w.keyPath, gameRoot: w.game,
    now: () => w.clock, alive: pid => w.alive.has(pid)});
  w.alive.add(500);
  const find = async (state = {}) => {
    const {raw, ...fields} = state;
    await writeFile(w.voicePath, raw ?? JSON.stringify({version: 1, state: 'ready', bridgePid: 500, updated: w.clock, ...fields}));
    return supervisor.findServingBridge();
  };
  assert.equal(await find(), 500);
  assert.equal(await find({state: 'starting'}), 500, 'a bridge that is still loading is used too');
  assert.equal(await find({updated: w.clock - 15_000}), 500, 'fifteen seconds old is the limit');
  assert.equal(await find({updated: w.clock - 15_001}), null, 'a heartbeat gone quiet');
  assert.equal(await find({updated: w.clock + 15_001}), null, 'a clock jump forward is as stale as one backward');
  assert.equal(await find({state: 'stopped'}), null, 'a bridge that said it stopped');
  assert.equal(await find({bridgePid: 501}), null, 'a PID that no process has');
  for (const bridgePid of ['500', 500.5, 0, -500, null, undefined]) assert.equal(await find({bridgePid}), null, `bridgePid ${String(bridgePid)}`);
  assert.equal(await find({updated: 'now'}), null, 'a timestamp that is not a number');
  assert.equal(await find({raw: ''}), null, 'the empty placeholder');
  assert.equal(await find({raw: '{"state":'}), null, 'a half-written file');
  assert.equal(await find({raw: '[500]'}), null);
  w.alive.add(process.pid);
  assert.equal(await find({bridgePid: process.pid}), null, 'never the supervisor itself');
  supervisor.childPid = 500;
  assert.equal(await find(), null, 'never the bridge it started itself');
  supervisor.childPid = null; supervisor.retiredPids.add(500);
  assert.equal(await find(), null, 'never a bridge it already stopped, whose heartbeat is still on disk');
});

test('an adopted bridge that ends is replaced by one of its own after the first backoff', opts, async t => {
  const w = await createWorld(t);
  w.alive.add(777);
  await w.writeVoice({pid: 777});
  w.supervise();
  const adopted = await w.untilStatus(status => status.state === 'ready', 'the running bridge was not used');
  assert.deepEqual([adopted.code, adopted.adopted, adopted.bridgePid], ['existing-bridge', true, 777]);
  assert.equal(w.spawned.length, 0);
  w.alive.delete(777);
  const gone = await exitedAfter(w);
  assert.equal(gone.adopted, false); assert.equal(gone.bridgePid, null);
  assert.match((await messages(w, /exited unexpectedly/))[0], /\(PID 777\) exited unexpectedly \(process ended\)/);
  w.advance(DEFAULT_TIMINGS.backoffMs[0]);
  const own = await readyFor(w, 0);
  assert.equal(own.adopted, false); assert.equal(own.restarts, 1);
  assert.equal(w.spawned.length, 1);
});

test('a stop request for another PID, a damaged request or another action changes nothing; the right one leaves the bridge stopped for good', opts, async t => {
  const w = await createWorld(t);
  w.supervise();
  await readyFor(w, 0);
  const child = w.spawned[0].child;
  for (const text of [JSON.stringify({action: 'shutdown', pid: child.pid + 1, nonce: 'other'}), '{"action":"shutdown","pid":',
    JSON.stringify({action: 'start', pid: child.pid, nonce: 'x'}), JSON.stringify({action: 'shutdown', nonce: 'no pid'}), '[]', 'null']) {
    await writeFile(w.controlPath, text);
    await w.turn(4);
    assert.equal((await w.status()).state, 'ready', text);
    assert.equal(child.exited, false);
  }
  await w.stopRequest(child.pid);
  const stopped = await w.untilStatus(status => status.state === 'stopped', 'the explicit stop was not reported');
  assert.deepEqual([stopped.code, stopped.bridgePid], ['stop-requested', null]);
  assert.match((await messages(w, /stopped on request; it stays stopped/))[0], /PID \d+/);
  w.advance(10 * 60_000); await w.turn(6);
  assert.equal(w.spawned.length, 1, 'ten minutes later it is still stopped, not restarted');
  assert.equal((await w.status()).state, 'stopped');
  assert.equal((await w.status()).restarts, 0, 'an explicit stop is not a crash');
});

test('an explicit stop also ends a supervisor that is not watching a game, and an adopted bridge can be stopped the same way', opts, async t => {
  const alone = await createWorld(t, {lifeline: false});
  alone.supervise();
  await readyFor(alone, 0);
  await alone.stopRequest(alone.spawned[0].child.pid);
  assert.deepEqual(await alone.done, {state: 'stopped', code: 'stop-requested'});

  const w = await createWorld(t);
  w.alive.add(888); await w.writeVoice({pid: 888});
  w.supervise();
  await w.untilStatus(status => status.state === 'ready' && status.adopted, 'not adopted');
  await w.stopRequest(888);
  await w.turn(3);
  w.alive.delete(888);
  const stopped = await w.untilStatus(status => status.state === 'stopped', 'the adopted bridge\'s stop was not reported');
  assert.equal(stopped.code, 'stop-requested');
  assert.equal(w.spawned.length, 0, 'the supervisor never started a bridge of its own');
});

test('the game ending while the bridge waits to restart stops the supervisor without starting another bridge or asking anyone to stop', opts, async t => {
  const w = await createWorld(t);
  w.supervise();
  await readyFor(w, 0);
  w.spawned[0].child.exit(4);
  await exitedAfter(w);
  const written = w.controlWrites.length;
  w.endGame();
  assert.deepEqual(await w.done, {state: 'stopped', code: 'game-exited'});
  assert.equal(w.spawned.length, 1); assert.equal(w.controlWrites.length, written);
  assert.equal((await w.status()).bridgePid, null);
});

test('the game ending while setup is incomplete leaves a stopped service, and the missing setup is not asked for again', opts, async t => {
  const w = await createWorld(t, {key: false});
  w.supervise();
  const failed = await w.untilStatus(status => status.state === 'failed', 'no failure published');
  assert.equal(failed.code, 'missing-key');
  assert.deepEqual(await w.finish(), {state: 'stopped', code: 'game-exited'});
  assert.equal(w.spawned.length, 0);
});

test('the game ending while the bridge is still starting: stopping is published, the bridge is asked by PID, then stopped', opts, async t => {
  const w = await createWorld(t);
  w.script.push({ready: false});
  w.supervise();
  await w.untilSpawned(1);
  const child = w.spawned[0].child;
  assert.deepEqual(await w.finish(), {state: 'stopped', code: 'game-exited'});
  const steps = w.history.map(status => `${status.state}/${status.code}`);
  assert(steps.includes('stopping/game-exited'), steps.join(' '));
  assert.equal(steps.at(-1), 'stopped/game-exited');
  assert.equal(JSON.parse(w.controlWrites.at(-1)).pid, child.pid);
  assert.equal(child.exited, true);
  assert.deepEqual(w.kills, [], 'a bridge that obeys is never force-ended');
});

test('a bridge that ignores the stop is asked every two seconds for 45 s, then its process tree is ended and the run still finishes', opts, async t => {
  const w = await createWorld(t);
  w.script.push({obeys: false});
  w.supervise();
  await readyFor(w, 0);
  w.endGame(); w.advance(1000);
  await w.untilStatus(status => status.state === 'stopping', 'stopping was not published');
  // The world looks at the control file only every 25 ms of real time, and each request replaces the one before it: a few event-loop turns after the clock
  // moved were not always enough for the next request to be seen ('12 requests in 42 s' on a busy machine). Each step waits until its request has been seen.
  for (let step = 0; step < 21; step++) {
    const seen = w.controlWrites.length;
    w.advance(2000);
    await w.until(async () => w.controlWrites.length, count => count > seen, `no stop request was seen after ${(step + 1) * 2} s of waiting`, 60_000);
  }
  assert.deepEqual(w.kills, [], 'still inside the grace period');
  const requests = w.controlWrites.map(text => JSON.parse(text));
  assert(requests.length >= 20 && requests.length <= 24, `${requests.length} requests in 42 s`);
  assert.equal(new Set(requests.map(request => request.nonce)).size, requests.length, 'every request has its own nonce');
  assert(requests.every(request => request.action === 'shutdown' && request.pid === w.spawned[0].child.pid));
  w.advance(4000);
  assert.deepEqual(await w.done, {state: 'stopped', code: 'game-exited'});
  assert.deepEqual(w.kills, [w.spawned[0].child.pid]);
  assert.match((await messages(w, /did not stop within 45 s; ending its process tree/))[0], /PID \d+/);
});

test('an adopted bridge is asked to stop when the game ends, and is never force-ended if it will not', opts, async t => {
  const w = await createWorld(t);
  w.alive.add(999); await w.writeVoice({pid: 999});
  w.supervise();
  await w.untilStatus(status => status.state === 'ready' && status.adopted, 'not adopted');
  w.endGame(); w.advance(1000);
  await w.untilStatus(status => status.state === 'stopping', 'stopping was not published');
  w.advance(DEFAULT_TIMINGS.shutdownGraceMs + 1);
  assert.deepEqual(await w.done, {state: 'stopped', code: 'game-exited'});
  assert.deepEqual(w.kills, [], 'a bridge started elsewhere is never ended by force');
  assert.equal(JSON.parse(w.controlWrites.at(-1)).pid, 999);
  assert.match((await messages(w, /existing bridge \(PID 999\) is still running/))[0], /still running/);
});

test('the lifeline closing or failing, not only ending, is the game ending', opts, async t => {
  for (const close of [lifeline => lifeline.destroy(), lifeline => lifeline.destroy(new Error('the pipe broke'))]) {
    const w = await createWorld(t);
    w.supervise();
    await readyFor(w, 0);
    close(w.lifeline); w.advance(1000);
    assert.deepEqual(await w.done, {state: 'stopped', code: 'game-exited'});
    assert.match(await w.logText(), /The game process ended \(lifeline closed\)/);
  }
});

test('the game PID is looked at once a second, so a game that ended is noticed at the next probe and not before', opts, async t => {
  const w = await createWorld(t, {gamePid: GAME_PID});
  w.supervise();
  await readyFor(w, 0);
  w.alive.delete(GAME_PID);
  await w.turn(4);
  assert.equal(w.finished, false, 'the probe is not due again yet');
  w.advance(DEFAULT_TIMINGS.gamePollMs);
  assert.deepEqual(await w.done, {state: 'stopped', code: 'game-exited'});
  assert.equal((await w.status()).gamePid, GAME_PID);
});

test('every status the supervisor publishes through a crash, a stop and the game ending carries the fields the game reads', opts, async t => {
  const w = await createWorld(t);
  w.supervise();
  await readyFor(w, 0);
  w.spawned[0].child.exit(4);
  await exitedAfter(w);
  w.advance(DEFAULT_TIMINGS.backoffMs[0]);
  await readyFor(w, 1);
  await w.finish();
  const states = new Set(['starting', 'ready', 'restarting', 'stopping', 'stopped', 'failed']);
  assert(w.history.length >= 5, w.history.map(status => status.state).join(' '));
  for (const status of w.history) {
    assert.equal(status.version, 1);
    assert(states.has(status.state), status.state);
    assert.equal(typeof status.code, 'string');
    assert(Number.isSafeInteger(status.since) && Number.isSafeInteger(status.updated) && status.since <= status.updated, JSON.stringify(status));
    assert.equal(status.supervisorPid, process.pid);
    assert.equal(status.gameRoot, w.game); assert.equal(status.stateDirectory, w.state);
    assert.equal(status.gamePid, null);
    assert(['number', 'object'].includes(typeof status.bridgePid));
  }
  const byCode = Object.fromEntries(w.history.map(status => [`${status.state}/${status.code}`, status]));
  assert.equal(byCode['starting/supervisor-started'].bridgePid, null);
  assert.equal(byCode['starting/bridge-starting'].since, byCode['starting/supervisor-started'].since,
    'a change of code inside one state keeps the time the state began');
  assert(byCode['ready/bridge-ready'].since >= byCode['starting/bridge-starting'].since);
  assert.equal(byCode['restarting/bridge-exited'].restarts, 1);
  assert.equal(w.history.at(-1).state, 'stopped'); assert.equal(w.history.at(-1).bridgePid, null);
  assert.equal(JSON.stringify(w.history).includes(FAKE_KEY.split('=')[1]), false, 'the credential is never published');
});

test('the supervisor writes the status over a file that already exists and keeps the log and the stop pointer in its own folder', opts, async t => {
  const w = await createWorld(t);
  await writeFile(w.statusPath, '{"version":1,"state":"ready","code":"bridge-ready","updated":1}');
  w.supervise();
  await readyFor(w, 0);
  assert.equal((await readFile(join(w.state, 'bridge.pid'), 'utf8')).trim(), String(w.spawned[0].child.pid));
  assert((await stat(w.logPath)).size > 0);
  assert.equal((await w.status()).supervisorPid, process.pid, 'the old status was replaced, not kept');
  await rm(w.statusPath, {force: true});
  w.advance(DEFAULT_TIMINGS.heartbeatMs + 1);
  await w.untilStatus(status => status.state === 'ready', 'a deleted status file was not written again by the heartbeat', 4000);
});
