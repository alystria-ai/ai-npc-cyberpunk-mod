// A new version reuses the optional packs unchanged (server-side copies on Hugging Face), so its Scripts and Runtime meet the OLD pack files in
// the player's game folder. These tests hold the rule that makes "Replace" always safe: the Runtime and the Scripts never carry a path a pack
// carries with other bytes (docs/PACKAGING.md, "Packs reused unchanged"). They use committed listings of the packs (path, size, CRC-32), never the packs
// themselves: the five 0.2.1 packs (packs-0.2.1.json: the rule's history and the 0.2.1 Runtime that broke it) and the five packs rebuilt for 0.2.9
// (packs-0.2.9.json: the stricter rule, the Runtime and the packs ship no file in common).
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
  compareWithPacks, countByFolder, duplicatePaths, runtimePathFor, validateListing, zipFiles} from './lib/pack-overlap.mjs';
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
    assert.match(cli.stdout, /OK: the zip ships no file a pack ships \(the install note apart\)/);
    // The rule of 0.2.1 to 0.2.8 is still there for the old listing: a shared file may have the same bytes.
    const lenient = spawnSync(process.execPath, [resolve(project, 'packaging/check-pack-overlap.mjs'), 'check', zip, '--listing', resolve(project, 'packaging/pack-listings/packs-0.2.1.json'), '--allow-identical'], {encoding: 'utf8'});
    assert.equal(lenient.status, 0, lenient.stdout + lenient.stderr);
    assert.match(lenient.stdout, /OK: every file shared with a pack has the same bytes/);
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

