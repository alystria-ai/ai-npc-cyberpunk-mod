import {createHash} from 'node:crypto';
import {open, readFile, readdir, rm, stat, mkdir} from 'node:fs/promises';
import {readPlayerVoiceSummary} from './player-voices.mjs';
import {resolve, join, dirname, basename} from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createZip} from './zip-writer.mjs';
import {atomicFile} from './guarded-file.mjs';
import {NO_BROWSER_MESSAGE} from './system-browser.mjs';
import {cachedGraphicsCards} from './setup-check.mjs';
import {describePackFiles} from './local-ai-pack.mjs';
import {errorReportStatus} from './error-events.mjs';

// Support report: one redacted zip a player can send to the developer after an
// error. The Help page in Companion Manager writes runtime/report-request.json;
// SupportReportControl (polled by the bridge) answers in runtime/report-result.json.
//
// Privacy contract, enforced structurally rather than by inspection:
//   * Only the files named below are ever opened. Credential files, audio,
//     voice references, model files and conversation transcripts are not on
//     those lists, so they cannot enter a report.
//   * Credential files are read only to learn the secret values to scrub. The
//     values are never written, logged or returned.
//   * Every text and JSON value passes through the redactor before it is
//     written: known secrets, key/token/authorization patterns, long hex and
//     base64-like runs, UUIDs and known provider IDs (hashed), and the Windows
//     account name in profile paths.

export const REPORT_KEEP = 5;
export const REPORT_NAME = /^convai-report-(\d{8}-\d{6})(?:-[a-z]+)?\.(?:zip|txt)$/;
// The short report the game's Lua writes when the service is not running: one fixed file in runtime/, written in place (a new
// file there would land in Mod Organizer 2's Overwrite folder). Not a REPORT_NAME, so pruning never touches it; Copy path accepts it.
export const LUA_REPORT_NAME = 'convai-report-lua.txt';
export const LOG_MAX_LINES = 2000;
export const LOG_MAX_BYTES = 1024 * 1024;
const LINE_LIMIT = 1000, REQUEST_MAX_BYTES = 16384, REQUEST_MAX_AGE_MS = 120000;
const REPORT_MAX_BYTES = 40 * 1024 * 1024;

// ---------------------------------------------------------------- redaction

