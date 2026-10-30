// Mod Organizer 2 support for the conversation service when the Runtime (or the Scripts) is installed as an MO2 mod. Shipped as
// app/launcher/usvfs-compat.mjs; it imports nothing from the bridge so it can be tested on its own.
//
// MO2 runs the game, and every process the game starts, inside its virtual file system, USVFS. A file that exists only in a mod folder
// (mods\<name>\...) is visible at its place in the game folder because USVFS hooks the Windows calls that open, list and query files. Its
// 0.5.6.1 release (MO2 2.5.2) most likely does not hook the newer "query by name" call that Windows 11 24H2 added (GetFileInformationByName),
// which the bundled Node (24, libuv 1.52) and Python (3.12) try first for stat. What was seen: in an MO2 test, `fs.statSync`, `fs.lstatSync`, `fs.existsSync`
// and the JavaScript `fs.realpathSync` said ENOENT for every file that lives only in a mod folder, while opening, reading, listing,
// `fs.accessSync` and `fs.realpathSync.native` of the same path worked (deliverables/mo2/REPRO.md). Node could not even find the
// service's entry script: "Cannot find module ...start-service.mjs", exit code 1, before any line of ours ran, so the game kept reading
// the launcher's "starting" for good.
//
// A second symptom of that unhooked call (a player's support report; reproduced in an MO2 test): when a path is a real file in the game
// folder AND a copy of it lies in front of it in MO2's view (a mod that holds the same path, or MO2's Overwrite folder, which holds every
// file the game or the service created before the install shipped its placeholders), open, read, write and rename reach the copy in front,
// while stat answers for the real file in the game folder: its size and modification time never change. The bridge's request poll skips
// the read while the stat of runtime/last-input.json equals the one it saw, so no turn V sent was ever read ("The conversation service
// did not get that message"). Only a stat through an opened handle answers for the file the process can open, so stat asks the handle
// first (statWithHandle below); lstat keeps its plain call.
//
// Three parts, used only when usvfs is loaded in the process (a physical install never runs any of this):
//   - locate(path): where a path really is. A virtual path (it opens but stat says ENOENT) maps to its real place with
//     realpathSync.native (GetFinalPathNameByHandle on an opened handle, which USVFS redirects). The service runs its own files (the
//     application, Python, the models) from their real place, so every process it starts (Node, Python, llama-server) sees plain files.
//   - installUsvfsCompat(): stat, lstat, exists, mkdir (recursive) and the JavaScript realpath fall back to calls that USVFS does
//     redirect when the plain call says ENOENT: an opened handle and fstat, access, and the path itself as its real path. The game's side
//     (the CET mod's runtime/ folder, which the game's Lua reads and writes) must stay at its virtual place, because that is where the
//     game, the Scripts mod, the Runtime mod and MO2's Overwrite folder meet. Child Node processes get the same fallbacks through
//     NODE_OPTIONS (childEnvironment), and this module installs itself when it is imported with CYBERPUNK_CONVAI_USVFS=1.
//   - pinPythonPaths(): the bundled Pythons' ._pth search paths made absolute and real (see there), for the same stat call.
// A path that is really missing still says ENOENT (the fallback cannot open it either), at the cost of one more failed open.
import fs from 'node:fs';
import moduleApi, {syncBuiltinESMExports} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const USVFS_VARIABLE = 'CYBERPUNK_CONVAI_USVFS';
const INSTALLED = Symbol.for('ai-npc-cyberpunk-mod.usvfs-compat');
const ORIGINALS = Symbol.for('ai-npc-cyberpunk-mod.usvfs-compat.originals');
const USVFS_LIBRARY = /(?:^|[\\/])usvfs_x(?:64|86)\.dll$/i;

