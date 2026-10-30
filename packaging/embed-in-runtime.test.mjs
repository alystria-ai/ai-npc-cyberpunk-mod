// The embedding model of the memory search ships in the Runtime (docs/LOCAL_AI.md, "The embedding model is in the Runtime"): node --test packaging/embed-in-runtime.test.mjs
//
// What this keeps true: the build puts the model in the Runtime (app/models/embed/) and not in the Local AI and Mature packs, the service tells the bridge where it is, the bridge prefers the
// Runtime's copy and falls back to the one an older pack carries, the Runtime update zip delivers it, the embedder runs it on the Runtime's own engine whether or not a pack is installed, and a
// check refuses a Runtime without it. No real Runtime, no download, nothing is started.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipWriter, listZip} from './lib/zip.mjs';
import {readEntry} from './lib/zip-entry.mjs';
import {PLUGIN} from './runtime/apply-removals.mjs';
import {installLayout, serviceEnvironment} from './runtime/prepare-state.mjs';
import {removalListText} from './lib/runtime-removals.mjs';
import {requiredRuntimeFiles} from './lib/runtime-required.mjs';
import {RELEASE_ENTRY, buildRuntimeUpdate} from './build-runtime-update.mjs';
import {ENGINE_FILES, EMBED_MODEL_FILE, LOCAL_AI_ENV, RUNTIME_EMBED_FOLDER, RUNTIME_ENGINE_FOLDER, detectLocalAiPack, runtimeEmbedFile} from '../bridge/local-ai-pack.mjs';
import {LlamaEmbedder} from '../bridge/local-embed.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const APP = `${PLUGIN}/app`;
const config = JSON.parse(readFileSync(resolve(project, 'packaging/release.config.json'), 'utf8'));
const embed = config.localAi.embed;
const builder = readFileSync(resolve(project, 'packaging/build-release.mjs'), 'utf8').replaceAll(String.fromCharCode(13), '');
const body = name => { const at = builder.indexOf(`async function ${name}(`); assert(at >= 0, `${name} exists`); return builder.slice(at, builder.indexOf('\n}\n', at)); };

test('the pins: the model is in the Runtime, not in the packs, and the bridge and the release name the same folder and file', () => {
  assert.equal(embed.inPacks, false);
  assert.equal(embed.runtimeFolder, RUNTIME_EMBED_FOLDER);
  assert.equal(embed.file, EMBED_MODEL_FILE);
  assert.equal(embed.dim, 384);
  assert.equal(config.localAi.server.inPacks, false, 'the engine stays in the Runtime too, and runs the model');
  assert.equal(config.localAi.server.runtimeFolder, RUNTIME_ENGINE_FOLDER);
  assert.equal(config.packFiles.packs['localai-engine'], undefined, 'there is no engine-only zip');
});

test('the service tells the bridge where the Runtime model is, and a developer\'s variable does not leak in', () => {
  const gameRoot = resolve('game fixture');
  const appDirectory = resolve(gameRoot, PLUGIN, 'app');
  const layout = installLayout({appDirectory, gameRoot});
  assert.equal(layout.embedModel, resolve(appDirectory, RUNTIME_EMBED_FOLDER, EMBED_MODEL_FILE));
  const env = serviceEnvironment(layout, {omni: false, keyFile: 'unused'}, {CYBERPUNK_CONVAI_LOCAL_RUNTIME_EMBED: 'C:/somewhere/else.gguf', PATH: 'x'});
  assert.equal(env[LOCAL_AI_ENV.runtimeEmbed], layout.embedModel);
  assert.equal(runtimeEmbedFile({project: appDirectory, environment: {}}), layout.embedModel);
  assert.equal(runtimeEmbedFile({environment: {}}), null);
  assert.equal(runtimeEmbedFile({project: appDirectory, environment: {[LOCAL_AI_ENV.runtimeEmbed]: resolve('named.gguf')}}), resolve('named.gguf'));
});

