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
  const expected = {
    a: 'ecdd7b1aa0d971a673e8355fb5716a6345266936a1bc0d7e1bd24d5cc4323337',
    b: '20896a98390e237cc5b6de2fbe8b6925623787cff9fa677091dba0b70fbc1939',
    c: '57e7c6fc686ea8d78436430bd42a74f978f20a0eda6938a4212424cf8ad17d7b',
    d: 'f58e33938c43ae3b808821cfb84056f01cc525fdade32612f4f170f2b84a38bc',
    e: '308ee20b4a7f78ee72cfe782e5719dc2a8acdd6f4d1e32329fb8926799dd94f4',
    f: '2731b5d9c283c8e0eec923670bdf21bb2fae725175ecc4787afdd734e0d96384',
    g: '7b0467247d97bd75bec26a9bb5302046a53f3607579cea740eddffce8fa0ccb6',
  };
  for (const [key, hash] of Object.entries(expected)) assert.equal(sha(messagesFor(prompt, key)), hash, `line ${key}`);
  assert.equal(sha(buildMessages({...judyArgs('a loot event'), reaction: true})), 'da97a53ed834c7460ce047ccd35b20deff739664192e7a6d7c37030cbbfe8360');
  assert.equal(sha(buildMessages({persona: prompt.persona, memory: MEMORY, history: HISTORY, context: 'ctx', text: 'hi', limits: LIMITS})),
    'b73c697299ad24497e5a7b9fa8d1a6d8287f13173efdcc9ff0bbf9a2e21c7d5f');
  assert.equal(sha(buildMessages({...judyArgs('hi'), mature: 'full'})), '242e27cc32634f51a2840034033d9847acaf7f334757e23efd4001f2f64261f9');
  assert.equal(sha(systemHead({persona: prompt.persona})), 'e280e404f9a7f4db6cf79db635db722f61f92b3189b561a30b75fe257938c856');
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
