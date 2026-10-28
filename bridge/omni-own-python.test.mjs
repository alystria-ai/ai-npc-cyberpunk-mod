import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {OWN_PYTHON_FILE, SELF_TEST_SOURCE, backendOf, ownPythonLine, ownPythonSummary, ownPythonVerdict, omniPriority, packagedOmniSource, parseOwnPythonText, parseRocmOptions,
  miopenWanted, readOwnPythonSetting, resolveOwnPython, rocmWorkerEnvironment, runOwnPythonSelfTest} from './omni-own-python.mjs';

// What the self-test prints for each kind of PC (no real GPU: these are the reports, as a ROCm, a CUDA and a CPU-only PyTorch answer).
const ROCM = {python: '3.12.10', torch: '2.14.0+rocm10.1.0', hip: '10.1.0', cuda: null, available: true, device: 'AMD Radeon RX 9070 XT', vramMiB: 16304, op: true, omnivoice: true};
const CUDA = {python: '3.11.9', torch: '2.8.0+cu128', hip: null, cuda: '12.8', available: true, device: 'NVIDIA GeForce RTX 4070', vramMiB: 12282, op: true, omnivoice: true};
const CPU = {python: '3.12.10', torch: '2.8.0+cpu', hip: null, cuda: null, available: false};
const windows = process.platform === 'win32';
const PY = windows ? 'C:\\Users\\Player\\omni-rocm\\.venv\\Scripts\\python.exe' : '/home/player/omni-rocm/.venv/bin/python';
const RUNTIME_PY = windows ? 'C:\\Game\\red4ext\\plugins\\AiNpcCyberpunkMod\\app\\omni\\python\\python.exe' : '/game/app/omni/python/python';

test('the backend is ROCm for a HIP build, CUDA for a CUDA build, and none when PyTorch sees no card', () => {
  assert.equal(backendOf(ROCM), 'rocm');
  assert.equal(backendOf(CUDA), 'cuda');
  assert.equal(backendOf(CPU), 'none');
  assert.equal(backendOf({...ROCM, available: false}), 'none', 'a ROCm build without a working card is no backend');
  assert.equal(backendOf(null), 'none');
});

test('a ROCm or CUDA Python that passed every step is usable, with its card memory read through PyTorch', () => {
  const rocm = ownPythonVerdict(ROCM);
  assert.equal(rocm.usable, true); assert.equal(rocm.backend, 'rocm'); assert.equal(rocm.reason, null);
  assert.equal(rocm.vramMiB, 16304); assert.equal(rocm.hip, '10.1.0'); assert.equal(rocm.device, 'AMD Radeon RX 9070 XT');
  const cuda = ownPythonVerdict(CUDA);
  assert.equal(cuda.usable, true); assert.equal(cuda.backend, 'cuda'); assert.equal(cuda.vramMiB, 12282);
});

test('each failed step refuses the Python with its own reason', () => {
  assert.equal(ownPythonVerdict({error: 'no-torch', python: '3.12.1'}).reason, 'no-torch');
  assert.equal(ownPythonVerdict(CPU).reason, 'no-gpu');
  assert.equal(ownPythonVerdict({...ROCM, op: false, detail: 'RuntimeError: HIP error: invalid device function'}).reason, 'op-failed');
  assert.match(ownPythonVerdict({...ROCM, op: false, detail: 'RuntimeError: HIP error'}).detail, /HIP error/);
  const missing = ownPythonVerdict({...ROCM, omnivoice: false, missing: 'transformers'});
  assert.equal(missing.reason, 'missing-module'); assert.equal(missing.module, 'transformers'); assert.equal(missing.usable, false);
  assert.equal(ownPythonVerdict({...ROCM, omnivoice: false}).reason, 'omnivoice-failed');
  for (const bad of [null, 'x', 7]) assert.equal(ownPythonVerdict(bad).reason, 'bad-output');
});

