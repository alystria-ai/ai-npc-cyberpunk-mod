// Vision projector discovery (bridge/local-projector.mjs): what a model's projector is, from its manifest entry or from the folder, and that it really is one (GGUF header).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {PROJECTOR_LIMITS, createProjectorFinder, defaultProjectorFinder, findProjector, isProjectorFile, looksLikeProjector, noProjector} from './local-projector.mjs';
import {describeLocalModels, listLocalModels} from './local-model-choice.mjs';
import {detectLocalAiPack} from './local-ai-pack.mjs';
import {detectMaturePack} from './mature-pack.mjs';
import {ggufFile} from './fixtures/gguf-header.mjs';

// An in-memory folder: path -> Buffer. `files` is what findProjector reads.
function memory(entries) {
  const table = new Map(Object.entries(entries).map(([path, value]) => [resolve(path), value]));
  return {
    list: folder => [...table.keys()].filter(path => resolve(path, '..') === resolve(folder)).map(path => path.split(/[\\/]/).pop()),
    stat: path => (table.has(resolve(path)) ? {size: table.get(resolve(path)).length, mtimeMs: 1} : null),
    head: (path, length) => table.get(resolve(path)).subarray(0, length),
  };
}
const model = ggufFile('gemma4');
const clip = ggufFile('clip');

test('a projector is a .gguf with mmproj in its name, whatever the case', () => {
  assert.equal(looksLikeProjector('mmproj-F16.gguf'), true);
  assert.equal(looksLikeProjector('gemma-4-E4B-MMPROJ-Q8.GGUF'), true);
  assert.equal(looksLikeProjector('gemma-4-E4B.gguf'), false);
  assert.equal(looksLikeProjector('mmproj-F16.bin'), false);
});

test('the header decides: clip is a projector, a chat model, a broken file and a short file are not', () => {
  const files = memory({'/m/ok.gguf': clip, '/m/chat.gguf': model, '/m/broken.gguf': Buffer.from('this is not a gguf file at all, only text'), '/m/tiny.gguf': Buffer.from('GGUF'),
    '/m/magic.gguf': ggufFile('clip', {magic: 'GGML'}), '/m/mmproj-alias.gguf': ggufFile('mmproj'), '/m/Upper.gguf': ggufFile('CLIP')});
  assert.equal(isProjectorFile('/m/ok.gguf', files), true);
  assert.equal(isProjectorFile('/m/mmproj-alias.gguf', files), true, 'llama.cpp also calls it mmproj');
  assert.equal(isProjectorFile('/m/Upper.gguf', files), true);
  for (const name of ['chat', 'broken', 'tiny', 'magic', 'absent']) assert.equal(isProjectorFile(`/m/${name}.gguf`, files), false, name);
  assert.equal(isProjectorFile(null, files), false);
  assert.equal(isProjectorFile('/m/ok.gguf', {stat: () => { throw new Error('boom'); }, head: () => clip}), false, 'a reader that throws means no projector');
});

test('auto-discovery: one projector beside a lone model is found, and only then', () => {
  const file = resolve('/m/gemma.gguf');
  const found = files => findProjector({file}, memory(files));
  assert.equal(found({'/m/gemma.gguf': model, '/m/mmproj-F16.gguf': clip}), resolve('/m/mmproj-F16.gguf'));
  assert.equal(found({'/m/gemma.gguf': model, '/m/GEMMA-MMPROJ-Q8.GGUF': clip}), resolve('/m/GEMMA-MMPROJ-Q8.GGUF'), 'any case');
  assert.equal(found({'/m/gemma.gguf': model}), null, 'no projector file');
  assert.equal(found({'/m/gemma.gguf': model, '/m/other.gguf': model, '/m/mmproj.gguf': clip}), null, 'two models in the folder: it is not clear whose it is');
  assert.equal(found({'/m/gemma.gguf': model, '/m/mmproj-a.gguf': clip, '/m/mmproj-b.gguf': clip}), null, 'two projectors');
  assert.equal(found({'/m/gemma.gguf': model, '/m/mmproj.gguf': model}), null, 'a file called mmproj that is not a projector (bad header)');
  assert.equal(found({'/m/gemma.gguf': model, '/m/mmproj.gguf': Buffer.from('plain text of a mislabelled file, long enough')}), null, 'not a GGUF at all');
  assert.equal(found({'/m/gemma.gguf': model, '/m/notes.txt': Buffer.from('x'), '/m/mmproj.gguf': clip}), resolve('/m/mmproj.gguf'), 'other kinds of files do not count');
  assert.equal(found({'/m/mmproj.gguf': clip, '/m/not-this-one.gguf': model}), null, 'the lone model is not the model asked about');
  assert.equal(findProjector({file}, {...memory({'/m/gemma.gguf': model, '/m/mmproj.gguf': clip}), list: () => { throw new Error('no folder'); }}), null, 'an unreadable folder means none');
  assert.equal(findProjector({file, auto: false}, memory({'/m/gemma.gguf': model, '/m/mmproj.gguf': clip})), null, 'auto off (a Mature model): never looked for');
});

