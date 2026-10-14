import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PersonaBook, buildMessages, systemHead, LIMITS, PROMPT_SOURCE} from './mistral-prompt.mjs';
import {budgetedChat, TokenMeter, estimateTokens} from './prompt-budget.mjs';
import {groqRoute} from './text-provider-host.mjs';
import {compactBackstory, compactPersona, compactForGroq, groqCompactEnabled, GROQ_COMPACT, GROQ_SOFT_TOKENS} from './groq-prompt.mjs';
import {buildPrompt, messagesFor, sizeOf, HISTORY, MEMORY, REMEMBERED, USER_LINES} from '../scripts/judy-prompt-fixture.mjs';

const prompt = buildPrompt();
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const judyArgs = (text = USER_LINES.a) => ({persona: prompt.persona, memory: MEMORY, history: HISTORY, contextParts: prompt.contextParts, remembered: REMEMBERED, text, limits: LIMITS});

// ---- Other providers are untouched -----------------------------------------------------------------------------------------

test('the prompt Mistral and the local AI build is byte for byte what it was before the Groq shaping existed (hashes taken from the commit before)', () => {
  // Computed with `buildMessages` as of 1e207eec (no `compact` anywhere): Judy's seven fixture lines, a reaction, layout v1 and the Mature layer.
  const expected = {
    a: 'dfcfeab1fec464b5316f6efb316946a027c039fd2e6ec4bcf4d33638d42ce2d0',
    b: 'a912695e138ff5fabe8e639bfe3825be8889156a30ab8b81288a9292e4768991',
    c: 'bc1098dd6c8044754fd2f9d726e33f2c1d8b14436fe77663c7717d5ba3e7b76f',
    d: 'c1801a86fec1f712f12a70f4098a54a40c86819f9dca1043596368165b452a09',
    e: '03a2bc9ef545f2ef8c79a658db7eeb05d655e531f5140a9107811f130f8cfa55',
    f: '28f1c5aa27e01a607399dcb41800e12aa5d99f52f1e78f5098e8a9be60693e24',
    g: '56a4ceeed5e1b9b8b0c1f08afa882a35815926c830b1612a0c739f9eb874773b',
  };
  for (const [key, hash] of Object.entries(expected)) assert.equal(sha(messagesFor(prompt, key)), hash, `line ${key}`);
  assert.equal(sha(buildMessages({...judyArgs('a loot event'), reaction: true})), '0274b2509da908de11ef1dedcd18619945318e1909b5563dc6cbe5137408a1db');
  assert.equal(sha(buildMessages({persona: prompt.persona, memory: MEMORY, history: HISTORY, context: 'ctx', text: 'hi', limits: LIMITS})),
    '8b2cb8a311679107cb24f0bfd5d7720d921f0bf68bde35fc8518c24f7b43f25c');
  assert.equal(sha(buildMessages({...judyArgs('hi'), mature: 'full'})), '16d4857675c9704e66af56f87aaa6fd40d1be73f1906ea73bbe84eff6df01ea6');
  assert.equal(sha(systemHead({persona: prompt.persona})), 'ef55ba10f2f959c81b1bfd4a665108e60787c0ffb0f2a92835a84263fd4e99c6');
});

test('shaping never changes its input: the persona, the history and the limits of the caller stay as they were', () => {
  const args = judyArgs();
  const before = JSON.stringify(args);
  const shaped = compactForGroq(args);
  assert.notEqual(shaped, args);
  assert.equal(JSON.stringify(args), before);
  assert.notEqual(shaped.persona, args.persona);
  assert.equal(args.limits.turns, LIMITS.turns);
});

// ---- The shaping -----------------------------------------------------------------------------------------------------------

