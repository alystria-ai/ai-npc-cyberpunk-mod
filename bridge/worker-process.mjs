// Stopping a worker we started, and finding out whether it is really gone. Shared by the Pocket and OmniVoice clients and by the voice
// service that retires them (bridge/voice-selection.mjs).
import {spawn} from 'node:child_process';
import {join} from 'node:path';

// Is the process still running? (signal 0 only asks.) EPERM means it exists and is not ours to signal, so it is alive.
export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

const TASKKILL_GONE = 128; // "the process was not found": it exited already, which is what was wanted.

/**
 * Stops a worker and everything it started. On Windows the venv's python.exe is a launcher whose child is the real interpreter, and a plain
 * kill reaches only the launcher: the real worker would go on holding the runtime lock, so a real spawn is stopped by process tree
 * (taskkill.exe from the system folder, not from PATH, which a broken PATH or a shadowing file can get wrong). Its answer is checked: any
 * failure (it did not start, it timed out, it refused) falls back to killing the handle itself. A test's stand-in child is never handed to
 * taskkill. Resolves {via: 'tree'|'handle', ok}; never rejects, never throws.
 */
export function killProcessTree(child, {real = false, platform = process.platform, spawnImpl = spawn, env = process.env,
  timeoutMs = 4000, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  const handle = () => { try { return child.kill() !== false; } catch { return false; } };
  if (!real || platform !== 'win32' || !child?.pid) return Promise.resolve({via: 'handle', ok: handle()});
  return new Promise(done => {
    let finished = false, killer;
    const finish = result => { if (finished) return; finished = true; clearTimer(timer); done(result); };
    const fallback = () => finish({via: 'handle', ok: handle()});
    const timer = setTimer(() => { try { killer?.kill?.(); } catch {} fallback(); }, timeoutMs);
    timer?.unref?.();
    try {
      const system = env.SystemRoot || env.windir || 'C:\\Windows';
      killer = spawnImpl(join(system, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
      killer.once('error', fallback);
      killer.once('close', code => { if (code === 0 || code === TASKKILL_GONE) finish({via: 'tree', ok: true}); else fallback(); });
    } catch { fallback(); }
  });
}

/**
 * A worker whose exit was not confirmed is not necessarily alive: the late `close` event, a slow driver teardown or a lost event can all
 * leave the handle open for a process that is gone. This checks again, stopping it once more every `killMs`, and resolves true the moment
 * the process is gone (or false when `timeoutMs` has passed with it still running). The pid is the spawned process's: a development venv's python.exe is a launcher
 * whose child is the real interpreter, and if the tree kill failed and only the launcher is gone, the child may be running on (player installs run the embeddable
 * interpreter itself, which has no such child). The caller decides what stands in the way meanwhile:
 * a replacement worker waits for this, so the runtime lock and the graphics memory are never shared.
 */
export function recoverExit({child, isAlive = pidAlive, kill, schedule, timeoutMs = 120_000, pollMs = 1000, killMs = 10_000, onGone}) {
  if (!child) return Promise.resolve(true);
  return new Promise(done => {
    let waited = 0, sinceKill = 0;
    const check = () => {
      if (!isAlive(child.pid)) { try { onGone?.(); } catch {} done(true); return; }
      if (waited >= timeoutMs) { done(false); return; }
      if (sinceKill >= killMs) { sinceKill = 0; try { kill(); } catch {} }
      waited += pollMs; sinceKill += pollMs;
      schedule(check, pollMs);
    };
    check();
  });
}

/**
 * Closes a worker and confirms its exit. A close that could not confirm the exit gets `recoverExit` of the client (when it has one) before
 * it counts as failed, so one missed confirmation does not stop every later voice for the rest of the session. A client that cannot check
 * again keeps the failure, as before.
 */
export async function closeConfirmed(client, {log = () => {}, recoverMs} = {}) {
  try { await client.close(); return; }
  catch (error) {
    if (typeof client?.recoverExit !== 'function') throw error;
    try { log(`the worker exit was not confirmed (${String(error?.message ?? error).slice(0, 100)}); checking the process again`); } catch {}
    if (!(await client.recoverExit(recoverMs ? {timeoutMs: recoverMs} : {}))) throw error;
    try { log('the worker has exited after all; the next voice may start'); } catch {}
  }
}
