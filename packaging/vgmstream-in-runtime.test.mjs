// vgmstream ships in the Runtime (docs/PACKAGING.md, "vgmstream in the Runtime"): node --test packaging/vgmstream-in-runtime.test.mjs
//
// What this keeps true: the pin in release.config.json names the 11 files with sizes and SHA-256 values; the build reads them from the checkout's vendor/vgmstream/ (never
// downloads), stops on a missing or changed file, and writes them to app/vgmstream/ with the licence texts in app/licenses/vgmstream/ and a notice in THIRD-PARTY-NOTICES;
// the Runtime's required files and the zip checker name them; a Runtime update from a Runtime without them delivers them; and the notices say what the files are
// and where their sources are. No real build, no download, nothing is started (the install test runs vgmstream-cli.exe from a real install).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipWriter, listZip} from './lib/zip.mjs';
import {readEntry} from './lib/zip-entry.mjs';
import {sha256Buffer, sha256File} from './lib/files.mjs';
import {PLUGIN, refusalFor} from './runtime/apply-removals.mjs';
import {removalListText} from './lib/runtime-removals.mjs';
import {RELEASE_ENTRY, buildRuntimeUpdate} from './build-runtime-update.mjs';
import {checkRuntimeContents} from './check-runtime-contents.mjs';
import {missingRuntimeFiles, requiredRuntimeFiles} from './lib/runtime-required.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const APP = `${PLUGIN}/app`;
const read = rel => readFileSync(resolve(project, rel), 'utf8');
const config = JSON.parse(read('packaging/release.config.json'));
const spec = config.toolchain.vgmstream;
const builder = read('packaging/build-release.mjs');
const body = name => { const at = builder.indexOf(`async function ${name}(`); assert(at >= 0, `${name} exists`); return builder.slice(at, builder.indexOf('\n}\n', at) + 2); };
const EXPECTED = ['vgmstream-cli.exe', 'avcodec-vgmstream-59.dll', 'avformat-vgmstream-59.dll', 'avutil-vgmstream-57.dll', 'libatrac9.dll', 'libcelt-0061.dll', 'libcelt-0110.dll',
  'libg719_decode.dll', 'libmpg123-0.dll', 'libspeex-1.dll', 'libvorbis.dll'];

test('the pin names the release, its licence and source, and the 11 files with size and SHA-256', () => {
  assert.equal(spec.version, 'r2055');
  assert.equal(spec.license, 'ISC');
  assert.equal(spec.runtimeFolder, 'vgmstream');
  assert.equal(spec.licenceFolder, 'licenses/vgmstream');
  assert.equal(spec.vendorFolder, 'vendor/vgmstream');
  assert.equal(spec.executable, 'vgmstream-cli.exe');
  assert.equal(spec.source, `https://github.com/vgmstream/vgmstream/tree/${spec.version}`);
  assert.match(spec.release, /^https:\/\/github\.com\/vgmstream\/vgmstream\/releases\/tag\/r2055$/);
  assert.deepEqual(Object.keys(spec.files).sort(), [...EXPECTED].sort());
  for (const [name, file] of Object.entries(spec.files)) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/, name);
    assert(Number.isInteger(file.size) && file.size > 10_000, name);
  }
  // The files that the voice-over decode does not need are not pinned and so never shipped.
  for (const left of ['swresample-vgmstream-4.dll', 'zlib-ng2.dll', 'in_vgmstream.dll', 'xmp-vgmstream.dll', 'Detex.dll', 'oodle-data-shared.dll']) assert(!(left in spec.files), left);
  assert.equal(Object.values(spec.files).reduce((sum, file) => sum + file.size, 0), 8_125_716, '8.1 MB raw');
});

