import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {detectLocalAiPack, ENGINE_FILES, LOCAL_AI_ENV, RUNTIME_ENGINE_FOLDER, describePackFiles, packPlaceLines, runtimeEngineFolder} from './local-ai-pack.mjs';

const project = resolve('project-fixture');
const root = resolve('pack-fixture');
const manifest = {version: 1, server: 'llama/llama-server.exe',
  standard: {file: 'models/q4.gguf', name: 'Qwen3.5-4B'}, lite: {file: 'models/q2.gguf', name: 'Qwen3.5-2B'},
  embed: {file: 'models/embed.gguf', dim: 384, id: 'granite-embedding-107m-multilingual-q8_0'}};
const realFiles = ['llama/llama-server.exe', 'models/q4.gguf', 'models/q2.gguf', 'models/embed.gguf'].map(name => resolve(root, name));

function detectReal(files, manifestValue = manifest, environment = {CYBERPUNK_CONVAI_LOCAL_AI: root}) {
  const manifestPath = resolve(root, 'manifest.json');
  const present = new Set([...files, ...(manifestValue === null ? [] : [manifestPath])]);
  return detectLocalAiPack({project, environment, exists: path => present.has(path),
    readText: path => { assert.equal(path, manifestPath); return typeof manifestValue === 'string' ? manifestValue : JSON.stringify(manifestValue); }});
}

test('a real pack is installed when its server and at least one chat model are present', () => {
  const found = detectReal(realFiles);
  assert.deepEqual(found, {installed: true, missing: [], root, server: realFiles[0],
    tiers: {standard: {file: realFiles[1], name: 'Qwen3.5-4B'}, lite: {file: realFiles[2], name: 'Qwen3.5-2B'}},
    embed: {file: realFiles[3], dim: 384, id: 'granite-embedding-107m-multilingual-q8_0'}, dev: false});
  // Defaults to <project>/local-ai.
  const byProject = detectLocalAiPack({project, environment: {}, exists: path => path === resolve(project, 'local-ai/manifest.json'),
    readText: () => JSON.stringify(manifest)});
  assert.equal(byProject.root, resolve(project, 'local-ai'));
});

test('missing pieces are listed and only the server and a chat model are required', () => {
  const [server, standard, lite, embed] = realFiles;
  assert.deepEqual(detectReal([server, standard, lite]).missing, ['embed']);
  assert.equal(detectReal([server, standard, lite]).installed, true);
  assert.equal(detectReal([server, standard, lite]).embed, null);
  const liteOnly = detectReal([server, lite, embed]);
  assert.equal(liteOnly.installed, true);
  assert.equal(liteOnly.tiers.standard, null);
  assert.equal(liteOnly.tiers.lite.name, 'Qwen3.5-2B');
  const noServer = detectReal([standard, lite, embed]);
  assert.deepEqual(noServer.missing, ['server']);
  assert.equal(noServer.installed, false);
  assert.equal(noServer.server, null);
  assert.deepEqual(detectReal([server, embed]).missing, ['model']);
  assert.deepEqual(detectReal([]).missing, ['server', 'model', 'embed']);
  assert.equal(detectReal([]).installed, false);
});

test('manifest paths must stay inside the pack', () => {
  const bad = {...manifest, server: 'C:\\Windows\\llama-server.exe', standard: {file: '../outside/m.gguf', name: 'x'}, lite: {file: '/abs/m.gguf'},
    embed: {file: 'models/..\\..\\e.gguf', dim: 384, id: 'e'}};
  const found = detectReal(realFiles, bad);
  assert.deepEqual(found.missing, ['server', 'model', 'embed']);
  assert.equal(found.installed, false);
  assert.equal(detectReal(realFiles, '{not json').installed, false);
  assert.equal(detectReal(realFiles, {...manifest, version: 2}).installed, false);
  // Names and ids default from the file name; another model is only another manifest.
  const other = detectReal(realFiles, {version: 1, server: manifest.server, standard: {file: 'models/q4.gguf'}, embed: {file: 'models/embed.gguf'}});
  assert.equal(other.tiers.standard.name, 'q4');
  assert.equal(other.embed.id, 'embed');
  assert.equal(other.embed.dim, 384);
});

