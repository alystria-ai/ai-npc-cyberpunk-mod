// The mod's code in the Scripts (docs/PACKAGING.md, "Code in the Scripts"): the copy into the Runtime base (packaging/runtime/install-code.mjs),
// the rules shared with the builders (packaging/lib/code-payload.mjs) and the removal step that must never delete that copy.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as payload from './lib/code-payload.mjs';
import * as installer from './runtime/install-code.mjs';
import {isScriptsCode, refusalFor} from './runtime/apply-removals.mjs';
import {checkRemovals} from './lib/runtime-removals.mjs';
import {LAUNCHER_BOOTSTRAP, launcherIniLines} from './lib/launcher-ini.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'code-payload-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const game = join(root, 'Cyberpunk 2077');
  const codeFolder = join(game, ...payload.CODE_FOLDER.split('/'));
  const codeApp = join(codeFolder, 'app'), runtimeApp = join(game, ...payload.RUNTIME_APP.split('/'));
  mkdirSync(codeApp, {recursive: true}); mkdirSync(join(runtimeApp, 'defaults'), {recursive: true});
  return {root, game, codeFolder, codeApp, runtimeApp};
}

// Writes the Scripts' copy of `files` ({rel: text}) and returns its manifest.
function scripts(w, files, {release = '0.3.4', removes = []} = {}) {
  const rows = [];
  for (const [rel, text] of Object.entries(files)) {
    const path = join(w.codeApp, ...rel.split('/'));
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, text);
    rows.push({path: rel, size: Buffer.byteLength(text), sha256: sha(Buffer.from(text))});
  }
  const manifest = {...payload.manifestOf({product: 'AI-NPC-Cyberpunk-Mod', release, game: '2.5', commit: `c-${release}`, runtimeBase: '0.3.3', files: rows}), removes};
  writeFileSync(join(w.codeFolder, payload.CODE_MANIFEST), JSON.stringify(manifest));
  return manifest;
}

test('the installer carries the same code rules as the builders and the removal step', () => {
  assert.deepEqual(installer.CODE_PREFIXES, payload.CODE_PREFIXES);
  assert.deepEqual(installer.CODE_FILES, payload.CODE_FILES);
  assert.equal(installer.INSTALLED_MANIFEST, payload.INSTALLED_MANIFEST);
  assert.equal(installer.RUNTIME_APP, payload.RUNTIME_APP);
  for (const rel of ['bridge/convai-bridge.mjs', 'launcher/start-service.mjs', 'assets/realtime-client.js', 'characters/roster.json', 'research/x/y.json',
    'vision/CyberpunkConvaiVision.exe', 'licenses/client/a/LICENSE', ...payload.CODE_FILES]) {
    assert.equal(payload.isCodePath(rel), true, rel); assert.equal(installer.isCodePath(rel), true, rel);
    assert.equal(isScriptsCode(`${payload.RUNTIME_APP}/${rel}`), true, rel);
    assert.equal(payload.isCodeGamePath(`${payload.RUNTIME_APP}/${rel}`), true, rel);
  }
  // The Runtime base's own files are never code.
  for (const rel of ['node/node.exe', 'python/python.exe', 'models/pocket/x', 'llama-cpp/llama-server.exe', 'release.json', 'defaults/pocket-voices.autobest.json',
    'defaults/convai-auth.json', 'defaults/runtime-removals.json', 'licenses/THIRD-PARTY-NOTICES.txt', 'node_modules/playwright/package.json', '../x', 'bridge/../../x', 'bridge\\x']) {
    assert.equal(payload.isCodePath(rel), false, rel); assert.equal(installer.isCodePath(rel), false, rel);
    // (The removal step refuses '..' and backslashes before it asks whether a path is code.)
    if (payload.safeRelative(rel)) assert.equal(isScriptsCode(`${payload.RUNTIME_APP}/${rel}`), false, rel);
  }
  assert.equal(isScriptsCode(`${payload.RUNTIME_APP}/${payload.INSTALLED_MANIFEST}`), true);
  assert.equal(payload.isCodeGamePath(`${payload.RUNTIME_APP}/${payload.INSTALLED_MANIFEST}`), true);
});

