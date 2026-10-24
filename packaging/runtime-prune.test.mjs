// What the Runtime build leaves out (packaging/lib/runtime-prune.mjs) and how that reaches a player who already has the files: the rules keep every
// file the voice, the microphone and the browser load, the Pocket source rule matches the worker's own source check, and the update zip's removal list
// carries every pruned path and the start step deletes them. Fixture files in a temporary folder; no real Runtime.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipWriter, listZip} from './lib/zip.mjs';
import {extractEntry} from './lib/zip-entry.mjs';
import {POCKET_SHIPPED_FILES, POCKET_SHIPPED_PREFIX, PYTHON_PRUNE_RULES, nodePackagePruned, pocketShipped, pythonPruned} from './lib/runtime-prune.mjs';
import {parsePocketSourceList} from './lib/pocket-source-list.mjs';
import {DECLARED_REMOVALS, REMOVALS_ENTRY, checkRemovals} from './lib/runtime-removals.mjs';
import {PLUGIN, applyRuntimeRemovals} from './runtime/apply-removals.mjs';
import {RELEASE_ENTRY, buildRuntimeUpdate} from './build-runtime-update.mjs';
import {baseText, BASE_FILE, STEPS_DIR} from '../bridge/runtime-steps.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const APP = `${PLUGIN}/app`;
const PY = `${APP}/python`;
const SITE = 'Lib/site-packages';
const quiet = () => {};

test('the Python rules leave out the sherpa-onnx wheel\'s second copy, torch/bin and the packages\' tests folders', () => {
  for (const rel of [`${SITE}/Scripts/onnxruntime.dll`, `${SITE}/Scripts/sherpa-onnx-c-api.dll`, `${SITE}/Scripts/sherpa-onnx-cxx-api.lib`,
    `${SITE}/torch/bin/fbgemm.dll`, `${SITE}/torch/bin/asmjit.dll`,
    `${SITE}/numpy/_core/tests/test_dtype.py`, `${SITE}/scipy/special/tests/data/boost.npz`, `${SITE}/networkx/algorithms/flow/tests/test_maxflow.py`,
    `${SITE}/sympy/core/tests/test_basic.py`, `${SITE}/mpmath/tests/test_basic_ops.py`, `${SITE}/setuptools/_distutils/tests/support.py`]) {
    assert.equal(pythonPruned(rel), true, rel);
  }
});

test('the Python rules keep what is loaded: the DLLs torch and sherpa-onnx use, numpy/scipy/sympy/torch testing packages, and look-alike names', () => {
  for (const rel of [`${SITE}/sherpa_onnx/lib/onnxruntime.dll`, `${SITE}/sherpa_onnx/lib/_sherpa_onnx.cp312-win_amd64.pyd`, `${SITE}/sherpa_onnx/__init__.py`,
    `${SITE}/torch/lib/fbgemm.dll`, `${SITE}/torch/lib/asmjit.dll`, `${SITE}/torch/lib/torch_cpu.dll`, `${SITE}/torch/__init__.py`,
    // Real packages other code imports (numpy.testing is imported by scipy, torch.testing by torch itself), not folders named tests.
    `${SITE}/torch/testing/_comparison.py`, `${SITE}/numpy/testing/__init__.py`, `${SITE}/sympy/testing/pytest.py`, `${SITE}/torch/_numpy/testing/utils.py`,
    // Names that only look alike.
    `${SITE}/pkg/contests/a.py`, `${SITE}/pkg/tests.py`, `${SITE}/pkg/mytests/a.py`, `${SITE}/pkg/test/a.py`, `${SITE}/ScriptsOther/a.dll`, `${SITE}/torch/binary/a.dll`,
    `${SITE}/tests/a.py`, 'Lib/tests/a.py', 'python312.dll', 'python312.zip', 'python312._pth', 'Lib/Scripts/a.dll']) {
    assert.equal(pythonPruned(rel), false, rel);
  }
  assert.deepEqual(PYTHON_PRUNE_RULES.map(rule => rule.id), ['sherpa-core-scripts', 'torch-bin', 'package-tests']);
});

