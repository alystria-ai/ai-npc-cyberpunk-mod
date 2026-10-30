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
  // Re-taken on 2026-10-30 (fix/natural-talk, docs/NATURAL_TALK_RESEARCH_2026-10-30.md): the world heading says the facts are what she already knows, as background, and V's
  // money band is told only when V's words are about money.
  const expected = {
    a: 'fc9696ac6f1746bc8b0a70c58ecd48db9a0b914f18217a8baf66aec371c0264c',
    b: 'b256279743f9c17b3cf6d0c0069e57f09e07717301691ce30d5ccfa151238e98',
    c: '2c286b5e663d379f81bfd8f978717dc4d15c6fc93b2062674288baaf6a59dadb',
    d: '50b8abda577515c89a244165701bc45b9b6cfa9d4f214b80d2cb7d5e7d51d749',
    e: '8da4defcc904302ac3d8b2bf7669c5520c0c1a5388c8a171d023947c58b6c2a3',
    f: '7c71ee5d920bc05081a65b0c0eb37c39efc8d7b80bbea8b6ea00e37fc5a86762',
    g: 'ae8397b7acc71b51f6acd603c7585a7903b9f85e18ea835c0c044460e8705c1a',
  };
  for (const [key, hash] of Object.entries(expected)) assert.equal(sha(messagesFor(prompt, key)), hash, `line ${key}`);
  assert.equal(sha(buildMessages({...judyArgs('a loot event'), reaction: true})), '3df94c6ab9c737e545bb9e312a3e2605631575389a9b99c31066918af0289cdb');
  assert.equal(sha(buildMessages({persona: prompt.persona, memory: MEMORY, history: HISTORY, context: 'ctx', text: 'hi', limits: LIMITS})),
    'b73c697299ad24497e5a7b9fa8d1a6d8287f13173efdcc9ff0bbf9a2e21c7d5f');
  assert.equal(sha(buildMessages({...judyArgs('hi'), mature: 'full'})), '47c6cf0e943bbced4170aa9b94b137a1659fe5e7527c5b5239278f519861c675');
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
