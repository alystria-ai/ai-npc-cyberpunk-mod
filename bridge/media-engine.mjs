// The page side of the media channel (music beds and sound effects of a story pack, docs/BOND_QUESTS.md 19.2 and 19.3): a second, non-positional audio stream in the hidden
// browser, beside the voice and never in front of it. It runs in its OWN page (bridge/media-pcm-client.mjs, served at /media by bridge/realtime-host.mjs), with its own
// AudioContext: the speech renderer's page, worklet, lease and packets are not touched, so speech keeps absolute priority and its latency cannot change.
//
// A sound is decoded by the bridge (bridge/prepared-audio.mjs) and sent here once as mono 16 bit packets (begin, append, seal), then played any number of times from the kept
// AudioBuffer (play). Everything is a Web Audio node: a looping AudioBufferSourceNode, a gain with an automation for the fades, a stereo panner, and one ducking bus that all
// "duck" sounds go through, lowered while any speech plays (duck). There is no timer, no polling and no per-frame code here: a fade is an automation, an end is the source's
// own `ended` event (posted to the bridge, which keeps its list of what plays), and the page does nothing at all while nothing plays.
//
// `context` is an AudioContext (or a fake with the same few calls, which is how bridge/media-engine.test.mjs checks the graph without a browser). `post(event)` tells the
// bridge about an end: {type: 'ended', id}. Loaded by the page as a module: it imports only bridge/media-mix.mjs, which has no imports.
import {MEDIA, clampFade, clampPan, clampVolume, duckTarget, rampTo, startEnvelope, stopPlan} from './media-mix.mjs';

const KEY = /^[A-Za-z0-9._:\/-]{1,160}$/;
const ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** Mono 16 bit little endian samples as floats, from base64. Throws on text that is not a whole number of samples. */
export function base64ToFloat(text) {
  if (typeof text !== 'string' || !text.length) throw Error('Empty media packet');
  const raw = atob(text);
  if (raw.length % 2) throw Error('Malformed media packet');
  const out = new Float32Array(raw.length >> 1);
  for (let i = 0; i < out.length; i++) {
    let value = (raw.charCodeAt(2 * i + 1) << 8) | raw.charCodeAt(2 * i);
    if (value & 0x8000) value -= 0x10000;
    out[i] = value / 32768;
  }
  return out;
}

function apply(param, points) {
  for (const point of points) {
    if (point.ramp) param.linearRampToValueAtTime(point.value, point.time);
    else param.setValueAtTime(point.value, point.time);
  }
}

export class MediaEngine {
  constructor({context, post = () => {}, maxBytes = MEDIA.maxBytes} = {}) {
    if (!context) throw Error('The media engine needs an audio context');
    Object.assign(this, {context, post, maxBytes});
    this.loading = new Map(); this.buffers = new Map(); this.items = new Map(); this.ducked = false; this.bytes = 0; this.uses = 0;
    // Two buses: sounds that duck go through duckBus (lowered under speech), the others straight to the output.
    this.bus = context.createGain(); this.duckBus = context.createGain();
    this.bus.connect(context.destination); this.duckBus.connect(context.destination);
  }

  /** The one entry point the bridge calls: run(method, argument). Only these methods exist. */
  run(method, argument) {
    switch (method) {
      case 'begin': return this.begin(argument);
      case 'append': return this.append(argument);
      case 'seal': return this.seal(argument);
      case 'play': return this.play(argument);
      case 'stop': return this.stop(argument);
      case 'stopAll': return this.stopAll(argument);
      case 'fade': return this.fade(argument);
      case 'duck': return this.duck(argument);
      case 'state': return this.state();
      default: throw Error('Unknown media command');
    }
  }

  // ---- loading: a sound arrives once, in packets of at most MEDIA.packetFrames ----
  begin({key, rate, frames} = {}) {
    if (!KEY.test(key ?? '') || !Number.isInteger(rate) || rate < 8000 || rate > 96000 || !Number.isInteger(frames) || frames < 1 || frames > MEDIA.maxFrames)
      throw Error('Invalid media sound');
    this.loading.set(key, {rate, frames, received: 0, data: new Float32Array(frames)});
    return {key};
  }

  append({key, offsetFrames, pcm} = {}) {
    const load = this.loading.get(key);
    if (!load) throw Error('No such media sound is loading');
    const samples = base64ToFloat(pcm);
    if (offsetFrames !== load.received || samples.length > MEDIA.packetFrames || load.received + samples.length > load.frames) throw Error('Media packet out of order');
    load.data.set(samples, load.received); load.received += samples.length;
    return {key, received: load.received};
  }

  seal({key} = {}) {
    const load = this.loading.get(key);
    if (!load || load.received !== load.frames) throw Error('The media sound is not complete');
    this.loading.delete(key);
    const buffer = this.context.createBuffer(1, load.frames, load.rate);
    buffer.copyToChannel(load.data, 0);
    const previous = this.buffers.get(key);
    if (previous) this.bytes -= previous.bytes;
    this.buffers.set(key, {buffer, bytes: load.frames * 4, used: ++this.uses}); this.bytes += load.frames * 4;
    return {key, frames: load.frames, evicted: this.evict(key)};
  }