test('a projector the manifest names is used when it is a projector, and a bad one is not replaced by a discovered one', () => {
  const files = memory({'/m/gemma.gguf': model, '/m/mmproj.gguf': clip, '/m/named.gguf': clip, '/m/bad.gguf': model});
  const file = resolve('/m/gemma.gguf');
  assert.equal(findProjector({file, declared: resolve('/m/named.gguf')}, files), resolve('/m/named.gguf'), 'the named file wins over the one beside the model');
  assert.equal(findProjector({file, declared: resolve('/m/bad.gguf')}, files), null, 'named but not a projector: none, the file beside it is not used instead');
  assert.equal(findProjector({file, declared: resolve('/m/gone.gguf')}, files), null, 'named but missing: none');
  assert.equal(findProjector({file, declared: resolve('/m/named.gguf'), auto: false}, files), resolve('/m/named.gguf'), 'a Mature model whose marker names one has it');
  assert.equal(findProjector({file: null}, files), null);
});

test('the finder remembers an answer for a short while and asks the disk again afterwards', () => {
  let clock = 0, reads = 0;
  const table = {'/m/gemma.gguf': model, '/m/mmproj.gguf': clip};
  const base = memory(table);
  const finder = createProjectorFinder({files: {...base, list: folder => { reads++; return base.list(folder); }}, now: () => clock, cacheMs: 1000});
  const file = resolve('/m/gemma.gguf');
  assert.equal(finder(file), resolve('/m/mmproj.gguf'));
  clock = 900; finder(file); finder(file);
  assert.equal(reads, 1, 'asked again within the window: no disk');
  assert.equal(finder(file, null, {auto: false}), null, 'auto off is a different question');
  clock = 1500; finder(file);
  assert.equal(reads === 2 || reads === 3, true, 'after the window the folder is read again');
  assert.equal(finder(''), null);
  assert.equal(noProjector(), null);
  assert.equal(PROJECTOR_LIMITS.cacheMs > 0, true);
  assert.equal(typeof defaultProjectorFinder, 'function');
});

// ---- listLocalModels carries it --------------------------------------------------------------------------------------------------------------------
test('every model of the list carries its projector (a path) or null, and the published list says only hasVision', () => {
  const finds = new Map([[resolve('/p/models/q4.gguf'), resolve('/p/models/q4-mmproj.gguf')], [resolve('/c/own.gguf'), resolve('/c/own-mmproj.gguf')]]);
  const calls = [];
  const findProjector = (file, declared, options = {}) => { calls.push({file, declared, auto: options.auto !== false}); return declared ?? finds.get(file) ?? null; };
  const pack = {tiers: {standard: {file: resolve('/p/models/q4.gguf'), name: 'Std'}, lite: {file: resolve('/p/models/q2.gguf'), name: 'Lite', mmproj: resolve('/p/models/lite-mmproj.gguf')}}};
  const matureModels = [{tier: 'good', file: resolve('/p/models/m.gguf'), name: 'M-uncensored', present: true}, {tier: 'lite', file: resolve('/p/models/ml.gguf'), name: 'ML', present: true, mmproj: resolve('/p/models/ml-mmproj.gguf')}];
  const customModels = [{id: 'custom:own', name: 'Own', file: resolve('/c/own.gguf')}, {id: 'custom:srv', name: 'Server', external: true, endpoint: 'http://127.0.0.1:5001/v1', origin: 'http://127.0.0.1:5001'}];
  const models = listLocalModels({pack, matureModels, customModels, findProjector});
  const byId = Object.fromEntries(models.map(item => [item.id, item.mmproj]));
  assert.deepEqual(byId, {standard: resolve('/p/models/q4-mmproj.gguf'), lite: resolve('/p/models/lite-mmproj.gguf'), 'mature:lite': resolve('/p/models/ml-mmproj.gguf'), 'mature:good': null,
    'custom:own': resolve('/c/own-mmproj.gguf'), 'custom:srv': null});
  assert.equal(calls.filter(call => call.auto === false).length, 2, 'a Mature model is never looked for beside itself');
  assert.equal(calls.some(call => call.file === null), false, 'a server of the player is not asked');
  const described = describeLocalModels(models, () => 4000);
  assert.deepEqual(described.filter(entry => entry.hasVision).map(entry => entry.id).sort(), ['custom:own', 'lite', 'mature:lite', 'standard']);
  assert.equal(JSON.stringify(described).includes('mmproj'), false, 'no path leaves the list');
  assert.equal(described.find(entry => entry.id === 'custom:srv').hasVision, undefined, 'a server of the player has no projector of ours');
  // Without a finder the real files are asked: a path that is not there has none.
  assert.equal(listLocalModels({pack: {tiers: {standard: {file: resolve('/no/such/folder/x.gguf'), name: 'X'}}}})[0].mmproj, null);
});

