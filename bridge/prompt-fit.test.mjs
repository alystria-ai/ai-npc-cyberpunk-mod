import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PersonaBook, buildMessages, PROMPT_SOURCE} from './mistral-prompt.mjs';
import {BUDGET, budgetedChat, TokenMeter, estimateTokens, templateTokens} from './prompt-budget.mjs';
import {MistralError, contextRefusal, mapFailure} from './mistral-client.mjs';
import {customRoute, mistralRoute} from './text-provider-host.mjs';
import {LIMIT_TTL_MS, LearnedLimits, MIN_LEARNED_LIMIT, learnedLimitChat, promptFitLine, trimmedText} from './prompt-fit.mjs';

// A text provider that refuses a prompt as too long and says how long it may be: the limit is read, the prompt is cut to it, the request is sent again once, the limit is remembered.
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const judy = new PersonaBook(roster).persona('judy-alvarez');
const lines = (label, count) => Array.from({length: count}, (_, index) => `- ${label} item ${index + 1}: a plain fact about the world that the character may know of.`).join('\n');
const WORLD_BLOCKS = () => [
  {key: undefined, text: 'RELATIONSHIP: V and Judy are friends. Judy trusts V.'},
  {key: 'knowledge', text: 'WORLD FACTS\n' + lines('fact', 60)},
  {key: 'recency', text: 'RECENT SHARED EVENTS\n' + lines('event', 30)},
  {key: 'history', text: 'JOURNAL HISTORY\n' + lines('quest', 80)},
  {key: 'jobs', text: 'AVAILABLE JOBS\n' + lines('job', 80)},
  {key: 'journal', text: 'TRACKED QUEST: Pisces. Objective: meet Judy at the Clouds.'},
  {key: 'gear', text: 'V WEARS\n' + lines('gear', 8)},
];
const exchanges = count => Array.from({length: count}, (_, index) => ({v: `Tell me about the job number ${index} and what happened that night at the Clouds.`,
  r: 'It was a long night, V. Braindance work is mostly waiting, then everything happens at once and you wish it had not.'}));
const TEXT = 'What are you up to right now, Judy?';
function turn() {
  const blocks = WORLD_BLOCKS();
  return {persona: judy, memory: 'I remember that V helped me with a job at the Clouds and that we get along.', history: exchanges(8),
    contextParts: {now: 'You are with V in person. It is night, about 11 PM, in Kabuki.', notes: 'FORMAT: use {joy} tags for feelings.', world: blocks.map(block => block.text).join('\n\n'), worldBlocks: blocks,
      volatile: 'Whether you ask V anything is your own call.'},
    remembered: [{text: 'V told me V likes the noodles at the corner stall.'}, {text: 'I promised V a braindance on Friday.'}], text: TEXT, reaction: false};
}
// The tokenizer of the fake provider: 4.2 characters a token, like the real models on this prompt.
const chars = messages => messages.reduce((sum, message) => sum + message.content.length, 0);
const tokensOf = messages => Math.ceil(chars(messages) / 4.2) + templateTokens(messages.length);
const MAX_TOKENS = 300;

// The refusal in each provider's words, built the way the client builds it (mapFailure), for a prompt of `prompt` tokens against `limit`.
const SHAPES = {
  groq: {provider: 'custom', status: 413, words: (limit, prompt) => `Request too large for model \`openai/gpt-oss-120b\` in organization \`org_01m5w39tn6ewg9f0ccksqgt74h\` service tier \`on_demand\` on tokens per minute (TPM): Limit ${limit}, Requested ${prompt + MAX_TOKENS}, please reduce your message size and try again.`},
  groqInput: {provider: 'custom', status: 413, words: (limit, prompt) => `Request too large for model \`qwen/qwen3.8-27b\` in organization \`org_x\` service tier \`on_demand\` on input tokens per minute (ITPM): Limit ${limit}, Requested ${prompt}`},
  openai: {provider: 'custom', status: 400, words: (limit, prompt) => `This model's maximum context length is ${limit} tokens. However, your messages resulted in ${prompt} tokens. Please reduce the length of the messages.`},
  openrouter: {provider: 'custom', status: 400, words: (limit, prompt) => `This endpoint's maximum context length is ${limit} tokens. However, you requested about ${prompt + MAX_TOKENS} tokens (${prompt} of text input, ${MAX_TOKENS} in the output).`},
  llama: {provider: 'custom', status: 400, words: (limit, prompt) => `request (${prompt} tokens) exceeds the available context size (${limit} tokens), try increasing it`},
  mistral: {provider: 'mistral', status: 400, words: (limit, prompt) => `Prompt contains ${prompt} tokens, too large for model with ${limit} maximum context length`},
  anthropic: {provider: 'custom', status: 400, words: (limit, prompt) => `prompt is too long: ${prompt} tokens > ${limit} maximum`},
};
function refusal(shape, limit, prompt) {
  const {provider, status, words} = SHAPES[shape];
  return mapFailure(status, {error: {message: words(limit, prompt)}}, {provider});
}
// A provider with a limit: refuses what is over it, in `shape`'s words, answers the rest.
function provider(shape, limit, {always = false} = {}) {
  const calls = [];
  const chat = async options => {
    const prompt = tokensOf(options.messages);
    calls.push({messages: options.messages, prompt, options});
    if (always || prompt + (shape === 'groq' || shape === 'openrouter' ? MAX_TOKENS : 0) > limit) throw refusal(shape, limit, prompt);
    return {text: 'ok', usage: {prompt_tokens: prompt}};
  };
  return {chat, calls};
}
const request = (shape, extra = {}) => ({messages: buildMessages(turn()), provider: SHAPES[shape].provider, model: 'the-model', trustedOrigin: 'https://api.example.test', maxTokens: MAX_TOKENS, ...extra});

