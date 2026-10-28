// The first script of the conversation service, from 0.3.4 (docs/PACKAGING.md, "Code in the Scripts"). Shipped in the Scripts as
// red4ext/plugins/AiNpcCyberpunkCode/install-code.mjs, beside the launcher DLL that starts it with the Runtime base's Node:
//   <game>/red4ext/plugins/AiNpcCyberpunkMod/app/node/node.exe --eval <bootstrap> <this file> --game-pid <pid> --game-root <root> --lifeline stdin
//
// The Scripts carry one complete copy of every code file of the mod (bridge, launcher scripts, client bundle, character data) in app/ beside
// this file, listed with sizes and hashes in code.json. The service runs from the Runtime base's app/ folder, where the bundled Python,
// the models, the engine and the voices are, so this script first makes the Runtime's copy of the code equal to the Scripts' copy:
//   - nothing to do (the Runtime's defaults/scripts-code.json lists the same release and every file has its listed size): two reads and one
//     stat per file;
//   - otherwise every listed file whose bytes differ is replaced (temporary file, then a rename over the old one, which keeps an existing file
//     in place under Mod Organizer 2), files the previous copy listed and this one does not are deleted, and the list is written last, so an
//     interrupted copy is finished at the next start.
// Then it runs the Runtime's app/launcher/start-service.mjs (the copy it just installed) in this same process, with process.argv as the
// launcher gave it, except that the script is that start-service.mjs at the place the launcher would have named (the virtual one under
// Mod Organizer 2), so start-service.mjs reads its options and its two places exactly as before.
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
export const RUNTIME_APP = 'red4ext/plugins/AiNpcCyberpunkMod/app';
const MOD_FOLDER = 'bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod';
const RETIRED = ['red4ext/plugins/AiNpcCyberpunkMod/CyberpunkConvai.dll.retired', 'red4ext/plugins/AiNpcCyberpunkModNative/CyberpunkConvaiNative.dll.retired'];
// What start-service.mjs logs for this script (it knows where the log is).
export const NOTES = Symbol.for('ai-npc-cyberpunk-mod.install-code');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const safeRelative = rel => typeof rel === 'string' && rel.length > 0 && rel.length <= 300 && !/[\x00-\x1f\\:*?"<>|]/.test(rel) && !rel.startsWith('/')
  && rel.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/~\d/.test(part));
export const isCodePath = rel => safeRelative(rel) && (CODE_FILES.includes(rel) || CODE_PREFIXES.some(prefix => rel.startsWith(prefix)));

// Size of a file, or null when it is not there. Under Mod Organizer 2 a file that exists only in a mod folder or in Overwrite opens but
// Node's stat says ENOENT (packaging/runtime/usvfs-compat.mjs), so stat falls back to an opened handle.
function sizeOf(path) {
  try { return statSync(path).size; } catch {}
  let handle = null;
  try { handle = openSync(path, 'r'); return fstatSync(handle).size; } catch { return null; } finally { if (handle !== null) closeSync(handle); }
}
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
  const before = new Map((installed?.files ?? []).map(row => [row.path, row.sha256]));
  // The quick check: the same release is installed and every file has its size. Anything else compares the bytes.
  const pending = [];
  for (const row of manifest.files) {
    const target = resolve(runtimeApp, ...row.path.split('/'));
    if (same && before.get(row.path) === row.sha256 && sizeOf(target) === row.size) continue;
    const current = readOptional(target);
    if (current && current.length === row.size && sha256(current) === row.sha256) continue;
    pending.push(row);
  }
  // Files the previous copy listed and this one does not, and code files an older Runtime shipped that no release has any more (code.json "removes").
  const stale = (installed?.files ?? []).filter(row => !listed.has(row.path) && isCodePath(row.path));
  for (const rel of Array.isArray(manifest.removes) ? manifest.removes : []) {
    if (isCodePath(rel) && !listed.has(rel) && !stale.some(row => row.path === rel) && sizeOf(resolve(runtimeApp, ...rel.split('/'))) !== null) stale.push({path: rel});
  }
  if (same && !pending.length && !stale.length) return {state: 'current', copied: 0, removed: 0, aside: [], problems: []};
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
  for (const row of pending) replaceFile(resolve(runtimeApp, ...row.path.split('/')), sources.get(row.path), aside);
  let removed = 0;
  for (const row of stale) {
    try { unlinkSync(resolve(runtimeApp, ...row.path.split('/'))); removed += 1; removeEmptyParents(runtimeApp, row.path); }
    catch (error) { if (error?.code !== 'ENOENT') problems.push(`${row.path}: ${error.code || error.message}`); }
  }
  replaceFile(installedPath, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), aside);
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
      else if (entry.isFile() && /\.(?:old-\d+|code-\d+\.tmp)$/.test(entry.name)) { try { unlinkSync(path); removed.push(entry.name); } catch {} }
    }
  };
  for (const folder of ['vision', 'launcher', 'bridge', 'defaults']) walk(resolve(runtimeApp, folder), 0);
  return removed;
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
  // Under Mod Organizer 2 the stat fallbacks go in before anything else looks at a file (the Scripts' own copy; start-service.mjs then finds
  // them in place). A problem is noted and the copy goes on with the handle fallback of sizeOf.
  try {
    const objects = process.report?.getReport?.()?.sharedObjects;
    if (Array.isArray(objects) && objects.some(path => /(?:^|[\\/])usvfs_x(?:64|86)\.dll$/i.test(String(path)))) {
      (await import(pathToFileURL(resolve(here, 'app/launcher/usvfs-compat.mjs')).href)).installUsvfsCompat();
    }
  } catch (error) { notes.push(`Mod Organizer 2 support could not be loaded before the code copy: ${error?.message || error}`); }

  const virtualApp = resolve(gameRoot, ...RUNTIME_APP.split('/'));
  const runtimeApp = realFolder(virtualApp);
  const manifest = readManifest(resolve(here, 'code.json'));
  if (!manifest) {
    publishFailure(gameRoot, 'install-incomplete', 'the Scripts\' code.json is missing or damaged; install the Scripts again');
    process.exit(1);
  }
  if (!existsSync(resolve(runtimeApp, 'release.json')) && !existsSync(resolve(runtimeApp, 'node'))) {
    publishFailure(gameRoot, 'install-incomplete', 'the Runtime base is not installed; get it from the mod\'s Hugging Face page');
    process.exit(1);
  }
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
    try { writeFileSync(resolve(runtimeApp, 'defaults', 'scripts-code-error.txt'), notes.join('\n') + '\n'); } catch {}
    process.exit(1);
  }
  // start-service.mjs as the launcher of an older Runtime would have named it: the virtual place under Mod Organizer 2, the real file otherwise.
  process.argv[1] = resolve(virtualApp, 'launcher', 'start-service.mjs');
  await import(pathToFileURL(resolve(runtimeApp, 'launcher', 'start-service.mjs')).href);
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) await main();
else if (/install-code\.mjs$/i.test(process.argv[1] ?? '') && realpathSafe(process.argv[1]) === fileURLToPath(import.meta.url).toLowerCase()) await main();

function realpathSafe(path) { try { return realpathSync.native(path).toLowerCase(); } catch { return ''; } }
