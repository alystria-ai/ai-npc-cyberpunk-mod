// Stopping a worker we started, and finding out whether it is really gone. Shared by the Pocket and OmniVoice clients and by the voice
// service that retires them (bridge/voice-selection.mjs).
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
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

// ---- The OmniVoice model slot after a fast game restart (docs/LOCAL_VOICES.md, "The model slot after a fast restart") -------------------------------------
// One resident voice worker owns the GPU slot at a time. The worker holds an OS lock (resident-model.lock, the only thing that can ever admit it) and, beside it,
// writes an owner record (resident-model.owner.json: pid, startedAt, heartbeatAt, state 'running' or 'exiting') that it refreshes every SLOT_WAIT.heartbeatMs and
// removes when it lets go. A game restarted fast ends the old bridge's tree and starts the new bridge a second later, so the new bridge often finds the old worker
// still going down. It used to start a worker that waited and failed, filed an error report and asked again after 45 s (triage of 2026-10-23). Now the bridge reads
// the record first: an owner that has exited, or whose heartbeat is older than staleMs, is taken over at once; one that is exiting is checked every exitPollMs;
// a live one is checked at 1, 2, 4 and 8 s (15 s in all). Only then does a worker start, so two are never started on one slot, and the OS lock stays the final say.
export const SLOT_OWNER_FILE = 'resident-model.owner.json';
export const SLOT_WAIT = Object.freeze({stepsMs: Object.freeze([1000, 2000, 4000, 8000]), exitPollMs: 100, sliceMs: 250, heartbeatMs: 2000, staleMs: 10_000});
// The bridge tells the worker how many seconds of the window it may still spend on the slot's lock (the worker reads it in main()).
export const SLOT_WAIT_VARIABLE = 'CYBERPUNK_CONVAI_SLOT_WAIT_S';
export const SLOT_WAIT_TOTAL_MS = SLOT_WAIT.stepsMs.reduce((sum, step) => sum + step, 0);
// What a start that found the slot still owned after the whole wait fails with, and what the worker itself says when the OS lock still refuses it. Both are one cause.
export const SLOT_OWNED_FAILURE = 'Local voice slot is still owned by another voice worker';
export const slotOwnedFailed = reason => /voice slot is still owned|owns the shared model slot/i.test(String(reason ?? ''));

/** Where the owner record is: beside the worker's lock, in the portable cache folder or in runtime/voice-studio-data of the install. Null when there is no folder to look in. */
export function slotOwnerFile({project, cacheDirectory} = {}) {
  if (typeof cacheDirectory === 'string' && cacheDirectory) return join(cacheDirectory, SLOT_OWNER_FILE);
  if (typeof project === 'string' && project) return join(project, 'runtime', 'voice-studio-data', SLOT_OWNER_FILE);
  return null;
}

/** The owner record, or null when there is none or it cannot be read as one (a missing, half-written or foreign file counts as no owner: the OS lock still decides). */
export function readSlotOwner(file, {read = readFileSync} = {}) {
  if (!file) return null;
  try {
    const value = JSON.parse(String(read(file, 'utf8')));
    if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.pid) || value.pid < 1 || !Number.isFinite(value.heartbeatAt)) return null;
    return {pid: value.pid, startedAt: Number.isFinite(value.startedAt) ? value.startedAt : null, heartbeatAt: value.heartbeatAt, state: value.state === 'exiting' ? 'exiting' : 'running'};
  } catch { return null; }
}

/**
 * What the record says about the slot right now: {state: 'free'} (no owner), {state: 'takeover', reason: 'exited' | 'stale'} (an owner that is gone, or that stopped
 * beating: start at once), {state: 'exiting'} (the owner is shutting down: look again in a moment) or {state: 'live'} (a worker is running: wait). Every state but
 * 'free' names the owner's `pid`. An owner that is exiting is never called stale: it is going and the slot is its until its process is gone.
 */
