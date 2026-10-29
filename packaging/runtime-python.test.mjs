// What the Runtime build guarantees about the Python it ships (packaging/lib/python-stdlib.mjs, packaging/lib/runtime-prune.mjs PYTHON_SKIP, packaging/build-release.mjs):
// every file the voice workers import is in the package. Report 0b8367fd0ebd2f2f (0.3.4): a player's app/python had no Lib/urllib and the voice never started;
// the shipped zips were complete, so the build now refuses to ship a Python that lacks any of these, and the running bridge checks the installed one
// (bridge/runtime-python.mjs, bridge/runtime-python.test.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DISTUTILS_PACKAGE, DISTUTILS_PTH, SITE_PACKAGES, STDLIB_FILES} from '../bridge/runtime-python.mjs';
import {PYTHON_SKIP, pythonPruned} from './lib/runtime-prune.mjs';
import {assertPythonShipped, assertStdlibUnzipped, missingPythonFiles, stdlibNotUnzipped} from './lib/python-stdlib.mjs';
import {listZip} from './lib/zip.mjs';
import {extractZip} from './lib/files.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** The files a complete Runtime Python holds, as the build packs them (paths relative to app/python). */
const completeTree = () => [
  'python.exe', 'python312.dll', 'python312._pth',
  ...STDLIB_FILES.map(file => `Lib/${file}.pyc`),
  ...SITE_PACKAGES.map(name => `Lib/site-packages/${name}/__init__.py`),
  `Lib/site-packages/${DISTUTILS_PTH}`, `Lib/site-packages/${DISTUTILS_PACKAGE}/__init__.py`, `Lib/site-packages/${DISTUTILS_PACKAGE}/override.py`,
];

test('the skip and prune rules keep every file the voice workers import', () => {
  for (const rel of completeTree()) {
    assert.equal(PYTHON_SKIP(rel), false, `skipped: ${rel}`);
    assert.equal(pythonPruned(rel), false, `pruned: ${rel}`);
  }
});

test('the skip rule still drops what no worker loads: caches, wheels\' compiled files, headers, build tools', () => {
  for (const rel of ['Lib/__pycache__/os.cpython-312.pyc', 'Lib/site-packages/numpy/__pycache__/x.pyc', 'Lib/site-packages/yaml/loader.pyc',
    'Lib/site-packages/torch/include/ATen/ATen.h', 'Lib/site-packages/torch/lib/torch.lib', 'Lib/site-packages/setuptools/cli-64.exe', 'Lib/site-packages/torch/bin/protoc.exe']) {
    assert.equal(PYTHON_SKIP(rel), true, rel);
  }
  // Only site-packages' compiled files are dropped: the standard library is shipped as .pyc, so a rule that skipped every .pyc would ship none of it.
  assert.equal(PYTHON_SKIP('Lib/pathlib.pyc'), false);
});

test('a complete tree passes, and the build refuses a Python without urllib or without the setuptools package its .pth imports', () => {
  assert.deepEqual(missingPythonFiles(completeTree()), []);
  assert.doesNotThrow(() => assertPythonShipped(completeTree()));
  const noUrllib = completeTree().filter(path => !path.startsWith('Lib/urllib/'));
  assert(missingPythonFiles(noUrllib).includes('Lib/urllib/parse'));
  assert.throws(() => assertPythonShipped(noUrllib), /Runtime's Python lacks 5 file\(s\).*Lib\/urllib\/__init__/);
  const noHack = completeTree().filter(path => !path.includes(`/${DISTUTILS_PACKAGE}/`));
  assert.deepEqual(missingPythonFiles(noHack), [`Lib/site-packages/${DISTUTILS_PACKAGE}/__init__`]);
  // Without the .pth nothing imports the package, so it is not required.
  assert.deepEqual(missingPythonFiles(noHack.filter(path => !path.endsWith(DISTUTILS_PTH))), []);
  const noTorch = completeTree().filter(path => !path.includes('/torch/'));
  assert.deepEqual(missingPythonFiles(noTorch), ['Lib/site-packages/torch/__init__']);
});

test('a Python that keeps the standard library in python312.zip is asked for its site-packages only', () => {
  const zipped = completeTree().filter(path => !path.startsWith('Lib/') || path.startsWith('Lib/site-packages/'));
  assert.deepEqual(missingPythonFiles(zipped, {zipped: true}), []);
  assert(missingPythonFiles(zipped).length > 100);
  assert.throws(() => assertPythonShipped(zipped.filter(path => !path.includes('/yaml/')), {zipped: true, what: 'the OmniPack'}), /OmniPack's Python lacks 1 file/);
});

test('an unzipped Lib must hold every file of its zip', () => {
  const names = ['urllib/', 'urllib/parse.pyc', 'urllib/__init__.pyc', 'site-packages/README.txt', 'pathlib.pyc'];
  assert.deepEqual(stdlibNotUnzipped(names, ['urllib/parse.pyc', 'urllib/__init__.pyc', 'site-packages/README.txt', 'pathlib.pyc']), []);
  assert.deepEqual(stdlibNotUnzipped(names, ['pathlib.pyc', 'site-packages/README.txt']), ['urllib/parse.pyc', 'urllib/__init__.pyc']);
  assert.doesNotThrow(() => assertStdlibUnzipped(names, ['urllib/parse.pyc', 'urllib/__init__.pyc', 'site-packages/README.txt', 'pathlib.pyc']));
  assert.throws(() => assertStdlibUnzipped(names, ['pathlib.pyc'], {zip: 'python312.zip'}), /python312\.zip unzipped to Lib\/ without 3 file\(s\)/);
});

test('the build calls both guards where the files are made and packed', async () => {
  const {readFile} = await import('node:fs/promises');
  const source = (await readFile(resolve(project, 'packaging/build-release.mjs'), 'utf8')).replace(/\r\n/g, '\n');
  assert(source.includes("import {assertPythonShipped, assertStdlibUnzipped} from './lib/python-stdlib.mjs';"));
  assert(/listZip\(resolve\(target, stdlibZip\)\)[\s\S]*?extractZip\(resolve\(target, stdlibZip\)[\s\S]*?assertStdlibUnzipped\(zipNames[\s\S]*?await rm\(resolve\(target, stdlibZip\)\)/.test(source),
    'the zip is listed, unzipped and compared before it is deleted');
  assert(/await pkg\.tree\(`\$\{app\}\/python`[\s\S]*?assertPythonShipped\(/.test(source), 'the packed Python is checked after the tree is added');
  assert(!/const PYTHON_SKIP =/.test(source), 'one definition of the skip rule (packaging/lib/runtime-prune.mjs)');
});

// The list against the real Python: every module in it is in the embeddable package's standard library zip (so it is a file the Runtime unzips). Needs the downloaded
// embeddable package (packaging/build-release.mjs caches it); skipped on a checkout that has none. AI_NPC_PYTHON_EMBED can name the zip.
const embed = process.env.AI_NPC_PYTHON_EMBED || resolve(project, 'dist/release-cache/downloads/python-3.12.10-embed-amd64.zip');
test('every standard library file the list asks for is in the embeddable Python\'s python312.zip', { skip: !existsSync(embed) && 'no cached embeddable Python on this checkout' }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'embed-stdlib-'));
  try {
    await extractZip(embed, work);
    const names = new Set((await listZip(join(work, 'python312.zip'))).map(entry => entry.name));
    const missing = STDLIB_FILES.filter(file => !names.has(`${file}.pyc`) && !names.has(`${file}.py`));
    assert.deepEqual(missing, []);
  } finally { await rm(work, {recursive: true, force: true}); }
});
