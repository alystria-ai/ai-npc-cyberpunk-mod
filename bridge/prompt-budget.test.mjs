import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PersonaBook, buildMessages, PROMPT_SOURCE, systemHead} from './mistral-prompt.mjs';
import {BUDGET, PromptTooLarge, TokenMeter, budgetedChat, describeFit, estimateTokens, fitMessages, templateTokens, textTokens} from './prompt-budget.mjs';
import {MistralError, errorCodeFor, mapFailure} from './mistral-client.mjs';
import {conversationContextBlocks} from './quest-context.mjs';

const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const judy = new PersonaBook(roster).persona('judy-alvarez');

// Lines of about 70 characters, so a block can be halved at a line boundary.
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
const joinWorld = blocks => blocks.map(block => block.text).join('\n\n');
const exchanges = count => Array.from({length: count}, (_, index) => ({v: `Tell me about the job number ${index} and what happened that night at the Clouds.`,
  r: 'It was a long night, V. Braindance work is mostly waiting, then everything happens at once and you wish it had not.'}));
function turn({blocks = WORLD_BLOCKS(), history = exchanges(8), remembered = [{text: 'V told me V likes the noodles at the corner stall.'}, {text: 'I promised V a braindance on Friday.'}],
  volatile = 'Whether you ask V anything is your own call.', text = 'What are you up to right now?'} = {}) {
  return {persona: judy, memory: 'I remember that V helped me with a job at the Clouds and that we get along.', history,
    contextParts: {now: 'You are with V in person. It is night, about 11 PM, in Kabuki.', notes: 'FORMAT: use {joy} tags for feelings.', world: joinWorld(blocks), worldBlocks: blocks, volatile},
    remembered, text, reaction: false};
}
const chars = messages => messages.reduce((sum, message) => sum + message.content.length, 0);
// A tokenizer that counts 4.2 characters a token, like the real models do on this prompt.
const counter = (log = []) => async messages => { log.push(messages.length); return Math.ceil(chars(messages) / 4.2) + templateTokens(messages.length); };

test('textTokens: English prose by the learned ratio, Chinese, Japanese and Korean about a token a character, other scripts half a token', () => {
  assert.equal(textTokens('', 4), 0);
  assert.equal(Math.round(textTokens('x'.repeat(400), 4)), 100);
  assert(textTokens('日本語のテキストです。'.repeat(10), 4) >= 90, 'about one token per Japanese character');
  assert(textTokens('Привет, как дела у тебя сегодня?'.repeat(10), 4) > 140, 'Cyrillic costs more than English');
  assert(estimateTokens([{role: 'user', content: 'x'.repeat(360)}], 3.6) === 100 + templateTokens(1));
});

test('TokenMeter: the lowest ratio of the server\'s own counts wins, a short or non-English prompt teaches nothing', () => {
  const meter = new TokenMeter();
  assert.equal(meter.charsPerToken, BUDGET.charsPerToken);
  const prompt = chars => [{role: 'system', content: 'a'.repeat(chars)}];
  assert.equal(meter.observe(prompt(100), 40), false);                               // too short
  assert.equal(meter.observe([{role: 'user', content: 'ありがとう'.repeat(100)}], 900), false);   // not English
  assert.equal(meter.observe(prompt(8400), 2000 + templateTokens(1)), true);        // 4.2 characters a token
  assert(Math.abs(meter.charsPerToken - 4.2 * 0.97) < 0.01);
  assert.equal(meter.observe(prompt(7000), 2000 + templateTokens(1)), true);        // 3.5: the lower one counts
  assert(Math.abs(meter.charsPerToken - 3.5 * 0.97) < 0.01);
  meter.reset();
  assert.equal(meter.charsPerToken, BUDGET.charsPerToken);
});

test('a prompt that fits is built exactly as buildMessages builds it, and asks the tokenizer nothing', async () => {
  const args = turn({blocks: WORLD_BLOCKS().filter(block => block.key === 'journal' || !block.key), history: exchanges(2)});
  const counts = [];
  const fit = await fitMessages({args, budget: {contextTokens: 16384, meter: new TokenMeter(), count: counter(counts)}});
  assert.deepEqual(fit.messages, buildMessages(args));
  assert.deepEqual(fit.trimmed, []);
  assert.equal(fit.fits, true);
  assert.equal(counts.length, 0);
  // Without a context the prompt is simply built.
  assert.deepEqual((await fitMessages({args, budget: null})).messages, buildMessages(args));
});

