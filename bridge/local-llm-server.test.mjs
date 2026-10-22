import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LlamaProcess, LocalLlmServer, LocalAiUnavailable, buildServerArgs, chooseTier, defaultCacheRamMiB, fillerText, isIntegratedGpu, parseDeviceList, tierNeedMiB,
  pickDevice, unavailableDetail, looksBlocked, BLOCKED, isAsciiPath, withoutKeyFile} from './local-llm-server.mjs';
import {SPILL_LIMITS} from './gpu-memory.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-llama-server.mjs', import.meta.url));
const DEVICES = `Available devices:
  Vulkan0: Intel(R) UHD Graphics (16000 MiB, 15000 MiB free)
  Vulkan1: NVIDIA GeForce RTX 4080 Laptop GPU (11997 MiB, 11229 MiB free)
`;
const exited = child => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit'));
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Polls until the check holds. The ceiling is generous on purpose: it is only reached when something is really stuck, so a busy machine (a
// fake llama-server is a whole node process to start) makes the wait longer, never the test fail.
async function until(check, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await sleep(15); }
  return false;
}

// A temp folder with stand-in pack files, and a server wired to the fake llama-server.
function harness(t, {standard = true, lite = true, env = {}, envFor, ...options} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'local-llm-test-'));
  const write = name => { const path = join(directory, name); writeFileSync(path, name); return path; };
  const pack = {installed: true, missing: [], root: directory, server: write('llama-server.exe'),
    tiers: {standard: standard ? {file: write('q4.gguf'), name: 'Qwen3.5-4B'} : null, lite: lite ? {file: write('q2.gguf'), name: 'Qwen3.5-2B'} : null},
    embed: {file: write('embed.gguf'), dim: 8, id: 'fake-embed'}, dev: false};
  const calls = [];
  const spawnImpl = (command, args, spawnOptions) => {
    const overlay = envFor ? envFor(calls.length) : {};
    const child = spawn(command, args, {...spawnOptions, env: {...spawnOptions.env, ...overlay}});
    calls.push({command, args, child});
    return child;
  };
  const fetched = [];
  const fetchImpl = (url, init) => { fetched.push(String(url)); return fetch(url, init); };
  const logs = [];
  const tmpDir = join(directory, 'tmp');
  mkdirSync(tmpDir);
  const server = new LocalLlmServer({pack, listDevices: async () => DEVICES, freeVramMiB: () => null, fileSizeMiB: () => 0, freeMemMiB: () => 32000, command: process.execPath,
    argsPrefix: [FAKE], spawnImpl, fetchImpl, log: line => logs.push(line), backoffMs: 10, startupMs: 180_000, warmup: false,
    processOptions: {env, tmpDir, pollMs: 20}, ...options});
  const failures = [];
  server.on('failed', event => failures.push(event));
  t.after(async () => {
    await server.stop();
    for (const {child} of calls) if (child.exitCode === null) child.kill();
    rmSync(directory, {recursive: true, force: true});
  });
  return {server, pack, calls, fetched, logs, failures, directory, tmpDir};
}

const stats = async info => (await fetch(new URL(info.endpoint).origin + '/__stats')).json();
const keyFolders = tmpDir => readdirSync(tmpDir).filter(name => name.startsWith('convai-llama-'));

test('buildServerArgs: the model, context, device and key file are arguments, and there is no key on the command line', () => {
  const args = buildServerArgs({model: 'M.gguf', port: 5123, keyFile: 'K', device: 'Vulkan1', contextSize: 4096});
  assert.deepEqual(args, ['-m', 'M.gguf', '-ngl', '99', '-fa', 'on', '-c', '4096', '-np', '1', '--reasoning', 'off', '--cache-ram', '1024',
    '--ctx-checkpoints', '32', '-fit', 'off', '--device', 'Vulkan1', '--no-webui', '--host', '127.0.0.1', '--port', '5123', '--api-key-file', 'K']);
  assert.ok(!args.includes('--api-key'));
  // -fit off is only safe because every size the fit pass would choose is given: layers, context and device.
  for (const flag of ['-ngl', '-c', '--device']) assert.ok(args.includes(flag), flag);
  assert.equal(buildServerArgs({model: 'M', port: 1, keyFile: 'K', device: 'V'})[7], '8192');
  assert.throws(() => buildServerArgs({model: 'M', port: 1, keyFile: 'K'}), TypeError);
});

test('device lines are parsed, integrated and software adapters are skipped, and the biggest discrete one wins', () => {
  const devices = parseDeviceList(DEVICES + 'noise line\n  Vulkan2: AMD Radeon RX 7600 (8176 MiB, 7000 MiB free)\n  Vulkan3: Radeon(TM) Graphics (512 MiB)\n');
  assert.deepEqual(devices.map(device => device.id), ['Vulkan0', 'Vulkan1', 'Vulkan2', 'Vulkan3']);
  assert.deepEqual(devices[1], {id: 'Vulkan1', name: 'NVIDIA GeForce RTX 4080 Laptop GPU', totalMiB: 11997, freeMiB: 11229});
  assert.equal(devices[3].freeMiB, null);
  assert.equal(pickDevice(devices).id, 'Vulkan1');
  assert.equal(pickDevice(devices.slice(2, 3)).id, 'Vulkan2');
  for (const name of ['Intel(R) UHD Graphics', 'Intel(R) Iris(R) Xe Graphics', 'Microsoft Basic Render Driver', 'llvmpipe (LLVM 15)', 'SwiftShader Device', 'Intel(R) Arc(TM) Graphics'])
    assert.equal(isIntegratedGpu(name), true, name);
  for (const name of ['Intel(R) Arc(TM) A770 Graphics', 'Intel(R) Arc(TM) B580 Graphics', 'NVIDIA GeForce RTX 3060', 'AMD Radeon RX 7900 XTX'])
    assert.equal(isIntegratedGpu(name), false, name);
  assert.equal(pickDevice(parseDeviceList('  Vulkan0: Intel(R) UHD Graphics (1024 MiB, 900 MiB free)\n  Vulkan1: llvmpipe (LLVM 15) (30000 MiB, 20000 MiB free)')), null);
  assert.equal(pickDevice([]), null);
});

test('the tier follows the free VRAM, and a forced tier needs its model', () => {
  const standard = {file: 'a'}; const lite = {file: 'b'};
  assert.equal(chooseTier({standard, lite, freeMiB: 3500}), 'standard');
  assert.equal(chooseTier({standard, lite, freeMiB: 3499}), 'lite');
  assert.equal(chooseTier({standard, lite, freeMiB: 2000}), 'lite');
  assert.throws(() => chooseTier({standard, lite, freeMiB: 1999}), error => error.reason === 'low-memory');
  assert.equal(chooseTier({standard: null, lite, freeMiB: 9000}), 'lite');
  assert.throws(() => chooseTier({standard, lite: null, freeMiB: 2500}), error => error.reason === 'low-memory');
  assert.equal(chooseTier({standard, lite, freeMiB: null}), 'lite');
  assert.equal(chooseTier({standard, lite: null, freeMiB: NaN}), 'standard');
  assert.equal(chooseTier({tier: 'standard', standard, lite, freeMiB: 100}), 'standard');
  assert.throws(() => chooseTier({tier: 'standard', standard: null, lite, freeMiB: 9000}), error => error.reason === 'not-installed');
  assert.throws(() => chooseTier({standard: null, lite: null, freeMiB: 9000}), error => error.reason === 'not-installed');
});

test('LocalAiUnavailable carries its reason and a marker', () => {
  const error = new LocalAiUnavailable('low-memory');
  assert.ok(error instanceof Error);
  assert.equal(error.reason, 'low-memory');
  assert.match(error.message, /^\[local:unavailable\]/);
});

test('ensure starts the server on the discrete GPU with the key in a file, and nothing secret shows in status or the command line', async t => {
  const {server, calls, tmpDir} = harness(t, {freeVramMiB: () => 9000});
  assert.deepEqual(server.status(), {state: 'stopped', tier: null, model: null});
  const events = [];
  server.on('state', event => events.push(event));
  const info = await server.ensure();
  assert.match(info.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/);
  assert.equal(info.tier, 'standard');
  assert.equal(info.model, 'Qwen3.5-4B');
  assert.match(info.apiKey, /^[0-9a-f]{64}$/);
  assert.deepEqual(server.status(), {state: 'ready', tier: 'standard', model: 'Qwen3.5-4B', contextSize: 16384});
  assert.equal(calls.length, 1);
  const args = calls[0].args;
  assert.ok(args.includes('--api-key-file'));
  assert.equal(args[args.indexOf('--device') + 1], 'Vulkan1');
  assert.ok(!args.join(' ').includes(info.apiKey), 'the key is not on the command line');
  // Nothing the host can see leaks the key or the port.
  const port = new URL(info.endpoint).port;
  const visible = JSON.stringify([server.status(), events]);
  assert.ok(!visible.includes(info.apiKey));
  assert.ok(!visible.includes(port));
  assert.deepEqual(events.map(event => event.state).filter((state, index, all) => state !== all[index - 1]), ['starting', 'warming', 'ready']);
  // The fake read the file at start (it exits otherwise), and it is deleted once the server is healthy.
  assert.deepEqual(keyFolders(tmpDir), []);
  const seen = await stats(info);
  assert.equal(seen.device, 'Vulkan1');
  assert.equal(seen.model, server.pack.tiers.standard.file);
  assert.equal(seen.embedding, false);
  // The key works: the right key is accepted and a wrong one is not.
  const ok = await fetch(info.endpoint, {method: 'POST', headers: {authorization: 'Bearer ' + info.apiKey, 'content-type': 'application/json'},
    body: JSON.stringify({messages: [{role: 'user', content: 'hello there'}], max_tokens: 1})});
  assert.equal(ok.status, 200);
  const wrong = await fetch(info.endpoint, {method: 'POST', headers: {authorization: 'Bearer nope'}, body: '{}'});
  assert.equal(wrong.status, 401);
});

// llama-server on Windows opens --api-key-file with a narrow call that cannot read a UTF-8 path (checked with b11560: "failed to open file" for
// C:\Users\<Cyrillic or Chinese name>\AppData\Local\Temp, and for accented letters too), so a player whose user name is not ASCII could never
// start Local AI. The key then travels in LLAMA_API_KEY.
test('a temporary folder that is not ASCII (a Windows user name with accents) takes the key in the environment and no file', async t => {
  const base = mkdtempSync(join(tmpdir(), 'local-llm-nonascii-'));
  t.after(() => rmSync(base, {recursive: true, force: true}));
  const unicodeTmp = join(base, '\u0418\u0432\u0430\u043d-J\u00fcrgen-\u4e2d\u6587');
  mkdirSync(unicodeTmp);
  const {server, calls} = harness(t, {freeVramMiB: () => 9000, processOptions: {env: {}, tmpDir: unicodeTmp, pollMs: 20, platform: 'win32'}});
  const info = await server.ensure();
  const args = calls[0].args;
  assert.ok(!args.includes('--api-key-file'), 'no key file argument');
  assert.ok(!args.join(' ').includes(info.apiKey), 'the key is not on the command line');
  assert.equal(args[args.indexOf('--port') + 1], new URL(info.endpoint).port, 'the rest of the command line is unchanged');
  assert.deepEqual(readdirSync(unicodeTmp), [], 'nothing was written to the non-ASCII folder');
  const ok = await fetch(info.endpoint, {method: 'POST', headers: {authorization: 'Bearer ' + info.apiKey, 'content-type': 'application/json'},
    body: JSON.stringify({messages: [{role: 'user', content: 'hello there'}], max_tokens: 1})});
  assert.equal(ok.status, 200);
  assert.equal((await fetch(info.endpoint, {method: 'POST', headers: {authorization: 'Bearer nope'}, body: '{}'})).status, 401);
});

test('an ASCII temporary folder on Windows keeps the key in a file, and a non-ASCII one is told apart', async t => {
  const {server, calls, tmpDir} = harness(t, {freeVramMiB: () => 9000, processOptions: {env: {}, pollMs: 20, platform: 'win32'}});
  void tmpDir;
  await server.ensure();
  assert.ok(calls[0].args.includes('--api-key-file'), 'the default (the system temp folder of this machine or the harness folder) is not changed when it is ASCII or the platform is not Windows');
  assert.equal(isAsciiPath('C:\\Users\\akshi\\AppData\\Local\\Temp'), true);
  assert.equal(isAsciiPath('C:\\Users\\J\u00fcrgen\\AppData\\Local\\Temp'), false);
  assert.equal(isAsciiPath('C:\\Users\\\u0418\u0432\u0430\u043d\\Temp'), false);
  assert.deepEqual(withoutKeyFile(['-m', 'M', '--api-key-file', 'K', '--port', '1']), ['-m', 'M', '--port', '1']);
});

test('without an injected device list, --list-devices of the server is parsed and the iGPU is skipped', async t => {
  const {server, calls} = harness(t, {listDevices: undefined});
  await server.ensure();
  assert.equal(calls[0].args[calls[0].args.indexOf('--device') + 1], 'Vulkan1');
  assert.equal(server.status().tier, 'standard');   // 11229 MiB free on the 4080
  // Unknown free memory chooses the lite tier.
  const unknown = harness(t, {listDevices: async () => 'Available devices:\n  Vulkan0: AMD Radeon RX 7600 (8176 MiB)\n'});
  assert.equal((await unknown.server.ensure()).tier, 'lite');
});

const spawnError = (code, message = 'spawn ' + code) => Object.assign(Error(message), {code, syscall: 'spawn'});

test('a listing of the graphics devices that fails is logged with its code and message, and tried once more', async t => {
  let tries = 0;
  const {server, calls, logs, failures} = harness(t, {deviceListRetryMs: 10, listDevices: async () => {
    if (++tries === 1) throw spawnError('UNKNOWN', 'spawn UNKNOWN');
    return DEVICES;
  }});
  const started = Date.now();
  await server.ensure();
  assert.equal(tries, 2);
  assert.equal(calls.length, 1, 'the model server started after the second listing');
  assert.equal(failures.length, 0);
  assert.ok(Date.now() - started >= 9, 'it waited before the second try');
  const line = logs.find(text => /could not list the graphics devices/.test(text));
  assert.match(line, /try 1 of 2\): code UNKNOWN: spawn UNKNOWN/);
  assert.match(line, /looks like Windows blocking the file/);
});

