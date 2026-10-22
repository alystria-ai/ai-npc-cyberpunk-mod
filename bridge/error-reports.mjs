// Automatic error reports (docs/ERROR_REPORTS.md): when the mod hits an error, a small redacted report goes to the project's backend
// (auth-backend/, POST /api/errors/report) so the developer sees the problem without asking the player for logs. On by default;
// Settings > Privacy > "Send error reports automatically" turns it off, and then nothing is recorded or sent, and anything queued is
// deleted.
//
// Who runs it: the conversation service's supervisor (bridge/bridge-supervisor.mjs), a separate process for the whole game session.
// It outlives a crashed bridge, and it is never on a turn's path, so a report costs a turn nothing. The bridge and the game only
// record events (bridge/error-events.mjs, mod/error-reports.lua); this module turns them into reports and sends them.
//
// When: a supervisor event (the service failed, the bridge exited unexpectedly) is sent 15 s after it happens; everything else is
// looked at once a minute after start-up and then every five minutes (one directory listing, two file sizes). Nothing runs per frame.
//
// Throttles: one report per error signature per installation per UTC day; twenty reports per installation per UTC day (the backend allows more,
// auth-backend/api/_lib/config.js errorInstallPerDay, so the day's edges never refuse one); every request
// has a 10 s timeout; a failed send waits 15 minutes and three failures stop it for the session; a 404 (a backend without this
// endpoint), a 401 or a 429 stops it for the session. Nothing is retried in a loop.
//
// What a report holds (buildErrorPayload): the signature, the error's kind, message and top frames; versions (Scripts, Runtime, game,
// CET, RED4ext, redscript, Codeware, ArchiveXL, Node, Windows); the provider, voice and Local AI model choices;
// Mature content as on or off only; the graphics card name and memory, the PC's total RAM and its commit limit (RAM plus paging files); the setup check's lines; whether the Runtime's code files match the release
// (counts and up to five file names, bridge/runtime-integrity.mjs, worked out when the report is built); for a bridge crash, the exit code in words,
// the stage the bridge was in and the summary of Node's own report (bridge/bridge-diagnostics.mjs); up to 150 log lines around the error
// (bridge stderr, the service log, the launcher, the mod's own logs, the redscript log's error lines); the install id hashed again.
// Never: keys, tokens, conversation text, memories, typed lines, audio, the Windows user name. Every text goes through the support
// report's redactor (bridge/support-report.mjs) with every key file's value as a literal to scrub, then a filter that removes
// anything that looks like conversation text (long quoted text, text=/reply=/prompt= values), then the user name.
import {createHash} from 'node:crypto';
import {mkdir, open, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import os from 'node:os';
import {accountNames, createRedactor, credentialSecrets, customServerSecrets, setupLine, tailFile} from './support-report.mjs';
export {accountNames};
import {dataFolderSecrets, pluginVersions} from './report-secrets.mjs';
import {cachedGraphicsCards, cachedMemoryFacts} from './setup-check.mjs';
import {checkRuntimeFiles} from './runtime-integrity.mjs';
import {AUTH_CONFIG_FILE, INSTALL_FILE, loadInstallId, readBackendAddress, signRequest} from './convai-credential.mjs';
import {GAME_EVENTS_FILE, QUEUE_FOLDER, attachLogs, cleanSlow, clearQueue, errorReportsEnabled, errorReportsSetting, parseGameEvents, readQueue, recordErrorEvent,
  removeQueued, sentPath} from './error-events.mjs';

export const REPORT_PATH = '/api/errors/report';
export const DAILY_LIMIT = 20;
export const MAX_BODY_BYTES = 60 * 1024;
export const MAX_LOG_LINES = 150;
export const TIMINGS = Object.freeze({timeoutMs: 10_000, firstFlushMs: 60_000, debounceMs: 15_000, retryMs: 15 * 60_000,
  tickMs: 5 * 60_000, maxFailures: 3, crashPairMs: 30_000});
const LINE_LIMIT = 300;
// `engine` and the graphics-memory numbers are what ErrorEvents.voiceFailed records (they never reached a report before: the voice reports of 2026-10-22 all had an empty detail), the `empty*` ones
// how a server the player runs ended an answer with no text (emptyAnswerDetail in bridge/error-events.mjs): a short word and counts, never text.
const DETAIL_KEYS = new Set(['provider', 'errorCode', 'localReason', 'microphone', 'log', 'context', 'scripts', 'runtime', 'detail',
  'engine', 'gpuDedicatedMiB', 'gpuSharedMiB', 'emptyFinish', 'emptyEvents', 'emptyPieces', 'emptyThinking', 'emptyTokens', 'emptyMs']);
const VERSION = /^\d{1,6}(?:\.\d{1,6}){1,3}(?:[-+][0-9A-Za-z.-]{1,30})?$/;
// Log sources, in the order they appear in a report, with their share of the 150 lines. `anchor`: the lines around the error's own
// message are taken when it is found in the file (else the end of the file); `errors`: only error lines.
const LOG_SOURCES = [
  {id: 'bridge-stderr', lines: 70, anchor: true},
  {id: 'service', lines: 20},
  {id: 'launcher', lines: 10},
  {id: 'probe', lines: 25, anchor: true},
  {id: 'cet-mod', lines: 15},
  {id: 'redscript', lines: 10, errors: true},
];

const clip = (value, size = 120) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, size) : undefined;
const today = now => new Date(now).toISOString().slice(0, 10);
export const hashInstall = installId => createHash('sha256').update(`error-report:v1:${installId}`).digest('hex').slice(0, 32);

