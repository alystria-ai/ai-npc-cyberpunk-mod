// Mod Organizer 2, packs installed as separate MO2 mods (node --test packaging/mo2-split-packs.test.mjs).
//
// A player had the Local AI standard pack and a Mature pack. With Mature content on the model row showed one model; with it off it said "Only Mature models found".
// Under MO2 each pack is usually its own mod and USVFS merges them into one virtual app/local-ai folder. Where stat cannot see a virtual folder (usvfs 0.5.6.1 on
// Windows 11 24H2, packaging/runtime/usvfs-compat.mjs), locate() mapped that folder to ONE real folder with realpathSync.native, the mod that wins for the folder, and the
// service read the pack from there: the other mod's markers and models were invisible. Now the service hands the bridge the virtual folder and each file a manifest names
// is mapped to its own real place (bridge/local-ai-pack.mjs, realPathFor); the server and its DLLs come from one real folder.
// There is no USVFS here. The tests build real mod folders and simulate the merge with the functions the detectors already take (exists, readText, list, realPath):
// a path under the virtual root is looked up in each mod in priority order, as USVFS does per file.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {USVFS_FLAG, describePackFiles, detectLocalAiPack, packFileProblems, packPlaceLines, placeLabel, realPathFor} from '../bridge/local-ai-pack.mjs';
import {detectMaturePack} from '../bridge/mature-pack.mjs';
import {CUSTOM_MARKER, CustomModelScanner} from '../bridge/custom-models.mjs';
import {chooseLocalModel, describeLocalModels, listLocalModels} from '../bridge/local-model-choice.mjs';

const ROOT_VARIABLE = 'CYBERPUNK_CONVAI_LOCAL_AI';
const ENGINE = 'llama/llama-server.exe';
const DLLS = ['ggml.dll', 'ggml-base.dll', 'ggml-cpu-haswell.dll', 'ggml-vulkan.dll', 'llama.dll', 'libomp.dll', 'mtmd.dll'];
const EMBED = {file: 'models/granite-embedding-107m-multilingual-Q8_0.gguf', dim: 384, id: 'granite-embedding-107m-multilingual-q8_0'};
const FILES = {standard: 'models/gemma-4-E4B_q4_0-it.gguf', good: 'models/Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf', matureLite: 'models/Qwen3.5-2B-Uncensored-Q4_K_M.gguf'};
const sizeOf = () => 0;

// What each pack zip holds, as packaging/build-release.mjs lays it out: the engine (server, DLLs, embedding model), the model and the marker.
function packFiles(pack, {engine = true, dlls = DLLS} = {}) {
  const files = {};
  if (engine) {
    files[ENGINE] = 'exe';
    for (const name of dlls) files[`llama/${name}`] = 'dll';
    files[EMBED.file] = 'embed';
  }
  if (pack === 'standard') {
    files[FILES.standard] = 'model';
    files['manifest.standard.json'] = JSON.stringify({version: 1, server: ENGINE, standard: {file: FILES.standard, name: 'Gemma 4 E4B'}, embed: EMBED});
  }
  if (pack === 'mature-standard') {
    files[FILES.good] = 'model';
    files['manifest.mature-standard.json'] = JSON.stringify({version: 1, pack: 'mature', server: ENGINE, good: {file: FILES.good, name: 'Gemma 4 E4B · uncensored', family: 'gemma-4'}, embed: EMBED});
  }
  if (pack === 'mature-lite') {
    files[FILES.matureLite] = 'model';
    files['manifest.mature-lite.json'] = JSON.stringify({version: 1, pack: 'mature', server: ENGINE, lite: {file: FILES.matureLite, name: 'Qwen3.5 2B uncensored', family: 'qwen'}, embed: EMBED});
  }
  return files;
}

/**
 * mods: [{name, files: {relative path: text}}], highest priority first. Builds each mod as mods/<name>/red4ext/plugins/AiNpcCyberpunkMod/app/local-ai and returns the
 * virtual app/local-ai folder (nothing on disk there) with the functions that see it merged, one file at a time.
 */