test('a listing that fails twice with a blocked-file error says Windows blocked a file, keeps it in the status, and never leaves Local AI', async t => {
  let tries = 0;
  const {server, calls, logs, failures} = harness(t, {deviceListRetryMs: 10, listDevices: async () => { tries++; throw spawnError('EPERM', 'spawn EPERM'); }});
  await assert.rejects(server.ensure(), error => error instanceof LocalAiUnavailable && error.reason === 'start-failed' && error.detail === BLOCKED);
  assert.equal(tries, 2, 'one retry, not more');
  assert.equal(calls.length, 0);
  assert.deepEqual(failures, [{reason: 'start-failed', detail: BLOCKED}]);
  assert.equal(server.status().detail, BLOCKED);
  assert.equal(logs.filter(text => /could not list the graphics devices \(try/.test(text)).length, 2);
  // The next turn is refused the same way, with the same words (the failure stays until reset(); there is no other provider to fall to).
  await assert.rejects(server.ensure(), error => error.reason === 'start-failed' && error.detail === BLOCKED);
  assert.match(unavailableDetail('start-failed', BLOCKED), /^Windows blocked a file of the model server \(Smart App Control or an Application Control policy\)/);
  assert.match(unavailableDetail('start-failed', BLOCKED), /^[ -~]+$/, 'printable ASCII only');
});

test('a listing that fails for another reason keeps the generic start failure, with the error in the log and without the folder', async t => {
  const {server, logs} = harness(t, {deviceListRetryMs: 10, listDevices: async () => { throw Object.assign(Error('Command failed: ' + process.execPath + ' --list-devices'), {code: 1}); }});
  await assert.rejects(server.ensure(), error => error.reason === 'start-failed' && error.detail === 'could not list the graphics devices');
  const line = logs.find(text => /could not list the graphics devices \(try 2 of 2\)/.test(text));
  assert.match(line, /code 1: Command failed:/);
  assert.ok(!line.includes(process.execPath), 'the folder of the executable is not logged');
  assert.ok(!/Windows blocking/.test(line));
});

test('looksBlocked: the spawn codes and the words of Smart App Control or an Application Control policy', () => {
  for (const code of ['UNKNOWN', 'EPERM', 'EACCES']) assert.equal(looksBlocked({code}), true, code);
  assert.equal(looksBlocked(Error('An Application Control policy has blocked this file.')), true);
  assert.equal(looksBlocked(Error('spawn UNKNOWN')), true);
  for (const error of [{code: 1}, {code: 'ENOENT'}, {code: 'ETIMEDOUT'}, Error('Command failed'), null, undefined]) assert.equal(looksBlocked(error), false, JSON.stringify(error));
});

test('the tier is chosen from the smaller of the device and nvidia-smi free memory', async t => {
  const high = harness(t, {freeVramMiB: () => 4000});
  assert.equal((await high.server.ensure()).tier, 'standard');
  const low = harness(t, {freeVramMiB: () => 3000});
  assert.equal((await low.server.ensure()).tier, 'lite');
  assert.equal(low.calls[0].args[low.calls[0].args.indexOf('-m') + 1], low.pack.tiers.lite.file);
  // nvidia-smi failing is ignored: the device's own figure (11229 MiB free) is used.
  const broken = harness(t, {freeVramMiB: async () => { throw Error('no nvidia-smi'); }});
  assert.equal((await broken.server.ensure()).tier, 'standard');
  // A non-NVIDIA device never asks nvidia-smi.
  let asked = false;
  const amd = harness(t, {listDevices: async () => 'Available devices:\n  Vulkan0: AMD Radeon RX 7600 (8176 MiB, 5000 MiB free)\n', freeVramMiB: () => { asked = true; return 100; }});
  assert.equal((await amd.server.ensure()).tier, 'standard');
  assert.equal(asked, false);
  // A forced tier skips the VRAM check.
  const forced = harness(t, {tier: 'standard', freeVramMiB: () => 300});
  assert.equal((await forced.server.ensure()).tier, 'standard');
  const noLite = harness(t, {tier: 'lite', lite: false});
  await assert.rejects(noLite.server.ensure(), error => error.reason === 'not-installed');
  assert.equal(noLite.calls.length, 0);
});

test('low memory, no discrete GPU and a missing pack fail without spawning, and emit failed once', async t => {
  // 1,500 MiB of graphics memory free: the smaller model goes on the card as far as it fits and runs the rest on the processor, which needs system memory; with none to spare it does not start.
  const low = harness(t, {freeVramMiB: () => 1500, freeMemMiB: () => 500});
  await assert.rejects(low.server.ensure(), error => error instanceof LocalAiUnavailable && error.reason === 'start-failed' && error.detail === 'low-ram');
  await assert.rejects(low.server.ensure(), error => error.reason === 'start-failed');
  assert.deepEqual(low.server.status(), {state: 'failed', reason: 'start-failed', detail: 'low-ram', tier: null, model: null});
  assert.deepEqual(low.failures, [{reason: 'start-failed', detail: 'low-ram'}]);
  assert.equal(low.calls.length, 0);
  // reset() allows another try, and it can now succeed.
  low.server.freeVramMiB = () => 6000; low.server.freeMemMiB = () => 32000;
  low.server.reset();
  assert.equal(low.server.status().state, 'stopped');
  assert.equal((await low.server.ensure()).tier, 'standard');

  const integrated = harness(t, {listDevices: async () => 'Available devices:\n  Vulkan0: Intel(R) Iris(R) Xe Graphics (8000 MiB, 7000 MiB free)\n'});
  await assert.rejects(integrated.server.ensure(), error => error.reason === 'no-gpu');
  assert.equal(integrated.calls.length, 0);
  assert.equal(integrated.failures.length, 1);

  const none = harness(t, {listDevices: async () => ''});
  await assert.rejects(none.server.ensure(), error => error.reason === 'no-gpu');

  const missing = harness(t);
  missing.server.pack = {...missing.pack, installed: false, missing: ['server']};
  await assert.rejects(missing.server.ensure(), error => error.reason === 'not-installed' && /\[local:unavailable\]/.test(error.message));
  assert.equal(missing.calls.length, 0);
  assert.equal(missing.failures.length, 1);
});

test('concurrent ensure calls share one start', async t => {
  const {server, calls} = harness(t, {env: {FAKE_LLAMA_DELAY_MS: '200'}, freeVramMiB: () => 9000});
  const [a, b, c] = await Promise.all([server.ensure(), server.ensure(), server.ensure()]);
  assert.equal(calls.length, 1);
  assert.equal(a.endpoint, b.endpoint);
  assert.equal(b.endpoint, c.endpoint);
  assert.equal(server.status().state, 'ready');
  // Ready already: no new start and an immediate answer.
  assert.equal((await server.ensure()).endpoint, a.endpoint);
  assert.equal(calls.length, 1);
  // An aborted caller does not cancel the shared start.
  const second = harness(t, {env: {FAKE_LLAMA_DELAY_MS: '200'}, freeVramMiB: () => 9000});
  const controller = new AbortController();
  const aborted = second.server.ensure({signal: controller.signal});
  const patient = second.server.ensure();
  controller.abort();
  await assert.rejects(aborted);
  assert.equal((await patient).tier, 'standard');
  assert.equal(second.calls.length, 1);
});

test('warm-up runs the bridge batch shapes the first time for a model file, and only a short request later', async t => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'local-llm-state-'));
  t.after(() => rmSync(stateDirectory, {recursive: true, force: true}));
  const stateFile = join(stateDirectory, 'local-ai-state.json');
  const first = harness(t, {warmup: true, stateFile, freeVramMiB: () => 9000});
  const statuses = [];
  first.server.on('state', event => statuses.push(event));
  const info = await first.server.ensure();
  assert.equal(first.server.status().firstTime, true);
  assert.ok(statuses.some(event => event.state === 'warming' && event.firstTime === true));
  const seen = (await stats(info)).requests;
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.map(request => request.maxTokens), [1, 1, 1]);
  assert.deepEqual(seen.map(request => request.stream), [false, false, false]);
  assert.ok(Math.abs(seen[0].promptChars - 4 * 512) < 100, String(seen[0].promptChars));
  assert.ok(Math.abs(seen[1].promptChars - 4 * 2048) < 100, String(seen[1].promptChars));
  assert.ok(seen[2].promptChars < 100);
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(saved.warmed[0].model, 'q4.gguf');
  assert.ok(saved.warmed[0].size > 0);
  assert.ok(saved.warmed[0].serverMtimeMs > 0);
  assert.ok(!readdirSync(stateDirectory).some(name => name.endsWith('.tmp')));
  assert.ok(!readFileSync(stateFile, 'utf8').includes(info.apiKey));
  await first.server.stop();

  // Same files, a new supervisor: only the short request.
  const later = harness(t, {warmup: true, stateFile, freeVramMiB: () => 9000, pack: first.pack});
  const laterInfo = await later.server.ensure();
  assert.equal(later.server.status().firstTime, undefined);
  assert.equal((await stats(laterInfo)).requests.length, 1);
  await later.server.stop();

  // A corrupt state file means the first time again; a different model file is a first time too.
  writeFileSync(stateFile, '{broken');
  const corrupt = harness(t, {warmup: true, stateFile, freeVramMiB: () => 9000, pack: first.pack});
  assert.equal((await stats(await corrupt.server.ensure())).requests.length, 3);
  await corrupt.server.stop();
  const lite = harness(t, {warmup: true, stateFile, freeVramMiB: () => 2500, pack: first.pack});
  const liteInfo = await lite.server.ensure();
  assert.equal(lite.server.status().firstTime, true);
  assert.equal((await stats(liteInfo)).requests.length, 3);
});

test('fillerText is about four characters per token', () => {
  assert.equal(fillerText(512).length, 2048);
  assert.equal(fillerText(0), '');
});

test('a failing warm-up request after a healthy start is not fatal', async t => {
  let failChat = true;
  const {server, logs} = harness(t, {warmup: true, freeVramMiB: () => 9000,
    fetchImpl: (url, init) => (failChat && String(url).includes('/v1/chat') ? Promise.reject(new TypeError('boom')) : fetch(url, init))});
  await server.ensure();
  assert.equal(server.status().state, 'ready');
  assert.ok(logs.some(line => line.includes('warm-up request failed')));
  failChat = false;
});

test('idle stop: the process ends after idleMs with no touch and no request in flight, and the next ensure restarts it', async t => {
  const timers = [];
  const setTimer = (fn, ms) => { const timer = {fn, ms, cleared: false, fired: false, unref() {}}; timers.push(timer); return timer; };
  const clearTimer = timer => { if (timer) timer.cleared = true; };
  const live = () => timers.filter(timer => timer.ms === 777 && !timer.cleared && !timer.fired);
  const fire = timer => { timer.fired = true; timer.fn(); };
  const {server, calls, fetched} = harness(t, {idleMs: 777, setTimer, clearTimer, freeVramMiB: () => 9000});
  await server.ensure();
  assert.equal(live().length, 1);
  const firstChild = calls[0].child;
  // No polling while ready.
  const requestsBefore = fetched.length;
  await sleep(250);
  assert.equal(fetched.length, requestsBefore);
  assert.equal(timers.filter(timer => !timer.cleared && !timer.fired).length, 1, 'only the idle timer is armed');
  // touch() restarts the countdown.
  const before = live()[0];
  server.touch();
  assert.equal(before.cleared, true);
  assert.equal(live().length, 1);
  // A request in flight blocks the stop, even if a stale timer fires.
  const release = server.begin();
  assert.equal(live().length, 0);
  fire(before);
  assert.equal(server.status().state, 'ready');
  release();
  release();   // one-shot
  assert.equal(server.inflight, 0);
  assert.equal(live().length, 1);
  fire(live()[0]);
  assert.equal(server.status().state, 'stopped');
  await exited(firstChild);
  assert.equal(isAlive(firstChild.pid), false);
  // The next ensure starts a fresh process.
  const info = await server.ensure();
  assert.equal(calls.length, 2);
  assert.equal(server.status().state, 'ready');
  assert.match(info.endpoint, /^http:/);
  assert.equal(live().length, 1);
});

test('a crash while ready restarts the server and callers wait for it', async t => {
  const {server, calls, failures} = harness(t, {freeVramMiB: () => 9000, envFor: index => (index === 0 ? {FAKE_LLAMA_CRASH_AFTER: '1'} : {})});
  const first = await server.ensure();
  assert.equal(await server.prewarm([{role: 'system', content: 'persona'}]), true);   // the fake dies after this answer
  assert.equal(await until(() => server.status().state !== 'ready'), true);
  const second = await server.ensure();
  assert.equal(calls.length, 2);
  assert.notEqual(second.endpoint, first.endpoint);
  assert.notEqual(second.apiKey, first.apiKey);
  assert.equal(server.status().state, 'ready');
  assert.deepEqual(failures, []);
});

test('repeated crashes end as failed (crashed), emitted once, until reset()', async t => {
  let mode = 'dying';
  const {server, calls, failures, logs} = harness(t, {freeVramMiB: () => 9000, maxRestarts: 2,
    envFor: index => (mode === 'good' ? {} : index === 0 ? {FAKE_LLAMA_CRASH_AFTER: '1'} : {FAKE_LLAMA_EXIT_AT_START: '3'})});
  await server.ensure();
  const gone = once(server, 'failed');
  await server.prewarm([{role: 'user', content: 'x'}]);
  const [event] = await gone;
  assert.deepEqual(event, {reason: 'crashed'});
  assert.equal(calls.length, 1 + 2);
  assert.deepEqual(server.status(), {state: 'failed', reason: 'crashed', tier: 'standard', model: 'Qwen3.5-4B'});
  await assert.rejects(server.ensure(), error => error instanceof LocalAiUnavailable && error.reason === 'crashed');
  await assert.rejects(server.ensure(), error => error.reason === 'crashed');
  assert.equal(await server.prewarm([{role: 'user', content: 'x'}]), false);
  assert.equal(calls.length, 3);
  assert.equal(failures.length, 1);
  assert.ok(logs.some(line => line.includes('restarting')));
  mode = 'good';
  server.reset();
  assert.equal((await server.ensure()).tier, 'standard');
  assert.equal(calls.length, 4);
  assert.equal(failures.length, 1);
});

test('a start that never becomes healthy, exits at once or has no exe is start-failed, once, and leaves nothing behind', async t => {
  const never = harness(t, {freeVramMiB: () => 9000, startupMs: 400, env: {FAKE_LLAMA_NEVER_HEALTHY: '1'}});
  await assert.rejects(never.server.ensure(), error => error.reason === 'start-failed');
  assert.equal(never.server.status().state, 'failed');
  assert.deepEqual(never.failures, [{reason: 'start-failed'}]);
  await exited(never.calls[0].child);
  assert.equal(isAlive(never.calls[0].child.pid), false, 'the unhealthy child was killed');
  assert.deepEqual(keyFolders(never.tmpDir), []);

  const exits = harness(t, {freeVramMiB: () => 9000, env: {FAKE_LLAMA_EXIT_AT_START: '9'}});
  await assert.rejects(exits.server.ensure(), error => error.reason === 'start-failed');
  assert.equal(exits.calls.length, 1);
  assert.deepEqual(exits.failures, [{reason: 'start-failed'}]);
  assert.deepEqual(keyFolders(exits.tmpDir), []);

  const noExe = harness(t, {freeVramMiB: () => 9000, command: join(never.directory, 'does-not-exist.exe'), argsPrefix: []});
  await assert.rejects(noExe.server.ensure(), error => error.reason === 'start-failed');
  assert.deepEqual(noExe.failures, [{reason: 'start-failed'}]);
  assert.deepEqual(keyFolders(noExe.tmpDir), []);
});