// 'yes' when usvfs is among the process's loaded libraries (the same test bridge/setup-check.mjs makes), 'no', or 'unknown'.
export function usvfsLoaded(report = () => process.report?.getReport?.()) {
  try {
    const objects = report()?.sharedObjects;
    if (Array.isArray(objects)) return objects.some(path => USVFS_LIBRARY.test(String(path))) ? 'yes' : 'no';
  } catch {}
  return 'unknown';
}

const missing = error => error?.code === 'ENOENT';
const recursive = options => typeof options === 'object' && options !== null && options.recursive === true;
const pathText = path => path instanceof URL ? fileURLToPath(path) : Buffer.isBuffer(path) ? path.toString() : String(path);
const originalsOf = base => base[ORIGINALS] ?? base;

// Where a path really is: {kind: 'physical' | 'virtual' | 'missing', path}. Uses the plain stat even after installUsvfsCompat.
export function locate(path, base = fs) {
  const plain = originalsOf(base);
  try { plain.statSync(path); return {kind: 'physical', path}; }
  catch (error) { if (!missing(error)) return {kind: 'physical', path}; }
  try { return {kind: 'virtual', path: plain.realpathSync.native(path)}; }
  catch { return {kind: 'missing', path}; }
}

// The files of a folder that are shadowed: a real file in the game folder whose plain stat disagrees (size or time) with a stat through a
// handle it opens, so MO2 shows another copy in front of it (a mod or Overwrite; see the header). Names only, for the service's log.
export function shadowedFiles(directory, base = fs) {
  const plain = originalsOf(base), names = [];
  let entries;
  try { entries = base.readdirSync(directory); } catch { return names; }
  for (const name of entries) {
    const path = resolve(directory, name);
    let real, seen;
    try { real = plain.statSync(path); if (!real.isFile()) continue; } catch { continue; }
    try { const fd = plain.openSync(path, 'r'); try { seen = plain.fstatSync(fd); } finally { plain.closeSync(fd); } } catch { continue; }
    if (real.size !== seen.size || Math.abs(real.mtimeMs - seen.mtimeMs) > 2) names.push(name);
  }
  return names;
}

