// A local turn that stalls explains itself (docs/LOCAL_AI.md, "When a local turn fails"): the request's record (headers, first event, first word,
// pieces, prompt progress, thinking), the reason a timeout is given, no retry of a wait, the turn's own time budget (shorter than the game's 90 s),
// the model's loaded file / family / chat template in the log and in the support report, and the notice the game shows.
// The server is the fake llama-server (bridge/fixtures/fake-llama-server.mjs): no model is loaded, no GPU, no game, no sound.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import fengari from 'fengari';
import {streamChat, MistralError, failureDetail, stallReason, newTrace, errorCodeFor, retryable, MIN_ATTEMPT_MS} from './mistral-client.mjs';
import {constants as osConstants} from 'node:os';
import {LlamaProcess, LocalLlmServer, modelFamily, describeTemplate, describeProps, isAmdApu, isIntegratedGpu, parseDeviceList, pickDevice} from './local-llm-server.mjs';
import {TextProviderHost, localRoute, describeLocalTurn, LOCAL_CHAT_LIMITS, LOCAL_TURN_BUDGET_MS, LOCAL_STOP_STRINGS, SLOW_FIRST_WORD_MS} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {MistralProvider, MistralControl} from './mistral-key.mjs';
import {PersonaBook, cleanReply} from './mistral-prompt.mjs';
import {detectLocalAiPack, describePackFiles, packFileProblems} from './local-ai-pack.mjs';
import {detectMaturePack} from './mature-pack.mjs';
import {listLocalModels, describeLocalModels, chooseLocalModel} from './local-model-choice.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-llama-server.mjs', import.meta.url));
const KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
const LOCAL_URL = 'http://127.0.0.1:9/v1/chat/completions';
const encoder = new TextEncoder();
const sleep = ms => new Promise(done => setTimeout(done, ms));

// ---- helpers for the in-process client tests ------------------------------------------------------------------------------------

const chunk = (delta, extra = {}) => `data: ${JSON.stringify({choices: [{index: 0, delta, finish_reason: null}], ...extra})}\n\n`;
const role = () => chunk({role: 'assistant', content: null});
const progress = (processed, total) => chunk({role: 'assistant', content: null}, {prompt_progress: {total, cache: 0, processed, time_ms: processed}});
const piece = text => chunk({content: text});
const thought = text => chunk({reasoning_content: text});
const finish = (reason = 'stop', extra = {}) => `data: ${JSON.stringify({choices: [{index: 0, delta: {}, finish_reason: reason}], ...extra})}\n\n`;
const DONE = 'data: [DONE]\n\n';
/** A response whose stream sends `events` and then stays open (like a server that stopped working) until the request is aborted, as a real body does. */
const open = (events, init, {cancelled} = {}) => ({ok: true, status: 200, headers: new Headers(), body: new ReadableStream({
  start(controller) {
    for (const event of events) controller.enqueue(encoder.encode(event));
    init.signal.addEventListener('abort', () => { try { controller.error(Object.assign(Error('aborted'), {name: 'AbortError'})); } catch { /* closed */ } });
  },
  cancel() { if (cancelled) cancelled.done = true; }})});
const closed = events => ({ok: true, status: 200, headers: new Headers(), body: new ReadableStream({start(controller) { for (const event of events) controller.enqueue(encoder.encode(event)); controller.close(); }})});
const hangs = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), {name: 'AbortError'}))));
const local = options => ({apiKey: KEY, provider: 'local', endpoint: LOCAL_URL, messages: [], retries: 2, backoffMs: [1], sleepImpl: async () => {}, ...options});

test('a reply carries the request\'s record: when the headers, the first word and the pieces came, the prompt progress, the server\'s own timings and the finish reason', async () => {
  const result = await streamChat(local({fetchImpl: async () => closed([progress(256, 1000), progress(1000, 1000), piece('Hey '), piece('V, '), piece('come in.'),
    finish('stop', {timings: {prompt_n: 700, cache_n: 300, prompt_ms: 41, predicted_n: 12, predicted_per_second: 48.5}}), DONE])}));
  const trace = result.trace;
  assert.equal(result.text, 'Hey V, come in.');
  assert.equal(trace.pieces, 3);
  assert.equal(trace.reasoning, 0);
  assert.ok(trace.events >= 7, `events ${trace.events}`);
  assert.ok(trace.headersMs >= 0 && trace.eventMs >= trace.headersMs && trace.firstTokenMs >= trace.eventMs && trace.elapsedMs >= trace.firstTokenMs);
  assert.deepEqual(trace.progress, {processed: 1000, total: 1000, cache: 0});
  assert.deepEqual(trace.timings, {promptTokens: 700, cachedTokens: 300, promptMs: 41, generated: 12, tokensPerSecond: 48.5});
  assert.equal(trace.finishReason, 'stop');
});

