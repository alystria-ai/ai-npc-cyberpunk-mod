import {test} from 'node:test';
import assert from 'node:assert/strict';
import {playerParagraphs, trimSparing} from './player-text.mjs';

// The paragraphs the player wrote are spared when a character text has to be shortened (bridge/player-text.mjs).
const SHIPPED = ['Opening paragraph about who she is. '.repeat(10), 'RELATIONSHIPS\n- V: a friend.\n- Jackie: an old contact.', 'BACKGROUND\n' + 'Long background sentence. '.repeat(30), 'LIMITS\n' + 'A limit sentence. '.repeat(20)].map(part => part.trim());
const SHIPPED_TEXT = SHIPPED.join('\n\n');

test('playerParagraphs: only the paragraphs that are not in the shipped bio, trimmed, in order, each once', () => {
  const mine = 'I also keep a tabby cat called Biscuit.';
  const bio = [SHIPPED[0], mine, SHIPPED[1], SHIPPED[2] + ' Changed.', mine, SHIPPED[3]].join('\n\n');
  assert.deepEqual(playerParagraphs(bio, SHIPPED_TEXT), [mine, SHIPPED[2] + ' Changed.']);
  assert.deepEqual(playerParagraphs(SHIPPED_TEXT, SHIPPED_TEXT), []);
  assert.deepEqual(playerParagraphs('', SHIPPED_TEXT), []);
  assert.deepEqual(playerParagraphs(undefined, undefined), []);
});

test('trimSparing without a spared paragraph cuts the end of the text as every cut did: down to the drop, at least 500 characters, an ellipsis', () => {
  const text = 'x'.repeat(3000);
  const cut = trimSparing(text, undefined, 400);
  assert.equal(cut.text, 'x'.repeat(2600) + '…');
  assert.equal(cut.short, 0);
  assert.equal(trimSparing('y'.repeat(600), [], 400).text, 'y'.repeat(500) + '…', 'never below 500 characters');
  assert.equal(trimSparing(text, undefined, 0).text, text, 'nothing to drop, nothing cut');
});

test('trimSparing takes the shipped paragraphs from the end first and leaves the ones the player wrote, wherever they are', () => {
  const mine = 'MINE: I keep a tabby cat called Biscuit on the editing console.';
  const text = [SHIPPED[0], SHIPPED[1], SHIPPED[2], SHIPPED[3], mine].join('\n\n');
  const drop = SHIPPED[3].length + 2 + 10;
  const cut = trimSparing(text, [mine], drop);
  assert(cut.text.includes(mine), 'the player\'s paragraph at the end stays');
  assert(!cut.text.includes('LIMITS'), 'the last shipped paragraph goes');
  assert(cut.text.length <= text.length - drop, `${cut.text.length} > ${text.length - drop}`);
  assert(cut.text.startsWith(SHIPPED[0]) && cut.text.includes('RELATIONSHIPS'), 'the beginning is untouched');
  // A player paragraph in the middle also stays.
  const middle = [SHIPPED[0], mine, SHIPPED[1], SHIPPED[2], SHIPPED[3]].join('\n\n');
  const second = trimSparing(middle, [mine], drop + 500);
  assert(second.text.includes(mine));
  assert(second.text.length <= middle.length - drop - 500);
  assert(!second.text.includes('LIMITS'));
});

test('trimSparing shortens the last paragraph that is needed only in part, at a sentence, and keeps a stub of at least 160 characters', () => {
  const mine = 'MINE: a fact.';
  const text = [SHIPPED[0], SHIPPED[2], mine].join('\n\n');
  const drop = Math.floor(SHIPPED[2].length / 2);
  const cut = trimSparing(text, [mine], drop);
  assert(cut.text.includes(mine));
  assert(cut.text.includes('BACKGROUND') && cut.text.includes('…'), 'the paragraph is shortened, not removed');
  assert(cut.text.length <= text.length - drop);
});

test('trimSparing with fallback off reports what is still to drop instead of cutting the player\'s words; with it on, the old cut finishes the job', () => {
  const mine = 'MINE: ' + 'z'.repeat(2000);
  const text = [SHIPPED[1], mine].join('\n\n');
  const off = trimSparing(text, [mine], 1500, {fallback: false});
  assert(off.text.includes(mine));
  assert(off.short > 0 && off.short < 1500, `${off.short} still to drop after the shipped paragraph`);
  const on = trimSparing(text, [mine], 1500);
  assert.equal(on.short, 0);
  assert(on.text.length <= text.length - 1500 + 1);
});

test('trimSparing with fallback off and nothing spared still goes paragraph by paragraph (the caller keeps the player\'s example lines instead of cutting the bio mid-sentence)', () => {
  const cut = trimSparing(SHIPPED_TEXT, [], SHIPPED[3].length + 5, {fallback: false});
  assert.equal(cut.short, 0);
  assert(!cut.text.includes('LIMITS'));
  assert(cut.text.startsWith(SHIPPED[0]));
});
