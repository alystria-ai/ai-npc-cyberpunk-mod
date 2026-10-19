// A new version reuses the optional packs unchanged (server-side copies on Hugging Face), so its Scripts and Runtime meet the OLD pack files in
// the player's game folder. These tests hold the rule that makes "Replace" always safe: the Runtime and the Scripts never carry a path a pack
// carries with other bytes (docs/PACKAGING.md, "Packs reused unchanged"). They use a committed listing of the five 0.2.1 packs (path, size, CRC-32:
// packaging/pack-listings/packs-0.2.1.json), never the packs themselves.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {ZipWriter, listZip} from './lib/zip.mjs';
import {PACK_OMNI_LISTS_FOLDER, PACK_OWN_TREES, PACK_PREPARED_FOLDER, PLUGIN, RUNTIME_DROPS, RUNTIME_OMNI_LISTS_FOLDER, RUNTIME_PREPARED_FOLDER,
  compareWithPacks, countByFolder, runtimePathFor, validateListing, zipFiles} from './lib/pack-overlap.mjs';
import {checkZips, makeListing} from './check-pack-overlap.mjs';
import {PREPARED_FOLDER as BRIDGE_CACHE_FOLDER, RUNTIME_PREPARED_FOLDER as BRIDGE_RUNTIME_FOLDER} from '../bridge/voxtral-reference.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const readJson = async rel => JSON.parse(await readFile(resolve(project, rel), 'utf8'));
const listing = validateListing(await readJson('packaging/pack-listings/packs-0.2.1.json'));
const shared = await readJson('packaging/pack-listings/runtime-0.2.1-shared.json');
const sharedFiles = shared.files.map(([path, size, crc]) => ({path, size, crc}));
const NOTE = 'HOW TO INSTALL - extract into your Cyberpunk 2077 folder.txt';
const temporary = () => mkdtemp(join(tmpdir(), 'pack overlap test '));
const where = (result, kind, pack) => result[kind].filter(item => item.pack === pack);

test('the committed listing describes the five 0.2.1 packs and adds up', () => {
  assert.deepEqual(listing.packs.map(pack => [pack.name, pack.entries, pack.file]), [
    ['OmniPack', 22202, 'AI-NPC-Cyberpunk-Mod-OmniPack-0.2.1.zip'],
    ['LocalAI-Standard', 32, 'AI-NPC-Cyberpunk-Mod-LocalAI-Standard-0.2.1.zip'],
    ['LocalAI-Lite', 32, 'AI-NPC-Cyberpunk-Mod-LocalAI-Lite-0.2.1.zip'],
    ['Mature-Standard', 35, 'AI-NPC-Cyberpunk-Mod-Mature-Standard-0.2.1.zip'],
    ['Mature-Lite', 35, 'AI-NPC-Cyberpunk-Mod-Mature-Lite-0.2.1.zip']]);
  // The OmniVoice pack's own trees are claimed, not listed: the Runtime may never put a file there.
  assert.deepEqual(listing.packs[0].claimed.map(item => [item.prefix, item.entries]), PACK_OWN_TREES.map((prefix, index) => [prefix, [21086, 159, 11][index]]));
  assert.throws(() => validateListing({schema: 1, packs: [{name: 'P', entries: 5, claimed: [], files: [['a', 1, '00000000']]}]}), /not 5/);
  assert.throws(() => validateListing({schema: 1, packs: [{name: 'P', entries: 2, claimed: [], files: [['a', 1, '00000000'], ['A', 1, '00000000']]}]}), /twice/);
});

test('the packs share files only byte for byte, so any packs can be extracted in any order', () => {
  let sharedPaths = 0;
  for (const [index, one] of listing.packs.entries()) for (const other of listing.packs.slice(index + 1)) {
    const theirs = new Map(other.files.map(([path, size, crc]) => [path.toLowerCase(), `${size}:${crc}`]));
    for (const [path, size, crc] of one.files) {
      const mine = theirs.get(path.toLowerCase());
      if (mine === undefined) continue;
      sharedPaths++;
      assert.equal(mine, `${size}:${crc}`, `${one.name} and ${other.name} differ at ${path}`);
    }
  }
  assert(sharedPaths > 60, 'the Local AI and Mature packs repeat the engine and the licence texts');
});