// ------------------------------------------------------------------ the address

// The backend's address and signing secret as a release ships them: app/defaults/error-reports.json in the Runtime package,
// {"version": 1, "url": "https://<deployment>", "secret": "<the deployment's ERROR_REPORT_SECRET>"} (never the token signing secret, which ships in
// convai-auth.json). Added to the Runtime by hand, not by the release build; the repository has none. Only the url's origin is used. The secret is obfuscation, not authentication (auth-backend/README.md).
export const PACKAGED_TARGET_FILE = join('defaults', 'error-reports.json');

/** The packaged address, {url, secret}, or null when the file is missing, damaged, not https (or a local address) or its secret is short. */
export async function packagedTarget({project, readText = path => readFile(path, 'utf8')} = {}) {
  if (!project) return null;
  try {
    const value = JSON.parse((await readText(join(project, PACKAGED_TARGET_FILE))).replace(/^﻿/, ''));
    const secret = typeof value?.secret === 'string' ? value.secret.trim() : '';
    const url = new URL(typeof value?.url === 'string' ? value.url.trim() : '');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (secret.length < 16 || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) return null;
    return {url: url.href, secret};
  } catch { return null; }
}

/**
 * Where reports go: /api/errors/report on the first backend address that comes with a secret, signed with that secret:
 *   1. the sign-in backend's own settings (the environment or convai-auth.json in the data folder, bridge/convai-credential.mjs; backend
 *      mode does not have to be on): a developer's machine;
 *   2. app/defaults/error-reports.json (packagedTarget): a released Runtime.
 * CYBERPUNK_CONVAI_ERRORS_URL replaces the address (not the secret). null when no source has both: then nothing is sent and events
 * wait in the queue (for at most a week).
 */
export async function reportTarget({env = process.env, stateDirectory, project, readText} = {}) {
  const configured = await readBackendAddress({env, ...(readText ? {readText} : {}), ...(stateDirectory ? {path: join(stateDirectory, AUTH_CONFIG_FILE)} : {})});
  const packaged = await packagedTarget({project, ...(readText ? {readText} : {})});
  const explicit = String(env.CYBERPUNK_CONVAI_ERRORS_URL ?? '').trim();
  const address = configured?.url ? configured : packaged ?? (explicit && configured ? configured : null);
  if (!address) return null;
  let url;
  try { url = explicit ? new URL(explicit) : address.url ? new URL(REPORT_PATH, new URL(address.url).origin) : null; } catch { return null; }
  if (!url) return null;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local))) return null;
  return {url: url.href, secret: address.secret};
}

// ------------------------------------------------------------------ redaction

