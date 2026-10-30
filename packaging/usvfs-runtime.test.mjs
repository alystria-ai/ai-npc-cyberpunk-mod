// The Runtime installed as a Mod Organizer 2 mod: the launcher.ini bootstrap and the start under USVFS
// (node --test packaging/usvfs-runtime.test.mjs).
//
// In a live MO2 test (MO2 2.5.2, usvfs 0.5.6.1, Windows 11 25H2; deliverables/mo2/REPRO.md) the launcher started the bundled Node with
// the Runtime's start-service.mjs and Node ended at once with "Cannot find module ...start-service.mjs": its stat cannot see a file that
// exists only in an MO2 mod folder, although opening it works. Nothing of ours ran, so the game read the launcher's "starting" for good.
// There is no USVFS here. A preload (--require) makes Node behave as it did under USVFS: stat, lstat, exists and the JavaScript realpath
// say ENOENT for the game's virtual folders, realpathSync.native maps them to the MO2 mod folders, and usvfs is among the loaded
// libraries. Real files are on disk at both places, so open and read work, as USVFS makes them work.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {LAUNCHER_BOOTSTRAP, launcherIni, launcherIniLines} from './lib/launcher-ini.mjs';
import {usvfsCompatImport} from '../bridge/bridge-supervisor.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const MOD = 'bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod';
const PLUGIN = 'red4ext/plugins/AiNpcCyberpunkMod';
const LAUNCHER_FILES = ['start-service.mjs', 'prepare-state.mjs', 'assemble-parts.mjs', 'migrate-legacy.mjs', 'place-packs.mjs', 'state-home.mjs', 'usvfs-compat.mjs'];
const put = async (path, text) => { await mkdir(dirname(path), {recursive: true}); await writeFile(path, text); };
const read = path => readFile(path, 'utf8');
const exists = path => stat(path).then(() => true, () => false);

// The preload: Node as it behaved under USVFS. USVFS_SIM = {virtual: [folders], map: [[virtual folder, real folder], ...]}.
const SIMULATION = String.raw`
const fs = require('node:fs'); const path = require('node:path'); const {syncBuiltinESMExports} = require('node:module');
const {fileURLToPath} = require('node:url');
const config = JSON.parse(process.env.USVFS_SIM);
const text = p => path.resolve(p instanceof URL ? fileURLToPath(p) : String(p));
const under = (p, folder) => { const a = text(p).toLowerCase(), b = path.resolve(folder).toLowerCase(); return a === b || a.startsWith(b + path.sep); };
const isVirtual = p => { try { return config.virtual.some(folder => under(p, folder)); } catch { return false; } };
const enoent = p => Object.assign(new Error("ENOENT: no such file or directory, stat '" + p + "'"), {code: 'ENOENT', errno: -4058, syscall: 'stat'});
const o = {statSync: fs.statSync, lstatSync: fs.lstatSync, existsSync: fs.existsSync, stat: fs.stat, lstat: fs.lstat, mkdirSync: fs.mkdirSync,
  realpathSync: fs.realpathSync, native: fs.realpathSync.native, pstat: fs.promises.stat, plstat: fs.promises.lstat, pmkdir: fs.promises.mkdir};
const failSync = name => (p, options) => { if (!isVirtual(p)) return o[name](p, options); if (options && options.throwIfNoEntry === false) return undefined; throw enoent(p); };
const failAsync = name => (p, options, callback) => { if (typeof options === 'function') { callback = options; options = undefined; }
  if (isVirtual(p)) process.nextTick(callback, enoent(p)); else o[name](p, options, callback); };
fs.statSync = failSync('statSync'); fs.lstatSync = failSync('lstatSync');
fs.existsSync = p => isVirtual(p) ? false : o.existsSync(p);
fs.stat = failAsync('stat'); fs.lstat = failAsync('lstat');
fs.promises.stat = async (p, options) => { if (isVirtual(p)) throw enoent(p); return o.pstat(p, options); };
fs.promises.lstat = async (p, options) => { if (isVirtual(p)) throw enoent(p); return o.plstat(p, options); };
// libuv's mkdir -p stats a folder that is already there: under USVFS that says ENOENT.
fs.mkdirSync = (p, options) => { if (isVirtual(p) && options && options.recursive && o.existsSync(text(p))) throw enoent(p); return o.mkdirSync(p, options); };
fs.promises.mkdir = async (p, options) => fs.mkdirSync(p, options);
const native = (p, options) => {
  for (const [from, to] of config.map) if (under(p, from)) { const real = to + text(p).slice(path.resolve(from).length); if (!o.existsSync(real)) throw enoent(p); return o.native(real, options); }
  return o.native(p, options);
};
fs.realpathSync = Object.assign((p, options) => { if (isVirtual(p)) throw enoent(p); return o.realpathSync(p, options); }, {native});
process.report.getReport = () => ({sharedObjects: ['C:\\Windows\\System32\\ntdll.dll', 'C:\\Modding\\MO2\\usvfs_x64.dll']});
syncBuiltinESMExports();
`;