test('compactBackstory: Scope lines go, the topic material is cut to its first paragraphs, every other section and the appearance stay', () => {
  const full = prompt.persona.backstory;
  assert.match(full, /^Scope:/m);
  const compact = compactBackstory(full);
  assert.doesNotMatch(compact, /^Scope:/m);
  assert(compact.length < full.length * 0.7, `${compact.length} of ${full.length}`);
  for (const section of ['ESTABLISHED BACKGROUND', 'ESTABLISHED RELATIONSHIPS', 'PUBLIC INTRINSIC TOPIC MATERIAL', 'KNOWLEDGE AND CURRENT SAVE', 'KNOWLEDGE LIMITS', 'Your appearance:'])
    assert(compact.includes(section), section);
  // The first paragraph of the topic material (its disclaimer and the first item) is always kept; the last items of the full text are not.
  assert(compact.includes('Judy is an exceptionally gifted braindance editor'));
  assert(!compact.includes('sneaked into the empty church'));
  const topic = /PUBLIC INTRINSIC TOPIC MATERIAL[\s\S]*?(?=\nKNOWLEDGE AND CURRENT SAVE)/.exec(compact)[0];
  assert(topic.length <= GROQ_COMPACT.topicChars + 100, `topic ${topic.length}`);
  // Deterministic: the same text gives the same text (the prompt's early part is identical turn after turn).
  assert.equal(compactBackstory(full), compact);
});

test('compactBackstory: a backstory with no Scope lines, or none of the topic header, is not rewritten', () => {
  assert.equal(compactBackstory('You are an ordinary person.\n\nKNOWLEDGE LIMITS\nNothing.'), 'You are an ordinary person.\n\nKNOWLEDGE LIMITS\nNothing.');
  assert.equal(compactBackstory(''), '');
  const noHeader = 'WHO\nA person.\nScope: not a claim.\n\nOther\nFact.';
  assert.equal(compactBackstory(noHeader), 'WHO\nA person.\n\nOther\nFact.');
  const short = 'PUBLIC INTRINSIC TOPIC MATERIAL\nIntro.\nA fact.\nScope: a limit.\n\nAnother fact.\n\nKNOWLEDGE LIMITS\nNone.';
  assert.equal(compactBackstory(short), 'PUBLIC INTRINSIC TOPIC MATERIAL\nIntro.\nA fact.\n\nAnother fact.\n\nKNOWLEDGE LIMITS\nNone.');
});

test('compactPersona: six example lines, the same object when nothing is cut, the repeat guard still sees the original lines', () => {
  const persona = compactPersona(prompt.persona);
  assert.equal(persona.samples.length, GROQ_COMPACT.samples);
  assert.deepEqual(persona.samples, prompt.persona.samples.slice(0, GROQ_COMPACT.samples));
  assert.equal(prompt.persona.samples.length, 16);
  const small = {name: 'X', backstory: 'plain', samples: ['a', 'b'], style: ''};
  assert.equal(compactPersona(small), small);
  assert.equal(compactPersona(null), null);
  assert.equal(persona.name, prompt.persona.name);
  assert.equal(persona.style, prompt.persona.style);
});

test('compactForGroq: four exchanges, shorter lines, tighter summary and memory limits; a request with no source arguments is not shaped', () => {
  const longHistory = Array.from({length: 8}, (_, index) => ({v: `question ${index} ` + 'x'.repeat(350), r: `answer ${index} ` + 'y'.repeat(500)}));
  const shaped = compactForGroq({...judyArgs(), history: longHistory});
  assert.equal(shaped.history.length, 4);
  assert.equal(shaped.history[0].v.startsWith('question 4'), true);
  assert.deepEqual({turns: shaped.limits.turns, userLine: shaped.limits.userLine, replyLine: shaped.limits.replyLine, summary: shaped.limits.summary, remembered: shaped.limits.remembered},
    {turns: 4, userLine: 300, replyLine: 420, summary: 900, remembered: 700});
  assert.equal(compactForGroq(undefined), undefined);
  assert.deepEqual(compactForGroq(null), null);
  const args = judyArgs();
  assert.equal(compactForGroq(args, {off: true}), args);
  // A limit that is already tighter is kept.
  assert.equal(compactForGroq({...judyArgs(), limits: {...LIMITS, turns: 2}}).limits.turns, 2);
});