test('the Runtime build adds the model with its licence text and a notice, and the packs build leaves it out', () => {
  assert.match(body('runtimePackage'), /await addRuntimeEmbed\(pkg, source, config, app, notices\)/);
  const add = body('addRuntimeEmbed');
  assert.match(add, /\$\{app\}\/\$\{folder\}\/\$\{spec\.file\}/, 'the model goes to app/<runtimeFolder>/');
  assert.match(add, /\$\{app\}\/licenses\/Apache-2\.0\.txt/);
  assert.match(add, /notices\.push\(/);
  const packs = body('addEngine');
  assert.match(packs, /embedInPacks = spec\.embed\.inPacks !== false/);
  assert.match(packs, /if \(embedInPacks\) pkg\.file\(`\$\{root\}\/models\//, 'a pack gets the model only while embed.inPacks is true');
  assert.match(packs, /embed: embedInPacks \? \{/, 'and its manifests name no embed otherwise');
  assert.match(body('localAiPackage'), /\.\.\.\(engine\.embed \? \{embed: engine\.embed\} : \{\}\)/);
  assert.match(body('maturePackage'), /\.\.\.\(engine\.embed \? \{embed: engine\.embed\} : \{\}\)/);
});

test('a Runtime without the model is refused by the contents check', async () => {
  const required = await requiredRuntimeFiles(project);
  assert.deepEqual(required['embedding model'], [`${APP}/${RUNTIME_EMBED_FOLDER}/${EMBED_MODEL_FILE}`]);
});

test('the notices name the model in the Runtime', () => {
  const notices = readFileSync(resolve(project, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notices, /granite-embedding-107m-multilingual/);
  assert.match(notices, /app\/models\/embed\//);
});

test('the Runtime update zip delivers the model and the Apache-2.0 text to a Runtime that had neither, and removes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'embed update test '));
  try {
    const make = async (path, files) => {
      const writer = await ZipWriter.create(path);
      for (const name of Object.keys(files).sort()) await writer.add(name, {buffer: Buffer.from(files[name])});
      await writer.close();
      return path;
    };
    const stamp = version => JSON.stringify({product: 'AI-NPC-Cyberpunk-Mod', package: 'runtime', version, game: '2.5', commit: `c-${version}`});
    const old = {[`${APP}/node/node.exe`]: 'node', [`${APP}/${RUNTIME_ENGINE_FOLDER}/llama-server.exe`]: 'server', [RELEASE_ENTRY]: stamp('0.4.0')};
    const next = {...old, [`${APP}/${RUNTIME_EMBED_FOLDER}/${EMBED_MODEL_FILE}`]: 'model', [`${APP}/licenses/Apache-2.0.txt`]: 'Apache', [RELEASE_ENTRY]: stamp('0.5.0'),
      [`${APP}/defaults/runtime-removals.json`]: removalListText('0.5.0', [])};
    const summary = await buildRuntimeUpdate({oldZips: [await make(join(dir, 'old.zip'), old)], newZips: [await make(join(dir, 'new.zip'), next)], out: join(dir, 'out'), log: () => {}});
    const zip = join(dir, 'out', 'Runtime-Update-0.4.0-to-0.5.0.zip');
    const held = Object.fromEntries(await Promise.all((await listZip(zip)).map(async entry => [entry.name, (await readEntry(zip, entry)).toString('utf8')])));
    assert.equal(held[`${APP}/${RUNTIME_EMBED_FOLDER}/${EMBED_MODEL_FILE}`], 'model');
    assert.equal(held[`${APP}/licenses/Apache-2.0.txt`], 'Apache');
    assert.equal(summary.removals, 0);
    assert.deepEqual(JSON.parse(held[`${APP}/defaults/runtime-removals.json`]).removes, []);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

// ---- the bridge: the Runtime's copy first, an older pack's copy as the fall-back ---------------------------------------------------------------------------------------
const appDir = resolve('app-fixture');
const root = resolve(appDir, 'local-ai');
const at = name => resolve(root, name);
const engineDir = resolve(appDir, RUNTIME_ENGINE_FOLDER);
const wholeEngine = ENGINE_FILES.map(name => resolve(engineDir, name));
const runtimeModel = resolve(appDir, RUNTIME_EMBED_FOLDER, EMBED_MODEL_FILE);
const EMBED_ENTRY = {file: `models/${EMBED_MODEL_FILE}`, dim: 384, id: 'granite-embedding-107m-multilingual-q8_0'};
const newManifest = {version: 1, standard: {file: 'models/q4.gguf', name: 'Gemma 4 E4B'}};            // a pack built from the next release: models only, no embed
const oldManifest = {...newManifest, embed: EMBED_ENTRY};                                             // a pack of 0.2.9 to 0.4.x: the model is in it
function detect({manifest, files = [], runtime = [runtimeModel, ...wholeEngine], environment = {CYBERPUNK_CONVAI_LOCAL_AI: root}}) {
  const present = new Set([...files.map(at), ...(manifest ? [at('manifest.standard.json')] : []), ...runtime]);
  return detectLocalAiPack({project: appDir, environment, exists: path => present.has(path), readText: () => JSON.stringify(manifest)});
}

test('with a new pack the model comes from the Runtime and nothing is missing', () => {
  const found = detect({manifest: newManifest, files: ['models/q4.gguf']});
  assert.equal(found.installed, true);
  assert.deepEqual(found.embed, {file: runtimeModel, dim: 384, id: EMBED_ENTRY.id});
  assert.deepEqual(found.missing, []);
  assert.equal(found.server, resolve(engineDir, 'llama-server.exe'), 'the Runtime engine runs it');
});

test('with an old pack that carries the model, the Runtime\'s copy is preferred, and the pack\'s serves when the Runtime has none', () => {
  const both = detect({manifest: oldManifest, files: ['models/q4.gguf', EMBED_ENTRY.file]});
  assert.equal(both.embed.file, runtimeModel);
  const packOnly = detect({manifest: oldManifest, files: ['models/q4.gguf', EMBED_ENTRY.file], runtime: wholeEngine});
  assert.equal(packOnly.embed.file, at(EMBED_ENTRY.file), 'an older Runtime without the model: the pack\'s model, as before');
  assert.equal(packOnly.embed.id, EMBED_ENTRY.id);
  // The same id either way, so memories stored with one are found with the other.
  assert.equal(both.embed.id, packOnly.embed.id);
});

test('no pack at all: a Runtime with the model gives the memory search everything it needs, and without the model the answer says embed is missing', () => {
  const bare = detect({manifest: null});
  assert.equal(bare.installed, false);
  assert.equal(bare.embed.file, runtimeModel);
  assert.equal(bare.server, resolve(engineDir, 'llama-server.exe'));
  assert.deepEqual(bare.missing, ['model']);
  const without = detect({manifest: null, runtime: wholeEngine});
  assert.equal(without.embed, null);
  assert.deepEqual(without.missing, ['model', 'embed']);
});

test('the developer layout keeps its own embedding model', () => {
  const devRoot = resolve('dev-fixture');
  const dev = file => resolve(devRoot, file);
  const present = new Set([dev('llama-vulkan/llama-server.exe'), dev('dl-gemma4-e4b/m.gguf'), dev('dl-granite-emb/e.gguf'), runtimeModel]);
  const found = detectLocalAiPack({project: appDir, environment: {CYBERPUNK_CONVAI_LOCAL_AI_DEV: devRoot}, exists: path => present.has(path),
    list: folder => (folder === dev('dl-gemma4-e4b') ? ['m.gguf'] : folder === dev('dl-granite-emb') ? ['e.gguf'] : [])});
  assert.equal(found.dev, true);
  assert.equal(found.embed.file, dev('dl-granite-emb/e.gguf'));
});

test('the embedder runs the Runtime model on the Runtime engine, with or without a pack', () => {
  for (const found of [detect({manifest: null}), detect({manifest: newManifest, files: ['models/q4.gguf']})]) {
    const embedder = new LlamaEmbedder({pack: found, exists: path => path === runtimeModel || path === found.server});
    assert.equal(embedder.available(), true);
    assert.equal(embedder.command, resolve(engineDir, 'llama-server.exe'));
    assert.equal(embedder.id, EMBED_ENTRY.id);
    assert.equal(embedder.dim, 384);
  }
  const none = new LlamaEmbedder({pack: detect({manifest: null, runtime: wholeEngine}), exists: () => true});
  assert.equal(none.available(), false, 'no model anywhere: no embedder, memory falls back as before');
});