test('a server that stops while it reads the prompt is named: how far it got, not retried (a retry would repeat the wait), and the cloud\'s timeouts still are', async () => {
  let calls = 0;
  const error = await streamChat(local({firstByteMs: 30_000, promptStallMs: 60, stallMs: 60, totalMs: 60_000, fetchImpl: async (url, init) => { calls++; return open([progress(100, 1000), progress(300, 1000)], init); }})).catch(e => e);
  assert.equal(calls, 1, 'one attempt: a local timeout is not asked again');
  assert.ok(error instanceof MistralError);
  assert.equal(error.kind, 'network'); assert.equal(error.slow, true); assert.equal(error.noRetry, true); assert.equal(retryable(error), false);
  assert.equal(error.reason, 'prefill-stalled');
  assert.deepEqual(error.trace.progress, {processed: 300, total: 1000, cache: 0});
  assert.match(error.message, /did not finish in time \(prompt read 300 of 1000 tokens/);
  assert.match(failureDetail(error), /^stuck reading the prompt \(300 of 1000 tokens after \d+ s\)$/);
  assert.equal(errorCodeFor(error), 'local-failed');
  assert.equal(error.failed[0].reason, 'prefill-stalled');
  // The same silence on the cloud route (Mistral) is retried as before.
  let cloudCalls = 0;
  await streamChat({apiKey: KEY, messages: [], firstByteMs: 30, retryFirstByteMs: 30, retries: 1, backoffMs: [1], sleepImpl: async () => {}, fetchImpl: async (url, init) => { cloudCalls++; return hangs(url, init); }}).catch(() => {});
  assert.equal(cloudCalls, 2);
});

test('the other ways a request goes quiet each get their own reason: no response, no first word, stopped partway', async () => {
  let calls = 0;
  const none = await streamChat(local({firstByteMs: 40, fetchImpl: async (url, init) => { calls++; return hangs(url, init); }})).catch(e => e);
  assert.equal(none.reason, 'no-response'); assert.equal(calls, 1); assert.match(none.message, /did not answer in time \(no response in \d+ s\)/);
  assert.match(failureDetail(none), /^the model server gave no answer after \d+ s$/);

  const silent = await streamChat(local({firstByteMs: 30_000, promptStallMs: 50, stallMs: 50, fetchImpl: async (url, init) => open([role()], init)})).catch(e => e);
  assert.equal(silent.reason, 'no-first-token');
  assert.match(failureDetail(silent), /^no first word from the model after \d+ s$/);

  const partway = await streamChat(local({firstByteMs: 30_000, promptStallMs: 50, stallMs: 50, fetchImpl: async (url, init) => open([role(), piece('Hey '), piece('V.')], init)})).catch(e => e);
  assert.equal(partway.reason, 'stalled'); assert.equal(partway.trace.pieces, 2);
  assert.match(partway.message, /went quiet before the reply was finished/);
  assert.match(failureDetail(partway), /^the reply stopped after 2 pieces after \d+ s$/);

  assert.equal(stallReason(null), 'no-response');
  assert.equal(stallReason({...newTrace(), headersMs: 5}), 'no-first-token');
  assert.equal(stallReason({...newTrace(), headersMs: 5, reasoning: 3}), 'thinking-only');
  assert.equal(stallReason({...newTrace(), headersMs: 5, reasoning: 3, pieces: 1}), 'stalled');
});

test('any stream event is life: a slow prompt that keeps reporting progress is not cut by stallMs, a silent one is', async () => {
  // Nine progress reports 60 ms apart (about 540 ms in all, more than stallMs), then the reply.
  const slow = init => ({ok: true, status: 200, headers: new Headers(), body: new ReadableStream({start(controller) {
    let step = 0;
    const timer = setInterval(() => {
      step++;
      if (step <= 9) controller.enqueue(encoder.encode(progress(step * 100, 900)));
      else { clearInterval(timer); controller.enqueue(encoder.encode(piece('Finally.') + finish('stop') + DONE)); controller.close(); }
    }, 60);
    init.signal.addEventListener('abort', () => { clearInterval(timer); try { controller.error(Object.assign(Error('aborted'), {name: 'AbortError'})); } catch { /* closed */ } });
  }})});
  const result = await streamChat(local({firstByteMs: 30_000, promptStallMs: 400, stallMs: 400, totalMs: 60_000, fetchImpl: async (url, init) => slow(init)}));
  assert.equal(result.text, 'Finally.');
  assert.deepEqual(result.trace.progress, {processed: 900, total: 900, cache: 0});
});

test('before the first word the silence allowed is promptStallMs, after it stallMs: a slow batch is waited for, a reply that stops is not', async () => {
  const slowStart = init => ({ok: true, status: 200, headers: new Headers(), body: new ReadableStream({start(controller) {
    controller.enqueue(encoder.encode(progress(512, 4000)));
    // 250 ms of silence in the middle of the prompt: more than stallMs, less than promptStallMs.
    const timer = setTimeout(() => { controller.enqueue(encoder.encode(piece('Hey ') + piece('V.') + finish('stop') + DONE)); controller.close(); }, 250);
    init.signal.addEventListener('abort', () => { clearTimeout(timer); try { controller.error(Object.assign(Error('aborted'), {name: 'AbortError'})); } catch { /* closed */ } });
  }})});
  const waited = await streamChat(local({firstByteMs: 30_000, promptStallMs: 2000, stallMs: 80, totalMs: 60_000, fetchImpl: async (url, init) => slowStart(init)}));
  assert.equal(waited.text, 'Hey V.');
  // The same silence after the first word is a stall.
  const stopped = await streamChat(local({firstByteMs: 30_000, promptStallMs: 2000, stallMs: 80, totalMs: 60_000, fetchImpl: async (url, init) => open([piece('Hey ')], init)})).catch(e => e);
  assert.equal(stopped.reason, 'stalled');
  assert.match(stopped.message, /nothing for 0 s after 1 pieces/);
  // Without promptStallMs the two are the same limit, as before.
  const same = await streamChat(local({firstByteMs: 30_000, stallMs: 80, totalMs: 60_000, retries: 0, fetchImpl: async (url, init) => slowStart(init)})).catch(e => e);
  assert.equal(same.reason, 'prefill-stalled');
});

test('a model that thinks instead of answering is stopped after thinkingPieces and says so; one that ends having only thought has the same reason', async () => {
  const cancelled = {done: false};
  let calls = 0;
  const error = await streamChat(local({thinkingPieces: 5, firstByteMs: 30_000, fetchImpl: async (url, init) => { calls++; return open([role(), ...Array.from({length: 12}, () => thought('hmm '))], init, {cancelled}); }})).catch(e => e);
  assert.equal(error.kind, 'empty'); assert.equal(error.reason, 'thinking-only'); assert.equal(error.noRetry, true);
  assert.equal(calls, 1); assert.equal(cancelled.done, true, 'the stream was cancelled, not read to the end');
  assert.equal(error.trace.reasoning, 5);
  assert.match(failureDetail(error), /^the model wrote only thinking and no reply$/);
  assert.equal(errorCodeFor(error), 'local-failed');

  const ended = await streamChat(local({retries: 0, fetchImpl: async () => closed([role(), thought('a '), thought('b '), finish('length'), DONE])})).catch(e => e);
  assert.equal(ended.kind, 'empty'); assert.equal(ended.reason, 'thinking-only'); assert.equal(ended.trace.finishReason, 'length');
  // Thinking that comes before an answer is fine: the answer is what is returned.
  const fine = await streamChat(local({thinkingPieces: 5, fetchImpl: async () => closed([thought('a '), thought('b '), piece('Here.'), finish('stop'), DONE])}));
  assert.equal(fine.text, 'Here.'); assert.equal(fine.trace.reasoning, 2);
  // An empty answer with no thinking is the old error.
  const nothing = await streamChat(local({retries: 0, fetchImpl: async () => closed([role(), finish('stop'), DONE])})).catch(e => e);
  assert.equal(nothing.kind, 'empty'); assert.equal(nothing.reason, undefined);
  assert.match(failureDetail(nothing), /^the model gave an empty reply$/);
});

test('the turn\'s deadline: an attempt is cut to what is left and none starts with too little, the explanation says the time was out', async () => {
  let clock = 1000, calls = 0;
  const now = () => clock;
  // No time left at all: the model is not asked.
  const late = await streamChat(local({now, deadlineAt: clock + MIN_ATTEMPT_MS - 1, fetchImpl: async () => { calls++; return closed([piece('x'), DONE]); }})).catch(e => e);
  assert.equal(calls, 0);
  assert.equal(late.deadline, true); assert.equal(late.reason, 'no-response');
  assert.match(late.message, /ran out of time before the model could be asked/);
  assert.match(failureDetail(late), /^ran out of the turn's time: the model server gave no answer$/);
  // An attempt whose own limits are generous is cut at the deadline (the clock is the real one here: the remaining time is about 150 ms).
  const real = () => performance.now();
  const began = real();
  const cut = await streamChat(local({now: real, deadlineAt: real() + 150, minAttemptMs: 20, firstByteMs: 60_000, totalMs: 60_000, stallMs: 60_000, retries: 2, fetchImpl: async (url, init) => open([role()], init)})).catch(e => e);
  assert.ok(real() - began < 30_000, 'cut at the deadline, not at the limits');
  assert.equal(cut.deadline, true);
  assert.equal(cut.reason, 'no-first-token');
  assert.match(failureDetail(cut), /^ran out of the turn's time: no first word from the model after \d+ s$/);
  // Without a deadline nothing changes.
  const plain = await streamChat(local({fetchImpl: async () => closed([piece('Fine.'), finish('stop'), DONE])}));
  assert.equal(plain.text, 'Fine.');
});

test('failureDetail: one plain sentence per way a local turn fails, nothing for another provider\'s error, never a path or a key', () => {
  const mk = (kind, options = {}) => new MistralError(kind, 'x', {provider: 'local', ...options});
  assert.equal(failureDetail(new MistralError('network', 'x', {provider: 'mistral', reason: 'stalled'})), undefined);
  assert.equal(failureDetail(Error('plain')), undefined);
  assert.equal(failureDetail(mk('network', {reason: 'loading', trace: {...newTrace(), elapsedMs: 79600}})), 'the model was still loading after 80 s (a first start compiles shaders for a minute or two)');
  const overflow = mk('request'); overflow.overflow = {promptTokens: 9000, contextTokens: 8192};
  assert.equal(failureDetail(overflow), 'the prompt (9000 tokens) does not fit the model\'s context (8192)');
  assert.equal(failureDetail(mk('empty', {trace: {...newTrace(), finishReason: 'length'}})), 'the model ran out of tokens before it said anything');
  assert.equal(failureDetail(mk('network', {status: 503})), 'the model server refused the request (HTTP 503)');
  assert.equal(failureDetail(mk('network')), 'the model server could not be reached or went away');
  for (const text of [failureDetail(overflow), failureDetail(mk('network'))]) assert.doesNotMatch(text, /[\\/]|aB3dE6/);
});

// ---- the supervisor's record of what is loaded ----------------------------------------------------------------------------------

const DEVICES = 'Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4080 Laptop GPU (11997 MiB, 11229 MiB free)\n';
const TEMPLATE = '{#\n  Template: Google Gemma 4 Canonical Chat Template\n#}{%- for message in messages -%}<|turn>{{ message.role }}\n{{ message.content }}<turn|>\n{%- endfor -%}';

function rig(t, {env = {}, names = {}, processExtra = {}, ...options} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'local-turn-diag-'));
  const write = name => { const path = join(directory, name); writeFileSync(path, name); return path; };
  const pack = {installed: true, missing: [], root: directory, server: write('llama-server.exe'),
    tiers: {standard: {file: write(names.file ?? 'Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf'), name: names.name ?? 'Gemma 4 E4B · uncensored'}, lite: null},
    embed: {file: write('embed.gguf'), dim: 8, id: 'fake-embed'}, dev: false};
  const children = [];
  const spawnImpl = (command, args, spawnOptions) => { const child = spawn(command, args, spawnOptions); children.push(child); return child; };
  const tmpDir = join(directory, 'tmp');
  mkdirSync(tmpDir);
  const logs = [];
  const server = new LocalLlmServer({pack, listDevices: async () => DEVICES, freeVramMiB: () => null, fileSizeMiB: () => 5088, command: process.execPath, argsPrefix: [FAKE],
    spawnImpl, log: line => logs.push(line), backoffMs: 10, startupMs: 180_000, warmup: false, contextSize: 16384, processOptions: {env, tmpDir, pollMs: 20, ...processExtra}, ...options});
  t.after(async () => { await server.stop(); for (const child of children) if (child.exitCode === null) child.kill(); rmSync(directory, {recursive: true, force: true}); });
  return {server, directory, logs, pack};
}

test('modelFamily, describeTemplate and describeProps: what the diagnostics keep of a model and of /props', () => {
  assert.equal(modelFamily({family: 'gemma-4', name: 'x'}), 'gemma-4');
  assert.equal(modelFamily({name: 'Gemma 4 E4B · uncensored'}), 'gemma-4');
  assert.equal(modelFamily({name: 'Gemma 3 12B'}), 'gemma');
  assert.equal(modelFamily({name: 'Qwen3.5-4B · uncensored'}), 'qwen');
  assert.equal(modelFamily({file: 'C:\\Games\\models\\Ternary-Bonsai-2-4B-Q2_0.gguf'}), 'bonsai');
  assert.equal(modelFamily({name: 'Something'}), null);
  const info = describeTemplate(TEMPLATE);
  assert.equal(info.chars, TEMPLATE.length);
  assert.match(info.sha, /^[0-9a-f]{8}$/);
  assert.equal(info.head.length <= 60, true); assert.doesNotMatch(info.head, /[\r\n]/);
  assert.equal(describeTemplate(''), null); assert.equal(describeTemplate(undefined), null);
  const props = describeProps({chat_template: TEMPLATE, bos_token: '<bos>', eos_token: '<eos>', build_info: 'b11560-abc', model_ftype: 'Q4_K_M', model_path: 'C:\\Users\\someone\\secret.gguf', media_marker: 'x'});
  assert.deepEqual(Object.keys(props).sort(), ['bos', 'build', 'eos', 'ftype', 'template']);
  assert.equal(props.eos, '<eos>');
  assert.deepEqual(describeProps(null), {});
});

test('after the start the supervisor can say which file is loaded, its family, its chat template (length, hash, first words, where it came from), eos and build, with no path', async t => {
  const {server, logs, directory} = rig(t, {env: {FAKE_LLAMA_TEMPLATE: TEMPLATE, FAKE_LLAMA_EOS: '<eos>', FAKE_LLAMA_BOS: '<bos>', FAKE_LLAMA_BUILD: 'b11560-test'}});
  assert.equal(server.diagnostics(), null, 'nothing loaded yet');
  await server.ensure();
  const d = server.diagnostics();
  assert.equal(d.state, 'ready');
  assert.equal(d.model.file, 'Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf');
  assert.equal(d.model.name, 'Gemma 4 E4B · uncensored');
  assert.equal(d.model.family, 'gemma-4'); assert.equal(d.model.id, 'standard'); assert.equal(d.model.sizeMiB, 5088); assert.equal(d.model.offload, false);
  assert.equal(d.template.source, 'gguf'); assert.equal(d.template.chars, TEMPLATE.length); assert.match(d.template.sha, /^[0-9a-f]{8}$/); assert.match(d.template.head, /^\{# Template: Google Gemma 4/);
  assert.deepEqual(d.tokens, {bos: '<bos>', eos: '<eos>'});
  assert.equal(d.engine.build, 'b11560-test'); assert.equal(d.engine.contextSize, 16384); assert.equal(d.engine.device.id, 'Vulkan0');
  assert.ok(d.engine.ram.totalMiB > 0 && d.engine.ram.freeMiB > 0 && d.engine.ram.freeMiB <= d.engine.ram.totalMiB, 'the system memory at the start (a model whose tables are mapped from disk slows down when it is short)');
  assert.equal(d.start.firstTime, false); assert.ok(d.start.loadMs >= 0); assert.match(d.start.readyAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(d.turns, {ok: 0, failed: 0}); assert.equal(d.lastTurn, null); assert.equal(d.lastExit, null);
  assert.equal(d.engine.priority, 'below-normal', 'the server leaves the CPU to the game: on a machine with none to spare that is why it can be slow');
  const text = JSON.stringify(d);
  assert.equal(text.includes(directory), false, 'no path');
  assert.doesNotMatch(text, /api-key|Bearer/);
  const line = logs.find(entry => entry.startsWith('[local] model ready:'));
  assert(line, 'the log says what is loaded');
  assert.match(line, /file Gemma4-E4B-MiniFantasy-V1-Q4_K_M\.gguf/); assert.match(line, /family gemma-4/); assert.match(line, /process priority normal while it loaded, below normal now/); assert.match(line, /template gguf \d+ chars sha [0-9a-f]{8}/); assert.match(line, /eos <eos>/); assert.match(line, /context 16384/);
  assert.equal(line.includes(directory), false);
});

test('a server that reports no template says so; a model with its own template flag names the flag', async t => {
  const plain = rig(t);
  await plain.server.ensure();
  assert.deepEqual(plain.server.diagnostics().template, {source: 'not reported'});
  const flagged = rig(t, {customModels: undefined});
  flagged.pack.tiers.standard = {file: flagged.pack.tiers.standard.file, name: 'My model'};
  // A custom model is described by listLocalModels; here the flag is checked through the selection hook.
  const custom = new LocalLlmServer({pack: flagged.pack, listDevices: async () => DEVICES, freeVramMiB: () => null, fileSizeMiB: () => 3000, command: process.execPath, argsPrefix: [FAKE],
    log: () => {}, warmup: false, contextSize: 8192, startupMs: 180_000, processOptions: {env: {FAKE_LLAMA_TEMPLATE: TEMPLATE}, pollMs: 20},
    selection: () => ({pin: 'custom:mine', matureOn: false, matureModels: [], customModels: [{id: 'custom:mine', name: 'Mine', file: flagged.pack.tiers.standard.file, family: 'gemma', chatTemplate: 'gemma', contextSize: null, uncensored: false}]})});
  t.after(() => custom.stop());
  await custom.ensure();
  const d = custom.diagnostics();
  assert.equal(d.template.source, 'flag:gemma'); assert.equal(d.template.chars, TEMPLATE.length);
  assert.equal(d.model.custom, true); assert.equal(d.model.family, 'gemma');
});

test('noteTurn keeps the last turn and the counts, says which turn was the first since the load, and raises "diagnostics" for a failure and the first turn only', async t => {
  const {server} = rig(t);
  await server.ensure();
  const events = [];
  server.on('diagnostics', value => events.push(value));
  const trace = {headersMs: 40, eventMs: 900, firstTokenMs: 910, pieces: 20, reasoning: 0, elapsedMs: 1500, progress: null, finishReason: 'stop', timings: {promptTokens: 4800, cachedTokens: 0, tokensPerSecond: 34.04}};
  assert.deepEqual(server.noteTurn({ok: true, trace}), {first: true});
  assert.equal(events.length, 1, 'the first turn is published');
  assert.deepEqual(server.noteTurn({ok: true, trace}), {first: false});
  assert.equal(events.length, 1, 'an ordinary turn is not');
  const error = new MistralError('network', 'x', {provider: 'local', reason: 'no-first-token', trace: {...trace, firstTokenMs: null, pieces: 0}});
  assert.deepEqual(server.noteTurn({ok: false, error, detail: 'no first word from the model after 60 s'}), {first: false});
  assert.equal(events.length, 2, 'a failure is published');
  const d = server.diagnostics();
  assert.deepEqual(d.turns, {ok: 2, failed: 1});
  assert.equal(d.lastTurn.ok, false); assert.equal(d.lastTurn.reason, 'no-first-token'); assert.equal(d.lastTurn.detail, 'no first word from the model after 60 s');
  assert.equal(d.lastTurn.firstWordMs, null); assert.equal(d.lastTurn.headersMs, 40);
  assert.equal(events.at(-1).lastTurn.reason, 'no-first-token');
  // The next load starts the count again.
  await server.stop();
  await server.ensure();
  assert.deepEqual(server.noteTurn({ok: true, trace}), {first: true});
  assert.deepEqual(server.noteTurn(), {first: false}, 'garbage never throws');
});

test('a server that does not start leaves its last output in the log, and one that dies later leaves its exit code in the diagnostics', async t => {
  const dead = rig(t, {env: {FAKE_LLAMA_EXIT_AT_START: '3'}});
  await assert.rejects(dead.server.ensure(), /start-failed|did not start/i);
  assert(dead.logs.some(line => /did not start: exited .*Gemma4-E4B-MiniFantasy-V1-Q4_K_M\.gguf, context 16384/.test(line)), dead.logs.join('\n'));
  assert(dead.logs.some(line => /last llama-server output \(it did not start\): .*fake-llama: exiting at start/.test(line)), dead.logs.join('\n'));
  assert.equal(dead.logs.some(line => line.includes(dead.directory + '\\tmp') && /api-key/.test(line)), false, 'the key file is not in the output');

  const crashing = rig(t, {env: {FAKE_LLAMA_CRASH_AFTER: '1'}, maxRestarts: 0});
  await crashing.server.ensure();
  await crashing.server.prewarm([{role: 'user', content: 'hi'}]);
  for (let wait = 0; wait < 400 && !crashing.server.diagnostics().lastExit; wait++) await sleep(50);
  const d = crashing.server.diagnostics();
  assert.equal(d.lastExit.code, 7);
  assert(crashing.logs.some(line => /llama-server stopped unexpectedly \(exit 7\)/.test(line)), crashing.logs.join('\n'));
});

test('an AMD APU never wins the pick over a graphics card (it reports as much memory as the system), but is still used when it is all there is; the log names the devices', async t => {
  for (const name of ['AMD Radeon(TM) Graphics', 'Radeon(TM) Graphics', 'AMD Radeon(TM) 780M Graphics', 'AMD Radeon(TM) 680M', 'AMD Radeon 660M', 'AMD Radeon(TM) Vega 8 Graphics'])
    assert.equal(isAmdApu(name), true, name);
  for (const name of ['AMD Radeon RX 7900 XTX', 'AMD Radeon RX 6600M', 'AMD Radeon(TM) RX 580 Series', 'AMD Radeon Pro W7800', 'AMD Radeon RX 7600 XT', 'NVIDIA GeForce RTX 4080 Laptop GPU', 'Intel(R) Arc(TM) A770 Graphics'])
    assert.equal(isAmdApu(name), false, name);
  const laptop = parseDeviceList('  Vulkan0: AMD Radeon(TM) Graphics (16384 MiB, 15000 MiB free)\n  Vulkan1: NVIDIA GeForce RTX 4060 Laptop GPU (8188 MiB, 7000 MiB free)');
  assert.equal(pickDevice(laptop).id, 'Vulkan1', 'the card, though the APU reports twice its memory');
  assert.equal(pickDevice(laptop.slice(0, 1)).id, 'Vulkan0', 'the only device is used, as before');
  assert.equal(pickDevice(parseDeviceList('  Vulkan0: Intel(R) UHD Graphics (16000 MiB)\n  Vulkan1: AMD Radeon(TM) 780M Graphics (8000 MiB)')).id, 'Vulkan1');
  assert.equal(pickDevice(parseDeviceList('  Vulkan0: AMD Radeon(TM) Graphics (16384 MiB)\n  Vulkan1: AMD Radeon RX 7600M XT (8176 MiB)\n  Vulkan2: AMD Radeon(TM) 780M Graphics (20000 MiB)')).id, 'Vulkan1');
  assert.equal(isIntegratedGpu('Intel(R) RaptorLake-S Mobile Graphics Controller'), true, 'the iGPU of the developer laptop');
  const {server, logs} = rig(t, {listDevices: async () => 'Available devices:\n  Vulkan0: AMD Radeon(TM) Graphics (16384 MiB, 15000 MiB free)\n  Vulkan1: NVIDIA GeForce RTX 4060 Laptop GPU (8188 MiB, 7000 MiB free)\n  Vulkan2: Intel(R) UHD Graphics (1024 MiB)\n'});
  await server.ensure();
  assert.equal(server.diagnostics().engine.device.id, 'Vulkan1');
  const line = logs.find(entry => entry.startsWith('[local] graphics devices:'));
  assert.equal(line, '[local] graphics devices: Vulkan0 AMD Radeon(TM) Graphics (16384 MiB, integrated AMD: last resort); Vulkan1 NVIDIA GeForce RTX 4060 Laptop GPU (8188 MiB); Vulkan2 Intel(R) UHD Graphics (1024 MiB, integrated: not used); using Vulkan1');
});

// ---- the host: a stalled local turn fails inside its budget and explains itself --------------------------------------------------

const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);
const turn = (text, extra = {}) => ({text, context: 'CURRENT PERSON\nQuest facts here.', sessionId: 'session-1',
  local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'},
  contextParts: {now: 'Right now (from the game, this turn only): you are with V in Kabuki, it is night.', notes: '', world: 'WORLD FACTS\n- a fact', worldBlocks: [{key: 'knowledge', text: 'WORLD FACTS\n- a fact'}], volatile: ''}, ...extra});

// preload: the model is loaded before the first turn, so the turn's own budget is not spent on starting the fake server (a computer with no CPU to spare takes minutes
// for that); the test of a model that is still loading turns it off.
async function hostRig(t, {env = {}, limits = {}, budgetMs, names, serverOptions = {}, preload = true} = {}) {
  const {server, logs, directory} = rig(t, {env, names, ...serverOptions});
  if (preload) await server.ensure();
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => '', writeText: async () => {}});
  await provider.load(); provider.setPreference('local'); provider.apply();
  const route = localRoute({server, provider, log: line => logs.push(line)});
  route.chatDefaults = {...route.chatDefaults, retries: 1, backoffMs: [1], ...limits};
  if (budgetMs !== undefined) route.turnBudgetMs = budgetMs;
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: book, routes: {local: route}, log: line => logs.push(line)});
  t.after(() => host.close());
  return {host, server, route, logs, directory};
}

