// WAV reading, resampling and reference concatenation for the reference picker.
//
// A multi-clip reference is built the way the research agent built the proposed three-clip references
// (runtime/voice-references/multiref-proposed): whole clips in the listed order, each converted to mono at
// 24 kHz with torchaudio's default windowed-sinc resampler, 0.4 s of digital silence between clips, 16-bit PCM.
// No EQ, denoising, trimming, normalisation or gain. The resampler below is a line-for-line port of
// torchaudio.functional.resample (sinc_interp_hann, lowpass_filter_width 6, rolloff 0.99); against the research
// agent's own output it differs by at most about one 16-bit step.
import {readFile} from 'node:fs/promises';

export const REFERENCE_RATE = 24000;
export const CLIP_GAP_SECONDS = 0.4;

const gcd = (a, b) => b ? gcd(b, a % b) : a;

export function parseWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw Error('Not a RIFF WAV file');
  }
  let at = 12, format = null, data = null;
  while (at + 8 <= buffer.length) {
    const name = buffer.toString('ascii', at, at + 4);
    const size = buffer.readUInt32LE(at + 4);
    const body = at + 8;
    if (name === 'fmt ') {
      format = {code: buffer.readUInt16LE(body), channels: buffer.readUInt16LE(body + 2), rate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14)};
      if (format.code === 0xFFFE && size >= 26) format.code = buffer.readUInt16LE(body + 24);
    } else if (name === 'data') {
      data = {start: body, size: Math.min(size, buffer.length - body)};
      break;
    }
    at = body + size + (size % 2);
  }
  if (!format || !data) throw Error('WAV has no format or audio chunk');
  const {code, channels, rate, bits} = format;
  if (![1, 3].includes(code) || ![1, 2].includes(channels) || ![16, 24, 32].includes(bits) || (code === 3 && bits !== 32)) {
    throw Error(`Unsupported WAV encoding (code ${code}, ${channels} ch, ${bits} bit)`);
  }
  const bytes = bits / 8, frames = Math.floor(data.size / (bytes * channels));
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      const offset = data.start + (frame * channels + channel) * bytes;
      sum += code === 3 ? buffer.readFloatLE(offset)
        : bits === 16 ? buffer.readInt16LE(offset) / 32768
        : bits === 24 ? buffer.readIntLE(offset, 3) / 8388608
        : buffer.readInt32LE(offset) / 2147483648;
    }
    samples[frame] = sum / channels;
  }
  return {samples, rate, channels, bits, frames, seconds: frames / rate};
}

export async function readWav(path) { return parseWav(await readFile(path)); }

// torchaudio.functional.resample, default arguments, for one mono signal.
export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const divisor = gcd(fromRate, toRate), orig = fromRate / divisor, target = toRate / divisor;
  const base = Math.min(orig, target) * 0.99, width = Math.ceil(6 * orig / base), taps = 2 * width + orig;
  const kernel = new Float64Array(target * taps);
  for (let phase = 0; phase < target; phase++) {
    for (let k = 0; k < taps; k++) {
      let t = (-phase / target + (k - width) / orig) * base;
      t = Math.max(-6, Math.min(6, t));
      const window = Math.cos(t * Math.PI / 6 / 2) ** 2, x = t * Math.PI;
      kernel[phase * taps + k] = (x === 0 ? 1 : Math.sin(x) / x) * window * (base / orig);
    }
  }
  const length = samples.length, frames = Math.floor((length + 2 * width + orig - taps) / orig) + 1;
  const out = new Float32Array(Math.ceil(target * length / orig));
  for (let frame = 0; frame < frames; frame++) {
    for (let phase = 0; phase < target; phase++) {
      const slot = frame * target + phase;
      if (slot >= out.length) break;
      let sum = 0;
      for (let k = 0; k < taps; k++) {
        const source = frame * orig + k - width;
        if (source >= 0 && source < length) sum += samples[source] * kernel[phase * taps + k];
      }
      out[slot] = sum;
    }
  }
  return out;
}

// Concatenate decoded clips ({samples, rate}) into one 24 kHz mono signal.
export function concatClips(clips, {rate = REFERENCE_RATE, gap = CLIP_GAP_SECONDS} = {}) {
  const parts = [];
  clips.forEach((clip, index) => {
    parts.push(resample(clip.samples, clip.rate, rate));
    if (index < clips.length - 1) parts.push(new Float32Array(Math.round(gap * rate)));
  });
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return {samples: out, rate};
}

// Seconds a set of clip durations adds up to once joined (clips plus the silent gaps).
export const joinedSeconds = durations => durations.reduce((a, b) => a + b, 0) + Math.max(0, durations.length - 1) * CLIP_GAP_SECONDS;

export function encodeWav(samples, rate) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(samples.length * 2, 40);
  for (let at = 0; at < samples.length; at++) {
    const value = Math.max(-1, Math.min(1, samples[at]));
    out.writeInt16LE(Math.round(value * 32767), 44 + at * 2);
  }
  return out;
}
