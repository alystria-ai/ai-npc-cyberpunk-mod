import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createZip} from './zip-writer.mjs';
import {CARD_DELAY_MS, OmniAmdSetup, amdArch, amdCard, checksumOk, downloadFile, loadManifest, packFor, parseAmdCommand, planFor, spaceNeeded, tarExtract, unpackInto} from './omni-amd-setup.mjs';
import {amdPackName, amdPackUrl, amdPaths, prepareInterpreter, pthText, readAmdSetup, syncAmdPython} from './omni-amd-layout.mjs';
import PACKS from './omni-amd-packs.mjs';
import {buildPack} from '../packaging/build-omni-amd-packs.mjs';
import {readOwnPythonSetting, resolveOwnPython} from './omni-own-python.mjs';

// Settings > Voices > OmniVoice for AMD, the service side (docs/OMNIVOICE_AMD.md): the pinned AMD files, the card families, the checks of a download, the
// layout of the AMD Python, and the whole job (download, unpack, test, remove) against a fake AMD server, a fake pack and a fake test. Nothing is downloaded.

const md5 = bytes => createHash('md5').update(bytes).digest('hex');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const temporary = () => mkdtemp(join(tmpdir(), 'omni-amd-'));
const RX9070 = {name: 'AMD Radeon RX 9070 XT', memoryMiB: 16304};

test('card names map to AMD chip families; only a discrete AMD card without an NVIDIA one is set up', () => {
  const cases = {
    'AMD Radeon RX 9070 XT': 'gfx1201', 'AMD Radeon RX 9070': 'gfx1201', 'AMD Radeon AI PRO R9700': 'gfx1201', 'AMD Radeon RX 9060 XT': 'gfx1200',
    'AMD Radeon RX 7900 XTX': 'gfx1100', 'AMD Radeon RX 7900 GRE': 'gfx1100', 'AMD Radeon RX 7900M': 'gfx1100', 'AMD Radeon PRO W7800': 'gfx1100',
    'AMD Radeon RX 7800 XT': 'gfx1101', 'AMD Radeon RX 7700 XT': 'gfx1101', 'AMD Radeon RX 7600M XT': 'gfx1102', 'AMD Radeon RX 7650 GRE': 'gfx1102',
    'AMD Radeon RX 6800 XT': 'gfx1030', 'AMD Radeon RX 6950 XT': 'gfx1030', 'AMD Radeon RX 6700 XT': 'gfx1031',
    'AMD Radeon RX 6600': null, 'AMD Radeon RX 5700 XT': null, 'AMD Radeon(TM) Graphics': null, 'AMD Radeon RX 90700': null, '': null};
  for (const [name, arch] of Object.entries(cases)) assert.equal(amdArch(name), arch, name);
  assert.deepEqual(amdCard([RX9070]), {name: 'AMD Radeon RX 9070 XT', arch: 'gfx1201', memoryMiB: 16304});
  assert.deepEqual(amdCard([{name: 'AMD Radeon(TM) Graphics', memoryMiB: 512}, RX9070])?.arch, 'gfx1201', 'the integrated one is skipped');
  assert.equal(amdCard([RX9070, {name: 'NVIDIA GeForce RTX 4070', memoryMiB: 12282}]), null, 'NVIDIA beside it: the NVIDIA route');
  assert.equal(amdCard([{name: 'AMD Radeon(TM) Graphics', memoryMiB: 512}]), null);
  assert.equal(amdCard([]), null); assert.equal(amdCard(null), null);
  assert.equal(amdCard([{name: 'AMD Radeon RX 5700 XT', memoryMiB: 8176}]).arch, null, 'a discrete card of a family AMD does not build for: offered, then "not supported"');
});