function mo2(t, mods) {
  const base = mkdtempSync(join(tmpdir(), 'mo2 split packs '));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  const virtual = join(base, 'Cyberpunk 2077', 'red4ext', 'plugins', 'AiNpcCyberpunkMod', 'app', 'local-ai');
  const roots = mods.map(mod => join(base, 'MO2', 'mods', mod.name, 'red4ext', 'plugins', 'AiNpcCyberpunkMod', 'app', 'local-ai'));
  mods.forEach((mod, index) => {
    for (const [name, text] of Object.entries(mod.files)) {
      const path = join(roots[index], name);
      mkdirSync(dirname(path), {recursive: true});
      writeFileSync(path, text);
    }
    mkdirSync(roots[index], {recursive: true});
  });
  const inside = path => { const rel = relative(virtual, resolve(path)); return rel.startsWith('..') || /^[a-z]:/i.test(rel) ? null : rel; };
  // The real place of a virtual path: the first mod that has it (USVFS maps every file by itself); null when none has it.
  const real = path => {
    const rel = inside(path);
    if (rel === null) return null;
    for (const root of roots) { const candidate = join(root, rel); if (existsSync(candidate)) return candidate; }
    return null;
  };
  const view = {
    virtual, roots,
    exists: path => { const mapped = inside(path) === null ? path : real(path); try { return Boolean(mapped) && statSync(mapped).isFile(); } catch { return false; } },
    readText: path => readFileSync(inside(path) === null ? path : real(path), 'utf8'),
    list: path => {
      if (inside(path) === null) { try { return readdirSync(path); } catch { return []; } }
      const names = new Set();
      for (const root of roots) { try { for (const name of readdirSync(join(root, inside(path)))) names.add(name); } catch { /* not in this mod */ } }
      return [...names];
    },
    realPath: path => (inside(path) === null ? path : real(path) ?? path),
    sizeOf,
    environment: {[ROOT_VARIABLE]: virtual},
  };
  view.options = {project: virtual, environment: view.environment, exists: view.exists, readText: view.readText, list: view.list, realPath: view.realPath};
  return view;
}
const sameFile = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const choose = (models, options) => chooseLocalModel({models, sizeOf, freeMiB: 12000, totalMiB: 12288, ...options});

test('the bug: the folder mapped to one mod (locate, the highest priority) hides the other pack, so Mature off had no model and Mature on one', t => {
  const f = mo2(t, [{name: 'LocalAI Mature Standard', files: packFiles('mature-standard')}, {name: 'LocalAI Standard', files: packFiles('standard')}]);
  // The old root: the real folder of the winning mod, read as a plain folder.
  const single = {project: f.roots[0], environment: {[ROOT_VARIABLE]: f.roots[0]}};
  const pack = detectLocalAiPack(single), mature = detectMaturePack(single);
  assert.equal(pack.tiers.standard, null, 'the standard pack is not in that mod');
  assert.deepEqual(mature.models.map(model => model.tier), ['good']);
  const models = listLocalModels({pack, matureModels: mature.models});
  assert.deepEqual(models.map(model => model.id), ['mature:good'], 'one model');
  assert.throws(() => choose(models, {matureOn: false}), error => error.reason === 'mature-off', 'Mature off: only Mature models found');
});

test('a virtual local-ai merged from the standard mod and the Mature mod: both models are listed, each from its own real folder', t => {
  const f = mo2(t, [{name: 'LocalAI Mature Standard', files: packFiles('mature-standard')}, {name: 'LocalAI Standard', files: packFiles('standard')}]);
  const pack = detectLocalAiPack(f.options), mature = detectMaturePack(f.options);
  assert.equal(pack.installed, true);
  assert.deepEqual(pack.missing, []);
  assert.equal(pack.root, f.virtual);
  assert.ok(sameFile(pack.tiers.standard.file, join(f.roots[1], FILES.standard)), pack.tiers.standard.file);
  assert.equal(pack.tiers.standard.name, 'Gemma 4 E4B');
  assert.deepEqual(mature.models.map(model => [model.tier, model.present]), [['good', true]]);
  assert.ok(sameFile(mature.models[0].file, join(f.roots[0], FILES.good)), mature.models[0].file);
  assert.ok(sameFile(pack.embed.file, join(f.roots[0], EMBED.file)), 'the embedding model of the winning mod');
  // Every file the engine gets is a real file of a mod folder, never a virtual path.
  for (const file of [pack.server, pack.tiers.standard.file, pack.embed.file, mature.models[0].file]) assert.ok(existsSync(file) && f.roots.some(root => file.toLowerCase().startsWith(root.toLowerCase())), file);
  const models = listLocalModels({pack, matureModels: mature.models});
  assert.deepEqual(describeLocalModels(models, sizeOf).map(model => model.name).sort(), ['Gemma 4 E4B', 'Gemma 4 E4B · uncensored']);
  assert.deepEqual(packFileProblems(describePackFiles(f.options)), []);
});

