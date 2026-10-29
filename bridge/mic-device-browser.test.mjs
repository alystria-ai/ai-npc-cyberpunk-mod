import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {LocalSttCapture} from './local-stt-capture.mjs';

// The real capture page in a real (headless Edge) browser with Chromium's FAKE audio devices: no microphone is opened. It shows that the inputs are listed by
// label without opening a recording, that a chosen label opens that input (and is kept open for the next press), and that a label that is not there opens the
// default input and says so.

test('the capture page lists the inputs by label, opens the chosen one, and falls back to the default when it is gone', {timeout: 120000}, async t => {
  let browser;
  try {
    browser = await chromium.launch({channel: 'msedge', headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio', '--autoplay-policy=no-user-gesture-required']});
  } catch (error) { t.skip('Edge is not available here: ' + String(error.message).slice(0, 80)); return; }
  try {
    let preferred = '';
    const capture = new LocalSttCapture({getBrowser: async () => browser, preferredDevice: () => preferred});
    const listed = await capture.listDevices();
    assert.ok(listed.inputs.length >= 1, 'at least one input is listed: ' + JSON.stringify(listed));
    assert.equal(listed.current, null, 'listing opens no device');
    assert.equal(capture.deviceOpen, false);

    // The default.
    let info = await capture.begin(() => {});
    assert.ok(info.device, 'the default input opened');
    assert.equal(info.requested, null);
    assert.equal(info.missing, null);
    const defaultLabel = info.device;
    await capture.end();

    // A chosen input (the last one listed, which differs from the default when the browser lists two or more).
    preferred = listed.inputs.at(-1);
    info = await capture.begin(() => {});
    assert.equal(info.device, preferred, 'the chosen input opened');
    assert.equal(info.requested, preferred);
    assert.equal(info.missing, null);
    assert.equal(info.reused, false, 'a different input than the one open before is a new open');
    assert.equal(info.settings.echoCancellation, true, 'a chosen input is opened with echo cancellation too');
    assert.deepEqual(capture.lastInput, {device: preferred, requested: preferred, missing: null, loopback: false});
    await capture.end();

    // Pressed again with the same choice: the open device is kept (no new open on the way to the recording).
    info = await capture.begin(() => {});
    assert.equal(info.reused, true, 'the same choice reuses the open device');
    await capture.end();

    // The chosen input is gone: the default opens and the answer says so.
    preferred = 'No Such Microphone (dead:beef)';
    info = await capture.begin(() => {});
    assert.equal(info.missing, preferred);
    assert.equal(info.device, defaultLabel, 'the default input opened instead');
    assert.deepEqual(capture.lastInput, {device: defaultLabel, requested: preferred, missing: preferred, loopback: false});
    await capture.end();

    // Back to the Windows default.
    preferred = '';
    info = await capture.begin(() => {});
    assert.equal(info.requested, null);
    assert.equal(info.device, defaultLabel);
    await capture.end();
    await capture.close();
  } finally { await browser.close().catch(() => {}); }
});