test('the pinned AMD files: every family has the full set from AMD\'s own index, nothing the pack already has, and the sizes the page shows', () => {
  const manifest = loadManifest();
  assert.equal(manifest.version, 1); assert.equal(manifest.python, 'cp311', 'the OmniVoice pack\'s Python is 3.11');
  for (const [target, names] of Object.entries(manifest.targets)) {
    const plan = planFor(manifest, target);
    assert.ok(plan, target);
    const projects = plan.files.map(file => file.project);
    for (const wanted of ['torch', 'torchaudio', 'torchvision', 'rocm', 'rocm-sdk-core', 'rocm-sdk-libraries', `rocm-sdk-device-${target}`, `amd-torch-device-${target}`])
      assert.ok(projects.includes(wanted), `${target}: ${wanted}`);
    for (const file of plan.files) {
      assert.match(file.url, /^https:\/\/stable\.repo\.amd\.com\/rocm\//, file.name);
      assert.ok(Number.isSafeInteger(file.size) && file.size > 0 && Number.isSafeInteger(file.unpacked) && file.unpacked > 0, file.name);
      assert.ok(file.sha256 || /^[0-9a-f]{32}(-\d+)?$/.test(file.etag), `${file.name} has a checksum or an ETag`);
      assert.ok(!manifest.fromPack.includes(file.project), `${file.name} is already in the pack`);
      if (file.kind === 'wheel') assert.match(file.name, /-(cp311-cp311|py3-none)-(win_amd64|any)\.whl$/);
    }
    assert.ok(names.includes(plan.files[0].name));
  }
  const rx9070 = planFor(manifest, 'gfx1201');
  assert.equal(Math.round(rx9070.downloadBytes / 2 ** 20), 1480);
  assert.ok(rx9070.unpackedBytes > 3.5 * 2 ** 30 && rx9070.unpackedBytes < 5 * 2 ** 30);
  assert.equal(planFor(manifest, 'gfx9999'), null); assert.equal(planFor(null, 'gfx1201'), null); assert.equal(planFor(manifest, null), null);
});

test('a download is checked by its SHA-256 when known, else by the MD5 in AMD\'s ETag (one part: the MD5; one part of a multipart upload: the MD5 of the MD5)', () => {
  const bytes = Buffer.from('rocm');
  const hex = md5(bytes), sha = sha256(bytes);
  assert.equal(checksumOk({sha256: sha}, {md5: hex, sha256: sha}), true);
  assert.equal(checksumOk({sha256: sha, etag: 'bad'}, {md5: hex, sha256: '0'.repeat(64)}), false, 'the SHA-256 wins');
  assert.equal(checksumOk({etag: hex}, {md5: hex, sha256: sha}), true);
  assert.equal(checksumOk({etag: hex.toUpperCase()}, {md5: hex, sha256: sha}), true);
  assert.equal(checksumOk({etag: 'f'.repeat(32)}, {md5: hex, sha256: sha}), false);
  const ofMd5 = createHash('md5').update(Buffer.from(hex, 'hex')).digest('hex');
  assert.equal(checksumOk({etag: `${ofMd5}-1`}, {md5: hex, sha256: sha}), true);
  assert.equal(checksumOk({etag: `${'0'.repeat(32)}-1`}, {md5: hex, sha256: sha}), false);
  assert.equal(checksumOk({etag: `${'0'.repeat(32)}-6`}, {md5: hex, sha256: sha}), true, 'several parts: the size alone');
});

test('commands: three actions, a fresh id, nothing from the future, nothing oversized', () => {
  const now = 1_000_000;
  for (const action of ['install', 'cancel', 'remove']) assert.deepEqual(parseAmdCommand(JSON.stringify({version: 1, id: 's:amd:1', action, issuedAt: now}), now), {id: 's:amd:1', action});
  assert.deepEqual(parseAmdCommand('\uFEFF' + JSON.stringify({version: 1, id: 's:amd:1', action: 'install', issuedAt: now}), now)?.action, 'install');
  for (const bad of ['', 'x', '[]', 'null', JSON.stringify({version: 2, id: 'a', action: 'install', issuedAt: now}), JSON.stringify({version: 1, id: ' a', action: 'install', issuedAt: now}),
    JSON.stringify({version: 1, id: 'a', action: 'format', issuedAt: now}), JSON.stringify({version: 1, id: 'a', action: 'install', issuedAt: now + 60_000}),
    JSON.stringify({version: 1, id: 'a', action: 'install', issuedAt: now, pad: 'x'.repeat(5000)})]) assert.equal(parseAmdCommand(bad, now), null, bad.slice(0, 60));
});

// A fake AMD server: serves `files` ({url: bytes}), honours Range, counts requests; `hold` makes a body wait for the abort.
function fakeServer(files, {status = {}, hold = false} = {}) {
  const requests = [];
  const fetchImpl = async (url, {headers = {}, signal} = {}) => {
    requests.push({url, range: headers.Range ?? null});
    if (status[url]) return new Response('no', {status: status[url]});
    const bytes = files[url];
    if (!bytes) return new Response('missing', {status: 404});
    const from = /^bytes=(\d+)-$/.exec(headers.Range ?? '')?.[1];
    const body = from ? bytes.subarray(Number(from)) : bytes;
    if (hold) {
      const stream = new ReadableStream({start(controller) {
        controller.enqueue(body.subarray(0, 4));
        signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), {once: true});
      }});
      return new Response(stream, {status: from ? 206 : 200});
    }
    return new Response(body, {status: from ? 206 : 200});
  };
  return {fetchImpl, requests};
}

test('downloadFile: whole, resumed from a part, a finished file reused, a bad checksum removed, a server error and a cancel', async () => {
  const folder = await temporary();
  try {
    const bytes = Buffer.from('a wheel of ROCm bytes'.repeat(100));
    const file = {url: 'https://stable.repo.amd.com/rocm/a.whl', size: bytes.length, etag: md5(bytes)};
    const {fetchImpl, requests} = fakeServer({[file.url]: bytes});
    let counted = 0;
    const path = join(folder, 'a.whl');
    await downloadFile(file, path, {fetchImpl, onBytes: n => { counted += n; }});
    assert.deepEqual(await readFile(path), bytes); assert.equal(counted, bytes.length);
    // Already there and right: no request.
    counted = 0;
    await downloadFile(file, path, {fetchImpl, onBytes: n => { counted += n; }});
    assert.equal(requests.length, 1); assert.equal(counted, bytes.length);
    // A part left by a lost connection is resumed with a Range request.
    await rm(path); await writeFile(`${path}.part`, bytes.subarray(0, 700));
    counted = 0;
    await downloadFile(file, path, {fetchImpl, onBytes: n => { counted += n; }});
    assert.equal(requests.at(-1).range, 'bytes=700-'); assert.deepEqual(await readFile(path), bytes); assert.equal(counted, bytes.length);
    assert.equal(existsSync(`${path}.part`), false);
    // Wrong bytes: refused and removed.
    await rm(path);
    await assert.rejects(downloadFile({...file, etag: 'f'.repeat(32)}, path, {fetchImpl}), error => error.code === 'checksum');
    assert.equal(existsSync(path), false);
    await assert.rejects(downloadFile(file, path, {fetchImpl: fakeServer({}, {status: {[file.url]: 500}}).fetchImpl}), error => error.code === 'download-failed');
    await assert.rejects(downloadFile(file, path, {fetchImpl: async () => { throw Error('offline'); }}), error => error.code === 'download-failed');
    const short = fakeServer({[file.url]: bytes.subarray(0, 10)});
    await assert.rejects(downloadFile(file, path, {fetchImpl: short.fetchImpl}), error => error.code === 'download-failed', 'a short body');
    // A cancel mid-download keeps the part for the next try.
    const held = fakeServer({[file.url]: bytes}, {hold: true});
    const abort = new AbortController();
    const running = downloadFile(file, path, {fetchImpl: held.fetchImpl, signal: abort.signal});
    setTimeout(() => abort.abort(), 30);
    await assert.rejects(running, error => error.code === 'cancelled');
  } finally { await rm(folder, {recursive: true, force: true}); }
});

