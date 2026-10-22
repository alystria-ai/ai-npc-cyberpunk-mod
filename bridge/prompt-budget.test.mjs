import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PersonaBook, LIMITS, buildMessages, knowledgeApart, PROMPT_SOURCE, systemHead, worldBlocksInCacheOrder} from './mistral-prompt.mjs';
import {BUDGET, COLD_PROMPT, PREFILL, PrefillMeter, PromptTooLarge, coldAttemptRoomMs, TokenMeter, budgetedChat, describeFit, estimateTokens, fitLimit, fitMessages, templateTokens, textTokens} from './prompt-budget.mjs';
import {MistralError, errorCodeFor, mapFailure} from './mistral-client.mjs';
import {conversationContextBlocks} from './quest-context.mjs';
import {matureLayer} from './mature-content.mjs';

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

test('textTokens: English prose by the learned ratio, Chinese, Japanese and Korean about two thirds of a token a character, other scripts half a token, Latin extended letters about one', () => {
  assert.equal(textTokens('', 4), 0);
  assert.equal(Math.round(textTokens('x'.repeat(400), 4)), 100);
  assert(textTokens('日本語のテキストです。'.repeat(10), 4) >= 75, 'two thirds of a token per Japanese character (measured 0.48 to 0.67)');
  assert(textTokens('Привет, как дела у тебя сегодня?'.repeat(10), 4) > 140, 'Cyrillic costs more than English');
  assert(textTokens('Zażółć gęślą jaźń, szczęśliwy człowiek.'.repeat(10), 4) > textTokens('Zazolc gesla jazn, szczesliwy czlowiek.'.repeat(10), 4) * 1.5, 'Latin extended letters cost more than plain ones');
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

test('shrinkPersona: with nothing optional left a persona that does not fit a 4096-token context is shortened in fixed levels, and nothing else of the prompt is cut', async () => {
  const args = {...turn(), mature: 'full'};
  const plain = await fitMessages({args, budget: {contextTokens: 4096, meter: new TokenMeter()}});
  assert.equal(plain.fits, false, 'without the option the persona is never cut (the host falls back to another route)');
  const fit = await fitMessages({args, budget: {contextTokens: 4096, meter: new TokenMeter()}, shrinkPersona: true});
  assert.equal(fit.fits, true, describeFit(fit));
  assert(fit.tokens <= fit.limit && fit.limit < 4096);
  assert(fit.trimmed.some(step => /^persona:\d+$/.test(step)), describeFit(fit));
  assert.equal(fit.trimmed.filter(step => step.startsWith('persona:')).length, 1, 'one entry: the level used');
  const system = fit.messages[0].content;
  for (const text of ['OUTPUT RULES', 'FORMAT: use {joy} tags', 'RIGHT NOW', 'You are with V in person.', matureLayer('full')]) assert(system.includes(text), text);
  assert(system.includes(judy.backstory.slice(0, 200)), 'the backstory keeps its beginning');
  assert(!system.includes(judy.backstory), 'and loses its end');
  assert(!system.includes('EXAMPLES OF YOUR VOICE'), 'the example lines are gone');
  // The level is chosen from the persona and the rest at its smallest: another turn lands on the same persona, so the server's prefix cache holds.
  const next = await fitMessages({args: {...turn({history: exchanges(3), text: 'And the other one?', volatile: 'Another note for this turn.'}), mature: 'full'}, budget: {contextTokens: 4096, meter: new TokenMeter()}, shrinkPersona: true});
  assert.equal(next.fits, true);
  const personaOf = content => content.slice(0, content.indexOf('OUTPUT RULES'));
  assert.equal(personaOf(next.messages[0].content), personaOf(system));
  // A context that holds the persona is not touched by the option; one too small for even the shortest persona still does not fit.
  const roomy = await fitMessages({args, budget: {contextTokens: 8192, meter: new TokenMeter()}, shrinkPersona: true});
  assert.equal(roomy.fits, true);
  assert(!roomy.trimmed.some(step => step.startsWith('persona:')));
  const tiny = await fitMessages({args, budget: {contextTokens: 2048, meter: new TokenMeter()}, shrinkPersona: true});
  assert.equal(tiny.fits, false);
  assert.match(describeFit(tiny), /does not fit/);
});

test('budgetedChat: options.lastResort shortens the persona instead of failing; without it the prompt that cannot fit fails as before', async () => {
  const sent = [];
  const chat = budgetedChat(async options => { sent.push(options.messages); return {text: 'ok', usage: {prompt_tokens: 3000}}; },
    {budget: async () => ({contextTokens: 4096, meter: new TokenMeter()})});
  const refused = await chat({messages: buildMessages(turn()), provider: 'local'}).catch(caught => caught);
  assert(refused instanceof PromptTooLarge);
  assert.equal(sent.length, 0);
  const answered = await chat({messages: buildMessages(turn()), provider: 'local', lastResort: true});
  assert.equal(answered.text, 'ok');
  assert.equal(sent.length, 1);
  assert(estimateTokens(sent[0]) <= 4096 - BUDGET.reserveTokens, 'what was sent fits the context');
  assert(sent[0][0].content.includes('OUTPUT RULES'));
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
  await assert.rejects(stubborn({messages: buildMessages(args), provider: 'local'}), error => error.overflow?.promptTokens === 99999 || error instanceof PromptTooLarge,
    'the second refusal is final (a count that absurd teaches a bias too, so the second fit may find nothing that fits and fail as too large)');
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
  assert.deepEqual(keys, ['knowledge', 'recency', 'history', 'jobs', 'journal', 'gear', 'authority']);
});

test('the world facts ranked by V\'s words come after the blocks that only change on game events, so a turn does not re-read the whole world block', () => {
  const blocks = conversationContextBlocks({profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private', text: 'hi', requestId: 'r1'});
  const world = blocks.filter(block => block.tier === 'world');
  assert.equal(world.find(block => block.key)?.key, 'knowledge', 'the Convai context keeps its own order');
  const ordered = worldBlocksInCacheOrder(world);
  assert.equal(ordered.length, world.length, 'nothing is added or dropped');
  assert.deepEqual(ordered.filter(block => block.key).map(block => block.key), ['recency', 'history', 'jobs', 'journal', 'gear', 'knowledge', 'authority']);
  assert.deepEqual(worldBlocksInCacheOrder([{key: 'gear', text: 'a'}, {text: 'b'}]), [{key: 'gear', text: 'a'}, {text: 'b'}], 'no knowledge block: as it was');
  assert.deepEqual(worldBlocksInCacheOrder([{key: 'knowledge', text: 'k'}, {key: 'gear', text: 'g'}]).map(block => block.key), ['gear', 'knowledge'], 'no authority sentence: the facts go last');
  assert.deepEqual(worldBlocksInCacheOrder(undefined), []);
});

test('two turns that differ only in the world facts share the system message up to those facts: the prompt cache keeps everything before them', () => {
  const facts = text => WORLD_BLOCKS().map(block => block.key === 'knowledge' ? {...block, text} : block);
  const system = blocks => buildMessages(turn({blocks: worldBlocksInCacheOrder(blocks), history: []}))[0].content;
  const first = system(facts('WORLD FACTS\n- the first question was about Arasaka'));
  const second = system(facts('WORLD FACTS\n- a different question, about the Afterlife and its prices'));
  let shared = 0;
  while (shared < first.length && first[shared] === second[shared]) shared++;
  for (const block of WORLD_BLOCKS().filter(item => item.key && item.key !== 'knowledge')) {
    assert(first.indexOf(block.text) >= 0 && first.indexOf(block.text) + block.text.length <= shared, `${block.key} is inside the shared prefix`);
  }
  assert(first.indexOf('FORMAT') < shared && first.indexOf(systemHead({persona: judy}).slice(-80)) < shared, 'the persona and the format notes are shared too');
  // The facts are set apart in the system message wherever they sit in the list of blocks (the Convai order has them first: the failure of the first reports), and
  // they come after the older-talk summary too, which was after them before.
  const early = blocks => buildMessages(turn({blocks, history: []}))[0].content;
  const a = early(facts('WORLD FACTS\n- the first question was about Arasaka')), b = early(facts('WORLD FACTS\n- a different question, about the Afterlife and its prices'));
  let early_shared = 0;
  while (early_shared < a.length && a[early_shared] === b[early_shared]) early_shared++;
  assert(early_shared >= shared - 1, 'the block order of the list no longer matters');
  assert(a.indexOf('I remember that V helped me') < early_shared, 'the older-talk summary is inside the shared prefix');
  assert(a.indexOf('WORLD KNOWLEDGE FOR THIS TURN') <= early_shared && early_shared < a.indexOf('RIGHT NOW'), 'the first difference is in the facts, which come last before the right-now block');
  // Without the list of blocks (older callers), or when the world context was cut by its cap, the old single world block stands.
  const parts = turn({blocks: facts('WORLD FACTS\n- the first question was about Arasaka'), history: []});
  const plain = buildMessages({...parts, contextParts: {...parts.contextParts, worldBlocks: undefined}})[0].content;
  assert(!plain.includes('WORLD KNOWLEDGE FOR THIS TURN') && plain.includes('WORLD FACTS\n- the first question'));
  // A world context over its cap is cut in the stable blocks; the facts stay whole and the two together still fit.
  const factsText = facts('WORLD FACTS\n- the first question was about Arasaka').find(block => block.key === 'knowledge').text;
  const tight = buildMessages({...parts, limits: {...LIMITS, world: 9000}})[0].content;
  assert(tight.includes('WORLD KNOWLEDGE FOR THIS TURN') && tight.includes(factsText));
  const between = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to));
  assert(between(tight, 'WORLD AND QUEST CONTEXT', 'WHAT YOU REMEMBER OF V FROM EARLIER TALKS').length + between(tight, 'WORLD KNOWLEDGE FOR THIS TURN', 'RIGHT NOW').length < 9000 + 400, 'together they fit the cap');
});

test('knowledgeApart: only the blocks the world context was joined from are split, and only when there is a knowledge block', () => {
  const blocks = [{key: 'gear', text: 'G'}, {key: 'knowledge', text: 'K'}, {key: 'authority', text: 'A'}];
  assert.deepEqual(knowledgeApart(blocks, 'G\n\nK\n\nA'), {stable: 'G\n\nA', knowledge: 'K'});
  assert.equal(knowledgeApart(blocks, 'G\n\nK'), null, 'a world text that is not what the blocks make');
  assert.equal(knowledgeApart([{key: 'gear', text: 'G'}], 'G'), null);
  assert.equal(knowledgeApart([{key: 'knowledge', text: ' '}], ''), null);
  assert.equal(knowledgeApart(undefined, 'G'), null);
});

test('the prompt cache: over a conversation with a summary the text a turn shares with the one before is longer, by the summary and everything else that was after the facts; the same words are sent', () => {
  const summary = 'I remember that V helped me with a job at the Clouds and that we get along. ' + 'We talked about the braindance studio and the noodles. '.repeat(18);
  // A world context under its cap (a cut would move with the length of the facts in the old layout and muddy the comparison).
  const smaller = facts => [{key: undefined, text: 'RELATIONSHIP: V and Judy are friends. Judy trusts V.'}, {key: 'knowledge', text: facts}, {key: 'recency', text: 'RECENT SHARED EVENTS\n' + lines('event', 10)},
    {key: 'history', text: 'JOURNAL HISTORY\n' + lines('quest', 30)}, {key: 'jobs', text: 'AVAILABLE JOBS\n' + lines('job', 20)}, {key: 'gear', text: 'V WEARS\n' + lines('gear', 6)}, {key: 'authority', text: 'Current verified save facts override older remembered claims.'}];
  const turnOf = (facts, count) => ({...turn({history: exchanges(count), blocks: smaller(facts), text: 'What next? ' + count}), memory: summary});
  const sharedWith = (build, one, two) => {
    const first = build(one), second = build(two);
    const x = first.map(message => message.content).join('\n#\n'), y = second.map(message => message.content).join('\n#\n');
    let at = 0;
    while (at < x.length && x[at] === y[at]) at++;
    return {chars: at, tokens: estimateTokens([{role: 'user', content: x.slice(0, at)}], BUDGET.knownCharsPerToken), total: x.length, first};
  };
  const oldLayout = args => buildMessages({...args, contextParts: {...args.contextParts, worldBlocks: undefined, world: joinWorld(worldBlocksInCacheOrder(args.contextParts.worldBlocks))}});
  const one = turnOf('WORLD FACTS\n' + lines('first-question fact', 40), 6), two = turnOf('WORLD FACTS\n' + lines('second-question fact', 40), 7);
  const before = sharedWith(oldLayout, one, two), after = sharedWith(buildMessages, one, two);
  console.log(`prompt cache: shared with the turn before ${before.chars} chars (${Math.round(before.tokens)} tokens) before, ${after.chars} (${Math.round(after.tokens)} tokens) after, of ${after.total} chars`);
  assert(after.chars > before.chars + summary.length - 5, `shared before ${before.chars} chars, after ${after.chars}`);
  assert(after.tokens > before.tokens + 200, 'at least the summary is read from the cache now');
  // Nothing is added or dropped but the one heading: the same lines are in the system message.
  const lineSet = text => text.split('\n').filter(Boolean).sort();
  const oldSystem = oldLayout(one)[0].content, newSystem = after.first[0].content;
  assert.deepEqual(lineSet(newSystem).filter(line => !line.startsWith('WORLD KNOWLEDGE FOR THIS TURN')), lineSet(oldSystem));
  assert.deepEqual(after.first.slice(1), oldLayout(one).slice(1), 'the history and the last message are untouched');
});

test('PrefillMeter: a slow reading is carried to the model that replaces it on the same computer, for as long as it is recent, and a fast one is not', () => {
  let clock = 1_000_000;
  const now = () => clock;
  const cpu = new PrefillMeter({now, offload: true});
  assert.deepEqual(cpu.carry(), {rate: PREFILL.offloadPrior, at: clock}, 'the prior of a model with layers on the CPU is carried while a turn used it lately');
  clock += 4 * 60_000; cpu.touch();
  const next = new PrefillMeter({now, carry: cpu.carry()});
  assert.equal(next.tokensPerSecond, PREFILL.offloadPrior, 'a model on the card that follows it is believed slow at first');
  assert.equal(next.slow, true);
  next.observe({timings: {promptTokens: 3000, cachedTokens: 0, promptMs: 1000}});   // 3,000 a second: the card is fine after all
  assert.equal(next.tokensPerSecond, (PREFILL.offloadPrior + 3000) / 2);
  assert.equal(next.slow, false, 'measured fast within one turn');
  assert.equal(next.carry(), null, 'a fast machine carries nothing');
  // A reading that is older than PREFILL.maxAgeMs is not carried, and a carried one ages from when it was made.
  const old = new PrefillMeter({now, offload: true});
  clock += PREFILL.maxAgeMs + 1;
  assert.equal(old.carry(), null);
  assert.equal(new PrefillMeter({now, carry: {rate: 100, at: clock - PREFILL.maxAgeMs - 1}}).tokensPerSecond, null);
  // A measurement carries with the time it was made.
  const measured = new PrefillMeter({now});
  measured.observe({timings: {promptTokens: 3000, cachedTokens: 0, promptMs: 15000}});   // 200 a second
  const made = clock; clock += 5 * 60_000;
  assert.deepEqual(measured.carry(), {rate: 200, at: made});
  assert.equal(new PrefillMeter({now, carry: measured.carry()}).tokensPerSecond, 200);
});

test('PrefillMeter: learns the reading speed from the server\'s timings and from a request stuck on the prompt, and asks for a smaller prompt only on a slow machine', () => {
  let clock = 0;
  const meter = new PrefillMeter({now: () => clock});
  assert.equal(meter.tokensPerSecond, null); assert.equal(meter.soft(), null, 'nothing known: the context is the only limit');
  meter.observe({timings: {promptTokens: 100, cachedTokens: 4300, promptMs: 50}});
  assert.equal(meter.tokensPerSecond, null, 'a prompt with few new tokens says nothing about the speed');
  assert.equal(meter.cachedTokens, 4300);
  meter.observe({timings: {promptTokens: 3000, cachedTokens: 4300, promptMs: 1500}});   // 2,000 tokens a second
  assert.equal(meter.tokensPerSecond, 2000); assert.equal(meter.soft(), null, 'a fast machine is never held back');
  clock += 11 * 60_000;
  meter.observe({timings: {promptTokens: 3000, cachedTokens: 4300, promptMs: 15000}});  // 200 a second; the old measurement is no longer believed
  assert.equal(meter.tokensPerSecond, 200);
  const soft = meter.soft();
  const limit = Math.floor(soft.contextTokens - soft.reserveTokens - Math.max(BUDGET.minMargin, soft.contextTokens * BUDGET.marginRatio));
  assert.equal(limit, 4300 + 1300, 'the prompt less what the server holds is the 1,300 new tokens of the step');
  // The target moves in steps, so a speed that wobbles does not move the early part of the prompt every turn.
  const limitAt = rate => { const m = new PrefillMeter({now: () => clock}); m.observe({timings: {promptTokens: 3000, cachedTokens: 4300, promptMs: 3000 / rate * 1000}}); const s = m.soft(); return s && Math.floor(s.contextTokens - Math.max(BUDGET.minMargin, s.contextTokens * BUDGET.marginRatio)) - 4300; };
  assert.equal(limitAt(210), 1300); assert.equal(limitAt(230), 1800, 'a little faster: the next step, not a new cut on every turn');
  assert.equal(limitAt(5), 600, 'never below the floor');
  assert.equal(limitAt(600), 3500, 'at most the top step');
  // A request that was stuck on the prompt: what was read in the time the server had it. Never before it had it (a queue says nothing).
  const before = meter.tokensPerSecond;
  meter.observeFailure({headersMs: null, elapsedMs: 60000, progress: {processed: 0, total: 5000, cache: 0}});
  meter.observeFailure({headersMs: 1000, elapsedMs: 3000, progress: {processed: 0, total: 5000, cache: 0}});
  meter.observeFailure({headersMs: 1000, elapsedMs: 60000, progress: {processed: 5000, total: 5000, cache: 0}});
  assert.equal(meter.tokensPerSecond, before, 'no headers, a short wait, or a prompt that was read: nothing learned');
  meter.observeFailure({headersMs: 1000, elapsedMs: 61000, progress: {processed: 2802, total: 7592, cache: 2802}});   // not a single new token in a minute
  assert(meter.tokensPerSecond < before / 1.5 && meter.tokensPerSecond > 0);
  assert.equal(meter.cachedTokens, 2802);
  // A model with layers on the CPU is taken to be slow before anything is measured.
  const offloaded = new PrefillMeter({now: () => clock, offload: true});
  assert.equal(offloaded.tokensPerSecond, PREFILL.offloadPrior); assert.equal(offloaded.soft(), null, 'but with nothing cached yet there is nothing to size it against');
  offloaded.observe({timings: {promptTokens: 0, cachedTokens: 2000, promptMs: 0}});
  assert(offloaded.soft(), 'once the server holds a prefix the prompt is sized');
  const cold = new PrefillMeter({now: () => clock, offload: true});
  assert(cold.soft(4000), 'or when the persona that has to be read first is known');
  assert.equal(cold.soft(0), null);
  assert.equal(cold.slow, true); assert.equal(new PrefillMeter({now: () => clock}).slow, false);
});

test('budgetedChat: on a machine seen to read slowly the prompt is cut below the context first; one that cannot reach that is still sent; a fast one is not held back', async () => {
  const args = turn();
  const full = estimateTokens(buildMessages(args));
  const run = async cached => {
    const speed = new PrefillMeter();
    speed.observe({timings: {promptTokens: 3000, cachedTokens: cached, promptMs: 15000}});   // 200 tokens a second
    const sent = [], fits = [];
    const chat = budgetedChat(async options => { sent.push(estimateTokens(options.messages)); return {text: 'ok', trace: {timings: {promptTokens: 900, cachedTokens: cached, promptMs: 4500}}}; },
      {budget: async () => ({contextTokens: 16384, meter: new TokenMeter(), speed}), onFit: fit => fits.push(fit)});
    await chat({messages: buildMessages(args), provider: 'local'});
    return {sent: sent[0], fits, speed};
  };
  const slow = await run(4300);
  assert(full > 9000 && slow.sent < full - 2500, `cut from ${full} to ${slow.sent}`);
  assert(slow.sent <= 4300 + 1300 + BUDGET.minMargin, 'to what the machine reads in a few seconds, on top of what the server holds');
  assert.equal(slow.fits[0].target, 'soft');
  assert(slow.fits[0].trimmed.length > 0 && slow.fits[0].fits);
  // The request that came back is measured too: 900 new tokens in 4.5 s is 200 a second again.
  assert.equal(Math.round(slow.speed.tokensPerSecond), 200);
  // The server holds nothing of this persona (a new character, a model loaded again): the persona has to be read whatever the target is, so the allowance
  // is added to the persona's own size and everything else is cut to it.
  const head = estimateTokens([{role: 'system', content: systemHead({persona: judy})}]);
  const cold = await run(0);
  assert(cold.sent < full - 2500 && cold.sent <= head + 1300 + BUDGET.minMargin, `cold: from ${full} to ${cold.sent}, persona ${head}`);
  // What cannot be cut (the format notes, the right-now block, V's words) is more than the allowance: the soft target cannot be reached even with everything optional
  // cut. The next step up that holds what is left is used (2026-10-20 live record: a prompt that missed the target by 36 tokens was sent whole, 5,300 tokens for 3,300).
  const heavy = turn(); heavy.contextParts.notes = 'FORMAT: ' + 'use a tag for a feeling, never read it aloud. '.repeat(65); heavy.text = 'Tell me everything. '.repeat(60);
  const wide = estimateTokens(buildMessages(heavy));
  const speed = new PrefillMeter(); speed.observe({timings: {promptTokens: 3000, cachedTokens: 4300, promptMs: 600_000}});   // 5 tokens a second: the lowest step, 600
  const sent = [], fits = [];
  await budgetedChat(async options => { sent.push(estimateTokens(options.messages)); return {text: 'ok'}; }, {budget: async () => ({contextTokens: 16384, meter: new TokenMeter(), speed}), onFit: fit => fits.push(fit)})({messages: buildMessages(heavy), provider: 'local'});
  assert.equal(fits.length, 1, 'cut under the raised target');
  assert.equal(fits[0].target, 'soft'); assert.equal(fits[0].raised, true); assert.equal(fits[0].fits, true);
  assert.match(describeFit(fits[0]), /\(raised soft target\)/);
  assert(sent[0] < wide - 1500 && sent[0] <= 4300 + 3500 + BUDGET.minMargin, `cut from ${wide} to ${sent[0]}`);
  assert(sent[0] > 4300 + PREFILL.steps[0], 'to a larger step than the lowest, which it could not reach');
  // A fast machine: the context is the only limit.
  const fast = new PrefillMeter(); fast.observe({timings: {promptTokens: 3000, cachedTokens: 4300, promptMs: 1000}});
  const quick = [];
  await budgetedChat(async options => { quick.push(estimateTokens(options.messages)); return {text: 'ok'}; }, {budget: async () => ({contextTokens: 16384, meter: new TokenMeter(), speed: fast})})({messages: buildMessages(args), provider: 'local'});
  assert.equal(quick[0], full);
});

test('budgetedChat: a request that stalls on the prompt teaches the next turn how slow the machine is', async () => {
  const args = turn();
  const speed = new PrefillMeter();
  speed.observe({timings: {promptTokens: 3000, cachedTokens: 4300, promptMs: 6000}});   // 500 a second: a little under fast
  const chat = budgetedChat(async () => {
    throw Object.assign(new MistralError('network', 'did not finish in time', {provider: 'local', slow: true, reason: 'prefill-stalled'}),
      {trace: {headersMs: 500, elapsedMs: 60500, progress: {processed: 4300, total: 9000, cache: 4300}}});
  }, {budget: async () => ({contextTokens: 16384, meter: new TokenMeter(), speed})});
  await assert.rejects(chat({messages: buildMessages(args), provider: 'local'}), /did not finish in time/);
  assert(speed.tokensPerSecond < 300, `now believed slow: ${speed.tokensPerSecond}`);
});

// 2026-10-20 live record (0.2.4, a Mature model on an 8192-token server): the soft target of a slow machine is the persona plus the allowance, which can be larger
// than the context. It let a prompt of 8919 tokens through, the server refused it, and the retry was fitted to the same soft target and refused again.
// A prompt of 3.4 characters a token (a denser one than the usual 4.2): the whole turn is about 9,500 tokens, over an 8192-token context.
const DENSE = 3.4;
const roomy = () => {
  const server = 8192, sent = [];
  const refusing = async options => {
    const tokens = Math.ceil(chars(options.messages) / DENSE) + templateTokens(options.messages.length);
    sent.push(tokens);
    if (tokens > server) throw Object.assign(new MistralError('request', 'exceeds the available context size', {provider: 'local'}), {overflow: {promptTokens: tokens, contextTokens: server}});
    return {text: 'ok', usage: {prompt_tokens: tokens}};
  };
  return {sent, chat: budgetedChat(refusing, {budget: async () => ({contextTokens: server, meter: new TokenMeter({charsPerToken: DENSE}), soft: {contextTokens: 9400, reserveTokens: 0}})})};
};

test('budgetedChat: a soft target that is not below the context is not used, so the prompt fits the context on the first request', async () => {
  const {sent, chat} = roomy();
  assert.equal((await chat({messages: buildMessages(turn()), provider: 'local'})).text, 'ok');
  assert.equal(sent.length, 1, 'no refusal, no retry');
  assert(sent[0] <= fitLimit({contextTokens: 8192}), `sent ${sent[0]} of ${fitLimit({contextTokens: 8192})}`);
});

test('budgetedChat: an estimate that is too low is refused once and the retry is cut to what the server counted, soft target or not', async () => {
  const sent = [];
  const chat = budgetedChat(async options => {
    const tokens = Math.ceil(chars(options.messages) / DENSE) + templateTokens(options.messages.length);
    sent.push(tokens);
    if (tokens > 8192) throw Object.assign(new MistralError('request', 'exceeds the available context size', {provider: 'local'}), {overflow: {promptTokens: tokens, contextTokens: 8192}});
    return {text: 'ok', usage: {prompt_tokens: tokens}};
  }, {budget: async () => ({contextTokens: 8192, meter: new TokenMeter({charsPerToken: 6}), soft: {contextTokens: 9400, reserveTokens: 0}})});
  assert.equal((await chat({messages: buildMessages(turn()), provider: 'local'})).text, 'ok');
  assert.equal(sent.length, 2, 'one refusal, one retry');
  assert(sent[0] > 8192 && sent[1] <= 8192 - BUDGET.reserveTokens, `first ${sent[0]}, retry ${sent[1]}`);
});

test('fitLimit: the context less the room for the reply and the margin', () => {
  assert.equal(fitLimit({contextTokens: 8192}), 8192 - BUDGET.reserveTokens - Math.max(BUDGET.minMargin, 8192 * BUDGET.marginRatio) | 0);
  assert(fitLimit({contextTokens: 9400, reserveTokens: 0}) > fitLimit({contextTokens: 8192}));
});

// ---- Older exchanges go in blocks: the history starts at the same exchange for several turns --------------------------------------------------------------

// The exchanges of a conversation, numbered from `first` (a different number in each, so a shifted start shows in the messages).
const numbered = (count, first = 0) => Array.from({length: count}, (_, index) => ({v: `Tell me about job number ${first + index} and what happened that night at the Clouds.`,
  r: `It was a long night, V, number ${first + index}. Braindance work is mostly waiting, then everything happens at once and you wish it had not.`}));
const kept = fit => fit.messages.slice(1, -1);   // the exchanges of the history that were sent

test('older exchanges: a conversation at the limit keeps the same first exchange for several turns, so the history is not read again every turn', async () => {
  const budget = () => ({contextTokens: 6640, meter: new TokenMeter()});   // a limit the prompt sits just over: the history is cut in blocks (6,640 since the knowledge section got a heading of its own)
  const fits = [];
  for (const size of [9, 10, 11]) {   // the memory store keeps the start of its window for a few turns while it grows by one exchange a turn
    fits.push(await fitMessages({args: turn({history: numbered(size), text: 'What next? ' + size}), budget: budget()}));
  }
  for (const fit of fits) assert(fit.fits && fit.trimmed.includes('older-exchanges'), 'the history is being cut: ' + fit.trimmed.join(','));
  // The system message (persona, rules, world blocks) is the same on all three turns.
  assert.equal(fits[1].messages[0].content, fits[0].messages[0].content);
  assert.equal(fits[2].messages[0].content, fits[0].messages[0].content);
  // The history of each turn starts with the exchange the turn before started with, and everything after it is the same exchanges plus the new ones: a byte-identical prefix.
  for (const [before, after] of [[0, 1], [1, 2]]) {
    const old = kept(fits[before]), now = kept(fits[after]);
    assert.deepEqual(now.slice(0, old.length), old, `turn ${after} repeats the history of turn ${before} and only appends`);
    assert(now.length >= old.length, 'the history only grew');
  }
});

test('older exchanges: they go in whole blocks of BUDGET.trimBlock (never below keepExchanges), the prompt only gets shorter, and a prompt that fits is not cut', async () => {
  const budget = () => ({contextTokens: 6640, meter: new TokenMeter()});   // a limit the prompt sits just over: the history is cut in blocks (6,640 since the knowledge section got a heading of its own)
  const base = await fitMessages({args: turn({history: numbered(8)}), budget: budget()});
  const dropped = 8 - kept(base).length / 2;
  assert.equal(dropped % BUDGET.trimBlock, 0, 'a whole block was dropped (' + dropped + ')');
  assert(kept(base).length / 2 >= BUDGET.keepExchanges);
  assert(base.trimmed.includes('older-exchanges'));
  assert(base.tokens <= base.limit);
  // The first exchange kept is always one of the conversation's own: a block is cut from the start, the end stays.
  assert.equal(kept(base).at(-1).content, numbered(8).at(-1).r);
  // Room to spare: nothing of the history is cut.
  const roomy = await fitMessages({args: turn({history: numbered(8)}), budget: {contextTokens: 24000, meter: new TokenMeter()}});
  assert.deepEqual(roomy.trimmed, []);
  assert.equal(kept(roomy).length, 16);
});

// ---- the room a freshly loaded model is given to answer (2026-10-21: a 5,015-token cold prompt on a model with about 0% of its layers on the card was stuck at 0 when 15 s ran out) ----

test('coldAttemptRoomMs: the base room for a model on the card; the time the cold prompt takes for one with layers on the CPU, capped', () => {
  const base = 15_000;
  assert.equal(coldAttemptRoomMs({baseMs: base}), base);
  assert.equal(coldAttemptRoomMs({baseMs: base, offload: false, cpuBound: true}), base, 'a model on the card is not stretched');
  // Expected rate (PREFILL.offloadPrior = 120 a second): 5,000 tokens take 41.7 s, and the first word 5 s after.
  const expected = Math.round(COLD_PROMPT.tokens / PREFILL.offloadPrior * 1000 + COLD_PROMPT.answerMs);
  assert.equal(coldAttemptRoomMs({baseMs: base, offload: true}), expected);
  assert.ok(expected > 40_000 && expected <= COLD_PROMPT.maxRoomMs);
  // So few layers on the card that the compact text is used from the start: a smaller prompt, a shorter wait.
  const compact = coldAttemptRoomMs({baseMs: base, offload: true, cpuBound: true});
  assert.equal(compact, Math.round(COLD_PROMPT.compactTokens / PREFILL.offloadPrior * 1000 + COLD_PROMPT.answerMs));
  assert.ok(compact < expected);
  // A reading of the last load, believed only when that load was on the CPU too.
  let clock = 0;
  const measured = new PrefillMeter({now: () => clock, offload: true});
  measured.observe({timings: {promptTokens: 3000, cachedTokens: 0, promptMs: 10_000}});   // 300 a second
  assert.equal(coldAttemptRoomMs({baseMs: base, offload: true, speed: measured}), Math.round(COLD_PROMPT.tokens / 300 * 1000 + COLD_PROMPT.answerMs));
  const onCard = new PrefillMeter({now: () => clock});
  onCard.observe({timings: {promptTokens: 3000, cachedTokens: 0, promptMs: 600}});          // 5,000 a second, on the card
  assert.equal(coldAttemptRoomMs({baseMs: base, offload: true, speed: onCard}), expected, 'the reading of a model that was on the card says nothing about this one');
  // A very slow reading is capped; and the room never drops below the base.
  const crawl = new PrefillMeter({now: () => clock, offload: true});
  crawl.observe({timings: {promptTokens: 600, cachedTokens: 0, promptMs: 20_000}});           // 30 a second
  assert.equal(coldAttemptRoomMs({baseMs: base, offload: true, speed: crawl}), COLD_PROMPT.maxRoomMs);
  const quick = new PrefillMeter({now: () => clock, offload: true});
  quick.observe({timings: {promptTokens: 6000, cachedTokens: 0, promptMs: 1000}});            // 6,000 a second
  assert.equal(coldAttemptRoomMs({baseMs: base, offload: true, speed: quick}), Math.round(COLD_PROMPT.tokens / 6000 * 1000 + COLD_PROMPT.answerMs) < base ? base : Math.round(COLD_PROMPT.tokens / 6000 * 1000 + COLD_PROMPT.answerMs));
});