test('stop() kills the child, is idempotent, and killSync() works for exit handlers', async t => {
  const {server, calls, tmpDir} = harness(t, {freeVramMiB: () => 9000});
  await server.ensure();
  const child = calls[0].child;
  assert.equal(isAlive(child.pid), true);
  await server.stop();
  assert.equal(isAlive(child.pid), false);
  assert.equal(server.status().state, 'stopped');
  await server.stop();
  assert.deepEqual(keyFolders(tmpDir), []);
  // Restarts after a stop.
  await server.ensure();
  const second = calls[1].child;
  server.killSync();
  server.killSync();
  assert.equal(server.status().state, 'stopped');
  await exited(second);
  assert.equal(isAlive(second.pid), false);
  // stop() during a start cancels it without a failure.
  const starting = harness(t, {freeVramMiB: () => 9000, env: {FAKE_LLAMA_DELAY_MS: '1500'}});
  const pending = starting.server.ensure();
  await until(() => starting.calls.length === 1);
  await starting.server.stop();
  await assert.rejects(pending, error => error.reason === 'stopped');
  assert.equal(starting.failures.length, 0);
  assert.equal(isAlive(starting.calls[0].child.pid), false);
});

test('prewarm sends only the given messages as a one-token request, and never throws', async t => {
  const {server, calls} = harness(t, {freeVramMiB: () => 9000});
  assert.equal(await server.prewarm([{role: 'system', content: 'You are Judy.'}]), true);
  const info = await server.ensure();
  const request = (await stats(info)).requests.at(-1);
  assert.equal(request.maxTokens, 1);
  assert.equal(request.stream, false);
  assert.equal(request.messages, 1);
  assert.equal(request.promptChars, 'You are Judy.'.length);
  assert.equal(request.cachePrompt, true);
  assert.equal(calls.length, 1);
  const broken = harness(t, {freeVramMiB: () => 100, freeMemMiB: () => 200});
  assert.equal(await broken.server.prewarm([{role: 'user', content: 'x'}]), false);
});

test('LlamaProcess keeps the key in a private file during start, redacts it from the output tail, and removes it when healthy', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'llama-process-test-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const argLists = [];
  const proc = new LlamaProcess({command: process.execPath, argsPrefix: [FAKE], tmpDir: directory, pollMs: 20, startupMs: 60_000,
    env: {FAKE_LLAMA_DELAY_MS: '300', FAKE_LLAMA_PRINT_KEY: '1'},
    spawnImpl: (command, args, options) => { argLists.push(args); return spawn(command, args, options); },
    buildArgs: ({port, keyFile}) => ['--host', '127.0.0.1', '--port', String(port), '--api-key-file', keyFile, '-m', 'x.gguf']});
  t.after(() => proc.stop());
  const started = proc.start();
  assert.equal(proc.start(), started, 'single-flight');
  await until(() => keyFolders(directory).length === 1);
  const [folder] = keyFolders(directory);
  const keyPath = join(directory, folder, 'api-key');
  assert.equal(readFileSync(keyPath, 'utf8').trim(), proc.apiKey);
  assert.ok(!argLists[0].join(' ').includes(proc.apiKey));
  const {port, baseUrl} = await started;
  assert.equal(baseUrl, 'http://127.0.0.1:' + port);
  assert.equal(existsSync(keyPath), false);
  assert.deepEqual(keyFolders(directory), []);
  assert.equal(proc.running, true);
  assert.ok(proc.pid > 0);
  await until(() => proc.tail().includes('debug key='));
  assert.ok(proc.tail().includes('debug key=[redacted]'));
  assert.ok(!proc.tail().includes(proc.apiKey));
  assert.ok(!JSON.stringify(proc).includes(proc.apiKey));
  const stoppedEvent = once(proc, 'exit');
  await proc.stop();
  const [info] = await stoppedEvent;
  assert.equal(info.expected, true);
  assert.equal(proc.running, false);
  await proc.stop();
});

test('start errors never contain the key', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'llama-process-test-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const proc = new LlamaProcess({command: process.execPath, argsPrefix: [FAKE], tmpDir: directory, pollMs: 20, startupMs: 300,
    env: {FAKE_LLAMA_NEVER_HEALTHY: '1', FAKE_LLAMA_PRINT_KEY: '1'},
    buildArgs: ({port, keyFile}) => ['--port', String(port), '--api-key-file', keyFile]});
  await assert.rejects(proc.start(), error => {
    assert.equal(error.code, 'timeout');
    assert.ok(!error.message.includes(proc.apiKey));
    return true;
  });
  assert.ok(!proc.tail().includes(proc.apiKey));
  assert.deepEqual(keyFolders(directory), []);
});

test('tier thresholds come from the model file size when known (file + 1200 MiB standard, + 700 MiB lite)', () => {
  const standard = {file: 'g'}; const lite = {file: 'q'};
  const sizes = {standardSizeMiB: 4900, liteSizeMiB: 1250};   // Gemma 4 E4B q4_0 and Qwen3.5-2B
  assert.equal(chooseTier({standard, lite, freeMiB: 6100, ...sizes}), 'standard');
  assert.equal(chooseTier({standard, lite, freeMiB: 6099, ...sizes}), 'lite');
  assert.equal(chooseTier({standard, lite, freeMiB: 1950, ...sizes}), 'lite');
  assert.throws(() => chooseTier({standard, lite, freeMiB: 1949, ...sizes}), error => error.reason === 'low-memory');
  assert.equal(tierNeedMiB('standard', 0), 3500);
  assert.equal(tierNeedMiB('lite', undefined), 2000);
  assert.equal(chooseTier({standard, lite, freeMiB: 3600, standardSizeMiB: 0, liteSizeMiB: 1250}), 'standard');
});

test('--cache-ram follows an option, then the environment, then the free system RAM', async t => {
  assert.equal(buildServerArgs({model: 'M', port: 1, keyFile: 'K', device: 'V', cacheRamMiB: 4096})[13], '4096');
  assert.deepEqual([16 * 1024, 12 * 1024, 12 * 1024 - 1, 8 * 1024, 8 * 1024 - 1, 100].map(defaultCacheRamMiB), [4096, 4096, 2048, 2048, 1024, 1024]);
  const cacheArg = calls => calls[0].args[calls[0].args.indexOf('--cache-ram') + 1];
  const auto = harness(t, {freeMemMiB: () => 9000, freeVramMiB: () => 9000});
  await auto.server.ensure();
  assert.equal(cacheArg(auto.calls), '2048');
  const small = harness(t, {freeMemMiB: () => 4000, freeVramMiB: () => 9000});
  await small.server.ensure();
  assert.equal(cacheArg(small.calls), '1024');
  const byEnvironment = harness(t, {freeMemMiB: () => 20000, environment: {CYBERPUNK_CONVAI_LOCAL_CACHE_RAM: '512'}, freeVramMiB: () => 9000});
  await byEnvironment.server.ensure();
  assert.equal(cacheArg(byEnvironment.calls), '512');
  const byOption = harness(t, {cacheRamMiB: 3000, environment: {CYBERPUNK_CONVAI_LOCAL_CACHE_RAM: '512'}, freeVramMiB: () => 9000});
  await byOption.server.ensure();
  assert.equal(cacheArg(byOption.calls), '3000');
});

test('beforeStart is awaited before free VRAM is read, and a hook that never returns is capped', async t => {
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const {server} = harness(t, {freeVramMiB: () => { order.push('vram'); return 9000; }, beforeStart: async () => { order.push('hook'); await gate; order.push('hook-done'); }});
  const starting = server.ensure();
  await sleep(100);
  assert.deepEqual(order, ['hook']);
  assert.equal(server.status().state, 'starting');
  release();
  await starting;
  assert.deepEqual(order, ['hook', 'hook-done', 'vram']);

  const capped = harness(t, {freeVramMiB: () => 9000, beforeStartMs: 80, beforeStart: () => new Promise(() => {})});
  assert.equal((await capped.server.ensure()).tier, 'standard');
  const throwing = harness(t, {freeVramMiB: () => 9000, beforeStart: () => { throw Error('hook broke'); }});
  assert.equal((await throwing.server.ensure()).tier, 'standard');
});

// ---- The model choice (bridge/local-model-choice.mjs): which installed model loads, and a reload when the choice changes ----------
// Sizes by file name: standard 5280 MiB (needs 6480 free), lite 1311 (2011), a big uncensored model 5400 (6600), a small one 1400 (2100).
const CHOICE_SIZES = {'q4.gguf': 5280, 'q2.gguf': 1311, 'big-u.gguf': 5400, 'small-u.gguf': 1400};
function choiceHarness(t, {selected = {}, mature = true, freeMiB = 24000, ...options} = {}) {
  const state = {pin: 'auto', matureOn: false, matureModels: [], ...selected};
  const made = harness(t, {freeVramMiB: () => freeMiB, selection: () => state,
    fileSizeMiB: file => CHOICE_SIZES[String(file).split(/[\\/]/).pop()] ?? 0, ...options});
  if (mature) {
    for (const name of ['big-u.gguf', 'small-u.gguf']) writeFileSync(join(made.directory, name), name);
    state.matureModels = [{tier: 'lite', file: join(made.directory, 'small-u.gguf'), name: 'Qwen3.5-2B-Uncensored', family: 'qwen', present: true},
      {tier: 'good', file: join(made.directory, 'big-u.gguf'), name: 'Gemma-4-E4B-uncensored', family: 'gemma', present: true}];
  }
  const fallbacks = [];
  made.server.on('model-fallback', event => fallbacks.push(event));
  const loaded = () => made.calls.map(call => call.args[call.args.indexOf('-m') + 1].split(/[\\/]/).pop());
  return {...made, state, fallbacks, loaded};
}

test('the model follows the choice: auto, Mature content, a pin, a missing pin and a pin that does not fit', async t => {
  const auto = choiceHarness(t);
  const info = await auto.server.ensure();
  assert.deepEqual([info.model, auto.server.modelId, auto.loaded()], ['Qwen3.5-4B', 'standard', ['q4.gguf']]);

  const mature = choiceHarness(t, {selected: {matureOn: true}});
  assert.equal((await mature.server.ensure()).model, 'Gemma-4-E4B-uncensored');
  assert.deepEqual([mature.server.modelId, mature.loaded(), mature.server.status().tier], ['mature:good', ['big-u.gguf'], 'standard']);

  const matureOff = choiceHarness(t, {selected: {matureOn: false}});
  await matureOff.server.ensure();
  assert.deepEqual(matureOff.loaded(), ['q4.gguf'], 'an uncensored model is never picked with Mature content off');

  const noPack = choiceHarness(t, {selected: {matureOn: true}, mature: false});
  await noPack.server.ensure();
  assert.deepEqual(noPack.loaded(), ['q4.gguf'], 'Mature content on without the pack loads the ordinary model');

  const smallFits = choiceHarness(t, {selected: {matureOn: true}, freeMiB: 3000});
  await smallFits.server.ensure();
  assert.deepEqual([smallFits.loaded(), smallFits.server.status().tier], [['small-u.gguf'], 'lite']);

  const pinned = choiceHarness(t, {selected: {pin: 'lite'}});
  await pinned.server.ensure();
  assert.deepEqual([pinned.loaded(), pinned.fallbacks], [['q2.gguf'], []]);

  const pinnedUncensored = choiceHarness(t, {selected: {pin: 'mature:lite', matureOn: true}});
  assert.equal((await pinnedUncensored.server.ensure()).model, 'Qwen3.5-2B-Uncensored');
  // Mature content off: a pinned uncensored model is not loaded (the pin stays saved), the ordinary default is, with no notice.
  const pinnedOff = choiceHarness(t, {selected: {pin: 'mature:lite', matureOn: false}});
  assert.equal((await pinnedOff.server.ensure()).model, 'Qwen3.5-4B');
  assert.deepEqual([pinnedOff.loaded(), pinnedOff.fallbacks], [['q4.gguf'], []]);

  const missing = choiceHarness(t, {selected: {pin: 'mature:good'}, mature: false});
  await missing.server.ensure();
  assert.deepEqual([missing.loaded(), missing.fallbacks], [['q4.gguf'], [{pin: 'mature:good', reason: 'missing', model: 'Qwen3.5-4B'}]]);

  const tooBig = choiceHarness(t, {selected: {pin: 'standard'}, freeMiB: 3000});
  await tooBig.server.ensure();
  assert.deepEqual([tooBig.loaded(), tooBig.fallbacks], [['q2.gguf'], [{pin: 'standard', reason: 'low-memory', model: 'Qwen3.5-2B'}]], 'the notice names the model that was used');
  assert.ok(tooBig.logs.some(line => /not usable \(low-memory\)/.test(line)));

  // With Mature content on and an uncensored model installed, the fallback of a missing choice is the largest uncensored one that fits.
  // (A player's own model that is gone is announced; a saved id of a model that left the packs is not.)
  const missingMature = choiceHarness(t, {selected: {pin: 'custom:gone-model', matureOn: true}});
  await missingMature.server.ensure();
  assert.deepEqual([missingMature.loaded(), missingMature.fallbacks], [['big-u.gguf'], [{pin: 'custom:gone-model', reason: 'missing', model: 'Gemma-4-E4B-uncensored'}]]);
  const stale = choiceHarness(t, {selected: {pin: 'mature:qwen3.5-9b-uncensored-hauhaucs-aggressive-q4_k_m', matureOn: true}});
  await stale.server.ensure();
  assert.deepEqual([stale.loaded(), stale.fallbacks, stale.server.modelId], [['big-u.gguf'], [], 'mature:good'], 'a saved Mature model that is gone maps to mature:good silently');
  assert.ok(!stale.logs.some(line => /not usable/.test(line)));
  const staleTight = choiceHarness(t, {selected: {pin: 'mature:qwen3.5-9b-old', matureOn: true}, freeMiB: 3000});
  await staleTight.server.ensure();
  assert.deepEqual([staleTight.loaded(), staleTight.fallbacks], [['small-u.gguf'], []], 'good does not fit: mature:lite, still silent');
  const staleOff = choiceHarness(t, {selected: {pin: 'mature:qwen3.5-9b-old', matureOn: false}, freeMiB: 3000});
  await staleOff.server.ensure();
  assert.deepEqual([staleOff.loaded(), staleOff.fallbacks], [['q2.gguf'], []], 'Mature content off: never the uncensored model, the lite one fits and loads');

  // A legacy saved `auto` is no choice at all: the default model loads and nothing is announced.
  assert.deepEqual(auto.fallbacks, []);
  assert.ok(auto.server.lastFreeMiB > 0, 'the free memory the choice saw is kept for the settings page');
});

test('the older `tier` option still wins over a selection and is strict', async t => {
  const forced = choiceHarness(t, {tier: 'lite', selected: {pin: 'standard'}, freeMiB: 300});
  await forced.server.ensure();
  assert.deepEqual(forced.loaded(), ['q2.gguf']);
  const none = choiceHarness(t, {tier: 'standard', standard: false, mature: false});
  await assert.rejects(none.server.ensure(), error => error.reason === 'not-installed');
});

