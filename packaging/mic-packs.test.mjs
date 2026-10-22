// The two voice-input packs, MicPack-European and MicPack-Asian, built for real by packaging/build-release.mjs and read back
// (node --test packaging/mic-packs.test.mjs). The committed tests use small generated stand-in files: the pins of release.config.json are
// replaced through --release-config by the stand-ins' sizes and hashes, and the download path is served by a local HTTP server from a
// generated .tar.bz2. No download from the internet, no secret. With CYBERPUNK_CONVAI_MIC_PACKS_DEV set (a folder laid out as
// DIR/<pack id>/<file>) the last test also builds the REAL files against the real pins.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {listZip} from './lib/zip.mjs';
import {validateListing} from './lib/pack-overlap.mjs';
import {checkZips} from './check-pack-overlap.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const builder = resolve(project, 'packaging/build-release.mjs');
const config = JSON.parse(await readFile(resolve(project, 'packaging/release.config.json'), 'utf8'));
const PLUGIN = config.layout.pluginDirectory, STT = `${PLUGIN}/app/models/stt`;
const NOTE = 'HOW TO INSTALL - extract into your Cyberpunk 2077 folder.txt';
const VERSION = '0.2.3';
const TAR = process.platform === 'win32' ? resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const temporary = () => mkdtemp(join(tmpdir(), 'ai npc mic packs '));
const PACKS = Object.values(config.micPacks.packs);
// The packs carry no product prefix (the Scripts alone keep it); the version stays in the build folder, the Hugging Face upload drops it.
const zipName = pack => `${pack.title}-${VERSION}.zip`;

// A stand-in for each model file: deterministic bytes, a different size per file, never the real model.
const standIn = (pack, name, index) => Buffer.from(`stand-in for ${pack.id}/${name} `.repeat(40 + 7 * index) + String(index));

async function writeStandIns(root) {
  const written = new Map(); // `${pack.id}/${name}` -> Buffer
  for (const pack of PACKS) {
    await mkdir(join(root, pack.id), {recursive: true});
    for (const [index, name] of Object.keys(pack.files).entries()) {
      const bytes = standIn(pack, name, index);
      written.set(`${pack.id}/${name}`, bytes);
      await writeFile(join(root, pack.id, name), bytes);
    }
  }
  return written;
}

// The release config with the stand-ins' sizes and hashes, and optionally another archive per pack.
function standInConfig(written, archives = {}) {
  const copy = structuredClone(config);
  for (const [key, pack] of Object.entries(copy.micPacks.packs)) {
    for (const name of Object.keys(pack.files)) {
      const bytes = written.get(`${pack.id}/${name}`);
      if (bytes) pack.files[name] = {size: bytes.length, sha256: sha(bytes)};
    }
    if (archives[key]) Object.assign(pack.archive, archives[key]);
  }
  return copy;
}

// Runs the builder asynchronously (the HTTP server of the download tests lives in this process).
function build({releaseConfig, out, cache, packages, source, env = {}}) {
  const args = [builder, '--version', VERSION, '--dry-run', '--worktree', '--packages', packages, '--out', out, '--cache', cache];
  if (releaseConfig) args.push('--release-config', releaseConfig);
  if (source) args.push('--mic-pack-source', source);
  const environment = {...process.env, ...env};
  if (!('CYBERPUNK_CONVAI_MIC_PACKS_DEV' in env)) delete environment.CYBERPUNK_CONVAI_MIC_PACKS_DEV;
  return new Promise(done => {
    const child = spawn(process.execPath, args, {env: environment, windowsHide: true});
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('close', status => done({status, output}));
  });
}

