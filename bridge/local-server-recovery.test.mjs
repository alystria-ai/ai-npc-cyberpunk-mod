// A local turn whose llama-server stops working while the turn is asked (bridge/local-server-recovery.mjs, LocalLlmServer.recover): the turn waits for the
// server to start again, within its own time, and asks once more at the new address; a server that cannot start again says why. The reports of 0.2.2
// had "could not be reached (ECONNREFUSED)" for a server that crashed with exit 3221226505 and was running again two minutes later.
// The server is the fake llama-server (bridge/fixtures/fake-llama-server.mjs): no model, no GPU, no game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MistralError, failureDetail, errorCodeFor, MIN_ATTEMPT_MS} from './mistral-client.mjs';
import {LocalLlmServer, LocalAiUnavailable, unavailableDetail} from './local-llm-server.mjs';
import {lostServer, deviceLost, survivingLoss} from './local-server-recovery.mjs';
import {TextProviderHost, localRoute, isLocalUnavailable} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {PersonaBook} from './mistral-prompt.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-llama-server.mjs', import.meta.url));
const DEVICES = 'Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4080 Laptop GPU (11997 MiB, 11229 MiB free)\n';

// ---- which failures a restarted server fixes ---------------------------------------------------------------------------------------

const failure = (message, extra = {}) => new MistralError('network', message, {provider: 'local', ...extra});

test('lostServer: a connection refused or a server fault with nothing of the reply written; not a timeout, a refused prompt, a partial reply or another provider', () => {
  assert.equal(lostServer(failure('could not be reached (ECONNREFUSED)')), true);
  assert.equal(lostServer(failure('could not be reached (ECONNRESET)', {trace: {pieces: 0}})), true);
  assert.equal(lostServer(failure('HTTP 500', {status: 500, slow: true})), true);
  assert.equal(lostServer(failure('HTTP 503', {status: 503, slow: true})), true);
  assert.equal(lostServer(failure('did not answer in time', {slow: true, reason: 'no-response', noRetry: true})), false, 'a wait is not repeated');
  assert.equal(lostServer(failure('went quiet', {reason: 'stalled', partial: true, trace: {pieces: 3}})), false, 'words of the reply were already written');
  assert.equal(lostServer(failure('cut by the turn\'s time', {deadline: true})), false);
  assert.equal(lostServer(failure('HTTP 400', {status: 400})), false);
  assert.equal(lostServer(new MistralError('network', 'could not be reached', {provider: 'mistral'})), false, 'only our own server');
  assert.equal(lostServer(new MistralError('request', 'prompt too large', {provider: 'local'})), false);
  assert.equal(lostServer(new Error('boom')), false);
});

// ---- the wrapper, with a scripted supervisor ----------------------------------------------------------------------------------------

const timed = (ms = 80_000) => ({deadlineAt: performance.now() + ms, now: () => performance.now()});

test('after a lost server the request is sent once more to the new address and key, and only once', async () => {
  const sent = [];
  const chat = async options => {
    sent.push({endpoint: options.endpoint, apiKey: options.apiKey});
    if (options.endpoint.includes(':1/')) throw failure('could not be reached (ECONNREFUSED)');
    return {text: 'back again'};
  };
  const logs = [];
  const asked = [];
  const server = {recover: async ({signal}) => { asked.push(signal); return {endpoint: 'http://127.0.0.1:2/v1/chat/completions', apiKey: 'newkey'}; }};
  const result = await survivingLoss(chat, {server, log: line => logs.push(line)})({endpoint: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'oldkey', ...timed()});
  assert.equal(result.text, 'back again');
  assert.deepEqual(sent.map(item => item.apiKey), ['oldkey', 'newkey']);
  assert.equal(asked.length, 1);
  assert.ok(logs.some(line => /was started again; asking once more/.test(line)), logs.join('\n'));
  // The second request fails too (the server died again): the turn fails with that error, no third request.
  let calls = 0;
  const dying = async () => { calls++; throw failure('could not be reached (ECONNREFUSED)'); };
  await assert.rejects(survivingLoss(dying, {server})({endpoint: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'a', ...timed()}), /ECONNREFUSED/);
  assert.equal(calls, 2);
});