test('the AMD Python\'s path file: its own sp/ before the pack\'s site-packages, the pack\'s other entries as absolute paths', () => {
  const pack = resolve('C:/Game/red4ext/plugins/AiNpcCyberpunkMod/app/omni/python');
  const text = pthText('python311.zip\r\n.\r\nLib\\site-packages\r\n..\\..\\bridge\r\nimport site\r\n', pack);
  assert.deepEqual(text.split('\r\n'), ['python311.zip', '.', 'sp', resolve(pack, 'Lib\\site-packages'), resolve(pack, '..\\..\\bridge'), 'import site', '']);
  assert.deepEqual(pthText('python311.zip\n.\nimport site\n', pack).split('\r\n').slice(0, 4), ['python311.zip', '.', 'sp', 'import site']);
  assert.ok(pthText('', pack).startsWith('sp'));
});

async function fakePack(root) {
  const home = join(root, 'game', 'app', 'omni', 'python');
  await mkdir(join(home, 'Lib', 'site-packages', 'omnivoice'), {recursive: true});
  await writeFile(join(home, 'python.exe'), 'exe'); await writeFile(join(home, 'python311.dll'), 'dll'); await writeFile(join(home, 'python311.zip'), 'zip');
  await writeFile(join(home, '_ctypes.pyd'), 'pyd');
  await writeFile(join(home, 'python311._pth'), 'python311.zip\r\n.\r\nLib\\site-packages\r\n..\\..\\bridge\r\nimport site\r\n');
  await writeFile(join(home, 'Lib', 'site-packages', 'omnivoice', '__init__.py'), '');
  return join(home, 'python.exe');
}

test('prepareInterpreter copies the pack\'s interpreter files (not its libraries) once and writes the path file; syncAmdPython follows a moved pack', async () => {
  const folder = await temporary();
  try {
    const runtimePython = await fakePack(folder);
    const home = join(folder, 'state', 'amd', 'py');
    assert.deepEqual(await prepareInterpreter({home, runtimePython}), {copied: 4, wrote: true});
    assert.deepEqual((await readdir(home)).sort(), ['_ctypes.pyd', 'python.exe', 'python311._pth', 'python311.dll', 'python311.zip']);
    assert.match(await readFile(join(home, 'python311._pth'), 'utf8'), /^python311\.zip\r\n\.\r\nsp\r\n/);
    assert.deepEqual(await prepareInterpreter({home, runtimePython}), {copied: 0, wrote: false}, 'nothing to do the second time');
    await writeFile(join(dirname(runtimePython), 'python311.dll'), 'a newer dll');
    assert.deepEqual(await prepareInterpreter({home, runtimePython}), {copied: 1, wrote: false});
    // syncAmdPython does nothing without a setup, and follows the pack once there is one.
    const stateDirectory = join(folder, 'state');
    assert.deepEqual(await syncAmdPython({stateDirectory, runtimePython}), {copied: 0, wrote: false});
    await writeFile(amdPaths(stateDirectory).setup, JSON.stringify({version: 1, target: 'gfx1201'}));
    const moved = await fakePack(join(folder, 'moved'));
    assert.equal((await syncAmdPython({stateDirectory, runtimePython: moved})).wrote, true);
    assert.ok((await readFile(join(home, 'python311._pth'), 'utf8')).includes(resolve(dirname(moved), 'Lib\\site-packages')));
    await assert.rejects(prepareInterpreter({home, runtimePython: null}));
  } finally { await rm(folder, {recursive: true, force: true}); }
});
const dirname = path => resolve(path, '..');

