import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseJournalHistory} from './journal-history.mjs';
import {JOURNAL_QUEST_TYPES} from './journal-quest-types.mjs';
import {conversationContext, conversationContextBlocks, withConversationKnowledge} from './quest-context.mjs';
import {dynamicInfo} from './dynamic-info.mjs';
import {storyLines, storyKnowledgeContext, MAX_LINES, MAX_LINE_CHARS} from './story-knowledge.mjs';
import {STORY_KNOWLEDGE, STORY_CHARACTERS, STORY_TOPICS} from './story-knowledge-data.mjs';

const NOW = 1_000_000;
const lane = {status: 'complete', ageSeconds: 1, windowSeconds: 0.5, observed: 1, omitted: 0, unstable: false};
const QUEEN = 'quests/side_quest/sq027_02_raffen_shiv_attack', PLAYING = 'quests/main_quest/act_01/q101_resurrection';
const BELLY = 'quests/main_quest/act_01/q114_03_attack_on_arasaka_tower', WARTIME = 'quests/main_quest/act_01/q104_02_av_chase';
const HOLDIN = 'quests/side_quest/sq011_kerry', PYRAMID = 'quests/side_quest/sq030_judy_romance';

let counter = 0;
const quest = (nativePath, state = 'succeeded', fields = {}) => {
  const nativeId = nativePath.split('/').at(-1);
  return {id: String(++counter), nativeId, nativePath, title: `Quest ${nativeId}`, state, lane: state === 'active' ? 'active' : 'history',
    observedAtMs: NOW - 1000, objectivesComplete: true, objectives: [], ...fields};
};
const inventory = quests => parseJournalHistory({version: 1, status: 'ready', generation: 1, worldToken: 'world-a', capturedAtMs: NOW,
  tracked: {status: 'untracked'}, coverage: {active: lane, history: lane}, quests});
const chip = {sq027_panam_knows_about_chip: {status: 'known', value: 1}};
const lines = (profileKey, quests, extra = {}) => storyLines({profileKey, history: inventory(quests), age: 1, now: NOW, ...extra});

test('the table: every character has all six topics, and every used quest exists in the game journal list and the research catalog', () => {
  const catalog = JSON.parse(readFileSync(new URL('../research/cyberpunk/generated/quest-catalog.json', import.meta.url), 'utf8'));
  assert.ok(catalog.quests.length > 100);
  for (const character of STORY_CHARACTERS) {
    const rows = STORY_KNOWLEDGE.filter(entry => entry.character === character);
    assert.deepEqual(rows.map(entry => entry.topic).sort(), [...STORY_TOPICS].sort(), `${character} covers each topic once`);
  }
  assert.equal(STORY_CHARACTERS.length, 10);
  const titles = new Set(catalog.quests.map(item => item.title.toLowerCase().replace(/[^a-z0-9]/g, '')));
  for (const entry of STORY_KNOWLEDGE) {
    assert.ok(STORY_CHARACTERS.includes(entry.character), entry.character);
    assert.ok(typeof entry.source === 'string' && entry.source.length > 5, `${entry.character}/${entry.topic} states its source`);
    if (!entry.quest) { assert.equal(entry.verified, false, 'a row with no quest is unverified'); continue; }
    assert.ok(Object.hasOwn(JOURNAL_QUEST_TYPES, entry.quest), `${entry.quest} is a journal quest`);
    assert.ok(titles.has(entry.questTitle.toLowerCase().replace(/[^a-z0-9]/g, '')), `${entry.questTitle} is in the research catalog`);
  }
});

test('the table: a verified row has a short plain line, an unverified one has none, and no line has a dash or a semicolon', () => {
  for (const entry of STORY_KNOWLEDGE) {
    const id = `${entry.character}/${entry.topic}`;
    if (entry.verified) {
      assert.ok(entry.line && entry.line.length < MAX_LINE_CHARS, `${id} line length ${entry.line.length}`);
      assert.ok(entry.quest, `${id} names its quest`);
    } else {
      assert.equal(entry.line, '', `${id} is unverified so it carries no text for a model`);
    }
    for (const text of [entry.line, entry.source, entry.note ?? '']) assert.doesNotMatch(text, /[–—;]|--/, id);
    assert.ok(!/\bAMM\b/.test(JSON.stringify(entry)), id);
  }
  assert.ok(STORY_KNOWLEDGE.some(entry => !entry.verified), 'unverified rows are kept and listed');
});

test('nothing leaks before the quest is finished: no quest, an active quest or a failed quest give no line', () => {
  assert.deepEqual(lines('viktor-vektor', []), []);
  assert.deepEqual(lines('viktor-vektor', [quest(PLAYING, 'active')]), [], 'active is not finished');
  assert.deepEqual(lines('viktor-vektor', [quest(PLAYING, 'failed')]), [], 'failed is not finished');
  assert.deepEqual(lines('viktor-vektor', [quest(HOLDIN)]), [], 'another quest unlocks nothing here');
  assert.equal(storyKnowledgeContext({profileKey: 'viktor-vektor', history: inventory([]), age: 1, now: NOW}), '', 'nothing learned, no block');
  assert.deepEqual(storyLines({profileKey: 'viktor-vektor', history: {status: 'unavailable'}}), []);
  assert.deepEqual(storyLines({profileKey: 'viktor-vektor'}), []);
  assert.deepEqual(lines('resident-male', [quest(PLAYING)]), [], 'an ordinary NPC knows none of it');
});