test('a prompt over n_ctx is cut in priority order and keeps the persona, the rules, the format notes and the right-now block', async () => {
  const args = turn();
  const raw = buildMessages(args);
  assert(estimateTokens(raw) > 8192, `the raw prompt (${estimateTokens(raw)} estimated tokens) is over an 8192-token context`);
  const fit = await fitMessages({args, budget: {contextTokens: 8192, meter: new TokenMeter(), count: counter()}});
  assert.equal(fit.fits, true);
  assert(fit.tokens <= fit.limit && fit.limit < 8192 - BUDGET.reserveTokens + 1, `${fit.tokens} of ${fit.limit}`);
  // The lowest-priority knowledge goes first, in the documented order.
  assert.equal(fit.trimmed[0], 'jobs:half');
  const order = ['jobs', 'history', 'recency', 'gear'].map(key => fit.trimmed.findIndex(step => step.startsWith(key)));
  for (const index of order.filter(index => index >= 0)) assert(index >= 0);
  assert.deepEqual(order.filter(index => index >= 0), [...order.filter(index => index >= 0)].sort((a, b) => a - b), 'jobs, then the journal history, then shared events, then gear');
  const system = fit.messages[0].content;
  assert(system.includes(systemHead({persona: {...judy, samples: fit.trimmed.includes('samples') ? [] : judy.samples}})), 'the persona and the output rules are whole');
  assert(system.includes('OUTPUT RULES'));
  assert(system.includes('FORMAT: use {joy} tags for feelings.'));
  assert(system.includes('You are with V in person. It is night, about 11 PM, in Kabuki.'));
  assert(system.includes('TRACKED QUEST: Pisces'), 'the tracked quest outlives the lists');
  assert(!system.includes('AVAILABLE JOBS') || fit.trimmed.includes('jobs:half') && !fit.trimmed.includes('jobs:drop'));
  assert(fit.messages.at(-1).content.includes('V says: What are you up to right now?'));
  assert(chars(fit.messages) < chars(raw));
  assert.match(describeFit(fit), /cut: jobs:half/);
});

test('a smaller context cuts further, never into the persona, the rules, the notes or the right-now block', async () => {
  const args = turn();
  const budget = {contextTokens: 5120, meter: new TokenMeter(), count: counter()};
  const fit = await fitMessages({args, budget});
  assert.equal(fit.fits, true, describeFit(fit));
  assert(fit.trimmed.includes('older-exchanges'), 'older exchanges go once the lists are gone');
  assert(fit.messages.length < buildMessages(args).length);
  const kept = fit.messages.filter(message => message.role === 'assistant').length;
  assert(kept >= BUDGET.keepExchanges - 0 || fit.trimmed.includes('exchanges'), 'the last exchanges stay as long as anything else can go first');
  const system = fit.messages[0].content;
  for (const text of ['OUTPUT RULES', 'FORMAT: use {joy} tags', 'RIGHT NOW', 'You are with V in person.']) assert(system.includes(text), text);
});

test('the cuts are the same from turn to turn, so the early part of the prompt stays identical for the server\'s prefix cache', async () => {
  const budget = () => ({contextTokens: 8192, meter: new TokenMeter(), count: counter()});
  const one = await fitMessages({args: turn({history: exchanges(4)}), budget: budget()});
  const two = await fitMessages({args: turn({history: exchanges(5), text: 'And what about the other one?'}), budget: budget()});
  assert.equal(one.messages[0].content, two.messages[0].content, 'the system message does not change when only the history grows');
  assert.deepEqual(one.trimmed.filter(step => /^(jobs|history|recency|gear)/.test(step)), two.trimmed.filter(step => /^(jobs|history|recency|gear)/.test(step)));
});

test('the server\'s token count settles a prompt the estimate puts over the limit: nothing that fits is cut', async () => {
  const args = turn({blocks: WORLD_BLOCKS().filter(block => !block.key || block.key === 'journal' || block.key === 'knowledge'), history: exchanges(8)});
  const raw = buildMessages(args);
  const meter = new TokenMeter({charsPerToken: 2.5});          // a ratio far too low: the estimate says the prompt is huge
  const counts = [];
  const fit = await fitMessages({args, budget: {contextTokens: 8192, meter, count: counter(counts)}});
  assert(estimateTokens(raw, 2.5) > fit.limit, 'the estimate alone would cut');
  assert.deepEqual(fit.trimmed, []);
  assert.equal(counts.length, 1);
  assert.equal(fit.exact, true);
  assert(fit.tokens <= fit.limit);
});

test('a persona and rules that alone do not fit are never cut: the fit says so', async () => {
  const fit = await fitMessages({args: turn(), budget: {contextTokens: 2048, meter: new TokenMeter()}});
  assert.equal(fit.fits, false);
  assert(fit.tokens > fit.limit);
  assert(fit.messages[0].content.includes('OUTPUT RULES'));
  assert.match(describeFit(fit), /does not fit/);
});

test('the older layout (no contextParts) is cut too', async () => {
  const args = {persona: judy, memory: '', history: exchanges(8), context: lines('world', 400), remembered: [], text: 'hi', reaction: false};
  const fit = await fitMessages({args, budget: {contextTokens: 8192, meter: new TokenMeter(), count: counter()}});
  assert.equal(fit.fits, true);
  assert(fit.trimmed.includes('context:cap'));
});