test('the local route\'s limits end a turn before the game gives up on it (90 s), and the route asks for what it needs from its own server only', () => {
  assert.ok(LOCAL_TURN_BUDGET_MS <= 80_000, 'the game waits 90 s (mod/init.lua) and then shows only a generic notice');
  assert.ok(LOCAL_CHAT_LIMITS.totalMs <= LOCAL_TURN_BUDGET_MS);
  assert.ok(LOCAL_CHAT_LIMITS.firstByteMs < LOCAL_CHAT_LIMITS.totalMs);
  assert.ok(LOCAL_CHAT_LIMITS.stallMs > 0, 'a stream that goes quiet is cut');
  assert.ok(LOCAL_CHAT_LIMITS.promptStallMs >= LOCAL_CHAT_LIMITS.stallMs && LOCAL_CHAT_LIMITS.promptStallMs <= LOCAL_CHAT_LIMITS.totalMs, 'a slow prompt gets more patience than a writing model, and never more than the attempt');
  assert.ok(LOCAL_CHAT_LIMITS.thinkingPieces > 0);
  assert.deepEqual([...LOCAL_STOP_STRINGS], ['<turn|>', '<|turn>', '<end_of_turn>', '<start_of_turn>', '<|im_end|>', '<|im_start|>']);
  const route = localRoute({server: {ensure: async () => ({}), status: () => ({state: 'ready'})}});
  assert.equal(route.chatDefaults, LOCAL_CHAT_LIMITS);
  assert.equal(route.turnBudgetMs, LOCAL_TURN_BUDGET_MS);
  const own = route.leaseBody({external: false});
  assert.deepEqual(own, {return_progress: true, stop: [...LOCAL_STOP_STRINGS], chat_template_kwargs: {enable_thinking: false}});
  assert.deepEqual(route.leaseBody({external: true}), {}, 'a server the player runs gets no field it may not know');
  // The source of the game's deadline is the number this one has to stay under.
  const lua = readFileSync(fileURLToPath(new URL('../mod/init.lua', import.meta.url)), 'utf8');
  assert.match(lua, /os\.time\(\) - pending\.sentAt >= 90/);
});