test('the server answers (null from recover): the original failure stands; background work with no turn deadline never waits for a server; an aborted turn stays aborted', async () => {
  const original = failure('HTTP 500', {status: 500, slow: true});
  let recovers = 0;
  const server = {recover: async () => { recovers++; return null; }};
  const chat = async () => { throw original; };
  await assert.rejects(survivingLoss(chat, {server})({...timed()}), error => error === original);
  assert.equal(recovers, 1);
  await assert.rejects(survivingLoss(chat, {server})({}), error => error === original);
  assert.equal(recovers, 1, 'no deadline: not asked');
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(survivingLoss(chat, {server})({signal: stopped.signal, ...timed()}), error => error === original);
  assert.equal(recovers, 1);
  await assert.rejects(survivingLoss(chat, {server})({deadlineAt: performance.now() + MIN_ATTEMPT_MS - 1, now: () => performance.now()}), error => error === original, 'no time left to ask again');
  assert.equal(recovers, 1);
  const plain = {ensure: async () => ({})};
  assert.equal(survivingLoss(chat, {server: plain}), chat, 'a supervisor without recover (a stand-in) leaves the request alone');
});

test('a server that is not ready in the time that is left ends the turn with its own explanation; one that cannot start again passes its reason on', async () => {
  const chat = async () => { throw failure('could not be reached (ECONNREFUSED)'); };
  const slow = {recover: ({signal}) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))};
  const logs = [];
  const began = performance.now();
  const keepAlive = setInterval(() => {}, 1000);   // AbortSignal.timeout does not keep the process alive; the bridge always has something that does
  const error = await survivingLoss(chat, {server: slow, log: line => logs.push(line)})({deadlineAt: performance.now() + MIN_ATTEMPT_MS + 120, now: () => performance.now()}).catch(e => e);
  clearInterval(keepAlive);
  assert.ok(performance.now() - began < 5000);
  assert.ok(error instanceof MistralError);
  assert.equal(error.reason, 'restarting'); assert.equal(error.noRetry, true); assert.equal(error.kind, 'network');
  assert.match(failureDetail(error), /^the model server stopped working and was still starting again after \d+ s$/);
  assert.equal(errorCodeFor(error), 'local-failed');
  assert.ok(logs.some(line => /was not ready again in time/.test(line)));
  const cannot = {recover: async () => { throw new LocalAiUnavailable('crashed'); }};
  await assert.rejects(survivingLoss(chat, {server: cannot})({...timed()}), error => isLocalUnavailable(error) && error.reason === 'crashed');
});

test('unavailableDetail says why Local AI cannot be used, in a few plain words', () => {
  assert.equal(unavailableDetail('crashed'), 'the model server stopped working and did not start again');
  assert.equal(unavailableDetail('start-failed', 'exited'), 'the model server did not start (exited)');
  assert.equal(unavailableDetail('start-failed', 'could not list the graphics devices'), 'the model server did not start', 'only a one-word code is added');
  assert.equal(unavailableDetail('no-gpu'), 'no discrete graphics card was found');
  assert.equal(unavailableDetail('not-installed', 'no model'), 'the Local AI pack is not installed');
  assert.equal(unavailableDetail('stopped'), undefined);
  assert.equal(unavailableDetail(undefined), undefined);
  for (const reason of ['not-installed', 'low-memory', 'mature-off', 'no-gpu', 'start-failed', 'crashed']) {
    const text = unavailableDetail(reason, 'exited');
    assert.ok(text.length <= 140 && /^[\x20-\x7e]+$/.test(text), reason);
  }
  const error = new LocalAiUnavailable('start-failed', 'timeout');
  assert.equal(error.detail, 'timeout');
});

// ---- the real supervisor and a real turn, over the fake llama-server ---------------------------------------------------------------

const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);
const turn = (text, extra = {}) => ({text, context: 'CURRENT PERSON\nQuest facts here.', sessionId: 'session-1',
  local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'},
  contextParts: {now: 'Right now (from the game, this turn only): you are with V in Kabuki, it is night.', notes: '', world: 'WORLD FACTS\n- a fact', worldBlocks: [{key: 'knowledge', text: 'WORLD FACTS\n- a fact'}], volatile: ''}, ...extra});

