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

test('the first phrase is at most 24 words (without marks), the second at most 24 and later ones at most 40, and no phrase is an isolated tail of fewer than four words', () => {
  const text = Array.from({length: 150}, (_, n) => `word${n}`).join(' ');
  const phrases = splitSpeechText(text), counts = phrases.map(phrase => phrase.split(' ').length);
  assert.ok(counts[0] <= 24 && counts[1] <= 24, `first phrases ${counts[0]} ${counts[1]}`);
  assert.ok(counts.slice(1).every(count => count <= 40), counts.join(','));
  assert.ok(counts.length < 2 || counts.at(-1) >= 4);
  // A tail of fewer than four words joins the phrase before it; four words stay a phrase of their own.
  const words = count => Array.from({length: count}, (_, n) => `w${n}`).join(' ');
  assert.deepEqual(splitSpeechText(words(24)).map(phrase => phrase.split(' ').length), [24]);
  assert.deepEqual(splitSpeechText(words(27)).map(phrase => phrase.split(' ').length), [27]);
  assert.deepEqual(splitSpeechText(words(28)).map(phrase => phrase.split(' ').length), [24, 4]);
});

test('the second phrase is ready in time (24 words), later phrases keep sentences together up to 40 words, and a comma is a cut only where no sentence end fits', () => {
  const sentence = count => Array.from({length: count}, (_, n) => `w${n}`).join(' ') + '.';
  // First phrase: the first sentence. The second is one sentence (two would pass 24 words); from the third on, 15 + 15 words are one phrase.
  const text = [sentence(8), sentence(15), sentence(15), sentence(15)].join(' ');
  assert.deepEqual(splitSpeechText(text).map(phrase => phrase.split(' ').length), [8, 15, 30]);
  // A second sentence too long for 24 words is not cut: it ends at its own end when that is within 40.
  assert.deepEqual(splitSpeechText([sentence(8), sentence(33), sentence(10)].join(' ')).map(phrase => phrase.split(' ').length), [8, 33, 10]);
  // A long sentence with commas and a short one after it: the sentence end, not a comma, is where the phrase stops.
  const commas = Array.from({length: 4}, (_, n) => `a${n}1 a${n}2 a${n}3 a${n}4 a${n}5 a${n}6,`).join(' ').replace(/,$/, '.');
  const mixed = splitSpeechText([sentence(7), commas, sentence(9)].join(' '));
  assert.deepEqual(mixed, [sentence(7), commas, sentence(9)], 'cut at the sentence ends, never at the commas inside the long sentence');
  // No sentence end inside the limit: the last comma that fits, not a cut mid-clause.
  const run = Array.from({length: 12}, (_, n) => `r${n}1 r${n}2 r${n}3 r${n}4,`).join(' ');
  const cut = splitSpeechText(run);
  assert.ok(cut.slice(0, -1).every(phrase => /,$/.test(phrase)), cut.join(' | '));
  assert.equal(cut.join(' '), run);
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
  // Without any punctuation the first two phrases are 24 words, then 40: 24 + 24 + 30 x 40 = 1248 words fill exactly 32 phrases.
  const full = splitSpeechText(words(1248));
  assert.equal(full.length, 32); assert.equal(full.join(' '), words(1248));
  assert.throws(() => splitSpeechText(words(1253)), /phrase limit/);
  assert.throws(() => splitSpeechText('word '.repeat(2400).trim()), /phrase limit/);
});