// The fallbacks, as functions over a base fs module (tests pass a fake one).
export function compatFunctions(base = fs) {
  const plain = {
    statSync: base.statSync, lstatSync: base.lstatSync, existsSync: base.existsSync, stat: base.stat, lstat: base.lstat,
    exists: base.exists, mkdirSync: base.mkdirSync, mkdir: base.mkdir, realpathSync: base.realpathSync, realpath: base.realpath,
    openSync: base.openSync, fstatSync: base.fstatSync, closeSync: base.closeSync, accessSync: base.accessSync,
    open: base.open, fstat: base.fstat, close: base.close,
    promises: base.promises ? {stat: base.promises.stat, lstat: base.promises.lstat, mkdir: base.promises.mkdir,
      realpath: base.promises.realpath, open: base.promises.open} : null,
  };
  const accessible = path => { try { plain.accessSync(path); return true; } catch { return false; } };
  const statByHandleSync = (path, options) => {
    const fd = plain.openSync(path, 'r');
    try { return plain.fstatSync(fd, options); } finally { try { plain.closeSync(fd); } catch {} }
  };
  const directorySync = path => { try { return statByHandleSync(path).isDirectory(); } catch { return false; } };
  // mkdir -p one folder at a time, accepting folders that exist only virtually.
  const makeTree = path => {
    const target = resolve(pathText(path));
    if (directorySync(target)) return;
    const parent = dirname(target);
    if (parent !== target) makeTree(parent);
    try { plain.mkdirSync(target); }
    catch (error) { if (!(error?.code === 'EEXIST' && directorySync(target))) throw error; }
  };
  const realOf = (path, options) => {
    const text = resolve(pathText(path));
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding === 'buffer' ? Buffer.from(text) : text;
  };

  function statLike(name) {
    return function statSync(path, options) {
      let result;
      try { result = plain[name](path, options); }
      catch (error) {
        if (!missing(error)) throw error;
        try { return statByHandleSync(path, options); }
        catch { if (options?.throwIfNoEntry === false) return undefined; throw error; }
      }
      if (result === undefined && options?.throwIfNoEntry === false) {
        try { return statByHandleSync(path, options); } catch { return undefined; }
      }
      return result;
    };
  }
  function statLikeAsync(name) {
    return function stat(path, options, callback) {
      if (typeof options === 'function') { callback = options; options = undefined; }
      plain[name](path, options, (error, stats) => {
        if (!missing(error)) { callback(error, stats); return; }
        plain.open(path, 'r', (openError, fd) => {
          if (openError) { callback(error); return; }
          plain.fstat(fd, options, (fstatError, handleStats) => plain.close(fd, () => {
            if (fstatError) callback(error); else callback(null, handleStats);
          }));
        });
      });
    };
  }
  function statLikePromise(name) {
    return async function stat(path, options) {
      try { return await plain.promises[name](path, options); }
      catch (error) {
        if (!missing(error)) throw error;
        let handle;
        try { handle = await plain.promises.open(path, 'r'); } catch { throw error; }
        try { return await handle.stat(options); } catch { throw error; } finally { await handle.close().catch(() => {}); }
      }
    };
  }

  // stat answers for the file the process can open (see the header): through a handle first, the plain call for what cannot be opened
  // (a file another process holds exclusively, a path that is not there).
  const plainStatSync = statLike('statSync'), plainStat = statLikeAsync('stat'), plainStatPromise = statLikePromise('stat');
  function statWithHandleSync(path, options) {
    try { return statByHandleSync(path, options); } catch { /* the plain call says what is wrong */ }
    return plainStatSync(path, options);
  }
  function statWithHandle(path, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    plain.open(path, 'r', (openError, fd) => {
      if (openError) { plainStat(path, options, callback); return; }
      plain.fstat(fd, options, (fstatError, handleStats) => plain.close(fd, () => {
        if (fstatError) plainStat(path, options, callback); else callback(null, handleStats);
      }));
    });
  }
  async function statWithHandlePromise(path, options) {
    let handle = null;
    try { handle = await plain.promises.open(path, 'r'); } catch { /* the plain call says what is wrong */ }
    if (handle) {
      try { return await handle.stat(options); } catch { /* the plain call says what is wrong */ } finally { await handle.close().catch(() => {}); }
    }
    return plainStatPromise(path, options);
  }

  const sync = {
    statSync: statWithHandleSync,
    lstatSync: statLike('lstatSync'),
    existsSync(path) { return plain.existsSync(path) || accessible(path); },
    mkdirSync(path, options) {
      try { return plain.mkdirSync(path, options); }
      catch (error) {
        if (!recursive(options) || (error?.code !== 'ENOENT' && error?.code !== 'EEXIST')) throw error;
        try { makeTree(path); } catch { throw error; }
        return undefined;
      }
    },
    realpathSync: Object.assign(function realpathSync(path, options) {
      try { return plain.realpathSync(path, options); }
      catch (error) { if (missing(error) && accessible(path)) return realOf(path, options); throw error; }
    }, {native: plain.realpathSync?.native}),
  };
  const callbacks = {
    stat: statWithHandle,
    lstat: statLikeAsync('lstat'),
    exists(path, callback) { plain.exists(path, found => callback(found || accessible(path))); },
    mkdir(path, options, callback) {
      if (typeof options === 'function') { callback = options; options = undefined; }
      plain.mkdir(path, options, (error, first) => {
        if (!error || !recursive(options) || (error.code !== 'ENOENT' && error.code !== 'EEXIST')) { callback(error, first); return; }
        try { makeTree(path); callback(null); } catch { callback(error); }
      });
    },
    realpath: Object.assign(function realpath(path, options, callback) {
      if (typeof options === 'function') { callback = options; options = undefined; }
      plain.realpath(path, options, (error, resolved) => {
        if (missing(error) && accessible(path)) callback(null, realOf(path, options)); else callback(error, resolved);
      });
    }, {native: plain.realpath?.native}),
  };
  const promises = plain.promises ? {
    stat: statWithHandlePromise,
    lstat: statLikePromise('lstat'),
    async mkdir(path, options) {
      try { return await plain.promises.mkdir(path, options); }
      catch (error) {
        if (!recursive(options) || (error?.code !== 'ENOENT' && error?.code !== 'EEXIST')) throw error;
        try { makeTree(path); } catch { throw error; }
        return undefined;
      }
    },
    async realpath(path, options) {
      try { return await plain.promises.realpath(path, options); }
      catch (error) { if (missing(error) && accessible(path)) return realOf(path, options); throw error; }
    },
  } : null;
  return {plain, sync, callbacks, promises};
}

