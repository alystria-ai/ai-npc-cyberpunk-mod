import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseWorldSnapshot, resolveKnowledge} from './world-knowledge.mjs';
import {parseJournalHistory} from './journal-history.mjs';
import {conversationContext, withConversationKnowledge} from './quest-context.mjs';
import {availableQuestsContext, categoryOf, questPathsFromPack, questTypeOf, recentSharedContext,
  recentSharedEvents} from './quest-overview.mjs';
import {JOURNAL_QUEST_TYPES} from './journal-quest-types.mjs';

const DAY = 86400, NOW = 101 * DAY;
const observed = (value, fields = {}) => ({status: 'known', value, sourceId: 'native-capture',
  evidenceRefs: ['capture:1:observation'], ...fields});
const audience = (speakers, perspective = 'participant') => ({speakers, perspective, channels: ['private', 'phone', 'group'],
  recipients: speakers === 'all' ? 'all' : ['v', ...speakers]});
function rule(id, fields = {}) {
  return {id, revision: 1, questKey: 'pyramid-song', topic: `topic.${id}`, outcome: 'done', status: 'source-verified',
    reviewed: true, gameVersions: ['2.31'], category: 'quest', priority: 5, stable: true, statement: `Statement ${id}.`,
    sourceIds: ['story'], evidenceRefs: ['native'], audience: audience(['judy-alvarez']),
    condition: {type: 'journal', key: 'dive', op: 'eq', value: 'succeeded'}, ...fields};
}
const journalLeaf = key => ({type: 'journal', key, op: 'eq', value: 'succeeded'});
function pack(rules) {
  return {version: 1, id: 'overview-test', revision: 1, gameVersions: ['2.31'],
    profileKeys: ['judy-alvarez', 'river-ward', 'panam-palmer'],
    sources: [{id: 'native-source', kind: 'native', locator: 'quest graph'}, {id: 'story', kind: 'community', url: 'https://example.org/story'}],
    evidence: [{id: 'native', kind: 'native', sourceId: 'native-source', locator: 'node 1', gameVersions: ['2.31']}],
    factAllowlist: {date_done: {evidenceRefs: ['native']}},
    journalAllowlist: {
      dive: {questKey: 'pyramid-song', nativePath: 'quests/side_quest/sq030_judy_romance/dive/dive', nativeClass: 'gameJournalQuestObjective', evidenceRefs: ['native']},
      date: {questKey: 'i-really-want-to-stay-at-your-house', nativePath: 'quests/minor_quest/mq055_romance_apartment/judy/date', nativeClass: 'gameJournalQuestObjective', evidenceRefs: ['native']},
      song: {questKey: 'pyramid-song', nativePath: 'quests/side_quest/sq030_judy_romance', nativeClass: 'gameJournalQuest', evidenceRefs: ['native']}},
    rules};
}
const RULES = [
  rule('judy.dive', {statement: 'Judy and V completed the dive.'}),
  rule('judy.continue', {statement: 'V and Judy chose to continue.', audience: audience(['judy-alvarez'], 'private'),
    condition: {type: 'fact', key: 'date_done', op: 'eq', value: 1}}),
  rule('judy.date', {questKey: 'i-really-want-to-stay-at-your-house', statement: 'Judy completed an apartment visit with V.',
    condition: journalLeaf('date')}),
  rule('judy.journal-only', {statement: 'Public journal fact.', audience: audience('all', 'shared-journal')}),
  rule('panam.only', {statement: 'Panam event.', audience: audience(['panam-palmer'])}),
];
function world(fields = {}) {
  return {version: 1, status: 'ready', gameVersion: '2.31', generation: 1, worldToken: 'world-a',
    capturedAt: new Date(1_000_000).toISOString(), gameTimeSeconds: NOW, identity: {status: 'unknown'},
    audience: {channel: 'private', profileKeys: ['judy-alvarez']},
    facts: {date_done: observed(1, {present: true})},
    journal: {dive: observed('succeeded', {revealed: true, questKey: 'pyramid-song', gameTimeSeconds: 66 * DAY}),
      date: observed('succeeded', {revealed: true, questKey: 'i-really-want-to-stay-at-your-house', gameTimeSeconds: 73 * DAY}),
      song: observed('succeeded', {revealed: true, questKey: 'pyramid-song', gameTimeSeconds: 67 * DAY})},
    ...fields};
}
const lane = {status: 'complete', ageSeconds: 1, windowSeconds: 0.5, observed: 1, omitted: 0, unstable: false};
const objective = (id, text, state = 'active', fields = {}) => ({id, nativeId: `o${id}`, questRelativePath: ['q', `o${id}`],
  text, state, observedAtMs: 999_500, ...fields});
