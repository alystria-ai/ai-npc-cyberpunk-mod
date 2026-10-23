import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {PcmRelay, RELAY_SAMPLE_RATE, RELAY_TAIL_MS, WORKLET_SOURCE} from './pcm-relay.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Stubs for the Web Audio classes: the worklet node records what is posted to it and lets a test report consumption.
function stubs({failModule = false, state = 'running'} = {}) {
  const made = {contexts: [], nodes: [], tracks: []};
  class Context {
    constructor(options) {
      this.options = options; this.state = state; this.closed = 0; made.contexts.push(this);
      this.audioWorklet = {addModule: async url => { if (failModule) throw Error('module failed'); this.module = url; }};
    }
    createMediaStreamDestination() {
      const track = {readyState: 'live', stop() { this.readyState = 'ended'; }};
      made.tracks.push(track);
      return {channelCount: 2, stream: {getTracks: () => [track]}, disconnect() { this.disconnected = true; }};
    }
    async resume() { this.state = 'running'; this.resumed = true; }
    async close() { this.closed++; this.state = 'closed'; }
  }
  class WorkletNode {
    constructor(context, name, options) {
      this.context = context; this.name = name; this.options = options; this.posted = [];
      this.port = {postMessage: (data, transfer) => this.posted.push({data, transfer}), onmessage: null};
      made.nodes.push(this);
    }
    connect(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
    report(consumed, empty = false) { this.port.onmessage?.({data: {consumed, empty}}); }
  }
  return {made, classes: {AudioContext: Context, AudioWorkletNode: WorkletNode}};
}

const ramp = (length, start = 0) => Int16Array.from({length}, (_, i) => start + i);
const base64Of = int16 => Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).toString('base64');

