import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {detectLocalAiPack} from './local-ai-pack.mjs';

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
