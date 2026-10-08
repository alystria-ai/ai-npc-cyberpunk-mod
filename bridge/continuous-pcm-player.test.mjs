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
            case 'arm': this.core.arm(ctx.currentTime * 1000); break;
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
  // The output stamp runs ahead of the mix by base + output latency (.01 + .02
  // here, measured 49 ms in Edge): the heard cursor is the stamp minus that.
  f.node.render(800); f.context.outputTime = .08;
  let state = f.player.snapshot();
  assert.equal(state.playedFrames, 800); assert.equal(state.ended, false); assert.equal(state.state, 'draining');
  assert.ok(Math.abs(state.positionSeconds - .05) < 1e-8); assert.equal(f.context.closeCount, 0);
  f.context.outputTime = .13; state = f.player.snapshot();
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

test('a standby player sits silent far beyond the 2s lease, ignores controls, then arms into a normal lease', async () => {
  const f = fixture(); await f.player.open({sampleRate: 8000, channels: 1, token: 'owner', standby: true});
  assert.equal(f.context.gain.gain.value, 0);
  for (let i = 0; i < 8; i++) { f.advance(5000); await flush(); f.node.render(128); }
  assert.equal(f.player.snapshot().error, null); assert.equal(f.context.closeCount, 0);
  assert.equal(f.player.snapshot().state, 'standby'); assert.equal(f.node.core.externalHold, false);
  f.player.control({allow: true, paused: false, volume: 1, pan: 0}); await flush(); // ignored
  assert.equal(f.node.core.allow, false); assert.equal(f.context.gain.gain.value, 0);
  await assert.rejects(f.player.append(pcm(100), 0), /cannot accept audio/);
  assert.equal(f.context.closeCount, 1, 'audio before arming fails closed');
  const g = fixture(); await g.player.open({sampleRate: 8000, channels: 1, token: 'owner', standby: true});
  g.advance(30000); await flush();
  await g.player.arm(); assert.equal(g.player.snapshot().state, 'awaiting-admission');
  await g.player.append(pcm(3200), 0);
  g.player.control({allow: true, paused: false, volume: .5, pan: 0}); await flush();
  assert.equal(g.context.gain.gain.value, .5);
  g.node.render(128); assert.equal(g.player.snapshot().state, 'playing');
  // The lease started at arming: a game that never refreshes it expires after 2 s, as before.
  g.advance(2000); await flush();
  assert.match(g.player.snapshot().error, /expired/); assert.equal(g.context.closeCount, 1);
  await assert.rejects(g.player.arm(), /not on standby/);
});

test('arming restarts the lease from the first audio, not from when the device opened', async () => {
  const f = fixture(); await f.player.open({sampleRate: 8000, channels: 1, token: 'owner', standby: true});
  f.advance(6000); await flush(); await f.player.arm();
  f.advance(1900); await flush(); assert.equal(f.player.snapshot().error, null);
  f.player.control({allow: true, paused: false, volume: 1, pan: 0}); await flush();
  f.advance(1900); await flush(); assert.equal(f.player.snapshot().error, null);
  await f.player.stop(); assert.equal(f.context.closeCount, 1);
});

test('a standby player is bounded and stopping it releases the device', async () => {
  const f = fixture(); await f.player.open({sampleRate: 8000, channels: 1, token: 'owner', standby: true});
  f.advance(69000); await flush(); assert.equal(f.player.snapshot().error, null);
  f.advance(1000); await flush();
  assert.match(f.player.snapshot().error, /standby expired/); assert.equal(f.context.closeCount, 1);
  const g = fixture(); await g.player.open({sampleRate: 8000, channels: 1, token: 'owner', standby: true});
  await g.player.stop('cancelled'); assert.equal(g.context.closeCount, 1);
  assert.equal(g.player.snapshot().state, 'stopped'); await assert.rejects(g.player.arm(), /not on standby/);
});

test('a standby player never opens an ordinary player twice and a plain player cannot be armed', async () => {
  const f = fixture(); await f.player.open({sampleRate: 8000, channels: 1, token: 'owner'});
  await assert.rejects(f.player.arm(), /not on standby/);
  assert.equal(f.player.snapshot().error, null);
  await f.player.stop();
});