test('the 0.2.1 Runtime layout reproduces the conflicts a player saw: 437 on the OmniVoice pack, 291 of them with other bytes', () => {
  const old = compareWithPacks(sharedFiles, listing);
  assert.equal(old.ok, false);
  const omni = {identical: where(old, 'identical', 'OmniPack'), different: where(old, 'different', 'OmniPack')};
  assert.equal(omni.identical.length + omni.different.length, 437, 'the number Windows reported');
  // The two voice lists: the Runtime's are newer (30 more voices, 3 re-pointed clips) than the pack's.
  const lists = omni.different.filter(item => item.path.startsWith(`${PLUGIN}/${PACK_OMNI_LISTS_FOLDER}/`));
  assert.deepEqual(lists.map(item => item.path.split('/').pop()).sort(), ['local-voices.autobest-long.json', 'local-voices.autobest-short.json']);
  for (const item of lists) assert(item.zip.size > item.packFile.size, 'the Runtime copy is the larger, newer one');
  // 216 voices have a slot in both: the Runtime's is made from the Pocket clip, the pack's from the OmniVoice clip (another signature, so another .json;
  // the encoded .ogg is the same file for 143 of them and different for 73).
  const slots = path => path.startsWith(`${PLUGIN}/${PACK_PREPARED_FOLDER}/`);
  assert.equal(omni.different.filter(item => slots(item.path) && item.path.endsWith('.json')).length, 216);
  assert.equal(omni.different.filter(item => slots(item.path) && item.path.endsWith('.ogg')).length, 73);
  assert.deepEqual(countByFolder(omni.different), [['voices/prepared', 289], ['app/omni/defaults', 2]]);
  // What is the same: 143 encoded slots, and three clips the 0.2.1 Runtime still carries although nothing in it uses them.
  assert.equal(omni.identical.filter(item => slots(item.path) && item.path.endsWith('.ogg')).length, 143);
  assert.deepEqual(omni.identical.filter(item => item.path.endsWith('reference.wav')).map(item => item.path.split('/').slice(-2, -1)[0]).sort(), ['coach-fred', 'jim-jarry', 'life-coach']);
  // The Mature packs overlapped only on the install note, with the same bytes ("some files with the same names, apparently the same size").
  for (const name of ['Mature-Standard', 'Mature-Lite']) {
    assert.deepEqual(where(old, 'identical', name).map(item => item.path), [NOTE]);
    assert.deepEqual(where(old, 'different', name), []);
  }
  assert.deepEqual(where(old, 'identical', 'LocalAI-Standard').concat(where(old, 'different', 'LocalAI-Standard'), where(old, 'identical', 'LocalAI-Lite')), []);
});

test('moving the Runtime\'s voice slots and OmniVoice lists to their own paths leaves nothing different, whichever order the zips are extracted in', () => {
  const mapped = sharedFiles.map(file => ({...file, to: runtimePathFor(file.path)}));
  assert.equal(mapped.filter(file => file.to !== null && file.to !== file.path).length, 2 + 216 + 216, 'both lists and every slot file move');
  assert.deepEqual(mapped.filter(file => file.to === null).map(file => file.path).sort(), RUNTIME_DROPS.slice().sort(), 'the three unused clips are left out');
  const result = compareWithPacks(mapped.filter(file => file.to !== null).map(file => ({...file, path: file.to})), listing);
  assert.equal(result.ok, true, JSON.stringify(result.different.slice(0, 3)));
  // The only file still shared is the install note, the same bytes in both Mature packs.
  assert.deepEqual(result.identical.map(item => [item.pack, item.path]), [['Mature-Standard', NOTE], ['Mature-Lite', NOTE]]);
  // Without the drop the three clips would still be shared, byte for byte (harmless, but Windows asks).
  const kept = compareWithPacks(sharedFiles.map(file => ({...file, path: runtimePathFor(file.path) ?? file.path})), listing);
  assert.equal(kept.ok, true); assert.equal(kept.identical.length, 2 + 3);
});

