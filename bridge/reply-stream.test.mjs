import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReplyStream, sentenceEnds, pickHead} from './reply-stream.mjs';
import {TurnClock, withClock} from './turn-clock.mjs';

const isTag = group => /^\{(?:joy|sad|anger)(?::(?:subtle|strong))?\}$/.test(group);

test('sentence ends need a space and more text after the stop, and skip abbreviations and decimals', () => {
  assert.deepEqual(sentenceEnds('Hey V. Listen to me. Dr. Smith is here! Mr. Hands knows. And 3. fine. Done'), [6, 20, 39, 56, 69]);
  assert.equal(sentenceEnds('One sentence only.').length, 0, 'a stop at the very end may be followed by more');
  assert.deepEqual(sentenceEnds('Wait... what? No way.'), [7, 13]);
  assert.equal(sentenceEnds('It costs 3.5 eddies. Fine.').length, 1);
  assert.deepEqual(sentenceEnds('Mr. Hands knows. Ok. Go on'), [16, 20], '"Ok." and "Mr." are told apart');
});

test('the head is the first sentences up to the minimum length', () => {
  assert.equal(pickHead('Hey. Come here and sit down with me for a while. Ok')?.text, 'Hey. Come here and sit down with me for a while.');
  assert.equal(pickHead('Good to see you again, V. What can I do? Tell me')?.text, 'Good to see you again, V. What can I do?');
  assert.equal(pickHead('Good to see you here again, V. What can I do?')?.text, 'Good to see you here again, V.');
  assert.equal(pickHead('Hey V. Short. Another short one.'), null, 'sentences too short to make a head yet and nothing after the last stop');
  assert.equal(pickHead('Well I never. '), null);
  assert.equal(pickHead(''), null);
});

test('nothing the cleaning could still change is committed as a head', () => {
  for (const text of ['Hey V, [laughter] good to see you here again. What?', 'Hey V {joy} good to see you here again. What?',
    'I told him (twice) that it was a bad idea for us. What?', 'She said *nothing at all* to me about it today. What?',
    '"Good to see you here again, V. Really," she said. What?', 'As an AI language model I cannot say that to you. What?',
    'The user wants me to greet them with a warm hello. What?']) {
    assert.equal(pickHead(text), null, text);
  }
  assert.ok(pickHead('I told him twice that it was a bad idea for us. What?'));
});

test('a stream commits its head once, announces it, and keeps it when the reply ends', async () => {
  const stream = new ReplyStream({name: 'Judy', isTag});
  let changes = 0; stream.onChange(() => changes++);
  stream.update('Judy: Hey V,');
  assert.equal(stream.head, null);
  stream.update('Judy: Hey V, good to see you here again.');
  assert.equal(stream.head, null, 'no more text after the stop yet');
  stream.update('Judy: Hey V, good to see you here again. What can');
  assert.equal(stream.head, 'Hey V, good to see you here again.', 'the speaker label is cleaned off');
  assert.equal(await stream.headReady, 'Hey V, good to see you here again.');
  stream.update('Judy: Hey V, good to see you here again. What can I do for you today?');
  assert.equal(stream.text, 'Hey V, good to see you here again.');
  assert.equal(stream.complete, false);
  assert.equal(stream.finish('Hey V, good to see you here again. What can I do for you today?'),
    'Hey V, good to see you here again. What can I do for you today?');
  assert.equal(stream.tail, 'What can I do for you today?');
  assert.equal(await stream.finished, 'Hey V, good to see you here again. What can I do for you today?');
  assert.equal(changes, 2, 'one change for the head, one for the end');
});

test('a reply that finishes before any head resolves the head with null', async () => {
  const stream = new ReplyStream({name: 'Judy'});
  stream.update('Sure.');
  stream.finish('Sure.');
  assert.equal(await stream.headReady, null);
  assert.equal(stream.head, null);
  assert.equal(stream.tail, '');
});

test('a failure before the head releases the waiter with null; after the head the finish promise rejects', async () => {
  const early = new ReplyStream({name: 'Judy'});
  early.fail(Error('boom'));
  assert.equal(await early.headReady, null);
  await assert.rejects(early.finished, /boom/);
  const late = new ReplyStream({name: 'Judy'});
  late.update('Hey V, good to see you here again. What can');
  assert.ok(late.head);
  late.fail(Error('network'));
  assert.equal(late.complete, true);
  await assert.rejects(late.finished, /network/);
});

test('a second attempt before any head starts clean; after a head it is ignored and the reply is cut back to the head', () => {
  const stream = new ReplyStream({name: 'Judy'});
  stream.update('As an AI language model I cannot say that to you. Ok');
  assert.equal(stream.head, null);
  stream.update('Hey V, good to see you here again. What can');
  assert.equal(stream.attempts, 2);
  assert.equal(stream.head, 'Hey V, good to see you here again.');
  stream.update('Totally different words begin the next try. And more words');
  assert.equal(stream.diverged, true);
  assert.equal(stream.head, 'Hey V, good to see you here again.');
  assert.equal(stream.reconcile('Totally different words begin the next try. And more words.'), 'Hey V, good to see you here again.');
  assert.equal(stream.reconcile('Hey V, good to see you here again. What can I do?'), 'Hey V, good to see you here again. What can I do?');
});

test('a stream that only watches never commits but still marks the first sentence on the turn clock', () => {
  const clock = new TurnClock({origin: 0});
  const stream = new ReplyStream({name: 'Judy', speak: false});
  withClock(clock, () => stream.update('Hey V, good to see you here again. What can'));
  assert.equal(stream.head, null);
  assert.equal(clock.has('firstSentence'), true);
});

test('the first sentence is marked even when it is too short to be the head', () => {
  const clock = new TurnClock({origin: 0});
  const stream = new ReplyStream({name: 'Judy'});
  withClock(clock, () => stream.update('Hey. Yes? Okay'));
  assert.equal(clock.has('firstSentence'), true);
  assert.equal(stream.head, null);
});