test('a changed choice reloads the model at an idle moment: the old server is stopped first, and nothing restarts mid-reply', async t => {
  const h = choiceHarness(t);
  await h.server.ensure();
  const first = h.calls[0].child;
  assert.equal(await h.server.reselect(), false, 'auto still satisfied');
  h.state.pin = 'standard';
  assert.equal(await h.server.reselect(), false, 'the pin is the loaded model');
  assert.equal(h.calls.length, 1);

  // A reply is in flight: the reload waits for it.
  const release = h.server.begin();
  h.state.pin = 'lite';
  assert.equal(await h.server.reselect(), false);
  await sleep(100);
  assert.equal(h.calls.length, 1); assert.equal(first.exitCode, null, 'the server stays up during a reply');
  release();
  assert.equal(await until(() => h.calls.length === 2 && h.server.status().state === 'ready'), true);
  assert.notEqual(first.exitCode ?? first.signalCode, null, 'the old server was stopped');
  assert.deepEqual(h.loaded(), ['q4.gguf', 'q2.gguf']);
  assert.equal(h.server.modelId, 'lite');

  // Mature content turned on with the pack: the loaded ordinary model no longer satisfies auto.
  h.state.pin = 'auto'; h.state.matureOn = true;
  assert.equal(await h.server.reselect(), true);
  assert.equal(await until(() => h.calls.length === 3 && h.server.status().state === 'ready'), true);
  assert.equal(h.server.modelId, 'mature:good');
  assert.equal(h.calls[1].child.exitCode !== null || h.calls[1].child.signalCode !== null, true);
});

test('Mature content turned off after an uncensored model was loaded and pinned: the standard model replaces it (reload), the pin stays saved, and back on it returns', async t => {
  // The Local AI standard pack and a Mature pack are both installed (the player's report: Mature off must not leave Local AI without a model).
  const h = choiceHarness(t, {selected: {pin: 'mature:good', matureOn: true}});
  assert.equal((await h.server.ensure()).model, 'Gemma-4-E4B-uncensored');
  h.state.matureOn = false;
  assert.equal(await h.server.reselect(), true, 'the loaded uncensored model does not satisfy Mature content off');
  assert.equal(await until(() => h.calls.length === 2 && h.server.status().state === 'ready'), true);
  assert.deepEqual([h.server.modelId, h.loaded(), h.state.pin, h.fallbacks], ['standard', ['big-u.gguf', 'q4.gguf'], 'mature:good', []]);
  assert.equal(await h.server.reselect(), false, 'and it is stable: no reload loop');
  h.state.matureOn = true;
  assert.equal(await h.server.reselect(), true);
  assert.equal(await until(() => h.calls.length === 3 && h.server.status().state === 'ready'), true);
  assert.equal(h.server.modelId, 'mature:good');
});

test('reselect does nothing while the server is stopped (the next start reads the choice itself), and a stop clears a queued reload', async t => {
  const h = choiceHarness(t);
  h.state.pin = 'lite';
  assert.equal(await h.server.reselect(), false);
  assert.equal(h.calls.length, 0);
  await h.server.ensure();
  assert.deepEqual(h.loaded(), ['q2.gguf']);
  const release = h.server.begin();
  h.state.pin = 'standard';
  await h.server.reselect();
  await h.server.stop();
  release();
  await sleep(100);
  assert.equal(h.calls.length, 1, 'a reload queued before a stop is dropped');
  h.state.pin = 'lite';
  assert.equal((await h.server.ensure()).model, 'Qwen3.5-2B');
});

// ---- Models the player added by hand (bridge/custom-models.mjs) ------------------------------------------------------------------
// Two custom models next to the built-in ones: 'my-model' (7000 MiB, auto, with a context size and a chat template) and 'odd-model' (2500 MiB,
// pinned only). FAKE_LLAMA_EXIT_FOR_MODEL makes the fake server refuse a file the way llama.cpp refuses an unsupported architecture.
const CUSTOM_SIZES = {...CHOICE_SIZES, 'my-model.gguf': 7000, 'odd-model.gguf': 2500, 'huge-model.gguf': 30000};
function customHarness(t, {selected = {}, freeMiB = 24000, env = {}, ...options} = {}) {
  const state = {pin: 'auto', matureOn: false, matureModels: [], customModels: [], ...selected};
  const made = harness(t, {freeVramMiB: () => freeMiB, selection: () => state, env,
    fileSizeMiB: file => CUSTOM_SIZES[String(file).split(/[\\/]/).pop()] ?? 0, ...options});
  const entry = (id, name, extra = {}) => {
    writeFileSync(join(made.directory, name), name);
    return {id: 'custom:' + id, name: id.toUpperCase(), file: join(made.directory, name), uncensored: false, auto: false, family: null,
      contextSize: null, chatTemplate: null, tooLarge: false, ...extra};
  };
  const fallbacks = [];
  made.server.on('model-fallback', event => fallbacks.push(event));
  const loaded = () => made.calls.map(call => call.args[call.args.indexOf('-m') + 1].split(/[\\/]/).pop());
  return {...made, state, entry, fallbacks, loaded};
}

test('a custom model starts with its own context size and chat template, and its manifest hints reach the Mature allowance', async t => {
  const h = customHarness(t, {selected: {pin: 'custom:my'}});
  h.state.customModels = [h.entry('my', 'my-model.gguf', {contextSize: 6144, chatTemplate: 'chatml', uncensored: true, family: 'llama'})];
  const info = await h.server.ensure();
  assert.deepEqual([info.model, h.server.modelId, h.loaded()], ['MY', 'custom:my', ['my-model.gguf']]);
  const args = h.calls[0].args;
  assert.deepEqual([args[args.indexOf('-c') + 1], args[args.indexOf('--chat-template') + 1], info.contextSize], ['6144', 'chatml', 6144]);
  assert.deepEqual(h.server.modelHints, {uncensored: true, family: 'llama'});
  // The same flags as the built-in models otherwise.
  for (const flag of ['-ngl', '-fa', '-np', '--reasoning', '--cache-ram', '-fit', '--device', '--no-webui', '--api-key-file']) assert.ok(args.includes(flag), flag);
  assert.ok(!args.join(' ').includes(info.apiKey));

  // A built-in model has no hints, no template and the usual context ladder.
  const plain = customHarness(t);
  await plain.server.ensure();
  assert.equal(plain.server.modelHints, null);
  assert.ok(!plain.calls[0].args.includes('--chat-template'));
  assert.equal(plain.calls[0].args[plain.calls[0].args.indexOf('-c') + 1], '16384');
  // A custom model without a context size takes the ladder.
  const ladder = customHarness(t, {selected: {pin: 'custom:odd'}});
  ladder.state.customModels = [ladder.entry('odd', 'odd-model.gguf')];
  await ladder.server.ensure();
  assert.equal(ladder.calls[0].args[ladder.calls[0].args.indexOf('-c') + 1], '16384');
  assert.ok(!ladder.calls[0].args.includes('--chat-template'));
});

test('a custom model takes part in the default choice by size, and is never chosen when it is too large for the card', async t => {
  const bigger = customHarness(t);
  bigger.state.customModels = [bigger.entry('my', 'my-model.gguf')];
  await bigger.server.ensure();
  assert.deepEqual([bigger.loaded(), bigger.server.modelId], [['my-model.gguf'], 'custom:my'], 'the largest model that fits, no flag needed');

  const flagIgnored = customHarness(t);
  flagIgnored.state.customModels = [flagIgnored.entry('my', 'my-model.gguf', {auto: false})];
  await flagIgnored.server.ensure();
  assert.deepEqual(flagIgnored.loaded(), ['my-model.gguf'], 'the obsolete auto flag changes nothing');

  const smaller = customHarness(t, {freeMiB: 6500});
  smaller.state.customModels = [smaller.entry('my', 'my-model.gguf')];
  await smaller.server.ensure();
  assert.deepEqual(smaller.loaded(), ['q4.gguf'], 'a custom model that does not fit the free memory is passed over');

  // The scan did not know the card; the device list did (11997 MiB): 30000 MiB of model can never fit.
  const huge = customHarness(t, {selected: {pin: 'custom:huge'}});
  huge.state.customModels = [huge.entry('huge', 'huge-model.gguf')];
  await huge.server.ensure();
  assert.deepEqual([huge.loaded(), huge.fallbacks], [['q4.gguf'], [{pin: 'custom:huge', reason: 'low-memory', model: 'Qwen3.5-4B'}]]);
  assert.equal(huge.server.totalVramMiB, 11997);
});

test('a custom model that fails to start is replaced by the default model with one notice naming it, and is not tried again until its file changes', async t => {
  const h = customHarness(t, {selected: {pin: 'custom:my'}, env: {FAKE_LLAMA_EXIT_FOR_MODEL: 'my-model'}});
  h.state.customModels = [h.entry('my', 'my-model.gguf')];
  const info = await h.server.ensure();
  assert.equal(info.model, 'Qwen3.5-4B', 'the built-in model answers');
  assert.deepEqual(h.loaded(), ['my-model.gguf', 'q4.gguf']);
  assert.deepEqual(h.fallbacks, [{pin: 'custom:my', reason: 'start-failed', model: 'Qwen3.5-4B'}], 'one notice, with the model used');
  assert.deepEqual(h.failures, [], 'not a failure of Local AI');
  assert.equal(h.server.modelId, 'standard');
  assert.ok(h.logs.some(line => /custom model "MY" did not start/.test(line)));

  // A later start (after the idle stop) goes straight to the fallback and says nothing more.
  await h.server.stop();
  await h.server.ensure();
  assert.deepEqual(h.loaded(), ['my-model.gguf', 'q4.gguf', 'q4.gguf']);
  assert.equal(h.fallbacks.length, 1);

  // A changed file gets another try; reset() too.
  CUSTOM_SIZES['my-model.gguf'] = 7001;
  t.after(() => { CUSTOM_SIZES['my-model.gguf'] = 7000; });
  await h.server.stop();
  await h.server.ensure();
  assert.deepEqual(h.loaded().slice(3), ['my-model.gguf', 'q4.gguf']);
  assert.equal(h.fallbacks.length, 2, 'it failed again, and said so again');
});

test('a custom model chosen by default that fails to start is skipped the same way; with no other model the failure is the usual one', async t => {
  const h = customHarness(t, {env: {FAKE_LLAMA_EXIT_FOR_MODEL: 'my-model'}});
  h.state.customModels = [h.entry('my', 'my-model.gguf')];
  assert.equal((await h.server.ensure()).model, 'Qwen3.5-4B');
  assert.deepEqual(h.fallbacks, [{pin: 'custom:my', reason: 'start-failed', model: 'Qwen3.5-4B'}]);

  const noOther = customHarness(t, {standard: false, lite: false, env: {FAKE_LLAMA_EXIT_FOR_MODEL: 'my-model'}});
  noOther.state.customModels = [noOther.entry('my', 'my-model.gguf')];
  await assert.rejects(noOther.server.ensure(), error => error instanceof LocalAiUnavailable);
});

test('buildServerArgs: an offloaded model gives no layer count and turns the fit pass on; every other start is unchanged', () => {
  const base = {model: 'm.gguf', port: 1, keyFile: 'k', device: 'Vulkan1'};
  const plain = buildServerArgs(base), offloaded = buildServerArgs({...base, offload: true});
  assert.equal(plain[plain.indexOf('-fit') + 1], 'off'); assert.ok(plain.includes('-ngl'));
  assert.equal(offloaded[offloaded.indexOf('-fit') + 1], 'on'); assert.ok(!offloaded.includes('-ngl'));
  assert.ok(offloaded.includes('-c') && offloaded.includes('--device'), 'the context and the device are still given');
  assert.deepEqual(buildServerArgs({...base, offload: false}), plain);
  // The game's room and the CPU threads belong to an offloaded load only: a model wholly on the card gets exactly the arguments it always had.
  assert.deepEqual(buildServerArgs({...base, fitTargetMiB: 1792, threads: 6}), plain);
  const placed = buildServerArgs({...base, offload: true, contextSize: 8192, kvType: 'q8_0', fitTargetMiB: 1792, threads: 6});
  assert.deepEqual([placed[placed.indexOf('-fit') + 1], placed[placed.indexOf('-fitt') + 1], placed[placed.indexOf('-t') + 1], placed[placed.indexOf('-c') + 1], placed[placed.indexOf('-ctk') + 1], placed[placed.indexOf('-ctv') + 1]],
    ['on', '1792', '6', '8192', 'q8_0', 'q8_0']);
  assert.ok(!placed.includes('-ngl'));
  assert.ok(!buildServerArgs({...base, offload: true}).includes('-fitt') && !buildServerArgs({...base, offload: true}).includes('-t'), 'no target and no threads given: llama-server defaults');
});

test('buildServerArgs: a whole-model load is byte-identical to what shipped before partial offload existed', () => {
  assert.deepEqual(buildServerArgs({model: 'm.gguf', port: 8081, keyFile: 'k', device: 'Vulkan1', contextSize: 16384, cacheRamMiB: 2048}),
    ['-m', 'm.gguf', '-ngl', '99', '-fa', 'on', '-c', '16384', '-np', '1', '--reasoning', 'off', '--cache-ram', '2048', '--ctx-checkpoints', '32', '-fit', 'off', '--device', 'Vulkan1', '--no-webui',
      '--host', '127.0.0.1', '--port', '8081', '--api-key-file', 'k']);
});

