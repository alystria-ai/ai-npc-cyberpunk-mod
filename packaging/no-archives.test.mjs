// The main file holds no archive (packaging/lib/package-guards.mjs, "No archive inside the main file"): the guard itself, each builder that
// writes a package the main file is made of (Scripts and Runtime in build-release.mjs, the Full zip, the Runtime update), the Runtime's pruning of the
// archives 0.3.5 carried, and the lip-sync table as plain text. Fixtures only, no build, no download.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {ZipWriter, listZip} from './lib/zip.mjs';
import {entryHead} from './lib/zip-entry.mjs';
import {ARCHIVE_GUARDED_PACKAGES, archiveEntry, archiveKind, archivesIn, archivesInZip, assertNoArchives} from './lib/package-guards.mjs';
import {planFull} from './lib/full-package.mjs';
import {INSTALL_NOTE_PATH} from './lib/pack-overlap.mjs';
import {pythonPruned} from './lib/runtime-prune.mjs';
import {DECLARED_REMOVALS, checkRemovals} from './lib/runtime-removals.mjs';
import {buildFull} from './build-full.mjs';
import {buildRuntimeUpdate} from './build-runtime-update.mjs';
import {MANAGED_FILES, installLayout, prepareState} from './runtime/prepare-state.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(project, 'packaging/release.config.json'), 'utf8'));
const PLUGIN = config.layout.pluginDirectory;
const MOD = config.layout.modDirectory;
const APP = `${PLUGIN}/app`;
const SITE = `${APP}/python/Lib/site-packages`;

// The first bytes of each kind, as the tools write them.
const SAMPLES = {
  zip: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]),
  gzip: gzipSync(Buffer.from('hello')),
  '7z': Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), Buffer.alloc(40)]),
  rar: Buffer.concat([Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]), Buffer.alloc(40)]),
  xz: Buffer.concat([Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), Buffer.alloc(40)]),
  bzip2: Buffer.concat([Buffer.from('BZh9'), Buffer.from([0x31, 0x41, 0x59, 0x26, 0x53, 0x59]), Buffer.alloc(40)]),
  tar: Buffer.concat([Buffer.alloc(257), Buffer.from('ustar'), Buffer.alloc(200)]),
  cab: Buffer.concat([Buffer.from('MSCF'), Buffer.alloc(40)]),
};
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

