// Custom models kept outside the game folder (%LOCALAPPDATA%\AiNpcCyberpunkMod\local-ai), read together with the Local AI folder of the mod
// (bridge/custom-models.mjs, docs/LOCAL_AI.md "Add your own model"): both folders, duplicates, relative and full paths, a missing folder, the
// support report's view of the folders and its secret scrubbing.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {CUSTOM_MARKER, CustomModelScanner, customManifestFolders, describeCustomFolders, outsideLocalAiRoot, validateEntry} from './custom-models.mjs';
import {LOCAL_AI_ENV} from './local-ai-pack.mjs';
import {collectReport, customServerSecrets} from './support-report.mjs';

// ---- A GGUF header (version 3), as in custom-models.test.mjs ---------------------------------------------------------------------
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
const str = text => Buffer.concat([u64(Buffer.byteLength(text)), Buffer.from(text)]);
const kvString = (key, value) => Buffer.concat([str(key), u32(8), str(value)]);
const header = (architecture = 'llama') => Buffer.concat([Buffer.from('GGUF', 'latin1'), u32(3), u64(0), u64(1), kvString('general.architecture', architecture)]);

// A player's computer: the outside folder under a fake %LOCALAPPDATA%, the mod's Local AI folder, and a folder of models kept elsewhere.
function setup(t) {
  const base = mkdtempSync(join(tmpdir(), 'custom-outside-'));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  const localAppData = join(base, 'LocalAppData'), outside = join(localAppData, 'AiNpcCyberpunkMod', 'local-ai');
  const mod = join(base, 'game', 'app', 'local-ai'), elsewhere = join(base, 'D-models');
  for (const folder of [outside, join(mod, 'custom'), elsewhere]) mkdirSync(folder, {recursive: true});
  const environment = {LOCALAPPDATA: localAppData, [LOCAL_AI_ENV.root]: mod};
  const logs = [];
  const put = (folder, name, mib = 2) => { const path = join(folder, name); writeFileSync(path, header()); truncateSync(path, mib * 1048576); return path; };
  const manifestIn = (folder, value) => writeFileSync(join(folder, CUSTOM_MARKER), typeof value === 'string' ? value : JSON.stringify(value));
  const scanner = (options = {}) => new CustomModelScanner({project: join(base, 'game', 'app'), environment, log: line => logs.push(line), ...options});
  return {base, localAppData, outside, mod, elsewhere, environment, logs, put, manifestIn, scanner};
}

test('the outside folder is the data home\'s local-ai folder: %LOCALAPPDATA%\\AiNpcCyberpunkMod, or CYBERPUNK_CONVAI_DATA_HOME when that is a full path', () => {
  const home = resolve(tmpdir(), 'x-home'), other = resolve(tmpdir(), 'x-other');
  assert.equal(outsideLocalAiRoot({LOCALAPPDATA: home}), join(home, 'AiNpcCyberpunkMod', 'local-ai'));
  assert.equal(outsideLocalAiRoot({LOCALAPPDATA: home, CYBERPUNK_CONVAI_DATA_HOME: other}), join(other, 'local-ai'));
  assert.equal(outsideLocalAiRoot({LOCALAPPDATA: home, CYBERPUNK_CONVAI_DATA_HOME: 'relative/place'}), join(home, 'AiNpcCyberpunkMod', 'local-ai'), 'a relative override is ignored, as for the data folder');
  assert.equal(outsideLocalAiRoot({LOCALAPPDATA: home, CYBERPUNK_CONVAI_DATA_HOME: ''}), join(home, 'AiNpcCyberpunkMod', 'local-ai'));
  assert.equal(outsideLocalAiRoot({}), null);
  assert.equal(outsideLocalAiRoot({LOCALAPPDATA: 'relative'}), null);
});

