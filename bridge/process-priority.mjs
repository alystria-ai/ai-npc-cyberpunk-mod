// One rule for process priority (docs/PROCESS_PRIORITY.md). Anything on the path from V's words to the first sound of the reply runs at HIGH priority
// (Windows HIGH_PRIORITY_CLASS, never REALTIME) so a game that keeps every core busy cannot starve it: the conversation service itself, the hidden browser
// (it plays the reply and hears the microphone), the OmniVoice worker, the Local AI model server while a turn waits on it, the Pocket worker while it voices a
// reply and the local speech recognition worker. Work nobody waits for (memory work, the embedder, a voice prepared ahead, report upload, downloads, probes)
// stays at normal or below. The player's way back, if the game stutters: a line `priority = normal` in priority.txt (below), or in omni-python.txt for the
// OmniVoice worker alone (bridge/omni-own-python.mjs); `CYBERPUNK_CONVAI_PRIORITY=normal` in the environment does the same for a developer.
//
// A level is 'high' (the default), 'normal' (what the mod did before this rule: workers are raised to normal while they work, nothing else is touched) or
// 'below' (below normal for the OmniVoice worker; everything else treats it as 'normal').
//
// Every process is set two ways, because a venv's python.exe is a launcher whose child is the real worker: the parent sets the child it spawned (setProcessPriority),
// and the worker sets itself when its environment names a level (PRIORITY_VARIABLE, read by the Python workers). Both are best effort: a refusal never fails a start.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {setPriority as osSetPriority, constants as osConstants} from 'node:os';

export const PRIORITY_FILE = 'priority.txt';
export const PRIORITY_ENVIRONMENT = 'CYBERPUNK_CONVAI_PRIORITY';
// Told to a Python worker by the bridge: the level it takes itself (resident-voice-worker.py, pocket-voice-worker.py, local-stt-worker.py).
export const PRIORITY_VARIABLE = 'CYBERPUNK_CONVAI_WORKER_PRIORITY';
export const PRIORITY_LEVELS = Object.freeze(['high', 'normal', 'below']);
export const DEFAULT_PRIORITY = 'high';

/** 'high', 'normal' or 'below' from a word (case and spaces ignored), else null. Pure. */
export function priorityLevel(value) {
  const word = String(value ?? '').trim().toLowerCase();
  return PRIORITY_LEVELS.includes(word) ? word : null;
}

/** The level a priority.txt names: the first `priority = <level>` (or `priority: <level>`) line that is not a # comment. null when there is none. Pure. */
export function parsePriorityText(text) {
  for (const row of String(text ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = row.trim();
    if (!line || line.startsWith('#')) continue;
    const found = /^priority\s*[=:]\s*([A-Za-z]{1,12})$/i.exec(line);
    const level = found ? priorityLevel(found[1]) : null;
    if (level) return level;
  }
  return null;
}

/**
 * The level for this PC: the developer's environment variable, else `<state>/priority.txt`, else the default (high). Read once when the service starts (a small
 * file, nothing per turn). {level, source: 'environment' | 'file' | 'default'}. Never throws.
 */
export function readTurnPriority({stateDirectory, environment = process.env, readFile = readFileSync} = {}) {
  const fromEnvironment = priorityLevel(environment?.[PRIORITY_ENVIRONMENT]);
  if (fromEnvironment) return {level: fromEnvironment, source: 'environment'};
  if (stateDirectory) {
    let text = null;
    try { text = String(readFile(resolve(stateDirectory, PRIORITY_FILE), 'utf8')).slice(0, 4096); } catch { /* no file: the default */ }
    const fromFile = parsePriorityText(text);
    if (fromFile) return {level: fromFile, source: 'file'};
  }
  return {level: DEFAULT_PRIORITY, source: 'default'};
}

/** Node's priority number for a level. 'high' is PRIORITY_HIGH (Windows HIGH_PRIORITY_CLASS), never PRIORITY_HIGHEST (that one is REALTIME). */
export function nodePriority(level) {
  const { priority } = osConstants;
  if (level === 'high') return priority.PRIORITY_HIGH;
  if (level === 'below') return priority.PRIORITY_BELOW_NORMAL;
  return priority.PRIORITY_NORMAL;
}

/** Sets a process's priority class. True when it was set; a refusal, a gone process or a bad pid is false, never an exception. */
export function setProcessPriority(pid, level, setPriority = osSetPriority) {
  if (!Number.isSafeInteger(pid) || pid < 0 || !PRIORITY_LEVELS.includes(level)) return false;
  try { setPriority(pid, nodePriority(level)); return true; } catch { return false; }
}

/** The environment a Python worker needs to take its own level (the parent also sets the child by pid). {} for 'normal'. Pure. */
export function priorityEnvironment(level) {
  return level === 'high' || level === 'below' ? {[PRIORITY_VARIABLE]: level} : {};
}

// The hidden browser is a tree (browser, GPU, audio service, one renderer per page) and Playwright does not hand out pids, so one PowerShell call raises the
// browser this bridge started: the children of this process whose command line carries Playwright's debugging pipe, and everything below them. The values come in
// through the environment, never through the command text. Prints how many processes were set.
const TREE_SCRIPT = [
  "$root = [int]$env:PRIORITY_ROOT; $level = $env:PRIORITY_CLASS;",
  "$all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine);",
  "$ids = New-Object 'System.Collections.Generic.HashSet[int]'; $queue = New-Object 'System.Collections.Generic.Queue[int]';",
  "foreach ($p in $all) { if (($p.ParentProcessId -eq $root) -and ($p.CommandLine -like '*--remote-debugging-*')) { if ($ids.Add([int]$p.ProcessId)) { $queue.Enqueue([int]$p.ProcessId) } } }",
  "while ($queue.Count -gt 0) { $next = $queue.Dequeue(); foreach ($p in $all) { if (($p.ParentProcessId -eq $next) -and $ids.Add([int]$p.ProcessId)) { $queue.Enqueue([int]$p.ProcessId) } } }",
  "$done = 0; foreach ($id in $ids) { try { (Get-Process -Id $id -ErrorAction Stop).PriorityClass = $level; $done++ } catch { } }",
  "$done"].join(' ');
const TREE_CLASSES = {high: 'High', normal: 'Normal', below: 'BelowNormal'};

const runPowerShell = (script, env, timeout) => new Promise(done => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {timeout, windowsHide: true, maxBuffer: 1 << 14, env: {...process.env, ...env}},
    (error, stdout) => done(error ? null : String(stdout ?? '')));
});

