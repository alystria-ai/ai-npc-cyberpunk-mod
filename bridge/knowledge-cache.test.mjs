import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configureKnowledgeParts, resolveKnowledgeParts} from './knowledge-parts.mjs';
import {parseWorldSnapshot, resolveKnowledge} from './world-knowledge.mjs';
import {parseJournalHistory} from './journal-history.mjs';
import {freezeDeep, isImmutable, isParsed, snapshotKey, digestOf} from './parsed-snapshot.mjs';

// A turn used to spend 150 to 230 ms preparing knowledge, nearly all of it re-reading, re-measuring, re-parsing and re-cloning the
// world snapshot and journal history the game publishes once per revision (docs/QUEST_DECISIONS.md, step 1). These tests pin what
// the cache may and may not do: share what a revision holds, parse it once, and never answer for another revision or a changed object.
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const source = (value, fields = {}) => ({status: 'known', value, sourceId: 'native-capture', evidenceRefs: ['capture:1:o'], ...fields});
const header = {version: 1, status: 'ready', gameVersion: '2.31', generation: 3, worldToken: 'lua-world-3',
  capturedAt: new Date(NOW).toISOString(), identity: {status: 'unknown'}, audience: {channel: 'private', profileKeys: ['judy-alvarez']}};
const worldPart = (revision, value = 1) => ({version: 1, part: 'world', revision, generation: 3, worldToken: 'lua-world-3',
  data: {lifepath: source('nomad'), activeQuestKeys: [], facts: {f: source(value, {present: true})}, journal: {}}});
const coverage = count => ({status: 'complete', ageSeconds: 0, windowSeconds: 1, observed: count, omitted: 0, unstable: false});
const questRow = (id, observed = NOW - 5000) => ({id, nativeId: `quest_${id}`, title: `Quest ${id}`, state: 'succeeded', lane: 'history',
  observedAtMs: observed, objectivesComplete: true, objectives: [{id: `${id}1`, nativeId: 'step', questRelativePath: [`quest_${id}`, 'step'],
    text: `Step of quest ${id}.`, state: 'succeeded', observedAtMs: observed}]});
const historyPart = (revision, ids) => ({version: 1, part: 'history', revision, generation: 3, worldToken: 'lua-world-3',
  data: {quests: Object.fromEntries(ids.map(id => [id, questRow(id)]))}});
const historyHeader = (revision, ids) => ({version: 1, status: 'ready', generation: 3, worldToken: 'lua-world-3', capturedAtMs: NOW,
  tracked: {status: 'unknown'}, coverage: {active: coverage(0), history: coverage(ids.length)}, quests: [],
  lanes: {history: {revision, ids}}});

// Files in memory; every read is counted.
function disk(files) {
  const reads = [];
  configureKnowledgeParts({runtimeDir: '/runtime', readFile: path => {
    const name = path.replace(/^.*[\\/]/, '');
    reads.push(name);
    if (!(name in files)) throw Error('no such file');
    return JSON.stringify(files[name]);
  }});
  return reads;
}
const worldRef = revision => ({...header, ref: {part: 'world', revision}});

test('an unchanged revision is read from disk once and shared by every turn', () => {
  const reads = disk({'knowledge-world.json': worldPart(2)});
  const first = resolveKnowledgeParts({worldKnowledge: worldRef(2)}).worldKnowledge;
  const second = resolveKnowledgeParts({worldKnowledge: {...worldRef(2), capturedAt: new Date(NOW + 9000).toISOString()}}).worldKnowledge;
  assert.deepEqual(reads, ['knowledge-world.json']);
  assert.equal(first.facts, second.facts, 'the facts are the same object, so nothing is cloned or re-parsed per turn');
  assert.equal(isImmutable(first.facts), true);
  assert.throws(() => { first.facts.f.value = 99; }, TypeError);
});

test('a new revision is read afresh and shows its own data; an older revision still held is not read again', () => {
  const files = {'knowledge-world.json': worldPart(2, 1)};
  const reads = disk(files);
  const old = parseWorldSnapshot(resolveKnowledgeParts({worldKnowledge: worldRef(2)}).worldKnowledge);
  files['knowledge-world.json'] = worldPart(3, 7);
  const fresh = parseWorldSnapshot(resolveKnowledgeParts({worldKnowledge: worldRef(3)}).worldKnowledge);
  assert.equal(old.facts.f.value, 1);
  assert.equal(fresh.facts.f.value, 7, 'the new revision is not answered from the old one');
  assert.notEqual(old.facts, fresh.facts);
  assert.deepEqual(reads, ['knowledge-world.json', 'knowledge-world.json']);
  // A request still naming revision 2 (the file now holds 3) is served from memory, and the held copy has not changed.
  const again = parseWorldSnapshot(resolveKnowledgeParts({worldKnowledge: worldRef(2)}).worldKnowledge);
  assert.equal(again.facts.f.value, 1);
  assert.equal(reads.length, 2);
});

