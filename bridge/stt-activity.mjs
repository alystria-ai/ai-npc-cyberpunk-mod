// Speech activity of the open recording, for the local recogniser's early decode and the stable-partial start
// (docs/LATENCY_2026-10-14.md section 1, option B).
//
// The same judgement the recogniser worker makes (bridge/local-stt-worker.py: 30 ms frames, a recording holds speech when 150 ms of
// frames rise 9 dB above its own 10th-percentile noise floor, never below -52 dBFS), kept in the bridge so that the bridge knows, without
// asking the worker, WHEN the player stopped talking and how much speech arrived after the newest live-words decode. It runs on the
// 100 ms chunks the capture page already sends (a few thousand multiply-adds per chunk, in the bridge process, never the game's), and
// holds one dB value per frame (about 1,500 numbers for the longest recording).
export const ACTIVITY = Object.freeze({
  sampleRate: 16000,
  frameSamples: 480,    // 30 ms, the worker's frame
  gateDb: -52,          // a frame below this is never speech
  marginDb: 9,          // a frame this far above the noise floor is speech
  speechFrames: 5,      // 150 ms of speech frames make the recording one that holds speech
});

const FRAME_MS = ACTIVITY.frameSamples * 1000 / ACTIVITY.sampleRate;

export class SpeechActivity {
  constructor() {
    this.levels = [];             // dBFS of every complete 30 ms frame
    this.rest = Buffer.alloc(0);  // bytes of the frame still being filled
    this.samples = 0;             // samples taken in (whole frames plus the rest)
    this.gateCache = null;
  }

  /** Takes Int16 little-endian 16 kHz mono samples (a Buffer, or anything with a byte view). */
  push(chunk) {
    let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (this.rest.length) bytes = Buffer.concat([this.rest, bytes]);
    const frameBytes = ACTIVITY.frameSamples * 2, whole = bytes.length - bytes.length % frameBytes;
    for (let at = 0; at < whole; at += frameBytes) {
      let sum = 0;
      for (let i = at; i < at + frameBytes; i += 2) { const value = bytes.readInt16LE(i) / 32768; sum += value * value; }
      this.levels.push(20 * Math.log10(Math.sqrt(sum / ACTIVITY.frameSamples + 1e-12)));
    }
    this.samples += (bytes.length - this.rest.length) >> 1;
    this.rest = Buffer.from(bytes.subarray(whole));
    if (whole) this.gateCache = null;
  }

  /** The speech gate of the recording so far (dBFS): its 10th-percentile level plus the margin, never below the floor. */
  get gate() {
    if (this.gateCache === null) {
      if (!this.levels.length) return ACTIVITY.gateDb;
      const sorted = [...this.levels].sort((a, b) => a - b);
      this.gateCache = Math.max(ACTIVITY.gateDb, sorted[Math.floor(0.1 * (sorted.length - 1))] + ACTIVITY.marginDb);
    }
    return this.gateCache;
  }

  get frames() { return this.levels.length; }

  /** Frames above the gate from frame `from` on. */
  speechFramesFrom(from = 0) {
    const gate = this.gate;
    let count = 0;
    for (let i = Math.max(0, from); i < this.levels.length; i++) if (this.levels[i] > gate) count++;
    return count;
  }

  /** True once the recording holds speech (what the worker's `has_speech` says for it). */
  get heardSpeech() { return this.speechFramesFrom(0) >= ACTIVITY.speechFrames; }

  /** Index of the last frame above the gate, or -1. Meaningful once `heardSpeech`. */
  get lastSpeechFrame() {
    const gate = this.gate;
    for (let i = this.levels.length - 1; i >= 0; i--) if (this.levels[i] > gate) return i;
    return -1;
  }

  /** Index of the first frame above the gate, or -1. */
  get firstSpeechFrame() {
    const gate = this.gate;
    for (let i = 0; i < this.levels.length; i++) if (this.levels[i] > gate) return i;
    return -1;
  }

  /** The byte offset where the first speech frame starts; 0 when nothing was heard. */
  get speechStartBytes() {
    const first = this.firstSpeechFrame;
    return first < 0 ? 0 : first * ACTIVITY.frameSamples * 2;
  }

  /** How long (ms) it has been quiet since the last speech frame; 0 while speech is going on or when nothing was heard. */
  get quietMs() {
    if (!this.heardSpeech) return 0;
    return (this.levels.length - 1 - this.lastSpeechFrame) * FRAME_MS;
  }

  /** The byte offset (Int16 samples * 2) just after the last speech frame; 0 when nothing was heard. */
  get speechEndBytes() {
    if (!this.heardSpeech) return 0;
    return (this.lastSpeechFrame + 1) * ACTIVITY.frameSamples * 2;
  }

  /** Milliseconds of speech frames in the audio after byte offset `bytes` (what a decode that covered `bytes` has not seen). */
  speechMsAfter(bytes) {
    return this.speechFramesFrom(Math.floor(bytes / 2 / ACTIVITY.frameSamples)) * FRAME_MS;
  }
}
