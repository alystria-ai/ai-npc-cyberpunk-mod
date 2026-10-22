import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {killProcessTree, recoverExit, closeConfirmed, pidAlive} from './worker-process.mjs';

const tick = () => new Promise(done => setImmediate(done));
const child = () => { const handle = new EventEmitter(); handle.pid = 4321; handle.kills = 0; handle.kill = () => { handle.kills++; return true; }; return handle; };
const killer = outcome => { const calls = [];
  const spawnImpl = (exe, args, options) => { const process = new EventEmitter(); process.kill = () => { process.killed = true; }; calls.push({exe, args, options, process});
    queueMicrotask(() => outcome(process)); return process; };
  return {calls, spawnImpl}; };

test('the process tree is stopped with the system folder\'s taskkill by PID, and a good answer needs no fallback', async () => {
  const handle = child(), k = killer(process => process.emit('close', 0));
  const result = await killProcessTree(handle, {real: true, platform: 'win32', spawnImpl: k.spawnImpl, env: {SystemRoot: 'C:\\Win'}});
  assert.deepEqual(result, {via: 'tree', ok: true});
  assert.match(k.calls[0].exe, /^C:.Win.System32.taskkill.exe$/); assert.deepEqual(k.calls[0].args, ['/PID', '4321', '/T', '/F']);
  assert.equal(handle.kills, 0);
});

test('"process not found" (128) counts as stopped', async () => {
  const handle = child(), k = killer(process => process.emit('close', 128));
  assert.deepEqual(await killProcessTree(handle, {real: true, platform: 'win32', spawnImpl: k.spawnImpl}), {via: 'tree', ok: true}); assert.equal(handle.kills, 0);
});

test('a taskkill that fails, cannot start or never answers falls back to killing the handle', async () => {
  for (const outcome of [process => process.emit('close', 1), process => process.emit('error', Error('spawn taskkill ENOENT')), () => {}]) {
    const handle = child(), k = killer(outcome); let release;
    const timers = {set: (task) => { release = task; return 1; }, clear: () => {}};
    const pending = killProcessTree(handle, {real: true, platform: 'win32', spawnImpl: k.spawnImpl, setTimer: timers.set, clearTimer: timers.clear});
    await tick(); if (handle.kills === 0) release();
    assert.deepEqual(await pending, {via: 'handle', ok: true}); assert.equal(handle.kills, 1);
  }
  const handle = child(), throwing = () => { throw Error('spawn failed'); };
  assert.deepEqual(await killProcessTree(handle, {real: true, platform: 'win32', spawnImpl: throwing}), {via: 'handle', ok: true}); assert.equal(handle.kills, 1);
});

test('a stand-in child or a non-Windows system is stopped by handle only', async () => {
  const handle = child(), k = killer(() => {});
  await killProcessTree(handle, {real: false, platform: 'win32', spawnImpl: k.spawnImpl});
  await killProcessTree(handle, {real: true, platform: 'linux', spawnImpl: k.spawnImpl});
  assert.equal(handle.kills, 2); assert.equal(k.calls.length, 0);
});

test('pidAlive: this process is alive, an impossible pid is not', () => { assert.equal(pidAlive(process.pid), true); assert.equal(pidAlive(0), false); assert.equal(pidAlive(undefined), false); });

test('recoverExit polls, stops the process again every killMs, resolves true when it is gone and false after its time', async () => {
  const jobs = []; const schedule = (task, ms) => { jobs.push({task, ms}); };
  const run = async () => { for (const job of jobs.splice(0)) job.task(); await tick(); };
  let alive = true, kills = 0, gone = 0;
  const done = recoverExit({child: child(), isAlive: () => alive, kill: () => kills++, schedule, timeoutMs: 100_000, pollMs: 1000, killMs: 3000, onGone: () => gone++});
  for (let step = 0; step < 7; step++) await run();
  assert.ok(kills >= 2, 'stopped again while alive'); alive = false; await run();
  assert.equal(await done, true); assert.equal(gone, 1);
  const never = recoverExit({child: child(), isAlive: () => true, kill: () => {}, schedule, timeoutMs: 3000, pollMs: 1000, killMs: 5000});
  for (let step = 0; step < 6; step++) await run();
  assert.equal(await never, false);
  assert.equal(await recoverExit({child: null, schedule}), true);
});

test('closeConfirmed rethrows an unconfirmed exit unless the client can look again and finds the process gone', async () => {
  const unconfirmed = Error('exit could not be confirmed'), logs = [];
  await closeConfirmed({close: async () => {}});
  await assert.rejects(closeConfirmed({close: async () => { throw unconfirmed; }}), /could not be confirmed/);
  await closeConfirmed({close: async () => { throw unconfirmed; }, recoverExit: async () => true}, {log: line => logs.push(line)});
  assert.ok(logs.some(line => /exited after all/.test(line)));
  await assert.rejects(closeConfirmed({close: async () => { throw unconfirmed; }, recoverExit: async () => false}), /could not be confirmed/);
});
