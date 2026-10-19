// Start-up auto-fix for optional pack files extracted one folder too deep (packaging/runtime/place-packs.mjs).
// Everything runs in a temporary fake game folder with small fake files; nothing touches a real installation.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import * as realFs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installLayout} from './runtime/prepare-state.mjs';
import {PLACEMENT_FILE, findCandidates, placeMisplacedPacks, recordPlacement} from './runtime/place-packs.mjs';
import {readPackPlacement} from '../bridge/setup-check.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PLUGIN = 'red4ext/plugins/AiNpcCyberpunkMod';
const APP = `${PLUGIN}/app`;
const exists = async path => { try { await stat(path); return true; } catch { return false; } };
const put = async (path, text) => { await mkdir(dirname(path), {recursive: true}); await writeFile(path, text); };
const read = path => readFile(path, 'utf8');

async function fakeGame() {
  const root = await mkdtemp(join(tmpdir(), 'ai npc place packs '));
  const game = join(root, 'Cyberpunk 2077 Ünïcode');
  await put(join(game, 'bin/x64/Cyberpunk2077.exe'), 'exe');
  await put(join(game, `${APP}/launcher/start-service.mjs`), '// the real launcher');
  await put(join(game, `${APP}/bridge/convai-bridge.mjs`), '// the real bridge');
  await put(join(game, `${PLUGIN}/voices/placeholder.txt`), 'v');
  for (const name of ['archive/pc/mod', 'engine/config', 'r6/scripts', 'tools/redmod']) await put(join(game, name, 'keep.txt'), 'game');
  const layout = installLayout({appDirectory: join(game, APP), gameRoot: game});
  return {root, game, layout, cleanup: () => rm(root, {recursive: true, force: true})};
}

// A Local AI standard pack under `base` (a folder that stands where the game root should be).
async function standardPack(base, {model = 'MODEL-BYTES-standard'} = {}) {
  const app = join(base, APP);
  await put(join(app, 'local-ai/manifest.standard.json'), '{"version":1,"standard":{"file":"models/chat.gguf"}}');
  await put(join(app, 'local-ai/llama/llama-server.exe'), 'server');
  await put(join(app, 'local-ai/models/chat.gguf'), model);
  await put(join(app, 'local-ai/models/embed.gguf'), 'embedding');
  await put(join(app, 'local-ai/licenses/Apache-2.0.txt'), 'licence');
  await put(join(app, 'local-ai/local-ai-standard.json'), '{}');
}
async function omniPack(base) {
  const root = join(base, PLUGIN);
  await put(join(root, 'app/omni/omni-pack.json'), '{"package":"omni"}');
  await put(join(root, 'app/omni/python/python.exe'), 'python');
  await put(join(root, 'app/omni/model/model.safetensors'), 'weights');
  for (const name of ['short', 'long']) await put(join(root, `app/omni/defaults/local-voices.autobest-${name}.json`), '{"version":1}');
  await put(join(root, 'voices/prepared/judy.mp3'), 'clip');
  await put(join(root, 'voices/judy.wav'), 'wav');
}
const lines = () => { const list = []; Object.defineProperty(list, 'log', {value: message => list.push(message)}); return list; };