test('both folders are read: the outside folder\'s models first, then the mod folder\'s, each with its own relative paths', t => {
  const s = setup(t);
  s.put(s.outside, 'outside-model.gguf'); s.put(join(s.mod, 'custom'), 'mod-model.gguf');
  s.manifestIn(s.outside, {version: 1, models: [{file: 'outside-model.gguf', name: 'Outside One'}]});
  s.manifestIn(s.mod, {version: 1, models: [{file: 'custom/mod-model.gguf', name: 'Mod One'}]});
  const scan = s.scanner().scan();
  assert.deepEqual(scan.models.map(model => model.name), ['Outside One', 'Mod One']);
  assert.deepEqual(scan.models.map(model => model.id), ['custom:outside-model', 'custom:mod-model']);
  assert.equal(scan.models[0].file, join(s.outside, 'outside-model.gguf'));
  assert.equal(scan.models[1].file, join(s.mod, 'custom', 'mod-model.gguf'));
  assert.deepEqual(scan.folders, [{where: 'outside', present: true, models: 1, problems: 0}, {where: 'mod', present: true, models: 1, problems: 0}]);
  assert.equal(scan.present, true);
  assert.equal(scan.root, s.mod, 'root stays the mod\'s Local AI folder');
  assert.deepEqual(s.logs, []);
});

test('only the outside folder: it works with no manifest (and no custom folder) in the mod', t => {
  const s = setup(t);
  s.put(s.outside, 'alone.gguf');
  s.manifestIn(s.outside, {version: 1, models: [{file: 'alone.gguf'}]});
  const scan = s.scanner().scan();
  assert.deepEqual(scan.models.map(model => model.id), ['custom:alone']);
  assert.deepEqual(scan.folders.map(folder => [folder.where, folder.present, folder.models]), [['outside', true, 1], ['mod', false, 0]]);
});

test('only the mod folder, or neither folder: exactly as before (one folder, log lines with no folder prefix)', t => {
  const s = setup(t);
  assert.deepEqual(s.scanner().scan(), {present: false, root: s.mod, models: [], problems: [],
    folders: [{where: 'outside', present: false, models: 0, problems: 0}, {where: 'mod', present: false, models: 0, problems: 0}]});
  s.put(join(s.mod, 'custom'), 'old.gguf');
  s.manifestIn(s.mod, {version: 1, models: [{file: 'custom/old.gguf'}, {file: 'custom/missing.gguf', name: 'Gone'}, {file: 'custom/x.bin'}]});
  const scan = s.scanner().scan();
  assert.deepEqual(scan.models.map(model => model.id), ['custom:old']);
  assert.deepEqual(s.logs, ['[custom models] "Gone" is not usable: the file missing.gguf was not found', '[custom models] skipped "custom/x.bin": only .gguf files are accepted']);
  // No data home at all (no %LOCALAPPDATA%): one folder, and `folders` lists only it.
  const none = s.scanner({environment: {[LOCAL_AI_ENV.root]: s.mod}}).scan();
  assert.deepEqual(none.folders.map(folder => folder.where), ['mod']);
  assert.equal(none.models.length, 1);
});

test('a missing outside folder is fine: nothing is created, nothing is thrown', t => {
  const s = setup(t);
  rmSync(s.outside, {recursive: true, force: true});
  s.put(join(s.mod, 'custom'), 'old.gguf');
  s.manifestIn(s.mod, {version: 1, models: [{file: 'custom/old.gguf'}]});
  assert.equal(s.scanner().scan().models.length, 1);
  assert.throws(() => statSync(s.outside), /ENOENT/, 'the scan did not create the folder');
});

test('the same model in both folders is used once, from the outside folder, and one log line says so', t => {
  const s = setup(t);
  const inOutside = s.put(s.outside, 'Same-Model.gguf'); s.put(join(s.mod, 'custom'), 'Same-Model.gguf');
  s.manifestIn(s.outside, {version: 1, models: [{file: 'Same-Model.gguf', name: 'New Name', contextSize: 4096}]});
  s.manifestIn(s.mod, {version: 1, models: [{file: 'custom/Same-Model.gguf', name: 'Old Name', contextSize: 8192}, {file: 'custom/Other.gguf', name: 'Other'}]});
  s.put(join(s.mod, 'custom'), 'Other.gguf');
  const scanner = s.scanner();
  const scan = scanner.scan();
  assert.deepEqual(scan.models.map(model => [model.id, model.name, model.contextSize]), [['custom:same-model', 'New Name', 4096], ['custom:other', 'Other', null]]);
  assert.equal(scan.models[0].file, inOutside);
  assert.deepEqual(scan.folders.map(folder => folder.models), [1, 1]);
  const lines = s.logs.filter(line => /outside folder/.test(line));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[custom models\] mod folder: skipped "custom\/Same-Model.gguf": "Old Name" is also in the outside folder, whose entry is used$/);
  scanner.scan(); scanner.scan();
  assert.equal(s.logs.filter(line => /outside folder/.test(line)).length, 1, 'reported once, not at every look');
});