const SENSITIVE_KEY = /api[-_ ]?key|apikey|access[-_ ]?token|auth[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|token|secret|passw|credential|authorization|bearer|cookie|private[-_ ]?key|signature/i;
const ID_KEY = /^(?:end[-_ ]?user|user|session|character|connection|room|participant|owner)[-_ ]?id$|^(?:world[-_ ]?)?token$/i;
const VALUE = String.raw`[^\s"',;}&]+`;
const KEYWORD = String.raw`(?:convai[-_ ]?key|api[-_ ]?key|apikey|x-api-key|access[-_ ]?token|auth[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|token|secret|passwd|password|private[-_ ]?key|cookie|session[-_ ]?key)`;
const RULES = [
  [/\b(authorization|proxy-authorization)(["']?\s*[:=]\s*["']?)[^\r\n"',;}]*/gi, '$1$2[redacted]'],
  [new RegExp(String.raw`(${KEYWORD}["']?\s*[:=]\s*["']?)${VALUE}`, 'gi'), '$1[redacted]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 [redacted]'],
  [/([?&](?:key|token|api_key|apikey|access_token|auth|signature|sig)=)[^&\s"']+/gi, '$1[redacted]'],
  [/\b(?:hf|ghp|gho|ghs|ghu|sk|pk|xox[abpr]|AKIA|AIza|ya29)[-_A-Za-z0-9.]{12,}/g, '[token-redacted]'],
];
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_HEX = /\b[0-9a-f]{32,}\b/gi;
const LONG_RUN = /[A-Za-z0-9+_=-]{40,}/g;
// The Windows account name in a profile path, in every spelling a log uses: C:\Users\<name>, c:/users/<name>, \\?\C:\Users, \\host\c$\Users,
// JSON-escaped (C:\\Users\\) and URL-encoded (C%3A%5CUsers%5C). A name with spaces ("John Smith") is taken whole up to the next separator, quote
// or the end; past 64 characters with none, only its first word is (the old rule). A Windows account name never holds , ; = + [ ] or those.
const PATH_SEPARATOR = String.raw`(?:[\\/]|%5c|%2f)`;
const NOT_IN_NAME = String.raw`\r\n"'<>|:*?,;=+\[\]`;
const USER_PATH = new RegExp(String.raw`((?:^|[\\/:]|%5c|%2f|%3a)Users${PATH_SEPARATOR}+)`
  + String.raw`(?:[^\\/${NOT_IN_NAME}]{1,64}?(?=${PATH_SEPARATOR}|[${NOT_IN_NAME}]|$)|[^\\/\s"'<>|:*?]+)`, 'gi');
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const shortHash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 8);

/**
 * `accounts`: the player's Windows account names (offline report: %USERNAME% and the profile folder's name). Any path part that is exactly
 * one of them becomes <user> as well, for a profile outside C:\Users or a folder named after the player (D:\Jane\Games\Cyberpunk 2077).
 */
export function createRedactor({secrets = [], ids = [], accounts = []} = {}) {
  const literal = [...new Set(secrets.filter(value => typeof value === 'string' && value.trim().length >= 6)
    .flatMap(value => [value, value.trim()]))].sort((a, b) => b.length - a.length);
  const known = [...new Set(ids.filter(value => typeof value === 'string' && value.length >= 6))].sort((a, b) => b.length - a.length);
  const stats = {secrets: 0, ids: 0, patterns: 0, paths: 0};
  const names = [...new Set(accounts.filter(name => typeof name === 'string').map(name => name.trim())
    .filter(name => name.length >= 2 && name.length <= 64 && !/[\\/\r\n]/.test(name)))].sort((a, b) => b.length - a.length);
  const account = names.length ? new RegExp(String.raw`(^|${PATH_SEPARATOR})(?:${names.map(escapeRegExp).join('|')})(?=${PATH_SEPARATOR}|[\s${NOT_IN_NAME})]|$)`, 'gi') : null;
  const replaceAll = (text, needle, replacement, counter) => {
    if (!text.includes(needle)) return text;
    stats[counter] += text.split(needle).length - 1;
    return text.split(needle).join(replacement);
  };
  const text = input => {
    let value = typeof input === 'string' ? input : String(input ?? '');
    for (const secret of literal) value = replaceAll(value, secret, '[secret-redacted]', 'secrets');
    for (const id of known) value = replaceAll(value, id, `[id:${shortHash(id)}]`, 'ids');
    for (const [pattern, replacement] of RULES) {
      value = value.replace(pattern, (...match) => { stats.patterns++; return replacement.replace(/\$(\d)/g, (_, n) => match[Number(n)] ?? ''); });
    }
    value = value.replace(UUID, id => { stats.ids++; return `[id:${shortHash(id.toLowerCase())}]`; });
    value = value.replace(LONG_HEX, () => { stats.patterns++; return '[hex-redacted]'; });
    value = value.replace(LONG_RUN, run => {
      if (!/\d/.test(run) || !/[A-Za-z]/.test(run) || run.startsWith('[')) return run;
      stats.patterns++; return '[token-redacted]';
    });
    value = value.replace(USER_PATH, (_, prefix) => { stats.paths++; return `${prefix}<user>`; });
    if (account) value = value.replace(account, (_, prefix) => { stats.paths++; return `${prefix}<user>`; });
    return value;
  };
  const walk = (value, key = '', depth = 0) => {
    if (depth > 8) return '[depth-limited]';
    if (typeof value === 'string') {
      if (ID_KEY.test(key) && value) { stats.ids++; return `[id:${shortHash(value)}]`; }
      if (SENSITIVE_KEY.test(key) && value) { stats.patterns++; return '[redacted]'; }
      return text(value);
    }
    if (Array.isArray(value)) {
      const rows = value.slice(0, 60).map(item => walk(item, key, depth + 1));
      if (value.length > 60) rows.push(`[${value.length - 60} more omitted]`);
      return rows;
    }
    if (value && typeof value === 'object') {
      const result = {};
      for (const [name, item] of Object.entries(value).slice(0, 200)) result[text(name)] = walk(item, name, depth + 1);
      return result;
    }
    return value;
  };
  return {text, value: item => walk(item), stats};
}

// ------------------------------------------------------------------- files

/** Reads a bounded tail. Returns null when the file is absent or unreadable. */
export async function tailFile(path, {maxBytes = LOG_MAX_BYTES, maxLines = LOG_MAX_LINES} = {}) {
  let handle;
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    handle = await open(path, 'r');
    const length = Math.min(info.size, maxBytes), start = info.size - length;
    const buffer = Buffer.alloc(length);
    const {bytesRead} = await handle.read(buffer, 0, length, start);
    let raw = buffer.subarray(0, bytesRead);
    let text = raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE ? raw.toString('utf16le') : raw.toString('utf8');
    let lines = text.split(/\r\n|\r|\n/);
    // The first line of a mid-file read is usually cut short.
    let cut = start > 0 && lines.length > 1;
    if (cut) lines = lines.slice(1);
    // Progress bars rewrite one line with carriage returns; keep each run's last.
    const progress = line => /\d+%\|/.test(line) && /it\/s|s\/it/.test(line);
    lines = lines.filter((line, index) => !(progress(line) && progress(lines[index + 1] ?? '')));
    lines = lines.map(line => line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT)} [truncated ${line.length - LINE_LIMIT} characters]` : line);
    while (lines.length && lines.at(-1) === '') lines.pop();
    const total = lines.length;
    if (total > maxLines) { lines = lines.slice(total - maxLines); cut = true; }
    return {lines, truncated: cut, bytes: info.size, modified: info.mtime.toISOString()};
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}

async function readSmallJson(path, maxBytes = 256 * 1024) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) return {error: info.isFile() ? 'too-large' : 'not-a-file'};
    const text = (await readFile(path, 'utf8')).replace(/^﻿/, '');
    // An empty file is a placeholder the install ships and the service has not written yet: nothing there, like a missing one.
    if (text.trim() === '') return {error: 'absent'};
    return {value: JSON.parse(text), modified: info.mtime.toISOString()};
  } catch (error) { return {error: error.code === 'ENOENT' ? 'absent' : 'unreadable'}; }
}

const newest = async (directory, pattern, count = 1) => {
  try {
    const names = (await readdir(directory)).filter(name => pattern.test(name));
    const rows = [];
    for (const name of names) rows.push({name, time: (await stat(join(directory, name))).mtimeMs});
    return rows.sort((a, b) => b.time - a.time).slice(0, count).map(row => join(directory, row.name));
  } catch { return []; }
};

// Every log location the report knows. Used for the report and for the paths
// the Help page shows, so the page and the report cannot disagree.
export async function locateLogs({game, modRoot, runtime, stateDirectory}) {
  // Each log has one or more candidate locations; the first that exists wins,
  // otherwise the first is reported as where it will appear.
  const candidates = [];
  const add = (id, paths, extra = {}) => candidates.push({id, paths: [].concat(paths), ...extra});
  const folders = stateDirectory ? [stateDirectory, join(stateDirectory, 'logs')] : [];
  const slug = path => path.split(/[\\/]/).at(-1).replace(/\.log$/i, '').replace(/[^A-Za-z0-9-]/g, '-').toLowerCase();
  add('probe', join(runtime, 'probe.log'));
  add('mcm', join(runtime, 'mcm.log'));
  // Which voice spoke each reply and why (bridge/voice-routing-log.mjs): routing facts only, no conversation text. Named
  // here because the content-like filter below would otherwise drop any log with "voice" in its name.
  add('voice-routing', join(runtime, 'voice-routing.log'));
  // Other diagnostic logs in the mod's runtime folder, except any whose name suggests
  // conversation content: those are never part of a report.
  for (const path of await newest(runtime, /^(?!probe\.log$|mcm\.log$).+\.log$/i, 12)) {
    if (!CONTENT_LIKE.test(path.split(/[\\/]/).at(-1))) add(`mod-${slug(path)}`, path);
  }
  add('mod-log', join(modRoot, 'AiNpcCyberpunkMod.log'));
  const bridgeNames = {'bridge-service': 'bridge-service.log', 'bridge-service-previous': 'bridge-service.log.previous',
    'bridge-stdout': 'bridge.stdout.log', 'bridge-stderr': 'bridge.stderr.log',
    'bridge-stdout-previous': 'bridge.stdout.previous.log', 'bridge-stderr-previous': 'bridge.stderr.previous.log'};
  for (const [id, name] of Object.entries(bridgeNames)) {
    if (folders.length) add(id, folders.map(folder => join(folder, name)), {previous: /previous/.test(id)});
  }
  for (const folder of folders) {
    for (const path of await newest(folder, /^bootstrap-.+\.(?:stdout|stderr)\.log$/i, 2)) add(`bootstrap-${slug(path)}`, path);
  }
  // The launcher DLL writes launcher.log next to itself: red4ext/plugins/AiNpcCyberpunkMod in a released install. The old
  // development folder name stays as a fallback; the first one that exists wins.
  add('launcher', [join(game, 'red4ext', 'plugins', 'AiNpcCyberpunkMod', 'launcher.log'),
    join(game, 'red4ext', 'plugins', 'CyberpunkConvaiLauncher', 'launcher.log')]);
  const cet = join(game, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks');
  add('cet', join(cet, 'cyber_engine_tweaks.log'));
  add('cet-scripting', join(cet, 'scripting.log'));
  add('redscript', join(game, 'r6', 'logs', 'redscript_rCURRENT.log'));
  const logs = join(game, 'red4ext', 'logs');
  add('red4ext', (await newest(logs, /^red4ext-.+\.log$/i))[0] ?? join(logs, 'red4ext-<date>.log'));
  add('audioware', (await newest(logs, /^audioware-.+\.log$/i))[0] ?? join(logs, 'audioware-<date>.log'));
  const result = [], seen = new Set();
  for (const {id, paths, ...extra} of candidates) {
    if (seen.has(id)) continue;
    seen.add(id);
    let chosen = paths[0];
    for (const path of paths) if (await stat(path).then(info => info.isFile(), () => false)) { chosen = path; break; }
    result.push({id, path: chosen, ...extra});
  }
  return result;
}

// The custom (OpenAI-compatible) provider's settings file (bridge/custom-endpoint.mjs CUSTOM_FILE): its `api-key=` line is a secret, its
// address and model id are not (they are diagnostics, and redacting them would hide the host from the report).
export const CUSTOM_ENDPOINT_FILE = 'player-custom-endpoint.txt';

/** The value of every `api-key=` / `key=` / `token=` / `secret=` line of a settings file, as written and without quotes. */
export function keyLineValues(text) {
  const found = [];
  for (const line of String(text ?? '').replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const match = /^\s*(?:api[-_ ]?key|apikey|key|token|secret)\s*[=:]\s*(\S+)\s*$/i.exec(line);
    if (!match) continue;
    found.push(match[1]);
    const bare = match[1].replace(/^bearer\s+/i, '').replace(/^["'`<]+|["'`>]+$/g, '');
    if (bare && bare !== match[1]) found.push(bare);
  }
  return found;
}

