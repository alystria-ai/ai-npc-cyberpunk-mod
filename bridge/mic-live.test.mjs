import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MicTap} from './mic-tap.mjs';
import {MicLive} from './mic-live.mjs';

const tick = (ms = 5) => new Promise(done => setTimeout(done, ms));

function setup({allowed = false} = {}) {
  const log = [];
  let sink = null, open = false;
  const capture = {log, get open() { return open; },
    emit: chunk => sink?.(chunk),
    begin: async onChunk => { log.push('begin'); sink = onChunk; open = true; return {device: 'Fake microphone'}; },
    end: async () => { log.push('end'); sink = null; open = false; },
    abort: async () => { log.push('abort'); sink = null; open = false; }};
  let file = '';
  const timers = [];
  let live;
  const tap = new MicTap({capture, onRelease: () => live.afterRelease()});
  live = new MicLive({tap, read: async () => file, setTimer: (fn, ms) => { const t = {fn, ms, unref() {}}; timers.push(t); return t; }, clearTimer: t => { if (t) t.cancelled = true; }});
  live.setAllowed(allowed);
  const write = value => { file = typeof value === 'string' ? value : JSON.stringify(value); return live.poll(); };
  return {capture, tap, live, write, timers};
}

test('the key press opens the microphone at once, before any turn exists, and the release stops it on the spot', async () => {
  const {capture, tap, write} = setup();
  await write({n: 1, holdId: 'k-1', down: true, listen: false});
  await tick();
  assert.deepEqual(capture.log, ['begin']);
  assert.equal(tap.owner, 'hold:k-1'); assert.equal(capture.open, true);
  capture.emit(Buffer.alloc(1280, 1));
  await write({n: 2, holdId: 'k-1', down: false, listen: false});
  await tick();
  assert.deepEqual(capture.log, ['begin', 'end']);
  assert.equal(capture.open, false, 'the device is closed at the release');
});

test('a repeated read of the same file does nothing, and a bad file or id is ignored', async () => {
  const {capture, write} = setup();
  await write({holdId: 'k-2', down: true}); await write({holdId: 'k-2', down: true}); await tick();
  assert.equal(capture.log.filter(line => line === 'begin').length, 1);
  await write('not json'); await write('{"holdId":"bad id with spaces","down":true}'); await write('null'); await tick();
  assert.equal(capture.log.filter(line => line === 'begin').length, 1);
});

test('a listen request opens nothing while Voice activation is off, and opens the listening tap when it is on', async () => {
  const {capture, tap, live, write} = setup({allowed: false});
  await write({n: 1, listen: true}); await tick();
  assert.deepEqual(capture.log, [], 'the setting is off: the microphone stays closed');
  live.setAllowed(true); await tick();
  assert.deepEqual(capture.log, ['begin']);
  assert.equal(tap.listening, true);
  assert.ok(tap.vad, 'the detector runs while listening');
});

test('turning the setting off, or the game closing the request, releases the device and drops the detector', async () => {
  const {capture, tap, live, write} = setup({allowed: true});
  await write({n: 1, listen: true}); await tick();
  assert.equal(tap.listening, true);
  live.setAllowed(false); await tick();
  assert.equal(tap.state, 'closed'); assert.equal(tap.vad, null); assert.equal(capture.open, false);
  assert.ok(capture.log.includes('abort'));
  live.setAllowed(true); await tick();
  assert.equal(tap.listening, true, 'the request is still on: it listens again');
  await write({n: 2, listen: false}); await tick();
  assert.equal(tap.state, 'closed'); assert.equal(capture.open, false);
});

test('a turn that takes the listening tap is not closed by the request going quiet, and listening resumes after the turn when asked', async () => {
  const {capture, tap, live, write, timers} = setup({allowed: true});
  await write({n: 1, listen: true}); await tick();
  tap.open('req-1', {vad: true, sinceMs: 0});
  await write({n: 2, listen: false}); await tick();
  assert.equal(tap.isOwner('req-1'), true, 'the game stops asking while it runs the turn; the turn keeps its microphone');
  assert.equal(capture.open, true);
  await write({n: 3, listen: true}); await tick();
  await tap.release('req-1', 'the recording is over');
  const reopen = timers.filter(t => !t.cancelled).at(-1);
  reopen.fn(); await tick();
  assert.equal(tap.listening, true, 'after the turn it listens again');
  assert.equal(capture.log.filter(line => line === 'begin').length, 2);
});

