// The first script of the conversation service, from 0.3.4 (docs/PACKAGING.md, "Code in the Scripts"). Shipped in the Scripts as
// red4ext/plugins/AiNpcCyberpunkCode/install-code.mjs, beside the launcher DLL that starts it with the Runtime base's Node:
//   <game>/red4ext/plugins/AiNpcCyberpunkMod/app/node/node.exe --eval <bootstrap> <this file> --game-pid <pid> --game-root <root> --lifeline stdin
//
// The Scripts carry one complete copy of every code file of the mod (bridge, launcher scripts, client bundle, character data) in app/ beside
// this file, listed with sizes and hashes in code.json. The service runs from the Runtime base's app/ folder, where the bundled Python,
// the models, the engine and the voices are, so this script first makes the Runtime's copy of the code equal to the Scripts' copy:
//   - nothing to do (the Runtime's defaults/scripts-code.json lists the same release and every file has its listed size AND the modification
//     time recorded when it was installed): two reads and one stat per file. A file whose time differs is hashed, because a mod manager's
//     "revert" (Vortex) can put an older file of the same size back; a file that hashes right gets its new time recorded, so it is hashed once;
//   - otherwise every listed file whose bytes differ is replaced (temporary file, then a rename over the old one, which keeps an existing file
//     in place under Mod Organizer 2), files the previous copy listed and this one does not are deleted, and the list is written last, so an
//     interrupted copy is finished at the next start.
// Then it runs the Runtime's app/launcher/start-service.mjs (the copy it just installed) in this same process, with process.argv as the
// launcher gave it, except that the script is that start-service.mjs at the place the launcher would have named (the virtual one under
// Mod Organizer 2), so start-service.mjs reads its options and its two places exactly as before.
//
// What this script writes, and nothing else: files of the code set under the Runtime's app/ folder, defaults/scripts-code.json (the list) and
// defaults/scripts-code-error.txt, temporary copies beside a target (LEFTOVER) and the status file runtime/bridge-service.json on a failure. It
// opens the Scripts' own files (code.json, app/, itself) only to read them, so a mod manager that tracks the Scripts never sees them change
// (packaging/vortex-no-rewrites.test.mjs).
//
// Only paths of the code set (CODE_PREFIXES, CODE_FILES; packaging/lib/code-payload.mjs, held equal by packaging/code-payload.test.mjs) are
// ever written or deleted, only under the Runtime's app/ folder. Imports Node's own modules only. A problem ends in a status the game reads
// (runtime/bridge-service.json, state "failed"), never in silence. --prepare-only is passed on to start-service.mjs.
import {createHash} from 'node:crypto';
import {closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync,
  unlinkSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const CODE_PREFIXES = Object.freeze(['bridge/', 'launcher/', 'assets/', 'characters/', 'research/', 'vision/', 'licenses/client/']);
export const CODE_FILES = Object.freeze(['package.json', 'defaults/characters.json', 'defaults/multilingual-profiles.json', 'defaults/runtime-code-files.json']);
export const INSTALLED_MANIFEST = 'defaults/scripts-code.json';
export const ERROR_NOTE = 'defaults/scripts-code-error.txt';
// The leftovers of an interrupted or blocked copy (replaceFile): swept at a later start.
export const LEFTOVER = /\.(?:old-\d+|code-\d+\.tmp)$/;
export const RUNTIME_APP = 'red4ext/plugins/AiNpcCyberpunkMod/app';
const MOD_FOLDER = 'bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod';
const RETIRED = ['red4ext/plugins/AiNpcCyberpunkMod/CyberpunkConvai.dll.retired', 'red4ext/plugins/AiNpcCyberpunkModNative/CyberpunkConvaiNative.dll.retired'];
// What start-service.mjs logs for this script (it knows where the log is).
export const NOTES = Symbol.for('ai-npc-cyberpunk-mod.install-code');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const safeRelative = rel => typeof rel === 'string' && rel.length > 0 && rel.length <= 300 && !/[\x00-\x1f\\:*?"<>|]/.test(rel) && !rel.startsWith('/')
  && rel.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/~\d/.test(part));
export const isCodePath = rel => safeRelative(rel) && (CODE_FILES.includes(rel) || CODE_PREFIXES.some(prefix => rel.startsWith(prefix)));

// Size and modification time (whole milliseconds) of a file, or null when it is not there. Under Mod Organizer 2 a file that exists only in a mod
// folder or in Overwrite opens but Node's stat says ENOENT (packaging/runtime/usvfs-compat.mjs), so stat falls back to an opened handle.
function infoOf(path) {
  const info = stats => ({size: stats.size, mtime: Math.trunc(stats.mtimeMs)});
  try { return info(statSync(path)); } catch {}
  let handle = null;
  try { handle = openSync(path, 'r'); return info(fstatSync(handle)); } catch { return null; } finally { if (handle !== null) closeSync(handle); }
}
const sizeOf = path => infoOf(path)?.size ?? null;
const readOptional = path => { try { return readFileSync(path); } catch { return null; } };
const jsonOf = path => { try { return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')); } catch { return null; } };

// The folder a path really is in: itself when stat sees it, else its real place (Mod Organizer 2: a folder only a mod holds).
function realFolder(path) {
  try { statSync(path); return path; } catch {}
  try { return realpathSync.native(path); } catch { return path; }
}

export function readManifest(path) {
  const value = jsonOf(path);
  if (!value || value.version !== 1 || value.package !== 'scripts-code' || !Array.isArray(value.files)) return null;
  for (const row of value.files) {
    if (!row || !isCodePath(row.path) || !Number.isSafeInteger(row.size) || row.size < 0 || !/^[0-9a-f]{64}$/.test(row.sha256)) return null;
  }
  return value;
}

// Writes `bytes` to `target`: a temporary file renamed over it. A target Windows will not replace (a program still running from it, such as
// the picture helper of a game session that is still closing) is renamed aside first; the copy aside is removed at a later start.
function replaceFile(target, bytes, aside) {
  mkdirSync(dirname(target), {recursive: true});
  const temporary = `${target}.code-${process.pid}.tmp`;
  writeFileSync(temporary, bytes);
  try { renameSync(temporary, target); return; } catch (error) {
    if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) { try { unlinkSync(temporary); } catch {} throw error; }
  }
  const old = `${target}.old-${process.pid}`;
  try { renameSync(target, old); aside.push(old); renameSync(temporary, target); }
  catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
}

function removeEmptyParents(app, rel) {
  const parts = rel.split('/').slice(0, -1);
  while (parts.length) {
    try { rmdirSync(resolve(app, ...parts)); } catch { return; }
    parts.pop();
  }
}

// The list kept in the Runtime: the Scripts' list with the modification time of each file as it was when known to be right.
const listBytes = (manifest, stamps) => Buffer.from(JSON.stringify({...manifest,
  files: manifest.files.map(row => stamps.get(row.path) === undefined ? row : {...row, mtime: stamps.get(row.path)})}, null, 2) + '\n');

/**
 * Makes the Runtime's copy of the code (`runtimeApp`, its app/ folder) equal to the Scripts' (`codeApp`, listed by `manifest`).
 * Returns {state: 'current'|'installed', copied, removed, aside, problems}. Throws when a Scripts file does not match its list (the Scripts
 * are damaged: nothing of it is installed) or a file cannot be written.
 */
export function installCode({codeApp, runtimeApp, manifest, log = () => {}}) {
  const installedPath = resolve(runtimeApp, INSTALLED_MANIFEST);
  const installed = readManifest(installedPath);
  const same = installed && installed.release === manifest.release && installed.commit === manifest.commit && installed.game === manifest.game
    && installed.files.length === manifest.files.length;
  const listed = new Map(manifest.files.map(row => [row.path, row]));
  const before = new Map((installed?.files ?? []).map(row => [row.path, row]));
  // The quick check: the same release is installed and every file has its size and the modification time recorded when it was copied. A mod
  // manager's "revert" (Vortex puts its staged file back, which can be an older file of the same size) changes the time, so that file is hashed
  // and, when it is the wrong one, copied again. Anything else compares the bytes. "stamps": the time of every file known to be right.
  const pending = [], stamps = new Map();
  let restamp = false;
  for (const row of manifest.files) {
    const target = resolve(runtimeApp, ...row.path.split('/'));
    const info = infoOf(target), was = before.get(row.path);
    if (info && same && was?.sha256 === row.sha256 && info.size === row.size && info.mtime === was.mtime) { stamps.set(row.path, info.mtime); continue; }
    const current = info ? readOptional(target) : null;
    if (current && current.length === row.size && sha256(current) === row.sha256) { stamps.set(row.path, info.mtime); restamp = true; continue; }
    pending.push(row);
  }
  // Files the previous copy listed and this one does not, and code files an older Runtime shipped that no release has any more (code.json "removes").
  const stale = (installed?.files ?? []).filter(row => !listed.has(row.path) && isCodePath(row.path));
  for (const rel of Array.isArray(manifest.removes) ? manifest.removes : []) {
    if (isCodePath(rel) && !listed.has(rel) && !stale.some(row => row.path === rel) && sizeOf(resolve(runtimeApp, ...rel.split('/'))) !== null) stale.push({path: rel});
  }
  if (same && !pending.length && !stale.length) {
    // Right bytes, but not the recorded time (a revert that brought the same file back): record the time so the next start is the quick one.
    const aside = [], problems = [];
    if (restamp) {
      try { replaceFile(installedPath, listBytes(manifest, stamps), aside); }
      catch (error) { problems.push(`${INSTALLED_MANIFEST}: ${error?.code || error?.message}`); }
    }
    return {state: 'current', copied: 0, removed: 0, aside, problems};
  }
  // Every Scripts file is read and checked before the first one is written: a damaged Scripts install changes nothing.
  const sources = new Map();
  for (const row of pending) {
    const bytes = readOptional(resolve(codeApp, ...row.path.split('/')));
    if (!bytes || bytes.length !== row.size || sha256(bytes) !== row.sha256) {
      throw Object.assign(Error(`The Scripts' code file ${row.path} is missing or does not match code.json; install the Scripts again.`), {code: 'SCRIPTS_DAMAGED'});
    }
    sources.set(row.path, bytes);
  }
  const aside = [], problems = [];
  for (const row of pending) {
    const target = resolve(runtimeApp, ...row.path.split('/'));
    replaceFile(target, sources.get(row.path), aside);
    stamps.set(row.path, infoOf(target)?.mtime);
  }
  let removed = 0;
  for (const row of stale) {
    try { unlinkSync(resolve(runtimeApp, ...row.path.split('/'))); removed += 1; removeEmptyParents(runtimeApp, row.path); }
    catch (error) { if (error?.code !== 'ENOENT') problems.push(`${row.path}: ${error.code || error.message}`); }
  }
  replaceFile(installedPath, listBytes(manifest, stamps), aside);
  log(`Code ${manifest.release} installed into the Runtime: ${pending.length} file(s) copied, ${removed} removed${installed ? ` (was ${installed.release})` : ' (first install from the Scripts)'}.`);
  return {state: 'installed', copied: pending.length, removed, aside, problems};
}

// Leftovers of earlier starts that could not be deleted then: the copies renamed aside, and an older Runtime's two DLLs the launcher retired
// (loaded by the game in the session they were renamed in, so deletable only later). Never fails.
export function sweepLeftovers({gameRoot, runtimeApp}) {
  const removed = [];
  for (const rel of RETIRED) {
    const path = resolve(gameRoot, ...rel.split('/'));
    try { unlinkSync(path); removed.push(rel); } catch {}
  }
  const walk = (folder, depth) => {
    let entries = [];
    try { entries = readdirSync(folder, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      const path = resolve(folder, entry.name);
      if (entry.isDirectory() && depth < 6) walk(path, depth + 1);
      else if (entry.isFile() && LEFTOVER.test(entry.name)) { try { unlinkSync(path); removed.push(entry.name); } catch {} }
    }
  };
  for (const folder of ['vision', 'launcher', 'bridge', 'defaults']) walk(resolve(runtimeApp, folder), 0);
  return removed;
}

// Files an older Runtime base shipped that must go for one game, removed by the Scripts so no Runtime update is needed (game -> game-relative paths).
// 2.5: the ambient driver guard archive is built from 2.31's quest phase and lays a stale copy over 2.5's own (fix/driver-guard-2.31-only); 2.5 bases
// from 0.3.4 do not ship it, older ones do. Each path goes through the Runtime removal step's own rules (refusalFor in apply-removals.mjs: under a
// folder a Runtime installs into, archive/pc/mod/ only for our file names, never a protected path) and is deleted in the folder the Runtime was
// installed into (installRootOf: the game folder, or the Runtime's own mod folder under Mod Organizer 2).
export const GAME_REMOVALS = Object.freeze({'2.5': Object.freeze(['archive/pc/mod/cyberpunk_convai_ambient_driver_guard.archive'])});

/**
 * Removes the GAME_REMOVALS of `game`. `rules` is {refusalFor, installRootOf} of apply-removals.mjs. Runs early in the start, before the game mounts its
 * archives (the launcher starts this process while RED4ext loads plugins). A file that is gone costs one stat; a file Windows will not delete (the game
 * already holds it) is tried again at the next start. Returns {removed, failed, refused}: one log line is made from it only when something happened.
 */
export function removeGameFiles({game, runtimeApp, rules, unlink = unlinkSync, exists = path => sizeOf(path) !== null}) {
  const result = {removed: [], failed: [], refused: []};
  const root = rules.installRootOf(runtimeApp);
  if (!root) return result;
  for (const rel of GAME_REMOVALS[game] ?? []) {
    const why = rules.refusalFor(rel);
    if (why) { result.refused.push(`${rel} (${why})`); continue; }
    const path = resolve(root, ...rel.split('/'));
    if (!exists(path)) continue;
    try { unlink(path); result.removed.push(rel); } catch (error) { if (error?.code !== 'ENOENT') result.failed.push(`${rel} (${error?.code || error?.message})`); }
  }
  return result;
}

function publishFailure(gameRoot, code, reason) {
  try {
    const runtime = resolve(gameRoot, MOD_FOLDER, 'runtime');
    if (!existsSync(runtime)) return;
    const now = Date.now();
    const gamePid = Number(option('--game-pid')) || null;
    writeFileSync(resolve(runtime, 'bridge-service.json'), JSON.stringify({version: 1, state: 'failed', code, source: 'service', stage: 'installing-code',
      reason: String(reason).slice(0, 140), since: now, updated: now, supervisorPid: process.pid, bridgePid: null, adopted: false, restarts: 0, gamePid}));
  } catch {}
}

const argv = process.argv.slice(2);
function option(name) { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; }

async function main() {
  const gameRoot = option('--game-root');
  if (!gameRoot) { process.stderr.write('Conversation service: --game-root is required.\n'); process.exit(2); }
  const here = dirname(fileURLToPath(import.meta.url));
  const notes = [];
  globalThis[NOTES] = notes;
  // The Runtime's real place is looked up BEFORE the stat fallbacks go in. With them in, stat sees a folder that only an MO2 mod holds, realFolder
  // answers with the virtual path, the code is copied through the virtual file system (every file that is new lands in Overwrite, where Node
  // cannot stat it) and start-service.mjs runs from the virtual path, so its child processes cannot import the files they need
  // (found in the live check of 2026-10-28: "Cannot find module ...launcher/usvfs-compat.mjs").
  const virtualApp = resolve(gameRoot, ...RUNTIME_APP.split('/'));
  const runtimeApp = realFolder(virtualApp);
  // Under Mod Organizer 2 the stat fallbacks go in before anything else looks at a file (the Scripts' own copy; start-service.mjs then finds
  // them in place). A problem is noted and the copy goes on with the handle fallback of sizeOf.
  try {
    const objects = process.report?.getReport?.()?.sharedObjects;
    if (Array.isArray(objects) && objects.some(path => /(?:^|[\\/])usvfs_x(?:64|86)\.dll$/i.test(String(path)))) {
      (await import(pathToFileURL(resolve(here, 'app/launcher/usvfs-compat.mjs')).href)).installUsvfsCompat();
    }
  } catch (error) { notes.push(`Mod Organizer 2 support could not be loaded before the code copy: ${error?.message || error}`); }

  const manifest =readManifest(resolve(here, 'code.json'));
  if (!manifest) {
    publishFailure(gameRoot, 'install-incomplete', 'the Scripts\' code.json is missing or damaged; install the Scripts again');
    process.exit(1);
  }
  if (!existsSync(resolve(runtimeApp, 'release.json')) && !existsSync(resolve(runtimeApp, 'node'))) {
    publishFailure(gameRoot, 'install-incomplete', 'the Runtime base is not installed; extract the full install zip (AI-Companions-LLM, on Nexus Mods and Hugging Face)');
    process.exit(1);
  }
  // First, before the game mounts its archives: the files an older base shipped that this game must not have (GAME_REMOVALS).
  try {
    const rules = await import(pathToFileURL(resolve(here, 'app/launcher/apply-removals.mjs')).href);
    const gone = removeGameFiles({game: manifest.game, runtimeApp, rules});
    if (gone.removed.length) notes.push(`Removed what an older Runtime shipped and game ${manifest.game} must not load: ${gone.removed.join(', ')}.`);
    if (gone.failed.length) notes.push(`Could not remove yet (tried again at the next start): ${gone.failed.join(', ')}.`);
    if (gone.refused.length) notes.push(`Not removed (the removal rules refuse it): ${gone.refused.join(', ')}.`);
  } catch (error) { notes.push(`Removing files for game ${manifest.game} failed: ${error?.message || error}`); }
  try {
    const result = installCode({codeApp: resolve(here, 'app'), runtimeApp, manifest, log: line => notes.push(line)});
    for (const problem of result.problems) notes.push(`Code copy: ${problem}`);
    const swept = sweepLeftovers({gameRoot, runtimeApp});
    if (swept.length) notes.push(`Removed ${swept.length} leftover file(s) of earlier starts (${swept.slice(0, 4).join(', ')}${swept.length > 4 ? ', ...' : ''}).`);
  } catch (error) {
    notes.push(`Installing the code into the Runtime failed: ${error?.stack || error}`);
    publishFailure(gameRoot, 'install-incomplete', error?.code === 'SCRIPTS_DAMAGED' ? 'a Scripts code file is missing or damaged; install the Scripts again'
      : `the code could not be copied into the Runtime (${error?.code || 'error'})`);
    // The notes are lost without the service's log; one line beside the Runtime's code says what happened.
    try { writeFileSync(resolve(runtimeApp, ...ERROR_NOTE.split('/')), notes.join('\n') + '\n'); } catch {}
    process.exit(1);
  }
  // start-service.mjs as the launcher of an older Runtime would have named it: the virtual place under Mod Organizer 2, the real file otherwise.
  process.argv[1] = resolve(virtualApp, 'launcher', 'start-service.mjs');
  await import(pathToFileURL(resolve(runtimeApp, 'launcher', 'start-service.mjs')).href);
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) await main();
else if (/install-code\.mjs$/i.test(process.argv[1] ?? '') && realpathSafe(process.argv[1]) === fileURLToPath(import.meta.url).toLowerCase()) await main();

function realpathSafe(path) { try { return realpathSync.native(path).toLowerCase(); } catch { return ''; } }
