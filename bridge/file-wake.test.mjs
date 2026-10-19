import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, rmSync, writeFileSync, renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {watchFiles, createWakeSignal} from './file-wake.mjs';

function fakeWatch() {
  const state = {listener: null, watcher: null, options: null, directory: null};
  state.watch = (directory, options, listener) => {
    Object.assign(state, {directory, options, listener});
    state.watcher = Object.assign(new EventEmitter(), {closed: false, close() { this.closed = true; }});
    return state.watcher;
  };
  return state;
}
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => { const timer = {fn, ms, cleared: false, unref() { timer.unrefed = true; }}; timers.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.cleared = true; },
    run() { for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn(); },
  };
}

test('an event for a watched file runs its handler once after the delay; other files are ignored', () => {
  const fs = fakeWatch(), clock = fakeTimers();
  const calls = [];
  const wake = watchFiles('R', {'last-input.json': () => calls.push('input'), 'microphone-command.json': () => calls.push('mic')},
    {watch: fs.watch, setTimer: clock.setTimer, clearTimer: clock.clearTimer, delayMs: 4});
  assert.equal(wake.active, true);
  assert.equal(fs.directory, 'R');
  assert.equal(fs.options.persistent, false, 'the watcher never keeps the bridge alive');
  fs.listener('rename', 'last-input.json.3f2a.tmp');
  fs.listener('change', 'continuous-face.json');
  assert.equal(clock.timers.length, 0);
  fs.listener('rename', 'last-input.json');
  fs.listener('change', 'last-input.json');
  fs.listener('change', Buffer.from('microphone-command.json'));
  assert.equal(clock.timers.length, 2, 'one timer per file for a burst of events');
  assert.equal(clock.timers[0].ms, 4);
  assert.ok(clock.timers.every(timer => timer.unrefed));
  assert.deepEqual(calls, []);
  clock.run();
  assert.deepEqual(calls, ['input', 'mic']);
  fs.listener('change', 'last-input.json');
  clock.run();
  assert.deepEqual(calls, ['input', 'mic', 'input'], 'a later change wakes it again');
});

test('a throwing or rejecting handler, a null filename and events after close() are harmless', async () => {
  const fs = fakeWatch(), clock = fakeTimers();
  let rejected = 0;
  const wake = watchFiles('R', {'a.json': () => { throw Error('boom'); }, 'b.json': () => { rejected++; return Promise.reject(Error('later')); }},
    {watch: fs.watch, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
  fs.listener('change', null);
  fs.listener('change', 'a.json'); fs.listener('change', 'b.json');
  clock.run();
  await new Promise(done => setImmediate(done));
  assert.equal(rejected, 1);
  fs.listener('change', 'a.json');
  wake.close();
  assert.equal(fs.watcher.closed, true);
  assert.equal(wake.active, false);
  assert.ok(clock.timers.every(timer => timer.cleared), 'a pending wake is cancelled');
  fs.listener('change', 'b.json');
  clock.run();
  assert.equal(rejected, 1);
  wake.close();
});

test('a watcher that cannot start or fails later leaves only the polls, and says so once', () => {
  const lines = [];
  const none = watchFiles('R', {'a.json': () => {}}, {watch: () => { throw Object.assign(Error('no'), {code: 'ENOSYS'}); }, log: line => lines.push(line)});
  assert.equal(none.active, false);
  assert.match(lines[0], /unavailable \(ENOSYS\)/);
  const fs = fakeWatch();
  const later = watchFiles('R', {'a.json': () => {}}, {watch: fs.watch, log: line => lines.push(line)});
  fs.watcher.emit('error', Object.assign(Error('gone'), {code: 'EPERM'}));
  assert.equal(later.active, false);
  assert.equal(fs.watcher.closed, true);
  assert.match(lines[1], /stopped \(EPERM\)/);
  const empty = watchFiles('R', {}, {watch: () => { throw Error('never called'); }});
  assert.equal(empty.active, false);
});

test('the real watcher sees an atomic replace (temp file and rename) of a watched file', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'file-wake-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  let woke;
  const seen = new Promise(done => { woke = done; });
  const wake = watchFiles(directory, {'last-input.json': () => woke(performance.now())});
  t.after(() => wake.close());
  assert.equal(wake.active, true);
  await new Promise(done => setTimeout(done, 50));
  const started = performance.now();
  writeFileSync(join(directory, 'last-input.json.tmp'), '{"requestId":"1"}');
  renameSync(join(directory, 'last-input.json.tmp'), join(directory, 'last-input.json'));
  const at = await Promise.race([seen, new Promise(done => setTimeout(() => done(null), 2000))]);
  assert.ok(at !== null, 'the handler ran');
  assert.ok(at - started < 500, `woke after ${Math.round(at - started)} ms`);
});

// The game rewrites last-input.json in place over the placeholder that ships empty (Mod Organizer 2): the same wake, with no rename.
test('the real watcher sees an in-place write over an existing watched file, and a write of an empty file', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'file-wake-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  writeFileSync(join(directory, 'last-input.json'), '');
  let wakes = 0, woke;
  let seen = new Promise(done => { woke = done; });
  const wake = watchFiles(directory, {'last-input.json': () => { wakes++; woke(performance.now()); }});
  t.after(() => wake.close());
  assert.equal(wake.active, true);
  await new Promise(done => setTimeout(done, 50));
  let started = performance.now();
  writeFileSync(join(directory, 'last-input.json'), '{"requestId":"1"}');
  let at = await Promise.race([seen, new Promise(done => setTimeout(() => done(null), 2000))]);
  assert.ok(at !== null, 'the handler ran for the in-place write');
  assert.ok(at - started < 500, `woke after ${Math.round(at - started)} ms`);
  seen = new Promise(done => { woke = done; });
  started = performance.now();
  writeFileSync(join(directory, 'last-input.json'), '');
  at = await Promise.race([seen, new Promise(done => setTimeout(() => done(null), 2000))]);
  assert.ok(at !== null, 'the handler ran for the empty write (the withdrawal)');
  assert.ok(wakes >= 2);
});

