// No file in the Scripts zip or in a Runtime base zip is ever written, replaced or deleted by the mod, the launcher, install-code.mjs or the service.
//
// Why: Vortex deploys a package as hardlinks from its staging folder and remembers every file it deployed. At the next deploy it asks, for each of
// them, whether the file in the game folder is still a link to the staged one (hardlink_activator isLink: nlink > 1 and the same inode, called by
// LinkingDeployment.externalChanges). A file that was replaced (written to a temp file and renamed over, as every writer of ours does) or deleted
// raises the "Mod files were changed outside Vortex" dialog; a file that was written in place keeps its inode and does not; a NEW file nobody deployed
// is never looked at, because only the deployment manifest is walked. docs/PACKAGING.md, "Files the game rewrites", has the details. The 0.3.3 Scripts
// shipped about 70 empty runtime/*.json placeholders that the mod rewrote, and a player saw 27 of them in the dialog at every install of any mod.
//
// This test builds the real Scripts lists (game 2.5 and game 2.31) and checks the Runtime base's list against everything our own code writes or
// deletes: the runtime/ exchange lists, launcher.log, install-code's targets, removals, leftovers and error note, GAME_REMOVALS, the launcher's
// retired DLLs, the removal lists and the native plugin's writes. It also runs install-code over the real extracted Scripts and a base, and compares
// every shipped file before and after.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {listZip} from './lib/zip.mjs';
import {loadRuntimeExchange, runtimeWrittenShipped} from './lib/runtime-exchange.mjs';
import {shippedButWritten} from './lib/package-writes.mjs';
import {CODE_APP, CODE_FOLDER, CODE_MANIFEST, INSTALLER, RETIRED_DLLS, RUNTIME_APP, isCodeGamePath} from './lib/code-payload.mjs';
import {requiredRuntimeFiles} from './lib/runtime-required.mjs';
import {ERROR_NOTE, GAME_REMOVALS, INSTALLED_MANIFEST, installCode, readManifest, removeGameFiles, sweepLeftovers} from './runtime/install-code.mjs';
import * as removalRules from './runtime/apply-removals.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(project, 'packaging/release.config.json'), 'utf8'));
const exchange = await loadRuntimeExchange(project);
const declared = (JSON.parse(await readFile(resolve(project, 'packaging/runtime-removals.json'), 'utf8')).removes ?? []);
const layout = config.layout, MOD = layout.modDirectory, PLUGIN = layout.pluginDirectory;
const VERSION = '0.0.1';
const tar = process.platform === 'win32' ? resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const GAMES = ['2.5', '2.31'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const lowered = names => new Set(names.map(name => name.toLowerCase()));

// What a real build adds that this test's build leaves out (it has no compiler): the native plugin and the picture helper.
const REAL_ONLY = [`${CODE_FOLDER}/${layout.nativeDll}`, `${CODE_APP}/vision/CyberpunkConvaiVision.exe`];

let root, fakeLauncher;
const scripts = {}; // game -> {names, dir, manifest}

function build(game, out, cache) {
  const suffix = game === '2.5' ? [] : ['--game', game];
  return spawnSync(process.execPath, [resolve(project, 'packaging/build-release.mjs'), '--version', VERSION, '--dry-run', '--packages', 'scripts', '--worktree',
    '--out', out, '--cache', cache, '--launcher', fakeLauncher, '--no-native', '--no-vision', ...suffix], {cwd: project, encoding: 'utf8', timeout: 180_000, env: {...process.env, GITHUB_ACTIONS: ''}});
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'vortex-no-rewrites-'));
  fakeLauncher = join(root, 'launcher.dll');
  await writeFile(fakeLauncher, 'stand-in launcher');
  for (const game of GAMES) {
    const out = join(root, `out-${game}`);
    const run = build(game, out, join(root, `cache-${game}`));
    assert.equal(run.status, 0, `the ${game} Scripts build failed:\n${run.stderr}${run.stdout}`);
    const zip = join(out, 'packages', `${config.product}-Scripts-${VERSION}${game === '2.5' ? '' : `-for-${game}`}.zip`);
    const dir = join(root, `extracted-${game}`);
    mkdirSync(dir);
    const unpack = spawnSync(tar, ['-xf', zip, '-C', dir], {encoding: 'utf8'});
    assert.equal(unpack.status, 0, unpack.stderr);
    const names = (await listZip(zip)).map(entry => entry.name).filter(name => !name.endsWith('/'));
    scripts[game] = {names, dir, manifest: JSON.parse(await readFile(join(dir, ...CODE_FOLDER.split('/'), CODE_MANIFEST), 'utf8'))};
  }
});
after(async () => { if (root) await rm(root, {recursive: true, force: true}); });