test('Mature off lists and chooses the standard model; Mature on chooses the Mature one, in either mod order', t => {
  for (const order of [['mature-standard', 'standard'], ['standard', 'mature-standard']]) {
    const f = mo2(t, order.map(pack => ({name: pack, files: packFiles(pack)})));
    const pack = detectLocalAiPack(f.options), mature = detectMaturePack(f.options);
    const models = listLocalModels({pack, matureModels: mature.models});
    assert.deepEqual(models.map(model => model.id).sort(), ['mature:good', 'standard'], order.join());
    const off = choose(models, {matureOn: false});
    assert.equal(off.model.id, 'standard', order.join());
    assert.equal(off.model.uncensored, false);
    assert.ok(sameFile(off.model.file, join(f.roots[order.indexOf('standard')], FILES.standard)), off.model.file);
    const on = choose(models, {matureOn: true});
    assert.equal(on.model.id, 'mature:good', order.join());
    assert.ok(sameFile(on.model.file, join(f.roots[order.indexOf('mature-standard')], FILES.good)), on.model.file);
    for (const pin of ['standard', 'mature:good']) assert.equal(choose(models, {pin, matureOn: pin !== 'standard'}).model.id, pin);
  }
});

test('three packs in three mods (standard, Mature standard, Mature lite) all show up', t => {
  const f = mo2(t, ['standard', 'mature-lite', 'mature-standard'].map(pack => ({name: pack, files: packFiles(pack)})));
  const pack = detectLocalAiPack(f.options), mature = detectMaturePack(f.options);
  assert.deepEqual(mature.models.map(model => model.tier), ['lite', 'good']);
  assert.ok(pack.tiers.standard);
  assert.equal(listLocalModels({pack, matureModels: mature.models}).length, 3);
});

test('the server lives in only one of the mods: the other pack\'s manifest uses it', t => {
  // The standard mod was installed without the engine (a trimmed zip), the Mature mod has it.
  const f = mo2(t, [{name: 'Standard no engine', files: packFiles('standard', {engine: false})}, {name: 'Mature', files: packFiles('mature-standard')}]);
  const pack = detectLocalAiPack(f.options);
  assert.equal(pack.installed, true);
  assert.deepEqual(pack.missing, []);
  assert.ok(sameFile(pack.server, join(f.roots[1], ENGINE)), pack.server);
  assert.ok(sameFile(pack.embed.file, join(f.roots[1], EMBED.file)));
  assert.ok(pack.tiers.standard && sameFile(pack.tiers.standard.file, join(f.roots[0], FILES.standard)));
  // Mature only, the standard pack's manifest absent: the Mature marker's server is used.
  const alone = mo2(t, [{name: 'Mature', files: packFiles('mature-standard')}]);
  const matureOnly = detectLocalAiPack(alone.options);
  assert.equal(matureOnly.installed, true);
  assert.deepEqual(matureOnly.tiers, {standard: null, lite: null});
});

test('llama-server and its DLLs come from one real folder: a pack that lacks a DLL of the winning mod\'s server is passed over for the pack with all of them', t => {
  // The mod of the higher priority has the exe and only some DLLs (an older build), the other has the full set. USVFS would map each file by itself: exe from the first, libomp.dll
  // from the second, and Windows looks for DLLs beside the real exe.
  const partial = DLLS.filter(name => name !== 'libomp.dll' && name !== 'mtmd.dll');
  const f = mo2(t, [{name: 'Standard (old engine)', files: packFiles('standard', {dlls: partial})}, {name: 'Mature (full engine)', files: packFiles('mature-standard')}]);
  const pack = detectLocalAiPack(f.options);
  assert.ok(sameFile(pack.server, join(f.roots[1], ENGINE)), 'the server of the mod that has every DLL: ' + pack.server);
  assert.deepEqual(pack.places.server.missing, []);
  assert.equal(pack.places.server.complete, true);
  for (const name of DLLS) assert.ok(existsSync(join(dirname(pack.server), name)), name + ' beside the server');
  // The winning mod holds the complete set: it stays.
  const same = mo2(t, [{name: 'Standard', files: packFiles('standard')}, {name: 'Mature', files: packFiles('mature-standard')}]);
  assert.ok(sameFile(detectLocalAiPack(same.options).server, join(same.roots[0], ENGINE)));
  // Neither folder has every DLL of the merged llama/ folder: the better one is used and the report names what is missing.
  const split = mo2(t, [{name: 'A', files: packFiles('standard', {dlls: ['ggml.dll', 'llama.dll', 'libomp.dll']})},
    {name: 'B', files: packFiles('mature-standard', {dlls: ['ggml.dll', 'llama.dll', 'mtmd.dll', 'ggml-vulkan.dll']})}]);
  const best = detectLocalAiPack(split.options);
  assert.ok(sameFile(best.server, join(split.roots[1], ENGINE)), 'the one with more of the DLLs');
  assert.equal(best.places.server.complete, false);
  assert.deepEqual(best.places.server.missing, ['libomp.dll'], 'the merged llama/ lists five DLLs; B lacks the one only A has');
  assert.equal(best.installed, true, 'still installed: the server is better than none');
});

