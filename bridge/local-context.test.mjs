// The local AI never gets a prompt longer than its context (docs/LOCAL_AI.md, "Context budget"): the context size comes from the
// server, the prompt is fitted to it, and a turn the local AI still cannot answer fails and says so (it is never handed to a cloud provider, whether
// or not a Mistral key is saved; owner rule 2026-10-21). These tests run the real LocalLlmServer supervisor against the fake llama-server; no model, no game, no sound.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalLlmServer, LOCAL_LLM_LIMITS, chooseContext, tierNeedMiB} from './local-llm-server.mjs';
import {TextProviderHost, localRoute, mistralRoute} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {errorCodeFor} from './mistral-client.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-llama-server.mjs', import.meta.url));
const MISTRAL_KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
const DEVICES = `Available devices:
  Vulkan0: NVIDIA GeForce RTX 4080 Laptop GPU (11997 MiB, 11229 MiB free)
`;
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);

// ---- The context ladder ------------------------------------------------------------------------------------------------------

test('chooseContext: the largest context of the ladder whose extra cache fits the free memory, never below 8192, the largest when the memory is unknown', () => {
  assert.deepEqual(LOCAL_LLM_LIMITS.contextLadder, [16384, 12288, 8192]);
  const sizeMiB = 2800;
  const need = tierNeedMiB('standard', sizeMiB);
  const perK = LOCAL_LLM_LIMITS.kvMiBPerKToken.standard;
  assert.equal(chooseContext({tier: 'standard', freeMiB: need + perK * 8 + 1, sizeMiB}), 16384);
  assert.equal(chooseContext({tier: 'standard', freeMiB: need + perK * 8 - 1, sizeMiB}), 12288);
  assert.equal(chooseContext({tier: 'standard', freeMiB: need + perK * 4 - 1, sizeMiB}), 8192);
  assert.equal(chooseContext({tier: 'standard', freeMiB: 1, sizeMiB}), 8192, 'the floor, whatever is free: the tier choice already decided it starts');
  assert.equal(chooseContext({tier: 'lite', freeMiB: NaN, sizeMiB: 1400}), 16384);
  assert.equal(chooseContext({tier: 'lite', freeMiB: null, sizeMiB: 1400}), 16384);
  // The lite model is Bonsai 2 4B (full-attention KV is larger than Gemma 4's sliding window): measured 1,581 / 1,713 / 1,845 MiB at 8k / 12k / 16k.
  assert.equal(LOCAL_LLM_LIMITS.kvMiBPerKToken.lite, 33);
  const liteNeed = tierNeedMiB('lite', 1156);
  assert.equal(chooseContext({tier: 'lite', freeMiB: liteNeed + 33 * 8 + 1, sizeMiB: 1156}), 16384);
  assert.equal(chooseContext({tier: 'lite', freeMiB: liteNeed + 33 * 8 - 1, sizeMiB: 1156}), 12288);
  assert.equal(chooseContext({tier: 'lite', freeMiB: liteNeed + 33 * 4 - 1, sizeMiB: 1156}), 8192);
});

// ---- The supervisor reads the context and counts tokens ------------------------------------------------------------------------

function supervisor(t, {env = {}, ...options} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'local-context-test-'));
  const write = name => { const path = join(directory, name); writeFileSync(path, name); return path; };
  const pack = {installed: true, missing: [], root: directory, server: write('llama-server.exe'),
    tiers: {standard: {file: write('q4.gguf'), name: 'Gemma-4-E4B'}, lite: {file: write('q2.gguf'), name: 'Qwen3.5-2B'}},
    embed: {file: write('embed.gguf'), dim: 8, id: 'fake-embed'}, dev: false};
  const children = [];
  const spawnImpl = (command, args, spawnOptions) => { const child = spawn(command, args, spawnOptions); children.push(child); return child; };
  const tmpDir = join(directory, 'tmp');
  mkdirSync(tmpDir);
  const logs = [];
  const server = new LocalLlmServer({pack, listDevices: async () => DEVICES, freeVramMiB: () => null, fileSizeMiB: () => 0, command: process.execPath, argsPrefix: [FAKE],
    spawnImpl, log: line => logs.push(line), backoffMs: 10, startupMs: 180_000, warmup: false, processOptions: {env, tmpDir, pollMs: 20}, ...options});
  t.after(async () => { await server.stop(); for (const child of children) if (child.exitCode === null) child.kill(); rmSync(directory, {recursive: true, force: true}); });
  return {server, directory, logs};
}
const stats = async info => (await fetch(new URL(info.endpoint).origin + '/__stats')).json();

test('the supervisor starts with the ladder\'s context, reads the real n_ctx from /props, and reports it in the handle and the status', async t => {
  const argsFile = join(tmpdir(), 'local-context-args-' + process.pid + '.json');
  t.after(() => rmSync(argsFile, {force: true}));
  const {server} = supervisor(t, {env: {FAKE_LLAMA_ARGS_FILE: argsFile, FAKE_LLAMA_CTX: '12288'}});   // free memory unknown: the largest, 16384, is asked for
  const info = await server.ensure();
  const argv = JSON.parse(readFileSync(argsFile, 'utf8'));
  assert.equal(argv[argv.indexOf('-c') + 1], '16384');
  assert.equal(info.contextSize, 12288, 'what the server reports wins over what was asked for');
  assert.equal(server.status().contextSize, 12288);
});

