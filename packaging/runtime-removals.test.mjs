// The files a Runtime update no longer ships are removed by the service at its next start (packaging/runtime/apply-removals.mjs), from the list
// every Runtime carries (app/defaults/runtime-removals.json). Everything here runs in a temporary fake game folder; nothing touches a real one.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {cp, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {shortPathOf} from '../bridge/ascii-temp.mjs';
import {ALLOWED_ROOTS, PLUGIN, PROTECTED, REMOVALS_FILE, applyRuntimeRemovals, installRootOf, readRemovalList, refusalFor} from './runtime/apply-removals.mjs';
import {DECLARED_REMOVALS, REMOVALS_ENTRY, checkRemovals, removalListText} from './lib/runtime-removals.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const APP = `${PLUGIN}/app`;
const MOD = 'bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod';
const LAUNCHER_FILES = ['start-service.mjs', 'prepare-state.mjs', 'assemble-parts.mjs', 'migrate-legacy.mjs', 'place-packs.mjs', 'state-home.mjs', 'usvfs-compat.mjs', 'apply-removals.mjs'];
const put = async (path, text = 'x') => { await mkdir(dirname(path), {recursive: true}); await writeFile(path, text); };
const exists = path => stat(path).then(() => true, () => false);
const lines = () => { const list = []; Object.defineProperty(list, 'log', {value: message => list.push(message)}); return list; };
async function tree(path, rel = '') {
  const out = [];
  for (const entry of (await readdir(path, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await tree(join(path, entry.name), name)); else out.push(name);
  }
  return out;
}

// A Runtime in `root` (the game folder, or an MO2 mod folder): some files to keep and some to remove, and a list that names the second kind.
async function runtime(root, removes, {version = '0.2.3'} = {}) {
  const app = join(root, APP);
  for (const rel of ['voices/keep/a.wav', 'voices/old/b.wav', 'voices/old/deeper/c.wav', 'app/bridge/old-module.mjs', 'app/bridge/convai-bridge.mjs', 'launcher.ini', 'launcher.log',
    'app/omni/model/weights.bin', 'app/local-ai/models/chat.gguf', 'app/release.json']) await put(join(root, PLUGIN, rel), rel);
  await put(join(root, 'archive/pc/mod/convai_old.archive'), 'a');
  await put(join(root, 'archive/pc/mod/another_mod.archive'), 'b');
  await put(join(root, 'r6/audioware/CyberpunkConvai/reply-9.wav'), 'w');
  await put(join(app, REMOVALS_FILE), JSON.stringify({version, removes}));
  return app;
}

test('a path is removable only as a relative forward-slash file under a folder a Runtime installs into, and never a protected one', () => {
  const ok = [`${PLUGIN}/voices/old/b.wav`, `${PLUGIN}/app/bridge/x.mjs`, 'red4ext/plugins/AiNpcCyberpunkModNative/README.txt', 'r6/audioware/CyberpunkConvai/reply-9.wav',
    'archive/pc/mod/convai_facial.archive', 'archive/pc/mod/cyberpunk_convai_ambient_driver_guard.archive', `${PLUGIN.toUpperCase()}/voices/a.wav`];
  for (const path of ok) assert.equal(refusalFor(path), null, path);
  const refused = {
    '../x.txt': /outside|\.\./, [`${PLUGIN}/../../x`]: /\.\./, [`${PLUGIN}/./a`]: /\.\./, [`${PLUGIN}//a`]: /\.\./,
    '/etc/passwd': /relative/, 'C:/Windows/x.dll': /relative/, 'C:\\Windows\\x.dll': /relative/, '\\\\server\\share\\x': /relative/,
    [`${PLUGIN}\\voices\\a.wav`]: /relative/, [`${PLUGIN}/voices/a.wav:stream`]: /relative/, [`${PLUGIN}/a\u0000.wav`]: /relative/,
    [`${PLUGIN}/voices/`]: /empty/, [`${PLUGIN}/voices/a.wav.`]: /empty/,
    'bin/x64/Cyberpunk2077.exe': /outside/, [`${MOD}/runtime/settings.json`]: /outside/, [`${MOD}/init.lua`]: /outside/, 'archive/pc/mod/another_mod.archive': /our file names/,
    'archive/pc/mod/sub/convai_x.archive': /our file names/, 'red4ext/plugins/OtherMod/x.dll': /outside/, 'r6/scripts/x.reds': /outside/,
    [`${PLUGIN}/launcher.ini`]: /protected/, [`${PLUGIN}/launcher.log`]: /protected/, [`${PLUGIN}/browser.txt`]: /protected/, [`${APP}/release.json`]: /protected/, [`${APP}/${REMOVALS_FILE}`]: /protected/,
    [`${APP}/omni/model/weights.bin`]: /protected/, [`${APP}/local-ai/models/chat.gguf`]: /protected/, [`${PLUGIN}/data/memories.json`]: /protected/,
  };
  for (const bad of ['', 5, null, undefined, {}]) assert.match(refusalFor(bad), /not a path/);
  for (const [path, why] of Object.entries(refused)) assert.match(refusalFor(path), why, path);
  assert.ok(ALLOWED_ROOTS.length && PROTECTED.length);
});

test('the install folder comes from where app/ is, and only a standard Runtime folder has one', () => {
  const root = join(tmpdir(), 'Modlists', 'mods', 'AI NPC Runtime');
  assert.equal(installRootOf(join(root, APP)), root);
  assert.equal(installRootOf(join(root, APP.toUpperCase())), root);
  assert.equal(installRootOf(join(tmpdir(), 'somewhere', 'app')), null);
  assert.equal(installRootOf(join(root, PLUGIN)), null);
});

test('removes the listed files, empties the folders they leave, keeps everything else, and is the same the second time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime removals Ünï '));
  try {
    const removes = [`${PLUGIN}/voices/old/b.wav`, `${PLUGIN}/voices/old/deeper/c.wav`, `${APP}/bridge/old-module.mjs`, 'archive/pc/mod/convai_old.archive',
      'r6/audioware/CyberpunkConvai/reply-9.wav', `${PLUGIN}/voices/never-existed.wav`];
    const app = await runtime(root, removes);
    const log = lines();
    const result = applyRuntimeRemovals({appDirectory: app, log: log.log});
    assert.deepEqual([result.state, result.version, result.removed, result.absent, result.refused, result.failed, result.left], ['done', '0.2.3', 5, 1, 0, 0, 0]);
    assert.equal(log.length, 1, 'one line per run');
    assert.match(log[0], /^Runtime removal list 0\.2\.3: 6 listed, 5 removed, 1 already gone\.$/);
    assert.deepEqual(await tree(root), [
      'archive/pc/mod/another_mod.archive',
      `${APP}/bridge/convai-bridge.mjs`, `${APP}/defaults/runtime-removals.json`, `${APP}/local-ai/models/chat.gguf`, `${APP}/omni/model/weights.bin`, `${APP}/release.json`,
      `${PLUGIN}/launcher.ini`, `${PLUGIN}/launcher.log`, `${PLUGIN}/voices/keep/a.wav`].sort());
    assert.equal(await exists(join(root, PLUGIN, 'voices/old')), false, 'the folders the removals emptied are gone');
    assert.equal(await exists(join(root, PLUGIN, 'voices')), true);
    assert.equal(await exists(join(root, 'archive/pc/mod')), true, 'a folder outside the plugin folder is never removed');
    const again = lines();
    const second = applyRuntimeRemovals({appDirectory: app, log: again.log});
    assert.deepEqual([second.state, second.removed, second.absent], ['done', 0, 6]);
    assert.match(again[0], /6 listed, 0 removed, 6 already gone\.$/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('a missing list does nothing and says nothing; an unreadable one is logged and removes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime removals '));
  try {
    const app = await runtime(root, []);
    const before = await tree(root);
    await rm(join(app, REMOVALS_FILE));
    const quiet = lines();
    assert.equal(applyRuntimeRemovals({appDirectory: app, log: quiet.log}).state, 'no-list');
    assert.deepEqual(quiet, []);
    assert.equal(readRemovalList(join(app, REMOVALS_FILE)), null);
    for (const [text, why] of [['{not json', /could not be read/], ['{"version":"1"}', /no "removes" list/], ['[]', /no "removes" list/], ['null', /no "removes" list/]]) {
      await put(join(app, REMOVALS_FILE), text);
      const log = lines();
      assert.equal(applyRuntimeRemovals({appDirectory: app, log: log.log}).state, 'bad-list');
      assert.match(log[0], why);
    }
    await rm(join(app, REMOVALS_FILE));
    assert.deepEqual(await tree(root), before.filter(name => !name.endsWith(REMOVALS_FILE)));
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('a list with a byte order mark and a version-less list work; entries that are not strings are refused, never fatal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime removals '));
  try {
    const app = await runtime(root, []);
    await put(join(app, REMOVALS_FILE), `\uFEFF${JSON.stringify({removes: [`${PLUGIN}/voices/old/b.wav`, 5, null, {}, ['x']]})}`);
    const result = applyRuntimeRemovals({appDirectory: app, log: () => {}});
    assert.deepEqual([result.state, result.version, result.removed, result.refused], ['done', null, 1, 4]);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('paths that escape, point outside the Runtime, or are protected are refused and counted; the files stay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime removals '));
  const outside = await mkdtemp(join(tmpdir(), 'runtime removals outside '));
  try {
    const removes = ['../outside.txt', `${PLUGIN}/../../../escape.txt`, '/etc/hosts', 'C:\\Windows\\win.ini', `${MOD}/init.lua`, 'bin/x64/Cyberpunk2077.exe',
      `${PLUGIN}/launcher.ini`, `${PLUGIN}/launcher.log`, `${APP}/omni/model/weights.bin`, `${APP}/local-ai/models/chat.gguf`, `${APP}/release.json`,
      `${PLUGIN}/voices/old`, 'archive/pc/mod/another_mod.archive'];
    const app = await runtime(root, removes);
    await put(join(root, 'bin/x64/Cyberpunk2077.exe'), 'exe');
    await put(join(root, MOD, 'init.lua'), 'lua');
    const before = await tree(root);
    const log = lines();
    const result = applyRuntimeRemovals({appDirectory: app, log: log.log});
    assert.deepEqual([result.removed, result.refused, result.failed], [0, removes.length, 0]);
    assert.deepEqual(await tree(root), before);
    assert.match(log[0], /refused \(/);
    // A link inside the plugin folder that leads outside must not be followed.
    await put(join(outside, 'precious.wav'), 'precious');
    await symlink(outside, join(root, PLUGIN, 'voices/linked'), 'junction');
    const linked = applyRuntimeRemovals({appDirectory: await runtime(root, [`${PLUGIN}/voices/linked/precious.wav`]), log: () => {}});
    assert.deepEqual([linked.removed, linked.refused], [0, 1]);
    assert.equal(await readFile(join(outside, 'precious.wav'), 'utf8'), 'precious');
  } finally {
    await rmdir(join(root, PLUGIN, 'voices/linked')).catch(() => {}); // a junction: removes the link, never what it points at
    await rm(root, {recursive: true, force: true}); await rm(outside, {recursive: true, force: true});
  }
});