test('the Runtime-only folders and the pack-owned trees do not overlap: no pack has a file in the Runtime\'s slot folder or list folder', () => {
  const runtimeFolders = [`${PLUGIN}/${RUNTIME_PREPARED_FOLDER}/`, `${PLUGIN}/${RUNTIME_OMNI_LISTS_FOLDER}/`].map(folder => folder.toLowerCase());
  for (const pack of listing.packs) for (const [path] of pack.files) {
    assert(!runtimeFolders.some(folder => path.toLowerCase().startsWith(folder)), `${pack.name} carries ${path}`);
  }
  for (const prefix of PACK_OWN_TREES) assert(!runtimeFolders.some(folder => prefix.toLowerCase().startsWith(folder) || folder.startsWith(prefix.toLowerCase())));
  // The folder names the build, the launcher and the bridge use are the same ones.
  assert.equal(`voices/${BRIDGE_RUNTIME_FOLDER}`, RUNTIME_PREPARED_FOLDER);
  assert.equal(`voices/${BRIDGE_CACHE_FOLDER}`, PACK_PREPARED_FOLDER);
});

test('runtimePathFor moves exactly the slot and list folders and nothing near them', () => {
  const p = rel => `${PLUGIN}/${rel}`;
  assert.equal(runtimePathFor(p('voices/prepared/aaron.ogg')), p('voices/prepared-runtime/aaron.ogg'));
  assert.equal(runtimePathFor(p('app/omni/defaults/local-voices.autobest-long.json')), p('app/defaults/local-voices.autobest-long.json'));
  for (const rel of ['voices/prepared-runtime/aaron.ogg', 'voices/prepared-extra/x.json', 'voices/prepared', 'voices/picked/autobest/omni-long/judy.wav',
    'app/omni/omni-pack.json', 'app/defaults/pocket-voices.autobest.json', 'app/omni/defaults']) assert.equal(runtimePathFor(p(rel)), p(rel), rel);
  assert.equal(runtimePathFor('voices/prepared/x.json'), 'voices/prepared/x.json', 'only the plugin folder\'s');
  assert.equal(runtimePathFor(p('voices/full-cast-draft/jim-jarry/reference.wav')), null);
  assert.equal(runtimePathFor(p('voices/full-cast-draft/someone-else/reference.wav')), p('voices/full-cast-draft/someone-else/reference.wav'));
});

test('names are compared like Windows does (without case) and a pack\'s own tree is off limits whatever the bytes', () => {
  const fake = {schema: 1, packs: [{name: 'P', file: 'P.zip', bytes: 1, entries: 3, claimed: [{prefix: 'a/tree/', entries: 1}], files: [['a/File.TXT', 5, '00000001'], ['b/x', 1, '00000002']]}]};
  validateListing(fake);
  const result = compareWithPacks([{path: 'a/file.txt', size: 5, crc: '00000001'}, {path: 'B/X', size: 1, crc: '0000ffff'}, {path: 'A/TREE/new.bin', size: 1, crc: '00000009'},
    {path: 'c/other', size: 1, crc: '00000001'}], fake);
  assert.deepEqual(result.identical.map(item => item.path), ['a/file.txt']);
  assert.deepEqual(result.different.map(item => item.path), ['B/X']);
  assert.deepEqual(result.inPackTrees.map(item => item.path), ['A/TREE/new.bin']);
  assert.equal(result.ok, false);
});

// ---- the real Scripts package -------------------------------------------------------------------------------------------------------------

async function buildScripts(root) {
  const run = spawnSync(process.execPath, [resolve(project, 'packaging/build-release.mjs'), '--version', '0.0.1', '--dry-run', '--packages', 'scripts', '--worktree',
    '--out', join(root, 'out'), '--cache', join(root, 'cache')], {cwd: project, encoding: 'utf8', timeout: 180_000, env: {...process.env, GITHUB_ACTIONS: ''}});
  assert.equal(run.status, 0, run.stderr);
  return join(root, 'out/packages/AI-NPC-Cyberpunk-Mod-Scripts-0.0.1.zip');
}