test('the Pocket TTS rule ships the package and the licence of the pinned revision and nothing else', async () => {
  const list = parsePocketSourceList(await readFile(resolve(project, 'bridge/pocket_voice_runtime.py'), 'utf8'));
  const shipped = [...list.keys()].filter(pocketShipped);
  assert.equal(list.size, 140);
  assert.equal(shipped.length, 53);
  assert.deepEqual(shipped.filter(rel => rel !== 'LICENSE' && !rel.startsWith('pocket_tts/')), []);
  for (const rel of ['LICENSE', 'pocket_tts/__init__.py', 'pocket_tts/models/tts_model.py', 'pocket_tts/config/english.yaml', 'pocket_tts/static/index.html']) assert(shipped.includes(rel), rel);
  for (const rel of [...list.keys()].filter(rel => !shipped.includes(rel))) assert.match(rel, /^(?:tests|training|docs|scripts|\.github)\/|^[^/]+$/, rel);
  for (const rel of ['tests/test_audio.py', 'training/train.py', 'docs/index.md', '.github/workflows/run-tests.yml', 'scripts/generate_default_voices.py', 'Dockerfile',
    'deploy.sh', 'docker-compose.yaml', 'mkdocs.yml', 'swarm-config.yaml', 'uv.lock', 'pyproject.toml', 'README.md', 'AGENTS.md', 'CONTRIBUTING.md', '.gitignore']) {
    assert(list.has(rel), `${rel} is a file of the pinned revision`);
    assert.equal(pocketShipped(rel), false, rel);
  }
});

test('the build and the worker\'s own source check name the same Pocket files', async () => {
  const python = await readFile(resolve(project, 'bridge/pocket_voice_runtime.py'), 'utf8');
  assert.equal(new RegExp(`SOURCE_SHIPPED_PREFIX = "${POCKET_SHIPPED_PREFIX}"`).test(python), true);
  const files = /SOURCE_SHIPPED_FILES = \(([^)]*)\)/.exec(python)?.[1].split(',').map(part => part.trim().replace(/^"|"$/g, '')).filter(Boolean);
  assert.deepEqual(files, [...POCKET_SHIPPED_FILES]);
});

test('the Node rules leave out the browser install scripts and the TypeScript declarations only', () => {
  for (const [name, rel] of [['playwright-core', 'bin/install_media_pack.ps1'], ['playwright-core', 'bin/reinstall_msedge_stable_win.ps1'], ['playwright-core', 'bin/reinstall_chrome_beta_linux.sh'],
    ['playwright-core', 'types/types.d.ts'], ['playwright-core', 'index.d.ts'], ['playwright', 'types/test.d.ts'], ['playwright', 'test.d.ts']]) assert.equal(nodePackagePruned(name, rel), true, `${name}/${rel}`);
  for (const [name, rel] of [['playwright-core', 'index.js'], ['playwright-core', 'index.mjs'], ['playwright-core', 'package.json'], ['playwright-core', 'browsers.json'],
    ['playwright-core', 'lib/server/chromium/chromium.js'], ['playwright-core', 'lib/server/registry/index.js'], ['playwright', 'index.js'], ['playwright', 'lib/index.js'],
    ['playwright', 'bin/anything.sh'], ['playwright-core', 'lib/binary.js'], ['playwright-core', 'LICENSE']]) assert.equal(nodePackagePruned(name, rel), false, `${name}/${rel}`);
});

test('the declared removals name the old support report tool so a full install over an old Runtime cleans it up', async () => {
  const declared = JSON.parse(await readFile(resolve(project, DECLARED_REMOVALS), 'utf8')).removes;
  for (const rel of [`${PLUGIN}/Make support report.bat`, `${APP}/bridge/make-support-report.mjs`, `${APP}/bridge/offline-support-report.mjs`]) assert(declared.includes(rel), rel);
  assert.deepEqual(checkRemovals(declared).refused, []);
});

// An old Runtime with the files and a new one without them, as the update builder sees them.
async function makeZip(path, files) {
  const writer = await ZipWriter.create(path);
  for (const name of Object.keys(files).sort()) await writer.add(name, {buffer: Buffer.from(files[name])});
  await writer.close();
  return path;
}

