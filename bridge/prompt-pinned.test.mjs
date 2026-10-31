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
  // Re-taken on 2026-10-31 (merge of feat/natural-talk-retrieval and fix/narration-strip): rule 2 (plain) of the base rules ends with "No narration in plain words either: never describe your voice, your tone, your face or the phone line, and never say who is speaking or how." Nothing else moved: with that sentence taken out every hash above is the one the retrieval branch pinned.
  const expected = {
    a: 'd4547dc1ddae17d1dd4bd07b0ccaa192fa37a9e3bc4d840b5c45796308b7e7de',
    b: '5362355ad8d235038fd7336f08568fde104f08682e563941256ad7ed4daad8af',
    c: 'd4f3c4ca6dd964dc4b36d6335cd28ffb0daa2bb15d2b43302f2f9ac2be8b3dee',
    d: '0bf546bddd33e8a4a7ec51a358aa05682b80a8ceb440e1cb95e137f6eded23d9',
    e: '34344b085ebe4994a9b0a83a4e606518776336647c453ced9b27b0b058422f4a',
    f: '6d46542942b419540198f63c242736edd8abef3cc54cc6a9e2009d2f9d2e1362',
    g: 'b91526c48c598d6260f3fc3eab5a850e2df837ed73db6dff4e7929c0a7c68139',
  };
  for (const [key, hash] of Object.entries(expected)) assert.equal(sha(messagesFor(prompt, key)), hash, `line ${key}`);
  assert.equal(sha(buildMessages({...judyArgs('a loot event'), reaction: true})), 'e140e34bf0ae3918e60191375b7ea7627a3fc22e5458125dbe266a05768f4068');
  assert.equal(sha(buildMessages({persona: prompt.persona, memory: MEMORY, history: HISTORY, context: 'ctx', text: 'hi', limits: LIMITS})),
    '3819668238ab77cc874f572f4cb70dfd86cf190eae40dc3efe9bb873468cf474');
  assert.equal(sha(buildMessages({...judyArgs('hi'), mature: 'full'})), 'a87e11e1f44c3447abc0e7eaaba3bebc3bf7adfaa0ff851974e794e3719571ed');
  assert.equal(sha(systemHead({persona: prompt.persona})), '2330945d522a7c91c3b751e1215f3e0d830ffa588011a13945167c330d94efe4');
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
