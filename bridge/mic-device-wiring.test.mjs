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

test('the Convai route reports a missing chosen input with the same note as the local routes', () => {
  const host = read('./realtime-host.mjs');
  assert.match(host, /if \(info\?\.missing && !result\.note\) result\.note = 'mic-device-gone'/);
  const capture = read('./local-stt-capture.mjs');
  assert.match(capture, /MIC_DEVICE_NOTE = 'mic-device-gone'/);
});
