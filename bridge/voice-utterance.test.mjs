import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Utterance} from './voice-utterance.mjs';

test('the first decision stands, and later ones cannot switch the voice', async () => {
  const utterance = new Utterance();
  assert.equal(utterance.engine, null);
  let seen;
  void utterance.decision.then(engine => { seen = engine; });
  assert.equal(utterance.decide('voxtral'), 'voxtral');
  assert.equal(utterance.decide('pocket'), 'voxtral');
  assert.equal(await utterance.decision, 'voxtral'); assert.equal(seen, 'voxtral'); assert.equal(utterance.engine, 'voxtral');
});

test('anything that is not the cloud voice is Pocket, and a finished head result settles an undecided utterance', () => {
  assert.equal(new Utterance().decide('something else'), 'pocket');
  assert.equal(new Utterance().settle({provider: 'voxtral'}), 'voxtral');
  assert.equal(new Utterance().settle({engine: 'voxtral'}), 'voxtral');
  assert.equal(new Utterance().settle({timing: {voiceEngine: 'voxtral'}}), 'voxtral');
  assert.equal(new Utterance().settle({provider: 'pocket'}), 'pocket');
  assert.equal(new Utterance().settle(undefined), 'pocket');
  const decided = new Utterance(); decided.decide('voxtral');
  assert.equal(decided.settle({provider: 'pocket'}), 'voxtral', 'a head that already played in the cloud voice stays decided');
});

test('every cloud voice can decide, and anything else is Pocket', () => {
  assert.equal(new Utterance().decide('inworld'), 'inworld');
  assert.equal(new Utterance().settle({provider: 'inworld'}), 'inworld');
  assert.equal(new Utterance().settle({engine: 'inworld'}), 'inworld');
  assert.equal(new Utterance().settle({timing: {voiceEngine: 'inworld'}}), 'inworld');
  const decided = new Utterance(); decided.decide('inworld');
  assert.equal(decided.decide('voxtral'), 'inworld', 'one reply, one cloud voice');
  assert.equal(decided.decide('pocket'), 'inworld');
});

test('a later part waits for the decision and follows it', async () => {
  const utterance = new Utterance();
  const first = utterance.wait(), second = utterance.wait(new AbortController().signal);
  let settled = 0; first.then(() => settled++); second.then(() => settled++);
  await new Promise(done => setTimeout(done, 10));
  assert.equal(settled, 0);
  utterance.decide('pocket');
  assert.deepEqual(await Promise.all([first, second]), ['pocket', 'pocket']);
  assert.equal(await utterance.wait(), 'pocket');
});

test('a part that is cancelled while waiting stops waiting', async () => {
  const utterance = new Utterance();
  const controller = new AbortController();
  const waiting = utterance.wait(controller.signal);
  controller.abort();
  await assert.rejects(waiting);
  const already = new AbortController(); already.abort();
  await assert.rejects(new Utterance().wait(already.signal));
  // A later decision does not resurrect or throw for the cancelled waiter.
  utterance.decide('inworld');
  assert.equal(await utterance.wait(new AbortController().signal), 'inworld');
});
