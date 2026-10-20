// The one slot of the local model server (docs/LOCAL_AI.md, "The single slot"): a typed line is never made to wait behind work nobody is waiting for.
// The 2026-10-20 player report ("fine at first, then a delay of 1 to 2 minutes after typing that keeps growing") and the error reports of 2026-10-19 and 20
// ("no response in 60 s", prompts that held 0 or 2,350 cached tokens) show the causes this file pins down:
//   - a summary of older talk (and memory work) in flight when V types: the model has one slot, so the line waited for it. Now a turn stops it, one such request
//     runs at a time, none starts while a turn is served or just after one, and an extraction that was put off is asked again soon, not after a backoff;
//   - a persona warm-up (the composer opens: one each time) for the character the slot already holds: it read the bare persona, a prefix of the last turn's
//     longer prompt, and left the slot with only that, so the next turn read the whole world block again. It is skipped;
//   - nothing showed the wait: every turn now leaves one log line with the wait before it was sent, what was on the server beside it and the prompt's sizes.
// The server is the fake llama-server (bridge/fixtures/fake-llama-server.mjs): no model, no GPU, no game, no sound.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {streamChat} from './mistral-client.mjs';
import {LocalLlmServer} from './local-llm-server.mjs';
import {TextProviderHost, localRoute} from './text-provider-host.mjs';
import {MistralMemory, MEMORY_LIMITS} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {PersonaBook, buildMessages} from './mistral-prompt.mjs';
import {MemoryStore} from './memory-store.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-llama-server.mjs', import.meta.url));
const DEVICES = 'Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4080 Laptop GPU (11997 MiB, 11229 MiB free)\n';
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(check, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await sleep(10); }
  assert.fail('the condition did not come true');
}

function rig(t, {env = {}, ...options} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'local-queue-'));
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
    spawnImpl, log: line => logs.push(line), backoffMs: 10, startupMs: 180_000, warmup: false, contextSize: 16384, processOptions: {env, tmpDir, pollMs: 20}, ...options});
  t.after(async () => { await server.stop(); for (const child of children) if (child.exitCode === null) child.kill(); rmSync(directory, {recursive: true, force: true}); });
  return {server, logs};
}

// The warm-up requests (non-streamed, one token) the server was sent, by the first words of their system message.
function countingWarmUps(seen) {
  return (url, init) => {
    try {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      if (String(url).endsWith('/v1/chat/completions') && body?.max_tokens === 1 && body?.stream === false) seen.push(String(body.messages?.[0]?.content ?? '').slice(0, 20));
    } catch { /* not JSON */ }
    return fetch(url, init);
  };
}

test('the server: a turn stops the background requests in flight, and work nobody waits on is refused while a turn is served, just after one, and while other such work runs', async t => {
  let clock = 5_000_000;
  const {server} = rig(t, {now: () => clock});
  await server.ensure();
  assert.equal(server.backgroundRefusal(), null, 'an idle server takes background work');
  const stopped = [];
  const summary = server.begin({background: true, cancel: () => stopped.push('summary')});
  assert.equal(server.backgroundRefusal(), 'other background work is running', 'one background request at a time');
  const turn = server.begin();
  assert.equal(server.backgroundRefusal(), 'a turn is using the model');
  assert.equal(server.preempt('judy-alvarez'), true, 'a turn takes the slot from the summary');
  assert.deepEqual(stopped, ['summary']);
  assert.equal(server.preempt('judy-alvarez'), false, 'nothing left to stop');
  summary(); turn();
  assert.equal(server.inflight, 0);
  assert.equal(server.backgroundRefusal(), 'a turn has just ended');
  clock += 9_999;
  assert.equal(server.backgroundRefusal(), 'a turn has just ended');
  clock += 1;
  assert.equal(server.backgroundRefusal(), null, 'ten seconds after the turn');
  // A background request without a stop function (a persona warm-up has its own) does not count as work to give way, and a release twice is harmless.
  const warm = server.begin({background: true});
  assert.equal(server.backgroundRefusal(), null);
  warm(); warm();
  assert.equal(server.inflight, 0);
  const queue = server.diagnostics().queue;
  assert.deepEqual([queue.stopped, queue.refused, queue.inflight], [1, 4, 0], 'the support report counts what was stopped and refused');
});

