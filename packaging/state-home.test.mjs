// The player's data folder outside the game folder (packaging/runtime/state-home.mjs): where it is, and the one-time move of an
// earlier release's data/ out of the CET mod folder (node --test packaging/state-home.test.mjs). Every test uses its own temporary
// folders; the real %LOCALAPPDATA% is never touched.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import * as realFs from 'node:fs/promises';
import {cp, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DATA_HOME_NAME, KEPT_FOLDER, RECORD_FILE, classify, dataHomeFor, moveGameFolderState} from './runtime/state-home.mjs';
import {installLayout} from './runtime/prepare-state.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const MOD = 'bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod';
const APP = 'red4ext/plugins/AiNpcCyberpunkMod/app';
const put = async (path, text) => { await mkdir(dirname(path), {recursive: true}); await writeFile(path, text); };
const read = path => readFile(path, 'utf8');
const exists = path => realFs.lstat(path).then(() => true, () => false);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ai npc state home Ünï '));
  const game = join(root, 'Cyberpunk 2077');
  const home = join(root, 'LocalAppData', DATA_HOME_NAME);
  return {root, game, home, from: join(game, MOD, 'data'), to: join(home, 'data'), cleanup: () => rm(root, {recursive: true, force: true})};
}

// What an earlier release left in <mod>/data: player state, generated files, volatile files.
async function earlierData(from) {
  await put(join(from, 'player-memory.json'), '{"judy":["likes the sea"]}');
  await put(join(from, 'convai-key.txt'), 'api-key = fake-test-value-not-a-key\n');
  await put(join(from, 'characters.json'), '{"mine":true}');
  await put(join(from, 'package-defaults.json'), '{"version":1,"files":{}}');
  await put(join(from, 'local-memory/judy/0001.json'), '{"text":"met at the docks"}');
  await put(join(from, 'pocket-voice-work/judy/state.bin'), Buffer.alloc(70_000, 3));
  await put(join(from, 'bridge-service.log'), 'old log\n');
  // Generated from the package on every start: removed, not copied.
  await put(join(from, 'lipsync-model/face-model.json'), '{}');
  await put(join(from, 'pocket-voices.autobest.json'), '{"runtime":{"workDirectory":"E:\\\\old"}}');
  await put(join(from, 'voice-configs.json'), '{}');
  // Volatile: never carried.
  await put(join(from, 'bridge.pid'), '4242');
  await put(join(from, 'bridge-control.json'), '{}');
  await put(join(from, 'settings.json.1234.tmp'), 'half');
}

test('the data home is %LOCALAPPDATA%\\AiNpcCyberpunkMod, an absolute override wins, anything else is ignored', () => {
  assert.deepEqual(dataHomeFor({LOCALAPPDATA: 'C:\\Users\\V\\AppData\\Local'}),
    {root: resolve('C:\\Users\\V\\AppData\\Local', DATA_HOME_NAME), source: 'localappdata'});
  assert.deepEqual(dataHomeFor({LOCALAPPDATA: 'C:\\Users\\V\\AppData\\Local', CYBERPUNK_CONVAI_DATA_HOME: 'D:\\Mods\\AI NPC'}),
    {root: resolve('D:\\Mods\\AI NPC'), source: 'override'});
  const relative = dataHomeFor({LOCALAPPDATA: 'C:\\Users\\V\\AppData\\Local', CYBERPUNK_CONVAI_DATA_HOME: 'mydata'});
  assert.equal(relative.root, resolve('C:\\Users\\V\\AppData\\Local', DATA_HOME_NAME));
  assert.match(relative.problem, /not an absolute path/);
  if (process.platform === 'win32') assert.equal(dataHomeFor({LOCALAPPDATA: 'C:relative'}).root, null, 'a drive-relative path is not used');
  assert.deepEqual(dataHomeFor({}), {root: null, source: 'game-folder'}, 'without a data home the data stays in the game folder');
});

