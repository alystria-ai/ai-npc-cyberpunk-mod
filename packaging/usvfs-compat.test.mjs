// Mod Organizer 2 support: the stat fallbacks of packaging/runtime/usvfs-compat.mjs (node --test packaging/usvfs-compat.test.mjs).
//
// Under USVFS 0.5.6.1 (MO2 2.5.2) on Windows 11 24H2 the bundled Node's stat, lstat, exists and JavaScript realpath say ENOENT for a file
// that exists only in an MO2 mod folder, while open, read, readdir, access and realpathSync.native work (seen in a live MO2 test,
// deliverables/mo2/REPRO.md). These tests build a file system that behaves that way: a "virtual" folder whose stat-family calls fail
// and whose other calls go to a real folder somewhere else, as USVFS redirects them.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {USVFS_IMPORT_VARIABLE, USVFS_VARIABLE, childEnvironment, installUsvfsCompat, locate, pinPythonPaths, usvfsLoaded} from './runtime/usvfs-compat.mjs';

const compatUrl = new URL('./runtime/usvfs-compat.mjs', import.meta.url).href;
const enoent = path => Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), {code: 'ENOENT', path});

// virtualRoot: what the game sees (nothing on disk); realRoot: where the files are. Calls USVFS redirects are mapped; stat-family calls
// on a virtual path fail as they do under USVFS. Returns a module-like object to install the fallbacks on.
function usvfsLike(virtualRoot, realRoot) {
  const isVirtual = path => { const text = resolve(String(path)); return text === virtualRoot || text.startsWith(virtualRoot + sep); };
  const map = path => isVirtual(path) ? realRoot + resolve(String(path)).slice(virtualRoot.length) : path;
  const failSync = name => (path, options) => {
    if (!isVirtual(path)) return fs[name](path, options);
    if (options?.throwIfNoEntry === false) return undefined;
    throw enoent(path);
  };
  const failAsync = name => (path, options, callback) => {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (isVirtual(path)) { process.nextTick(callback, enoent(path)); return; }
    fs[name](path, options, callback);
  };
  const failPromise = name => async (path, options) => { if (isVirtual(path)) throw enoent(path); return fs.promises[name](path, options); };
  const mkdirLike = (path, options) => {
    // libuv's mkdir -p stats a folder that exists: under USVFS that says ENOENT.
    if (isVirtual(path) && options?.recursive) { if (fs.existsSync(map(path))) throw enoent(path); return fs.mkdirSync(map(path), options); }
    return fs.mkdirSync(map(path), options);
  };
  const fake = {
    statSync: failSync('statSync'), lstatSync: failSync('lstatSync'),
    existsSync: path => isVirtual(path) ? false : fs.existsSync(path),
    stat: failAsync('stat'), lstat: failAsync('lstat'),
    exists: (path, callback) => { if (isVirtual(path)) process.nextTick(callback, false); else fs.exists(path, callback); },
    mkdirSync: mkdirLike,
    mkdir: (path, options, callback) => { try { callback(null, mkdirLike(path, options)); } catch (error) { callback(error); } },
    realpathSync: Object.assign((path, options) => { if (isVirtual(path)) throw enoent(path); return fs.realpathSync(path, options); },
      {native: (path, options) => fs.realpathSync.native(map(path), options)}),
    realpath: Object.assign(failAsync('realpath'), {native: (path, options, callback) => fs.realpath.native(map(path), options, callback)}),
    openSync: (path, flags) => fs.openSync(map(path), flags), fstatSync: fs.fstatSync, closeSync: fs.closeSync,
    accessSync: (path, mode) => fs.accessSync(map(path), mode),
    open: (path, flags, callback) => fs.open(map(path), flags, callback), fstat: fs.fstat, close: fs.close,
    readFileSync: (path, options) => fs.readFileSync(map(path), options),
    promises: {
      stat: failPromise('stat'), lstat: failPromise('lstat'),
      mkdir: async (path, options) => mkdirLike(path, options),
      realpath: async (path, options) => { if (isVirtual(path)) throw enoent(path); return fs.promises.realpath(path, options); },
      open: (path, flags) => fs.promises.open(map(path), flags),
    },
  };
  return fake;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ai npc usvfs compat '));
  const virtualRoot = join(root, 'Cyberpunk 2077', 'mods', 'AiNpcCyberpunkMod');
  const realRoot = join(root, 'MO2', 'mods', 'Scripts', 'AiNpcCyberpunkMod');
  fs.mkdirSync(join(realRoot, 'runtime'), {recursive: true});
  fs.writeFileSync(join(realRoot, 'init.lua'), '-- the CET mod (20B)');
  fs.writeFileSync(join(realRoot, 'runtime', 'bridge-service.json'), '');
  fs.mkdirSync(join(root, 'Cyberpunk 2077', 'bin'), {recursive: true});
  fs.writeFileSync(join(root, 'Cyberpunk 2077', 'bin', 'game.exe'), 'exe');
  return {root, virtualRoot, realRoot, fake: usvfsLike(virtualRoot, realRoot), cleanup: () => rm(root, {recursive: true, force: true})};
}