test('omni-python.txt wins over the AMD setup; without the file the AMD setup\'s Python is tested like an own Python (managed), after its path file is synced', async () => {
  const folder = await temporary();
  try {
    const stateDirectory = join(folder, 'state');
    await mkdir(stateDirectory, {recursive: true});
    assert.deepEqual(await readOwnPythonSetting({stateDirectory}), {configured: false});
    const paths = amdPaths(stateDirectory);
    await mkdir(paths.home, {recursive: true});
    await writeFile(paths.setup + '.tmp', '{}');
    assert.deepEqual(await readOwnPythonSetting({stateDirectory}), {configured: false}, 'a half-made setup is not taken');
    await writeFile(paths.setup, JSON.stringify({version: 1, target: 'gfx1201'}));
    assert.deepEqual(await readOwnPythonSetting({stateDirectory}), {configured: true, managed: true, path: paths.python, problem: null});
    assert.deepEqual(await readAmdSetup({stateDirectory}), {version: 1, target: 'gfx1201'});
    const own = join(folder, 'own', 'python.exe');
    await mkdir(dirname(own), {recursive: true}); await writeFile(own, '');
    await writeFile(join(stateDirectory, 'omni-python.txt'), own);
    const mine = await readOwnPythonSetting({stateDirectory});
    assert.equal(mine.managed, undefined); assert.equal(mine.path, own);
    await rm(join(stateDirectory, 'omni-python.txt'));
    // The whole decision: synced first, then the same self-test, with `managed` carried through.
    const synced = [];
    const ROCM = {python: '3.11.9', torch: '2.14.0+rocm10.1.0', hip: '10.1.0', available: true, device: 'AMD Radeon RX 9070 XT', vramMiB: 16304, op: true, omnivoice: true};
    const result = await resolveOwnPython({stateDirectory, runtimePython: 'C:/pack/app/omni/python/python.exe', exists: async () => true,
      prepareManaged: async options => { synced.push(options.runtimePython); }, selfTest: async ({python}) => { assert.equal(python, paths.python); return ROCM; }});
    assert.deepEqual(synced, ['C:/pack/app/omni/python/python.exe']);
    assert.equal(result.used, true); assert.equal(result.managed, true); assert.equal(result.backend, 'rocm');
    const broken = await resolveOwnPython({stateDirectory, runtimePython: 'C:/pack/app/omni/python/python.exe', exists: async () => true,
      prepareManaged: async () => { throw Error('pack gone'); }, selfTest: async () => ROCM});
    assert.equal(broken.used, false); assert.equal(broken.reason, 'start-failed'); assert.equal(broken.managed, true);
  } finally { await rm(folder, {recursive: true, force: true}); }
});

const tarExe = process.platform === 'win32' ? resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const haveTar = spawnSync(tarExe, ['--version'], {windowsHide: true}).status === 0;

// A small wheel and the rocm source package, as AMD ships them (the wheel with a .data/platlib folder to merge).
async function fakeAmdFiles(folder) {
  const wheel = createZip([{name: 'torch/__init__.py', data: Buffer.from('# amd torch\n')}, {name: 'torch-2.14.0.dist-info/METADATA', data: Buffer.from('Name: torch\n')},
    {name: 'torch-2.14.0.data/platlib/_rocm_extra/lib.dll', data: Buffer.from('dll')}]);
  const sdistRoot = join(folder, 'sdist-src');
  await mkdir(join(sdistRoot, 'rocm-10.1.0', 'src', 'rocm_sdk'), {recursive: true});
  await mkdir(join(sdistRoot, 'rocm-10.1.0', 'src', 'rocm.egg-info'), {recursive: true});
  await writeFile(join(sdistRoot, 'rocm-10.1.0', 'PKG-INFO'), 'Metadata-Version: 2.4\nName: rocm\nVersion: 10.1.0\n');
  await writeFile(join(sdistRoot, 'rocm-10.1.0', 'src', 'rocm_sdk', '__init__.py'), '# rocm_sdk\n');
  await writeFile(join(sdistRoot, 'rocm-10.1.0', 'src', 'rocm.egg-info', 'PKG-INFO'), 'x');
  const sdistPath = join(folder, 'rocm-10.1.0.tar.gz');
  if (haveTar) spawnSync(tarExe, ['-czf', sdistPath, '-C', sdistRoot, 'rocm-10.1.0'], {windowsHide: true});
  const sdist = haveTar ? await readFile(sdistPath) : Buffer.alloc(0);
  const base = 'https://stable.repo.amd.com/rocm/';
  const manifest = {version: 1, roots: {torch: '2.14.0+rocm10.1.0'}, fromPack: [], targets: {gfx1201: ['torch-2.14.0+rocm10.1.0-cp311-cp311-win_amd64.whl', 'rocm-10.1.0.tar.gz']},
    files: {
      'torch-2.14.0+rocm10.1.0-cp311-cp311-win_amd64.whl': {url: `${base}torch.whl`, kind: 'wheel', project: 'torch', version: '2.14.0+rocm10.1.0', size: wheel.length, unpacked: 4 * 2 ** 20, etag: md5(wheel), sha256: null},
      'rocm-10.1.0.tar.gz': {url: `${base}rocm.tar.gz`, kind: 'sdist', project: 'rocm', version: '10.1.0', size: sdist.length || 1, unpacked: 1000, etag: null, sha256: sha256(sdist)}}};
  return {manifest, served: {[`${base}torch.whl`]: wheel, [`${base}rocm.tar.gz`]: sdist}};
}