// Puts the fallbacks in place on node:fs (or a given module object) and updates the ES module bindings of node:fs and node:fs/promises,
// so modules that import {stat} from 'node:fs/promises' see them too. Returns false when they were in place already.
export function installUsvfsCompat({target = fs} = {}) {
  if (target[INSTALLED]) return false;
  const {plain, sync, callbacks, promises} = compatFunctions(target);
  Object.defineProperty(target, ORIGINALS, {value: plain, enumerable: false});
  Object.assign(target, sync, callbacks);
  if (promises && target.promises) Object.assign(target.promises, promises);
  Object.defineProperty(target, INSTALLED, {value: true, enumerable: false});
  if (target === fs) { syncBuiltinESMExports(); installModuleFallback(); }
  return true;
}

// Node's module resolution checks a file with its own internal stat, which the fallbacks above cannot reach. From 0.3.4 the Scripts copy the
// code into the Runtime's app/ at the start (packaging/runtime/install-code.mjs), and under Mod Organizer 2 with the Runtime in the game folder a
// code file that is NEW in a release lands in MO2's Overwrite: it opens and reads, but resolution says ERR_MODULE_NOT_FOUND. This resolve hook
// (module.registerHooks, Node 22.15 and later; the bundled Node is 24) answers such an import with the same file URL when the file can be
// opened, and the default loader then reads it (reading works). Anything else fails as before. Only under usvfs.
export function moduleFallback(specifier, context, nextResolve, open = path => { fs.closeSync(fs.openSync(path, 'r')); }) {
  try { return nextResolve(specifier, context); } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !/^(?:\.{1,2}\/|file:)/.test(specifier) || !context?.parentURL?.startsWith('file:')) throw error;
    const url = new URL(specifier, context.parentURL);
    try { open(fileURLToPath(url)); } catch { throw error; }
    return {url: url.href, shortCircuit: true, ...(/\.mjs$/i.test(url.pathname) ? {format: 'module'} : {})};
  }
}
let moduleHooked = false;
function installModuleFallback() {
  if (moduleHooked) return;
  moduleHooked = true;
  try { if (typeof moduleApi.registerHooks === 'function') moduleApi.registerHooks({resolve: (specifier, context, next) => moduleFallback(specifier, context, next)}); } catch {}
}