test('the fake file system fails like USVFS before the fallbacks go in', async () => {
  const f = await fixture();
  try {
    const init = join(f.virtualRoot, 'init.lua');
    assert.throws(() => f.fake.statSync(init), {code: 'ENOENT'});
    assert.equal(f.fake.existsSync(init), false);
    assert.throws(() => f.fake.mkdirSync(join(f.virtualRoot, 'runtime'), {recursive: true}), {code: 'ENOENT'});
    assert.equal(f.fake.readFileSync(init, 'utf8'), '-- the CET mod (20B)', 'reading works, as under USVFS');
  } finally { await f.cleanup(); }
});

test('stat, lstat and exists see a file and a folder that exist only in an MO2 mod folder', async () => {
  const f = await fixture();
  try {
    assert.equal(installUsvfsCompat({target: f.fake}), true);
    const init = join(f.virtualRoot, 'init.lua');
    const stats = f.fake.statSync(init);
    assert.equal(stats.isFile(), true);
    assert.equal(stats.size, 20);
    assert.equal(f.fake.lstatSync(init).isFile(), true);
    assert.equal(f.fake.statSync(join(f.virtualRoot, 'runtime')).isDirectory(), true);
    assert.equal(f.fake.statSync(init, {bigint: true}).size, 20n);
    assert.equal(f.fake.existsSync(init), true);
    assert.equal(f.fake.existsSync(join(f.virtualRoot, 'runtime', 'bridge-service.json')), true);
  } finally { await f.cleanup(); }
});

test('a file that is really missing still says ENOENT, and throwIfNoEntry: false still gives undefined', async () => {
  const f = await fixture();
  try {
    installUsvfsCompat({target: f.fake});
    const missing = join(f.virtualRoot, 'runtime', 'no-such-file.json');
    assert.throws(() => f.fake.statSync(missing), {code: 'ENOENT'});
    assert.throws(() => f.fake.lstatSync(missing), {code: 'ENOENT'});
    assert.equal(f.fake.statSync(missing, {throwIfNoEntry: false}), undefined);
    assert.equal(f.fake.statSync(join(f.virtualRoot, 'init.lua'), {throwIfNoEntry: false}).size, 20);
    assert.equal(f.fake.existsSync(missing), false);
    await assert.rejects(f.fake.promises.stat(missing), {code: 'ENOENT'});
    await new Promise(done => f.fake.stat(missing, error => { assert.equal(error?.code, 'ENOENT'); done(); }));
    assert.throws(() => f.fake.realpathSync(missing), {code: 'ENOENT'});
  } finally { await f.cleanup(); }
});

test('the callback and promise forms fall back too', async () => {
  const f = await fixture();
  try {
    installUsvfsCompat({target: f.fake});
    const init = join(f.virtualRoot, 'init.lua');
    assert.equal((await f.fake.promises.stat(init)).size, 20);
    assert.equal((await f.fake.promises.lstat(init)).isFile(), true);
    const viaCallback = await new Promise((done, fail) => f.fake.stat(init, (error, stats) => error ? fail(error) : done(stats)));
    assert.equal(viaCallback.size, 20);
    const viaLstat = await new Promise((done, fail) => f.fake.lstat(init, {}, (error, stats) => error ? fail(error) : done(stats)));
    assert.equal(viaLstat.isFile(), true);
    assert.equal(await new Promise(done => f.fake.exists(init, done)), true);
  } finally { await f.cleanup(); }
});