test('an outside entry that is not usable does not hide a usable one of the same name in the mod folder', t => {
  const s = setup(t);
  s.put(join(s.mod, 'custom'), 'M.gguf');
  s.manifestIn(s.outside, {version: 1, models: [{file: 'M.gguf', name: 'Outside M'}]});   // the file is not there
  s.manifestIn(s.mod, {version: 1, models: [{file: 'custom/M.gguf', name: 'Mod M'}]});
  const scan = s.scanner().scan();
  assert.deepEqual(scan.models.map(model => model.name), ['Mod M']);
  assert.deepEqual(scan.problems.map(problem => [problem.name, problem.reason]), [['Outside M', 'missing']]);
  assert.deepEqual(scan.folders.map(folder => [folder.models, folder.problems]), [[0, 1], [1, 0]]);
});

test('a duplicate inside one folder still gets a suffix; a later folder never reuses an id', t => {
  const s = setup(t);
  mkdirSync(join(s.outside, 'a')); mkdirSync(join(s.outside, 'b'));
  s.put(join(s.outside, 'a'), 'M.gguf'); s.put(join(s.outside, 'b'), 'M.gguf'); s.put(join(s.mod, 'custom'), 'Z.gguf');
  s.manifestIn(s.outside, {version: 1, models: [{file: 'a/M.gguf'}, {file: 'b/M.gguf'}]});
  s.manifestIn(s.mod, {version: 1, models: [{file: 'custom/Z.gguf'}]});
  assert.deepEqual(s.scanner().scan().models.map(model => model.id), ['custom:m', 'custom:m-2', 'custom:z']);
});

test('paths: relative to the folder of the manifest; a full path with a drive letter only in the outside folder; ".." never', t => {
  const s = setup(t);
  const far = s.put(s.elsewhere, 'Far-Away.gguf');
  s.put(join(s.mod, 'custom'), 'near.gguf');
  s.manifestIn(s.outside, {version: 1, models: [
    {file: far, name: 'Full path'},
    {file: far.replace(/\\/g, '/'), name: 'Full path, forward slashes'},
    {file: '../escape.gguf', name: 'Up'},
    {file: join(s.elsewhere, '..', 'x', 'm.gguf'), name: 'Full path with up'},
    {file: 'C:models/drive-relative.gguf', name: 'Drive relative'},
    {file: '/rooted.gguf', name: 'Rooted'}]});
  s.manifestIn(s.mod, {version: 1, models: [{file: far, name: 'Full path in the mod folder'}, {file: 'custom/near.gguf', name: 'Near'}]});
  const scan = s.scanner().scan();
  assert.deepEqual(scan.models.map(model => model.name), ['Full path', 'Near'], 'the second spelling of the same file is a duplicate, and the mod folder keeps refusing full paths');
  assert.equal(scan.models[0].file, far);
  const said = s.logs.join('\n');
  assert.match(said, /outside folder: skipped "\.\.\/escape\.gguf": the file path must not contain "\.\."/);
  assert.match(said, /outside folder: skipped ".*": the file path must not contain "\.\."/);
  assert.match(said, /outside folder: skipped "C:models\/drive-relative\.gguf": the file path must be relative to the folder of this manifest, or a full path with a drive letter/);
  assert.match(said, /outside folder: skipped "\/rooted\.gguf": the file path must be relative/);
  assert.match(said, /mod folder: skipped ".*Far-Away\.gguf": the file path must be relative to the Local AI folder/);
  // The validator on its own: the mod folder's manifest is checked as it always was.
  assert.match(validateEntry(s.mod, {file: far}).error, /relative to the Local AI folder/);
  assert.equal(validateEntry(s.outside, {file: far}, {allowAbsolute: true}).entry.file, far);
  assert.match(validateEntry(s.outside, {file: far.replace(/\.gguf$/, '.bin')}, {allowAbsolute: true}).error, /\.gguf/);
});