export async function credentialSecrets(stateDirectory) {
  const found = [];
  if (!stateDirectory) return found;
  const names = ['convai-key.txt', 'kaggle-access-token.txt'];
  let custom = false;
  try {
    for (const name of await readdir(stateDirectory)) {
      // Every saved key file (player-convai-key.txt, player-mistral-key.txt, player-inworld-key.txt...), also one the service did not load.
      if (/^huggingface-.*\.txt$/i.test(name) || (/-key\.txt$/i.test(name) && !names.includes(name))) names.push(name);
      if (name.toLowerCase() === CUSTOM_ENDPOINT_FILE) custom = name;
    }
  } catch { return found; }
  if (custom) {
    try {
      const info = await stat(join(stateDirectory, custom));
      if (info.isFile() && info.size <= 16384) found.push(...keyLineValues(await readFile(join(stateDirectory, custom), 'utf8')));
    } catch {}
  }
  for (const name of names) {
    try {
      const info = await stat(join(stateDirectory, name));
      if (!info.isFile() || info.size > 8192) continue;
      const raw = (await readFile(join(stateDirectory, name), 'utf8')).trim();
      found.push(raw);
      // The key file is api-key=VALUE; the value alone must also be scrubbed.
      const value = /^[A-Za-z0-9_-]+\s*=\s*(\S+)$/.exec(raw)?.[1];
      if (value) found.push(value);
      for (const part of raw.split(/\s+/)) if (part.length >= 12) found.push(part);
    } catch {}
  }
  return found;
}

// The apiKey values of the servers listed in manifest.custom.json (a model server the player runs, docs/LOCAL_AI.md "Use your own server"): secrets like
// any key file, scrubbed from every line of the report. The manifest itself is never copied into the report (only its file name is listed).
export async function customServerSecrets({project, environment = process.env} = {}) {
  const found = [];
  const roots = new Set();
  const named = name => (typeof environment?.[name] === 'string' && environment[name].trim() ? resolve(environment[name]) : null);
  roots.add(named('CYBERPUNK_CONVAI_LOCAL_AI') ?? (project ? resolve(project, 'local-ai') : null));
  roots.add(named('CYBERPUNK_CONVAI_LOCAL_AI_DEV'));
  for (const root of roots) {
    if (!root) continue;
    try {
      const path = join(root, 'manifest.custom.json');
      const info = await stat(path);
      if (!info.isFile() || info.size > 262144) continue;
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      for (const entry of Array.isArray(manifest?.models) ? manifest.models : []) {
        if (typeof entry?.apiKey === 'string' && entry.apiKey.trim()) { found.push(entry.apiKey.trim()); if (entry.apiKey.trim() !== entry.apiKey) found.push(entry.apiKey); }
      }
    } catch {}
  }
  return found;
}

// Where the zip reports are written. The service's data folder is <data home>/data, so a data folder named "data" outside the mod
// folder has the data home as its parent (%LOCALAPPDATA%\AiNpcCyberpunkMod, packaging/runtime/state-home.mjs): reports go to
// <data home>/reports, outside the game folder (files created there land in Mod Organizer 2's Overwrite folder). Any other state
// folder (the development project's runtime/, or data/ kept in the mod folder after a deferred move) keeps <runtime>/reports.
export function reportsDirectoryFor({runtime, stateDirectory, modRoot = resolve(runtime, '..')}) {
  if (stateDirectory) {
    const state = resolve(stateDirectory), home = dirname(state);
    if (basename(state).toLowerCase() === 'data' && home !== dirname(home) && home.toLowerCase() !== resolve(modRoot).toLowerCase()) {
      return join(home, 'reports');
    }
  }
  return join(runtime, 'reports');
}

