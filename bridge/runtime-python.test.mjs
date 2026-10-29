// The Runtime's Python has the files the voice workers import (bridge/runtime-python.mjs). Report 0b8367fd0ebd2f2f (0.3.4): "No module named 'urllib'" with Python
// starting fine, because Lib/urllib and Lib/site-packages/_distutils_hack were not on the disk. The trees below are made of empty files in a temporary folder:
// the full Runtime Python is 580 MB. The release install test (packaging/test-release-install.mjs) runs the same check against the real packaged Python.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {DISTUTILS_PACKAGE, DISTUTILS_PTH, REQUIRED_MODULES, SITE_PACKAGES, STDLIB_FILES, checkPythonFiles, checkPythonImports, checkRuntimePython, moduleNameOf,
  pathEntries, startupFailures} from './runtime-python.mjs';
import {cachedRuntimePython, collectSetupCheck, resetRuntimePythonCache} from './setup-check.mjs';

const PTH_LIB = 'Lib\r\n.\r\nLib\\site-packages\r\n..\\bridge\r\nimport site\r\n';
const PTH_ZIP = 'python312.zip\r\n.\r\nLib\\site-packages\r\n..\\bridge\r\nimport site\r\n';

const put = async (root, rel, text = '') => { await mkdir(dirname(join(root, rel)), {recursive: true}); await writeFile(join(root, rel), text); };

/** A Runtime app/ folder: python.exe, the _pth, the standard library as Lib/*.pyc (or python312.zip), the site-packages and the setuptools .pth. */
async function runtime({layout = 'lib', packages = true, hack = true} = {}) {
  const app = await mkdtemp(join(tmpdir(), 'python-check-'));
  await put(app, 'python/python.exe', 'x');
  await put(app, 'python/python312._pth', layout === 'lib' ? PTH_LIB : PTH_ZIP);
  if (layout === 'lib') for (const file of STDLIB_FILES) await put(app, `python/Lib/${file}.pyc`);
  else await writeFile(join(app, 'python/python312.zip'), Buffer.alloc(2 * 1024 * 1024));
  if (packages) for (const name of SITE_PACKAGES) await put(app, `python/Lib/site-packages/${name}/__init__.py`);
  if (hack) {
    await put(app, `python/Lib/site-packages/${DISTUTILS_PTH}`, "import os; __import__('_distutils_hack').add_shim()\n");
    await put(app, `python/Lib/site-packages/${DISTUTILS_PACKAGE}/__init__.py`);
  }
  return app;
}
const cleanup = app => rm(app, {recursive: true, force: true});

test('the list holds what the report named and not what Python freezes into its DLL', () => {
  assert(STDLIB_FILES.includes('urllib/parse') && STDLIB_FILES.includes('pathlib') && STDLIB_FILES.includes('encodings/__init__'));
  assert(REQUIRED_MODULES.includes('urllib.parse') && REQUIRED_MODULES.includes('urllib') && REQUIRED_MODULES.includes('torch') && REQUIRED_MODULES.includes('sherpa_onnx'));
  // Frozen into python312.dll: no file exists for them in the embeddable package, so the check must not ask for one.
  for (const frozen of ['os', 'io', 'abc', 'codecs', 'site', 'stat', 'posixpath', 'ntpath', 'genericpath', 'runpy', 'zipimport', '_collections_abc', '_sitebuiltins', 'importlib/util', 'importlib/machinery']) {
    assert(!STDLIB_FILES.includes(frozen), `${frozen} is frozen`);
  }
  assert.equal(new Set(STDLIB_FILES).size, STDLIB_FILES.length, 'no duplicate');
  assert.equal(moduleNameOf('urllib/__init__'), 'urllib');
  assert.equal(moduleNameOf('importlib/metadata/_text'), 'importlib.metadata._text');
});