test('unpackInto with Windows\' tar: a wheel whole (its .data/platlib merged), the rocm source package as rocm_sdk with a .dist-info', {skip: !haveTar}, async () => {
  const folder = await temporary();
  try {
    const {manifest, served} = await fakeAmdFiles(folder);
    const downloads = join(folder, 'downloads');
    await mkdir(downloads, {recursive: true});
    const plan = planFor(manifest, 'gfx1201');
    for (const file of plan.files) await writeFile(join(downloads, file.name), served[file.url]);
    const site = join(folder, 'st', 'sp');
    await unpackInto(site, plan, downloads, {extract: tarExtract});
    assert.deepEqual((await readdir(site)).sort(), ['_rocm_extra', 'rocm-10.1.0.dist-info', 'rocm_sdk', 'torch', 'torch-2.14.0.dist-info']);
    assert.equal(await readFile(join(site, 'torch', '__init__.py'), 'utf8'), '# amd torch\n');
    assert.equal(await readFile(join(site, '_rocm_extra', 'lib.dll'), 'utf8'), 'dll');
    assert.match(await readFile(join(site, 'rocm-10.1.0.dist-info', 'METADATA'), 'utf8'), /Name: rocm/);
    assert.equal(existsSync(join(folder, 'st', 'sdist')), false, 'the source package\'s folder is cleaned up');
    await assert.rejects(tarExtract({archive: join(folder, 'missing.whl'), destination: site}), error => error.code === 'unpack-failed');
  } finally { await rm(folder, {recursive: true, force: true}); }
});

// Our pack of gfx1201 as the builder makes it from the fake AMD files: {packs (the list), bytes, url}.
async function hostedPack(folder, manifest, served) {
  const built = await buildPack({manifest, target: 'gfx1201', downloads: join(folder, 'builder'), out: join(folder, 'packs'), fetchImpl: fakeServer(served).fetchImpl});
  return {packs: {version: 1, packs: {gfx1201: {name: built.name, size: built.size, sha256: built.sha256, files: built.files}}}, bytes: await readFile(built.path), url: amdPackUrl(built.name)};
}

// The whole job against fakes. `recheck` plays the Python test the bridge runs (resolveOwnPython): it reads what is on disk.
async function fixture({cards = [RX9070], free = () => 50 * 2 ** 30, test = 'rocm', pack = true, server, hold = false, hosted = false} = {}) {
  const folder = await temporary();
  const stateDirectory = join(folder, 'state');
  await mkdir(join(stateDirectory), {recursive: true});
  const runtimePython = await fakePack(folder);
  const {manifest, served} = await fakeAmdFiles(folder);
  // hosted: our pack of the family on Hugging Face, built by the real pack builder from the fake AMD files ('missing': listed but not there; 'corrupt': other bytes).
  let packs;
  const everything = {...served};
  if (hosted) {
    const mine = await hostedPack(folder, manifest, served);
    packs = mine.packs;
    if (hosted !== 'missing') everything[mine.url] = hosted === 'corrupt' ? Buffer.concat([mine.bytes.subarray(0, 100), Buffer.from([mine.bytes[100] ^ 0xff]), mine.bytes.subarray(101)]) : mine.bytes;
  }
  const fake = fakeServer(server ?? everything, {hold});
  const published = [], logs = [];
  let clock = 1_000_000, own = null, released = 0, extracted = [];
  const commandPath = join(folder, 'omni-amd-command.json');
  await writeFile(commandPath, '');
  const setup = new OmniAmdSetup({stateDirectory, commandPath, manifest, packs, publish: value => { published.push(structuredClone(value)); },
    runtimePython: () => pack ? runtimePython : null, packInstalled: () => pack, cards: async () => cards, ownPython: () => own, ownFile: async () => false,
    recheck: async () => {
      const installed = await readAmdSetup({stateDirectory});
      own = !installed ? {configured: false} : test === 'rocm'
        ? {configured: true, managed: true, used: true, backend: 'rocm', device: 'AMD Radeon RX 9070 XT', vramMiB: 16304, path: amdPaths(stateDirectory).python}
        : {configured: true, managed: true, used: false, backend: 'none', reason: 'no-gpu'};
      return own;
    },
    release: async () => { released++; }, fetchImpl: fake.fetchImpl, free: async () => free(),
    extract: haveTar ? tarExtract : async ({archive, destination}) => { extracted.push(archive); await writeFile(join(destination, 'unpacked.txt'), archive); },
    now: () => clock, log: line => logs.push(line)});
  await setup.open();
  const send = async (action, id = `s:amd:${published.length}`) => {
    await writeFile(commandPath, JSON.stringify({version: 1, id, action, issuedAt: clock}));
    await setup.poll();
    return id;
  };
  const finished = async () => { await setup.running; return published.at(-1); };
  return {folder, stateDirectory, setup, published, logs, fake, send, finished, released: () => released, advance: ms => { clock += ms; }, own: () => own,
    close: () => rm(folder, {recursive: true, force: true})};
}

test('the card list is read once, a while after start-up, and only with the OmniVoice pack; then the page is offered with the download and disk sizes', async () => {
  const h = await fixture();
  try {
    assert.equal(h.published.at(-1).offered, false, 'nothing known at start');
    await h.setup.poll();
    assert.equal(h.published.at(-1).offered, false, 'not before the delay');
    h.advance(CARD_DELAY_MS);
    await h.setup.poll();
    const status = h.published.at(-1);
    assert.equal(status.offered, true); assert.equal(status.card, 'AMD Radeon RX 9070 XT'); assert.equal(status.arch, 'gfx1201');
    assert.equal(status.installed, false); assert.equal(status.ownPython, false); assert.ok(Number.isInteger(status.downloadMiB) && status.diskMiB === 4);
    const count = h.published.length;
    await h.setup.poll(); await h.setup.poll();
    assert.equal(h.published.length, count, 'no second card read');
  } finally { await h.close(); }
  const none = await fixture({pack: false});
  try { none.advance(CARD_DELAY_MS); await none.setup.poll(); assert.equal(none.published.at(-1).offered, false); } finally { await none.close(); }
});

