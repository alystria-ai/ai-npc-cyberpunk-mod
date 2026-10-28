// The Full install zip (packaging/build-full.mjs, packaging/lib/full-package.mjs; docs/PACKAGING.md, "The Full install package"): the update zip and the
// Runtime base zip of one game version in ONE zip. Small fixture zips, no build, no download.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipWriter, listZip} from './lib/zip.mjs';
import {readEntry} from './lib/zip-entry.mjs';
import {GAME_VARIANTS} from './lib/game-variants.mjs';
import {CODE_FOLDER, CODE_MANIFEST} from './lib/code-payload.mjs';
import {INSTALL_NOTE_PATH} from './lib/pack-overlap.mjs';
import {REMOVALS_ENTRY} from './lib/runtime-removals.mjs';
import {FULL_NOTE, FULL_NOTE_NAME, fullBaseName, runtimeZipName, updateBaseName, updateBaseNameFor, updateFrom} from './lib/full-package.mjs';
import {buildFull} from './build-full.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(project, 'packaging/release.config.json'), 'utf8'));
const MOD = config.layout.modDirectory, PLUGIN = config.layout.pluginDirectory;
const FROM = config.runtimeBase.required;
const VERSION = '0.3.4';
const STAMP = new Date(Date.UTC(2026, 9, 28, 12, 0, 0));

const STANDARD_NOTE = 'the standard install note, the same bytes in every package';
const updateFiles = (game = '2.5', extra = {}) => ({
  [INSTALL_NOTE_PATH]: STANDARD_NOTE,
  [`${MOD}/release.json`]: JSON.stringify({product: config.product, package: 'scripts', version: VERSION, game, commit: 'abc', runtimeBase: FROM}),
  [`${MOD}/init.lua`]: 'lua code',
  [`${MOD}/README.txt`]: 'readme',
  [`${CODE_FOLDER}/CyberpunkConvai.dll`]: 'launcher',
  [`${CODE_FOLDER}/install-code.mjs`]: 'installer',
  [`${CODE_FOLDER}/${CODE_MANIFEST}`]: JSON.stringify({version: 1, files: [], removes: []}),
  [`${CODE_FOLDER}/app/bridge/convai-bridge.mjs`]: 'bridge code '.repeat(100),
  'r6/scripts/CyberpunkConvai/Main.reds': 'redscript',
  ...extra,
});
const runtimeFiles = (game = '2.5', extra = {}) => ({
  [INSTALL_NOTE_PATH]: STANDARD_NOTE,
  [`${PLUGIN}/app/release.json`]: JSON.stringify({product: config.product, package: 'runtime', kind: 'base', version: VERSION, game}),
  [REMOVALS_ENTRY]: JSON.stringify({version: VERSION, removes: []}),
  [`${PLUGIN}/README.txt`]: 'readme',
  [`${PLUGIN}/CyberpunkConvaiBase.dll`]: 'base marker',
  [`${PLUGIN}/app/node/node.exe`]: 'node '.repeat(500),
  [`${PLUGIN}/app/models/model.bin`]: 'model '.repeat(300),
  'archive/pc/mod/convai_facial.archive': 'archive',
  ...extra,
});

async function zipOf(path, files) {
  const writer = await ZipWriter.create(path, {timestamp: STAMP});
  for (const name of Object.keys(files).sort()) await writer.add(name, {buffer: Buffer.from(files[name])});
  await writer.close();
  return path;
}

let root;
before(async () => { root = await mkdtemp(join(tmpdir(), 'build-full-')); });
after(async () => { if (root) await rm(root, {recursive: true, force: true}); });

async function fixture(name, {game = '2.5', update = {}, runtime = {}, drop = []} = {}) {
  const dir = join(root, name);
  const base = {updatePath: join(dir, 'update.zip'), runtimePath: join(dir, 'runtime.zip'), outDir: join(dir, 'out')};
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, {recursive: true});
  const updateSet = updateFiles(game, update), runtimeSet = runtimeFiles(game, runtime);
  for (const key of drop) { delete updateSet[key]; delete runtimeSet[key]; }
  await zipOf(base.updatePath, updateSet);
  await zipOf(base.runtimePath, runtimeSet);
  return {...base, version: VERSION, game, config, updateSet, runtimeSet};
}