test('a short 8.3 spelling or an alias of a protected path is refused: the real name of the file decides, not the text of the list', async () => {
  // The text of a path: a part that looks like a short name is refused before anything is looked at.
  for (const short of [`${PLUGIN}/voices/MULTIL~1/de/x.bin`, `${PLUGIN}/app/RELEAS~1.JSO`, `${PLUGIN}/voices/multilingual-pocket/ABCDEF~2.bin`, `${PLUGIN}/app/OMNI~1/m.bin`, `${PLUGIN}/LAUNCH~1.INI`]) {
    assert.match(refusalFor(short), /8\.3 short name/, short);
  }
  assert.equal(refusalFor(`${PLUGIN}/voices/old/clip~backup.wav`), null, 'a tilde that is not followed by a digit is an ordinary name');

  const root = await mkdtemp(join(tmpdir(), 'runtime removals real '));
  try {
    const app = await runtime(root, []);
    await put(join(root, PLUGIN, 'voices/multilingual/de/voice.bin'), 'language pack');
    await put(join(root, PLUGIN, 'voices/multilingual-pocket/fr/model.bin'), 'pocket model');
    // 1. The resolver reports another name for what a list names (an 8.3 short name: voices/ALIAS/... is voices/multilingual/...): the real name is protected.
    const names = new Map([[join(root, PLUGIN, 'voices/ALIAS/de'), join(root, PLUGIN, 'voices/multilingual/de')],
      [join(root, PLUGIN, 'voices/ALIAS/de/voice.bin'), join(root, PLUGIN, 'voices/multilingual/de/voice.bin')],
      [join(root, PLUGIN, 'app/SHORT.JSO'), join(root, PLUGIN, 'app/release.json')]]);
    const realpath = path => names.get(path) ?? realpathSync.native(path);
    await mkdir(join(root, PLUGIN, 'voices/ALIAS/de'), {recursive: true});
    await put(join(root, PLUGIN, 'voices/ALIAS/de/voice.bin'), 'a different file that only has that spelling here');
    await put(join(root, PLUGIN, 'app/SHORT.JSO'), 'x');
    const faked = applyRuntimeRemovals({appDirectory: await runtime(root, [`${PLUGIN}/voices/ALIAS/de/voice.bin`, `${PLUGIN}/app/SHORT.JSO`]), log: () => {}, realpath});
    assert.deepEqual([faked.removed, faked.refused], [0, 2]);
    assert.equal(await readFile(join(root, PLUGIN, 'voices/multilingual/de/voice.bin'), 'utf8'), 'language pack');
    assert.equal(await readFile(join(root, PLUGIN, 'app/release.json'), 'utf8'), 'app/release.json');
    // 2. A real alias: a junction inside the Runtime's folder that leads to a protected folder. Its text passes every check, its real path does not.
    await symlink(join(root, PLUGIN, 'voices/multilingual'), join(root, PLUGIN, 'voices/jct'), 'junction');
    const through = applyRuntimeRemovals({appDirectory: await runtime(root, [`${PLUGIN}/voices/jct/de/voice.bin`, `${PLUGIN}/voices/old/b.wav`]), log: () => {}});
    assert.deepEqual([through.removed, through.refused], [1, 1], 'the ordinary file went, the protected one behind the alias stayed');
    assert.equal(await readFile(join(root, PLUGIN, 'voices/multilingual/de/voice.bin'), 'utf8'), 'language pack');
    // 3. The real 8.3 name of a protected folder, where this volume makes one (some have them switched off): the file stays.
    const short = shortPathOf(join(root, PLUGIN, 'voices/multilingual-pocket'));
    if (short && /~\d/.test(short)) {
      const part = short.split(/[\\/]/).at(-1);
      const viaShort = applyRuntimeRemovals({appDirectory: await runtime(root, [`${PLUGIN}/voices/${part}/fr/model.bin`]), log: () => {}});
      assert.deepEqual([viaShort.removed, viaShort.refused], [0, 1]);
      assert.equal(await readFile(join(root, PLUGIN, 'voices/multilingual-pocket/fr/model.bin'), 'utf8'), 'pocket model');
    }
  } finally {
    await rmdir(join(root, PLUGIN, 'voices/jct')).catch(() => {}); // a junction: removes the link, never what it points at
    await rm(root, {recursive: true, force: true});
  }
});