test('Panam: the Relic and the danger once Queen of the Highway is finished and V told her, not before', () => {
  assert.deepEqual(lines('panam-palmer', [], {facts: chip}), []);
  assert.deepEqual(lines('panam-palmer', [quest(QUEEN, 'active')], {facts: chip}), [], 'the quest is still running');
  const told = lines('panam-palmer', [quest(QUEEN)], {facts: chip});
  assert.equal(told.length, 2);
  assert.match(told[0], /biochip with a personality construct inside it/);
  assert.match(told[1], /threatening V's life/);
  assert.deepEqual(lines('panam-palmer', [quest(QUEEN)], {facts: {sq027_panam_knows_about_chip: {status: 'known', value: 0}}}), [], 'V did not tell her');
  assert.deepEqual(lines('panam-palmer', [quest(QUEEN)], {facts: {sq027_panam_knows_about_chip: {status: 'unknown'}}}), [], 'unknown is not told');
  assert.deepEqual(lines('panam-palmer', [quest(QUEEN)]), [], 'no current snapshot, no fact, no line');
  assert.ok(!told.join(' ').includes('Johnny'), 'her Johnny knowledge is unverified, so it is never stated');
});

test('Panam learns Hellman, Arasaka and Mikoshi only from their own finished quests', () => {
  const wartime = lines('panam-palmer', [quest(WARTIME)]);
  assert.equal(wartime.length, 1);
  assert.match(wartime[0], /Hellman/);
  assert.ok(!wartime.join(' ').match(/Mikoshi|Arasaka/));
  const belly = lines('panam-palmer', [quest(BELLY)]);
  assert.equal(belly.length, 2);
  assert.match(belly.join(' '), /Mikoshi/);
  assert.match(belly.join(' '), /Arasaka/);
  assert.equal(lines('panam-palmer', [quest(QUEEN), quest(WARTIME), quest(BELLY)], {facts: chip}).length, 5);
  assert.ok(lines('panam-palmer', [quest(QUEEN), quest(WARTIME), quest(BELLY)], {facts: chip}).length <= MAX_LINES);
});

test('the other characters unlock their own lines from their own quests', () => {
  assert.equal(lines('viktor-vektor', [quest(PLAYING)]).length, 3);
  assert.match(lines('viktor-vektor', [quest(PLAYING)]).join(' '), /Silverhand's construct/);
  assert.match(lines('kerry-eurodyne', [quest(HOLDIN)])[0], /Johnny/);
  assert.equal(lines('judy-alvarez', [quest(PYRAMID)]).length, 2);
  assert.equal(lines('johnny-silverhand', [quest(PLAYING)]).length, 4);
  assert.deepEqual(lines('river-ward', [quest(PLAYING), quest(PYRAMID), quest(QUEEN), quest(BELLY)]), [], 'nothing is verified for River');
  assert.equal(lines('rogue-amendiares', [quest('quests/main_quest/act_01/q115_afterlife')]).length, 0, 'her assault lines need the route fact');
  const route = {q115_rogue_in_av: {status: 'known', value: 1}};
  assert.equal(lines('rogue-amendiares', [quest('quests/main_quest/act_01/q115_afterlife')], {facts: route}).length, 2);
});

test('a group turn only gets what the others could also know, and a quest row without a path is found by its id', () => {
  assert.deepEqual(lines('viktor-vektor', [quest(PLAYING)], {group: true}), [], 'a private diagnosis stays private');
  assert.equal(lines('panam-palmer', [quest(BELLY)], {group: true}).length, 2, 'witnessed events are shared');
  const bare = quest(PLAYING); delete bare.nativePath;
  assert.equal(lines('viktor-vektor', [bare]).length, 3);
});

test('a stale lane gives nothing, and a finished quest is judged by its lane', () => {
  const old = inventory([quest(PLAYING)]);
  assert.equal(storyLines({profileKey: 'viktor-vektor', history: old, age: 1, now: NOW}).length, 3);
  assert.deepEqual(storyLines({profileKey: 'viktor-vektor', history: old, age: 10_000, now: NOW}), []);
});

test('in a real turn: a stable world block, only for a finished quest, off with the Quest and journal switch', () => {
  const turn = (profileKey, quests, fields = {}, off) => {
    const before = dynamicInfo.off; dynamicInfo.off = off ?? before;
    try {
      const attached = withConversationKnowledge({profileKey, text: 'hello', requestId: 'r1', id: 'e1', entity: 'e1', name: 'X', channel: 'private',
        journalHistory: inventory(quests), ...fields}, {generation: 1, worldToken: 'world-a', now: NOW});
      return {text: conversationContext(attached), blocks: conversationContextBlocks(attached)};
    } finally { dynamicInfo.off = before; }
  };
  const done = turn('viktor-vektor', [quest(PLAYING)]);
  const block = done.blocks.find(item => item.key === 'story');
  assert.equal(block.tier, 'world', 'stable between turns, it never moves the volatile tail');
  assert.match(block.text, /Silverhand's construct/);
  assert.match(done.text, /fuse lit/);
  assert.equal(turn('viktor-vektor', [quest(PLAYING, 'active')]).blocks.find(item => item.key === 'story').text ?? '', '', 'not finished');
  assert.doesNotMatch(turn('viktor-vektor', [quest(PLAYING, 'active')]).text, /fuse lit/);
  assert.doesNotMatch(turn('viktor-vektor', [quest(PLAYING)], {}, Object.freeze(new Set(['quest']))).text, /fuse lit/, 'the switch is off');
  assert.doesNotMatch(turn('resident-male', [quest(PLAYING)]).text, /fuse lit/, 'an ordinary NPC');
  assert.doesNotMatch(turn('viktor-vektor', [quest(PLAYING)], {journalHistory: undefined}).text, /fuse lit/, 'no inventory');
  // The same inventory gives the same text twice, so the prompt cache keeps its prefix.
  assert.equal(turn('viktor-vektor', [quest(PLAYING)]).blocks.find(item => item.key === 'story').text, block.text);
});
