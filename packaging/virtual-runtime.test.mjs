// The conversation service's start when the Runtime is not a plain folder in the game: a Mod Organizer 2 mod, which exists only in the
// virtual file system (USVFS) the game and every process it starts run in (node --test packaging/virtual-runtime.test.mjs).
//
// A player on the Ultraviolence modlist installed the Runtime and the Scripts as MO2 mods. The game then read only the RED4ext launcher's
// "starting" in runtime/bridge-service.json, forever: the service never said anything more, and neither did anything else. These tests
// pin what the start must do whichever way the Runtime is installed:
//   - the layout derives the game's folders from --game-root and the Runtime's folders from the script's own place, so a Runtime that
//     lives somewhere else entirely (an MO2 mod folder) works and is never touched;
//   - nothing in the start can end without a status: a missing file, an error nobody caught, a stage that never finishes;
//   - a process that cannot see the game's mod folder (it runs outside the virtual file system) writes nothing under the game folder.
// There is no virtual file system here: the Runtime is placed outside the game folder, which is what the service sees from inside one.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {installLayout} from './runtime/prepare-state.mjs';
import {findCandidates, placeMisplacedPacks} from './runtime/place-packs.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const MOD = 'bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod';
const APP = 'red4ext/plugins/AiNpcCyberpunkMod/app';
const LAUNCHER_FILES = ['start-service.mjs', 'prepare-state.mjs', 'assemble-parts.mjs', 'migrate-legacy.mjs', 'place-packs.mjs', 'state-home.mjs', 'usvfs-compat.mjs'];
const put = async (path, text) => { await mkdir(dirname(path), {recursive: true}); await writeFile(path, text); };
const read = path => readFile(path, 'utf8');
const exists = path => stat(path).then(() => true, () => false);
const readStatus = async game => JSON.parse(await read(join(game, MOD, 'runtime/bridge-service.json')));

