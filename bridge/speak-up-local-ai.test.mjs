// Lines prepared ahead on the text providers (docs/COMPANION_SPEAK_UP.md, "Bridge side"): Johnny's follow-on and a companion's after-scene line are written while a line
// plays. On the local AI they are the lowest-priority work there is: the model has ONE slot, so a prepared line never starts beside anything else, is stopped the
// moment a turn of V's needs the model (the generation really ends: the fake server sees the client go away), and never loads the model. On Mistral it is sent at the
// background priority of the account's scheduler. The server is the fake llama-server (bridge/fixtures/fake-llama-server.mjs): no model, no GPU, no game, no sound.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {constants as osConstants} from 'node:os';
import {streamChat} from './mistral-client.mjs';
import {LocalLlmServer} from './local-llm-server.mjs';
import {TextProviderHost, localRoute, mistralRoute} from './text-provider-host.mjs';
import {MistralMemory, MEMORY_LIMITS} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {MistralScheduler, PRIORITY} from './mistral-rate.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-llama-server.mjs', import.meta.url));
const DEVICES = 'Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4080 Laptop GPU (11997 MiB, 11229 MiB free)\n';
const BELOW_NORMAL = osConstants.priority.PRIORITY_BELOW_NORMAL, NORMAL = osConstants.priority.PRIORITY_NORMAL;
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(check, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await sleep(10); }
  assert.fail('the condition did not come true');
}

function rig(t, {env = {}, processExtra = {}, ...options} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'speak-up-local-'));
  const write = name => { const path = join(directory, name); writeFileSync(path, name); return path; };
  const pack = {installed: true, missing: [], root: directory, server: write('llama-server.exe'),
    tiers: {standard: {file: write('Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf'), name: 'Gemma 4 E4B · uncensored'}, lite: null},
    embed: {file: write('embed.gguf'), dim: 8, id: 'fake-embed'}, dev: false};
  const children = [];
  const spawnImpl = (command, args, spawnOptions) => { const child = spawn(command, args, spawnOptions); children.push(child); return child; };
  const tmpDir = join(directory, 'tmp');
  mkdirSync(tmpDir);
  const logs = [];
  const server = new LocalLlmServer({pack, listDevices: async () => DEVICES, freeVramMiB: () => null, fileSizeMiB: () => 5088, command: process.execPath, argsPrefix: [FAKE],
    spawnImpl, log: line => logs.push(line), backoffMs: 10, startupMs: 180_000, warmup: false, contextSize: 16384, processOptions: {env, tmpDir, pollMs: 20, ...processExtra}, ...options});
  t.after(async () => { await server.stop(); for (const child of children) if (child.exitCode === null) child.kill(); rmSync(directory, {recursive: true, force: true}); });
  return {server, logs};
}
// What the fake server saw: each chat request, and whether its client went away before the answer was finished.
async function seen(server) {
  const handle = await server.ensure();
  const stats = await (await fetch(new URL(handle.endpoint).origin + '/__stats')).json();
  return stats.requests.filter(row => row.path === '/v1/chat/completions');
}

// ---- the server ---------------------------------------------------------------------------------------------------------------------------

test('the server: a prepared line starts only when nothing else holds the slot, needs no quiet time after a turn, and runs at normal priority like a turn', async t => {
  const timeline = [];
  const {server} = rig(t, {now: () => 5_000_000, processExtra: {setPriorityImpl: (pid, level) => timeline.push(level)}});
  await server.ensure();
  assert.deepEqual(timeline, [BELOW_NORMAL]);
  assert.equal(server.preparedRefusal(), null, 'an idle server takes a prepared line');
  // Plain background work (a summary, a warm-up) leaves the priority alone; a prepared line raises the process to normal for as long as it runs, as a turn does.
  server.begin({background: true})();
  assert.deepEqual(timeline, [BELOW_NORMAL]);
  const stopped = [];
  const prepared = server.begin({background: true, raise: true, cancel: () => stopped.push('prepared')});
  assert.deepEqual(timeline, [BELOW_NORMAL, NORMAL]);
  assert.equal(server.preparedRefusal(), 'other work is running', 'one at a time');
  assert.equal(server.backgroundRefusal(), 'other background work is running', 'a summary waits for it');
  // It is registered like a summary: a turn takes the slot from it.
  assert.equal(server.preempt('judy-alvarez'), true);
  assert.deepEqual(stopped, ['prepared']);
  prepared();
  assert.equal(server.inflight, 0);
  // A turn is being served: refused. When it has ended a prepared line is wanted right now, while a summary must wait out the quiet time.
  const turn = server.begin();
  assert.equal(server.preparedRefusal(), 'a turn is using the model');
  turn();
  assert.equal(server.backgroundRefusal(), 'a turn has just ended');
  assert.equal(server.preparedRefusal(), null, 'no quiet time for a prepared line');
  const summary = server.begin({background: true, cancel: () => {}});
  assert.equal(server.preparedRefusal(), 'other work is running');
  summary();
  assert.equal(server.preparedRefusal(), null);
  const queue = server.diagnostics().queue;
  assert.deepEqual([queue.stopped, queue.refused], [1, 5], 'the support report counts what was stopped and refused');
});

