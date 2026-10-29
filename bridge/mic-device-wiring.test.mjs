import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Settings > Voices > Microphone, as the bridge wires it (source-level checks, the pattern of pocket-language-selection.test.mjs): the choice reaches every open of the
// device through the one capture, the list command rides the settings poll, and the setup check and the report name the input in use.
const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');

test('the bridge wires the choice into the capture, polls the list command with the settings, and reports the input in use', () => {
  const source = read('./convai-bridge.mjs');
  assert.match(source, /new LocalSttCapture\(\{getBrowser: hostBrowser\(realtime\), preferredDevice: \(\) => micPreferred\}\)/, 'every open asks for the choice');
  assert.match(source, /adoptMicDevice\(settings\);\s*await micDevicesControl\.poll\(\)/, 'the choice and the list command follow the settings poll');
  assert.match(source, /microphone: \(\) => micDevicesControl\.summary\(micPreferred\)/, 'the setup check names the input');
  assert.match(source, /microphone: micDevicesControl\.summary\(micPreferred\)/, 'the report names the input');
  assert.match(source, /micTap\.listening\) void micTap\.release\(undefined, 'the microphone input changed'\)/, 'a listening tap reopens on the new input');
});

test('nothing lists the devices on the way to a recording', () => {
  const capture = read('./local-stt-capture.mjs');
  const begin = capture.slice(capture.indexOf('  async begin(onChunk'), capture.indexOf('  samplesFor('));
  assert.ok(begin.length > 100, 'found begin()');
  assert.ok(!begin.includes('listDevices') && !begin.includes('listInputs'), 'begin() never lists');
  const tap = read('./mic-tap.mjs');
  assert.ok(!tap.includes('listDevices'), 'the tap never lists');
});

test('the Convai route reports a missing chosen input and a loopback default with the same notes as the local routes', () => {
  const host = read('./realtime-host.mjs');
  assert.match(host, /if \(!result\.note\) \{ const note = inputNote\(info\); if \(note\) result\.note = note; \}/);
  const match = read('./mic-match.mjs');
  assert.match(match, /MIC_DEVICE_NOTE = 'mic-device-gone'/);
  assert.match(match, /MIC_LOOPBACK_NOTE = 'mic-loopback'/);
});

test('the Convai page\'s own microphone (the fallback) gets the chosen input and echo cancellation too', () => {
  const host = read('./realtime-host.mjs');
  assert.match(host, /micDevice: this\.micTap\?\.capture\?\.preferred\?\.\(\) \?\? ''/, 'the host hands the choice to the page');
  const client = read('./realtime-client.mjs');
  assert.match(client, /options\?\.micDevice/);
  assert.match(client, /audio\.echoCancellation = true; audio\.noiseSuppression = true; audio\.autoGainControl = true/);
});

test('every getUserMedia in the bridge is the constrained open or a short unlock probe', () => {
  for (const file of ['./local-stt-capture.mjs', './realtime-client.mjs']) {
    const calls = read(file).split('\n').filter(line => /getUserMedia\(/.test(line) && !/^\s*\/\//.test(line) && !/getUserMedia = |Descriptor\(/.test(line));
    for (const line of calls) {
      assert.ok(/getUserMedia\(\{audio: true\}\)/.test(line) || /original\.call\(/.test(line) || /getUserMedia\(constraints\)/.test(line), file + ': ' + line.trim());
    }
  }
  assert.match(read('./local-stt-capture.mjs'), /const constraints = \{audio: \{channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true\}\}/);
});

test('the recording state carries the input name only for the loopback note', () => {
  assert.match(read('./convai-bridge.mjs'), /opened\.note === 'mic-loopback' && typeof opened\.device === 'string' \? \{device: opened\.device\.slice\(0, 80\)\}/);
});