test('a removal list never deletes the code the Scripts install (an older Runtime\'s list, or an update zip that compares a Runtime with code to the base)', () => {
  const code = `${payload.RUNTIME_APP}/bridge/convai-bridge.mjs`, base = `${payload.RUNTIME_APP}/voices-old.wav`;
  assert.equal(refusalFor(code), 'code the Scripts install');
  assert.equal(refusalFor(base), null);
  const {ok, refused} = checkRemovals([code, base, `${payload.RUNTIME_APP}/defaults/scripts-code.json`]);
  assert.deepEqual(ok, [base]);
  assert.deepEqual(refused.map(item => item.why), ['code the Scripts install', 'code the Scripts install']);
});

test('the launcher starts the Runtime base\'s Node on the Scripts\' install-code.mjs', () => {
  const lines = Object.fromEntries(launcherIniLines().filter(line => /^\w+=/.test(line)).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.equal(lines.program, '%GAME%\\red4ext\\plugins\\AiNpcCyberpunkMod\\app\\node\\node.exe');
  assert.equal(lines.arg2, LAUNCHER_BOOTSTRAP);
  assert.equal(lines.arg3, `%PLUGIN%\\${payload.INSTALLER}`);
  assert.equal(payload.CODE_FOLDER, 'red4ext/plugins/AiNpcCyberpunkCode');
  // RED4ext loads plugins in folder order (NTFS: by name): the Scripts' folder must come before both of an older Runtime's folders, so the
  // launcher in it renames their DLLs before RED4ext reaches them.
  const name = payload.CODE_FOLDER.split('/').pop().toUpperCase();
  for (const old of ['AiNpcCyberpunkMod', 'AiNpcCyberpunkModNative']) assert(name < old.toUpperCase(), `${name} sorts before ${old}`);
});

test('the first start copies the code over an older Runtime\'s, the next is two reads and a stat per file, a changed file is copied again', t => {
  const w = world(t);
  // An older Runtime's code, as 0.3.3 shipped it inside app/.
  mkdirSync(join(w.runtimeApp, 'bridge'), {recursive: true});
  writeFileSync(join(w.runtimeApp, 'bridge', 'a.mjs'), 'old a');
  writeFileSync(join(w.runtimeApp, 'bridge', 'retired.mjs'), 'gone in 0.3.4');
  writeFileSync(join(w.runtimeApp, 'bridge', 'unknown.mjs'), 'an old file nobody lists');
  writeFileSync(join(w.runtimeApp, 'release.json'), JSON.stringify({package: 'runtime', version: '0.3.3'}));
  const manifest = scripts(w, {'bridge/a.mjs': 'new a', 'bridge/b.py': 'new b', 'launcher/start-service.mjs': 'start', 'defaults/characters.json': '{}'},
    {removes: ['bridge/retired.mjs']});
  const lines = [];
  const first = installer.installCode({codeApp: w.codeApp, runtimeApp: w.runtimeApp, manifest, log: line => lines.push(line)});
  assert.equal(first.state, 'installed'); assert.equal(first.copied, 4); assert.equal(first.removed, 1);
  assert.equal(readFileSync(join(w.runtimeApp, 'bridge', 'a.mjs'), 'utf8'), 'new a');
  assert.equal(readFileSync(join(w.runtimeApp, 'bridge', 'b.py'), 'utf8'), 'new b');
  assert.equal(existsSync(join(w.runtimeApp, 'bridge', 'retired.mjs')), false, 'a code file no release has any more is deleted');
  assert.equal(readFileSync(join(w.runtimeApp, 'bridge', 'unknown.mjs'), 'utf8'), 'an old file nobody lists', 'nothing unlisted is touched');
  assert.equal(readFileSync(join(w.runtimeApp, 'release.json'), 'utf8').includes('0.3.3'), true, 'the base\'s own files are never written');
  assert.equal(installer.readManifest(join(w.runtimeApp, payload.INSTALLED_MANIFEST)).release, '0.3.4');
  assert.match(lines.join('\n'), /Code 0\.3\.4 installed into the Runtime: 4 file\(s\) copied, 1 removed \(first install from the Scripts\)/);

  assert.equal(installer.installCode({codeApp: w.codeApp, runtimeApp: w.runtimeApp, manifest}).state, 'current');
  // Something put an older file back (an older Runtime zip extracted again): its size differs, so it is copied again.
  writeFileSync(join(w.runtimeApp, 'bridge', 'a.mjs'), 'old a, again');
  const again = installer.installCode({codeApp: w.codeApp, runtimeApp: w.runtimeApp, manifest});
  assert.equal(again.state, 'installed'); assert.equal(again.copied, 1);
  assert.equal(readFileSync(join(w.runtimeApp, 'bridge', 'a.mjs'), 'utf8'), 'new a');
});

test('the next release replaces what changed and deletes what it no longer lists', t => {
  const w = world(t);
  const one = scripts(w, {'bridge/a.mjs': 'a1', 'bridge/sub/old.mjs': 'old', 'assets/x.js': 'x'});
  installer.installCode({codeApp: w.codeApp, runtimeApp: w.runtimeApp, manifest: one});
  rmSync(w.codeApp, {recursive: true, force: true});
  const two = scripts(w, {'bridge/a.mjs': 'a2', 'assets/x.js': 'x'}, {release: '0.3.5'});
  const result = installer.installCode({codeApp: w.codeApp, runtimeApp: w.runtimeApp, manifest: two});
  assert.equal(result.copied, 1); assert.equal(result.removed, 1);
  assert.equal(existsSync(join(w.runtimeApp, 'bridge', 'sub')), false, 'the folder the removal emptied goes too');
  assert.equal(readFileSync(join(w.runtimeApp, 'bridge', 'a.mjs'), 'utf8'), 'a2');
});

test('damaged Scripts change nothing: every source is checked before the first write', t => {
  const w = world(t);
  const manifest = scripts(w, {'bridge/a.mjs': 'a', 'bridge/b.mjs': 'b'});
  writeFileSync(join(w.codeApp, 'bridge', 'b.mjs'), 'tampered');
  assert.throws(() => installer.installCode({codeApp: w.codeApp, runtimeApp: w.runtimeApp, manifest}), error => error.code === 'SCRIPTS_DAMAGED');
  assert.equal(existsSync(join(w.runtimeApp, 'bridge', 'a.mjs')), false);
  assert.equal(existsSync(join(w.runtimeApp, payload.INSTALLED_MANIFEST)), false);
});

test('a manifest that names anything outside the code set is refused', t => {
  const w = world(t);
  scripts(w, {'bridge/a.mjs': 'a'});
  const path = join(w.codeFolder, payload.CODE_MANIFEST);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  value.files.push({path: 'node/node.exe', size: 1, sha256: '0'.repeat(64)});
  writeFileSync(path, JSON.stringify(value));
  assert.equal(installer.readManifest(path), null);
  assert.throws(() => payload.manifestOf({files: [{path: 'python/x.py', size: 1, sha256: '0'.repeat(64)}]}), /Not a code path/);
});

test('leftovers of earlier starts and an older Runtime\'s retired DLLs are swept', t => {
  const w = world(t);
  for (const rel of payload.RETIRED_DLLS) {
    const path = join(w.game, ...`${rel}.retired`.split('/'));
    mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, 'old dll');
  }
  mkdirSync(join(w.runtimeApp, 'vision'), {recursive: true});
  writeFileSync(join(w.runtimeApp, 'vision', 'CyberpunkConvaiVision.exe.old-123'), 'x');
  writeFileSync(join(w.runtimeApp, 'vision', 'CyberpunkConvaiVision.exe'), 'keep');
  const removed = installer.sweepLeftovers({gameRoot: w.game, runtimeApp: w.runtimeApp});
  assert.equal(removed.length, 3);
  assert.equal(existsSync(join(w.runtimeApp, 'vision', 'CyberpunkConvaiVision.exe')), true);
});