test('open() builds a 16 kHz interactive context, a mono worklet node and one live track', async () => {
  const {made, classes} = stubs();
  const relay = new PcmRelay(classes);
  assert.equal(relay.stream, null);
  await relay.open();
  const [context] = made.contexts, [node] = made.nodes;
  assert.deepEqual({...context.options}, {sampleRate: RELAY_SAMPLE_RATE, latencyHint: 'interactive'});
  assert.equal(node.name, 'pcm-relay'); assert.equal(node.options.numberOfInputs, 0); assert.deepEqual([...node.options.outputChannelCount], [1]);
  assert.equal(node.target.channelCount, 1, 'the destination is mono');
  assert.equal(relay.stream.getTracks().length, 1); assert.equal(relay.stream.getTracks()[0].readyState, 'live');
  assert.match(WORKLET_SOURCE, /registerProcessor\('pcm-relay'/);
  relay.close();
});

test('a suspended context is resumed', async () => {
  const {made, classes} = stubs({state: 'suspended'});
  const relay = new PcmRelay(classes); await relay.open();
  assert.equal(made.contexts[0].resumed, true); relay.close();
});

test('pushes keep their order, before and after the worklet is ready, and never copy more than once', async () => {
  const {made, classes} = stubs();
  const relay = new PcmRelay(classes);
  const first = ramp(320, 0), second = ramp(320, 1000);
  assert.equal(relay.push(first), true); assert.equal(relay.pushBase64(base64Of(second)), true);
  assert.equal(relay.backlogMs, 40, '640 samples at 16 kHz');
  const opening = relay.open();
  await opening;
  const third = ramp(160, 5000); relay.push(third);
  const posted = made.nodes[0].posted;
  assert.equal(posted.length, 3);
  assert.deepEqual([...posted[0].data.slice(0, 3)], [0, 1, 2]); assert.deepEqual([...posted[1].data.slice(0, 3)], [1000, 1001, 1002]);
  assert.deepEqual([...posted[2].data.slice(0, 2)], [5000, 5001]);
  for (const row of posted) assert.equal(row.transfer.length, 1, 'the buffer moves to the audio thread');
  assert.equal(first.length, 320, 'push() copied, so the caller keeps a usable array');
  assert.equal(relay.backlogMs, 50);
  relay.close();
});

test('push(): transfer option hands over a whole-buffer array, other views are copied, junk is refused', async () => {
  const {made, classes} = stubs();
  const relay = new PcmRelay(classes); await relay.open();
  const owned = ramp(100); relay.push(owned, {transfer: true});
  assert.equal(made.nodes[0].posted[0].transfer[0], owned.buffer, 'the callers own buffer moves');
  const view = new Int16Array(ramp(100).buffer, 20, 10); relay.push(view, {transfer: true});
  assert.notEqual(made.nodes[0].posted[1].transfer[0], view.buffer, 'a partial view is copied instead');
  assert.equal(made.nodes[0].posted[1].data.length, 10);
  assert.equal(relay.push('text'), false); assert.equal(relay.push(new Int16Array(0)), true);
  assert.equal(relay.pushBase64(''), false); assert.equal(relay.pushBase64(5), false);
  assert.equal(made.nodes[0].posted.length, 2);
  relay.close();
});

test('pushBase64 handles an odd byte count by dropping the half sample', async () => {
  const {made, classes} = stubs();
  const relay = new PcmRelay(classes); await relay.open();
  assert.equal(relay.pushBase64(Buffer.from([1, 0, 2, 0, 9]).toString('base64')), true);
  assert.deepEqual([...made.nodes[0].posted[0].data], [1, 2]);
  assert.equal(relay.pushBase64(Buffer.from([7]).toString('base64')), false);
  relay.close();
});

test('backlog accounting follows the worklet reports', async () => {
  const {made, classes} = stubs();
  const relay = new PcmRelay(classes); await relay.open();
  relay.push(ramp(1600)); assert.equal(relay.backlogMs, 100);
  made.nodes[0].report(800); assert.equal(relay.backlogMs, 50);
  made.nodes[0].report(800); made.nodes[0].report(1600, true); assert.equal(relay.backlogMs, 0);
  made.nodes[0].report(1000); assert.equal(relay.backlogMs, 0, 'reports never go backwards');
  relay.close();
});

test('drain() resolves at once when nothing was ever pushed', async () => {
  const {classes} = stubs();
  const relay = new PcmRelay(classes); await relay.open();
  const result = await relay.drain(1000);
  assert.equal(result.drained, true); assert.ok(result.waitedMs < 100);
  relay.close();
});

test('drain() waits for the backlog to play out plus the silent tail', async () => {
  const {made, classes} = stubs();
  const relay = new PcmRelay(classes); await relay.open();
  relay.push(ramp(1600));
  let settled = false;
  const draining = relay.drain(5000).then(result => { settled = true; return result; });
  await delay(60); assert.equal(settled, false, 'the backlog is still queued');
  made.nodes[0].report(1600, true);
  await delay(RELAY_TAIL_MS / 3); assert.equal(settled, false, 'the encoder tail is not over');
  const result = await draining;
  assert.equal(result.drained, true); assert.ok(result.waitedMs >= RELAY_TAIL_MS - 5, 'waited ' + result.waitedMs);
  relay.close();
});

test('drain() gives up at its timeout with drained:false', async () => {
  const {classes} = stubs();
  const relay = new PcmRelay(classes); await relay.open();
  relay.push(ramp(1600));
  const result = await relay.drain(120);
  assert.equal(result.drained, false); assert.ok(result.waitedMs >= 100 && result.waitedMs < 1000);
  relay.close();
});

test('drain() resolves {drained:false} when the relay is closed meanwhile', async () => {
  const {classes} = stubs();
  const relay = new PcmRelay(classes); await relay.open();
  relay.push(ramp(1600));
  const draining = relay.drain(5000); await delay(20); relay.close();
  assert.equal((await draining).drained, false);
  assert.equal((await relay.drain(5000)).drained, false, 'a closed relay never claims it drained');
});

test('close() stops the track, disconnects, closes the context once, and is idempotent', async () => {
  const {made, classes} = stubs();
  const relay = new PcmRelay(classes); await relay.open();
  relay.close(); relay.close(); relay.close();
  await delay(5);
  assert.equal(made.tracks[0].readyState, 'ended'); assert.equal(made.nodes[0].disconnected, true);
  assert.equal(made.contexts[0].closed, 1);
  assert.equal(relay.push(ramp(10)), false); assert.equal(relay.pushBase64(base64Of(ramp(10))), false);
  assert.equal(made.nodes[0].posted.length, 0);
});

test('close() before open() finishes tears everything down and open() rejects', async () => {
  const {made, classes} = stubs();
  const relay = new PcmRelay(classes);
  const opening = relay.open(); relay.close();
  await assert.rejects(opening, /closed/);
  await delay(5);
  assert.equal(made.contexts[0].closed, 1);
});

test('a worklet module failure rejects open() and leaves the context closed', async () => {
  const {made, classes} = stubs({failModule: true});
  const relay = new PcmRelay(classes);
  await assert.rejects(relay.open(), /module failed/);
  await delay(5);
  assert.equal(made.contexts[0].closed, 1); assert.equal(relay.stream, null);
  assert.equal(relay.push(ramp(10)), false);
});

test('without Web Audio open() rejects with a clear error', async () => {
  await assert.rejects(new PcmRelay({}).open(), /not available/);
});

// ---- real browser: a pushed 1 kHz sine becomes a live track, silence after the drain, ended after close ----
test('real muted Edge: a pushed sine arrives on the track, drain waits for it, the track ends on close', {timeout: 180000}, async t => {
  let chromium;
  try { ({chromium} = await import('playwright')); } catch { t.skip('playwright is not installed'); return; }
  const server = createServer(async (request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>PCM relay test</title>'); return; }
    if (request.url !== '/pcm-relay.mjs') { response.writeHead(404).end(); return; }
    try { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(new URL('./pcm-relay.mjs', import.meta.url))); }
    catch { response.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    // Muted and without any microphone access: the only source is the pushed sine, read back through an analyser.
    try {
      browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required']});
    } catch (error) { t.skip('Edge cannot run here: ' + error.message); return; }
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => {
      const {PcmRelay} = await import('/pcm-relay.mjs');
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const relay = new PcmRelay();
      // Queue before the context exists: the pre-roll.
      const rate = 16000, total = 9600; // 600 ms
      const sine = new Int16Array(total);
      for (let i = 0; i < total; i++) sine[i] = Math.round(Math.sin(2 * Math.PI * 1000 * i / rate) * 16000);
      const chunk = 640; // 40 ms
      const half = Math.floor(total / chunk / 2) * chunk;
      for (let at = 0; at < half; at += chunk) relay.push(sine.subarray(at, at + chunk));
      await relay.open();
      const stream = relay.stream, track = stream.getTracks()[0];
      const before = {state: track.readyState, kind: track.kind, tracks: stream.getAudioTracks().length};
      // Read the track back through a second context: peak level and the dominant frequency of every analysis frame.
      const reader = new AudioContext({sampleRate: rate});
      const analyser = reader.createAnalyser(); analyser.fftSize = 2048;
      reader.createMediaStreamSource(stream).connect(analyser);
      if (reader.state !== 'running') await reader.resume();
      const time = new Float32Array(analyser.fftSize), freq = new Float32Array(analyser.frequencyBinCount);
      const frames = [];
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          analyser.getFloatTimeDomainData(time); analyser.getFloatFrequencyData(freq);
          let peak = 0; for (const v of time) peak = Math.max(peak, Math.abs(v));
          let best = 0; for (let i = 1; i < freq.length; i++) if (freq[i] > freq[best]) best = i;
          frames.push({peak, hz: best * rate / analyser.fftSize, at: performance.now()});
          await delay(20);
        }
      })();
      // Nothing plays before start(): the pre-roll waits for the published track instead of playing into a track nobody receives.
      await delay(300);
      const heldBack = {consumed: relay.consumed, loud: frames.filter(f => f.peak > 0.05).length, backlogMs: relay.backlogMs};
      relay.start();
      // The second half arrives while the first plays (order across the boundary must hold).
      for (let at = half; at < total; at += chunk) { relay.push(sine.subarray(at, at + chunk)); await delay(10); }
      const backlogAtPush = relay.backlogMs;
      const drained = await relay.drain(4000);
      const drainedAt = performance.now();
      await delay(500);
      sampling = false; await sampler;
      const playing = frames.filter(f => f.peak > 0.2);
      // the analyser window holds the last 128 ms, so look past it
      const after = frames.filter(f => f.at > drainedAt + 300);
      const tail = {frames: after.length, peak: Math.max(0, ...after.map(f => f.peak))};
      const mid = playing.slice(2, -2).map(f => f.hz);
      const stateBeforeClose = track.readyState;
      relay.close(); relay.close();
      await delay(100);
      const out = {before, heldBack, drained, backlogAtPush, playingFrames: playing.length, playingPeak: Math.max(0, ...playing.map(f => f.peak)),
        hz: mid.sort((a, b) => a - b)[Math.floor(mid.length / 2)], tail, stateBeforeClose, stateAfterClose: track.readyState,
        backlogAfter: relay.backlogMs, pushAfterClose: relay.push(new Int16Array(10))};
      await reader.close();
      return out;
    });
    assert.equal(result.heldBack.consumed, 0, 'before start() nothing is consumed: ' + JSON.stringify(result.heldBack));
    assert.equal(result.heldBack.loud, 0); assert.ok(result.heldBack.backlogMs >= 280);
    assert.equal(result.before.state, 'live'); assert.equal(result.before.kind, 'audio'); assert.equal(result.before.tracks, 1);
    assert.equal(result.drained.drained, true, JSON.stringify(result));
    assert.ok(result.playingFrames >= 8, 'the sine reached the track: ' + JSON.stringify(result));
    assert.ok(result.playingPeak > 0.3 && result.playingPeak < 0.7, 'level ' + result.playingPeak);
    assert.ok(Math.abs(result.hz - 1000) < 100, 'dominant frequency ' + result.hz);
    assert.ok(result.tail.frames >= 3 && result.tail.peak < 0.01, 'silence after drain: ' + JSON.stringify(result.tail));
    assert.equal(result.stateBeforeClose, 'live'); assert.equal(result.stateAfterClose, 'ended');
    assert.equal(result.backlogAfter, 0); assert.equal(result.pushAfterClose, false);
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
  }
});

