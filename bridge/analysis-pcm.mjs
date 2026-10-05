// A read-only analysis copy of streamed PCM16 speech (browser and Node). The
// renderer keeps its own packets; this copy only feeds the facial model and is
// requested by absolute frame offset, so a repeated or lost poll can neither
// skip nor duplicate samples. No gain, filtering or resampling is applied.
const MAX_SLICE_FRAMES = 48000;

export class AnalysisPcm {
  constructor(channels) {
    if (![1, 2].includes(channels)) throw Error('Invalid analysis channel count');
    this.channels = channels; this.parts = []; this.frames = 0;
  }
  // Interleaved little-endian PCM16 bytes at exactly the current end offset.
  append(bytes, offsetFrames) {
    if (!(bytes instanceof Uint8Array) || bytes.length % (2 * this.channels) || offsetFrames !== this.frames)
      throw Error('Analysis PCM is out of order');
    if (!bytes.length) return;
    this.parts.push({offset: offsetFrames, bytes: bytes.slice()});
    this.frames += bytes.length / (2 * this.channels);
  }
  // Mono PCM16 (channel average) for frames [from, from + count), base64.
  slice(from, maxFrames = MAX_SLICE_FRAMES / 2) { // ~1 s per poll keeps each playback update small
    if (!Number.isSafeInteger(from) || from < 0 || from > this.frames) return undefined;
    const count = Math.min(maxFrames, this.frames - from);
    if (!count) return undefined;
    const mono = new Uint8Array(count * 2), view = new DataView(mono.buffer);
    let index = this.parts.findIndex(part => part.offset + part.bytes.length / (2 * this.channels) > from);
    for (let frame = from; frame < from + count; index++) {
      const part = this.parts[index], partFrames = part.bytes.length / (2 * this.channels);
      const source = new DataView(part.bytes.buffer, part.bytes.byteOffset, part.bytes.byteLength);
      for (let local = frame - part.offset; local < partFrames && frame < from + count; local++, frame++) {
        let sum = 0;
        for (let channel = 0; channel < this.channels; channel++) sum += source.getInt16((local * this.channels + channel) * 2, true);
        view.setInt16((frame - from) * 2, Math.round(sum / this.channels), true);
      }
    }
    let binary = '';
    for (let offset = 0; offset < mono.length; offset += 32768) binary += String.fromCharCode(...mono.subarray(offset, offset + 32768));
    return {offsetFrames: from, frames: count, data: btoa(binary)};
  }
}

// Validate and decode a slice to Float32 samples in [-1, 1).
export function decodeAnalysisPcm(slice, expectedOffset) {
  if (!slice || slice.offsetFrames !== expectedOffset || !Number.isSafeInteger(slice.frames) || slice.frames < 1
      || slice.frames > MAX_SLICE_FRAMES || typeof slice.data !== 'string' || slice.data.length !== Math.ceil(slice.frames * 2 / 3) * 4)
    throw Error('Invalid analysis PCM slice');
  const binary = atob(slice.data);
  if (binary.length !== slice.frames * 2) throw Error('Invalid analysis PCM slice');
  const pcm = new Float32Array(slice.frames);
  for (let i = 0; i < slice.frames; i++) {
    const value = binary.charCodeAt(2 * i) | (binary.charCodeAt(2 * i + 1) << 8);
    pcm[i] = (value & 0x8000 ? value - 0x10000 : value) / 32768;
  }
  return pcm;
}