async function extract(zip, destination) {
  await mkdir(destination, {recursive: true});
  const result = spawnSync(TAR, ['-xf', zip, '-C', destination], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
}

// What a built pack must be: exactly its pinned files, the marker, the notice and the mod licence under app/models/stt/<id>/, and the install note.
async function checkPackZip({zip, pack, spec = pack, root, version = VERSION, real = false}) {
  const entries = await listZip(zip);
  const folder = `${STT}/${pack.id}`;
  const expected = [...Object.keys(spec.files).map(name => `${folder}/${name}`), `${folder}/LICENSE-mod.txt`, `${folder}/NOTICE.txt`, `${folder}/mic-pack.json`, NOTE].sort();
  assert.deepEqual(entries.map(entry => entry.name).sort(), expected, `${pack.title}: exactly these files`);
  for (const entry of entries) {
    assert(entry.name === NOTE || entry.name.startsWith(`${STT}/`), `${entry.name} is under red4ext/plugins/AiNpcCyberpunkMod/app/models/stt or is the install note`);
    assert(!/test_wavs|README|\.wav$|\.\.|\\/i.test(entry.name), entry.name);
    assert(!entry.name.startsWith(`${STT}/moonshine-tiny-en-int8/`), 'the Runtime\'s own folder is not touched');
  }
  const sizes = new Map(entries.map(entry => [entry.name, entry.uncompressed]));
  for (const [name, file] of Object.entries(spec.files)) {
    assert.equal(sizes.get(`${folder}/${name}`), file.size, `${name}: the pinned size`);
    if (name.endsWith('.onnx')) assert.equal(entries.find(entry => entry.name === `${folder}/${name}`).method, 0, `${name} is stored, not deflated`);
  }
  if (real) return entries;
  // Read it back: the model files are the pinned bytes, the marker and notice say what they should.
  const out = join(root, `unpacked-${pack.id}`);
  await extract(zip, out);
  for (const [name, file] of Object.entries(spec.files)) assert.equal(sha(await readFile(join(out, folder, name))), file.sha256, name);
  const marker = JSON.parse(await readFile(join(out, folder, 'mic-pack.json'), 'utf8'));
  assert.deepEqual(marker, {product: config.product, package: pack.packageId, version, commit: 'worktree', pack: pack.id, languages: pack.languages, model: pack.model,
    source: pack.archive.url, archiveSha256: pack.archive.sha256, license: pack.license, licenseUrl: pack.licenseUrl, attribution: pack.attribution});
  const notice = await readFile(join(out, folder, 'NOTICE.txt'), 'utf8');
  assert(notice.includes(pack.licenseUrl), 'the notice carries the licence link');
  assert(notice.includes('\r\n') && !/[^\r]\n/.test(notice), 'the notice has CRLF line ends');
  assert.equal(await readFile(join(out, folder, 'LICENSE-mod.txt'), 'utf8'), await readFile(resolve(project, 'LICENSE'), 'utf8'), 'the mod\'s own licence');
  const note = await readFile(join(out, NOTE), 'utf8');
  assert.match(note, /Extract this zip INTO your Cyberpunk 2077 folder/);
  return entries;
}

test('both packs build from a developer folder: exactly the pinned files, marker, notice, licence and install note, nothing else', async () => {
  const root = await temporary();
  try {
    const source = join(root, 'dev');
    const written = await writeStandIns(source);
    const releaseConfig = join(root, 'release.config.json');
    await writeFile(releaseConfig, JSON.stringify(standInConfig(written)));
    const out = join(root, 'out');
    const result = await build({releaseConfig, out, cache: join(root, 'cache'), packages: 'micpack-european,micpack-asian', source});
    assert.equal(result.status, 0, result.output);
    const names = (await readdir(join(out, 'packages'))).filter(name => name.endsWith('.zip')).sort();
    assert.deepEqual(names, PACKS.map(zipName).sort(), 'one zip each, named after the title, no parts');
    const copy = JSON.parse(await readFile(releaseConfig, 'utf8'));
    for (const [key, pack] of Object.entries(config.micPacks.packs)) {
      await checkPackZip({zip: join(out, 'packages', zipName(pack)), pack, spec: copy.micPacks.packs[key], root});
    }
    // No loose checksum file is written any more; the manifest holds each zip's SHA-256.
    assert.deepEqual((await readdir(join(out, 'packages'))).filter(name => /sha256sums/i.test(name)), []);
    const written256 = JSON.parse(await readFile(join(out, 'packages/release-manifest.json'), 'utf8'));
    for (const pack of PACKS) assert.equal(written256.packages[pack.packageId].archives[0].sha256, sha(await readFile(join(out, 'packages', zipName(pack)))));
    const manifest = JSON.parse(await readFile(join(out, 'packages/release-manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.packages).sort(), ['micpack-asian', 'micpack-european']);
    // The two packs share no path but the install note, with identical bytes, and neither shares one with the 0.2.1 packs or the Runtime's Moonshine folder.
    const [european, asian] = await Promise.all(PACKS.map(async pack => (await listZip(join(out, 'packages', zipName(pack)))).map(entry => [entry.name, entry.crc])));
    const asianPaths = new Map(asian);
    const shared = european.filter(([name]) => asianPaths.has(name));
    assert.deepEqual(shared.map(([name, crc]) => [name, asianPaths.get(name) === crc]), [[NOTE, true]]);
    const listing = validateListing(JSON.parse(await readFile(resolve(project, 'packaging/pack-listings/packs-0.2.1.json'), 'utf8')));
    const lines = [];
    assert.equal(await checkZips(PACKS.map(pack => join(out, 'packages', zipName(pack))), listing, {log: line => lines.push(line)}), true, lines.join('\n'));
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('a pack built alone carries only its own folder, and a developer folder file that differs from its pin or is missing stops the build', async () => {
  const root = await temporary();
  try {
    const source = join(root, 'dev');
    const written = await writeStandIns(source);
    const releaseConfig = join(root, 'release.config.json');
    await writeFile(releaseConfig, JSON.stringify(standInConfig(written)));
    const alone = await build({releaseConfig, out: join(root, 'one'), cache: join(root, 'cache'), packages: 'micpack-asian', source});
    assert.equal(alone.status, 0, alone.output);
    assert.deepEqual((await readdir(join(root, 'one/packages'))).filter(name => name.endsWith('.zip')), [zipName(config.micPacks.packs.asian)]);
    // Same size, other bytes.
    const european = config.micPacks.packs.european;
    const file = join(source, european.id, 'tokens.txt');
    const original = await readFile(file);
    await writeFile(file, Buffer.from(original.toString('latin1').replace(/s/, 'S'), 'latin1'));
    const changed = await build({releaseConfig, out: join(root, 'two'), cache: join(root, 'cache'), packages: 'micpack-european', source});
    assert.notEqual(changed.status, 0);
    assert.match(changed.output, /tokens\.txt differs from the pinned file/);
    assert.deepEqual(existsSync(join(root, 'two/packages')) ? (await readdir(join(root, 'two/packages'))).filter(name => name.endsWith('.zip')) : [], []);
    await writeFile(file, original);
    await rm(join(source, european.id, 'joiner.int8.onnx'));
    const missing = await build({releaseConfig, out: join(root, 'three'), cache: join(root, 'cache'), packages: 'micpack-european', source});
    assert.notEqual(missing.status, 0);
    assert.match(missing.output, /joiner\.int8\.onnx is missing/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

// ---------------------------------------------------------------- the download path, from a generated archive served by a local HTTP server
async function archiveFor(root, pack, {extra = null, drop = null} = {}) {
  const folder = pack.archive.folder;
  const src = join(root, `archive-src-${pack.id}`);
  await rm(src, {recursive: true, force: true});
  await mkdir(join(src, folder, 'test_wavs'), {recursive: true});
  const written = new Map();
  for (const [index, name] of Object.keys(pack.files).entries()) {
    const bytes = standIn(pack, name, index);
    written.set(`${pack.id}/${name}`, bytes);
    if (name !== drop) await writeFile(join(src, folder, name), bytes);
  }
  await writeFile(join(src, folder, 'test_wavs/0.wav'), 'RIFF sample');
  await writeFile(join(src, folder, 'README.md'), 'readme of the archive');
  if (extra) { await mkdir(join(src, dirname(extra)), {recursive: true}); await writeFile(join(src, extra), 'outside'); }
  const archive = join(root, `${pack.archive.folder}.tar.bz2`);
  const result = spawnSync(TAR, ['-cjf', archive, '-C', src, ...(extra ? [dirname(extra)] : []), folder], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const bytes = await readFile(archive);
  return {written, archive, size: bytes.length, sha256: sha(bytes)};
}

async function serve(files) {
  const server = http.createServer(async (request, response) => {
    const path = files.get(decodeURIComponent(request.url.slice(1)));
    if (!path) { response.writeHead(404); response.end(); return; }
    const bytes = await readFile(path);
    response.writeHead(200, {'content-length': bytes.length});
    response.end(bytes);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {server, url: name => `http://127.0.0.1:${server.address().port}/${encodeURIComponent(name)}`, close: () => new Promise(done => server.close(done))};
}

test('without a developer folder the archive is downloaded, SHA-256 checked, listed, and only the pinned files are extracted (no test_wavs, no README)', async () => {
  const root = await temporary();
  let host;
  try {
    const made = {};
    const files = new Map();
    for (const [key, pack] of Object.entries(config.micPacks.packs)) { made[key] = await archiveFor(root, pack); files.set(`${pack.archive.folder}.tar.bz2`, made[key].archive); }
    host = await serve(files);
    const written = new Map([...Object.values(made)].flatMap(item => [...item.written]));
    const archives = Object.fromEntries(Object.entries(config.micPacks.packs).map(([key, pack]) => [key,
      {url: host.url(`${pack.archive.folder}.tar.bz2`), size: made[key].size, sha256: made[key].sha256}]));
    const standIns = standInConfig(written, archives);
    const releaseConfig = join(root, 'release.config.json');
    await writeFile(releaseConfig, JSON.stringify(standIns));
    const out = join(root, 'out'), cache = join(root, 'cache');
    const result = await build({releaseConfig, out, cache, packages: 'micpack-european,micpack-asian'});
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Downloading http:\/\/127\.0\.0\.1:\d+\//);
    assert.match(result.output, /Extracting 4 files of/); assert.match(result.output, /Extracting 2 files of/);
    for (const [key, pack] of Object.entries(config.micPacks.packs)) {
      const entries = await checkPackZip({zip: join(out, 'packages', zipName(pack)), pack: {...pack, archive: standIns.micPacks.packs[key].archive}, spec: standIns.micPacks.packs[key], root});
      assert(!entries.some(entry => /test_wavs|README/.test(entry.name)));
      // The extraction folder holds only what the pack ships.
      assert.deepEqual((await readdir(join(cache, 'extract', `mic-pack-${pack.id}`, pack.archive.folder))).sort(), Object.keys(pack.files).sort());
    }
    // A second build reuses the cached archive (it is only downloaded when missing or when its hash differs).
    await host.close(); host = null;
    const again = await build({releaseConfig, out: join(root, 'again'), cache, packages: 'micpack-asian'});
    assert.equal(again.status, 0, again.output);
    assert.doesNotMatch(again.output, /Downloading/);
  } finally { if (host) await host.close(); await rm(root, {recursive: true, force: true}); }
});

test('a downloaded archive with the wrong SHA-256, a stray entry outside its folder, or a missing pinned file stops the build', async () => {
  const root = await temporary();
  let host;
  try {
    const pack = config.micPacks.packs.asian;
    const good = await archiveFor(root, pack);
    const files = new Map([[`${pack.archive.folder}.tar.bz2`, good.archive]]);
    host = await serve(files);
    const run = async (name, archive, extra = {}) => {
      const configFile = join(root, `${name}.json`);
      await writeFile(configFile, JSON.stringify(standInConfig(good.written, {asian: {url: host.url(`${pack.archive.folder}.tar.bz2`), size: archive.size, sha256: archive.sha256, ...extra}})));
      return build({releaseConfig: configFile, out: join(root, name), cache: join(root, `cache-${name}`), packages: 'micpack-asian'});
    };
    const wrong = await run('wrong-hash', good, {sha256: '0'.repeat(64)});
    assert.notEqual(wrong.status, 0); assert.match(wrong.output, /Checksum mismatch/);
    const wrongSize = await run('wrong-size', good, {size: good.size + 1});
    assert.notEqual(wrongSize.status, 0); assert.match(wrongSize.output, /is not \d+ bytes/);
    // A stray entry beside the archive's folder: refused before anything is extracted.
    const stray = await archiveFor(root, pack, {extra: 'elsewhere/payload.txt'});
    files.set(`${pack.archive.folder}.tar.bz2`, stray.archive);
    const outside = await run('outside', stray);
    assert.notEqual(outside.status, 0); assert.match(outside.output, /holds an entry outside sherpa-onnx-sense-voice[^\n]*: elsewhere/);
    assert.equal(existsSync(join(root, 'cache-outside/extract')), false, 'nothing was extracted');
    // A pinned file the archive does not have.
    const lacking = await archiveFor(root, pack, {drop: 'tokens.txt'});
    files.set(`${pack.archive.folder}.tar.bz2`, lacking.archive);
    const missing = await run('lacking', lacking);
    assert.notEqual(missing.status, 0); assert.match(missing.output, /has no sherpa-onnx-sense-voice[^\n]*\/tokens\.txt/);
  } finally { if (host) await host.close(); await rm(root, {recursive: true, force: true}); }
});

test('an archive entry that climbs out with .. is refused before anything is extracted', async t => {
  const root = await temporary();
  let host;
  try {
    const pack = config.micPacks.packs.european;
    const archive = join(root, 'evil.tar.bz2');
    // bsdtar will not write such a name, so the archive is made with Python's tarfile (skipped where Python is missing).
    const code = ['import tarfile, io, sys', 'out, folder = sys.argv[1], sys.argv[2]', "t = tarfile.open(out, 'w:bz2')",
      "for name, data in [(folder + '/tokens.txt', b'tokens'), (folder + '/../escaped.txt', b'payload')]:",
      '    info = tarfile.TarInfo(name); info.size = len(data); t.addfile(info, io.BytesIO(data))', 't.close()'].join('\n');
    const made = spawnSync('python', ['-I', '-c', code, archive, pack.archive.folder], {encoding: 'utf8'});
    if (made.status !== 0 || !existsSync(archive)) { t.skip('Python is not available to write the archive'); return; }
    assert.match(spawnSync(TAR, ['-tjf', archive], {encoding: 'utf8'}).stdout, /\.\.\/escaped\.txt/, 'the archive really holds a .. entry');
    const bytes = await readFile(archive);
    host = await serve(new Map([['evil.tar.bz2', archive]]));
    const copy = standInConfig(new Map(), {european: {url: host.url('evil.tar.bz2'), size: bytes.length, sha256: sha(bytes)}});
    copy.micPacks.packs.european.files = {'tokens.txt': {size: 6, sha256: sha(Buffer.from('tokens'))}};
    const configFile = join(root, 'evil.json');
    await writeFile(configFile, JSON.stringify(copy));
    const result = await build({releaseConfig: configFile, out: join(root, 'out'), cache: join(root, 'cache'), packages: 'micpack-european'});
    assert.notEqual(result.status, 0);
    assert.match(result.output, /holds an entry outside sherpa-onnx-nemo-parakeet[^\n]*: sherpa-onnx-nemo-parakeet[^\n]*\/\.\.\/escaped\.txt/);
    assert.equal(existsSync(join(root, 'cache/extract')), false, 'nothing was extracted');
    assert.equal(existsSync(join(root, 'cache', 'escaped.txt')), false);
  } finally { if (host) await host.close(); await rm(root, {recursive: true, force: true}); }
});

// ---------------------------------------------------------------- the real files (a developer's machine only)
const REAL = process.env.CYBERPUNK_CONVAI_MIC_PACKS_DEV;
test('the REAL model files build into both packs against the real pins (only with CYBERPUNK_CONVAI_MIC_PACKS_DEV)', {skip: !REAL || !existsSync(REAL) ? 'set CYBERPUNK_CONVAI_MIC_PACKS_DEV to a folder laid out as DIR/<pack id>/<file>' : false, timeout: 1_800_000}, async () => {
  const root = await temporary();
  try {
    const out = join(root, 'out');
    const result = await build({out, cache: join(root, 'cache'), packages: 'micpack-european,micpack-asian', source: REAL});
    assert.equal(result.status, 0, result.output);
    for (const pack of PACKS) await checkPackZip({zip: join(out, 'packages', zipName(pack)), pack, root, real: true});
  } finally { await rm(root, {recursive: true, force: true}); }
});