test('_pth lines: folders and the zip are paths, comments and `import site` are not', () => {
  const entries = pathEntries(PTH_LIB + '# note\r\n', 'C:\\r\\app\\python');
  assert.deepEqual(entries.map(entry => entry.kind), ['dir', 'dir', 'dir', 'dir']);
  assert(entries[0].path.endsWith('Lib'));
  assert.deepEqual(pathEntries(PTH_ZIP, 'C:\\r\\app\\python').map(entry => entry.kind), ['zip', 'dir', 'dir', 'dir']);
  assert.deepEqual(pathEntries('', 'C:\\x'), []);
});

test('a complete unzipped Runtime Python is ok, in the Lib layout', async () => {
  const app = await runtime();
  try {
    const found = await checkPythonFiles({project: app});
    assert.equal(found.state, 'ok'); assert.equal(found.code, 'ok'); assert.equal(found.layout, 'lib'); assert.deepEqual(found.missing, []);
  } finally { await cleanup(app); }
});

test('a Runtime that still keeps the standard library in python312.zip is ok (the zip is not opened)', async () => {
  const app = await runtime({layout: 'zip'});
  try {
    const found = await checkPythonFiles({project: app});
    assert.equal(found.state, 'ok'); assert.equal(found.layout, 'zip');
  } finally { await cleanup(app); }
});

test('the report: Lib/urllib and the _distutils_hack folder gone, Python and the rest still there', async () => {
  const app = await runtime();
  try {
    await rm(join(app, 'python/Lib/urllib'), {recursive: true});
    await rm(join(app, `python/Lib/site-packages/${DISTUTILS_PACKAGE}`), {recursive: true});
    const found = await checkPythonFiles({project: app});
    assert.equal(found.state, 'problem'); assert.equal(found.code, 'incomplete'); assert.equal(found.layout, 'lib');
    assert(found.missing.includes('urllib') && found.missing.includes('urllib.parse') && found.missing.includes(DISTUTILS_PACKAGE), found.missing.join());
    assert(found.missingCount >= 6);
    assert(found.missing.length <= 8, 'a short list in the answer');
  } finally { await cleanup(app); }
});

test('a missing site-package, a missing top-level file and an empty Lib are each a problem', async () => {
  let app = await runtime();
  try {
    await rm(join(app, 'python/Lib/site-packages/torch'), {recursive: true});
    assert.deepEqual((await checkPythonFiles({project: app})).missing, ['torch']);
    await rm(join(app, 'python/Lib/pathlib.pyc'));
    assert.deepEqual((await checkPythonFiles({project: app})).missing, ['pathlib', 'torch']);
  } finally { await cleanup(app); }
  app = await runtime();
  try {
    // The shape of an install whose _pth was replaced (the Lib layout) while the Lib folder was not: nothing of the standard library there.
    await rm(join(app, 'python/Lib'), {recursive: true});
    const found = await checkPythonFiles({project: app});
    assert.equal(found.state, 'problem'); assert.equal(found.layout, 'lib'); assert(found.missingCount > STDLIB_FILES.length);
  } finally { await cleanup(app); }
});

test('the five install combinations of the report, as file sets', async () => {
  // (a) the fixed Full alone, (b) the old Full and then the fixed Full over it, (c) the fixed Full and then the Scripts update, (d) 0.3.3 and then the Scripts update,
  // (e) the old Full alone. The Scripts update carries no Python file, so it changes nothing; the fixed Full over the old one leaves python312.zip as an unused extra.
  const a = await runtime();
  const b = await runtime();
  const e = await runtime({layout: 'zip'});
  try {
    await writeFile(join(b, 'python/python312.zip'), Buffer.alloc(2 * 1024 * 1024));
    for (const [name, app] of [['a', a], ['b', b], ['c', a], ['d', e], ['e', e]]) assert.equal((await checkRuntimePython({project: app})).state, 'ok', name);
    // A mixed state that does break: the new _pth (Lib) over the old files (zip, no Lib).
    await put(e, 'python/python312._pth', PTH_LIB);
    const mixed = await checkRuntimePython({project: e});
    assert.equal(mixed.state, 'problem'); assert.equal(mixed.layout, 'lib');
  } finally { await Promise.all([a, b, e].map(cleanup)); }
});