for (const shape of Object.keys(SHAPES)) {
  test(`${shape}: the refusal names the limit, the prompt is cut to it and sent again once, the limit is remembered and the next turn is built to fit`, async () => {
    const limit = 8000, fake = provider(shape, limit), logged = [], limits = new LearnedLimits();
    const chat = learnedLimitChat(fake.chat, {limits, log: line => logged.push(line)});
    const first = request(shape);
    assert(tokensOf(first.messages) > limit, 'the full prompt is over the limit');
    const answer = await chat(first);
    assert.equal(answer.text, 'ok');
    assert.equal(fake.calls.length, 2, 'refused once, sent again once');
    assert(fake.calls[1].prompt + (shape === 'groq' || shape === 'openrouter' ? MAX_TOKENS : 0) <= limit, `the second prompt fits (${fake.calls[1].prompt})`);
    assert(fake.calls[1].prompt < fake.calls[0].prompt);
    // What is never cut: the persona and rules, the player's words, the right-now block.
    const sent = fake.calls[1].messages;
    assert(sent[0].content.includes('OUTPUT RULES'), 'the output rules stay');
    assert(sent.at(-1).content.includes(TEXT), 'the player\'s words stay');
    assert(sent.map(message => message.content).join('\n').includes('You are with V in person'), 'the right-now block stays');
    assert.equal(limits.get(`${SHAPES[shape].provider}|https://api.example.test|the-model`), limit);
    assert.equal(logged.length, 1);
    assert.match(logged[0], new RegExp(`^\\[PromptFit\\] provider=${SHAPES[shape].provider} model=the-model limit=${limit} sent=\\d+ trimmed=[a-z:,0-9-]+ retried=ok$`), logged[0]);
    // The next turn: built to fit from the start, one request.
    const next = await chat(request(shape));
    assert.equal(next.text, 'ok');
    assert.equal(fake.calls.length, 3, 'one request, no refusal');
    assert(fake.calls[2].prompt <= limit);
    assert.equal(logged.length, 1, 'no log line for a turn that was fitted from the start');
  });
}

test('the oldest and lowest-priority content goes first: knowledge blocks and memories before the recent talk; the order is the Local AI\'s', async () => {
  const fake = provider('groq', 8000), logged = [];
  await learnedLimitChat(fake.chat, {log: line => logged.push(line)})(request('groq'));
  const names = /trimmed=(\S+)/.exec(logged[0])[1].split(',').map(item => item.split(':')[0]);
  assert(names.length >= 2, logged[0]);
  assert(names.indexOf('jobs') < names.indexOf('older-exchanges') || !names.includes('older-exchanges'), 'knowledge before history');
  assert.equal(trimmedText(['jobs:drop', 'older-exchanges', 'older-exchanges', 'older-exchanges:block']), 'jobs:1,older-exchanges:3');
  assert.equal(trimmedText([]), 'none');
});

test('a retry that is refused again is the end: two requests in all, the second refusal reaches the caller, the line says retried=failed', async () => {
  const fake = provider('groq', 8000, {always: true}), logged = [], limits = new LearnedLimits();
  await assert.rejects(learnedLimitChat(fake.chat, {limits, log: line => logged.push(line)})(request('groq')), error => error instanceof MistralError && !!error.overflow);
  assert.equal(fake.calls.length, 2, 'never a third request');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /retried=failed$/);
});

