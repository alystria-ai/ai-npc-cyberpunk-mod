// Voice activity detector for the "Voice activation" setting: tells the bridge WHEN the player starts and stops speaking in the
// live 16 kHz microphone stream, so a conversation turn can begin and end without a key.
//
// Same judgement as the finished-recording gate in bridge/stt-activity.mjs (30 ms frames, dBFS per frame, a noise floor, a hard
// floor, a margin above the floor), plus the recogniser worker's "voiced" test (a 70-400 Hz pitch repeating inside the frame: vowels
// have it, fans, hiss and key clicks do not), and the streaming parts a live mic needs: an onset window, a hangover for unvoiced
// consonants, an end-of-speech silence, and a noise floor that keeps learning while nobody talks.
//
// Cost: one sum of squares per sample, and for the frames that pass the level gate one autocorrelation on the half-rate frame
// (about 95 lags * 200 samples = 19 thousand multiply-adds per 30 ms frame, well under one million per second). Runs in the bridge
// process, never the game's. No timers, no I/O, no allocation per chunk (two typed arrays and a ring are made once).
export const VAD = Object.freeze({
  sampleRate: 16000,
  frameSamples: 480,      // 30 ms
  gateFloorDb: -50,       // a frame below this is never speech
  marginDb: 12,           // a frame this far above the noise floor can be speech
  onsetFrames: 8,         // voiced speech frames needed ...
  onsetWindow: 12,        // ... among the last this many frames (about 240 ms of voice) to start
  hangoverMs: 300,        // after a voiced frame, louder-than-gate unvoiced frames ('s', 'f', 't') still count as speech
  endSilenceMs: 900,      // this long without a speech frame ends the utterance
  prerollMs: 300,         // not used here: what the caller keeps before onsetMs
  voicedThreshold: 0.30,  // normalised autocorrelation peak (lags 40..228 samples) of a voiced frame
});