test('servers the player runs are read from the outside manifest too, and the same server in both is listed once', t => {
  const s = setup(t);
  s.manifestIn(s.outside, {version: 1, models: [{endpoint: 'http://127.0.0.1:5001/v1', name: 'Outside Kobold', model: 'q'}]});
  s.manifestIn(s.mod, {version: 1, models: [{endpoint: 'http://127.0.0.1:5001/v1', name: 'Mod Kobold', model: 'q'}, {endpoint: 'http://127.0.0.1:1234/v1', name: 'LM Studio'}]});
  const scan = s.scanner().scan();
  assert.deepEqual(scan.models.map(model => [model.name, model.external]), [['Outside Kobold', true], ['LM Studio', true]]);
  assert.equal(s.logs.filter(line => /also in the outside folder/.test(line)).length, 1);
  assert(!s.logs.join('\n').includes('127.0.0.1'), 'no address in the log');
});

test('a manifest that is not valid JSON names its folder when both are in use, and the other folder still works', t => {
  const s = setup(t);
  s.put(join(s.mod, 'custom'), 'ok.gguf');
  s.manifestIn(s.outside, '{ not json');
  s.manifestIn(s.mod, {version: 1, models: [{file: 'custom/ok.gguf'}]});
  const scan = s.scanner().scan();
  assert.deepEqual(scan.models.map(model => model.id), ['custom:ok']);
  assert.deepEqual(s.logs, ['[custom models] outside folder: manifest.custom.json is not valid JSON; no custom models']);
  assert.deepEqual(scan.folders.map(folder => [folder.where, folder.present, folder.models]), [['outside', true, 0], ['mod', true, 1]]);
});

test('at most 16 entries are used in all, the outside folder\'s first', t => {
  const s = setup(t);
  const entries = (folder, prefix, count) => { const list = []; for (let index = 0; index < count; index++) { s.put(folder, prefix + index + '.gguf'); list.push({file: prefix + index + '.gguf'}); } return list; };
  s.manifestIn(s.outside, {version: 1, models: entries(s.outside, 'o', 10)});
  s.manifestIn(s.mod, {version: 1, models: entries(s.mod, 'm', 10)});
  const scan = s.scanner().scan();
  assert.equal(scan.models.length, 16);
  assert.deepEqual(scan.folders.map(folder => folder.models), [10, 6]);
  assert.equal(s.logs.filter(line => /only the first 16/.test(line)).length, 1);
});

test('the same folder given as both is read once', t => {
  const s = setup(t);
  s.put(s.mod, 'once.gguf');
  s.manifestIn(s.mod, {version: 1, models: [{file: 'once.gguf'}]});
  const scan = s.scanner({outside: s.mod}).scan();
  assert.equal(scan.models.length, 1);
  assert.deepEqual(scan.folders.map(folder => folder.where), ['mod']);
  assert.deepEqual(s.logs, []);
});

test('a look costs stats and two small JSON reads; a file header is read once, then only when the file changes', t => {
  const s = setup(t);
  s.put(s.outside, 'a.gguf'); s.put(join(s.mod, 'custom'), 'b.gguf');
  s.manifestIn(s.outside, {version: 1, models: [{file: 'a.gguf'}]});
  s.manifestIn(s.mod, {version: 1, models: [{file: 'custom/b.gguf'}]});
  let heads = 0, texts = 0;
  const realHead = s.scanner().head, realRead = s.scanner().readText;
  const scanner = s.scanner({head: (...args) => { heads++; return realHead(...args); }, readText: path => { texts++; return realRead(path); }});
  scanner.scan(); scanner.scan(); scanner.scan();
  assert.equal(heads, 2, 'one header read per file, ever, while it does not change');
  assert.equal(texts, 6, 'two manifests per look');
});