async function tree(path, rel = '') {
  const out = [];
  for (const entry of (await readdir(path, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await tree(join(path, entry.name), name)); else out.push(name);
  }
  return out;
}

// A game folder with the CET mod's init.lua, and a Runtime in an MO2 mod folder far from it (`inGame: true` puts it in the game, as a
// physical install does). The data home is a folder of its own, as %LOCALAPPDATA%\AiNpcCyberpunkMod is.
async function install({inGame = false, withInit = true} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ai npc virtual runtime Ünï '));
  const game = join(root, 'Games', 'Cyberpunk 2077');
  const modFolder = join(root, 'Modlists', 'Ultraviolence', 'mods', 'AI NPC Cyberpunk Mod Runtime');
  const app = join(inGame ? game : modFolder, APP);
  await mkdir(join(app, 'launcher'), {recursive: true});
  for (const name of LAUNCHER_FILES) await cp(join(project, 'packaging/runtime', name), join(app, 'launcher', name));
  await put(join(app, 'defaults/pocket-voices.autobest.json'), JSON.stringify({version: 1, provider: 'pocket', engine: 'pocket-tts', runtime: {}, voices: {}}));
  await put(join(app, 'defaults/characters.json'), '{"v":2}');
  await put(join(app, 'defaults/multilingual-profiles.json'), '{"v":2}');
  await put(join(app, 'models/lipsync/face-model.json'), '{}');
  await put(join(game, 'bin/x64/Cyberpunk2077.exe'), 'exe');
  if (withInit) await put(join(game, MOD, 'init.lua'), '-- the CET mod');
  const home = join(root, 'LocalAppData', 'AiNpcCyberpunkMod');
  return {root, game, app, modFolder, home, state: join(home, 'data'), env: {...process.env, CYBERPUNK_CONVAI_DATA_HOME: home},
    cleanup: () => rm(root, {recursive: true, force: true})};
}
const start = (f, ...extra) => spawnSync(process.execPath, [join(f.app, 'launcher/start-service.mjs'), '--game-root', f.game, ...extra],
  {encoding: 'utf8', timeout: 60_000, env: f.env});

test('a Runtime in an MO2 mod folder, far from the game folder, prepares and leaves the mod folder untouched', async () => {
  const f = await install();
  try {
    const before = await tree(f.modFolder);
    const result = start(f, '--prepare-only');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const summary = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.equal(summary.ok, true);
    assert.equal(summary.state, f.state);
    assert.deepEqual(await tree(f.modFolder), before, 'nothing is written next to the Runtime: it would land in Overwrite');
    assert.equal(await exists(join(f.game, 'red4ext')), false, 'nothing is created for the Runtime in the game folder');
    assert.deepEqual((await readdir(join(f.game, MOD))).sort(), ['init.lua', 'runtime'], 'only runtime/ is made in the CET mod folder');
    assert.equal(await exists(join(f.state, 'characters.json')), true, 'the data is in the data home');
    const log = await read(join(f.state, 'bridge-service.log'));
    assert.match(log, /View: Node v?\d/);
    assert.match(log, /the Runtime is outside the game folder/);
    assert.match(log, /the CET mod's init\.lua is visible/);
    assert.match(log, /inside a virtual file system \(usvfs\): no/, 'a plain Node process is outside any virtual file system');
  } finally { await f.cleanup(); }
});

test('the layout takes the game folders from --game-root and the Runtime folders from the script, wherever each is', () => {
  const game = join(tmpdir(), 'Game', 'Cyberpunk 2077'), app = join(tmpdir(), 'Modlist', 'mods', 'Runtime', APP);
  const layout = installLayout({appDirectory: app, gameRoot: game});
  assert.equal(layout.mod, resolve(game, MOD));
  assert.equal(layout.runtime, resolve(game, MOD, 'runtime'));
  assert.equal(layout.plugin, resolve(app, '..'));
  assert.equal(layout.voices, resolve(app, '..', 'voices'));
  assert.equal(layout.node, resolve(app, 'node/node.exe'));
  assert.equal(layout.localAi, resolve(app, 'local-ai'));
  // No realpath, no comparison of one with the other: a virtual file system may show the same folder under two names.
});

test('a Runtime outside the game folder is never taken for a misplaced pack, and a pack installed in it stays', async () => {
  const f = await install();
  try {
    await put(join(f.app, 'local-ai/manifest.standard.json'), '{"version":1}');
    await put(join(f.app, 'local-ai/models/chat.gguf'), 'MODEL');
    await put(join(f.app, 'omni/omni-pack.json'), '{}');
    const layout = installLayout({appDirectory: f.app, gameRoot: f.game});
    const before = await tree(f.modFolder);
    assert.deepEqual(await findCandidates(layout), []);
    const report = await placeMisplacedPacks({layout, log: () => assert.fail('nothing to move')});
    assert.deepEqual(report, {fixed: [], conflicts: [], errors: []});
    assert.deepEqual(await tree(f.modFolder), before);
    // The same folder shown a second way (a virtual file system lists a mod's files inside the game folder): still the installation.
    await cp(join(f.modFolder, 'red4ext'), join(f.game, 'red4ext'), {recursive: true});
    const both = installLayout({appDirectory: f.app, gameRoot: f.game});
    assert.deepEqual(await findCandidates(both), [], 'the game\'s own red4ext folder is never searched');
    await placeMisplacedPacks({layout: both, log: () => assert.fail('nothing to move')});
    assert.equal(await exists(join(f.game, APP, 'local-ai/manifest.standard.json')), true, 'the copy shown in the game folder is left too');
    assert.equal(await exists(join(f.app, 'local-ai/manifest.standard.json')), true);
  } finally { await f.cleanup(); }
});

test('a missing file of the service ends in a failed status with a short reason and a line in the log, with no path in the reason', async () => {
  const f = await install();
  try {
    await rm(join(f.app, 'launcher/place-packs.mjs'));
    const result = start(f, '--game-pid', '4242');
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const status = await readStatus(f.game);
    assert.equal(status.state, 'failed');
    assert.equal(status.code, 'install-incomplete');
    assert.equal(status.stage, 'loading-modules');
    assert.equal(status.source, 'service');
    assert.equal(status.view, 'usvfs no; Runtime outside the game folder; init.lua visible', 'the status says what the service sees, for the short report');
    assert.equal(status.gamePid, 4242);
    assert.match(status.reason, /place-packs\.mjs/);
    assert.doesNotMatch(status.reason, /[A-Za-z]:[\\/]|Users|Modlists|Games/, status.reason);
    assert(status.reason.length <= 140);
    const log = await read(join(f.state, 'bridge-service.log'));
    assert.match(log, /Loading the service's own files failed/);
  } finally { await f.cleanup(); }
});

test('an error nobody caught ends in a failed status too', async () => {
  const f = await install();
  try {
    // The data home is looked up first; this one throws, with a path in its message.
    await put(join(f.app, 'launcher/state-home.mjs'), `export const dataHomeFor = () => { throw new Error('boom in ${join(f.root, 'secret folder', 'x.mjs').replace(/\\/g, '\\\\')}'); };\n`
      + 'export const moveGameFolderState = async () => ({found: false});\n');
    const result = start(f);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    const status = await readStatus(f.game);
    assert.equal(status.state, 'failed');
    assert.equal(status.code, 'service-error');
    assert.match(status.reason, /boom in x\.mjs/);
    assert.doesNotMatch(status.reason, /secret folder/);
    assert.match(await read(join(f.state, 'bridge-service.log')), /The conversation service stopped: Error: boom in/, 'the log has the full error, the usual place');
  } finally { await f.cleanup(); }
});

test('a stage that never finishes leaves a fresh "starting" naming the stage, written by the script itself, in the file the game reads', async () => {
  const f = await install();
  // Preparing the state hangs, as a lock, a locked file or a stalled disk would make it.
  await cp(join(f.app, 'launcher/prepare-state.mjs'), join(f.app, 'launcher/prepare-state-real.mjs'));
  await put(join(f.app, 'launcher/prepare-state.mjs'), `export {installLayout, serviceEnvironment} from './prepare-state-real.mjs';\n`
    + 'export const prepareState = () => new Promise(() => setInterval(() => {}, 1000));\n');
  const child = spawn(process.execPath, [join(f.app, 'launcher/start-service.mjs'), '--game-root', f.game, '--game-pid', '4242'],
    {env: f.env, stdio: 'ignore', windowsHide: true});
  try {
    let status;
    for (let waited = 0; waited < 20_000; waited += 100) {
      status = await readStatus(f.game).catch(() => null);
      if (status?.stage === 'preparing-state') break;
      await sleep(100);
    }
    assert.equal(status?.stage, 'preparing-state', JSON.stringify(status));
    assert.equal(status.state, 'starting');
    assert.equal(status.code, 'service-starting');
    assert.equal(status.source, 'service');
    assert.equal(status.supervisorPid, child.pid);
    assert.equal(status.gamePid, 4242);
    assert.equal(status.stateDirectory, f.state);
    assert(Math.abs(Date.now() - status.updated) < 10_000);
    // The file is where the layout puts the game's runtime/, the one mod/service-status.lua reads.
    assert.equal(join(f.game, MOD, 'runtime', 'bridge-service.json'), join(installLayout({appDirectory: f.app, gameRoot: f.game}).runtime, 'bridge-service.json'));
    // And it is kept fresh while the stage lasts.
    const first = status.updated;
    let later = first;
    for (let waited = 0; waited < 15_000 && later === first; waited += 200) { await sleep(200); later = (await readStatus(f.game).catch(() => status)).updated; }
    assert.notEqual(later, first, 'the status is refreshed while the script prepares');
  } finally { child.kill(); await sleep(200); await f.cleanup(); }
});

test('a service that cannot see the game\'s mod folder stops and writes nothing under the game folder', async () => {
  const f = await install({withInit: false});
  try {
    const result = start(f);
    assert.equal(result.status, 3, result.stderr + result.stdout);
    assert.equal(await exists(join(f.game, 'bin/x64/plugins')), false, 'no CET mod folder, no runtime/ and no status are made in the game folder');
    assert.deepEqual(await readdir(f.game), ['bin'], 'only the game executable\'s folder is there');
    const log = await read(join(f.state, 'bridge-service.log'));
    assert.match(log, /View: .*the CET mod's init\.lua is NOT visible/);
    assert.match(log, /Stopped: the CET mod's init\.lua .* is not visible to this process, although the launcher saw it/);
    assert.match(log, /Nothing was started/);
    assert.equal(await exists(join(f.state, 'characters.json')), false, 'nothing was prepared either');
    // --prepare-only is a development and test aid with no game to talk to: it goes on.
    const prepared = start(f, '--prepare-only');
    assert.equal(prepared.status, 0, prepared.stderr);
  } finally { await f.cleanup(); }
});

test('a physical install, with the Runtime inside the game folder, behaves the same', async () => {
  const f = await install({inGame: true});
  try {
    const result = start(f, '--prepare-only');
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const log = await read(join(f.state, 'bridge-service.log'));
    assert.match(log, /the Runtime is inside the game folder/);
    assert.match(log, /the CET mod's init\.lua is visible/);
    // A failure is published the same way.
    await rm(join(f.app, 'launcher/state-home.mjs'));
    const failed = start(f);
    assert.equal(failed.status, 1);
    const status = await readStatus(f.game);
    assert.deepEqual([status.state, status.code, status.stage], ['failed', 'install-incomplete', 'loading-modules']);
    assert.equal(status.view, 'usvfs no; Runtime inside the game folder; init.lua visible');
  } finally { await f.cleanup(); }
});

test('the status the script writes carries what mod/service-status.lua reads, in the supervisor\'s fields', async () => {
  const f = await install();
  try {
    await rm(join(f.app, 'launcher/assemble-parts.mjs'));
    start(f);
    const status = await readStatus(f.game);
    for (const key of ['version', 'state', 'code', 'since', 'updated', 'supervisorPid', 'bridgePid', 'adopted', 'restarts', 'gamePid', 'gameRoot']) {
      assert(key in status, key);
    }
    assert.equal(status.version, 1);
    assert.equal(status.gameRoot, resolve(f.game));
    assert(Number.isSafeInteger(status.since) && Number.isSafeInteger(status.updated) && status.since <= status.updated);
    assert.equal(status.supervisorPid > 0, true);
  } finally { await f.cleanup(); }
});
