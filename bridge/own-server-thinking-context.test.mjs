// A model server the player runs (an `endpoint` entry of manifest.custom.json, LM Studio, Ollama, llama.cpp; or the custom provider pointed at one) in the two ways
// the 0.2.3 reports showed it failing a turn:
//   1. a model whose name nobody listed that thinks through its whole allowance (the reply is only thinking): the turn is asked again once with the fields that ask for
//      no thinking, the endpoint is remembered as one that thinks, and a second answer of only thinking fails the turn with its own line (`local-thinking`);
//   2. a prompt longer than the context the server really has loaded (LM Studio passes llama.cpp's refusal on as a 500 or 502, with the numbers inside its own error
//      text, or none): the real context is learned (or the assumed one halved), the prompt is fitted again with the persona shortened, and the server is not "down".
// Every server here is a scripted fake on a loopback port. No real network, no real key.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {streamChat, mapFailure, errorCodeFor, failureKind, failureDetail, contextRefusal, newAdaptation, MistralError} from './mistral-client.mjs';
import {noThinkingFields, NO_THINKING_FIELDS} from './reasoning.mjs';
import {PersonaBook, buildMessages} from './mistral-prompt.mjs';
import {BUDGET, PromptTooLarge, TokenMeter, budgetedChat, templateTokens, MIN_SERVER_CONTEXT} from './prompt-budget.mjs';
import {CustomModelScanner} from './custom-models.mjs';
import {detectLocalAiPack} from './local-ai-pack.mjs';
import {LocalLlmServer, NO_KEY} from './local-llm-server.mjs';
import {TextProviderHost, localRoute, customRoute} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {reportableTurnFailure} from './error-events.mjs';
import {startOpenAiMock} from './openai-mock-server.mjs';

const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);
const DEVICES = 'Available devices:\n  Vulkan1: NVIDIA GeForce RTX 4080 Laptop GPU (11997 MiB, 11229 MiB free)\n';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A fake OpenAI-compatible server whose chat answers are scripted: plan(body, index) returns
//   {thinking: n, text}   n pieces of `reasoning_content`, then (optionally) the reply text, then finish "stop"
//   {status, body}        an error answer, the body as JSON
// `models` is the /v1/models listing. Requests are kept in order (`chats()` are the POSTs).
async function scripted(t, plan, {models = [{id: 'laptop-ai'}]} = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
      requests.push({method: request.method, url: request.url, body});
      const json = (status, value) => { response.writeHead(status, {'content-type': 'application/json'}); response.end(JSON.stringify(value)); };
      if (request.method === 'GET' && request.url === '/v1/models') return json(200, {object: 'list', data: models});
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return json(404, {error: {message: 'not found'}});
      const answer = plan(body, requests.filter(item => item.method === 'POST').length - 1) ?? {thinking: 0, text: 'Fine, V.'};
      if (answer.status) return json(answer.status, answer.body);
      response.writeHead(200, {'content-type': 'text/event-stream'});
      for (let index = 0; index < (answer.thinking ?? 0); index++) response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {reasoning_content: `hm ${index} `}}]})}\n\n`);
      for (const piece of String(answer.text ?? '').match(/.{1,9}/gs) ?? []) response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: piece}}]})}\n\n`);
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 100, completion_tokens: 9}})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(done => { server.closeAllConnections?.(); server.close(done); }));
  return {origin, endpoint: origin + '/v1', requests, chats: () => requests.filter(request => request.method === 'POST')};
}

const ask = (api, extra = {}) => streamChat({apiKey: NO_KEY, model: 'laptop-ai', messages: [{role: 'user', content: 'hi'}], provider: 'local', endpoint: api.endpoint + '/chat/completions',
  retries: 1, backoffMs: [0], thinkingPieces: 5, ...extra});
const NO_THINKING = noThinkingFields({hostname: '192.168.1.50', local: true});
const asked = body => Object.fromEntries(NO_THINKING_FIELDS.filter(name => name in body).map(name => [name, body[name]]));

// ---- 1. A model that only thinks ----------------------------------------------------------------------------------------------