async function tree(path, rel = '') {
  const out = [];
  for (const entry of (await readdir(path, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await tree(join(path, entry.name), name)); else out.push(name);
  }
  return out;
}

test('a pack extracted into a wrapper folder named after the zip is moved into place', async () => {
  const f = await fakeGame();
  try {
    const wrapper = join(f.game, 'AI-NPC-Cyberpunk-Mod-LocalAI-Standard-0.2');
    await standardPack(wrapper);
    const log = lines();
    const report = await placeMisplacedPacks({layout: f.layout, log: log.log});
    assert.deepEqual(log, ['Moved the Local AI standard files into place from AI-NPC-Cyberpunk-Mod-LocalAI-Standard-0.2']);
    assert.deepEqual(report.fixed, [{pack: 'Local AI standard', from: 'AI-NPC-Cyberpunk-Mod-LocalAI-Standard-0.2'}]);
    const real = join(f.game, APP, 'local-ai');
    assert.equal(await read(join(real, 'models/chat.gguf')), 'MODEL-BYTES-standard');
    assert.equal(await read(join(real, 'llama/llama-server.exe')), 'server');
    assert.match(await read(join(real, 'manifest.standard.json')), /standard/);
    assert.equal(await exists(wrapper), false, 'the empty wrapper folders are removed');
    // The real launcher is untouched.
    assert.equal(await read(join(f.game, APP, 'launcher/start-service.mjs')), '// the real launcher');
    // Run again: nothing to fix, nothing logged.
    const again = lines();
    assert.deepEqual((await placeMisplacedPacks({layout: f.layout, log: again.log})).fixed, []);
    assert.deepEqual(again, []);
  } finally { await f.cleanup(); }
});

test('wrapper depth 2 (X/X/red4ext/...) is handled and both wrapper levels removed', async () => {
  const f = await fakeGame();
  try {
    await standardPack(join(f.game, 'Pack', 'Pack'));
    const log = lines();
    await placeMisplacedPacks({layout: f.layout, log: log.log});
    assert.deepEqual(log, [`Moved the Local AI standard files into place from ${join('Pack', 'Pack')}`]);
    assert.equal(await read(join(f.game, APP, 'local-ai/models/chat.gguf')), 'MODEL-BYTES-standard');
    assert.equal(await exists(join(f.game, 'Pack')), false);
  } finally { await f.cleanup(); }
});

test('wrapper depth 3 and deeper is not searched', async () => {
  const f = await fakeGame();
  try {
    await standardPack(join(f.game, 'A', 'B', 'C'));
    const log = lines();
    await placeMisplacedPacks({layout: f.layout, log: log.log});
    assert.deepEqual(log, []);
    assert.equal(await exists(join(f.game, 'A/B/C', APP, 'local-ai/manifest.standard.json')), true);
  } finally { await f.cleanup(); }
});

test('the other pack kinds are recognised: Local AI lite, Mature lite and standard, one line per pack', async () => {
  const f = await fakeGame();
  try {
    const wrapper = join(f.game, 'Both');
    const app = join(wrapper, APP);
    await put(join(app, 'local-ai/manifest.lite.json'), '{"lite":1}');
    await put(join(app, 'local-ai/models/lite.gguf'), 'lite');
    await put(join(app, 'local-ai/manifest.mature-lite.json'), '{"pack":"mature"}');
    await put(join(app, 'local-ai/manifest.mature-standard.json'), '{"pack":"mature"}');
    await put(join(app, 'local-ai/mature/README.md'), 'readme');
    await put(join(app, 'local-ai/models/mature.gguf'), 'mature');
    const log = lines();
    await placeMisplacedPacks({layout: f.layout, log: log.log});
    assert.deepEqual([...log].sort(), ['Mature lite', 'Mature standard', 'Local AI lite'].map(name => `Moved the ${name} files into place from Both`).sort());
    assert.deepEqual(await tree(join(f.game, APP, 'local-ai')), ['manifest.lite.json', 'manifest.mature-lite.json', 'manifest.mature-standard.json',
      'mature/README.md', 'models/lite.gguf', 'models/mature.gguf']);
    assert.equal(await exists(wrapper), false);
  } finally { await f.cleanup(); }
});

test('the OmniVoice pack moves app/omni and its voices folder', async () => {
  const f = await fakeGame();
  try {
    await omniPack(join(f.game, 'Omni'));
    // A reference clip the Runtime package already ships, byte for byte.
    await put(join(f.game, PLUGIN, 'voices/judy.wav'), 'wav');
    const log = lines();
    await placeMisplacedPacks({layout: f.layout, log: log.log});
    assert.deepEqual(log, ['Moved the OmniVoice files into place from Omni']);
    assert.deepEqual(await tree(join(f.game, APP, 'omni')), ['defaults/local-voices.autobest-long.json', 'defaults/local-voices.autobest-short.json', 'model/model.safetensors', 'omni-pack.json', 'python/python.exe']);
    assert.equal(await read(join(f.game, PLUGIN, 'voices/prepared/judy.mp3')), 'clip');
    assert.equal(await read(join(f.game, PLUGIN, 'voices/placeholder.txt')), 'v');
    assert.equal(await exists(join(f.game, 'Omni')), false);
  } finally { await f.cleanup(); }
});

test('a file already in place with the same size is kept and the stray copy dropped', async () => {
  const f = await fakeGame();
  try {
    await put(join(f.game, APP, 'local-ai/models/embed.gguf'), 'EMBEDDING'); // same size as 'embedding', other bytes
    await standardPack(join(f.game, 'W'));
    const log = lines();
    await placeMisplacedPacks({layout: f.layout, log: log.log});
    assert.deepEqual(log, ['Moved the Local AI standard files into place from W']);
    assert.equal(await read(join(f.game, APP, 'local-ai/models/embed.gguf')), 'EMBEDDING', 'the file in place is not overwritten');
    assert.equal(await exists(join(f.game, 'W')), false, 'nothing is left behind once the stray copy is dropped');
    assert.equal(await read(join(f.game, APP, 'local-ai/models/chat.gguf')), 'MODEL-BYTES-standard');
  } finally { await f.cleanup(); }
});

test('a file in place with a different size is never overwritten and the stray copy stays', async () => {
  const f = await fakeGame();
  try {
    await put(join(f.game, APP, 'local-ai/models/chat.gguf'), 'NEWER-AND-LONGER-MODEL-FILE-IN-PLACE');
    await standardPack(join(f.game, 'W'));
    const log = lines();
    await placeMisplacedPacks({layout: f.layout, log: log.log});
    assert.equal(await read(join(f.game, APP, 'local-ai/models/chat.gguf')), 'NEWER-AND-LONGER-MODEL-FILE-IN-PLACE');
    assert.equal(await read(join(f.game, 'W', APP, 'local-ai/models/chat.gguf')), 'MODEL-BYTES-standard', 'the different stray copy is left for the player');
    assert.ok(log.some(line => /^Moved the Local AI standard files into place from W$/.test(line)));
    assert.ok(log.some(line => /^Left 1 file in W because a different file is already in place \(for example local-ai\/models\/chat\.gguf\)/.test(line)));
    // Everything else moved, and the wrapper remains because it is not empty.
    assert.equal(await read(join(f.game, APP, 'local-ai/llama/llama-server.exe')), 'server');
    assert.deepEqual(await tree(join(f.game, 'W')), [`${APP}/local-ai/models/chat.gguf`]);
  } finally { await f.cleanup(); }
});

test('nothing to fix: a few stat calls, no log, well under 50 ms', async () => {
  const f = await fakeGame();
  try {
    for (const name of ['mods', 'Support', 'REDprelauncher', 'localization', 'Wrapper-Without-Packs/inner', 'Notes']) await mkdir(join(f.game, name), {recursive: true});
    await put(join(f.game, 'Notes/readme.txt'), 'hi');
    const log = lines();
    await placeMisplacedPacks({layout: f.layout, log: log.log}); // warm up the file system cache
    const times = [];
    for (let i = 0; i < 15; i += 1) {
      const start = process.hrtime.bigint();
      await placeMisplacedPacks({layout: f.layout, log: log.log});
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    console.log(`place-packs no-op: median ${median.toFixed(2)} ms, max ${times.at(-1).toFixed(2)} ms`);
    assert.deepEqual(log, []);
    assert.ok(median < 50, `the no-op path took ${median} ms`);
  } finally { await f.cleanup(); }
});

test('the game folders are never searched or touched', async () => {
  const f = await fakeGame();
  try {
    // A pack-shaped tree inside folders the game owns must be left exactly where it is.
    for (const folder of ['archive', 'r6', 'engine', 'bin', 'tools', 'mods']) await standardPack(join(f.game, folder));
    await standardPack(join(f.game, 'red4ext/wrapper-like'));
    const before = await tree(f.game);
    const log = lines();
    const candidates = await findCandidates(f.layout);
    assert.deepEqual(candidates.map(item => item.base), []);
    await placeMisplacedPacks({layout: f.layout, log: log.log});
    assert.deepEqual(log, []);
    assert.deepEqual(await tree(f.game), before);
  } finally { await f.cleanup(); }
});

test('a folder that is not a pack is left alone, including a Runtime-shaped tree', async () => {
  const f = await fakeGame();
  try {
    const runtime = join(f.game, 'Runtime-0.2', APP);
    await put(join(runtime, 'launcher/start-service.mjs'), '// an older launcher');
    await put(join(runtime, 'bridge/convai-bridge.mjs'), '// an older bridge');
    await put(join(runtime, 'local-ai/readme.txt'), 'no marker here');
    await put(join(f.game, 'Mods Backup/notes.txt'), 'x');
    await put(join(f.game, 'Mods Backup/red4ext/plugins/OtherMod/app/local-ai/manifest.standard.json'), 'not ours');
    const before = await tree(f.game);
    const log = lines();
    await placeMisplacedPacks({layout: f.layout, log: log.log});
    assert.deepEqual(log, []);
    assert.deepEqual(await tree(f.game), before);
    assert.equal(await read(join(f.game, APP, 'launcher/start-service.mjs')), '// the real launcher');
  } finally { await f.cleanup(); }
});

test('a pack found beside Runtime-shaped files moves only its pack folders', async () => {
  const f = await fakeGame();
  try {
    const wrapper = join(f.game, 'Mixed');
    await standardPack(wrapper);
    await put(join(wrapper, APP, 'launcher/start-service.mjs'), '// an older launcher');
    await put(join(wrapper, 'README.txt'), 'notes');
    const log = lines();
    await placeMisplacedPacks({layout: f.layout, log: log.log});
    assert.equal(await read(join(f.game, APP, 'launcher/start-service.mjs')), '// the real launcher');
    assert.equal(await read(join(wrapper, APP, 'launcher/start-service.mjs')), '// an older launcher');
    assert.equal(await read(join(f.game, APP, 'local-ai/models/chat.gguf')), 'MODEL-BYTES-standard');
    assert.equal(await read(join(wrapper, 'README.txt')), 'notes');
  } finally { await f.cleanup(); }
});

test('related mistakes: extracted into the CET mod folder or the plugin folder', async () => {
  const f = await fakeGame();
  try {
    // red4ext/... extracted into mods/AiNpcCyberpunkMod/
    await standardPack(f.layout.mod);
    // app/omni extracted into mods/AiNpcCyberpunkMod/app/ (the app folder dragged in)
    await put(join(f.layout.mod, 'app/omni/omni-pack.json'), '{}');
    await put(join(f.layout.mod, 'app/omni/python/python.exe'), 'python');
    // red4ext/... extracted into red4ext/plugins/AiNpcCyberpunkMod/, and inside a wrapper folder of it
    await put(join(f.layout.plugin, APP, 'local-ai/manifest.lite.json'), '{}');
    await put(join(f.layout.plugin, APP, 'local-ai/models/lite.gguf'), 'lite');
    await put(join(f.layout.mod, 'init.lua'), 'return {}');
    await put(join(f.layout.mod, 'data/settings.json'), '{}');
    const wrapped = join(f.layout.plugin, 'Pack-0.2');
    await put(join(wrapped, APP, 'local-ai/manifest.mature-lite.json'), '{}');
    await put(join(wrapped, APP, 'local-ai/models/mature.gguf'), 'mature');
    const log = lines();
    await placeMisplacedPacks({layout: f.layout, log: log.log});
    assert.equal(log.length, 4, log.join('\n'));
    assert.deepEqual(await tree(join(f.game, APP, 'local-ai')), ['licenses/Apache-2.0.txt', 'llama/llama-server.exe', 'local-ai-standard.json',
      'manifest.lite.json', 'manifest.mature-lite.json', 'manifest.standard.json', 'models/chat.gguf', 'models/embed.gguf', 'models/lite.gguf', 'models/mature.gguf']);
    assert.equal(await read(join(f.game, APP, 'omni/python/python.exe')), 'python');
    // The real mod and plugin folders and what is in them stay.
    assert.equal(await read(join(f.layout.mod, 'init.lua')), 'return {}');
    assert.equal(await read(join(f.layout.mod, 'data/settings.json')), '{}');
    assert.equal(await exists(join(f.layout.mod, 'red4ext')), false);
    assert.equal(await exists(join(f.layout.mod, 'app')), false);
    assert.equal(await exists(wrapped), false);
    assert.equal(await exists(join(f.layout.plugin, 'red4ext')), false);
    assert.equal(await exists(f.layout.app), true);
    assert.equal(await exists(f.layout.plugin), true);
  } finally { await f.cleanup(); }
});

test('a rename refused by the file system stops the move, keeps the marker for a retry, and the next start finishes', async () => {
  const f = await fakeGame();
  try {
    const wrapper = join(f.game, 'W');
    await standardPack(wrapper);
    let refuse = true;
    const fs = {...realFs, async rename(from, to) {
      if (refuse && /(?:chat\.gguf|[\\/]models)$/.test(from)) throw Object.assign(new Error('EPERM: operation not permitted'), {code: 'EPERM'});
      return realFs.rename(from, to);
    }};
    const log = lines();
    const report = await placeMisplacedPacks({layout: f.layout, log: log.log, fs});
    assert.equal(report.fixed.length, 0);
    assert.equal(log.length, 1);
    assert.match(log[0], /^Could not finish moving the Local AI standard files into place from W: .*EPERM.*left where they are/);
    // The marker was not moved, so the pack is not seen half-placed and the next start retries.
    assert.equal(await exists(join(f.game, APP, 'local-ai/manifest.standard.json')), false);
    assert.equal(await exists(join(wrapper, APP, 'local-ai/manifest.standard.json')), true);
    assert.equal(await read(join(wrapper, APP, 'local-ai/models/chat.gguf')), 'MODEL-BYTES-standard');
    refuse = false;
    const next = lines();
    await placeMisplacedPacks({layout: f.layout, log: next.log, fs});
    assert.deepEqual(next, ['Moved the Local AI standard files into place from W']);
    assert.equal(await read(join(f.game, APP, 'local-ai/models/chat.gguf')), 'MODEL-BYTES-standard');
    assert.equal(await exists(wrapper), false);
  } finally { await f.cleanup(); }
});

test('across volumes (EXDEV) files are copied, verified by size, then deleted', async () => {
  const f = await fakeGame();
  try {
    const wrapper = join(f.game, 'W');
    await standardPack(wrapper);
    await omniPack(wrapper);
    const copies = [];
    const fs = {...realFs,
      async rename(from, to) {
        if (from.startsWith(wrapper)) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), {code: 'EXDEV'});
        return realFs.rename(from, to);
      },
      async copyFile(from, to, mode) { copies.push(to); return realFs.copyFile(from, to, mode); }};
    const log = lines();
    await placeMisplacedPacks({layout: f.layout, log: log.log, fs});
    assert.deepEqual([...log].sort(), ['Moved the Local AI standard files into place from W', 'Moved the OmniVoice files into place from W']);
    assert.ok(copies.length >= 9, `${copies.length} copies`);
    assert.equal(await read(join(f.game, APP, 'local-ai/models/chat.gguf')), 'MODEL-BYTES-standard');
    assert.equal(await read(join(f.game, APP, 'omni/model/model.safetensors')), 'weights');
    assert.equal(await read(join(f.game, PLUGIN, 'voices/prepared/judy.mp3')), 'clip');
    assert.equal(await exists(wrapper), false);
  } finally { await f.cleanup(); }
});