test('every archive kind is told by its first bytes, and ordinary files are not', () => {
  for (const [kind, bytes] of Object.entries(SAMPLES)) assert.equal(archiveKind(bytes), kind, kind);
  for (const bytes of [Buffer.alloc(0), Buffer.from('{"json": true}'), Buffer.from('MZ an exe'), Buffer.from('GGUF'), Buffer.from('BZh is a name'), Buffer.from('PK is text'),
    Buffer.from([0x1f, 0x8b]), Buffer.from('hello world, plain text\n'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('RIFF....WAVE')]) {
    assert.equal(archiveKind(bytes), null, bytes.subarray(0, 12).toString('latin1'));
  }
});

test('an entry is refused by an archive name, whatever its bytes, and by archive bytes, whatever its name', () => {
  for (const name of ['a/data.zip', 'a/atlas.dat.gz', 'a/face-lexicon.txt.gz', 'a/x.7z', 'a/x.rar', 'a/x.xz', 'a/x.bz2', 'a/x.tar', 'a/x.tgz', 'a/x.cab', 'a/x.msi', 'a/x.MSI',
    'a/scipy-1.18.1-cp312-cp312-win_amd64.whl', 'a/x.jar', 'a/x.zst']) {
    assert.notEqual(archiveEntry(name, Buffer.from('plain')), null, name);
    assert.notEqual(archiveEntry(name, null), null, `${name} by name alone`);
  }
  assert.match(archiveEntry('a/_sobol_direction_numbers.npz', SAMPLES.zip), /zip archive by its first bytes/);
  assert.match(archiveEntry('a/renamed.dat', SAMPLES.gzip), /gzip archive by its first bytes/);
  for (const name of ['a/face-lexicon.txt', 'a/model.onnx', 'a/model.safetensors', 'a/python312.dll', 'a/x.pyd', 'a/zipfile.py', 'a/gzip.py', 'a/x.zip.txt', 'a/tar.mjs', 'a/lzma.py', 'a/x.json']) {
    assert.equal(archiveEntry(name, Buffer.from('plain text')), null, name);
  }
  // An OLE document that is not an installer is not an archive.
  assert.equal(archiveEntry('a/old.doc', OLE), null);
});

test('the Scripts and the Runtime are the guarded packages, the optional packs on Hugging Face are not', () => {
  assert.deepEqual([...ARCHIVE_GUARDED_PACKAGES], ['scripts', 'runtime']);
});

let root;
before(async () => { root = await mkdtemp(join(tmpdir(), 'no-archives-')); });
after(async () => { if (root) await rm(root, {recursive: true, force: true}); });

async function zipOf(path, files) {
  const writer = await ZipWriter.create(path, {timestamp: new Date(Date.UTC(2026, 9, 31))});
  for (const name of Object.keys(files).sort()) await writer.add(name, {buffer: Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(files[name])});
  await writer.close();
  return path;
}

test('a package is checked on the bytes it will write: buffers and source files, a renamed archive included', async () => {
  const file = async (name, bytes) => { await writeFile(join(root, name), bytes); return join(root, name); };
  const entries = new Map([
    ['ok/lexicon.txt', {buffer: Buffer.from('hello HH AH L OW\n')}],
    ['ok/model.bin', {source: await file('model.bin', Buffer.alloc(2000, 7))}],
    ['ok/empty', {source: await file('empty', Buffer.alloc(0))}],
  ]);
  assert.deepEqual(await archivesIn(entries), []);
  await assertNoArchives('runtime', entries);
  entries.set('bad/renamed.dat', {source: await file('renamed.dat', SAMPLES.gzip)});
  entries.set('bad/inline.dat', {buffer: SAMPLES.zip});
  entries.set('bad/by-name.gz', {buffer: Buffer.from('not even gzip')});
  assert.equal((await archivesIn(entries)).length, 3);
  await assert.rejects(assertNoArchives('scripts', entries), /scripts: the main file holds no archive.*3 entries are one/s);
});

test('a finished zip is read back: stored and deflated entries, small and large, named and renamed archives', async () => {
  const clean = await zipOf(join(root, 'clean.zip'), {'a/text.txt': 'hello '.repeat(5000), 'a/small.txt': 'x', 'a/blank': '', 'a/big.bin': Buffer.alloc(300_000, 3)});
  assert.deepEqual(await archivesInZip(clean), []);
  const dirty = await zipOf(join(root, 'dirty.zip'), {'a/text.txt': 'hello', 'a/renamed.dat': Buffer.concat([SAMPLES.gzip, Buffer.alloc(100_000, 9)]),
    'a/big-renamed.dat': Buffer.concat([SAMPLES.zip, Buffer.alloc(900_000, 1)]), 'a/named.tar': 'not a tar'});
  const found = await archivesInZip(dirty);
  assert.deepEqual(found.map(line => line.split(' ')[0]).sort(), ['a/big-renamed.dat', 'a/named.tar', 'a/renamed.dat']);
  // The head of a deflated entry is the start of its bytes, not of the compressed stream.
  const entry = (await listZip(dirty)).find(item => item.name === 'a/big-renamed.dat');
  assert.equal(entry.method, 8);
  assert.deepEqual([...(await entryHead(dirty, entry, 4))], [0x50, 0x4b, 0x03, 0x04]);
});

test('the Full zip builder refuses a nested archive from either input, by name and by first bytes', async () => {
  const FROM = config.runtimeBase.required, VERSION = '0.4.0', note = 'the standard install note';
  const update = extra => ({
    [INSTALL_NOTE_PATH]: note, [`${MOD}/release.json`]: JSON.stringify({product: config.product, package: 'scripts', version: VERSION, game: '2.5', commit: 'abc', runtimeBase: FROM}),
    [`${MOD}/init.lua`]: 'lua', ...extra});
  const runtime = extra => ({
    [INSTALL_NOTE_PATH]: note, [`${APP}/release.json`]: JSON.stringify({product: config.product, package: 'runtime', kind: 'base', version: VERSION, game: '2.5'}),
    [`${APP}/models/lipsync/face-lexicon.txt`]: 'hello HH AH L OW\n', ...extra});
  const fix = async (name, u, r) => {
    const dir = join(root, name);
    await mkdir(dir, {recursive: true});
    await zipOf(join(dir, 'u.zip'), u); await zipOf(join(dir, 'r.zip'), r);
    return {updatePath: join(dir, 'u.zip'), runtimePath: join(dir, 'r.zip'), outDir: join(dir, 'out'), version: VERSION, game: '2.5', config, log: () => {}};
  };
  assert.equal((await buildFull(await fix('good', update(), runtime()))).file, 'AI-NPC-LLM-Companions-0.4.0.zip');
  // By name: caught when the two packages are planned.
  await assert.rejects(buildFull(await fix('gz-name', update(), runtime({[`${APP}/models/lipsync/face-lexicon.txt.gz`]: gzipSync(Buffer.from('x'))}))),
    /face-lexicon\.txt\.gz is an archive by its name/);
  // By first bytes: a zip and a gzip named like data.
  await assert.rejects(buildFull(await fix('zip-bytes', update({[`${MOD}/data.dat`]: SAMPLES.zip}), runtime())), /data\.dat is a zip archive by its first bytes/);
  await assert.rejects(buildFull(await fix('gzip-bytes', update(), runtime({[`${APP}/python/x/atlas.dat`]: SAMPLES.gzip}))), /atlas\.dat is a gzip archive by its first bytes/);
  assert.equal(existsSync(join(root, 'zip-bytes', 'out')), false, 'nothing is written when the guard refuses');
  // planFull alone sees the names.
  const rows = names => names.map(name => ({name, crc: 1, uncompressed: 1}));
  const plan = planFull({update: {label: 'u', entries: rows([INSTALL_NOTE_PATH, `${MOD}/init.lua`]), release: {package: 'scripts', version: VERSION, game: '2.5', runtimeBase: FROM}, extra: {removes: []}},
    runtime: {label: 'r', entries: rows([INSTALL_NOTE_PATH, `${APP}/x/data.tar.gz`]), release: {package: 'runtime', kind: 'base', version: VERSION, game: '2.5'}, extra: {removes: []}},
    config, game: '2.5', version: VERSION});
  assert(plan.problems.some(problem => /data\.tar\.gz is an archive by its name.*no archive/.test(problem)), plan.problems.join(' | '));
});

test('a Runtime update zip refuses to carry an archive', async () => {
  const release = version => JSON.stringify({package: 'runtime', version, game: '2.5'});
  const dir = join(root, 'update');
  await mkdir(dir, {recursive: true});
  const oldZip = await zipOf(join(dir, 'old.zip'), {[`${APP}/release.json`]: release('0.4.0'), [`${APP}/a.txt`]: 'a'});
  const fine = await zipOf(join(dir, 'new-fine.zip'), {[`${APP}/release.json`]: release('0.4.1'), [`${APP}/a.txt`]: 'b', [`${APP}/models/lipsync/face-lexicon.txt`]: 'hello HH AH L OW\n'});
  const summary = await buildRuntimeUpdate({oldZips: [oldZip], newZips: [fine], out: join(dir, 'out-fine'), listing: null, log: () => {}});
  assert.equal(summary.added, 1);
  for (const [label, extra] of [['name', {[`${APP}/models/lipsync/face-lexicon.txt.gz`]: 'x'}], ['bytes', {[`${APP}/bridge/blob.dat`]: SAMPLES['7z']}]]) {
    const bad = await zipOf(join(dir, `new-${label}.zip`), {[`${APP}/release.json`]: release('0.4.1'), [`${APP}/a.txt`]: 'b', ...extra});
    await assert.rejects(buildRuntimeUpdate({oldZips: [oldZip], newZips: [bad], out: join(dir, `out-${label}`), listing: null, log: () => {}}), /would hold an archive/);
    assert.equal(existsSync(join(dir, `out-${label}`, 'Runtime-Update-0.4.0-to-0.4.1.zip.tmp')), false, 'no half-written zip is left');
  }
});

test('the archives of the 0.3.5 Runtime are pruned from its Python, and an update removes them from an install that has them', async () => {
  const gone = ['networkx/generators/atlas.dat.gz', 'scipy/stats/_sobol_direction_numbers.npz', 'scipy-1.18.1-cp312-cp312-win_amd64.whl'];
  for (const rel of gone) assert.equal(pythonPruned(`Lib/site-packages/${rel}`), true, rel);
  // What stays: the modules that read them (they only open the file when called) and every other numpy/scipy file.
  for (const rel of ['networkx/generators/atlas.py', 'networkx/generators/__init__.py', 'scipy/stats/_sobol.cp312-win_amd64.pyd', 'scipy/stats/_qmc.py', 'scipy/signal/__init__.py', 'numpy/__init__.py']) {
    assert.equal(pythonPruned(`Lib/site-packages/${rel}`), false, rel);
  }
  const declared = JSON.parse(await readFile(resolve(project, DECLARED_REMOVALS), 'utf8')).removes;
  const wanted = [`${APP}/models/lipsync/face-lexicon.txt.gz`, ...gone.map(rel => `${SITE}/${rel}`)];
  for (const path of wanted) assert(declared.includes(path), `${path} is in the declared removals`);
  assert.deepEqual(checkRemovals(wanted).refused, [], 'the start step may delete them');
});

test('the lip-sync table is built into the Runtime as plain text and the notice names it', async () => {
  const group = config.models.groups.find(item => item.target === 'app/models/lipsync/');
  assert.deepEqual(group.unpack, {'face-lexicon.txt.gz': 'face-lexicon.txt'});
  assert(group.files.includes('face-lexicon.txt.gz'), 'the model bucket keeps its gzip, the build unpacks it');
  const builder = await readFile(resolve(project, 'packaging/build-release.mjs'), 'utf8');
  assert.match(builder, /gunzipSync\(await readFile\(path\)\)/);
  assert.match(builder, /app\/models\/lipsync\/face-lexicon\.txt\)/);
  assert.doesNotMatch(builder, /app\/models\/lipsync\/face-lexicon\.txt\.gz/);
  assert.match(builder, /ARCHIVE_GUARDED_PACKAGES\.includes\(id\)\) await assertNoArchives\(id, pkg\.entries\)/, 'checked before the zips are written');
  assert.match(builder, /archivesInZip\(resolve\(out, 'packages', item\.file\)\)/, 'and again on the finished zips');
});

