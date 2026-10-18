// Carry-over from the folders this mod used before it was renamed to "AI NPC Cyberpunk Mod".
//
// The first releases installed under the name CyberpunkConvai:
//   bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai/        (CET Lua, data/ and runtime/ = the player's state)
//   red4ext/plugins/CyberpunkConvai/                                 (launcher + app/, voices/, the optional packs in app/local-ai and app/omni)
//   red4ext/plugins/CyberpunkConvaiNative/                           (the optional native plugin)
// The mod now lives under AiNpcCyberpunkMod (the same two folders) and AiNpcCyberpunkModNative. A player who extracts the new packages over
// an old installation has both. This file, shipped as app/launcher/migrate-legacy.mjs and run by start-service.mjs before anything else
// reads the player's data, makes sure that
//   - the old copy cannot start (its init.lua and its DLLs are renamed; renaming works even for a DLL the game has loaded),
//   - everything the player owns moves to the new folders and is verified there, and only then are the old folders removed,
//   - nothing is ever deleted that has not been moved or compared first: an old file that cannot be placed stays where it is,
//     and the old folder is kept (its state is still on disk) until the next start retries.
//
// Two phases, so the start of the game never waits for a big deletion:
//   adoptLegacyInstall   blocking and quick: retire the old copy, move the state (renames, no copying on one drive), carry the
//                        key bindings. Does nothing, apart from three stat calls, when there is no old folder.
//   cleanupLegacyInstall removes what is left of the old folders (the old application, Chrome, Python...). The service runs it a
//                        while after the start, off the main path. A locked file only postpones it to the next start.
//
// What is the player's state (moved):
//   mods/<old>/data, mods/<old>/runtime   settings, keys, memories, chat history, voice settings (volatile files are dropped)
//   red4ext/plugins/<old>/app/local-ai    the Local AI and Mature packs
//   red4ext/plugins/<old>/app/omni        the OmniVoice pack
//   red4ext/plugins/<old>/voices          reference clips (clips the new package also ships are not duplicated)
// Conflicts: a state file that exists in both places keeps the OLD content (it is the player's), and the new file it displaces is
// saved under data/legacy-migration/replaced; package files (packs, voices, runtime/native-off.txt) keep the NEW content.
// Everything in an old folder that is neither package code nor state is kept under data/legacy-migration/leftovers.
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import * as realFs from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';

export const NEW_NAME = 'AiNpcCyberpunkMod';
export const LEGACY_NAME = 'CyberpunkConvai';
export const REPORT_FILE = 'legacy-migration.json';

// stateDirectory: where the new installation keeps the player's data (state-home.mjs); the new mod folder's data/ by default.
export function legacyPaths(gameRoot, {stateDirectory} = {}) {
  const game = resolve(gameRoot);
  const cet = join(game, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks');
  const plugins = join(game, 'red4ext', 'plugins');
  return Object.freeze({
    game, bindings: join(cet, 'bindings.json'),
    oldMod: join(cet, 'mods', LEGACY_NAME), oldPlugin: join(plugins, LEGACY_NAME), oldNative: join(plugins, `${LEGACY_NAME}Native`),
    newMod: join(cet, 'mods', NEW_NAME), newPlugin: join(plugins, NEW_NAME), newNative: join(plugins, `${NEW_NAME}Native`),
    newState: stateDirectory ? resolve(stateDirectory) : join(cet, 'mods', NEW_NAME, 'data'),
  });
}

// Files a running service or game session leaves behind: not state, and a stale lock or pid must never be carried over.
const VOLATILE = /\.(?:log|lock|pid|tmp)$|^bridge-(?:service|control)\.json$/i;
const isVolatile = name => VOLATILE.test(name);
// Files that belong to the package even when they live in a state folder: the new package's copy wins.
const PACKAGE_FILES = new Set(['native-off.txt']);

const MOVE_FALLBACK = new Set(['EXDEV', 'EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EEXIST', 'EMFILE']);

async function exists(fs, path) { try { await fs.lstat(path); return true; } catch { return false; } }
const statOrNull = async (fs, path) => { try { return await fs.lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

function hashFile(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', chunk => hash.update(chunk)).on('error', fail).on('end', () => done(hash.digest('hex')));
  });
}

async function sameFile(fs, a, b) {
  const [x, y] = await Promise.all([fs.lstat(a), fs.lstat(b)]);
  if (x.size !== y.size) return false;
  return (await hashFile(a)) === (await hashFile(b));
}

async function listFiles(fs, root, base = '') {
  const out = [];
  for (const entry of await fs.readdir(join(root, base), {withFileTypes: true})) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await listFiles(fs, root, rel));
    else out.push(rel);
  }
  return out;
}