test('the shaped prompt keeps the persona core, the rules, the notes, the right-now block and the player words', () => {
  const full = messagesFor(prompt, 'a');
  const shaped = buildMessages(compactForGroq(judyArgs()));
  assert(sizeOf(shaped) < sizeOf(full) * 0.9, `${sizeOf(shaped)} of ${sizeOf(full)}`);
  const system = shaped[0].content;
  for (const text of ['You are Judy Alvarez', 'HOW YOU TALK', 'OUTPUT RULES (they outrank everything above about format)', '9. Answer in the language V writes in',
    'FORMAT NOTES FOR EVERY REPLY', 'WORLD AND QUEST CONTEXT', 'RIGHT NOW (from the game', 'KNOWLEDGE LIMITS', 'Your appearance:']) assert(system.includes(text), text);
  const last = shaped.at(-1).content;
  assert(last.includes(`V says: ${USER_LINES.a}`));
  assert(last.includes('(Reply as Judy Alvarez, out loud'));
  assert(last.includes('[YOU, RIGHT NOW:'));
  // The rules block is the very same text.
  const rules = text => text.slice(text.indexOf('OUTPUT RULES'), text.indexOf('FORMAT NOTES FOR EVERY REPLY'));
  assert.equal(rules(system), rules(full[0].content));
});

