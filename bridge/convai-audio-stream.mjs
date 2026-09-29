// The browser receives decoded PCM at playback speed. Publish real captured
// segments while the remote track is still playing; never split a completed
// WAV and call that streaming. This module is shared by browser and Node and
// keeps native/file operations behind injected adapters.
const MAX_DURATION = 120;
const MAX_CHUNKS = 128;
const MAX_TEXT = 12000;
const finite = Number.isFinite;
const cancelled = (message = 'Conversation cancelled') => Object.assign(Error(message), {name: 'AbortError'});
const cleanText = text => typeof text === 'string' ? text.trim().slice(0, MAX_TEXT) : '';

export function encodePcmWav(pcm, sampleRate) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000
      || !(pcm instanceof Float32Array) || !pcm.length || pcm.length > sampleRate * MAX_DURATION) {
    throw Error('Invalid captured speech samples');
  }
  const bytes = new Uint8Array(44 + pcm.length * 2), view = new DataView(bytes.buffer);
  const label = (at, value) => [...value].forEach((c, i) => { bytes[at + i] = c.charCodeAt(0); });
  label(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); label(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  // Same PCM16 conversion as the previous full-reply path. No gain change,
  // normalization, silence removal, resampling, fades, or other processing.
  for (let i = 0; i < pcm.length; i++) {
    if (!finite(pcm[i])) throw Error('Non-finite captured speech sample');
    view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), true);
  }
  let binary = '';
  for (let at = 0; at < bytes.length; at += 16384) binary += String.fromCharCode(...bytes.subarray(at, at + 16384));
  return btoa(binary);
}

// Keep the SDK's audio-seconds timeline. Each native file needs local times,
// with interpolated boundary poses, not a new face timeline starting at zero.
export function sliceFaces(frames, start, end) {
  if (!Array.isArray(frames) || frames.length > 14400 || !finite(start) || !finite(end) || end <= start) return [];
  let previous = -1;
  for (const frame of frames) {
    if (!finite(frame?.at) || frame.at < 0 || frame.at <= previous || frame.at > MAX_DURATION
        || !Array.isArray(frame.values) || frame.values.length !== 61 || !frame.values.every(finite)) return [];
    previous = frame.at;
  }
  const output = [];
  const boundary = at => {
    let right = frames.findIndex(frame => frame.at >= at);
    if (right === -1) return null;
    if (frames[right].at === at) return {at: at - start, values: [...frames[right].values]};
    if (!right) return null;
    const left = frames[right - 1], next = frames[right];
    // Missing facial packets cannot be stretched across an arbitrary gap.
    if (next.at - left.at > .2) return null;
    const mix = (at - left.at) / (next.at - left.at);
    return {at: at - start, values: left.values.map((value, index) => value + (next.values[index] - value) * mix)};
  };
  const first = boundary(start);
  if (first) output.push(first);
  for (const frame of frames) if (frame.at > start && frame.at < end) output.push({at: frame.at - start, values: [...frame.values]});
  const last = boundary(end);
  if (last) output.push(last);
  return output;
}

function sliceCaptions(captions, start, end) {
  if (!Array.isArray(captions)) return [];
  const output = [];
  for (const caption of captions.slice(-4096)) {
    const text = cleanText(caption?.text);
    if (text && finite(caption.at) && caption.at >= start && caption.at < end
        && !output.some(row => row.at === caption.at - start && row.text === text)) {
      output.push({at: caption.at - start, text});
    }
  }
  return output.sort((a, b) => a.at - b.at);
}