test('a request to our own llama-server carries return_progress, the stop strings and enable_thinking false', async t => {
  const bodies = join(tmpdir(), 'local-turn-bodies-' + process.pid + '.jsonl');
  rmSync(bodies, {force: true}); t.after(() => rmSync(bodies, {force: true}));
  const {host} = await hostRig(t, {env: {FAKE_LLAMA_BODIES_FILE: bodies, FAKE_LLAMA_FIRST_TOKEN_MS: '1', FAKE_LLAMA_REPLY: 'Sure, V.'}});
  const reply = await host.reply(turn('hello there'));
  assert.equal(reply.text, 'Sure, V.');
  const sent = readFileSync(bodies, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].return_progress, true);
  assert.deepEqual(sent[0].stop, [...LOCAL_STOP_STRINGS]);
  assert.deepEqual(sent[0].chat_template_kwargs, {enable_thinking: false});
  assert.deepEqual(sent[0].stream_options, {include_usage: true});
});

test('a server that reads the prompt for a while and then stops: the turn fails at the stall limit, names what happened, logs the model and the template, and the next turn is not blocked', async t => {
  const {host, server, logs} = await hostRig(t, {env: {FAKE_LLAMA_TEMPLATE: TEMPLATE, FAKE_LLAMA_STALL: 'progress'}, limits: {promptStallMs: 120, stallMs: 120, firstByteMs: 30_000, totalMs: 60_000}});
  const began = performance.now();
  const error = await host.reply(turn('hello there')).catch(e => e);
  assert.ok(performance.now() - began < 30_000, 'cut at stallMs, not at the 90 s of before');
  assert.ok(error instanceof MistralError); assert.equal(error.reason, 'prefill-stalled');
  assert.equal(error.failed.length, 1, 'not asked again');
  assert.equal(errorCodeFor(error), 'local-failed');
  const line = logs.find(entry => entry.startsWith('[LocalTurn] FAILED'));
  assert(line, logs.join('\n'));
  assert.match(line, /stuck reading the prompt \(\d+ of \d+ tokens after \d+ s\) \(prefill-stalled\)/);
  assert.match(line, /headers \d+ ms, first event \d+ ms, first word -, 0 pieces, 0 thinking pieces, prompt read \d+ of \d+ tokens/);
  assert.match(line, /model Gemma4-E4B-MiniFantasy-V1-Q4_K_M\.gguf \(gemma-4\)/);
  assert.match(line, /template gguf \d+ chars sha [0-9a-f]{8}/);
  assert.match(line, /context 16384, server ready, loaded in [\d.]+ s/);
  assert.match(line, /attempts: prefill-stalled \d+ ms/);
  const d = server.diagnostics();
  assert.deepEqual(d.turns, {ok: 0, failed: 1});
  assert.equal(d.lastTurn.reason, 'prefill-stalled'); assert.match(d.lastTurn.detail, /stuck reading the prompt/); assert.match(d.lastTurn.promptProgress, /^\d+\/\d+$/);
});