test('state preparation puts the plain table in the data folder and drops the older gzip copy', async () => {
  const dir = join(root, 'state');
  const install = async (name, lexicon) => {
    const game = join(dir, name), app = join(game, APP);
    await mkdir(join(app, 'defaults'), {recursive: true});
    await mkdir(join(app, 'models/lipsync'), {recursive: true});
    await writeFile(join(app, 'defaults/pocket-voices.autobest.json'), JSON.stringify({version: 1, provider: 'pocket', engine: 'pocket-tts', runtime: {}, voices: {}}));
    for (const file of MANAGED_FILES) await writeFile(join(app, 'defaults', file), JSON.stringify({file, v: 1}));
    await writeFile(join(app, 'models/lipsync/face-model.json'), '{}');
    for (const [file, bytes] of Object.entries(lexicon)) await writeFile(join(app, 'models/lipsync', file), bytes);
    return installLayout({appDirectory: app, gameRoot: game});
  };
  const layout = await install('new', {'face-lexicon.txt': 'hello HH AH L OW\n'});
  await mkdir(join(layout.state, 'lipsync-model'), {recursive: true});
  await writeFile(join(layout.state, 'lipsync-model/face-lexicon.txt.gz'), gzipSync('hello HH AH L OW\n'));
  const lines = [];
  await prepareState(layout, {log: line => lines.push(line)});
  assert.equal(await readFile(join(layout.state, 'lipsync-model/face-lexicon.txt'), 'utf8'), 'hello HH AH L OW\n');
  await assert.rejects(readFile(join(layout.state, 'lipsync-model/face-lexicon.txt.gz')), /ENOENT/);
  assert(lines.some(line => /Removed the older lipsync-model\/face-lexicon\.txt\.gz/.test(line)));
  // An install whose Runtime still has only the older gzip keeps it: the bridge reads it.
  const only = await install('only', {'face-lexicon.txt.gz': gzipSync('x')});
  await prepareState(only);
  assert((await readFile(join(only.state, 'lipsync-model/face-lexicon.txt.gz'))).length > 0);
});