test('Mature content on never loads a censored model: a Mature model that does not fit whole is loaded with part of its layers on the CPU, in the offload placement, when enough of it can stay on the card', async t => {
  // Only the good model (5,400 MiB, 6,600 by the file-size rule) is installed; 5,500 MiB are free: no projection tool, so the file stands in (6,100 MiB): about half of the layers stay on the card.
  const tight = onlyGood(choiceHarness(t, {selected: {matureOn: true}, freeMiB: 5500}));
  const info = await tight.server.ensure();
  assert.deepEqual([info.model, tight.loaded(), tight.server.modelId, tight.fallbacks], ['Gemma-4-E4B-uncensored', ['big-u.gguf'], 'mature:good', []]);
  const args = tight.calls[0].args;
  assert.ok(!args.includes('-ngl'), 'no layer count: llama-server fits the layers to the memory');
  assert.deepEqual([argValue(tight.calls[0], '-fit'), argValue(tight.calls[0], '-fitt'), argValue(tight.calls[0], '-c'), argValue(tight.calls[0], '-ctk'), argValue(tight.calls[0], '-ctv')], ['on', '1792', '8192', 'q8_0', 'q8_0']);
  assert.ok(Number(argValue(tight.calls[0], '-t')) >= 2 && Number(argValue(tight.calls[0], '-t')) <= 6, 'the CPU threads are capped');
  assert.ok(tight.logs.some(line => /part of its layers on the CPU/.test(line) && /Mature content never uses a censored model/.test(line)));
  const line = tight.logs.find(entry => /partial offload:/.test(entry));
  assert.ok(/Gemma-4-E4B-uncensored, about 5\d% of its layers on the card \(estimated from the file, 6100 MiB at 8192 q8_0 against 5500 MiB free\), context 8192, q8_0 cache, fit target 1792 MiB kept free for the game, \d CPU threads/.test(line), line);
  assert.deepEqual([tight.server.diagnostics().engine.offloadPlan.fitTargetMiB, tight.server.diagnostics().model.offload], [1792, true]);
  // A pinned good model that does not fit with the lite one installed too: the lite model fits whole, so it is loaded plainly and the usual notice names it.
  const pinned = choiceHarness(t, {selected: {matureOn: true, pin: 'mature:good'}, freeMiB: 3000});
  await pinned.server.ensure();
  assert.deepEqual([pinned.loaded(), pinned.fallbacks], [['small-u.gguf'], [{pin: 'mature:good', reason: 'low-memory', model: 'Qwen3.5-2B-Uncensored'}]]);
  assert.ok(pinned.calls[0].args.includes('-ngl') && argValue(pinned.calls[0], '-fit') === 'off' && !pinned.calls[0].args.includes('-fitt') && !pinned.calls[0].args.includes('-t'));
  // Fits: the plain start (all layers on the card, fit pass off).
  const roomy = choiceHarness(t, {selected: {matureOn: true}, freeMiB: 3000});
  await roomy.server.ensure();
  assert.ok(roomy.calls[0].args.includes('-ngl') && roomy.calls[0].args[roomy.calls[0].args.indexOf('-fit') + 1] === 'off');
  // Mature content off with no room at all (1,000 MiB): an ordinary model is offloaded (the smallest), never an uncensored one; any share loads, here nearly none, and the player is told once.
  const off = choiceHarness(t, {selected: {matureOn: false}, freeMiB: 1000});
  const slow = [];
  off.server.on('offload-slow', event => slow.push(event));
  await off.server.ensure();
  assert.deepEqual(off.loaded(), ['q2.gguf']);
  assert.deepEqual([argValue(off.calls[0], '-fit'), argValue(off.calls[0], '-fitt'), argValue(off.calls[0], '-c')], ['on', '1792', '8192']);
  assert.deepEqual(slow.map(event => [event.id, event.share]), [['lite', 0]]);
  assert.ok(off.logs.some(line => /will run mostly on the processor: only about 0% of its layers fit the graphics card with 1792 MiB kept free for the game \(1000 MiB free\); replies will be slow \(a smaller model or the Custom provider is faster\)/.test(line)), off.logs.join('|'));
  assert.deepEqual(off.failures, []);
  // The processor's side is what stops a load: the part of the model that stays in system memory (its file and cache) must fit what is free.
  const noRam = choiceHarness(t, {selected: {matureOn: false}, freeMiB: 1000, freeMemMiB: () => 600});
  await assert.rejects(noRam.server.ensure(), error => error.reason === 'start-failed' && error.detail === 'low-ram');
  assert.deepEqual([noRam.calls.length, noRam.failures], [0, [{reason: 'start-failed', detail: 'low-ram'}]]);
  assert.ok(noRam.logs.some(line => /cannot run partly on the processor: about \d+ MiB of system memory are needed for its CPU part and cache, 600 MiB are free: close programs, or choose a smaller model in Settings, or use the Custom provider/.test(line)), noRam.logs.join('|'));
  assert.ok(unavailableDetail('start-failed', 'low-ram').includes('Custom provider') && !/cloud/i.test(unavailableDetail('start-failed', 'low-ram')));
  // A card with room for most of the model needs no warning, and the system memory it needs is only the part that stays on the processor (about 3,900 MiB here, 5,000 free).
  const half = onlyGood(choiceHarness(t, {selected: {matureOn: true}, freeMiB: 5500, freeMemMiB: () => 5000}));
  const quiet = [];
  half.server.on('offload-slow', event => quiet.push(event));
  await half.server.ensure();
  assert.deepEqual([half.calls.length, quiet.length], [1, 0], 'about half of the layers on the card: slow, but not mostly on the processor');
});

test('buildServerArgs adds --chat-template only when one is named', () => {
  const base = {model: 'm.gguf', port: 1, keyFile: 'k', device: 'Vulkan1'};
  assert.ok(!buildServerArgs(base).includes('--chat-template'));
  const args = buildServerArgs({...base, chatTemplate: 'llama3'});
  assert.equal(args[args.indexOf('--chat-template') + 1], 'llama3');
});

// ---- Stalled turns: step down to a smaller model (the game takes the graphics memory and the model is read at a crawl) ----------------------------------------------

// What the Mistral client throws for a local turn that stalled (bridge/mistral-client.mjs timeoutError): `slow`, and the stream's own reason.
const stalledTurn = (reason = 'prefill-stalled') => Object.assign(new Error('The local AI did not finish in time'), {slow: true, reason, provider: 'local'});
const stall = (server, reason) => server.noteTurn({ok: false, error: stalledTurn(reason), detail: 'stuck reading the prompt'});

function stepHarness(t, options) {
  const h = choiceHarness(t, options);
  const steps = [];
  h.server.on('model-stepdown', event => steps.push(event));
  return {...h, steps};
}

test('stalled turns step the model down: standard to lite after two stalls with no answer between, in memory only (the saved choice stays), and said once', async t => {
  const h = stepHarness(t, {mature: false, selected: {pin: 'standard'}});
  await h.server.ensure();
  assert.deepEqual(h.loaded(), ['q4.gguf']);
  // One stall is not enough, and an answered turn clears the count; a refused prompt or a model that was still loading is no stall.
  stall(h.server, 'no-response');
  h.server.noteTurn({ok: true, trace: {firstTokenMs: 400}});
  stall(h.server, 'no-first-token');
  h.server.noteTurn({ok: false, error: Object.assign(new Error('x'), {slow: true, reason: 'loading', provider: 'local'})});
  h.server.noteTurn({ok: false, error: Object.assign(new Error('x'), {slow: false, reason: 'prefill-stalled'})});
  h.server.noteTurn({ok: false, error: Object.assign(new Error('x'), {slow: true, reason: 'thinking-only'})});
  assert.deepEqual([h.steps.length, h.calls.length], [0, 1], 'nothing stepped down yet');
  stall(h.server, 'prefill-stalled');
  assert.equal(await until(() => h.steps.length > 0), true);
  const info = await h.server.ensure();
  assert.deepEqual([info.model, h.server.modelId, h.loaded()], ['Qwen3.5-2B', 'lite', ['q4.gguf', 'q2.gguf']]);
  assert.equal(h.steps.length, 1);
  assert.deepEqual([h.steps[0].model, h.fallbacks], ['Qwen3.5-2B', []], 'its own event, not the "chosen model is missing" fallback');
  assert.equal(h.state.pin, 'standard', 'the saved choice is never changed');
  assert.equal(await until(() => h.calls[0].child.exitCode !== null || h.calls[0].child.signalCode !== null), true, 'the stalled model was stopped, its graphics memory is free');
  assert.ok(h.logs.some(line => /stepping down from Qwen3.5-4B/.test(line) && /Qwen3.5-2B is the next smaller model/.test(line)));
  assert.deepEqual(h.server.diagnostics().steppedDown, ['standard']);
  // An idle stop and a new start keep the session's step (still lite, no second notice); a new choice or a new Local AI choice (reset) tries the whole choice again.
  await h.server.stop();
  assert.equal((await h.server.ensure()).model, 'Qwen3.5-2B');
  assert.equal(h.steps.length, 1);
  h.server.reset();
  await h.server.stop();
  assert.equal((await h.server.ensure()).model, 'Qwen3.5-4B');
});

test('stalled turns on the Mature family: mature:good steps down to mature:lite, never to a censored model, and with Mature lite stalled it is loaded with part of it on the CPU, where a further stall leaves it loaded', async t => {
  const h = stepHarness(t, {selected: {matureOn: true}});
  await h.server.ensure();
  assert.deepEqual([h.server.modelId, h.loaded()], ['mature:good', ['big-u.gguf']]);
  stall(h.server, 'no-response'); stall(h.server, 'no-response');
  assert.equal(await until(() => h.steps.length > 0), true);
  assert.equal((await h.server.ensure()).model, 'Qwen3.5-2B-Uncensored');
  assert.deepEqual([h.server.modelId, h.loaded(), h.steps.map(step => step.model)], ['mature:lite', ['big-u.gguf', 'small-u.gguf'], ['Qwen3.5-2B-Uncensored']]);
  assert.ok(!h.loaded().includes('q4.gguf') && !h.loaded().includes('q2.gguf'), 'a censored model never takes the place of an uncensored one');
  // The lite model stalls too: none is left in the family, so the same model is loaded with part of its layers on the CPU (it is never replaced by a censored one) ...
  stall(h.server, 'prefill-stalled'); stall(h.server, 'stalled');
  assert.equal(await until(() => h.calls.length === 3 && h.server.status().state === 'ready'), true);
  assert.deepEqual([h.loaded().at(-1), argValue(h.calls[2], '-fit'), argValue(h.calls[2], '-c'), h.steps.length, h.failures.length], ['small-u.gguf', 'on', '8192', 1, 0]);
  // ... and when that stalls once more it stays loaded: nothing smaller, nothing more to give up, and a slow answer is still an answer. No failure, no cloud event, no third server.
  stall(h.server, 'prefill-stalled');
  assert.equal(await until(() => h.logs.some(line => /already runs with part of its layers on the CPU; no smaller model is installed, so it stays loaded/.test(line))), true);
  assert.deepEqual([h.failures, h.steps.length, h.server.status().state, h.calls.length], [[], 1, 'ready', 3]);
  // Choosing Local AI again (reset) tries the whole choice from the top.
  await h.server.stop();
  h.server.reset();
  assert.equal((await h.server.ensure()).model, 'Gemma-4-E4B-uncensored');
});

test('a pinned model steps down inside its own family: the Mature good model (pinned, Mature content on) goes to Mature lite, not to the ordinary lite model', async t => {
  const h = stepHarness(t, {selected: {pin: 'mature:good', matureOn: true}});
  assert.equal((await h.server.ensure()).model, 'Gemma-4-E4B-uncensored');
  stall(h.server, 'no-first-token'); stall(h.server, 'no-first-token');
  assert.equal(await until(() => h.steps.length > 0), true);
  assert.equal((await h.server.ensure()).model, 'Qwen3.5-2B-Uncensored');
  assert.equal(h.state.pin, 'mature:good');
  assert.deepEqual(h.fallbacks, []);
});

test('with no smaller model installed the stalled model is loaded again with part of its layers on the CPU (no cloud event), and when that stalls too it stays loaded (slow, but it answers)', async t => {
  const h = stepHarness(t, {mature: false, lite: false});
  await h.server.ensure();
  assert.deepEqual(h.loaded(), ['q4.gguf']);
  stall(h.server, 'no-response'); stall(h.server, 'prefill-stalled');
  assert.equal(await until(() => h.calls.length === 2 && h.server.status().state === 'ready'), true);
  assert.deepEqual([h.loaded(), h.steps, h.failures, h.server.modelId], [['q4.gguf', 'q4.gguf'], [], [], 'standard']);
  assert.ok(h.logs.some(line => /no smaller model is installed, so the same model is loaded again with part of its layers on the CPU/.test(line)));
  const args = h.calls[1];
  assert.ok(!args.args.includes('-ngl'), 'the layers are fitted by llama-server');
  assert.deepEqual([argValue(args, '-fit'), argValue(args, '-fitt'), argValue(args, '-c'), argValue(args, '-ctk'), argValue(args, '-ctv')], ['on', '1792', '8192', 'q8_0', 'q8_0']);
  assert.ok(Number(argValue(args, '-t')) >= 2);
  assert.equal(await until(() => h.calls[0].child.exitCode !== null || h.calls[0].child.signalCode !== null), true, 'the whole-model server was stopped');
  assert.equal(h.server.diagnostics().model.offload, true);
  // It stalls once more: it already runs part on the CPU and nothing is smaller, so it stays loaded (a slow answer is still an answer); Local AI is not marked unavailable.
  stall(h.server, 'prefill-stalled');
  assert.equal(await until(() => h.logs.some(line => /already runs with part of its layers on the CPU; no smaller model is installed, so it stays loaded/.test(line))), true);
  await sleep(100);
  assert.deepEqual([h.steps, h.failures, h.server.status().state, h.calls.length], [[], [], 'ready', 2], 'no third server, no failure, no cloud event');
  assert.ok(unavailableDetail('low-memory', 'too-small').includes('Custom provider'));
});

test('a standard model with a lite one that does not fit the free memory now: the lite one is loaded mostly on the CPU (said once, no cloud event), and a model the player added never steps down on a stall', async t => {
  // The game filled the card: after the stalled model left, the lite one (needs 2011 MiB) has 1500 MiB.
  let free = 24000;
  const tight = stepHarness(t, {mature: false, freeMiB: 24000, freeVramMiB: () => free});
  const slow = [];
  tight.server.on('offload-slow', event => slow.push(event));
  await tight.server.ensure();
  free = 1500;
  stall(tight.server, 'no-response'); stall(tight.server, 'no-response');
  assert.equal(await until(() => tight.calls.length === 2 && tight.server.status().state === 'ready'), true);
  assert.deepEqual([tight.failures, tight.steps.map(step => step.model), slow.map(event => [event.id, event.share])], [[], ['Qwen3.5-2B'], [['lite', 0]]], 'a smaller model, mostly on the processor, and the player is told so');
  assert.deepEqual(tight.loaded(), ['q4.gguf', 'q2.gguf']);

  const custom = choiceHarness(t, {mature: false, selected: {pin: 'custom:mine', customModels: []}});
  const own = join(custom.directory, 'mine.gguf');
  writeFileSync(own, 'mine');
  custom.state.customModels = [{id: 'custom:mine', name: 'Mine', file: own, family: 'llama'}];
  assert.equal((await custom.server.ensure()).model, 'Mine');
  stall(custom.server, 'no-response'); stall(custom.server, 'no-response'); stall(custom.server, 'no-response');
  await sleep(150);
  assert.deepEqual([custom.calls.length, custom.server.status().state, custom.server.diagnostics().steppedDown], [1, 'ready', undefined], 'the player chose that model: it keeps running');
});

test('on a small card a model that leaves the game under 3000 MiB steps down at its first stall; on a larger card, or for a model that leaves room, it takes two', async t => {
  const small = `Available devices:
  Vulkan0: NVIDIA GeForce RTX 4060 (8188 MiB, 7600 MiB free)
`;
  // The Mature good model (5400 MiB and the standard headroom) on an 8 GB card: it cannot sit beside the game.
  const h = stepHarness(t, {selected: {pin: 'mature:good', matureOn: true}, listDevices: async () => small});
  assert.equal((await h.server.ensure()).model, 'Gemma-4-E4B-uncensored');
  stall(h.server, 'prefill-stalled');
  assert.equal(await until(() => h.steps.length > 0), true, 'one stall was enough');
  assert.equal((await h.server.ensure()).model, 'Qwen3.5-2B-Uncensored');
  assert.ok(h.logs.some(line => /stalled \(1 of 1\)/.test(line)));
  // The lite model (1400 MiB and the lite headroom) leaves the game 5000 MiB: it takes two stalls like anywhere.
  stall(h.server, 'prefill-stalled');
  await sleep(150);
  assert.deepEqual([h.steps.length, h.server.status().state], [1, 'ready'], 'the lite model on the same card needs two stalls');
  // A card of 12 GB: the good model takes two stalls.
  const big = stepHarness(t, {selected: {pin: 'mature:good', matureOn: true}});
  await big.server.ensure();
  stall(big.server, 'prefill-stalled');
  await sleep(150);
  assert.deepEqual([big.steps.length, big.calls.length], [0, 1]);
});

