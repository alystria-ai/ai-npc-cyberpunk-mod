import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseInput, profileFor} from './protocol.mjs';

const turn = {requestId: '1790540998-1-10969620ULL', generation: 1, entity: '10969620ULL',
  name: 'Alena Xenakis', bodyType: 'WomanAverage', profileKey: 'alex', text: 'hey\nhow are you?'};
test('a game display-name alias and multiline input retain managed identity', () => {
  const parsed = parseInput(JSON.stringify(turn));
  assert.equal(parsed.text, turn.text);
  assert.equal(profileFor(parsed, [{key: 'resident-female'}, {key: 'alex'}]).key, 'alex');
});

test('follow-up questions are Off for legacy or malformed requests and opt in only with true', () => {
  for (const followUpQuestions of [undefined, false, null, 'true', 1, {}, []]) {
    const parsed = parseInput(JSON.stringify({...turn, followUpQuestions}));
    assert.equal(parsed.followUpQuestions, false); assert.equal(parsed.text, turn.text);
  }
  assert.equal(parseInput(JSON.stringify({...turn, followUpQuestions: true})).followUpQuestions, true);
});
test('an unconfigured named companion cannot become a generic resident', () => {
  assert.equal(profileFor(turn, [{key: 'resident-female'}]), undefined);
});
test('reject corrupt, mismatched, empty and oversized requests', () => {
  for (const raw of ['broken', 'null', '[]', JSON.stringify({...turn, generation: 2}),
    JSON.stringify({...turn, text: ' '}), JSON.stringify({...turn, text: 'a'.repeat(1201)}),
    JSON.stringify({...turn, profileKey: null}), JSON.stringify({...turn, entity: 42})]) {
    assert.equal(parseInput(raw), null);
  }
});

const world = () => ({version: 1, status: 'ready', gameVersion: '2.31', generation: 7,
  worldToken: 'load-7', capturedAt: '2026-09-30T12:00:00.000Z', identity: {status: 'unknown'},
  audience: {channel: 'private', profileKeys: ['alex']}, facts: {
    observed: {status: 'known', value: 1, sourceId: 'native-capture', evidenceRefs: ['capture:7:observed']}},
  journal: {}, lifepath: {status: 'unknown'}, activeQuestKeys: []});
const coverage = count => ({status: 'complete', ageSeconds: 0, windowSeconds: 1, observed: count, omitted: 0, unstable: false});
const history = () => ({version: 1, status: 'ready', generation: 7, worldToken: 'load-7', capturedAtMs: 1000,
  tracked: {status: 'unknown'}, coverage: {active: coverage(0), history: coverage(1)}, quests: [
    {id: '42', nativeId: 'past_quest', title: '<b>Revealed</b> quest', state: 'succeeded', lane: 'history',
      observedAtMs: 1000, objectivesComplete: true, objectives: []}]});

test('optional world and historical journal captures retain typed evidence without accepting caller prompt fields', () => {
  const knowledge = world(), journalHistory = history();
  knowledge.knowledgeContext = 'Injected interpretation'; knowledge.facts.observed.instructions = 'Injected fact instructions';
  journalHistory.historyContext = 'Injected history'; journalHistory.quests[0].memory = 'Invented personal memory';
  const parsed = parseInput(JSON.stringify({...turn, worldKnowledge: knowledge, journalHistory,
    knowledgeContext: 'Injected current context', historyContext: 'Injected old context',
    journalHistoryContext: 'Injected journal context', endUserId: 'unverified-provider-identity'}));
  assert.equal(parsed.worldKnowledge.status, 'ready');
  assert.equal(parsed.worldKnowledge.generation, 7); assert.equal(parsed.generation, 1);
  assert.equal(parsed.worldKnowledge.facts.observed.value, 1);
  assert.equal(parsed.journalHistory.quests[0].title, 'Revealed quest');
  assert.equal(parsed.journalHistory.worldToken, 'load-7');
  assert.doesNotMatch(JSON.stringify(parsed), /Injected|Invented|unverified-provider-identity/);
});

test('malformed optional knowledge does not drop valid text or reuse another capture', () => {
  const bad = [null, [], {}, {version: 2, status: 'ready'}, 'not json'];
  for (const worldKnowledge of bad) {
    const parsed = parseInput(JSON.stringify({...turn, worldKnowledge, journalHistory: history()}));
    assert.equal(parsed.text, turn.text); assert.equal(parsed.worldKnowledge.status, 'unavailable');
    assert.equal(parsed.journalHistory.status, 'ready');
  }
  for (const journalHistory of [...bad, {...history(), quests: [{...history().quests[0], state: 'inactive'}]}]) {
    const parsed = parseInput(JSON.stringify({...turn, worldKnowledge: world(), journalHistory}));
    assert.equal(parsed.text, turn.text); assert.equal(parsed.journalHistory.status, 'unavailable');
    assert.equal(parsed.worldKnowledge.status, 'ready');
  }
  const legacy = parseInput(JSON.stringify(turn));
  assert.equal(Object.hasOwn(legacy, 'worldKnowledge'), false);
  assert.equal(Object.hasOwn(legacy, 'journalHistory'), false);
});