test('the names follow game-variants.json: the Full zip and the update carry the game suffix, none for 2.5, -for-2.31 for 2.31', () => {
  assert.equal(GAME_VARIANTS['2.5'].suffix, '');
  assert.equal(fullBaseName('0.3.4', '2.5'), 'AI-NPC-LLM-Companions-0.3.4');
  assert.equal(fullBaseName('0.3.4', '2.31'), 'AI-NPC-LLM-Companions-0.3.4-for-2.31');
  assert.equal(updateBaseName('0.3.3', '0.3.4', '2.5'), 'AI-NPC-LLM-Companions-Update-0.3.3-to-0.3.4');
  assert.equal(updateBaseName('0.3.3', '0.3.4', '2.31'), 'AI-NPC-LLM-Companions-Update-0.3.3-to-0.3.4-for-2.31');
  assert.equal(runtimeZipName('0.3.4', '2.31'), 'Runtime-0.3.4-for-2.31.zip');
  assert.throws(() => fullBaseName('0.3.4', '3.0'), /Unknown game/);
  // The Full name has no "Full", no "Scripts" and no product prefix of the old files.
  assert.doesNotMatch(fullBaseName('0.3.4', '2.5'), /Full|Scripts|Cyberpunk-Mod/);
});

for (const game of ['2.5', '2.31']) {
  test(`game ${game}: the Full zip holds exactly the union of the update and the Runtime base, byte for byte, with one install note of its own`, async () => {
    const f = await fixture(`union-${game}`, {game});
    const result = await buildFull({...f, log: () => {}});
    const suffix = GAME_VARIANTS[game].suffix;
    assert.equal(result.file, `AI-NPC-LLM-Companions-${VERSION}${suffix}.zip`);
    assert.deepEqual((await readdir(f.outDir)).sort(), [`AI-NPC-LLM-Companions-${VERSION}${suffix}.files.json`, result.file].sort(), 'the zip and its files.json, nothing else');
    const entries = await listZip(result.path);
    const names = entries.map(entry => entry.name).sort();
    const union = [...Object.keys(f.updateSet), ...Object.keys(f.runtimeSet)].filter(name => name !== INSTALL_NOTE_PATH);
    assert.deepEqual(names, [...union, FULL_NOTE_NAME].sort(), 'the union of both, the standard note replaced by the Full note');
    assert.equal(new Set(names.map(name => name.toLowerCase())).size, names.length);
    assert.equal(names.includes(INSTALL_NOTE_PATH), false, 'the install text exists once, and it is the Full one');
    // Every file has the bytes it has in its package.
    for (const [name, text] of Object.entries({...f.updateSet, ...f.runtimeSet})) {
      if (name === INSTALL_NOTE_PATH) continue;
      assert.equal((await readEntry(result.path, entries.find(entry => entry.name === name))).toString(), text, name);
    }
    assert.equal((await readEntry(result.path, entries.find(entry => entry.name === FULL_NOTE_NAME))).toString(), FULL_NOTE);
    // The files.json lists every entry with its size and SHA-256, like the other packages, and the zip is deterministic.
    const list = JSON.parse(await readFile(join(f.outDir, `AI-NPC-LLM-Companions-${VERSION}${suffix}.files.json`), 'utf8'));
    assert.deepEqual(list.map(row => row.path).sort(), names);
    assert(list.every(row => /^[0-9a-f]{64}$/.test(row.sha256) && Number.isSafeInteger(row.bytes)));
    const again = await buildFull({...f, outDir: join(f.outDir, 'again'), log: () => {}});
    assert.equal(again.sha256, result.sha256, 'the same inputs give the same zip');
  });
}