export async function publishSupportPaths({game, modRoot, runtime, stateDirectory, reportsDirectory, now = Date.now}) {
  const logs = {};
  for (const entry of await locateLogs({game, modRoot, runtime, stateDirectory})) {
    logs[entry.id] = {path: entry.path, exists: await stat(entry.path).then(info => info.isFile(), () => false)};
  }
  const document = {version: 1, updated: now(), gameRoot: game, modRoot, runtime,
    reports: reportsDirectory ?? reportsDirectoryFor({runtime, stateDirectory, modRoot}), stateDirectory: stateDirectory ?? null, logs};
  await atomicFile(join(runtime, 'support-paths.json'), JSON.stringify(document));
  return document;
}

// ------------------------------------------------------------------ report

// A setup-check.json is read as this bridge's own while its bridgePid is this process, or (written by another process) while it is under
// ten minutes old: a document an earlier game session left behind says nothing about this one.
const SETUP_FRESH_MS = 10 * 60 * 1000;
export function setupLine(row) {
  const id = clip(row?.id, 40), code = clip(row?.code, 40);
  if (!id || !code) return null;
  const detail = [];
  if (id === 'versions' && row.code === 'mismatch') detail.push(`Scripts ${clip(row.scripts, 40)}, Runtime ${clip(row.runtime, 40)}`);
  else if (id === 'packs' && row.code === 'nested') {
    detail.push((Array.isArray(row.nested) ? row.nested : []).slice(0, 8).map(item => `${clip(item?.pack, 60)} in ${clip(item?.folder, 200)}`).join(', '));
  } else if (id === 'packs' && row.code === 'conflict') detail.push('the launcher could not finish moving pack files into place');
  else if (id === 'internet' && row.host) detail.push(`${clip(row.service, 20)}: ${clip(row.host, 80)}`);
  const text = detail.filter(Boolean).join('; ');
  return `Setup check: ${id} ${code}${text ? ` (${text})` : ''}`;
}

// A fault the player can fix, stated plainly at the top of the report (the service status code says which). `lua.setup` is the game-side
// checks the Help page sent with the request.
function knownProblems(raw, {lua = {}, now = Date.now} = {}) {
  const problems = [];
  const browserMissing = raw['bridge-service.json']?.code === 'browser-missing';
  if (browserMissing) problems.push(`The conversation service could not start: ${NO_BROWSER_MESSAGE} (service status code browser-missing).`);
  const check = raw['setup-check.json'];
  const fresh = check && typeof check === 'object' && Array.isArray(check.checks)
    && (check.bridgePid === process.pid || (Number.isFinite(check.updated) && Math.abs(now() - check.updated) <= SETUP_FRESH_MS));
  if (fresh) {
    for (const row of check.checks.slice(0, 16)) {
      if (row?.state !== 'problem' || (browserMissing && row.id === 'browser')) continue;
      const line = setupLine(row);
      if (line) problems.push(line);
    }
  }
  for (const row of Array.isArray(lua.setup) ? lua.setup : []) {
    if (row?.state === 'problem' && row.id && row.code) problems.push(`Setup check (game): ${row.id} ${row.code}`);
  }
  return problems;
}

const STATUS_FILES = ['bridge-service.json', 'bridge-status.json', 'knowledge-status.json', 'local-voice-state.json',
  'party-connection-state.json', 'party-connections.json', 'companion-invitations-state.json', 'memory-status.json',
  'relationship-routing.json', 'world-session.json', 'bridge-latency.json', 'setup-check.json'];
const ERROR_LINE = /\b(?:error|exception|failed|failure|fatal|crash(?:ed)?|traceback|panic|unhandled|assert(?:ion)?)\b/i;
// Routine lines that merely mention the word ("no error reported", "error=false").
const NOT_AN_ERROR = /\b(?:no|zero|0)\s+(?:scene\s+)?errors?\b|\berrors?\s*[=:]\s*(?:false|0|none|null)\b|\bfailures?\s*[=:]\s*0\b|\bwithout (?:an? )?error/i;

// Names of files that may hold what the player or a character said.
const CONTENT_LIKE = /chat|transcript|convers|history|dialog|message|input|reply|prompt|journal|speech|audio|voice|mic|memory|subtitle/i;

const clip = (value, size = 120) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, size) : undefined;

function compactStatus(name, value) {
  if (!value || typeof value !== 'object') return value;
  const copy = {...value};
  for (const key of ['profiles', 'configuredProfiles', 'preparedProfiles', 'routedProfiles']) {
    if (Array.isArray(copy[key]) && copy[key].length > 12) copy[key] = {count: copy[key].length};
  }
  if (name === 'memory-status.json' && Array.isArray(copy.characters)) {
    copy.characters = {count: copy.characters.length, blocked: copy.characters.filter(row => row?.blocked).length};
  }
  if (name === 'world-session.json') return {ready: copy.ready, generation: copy.generation, updated: copy.updated};
  return copy;
}

function sanitizeRequest(request) {
  const lua = request.lua && typeof request.lua === 'object' ? request.lua : {};
  const party = Array.isArray(lua.party) ? lua.party.slice(0, 12).map(row => ({
    profile: clip(row?.profile, 80), key: clip(row?.key, 80), name: clip(row?.name, 80),
    state: clip(row?.state, 40), error: clip(row?.error, 160),
  })) : [];
  // The game-side setup checks (files, game, CET, RED4ext...): short tokens only, at most 24 rows.
  const setup = Array.isArray(lua.setup) ? lua.setup.slice(0, 24).map(row => ({id: clip(row?.id, 40), state: clip(row?.state, 20),
    code: clip(row?.code, 60), version: clip(row?.version, 40)})) : undefined;
  return {cetVersion: clip(lua.cetVersion, 40), language: clip(lua.language, 20), view: clip(lua.view, 40),
    developerMode: typeof lua.developerMode === 'boolean' ? lua.developerMode : undefined, party, setup};
}

