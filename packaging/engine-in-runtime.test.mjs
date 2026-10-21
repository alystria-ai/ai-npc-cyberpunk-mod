// The llama.cpp engine ships in the Runtime (docs/LOCAL_AI.md, "The engine is in the Runtime"): node --test packaging/engine-in-runtime.test.mjs
//
// What this keeps true: the service tells the bridge where the Runtime's engine is; the Runtime update zip delivers the engine from a Runtime that had none; the start
// step can never delete a pack's own copy of the engine (an older bridge still needs it); the build writes the engine into the Runtime, once from the same pinned zip the packs
// use, and a pack built with localAi.server.inPacks false carries models only; and under Mod Organizer 2 (the Runtime and every pack its own mod) the Runtime's engine
// is used with its DLLs beside it while the packs' models are found through the merged folder. No real Runtime, no download, nothing is started.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipWriter, listZip} from './lib/zip.mjs';
import {readEntry} from './lib/zip-entry.mjs';
import {PLUGIN, refusalFor} from './runtime/apply-removals.mjs';
import {installLayout, serviceEnvironment} from './runtime/prepare-state.mjs';
import {removalListText} from './lib/runtime-removals.mjs';
import {RELEASE_ENTRY, buildRuntimeUpdate} from './build-runtime-update.mjs';
import {ENGINE_FILES, RUNTIME_ENGINE_FOLDER, detectLocalAiPack} from '../bridge/local-ai-pack.mjs';
import {detectMaturePack} from '../bridge/mature-pack.mjs';
import {listLocalModels} from '../bridge/local-model-choice.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const APP = `${PLUGIN}/app`;
const config = JSON.parse(readFileSync(resolve(project, 'packaging/release.config.json'), 'utf8'));
const server = config.localAi.server;
const builder = readFileSync(resolve(project, 'packaging/build-release.mjs'), 'utf8');
const body = name => { const at = builder.indexOf(`async function ${name}(`); assert(at >= 0, `${name} exists`); return builder.slice(at, builder.indexOf('\n}\n', at)); };

test('the pin names the Runtime folder and the files the engine needs, and the packs keep a copy for one release', () => {
  assert.equal(server.runtimeFolder, RUNTIME_ENGINE_FOLDER);
  assert.equal(typeof server.inPacks, 'boolean');
  for (const name of ['llama-server.exe', 'llama-fit-params.exe', 'llama-fit-params-impl.dll', ...ENGINE_FILES]) assert(server.require.includes(name), `${name} is required of the download`);
  // The folder is under app/, beside node/ and python/, and it is not the packs' llama/ (which a pack shipped at app/local-ai/llama).
  assert.notEqual(server.runtimeFolder, 'llama');
  assert.match(server.runtimeFolder, /^[a-z0-9-]+$/);
});

test('the service tells the bridge where the Runtime engine is, from the install, and a developer\'s own variable does not leak in', () => {
  const gameRoot = resolve('game fixture');
  const appDirectory = resolve(gameRoot, PLUGIN, 'app');
  const layout = installLayout({appDirectory, gameRoot});
  assert.equal(layout.engine, resolve(appDirectory, RUNTIME_ENGINE_FOLDER));
  const env = serviceEnvironment(layout, {omni: false, keyFile: 'unused'}, {CYBERPUNK_CONVAI_LOCAL_ENGINE: 'C:/somewhere/else', PATH: 'x'});
  assert.equal(env.CYBERPUNK_CONVAI_LOCAL_ENGINE, layout.engine);
  // The pack folder is still the packs' own, so the lookup order (Runtime engine first, the pack's copy after) is the bridge's.
  assert.equal(env.CYBERPUNK_CONVAI_LOCAL_AI, layout.localAi);
  assert.notEqual(layout.engine, layout.localAi);
});

test('the start step can never delete the engine a pack carries: an older bridge reads it from there', () => {
  for (const file of ['llama-server.exe', 'ggml-vulkan.dll', 'llama-fit-params.exe', 'LICENSE-LLVM-OpenMP']) {
    assert.equal(refusalFor(`${APP}/local-ai/llama/${file}`), 'protected', file);
  }
  assert.equal(refusalFor(`${APP}/local-ai/llama/`.replace(/\/$/, '')), 'protected', 'the folder itself');
  // The Runtime's own engine folder is the Runtime's: a later update may list a file of it that a newer llama.cpp no longer ships.
  assert.equal(refusalFor(`${APP}/${RUNTIME_ENGINE_FOLDER}/ggml-rpc.dll`), null);
});