test('the file names one absolute python.exe; comments, quotes and blank lines are fine, anything else is refused', () => {
  assert.deepEqual(parseOwnPythonText(''), {path: null, problem: null});
  assert.deepEqual(parseOwnPythonText('# only a comment\n\n'), {path: null, problem: null});
  assert.deepEqual(parseOwnPythonText(`\uFEFF# my ROCm Python\n"${PY}"\n`), {path: PY, problem: null});
  assert.deepEqual(parseOwnPythonText(`  ${PY}  \r\nignored`), {path: PY, problem: null});
  assert.equal(parseOwnPythonText('python.exe').problem, 'not-absolute');
  assert.equal(parseOwnPythonText('.venv\\Scripts\\python.exe').problem, 'not-absolute');
  assert.equal(parseOwnPythonText(windows ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh').problem, 'not-python');
  if (windows) assert.equal(parseOwnPythonText('C:python.exe').problem, 'not-absolute', 'a drive-relative path is not absolute');
});

test('the setting is read from the data folder; no file is no override, a missing python.exe is refused', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'omni-own-python-'));
  try {
    assert.deepEqual(await readOwnPythonSetting({stateDirectory: folder}), {configured: false});
    await writeFile(join(folder, OWN_PYTHON_FILE), '# write the full path of your python.exe below\n');
    assert.deepEqual(await readOwnPythonSetting({stateDirectory: folder}), {configured: false});
    const missing = resolve(folder, 'nowhere', windows ? 'python.exe' : 'python');
    await writeFile(join(folder, OWN_PYTHON_FILE), missing + '\n');
    assert.deepEqual(await readOwnPythonSetting({stateDirectory: folder}), {configured: true, path: missing, problem: 'not-found'});
    await writeFile(join(folder, OWN_PYTHON_FILE), 'python\n');
    assert.deepEqual(await readOwnPythonSetting({stateDirectory: folder}), {configured: true, path: null, problem: 'not-absolute'});
    const there = resolve(folder, windows ? 'python.exe' : 'python');
    await writeFile(there, '');
    await writeFile(join(folder, OWN_PYTHON_FILE), there);
    assert.deepEqual(await readOwnPythonSetting({stateDirectory: folder}), {configured: true, path: there, problem: null});
  } finally { await rm(folder, {recursive: true, force: true}); }
});

// A stand-in child process: answers with `stdout` and closes, or never answers.
function fakeSpawn({stdout = '', hang = false, throws = false, error = false} = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    if (throws) throw Error('spawn EACCES');
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.killed = false; child.kill = () => { child.killed = true; };
    let input = '';
    child.stdin = {on() {}, end(text) { input = text; queueMicrotask(() => {
      if (error) { child.emit('error', Error('ENOENT')); return; }
      if (hang) return;
      child.stdout.emit('data', stdout); child.emit('close', 0);
    }); }};
    calls.push({command, args, options, child, get input() { return input; }});
    return child;
  };
  return {spawnImpl, calls};
}

test('the self-test runs the named python isolated, feeds the script on stdin and reads its marked line', async () => {
  const {spawnImpl, calls} = fakeSpawn({stdout: 'some library warning\n@@OMNI-SELFTEST@@' + JSON.stringify(ROCM) + '\n'});
  const report = await runOwnPythonSelfTest({python: PY, source: '/pack/omnivoice', spawnImpl});
  assert.deepEqual(report, ROCM);
  assert.equal(calls[0].command, PY);
  assert.deepEqual(calls[0].args, ['-I', '-', '/pack/omnivoice']);
  assert.equal(calls[0].input, SELF_TEST_SOURCE);
  assert.equal(calls[0].options.env.PYTHONNOUSERSITE, '1');
  assert.match(SELF_TEST_SOURCE, /torch\.version, 'hip'/, 'the script reads torch.version.hip');
  assert.match(SELF_TEST_SOURCE, /get_device_properties\(0\)/, 'the card memory comes from PyTorch, not nvidia-smi');
  assert.doesNotMatch(SELF_TEST_SOURCE, /nvidia-smi/);
});

test('a broken python path, a silent or a garbled self-test are refused, and a hung one is stopped', async () => {
  assert.deepEqual(await runOwnPythonSelfTest({python: PY, spawnImpl: fakeSpawn({throws: true}).spawnImpl}), {error: 'start-failed'});
  assert.deepEqual(await runOwnPythonSelfTest({python: PY, spawnImpl: fakeSpawn({error: true}).spawnImpl}), {error: 'start-failed'});
  assert.deepEqual(await runOwnPythonSelfTest({python: PY, spawnImpl: fakeSpawn({stdout: 'Traceback (most recent call last)\n'}).spawnImpl}), {error: 'bad-output'});
  assert.deepEqual(await runOwnPythonSelfTest({python: PY, spawnImpl: fakeSpawn({stdout: '@@OMNI-SELFTEST@@{nope\n'}).spawnImpl}), {error: 'bad-output'});
  const hung = fakeSpawn({hang: true});
  let fire;
  const pending = runOwnPythonSelfTest({python: PY, spawnImpl: hung.spawnImpl, setTimer: callback => { fire = callback; return {}; }, clearTimer: () => {}});
  await new Promise(done => setImmediate(done));
  fire();
  assert.deepEqual(await pending, {error: 'timed-out'});
  assert.equal(hung.calls[0].child.killed, true);
});

