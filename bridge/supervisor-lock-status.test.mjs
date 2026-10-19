// What the game reads while the supervisor has not started a bridge yet (bridge/bridge-supervisor.mjs, node --test).
//
// The supervisor waits for the previous session's supervisor to let go of bridge-supervisor.lock. That wait used to be silent: no status
// was written before the lock was held, so a start behind a holder that never ended left the game with the launcher's "starting" for
// good (a player on Mod Organizer 2 saw exactly that). After lockStatusAfterMs the waiting supervisor publishes its own status and keeps
// it fresh. A failure's short reason travels in the same file.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {closeSync, constants, openSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {BridgeSupervisor, DEFAULT_TIMINGS} from './bridge-supervisor.mjs';
import {GAME_PID, createWorld} from './supervisor-world.mjs';

const opts = {timeout: 60_000, skip: process.platform === 'win32' ? false : 'the lock is exclusive only on Windows'};
const EXCLUSIVE = constants.UV_FS_O_EXLOCK ?? 0x10000000;

test('the documented wait before a waiting supervisor speaks is five seconds', () => {
  assert.equal(DEFAULT_TIMINGS.lockStatusAfterMs, 5000);
});

test('a supervisor behind an earlier one says it is waiting after five seconds, keeps saying so, then takes over', opts, async t => {
  const w = await createWorld(t);
  // The previous session's supervisor holds the lock; the kernel lets go of it when that process ends.
  const held = openSync(join(w.state, 'bridge-supervisor.lock'), constants.O_RDWR | constants.O_CREAT | EXCLUSIVE);
  let open = true;
  t.after(() => { if (open) closeSync(held); });
  w.supervise();
  await w.turn(6);
  assert.equal(await w.status(), null, 'a short wait writes nothing: the previous session is still stopping its bridge');
  w.advance(DEFAULT_TIMINGS.lockStatusAfterMs - 1000);
  await w.turn(4);
  assert.equal(await w.status(), null, 'not yet');
  w.advance(1000);
  const waiting = await w.untilStatus(status => status.code === 'waiting-for-previous-service', 'the wait was never published');
  assert.equal(waiting.state, 'starting');
  assert.equal(waiting.supervisorPid, process.pid);
  assert.equal(waiting.bridgePid, null);
  assert.equal(waiting.gameRoot, w.game);
  assert.equal(w.spawned.length, 0, 'nothing is started while the earlier supervisor holds the lock');
  assert.match(await w.logText(), /Still waiting for the earlier supervisor/);
  // The heartbeat keeps the status fresh for a wait that lasts: the game must not read a service that went quiet.
  w.advance(DEFAULT_TIMINGS.heartbeatMs + 1000);
  const refreshed = await w.untilStatus(status => status.updated > waiting.updated, 'the status was not refreshed while waiting');
  assert.equal(refreshed.code, 'waiting-for-previous-service');
  assert.equal(refreshed.since, waiting.since, 'the same wait keeps the time it began');
  // The earlier supervisor ends: this one owns the bridge and the status moves on.
  closeSync(held); open = false;
  await w.untilStatus(status => status.state === 'ready', 'the waiting supervisor did not take over');
  assert.equal(w.spawned.length, 1);
  const states = w.history.map(status => `${status.state}/${status.code}`);
  assert(states.indexOf('starting/waiting-for-previous-service') < states.indexOf('starting/supervisor-started'), states.join(' '));
  assert.equal(states.filter(state => state === 'starting/supervisor-started').length, 1);
});

test('a waiting supervisor whose game ends writes nothing more and leaves no heartbeat running', opts, async t => {
  const w = await createWorld(t);
  const held = openSync(join(w.state, 'bridge-supervisor.lock'), constants.O_RDWR | constants.O_CREAT | EXCLUSIVE);
  let open = true;
  const release = () => { if (open) { open = false; closeSync(held); } };
  t.after(release);
  w.supervise();
  await w.turn(6); // the wait has begun
  w.advance(DEFAULT_TIMINGS.lockStatusAfterMs);
  await w.untilStatus(status => status.code === 'waiting-for-previous-service', 'the wait was never published');
  w.endGame();
  assert.deepEqual(await w.done, {state: 'not-started'});
  assert.equal(w.supervisor.heartbeat, null, 'the heartbeat of the wait is stopped');
  assert.equal(w.spawned.length, 0);
  release(); // the folder is removed after the test: nothing may hold the lock file then
});