const devRoot = resolve('dev-fixture/local-llm');
const devFiles = {
  [resolve(devRoot, 'llama-vulkan')]: [],
  [resolve(devRoot, 'dl-qwen35-4b')]: ['Qwen3.5-4B-Q4_K_M.gguf'],
  [resolve(devRoot, 'dl-qwen35-2b')]: ['Qwen3.5-2B-Q4_K_M.gguf', 'notes.txt'],
  [resolve(devRoot, 'dl-granite-emb')]: ['granite-embedding-107m-multilingual-Q8_0.gguf'],
};
const devPaths = [resolve(devRoot, 'llama-vulkan/llama-server.exe'), resolve(devRoot, 'dl-qwen35-4b/Qwen3.5-4B-Q4_K_M.gguf'),
  resolve(devRoot, 'dl-qwen35-2b/Qwen3.5-2B-Q4_K_M.gguf'), resolve(devRoot, 'dl-granite-emb/granite-embedding-107m-multilingual-Q8_0.gguf')];

function detectDev(environment, files = devPaths) {
  return detectLocalAiPack({project, environment, exists: path => files.includes(path), readText: () => { throw Error('no manifest'); },
    list: directory => devFiles[directory] ?? []});
}

test('the developer layout is used when the pack has no manifest', () => {
  const found = detectDev({CYBERPUNK_CONVAI_LOCAL_AI_DEV: devRoot});
  assert.deepEqual(found, {installed: true, missing: [], root: devRoot, server: devPaths[0],
    tiers: {standard: {file: devPaths[1], name: 'Qwen3.5-4B-Q4_K_M'}, lite: {file: devPaths[2], name: 'Qwen3.5-2B-Q4_K_M'}},
    embed: {file: devPaths[3], dim: 384, id: 'granite-embedding-107m-multilingual-q8_0'}, dev: true});
  // Nothing configured: nothing found, and nothing is guessed.
  const none = detectDev({});
  assert.equal(none.installed, false);
  assert.equal(none.dev, false);
  assert.equal(none.root, resolve(project, 'local-ai'));
  assert.deepEqual(detectDev({CYBERPUNK_CONVAI_LOCAL_AI_DEV: devRoot}, devPaths.slice(0, 2)).missing, ['embed']);
  assert.equal(detectDev({CYBERPUNK_CONVAI_LOCAL_AI_DEV: devRoot}, devPaths.slice(1)).installed, false);
});

test('the developer layout takes the lite model from dl-bonsai2-4b and falls back to the earlier dl-qwen35-2b', () => {
  const bonsai = resolve(devRoot, 'dl-bonsai2-4b/Ternary-Bonsai-2-4B-Q2_0.gguf');
  devFiles[resolve(devRoot, 'dl-bonsai2-4b')] = ['Ternary-Bonsai-2-4B-Q2_0.gguf'];
  try {
    const found = detectDev({CYBERPUNK_CONVAI_LOCAL_AI_DEV: devRoot}, [...devPaths, bonsai]);
    assert.deepEqual(found.tiers.lite, {file: bonsai, name: 'Ternary-Bonsai-2-4B-Q2_0'});
  } finally { delete devFiles[resolve(devRoot, 'dl-bonsai2-4b')]; }
  assert.equal(detectDev({CYBERPUNK_CONVAI_LOCAL_AI_DEV: devRoot}, devPaths).tiers.lite.file, devPaths[2], 'no Bonsai folder: the earlier lite model');
});

test('a real manifest wins over the developer layout', () => {
  const manifestPath = resolve(root, 'manifest.json');
  const found = detectLocalAiPack({project, environment: {CYBERPUNK_CONVAI_LOCAL_AI: root, CYBERPUNK_CONVAI_LOCAL_AI_DEV: devRoot},
    exists: path => path === manifestPath || realFiles.includes(path) || devPaths.includes(path), readText: () => JSON.stringify(manifest)});
  assert.equal(found.dev, false);
  assert.equal(found.root, root);
});

