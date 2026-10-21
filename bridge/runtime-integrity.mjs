// Whether the Runtime's own code files are the ones the release shipped (a changed or extra file means someone else edited the service).
//
// A release ships app/defaults/runtime-code-files.json (packaging/build-release.mjs): every code file of the Runtime's bridge/, launcher/ and
// assets/ folders (.mjs, .cjs, .js, .py) with the first 24 hex digits of its SHA-256. A Runtime update zip replaces the list with the new
// Runtime's, so the list always matches the newest Runtime applied. This module compares the folders with the list:
//   changed  a listed file whose bytes differ;   extra  a code file the list does not know;   missing  a listed file that is gone.
// The result is counts and up to five file names (relative paths in the Runtime, never contents): it goes into the support report and into
// the automatic error reports (docs/ERROR_REPORTS.md).
//
// Cost: on demand only (when a report is built), never at start-up and never on a turn. One directory walk and one stat per code file; a file
// is read and hashed only when its size or modification time differs from what an earlier run in this process saw, so the first report of a
// session hashes the folders once (a few megabytes) and later ones read nothing. A Runtime without the list (before 0.2.8) says so and stops.
import {createHash} from 'node:crypto';
import {readFile, readdir, stat} from 'node:fs/promises';
import {join} from 'node:path';

export const CODE_LIST = 'defaults/runtime-code-files.json';
export const CODE_FOLDERS = Object.freeze(['bridge', 'launcher', 'assets']);
export const CODE_FILE = /\.(?:mjs|cjs|js|py)$/i;
export const HASH_DIGITS = 24;
export const MAX_NAMES = 5;
const SKIPPED_FOLDERS = new Set(['node_modules', '__pycache__']);

export const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, HASH_DIGITS);

/** The list file's text for a Runtime: `rows` is [{path, sha256 | hash}] with paths relative to app/. Sorted, compact. */
export function codeListText({version, rows}) {
  const files = {};
  for (const row of [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) files[row.path] = String(row.hash ?? row.sha256).slice(0, HASH_DIGITS);
  return JSON.stringify({version: 1, runtime: version, digits: HASH_DIGITS, files}) + '\n';
}

/** True for a path (relative to app/, forward slashes) that the list covers. */
export const isCodePath = path => {
  const parts = String(path).split('/');
  return parts.length >= 2 && CODE_FOLDERS.includes(parts[0]) && CODE_FILE.test(path) && !parts.some(part => SKIPPED_FOLDERS.has(part));
};

async function walk(root, folder, found, {list = readdir} = {}) {
  let entries;
  try { entries = await list(join(root, folder), {withFileTypes: true}); } catch { return; }
  for (const entry of entries) {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) { if (!SKIPPED_FOLDERS.has(entry.name)) await walk(root, path, found, {list}); }
    else if (entry.isFile() && CODE_FILE.test(entry.name)) found.push(path);
  }
}

// What an earlier run in this process learned about a file: path -> {size, mtimeMs, hash}. And the list file, by its own modification time.
const fileCache = new Map();
let listCache = null;
/** For tests: forget what the caches hold. */
export function resetRuntimeIntegrityCache() { fileCache.clear(); listCache = null; }

async function shippedList(project) {
  const path = join(project, CODE_LIST);
  let info;
  try { info = await stat(path); } catch { return null; }
  if (listCache && listCache.path === path && listCache.mtimeMs === info.mtimeMs && listCache.size === info.size) return listCache.files;
  let value;
  try { value = JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, '')); } catch { return {damaged: true}; }
  if (!value || value.version !== 1 || !value.files || typeof value.files !== 'object') return {damaged: true};
  listCache = {path, mtimeMs: info.mtimeMs, size: info.size, files: value};
  return value;
}

/**
 * Compares the Runtime folder `project` (app/) with the shipped list: {state, checked, changed, extra, missing, names}.
 *   state  'ok' (all match), 'modified' (something differs), 'no-list' (this Runtime ships no list), 'damaged-list' or 'unavailable'
 *   names  up to five entries "changed bridge/x.mjs", "extra bridge/y.mjs", "missing launcher/z.mjs" (changed first)
 * Never throws.
 */
export async function checkRuntimeFiles({project, concurrency = 8} = {}) {
  try {
    if (!project) return {state: 'unavailable'};
    const list = await shippedList(project);
    if (!list) return {state: 'no-list'};
    if (list.damaged) return {state: 'damaged-list'};
    const found = [];
    for (const folder of CODE_FOLDERS) await walk(project, folder, found);
    found.sort();
    const hashes = new Map();
    let next = 0;
    const worker = async () => {
      while (next < found.length) {
        const path = found[next++];
        try {
          const info = await stat(join(project, path));
          const cached = fileCache.get(path);
          if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) { hashes.set(path, cached.hash); continue; }
          const hash = hashBytes(await readFile(join(project, path)));
          fileCache.set(path, {size: info.size, mtimeMs: info.mtimeMs, hash});
          hashes.set(path, hash);
        } catch { /* a file that vanished while reading counts as missing below */ }
      }
    };
    await Promise.all(Array.from({length: Math.max(1, Math.min(concurrency, found.length))}, worker));
    const shipped = list.files, digits = Number.isInteger(list.digits) ? list.digits : HASH_DIGITS;
    const changed = [], extra = [], missing = [];
    for (const [path, hash] of hashes) {
      if (!Object.prototype.hasOwnProperty.call(shipped, path)) extra.push(path);
      else if (String(shipped[path]) !== hash.slice(0, digits)) changed.push(path);
    }
    for (const path of Object.keys(shipped)) if (!hashes.has(path) && isCodePath(path)) missing.push(path);
    for (const group of [changed, extra, missing]) group.sort();   // the workers finish in any order
    const names = [...changed.map(path => `changed ${path}`), ...extra.map(path => `extra ${path}`), ...missing.map(path => `missing ${path}`)].slice(0, MAX_NAMES);
    return {state: changed.length || extra.length || missing.length ? 'modified' : 'ok', checked: hashes.size, changed: changed.length, extra: extra.length,
      missing: missing.length, ...(typeof list.runtime === 'string' ? {listVersion: list.runtime.slice(0, 40)} : {}), names};
  } catch { return {state: 'unavailable'}; }
}

/** One line for the setup-style lists: "Runtime files: 2 changed, 1 extra (changed bridge/a.mjs, ...)". */
export function integrityLine(result) {
  if (!result) return 'Runtime files: unknown';
  if (result.state === 'ok') return `Runtime files: all ${result.checked} code files match the release`;
  if (result.state !== 'modified') return `Runtime files: ${result.state}`;
  return `Runtime files: ${result.changed} changed, ${result.extra} extra, ${result.missing} missing of ${result.checked} (${result.names.join(', ')})`;
}
