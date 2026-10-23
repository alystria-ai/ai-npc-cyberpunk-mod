import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {LocalSttCapture} from './local-stt-capture.mjs';
import {MicTap, TapCapture, TAP} from './mic-tap.mjs';

// The real capture page in a real (headless Edge) browser with Chromium's FAKE audio device: no microphone is opened, nothing is heard, no provider is
// called. It shows that the page honours the 40 ms chunk size the tap asks for, that the tap keeps the first chunks until a channel takes them, and that the
// device is released at the stop.
const wait = ms => new Promise(done => setTimeout(done, ms));

test('the capture page posts 40 ms chunks when the tap asks, keeps them until a channel attaches, and releases the device at the stop', {timeout: 120000}, async t => {
  let browser;
  try {
    browser = await chromium.launch({channel: 'msedge', headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio', '--autoplay-policy=no-user-gesture-required']});
  } catch (error) { t.skip('Edge is not available here: ' + String(error.message).slice(0, 80)); return; }
  try {
    const capture = new LocalSttCapture({getBrowser: async () => browser});
    const tap = new MicTap({capture});
    const info = await tap.hold('browser-1');
    assert.ok(info.device, 'the page names the device it opened');
    await wait(500);                                      // nobody has attached: the audio is being kept
    tap.open('req-b', {holdId: 'browser-1'});
    const adapter = new TapCapture({tap}), got = [];
    await adapter.begin(chunk => got.push(chunk), {requestId: 'req-b'});
    const keptMs = got.reduce((sum, chunk) => sum + chunk.length, 0) / 32;
    assert.ok(keptMs >= 300, 'about half a second of audio was kept before the channel came: ' + keptMs + ' ms');
    assert.ok(got.length >= 8, 'handed over in pieces');
    await wait(400);                                      // live chunks now
    const live = got.slice(-5);
    assert.ok(live.every(chunk => chunk.length % 2 === 0), 'whole 16-bit samples');
    const sizes = new Set(got.map(chunk => chunk.length));
    assert.ok(sizes.has(TAP.chunkMs * 32), 'the page posts ' + TAP.chunkMs + ' ms chunks (' + [...sizes].join(', ') + ' bytes seen)');
    await tap.released('browser-1');
    const after = got.length;
    await wait(300);
    assert.equal(got.length, after, 'nothing arrives after the key is let go');
    const open = await capture.page.evaluate(() => navigator.mediaDevices.enumerateDevices().then(() => true));
    assert.ok(open, 'the page still answers');
    await adapter.abort();
    assert.equal(tap.state, 'closed');
  } finally { await browser?.close(); }
});