test('a fixed context (the option or CYBERPUNK_CONVAI_LOCAL_CTX) replaces the ladder', async t => {
  const argsFile = join(tmpdir(), 'local-context-args2-' + process.pid + '.json');
  t.after(() => rmSync(argsFile, {force: true}));
  const {server} = supervisor(t, {contextSize: 8192, env: {FAKE_LLAMA_ARGS_FILE: argsFile}});
  const info = await server.ensure();
  assert.equal(JSON.parse(readFileSync(argsFile, 'utf8')).includes('8192'), true);
  assert.equal(info.contextSize, 8192);
});

test('tokenize: the server\'s own count, null while it is stopped (it never starts the server)', async t => {
  const {server} = supervisor(t, {contextSize: 8192, env: {FAKE_LLAMA_CHARS_PER_TOKEN: '4'}});
  assert.equal(await server.tokenize('x'.repeat(400)), null);
  assert.equal(server.status().state === 'ready', false);
  await server.ensure();
  assert.equal(await server.tokenize('x'.repeat(400)), 100);
  assert.equal(await server.tokenize(''), 0);
});

// ---- A turn is fitted to the context ------------------------------------------------------------------------------------------

const lines = (label, count) => Array.from({length: count}, (_, index) => `- ${label} item ${index + 1}: a plain fact about the world that the character may know of.`).join('\n');
const WORLD_BLOCKS = () => [
  {key: 'knowledge', text: 'WORLD FACTS\n' + lines('fact', 60)},
  {key: 'recency', text: 'RECENT SHARED EVENTS\n' + lines('event', 30)},
  {key: 'history', text: 'JOURNAL HISTORY\n' + lines('quest', 80)},
  {key: 'jobs', text: 'AVAILABLE JOBS\n' + lines('job', 80)},
  {key: 'journal', text: 'TRACKED QUEST: Pisces. Objective: meet Judy at the Clouds.'},
];
const bigTurn = (text, extra = {}) => {
  const blocks = WORLD_BLOCKS();
  return {text, context: 'CURRENT PERSON\nQuest facts here.', sessionId: 'session-1',
    local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'},
    contextParts: {now: 'Right now (from the game, this turn only): you are with V in Kabuki, it is night.', notes: 'Use {joy} tags for feelings.',
      world: blocks.map(block => block.text).join('\n\n'), worldBlocks: blocks, volatile: 'Whether you ask V anything is your own call.'}, ...extra};
};

async function hostFor(t, {server, preference = 'local', mistralKey = null, mistralScript, withTokenize = true, env = {}} = {}) {
  const logs = [];
  const handle = server ?? supervisor(t, {contextSize: 8192, env}).server;
  const routeServer = withTokenize ? handle : {ensure: options => handle.ensure(options), touch: () => handle.touch?.(), prewarm: () => {}};
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => mistralKey ? `api-key=${mistralKey}\n` : '', writeText: async () => {}});
  await provider.load();
  provider.setPreference(preference); provider.apply();
  const memory = await MistralMemory.open({path: null});
  let cloud = null;
  const routes = {local: localRoute({server: routeServer, provider, log: line => logs.push(line)})};
  if (mistralScript) {
    cloud = await cloudServer(mistralScript);
    routes.mistral = mistralRoute({provider, endpoint: cloud.endpoint, gapMs: 0, chatDefaults: {retries: 0, backoffMs: [0], firstByteMs: 3000, totalMs: 3000}});
  }
  const host = new TextProviderHost({provider, memory, personas: book, routes, log: line => logs.push(line)});
  t.after(async () => { host.close(); await cloud?.close(); });
  return {host, provider, handle, logs, cloud};
}

