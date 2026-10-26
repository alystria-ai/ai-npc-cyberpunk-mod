import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseJournalHistory} from './journal-history.mjs';
import {conversationContext, conversationContextBlocks, withConversationKnowledge} from './quest-context.mjs';
import {briefingNote, briefingRequested, questBriefingContext, selectBriefing, stageOf} from './quest-briefing.mjs';
import {QUEST_BRIEFINGS} from './quest-briefing-data.mjs';
import {JOURNAL_QUEST_TYPES} from './journal-quest-types.mjs';
import {dynamicInfo} from './dynamic-info.mjs';
import {validateBriefings} from '../research/cyberpunk/scripts/quest_briefing_schema.mjs';

const read = relative => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));

// ---- The screen -------------------------------------------------------------------------------------------------------------------------------

test('the screen lets the real questions through in all 15 menu languages and stays quiet on plain small talk', () => {
  const phrases = read('./quest-briefing-phrases.json');
  assert.deepEqual(Object.keys(phrases), ['en', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'ru', 'uk', 'tr', 'cs', 'hu', 'ja', 'ko', 'zh']);
  let asked = 0, caught = 0, plain = 0, quiet = 0;
  for (const [language, set] of Object.entries(phrases)) {
    const missed = set.positive.filter(text => !briefingRequested(text));
    assert.ok(set.positive.length >= 60, language);
    assert.ok(missed.length / set.positive.length <= 0.03, `${language} misses ${JSON.stringify(missed)}`);
    const loud = set.statements.filter(text => briefingRequested(text));
    // A statement with no question in it should mostly pass unseen; the rest only costs a lookup (the next gate is the job itself).
    assert.ok(loud.length / set.statements.length <= 0.3, `${language} lets through ${JSON.stringify(loud)}`);
    asked += set.positive.length; caught += set.positive.length - missed.length;
    plain += set.statements.length; quiet += set.statements.length - loud.length;
  }
  assert.ok(caught / asked >= 0.995, `recall ${caught}/${asked}`);
  assert.ok(quiet / plain >= 0.88, `quiet ${quiet}/${plain}`);
});

test('the screen: hand-written examples, edge values and size limit', () => {
  for (const text of ['tell me about the job', 'What do I need to do next?', 'walk me through the gig', 'i need the rundown', 'Was ist der Auftrag?',
    'Quelle est la suite ?', 'Что мне делать дальше', '次は何をすればいい', '下一步该怎么做', '다음 단계가 뭐야', 'where do I go']) {
    assert.equal(briefingRequested(text), true, text);
  }
  for (const text of ['Nice jacket.', 'See you later, choom.', 'Thanks for the drink.', 'Hello there.', '', '   ', 'ありがとう', '谢谢你', 'Bis später.']) {
    assert.equal(briefingRequested(text), false, text);
  }
  assert.equal(briefingRequested(undefined), false);
  assert.equal(briefingRequested(42), false);
  assert.equal(briefingRequested('what ' + 'x'.repeat(5000)), false, 'an oversized text is never screened');
  assert.equal(briefingRequested("What’s next?"), true, 'a typographic apostrophe is the same as a plain one');
});

// ---- The dataset ------------------------------------------------------------------------------------------------------------------------------

test('the built data module is the reviewed source, and the source passes its schema', () => {
  const source = read('../research/cyberpunk/quest-briefings.json');
  const report = validateBriefings(source, {questPaths: new Set(Object.keys(JOURNAL_QUEST_TYPES))});
  assert.deepEqual(report.errors, []);
  assert.deepEqual(Object.keys(QUEST_BRIEFINGS), Object.keys(source.quests).sort());
  for (const [path, quest] of Object.entries(source.quests)) {
    const {sources, ...runtime} = quest;
    assert.deepEqual(QUEST_BRIEFINGS[path], runtime, path);
    assert.ok(sources.every(id => Object.hasOwn(source.sources, id)), `${path} cites a source that is listed`);
  }
  assert.ok(Object.keys(QUEST_BRIEFINGS).length >= 20, 'the pilot covers about twenty quests');
  assert.throws(() => { QUEST_BRIEFINGS['x'] = {}; }, TypeError, 'the table is frozen');
});

