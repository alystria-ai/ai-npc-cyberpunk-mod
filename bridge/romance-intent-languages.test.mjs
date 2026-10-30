// Every line in romance-intent-languages.cases.json must be read as written: 'propose', 'end' or null (screenRomance unions all languages, so a line of one
// language must also stay clear of every other language's patterns).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {screenRomance} from './romance-intent.mjs';
import {LANGUAGE_PATTERNS} from './romance-intent-languages.mjs';

const cases = JSON.parse(readFileSync(new URL('./romance-intent-languages.cases.json', import.meta.url), 'utf8'));
const EXPECTED = {propose: 'propose', end: 'end', neither: null};

test('every language has a row and a case set', () => {
  assert.deepEqual(Object.keys(cases).sort(), Object.keys(LANGUAGE_PATTERNS).sort());
  for (const [language, set] of Object.entries(cases)) {
    for (const kind of Object.keys(EXPECTED)) assert.equal(set[kind]?.length, 6, `${language} ${kind} needs 6 lines`);
  }
});

for (const [language, set] of Object.entries(cases)) {
  for (const [kind, expected] of Object.entries(EXPECTED)) {
    test(`${language} ${kind}`, () => {
      for (const line of set[kind]) assert.equal(screenRomance(line), expected, `${language} ${kind}: ${line}`);
    });
  }
}

test('curly apostrophes read like straight ones', () => {
  assert.equal(screenRomance('Je t’aime, Judy'), 'propose');
  assert.equal(screenRomance('C’est fini entre nous'), 'end');
});

test('English still works', () => {
  assert.equal(screenRomance('Will you be my girlfriend?'), 'propose');
  assert.equal(screenRomance('I want to break up with you'), 'end');
  assert.equal(screenRomance("let's split up and search the building"), null);
});
