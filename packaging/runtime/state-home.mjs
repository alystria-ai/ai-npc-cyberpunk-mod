// Where the conversation service keeps the player's data, and the one-time move of that data out of the game folder.
// Shipped as app/launcher/state-home.mjs and run by start-service.mjs before anything reads the data folder; it imports nothing
// from the bridge so it can be tested on its own.
//
// The data folder (memories, chat history, keys, voice caches, logs) used to be
//   <game>/bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod/data
// It now lives in
//   %LOCALAPPDATA%/AiNpcCyberpunkMod/data
// because Mod Organizer 2 runs the game, and everything the game starts, inside its virtual file system (USVFS): every file the
// service created under the game folder was redirected into MO2's Overwrite folder, and a CET mod folder that had grown a copy in
// Overwrite could stop loading (CET: "cannot open init.lua"). %LOCALAPPDATA% is outside every folder MO2 maps, so writes there go to
// disk as they are, with or without MO2, Vortex or a manual install. Only the files the game's Lua side must read or write stay in the
// mod folder (runtime/): CET lets Lua open files only inside its own mod folder.
//
// CYBERPUNK_CONVAI_DATA_HOME (an absolute path) puts the data somewhere else, for development or for a player who wants it elsewhere.
// Without %LOCALAPPDATA% (never the case on Windows) the data stays in the game folder as before.
//
// The move (moveGameFolderState) is all or nothing: every file is copied into a staging folder beside the new data folder and
// verified (size and SHA-256) first. Only when every copy is good are they put in place and the originals removed. When anything
// fails, the staging folder is removed, nothing in the old folder is touched, and this start keeps using the old folder; the next
// start tries again. When the new folder already has a file with different content, the newer of the two is used and the other is
// kept under moved-from-game-folder/, never deleted.
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import * as realFs from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';

export const DATA_HOME_NAME = 'AiNpcCyberpunkMod';
export const DATA_HOME_VARIABLE = 'CYBERPUNK_CONVAI_DATA_HOME';
export const KEPT_FOLDER = 'moved-from-game-folder';
export const RECORD_FILE = 'moved-from-game-folder.json';

// Fully qualified Windows paths only (C:\... or \\server\share\...); a relative or drive-relative value is never used.
const QUALIFIED = /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i;
const usable = value => typeof value === 'string' && value === value.trim() && value !== '' && !/[\x00-\x1f]/.test(value)
  && isAbsolute(value) && (process.platform !== 'win32' || QUALIFIED.test(value));

// The folder that holds data/ for this player, or null to keep the data in the game folder. `problem` names an override that was ignored.
export function dataHomeFor(env = process.env) {
  const override = env[DATA_HOME_VARIABLE];
  if (override !== undefined && override !== '') {
    if (usable(override)) return {root: resolve(override), source: 'override'};
    return {root: usable(env.LOCALAPPDATA) ? resolve(env.LOCALAPPDATA, DATA_HOME_NAME) : null, source: 'localappdata',
      problem: `${DATA_HOME_VARIABLE} is not an absolute path and was ignored`};
  }
  if (usable(env.LOCALAPPDATA)) return {root: resolve(env.LOCALAPPDATA, DATA_HOME_NAME), source: 'localappdata'};
  return {root: null, source: 'game-folder'};
}

// Files a running service leaves behind: never state, and a stale lock or pid must never be carried.
const VOLATILE = /\.(?:lock|pid|tmp|migrating)$|^bridge-control\.json$/i;
// Files prepare-state.mjs writes from the package on every start: not copied (they would be rewritten anyway), only removed.
const GENERATED_FILES = new Set(['pocket-voices.autobest.json', 'local-voices.autobest-short.json', 'local-voices.autobest-long.json',
  'voice-configs.json']);
const GENERATED_FOLDERS = ['lipsync-model'];
const LOCK = 'bridge-supervisor.lock';

export function classify(rel) {
  const parts = rel.split('/'), name = parts[parts.length - 1];
  if (VOLATILE.test(name)) return 'volatile';
  if (parts.length === 1 && GENERATED_FILES.has(name)) return 'generated';
  if (parts.length > 1 && GENERATED_FOLDERS.includes(parts[0])) return 'generated';
  return 'state';
}

const statOrNull = async (fs, path) => { try { return await fs.lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

function hashFile(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', fail).on('end', () => done(hash.digest('hex')));
  });
}

async function sameContent(fs, a, b) {
  const [x, y] = await Promise.all([fs.stat(a), fs.stat(b)]);
  return x.size === y.size && (await hashFile(a)) === (await hashFile(b));
}

// Every regular file under root as a forward-slash relative path, plus every folder (deepest first, for removal).
async function walk(fs, root) {
  const files = [], folders = [];
  const visit = async base => {
    for (const entry of await fs.readdir(base ? join(root, ...base.split('/')) : root, {withFileTypes: true})) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await visit(rel); folders.push(rel); }
      else if (entry.isFile()) files.push(rel);
      // Links and other entries are left alone (the folder then stays, which is safe).
    }
  };
  await visit('');
  return {files, folders};
}

const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const inside = (parent, child) => { const rel = relative(resolve(parent), resolve(child)); return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel)); };