test('a model that thinks forever fails fast with its own reason, a stall before any word with another', async t => {
  const thinker = await hostRig(t, {env: {FAKE_LLAMA_THINK: '400'}, limits: {thinkingPieces: 10, firstByteMs: 30_000, totalMs: 60_000}});
  const began = performance.now();
  const error = await thinker.host.reply(turn('hello there')).catch(e => e);
  assert.ok(performance.now() - began < 30_000);
  assert.equal(error.reason, 'thinking-only'); assert.equal(error.kind, 'empty');
  assert(thinker.logs.some(entry => /^\[LocalTurn\] FAILED: the model wrote only thinking and no reply \(thinking-only\)/.test(entry)), thinker.logs.join('\n'));
  assert.equal(errorCodeFor(error), 'local-failed');

  const silent = await hostRig(t, {env: {FAKE_LLAMA_STALL: 'role'}, limits: {promptStallMs: 100, stallMs: 100, firstByteMs: 30_000, totalMs: 60_000}});
  const quiet = await silent.host.reply(turn('hello there')).catch(e => e);
  assert.equal(quiet.reason, 'no-first-token');
  assert(silent.logs.some(entry => /^\[LocalTurn\] FAILED: no first word from the model after \d+ s \(no-first-token\)/.test(entry)), silent.logs.join('\n'));
});

test('a reply that stops partway is a failure with its pieces counted, never a half reply', async t => {
  const {host, logs} = await hostRig(t, {env: {FAKE_LLAMA_STALL: 'mid', FAKE_LLAMA_REPLY: 'One two three four five six.'}, limits: {stallMs: 100, firstByteMs: 30_000, totalMs: 60_000}});
  const error = await host.reply(turn('hello there')).catch(e => e);
  assert.equal(error.reason, 'stalled'); assert.equal(error.trace.pieces, 2);
  assert(logs.some(entry => /^\[LocalTurn\] FAILED: the reply stopped after 2 pieces after \d+ s \(stalled\).*2 pieces/.test(entry)), logs.join('\n'));
});

test('the turn budget covers the whole turn: when it is spent no request is sent, and the deadline is passed to every request', async t => {
  const {host, route, logs} = await hostRig(t, {env: {FAKE_LLAMA_REPLY: 'Fine, V.'}});
  const seen = [];
  const chat = route.chat;
  route.chat = options => { seen.push({deadlineAt: options.deadlineAt, now: typeof options.now, thinkingPieces: options.thinkingPieces, stallMs: options.stallMs, firstByteMs: options.firstByteMs, totalMs: options.totalMs}); return chat(options); };
  const before = performance.now();
  const reply = await host.reply(turn('hello there'));
  assert.equal(reply.text, 'Fine, V.');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].now, 'function');
  assert.ok(seen[0].deadlineAt >= before + LOCAL_TURN_BUDGET_MS - 1000 && seen[0].deadlineAt <= performance.now() + LOCAL_TURN_BUDGET_MS, 'started + the budget');
  assert.equal(seen[0].thinkingPieces, LOCAL_CHAT_LIMITS.thinkingPieces); assert.equal(seen[0].stallMs, LOCAL_CHAT_LIMITS.stallMs);
  // A budget already spent: the model is never asked, and the failure says the time was out.
  route.turnBudgetMs = 1;
  const error = await host.reply(turn('and again')).catch(e => e);
  assert.equal(error.deadline, true);
  assert(logs.some(entry => /^\[LocalTurn\] FAILED: ran out of the turn's time/.test(entry)), logs.join('\n'));
});