test('what a retry asks for: a home server gets every field it may honour, another host a milder set, OpenRouter and DeepSeek nothing new', () => {
  assert.deepEqual(NO_THINKING, {reasoning_effort: 'none', chat_template_kwargs: {enable_thinking: false}, think: false});
  assert.deepEqual(noThinkingFields({hostname: 'llm.example.com', local: false}), {reasoning_effort: 'low', chat_template_kwargs: {enable_thinking: false}});
  assert.equal(noThinkingFields({hostname: 'openrouter.ai', local: false}), undefined);
  assert.equal(noThinkingFields({hostname: 'api.deepseek.com', local: false}), undefined);
});

test('a server of the player that only thinks: the turn is asked again once, at once, with the fields that ask for no thinking, and the next turns carry them from the start', async t => {
  const api = await scripted(t, (body, index) => ('think' in body ? {thinking: 2, text: 'Over here, V.'} : {thinking: 40}));
  const adapt = newAdaptation();
  const retries = [];
  const began = Date.now();
  const result = await ask(api, {adapt, noThinking: NO_THINKING, onRetry: info => retries.push(info)});
  assert.equal(result.text, 'Over here, V.');
  assert.equal(api.chats().length, 2, 'one try that only thought, one retry');
  assert.deepEqual(asked(api.chats()[0].body), {}, 'the first request is the ordinary one: nothing is sent that the server might refuse');
  assert.deepEqual(asked(api.chats()[1].body), NO_THINKING);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].waitMs, 0, 'right away');
  assert(Date.now() - began < 3000);
  assert.equal(adapt.thinks, true, 'this endpoint is remembered as one that thinks');
  // The next turn to the same endpoint does not pay for the first try again.
  const next = await ask(api, {adapt, noThinking: NO_THINKING});
  assert.equal(next.text, 'Over here, V.');
  assert.equal(api.chats().length, 3);
  assert.deepEqual(asked(api.chats()[2].body), NO_THINKING);
  // Another endpoint (its own adaptation) starts with the ordinary request.
  const other = await scripted(t, () => ({thinking: 0, text: 'Hi, V.'}));
  await ask(other, {adapt: newAdaptation(), noThinking: NO_THINKING});
  assert.deepEqual(asked(other.chats()[0].body), {});
});

test('a model that only thinks even when asked not to: the turn fails once more with its own words (one retry, never a loop), and the next turn fails after one request', async t => {
  const api = await scripted(t, () => ({thinking: 40}));
  const adapt = newAdaptation();
  const error = await ask(api, {adapt, noThinking: NO_THINKING}).catch(caught => caught);
  assert(error instanceof MistralError);
  assert.equal(api.chats().length, 2);
  assert.equal(error.reason, 'thinking-only');
  assert.equal(error.kind, 'empty');
  assert.match(error.message, /even when asked not to think/);
  assert.match(error.message, /\[local:empty\]/);
  assert.equal(errorCodeFor(error), 'local-thinking');
  assert.equal(failureKind(error), 'empty');
  assert.match(failureDetail(error), /only thinking/);
  const again = await ask(api, {adapt, noThinking: NO_THINKING}).catch(caught => caught);
  assert.equal(errorCodeFor(again), 'local-thinking');
  assert.equal(api.chats().length, 3, 'the fields went with the first request: there is nothing left to try');
  assert.deepEqual(asked(api.chats()[2].body), NO_THINKING);
});

test('the packaged local models never think: no retry, no fields, and the failure keeps the ordinary local-failed notice', async t => {
  const api = await scripted(t, () => ({thinking: 40}));
  const adapt = newAdaptation();
  const error = await ask(api, {adapt}).catch(caught => caught);
  assert.equal(api.chats().length, 1, 'a model that only thinks is not asked again (noRetry), as before');
  assert.equal(errorCodeFor(error), 'local-failed');
  assert.doesNotMatch(error.message, /even when asked/);
  assert.equal(adapt.thinks, false);
  assert.deepEqual(asked(api.chats()[0].body), {});
});

test('a server that refuses one of the fields by name is sent the retry without just that one, and the refusal is remembered', async t => {
  const api = await scripted(t, body => {
    if (!('think' in body) && !('reasoning_effort' in body)) return {thinking: 40};
    if ('think' in body) return {status: 400, body: {error: {message: "Unrecognized request argument supplied: think", type: 'invalid_request_error'}}};
    return {thinking: 1, text: 'Right here, V.'};
  });
  const adapt = newAdaptation();
  const result = await ask(api, {adapt, noThinking: NO_THINKING});
  assert.equal(result.text, 'Right here, V.');
  assert.equal(api.chats().length, 3, 'only thinking, then refused for think, then answered');
  assert.deepEqual(asked(api.chats()[2].body), {reasoning_effort: 'none', chat_template_kwargs: {enable_thinking: false}});
  assert.deepEqual([...adapt.noThinkDropped], ['think']);
  // Later requests leave it out from the start.
  await ask(api, {adapt, noThinking: NO_THINKING});
  assert.deepEqual(asked(api.chats()[3].body), {reasoning_effort: 'none', chat_template_kwargs: {enable_thinking: false}});
});

