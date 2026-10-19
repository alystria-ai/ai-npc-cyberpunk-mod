import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {AUDIO_DELAY_CHOICES, AudioOutputWatch, BLUETOOTH_DELAY_MS, audioDelayMs, resolveDelayMs,
  setAudioDelayMs, settingDelay} from './audio-delay.mjs';
import {playbackControl} from './continuous-pcm-core.mjs';
import {ContinuousPcmPlayer} from './continuous-pcm-player.mjs';

test('the Lip sync delay setting resolves Auto from the output device and fixed values as given', () => {
  assert.deepEqual(AUDIO_DELAY_CHOICES, ['auto', 0, 50, 100, 150, 200, 250]);
  assert.equal(settingDelay({}), 'auto'); assert.equal(settingDelay({audioDelay: 75}), 'auto');
  assert.equal(settingDelay({audioDelay: 0}), 0); assert.equal(settingDelay({audioDelay: 200}), 200);
  assert.equal(resolveDelayMs('auto', {bluetooth: true}), BLUETOOTH_DELAY_MS);
  assert.equal(resolveDelayMs('auto', {bluetooth: false}), 0);
  assert.equal(resolveDelayMs('auto', null), 0, 'unknown device: no delay');
  assert.equal(resolveDelayMs(0, {bluetooth: true}), 0, 'Off wins over detection');
  assert.equal(resolveDelayMs(250, {bluetooth: false}), 250);
  try {
    assert.equal(setAudioDelayMs(150), true); assert.equal(setAudioDelayMs(150), false); assert.equal(audioDelayMs(), 150);
  } finally { setAudioDelayMs(0); }
});

function fakeProbe() {
  const spawns = [];
  const spawnFn = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stdin = {end() { child.ended = true; }}; child.kill = () => { child.killed = true; };
    spawns.push({command, args, options, child}); return child;
  };
  return {spawns, spawnFn};
}

test('one hidden probe reports the default device; a change or exit is handled without polling per frame', () => {
  const {spawns, spawnFn} = fakeProbe(), changes = [], timers = [];
  const watch = new AudioOutputWatch({spawnFn, platform: 'win32', onChange: value => changes.push(value),
    setTimeoutFn: (fn, ms) => { timers.push({fn, ms}); return timers.length; }, clearTimeoutFn: () => {}});
  watch.start(); watch.start();
  assert.equal(spawns.length, 1, 'one resident probe');
  assert.equal(spawns[0].options.windowsHide, true);
  assert.ok(spawns[0].args.includes('-Interval') && spawns[0].args.includes('-ParentId'));
  const out = spawns[0].child.stdout;
  out.emit('data', '{"available":true,"name":"Headphones (Buds)","enumerator":"INTELAUDIO","formFactor":3,"blue');
  out.emit('data', 'tooth":true}\n');
  assert.deepEqual(changes, [{available: true, bluetooth: true, name: 'Headphones (Buds)'}]);
  out.emit('data', '{"available":true,"name":"Headphones (Buds)","bluetooth":true}\nnot json\n');
  assert.equal(changes.length, 1, 'the same device is not a change');
  out.emit('data', '{"available":true,"name":"Speakers","bluetooth":false}\n');
  assert.equal(changes.at(-1).bluetooth, false);
  spawns[0].child.emit('exit', 1);
  const restarts = timers.filter(timer => timer.ms === 60000);
  assert.equal(restarts.length, 1, 'restart no sooner than one interval');
  restarts[0].fn(); assert.equal(spawns.length, 2);
  watch.stop(); assert.ok(spawns[1].child.killed);
  const elsewhere = new AudioOutputWatch({spawnFn, platform: 'linux'}); elsewhere.start();
  assert.equal(spawns.length, 2, 'Windows only');
});

// A PC where PowerShell cannot be used (blocked or missing, disabled by the device owner, a group policy): the probe gives up once,
// logs one line, never starts again in this process, and Auto stays at 0 ms.
function unusable(options = {}) {
  const {spawns, spawnFn} = fakeProbe(), logs = [], changes = [], timers = [], cleared = [];
  const watch = new AudioOutputWatch({spawnFn: options.spawnFn ?? spawnFn, platform: 'win32', log: line => logs.push(line),
    onChange: value => changes.push(value),
    setTimeoutFn: (fn, ms) => { const timer = {fn, ms}; timers.push(timer); return timer; }, clearTimeoutFn: timer => cleared.push(timer)});
  const settled = () => {
    for (let call = 0; call < 5; call++) watch.start();
    assert.equal(logs.length, 1, 'one log line for the whole session');
    assert.equal(timers.filter(timer => timer.ms === 60000).length, 0, 'no restart timer');
    assert.equal(watch.running, false);
    assert.equal(resolveDelayMs('auto', watch.output), 0, 'no delay compensation');
    assert.ok(!/key|token|secret/i.test(logs[0]));
    return true;
  };
  return {watch, spawns, logs, changes, timers, cleared, settled};
}

