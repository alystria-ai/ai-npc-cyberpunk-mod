// Mod Organizer 2, voice-input (microphone) packs installed as separate MO2 mods (node --test packaging/mo2-mic-packs.test.mjs).
//
// The packs MicPack-European and MicPack-Asian unpack into app/models/stt/<id>. The service used to read them from the Runtime's own real app folder only, so a pack
// installed as its own MO2 mod was missed. Now the service names the VIRTUAL app/models/stt in CYBERPUNK_CONVAI_STT_PACKS (every mod's <id> folders, listed merged) and
// bridge/local-stt.mjs maps each model file to its real place and gives the worker the one real folder that holds the most of a model's files (llama-server's DLLs get the
// same treatment). There is no USVFS here: the merge is simulated with the `exists` and `realPath` functions resolveLocalSttPaths takes, one file at a time in priority order.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {LocalStt, MOONSHINE_ENGINE, resolveLocalSttPaths} from '../bridge/local-stt.mjs';
import {LOCAL_PACKS} from '../bridge/speech-language.mjs';
import {installLayout, serviceEnvironment} from './runtime/prepare-state.mjs';

const EUROPEAN = LOCAL_PACKS.find(pack => pack.id === 'parakeet-tdt-0.6b-v3-int8');
const ASIAN = LOCAL_PACKS.find(pack => pack.id === 'sense-voice-int8');
const USVFS = {CYBERPUNK_CONVAI_USVFS: '1'};

/** mods: [{name, files: {'<id>/<file>': text}}], highest priority first; builds mods/<name>/.../app/models/stt/<id>/<file> and the virtual app/models/stt folder (nothing on disk). */
function mo2(t, mods) {
  const base = mkdtempSync(join(tmpdir(), 'mo2 mic packs '));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  const virtual = join(base, 'Cyberpunk 2077', 'red4ext', 'plugins', 'AiNpcCyberpunkMod', 'app', 'models', 'stt');
  const roots = mods.map(mod => join(base, 'MO2', 'mods', mod.name, 'red4ext', 'plugins', 'AiNpcCyberpunkMod', 'app', 'models', 'stt'));
  mods.forEach((mod, index) => {
    mkdirSync(roots[index], {recursive: true});
    for (const [name, text] of Object.entries(mod.files)) {
      const path = join(roots[index], name);
      mkdirSync(dirname(path), {recursive: true});
      writeFileSync(path, text);
    }
  });
  const inside = path => { const rel = relative(virtual, resolve(path)); return rel.startsWith('..') || /^[a-z]:/i.test(rel) ? null : rel; };
  const real = path => { const rel = inside(path); if (rel === null) return null; for (const root of roots) { const candidate = join(root, rel); if (existsSync(candidate)) return candidate; } return null; };
  return {virtual, roots,
    exists: path => (inside(path) === null ? existsSync(path) : Boolean(real(path))),
    realPath: path => (inside(path) === null ? path : real(path) ?? path),
    environment: {...USVFS, CYBERPUNK_CONVAI_STT_PACKS: virtual}};
}
const packFiles = (pack, {only = pack.files} = {}) => Object.fromEntries(only.map(name => [`${pack.id}/${name}`, name]));
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const paths = (f, engine, project = join(dirname(f.virtual), 'no-project')) => resolveLocalSttPaths({project, environment: f.environment, engine, exists: f.exists, realPath: f.realPath});

test('the pack is its own mod and the Runtime is another: the model folder is the pack mod\'s real folder, whichever has priority', t => {
  for (const order of [['Runtime', 'MicPack-European'], ['MicPack-European', 'Runtime']]) {
    const f = mo2(t, order.map(name => ({name, files: name === 'Runtime' ? {[`${MOONSHINE_ENGINE.id}/tokens.txt`]: 'english'} : packFiles(EUROPEAN)})));
    const result = paths(f, EUROPEAN);
    assert.ok(same(result.modelDirectory, join(f.roots[order.indexOf('MicPack-European')], EUROPEAN.id)), `${order}: ${result.modelDirectory}`);
    assert.deepEqual(result.place, {looked: join(f.virtual, EUROPEAN.id), count: EUROPEAN.files.length, of: EUROPEAN.files.length});
    // Every file the worker reads is a real file of that folder.
    for (const name of EUROPEAN.files) assert.ok(existsSync(join(result.modelDirectory, name)), name);
  }
});

