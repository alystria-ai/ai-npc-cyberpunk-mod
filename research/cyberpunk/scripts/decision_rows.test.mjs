import {test} from 'node:test';
import assert from 'node:assert/strict';
import {acceptsZero, leaves, validateSpec} from './decision_rows.mjs';

const context = () => ({
  decisions: new Map([['silverhand.rooftop-kerry-call', {outcomes: [{key: 'called'}, {key: 'other'}]}]]),
  profiles: new Set(['kerry-eurodyne', 'judy-alvarez']),
  journals: {'q115.partner': true}});
const row = (fields = {}) => ({id: 'db.kerry-call', status: 'verified', decisionId: 'silverhand.rooftop-kerry-call', outcomeKey: 'called',
  statement: 'V picked Kerry as the person to call from the rooftop.', speakers: ['kerry-eurodyne'], perspective: 'participant',
  condition: {type: 'fact', key: 'q115_kerry_romance_chosen', op: 'gte', value: 1},
  notes: 'Only the Kerry option of the rooftop choice writes this fact.', ...fields});
const check = (...rows) => validateSpec({version: 1, rows}, context());

test('a zero-accepting fact leaf is detected, because a zero fact is unknown and never a refusal', () => {
  assert.equal(acceptsZero({type: 'fact', key: 'a', op: 'gte', value: 1}), false);
  assert.equal(acceptsZero({type: 'fact', key: 'a', op: 'gte', value: 0}), true);
  assert.equal(acceptsZero({type: 'fact', key: 'a', op: 'eq', value: 0}), true);
  assert.equal(acceptsZero({type: 'fact', key: 'a', op: 'eq', value: 2}), false);
  assert.equal(acceptsZero({type: 'fact', key: 'a', op: 'in', value: [0, 1]}), true);
  assert.equal(acceptsZero({type: 'fact', key: 'a', op: 'in', value: [2, 3]}), false);
  assert.equal(acceptsZero({type: 'fact', key: 'a', op: 'ne', value: 3}), true);
  assert.equal(acceptsZero({type: 'journal', key: 'a', op: 'eq', value: 'active'}), false);
  const tree = {all: [{type: 'fact', key: 'a', op: 'gte', value: 1}, {any: [{type: 'journal', key: 'b', op: 'eq', value: 'active'}]}]};
  assert.deepEqual(leaves(tree).map(leaf => leaf.key), ['a', 'b']);
});

test('a well-formed verified row and an unverified candidate row validate', () => {
  assert.deepEqual(check(row()), []);
  assert.deepEqual(check(row({id: 'db.kerry-unverified', status: 'unverified', outcomeKey: 'other',
    unverifiedBecause: 'The fact name matches but no writer was readable.'})), []);
  assert.deepEqual(check(row({condition: {all: [{type: 'fact', key: 'q115_x', op: 'gte', value: 1},
    {type: 'journal', key: 'q115.partner', op: 'eq', value: 'succeeded'}]}})), []);
});

test('rows that overreach, guess, or cannot be proven are refused', () => {
  const refused = (fields, pattern) => assert.match(check(row(fields)).join('\n'), pattern);
  refused({condition: {type: 'fact', key: 'q115_x', op: 'eq', value: 0}}, /accepts zero/);
  refused({condition: {type: 'journal', key: 'not.in.pack', op: 'eq', value: 'active'}}, /journal allowlist/);
  refused({condition: {type: 'journal', key: 'q115.partner', op: 'ne', value: 'active'}}, /journal ne/);
  refused({condition: undefined}, /condition required/);
  refused({decisionId: 'nope.nothing'}, /unknown decision/);
  refused({outcomeKey: 'missing'}, /unknown decision/);
  refused({speakers: ['not-a-character']}, /roster keys/);
  refused({speakers: []}, /roster keys/);
  refused({perspective: 'told-by-v'}, /disclosure receipt/);
  refused({perspective: 'gossip'}, /perspective/);
  refused({channels: ['radio']}, /channels/);
  refused({statement: 'short'}, /statement length/);
  refused({notes: 'ok'}, /notes/);
  refused({id: 'Bad Id'}, /bad or duplicate id/);
  refused({status: 'maybe'}, /status/);
  refused({status: 'unverified'}, /unverifiedBecause/);
  assert.match(check(row(), row({id: 'db.second'})).join('\n'), /two verified rows/);
  assert.match(check(row(), row()).join('\n'), /duplicate id/);
  assert.deepEqual(validateSpec({version: 2, rows: []}, context()), ['spec: version 1 and rows required']);
});

test('a row joins a native topic domain only through a verified row with a reviewed alias policy, and a live check must be a real recipe', () => {
  const aliased = (fields = {}, alias = {}) => row({topic: 'silverhand.native-rooftop', topicAlias: {policy: 'mutually-exclusive-stance',
    rationale: 'The two outcomes are exclusive in the quest script.', reviewRef: 'native-reviews/rooftop-alias-20261015.md', ...alias}, ...fields});
  const withTopic = (...rows) => validateSpec({version: 1, rows}, {...context(),
    decisions: new Map([['silverhand.rooftop-kerry-call', {topic: 'silverhand.rooftop', outcomes: [{key: 'called'}, {key: 'other'}]}]])});
  assert.deepEqual(withTopic(aliased()), []);
  assert.match(withTopic(aliased({topic: 'silverhand.rooftop'})).join('\n'), /different from the catalog topic/);
  assert.match(withTopic(aliased({}, {policy: 'whatever'})).join('\n'), /topicAlias needs/);
  assert.match(withTopic(aliased({}, {reviewRef: '../outside.md'})).join('\n'), /topicAlias needs/);
  assert.match(withTopic(aliased({}, {rationale: '  '})).join('\n'), /topicAlias needs/);
  assert.match(withTopic(aliased({topicAlias: undefined})).join('\n'), /topicAlias needs/);
  assert.match(withTopic(aliased({status: 'unverified', unverifiedBecause: 'Not yet read.'})).join('\n'), /only a verified row joins/);
  assert.deepEqual(check(row({id: 'db.kerry-open', status: 'unverified', outcomeKey: 'other', unverifiedBecause: 'Never observed in a save.',
    liveCheck: 'Pick the Kerry option, then read q115_kerry_romance_chosen in the CET console.'})), []);
  assert.match(check(row({id: 'db.kerry-open', status: 'unverified', outcomeKey: 'other', unverifiedBecause: 'Never observed.', liveCheck: 'look'})).join('\n'), /liveCheck/);
});