test('the retry keeps the turn\'s time: with less than an attempt left it is not made', async t => {
  const api = await scripted(t, () => ({thinking: 40}));
  let clock = 0;
  const now = () => (clock += 3000);
  const error = await ask(api, {adapt: newAdaptation(), noThinking: NO_THINKING, now, deadlineAt: 10_000, minAttemptMs: 3000}).catch(caught => caught);
  assert.equal(api.chats().length, 1, 'no room for a second request');
  assert.equal(error.reason, 'thinking-only');
  assert.doesNotMatch(error.message, /even when asked/);
});

test('a custom provider whose model id gives no reasoning hint: a reply that spent its budget on thinking is asked again once with more room and the fields, and the endpoint is remembered', async t => {
  const mock = await startOpenAiMock();
  t.after(() => mock.close());
  mock.behave(request => ('chat_template_kwargs' in request.body ? {sse: [{reasoning_content: 'ok'}, 'Here, V.']} : {sse: [{reasoning_content: 'hmm'}], finish: 'length'}));
  const adapt = newAdaptation();
  const call = () => streamChat({provider: 'custom', endpoint: mock.url + '/chat/completions', trustedOrigin: mock.origin, model: 'laptop-ai', messages: [{role: 'user', content: 'hi'}],
    retries: 1, backoffMs: [0], adapt, noThinking: NO_THINKING, maxTokens: 300});
  const result = await call();
  assert.equal(result.text, 'Here, V.');
  assert.equal(mock.requests.length, 2, 'one try that spent its budget thinking, one retry (the larger room and the fields in the same one)');
  assert.deepEqual(asked(mock.requests[0].body), {});
  assert.deepEqual(asked(mock.requests[1].body), NO_THINKING);
  assert.equal(mock.requests[0].body.max_tokens, 300);
  assert(mock.requests[1].body.max_tokens >= 1500, 'the existing room for a model that thinks is kept');
  assert.equal(adapt.thinks, true);
  await call();
  assert.equal(mock.requests.length, 3);
  assert.deepEqual(asked(mock.requests[2].body), NO_THINKING, 'the next turn starts with them');
  // Still only thinking: the existing notice for a custom model, after the one retry.
  const stubborn = await startOpenAiMock();
  t.after(() => stubborn.close());
  stubborn.behave(() => ({sse: [{reasoning_content: 'hmm'}], finish: 'length'}));
  const error = await streamChat({provider: 'custom', endpoint: stubborn.url + '/chat/completions', trustedOrigin: stubborn.origin, model: 'laptop-ai', messages: [{role: 'user', content: 'hi'}],
    retries: 2, backoffMs: [0], adapt: newAdaptation(), noThinking: NO_THINKING}).catch(caught => caught);
  assert.equal(errorCodeFor(error), 'custom-reasoning');
  assert.equal(stubborn.requests.length, 2, 'asked once more, not twice');
});

test('the custom route hands its adaptation (one per endpoint and model) and the fields to every request', async () => {
  const route = customRoute({provider: {}, custom: {ready: true, chatUrl: 'http://192.168.1.50:1234/v1/chat/completions', origin: 'http://192.168.1.50:1234', model: 'laptop-ai', local: true,
    noThinking: NO_THINKING, reasoning: undefined, key: null, extraHeaders: undefined}});
  const first = await route.connect(), second = await route.connect();
  assert.deepEqual(first.noThinking, NO_THINKING);
  assert.equal(first.adapt, second.adapt, 'kept for the session');
  assert.equal(first.reasoning, undefined, 'the id gave no hint: nothing is sent from the start');
});

// ---- 2. A prompt longer than the context the server really has --------------------------------------------------------------

const LM_STUDIO = {error: {message: 'Engine protocol predict request returned 400: {"error":{"code":400,"message":"request (9423 tokens) exceeds the available context size (4096 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":9423,"n_ctx":4096}}', type: 'invalid_request_error'}};