test('only the newest three revisions of a part are kept', () => {
  const files = {'knowledge-world.json': worldPart(1)};
  const reads = disk(files);
  for (const revision of [1, 2, 3, 4]) { files['knowledge-world.json'] = worldPart(revision); resolveKnowledgeParts({worldKnowledge: worldRef(revision)}); }
  assert.equal(reads.length, 4);
  resolveKnowledgeParts({worldKnowledge: worldRef(4)}); resolveKnowledgeParts({worldKnowledge: worldRef(2)});
  assert.equal(reads.length, 4, 'revisions 2 to 4 are still held');
  files['knowledge-world.json'] = worldPart(1);
  resolveKnowledgeParts({worldKnowledge: worldRef(1)});
  assert.equal(reads.length, 5, 'revision 1 was evicted, so it is read again');
});

test('a part that is not what the turn names is never used: a wrong revision, generation or world stays unavailable', () => {
  disk({'knowledge-world.json': worldPart(2)});
  for (const ref of [{...worldRef(5)}, {...worldRef(2), generation: 4}, {...worldRef(2), worldToken: 'lua-world-9'}]) {
    const snapshot = resolveKnowledgeParts({worldKnowledge: ref}).worldKnowledge;
    assert.equal(snapshot.status, 'unavailable');
  }
});

test('parsing is done once per revision: the parsed facts are shared, a parsed snapshot is returned as it is, and it is frozen', () => {
  disk({'knowledge-world.json': worldPart(2)});
  const one = parseWorldSnapshot(resolveKnowledgeParts({worldKnowledge: worldRef(2)}).worldKnowledge);
  const two = parseWorldSnapshot(resolveKnowledgeParts({worldKnowledge: {...worldRef(2), capturedAt: new Date(NOW + 5000).toISOString()}}).worldKnowledge);
  assert.equal(one.status, 'ready');
  assert.notEqual(one, two, 'each turn has its own snapshot header');
  assert.equal(one.facts, two.facts, 'the parse of the facts is shared');
  assert.equal(two.capturedAt, new Date(NOW + 5000).toISOString());
  assert.equal(parseWorldSnapshot(one), one);
  assert.equal(isParsed(one), true);
  assert.throws(() => { one.facts.f.value = 0; }, TypeError);
  assert.throws(() => { one.audience.profileKeys.push('panam-palmer'); }, TypeError);
});

test('what the cache returns equals what a plain parse of a copy returns', () => {
  disk({'knowledge-world.json': worldPart(2, 4)});
  const cached = parseWorldSnapshot(resolveKnowledgeParts({worldKnowledge: worldRef(2)}).worldKnowledge);
  const plain = parseWorldSnapshot(JSON.stringify({...header, ...worldPart(2, 4).data}));
  assert.deepEqual(cached, plain);
});

test('an object that could still change is never remembered: changing it changes the parse', () => {
  const raw = () => ({...header, ...worldPart(2).data});
  const mutable = raw();
  assert.equal(parseWorldSnapshot(mutable).facts.f.value, 1);
  mutable.facts.f.value = 5;
  assert.equal(parseWorldSnapshot(mutable).facts.f.value, 5);
  // And a frozen result cannot be handed back changed: a copy of it is parsed afresh.
  const parsed = parseWorldSnapshot(raw()), copy = structuredClone(parsed);
  copy.facts.f.value = 8;
  assert.equal(parseWorldSnapshot(copy).facts.f.value, 8);
  assert.equal(parsed.facts.f.value, 1);
});

test('a snapshot over the size limit is still refused, whether it arrives as text or as shared objects', () => {
  const big = {...header, facts: Object.fromEntries(Array.from({length: 900}, (_, i) => [`fact_${i}`, source(i + 1, {present: true,
    evidenceRefs: Array.from({length: 16}, (_, n) => `capture:${i}:${n}:${'x'.repeat(40)}`)})])), journal: {}, lifepath: source('nomad')};
  assert.equal(parseWorldSnapshot(JSON.stringify(big)).reason, 'invalid-snapshot');
  assert.equal(parseWorldSnapshot(freezeDeep(structuredClone(big))).reason, 'invalid-snapshot');
  assert.equal(parseWorldSnapshot(structuredClone(big)).reason, 'invalid-snapshot');
});

