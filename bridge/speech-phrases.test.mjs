import {test} from 'node:test';
import assert from 'node:assert/strict';
import {splitSpeechText} from './speech-phrases.mjs';

// (The queue, look-ahead, cancel and failure rules of a reply's phrases are tested with createOmniPcmVoice in omni-pcm.test.mjs.)

test('phrases preserve every word and favour natural boundaries with a short first phrase', () => {
  const text = 'Hey V, I have been thinking about what happened last night. We could head down to the market together, pick up some food and talk about the next job. That sounds good to me.';
  const phrases = splitSpeechText(text);
  assert.equal(phrases.join(' '), text);
  assert.equal(phrases[0], 'Hey V, I have been thinking about what happened last night.');
  assert.ok(phrases.length > 1);
  assert.deepEqual(splitSpeechText('Hey, V.'), ['Hey, V.']);
  assert.throws(() => splitSpeechText(''), /Invalid/);
  const unpunctuated = Array.from({length: 100}, (_, n) => `word${n}`).join(' ');
  assert.equal(splitSpeechText(unpunctuated).join(' '), unpunctuated);
});

test('the first phrase is at most 22 words and later ones at most 34, and no phrase is an isolated tail of fewer than four words', () => {
  const text = Array.from({length: 120}, (_, n) => `word${n}`).join(' ');
  const phrases = splitSpeechText(text), counts = phrases.map(phrase => phrase.split(' ').length);
  assert.ok(counts[0] <= 22, `first phrase ${counts[0]}`);
  assert.ok(counts.slice(1).every(count => count <= 34), counts.join(','));
  assert.ok(counts.length < 2 || counts.at(-1) >= 4);
  // A tail of fewer than four words joins the phrase before it; four words stay a phrase of their own.
  const words = count => Array.from({length: count}, (_, n) => `w${n}`).join(' ');
  assert.deepEqual(splitSpeechText(words(24)).map(phrase => phrase.split(' ').length), [24]);
  assert.deepEqual(splitSpeechText(words(25)).map(phrase => phrase.split(' ').length), [25]);
  assert.deepEqual(splitSpeechText(words(26)).map(phrase => phrase.split(' ').length), [22, 4]);
});

test('the first phrase ends at the first sentence end after six words, and a sentence of fewer words is not cut short', () => {
  const phrases = splitSpeechText('Hi. Hey there V, nice to see you again after so long. ' + 'Then we kept talking about the old days and the new ones for quite a while. '.repeat(3));
  assert.ok(phrases[0].split(' ').length >= 6, phrases[0]);
  assert.match(phrases[0], /again after so long\.$/);
  assert.deepEqual(splitSpeechText('Yes. No.'), ['Yes. No.']);
});

test('clause boundaries (commas, semicolons, dashes, full-width stops) cut a long run', () => {
  const clause = 'one two three four five six seven eight nine ten eleven twelve thirteen, ';
  const text = clause.repeat(6).trim();
  const phrases = splitSpeechText(text);
  assert.ok(phrases.length > 1);
  assert.equal(phrases.join(' '), text);
  assert.ok(phrases.slice(0, -1).every(phrase => /,$/.test(phrase)), 'cut after a comma');
  const cjk = splitSpeechText(Array.from({length: 10}, () => '你好 吗 我 很 好。').join(' '));
  assert.ok(cjk.length >= 1 && cjk.every(phrase => phrase.length > 0));
  assert.equal(cjk.join(' '), Array.from({length: 10}, () => '你好 吗 我 很 好。').join(' '));
});

test('text that is not a string, is blank, or is longer than 12000 characters is refused, and so is a reply of more than 32 phrases', () => {
  for (const bad of [undefined, null, 5, '', ' ', 'a '.repeat(6001)]) assert.throws(() => splitSpeechText(bad), /Invalid speech text/);
  const words = count => Array.from({length: count}, (_, n) => `w${n}`).join(' ');
  // Without any punctuation a phrase is 22 words, then 34: 22 + 31 x 34 = 1076 words fill exactly 32 phrases.
  const full = splitSpeechText(words(1076));
  assert.equal(full.length, 32); assert.equal(full.join(' '), words(1076));
  assert.throws(() => splitSpeechText(words(1111)), /phrase limit/);
  assert.throws(() => splitSpeechText('word '.repeat(2400).trim()), /phrase limit/);
});
