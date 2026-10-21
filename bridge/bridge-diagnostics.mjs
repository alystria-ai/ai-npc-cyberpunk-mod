// What the supervisor (bridge/bridge-supervisor.mjs) can say about a bridge that ended without a word: the exit code decoded, the newest
// Node diagnostic report (a fatal error or an uncaught exception writes one into <data>/node-reports, switched on by the supervisor's launch
// flags) boiled down to the error, a few stack frames and the memory figures, and the stage the bridge was in (bridge/stage-marker.mjs).
//
// Nothing private is read out: a report's environment variables, command line, loaded libraries and network sections are never looked at,
// and the summary holds fixed words, numbers and at most a few frame names. It runs once per unexpected bridge exit, in the supervisor, never
// on a turn's path and never in the game.
import {mkdirSync, readFileSync, readdirSync, rmSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {stackFrames} from './error-events.mjs';
import {readStageMarker} from './stage-marker.mjs';

export const REPORT_FOLDER = 'node-reports';
export const REPORT_KEEP = 5;
const REPORT_NAME = /^report\..+\.json$/i;
const REPORT_MAX_BYTES = 16 * 1024 * 1024;
const REPORT_MAX_AGE_MS = 14 * 24 * 3600_000;
const MIB = 1024 * 1024;

const clip = (value, size) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, size) : '';
const mib = bytes => Number.isFinite(bytes) && bytes >= 0 ? Math.round(bytes / MIB) : undefined;

// ------------------------------------------------------------------ the exit code

const STATUS = new Map([
  [0xC0000005, 'access violation: a native crash in Node or in a module it loaded'],
  [0xC0000409, 'fast-fail (stack buffer overrun or abort): a native crash or V8 fatal error'],
  [0xC00000FD, 'stack overflow in native code'],
  [0xC0000374, 'heap corruption in native code'],
  [0xC0000017, 'out of memory (Windows could not commit more)'],
  [0xC0000142, 'a library failed to start (DLL initialisation failed)'],
  [0xC0000135, 'a library was not found (DLL missing)'],
  [0xC000013A, 'ended by Ctrl+C or a console close'],
  [0xC000041D, 'an unhandled exception in a callback'],
  [0xE06D7363, 'an unhandled C++ exception'],
  [0x80000003, 'a breakpoint was hit'],
  [0x40010004, 'terminated by a debugger'],
  [0xFFFFFFFF, 'exit code -1: usually TerminateProcess by another program (Task Manager, an antivirus, a cleaner, a job object ending)'],
]);

/**
 * The exit code in words: {code, hex, meaning}. null for 0 and for a code that is not a number. A small code is a Node exit code
 * (1: an uncaught exception, 7: a failing exception handler, 9: a bad option, 134: abort, which is also how an out-of-memory heap ends).
 */
export function decodeExitCode(code) {
  if (typeof code !== 'number' || !Number.isFinite(code) || code === 0) return null;
  const unsigned = code < 0 ? code >>> 0 : code;
  const hex = `0x${unsigned.toString(16).toUpperCase().padStart(8, '0')}`;
  let meaning = STATUS.get(unsigned);
  if (!meaning) {
    if (unsigned === 134) meaning = 'abort (SIGABRT): a V8 fatal error, usually the heap ran out of memory';
    else if (unsigned === 3) meaning = 'abort() of the C runtime: a fatal error that ended the process';
    else if (unsigned === 1) meaning = 'an uncaught exception or a fatal error in JavaScript (see bridge.stderr.log)';
    else if (unsigned === 7) meaning = 'an error inside the exception handler';
    else if (unsigned === 9) meaning = 'Node refused a launch option';
    else if (unsigned === 12) meaning = 'a bad debugger argument';
    else if (unsigned >= 0xC0000000) meaning = 'a Windows error status';
    else if (unsigned > 128 && unsigned < 160) meaning = `ended by signal ${unsigned - 128}`;
  }
  return {code: unsigned, hex, ...(meaning ? {meaning} : {})};
}

/** "0xFFFFFFFF, exit code -1: ..." for the service log; '' when the code has no meaning to add (an ordinary small exit code). */
export function exitCodeWords(code) {
  const decoded = decodeExitCode(code);
  return decoded?.meaning ? `${decoded.hex}, ${decoded.meaning}` : '';
}