test('the update is named from the base it needs: <from> is that version when it is the release just before, "any" when the update covers several releases', () => {
  const at = (required, previousRelease) => ({runtimeBase: {required, previousRelease}});
  // 0.3.4 on the 0.3.3 base: one earlier release, so the version itself.
  assert.equal(updateFrom(at('0.3.3', '0.3.3')), '0.3.3');
  assert.equal(updateBaseNameFor(at('0.3.3', '0.3.3'), '0.3.4', '2.5'), 'AI-NPC-LLM-Companions-Update-0.3.3-to-0.3.4');
  assert.equal(updateBaseNameFor(at('0.3.3', '0.3.3'), '0.3.4', '2.31'), 'AI-NPC-LLM-Companions-Update-0.3.3-to-0.3.4-for-2.31');
  // 0.3.5 on the same base: it covers 0.3.3 and 0.3.4, so "any".
  assert.equal(updateFrom(at('0.3.3', '0.3.4')), 'any');
  assert.equal(updateBaseNameFor(at('0.3.3', '0.3.4'), '0.3.5', '2.5'), 'AI-NPC-LLM-Companions-Update-any-to-0.3.5');
  assert.equal(updateBaseNameFor(at('0.3.3', '0.3.4'), '0.3.5', '2.31'), 'AI-NPC-LLM-Companions-Update-any-to-0.3.5-for-2.31');
  // A base raised in the release itself is "the release before" again.
  assert.equal(updateFrom(at('0.3.5', '0.3.5')), '0.3.5');
  // Numeric, not text, order; and a config that cannot tell stops the build instead of guessing a name.
  assert.equal(updateFrom(at('0.3.9', '0.3.10')), 'any');
  assert.throws(() => updateFrom({runtimeBase: {required: '0.3.3'}}), /previousRelease/);
  assert.throws(() => updateFrom(at('0.3.4', '0.3.3')), /newer than the previous release/);
  assert.throws(() => updateFrom(at('latest', '0.3.3')), /not a version/);
  // The real config is the 0.3.4 one.
  assert.equal(updateFrom(config), '0.3.3');
  assert.equal(updateBaseName('any', '0.3.5', '2.5'), 'AI-NPC-LLM-Companions-Update-any-to-0.3.5');
});

test('the Full note says where to extract, that it holds everything, and that Vortex and Mod Organizer 2 take two mods; it is the only note and is worded for the Full zip', () => {
  assert.match(FULL_NOTE, /Extract this zip INTO your Cyberpunk 2077 folder/);
  assert.match(FULL_NOTE, /holds everything/);
  assert.match(FULL_NOTE, /Vortex or Mod Organizer 2\? Add this zip as ONE mod/);
  assert.match(FULL_NOTE, /Remove older separate\s+Scripts and Runtime mods first/);
  assert.match(FULL_NOTE, /Do not add the small Update zip to a mod manager/);
  assert.notEqual(FULL_NOTE_NAME, INSTALL_NOTE_PATH, 'the standard note is fixed text and keeps its own file name');
  assert.doesNotMatch(FULL_NOTE, /;/);
});

test('overlap is refused loudly and no zip is left: a path in both packages, also with another case', async () => {
  for (const [name, extra] of [['same', {[`${CODE_FOLDER}/app/bridge/convai-bridge.mjs`]: 'other'}], ['case', {[`${CODE_FOLDER}/APP/bridge/Convai-Bridge.mjs`]: 'other'}]]) {
    const f = await fixture(`overlap-${name}`, {runtime: extra});
    await assert.rejects(buildFull({...f, log: () => {}}), error => /overlap in 1 path/.test(error.message) && /convai-bridge\.mjs/i.test(error.message));
    assert.equal(existsSync(f.outDir) ? (await readdir(f.outDir)).length : 0, 0, 'nothing written');
  }
  // A shared file that is byte for byte the same is an overlap too: only the install note may be in both.
  const f = await fixture('overlap-identical', {runtime: {'r6/scripts/CyberpunkConvai/Main.reds': 'redscript'}});
  await assert.rejects(buildFull({...f, log: () => {}}), /overlap/);
});

