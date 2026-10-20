#!/usr/bin/env node
// Developer-side: copy the automatic error reports from the sign-in backend (auth-backend/, "Error reports" in its README) into
// local files you can read and grep, and write an index of what is there.
//
//   node scripts/Fetch-ErrorReports.mjs [--url https://<address>] [--admin-secret-file <path>] [--out <dir>] [--limit N] [--delete-fetched]
//
//   --url                 the backend address (only its origin is used). Default: the origin of "url" in runtime/convai-auth.json.
//   --admin-secret-file   a file holding the admin secret. Default: runtime/convai-auth-admin.txt, else auth-backend/secrets/admin.secret.
//   --out                 where the reports go. Default: deliverables/error-reports (git ignored).
//   --limit N             how many signatures to list (1 to 200, default 100; the newest first).
//   --delete-fetched      after a report is saved here, delete it on the server (the counts stay in the server's index).
//
// For every signature the server lists, each kept report that is not yet saved is fetched into <out>/<signature>/<id>.json, then
// <out>/INDEX.md is rewritten: one row per signature, newest first. Signatures that are saved here but gone from the server are kept
// and marked "(expired on server)". The admin secret goes only in the Authorization header: it is never printed, written to a file,
// or put in an address. The address must be https (http only for localhost, for tests). This script only runs on the developer's
// machine; it does not ship and uses nothing outside Node.
import {mkdir, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SIGNATURE = /^[0-9a-f]{16}$/;
export const REPORT_ID = /^\d{13}-[0-9a-f]{6}$/;
const FETCH_AT_ONCE = 6;
const TIMEOUT_MS = 30_000;

/** A problem with how the script was called or set up (exit code 2), as opposed to a failure while fetching (exit code 1). */
export class UsageError extends Error {}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The origin of `text` when it is https (or http to localhost, for tests); anything else is refused. */
export function checkBaseUrl(text) {
  let url;
  try {
    url = new URL(String(text ?? '').trim());
  } catch {
    throw new UsageError('The backend address is not a valid address (expected https://<address>).');
  }
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) return url.origin;
  throw new UsageError('The backend address must start with https:// (http is only accepted for localhost).');
}

const readText = async path => {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

/** The backend origin from `url` in runtime/convai-auth.json. Nothing else in that file is read into anything. */
export async function readBackendOrigin(root) {
  const path = resolve(root, 'runtime', 'convai-auth.json');
  const text = await readText(path);
  if (text === null) throw new UsageError(`Backend settings file not found: ${path} (or give the address with --url https://<address>).`);
  let address;
  try {
    address = JSON.parse(text.replace(/^﻿/, '')).url;
  } catch {
    throw new UsageError(`Could not read ${path} as JSON (give the address with --url instead).`);
  }
  if (typeof address !== 'string' || !address.trim()) throw new UsageError(`${path} has no "url" (give the address with --url instead).`);
  return checkBaseUrl(address);
}

/** The admin secret, trimmed, from the first of `paths` that exists. An explicit path that is missing or empty is an error that names it. */
export async function readAdminSecret(paths) {
  for (const path of paths) {
    const text = await readText(path);
    if (text === null) continue;
    const secret = text.trim();
    if (!secret) throw new UsageError(`Admin secret file is empty: ${path}`);
    return secret;
  }
  throw new UsageError(`Admin secret file not found: ${paths[0]}${paths.length > 1 ? ` (also tried ${paths.slice(1).join(', ')})` : ''}.`);
}

// --- Index ------------------------------------------------------------------------------------------------------------------------

const versionParts = text => String(text).split(/[-+]/)[0].split('.').map(Number);
const compareVersions = (a, b) => {
  const left = versionParts(a), right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference) return difference;
  }
  return 0;
};
const formatVersions = versions => Object.entries(versions ?? {}).sort((a, b) => compareVersions(b[0], a[0]) || (a[0] < b[0] ? 1 : -1))
  .map(([version, count]) => `${version} x${count}`).join(', ');