test('no python.exe is "unknown" (the Runtime itself is not installed: other checks say so), no _pth is a problem, a bad project never throws', async () => {
  const app = await mkdtemp(join(tmpdir(), 'python-check-'));
  try {
    assert.equal((await checkPythonFiles({project: app})).state, 'unknown');
    await put(app, 'python/python.exe', 'x');
    const none = await checkPythonFiles({project: app});
    assert.equal(none.state, 'problem'); assert.equal(none.code, 'no-path-file');
  } finally { await cleanup(app); }
  assert.equal((await checkPythonFiles({})).state, 'unknown');
  assert.equal((await checkPythonFiles({project: join(tmpdir(), 'does-not-exist-python-check')})).state, 'unknown');
});

test('start-up messages: the module names of "No module named" and nothing else', () => {
  const stderr = 'Error processing line 1 of C:\\game\\red4ext\\plugins\\AiNpcCyberpunkMod\\app\\python\\Lib\\site-packages\\distutils-precedence.pth:\r\nTraceback (most recent call last):\r\n'
    + '  File "<string>", line 1, in <module>\r\nModuleNotFoundError: No module named \'_distutils_hack\'\r\nRemainder of file ignored\r\n';
  assert.deepEqual(startupFailures(stderr), ['_distutils_hack']);
  assert.deepEqual(startupFailures(''), []);
  assert.deepEqual(startupFailures("ModuleNotFoundError: No module named 'urllib'"), ['urllib']);
});

const fakeRun = ({stdout = '[]', stderr = '', error = null, seen = null} = {}) => (file, args, options, done) => {
  seen?.push({file, args, options});
  done(error, stdout, stderr);
};

test('the import stage asks the packaged Python with -I and one list, and reads the modules it could not find', async () => {
  const app = await runtime();
  try {
    const seen = [];
    const ok = await checkPythonImports({project: app, run: fakeRun({seen})});
    assert.equal(ok.state, 'ok');
    assert.equal(seen.length, 1);
    assert(seen[0].file.endsWith('python.exe')); assert(seen[0].args.includes('-I')); assert(seen[0].args.includes('-B'));
    assert.deepEqual(JSON.parse(seen[0].args.at(-1)), [...REQUIRED_MODULES]);
    assert.equal(seen[0].options.windowsHide, true); assert(seen[0].options.timeout <= 30000);
    const bad = await checkPythonImports({project: app, run: fakeRun({stdout: 'noise\n["urllib","urllib.parse"]\n'})});
    assert.equal(bad.state, 'problem'); assert.equal(bad.code, 'import-failed'); assert.deepEqual(bad.missing, ['urllib', 'urllib.parse']);
    // Python printed a start-up import error even though the finder ran: still a problem, with the module's name.
    const startup = await checkPythonImports({project: app, run: fakeRun({stdout: '[]', stderr: "ModuleNotFoundError: No module named '_distutils_hack'"})});
    assert.deepEqual([startup.state, startup.missing], ['problem', ['_distutils_hack']]);
    // It did not run at all, nothing named: no verdict (a timeout or a refusal by Windows is not a missing file).
    assert.equal((await checkPythonImports({project: app, run: fakeRun({stdout: '', error: Error('timeout')})})).state, 'unknown');
    // It died at start-up on a missing module: a problem that names it.
    const died = await checkPythonImports({project: app, run: fakeRun({stdout: '', stderr: "ModuleNotFoundError: No module named 'encodings'", error: Error('exit 1')})});
    assert.deepEqual([died.state, died.missing], ['problem', ['encodings']]);
    const thrown = await checkPythonImports({project: app, run: () => { throw Error('spawn EPERM'); }});
    assert.equal(thrown.state, 'unknown');
  } finally { await cleanup(app); }
});