test('LM Studio passes llama.cpp\'s refusal on as a 500 or a 502: it is a prompt that is too long (kind request, with the numbers), not a server that failed', () => {
  for (const status of [400, 413, 422, 500, 502, 503]) {
    const error = mapFailure(status, LM_STUDIO, {provider: 'local'});
    assert.equal(error.kind, 'request', String(status));
    assert.deepEqual(error.overflow, {promptTokens: 9423, contextTokens: 4096}, String(status));
    assert.equal(error.slow, false);
    assert.equal(errorCodeFor(error), 'local-failed');
  }
  // The numbers may be missing, or come in another server's words.
  assert.deepEqual(contextRefusal(500, 'Trying to keep the first 6000 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough.', null),
    {promptTokens: 6000, contextTokens: 4096});
  assert.deepEqual(contextRefusal(400, "This model's maximum context length is 8192 tokens. However, you requested 9500 tokens (9000 in the messages, 500 in the completion).", null),
    {promptTokens: 9500, contextTokens: 8192});
  assert.deepEqual(contextRefusal(502, 'the prompt exceeds the context size', null), {promptTokens: undefined, contextTokens: undefined});
  // A server fault with no such words is still one; an unrelated 400 is not an overflow.
  assert.equal(contextRefusal(500, 'model crashed', null), null);
  assert.equal(contextRefusal(404, 'exceeds the context size', null), null);
  assert.equal(mapFailure(502, {error: {message: 'Bad gateway'}}, {provider: 'local'}).kind, 'network');
  assert.equal(mapFailure(500, {error: {message: 'Bad gateway'}}, {provider: 'local'}).overflow, undefined);
});

const args = () => ({persona: book.persona('judy-alvarez'), memory: '', history: Array.from({length: 8}, (_, index) => ({v: `Tell me about the night number ${index} at the Clouds.`,
  r: 'It was a long night, V. Braindance work is mostly waiting, then everything happens at once and you wish it had not.'})),
  contextParts: {now: 'You are with V in person. It is night, about 11 PM, in Kabuki.', notes: 'FORMAT: use {joy} tags for feelings.', world: 'WORLD FACTS\n' + '- a plain fact about the world the character may know of.\n'.repeat(120),
    worldBlocks: [{key: 'knowledge', text: 'WORLD FACTS\n' + '- a plain fact about the world the character may know of.\n'.repeat(120)}], volatile: 'Whether you ask V anything is your own call.'},
  remembered: [], text: 'What are you up to right now?', reaction: false});
const refuse = (overflow, accept) => async options => {
  const tokens = Math.ceil(options.messages.reduce((sum, message) => sum + message.content.length, 0) / 4.2) + templateTokens(options.messages.length);
  if (tokens > accept) throw Object.assign(new MistralError('request', 'exceeds the available context size', {provider: 'local'}), {overflow: overflow(tokens)});
  return {text: 'ok', usage: {prompt_tokens: tokens}};
};

test('a server that names its real context: the prompt is fitted to it with the persona shortened, the context is passed on to be remembered, and the retry answers', async () => {
  const learned = [];
  const chat = budgetedChat(refuse(tokens => ({promptTokens: tokens, contextTokens: 4096}), 4096), {budget: async () => ({contextTokens: 8192, meter: new TokenMeter({charsPerToken: 6}), server: true}), learn: tokens => learned.push(tokens)});
  const result = await chat({messages: buildMessages(args()), provider: 'local', lastResort: true});
  assert.equal(result.text, 'ok');
  assert.deepEqual(learned, [4096]);
});

test('a server that names no context: the assumed one is halved (never below 2048), remembered, and the prompt is fitted again', async () => {
  const learned = [];
  const sent = [];
  const chat = budgetedChat(async options => { sent.push(options.messages); return refuse(() => ({promptTokens: undefined, contextTokens: undefined}), 3900)(options); },
    {budget: async () => ({contextTokens: 8192, meter: new TokenMeter(), server: true}), learn: tokens => learned.push(tokens)});
  const result = await chat({messages: buildMessages(args()), provider: 'local', lastResort: true});
  assert.equal(result.text, 'ok');
  assert.deepEqual(learned, [4096]);
  assert.equal(sent.length, 2);
  // Never below the floor.
  const floor = [];
  const small = budgetedChat(refuse(() => ({}), 100), {budget: async () => ({contextTokens: 3000, meter: new TokenMeter(), server: true}), learn: tokens => floor.push(tokens)});
  await small({messages: buildMessages(args()), provider: 'local', lastResort: true}).catch(() => {});
  assert.deepEqual(floor, [MIN_SERVER_CONTEXT]);
});