test('install: checking, downloading with progress, unpacking, testing, done; the AMD Python is on disk, the downloads are gone; remove takes it all off', async () => {
  const h = await fixture();
  try {
    const id = await h.send('install');
    const status = await h.finished();
    const states = h.published.filter(value => value.job?.id === id).map(value => value.job.state);
    assert.deepEqual([...new Set(states)], ['checking', 'downloading', 'unpacking', 'testing', 'done'], states.join(','));
    assert.ok(h.published.some(value => value.job?.state === 'downloading' && value.job.totalMiB >= 0 && value.job.doneMiB === 0));
    assert.equal(status.installed, true); assert.deepEqual(status.test, {state: 'used', backend: 'rocm', device: 'AMD Radeon RX 9070 XT', vramMiB: 16304});
    const paths = amdPaths(h.stateDirectory);
    assert.equal(existsSync(paths.python), true); assert.equal(existsSync(paths.downloads), false); assert.equal(existsSync(paths.staging), false);
    assert.equal((await readAmdSetup({stateDirectory: h.stateDirectory})).target, 'gfx1201');
    assert.match(await readFile(join(paths.home, 'python311._pth'), 'utf8'), /\r\nsp\r\n/);
    if (haveTar) assert.equal(existsSync(join(paths.site, 'torch', '__init__.py')), true);
    assert.equal(h.released(), 1, 'the AMD Python is let go before it is replaced');
    // Reinstall downloads again (the downloads were deleted) and lets go again.
    const before = h.fake.requests.length;
    await h.send('install', 's:amd:again'); await h.finished();
    assert.ok(h.fake.requests.length > before); assert.equal(h.released(), 2);
    const removeId = await h.send('remove');
    const removed = await h.finished();
    assert.deepEqual(removed.job, {id: removeId, action: 'remove', state: 'removed'});
    assert.equal(removed.installed, false); assert.equal(existsSync(paths.root), false); assert.deepEqual(h.own(), {configured: false});
    assert.ok(h.logs.some(line => line.startsWith('ready: AMD Radeon RX 9070 XT')), h.logs.join('\n'));
  } finally { await h.close(); }
});

test('every failure has its code: no pack, no AMD card, a family AMD does not build for, no space, a failed download, a wrong checksum, a failed test', async () => {
  const cases = [
    [{pack: false}, 'no-pack'],
    [{cards: [RX9070, {name: 'NVIDIA GeForce RTX 4070', memoryMiB: 12282}]}, 'not-amd'],
    [{cards: [{name: 'AMD Radeon RX 5700 XT', memoryMiB: 8176}]}, 'unsupported-card'],
    [{free: () => 1000}, 'no-space'],
    [{server: {}}, 'download-failed'],
    [{test: 'refused'}, 'test-failed'],
  ];
  for (const [options, code] of cases) {
    const h = await fixture(options);
    try {
      const id = await h.send('install');
      const status = await h.finished();
      assert.deepEqual(status.job, {id, action: 'install', state: 'failed', code}, code);
      assert.equal(existsSync(amdPaths(h.stateDirectory).staging), false, code);
      if (code === 'test-failed') { assert.equal(status.installed, true); assert.equal(status.test.state, 'refused'); }
      else assert.equal(status.installed, false, code);
    } finally { await h.close(); }
  }
  // A wrong checksum: the file is removed, the job says so.
  const bad = await fixture();
  try {
    const manifest = bad.setup.manifest;
    manifest.files['torch-2.14.0+rocm10.1.0-cp311-cp311-win_amd64.whl'].etag = 'f'.repeat(32);
    await bad.send('install');
    assert.equal((await bad.finished()).job.code, 'checksum');
  } finally { await bad.close(); }
  // No manifest in this build: "not ready yet".
  const empty = await fixture();
  try { empty.setup.manifest = null; await empty.send('install'); assert.equal((await empty.finished()).job.code, 'not-ready'); } finally { await empty.close(); }
});

test('cancel stops the download and answers to the cancel command; a second install while one runs is not started; the part is kept for the next try', async () => {
  const h = await fixture({hold: true});
  try {
    const id = await h.send('install');
    for (let i = 0; i < 50 && !h.published.some(value => value.job?.state === 'downloading'); i++) await new Promise(done => setTimeout(done, 10));
    await new Promise(done => setTimeout(done, 30));
    const running = h.setup.running;
    await h.send('install', 's:amd:second');
    assert.equal(h.setup.running, running, 'the running job goes on');
    const cancelId = await h.send('cancel', 's:amd:cancel');
    const status = await h.finished();
    assert.deepEqual(status.job, {id: cancelId, action: 'install', state: 'cancelled'});
    assert.notEqual(id, cancelId);
    const parts = await readdir(amdPaths(h.stateDirectory).downloads);
    assert.ok(parts.some(name => name.endsWith('.part')), parts.join(','));
    // A cancel with nothing running still answers.
    const idle = await h.send('cancel', 's:amd:idle');
    assert.deepEqual(h.published.at(-1).job, {id: idle, action: 'install', state: 'cancelled'});
  } finally { await h.close(); }
});