test('both stages together: the files come first, the worse answer wins, an unknown import stage leaves the files answer', async () => {
  const app = await runtime();
  try {
    assert.equal((await checkRuntimePython({project: app})).state, 'ok');
    const withImports = await checkRuntimePython({project: app, import: true, run: fakeRun({stdout: '["wave"]'})});
    assert.deepEqual([withImports.state, withImports.code, withImports.missing], ['problem', 'incomplete', ['wave']]);
    assert.equal((await checkRuntimePython({project: app, import: true, run: fakeRun({error: Error('x'), stdout: ''})})).state, 'ok');
    await rm(join(app, 'python/Lib/urllib'), {recursive: true});
    const both = await checkRuntimePython({project: app, import: true, run: fakeRun({stdout: '["urllib.parse","wave"]'})});
    assert.equal(both.state, 'problem'); assert(both.missing.includes('wave') && both.missing.includes('urllib'));
  } finally { await cleanup(app); }
});

test('the setup check: a row "python" in every run, files only in the light run, the Python asked in a full run, a good answer kept for ten minutes, a bad one never', async () => {
  resetRuntimePythonCache();
  const app = await runtime();
  try {
    let asked = 0;
    const run = fakeRun({stdout: '[]'});
    const counting = (file, args, options, done) => { asked += 1; run(file, args, options, done); };
    const check = options => checkRuntimePython({...options, run: counting});
    let clock = 1_000_000;
    const light = await cachedRuntimePython({project: app, light: true, now: () => clock, check});
    assert.equal(light.state, 'ok'); assert.equal(asked, 0, 'a light run starts no process');
    await cachedRuntimePython({project: app, now: () => clock, check});
    await cachedRuntimePython({project: app, now: () => clock + 60_000, check});
    assert.equal(asked, 1, 'asked once, then kept');
    await cachedRuntimePython({project: app, now: () => clock + 11 * 60_000, check});
    assert.equal(asked, 2, 'asked again after ten minutes');
    resetRuntimePythonCache();
    await rm(join(app, 'python/Lib/urllib'), {recursive: true});
    clock = 2_000_000; asked = 0;
    for (let index = 0; index < 3; index += 1) assert.equal((await cachedRuntimePython({project: app, now: () => clock, check})).state, 'problem');
    assert.equal(asked, 3, 'a problem is asked again every time');
    const document = await collectSetupCheck({project: app, light: true});
    const row = document.checks.find(item => item.id === 'python');
    assert.equal(row.state, 'problem'); assert.equal(row.code, 'incomplete'); assert(row.missing.includes('urllib')); assert.equal(row.missingCount, 5); assert.equal(row.layout, 'lib');
  } finally { resetRuntimePythonCache(); await cleanup(app); }
});

test('the setup check row from an injected check: the light flag passed, unknown when the check fails, unknown without a project', async () => {
  const lights = [];
  const injected = async ({light}) => { lights.push(light); return {state: 'problem', missing: ['urllib', 'a b', 5], missingCount: 2, layout: 'zip'}; };
  const document = await collectSetupCheck({python: injected, light: true});
  const row = document.checks.find(item => item.id === 'python');
  assert.deepEqual([row.state, row.code, row.layout, row.missingCount], ['problem', 'incomplete', 'zip', 2]);
  assert.deepEqual(row.missing, ['urllib', 'a b']);
  assert.deepEqual(lights, [true]);
  const failing = (await collectSetupCheck({python: async () => { throw Error('x'); }})).checks.find(item => item.id === 'python');
  assert.deepEqual([failing.state, failing.code], ['unknown', 'unknown']);
  const none = (await collectSetupCheck({})).checks.find(item => item.id === 'python');
  assert.deepEqual([none.state, none.code, none.missing], ['unknown', 'unknown', []]);
});