test('a status carries the short reason it was given, and the next status without one does not keep it', opts, async t => {
  const w = await createWorld(t);
  const supervisor = new BridgeSupervisor({project: w.project, stateDirectory: w.state, keyFile: w.keyPath, gameRoot: w.game, now: () => w.clock});
  await supervisor.setStatus('failed', 'supervisor-error', 'EPERM: operation not permitted, open \'bridge-service.log\'');
  const failed = await w.status();
  assert.deepEqual([failed.state, failed.code, failed.reason], ['failed', 'supervisor-error', 'EPERM: operation not permitted, open \'bridge-service.log\'']);
  await supervisor.setStatus('stopped', 'stop-requested');
  assert.equal('reason' in await w.status(), false);
  // The same state and code with a reason added is a change, not a repeat.
  await supervisor.setStatus('stopped', 'stop-requested', 'now with a reason');
  assert.equal((await w.status()).reason, 'now with a reason');
});

// "Restart the game" is what the failure notice says, and a player who does it at once starts the next session while this supervisor
// still drains its bridge (up to 45 s, then the kill). The next session's launcher and start script write the same file with their own
// game's PID; this supervisor's 'stopping' heartbeat and its final 'stopped' used to write over them, so a start that failed in the new
// session read as "not running" there.
test('a supervisor whose game has ended leaves the next session\'s status alone while it stops its bridge', opts, async t => {
  const w = await createWorld(t, {gamePid: GAME_PID});
  w.script.push({obeys: false}); // a bridge slow to stop keeps this supervisor in its shutdown, heartbeat running
  w.supervise();
  await w.untilStatus(status => status.state === 'ready', 'the bridge never became ready');
  w.alive.delete(GAME_PID); w.advance(DEFAULT_TIMINGS.gamePollMs);
  await w.untilStatus(status => status.state === 'stopping', 'stopping was not published');
  const next = JSON.stringify({version: 1, state: 'failed', code: 'install-incomplete', source: 'service', stage: 'loading-modules',
    reason: 'ERR_MODULE_NOT_FOUND', gamePid: GAME_PID + 1, since: w.clock, updated: w.clock});
  await writeFile(w.statusPath, next);
  for (let step = 0; step < 4; step++) { w.advance(DEFAULT_TIMINGS.heartbeatMs); await w.turn(3); }
  assert.equal(await readFile(w.statusPath, 'utf8'), next, 'the heartbeat of the stop does not write over the next session');
  w.advance(DEFAULT_TIMINGS.shutdownGraceMs);
  assert.deepEqual(await w.done, {state: 'stopped', code: 'game-exited'});
  assert.deepEqual(w.kills, [w.spawned[0].child.pid], 'the stop itself is unchanged');
  assert.equal(await readFile(w.statusPath, 'utf8'), next, 'nor does its final "stopped"');
  assert.match(await w.logText(), /belongs to the next game session \(game PID 7778\); this supervisor no longer writes it/);
});

test('a supervisor whose game has ended still reports its stop when the file is its own session\'s', opts, async t => {
  const w = await createWorld(t, {gamePid: GAME_PID});
  w.supervise();
  await w.untilStatus(status => status.state === 'ready', 'the bridge never became ready');
  w.alive.delete(GAME_PID); w.advance(DEFAULT_TIMINGS.gamePollMs);
  assert.deepEqual(await w.done, {state: 'stopped', code: 'game-exited'});
  const status = await w.status();
  assert.deepEqual([status.state, status.code, status.gamePid], ['stopped', 'game-exited', GAME_PID]);
  assert.doesNotMatch(await w.logText(), /next game session/);
});
