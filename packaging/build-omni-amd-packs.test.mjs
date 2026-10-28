import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {buildPack, listText, planPacks} from './build-omni-amd-packs.mjs';
import {listZip} from './lib/zip.mjs';
import {AMD_PACK_MANIFEST} from '../bridge/omni-amd-layout.mjs';
import {packFor, planFor} from '../bridge/omni-amd-setup.mjs';
import WHEELS from '../bridge/omni-amd-wheels.mjs';

// packaging/build-omni-amd-packs.mjs: AMD's wheels of a card family into one zip for Hugging Face (voice/amd/). Tested with small fake wheels; nothing is downloaded.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const md5 = bytes => createHash('md5').update(bytes).digest('hex');

// Three fake files of one family on a fake AMD server (two with an MD5 ETag, one with a recorded SHA-256).
function fakeAmd() {
  const bytes = {
    'torch-2.14.0+rocm10.1.0-cp311-cp311-win_amd64.whl': Buffer.from('torch wheel '.repeat(500)),
    'rocm_sdk_core-10.1.0-py3-none-win_amd64.whl': Buffer.from('core wheel '.repeat(300)),
    'rocm-10.1.0.tar.gz': Buffer.from('rocm source '.repeat(50)),
  };
  const base = 'https://stable.repo.amd.com/rocm/';
  const files = {
    'torch-2.14.0+rocm10.1.0-cp311-cp311-win_amd64.whl': {url: `${base}torch.whl`, kind: 'wheel', project: 'torch', version: '2.14.0+rocm10.1.0', etag: md5(bytes['torch-2.14.0+rocm10.1.0-cp311-cp311-win_amd64.whl'])},
    'rocm_sdk_core-10.1.0-py3-none-win_amd64.whl': {url: `${base}core.whl`, kind: 'wheel', project: 'rocm-sdk-core', version: '10.1.0', etag: md5(bytes['rocm_sdk_core-10.1.0-py3-none-win_amd64.whl'])},
    'rocm-10.1.0.tar.gz': {url: `${base}rocm.tar.gz`, kind: 'sdist', project: 'rocm', version: '10.1.0', etag: null, sha256: sha256(bytes['rocm-10.1.0.tar.gz'])},
  };
  const served = {};
  for (const [name, file] of Object.entries(files)) { file.size = bytes[name].length; file.unpacked = bytes[name].length * 3; file.sha256 ??= null; served[file.url] = bytes[name]; }
  const manifest = {version: 1, python: 'cp311', index: base, roots: {torch: '2.14.0+rocm10.1.0'}, fromPack: [],
    targets: {gfx1201: Object.keys(files).sort(), gfx1030: ['rocm-10.1.0.tar.gz', 'torch-2.14.0+rocm10.1.0-cp311-cp311-win_amd64.whl']}, files};
  const requests = [];
  const fetchImpl = async (url, {headers = {}} = {}) => {
    requests.push(url);
    const body = served[url];
    if (!body) return new Response('missing', {status: 404});
    const from = /^bytes=(\d+)-$/.exec(headers.Range ?? '')?.[1];
    return new Response(from ? body.subarray(Number(from)) : body, {status: from ? 206 : 200});
  };
  return {manifest, bytes, fetchImpl, requests};
}

test('a pack is the family\'s files stored whole in the pinned order plus a manifest with each file\'s SHA-256; the zip is the same every time and is read back', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'amd-pack-'));
  try {
    const {manifest, bytes, fetchImpl, requests} = fakeAmd();
    const options = {manifest, target: 'gfx1201', downloads: join(folder, 'dl'), out: join(folder, 'out'), fetchImpl};
    const one = await buildPack(options);
    assert.equal(one.name, 'OmniAMD-gfx1201-PyTorch-2.14-ROCm-10.1.zip');
    assert.equal(one.path, join(folder, 'out', one.name));
    assert.deepEqual(one.files, manifest.targets.gfx1201);
    assert.equal(one.sha256, sha256(await readFile(one.path)));
    const entries = await listZip(one.path);
    assert.deepEqual(entries.map(entry => entry.name), [...manifest.targets.gfx1201, AMD_PACK_MANIFEST]);
    assert.ok(entries.every(entry => entry.method === 0), 'stored, not compressed again');
    // The download folder keeps AMD's file as it is.
    assert.deepEqual(await readFile(join(folder, 'dl', 'rocm-10.1.0.tar.gz')), bytes['rocm-10.1.0.tar.gz']);
    // The same files give the same zip, and a second family reuses the downloads it already has.
    const asked = requests.length;
    const two = await buildPack(options);
    assert.equal(two.sha256, one.sha256); assert.equal(two.size, one.size); assert.equal(requests.length, asked, 'nothing downloaded twice');
    const other = await buildPack({...options, target: 'gfx1030'});
    assert.equal(other.name, 'OmniAMD-gfx1030-PyTorch-2.14-ROCm-10.1.zip');
    assert.equal(requests.length, asked, 'torch and rocm were in the downloads already');
    // The game accepts what the builder reports: the list text, imported, gives a pack for the family with the pinned files.
    const text = listText({gfx1201: {name: one.name, size: one.size, sha256: one.sha256, files: one.files, built: '2026-10-28'}});
    assert.match(text, /^\/\/ Written by packaging\/build-omni-amd-packs\.mjs/);
    const module = join(folder, 'list.mjs');
    await writeFile(module, text);
    const list = (await import(pathToFileURL(module).href)).default;
    assert.equal(list.version, 1);
    assert.deepEqual(packFor(manifest, list, 'gfx1201', manifest.targets.gfx1201)?.sha256, one.sha256);
    assert.equal(planFor(manifest, 'gfx1201', list).downloadBytes, one.size);
    assert.equal(planFor(manifest, 'gfx1030', list).pack, null, 'a family without an entry is downloaded from AMD');
  } finally { await rm(folder, {recursive: true, force: true}); }
});

