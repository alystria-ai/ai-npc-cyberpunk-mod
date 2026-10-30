// The quest link's clock (bridge/quest-poller.mjs): a 500 ms poll that exists only while a quest is active. Offline, with a fake timer and a fake link.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createQuestPoller} from './quest-poller.mjs';

function fixture({active = false, stopped = false} = {}) {
  const state = {active, stopped, polls: 0, syncs: 0, timers: new Set(), made: 0, cleared: 0, errors: [], pollError: null, syncError: null, hold: null};
  const link = {
    active: () => state.active,
    async poll() { state.polls++; if (state.hold) await state.hold; if (state.pollError) throw state.pollError; },
    async sync() { state.syncs++; if (state.syncError) throw state.syncError; },
  };
  const poller = createQuestPoller({link, stopped: () => state.stopped, onError: error => state.errors.push(error.message),
    setTimer: (fn, ms) => { const timer = {fn, ms, unref() { this.unrefed = true; }}; state.timers.add(timer); state.made++; return timer; },
    clearTimer: timer => { state.timers.delete(timer); state.cleared++; }});
  return {state, poller, tick: () => [...state.timers].forEach(timer => timer.fn())};
}
const settle = () => new Promise(done => setTimeout(done, 5));

test('with no quest there is no timer, however often the state is synced', async () => {
  const {state, poller} = fixture();
  assert.equal(poller.arm(), false);
  for (let n = 0; n < 5; n++) await poller.sync();
  assert.equal(state.made, 0); assert.equal(state.timers.size, 0); assert.equal(poller.armed, false);
  assert.equal(state.syncs, 5, 'the play file still follows the pack state');
  assert.equal(state.polls, 0, 'the events file is never read');
});

test('a quest turns on a 500 ms timer (unref\'d), one only, that polls the events and syncs the play file; the end of the quest turns it off', async () => {
  const {state, poller, tick} = fixture();
  state.active = true;
  await poller.sync(); await poller.sync();
  assert.equal(state.made, 1, 'one timer'); assert.equal([...state.timers][0].ms, 500); assert.equal([...state.timers][0].unrefed, true); assert.equal(poller.armed, true);
  tick(); await settle();
  assert.equal(state.polls, 1); assert.equal(state.syncs, 3, 'each poll syncs too');
  state.active = false;
  tick(); await settle();
  assert.equal(state.timers.size, 0, 'the poll that saw the quest end removed the timer'); assert.equal(poller.armed, false); assert.equal(state.cleared, 1);
  const last = state.polls;
  tick(); await settle();
  assert.equal(state.polls, last, 'nothing runs afterwards');
});

test('a poll that is still running is not started twice, and a failing link is reported without stopping the clock', async () => {
  const {state, poller, tick} = fixture({active: true});
  poller.arm();
  let release; state.hold = new Promise(done => { release = done; });
  tick(); tick(); tick();
  await settle();
  assert.equal(state.polls, 1, 'one poll at a time');
  release(); await settle();
  state.hold = null; state.pollError = Error('bad events file');
  tick(); await settle();
  assert.deepEqual(state.errors, ['bad events file']);
  assert.equal(poller.armed, true, 'the next poll still comes');
  state.pollError = null; state.syncError = Error('disk full');
  await poller.sync();
  assert.deepEqual(state.errors, ['bad events file', 'disk full']);
});

test('a stopped service starts no timer and polls nothing; stop() removes the timer', async () => {
  const {state, poller, tick} = fixture({active: true});
  poller.arm();
  assert.equal(poller.armed, true);
  poller.stop();
  assert.equal(poller.armed, false); assert.equal(state.timers.size, 0);
  state.stopped = true;
  assert.equal(poller.arm(), false); await poller.poll(); await poller.sync();
  assert.equal(state.made, 1); assert.equal(state.polls, 0);
  tick();
  assert.equal(state.polls, 0);
});

test('a link whose active() throws is reported and counts as no quest', async () => {
  const {state, poller} = fixture();
  state.active = true;
  const broken = createQuestPoller({link: {active() { throw Error('no state'); }, async poll() {}, async sync() {}}, onError: error => state.errors.push(error.message), setTimer: () => assert.fail('no timer'), clearTimer() {}});
  assert.equal(broken.arm(), false);
  assert.deepEqual(state.errors, ['no state']);
  await poller.sync();
  assert.equal(poller.armed, true);
});