test('the status names the test of the AMD Python and the player\'s own file; a command from before this session is ignored', async () => {
  const folder = await temporary();
  try {
    const commandPath = join(folder, 'command.json');
    await writeFile(commandPath, JSON.stringify({version: 1, id: 'old:amd:1', action: 'install', issuedAt: Date.now()}));
    const published = [];
    let own = {configured: true, managed: true, used: false, pending: true};
    const setup = await new OmniAmdSetup({stateDirectory: folder, commandPath, manifest: loadManifest(), publish: value => published.push(value), ownPython: () => own,
      ownFile: async () => true, cards: async () => [RX9070], packInstalled: () => true}).open();
    assert.equal(published.at(-1).ownPython, true);
    assert.deepEqual(published.at(-1).test, {state: 'testing'});
    own = {configured: true, managed: true, used: false, backend: 'none', reason: 'no-gpu'};
    assert.deepEqual(setup.status().test, {state: 'refused', backend: 'none', reason: 'no-gpu'});
    own = {configured: true, used: true, backend: 'rocm'};
    assert.equal(setup.status().test, undefined, 'the player\'s own Python is not the setup\'s test');
    await setup.poll();
    assert.equal(setup.running, null, 'the old command is not run');
    assert.throws(() => new OmniAmdSetup({}), /Invalid/);
  } finally { await rm(folder, {recursive: true, force: true}); }
});

test('the pack of a family: named by runtime, family and versions, found on our Hugging Face voice/amd/ folder, accepted only with the pinned files and a SHA-256', () => {
  const roots = {torch: '2.14.0+rocm10.1.0'};
  assert.equal(amdPackName(roots, 'gfx1201'), 'OmniAMD-gfx1201-PyTorch-2.14-ROCm-10.1.zip');
  assert.equal(amdPackUrl('OmniAMD-gfx1201-PyTorch-2.14-ROCm-10.1.zip'), 'https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/resolve/main/voice/amd/OmniAMD-gfx1201-PyTorch-2.14-ROCm-10.1.zip');
  assert.equal(amdPackName({torch: 'x'}, 'gfx1201'), null); assert.equal(amdPackName(roots, '../x'), null); assert.equal(amdPackName(null, 'gfx1201'), null);
  const manifest = {roots, targets: {gfx1201: ['b.whl', 'a.whl']}, files: {'a.whl': {url: 'https://x/a', size: 10, unpacked: 30}, 'b.whl': {url: 'https://x/b', size: 20, unpacked: 60}}};
  const entry = {name: amdPackName(roots, 'gfx1201'), size: 1234, sha256: 'a'.repeat(64), files: ['a.whl', 'b.whl']};
  const found = packFor(manifest, {packs: {gfx1201: entry}}, 'gfx1201', manifest.targets.gfx1201);
  assert.deepEqual(found, {name: entry.name, url: amdPackUrl(entry.name), size: 1234, sha256: 'a'.repeat(64)});
  for (const bad of [{...entry, name: 'OmniAMD-gfx1201-PyTorch-2.15-ROCm-10.1.zip'}, {...entry, sha256: 'A'.repeat(64)}, {...entry, sha256: null}, {...entry, size: 0}, {...entry, files: ['a.whl']},
    {...entry, files: ['a.whl', 'b.whl', 'c.whl']}]) assert.equal(packFor(manifest, {packs: {gfx1201: bad}}, 'gfx1201', manifest.targets.gfx1201), null, JSON.stringify(bad).slice(0, 80));
  assert.equal(packFor(manifest, {packs: {}}, 'gfx1201', manifest.targets.gfx1201), null); assert.equal(packFor(manifest, null, 'gfx1201', manifest.targets.gfx1201), null);
  // The plan downloads the pack when there is one (the page shows its size), else the sum of AMD's files.
  const withPack = planFor(manifest, 'gfx1201', {packs: {gfx1201: entry}}), without = planFor(manifest, 'gfx1201', {packs: {}});
  assert.equal(withPack.downloadBytes, 1234); assert.equal(withPack.filesBytes, 30); assert.equal(withPack.pack.name, entry.name);
  assert.equal(without.downloadBytes, 30); assert.equal(without.pack, null); assert.equal(without.unpackedBytes, 90);
  // The room: the zip and the wheels it holds together, then the unpacked files; what an earlier try left is not counted twice.
  const margin = 512 * 2 ** 20, big = {...withPack, pack: {...withPack.pack, size: 1000}, filesBytes: 800, unpackedBytes: 3000};
  assert.equal(spaceNeeded(big), 800 + 3000 + margin);
  assert.equal(spaceNeeded({...big, unpackedBytes: 100}), 800 + 1000 + margin, 'the zip and the wheels are on the drive together');
  assert.equal(spaceNeeded(big, {packBytes: 400, fileBytes: 100}), 700 + 3000 + margin);
  assert.equal(spaceNeeded(big, {extracted: true}), 3000 + margin);
  assert.equal(spaceNeeded({...big, pack: null}, {fileBytes: 300}), 500 + 3000 + margin, 'from AMD: the wheels and the unpacked files');
});