test('a copy with the wrong size is removed and the source stays', async () => {
  const f = await fakeGame();
  try {
    const wrapper = join(f.game, 'W');
    await standardPack(wrapper);
    const fs = {...realFs,
      async rename(from, to) { if (from.startsWith(wrapper)) throw Object.assign(new Error('EXDEV'), {code: 'EXDEV'}); return realFs.rename(from, to); },
      async copyFile(from, to, mode) { await realFs.copyFile(from, to, mode); if (/chat\.gguf$/.test(to)) await writeFile(to, 'short'); }};
    const log = lines();
    await placeMisplacedPacks({layout: f.layout, log: log.log, fs});
    assert.match(log[0], /^Could not finish moving/);
    assert.equal(await exists(join(f.game, APP, 'local-ai/models/chat.gguf')), false, 'the bad copy is deleted');
    assert.equal(await read(join(wrapper, APP, 'local-ai/models/chat.gguf')), 'MODEL-BYTES-standard');
    assert.equal(await exists(join(f.game, APP, 'local-ai/manifest.standard.json')), false);
  } finally { await f.cleanup(); }
});

test('the launcher imports and runs it before the pack checks', async () => {
  const source = await read(new URL('./runtime/start-service.mjs', import.meta.url));
  const placed = source.indexOf('placeMisplacedPacks({layout, log})'), prepared = source.indexOf('prepared = await prepareState');
  assert.ok(placed > 0 && prepared > placed, 'placeMisplacedPacks runs before prepareState');
  assert.match(await read(new URL('./build-release.mjs', import.meta.url)), /'migrate-legacy\.mjs', 'place-packs\.mjs'/);
});