test('a Runtime update carries every pruned path in its removal list and the start step deletes them, and nothing the voice or microphone loads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime prune test '));
  try {
    const kept = {
      [`${PY}/${SITE}/torch/lib/fbgemm.dll`]: 'fbgemm', [`${PY}/${SITE}/torch/lib/asmjit.dll`]: 'asmjit', [`${PY}/${SITE}/torch/__init__.py`]: 'torch',
      [`${PY}/${SITE}/torch/testing/_comparison.py`]: 'testing', [`${PY}/${SITE}/numpy/testing/__init__.py`]: 'numpy testing',
      [`${PY}/${SITE}/sherpa_onnx/lib/onnxruntime.dll`]: 'ort', [`${PY}/${SITE}/sherpa_onnx/lib/sherpa-onnx-c-api.dll`]: 'c api',
      [`${APP}/pocket-tts/LICENSE`]: 'MIT', [`${APP}/pocket-tts/pocket_tts/__init__.py`]: 'pocket', [`${APP}/pocket-tts/pocket_tts/config/english.yaml`]: 'a: 1',
      [`${APP}/node_modules/playwright-core/index.js`]: 'playwright', [`${APP}/bridge/convai-bridge.mjs`]: 'bridge',
      [RELEASE_ENTRY]: JSON.stringify({package: 'runtime', version: '0.2.8', game: '2.5'}), [`${APP}/${STEPS_DIR}/${BASE_FILE}`]: baseText('0.2.8')};
    const pruned = {
      [`${PY}/${SITE}/Scripts/onnxruntime.dll`]: 'ort', [`${PY}/${SITE}/Scripts/sherpa-onnx-c-api.dll`]: 'c api', [`${PY}/${SITE}/Scripts/sherpa-onnx-cxx-api.lib`]: 'cxx lib',
      [`${PY}/${SITE}/torch/bin/fbgemm.dll`]: 'fbgemm', [`${PY}/${SITE}/torch/bin/asmjit.dll`]: 'asmjit',
      [`${PY}/${SITE}/numpy/_core/tests/test_dtype.py`]: 't1', [`${PY}/${SITE}/scipy/special/tests/data/boost.npz`]: 't2', [`${PY}/${SITE}/sympy/core/tests/test_basic.py`]: 't3',
      [`${APP}/pocket-tts/tests/test_audio.py`]: 'p1', [`${APP}/pocket-tts/training/train.py`]: 'p2', [`${APP}/pocket-tts/docs/API Reference/python-api.md`]: 'p3',
      [`${APP}/pocket-tts/.github/workflows/run-tests.yml`]: 'p4', [`${APP}/pocket-tts/uv.lock`]: 'p5', [`${APP}/pocket-tts/Dockerfile`]: 'p6',
      [`${APP}/node_modules/playwright-core/bin/install_media_pack.ps1`]: 'n1', [`${APP}/node_modules/playwright-core/types/types.d.ts`]: 'n2'};
    // The new Runtime is the old one with the same rules the build applies.
    const next = {};
    for (const [name, text] of Object.entries({...kept, ...pruned})) {
      const rel = name.startsWith(`${PY}/`) ? name.slice(PY.length + 1) : null;
      const pocket = name.startsWith(`${APP}/pocket-tts/`) ? name.slice(`${APP}/pocket-tts/`.length) : null;
      const node = /^.*\/node_modules\/(playwright(?:-core)?)\/(.*)$/.exec(name);
      if ((rel && pythonPruned(rel)) || (pocket !== null && !pocketShipped(pocket)) || (node && nodePackagePruned(node[1], node[2]))) continue;
      next[name] = name === RELEASE_ENTRY ? JSON.stringify({package: 'runtime', version: '0.2.9', game: '2.5'}) : name.endsWith(`/${BASE_FILE}`) ? baseText('0.2.9') : text;
    }
    assert.deepEqual(Object.keys(next).filter(name => name in pruned), [], 'every pruned file is out of the new Runtime');
    assert.deepEqual(Object.keys(kept).filter(name => !(name in next)), [], 'no kept file is out of the new Runtime');
    const out = join(dir, 'out');
    const summary = await buildRuntimeUpdate({oldZips: [await makeZip(join(dir, 'old.zip'), {...kept, ...pruned})], newZips: [await makeZip(join(dir, 'new.zip'), next)],
      out, listing: null, log: quiet});
    assert.equal(summary.removals, Object.keys(pruned).length);
    assert.deepEqual(summary.leftInPlace, []);
    const zip = join(out, 'Runtime-Update-0.2.8-to-0.2.9.zip');
    const list = (await listZip(zip)).find(entry => entry.name === REMOVALS_ENTRY);
    await extractEntry(zip, list, join(dir, 'removals.json'));
    const removes = JSON.parse(await readFile(join(dir, 'removals.json'), 'utf8')).removes;
    assert.deepEqual([...removes].sort(), Object.keys(pruned).sort());
    // A player's folder with the old Runtime: the start step deletes exactly those files and the folders they leave empty.
    const game = join(dir, 'game');
    for (const [name, text] of Object.entries({...kept, ...pruned})) { await mkdir(dirname(join(game, name)), {recursive: true}); await writeFile(join(game, name), text); }
    await mkdir(join(game, APP, 'defaults'), {recursive: true});
    await writeFile(join(game, APP, 'defaults/runtime-removals.json'), JSON.stringify({version: '0.2.9', removes}));
    const result = applyRuntimeRemovals({appDirectory: join(game, APP), log: quiet});
    assert.deepEqual([result.state, result.removed, result.refused, result.failed, result.left], ['done', removes.length, 0, 0, 0]);
    for (const name of Object.keys(pruned)) await assert.rejects(stat(join(game, name)), name);
    for (const name of Object.keys(kept)) assert.equal((await stat(join(game, name))).isFile(), true, name);
    await assert.rejects(stat(join(game, PY, SITE, 'Scripts')), 'the emptied Scripts folder went too');
    await assert.rejects(stat(join(game, APP, 'pocket-tts/tests')), 'the emptied tests folder went too');
  } finally { await rm(dir, {recursive: true, force: true}); }
});
