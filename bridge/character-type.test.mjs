import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TYPES, POLICY, modeFor, TYPE_LINES, setCharacterRoster, characterTypeOf, typeLine, tieWords, placeWords, tieOf, touches, words} from './character-type.mjs';
import {conversationContextBlocks, withConversationKnowledge} from './quest-context.mjs';
import {availableQuestsContext} from './quest-overview.mjs';
import {parseJournalHistory, selectJournalHistory} from './journal-history.mjs';

// Context by character type (docs/CONTEXT_BY_TYPE.md): story characters keep the full quest context, side characters get quest and world context only when it is tied
// to them, strangers never, and every character is told what kind of person it is.
const text = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/^﻿/, '');
const roster = [...JSON.parse(text('../characters/roster.json')), ...JSON.parse(text('../characters/archetype-roster.json'))];
const ROWS = [
  {key: 'judy-alvarez', name: 'Judy Alvarez', kind: 'named', summary: "Judy is a braindance editor working from the basement of Lizzie's Bar, allied with the Mox."},
  {key: 'adam-giles', name: 'Adam Giles', kind: 'named', minor: true, aliases: ['Adam Giles'], summary: 'Adam Giles is a member of the Animals gang, a Night City street crew known for heavy-handed muscle.'},
  {key: 'npc-maelstrom-male', name: '', kind: 'archetype', summary: 'Generic Maelstrom ganger (male): an unnamed NPC archetype, not a canon individual.'},
];
setCharacterRoster(ROWS);

const lines = value => value.map(block => block.text).filter(Boolean);
const said = (block, part) => typeof block.text === 'string' && block.text.includes(part);
const find = (blocks, key) => blocks.find(block => block.key === key);
const journal = (title = 'Pyramid Song', objective = 'Meet Hanako at Embers.') => ({version: 1, status: 'active',
  quest: {id: '5', title, objectives: [{id: '6', text: objective, tracked: true}]}});
const input = (profileKey, fields = {}) => ({requestId: '1-1-1ULL', profileKey, name: profileKey, text: 'hey, how is it going?', journal: journal(), ...fields});
const hasJournal = blocks => lines(blocks).some(line => line.includes('verified current-save journal'));

test('the table is small, frozen and says what each type may be told', () => {
  assert.deepEqual([...TYPES], ['story', 'side', 'stranger']);
  assert.ok(Object.isFrozen(POLICY) && TYPES.every(type => Object.isFrozen(POLICY[type])));
  for (const type of TYPES) assert.deepEqual(Object.keys(POLICY[type]), ['journal', 'jobs', 'history', 'recency', 'story', 'briefing', 'knowledge']);
  assert.ok(Object.values(POLICY.story).every(mode => mode === 'all'), 'a story character is told everything, as before');
  assert.ok(Object.values(POLICY.stranger).every(mode => mode === 'none'), 'a stranger is told none of it');
  for (const part of ['journal', 'jobs', 'history']) assert.equal(POLICY.side[part], 'tied', part);
  assert.equal(modeFor('side', 'nothing-yet'), 'all');
  assert.equal(modeFor('unknown-type', 'journal'), 'all');
});

test('the type of every key comes from the roster: the cast sweep rows are side, other named rows story, crowd keys strangers', () => {
  setCharacterRoster(roster);
  const count = {story: 0, side: 0, stranger: 0};
  for (const row of roster) {
    const type = characterTypeOf(row.key);
    count[type]++;
    if (row.kind === 'named') assert.equal(type, row.minor === true ? 'side' : 'story', row.key);
    else assert.equal(type, 'stranger', row.key);
  }
  assert.ok(count.side >= 500 && count.story >= 100 && count.stranger >= 80, JSON.stringify(count));
  assert.equal(characterTypeOf('resident-male'), 'stranger');
  assert.equal(characterTypeOf('npc-anything-new'), 'stranger');
  assert.equal(characterTypeOf('a-character-the-player-made'), 'story', 'an unknown key keeps the full context as before');
  assert.equal(typeLine('a-character-the-player-made'), '', 'and gets no type line');
  setCharacterRoster(ROWS);
});