test('the packaged service places the pack before its checks and logs one line (start-service.mjs --prepare-only)', async () => {
  const f = await fakeGame();
  try {
    const app = f.layout.app;
    for (const name of ['start-service.mjs', 'prepare-state.mjs', 'assemble-parts.mjs', 'migrate-legacy.mjs', 'place-packs.mjs', 'state-home.mjs', 'usvfs-compat.mjs', 'apply-removals.mjs']) await cp(join(project, 'packaging/runtime', name), join(app, 'launcher', name));
    await put(join(app, 'defaults/pocket-voices.autobest.json'), JSON.stringify({version: 1, provider: 'pocket', engine: 'pocket-tts', runtime: {}, voices: {}}));
    await put(join(app, 'defaults/characters.json'), '{"v":2}');
    await put(join(app, 'defaults/multilingual-profiles.json'), '{"v":2}');
    await put(join(app, 'models/lipsync/face-model.json'), '{}');
    const wrapper = join(f.game, 'AI-NPC-Cyberpunk-Mod-LocalAI-Standard-0.2');
    await standardPack(wrapper);
    await omniPack(wrapper);
    const home = join(f.root, 'LocalAppData', 'AiNpcCyberpunkMod'), state = join(home, 'data');
    const run = () => spawnSync(process.execPath, [join(app, 'launcher/start-service.mjs'), '--game-root', f.game, '--prepare-only'],
      {encoding: 'utf8', timeout: 60_000, env: {...process.env, CYBERPUNK_CONVAI_DATA_HOME: home}});
    const first = run();
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.equal(JSON.parse(first.stdout.trim().split('\n').pop()).omni, true, 'the OmniVoice pack is found in the same start');
    assert.equal(await read(join(app, 'local-ai/models/chat.gguf')), 'MODEL-BYTES-standard');
    assert.equal(await exists(wrapper), false);
    const log = (await read(join(state, 'bridge-service.log'))).split('\n').filter(line => / Moved the /.test(line));
    assert.equal(log.length, 2, log.join('\n'));
    assert.match(log.join('\n'), /Moved the Local AI standard files into place from AI-NPC-Cyberpunk-Mod-LocalAI-Standard-0\.2/);
    assert.match(log.join('\n'), /Moved the OmniVoice files into place from AI-NPC-Cyberpunk-Mod-LocalAI-Standard-0\.2/);
    // What the move did is kept for the setup check on the Help page (bridge/setup-check.mjs readPackPlacement).
    const placement = JSON.parse(await read(join(state, PLACEMENT_FILE)));
    assert.equal(placement.version, 1);
    assert(Number.isFinite(placement.updated));
    assert.deepEqual(placement.fixed.map(row => row.pack).sort(), ['Local AI standard', 'OmniVoice']);
    assert(placement.fixed.every(row => row.from === 'AI-NPC-Cyberpunk-Mod-LocalAI-Standard-0.2'), JSON.stringify(placement.fixed));
    assert.deepEqual([placement.conflicts, placement.errors], [[], []]);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal((await read(join(state, 'bridge-service.log'))).split('\n').filter(line => / Moved the /.test(line)).length, 2, 'a second start moves nothing');
    const later = JSON.parse(await read(join(state, PLACEMENT_FILE)));
    assert.deepEqual(later.fixed, [], 'the report is of this start only');
    assert(later.updated >= placement.updated);
  } finally { await f.cleanup(); }
});