test('each developer-layout file can be overridden by an environment variable', () => {
  const model = resolve('elsewhere/other-model.gguf');
  const server = resolve('elsewhere/llama-server.exe');
  const embed = resolve('elsewhere/Embed-Small-F16.gguf');
  const found = detectDev({CYBERPUNK_CONVAI_LOCAL_AI_DEV: devRoot, CYBERPUNK_CONVAI_LOCAL_SERVER: server,
    CYBERPUNK_CONVAI_LOCAL_MODEL: model, CYBERPUNK_CONVAI_LOCAL_EMBED_MODEL: embed}, [server, model, devPaths[2], embed]);
  assert.equal(found.installed, true);
  assert.equal(found.server, server);
  assert.deepEqual(found.tiers.standard, {file: model, name: 'other-model'});
  assert.equal(found.tiers.lite.file, devPaths[2]);
  assert.equal(found.embed.id, 'embed-small-f16');
  // The lite override works on its own, even with no dev folder at all.
  const lite = resolve('elsewhere/lite.gguf');
  const alone = detectDev({CYBERPUNK_CONVAI_LOCAL_SERVER: server, CYBERPUNK_CONVAI_LOCAL_LITE_MODEL: lite}, [server, lite]);
  assert.equal(alone.installed, true);
  assert.equal(alone.tiers.standard, null);
  assert.equal(alone.tiers.lite.name, 'lite');
  assert.deepEqual(alone.missing, ['embed']);
});

test('the developer layout prefers the Gemma 4 E4B folder for the standard tier when it holds a model', () => {
  const gemma = resolve(devRoot, 'dl-gemma4-e4b/gemma-4-E4B_q4_0-it.gguf');
  devFiles[resolve(devRoot, 'dl-gemma4-e4b')] = ['gemma-4-E4B_q4_0-it.gguf'];
  try {
    const found = detectDev({CYBERPUNK_CONVAI_LOCAL_AI_DEV: devRoot}, [...devPaths, gemma]);
    assert.equal(found.tiers.standard.file, gemma);
    assert.equal(found.tiers.lite.file, devPaths[2]);
    // The environment override still wins.
    assert.equal(detectDev({CYBERPUNK_CONVAI_LOCAL_AI_DEV: devRoot, CYBERPUNK_CONVAI_LOCAL_MODEL: devPaths[1]}, [...devPaths, gemma]).tiers.standard.file, devPaths[1]);
  } finally { delete devFiles[resolve(devRoot, 'dl-gemma4-e4b')]; }
});

test('the two optional packs unpack into one folder with a manifest fragment each, and either one alone is enough', () => {
  const standard = {version: 1, server: manifest.server, standard: manifest.standard, embed: manifest.embed};
  const lite = {version: 1, server: manifest.server, lite: manifest.lite, embed: manifest.embed};
  const detect = (files, fragments) => detectLocalAiPack({project, environment: {CYBERPUNK_CONVAI_LOCAL_AI: root},
    exists: path => files.includes(path) || Object.keys(fragments).some(name => resolve(root, name) === path),
    readText: path => JSON.stringify(fragments[Object.keys(fragments).find(name => resolve(root, name) === path)])});
  const [server, big, small, embed] = realFiles;
  const both = detect(realFiles, {'manifest.standard.json': standard, 'manifest.lite.json': lite});
  assert.equal(both.installed, true);
  assert(both.tiers.standard && both.tiers.lite);
  assert.deepEqual(both.missing, []);
  const onlyLite = detect([server, small, embed], {'manifest.lite.json': lite});
  assert.equal(onlyLite.installed, true); assert.equal(onlyLite.tiers.standard, null); assert(onlyLite.tiers.lite);
  const onlyStandard = detect([server, big, embed], {'manifest.standard.json': standard});
  assert.equal(onlyStandard.tiers.lite, null); assert(onlyStandard.tiers.standard);
  // A fragment whose model file was deleted by hand leaves the other pack working.
  const halfDeleted = detect([server, small, embed], {'manifest.standard.json': standard, 'manifest.lite.json': lite});
  assert.equal(halfDeleted.tiers.standard, null); assert(halfDeleted.tiers.lite); assert.equal(halfDeleted.installed, true);
});