const quest = (id, title, fields = {}) => ({id, nativeId: 'q', title, state: 'active', lane: 'active', observedAtMs: 999_000,
  objectivesComplete: true, objectives: [], ...fields});
function history(quests, fields = {}) {
  return {version: 1, status: 'ready', generation: 1, worldToken: 'world-a', capturedAtMs: 1_000_000,
    tracked: {status: 'known', questId: '1'}, coverage: {active: lane, history: lane}, quests, ...fields};
}
const CATALOG = {quests: [
  {key: 'pyramid-song', title: 'Pyramid Song', nativeIds: [], characters: ['judy-alvarez']},
  {key: 'i-really-want-to-stay-at-your-house', title: 'I Really Want to Stay at Your House', nativeIds: [], characters: ['judy-alvarez', 'river-ward']},
  {key: 'nocturne-op55n1', title: 'Nocturne Op55N1', nativeIds: [], characters: ['judy-alvarez', 'panam-palmer', 'river-ward',
    'takemura', 'johnny-silverhand', 'hanako-arasaka']}]};
const INVENTORY = [
  quest('1', 'One Way or Another', {nativePath: 'ep1/quests/minor_quest/wst_ep1_09', questType: 'MinorQuest',
    objectives: [objective('11', 'Read the message from Nele Springer.')]}),
  quest('2', 'Nocturne Op55N1', {nativePath: 'quests/meta/02_sickness', objectives: [objective('21', 'Meet Hanako at Embers.')]}),
  quest('3', 'I Really Want to Stay at Your House', {nativePath: 'quests/minor_quest/mq055_romance_apartment', questType: 'MinorQuest',
    objectives: [objective('31', 'Read and reply to the message from Judy.', 'succeeded'), objective('32', 'Meet Judy at your Glen apartment.'),
      objective('33', 'Hidden branch text.', 'failed')]}),
  quest('4', 'Gig: Family Heirloom', {questType: 'StreetStory'}),
  quest('5', 'Reported Crime: Table Scraps', {questType: 'Contract'}),
  quest('6', 'Cyberpsycho Sighting: Bloody Ritual', {questType: 'CyberPsycho'}),
  quest('7', 'Pyramid Song', {state: 'succeeded', lane: 'history', nativePath: 'quests/side_quest/sq030_judy_romance',
    questType: 'SideQuest', gameTimeSeconds: 67 * DAY}),
];
const shared = (profileKey = 'judy-alvarez', snapshot = world({audience: {channel: 'private', profileKeys: [profileKey]}})) =>
  resolveKnowledge({pack: pack(RULES), snapshot, profileKey, maxChars: 8000}).shared;
const parsedHistory = (quests = INVENTORY, fields) => parseJournalHistory(history(quests, fields));

test('the resolver reports only events the speaker took part in, timed by the latest journal entry each rests on', () => {
  const events = shared();
  assert.deepEqual(events.map(event => event.ruleId).sort(), ['judy.continue', 'judy.date', 'judy.dive']);
  assert.equal(events.find(event => event.ruleId === 'judy.dive').gameTimeSeconds, 66 * DAY);
  assert.equal(events.find(event => event.ruleId === 'judy.continue').gameTimeSeconds, undefined, 'facts carry no time');
  assert.ok(!events.some(event => event.ruleId === 'judy.journal-only'), 'shared journal data is not taking part');
  assert.deepEqual(shared('river-ward'), []);
  // A malformed timestamp on one journal row is dropped; the snapshot stays usable.
  const parsed = parseWorldSnapshot(world({journal: {...world().journal,
    dive: observed('succeeded', {revealed: true, questKey: 'pyramid-song', gameTimeSeconds: -1})}}));
  assert.equal(parsed.status, 'ready'); assert.equal(parsed.journal.dive.gameTimeSeconds, undefined);
});

test('recent shared events are newest first with an honest timing source and a recency marker', () => {
  const result = recentSharedEvents({shared: shared(), worldSeconds: NOW, history: parsedHistory(),
    questPaths: questPathsFromPack(pack(RULES)), questCatalog: CATALOG});
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.events.map(event => event.text), ['Judy completed an apartment visit with V.',
    'V and Judy chose to continue.', 'Judy and V completed the dive.']);
  assert.deepEqual(result.events.map(event => event.timedBy), ['journal entry', 'quest completion (latest possible time)', 'journal entry']);
  assert.deepEqual(result.events.map(event => event.inGameDaysAgo), [28, 34, 35]);
  assert.ok(result.events.every(event => event.when === 'a while ago'));
  assert.equal(result.events[0].quest, 'I Really Want to Stay at Your House');
  const recent = recentSharedEvents({shared: [{ruleId: 'r', questKey: 'pyramid-song', text: 'Recent.', gameTimeSeconds: NOW - 3600}],
    worldSeconds: NOW});
  assert.equal(recent.events[0].when, 'recently'); assert.equal(recent.events[0].inGameDaysAgo, 0);
});