test('every character is told what kind of person it is, with its own role from the roster, the same text every turn', () => {
  assert.match(typeLine('adam-giles'), /everyday Night City person.*not part of V's story/);
  assert.match(typeLine('adam-giles'), /Your place in Night City: a member of the Animals gang, a Night City street crew known for heavy-handed muscle\.$/);
  assert.match(typeLine('judy-alvarez'), /^You are one of the people V's story runs through/);
  assert.match(typeLine('judy-alvarez'), /Your place in Night City: a braindance editor working from the basement of Lizzie's Bar, allied with the Mox\.$/, 'a summary that starts with the first name');
  assert.equal(typeLine('npc-maelstrom-male'), TYPE_LINES.stranger);
  assert.equal(typeLine('resident-female'), TYPE_LINES.stranger);
  assert.equal(typeLine('adam-giles'), typeLine('adam-giles'));
  for (const key of ['judy-alvarez', 'adam-giles', 'npc-maelstrom-male']) assert.ok(typeLine(key).length < 520, key);
  // A summary that does not start with the name and "is" adds no role, rather than a wrong one.
  setCharacterRoster([{key: 'x', name: 'Xavier Roe', kind: 'named', minor: true, summary: 'A fixer in the Glen.'}]);
  assert.equal(typeLine('x'), TYPE_LINES.side);
  setCharacterRoster(ROWS);
  // The shipped roster: almost every named row has a role line.
  setCharacterRoster(roster);
  const named = roster.filter(row => row.kind === 'named');
  assert.ok(named.filter(row => typeLine(row.key).includes('Your place in Night City')).length / named.length > 0.8);
  setCharacterRoster(ROWS);
});

test('the tie words of a character are its name, aliases and the proper names of its summary, and ordinary words tie nothing', () => {
  const tie = tieWords('adam-giles');
  assert.ok(tie.has('adam') && tie.has('giles') && tie.has('animals'));
  assert.ok(!tie.has('gang') && !tie.has('night') && !tie.has('city') && !tie.has('muscle'));
  assert.equal(tieWords('unknown').size, 0);
  assert.ok(touches('Settle a score with the Animals', tie));
  assert.ok(!touches('Meet Hanako at Embers.', tie));
  assert.deepEqual([...words('The Night City quest: Pyramid Song, 2077')].sort(), ['PYRAMID'.toLowerCase(), 'song'].sort());
  assert.deepEqual([...placeWords({district: 'Watson', area: 'Little China'})].sort(), ['china', 'little', 'watson']);
  assert.equal(tieOf('Settle a score with the Animals', {profileKey: 'adam-giles'}), 'own');
  assert.equal(tieOf('Meet Hanako at Embers.', {profileKey: 'adam-giles', place: placeWords({area: 'Embers'})}), 'own');
  assert.equal(tieOf('Meet Hanako at Embers.', {profileKey: 'adam-giles', talk: 'what about hanako?'}), 'talk');
  assert.equal(tieOf('Meet Hanako at Embers.', {profileKey: 'adam-giles', talk: 'hey how are you'}), false);
});

test('a story character gets the tracked quest as always, in the stable world part', () => {
  const blocks = conversationContextBlocks(input('judy-alvarez'));
  const block = find(blocks, 'journal');
  assert.equal(block.tier, 'world');
  assert.match(block.text, /Pyramid Song/);
  assert.ok(blocks.slice(0, 3).some(item => item.tier === 'world' && /story runs through/.test(item.text ?? '')), 'the type line follows the right-now block');
});

test('a side character gets the tracked quest only when it is tied to them: stable when it names them or where they stand, this turn only when V asks', () => {
  // Not tied: no journal at all.
  let blocks = conversationContextBlocks(input('adam-giles'));
  assert.ok(!hasJournal(blocks), 'an unrelated quest is not told to a side character');
  assert.ok(!blocks.some(block => block.key === 'journal' && block.text));
  // Tied by the character's faction: part of the stable world text.
  blocks = conversationContextBlocks(input('adam-giles', {journal: journal('Gig: Animals Trouble', 'Talk to the Animals.')}));
  assert.equal(find(blocks, 'journal').tier, 'world');
  assert.ok(hasJournal(blocks));
  // Tied by the place they stand in.
  blocks = conversationContextBlocks(input('adam-giles', {turnContext: {version: 1, status: 'ready', hour: 12, minute: 0, district: 'Watson', area: 'Embers'}}));
  assert.equal(find(blocks, 'journal').tier, 'world');
  // Tied only by V's words this turn: after the history, never in the stable part.
  blocks = conversationContextBlocks(input('adam-giles', {text: 'do you know anything about Hanako?'}));
  const talk = blocks.find(block => said(block, 'verified current-save journal'));
  assert.equal(talk.tier, 'volatile');
  assert.equal(talk.key, undefined, 'a block of this turn only is never cut by key');
  assert.ok(!blocks.some(block => block.tier === 'world' && said(block, 'verified current-save journal')));
  // No tracked quest, or an unreadable one: nothing to tie.
  assert.ok(!hasJournal(conversationContextBlocks(input('adam-giles', {journal: {version: 1, status: 'untracked'}}))));
});

test('a stranger gets none of the quest context and only a line about who they are', () => {
  const blocks = conversationContextBlocks(input('npc-maelstrom-male', {text: 'what about Pyramid Song?'}));
  assert.ok(!hasJournal(blocks));
  assert.ok(!blocks.some(block => ['journal', 'jobs', 'history', 'knowledge', 'story', 'recency'].includes(block.key) && block.text));
  const line = blocks.find(block => block.text === TYPE_LINES.stranger);
  assert.equal(line?.tier, 'world');
});

test('the stable parts stay ahead of the changing ones: the type line is a world block right after the right-now block and never in the notes of a turn', () => {
  for (const key of ['judy-alvarez', 'adam-giles', 'npc-maelstrom-male']) {
    const blocks = conversationContextBlocks(input(key));
    assert.equal(blocks[0].tier, 'now');
    const at = blocks.findIndex(block => block.text === typeLine(key));
    assert.ok(at > 0 && at <= 2, `${key}: at ${at}`);
    assert.equal(blocks[at].tier, 'world');
    assert.equal(blocks[at].key, undefined, 'the line is never cut by the prompt budget');
    assert.ok(blocks.slice(0, at).every(block => block.tier === 'now' || !block.text), 'only Johnny\'s head block may come before it');
    assert.ok(!blocks.some(block => block.tier === 'volatile' && said(block, typeLine(key))));
  }
});

// ---- the history and the jobs ----
const lane = {status: 'complete', ageSeconds: 1, windowSeconds: 0.5, observed: 1, total: 1, omitted: 0, unstable: false};
const entry = (id, title, objectiveText, fields = {}) => ({id, nativeId: `n${id}`, title, state: 'succeeded', lane: 'history', observedAtMs: 999000, objectivesComplete: true,
  objectives: [{id: String(Number(id) + 100), nativeId: 'o', questRelativePath: [`n${id}`, 'o'], text: objectiveText, state: 'succeeded', observedAtMs: 999500}], ...fields});
const snapshot = {version: 1, status: 'ready', generation: 1, worldToken: 'world-a', capturedAtMs: 1000000,
  tracked: {status: 'known', questId: '1', objectiveId: '101'}, coverage: {active: lane, history: lane},
  quests: [entry('1', 'Current Quest', 'Meet Hanako at Embers.', {state: 'active', lane: 'active'}),
    entry('2', 'Pyramid Song', 'Dive with Judy.'), entry('3', 'Animals Brawl', 'Fight the Animals outside the Afterlife.'), entry('4', 'Heirloom', 'Find the family heirloom.')]};
const catalog = {quests: [{key: 'heirloom', title: 'Heirloom', nativeIds: [], characters: ['adam-giles']}]};
const pick = (extra = {}) => selectJournalHistory({snapshot, generation: 1, worldToken: 'world-a', now: 1000000, profileKey: 'adam-giles', questCatalog: catalog, ...extra});

test('history: a side character is told a past quest only when the catalog, their faction, the place or V\'s words tie it to them', () => {
  // A story character: the tracked quest, as before.
  assert.deepEqual(pick({query: 'tell me about the old days'}).diagnostics.selected, ['1']);
  // A side character: the tracked quest is V's business unless it is tied to them, and with nothing tied there is no block at all.
  const none = pick({tied: true, query: 'tell me about the old days'});
  assert.deepEqual(none.diagnostics.selected, []);
  assert.equal(none.context, '');
  // V asks about the past: only the quests tied to this character come back (their faction in the words, the catalog listing them), not the rest.
  const past = pick({tied: true, query: 'what did you finish in the past?'});
  assert.deepEqual(past.diagnostics.selected.sort(), ['3', '4']);
  assert.doesNotMatch(past.context, /Pyramid Song|Current Quest/);
  // V's words bring one back for this turn, whoever it belongs to.
  assert.deepEqual(pick({tied: true, query: 'what about Pyramid Song?'}).diagnostics.selected, ['2']);
  // The place they stand in ties the tracked quest to them.
  assert.deepEqual(pick({tied: true, query: 'hello', place: placeWords({area: 'Embers'})}).diagnostics.selected, ['1']);
  // Their name in the quest's words ties it as well ("Dive with Judy.").
  assert.deepEqual(pick({tied: true, query: 'what did you finish in the past?', profileKey: 'judy-alvarez', questCatalog: {quests: []}}).diagnostics.selected, ['2']);
});

test('jobs: a side character is told only the jobs tied to them, and no block when there are none', () => {
  const lane2 = {status: 'complete', ageSeconds: 1, windowSeconds: 0.5, observed: 1, total: 1, omitted: 0, unstable: false};
  const open = (id, title, fields = {}) => ({id, nativeId: `n${id}`, title, state: 'active', lane: 'active', observedAtMs: 999000, objectivesComplete: true,
    questType: 'MinorQuest', objectives: [], ...fields});
  const parsed = parseJournalHistory({version: 1, status: 'ready', generation: 1, worldToken: 'world-a', capturedAtMs: 1_000_000,
    tracked: {status: 'known', questId: '1'}, coverage: {active: lane2, history: lane2}, quests: [open('1', 'Current Quest'), open('4', 'Heirloom')]});
  const base = {history: parsed, now: 1_000_000, profileKey: 'adam-giles', questCatalog: catalog};
  assert.match(availableQuestsContext(base), /Current Quest/);
  const tied = availableQuestsContext({...base, tied: true});
  assert.match(tied, /Heirloom/);
  assert.doesNotMatch(tied, /Current Quest/);
  assert.equal(availableQuestsContext({...base, tied: true, profileKey: 'someone-else'}), '', 'no tied job, no block');
});

test('withConversationKnowledge applies the type: a stranger gets no history and no jobs, a side character the tied ones, a story character all of them', () => {
  const raw = key => ({requestId: '1-1-1ULL', profileKey: key, text: 'hey', journal: journal('Heirloom', 'Find the family heirloom.'), journalHistory: snapshot});
  const run = key => withConversationKnowledge(raw(key), {generation: 1, worldToken: 'world-a', questCatalog: catalog, now: 1_000_000});
  const symbols = value => Object.getOwnPropertySymbols(value).map(symbol => value[symbol]).find(item => item && 'historyContext' in item);
  const story = symbols(run('judy-alvarez')), side = symbols(run('adam-giles')), stranger = symbols(run('npc-maelstrom-male'));
  assert.equal(side.trackedTied, true, 'the catalog lists Adam in the tracked quest');
  assert.equal(story.trackedTied, false);
  assert.equal(stranger.historyContext, '');
  assert.equal(stranger.jobsContext, '');
  assert.ok(story.historyContext.length > 0);
  assert.ok(!side.historyContext.includes('Current Quest'));
});

test('cost: the type, the line and the tie words are worked out once, and the registry is filled once at the bridge start', () => {
  setCharacterRoster(roster);
  const started = process.hrtime.bigint();
  for (let i = 0; i < 20000; i++) { characterTypeOf('adam-giles'); typeLine('adam-giles'); tieWords('adam-giles'); }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 150, `${ms} ms for 20000 turns of lookups`);
  setCharacterRoster(ROWS);
  const bridge = text('./convai-bridge.mjs');
  assert.match(bridge, /^setCharacterRoster\(roster\);$/m);
  assert.equal([...bridge.matchAll(/setCharacterRoster\(/g)].length, 1);
  // Nothing about it runs per frame or on a timer.
  const module = text('./character-type.mjs');
  assert.doesNotMatch(module, /setInterval|setTimeout|readFileSync|readFile\(/);
});