test('after a released tap nothing reopens when the game no longer asks, or the setting is off', async () => {
  const {capture, tap, live, write, timers} = setup({allowed: true});
  await write({n: 1, listen: false}); await tick();
  await tap.open('req-2'); await tap.release('req-2');
  timers.filter(t => !t.cancelled).at(-1).fn(); await tick();
  assert.equal(tap.state, 'closed');
  await write({n: 2, listen: true}); await tick();
  live.setAllowed(false); await tick();
  await tap.open('req-3'); await tap.release('req-3');
  timers.filter(t => !t.cancelled).at(-1).fn(); await tick();
  assert.equal(tap.state, 'closed');
  assert.equal(capture.open, false);
});

test('a microphone that cannot open for listening is reported once to the game', async () => {
  const errors = [];
  const capture = {begin: async () => { throw Error('NotAllowedError'); }, end: async () => {}, abort: async () => {}};
  const tap = new MicTap({capture});
  const live = new MicLive({tap, read: async () => '{"listen":true}', onListenError: error => errors.push(error.message)});
  live.setAllowed(true); await live.poll(); await tick();
  assert.deepEqual(errors, ['NotAllowedError']);
  assert.equal(tap.state, 'closed');
});

// ---- the device kept open ------------------------------------------------------------------------------------------------------------------
function warmSetup({warmAllowed = true} = {}) {
  const calls = [];
  let sink = null, warmed = false;
  const capture = {calls, get warmed() { return warmed; },
    emit: chunk => sink?.(chunk),
    warm: async () => { calls.push('warm'); warmed = true; return {device: 'Fake microphone', warm: true}; },
    cool: async () => { calls.push('cool'); warmed = false; },
    begin: async onChunk => { calls.push(warmed ? 'begin (warm)' : 'begin (cold)'); sink = onChunk; return {device: 'Fake microphone'}; },
    end: async () => { calls.push('end'); sink = null; },
    abort: async () => { calls.push('abort'); sink = null; }};
  let file = '', clock = 1_000_000;
  const tap = new MicTap({capture});
  const live = new MicLive({tap, read: async () => file, warmAllowed, now: () => clock, staleMs: 120_000});
  return {capture, tap, live, write: value => { file = JSON.stringify(value); return live.poll(); }, advance: ms => { clock += ms; }, poll: () => live.poll()};
}

test('warm: true keeps the device open before any key press, and the press then finds it open', async () => {
  const {capture, tap, write} = warmSetup();
  await write({n: 1, warm: true}); await tick();
  assert.deepEqual(capture.calls, ['warm']);
  assert.equal(tap.warmWanted, true);
  await write({n: 2, warm: true, holdId: 'k-1', down: true}); await tick();
  assert.deepEqual(capture.calls, ['warm', 'begin (warm)'], 'the press did not have to open the device');
  await write({n: 3, warm: true, holdId: 'k-1', down: false}); await tick();
  await tap.release(undefined, 'done');
  assert.equal(capture.warmed, true, 'the device stays open after the recording');
  assert.ok(!capture.calls.includes('cool'));
});

test('warm: false, or the game gone silent for two minutes, lets the device go; a beat keeps it', async () => {
  const {capture, tap, write, advance, poll} = warmSetup();
  await write({n: 1, warm: true}); await tick();
  advance(100_000); await write({n: 2, warm: true}); advance(100_000); await poll(); await tick();
  assert.equal(tap.warmWanted, true, 'a beat 100 s ago keeps it');
  advance(30_000); await poll(); await tick();
  assert.equal(tap.warmWanted, false, 'no beat for 130 s: the game is gone'); assert.equal(capture.warmed, false);
  await write({n: 3, warm: true}); await tick();
  assert.equal(capture.warmed, true);
  await write({n: 4, warm: false}); await tick();
  assert.equal(capture.warmed, false);
});

test('a device that is in use is let go when the recording ends, not under it', async () => {
  const {capture, tap, live, write} = warmSetup();
  await write({n: 1, warm: true}); await tick();
  await tap.open('req-1');
  await write({n: 2, warm: false}); await tick();
  assert.equal(capture.warmed, true, 'still open: a recording uses it');
  await tap.release('req-1', 'the recording is over'); await tick();
  assert.equal(capture.warmed, false);
  assert.ok(live);
});

test('the warm device comes back after the voice browser was closed (afterRelease), and CYBERPUNK_CONVAI_MIC_WARM=0 keeps it closed', async () => {
  const a = warmSetup();
  await a.write({n: 1, warm: true}); await tick();
  a.capture.warmed2 = false;
  assert.equal(a.tap.warmWanted, true);
  const off = warmSetup({warmAllowed: false});
  await off.write({n: 1, warm: true}); await tick();
  assert.deepEqual(off.capture.calls, [], 'the switch keeps the device closed between recordings');
  await off.write({n: 2, warm: true, holdId: 'k-9', down: true}); await tick();
  assert.deepEqual(off.capture.calls, ['begin (cold)']);
});