test('a server whose context is still too small after the retry: one clear error with its own notice code, not a reported fault; any other server keeps the old behaviour', async () => {
  const calls = [];
  const chat = budgetedChat(async options => { calls.push(1); throw Object.assign(new MistralError('request', 'exceeds the available context size', {provider: 'local'}), {overflow: {promptTokens: 9000, contextTokens: 2048}}); },
    {budget: async () => ({contextTokens: 8192, meter: new TokenMeter(), server: true})});
  const error = await chat({messages: buildMessages(args()), provider: 'local', lastResort: true}).catch(caught => caught);
  assert(error instanceof PromptTooLarge, String(error));
  assert.match(error.message, /\[local:request\]/);
  assert.equal(errorCodeFor(error), 'local-context');
  assert.equal(calls.length, 1, 'the persona that could not be fitted to 2048 tokens is not sent');
  assert.equal(reportableTurnFailure(error, {errorCode: 'local-context'}), false);
  assert.equal(reportableTurnFailure(new Error('x'), {errorCode: 'local-thinking'}), false);
  // A persona that cannot fit the context the server named is the same thing without any request.
  const never = budgetedChat(async () => ({text: 'never'}), {budget: async () => ({contextTokens: 2048, meter: new TokenMeter(), server: true})});
  assert.equal(errorCodeFor(await never({messages: buildMessages(args()), provider: 'local'}).catch(caught => caught)), 'local-context');
  // Our own llama-server (no `server`): the same prompt is the ordinary local-failed.
  const own = budgetedChat(async () => ({text: 'never'}), {budget: async () => ({contextTokens: 2048, meter: new TokenMeter()})});
  assert.equal(errorCodeFor(await own({messages: buildMessages(args()), provider: 'local'}).catch(caught => caught)), 'local-failed');
  const refusing = budgetedChat(async () => { throw Object.assign(new MistralError('request', 'x', {provider: 'local'}), {overflow: {promptTokens: 99999, contextTokens: 8192}}); },
    {budget: async () => ({contextTokens: 8192, meter: new TokenMeter({charsPerToken: 6})})});
  await assert.rejects(refusing({messages: buildMessages(args()), provider: 'local'}), caught => caught.overflow?.promptTokens === 99999 && !(caught instanceof PromptTooLarge));
});

// ---- The two together, through the route, on a supervisor over a scripted server --------------------------------------------

function project(t) {
  const directory = mkdtempSync(join(tmpdir(), 'own-server-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return directory;
}
function supervisor(t, api, entry = {}) {
  const directory = project(t);
  mkdirSync(join(directory, 'local-ai'), {recursive: true});
  writeFileSync(join(directory, 'local-ai', 'manifest.custom.json'), JSON.stringify({version: 1, models: [{endpoint: api.endpoint, name: 'Laptop AI', model: 'laptop-ai', contextSize: 8192, ...entry}]}));
  const models = new CustomModelScanner({project: directory, environment: {}, log: () => {}}).scan().models;
  const logs = [];
  const state = {pin: 'auto', matureOn: false, matureModels: [], customModels: models};
  const server = new LocalLlmServer({pack: detectLocalAiPack({project: directory, environment: {}}), selection: () => state,
    spawnImpl: () => { throw new Error('a llama-server of ours must not start'); }, listDevices: async () => DEVICES, freeVramMiB: () => null, fileSizeMiB: () => 0,
    warmup: false, idleMs: 0, backoffMs: 5, log: line => logs.push(line)});
  t.after(async () => { await server.stop(); });
  return {server, logs};
}
async function hostFor(t, server) {
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => '', writeText: async () => {}});
  await provider.load(); provider.setPreference('local'); provider.apply();
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: book, routes: {local: localRoute({server, provider})}, log: () => {}});
  t.after(() => host.close());
  return host;
}
const turn = text => ({text, context: 'CURRENT PERSON\nQuest facts here.', sessionId: 'session-1', local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}});