// ---- the Mature packs carry the engine too, so a Mature pack alone is a working install (docs/LOCAL_AI.md, "Mature content")
import {MATURE_ENGINE_MARKERS} from './local-ai-pack.mjs';
import {MATURE_MARKER, MATURE_MARKERS} from './mature-pack.mjs';

const matureEmbed = {file: 'models/embed.gguf', dim: 384, id: 'granite-embedding-107m-multilingual-q8_0'};
const matureLiteMarker = {version: 1, pack: 'mature', server: 'llama/llama-server.exe', lite: {file: 'models/uncensored-lite.gguf', name: 'Qwen3.5-4B · uncensored', family: 'qwen'}, embed: matureEmbed};
const matureStandardMarker = {version: 1, pack: 'mature', server: 'llama/llama-server.exe', good: {file: 'models/uncensored-good.gguf', name: 'Gemma 4 E4B · uncensored', family: 'gemma-4'}, embed: matureEmbed};
const oldMatureMarker = {version: 1, pack: 'mature', lite: matureLiteMarker.lite};   // an older Mature pack: no server, no embed
const at = name => resolve(root, name);

// `fragments` maps a file name in the pack folder to its JSON; `files` are the other files present.
function detectFolder(fragments, files = []) {
  const present = new Set([...files.map(at), ...Object.keys(fragments).map(at)]);
  return detectLocalAiPack({project, environment: {CYBERPUNK_CONVAI_LOCAL_AI: root}, exists: path => present.has(path),
    readText: path => JSON.stringify(fragments[Object.keys(fragments).find(name => at(name) === path)])});
}

test('the Mature marker names are the ones bridge/mature-pack.mjs reads', () => {
  assert.deepEqual([...MATURE_ENGINE_MARKERS].sort(), [...Object.values(MATURE_MARKERS), MATURE_MARKER].sort());
});

test('a Mature pack alone is an installed pack: its marker supplies the server and the embedding model, and no chat tier is invented', () => {
  const lite = detectFolder({'manifest.mature-lite.json': matureLiteMarker}, ['llama/llama-server.exe', 'models/embed.gguf', 'models/uncensored-lite.gguf']);
  assert.deepEqual(lite, {installed: true, missing: [], root, server: at('llama/llama-server.exe'), tiers: {standard: null, lite: null},
    embed: {file: at('models/embed.gguf'), dim: 384, id: 'granite-embedding-107m-multilingual-q8_0'}, dev: false},
    'the Mature `lite` model is not the Local AI lite model');
  const standard = detectFolder({'manifest.mature-standard.json': matureStandardMarker}, ['llama/llama-server.exe', 'models/embed.gguf', 'models/uncensored-good.gguf']);
  assert.equal(standard.installed, true);
  assert.deepEqual(standard.tiers, {standard: null, lite: null});
  // Both Mature packs together.
  const both = detectFolder({'manifest.mature-lite.json': matureLiteMarker, 'manifest.mature-standard.json': matureStandardMarker},
    ['llama/llama-server.exe', 'models/embed.gguf', 'models/uncensored-lite.gguf', 'models/uncensored-good.gguf']);
  assert.equal(both.installed, true);
  // The embedding model is optional, as for the Local AI packs.
  const noEmbed = detectFolder({'manifest.mature-lite.json': matureLiteMarker}, ['llama/llama-server.exe', 'models/uncensored-lite.gguf']);
  assert.equal(noEmbed.installed, true); assert.equal(noEmbed.embed, null); assert.deepEqual(noEmbed.missing, ['embed']);
});

