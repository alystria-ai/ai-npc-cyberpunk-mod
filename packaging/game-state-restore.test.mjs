// The launcher's start-up restore of the player's state files (packaging/runtime/start-service.mjs, bridge/game-state.mjs): under Mod
// Organizer 2 a file created in the game folder does not survive a launch, so the files come back from the copies in the data folder
// before anything slower runs, and runtime/state-restore.json tells the game's Lua the restore is over.
// Every test uses its own temporary folders; the real %LOCALAPPDATA% is never touched.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installLayout, serviceEnvironment} from './runtime/prepare-state.mjs';
import {DATA_HOME_NAME} from './runtime/state-home.mjs';
import {RESTORE_SIGNAL, gameStateFolder} from '../bridge/game-state.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const MOD = 'bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod';
const APP = 'red4ext/plugins/AiNpcCyberpunkMod/app';
const put = async (path, text, seconds) => {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, text);
  if (seconds !== undefined) await utimes(path, seconds, seconds);
};
const read = path => readFile(path, 'utf8');
const exists = path => stat(path).then(() => true, () => false);
const LAUNCHER = ['start-service.mjs', 'prepare-state.mjs', 'assemble-parts.mjs', 'migrate-legacy.mjs', 'place-packs.mjs', 'state-home.mjs'];

async function installed({withGameState = true, withDefaults = true} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ai npc restore Ünï '));
  const game = join(root, 'Cyberpunk 2077'), home = join(root, 'LocalAppData', DATA_HOME_NAME), app = join(game, APP);
  for (const name of LAUNCHER) { await mkdir(join(app, 'launcher'), {recursive: true}); await cp(join(project, 'packaging/runtime', name), join(app, 'launcher', name)); }
  if (withGameState) { await mkdir(join(app, 'bridge'), {recursive: true}); await cp(join(project, 'bridge/game-state.mjs'), join(app, 'bridge/game-state.mjs')); }
  if (withDefaults) {
    await put(join(app, 'defaults/pocket-voices.autobest.json'), JSON.stringify({version: 1, provider: 'pocket', engine: 'pocket-tts', runtime: {}, voices: {}}));
    await put(join(app, 'defaults/characters.json'), '{"v":2}');
    await put(join(app, 'defaults/multilingual-profiles.json'), '{"v":2}');
    await put(join(app, 'models/lipsync/face-model.json'), '{}');
  }
  await put(join(game, 'bin/x64/Cyberpunk2077.exe'), 'exe');
  await put(join(game, MOD, 'init.lua'), '-- the CET mod');
  return {root, game, home, app, runtime: join(game, MOD, 'runtime'), data: join(home, 'data'), copies: gameStateFolder(join(home, 'data')),
    cleanup: () => rm(root, {recursive: true, force: true}),
    run: env => spawnSync(process.execPath, [join(app, 'launcher/start-service.mjs'), '--game-root', game, '--prepare-only'],
      {encoding: 'utf8', timeout: 60_000, env: {...process.env, CYBERPUNK_CONVAI_DATA_HOME: home, ...env}})};
}

test('the launcher puts a missing or empty state file back from its copy and then publishes the signal', async () => {
  const f = await installed();
  try {
    const NOW = Math.floor(Date.now() / 1000);
    await put(join(f.copies, 'settings.json'), '{"version":2,"voice":false,"conversationProvider":"local"}', NOW - 3600);
    await put(join(f.copies, 'phone-history.json'), '{"version":3,"buckets":{"saved":{}}}', NOW - 3600);
    await put(join(f.copies, 'npc-names.json'), '{"version":1,"names":{"vendor":"Rico Alvarez"},"order":["vendor"]}', NOW - 3600);
    await put(join(f.runtime, 'phone-history.json'), '');                                   // an empty file where the copy belongs
    await put(join(f.runtime, 'addon-settings.json'), '{"version":1,"addons":{"mine":{}}}');  // a real file wins
    await put(join(f.runtime, RESTORE_SIGNAL), '');                                         // the Scripts package's empty placeholder
    const started = Date.now();
    const result = f.run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(await read(join(f.runtime, 'settings.json')), '{"version":2,"voice":false,"conversationProvider":"local"}');
    assert.equal(await read(join(f.runtime, 'phone-history.json')), '{"version":3,"buckets":{"saved":{}}}');
    assert.equal(await read(join(f.runtime, 'npc-names.json')), '{"version":1,"names":{"vendor":"Rico Alvarez"},"order":["vendor"]}');
    assert.equal(await read(join(f.runtime, 'addon-settings.json')), '{"version":1,"addons":{"mine":{}}}', 'a real file is never replaced');
    assert.equal(await read(join(f.copies, 'addon-settings.json')), '{"version":1,"addons":{"mine":{}}}', 'and refreshes the copy');
    const signal = JSON.parse(await read(join(f.runtime, RESTORE_SIGNAL)));
    assert.equal(signal.version, 1); assert.equal(signal.state, 'done'); assert.equal(signal.errors, 0);
    assert.deepEqual(signal.restored, ['settings.json', 'phone-history.json', 'npc-names.json']);
    assert(signal.written >= started - 2000 && signal.written <= Date.now() + 2000, `signal time ${signal.written}`);
    assert.match(await read(join(f.data, 'bridge-service.log')), /Player state in runtime\/: 3 restored \(settings\.json, phone-history\.json, npc-names\.json\), 1 copied\./);
  } finally { await f.cleanup(); }
});