/**
 * Moves the data folder from `from` (the old folder in the game) to `to` (the new data folder). Returns
 *   {found: false}                                    nothing to move (one lstat when there is no old folder)
 *   {found: true, state: 'moved', ...counts}          moved; the old folder is gone (or only leftovers that could not be removed)
 *   {found: true, state: 'deferred', reason}          nothing was changed; use the old folder for this start
 */
export async function moveGameFolderState({from, to, log = () => {}, fs = realFs, now = () => new Date()} = {}) {
  if (!from || !to || samePath(from, to)) return {found: false};
  if (inside(from, to) || inside(to, from)) return {found: false};
  const info = await statOrNull(fs, from);
  if (!info?.isDirectory()) return {found: false};

  // A service from an earlier game session that still holds the old lock is still writing there: leave everything for the next start.
  const lock = join(from, LOCK);
  if (await statOrNull(fs, lock)) {
    try { await fs.rm(lock, {force: true}); } catch (error) {
      log(`The data folder in the game folder is still in use (${error.code || error.message}); it is used for this start and moved on the next one.`);
      return {found: true, state: 'deferred', reason: 'in-use'};
    }
  }

  const {files, folders} = await walk(fs, from);
  const state = files.filter(rel => classify(rel) === 'state');
  const staging = join(to, `.moving-${process.pid}`);
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const result = {found: true, state: 'moved', moved: 0, same: 0, keptOlder: [], keptReplaced: [], leftovers: []};
  try {
    await fs.mkdir(to, {recursive: true});
    await fs.rm(staging, {recursive: true, force: true});
    // 1. Copy and verify everything. Any failure leaves the old folder untouched.
    for (const rel of state) {
      const src = join(from, ...rel.split('/')), copy = join(staging, ...rel.split('/'));
      await fs.mkdir(dirname(copy), {recursive: true});
      await fs.copyFile(src, copy);
      if (!await sameContent(fs, src, copy)) throw Object.assign(Error(`the copy of ${rel} did not match`), {code: 'EVERIFY'});
    }
  } catch (error) {
    await fs.rm(staging, {recursive: true, force: true}).catch(() => {});
    log(`Moving the data folder to ${to} failed (${error.code || error.message}); the game folder copy is used for this start and the move is tried again on the next.`);
    return {found: true, state: 'deferred', reason: error.code || 'copy-failed'};
  }

  // 2. Put the copies in place. From here on every original has a verified copy, so a problem only leaves a duplicate behind.
  const keep = async (path, kind, rel) => {
    const target = join(to, KEPT_FOLDER, `${stamp}-${kind}`, ...rel.split('/'));
    await fs.mkdir(dirname(target), {recursive: true});
    await fs.rename(path, target);
  };
  for (const rel of state) {
    const src = join(from, ...rel.split('/')), copy = join(staging, ...rel.split('/')), dst = join(to, ...rel.split('/'));
    try {
      const existing = await statOrNull(fs, dst);
      if (!existing) {
        await fs.mkdir(dirname(dst), {recursive: true});
        await fs.rename(copy, dst);
        result.moved++;
      } else if (existing.isFile() && await sameContent(fs, copy, dst)) {
        result.same++;
      } else if (existing.isFile() && (await fs.stat(src)).mtimeMs > existing.mtimeMs) {
        // The game folder copy is newer (for example, written by an older Runtime after an earlier move): it is used.
        await keep(dst, 'replaced', rel);
        await fs.rename(copy, dst);
        result.keptReplaced.push(rel);
      } else {
        // The data folder copy is newer, or the path is a folder there: the game folder copy is kept aside.
        await keep(copy, 'older', rel);
        result.keptOlder.push(rel);
      }
    } catch (error) {
      result.leftovers.push(rel);
      log(`Could not place ${rel} in ${to} (${error.code || error.message}); the original stays in the game folder for the next start.`);
      continue;
    }
    await fs.rm(src, {force: true}).catch(() => result.leftovers.push(rel));
  }
  // 3. Volatile and generated files are not state; remove them, then the empty folders, then the old folder itself.
  for (const rel of files) {
    if (classify(rel) !== 'state') await fs.rm(join(from, ...rel.split('/')), {force: true}).catch(() => result.leftovers.push(rel));
  }
  for (const rel of folders) await fs.rmdir(join(from, ...rel.split('/'))).catch(() => {});
  await fs.rmdir(from).catch(() => {});
  await fs.rm(staging, {recursive: true, force: true}).catch(() => {});

  const record = {version: 1, at: now().toISOString(), from, to, moved: result.moved, identical: result.same,
    replaced: result.keptReplaced, older: result.keptOlder, leftovers: result.leftovers};
  try { await fs.writeFile(join(to, RECORD_FILE), JSON.stringify(record, null, 2) + '\n'); } catch {}
  log(`Moved the player's data from ${from} to ${to}: ${result.moved} file(s) moved, ${result.same} already there`
    + (result.keptReplaced.length ? `, ${result.keptReplaced.length} newer in the game folder (the other copy is kept under ${KEPT_FOLDER})` : '')
    + (result.keptOlder.length ? `, ${result.keptOlder.length} older in the game folder (kept under ${KEPT_FOLDER})` : '')
    + (result.leftovers.length ? `; ${result.leftovers.length} left in the game folder for the next start` : '') + '.');
  return result;
}