test('the server: a persona warm-up in flight (V is about to talk) keeps a prepared line from starting', async t => {
  let release;
  const gate = new Promise(done => { release = done; });
  const requests = [];
  const fetchImpl = async (url, init) => {
    try { const body = JSON.parse(init?.body ?? '{}'); if (String(url).endsWith('/v1/chat/completions') && body.max_tokens === 1) { requests.push('warm'); await gate; } } catch { /* not JSON */ }
    return fetch(url, init);
  };
  const {server} = rig(t, {fetchImpl});
  await server.ensure();
  const warming = server.prewarm([{role: 'system', content: 'persona of judy'}, {role: 'user', content: '.'}], {key: 'judy-alvarez'});
  await until(() => requests.length === 1);
  assert.equal(server.preparedRefusal(), 'a persona warm-up is running');
  release(); await warming;
  assert.equal(server.preparedRefusal(), null);
});

// ---- the route ----------------------------------------------------------------------------------------------------------------------------

test('the route: a prepared line never loads the model, is refused while anything else holds the slot, is stopped by a turn through its own signal, and costs the turn no wait', async t => {
  const {server} = rig(t);
  const route = localRoute({server});
  // The model is not loaded: nothing is started for a line nobody is waiting for.
  assert.notEqual(server.status().state, 'ready');
  await assert.rejects(route.connect(undefined, {prepared: true, profileKey: 'johnny-silverhand'}), error => error.reason === 'busy' && error.noRetry === true && error.provider === 'local' && /not loaded/.test(error.message));
  assert.notEqual(server.status().state, 'ready', 'refused without loading');
  assert.notEqual(server.status().state, 'starting', 'and without starting a load');
  await server.ensure();
  // A turn is being served: refused, and counted as a refusal, not a failure.
  const turn = await route.connect(undefined, {profileKey: 'judy-alvarez', persona: 'judy-alvarez'});
  await assert.rejects(route.connect(undefined, {prepared: true, profileKey: 'johnny-silverhand'}), error => error.reason === 'busy' && /a turn is using the model/.test(error.message));
  turn.release();
  // Idle: it runs, with a stop signal, and a second one waits for it.
  const prepared = await route.connect(undefined, {prepared: true, profileKey: 'johnny-silverhand', persona: 'johnny-silverhand'});
  assert.ok(prepared.signal instanceof AbortSignal); assert.equal(prepared.signal.aborted, false);
  await assert.rejects(route.connect(undefined, {prepared: true}), error => error.reason === 'busy' && /other work is running/.test(error.message));
  // V's line: the prepared one is stopped at once, and the turn did not wait for anything.
  const began = Date.now();
  const next = await route.connect(undefined, {profileKey: 'judy-alvarez', persona: 'judy-alvarez'});
  assert.ok(Date.now() - began < 200, `the turn got the model without waiting (${Date.now() - began} ms)`);
  assert.equal(prepared.signal.aborted, true);
  assert.deepEqual(next.queue, {behind: 1, stopped: true});
  prepared.release(); next.release();
  assert.equal(server.inflight, 0);
  // A server the player runs is not asked to arbitrate: nothing of ours stops its request (the abort of the request itself still reaches it).
  const own = localRoute({server: {ensure: async () => ({apiKey: 'k', endpoint: 'e', model: 'm', requestModel: 'm', external: true}), status: () => ({state: 'ready'}), begin: () => () => {}, inflight: 0,
    preparedRefusal: () => 'a turn is using the model'}});
  assert.equal((await own.connect(undefined, {prepared: true})).signal, undefined);
});

