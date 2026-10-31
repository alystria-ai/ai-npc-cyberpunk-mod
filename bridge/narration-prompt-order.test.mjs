// The two prompt changes of 31 Oct 2026 side by side: talk retrieval (everything that changes between turns comes after the history) and the narration line
// (the plain rule tells the model not to narrate its voice, its tone or who is speaking). The line belongs to the stable head: once in the system message of every profile,
// nowhere in the last message, the same text whether retrieval is on or off, and untouched when the world or the knowledge changes.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {worldTurn} from './fixtures/talk-world.mjs';
import {conversationContextBlocks, retrievalSources} from './quest-context.mjs';
import {PersonaBook, buildMessages, withRetrievedParts, joinBlocks, worldBlocksInCacheOrder} from './mistral-prompt.mjs';
import {TalkRetrieval, Corpus} from './talk-retrieval.mjs';
import {BASE_PROFILE, BUILT_IN_IDS, FAMILY_IDS, defaultProfile, customProfileId} from './prompt-profiles.mjs';

const roster = JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8'));
const withTopics = new PersonaBook(roster, {lean: true, topics: true}), wholeBook = new PersonaBook(roster, {lean: true});
const corpus = new Corpus(roster.flatMap(row => withTopics.topicMaterial(row.key, {raw: true})?.items.map(item => item.text.split('\n')[0]) ?? []));
const history = Array.from({length: 4}, (_, index) => ({v: `Tell me about job number ${index}.`, r: `It was a long night number ${index}, V.`}));

const partsOf = blocks => { const ordered = worldBlocksInCacheOrder(blocks); return {now: 'Right now: You are with V in person.', notes: '', world: joinBlocks(ordered.map(block => block.text)), worldBlocks: ordered, volatile: '', closing: ''}; };
async function build(input, {retrieval = true, profile} = {}) {
  const full = partsOf(conversationContextBlocks(input));
  const result = await new TalkRetrieval({topicFor: key => withTopics.topicMaterial(key), corpus})
    .prepare({profileKey: input.profileKey, requestId: input.requestId, text: input.text, reaction: false}, {sources: retrievalSources(input)});
  return buildMessages({persona: (retrieval ? withTopics : wholeBook).persona('panam-palmer'), memory: 'I remember V from the camp.', history,
    contextParts: retrieval ? withRetrievedParts(full, result) : full, remembered: [], text: input.text, ...(profile ? {profile} : {})});
}
const occurrences = (text, part) => text.split(part).length - 1;
const profiles = [['base', undefined], ...[...BUILT_IN_IDS.map(id => [id, defaultProfile(id)]),
  ...FAMILY_IDS.map(family => [`family:${family}`, defaultProfile(customProfileId('http://example.test', 'x'), {family})])]];

test('the plain rule with the narration line is once in the system message of every profile, never in the last message, with retrieval on or off', async () => {
  for (const [id, profile] of profiles) {
    const plain = (profile ?? BASE_PROFILE).rules.find(rule => rule.id === 'plain');
    assert.ok(plain, `${id}: has a plain rule`);
    assert.match(plain.text, /narrat|how they sound|who says them/i, `${id}: the plain rule carries the narration line`);
    for (const retrieval of [true, false]) {
      const messages = await build(worldTurn('what happened to Saul?', {facts: 8}), {retrieval, profile});
      assert.equal(occurrences(messages[0].content, plain.text), 1, `${id}, retrieval ${retrieval}: once in the system message`);
      assert.equal(messages.slice(1).map(message => message.content).join('\n').includes(plain.text), false, `${id}, retrieval ${retrieval}: not after the head`);
    }
  }
});

test('the head, with the narration line in it, has the same output rules with retrieval on and off', async () => {
  const on = (await build(worldTurn('hey'), {retrieval: true}))[0].content, off = (await build(worldTurn('hey'), {retrieval: false}))[0].content;
  const rules = text => text.slice(text.indexOf('OUTPUT RULES')).split('\n\n')[0];
  assert.ok(rules(on).includes('No narration in plain words either'));
  assert.equal(rules(on), rules(off));
});

test('a changed world or knowledge block moves nothing up to the end of the history, the narration line included', async () => {
  const base = await build(worldTurn('what happened to Saul?', {facts: 8}));
  for (const other of [await build(worldTurn('what happened to Saul?', {facts: 20})), await build(worldTurn('what happened to Saul?', {facts: 8, quests: 9}))]) {
    assert.equal(JSON.stringify(other.slice(0, -1)), JSON.stringify(base.slice(0, -1)));
    assert.ok(other[0].content.includes('No narration in plain words either'));
  }
});
