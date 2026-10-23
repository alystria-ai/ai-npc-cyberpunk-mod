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
    assert.ok(keptMs >= 150, 'about half a second of audio was kept before the channel came: ' + keptMs + ' ms');
    assert.ok(got.length >= 4, 'handed over in pieces');
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

test('a warm device: the key press starts at once, the device stays open and unread between recordings, and cool() lets it go', {timeout: 120000}, async t => {
  let browser;
  try {
    browser = await chromium.launch({channel: 'msedge', headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio', '--autoplay-policy=no-user-gesture-required']});
  } catch (error) { t.skip('Edge is not available here: ' + String(error.message).slice(0, 80)); return; }
  try {
    const capture = new LocalSttCapture({getBrowser: async () => browser});
    const logged = [];
    const tap = new MicTap({capture, log: line => logged.push(line)});
    const info = await tap.warm(true);
    assert.ok(info?.warm === true && info.device, 'the device is open: ' + JSON.stringify(info));
    const state = () => capture.page.evaluate(() => ({warm: window.localStt.isWarm()}));
    assert.equal((await state()).warm, true);
    await wait(300);                                      // warm and unread: nothing may be delivered to the bridge
    const stray = [];
    capture.target = chunk => stray.push(chunk);
    await wait(300);
    assert.equal(stray.length, 0, 'a warm device delivers nothing');
    capture.target = null;
    // key press: the recording starts without opening anything
    const began = Date.now();
    await tap.hold('warm-1');
    const pressMs = Date.now() - began;
    assert.ok(pressMs < 150, 'the press found the device open: ' + pressMs + ' ms');
    tap.open('req-w', {holdId: 'warm-1'});
    const adapter = new TapCapture({tap}), got = [];
    await adapter.begin(chunk => got.push(chunk), {requestId: 'req-w'});
    await wait(500);
    assert.ok(got.reduce((sum, chunk) => sum + chunk.length, 0) / 32 >= 400, 'audio flows from the press on');
    await tap.released('warm-1');
    await adapter.abort();
    assert.equal(tap.state, 'closed');
    assert.equal((await state()).warm, true, 'the device is still open after the recording');
    const after = got.length;
    await wait(300);
    assert.equal(got.length, after, 'and reads nothing again');
    // a second press is as quick
    const again = Date.now();
    await tap.hold('warm-2');
    assert.ok(Date.now() - again < 150, 'the second press too');
    await tap.release(undefined, 'done');
    await tap.warm(false);
    assert.equal((await state()).warm, false, 'cool() released the device');
    assert.ok(logged.some(line => /kept open, reading nothing/.test(line)));
  } finally { await browser?.close(); }
});