export class PcmChunkStream {
  constructor({sampleRate, emit, firstSeconds = 1, chunkSeconds = 1, maxBufferedSeconds = 12,
    emitTimeoutMs = 15000, now = () => performance.now()}) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000 || typeof emit !== 'function'
        || !finite(firstSeconds) || firstSeconds < .25 || firstSeconds > 4
        || !finite(chunkSeconds) || chunkSeconds < 1 || chunkSeconds > 4
        || !finite(maxBufferedSeconds) || maxBufferedSeconds < chunkSeconds * 2 || maxBufferedSeconds > 30
        || !finite(emitTimeoutMs) || emitTimeoutMs < 1 || emitTimeoutMs > 45000) throw Error('Invalid audio stream configuration');
    Object.assign(this, {sampleRate, emit, emitTimeoutMs, now});
    this.firstSamples = Math.round(firstSeconds * sampleRate);
    this.chunkSamples = Math.round(chunkSeconds * sampleRate);
    this.minimumTail = Math.ceil(.05 * sampleRate);
    this.maximumBuffered = Math.round(maxBufferedSeconds * sampleRate);
    this.parts = []; this.headOffset = 0; this.buffered = 0; this.inFlight = 0;
    this.receivedSamples = 0; this.sentSamples = 0; this.count = 0; this.metadata = {};
    this.audioEncodeMs = 0; this.sinkWaitMs = 0;
    this.started = now(); this.finalRequested = false; this.finished = false;
    this.interrupted = new Promise((_, reject) => { this.rejectInterruption = reject; });
    this.interrupted.catch(() => {});
  }
  assertActive() { if (this.error) throw this.error; }
  abort(reason = cancelled()) {
    if (!this.error) { this.error = reason instanceof Error ? reason : Error(String(reason)); this.rejectInterruption(this.error); }
    this.parts = []; this.buffered = 0;
  }
  push(pcm) {
    this.assertActive();
    if (this.finalRequested || this.finished) throw Error('Audio arrived after capture completed');
    if (!(pcm instanceof Float32Array) || !pcm.length || pcm.length > this.sampleRate * 4 || !pcm.every(finite)) {
      throw Error('Invalid captured audio packet');
    }
    if (this.receivedSamples + pcm.length > this.sampleRate * MAX_DURATION) {
      this.abort(Error('Voice exceeded two minutes')); this.assertActive();
    }
    if (this.buffered + this.inFlight + pcm.length > this.maximumBuffered) {
      // Remote WebRTC cannot be backpressured by local pause. Stop explicitly
      // instead of retaining unbounded PCM or silently dropping words.
      this.abort(Error('Native playback fell behind the realtime audio buffer')); this.assertActive();
    }
    this.parts.push(pcm); this.buffered += pcm.length; this.receivedSamples += pcm.length;
  }
  update(metadata = {}) {
    this.metadata = {...metadata, text: cleanText(metadata.text)};
  }
  take(length) {
    const out = new Float32Array(length);
    for (let written = 0; written < length;) {
      const part = this.parts[0], count = Math.min(length - written, part.length - this.headOffset);
      out.set(part.subarray(this.headOffset, this.headOffset + count), written);
      written += count; this.headOffset += count;
      if (this.headOffset === part.length) { this.parts.shift(); this.headOffset = 0; }
    }
    this.buffered -= length;
    return out;
  }
  cutNearZero(target) {
    // Native files may have a short scheduling gap. Prefer a real source
    // zero crossing in the last 12 ms, reducing a cut's discontinuity without
    // changing/fading samples or adding synthetic silence. Never cut later:
    // the >=50 ms reserved tail must still be a valid final WAV.
    const first = Math.max(this.minimumTail, target - Math.floor(.012 * this.sampleRate));
    const sampleAt = index => {
      let at = index + this.headOffset;
      for (const part of this.parts) { if (at < part.length) return part[at]; at -= part.length; }
      return undefined;
    };
    let best = target, score = Infinity;
    for (let cut = target; cut >= first; cut--) {
      const left = sampleAt(cut - 1), right = sampleAt(cut);
      if (left === undefined || right === undefined || left * right > 0) continue;
      const level = Math.abs(left) + Math.abs(right);
      if (level < score) { score = level; best = cut; }
    }
    return best;
  }
  pump() {
    if (this.pumping) return this.pumping;
    const task = this.flush();
    this.pumping = task.finally(() => { this.pumping = null; });
    // Polling calls need not await the sink; finish() still observes failure.
    this.pumping.catch(() => {});
    return this.pumping;
  }
  async flush() {
    try {
      for (;;) {
        this.assertActive();
        const target = this.count ? this.chunkSamples : this.firstSamples;
        if (!this.metadata.text || (!this.finalRequested && this.buffered < target + this.minimumTail)
            || !this.buffered) return;
        if (this.count >= MAX_CHUNKS) throw Error('Speech exceeded the chunk limit');
        // Keep >=50 ms behind until finalization so a tiny last packet never
        // becomes an invalid WAV. The samples themselves remain untouched.
        const size = this.finalRequested && this.buffered < target + this.minimumTail ? this.buffered : this.cutNearZero(target);
        if (size < this.minimumTail) throw Error('Captured speech is shorter than the native audio minimum');
        const startSeconds = this.sentSamples / this.sampleRate, duration = size / this.sampleRate;
        const speechSegment = {version: 1, index: this.count + 1, startSeconds,
          first: this.count === 0, last: this.finalRequested && size === this.buffered};
        const metadata = this.metadata, pcm = this.take(size);
        this.inFlight = size;
        const encodingAt = this.now(), audio = encodePcmWav(pcm, this.sampleRate);
        const audioEncodeMs = this.now() - encodingAt, chunkReadyMs = this.now() - this.started;
        this.audioEncodeMs += audioEncodeMs;
        this.firstChunkMs ??= chunkReadyMs;
        const chunk = {version: 1, index: this.count + 1, startSeconds, duration, audio, speechSegment,
          text: metadata.text, textComplete: metadata.textComplete === true, sessionID: metadata.sessionID,
          faces: sliceFaces(metadata.faces, startSeconds, startSeconds + duration),
          facesFormat: 'arkit61', facesTimebase: 'audio-seconds',
          captions: sliceCaptions(metadata.captions, startSeconds, startSeconds + duration),
          timing: {...metadata.timing, audioEncodeMs, chunkReadyMs}};
        let timer;
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Native audio sink did not acknowledge a chunk')), this.emitTimeoutMs); });
        const waitingAt = this.now();
        try { await Promise.race([Promise.resolve().then(() => this.emit(chunk)), timeout, this.interrupted]); }
        finally { clearTimeout(timer); this.inFlight = 0; this.sinkWaitMs += this.now() - waitingAt; }
        this.assertActive();
        this.count++; this.sentSamples += size;
      }
    } catch (error) { this.abort(error); throw error; }
  }
  async finish(metadata) {
    this.assertActive();
    this.update(metadata); this.finalRequested = true;
    if (this.pumping) await this.pumping;
    await this.pump();
    this.assertActive();
    if (this.buffered || !this.count || !this.metadata.text) throw Error('Convai returned no complete audio dialogue');
    this.finished = true;
    return {chunks: this.count, duration: this.sentSamples / this.sampleRate,
      firstChunkMs: this.firstChunkMs, audioEncodeMs: this.audioEncodeMs, sinkWaitMs: this.sinkWaitMs};
  }
}