// ---- The real files: pack manifests and the Mature marker ----------------------------------------------------------------------------------------
test('a pack manifest that names a projector hands it to the tier, with the same path rules as the model file; a bad path costs the projector only', () => {
  const root = resolve('pack-fixture');
  const manifest = {version: 1, server: 'llama/llama-server.exe',
    standard: {file: 'models/q4.gguf', name: 'Std', mmproj: 'models/q4-mmproj.gguf'}, lite: {file: 'models/q2.gguf', name: 'Lite', mmproj: '../outside/m.gguf'}};
  const names = ['llama/llama-server.exe', 'models/q4.gguf', 'models/q2.gguf', 'models/q4-mmproj.gguf'].map(name => resolve(root, name));
  const manifestPath = resolve(root, 'manifest.json');
  const found = detectLocalAiPack({project: root, environment: {CYBERPUNK_CONVAI_LOCAL_AI: root}, exists: path => path === manifestPath || names.includes(path), readText: () => JSON.stringify(manifest)});
  assert.equal(found.installed, true);
  assert.equal(found.tiers.standard.mmproj, resolve(root, 'models/q4-mmproj.gguf'));
  assert.equal('mmproj' in found.tiers.lite, false, 'a path with .. is dropped, the model stays');
  assert.deepEqual(Object.keys(found.tiers.lite).sort(), ['file', 'name']);
  const absolute = detectLocalAiPack({project: root, environment: {CYBERPUNK_CONVAI_LOCAL_AI: root}, exists: path => path === manifestPath || names.includes(path),
    readText: () => JSON.stringify({...manifest, standard: {file: 'models/q4.gguf', name: 'Std', mmproj: 'C:/elsewhere/p.gguf'}})});
  assert.equal('mmproj' in absolute.tiers.standard, false, 'a drive path is not allowed in a pack manifest');
  // The listed model carries it through the finder: the manifest's word, checked by the header.
  const files = memory({[resolve(root, 'models/q4-mmproj.gguf')]: clip, [resolve(root, 'models/q4.gguf')]: model, [resolve(root, 'models/q2.gguf')]: model});
  const list = listLocalModels({pack: found, findProjector: (file, declared) => findProjector({file, declared}, files)});
  assert.deepEqual(list.map(item => [item.id, item.mmproj]), [['standard', resolve(root, 'models/q4-mmproj.gguf')], ['lite', null]]);
  // A named file that is not a projector means none.
  const wrongFiles = memory({[resolve(root, 'models/q4-mmproj.gguf')]: model, [resolve(root, 'models/q4.gguf')]: model});
  assert.equal(listLocalModels({pack: found, findProjector: (file, declared) => findProjector({file, declared}, wrongFiles)})[0].mmproj, null);
});

test('a Mature pack model has a projector only when its marker names one', () => {
  const root = resolve('C:/game/local-ai');
  const marker = {version: 1, pack: 'mature', lite: {file: 'models/a.gguf', name: 'A', mmproj: 'models/a-mmproj.gguf'}, good: {file: 'models/b.gguf', name: 'B'}};
  const files = {[resolve(root, 'manifest.mature.json')]: JSON.stringify(marker)};
  const found = detectMaturePack({project: 'C:/game', environment: {}, exists: path => path in files, readText: path => files[path]});
  assert.equal(found.models.find(item => item.tier === 'lite').mmproj, resolve(root, 'models/a-mmproj.gguf'));
  assert.equal('mmproj' in found.models.find(item => item.tier === 'good'), false);
  const badPath = JSON.stringify({...marker, lite: {...marker.lite, mmproj: '../x.gguf'}});
  const other = detectMaturePack({project: 'C:/game', environment: {}, exists: path => path === resolve(root, 'manifest.mature.json'), readText: () => badPath});
  assert.equal('mmproj' in other.models.find(item => item.tier === 'lite'), false, 'a path outside the pack is dropped');
});

test('discovery on a real folder: the model, its projector and nothing else', () => {
  const folder = mkdtempSync(join(tmpdir(), 'projector-test-'));
  try {
    mkdirSync(join(folder, 'one'));
    writeFileSync(join(folder, 'one', 'gemma.gguf'), model);
    writeFileSync(join(folder, 'one', 'mmproj-F16.gguf'), clip);
    assert.equal(defaultProjectorFinder(join(folder, 'one', 'gemma.gguf')), join(folder, 'one', 'mmproj-F16.gguf'));
    mkdirSync(join(folder, 'bad'));
    writeFileSync(join(folder, 'bad', 'gemma.gguf'), model);
    writeFileSync(join(folder, 'bad', 'mmproj-F16.gguf'), model);
    assert.equal(findProjector({file: join(folder, 'bad', 'gemma.gguf')}), null, 'a projector with a chat model header is refused');
  } finally { rmSync(folder, {recursive: true, force: true}); }
});
