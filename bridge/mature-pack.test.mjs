// The Mature pack marker: the pack is installed when a valid manifest.mature.json sits in the Local AI folder, and only then.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {MATURE_MARKER, MATURE_TIERS, detectMaturePack} from './mature-pack.mjs';
import {LOCAL_AI_ENV} from './local-ai-pack.mjs';

const marker = (extra = {}) => ({version: 1, pack: 'mature', lite: {file: 'models/a.gguf', name: 'A', family: 'qwen'}, good: {file: 'models/b.gguf', name: 'B', family: 'gemma'}, ...extra});
// A detector over an in-memory folder: `files` maps absolute paths to text.
const memory = files => ({exists: path => path in files, readText: path => { if (!(path in files)) throw new Error('missing'); return files[path]; }});
const root = resolve('C:/game/local-ai');
const markerPath = resolve(root, MATURE_MARKER);

test('the marker is next to the Local AI manifests under its own name', () => {
  assert.equal(MATURE_MARKER, 'manifest.mature.json');
  assert.notEqual(MATURE_MARKER, 'manifest.standard.json');
  assert.notEqual(MATURE_MARKER, 'manifest.lite.json');
});

test('no marker, no pack: the models alone do not count', () => {
  const result = detectMaturePack({project: 'C:/game', environment: {}, ...memory({[resolve(root, 'models/a.gguf')]: ''})});
  assert.deepEqual(result, {installed: false, root, models: []});
});

test('a malformed, empty or foreign marker is not the pack', () => {
  for (const text of ['', 'not json', '[]', 'null', '42', JSON.stringify({version: 2, pack: 'mature'}), JSON.stringify({version: 1, pack: 'standard'}),
    JSON.stringify({pack: 'mature'}), JSON.stringify({version: 1})]) {
    assert.equal(detectMaturePack({project: 'C:/game', environment: {}, ...memory({[markerPath]: text})}).installed, false, text);
  }
});

test('a valid marker is the pack, and lists its models with whether each file is there', () => {
  const text = JSON.stringify(marker({good: {file: 'models\\b.gguf', name: 'B', family: 'gemma'}}));
  const result = detectMaturePack({project: 'C:/game', environment: {}, ...memory({[markerPath]: text, [resolve(root, 'models/a.gguf')]: ''})});
  assert.equal(result.installed, true);
  assert.equal(result.root, root);
  assert.deepEqual(result.models.map(model => [model.tier, model.name, model.family, model.present]), [['lite', 'A', 'qwen', true], ['good', 'B', 'gemma', false]]);
  assert.deepEqual(MATURE_TIERS, ['lite', 'good']);
  // The marker alone makes it installed: a split model is joined later, so a model file is not required.
  assert.equal(detectMaturePack({project: 'C:/game', environment: {}, ...memory({[markerPath]: JSON.stringify(marker({lite: undefined, good: undefined}))})}).installed, true);
  assert.equal(detectMaturePack({project: 'C:/game', environment: {}, ...memory({[markerPath]: JSON.stringify({version: 1, pack: 'mature'})})}).installed, true);
});

test('a model path that leaves the pack folder is dropped, the rest of the marker still counts', () => {
  const bad = ['../outside.gguf', 'models/../../x.gguf', 'C:/elsewhere/x.gguf', '/abs/x.gguf', '\\\\share\\x.gguf', '', '  ', 7, null, undefined];
  for (const file of bad) {
    const text = JSON.stringify(marker({lite: {file, name: 'bad'}, good: {file: 'models/ok.gguf', name: 'ok', family: 'qwen'}}));
    const result = detectMaturePack({project: 'C:/game', environment: {}, ...memory({[markerPath]: text})});
    assert.equal(result.installed, true, String(file));
    assert.deepEqual(result.models.map(model => [model.tier, model.name]), [['good', 'ok']], String(file));
  }
});