test('ties are marked, each quest contributes at most two events, and untimed or impossible times are left out', () => {
  const same = ['a', 'b', 'c'].map(id => ({ruleId: id, questKey: 'one', text: id, gameTimeSeconds: 10 * DAY}));
  const result = recentSharedEvents({shared: [...same, {ruleId: 'd', questKey: 'two', text: 'd', gameTimeSeconds: 9 * DAY},
    {ruleId: 'future', questKey: 'three', text: 'future', gameTimeSeconds: NOW + DAY},
    {ruleId: 'untimed', questKey: 'four', text: 'untimed'}], worldSeconds: NOW});
  assert.deepEqual(result.events.map(event => event.text), ['a', 'b', 'd']);
  assert.equal(result.events[1].sameMomentAsPrevious, true);
  assert.equal(result.untimed, 2);
  // A fact-only rule on a quest that is still running has no proven time.
  const running = recentSharedEvents({shared: [{ruleId: 'x', questKey: 'pyramid-song', text: 'x'}], worldSeconds: NOW,
    history: parsedHistory([{...INVENTORY[6], state: 'active', lane: 'active'}]), questPaths: questPathsFromPack(pack(RULES))});
  assert.equal(running.status, 'untimed');
});

test('without a proven order the section says so; with no shared event it forbids inventing one', () => {
  assert.match(recentSharedContext({shared: [{ruleId: 'x', questKey: 'q', text: 'x'}]}), /order is unknown/);
  assert.match(recentSharedContext({shared: []}), /do not invent one/);
  assert.equal(recentSharedContext({}), '');
  const text = recentSharedContext({shared: shared(), worldSeconds: NOW, history: parsedHistory(),
    questPaths: questPathsFromPack(pack(RULES)), questCatalog: CATALOG}, 800);
  assert.ok(text.length <= 800 && /newest first/.test(text));
  assert.equal(JSON.parse(text.slice(text.indexOf('\n') + 1)).events.length, 1, 'whole events only within the budget');
  // The game clock is optional: order survives, the recency marker does not.
  const untimedClock = recentSharedEvents({shared: shared(), history: parsedHistory(), questCatalog: CATALOG,
    questPaths: questPathsFromPack(pack(RULES))});
  assert.equal(untimedClock.events[0].when, undefined); assert.equal(untimedClock.events.length, 3);
});

test('quest categories are the game\'s own journal types, natively read or from the cooked journal', () => {
  assert.equal(questTypeOf({questType: 'SideQuest', nativePath: 'quests/meta/02_sickness'}), 'SideQuest', 'native reading wins');
  assert.equal(questTypeOf({nativePath: 'quests/meta/02_sickness'}), 'MainQuest');
  assert.equal(JOURNAL_QUEST_TYPES['ep1/quests/minor_quest/wst_ep1_09'], 'MinorQuest');
  assert.equal(JOURNAL_QUEST_TYPES['quests/side_quest/sq030_judy_romance'], 'SideQuest');
  assert.equal(questTypeOf({nativePath: 'quests/minor_quest/unknown'}), undefined);
  assert.deepEqual(['MainQuest', 'SideQuest', 'MinorQuest', 'StreetStory', 'Contract', 'CyberPsycho', undefined]
    .map(questType => categoryOf({questType})), ['mainJobs', 'sideJobs', 'sideJobs', 'gigs', 'ncpdScannerHustles', 'other', 'other']);
  assert.equal(Object.hasOwn(JOURNAL_QUEST_TYPES, '__proto__'), false);
});

