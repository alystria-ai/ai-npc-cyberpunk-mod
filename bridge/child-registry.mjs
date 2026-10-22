// The model servers this bridge started, written down so that a bridge that dies hard leaves nothing running (docs/RESOURCE_LIFECYCLE.md, "Exit and lock discipline").
//
// `process.on('exit')` (bridge/convai-bridge.mjs) stops llama-server and the embedder when the bridge ends in JavaScript, but it does not run on a V8 fatal
// out-of-memory, a native crash or "End task" on node.exe. llama-server then keeps running with several GB of the graphics card's memory, and the next bridge
// starts a second one, finds the card nearly full and steps down to a smaller model or fails with "low memory".
//
// So every child we spawn is recorded in `children.json` (next to the other state files: pid, the exe's path, when it started, the bridge that owns it) and removed
// when it exits. Whoever finds an entry whose owning bridge is gone, the supervisor right after the bridge exits and the next bridge at its start, calls `reapChildren`:
//   - the entry is stopped only when ALL of these hold: its owner (a bridge pid) is no longer running, a process with that pid is running right now, its image is
//     exactly the exe path we recorded, and it started within ten seconds of the time we recorded (a pid that was handed to another program since never matches); the
//     check and the stop are ONE PowerShell call on the same process object, so a pid handed to another program between the two can never be the one that is stopped;
//   - a record is dropped only when its process was stopped, was gone or is someone else's now; one that could not be looked at (a slow PowerShell, a process we may not read)
//     stays for the next start, and records of a bridge that started meanwhile are never overwritten (the file is re-read before the dealt-with ones are removed);
//   - anything else is only dropped from the file. Nothing is ever stopped by name, by a search of the process list, or on a guess.
// The exit of what was stopped is confirmed (polled) before the line saying so is written.
import {readFileSync, writeFileSync, renameSync, mkdirSync, rmSync} from 'node:fs';
import {dirname, resolve as resolvePath} from 'node:path';
import {execFile} from 'node:child_process';
import {uptime} from 'node:os';

export const CHILDREN_FILE = 'children.json';
// The recorded start and the process's own start time may differ by this much (the record is written within milliseconds of the spawn).
export const START_TOLERANCE_MS = 10_000;

const keyOf = entry => entry.pid + ':' + entry.startedAt;
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

const run = (file, args, timeout, env) => new Promise(resolveRun => {
  execFile(file, args, {timeout, windowsHide: true, maxBuffer: 1 << 16, env: {...process.env, ...env}}, (error, stdout) => resolveRun(error ? null : String(stdout ?? '')));
});

// One PowerShell call checks and stops: the process object it looked at is the one it ends (its handle is opened first and kept, so Windows cannot give the pid to
// another program while it is held, and every later read and the stop use that handle), and only when its image is exactly the recorded exe and it started within the tolerance of the recorded time. The values come in through the environment, never
// through the command text; the pid is a checked integer.
const STOP_SCRIPT = [
  "$p = Get-Process -Id ([int]$env:CHILD_PID) -ErrorAction SilentlyContinue;",
  "if (-not $p) { 'gone' } else {",
  "  $path = $null; $start = 0;",
  "  try { $null = $p.Handle } catch { }",
  "  try { $start = [DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds() } catch { }",
  "  try { $path = $p.Path } catch { }",
  "  if (($start -ne 0) -and ([Math]::Abs($start - [int64]$env:CHILD_START) -gt [int64]$env:CHILD_TOLERANCE)) { 'foreign' }",
  "  elseif (-not $path) { 'unreadable' }",
  "  elseif ($path -ne $env:CHILD_EXE) { 'foreign' }",
  "  else { $p.Kill(); if ($p.WaitForExit([int]$env:CHILD_CONFIRM)) { 'stopped' } else { 'still-running' } }",
  "}"].join(' ');
const OUTCOMES = new Set(['gone', 'unreadable', 'foreign', 'stopped', 'still-running']);