// ---- Free-memory fit (bridge/local-vram-fit.mjs) and spill (bridge/gpu-memory.mjs) ------------------------------------------------------------------------------
// llama-fit-params' projections of a Gemma 4 E4B model by context (16,384 / 8,192 / 8,192 with the 8-bit cache), measured 2026-10-20: the file-size rule says 6,600 MiB for the 5,400 MiB file, the projection 3,734.
const PROJECTED = {'big-u.gguf': {16384: 3734, 8192: 3598, q8: 3520}, 'q4.gguf': {16384: 3562, 8192: 3426, q8: 3348}, 'q2.gguf': {16384: 2228, 8192: 1964, q8: 1844}};
function fitHarness(t, {free = {value: 24000}, spill = null, clock = {now: 1_000_000}, probes = [], table = PROJECTED, ...options} = {}) {
  const fitProbe = async args => { probes.push(args); return table[String(args.model).split(/[\\/]/).pop()]?.[args.kvType ? 'q8' : args.contextSize] ?? null; };
  const gpuMemory = spill ? async () => spill.value : null;
  const h = stepHarness(t, {freeVramMiB: () => free.value, fitProbe, gpuMemory, now: () => clock.now, ...options});
  return {...h, free, probes, clock, spill};
}
const argValue = (call, flag) => call.args[call.args.indexOf(flag) + 1];
// A Mature pack with only its good model (the 2026-10-20 8 GB reports had no smaller model to fall back to): the pin that does not fit is loaded anyway.
const onlyGood = h => { h.state.matureModels = h.state.matureModels.filter(model => model.tier === 'good'); return h; };

test('a chosen Mature model that the file-size rule says does not fit, but whose projection does, is loaded whole on the card (no layers on the CPU), with the context and cache the free memory allows', async t => {
  // The 2026-10-20 reports: a 4070 SUPER with 4,789 MiB free, a 4080 with 3,208, an 8 GB card: the 5 GB model was loaded "part on the CPU" in 8,192 context.
  const roomy = fitHarness(t, {selected: {pin: 'mature:good', matureOn: true}, free: {value: 4789}});
  await roomy.server.ensure();
  assert.ok(roomy.calls[0].args.includes('-ngl') && argValue(roomy.calls[0], '-fit') === 'off', 'the whole model on the card: layers given, fit pass off');
  assert.equal(argValue(roomy.calls[0], '-c'), '16384');
  assert.ok(!roomy.calls[0].args.includes('-ctk'));
  assert.deepEqual(roomy.fallbacks, []);
  assert.ok(roomy.logs.some(line => /fit of Gemma-4-E4B-uncensored: projected 3734 MiB at 16384, 3598 MiB at 8192, 3520 MiB at 8192 q8_0 against 4789 MiB free/.test(line) && /the whole model fits: context 16384/.test(line)));
  assert.equal(roomy.server.diagnostics().engine.fit.pick.contextSize, 16384);
  // A little less room: the 8,192 context, then the 8-bit cache, then (nothing fits) the old way with layers on the CPU and the share the card can hold.
  const ctx = fitHarness(t, {selected: {pin: 'mature:good', matureOn: true}, free: {value: 4200}});
  await ctx.server.ensure();
  assert.deepEqual([argValue(ctx.calls[0], '-c'), ctx.calls[0].args.includes('-ctk'), argValue(ctx.calls[0], '-fit')], ['8192', false, 'off']);
  const q8 = fitHarness(t, {selected: {pin: 'mature:good', matureOn: true}, free: {value: 4100}});
  await q8.server.ensure();
  assert.deepEqual([argValue(q8.calls[0], '-c'), argValue(q8.calls[0], '-ctk'), argValue(q8.calls[0], '-ctv')], ['8192', 'q8_0', 'q8_0']);
  // No rung fits (3,520 and the 512 MiB margin need 4,032) but 3,900 MiB leave about 40% of the layers on the card beside 1,792 MiB for the game: the offload placement, 8,192 context, 8-bit cache.
  const none = onlyGood(fitHarness(t, {selected: {pin: 'mature:good', matureOn: true}, free: {value: 3900}}));
  await none.server.ensure();
  assert.ok(!none.calls[0].args.includes('-ngl') && argValue(none.calls[0], '-fit') === 'on', 'no rung fits: layers on the CPU');
  assert.deepEqual([argValue(none.calls[0], '-fitt'), argValue(none.calls[0], '-c'), argValue(none.calls[0], '-ctk')], ['1792', '8192', 'q8_0']);
  assert.ok(none.logs.some(line => /about 42% of the layers can stay on the card/.test(line)), none.logs.filter(line => /fit of/.test(line)).join('|'));
  assert.ok(/about 4\d% of the layers on the card/.test(none.logs.find(line => /model ready/.test(line))), none.logs.find(line => /model ready/.test(line)));
  assert.ok(none.logs.some(line => /partial offload: Gemma-4-E4B-uncensored, about 4\d% of its layers on the card \(projected 3520 MiB at 8192 q8_0 against 3900 MiB free\)/.test(line)), none.logs.filter(line => /partial/.test(line)).join('|'));
  assert.equal(none.probes.filter(probe => probe.contextSize === 8192 && probe.kvType === 'q8_0').length, 1, 'the projection of the offload placement is the one the fit already made: no second tool run');
  // 3,000 MiB leave 4% of the layers: it still loads (any share does, owner decision 2026-10-21), the player is told once that it runs mostly on the processor, and nothing names a cloud provider.
  const hopeless = onlyGood(fitHarness(t, {selected: {pin: 'mature:good', matureOn: true}, free: {value: 3000}}));
  const slow = [];
  hopeless.server.on('offload-slow', event => slow.push(event));
  await hopeless.server.ensure();
  assert.deepEqual([hopeless.calls.length, hopeless.failures, hopeless.steps.length, argValue(hopeless.calls[0], '-fit'), argValue(hopeless.calls[0], '-fitt'), argValue(hopeless.calls[0], '-c')], [1, [], 0, 'on', '1792', '8192']);
  assert.deepEqual(slow.map(event => [event.id, Math.round(event.share * 100)]), [['mature:good', 4]]);
  assert.ok(hopeless.logs.some(line => /will run mostly on the processor: only about 4% of its layers fit the graphics card.*a smaller model or the Custom provider is faster/.test(line) && !/cloud/i.test(line)), hopeless.logs.join('|'));
});

test('a pinned ordinary model whose projection fits is kept instead of replaced by the lite model; the default choice and a card with room take no probe at all', async t => {
  const pinned = fitHarness(t, {selected: {pin: 'standard'}, mature: false, free: {value: 4600}});
  await pinned.server.ensure();
  assert.deepEqual([pinned.loaded(), pinned.fallbacks], [['q4.gguf'], []], 'the player chose it and it fits whole: no "low-memory" fallback');
  assert.equal(argValue(pinned.calls[0], '-c'), '16384');
  // The default rule is unchanged: standard needs 6,480 by the file-size rule, so lite is taken, and nothing was probed.
  const auto = fitHarness(t, {mature: false, free: {value: 4600}});
  await auto.server.ensure();
  assert.deepEqual([auto.loaded(), auto.probes.length], [['q2.gguf'], 0]);
  // A card with room: the fit tool is never started.
  const roomy = fitHarness(t, {selected: {pin: 'mature:good', matureOn: true}, free: {value: 24000}});
  await roomy.server.ensure();
  assert.deepEqual([roomy.loaded(), roomy.probes.length], [['big-u.gguf'], 0]);
  // A missing fit tool or one that gives no number: the file-size rule alone, as before.
  const blind = onlyGood(choiceHarness(t, {selected: {pin: 'mature:good', matureOn: true}, freeMiB: 4789, fitProbe: async () => null}));
  await blind.server.ensure();
  assert.ok(!blind.calls[0].args.includes('-ngl') && argValue(blind.calls[0], '-fit') === 'on', 'the estimate from the file (6,100 MiB) leaves about 38% on the card: loaded part on the CPU');
});

test('buildServerArgs: the cache type is given only when the fit asked for it', () => {
  const base = {model: 'm.gguf', port: 1, keyFile: 'k', device: 'Vulkan1'};
  assert.ok(!buildServerArgs(base).includes('-ctk') && !buildServerArgs({...base, kvType: null}).includes('-ctv'));
  const args = buildServerArgs({...base, kvType: 'q8_0'});
  assert.deepEqual([args[args.indexOf('-ctk') + 1], args[args.indexOf('-ctv') + 1]], ['q8_0', 'q8_0']);
});

test('a model with almost none of its layers on the card (the 5 GB model on an 8 GB card with 123 to 314 MiB free) loads, says so once, and with nothing smaller stays loaded at its first stall; one with a good part of them takes two stalls', async t => {
  const hopeless = onlyGood(fitHarness(t, {selected: {pin: 'mature:good', matureOn: true}, free: {value: 300}}));
  const slow = [];
  hopeless.server.on('offload-slow', event => slow.push(event));
  await hopeless.server.ensure();
  assert.deepEqual([hopeless.calls.length, slow.length, slow[0]?.share], [1, 1, 0]);
  assert.deepEqual(hopeless.server.placement(), {offload: true, cpuBound: true}, 'where it runs, for the room the first turn is given to ask it');
  // Under 35% of the layers on the card one stall is enough to look for a smaller model; there is none (only the good model is installed), so the model stays loaded.
  stall(hopeless.server, 'prefill-stalled');
  assert.equal(await until(() => hopeless.logs.some(line => /stalled \(1 of 1\)/.test(line))), true, 'one stall was enough to look');
  assert.equal(await until(() => hopeless.logs.some(line => /so it stays loaded/.test(line))), true);
  assert.deepEqual([hopeless.calls.length, hopeless.failures, hopeless.steps.length, hopeless.server.status().state], [1, [], 0, 'ready']);
  // 3,900 MiB free: about 40% of the layers stay on the card: no warning, two stalls.
  const mostly = onlyGood(fitHarness(t, {selected: {pin: 'mature:good', matureOn: true}, free: {value: 3900}}));
  const quiet = [];
  mostly.server.on('offload-slow', event => quiet.push(event));
  await mostly.server.ensure();
  assert.deepEqual(mostly.server.placement(), {offload: true, cpuBound: false});
  stall(mostly.server, 'prefill-stalled');
  await sleep(150);
  assert.deepEqual([mostly.steps.length, mostly.calls.length, quiet.length], [0, 1, 0]);
});

test('a model loaded after a step-down that the card has no room for is loaded mostly on the CPU and said so (the 3060 Ti report: Gemma, then Qwen part on the CPU), and a stall there leaves it loaded; with room it takes two stalls', async t => {
  const small = `Available devices:
  Vulkan0: NVIDIA GeForce RTX 3060 Ti (8188 MiB, 7600 MiB free)
`;
  const free = {value: 7600};
  const h = fitHarness(t, {selected: {pin: 'mature:good', matureOn: true}, free, listDevices: async () => small});
  const slow = [];
  h.server.on('offload-slow', event => slow.push(event));
  assert.equal((await h.server.ensure()).model, 'Gemma-4-E4B-uncensored');
  free.value = 1500;                                       // the game took the card after the load
  stall(h.server, 'prefill-stalled');
  assert.equal(await until(() => h.calls.length === 2 && h.server.status().state === 'ready'), true, 'the oversize model steps down at its first stall; the smaller one has little room but loads');
  assert.deepEqual([h.failures, h.steps.map(step => step.model), h.loaded(), slow.map(event => event.id)], [[], ['Qwen3.5-2B-Uncensored'], ['big-u.gguf', 'small-u.gguf'], ['mature:lite']]);
  assert.ok(!h.calls[1].args.includes('-ngl') && argValue(h.calls[1], '-fit') === 'on');
  stall(h.server, 'prefill-stalled');
  assert.equal(await until(() => h.logs.some(line => /so it stays loaded/.test(line))), true, 'its first stall changes nothing: no smaller model, and it answers, slowly');
  assert.deepEqual([h.failures, h.server.status().state, h.calls.length], [[], 'ready', 2]);
  // The same on a card that leaves room for the lite model: whole on the card, two stalls as anywhere.
  const roomy = fitHarness(t, {selected: {pin: 'mature:good', matureOn: true}, free: {value: 7600}, listDevices: async () => small});
  await roomy.server.ensure();
  stall(roomy.server, 'prefill-stalled');
  assert.equal(await until(() => roomy.steps.length > 0), true);
  await roomy.server.ensure();
  stall(roomy.server, 'prefill-stalled');
  await sleep(150);
  assert.deepEqual([roomy.failures.length, roomy.server.status().state], [0, 'ready']);
});

test('a model that spilled into shared memory is unloaded and loaded again fitted to the memory that is free now, once; a second spill steps down; healthy counters and a recent reading do nothing', async t => {
  const spill = {value: {dedicatedMiB: 3200, sharedMiB: 95}};
  const h = fitHarness(t, {selected: {pin: 'standard'}, mature: false, spill});
  await h.server.ensure();
  assert.equal(argValue(h.calls[0], '-c'), '16384');
  const slow = {timings: {tokensPerSecond: 3.9, promptTokens: 2500}, pieces: 40};
  // Healthy counters on a slow reply: looked at, nothing done (a CPU-bound model is slow without being spilled).
  h.server.noteTurn({ok: true, trace: slow});
  await sleep(100);
  assert.deepEqual([h.calls.length, h.logs.filter(line => /graphics memory of the model server after a slow reply/.test(line)).length], [1, 1]);
  assert.equal(h.server.diagnostics().engine.spill.spilled, false);
  // Inside the rate limit nothing is read again.
  spill.value = {dedicatedMiB: 2200, sharedMiB: 1100};
  h.clock.now += 60_000;
  h.server.noteTurn({ok: true, trace: slow});
  await sleep(100);
  assert.equal(h.calls.length, 1, 'one reading in three minutes');
  // Spilled, the game left 4,500 MiB: the same model again, in the 8,192 context (3,426 and the 1,024 margin fit; 16,384 does not).
  h.clock.now += 200_000; h.free.value = 4500;
  h.server.noteTurn({ok: true, trace: slow});
  assert.equal(await until(() => h.calls.length === 2 && h.server.status().state === 'ready'), true);
  assert.deepEqual([h.loaded(), argValue(h.calls[1], '-c'), h.server.modelId], [['q4.gguf', 'q4.gguf'], '8192', 'standard']);
  assert.equal(h.steps.length, 0, 'no step-down, no notice: the same model');
  assert.ok(h.logs.some(line => /972 MiB in shared system memory \(the game took the graphics memory\): unloading it/.test(line)));
  assert.equal(await until(() => h.calls[0].child.exitCode !== null || h.calls[0].child.signalCode !== null), true, 'the spilled server was stopped');
  // The second spill of the same model steps down to lite.
  h.clock.now += 200_000;
  h.server.noteTurn({ok: true, trace: slow});
  assert.equal(await until(() => h.steps.length > 0), true);
  assert.equal((await h.server.ensure()).model, 'Qwen3.5-2B');
  assert.deepEqual(h.server.diagnostics().steppedDown, ['standard']);
});

