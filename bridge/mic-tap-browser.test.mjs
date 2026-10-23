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

test('the linger: the device opens at the press, stays open and unread for lingerMs after the turn, the next press is instant, then it closes; busy closes it at once', {timeout: 120000}, async t => {
  let browser;
  try {
    browser = await chromium.launch({channel: 'msedge', headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio', '--autoplay-policy=no-user-gesture-required']});
  } catch (error) { t.skip('Edge is not available here: ' + String(error.message).slice(0, 80)); return; }
  try {
    const capture = new LocalSttCapture({getBrowser: async () => browser});
    const logged = [];
    const tap = new MicTap({capture, log: line => logged.push(line), limits: {lingerMs: 1500}});
    const open = () => capture.page.evaluate(() => window.localStt.isOpen());
    await capture.ensurePage();
    assert.equal(await open(), false, 'nothing is open before a press');
    const turn = async (holdId, requestId) => {
      const began = Date.now();
      await tap.hold(holdId);
      const pressMs = Date.now() - began;
      tap.open(requestId, {holdId});
      const adapter = new TapCapture({tap}), got = [];
      await adapter.begin(chunk => got.push(chunk), {requestId});
      await wait(400);
      await tap.released(holdId);
      await adapter.abort();
      return {pressMs, bytes: got.reduce((sum, chunk) => sum + chunk.length, 0)};
    };
    const first = await turn('l-1', 'req-l1');
    assert.ok(first.bytes > 0, 'the first press recorded');
    assert.equal(tap.state, 'closed');
    assert.equal(await open(), true, 'the device stays open after the turn');
    assert.equal(tap.lingering, true);
    const second = await turn('l-2', 'req-l2');
    assert.ok(second.pressMs < first.pressMs && second.pressMs < 150, `the next press found it open: ${first.pressMs} ms then ${second.pressMs} ms`);
    await wait(1900);
    assert.equal(await open(), false, 'the device closed after the linger');
    assert.ok(logged.some(line => /tap released/.test(line)));
    // busy: closes at once, no linger
    await turn('l-3', 'req-l3');
    assert.equal(await open(), true);
    tap.setBlocked(true); await wait(300);
    assert.equal(await open(), false, 'a menu, a loading screen, a scene or a choice list closes it at once');
    await turn('l-4', 'req-l4'); await wait(300);
    assert.equal(await open(), false, 'and nothing lingers while the game is busy');
  } finally { await browser?.close(); }
});
