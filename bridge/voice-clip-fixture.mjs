// A synthetic recording for the voice clip tests (bridge/custom-voice-clip.mjs, bridge/player-voices.mjs, the character editor): a voiced tone
// shaped like words with short pauses, which passes the speech checks unless asked not to. Test code only; never shipped.
// ---- a synthetic recording: a voiced tone, shaped like words with short pauses, at any rate, depth and channel count
export function speechWav({seconds = 12, rate = 24000, channels = 1, bits = 16, level = 0.4, silent = false, clip = false, extensible = false, float = false} = {}) {
  const frames = Math.round(seconds * rate), width = float ? 4 : bits / 8, align = channels * width;
  const header = extensible ? 40 : 16, bytes = Buffer.alloc(12 + 8 + header + 8 + frames * align);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(header, 16);
  const codec = float ? 3 : 1;
  bytes.writeUInt16LE(extensible ? 0xFFFE : codec, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * align, 28);
  bytes.writeUInt16LE(align, 32); bytes.writeUInt16LE(float ? 32 : bits, 34);
  if (extensible) { bytes.writeUInt16LE(22, 36); bytes.writeUInt16LE(float ? 32 : bits, 38); bytes.writeUInt32LE(3, 40); bytes.writeUInt16LE(codec, 44); }
  const at = 20 + header;
  bytes.write('data', at); bytes.writeUInt32LE(frames * align, at + 4);
  for (let i = 0; i < frames; i++) {
    const t = i / rate, word = silent ? 0 : (Math.sin(2 * Math.PI * 2.2 * t) > -0.7 ? 1 : 0);   // about a fifth of the time is a pause
    let sample = word * level * Math.sin(2 * Math.PI * 180 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 5 * t));
    if (clip) sample = Math.sign(sample) * Math.min(1, Math.abs(sample) * 20);
    for (let c = 0; c < channels; c++) {
      const place = at + 8 + i * align + c * width;
      if (float) bytes.writeFloatLE(sample, place);
      else if (bits === 16) bytes.writeInt16LE(Math.round(sample * 32767), place);
      else if (bits === 24) bytes.writeIntLE(Math.round(sample * 8388607), place, 3);
      else bytes.writeInt32LE(Math.round(sample * 2147483647), place);
    }
  }
  return bytes;
}
