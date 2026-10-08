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
  assert.equal(timers.length, 1); assert.equal(timers[0].ms, 60000, 'restart no sooner than one interval');
  timers[0].fn(); assert.equal(spawns.length, 2);
  watch.stop(); assert.ok(spawns[1].child.killed);
  const elsewhere = new AudioOutputWatch({spawnFn, platform: 'linux'}); elsewhere.start();
  assert.equal(spawns.length, 2, 'Windows only');
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
