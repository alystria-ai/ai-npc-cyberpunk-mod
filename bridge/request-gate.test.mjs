import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RequestGate} from './request-gate.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a request runs at once while fewer than the limit are running, and release hands the slot on', async () => {
  const gate = new RequestGate({limit: 2});
  const a = await gate.acquire(), b = await gate.acquire();
  let third = false;
  const pending = gate.acquire().then(release => { third = true; return release; });
  await tick(); assert.equal(third, false); assert.equal(gate.stats().waiting, 1);
  a(); a();                                   // releasing twice frees one slot only
  const c = await pending; assert.equal(third, true); assert.equal(gate.stats().running, 2);
  b(); c(); assert.equal(gate.stats().running, 0);
});

test('the speaker being heard goes before a waiting look-ahead, and the look-ahead never has more than its share', async () => {
  const gate = new RequestGate({limit: 3, aheadLimit: 1});
  const order = [];
  const a1 = await gate.acquire({ahead: true});
  let a2; const second = gate.acquire({ahead: true}).then(release => { order.push('ahead-2'); a2 = release; });
  await tick(); assert.deepEqual(order, [], 'a second look-ahead waits although a slot is free');
  const f1 = await gate.acquire(), f2 = await gate.acquire();     // both start at once
  assert.equal(gate.stats().running, 3);
  const queued = []; const third = gate.acquire().then(release => { queued.push('foreground'); return release; });
  await tick();
  f1(); await tick();
  assert.deepEqual(queued, ['foreground'], 'a waiting foreground request takes the freed slot before a waiting look-ahead');
  assert.deepEqual(order, []);
  a1(); await second; assert.deepEqual(order, ['ahead-2']);
  f2(); (await third)(); a2();
  assert.equal(gate.stats().running, 0);
});

test('a refusal tightens the cap for a while, then the cap returns by itself', () => {
  let time = 0;
  const gate = new RequestGate({limit: 4, tightLimit: 2, tightMs: 1000, now: () => time});
  assert.equal(gate.cap, 4); gate.tighten(); assert.equal(gate.cap, 2);
  time = 999; assert.equal(gate.cap, 2); time = 1001; assert.equal(gate.cap, 4);
});

test('a waiting request leaves on abort or after the queue limit, and never runs', async () => {
  const gate = new RequestGate({limit: 1});
  const hold = await gate.acquire();
  const controller = new AbortController();
  const aborted = gate.acquire({signal: controller.signal}); controller.abort(new Error('stop'));
  await assert.rejects(aborted, /stop/);
  await assert.rejects(gate.acquire({maxQueueMs: 20}), {code: 'queue-timeout'});
  await assert.rejects(gate.acquire({signal: controller.signal}), /stop/);
  assert.equal(gate.stats().waiting, 0);
  hold(); assert.equal(gate.stats().running, 0);
  (await gate.acquire())();
});