test('the zip of a pack unpacks with Windows\' tar to the files and the manifest, byte for byte', {skip: process.platform !== 'win32'}, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'amd-pack-'));
  try {
    const {manifest, bytes, fetchImpl} = fakeAmd();
    const pack = await buildPack({manifest, target: 'gfx1201', downloads: join(folder, 'dl'), out: join(folder, 'out'), fetchImpl});
    const destination = join(folder, 'unpacked');
    await mkdir(destination);
    const tar = spawnSync(resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', pack.path, '-C', destination], {windowsHide: true});
    assert.equal(tar.status, 0);
    for (const [name, data] of Object.entries(bytes)) assert.deepEqual(await readFile(join(destination, name)), data, name);
    const record = JSON.parse(await readFile(join(destination, AMD_PACK_MANIFEST), 'utf8'));
    assert.equal(record.target, 'gfx1201'); assert.equal(record.torch, '2.14.0+rocm10.1.0'); assert.equal(record.name, pack.name);
    assert.deepEqual(record.files.map(file => file.name), manifest.targets.gfx1201);
    for (const file of record.files) assert.equal(file.sha256, sha256(bytes[file.name]), file.name);
  } finally { await rm(folder, {recursive: true, force: true}); }
});

test('a file that does not check out, or is missing at AMD, builds no pack and leaves no half-made zip', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'amd-pack-'));
  try {
    const {manifest, fetchImpl} = fakeAmd();
    const bad = structuredClone(manifest);
    bad.files['rocm-10.1.0.tar.gz'].sha256 = '0'.repeat(64);
    await assert.rejects(buildPack({manifest: bad, target: 'gfx1201', downloads: join(folder, 'dl'), out: join(folder, 'out'), fetchImpl}), error => error.code === 'checksum');
    const gone = structuredClone(manifest);
    gone.files['rocm_sdk_core-10.1.0-py3-none-win_amd64.whl'].url = 'https://stable.repo.amd.com/rocm/gone.whl';
    await assert.rejects(buildPack({manifest: gone, target: 'gfx1201', downloads: join(folder, 'dl'), out: join(folder, 'out'), fetchImpl}), error => error.code === 'download-failed');
    assert.equal(existsSync(join(folder, 'out', 'OmniAMD-gfx1201-PyTorch-2.14-ROCm-10.1.zip')), false);
    assert.equal(existsSync(join(folder, 'out', 'OmniAMD-gfx1201-PyTorch-2.14-ROCm-10.1.zip.tmp')), false);
    await assert.rejects(buildPack({manifest, target: 'gfx9999', downloads: join(folder, 'dl'), out: join(folder, 'out'), fetchImpl}), /not in the pinned list/);
  } finally { await rm(folder, {recursive: true, force: true}); }
});

test('the plan for the real pinned list: one pack per family, named by family and versions, each holding the family\'s files; --plan downloads nothing', () => {
  const planned = planPacks(WHEELS);
  assert.deepEqual(planned.map(pack => pack.target), Object.keys(WHEELS.targets));
  for (const pack of planned) {
    assert.match(pack.name, /^OmniAMD-gfx[0-9a-f]+-PyTorch-2\.14-ROCm-10\.1\.zip$/);
    assert.ok(pack.name.includes(pack.target)); assert.deepEqual(pack.files, WHEELS.targets[pack.target]);
    assert.ok(pack.bytes > 900 * 2 ** 20 && pack.bytes < 2 * 2 ** 30, `${pack.name}: ${pack.bytes}`);
  }
  assert.equal(new Set(planned.map(pack => pack.name)).size, planned.length);
  const run = spawnSync(process.execPath, [join(project, 'packaging', 'build-omni-amd-packs.mjs'), '--plan', '--target', 'gfx1201,gfx1030'], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split(/\r?\n/);
  assert.match(lines[0], /^OmniAMD-gfx1201-PyTorch-2\.14-ROCm-10\.1\.zip\t11 files\t1480 MiB$/);
  assert.match(lines[1], /^OmniAMD-gfx1030-PyTorch-2\.14-ROCm-10\.1\.zip\t10 files\t1062 MiB$/);
  assert.notEqual(spawnSync(process.execPath, [join(project, 'packaging', 'build-omni-amd-packs.mjs'), '--target', 'gfx9999'], {encoding: 'utf8'}).status, 0);
});
