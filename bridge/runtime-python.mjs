// Whether the Runtime's Python (app/python, the interpreter of the Pocket voice, V's voice worker and the local speech recognition) has every file
// those workers import. Report 0b8367fd0ebd2f2f (0.3.4, game 2.5): "No module named 'urllib'" from `from pathlib import Path` while Python itself
// started, so the voice stayed silent for good and the Help page said "restart the game", which cannot help: part of app/python\Lib was not on the
// disk (an incomplete extraction, a cleaner or a scanner took it), and the Runtime file check only covers the mod's own code.
//
// Two stages, the same answer shape:
//  files   Only the disk is read (readdir, no process): the folders of the `python3XX._pth` file are searched for every standard library module the
//          workers load and for the site-packages the workers import. A Python that keeps its standard library in `python3XX.zip` (every Runtime before
//          the one that unzips it, docs/PACKAGING.md "Python standard library") is accepted when the zip is there and not empty: its inside is not read.
//  import  The Python itself is asked (`python.exe -I`) to find every one of those modules with importlib, which is the one judge of what its path
//          finds, and its start-up messages are read ("Error processing line 1 of ...distutils-precedence.pth": a site-packages file that names a
//          missing package). One short process, never started by the light run of the setup check.
//
// The list below is what the workers load (the closure of bridge/pocket-voice-worker.py, pocket_voice_runtime.py, local-stt-worker.py and
// resident-voice-worker.py on Python 3.12, measured with sys.modules); modules frozen into python312.dll need no file and are not listed. The packaging
// (packaging/build-release.mjs) refuses to build a Runtime whose Python lacks any of them, and packaging/runtime-python.test.mjs keeps its skip rules away from them.
import {readFile, readdir, stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {join, resolve} from 'node:path';

// Standard library files (relative to Lib/, forward slashes, `.pyc` as the Runtime ships them; a `.py` is accepted as well).
export const STDLIB_FILES = Object.freeze([
  '__future__', '_compat_pickle', '_compression', '_weakrefset', 'argparse', 'ast', 'asyncio/__init__', 'asyncio/base_events', 'asyncio/base_futures',
  'asyncio/base_subprocess', 'asyncio/base_tasks', 'asyncio/constants', 'asyncio/coroutines', 'asyncio/events', 'asyncio/exceptions',
  'asyncio/format_helpers', 'asyncio/futures', 'asyncio/locks', 'asyncio/log', 'asyncio/mixins', 'asyncio/proactor_events', 'asyncio/protocols',
  'asyncio/queues', 'asyncio/runners', 'asyncio/selector_events', 'asyncio/sslproto', 'asyncio/staggered', 'asyncio/streams', 'asyncio/subprocess',
  'asyncio/taskgroups', 'asyncio/tasks', 'asyncio/threads', 'asyncio/timeouts', 'asyncio/transports', 'asyncio/trsock', 'asyncio/windows_events',
  'asyncio/windows_utils', 'base64', 'bdb', 'bisect', 'bz2', 'calendar', 'cmd', 'code', 'codeop', 'collections/__init__', 'collections/abc',
  'concurrent/__init__', 'concurrent/futures/__init__', 'concurrent/futures/_base', 'concurrent/futures/thread', 'contextlib', 'contextvars', 'copy',
  'copyreg', 'csv', 'ctypes/__init__', 'ctypes/_endian', 'ctypes/wintypes', 'dataclasses', 'datetime', 'difflib', 'dis', 'email/__init__',
  'email/_encoded_words', 'email/_parseaddr', 'email/_policybase', 'email/base64mime', 'email/charset', 'email/encoders', 'email/errors',
  'email/feedparser', 'email/header', 'email/iterators', 'email/message', 'email/parser', 'email/quoprimime', 'email/utils', 'encodings/__init__',
  'encodings/aliases', 'encodings/cp1252', 'encodings/utf_8', 'encodings/utf_8_sig', 'enum', 'fnmatch', 'functools', 'gettext', 'glob', 'gzip',
  'hashlib', 'heapq', 'http/__init__', 'http/client', 'importlib/__init__', 'importlib/_abc', 'importlib/_bootstrap', 'importlib/_bootstrap_external',
  'importlib/abc', 'importlib/metadata/__init__', 'importlib/metadata/_adapters', 'importlib/metadata/_collections', 'importlib/metadata/_functools',
  'importlib/metadata/_itertools', 'importlib/metadata/_meta', 'importlib/metadata/_text', 'importlib/resources/__init__', 'importlib/resources/_adapters',
  'importlib/resources/_common', 'importlib/resources/_legacy', 'importlib/resources/abc', 'inspect', 'ipaddress', 'json/__init__', 'json/decoder',
  'json/encoder', 'json/scanner', 'keyword', 'linecache', 'locale', 'logging/__init__', 'lzma', 'multiprocessing/__init__', 'multiprocessing/connection',
  'multiprocessing/context', 'multiprocessing/process', 'multiprocessing/reduction', 'multiprocessing/resource_sharer',
  'multiprocessing/resource_tracker', 'multiprocessing/spawn', 'multiprocessing/util', 'nturl2path', 'numbers', 'opcode', 'operator', 'pathlib', 'pdb',
  'pickle', 'pickletools', 'pkgutil', 'platform', 'pprint', 'queue', 'quopri', 'random', 're/__init__', 're/_casefix', 're/_compiler', 're/_constants',
  're/_parser', 'reprlib', 'selectors', 'shutil', 'signal', 'socket', 'ssl', 'string', 'struct', 'subprocess', 'sysconfig', 'tarfile', 'tempfile',
  'textwrap', 'threading', 'timeit', 'token', 'tokenize', 'traceback', 'types', 'typing', 'unittest/__init__', 'unittest/case', 'unittest/loader',
  'unittest/main', 'unittest/mock', 'unittest/result', 'unittest/runner', 'unittest/signals', 'unittest/suite', 'unittest/util', 'urllib/__init__',
  'urllib/error', 'urllib/parse', 'urllib/request', 'urllib/response', 'uuid', 'warnings', 'wave', 'weakref', 'zipfile/__init__', 'zipfile/_path/__init__',
  'zipfile/_path/glob',
]);

// Packages of Lib/site-packages the workers import (numpy and torch: the Pocket model; yaml and safetensors: its settings and voice files;
// sherpa_onnx: the local speech recognition). A package is there when its __init__.py is.
// The voice clip builder (bridge/voice_clip_build.py, docs/VOICE_EXTRACTION.md) also imports scipy.signal (the resampler of the older clips) and torch.nn.functional
// (the resampler of the newer ones): with the clips no longer shipped (voiceClips.fromGame) a Runtime without them cannot make its characters' voices, so a broken one is reported.
export const SITE_PACKAGES = Object.freeze(['numpy', 'torch', 'torch/nn', 'scipy', 'scipy/signal', 'yaml', 'safetensors', 'sherpa_onnx']);
// site-packages/distutils-precedence.pth (setuptools) imports this at every start; with the package gone Python prints "Error processing line 1".
export const DISTUTILS_PTH = 'distutils-precedence.pth';
export const DISTUTILS_PACKAGE = '_distutils_hack';

/** The modules the file stage looks for, as dotted module names: 'urllib.parse'. */
export const moduleNameOf = path => String(path).replace(/\/__init__$/, '').replace(/\//g, '.');
/** Every module name the import stage asks Python to find (the standard library files, then the site-packages). */
export const REQUIRED_MODULES = Object.freeze([...new Set([...STDLIB_FILES, ...SITE_PACKAGES].map(moduleNameOf))]);

const MIN_ZIP_BYTES = 1024 * 1024;
const MAX_NAMES = 8;
const IMPORT_TIMEOUT_MS = 30_000;

// What `python3XX._pth` names: [{kind: 'dir', path} | {kind: 'zip', path}], in order. `import site` and comments are not paths.
export function pathEntries(pthText, pythonDirectory) {
  const found = [];
  for (const raw of String(pthText ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^import\b/.test(line)) continue;
    if (line.length > 400 || /[\x00-\x1f"<>|?*]/.test(line)) continue;
    const path = resolve(pythonDirectory, line.replace(/\\/g, '/'));
    found.push({kind: /\.zip$/i.test(line) ? 'zip' : 'dir', path});
  }
  return found;
}

const exists = async (path, size = null) => {
  try { const info = await stat(path); return size === null ? true : info.isFile() && info.size >= size; } catch { return false; }
};

// The names in a folder, lower-cased and without the .pyc/.py suffix of a file: a package folder keeps its own name. Never throws.
async function namesIn(folder, cache) {
  const key = folder.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  let names;
  try {
    names = new Set((await readdir(folder, {withFileTypes: true})).map(entry => entry.isDirectory() ? `${entry.name.toLowerCase()}/` : entry.name.toLowerCase().replace(/\.(?:pyc|py)$/, '')));
  } catch { names = null; }
  cache.set(key, names);
  return names;
}

/** Whether `file` ('urllib/parse', no suffix) is in one of the folders `roots`. */
async function findIn(roots, file, cache) {
  const parts = file.split('/');
  const leaf = parts.pop().toLowerCase();
  for (const root of roots) {
    const names = await namesIn(parts.length ? join(root, ...parts) : root, cache);
    if (names && names.has(leaf)) return true;
  }
  return false;
}

/**
 * The file stage. `project` is the Runtime's app/ folder. Returns
 *   {state: 'ok' | 'problem' | 'unknown', code: 'ok' | 'incomplete' | 'no-path-file' | 'absent', layout: 'lib' | 'zip' | null, missing: [module names], missingCount}
 * Never throws. A Runtime with no python.exe (no Python folder at all) is 'unknown': that is the Runtime not being installed, which other checks name.
 */
export async function checkPythonFiles({project} = {}) {
  try {
    if (!project) return {state: 'unknown', code: 'absent', layout: null, missing: [], missingCount: 0};
    const python = join(project, 'python');
    if (!await exists(join(python, 'python.exe'))) return {state: 'unknown', code: 'absent', layout: null, missing: [], missingCount: 0};
    let pthName = null;
    try { pthName = (await readdir(python)).find(name => /^python\d+\._pth$/i.test(name)) ?? null; } catch { pthName = null; }
    if (!pthName) return {state: 'problem', code: 'no-path-file', layout: null, missing: ['python._pth'], missingCount: 1};
    const entries = pathEntries(await readFile(join(python, pthName), 'utf8'), python);
    const roots = entries.filter(entry => entry.kind === 'dir').map(entry => entry.path);
    const zipPresent = (await Promise.all(entries.filter(entry => entry.kind === 'zip').map(entry => exists(entry.path, MIN_ZIP_BYTES)))).some(Boolean);
    const layout = roots.some(root => /[\\/]Lib$/i.test(root)) ? 'lib' : zipPresent ? 'zip' : null;
    const cache = new Map();
    const missing = [];
    // The standard library: from the zip when the Runtime still keeps it there (the inside is not read), else from the Lib folder.
    if (layout !== 'zip') {
      for (const file of STDLIB_FILES) if (!await findIn(roots, file, cache)) missing.push(moduleNameOf(file));
    }
    for (const name of SITE_PACKAGES) {
      // A part of a package (torch/nn) is not named again when the whole package is gone.
      if (name.includes('/') && missing.includes(moduleNameOf(name.split('/')[0]))) continue;
      if (!await findIn(roots, `${name}/__init__`, cache)) missing.push(moduleNameOf(name));
    }
    // A site-packages file that imports a package which is gone (setuptools' distutils-precedence.pth).
    for (const root of roots) {
      if (await exists(join(root, DISTUTILS_PTH)) && !await findIn(roots, `${DISTUTILS_PACKAGE}/__init__`, cache)) { missing.push(DISTUTILS_PACKAGE); break; }
    }
    const unique = [...new Set(missing)];
    return {state: unique.length ? 'problem' : 'ok', code: unique.length ? 'incomplete' : 'ok', layout, missing: unique.slice(0, MAX_NAMES), missingCount: unique.length};
  } catch {
    return {state: 'unknown', code: 'absent', layout: null, missing: [], missingCount: 0};
  }
}

// The program the import stage runs: finds every module (importlib.util.find_spec imports only the parent packages' __init__), prints the missing ones as
// a JSON array on the last line. Python's own start-up messages (site-packages files that fail) arrive on stderr.
const FINDER = 'import importlib.util as u,json,sys\n'
  + 'bad=[]\n'
  + 'for n in json.loads(sys.argv[1]):\n'
  + '    try:\n'
  + '        if u.find_spec(n) is None: bad.append(n)\n'
  + '    except Exception:\n'
  + '        bad.append(n)\n'
  + 'print(json.dumps(bad))\n';

/** What Python printed to stderr before the program ran, reduced to the module names it could not import (never a path). */
export function startupFailures(stderr) {
  const names = [];
  for (const match of String(stderr ?? '').matchAll(/No module named '?([A-Za-z0-9_.]{1,60})'?/g)) names.push(match[1]);
  return [...new Set(names)];
}

/**
 * The import stage: one `python.exe -I -c` that asks importlib for every required module. `run(file, args, options)` is the process runner (a test seam).
 * Returns the same shape as checkPythonFiles, with code 'import-failed' when Python itself could not start or its start-up printed an import error.
 */
export async function checkPythonImports({project, run = execFile} = {}) {
  const python = project ? join(project, 'python', 'python.exe') : null;
  if (!python || !await exists(python)) return {state: 'unknown', code: 'absent', layout: null, missing: [], missingCount: 0};
  const outcome = await new Promise(done => {
    try {
      run(python, ['-I', '-B', '-c', FINDER, JSON.stringify(REQUIRED_MODULES)], {timeout: IMPORT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024,
        env: {PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', PYTHONUTF8: '1'}},
      (error, stdout, stderr) => done({error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '')}));
    } catch (error) { done({error, stdout: '', stderr: ''}); }
  });
  let bad = null;
  try { const parsed = JSON.parse(outcome.stdout.trim().split(/\r?\n/).pop() || 'null'); if (Array.isArray(parsed)) bad = parsed.filter(name => typeof name === 'string').slice(0, 400); } catch { bad = null; }
  const startup = startupFailures(outcome.stderr);
  if (bad === null) {
    // It did not run at all: a start-up import error names the module (`import site` died), a timeout or a refusal names nothing and is not a verdict.
    if (startup.length) return {state: 'problem', code: 'import-failed', layout: null, missing: startup.slice(0, MAX_NAMES), missingCount: startup.length};
    return {state: 'unknown', code: 'absent', layout: null, missing: [], missingCount: 0};
  }
  const missing = [...new Set([...bad, ...startup])];
  return {state: missing.length ? 'problem' : 'ok', code: missing.length ? 'import-failed' : 'ok', layout: null, missing: missing.slice(0, MAX_NAMES), missingCount: missing.length};
}

/** Both stages together for the setup check: the file stage always, the import stage when `import` is true. The worse answer wins; `missing` is joined. */
export async function checkRuntimePython({project, import: withImport = false, run} = {}) {
  const files = await checkPythonFiles({project});
  if (files.state === 'unknown' || !withImport) return files;
  const imports = await checkPythonImports({project, run});
  if (imports.state === 'unknown') return files;
  if (files.state === 'problem' || imports.state === 'problem') {
    const missing = [...new Set([...files.missing, ...imports.missing])];
    return {state: 'problem', code: 'incomplete', layout: files.layout, missing: missing.slice(0, MAX_NAMES), missingCount: Math.max(files.missingCount, imports.missingCount, missing.length)};
  }
  return files;
}
