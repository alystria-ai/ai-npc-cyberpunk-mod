// Quest facts (bridge/quest-facts.mjs, docs/QUEST_PRIMITIVES.md 10.9): the registry, matching with "missing data is a no", the facts file parser and the cached reader. Offline.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FACTS, factProblem, factMatches, wantedFacts, parseFacts, createFactsReader} from './quest-facts.mjs';

test('the registry names takemura-alive (a bool) and pisces-outcome (spared, killed, unknown), both flagged to verify', () => {
  assert.equal(FACTS['takemura-alive'].kind, 'bool');
  assert.deepEqual([...FACTS['pisces-outcome'].values], ['spared', 'killed', 'unknown']);
  for (const fact of Object.values(FACTS)) { assert.equal(fact.verify, true); assert(fact.names.length > 0); }
});

test('expectations: a bool is true or false, an enum one value or a list of its values, unknown facts are refused', () => {
  assert.equal(factProblem('takemura-alive', true), null);
  assert.match(factProblem('takemura-alive', 'yes'), /true or false/);
  assert.equal(factProblem('pisces-outcome', 'spared'), null);
  assert.equal(factProblem('pisces-outcome', ['spared', 'unknown']), null);
  assert.match(factProblem('pisces-outcome', 'maybe'), /one of spared, killed, unknown/);
  assert.match(factProblem('pisces-outcome', []), /one of/);
  assert.match(factProblem('nothing-here', true), /not a known fact/);
  assert.match(factProblem('__proto__', true), /not a known fact/);
});

test('matching: the game must have reported the fact; a fact it has not reported is a no, even for an expected false', () => {
  assert.equal(factMatches({'takemura-alive': true}, 'takemura-alive', true), true);
  assert.equal(factMatches({'takemura-alive': false}, 'takemura-alive', true), false);
  assert.equal(factMatches({'takemura-alive': false}, 'takemura-alive', false), true);
  assert.equal(factMatches({}, 'takemura-alive', false), false, 'missing data is always a no');
  assert.equal(factMatches(null, 'takemura-alive', true), false);
  assert.equal(factMatches(undefined, 'takemura-alive', true), false);
  assert.equal(factMatches({'pisces-outcome': 'killed'}, 'pisces-outcome', ['spared', 'killed']), true);
  assert.equal(factMatches({'pisces-outcome': 'killed'}, 'pisces-outcome', 'spared'), false);
  assert.equal(factMatches({'pisces-outcome': 'odd'}, 'pisces-outcome', 'odd'), false, 'an invalid expectation never matches');
});

test('factsWanted: each fact once, with its candidate names and kind, sorted', () => {
  const wanted = wantedFacts([{facts: {'takemura-alive': true}}, {facts: {'takemura-alive': true, 'pisces-outcome': 'spared'}}, {}, undefined, {facts: {bogus: 1}}]);
  assert.deepEqual(wanted.map(item => item.id), ['pisces-outcome', 'takemura-alive']);
  assert.equal(wanted[1].kind, 'bool'); assert(wanted[1].names.length > 0);
  assert.deepEqual(wantedFacts([]), []);
});

test('the facts file: version 1, known ids and valid values only; a damaged file is nothing', () => {
  const parsed = parseFacts(JSON.stringify({version: 1, at: 500, facts: {'takemura-alive': true, 'pisces-outcome': 'odd', unknown: 3}}));
  assert.deepEqual(parsed, {at: 500, facts: {'takemura-alive': true}});
  assert.equal(parseFacts('{'), null); assert.equal(parseFacts(JSON.stringify({version: 2, facts: {}})), null); assert.equal(parseFacts(JSON.stringify({version: 1})), null);
  assert.equal(parseFacts('x'.repeat(20000)), null); assert.equal(parseFacts(undefined), null);
});

test('the reader looks at the file at most every few seconds and reads it only when its modified time changed', () => {
  let clock = 1000, mtime = 1, text = JSON.stringify({version: 1, facts: {'takemura-alive': true}});
  const calls = {stat: 0, read: 0};
  let exists = true;
  const read = createFactsReader({path: 'facts.json', now: () => clock, minIntervalMs: 5000,
    statFile: () => { calls.stat++; return exists ? {mtimeMs: mtime} : null; }, readText: () => { calls.read++; return text; }});
  assert.deepEqual(read(), {'takemura-alive': true});
  for (let n = 0; n < 10; n++) read();
  assert.deepEqual(calls, {stat: 1, read: 1}, 'ten more checks inside the interval cost nothing');
  clock += 6000;
  assert.deepEqual(read(), {'takemura-alive': true});
  assert.deepEqual(calls, {stat: 2, read: 1}, 'the file did not change: stat only');
  text = JSON.stringify({version: 1, facts: {'takemura-alive': false}}); mtime = 2; clock += 6000;
  assert.deepEqual(read(), {'takemura-alive': false});
  assert.equal(calls.read, 2);
  exists = false; clock += 6000;
  assert.deepEqual(read(), {}, 'no file is no facts');
  const none = createFactsReader({});
  assert.deepEqual(none(), {}, 'no path is no facts');
  const broken = createFactsReader({path: 'x', now: () => 0, statFile: () => { throw Error('boom'); }});
  assert.deepEqual(broken(), {});
});