// A Runtime base as 0.3.4 builds it, as far as a test can know without the multi-gigabyte build: the notes, the marker plugin, the release record,
// the removal list, the sign-in settings, the files the features require (V's clips, the OmniVoice lists, the engine, the decoder) and the big trees.
async function baseNames() {
  const required = Object.values(await requiredRuntimeFiles(project)).flat();
  return [...new Set([`${PLUGIN}/README.txt`, `${PLUGIN}/LICENSE.txt`, `${PLUGIN}/CyberpunkConvaiBase.dll`, `${RUNTIME_APP}/release.json`, `${RUNTIME_APP}/licenses/THIRD_PARTY_NOTICES.md`,
    `${RUNTIME_APP}/defaults/runtime-removals.json`, `${RUNTIME_APP}/defaults/steps/base.json`, `${RUNTIME_APP}/node/node.exe`, `${RUNTIME_APP}/python/python.exe`,
    `${RUNTIME_APP}/models/pocket/model.safetensors`, `${RUNTIME_APP}/node_modules/ws/package.json`, ...required])];
}

const problems = list => list.map(item => `${item.name} (${item.why})`);

test('the Scripts zips (game 2.5 and game 2.31) ship nothing our own code writes, replaces or deletes', () => {
  for (const game of GAMES) {
    const {names, manifest} = scripts[game];
    const all = [...names, ...REAL_ONLY];
    assert.deepEqual(problems(shippedButWritten(all, {layout, game, codeRemoves: manifest.removes ?? [], removes: declared})), [], `Scripts for ${game}`);
    // The only runtime/ file is the static note.
    assert.deepEqual(names.filter(name => name.startsWith(`${MOD}/runtime/`)), [`${MOD}/runtime/README.txt`], `Scripts for ${game}`);
  }
});

test('the same paths, crossed by hand with every list a writer works from (not through the shared function)', () => {
  const written = new Set();
  const add = (path, ...suffixes) => { for (const suffix of ['', ...suffixes]) written.add(`${path}${suffix}`.toLowerCase()); };
  // The game and the service: every runtime/ file of every class, its temp file and its backup.
  for (const section of ['exchange', 'state', 'optional', 'elsewhere']) for (const name of exchange[section]) add(`${MOD}/runtime/${name}`, '.tmp', '.previous');
  // The launcher's log (beside its own DLL, which is in the code folder now; an older launcher wrote it beside the plugin) and the status it publishes.
  add(`${CODE_FOLDER}/launcher.log`); add(`${PLUGIN}/launcher.log`); add(`${MOD}/runtime/bridge-service.json`, '.tmp');
  // install-code: its list, its error note, and the folder of the Runtime's code.
  add(`${RUNTIME_APP}/${INSTALLED_MANIFEST}`); add(`${RUNTIME_APP}/${ERROR_NOTE}`);
  // The launcher renames an older Runtime's DLLs, and the removal lists delete.
  for (const path of RETIRED_DLLS) add(path, '.retired');
  for (const path of declared) add(path);
  for (const game of GAMES) {
    for (const path of GAME_REMOVALS[game] ?? []) add(path);
    const {names, manifest} = scripts[game];
    for (const rel of manifest.removes ?? []) add(`${RUNTIME_APP}/${rel}`);
    // Every code file lands in the Runtime's app/ and is replaced or deleted there at a release change.
    for (const row of manifest.files) add(`${RUNTIME_APP}/${row.path}`);
    const overlap = [...names, ...REAL_ONLY].filter(name => written.has(name.toLowerCase()));
    // The runtime/ note and the code.json list of removals are the two allowed hits: README.txt is never written, native-off.txt is not shipped.
    assert.deepEqual(overlap.filter(name => name !== `${MOD}/runtime/README.txt`), [], `Scripts for ${game}`);
  }
});