test('end to end on a model server of the player: the very first request already asks for no thinking, so a model that would have thought through its allowance answers the first turn', async t => {
  const lines = ['Over here, V. What do you need?', 'Still here, choom. The noodles are getting cold.', 'Where else would I be?'];
  const api = await scripted(t, (body, index) => ('think' in body ? {thinking: 1, text: lines[index]} : {thinking: 200}));
  const {server, logs} = supervisor(t, api);
  const host = await hostFor(t, server);
  const first = await host.reply(turn('Where are you?'));
  assert.match(first.text, /Over here/);
  assert.equal(api.chats().length, 1, 'one request: no wasted try that only thinks');
  assert.deepEqual(asked(api.chats()[0].body), NO_THINKING);
  const second = await host.reply(turn('And now?'));
  assert.match(second.text, /Still here/);
  assert.equal(api.chats().length, 2);
  assert.deepEqual(asked(api.chats()[1].body), NO_THINKING);
  assert.equal(server.status().state, 'ready');
  assert(logs.every(line => !/stopped answering/.test(line)), logs.join('\n'));
});

test('end to end: a server that refuses a no-thinking field by name loses just that field on the first turn (one request sent again at once), and the next turns do not send it', async t => {
  const api = await scripted(t, body => ('think' in body ? {status: 400, body: {error: {message: 'Unrecognized request argument supplied: think', type: 'invalid_request_error'}}} : {thinking: 0, text: 'Right here, V.'}));
  const {server} = supervisor(t, api);
  const host = await hostFor(t, server);
  const first = await host.reply(turn('Where are you?'));
  assert.match(first.text, /Right here/);
  assert.equal(api.chats().length, 2, 'the refused request and the same one without the field');
  assert.deepEqual(asked(api.chats()[0].body), NO_THINKING);
  const {think: _dropped, ...kept} = NO_THINKING;
  assert.deepEqual(asked(api.chats()[1].body), kept);
  await host.reply(turn('And now?'));
  assert.equal(api.chats().length, 3, 'the refusal is remembered: one request');
  assert.deepEqual(asked(api.chats()[2].body), kept);
  assert.equal(server.status().state, 'ready');
});

test('end to end: a strict server that refuses the extra fields without naming them loses all three on the first turn (one request sent again at once) and answers every turn after that', async t => {
  const api = await scripted(t, body => (('think' in body || 'chat_template_kwargs' in body || 'reasoning_effort' in body)
    ? {status: 400, body: {error: {message: 'Extra inputs are not permitted', type: 'invalid_request_error'}}} : {thinking: 0, text: 'Right here, V.'}));
  const {server} = supervisor(t, api);
  const host = await hostFor(t, server);
  const first = await host.reply(turn('Where are you?'));
  assert.match(first.text, /Right here/);
  assert.equal(api.chats().length, 2, 'the refused request and the same one without the three fields');
  assert.deepEqual(asked(api.chats()[0].body), NO_THINKING);
  assert.deepEqual(asked(api.chats()[1].body), {});
  await host.reply(turn('And now?'));
  assert.equal(api.chats().length, 3, 'remembered: one request');
  assert.deepEqual(asked(api.chats()[2].body), {});
  assert.equal(server.status().state, 'ready');
});

test('end to end: a model that thinks whatever it is asked fails the turn with the notice code local-thinking after one request (it was asked not to think from the start), and nothing is remembered', async t => {
  const api = await scripted(t, () => ({thinking: 200}));
  const {server} = supervisor(t, api);
  const host = await hostFor(t, server);
  const error = await host.reply(turn('Where are you?')).catch(caught => caught);
  assert.equal(errorCodeFor(error), 'local-thinking', String(error));
  assert.equal(api.chats().length, 1);
  assert.deepEqual(host.memory.recall({profileKey: 'judy-alvarez', channel: 'private'}).turns, []);
  assert.equal(server.status().state, 'ready');
});