test('the shipped roster: every character loses its Scope lines and keeps every section header, its appearance and the rest of its persona', async () => {
  const {readFile} = await import('node:fs/promises');
  const roster = JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8'));
  const book = new PersonaBook(roster);
  let cut = 0, before = 0, after = 0;
  for (const row of roster) {
    const persona = book.persona(row.key);
    const compact = compactPersona(persona);
    assert.doesNotMatch(compact.backstory, /^Scope:/m, row.key);
    for (const header of persona.backstory.match(/^[A-Z][A-Z ,'()-]{5,}$/gm) ?? []) assert(compact.backstory.includes(header) || header === 'PUBLIC INTRINSIC TOPIC MATERIAL', `${row.key}: ${header}`);
    if (persona.backstory.includes('Your appearance:')) assert(compact.backstory.includes('Your appearance:'), row.key);
    assert.deepEqual({...compact, backstory: 0, samples: 0}, {...persona, backstory: 0, samples: 0}, row.key);
    before += persona.backstory.length; after += compact.backstory.length;
    if (compact !== persona) cut++;
  }
  assert(cut >= 70, `${cut} of ${roster.length} personas changed`);
  assert(after < before * 0.85, `${after} of ${before} characters`);
});

// ---- Through the Groq route ------------------------------------------------------------------------------------------------

function groqSeen({compact, args = judyArgs()} = {}) {
  const sent = [];
  const route = groqRoute({provider: {}, chat: async options => { sent.push(options); return {text: 'ok'}; }, log: () => {}, compact});
  const messages = buildMessages(args);
  return route.chat({messages, provider: 'groq'}).then(() => ({sent, messages}));
}

test('the Groq route sends the shaped prompt and never the persona text it cut; switched off it sends what the budget alone would', async () => {
  const on = await groqSeen({compact: true});
  assert.equal(on.sent.length, 1);
  assert(sizeOf(on.sent[0].messages) < sizeOf(on.messages) * 0.9);
  assert(!on.sent[0].messages.some(message => /^Scope:/m.test(message.content)));
  const off = await groqSeen({compact: false});
  assert(off.sent[0].messages.some(message => /^Scope:/m.test(message.content)), 'the old behaviour keeps the Scope lines');
});

test('the Groq route fits one request into the plan limit with the shaping on and off, and a prompt that fits is not trimmed more than the plan needs', async () => {
  for (const compact of [true, false]) {
    const {sent} = await groqSeen({compact});
    assert(estimateTokens(sent[0].messages) <= 8000 - 256, `compact ${compact}: ${estimateTokens(sent[0].messages)}`);
  }
  // With the shaping Judy's whole prompt (memories, history, summary, notes) fits the hard limit as it is; before it, those were cut to make room.
  const on = await groqSeen({compact: true}), off = await groqSeen({compact: false});
  const count = (seen, text) => seen.sent[0].messages.filter(message => message.content.includes(text)).length;
  assert.equal(count(on, 'THINGS YOU REMEMBER ABOUT V'), 1);
  assert.equal(count(off, 'THINGS YOU REMEMBER ABOUT V'), 0, 'before: the remembered facts were the first cut');
  assert(on.sent[0].messages.length > off.sent[0].messages.length, 'more of the conversation is kept');
});

test('a smaller character reaches the soft target (two turns a minute); the cuts follow the budget order and keep the persona', async () => {
  const roster = [{key: 'small-person', name: 'Sam', kind: 'named', backstory: 'Sam sells noodles in Kabuki. '.repeat(40), speakingStyleDescription: 'Plain and dry.',
    speakingStyleSampleDialogues: 'Line one.\n\nLine two.'}];
  const persona = new PersonaBook(roster).persona('small-person');
  const bigWorld = Array.from({length: 120}, (_, index) => `- A world fact number ${index}: something about the city that the character may know of.`).join('\n');
  const args = {...judyArgs(), persona, contextParts: {...prompt.contextParts, world: bigWorld, notes: ''}};
  const logs = [];
  const sent = [];
  const route = groqRoute({provider: {}, chat: async options => { sent.push(options.messages); return {text: 'ok'}; }, log: line => logs.push(line), compact: true});
  await route.chat({messages: buildMessages(args), provider: 'groq'});
  assert(estimateTokens(sent[0]) <= GROQ_SOFT_TOKENS - 256, `${estimateTokens(sent[0])} of ${GROQ_SOFT_TOKENS}`);
  assert(sent[0][0].content.includes('You are Sam'));
  assert(sent[0].at(-1).content.includes('V says: ' + USER_LINES.a));
  // The same request with the shaping off is only fitted to the plan's hard limit and keeps all of its world block.
  const plain = [];
  await groqRoute({provider: {}, chat: async options => { plain.push(options.messages); return {text: 'ok'}; }, log: () => {}, compact: false}).chat({messages: buildMessages(args), provider: 'groq'});
  assert(sizeOf(plain[0]) > sizeOf(sent[0]));
});

test('with a Mistral key the second turn has somewhere to go, so no optional context is cut for the soft target (the shaping still applies)', async () => {
  const roster = [{key: 'small-person', name: 'Sam', kind: 'named', backstory: 'Sam sells noodles in Kabuki. '.repeat(40), speakingStyleDescription: 'Plain and dry.',
    speakingStyleSampleDialogues: 'Line one.\n\nLine two.'}];
  const persona = new PersonaBook(roster).persona('small-person');
  const bigWorld = Array.from({length: 120}, (_, index) => `- A world fact number ${index}: something about the city that the character may know of.`).join('\n');
  const args = {...judyArgs(), persona, contextParts: {...prompt.contextParts, world: bigWorld, notes: ''}};
  const sizes = {};
  for (const [name, provider] of [['groq only', {}], ['with mistral', {apiKey: 'a-mistral-key'}]]) {
    const sent = [];
    await groqRoute({provider, chat: async options => { sent.push(options.messages); return {text: 'ok'}; }, log: () => {}, compact: true}).chat({messages: buildMessages(args), provider: 'groq'});
    sizes[name] = sizeOf(sent[0]);
    assert(estimateTokens(sent[0]) <= 8000 - 256, name);
  }
  assert(sizes['with mistral'] > sizes['groq only'], JSON.stringify(sizes));
  // The history is still shortened to four exchanges by the shaping.
  const sent = [];
  const eight = Array.from({length: 8}, (_, index) => ({v: `q${index}`, r: `a${index}`}));
  await groqRoute({provider: {apiKey: 'k'}, chat: async options => { sent.push(options.messages); return {text: 'ok'}; }, log: () => {}, compact: true})
    .chat({messages: buildMessages({...judyArgs(), history: eight}), provider: 'groq'});
  assert.equal(sent[0].filter(message => message.role === 'assistant').length, 4);
});

test('a request that was not built by buildMessages (a summary, the action decision) goes through the Groq route unshaped', async () => {
  const sent = [];
  const route = groqRoute({provider: {}, chat: async options => { sent.push(options.messages); return {text: 'ok'}; }, log: () => {}, compact: true});
  const messages = [{role: 'system', content: 'Summarize.'}, {role: 'user', content: 'Scope: this stays\nhello'}];
  await route.chat({messages, provider: 'groq'});
  assert.equal(sent[0], messages);
});

// ---- The budget's new options ----------------------------------------------------------------------------------------------

test('budgetedChat: a soft target is tried first and a prompt that cannot reach it is fitted to the hard limit, never refused for the soft one', async () => {
  const sent = [];
  const chat = async options => { sent.push(options.messages); return {text: 'ok'}; };
  const hard = 8000;
  // A target no prompt can reach (the rules and notes alone are above it): the hard fit decides, and the request goes out.
  const fit = budgetedChat(chat, {budget: () => ({contextTokens: hard, reserveTokens: 256, meter: new TokenMeter(), soft: {contextTokens: 900, reserveTokens: 256}})});
  await fit({messages: buildMessages(judyArgs()), provider: 'groq'});
  assert.equal(sent.length, 1);
  assert(estimateTokens(sent[0]) <= hard);
  // A target the prompt can reach: it is used.
  const tight = [];
  const reachable = budgetedChat(async options => { tight.push(options.messages); return {text: 'ok'}; },
    {budget: () => ({contextTokens: hard, reserveTokens: 256, meter: new TokenMeter(), soft: {contextTokens: 7000, reserveTokens: 256}})});
  await reachable({messages: buildMessages(judyArgs()), provider: 'groq'});
  assert(estimateTokens(tight[0]) <= 7000 - 256);
});

test('budgetedChat: `shape` receives the source arguments and the options and its result is what is built; without one nothing changes', async () => {
  const seen = [];
  const sent = [];
  const chat = async options => { sent.push(options.messages); return {text: 'ok'}; };
  const messages = buildMessages(judyArgs());
  const shaped = budgetedChat(chat, {budget: () => ({contextTokens: 20000}), shape: (args, options) => { seen.push([args, options.provider]); return {...args, history: []}; }});
  await shaped({messages, provider: 'groq'});
  assert.equal(seen[0][0], messages[PROMPT_SOURCE]);
  assert.equal(seen[0][1], 'groq');
  assert(sent[0].length < messages.length, 'the history the shape removed is gone');
  const plain = budgetedChat(chat, {budget: () => ({contextTokens: 20000})});
  await plain({messages, provider: 'local'});
  assert.equal(sha(sent[1]), sha(messages), 'no shape, no soft target: the very same prompt');
});

test('the kill switch: CYBERPUNK_CONVAI_GROQ_COMPACT=0 (or off, false, no) turns the shaping off; anything else leaves it on', () => {
  assert.equal(groqCompactEnabled({}), true);
  for (const value of ['0', 'off', 'OFF', 'false', 'no', ' 0 ']) assert.equal(groqCompactEnabled({CYBERPUNK_CONVAI_GROQ_COMPACT: value}), false, value);
  for (const value of ['1', 'on', '', 'yes']) assert.equal(groqCompactEnabled({CYBERPUNK_CONVAI_GROQ_COMPACT: value}), true, value);
});
