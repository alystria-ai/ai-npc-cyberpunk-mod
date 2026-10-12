import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {classifyDecisions, PERFORMANCE} from './knowledge-decisions.mjs';
import {branchDecisions, resolveKnowledge, CHOICE_SHARE} from './world-knowledge.mjs';

// docs/QUEST_DECISIONS.md, step 1: rules that record a branch decision are flagged at pack load, told first under "choices" with a
// reserved share of the budget, and a statement is never told twice.
const link = (decisionId, outcomeKey) => ({decisionId, outcomeKey});
const row = (id, fields = {}) => ({id, topic: `topic.${id}`, outcome: id, statement: 'Something happened at the garage.',
  narrativeLinks: [], condition: {type: 'fact', key: 'f', op: 'eq', value: 1}, ...fields});

test('two or more outcomes of one decision point, topic or exclusive group are a branch', () => {
  const rules = [row('a', {narrativeLinks: [link('gig.fate', 'killed')]}), row('b', {narrativeLinks: [link('gig.fate', 'spared')]}),
    row('c', {topic: 'shared.topic', outcome: 'x'}), row('d', {topic: 'shared.topic', outcome: 'y'}),
    row('e', {exclusiveGroups: [{id: 'route', outcome: 'north'}]}), row('f', {exclusiveGroups: [{id: 'route', outcome: 'south'}]}),
    row('lonely', {narrativeLinks: [link('gig.only', 'done')]})];
  const found = classifyDecisions(rules);
  for (const id of 'abcdef') assert.equal(found.get(id), 'alternatives', id);
  assert.equal(found.has('lonely'), false);
});

test('a result of play (detected or not, won or lost, a count of deaths) is never a branch decision', () => {
  assert.ok(['detected', 'undetected', 'victory', 'defeat', 'all-alive', 'some-deaths'].every(key => PERFORMANCE.includes(key)));
  const rules = [row('seen', {narrativeLinks: [link('gig.stealth', 'detected')], statement: 'V was detected in the bar.'}),
    row('unseen', {narrativeLinks: [link('gig.stealth', 'undetected')], statement: 'V accepted the quiet route and stayed hidden.'}),
    row('won', {narrativeLinks: [link('ring.final', 'victory')]}), row('lost', {narrativeLinks: [link('ring.final', 'defeat')]})];
  assert.equal(classifyDecisions(rules).size, 0);
});

test('V doing a deliberate thing is a branch even when no sibling outcome has a rule; a plain beat or a reported act is not', () => {
  const found = classifyDecisions([
    row('offer', {statement: 'V accepted Dex\'s offer of a forty percent cut.'}),
    row('spared', {statement: 'After the chase V spared Sampson.'}),
    row('together', {statement: 'V and Takemura began cooperating after the diner talk.'}),
    row('beat', {statement: 'V completed the job and reached the garage.'}),
    row('reported', {statement: 'Hands messaged V that V accepted nothing and left.'}),
    row('npc', {statement: 'Rachel refused to speak to V after the show.'})]);
  assert.deepEqual([...found].sort(), [['offer', 'statement'], ['spared', 'statement'], ['together', 'statement']]);
});

test('a phone reply V picked is a branch, recognised from the journal entry class in its condition', () => {
  const journals = new Map([['reply-yes', {nativeClass: 'gameJournalPhoneChoiceEntry'}], ['talk', {nativeClass: 'gameJournalQuestObjective'}]]);
  const found = classifyDecisions([
    row('yes', {condition: {all: [{type: 'journal', key: 'reply-yes', op: 'eq', value: 'succeeded'}]}, statement: 'Jim invited V to race.'}),
    row('talk', {condition: {type: 'journal', key: 'talk', op: 'eq', value: 'succeeded'}, statement: 'Jim invited V to race.'})], journals);
  assert.deepEqual([...found], [['yes', 'phone-reply']]);
});