test('run as the launcher runs it: the code is installed, then the Runtime\'s start-service.mjs runs in the same process as the launcher would name it', t => {
  const w = world(t);
  const mod = join(w.game, 'bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod');
  mkdirSync(join(mod, 'runtime'), {recursive: true});
  writeFileSync(join(w.runtimeApp, 'release.json'), JSON.stringify({package: 'runtime', version: '0.3.3'}));
  const record = join(w.root, 'started.json');
  scripts(w, {'launcher/start-service.mjs': `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify({argv: process.argv.slice(1), url: import.meta.url}));\n`});
  writeFileSync(join(w.codeFolder, payload.INSTALLER), readFileSync(join(here, 'runtime', 'install-code.mjs')));
  const run = spawnSync(process.execPath, ['--eval', LAUNCHER_BOOTSTRAP, join(w.codeFolder, payload.INSTALLER), '--game-pid', '1', '--game-root', w.game, '--prepare-only'],
    {encoding: 'utf8', cwd: w.codeFolder});
  assert.equal(run.status, 0, run.stderr);
  const started = JSON.parse(readFileSync(record, 'utf8'));
  assert.equal(resolve(started.argv[0]).toLowerCase(), join(w.runtimeApp, 'launcher', 'start-service.mjs').toLowerCase());
  assert.deepEqual(started.argv.slice(1), ['--game-pid', '1', '--game-root', w.game, '--prepare-only']);
  assert.match(decodeURIComponent(started.url).replaceAll('\\', '/').toLowerCase(), /red4ext\/plugins\/ainpccyberpunkmod\/app\/launcher\/start-service\.mjs$/);
});