async function cloudServer(script) {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(raw));
      response.writeHead(200, {'content-type': 'text/event-stream'});
      for (const piece of String(script()).match(/.{1,12}/gs) ?? []) response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: piece}}]})}\n\n`);
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {requests, endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); })};
}

test('a raw prompt of well over 8192 tokens is cut to fit: the server never refuses it, the persona and the right-now block stay', async t => {
  const {host, handle} = await hostFor(t, {env: {FAKE_LLAMA_CHARS_PER_TOKEN: '3', FAKE_LLAMA_REPLY: 'Sure thing, V.'}});
  const reply = await host.reply(bigTurn('What are you up to right now?'));
  assert.equal(reply.text, 'Sure thing, V.');
  const seen = (await stats(await handle.ensure())).requests.filter(request => request.path === '/v1/chat/completions');
  assert.equal(seen.filter(request => request.refused).length, 0, 'no refusal');
  assert.equal(seen.length, 1);
  assert(seen[0].promptTokens <= 8192 - 320, `the prompt (${seen[0].promptTokens} tokens) leaves room for the reply`);
  // What was left out is the lowest-priority knowledge, in the order of the docs: the persona core is still there.
  assert(seen[0].promptChars > 8000, 'the persona core is kept');
});

test('a server that counts denser than the estimate refuses once; the count is learned and the same turn is sent again, smaller', async t => {
  const {host, handle, logs} = await hostFor(t, {withTokenize: false, env: {FAKE_LLAMA_CHARS_PER_TOKEN: '3', FAKE_LLAMA_REPLY: 'Sure thing, V.'}});
  const reply = await host.reply(bigTurn('What are you up to right now?'));
  assert.equal(reply.text, 'Sure thing, V.');
  const seen = (await stats(await handle.ensure())).requests.filter(request => request.path === '/v1/chat/completions');
  assert.equal(seen.filter(request => request.refused).length, 1, 'one refusal');
  assert.equal(seen.filter(request => !request.refused).length, 1, 'one answered request');
  assert(seen.find(request => !request.refused).promptTokens <= 8192);
  assert(logs.some(line => /local AI/i.test(line)), 'the cut is logged');
});

// ---- A turn the local AI cannot answer ----------------------------------------------------------------------------------------

test('with a Mistral key saved a turn the local AI cannot answer still fails with local-failed: Mistral is never asked, and Local AI stays selected', async t => {
  // A context far too small for any prompt: every local request is "too large".
  const handle = supervisor(t, {contextSize: 2048, env: {FAKE_LLAMA_REPLY: 'never used'}}).server;
  const {host, provider, cloud, logs} = await hostFor(t, {server: handle, mistralKey: MISTRAL_KEY, mistralScript: () => 'Mistral here, V.'});
  const error = await host.reply(bigTurn('Hello?')).catch(caught => caught);
  assert(error instanceof Error);
  assert.equal(errorCodeFor(error), 'local-failed');
  assert.equal(cloud.requests.length, 0, 'nothing went to Mistral');
  assert.equal(provider.route, 'local', 'the player\'s choice is not changed by one failed turn');
  assert.equal(provider.takeNotice(), undefined, 'no notice says a cloud provider answered');
  assert(!logs.some(line => /using Mistral/.test(line)));
  const seen = (await stats(await handle.ensure())).requests.filter(request => request.path === '/v1/chat/completions');
  assert.equal(seen.length, 0, 'the local server was never sent a prompt that cannot fit');
});

test('without a cloud key the turn fails with the game code local-failed and no notice about a fallback', async t => {
  const handle = supervisor(t, {contextSize: 2048}).server;
  const {host, provider} = await hostFor(t, {server: handle});
  const error = await host.reply(bigTurn('Hello?')).catch(caught => caught);
  assert(error instanceof Error);
  assert.equal(errorCodeFor(error), 'local-failed');
  assert.equal(provider.takeNotice(), undefined);
});

test('a 4096-token server the player runs: with no cloud key the persona is shortened to fit, and the server is never sent more than it holds', async t => {
  // A 2026-10-19 report: a named character's persona and the output rules alone were over a 4,096-token context, nothing optional was left to cut, and every turn failed.
  const {server: handle} = supervisor(t, {contextSize: 4096, env: {FAKE_LLAMA_REPLY: 'Sure thing, V.'}});
  const {host, logs} = await hostFor(t, {server: handle});
  const reply = await host.reply(bigTurn('What are you up to right now?'));
  assert.equal(reply.text, 'Sure thing, V.');
  const seen = (await stats(await handle.ensure())).requests.filter(request => request.path === '/v1/chat/completions');
  assert.equal(seen.filter(request => request.refused).length, 0, 'no refusal');
  assert.equal(seen.length, 1);
  assert(seen[0].promptTokens <= 4096 - 320, `the prompt (${seen[0].promptTokens} tokens) leaves room for the reply`);
  assert(logs.some(line => /cut:.*persona:\d+/.test(line)), 'the log names the persona cut');
});

test('a 4096-token server with a Mistral key saved: the persona is shortened to fit like without a key, and Mistral is never asked', async t => {
  const {server: handle} = supervisor(t, {contextSize: 4096, env: {FAKE_LLAMA_REPLY: 'Sure thing, V.'}});
  const {host, cloud, logs} = await hostFor(t, {server: handle, mistralKey: MISTRAL_KEY, mistralScript: () => 'Mistral here, V.'});
  const reply = await host.reply(bigTurn('What are you up to right now?'));
  assert.equal(reply.text, 'Sure thing, V.');
  assert.equal(cloud.requests.length, 0, 'nothing went to Mistral');
  const seen = (await stats(await handle.ensure())).requests.filter(request => request.path === '/v1/chat/completions');
  assert.equal(seen.length, 1); assert.equal(seen.filter(request => request.refused).length, 0);
  assert(logs.some(line => /cut:.*persona:\d+/.test(line)), 'the log names the persona cut');
});

test('the provider has no per-turn fallback notice any more', async t => {
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${MISTRAL_KEY}\n`, writeText: async () => {}});
  await provider.load();
  provider.setPreference('local'); provider.apply();
  assert.equal(typeof provider.noteLocalTurnFallback, 'undefined');
  assert.equal(provider.takeNotice(), undefined);
});