// envFor(index): the environment of the index-th server that is started.
async function rig(t, {envFor = () => ({}), maxRestarts} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'local-recovery-'));
  const write = name => { const path = join(directory, name); writeFileSync(path, name); return path; };
  const pack = {installed: true, missing: [], root: directory, server: write('llama-server.exe'),
    tiers: {standard: {file: write('Qwen3.5-4B-Q4_K_M.gguf'), name: 'Qwen3.5-4B'}, lite: null}, embed: {file: write('embed.gguf'), dim: 8, id: 'fake-embed'}, dev: false};
  const children = [];
  const spawnImpl = (command, args, spawnOptions) => {
    const child = spawn(command, args, {...spawnOptions, env: {...spawnOptions.env, ...envFor(children.length)}});
    children.push(child);
    return child;
  };
  const tmpDir = join(directory, 'tmp');
  mkdirSync(tmpDir);
  const logs = [];
  const server = new LocalLlmServer({pack, listDevices: async () => DEVICES, freeVramMiB: () => null, fileSizeMiB: () => 2582, command: process.execPath, argsPrefix: [FAKE],
    spawnImpl, log: line => logs.push(line), backoffMs: 10, startupMs: 180_000, warmup: false, contextSize: 16384, ...(maxRestarts === undefined ? {} : {maxRestarts}),
    processOptions: {tmpDir, pollMs: 20}});
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => '', writeText: async () => {}});
  await provider.load(); provider.setPreference('local'); provider.apply();
  const restarted = [];
  server.on('restarted', event => { restarted.push(event); provider.noteLocalRestarted(); });
  const route = localRoute({server, provider, log: line => logs.push(line)});
  route.chatDefaults = {...route.chatDefaults, retries: 1, backoffMs: [1]};
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: book, routes: {local: route}, log: line => logs.push(line)});
  t.after(async () => {
    host.close();
    await server.stop();
    for (const child of children) if (child.exitCode === null) child.kill();
    rmSync(directory, {recursive: true, force: true});
  });
  return {server, host, provider, logs, children, restarted};
}

test('a server that crashes during a turn and is still listed as running: the turn waits for the next one, is answered, and the player is told once', async t => {
  const {server, host, provider, logs, children, restarted} = await rig(t, {envFor: index => (index === 0 ? {FAKE_LLAMA_GO_DEAF_AT: '1'} : {FAKE_LLAMA_REPLY: 'Sure, V.'})});
  const first = await server.ensure();
  const reply = await host.reply(turn('hello there'));
  assert.equal(reply.text, 'Sure, V.');
  assert.equal(children.length, 2, 'the dead server was replaced once');
  assert.notEqual((await server.ensure()).endpoint, first.endpoint);
  assert.equal(server.status().state, 'ready');
  assert.equal(restarted.length, 1);
  assert.ok(logs.some(line => /llama-server stopped answering/.test(line)), logs.join('\n'));
  assert.ok(logs.some(line => /was started again; asking once more/.test(line)));
  assert.equal(provider.takeNotice(), 'local-restarted');
  assert.equal(provider.takeNotice(), undefined, 'once');
  // The next turn needs no restart.
  assert.equal((await host.reply(turn('and again'))).text, 'Sure, V.');
  assert.equal(children.length, 2);
});

test('a server that cannot start again fails the turn with its reason, and Local AI is marked unusable', async t => {
  const {server, host, provider, restarted} = await rig(t, {maxRestarts: 2,
    envFor: index => (index === 0 ? {FAKE_LLAMA_GO_DEAF_AT: '1'} : {FAKE_LLAMA_EXIT_AT_START: '3'})});
  await server.ensure();
  const error = await host.reply(turn('hello there')).catch(e => e);
  assert.ok(isLocalUnavailable(error), String(error?.message));
  assert.equal(error.reason, 'crashed');
  assert.equal(provider.localBroken, 'crashed');
  assert.equal(restarted.length, 0, 'it never came back, so nobody says it did');
  assert.equal(unavailableDetail(error.reason, error.detail), 'the model server stopped working and did not start again');
  assert.equal(server.status().state, 'failed');
});

test('a turn that arrives while the server is starting after an idle stop waits for it (within the turn\'s time)', async t => {
  const {server, host} = await rig(t, {envFor: () => ({FAKE_LLAMA_REPLY: 'Hey.', FAKE_LLAMA_DELAY_MS: '300'})});
  await server.ensure();
  await server.stop();
  assert.equal(server.status().state, 'stopped');
  const started = once(server, 'state');
  const reply = await host.reply(turn('hello there'));
  await started;
  assert.equal(reply.text, 'Hey.');
  assert.equal(server.status().state, 'ready');
});

// ---- a lost graphics device: the server stays alive and answers /health, every request fails (2026-10-20 report, an RX 580 over Vulkan) -----------------------------------

const LOST = 'decode() failed: vk::Queue::submit: ErrorDeviceLost';