const cell = (text, limit = Infinity) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const characters = Array.from(flat);
  const cutText = characters.length > limit ? `${characters.slice(0, limit - 3).join('')}...` : flat;
  return cutText.replace(/\|/g, '\\|');
};
const isoOfId = id => new Date(Number(id.slice(0, 13))).toISOString();

/** What is saved under <out>: signature -> sorted ids (oldest first). */
async function savedReports(out) {
  const saved = new Map();
  let names = [];
  try {
    names = await readdir(out);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const name of names) {
    if (!SIGNATURE.test(name)) continue;
    let files = [];
    try {
      files = await readdir(join(out, name));
    } catch { continue; }
    const ids = files.filter(file => file.endsWith('.json') && REPORT_ID.test(file.slice(0, -5))).map(file => file.slice(0, -5)).sort();
    if (ids.length) saved.set(name, ids);
  }
  return saved;
}

/** A row for a signature that is only known from the files saved here (the server no longer lists it). */
async function rowFromFiles(out, signature, ids) {
  const versions = {};
  let kind = '', message = '';
  for (const id of ids) {
    try {
      const report = JSON.parse(await readFile(join(out, signature, `${id}.json`), 'utf8')).report ?? {};
      kind = String(report.kind ?? kind);
      message = String(report.message ?? message);
      if (typeof report.modVersion === 'string') versions[report.modVersion] = (versions[report.modVersion] ?? 0) + 1;
    } catch { /* an unreadable file still counts as a file */ }
  }
  return {signature, kind, message, reports: null, stored: null, versions, firstSeen: isoOfId(ids[0]), lastSeen: isoOfId(ids.at(-1)), expired: true};
}

const seconds = ms => (Number.isFinite(ms) ? `${Math.round(ms / 100) / 10} s` : '-');

/**
 * One table row per saved `slow-turn` report (bridge/slow-turns.mjs): when the replies were slow and how they grew, from the numbers the
 * report carries (the first turns of the session against the slow ones), so the growth shows without opening a file.
 */
async function slowTurnLines(out, slowRows, saved) {
  const lines = [];
  for (const row of slowRows) {
    for (const id of saved.get(row.signature) ?? []) {
      let body;
      try { body = JSON.parse(await readFile(join(out, row.signature, `${id}.json`), 'utf8')).report; } catch { continue; }
      const slow = body?.report?.slow;
      if (!slow || typeof slow !== 'object') continue;
      const list = items => (Array.isArray(items) ? items : []).map(item => seconds(item?.soundMs)).join(', ') || '-';
      lines.push(`| \`${row.signature}/${id}\` | ${cell(body.modVersion)} | ${cell(slow.provider ?? body.report?.choices?.provider)} | ${cell(slow.voice ?? body.report?.choices?.voice)} | ${cell(slow.turns)} | ${cell(slow.minutes)} | ${cell(list(slow.first))} | ${cell(list(slow.slow))} | ${cell(slow.reason)} |`);
    }
  }
  return lines;
}

/**
 * Rewrites <out>/INDEX.md: when it was fetched, a table sorted by last seen (newest first) of the signatures the server listed plus
 * the ones only saved here, and a totals line. `signatures` is the server's list (its `signatures` array). Returns the path.
 */