async function versions({game, modRoot, project, logs, now}) {
  const result = {node: process.version, os: {platform: process.platform, release: os.release(), arch: process.arch}};
  const head = async path => (await tailFile(path, {maxBytes: 8192, maxLines: 60}))?.lines ?? [];
  const logPath = id => logs.find(entry => entry.id === id)?.path;
  // RED4ext writes the game version at the top of every session log.
  for (const line of await head(logPath('red4ext'))) {
    const product = /Product version:\s*(\S+)/.exec(line), file = /File version:\s*(\S+)/.exec(line), version = /RED4ext \(v([^)]+)\)/.exec(line);
    if (product) result.game = {...result.game, product: product[1]};
    if (file) result.game = {...result.game, file: file[1]};
    if (version) result.red4ext = version[1];
  }
  // CET appends sessions to one log; the last version line is the current one.
  const cet = await tailFile(logPath('cet'), {maxBytes: 4 * 1024 * 1024, maxLines: 100000});
  for (const line of cet?.lines ?? []) {
    const cetVersion = /CET version (\S+)/.exec(line);
    if (cetVersion) result.cet = cetVersion[1];
  }
  try {
    const names = (await readdir(modRoot)).filter(name => /\.lua$/i.test(name)).sort();
    const rows = [];
    let newestTime = 0;
    for (const name of names) {
      const info = await stat(join(modRoot, name));
      rows.push(`${name}:${info.size}`); newestTime = Math.max(newestTime, info.mtimeMs);
    }
    result.mod = {luaFiles: names.length, fingerprint: createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 12),
      newestFile: newestTime ? new Date(newestTime).toISOString() : null};
  } catch { result.mod = {luaFiles: 0}; }
  try {
    const pointer = (await readFile(join(project, '.git', 'HEAD'), 'utf8')).trim();
    const reference = /^ref:\s*(\S+)$/.exec(pointer)?.[1];
    const commit = reference ? (await readFile(join(project, '.git', ...reference.split('/')), 'utf8').catch(() => '')).trim() : pointer;
    if (/^[0-9a-f]{12,64}$/i.test(commit)) result.mod = {...result.mod, commit: commit.slice(0, 12)};
  } catch {}
  try {
    const pack = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
    if (typeof pack.version === 'string') result.mod = {...result.mod, package: clip(pack.version, 30)};
  } catch {}
  result.generated = new Date(now()).toISOString();
  return result;
}

// The model server's own record (bridge/local-llm-server.mjs diagnostics(): which file is loaded, its family, chat template length and hash, how the last turn
// went) and the folder description copied as plain data only: numbers, booleans, short strings, objects and lists of at most 24, six deep. It holds file names, never a path, a key or a word of a reply.
function plainData(value, depth = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'string') return clip(value, 200);
  if (Array.isArray(value) && depth < 6) return value.slice(0, 24).map(item => plainData(item, depth + 1)).filter(item => item !== undefined);
  if (value && typeof value === 'object' && !Array.isArray(value) && depth < 6) {
    const out = {};
    let count = 0;
    for (const [key, item] of Object.entries(value)) {
      if (++count > 30) break;
      const copy = plainData(item, depth + 1);
      if (copy !== undefined) out[clip(key, 40)] = copy;
    }
    return out;
  }
  return undefined;
}

// Local AI detection, as the service sees it. Only the fields named here are copied from runtime/mistral-state.json (which
// also holds provider and key-status fields); the pack root and the manifest file names come from the folder itself.
export async function localAiSection({runtime, project, environment = process.env, describeFiles = describePackFiles}) {
  const read = await readSmallJson(join(runtime, 'mistral-state.json'));
  const state = read.value && typeof read.value === 'object' ? read.value : {};
  const fromEnvironment = typeof environment.CYBERPUNK_CONVAI_LOCAL_AI === 'string' && environment.CYBERPUNK_CONVAI_LOCAL_AI.trim() !== '';
  const root = fromEnvironment ? resolve(environment.CYBERPUNK_CONVAI_LOCAL_AI) : resolve(project, 'local-ai');
  let manifests = null;
  try { manifests = (await readdir(root)).filter(name => /^manifest.*\.json$/i.test(name)).sort(); } catch {}
  const models = Array.isArray(state.localModels) ? state.localModels.slice(0, 30).map(row => ({
    id: clip(row?.id, 80), name: clip(row?.name, 80), sizeMiB: Number.isFinite(row?.sizeMiB) ? Math.round(row.sizeMiB) : undefined,
    // A model server the player runs: only that it is one. Its address and key are neither published by the bridge nor copied here.
    ...(row?.external === true ? {external: true} : {})})) : null;
  return {
    state: read.error ?? 'present', stateModified: read.modified,
    localAi: typeof state.localAi === 'string' ? clip(state.localAi, 40) : null,
    maturePack: typeof state.maturePack === 'boolean' ? state.maturePack : null,
    localModels: models,
    // What is loaded and how the last local turns went (absent until a model was loaded): the cause of a turn that timed out is in lastTurn and template.
    diagnostics: plainData(state.localDiagnostics) ?? null,
    // Which markers the folder holds, the model files each names (there or not, with sizes) and the .gguf files of models/: a pack that was not fully extracted shows here.
    packFiles: (() => { try { return plainData(describeFiles({project, environment})); } catch { return null; } })() ?? null,
    root, rootSource: fromEnvironment ? 'CYBERPUNK_CONVAI_LOCAL_AI' : 'default (local-ai next to the bridge)',
    rootExists: manifests !== null, manifests: manifests ?? [],
  };
}

/**
 * Which conversation provider is chosen and in use, and for the custom OpenAI-compatible provider its host and model id (docs/CUSTOM_PROVIDER.md). From
 * the two status files the bridge publishes; only the fields named here are copied. Never the address's path or query, never the key (not even its tail).
 */