test('the committed licence texts are what the pin says, and say what is bundled and where the sources are', () => {
  for (const [name, licence] of Object.entries(spec.licences)) {
    assert(existsSync(resolve(project, licence.path)), `${licence.path} is committed (vendor/ is not in git)`);
    if (licence.sha256) assert.equal(sha256Buffer(readFileSync(resolve(project, licence.path))), licence.sha256, name);
  }
  assert.deepEqual(Object.keys(spec.licences).sort(), ['COPYING', 'NOTICE-bundled-libraries.txt']);
  const copying = read(spec.licences.COPYING.path);
  assert.match(copying, /Permission to use, copy, modify, and distribute this software for any\s+purpose with or without fee is hereby granted/, 'ISC');
  assert.match(copying, /Adam Gashlin/);
  const notice = read(spec.licences['NOTICE-bundled-libraries.txt'].path);
  for (const text of ['r2055', 'app/vgmstream/', 'https://github.com/vgmstream/vgmstream/tree/r2055', 'LGPL-2.1-or-later', 'unmodified', 'dynamically', 'BSD-3-Clause', 'MIT', 'FFmpeg',
    'libmpg123-0.dll', 'libvorbis.dll', 'libspeex-1.dll', 'libcelt-0061.dll', 'libcelt-0110.dll', 'libatrac9.dll', 'libg719_decode.dll', 'carries no licence text', 'one line at a time']) {
    assert(notice.includes(text), `the library notice mentions ${text}`);
  }
  assert.doesNotMatch(notice + copying, /\bAMM\b/);
  assert.doesNotMatch(notice, /Claude|Anthropic/i);
});

test('the files in a development checkout (vendor/vgmstream, git-ignored) are the pinned ones', async t => {
  const folder = resolve(project, spec.vendorFolder);
  if (!existsSync(join(folder, spec.executable))) return t.skip('vendor/vgmstream is not in this checkout');
  for (const [name, file] of Object.entries(spec.files)) {
    assert.equal((await stat(join(folder, name))).size, file.size, name);
    assert.equal(await sha256File(join(folder, name)), file.sha256, name);
  }
});