export async function writeIndex({out, signatures, fetchedAt = Date.now()}) {
  const saved = await savedReports(out);
  const rows = signatures.filter(row => SIGNATURE.test(String(row?.signature))).map(row => ({...row, expired: false}));
  const listed = new Set(rows.map(row => row.signature));
  for (const [signature, ids] of saved) if (!listed.has(signature)) rows.push(await rowFromFiles(out, signature, ids));
  rows.sort((a, b) => String(b.lastSeen ?? '').localeCompare(String(a.lastSeen ?? '')) || (a.signature < b.signature ? -1 : 1));

  const lines = ['# Error reports', '', `Fetched ${new Date(fetchedAt).toISOString()}.`, '',
    '| Signature | Kind | Message | Reports | Kept | Versions | First seen | Last seen | Files here |',
    '|---|---|---|---|---|---|---|---|---|'];
  let reports = 0, kept = 0, files = 0, expired = 0;
  for (const row of rows) {
    const here = saved.get(row.signature)?.length ?? 0;
    reports += Number(row.reports) || 0;
    kept += Number(row.stored) || 0;
    files += here;
    if (row.expired) expired += 1;
    lines.push(`| \`${row.signature}\`${row.expired ? ' (expired on server)' : ''} | ${cell(row.kind)} | ${cell(row.message, 120)} | ${row.reports ?? '-'} | ${row.stored ?? '-'} | ${cell(formatVersions(row.versions))} | ${cell(row.firstSeen)} | ${cell(row.lastSeen)} | ${here} |`);
  }
  // By kind (a report kind is one word: turn-failed, voice-failed, slow-turn, ...), most reports first; then what each saved slow-turn report says.
  const kinds = new Map();
  for (const row of rows) kinds.set(String(row.kind || 'unknown'), (kinds.get(String(row.kind || 'unknown')) ?? 0) + (Number(row.reports) || saved.get(row.signature)?.length || 0));
  lines.push('', `By kind: ${[...kinds].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([kind, total]) => `${kind} x${total}`).join(', ') || 'none'}.`);
  const slow = await slowTurnLines(out, rows.filter(row => row.kind === 'slow-turn'), saved);
  if (slow.length) lines.push('', '### Slow replies (kind slow-turn)', '',
    '| Report | Version | Provider | Voice | Turns | Minutes in | First sound, first turns | First sound, slow turns | Trigger |', '|---|---|---|---|---|---|---|---|---|', ...slow);
  lines.push('', `Totals: ${rows.length} signatures (${expired} expired on server), ${reports} reports, ${kept} kept on the server, ${files} files here.`, '');
  await mkdir(out, {recursive: true});
  const path = join(out, 'INDEX.md');
  await writeFile(path, lines.join('\n'));
  return path;
}

// --- Fetching ---------------------------------------------------------------------------------------------------------------------