test('a Mature pack alone is not installed without its server or its model file, or with a marker that is not ours', () => {
  assert.equal(detectFolder({'manifest.mature-lite.json': matureLiteMarker}, ['models/embed.gguf', 'models/uncensored-lite.gguf']).installed, false, 'no server file');
  const noModel = detectFolder({'manifest.mature-lite.json': matureLiteMarker}, ['llama/llama-server.exe', 'models/embed.gguf']);
  assert.equal(noModel.installed, false); assert.deepEqual(noModel.missing, ['model']);
  const files = ['llama/llama-server.exe', 'models/embed.gguf', 'models/uncensored-lite.gguf'];
  for (const marker of [{...matureLiteMarker, pack: 'standard'}, {...matureLiteMarker, version: 2}, null, [], {...matureLiteMarker, server: 'C:\\Windows\\llama-server.exe'},
    {...matureLiteMarker, server: '../llama-server.exe'}]) {
    assert.equal(detectFolder({'manifest.mature-lite.json': marker}, files).installed, false, JSON.stringify(marker));
  }
  assert.equal(detectLocalAiPack({project, environment: {CYBERPUNK_CONVAI_LOCAL_AI: root}, exists: path => path === at('manifest.mature-lite.json') || files.map(at).includes(path),
    readText: () => '{not json'}).installed, false);
  // A model path that leaves the pack is not used either.
  const escaping = {...matureLiteMarker, lite: {file: '../outside/m.gguf', name: 'x'}};
  assert.equal(detectFolder({'manifest.mature-lite.json': escaping}, [...files, '../outside/m.gguf']).installed, false);
});

test('an older Mature marker without a server adds nothing: alone it is not an install, beside a Local AI pack nothing changes', () => {
  const files = ['llama/llama-server.exe', 'models/embed.gguf', 'models/uncensored-lite.gguf'];
  const alone = detectFolder({'manifest.mature-lite.json': oldMatureMarker}, files);
  assert.equal(alone.installed, false); assert.equal(alone.server, null); assert.deepEqual(alone.missing, ['server', 'model', 'embed']);
  const standard = {version: 1, server: manifest.server, standard: manifest.standard, embed: manifest.embed};
  const localFiles = ['llama/llama-server.exe', 'models/q4.gguf', 'models/embed.gguf'];
  const without = detectFolder({'manifest.standard.json': standard}, localFiles);
  const withOld = detectFolder({'manifest.standard.json': standard, 'manifest.mature-lite.json': oldMatureMarker}, [...localFiles, 'models/uncensored-lite.gguf']);
  assert.deepEqual(withOld, without, 'identical to the same install without the Mature marker');
  assert.equal(withOld.installed, true);
});

test('Mature and Local AI packs together: the Local AI manifest names the pieces first, the Mature marker never supplies a chat tier', () => {
  const standard = {version: 1, server: manifest.server, standard: manifest.standard, embed: manifest.embed};
  const files = ['llama/llama-server.exe', 'models/q4.gguf', 'models/embed.gguf', 'models/uncensored-lite.gguf'];
  const combined = detectFolder({'manifest.standard.json': standard, 'manifest.mature-lite.json': matureLiteMarker}, files);
  assert.equal(combined.installed, true);
  assert.equal(combined.tiers.standard.name, 'Qwen3.5-4B');
  assert.equal(combined.tiers.lite, null, 'the Mature lite model is not offered as the Local AI lite model');
  assert.equal(combined.embed.id, 'granite-embedding-107m-multilingual-q8_0');
  // The same install with the files named in the other order is identical.
  assert.deepEqual(detectFolder({'manifest.mature-lite.json': matureLiteMarker, 'manifest.standard.json': standard}, files), combined);
  // A Local AI pack whose standard model was deleted, beside a Mature pack: the engine still starts, for the Mature model.
  const noStandard = detectFolder({'manifest.standard.json': standard, 'manifest.mature-lite.json': matureLiteMarker},
    ['llama/llama-server.exe', 'models/embed.gguf', 'models/uncensored-lite.gguf']);
  assert.equal(noStandard.installed, true); assert.equal(noStandard.tiers.standard, null);
});

// ---- The engine in the Runtime (app/llama-cpp/, docs/LOCAL_AI.md "The engine is in the Runtime") --------------------------------------------------------------------------
const engineDir = resolve(project, RUNTIME_ENGINE_FOLDER);
const engineAt = name => resolve(engineDir, name);
const wholeEngine = ENGINE_FILES.map(engineAt);
const engineFolderSet = (fragments, files, engine = wholeEngine, environment = {CYBERPUNK_CONVAI_LOCAL_AI: root}) => {
  const present = new Set([...files.map(at), ...Object.keys(fragments).map(at), ...engine]);
  return detectLocalAiPack({project, environment, exists: path => present.has(path),
    readText: path => JSON.stringify(fragments[Object.keys(fragments).find(name => at(name) === path)])});
};
const standardFragment = {version: 1, server: manifest.server, standard: manifest.standard, embed: manifest.embed};
const modelsOnlyFragment = {version: 1, standard: manifest.standard, embed: manifest.embed};   // a pack built with localAi.server.inPacks false
const packFilesWithEngine = ['llama/llama-server.exe', 'models/q4.gguf', 'models/embed.gguf'];