export async function conversationSection({runtime, settings}) {
  const chosen = ['convai', 'mistral', 'local', 'custom'].includes(settings?.conversationProvider) ? settings.conversationProvider : 'convai';
  const provider = await readSmallJson(join(runtime, 'mistral-state.json'));
  const custom = await readSmallJson(join(runtime, 'custom-provider-state.json'));
  const state = custom.value && typeof custom.value === 'object' ? custom.value : {};
  const test = state.test && typeof state.test === 'object' ? state.test : null;
  return {provider: chosen,
    effective: ['convai', 'mistral', 'local', 'custom'].includes(provider.value?.effective) ? provider.value.effective : null,
    ...(chosen === 'custom' || state.ready === true ? {custom: {
      host: clip(typeof state.host === 'string' ? state.host.replace(/[/?#].*$/, '') : null, 80) ?? null, model: clip(state.model, 120) ?? null,
      ready: state.ready === true, keySaved: state.keySaved === true, secure: state.secure === true, local: state.local === true,
      limit: typeof state.limit === 'string' ? clip(state.limit, 20) : null,
      ...(test ? {lastTest: {state: clip(test.state, 20), code: clip(test.code, 20), status: Number.isInteger(test.status) ? test.status : undefined}} : {})}} : {})};
}

function companionProviders({settings, voice, routing, party}) {
  const routed = new Set(Array.isArray(voice?.routedProfiles) ? voice.routedProfiles : []);
  const routes = new Map((Array.isArray(routing?.routes) ? routing.routes : []).map(row => [row?.profileKey, row]));
  const local = voice?.provider && voice.provider !== 'convai' ? voice.provider : null;
  const rows = [];
  for (const member of party) {
    const key = member.profile || member.key;
    if (!key) continue;
    const route = routes.get(key);
    rows.push({profile: key, state: member.state, conversation: 'convai-realtime',
      voice: local && routed.has(key) ? local : 'convai',
      relationshipStyle: route ? {mode: route.mode, style: route.style ?? route.variant, status: route.status,
        ...(route.multilingual === true ? {multilingual: true} : {})} : undefined,
      conversationEnabled: settings?.enabledByKey ? settings.enabledByKey[key] !== false : undefined});
  }
  return {conversation: 'convai-realtime', voiceSelected: settings?.voiceProvider ?? voice?.requestedProvider ?? null,
    voiceActive: voice?.provider ?? null, voiceState: voice?.state ?? null, omniSteps: voice?.omniSteps ?? settings?.omniSteps ?? null,
    voiceFallback: voice?.fallback ?? null,
    omniReference: voice?.omniReference ?? settings?.omniReference ?? null,
    omniPackInstalled: voice?.omniPack?.installed ?? null,
    keepPreparedVoices: voice?.keepPreparedVoices ?? settings?.keepPreparedVoices ?? null,
    multilingualConversations: settings?.multilingualConversations ?? null,
    companions: rows};
}

/**
 * Builds the report in memory. Nothing is written here.
 *
 * Offline mode (Make support report.bat, bridge/offline-support-report.mjs: the game is closed and no service runs) passes five
 * more options; the service never does, and without them nothing here changes:
 *   offline         true: the README and summary say the report was made with the game closed, and no bridge process is described
 *   logs            the located log list to use instead of locateLogs (the offline tool looks in more than one folder)
 *   extraProblems   more lines for the PROBLEM FOUND block, after the ones the status files give
 *   extraSummary    an object merged into summary.json (it goes through the same redactor as everything else)
 *   accounts        the player's Windows account names, hidden in every path as well (createRedactor)
 */
export async function collectReport(options) {
  const {game, runtime, stateDirectory, project, request, now = Date.now, bridge = {}, environment = process.env} = options;
  const offline = options.offline === true;
  const modRoot = options.modRoot ?? resolve(runtime, '..');
  // The graphics cards (reg.exe, once per process) are looked up while the logs are read, so the report is not slower for it.
  const graphicsSource = options.graphics ?? (() => cachedGraphicsCards());
  const graphicsPending = Promise.resolve().then(() => typeof graphicsSource === 'function' ? graphicsSource() : graphicsSource).catch(() => []);
  const secrets = [...(options.secrets ?? []), ...await credentialSecrets(stateDirectory), ...await customServerSecrets({project: project ?? resolve(runtime, '..'), environment})];
  const redact = createRedactor({secrets, ids: options.knownIds ?? [], accounts: Array.isArray(options.accounts) ? options.accounts : []});
  const logs = Array.isArray(options.logs) ? options.logs : await locateLogs({game, modRoot, runtime, stateDirectory});
  const lua = sanitizeRequest(request ?? {});
  const entries = [], index = [], errors = [];

  let number = 0;
  for (const log of logs) {
    const tail = await tailFile(log.path, {maxLines: log.previous ? 500 : LOG_MAX_LINES});
    if (!tail) { index.push({id: log.id, path: redact.text(log.path), found: false}); continue; }
    const lines = tail.lines.map(line => redact.text(line));
    const name = `logs/${String(++number).padStart(2, '0')}-${log.id}.txt`;
    entries.push({name, data: `# ${redact.text(log.path)}\n# last ${lines.length} lines${tail.truncated ? ' (earlier lines omitted)' : ''}, file modified ${tail.modified}\n${lines.join('\n')}\n`});
    index.push({id: log.id, path: redact.text(log.path), found: true, entry: name, lines: lines.length,
      truncated: tail.truncated, bytes: tail.bytes, modified: tail.modified});
    if (!log.previous) {
      for (const line of lines.slice(-500)) {
        if (ERROR_LINE.test(line) && !NOT_AN_ERROR.test(line)) errors.push({source: log.id, line: line.slice(0, 300)});
      }
    }
  }
  // Newest first, at most 12 per source and 80 overall.
  const perSource = new Map(), recentErrors = [];
  for (const row of errors.reverse()) {
    const count = perSource.get(row.source) ?? 0;
    if (count >= 12 || recentErrors.length >= 80) continue;
    perSource.set(row.source, count + 1); recentErrors.push(row);
  }

  const status = {}, raw = {};
  for (const name of STATUS_FILES) {
    const read = await readSmallJson(join(runtime, name));
    if (read.error) { status[name] = {state: read.error}; continue; }
    raw[name] = read.value;
    status[name] = {modified: read.modified, value: redact.value(compactStatus(name, read.value))};
  }
  const settingsRead = await readSmallJson(join(runtime, 'settings.json'));
  let settings = settingsRead.value, settingsView = {state: settingsRead.error ?? 'present'};
  if (settings && typeof settings === 'object') {
    const {enabledByKey, ...rest} = settings;
    const flags = enabledByKey && typeof enabledByKey === 'object' ? enabledByKey : {};
    settingsView = redact.value({...rest, conversationEnabledCount: Object.values(flags).filter(value => value !== false).length,
      conversationDisabled: Object.keys(flags).filter(key => flags[key] === false)});
  }
  const party = [...lua.party];
  if (!party.length && Array.isArray(raw['party-connections.json']?.profiles)) {
    for (const profile of raw['party-connections.json'].profiles.slice(0, 12)) party.push({profile: clip(profile, 80), state: 'connected'});
  }
  const versionInfo = await versions({game, modRoot, project: project ?? resolve(runtime, '..'), logs, now});
  const problems = [...knownProblems(raw, {lua, now}),
    ...(Array.isArray(options.extraProblems) ? options.extraProblems.filter(line => typeof line === 'string' && line).slice(0, 40) : [])];
  // The player's voice clips (bridge/player-voices.mjs): how many and how long each is, never the audio, the words or a path.
  const voiceClips = await readPlayerVoiceSummary(stateDirectory).catch(() => ({count: 0, clips: []}));
  const cards = await graphicsPending;
  const graphics = (Array.isArray(cards) ? cards : []).slice(0, 8)
    .map(card => ({name: clip(card?.name, 120), memoryMiB: Number.isFinite(card?.memoryMiB) && card.memoryMiB > 0 ? Math.round(card.memoryMiB) : null}))
    .filter(card => card.name);
  const summary = redact.value({
    schema: 1, ...(problems.length ? {problems} : {}), reportId: options.reportId, generatedBy: offline ? 'offline' : 'bridge', generatedAt: new Date(now()).toISOString(),
    privacy: {notes: ['No API keys, tokens, audio, voice references, voice clips, model files or conversation text are included.',
      'IDs are replaced by short hashes; key and token patterns, long secrets and your Windows account name are removed from every log.'],
      redactions: undefined},
    versions: versionInfo,
    ...(options.extraSummary && typeof options.extraSummary === 'object' ? options.extraSummary : {}),
    system: {graphics},
    request: {cetVersion: lua.cetVersion, language: lua.language, view: lua.view, developerMode: lua.developerMode,
      ageMs: Number.isFinite(request?.issuedAt) ? Math.max(0, now() - request.issuedAt) : null, setup: lua.setup},
    // Offline, this is the status the last game session left behind, and no process of this report's own is described.
    bridge: offline ? {offline: true, ...bridge, status} : {pid: process.pid, uptimeSeconds: Math.round(process.uptime()), ...bridge, status},
    settings: settingsView,
    // Settings > Privacy > Send error reports automatically (docs/ERROR_REPORTS.md): on or off, and counts only.
    errorReports: await errorReportStatus({runtime, stateDirectory, now: now()}).catch(() => null),
    localAi: await localAiSection({runtime, project: project ?? resolve(runtime, '..'), environment}),
    party: {companions: party, connections: raw['party-connection-state.json']
      ? redact.value(compactStatus('party-connection-state.json', raw['party-connection-state.json'])) : null},
    conversation: await conversationSection({runtime, settings}),
    providers: companionProviders({settings, voice: raw['local-voice-state.json'], routing: raw['relationship-routing.json'], party}),
    voiceClips,
    recentErrors, logs: index,
  });
  summary.privacy.redactions = {...redact.stats};
  const readme = [
    offline ? 'AI NPC Cyberpunk Mod support report (made with the game closed)' : 'AI NPC Cyberpunk Mod support report',
    `Created ${summary.generatedAt}  (report ${options.reportId})`, '',
    ...(problems.length ? ['PROBLEM FOUND:', ...problems.map(line => `  ${redact.text(line)}`), ''] : []),
    'Send this one file to the developer. It contains:',
    offline
      ? '  summary.json   versions, the requirement check, where the mod files are, service status from the last game start, settings, Local AI detection, recent errors'
      : '  summary.json   versions, graphics card, service status, setup check, settings, Local AI detection, party, provider per companion, recent errors',
    '  logs/*.txt     the end of each mod, service, CET, redscript and RED4ext log (last 2000 lines each);',
    '                 voice-routing.txt lists which voice spoke each reply and why (no reply text)', '',
    'It does NOT contain API keys or tokens, microphone audio, voice references, your own voice clips',
    '(only how many there are and how long each is), model files or conversation text.',
    'IDs are shown as short hashes and your Windows account name is hidden.',
    'You can open the zip and read every file before you send it.', ''].join('\n');
  return {entries: [{name: 'README.txt', data: readme}, {name: 'summary.json', data: JSON.stringify(summary, null, 2) + '\n'}, ...entries],
    summary};
}

const stamp = date => {
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

export async function pruneReports(directory, keep = REPORT_KEEP) {
  let names;
  try { names = (await readdir(directory)).filter(name => REPORT_NAME.test(name)); } catch { return []; }
  // Names embed the creation time; the newest sort last.
  names.sort((a, b) => REPORT_NAME.exec(a)[1].localeCompare(REPORT_NAME.exec(b)[1]) || a.localeCompare(b));
  const removed = names.slice(0, Math.max(0, names.length - keep));
  for (const name of removed) await rm(join(directory, name), {force: true}).catch(() => {});
  return removed;
}

/** Collects, zips, writes into the reports folder (reportsDirectoryFor) and keeps the newest five. */
export async function buildReport(options) {
  const now = options.now ?? Date.now;
  const reportId = options.reportId ?? `r-${stamp(new Date(now()))}`;
  const directory = options.reportsDirectory ?? reportsDirectoryFor(options);
  await mkdir(directory, {recursive: true});
  const {entries, summary} = await collectReport({...options, reportId});
  const archive = createZip(entries, {date: new Date(now())});
  if (archive.length > REPORT_MAX_BYTES) throw Object.assign(Error('Report too large'), {code: 'too-large'});
  let name = `convai-report-${stamp(new Date(now()))}.zip`;
  for (let attempt = 2; await stat(join(directory, name)).then(() => true, () => false); attempt++) {
    name = `convai-report-${stamp(new Date(now()))}-${String.fromCharCode(96 + Math.min(attempt, 26))}.zip`;
  }
  const path = join(directory, name);
  if (!await atomicFile(path, archive)) throw Object.assign(Error('Report was not written'), {code: 'write-failed'});
  await pruneReports(directory);
  return {path, name, bytes: archive.length, entries: entries.length, summary};
}

// -------------------------------------------------------------- bridge side

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export function parseReportRequest(raw, now = Date.now()) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > REQUEST_MAX_BYTES) return null;
  let value; try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
      || typeof value.id !== 'string' || !REQUEST_ID.test(value.id)
      || !Number.isFinite(value.issuedAt) || value.issuedAt < 0) return null;
  return {id: value.id, issuedAt: value.issuedAt, lua: value.lua && typeof value.lua === 'object' ? value.lua : {}};
}

// Copy Report path: the game side cannot always reach the Windows clipboard, so
// it asks the service. Only the path of a report file is ever copied.
export const CLIPBOARD_REQUEST_MAX_AGE_MS = 15_000;
const sameFolder = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
/**
 * `folders` (the service passes the reports folder and runtime/): the text must then be an absolute path to a file directly in one of them.
 * Without it only the file name is checked. Either way nothing but a report's path reaches the clipboard: a request that names something
 * else (a command line that merely ends in a report's name) is refused.
 */
export function parseClipboardRequest(raw, now = Date.now(), {folders} = {}) {
  let value;
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 4096) return null;
  try { value = JSON.parse(raw); } catch { return null; }
  if (value?.version !== 1 || typeof value.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,96}$/.test(value.id)) return null;
  if (!Number.isFinite(value.issuedAt) || Math.abs(now - value.issuedAt) > CLIPBOARD_REQUEST_MAX_AGE_MS) return null;
  if (typeof value.text !== 'string' || value.text.length > 1024 || /[\u0000-\u001f]/.test(value.text)) return null;
  const file = basename(value.text.replaceAll('\\', '/'));
  if (!REPORT_NAME.test(file) && file !== LUA_REPORT_NAME) return null;
  if (Array.isArray(folders)) {
    // A drive path or a UNC path, with none of the characters Windows refuses in a file or folder name.
    if (!/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(value.text) || /[<>"|?*]/.test(value.text.slice(2))) return null;
    if (!folders.some(folder => typeof folder === 'string' && folder && sameFolder(dirname(resolve(value.text)), folder))) return null;
  }
  return {id: value.id, text: value.text};
}
// clip.exe reads UTF-16 text that starts with a byte-order mark, so a Windows
// account name with accents survives. Resolves when the process has exited.
export function copyToClipboard(text) {
  return new Promise((done, fail) => {
    const child = spawn('clip.exe', [], {windowsHide: true, stdio: ['pipe', 'ignore', 'ignore']});
    child.once('error', fail);
    child.once('close', code => code === 0 ? done() : fail(Error(`clip.exe exited with ${code}`)));
    child.stdin.on('error', fail);
    child.stdin.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
  });
}

/** File IPC for the Help page. Only a request that appears after the bridge
 * started, is well formed and is recent produces a report; an old request left
 * by an earlier session is never replayed. */
export class SupportReportControl {
  static async open(options) {
    const control = new SupportReportControl(options);
    control.observed = await readFile(control.requestPath, 'utf8').catch(() => '');
    await publishSupportPaths(control.layout()).catch(() => {});
    return control;
  }
  constructor({game, runtime, stateDirectory, project, requestPath, resultPath, secrets, knownIds, bridge,
    now = Date.now, build = buildReport, clipboardPath, copy = copyToClipboard, graphics}) {
    Object.assign(this, {game, runtime, stateDirectory, project, secrets, knownIds, bridge, now, build, copy, graphics});
    this.clipboardPath = clipboardPath ?? join(runtime, 'clipboard-request.json');
    this.clipboardObserved = ''; this.copied = new Set();
    this.requestPath = requestPath ?? join(runtime, 'report-request.json');
    this.resultPath = resultPath ?? join(runtime, 'report-result.json');
    this.observed = ''; this.polling = false; this.closed = false; this.handled = new Set();
  }
  layout() {
    return {game: this.game, modRoot: resolve(this.runtime, '..'), runtime: this.runtime, stateDirectory: this.stateDirectory, now: this.now};
  }
  publish(value) {
    return atomicFile(this.resultPath, JSON.stringify({version: 1, updated: this.now(), ...value})).catch(() => false);
  }
  async pollClipboard() {
    const raw = await readFile(this.clipboardPath, 'utf8').catch(() => '');
    if (raw === this.clipboardObserved) return;
    this.clipboardObserved = raw;
    const folders = [reportsDirectoryFor({runtime: this.runtime, stateDirectory: this.stateDirectory}), this.runtime];
    const request = parseClipboardRequest(raw, this.now(), {folders});
    if (!request || this.copied.has(request.id)) return;
    this.copied.add(request.id);
    try { await this.copy(request.text); } catch { /* The game still shows the path on the Last report row. */ }
  }
  async poll() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      await this.pollClipboard();
      const raw = await readFile(this.requestPath, 'utf8').catch(() => '');
      if (raw === this.observed) return;
      this.observed = raw;
      const request = parseReportRequest(raw, this.now());
      if (!request || this.handled.has(request.id)) return;
      if (request.issuedAt > this.now() + 5000 || this.now() - request.issuedAt > REQUEST_MAX_AGE_MS) return;
      this.handled.add(request.id);
      await this.publish({id: request.id, state: 'building'});
      try {
        const secrets = typeof this.secrets === 'function' ? await this.secrets() : this.secrets ?? [];
        const knownIds = typeof this.knownIds === 'function' ? await this.knownIds() : this.knownIds ?? [];
        const bridge = typeof this.bridge === 'function' ? await this.bridge() : this.bridge ?? {};
        const result = await this.build({game: this.game, runtime: this.runtime, stateDirectory: this.stateDirectory,
          project: this.project, request, secrets, knownIds, bridge, now: this.now, graphics: this.graphics});
        await publishSupportPaths(this.layout()).catch(() => {});
        await this.publish({id: request.id, state: 'ready', mode: 'bridge', path: result.path, fileName: result.name,
          bytes: result.bytes, entries: result.entries});
      } catch (error) {
        await this.publish({id: request.id, state: 'failed', code: typeof error?.code === 'string' ? error.code : 'failed'});
      }
    } finally { this.polling = false; }
  }
  close() { this.closed = true; }
}