test('mkdir -p accepts a folder that exists only virtually, and makes new folders under it', async () => {
  const f = await fixture();
  try {
    installUsvfsCompat({target: f.fake});
    const runtime = join(f.virtualRoot, 'runtime');
    assert.equal(f.fake.mkdirSync(runtime, {recursive: true}), undefined, 'the bridge starts with mkdir(runtime, {recursive: true})');
    await f.fake.promises.mkdir(runtime, {recursive: true});
    await new Promise((done, fail) => f.fake.mkdir(runtime, {recursive: true}, error => error ? fail(error) : done()));
    f.fake.mkdirSync(join(runtime, 'reports', 'today'), {recursive: true});
    assert.equal(fs.statSync(join(f.realRoot, 'runtime', 'reports', 'today')).isDirectory(), true);
    assert.throws(() => f.fake.mkdirSync(join(f.root, 'Cyberpunk 2077', 'bin')), {code: 'EEXIST'}, 'a plain mkdir of an existing folder still fails');
  } finally { await f.cleanup(); }
});

test('the JavaScript realpath gives a virtual path itself; realpathSync.native is left alone', async () => {
  const f = await fixture();
  try {
    const native = f.fake.realpathSync.native;
    installUsvfsCompat({target: f.fake});
    const init = join(f.virtualRoot, 'init.lua');
    assert.equal(f.fake.realpathSync(init), resolve(init));
    assert.deepEqual(f.fake.realpathSync(init, {encoding: 'buffer'}), Buffer.from(resolve(init)));
    assert.equal(await f.fake.promises.realpath(init), resolve(init));
    assert.equal(f.fake.realpathSync.native, native);
    assert.equal(f.fake.realpathSync.native(init), fs.realpathSync.native(join(f.realRoot, 'init.lua')));
  } finally { await f.cleanup(); }
});

test('locate tells a physical, a virtual and a missing path apart, also after the fallbacks are in', async () => {
  const f = await fixture();
  try {
    for (const installed of [false, true]) {
      if (installed) installUsvfsCompat({target: f.fake});
      const game = join(f.root, 'Cyberpunk 2077', 'bin', 'game.exe');
      assert.deepEqual(locate(game, f.fake), {kind: 'physical', path: game});
      assert.deepEqual(locate(join(f.virtualRoot, 'runtime'), f.fake), {kind: 'virtual', path: fs.realpathSync.native(join(f.realRoot, 'runtime'))});
      const missing = join(f.virtualRoot, 'local-ai');
      assert.deepEqual(locate(missing, f.fake), {kind: 'missing', path: missing});
    }
  } finally { await f.cleanup(); }
});

test('installing twice changes nothing, and only the given module is touched', async () => {
  const f = await fixture();
  try {
    const realStat = fs.statSync;
    assert.equal(installUsvfsCompat({target: f.fake}), true);
    const patched = f.fake.statSync;
    assert.equal(installUsvfsCompat({target: f.fake}), false);
    assert.equal(f.fake.statSync, patched);
    assert.equal(fs.statSync, realStat, 'node:fs of this process is untouched');
  } finally { await f.cleanup(); }
});

test('usvfs is detected from the loaded libraries', () => {
  assert.equal(usvfsLoaded(() => ({sharedObjects: ['C:\\Windows\\System32\\ntdll.dll', 'C:\\MO2\\usvfs_x64.dll']})), 'yes');
  assert.equal(usvfsLoaded(() => ({sharedObjects: ['C:\\Windows\\System32\\ntdll.dll', 'C:\\x\\notusvfs_x64.dll.bak']})), 'no');
  assert.equal(usvfsLoaded(() => { throw new Error('no report'); }), 'unknown');
  assert.equal(usvfsLoaded(() => ({})), 'unknown');
  assert.equal(usvfsLoaded(), 'no', 'this test process runs outside MO2');
});

