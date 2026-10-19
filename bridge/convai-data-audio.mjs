// Convai LiveKit audio_config.output.audio_routing=data_only, PCM16LE.
// Keep source samples byte-for-byte. A network packet is not a playback clip.
// https://docs.convai.com/api-docs/api-reference/core-api-reference/live-apis-beta/audio-data-via-data-channel
//
// Ownership limit: audio-data carries no response ID. The caller must admit only
// one submitted turn on a verified remote participant, and discard the entire
// connection after cancellation/failure before admitting another turn. This
// collector cannot identify old ownerless PCM on a reused cancelled connection.
const TYPES = new Set(['audio-data', 'chunked-neurosync-blendshapes',
  'blendshape-turn-stats', 'bot-started-speaking', 'bot-stopped-speaking',
  'bot-turn-completed', 'neurosync-blendshapes-cancel']);
const MAX_WIRE_BYTES = 1048576;
// Convai's declared duration is a rounded millisecond figure that may be summed per packet, so on a long reply it drifts from
// bytes / (rate * channels * 2) by a few milliseconds (2026-10-20: one 0.2.2 turn failed on exactly this). The byte count is the
// authority for playback, so the duration only has to be about right: this slack covers rounding, while a wrong sample rate or
// channel count (an 8 percent error or more) still fails.
const DURATION_SLACK_SECONDS = 0.03, DURATION_SLACK_FRACTION = 0.01;
const durationSlack = seconds => DURATION_SLACK_SECONDS + DURATION_SLACK_FRACTION * seconds;
const ownerFields = ['response_id', 'neurosync_turn_id', 'epoch'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;

function getOwner(data) {
  const owner = {};
  if (data.response_id !== undefined) {
    if (typeof data.response_id !== 'string' || !data.response_id || data.response_id.length > 512)
      throw Error('Invalid Convai speech owner');
    owner.response_id = data.response_id;
  }
  const neuro = data.neurosync_turn_id ?? data.turn_id;
  if (neuro !== undefined) {
    if (!integer(neuro)) throw Error('Invalid Convai facial owner');
    owner.neurosync_turn_id = neuro;
  }
  if (data.epoch !== undefined) {
    if (!integer(data.epoch)) throw Error('Invalid Convai speech epoch');
    owner.epoch = data.epoch;
  }
  return owner;
}

function hasOwner(owner) {
  return owner.response_id !== undefined || owner.neurosync_turn_id !== undefined;
}

function sameOwner(left, right) {
  if (!hasOwner(left) || !hasOwner(right)) return false;
  let common = false;
  for (const field of ownerFields) {
    if (left[field] !== undefined && right[field] !== undefined) {
      if (left[field] !== right[field]) return false;
      if (field !== 'epoch') common = true;
    }
  }
  return common;
}

function unwrap(input) {
  let message = input;
  if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_WIRE_BYTES) throw Error('Convai audio message exceeds the size limit');
    try { message = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(input)); }
    catch { throw Error('Invalid Convai data message'); }
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  if (message.label !== undefined && message.label !== 'rtvi-ai') return null;
  if (message.type === 'server-message') {
    const data = message.data;
    return data && typeof data === 'object' && !Array.isArray(data) && TYPES.has(data.type) ? data : null;
  }
  if (!TYPES.has(message.type)) return null;
  if (Object.hasOwn(message, 'data')) {
    if (!message.data || typeof message.data !== 'object' || Array.isArray(message.data))
      throw Error('Invalid Convai lifecycle payload');
    if (message.data.type !== undefined && message.data.type !== message.type)
      throw Error('Conflicting Convai lifecycle event types');
    // Live production emits owned speaking/terminal events at the top level,
    // with their fields in data. Its outer type is authoritative. Audio and
    // NeuroSync continue to arrive inside the server-message envelope above.
    return {...message.data, type: message.type};
  }
  return message;
}

function decodePcm(base64) {
  if (typeof base64 !== 'string' || !base64.length || base64.length > MAX_WIRE_BYTES
      || base64.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))
    throw Error('Invalid Convai PCM payload');
  const binary = atob(base64), bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}

function wav(parts, byteCount, rate, channels) {
  const bytes = new Uint8Array(44 + byteCount), view = new DataView(bytes.buffer);
  const ascii = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + byteCount, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true); view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, byteCount, true);
  let offset = 44;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return base64(bytes);
}