test('every briefing renders a short note for every stage, with no later stage in it', () => {
  for (const [path, quest] of Object.entries(QUEST_BRIEFINGS)) {
    quest.stages.forEach((stage, index) => {
      const note = briefingNote({path, quest, stage, giver: true});
      assert.ok(note.length > 300 && note.length <= 1500, `${path} stage ${stage.id}: ${note.length} characters`);
      assert.ok(note.includes(stage.now) && note.includes(stage.ahead), `${path} ${stage.id}`);
      assert.doesNotMatch(note, /[<>{}\[\]`]/, 'no markup in a note');
      for (const later of quest.stages.slice(index + 1)) {
        assert.ok(!note.includes(later.now) && !note.includes(later.ahead), `${path} ${stage.id} carries the text of ${later.id}`);
      }
    });
  }
});

// ---- Choosing the quest and the stage ---------------------------------------------------------------------------------------------------------

const NOW = 1_000_000;
const lane = {status: 'complete', ageSeconds: 1, windowSeconds: 0.5, observed: 1, omitted: 0, unstable: false};
let counter = 100;
const objective = (quest, rel, state = 'active', fields = {}) => ({id: String(++counter), nativeId: rel.split('/').at(-1), questRelativePath: [quest, ...rel.split('/')],
  text: `Objective ${rel}`, state, observedAtMs: NOW - 500, ...fields});
const row = (id, nativePath, objectives, fields = {}) => {
  const nativeId = nativePath.split('/').at(-1);
  return {id, nativeId, nativePath, title: `Quest ${nativeId}`, state: 'active', lane: 'active', observedAtMs: NOW - 1000, objectivesComplete: true,
    objectives: objectives.map(([rel, state, extra]) => objective(nativeId, rel, state, extra)), ...fields};
};
const inventory = (quests, fields = {}) => parseJournalHistory({version: 1, status: 'ready', generation: 1, worldToken: 'world-a', capturedAtMs: NOW,
  tracked: {status: 'known', questId: '1'}, coverage: {active: lane, history: lane}, quests, ...fields});

const stage = (id, objectives, extra = {}) => ({id, objectives, now: `now ${id}`, ahead: `ahead ${id}`, places: [`place ${id}`], people: [`person ${id}`], tips: [`tip ${id}`], ...extra});
const DATA = Object.freeze({
  'quests/street_stories/test/gig_alpha': {title: 'Gig: Alpha Run', givers: ['regina-jones'], knowers: ['jackie-welles'], overview: 'Regina wants a crate moved.',
    spoiler: 'none', persistent: ['alpha/main'], stages: [stage('s0', ['alpha/go']), stage('s1', ['alpha/take', 'alpha/hack']), stage('s2', ['alpha/leave'])]},
  'quests/street_stories/test/gig_beta': {title: 'Gig: Beta Drop', givers: ['regina-jones'], knowers: [], overview: 'Regina wants a drop made.',
    spoiler: 'none', stages: [stage('b0', ['beta/go']), stage('b1', ['beta/drop'])]},
  'quests/side_quest/test/gig_gamma': {title: 'Gamma', givers: ['wakako-okada'], knowers: [], overview: 'Wakako wants a favour.', spoiler: 'none',
    stages: [stage('g0', ['gamma/go'])]},
});
const pick = (quests, options = {}) => selectBriefing({text: 'what is next?', profileKey: 'regina-jones', history: inventory(quests), age: 1, now: NOW, data: DATA, ...options});
const ALPHA = 'quests/street_stories/test/gig_alpha', BETA = 'quests/street_stories/test/gig_beta', GAMMA = 'quests/side_quest/test/gig_gamma';

test('the stage is the one whose objectives are active, the furthest when several are, and never one V has not reached', () => {
  const first = pick([row('1', ALPHA, [['alpha/main', 'active'], ['alpha/go', 'active']])]);
  assert.equal(first.stage.id, 's0');
  const both = pick([row('1', ALPHA, [['alpha/main', 'active'], ['alpha/go', 'active'], ['alpha/take', 'active']])]);
  assert.equal(both.stage.id, 's1', 'two active: the furthest stage');
  const finished = pick([row('1', ALPHA, [['alpha/go', 'succeeded'], ['alpha/take', 'succeeded']])]);
  assert.equal(finished.stage, null, 'no active objective: no stage is claimed');
  // The objective of the last stage exists in the journal only once revealed; a succeeded one is not "where V is".
  const behind = pick([row('1', ALPHA, [['alpha/go', 'active'], ['alpha/leave', 'succeeded']])]);
  assert.equal(behind.stage.id, 's0', 'a later stage whose objective is not active is never chosen');
  const optional = pick([row('1', ALPHA, [['alpha/go', 'active'], ['alpha/hack', 'active', {optional: true}]])]);
  assert.equal(optional.stage.id, 's0', 'an optional objective does not move V on');
  const tracked = pick([row('1', ALPHA, [['alpha/go', 'active'], ['alpha/take', 'active']])], {history: inventory([row('1', ALPHA, [['alpha/go', 'active'], ['alpha/take', 'active']])],
    {tracked: {status: 'known', questId: '1', objectiveId: '101'}})});
  assert.ok(['s0', 's1'].includes(tracked.stage.id));
});

test('the tracked objective decides the stage when it is one of the active ones; persistent objectives say nothing', () => {
  const rows = [row('1', ALPHA, [['alpha/main', 'active'], ['alpha/go', 'active'], ['alpha/take', 'active']])];
  const goId = rows[0].objectives.find(item => item.nativeId === 'go').id;
  const history = inventory(rows, {tracked: {status: 'known', questId: '1', objectiveId: goId}});
  assert.equal(selectBriefing({text: 'next?', profileKey: 'regina-jones', history, age: 1, now: NOW, data: DATA}).stage.id, 's0');
  const onlyMain = pick([row('1', ALPHA, [['alpha/main', 'active']])]);
  assert.equal(onlyMain.stage, null, 'a persistent objective alone gives no stage');
  assert.equal(stageOf(DATA[ALPHA], rows[0], undefined), 1);
});

test('an objective the dataset does not know gives the job itself and no invented step', () => {
  const selection = pick([row('1', ALPHA, [['alpha/new_in_a_patch', 'active']])]);
  assert.equal(selection.stage, null);
  const note = briefingNote(selection);
  assert.match(note, /Regina wants a crate moved/);
  assert.match(note, /do not invent steps/);
  assert.doesNotMatch(note, /ahead s\d|now s\d/);
});

test('only an active, fresh job that this speaker gave or knows is briefed', () => {
  const live = [row('1', ALPHA, [['alpha/go', 'active']])];
  assert.ok(pick(live));
  assert.equal(pick(live, {profileKey: 'judy-alvarez'}), null, 'someone who neither gave nor knows it');
  assert.equal(pick(live, {profileKey: 'wakako-okada'}), null);
  assert.equal(pick(live, {profileKey: 'jackie-welles'}).giver, false, 'a knower is briefed too, as someone who is part of it');
  assert.equal(pick([row('1', ALPHA, [['alpha/go', 'succeeded']], {state: 'succeeded', lane: 'history'})]), null, 'a finished job is no briefing');
  assert.equal(pick([row('1', ALPHA, [['alpha/go', 'active']], {state: 'failed'})]), null);
  assert.equal(pick([row('1', ALPHA, [['alpha/go', 'active']], {observedAtMs: NOW - 60_000})], {now: NOW}), null, 'an old observation is not trusted');
  assert.equal(pick([row('1', 'quests/side_quest/unknown_quest', [['x/y', 'active']])]), null, 'a quest with no briefing');
  assert.equal(selectBriefing({text: 'next?', profileKey: 'regina-jones', history: {status: 'unavailable'}, data: DATA}), null);
  assert.equal(selectBriefing({text: 'next?', profileKey: 7, history: inventory(live), data: DATA}), null);
});

test('with several jobs: the one V names, then the tracked one, then one the speaker gave, then the newest', () => {
  const alpha = row('1', ALPHA, [['alpha/go', 'active']], {observedAtMs: NOW - 3000});
  const beta = row('2', BETA, [['beta/go', 'active']], {observedAtMs: NOW - 2000});
  const named = pick([alpha, beta], {text: 'tell me about the beta drop'});
  assert.equal(named.path, BETA);
  const trackedAlpha = selectBriefing({text: 'what next?', profileKey: 'regina-jones', history: inventory([alpha, beta], {tracked: {status: 'known', questId: '1'}}), age: 1, now: NOW, data: DATA});
  assert.equal(trackedAlpha.path, ALPHA);
  const newest = selectBriefing({text: 'what next?', profileKey: 'regina-jones', history: inventory([alpha, beta], {tracked: {status: 'untracked'}}), age: 1, now: NOW, data: DATA});
  assert.equal(newest.path, BETA, 'ties go to the job that changed last');
  const gaveOverKnew = selectBriefing({text: 'what next?', profileKey: 'jackie-welles', history: inventory([alpha, row('3', GAMMA, [['gamma/go', 'active']])], {tracked: {status: 'untracked'}}), age: 1, now: NOW, data: DATA});
  assert.equal(gaveOverKnew.path, ALPHA, 'only the jobs this speaker has a part in count');
});

test('a quest is found by its own id when an older collector reports no path', () => {
  const noPath = row('1', ALPHA, [['alpha/take', 'active']]);
  delete noPath.nativePath;
  assert.equal(pick([noPath]).stage.id, 's1');
});

// ---- The note ---------------------------------------------------------------------------------------------------------------------------------

test('the note carries the job, where V is, what comes next, places, people and tips, and nothing from other stages', () => {
  const selection = pick([row('1', ALPHA, [['alpha/take', 'active']])]);
  const note = briefingNote(selection);
  assert.match(note, /^Job briefing for this reply only/);
  assert.match(note, /a job you gave V/);
  for (const piece of ['Regina wants a crate moved.', 'now s1', 'ahead s1', 'place s1', 'person s1', 'tip s1']) assert.ok(note.includes(piece), piece);
  for (const other of ['now s0', 'ahead s0', 'now s2', 'ahead s2', 'tip s2']) assert.ok(!note.includes(other), other);
  assert.match(note, /Do not add later steps, twists, outcomes, rewards/);
  assert.match(note, /If V is talking about something else, ignore these notes/);
  assert.match(briefingNote(pick([row('1', ALPHA, [['alpha/take', 'active']])], {profileKey: 'jackie-welles'})), /part of it/);
  assert.equal(briefingNote(null), '');
  assert.equal(briefingNote({quest: {overview: ''}}), '');
});

test('questBriefingContext screens first: a statement gets nothing, a question about the job gets the note', () => {
  const history = inventory([row('1', ALPHA, [['alpha/go', 'active']])]);
  const ask = text => questBriefingContext({text, profileKey: 'regina-jones', history, age: 1, now: NOW, data: DATA});
  assert.match(ask('What am I supposed to do now?'), /now s0/);
  assert.equal(ask('Nice jacket.'), '');
  assert.equal(ask(undefined), '');
});

// ---- The turn --------------------------------------------------------------------------------------------------------------------------------

const REAL = 'quests/street_stories/watson/northside_industrial_district/sts_wat_nid_01';
const turnInput = (text, fields = {}) => ({profileKey: 'regina-jones', text, requestId: 'r1', id: 'e1', entity: 'e1', name: 'Regina', channel: 'private',
  journalHistory: inventory([row('1', REAL, [['sts_wat_nid_01/main', 'active'], ['sts_wat_nid_01/find', 'active']])]), ...fields});
const turn = (input, off) => {
  const before = dynamicInfo.off;
  dynamicInfo.off = off ?? before;
  try {
    const attached = withConversationKnowledge(input, {generation: 1, worldToken: 'world-a', now: NOW});
    return {attached, text: conversationContext(attached), blocks: conversationContextBlocks(attached)};
  } finally { dynamicInfo.off = before; }
};

test('in a real turn: the briefing of the real gig, at the stage the journal shows, as a volatile block', () => {
  const quest = QUEST_BRIEFINGS[REAL];
  assert.ok(quest, 'the pilot covers Occupational Hazard');
  const stageNow = quest.stages.find(item => item.objectives.includes('sts_wat_nid_01/find'));
  const result = turn(turnInput('what do I do next?'));
  assert.ok(result.text.includes(stageNow.now) && result.text.includes(stageNow.ahead));
  const block = result.blocks.find(item => item.text.startsWith('Job briefing for this reply only'));
  assert.equal(block.tier, 'volatile', 'a prefix cache keeps its stable blocks');
  for (const later of quest.stages.slice(quest.stages.indexOf(stageNow) + 1)) assert.ok(!result.text.includes(later.ahead), later.id);
  // The note comes with the rest of the quest context, not instead of it.
  assert.match(result.text, /Current save journal|open jobs|journal history/i);
});

test('in a real turn: no note for other words, other speakers, ordinary NPCs, automatic reactions, a stale inventory or the switch off', () => {
  const marker = /Job briefing for this reply only/;
  assert.match(turn(turnInput('how do I get started?')).text, marker);
  assert.doesNotMatch(turn(turnInput('Thanks, see you later.')).text, marker, 'not a question about the job');
  assert.doesNotMatch(turn(turnInput('what do I do next?', {profileKey: 'judy-alvarez'})).text, marker, 'not her job');
  assert.doesNotMatch(turn(turnInput('what do I do next?', {profileKey: 'resident-male'})).text, marker, 'an ordinary NPC knows nothing of V\'s jobs');
  assert.doesNotMatch(turn(turnInput('what do I do next?', {reaction: {kind: 'battle'}})).text, marker, 'a bark answers no question');
  assert.doesNotMatch(turn(turnInput('what do I do next?', {journalHistory: undefined})).text, marker, 'no inventory, no briefing');
  const stale = withConversationKnowledge(turnInput('what do I do next?'), {generation: 1, worldToken: 'world-a', now: NOW + 60_000});
  assert.doesNotMatch(conversationContext(stale), marker, 'an inventory older than its lease');
  assert.doesNotMatch(turn(turnInput('what do I do next?'), Object.freeze(new Set(['quest']))).text, marker, 'Settings > Dynamic info > Quest and journal off');
  assert.match(turn(turnInput('what do I do next?'), Object.freeze(new Set(['gear', 'time']))).text, marker, 'other switches do not matter');
});

test('the text from a turn is the same on every path: the blocks are joined for Convai and laid out by tier for the text providers', () => {
  const {blocks, text} = turn(turnInput('what is the plan?'));
  const note = blocks.filter(item => /^Job briefing for this reply only/.test(item.text));
  assert.equal(note.length, 1);
  assert.ok(text.includes(note[0].text));
  assert.equal(blocks.filter(item => item.tier === 'volatile' && item.text === note[0].text).length, 1, 'tier volatile: the Mistral, Local AI and Custom layouts read it');
});