/**
 * Stops the process `entry` describes when, and only when, it is that very process: one PowerShell call that checks the image path and the start time and ends it on the same
 * process object. Resolves 'stopped', 'still-running' (it was ours and did not exit in time), 'foreign' (another program has the pid: left alone), 'gone', or 'unreadable'
 * (not on Windows, PowerShell failed or timed out, or the process cannot be looked at: nothing was stopped). Never rejects.
 */
export async function stopIfMatching(entry, {runner = run, platform = process.platform, toleranceMs = START_TOLERANCE_MS, confirmMs = 4000, timeoutMs = 15_000} = {}) {
  try {
    if (platform !== 'win32' || !Number.isSafeInteger(entry?.pid) || entry.pid <= 0 || typeof entry.exe !== 'string' || !Number.isFinite(entry.startedAt)) return 'unreadable';
    const out = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', STOP_SCRIPT], timeoutMs,
      {CHILD_PID: String(entry.pid), CHILD_EXE: normal(entry.exe).replace(/\//g, '\\'), CHILD_START: String(Math.round(entry.startedAt)), CHILD_TOLERANCE: String(toleranceMs), CHILD_CONFIRM: String(confirmMs)});
    const word = String(out ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1);
    return OUTCOMES.has(word) ? word : 'unreadable';
  } catch { return 'unreadable'; }
}

/** Is a process running as `pid`? (Signal 0 only asks.) A process we may not look at counts as running. */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

// A record whose process could not be looked at is kept for the next start, for this long.
export const UNREADABLE_KEEP_MS = 3 * 24 * 3600_000;

/**
 * Stops the model servers a bridge that is gone left running (see the top of this file). Returns [{pid, label, outcome}] with outcome 'stopped', 'still-running',
 * 'gone' (not running any more), 'foreign' (the pid belongs to something else now: left alone), 'owner-running' (its bridge is alive: left alone), 'unreadable' or
 * 'skipped' (the \`signal\` ended the look first). A record is dropped only when its process is stopped, gone or someone else's; one that could not be looked at, that did not exit,
 * whose owner runs or that was not reached stays for the next start (an unreadable one for three days at most). The file is re-read when the work is done and only the records
 * dealt with are removed, so a bridge that started meanwhile and wrote its own keeps them. Never throws, never touches a process that does not match its record.
 */
export async function reapChildren({file, stop = stopIfMatching, alive = pidAlive, log = () => {}, signal, now = Date.now, confirmMs = 4000, toleranceMs = START_TOLERANCE_MS,
    bootedAt = Date.now() - uptime() * 1000} = {}) {
  const results = [], dealt = new Set();
  try {
    const entries = readEntries(file);
    if (!entries.length) return results;
    for (const entry of entries) {
      const note = outcome => results.push({pid: entry.pid, label: entry.label, outcome});
      if (signal?.aborted) { note('skipped'); continue; }
      if (Number.isSafeInteger(entry.bridgePid) && alive(entry.bridgePid)) { note('owner-running'); continue; }
      // A record from before this boot describes a process that cannot be running (after a crash and a restart of the PC its pid is often a system process now).
      if (!alive(entry.pid) || (Number.isFinite(entry.startedAt) && entry.startedAt < bootedAt - 60_000)) { dealt.add(keyOf(entry)); note('gone'); continue; }
      let outcome = 'unreadable';
      try { outcome = await stop(entry, {confirmMs, toleranceMs}); } catch { outcome = 'unreadable'; }
      if (outcome === 'unreadable' && now() - (entry.startedAt ?? 0) > UNREADABLE_KEEP_MS) dealt.add(keyOf(entry));
      else if (outcome !== 'unreadable' && outcome !== 'still-running') dealt.add(keyOf(entry));
      note(outcome);
      if (outcome === 'stopped' || outcome === 'still-running') {
        try { log(`[Resource] ${entry.label ?? 'child'} (PID ${entry.pid}) was left running by a bridge that ended without cleaning up: ${outcome === 'stopped' ? 'stopped, exit confirmed' : 'it did not exit'}`); } catch { /* a log never fails */ }
      }
    }
    if (dealt.size) writeEntries(file, readEntries(file).filter(entry => !dealt.has(keyOf(entry))));
  } catch { /* nothing here ever fails a start */ }
  return results;
}