test('a wake signal resolves its waiters when fired, and a fire nobody waited for is not lost', async () => {
  const signal = createWakeSignal();
  let woke = 0;
  const first = signal.next().then(() => { woke++; });
  const second = signal.next();
  assert.equal(first === second, false);
  await new Promise(done => setTimeout(done, 5));
  assert.equal(woke, 0, 'nothing resolves before a fire');
  signal.fire();
  await first; await second;
  assert.equal(woke, 1);
  // Nobody waiting: the fire is kept for the next wait (and only for one).
  signal.fire(); signal.fire();
  let early = false;
  await signal.next().then(() => { early = true; });
  assert.equal(early, true);
  let pending = true;
  signal.next().then(() => { pending = false; });
  await new Promise(done => setTimeout(done, 5));
  assert.equal(pending, true, 'the kept fire was used once');
  signal.fire();
  await new Promise(done => setTimeout(done, 5));
  assert.equal(pending, false);
});

test('a file with delay 0 runs its handler on the next turn of the event loop, never on a timer, and close() cancels it', async () => {
  const fs = fakeWatch(), clock = fakeTimers();
  const calls = [];
  const wake = watchFiles('R', {'continuous-control.json': () => calls.push('lease'), 'last-input.json': () => calls.push('input')},
    {watch: fs.watch, setTimer: clock.setTimer, clearTimer: clock.clearTimer, delays: {'continuous-control.json': 0}});
  fs.listener('change', 'continuous-control.json');
  fs.listener('change', 'continuous-control.json');
  fs.listener('change', 'last-input.json');
  assert.equal(clock.timers.length, 1, 'only the request file waits on a timer');
  assert.equal(clock.timers[0].ms, 4);
  assert.deepEqual(calls, [], 'nothing runs inside the watcher callback');
  await new Promise(done => setImmediate(done));
  assert.deepEqual(calls, ['lease'], 'one run for the burst, on the next turn of the loop');
  fs.listener('change', 'continuous-control.json');
  wake.close();
  await new Promise(done => setImmediate(done));
  assert.deepEqual(calls, ['lease'], 'a pending immediate wake is cancelled by close()');
});