export class ConvaiDataAudio {
  constructor({retiredOwners = [], maxSeconds = 120, maxBytes = 24000000} = {}) {
    if (!finite(maxSeconds) || maxSeconds <= 0 || maxSeconds > 120
        || !integer(maxBytes) || maxBytes < 2 || maxBytes > 24000000)
      throw Error('Invalid Convai audio limits');
    this.maxSeconds = maxSeconds; this.maxBytes = maxBytes;
    this.retiredOwners = retiredOwners.map(getOwner);
    this.parts = []; this.byteCount = 0; this.packetCount = 0;
    this.pcmCursor = 0; this.drainedFrames = 0;
    this.frames = new Map(); this.facialDiagnostic = null;
    this._owner = null; this.error = null; this.terminal = null; this.stats = null;
    this.sampleRate = null; this.channels = null; this.fps = null;
    this.timing = {}; this.sealed = false; this.result = null;
  }

  get owner() { return this._owner ? {...this._owner} : null; }

  get ready() {
    if (this.error || this.sealed || !this.stats || !this.terminal || !this.sampleRate) return false;
    return this.byteCount === this.stats.total_audio_bytes;
  }

  fail(message) {
    this.error ??= Error(message);
    this.parts.length = 0; this.frames.clear();
    throw this.error;
  }

  abort(reason = 'Convai audio cancelled') {
    if (this.sealed) return;
    this.error ??= Error(reason);
    this.parts.length = 0; this.frames.clear();
  }

  transportClosed() {
    if (!this.ready && !this.sealed) this.abort('Convai audio connection closed before collection finished');
  }

  faceFault(message) {
    this.facialDiagnostic ??= message;
    this.frames.clear();
  }

  // Why an owner was refused, for the error report (2026-10-19: four turns of one player failed on this, and the report said only that
  // the owner was replaced): which identifier fields the message carried against the active owner's (never their values), the message
  // type, and how far the active response had got. Field and type names only; type is one of TYPES.
  ownerChange(owner, type) {
    const fields = ownerFields.map(field => {
      const had = this._owner?.[field] !== undefined, has = owner[field] !== undefined;
      return `${field} ${had && has ? (this._owner[field] === owner[field] ? 'same' : 'differs') : had ? 'absent in the new message' : has ? 'new' : 'none'}`;
    });
    return `${TYPES.has(type) ? type : 'other'}; ${fields.join(', ')}; the active response had ${this.packetCount} audio packets, `
      + `${this.stats ? 'its statistics' : 'no statistics'}, ${this.terminal ? 'its end' : 'no end'}`;
  }

  accept(input, {kind, atMs} = {}) {
    if (this.error || this.sealed) return false;
    try {
      const data = unwrap(input);
      if (!data) return false;
      // LiveKit DataPacket_Kind.RELIABLE=0. Ownerless PCM must never accept a
      // lossy channel or silently concatenate audio after transport loss.
      if (kind !== 0) return this.fail('Convai speech requires reliable ordered data');
      if (!finite(atMs) || atMs < 0) return this.fail('Invalid Convai audio arrival time');
      if (data.type !== 'audio-data') {
        const owner = getOwner(data);
        // Generic RTVI speaking flags are UI signals, not this response's
        // ownership or completion proof. Only owned lifecycle messages matter.
        if (!hasOwner(owner) && ['bot-started-speaking', 'bot-stopped-speaking'].includes(data.type)) return false;
        if (!hasOwner(owner)) return this.fail('Convai speech metadata has no response owner');
        if (this.retiredOwners.some(retired => sameOwner(retired, owner))) return false;
        if (this._owner && !sameOwner(this._owner, owner)) return this.fail(`Convai replaced the active speech owner (${this.ownerChange(owner, data.type)})`);
        this._owner = {...this._owner, ...owner};
      }
      switch (data.type) {
        case 'audio-data': this.addAudio(data, atMs); break;
        case 'chunked-neurosync-blendshapes': this.addFaces(data, atMs); break;
        case 'blendshape-turn-stats': this.addStats(data.stats); break;
        case 'bot-turn-completed':
          if (data.was_interrupted !== false || data.was_aborted === true)
            return this.fail('Convai speech turn was interrupted or aborted');
          this.terminal = {atMs}; break;
        case 'neurosync-blendshapes-cancel': return this.fail('Convai cancelled the active facial/audio response');
      }
      this.validateTotals();
      if (this.ready) this.timing.collectionCompleteMs ??= atMs;
      return true;
    } catch (error) {
      if (this.error) throw this.error;
      return this.fail(error.message || 'Invalid Convai speech data');
    }
  }