// The real thing a Convai room does with the track: it goes over a WebRTC peer connection (Opus) to a far end that records what arrives. Audio pushed BEFORE
// the track was published (the pre-roll) must reach the far end whole once start() is called, and none of it before.
test('real Edge, WebRTC loopback: the pre-roll pushed before start() reaches the far end whole, in order, after it and not before', {timeout: 180000}, async t => {
  let chromium;
  try { ({chromium} = await import('playwright')); } catch { t.skip('playwright is not installed'); return; }
  let browser;
  try { browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required']}); }
  catch (error) { t.skip('Edge cannot run here: ' + error.message); return; }
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><title>t</title>'}));
    await page.goto('http://127.0.0.1:1/');
    const source = readFileSync(new URL('./pcm-relay.mjs', import.meta.url), 'utf8');
    const result = await page.evaluate(async source => {
      const {PcmRelay} = await import(URL.createObjectURL(new Blob([source], {type: 'text/javascript'})));
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const relay = new PcmRelay(); await relay.open();
      const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
      pc1.onicecandidate = e => e.candidate && pc2.addIceCandidate(e.candidate); pc2.onicecandidate = e => e.candidate && pc1.addIceCandidate(e.candidate);
      const track = relay.stream.getAudioTracks()[0];
      pc1.addTrack(track, relay.stream);
      const far = new AudioContext(), levels = []; let t0 = performance.now();
      pc2.ontrack = e => {
        const sink = new Audio(); sink.srcObject = new MediaStream([e.track]); sink.muted = true; sink.play().catch(() => {});
        const analyser = far.createAnalyser(); analyser.fftSize = 1024; far.createMediaStreamSource(new MediaStream([e.track])).connect(analyser);
        const buffer = new Float32Array(1024);
        setInterval(() => { analyser.getFloatTimeDomainData(buffer); let sum = 0; for (const v of buffer) sum += v * v; levels.push([performance.now() - t0, Math.sqrt(sum / buffer.length)]); }, 20);
      };
      const offer = await pc1.createOffer(); await pc1.setLocalDescription(offer); await pc2.setRemoteDescription(offer);
      const answer = await pc2.createAnswer(); await pc2.setLocalDescription(answer); await pc1.setRemoteDescription(answer);
      await delay(800);
      const samples = 16000 * 1.5, tone = new Int16Array(samples);
      for (let i = 0; i < samples; i++) tone[i] = Math.round(8000 * Math.sin(2 * Math.PI * 220 * i / 16000));
      t0 = performance.now(); levels.length = 0;
      relay.push(tone);
      await delay(1200);                                   // the connection is still opening: nothing may play
      const loudBeforeStart = levels.filter(([, v]) => v > 0.02).length;
      const startedAt = performance.now() - t0;
      relay.start();
      const drained = await relay.drain();
      await delay(400);
      const loud = levels.filter(([, v]) => v > 0.02);
      track.stop();
      return {loudBeforeStart, startedAt, drained, loudMs: loud.length * 20, firstLoud: loud[0]?.[0] - startedAt, lastLoud: loud.at(-1)?.[0] - startedAt};
    }, source);
    assert.equal(result.loudBeforeStart, 0, 'nothing played before start(): ' + JSON.stringify(result));
    assert.equal(result.drained.drained, true);
    assert.ok(result.loudMs >= 1350 && result.loudMs <= 1700, 'the whole 1.5 s arrived: ' + JSON.stringify(result));
    assert.ok(result.firstLoud < 400, 'and promptly after start(): ' + JSON.stringify(result));
  } finally { await browser.close(); }
});