test('the support report lists the folders with counts and no path; a key in the outside manifest is scrubbed', async t => {
  const s = setup(t);
  const [game, runtime, state, project] = ['game2', 'runtime', 'state', join('game', 'app')].map(name => join(s.base, name));
  for (const folder of [game, runtime, state]) await mkdir(folder, {recursive: true});
  const KEY = 'Outside-Server-Key-Zq7Lm2Wv9Xc4';
  await writeFile(join(runtime, 'mistral-state.json'), JSON.stringify({version: 1, localAi: 'ready', localModels: []}));
  await writeFile(join(state, 'bridge-service.log'), `[LocalAI] trouble with ${KEY} here\n`);
  const environment = {...s.environment};
  const build = () => collectReport({game, runtime, stateDirectory: state, project, reportId: 'r-outside', environment});
  const text = report => report.entries.map(row => row.data).join('\n') + JSON.stringify(report.summary);
  // Neither manifest yet.
  let report = await build();
  assert.deepEqual(report.summary.localAi.customFolders, [
    {where: 'outside', folder: 'found', manifest: 'missing', entries: 0, servers: 0}, {where: 'mod', folder: 'found', manifest: 'missing', entries: 0, servers: 0}]);
  assert(text(report).includes(KEY), 'control: nothing tells the scrubber about this key yet');
  s.manifestIn(s.outside, {version: 1, models: [{file: 'a.gguf'}, {file: 'b.gguf'}, {endpoint: 'http://127.0.0.1:5001/v1', name: 'Kobold', apiKey: KEY}]});
  s.manifestIn(s.mod, {version: 1, models: [{file: 'custom/c.gguf'}]});
  report = await build();
  assert.deepEqual(report.summary.localAi.customFolders, [
    {where: 'outside', folder: 'found', manifest: 'found', entries: 3, servers: 1}, {where: 'mod', folder: 'found', manifest: 'found', entries: 1, servers: 0}]);
  assert(!text(report).includes(KEY), 'a key in the outside manifest is scrubbed from every line');
  assert(!JSON.stringify(report.summary.localAi.customFolders).includes(s.base), 'no path in the folder list');
  assert.deepEqual(await customServerSecrets({project, environment}), [KEY]);
  assert.deepEqual(await customServerSecrets({project, environment: {}}), []);
});

test('describing the folders: a missing outside folder, no data home, a broken or unreadable manifest, the dev folder only with a manifest', t => {
  const s = setup(t);
  rmSync(s.outside, {recursive: true, force: true});
  const project = join(s.base, 'game', 'app');
  assert.deepEqual(describeCustomFolders({project, environment: s.environment}).map(row => [row.where, row.folder, row.manifest]), [['outside', 'missing', 'missing'], ['mod', 'found', 'missing']]);
  assert.deepEqual(describeCustomFolders({project, environment: {[LOCAL_AI_ENV.root]: s.mod}}).map(row => [row.where, row.folder]), [['outside', 'unavailable'], ['mod', 'found']]);
  s.manifestIn(s.mod, '{ not json');
  assert.equal(describeCustomFolders({project, environment: s.environment}).find(row => row.where === 'mod').manifest, 'invalid');
  s.manifestIn(s.mod, '﻿{“version”: 1, “models”: [{“file”: “custom/a.gguf”}]}');
  assert.deepEqual(describeCustomFolders({project, environment: s.environment}).find(row => row.where === 'mod'), {where: 'mod', folder: 'found', manifest: 'found', entries: 1, servers: 0});
  const dev = join(s.base, 'dev-ai'); mkdirSync(dev);
  const withDev = {LOCALAPPDATA: s.localAppData, [LOCAL_AI_ENV.dev]: dev};
  assert.deepEqual(describeCustomFolders({project: join(s.base, 'nowhere'), environment: withDev}).map(row => row.where), ['outside', 'mod'], 'a dev folder with no manifest is left out');
  s.manifestIn(dev, {version: 1, models: []});
  assert.deepEqual(describeCustomFolders({project: join(s.base, 'nowhere'), environment: withDev}).map(row => row.where), ['outside', 'mod', 'dev']);
  assert.deepEqual(customManifestFolders({project, environment: s.environment}).map(row => row.where), ['outside', 'mod']);
});