test('the Local AI folder follows the environment override, like the Local AI packs', () => {
  const other = resolve('D:/elsewhere/local-ai');
  const files = {[resolve(other, MATURE_MARKER)]: JSON.stringify(marker())};
  assert.equal(detectMaturePack({project: 'C:/game', environment: {[LOCAL_AI_ENV.root]: other}, ...memory(files)}).installed, true);
  assert.equal(detectMaturePack({project: 'C:/game', environment: {}, ...memory(files)}).installed, false, 'not in the project folder');
});

test('the real filesystem: a marker in a folder is found, deleting it loses the pack', async () => {
  const project = await mkdtemp(join(tmpdir(), 'mature-pack-'));
  try {
    const folder = join(project, 'local-ai');
    await mkdir(join(folder, 'models'), {recursive: true});
    assert.equal(detectMaturePack({project, environment: {}}).installed, false);
    await writeFile(join(folder, MATURE_MARKER), JSON.stringify(marker()));
    await writeFile(join(folder, 'models', 'a.gguf'), 'x');
    const found = detectMaturePack({project, environment: {}});
    assert.equal(found.installed, true);
    assert.equal(found.models[0].tier, 'lite');
    assert.equal(found.models[0].present, true);
    assert.equal(found.models[1].present, false);
    await rm(join(folder, MATURE_MARKER));
    assert.equal(detectMaturePack({project, environment: {}}).installed, false);
  } finally { await rm(project, {recursive: true, force: true}); }
});

test('a development checkout finds the marker in the developer Local AI folder when the real pack folder has none', () => {
  const dev = resolve('E:/dev/local-llm');
  const text = JSON.stringify(marker({lite: {file: 'mature/a.gguf', name: 'A-Uncensored', family: 'qwen'}, good: undefined}));
  const files = {[resolve(dev, MATURE_MARKER)]: text, [resolve(dev, 'mature/a.gguf')]: ''};
  const found = detectMaturePack({project: 'C:/game', environment: {CYBERPUNK_CONVAI_LOCAL_AI_DEV: dev}, ...memory(files)});
  assert.equal(found.installed, true);
  assert.equal(found.root, dev);
  assert.deepEqual(found.models.map(model => [model.name, model.present]), [['A-Uncensored', true]]);
  // The real pack wins when both have a marker, and an explicit pack folder never falls back to the developer one.
  const both = {...files, [markerPath]: JSON.stringify(marker({lite: undefined, good: undefined}))};
  assert.equal(detectMaturePack({project: 'C:/game', environment: {CYBERPUNK_CONVAI_LOCAL_AI_DEV: dev}, ...memory(both)}).root, root);
  assert.equal(detectMaturePack({project: 'C:/game', environment: {CYBERPUNK_CONVAI_LOCAL_AI: 'C:/game/local-ai', CYBERPUNK_CONVAI_LOCAL_AI_DEV: dev}, ...memory(files)}).installed, false);
});

test('a marker with the old models list and no lite or good is still the pack, with no models', () => {
  const text = JSON.stringify({version: 1, pack: 'mature', models: [{file: 'models/a.gguf', name: 'A', family: 'qwen'}, {file: 'models/b.gguf', name: 'B', family: 'gemma'}]});
  const result = detectMaturePack({project: 'C:/game', environment: {}, ...memory({[markerPath]: text, [resolve(root, 'models/a.gguf')]: ''})});
  assert.equal(result.installed, true);
  assert.deepEqual(result.models, []);
});

test('only lite and good are read: at most two models, lite first, and any other entry in the marker is ignored', () => {
  const text = JSON.stringify(marker({huge: {file: 'models/c.gguf', name: 'C'}, models: [{file: 'models/d.gguf', name: 'D'}]}));
  const result = detectMaturePack({project: 'C:/game', environment: {}, ...memory({[markerPath]: text})});
  assert.deepEqual(result.models.map(model => [model.tier, model.name]), [['lite', 'A'], ['good', 'B']]);
  // Either tier alone is fine.
  const onlyGood = detectMaturePack({project: 'C:/game', environment: {}, ...memory({[markerPath]: JSON.stringify(marker({lite: undefined}))})});
  assert.deepEqual(onlyGood.models.map(model => model.tier), ['good']);
});
