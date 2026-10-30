// One source sample clock for a whole utterance. The renderer never interprets
// packet boundaries as sound boundaries and never changes the supplied PCM.
export const PCM_LIMITS = Object.freeze({maxSeconds: 120, maxBytes: 24000000,
  startupSeconds: 0.4, holdAfterMs: 500, expireAfterMs: 2000,
  // After the voice breaks (the buffer ran dry), the audio to have in hand before it plays on again grows with each break of the line
  // (0.8, 1.6, 3.2 s, never above maxRefillSeconds) and jumps further when the audio was measured to arrive slower than it plays: a
  // refill of the start's 0.4 s taking longer to arrive than to play broke the line every 0.4 s (a Pocket voice on a busy CPU: 17 breaks in
  // 30 s). carrySeconds: how long one refill should carry a line arriving at the measured speed. refillWaitMs: the longest a refill waits.
  maxRefillSeconds: 4, carrySeconds: 2.5, refillWaitMs: 6000, minMeasureMs: 250,
  // A device opened before its first audio exists waits silently for at most this
  // long (the Convai request's own 60 s ceiling plus margin). It is not a lease:
  // nothing can sound until arm() starts the ordinary 2 s game lease.
  standbyMs: 70000});

/**
 * The player's own reason for a failure as a short printable suffix, " (Playback admission expired)", or "" when there is none. A refused append says why the player was
 * already closed, so a report names the cause (the lease, the device, the renderer) and not only the refusal it came to (reports c1808dbe181f54da and bba9bf36c83e5565,
 * 29 Oct 2026: "PCM player cannot accept audio" on every reply of one install, with the reason lost). Only the player's own strings reach it.
 */
export function pcmReason(reason) {
  const text = typeof reason === 'string' ? reason.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  return text ? ` (${text})` : '';
}

export function pcmFormat(sampleRate, channels) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000
      || ![1, 2].includes(channels)) throw Error('Unsupported continuous PCM format');
  return {sampleRate, channels, align: channels * 2,
    maxFrames: Math.min(sampleRate * PCM_LIMITS.maxSeconds, Math.floor(PCM_LIMITS.maxBytes / (channels * 2)))};
}

export function playbackControl(value) {
  if (!value || typeof value.allow !== 'boolean' || typeof value.paused !== 'boolean')
    throw Error('Invalid playback admission');
  const volume = value.volume ?? 1, pan = value.pan ?? 0;
  if (!Number.isFinite(volume) || volume < 0 || volume > 1
      || !Number.isFinite(pan) || pan < -1 || pan > 1) throw Error('Invalid playback volume or pan');
  // Optional dialogue-level fields (docs/DIALOGUE_LEVEL.md): makeup gain in dB
  // behind a peak limiter, and the speaker's distance for a gentle air low-pass.
  // Absent means the previous unity path.
  // delayMs: the Lip sync delay setting (bridge/audio-delay.mjs), audio heard
  // after the Windows mix (Bluetooth). It holds the heard cursor back.
  // makeupDb is the dialogue level plus the Voice volume setting (bridge/dialogue-level.mjs): -6.02 dB (50% with matching off) to
  // +21.54 dB (12 dB of dialogue level and 300%). Anything below 0 is plain attenuation.
  const makeupDb = value.makeupDb ?? 0, distance = value.distance ?? null, delayMs = value.delayMs ?? 0;
  if (!Number.isFinite(makeupDb) || makeupDb < -6.03 || makeupDb > 21.55
      || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > 500
      || (distance !== null && (!Number.isFinite(distance) || distance < 0 || distance > 1000)))
    throw Error('Invalid playback level');
  return {allow: value.allow, paused: value.paused, volume, pan, makeupDb, distance, delayMs};
}

