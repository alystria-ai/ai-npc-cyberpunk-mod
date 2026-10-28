import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MicDevicesControl, cleanDeviceLabel, parseListCommand, settingMicDevice, MAX_LABEL_BYTES} from './mic-devices-control.mjs';
import {matchInput, createLocalSttChannel, describeInput, MIC_DEVICE_NOTE} from './local-stt-capture.mjs';

// Settings > Voices > Microphone: the list of audio inputs the settings page asks for, the label match against what the browser lists, and the note a recording
// carries when the chosen input was not there.

const command = (id, issuedAt = 1_000_000) => JSON.stringify({version: 1, id, action: 'list', issuedAt});

function harness(capture, options = {}) {
  const published = [];
  let file = '';
  const control = new MicDevicesControl({capture, commandPath: 'command.json', publish: async document => { published.push(document); },
    read: async () => file, now: () => 1_000_000, ...options});
  return {control, published, write: text => { file = text; }};
}

test('a device label is kept only as a plain string of a sane size', () => {
  assert.equal(cleanDeviceLabel('  Headset Mic (USB)  '), 'Headset Mic (USB)');
  assert.equal(cleanDeviceLabel(''), '');
  assert.equal(cleanDeviceLabel(5), '');
  assert.equal(cleanDeviceLabel('line\nbreak'), '');
  assert.equal(cleanDeviceLabel('x'.repeat(MAX_LABEL_BYTES)), 'x'.repeat(MAX_LABEL_BYTES));
  assert.equal(cleanDeviceLabel('x'.repeat(MAX_LABEL_BYTES + 1)), '');
  assert.equal(cleanDeviceLabel('é'.repeat(121)), '', 'the limit counts bytes, as the game does');
  assert.equal(settingMicDevice({micDevice: 'Mic'}), 'Mic');
  assert.equal(settingMicDevice({micDevice: 7}), '');
  assert.equal(settingMicDevice(undefined), '');
});

test('only a well-formed list command counts', () => {
  assert.deepEqual(parseListCommand(command('s:mic:1'), Date.now()), {id: 's:mic:1'});
  for (const raw of ['', 'nope', '[]', JSON.stringify({version: 2, id: 'a', action: 'list', issuedAt: 1}), JSON.stringify({version: 1, id: 'a', action: 'wipe', issuedAt: 1}),
      JSON.stringify({version: 1, id: '../a', action: 'list', issuedAt: 1}), JSON.stringify({version: 1, id: 'a', action: 'list', issuedAt: Date.now() + 60_000}), 'x'.repeat(5000)]) {
    assert.equal(parseListCommand(raw, Date.now()), null, raw.slice(0, 40));
  }
});

test('a command lists the inputs: listing, then the answer with each label once, Windows virtual entries excluded by the page', async () => {
  const capture = {listDevices: async () => ({inputs: ['Mic A', 'Mic B', 'Mic A', 'bad\nlabel', ''], current: 'Mic B'})};
  const {control, published, write} = harness(capture);
  await control.open();
  assert.equal(published.at(-1).state, 'idle');
  write(command('g:mic:1'));
  await control.poll();
  assert.deepEqual(published.map(document => document.state), ['idle', 'listing', 'ok']);
  assert.deepEqual(published.at(-1), {version: 1, updated: 1_000_000, id: 'g:mic:1', state: 'ok', inputs: ['Mic A', 'Mic B'], current: 'Mic B'});
  const count = published.length;
  await control.poll();
  assert.equal(published.length, count, 'the same command is not run twice');
});

test('a command left from an earlier session is ignored; a new one counts', async () => {
  let listed = 0;
  const capture = {listDevices: async () => { listed++; return {inputs: ['Mic'], current: null}; }};
  const {control, write} = harness(capture);
  write(command('old:mic:1'));
  await control.open();
  await control.poll();
  assert.equal(listed, 0);
  write(command('new:mic:1'));
  await control.poll();
  assert.equal(listed, 1);
});

test('a listing that fails or hangs publishes failed and keeps the last list', async () => {
  let mode = 'ok';
  const capture = {listDevices: () => mode === 'ok' ? Promise.resolve({inputs: ['Mic'], current: null}) : mode === 'throw' ? Promise.reject(Error('no browser')) : new Promise(() => {})};
  const {control, published, write} = harness(capture, {timeoutMs: 20});
  await control.open();
  write(command('a:1')); await control.poll();
  mode = 'throw'; write(command('a:2')); await control.poll();
  assert.equal(published.at(-1).state, 'failed');
  assert.deepEqual(published.at(-1).inputs, ['Mic'], 'the earlier list stays');
  assert.equal(published.at(-1).id, 'a:2');
  mode = 'hang'; write(command('a:3')); await control.poll();
  assert.equal(published.at(-1).state, 'failed');
  mode = 'ok'; write(command('a:4')); await control.poll();
  assert.equal(published.at(-1).state, 'ok');
});