const exists = async path => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** Runs `work` over `items`, a few at a time. */
async function inParallel(items, work) {
  let next = 0;
  await Promise.all(Array.from({length: Math.min(FETCH_AT_ONCE, items.length)}, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

function failure(response, data) {
  const code = data && typeof data.error === 'string' ? ` (${data.error.slice(0, 40)})` : '';
  const hint = {
    401: ' The admin secret is not the one the server holds.',
    404: ' The server has no admin secret set, or no error endpoint.',
    503: ' The server could not reach its store; try again later.',
  }[response.status] ?? '';
  return new Error(`The server answered ${response.status}${code}.${hint}`);
}

/**
 * Saves every kept report the server lists that is not saved yet, then rewrites INDEX.md. `fetchImpl` is fetch (a fake in the tests).
 * Returns {signatures, total, newReports, alreadyHere, gone, deleted, indexPath, out}.
 */
export async function fetchErrorReports({baseUrl, secret, out, limit = 100, fetchImpl = fetch, now = Date.now, deleteFetched = false}) {
  const origin = checkBaseUrl(baseUrl);
  if (!secret) throw new UsageError('No admin secret given.');
  const call = async (query, method = 'GET') => {
    // A redirect would send the Authorization header somewhere else: refuse to follow one.
    const response = await fetchImpl(`${origin}/api/admin/errors?${query}`, {method, redirect: 'error', cache: 'no-store',
      headers: {Authorization: `Bearer ${secret}`, Accept: 'application/json'}, signal: AbortSignal.timeout(TIMEOUT_MS)});
    let data = null;
    try { data = await response.json(); } catch { /* not JSON */ }
    return {response, data};
  };

  const listing = await call(`limit=${Math.min(200, Math.max(1, Math.trunc(limit) || 100))}`);
  if (!listing.response.ok) throw failure(listing.response, listing.data);
  const signatures = Array.isArray(listing.data?.signatures) ? listing.data.signatures : [];
  const summary = {signatures: signatures.length, total: Number(listing.data?.total) || signatures.length, newReports: 0, alreadyHere: 0, gone: 0, deleted: 0, indexPath: '', out};

  const wanted = [];
  for (const row of signatures) {
    if (!SIGNATURE.test(String(row?.signature))) continue;
    for (const id of Array.isArray(row.ids) ? row.ids : []) if (REPORT_ID.test(String(id))) wanted.push({signature: row.signature, id: String(id)});
  }
  await inParallel(wanted, async ({signature, id}) => {
    const file = join(out, signature, `${id}.json`);
    if (await exists(file)) summary.alreadyHere += 1;
    else {
      const {response, data} = await call(`signature=${signature}&id=${id}`);
      if (response.status === 404) {
        summary.gone += 1; // dropped on the server between the list and now
        return;
      }
      if (!response.ok) throw failure(response, data);
      await mkdir(join(out, signature), {recursive: true});
      await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
      summary.newReports += 1;
    }
    // Only a report that is saved here (just now or before) is ever deleted on the server.
    if (deleteFetched && await exists(file)) {
      const {response, data} = await call(`signature=${signature}&id=${id}`, 'DELETE');
      if (!response.ok) throw failure(response, data);
      if (data?.deleted) summary.deleted += 1;
    }
  });
  summary.indexPath = await writeIndex({out, signatures, fetchedAt: now()});
  return summary;
}

// --- Command line -----------------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {deleteFetched: false, help: false};
  const withValue = {'--url': 'url', '--admin-secret-file': 'secretFile', '--out': 'out', '--limit': 'limit'};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--delete-fetched') options.deleteFetched = true;
    else if (name === '--help' || name === '-h') options.help = true;
    else if (withValue[name]) {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value.`);
      options[withValue[name]] = value;
    } else throw new UsageError(`Unknown option: ${name}`);
  }
  if (options.limit !== undefined && !(/^\d{1,3}$/.test(options.limit) && Number(options.limit) >= 1 && Number(options.limit) <= 200)) {
    throw new UsageError('--limit must be a whole number from 1 to 200.');
  }
  return options;
}

const USAGE = 'Usage: node scripts/Fetch-ErrorReports.mjs [--url https://<address>] [--admin-secret-file <path>] [--out <dir>] [--limit N] [--delete-fetched]';

/** The whole command, with its inputs injectable for the tests. Returns the exit code: 0 done, 1 fetching failed, 2 bad call or setup. */
export async function run(argv, {root = projectRoot, fetchImpl = fetch, now = Date.now, log = console.log, error = console.error} = {}) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      log(USAGE);
      return 0;
    }
    const baseUrl = options.url ? checkBaseUrl(options.url) : await readBackendOrigin(root);
    const secret = await readAdminSecret(options.secretFile ? [resolve(options.secretFile)]
      : [resolve(root, 'runtime', 'convai-auth-admin.txt'), resolve(root, 'auth-backend', 'secrets', 'admin.secret')]);
    const out = resolve(options.out ?? join(root, 'deliverables', 'error-reports'));
    const summary = await fetchErrorReports({baseUrl, secret, out, limit: Number(options.limit ?? 100), fetchImpl, now, deleteFetched: options.deleteFetched});
    log(`${summary.signatures} signatures (${summary.total} on the server), ${summary.newReports} new reports written, ${summary.alreadyHere} already here${summary.gone ? `, ${summary.gone} gone from the server` : ''}${options.deleteFetched ? `, ${summary.deleted} deleted on the server` : ''}.`);
    log(`Index: ${summary.indexPath}`);
    return 0;
  } catch (problem) {
    if (problem instanceof UsageError) {
      error(problem.message);
      if (/^(Unknown option|--)/.test(problem.message)) error(USAGE);
      return 2;
    }
    error(`Fetching the error reports failed: ${problem instanceof Error ? problem.message : 'unknown failure'}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
