// Carry-over from the CyberpunkConvai folders to the AI NPC Cyberpunk Mod folders (packaging/runtime/migrate-legacy.mjs).
// Everything runs in a fake game folder; nothing touches a real installation.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import * as realFs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {adoptLegacyInstall, carryBindings, cleanupLegacyInstall, legacyPaths, REPORT_FILE} from './runtime/migrate-legacy.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const exists = async path => { try { await stat(path); return true; } catch { return false; } };
const put = async (path, text) => { await mkdir(dirname(path), {recursive: true}); await writeFile(path, text); };
const read = path => readFile(path, 'utf8');

// Bindings use numbers CET writes as vk << 48 with more keys in the lower bits: beyond 2^53, so they must survive as text.
const BINDINGS = `{
    "CyberpunkConvai": {
        "cyberpunk_convai_text": 33214047251857409,
        "cyberpunk_convai_voice": 33495522228568064
    },
    "cet": {
        "overlay_key": 4503947519721472
    }
}
`;
const MEMORY = JSON.stringify({players: {p1: {judy: ['remembers the Afterlife', 'ünïcode ✓']}}});

async function fakeGame({withNew = true, state = true} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ai npc legacy test '));
  const game = join(root, 'Cyberpunk 2077 Ünïcode');
  const p = legacyPaths(game);
  await put(join(game, 'bin/x64/Cyberpunk2077.exe'), 'exe');
  await put(p.bindings, BINDINGS);
  // The old CET mod: package files plus the player's data/ and runtime/.
  await put(join(p.oldMod, 'init.lua'), 'return {old = true}');
  await put(join(p.oldMod, 'addons.lua'), '-- old module');
  await put(join(p.oldMod, 'locales/de.lua'), 'return {}');
  await put(join(p.oldMod, 'release.json'), '{"version":"0.1"}');
  await put(join(p.oldMod, 'db.sqlite3'), 'cet');
  await put(join(p.oldMod, 'CyberpunkConvai.log'), 'log');
  if (state) {
    await put(join(p.oldMod, 'data/player-memory.json'), MEMORY);
    await put(join(p.oldMod, 'data/convai-key.txt'), 'api-key = fake-test-value-not-a-key\n');
    await put(join(p.oldMod, 'data/characters.json'), '{"mine":true}');
    await put(join(p.oldMod, 'data/phone/sessions.json'), '{"judy":[{"t":"hi"}]}');
    await put(join(p.oldMod, 'data/bridge-supervisor.lock'), '123');
    await put(join(p.oldMod, 'data/bridge-service.log'), 'old log');
    await put(join(p.oldMod, 'runtime/settings.json'), '{"provider":"mistral"}');
    await put(join(p.oldMod, 'runtime/phone-chat-history.json'), '{"history":[1,2,3]}');
    await put(join(p.oldMod, 'runtime/native-off.txt'), 'actuator\n');
    await put(join(p.oldMod, 'runtime/probe.log'), 'probe');
    await put(join(p.oldMod, 'my-notes.txt.bak'), 'a file the player added');
    await put(join(p.oldMod, 'custom-folder/readme'), 'a folder the player added');
  }
  // The old plugin folders: launcher, application, packs, voices.
  await put(join(p.oldPlugin, 'CyberpunkConvai.dll'), 'MZ old launcher');
  await put(join(p.oldPlugin, 'launcher.ini'), 'enabled=1');
  await put(join(p.oldPlugin, 'app/node/node.exe'), 'node');
  await put(join(p.oldPlugin, 'app/bridge/convai-bridge.mjs'), '// old');
  await put(join(p.oldPlugin, 'voices/judy.wav'), 'judy clip');
  if (state) {
    await put(join(p.oldPlugin, 'app/local-ai/manifest.standard.json'), '{"tier":"standard"}');
    await put(join(p.oldPlugin, 'app/local-ai/models/chat.gguf'), 'G'.repeat(50_000));
    await put(join(p.oldPlugin, 'app/omni/omni-pack.json'), '{"omni":true}');
    await put(join(p.oldPlugin, 'voices/my-own-voice.wav'), 'the player recorded this');
  }
  await put(join(p.oldNative, 'CyberpunkConvaiNative.dll'), 'MZ old native');
  await put(join(p.oldNative, 'README.txt'), 'native');
  if (withNew) {
    await put(join(p.newMod, 'init.lua'), 'return {new = true}');
    await put(join(p.newMod, 'runtime/native-off.txt'), 'actuator\nvehicles\n');
    await put(join(p.newPlugin, 'AiNpcCyberpunkMod.txt'), 'new');
    await put(join(p.newPlugin, 'app/node/node.exe'), 'node new');
    await put(join(p.newPlugin, 'voices/judy.wav'), 'judy clip');
    await put(join(p.newNative, 'CyberpunkConvaiNative.dll'), 'MZ new native');
  }
  return {root, game, p};
}
const done = f => rm(f.root, {recursive: true, force: true});