test('resolveOwnPython: no file changes nothing; ROCm, CUDA and CPU-only Pythons; a broken path; no pack', async () => {
  const exists = async () => true;
  const setting = value => async () => value;
  const run = (report, extra = {}) => resolveOwnPython({stateDirectory: 'x', runtimePython: RUNTIME_PY, readSetting: setting({configured: true, path: PY, problem: null}),
    selfTest: async ({python, source}) => { assert.equal(python, PY); assert.equal(source, packagedOmniSource(RUNTIME_PY)); return report; }, exists, ...extra});
  assert.deepEqual(await resolveOwnPython({readSetting: setting({configured: false}), selfTest: () => assert.fail('no self-test without the file')}), {configured: false});
  const rocm = await run(ROCM);
  assert.equal(rocm.used, true); assert.equal(rocm.backend, 'rocm'); assert.equal(rocm.path, PY); assert.equal(rocm.vramMiB, 16304);
  assert.equal(rocm.source, packagedOmniSource(RUNTIME_PY), 'OmniVoice\'s code comes from the pack');
  assert.match(packagedOmniSource(RUNTIME_PY), /omni[\\/]python[\\/]Lib[\\/]site-packages[\\/]omnivoice$/);
  const cuda = await run(CUDA);
  assert.equal(cuda.used, true); assert.equal(cuda.backend, 'cuda');
  const cpu = await run(CPU);
  assert.equal(cpu.used, false); assert.equal(cpu.backend, 'none'); assert.equal(cpu.reason, 'no-gpu'); assert.equal(cpu.source, null);
  assert.equal((await run({error: 'timed-out'})).reason, 'timed-out');
  const broken = await resolveOwnPython({readSetting: setting({configured: true, path: PY, problem: 'not-found'}), selfTest: () => assert.fail('no self-test of a missing file')});
  assert.deepEqual(broken, {configured: true, used: false, path: PY, backend: null, reason: 'not-found'});
  assert.equal((await run(ROCM, {packInstalled: false})).reason, 'no-pack');
  assert.equal((await run(ROCM, {exists: async () => false})).reason, 'no-pack', 'the pack\'s OmniVoice code must be there');
  assert.equal((await run(ROCM, {selfTest: async () => { throw Error('x'); }})).reason, 'start-failed');
});

test('the lines after the python.exe name the ROCm options; only three names and their values count, anything else is ignored', async () => {
  assert.deepEqual(parseOwnPythonText(`${PY}\nminiopen = on\n`), {path: PY, problem: null}, 'no known option: no options key');
  assert.deepEqual(parseOwnPythonText(`# mine\n${PY}\n# tuning\nmiopen-find-mode = normal\nmiopen: on\npriority=normal\n`),
    {path: PY, problem: null, options: {miopenFindMode: 'NORMAL', miopen: 'on', priority: 'normal'}});
  assert.deepEqual(parseRocmOptions(['miopen = maybe', 'priority = high', 'miopen-find-mode = a b', 'unknown = 1', 'priority = below']), {priority: 'below'});
  assert.deepEqual(parseRocmOptions(['miopen-find-mode = FAST; rm -rf', 'miopen-find-mode = ' + 'X'.repeat(30)]), {}, 'a value is a short plain word');
  assert.equal(parseOwnPythonText('priority = normal\n' + PY).problem, 'not-absolute', 'an option line never replaces the path');
  const folder = await mkdtemp(join(tmpdir(), 'omni-rocm-'));
  try {
    await writeFile(resolve(folder, OWN_PYTHON_FILE), `${PY}\nmiopen = on\n`);
    assert.deepEqual(await readOwnPythonSetting({stateDirectory: folder, isFile: async () => true}), {configured: true, path: PY, problem: null, options: {miopen: 'on'}});
    const used = await resolveOwnPython({readSetting: async () => ({configured: true, path: PY, problem: null, options: {miopen: 'on'}}), runtimePython: RUNTIME_PY,
      selfTest: async () => ROCM, exists: async () => true});
    assert.deepEqual(used.options, {miopen: 'on'}); assert.equal(used.used, true);
  } finally { await rm(folder, {recursive: true, force: true}); }
});