test('the Scripts package the builder makes shares only identical files with the packs, and its install note is the packs\' copy', async () => {
  const root = await temporary();
  try {
    const zip = await buildScripts(root);
    const files = zipFiles(await listZip(zip));
    const result = compareWithPacks(files, listing);
    assert.equal(result.ok, true, JSON.stringify(result.different));
    // The note: 574 bytes, CRC-32 0c69b021, in the Scripts and in both Mature packs (the other packs were built before the note existed).
    const note = files.find(file => file.path === NOTE);
    assert.deepEqual([note.size, note.crc], [574, '0c69b021']);
    for (const name of ['Mature-Standard', 'Mature-Lite']) {
      assert.deepEqual(listing.packs.find(pack => pack.name === name).files.find(([path]) => path === NOTE).slice(1), [574, '0c69b021']);
      assert.deepEqual(where(result, 'identical', name).map(item => item.path), [NOTE]);
    }
    // The command line says the same thing about the same zip.
    const cli = spawnSync(process.execPath, [resolve(project, 'packaging/check-pack-overlap.mjs'), 'check', zip], {encoding: 'utf8'});
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.match(cli.stdout, /OK: every file shared with a pack has the same bytes/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

// ---- the command line on synthetic zips ---------------------------------------------------------------------------------------------------

async function zipOf(directory, name, files) {
  const zip = await ZipWriter.create(join(directory, name));
  for (const [path, text] of Object.entries(files)) await zip.add(path, {buffer: Buffer.from(text)});
  await zip.close();
  return join(directory, name);
}
const lines = [];
const collect = line => lines.push(line);

test('check passes a zip that moved its slots and lists, and names every folder of one that did not', async () => {
  const directory = await temporary();
  try {
    const slot = 'aaron.json', list = 'local-voices.autobest-short.json';
    const old = await zipOf(directory, 'old.zip', {[`${PLUGIN}/voices/prepared/${slot}`]: '{}', [`${PLUGIN}/app/omni/defaults/${list}`]: '{"voices":{}}',
      [`${PLUGIN}/app/omni/python/python.exe`]: 'x', [`${PLUGIN}/app/other.txt`]: 'only the Runtime'});
    lines.length = 0;
    assert.equal(await checkZips([old], listing, {log: collect}), false);
    const text = lines.join('\n');
    assert.match(text, /OmniPack: 2 file\(s\) with DIFFERENT bytes/);
    assert.match(text, /voices\/prepared: 1/); assert.match(text, /app\/omni\/defaults: 1/);
    assert.match(text, /OmniPack: 1 file\(s\) inside a tree only the OmniVoice pack writes/);
    assert.match(text, /FAILED/);
    const fixed = await zipOf(directory, 'fixed.zip', {[`${PLUGIN}/voices/prepared-runtime/${slot}`]: '{}', [`${PLUGIN}/app/defaults/${list}`]: '{"voices":{}}',
      [`${PLUGIN}/app/other.txt`]: 'only the Runtime'});
    lines.length = 0;
    assert.equal(await checkZips([fixed], listing, {log: collect}), true);
    assert.match(lines.join('\n'), /shares 0 paths with the packs/);
    // The exit code is what a build script looks at.
    assert.equal(spawnSync(process.execPath, [resolve(project, 'packaging/check-pack-overlap.mjs'), 'check', old], {encoding: 'utf8'}).status, 1);
    assert.equal(spawnSync(process.execPath, [resolve(project, 'packaging/check-pack-overlap.mjs'), 'check', fixed], {encoding: 'utf8'}).status, 0);
    assert.equal(spawnSync(process.execPath, [resolve(project, 'packaging/check-pack-overlap.mjs'), 'check'], {encoding: 'utf8'}).status, 2, 'no zip named');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('a pack on a web server is listed by byte ranges, following a redirect, without being downloaded', async () => {
  const directory = await temporary();
  const served = {bytes: 0, ranges: 0};
  let server;
  try {
    const zip = await ZipWriter.create(join(directory, 'pack.zip'));
    await zip.add(`${PLUGIN}/voices/a.txt`, {buffer: Buffer.from('shared bytes')});
    await zip.add(`${PLUGIN}/app/omni/python/lib.bin`, {buffer: Buffer.from('python')});
    await zip.add(`${PLUGIN}/app/local-ai/models/big.gguf`, {buffer: randomBytes(3_000_000)});
    await zip.close();
    const body = await readFile(join(directory, 'pack.zip'));
    server = http.createServer((request, response) => {
      if (request.url === '/resolve/pack.zip') { response.writeHead(302, {location: '/cdn/pack.zip'}); return response.end(); }
      if (request.url !== '/cdn/pack.zip') { response.writeHead(404); return response.end(); }
      if (request.method === 'HEAD') { response.writeHead(200, {'content-length': body.length}); return response.end(); }
      const [from, to] = /bytes=(\d+)-(\d+)/.exec(request.headers.range ?? '').slice(1).map(Number);
      const part = body.subarray(from, to + 1);
      served.bytes += part.length; served.ranges++;
      response.writeHead(206, {'content-length': part.length, 'content-range': `bytes ${from}-${from + part.length - 1}/${body.length}`});
      response.end(part);
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const out = join(directory, 'listing.json');
    const messages = [];
    await makeListing(out, [`Fake=http://127.0.0.1:${server.address().port}/resolve/pack.zip`], {log: line => messages.push(line)});
    const made = validateListing(JSON.parse(await readFile(out, 'utf8')));
    assert.equal(made.packs[0].name, 'Fake'); assert.equal(made.packs[0].file, 'pack.zip'); assert.equal(made.packs[0].bytes, body.length);
    assert.equal(made.packs[0].entries, 3);
    assert.deepEqual(made.packs[0].claimed, [{prefix: PACK_OWN_TREES[0], entries: 1}]);
    assert.deepEqual(made.packs[0].files.map(([path]) => path), [`${PLUGIN}/app/local-ai/models/big.gguf`, `${PLUGIN}/voices/a.txt`]);
    assert(served.ranges >= 2 && served.bytes < 100_000, `read ${served.bytes} bytes of ${body.length} in ${served.ranges} requests`);
    assert.match(messages.join('\n'), /bytes read in all/);
    // The same listing read from the file on disk is identical (path, size, CRC-32).
    const local = join(directory, 'local.json');
    await makeListing(local, [`Fake=${join(directory, 'pack.zip')}`], {log: () => {}});
    assert.deepEqual(JSON.parse(await readFile(local, 'utf8')).packs[0].files, made.packs[0].files);
  } finally { server?.close(); server?.closeAllConnections?.(); await rm(directory, {recursive: true, force: true}); }
});

test('a server that ignores byte ranges stops the listing instead of sending the whole pack', async () => {
  const directory = await temporary();
  let server;
  try {
    server = http.createServer((request, response) => {
      if (request.method === 'HEAD') { response.writeHead(200, {'content-length': 100_000}); return response.end(); }
      response.writeHead(200); response.end(Buffer.alloc(100_000));
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    await assert.rejects(makeListing(join(directory, 'x.json'), [`P=http://127.0.0.1:${server.address().port}/p.zip`], {log: () => {}}), /does not answer byte ranges/);
  } finally { server?.close(); server?.closeAllConnections?.(); await rm(directory, {recursive: true, force: true}); }
});

// ---- the code that follows the rule -------------------------------------------------------------------------------------------------------

test('the build puts the Runtime\'s slots in their own folder and leaves voices/prepared to the OmniVoice pack, and the bridge reads both', async () => {
  const builder = await readFile(resolve(project, 'packaging/build-release.mjs'), 'utf8');
  assert.equal(builder.split('${plugin}/${RUNTIME_PREPARED_FOLDER}').length - 1, 1, 'the Runtime package');
  assert.equal(builder.split('${plugin}/voices/prepared`').length - 1, 1, 'the OmniVoice pack');
  assert.match(builder, /import \{RUNTIME_PREPARED_FOLDER\} from '\.\/lib\/pack-overlap\.mjs'/);
  const bridge = await readFile(resolve(project, 'bridge/convai-bridge.mjs'), 'utf8');
  assert(bridge.includes('cacheDirectory: resolve(voxtralReferenceRoot, PREPARED_FOLDER), shippedDirectories: [resolve(voxtralReferenceRoot, RUNTIME_PREPARED_FOLDER)]'));
});

test('the install steps of the README, the player readme and the Nexus page tell players that Replace is safe', async () => {
  for (const file of ['README.md', 'packaging/PLAYER_README.md', 'docs/NEXUS_PAGE.md']) {
    assert.match(await readFile(resolve(project, file), 'utf8'), /If Windows asks about files with the same names, choose Replace: it is always safe\./, file);
  }
});
