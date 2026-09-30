import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ContinuousPcmPlayer} from './continuous-pcm-player.mjs';
import {ContinuousPcmCore} from './continuous-pcm-core.mjs';

const pcm = count => new Uint8Array(count * 2);
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture({actualRate, addModule, suppressAcks = false} = {}) {
  let now = 0, tick, context, node;
  class Context {
    constructor(options) {
      context = this; this.sampleRate = actualRate ?? options.sampleRate;
      this.currentTime = 0; this.outputTime = 0; this.state = 'suspended'; this.closeCount = 0;
      this.destination = {}; this.baseLatency = .01; this.outputLatency = .02;
      this.audioWorklet = {addModule: async url => { assert.match(url, /continuous-pcm-worklet\.mjs$/); await addModule?.(); }};
    }
    createGain() { this.gain = this.endpoint('gain'); return this.gain; }
    createStereoPanner() { this.panner = this.endpoint('pan'); return this.panner; }
    endpoint(name) { return {[name]: {value: 0, setValueAtTime(value) { this.value = value; }},
      connect() {}, disconnect() { this.disconnected = true; }}; }
    async resume() { this.state = 'running'; this.onstatechange?.(); }
    getOutputTimestamp() { return {contextTime: this.outputTime, performanceTime: now}; }
    async close() { this.closeCount++; this.state = 'closed'; this.onstatechange?.(); }
  }
  class Node {
    constructor(ctx, name, {processorOptions}) {
      node = this; assert.equal(name, 'convai-continuous-pcm'); this.token = processorOptions.token;
      this.core = new ContinuousPcmCore({...processorOptions, nowMs: 0}); this.history = [];
      this.port = {postMessage: message => queueMicrotask(() => {
        try {
          switch (message.type) {
            case 'append': this.core.append(new Uint8Array(message.bytes), message.offsetFrames); break;
            case 'control': this.core.control(message.value, ctx.currentTime * 1000); break;
            case 'hold': this.core.hold(); break;
            case 'end': this.core.end(message.totalFrames); break;
            case 'stop': this.core.stop(); return;
          }
          if (!suppressAcks) this.report(message.id);
        } catch (error) { this.port.onmessage?.({data: {type: 'failure', token: this.token, error: error.message}}); }
      }), close() { this.closed = true; }};
    }
    report(id) {
      const history = this.history; this.history = [];
      this.port.onmessage?.({data: {type: 'state', token: this.token, id, snapshot: this.core.snapshot(), history}});
    }
    render(frames) {
      const s = this.core.render([new Float32Array(frames)], context.currentTime);
      this.history.push(s.start, s.end, s.from, s.to, s.advancingEnd);
      context.currentTime += frames / context.sampleRate; now = context.currentTime * 1000; this.report();
    }
    connect() { this.connected = true; }
    disconnect() { this.disconnected = true; }
  }
  const player = new ContinuousPcmPlayer({AudioContextClass: Context, AudioWorkletNodeClass: Node,
    now: () => now, setIntervalFn: fn => { tick = fn; return 1; }, clearIntervalFn: () => { tick = null; }});
  return {player, get context() { return context; }, get node() { return node; },
    advance: ms => { now += ms; context.currentTime = now / 1000; tick?.(); }};
}

test('source sample rate mismatch fails before any output graph is connected', async () => {
  const f = fixture({actualRate: 48000});
  await assert.rejects(f.player.open({sampleRate: 24000, channels: 1, token: 'test'}), /sample rate/);
  assert.equal(f.node, undefined); assert.equal(f.context.closeCount, 1);
  assert.equal(f.player.snapshot().state, 'error');
});

test('opening is silent, ownership is copied, and a stale token cannot modify state', async () => {
  const f = fixture(); await f.player.open({sampleRate: 8000, channels: 1, token: 'owner'});
  assert.equal(f.context.gain.gain.value, 0);
  const bytes = pcm(3200); new DataView(bytes.buffer).setInt16(0, 4321, true);
  const pending = f.player.append(bytes, 0); bytes.fill(0); await pending;
  assert.equal(f.node.core.samples[0], 4321);
  f.node.port.onmessage({data: {type: 'failure', token: 'different-owner', error: 'stale'}});
  assert.equal(f.player.snapshot().error, null);
  f.player.control({allow: true, paused: false, volume: .5, pan: -.25}); await flush();
  assert.equal(f.context.gain.gain.value, .5); assert.equal(f.context.panner.pan.value, -.25);
  await f.player.stop(); await f.player.stop(); assert.equal(f.context.closeCount, 1);
});

test('rendered EOF is not declared heard until the device-correlated cursor reaches it', async () => {
  const f = fixture(); await f.player.open({sampleRate: 8000, channels: 1, token: 'owner'});
  await f.player.append(pcm(800), 0); await f.player.end(800);
  f.player.control({allow: true, paused: false}); await flush();
  f.node.render(800); f.context.outputTime = .05;
  let state = f.player.snapshot();
  assert.equal(state.playedFrames, 800); assert.equal(state.ended, false); assert.equal(state.state, 'draining');
  assert.ok(Math.abs(state.positionSeconds - .05) < 1e-8); assert.equal(f.context.closeCount, 0);
  f.context.outputTime = .1; state = f.player.snapshot();
  assert.equal(state.ended, true); assert.equal(state.state, 'ended'); assert.equal(state.positionSeconds, .1);
  await f.player.stop('completed'); assert.equal(f.context.closeCount, 1);
  assert.equal(f.player.snapshot().ended, true);
});

test('admission watchdog holds samples at 500ms and destroys the renderer after 2s', async () => {
  const f = fixture(); await f.player.open({sampleRate: 8000, channels: 1, token: 'owner'});
  f.player.control({allow: true, paused: false}); await flush();
  f.advance(500); await flush(); f.node.render(128);
  assert.equal(f.player.snapshot().state, 'lease-held'); assert.equal(f.player.snapshot().playedFrames, 0);
  f.advance(1500); await flush();
  assert.equal(f.player.snapshot().state, 'error'); assert.match(f.player.snapshot().error, /expired/);
  assert.equal(f.context.closeCount, 1);
  assert.throws(() => f.player.control({allow: true, paused: false}), /not open/);
});

test('stop during asynchronous worklet setup cannot resurrect playback', async () => {
  let resume;
  const f = fixture({addModule: () => new Promise(resolve => { resume = resolve; })});
  const opening = f.player.open({sampleRate: 8000, channels: 1, token: 'owner'});
  const rejected = assert.rejects(opening, /stopped/);
  await f.player.stop(); resume(); await rejected;
  assert.equal(f.node, undefined); assert.equal(f.context.closeCount, 1);
});

test('wrong offsets and mismatched EOF fail closed without leaving an audio context', async () => {
  for (const action of [p => p.append(pcm(1), 1), p => p.end(5)]) {
    const f = fixture(); await f.player.open({sampleRate: 8000, channels: 1, token: 'owner'});
    await assert.rejects(action(f.player)); await flush();
    assert.equal(f.player.snapshot().state, 'error'); assert.equal(f.context.closeCount, 1);
  }
});

test('device suspension fails closed instead of advancing lipsync from wall time', async () => {
  const f = fixture(); await f.player.open({sampleRate: 8000, channels: 1, token: 'owner'});
  f.context.state = 'suspended'; f.context.onstatechange(); await flush();
  assert.match(f.player.snapshot().error, /no longer running/);
  assert.equal(f.context.closeCount, 1); assert.equal(f.player.snapshot().positionSeconds, 0);
});