test('without a Runtime base, or with damaged Scripts, the game reads a failure instead of silence', t => {
  const w = world(t);
  const mod = join(w.game, 'bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod');
  mkdirSync(join(mod, 'runtime'), {recursive: true});
  scripts(w, {'launcher/start-service.mjs': ''});
  writeFileSync(join(w.codeFolder, payload.INSTALLER), readFileSync(join(here, 'runtime', 'install-code.mjs')));
  const run = () => spawnSync(process.execPath, [join(w.codeFolder, payload.INSTALLER), '--game-root', w.game], {encoding: 'utf8'});
  assert.equal(run().status, 1);
  let status = JSON.parse(readFileSync(join(mod, 'runtime', 'bridge-service.json'), 'utf8'));
  assert.equal(status.state, 'failed'); assert.equal(status.code, 'install-incomplete'); assert.match(status.reason, /Runtime base is not installed/);
  writeFileSync(join(w.runtimeApp, 'release.json'), '{}');
  writeFileSync(join(w.codeApp, 'launcher', 'start-service.mjs'), 'tampered');
  assert.equal(run().status, 1);
  status = JSON.parse(readFileSync(join(mod, 'runtime', 'bridge-service.json'), 'utf8'));
  assert.match(status.reason, /Scripts code file is missing or damaged/);
});

test('version order of release strings', () => {
  assert(payload.compareVersions('0.3.3', '0.3.4') < 0);
  assert(payload.compareVersions('0.3.10', '0.3.9') > 0);
  assert.equal(payload.compareVersions('0.3', '0.3.0'), 0);
  assert(payload.compareVersions('2077.1', '0.3.4') > 0);
});

