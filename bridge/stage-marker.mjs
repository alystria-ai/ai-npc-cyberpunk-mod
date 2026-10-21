// What the bridge was doing when it ended, for the supervisor (bridge/bridge-supervisor.mjs) and the error reports (docs/ERROR_REPORTS.md).
//
// A bridge that dies natively (an access violation, an out-of-memory abort) or is ended from outside leaves no JavaScript stack. This module
// keeps one cheap fact for that case: the last thing the bridge STARTED (a turn's stage, a voice render, the microphone, the vision helper) and
// the few before it, as a name and a time. It is a small JSON file in the data folder (bridge-stage.json), rewritten at most once a second and
// only when the stage changed; the supervisor reads it after the bridge is gone. Names are fixed words, never text of a conversation.
//
// Cost: `markBridgeStage` is a null check until the bridge installs the marker; then a string compare and, when the stage changed, a
// deferred write of about 300 bytes (asynchronous, throttled). Nothing runs per frame, and nothing here is in the game process.
//
// Also here: the bridge's memory line (resident set and heap, at most every 5 minutes) and the closing write: on a normal JavaScript-level
// end (process.exit, an uncaught exception) the exit event writes `closed: true` and the exit code, so a file that is NOT closed means the
// process was ended from outside (TerminateProcess, the job object, Task Manager) or died natively.
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {getHeapStatistics} from 'node:v8';

export const STAGE_FILE = 'bridge-stage.json';
export const MEMORY_INTERVAL_MS = 5 * 60_000;
const STAGE_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,39}$/;
const MIB = 1024 * 1024;

let installed = null;

/** Notes that the bridge just started `name` (a short fixed word such as 'turn.llmSent' or 'microphone.start'). A no-op until installed. */
export function markBridgeStage(name) {
  if (installed) installed.mark(name);
}

/** The memory facts as one number each, in MiB: rss, heap used, heap total, heap limit, external. */
export function memorySnapshot({memory = () => process.memoryUsage(), heapLimit = () => getHeapStatistics().heap_size_limit} = {}) {
  const usage = memory();
  const mib = bytes => Number.isFinite(bytes) ? Math.round(bytes / MIB) : undefined;
  return {rssMiB: mib(usage.rss), heapUsedMiB: mib(usage.heapUsed), heapTotalMiB: mib(usage.heapTotal), externalMiB: mib(usage.external), heapLimitMiB: mib(heapLimit())};
}

/** "rss 412 MiB, heap 96 of 140 MiB (limit 4144 MiB), external 20 MiB, up 35 min": the one memory line. */
export function memoryLine(snapshot, uptimeSeconds) {
  return `[Memory] rss ${snapshot.rssMiB} MiB, heap ${snapshot.heapUsedMiB} of ${snapshot.heapTotalMiB} MiB (limit ${snapshot.heapLimitMiB} MiB), `
    + `external ${snapshot.externalMiB} MiB, up ${Math.round(uptimeSeconds / 60)} min`;
}

// The write is a temporary file renamed over the old one, so a process ended in the middle of it leaves the last whole copy.
async function writeAtomic(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  try { await writeFile(temporary, text); await rename(temporary, path); } catch (error) { await rm(temporary, {force: true}).catch(() => {}); throw error; }
}

export class StageMarker {
  constructor({stateDirectory, pid = process.pid, now = Date.now, minGapMs = 1000, ring = 5, setTimer = setTimeout, clearTimer = clearTimeout,
    write = writeAtomic,
    writeSync: writeNow = (path, text) => writeFileSync(path, text)} = {}) {
    Object.assign(this, {stateDirectory, pid, now, minGapMs, ring, setTimer, clearTimer, write, writeNow});
    this.path = join(stateDirectory, STAGE_FILE);
    this.startedAt = now();
    this.current = null; this.previous = []; this.memory = null; this.lastWrite = -Infinity; this.timer = null; this.dirty = false; this.closed = false;
  }

  mark(name) {
    if (this.closed || typeof name !== 'string' || !STAGE_NAME.test(name) || this.current?.name === name) return;
    if (this.current) this.previous = [...this.previous, this.current].slice(-this.ring);
    this.current = {name, at: this.now()};
    this.#schedule();
  }

  setMemory(snapshot) {
    this.memory = {...snapshot, at: this.now()};
    this.#schedule();
  }

  document(extra = {}) {
    return {version: 1, pid: this.pid, startedAt: this.startedAt, updatedAt: this.now(), stage: this.current, previous: this.previous,
      ...(this.memory ? {memory: this.memory} : {}), ...extra};
  }

  #schedule() {
    this.dirty = true;
    if (this.timer !== null) return;
    const wait = Math.max(0, this.lastWrite + this.minGapMs - this.now());
    this.timer = this.setTimer(() => { this.timer = null; void this.flush(); }, wait);
    this.timer?.unref?.();
  }

  /** Writes the file now if something changed. Never throws. */
  async flush() {
    if (!this.dirty || this.closed) return;
    this.dirty = false; this.lastWrite = this.now();
    try { await this.write(this.path, JSON.stringify(this.document())); } catch { /* a missing stage never hurts the bridge */ }
  }

  /** The process is ending in JavaScript (the exit event): one synchronous write that says so, with the exit code. */
  close(exitCode) {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    try { this.writeNow(this.path, JSON.stringify(this.document({closed: true, exitCode: Number.isFinite(exitCode) ? exitCode : null}))); } catch { /* best effort */ }
  }
}

/**
 * Starts the marker and the memory line for this process: stage marks from now on, a memory line to `log` every 5 minutes (the first one
 * after the first interval, never at start-up), and the closing write at exit. Returns {marker, stop}.
 */
export function installStageMarker({stateDirectory, log = line => console.error(line), processRef = process, now = Date.now, intervalMs = MEMORY_INTERVAL_MS,
  setRepeat = setInterval, clearRepeat = clearInterval, snapshot = memorySnapshot, uptime = () => process.uptime()} = {}) {
  if (!stateDirectory) return {marker: null, stop() {}};
  try { mkdirSync(stateDirectory, {recursive: true}); } catch { /* the first write tries again */ }
  const marker = new StageMarker({stateDirectory, now});
  installed = marker;
  marker.mark('bridge.start');
  const listener = code => marker.close(code);
  processRef.on('exit', listener);
  const repeat = setRepeat(() => {
    try {
      const memory = snapshot();
      marker.setMemory(memory);
      log(memoryLine(memory, uptime()));
    } catch { /* never fails the bridge */ }
  }, intervalMs);
  repeat?.unref?.();
  return {marker, stop() {
    clearRepeat(repeat);
    processRef.removeListener('exit', listener);
    if (installed === marker) installed = null;
  }};
}

/**
 * The marker file as the supervisor reads it after the bridge ended: null when there is none or it belongs to another process, else
 * {stage, previous, memory, closed, exitCode, startedAt, updatedAt}. Never throws.
 */
export function readStageMarker(stateDirectory, pid, {read = path => readFileSync(path, 'utf8')} = {}) {
  try {
    const value = JSON.parse(String(read(join(stateDirectory, STAGE_FILE))).replace(/^﻿/, ''));
    if (!value || typeof value !== 'object' || value.version !== 1 || (pid && value.pid !== pid)) return null;
    return value;
  } catch { return null; }
}

/** For the supervisor: removes the file of a bridge that is gone, so the next bridge starts clean. */
export function clearStageMarker(stateDirectory) {
  try { rmSync(join(stateDirectory, STAGE_FILE), {force: true}); } catch { /* it is only a diagnostic */ }
}