export function validateConvaiAudioChunk(chunk, {index, startSeconds} = {}) {
  if (!chunk || chunk.version !== 1 || !Number.isInteger(chunk.index) || chunk.index < 1 || chunk.index > MAX_CHUNKS
      || (index !== undefined && chunk.index !== index)
      || !finite(chunk.startSeconds) || chunk.startSeconds < 0 || chunk.startSeconds > MAX_DURATION
      || (startSeconds !== undefined && Math.abs(chunk.startSeconds - startSeconds) > .0001)
      || !finite(chunk.duration) || chunk.duration < .05 || chunk.duration > 4.05
      || chunk.startSeconds + chunk.duration > MAX_DURATION + .0001
      || typeof chunk.audio !== 'string' || chunk.audio.length > 1100000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(chunk.audio)
      || typeof chunk.text !== 'string' || !chunk.text.trim() || chunk.text.length > MAX_TEXT
      || typeof chunk.textComplete !== 'boolean') throw Error('Invalid realtime audio chunk');
  if (chunk.faces !== undefined && (!Array.isArray(chunk.faces) || chunk.faces.length > 500)) throw Error('Invalid realtime face slice');
  if (chunk.captions !== undefined && (!Array.isArray(chunk.captions) || chunk.captions.length > 512)) throw Error('Invalid realtime caption slice');
  if (chunk.speechSegment !== undefined && (!chunk.speechSegment || chunk.speechSegment.version !== 1
      || chunk.speechSegment.index !== chunk.index || chunk.speechSegment.startSeconds !== chunk.startSeconds
      || chunk.speechSegment.first !== (chunk.index === 1) || typeof chunk.speechSegment.last !== 'boolean')) {
    throw Error('Invalid realtime speech segment boundary');
  }
  return chunk;
}