const START_FLOOR_DB = -60;     // the noise floor before anything was heard
const MIN_FLOOR_DB = -80;
const MAX_FLOOR_DB = -35;
const FLOOR_RISE_DB_PER_SEC = 1; // a fan that starts up is learned in seconds, one syllable never lifts it
const FLOOR_FALL_RATE = 0.3;     // share of the way down to a quieter frame taken per frame
const MIN_PITCH_HZ = 70;
const MAX_PITCH_HZ = 400;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export class VoiceActivity {
  constructor(options = {}) {
    const merged = { ...VAD };
    for (const key of Object.keys(VAD)) {
      if (options[key] !== undefined && Number.isFinite(Number(options[key]))) merged[key] = Number(options[key]);
    }
    this.o = Object.freeze(merged);
    const o = this.o;
    this.frameMs = o.frameSamples * 1000 / o.sampleRate;
    this.endFrames = Math.max(1, Math.ceil(o.endSilenceMs / this.frameMs - 1e-9));
    this.window = Math.max(1, Math.round(o.onsetWindow));
    this.half = o.frameSamples >> 1;                                    // frame length after taking pairs of samples
    this.minLag = Math.max(1, Math.round(o.sampleRate / MAX_PITCH_HZ / 2));   // 20 at 16 kHz (40 samples at full rate)
    this.maxLag = Math.min(this.half - 8, Math.floor(o.sampleRate / MIN_PITCH_HZ / 2)); // 114 (228 samples)
    this.frame = new Int16Array(o.frameSamples);
    this.dec = new Float64Array(this.half);
    this.cum = new Float64Array(this.half + 1);
    this.ring = new Int32Array(this.window);
    this.reset({ floor: true });
  }

  /** Back to idle. The noise floor is kept unless `reset({ floor: true })`. */
  reset({ floor = false } = {}) {
    this.fill = 0;            // samples in the frame being filled
    this.leftover = -1;       // the low byte of a sample whose high byte has not arrived, or -1
    this.samples = 0;         // samples seen since reset
    this.frameIndex = 0;      // complete frames since reset
    this.mode = 'idle';
    this.ring.fill(-1);       // frame index of each voiced frame in the onset window, -1 for none
    this.ringCount = 0;
    this.lastVoiced = -1e9;   // frame index of the newest voiced frame
    this.lastSpeech = -1e9;   // frame index of the newest speech frame
    this.speechFrames = 0;    // speech frames of the running utterance
    if (floor || this.floorDb === undefined) this.floorDb = START_FLOOR_DB;
  }

  get state() { return this.mode; }
  get noiseFloorDb() { return this.floorDb; }
  get streamMs() { return this.samples * 1000 / this.o.sampleRate; }

  /** Takes Int16 little-endian 16 kHz mono samples (Buffer, Uint8Array or Int16Array, any length). Returns the events it caused. */
  push(chunk) {
    const events = [];
    if (!chunk || !chunk.byteLength) return events;
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const frame = this.frame, size = this.o.frameSamples;
    let i = 0;
    const n = bytes.length;
    if (this.leftover >= 0) {
      const value = (bytes[0] << 8) | this.leftover;
      frame[this.fill++] = value << 16 >> 16;
      this.samples++;
      this.leftover = -1;
      i = 1;
      if (this.fill === size) { this.fill = 0; this._frame(events); }
    }
    for (; i + 1 < n; i += 2) {
      frame[this.fill++] = ((bytes[i + 1] << 8) | bytes[i]) << 16 >> 16;
      this.samples++;
      if (this.fill === size) { this.fill = 0; this._frame(events); }
    }
    if (i < n) this.leftover = bytes[i];
    return events;
  }

  // One complete 30 ms frame.
  _frame(events) {
    const o = this.o, frame = this.frame, size = o.frameSamples, idx = this.frameIndex++;
    let sum = 0;
    for (let k = 0; k < size; k++) { const v = frame[k]; sum += v * v; }
    const level = 10 * Math.log10(sum / size / 1073741824 + 1e-12);   // dBFS of the frame's rms (32768 squared = 2^30)
    const gate = Math.max(o.gateFloorDb, this.floorDb + o.marginDb);
    const above = level > gate;
    const voiced = above && this._voiced();
    if (voiced) this.lastVoiced = idx;
    const speech = above && (voiced || (idx - this.lastVoiced) * this.frameMs <= o.hangoverMs);
    if (speech) this.lastSpeech = idx;

    // The onset window: which of the last frames were voiced speech frames.
    const slot = idx % this.window;
    if (this.ring[slot] >= 0) this.ringCount--;
    this.ring[slot] = voiced ? idx : -1;
    if (voiced) this.ringCount++;

    if (this.mode === 'idle') {
      if (!speech && this.ringCount === 0) this._learnFloor(level);
      if (this.ringCount >= o.onsetFrames) {
        let first = idx;
        for (let k = 0; k < this.window; k++) if (this.ring[k] >= 0 && this.ring[k] < first) first = this.ring[k];
        this.mode = 'speech';
        this.speechFrames = this.ringCount;
        events.push({ type: 'start', onsetMs: first * this.frameMs, detectedMs: (idx + 1) * this.frameMs });
      }
    } else if (speech) {
      this.speechFrames++;
    } else if (idx - this.lastSpeech >= this.endFrames) {
      events.push({
        type: 'end',
        endMs: (this.lastSpeech + 1) * this.frameMs,
        speechMs: this.speechFrames * this.frameMs,
        silenceMs: (idx - this.lastSpeech) * this.frameMs,
      });
      this.mode = 'idle';
      this.ring.fill(-1);
      this.ringCount = 0;
      this.speechFrames = 0;
    }
  }

  // Follows the room level down quickly and up slowly.
  _learnFloor(level) {
    let floor = this.floorDb;
    if (level < floor) floor += (level - floor) * FLOOR_FALL_RATE;
    else floor = Math.min(level, floor + FLOOR_RISE_DB_PER_SEC * this.frameMs / 1000);
    this.floorDb = clamp(floor, MIN_FLOOR_DB, MAX_FLOOR_DB);
  }

  // Voiced: the frame repeats itself at some lag of 70-400 Hz (normalised autocorrelation peak at or above the threshold).
  _voiced() {
    const frame = this.frame, d = this.dec, cum = this.cum, n = this.half, threshold = this.o.voicedThreshold;
    let mean = 0;
    for (let k = 0; k < n; k++) { const v = frame[2 * k] + frame[2 * k + 1]; d[k] = v; mean += v; }
    mean /= n;
    let acc = 0;
    cum[0] = 0;
    for (let k = 0; k < n; k++) { const v = d[k] - mean; d[k] = v; acc += v * v; cum[k + 1] = acc; }
    if (acc <= 0) return false;
    for (let lag = this.minLag; lag <= this.maxLag; lag++) {
      const len = n - lag;
      let num = 0;
      for (let k = 0; k < len; k++) num += d[k] * d[k + lag];
      if (num <= 0) continue;
      const denom = Math.sqrt(cum[len] * (acc - cum[lag]));
      if (denom > 0 && num / denom >= threshold) return true;
    }
    return false;
  }
}

/** One readable line of the numbers in force, for logs and docs. */
export function describeThresholds(options = {}) {
  const o = { ...VAD };
  for (const key of Object.keys(VAD)) if (options[key] !== undefined && Number.isFinite(Number(options[key]))) o[key] = Number(options[key]);
  const frameMs = o.frameSamples * 1000 / o.sampleRate;
  return `voice activity: ${frameMs} ms frames, speech above max(${o.gateFloorDb} dBFS, noise floor + ${o.marginDb} dB) and voiced ` +
    `(pitch correlation >= ${o.voicedThreshold}, or within ${o.hangoverMs} ms of a voiced frame), start when ${o.onsetFrames} of the last ` +
    `${o.onsetWindow} frames are voiced, end after ${o.endSilenceMs} ms without speech, keep ${o.prerollMs} ms before the start, ` +
    `noise floor from ${START_FLOOR_DB} dBFS (clamped ${MIN_FLOOR_DB}..${MAX_FLOOR_DB}, rises at most ${FLOOR_RISE_DB_PER_SEC} dB/s)`;
}
