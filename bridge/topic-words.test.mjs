import assert from 'node:assert/strict';
import test from 'node:test';
import {TopicWords} from './topic-words.mjs';

test('a talk keeps the words of everything said so far, in the order they came, and the same sentence again changes nothing', () => {
  const topics = new TopicWords();
  assert.equal(topics.fold('judy', '', 0), '', 'nothing said yet');
  assert.equal(topics.fold('judy', 'Hey Judy, how is Pyramid Song going?', 1000), 'hey judy how pyramid song going');
  assert.equal(topics.fold('judy', 'Hey Judy, how is Pyramid Song going?', 1500), 'hey judy how pyramid song going');
  assert.equal(topics.fold('judy', 'And the Afterlife?', 2000), 'hey judy how pyramid song going and the afterlife');
  assert.equal(topics.fold('judy', '', 3000), 'hey judy how pyramid song going and the afterlife', 'a turn with no words (a reaction) reads the talk as it is');
});

test('another character has its own talk, and a talk quiet for ten minutes starts again', () => {
  const topics = new TopicWords();
  topics.fold('judy', 'pyramid song', 0);
  assert.equal(topics.fold('panam', 'aldecaldos', 10), 'aldecaldos');
  assert.equal(topics.fold('judy', 'afterlife', 599_000), 'pyramid song afterlife');
  assert.equal(topics.fold('judy', 'braindance', 599_000 + 600_001), 'braindance');
  topics.reset('judy');
  assert.equal(topics.fold('judy', '', 1), '');
});

test('the words are bounded: the oldest go first, and only a bounded number of talks are kept', () => {
  const topics = new TopicWords({maxWords: 4, maxTalks: 2});
  topics.fold('a', 'one two three four five six', 0);
  assert.equal(topics.fold('a', '', 1), 'three four five six');
  topics.fold('b', 'bravo', 2); topics.fold('c', 'charlie', 3);
  assert.equal(topics.fold('a', '', 4), '', 'the least recently used talk was dropped');
  assert.equal(topics.fold('c', '', 4), 'charlie');
});