// ------------------------------------------------------------ Node's diagnostic reports

/**
 * The launch flags that make Node write a report on a fatal error and on an uncaught exception, into `directory`: compact (one line, no
 * indentation). `--report-exclude-env` (Node 22.13 and later) leaves the environment out when this process's own Node knows it, and the
 * bridge runs the same executable; another Node gets only the four flags every Node since 14 knows.
 */
export function reportArguments(directory, {nodeExecutable, ownExecutable = process.execPath, allowed = process.allowedNodeEnvironmentFlags} = {}) {
  const flags = ['--report-on-fatalerror', '--report-uncaught-exception', '--report-compact', `--report-directory=${directory}`];
  if (nodeExecutable === ownExecutable && allowed?.has?.('--report-exclude-env')) flags.push('--report-exclude-env');
  return flags;
}

/** Makes the report folder and removes old reports: the newest REPORT_KEEP stay, and none older than two weeks. Never throws. */
export function prepareReportFolder(directory, {now = Date.now()} = {}) {
  try { mkdirSync(directory, {recursive: true}); } catch { return false; }
  try {
    const rows = readdirSync(directory).filter(name => REPORT_NAME.test(name)).map(name => {
      try { return {name, time: statSync(join(directory, name)).mtimeMs}; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.time - a.time);
    for (const [index, row] of rows.entries()) if (index >= REPORT_KEEP || now - row.time > REPORT_MAX_AGE_MS) { try { rmSync(join(directory, row.name), {force: true}); } catch {} }
  } catch { /* a folder that cannot be listed is left alone */ }
  return true;
}

/**
 * A Node report's summary: {event, trigger, error, frames, native, heapUsedMiB, heapTotalMiB, heapLimitMiB, rssMiB, node}. `event` and `trigger`
 * are Node's own words ("Exception", "Allocation failed - JavaScript heap out of memory"); `error` is the first line of the JavaScript error;
 * `frames` the top JavaScript frames (file name and line, no folders); `native` the first native symbols that are not the report's own.
 */
export function summariseNodeReport(report) {
  if (!report || typeof report !== 'object') return null;
  const header = report.header ?? {}, js = report.javascriptStack ?? {}, heap = report.javascriptHeap ?? {}, usage = report.resourceUsage ?? {};
  const message = clip(String(js.message ?? '').split(/\r?\n/)[0], 200);
  const frames = stackFrames(Array.isArray(js.stack) ? js.stack.map(line => `    at ${String(line).replace(/^\s*at\s+/, '')}`).join('\n') : '', 5);
  const native = (Array.isArray(report.nativeStack) ? report.nativeStack : []).map(frame => clip(String(frame?.symbol ?? '').replace(/\+\d+$/, ''), 80))
    .filter(symbol => symbol && !/TriggerNodeReport|GetNodeReport|TriggerReport|DumpNativeStack/.test(symbol)).slice(0, 4);
  const result = {event: clip(header.event, 80), trigger: clip(header.trigger, 40), ...(message && !/^No stack\.?$/i.test(message) ? {error: message} : {}),
    ...(frames.length ? {frames} : {}), ...(native.length ? {native} : {}), heapUsedMiB: mib(heap.usedMemory), heapTotalMiB: mib(heap.totalMemory),
    heapLimitMiB: mib(heap.memoryLimit), rssMiB: mib(usage.rss), node: clip(header.nodejsVersion, 20)};
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined && value !== ''));
}

/** The newest `limit` reports in `directory` written since `since` (ms), newest first, each summarised with its file name and time. Never throws. */
export function recentNodeReports(directory, {since = 0, limit = 1} = {}) {
  const found = [];
  try {
    const rows = readdirSync(directory).filter(name => REPORT_NAME.test(name)).map(name => {
      try { const info = statSync(join(directory, name)); return info.isFile() && info.size <= REPORT_MAX_BYTES ? {name, time: info.mtimeMs} : null; } catch { return null; }
    }).filter(row => row && row.time >= since).sort((a, b) => b.time - a.time);
    for (const row of rows) {
      if (found.length >= limit) break;
      try {
        const summary = summariseNodeReport(JSON.parse(readFileSync(join(directory, row.name), 'utf8')));
        if (summary) found.push({file: row.name, at: new Date(row.time).toISOString(), ...summary});
      } catch { /* a report that was cut short is skipped */ }
    }
  } catch { /* no folder, no reports */ }
  return found;
}

