// What the release builder takes from the repository (packaging/release.config.json, packaging/build-release.mjs), checked without
// a build: every input it names exists, and everything the shipped bridge and Lua read from outside their own folder is something a
// package carries. A file that is missing here would only be found by the build on release day, or, for a data read the builder does
// not know about, by a player at start-up.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile, readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {importClosure} from './lib/closure.mjs';
import {loadRuntimeExchange} from './lib/runtime-exchange.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const config = JSON.parse(await readFile(resolve(project, 'packaging/release.config.json'), 'utf8'));
const closure = await importClosure(project, config.bridgeEntries);
const closureText = new Map();
for (const rel of closure) closureText.set(rel, await readFile(resolve(project, rel), 'utf8'));
const code = text => text.split(/\r?\n/).map(line => line.replace(/^\s*(?:\/\/|\*).*$/, '').replace(/\s\/\/.*$/, ''));

test('every file release.config.json names as an input exists in the repository', () => {
  const inputs = [
    ...config.catalogs.map(item => item.source),
    ...config.appData,
    ...config.bridgeWorkers,
    ...config.bridgeEntries,
    ...config.clientModules.map(name => `bridge/${name}`),
    ...Object.values(config.native.licences),
    ...config.releaseData.archives.map(item => item.source),
    ...config.releaseData.managed.map(name => `packaging/release-data/${name}`),
    ...config.maturePack.licenceFiles, config.maturePack.readme, config.maturePack.releaseNotes,
    config.toolchain.python.lock, config.toolchain.omniPython.lock,
    ...config.devOnlyLua.map(name => `mod/${name}`),
    ...config.retiredRedscript.map(name => `r6/scripts/CyberpunkConvai/${name}`),
  ];
  assert(inputs.length > 40, 'the list of inputs is not empty');
  assert.deepEqual(inputs.filter(rel => !existsSync(resolve(project, rel))), []);
  // Each Node package the Runtime copies from node_modules is installed (the builder stops with "run npm ci first" otherwise).
  assert.deepEqual(config.nodePackages.filter(name => !existsSync(resolve(project, 'node_modules', name, 'package.json'))), []);
});

test('config inputs are repository-relative, forward-slashed and stay inside the repository', () => {
  const inputs = [...config.catalogs.flatMap(item => [item.source, item.target]), ...config.appData, ...config.bridgeWorkers,
    ...config.releaseData.archives.flatMap(item => [item.source, item.target]), ...config.retiredRedscript, ...config.devOnlyLua];
  for (const rel of inputs) {
    assert.doesNotMatch(rel, /^[\\/]|^[A-Za-z]:|\.\.|\\/, `${rel} must be a plain relative path with forward slashes`);
  }
  // Two sources never land on one target: the zip writer would refuse the duplicate and stop the whole build.
  const targets = config.catalogs.map(item => item.target.toLowerCase());
  assert.equal(new Set(targets).size, targets.length);
  const archives = config.releaseData.archives.map(item => item.target.toLowerCase());
  assert.equal(new Set(archives).size, archives.length);
});