test('the flag is deterministic: the same rules in any order give the same answer', () => {
  const pack = JSON.parse(readFileSync(new URL('../characters/world-knowledge.json', import.meta.url), 'utf8'));
  const rules = pack.rules.filter(rule => /verified$/.test(rule.status)), journals = new Map(Object.entries(pack.journalAllowlist));
  const first = classifyDecisions(rules, journals);
  const second = classifyDecisions([...rules].reverse(), journals);
  assert.deepEqual([...first].sort(), [...second].sort());
});

test('the reviewed pack: choices are flagged, results of play and plain events are not', () => {
  const pack = JSON.parse(readFileSync(new URL('../characters/world-knowledge.json', import.meta.url), 'utf8'));
  const flagged = branchDecisions(pack);
  const executable = pack.rules.filter(rule => /verified$/.test(rule.status)).length;
  // The old test (two or more outcomes of a decision point) flagged 392 of 768; this one adds V's single-outcome acts and
  // phone replies and drops performance results. Pinned loosely so that reviewed rows added later do not break it.
  assert.ok(flagged.size > 400 && flagged.size < executable * 0.75, `${flagged.size} of ${executable}`);
  for (const id of ['jt.takemura-fate.rescued', 'jt.takemura-fate.left-behind', 'jt.oda-fate.killed', 'jt.takemura-alliance.agreed',
    'jr-native.pisces-maiko-killed', 'cc5.jim.invite-declined']) assert.ok(flagged.has(id), id);
  for (const id of ['fo5.breaking-news.seen', 'fo5.karubo.alarm', 'heywood.boxing.final.victory', 'heywood.boxing.final.defeat',
    'jt.oda-refusal.refused']) assert.equal(flagged.has(id), false, id);
  assert.equal(flagged.get('cc5.jim.invite-declined'), 'phone-reply');
  assert.equal(flagged.get('jt.takemura-fate.rescued'), 'alternatives');
  assert.equal(flagged.get('jt.oda-fate.killed'), 'statement');
});

// A small pack for the resolver: `events` plain beats and `choices` acts, every statement distinct and of similar length.
const observation = (value, fields = {}) => ({status: 'known', value, sourceId: 'native-capture', evidenceRefs: ['capture:1:o'], ...fields});
function rule(id, statement, fields = {}) {
  return {id, revision: 1, questKey: 'the-quest', topic: `topic.${id}`, outcome: id, status: 'source-verified', reviewed: true,
    gameVersions: ['2.31'], category: 'decision', priority: 5, stable: true, statement, sourceIds: ['story-source'],
    evidenceRefs: ['native-branch'], audience: {speakers: ['johnny-silverhand'], perspective: 'participant', channels: ['private'],
      recipients: ['v', 'johnny-silverhand']}, condition: {type: 'fact', key: 'f', op: 'eq', value: 1}, ...fields};
}
const pad = number => String(number).padStart(3, '0');
function pack({events = 0, choices = 0, extra = []} = {}) {
  const rules = [
    ...Array.from({length: events}, (_, i) => rule(`event-${pad(i)}`, `Event ${pad(i)}: V and Johnny reached the garage and found a note about the shipment number ${pad(i)} left on the bench.`,
      {category: 'world', priority: 10})),
    ...Array.from({length: choices}, (_, i) => rule(`choice-${pad(i)}`, `Choice ${pad(i)}: V accepted offer number ${pad(i)} from the fixer and agreed to keep it secret.`)), ...extra];
  return {version: 1, id: 'test-world', revision: 1, gameVersions: ['2.31'], profileKeys: ['johnny-silverhand', 'judy-alvarez'],
    sources: [{id: 'native-source', kind: 'native', locator: 'base/quest/example.quest'},
      {id: 'story-source', kind: 'community', url: 'https://example.org/inspected-story'}],
    evidence: [{id: 'native-branch', kind: 'native', sourceId: 'native-source', locator: 'branch 1', gameVersions: ['2.31']}],
    factAllowlist: {f: {evidenceRefs: ['native-branch']}}, journalAllowlist: {}, rules};
}
const snapshot = () => ({version: 1, status: 'ready', gameVersion: '2.31', generation: 1, capturedAt: '2026-10-13T12:00:00.000Z',
  identity: {status: 'unknown'}, audience: {channel: 'private', profileKeys: ['johnny-silverhand']}, activeQuestKeys: [],
  facts: {f: observation(1, {present: true})}, journal: {}, lifepath: observation('nomad')});
