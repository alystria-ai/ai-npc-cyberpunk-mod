import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fallbackAliases, missingFallbacks, missingFallbacksLine, readFallbacks} from './voice-fallbacks.mjs';

const file = characters => JSON.stringify({version: 1, characters});

test('readFallbacks: the archetype of each person the roster names, nothing from rows that are not well formed', () => {
  const text = file({
    'adam-brocki': {fallback: 'npc-corpo-resident-male', clip: null},
    'aaron-mccarlson': {fallback: 'npc-ncpd-male', clip: {stem: 'x'}},
    'not-in-roster': {fallback: 'npc-ncpd-male', clip: null},
    'no-fallback': {clip: null},
    'bad-fallback': {fallback: '../escape', clip: null},
    'Bad Key': {fallback: 'npc-ncpd-male', clip: null},
    '__proto__': {fallback: 'npc-ncpd-male'},
  });
  const all = readFallbacks(text);
  assert.deepEqual(Object.keys(all).sort(), ['aaron-mccarlson', 'adam-brocki', 'not-in-roster']);
  const some = readFallbacks(text, new Set(['adam-brocki', 'aaron-mccarlson']));
  assert.deepEqual({...some}, {'adam-brocki': 'npc-corpo-resident-male', 'aaron-mccarlson': 'npc-ncpd-male'});
  assert.deepEqual(Object.keys(readFallbacks('{')), [], 'an unreadable file gives no fallbacks');
  assert.deepEqual(Object.keys(readFallbacks('[]')), []);
  assert.equal(readFallbacks(text).toString, undefined, 'no prototype to read keys from');
});

test('fallbackAliases: the player\'s own characters first, then the cast sweep fallback, and nothing for anyone else', () => {
  const alias = fallbackAliases(readFallbacks(file({'adam-brocki': {fallback: 'npc-corpo-resident-male'}})), key => key === 'custom-a' ? 'resident-male' : null);
  assert.equal(alias('custom-a'), 'resident-male');
  assert.equal(alias('adam-brocki'), 'npc-corpo-resident-male');
  for (const key of ['judy-alvarez', 'toString', '__proto__', '', undefined, null, 5]) assert.equal(alias(key), null, String(key));
  assert.equal(fallbackAliases({})('anyone'), null);
});

test('missingFallbacks: counts the people an engine has no archetype voice for, and the line says it once', () => {
  const fallbacks = readFallbacks(file({a: {fallback: 'npc-x'}, b: {fallback: 'npc-x'}, c: {fallback: 'npc-y'}, d: {fallback: 'npc-y'}}));
  const tables = {pocket: {'npc-x': {}, 'npc-y': {}}, short: {'npc-x': {}, d: {}}, long: null};
  const counts = missingFallbacks(fallbacks, tables);
  assert.deepEqual(counts, {pocket: 0, short: 1});
  assert.equal(missingFallbacksLine({pocket: 0, short: 0}, 4), null);
  const line = missingFallbacksLine(counts, 4);
  assert.match(line, /short 1 of 4 side character/);
  assert.doesNotMatch(line, /pocket/);
  assert.equal(line.includes('\n'), false);
});
