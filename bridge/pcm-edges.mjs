// Breathing room at both ends of a short synthesized line.
//
// Pocket (and the cloud voices behind the same packet shape) stop a line one frame after the model's end-of-speech and start it at
// the first voiced sample, and the renderer plays exactly the samples it is given, so a line starts and stops "tight": the ear
// hears the cut. The fix costs nothing to synthesize: silence and a short fade are added around the line on its way to the renderer.
//   - lead-in: `leadMs` of silence in front of the first sample, merged into the first packet (no packet waits for it) and
//     followed by a `fadeInMs` raised-cosine rise over the line's first samples;
//   - tail: only the last `fadeOutMs` of the line are held back (never a whole packet, so nothing is delayed while the line is
//     being produced), faded to zero, followed by `tailMs` of silence. The line is "ended" only after that silence has played.
// Packets keep the shape of the engine's own (owner, id, profile, modelSha256, f32le mono 24 kHz), renumbered and with the frame
// offsets of the padded line, at most `maxPacketFrames` frames each. Pure data in, pure data out: no timers, no clocks, no I/O.

export const EDGE_DEFAULTS = Object.freeze({sampleRate: 24000, leadMs: 160, tailMs: 320, fadeInMs: 15, fadeOutMs: 40,
  maxPacketFrames: 48000});

const frames = (ms, sampleRate) => Math.max(0, Math.round(ms * sampleRate / 1000));

/** The gain of a raised-cosine fade: 0 at its first sample, 1 at its end (`at` of `length` samples in). */
export const fadeGain = (at, length) => length <= 0 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, (at + 0.5) / length)));

export class PcmEdges {
  /**
   * emit  async packet => ack: the renderer-bound consumer (called in order, never concurrently by this class)
   * options  EDGE_DEFAULTS, overridable
   */
  constructor(emit, options = {}) {
    const {sampleRate, leadMs, tailMs, fadeInMs, fadeOutMs, maxPacketFrames} = {...EDGE_DEFAULTS, ...options};
    this.emit = emit;
    this.leadFrames = frames(leadMs, sampleRate);
    this.tailFrames = frames(tailMs, sampleRate);
    this.fadeInFrames = frames(fadeInMs, sampleRate);
    this.fadeOutFrames = frames(fadeOutMs, sampleRate);
    this.maxPacketFrames = maxPacketFrames;
    this.template = null;
    this.held = new Float32Array(0);   // the last fadeOutFrames of the line so far (not yet emitted)
    this.voiced = 0;                   // line samples seen (for the fade-in)
    this.sent = 0;                     // frames emitted
    this.index = 0;
    this.finished = false;
  }

  /** One engine packet. Emits everything except the held end of the line (so the first sound is never later than without this). */
  async push(packet) {
    if (this.finished) throw Error('The padded line is already finished');
    const source = packet.pcm;
    if (!(source instanceof Float32Array) || !source.length) return undefined;
    let head = 0;
    if (!this.template) {
      this.template = {owner: packet.owner, id: packet.id, profile: packet.profile, modelSha256: packet.modelSha256};
      head = this.leadFrames;
    }
    const joined = new Float32Array(head + this.held.length + source.length);
    joined.set(this.held, head);
    // Fade-in over the line's first samples (the held samples were already counted).
    const base = head + this.held.length;
    for (let at = 0; at < source.length; at++) {
      const line = this.voiced + at;
      joined[base + at] = line < this.fadeInFrames ? source[at] * fadeGain(line, this.fadeInFrames) : source[at];
    }
    this.voiced += source.length;
    const keep = Math.min(this.fadeOutFrames, joined.length);
    this.held = joined.slice(joined.length - keep);
    return this.write(joined.subarray(0, joined.length - keep));
  }

  /** The engine finished: fades the held end of the line to zero, adds the silent tail and emits the rest. Safe to call once. */
  async finish() {
    if (this.finished || !this.template) { this.finished = true; return undefined; }
    this.finished = true;
    const last = new Float32Array(this.held.length + this.tailFrames);
    for (let at = 0; at < this.held.length; at++) {
      // Never raise the gain above the fade-in's own (a line shorter than the fade is already quiet at its start).
      last[at] = this.held[at] * (1 - fadeGain(at, this.fadeOutFrames));
    }
    this.held = new Float32Array(0);
    return this.write(last);
  }

  async write(pcm) {
    let ack;
    for (let offset = 0; offset < pcm.length; offset += this.maxPacketFrames) {
      const part = pcm.slice(offset, offset + this.maxPacketFrames);
      this.index++;
      ack = await this.emit({version: 1, engine: 'pocket-tts', ...this.template, sampleRate: 24000, channels: 1, format: 'f32le',
        index: this.index, offsetFrames: this.sent, frames: part.length, pcm: part});
      this.sent += part.length;
    }
    return ack;
  }
}