// A game folder whose AI NPC Cyberpunk Mod folders exist only virtually, a Runtime and a Local AI pack each in an MO2 mod folder, and a
// data home of its own. `compat: false` leaves usvfs-compat.mjs out of the Runtime (as in a Runtime from before this fix).
// `overwrite: true` is the other layout (report c44c3c95): the Runtime lives in the game folder and the hooked installer has just written it, so MO2 holds
// every file of it in its Overwrite folder, a place that is no mod of the list: the real files are there and the game's view of them is virtual all the same.
async function mo2Install({compat = true, overwrite = false} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ai npc usvfs runtime Ünï '));
  const game = join(root, 'Games', 'Cyberpunk 2077');
  const mods = join(root, 'Modding', 'MO2', 'mods');
  const runtimeMod = overwrite ? join(root, 'Modding', 'MO2', 'overwrite') : join(mods, 'AI NPC Cyberpunk Mod - Runtime');
  const localAiMod = join(mods, 'AI NPC Cyberpunk Mod - LocalAI Lite');
  const realApp = join(runtimeMod, PLUGIN, 'app');
  await mkdir(join(realApp, 'launcher'), {recursive: true});
  for (const name of LAUNCHER_FILES) if (compat || name !== 'usvfs-compat.mjs') await cp(join(project, 'packaging/runtime', name), join(realApp, 'launcher', name));
  await mkdir(join(realApp, 'bridge'), {recursive: true});
  await cp(join(project, 'bridge/local-ai-pack.mjs'), join(realApp, 'bridge/local-ai-pack.mjs'));
  await put(join(realApp, 'defaults/pocket-voices.autobest.json'), JSON.stringify({version: 1, provider: 'pocket', engine: 'pocket-tts', runtime: {}, voices: {}}));
  await put(join(realApp, 'defaults/characters.json'), '{"v":2}');
  await put(join(realApp, 'defaults/multilingual-profiles.json'), '{"v":2}');
  await put(join(realApp, 'models/lipsync/face-model.json'), '{}');
  await put(join(localAiMod, PLUGIN, 'app/local-ai/manifest.lite.json'), '{}');
  await put(join(game, 'bin/x64/Cyberpunk2077.exe'), 'exe');
  // The Scripts mod's files: on disk here so that open and read work, but stat says ENOENT (the preload), as under USVFS.
  await put(join(game, MOD, 'init.lua'), '-- the CET mod');
  await put(join(game, MOD, 'runtime/bridge-service.json'), '');
  const home = join(root, 'LocalAppData', 'AiNpcCyberpunkMod');
  const virtualPlugin = join(game, PLUGIN);
  const sim = {virtual: [virtualPlugin, join(game, MOD)],
    map: [[join(virtualPlugin, 'app/local-ai'), join(localAiMod, PLUGIN, 'app/local-ai')], [virtualPlugin, join(runtimeMod, PLUGIN)]]};
  const preload = join(root, 'usvfs-like.cjs');
  await writeFile(preload, SIMULATION);
  return {root, game, realApp, localAiMod, home, state: join(home, 'data'), preload, virtualScript: join(virtualPlugin, 'app/launcher/start-service.mjs'),
    env: {...process.env, CYBERPUNK_CONVAI_DATA_HOME: home, USVFS_SIM: JSON.stringify(sim), NODE_OPTIONS: ''},
    cleanup: () => rm(root, {recursive: true, force: true})};
}
// What the launcher runs (launcher.ini), under the preload.
const launch = (f, ...extra) => spawnSync(process.execPath, ['--require', f.preload, '--eval', LAUNCHER_BOOTSTRAP, f.virtualScript, '--game-root', f.game, ...extra],
  {encoding: 'utf8', timeout: 60_000, env: f.env, cwd: f.realApp});