test('the capture page opened for a listing is let go a while later, once', async () => {
  const timers = [];
  let released = 0;
  const capture = {listDevices: async () => ({inputs: ['Mic'], current: null})};
  const {control, write} = harness(capture, {releaseIdle: () => { released++; }, setTimer: (fn, ms) => { const timer = {fn, ms, cleared: false}; timers.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.cleared = true; }});
  write(command('r:1')); await control.poll();
  write(command('r:2')); await control.poll();
  const live = timers.filter(timer => !timer.cleared && timer.ms === 20_000);
  assert.equal(live.length, 1, 'a second listing replaces the first timer');
  live[0].fn();
  assert.equal(released, 1);
});

test('the summary names labels only and says when the chosen input was not found', () => {
  const capture = {listDevices: async () => ({}), lastInput: null};
  const {control} = harness(capture);
  assert.equal(control.summary(''), null, 'nothing opened and nothing chosen: no row');
  assert.deepEqual(control.summary('Headset'), {chosen: 'Headset', device: null, missing: false});
  capture.lastInput = {device: 'Microphone (Realtek)', requested: null, missing: null};
  assert.deepEqual(control.summary(''), {chosen: null, device: 'Microphone (Realtek)', missing: false});
  capture.lastInput = {device: 'Microphone (Realtek)', requested: 'Headset', missing: 'Headset'};
  assert.deepEqual(control.summary('Headset'), {chosen: 'Headset', device: 'Microphone (Realtek)', missing: true});
  assert.equal(control.summary('Other').missing, false, 'a missing input the player has since replaced is not reported');
});

test('matchInput: exact label first, then the same label without case, spacing or the hardware id; Windows virtual entries never match', () => {
  const devices = [
    {deviceId: 'default', label: 'Default - Headset Mic (USB)'},
    {deviceId: 'communications', label: 'Communications - Headset Mic (USB)'},
    {deviceId: 'a1', label: 'Microphone (Realtek(R) Audio)'},
    {deviceId: 'b2', label: 'Headset Mic (USB Audio Device) (046d:0825)'},
    {deviceId: 'c3', label: 'Headset Mic (USB Audio Device)'},
  ];
  assert.equal(matchInput(devices, 'Microphone (Realtek(R) Audio)').deviceId, 'a1');
  assert.equal(matchInput(devices, 'Headset Mic (USB Audio Device) (046d:0825)').deviceId, 'b2', 'exact beats the loose match');
  assert.equal(matchInput(devices, 'microphone  (realtek(r) audio)').deviceId, 'a1', 'case and spacing');
  assert.equal(matchInput([{deviceId: 'b2', label: 'Headset Mic (USB Audio Device) (046d:0825)'}], 'Headset Mic (USB Audio Device)').deviceId, 'b2', 'a hardware id added since');
  assert.equal(matchInput([{deviceId: 'b2', label: 'Headset Mic (USB Audio Device)'}], 'Headset Mic (USB Audio Device) (046d:0825)').deviceId, 'b2', 'a hardware id dropped since');
  assert.equal(matchInput(devices, 'Default - Headset Mic (USB)'), null, 'the virtual default is not an input to choose');
  assert.equal(matchInput(devices, 'Nothing'), null);
  assert.equal(matchInput(devices, ''), null);
  assert.equal(matchInput(undefined, 'x'), null);
  // The page embeds this function's source: it must stand alone.
  const standalone = new Function('return ' + matchInput.toString())();
  assert.equal(standalone(devices, 'Microphone (Realtek(R) Audio)').deviceId, 'a1');
});

test('a recording whose chosen input was not found carries the note the game turns into one notice', async () => {
  const stt = {availability: () => ({available: true}), start: async () => {}, cancel: async () => {}, pushAudio() {}, heard: () => '', finish: async () => ({text: 'hello', seconds: 1})};
  const logs = [];
  for (const [info, expected] of [[{device: 'Default Mic', requested: 'Headset', missing: 'Headset'}, MIC_DEVICE_NOTE], [{device: 'Headset', requested: 'Headset', missing: null}, undefined], [{device: 'Default Mic'}, undefined]]) {
    const capture = {begin: async () => info, end: async () => {}, abort: async () => {}};
    const channel = createLocalSttChannel({stt, capture, log: line => logs.push(line)})();
    const opened = await channel.beginVoice({requestId: 'r1'});
    assert.equal(opened.note, expected);
    await channel.close();
  }
  assert.ok(logs.some(line => line.includes('chosen "Headset" not found, default used')), logs.join(' | '));
  assert.ok(logs.some(line => line.includes('chosen in Settings')));
  assert.equal(describeInput({device: 'Mic', sampleRate: 16000, inputs: ['Mic']}).includes('chosen'), false, 'no choice, no extra words');
});
