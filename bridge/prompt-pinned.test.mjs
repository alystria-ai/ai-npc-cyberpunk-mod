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
  const expected = {
    a: '673d59521d0de368442a0e021e20be609ead20c280aded68c3a0ca6311131eb8',
    b: 'fc68e51460d945ec25def020d5ca8226c85676ec9074eabc391c29f767dc4e55',
    c: '493861a79c4c6adb0c4f4bc0a723be5f4ce81b52ade61366d8f5e04312bbbf7c',
    d: '7f797d3ea0168432a33c393404c66ba71984528675d0074a2f754785ef87fe31',
    e: 'c6e3188ba7818043591bce270d1eddc70e8ca31ded783037be26e6e1139da5b4',
    f: 'd0f28ead166022f0ba5681505d77add3767fd00b3fd0d47ac7c1a853f846a84c',
    g: 'f84b3bfc6782af6709805cbcf2241e3f7e4e892acb67e8855fbf833197a867fe',
  };
  for (const [key, hash] of Object.entries(expected)) assert.equal(sha(messagesFor(prompt, key)), hash, `line ${key}`);
  assert.equal(sha(buildMessages({...judyArgs('a loot event'), reaction: true})), '0a5d2681164e2b0b8e2ef8d98e923cd50933e24764f53ed39bb392cce2513b3a');
  assert.equal(sha(buildMessages({persona: prompt.persona, memory: MEMORY, history: HISTORY, context: 'ctx', text: 'hi', limits: LIMITS})),
    'b73c697299ad24497e5a7b9fa8d1a6d8287f13173efdcc9ff0bbf9a2e21c7d5f');
  assert.equal(sha(buildMessages({...judyArgs('hi'), mature: 'full'})), 'ad4e0a03666c1f432cc8931aa6bf6850daa9055413ba0f50f7400738ae519223');
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
