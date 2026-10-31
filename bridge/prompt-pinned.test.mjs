import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildMessages, systemHead, LIMITS, PROMPT_SOURCE} from './mistral-prompt.mjs';
import {budgetedChat, TokenMeter, estimateTokens} from './prompt-budget.mjs';
import {buildPrompt, messagesFor, HISTORY, MEMORY, REMEMBERED, USER_LINES} from '../scripts/judy-prompt-fixture.mjs';

// Pins the prompt of every provider byte for byte (the Groq shaping that these tests were first written for was removed on 2026-10-14; Mistral's and the
// local AI's prompt did not change then or before), and the two optional features of the prompt budget (a soft target and a shaping hook).
const prompt = buildPrompt();
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const judyArgs = (text = USER_LINES.a) => ({persona: prompt.persona, memory: MEMORY, history: HISTORY, contextParts: prompt.contextParts, remembered: REMEMBERED, text, limits: LIMITS});

// ---- The prompt is pinned --------------------------------------------------------------------------------------------------

test('the prompt Mistral and the local AI build is byte for byte what it was (hashes taken from commit 1e207eec, re-taken on 2026-10-14 for the first-person profiles)', () => {
  // Computed with `buildMessages` as of 1e207eec (no `compact` anywhere), re-taken on 2026-10-14 for the first-person profiles (old code and new code agree on them) and on 2026-10-15 for the place and usual-haunts sentences of the right-now block (lines a-g, the reaction and the Mature layer; the 'ctx' and system-head hashes did not change): Judy's seven fixture lines, a reaction, layout v1 and the Mature layer. Re-taken on 2026-10-21 (lines a-g, the reaction and the Mature layer) for the clock: it left the right-now block for a short Background line in the volatile tail (bridge/scenery-memory.mjs); the fixture's turn is a first turn, so that line is there.
  // Re-taken on 2026-10-22 (response audit): rule 7 no longer asks for "a few words of attitude about the place or the hour" and says nothing of weather, time or place unless V asks; the copy of the
  // right-now sentence before V's words no longer names the place (the system message's block still does). The roster text itself is unchanged here (PersonaBook `lean` is off in this fixture).
  // Re-taken again on 2026-10-22 on the merge with feat/dynamic-info: the right-now block's own where-sentence (the place is a second sentence, never in the first) and its one
  // guidance sentence ("mention a place or the time only if it matters to what V says"; docs/DYNAMIC_INFO.md), on top of the response audit's changes above.
  // Re-taken on 2026-10-31 (fix/talk-repetition-gear): the copy of the right-now sentence before V's words adds "Never announce that you are here or beside V, or that V is here." (a partner said "I'm still here, standing right beside you" to someone next to her).
  // Re-taken on 2026-10-30 (fix/natural-talk, docs/NATURAL_TALK_RESEARCH_2026-10-30.md): the world heading says the facts are what she already knows, as background, and V's
  // money band is told only when V's words are about money. Re-taken on the merge into main (2026-10-30) on top of the Natural speech re-take above.
  // Re-taken on 2026-10-31 (feat/natural-talk-retrieval): the world, the older-talk summary, the knowledge, the right-now block and the fresh facts moved from the system message to the start of the
  // last message, after the history (a changed world block no longer throws away the cached persona and history), and rule "now" says "the last message" instead of "the end of this message".
  const expected = {
    a: '28a85694db5cd5595c0d3154da0b47735f5fb4ca92fe16ad92b9f2cf0d00caec',
    b: 'af7edd31bfc5a7fc782e2bc5fa74191449eedfa41dab94a9313269ecb772a709',
    c: '546c5cec5b4abab3a4c0d696aeada088bd5332b0a9874de1eaa95ac311675674',
    d: '4c884cda1344df56faca8520a4431d3957799a90956766bc6dc7294b3b41195f',
    e: 'e183e82eb641143d76c033bbdabbe1678a482c2d3ea8fadd6c1c2f0b292fff6f',
    f: '3866632eb668cc5c1df5fa69521086bccd2456a9968b94b8aa67bd07ca08183a',
    g: 'efa9ee6f00ab72ece856c389fabe5ea061c3191889d2610d812c8aea8d0aac82',
  };
  for (const [key, hash] of Object.entries(expected)) assert.equal(sha(messagesFor(prompt, key)), hash, `line ${key}`);
  assert.equal(sha(buildMessages({...judyArgs('a loot event'), reaction: true})), 'ca92b18f2e8fc4ef39c8fbc7ea76f9e4c0c42d914c3f16457fa6aedecd55de20');
  assert.equal(sha(buildMessages({persona: prompt.persona, memory: MEMORY, history: HISTORY, context: 'ctx', text: 'hi', limits: LIMITS})),
    '8a0846a17b546c53627b221bb4c362c6a33cb917d5e6586533e3990b5c77aa73');
  assert.equal(sha(buildMessages({...judyArgs('hi'), mature: 'full'})), '86c8c63001f1f376077880767560f5e90bc211b876bd3ce9ab5d61449c709569');
  assert.equal(sha(systemHead({persona: prompt.persona})), 'cdad28c1c440a30cbb71c97797a0736129c734f7d0d4b426f36f9e9690514888');
});

// ---- The budget's new options ----------------------------------------------------------------------------------------------

test('budgetedChat: a soft target is tried first and a prompt that cannot reach it is fitted to the hard limit, never refused for the soft one', async () => {
  const sent = [];
  const chat = async options => { sent.push(options.messages); return {text: 'ok'}; };
  const hard = 8000;
  // A target no prompt can reach (the rules and notes alone are above it): the hard fit decides, and the request goes out.
  const fit = budgetedChat(chat, {budget: () => ({contextTokens: hard, reserveTokens: 256, meter: new TokenMeter(), soft: {contextTokens: 900, reserveTokens: 256}})});
  await fit({messages: buildMessages(judyArgs()), provider: 'local'});
  assert.equal(sent.length, 1);
  assert(estimateTokens(sent[0]) <= hard);
  // A target the prompt can reach: it is used.
  const tight = [];
  const reachable = budgetedChat(async options => { tight.push(options.messages); return {text: 'ok'}; },
    {budget: () => ({contextTokens: hard, reserveTokens: 256, meter: new TokenMeter(), soft: {contextTokens: 7000, reserveTokens: 256}})});
  await reachable({messages: buildMessages(judyArgs()), provider: 'local'});
  assert(estimateTokens(tight[0]) <= 7000 - 256);
});

test('budgetedChat: `shape` receives the source arguments and the options and its result is what is built; without one nothing changes', async () => {
  const seen = [];
  const sent = [];
  const chat = async options => { sent.push(options.messages); return {text: 'ok'}; };
  const messages = buildMessages(judyArgs());
  const shaped = budgetedChat(chat, {budget: () => ({contextTokens: 20000}), shape: (args, options) => { seen.push([args, options.provider]); return {...args, history: []}; }});
  await shaped({messages, provider: 'local'});
  assert.equal(seen[0][0], messages[PROMPT_SOURCE]);
  assert.equal(seen[0][1], 'local');
  assert(sent[0].length < messages.length, 'the history the shape removed is gone');
  const plain = budgetedChat(chat, {budget: () => ({contextTokens: 20000})});
  await plain({messages, provider: 'local'});
  assert.equal(sha(sent[1]), sha(messages), 'no shape, no soft target: the very same prompt');
});