  addAudio(data, atMs) {
    const rate = data.sample_rate, channels = data.channels;
    if (!Number.isInteger(rate) || rate < 8000 || rate > 96000 || ![1, 2].includes(channels)
        || data.includes_wav_header !== false) return this.fail('Unsupported Convai PCM format');
    if (this.sampleRate !== null && (this.sampleRate !== rate || this.channels !== channels))
      return this.fail('Convai changed PCM format during the response');
    const bytes = decodePcm(data.audio);
    if (!bytes.length || bytes.length % (channels * 2)) return this.fail('Unaligned Convai PCM samples');
    const total = this.byteCount + bytes.length;
    if (total > this.maxBytes || total / (rate * channels * 2) > this.maxSeconds)
      return this.fail('Convai speech exceeded the collection limit');
    this.sampleRate = rate; this.channels = channels;
    this.parts.push(bytes); this.byteCount = total; this.packetCount++;
    this.timing.firstAudioMs ??= atMs; this.timing.completeAudioMs = atMs;
  }

  addFaces(data, atMs) {
    if (this.facialDiagnostic) return;
    const fps = data.fps, first = data.start_frame_index, frames = data.blendshapes;
    if (!finite(fps) || fps < 1 || fps > 120 || !integer(first) || !Array.isArray(frames)
        || !frames.length || frames.length > 1000 || first + frames.length > Math.ceil(this.maxSeconds * fps) + 1)
      return this.faceFault('Invalid indexed Convai facial data');
    if (this.fps !== null && fps !== this.fps) return this.faceFault('Convai changed the facial frame clock');
    this.fps = fps;
    for (let offset = 0; offset < frames.length; offset++) {
      const frame = frames[offset], index = first + offset;
      if (!Array.isArray(frame) || frame.length !== 61 || frame.some(value => !finite(value)))
        return this.faceFault('Invalid Convai ARKit facial frame');
      const previous = this.frames.get(index);
      if (previous && previous.some((value, i) => value !== frame[i]))
        return this.faceFault('Conflicting Convai facial frame');
      if (!previous) this.frames.set(index, frame.slice());
    }
    this.timing.firstFaceMs ??= atMs; this.timing.completeFaceMs = atMs;
  }

  addStats(stats) {
    if (!stats || !integer(stats.total_audio_bytes) || stats.total_audio_bytes < 2
        || stats.total_audio_bytes > this.maxBytes
        || !finite(stats.total_audio_duration_ms) || stats.total_audio_duration_ms <= 0
        || stats.total_audio_duration_ms > this.maxSeconds * 1000 || stats.was_interrupted !== false)
      return this.fail('Invalid Convai final speech statistics');
    if (!integer(stats.total_blendshapes) || stats.total_blendshapes < 1
        || !finite(stats.fps) || stats.fps < 1 || stats.fps > 120)
      this.faceFault('Invalid Convai final facial statistics');
    const next = {total_audio_bytes: stats.total_audio_bytes, total_blendshapes: stats.total_blendshapes,
      fps: stats.fps, total_audio_duration_ms: stats.total_audio_duration_ms, was_interrupted: false};
    if (this.stats) {
      if (['total_audio_bytes', 'total_audio_duration_ms'].some(key => next[key] !== this.stats[key]))
        return this.fail('Conflicting Convai final speech statistics');
      if (['fps', 'total_blendshapes'].some(key => next[key] !== this.stats[key]))
        this.faceFault('Conflicting Convai final facial statistics');
    }
    this.stats = next;
  }