test('end to end: an LM Studio style refusal for length (a 500 with llama.cpp\'s words inside) is not "stopped answering": the context is learned, the prompt shortened, the turn answered', async t => {
  // The server really has 3000 tokens loaded, whatever it reported (8192).
  const limit = 3000;
  const api = await scripted(t, body => {
    const tokens = Math.ceil(JSON.stringify(body.messages).length / 4);
    return tokens > limit - 250 ? {status: 500, body: {error: {message: `Engine protocol predict request returned 400: {"error":{"code":400,"message":"request (${tokens} tokens) exceeds the available context size (${limit} tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":${tokens},"n_ctx":${limit}}}`}}}
      : {thinking: 0, text: 'Right here, V.'};
  });
  const {server, logs} = supervisor(t, api);
  const host = await hostFor(t, server);
  const result = await host.reply(turn('Where are you?'));
  assert.match(result.text, /Right here/);
  assert.equal(server.status().state, 'ready', 'a 500 that is a refusal for length is an answer');
  assert(logs.every(line => !/stopped answering/.test(line)), logs.join('\n'));
  assert(logs.some(line => /smaller context than it reported: prompts are fitted to 3000 tokens/.test(line)), logs.join('\n'));
  assert.equal((await server.ensure()).contextSize, 3000, 'remembered for the session');
  const before = api.chats().length;
  await host.reply(turn('Still there?'));
  assert.equal(api.chats().length, before + 1, 'the next turn is fitted at once: no refused request');
});

test('end to end: a server whose context is too small for any persona fails the turn with local-context after one retry, and is still not "stopped answering"', async t => {
  const api = await scripted(t, body => ({status: 400, body: {error: {message: `request (${Math.ceil(JSON.stringify(body.messages).length / 4)} tokens) exceeds the available context size (1500 tokens), try increasing it`, type: 'exceed_context_size_error', n_ctx: 1500}}}));
  const {server, logs} = supervisor(t, api);
  const host = await hostFor(t, server);
  const error = await host.reply(turn('Where are you?')).catch(caught => caught);
  assert.equal(errorCodeFor(error), 'local-context', String(error));
  assert(api.chats().length <= 1, 'the persona cannot be fitted to 1500 tokens: it is not sent again');
  assert.equal(server.status().state, 'ready');
  assert(logs.every(line => !/stopped answering/.test(line)));
});

test('the persona prewarm\'s refusal for length is learned like a turn\'s and does not count as the server being down', async t => {
  const api = await scripted(t, body => (body.max_tokens === 1 ? {status: 400, body: {error: {message: 'request (5000 tokens) exceeds the available context size (4096 tokens), try increasing it', type: 'exceed_context_size_error', n_ctx: 4096}}} : {thinking: 0, text: 'ok'}));
  const {server, logs} = supervisor(t, api);
  assert.equal((await server.ensure()).contextSize, 8192);
  assert.equal(await server.prewarm([{role: 'system', content: 'persona'}, {role: 'user', content: 'hi'}]), false);
  assert.equal(server.status().state, 'ready');
  assert.equal((await server.ensure()).contextSize, 4096);
  assert(logs.every(line => !/stopped answering/.test(line)), logs.join('\n'));
  // A refusal that names no context halves the one assumed (not below 2048); our own words in the log never carry an address.
  const quiet = await scripted(t, () => ({status: 502, body: {error: {message: 'Engine protocol predict request returned 400: the prompt exceeds the context size'}}}));
  const other = supervisor(t, quiet);
  await other.server.ensure();
  await other.server.prewarm([{role: 'user', content: 'hi'}]);
  assert.equal((await other.server.ensure()).contextSize, 4096);
  assert.equal(other.server.status().state, 'ready');
  assert(other.logs.every(line => !/127\.0\.0\.1/.test(line)), other.logs.join('\n'));
});

test('the new notice lines are one sentence each and are in the notices, the phone status and the error-report allow list', async () => {
  const lua = await readFile(new URL('../mod/init.lua', import.meta.url), 'utf8');
  const notices = await readFile(new URL('../mod/notices.lua', import.meta.url), 'utf8');
  const phone = await readFile(new URL('../mod/phone-chat.lua', import.meta.url), 'utf8');
  for (const id of ['local-thinking', 'local-context']) {
    assert.match(notices, new RegExp(`\\['${id}'\\] = \\{class = PLAYER, repeatS = 30\\}`));
    assert.match(lua, new RegExp(`reply\\.errorCode == '${id}'`));
    assert.match(phone, new RegExp(`\\['${id}'\\] =`));
  }
  assert.match(lua, /Your model only thought and didn't answer\. Turn thinking off for it in your model server, or pick a non-thinking model\./);
  assert.match(lua, /Your model server's context is too small for this character\. Raise the context length in your server \(8192 or more\)\./);
});