test('a Runtime base ships none of it either, and the old 0.3.3 base would have failed this test', async () => {
  const base = await baseNames();
  for (const game of GAMES) {
    assert.deepEqual(problems(shippedButWritten(base, {layout, game, removes: declared})), [], `Runtime base for ${game}`);
  }
  // The 0.3.3 base: the launcher and native DLLs, an empty launcher.log, the mod's code under app/, and (game 2.31 only) the driver guard archive.
  const old = [...base, `${PLUGIN}/${layout.pluginDll}`, `${layout.nativeDirectory}/${layout.nativeDll}`, `${PLUGIN}/launcher.log`, `${RUNTIME_APP}/bridge/bridge-service.mjs`,
    `${RUNTIME_APP}/${INSTALLED_MANIFEST}`, `${RUNTIME_APP}/launcher/start-service.mjs`, `${MOD}/runtime/reply.json`, 'archive/pc/mod/cyberpunk_convai_ambient_driver_guard.archive'];
  const flagged = shippedButWritten(old, {layout, game: '2.5', removes: declared}).map(item => item.name);
  for (const name of old.slice(base.length)) assert(flagged.includes(name), `${name} must be flagged`);
  assert(!shippedButWritten(old, {layout, game: '2.31'}).some(item => item.name.endsWith('driver_guard.archive')), 'game 2.31 still ships (and keeps) the guard archive');
  // The builder applies the rule to both packages before it writes them.
  const builder = await readFile(resolve(project, 'packaging/build-release.mjs'), 'utf8');
  assert.match(builder.slice(builder.indexOf('async function scriptsPackage'), builder.indexOf('async function addCodePayload')), /shippedButWritten\(\[\.\.\.pkg\.entries\.keys\(\)\], \{layout: config\.layout, game, codeRemoves: code\.removes/);
  assert.match(builder.slice(builder.indexOf('async function runtimePackage')), /shippedButWritten\(\[\.\.\.pkg\.entries\.keys\(\)\], \{layout: config\.layout, game, removes: declared\}\)/);
  assert.match(builder, /const stray = \[\.\.\.pkg\.entries\.keys\(\)\]\.filter\(name => isCodeGamePath\(name\)\)/, 'the base carries no code path');
});

test('the rule itself: what it flags, and what it leaves alone', () => {
  const ok = [`${MOD}/runtime/README.txt`, `${MOD}/init.lua`, `${CODE_FOLDER}/${INSTALLER}`, `${CODE_FOLDER}/${CODE_MANIFEST}`, `${CODE_FOLDER}/${layout.pluginDll}`, `${CODE_APP}/bridge/a.mjs`,
    `${PLUGIN}/app/node/node.exe`, `${PLUGIN}/app/defaults/convai-auth.json`, `${PLUGIN}/CyberpunkConvaiBase.dll`];
  assert.deepEqual(shippedButWritten(ok, {layout, game: '2.5'}), []);
  const bad = [`${MOD}/runtime/settings.json`, `${CODE_FOLDER}/launcher.log`, `${PLUGIN}/launcher.log`, `${RUNTIME_APP}/bridge/a.mjs`, `${RUNTIME_APP}/${INSTALLED_MANIFEST}`,
    `${RUNTIME_APP}/${ERROR_NOTE}`, `${CODE_APP}/bridge/a.mjs.old-1234`, `${PLUGIN}/app/node/x.code-5.tmp`, ...RETIRED_DLLS, 'archive/pc/mod/cyberpunk_convai_ambient_driver_guard.archive',
    'red4ext/plugins/CyberpunkConvai/CyberpunkConvai.dll', 'bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai/init.lua'];
  assert.deepEqual(shippedButWritten(bad, {layout, game: '2.5'}).map(item => item.name).sort(), bad.sort());
  // A code.json "removes" entry and a removal-list entry that name a shipped file are caught as well.
  assert.deepEqual(shippedButWritten([`${RUNTIME_APP}/bridge/gone.mjs`], {layout, game: '2.5', codeRemoves: ['bridge/gone.mjs']}).length, 2);
  assert.deepEqual(shippedButWritten([`${PLUGIN}/app/models/x.bin`], {layout, game: '2.5', removes: [`${PLUGIN}/app/models/x.bin`]}).map(item => item.name), [`${PLUGIN}/app/models/x.bin`]);
  // runtimeWrittenShipped keeps its own contract (the existing tests lean on it).
  assert.deepEqual(runtimeWrittenShipped([`${MOD}/runtime/README.txt`, `${MOD}/runtime/a.json`], layout), [`${MOD}/runtime/a.json`]);
});

test('the launcher renames only an older Runtime\'s DLLs, writes only launcher.log beside its own DLL and a status file in runtime/', () => {
  const source = readFileSync(resolve(project, 'native/autostart/CyberpunkConvaiLauncher.c'), 'utf8');
  const macro = name => {
    const match = source.match(new RegExp(`#define ${name} L"([^"]+)"`));
    assert(match, name);
    return match[1].replace(/\\\\/g, '/').replace(/^\//, '');
  };
  // The two paths it retires are the old Runtime's, in no 0.3.4 package.
  assert.deepEqual([macro('OLD_LAUNCHER_RELATIVE'), macro('OLD_NATIVE_RELATIVE')].sort(), [...RETIRED_DLLS].sort());
  // retire() is the only rename, and it never touches its own DLL.
  assert.equal(source.split('MoveFileExW').length - 1, 2, 'one rename of an old DLL and one of the status file\'s temp file');
  assert.match(source, /if \(_wcsicmp\(path, own\) == 0 \|\| !file_exists\(path\)\) return RETIRE_NONE;/);
  assert.match(source, /retire\(game, OLD_NATIVE_RELATIVE, own\)/);
  assert.match(source, /retire\(game, OLD_LAUNCHER_RELATIVE, own\)/);
  // The log is created beside the DLL itself (the Scripts' code folder), and nothing else is created with CREATE_ALWAYS but the status temp file.
  assert.match(source, /GetModuleFileNameW\(self, plugin, PATH_CAP\)/);
  assert.match(source, /join\(path, PATH_CAP, plugin, L"\\\\launcher\.log"\)/);
  assert.equal([...source.matchAll(/CREATE_ALWAYS/g)].length, 2, 'launcher.log and the status temp file');
  assert.match(source, /join\(target, PATH_CAP, runtime, L"\\\\bridge-service\.json"\)/);
  // The DLLs it retires are not the ones this release ships.
  for (const game of GAMES) for (const dll of RETIRED_DLLS) assert(!lowered(scripts[game].names).has(dll.toLowerCase()), dll);
});

test('the native plugin writes only inside the mod folder\'s runtime/, through one file', () => {
  const writers = [];
  const walk = folder => {
    for (const entry of readdirSync(folder, {withFileTypes: true})) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:cpp|hpp|c|h)$/.test(entry.name) && /GENERIC_WRITE|MoveFileEx|DeleteFileW|\bfopen\b|ofstream|CopyFileW|_wremove|_wrename/.test(readFileSync(path, 'utf8'))) {
        writers.push(relative(project, path).replace(/\\/g, '/'));
      }
    }
  };
  walk(resolve(project, 'native/core/src'));
  assert.deepEqual(writers.sort(), ['native/core/src/core/FileIo.cpp', 'native/core/src/core/FileIo.hpp', 'native/core/src/systems/core/CoreNatives.cpp']);
  const paths = readFileSync(resolve(project, 'native/core/src/core/Paths.cpp'), 'utf8');
  assert(paths.includes(`${MOD.split('/').pop()}\\\\runtime"`), 'its folder is the mod folder\'s runtime/');
  // Its comment-listed MoveFileExW in CoreNatives.cpp is a comment about the file-replace helper, not a call.
  assert.doesNotMatch(readFileSync(resolve(project, 'native/core/src/systems/core/CoreNatives.cpp'), 'utf8').replace(/\/\/.*$/gm, ''), /GENERIC_WRITE|MoveFileEx|DeleteFileW|\bfopen\b|ofstream/);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// install-code over the real extracted Scripts and a base: every shipped file is byte-, size- and time-identical afterwards.

function snapshot(folder) {
  const files = new Map();
  const walk = current => {
    for (const entry of readdirSync(current, {withFileTypes: true})) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else { const info = statSync(path); files.set(relative(folder, path).replace(/\\/g, '/'), `${info.size}:${Math.trunc(info.mtimeMs)}:${sha(readFileSync(path))}`); }
    }
  };
  walk(folder);
  return files;
}

for (const game of GAMES) {
  test(`install-code over the real Scripts for game ${game} changes none of the Scripts' files and none of the base's`, async t => {
    const {dir, names, manifest} = scripts[game];
    const gameRoot = join(root, `game-${game}`);
    // The Scripts as Vortex would have deployed them, and a base: its files, with their time set well in the past.
    const copy = spawnSync(tar, ['-cf', join(root, `scripts-${game}.tar`), '-C', dir, '.'], {encoding: 'utf8'});
    assert.equal(copy.status, 0, copy.stderr);
    mkdirSync(gameRoot, {recursive: true});
    assert.equal(spawnSync(tar, ['-xf', join(root, `scripts-${game}.tar`), '-C', gameRoot], {encoding: 'utf8'}).status, 0);
    const baseList = await baseNames();
    for (const name of baseList) {
      const target = join(gameRoot, ...name.split('/'));
      mkdirSync(dirname(target), {recursive: true});
      writeFileSync(target, `base file ${name}`);
    }
    // Game 2.5: the 0.3.3 base shipped the 2.31 guard archive; it is the one deletion install-code makes, and no 0.3.4 base has the file.
    const runtimeApp = join(gameRoot, ...RUNTIME_APP.split('/'));
    const shipped = snapshot(gameRoot); // everything either package puts on disk
    const before = new Map([...shipped]);
    const result = installCode({codeApp: join(gameRoot, ...CODE_APP.split('/')), runtimeApp, manifest});
    assert.equal(result.state, 'installed');
    assert.deepEqual(removeGameFiles({game, runtimeApp, rules: removalRules}), {removed: [], failed: [], refused: []}, 'a 0.3.4 base has no guard archive to remove');
    sweepLeftovers({gameRoot, runtimeApp});
    // A second start (the quick path) and a start with a stale list change nothing either.
    assert.equal(installCode({codeApp: join(gameRoot, ...CODE_APP.split('/')), runtimeApp, manifest}).state, 'current');
    const after = snapshot(gameRoot);
    const changed = [...before].filter(([name, stamp]) => after.get(name) !== stamp).map(([name]) => name);
    assert.deepEqual(changed, [], 'a file that either package ships was changed or deleted');
    // What is new: the code copy in the Runtime's app/ (code paths only), its list. Nothing else.
    const added = [...after.keys()].filter(name => !before.has(name));
    assert.deepEqual(added.filter(name => !(isCodeGamePath(name))), [], 'install-code created a file outside the code set');
    assert(added.includes(`${RUNTIME_APP}/${INSTALLED_MANIFEST}`));
    assert.equal(added.length, manifest.files.length + 1);
    // The Scripts' own list is the one it read, and the shipped names are all still there.
    for (const name of names.filter(entry => !entry.endsWith('/'))) assert(after.has(name), `${name} disappeared`);
    assert(readManifest(join(gameRoot, ...CODE_APP.split('/'), '..', CODE_MANIFEST)), 'code.json still reads');
    assert(existsSync(join(runtimeApp, 'release.json')));
    t.diagnostic(`${manifest.files.length} code files copied, ${before.size} shipped files untouched`);
  });
}
