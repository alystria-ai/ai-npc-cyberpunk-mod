import {test} from 'node:test';
import assert from 'node:assert/strict';
import {textEmotion, textExpressionSignal} from './text-emotion.mjs';

test('clear cues map to one feeling; weak, mixed or negated text stays neutral', () => {
  assert.deepEqual(textEmotion("Haha, that was preem! Best night in ages, choom."), {emotion: 'Joy', scale: 1});
  assert.deepEqual(textEmotion('I miss him. Jackie was family, and now he is gone. Sorry.'), {emotion: 'Sadness', scale: 1});
  assert.deepEqual(textEmotion('Those bastards betrayed us. I hate them, I swear they will pay!'), {emotion: 'Anger', scale: 1});
  assert.deepEqual(textEmotion('Wow, no way! You actually pulled it off?'), {emotion: 'Surprise', scale: 1});
  for (const neutral of ['Sure, meet me at the Afterlife at nine.', 'I am not happy about this.', 'Great.',
    "Glad you're here, sorry it took so long.", '', '   ', null])
    assert.equal(textEmotion(neutral), undefined, String(neutral));
  assert.equal(textEmotion('Haha! Amazing, wonderful, perfect, I love it, best day ever, hell yeah!').scale, 2);
});

test('the local expression signal has the exact shape the receipt path admits', () => {
  assert.deepEqual(textExpressionSignal('I miss him. Jackie is gone. Sorry.'),
    {version: 1, correlated: true, sequence: 0, emotion: 'Sadness', scale: 1, basis: 'text'});
  assert.equal(textExpressionSignal('Okay.'), undefined);
});