test('the Runtime engine is used before the server an older pack carries, and says so', () => {
  const found = engineFolderSet({'manifest.standard.json': standardFragment}, packFilesWithEngine);
  assert.equal(found.installed, true);
  assert.equal(found.server, engineAt('llama-server.exe'));
  assert.deepEqual(found.engine, {source: 'runtime'});
  assert.deepEqual(found.missing, []);
});

test('an older Runtime (no app/llama-cpp) and an old pack behave exactly as before: the pack\'s server, no extra field', () => {
  const found = engineFolderSet({'manifest.standard.json': standardFragment}, packFilesWithEngine, []);
  assert.equal(found.server, at('llama/llama-server.exe'));
  assert.equal('engine' in found, false);
  assert.equal(found.installed, true);
});

test('a pack that carries models only runs on the Runtime\'s engine, and is not installed without it', () => {
  const found = engineFolderSet({'manifest.standard.json': modelsOnlyFragment}, ['models/q4.gguf', 'models/embed.gguf']);
  assert.equal(found.installed, true);
  assert.equal(found.server, engineAt('llama-server.exe'));
  const without = engineFolderSet({'manifest.standard.json': modelsOnlyFragment}, ['models/q4.gguf', 'models/embed.gguf'], []);
  assert.equal(without.installed, false);
  assert.deepEqual(without.missing, ['server']);
});

test('the new Runtime with no pack: the engine is there, nothing is installed, and the only things missing are the model and the embedding model (an own-server player is told nothing new)', () => {
  const found = engineFolderSet({}, []);
  assert.equal(found.installed, false);
  assert.equal(found.server, engineAt('llama-server.exe'));
  assert.deepEqual(found.missing, ['model', 'embed']);
  assert.deepEqual(found.tiers, {standard: null, lite: null});
  assert.equal(found.embed, null);
});

test('an engine that lost a file (an antivirus tool took a DLL) is passed over for the pack\'s own server, and the report names what is missing', () => {
  const lost = wholeEngine.filter(path => !path.endsWith('ggml-vulkan.dll'));
  const withPack = engineFolderSet({'manifest.standard.json': standardFragment}, packFilesWithEngine, lost);
  assert.equal(withPack.server, at('llama/llama-server.exe'));
  assert.deepEqual(withPack.engine, {source: 'pack', runtimeMissing: ['ggml-vulkan.dll']});
  assert.equal(withPack.installed, true);
  const modelsOnly = engineFolderSet({'manifest.standard.json': modelsOnlyFragment}, ['models/q4.gguf', 'models/embed.gguf'], lost);
  assert.equal(modelsOnly.installed, false);
  assert.equal(modelsOnly.server, null);
  assert.deepEqual(modelsOnly.engine, {source: null, runtimeMissing: ['ggml-vulkan.dll']});
});

test('Mature packs: a marker with no server counts when the Runtime has the engine, a Mature pack alone is installed, and an older marker without an engine still adds nothing', () => {
  const noServerMature = {version: 1, pack: 'mature', lite: matureLiteMarker.lite, embed: matureEmbed};
  const files = ['models/embed.gguf', 'models/uncensored-lite.gguf'];
  const alone = engineFolderSet({'manifest.mature-lite.json': noServerMature}, files);
  assert.equal(alone.installed, true);
  assert.equal(alone.server, engineAt('llama-server.exe'));
  assert.deepEqual(alone.tiers, {standard: null, lite: null});
  assert.equal(engineFolderSet({'manifest.mature-lite.json': noServerMature}, files, []).installed, false);
  // A Mature pack that still carries its own engine, beside the new Runtime: the Runtime's engine is the one used.
  const both = engineFolderSet({'manifest.mature-lite.json': matureLiteMarker}, ['llama/llama-server.exe', ...files]);
  assert.equal(both.server, engineAt('llama-server.exe'));
  // Local AI beside Mature, both models-only: one engine, both models.
  const together = engineFolderSet({'manifest.standard.json': modelsOnlyFragment, 'manifest.mature-lite.json': noServerMature}, ['models/q4.gguf', ...files]);
  assert.equal(together.installed, true);
  assert.equal(together.tiers.standard.name, 'Qwen3.5-4B');
  assert.equal(together.server, engineAt('llama-server.exe'));
});