test('the server: a warm-up for the persona the slot already holds is skipped, one while a turn is served is skipped, and the slot is free again after another persona, a decision or a restart', async t => {
  const seen = [];
  const {server} = rig(t, {fetchImpl: countingWarmUps(seen)});
  await server.ensure();
  const head = name => [{role: 'system', content: `persona of ${name}`}, {role: 'user', content: '.'}];
  assert.equal(await server.prewarm(head('judy'), {key: 'judy'}), true);
  assert.equal(seen.length, 1);
  // The composer opens again: Judy's prompt (the warm-up, or the turn after it) is still in the slot.
  assert.equal(await server.prewarm(head('judy'), {key: 'judy'}), false);
  assert.equal(seen.length, 1, 'nothing was sent: a warm-up would only have cut the slot down to the bare persona');
  // A turn for Judy leaves her prompt in the slot too.
  server.noteSlot('panam');
  assert.equal(await server.prewarm(head('panam'), {key: 'panam'}), false);
  server.noteSlot('judy');
  assert.equal(await server.prewarm(head('panam'), {key: 'panam'}), true, 'another persona replaces the slot');
  assert.equal(await server.prewarm(head('judy'), {key: 'judy'}), true, 'and Judy is read again after Panam');
  assert.equal(seen.length, 3);
  // An action decision puts a short prompt into the slot: no persona is held, so the next warm-up of Judy goes through.
  server.noteSlot(null);
  assert.equal(await server.prewarm(head('judy'), {key: 'judy'}), true);
  assert.equal(seen.length, 4);
  // A turn is being served: a warm-up would queue behind it and then replace its prompt with the bare persona.
  const turn = server.begin();
  assert.equal(await server.prewarm(head('panam'), {key: 'panam'}), false);
  assert.equal(seen.length, 4);
  turn();
  // A warm-up with no key (the connection is only being opened) is never skipped for the slot.
  assert.equal(await server.prewarm(head('x')), true);
  assert.equal(seen.length, 5);
  // A restart empties the slot.
  await server.prewarm(head('judy'), {key: 'judy'});
  const before = seen.length;
  await server.stop();
  await sleep(5);
  await server.ensure();
  assert.equal(await server.prewarm(head('judy'), {key: 'judy'}), true, 'the new load holds nothing');
  assert.equal(seen.length, before + 1);
  assert.equal(server.diagnostics().queue.warmSkipped, 3);
});

test('the route: background work is refused while a turn is served and while other background work runs, a turn stops it through its own signal, and the lease says what was beside it', async t => {
  const {server} = rig(t, {backgroundQuietMs: 0});
  await server.ensure();
  const route = localRoute({server});
  const turn = await route.connect(undefined, {profileKey: 'judy-alvarez', persona: 'judy-alvarez'});
  assert.deepEqual(turn.queue, {behind: 0}, 'nothing else was on the server');
  await assert.rejects(route.connect(undefined, {background: true}), error => error.reason === 'busy' && error.noRetry === true && error.provider === 'local' && /a turn is using the model/.test(error.message));
  turn.release();
  const summary = await route.connect(undefined, {background: true});
  assert.ok(summary.signal instanceof AbortSignal);
  assert.equal(summary.signal.aborted, false);
  await assert.rejects(route.connect(undefined, {background: true}), error => error.reason === 'busy' && /other background work/.test(error.message), 'one at a time');
  // The player's line: the summary is stopped at once and the turn knows it was sent beside it.
  const next = await route.connect(undefined, {profileKey: 'judy-alvarez', persona: 'judy-alvarez'});
  assert.equal(summary.signal.aborted, true);
  assert.deepEqual(next.queue, {behind: 1, stopped: true});
  summary.release(); next.release();
  assert.equal(server.inflight, 0);
  // A server the player runs is not asked to arbitrate: its background requests carry no signal of ours.
  const own = localRoute({server: {ensure: async () => ({apiKey: 'k', endpoint: 'e', model: 'm', requestModel: 'm', external: true}), status: () => ({state: 'ready'}), begin: () => () => {}, inflight: 0,
    backgroundRefusal: () => 'a turn is using the model'}});
  const lease = await own.connect(undefined, {background: true});
  assert.equal(lease.signal, undefined);
});