test('Mod Organizer 2: a code file only Overwrite holds still resolves (the resolve fallback of usvfs-compat.mjs)', async () => {
  const {moduleFallback} = await import('./runtime/usvfs-compat.mjs');
  const missing = () => { throw Object.assign(Error('Cannot find module'), {code: 'ERR_MODULE_NOT_FOUND'}); };
  const parentURL = 'file:///C:/Game/red4ext/plugins/AiNpcCyberpunkMod/app/bridge/convai-bridge.mjs';
  const opened = [];
  const found = moduleFallback('./new-module.mjs', {parentURL}, missing, path => opened.push(path));
  assert.deepEqual(found, {url: 'file:///C:/Game/red4ext/plugins/AiNpcCyberpunkMod/app/bridge/new-module.mjs', shortCircuit: true, format: 'module'});
  assert.equal(opened.length, 1);
  // A file that cannot be opened either, a package name, or another error: the original error.
  assert.throws(() => moduleFallback('./gone.mjs', {parentURL}, missing, () => { throw Error('ENOENT'); }), /Cannot find module/);
  assert.throws(() => moduleFallback('playwright', {parentURL}, missing, () => {}), /Cannot find module/);
  assert.throws(() => moduleFallback('./x.mjs', {parentURL}, () => { throw Object.assign(Error('other'), {code: 'ERR_OTHER'}); }, () => {}), /other/);
  assert.deepEqual(moduleFallback('./x.mjs', {parentURL}, () => ({url: 'file:///found'}), () => {}), {url: 'file:///found'});
});

const GUARD = 'archive/pc/mod/cyberpunk_convai_ambient_driver_guard.archive';

test('game 2.5: the 2.31 driver guard archive an older Runtime base shipped is removed through the removal rules, game 2.31 keeps it', async t => {
  const rules = await import('./runtime/apply-removals.mjs');
  assert.deepEqual(installer.GAME_REMOVALS['2.5'], [GUARD]);
  assert.equal(installer.GAME_REMOVALS['2.31'], undefined);
  for (const rel of installer.GAME_REMOVALS['2.5']) assert.equal(rules.refusalFor(rel), null, rel);
  const w = world(t);
  const guard = join(w.game, ...GUARD.split('/'));
  mkdirSync(dirname(guard), {recursive: true});
  writeFileSync(guard, 'guard');
  assert.deepEqual(installer.removeGameFiles({game: '2.31', runtimeApp: w.runtimeApp, rules}), {removed: [], failed: [], refused: []});
  assert.ok(existsSync(guard));
  assert.deepEqual(installer.removeGameFiles({game: '2.5', runtimeApp: w.runtimeApp, rules}).removed, [GUARD]);
  assert.ok(!existsSync(guard));
  assert.deepEqual(installer.removeGameFiles({game: '2.5', runtimeApp: w.runtimeApp, rules}), {removed: [], failed: [], refused: []});
  // Mod Organizer 2: the Runtime's real app/ sits in its own mod folder; the file is deleted there, never in the game folder.
  const mo2 = join(w.root, 'mods', 'AI NPC Runtime'), mo2App = join(mo2, ...payload.RUNTIME_APP.split('/'));
  const inMod = join(mo2, ...GUARD.split('/')), inGame = guard;
  mkdirSync(dirname(inMod), {recursive: true}); mkdirSync(mo2App, {recursive: true});
  writeFileSync(inMod, 'guard'); writeFileSync(inGame, 'someone else\'s copy');
  assert.deepEqual(installer.removeGameFiles({game: '2.5', runtimeApp: mo2App, rules}).removed, [GUARD]);
  assert.ok(!existsSync(inMod)); assert.ok(existsSync(inGame));
  // An app/ folder that is not the Runtime's deletes nothing.
  assert.deepEqual(installer.removeGameFiles({game: '2.5', runtimeApp: join(w.root, 'elsewhere', 'app'), rules}).removed, []);
});

test('the game-file removal refuses what the removal rules refuse, and a file Windows holds is tried again at the next start', t => {
  const w = world(t);
  const guard = join(w.game, ...GUARD.split('/'));
  mkdirSync(dirname(guard), {recursive: true});
  writeFileSync(guard, 'guard');
  const refuse = {installRootOf: () => w.game, refusalFor: () => 'not ours'};
  assert.deepEqual(installer.removeGameFiles({game: '2.5', runtimeApp: w.runtimeApp, rules: refuse}).refused, [`${GUARD} (not ours)`]);
  assert.ok(existsSync(guard));
  const rules = {installRootOf: () => w.game, refusalFor};
  const busy = () => { throw Object.assign(Error('busy'), {code: 'EBUSY'}); };
  assert.deepEqual(installer.removeGameFiles({game: '2.5', runtimeApp: w.runtimeApp, rules, unlink: busy}).failed, [`${GUARD} (EBUSY)`]);
  assert.ok(existsSync(guard));
  assert.deepEqual(installer.removeGameFiles({game: '2.5', runtimeApp: w.runtimeApp, rules}).removed, [GUARD]);
});