/** Sets the hidden browser's whole process tree (see TREE_SCRIPT). Resolves the number of processes set, or null (not Windows, PowerShell failed). Never rejects. */
export async function setBrowserTreePriority(level, {rootPid = process.pid, platform = process.platform, run = runPowerShell, timeoutMs = 15_000} = {}) {
  try {
    if (platform !== 'win32' || !TREE_CLASSES[level] || !Number.isSafeInteger(rootPid) || rootPid < 1) return null;
    const out = await run(TREE_SCRIPT, {PRIORITY_ROOT: String(rootPid), PRIORITY_CLASS: TREE_CLASSES[level]}, timeoutMs);
    const count = Number.parseInt(String(out ?? '').trim().split(/\r?\n/).at(-1), 10);
    return Number.isInteger(count) && count >= 0 ? count : null;
  } catch { return null; }
}

/**
 * Keeps the hidden browser's tree at the level: `request()` after the browser started and after a page opened (a new page has a new renderer). Calls are joined: at most one
 * PowerShell call at a time and one per `gapMs`, the last request always gets its turn. Off the turn's path (nothing awaits it), nothing per frame. Only 'high' does anything:
 * the browser is left as it started for 'normal' and 'below'.
 */
export class BrowserPriority {
  constructor({level = 'high', rootPid = process.pid, setTree = setBrowserTreePriority, gapMs = 4000, settleMs = 400, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {}} = {}) {
    Object.assign(this, {level, rootPid, setTree, gapMs, settleMs, now, setTimer, clearTimer, log});
    this.timer = null; this.running = false; this.again = false; this.last = -Infinity; this.closed = false; this.reported = false;
  }
  request() {
    if (this.closed || this.level !== 'high') return;
    if (this.running) { this.again = true; return; }
    if (this.timer) return;
    // Wait for the browser's new processes to exist, and keep the gap between two calls.
    const wait = Math.max(this.settleMs, this.last + this.gapMs - this.now());
    this.timer = this.setTimer(() => { this.timer = null; void this.#run(); }, wait);
    this.timer?.unref?.();
  }
  async #run() {
    if (this.closed) return;
    this.running = true; this.again = false;
    let count = null;
    try { count = await this.setTree(this.level, {rootPid: this.rootPid}); } catch { count = null; }
    this.last = this.now(); this.running = false;
    if (!this.reported) {
      this.reported = true;
      try { this.log(count === null ? 'hidden browser priority: could not be set' : `hidden browser priority: high for ${count} process${count === 1 ? '' : 'es'}`); } catch { /* a log never fails */ }
    }
    if (this.again) this.request();
  }
  // The browser went away (its host closed; it may start again, and asks again then): nothing more is scheduled for it.
  cancel() { this.clearTimer(this.timer); this.timer = null; this.again = false; }
  close() { this.closed = true; this.cancel(); }
}