async function copyTree(fs, src, dst) {
  const info = await fs.lstat(src);
  if (info.isDirectory()) {
    await fs.mkdir(dst, {recursive: true});
    for (const name of await fs.readdir(src)) await copyTree(fs, join(src, name), join(dst, name));
  } else {
    await fs.mkdir(dirname(dst), {recursive: true});
    await fs.copyFile(src, dst);
  }
}

// Every file of src exists in dst with the same size and SHA-256.
async function verifyTree(fs, src, dst) {
  const info = await fs.lstat(src);
  if (!info.isDirectory()) return (await statOrNull(fs, dst))?.isFile() === true && await sameFile(fs, src, dst);
  for (const rel of await listFiles(fs, src)) {
    const target = join(dst, ...rel.split('/'));
    if (!(await statOrNull(fs, target))?.isFile() || !await sameFile(fs, join(src, ...rel.split('/')), target)) return false;
  }
  return true;
}

// Moves one file or folder. A rename is atomic and instant on one drive (the case here); when it is refused the content is copied,
// compared and only then removed from the source. A failed verification throws and leaves the source untouched.
async function moveEntry(fs, src, dst) {
  await fs.mkdir(dirname(dst), {recursive: true});
  try { await fs.rename(src, dst); return 'renamed'; } catch (error) {
    if (error.code === 'ENOENT') throw error;
    if (!MOVE_FALLBACK.has(error.code)) throw error;
  }
  const staging = `${dst}.migrating`;
  await fs.rm(staging, {recursive: true, force: true});
  await copyTree(fs, src, staging);
  if (!await verifyTree(fs, src, staging)) {
    await fs.rm(staging, {recursive: true, force: true});
    throw Object.assign(new Error(`verification of ${src} failed; it was not removed`), {code: 'EVERIFY'});
  }
  await fs.rename(staging, dst);
  await fs.rm(src, {recursive: true, force: true});
  return 'copied';
}

// Merges the old folder src into the new folder dst. `kind` is 'state' (old wins) or 'package' (new wins).
async function mergeTree(ctx, src, dst, kind, rel = '') {
  const {fs, report} = ctx;
  const info = await statOrNull(fs, src);
  if (!info) return;
  const label = rel || '.';
  if (info.isDirectory()) {
    const target = await statOrNull(fs, dst);
    if (!target) { await place(ctx, src, dst, label); return; }
    if (!target.isDirectory()) { report.errors.push(`${src}: the new location is a file; kept`); return; }
    for (const name of await fs.readdir(src)) {
      if (kind === 'state' && rel === '' && isVolatile(name)) continue; // not state: dropped with the old folder
      await mergeTree(ctx, join(src, name), join(dst, name), kind, rel ? `${rel}/${name}` : name);
    }
    await fs.rmdir(src).catch(() => {});
    return;
  }
  const target = await statOrNull(fs, dst);
  if (!target) { await place(ctx, src, dst, label); return; }
  if (target.isFile() && await sameFile(fs, src, dst)) { await fs.rm(src, {force: true}); return; }
  const name = rel.split('/').pop();
  if (kind === 'package' || PACKAGE_FILES.has(name)) { await fs.rm(src, {force: true}); report.packageKept.push(rel); return; }
  // State conflict: the old content wins; the file it displaces is saved, not deleted.
  const saved = join(ctx.paths.newState, 'legacy-migration', 'replaced', ctx.tag, ...rel.split('/'));
  await fs.mkdir(dirname(saved), {recursive: true});
  await fs.rename(dst, saved);
  await place(ctx, src, dst, label);
  report.replaced.push(rel);
}

async function place(ctx, src, dst, label) {
  try {
    const how = await moveEntry(ctx.fs, src, dst);
    ctx.report.moved.push({area: ctx.tag, path: label, how});
  } catch (error) {
    if (error.code === 'ENOENT') return; // moved by another start of the service
    ctx.report.errors.push(`${src}: ${error.message}`);
    ctx.log(`Could not move ${src}: ${error.message}. It stays where it is.`);
  }
}