// ---- the host -----------------------------------------------------------------------------------------------------------------------------

const roster = JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8'));
const book = new PersonaBook(roster);
const trigger = 'You are Johnny Silverhand, the engram in V\'s head. "Judy" has just said this to V: "Quiet night." Give one brief remark.';
const lineFor = (profileKey, name, extra = {}) => ({text: trigger, context: 'CURRENT PERSON\nQuest facts here.', sessionId: `s-${profileKey}`,
  local: {profileKey, name, channel: 'private'}, reaction: {kind: 'head', event: 'follow', maxWords: 25}, prepared: true,
  contextParts: {now: 'Right now (from the game, this turn only): you are in V\'s head.', notes: '', world: 'WORLD FACTS\n- a fact', worldBlocks: [{key: 'knowledge', text: 'WORLD FACTS\n- a fact'}], volatile: ''}, ...extra});
const ask = (text, extra = {}) => ({text, context: 'CURRENT PERSON\nQuest facts here.', sessionId: 'session-1', local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'},
  contextParts: {now: 'Right now (from the game, this turn only): you are with V in Kabuki, it is night.', notes: '', world: 'WORLD FACTS\n- a fact', worldBlocks: [{key: 'knowledge', text: 'WORLD FACTS\n- a fact'}], volatile: ''}, ...extra});

async function hostRig(t, {env = {FAKE_LLAMA_FIRST_TOKEN_MS: '1', FAKE_LLAMA_REPLY: 'Sure, V.'}, serverOptions = {}, load = true} = {}) {
  const {server, logs} = rig(t, {env, ...serverOptions});
  if (load) await server.ensure();
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => '', writeText: async () => {}});
  await provider.load(); provider.setPreference('local'); provider.apply();
  const route = localRoute({server, provider, chat: streamChat, log: line => logs.push(line)});
  const memory = await MistralMemory.open({path: null, limits: {...MEMORY_LIMITS, turns: 4, batch: 4, slide: 0}});
  const host = new TextProviderHost({provider, memory, personas: book, routes: {local: route}, log: line => logs.push(line), idleRetryMs: 20});
  t.after(() => host.close());
  return {host, server, route, logs, memory};
}

test('the host: a prepared line is written when the model is free, leaves no memory, and is sent as a plain request of the server', async t => {
  const { host, server, memory, logs } = await hostRig(t, {env: {FAKE_LLAMA_FIRST_TOKEN_MS: '1', FAKE_LLAMA_REPLY: 'Cute. She never stops talking.'}});
  const reply = await host.reply(lineFor('johnny-silverhand', 'Johnny Silverhand'));
  assert.equal(reply.text, 'Cute. She never stops talking.');
  assert.equal((await seen(server)).length, 1);
  assert.equal(server.inflight, 0);
  assert.deepEqual(memory.recall({profileKey: 'johnny-silverhand', channel: 'private'}).turns, [], 'a reaction is never recorded: nothing of Johnny\'s line is in anyone\'s memory');
  assert.deepEqual(memory.recall({profileKey: 'judy-alvarez', channel: 'private'}).turns, []);
  assert.equal(logs.some(line => /FAILED/.test(line)), false, logs.join('\n'));
});