// Serial native publisher. Append is the awaited browser sink, so native
// acknowledgements also limit browser read-ahead. The final provider result
// finalizes this manifest; it must not publish another ordinary reply.json.
export class ConvaiAudioStream {
  constructor({input, streamId, slots, readState, writeManifest, current, signal, buildFace,
    now = Date.now, wait = ms => new Promise(done => setTimeout(done, ms))}) {
    if (!input || typeof input.requestId !== 'string' || typeof input.entity !== 'string'
        || typeof streamId !== 'string' || !streamId || streamId.length > 80) throw Error('Invalid native stream owner');
    Object.assign(this, {input, slots, readState, writeManifest, current, signal, buildFace, now, wait});
    this.manifest = {version: 2, streamId, requestId: input.requestId, generation: input.generation,
      entity: input.entity, total: null, complete: false, captionMode: 'utterance', text: '', bufferedDuration: 0, chunks: []};
    this.started = now(); this.totalDuration = 0; this.accepted = false; this.tail = Promise.resolve();
  }
  async assertCurrent() { if (this.signal?.aborted || !await this.current()) throw cancelled(); }
  async publish() { await this.assertCurrent(); await this.writeManifest({...this.manifest, updated: this.now()}); }
  append(chunk) {
    const task = this.tail.then(() => this.appendChunk(chunk));
    this.tail = task.catch(() => {});
    return task;
  }
  async appendChunk(chunk) {
    await this.assertCurrent();
    if (this.manifest.complete) throw Error('Speech stream is already complete');
    const index = this.manifest.chunks.length + 1;
    validateConvaiAudioChunk(chunk, {index, startSeconds: this.totalDuration});
    if (index === 1) await this.slots.begin(this.manifest.streamId, this.current);
    else await this.room();
    await this.assertCurrent();
    const audio = await this.slots.write(this.manifest.streamId, index, chunk.audio, this.current);
    if (!finite(audio.duration) || Math.abs(audio.duration - chunk.duration) > .0001) throw Error('Captured WAV duration disagrees with its stream timeline');
    let face;
    try { face = this.buildFace?.(chunk, this.input); } catch { /* Missing faces never block unchanged voice audio. */ }
    const row = {index, startSeconds: chunk.startSeconds, text: chunk.text, audio, face, captions: chunk.captions,
      timing: chunk.timing, readyAt: this.now()};
    this.totalDuration += audio.duration;
    this.manifest.bufferedDuration = this.totalDuration;
    this.manifest.text = chunk.text;
    this.manifest.textComplete = chunk.textComplete;
    this.manifest.chunks.push(row);
    await this.publish();
    return row;
  }
  async room() {
    let waitingSince = this.now();
    for (;;) {
      await this.assertCurrent();
      const state = await this.readState(), matching = state.streamId === this.manifest.streamId;
      const fresh = finite(state.updated) && this.now() - state.updated >= 0 && this.now() - state.updated < 7000;
      if (matching && fresh) {
        this.accepted = true;
        if (state.requestId !== this.input.requestId || !['starting', 'playing', 'buffering'].includes(state.state)) throw cancelled('Speech playback ended');
        if (!Number.isInteger(state.completedChunk) || state.completedChunk < 0 || state.completedChunk > this.manifest.chunks.length) throw Error('Invalid speech acknowledgement');
        if (this.manifest.chunks.length - state.completedChunk < 3) return;
        if (state.paused) waitingSince = this.now();
      } else if (this.accepted && (!fresh || !matching)) throw cancelled('Speech consumer disappeared');
      else if (!this.accepted && this.manifest.chunks.length < 2) return;
      if (this.now() - waitingSince > 45000) throw Error('Speech consumer did not advance');
      await this.wait(75);
    }
  }
  descriptor() {
    if (!this.manifest.chunks.length) throw Error('Speech has not started');
    return {version: 2, id: this.manifest.streamId, total: null, captionMode: 'utterance',
      firstText: this.manifest.chunks[0].text, textComplete: this.manifest.textComplete, bufferedDuration: this.totalDuration};
  }
  async finish(result) {
    await this.tail; await this.assertCurrent();
    if (this.manifest.complete) return;
    if (result?.streamed !== true || result.stream?.chunks !== this.manifest.chunks.length || !this.manifest.chunks.length
        || !finite(result.stream.duration) || Math.abs(result.stream.duration - this.totalDuration) > .0001
        || typeof result.text !== 'string' || !result.text.trim() || result.text.length > MAX_TEXT) throw Error('Incomplete realtime audio stream');
    this.manifest.text = result.text;
    this.manifest.textComplete = true;
    this.manifest.total = this.manifest.chunks.length;
    this.manifest.complete = true;
    await this.publish();
  }
  async fail(error) {
    await this.tail;
    if (!this.manifest.chunks.length || this.manifest.complete || error?.name === 'AbortError'
        || this.signal?.aborted || !await this.current()) return;
    this.error = error?.message || 'Realtime audio failed';
    this.manifest.total = this.manifest.chunks.length;
    this.manifest.complete = true;
    this.manifest.error = 'The rest of the voice reply could not be received.';
    await this.publish();
  }
}
