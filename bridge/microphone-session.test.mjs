import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {MicrophoneSession} from './microphone-session.mjs';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
function fixture() {
  const opening = deferred(), response = deferred(), states = [], replies = [];
  let stops = 0, finishes = 0;
  const session = new MicrophoneSession({hostFactory: () => ({
    beginVoice: () => opening.promise,
    finishVoice: () => { finishes++; return response.promise; },
    close: async () => { stops++; },
  }), onState: async state => { states.push(state); },
  onReply: async (input, result) => { replies.push([input.requestId, result]); }, onError: async () => { states.push('error'); }});
  return {session, opening, response, states, replies, counts: () => ({stops, finishes})};
}
test('second press while microphone opens finishes it once ready', async () => {
  const f = fixture(); const start = f.session.start({requestId: 'one'}, {});
  await setImmediate(); await f.session.finish('one');
  assert.equal(f.counts().finishes, 0);
  f.opening.resolve(); await setImmediate();
  assert.equal(f.counts().finishes, 1);
  f.response.resolve({text: 'hello'}); await start;
  assert.equal(f.replies.length, 1); assert.ok(f.counts().stops);
});
test('cancel during device opening closes the late device and emits no reply', async () => {
  const f = fixture(); const start = f.session.start({requestId: 'one'}, {});
  await setImmediate(); await f.session.cancel(); f.opening.resolve(); await start;
  assert.equal(f.session.current, null); assert.equal(f.counts().finishes, 0);
  assert.equal(f.replies.length, 0); assert.ok(f.counts().stops);
});
test('game loss discards a late response and stops the owned host', async () => {
  const f = fixture(); const start = f.session.start({requestId: 'one'}, {});
  await setImmediate(); f.opening.resolve(); await start;
  const finish = f.session.finish('one'); await setImmediate();
  await f.session.tick(false); f.response.resolve({text: 'stale'}); await finish;
  assert.equal(f.replies.length, 0); assert.equal(f.session.current, null);
});