test('no old folder: nothing is created and nothing changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai npc legacy test '));
  try {
    const game = join(root, 'game');
    const p = legacyPaths(game);
    await put(join(p.newMod, 'init.lua'), 'return {}');
    const adopted = await adoptLegacyInstall({gameRoot: game});
    assert.equal(adopted.found, false);
    assert.deepEqual(await cleanupLegacyInstall({adopted}), {removed: [], pending: []});
    assert.deepEqual(await readdir(p.newMod), ['init.lua'], 'no report, no folder created');
    assert.equal(await exists(join(game, 'red4ext')), false);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('the old copy is retired, the player state arrives byte for byte, and only then are the old folders removed', async () => {
  const f = await fakeGame();
  const {p} = f;
  try {
    const messages = [];
    const adopted = await adoptLegacyInstall({gameRoot: f.game, log: message => messages.push(message)});
    assert.equal(adopted.found, true);
    assert.deepEqual(adopted.report.errors, []);

    // The old copy cannot start any more, while everything is still on disk.
    assert.equal(await exists(join(p.oldMod, 'init.lua')), false);
    assert.equal(await read(join(p.oldMod, 'init.lua.migrated')), 'return {old = true}');
    assert.equal(await exists(join(p.oldPlugin, 'CyberpunkConvai.dll')), false);
    assert.equal(await exists(join(p.oldPlugin, 'CyberpunkConvai.dll.migrated')), true);
    assert.equal(await exists(join(p.oldNative, 'CyberpunkConvaiNative.dll')), false);
    assert.equal(await read(join(p.newMod, 'init.lua')), 'return {new = true}', 'the new mod is untouched');
    assert.equal(await read(join(p.newNative, 'CyberpunkConvaiNative.dll')), 'MZ new native');

    // State: identical bytes in the new places.
    assert.equal(await read(join(p.newMod, 'data/player-memory.json')), MEMORY);
    assert.equal(await read(join(p.newMod, 'data/convai-key.txt')), 'api-key = fake-test-value-not-a-key\n');
    assert.equal(await read(join(p.newMod, 'data/characters.json')), '{"mine":true}');
    assert.equal(await read(join(p.newMod, 'data/phone/sessions.json')), '{"judy":[{"t":"hi"}]}');
    assert.equal(await read(join(p.newMod, 'runtime/settings.json')), '{"provider":"mistral"}');
    assert.equal(await read(join(p.newMod, 'runtime/phone-chat-history.json')), '{"history":[1,2,3]}');
    assert.equal(await read(join(p.newPlugin, 'app/local-ai/manifest.standard.json')), '{"tier":"standard"}');
    assert.equal((await readFile(join(p.newPlugin, 'app/local-ai/models/chat.gguf'))).length, 50_000);
    assert.equal(await read(join(p.newPlugin, 'app/omni/omni-pack.json')), '{"omni":true}');
    assert.equal(await read(join(p.newPlugin, 'voices/my-own-voice.wav')), 'the player recorded this');
    // Package files: the new package wins; stale locks and logs are not carried.
    assert.equal(await read(join(p.newMod, 'runtime/native-off.txt')), 'actuator\nvehicles\n');
    assert.equal(await exists(join(p.newMod, 'data/bridge-supervisor.lock')), false);
    assert.equal(await exists(join(p.newMod, 'data/bridge-service.log')), false);
    assert.equal(await exists(join(p.newMod, 'runtime/probe.log')), false);
    assert.equal(await read(join(p.newPlugin, 'app/node/node.exe')), 'node new', 'the new application is not replaced by the old one');
    assert.equal(await exists(join(p.newPlugin, 'app/bridge')), false, 'old application code is not carried');
    // Nothing of the state is left behind in the old folders.
    assert.equal(await exists(join(p.oldMod, 'data/player-memory.json')), false);
    assert.equal(await exists(join(p.oldPlugin, 'app/local-ai/models/chat.gguf')), false);

    // The key bindings follow the folder name, digits intact; the old entry is saved first.
    assert.equal(adopted.report.bindings, 'renamed');
    const bindings = await read(p.bindings);
    assert.equal(bindings, BINDINGS.replace('"CyberpunkConvai"', '"AiNpcCyberpunkMod"'));
    assert.equal(await read(`${p.bindings}.pre-ai-npc-rename.bak`), BINDINGS);

    // Second phase: the rest of the old folders goes, and what the package does not know is kept, not deleted.
    const cleaned = await cleanupLegacyInstall({adopted, log: message => messages.push(message)});
    assert.deepEqual(cleaned.pending, []);
    assert.deepEqual(cleaned.removed.sort(), [p.oldMod, p.oldPlugin, p.oldNative].sort());
    for (const old of [p.oldMod, p.oldPlugin, p.oldNative]) assert.equal(await exists(old), false, old);
    assert.equal(await read(join(p.newMod, 'data/legacy-migration/leftovers/mod/my-notes.txt.bak')), 'a file the player added');
    assert.equal(await read(join(p.newMod, 'data/legacy-migration/leftovers/mod/custom-folder/readme')), 'a folder the player added');
    const report = JSON.parse(await read(join(p.newMod, 'data', REPORT_FILE)));
    assert.deepEqual(report.pending, []);
    assert(report.leftovers.includes('my-notes.txt.bak'));

    // Running again finds nothing.
    assert.equal((await adoptLegacyInstall({gameRoot: f.game})).found, false);
    assert(messages.some(message => /older installation/.test(message)));
  } finally { await done(f); }
});

test('a state file that exists in both places keeps the old content, and the displaced new file is saved', async () => {
  const f = await fakeGame();
  const {p} = f;
  try {
    await put(join(p.newMod, 'runtime/settings.json'), '{"provider":"convai","fresh":true}');
    await put(join(p.newMod, 'data/phone/sessions.json'), '{"judy":[{"t":"hi"}]}'); // identical: simply merged
    await put(join(p.newMod, 'data/other.json'), '{"only":"new"}');
    const adopted = await adoptLegacyInstall({gameRoot: f.game});
    assert.deepEqual(adopted.report.errors, []);
    assert.equal(await read(join(p.newMod, 'runtime/settings.json')), '{"provider":"mistral"}');
    assert.equal(await read(join(p.newMod, 'data/other.json')), '{"only":"new"}');
    const saved = join(p.newMod, 'data/legacy-migration/replaced/mod-runtime/settings.json');
    assert.equal(await read(saved), '{"provider":"convai","fresh":true}');
    assert.deepEqual(adopted.report.replaced, ['settings.json']);
    assert.equal(await read(join(p.newMod, 'data/phone/sessions.json')), '{"judy":[{"t":"hi"}]}');
  } finally { await done(f); }
});

test('an empty placeholder the package ships in runtime/ takes the old content in place, and a shipped log is emptied, never deleted', async () => {
  const f = await fakeGame();
  const {p} = f;
  try {
    // Mod Organizer 2 needs these to exist (docs/PACKAGING.md), so the carry-over writes into them instead of replacing them.
    await put(join(p.newMod, 'runtime/phone-chat-history.json'), '');
    await put(join(p.newMod, 'runtime/mcm.log'), 'written by this start');
    await put(join(p.newMod, 'runtime/bridge-service.json'), '{"state":"running"}');
    const adopted = await adoptLegacyInstall({gameRoot: f.game});
    assert.deepEqual(adopted.report.errors, []);
    assert.equal(await read(join(p.newMod, 'runtime/phone-chat-history.json')), '{"history":[1,2,3]}');
    assert.deepEqual(adopted.report.replaced, [], 'nothing was displaced');
    assert(adopted.report.moved.some(item => item.path === 'phone-chat-history.json' && item.how === 'copied'));
    assert.equal(await exists(join(p.newMod, 'data/legacy-migration/replaced')), false);
    for (const name of ['mcm.log', 'bridge-service.json']) {
      assert.equal(await exists(join(p.newMod, 'runtime', name)), true, `${name} was not deleted`);
      assert.equal(await read(join(p.newMod, 'runtime', name)), '', `${name} was emptied`);
    }
  } finally { await done(f); }
});

test('when a rename is refused the state is copied, compared and only then removed', async () => {
  const f = await fakeGame();
  const {p} = f;
  try {
    const refuse = new Set();
    const fs = {...realFs, rename: async (from, to) => {
      if (/legacy-migration|\.migrated$|\.migrating$/.test(to)) return realFs.rename(from, to);
      if (from.startsWith(p.oldMod) || from.startsWith(p.oldPlugin)) { refuse.add(from); throw Object.assign(new Error('different drive'), {code: 'EXDEV'}); }
      return realFs.rename(from, to);
    }};
    const adopted = await adoptLegacyInstall({gameRoot: f.game, fs});
    assert(refuse.size > 0, 'the copy path ran');
    assert.deepEqual(adopted.report.errors, []);
    assert(adopted.report.moved.every(item => item.how === 'copied'), JSON.stringify(adopted.report.moved));
    assert.equal(await read(join(p.newMod, 'data/player-memory.json')), MEMORY);
    assert.equal((await readFile(join(p.newPlugin, 'app/local-ai/models/chat.gguf'))).length, 50_000);
    assert.equal(await exists(join(p.oldMod, 'data')), false, 'removed from the source after the copy was verified');
    assert.deepEqual((await readdir(join(p.newMod, 'data'))).filter(name => name.endsWith('.migrating')), []);
  } finally { await done(f); }
});

test('a copy that does not verify deletes nothing; the next start finishes the job', async () => {
  const f = await fakeGame();
  const {p} = f;
  try {
    const broken = {...realFs,
      rename: async (from, to) => (from === join(p.oldMod, 'data') || from === join(p.oldMod, 'runtime'))
        ? Promise.reject(Object.assign(new Error('locked'), {code: 'EBUSY'})) : realFs.rename(from, to),
      copyFile: async (from, to) => { await realFs.copyFile(from, to); if (/player-memory\.json/.test(to)) await writeFile(to, 'TRUNCATED'); }};
    const first = await adoptLegacyInstall({gameRoot: f.game, fs: broken});
    assert(first.report.errors.some(error => /verification/.test(error)), first.report.errors.join('\n'));
    assert.equal(await read(join(p.oldMod, 'data/player-memory.json')), MEMORY, 'the original is untouched');
    const cleaned = await cleanupLegacyInstall({adopted: first, fs: broken});
    assert(cleaned.pending.includes(p.oldMod), 'the old mod folder is kept');
    assert.equal(await read(join(p.oldMod, 'data/player-memory.json')), MEMORY);
    assert.equal(await exists(join(p.newMod, 'data/player-memory.json')), false, 'a half-verified copy is not left behind either');
    // Next start, healthy disk.
    const second = await adoptLegacyInstall({gameRoot: f.game});
    assert.deepEqual(second.report.errors, []);
    assert.equal(await read(join(p.newMod, 'data/player-memory.json')), MEMORY);
    const finished = await cleanupLegacyInstall({adopted: second});
    assert.deepEqual(finished.pending, []);
    assert.equal(await exists(p.oldMod), false);
  } finally { await done(f); }
});

test('a locked old DLL postpones the removal; the old copy is already unable to start and the next start removes it', async () => {
  const f = await fakeGame();
  const {p} = f;
  try {
    const locked = {...realFs, rm: async (path, options) => {
      if (path === p.oldPlugin || path === p.oldNative) throw Object.assign(new Error('in use'), {code: 'EBUSY'});
      return realFs.rm(path, options);
    }};
    const adopted = await adoptLegacyInstall({gameRoot: f.game, fs: locked});
    const cleaned = await cleanupLegacyInstall({adopted, fs: locked});
    assert(cleaned.pending.includes(p.oldPlugin) && cleaned.pending.includes(p.oldNative), cleaned.pending.join(', '));
    assert.equal(await exists(join(p.oldPlugin, 'CyberpunkConvai.dll')), false, 'the DLL cannot be loaded again');
    assert.equal(await exists(join(p.oldNative, 'CyberpunkConvaiNative.dll')), false);
    assert.equal(await exists(p.oldMod), false, 'the part that was not locked is gone');
    assert.equal(await read(join(p.newMod, 'data/player-memory.json')), MEMORY);
    // Next start, nothing locked.
    const again = await adoptLegacyInstall({gameRoot: f.game});
    assert.equal(again.found, true);
    const finished = await cleanupLegacyInstall({adopted: again});
    assert.deepEqual(finished.pending, []);
    assert.equal(await exists(p.oldPlugin), false);
    assert.equal(await exists(p.oldNative), false);
  } finally { await done(f); }
});

test('bindings: only a plain rename of the old entry; an existing new entry or a damaged file is left alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai npc legacy test '));
  try {
    const p = legacyPaths(join(root, 'game'));
    await put(p.bindings, '{"cet": {"overlay_key": 1}}');
    assert.equal(await carryBindings(p), 'none');
    await put(p.bindings, '{"CyberpunkConvai": {"a": 1}, "AiNpcCyberpunkMod": {"a": 2}}');
    assert.equal(await carryBindings(p), 'none');
    assert.equal(await read(p.bindings), '{"CyberpunkConvai": {"a": 1}, "AiNpcCyberpunkMod": {"a": 2}}');
    await put(p.bindings, '{"CyberpunkConvai": {"a": 1');
    assert.equal(await carryBindings(p), 'unreadable');
    assert.equal(await read(p.bindings), '{"CyberpunkConvai": {"a": 1');
    assert.equal(await exists(`${p.bindings}.pre-ai-npc-rename.bak`), false);
    await rm(p.bindings);
    assert.equal(await carryBindings(p), 'none');
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('the packaged service moves an old installation before it reads the data folder (start-service.mjs --prepare-only)', async () => {
  const f = await fakeGame();
  const {p} = f;
  try {
    // A minimal installed application: the real launcher files and the defaults prepareState needs.
    const app = join(p.newPlugin, 'app');
    await mkdir(join(app, 'launcher'), {recursive: true});
    for (const name of ['start-service.mjs', 'prepare-state.mjs', 'assemble-parts.mjs', 'migrate-legacy.mjs', 'place-packs.mjs', 'state-home.mjs', 'usvfs-compat.mjs', 'apply-removals.mjs']) await cp(join(project, 'packaging/runtime', name), join(app, 'launcher', name));
    await put(join(app, 'defaults/pocket-voices.autobest.json'), JSON.stringify({version: 1, provider: 'pocket', engine: 'pocket-tts', runtime: {}, voices: {}}));
    await put(join(app, 'defaults/characters.json'), '{"v":2}');
    await put(join(app, 'defaults/multilingual-profiles.json'), '{"v":2}');
    await put(join(app, 'models/lipsync/face-model.json'), '{}');
    // The data home stands in for %LOCALAPPDATA%\AiNpcCyberpunkMod: the old state goes straight there.
    const home = join(f.root, 'LocalAppData', 'AiNpcCyberpunkMod'), state = join(home, 'data');
    const run = () => spawnSync(process.execPath, [join(app, 'launcher/start-service.mjs'), '--game-root', f.game, '--prepare-only'],
      {encoding: 'utf8', timeout: 60_000, env: {...process.env, CYBERPUNK_CONVAI_DATA_HOME: home}});
    const first = run();
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const summary = JSON.parse(first.stdout.trim().split('\n').pop());
    assert.equal(summary.ok, true);
    assert(summary.legacy && summary.legacy.errors.length === 0 && summary.legacy.pending.length === 0, JSON.stringify(summary.legacy));
    assert.equal(summary.key, 'player', 'the carried convai-key.txt is the key it picks');
    assert.equal(await read(join(state, 'player-memory.json')), MEMORY);
    assert.equal(await read(join(p.newMod, 'runtime/settings.json')), '{"provider":"mistral"}');
    // A managed file the player edited stays theirs.
    assert.equal(await read(join(state, 'characters.json')), '{"mine":true}');
    assert.equal(summary.state, state);
    assert.equal(await exists(join(p.newMod, 'data')), false, 'nothing is written to data/ in the game folder');
    assert.equal(await exists(p.oldMod), false);
    assert.equal(await exists(p.oldPlugin), false);
    assert(/older installation/.test(await read(join(state, 'bridge-service.log'))), 'the service log tells what happened');
    // Starting again is the same as a normal start.
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout.trim().split('\n').pop()).legacy, null);
  } finally { await done(f); }
});

test('the packages carry nothing under the old folder names, and the carry-over targets the shipped folders', async () => {
  // No build under the old name was ever public, so the packages ship no stand-ins at the old paths.
  const config = JSON.parse(await read(join(project, 'packaging/release.config.json')));
  assert.equal(config.legacy, undefined);
  const builder = await read(join(project, 'packaging/build-release.mjs'));
  assert.doesNotMatch(builder, /mods\/CyberpunkConvai\b|red4ext\/plugins\/CyberpunkConvai(?:Native)?\b|legacy-init/);
  const p = legacyPaths('G:/game');
  assert(p.oldMod.replaceAll('\\', '/').endsWith('bin/x64/plugins/cyber_engine_tweaks/mods/CyberpunkConvai'));
  assert(p.oldPlugin.replaceAll('\\', '/').endsWith('red4ext/plugins/CyberpunkConvai'));
  assert(p.newMod.replaceAll('\\', '/').endsWith(config.layout.modDirectory));
  assert(p.newPlugin.replaceAll('\\', '/').endsWith(config.layout.pluginDirectory));
  assert(p.newNative.replaceAll('\\', '/').endsWith(config.layout.nativeDirectory));
});