test('the layout keeps runtime/ in the mod folder and puts data/ in the data home', () => {
  const game = 'E:\\Games\\Cyberpunk 2077', app = `${game}\\${APP.replaceAll('/', '\\')}`;
  const moved = installLayout({appDirectory: app, gameRoot: game, dataHome: 'C:\\Users\\V\\AppData\\Local\\AiNpcCyberpunkMod'});
  assert.equal(moved.state, resolve('C:\\Users\\V\\AppData\\Local\\AiNpcCyberpunkMod\\data'));
  assert.equal(moved.runtime, resolve(game, MOD, 'runtime'), 'the Lua exchange folder stays where CET lets Lua reach it');
  assert.equal(moved.gameState, resolve(game, MOD, 'data'));
  const old = installLayout({appDirectory: app, gameRoot: game});
  assert.equal(old.state, resolve(game, MOD, 'data'), 'without a data home nothing changes');
  assert.equal(old.dataHome, null);
});

test('state, generated and volatile files are told apart', () => {
  assert.equal(classify('player-memory.json'), 'state');
  assert.equal(classify('local-memory/judy/0001.json'), 'state');
  assert.equal(classify('package-defaults.json'), 'state', 'it remembers which managed files the player edited');
  assert.equal(classify('lipsync-model/face-model.json'), 'generated');
  assert.equal(classify('voice-configs.json'), 'generated');
  assert.equal(classify('character-overrides/voice-configs.json'), 'state', 'only top-level generated names');
  for (const name of ['bridge.pid', 'bridge-supervisor.lock', 'bridge-control.json', 'x.json.12.tmp', 'y.migrating']) assert.equal(classify(name), 'volatile', name);
});

test('nothing to move costs one lstat and changes nothing', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const fs = new Proxy(realFs, {get: (target, name) => (...args) => { calls++; return target[name](...args); }});
    assert.deepEqual(await moveGameFolderState({from: f.from, to: f.to, fs}), {found: false});
    assert.equal(calls, 1);
    assert.equal(await exists(f.home), false);
  } finally { await f.cleanup(); }
});

