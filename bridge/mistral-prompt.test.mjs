import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {closing, PersonaBook, systemPrompt, buildMessages, capContext, cleanReply, capReply, capPoint, breaksCharacter, summaryMessages, LIMITS,
  CONTEXT_PREFIX} from './mistral-prompt.mjs';
import {hasEmotionTag} from './emotion-tags.mjs';

const named = JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8'));
const archetypes = JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'));
const book = new PersonaBook([...named, ...archetypes]);
const isTag = hasEmotionTag;

test('a named persona carries the backstory with the appearance, the speaking style and the example lines, without the build marker', () => {
  const persona = book.persona('judy-alvarez');
  assert.equal(persona.name, 'Judy Alvarez');
  assert.equal(persona.ambient, false);
  const prompt = systemPrompt({persona});
  assert.match(prompt, /^You are Judy Alvarez/);
  assert.match(prompt, /Your appearance:\nYou have green and pink hair/);
  assert.match(prompt, /HOW YOU TALK\nEditorial delivery/);
  assert.match(prompt, /EXAMPLES OF YOUR VOICE/);
  assert.match(prompt, /- Sure\. The hard part isn't making somebody feel something\./);
  assert.doesNotMatch(prompt, /CyberpunkConvai profile/);
  assert.match(prompt, /OUTPUT RULES/);
  assert.match(prompt, /first person/);
  assert.match(prompt, /AI, a language model/);
});

test('every roster character builds a prompt inside the cap, and an unnamed NPC is not given a name', () => {
  for (const row of [...named, ...archetypes]) {
    const prompt = systemPrompt({persona: book.persona(row.key)});
    assert(prompt.length < LIMITS.persona + 4000, `${row.key}: ${prompt.length}`);
  }
  const vendor = book.persona('npc-food-vendor-male');
  assert.equal(vendor.name, '');
  assert.equal(vendor.ambient, true);
  const prompt = systemPrompt({persona: vendor});
  assert.match(prompt, /^You are an ordinary person in Cyberpunk 2077's Night City/);
  assert.match(prompt, /unnamed food and drink vendor/);
  assert.doesNotMatch(prompt, /Food Vendor Male/);
  const unknown = book.persona('npc-not-in-the-roster', 'Somebody');
  assert.equal(unknown.known, false);
  assert.match(systemPrompt({persona: unknown}), /ordinary person/);
});

test('an over-long persona drops the examples first, then the end of the backstory', () => {
  const persona = {name: 'Big', ambient: false, backstory: 'B'.repeat(30000), style: 'style', samples: ['one', 'two']};
  const limits = {...LIMITS, persona: 9000};
  const prompt = systemPrompt({persona, limits});
  assert(prompt.length <= 9000 + 2000 + 1500, String(prompt.length));
  assert.doesNotMatch(prompt, /EXAMPLES OF YOUR VOICE/);
  assert.match(prompt, /OUTPUT RULES/);
  const small = systemPrompt({persona: {...persona, backstory: 'short'}, limits});
  assert.match(small, /EXAMPLES OF YOUR VOICE/);
});

test('memory goes into the system message, trimmed to its cap', () => {
  const persona = book.persona('panam-palmer');
  const prompt = systemPrompt({persona, memory: 'x'.repeat(5000)});
  const section = prompt.split('WHAT YOU REMEMBER OF V FROM EARLIER TALKS')[1].split('OUTPUT RULES')[0];
  assert(section.length < LIMITS.summary + 120, String(section.length));
  assert.doesNotMatch(systemPrompt({persona}), /WHAT YOU REMEMBER/);
});

test('messages: system, then the recent history, then one user message with the live context and V\'s words', () => {
  const persona = book.persona('johnny-silverhand');
  const history = Array.from({length: 12}, (_, index) => ({v: `question ${index}`, r: `answer ${index}`}));
  const messages = buildMessages({persona, memory: '', history, context: 'CURRENT PERSON\nQuest facts here.\n\nFirst-person reminder.', text: 'Where are we going?'});
  assert.equal(messages[0].role, 'system');
  assert.equal(messages.length, 1 + LIMITS.turns * 2 + 1);
  assert.deepEqual(messages.slice(1, 3).map(m => m.content), ['question 4', 'answer 4']);
  assert.deepEqual(messages.slice(1, -1).map(m => m.role), Array.from({length: LIMITS.turns * 2}, (_, i) => i % 2 ? 'assistant' : 'user'));
  const last = messages.at(-1);
  assert.equal(last.role, 'user');
  assert(last.content.startsWith('[LIVE CONTEXT'));
  assert(last.content.includes(CONTEXT_PREFIX));
  assert(last.content.includes('V says: Where are we going?'));
  assert(last.content.endsWith(closing('Johnny Silverhand')), 'the closing reminder is the last thing the model reads');
  // The context is passed on unchanged (it is the same text Convai gets).
  assert(last.content.includes('CURRENT PERSON\nQuest facts here.\n\nFirst-person reminder.'));
});

test('history lines and V\'s message are length-capped; a reaction is an event, not something V said', () => {
  const persona = book.persona('judy-alvarez');
  const messages = buildMessages({persona, history: [{v: 'v'.repeat(2000), r: 'r'.repeat(2000)}, {v: '', r: 'ignored'}], context: 'c', text: 't'.repeat(5000)});
  assert.equal(messages.length, 4);
  assert(messages[1].content.length <= LIMITS.userLine);
  assert(messages[2].content.length <= LIMITS.replyLine);
  assert.equal(messages[2].role, 'assistant');
  const reaction = buildMessages({persona, context: 'ctx', text: 'The player has just entered combat.', reaction: true}).at(-1).content;
  assert.match(reaction, /\[EVENT, not spoken by V\]\nThe player has just entered combat\./);
  assert.doesNotMatch(reaction, /V says:/);
  const long = buildMessages({persona, context: 'c', text: 'x'.repeat(5000)}).at(-1).content;
  assert(long.length < LIMITS.playerText + 1000);
});

test('a live context over the cap keeps its head and its tail, where the format notes are', () => {
  const context = `HEAD ${'a'.repeat(30000)} TAIL: write {joy} tags and keep the first person.`;
  const capped = capContext(context, 1000);
  assert(capped.length <= 1010);
  assert(capped.startsWith('HEAD'));
  assert(capped.endsWith('keep the first person.'));
  assert(capped.includes('[...]'));
  assert.equal(capContext('short', 1000), 'short');
});

test('reply cleaning removes labels, stage directions, markdown, emoji and stray braces, and keeps real tags', () => {
  const clean = (text, name = 'Judy Alvarez') => cleanReply(text, {name, isTag});
  assert.equal(clean('Judy Alvarez: Sure thing, V.'), 'Sure thing, V.');
  assert.equal(clean('**Judy:** Sure thing.', 'Judy'), 'Sure thing.');
  assert.equal(clean('*smiles* Sure thing, V. (laughs)'), 'Sure thing, V.');
  assert.equal(clean('"Sure thing, V."'), 'Sure thing, V.');
  assert.equal(clean('She said "no" and he said "yes".'), 'She said "no" and he said "yes".');
  assert.equal(clean('Fine 😀 then!'), 'Fine then!');
  assert.equal(clean('## Heading\n- one\n- two'), 'Heading one two');
  assert.equal(clean('<think>planning the answer</think>Ready when you are.'), 'Ready when you are.');
  assert.equal(clean('<think>never closed'), '');
  assert.equal(clean('Come on, {choomba} let us go.'), 'Come on, let us go.');
  assert.equal(clean('{joy}Sure thing, V. [laughter]'), '{joy}Sure thing, V. [laughter]');
  assert.equal(clean('Sure [laughing out loud] thing.'), 'Sure thing.');
  assert.equal(clean('It costs (about 300) eddies.'), 'It costs (about 300) eddies.');
  assert.equal(clean('V: nothing'), 'nothing');
  assert.equal(clean('Line one.\n\nLine two.'), 'Line one. Line two.');
});

test('the length cap cuts at a sentence end and counts only real sentence ends', () => {
  const six = 'One. Two. Three. Four. Five. Six. Seven. Eight.';
  assert.equal(capReply(six), 'One. Two. Three. Four. Five. Six.');
  assert.equal(capPoint('One. Two.'), -1);
  assert.equal(capPoint('Exactly six. Two. Three. Four. Five. Six.'), -1);
  assert.equal(capReply('Dr. Okoye said it costs 3.5 thousand. Fine.'), 'Dr. Okoye said it costs 3.5 thousand. Fine.');
  const long = 'word '.repeat(300);
  const cut = capReply(long, {sentences: 6, chars: 100});
  assert(cut.length <= 102 && cut.endsWith('.'), cut);
  const loud = capReply('What?! No way... Really? Yes! Fine. Done. Extra.');
  assert.equal(loud, 'What?! No way... Really? Yes! Fine. Done.');
  assert.equal(capReply('Short and sweet.', LIMITS), 'Short and sweet.');
});

test('breaking character is recognised', () => {
  for (const text of ['As an AI language model, I cannot do that.', "I'm an AI assistant.", 'My instructions say otherwise.', 'I cannot roleplay that.'])
    assert(breaksCharacter(text), text);
  for (const text of ['I have a cyberdeck that thinks it is an AI.', 'Let me tell you about my instructor.']) assert(!breaksCharacter(text), text);
});

test('the summary request carries the old summary and the exchanges to fold in', () => {
  const messages = summaryMessages({name: 'Judy', summary: 'I fixed a rig for V.', turns: [{v: 'Thanks for the help', r: 'Anytime, choom.'}]});
  assert.equal(messages.length, 2);
  assert.match(messages[1].content, /What I remembered so far:\nI fixed a rig for V\./);
  assert.match(messages[1].content, /V: Thanks for the help\nJudy: Anytime, choom\./);
  assert.match(messages[0].content, /at most 110 words/);
});

test('reasoning written into the answer, a classifier verdict and a cut-off line are recognised; a normal line is not', async () => {
  const {leaksReasoning, looksCut, trimUnfinished} = await import('./mistral-prompt.mjs');
  for (const text of ['The user is asking me to roleplay as Panam Palmer from Cyberpunk 2077.', "Here's a thinking process: 1. Analyze the input.",
    'User Safety: safe', 'Okay, let me think about how Judy would answer.', 'I need to respond in the first person, briefly.',
    'Sure. Per the live context I should be short.'])
    assert(leaksReasoning(text), text);
  for (const text of ['Sure thing, V. What kind of job?', 'The user interface on this deck is garbage, V.', 'I need a drink. You buying?'])
    assert(!leaksReasoning(text), text);
  assert(looksCut('Alright,') && looksCut('Well -') && !looksCut('Alright.') && !looksCut(''));
  assert.equal(trimUnfinished('Sure thing, V. I was just about to'), 'Sure thing, V.');
  assert.equal(trimUnfinished('Sure thing, V.'), 'Sure thing, V.');
  assert.equal(trimUnfinished('no end at all'), 'no end at all');
});

test('a removed stage direction between two dashes does not leave a doubled dash', () => {
  assert.equal(cleanReply('And— (beat) —maybe a bike.', {name: 'Jackie Welles', isTag}), 'And—maybe a bike.');
});