// Chromium derives the worklet's currentTime from currentFrame. A live device
// trace repeated both ends of one context quantum while the renderer supplied
// the next 128 source samples. Give every supplied output quantum its own place
// on the context timeline; never replay or discard PCM to repair that timestamp.
export class PcmQuantumClock {
  constructor(sampleRate) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000)
      throw Error('Invalid PCM quantum sample rate');
    this.sampleRate = sampleRate; this.previousRawFrame = null;
    this.previousStartFrame = null; this.nextFrame = null;
    this.corrections = 0; this.repeatedQuanta = 0;
    this.leadFrames = 0; this.maxLeadFrames = 0; this.diagnostic = null;
  }

  next(rawFrame, frames) {
    if (!Number.isSafeInteger(rawFrame) || rawFrame < 0
        || !Number.isSafeInteger(frames) || frames < 1
        || !Number.isSafeInteger(rawFrame + frames)) throw Error('Invalid PCM render quantum');
    if (this.previousRawFrame !== null && rawFrame < this.previousRawFrame) {
      const error = Error('PCM render frame clock regressed');
      error.clockDiagnostic = {previousRawFrame: this.previousRawFrame,
        previousStartFrame: this.previousStartFrame, previousEndFrame: this.nextFrame,
        nextRawFrame: rawFrame, quantumFrames: frames};
      throw error;
    }
    const startFrame = Math.max(rawFrame, this.nextFrame ?? rawFrame);
    this.leadFrames = startFrame - rawFrame;
    if (this.leadFrames) {
      this.corrections++;
      if (rawFrame === this.previousRawFrame) this.repeatedQuanta++;
      this.maxLeadFrames = Math.max(this.maxLeadFrames, this.leadFrames);
      this.diagnostic = {previousRawFrame: this.previousRawFrame,
        previousStartFrame: this.previousStartFrame, previousEndFrame: this.nextFrame,
        nextRawFrame: rawFrame, mappedStartFrame: startFrame, quantumFrames: frames};
    }
    this.previousRawFrame = rawFrame; this.previousStartFrame = startFrame;
    this.nextFrame = startFrame + frames;
    return startFrame / this.sampleRate;
  }

  controlTime(rawFrame) {
    if (!Number.isSafeInteger(rawFrame) || rawFrame < 0) throw Error('Invalid PCM control frame clock');
    // A MessagePort callback need not advance a render quantum. Refresh the
    // lease at its latest mapped start, without consuming a single source frame.
    return Math.max(rawFrame, this.previousStartFrame ?? rawFrame) / this.sampleRate;
  }

  snapshot() {
    return {clockCorrections: this.corrections, clockRepeatedQuanta: this.repeatedQuanta,
      clockLeadFrames: this.leadFrames, clockMaxLeadFrames: this.maxLeadFrames,
      clockDiagnostic: this.diagnostic};
  }
}

export class ContinuousPcmCore {
  constructor({sampleRate, channels, capacityFrames, startupSeconds = PCM_LIMITS.startupSeconds,
    nowMs = 0, standby = false} = {}) {
    Object.assign(this, pcmFormat(sampleRate, channels));
    if (!Number.isFinite(startupSeconds) || startupSeconds < 0 || startupSeconds > 2
        || !Number.isFinite(nowMs)) throw Error('Invalid continuous PCM buffer policy');
    this.capacityFrames = capacityFrames ?? this.maxFrames;
    if (!Number.isInteger(this.capacityFrames) || this.capacityFrames < 1 || this.capacityFrames > this.maxFrames)
      throw Error('Invalid continuous PCM queue capacity');
    // A bounded PCM16 ring, rather than a queue of per-packet sound objects.
    // At the ordinary 24kHz mono format the 120s ceiling is 5.76 MB of RAM.
    this.samples = new Int16Array(this.capacityFrames * channels);
    this.startupFrames = Math.min(this.capacityFrames, Math.ceil(startupSeconds * sampleRate));
    this.receivedFrames = 0; this.playedFrames = 0; this.bufferedFrames = 0;
    this.readFrame = 0; this.writeFrame = 0; this.underruns = 0;
    this.allow = false; this.paused = false; this.lastControlMs = nowMs;
    this.externalHold = false;
    // Standby: the output device is already running but the stream is not yet
    // admitted. Silent, no lease clock, and no audio may be appended; arm() ends it.
    this.standby = standby === true;
    this.started = false; this.rebuffering = false; this.sealed = false;
    this.stopped = false; this.error = null; this.state = 'awaiting-admission';
    this.startAt = null; this.drainAt = null;
    // The refill target after a break (frames) and the arrival measure it comes from (first and latest append: the time and the frames received).
    this.refillFrames = this.startupFrames; this.breaks = 0; this.rebufferSinceMs = null;
    this.firstAppend = null; this.lastAppend = null;
    this.segment = {start: 0, end: 0, from: 0, to: 0, advancingEnd: 0};
  }

  fail(message) {
    this.error ??= message; this.state = 'error'; this.stopped = true;
    this.bufferedFrames = 0;
    throw Error(this.error);
  }