test('the restore comes before the slower start-up work: it is done even when preparing the installation fails', async () => {
  const f = await installed({withDefaults: false});          // no packaged defaults: prepareState fails
  try {
    await put(join(f.copies, 'settings.json'), '{"version":2,"voice":false}');
    const result = f.run();
    assert.equal(result.status, 1, 'the start fails as it always did without its defaults');
    assert.equal(await read(join(f.runtime, 'settings.json')), '{"version":2,"voice":false}');
    assert.equal(JSON.parse(await read(join(f.runtime, RESTORE_SIGNAL))).state, 'done');
  } finally { await f.cleanup(); }
});

test('a first start with nothing saved creates no state file and still publishes the signal', async () => {
  const f = await installed();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    for (const name of ['settings.json', 'phone-history.json', 'addon-settings.json', 'npc-names.json', 'memory-chat-resets.json']) {
      assert.equal(await exists(join(f.runtime, name)), false, `${name} is created by the game, never by a restore with nothing to restore`);
    }
    assert.deepEqual(JSON.parse(await read(join(f.runtime, RESTORE_SIGNAL))).restored, []);
    assert.equal(await exists(f.copies), false, 'no copies folder until there is a copy to keep');
  } finally { await f.cleanup(); }
});

test('without a data home outside the game folder there is no restore and no signal', async () => {
  const f = await installed();
  try {
    await put(join(f.runtime, RESTORE_SIGNAL), '');
    const result = f.run({CYBERPUNK_CONVAI_DATA_HOME: '', LOCALAPPDATA: ''});
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(await read(join(f.runtime, RESTORE_SIGNAL)), '', 'the placeholder is untouched');
  } finally { await f.cleanup(); }
});

test('a Runtime package without the module still publishes a signal, so the game stops waiting', async () => {
  const f = await installed({withGameState: false});
  try {
    await put(join(f.copies, 'settings.json'), '{"version":2}');
    const result = f.run();
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const signal = JSON.parse(await read(join(f.runtime, RESTORE_SIGNAL)));
    assert.equal(signal.state, 'done'); assert.equal(signal.errors, 1);
    assert.match(await read(join(f.data, 'bridge-service.log')), /Restoring the player's state files failed/);
  } finally { await f.cleanup(); }
});

test('the service environment names the copies folder only with a data home, and a developer\'s value never leaks in', () => {
  const app = join(tmpdir(), 'ai-npc-app'), game = join(tmpdir(), 'ai-npc-game');
  const withHome = installLayout({appDirectory: app, gameRoot: game, dataHome: join(tmpdir(), 'ai-npc-home')});
  const env = serviceEnvironment(withHome, {omni: false, keyFile: 'key'}, {CYBERPUNK_CONVAI_GAME_STATE: 'D:\\developer'});
  assert.equal(env.CYBERPUNK_CONVAI_GAME_STATE, gameStateFolder(withHome.state), 'the bridge keeps the copies where the launcher restores them from');
  const without = installLayout({appDirectory: app, gameRoot: game, dataHome: null});
  assert.equal('CYBERPUNK_CONVAI_GAME_STATE' in serviceEnvironment(without, {omni: false, keyFile: 'key'}, {CYBERPUNK_CONVAI_GAME_STATE: 'D:\\developer'}), false);
});
