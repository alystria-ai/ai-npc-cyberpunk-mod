import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crossTab, gradeRow, holds, leavesOf, parseSelector} from './decision_rows_offline_check.mjs';

const fact = (key, op = 'gte', value = 1) => ({type: 'fact', key, op, value});
const journal = (key, value = 'succeeded', op = 'eq') => ({type: 'journal', key, op, value});
const world = (facts = {}, journals = {}) => ({factValue: name => facts[name] ?? 0, journalState: key => journals[key]});

test('a condition is evaluated against one save with the same semantics as the bridge', () => {
  const condition = {all: [fact('a'), journal('j', ['active', 'succeeded'], 'in')]};
  assert.equal(holds(condition, world({a: 1}, {j: 'active'})), true);
  assert.equal(holds(condition, world({a: 1}, {j: 'failed'})), false);
  assert.equal(holds(condition, world({}, {j: 'active'})), false, 'an absent fact is zero, never a match for gte 1');
  assert.equal(holds({any: [fact('a', 'eq', 2), fact('b')]}, world({b: 3})), true);
  assert.equal(holds(fact('a', 'in', [1, 2]), world({a: 2})), true);
  assert.equal(holds(journal('j', 'succeeded', 'ne'), world({}, {})), false, 'ne never matches an absent entry');
  assert.equal(holds(undefined, world()), false);
  assert.deepEqual(leavesOf({all: [fact('a'), {any: [journal('j')]}]}).map(leaf => leaf.key), ['a', 'j']);
});

test('the grade says whether the selectors exist, have a hash-bound writer, and were seen in a real save', () => {
  const known = (fields = {}) => ({key: 'q_x', inDictionary: false, alreadyInPack: false,
    writers: {assignments: 0, positive: 0, hashBoundPositive: 1}, ...fields});
  const row = fields => ({id: 'db.x', status: 'unverified', condition: fact('q_x'), notes: 'Some reading of the scene graph.', ...fields});
  const input = fields => ({facts: [known()], journals: [], conditionHolds: 0, ...fields});
  assert.equal(gradeRow(row(), input()), 'anchored-not-seen');
  assert.equal(gradeRow(row(), input({conditionHolds: 3})), 'anchored-and-seen');
  // A scene-written fact is not in the dictionary; that alone must not make a row "missing".
  assert.equal(gradeRow(row(), input({facts: [known({inDictionary: false})]})), 'anchored-not-seen');
  assert.equal(gradeRow(row(), input({facts: [known({writers: {assignments: 0, positive: 0, hashBoundPositive: 0}})]})), 'missing-selector');
  assert.equal(gradeRow(row(), input({facts: [known({inDictionary: true, writers: {assignments: 1, positive: 1, hashBoundPositive: 0}})]})), 'writer-unbound');
  assert.equal(gradeRow(row(), input({facts: [known({alreadyInPack: true, writers: {assignments: 0, positive: 0, hashBoundPositive: 0}})]})), 'anchored-not-seen');
  assert.equal(gradeRow(row(), input({journals: [{inCookedJournal: false}]})), 'missing-selector');
  assert.equal(gradeRow(row({condition: null}), input()), 'not-executable');
  assert.equal(gradeRow(row({notes: 'DRAFT ONLY, THIS CONDITION IS NOT EXCLUSIVE.'}), input({conditionHolds: 9})), 'not-executable');
});

test('selectors parse as fact:name or journal:path, and anything else is refused', () => {
  assert.deepEqual(parseSelector('fact:q112_oda_dead'), {type: 'fact', key: 'q112_oda_dead'});
  assert.deepEqual(parseSelector('journal:quests/a/b'), {type: 'journal', key: 'quests/a/b'});
  assert.throws(() => parseSelector('quests/a/b'));
  assert.throws(() => parseSelector('lifepath:x'));
});

test('the cross-tab groups saves by the values of the selectors and keeps the kinds of save apart', () => {
  const saves = [{kind: 'CM', v: ['1', '0']}, {kind: 'CM', v: ['1', '0']}, {kind: 'NM', v: ['0', '1']}, {kind: 'CF', v: ['1', '0']}];
  const rows = crossTab(saves, [0, 1], (save, index) => save.v[index], save => save.kind);
  assert.deepEqual(rows.map(row => [row.values.join(''), row.saves]), [['10', 3], ['01', 1]]);
  assert.deepEqual(rows[0].kinds, {CM: 2, CF: 1});
  assert.deepEqual(rows[1].kinds, {NM: 1});
});