test('a prompt that cannot fit without the persona is the plain "does not fit" refusal, after the limit is learned', async () => {
  const fake = provider('openai', 3000), logged = [];
  await assert.rejects(learnedLimitChat(fake.chat, {log: line => logged.push(line)})(request('openai')), error => error.name === 'PromptTooLarge');
  assert.equal(fake.calls.length, 1, 'nothing was sent a second time: the persona alone is over the limit');
  assert.match(logged[0], /retried=failed$/);
});

test('a normal turn costs nothing: with no limit known the request goes out as it was, the same messages, one request', async () => {
  const fake = provider('groq', 1_000_000), limits = new LearnedLimits();
  const chat = learnedLimitChat(fake.chat, {limits});
  const options = request('groq');
  await chat(options);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].messages, options.messages, 'the very same messages');
  assert.equal(limits.size, 0);
});

test('only a prompt built by buildMessages can be cut: a summary, an aborted request or a refusal without a limit is not sent again', async () => {
  const fake = provider('groq', 8000);
  const chat = learnedLimitChat(fake.chat);
  const plain = [{role: 'user', content: 'x'.repeat(40_000)}];
  await assert.rejects(chat({messages: plain, provider: 'custom', model: 'the-model', maxTokens: MAX_TOKENS}));
  assert.equal(fake.calls.length, 1, 'no source, no second request');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(chat({...request('groq'), signal: controller.signal}));
  assert.equal(fake.calls.length, 2, 'aborted: no second request');
  const calls = [];
  const odd = learnedLimitChat(async options => { calls.push(options); throw mapFailure(400, {error: {message: 'bad request: unknown field'}}, {provider: 'custom'}); });
  await assert.rejects(odd(request('groq')));
  assert.equal(calls.length, 1, 'not a size refusal');
  const tiny = learnedLimitChat(async options => { calls.push(options); throw refusal('openai', MIN_LEARNED_LIMIT - 1, 9000); });
  await assert.rejects(tiny(request('openai')));
  assert.equal(calls.length, 2, 'a limit smaller than any persona is not learned');
});

test('a rate limit with a wait ("Rate limit reached ... Used, Requested") is not a size refusal', () => {
  const error = mapFailure(429, {error: {message: 'Rate limit reached for model `x` on tokens per minute (TPM): Limit 6000, Used 5200, Requested 900. Please try again in 8s.'}}, {provider: 'custom'});
  assert.equal(error.overflow, undefined);
  assert.equal(error.kind, 'limit');
});

test('the limit is kept per provider, address and model: another model is not cut to it', async () => {
  const limits = new LearnedLimits();
  const fake = provider('groq', 8000);
  const chat = learnedLimitChat(fake.chat, {limits});
  await chat(request('groq'));
  assert.equal(limits.get('custom|https://api.example.test|the-model'), 8000);
  assert.equal(limits.get('custom|https://api.example.test|other-model'), undefined);
  assert.equal(limits.get('custom|https://other.example.test|the-model'), undefined);
  const big = provider('groq', 1_000_000);
  const bigChat = learnedLimitChat(big.chat, {limits});
  const other = request('groq', {model: 'other-model'});
  await bigChat(other);
  assert.equal(big.calls[0].messages, other.messages, 'the other model is sent as it is');
});

test('a limit known from the start whose provider takes it lower is cut and sent again once by the fit itself, with the same line', async () => {
  const limits = new LearnedLimits();
  limits.learn('custom|https://api.example.test|the-model', 12000);   // the estimate (3.6 characters a token) still lets the whole prompt through
  const fake = provider('groq', 8000), logged = [];
  const answer = await learnedLimitChat(fake.chat, {limits, log: line => logged.push(line)})(request('groq'));
  assert.equal(answer.text, 'ok');
  assert.equal(fake.calls.length, 2);
  assert.equal(limits.get('custom|https://api.example.test|the-model'), 8000, 'the lower limit replaces it');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /limit=8000 .*retried=ok$/);
});