test('a developer\'s folder keeps its own engine, and CYBERPUNK_CONVAI_LOCAL_ENGINE names the Runtime folder', () => {
  const devRoot = resolve('dev-fixture');
  const dev = file => resolve(devRoot, file);
  const present = new Set([dev('llama-vulkan/llama-server.exe'), dev('dl-gemma4-e4b/m.gguf'), ...wholeEngine]);
  const found = detectLocalAiPack({project, environment: {CYBERPUNK_CONVAI_LOCAL_AI_DEV: devRoot}, exists: path => present.has(path),
    list: folder => (folder === dev('dl-gemma4-e4b') ? ['m.gguf'] : [])});
  assert.equal(found.dev, true);
  assert.equal(found.server, dev('llama-vulkan/llama-server.exe'), 'the developer\'s engine, not the Runtime\'s');
  assert.equal(found.engine.source, 'pack');
  const elsewhere = resolve('engine-elsewhere');
  const named = engineFolderSet({'manifest.standard.json': modelsOnlyFragment}, ['models/q4.gguf'], ENGINE_FILES.map(name => resolve(elsewhere, name)),
    {CYBERPUNK_CONVAI_LOCAL_AI: root, [LOCAL_AI_ENV.engine]: elsewhere});
  assert.equal(named.server, resolve(elsewhere, 'llama-server.exe'));
  assert.equal(runtimeEngineFolder({project, environment: {}}), engineDir);
  assert.equal(runtimeEngineFolder({environment: {}}), null);
});

test('the engine files the bridge requires are the ones the release requires, and the folder is the one the build writes', async () => {
  const {readFile} = await import('node:fs/promises');
  const server = JSON.parse(await readFile(new URL('../packaging/release.config.json', import.meta.url), 'utf8')).localAi.server;
  for (const name of ENGINE_FILES) assert(server.require.includes(name), `${name} is in localAi.server.require`);
  for (const name of ['llama-fit-params.exe', 'llama-fit-params-impl.dll']) assert(server.require.includes(name), `${name} ships with the engine`);
  assert.equal(server.runtimeFolder, RUNTIME_ENGINE_FOLDER);
  // The fit tool is found beside the Runtime's server (bridge/local-vram-fit.mjs), so the free-memory fit works on the engine a pack no longer carries.
  const {fitToolPath} = await import('./local-vram-fit.mjs');
  assert.equal(fitToolPath(engineAt('llama-server.exe'), {exists: path => path === engineAt('llama-fit-params.exe'), platform: 'win32'}), engineAt('llama-fit-params.exe'));
});

test('describePackFiles and packPlaceLines say where the engine came from', () => {
  const present = new Set([...wholeEngine, at('manifest.standard.json'), at('models/q4.gguf'), at('models/embed.gguf')]);
  const options = {project, environment: {CYBERPUNK_CONVAI_LOCAL_AI: root}, exists: path => present.has(path), readText: () => JSON.stringify(modelsOnlyFragment), sizeOf: () => 1, list: () => []};
  assert.deepEqual(describePackFiles(options).engine, [{piece: 'server', source: 'runtime'}]);
  assert.match(packPlaceLines(options).join('\n'), /the Runtime's engine/);
  present.delete(engineAt('ggml.dll'));
  assert.deepEqual(describePackFiles(options).engine, [{piece: 'server', source: null, runtimeMissing: ['ggml.dll']}]);
  assert.match(packPlaceLines(options).join('\n'), /Runtime's engine is incomplete \(missing: ggml\.dll\); no server to use/);
});