  validateTotals() {
    if (!this.stats) return;
    if (this.byteCount > this.stats.total_audio_bytes)
      return this.fail('Convai speech exceeds the declared output size');
    if (this.frames.size > this.stats.total_blendshapes || [...this.frames.keys()].some(index => index >= this.stats.total_blendshapes))
      this.faceFault('Convai facial data exceeds its declared frame count');
    if (this.fps !== null && this.fps !== this.stats.fps) this.faceFault('Convai facial statistics use a different frame clock');
    const declaredSeconds = this.stats.total_audio_duration_ms / 1000;
    if (Math.abs(this.stats.total_blendshapes / this.stats.fps - declaredSeconds) > 1 / this.stats.fps + 0.001 + durationSlack(declaredSeconds))
      this.faceFault('Convai facial duration does not match its speech');
    if (this.sampleRate) {
      const align = this.channels * 2, bytes = this.stats.total_audio_bytes;
      const counted = bytes / (align * this.sampleRate);
      const numbers = `${bytes} bytes, ${this.stats.total_audio_duration_ms} ms declared against ${(counted * 1000).toFixed(1)} ms counted, `
        + `${this.sampleRate} Hz, ${this.channels} channel${this.channels === 1 ? '' : 's'}, ${this.packetCount} packets`;
      if (bytes % align) return this.fail(`Convai PCM size is not a whole number of samples (${numbers})`);
      if (Math.abs(counted - declaredSeconds) > 1 / this.sampleRate + 0.001 + durationSlack(declaredSeconds))
        return this.fail(`Convai PCM size does not match its declared duration (${numbers})`);
    }
  }

  // A packet is admitted by accept() first. Ownerless PCM may precede the
  // facial/lifecycle owner, so hold it until that owner is established. Return
  // independent bytes: a worklet may transfer its input buffer to its thread.
  drainPcm() {
    if (this.error) throw this.error;
    if (this.sealed || !this._owner || !this.sampleRate) return [];
    const packets = [];
    while (this.pcmCursor < this.parts.length) {
      const bytes = this.parts[this.pcmCursor++].slice();
      packets.push({bytes, offsetFrames: this.drainedFrames});
      this.drainedFrames += bytes.length / (this.channels * 2);
    }
    return packets;
  }

  progress() {
    if (this.result) return {sampleRate: this.result.sampleRate, channels: this.result.channels,
      receivedFrames: this.byteCount / (this.result.channels * 2), faces: this.result.faces,
      facesFormat: 'arkit61', facesTimebase: 'audio-seconds', sourceComplete: true};
    return {sampleRate: this.sampleRate, channels: this.channels,
      receivedFrames: this.channels ? this.byteCount / (this.channels * 2) : 0,
      faces: this.facialDiagnostic || !this.fps ? [] : [...this.frames.entries()]
        .sort(([a], [b]) => a - b).map(([index, values]) => ({at: index / this.fps, values: values.slice()})),
      facesFormat: 'arkit61', facesTimebase: 'audio-seconds', sourceComplete: this.ready};
  }

  finish({includeAudio = true} = {}) {
    if (this.error) throw this.error;
    if (this.result) return this.result;
    if (!this.ready) throw Error('Convai speech has not delivered its complete audio and terminal statistics');
    const duration = this.byteCount / (this.sampleRate * this.channels * 2);
    if (!this.facialDiagnostic) {
      if (!this.fps || this.frames.size !== this.stats.total_blendshapes)
        this.faceFault('Convai facial timeline is incomplete');
      else for (let index = 0; index < this.frames.size; index++) {
        if (!this.frames.has(index)) { this.faceFault('Convai facial timeline has missing indices'); break; }
      }
    }
    const faces = this.facialDiagnostic ? [] : Array.from({length: this.frames.size}, (_, index) => ({at: index / this.fps, values: this.frames.get(index)}));
    const audio = includeAudio ? wav(this.parts, this.byteCount, this.sampleRate, this.channels) : undefined;
    this.result = {...(includeAudio ? {audio} : {}), duration, sampleRate: this.sampleRate, channels: this.channels, bits: 16,
      faces, facesFormat: 'arkit61', facesTimebase: 'audio-seconds',
      timing: {...this.timing}, stats: {...this.stats}, packetCount: this.packetCount,
      ...(this.facialDiagnostic ? {facialDiagnostic: this.facialDiagnostic} : {})};
    this.sealed = true; this.parts.length = 0; this.frames.clear();
    return this.result;
  }
}