const resolve = (fields = {}, maxChars = 8000) => resolveKnowledge({pack: pack(fields), snapshot: snapshot(), profileKey: 'johnny-silverhand', maxChars});
const entries = result => { const data = JSON.parse(result.context.slice(result.context.indexOf('\n') + 1)); return {choices: data.choices ?? [], facts: data.facts}; };

test('choices come first under their own heading, before the other facts', () => {
  const result = resolve({events: 3, choices: 3});
  const {choices, facts} = entries(result);
  assert.equal(choices.length, 3); assert.equal(facts.length, 3);
  assert.ok(choices.every(item => /^Choice/.test(item.text)) && facts.every(item => /^Event/.test(item.text)));
  assert.ok(result.context.indexOf('"choices"') < result.context.indexOf('"facts"'));
  assert.match(result.context.split('\n')[0], /Under "choices" are decisions V made/);
  assert.equal(result.context.split('\n').length, 2, 'the JSON stays on the second line');
  assert.deepEqual(result.diagnostics.decisions, {true: 3, selected: 3, dropped: 0, duplicates: 0});
});

test('with no decision there is no heading and the context is exactly the old shape', () => {
  const result = resolve({events: 3});
  assert.doesNotMatch(result.context, /"choices"|Under "choices"/);
  assert.deepEqual(entries(result).facts.map(item => item.text.slice(0, 7)), ['Event 0', 'Event 0', 'Event 0']);
  assert.equal(result.diagnostics.decisions.true, 0);
});

test('a decision outranks events that outrank it on every other measure when the budget runs out', () => {
  const extra = [rule('active-event', 'The active quest event: V and Johnny stood in the garage while the rain came down all night long.',
    {category: 'relationship', priority: 10, questKey: 'active-quest'})];
  const rules = pack({events: 40, choices: 1, extra});
  rules.rules.find(item => item.id === 'choice-000').priority = 0;
  const live = {...snapshot(), activeQuestKeys: ['active-quest']};
  const result = resolveKnowledge({pack: rules, snapshot: live, profileKey: 'johnny-silverhand', maxChars: 1500});
  const {choices, facts} = entries(result);
  assert.equal(choices.length, 1);
  assert.ok(facts.length > 0);
  assert.ok(result.diagnostics.counts.omitted > 0, 'events were dropped');
  assert.ok(result.context.length <= 1500);
});

test('decisions may claim most of the budget when events and decisions both overflow, and the other facts keep the rest', () => {
  const budget = 8000, room = budget - resolve({}).context.length, result = resolve({events: 80, choices: 80}, budget);
  const {choices, facts} = entries(result);
  const chars = items => items.reduce((sum, item) => sum + JSON.stringify(item).length + 1, 0);
  assert.ok(choices.length > 0 && facts.length > 0);
  assert.ok(chars(choices) <= CHOICE_SHARE * room, 'choices stay within their share while events remain');
  assert.ok(chars(choices) > CHOICE_SHARE * room - 400, `choices fill their share (${chars(choices)})`);
  assert.ok(CHOICE_SHARE >= 0.5 && CHOICE_SHARE < 1);
  assert.ok(facts.length >= 1, 'events keep the last twentieth');
  assert.ok(choices.length > facts.length * 5, 'decisions win');
  assert.ok(result.context.length <= budget && result.context.length > budget - 250);
  assert.equal(result.diagnostics.decisions.selected, choices.length);
  assert.equal(result.diagnostics.decisions.dropped, 80 - choices.length);
});

