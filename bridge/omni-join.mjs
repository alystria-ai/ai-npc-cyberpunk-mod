// How the phrases of an OmniVoice reply are joined (bridge/omni-pcm.mjs shapes each rendered phrase with this before it is sent to the renderer).
//
// OmniVoice renders a phrase as a whole and pads it with silence of its own: measured on the CUDA model (postprocess off, as the worker runs it)
// 150 to 900 ms (often 450 to 650) before the first word and 130 to 300 ms after the last. Joined as they came, two phrases had 0.4 to 1.2 s of dead
// air between them, a different length every time, even where the cut fell at a comma, and the first word of a reply came half a second late. The
// phrases also differ in loudness by a few dB, and a phrase can end on the model's last frame with the voice still sounding (a click, a clipped word).
// So each phrase is:
//   - cropped to its speech: from `LEAD_KEEP_MS` before the first frame that is louder than -45 dB of the phrase's loudest, to `TAIL_KEEP_MS` after the
//     last such frame (`LAST_TAIL_KEEP_MS` after the reply's last phrase). Nothing audible is cut: the thresholds sit far below a quiet consonant, and the
//     kept margins hold the soft start of a breath and the decay of the last syllable;
//   - faded: 6 ms in where the crop began inside the model's padding, 30 ms out at the end (a raised cosine, so even a phrase that ends on the model's last
//     frame ends smoothly);
//   - set to the loudness of the reply's first phrase, within +-3 dB (the first phrase is left as rendered, it is already on its way to the speaker), never
//     past a peak of 0.98;
//   - and followed by a pause of the length a speaker makes: PAUSE_SENTENCE_MS (counted from the end of the sound to the start of the next) after a sentence,
//     PAUSE_CLAUSE_MS after a comma or dash, PAUSE_PLAIN_MS where the phrase was cut with no mark.
// Pure arithmetic on a few hundred thousand samples at most, no model, no I/O: well under a millisecond a second of audio.
export const JOIN_RATE = 24000;
export const LEAD_KEEP_MS = 30;
export const TAIL_KEEP_MS = 80;
export const LAST_TAIL_KEEP_MS = 120;
export const FADE_IN_MS = 6;
export const FADE_OUT_MS = 30;
export const PAUSE_SENTENCE_MS = 320;
export const PAUSE_CLAUSE_MS = 140;
export const PAUSE_PLAIN_MS = 110;
export const SPEECH_FLOOR_DB = -45;
export const MATCH_LIMIT_DB = 3;
const FRAME_MS = 10;
const ABSOLUTE_FLOOR = 0.0003;

const SENTENCE_END = /[.!?…。！？]["'”’)\]»]*$/u;
const CLAUSE_END = /[,;:，；：、—–-]["'”’)\]»]*$/u;
/** How a phrase's text ends: 'sentence', 'clause' or 'plain' (cut without a mark). */
export const phraseEnding = text => (SENTENCE_END.test(String(text ?? '').trim()) ? 'sentence' : CLAUSE_END.test(String(text ?? '').trim()) ? 'clause' : 'plain');

const samples = (ms, rate = JOIN_RATE) => Math.round(ms * rate / 1000);

/**
 * Where the speech of a phrase is: {start, end} in samples (end exclusive), the RMS `level` of its voiced frames and its `peak`; null when the phrase has no
 * frame above the floor (silence, or a few samples).
 */
export function measureSpeech(pcm, rate = JOIN_RATE) {
  const frame = Math.max(1, samples(FRAME_MS, rate)), count = Math.floor(pcm.length / frame);
  if (count < 1) return null;
  const energy = new Float64Array(count);
  let loudest = 0, peak = 0;
  for (let at = 0; at < count; at++) {
    let sum = 0;
    for (let n = at * frame, stop = n + frame; n < stop; n++) { const value = pcm[n]; sum += value * value; const magnitude = Math.abs(value); if (magnitude > peak) peak = magnitude; }
    energy[at] = sum / frame;
    if (energy[at] > loudest) loudest = energy[at];
  }
  const loud = Math.sqrt(loudest), threshold = Math.max(ABSOLUTE_FLOOR, loud * 10 ** (SPEECH_FLOOR_DB / 20)), voicedFrom = (loud * 10 ** (-30 / 20)) ** 2;
  let first = -1, last = -1, voiced = 0, voicedEnergy = 0;
  for (let at = 0; at < count; at++) {
    if (Math.sqrt(energy[at]) > threshold) { if (first < 0) first = at; last = at; }
    if (energy[at] > voicedFrom) { voiced++; voicedEnergy += energy[at]; }
  }
  if (first < 0 || voiced === 0) return null;
  return {start: first * frame, end: Math.min(pcm.length, (last + 1) * frame), level: Math.sqrt(voicedEnergy / voiced), peak};
}

/**
 * One reply's joiner. `shape(pcm, {text, first, last})` returns the phrase ready to send: the pause that follows the previous phrase, then the cropped, faded and
 * level-matched speech. Phrases must be given in order. A phrase that cannot be measured comes back unchanged (after its pause).
 */
export class PhraseJoiner {
  constructor({rate = JOIN_RATE} = {}) {
    this.rate = rate;
    this.reference = null;      // loudness of the first phrase
    this.previous = null;       // {ending, tail}: how the previous phrase ended and how much of its tail was kept (samples)
  }

  shape(pcm, {text = '', first = this.previous === null, last = false} = {}) {
    const rate = this.rate, ending = phraseEnding(text);
    const measured = measureSpeech(pcm, rate);
    let start = 0, end = pcm.length, lead = 0, tail = 0;
    if (measured) {
      lead = Math.min(measured.start, samples(LEAD_KEEP_MS, rate));
      start = measured.start - lead;
      tail = Math.min(pcm.length - measured.end, samples(last ? LAST_TAIL_KEEP_MS : TAIL_KEEP_MS, rate));
      end = measured.end + tail;
    }
    // The pause: counted from the end of the previous sound to the start of this one, less what the two crops already keep as silence.
    let pause = 0;
    if (this.previous && !first) {
      const wanted = this.previous.ending === 'sentence' ? PAUSE_SENTENCE_MS : this.previous.ending === 'clause' ? PAUSE_CLAUSE_MS : PAUSE_PLAIN_MS;
      pause = Math.max(0, samples(wanted, rate) - this.previous.tail - lead);
    }
    const body = end - start, out = new Float32Array(pause + body);
    out.set(pcm.subarray(start, end), pause);
    if (measured) {
      let gain = 1;
      if (this.reference === null) this.reference = measured.level;
      else if (!first) {
        const limit = 10 ** (MATCH_LIMIT_DB / 20);
        gain = Math.min(limit, Math.max(1 / limit, this.reference / measured.level));
        if (measured.peak * gain > 0.98) gain = Math.max(1 / limit, 0.98 / measured.peak);
        if (Math.abs(gain - 1) < 0.06) gain = 1;      // under half a dB: leave the samples alone
      }
      const fadeIn = start > 0 ? Math.min(samples(FADE_IN_MS, rate), body) : 0, fadeOut = Math.min(samples(FADE_OUT_MS, rate), body);
      if (gain !== 1) for (let n = pause; n < out.length; n++) out[n] *= gain;
      for (let n = 0; n < fadeIn; n++) out[pause + n] *= n / fadeIn;
      for (let n = 0; n < fadeOut; n++) out[out.length - 1 - n] *= 0.5 - 0.5 * Math.cos(Math.PI * n / fadeOut);
    }
    this.previous = {ending, tail};
    return out;
  }
}