async function makeZip(path, files) {
  const writer = await ZipWriter.create(path);
  for (const name of Object.keys(files).sort()) await writer.add(name, {buffer: Buffer.from(files[name])});
  await writer.close();
  return path;
}

test('the update zip from a Runtime without the engine delivers it (and a pack\'s copy is neither in the update nor in its removal list)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'engine update test '));
  try {
    const stamp = version => JSON.stringify({product: 'AI-NPC-Cyberpunk-Mod', package: 'runtime', version, commit: `c-${version}`});
    const engine = Object.fromEntries([...ENGINE_FILES, 'llama-fit-params.exe', 'llama-fit-params-impl.dll', 'LICENSE-LLVM-OpenMP'].map(name => [`${APP}/${RUNTIME_ENGINE_FOLDER}/${name}`, `bytes of ${name}`]));
    const old = {[`${APP}/bridge/convai-bridge.mjs`]: 'bridge v1', [RELEASE_ENTRY]: stamp('0.2.6')};
    const next = {...old, ...engine, [`${APP}/licenses/llama.cpp-MIT.txt`]: 'MIT', [`${APP}/bridge/convai-bridge.mjs`]: 'bridge v2', [RELEASE_ENTRY]: stamp('0.2.7'),
      [`${APP}/defaults/runtime-removals.json`]: removalListText('0.2.7', [])};
    const oldZip = await makeZip(join(dir, 'old.zip'), old), newZip = await makeZip(join(dir, 'new.zip'), next);
    const summary = await buildRuntimeUpdate({oldZips: [oldZip], newZips: [newZip], out: join(dir, 'out'), log: () => {}});
    const zip = join(dir, 'out', `AI-NPC-Cyberpunk-Mod-Runtime-Update-0.2.6-to-0.2.7.zip`);
    const held = Object.fromEntries(await Promise.all((await listZip(zip)).map(async entry => [entry.name, (await readEntry(zip, entry)).toString('utf8')])));
    for (const name of Object.keys(engine)) assert.equal(held[name], engine[name], `${name} is in the update`);
    assert.equal(held[`${APP}/licenses/llama.cpp-MIT.txt`], 'MIT');
    assert.equal(summary.added, Object.keys(engine).length + 2, 'the engine, its licence and the removal list are added');
    const removes = JSON.parse(held[`${APP}/defaults/runtime-removals.json`]).removes;
    assert(!removes.some(path => /llama/i.test(path)), 'nothing about the engine is removed');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the build writes the engine into the Runtime from the same pinned download the packs use', () => {
  const runtime = body('runtimePackage');
  assert.match(runtime, /await addRuntimeEngine\(pkg, source, config, app, notices\)/, 'the Runtime package adds the engine');
  const add = body('addRuntimeEngine');
  assert.match(add, /await engineFiles\(config\)/, 'one helper reads the download for the Runtime and the packs');
  assert.match(add, /\$\{app\}\/\$\{folder\}\/\$\{name\}/, 'the files go to app/<runtimeFolder>/');
  assert.match(add, /\$\{app\}\/licenses\/llama\.cpp-MIT\.txt/, 'with the licence text');
  assert.match(add, /notices\.push\(/, 'and a line in the Runtime\'s third-party notices');
  assert.match(body('addEngine'), /await engineFiles\(config\)/);
  const files = body('engineFiles');
  assert.match(files, /spec\.server\.keep/);
  assert.match(files, /for \(const name of spec\.server\.require\)/, 'a download that lacks a required file stops the build');
});

test('a pack built with inPacks false carries models only: no llama/ folder, no licence for it, no server in its marker, and the notices say where the engine is', () => {
  const add = body('addEngine');
  assert.match(add, /const inPacks = spec\.server\.inPacks !== false;/);
  assert.match(add, /if \(inPacks\) \{[\s\S]*?\$\{root\}\/llama\/\$\{name\}/, 'the pack\'s copy of the engine only with inPacks');
  assert.match(add, /if \(inPacks\) pkg\.file\(`\$\{root\}\/licenses\/llama\.cpp-MIT\.txt`/);
  assert.match(add, /server: inPacks \? 'llama\/llama-server\.exe' : null/);
  assert.match(body('localAiPackage'), /\.\.\.\(engine\.server \? \{server: engine\.server\} : \{\}\)/, 'the Local AI manifest names a server only when the pack has one');
  assert.match(body('maturePackage'), /\.\.\.\(engine\.server \? \{server: engine\.server\} : \{\}\)/, 'and so does a Mature marker');
  assert.match(builder, /it is part of the Runtime package \(app\/\$\{spec\.server\.runtimeFolder\}\//, 'the pack notice points at the Runtime');
});

test('the notices name the engine in the Runtime and the packs\' copy', () => {
  const notices = readFileSync(resolve(project, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notices, /app\/llama-cpp\//);
  assert.match(notices, new RegExp(server.version));
});

// ---- Mod Organizer 2: the Runtime is one mod, each pack another ---------------------------------------------------------------------------------------------------------
const EMBED = {file: 'models/granite-embedding-107m-multilingual-Q8_0.gguf', dim: 384, id: 'granite-embedding-107m-multilingual-q8_0'};

function mo2(t, {packs, runtimeEngine = true}) {
  const base = mkdtempSync(join(tmpdir(), 'mo2 engine runtime '));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  const appOf = mod => join(base, 'MO2', 'mods', mod, 'red4ext', 'plugins', 'AiNpcCyberpunkMod', 'app');
  const runtimeApp = appOf('AI NPC Runtime');
  mkdirSync(join(runtimeApp, 'bridge'), {recursive: true});
  if (runtimeEngine) {
    for (const name of [...ENGINE_FILES, 'llama-fit-params.exe', 'llama-fit-params-impl.dll']) {
      mkdirSync(join(runtimeApp, RUNTIME_ENGINE_FOLDER), {recursive: true});
      writeFileSync(join(runtimeApp, RUNTIME_ENGINE_FOLDER, name), `runtime ${name}`);
    }
  }
  const virtual = join(base, 'Cyberpunk 2077', 'red4ext', 'plugins', 'AiNpcCyberpunkMod', 'app', 'local-ai');
  const roots = packs.map(pack => join(appOf(pack.name), 'local-ai'));
  packs.forEach((pack, index) => {
    mkdirSync(roots[index], {recursive: true});
    for (const [name, text] of Object.entries(pack.files)) { mkdirSync(dirname(join(roots[index], name)), {recursive: true}); writeFileSync(join(roots[index], name), text); }
  });
  const inside = path => { const rel = relative(virtual, resolve(path)); return rel.startsWith('..') || /^[a-z]:/i.test(rel) ? null : rel; };
  const real = path => { const rel = inside(path); if (rel === null) return null; for (const root of roots) { const candidate = join(root, rel); if (existsSync(candidate)) return candidate; } return null; };
  const environment = {CYBERPUNK_CONVAI_LOCAL_AI: virtual, CYBERPUNK_CONVAI_USVFS: '1', CYBERPUNK_CONVAI_LOCAL_ENGINE: join(runtimeApp, RUNTIME_ENGINE_FOLDER)};
  const options = {
    project: runtimeApp, environment,
    exists: path => { const mapped = inside(path) === null ? path : real(path); try { return Boolean(mapped) && statSync(mapped).isFile(); } catch { return false; } },
    readText: path => readFileSync(inside(path) === null ? path : real(path), 'utf8'),
    list: path => {
      if (inside(path) === null) { try { return readdirSync(path); } catch { return []; } }
      const names = new Set();
      for (const root of roots) { try { for (const name of readdirSync(join(root, inside(path)))) names.add(name); } catch { /* not in this mod */ } }
      return [...names];
    },
    realPath: path => (inside(path) === null ? path : real(path) ?? path),
  };
  return {options, runtimeApp, roots};
}
const modelsOnly = {
  'standard': {'models/gemma-4-E4B_q4_0-it.gguf': 'model', [EMBED.file]: 'embed',
    'manifest.standard.json': JSON.stringify({version: 1, standard: {file: 'models/gemma-4-E4B_q4_0-it.gguf', name: 'Gemma 4 E4B'}, embed: EMBED})},
  'mature': {'models/Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf': 'model', [EMBED.file]: 'embed',
    'manifest.mature-standard.json': JSON.stringify({version: 1, pack: 'mature', good: {file: 'models/Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf', name: 'Gemma 4 E4B · uncensored', family: 'gemma-4'}, embed: EMBED})},
};
// A pack as built up to 0.2.7: the engine in its own llama/ folder and `server` in every marker.
const named = files => Object.fromEntries(Object.entries(files).map(([name, text]) => [name, /^manifest\./.test(name) ? JSON.stringify({...JSON.parse(text), server: 'llama/llama-server.exe'}) : text]));
const withEngine = files => ({...named(files), 'llama/llama-server.exe': 'pack exe', 'llama/llama-server-impl.dll': 'pack dll', 'llama/llama.dll': 'pack dll', 'llama/ggml.dll': 'pack dll',
  'llama/ggml-base.dll': 'pack dll', 'llama/ggml-vulkan.dll': 'pack dll', 'llama/ggml-cpu-x64.dll': 'pack dll'});

test('MO2: the Runtime mod\'s engine runs both models-only packs (each its own mod), with the fit tool beside it', t => {
  const f = mo2(t, {packs: [{name: 'LocalAI Standard', files: modelsOnly.standard}, {name: 'Mature Standard', files: modelsOnly.mature}]});
  const pack = detectLocalAiPack(f.options), mature = detectMaturePack(f.options);
  assert.equal(pack.installed, true);
  assert.equal(pack.engine.source, 'runtime');
  assert.equal(pack.server, join(f.runtimeApp, RUNTIME_ENGINE_FOLDER, 'llama-server.exe'));
  assert.equal(existsSync(join(dirname(pack.server), 'llama-fit-params.exe')), true, 'the fit tool is in the same real folder');
  assert.equal(pack.tiers.standard.name, 'Gemma 4 E4B');
  assert.deepEqual(mature.models.map(model => model.tier), ['good']);
  assert.deepEqual(listLocalModels({pack, matureModels: mature.models}).map(model => model.id).sort(), ['mature:good', 'standard']);
});

test('MO2: a Mature pack alone (models only) is installed on the Runtime\'s engine', t => {
  const f = mo2(t, {packs: [{name: 'Mature Standard', files: modelsOnly.mature}]});
  const pack = detectLocalAiPack(f.options);
  assert.equal(pack.installed, true);
  assert.equal(pack.server, join(f.runtimeApp, RUNTIME_ENGINE_FOLDER, 'llama-server.exe'));
});

test('MO2: old packs that carry their own engine beside the new Runtime mod use the Runtime\'s; without the Runtime mod\'s engine they use the pack\'s, as before', t => {
  const packs = [{name: 'LocalAI Standard', files: withEngine(modelsOnly.standard)}, {name: 'Mature Standard', files: withEngine(modelsOnly.mature)}];
  const both = detectLocalAiPack(mo2(t, {packs}).options);
  assert.equal(both.engine.source, 'runtime');
  assert.match(both.server, /AI NPC Runtime/);
  const old = mo2(t, {packs, runtimeEngine: false});
  const pack = detectLocalAiPack(old.options);
  assert.equal(pack.installed, true);
  assert.equal('engine' in pack, false, 'an older Runtime: nothing new in the answer');
  assert.match(pack.server, /LocalAI Standard|Mature Standard/);
  assert(pack.places.server.complete, 'the pack\'s server and DLLs from one real folder, as before');
});

test('the new Runtime with no pack and an own server: the engine is present and nothing is reported missing but the models', t => {
  const f = mo2(t, {packs: []});
  const pack = detectLocalAiPack(f.options);
  assert.equal(pack.installed, false);
  assert.deepEqual(pack.missing, ['model', 'embed']);
  assert.equal(listLocalModels({pack, matureModels: []}).length, 0);
});