// Drops stale lock, pid, log and status files that came over with a whole folder.
async function purgeVolatile(fs, directory) {
  for (const entry of await fs.readdir(directory, {withFileTypes: true}).catch(() => [])) {
    if (entry.isFile() && isVolatile(entry.name)) await fs.rm(join(directory, entry.name), {force: true}).catch(() => {});
  }
}

// CET keeps the key bindings under the mod's folder name. The old entry is renamed (as text, so the 64-bit numbers keep their digits).
export async function carryBindings(paths, fs = realFs) {
  let text;
  try { text = await fs.readFile(paths.bindings, 'utf8'); } catch { return 'none'; }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return 'unreadable'; }
  if (!parsed || typeof parsed !== 'object' || !(LEGACY_NAME in parsed) || NEW_NAME in parsed) return 'none';
  const next = text.replace(/"CyberpunkConvai"(\s*:\s*\{)/, `"${NEW_NAME}"$1`);
  let check;
  try { check = JSON.parse(next); } catch { return 'unreadable'; }
  if (!(NEW_NAME in check) || LEGACY_NAME in check || Object.keys(check).length !== Object.keys(parsed).length) return 'unreadable';
  const backup = `${paths.bindings}.pre-ai-npc-rename.bak`;
  if (!await exists(fs, backup)) await fs.writeFile(backup, text);
  const temporary = `${paths.bindings}.${process.pid}.tmp`;
  await fs.writeFile(temporary, next);
  await fs.rename(temporary, paths.bindings);
  return 'renamed';
}

// Makes the old copy unable to start: init.lua and every DLL beside the old plugin folders are renamed. Nothing is deleted here.
async function retire(ctx) {
  const {fs, paths, report} = ctx;
  const rename = async (path) => {
    const target = `${path}.migrated`;
    try { await fs.rm(target, {force: true}); await fs.rename(path, target); report.retired.push(path); } catch (error) {
      if (error.code !== 'ENOENT') report.errors.push(`${path}: could not be retired (${error.code || error.message})`);
    }
  };
  await rename(join(paths.oldMod, 'init.lua'));
  for (const folder of [paths.oldPlugin, paths.oldNative]) {
    for (const entry of await fs.readdir(folder, {withFileTypes: true}).catch(() => [])) {
      if (entry.isFile() && /\.dll$/i.test(entry.name)) await rename(join(folder, entry.name));
    }
  }
}

export async function adoptLegacyInstall({gameRoot, stateDirectory, log = () => {}, fs = realFs} = {}) {
  const paths = legacyPaths(gameRoot, {stateDirectory});
  const present = [];
  for (const key of ['oldMod', 'oldPlugin', 'oldNative']) if (await exists(fs, paths[key])) present.push(key);
  if (!present.length) return {found: false, paths};
  const report = {version: 1, at: new Date().toISOString(), folders: present.map(key => paths[key]), retired: [], moved: [], replaced: [],
    packageKept: [], bindings: 'none', leftovers: [], pending: [], errors: []};
  const ctx = {fs, paths, report, log, tag: 'mod'};
  log(`An older installation (${NEW_NAME} was called ${LEGACY_NAME}) was found: ${present.map(key => paths[key]).join(', ')}.`);
  await retire(ctx);
  // runtime/native-off.txt belongs to the package (a later update changes the list), so it is never carried: the new package writes its own.
  for (const name of PACKAGE_FILES) await fs.rm(join(paths.oldMod, 'runtime', name), {force: true}).catch(() => {});
  const merges = [
    ['mod/data', join(paths.oldMod, 'data'), paths.newState, 'state'],
    ['mod/runtime', join(paths.oldMod, 'runtime'), join(paths.newMod, 'runtime'), 'state'],
    ['plugin/local-ai', join(paths.oldPlugin, 'app', 'local-ai'), join(paths.newPlugin, 'app', 'local-ai'), 'package'],
    ['plugin/omni', join(paths.oldPlugin, 'app', 'omni'), join(paths.newPlugin, 'app', 'omni'), 'package'],
    ['plugin/voices', join(paths.oldPlugin, 'voices'), join(paths.newPlugin, 'voices'), 'package'],
  ];
  for (const [tag, src, dst, kind] of merges) {
    ctx.tag = tag.replace('/', '-');
    try { await mergeTree(ctx, src, dst, kind); } catch (error) { report.errors.push(`${src}: ${error.message}`); log(`Carry-over of ${src} failed: ${error.message}`); }
  }
  for (const directory of [paths.newState, join(paths.newMod, 'runtime')]) await purgeVolatile(fs, directory);
  try { report.bindings = await carryBindings(paths, fs); } catch (error) { report.bindings = 'failed'; report.errors.push(`bindings.json: ${error.message}`); }
  if (report.moved.length || report.replaced.length) log(`Carried over ${report.moved.length} item(s) of the player's state to ${NEW_NAME}${report.replaced.length ? `; ${report.replaced.length} file(s) it replaced are saved under data/legacy-migration/replaced` : ''}.`);
  await writeReport(ctx);
  return {found: true, paths, report};
}