test('the learned limits are kept in a small file, without a key or an address of a person, and expire after three days', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'prompt-fit-'));
  try {
    const file = join(folder, 'prompt-limits.json');
    let now = 1_000_000;
    const first = new LearnedLimits({file, now: () => now});
    first.learn('custom|https://api.groq.com|openai/gpt-oss-120b', 8000);
    first.learn('custom|https://x|tiny', 10);   // below the smallest worth learning
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(Object.keys(saved.limits), ['custom|https://api.groq.com|openai/gpt-oss-120b']);
    assert.equal(new LearnedLimits({file, now: () => now + 1000}).get('custom|https://api.groq.com|openai/gpt-oss-120b'), 8000, 'the next session starts from it');
    assert.equal(new LearnedLimits({file, now: () => now + LIMIT_TTL_MS + 1}).get('custom|https://api.groq.com|openai/gpt-oss-120b'), undefined, 'a plan that was upgraded since is asked again');
    await writeFile(file, '{ not json');
    assert.equal(new LearnedLimits({file}).size, 0);
    await writeFile(file, JSON.stringify({version: 1, limits: {a: {limit: 'x', at: 1}, b: {limit: 100, at: Date.now()}, c: 7}}));
    assert.equal(new LearnedLimits({file}).size, 0);
    assert.doesNotThrow(() => new LearnedLimits({file: join(folder, 'missing', 'x.json'), writeText: () => { throw new Error('disk full'); }}).learn('k', 5000));
  } finally { await rm(folder, {recursive: true, force: true}); }
});

test('the custom and Mistral routes wrap their chat, and the Local AI route\'s fit tells the same story through its own hook', async () => {
  const logged = [];
  const fake = provider('groq', 8000);
  const limits = new LearnedLimits();
  const custom = customRoute({provider: {}, custom: {origin: 'https://api.example.test', model: 'the-model'}, chat: fake.chat, limits, log: line => logged.push(line)});
  assert.equal((await custom.chat(request('groq'))).text, 'ok');
  assert.match(logged[0], /^\[PromptFit\] provider=custom /);
  const mistralFake = provider('mistral', 8000), mistralLogged = [];
  const mistral = mistralRoute({provider: {}, chat: mistralFake.chat, limits: new LearnedLimits(), log: line => mistralLogged.push(line)});
  assert.equal((await mistral.chat({...request('mistral'), provider: 'mistral', model: 'mistral-small-latest'})).text, 'ok');
  assert.match(mistralLogged[0], /^\[PromptFit\] provider=mistral model=mistral-small-latest limit=8000 /);
  // A model server the player runs: budgetedChat's own retry reports through onLearned.
  const server = provider('llama', 8000), serverLogged = [];
  const fitted = budgetedChat(server.chat, {budget: async () => ({contextTokens: 20_000, meter: new TokenMeter(), server: true}), learn: () => {}, onLearned: (info, options) => serverLogged.push(promptFitLine({provider: 'local', model: 'm'}, info))});
  assert.equal((await fitted(request('llama'))).text, 'ok');
  assert.equal(server.calls.length, 2);
  assert.match(serverLogged[0], /^\[PromptFit\] provider=local model=m limit=8000 sent=\d+ trimmed=\S+ retried=ok$/);
  assert(server.calls[1].prompt <= 8000 - BUDGET.reserveTokens);
});

test('contextRefusal reads each shape and nothing else', () => {
  const read = (status, words) => contextRefusal(status, words, null);
  assert.deepEqual(read(413, SHAPES.groq.words(8000, 8326)), {promptTokens: 8626, contextTokens: 8000});
  assert.deepEqual(read(400, SHAPES.openai.words(8192, 9000)), {promptTokens: 9000, contextTokens: 8192});
  assert.deepEqual(read(400, SHAPES.openrouter.words(8192, 9000)), {promptTokens: 9300, contextTokens: 8192});
  assert.deepEqual(read(400, SHAPES.llama.words(8192, 9000)), {promptTokens: 9000, contextTokens: 8192});
  assert.deepEqual(read(400, SHAPES.mistral.words(32768, 40050)), {promptTokens: 40050, contextTokens: 32768});
  assert.deepEqual(read(400, SHAPES.anthropic.words(200000, 210000)), {promptTokens: 210000, contextTokens: 200000});
  assert.equal(read(429, SHAPES.groq.words(8000, 8326)), null, 'a 429 is a rate limit, waited out');
  assert.equal(read(400, 'unknown field'), null);
  assert.equal(estimateTokens([{content: 'x'}]) > 0, true);
});

test('the bridge wires it: one limits file in the state folder, the log goes to stderr as it is, nothing on a normal turn', async () => {
  const bridge = await readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /const promptLimits = new LearnedLimits\(\{file: resolve\(stateDirectory, 'prompt-limits\.json'\)\}\)/);
  assert.match(bridge, /customRoute\(\{provider: mistral, custom: customEndpoint, limits: promptLimits, log: line => console\.error\(line\)\}\)/);
  assert.match(bridge, /limits: promptLimits, log: line => console\.error\(line\)\}\),\s*local:/);
  assert.equal(PROMPT_SOURCE.description, 'cyberpunk-convai.prompt-source');
});