test('both packs, each its own mod: each model runs from its own mod folder and the recogniser is available', t => {
  const f = mo2(t, [{name: 'MicPack-Asian', files: packFiles(ASIAN)}, {name: 'MicPack-European', files: packFiles(EUROPEAN)}]);
  const european = paths(f, EUROPEAN), asian = paths(f, ASIAN);
  assert.ok(same(european.modelDirectory, join(f.roots[1], EUROPEAN.id)));
  assert.ok(same(asian.modelDirectory, join(f.roots[0], ASIAN.id)));
  // The bridge asks LocalStt.availability(); only the model folder matters here (python, worker and sherpa are real files of the Runtime).
  const runtime = mkdtempSync(join(tmpdir(), 'mo2 mic runtime '));
  t.after(() => rmSync(runtime, {recursive: true, force: true}));
  for (const file of ['python/python.exe', 'bridge/local-stt-worker.py']) { mkdirSync(dirname(join(runtime, file)), {recursive: true}); writeFileSync(join(runtime, file), ''); }
  mkdirSync(join(runtime, 'python/Lib/site-packages/sherpa_onnx'), {recursive: true});
  for (const [engine, expected] of [[EUROPEAN, european], [ASIAN, asian]]) {
    const stt = new LocalStt({project: runtime, pythonExecutable: join(runtime, 'python/python.exe'), engine, environment: {...f.environment},
      paths: {...paths(f, engine, runtime), python: join(runtime, 'python/python.exe')}});
    assert.deepEqual(stt.availability(), {available: true, reason: null}, engine.id);
    assert.equal(stt.paths.modelDirectory, expected.modelDirectory);
  }
});