test('deviceLost reads the words of a failed request; lostServer still holds for the same failure', () => {
  assert.equal(deviceLost(failure(LOST, {status: 500, slow: true})), true);
  assert.equal(deviceLost(failure('the graphics device ran out of memory')), false, 'only the driver\'s own words');
  assert.equal(deviceLost(failure('VK_ERROR_DEVICE_LOST')), true);
  assert.equal(deviceLost(Object.assign(failure('HTTP 500', {status: 500}), {providerText: 'device lost'})), true);
  assert.equal(deviceLost(failure('could not be reached (ECONNREFUSED)')), false);
  assert.equal(deviceLost(new Error('boom')), false);
  assert.equal(deviceLost(undefined), false);
  assert.equal(lostServer(failure(LOST, {status: 500, slow: true})), true, 'a 500 with no reply written is a lost server, whatever its words');
});

test('a device-lost failure asks the supervisor to restart without its health check; a second loss on the new server tells it at once', async () => {
  const flags = [], noted = [];
  let calls = 0;
  const chat = async () => { calls++; throw failure(LOST, {status: 500, slow: true}); };
  const server = {recover: async options => { flags.push(options.deviceLost); return {endpoint: 'http://127.0.0.1:2/v1/chat/completions', apiKey: 'newkey'}; },
    noteDeviceLost: what => { noted.push(what); }};
  await assert.rejects(survivingLoss(chat, {server})({endpoint: 'http://127.0.0.1:1/v1/chat/completions', apiKey: 'a', ...timed()}), /ErrorDeviceLost/);
  assert.deepEqual(flags, [true]);
  assert.equal(calls, 2, 'asked once more, no third time');
  assert.equal(noted.length, 1, 'the second loss is noted (step down), the first went through recover');
  // An ordinary failure never carries the flag.
  const flagsOrdinary = [];
  const ordinary = async () => { throw failure('could not be reached (ECONNREFUSED)'); };
  await survivingLoss(ordinary, {server: {recover: async options => { flagsOrdinary.push(options.deviceLost); return null; }}})({...timed()}).catch(() => {});
  assert.deepEqual(flagsOrdinary, [false]);
  // A loss that cannot be asked again (no turn deadline, or a reply already begun) is still noted, so the next turn finds a restarted server; the failure stands.
  noted.length = 0;
  const partial = async () => { throw failure(LOST, {status: 500, partial: true, trace: {pieces: 2}}); };
  await assert.rejects(survivingLoss(partial, {server})({...timed()}), /ErrorDeviceLost/);
  await assert.rejects(survivingLoss(chat, {server})({}), /ErrorDeviceLost/);
  assert.equal(noted.length, 2);
  assert.equal(flags.length, 1, 'neither went through recover');
});

test('a device lost on a server that stays healthy: the turn is restarted onto a new server and answered; the player is told once', async t => {
  const {server, host, provider, logs, children, restarted} = await rig(t, {envFor: index => (index === 0 ? {FAKE_LLAMA_DEVICE_LOST_FROM: '1'} : {FAKE_LLAMA_REPLY: 'Sure, V.'})});
  server.deviceLostPauseMs = 10;
  const first = await server.ensure();
  const reply = await host.reply(turn('hello there'));
  assert.equal(reply.text, 'Sure, V.');
  assert.equal(children.length, 2);
  assert.notEqual((await server.ensure()).endpoint, first.endpoint);
  assert.ok(logs.some(line => /graphics device was lost/.test(line)), logs.join('\n'));
  assert.equal(restarted.length, 1);
  assert.equal(provider.takeNotice(), 'local-restarted');
});

test('a device lost again on the new server fails the turn with its own words, then steps down (here: no smaller model, so the cloud takes over) instead of looping', async t => {
  const {server, host, children} = await rig(t, {envFor: () => ({FAKE_LLAMA_DEVICE_LOST_FROM: '1'})});
  server.deviceLostPauseMs = 10;
  await server.ensure();
  const error = await host.reply(turn('hello there')).catch(e => e);
  assert.ok(error instanceof Error);
  assert.match(String(error.message), /ErrorDeviceLost|device lost|stopped working|went away/i);
  assert.equal(await (async () => { for (let i = 0; i < 400; i++) { if (server.status().state === 'failed') return true; await new Promise(resolve => setTimeout(resolve, 25)); } return false; })(), true, 'Local AI is marked unavailable');
  assert.equal(server.status().reason, 'low-memory');
  assert.equal(children.length, 2, 'two servers in all, no loop');
});
