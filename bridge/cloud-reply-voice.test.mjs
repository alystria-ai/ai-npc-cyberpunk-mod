import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReplyVoice} from './cloud-reply-voice.mjs';

test('only the first part of a reply claims the decision', () => {
  const reply = new ReplyVoice();
  assert.equal(reply.claim(), true);
  assert.equal(reply.claim(), false);
  assert.equal(reply.engine, null);
});

test('the first decision stands; later ones change nothing', () => {
  const reply = new ReplyVoice();
  assert.equal(reply.decide('inworld'), 'inworld');
  assert.equal(reply.decide('pocket'), 'inworld');
  assert.equal(reply.engine, 'inworld');
});

test('a later part waits for the decision, then follows it', async () => {
  const reply = new ReplyVoice();
  const first = reply.decision(), second = reply.decision();
  let settled = 0; first.then(() => settled++); second.then(() => settled++);
  await new Promise(done => setTimeout(done, 10));
  assert.equal(settled, 0);
  reply.decide('pocket');
  assert.deepEqual(await Promise.all([first, second]), ['pocket', 'pocket']);
  assert.equal(await reply.decision(), 'pocket');
});

test('a part that is cancelled while waiting stops waiting and leaves no waiter behind', async () => {
  const reply = new ReplyVoice();
  const controller = new AbortController();
  const waiting = reply.decision(controller.signal);
  assert.equal(reply.waiters.size, 1);
  controller.abort();
  await assert.rejects(waiting);
  assert.equal(reply.waiters.size, 0);
  const already = new AbortController(); already.abort();
  await assert.rejects(new ReplyVoice().decision(already.signal));
});