// Python under USVFS. USVFS also answers GetModuleFileNameW with the virtual path, so a bundled Python started from its real place still
// takes the virtual folder for its home, joins the relative lines of its python3XX._pth to it and cannot stat its own python3XX.zip
// ("No module named 'encodings'", seen in the MO2 test). Its stat has no fallback (CPython 3.12 uses the same Windows call as Node), so
// the ._pth lines are made absolute, real paths: Python reads the file through the virtual path (open works) and then only meets real
// paths. The package's own text is kept beside it (python3XX._pth.package) so that a moved MO2 instance is pinned again from it, and
// a ._pth that an update put back (relative lines again) is taken as the new package text. Only ever run inside usvfs; a physical install
// keeps the package's file. Returns the files it changed.
const PTH_FILE = /^python\d+\._pth$/i;
const relativeEntry = line => { const text = line.trim(); return text !== '' && !text.startsWith('#') && !/^import\s/.test(text) && !/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(text); };
export function pinPythonPaths(pythonDirectory, base = fs) {
  const changed = [];
  let names;
  try { names = base.readdirSync(pythonDirectory).filter(name => PTH_FILE.test(name)); } catch { return changed; }
  for (const name of names) {
    const file = resolve(pythonDirectory, name), kept = `${file}.package`;
    const current = base.readFileSync(file, 'utf8');
    const lines = current.split(/\r?\n/);
    let source = current;
    if (lines.some(relativeEntry)) { if (readOrNull(base, kept) !== current) base.writeFileSync(kept, current); }
    else source = readOrNull(base, kept) ?? current;
    const pinned = source.split(/\r?\n/).map(line => relativeEntry(line) ? resolve(pythonDirectory, line.trim()) : line).join('\r\n');
    if (pinned !== current) { base.writeFileSync(file, pinned); changed.push(file); }
  }
  return changed;
}
const readOrNull = (base, path) => { try { return base.readFileSync(path, 'utf8'); } catch { return null; } };

// The environment that gives a child Node process the same fallbacks before its first line runs: NODE_OPTIONS loads this module from
// its real place (a file URL never holds a space), and the variable tells it to install itself. The supervisor drops every inherited
// NODE_OPTIONS for the bridge and puts this one back from USVFS_IMPORT_VARIABLE (bridge/bridge-supervisor.mjs, usvfsCompatImport).
export const USVFS_IMPORT_VARIABLE = 'CYBERPUNK_CONVAI_USVFS_IMPORT';
export function childEnvironment(moduleUrl = import.meta.url) {
  return {NODE_OPTIONS: `--import=${moduleUrl}`, [USVFS_VARIABLE]: '1', [USVFS_IMPORT_VARIABLE]: moduleUrl};
}

// The module's own copy outside the game folder (report c44c3c95, install 59e9f1, 0.3.5, 30 Oct 2026). A child's `--import` is resolved by Node's own
// default loader before any fallback exists in the child. A Runtime installed in the game folder under MO2 has just been written by the hooked
// installer, so every file of it lies in MO2's Overwrite and Node 24's stat cannot see any of them: the bridge ended with ERR_MODULE_NOT_FOUND for
// this very file, seven starts in a row. A file in the player's data folder (%LOCALAPPDATA%, which usvfs does not redirect) is a plain file for
// every process, so the first import of a child never depends on a file MO2 may have put in front. The path keeps the `/launcher/usvfs-compat.mjs`
// ending that the supervisor requires (bridge/bridge-supervisor.mjs, usvfsCompatImport; the same pattern). Returns the file URL, or null when the
// copy could not be made, is not the same bytes, or cannot be seen by a plain stat (then the caller keeps the Runtime's own file).
export const CHILD_IMPORT_FILE = /^file:\/\/\/[^\s"']+\/launcher\/usvfs-compat\.mjs$/i;
export function stageChildImport(folder, source = import.meta.url, base = fs) {
  try {
    const target = resolve(folder, 'launcher', 'usvfs-compat.mjs');
    const wanted = base.readFileSync(fileURLToPath(source));
    const same = () => { try { return base.readFileSync(target).equals(wanted); } catch { return false; } };
    if (!same()) {
      base.mkdirSync(dirname(target), {recursive: true});
      const partial = `${target}.${process.pid}.tmp`;
      try { base.writeFileSync(partial, wanted); base.renameSync(partial, target); }
      catch (error) { try { base.rmSync(partial, {force: true}); } catch {} throw error; }
      if (!same()) return null;
    }
    // What the child's default loader will do with it.
    originalsOf(base).statSync(target);
    const url = pathToFileURL(target).href;
    return CHILD_IMPORT_FILE.test(url) ? url : null;
  } catch { return null; }
}

if (process.env[USVFS_VARIABLE] === '1') installUsvfsCompat();