test('the host: a prepared line asked for while a turn is served is not started at all: no request, no failure, no stall, and the turn is answered as usual', async t => {
  const { host, server, logs } = await hostRig(t, {env: {FAKE_LLAMA_FIRST_TOKEN_MS: '700', FAKE_LLAMA_REPLY: 'Sure, V.'}});
  const turn = host.reply(ask('How are you?'));
  await until(() => server.inflight === 1);
  await assert.rejects(host.reply(lineFor('johnny-silverhand', 'Johnny Silverhand')), error => error.reason === 'busy' && error.provider === 'local');
  assert.equal((await turn).text, 'Sure, V.');
  const requests = await seen(server);
  assert.equal(requests.length, 1, 'only the turn reached the model');
  assert.equal(logs.some(line => /FAILED|stalled/.test(line)), false, logs.join('\n'));
  assert.equal(logs.some(line => /a line prepared ahead was not started \(.*busy \(a turn is using the model\)/.test(line)), true, logs.join('\n'));
  assert.equal(server.diagnostics().turns?.failed ?? 0, 0, 'a refusal is not a failed turn');
});

test('the host: a turn of V\'s that arrives while a prepared line is being written stops it (the model server sees the generation end) and is answered at its normal latency', async t => {
  const env = {FAKE_LLAMA_FIRST_TOKEN_MS: '900', FAKE_LLAMA_REPLY: 'Sure, V.'};
  const { host, server } = await hostRig(t, {env});
  // The latency of a turn on its own.
  let began = Date.now();
  await host.reply(ask('Baseline one'));
  const alone = Date.now() - began;
  // The same turn while a prepared line is in flight.
  const controller = new AbortController();
  const prepared = host.reply(lineFor('johnny-silverhand', 'Johnny Silverhand'), {signal: controller.signal});
  prepared.catch(() => {});
  await until(() => server.inflight === 1);
  began = Date.now();
  const reply = await host.reply(ask('And now V talks'));
  const beside = Date.now() - began;
  assert.equal(reply.text, 'Sure, V.');
  assert.ok(beside < alone + 600, `V's turn took ${beside} ms beside the prepared line, ${alone} ms alone`);
  await assert.rejects(prepared, error => error?.name === 'AbortError' || /abort|cancel/i.test(String(error?.message)), 'the prepared line was stopped');
  await until(() => server.inflight === 0);
  const requests = await seen(server);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].aborted, true, 'the model server saw the prepared request\'s client go away');
  assert.ok(!requests[0].aborted && !requests[2].aborted, 'V\'s turns were answered to the end');
  assert.equal(server.diagnostics().queue.stopped >= 1, true);
  // Withdrawn by the bridge itself (the signal of the held turn): the same, and nothing is left running.
  const second = host.reply(lineFor('johnny-silverhand', 'Johnny Silverhand'), {signal: controller.signal});
  second.catch(() => {});
  await until(() => server.inflight === 1);
  controller.abort();
  await assert.rejects(second);
  await until(() => server.inflight === 0);
  await until(async () => (await seen(server)).length === 4 && (await seen(server))[3].aborted === true);
});

test('the host: a prepared line never loads the model: with the model down it is refused and the server stays down', async t => {
  const { host, server, logs } = await hostRig(t, {load: false});
  await assert.rejects(host.reply(lineFor('johnny-silverhand', 'Johnny Silverhand')), error => error.reason === 'busy' && /not loaded/.test(error.message));
  assert.notEqual(server.status().state, 'ready'); assert.notEqual(server.status().state, 'starting');
  assert.equal(logs.some(line => /FAILED/.test(line)), false, logs.join('\n'));
});

// ---- Mistral ------------------------------------------------------------------------------------------------------------------------------

test('Mistral: a prepared line is scheduled at the background priority, so a turn of V\'s on the same account is served first', async t => {
  const order = [];
  const scheduler = new MistralScheduler({spacingMs: 0});
  const chat = async options => { order.push(options.messages.at(-1).content.includes('Johnny Silverhand') ? 'prepared' : 'turn'); return {text: 'Sure, V.', model: 'm', finishReason: 'stop', usage: {}}; };
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => 'api-key=aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL\n', writeText: async () => {}});
  await provider.load(); provider.setPreference('mistral'); provider.apply();
  const seenPriorities = [];
  const spy = {schedule: (task, options) => { seenPriorities.push(options.priority); return scheduler.schedule(task, options); }};
  const route = mistralRoute({provider, chat, gapMs: 0, scheduler: spy, priorities: PRIORITY});
  const memory = await MistralMemory.open({path: null});
  const host = new TextProviderHost({provider, memory, personas: book, routes: {mistral: route}});
  t.after(() => host.close());
  await host.reply(lineFor('johnny-silverhand', 'Johnny Silverhand'));
  await host.reply(ask('A turn of V\'s'));
  assert.deepEqual(seenPriorities, [PRIORITY.BACKGROUND, PRIORITY.TEXT]);
  assert.deepEqual(order, ['prepared', 'turn']);
});