test('the Runtime requires the 11 files and the two licence files; the zip checker names the missing one', async () => {
  const required = await requiredRuntimeFiles(project);
  assert.deepEqual(required['vgmstream decoder'], EXPECTED.map(name => `${PLUGIN}/app/vgmstream/${name}`));
  assert.deepEqual(required['vgmstream licences'], ['COPYING', 'NOTICE-bundled-libraries.txt'].map(name => `${PLUGIN}/app/licenses/vgmstream/${name}`));
  const names = Object.values(required).flat();
  assert.deepEqual(missingRuntimeFiles(names, required), {});
  const dll = `${PLUGIN}/app/vgmstream/libvorbis.dll`;
  assert.deepEqual(missingRuntimeFiles(names.filter(name => name !== dll), required), {'vgmstream decoder': [dll]});
  assert.deepEqual(Object.keys(missingRuntimeFiles(names.filter(name => !name.includes('/vgmstream/')), required)).sort(), ['vgmstream decoder', 'vgmstream licences']);
  assert.deepEqual(missingRuntimeFiles(names.map(name => name.toUpperCase()), required), {}, 'Windows names are not case sensitive');
  const directory = await mkdtemp(join(tmpdir(), 'vgmstream contents test '));
  try {
    const zipOf = async (file, list) => { const zip = await ZipWriter.create(join(directory, file)); for (const name of list) await zip.add(name, {buffer: Buffer.from('x')}); await zip.close(); return join(directory, file); };
    const lines = [];
    assert.equal(await checkRuntimeContents([await zipOf('ok.zip', names)], {log: line => lines.push(line)}), true, lines.join('\n'));
    lines.length = 0;
    assert.equal(await checkRuntimeContents([await zipOf('no-exe.zip', names.filter(name => !name.endsWith('vgmstream-cli.exe')))], {log: line => lines.push(line)}), false);
    assert(lines.some(line => /MISSING \(vgmstream decoder\).*vgmstream-cli\.exe/.test(line)), lines.join('\n'));
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('the build writes the files from the checkout vendor folder, checks each against the pin, adds the licences and the notices', () => {
  const runtime = body('runtimePackage');
  assert.match(runtime, /await addRuntimeVgmstream\(pkg, source, config, app, notices\)/, 'the Runtime package adds vgmstream');
  const add = body('addRuntimeVgmstream');
  assert.match(add, /resolve\(project, spec\.vendorFolder\)/, 'read from the working checkout: vendor/ is not in the exported commit');
  assert.match(add, /sha256File\(path\) !== pinned\.sha256/, 'every file is checked against the pin');
  assert.match(add, /\(await stat\(path\)\)\.size !== pinned\.size/);
  assert.match(add, /pkg\.file\(`\$\{app\}\/\$\{folder\}\/\$\{name\}`, path\)/, 'the files go to app/vgmstream/');
  assert.match(add, /pkg\.file\(`\$\{app\}\/\$\{spec\.licenceFolder\}\/\$\{name\}`, path\)/, 'the licences go to app/licenses/vgmstream/');
  assert.equal((add.match(/notices\.push\(/g) ?? []).length, 2, 'two lines in THIRD-PARTY-NOTICES.txt: vgmstream and its libraries');
  assert.match(add, /LGPL-2\.1-or-later/);
  assert.doesNotMatch(add, /download\(|fetch\(/, 'nothing is downloaded');
  assert.doesNotMatch(add, /\bAMM\b/);
});

test('addRuntimeVgmstream packs the pinned files and stops on a missing or changed one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vgmstream build test '));
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const bytes = name => Buffer.from(`bytes of ${name}`);
    const root = join(directory, 'checkout');
    await mkdir(join(root, 'vendor/vgmstream'), {recursive: true});
    await mkdir(join(root, 'packaging/licenses/vgmstream'), {recursive: true});
    const files = Object.fromEntries(EXPECTED.map(name => [name, {size: bytes(name).length, sha256: sha256Buffer(bytes(name))}]));
    for (const name of EXPECTED) await writeFile(join(root, 'vendor/vgmstream', name), bytes(name));
    await writeFile(join(root, 'packaging/licenses/vgmstream/COPYING'), 'ISC text');
    await writeFile(join(root, 'packaging/licenses/vgmstream/NOTICE-bundled-libraries.txt'), 'notice');
    const fixture = {...spec, files, licences: {COPYING: {path: 'packaging/licenses/vgmstream/COPYING', sha256: sha256Buffer(Buffer.from('ISC text'))},
      'NOTICE-bundled-libraries.txt': {path: 'packaging/licenses/vgmstream/NOTICE-bundled-libraries.txt'}}};
    // The function's own text from the builder, with the builder's names handed in (the builder is a script and cannot be imported).
    const text = body('addRuntimeVgmstream').replace(/^async function addRuntimeVgmstream/, 'return async function');
    const run = async () => {
      const fn = await new AsyncFunction('resolve', 'existsSync', 'stat', 'sha256File', 'project', text)(resolve, existsSync, stat, sha256File, root);
      const packed = new Map(), notices = [];
      const count = await fn({file: (name, from) => packed.set(name, from)}, {root}, {toolchain: {vgmstream: fixture}}, 'APP', notices);
      return {count, packed, notices};
    };
    const done = await run();
    assert.equal(done.count, 11);
    assert.deepEqual([...done.packed.keys()].sort(), [...EXPECTED.map(name => `APP/vgmstream/${name}`), 'APP/licenses/vgmstream/COPYING', 'APP/licenses/vgmstream/NOTICE-bundled-libraries.txt'].sort());
    assert.equal(done.packed.get('APP/vgmstream/vgmstream-cli.exe'), join(root, 'vendor/vgmstream/vgmstream-cli.exe'));
    assert.match(done.notices.join('\n'), /vgmstream r2055[\s\S]*ISC[\s\S]*LGPL-2\.1-or-later[\s\S]*libg719_decode/);
    // A changed file (same size, other bytes) and a missing file each stop the build; so does a licence text that is not the pinned one.
    await writeFile(join(root, 'vendor/vgmstream/libvorbis.dll'), Buffer.from(bytes('libvorbis.dll').toString().toUpperCase()));
    await assert.rejects(run, /libvorbis\.dll differs from the pinned file/);
    await writeFile(join(root, 'vendor/vgmstream/libvorbis.dll'), bytes('libvorbis.dll'));
    await rm(join(root, 'vendor/vgmstream/libspeex-1.dll'));
    await assert.rejects(run, /libspeex-1\.dll is missing/);
    await writeFile(join(root, 'vendor/vgmstream/libspeex-1.dll'), bytes('libspeex-1.dll'));
    await writeFile(join(root, 'packaging/licenses/vgmstream/COPYING'), 'other text');
    await assert.rejects(run, /differs from the pinned licence text/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('a Runtime update from a Runtime without vgmstream delivers the 11 files and the licences, and never lists them for removal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vgmstream update test '));
  try {
    const stamp = version => JSON.stringify({product: 'AI-NPC-Cyberpunk-Mod', package: 'runtime', version, commit: `c-${version}`});
    const makeZip = async (path, files) => { const writer = await ZipWriter.create(path); for (const name of Object.keys(files).sort()) await writer.add(name, {buffer: Buffer.from(files[name])}); await writer.close(); return path; };
    const shipped = Object.fromEntries([...EXPECTED.map(name => `${APP}/vgmstream/${name}`), `${APP}/licenses/vgmstream/COPYING`, `${APP}/licenses/vgmstream/NOTICE-bundled-libraries.txt`].map(name => [name, `bytes of ${name}`]));
    const old = {[`${APP}/bridge/convai-bridge.mjs`]: 'bridge v1', [RELEASE_ENTRY]: stamp('0.2.7')};
    const next = {...old, ...shipped, [RELEASE_ENTRY]: stamp('0.2.8'), [`${APP}/defaults/runtime-removals.json`]: removalListText('0.2.8', [])};
    const summary = await buildRuntimeUpdate({oldZips: [await makeZip(join(dir, 'old.zip'), old)], newZips: [await makeZip(join(dir, 'new.zip'), next)], out: join(dir, 'out'), log: () => {}});
    const zip = join(dir, 'out', 'AI-NPC-Cyberpunk-Mod-Runtime-Update-0.2.7-to-0.2.8.zip');
    const held = Object.fromEntries(await Promise.all((await listZip(zip)).map(async entry => [entry.name, (await readEntry(zip, entry)).toString('utf8')])));
    for (const name of Object.keys(shipped)) assert.equal(held[name], shipped[name], `${name} is in the update`);
    assert.equal(summary.added, Object.keys(shipped).length + 1, 'the 13 files and the removal list are added');
    assert(!JSON.parse(held[`${APP}/defaults/runtime-removals.json`]).removes.some(path => /vgmstream/i.test(path)));
    // A later Runtime may drop or rename a library: the folder is the Runtime's, so the start step may delete such a file.
    assert.equal(refusalFor(`${APP}/vgmstream/libcelt-0061.dll`), null);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the notices name vgmstream, its licences and the source; the install test starts the CLI; the docs have the section', () => {
  const notices = read('THIRD_PARTY_NOTICES.md').replaceAll('\r\n', '\n');
  const runtimeTable = notices.slice(notices.indexOf('## Bundled in the Runtime package'), notices.indexOf('## Bundled in the optional OmniVoice pack'));
  for (const text of ['vgmstream', 'r2055', 'ISC', 'LGPL-2.1-or-later', 'unmodified official vgmstream release DLLs, dynamically linked', 'app/vgmstream/', 'app/licenses/vgmstream/COPYING',
    'https://github.com/vgmstream/vgmstream/tree/r2055', 'BSD-3-Clause', 'MIT', 'FFmpeg', 'mpg123', 'libg719_decode.dll', 'one line at a time', "player's own PC", 'V voice mod']) {
    assert(runtimeTable.includes(text), `THIRD_PARTY_NOTICES.md (Runtime section) mentions ${text}`);
  }
  assert.doesNotMatch(runtimeTable, /\bAMM\b/);
  const install = read('packaging/test-release-install.mjs');
  assert.match(install, /vgmstreamSpec\.executable\), \['-h'\]/);
  assert.match(install, /vgmstream CLI decoder \$\{vgmstreamSpec\.version\} \(\$\{vgmstreamSpec\.build\}\)/);
  const docs = read('docs/PACKAGING.md');
  assert(docs.includes('### vgmstream in the Runtime'));
  assert(docs.includes('app/vgmstream/'));
  assert(docs.includes('vendor/vgmstream/'));
});