test('buildMessages leaves its arguments on the messages, and the request body does not change', () => {
  const args = turn({history: exchanges(1)});
  const messages = buildMessages(args);
  assert.equal(messages[PROMPT_SOURCE].text, args.text);
  assert.equal(JSON.stringify(messages).includes('worldBlocks'), false);
  assert.deepEqual(Object.keys(messages), messages.map((_, index) => String(index)));
});

test('budgetedChat: requests without a source, and routes without a budget, pass through untouched', async () => {
  const seen = [];
  const chat = async options => { seen.push(options.messages); return {text: 'ok'}; };
  const plain = [{role: 'user', content: 'hi'}];
  await budgetedChat(chat, {budget: async () => ({contextTokens: 8192})})({messages: plain});
  const built = buildMessages(turn({history: exchanges(1), blocks: []}));
  await budgetedChat(chat, {budget: async () => null})({messages: built});
  assert.equal(seen[0], plain);
  assert.equal(seen[1], built);
});

test('budgetedChat: a server that still refuses the prompt says what it counted; that count is learned and the request is sent once more, smaller', async () => {
  const args = turn();
  const meter = new TokenMeter({charsPerToken: 6});            // far too optimistic: the first fit cuts nothing
  const sent = [];
  const refusing = async options => {
    sent.push(chars(options.messages));
    const tokens = Math.ceil(chars(options.messages) / 4.2) + templateTokens(options.messages.length);
    if (tokens > 7000) throw Object.assign(new MistralError('request', 'exceeds the available context size', {provider: 'local'}), {overflow: {promptTokens: tokens, contextTokens: 7000}});
    return {text: 'ok', usage: {prompt_tokens: tokens}};
  };
  const fits = [];
  const chat = budgetedChat(refusing, {budget: async () => ({contextTokens: 7000, meter}), onFit: fit => fits.push(fit)});
  const result = await chat({messages: buildMessages(args), provider: 'local'});
  assert.equal(result.text, 'ok');
  assert.equal(sent.length, 2, 'one refusal, one retry');
  assert(sent[1] < sent[0]);
  assert(meter.charsPerToken < 4.2, 'the learned ratio replaces the optimistic one');
  assert(fits.length >= 1);
  // A second refusal is final.
  const stubborn = budgetedChat(async options => { throw Object.assign(new MistralError('request', 'x', {provider: 'local'}), {overflow: {promptTokens: 99999, contextTokens: 8192}}); },
    {budget: async () => ({contextTokens: 8192, meter: new TokenMeter({charsPerToken: 6})})});
  await assert.rejects(stubborn({messages: buildMessages(args), provider: 'local'}), error => error.overflow?.promptTokens === 99999);
});

test('budgetedChat: a prompt that cannot fit is a failed local request the host falls back from, with a game code', async () => {
  const chat = budgetedChat(async () => ({text: 'never'}), {budget: async () => ({contextTokens: 2048, meter: new TokenMeter()})});
  const error = await chat({messages: buildMessages(turn()), provider: 'local'}).catch(caught => caught);
  assert(error instanceof PromptTooLarge && error instanceof MistralError);
  assert.match(error.message, /\[local:request\]/);
  assert.equal(errorCodeFor(error), 'local-failed');
});

test('llama-server\'s refusal of a long prompt is an overflow with the counted tokens, and a local failure has the game code local-failed', () => {
  const body = {error: {code: 400, type: 'exceed_context_size_error', n_prompt_tokens: 8790, n_ctx: 8192,
    message: 'request (8790 tokens) exceeds the available context size (8192 tokens), try increasing it'}};
  const error = mapFailure(400, body, {provider: 'local'});
  assert.equal(error.kind, 'request');
  assert.deepEqual(error.overflow, {promptTokens: 8790, contextTokens: 8192});
  assert.equal(errorCodeFor(error), 'local-failed');
  // Without the typed fields the message still carries the counts.
  const plain = mapFailure(400, {error: {message: 'request (9000 tokens) exceeds the available context size (8192 tokens), try increasing it'}}, {provider: 'local'});
  assert.deepEqual(plain.overflow, {promptTokens: 9000, contextTokens: 8192});
  assert.equal(mapFailure(400, {error: {message: 'bad request'}}, {provider: 'local'}).overflow, undefined);
});

test('the world blocks of a named character carry the keys the trimming order uses', () => {
  const blocks = conversationContextBlocks({profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private', text: 'hi', requestId: 'r1'});
  const keys = blocks.filter(block => block.tier === 'world' && block.key).map(block => block.key);
  assert.deepEqual(keys, ['knowledge', 'recency', 'history', 'jobs', 'journal', 'gear']);
});