test('a child Node process gets the fallbacks before its first line, including the node:fs/promises bindings', () => {
  const env = childEnvironment(compatUrl);
  assert.deepEqual(env, {NODE_OPTIONS: `--import=${compatUrl}`, [USVFS_VARIABLE]: '1', [USVFS_IMPORT_VARIABLE]: compatUrl});
  assert.doesNotMatch(env.NODE_OPTIONS, / /, 'a file URL never holds a space, so NODE_OPTIONS needs no quoting');
  const code = `
    const fs = require('node:fs');
    const originals = fs[Symbol.for('ai-npc-cyberpunk-mod.usvfs-compat.originals')];
    import('node:fs/promises').then(async esm => {
      const missing = await esm.stat(${JSON.stringify(join(tmpdir(), 'no such file ' + process.pid))}).then(() => 'found', error => error.code);
      console.log(JSON.stringify({installed: !!originals, patched: fs.statSync !== originals?.statSync,
        esmPromises: esm.stat === fs.promises.stat, missing, exists: fs.existsSync(process.execPath)}));
    });`;
  const result = spawnSync(process.execPath, ['-e', code], {encoding: 'utf8', timeout: 30_000, env: {...process.env, ...env}});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {installed: true, patched: true, esmPromises: true, missing: 'ENOENT', exists: true});
  const plain = spawnSync(process.execPath, ['--import', compatUrl, '-e', "console.log(!!require('node:fs')[Symbol.for('ai-npc-cyberpunk-mod.usvfs-compat')])"],
    {encoding: 'utf8', timeout: 30_000, env: {...process.env, [USVFS_VARIABLE]: ''}});
  assert.equal(plain.stdout.trim(), 'false', 'importing the module without the variable installs nothing');
});

test('the module file URL works from a folder with spaces and non-ASCII letters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai npc ünï compat '));
  try {
    const copy = join(root, 'usvfs-compat.mjs');
    fs.copyFileSync(new URL(compatUrl), copy);
    const env = childEnvironment(pathToFileURL(copy).href);
    const result = spawnSync(process.execPath, ['-e', "console.log(!!require('node:fs')[Symbol.for('ai-npc-cyberpunk-mod.usvfs-compat')])"],
      {encoding: 'utf8', timeout: 30_000, env: {...process.env, ...env}});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'true');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("Python's ._pth search paths are pinned to its real folder, kept, re-pinned after a move and renewed after an update", async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai npc usvfs python '));
  try {
    const python = join(root, 'MO2', 'mods', 'Runtime', 'app', 'python');
    fs.mkdirSync(python, {recursive: true});
    const pth = join(python, 'python312._pth');
    const packageText = ['python312.zip', '.', 'Lib\\site-packages', '..\\bridge', 'import site', ''].join('\r\n');
    fs.writeFileSync(pth, packageText);
    assert.deepEqual(pinPythonPaths(python), [pth]);
    assert.equal(fs.readFileSync(pth, 'utf8'), [join(python, 'python312.zip'), python, join(python, 'Lib', 'site-packages'),
      join(root, 'MO2', 'mods', 'Runtime', 'app', 'bridge'), 'import site', ''].join('\r\n'));
    assert.equal(fs.readFileSync(`${pth}.package`, 'utf8'), packageText, 'the package text is kept beside it');
    assert.deepEqual(pinPythonPaths(python), [], 'a pinned file is left alone');

    // The MO2 instance moved: the pinned lines point to the old place, the kept package text pins them again.
    const moved = join(root, 'Elsewhere', 'Runtime', 'app', 'python');
    fs.mkdirSync(dirname(moved), {recursive: true});
    fs.renameSync(python, moved);
    assert.deepEqual(pinPythonPaths(moved), [join(moved, 'python312._pth')]);
    assert.ok(fs.readFileSync(join(moved, 'python312._pth'), 'utf8').startsWith(join(moved, 'python312.zip') + '\r\n'));

    // An update put the package's file back with a new line: that is the package text now.
    const updated = packageText.replace('import site', 'extra\r\nimport site');
    fs.writeFileSync(join(moved, 'python312._pth'), updated);
    pinPythonPaths(moved);
    assert.equal(fs.readFileSync(join(moved, 'python312._pth.package'), 'utf8'), updated);
    assert.ok(fs.readFileSync(join(moved, 'python312._pth'), 'utf8').includes(join(moved, 'extra') + '\r\n'));

    assert.deepEqual(pinPythonPaths(join(root, 'no python here')), []);
  } finally { await rm(root, {recursive: true, force: true}); }
});