test('every data file the shipped bridge names by path is in appData or a reviewed intrinsic pack', async () => {
  const {REVIEWED_INTRINSIC_PACKS} = await import(pathToFileURL(resolve(project, 'bridge/intrinsic-character-context.mjs')).href);
  const shipped = new Set([...config.appData, ...REVIEWED_INTRINSIC_PACKS.map(descriptor => descriptor.file)]);
  const unshipped = [];
  for (const [rel, text] of closureText) {
    code(text).forEach((line, index) => {
      for (const match of line.matchAll(/['"`]((?:characters|research)\/[A-Za-z0-9_./-]+\.json)['"`]/g)) {
        if (!shipped.has(match[1])) unshipped.push(`${rel}:${index + 1}: ${match[1]}`);
      }
    });
  }
  assert.deepEqual(unshipped, [], 'add the file to appData in packaging/release.config.json, or the player\'s bridge fails at start-up');
  // The detector is not dead: the data the builder ships under these names is really read.
  for (const name of ['characters/roster.json', 'characters/world-knowledge.json', 'research/cyberpunk/generated/quest-catalog.json']) {
    assert([...closureText.values()].some(text => text.includes(name)), `${name} is read by the bridge`);
  }
});

test('every bare package the shipped bridge imports is one the Runtime package carries', () => {
  const carried = new Set(config.nodePackages);
  const strays = [];
  for (const [rel, text] of closureText) {
    code(text).forEach((line, index) => {
      for (const match of line.matchAll(/(?:\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?|\bexport\s+[\w*{}\s,$]+\s+from\s+|\bimport\(\s*)['"]([^'"./][^'"]*)['"]/g)) {
        const specifier = match[1];
        if (specifier.startsWith('node:')) continue;
        const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        if (!carried.has(name)) strays.push(`${rel}:${index + 1}: ${specifier}`);
      }
    });
  }
  assert.deepEqual(strays, [], 'a package the bridge imports must be in nodePackages (or bundled into the browser client)');
});

test('the page modules the hidden browser loads are exactly the clientModules the Runtime package copies into assets/', () => {
  // realtime-host.mjs reads each PCM module from the assets folder when it starts the page. One that the host lists and the package
  // does not copy stops the browser page (no audio) on every player's machine; they are not in the import closure, so only this list ties them.
  const host = closureText.get('bridge/realtime-host.mjs');
  const listed = /const PCM_MODULES = Object\.freeze\(\[([^\]]+)\]\)/.exec(host)?.[1];
  assert(listed, 'realtime-host.mjs lists PCM_MODULES');
  // The media page (a story pack's music and sounds) has three more, read when that page is first opened.
  const mediaListed = /export const MEDIA_MODULES = Object\.freeze\(\[([^\]]+)\]\)/.exec(host)?.[1];
  assert(mediaListed, 'realtime-host.mjs lists MEDIA_MODULES');
  const modules = [...listed.matchAll(/'([^']+)'/g), ...mediaListed.matchAll(/'([^']+)'/g)].map(match => match[1]).sort();
  assert.deepEqual(modules, [...config.clientModules].sort());
  // The browser bundle itself comes from bridge/realtime-client.mjs through esbuild, never through the Node closure.
  assert(!closure.includes('bridge/realtime-client.mjs'));
  for (const name of config.clientModules) assert(!closure.includes(`bridge/${name}`), `${name} is a page asset, not a service module`);
});

test('every Python file the shipped bridge starts by path is a bridgeWorker (or comes with the OmniVoice pack)', () => {
  // The Python workers are not imports, so the closure cannot find them; the list is the only thing that puts them in the package.
  const shipped = new Set(config.bridgeWorkers.map(worker => worker.split('/').pop()));
  const OMNI_PACK_ONLY = new Set(['tts_backend.py', '__init__.py']); // the VoiceStudio adapter, shipped in the OmniVoice pack (omni-pack.mjs)
  const missing = [];
  for (const [rel, text] of closureText) {
    code(text).forEach((line, index) => {
      for (const match of line.matchAll(/['"`]([A-Za-z0-9_./-]*[A-Za-z0-9_-]+\.py)['"`]/g)) {
        const name = match[1].split('/').pop();
        if (!shipped.has(name) && !OMNI_PACK_ONLY.has(name)) missing.push(`${rel}:${index + 1}: ${match[1]}`);
      }
    });
  }
  assert.deepEqual(missing, []);
  for (const worker of config.bridgeWorkers) assert(worker.startsWith('bridge/'), worker);
});

test('every catalog the Scripts package puts at the mod root is read by the shipped Lua, and no Lua reads a catalog the package lacks', async () => {
  const lua = (await readdir(resolve(project, 'mod'))).filter(name => name.endsWith('.lua') && !config.devOnlyLua.includes(name));
  const text = (await Promise.all(lua.map(name => readFile(resolve(project, 'mod', name), 'utf8')))).join('\n');
  const exchange = await loadRuntimeExchange(project);
  const known = new Set([...exchange.exchange, ...exchange.state, ...exchange.optional, ...exchange.elsewhere]);
  for (const {target} of config.catalogs) assert(text.includes(`'${target}'`) || text.includes(`"${target}"`), `${target} is read by a shipped Lua file`);
  // A bare 'name.json' (no runtime/ folder) opened from the mod folder is a catalog, or a runtime file the Lua puts the folder in front of.
  // Anything else would be a file that is neither shipped nor classified for Mod Organizer 2.
  const catalogs = new Set(config.catalogs.map(item => item.target));
  const unclassified = new Set();
  for (const match of text.matchAll(/['"]([A-Za-z0-9][A-Za-z0-9_.-]*\.json)['"]/g)) {
    if (!catalogs.has(match[1]) && !known.has(match[1])) unclassified.add(match[1]);
  }
  // npc-names.json is the crowd name store a Lua module writes next to init.lua (see the observation in deliverables/tests/REPORT.md).
  unclassified.delete('npc-names.json');
  // release.json is written beside init.lua by the Scripts build (packaging/build-release.mjs) and only read, by the setup check.
  unclassified.delete('release.json');
  assert.deepEqual([...unclassified], [], 'classify the file in packaging/runtime-exchange.json or ship it as a catalog');
});

test('the release ships the quest data: every bond pack, every reach-out file and the gift tables are in appData, and nothing listed is gone', async () => {
  const listed = new Set(config.appData);
  const folders = ['characters/bond-packs', 'characters/reach-outs'];
  const present = [];
  for (const folder of folders) for (const name of await readdir(resolve(project, folder))) if (name.endsWith('.json')) present.push(`${folder}/${name}`);
  present.push('characters/gift-tables.json');
  assert(present.filter(item => item.startsWith('characters/bond-packs/')).length >= 100, 'the pack folder is read');
  assert(present.filter(item => item.startsWith('characters/reach-outs/')).length >= 10, 'the reach-out folder is read');
  assert.deepEqual(present.filter(item => !listed.has(item)), [], 'a data file of the quest update is not in appData: it would not reach the player');
  assert.deepEqual([...listed].filter(item => /^characters\/(?:bond-packs|reach-outs)\//.test(item) && !existsSync(resolve(project, item))), [], 'a listed quest file is gone');
  assert.equal(new Set(config.appData).size, config.appData.length, 'no file is listed twice');
});