test('run as the launcher runs it on game 2.5: the guard archive is removed before the code copy and logged once', t => {
  const w = world(t);
  mkdirSync(join(w.game, 'bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod/runtime'), {recursive: true});
  writeFileSync(join(w.runtimeApp, 'release.json'), JSON.stringify({package: 'runtime', version: '0.3.3'}));
  const guard = join(w.game, ...GUARD.split('/'));
  mkdirSync(dirname(guard), {recursive: true});
  writeFileSync(guard, 'guard');
  const record = join(w.root, 'notes.json');
  scripts(w, {
    'launcher/apply-removals.mjs': readFileSync(join(here, 'runtime', 'apply-removals.mjs'), 'utf8'),
    'launcher/start-service.mjs': `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify(globalThis[Symbol.for('ai-npc-cyberpunk-mod.install-code')]));\n`,
  });
  writeFileSync(join(w.codeFolder, payload.INSTALLER), readFileSync(join(here, 'runtime', 'install-code.mjs')));
  const run = () => spawnSync(process.execPath, [join(w.codeFolder, payload.INSTALLER), '--game-root', w.game, '--prepare-only'], {encoding: 'utf8'});
  assert.equal(run().status, 0);
  assert.ok(!existsSync(guard));
  const first = JSON.parse(readFileSync(record, 'utf8')).filter(line => /driver_guard/.test(line));
  assert.equal(first.length, 1); assert.match(first[0], /^Removed what an older Runtime shipped and game 2\.5 must not load/);
  assert.equal(run().status, 0);
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')).filter(line => /driver_guard|Removing files/.test(line)), []);
});