  // The least recently used sounds that nothing is playing go when the kept buffers pass the cap.
  evict(keep) {
    const playing = new Set([keep, ...[...this.items.values()].map(item => item.key)]), removed = [];
    for (const [key, row] of [...this.buffers].sort((a, b) => a[1].used - b[1].used)) {
      if (this.bytes <= this.maxBytes) break;
      if (playing.has(key)) continue;
      this.buffers.delete(key); this.bytes -= row.bytes; removed.push(key);
    }
    return removed;
  }

  // ---- playing ----
  play({id, key, loop = false, volume = 1, fadeIn = 0, fadeOut = 0, pan = 0, duck = false} = {}) {
    if (!ID.test(id ?? '')) throw Error('Invalid media id');
    const row = this.buffers.get(key);
    if (!row) throw Error('The media sound is not loaded');
    // A sound that is only fading out to its stop does not count against the limit.
    if (!this.items.has(id) && [...this.items.values()].filter(item => !item.stopping).length >= MEDIA.maxItems) throw Error('Too many sounds are playing');
    if (this.items.has(id)) this.stop({id, fadeOut: 0.1});
    const context = this.context, now = context.currentTime;
    if (context.state === 'suspended') void Promise.resolve(context.resume()).catch(() => {});
    row.used = ++this.uses;
    const source = context.createBufferSource(), gain = context.createGain(), panner = context.createStereoPanner();
    source.buffer = row.buffer; source.loop = loop === true;
    const duration = loop === true ? null : row.buffer.duration;
    gain.gain.cancelScheduledValues(now);
    apply(gain.gain, startEnvelope({now, volume, fadeIn, fadeOut, duration, loop: loop === true}));
    panner.pan.value = clampPan(pan);
    source.connect(gain); gain.connect(panner); panner.connect(duck === true ? this.duckBus : this.bus);
    const item = {id, key, source, gain, panner, loop: loop === true, duck: duck === true, volume: clampVolume(volume), stopping: false};
    source.onended = () => this.finish(id, source, [source, gain, panner]);
    this.items.set(id, item);
    source.start(now);
    return {id, duration};
  }

  // A source ended. Its nodes are always let go of. The bridge is told only when this was the sound that holds the id now (a sound replaced by a new one under the same id
  // ends quietly: the id still plays).
  finish(id, source, nodes) {
    for (const node of nodes) { try { node.disconnect(); } catch { /* already gone */ } }
    const item = this.items.get(id);
    if (!item || item.source !== source) return;
    this.items.delete(id);
    try { this.post({type: 'ended', id}); } catch { /* the bridge's list is corrected by its next command */ }
  }

  stop({id, fadeOut = 0.3} = {}) {
    const item = this.items.get(id);
    if (!item || item.stopping) return false;
    const now = this.context.currentTime, plan = stopPlan({now, current: item.gain.gain.value, fadeOut: clampFade(fadeOut)});
    item.gain.gain.cancelScheduledValues(now);
    apply(item.gain.gain, plan.points);
    item.source.stop(plan.stopAt);
    item.stopping = true;
    return true;
  }

  stopAll({fadeOut = 0.3} = {}) {
    let stopped = 0;
    for (const id of [...this.items.keys()]) if (this.stop({id, fadeOut})) stopped++;
    return stopped;
  }

  // A new level and/or pan, reached over `seconds`: a fade, or the game steering a positional loop (a few times a second at most).
  fade({id, volume, pan, seconds = 1} = {}) {
    const item = this.items.get(id);
    if (!item || item.stopping) return false;
    const now = this.context.currentTime;
    if (volume !== undefined) {
      item.gain.gain.cancelScheduledValues(now);
      apply(item.gain.gain, rampTo({now, current: item.gain.gain.value, target: volume, seconds}));
      item.volume = clampVolume(volume);
    }
    if (pan !== undefined) {
      item.panner.pan.cancelScheduledValues(now);
      item.panner.pan.setValueAtTime(item.panner.pan.value, now);
      item.panner.pan.linearRampToValueAtTime(clampPan(pan), now + Math.max(MEDIA.minFade, clampFade(seconds)));
    }
    return true;
  }

  // The ducking bus down (any speech plays) or back up (none does).
  duck({on} = {}) {
    on = on === true;
    if (this.ducked === on) return false;
    this.ducked = on;
    const now = this.context.currentTime, {target, timeConstant} = duckTarget(on);
    this.duckBus.gain.cancelScheduledValues(now);
    this.duckBus.gain.setValueAtTime(this.duckBus.gain.value, now);
    this.duckBus.gain.setTargetAtTime(target, now, timeConstant);
    return true;
  }

  state() {
    return {items: [...this.items.values()].map(item => ({id: item.id, key: item.key, loop: item.loop, duck: item.duck, volume: item.volume, stopping: item.stopping})),
      buffers: this.buffers.size, bytes: this.bytes, ducked: this.ducked, context: this.context.state};
  }

  async close() {
    for (const id of [...this.items.keys()]) { const item = this.items.get(id); try { item.source.onended = null; item.source.stop(); } catch { /* not started */ } this.items.delete(id); }
    this.loading.clear(); this.buffers.clear(); this.bytes = 0;
    try { await this.context.close?.(); } catch { /* closed already */ }
  }
}