test('the placement report is one small file in the state folder, replaced at every start, and the setup check reads it back', async () => {
  const f = await fakeGame();
  try {
    const state = join(f.root, 'state');
    await recordPlacement({state, report: {fixed: [{pack: 'OmniVoice', from: 'wrapped'}], conflicts: ['local-ai/models/chat.gguf'], errors: ['a problem']}, now: () => 1234});
    assert.deepEqual(JSON.parse(await read(join(state, PLACEMENT_FILE))),
      {version: 1, updated: 1234, fixed: [{pack: 'OmniVoice', from: 'wrapped'}], conflicts: ['local-ai/models/chat.gguf'], errors: ['a problem']});
    assert.deepEqual(await readPackPlacement({stateDirectory: state, startedAt: 1234, now: () => 1300}),
      {fixed: [{pack: 'OmniVoice', from: 'wrapped'}], conflicts: ['local-ai/models/chat.gguf'], errors: ['a problem']});
    // a start that moved nothing replaces it with an empty report
    await recordPlacement({state, report: undefined, now: () => 5678});
    assert.deepEqual(JSON.parse(await read(join(state, PLACEMENT_FILE))), {version: 1, updated: 5678, fixed: [], conflicts: [], errors: []});
    assert.deepEqual(await readdir(state), [PLACEMENT_FILE], 'no temporary or numbered copies');
    // a file system that refuses is the caller's to log: the function throws and the launcher goes on
    await assert.rejects(recordPlacement({state, report: {}, fs: {mkdir: async () => { throw new Error('read-only'); }, writeFile: async () => {}}}), /read-only/);
    const source = await read(join(project, 'packaging/runtime/start-service.mjs'));
    assert.match(source, /try \{ await recordPlacement\(\{state: layout\.state, report: placed\}\); \}\s*catch \(error\) \{ log\(/, 'the launcher catches a failed write and carries on');
  } finally { await f.cleanup(); }
});

// ---------------------------------------------------------------- the voice-input packs (MicPack-European, MicPack-Asian)
const EUROPEAN = 'parakeet-tdt-0.6b-v3-int8', ASIAN = 'sense-voice-int8';
const STT = `${APP}/models/stt`;
async function micPack(base, id, {marker = true, model = `MODEL-${id}`} = {}) {
  const folder = join(base, STT, id);
  for (const name of id === EUROPEAN ? ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'] : ['model.int8.onnx', 'tokens.txt']) {
    await put(join(folder, name), name === 'tokens.txt' ? 'tokens' : model);
  }
  await put(join(folder, 'NOTICE.txt'), 'notice');
  await put(join(folder, 'LICENSE-mod.txt'), 'licence');
  if (marker) await put(join(folder, 'mic-pack.json'), `{"pack":"${id}"}`);
}
const RUNTIME_MOONSHINE = 'models/stt/moonshine-tiny-en-int8';
const moonshine = (base, text) => put(join(base, APP, RUNTIME_MOONSHINE, 'encode.int8.onnx'), text);

test('the voice-input pack ids and marker are the ones the build writes and the bridge looks for', async () => {
  const config = JSON.parse(await read(join(project, 'packaging/release.config.json')));
  const {MIC_PACKS} = await import('./runtime/place-packs.mjs');
  assert.deepEqual(Object.fromEntries(Object.values(config.micPacks.packs).map(pack => [pack.id, pack.title])), MIC_PACKS);
  assert.equal(config.micPacks.markerFile, 'mic-pack.json');
  assert.equal(config.micPacks.directory, 'app/models/stt');
  const {LOCAL_PACKS} = await import('../bridge/speech-language.mjs');
  assert.deepEqual(Object.keys(MIC_PACKS).sort(), LOCAL_PACKS.map(pack => pack.id).sort());
});

test('a voice-input pack extracted into a wrapper folder moves into app/models/stt/<id>, beside the Runtime\'s own Moonshine folder', async () => {
  const f = await fakeGame();
  try {
    await moonshine(f.game, 'RUNTIME-MOONSHINE');
    const wrapper = join(f.game, 'AI-NPC-Cyberpunk-Mod-MicPack-European-0.2.3');
    await micPack(wrapper, EUROPEAN);
    const log = lines();
    const report = await placeMisplacedPacks({layout: f.layout, log: log.log});
    assert.deepEqual(log, ['Moved the MicPack-European files into place from AI-NPC-Cyberpunk-Mod-MicPack-European-0.2.3']);
    assert.deepEqual(report.fixed, [{pack: 'MicPack-European', from: 'AI-NPC-Cyberpunk-Mod-MicPack-European-0.2.3'}]);
    assert.deepEqual(await tree(join(f.game, STT, EUROPEAN)), ['decoder.int8.onnx', 'encoder.int8.onnx', 'joiner.int8.onnx', 'LICENSE-mod.txt', 'mic-pack.json', 'NOTICE.txt', 'tokens.txt']);
    assert.equal(await read(join(f.game, STT, EUROPEAN, 'encoder.int8.onnx')), `MODEL-${EUROPEAN}`);
    assert.equal(await read(join(f.game, APP, RUNTIME_MOONSHINE, 'encode.int8.onnx')), 'RUNTIME-MOONSHINE', 'the Runtime\'s own speech model is untouched');
    assert.equal(await exists(wrapper), false, 'the wrapper and the empty models/stt folders are removed');
    assert.equal(await read(join(f.game, APP, 'launcher/start-service.mjs')), '// the real launcher');
    const again = lines();
    assert.deepEqual((await placeMisplacedPacks({layout: f.layout, log: again.log})).fixed, []);
    assert.deepEqual(again, []);
  } finally { await f.cleanup(); }
});

test('both voice-input packs, wrapped two folders deep beside a Local AI pack, are each moved with one line', async () => {
  const f = await fakeGame();
  try {
    const wrapper = join(f.game, 'Both', 'Both');
    await micPack(wrapper, EUROPEAN); await micPack(wrapper, ASIAN); await standardPack(wrapper);
    const log = lines();
    await placeMisplacedPacks({layout: f.layout, log: log.log});
    const from = join('Both', 'Both');
    assert.deepEqual([...log].sort(), ['Local AI standard', 'MicPack-Asian', 'MicPack-European'].map(name => `Moved the ${name} files into place from ${from}`).sort());
    assert.equal(await read(join(f.game, STT, ASIAN, 'model.int8.onnx')), `MODEL-${ASIAN}`);
    assert.equal(await read(join(f.game, STT, EUROPEAN, 'tokens.txt')), 'tokens');
    assert.equal(await read(join(f.game, APP, 'local-ai/models/chat.gguf')), 'MODEL-BYTES-standard');
    assert.equal(await exists(join(f.game, 'Both')), false);
  } finally { await f.cleanup(); }
});

test('a wrapped Runtime-shaped tree with a Moonshine folder is not a pack, and beside a voice-input pack only that pack moves', async () => {
  const f = await fakeGame();
  try {
    await moonshine(f.game, 'RUNTIME-MOONSHINE');
    const old = join(f.game, 'Runtime-0.2');
    await moonshine(old, 'OLDER-MOONSHINE');
    await put(join(old, APP, 'launcher/start-service.mjs'), '// an older launcher');
    const before = await tree(f.game);
    const log = lines();
    await placeMisplacedPacks({layout: f.layout, log: log.log});
    assert.deepEqual(log, [], 'a Moonshine folder is no marker');
    assert.deepEqual(await tree(f.game), before);
    // The same wrapper, now with a voice-input pack too.
    await micPack(old, ASIAN);
    await placeMisplacedPacks({layout: f.layout, log: log.log});
    assert.deepEqual(log, ['Moved the MicPack-Asian files into place from Runtime-0.2']);
    assert.equal(await read(join(f.game, STT, ASIAN, 'mic-pack.json')), `{"pack":"${ASIAN}"}`);
    assert.equal(await read(join(old, APP, RUNTIME_MOONSHINE, 'encode.int8.onnx')), 'OLDER-MOONSHINE', 'the older Runtime\'s Moonshine copy stays where it is');
    assert.equal(await read(join(f.game, APP, RUNTIME_MOONSHINE, 'encode.int8.onnx')), 'RUNTIME-MOONSHINE');
    assert.equal(await read(join(old, APP, 'launcher/start-service.mjs')), '// an older launcher');
    assert.equal(await exists(join(old, STT, ASIAN)), false);
  } finally { await f.cleanup(); }
});

test('a voice-input folder with no marker, or for an id the mod does not know, is left alone', async () => {
  const f = await fakeGame();
  try {
    await micPack(join(f.game, 'NoMarker'), EUROPEAN, {marker: false});
    await put(join(f.game, 'Other', STT, 'some-other-model-int8', 'mic-pack.json'), '{}');
    await put(join(f.game, 'Other', STT, 'some-other-model-int8', 'model.onnx'), 'x');
    const before = await tree(f.game);
    const log = lines();
    await placeMisplacedPacks({layout: f.layout, log: log.log});
    assert.deepEqual(log, []);
    assert.deepEqual(await tree(f.game), before);
  } finally { await f.cleanup(); }
});

test('a voice-input pack: a same-size file in place is kept and the stray one dropped, a different size leaves both, and nothing is overwritten', async () => {
  const f = await fakeGame();
  try {
    await put(join(f.game, STT, EUROPEAN, 'tokens.txt'), 'TOKENS'); // same size as 'tokens', other bytes
    await put(join(f.game, STT, EUROPEAN, 'encoder.int8.onnx'), 'A-LONGER-ENCODER-ALREADY-IN-PLACE');
    await micPack(join(f.game, 'W'), EUROPEAN);
    const log = lines();
    await placeMisplacedPacks({layout: f.layout, log: log.log});
    assert.equal(await read(join(f.game, STT, EUROPEAN, 'tokens.txt')), 'TOKENS');
    assert.equal(await read(join(f.game, STT, EUROPEAN, 'encoder.int8.onnx')), 'A-LONGER-ENCODER-ALREADY-IN-PLACE');
    assert.equal(await read(join(f.game, 'W', STT, EUROPEAN, 'encoder.int8.onnx')), `MODEL-${EUROPEAN}`, 'the different stray copy is left for the player');
    assert.equal(await read(join(f.game, STT, EUROPEAN, 'decoder.int8.onnx')), `MODEL-${EUROPEAN}`);
    assert.ok(log.some(line => /^Left 1 file in W because a different file is already in place \(for example models\/stt\/parakeet-tdt-0\.6b-v3-int8\/encoder\.int8\.onnx\)/.test(line)), log.join('\n'));
    assert.deepEqual(await tree(join(f.game, 'W')), [`${STT}/${EUROPEAN}/encoder.int8.onnx`]);
  } finally { await f.cleanup(); }
});

test('a refused rename of a voice-input pack keeps its marker back for a retry, and the next start finishes', async () => {
  const f = await fakeGame();
  try {
    const wrapper = join(f.game, 'W');
    await micPack(wrapper, ASIAN);
    let refuse = true;
    const fs = {...realFs, async rename(from, to) {
      if (refuse && /model\.int8\.onnx$/.test(from)) throw Object.assign(new Error('EPERM: operation not permitted'), {code: 'EPERM'});
      return realFs.rename(from, to);
    }};
    const log = lines();
    const report = await placeMisplacedPacks({layout: f.layout, log: log.log, fs});
    assert.equal(report.fixed.length, 0);
    assert.match(log[0], /^Could not finish moving the MicPack-Asian files into place from W: .*EPERM.*left where they are/);
    assert.equal(await exists(join(f.game, STT, ASIAN, 'mic-pack.json')), false, 'the pack is never seen half-placed');
    assert.equal(await exists(join(wrapper, STT, ASIAN, 'mic-pack.json')), true);
    refuse = false;
    const next = lines();
    await placeMisplacedPacks({layout: f.layout, log: next.log, fs});
    assert.deepEqual(next, ['Moved the MicPack-Asian files into place from W']);
    assert.equal(await read(join(f.game, STT, ASIAN, 'model.int8.onnx')), `MODEL-${ASIAN}`);
    assert.equal(await exists(wrapper), false);
  } finally { await f.cleanup(); }
});

test('across volumes (EXDEV) a voice-input pack is copied, verified by size, then deleted', async () => {
  const f = await fakeGame();
  try {
    const wrapper = join(f.game, 'W');
    await micPack(wrapper, EUROPEAN);
    const fs = {...realFs, async rename(from, to) {
      if (from.startsWith(wrapper)) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), {code: 'EXDEV'});
      return realFs.rename(from, to);
    }};
    const log = lines();
    await placeMisplacedPacks({layout: f.layout, log: log.log, fs});
    assert.deepEqual(log, ['Moved the MicPack-European files into place from W']);
    assert.equal(await read(join(f.game, STT, EUROPEAN, 'joiner.int8.onnx')), `MODEL-${EUROPEAN}`);
    assert.equal(await exists(wrapper), false);
  } finally { await f.cleanup(); }
});