test('room the events leave unused goes back to decisions, and room the decisions leave goes to events', () => {
  const fewEvents = resolve({events: 1, choices: 80}, 4000), {choices, facts} = entries(fewEvents);
  assert.equal(facts.length, 1, 'the one event has its floor');
  assert.ok(choices.length > 12 && fewEvents.context.length > 4000 - 250, `${choices.length} choices`);
  const fewChoices = resolve({events: 80, choices: 2}, 4000), second = entries(fewChoices);
  assert.equal(second.choices.length, 2);
  assert.ok(second.facts.length > 10 && fewChoices.context.length > 4000 - 250);
  const wide = entries(resolve({events: 80, choices: 80}, 12000));
  assert.ok(wide.facts.length >= 2, 'a larger budget leaves the other facts a larger share');
});

test('the same statement is told once, and the first-ranked rule wins', () => {
  const same = 'V accepted the fixer\'s offer of a forty percent cut.';
  const extra = [rule('copy-1', same, {priority: 9}), rule('copy-2', `${same.replace('forty percent', 'FORTY  PERCENT')} `, {priority: 8, topic: 'topic.other'}),
    rule('copy-3', same, {priority: 7, topic: 'topic.third'})];
  const result = resolve({events: 1, extra});
  const told = [...entries(result).choices, ...entries(result).facts].filter(item => /forty percent/i.test(item.text));
  assert.equal(told.length, 1);
  assert.equal(told[0].topic, 'topic.copy-1');
  assert.deepEqual(result.diagnostics.rules.filter(item => item.status === 'duplicate-statement').map(item => item.ruleId).sort(), ['copy-2', 'copy-3']);
  assert.equal(result.diagnostics.decisions.duplicates, 2);
  // Case and spacing do not make a statement new, for events either.
  const events = [rule('note-1', 'The shipment note was left on the bench.', {category: 'world'}),
    rule('note-2', 'THE SHIPMENT  NOTE was left on the bench. ', {category: 'world', priority: 4})];
  const noted = entries(resolve({extra: events})).facts;
  assert.deepEqual(noted.map(item => item.topic), ['topic.note-1']);
  assert.equal(result.diagnostics.counts.selected, 2);
});

test('the character budget is exact: the context always fits and the arithmetic matches the rendered text', () => {
  const full = resolve({events: 12, choices: 12}, 12000);
  assert.equal(entries(full).choices.length + entries(full).facts.length, 24);
  for (const maxChars of [full.context.length, full.context.length - 1, 5000, 3000, 2000, 1200, 900]) {
    const bounded = resolve({events: 12, choices: 12}, maxChars);
    assert.ok(bounded.context.length <= maxChars, `${bounded.context.length} <= ${maxChars}`);
    const parts = entries(bounded);
    assert.equal(bounded.diagnostics.counts.selected, parts.choices.length + parts.facts.length);
    assert.equal(bounded.diagnostics.contextChars, bounded.context.length);
  }
  assert.equal(resolve({events: 12, choices: 12}, full.context.length).diagnostics.counts.omitted, 0);
  assert.ok(resolve({events: 12, choices: 12}, full.context.length - 1).diagnostics.counts.omitted >= 1);
});

test('events recorded for memory keep the order the context tells them in', () => {
  const live = {...snapshot(), identity: {status: 'verified', userId: 'u', playthroughId: 'p', branchId: 'b', checkpointId: 'c'}};
  const result = resolveKnowledge({pack: pack({events: 2, choices: 2}), snapshot: live, profileKey: 'johnny-silverhand', maxChars: 8000});
  assert.deepEqual(result.events.map(event => event.topic.slice(0, 12)), ['topic.choice', 'topic.choice', 'topic.event-', 'topic.event-']);
});
