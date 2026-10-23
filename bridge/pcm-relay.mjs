// Turns pushed microphone samples (16 kHz mono Int16, the bridge's capture page) into a live MediaStream track, so the Convai voice
// page can publish a microphone the bridge opened at the key press instead of opening the device itself. Audio pushed before the
// connection is ready waits in the worklet's FIFO and plays out in order as soon as the track is published (the pre-roll).
// Browser-safe ESM: no Node APIs. Tests may pass stubs for AudioContext / AudioWorkletNode.

export const RELAY_SAMPLE_RATE = 16000;
// Silence kept flowing after the last sample so the encoder flushes the player's final syllable before the track is disabled.
export const RELAY_TAIL_MS = 120;

const PROCESSOR_NAME = 'pcm-relay';
// One FIFO of Int16 chunks, played in order once the relay is started (until then it only collects: the track is not published yet and nobody
// would hear what plays), silence when empty. Reports the cumulative consumed sample count every 8 render
// quanta while audio plays, and at once when the FIFO runs dry. Nothing is posted or allocated while idle.
export const WORKLET_SOURCE = `
class PcmRelayProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = []; this.head = 0; this.offset = 0; this.consumed = 0; this.reported = 0; this.quanta = 0; this.playing = false;
    this.port.onmessage = event => {
      const data = event.data;
      if (data === 'play') this.playing = true;
      else if (data && data.length) this.queue.push(data);
    };
  }
  process(inputs, outputs) {
    const output = outputs[0], out = output && output[0];
    if (!out) return true;
    const frames = out.length;
    let written = 0;
    while (this.playing && written < frames && this.head < this.queue.length) {
      const chunk = this.queue[this.head];
      let at = this.offset;
      const take = Math.min(frames - written, chunk.length - at);
      for (let i = 0; i < take; i++) out[written + i] = chunk[at + i] / 32768;
      written += take; at += take; this.consumed += take;
      if (at >= chunk.length) { this.queue[this.head++] = null; at = 0; }
      this.offset = at;
    }
    if (written < frames) out.fill(0, written);
    for (let c = 1; c < output.length; c++) output[c].set(out);
    const dry = this.playing && this.head >= this.queue.length;
    if (dry && this.head) { this.queue.length = 0; this.head = 0; }
    if (this.consumed !== this.reported && (dry || ++this.quanta >= 8)) {
      this.reported = this.consumed; this.quanta = 0;
      this.port.postMessage({consumed: this.consumed, empty: dry});
    }
    return true;
  }
}
registerProcessor('${PROCESSOR_NAME}', PcmRelayProcessor);
`;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function decodeBase64(text) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text);
  const binary = atob(text), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class PcmRelay {
  // `classes` lets a test supply stubs: {AudioContext, AudioWorkletNode, Blob, URL}.
  constructor(classes = {}) {
    this.classes = classes;
    this.context = null; this.node = null; this.destination = null; this._stream = null;
    this.pushed = 0; this.consumed = 0; this.lastPlayedAt = -Infinity; this.started = false;
    this.pending = []; this.ready = false; this.closed = false; this.opening = null;
    this.waiters = new Set();
  }

  // The one live audio track of the relay (null until open() resolved).
  get stream() { return this._stream; }
  get backlogMs() { return Math.max(0, this.pushed - this.consumed) * 1000 / RELAY_SAMPLE_RATE; }

  open() { return this.opening ??= this._open(); }

  async _open() {
    const Context = this.classes.AudioContext ?? globalThis.AudioContext;
    const NodeClass = this.classes.AudioWorkletNode ?? globalThis.AudioWorkletNode;
    const BlobClass = this.classes.Blob ?? globalThis.Blob, UrlClass = this.classes.URL ?? globalThis.URL;
    if (typeof Context !== 'function' || typeof NodeClass !== 'function') throw Error('Web Audio worklets are not available');
    if (this.closed) throw Error('PCM relay closed');
    const context = this.context = new Context({sampleRate: RELAY_SAMPLE_RATE, latencyHint: 'interactive'});
    try {
      const url = UrlClass.createObjectURL(new BlobClass([WORKLET_SOURCE], {type: 'text/javascript'}));
      try { await context.audioWorklet.addModule(url); } finally { UrlClass.revokeObjectURL(url); }
      if (this.closed) throw Error('PCM relay closed');
      const node = this.node = new NodeClass(context, PROCESSOR_NAME, {numberOfInputs: 0, numberOfOutputs: 1,
        outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit'});
      node.port.onmessage = event => this._report(event.data);
      const destination = this.destination = context.createMediaStreamDestination();
      destination.channelCount = 1;
      node.connect(destination);
      this._stream = destination.stream;
      if (context.state !== 'running') await context.resume();
      if (this.closed) throw Error('PCM relay closed');
      this.ready = true;
      for (const [samples, transfer] of this.pending.splice(0)) {
        if (samples === 'play') this.node.port.postMessage('play'); else this._send(samples, transfer);
      }
    } catch (error) { this.close(); throw error; }
    return this;
  }

  _report(data) {
    if (!data || typeof data.consumed !== 'number') return;
    if (data.consumed > this.consumed) { this.consumed = data.consumed; this.lastPlayedAt = now(); }
    if (data.empty) this._wake();
  }

  // The track is published: what was pushed so far (the pre-roll) and everything after it now plays out, in order, at the real-time rate.
  // Before this call nothing is consumed, so audio pushed while the connection opened is not played into a track nobody receives.
  start() {
    if (this.closed || this.started) return;
    this.started = true; this.startedAt = now();
    if (this.ready) this.node.port.postMessage('play'); else this.pending.push(['play']);
  }

  _send(samples, transfer) {
    // Transferring moves the buffer into the audio thread without copying; the caller's view is then detached.
    this.node.port.postMessage(samples, transfer ? [samples.buffer] : []);
  }

  // Queues an Int16Array (16 kHz mono, little-endian host order). Copied unless {transfer: true} (then the caller's array is detached).
  // Returns false once closed (the samples are dropped).
  push(int16, {transfer = false} = {}) {
    if (this.closed) return false;
    let samples = int16;
    if (!(samples instanceof Int16Array)) {
      if (samples instanceof ArrayBuffer) samples = new Int16Array(samples, 0, samples.byteLength >> 1);
      else if (ArrayBuffer.isView(samples)) samples = new Int16Array(samples.buffer, samples.byteOffset, samples.byteLength >> 1);
      else return false;
      transfer = false;
    }
    if (!samples.length) return true;
    if (transfer && (samples.byteOffset !== 0 || samples.buffer.byteLength !== samples.byteLength)) transfer = false;
    if (!transfer) samples = samples.slice();
    this.pushed += samples.length;
    if (this.ready) this._send(samples, true); else this.pending.push([samples, true]);
    return true;
  }

  // Base64 of Int16 little-endian samples. The decoded buffer is ours, so it is handed over without another copy.
  pushBase64(text) {
    if (this.closed || typeof text !== 'string' || !text) return false;
    let bytes;
    try { bytes = decodeBase64(text); } catch { return false; }
    const length = bytes.length >> 1;
    if (!length) return false;
    const samples = bytes.byteOffset % 2 === 0 && bytes.buffer.byteLength === bytes.byteLength && !(bytes.length & 1)
      ? new Int16Array(bytes.buffer, 0, length) : new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + length * 2));
    return this.push(samples, {transfer: true});
  }

  _wake() { for (const check of [...this.waiters]) check(); }

  // Resolves {drained, waitedMs} once everything pushed has played out and RELAY_TAIL_MS of silence followed, or at the timeout.
  // Never rejects. After close() it resolves {drained: false} (nothing more can play).
  drain(timeoutMs) {
    const started = now();
    // The default fits what is queued (it plays in real time) plus a margin; a fixed 2 s cut a longer backlog off in the middle of the player's words.
    if (!(timeoutMs > 0)) timeoutMs = Math.max(3000, this.backlogMs + 2000);
    return new Promise(resolve => {
      let timer = null, done = false;
      const finish = drained => {
        if (done) return; done = true;
        clearTimeout(timer); this.waiters.delete(check);
        resolve({drained, waitedMs: Math.round(now() - started)});
      };
      const check = () => {
        if (done) return;
        if (this.closed) return finish(false);
        const elapsed = now() - started;
        if (elapsed >= timeoutMs) return finish(false);
        let wait = Math.min(timeoutMs - elapsed, 25);
        if (this.pushed <= this.consumed) {
          const tail = RELAY_TAIL_MS - (now() - this.lastPlayedAt);
          if (tail <= 0) return finish(true);
          wait = Math.min(wait, tail);
        }
        clearTimeout(timer); timer = setTimeout(check, Math.max(1, wait));
      };
      this.waiters.add(check);
      check();
    });
  }

  // Stops the track, disconnects and closes the context. Safe to call any number of times, at any point of open().
  close() {
    if (this.closed) return;
    this.closed = true; this.ready = false; this.pending.length = 0;
    try { for (const track of this._stream?.getTracks?.() ?? []) track.stop(); } catch {}
    try { if (this.node) this.node.port.onmessage = null; } catch {}
    try { this.node?.disconnect(); } catch {}
    try { this.destination?.disconnect(); } catch {}
    try { void Promise.resolve(this.context?.close()).catch(() => {}); } catch {}
    this._wake();
  }
}
