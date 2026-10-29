// A stand-in for the browser's AudioContext, for the media channel's tests (bridge/media-engine.test.mjs, bridge/media-host.test.mjs): the few calls bridge/media-engine.mjs makes,
// with real automation maths behind `value` (bridge/media-mix.mjs gainAt and duckAt) and a clock the test moves by hand. Not used by the bridge.
import {duckAt, gainAt} from './media-mix.mjs';

export class FakeParam {
  constructor(context, initial = 1) { this.context = context; this.base = initial; this.events = []; }
  get value() {
    const t = this.context.currentTime;
    let value = this.base, last = -Infinity;
    const steps = [], targets = [];
    for (const event of this.events) (event.type === 'target' ? targets : steps).push(event);
    if (steps.length) { value = gainAt(steps.map(event => ({time: event.time, value: event.value, ramp: event.type === 'ramp'})), t, this.base); last = steps.filter(event => event.time <= t).at(-1)?.time ?? -Infinity; }
    const target = targets.filter(event => event.time <= t && event.time >= last).at(-1);
    return target ? duckAt(target.from, target.target, target.constant, t - target.time) : value;
  }
  set value(next) { this.base = next; this.events = []; }
  setValueAtTime(value, time) { this.events.push({type: 'set', value, time}); return this; }
  linearRampToValueAtTime(value, time) { this.events.push({type: 'ramp', value, time}); return this; }
  setTargetAtTime(target, time, constant) { this.events.push({type: 'target', target, time, constant, from: this.value}); return this; }
  cancelScheduledValues(time) { const now = this.value; this.events = this.events.filter(event => event.time < time); this.base = this.events.length ? this.base : now; return this; }
}

class FakeNode {
  constructor(context) { this.context = context; this.to = null; this.disconnected = false; }
  connect(node) { this.to = node; return node; }
  disconnect() { this.to = null; this.disconnected = true; }
}
export class FakeGain extends FakeNode { constructor(context) { super(context); this.gain = new FakeParam(context, 1); } }
export class FakePanner extends FakeNode { constructor(context) { super(context); this.pan = new FakeParam(context, 0); } }
export class FakeSource extends FakeNode {
  constructor(context) { super(context); this.buffer = null; this.loop = false; this.onended = null; this.startedAt = null; this.stopAt = null; this.ended = false; }
  start(time) { this.startedAt = time; }
  stop(time = this.context.currentTime) { this.stopAt = this.stopAt === null ? time : Math.min(this.stopAt, time); }
}

export class FakeAudioContext {
  constructor() {
    this.currentTime = 0; this.state = 'running'; this.destination = new FakeNode(this); this.sources = []; this.buffers = []; this.closed = false;
  }
  createGain() { return new FakeGain(this); }
  createStereoPanner() { return new FakePanner(this); }
  createBufferSource() { const source = new FakeSource(this); this.sources.push(source); return source; }
  createBuffer(channels, frames, rate) {
    const buffer = {numberOfChannels: channels, length: frames, sampleRate: rate, duration: frames / rate, data: null, copyToChannel(data) { this.data = data; }};
    this.buffers.push(buffer); return buffer;
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
  /** Moves the clock and ends every source whose stop time, or natural end, has passed (the browser's `ended` event). */
  advance(seconds) {
    this.currentTime += seconds;
    for (const source of this.sources) {
      if (source.ended || source.startedAt === null) continue;
      const natural = source.loop ? Infinity : source.startedAt + (source.buffer?.duration ?? 0);
      if ((source.stopAt !== null && source.stopAt <= this.currentTime) || natural <= this.currentTime) { source.ended = true; source.onended?.(); }
    }
  }
}