test('a model whose files are in two mods comes from the most complete folder; a tie goes to the folder of the first file; a model complete in none is not available', t => {
  // The pack mod complete, another mod with a stray file of the same model, either priority: the complete folder.
  for (const order of [['Stray', 'MicPack-Asian'], ['MicPack-Asian', 'Stray']]) {
    const f = mo2(t, order.map(name => ({name, files: name === 'Stray' ? packFiles(ASIAN, {only: ['tokens.txt']}) : packFiles(ASIAN)})));
    const result = paths(f, ASIAN);
    assert.ok(same(result.modelDirectory, join(f.roots[order.indexOf('MicPack-Asian')], ASIAN.id)), order.join(' > '));
    assert.equal(result.place.count, ASIAN.files.length);
  }
  // Three of four files in one mod: that mod, though the model is not complete there (the worker could not read it).
  const split = mo2(t, [{name: 'Most', files: packFiles(EUROPEAN, {only: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx']})}, {name: 'Rest', files: packFiles(EUROPEAN, {only: ['tokens.txt']})}]);
  const result = paths(split, EUROPEAN);
  assert.ok(same(result.modelDirectory, join(split.roots[0], EUROPEAN.id)));
  assert.deepEqual([result.place.count, result.place.of], [3, 4]);
  const incomplete = new LocalStt({project: '.', pythonExecutable: 'python.exe', engine: EUROPEAN, paths: {...result, python: 'python.exe', worker: 'w.py'}, exists: path => existsSync(path) || /python|w\.py|sherpa/.test(path)});
  assert.equal(incomplete.availability().reason, 'model-missing');
  // A two-two tie: the folder of the first file of the model.
  const tie = mo2(t, [{name: 'Tail', files: packFiles(EUROPEAN, {only: ['joiner.int8.onnx', 'tokens.txt']})}, {name: 'Head', files: packFiles(EUROPEAN, {only: ['encoder.int8.onnx', 'decoder.int8.onnx']})}]);
  assert.ok(same(paths(tie, EUROPEAN).modelDirectory, join(tie.roots[1], EUROPEAN.id)));
});

test('a pack that is nowhere: no folder claimed from the mods, and the Runtime\'s own folder is still looked at', t => {
  const f = mo2(t, [{name: 'Runtime', files: {[`${MOONSHINE_ENGINE.id}/tokens.txt`]: 'english'}}]);
  const result = paths(f, EUROPEAN);
  assert.equal(result.place.count, 0);
  assert.ok(same(result.modelDirectory, join(f.virtual, EUROPEAN.id)), 'nothing found: the first place looked at, as before');
  // The pack merged into the Runtime's own mod folder (the old way) still works: the project folder is the second place looked at.
  const project = mkdtempSync(join(tmpdir(), 'mo2 mic project '));
  t.after(() => rmSync(project, {recursive: true, force: true}));
  for (const name of EUROPEAN.files) { mkdirSync(join(project, 'models/stt', EUROPEAN.id), {recursive: true}); writeFileSync(join(project, 'models/stt', EUROPEAN.id, name), name); }
  const merged = resolveLocalSttPaths({project, environment: f.environment, engine: EUROPEAN, exists: f.exists, realPath: f.realPath});
  assert.ok(same(merged.modelDirectory, join(project, 'models/stt', EUROPEAN.id)));
});

// The result before this change, copied: the physical install must not move.
function oldResolve({project, environment, pythonExecutable, engine}) {
  const python = environment.CYBERPUNK_CONVAI_LOCAL_STT_PYTHON || pythonExecutable || environment.CYBERPUNK_CONVAI_PYTHON || null;
  const english = engine.kind === 'moonshine';
  const candidates = [english ? environment.CYBERPUNK_CONVAI_STT_MODEL : environment.CYBERPUNK_CONVAI_STT_PACKS && resolve(environment.CYBERPUNK_CONVAI_STT_PACKS, engine.id),
    project && resolve(project, 'models/stt', engine.id), project && resolve(project, 'runtime/stt-model', engine.id)].filter(Boolean);
  const modelDirectory = candidates.find(path => engine.files.every(name => existsSync(resolve(path, name)))) ?? candidates[0] ?? null;
  return {python, modelDirectory, worker: project ? resolve(project, 'bridge/local-stt-worker.py') : null};
}

test('a physical install is unchanged: the same result as before, with and without a packs folder, complete or not', t => {
  const project = mkdtempSync(join(tmpdir(), 'mo2 mic physical '));
  const extra = mkdtempSync(join(tmpdir(), 'mo2 mic extra '));
  t.after(() => { rmSync(project, {recursive: true, force: true}); rmSync(extra, {recursive: true, force: true}); });
  const put = (root, pack, names) => { for (const name of names) { mkdirSync(join(root, pack.id), {recursive: true}); writeFileSync(join(root, pack.id, name), name); } };
  put(join(project, 'models/stt'), EUROPEAN, EUROPEAN.files);
  put(join(project, 'models/stt'), ASIAN, ['tokens.txt']);
  put(extra, ASIAN, ASIAN.files);
  for (const environment of [{}, {CYBERPUNK_CONVAI_STT_PACKS: extra}, {CYBERPUNK_CONVAI_USVFS: '0', CYBERPUNK_CONVAI_STT_PACKS: extra}, {CYBERPUNK_CONVAI_PYTHON: 'p.exe'}]) {
    for (const engine of [EUROPEAN, ASIAN, MOONSHINE_ENGINE]) {
      const arguments_ = {project, environment, pythonExecutable: 'x.exe', engine};
      assert.deepEqual(resolveLocalSttPaths(arguments_), oldResolve(arguments_), `${engine.id} ${JSON.stringify(environment)}`);
    }
  }
  assert.equal('place' in resolveLocalSttPaths({project, environment: {}, engine: EUROPEAN}), false);
  // Inside USVFS but with the files really where they were looked for: the same folder.
  const inside = resolveLocalSttPaths({project, environment: USVFS, engine: EUROPEAN});
  assert.ok(same(inside.modelDirectory, join(project, 'models/stt', EUROPEAN.id)));
});

test('the service layout and environment: the virtual packs folder only under MO2, nothing added for a physical install', () => {
  const base = {appDirectory: 'D:/Game/red4ext/plugins/X/app', gameRoot: 'D:/Game'};
  const physical = installLayout(base);
  assert.equal('sttPacks' in physical, false);
  assert.deepEqual(installLayout({...base, packRoots: {}}), physical);
  const envPhysical = serviceEnvironment(physical, {omni: false, keyFile: 'k'}, {});
  assert.equal('CYBERPUNK_CONVAI_STT_PACKS' in envPhysical, false);
  const virtual = 'E:/Game/red4ext/plugins/X/app/models/stt';
  const mo = installLayout({...base, packRoots: {stt: virtual}});
  assert.equal(mo.sttPacks, resolve(virtual));
  assert.deepEqual({...mo, sttPacks: undefined}, {...physical, sttPacks: undefined}, 'nothing else moves');
  assert.equal(serviceEnvironment(mo, {omni: false, keyFile: 'k'}, {}).CYBERPUNK_CONVAI_STT_PACKS, resolve(virtual));
});