test('the install note must be the same in both, and every other guard runs over the union', async () => {
  const cases = [
    ['note differs', {runtime: {[INSTALL_NOTE_PATH]: 'another note'}}, /same install note/],
    ['code in the Runtime base', {runtime: {[`${PLUGIN}/app/bridge/convai-bridge.mjs`]: 'code'}}, /carries code that belongs to the update/],
    ['launcher in the Runtime base', {runtime: {[`${CODE_FOLDER}/other.dll`]: 'dll'}}, /carries code that belongs to the update/],
    ['runtime file in the update', {update: {[`${PLUGIN}/app/node/extra.exe`]: 'x'}}, /Runtime's plugin folder/],
    ['a file the mod rewrites', {update: {[`${MOD}/runtime/player-memory.json`]: '{}'}}, /writes or deletes/],
    ['a Convai key file', {runtime: {[`${PLUGIN}/app/convai-key.txt`]: 'k'}}, /forbidden file|key file/],
    ['the development launcher', {update: {'red4ext/plugins/CyberpunkConvaiLauncher/launcher.dll': 'x'}}, /unexpected RED4ext plugin file/],
    ['developer material', {runtime: {'misc/notes.txt': 'x'}}, /developer-only material/],
    ['a plugin DLL of the Runtime', {runtime: {[`${PLUGIN}/CyberpunkConvai.dll`]: 'old launcher'}}, /unexpected RED4ext plugin file|writes or deletes/],
  ];
  for (const [name, set, pattern] of cases) {
    const f = await fixture(`guard-${name.replace(/\W+/g, '-')}`, set);
    await assert.rejects(buildFull({...f, log: () => {}}), error => pattern.test(error.message), name);
  }
});

test('the two must be the same version, game and kind, and the base new enough for the update', async () => {
  const wrong = async (name, set, pattern) => {
    const f = await fixture(`meta-${name}`, set);
    await assert.rejects(buildFull({...f, log: () => {}}), error => pattern.test(error.message), name);
  };
  await wrong('update game', {update: {[`${MOD}/release.json`]: JSON.stringify({package: 'scripts', version: VERSION, game: '2.31', runtimeBase: FROM})}}, /built for game 2\.31, not 2\.5/);
  await wrong('runtime game', {runtime: {[`${PLUGIN}/app/release.json`]: JSON.stringify({package: 'runtime', kind: 'base', version: VERSION, game: '2.31'})}}, /built for game 2\.31, not 2\.5/);
  await wrong('update version', {update: {[`${MOD}/release.json`]: JSON.stringify({package: 'scripts', version: '0.3.3', game: '2.5', runtimeBase: FROM})}}, /is version 0\.3\.3, not 0\.3\.4/);
  await wrong('old base', {runtime: {[`${PLUGIN}/app/release.json`]: JSON.stringify({package: 'runtime', kind: 'base', version: '0.3.2', game: '2.5'})}}, /older than the/);
  await wrong('not a base', {runtime: {[`${PLUGIN}/app/release.json`]: JSON.stringify({package: 'runtime', version: VERSION, game: '2.5'})}}, /not a Runtime base/);
  await wrong('swapped', {update: {[`${MOD}/release.json`]: JSON.stringify({package: 'runtime', version: VERSION, game: '2.5', runtimeBase: FROM})}}, /not the update package/);
});

test('the command line builds from a packages folder by the names a release build writes, and adds the zip to release-manifest.json', async () => {
  const dir = join(root, 'cli');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, {recursive: true});
  await zipOf(join(dir, `${updateBaseNameFor(config, VERSION, '2.31')}.zip`), updateFiles('2.31'));
  await zipOf(join(dir, runtimeZipName(VERSION, '2.31')), runtimeFiles('2.31'));
  await writeFile(join(dir, 'release-manifest.json'), JSON.stringify({version: VERSION, packages: {scripts: {}, runtime: {}}}));
  const run = spawnSync(process.execPath, [resolve(project, 'packaging/build-full.mjs'), '--version', VERSION, '--game', '2.31', '--packages', dir], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert(existsSync(join(dir, `AI-NPC-LLM-Companions-${VERSION}-for-2.31.zip`)));
  const manifest = JSON.parse(await readFile(join(dir, 'release-manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.packages), ['scripts', 'runtime', 'full']);
  assert.equal(manifest.packages.full.archives[0].file, `AI-NPC-LLM-Companions-${VERSION}-for-2.31.zip`);
  // A missing input stops it, and a wrong game for the files named stops it before anything is written.
  const missing = spawnSync(process.execPath, [resolve(project, 'packaging/build-full.mjs'), '--version', VERSION, '--packages', dir], {encoding: 'utf8'});
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /zip is missing/);
});

test('the combined zip stays under the size one upload takes', async () => {
  const f = await fixture('limit');
  await assert.rejects(buildFull({...f, config: {...config, limits: {...config.limits, assetBytes: 100}}, log: () => {}}), /over the .* a single upload takes/);
  assert.equal((await readdir(f.outDir)).filter(name => name.endsWith('.zip')).length, 0);
});