async function writeReport(ctx) {
  const {fs, paths, report} = ctx;
  try {
    await fs.mkdir(paths.newState, {recursive: true});
    await fs.writeFile(join(paths.newState, REPORT_FILE), JSON.stringify(report, null, 2) + '\n');
  } catch { /* the report is for support; the carry-over does not depend on it */ }
}

// What may be removed without a second look, per old folder. Anything else is kept under data/legacy-migration/leftovers.
const KNOWN = {
  oldMod: name => /\.(?:lua|json|txt|log|migrated)$/i.test(name) || name === 'locales' || name === 'db.sqlite3',
  oldPlugin: name => /^(?:CyberpunkConvai\.dll(?:\.migrated)?|launcher\.(?:ini|log)|README\.txt|LICENSE\.txt|app)$/i.test(name) || name === 'voices',
  oldNative: name => /\.(?:dll|dll\.migrated|md|txt|log)$/i.test(name),
};
// Folders that must be empty by now (their content was moved); a file left in one is kept, not deleted.
const MUST_BE_EMPTY = {
  oldMod: ['data', 'runtime'],
  oldPlugin: ['app/local-ai', 'app/omni', 'voices'],
  oldNative: [],
};

export async function cleanupLegacyInstall({adopted, log = () => {}, fs = realFs} = {}) {
  if (!adopted?.found) return {removed: [], pending: []};
  const {paths, report} = adopted;
  const ctx = {fs, paths, report, log, tag: 'leftovers'};
  const removed = [], pending = [];
  for (const key of ['oldMod', 'oldPlugin', 'oldNative']) {
    const folder = paths[key];
    if (!await exists(fs, folder)) continue;
    // A move that failed in the first phase left state in this folder: do not touch the folder; the next start tries the move again.
    if (report.errors.some(error => error.startsWith(folder))) { pending.push(folder); continue; }
    let safe = true;
    const keep = async (src, label) => {
      const dst = join(paths.newState, 'legacy-migration', 'leftovers', key.replace('old', '').toLowerCase(), ...label.split('/'));
      try { await moveEntry(fs, src, dst); report.leftovers.push(label); log(`Kept ${src} as data/legacy-migration/leftovers/${label}.`); }
      catch (error) { safe = false; report.errors.push(`${src}: ${error.message}`); log(`Could not keep ${src}: ${error.message}. The old folder stays.`); }
    };
    for (const relative of MUST_BE_EMPTY[key]) {
      const directory = join(folder, ...relative.split('/'));
      if (!await exists(fs, directory)) continue;
      if (relative === 'data' || relative === 'runtime') await purgeVolatile(fs, directory);
      if ((await listFiles(fs, directory).catch(() => ['?'])).length) await keep(directory, relative);
    }
    for (const entry of await fs.readdir(folder).catch(() => [])) {
      if (!KNOWN[key](entry) && !MUST_BE_EMPTY[key].some(item => item.split('/')[0] === entry)) await keep(join(folder, entry), entry);
    }
    if (!safe) { pending.push(folder); continue; }
    try { await fs.rm(folder, {recursive: true, force: true, maxRetries: 2, retryDelay: 250}); removed.push(folder); log(`Removed the old folder ${folder}.`); }
    catch (error) { pending.push(folder); log(`Could not remove ${folder} yet (${error.code || error.message}); the next start tries again. It cannot run: its init.lua and DLLs are renamed.`); }
  }
  report.pending = pending;
  report.removed = removed;
  await writeReport(ctx);
  return {removed, pending};
}