test('a spill with no room for the model whole (the game holds the card) steps down at once, and a spill needs the counters: without them nothing changes', async t => {
  const spill = {value: {dedicatedMiB: 2200, sharedMiB: 1100}};
  const h = fitHarness(t, {selected: {pin: 'standard'}, mature: false, spill});
  await h.server.ensure();
  h.free.value = 3000;   // 3,426 + 1,024 does not fit, nor does any other rung
  h.server.noteTurn({ok: true, trace: {timings: {tokensPerSecond: 2.5}, pieces: 30}});
  assert.equal(await until(() => h.steps.length > 0), true);
  assert.equal((await h.server.ensure()).model, 'Qwen3.5-2B');
  // Not slow enough, or too short to tell: no reading.
  const quiet = fitHarness(t, {selected: {pin: 'standard'}, mature: false, spill});
  await quiet.server.ensure();
  quiet.server.noteTurn({ok: true, trace: {timings: {tokensPerSecond: 40}, pieces: 60}});
  quiet.server.noteTurn({ok: true, trace: {timings: {tokensPerSecond: 2}, pieces: 3}});
  await sleep(100);
  assert.ok(!quiet.logs.some(line => /graphics memory of the model server/.test(line)));
  // No counters (not Windows, or a failed read): a slow reply is only slow.
  const blind = fitHarness(t, {selected: {pin: 'standard'}, mature: false});
  await blind.server.ensure();
  blind.server.noteTurn({ok: true, trace: {timings: {tokensPerSecond: 2}, pieces: 40}});
  await sleep(100);
  assert.deepEqual([blind.calls.length, blind.steps.length], [1, 0]);
});

test('a spill with no smaller model (the 2026-10-21 8 GB RTX 4060 report: answered once, then low memory): the same model is loaded again with part of its layers on the CPU, in 8,192 context with the 8-bit cache and 1,792 MiB kept free for the game', async t => {
  const spill = {value: {dedicatedMiB: 2200, sharedMiB: 1100}};
  const free = {value: 4500};
  const h = fitHarness(t, {selected: {pin: 'standard'}, mature: false, lite: false, spill, free});
  await h.server.ensure();
  assert.equal(argValue(h.calls[0], '-c'), '16384');
  free.value = 3900;   // the game took more: 3,348 MiB projected plus the 1,024 MiB margin do not fit, a bit more than a third of the layers do
  h.server.noteTurn({ok: true, trace: {timings: {tokensPerSecond: 3, promptTokens: 2500}, pieces: 40}});
  assert.equal(await until(() => h.calls.length === 2 && h.server.status().state === 'ready'), true);
  const second = h.calls[1];
  assert.ok(!second.args.includes('-ngl'));
  assert.deepEqual([argValue(second, '-fit'), argValue(second, '-fitt'), argValue(second, '-c'), argValue(second, '-ctk'), argValue(second, '-ctv')], ['on', '1792', '8192', 'q8_0', 'q8_0']);
  assert.ok(Number(argValue(second, '-t')) >= 2 && Number(argValue(second, '-t')) <= 6);
  assert.deepEqual([h.loaded(), h.steps, h.failures, h.fallbacks, h.server.modelId], [['q4.gguf', 'q4.gguf'], [], [], [], 'standard'], 'the same model, no notice, nothing handed to a cloud provider');
  assert.ok(h.logs.some(line => /no smaller model is installed, so the same model is loaded again with part of its layers on the CPU/.test(line)));
  assert.ok(h.logs.some(line => /partial offload: Qwen3.5-4B, about 4\d% of its layers on the card \(projected 3348 MiB at 8192 q8_0 against 3900 MiB free\), context 8192, q8_0 cache, fit target 1792 MiB kept free for the game, \d CPU threads/.test(line)),
    h.logs.filter(line => /partial|fit of/.test(line)).join('|'));
  assert.deepEqual([h.server.diagnostics().engine.offloadPlan.fitTargetMiB, h.server.diagnostics().model.offload], [1792, true]);
  assert.equal(h.probes.filter(probe => probe.contextSize === 8192 && probe.kvType === 'q8_0').length >= 1, true);
  // The offloaded model spills again: it is loaded again the same way (at most three times a session), and then Local AI is unavailable (the card cannot hold it beside the game).
  for (let again = 2; again <= 3; again++) {
    h.clock.now += 200_000;
    h.server.noteTurn({ok: true, trace: {timings: {tokensPerSecond: 3, promptTokens: 2500}, pieces: 40}});
    assert.equal(await until(() => h.calls.length === again + 1 && h.server.status().state === 'ready'), true, 'reload ' + again);
  }
  h.clock.now += 200_000;
  h.server.noteTurn({ok: true, trace: {timings: {tokensPerSecond: 3, promptTokens: 2500}, pieces: 40}});
  assert.equal(await until(() => h.failures.length > 0), true);
  assert.deepEqual([h.failures, h.steps, h.calls.length], [[{reason: 'low-memory', detail: 'too-small'}], [], 4]);
});

test('a spill with no smaller model and too little of the card left (the game holds it): the same model is loaded mostly on the CPU, said once, no cloud event', async t => {
  const spill = {value: {dedicatedMiB: 2200, sharedMiB: 1100}};
  const free = {value: 4500};
  const h = fitHarness(t, {selected: {pin: 'standard'}, mature: false, lite: false, spill, free});
  const slow = [];
  h.server.on('offload-slow', event => slow.push(event));
  await h.server.ensure();
  free.value = 2800;   // (2,800 - 1,792 - 1,100) is nothing: the model would be on the CPU
  h.server.noteTurn({ok: true, trace: {timings: {tokensPerSecond: 3, promptTokens: 2500}, pieces: 40}});
  assert.equal(await until(() => h.calls.length === 2 && h.server.status().state === 'ready'), true);
  assert.deepEqual([h.failures, h.steps, h.server.status().state, slow.map(event => [event.id, event.share])], [[], [], 'ready', [['standard', 0]]]);
  assert.equal(await until(() => h.calls[0].child.exitCode !== null || h.calls[0].child.signalCode !== null), true, 'the spilled server was stopped');
  assert.equal(argValue(h.calls[1], '-fit'), 'on');
  // Not enough system memory for the part that stays on the processor: it is not started, and the reason says so.
  const poor = fitHarness(t, {selected: {pin: 'standard'}, mature: false, lite: false, spill, free: {value: 4500}, freeMemMiB: () => 32000});
  await poor.server.ensure();
  poor.free.value = 2800; poor.server.freeMemMiB = () => 1500;
  poor.server.noteTurn({ok: true, trace: {timings: {tokensPerSecond: 3, promptTokens: 2500}, pieces: 40}});
  assert.equal(await until(() => poor.failures.length > 0), true);
  assert.deepEqual([poor.failures, poor.steps, poor.calls.length], [[{reason: 'start-failed', detail: 'low-ram'}], [], 1]);
});

test('a spilled model the player added is fitted again like a pack model (it was left alone before), and with no placement on the card it runs mostly on the processor', async t => {
  const spill = {value: {dedicatedMiB: 2200, sharedMiB: 1100}};
  const free = {value: 24000};
  const sizes = {'mine.gguf': 4000};
  const table = {...PROJECTED, 'mine.gguf': {16384: 4600, 8192: 4400, q8: 4300}};
  const h = fitHarness(t, {mature: false, standard: false, lite: false, selected: {pin: 'custom:mine'}, spill, free, table, fileSizeMiB: file => { const name = String(file).split(/[\\/]/).pop(); return sizes[name] ?? CHOICE_SIZES[name] ?? 0; }});
  const own = join(h.directory, 'mine.gguf');
  writeFileSync(own, 'mine');
  h.state.customModels = [{id: 'custom:mine', name: 'Mine', file: own, family: 'llama'}];
  assert.equal((await h.server.ensure()).model, 'Mine');
  free.value = 5500;   // the game took the card: the 8,192 context and its 1,024 MiB margin fit (4,400 + 1,024), the 16,384 one does not
  h.server.noteTurn({ok: true, trace: {timings: {tokensPerSecond: 3, promptTokens: 2500}, pieces: 40}});
  assert.equal(await until(() => h.calls.length === 2 && h.server.status().state === 'ready'), true);
  assert.deepEqual([h.loaded(), argValue(h.calls[1], '-c'), h.calls[1].args.includes('-ngl')], [['mine.gguf', 'mine.gguf'], '8192', true], 'the same file, whole on the card in the smaller context');
  // It spills again with nothing smaller (a model the player added never steps down) and 3,000 MiB left: the same file is loaded mostly on the processor, said once.
  const slow = [];
  h.server.on('offload-slow', event => slow.push(event));
  free.value = 3000; h.clock.now += 200_000;
  h.server.noteTurn({ok: true, trace: {timings: {tokensPerSecond: 3, promptTokens: 2500}, pieces: 40}});
  assert.equal(await until(() => h.calls.length === 3 && h.server.status().state === 'ready'), true);
  assert.deepEqual([h.failures, h.steps.length, slow.map(event => event.id), argValue(h.calls[2], '-fit')], [[], 0, ['custom:mine'], 'on']);
});

test('a changed choice that would end on the model already loaded does not reload it, and still says the chosen model does not fit', async t => {
  // Mature good is loaded (24 GB free then). The player pins the standard model; 3,000 MiB are free now and our model holds 3,300, so the card has 6,300 without it: the standard model
  // does not fit by the file-size rule, and the Mature default is the loaded model, which fits whole by its projection.
  const spill = {value: {dedicatedMiB: 3300, sharedMiB: 90}};
  const {'q4.gguf': _standard, ...withoutStandard} = PROJECTED;   // no projection for the standard model: it does not fit by either rule
  const h = fitHarness(t, {selected: {matureOn: true}, spill, table: withoutStandard});
  await h.server.ensure();
  assert.equal(h.server.modelId, 'mature:good');
  h.free.value = 3000; h.state.pin = 'standard';
  assert.equal(await h.server.reselect(), false);
  assert.equal(h.calls.length, 1, 'no reload of the same 5 GB model');
  assert.deepEqual(h.fallbacks, [{pin: 'standard', reason: 'low-memory', model: 'Gemma-4-E4B-uncensored'}]);
  assert.ok(h.logs.some(line => /it stays loaded/.test(line)));
  // With room for the pinned model the reload happens.
  h.free.value = 24000;
  assert.equal(await h.server.reselect(), true);
  assert.equal(await until(() => h.calls.length === 2 && h.server.status().state === 'ready'), true);
  assert.equal(h.server.modelId, 'standard');
  // Without the counters the answer is unknown: it reloads as it always did.
  const blind = fitHarness(t, {selected: {matureOn: true}});
  await blind.server.ensure();
  blind.free.value = 3000; blind.state.pin = 'standard';
  assert.equal(await blind.server.reselect(), true);
});

test('stepDownNear: false until one stall has happened, true while one more would step down, false again after an answered turn', async t => {
  const h = stepHarness(t, {mature: false, selected: {pin: 'standard'}});
  await h.server.ensure();
  assert.equal(h.server.stepDownNear(), false);
  stall(h.server, 'no-response');
  assert.equal(h.server.stepDownNear(), true, 'the next stall steps down');
  h.server.noteTurn({ok: true, trace: {firstTokenMs: 400}});
  assert.equal(h.server.stepDownNear(), false);
});

// ---- A lost graphics device (Vulkan ErrorDeviceLost): llama-server stays alive and healthy, every request fails --------------------------------------------------------
// 2026-10-20 report: an RX 580 failed seven turns in a row, 50 to 100 ms each, until llama-server finally crashed. /health still answered, so recover() called it fine.

test('a lost graphics device restarts a server that still answers /health (the first loss); an ordinary failure still finds it fine', async t => {
  const h = stepHarness(t, {mature: false, selected: {pin: 'standard'}, deviceLostPauseMs: 10});
  const first = await h.server.ensure();
  assert.equal(await h.server.recover(), null, 'a healthy server is not restarted for an ordinary failure');
  assert.equal(h.calls.length, 1);
  const restarted = [];
  h.server.on('restarted', event => restarted.push(event));
  const next = await h.server.recover({deviceLost: true});
  assert.equal(h.calls.length, 2, 'a second llama-server was started');
  assert.notEqual(next.endpoint, first.endpoint);
  assert.notEqual(next.apiKey, first.apiKey);
  assert.equal(next.model, 'Qwen3.5-4B', 'the same model: the first loss only restarts');
  assert.equal(await until(() => h.calls[0].child.exitCode !== null || h.calls[0].child.signalCode !== null), true, 'the old server was ended');
  assert.equal(h.steps.length, 0);
  assert.equal(restarted.length, 1, 'the player is told once that Local AI was restarted (local-restarted)');
  assert.ok(h.logs.some(line => /graphics device was lost/.test(line)), h.logs.join('\n'));
});

test('the second lost device of a session steps the model down one size (its own notice); the count starts again for the smaller model', async t => {
  const h = stepHarness(t, {mature: false, selected: {pin: 'standard'}, deviceLostPauseMs: 10});
  await h.server.ensure();
  await h.server.recover({deviceLost: true});
  assert.equal(h.steps.length, 0);
  const stepped = await h.server.recover({deviceLost: true});
  assert.equal(stepped.model, 'Qwen3.5-2B');
  assert.deepEqual([h.loaded(), h.steps.length, h.steps[0].model], [['q4.gguf', 'q4.gguf', 'q2.gguf'], 1, 'Qwen3.5-2B']);
  assert.deepEqual(h.server.diagnostics().steppedDown, ['standard']);
  assert.equal(h.state.pin, 'standard', 'the saved choice is never changed');
  // The smaller model gets its own first restart, not an immediate second step.
  await h.server.recover({deviceLost: true});
  assert.equal(h.calls.length, 4);
  assert.equal(h.server.modelId, 'lite');
  assert.equal(h.steps.length, 1);
});

test('a lost device with no smaller model installed: the second loss loads the same model with part of it on the CPU, again after each pair of losses up to three times, then Local AI is unavailable (low-memory, too-small), and it never restarts in a loop', async t => {
  const h = stepHarness(t, {mature: false, lite: false, selected: {pin: 'standard'}, deviceLostPauseMs: 10});
  await h.server.ensure();
  const lose = () => h.server.recover({deviceLost: true});
  await lose();                                  // the first loss: a restart (server 2)
  const offloaded = await lose();                // the second: the same model, part on the CPU (server 3)
  assert.equal(offloaded.model, 'Qwen3.5-4B');
  assert.deepEqual([h.calls.length, h.steps.length, h.failures.length], [3, 0, 0]);
  assert.deepEqual([argValue(h.calls[2], '-fit'), argValue(h.calls[2], '-c'), argValue(h.calls[2], '-fitt')], ['on', '8192', '1792']);
  for (let round = 2; round <= 3; round++) { await lose(); await lose(); }   // a restart and a reload each round
  assert.equal(h.calls.length, 7);
  await lose();                                  // a restart, then the fourth pair: three reloads were enough
  await assert.rejects(lose(), error => error instanceof LocalAiUnavailable && error.reason === 'low-memory' && error.detail === 'too-small');
  assert.deepEqual([h.failures, h.steps.map(step => step.model)], [[{reason: 'low-memory', detail: 'too-small'}], []]);
  assert.equal(h.calls.length, 8, 'no ninth server');
  assert.equal(h.server.status().state, 'failed');
});

test('one server process counts once: a second report of the same loss (a turn that failed while the restart was starting) does nothing', async t => {
  const h = stepHarness(t, {mature: false, selected: {pin: 'standard'}, deviceLostPauseMs: 10});
  await h.server.ensure();
  const [one, two] = await Promise.all([h.server.noteDeviceLost('turn one'), h.server.noteDeviceLost('turn two')]);
  assert.deepEqual([one, two], ['restart', null]);
  await h.server.ensure();
  assert.equal(h.calls.length, 2);
  assert.equal(h.steps.length, 0);
});