  // nowMs (optional): the clock of render(), when the packet was taken; the audio's arrival speed is measured from it.
  append(bytes, offsetFrames, nowMs = null) {
    if (this.stopped || this.sealed) throw Error(this.error || 'PCM stream is closed');
    if (this.standby) return this.fail('PCM audio arrived before the stream was armed');
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength % this.align
        || !Number.isSafeInteger(offsetFrames) || offsetFrames !== this.receivedFrames)
      return this.fail('PCM append is malformed or out of order');
    const frames = bytes.byteLength / this.align;
    if (this.receivedFrames + frames > this.maxFrames) return this.fail('PCM utterance exceeds its limit');
    if (this.bufferedFrames + frames > this.capacityFrames) return this.fail('PCM queue capacity exceeded');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Called outside process(), before acknowledging ownership to the sender.
    for (let frame = 0; frame < frames; frame++) {
      const target = ((this.writeFrame + frame) % this.capacityFrames) * this.channels;
      for (let channel = 0; channel < this.channels; channel++)
        this.samples[target + channel] = view.getInt16((frame * this.channels + channel) * 2, true);
    }
    this.writeFrame = (this.writeFrame + frames) % this.capacityFrames;
    this.receivedFrames += frames; this.bufferedFrames += frames;
    if (Number.isFinite(nowMs)) {
      this.firstAppend ??= {nowMs, frames: this.receivedFrames};
      this.lastAppend = {nowMs, frames: this.receivedFrames};
    }
  }

  /** How fast the audio has been arriving, in seconds of audio per second (1: as fast as it plays), after the first packet; null before it can be told. */
  arrivalSpeed() {
    const first = this.firstAppend, last = this.lastAppend;
    if (!first || !last || last.nowMs - first.nowMs < PCM_LIMITS.minMeasureMs) return null;
    return (last.frames - first.frames) / this.sampleRate / ((last.nowMs - first.nowMs) / 1000);
  }

  // The buffer ran dry: the next refill is bigger (doubled, and as large as the measured speed says one refill must be to carry the line).
  growRefill(nowMs) {
    this.breaks++; this.rebufferSinceMs = nowMs;
    let target = Math.max(this.startupFrames, this.refillFrames * 2);
    const speed = this.arrivalSpeed();
    if (speed !== null && speed < 1) target = Math.max(target, Math.ceil(PCM_LIMITS.carrySeconds * (1 - speed) * this.sampleRate));
    this.refillFrames = Math.min(Math.ceil(PCM_LIMITS.maxRefillSeconds * this.sampleRate), this.capacityFrames, Math.ceil(target));
  }

  // Ends standby and starts the ordinary lease at nowMs. Playback still needs a
  // fresh allowing control; arming never admits anything by itself.
  arm(nowMs) {
    if (this.stopped) throw Error(this.error || 'PCM stream is closed');
    if (!this.standby) return;
    if (!Number.isFinite(nowMs) || nowMs < this.lastControlMs) return this.fail('Playback control clock regressed');
    this.standby = false; this.lastControlMs = nowMs; this.allow = false; this.paused = false;
    this.externalHold = false; this.state = 'awaiting-admission';
  }

  control(value, nowMs) {
    if (this.stopped) throw Error(this.error || 'PCM stream is closed');
    // Controls sent while on standby are ignored: only arm() starts the lease.
    if (this.standby) { playbackControl(value); return; }
    if (!Number.isFinite(nowMs) || nowMs < this.lastControlMs) return this.fail('Playback control clock regressed');
    if (nowMs - this.lastControlMs >= PCM_LIMITS.expireAfterMs) return this.fail('Playback admission expired');
    const valid = playbackControl(value);
    this.allow = valid.allow; this.paused = valid.paused; this.lastControlMs = nowMs;
    this.externalHold = false;
  }

  hold() { if (!this.standby) this.externalHold = true; }

  end(totalFrames) {
    if (this.stopped) throw Error(this.error || 'PCM stream is closed');
    if (!Number.isSafeInteger(totalFrames) || totalFrames < 1 || totalFrames !== this.receivedFrames)
      return this.fail('PCM end does not match the accepted sample count');
    this.sealed = true;
    if (this.bufferedFrames === 0) this.state = 'drained';
  }

  stop(reason) {
    if (this.stopped) return;
    this.stopped = true; this.state = 'stopped'; this.bufferedFrames = 0;
  }

  render(output, contextSeconds, nowMs = contextSeconds * 1000) {
    const frames = output?.[0]?.length ?? 0;
    for (const channel of output ?? []) channel.fill(0);
    const segment = this.segment;
    segment.start = contextSeconds; segment.end = contextSeconds + frames / this.sampleRate;
    segment.from = segment.to = this.playedFrames; segment.advancingEnd = contextSeconds;
    if (this.stopped) return segment;
    let validChannels = output?.length === this.channels;
    for (let channel = 0; channel < (output?.length ?? 0); channel++)
      if (output[channel].length !== frames) validChannels = false;
    if (!Number.isFinite(contextSeconds) || !Number.isFinite(nowMs) || frames < 1 || !validChannels) {
      this.error = 'PCM output format changed'; this.stopped = true; this.state = 'error'; return segment;
    }
    if (this.standby) { this.state = 'standby'; return segment; }
    if (this.sealed && this.bufferedFrames === 0) { this.state = 'drained'; return segment; }
    const age = nowMs - this.lastControlMs;
    if (age >= PCM_LIMITS.expireAfterMs) {
      this.error = 'Playback admission expired'; this.stopped = true; this.state = 'error';
      this.bufferedFrames = 0; return segment;
    }
    if (this.externalHold || age >= PCM_LIMITS.holdAfterMs) { this.state = 'lease-held'; return segment; }
    if (!this.allow) { this.state = 'awaiting-admission'; return segment; }
    if (this.paused) { this.state = 'paused'; return segment; }
    // The start waits for startupFrames; a refill after a break for refillFrames, but never longer than refillWaitMs (a producer that slow
    // gets what it has, which is still more than the start's).
    const target = this.started ? this.refillFrames : this.startupFrames;
    if ((!this.started || this.rebuffering) && this.bufferedFrames < target && !this.sealed
        && !(this.rebuffering && this.bufferedFrames >= this.startupFrames && nowMs - this.rebufferSinceMs >= PCM_LIMITS.refillWaitMs)) {
      this.state = 'buffering'; return segment;
    }
    const count = Math.min(frames, this.bufferedFrames);
    if (count) {
      if (!this.started) this.startAt = contextSeconds;
      this.started = true; this.rebuffering = false;
      for (let frame = 0; frame < count; frame++) {
        const source = ((this.readFrame + frame) % this.capacityFrames) * this.channels;
        for (let channel = 0; channel < this.channels; channel++)
          output[channel][frame] = this.samples[source + channel] / 32768;
      }
      this.readFrame = (this.readFrame + count) % this.capacityFrames;
      this.playedFrames += count; this.bufferedFrames -= count;
      segment.to = this.playedFrames; segment.advancingEnd = contextSeconds + count / this.sampleRate;
      this.drainAt = segment.advancingEnd;
    }
    if (this.sealed && !this.bufferedFrames) this.state = 'drained';
    else if (count < frames) {
      if (this.started && !this.rebuffering) { this.underruns++; this.growRefill(nowMs); }
      this.rebuffering = true; this.state = 'buffering';
    } else this.state = 'playing';
    return segment;
  }

  snapshot() {
    return {state: this.state, playedFrames: this.playedFrames, bufferedFrames: this.bufferedFrames,
      receivedFrames: this.receivedFrames, underruns: this.underruns, refillSeconds: this.refillFrames / this.sampleRate, sampleRate: this.sampleRate,
      channels: this.channels, sealed: this.sealed, ended: false, error: this.error,
      startAt: this.startAt, drainAt: this.drainAt};
  }
}