test('the DLL rule uses the mod of the marker even when the other pack\'s copy of llama/ is the one USVFS maps the exe to', t => {
  // Standard mod (priority) has the exe only; the Mature mod has the exe and all DLLs. The exe path maps to the standard mod's copy; the Mature marker's own mod is a candidate.
  const f = mo2(t, [{name: 'Standard', files: {...packFiles('standard', {dlls: []})}}, {name: 'Mature', files: packFiles('mature-standard')}]);
  const pack = detectLocalAiPack(f.options);
  assert.ok(sameFile(pack.server, join(f.roots[1], ENGINE)), pack.server);
  assert.equal(pack.places.server.complete, true);
});

test('a physical install is unchanged: no mapping, no extra fields, the same paths as before', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mo2 physical '));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  for (const [name, text] of Object.entries({...packFiles('standard'), ...packFiles('mature-standard')})) {
    const path = join(directory, name);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, text);
  }
  const environment = {[ROOT_VARIABLE]: directory};
  const pack = detectLocalAiPack({project: directory, environment});
  assert.equal('places' in pack, false);
  assert.deepEqual(pack, {installed: true, missing: [], root: directory, server: join(directory, ENGINE),
    tiers: {standard: {file: join(directory, FILES.standard), name: 'Gemma 4 E4B'}, lite: null},
    embed: {file: join(directory, EMBED.file), dim: 384, id: EMBED.id}, dev: false});
  // Without usvfs the default mapping is the identity, even with the variable absent or not '1'.
  for (const environmentWith of [{}, {[USVFS_FLAG]: '0'}, {[USVFS_FLAG]: ''}]) assert.equal(realPathFor(environmentWith)(join(directory, 'x', '..', ENGINE)), join(directory, 'x', '..', ENGINE));
  assert.deepEqual(detectLocalAiPack({project: directory, environment: {...environment, [USVFS_FLAG]: '0'}}), pack);
  const mature = detectMaturePack({project: directory, environment});
  assert.deepEqual(mature.models.map(model => [model.tier, model.file, model.present]), [['good', join(directory, FILES.good), true]]);
  const description = describePackFiles({project: directory, environment, sizeOf});
  assert.equal('engine' in description, false);
  assert.equal(JSON.stringify(description).includes('foundIn'), false);
  assert.deepEqual(packPlaceLines({project: directory, environment}), []);
  // A physical install running inside usvfs (the flag on, files really there): the real path is the path itself, so nothing is reported as elsewhere.
  const flagged = {...environment, [USVFS_FLAG]: '1'};
  const inside = detectLocalAiPack({project: directory, environment: flagged});
  assert.equal(inside.installed, true);
  assert.equal('places' in inside, false, 'a file that is where it was looked for is not listed as moved');
  assert.deepEqual(packPlaceLines({project: directory, environment: flagged}), []);
});

test('realPathFor maps with realpathSync.native only when usvfs is on, and leaves a path it cannot map as it is', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mo2 realpath '));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const file = join(directory, 'a.gguf');
  writeFileSync(file, 'x');
  const on = realPathFor({[USVFS_FLAG]: '1'});
  assert.equal(on(file).toLowerCase(), realpathSync.native(file).toLowerCase());
  const gone = join(directory, 'nothing.gguf');
  assert.equal(on(gone), gone);
});