// A mod manager's "revert" (Vortex: "Revert change (use staging file)") puts its staged file back over the copy install-code made. That file can be an
// older release's file of the very same size, so the quick check also compares the modification time recorded at the copy.
test('a file a mod manager reverted to older bytes of the same size is noticed, a touched but right file is only re-stamped', t => {
  const w = world(t);
  const manifest = scripts(w, {'bridge/a.mjs': 'new a', 'bridge/b.mjs': 'new b', 'launcher/start-service.mjs': 'start'});
  assert.equal(installer.installCode({codeApp: w.codeApp, runtimeApp: w.runtimeApp, manifest}).state, 'installed');
  const listPath = join(w.runtimeApp, payload.INSTALLED_MANIFEST);
  const recorded = () => JSON.parse(readFileSync(listPath, 'utf8')).files;
  assert(recorded().every(row => Number.isSafeInteger(row.mtime)), 'the list records when each file was copied');
  const a = join(w.runtimeApp, 'bridge', 'a.mjs'), b = join(w.runtimeApp, 'bridge', 'b.mjs');
  const stamp = path => Math.trunc(statSync(path).mtimeMs);

  // Reverted: old bytes, the same size (5 characters), a different time.
  writeFileSync(a, 'old a');
  utimesSync(a, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
  const reverted = installer.installCode({codeApp: w.codeApp, runtimeApp: w.runtimeApp, manifest});
  assert.equal(reverted.state, 'installed'); assert.equal(reverted.copied, 1);
  assert.equal(readFileSync(a, 'utf8'), 'new a');
  assert.equal(recorded().find(row => row.path === 'bridge/a.mjs').mtime, stamp(a));

  // Touched (a mod manager moved the right file back, or a backup tool restored it): the bytes are right, nothing is copied, the new time is recorded.
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(b, old, old);
  const touched = installer.installCode({codeApp: w.codeApp, runtimeApp: w.runtimeApp, manifest});
  assert.equal(touched.state, 'current'); assert.equal(touched.copied, 0);
  assert.equal(recorded().find(row => row.path === 'bridge/b.mjs').mtime, stamp(b), 'the list follows the file');

  // Untouched: the quick path reads no file (a file whose bytes change under an unchanged size and time is what a hash per start would catch, and this does not look).
  const listBefore = readFileSync(listPath, 'utf8');
  assert.equal(installer.installCode({codeApp: w.codeApp, runtimeApp: w.runtimeApp, manifest}).state, 'current');
  assert.equal(readFileSync(listPath, 'utf8'), listBefore, 'the quick path writes nothing');
  // An older list without times (installed before times were recorded) is hashed once, then follows.
  writeFileSync(listPath, JSON.stringify({...manifest}));
  assert.equal(installer.installCode({codeApp: w.codeApp, runtimeApp: w.runtimeApp, manifest}).state, 'current');
  assert(recorded().every(row => Number.isSafeInteger(row.mtime)));
});

// 0.4.0 reports (installs 7c14a1, b391fe, f0a37a): code files that older Runtime bases shipped and no Scripts ever listed stayed in app/bridge, so the code check
// of every report said "modified" with extra files. The declared removal list (packaging/runtime-removals.json) names them, the builder turns the code paths of it
// into code.json "removes", and install-code.mjs deletes them next to the files the previous copy listed.
test('the declared removals name the retired bridge files, none of them is in the code the Scripts ship, and the installer deletes them from an old Runtime', async t => {
  const {DECLARED_REMOVALS} = await import('./lib/runtime-removals.mjs');
  const {importClosure} = await import('./lib/closure.mjs');
  const project = resolve(here, '..');
  const declared = JSON.parse(readFileSync(resolve(project, DECLARED_REMOVALS), 'utf8')).removes;
  const leftovers = ['omni-server.mjs', 'omni-server-main.mjs', 'gemini-voice.mjs', 'eddies-payment.mjs', 'key-codec.mjs', 'local-stt-worker.check.py', 'npc-awareness.mjs',
    'omni-fake-worker.cjs', 'pcm-relay.mjs', 'realtime-client.mjs', 'rovoice-autostart.mjs'];
  const named = declared.filter(path => payload.isCodeGamePath(path)).map(path => path.slice(payload.RUNTIME_APP.length + 1));
  for (const name of leftovers) assert.ok(named.includes(`bridge/${name}`), `${name} is declared`);
  // The builder drops a declared path the release ships (build-release.mjs filters on the payload), but a list that names a shipped file is a mistake to catch here.
  const config = JSON.parse(readFileSync(resolve(project, 'packaging/release.config.json'), 'utf8'));
  const shipped = new Set([...await importClosure(project, config.bridgeEntries), ...config.bridgeWorkers]);
  for (const rel of named) assert.ok(!shipped.has(rel), `${rel} is declared as removed but the Scripts ship it`);
  // An old Runtime base that still holds them: the first code install of a release that declares them removes exactly those and nothing unlisted.
  const w = world(t);
  mkdirSync(join(w.runtimeApp, 'bridge'), {recursive: true});
  for (const name of leftovers) writeFileSync(join(w.runtimeApp, 'bridge', name), 'old');
  writeFileSync(join(w.runtimeApp, 'bridge', 'player-note.mjs'), 'not ours to delete');
  const manifest = scripts(w, {'bridge/a.mjs': 'a'}, {removes: named});
  const result = installer.installCode({codeApp: w.codeApp, runtimeApp: w.runtimeApp, manifest});
  assert.equal(result.removed, leftovers.length);
  for (const name of leftovers) assert.equal(existsSync(join(w.runtimeApp, 'bridge', name)), false, name);
  assert.equal(readFileSync(join(w.runtimeApp, 'bridge', 'player-note.mjs'), 'utf8'), 'not ours to delete');
  assert.equal(readFileSync(join(w.runtimeApp, 'bridge', 'a.mjs'), 'utf8'), 'a');
});