// Map the output device's context time through pauses and underruns. Extrapolating
// playedFrames from wall time would animate words that have not been heard.
export class PcmClockHistory {
  constructor(capacity = 4096) {
    if (!Number.isInteger(capacity) || capacity < 2 || capacity > 16384) throw Error('Invalid PCM clock history');
    this.capacity = capacity; this.count = 0; this.next = 0;
    this.data = new Float64Array(capacity * 5);
  }
  push(start, end, from, to, advancingEnd) {
    if (![start, end, from, to, advancingEnd].every(Number.isFinite) || start < 0
        || end < start || from < 0 || to < from || advancingEnd < start || advancingEnd > end)
      throw Error('Invalid PCM clock segment');
    if (this.count) {
      const previous = ((this.next + this.capacity - 1) % this.capacity) * 5;
      if (start < this.data[previous + 1] - 1e-8 || from !== this.data[previous + 3]) {
        const error = Error('PCM clock segments are not contiguous');
        error.clockDiagnostic = {previousStart: this.data[previous], previousEnd: this.data[previous + 1],
          previousFrom: this.data[previous + 2], previousTo: this.data[previous + 3],
          nextStart: start, nextEnd: end, nextFrom: from, nextTo: to};
        throw error;
      }
    }
    const at = this.next * 5;
    this.data[at] = start; this.data[at + 1] = end; this.data[at + 2] = from;
    this.data[at + 3] = to; this.data[at + 4] = advancingEnd;
    this.next = (this.next + 1) % this.capacity; this.count = Math.min(this.count + 1, this.capacity);
  }
  at(contextSeconds) {
    if (!this.count || !Number.isFinite(contextSeconds)) return 0;
    for (let i = 0; i < this.count; i++) {
      const at = ((this.next - 1 - i + this.capacity) % this.capacity) * 5;
      if (contextSeconds < this.data[at]) continue;
      const from = this.data[at + 2], to = this.data[at + 3], advancingEnd = this.data[at + 4];
      if (contextSeconds >= advancingEnd || to === from) return to;
      return from + (to - from) * Math.max(0, Math.min(1,
        (contextSeconds - this.data[at]) / (advancingEnd - this.data[at])));
    }
    return 0;
  }
}