export function judgeSlot(owner, {now = Date.now(), alive = pidAlive, staleMs = SLOT_WAIT.staleMs} = {}) {
  if (!owner) return {state: 'free'};
  if (!alive(owner.pid)) return {state: 'takeover', reason: 'exited', pid: owner.pid};
  if (owner.state === 'exiting') return {state: 'exiting', pid: owner.pid};
  if (now - owner.heartbeatAt > staleMs) return {state: 'takeover', reason: 'stale', pid: owner.pid, ageMs: Math.max(0, Math.round(now - owner.heartbeatAt))};
  return {state: 'live', pid: owner.pid};
}

const slotChecker = ({file, now, alive, read, staleMs}) => () => judgeSlot(readSlotOwner(file, {read}), {now: now(), alive, staleMs});

/**
 * The one log line of a slot that can be used: a takeover (the owner had exited or stopped beating) or a release (the owner let go while it was waited for). Null when the
 * slot was free and nobody had owned it, so a normal start logs nothing. `owner` is the pid last seen owning it, `waitedMs` how long the start waited.
 */
export function slotLine(verdict, {waitedMs = 0, owner} = {}) {
  const after = waitedMs > 0 ? ` after ${(waitedMs / 1000).toFixed(1)} s` : '';
  if (verdict?.state === 'takeover') {
    const why = verdict.reason === 'stale' ? `its heartbeat was ${Math.round((verdict.ageMs ?? 0) / 1000)} s old` : 'it had exited';
    return `[OmniSlot] took over the voice slot from worker ${verdict.pid} (${why})${after}`;
  }
  return verdict?.state === 'free' && owner ? `[OmniSlot] the voice slot was released by worker ${owner}${after}` : null;
}

/** One look at the slot (no waiting): the verdict of `judgeSlot` for the owner record in `file`. */
export function checkModelSlot({file, now = Date.now, alive = pidAlive, read = readFileSync, staleMs = SLOT_WAIT.staleMs} = {}) {
  return slotChecker({file, now, alive, read, staleMs})();
}

/**
 * Waits for the slot while a worker owns it, up to the whole window (SLOT_WAIT_TOTAL_MS), and resolves {ok, waitedMs, verdict}: ok when it is free or can be taken over,
 * not ok when a live owner is still there at the end (verdict: the last look). The pause between looks is 100 ms while the owner is exiting and otherwise the next step
 * of 1, 2, 4, 8 s, cut short as soon as the owner starts to exit, exits or is declared stale. Exactly one log line (`slotLine`) says how it ended, none when the
 * slot was free at once. `cancelled()` ends the wait early (the voice is closing). Never throws.
 */
export async function awaitModelSlot({file, now = Date.now, alive = pidAlive, read = readFileSync, staleMs = SLOT_WAIT.staleMs, wait = SLOT_WAIT,
    sleep = ms => new Promise(done => setTimeout(done, ms)), log = () => {}, cancelled = () => false, first} = {}) {
  const look = slotChecker({file, now, alive, read, staleMs}), total = wait.stepsMs.reduce((sum, step) => sum + step, 0);
  const started = now();
  let verdict = first ?? look(), owner = verdict.pid, step = 0, waited = 0;
  const say = text => { try { log(`${text}\n`); } catch { /* a log line never changes the wait */ } };
  const elapsed = () => Math.max(0, now() - started);
  for (;;) {
    if (verdict.state === 'free' || verdict.state === 'takeover') {
      waited = elapsed();
      const line = slotLine(verdict, {waitedMs: waited, owner});
      if (line) say(line);
      return {ok: true, waitedMs: waited, verdict};
    }
    owner = verdict.pid ?? owner;
    waited = elapsed();
    if (cancelled() || waited >= total) return {ok: false, waitedMs: waited, verdict};
    const pause = verdict.state === 'exiting' ? wait.exitPollMs : Math.min(wait.stepsMs[Math.min(step++, wait.stepsMs.length - 1)], total - waited);
    // A long pause is taken in slices so that an owner that starts to exit, exits or goes stale is noticed within `sliceMs`, not at the end of the step.
    for (let left = pause; left > 0 && !cancelled();) {
      const slice = verdict.state === 'exiting' ? left : Math.min(left, wait.sliceMs);
      await sleep(slice); left -= slice;
      const next = look(), changed = next.state !== verdict.state;
      verdict = next;
      if (changed) break;
    }
  }
}
