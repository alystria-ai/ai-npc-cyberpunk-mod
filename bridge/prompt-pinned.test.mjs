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
  // Computed with `buildMessages` as of 1e207eec (no `compact` anywhere), re-taken on 2026-10-14 for the first-person profiles (old code and new code agree on them), on 2026-10-22 for the right-now block's own where-sentence and its one guidance sentence (lines a-g, the reaction and the Mature layer; Dynamic info, docs/DYNAMIC_INFO.md) and on 2026-10-15 for the place and usual-haunts sentences of the right-now block (lines a-g, the reaction and the Mature layer; the 'ctx' and system-head hashes did not change): Judy's seven fixture lines, a reaction, layout v1 and the Mature layer. Re-taken on 2026-10-21 (lines a-g, the reaction and the Mature layer) for the clock: it left the right-now block for a short Background line in the volatile tail (bridge/scenery-memory.mjs); the fixture's turn is a first turn, so that line is there.
  const expected = {
    a: '332897714185ff663d62d012f245e4ad090482b9f72c3e79c620f2831be7b1fd',
    b: 'fac0c9bb5a9f7dfbb082baa8e6e50e91b90a2998671056427ea4160db065ff7d',
    c: 'e7dae0c284487c6faec18c26f7126d5f07728f5d376b955daea5804e8a08e3d6',
    d: 'c1fd88f38762ee34636d75da4adb2ef3e424359dcf70985b3121377bbed0edac',
    e: '194509d6c6a631308d08002be62bf586cc7791ccaeeef94b98fba2ab36580dad',
    f: 'ac67c2ee35a7b9c22d86c44120c60a54764bf3d2f066b81a09930f3b810d15a2',
    g: 'fb8c88b693a18904c209aa19a8506d1ab73ee481bc51674983833132c41c1b29',
  };
  for (const [key, hash] of Object.entries(expected)) assert.equal(sha(messagesFor(prompt, key)), hash, `line ${key}`);
  assert.equal(sha(buildMessages({...judyArgs('a loot event'), reaction: true})), 'aca192680434203f04bc16b90541c27d417e10ef2c13d4524444e0b57453873c');
  assert.equal(sha(buildMessages({persona: prompt.persona, memory: MEMORY, history: HISTORY, context: 'ctx', text: 'hi', limits: LIMITS})),
    '71afe8b30cf3be13bf64bdd54f4a34283b875d3679159a9affe2944f5f9bbaa1');
  assert.equal(sha(buildMessages({...judyArgs('hi'), mature: 'full'})), '320209db60fe39b285a41a84e5f3e6a9b29147c1a939acdd1c5b98badc8def02');
  assert.equal(sha(systemHead({persona: prompt.persona})), 'dc55ee3f93c420f63746cbbed90314261e4d78c936f5e034614424f98cbd39e0');
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