test('the ROCm worker environment: MIOpen on with find mode 2 and enforce 1 by default, off by the game setting, the file and the player own variables winning; the priority is not part of it', () => {
  const rocm = {used: true, backend: 'rocm'};
  const on = {CYBERPUNK_CONVAI_ROCM_MIOPEN: '1', MIOPEN_FIND_MODE: '2', MIOPEN_FIND_ENFORCE: '1'};
  assert.deepEqual(rocmWorkerEnvironment(rocm, {}), on);
  assert.deepEqual(rocmWorkerEnvironment(rocm, {}, {miopen: true}), on);
  assert.deepEqual(rocmWorkerEnvironment(rocm, {}, {miopen: false}), {CYBERPUNK_CONVAI_ROCM_MIOPEN: '0', MIOPEN_FIND_MODE: '2'}, 'the AMD-only choice off');
  assert.deepEqual(rocmWorkerEnvironment(rocm, {MIOPEN_FIND_MODE: 'NORMAL', MIOPEN_FIND_ENFORCE: '3'}), {CYBERPUNK_CONVAI_ROCM_MIOPEN: '1'}, 'a variable the player set is theirs');
  assert.deepEqual(rocmWorkerEnvironment({...rocm, options: {miopenFindMode: 'HYBRID', miopen: 'on', priority: 'normal'}}, {MIOPEN_FIND_MODE: 'FAST'}, {miopen: false}),
    {MIOPEN_FIND_MODE: 'HYBRID', CYBERPUNK_CONVAI_ROCM_MIOPEN: '1', MIOPEN_FIND_ENFORCE: '1'}, 'the file wins over the environment and the game setting');
  assert.deepEqual(rocmWorkerEnvironment({...rocm, options: {miopen: 'off'}}, {}, {miopen: true}), {CYBERPUNK_CONVAI_ROCM_MIOPEN: '0', MIOPEN_FIND_MODE: '2'});
  assert.equal(miopenWanted(rocm), true); assert.equal(miopenWanted(rocm, false), false); assert.equal(miopenWanted({options: {miopen: 'on'}}, false), true);
  for (const other of [null, {}, {used: false, backend: 'rocm'}, {used: true, backend: 'cuda'}, {used: true, backend: 'none'}]) {
    assert.deepEqual(rocmWorkerEnvironment(other, {}), {}, JSON.stringify(other));
    assert.deepEqual(rocmWorkerEnvironment(other, {}, {miopen: false}), {}, 'NVIDIA is never touched: ' + JSON.stringify(other));
  }
});

test('the OmniVoice worker priority: the omni-python.txt line (high, normal or below) wins, else the level for the PC, else high; the same on every backend', () => {
  assert.deepEqual(parseRocmOptions(['priority = high']), {priority: 'high'});
  assert.deepEqual(parseRocmOptions(['priority = normal']), {priority: 'normal'});
  assert.deepEqual(parseRocmOptions(['priority = realtime', 'priority = highest', 'priority = above']), {}, 'only high, normal and below; never realtime');
  assert.equal(omniPriority(null), 'high'); assert.equal(omniPriority(undefined, undefined), 'high');
  assert.equal(omniPriority({used: true, backend: 'rocm'}), 'high', 'the AMD route is no longer lowered');
  assert.equal(omniPriority({used: true, backend: 'cuda'}), 'high');
  assert.equal(omniPriority(null, 'normal'), 'normal'); assert.equal(omniPriority(null, 'below'), 'below'); assert.equal(omniPriority(null, 'realtime'), 'high');
  assert.equal(omniPriority({used: true, backend: 'rocm', options: {priority: 'normal'}}, 'high'), 'normal', 'the file line wins');
  assert.equal(omniPriority({used: true, backend: 'rocm', options: {priority: 'below'}}, 'high'), 'below');
  assert.equal(omniPriority({used: false, options: {priority: 'normal'}}, 'high'), 'high', 'a refused own Python file is ignored');
});

test('the log line names the backend and the refusal; the summary carries no folder', () => {
  const used = {configured: true, used: true, path: PY, ...ownPythonVerdict(ROCM)};
  assert.match(ownPythonLine(used), /own Python \(experimental\): PyTorch 2\.14\.0\+rocm10\.1\.0, ROCm\/HIP 10\.1\.0, AMD Radeon RX 9070 XT 16304 MiB/);
  assert.match(ownPythonLine({configured: true, used: false, ...ownPythonVerdict(CPU)}), /was not used \(no-gpu; backend: no GPU backend\)/);
  assert.match(ownPythonLine({configured: true, used: false, ...ownPythonVerdict({...ROCM, omnivoice: false, missing: 'einops'})}), /missing-module einops/);
  assert.match(ownPythonLine({configured: false}), /Runtime's Python/);
  const summary = ownPythonSummary(used);
  assert.deepEqual(Object.keys(summary).sort(), ['backend', 'cuda', 'device', 'hip', 'module', 'reason', 'torch', 'used', 'vramMiB']);
  assert.ok(!JSON.stringify(summary).includes('Player'), 'no folder of the PC');
  assert.equal(ownPythonSummary({configured: false}), null);
});