test('the committed pack list names, for every family it lists, the files of the pinned list and a SHA-256 (an empty list: AMD\'s files are downloaded)', () => {
  const manifest = loadManifest();
  assert.equal(PACKS.version, 1);
  for (const target of Object.keys(PACKS.packs)) {
    const plan = planFor(manifest, target, PACKS);
    assert.ok(plan?.pack, `${target}: the list is stale (run packaging/build-omni-amd-packs.mjs again)`);
    assert.match(plan.pack.url, /^https:\/\/huggingface\.co\/alystria-ai\/ai-npc-cyberpunk-mod-packs\/resolve\/main\/voice\/amd\/OmniAMD-gfx\d+-PyTorch-/);
  }
  if (!Object.keys(PACKS.packs).length) assert.equal(planFor(manifest, 'gfx1201').pack, null);
});

test('install through our pack: one download from voice/amd/, unpacked, the zip deleted, nothing fetched from AMD; setup.json says where it came from', {skip: !haveTar}, async () => {
  const h = await fixture({hosted: true});
  try {
    h.advance(CARD_DELAY_MS); await h.setup.poll();
    const plan = h.setup.plan();
    assert.ok(plan.pack); assert.equal(h.published.at(-1).downloadMiB, Math.round(plan.pack.size / 2 ** 20));
    const id = await h.send('install');
    const status = await h.finished();
    assert.equal(status.job.state, 'done', JSON.stringify(status.job));
    const states = h.published.filter(value => value.job?.id === id).map(value => value.job.state);
    assert.deepEqual([...new Set(states)], ['checking', 'downloading', 'unpacking', 'testing', 'done'], states.join(','));
    assert.deepEqual([...new Set(h.fake.requests.map(request => request.url))], [plan.pack.url], 'only our file was asked for');
    const paths = amdPaths(h.stateDirectory);
    assert.equal((await readAmdSetup({stateDirectory: h.stateDirectory})).source, 'huggingface');
    assert.equal(existsSync(join(paths.site, 'torch', '__init__.py')), true); assert.equal(existsSync(join(paths.site, 'rocm_sdk', '__init__.py')), true);
    assert.equal(existsSync(paths.downloads), false);
  } finally { await h.close(); }
});

test('our pack missing or not right: the job goes on with AMD\'s files, checked one by one; any other failure of ours ends the job as before', {skip: !haveTar}, async () => {
  for (const hosted of ['missing', 'corrupt']) {
    const h = await fixture({hosted});
    try {
      await h.send('install');
      const status = await h.finished();
      assert.equal(status.job.state, 'done', `${hosted}: ${JSON.stringify(status.job)}`);
      assert.ok(h.fake.requests.some(request => request.url.startsWith('https://stable.repo.amd.com/')), hosted);
      assert.equal((await readAmdSetup({stateDirectory: h.stateDirectory})).source, 'amd', hosted);
      assert.ok(h.logs.some(line => line.startsWith('our pack OmniAMD-gfx1201-')), h.logs.join('\n'));
    } finally { await h.close(); }
  }
  // A server error of ours (not "missing") is a failed download: no silent switch to AMD.
  const h = await fixture({hosted: true});
  try {
    const url = amdPackUrl('OmniAMD-gfx1201-PyTorch-2.14-ROCm-10.1.zip');
    h.setup.options.fetchImpl = async (target, init) => target === url ? new Response('no', {status: 503}) : h.fake.fetchImpl(target, init);
    await h.send('install');
    const status = await h.finished();
    assert.deepEqual(status.job.code, 'download-failed');
    assert.equal(h.fake.requests.some(request => request.url.startsWith('https://stable.repo.amd.com/')), false);
  } finally { await h.close(); }
});

test('after a failed unpack the zip is kept and not downloaded again; once unpacked a marker lets the next try skip the download and the unpack', {skip: !haveTar}, async () => {
  const h = await fixture({hosted: true});
  try {
    const good = h.setup.options.extract;
    h.setup.options.extract = async () => { throw Object.assign(Error('x'), {code: 'unpack-failed'}); };
    await h.send('install');
    assert.equal((await h.finished()).job.code, 'unpack-failed');
    const downloads = amdPaths(h.stateDirectory).downloads;
    assert.ok((await readdir(downloads)).some(name => name.startsWith('OmniAMD-')), 'the zip stays for the next try');
    const asked = h.fake.requests.length;
    // The zip is unpacked, then a later step fails (the pack's Python is not there): the marker is written and the wheels stay.
    h.setup.options.extract = good;
    const python = h.setup.options.runtimePython;
    h.setup.options.runtimePython = () => join(h.folder, 'nowhere', 'python.exe');
    await h.send('install', 's:amd:second');
    assert.notEqual((await h.finished()).job.state, 'done');
    assert.equal(h.fake.requests.length, asked, 'the kept zip was verified, not downloaded again');
    const names = await readdir(downloads);
    assert.ok(names.some(name => name.endsWith('.done')) && !names.some(name => name.endsWith('.zip')), names.join(','));
    h.setup.options.runtimePython = python;
    await h.send('install', 's:amd:third');
    assert.equal((await h.finished()).job.state, 'done');
    assert.equal(h.fake.requests.length, asked, 'nothing downloaded at all the third time');
  } finally { await h.close(); }
});
