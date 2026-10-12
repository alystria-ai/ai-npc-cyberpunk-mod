import {test} from 'node:test';
import assert from 'node:assert/strict';
import {STEERING, instructionFor, plainText, steerText} from './inworld-steering.mjs';

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
  assert.deepEqual(steerText('Hello there.', [{at: 0, name: 'calm'}]), {text: 'Hello there.', tags: 0});
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
  assert.deepEqual(steerText('Short.', [{at: 99, name: 'joy'}]), {text: 'Short.', tags: 0});
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
  assert.deepEqual(result, {text: 'Fine text.', tags: 0});
  assert.deepEqual(steerText(undefined, undefined), {text: '', tags: 0});
});
