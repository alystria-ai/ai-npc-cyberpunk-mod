import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync, rmSync, writeFileSync, renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {watchFiles} from './file-wake.mjs';

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