// ---- the host ---------------------------------------------------------------------------------------------------------------------

const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);
const turn = (text, extra = {}) => ({text, context: 'CURRENT PERSON\nQuest facts here.', sessionId: 'session-1',
  local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'},
  contextParts: {now: 'Right now (from the game, this turn only): you are with V in Kabuki, it is night.', notes: '', world: 'WORLD FACTS\n- a fact', worldBlocks: [{key: 'knowledge', text: 'WORLD FACTS\n- a fact'}], volatile: ''}, ...extra});

// A host on the fake server whose summary requests (260 tokens) never answer until they are stopped, like a model that is slow writing one on a busy machine.
async function hostRig(t, {env = {FAKE_LLAMA_FIRST_TOKEN_MS: '1', FAKE_LLAMA_REPLY: 'Sure, V.'}, serverOptions = {}} = {}) {
  const {server, logs} = rig(t, {env, ...serverOptions});
  await server.ensure();
  const started = [];
  const chat = options => {
    if (options.maxTokens !== 260) return streamChat(options);
    started.push(options);
    return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal.reason ?? Object.assign(Error('cancelled'), {name: 'AbortError'})), {once: true}));
  };
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => '', writeText: async () => {}});
  await provider.load(); provider.setPreference('local'); provider.apply();
  const route = localRoute({server, provider, chat, log: line => logs.push(line)});
  const memory = await MistralMemory.open({path: null, limits: {...MEMORY_LIMITS, turns: 1, batch: 1, slide: 0}});
  const host = new TextProviderHost({provider, memory, personas: book, routes: {local: route}, log: line => logs.push(line), idleRetryMs: 20});
  t.after(() => host.close());
  return {host, server, route, logs, memory, started};
}

test('the host: a summary in flight gives way to the next typed line, which is answered at once; the batch stays for a later quiet moment', async t => {
  const {host, server, logs, memory, started} = await hostRig(t, {serverOptions: {backgroundQuietMs: 0}});
  await host.reply(turn('first'));
  assert.equal(started.length, 0, 'one exchange is still in the history, nothing to fold in yet');
  await host.reply(turn('second'));
  await until(() => started.length === 1);   // the summary of the first exchange is being written
  assert.equal(server.inflight, 1);
  const began = Date.now();
  const reply = await host.reply(turn('third'));
  assert.equal(reply.text, 'Sure, V.');
  assert.ok(Date.now() - began < 5000, 'the line did not wait for the summary');
  assert.equal(started[0].signal.aborted, true, 'the summary was stopped for the turn');
  await until(() => server.inflight === 0);
  assert(logs.some(line => /summary put off: a turn needed the local model/.test(line)), logs.join('\n'));
  assert.equal(logs.some(line => /summary failed/.test(line)), false, 'put off is not a failure');
  // After that turn's reply the exchanges that rolled out of the history are summarised again (the batch was not lost); it is the quiet moment now.
  await until(() => started.length === 2);
  assert.equal(memory.pendingSummary('judy-alvarez'), null, 'a summary of the batch is under way again');
});