test('a model that is still loading when the budget ends: the turn says so at once, the load goes on, and the next turn is answered', async t => {
  const {host, route, server, logs} = await hostRig(t, {env: {FAKE_LLAMA_DELAY_MS: '3000', FAKE_LLAMA_REPLY: 'Ready now, V.'}, preload: false});
  route.turnBudgetMs = 600;
  const began = performance.now();
  const error = await host.reply(turn('hello there')).catch(e => e);
  assert.notEqual(server.status().state, 'ready', 'the turn ended while the model was still loading');
  assert.ok(performance.now() - began < 30_000);
  assert.equal(error.reason, 'loading'); assert.equal(error.noRetry, true); assert.equal(errorCodeFor(error), 'local-failed');
  assert(logs.some(entry => /^\[LocalTurn\] FAILED: the model was still loading after \d+ s/.test(entry)), logs.join('\n'));
  // The load was not stopped by that: a later turn finds the model, with a normal budget.
  route.turnBudgetMs = 90_000;
  const later = await host.reply(turn('hello again'));
  assert.equal(later.text, 'Ready now, V.');
  assert.equal(server.status().state, 'ready');
});

test('the first turn after a load is logged with its numbers, so is a slow first word, an ordinary turn is not', async t => {
  const {host, logs} = await hostRig(t, {env: {FAKE_LLAMA_TEMPLATE: TEMPLATE, FAKE_LLAMA_FIRST_TOKEN_MS: '5', FAKE_LLAMA_REPLY: 'Sure thing, V.'}});
  await host.reply(turn('first'));
  const first = logs.filter(entry => entry.startsWith('[LocalTurn] ok'));
  assert.equal(first.length, 1);
  assert.match(first[0], /^\[LocalTurn\] ok \(first turn since the model was loaded\): first word \d+ ms, 3 pieces, 50 tokens\/s, prompt \d+ new \+ 0 cached tokens, took \d+ ms \| model Gemma4-E4B/);
  await host.reply(turn('second'));
  assert.equal(logs.filter(entry => entry.startsWith('[LocalTurn] ok')).length, 1, 'the second, fast turn is not logged');
  assert.equal(SLOW_FIRST_WORD_MS, 8000);
});

test('describeLocalTurn: a failed turn and a good one in one line each, with the model when it is known and without when it is not', () => {
  const diagnostics = {state: 'ready', model: {file: 'x.gguf', name: 'X', family: 'qwen', offload: true}, template: {source: 'flag:gemma', chars: 99, sha: 'deadbeef'}, engine: {contextSize: 8192}, start: {loadMs: 41600}};
  const error = new MistralError('network', 'x', {provider: 'local', reason: 'no-first-token', trace: {...newTrace(), headersMs: 12, elapsedMs: 60000, pieces: 0}});
  error.failed = [{kind: 'network', reason: 'no-first-token', ms: 60001}];
  const line = describeLocalTurn({ok: false, error, detail: failureDetail(error), diagnostics});
  assert.match(line, /^\[LocalTurn\] FAILED: no first word from the model after 60 s \(no-first-token\): headers 12 ms, first event -, first word -, 0 pieces, 0 thinking pieces, took 60000 ms; attempts: no-first-token 60001 ms \| model x\.gguf \(qwen, part on the CPU\), template flag:gemma 99 chars sha deadbeef, context 8192, server ready, loaded in 41\.6 s$/);
  assert.match(describeLocalTurn({ok: false, error: Error('boom'), diagnostics: null}), /^\[LocalTurn\] FAILED: boom \(error\):.* \| model unknown$/);
  assert.match(describeLocalTurn({ok: true, trace: {...newTrace(), firstTokenMs: 346, pieces: 50, elapsedMs: 1895, timings: {promptTokens: 322, cachedTokens: 4579, tokensPerSecond: 32.5}}, diagnostics}),
    /^\[LocalTurn\] ok: first word 346 ms, 50 pieces, 32\.5 tokens\/s, prompt 322 new \+ 4579 cached tokens, took 1895 ms \| model x\.gguf/);
});

// ---- the game's notice, the status file and the support report ---------------------------------------------------------------------

test('the bridge sends the reason with a failed local turn, and the status file and the support report carry the diagnostics', async () => {
  const bridge = await readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /failureDetail as localFailureDetail/);
  assert.match(bridge, /errorCode === 'local-failed' \? localFailureDetail\(error\) : undefined/);
  assert.match(bridge, /return errorCode \? \{errorCode, \.\.\.\(errorDetail \? \{errorDetail\} : \{\}\)\} : \{\};/);
  assert.match(bridge, /localDiagnostics: \(\) => localServer\.diagnostics\(\)/);
  assert.match(bridge, /localServer\.on\('diagnostics'/);
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => '', writeText: async () => {}});
  await provider.load();
  const diag = {model: {file: 'x.gguf'}, lastTurn: {ok: false, reason: 'stalled'}};
  const control = new MistralControl({provider, commandPath: 'c.json', publish: async () => {}, localDiagnostics: () => diag});
  assert.deepEqual(control.status().localDiagnostics, diag);
  const none = new MistralControl({provider, commandPath: 'c.json', publish: async () => {}, localDiagnostics: () => null});
  assert.equal('localDiagnostics' in none.status(), false, 'absent until a model was loaded');
  assert.equal('localDiagnostics' in new MistralControl({provider, commandPath: 'c.json', publish: async () => {}}).status(), false);
});