test('a journal history is rebuilt from cached rows, with each row parsed once and the capture time still enforced', () => {
  const ids = ['101', '102', '103'];
  const reads = disk({'knowledge-history.json': historyPart(4, ids)});
  const turn = (extra = {}) => parseJournalHistory(resolveKnowledgeParts({journalHistory: {...historyHeader(4, ids), ...extra}}).journalHistory);
  const first = turn(), second = turn({capturedAtMs: NOW + 1000});
  assert.equal(first.status, 'ready'); assert.equal(first.quests.length, 3);
  assert.deepEqual(first.quests.map(row => row.id), ids);
  assert.equal(first.quests[0], second.quests[0], 'a parsed row is shared between turns');
  assert.equal(reads.length, 1);
  assert.throws(() => { first.quests[0].title = 'Changed'; }, TypeError);
  // A capture older than a row's observation still rejects that row, though the row parsed before.
  assert.equal(turn({capturedAtMs: NOW - 60000}).status, 'unavailable');
  // A lane that was never observed still rejects its rows.
  assert.equal(turn({coverage: {active: coverage(0), history: {status: 'pending'}}}).reason, 'unobserved-lane');
});

test('a new history revision brings its own rows, and the old rows are not mixed in', () => {
  const files = {'knowledge-history.json': historyPart(4, ['101', '102'])};
  const reads = disk(files);
  const request = (revision, ids) => parseJournalHistory(resolveKnowledgeParts({journalHistory: historyHeader(revision, ids)}).journalHistory);
  const first = request(4, ['101', '102']);
  files['knowledge-history.json'] = {...historyPart(5, ['101', '102', '104']), data: {quests: {...historyPart(5, ['101', '102', '104']).data.quests,
    101: {...questRow('101'), title: 'Quest 101 renamed'}}}};
  const next = request(5, ['101', '102', '104']);
  assert.equal(reads.length, 2);
  assert.equal(first.quests.length, 2); assert.equal(next.quests.length, 3);
  assert.equal(first.quests[0].title, 'Quest 101');
  assert.equal(next.quests[0].title, 'Quest 101 renamed');
});

test('an identity key moves exactly when the revision does, and does not serialise the large members again', () => {
  const files = {'knowledge-world.json': worldPart(2, 1)};
  disk(files);
  const turn = revision => parseWorldSnapshot(resolveKnowledgeParts({worldKnowledge: worldRef(revision)}).worldKnowledge);
  const a = turn(2), b = turn(2);
  assert.notEqual(a, b);
  assert.equal(JSON.stringify(snapshotKey(a)), JSON.stringify(snapshotKey(b)));
  assert.equal(digestOf(a.facts), digestOf(b.facts));
  files['knowledge-world.json'] = worldPart(3, 2);
  const c = turn(3);
  assert.notEqual(JSON.stringify(snapshotKey(a)), JSON.stringify(snapshotKey(c)));
  // A snapshot that is not frozen is its own key, as before.
  const loose = {...header, facts: {}};
  assert.equal(snapshotKey(loose), loose);
});

test('a rule resolved over cached parts equals the same rule over a plain copy of the snapshot', () => {
  const pack = {version: 1, id: 'p', revision: 1, gameVersions: ['2.31'], profileKeys: ['judy-alvarez'],
    sources: [{id: 'native-source', kind: 'native', locator: 'base/quest/example.quest'}, {id: 'story-source', kind: 'community', url: 'https://example.org/s'}],
    evidence: [{id: 'native-branch', kind: 'native', sourceId: 'native-source', locator: 'branch 1', gameVersions: ['2.31']}],
    factAllowlist: {f: {evidenceRefs: ['native-branch']}}, journalAllowlist: {},
    rules: [{id: 'r', revision: 1, questKey: 'q', topic: 't', outcome: 'o', status: 'source-verified', reviewed: true, gameVersions: ['2.31'],
      category: 'decision', priority: 5, stable: true, statement: 'V accepted the offer.', sourceIds: ['story-source'], evidenceRefs: ['native-branch'],
      audience: {speakers: ['judy-alvarez'], perspective: 'participant', channels: ['private'], recipients: ['v', 'judy-alvarez']},
      condition: {type: 'fact', key: 'f', op: 'eq', value: 1}}]};
  disk({'knowledge-world.json': worldPart(2)});
  const viaParts = resolveKnowledge({pack, snapshot: resolveKnowledgeParts({worldKnowledge: worldRef(2)}).worldKnowledge, profileKey: 'judy-alvarez', maxChars: 4000});
  const viaCopy = resolveKnowledge({pack, snapshot: {...header, ...structuredClone(worldPart(2).data)}, profileKey: 'judy-alvarez', maxChars: 4000});
  assert.equal(viaParts.context, viaCopy.context);
  assert.match(viaParts.context, /"choices":\[\{"questKey":"q"/);
  assert.deepEqual(viaParts.diagnostics, viaCopy.diagnostics);
});
