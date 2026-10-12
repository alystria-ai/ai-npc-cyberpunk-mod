import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LlamaProcess, LocalLlmServer, LocalAiUnavailable, buildServerArgs, chooseTier, defaultCacheRamMiB, fillerText, isIntegratedGpu, parseDeviceList, tierNeedMiB,
  pickDevice} from './local-llm-server.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-llama-server.mjs', import.meta.url));
const DEVICES = `Available devices:
  Vulkan0: Intel(R) UHD Graphics (16000 MiB, 15000 MiB free)
  Vulkan1: NVIDIA GeForce RTX 4080 Laptop GPU (11997 MiB, 11229 MiB free)
`;
const exited = child => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit'));
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
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
  const server = new LocalLlmServer({pack, listDevices: async () => DEVICES, freeVramMiB: () => null, fileSizeMiB: () => 0, command: process.execPath,
    argsPrefix: [FAKE], spawnImpl, fetchImpl, log: line => logs.push(line), backoffMs: 10, startupMs: 5000, warmup: false,
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
    '--ctx-checkpoints', '32', '--device', 'Vulkan1', '--no-webui', '--host', '127.0.0.1', '--port', '5123', '--api-key-file', 'K']);
  assert.ok(!args.includes('--api-key'));
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

test('without an injected device list, --list-devices of the server is parsed and the iGPU is skipped', async t => {
  const {server, calls} = harness(t, {listDevices: undefined});
  await server.ensure();
  assert.equal(calls[0].args[calls[0].args.indexOf('--device') + 1], 'Vulkan1');
  assert.equal(server.status().tier, 'standard');   // 11229 MiB free on the 4080
  // Unknown free memory chooses the lite tier.
  const unknown = harness(t, {listDevices: async () => 'Available devices:\n  Vulkan0: AMD Radeon RX 7600 (8176 MiB)\n'});
  assert.equal((await unknown.server.ensure()).tier, 'lite');
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
  const low = harness(t, {freeVramMiB: () => 1500});
  await assert.rejects(low.server.ensure(), error => error instanceof LocalAiUnavailable && error.reason === 'low-memory');
  await assert.rejects(low.server.ensure(), error => error.reason === 'low-memory');
  assert.deepEqual(low.server.status(), {state: 'failed', reason: 'low-memory', tier: null, model: null});
  assert.deepEqual(low.failures, [{reason: 'low-memory'}]);
  assert.equal(low.calls.length, 0);
  // reset() allows another try, and it can now succeed.
  low.server.freeVramMiB = () => 6000;
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
  const broken = harness(t, {freeVramMiB: () => 100});
  assert.equal(await broken.server.prewarm([{role: 'user', content: 'x'}]), false);
});

test('LlamaProcess keeps the key in a private file during start, redacts it from the output tail, and removes it when healthy', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'llama-process-test-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const argLists = [];
  const proc = new LlamaProcess({command: process.execPath, argsPrefix: [FAKE], tmpDir: directory, pollMs: 20, startupMs: 5000,
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