test('the host: a summary the host has not stopped yet is still stopped by the server when the turn asks for the model', async t => {
  const {host, server, started} = await hostRig(t, {serverOptions: {backgroundQuietMs: 0}});
  await host.reply(turn('first'));
  await host.reply(turn('second'));
  await until(() => started.length === 1);
  host.stoppable.clear();   // as if it were another host's summary (an add-on's host shares the server): only the server's own arbitration is left
  const reply = await host.reply(turn('third'));
  assert.equal(reply.text, 'Sure, V.');
  assert.equal(started[0].signal.aborted, true);
  assert.equal(server.diagnostics().queue.stopped >= 1, true, 'counted for the support report');
});

test('the host: a summary asked for while the model is busy is not sent, is asked again every few seconds without a log line, and is written once the quiet time has passed', async t => {
  let clock = 9_000_000;
  const {host, logs, started} = await hostRig(t, {serverOptions: {now: () => clock}});   // the default quiet time after a turn: 10 s
  await host.reply(turn('first'));
  await host.reply(turn('second'));
  await sleep(150);   // several retries (idleRetryMs is 20 ms) land inside the quiet time
  assert.equal(started.length, 0, 'no summary starts within ten seconds of a turn');
  assert.equal(logs.some(line => /summary (failed|put off)/.test(line)), false, 'a busy model is no log line');
  clock += 10_000;
  await until(() => started.length === 1);   // a retry finds the model free
});

test('every turn leaves one line with the wait before it was sent, what was beside it and the prompt sizes', async t => {
  const {host, server, logs} = await hostRig(t);
  const background = server.begin({background: true});   // a request of ours already on the server
  await host.reply(turn('hello there'));
  background();
  await host.reply(turn('and again'));
  const lines = logs.filter(line => line.startsWith('[LocalTurn] ok'));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /prompt \d+ new \+ \d+ cached tokens, took \d+ ms \| .*waited \d+ ms before sending, behind 1 other request$/);
  assert.match(lines[1], /^\[LocalTurn\] ok: first word \d+ ms, \d+ pieces, 50 tokens\/s, prompt \d+ new \+ \d+ cached tokens, took \d+ ms \| waited \d+ ms before sending, nothing else on the server$/);
  assert.equal(server.diagnostics().lastTurn.behind, 0);
  assert.equal(Number.isFinite(server.diagnostics().lastTurn.waitedMs), true);
});

// ---- the prompt: what the server's prompt cache can keep from one turn to the next ---------------------------------------------------

test('in a long conversation most turns keep the whole last prompt up to its newest exchange (the history window moves in steps, not every turn)', async () => {
  const persona = book.persona('judy-alvarez');
  // For each turn after the history is full: does this turn's prompt begin with all of the last turn's prompt but its final message?
  const keeps = async limits => {
    const memory = await MemoryStore.open({limits});
    const flags = [];
    let last = null, lastHistory = 0;
    for (let i = 0; i < 40; i++) {
      const {turns} = memory.recall({profileKey: 'judy-alvarez'});
      const messages = buildMessages({persona, memory: '', history: turns, contextParts: {now: 'NOW', notes: '', world: 'WORLD', volatile: `notes ${i}`}, text: `line ${i}`});
      if (last && lastHistory >= MEMORY_LIMITS.turns) {
        const shared = 1 + lastHistory * 2;   // the system message and the last turn's history
        flags.push(messages.length > shared && last.slice(0, shared).every((message, at) => message.content === messages[at].content));
      }
      last = messages; lastHistory = turns.length;
      memory.record({profileKey: 'judy-alvarez', v: `line ${i}`, r: `reply ${i}`});
    }
    return flags;
  };
  const stepped = await keeps({});
  assert.ok(stepped.length >= 20);
  const share = stepped.filter(Boolean).length / stepped.length;
  assert.ok(share >= MEMORY_LIMITS.slide / (MEMORY_LIMITS.slide + 1) - 0.1, `${Math.round(share * 100)} % of the turns kept the whole history prefix`);
  // The one-at-a-time window (slide 0) never did once it was full: the server read the whole history again on every turn.
  const oneByOne = await keeps({slide: 0});
  assert.equal(oneByOne.filter(Boolean).length, 0);
});
