import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {LocalSttCapture} from './local-stt-capture.mjs';
import {MicTap, TapCapture} from './mic-tap.mjs';
import {RealtimeHost} from './realtime-host.mjs';

// The whole Convai-route microphone path in real Edge, minus Convai itself: a warm fake device (a looping 440 Hz tone) -> the key press -> the tap keeps
// the audio while the "connection" opens -> the relay pump hands it to a second page's PcmRelay -> the track goes over a WebRTC peer connection to a far
// end that records what arrives. What the player said from the key press on must reach the far end whole, and none of it before the track is "published".
const wait = ms => new Promise(done => setTimeout(done, ms));

test('real Edge: audio from the key press reaches the far end of the relay track, whole and only after the track is published', {timeout: 180000}, async t => {
  const folder = mkdtempSync(join(tmpdir(), 'ptt-e2e-'));
  const sample = join(folder, 'tone.wav');
  {
    const rate = 16000, n = rate * 2, data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 440 * i / rate)), i * 2);
    const head = Buffer.alloc(44);
    head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
    head.write('data', 36); head.writeUInt32LE(data.length, 40);
    writeFileSync(sample, Buffer.concat([head, data]));
  }
  let browser;
  try {
    browser = await chromium.launch({channel: 'msedge', headless: true,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${sample}`, '--mute-audio', '--autoplay-policy=no-user-gesture-required']});
  } catch (error) { rmSync(folder, {recursive: true, force: true}); t.skip('Edge is not available here: ' + String(error.message).slice(0, 80)); return; }
  try {
    const tap = new MicTap({capture: new LocalSttCapture({getBrowser: async () => browser})});
    assert.ok((await tap.warm(true))?.warm, 'the device is open before any key press');

    // The "Convai page": the relay plus a far end that records the level of what arrives.
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><title>room</title>'}));
    await page.goto('http://127.0.0.1:2/');
    const source = readFileSync(new URL('./pcm-relay.mjs', import.meta.url), 'utf8');
    await page.evaluate(async source => {
      const {PcmRelay} = await import(URL.createObjectURL(new Blob([source], {type: 'text/javascript'})));
      const relay = window.relay = new PcmRelay(); await relay.open();
      const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
      pc1.onicecandidate = e => e.candidate && pc2.addIceCandidate(e.candidate); pc2.onicecandidate = e => e.candidate && pc1.addIceCandidate(e.candidate);
      const track = relay.stream.getAudioTracks()[0];
      pc1.addTrack(track, relay.stream);
      const far = new AudioContext(); window.levels = [];
      pc2.ontrack = e => {
        const sink = new Audio(); sink.srcObject = new MediaStream([e.track]); sink.muted = true; sink.play().catch(() => {});
        const analyser = far.createAnalyser(); analyser.fftSize = 1024; far.createMediaStreamSource(new MediaStream([e.track])).connect(analyser);
        const buffer = new Float32Array(1024);
        setInterval(() => { analyser.getFloatTimeDomainData(buffer); let sum = 0; for (const v of buffer) sum += v * v; window.levels.push(Math.sqrt(sum / buffer.length)); }, 20);
      };
      const offer = await pc1.createOffer(); await pc1.setLocalDescription(offer); await pc2.setRemoteDescription(offer);
      const answer = await pc2.createAnswer(); await pc2.setLocalDescription(answer); await pc1.setRemoteDescription(answer);
    }, source);
    await wait(600);
    await page.evaluate(() => { window.levels.length = 0; });

    // The key press: the tap keeps the audio. The "connection" takes a second to open.
    const hostLike = new RealtimeHost({launchBrowser: async () => { throw Error('no browser'); }});
    const lease = {value: {isClosed: () => false, evaluate: (_fn, text) => page.evaluate(b64 => window.relay.pushBase64(b64), text)}};
    const pressed = Date.now();
    await tap.hold('e2e-1');
    assert.ok(Date.now() - pressed < 200, 'the press found the device open: ' + (Date.now() - pressed) + ' ms');
    tap.open('req-e2e', {holdId: 'e2e-1'});
    await wait(1000);
    const pump = hostLike.startRelayPump(lease, tap, 'req-e2e');
    pump.started = true;
    await wait(300);
    const loudBefore = await page.evaluate(() => window.levels.filter(v => v > 0.02).length);
    await page.evaluate(() => window.relay.start());                  // the SDK published the track
    await wait(600);                                                   // the player is still holding the key
    await tap.released('e2e-1');                                       // let go
    await pump.idle();
    await tap.stop('req-e2e');
    await pump.idle();
    const pushedMs = pump.pushed / 32;
    const drained = await page.evaluate(() => window.relay.drain());
    await wait(300);
    const loudMs = (await page.evaluate(() => window.levels.filter(v => v > 0.02).length)) * 20;
    assert.equal(loudBefore, 0, 'nothing played into the unpublished track');
    assert.ok(pushedMs >= 1000, 'the audio from the key press on was handed over: ' + pushedMs + ' ms');
    assert.equal(drained.drained, true);
    assert.ok(loudMs >= 0.85 * pushedMs, `the far end heard ${loudMs} ms of the ${Math.round(pushedMs)} ms that was said`);
    pump.close();
    await tap.release(undefined, 'done'); await tap.warm(false);
  } finally { await browser.close(); rmSync(folder, {recursive: true, force: true}); }
});