test('launcher.ini: UTF-16 with a byte order mark, Node started through the bootstrap with the script as its first argument', () => {
  const bytes = launcherIni();
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  const text = bytes.subarray(2).toString('utf16le');
  assert.equal(text, launcherIniLines().join('\r\n') + '\r\n');
  const values = Object.fromEntries(launcherIniLines().filter(line => /^\w+=/.test(line)).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  // From launcher 1.1.0 (0.3.4): the Runtime base's Node, the Scripts' install-code.mjs beside the launcher (docs/PACKAGING.md, "Code in the Scripts").
  assert.deepEqual(values, {enabled: '1', program: '%GAME%\\red4ext\\plugins\\AiNpcCyberpunkMod\\app\\node\\node.exe', arg1: '--eval', arg2: LAUNCHER_BOOTSTRAP,
    arg3: '%PLUGIN%\\install-code.mjs', working_directory: '%PLUGIN%'});
  // CyberpunkConvaiLauncher.c reads each value into 1024 characters and refuses one that fills them; GetPrivateProfileString takes
  // quotes around a whole value away; %GAME% and %PLUGIN% are the only expansions.
  for (const [key, value] of Object.entries(values)) {
    assert.ok(value.length < 1023, `${key} is ${value.length} characters`);
    assert.doesNotMatch(value, /^["']|["']$|[\r\n]/, key);
  }
  assert.doesNotMatch(LAUNCHER_BOOTSTRAP, /%/);
});

test('the bootstrap loads a physical install from where it is, with the launcher\'s arguments in process.argv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai npc bootstrap Ünï '));
  try {
    const script = join(root, 'app', 'launcher', 'start-service.mjs');
    await put(script, 'console.log(JSON.stringify({argv: process.argv.slice(1), url: import.meta.url}));');
    const result = spawnSync(process.execPath, ['--eval', LAUNCHER_BOOTSTRAP, script, '--game-pid', '42', '--game-root', 'C:\\Games\\Cyberpunk 2077', '--lifeline', 'stdin'],
      {encoding: 'utf8', timeout: 30_000, cwd: join(root, 'app')});
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {argv: [script, '--game-pid', '42', '--game-root', 'C:\\Games\\Cyberpunk 2077', '--lifeline', 'stdin'],
      url: pathToFileURL(script).href});
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('the bootstrap loads the script from its real place when stat cannot see the virtual one, and keeps the virtual path in argv', async () => {
  const f = await mo2Install();
  try {
    await put(join(f.realApp, 'launcher', 'probe.mjs'), 'console.log(JSON.stringify({argv1: process.argv[1], url: import.meta.url}));');
    const virtualProbe = join(dirname(f.virtualScript), 'probe.mjs');
    const result = spawnSync(process.execPath, ['--require', f.preload, '--eval', LAUNCHER_BOOTSTRAP, virtualProbe], {encoding: 'utf8', timeout: 30_000, env: f.env});
    assert.equal(result.status, 0, result.stderr);
    const seen = JSON.parse(result.stdout);
    assert.equal(seen.argv1, virtualProbe);
    assert.equal(fileURLToPath(seen.url).toLowerCase(), join(f.realApp, 'launcher', 'probe.mjs').toLowerCase());
    const missing = spawnSync(process.execPath, ['--require', f.preload, '--eval', LAUNCHER_BOOTSTRAP, join(dirname(f.virtualScript), 'gone.mjs')],
      {encoding: 'utf8', timeout: 30_000, env: f.env});
    assert.equal(missing.status, 1, 'a script that is nowhere still fails, as before');
    assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/);
  } finally { await f.cleanup(); }
});

test('under USVFS the start puts the stat fallbacks in, runs the Runtime from its MO2 mod folder and finds a pack that is its own MO2 mod', async () => {
  const f = await mo2Install();
  try {
    const result = launch(f, '--prepare-only');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const summary = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.equal(summary.ok, true);
    assert.equal(summary.state, f.state);
    assert.equal(summary.app.toLowerCase(), f.realApp.toLowerCase(), 'Python, llama-server and the bridge get real paths');
    // The Local AI folder stays the virtual one (packs that are separate MO2 mods are merged there; each file is mapped to its real place by the bridge,
    // packaging/mo2-split-packs.test.mjs); the old single real folder hid every other mod's pack.
    assert.equal(summary.packs.localAi.toLowerCase(), join(f.game, PLUGIN, 'app/local-ai').toLowerCase());
    assert.equal(summary.packs.omni.toLowerCase(), join(f.realApp, 'omni').toLowerCase(), 'a pack that is not installed stays under the app');
    // The children import the fallbacks from a copy in the data folder, outside the game folder and the mod folder (report c44c3c95).
    assert.match(summary.childNodeOptions, /^--import=file:\/\/\/.*\/launcher\/usvfs-compat\.mjs$/);
    const url = summary.childNodeOptions.slice('--import='.length);
    assert.equal(fileURLToPath(url).toLowerCase(), join(f.state, 'launcher', 'usvfs-compat.mjs').toLowerCase());
    assert.equal(usvfsCompatImport({CYBERPUNK_CONVAI_USVFS: '1', CYBERPUNK_CONVAI_USVFS_IMPORT: url}), url, 'the supervisor lets exactly this module into the bridge');
    const log = await read(join(f.state, 'bridge-service.log'));
    assert.match(log, /inside a virtual file system \(usvfs\): yes \(stat fallbacks on\)/);
    assert.match(log, /the Runtime is in an MO2 mod folder \(/);
    assert.ok(log.includes(`started as ${resolve(f.virtualScript, '../..')}`), log);
    assert.match(log, /the CET mod's init\.lua is visible; runtime\/ is visible/);
    assert.doesNotMatch(log, /Stopped:/);
    assert.doesNotMatch(log, /locating the Local AI pack files failed/, 'the pack locator ran (it lists a pack\'s files only when they are somewhere else than where they were looked for)');
    assert.doesNotMatch(log, /locating the voice-input packs failed/);
    assert.equal(await exists(join(f.game, PLUGIN)), false, 'nothing is created for the Runtime in the game folder');
  } finally { await f.cleanup(); }
});

// The two MO2 layouts of a Runtime. The child's first import (NODE_OPTIONS --import) is resolved by Node's own loader, whose stat cannot see a file that MO2 holds in a mod
// folder or in Overwrite (ERR_MODULE_NOT_FOUND for launcher/usvfs-compat.mjs, the bridge stopped at once, seven starts in a row). The preload cannot reach that loader, so what is
// proved here is what the fix relies on: the file named in NODE_OPTIONS is a plain file that stat sees, outside every virtual folder, with the module's own bytes.
for (const [name, options] of [['the Runtime and the Scripts as separate mods', {}], ['the Runtime in the game folder, its files in Overwrite', {overwrite: true}]]) {
  test(`under USVFS with ${name} the service's Node processes import the fallbacks from a plain file in the data folder`, async () => {
    const f = await mo2Install(options);
    try {
      const result = launch(f, '--prepare-only');
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const summary = JSON.parse(result.stdout.trim().split('\n').pop());
      const url = summary.childNodeOptions.slice('--import='.length);
      const staged = join(f.state, 'launcher', 'usvfs-compat.mjs');
      assert.equal(fileURLToPath(url).toLowerCase(), staged.toLowerCase());
      assert.equal(usvfsCompatImport({CYBERPUNK_CONVAI_USVFS: '1', CYBERPUNK_CONVAI_USVFS_IMPORT: url}), url, 'the supervisor lets exactly this file into the bridge');
      assert.deepEqual(await readFile(staged), await readFile(join(project, 'packaging/runtime/usvfs-compat.mjs')), "the module's own bytes");
      assert.equal(await exists(join(f.game, PLUGIN, 'app/launcher/usvfs-compat.mjs')), false, 'nothing of the Runtime is created in the game folder');
      // Under the simulation the Runtime's own copy cannot be stat'ed through the game's path (what Node's loader meets), the staged file can.
      const probe = spawnSync(process.execPath, ['--require', f.preload, '-e', `const fs = require('node:fs'); const seen = path => { try { fs.statSync(path); return true; } catch (error) { return error.code; } };
        console.log(JSON.stringify({virtual: seen(process.argv[1]), staged: seen(process.argv[2])}));`, join(f.game, PLUGIN, 'app/launcher/usvfs-compat.mjs'), staged],
        {encoding: 'utf8', timeout: 30_000, env: f.env});
      assert.equal(probe.status, 0, probe.stderr);
      assert.deepEqual(JSON.parse(probe.stdout), {virtual: 'ENOENT', staged: true});
      // A child started the way the supervisor starts the bridge gets the fallbacks before its first line.
      const child = spawnSync(process.execPath, ['--require', f.preload, '-e', "console.log(!!require('node:fs')[Symbol.for('ai-npc-cyberpunk-mod.usvfs-compat')])"],
        {encoding: 'utf8', timeout: 30_000, env: {...f.env, NODE_OPTIONS: summary.childNodeOptions, CYBERPUNK_CONVAI_USVFS: '1'}});
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout.trim(), 'true');
      const log = await read(join(f.state, 'bridge-service.log'));
      assert.match(log, /imported from the data folder, outside the game folder/);
    } finally { await f.cleanup(); }
  });
}

test('without a data folder of its own, or when the copy cannot be made, the children keep the Runtime\'s own file', async () => {
  const f = await mo2Install();
  try {
    // A file where the data folder's launcher/ folder should go: the copy fails, and the start goes on with the Runtime's file.
    await put(join(f.state, 'launcher'), 'a file, not a folder');
    const result = launch(f, '--prepare-only');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const summary = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.match(summary.childNodeOptions, /^--import=file:\/\/\/.*\/app\/launcher\/usvfs-compat\.mjs$/);
    assert.equal(fileURLToPath(summary.childNodeOptions.slice('--import='.length)).toLowerCase(), join(f.realApp, 'launcher', 'usvfs-compat.mjs').toLowerCase());
    assert.match(await read(join(f.state, 'bridge-service.log')), /imported from the Runtime's own launcher folder/);
  } finally { await f.cleanup(); }
});

test('under USVFS the status the game reads is written in place in the virtual runtime/ folder', async () => {
  const f = await mo2Install();
  try {
    // No --prepare-only: the start goes on to the supervisor, which this fake Runtime does not have; the status is written before.
    const result = launch(f);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const status = JSON.parse(await read(join(f.game, MOD, 'runtime/bridge-service.json')));
    assert.equal(status.source, 'service');
    assert.equal(status.state, 'failed');
    assert.equal(status.code, 'install-incomplete', 'the missing supervisor of this fake Runtime, not a folder it could not see');
    assert.equal(status.stage, 'loading-supervisor');
    assert.match(status.view, /^usvfs yes \(stat fallbacks on\); Runtime in an MO2 mod folder; init\.lua visible$/);
  } finally { await f.cleanup(); }
});

test('a Runtime without the fallbacks under USVFS cannot see the CET mod and says so (what a Runtime before this fix would do once started)', async () => {
  const f = await mo2Install({compat: false});
  try {
    const result = launch(f);
    assert.equal(result.status, 3, result.stderr + result.stdout);
    const log = await read(join(f.state, 'bridge-service.log'));
    assert.match(log, /Mod Organizer 2 support could not be loaded/);
    assert.match(log, /Stopped: the CET mod's init\.lua/);
  } finally { await f.cleanup(); }
});

test('a physical install outside MO2 never loads the fallbacks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai npc physical Ünï '));
  try {
    const game = join(root, 'Cyberpunk 2077');
    const app = join(game, PLUGIN, 'app');
    for (const name of LAUNCHER_FILES) await cp(join(project, 'packaging/runtime', name), join(app, 'launcher', name));
    await put(join(app, 'defaults/pocket-voices.autobest.json'), JSON.stringify({version: 1, provider: 'pocket', engine: 'pocket-tts', runtime: {}, voices: {}}));
    await put(join(app, 'defaults/characters.json'), '{"v":2}');
    await put(join(app, 'defaults/multilingual-profiles.json'), '{"v":2}');
    await put(join(app, 'models/lipsync/face-model.json'), '{}');
    await put(join(game, 'bin/x64/Cyberpunk2077.exe'), 'exe');
    await put(join(game, MOD, 'init.lua'), '-- the CET mod');
    const home = join(root, 'LocalAppData', 'AiNpcCyberpunkMod');
    const result = spawnSync(process.execPath, ['--eval', LAUNCHER_BOOTSTRAP, join(app, 'launcher/start-service.mjs'), '--game-root', game, '--prepare-only'],
      {encoding: 'utf8', timeout: 60_000, cwd: app, env: {...process.env, CYBERPUNK_CONVAI_DATA_HOME: home, NODE_OPTIONS: ''}});
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const summary = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.equal(summary.app, app);
    assert.deepEqual(summary.packs, {localAi: join(app, 'local-ai'), omni: join(app, 'omni')});
    assert.equal(summary.childNodeOptions, null);
    const log = await read(join(home, 'data', 'bridge-service.log'));
    assert.match(log, /inside a virtual file system \(usvfs\): no; the Runtime is inside the game folder \(/);
    assert.doesNotMatch(log, /stat fallbacks|started as/);
  } finally { await rm(root, {recursive: true, force: true}); }
});