/** The newest report written since `since` (ms), summarised, with its file name; null when there is none. */
export function newestNodeReport(directory, {since = 0} = {}) {
  const [report] = recentNodeReports(directory, {since, limit: 1});
  if (!report) return null;
  const {at, ...rest} = report;
  return rest;
}

// ------------------------------------------------------------------ the crash facts

/**
 * Everything the supervisor knows about a bridge that exited: {exit, stage, memory, uptimeS, nodeReport}, each only when there is something
 * to say. `pid`: the bridge process (the stage file of another process is not used); `launchedAt`: when it started (an older Node report is
 * an earlier run's).
 */
export function collectCrashInfo({stateDirectory, pid, exit, launchedAt = 0, now = Date.now()}) {
  const info = {};
  const decoded = decodeExitCode(exit?.code);
  if (decoded) info.exit = decoded;
  else if (exit?.signal) info.exit = {signal: clip(String(exit.signal), 20)};
  const marker = stateDirectory ? readStageMarker(stateDirectory, pid) : null;
  if (marker) {
    info.stage = {...(marker.stage?.name ? {name: clip(marker.stage.name, 40)} : {}),
      ...(Number.isFinite(marker.stage?.at) ? {agoS: Math.max(0, Math.round((now - marker.stage.at) / 1000))} : {}),
      previous: (Array.isArray(marker.previous) ? marker.previous : []).map(row => clip(row?.name, 40)).filter(Boolean).slice(-4),
      closed: marker.closed === true};
    if (marker.closed === true && Number.isFinite(marker.exitCode)) info.stage.exitCode = marker.exitCode;
    if (marker.memory && typeof marker.memory === 'object') {
      const {rssMiB, heapUsedMiB, heapTotalMiB, heapLimitMiB} = marker.memory;
      info.memory = Object.fromEntries(Object.entries({rssMiB, heapUsedMiB, heapTotalMiB, heapLimitMiB}).filter(([, value]) => Number.isFinite(value)));
      if (Number.isFinite(marker.memory.at)) info.memory.agoS = Math.max(0, Math.round((now - marker.memory.at) / 1000));
    }
    if (Number.isFinite(marker.startedAt)) info.uptimeS = Math.max(0, Math.round((now - marker.startedAt) / 1000));
  }
  const nodeReport = stateDirectory ? newestNodeReport(join(stateDirectory, REPORT_FOLDER), {since: Math.max(0, launchedAt - 5000)}) : null;
  if (nodeReport) info.nodeReport = nodeReport;
  return info;
}

/** The service log lines for those facts (one or two). */
export function crashLogLines(info) {
  const lines = [];
  if (info?.stage?.name) {
    const stage = info.stage;
    const how = stage.closed ? `the bridge announced its own exit${Number.isFinite(stage.exitCode) ? ` (code ${stage.exitCode})` : ''}`
      : 'the bridge did not announce an exit, so it was ended from outside or died natively';
    lines.push(`Last stage of the bridge: ${stage.name}${Number.isFinite(stage.agoS) ? `, ${stage.agoS} s before the end` : ''}`
      + `${stage.previous?.length ? `; before it: ${stage.previous.join(', ')}` : ''}; ${how}.`
      + `${info.memory?.rssMiB ? ` Last memory line: rss ${info.memory.rssMiB} MiB, heap ${info.memory.heapUsedMiB ?? '?'} of ${info.memory.heapTotalMiB ?? '?'} MiB.` : ''}`);
  }
  const report = info?.nodeReport;
  if (report) {
    lines.push(`Node report ${report.file}: ${report.event || 'report'}${report.error ? `, ${report.error}` : ''}`
      + `${report.frames?.length ? `, at ${report.frames.slice(0, 3).join(' < ')}` : ''}`
      + `${report.native?.length ? `, native ${report.native.join(' < ')}` : ''}`
      + `${Number.isFinite(report.heapUsedMiB) ? `, heap ${report.heapUsedMiB} of ${report.heapTotalMiB} MiB (limit ${report.heapLimitMiB} MiB)` : ''}`
      + `${Number.isFinite(report.rssMiB) ? `, rss ${report.rssMiB} MiB` : ''}.`);
  }
  return lines;
}