test('Mod Organizer 2: the Runtime is a mod folder, so the delete happens there and the game folder is never touched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime removals mo2 '));
  try {
    const game = join(root, 'Games', 'Cyberpunk 2077');
    const mod = join(root, 'Modlists', 'Ultraviolence', 'mods', 'AI NPC Cyberpunk Mod Runtime');
    const other = join(root, 'Modlists', 'Ultraviolence', 'mods', 'Another Mod Holding The Same Path');
    const removes = [`${PLUGIN}/voices/old/b.wav`, `${PLUGIN}/voices/in-another-mod.wav`, 'archive/pc/mod/convai_old.archive'];
    const app = await runtime(mod, removes);
    // A file with the same name in the game folder, and in another mod: neither is the Runtime's own.
    await put(join(game, PLUGIN, 'voices/old/b.wav'), 'game copy');
    await put(join(other, PLUGIN, 'voices/in-another-mod.wav'), 'other mod');
    await put(join(game, MOD, 'init.lua'), 'lua');
    const gameBefore = await tree(game), otherBefore = await tree(other);
    const result = applyRuntimeRemovals({appDirectory: app, log: () => {}});
    assert.deepEqual([result.state, result.root, result.removed, result.absent], ['done', mod, 2, 1]);
    assert.equal(await exists(join(mod, PLUGIN, 'voices/old/b.wav')), false);
    assert.equal(await exists(join(mod, 'archive/pc/mod/convai_old.archive')), false, 'files outside the plugin folder are in the same mod folder');
    assert.deepEqual(await tree(game), gameBefore);
    assert.deepEqual(await tree(other), otherBefore);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('it never holds the start: past its time budget the rest waits for the next start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime removals '));
  try {
    const names = Array.from({length: 40}, (_, index) => `${PLUGIN}/voices/many/${index}.wav`);
    const app = await runtime(root, names);
    for (const name of names) await put(join(root, name));
    let clock = 0;
    const log = lines();
    const result = applyRuntimeRemovals({appDirectory: app, log: log.log, budgetMs: 100, now: () => (clock += 10)});
    assert.equal(result.state, 'partial');
    assert.ok(result.removed > 0 && result.removed < 40 && result.left === 40 - result.removed - result.absent, JSON.stringify(result));
    assert.match(log[0], /left for the next start\.$/);
    const finished = applyRuntimeRemovals({appDirectory: app, budgetMs: 1e9});
    assert.deepEqual([finished.state, finished.removed + result.removed], ['done', 40]);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('the build side: the list text is sorted and stable, and a list may not name what the Runtime ships or what the start step may not delete', () => {
  assert.equal(removalListText('0.2.3', ['b', 'a', 'b']), '{\n "version": "0.2.3",\n "removes": [\n  "a",\n  "b"\n ]\n}\n');
  assert.equal(REMOVALS_ENTRY, `${APP}/${REMOVALS_FILE}`);
  const checked = checkRemovals([`${PLUGIN}/voices/old.wav`, `${PLUGIN}/Voices/OLD.wav`, `${PLUGIN}/voices/new.wav`, 'bin/x64/Cyberpunk2077.exe', `${PLUGIN}/launcher.ini`],
    new Set([`${PLUGIN}/voices/NEW.wav`]));
  assert.deepEqual(checked.ok, [`${PLUGIN}/voices/old.wav`]);
  assert.deepEqual(checked.refused.map(item => item.why), ['the new Runtime ships it', 'outside the folders a Runtime installs into', 'protected']);
});

test('the declared removals file is valid and every path in it is one the start step may delete', async () => {
  const declared = JSON.parse(await readFile(resolve(project, DECLARED_REMOVALS), 'utf8'));
  assert.ok(Array.isArray(declared.removes));
  assert.deepEqual(checkRemovals(declared.removes).refused, []);
});

test('the Runtime build ships the removal step and the list; the start script runs the step inside its own guard', async () => {
  const build = await readFile(resolve(project, 'packaging/build-release.mjs'), 'utf8');
  assert.match(build, /'usvfs-compat\.mjs', 'apply-removals\.mjs'\]\) pkg\.file\(`\$\{app\}\/launcher\//);
  assert.match(build, /pkg\.text\(REMOVALS_ENTRY, removalListText\(version, checked\.ok\)\)/);
  const start = await readFile(resolve(project, 'packaging/runtime/start-service.mjs'), 'utf8');
  assert.match(start, /try \{\r?\n  const \{applyRuntimeRemovals\} = await import\('\.\/apply-removals\.mjs'\);\r?\n  removals = applyRuntimeRemovals\(\{appDirectory, log\}\);\r?\n\} catch/);
});

// ---------------------------------------------------------------- the start script
async function installation({withStep = true} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'runtime removals start '));
  const game = join(root, 'Games', 'Cyberpunk 2077'), mod = join(root, 'mods', 'AI NPC Cyberpunk Mod Runtime');
  const app = join(mod, APP);
  await mkdir(join(app, 'launcher'), {recursive: true});
  for (const name of LAUNCHER_FILES) if (withStep || name !== 'apply-removals.mjs') await cp(join(project, 'packaging/runtime', name), join(app, 'launcher', name));
  await put(join(app, 'defaults/pocket-voices.autobest.json'), JSON.stringify({version: 1, provider: 'pocket', engine: 'pocket-tts', runtime: {}, voices: {}}));
  await put(join(app, 'defaults/characters.json'), '{"v":2}');
  await put(join(app, 'defaults/multilingual-profiles.json'), '{"v":2}');
  await put(join(app, 'models/lipsync/face-model.json'), '{}');
  await put(join(game, 'bin/x64/Cyberpunk2077.exe'), 'exe');
  await put(join(game, MOD, 'init.lua'), '-- the CET mod');
  const home = join(root, 'LocalAppData', 'AiNpcCyberpunkMod');
  return {root, game, mod, app, home, state: join(home, 'data'), env: {...process.env, CYBERPUNK_CONVAI_DATA_HOME: home}};
}
const prepare = f => {
  const result = spawnSync(process.execPath, [join(f.app, 'launcher/start-service.mjs'), '--game-root', f.game, '--prepare-only'], {encoding: 'utf8', timeout: 60_000, env: f.env});
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').pop());
};

test('the start removes what the list names, logs one line, and reports it; a second start removes nothing more', async () => {
  const f = await installation();
  try {
    await put(join(f.mod, PLUGIN, 'voices/old/b.wav'), 'old');
    await put(join(f.mod, PLUGIN, 'voices/keep.wav'), 'keep');
    await put(join(f.app, REMOVALS_FILE), JSON.stringify({version: '0.2.3', removes: [`${PLUGIN}/voices/old/b.wav`]}));
    const first = prepare(f);
    assert.deepEqual(first.removals, {state: 'done', version: '0.2.3', removed: 1, absent: 0, refused: 0, failed: 0, left: 0});
    assert.equal(await exists(join(f.mod, PLUGIN, 'voices/old')), false);
    assert.equal(await exists(join(f.mod, PLUGIN, 'voices/keep.wav')), true);
    const second = prepare(f);
    assert.deepEqual([second.removals.removed, second.removals.absent], [0, 1]);
    const log = (await readFile(join(f.state, 'bridge-service.log'), 'utf8')).split('\n').filter(line => /Runtime removal list/.test(line));
    assert.equal(log.length, 2, 'one line per start');
    assert.match(log[0], /Runtime removal list 0\.2\.3: 1 listed, 1 removed, 0 already gone\./);
    assert.equal(await exists(join(f.game, PLUGIN)), false, 'nothing is made in the game folder for a Runtime that lives in a mod folder');
  } finally { await rm(f.root, {recursive: true, force: true}); }
});

test('the start without a list reports no removals, and a Runtime missing the step still starts', async () => {
  const f = await installation();
  try {
    assert.equal(prepare(f).removals.state, 'no-list');
  } finally { await rm(f.root, {recursive: true, force: true}); }
  const partial = await installation({withStep: false});
  try {
    await put(join(partial.mod, PLUGIN, 'voices/old/b.wav'), 'old');
    await put(join(partial.app, REMOVALS_FILE), JSON.stringify({version: '0.2.3', removes: [`${PLUGIN}/voices/old/b.wav`]}));
    const summary = prepare(partial);
    assert.equal(summary.ok, true);
    assert.equal(summary.removals, null);
    assert.equal(await exists(join(partial.mod, PLUGIN, 'voices/old/b.wav')), true);
    assert.match(await readFile(join(partial.state, 'bridge-service.log'), 'utf8'), /Removing the files an update no longer ships failed/);
  } finally { await rm(partial.root, {recursive: true, force: true}); }
});

// ---------------------------------------------------------------- the player's browser.txt
// browser.txt in the plugin folder beside launcher.ini names the browser program; the start feeds it to the same setting as a developer's
// CYBERPUNK_CONVAI_BROWSER, an update never removes it, and a file that names nothing usable only says so in the log.
test('the start reads browser.txt, ignores one that names nothing usable, and a developer variable wins', async () => {
  const f = await installation();
  try {
    await put(join(f.app, 'bridge/system-browser.mjs'), await readFile(resolve(project, 'bridge/system-browser.mjs'), 'utf8'));
    const brave = join(f.root, 'Odd Folder', 'Brave', 'brave.exe');
    await put(brave, 'exe');
    delete f.env.CYBERPUNK_CONVAI_BROWSER;
    const lines = async () => (await readFile(join(f.state, 'bridge-service.log'), 'utf8')).split('\n').filter(line => /browser/i.test(line));
    assert.equal(prepare(f).browser, null, 'no file: nothing is set');
    await put(join(f.mod, PLUGIN, 'browser.txt'), `; the browser the conversation page uses\r\n"${brave}"\r\n`);
    assert.equal(prepare(f).browser, brave);
    assert.match((await lines()).pop(), /Browser from browser\.txt: /);
    await put(join(f.mod, PLUGIN, 'browser.txt'), join(f.root, 'Odd Folder', 'Brave'));
    assert.equal(prepare(f).browser, brave, 'the browser folder works too');
    await put(join(f.mod, PLUGIN, 'browser.txt'), join(f.root, 'gone', 'brave.exe'));
    assert.equal(prepare(f).browser, null);
    const last = (await lines()).pop();
    assert.match(last, /brave\.exe, which is not there\. Looking for a browser the usual way instead\./);
    assert.ok(!last.includes('gone'), 'the log names the file, not its folder');
    await put(join(f.mod, PLUGIN, 'browser.txt'), brave);
    const developer = join(f.root, 'dev', 'edge.exe');
    assert.equal(prepare({...f, env: {...f.env, CYBERPUNK_CONVAI_BROWSER: developer}}).browser, developer);
    assert.match((await lines()).pop(), /browser\.txt is not used: CYBERPUNK_CONVAI_BROWSER is set\./);
    // A Runtime without the lookup's file still starts, and the player's file stays.
    await rm(join(f.app, 'bridge'), {recursive: true, force: true});
    assert.equal(prepare(f).ok, true);
    assert.equal(await exists(join(f.mod, PLUGIN, 'browser.txt')), true);
  } finally { await rm(f.root, {recursive: true, force: true}); }
});
