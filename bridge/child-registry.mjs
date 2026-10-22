// The model servers this bridge started, written down so that a bridge that dies hard leaves nothing running (docs/RESOURCE_LIFECYCLE.md, "Exit and lock discipline").
//
// `process.on('exit')` (bridge/convai-bridge.mjs) stops llama-server and the embedder when the bridge ends in JavaScript, but it does not run on a V8 fatal
// out-of-memory, a native crash or "End task" on node.exe. llama-server then keeps running with several GB of the graphics card's memory, and the next bridge
// starts a second one, finds the card nearly full and steps down to a smaller model or fails with "low memory".
//
// So every child we spawn is recorded in `children.json` (next to the other state files: pid, the exe's path, when it started, the bridge that owns it) and removed
// when it exits. Whoever finds an entry whose owning bridge is gone, the supervisor right after the bridge exits and the next bridge at its start, calls `reapChildren`:
//   - the entry is stopped only when ALL of these hold: its owner (a bridge pid) is no longer running, a process with that pid is running right now, its image is
//     exactly the exe path we recorded, and it started within a minute of the time we recorded (a pid that was handed to another program since never matches);
//   - anything else is only dropped from the file. Nothing is ever stopped by name, by a search of the process list, or on a guess.
// The exit of what was stopped is confirmed (polled) before the line saying so is written.
import {readFileSync, writeFileSync, renameSync, mkdirSync, rmSync} from 'node:fs';
import {dirname, resolve as resolvePath} from 'node:path';
import {execFile} from 'node:child_process';

export const CHILDREN_FILE = 'children.json';
// The recorded start and the process's own start time may differ by this much (the record is written just after the spawn).
export const START_TOLERANCE_MS = 60_000;

const normal = path => resolvePath(String(path ?? '')).replace(/\//g, '\\').toLowerCase();

function readEntries(file) {
  try {
    const document = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(document?.children) ? document.children.filter(entry => Number.isSafeInteger(entry?.pid) && entry.pid > 0 && typeof entry.exe === 'string') : [];
  } catch { return []; }
}

function writeEntries(file, children) {
  if (!children.length) { try { rmSync(file, {force: true}); } catch { /* best effort */ } return; }
  mkdirSync(dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({version: 1, children}));
  renameSync(temporary, file);
}

export class ChildRegistry {
  constructor({file, bridgePid = process.pid, now = Date.now, log = () => {}} = {}) {
    if (!file) throw TypeError('a registry file is required');
    Object.assign(this, {file, bridgePid, now, log});
  }
  // A child was spawned. Never throws: a registry that cannot be written only loses the orphan protection.
  add({pid, exe, label = 'child'}) {
    try {
      if (!Number.isSafeInteger(pid) || pid <= 0 || !exe) return false;
      const rest = readEntries(this.file).filter(entry => entry.pid !== pid);
      writeEntries(this.file, [...rest, {pid, exe: String(exe), label: String(label).slice(0, 40), startedAt: this.now(), bridgePid: this.bridgePid}]);
      return true;
    } catch (error) { try { this.log('children.json could not be written: ' + (error?.code || error?.message)); } catch { /* a log never fails */ } return false; }
  }
  // The child exited (or was stopped on purpose).
  remove(pid) {
    try {
      const children = readEntries(this.file), rest = children.filter(entry => entry.pid !== pid);
      if (rest.length !== children.length) writeEntries(this.file, rest);
    } catch { /* best effort */ }
  }
}

const run = (file, args, timeout) => new Promise(resolveRun => {
  execFile(file, args, {timeout, windowsHide: true, maxBuffer: 1 << 16}, (error, stdout) => resolveRun(error ? null : String(stdout ?? '')));
});

/** The image path and start time (epoch ms) of the process running as `pid` right now, or null (no such process, or it cannot be read). Windows only. */
export async function imageOf(pid, {runner = run, platform = process.platform} = {}) {
  if (platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.Path; [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds() }`;
  const out = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 8000);
  const [path, start] = String(out ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return path && /^\d+$/.test(start ?? '') ? {path, startMs: Number(start)} : null;
}

/** Is a process running as `pid`? (Signal 0 only asks.) A process we may not look at counts as running. */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/**
 * Stops the model servers a bridge that is gone left running (see the top of this file). Returns [{pid, label, outcome}] with outcome 'stopped', 'still-running',
 * 'gone' (not running any more), 'foreign' (the pid belongs to something else now: left alone), 'owner-running' (its bridge is alive: left alone) or 'unreadable'.
 * Never throws, never touches a process that does not match its record.
 */
export async function reapChildren({file, image = imageOf, alive = pidAlive, kill = pid => process.kill(pid), wait = ms => new Promise(done => setTimeout(done, ms)),
    log = () => {}, confirmMs = 4000, toleranceMs = START_TOLERANCE_MS} = {}) {
  const results = [];
  try {
    const entries = readEntries(file);
    if (!entries.length) return results;
    const keep = [];
    for (const entry of entries) {
      const note = outcome => results.push({pid: entry.pid, label: entry.label, outcome});
      if (Number.isSafeInteger(entry.bridgePid) && alive(entry.bridgePid)) { keep.push(entry); note('owner-running'); continue; }
      if (!alive(entry.pid)) { note('gone'); continue; }
      let found = null;
      try { found = await image(entry.pid); } catch { found = null; }
      if (!found) { note('unreadable'); continue; }
      if (normal(found.path) !== normal(entry.exe) || !Number.isFinite(found.startMs) || Math.abs(found.startMs - (entry.startedAt ?? 0)) > toleranceMs) { note('foreign'); continue; }
      try { kill(entry.pid); } catch { /* the check below says whether it is gone */ }
      let gone = !alive(entry.pid);
      for (let waited = 0; !gone && waited < confirmMs; waited += 200) { await wait(200); gone = !alive(entry.pid); }
      if (!gone) keep.push(entry);
      note(gone ? 'stopped' : 'still-running');
      try { log(`[Resource] ${entry.label ?? 'child'} (PID ${entry.pid}) was left running by a bridge that ended without cleaning up: ${gone ? 'stopped, exit confirmed' : 'it did not exit'}`); } catch { /* a log never fails */ }
    }
    writeEntries(file, keep);
  } catch { /* nothing here ever fails a start */ }
  return results;
}