// The directory of a ZIP64 archive like the 6.5 GB OmniVoice pack: it starts past 4 GiB (the end record says 0xFFFFFFFF and the ZIP64 records hold the
// real offset), an entry's local header past 4 GiB is named only in its ZIP64 extra field, and an entry over 4 GiB has both sizes there.
function zip64Tail(entries, directoryOffset) {
  const directory = Buffer.concat(entries.map(({name, crc, size, offset}) => {
    const nameBytes = Buffer.from(name), big = size >= 0xFFFFFFFF, far = offset >= 0xFFFFFFFF, fields = [];
    if (big) { const sizes = Buffer.alloc(16); sizes.writeBigUInt64LE(BigInt(size), 0); sizes.writeBigUInt64LE(BigInt(size), 8); fields.push(sizes); }
    if (far) { const at = Buffer.alloc(8); at.writeBigUInt64LE(BigInt(offset)); fields.push(at); }
    const extra = fields.length ? Buffer.concat([Buffer.from([1, 0, 0, 0]), ...fields]) : Buffer.alloc(0);
    if (fields.length) extra.writeUInt16LE(extra.length - 4, 2);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(45, 4); record.writeUInt16LE(45, 6);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(big ? 0xFFFFFFFF : size, 20); record.writeUInt32LE(big ? 0xFFFFFFFF : size, 24);
    record.writeUInt16LE(nameBytes.length, 28); record.writeUInt16LE(extra.length, 30); record.writeUInt32LE(far ? 0xFFFFFFFF : offset, 42);
    return Buffer.concat([record, nameBytes, extra]);
  }));
  const end64 = Buffer.alloc(56);
  end64.writeUInt32LE(0x06064b50, 0); end64.writeBigUInt64LE(44n, 4); end64.writeUInt16LE(45, 12); end64.writeUInt16LE(45, 14);
  end64.writeBigUInt64LE(BigInt(entries.length), 24); end64.writeBigUInt64LE(BigInt(entries.length), 32);
  end64.writeBigUInt64LE(BigInt(directory.length), 40); end64.writeBigUInt64LE(BigInt(directoryOffset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(directoryOffset + directory.length), 8); locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(0xFFFFFFFF, 16);
  return Buffer.concat([directory, end64, locator, end]);
}

test('a ZIP64 pack past 4 GiB is listed from its directory alone, with the real sizes, and compared like any other', async () => {
  const directoryOffset = 6_500_000_000;
  const tail = zip64Tail([
    {name: `${PLUGIN}/app/omni/model/model.safetensors`, crc: 0x11111111, size: 4_900_000_000, offset: 0},
    {name: `${PLUGIN}/voices/picked/autobest/omni-long/judy-alvarez.wav`, crc: 0x22222222, size: 600_000, offset: 5_000_000_000},
    {name: `${PLUGIN}/app/omni/omni-pack.json`, crc: 0x33333333, size: 333, offset: 6_400_000_000}], directoryOffset);
  let bytesRead = 0;
  // A 6.5 GB file in which only the directory exists: anything read before it is zeros, and the total read is counted.
  const reader = {size: directoryOffset + tail.length, label: 'virtual.zip', async read(position, length) {
    bytesRead += length;
    const buffer = Buffer.alloc(length);
    if (position + length > directoryOffset) tail.copy(buffer, Math.max(0, directoryOffset - position), Math.max(0, position - directoryOffset));
    return buffer;
  }};
  const files = zipFiles(await listZip(reader));
  assert.deepEqual(files.map(file => [file.path.split('/').pop(), file.size, file.crc]),
    [['model.safetensors', 4_900_000_000, '11111111'], ['judy-alvarez.wav', 600_000, '22222222'], ['omni-pack.json', 333, '33333333']]);
  assert(bytesRead < 200_000, `read ${bytesRead} bytes`);
  const fake = validateListing({schema: 1, packs: [{name: 'Big', file: 'big.zip', bytes: reader.size, entries: 2, claimed: [],
    files: files.slice(1).map(file => [file.path, file.size, file.crc])}]});
  const same = compareWithPacks(files.slice(1), fake), other = compareWithPacks([{...files[1], size: 600_001}], fake);
  assert.equal(same.ok, true); assert.equal(same.identical.length, 2);
  assert.equal(other.ok, false); assert.deepEqual(other.different[0].packFile, {size: 600_000, crc: '22222222'});
});

test('a path a zip holds twice fails the check when the copies differ (the answer to "Replace or skip?" would pick one), and is named when they do not', async () => {
  const directory = await temporary();
  try {
    // ZipWriter refuses a second copy of a name, so these zips are written with that check turned off, as another tool might write them.
    const loose = async (name, entries) => {
      const zip = await ZipWriter.create(join(directory, name));
      zip.checkName = () => {};
      for (const [path, text] of entries) await zip.add(path, {buffer: Buffer.from(text)});
      await zip.close();
      return join(directory, name);
    };
    const clash = await loose('clash.zip', [[`${PLUGIN}/app/defaults/local-voices.autobest-long.json`, '{"v":1}'],
      [`${PLUGIN}/app/defaults/LOCAL-VOICES.autobest-long.json`, '{"v":22}'], [`${PLUGIN}/app/other.txt`, 'x'], [`${PLUGIN}/app/other.txt`, 'x']]);
    const files = zipFiles(await listZip(clash));
    assert.equal(files.length, 4, 'listZip shows every entry, duplicates included');
    assert.deepEqual(duplicatePaths(files).map(item => [item.path.split('/').pop(), item.copies.length, item.same]),
      [['local-voices.autobest-long.json', 2, false], ['other.txt', 2, true]]);
    lines.length = 0;
    assert.equal(await checkZips([clash], listing, {log: collect}), false);
    assert.match(lines.join('\n'), /holds 2 path\(s\) more than once, 1 with DIFFERENT bytes/);
    assert.match(lines.join('\n'), /local-voices\.autobest-long\.json \(2 copies: 7 bytes, [0-9a-f]{8} \/ 8 bytes, [0-9a-f]{8}\)/);
    assert.equal(spawnSync(process.execPath, [resolve(project, 'packaging/check-pack-overlap.mjs'), 'check', clash], {encoding: 'utf8'}).status, 1);
    // The same bytes twice: Replace is still safe, so it passes, and the path is named.
    const twins = await loose('twins.zip', [[`${PLUGIN}/app/other.txt`, 'x'], [`${PLUGIN}/app/other.txt`, 'x']]);
    lines.length = 0;
    assert.equal(await checkZips([twins], listing, {log: collect}), true);
    assert.match(lines.join('\n'), /holds 1 path\(s\) more than once \(the same bytes each time\)/);
    // A pack with a name twice cannot be listed: the listing holds one size and CRC per path, so making it stops with the path named.
    await assert.rejects(makeListing(join(directory, 'listing.json'), [`Twice=${clash}`], {log: () => {}}), /listed twice/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

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
  assert.match(builder, /import \{RUNTIME_PREPARED_FOLDER, LANGUAGE_PACK_TREE\} from '\.\/lib\/pack-overlap\.mjs'/);
  const bridge = await readFile(resolve(project, 'bridge/convai-bridge.mjs'), 'utf8');
  assert(bridge.includes('cacheDirectory: resolve(voxtralReferenceRoot, PREPARED_FOLDER), shippedDirectories: [resolve(voxtralReferenceRoot, RUNTIME_PREPARED_FOLDER)]'));
});

test("every Runtime the build makes carries its own OmniVoice lists in app/defaults, the same text as the pack's, so an older Runtime's never stay in charge", async () => {
  // The launcher reads app/defaults first and nothing deletes an earlier version's files: a Runtime without lists there would leave the previous
  // Runtime's lists winning over a newer pack's at every start.
  const builder = await readFile(resolve(project, 'packaging/build-release.mjs'), 'utf8');
  const runtime = builder.slice(builder.indexOf('async function runtimePackage('), builder.indexOf('async function voxtralCache('));
  const omni = builder.slice(builder.indexOf('async function omniPackage('), builder.indexOf('async function localAiFile('));
  assert(runtime.includes('for (const name of OMNI_LIST_NAMES) pkg.json(`${app}/defaults/${name}`, await omniListOf(models.files.get(configs.bucket + name), name, config.toolchain.omniModel));'));
  assert(omni.includes('pkg.json(`${omni}/defaults/${name}`, await omniListOf(models.files.get(configs.bucket + name), name, model));'));
  assert.equal(builder.split('await omniListOf(').length - 1, 2, 'one helper makes both copies, so their bytes are the same');
  const {OMNI_CONFIGS} = await import('./runtime/prepare-state.mjs');
  assert(builder.includes(`const OMNI_LIST_NAMES = Object.freeze(['${OMNI_CONFIGS.short}', '${OMNI_CONFIGS.long}']);`), "the launcher's names");
  assert.equal(`${PLUGIN}/app/defaults`.endsWith(RUNTIME_OMNI_LISTS_FOLDER), true);
});

test('the install steps of the README, the player readme and the Nexus page tell players that Replace is safe', async () => {
  for (const file of ['README.md', 'packaging/PLAYER_README.md', 'docs/NEXUS_PAGE.md']) {
    assert.match(await readFile(resolve(project, file), 'utf8'), /If Windows asks about files with the same names, choose Replace: it is always safe\./, file);
  }
});

// ---- the packs rebuilt for 0.2.9: the Runtime and the packs ship no file in common ---------------------------------------------------------------

const listing29 = validateListing(await readJson('packaging/pack-listings/packs-0.2.9.json'));

test('the committed 0.2.9 listing describes the five rebuilt packs and adds up: no engine copy, no tests folders, no draft clips', () => {
  assert.deepEqual(listing29.packs.map(pack => [pack.name, pack.entries, pack.file]), [
    ['OmniPack', 18099, 'OmniPack.zip'], ['LocalAI-Standard', 8, 'LocalAI-Standard.zip'], ['LocalAI-Lite', 8, 'LocalAI-Lite.zip'],
    ['Mature-Standard', 10, 'Mature-Standard.zip'], ['Mature-Lite', 10, 'Mature-Lite.zip']]);
  assert.deepEqual(listing29.packs[0].claimed.map(item => [item.prefix, item.entries]), PACK_OWN_TREES.map((prefix, index) => [prefix, [16985, 159, 11][index]]),
    'the Python environment lost its 4,099 tests files and its two DLL copies: 21086 entries before, 16985 now');
  for (const pack of listing29.packs) {
    for (const [path] of pack.files) {
      assert(!/\/app\/local-ai\/llama\//.test(path), `${pack.name} carries the engine: ${path}`);
      assert(!/llama\.cpp-MIT/.test(path), `${pack.name} carries the engine's licence: ${path}`);
      assert(!/full-cast-draft|\/tests?\//.test(path), `${pack.name}: ${path}`);
    }
  }
  // Every pack carries the install note, the same 574 bytes, and the four model packs the same embedding model and licence texts (each works alone).
  for (const pack of listing29.packs) assert.deepEqual(pack.files.find(([path]) => path === NOTE).slice(1), [574, '0c69b021'], pack.name);
  const embed = listing29.packs.slice(1).map(pack => pack.files.find(([path]) => path.endsWith('granite-embedding-107m-multilingual-Q8_0.gguf')).slice(1).join(':'));
  assert.equal(new Set(embed).size, 1, 'the same embedding model in every Local AI and Mature pack');
});

test('the Runtime check is strict: a file the zip and a pack both ship fails it (the install note excepted), and --allow-identical is the old rule', async () => {
  const directory = await temporary();
  try {
    const clip = `${PLUGIN}/voices/archetypes/omni-long/some-voice.wav`;
    const same = await zipOf(directory, 'same.zip', {[clip]: 'the same clip'});
    // A listing in which the OmniPack ships that very clip (the zip's own size and CRC-32), the install note aside.
    const own = zipFiles(await listZip(same))[0];
    const edited = structuredClone(listing29);
    edited.packs[0].files.push([clip, own.size, own.crc]);
    edited.packs[0].entries++;
    lines.length = 0;
    assert.equal(await checkZips([same], edited, {log: collect}), false, 'strict by default');
    assert.match(lines.join('\n'), /OmniPack: 1 file\(s\) the zip and the pack both ship/);
    assert.match(lines.join('\n'), /FAILED/);
    lines.length = 0;
    assert.equal(await checkZips([same], edited, {log: collect, strict: false}), true, 'the rule of 0.2.1 to 0.2.8: the same bytes are fine');
    // The same path with other bytes fails either way.
    const other = await zipOf(directory, 'other.zip', {[clip]: 'a different clip'});
    assert.equal(await checkZips([other], edited, {log: collect, strict: false}), false);
    // The install note alone is fine, whatever the mode, because every package carries it.
    const note = await zipOf(directory, 'note.zip', {[NOTE]: 'note'});
    const noted = structuredClone(listing29), mine = zipFiles(await listZip(note))[0];
    for (const pack of noted.packs) { const row = pack.files.find(([name]) => name === NOTE); row[1] = mine.size; row[2] = mine.crc; }
    assert.equal(await checkZips([note], noted, {log: collect}), true);
    // The command line: exit 1 strict, 0 with --allow-identical.
    const listingFile = join(directory, 'listing.json');
    await writeFile(listingFile, JSON.stringify(edited));
    const cli = args => spawnSync(process.execPath, [resolve(project, 'packaging/check-pack-overlap.mjs'), 'check', same, '--listing', listingFile, ...args], {encoding: 'utf8'});
    assert.equal(cli([]).status, 1); assert.equal(cli(['--allow-identical']).status, 0);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the real 0.2.9 Scripts package and the committed Runtime file list pass the strict check against the 0.2.9 listing', async () => {
  const runtime = (await readJson('packaging/pack-listings/runtime-0.2.9-pack-folders.json')).files.map(([path, size, crc]) => ({path, size, crc}));
  const result = compareWithPacks(runtime, listing29);
  assert.deepEqual([result.different, result.inPackTrees], [[], []]);
  assert.deepEqual([...new Set(result.identical.map(item => item.path))], [NOTE]);
  const root = await temporary();
  try {
    const zip = await buildScripts(root);
    const cli = spawnSync(process.execPath, [resolve(project, 'packaging/check-pack-overlap.mjs'), 'check', zip], {encoding: 'utf8'});
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  } finally { await rm(root, {recursive: true, force: true}); }
});