test('a probe that cannot be spawned (blocked or missing PowerShell) is logged once and never retried', () => {
  for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
    const thrown = unusable({spawnFn: () => { throw Object.assign(Error('spawn blocked'), {code}); }});
    thrown.watch.start();
    assert.ok(thrown.settled(), `${code} thrown by spawn`);
    assert.match(thrown.logs[0], new RegExp(code));
    assert.equal(thrown.spawns.length, 0);

    const evented = unusable();
    evented.watch.start();
    const child = evented.spawns[0].child;
    // Node reports a missing or refused executable as an 'error' event followed by an 'exit' with a negative code.
    child.emit('error', Object.assign(Error('spawn powershell.exe'), {code}));
    child.emit('exit', -4058);
    assert.ok(evented.settled(), `${code} as an error event`);
    assert.equal(evented.spawns.length, 1, 'never spawned again');
    assert.ok(child.killed || child.ended, 'the dead child is released');
  }
});

test('a probe that exits non-zero or prints policy text without a device line is given up on once', () => {
  const policy = [
    'File C:\\app\\bridge\\audio-output-probe.ps1 cannot be loaded because running scripts is disabled on this system.',
    'This program is blocked by group policy. For more information, contact your system administrator.'];
  for (const exitCode of [1, 5, null]) {
    const fixture = unusable();
    fixture.watch.start();
    for (const line of policy) fixture.spawns[0].child.stdout.emit('data', `${line}\r\n`);
    fixture.spawns[0].child.stdout.emit('data', 'x'.repeat(20000));
    assert.equal(fixture.changes.length, 0, 'policy text is not a device');
    assert.equal(fixture.watch.heard, false);
    fixture.spawns[0].child.emit('exit', exitCode);
    assert.ok(fixture.settled(), `exit ${exitCode}`);
    assert.equal(fixture.spawns.length, 1);
    assert.ok(fixture.logs[0].length < 200 && !/group policy|running scripts/.test(fixture.logs[0]), 'the policy text is not copied into the log');
  }
});

test('a probe that never prints anything is ended after a bounded wait', () => {
  const fixture = unusable();
  fixture.watch.start();
  const watchdog = fixture.timers.find(timer => timer.ms === 30000);
  assert.ok(watchdog, 'the first-output wait is bounded');
  assert.equal(fixture.logs.length, 0, 'still waiting');
  watchdog.fn();
  assert.ok(fixture.settled());
  assert.equal(fixture.spawns[0].child.killed, true, 'the silent probe is killed');
  // The same silent child exiting later changes nothing.
  fixture.spawns[0].child.emit('exit', 1);
  assert.equal(fixture.logs.length, 1);
});

test('a first device line cancels the wait; a working probe that later cannot restart gives up once and clears Bluetooth', () => {
  const fixture = unusable();
  fixture.watch.start();
  fixture.spawns[0].child.stdout.emit('data', '{"available":true,"name":"Buds","bluetooth":true}\n');
  assert.ok(fixture.cleared.some(timer => timer.ms === 30000), 'the wait is cancelled once a device line arrived');
  assert.deepEqual(fixture.changes.map(value => value.bluetooth), [true]);
  fixture.spawns[0].child.emit('exit', 1);
  const restart = fixture.timers.find(timer => timer.ms === 60000);
  assert.ok(restart, 'a probe that worked is restarted after one interval');
  restart.fn();
  assert.equal(fixture.spawns.length, 2);
  fixture.spawns[1].child.stdout.emit('data', 'blocked by group policy\n');
  fixture.spawns[1].child.emit('exit', 1);
  assert.deepEqual(fixture.changes.map(value => value.bluetooth), [true, false], 'Auto falls back to no delay');
  for (let call = 0; call < 5; call++) fixture.watch.start();
  assert.equal(fixture.spawns.length, 2); assert.equal(fixture.logs.length, 1);
  assert.equal(resolveDelayMs('auto', fixture.watch.output), 0);
});

test('a real spawn of a program that does not exist is given up on once (no PowerShell is started)', async () => {
  const {spawn} = await import('node:child_process');
  const logs = [], timers = [];
  const watch = new AudioOutputWatch({platform: 'win32', log: line => logs.push(line),
    spawnFn: (_command, _args, options) => spawn('no-such-audio-probe-program', [], options),
    setTimeoutFn: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); timers.push(ms); return timer; }});
  try {
    watch.start();
    for (let wait = 0; wait < 100 && !logs.length; wait++) await new Promise(done => setTimeout(done, 20));
    assert.equal(logs.length, 1);
    watch.start(); watch.start();
    await new Promise(done => setTimeout(done, 100));
    assert.equal(logs.length, 1); assert.equal(watch.running, false); assert.equal(watch.unavailable, true);
    assert.ok(!timers.includes(60000), 'no restart timer');
  } finally { watch.stop(); }
});

test('the delay holds the browser heard cursor back by exactly that much', async () => {
  assert.equal(playbackControl({allow: true, paused: false, delayMs: 150}).delayMs, 150);
  assert.equal(playbackControl({allow: true, paused: false}).delayMs, 0);
  assert.throws(() => playbackControl({allow: true, paused: false, delayMs: 501}));
  assert.throws(() => playbackControl({allow: true, paused: false, delayMs: -1}));
  const player = new ContinuousPcmPlayer();
  player.context = {currentTime: 2, baseLatency: 0, outputLatency: 0,
    getOutputTimestamp: () => ({contextTime: 1, performanceTime: performance.now()})};
  const base = player.outputTime();
  player.admission = {...player.admission, delayMs: 150};
  assert.ok(Math.abs(base - player.outputTime() - .15) < .005);
});