test('the support report copies the diagnostics as plain data: short strings, numbers and nested objects, nothing else', async () => {
  const {localAiSection} = await import('./support-report.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'local-turn-report-'));
  try {
    const runtime = join(directory, 'runtime');
    mkdirSync(runtime, {recursive: true});
    writeFileSync(join(runtime, 'mistral-state.json'), JSON.stringify({version: 1, localAi: 'ready', localDiagnostics: {
      model: {file: 'Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf', family: 'gemma-4', sizeMiB: 5088, offload: false}, template: {source: 'gguf', chars: 16804, sha: '1a2b3c4d', head: 'x'.repeat(500)},
      lastTurn: {ok: false, reason: 'no-first-token', detail: 'no first word from the model after 60 s', headersMs: 12, firstWordMs: null}, notAnObject: ['a', 'b'], deep: {a: {b: {c: {d: {e: {f: 1}}}}}}}}));
    const section = await localAiSection({runtime, project: directory, environment: {}});
    assert.equal(section.diagnostics.model.file, 'Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf');
    assert.equal(section.diagnostics.template.chars, 16804);
    assert.equal(section.diagnostics.template.head.length, 200, 'long text is clipped');
    assert.equal(section.diagnostics.lastTurn.reason, 'no-first-token'); assert.equal(section.diagnostics.lastTurn.firstWordMs, null);
    assert.deepEqual(section.diagnostics.notAnObject, ['a', 'b'], 'a short list is copied');
    assert.deepEqual(section.diagnostics.deep.a.b.c.d, {}, 'nested deeper than six levels is cut');
    writeFileSync(join(runtime, 'mistral-state.json'), JSON.stringify({version: 1, localAi: 'ready'}));
    assert.equal((await localAiSection({runtime, project: directory, environment: {}})).diagnostics, null);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

// ---- replies: the end-of-turn markers and Gemma's thought channel never reach the player ------------------------------------------

test('a reply ends at the first end-of-turn or turn-start marker, and a Gemma thought channel is removed', () => {
  assert.equal(cleanReply('Hey V, come in.<turn|>\n<|turn>user\nhello'), 'Hey V, come in.');
  assert.equal(cleanReply('Fine.<end_of_turn>\n<start_of_turn>user\nmore'), 'Fine.');
  assert.equal(cleanReply('Sure.<|im_end|><|im_start|>assistant\nmore'), 'Sure.');
  assert.equal(cleanReply('<|channel>thought\nThe user wants a greeting.<channel|>Hey V.'), 'Hey V.');
  assert.equal(cleanReply('Hey V.<|channel>thought\nstill thinking'), 'Hey V.', 'an unfinished thought goes too');
  assert.equal(cleanReply('<think>hmm</think>Hey V.'), 'Hey V.', 'the older think block still goes');
  assert.equal(cleanReply('Nothing special here, choom.'), 'Nothing special here, choom.');
});

// ---- the game's notice (mod/init.lua) -----------------------------------------------------------------------------------------------

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
function runLua(code) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  if (lauxlib.luaL_dostring(L, to_luastring(code)) !== lua.LUA_OK) throw Error(to_jsstring(lua.lua_tostring(L, -1)));
  const kind = lua.lua_type(L, -1);
  return kind === lua.LUA_TSTRING ? to_jsstring(lua.lua_tostring(L, -1)) : kind === lua.LUA_TBOOLEAN ? lua.lua_toboolean(L, -1) : null;
}

test('the notice for a failed local turn is the translated sentence plus the bridge\'s reason, and only a short plain one', async () => {
  const source = await readFile(new URL('../mod/init.lua', import.meta.url), 'utf8');
  const start = source.indexOf('local function localFailureSuffix(reply)');
  const end = source.indexOf('-- A turn the local AI could not answer and the player\'s cloud provider did');
  assert.ok(start > 0 && end > start, 'the helper and the branch are in mod/init.lua');
  // The helper and the whole keyReplyNotice head are run as written, with a stand-in for the translation function.
  const helper = source.slice(start, source.indexOf('-- id and text of the notice a reply calls for'));
  const branch = source.slice(source.indexOf('if reply.errorCode == \'local-failed\' then'), end);
  const code = `local ui = {t = function(text) return 'T(' .. text .. ')' end}\n${helper}\nlocal function notice(reply)\n${branch}\nreturn nil\nend\n`;
  const run = reply => runLua(`${code}\nlocal id, text = notice(${reply})\nreturn id .. '|' .. text`);
  assert.equal(run('{errorCode = \'local-failed\', errorDetail = \'no first word from the model after 60 s\'}'),
    'local-failed|T(Local AI could not answer that. Try again in a moment.)\n(no first word from the model after 60 s)');
  assert.equal(run('{errorCode = \'local-failed\'}'), 'local-failed|T(Local AI could not answer that. Try again in a moment.)');
  for (const bad of ['\'\'', '12', '{}', '\'bad \\n control\'', '\'caf\\195\\169\'', `'${'x'.repeat(141)}'`])
    assert.equal(run(`{errorCode = 'local-failed', errorDetail = ${bad}}`), 'local-failed|T(Local AI could not answer that. Try again in a moment.)', `ignored: ${bad.slice(0, 20)}`);
  // The bridge's own phrases all pass the check.
  for (const phrase of ['no first word from the model after 60 s', 'ran out of the turn\'s time: no first word from the model after 61 s', 'stuck reading the prompt (2048 of 4824 tokens after 40 s)',
    'the model was still loading after 80 s (a first start compiles shaders for a minute or two)', 'the prompt (9000 tokens) does not fit the model\'s context (8192)'])
    assert.match(run(`{errorCode = 'local-failed', errorDetail = '${phrase.replace(/'/g, '\\\'')}'}`), /\n\(/, phrase);
});

// ---- both packs installed: what the folder holds, and the install that did not finish -------------------------------------------------------

const ENGINE = 'llama/llama-server.exe';
const EMBED = {file: 'models/granite-embedding-107m-multilingual-Q8_0.gguf', dim: 384, id: 'granite-embedding-107m-multilingual-q8_0'};
/** The two packs in the real shape (names of packaging/release.config.json). `omit` leaves files out, as a zip that was not fully extracted does. */
function packFolder(t, {omit = [], orphan = null} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'two-packs-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const put = (relative, text = 'x') => { if (omit.includes(relative)) return; const path = join(directory, relative); mkdirSync(join(path, '..'), {recursive: true}); writeFileSync(path, text); };
  put(ENGINE); put(EMBED.file);
  put('models/gemma-4-E4B_q4_0-it.gguf', 'a'.repeat(2048));
  put('manifest.standard.json', JSON.stringify({version: 1, server: ENGINE, standard: {file: 'models/gemma-4-E4B_q4_0-it.gguf', name: 'Gemma 4 E4B'}, embed: EMBED}));
  put('models/Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf', 'b'.repeat(4096));
  put('manifest.mature-standard.json', JSON.stringify({version: 1, pack: 'mature', server: ENGINE, good: {file: 'models/Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf', name: 'Gemma 4 E4B · uncensored', family: 'gemma-4'}, embed: EMBED}));
  if (orphan) put('models/' + orphan, 'c');
  return directory;
}
const listed = directory => {
  const environment = {CYBERPUNK_CONVAI_LOCAL_AI: directory};
  const pack = detectLocalAiPack({project: directory, environment}), mature = detectMaturePack({project: directory, environment});
  return {pack, models: listLocalModels({pack, matureModels: mature.models}), files: describePackFiles({project: directory, environment})};
};

test('with both packs in place the list has both models, the folder description names every marker and model file with its size, and nothing is missing', t => {
  const {pack, models, files} = listed(packFolder(t));
  assert.deepEqual(describeLocalModels(models, () => 5000).map(model => model.name), ['Gemma 4 E4B', 'Gemma 4 E4B · uncensored']);
  assert.deepEqual(files.markers.map(marker => [marker.name, marker.mature, marker.declares.map(item => [item.tier, item.name, item.file, item.present, item.sizeMiB])]), [
    ['manifest.standard.json', false, [['standard', 'Gemma 4 E4B', 'models/gemma-4-E4B_q4_0-it.gguf', true, 0]]],
    ['manifest.mature-standard.json', true, [['good', 'Gemma 4 E4B · uncensored', 'models/Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf', true, 0]]]]);
  assert.deepEqual(files.files.map(item => [item.file, item.named]), [
    ['Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf', true], ['gemma-4-E4B_q4_0-it.gguf', true], ['granite-embedding-107m-multilingual-Q8_0.gguf', true]]);
  assert.deepEqual(packFileProblems(files), []);
  assert.equal(pack.tiers.standard.name, 'Gemma 4 E4B');
  // With Mature content off the normal model is the default, with it on the uncensored one: nothing is blocked.
  assert.equal(chooseLocalModel({models, matureOn: false, freeMiB: 12000, sizeOf: () => 5000}).model.id, 'standard');
  assert.equal(chooseLocalModel({models, matureOn: true, freeMiB: 12000, sizeOf: () => 5000}).model.id, 'mature:good');
});

test('the install that did not finish (the Local AI pack\'s model file is not there): only the Mature model is listed, Mature off starts nothing, and the folder description says which model is missing', t => {
  const {models, files} = listed(packFolder(t, {omit: ['models/gemma-4-E4B_q4_0-it.gguf']}));
  assert.deepEqual(describeLocalModels(models, () => 5000).map(model => model.name), ['Gemma 4 E4B · uncensored'], 'the symptom of the letter: one model in the list');
  assert.deepEqual(packFileProblems(files), [{name: 'Gemma 4 E4B', reason: 'missing'}]);
  assert.equal(files.markers[0].declares[0].present, false); assert.equal(files.markers[0].declares[0].sizeMiB, null);
  assert.equal(files.files.some(item => item.file === 'gemma-4-E4B_q4_0-it.gguf'), false);
  assert.throws(() => chooseLocalModel({models, matureOn: false, freeMiB: 12000, sizeOf: () => 5000}), error => error.reason === 'mature-off');
  assert.equal(chooseLocalModel({models, matureOn: true, freeMiB: 12000, sizeOf: () => 5000}).model.id, 'mature:good');
  // The Mature pack's own model missing is the same note.
  const noMature = listed(packFolder(t, {omit: ['models/Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf']}));
  assert.deepEqual(packFileProblems(noMature.files), [{name: 'Gemma 4 E4B · uncensored', reason: 'missing'}]);
  assert.deepEqual(describeLocalModels(noMature.models, () => 5000).map(model => model.name), ['Gemma 4 E4B']);
});

test('a model file with no marker (the marker is extracted last, or never was) is shown as not named; a folder with nothing is described as empty and never throws', t => {
  const {files} = listed(packFolder(t, {omit: ['manifest.standard.json'], orphan: 'Some-Other-Model-Q4.gguf'}));
  assert.deepEqual(files.markers.map(marker => marker.name), ['manifest.mature-standard.json']);
  assert.deepEqual(files.files.filter(item => !item.named).map(item => item.file), ['Some-Other-Model-Q4.gguf', 'gemma-4-E4B_q4_0-it.gguf']);
  assert.deepEqual(describePackFiles({project: join(tmpdir(), 'no-such-folder-' + process.pid), environment: {}}), {markers: [], files: []});
  assert.deepEqual(packFileProblems(undefined), []);
  // A marker that names a path outside the pack is not followed.
  const evil = mkdtempSync(join(tmpdir(), 'evil-pack-'));
  t.after(() => rmSync(evil, {recursive: true, force: true}));
  writeFileSync(join(evil, 'manifest.standard.json'), JSON.stringify({version: 1, server: ENGINE, standard: {file: '../outside.gguf', name: 'Outside'}}));
  assert.deepEqual(describePackFiles({project: evil, environment: {CYBERPUNK_CONVAI_LOCAL_AI: evil}}).markers[0].declares, []);
});

test('the support report carries the folder description and the bridge puts a missing pack model into the notes of the model row', async t => {
  const {localAiSection} = await import('./support-report.mjs');
  const directory = packFolder(t, {omit: ['models/gemma-4-E4B_q4_0-it.gguf']});
  const runtime = join(directory, 'runtime');
  mkdirSync(runtime);
  writeFileSync(join(runtime, 'mistral-state.json'), JSON.stringify({version: 1, localAi: 'failed'}));
  const section = await localAiSection({runtime, project: directory, environment: {CYBERPUNK_CONVAI_LOCAL_AI: directory}});
  assert.equal(section.packFiles.markers[0].name, 'manifest.standard.json');
  assert.equal(section.packFiles.markers[0].declares[0].present, false);
  assert.deepEqual(section.packFiles.files.map(item => item.file), ['Gemma4-E4B-MiniFantasy-V1-Q4_K_M.gguf', 'granite-embedding-107m-multilingual-Q8_0.gguf']);
  assert.equal(JSON.stringify(section.packFiles).includes(directory), false, 'no path');
  const bridge = await readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /packFileProblems\(describePackFiles\(\{project\}\)\)/);
  assert.match(bridge, /const customModelProblems = \(\) => \[\.\.\.customScan\.problems\.map/);
});

// ---- the model loads at normal priority and is lowered when it is ready ------------------------------------------------------------------

const BELOW_NORMAL = osConstants.priority.PRIORITY_BELOW_NORMAL;

test('LlamaProcess: lowered at spawn by default (the embedder), left at normal until lower() with lowerAfter ready (the chat model), never with lowerPriority false, a refusal is not an error', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'llama-priority-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const make = options => {
    const calls = [];
    const proc = new LlamaProcess({command: process.execPath, argsPrefix: [FAKE], tmpDir: directory, pollMs: 20, startupMs: 180_000, setPriorityImpl: (pid, level) => calls.push([pid, level]),
      buildArgs: ({port, keyFile}) => ['--host', '127.0.0.1', '--port', String(port), '--api-key-file', keyFile, '-m', 'x.gguf'], ...options});
    t.after(() => proc.stop());
    return {proc, calls};
  };
  const lowered = make();
  await lowered.proc.start();
  assert.deepEqual(lowered.calls, [[lowered.proc.pid, BELOW_NORMAL]], 'a CPU process is lowered at spawn, as before');

  const loading = make({lowerAfter: 'ready'});
  await loading.proc.start();
  assert.deepEqual(loading.calls, [], 'the model loaded at normal priority: nothing was changed while it started');
  assert.equal(loading.proc.lower(), true);
  assert.deepEqual(loading.calls, [[loading.proc.pid, BELOW_NORMAL]]);

  const never = make({lowerAfter: 'ready', lowerPriority: false});
  await never.proc.start();
  assert.equal(never.proc.lower(), false); assert.deepEqual(never.calls, []);

  const refused = make({lowerAfter: 'ready', setPriorityImpl() { throw Error('access denied'); }});
  await refused.proc.start();
  assert.equal(refused.proc.lower(), false, 'a priority is an optimisation, never a failure');
  const notStarted = new LlamaProcess({command: process.execPath, buildArgs: () => []});
  assert.equal(notStarted.lower(), false, 'no child, nothing to lower');
});

test('the chat model starts at normal priority, stays there through the warm-up, and is lowered below normal just before it is ready; a failed start is never lowered', async t => {
  const timeline = [];
  let chatRequests = 0, server;
  const counted = async (url, init) => { if (String(url).endsWith('/v1/chat/completions')) chatRequests++; return fetch(url, init); };
  const made = rig(t, {warmup: true, stateFile: join(tmpdir(), 'local-turn-priority-' + process.pid + '.json'), fetchImpl: counted,
    processExtra: {setPriorityImpl: (pid, level) => timeline.push({pid, level, state: server.status().state, warmUpRequests: chatRequests})}});
  server = made.server;
  t.after(() => rmSync(join(tmpdir(), 'local-turn-priority-' + process.pid + '.json'), {force: true}));
  assert.deepEqual(timeline, []);
  await server.ensure();
  assert.equal(timeline.length, 1, 'once');
  assert.equal(timeline[0].level, BELOW_NORMAL);
  assert.equal(timeline[0].state, 'warming', 'before the state is ready: the load and the warm-up ran at normal priority');
  assert.ok(timeline[0].warmUpRequests >= 1, 'after the warm-up requests, which are CPU work too (the shader compile of a first start)');
  assert.equal(server.status().state, 'ready');
  assert.equal(server.diagnostics().engine.priority, 'below-normal');
  assert.match(made.logs.find(line => line.startsWith('[local] model ready:')), /process priority normal while it loaded, below normal now/);
  // A second turn on the same model does not touch it again.
  await server.prewarm([{role: 'user', content: 'hi'}]);
  assert.equal(timeline.length, 1);

  // A start that fails never reaches the lowering.
  const failing = [];
  const dead = rig(t, {env: {FAKE_LLAMA_EXIT_AT_START: '3'}, processExtra: {setPriorityImpl: (pid, level) => failing.push([pid, level])}});
  await assert.rejects(dead.server.ensure());
  assert.deepEqual(failing, []);

  // The player's server and a refused change: the model is ready anyway, and says it is at normal priority.
  const refused = rig(t, {processExtra: {setPriorityImpl() { throw Error('access denied'); }}});
  await refused.server.ensure();
  assert.equal(refused.server.status().state, 'ready');
  assert.equal(refused.server.diagnostics().engine.priority, 'normal');
  assert.doesNotMatch(refused.logs.find(line => line.startsWith('[local] model ready:')), /process priority/);
});