test('placeLabel names the MO2 mod folder, never a path', () => {
  assert.equal(placeLabel('C:\\Games\\MO2\\mods\\Local AI Standard\\red4ext\\plugins\\x\\app\\local-ai\\models\\a.gguf', 'D:\\Cyberpunk 2077\\red4ext\\plugins\\x\\app\\local-ai\\models\\a.gguf'), 'Local AI Standard');
  assert.equal(placeLabel('E:\\elsewhere\\a.gguf', 'D:\\game\\a.gguf'), 'elsewhere');
  assert.equal(placeLabel('D:\\game\\a.gguf', 'd:\\GAME\\a.gguf'), null, 'the same file (case aside) is not "found elsewhere"');
  assert.equal(placeLabel(null, 'x'), null);
});

test('the support report lists where each pack file was found under MO2 (mod folder names, DLL status), and the service log lists the real paths', t => {
  const partial = DLLS.filter(name => name !== 'libomp.dll');
  const f = mo2(t, [{name: 'Standard pack', files: packFiles('standard', {dlls: partial})}, {name: 'Mature pack', files: packFiles('mature-standard')}]);
  const description = describePackFiles({...f.options, sizeOf});
  assert.deepEqual(description.markers.map(marker => [marker.name, marker.foundIn]), [['manifest.standard.json', 'Standard pack'], ['manifest.mature-standard.json', 'Mature pack']]);
  assert.deepEqual(description.markers[1].declares.map(item => [item.tier, item.present, item.foundIn]), [['good', true, 'Mature pack']]);
  assert.deepEqual(description.files.map(file => [file.file, file.foundIn, file.named]).sort(), [
    ['Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf', 'Mature pack', true], ['gemma-4-E4B_q4_0-it.gguf', 'Standard pack', true],
    ['granite-embedding-107m-multilingual-Q8_0.gguf', 'Standard pack', true]].sort());
  assert.deepEqual(description.engine, [{piece: 'server', foundIn: 'Mature pack', dllsBeside: true, dllsMissing: []}, {piece: 'embed', foundIn: 'Standard pack'}]);
  const text = JSON.stringify(description);
  assert.equal(text.includes(f.roots[0]) || text.includes(f.roots[1]), false, 'no path in the report data');
  const lines = packPlaceLines(f.options);
  assert.ok(lines.some(line => line.startsWith('marker manifest.standard.json: ') && line.includes('Standard pack')), lines.join('\n'));
  assert.ok(lines.some(line => line.startsWith('  good model Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf: ') && line.includes('Mature pack')));
  assert.ok(lines.some(line => line.startsWith('server llama-server.exe: ') && line.includes('Mature pack') && line.endsWith('its DLLs are all beside it')), lines.join('\n'));
  // A pack file that is nowhere says so.
  const broken = mo2(t, [{name: 'Standard', files: (() => { const files = packFiles('standard'); delete files[FILES.standard]; return files; })()}]);
  assert.ok(packPlaceLines(broken.options).some(line => line.includes('standard model gemma-4-E4B_q4_0-it.gguf: not found')));
  assert.deepEqual(packFileProblems(describePackFiles({...broken.options, sizeOf})), [{name: 'Gemma 4 E4B', reason: 'missing'}]);
});

test('a custom model of the mod folder is used from where it really is', t => {
  const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
  const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
  const str = text => Buffer.concat([u64(Buffer.byteLength(text)), Buffer.from(text)]);
  const header = Buffer.concat([Buffer.from('GGUF', 'latin1'), u32(3), u64(0), u64(2), str('general.architecture'), u32(8), str('llama'),
    str('llama.context_length'), u32(4), u32(8192)]);
  const manifest = JSON.stringify({version: 1, models: [{file: 'custom/My-Model.gguf', name: 'My Model'}]});
  const f = mo2(t, [{name: 'Custom models', files: {[CUSTOM_MARKER]: manifest, 'custom/My-Model.gguf': header}}, {name: 'Standard', files: packFiles('standard')}]);
  truncateSync(join(f.roots[0], 'custom', 'My-Model.gguf'), 2 * 1048576);
  const scanner = new CustomModelScanner({project: f.virtual, environment: f.environment, outside: null, exists: f.exists, readText: f.readText, realPath: f.realPath});
  const result = scanner.scan();
  assert.equal(result.models.length, 1, JSON.stringify(result.problems));
  assert.ok(sameFile(result.models[0].file, join(f.roots[0], 'custom', 'My-Model.gguf')), result.models[0].file);
  assert.equal(result.models[0].id, 'custom:my-model');
});
