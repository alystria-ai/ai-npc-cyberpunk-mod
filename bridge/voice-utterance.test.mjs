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
