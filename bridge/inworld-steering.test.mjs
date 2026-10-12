import {test} from 'node:test';
import assert from 'node:assert/strict';
import {STEERING, SOUNDS, MAX_SOUNDS, instructionFor, plainText, steerText, soundFor, fallbackMarks} from './inworld-steering.mjs';

const FEELINGS = ['joy', 'warm', 'interest', 'surprise', 'sadness', 'fear', 'anger', 'disgust', 'calm'];

test('every Expressive feeling has an instruction, in lower case English without punctuation, and calm is a reset', () => {
  assert.deepEqual(Object.keys(STEERING).sort(), [...FEELINGS].sort());
  for (const name of FEELINGS.filter(name => name !== 'calm')) {
    for (const strength of ['subtle', 'strong']) {
      const tag = instructionFor({name, strength});
      assert.match(tag, /^\[[a-z ]+\]$/, `${name} ${strength}`);
    }
    assert.notEqual(instructionFor({name, strength: 'subtle'}), instructionFor({name, strength: 'strong'}));
  }
  assert.equal(instructionFor({name: 'calm'}), '[reset]');
  assert.equal(instructionFor({name: 'unknown'}), null);
  assert.equal(instructionFor(null), null);
});

test('an instruction goes in front of the word each mark precedes; the words themselves are untouched', () => {
  const text = 'Work is work. But I mean, it hurts.';
  const at = text.indexOf('But');
  const result = steerText(text, [{at, name: 'sadness', strength: 'strong'}]);
  assert.equal(result.text, 'Work is work. [slow and hushed with every word weighted by grief] But I mean, it hurts.');
  assert.equal(result.tags, 1);
  const two = steerText(text, [{at: 0, name: 'joy', strength: 'subtle'}, {at, name: 'calm', strength: 'subtle'}]);
  assert.equal(two.text, '[say with warm amusement] Work is work. [reset] But I mean, it hurts.');
  assert.equal(two.tags, 2);
});

test('a calm mark with nothing in force and a repeated instruction add nothing', () => {
  assert.deepEqual(steerText('Hello there.', [{at: 0, name: 'calm'}]), {text: 'Hello there.', tags: 0, sounds: 0});
  const repeated = steerText('One two three.', [{at: 0, name: 'anger'}, {at: 4, name: 'anger'}]);
  assert.equal(repeated.tags, 1);
  assert.equal(repeated.text, '[say with controlled irritation] One two three.');
});

test('a tail request starts in the feeling that was in force where it begins, and marks before it are not repeated', () => {
  const whole = 'Back off. Touch her again.';
  const from = whole.indexOf('Touch');
  const result = steerText('Touch her again.', [{at: 0, name: 'anger', strength: 'strong'}], {from});
  assert.equal(result.text, '[speak as if barely holding back rage forcing every word through gritted teeth] Touch her again.');
  const later = steerText('Touch her again.', [{at: from + 10, name: 'fear'}], {from});
  assert.equal(later.text, 'Touch her [sound worried and tense] again.');
  // A mark past the end of the text is ignored.
  assert.deepEqual(steerText('Short.', [{at: 99, name: 'joy'}]), {text: 'Short.', tags: 0, sounds: 0});
});

test('brackets and angle brackets in the text never reach Inworld as markup, and the marks still line up', () => {
  assert.equal(plainText('a [sigh] b <break/> c'), 'a sigh b break/ c');
  const text = 'Hi [laugh] there friend';
  const at = text.indexOf('there');
  const result = steerText(text, [{at, name: 'surprise'}]);
  assert.equal(result.text, 'Hi laugh [sound surprised] there friend');
});

test('bad marks are skipped, not thrown on', () => {
  const result = steerText('Fine text.', [null, {at: 'x', name: 'joy'}, {at: 0}, {at: 0, name: 'nonsense'}]);
  assert.deepEqual(result, {text: 'Fine text.', tags: 0, sounds: 0});
  assert.deepEqual(steerText(undefined, undefined), {text: '', tags: 0, sounds: 0});
});

test('sounds: our tag names map onto Inworld sounds where one matches, and the rest are not spoken', () => {
  assert.deepEqual([...new Set(Object.values(SOUNDS))].sort(), ['[breathe]', '[clear throat]', '[cough]', '[laugh]', '[sigh]', '[yawn]']);
  assert.equal(soundFor('laughter'), '[laugh]'); assert.equal(soundFor('Laugh'), '[laugh]'); assert.equal(soundFor('sigh'), '[sigh]');
  for (const none of ['confirmation-en', 'question-en', 'question-ah', 'question-oh', 'surprise-ah', 'surprise-oh', 'dissatisfaction-hnn', 'surprise-wa', 'nonsense', '', null, 7])
    assert.equal(soundFor(none), null, String(none));
  // At the word they precede; at the end for a trailing one; an unmatched tag leaves no trace in the text.
  const text = 'I told him no, and he still showed up.';
  const at = text.indexOf('and');
  assert.deepEqual(steerText(text, [], {sounds: [{at, name: 'laughter'}]}), {text: 'I told him no, [laugh] and he still showed up.', tags: 0, sounds: 1});
  assert.deepEqual(steerText(text, [], {sounds: [{at, name: 'question-oh'}]}), {text, tags: 0, sounds: 0});
  assert.equal(steerText('Fine.', null, {sounds: [{at: 5, name: 'sigh'}]}).text, 'Fine. [sigh]');
  // A feeling and a sound before the same word: the feeling first, the sound after it.
  assert.equal(steerText('Oh no.', [{at: 0, name: 'sadness'}], {sounds: [{at: 0, name: 'sigh'}]}).text, '[say sadly in a quiet low voice] [sigh] Oh no.');
  // Never more than two a request, never the same sound twice in a row.
  const many = steerText('a b c d e f', [], {sounds: [{at: 0, name: 'laugh'}, {at: 2, name: 'laugh'}, {at: 4, name: 'sigh'}, {at: 6, name: 'breathe'}]});
  assert.equal(MAX_SOUNDS, 2); assert.equal(many.sounds, 2); assert.equal(many.text, '[laugh] a b [sigh] c d e f');
  // The tail of a reply voiced in two parts counts from where it begins; a sound that belongs to the first part is not repeated.
  assert.deepEqual(steerText('b c d', [], {from: 2, sounds: [{at: 0, name: 'laugh'}, {at: 4, name: 'sigh'}]}), {text: 'b [sigh] c d', tags: 0, sounds: 1});
});

test('with no feeling tag the words are read for a clear one, with one mark at the start, and a weak or unclear text stays plain', () => {
  const sad = fallbackMarks('I am so sorry, V. I really miss him.');
  assert.equal(sad.length, 1); assert.equal(sad[0].name, 'sadness'); assert.equal(sad[0].at, 0); assert.ok(['subtle', 'strong'].includes(sad[0].strength));
  assert.equal(fallbackMarks('Back off! I will kill them, you hear me? Enough!')[0].name, 'anger');
  assert.equal(fallbackMarks('Haha, that is hilarious, we did it!')[0].name, 'joy');
  assert.equal(fallbackMarks('Thank you. I trust you, V.')[0].name, 'warm');
  for (const plain of ['Meet me at the corner at nine.', '', '   ', 'Okay.']) assert.deepEqual(fallbackMarks(plain), [], plain);
  assert.deepEqual(fallbackMarks(null), []);
});