test('an earlier release\'s data moves out of the game folder whole, and the old folder is removed', async () => {
  const f = await fixture();
  try {
    await earlierData(f.from);
    const lines = [];
    const result = await moveGameFolderState({from: f.from, to: f.to, log: line => lines.push(line)});
    assert.equal(result.state, 'moved');
    assert.equal(result.moved, 7);
    assert.deepEqual(result.leftovers, []);
    assert.equal(await read(join(f.to, 'player-memory.json')), '{"judy":["likes the sea"]}');
    assert.equal(await read(join(f.to, 'local-memory/judy/0001.json')), '{"text":"met at the docks"}');
    assert.equal((await readFile(join(f.to, 'pocket-voice-work/judy/state.bin'))).length, 70_000);
    assert.equal(await read(join(f.to, 'convai-key.txt')), 'api-key = fake-test-value-not-a-key\n');
    for (const name of ['lipsync-model', 'pocket-voices.autobest.json', 'voice-configs.json', 'bridge.pid', 'bridge-control.json', 'settings.json.1234.tmp']) {
      assert.equal(await exists(join(f.to, name)), false, `${name} is not carried`);
    }
    assert.equal(await exists(f.from), false, 'the data folder in the game folder is gone');
    assert.equal(await exists(join(f.game, MOD)), true, 'the mod folder itself stays');
    assert.deepEqual((await readdir(f.to)).filter(name => name.startsWith('.moving-')), [], 'no staging folder is left');
    const record = JSON.parse(await read(join(f.to, RECORD_FILE)));
    assert.equal(record.moved, 7);
    assert.match(lines.join('\n'), /Moved the player's data from .* 7 file\(s\) moved/);
    // A second start finds nothing to move.
    assert.deepEqual(await moveGameFolderState({from: f.from, to: f.to}), {found: false});
  } finally { await f.cleanup(); }
});

test('when both folders have a file, the newer one is used and the other is kept, never deleted', async () => {
  const f = await fixture();
  try {
    await put(join(f.from, 'player-memory.json'), 'NEWER IN GAME FOLDER');
    await put(join(f.from, 'phone-sessions.json'), 'OLDER IN GAME FOLDER');
    await put(join(f.from, 'daily-usage.json'), 'SAME');
    await put(join(f.to, 'player-memory.json'), 'older in data home');
    await put(join(f.to, 'phone-sessions.json'), 'newer in data home');
    await put(join(f.to, 'daily-usage.json'), 'SAME');
    const old = new Date('2026-10-01T00:00:00Z'), recent = new Date('2026-10-17T00:00:00Z');
    await utimes(join(f.from, 'player-memory.json'), recent, recent);
    await utimes(join(f.to, 'player-memory.json'), old, old);
    await utimes(join(f.from, 'phone-sessions.json'), old, old);
    await utimes(join(f.to, 'phone-sessions.json'), recent, recent);
    const result = await moveGameFolderState({from: f.from, to: f.to, now: () => new Date('2026-10-18T10:00:00Z')});
    assert.equal(result.state, 'moved');
    assert.equal(result.same, 1);
    assert.deepEqual(result.keptReplaced, ['player-memory.json']);
    assert.deepEqual(result.keptOlder, ['phone-sessions.json']);
    assert.equal(await read(join(f.to, 'player-memory.json')), 'NEWER IN GAME FOLDER');
    assert.equal(await read(join(f.to, 'phone-sessions.json')), 'newer in data home');
    const kept = join(f.to, KEPT_FOLDER);
    const folders = (await readdir(kept)).sort();
    assert.equal(folders.length, 2);
    assert.equal(await read(join(kept, folders.find(name => name.endsWith('-replaced')), 'player-memory.json')), 'older in data home');
    assert.equal(await read(join(kept, folders.find(name => name.endsWith('-older')), 'phone-sessions.json')), 'OLDER IN GAME FOLDER');
    assert.equal(await exists(f.from), false);
  } finally { await f.cleanup(); }
});

test('a copy that fails changes nothing: the game folder copy is used for this start and the move is retried later', async () => {
  const f = await fixture();
  try {
    await earlierData(f.from);
    const before = (await readdir(f.from, {recursive: true})).sort();
    const fs = {...realFs, copyFile: async (src, dst) => {
      if (src.endsWith('0001.json')) throw Object.assign(Error('disk full'), {code: 'ENOSPC'});
      return realFs.copyFile(src, dst);
    }};
    const lines = [];
    const result = await moveGameFolderState({from: f.from, to: f.to, fs, log: line => lines.push(line)});
    assert.deepEqual(result, {found: true, state: 'deferred', reason: 'ENOSPC'});
    assert.deepEqual((await readdir(f.from, {recursive: true})).sort(), before, 'the old folder is untouched');
    assert.deepEqual(await readdir(f.to), [], 'nothing half-copied is left in the data home');
    assert.match(lines.join('\n'), /failed \(ENOSPC\).*tried again/);
    // The next start, with room on the disk, moves everything.
    assert.equal((await moveGameFolderState({from: f.from, to: f.to})).state, 'moved');
    assert.equal(await read(join(f.to, 'local-memory/judy/0001.json')), '{"text":"met at the docks"}');
  } finally { await f.cleanup(); }
});

test('a lock still held by a service from an earlier session defers the move', async () => {
  const f = await fixture();
  try {
    await earlierData(f.from);
    await put(join(f.from, 'bridge-supervisor.lock'), '777');
    const fs = {...realFs, rm: async (path, options) => {
      if (path.endsWith('bridge-supervisor.lock')) throw Object.assign(Error('busy'), {code: 'EBUSY'});
      return realFs.rm(path, options);
    }};
    assert.deepEqual(await moveGameFolderState({from: f.from, to: f.to, fs}), {found: true, state: 'deferred', reason: 'in-use'});
    assert.equal(await exists(join(f.from, 'player-memory.json')), true);
    assert.equal(await exists(f.to), false);
    // A stale lock (its service has ended) is simply removed.
    assert.equal((await moveGameFolderState({from: f.from, to: f.to})).state, 'moved');
  } finally { await f.cleanup(); }
});

test('a data home inside the old folder, or the same folder, is never treated as a move', async () => {
  const f = await fixture();
  try {
    await earlierData(f.from);
    assert.deepEqual(await moveGameFolderState({from: f.from, to: f.from}), {found: false});
    assert.deepEqual(await moveGameFolderState({from: f.from, to: join(f.from, 'inner')}), {found: false});
    assert.equal(await exists(join(f.from, 'player-memory.json')), true);
  } finally { await f.cleanup(); }
});

// The packaged entry point, end to end: an earlier release's data/ is moved before prepareState, the player's key is found in its
// new place, nothing new is written under the CET mod folder except runtime/, and a second start is a normal start.
async function installedApp(game) {
  const app = join(game, APP);
  for (const name of ['start-service.mjs', 'prepare-state.mjs', 'assemble-parts.mjs', 'migrate-legacy.mjs', 'place-packs.mjs', 'state-home.mjs']) {
    await mkdir(join(app, 'launcher'), {recursive: true});
    await cp(join(project, 'packaging/runtime', name), join(app, 'launcher', name));
  }
  await put(join(app, 'defaults/pocket-voices.autobest.json'), JSON.stringify({version: 1, provider: 'pocket', engine: 'pocket-tts', runtime: {}, voices: {}}));
  await put(join(app, 'defaults/characters.json'), '{"v":2}');
  await put(join(app, 'defaults/multilingual-profiles.json'), '{"v":2}');
  await put(join(app, 'models/lipsync/face-model.json'), '{}');
  await put(join(game, 'bin/x64/Cyberpunk2077.exe'), 'exe');
  await put(join(game, MOD, 'init.lua'), '-- the CET mod');
  return app;
}

test('the packaged service moves the data folder before it reads it (start-service.mjs --prepare-only)', async () => {
  const f = await fixture();
  try {
    const app = await installedApp(f.game);
    await earlierData(f.from);
    const run = () => spawnSync(process.execPath, [join(app, 'launcher/start-service.mjs'), '--game-root', f.game, '--prepare-only'],
      {encoding: 'utf8', timeout: 60_000, env: {...process.env, CYBERPUNK_CONVAI_DATA_HOME: f.home}});
    const first = run();
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const summary = JSON.parse(first.stdout.trim().split('\n').pop());
    assert.equal(summary.ok, true);
    assert.equal(summary.state, f.to);
    assert.equal(summary.key, 'player', 'the player\'s own key is found in its new place');
    assert.equal(await read(join(f.to, 'characters.json')), '{"mine":true}', 'an edited managed file stays the player\'s');
    assert.equal(await read(join(f.to, 'lipsync-model/face-model.json')), '{}', 'generated files are written fresh');
    assert.equal(await exists(f.from), false);
    assert.deepEqual((await readdir(join(f.game, MOD))).sort(), ['init.lua', 'runtime'], 'only runtime/ is created in the CET mod folder');
    const log = await read(join(f.to, 'bridge-service.log'));
    assert.match(log, /old log/, 'the old service log continues in the new place');
    assert.match(log, /Moved the player's data from /);
    assert.match(log, /player data in /);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout.trim().split('\n').pop()).state, f.to);
    assert.equal(await exists(f.from), false, 'a second start writes nothing to the game folder\'s data/');
  } finally { await f.cleanup(); }
});

test('a fresh install never creates data/ in the game folder', async () => {
  const f = await fixture();
  try {
    const app = await installedApp(f.game);
    const result = spawnSync(process.execPath, [join(app, 'launcher/start-service.mjs'), '--game-root', f.game, '--prepare-only'],
      {encoding: 'utf8', timeout: 60_000, env: {...process.env, CYBERPUNK_CONVAI_DATA_HOME: f.home}});
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(JSON.parse(result.stdout.trim().split('\n').pop()).state, f.to);
    assert.equal(await exists(f.from), false);
    assert.equal(await exists(join(f.to, 'characters.json')), true);
    assert.equal(await exists(join(f.to, RECORD_FILE)), false, 'nothing was moved, so no record');
  } finally { await f.cleanup(); }
});