test('the open-job list splits main, side, gig and NCPD jobs, flags tracking, and details only the speaker\'s own jobs', () => {
  const text = availableQuestsContext({history: parsedHistory(), now: 1_000_000, profileKey: 'judy-alvarez',
    questCatalog: CATALOG, shared: shared()});
  const data = JSON.parse(text.slice(text.indexOf('\n') + 1));
  assert.deepEqual(data.mainJobs, [{title: 'Nocturne Op55N1'}], 'an ensemble main job is named, not detailed');
  assert.deepEqual(data.sideJobs, [{title: 'One Way or Another', tracked: true},
    {title: 'I Really Want to Stay at Your House', involvesYou: true, stillToDo: ['Meet Judy at your Glen apartment.']}]);
  assert.deepEqual(data.gigs, [{title: 'Gig: Family Heirloom'}]);
  assert.deepEqual(data.ncpdScannerHustles, [{title: 'Reported Crime: Table Scraps'}]);
  assert.equal(data.otherOpenJobs, 1);
  assert.doesNotMatch(text, /Pyramid Song|Read and reply|Hidden branch|Nele Springer|Hanako/,
    'finished jobs, done or failed objectives, the tracked block and other jobs\' steps stay out');
  assert.match(text, /Main jobs carry V's central story and matter most/);
});

test('a shared-cast job is the speaker\'s own only with a verified event in it on this save', () => {
  const river = availableQuestsContext({history: parsedHistory(), now: 1_000_000, profileKey: 'river-ward',
    questCatalog: CATALOG, shared: shared('river-ward')});
  assert.doesNotMatch(river, /"involvesYou":true|Glen apartment/);
  const solo = availableQuestsContext({history: parsedHistory([quest('8', 'Pyramid Song', {questType: 'SideQuest',
    objectives: [objective('81', 'Find Judy.'), objective('82', 'Optional chat.', 'active', {optional: true})]})]),
  now: 1_000_000, profileKey: 'judy-alvarez', questCatalog: CATALOG, shared: []});
  assert.match(solo, /"involvesYou":true,"stillToDo":\["Find Judy.",\{"text":"Optional chat.","optional":true\}\]/);
});

test('job list respects caps, its character budget, stale active data and partial inventories', () => {
  const many = Array.from({length: 14}, (_, i) => quest(String(100 + i), `Side Job ${i}`, {questType: 'MinorQuest'}));
  const text = availableQuestsContext({history: parsedHistory(many), now: 1_000_000, profileKey: 'judy-alvarez', questCatalog: CATALOG});
  const data = JSON.parse(text.slice(text.indexOf('\n') + 1));
  assert.equal(data.sideJobs.length, 8); assert.equal(data.notListed.sideJobs, 6);
  const tight = availableQuestsContext({history: parsedHistory(many), now: 1_000_000, profileKey: 'judy-alvarez'}, 900);
  assert.ok(tight.length <= 900);
  assert.equal(availableQuestsContext({history: parsedHistory(), now: 1_000_000 + 20_000, age: 20, profileKey: 'judy-alvarez'})
    .includes('One Way or Another'), false, 'an expired active lane lists nothing');
  const partial = parsedHistory(INVENTORY, {coverage: {active: {...lane, status: 'partial', scanning: true}, history: lane}});
  assert.match(availableQuestsContext({history: partial, now: 1_000_000, profileKey: 'judy-alvarez'}), /someJobsMayBeMissing/);
});

test('conversation context carries both sections only for a current world, beside the facts and tracked journal', () => {
  const input = {profileKey: 'judy-alvarez', text: 'what did we do last?', worldKnowledge: world(), journalHistory: history(INVENTORY),
    journal: {version: 1, status: 'active', quest: {id: '1', title: 'One Way or Another',
      objectives: [{id: '11', text: 'Read the message from Nele Springer.', tracked: true}]}}};
  const projection = resolveKnowledge({pack: pack(RULES), snapshot: world(), profileKey: 'judy-alvarez', maxChars: 8000});
  const options = {knowledgeContext: projection.context, generation: 1, worldToken: 'world-a', questCatalog: CATALOG,
    now: 1_000_000, sharedEvents: projection.shared, questPaths: questPathsFromPack(pack(RULES))};
  const context = conversationContext(withConversationKnowledge(input, options));
  const recent = context.indexOf('Your most recent shared events'), jobs = context.indexOf("V's open jobs"),
    tracked = context.indexOf("V's verified current-save journal"), facts = context.indexOf('Current-save knowledge');
  assert.ok(facts >= 0 && facts < recent && recent < jobs && jobs < tracked);
  assert.match(context, /"quest":"I Really Want to Stay at Your House","when":"a while ago"/);
  // A stale world binding drops the shared events; the job list is bound to the journal inventory's own lease.
  const stale = conversationContext(withConversationKnowledge(input, {...options, worldToken: 'world-b'}));
  assert.doesNotMatch(stale, /Your most recent shared events|V's open jobs/);
  const late = conversationContext(withConversationKnowledge(input, {...options, now: 1_000_000 + 60_000}));
  assert.doesNotMatch(late, /Your most recent shared events|V's open jobs/);
});