// Quoted text of 12 characters or more with a space in it reads like a sentence (an identifier or a short name has no space): removed.
const QUOTED = /(["“‘'])([^"“”‘’'\r\n]{12,}?)(["”’'])/g;
const CONTENT_VALUE = /\b((?:user|player|reply|response|input|output)?[-_ ]?(?:text|reply|replies|prompt|transcript|utterance|heard|caption|subtitle|said|content)s?)(\s*[:=]\s*)(?!\s*(?:\d|true\b|false\b|null\b|none\b|\[))[^\r\n]*/gi;
const CONTENT_JSON = /("(?:text|reply|userText|playerText|prompt|transcript|utterance|heard|content|caption|subtitle|said|input|output)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

/** Removes what could be conversation text from one line: quoted sentences, and the values of text-like fields. */
export function withoutConversation(line) {
  return String(line ?? '')
    .replace(CONTENT_JSON, '$1"[text removed]"')
    .replace(QUOTED, (match, open, inner, close) => /\s/.test(inner) ? `${open}[text removed]${close}` : match)
    .replace(CONTENT_VALUE, (match, name, separator) => `${name}${separator}[text removed]`);
}

/** text -> redacted text: the support report's redactor, then the conversation filter, then the account names. */
export function reportCleaner({secrets = [], ids = [], names = accountNames()} = {}) {
  // Every name counts as a path part (even a two-letter one, as in D:\Jo\Games); only names of three or more characters are also hidden anywhere in a line.
  const redact = createRedactor({secrets, ids, accounts: names});
  const patterns = names.filter(name => name.length >= 3).map(name => new RegExp(`(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'gi'));
  const clean = text => {
    let value = withoutConversation(redact.text(String(text ?? '')));
    for (const pattern of patterns) value = value.replace(pattern, '<user>');
    return value;
  };
  return {clean, stats: redact.stats};
}

// ------------------------------------------------------------------ the payload

async function readJson(path, maxBytes = 262144) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) return null;
    return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''));
  } catch { return null; }
}

async function headOf(path, bytes = 65536) {
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(bytes);
    const {bytesRead} = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return ''; } finally { await handle?.close().catch(() => {}); }
}

async function newestFile(directory, pattern) {
  try {
    const rows = [];
    for (const name of (await readdir(directory)).filter(item => pattern.test(item))) rows.push({name, time: (await stat(join(directory, name))).mtimeMs});
    rows.sort((a, b) => b.time - a.time);
    return rows[0] ? join(directory, rows[0].name) : null;
  } catch { return null; }
}

export function logPaths({game, modRoot, runtime, stateDirectory}) {
  return {
    'bridge-stderr': stateDirectory ? join(stateDirectory, 'bridge.stderr.log') : null,
    service: stateDirectory ? join(stateDirectory, 'bridge-service.log') : null,
    launcher: game ? join(game, 'red4ext', 'plugins', 'AiNpcCyberpunkMod', 'launcher.log') : null,
    probe: runtime ? join(runtime, 'probe.log') : null,
    'cet-mod': modRoot ? join(modRoot, 'AiNpcCyberpunkMod.log') : null,
    redscript: game ? join(game, 'r6', 'logs', 'redscript_rCURRENT.log') : null,
  };
}

async function collectVersions({game, modRoot, project, gameInfo = {}}) {
  const release = async path => { const value = await readJson(path, 65536); return typeof value?.version === 'string' ? clip(value.version, 40) : null; };
  let runtimeVersion = project ? await release(join(project, 'release.json')) : null;
  if (!runtimeVersion && project) runtimeVersion = await release(join(project, 'package.json'));
  const versions = {runtime: runtimeVersion, scripts: (modRoot ? await release(join(modRoot, 'release.json')) : null) ?? gameInfo.scripts ?? null};
  for (const key of ['game', 'cet', 'codeware', 'redscript', 'mcm']) versions[key] = gameInfo[key] ?? null;
  // RED4ext writes the game version and every plugin it loaded at the top of its session log.
  const red4ext = game ? await newestFile(join(game, 'red4ext', 'logs'), /^red4ext-.+\.log$/i) : null;
  if (red4ext) {
    const text = await headOf(red4ext);
    const plugins = pluginVersions(text);
    versions.red4ext = plugins.red4ext;
    for (const [id, name] of [['codeware', 'codeware'], ['archivexl', 'archivexl']]) {
      versions[id] ??= plugins.plugins.get(name) ?? null;
    }
    versions.game ??= clip(/Product version:\s*(\S+)/.exec(text)?.[1], 30) ?? null;
  }
  if (!versions.cet && game) {
    const cet = await tailFile(join(game, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'cyber_engine_tweaks.log'), {maxBytes: 262144, maxLines: 4000});
    for (const line of cet?.lines ?? []) { const match = /CET version (\S+)/.exec(line); if (match) versions.cet = clip(match[1], 30); }
  }
  versions.node = process.version;
  versions.os = `${process.platform} ${os.release()} ${process.arch}`;
  return Object.fromEntries(Object.entries(versions).filter(([, value]) => value !== null && value !== undefined));
}

async function collectChoices({runtime, gameInfo = {}}) {
  const settings = await readJson(join(runtime, 'settings.json')) ?? await readJson(join(runtime, 'settings.json.previous')) ?? {};
  const state = await readJson(join(runtime, 'mistral-state.json')) ?? {};
  const voice = await readJson(join(runtime, 'local-voice-state.json')) ?? {};
  const word = (value, size = 40) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(value) ? clip(value, size) : undefined;
  return {
    provider: word(settings.conversationProvider) ?? 'convai',
    effective: word(state.effective),
    voice: word(settings.voiceProvider),
    voiceActive: word(voice.provider),
    voiceState: word(voice.state),
    omniSteps: Number.isInteger(settings.omniSteps) ? settings.omniSteps : undefined,
    omniReference: word(settings.omniReference),
    localModel: word(settings.localModel, 80),
    localAi: word(state.localAi),
    // Mature content is reported as on or off, nothing more.
    matureContent: settings.matureContent === true,
    language: word(settings.uiLanguage) ?? gameInfo.language,
  };
}

async function collectSetup({runtime, gameInfo = {}, now}) {
  const lines = [];
  const check = await readJson(join(runtime, 'setup-check.json'));
  if (check && Array.isArray(check.checks) && Number.isFinite(check.updated) && now - check.updated < 24 * 3600_000) {
    for (const row of check.checks.slice(0, 16)) {
      if (typeof row?.id !== 'string' || typeof row?.code !== 'string') continue;
      lines.push(row.state === 'problem' ? setupLine(row) ?? `${row.id}: problem ${row.code}` : `${clip(row.id, 40)}: ${clip(String(row.state), 20)} ${clip(row.code, 40)}`);
    }
  }
  for (const line of gameInfo.setup ?? []) lines.push(`game ${line}`);
  return lines.slice(0, 24);
}

/** The same value with every string put through `clean` (the redactor), whatever the nesting. */
function cleanStrings(value, clean) {
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map(item => cleanStrings(item, clean));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanStrings(item, clean)]));
  return value;
}

const needleOf = message => String(message ?? '').replace(/^\w*Error: /, '').replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 48);

async function collectLogs({paths, record, clean}) {
  const result = [];
  const needle = needleOf(record.message);
  for (const source of LOG_SOURCES) {
    const path = paths[source.id];
    if (!path) continue;
    const tail = await tailFile(path, {maxBytes: 1024 * 1024, maxLines: 4000});
    if (!tail?.lines.length) continue;
    let lines = tail.lines;
    if (source.errors) lines = lines.filter(line => /\[ERROR|\berror\b/i.test(line)).slice(-source.lines);
    else {
      let at = -1;
      if (source.anchor && needle.length >= 8) for (let index = lines.length - 1; index >= 0 && at < 0; index--) if (lines[index].includes(needle)) at = index;
      if (at >= 0) {
        const before = Math.round(source.lines * 0.7);
        const start = Math.max(0, Math.min(at - before, lines.length - source.lines));
        lines = lines.slice(start, start + source.lines);
      } else lines = lines.slice(-source.lines);
    }
    const cleaned = lines.map(line => clean(line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT)} [cut]` : line)).filter(line => line.trim() !== '');
    if (cleaned.length) result.push({source: source.id, lines: cleaned});
  }
  return result;
}

/**
 * The log excerpt of a queued record, as it is kept in its queue file (error-events.mjs attachLogs): read and scrubbed NOW, with the same
 * sources, the same line counts and the same redactor as a sent report, so that a report that waits sends the lines of the moment the event was
 * seen. Used by the reporter at every look; buildErrorPayload uses the kept excerpt when the record has one.
 */
export async function captureLogs({record, game, modRoot, runtime, stateDirectory, secrets, names}) {
  const {clean} = reportCleaner({secrets, ...(names ? {names} : {})});
  return collectLogs({paths: logPaths({game, modRoot, runtime, stateDirectory}), record, clean});
}

// A kept excerpt, checked again and put through the redactor once more (the file is the player's to edit): known sources only, the share of lines
// each source has, text lines only.
function keptLogs(logs, clean) {
  const shares = new Map(LOG_SOURCES.map(source => [source.id, source.lines]));
  const out = [];
  for (const item of Array.isArray(logs) ? logs.slice(0, LOG_SOURCES.length) : []) {
    if (!item || typeof item.source !== 'string' || !shares.has(item.source) || !Array.isArray(item.lines)) continue;
    const lines = item.lines.slice(-shares.get(item.source)).filter(line => typeof line === 'string')
      .map(line => clean(line.length > LINE_LIMIT + 6 ? `${line.slice(0, LINE_LIMIT)} [cut]` : line)).filter(line => line.trim() !== '');
    if (lines.length) out.push({source: item.source, lines});
  }
  return out;
}

/** Every value to scrub: the key files of the data folder, the sign-in file's secret, the custom servers' keys, the packed key. */
export async function reportSecrets({stateDirectory, project, environment = process.env, extra = []}) {
  const found = [...extra];
  const packaged = await packagedTarget({project});
  if (packaged) found.push(packaged.secret);
  for (const list of await Promise.all([credentialSecrets(stateDirectory).catch(() => []),
    customServerSecrets({project, environment}).catch(() => []), dataFolderSecrets({stateDirectory, project}).catch(() => [])])) found.push(...list);
  return found;
}

/**
 * The report body for one queued record. Pure apart from reading the files named here; nothing is written. The caller signs and sends
 * it. The JSON is at most MAX_BODY_BYTES (log lines are dropped, oldest first from the largest source, until it fits).
 */
export async function buildErrorPayload({record, game, modRoot, runtime, stateDirectory, project, installId, gameInfo = {}, secrets,
  graphics = () => cachedGraphicsCards(), memory = () => cachedMemoryFacts(), integrity = () => checkRuntimeFiles({project}), environment = process.env, names, now = Date.now}) {
  const scrub = secrets ?? await reportSecrets({stateDirectory, project, environment});
  const {clean, stats} = reportCleaner({secrets: scrub, ...(names ? {names} : {})});
  const versions = await collectVersions({game, modRoot, project, gameInfo});
  const cards = await Promise.resolve().then(() => typeof graphics === 'function' ? graphics() : graphics).catch(() => []);
  const gpu = (Array.isArray(cards) ? cards : []).slice(0, 4)
    .map(card => ({name: clean(clip(card?.name, 120) ?? ''), memoryMiB: Number.isFinite(card?.memoryMiB) && card.memoryMiB > 0 ? Math.round(card.memoryMiB) : null}))
    .filter(card => card.name);
  // Total RAM and the commit limit (RAM plus the paging files): what tells a "paging file is too small" failure (error 1455) from another one. Read once per bridge process.
  const facts = await Promise.resolve().then(() => typeof memory === 'function' ? memory() : memory).catch(() => null);
  const wholeMiB = value => Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  // Only the detail fields the recorders write (codes, versions, the log a Lua error was found in and the mod's own label before it).
  const detail = record.detail && typeof record.detail === 'object'
    ? Object.fromEntries(Object.entries(record.detail).filter(([key]) => DETAIL_KEYS.has(key))
      .map(([key, value]) => [key, typeof value === 'string' ? clean(value).slice(0, 200) : value])) : undefined;
  const runtimeVersion = VERSION.test(versions.runtime ?? '') ? versions.runtime : '0.0.0-dev';
  const payload = {
    schema: 1,
    install: hashInstall(installId),
    signature: record.signature,
    kind: record.kind,
    message: clean(record.message).slice(0, 400) || record.kind,
    ...(record.frame ? {frame: clean(record.frame).slice(0, 240)} : {}),
    modVersion: runtimeVersion,
    count: Math.max(1, Math.min(100000, Number(record.count) || 1)),
    report: {
      source: clip(record.source, 20),
      firstAt: new Date(record.firstAt).toISOString(), lastAt: new Date(record.lastAt).toISOString(), sentAt: new Date(now()).toISOString(),
      stack: (record.stack ?? []).map(line => clean(line)),
      ...(detail ? {detail} : {}),
      // A slow-turn record's timings (bridge/slow-turns.mjs): numbers and fixed names, rebuilt again by cleanSlow when it was queued.
      ...(record.kind === 'slow-turn' && record.slow ? {slow: cleanStrings(cleanSlow(record.slow), clean)} : {}),
      versions,
      // A crash's facts (the exit code decoded, the bridge's last stage, Node's own report): rebuilt field by field when the event was recorded.
      ...(record.kind === 'bridge-crash' && record.crash ? {crash: cleanStrings(record.crash, clean)} : {}),
      runtimeFiles: cleanStrings(await Promise.resolve().then(() => integrity()).catch(() => ({state: 'unavailable'})), clean),
      choices: await collectChoices({runtime, gameInfo}),
      system: {gpu, totalRamMiB: wholeMiB(facts?.totalRamMiB), commitLimitMiB: wholeMiB(facts?.commitLimitMiB)},
      setup: (await collectSetup({runtime, gameInfo, now: now()})).map(line => clean(line)),
      // A queued record carries the excerpt taken when the event was seen; one without (an older queue file) is read now.
      logs: Array.isArray(record.logs) ? keptLogs(record.logs, clean) : await collectLogs({paths: logPaths({game, modRoot, runtime, stateDirectory}), record, clean}),
    },
  };
  payload.report.privacy = {redactions: {...stats}};
  let body = JSON.stringify(payload);
  while (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    const largest = payload.report.logs.reduce((best, item) => !best || item.lines.length > best.lines.length ? item : best, null);
    if (!largest || largest.lines.length === 0) { payload.report.logs = []; payload.report.stack = payload.report.stack.slice(0, 2); body = JSON.stringify(payload); break; }
    largest.lines.splice(0, Math.max(1, Math.ceil(largest.lines.length / 10)));
    body = JSON.stringify(payload);
  }
  return {payload, body};
}

// ------------------------------------------------------------- the Lua logs

// A Lua runtime error as the game logs it: "<file>.lua:<line>: <message>". CET writes a callback's uncaught error to the mod's own log
// (AiNpcCyberpunkMod.log), where every such line counts; probe.log (the mod's log, mod/init.lua) holds the errors the mod caught and
// logged ("... failed: init.lua:150: attempt to index ..."), where only a Lua error's wording counts.
const LUA_ERROR = /(?:^|[\s:(\]])([A-Za-z0-9_.-]+\.lua):(\d+): (.+)$/;
const LUA_WORDS = /attempt to|bad argument|stack overflow|nil value|expected|unexpected|not enough memory|table index|invalid|error/i;

/**
 * Lua errors in some log lines: [{message, frame, context}]. `since` (ms): a line that starts with an ISO stamp older than it is skipped (probe.log
 * lines carry one; the file is cut back at each game load, and what is left of earlier sessions is not this session's).
 */
export function luaErrorsIn(lines, {strict = true, since = 0} = {}) {
  const found = [];
  for (const raw of lines) {
    if (since) {
      const stamp = /^\s*(\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(String(raw ?? ''));
      if (stamp && Date.parse(stamp[1]) < since) continue;
    }
    const line = String(raw ?? '').replace(/^\s*(?:\[[^\]]*\]\s*|\d{4}-\d\d-\d\dT[\d:.]+Z\s*)+/, '');
    const match = LUA_ERROR.exec(line);
    if (match) {
      if (strict && !LUA_WORDS.test(match[3])) continue;
      const before = line.slice(0, match.index).replace(/[:\s]+$/, '').replace(/\s*failed$/i, ' failed');
      found.push({message: match[3].trim().slice(0, 300), frame: `${match[1]}:${match[2]}`, context: before.slice(-100)});
    } else if (!strict && /\[error\]/i.test(raw)) {
      found.push({message: line.replace(/^.*?\[error\]\s*/i, '').trim().slice(0, 300), frame: 'cet', context: ''});
    }
  }
  return found;
}

// --------------------------------------------------------------- the reporter

export class ErrorReporter {
  /**
   * game, runtime, modRoot, stateDirectory, project: the install's folders (the supervisor knows them). env: for the backend address.
   * log: one line to the service log (never a payload). Everything else is for tests.
   */
  constructor({game, runtime, modRoot, stateDirectory, project, env = process.env, fetchImpl = globalThis.fetch, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, setRepeat = setInterval, clearRepeat = clearInterval, log = () => {},
    graphics, timings = {}, target, names} = {}) {
    Object.assign(this, {game, runtime, stateDirectory, project, env, fetchImpl, now, setTimer, clearTimer, setRepeat, clearRepeat, log, graphics, names});
    this.modRoot = modRoot ?? (runtime ? dirname(runtime) : null);
    this.timings = {...TIMINGS, ...timings};
    this.targetOverride = target;
    this.startedAt = now();
    this.timer = null; this.repeat = null; this.flushing = null; this.closed = false; this.chain = Promise.resolve();
    this.stopped = null; this.failures = 0; this.retryAt = 0; this.clockOffsetMs = 0; this.gameInfo = {};
    this.announced = new Set();
  }

  #note(key, message) {
    if (this.announced.has(key)) return;
    this.announced.add(key);
    try { this.log(`Error reports: ${message}`); } catch {}
  }

  async #state() {
    let value = null;
    try { value = JSON.parse(await readFile(sentPath(this.stateDirectory), 'utf8')); } catch {}
    const state = value && typeof value === 'object' && value.version === 1 ? value : {version: 1};
    const day = today(this.now());
    if (state.day !== day) Object.assign(state, {day, count: 0, signatures: {}});
    state.signatures = state.signatures && typeof state.signatures === 'object' ? state.signatures : {};
    state.logs = state.logs && typeof state.logs === 'object' ? state.logs : {};
    state.count = Number.isInteger(state.count) ? state.count : 0;
    return state;
  }

  async #save(state) {
    const path = sentPath(this.stateDirectory), temporary = `${path}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(path), {recursive: true});
      await writeFile(temporary, JSON.stringify(state));
      await rename(temporary, path);
    } catch { /* the next look writes it again (a full disk or a locked file never reaches the caller) */ await rm(temporary, {force: true}).catch(() => {}); }
  }

  /** Starts the looks: the game's events and the log positions now (a few reads), the first send a minute later, then every 5 minutes. */
  start() {
    if (this.closed || this.repeat) return this;
    void this.#look({flush: false});
    this.#schedule(this.timings.firstFlushMs);
    this.repeat = this.setRepeat(() => { void this.#look({flush: true}); }, this.timings.tickMs);
    this.repeat?.unref?.();
    return this;
  }

  #schedule(delayMs) {
    if (this.closed) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; void this.flush().catch(() => {}); }, Math.max(0, delayMs));
    this.timer?.unref?.();
  }

  /** A supervisor event ({kind, message, frame, detail}). Recorded unless the setting is off; sent 15 s later. */
  async record(event) {
    if (this.closed || !await errorReportsEnabled(this.runtime)) return null;
    const record = await recordErrorEvent(this.stateDirectory, {source: 'service', ...event}, {now: this.now()});
    if (record) {
      // The log lines of this moment are kept with the record: it may wait (daily limit, unreachable backend) and a later session's logs are not its.
      await this.#serial(() => this.#capture()).catch(() => {});
      this.#schedule(this.timings.debounceMs);
    }
    return record;
  }

  /** The bridge exited unexpectedly: a crash report, unless the bridge recorded its own exception just before (that one says more). `crash`: collectCrashInfo's facts. */
  async bridgeExited(description, crash) {
    if (this.closed) return null;
    const recent = (await readQueue(this.stateDirectory, {now: this.now()}))
      .some(record => (record.kind === 'bridge-exception' || record.kind === 'bridge-rejection') && this.now() - record.lastAt <= this.timings.crashPairMs);
    if (recent) { this.#schedule(this.timings.debounceMs); return null; }
    return this.record({kind: 'bridge-crash', message: 'The bridge exited unexpectedly', frame: clip(String(description ?? 'unknown'), 120), ...(crash ? {crash} : {})});
  }

  // The state file (sent.json) has one writer at a time: every look and every send runs in this chain.
  #serial(work) {
    const run = this.chain.then(work);
    this.chain = run.catch(() => {});
    return run;
  }

  /** The game's new events and new Lua errors into the queue; with `flush`, then a send. Never throws. */
  #look({flush}) {
    return this.#serial(async () => {
      if (this.closed) return;
      const enabled = await errorReportsEnabled(this.runtime);
      const state = await this.#state();
      await this.#importGameEvents(state, enabled);
      await this.#scanLuaLogs(state, enabled);
      if (enabled) await this.#capture();
      await this.#save(state);
      if (flush) await this.#flush();
    }).catch(() => {});
  }

  /** One look now, as the five-minute timer does (tests, and a caller that knows something was written). */
  look({flush = true} = {}) { return this.#look({flush}); }

  async #importGameEvents(state, enabled) {
    const raw = await readFile(join(this.runtime, GAME_EVENTS_FILE), 'utf8').catch(() => '');
    const {game, events} = parseGameEvents(raw);
    this.gameInfo = game;
    const seen = Number.isFinite(state.gameSeenAt) ? state.gameSeenAt : 0;
    let newest = seen;
    for (const event of events) {
      if (event.at <= seen) continue;
      newest = Math.max(newest, event.at);
      if (enabled && this.now() - event.at < 7 * 24 * 3600_000) await recordErrorEvent(this.stateDirectory, event, {now: this.now()});
    }
    state.gameSeenAt = newest;
  }

  async #scanLuaLogs(state, enabled) {
    const sources = [{id: 'cet-mod', path: this.modRoot ? join(this.modRoot, 'AiNpcCyberpunkMod.log') : null, strict: false},
      {id: 'probe', path: this.runtime ? join(this.runtime, 'probe.log') : null, strict: true}];
    let recorded = 0;
    for (const source of sources) {
      if (!source.path) continue;
      let size;
      try { size = (await stat(source.path)).size; } catch { continue; }
      const known = state.logs[source.id]?.size;
      state.logs[source.id] = {size};
      // First sight: only what is written from now on counts (an older session's errors are not this one's).
      if (!Number.isFinite(known) || size === known || !enabled) continue;
      const from = size < known ? 0 : known;
      const start = Math.max(from, size - 262144);
      let text = '';
      let handle;
      try {
        handle = await open(source.path, 'r');
        const buffer = Buffer.alloc(size - start);
        const {bytesRead} = await handle.read(buffer, 0, buffer.length, start);
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } catch { continue; } finally { await handle?.close().catch(() => {}); }
      // A file that got smaller was cut back or replaced (the game cuts probe.log back at each load): only its lines stamped since this service started count.
      const since = size < known ? this.startedAt - 60_000 : 0;
      for (const found of luaErrorsIn(text.split(/\r?\n/), {strict: source.strict, since})) {
        if (recorded >= 5) break;
        if (await recordErrorEvent(this.stateDirectory, {kind: 'lua-error', message: found.message, frame: found.frame, source: 'game',
          detail: {log: source.id, ...(found.context ? {context: found.context} : {})}}, {now: this.now()})) recorded++;
      }
    }
  }

  // The queued records that have no log excerpt yet get theirs: read and scrubbed now, kept in the record's own file (attachLogs). A few directory
  // reads and, per new record, at most six small tails; nothing when every record already has its excerpt. Never throws.
  async #capture() {
    try {
      const todo = (await readQueue(this.stateDirectory, {now: this.now()})).filter(record => !Array.isArray(record.logs));
      if (!todo.length) return;
      const secrets = await reportSecrets({stateDirectory: this.stateDirectory, project: this.project, environment: this.env});
      for (const record of todo) {
        const logs = await captureLogs({record, game: this.game, modRoot: this.modRoot, runtime: this.runtime, stateDirectory: this.stateDirectory,
          secrets, ...(this.names ? {names: this.names} : {})});
        await attachLogs(record, logs, {now: this.now()});
      }
    } catch { /* the report then reads the logs when it is sent, as before */ }
  }

  async #target() {
    if (this.targetOverride !== undefined) return this.targetOverride;
    return reportTarget({env: this.env, stateDirectory: this.stateDirectory, project: this.project});
  }

  async #send(target, body) {
    const timestamp = String(Math.floor((this.now() + this.clockOffsetMs) / 1000));
    let response;
    try {
      response = await this.fetchImpl(target.url, {method: 'POST', redirect: 'error', cache: 'no-store',
        headers: {'content-type': 'text/plain; charset=utf-8', accept: 'application/json', 'x-convai-timestamp': timestamp,
          'x-convai-signature': signRequest(target.secret, timestamp, body)},
        body, signal: AbortSignal.timeout(this.timings.timeoutMs)});
    } catch { return {kind: 'failed'}; }
    let data = {};
    try { const text = await response.text(); if (text.length <= 16384) data = JSON.parse(text) ?? {}; } catch {}
    const status = response.status;
    if (status === 200 && data?.ok === true) return {kind: 'ok', stored: data.stored === true};
    if (status === 404) return {kind: 'not-found'};
    if (status === 401 && data?.error === 'stale' && Number.isFinite(data.serverTime)) return {kind: 'stale', serverTime: data.serverTime};
    if (status === 401 || status === 403) return {kind: 'unauthorized'};
    if (status === 429) return {kind: 'rate'};
    if (status === 400 || status === 413 || status === 422) return {kind: 'rejected'};
    return {kind: 'failed'};
  }

  /** Sends what is queued, within the throttles. One at a time; a call while one runs joins it. */
  flush() {
    if (this.closed) return Promise.resolve();
    this.flushing ??= this.#serial(() => this.#flush()).catch(() => {}).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async #flush() {
    if (this.stopped || this.now() < this.retryAt) return;
    const setting = await errorReportsSetting(this.runtime);
    if (setting.state === 'off') {
      const removed = await clearQueue(this.stateDirectory);
      if (removed) this.#note('off', 'the setting is off; queued errors were deleted');
      return;
    }
    // An unreadable settings file is an unknown state: nothing is sent and nothing is deleted. Nothing is sent either before the
    // game has shown the notice that says reports are sent (what is queued waits, up to a week).
    if (setting.state !== 'on') { this.#note('unknown', 'the settings file cannot be read; nothing is sent until it can'); return; }
    if (!setting.noticed) { this.#note('notice-pending', 'the in-game notice has not been shown yet; nothing is sent until it has'); return; }
    const queue = await readQueue(this.stateDirectory, {now: this.now()});
    if (!queue.length) return;
    const target = await this.#target();
    if (!target) { this.#note('no-target', 'no backend address is configured; errors stay queued for up to a week'); return; }
    const state = await this.#state();
    let installId = null, secrets = null;
    try {
      for (const record of queue) {
        if (state.signatures[record.signature]) { await removeQueued(record); continue; }
        if (state.count >= DAILY_LIMIT) { this.#note(`limit-${state.day}`, `the daily limit of ${DAILY_LIMIT} reports is reached; the rest wait`); break; }
        installId ??= await loadInstallId({path: join(this.stateDirectory, INSTALL_FILE)});
        secrets ??= await reportSecrets({stateDirectory: this.stateDirectory, project: this.project, environment: this.env});
        const {body} = await buildErrorPayload({record, game: this.game, modRoot: this.modRoot, runtime: this.runtime,
          stateDirectory: this.stateDirectory, project: this.project, installId, gameInfo: this.gameInfo, secrets, graphics: this.graphics,
          environment: this.env, now: this.now, ...(this.names ? {names: this.names} : {})});
        let result = await this.#send(target, body);
        if (result.kind === 'stale') {
          this.clockOffsetMs = result.serverTime * 1000 - this.now();
          result = await this.#send(target, body);
          if (result.kind === 'stale') result = {kind: 'unauthorized'};
        }
        if (result.kind === 'ok') {
          state.count += 1; state.signatures[record.signature] = this.now(); state.lastSentAt = this.now(); state.total = (Number(state.total) || 0) + 1;
          this.failures = 0;
          await removeQueued(record);
          try { this.log(`Error reports: sent ${record.kind} ${record.signature}${result.stored ? '' : ' (counted)'}`); } catch {}
          continue;
        }
        if (result.kind === 'rejected') { await removeQueued(record); this.#note(`rejected-${record.signature}`, `the backend refused report ${record.signature}; it was dropped`); continue; }
        if (result.kind === 'failed') {
          this.failures += 1;
          this.retryAt = this.now() + this.timings.retryMs;
          if (this.failures >= this.timings.maxFailures) this.#stop(state, 'unreachable', 'the backend could not be reached three times; none sent this session');
          else this.#note(`failed-${this.failures}`, 'the backend could not be reached; trying again in 15 minutes');
          break;
        }
        this.#stop(state, result.kind, result.kind === 'not-found' ? 'the backend has no error endpoint (404); none sent this session'
          : result.kind === 'rate' ? 'the backend is limiting reports (429); none sent this session'
            : 'the backend refused the request signature (401); none sent this session');
        break;
      }
    } finally { await this.#save(state); }
  }

  #stop(state, kind, message) {
    this.stopped = kind; state.stopped = kind;
    this.#note(`stop-${kind}`, message);
  }

  /** Waits for a send in progress, at most `ms`. */
  async idle(ms = 3000) {
    let timer;
    await Promise.race([this.chain, new Promise(done => { timer = setTimeout(done, ms); timer.unref?.(); })]);
    clearTimeout(timer);
  }

  close() {
    this.closed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    if (this.repeat !== null) this.clearRepeat(this.repeat);
    this.timer = null; this.repeat = null;
  }
}

export {QUEUE_FOLDER};