test('the server\'s own log saying the device was lost is enough: recover() restarts it although the failed request\'s text did not say so', async t => {
  const h = stepHarness(t, {mature: false, selected: {pin: 'standard'}, deviceLostPauseMs: 10, envFor: index => (index === 0 ? {FAKE_LLAMA_DEVICE_LOST_FROM: '1'} : {})});
  const first = await h.server.ensure();
  const response = await fetch(first.endpoint, {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + first.apiKey},
    body: JSON.stringify({model: 'x', stream: false, messages: [{role: 'user', content: 'hi'}]})});
  assert.equal(response.status, 500);
  await sleep(300);   // the child's stderr reaches the supervisor's tail
  const next = await h.server.recover();
  assert.ok(next && next.endpoint !== first.endpoint, 'restarted on the log line alone');
  assert.equal(h.calls.length, 2);
});

// ---- 2026-10-21, round 3: a step-down race, and an early look for a spill --------------------------------------------------------------------------------------------------

test('a turn that comes while a spill is being acted on waits for the step and is answered by the smaller model: no start the step would cancel, no "stopped", Local AI stays up', async t => {
  const spill = {value: {dedicatedMiB: 2200, sharedMiB: 1100}};
  const free = {value: 24000};
  const gate = {on: false, open: null};
  gate.promise = new Promise(resolve => { gate.open = resolve; });
  // The free-memory read that #spillAct makes after it stopped the model is held, as it is for real while nvidia-smi runs.
  const h = fitHarness(t, {selected: {pin: 'standard'}, mature: false, spill, free, freeVramMiB: async () => { if (gate.on) await gate.promise; return free.value; }});
  await h.server.ensure();
  free.value = 3000;   // the game holds the card: the large model does not fit whole any more, so the step ends in a step-down
  gate.on = true;
  h.server.noteTurn({ok: true, trace: {timings: {tokensPerSecond: 3, promptTokens: 2500}, pieces: 40}});   // a slow reply: the counters are read, the model spilled
  assert.equal(await until(() => h.logs.some(line => /unloading it and loading it again fitted/.test(line))), true);
  await sleep(40);   // #spillAct is at its free-memory read; the model is stopped
  assert.equal(h.server.status().state, 'stopped');
  // The retried turn calls ensure() now. Before the fix it started the large model again here, and #stepDown's stop() cancelled that start: the turn failed with 'stopped'.
  const turn = h.server.ensure();
  await sleep(200);
  assert.deepEqual([h.calls.length, h.server.status().state], [1, 'stopped'], 'the large model was not started again while the step runs');
  gate.open();
  const handle = await turn;
  assert.equal(handle.model, 'Qwen3.5-2B');
  assert.deepEqual([h.loaded(), h.failures, h.server.status().state, h.steps.map(step => step.model)], [['q4.gguf', 'q2.gguf'], [], 'ready', ['Qwen3.5-2B']]);
});

test('ensure(): a start that a newer start took the place of is not a failure (the newer one is awaited), a plain stop still ends the wait with "stopped", and an aborted caller still stops waiting', async t => {
  const h = harness(t, {env: {FAKE_LLAMA_DELAY_MS: '500'}});
  const first = h.server.ensure();
  await sleep(100);
  const stopping = h.server.stop();   // a reload or a step-down: the start in flight is ended ...
  const second = h.server.ensure();   // ... and a newer one begins at once
  const [one, two] = await Promise.all([first, second]);
  await stopping;
  assert.equal(one.endpoint, two.endpoint, 'the first caller got the newer server');
  assert.equal(h.calls.length, 2);
  // Nothing started again: the caller's wait ends with 'stopped', and no server is begun on its behalf.
  await h.server.stop();
  const lone = h.server.ensure();
  await sleep(100);
  await h.server.stop();
  await assert.rejects(lone, error => error instanceof LocalAiUnavailable && error.reason === 'stopped');
  assert.equal(h.calls.length, 3);
  assert.equal(h.server.status().state, 'stopped');
  // A caller whose signal is aborted stops waiting whatever happens to the start.
  const controller = new AbortController();
  const aborted = h.server.ensure({signal: controller.signal});
  controller.abort();
  await assert.rejects(aborted, error => error.name === 'AbortError');
});

test('the memory counters are read once at the first request after each load (a persona warm-up or a turn), and not again while that load serves requests', async t => {
  const spill = {value: {dedicatedMiB: 3200, sharedMiB: 95}};
  const h = fitHarness(t, {selected: {pin: 'standard'}, mature: false, spill});
  const readings = () => h.logs.filter(line => /graphics memory of the model server after/.test(line));
  await h.server.ensure();
  assert.equal(readings().length, 0, 'nothing is read at the load itself');
  h.server.begin({background: true})();   // the persona warm-up of the character the player is about to talk to
  assert.equal(await until(() => readings().length === 1), true);
  assert.match(readings()[0], /after the first persona warm-up after the load: 3200 MiB on the card, 95 MiB in shared system memory$/);
  h.server.begin()(); h.server.begin()();
  await sleep(100);
  assert.equal(readings().length, 1, 'healthy and looked at: not again');
  // A new load is looked at again.
  await h.server.stop();
  await h.server.ensure();
  h.server.begin()();
  assert.equal(await until(() => readings().length === 2), true);
  assert.match(readings()[1], /after the first turn after the load/);
  // No counters (not Windows, no tool): nothing is read and nothing changes.
  const blind = fitHarness(t, {selected: {pin: 'standard'}, mature: false});
  await blind.server.ensure();
  blind.server.begin()();
  await sleep(100);
  assert.equal(blind.logs.filter(line => /graphics memory of the model server/.test(line)).length, 0);
});

test('a spill found at the first request after the load is acted on before the turn is lost to it: the same model is loaded again fitted, and its own first request is looked at too (then it steps down)', async t => {
  const spill = {value: {dedicatedMiB: 2200, sharedMiB: 1100}};
  const h = fitHarness(t, {selected: {pin: 'standard'}, mature: false, spill, free: {value: 4500}});
  await h.server.ensure();
  assert.equal(argValue(h.calls[0], '-c'), '16384');
  const turn = h.server.begin();   // the first turn: no slow reply, no stall yet
  assert.equal(await until(() => h.calls.length === 2 && h.server.status().state === 'ready'), true);
  turn();
  assert.equal(argValue(h.calls[1], '-c'), '8192', 'fitted to the 4,500 MiB that are free now');
  assert.ok(h.logs.some(line => /after the first turn after the load: 2200 MiB on the card, 1100 MiB in shared system memory \(spilled: 972 MiB/.test(line)), h.logs.join('\n'));
  // The load it made is looked at once as well; it spilled again, so the model steps down.
  h.server.begin()();
  assert.equal(await until(() => h.steps.length > 0), true);
  assert.equal((await h.server.ensure()).model, 'Qwen3.5-2B');
});

test('a turn with no answer after 10 s reads the counters once (not three minutes after the last reading: 20 s), and an answered turn never does', async t => {
  const timers = [];
  const setTimer = (callback, ms) => { if (ms === SPILL_LIMITS.noHeadersMs) { const entry = {callback, cleared: false}; timers.push(entry); return {entry, unref() {}}; } return setTimeout(callback, ms); };
  const clearTimer = handle => { if (handle?.entry) handle.entry.cleared = true; else clearTimeout(handle); };
  const spill = {value: {dedicatedMiB: 3200, sharedMiB: 95}};
  const h = fitHarness(t, {selected: {pin: 'standard'}, mature: false, spill, setTimer, clearTimer});
  const readings = () => h.logs.filter(line => /graphics memory of the model server after/.test(line));
  await h.server.ensure();
  // An answered turn: the headers come (noteHeaders) and the wait ends; the first request after the load was looked at (healthy).
  const answered = h.server.begin();
  assert.equal(await until(() => readings().length === 1), true);
  assert.equal(timers.length, 1);
  h.server.noteHeaders();
  assert.equal(timers[0].cleared, true, 'the wait for the headers ended');
  answered();
  // A turn with no answer: the timer fires. The model spilled meanwhile, but the last reading was a moment ago: the shorter limit holds first.
  const stuck = h.server.begin();
  assert.equal(timers.length, 2);
  spill.value = {dedicatedMiB: 2200, sharedMiB: 1100}; h.free.value = 4500;
  timers[1].callback();
  await sleep(100);
  assert.equal(readings().length, 1, 'read 0 s ago: not again');
  h.clock.now += 25_000;
  timers[1].callback();
  assert.equal(await until(() => h.calls.length === 2 && h.server.status().state === 'ready'), true);
  assert.equal(readings().length, 2);
  assert.match(readings()[1], /after no answer from the model server after 10 s/);
  stuck();
  // Not Windows / no counters: no timer is made at all.
  const blind = fitHarness(t, {selected: {pin: 'standard'}, mature: false, setTimer, clearTimer});
  await blind.server.ensure();
  const before = timers.length;
  blind.server.begin()();
  assert.equal(timers.length, before);
});

// ---- The game's room on a small card (2026-10-22, LordValerius's 0.2.7 report: an 8 GB RTX 3070, 7,461 MiB free at the service's start, the model loaded whole, then the game and OmniVoice took the card) ----------------------

const RTX3070 = 'Available devices:\n  Vulkan0: NVIDIA GeForce RTX 3070 (8232 MiB, 7461 MiB free)\n';
function roomHarness(t, {room = {}, listDevices = async () => RTX3070, free = {value: 7461}, ...options} = {}) {
  const gameRoom = {voiceMiB: () => 0, residentVoiceMiB: () => 0, ...room};
  return onlyGood(fitHarness(t, {selected: {matureOn: true}, free, listDevices, gameRoom, ...options}));
}

test('on an 8 GB card at the service start the model is placed against what is left after the game, with one plan line, instead of loaded whole and moved later', async t => {
  // Pocket on the CPU, no voice engine to load: 7,461 free - 4,528 for the game leaves 2,933 MiB, so about three quarters of the layers go on the card (projected 3,520 MiB at 8,192 with the 8-bit cache).
  const h = roomHarness(t);
  const slow = [];
  h.server.on('offload-slow', event => slow.push(event));
  await h.server.ensure();
  assert.ok(!h.calls[0].args.includes('-ngl') && argValue(h.calls[0], '-fit') === 'on', 'layers on the CPU from the first load');
  assert.deepEqual([argValue(h.calls[0], '-fitt'), argValue(h.calls[0], '-c'), argValue(h.calls[0], '-ctk')], ['4528', '8192', 'q8_0'], 'the game room is the fit target');
  const plan = h.logs.filter(line => line.includes('game room on a small card'));
  assert.equal(plan.length, 1, plan.join('|'));
  assert.ok(plan[0].includes('card 8232 MiB, 4528 MiB kept for the game, 7461 MiB free now, so 2933 MiB for the model: about 76% of its layers on the card'), plan[0]);
  assert.deepEqual(slow, [], 'three quarters on the card is no warning');
  assert.deepEqual(h.failures, []);
  // The same card, nothing else changed, with the room off (the bridge's option is absent): the model loads whole, as before.
  const before = onlyGood(fitHarness(t, {selected: {matureOn: true}, free: {value: 7461}, listDevices: async () => RTX3070}));
  await before.server.ensure();
  assert.ok(before.calls[0].args.includes('-ngl') && argValue(before.calls[0], '-fit') === 'off');
  assert.ok(!before.logs.some(line => line.includes('game room on a small card')));
});

test('a voice engine that is still to load takes its size out of the model\'s room, and OmniVoice plus the game on 8 GB leaves the model on the processor, said at the start', async t => {
  const h = roomHarness(t, {room: {voiceMiB: () => 2500}});
  const slow = [];
  h.server.on('offload-slow', event => slow.push(event));
  await h.server.ensure();
  const plan = h.logs.find(line => line.includes('game room on a small card'));
  assert.ok(plan.includes('2500 MiB for the voice engine still to load') && plan.includes('so 433 MiB for the model') && plan.includes('about 0% of its layers on the card'), plan);
  assert.deepEqual(slow.map(event => event.share), [0]);
  assert.deepEqual([argValue(h.calls[0], '-fit'), argValue(h.calls[0], '-fitt')], ['on', '4528']);
});

test('a card of 12 GB or less with room for both gets the whole model on the card; a larger card and an old service take the free memory as it is', async t => {
  // 11,997 MiB (the 4080 Laptop of the tests): 4,608 MiB for the game leaves 6,621 MiB, the model (3,734 at 16,384 plus the margin) fits whole.
  const big = roomHarness(t, {listDevices: async () => DEVICES, free: {value: 11229}});
  await big.server.ensure();
  assert.ok(big.calls[0].args.includes('-ngl') && argValue(big.calls[0], '-fit') === 'off' && argValue(big.calls[0], '-c') === '16384');
  const line = big.logs.find(text => text.includes('game room on a small card'));
  assert.ok(line.includes('4608 MiB kept for the game') && line.includes('all of its layers on the card'), line);
  // A card above 12 GB: no plan line at all.
  const huge = roomHarness(t, {listDevices: async () => 'Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4090 (24564 MiB, 23000 MiB free)\n', free: {value: 23000}});
  await huge.server.ensure();
  assert.ok(!huge.logs.some(text => text.includes('game room on a small card')) && huge.calls[0].args.includes('-ngl'));
});

const RTX3070_MIDPLAY = `Available devices:
  Vulkan0: NVIDIA GeForce RTX 3070 (8232 MiB, 3000 MiB free)
`;
test('a supervisor restart mid-play on an 8 GB card keeps back only what the game has not taken: the model gets a real share, not the processor alone (review A1)', async t => {
  // The game already holds about 4.2 GB: 3,000 MiB free, the model's room is 3,000 - 296 and the plan line says the game's room was mostly taken.
  const h = roomHarness(t, {listDevices: async () => RTX3070_MIDPLAY, free: {value: 3000}});
  const slow = [];
  h.server.on('offload-slow', event => slow.push(event));
  await h.server.ensure();
  const plan = h.logs.find(line => line.includes('game room on a small card'));
  assert.ok(plan.includes('296 MiB kept for the game') && plan.includes('so 2704 MiB for the model'), plan);
  assert.ok(!plan.includes('about 0% of its layers'), plan);
  assert.ok(Math.max(...slow.map(event => event.share), 1) > 0.15, 'not the processor alone');
  assert.deepEqual(h.failures, []);
});

test('a 12 GB card with OmniVoice already loaded and a quick Continue: the resident engine is not charged to the game, so the model gets its share (review A1)', async t => {
  const devices = `Available devices:
  Vulkan0: NVIDIA GeForce RTX 4080 Laptop GPU (11997 MiB, 4800 MiB free)
`;
  const quick = roomHarness(t, {listDevices: async () => devices, free: {value: 4800}, room: {residentVoiceMiB: () => 2500}});
  await quick.server.ensure();
  const plan = quick.logs.find(line => line.includes('game room on a small card'));
  assert.ok(plan.includes('911 MiB kept for the game') && plan.includes('so 3889 MiB for the model'), plan);
  // The same numbers before the fix left 192 MiB: nothing of the model fit.
  assert.ok(!plan.includes('so 192 MiB'));
});
