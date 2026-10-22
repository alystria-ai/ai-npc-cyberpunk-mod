// Error events for the automatic error reports (docs/ERROR_REPORTS.md). This module only RECORDS: a small JSON file per error
// signature in <state>/error-reports/queue/. Sending is bridge/error-reports.mjs, run by the conversation service's supervisor,
// a separate process that outlives a crashed bridge and is never on a turn's path.
//
// Who records what:
//   * the bridge: an uncaught exception or unhandled rejection (installCrashCapture: Node's uncaughtExceptionMonitor, which does
//     not change how the process ends), a provider turn that failed for a reason that is not the player's own doing, and the
//     setup check's problems at start-up (ErrorEvents);
//   * the supervisor: the service going `failed` and a bridge that exited unexpectedly (bridge/error-reports.mjs);
//   * the game's Lua: runtime/error-events.json (mod/error-reports.lua), read by the supervisor: a service that never came up
//     (service-silent), a failure only the game saw, and the game-side setup check.
//
// Cost: nothing runs per frame or per turn. A record is one small file write, made after the event (a turn's failure reply is
// written first) and at most once per signature per bridge run. Nothing is recorded while Settings > Privacy > "Send error reports
// automatically" is off (settings.json "errorReports": false; missing means on).
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {mkdir, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import {basename, join} from 'node:path';

export const QUEUE_FOLDER = 'error-reports';
export const GAME_EVENTS_FILE = 'error-events.json';
export const QUEUE_MAX = 20;
export const EVENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TEMPORARY_MAX_AGE_MS = 60 * 60 * 1000;
export const KINDS = Object.freeze(['bridge-exception', 'bridge-rejection', 'bridge-crash', 'service-failed', 'service-silent',
  'turn-failed', 'voice-failed', 'setup-problem', 'lua-error', 'slow-turn']);
const KIND_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{16}$/;

export const SENT_FILE = 'sent.json';
export const queueDirectory = stateDirectory => join(stateDirectory, QUEUE_FOLDER, 'queue');
export const sentPath = stateDirectory => join(stateDirectory, QUEUE_FOLDER, SENT_FILE);

const controls = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const clip = (value, size) => typeof value === 'string' ? value.replace(controls, ' ').slice(0, size) : '';

// ------------------------------------------------------------------ signatures

/**
 * The message with what changes between occurrences taken out, so the same fault gives the same signature: folders (a path keeps
 * only its file name), ids, long hex runs, numbers, long quoted text, and case and spacing.
 */
export function normaliseMessage(text) {
  return clip(String(text ?? ''), 2000)
    .replace(/(?:file:\/\/\/?)?(?:[A-Za-z]:)?(?:[\\/][^\\/\s'"():<>|*?]+)+[\\/]([^\\/\s'"():<>|*?]+)/g, '$1')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(?:0x)?[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/(["'“”])[^"'“”]{41,}\1/g, '"…"')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim().toLowerCase().slice(0, 240);
}

/** The frame without its line and column numbers: the same code location across a few edits and versions. */
export const frameKey = frame => clip(String(frame ?? ''), 240).replace(/:\d+(?::\d+)?\)?$/, '').replace(/:\d+(?::\d+)?(?=\s|$)/g, '').trim().toLowerCase();

/** 16 hex characters from kind, normalised message and top frame. */
export function errorSignature({kind, message, frame}) {
  return createHash('sha256').update(`${kind}\n${normaliseMessage(message)}\n${frameKey(frame)}`).digest('hex').slice(0, 16);
}

/**
 * The useful frames of a JavaScript stack, as "file.mjs:line function": Node's own internals are left out and a path keeps only its
 * file name (a folder can hold the Windows account name). At most `limit` frames.
 */
export function stackFrames(stack, limit = 8) {
  const frames = [];
  for (const line of String(stack ?? '').split(/\r?\n/)) {
    const match = /^\s*at (?:(.+?) \()?(.+?)(?::(\d+))?(?::\d+)?\)?$/.exec(line);
    if (!match || /^node:|\(node:|internal\//.test(match[2])) continue;
    const file = basename(String(match[2]).replace(/^file:\/\/\/?/, '').replace(/\\/g, '/'));
    if (!file) continue;
    frames.push(`${file}${match[3] ? `:${match[3]}` : ''}${match[1] ? ` ${clip(match[1], 80)}` : ''}`);
    if (frames.length >= limit) break;
  }
  return frames;
}

/** An event from a thrown value: kind, its first message line, the top frame and a few more. */
export function eventFromError(error, kind, source = 'bridge') {
  const name = typeof error?.name === 'string' && error.name !== 'Error' ? `${error.name}: ` : '';
  const raw = error instanceof Error || typeof error?.message === 'string' ? error.message : String(error);
  const message = clip(`${name}${String(raw ?? '').split(/\r?\n/)[0]}`, 400) || 'unknown error';
  const stack = stackFrames(error?.stack);
  return {kind, message, frame: stack[0] ?? '', stack, source};
}

// ------------------------------------------------------------------- the setting

/**
 * What one settings file says: {on, noticed}, or null when it is not readable JSON (so the next copy is tried).
 * A missing "errorReports" means on (the default); "errorReportsNoticed" is written by the game once the in-game notice was shown.
 */
const settingsState = text => {
  try {
    const value = JSON.parse(String(text).replace(/^﻿/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    // Only a missing key or a real boolean says anything: another value (a string, a number) is not read as "on".
    if (value.errorReports !== undefined && typeof value.errorReports !== 'boolean') return null;
    return {on: value.errorReports !== false, noticed: value.errorReportsNoticed === true};
  } catch { return null; }
};

/**
 * The state of the setting from the first readable of settings.json and settings.json.previous (the previous copy stands in for a
 * file being replaced): {state: 'on' | 'off' | 'unknown', noticed}. Neither file existing is a fresh install: on, not noticed yet.
 * A file that exists but cannot be read or parsed, with no readable copy, is 'unknown': an unknown state is never treated as on,
 * so a damaged settings file cannot turn a player's opt-out back on. `readText(name)` returns the text or throws.
 */
function readSettingsState(readText) {
  let present = false;
  for (const name of ['settings.json', 'settings.json.previous']) {
    let text;
    try { text = readText(name); } catch (error) {
      if (error?.code !== 'ENOENT') present = true;
      continue;
    }
    const state = settingsState(text);
    if (state) return {state: state.on ? 'on' : 'off', noticed: state.noticed};
    present = true;
  }
  return present ? {state: 'unknown', noticed: false} : {state: 'on', noticed: false};
}

/** {state, noticed} of the error-report setting (see readSettingsState). */
export async function errorReportsSetting(runtime) {
  const texts = {};
  for (const name of ['settings.json', 'settings.json.previous']) {
    try { texts[name] = await readFile(join(runtime, name), 'utf8'); } catch (error) { texts[name] = error; }
  }
  return readSettingsState(name => { if (texts[name] instanceof Error) throw texts[name]; return texts[name]; });
}

/** True only when the setting is known to be on: an unreadable settings file is not on. */
export async function errorReportsEnabled(runtime) {
  return (await errorReportsSetting(runtime)).state === 'on';
}

/** True when reports may leave the machine: the setting is on and the in-game notice that says so was shown. */
export async function errorReportsMaySend(runtime) {
  const {state, noticed} = await errorReportsSetting(runtime);
  return state === 'on' && noticed;
}

export function errorReportsEnabledSync(runtime) {
  return readSettingsState(name => readFileSync(join(runtime, name), 'utf8')).state === 'on';
}

// ------------------------------------------------------------------- the queue

// ------------------------------------------------------------------ slow turns

const SLOW_WORD = /^[A-Za-z0-9._:-]{1,80}$/;
const SLOW_NAME = /^[A-Za-z][A-Za-z0-9]{1,23}$/;
const slowNumber = (value, max = 1e7) => Number.isFinite(value) ? Math.max(0, Math.min(max, Math.round(value * 10) / 10)) : undefined;
const slowWord = value => typeof value === 'string' && SLOW_WORD.test(value) ? value : undefined;
const without = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

function slowTurn(row) {
  if (!row || typeof row !== 'object') return null;
  const marks = {};
  if (row.marks && typeof row.marks === 'object') {
    // A mark can be a little negative (the request file was written before the bridge read it).
    for (const [name, at] of Object.entries(row.marks).slice(0, 40)) if (SLOW_NAME.test(name) && Number.isFinite(at)) marks[name] = Math.round(Math.max(-1e7, Math.min(1e7, at)));
  }
  const stalls = row.stalls && typeof row.stalls === 'object' ? without({count: slowNumber(row.stalls.count, 1000), maxMs: slowNumber(row.stalls.maxMs)}) : undefined;
  return without({n: slowNumber(row.n, 1e6), atMin: slowNumber(row.atMin, 1e6), soundMs: slowNumber(row.soundMs), provider: slowWord(row.provider),
    model: slowWord(row.model), voice: slowWord(row.voice), promptTokens: slowNumber(row.promptTokens), cachedTokens: slowNumber(row.cachedTokens),
    cold: row.cold === true ? true : undefined, stalls: stalls && Object.keys(stalls).length ? stalls : undefined,
    marks: Object.keys(marks).length ? marks : undefined});
}

/**
 * The `slow` section of a slow-turn record (bridge/slow-turns.mjs), rebuilt field by field: numbers, fixed names and nothing else, each
 * bounded, so no text can ride along. null when there is nothing usable.
 */
export function cleanSlow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rows = list => (Array.isArray(list) ? list.slice(0, 8).map(slowTurn).filter(Boolean) : []);
  const group = (object, keys, max = 1e6) => object && typeof object === 'object'
    ? without(Object.fromEntries(keys.map(key => [key, slowNumber(object[key], max)]))) : undefined;
  const background = {};
  if (value.background && typeof value.background === 'object') {
    for (const [key, count] of Object.entries(value.background).slice(0, 12)) if (/^[A-Za-z]{2,30}$/.test(key) && slowNumber(count, 1e6) !== undefined) background[key] = slowNumber(count, 1e6);
  }
  const clean = without({reason: slowWord(value.reason), thresholds: group(value.thresholds, ['windowTurns', 'slowInWindow', 'slowMs', 'extremeMs']),
    turns: slowNumber(value.turns, 1e6), excluded: group(value.excluded, ['failed', 'paused']), minutes: slowNumber(value.minutes, 1e6),
    provider: slowWord(value.provider), voice: slowWord(value.voice), freeVideoMemoryMiB: slowNumber(value.freeVideoMemoryMiB, 1e6),
    background: Object.keys(background).length ? background : undefined,
    recentSoundMs: Array.isArray(value.recentSoundMs) ? value.recentSoundMs.slice(0, 12).map(item => slowNumber(item)).filter(item => item !== undefined) : undefined,
    first: rows(value.first), slow: rows(value.slow)});
  return Object.keys(clean).length ? clean : null;
}

// ------------------------------------------------------------- a crash's facts

const crashNumber = (value, max = 1e9) => Number.isFinite(value) ? Math.max(0, Math.min(max, Math.round(value))) : undefined;
const crashList = (list, count, size) => Array.isArray(list) ? list.slice(0, count).map(item => clip(String(item ?? ''), size).trim()).filter(Boolean) : [];

/**
 * The `crash` section of a bridge-crash record (bridge/bridge-diagnostics.mjs collectCrashInfo), rebuilt field by field: the exit code in words,
 * the stage the bridge was in (fixed names), its last memory figures and the summary of Node's own report (the error's first line, a few
 * frames, heap and rss). Bounded, no conversation text. null when there is nothing usable.
 */
export function cleanCrash(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  const exit = value.exit && typeof value.exit === 'object' ? without({code: crashNumber(value.exit.code, 4294967295), hex: clip(value.exit.hex, 12) || undefined,
    meaning: clip(value.exit.meaning, 160) || undefined, signal: clip(value.exit.signal, 20) || undefined}) : null;
  if (exit && Object.keys(exit).length) result.exit = exit;
  if (value.stage && typeof value.stage === 'object') {
    const stage = without({name: clip(value.stage.name, 40) || undefined, agoS: crashNumber(value.stage.agoS, 1e7), previous: crashList(value.stage.previous, 5, 40),
      closed: typeof value.stage.closed === 'boolean' ? value.stage.closed : undefined, exitCode: Number.isFinite(value.stage.exitCode) ? Math.round(value.stage.exitCode) : undefined});
    if (stage.previous && !stage.previous.length) delete stage.previous;
    if (Object.keys(stage).length) result.stage = stage;
  }
  const figures = source => source && typeof source === 'object' ? without({rssMiB: crashNumber(source.rssMiB, 1e6), heapUsedMiB: crashNumber(source.heapUsedMiB, 1e6),
    heapTotalMiB: crashNumber(source.heapTotalMiB, 1e6), heapLimitMiB: crashNumber(source.heapLimitMiB, 1e6), agoS: crashNumber(source.agoS, 1e7)}) : {};
  const memory = figures(value.memory);
  if (Object.keys(memory).length) result.memory = memory;
  const uptime = crashNumber(value.uptimeS, 1e8);
  if (uptime !== undefined) result.uptimeS = uptime;
  if (value.nodeReport && typeof value.nodeReport === 'object') {
    const report = without({file: clip(value.nodeReport.file, 80) || undefined, event: clip(value.nodeReport.event, 80) || undefined,
      trigger: clip(value.nodeReport.trigger, 40) || undefined, error: clip(value.nodeReport.error, 200) || undefined, frames: crashList(value.nodeReport.frames, 5, 120),
      native: crashList(value.nodeReport.native, 4, 80), node: clip(value.nodeReport.node, 20) || undefined, ...figures(value.nodeReport)});
    for (const key of ['frames', 'native']) if (report[key] && !report[key].length) delete report[key];
    if (Object.keys(report).length) result.nodeReport = report;
  }
  return Object.keys(result).length ? result : null;
}

/** A queue record from an event, or null when the event is not usable. Paths in the text keep only their file names. */
export function queueRecord(event, now = Date.now()) {
  if (!event || typeof event !== 'object' || !KIND_PATTERN.test(String(event.kind ?? ''))) return null;
  const message = clip(String(event.message ?? ''), 400).trim();
  if (!message) return null;
  const frame = clip(String(event.frame ?? ''), 240);
  const signature = SIGNATURE_PATTERN.test(String(event.signature ?? '')) ? event.signature : errorSignature({kind: event.kind, message, frame});
  const stack = Array.isArray(event.stack) ? event.stack.slice(0, 8).map(line => clip(String(line), 200)) : [];
  const detail = event.detail && typeof event.detail === 'object' && !Array.isArray(event.detail)
    ? Object.fromEntries(Object.entries(event.detail).slice(0, 12).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
      .map(([key, value]) => [clip(key, 40), typeof value === 'string' ? clip(value, 200) : value]))
    : undefined;
  const at = Number.isFinite(event.at) ? event.at : now;
  const slow = event.kind === 'slow-turn' ? cleanSlow(event.slow) : null;
  const crash = event.kind === 'bridge-crash' ? cleanCrash(event.crash) : null;
  return {version: 1, signature, kind: event.kind, message, frame, stack, ...(detail ? {detail} : {}), ...(slow ? {slow} : {}), ...(crash ? {crash} : {}),
    source: clip(String(event.source ?? 'bridge'), 20), count: 1, firstAt: at, lastAt: at};
}

const merge = (old, record) => old && old.signature === record.signature
  ? {...record, count: Math.min(100000, (Number(old.count) || 1) + 1), firstAt: Number.isFinite(old.firstAt) ? old.firstAt : record.firstAt}
  : record;

/** Writes (or bumps the count of) the queue file for this event. Never throws; resolves with the record or null. */
export async function recordErrorEvent(stateDirectory, event, {now = Date.now()} = {}) {
  const record = queueRecord(event, now);
  if (!record || !stateDirectory) return null;
  try {
    const folder = queueDirectory(stateDirectory), path = join(folder, `${record.signature}.json`);
    await mkdir(folder, {recursive: true});
    let old = null;
    try { old = JSON.parse(await readFile(path, 'utf8')); } catch {}
    if (!old && (await readdir(folder)).filter(name => name.endsWith('.json')).length >= QUEUE_MAX) return null;
    const merged = merge(old, record), temporary = `${path}.${process.pid}.${now}.tmp`;
    await writeFile(temporary, JSON.stringify(merged));
    await rename(temporary, path).catch(async error => { await rm(temporary, {force: true}).catch(() => {}); throw error; });
    return merged;
  } catch { return null; }
}

/** The same, synchronously: for a process that is about to end (uncaughtExceptionMonitor). */
export function recordErrorEventSync(stateDirectory, event, {now = Date.now()} = {}) {
  const record = queueRecord(event, now);
  if (!record || !stateDirectory) return null;
  try {
    const folder = queueDirectory(stateDirectory), path = join(folder, `${record.signature}.json`);
    mkdirSync(folder, {recursive: true});
    let old = null;
    try { old = JSON.parse(readFileSync(path, 'utf8')); } catch {}
    if (!old && readdirSync(folder).filter(name => name.endsWith('.json')).length >= QUEUE_MAX) return null;
    const merged = merge(old, record), temporary = `${path}.${process.pid}.${now}.tmp`;
    writeFileSync(temporary, JSON.stringify(merged));
    try { renameSync(temporary, path); } catch (error) { try { rmSync(temporary, {force: true}); } catch {} throw error; }
    return merged;
  } catch { return null; }
}

/** The queued records, oldest first. Unreadable or expired files are removed. */
export async function readQueue(stateDirectory, {now = Date.now()} = {}) {
  const folder = queueDirectory(stateDirectory);
  let names = [];
  try {
    const all = await readdir(folder);
    names = all.filter(name => /^[0-9a-f]{16}\.json$/.test(name));
    // A write that was cut short (the process was ended between the write and the rename) leaves a .tmp file nobody reads: removed once an hour old.
    for (const name of all.filter(item => item.endsWith('.tmp'))) {
      try { if (now - (await stat(join(folder, name))).mtimeMs > TEMPORARY_MAX_AGE_MS) await rm(join(folder, name), {force: true}); } catch { /* the next look tries again */ }
    }
  } catch { return []; }
  const records = [];
  for (const name of names) {
    const path = join(folder, name);
    let record = null;
    try { record = JSON.parse(await readFile(path, 'utf8')); } catch {}
    if (!record || record.version !== 1 || `${record.signature}.json` !== name || !KIND_PATTERN.test(String(record.kind))
        || !Number.isFinite(record.lastAt) || now - record.lastAt > EVENT_MAX_AGE_MS) {
      await rm(path, {force: true}).catch(() => {});
      continue;
    }
    records.push({...record, path});
  }
  return records.sort((a, b) => a.lastAt - b.lastAt);
}

export const removeQueued = record => rm(record.path, {force: true}).catch(() => {});

export async function clearQueue(stateDirectory) {
  const folder = queueDirectory(stateDirectory);
  let names = [];
  try { names = await readdir(folder); } catch { return 0; }
  let removed = 0;
  for (const name of names) if (name.endsWith('.json') || name.endsWith('.tmp')) { await rm(join(folder, name), {force: true}).catch(() => {}); removed++; }
  return removed;
}

/**
 * For the support report: whether the setting is on, how many reports went out on the current UTC day, when the last one went, and
 * how many wait in the queue. Counts and times only.
 */
export async function errorReportStatus({runtime, stateDirectory, now = Date.now()} = {}) {
  const setting = runtime ? await errorReportsSetting(runtime) : {state: 'on', noticed: true};
  let sent = null;
  try { sent = JSON.parse(await readFile(sentPath(stateDirectory), 'utf8')); } catch {}
  let queued = 0;
  try { queued = (await readdir(queueDirectory(stateDirectory))).filter(name => /^[0-9a-f]{16}\.json$/.test(name)).length; } catch {}
  const today = new Date(now).toISOString().slice(0, 10);
  // 'unknown': settings.json cannot be read (nothing is sent). noticed: the in-game notice was shown (nothing is sent before it was).
  return {setting: setting.state, noticed: setting.noticed, sentToday: sent?.day === today && Number.isInteger(sent.count) ? sent.count : 0,
    lastSentAt: Number.isFinite(sent?.lastSentAt) ? new Date(sent.lastSentAt).toISOString() : null, queued,
    stoppedLastSession: typeof sent?.stopped === 'string' ? clip(sent.stopped, 30) : null};
}

// ------------------------------------------------------------ the game's events

/**
 * runtime/error-events.json as mod/error-reports.lua writes it: {version: 1, game: {versions...}, events: [{kind, code, detail, at}]}.
 * Returns {game, events} with only the fields named here, each short; anything else (or a damaged file) gives empty lists.
 */
export function parseGameEvents(text) {
  let value;
  try { value = JSON.parse(String(text ?? '').replace(/^﻿/, '')); } catch { return {game: {}, events: []}; }
  if (!value || typeof value !== 'object' || value.version !== 1) return {game: {}, events: []};
  const game = {};
  if (value.game && typeof value.game === 'object' && !Array.isArray(value.game)) {
    for (const key of ['game', 'cet', 'codeware', 'audioware', 'tweakxl', 'redscript', 'red4ext', 'mcm', 'scripts', 'language']) {
      if (typeof value.game[key] === 'string' && value.game[key].trim()) game[key] = clip(value.game[key].trim(), 40);
    }
    if (Array.isArray(value.game.setup)) game.setup = value.game.setup.slice(0, 16).map(line => clip(String(line), 120)).filter(Boolean);
  }
  const events = [];
  for (const row of Array.isArray(value.events) ? value.events.slice(-20) : []) {
    if (!row || typeof row !== 'object' || !KIND_PATTERN.test(String(row.kind ?? '')) || !Number.isFinite(row.at)) continue;
    const code = clip(String(row.code ?? ''), 120).trim();
    if (!code) continue;
    events.push({kind: row.kind, message: code, frame: clip(String(row.frame ?? ''), 160), at: row.at,
      detail: typeof row.detail === 'string' && row.detail.trim() ? {detail: clip(row.detail, 200)} : undefined, source: 'game'});
  }
  return {game, events};
}

// ---------------------------------------------------------------- the bridge side

/**
 * Records a crash of this process before it ends: Node's uncaughtExceptionMonitor runs for an uncaught exception and for an unhandled
 * rejection that ends the process, and leaves how the process ends unchanged. A synchronous write of one small file.
 */
export function installCrashCapture({stateDirectory, runtime, processRef = process, now = Date.now} = {}) {
  const listener = (error, origin) => {
    try {
      if (!errorReportsEnabledSync(runtime)) return;
      recordErrorEventSync(stateDirectory, eventFromError(error, origin === 'unhandledRejection' ? 'bridge-rejection' : 'bridge-exception'), {now: now()});
    } catch { /* recording never changes how the process ends */ }
  };
  processRef.on('uncaughtExceptionMonitor', listener);
  return () => processRef.removeListener('uncaughtExceptionMonitor', listener);
}

// A failed turn that is the player's own doing or not a fault: a key the provider refused, a plan or free limit used up, the daily
// allowance, the player's own server or account, a player who cancelled. Local AI that could not start because it is not installed,
// does not fit the graphics memory ('local-no-memory'), has no graphics card to run on or needs Mature content is the player's setup too.
const OWN_DOING = new Set(['mistral-key', 'mistral-limit', 'custom-key', 'custom-credits', 'custom-limit', 'custom-model', 'custom-unreachable',
  'quota-own', 'quota-shared', 'daily-limit', 'key-rejected', 'key-memory', 'key-memory-needed', 'addon-provider', 'addon-pace', 'local-no-memory',
  // The player's own model server only thinks (also when asked not to) or has a context too small for the character: what to change is in its settings.
  'local-thinking', 'local-context',
  // The browser for the conversation page would not start (bridge/system-browser.mjs): the player's own browser or its policy, named in the log.
  'browser-failed']);
const OWN_LOCAL_REASONS = new Set(['not-installed', 'low-memory', 'mature-off', 'no-gpu']);
// The codes that say Local AI could not take a turn; whether that is the player's setup depends on why (localReason).
const LOCAL_DOWN = new Set(['local-fallback', 'local-unavailable']);
// The game ending a talk is what it is for: V pressed the talk key again, walked away, opened a menu or loaded a save (the continuous speech
// lease, mod/continuous-speech.lua: an explicit stop, or no refresh while the game is paused or loading). Not the mod failing.
const NOT_A_FAULT = /\b(?:abort(?:ed)?|cancell?ed|superseded|interrupted|voice service is closed|no speech was heard|continuous speech was stopped by the game|continuous speech game lease expired|continuous speech owner changed)\b/i;

/** Whether a failed turn is worth a report (see OWN_DOING). Pure; the bridge passes what it knows. */
export function reportableTurnFailure(error, {errorCode, localReason, microphone = false} = {}) {
  if (!error) return false;
  if (error?.name === 'AbortError' || error?.name === 'TurnLimitError' || error?.code === 'ABORT_ERR') return false;
  if (typeof error?.code === 'string' && error.code.startsWith('MIC_')) return false;
  const text = typeof error?.message === 'string' ? error.message : String(error);
  if (NOT_A_FAULT.test(text)) return false;
  if (errorCode && OWN_DOING.has(errorCode)) return false;
  if (LOCAL_DOWN.has(errorCode) && OWN_LOCAL_REASONS.has(localReason)) return false;
  // A microphone turn fails for the device as often as for the service: only one that names a provider failure counts.
  if (microphone && !errorCode && !/\[(?:mistral|local|custom):|convai|timed? ?out|timeout/i.test(text)) return false;
  return true;
}

/**
 * The bridge's recorder: fire and forget, at most once per signature per bridge run and QUEUE_MAX in all, never awaited by a turn.
 * Each record first reads settings.json (the setting may have changed) and then writes one file.
 */
/**
 * How a server the player runs ended an answer that had no text, as numbers and one short word (never any text of the answer): the end-of-answer reason it gave (`stop`, `length`, ...),
 * the tokens it counted for it, the events and pieces of the stream, the seconds the answer took. An empty answer of such a server comes back in 100 ms or in seconds and the report said
 * nothing else (2026-10-22 report: a custom server that answered the summary requests empty every time).
 */
export function emptyAnswerDetail(error) {
  const trace = error?.kind === 'empty' && error?.provider === 'custom' ? error.trace : null;
  if (!trace || typeof trace !== 'object') return {};
  const whole = value => (Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);
  const finish = typeof trace.finishReason === 'string' && /^[a-z_]{1,20}$/.test(trace.finishReason) ? trace.finishReason : undefined;
  const fields = {emptyFinish: finish, emptyEvents: whole(trace.events), emptyPieces: whole(trace.pieces), emptyThinking: whole(trace.reasoning), emptyTokens: whole(trace.completionTokens), emptyMs: whole(trace.elapsedMs)};
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

export class ErrorEvents {
  constructor({stateDirectory, runtime, now = Date.now, defer = setImmediate} = {}) {
    Object.assign(this, {stateDirectory, runtime, now, defer});
    this.seen = new Set();
  }
  record(event) {
    const record = queueRecord(event, this.now());
    if (!record || this.seen.has(record.signature) || this.seen.size >= QUEUE_MAX) return;
    this.seen.add(record.signature);
    this.defer(() => {
      void errorReportsEnabled(this.runtime).then(on => on ? recordErrorEvent(this.stateDirectory, event, {now: this.now()}) : null).catch(() => {});
    });
  }
  /** A provider turn that failed (after its failure reply was written). provider: the route that answered (convai, mistral, local, custom). */
  turnFailed(error, {provider = 'convai', errorCode, localReason, microphone = false} = {}) {
    if (!reportableTurnFailure(error, {errorCode, localReason, microphone})) return;
    const base = eventFromError(error, 'turn-failed');
    this.record({...base, message: `${clip(provider, 20)}${errorCode ? ` ${errorCode}` : ''}: ${base.message}`.slice(0, 400),
      detail: {provider: clip(provider, 20), ...(errorCode ? {errorCode} : {}), ...(microphone ? {microphone: true} : {}),
        ...(localReason ? {localReason: clip(String(localReason), 40)} : {}), ...emptyAnswerDetail(error)}});
  }
  /**
   * A voice that could not start (the Pocket voice, V's own Pocket worker, OmniVoice), with the few words the worker gave. A player with no voice has
   * no other way to tell us (a 2026-10-19 report held the Pocket failure only as log lines of an unrelated setup problem). At most once per
   * distinct reason per bridge run, like every record; a retry that fails the same way adds nothing.
   */
  voiceFailed({engine, reason, gpu} = {}) {
    const name = typeof engine === 'string' && /^[a-z0-9-]{1,20}$/.test(engine) ? engine : 'voice';
    const why = clip(String(reason ?? '').split(/\r?\n/)[0], 200).trim() || 'unknown';
    // A render that ran out of time carries its worker's graphics memory (numbers only), so the report says whether the card was over-committed.
    const memory = Number.isFinite(gpu?.dedicatedMiB) && Number.isFinite(gpu?.sharedMiB)
      ? {gpuDedicatedMiB: Math.max(0, Math.round(gpu.dedicatedMiB)), gpuSharedMiB: Math.max(0, Math.round(gpu.sharedMiB))} : {};
    this.record({kind: 'voice-failed', message: `${name}: ${why}`, frame: 'voice-selection', detail: {engine: name, ...memory}});
  }
  /**
   * Replies are slow and stay slow (bridge/slow-turns.mjs decides; `data` is its report section). The message is the same every time, so
   * the kind is one signature: one report a day. Numbers and names only: no turn's text is ever passed here.
   */
  slowTurns(data) {
    const provider = slowWord(data?.provider);
    this.record({kind: 'slow-turn', message: 'Replies are slow and stay slow', frame: 'turn-clock', slow: data, ...(provider ? {detail: {provider}} : {})});
  }
  /** The setup check's document: every row in the problem state. */
  setupChecked(document) {
    for (const row of Array.isArray(document?.checks) ? document.checks.slice(0, 16) : []) {
      if (row?.state !== 'problem' || typeof row.id !== 'string' || typeof row.code !== 'string') continue;
      this.record({kind: 'setup-problem', message: `${clip(row.id, 40)} ${clip(row.code, 40)}`, frame: 'setup-check',
        detail: {...(typeof row.scripts === 'string' ? {scripts: row.scripts} : {}), ...(typeof row.runtime === 'string' ? {runtime: row.runtime} : {})}});
    }
  }
}
