// The voice clip a player gives a character of their own (docs/CHARACTER_EDITOR.md, "Your own characters"): a recording of clean speech,
// about 10 to 18 seconds, that the local voices (Pocket and OmniVoice, and Voxtral on the cloud) copy. It is checked here the way the
// shipped references are checked where they are used (bridge/resident-voice-worker.py validate_reference, bridge/pocket_voice_runtime.py
// inspect_reference): a real PCM WAV, one or two channels, 16 to 96 kHz, 16-, 24- or 32-bit, never longer than the 20 seconds the
// OmniVoice worker accepts, a size the workers accept. On top of that the clip must be speech somebody could copy: loud enough, not
// clipped, and not mostly silence.
//
// What is kept is a canonical copy: mono, 16-bit PCM, the clip's own sample rate, a plain 44-byte header. That is a file both workers read
// without any special case (Pocket demands an exact RIFF size), and the file's SHA-256 is the identity the voice configurations carry.
// Nothing is resampled, equalised, normalised or denoised, as for every other reference. Pure functions: no I/O.
import {createHash} from 'node:crypto';

export const CLIP = Object.freeze({
  maxUploadBytes: 16 * 1024 * 1024,   // what the page may send (a 20 s clip is at most about 5.8 MB at 48 kHz stereo 24-bit)
  maxStoredBytes: 8 * 1024 * 1024,    // the canonical copy (add-on references share this limit)
  minSeconds: 5, maxSeconds: 20,      // 20 s is the OmniVoice worker's own limit
  goodMin: 10, goodMax: 18,           // the range the picker and the shipped references use: shorter or longer only earns a gentle note
  minRate: 16000, maxRate: 96000,
  transcript: 600,                    // characters of the words said in the clip
  transcriptMin: 8,
  clipped: 0.005,                     // more than this share of samples at full scale: distorted
  quietDb: -45,                       // the average level of the speaking parts, in dB below full scale: quieter than this cannot be copied
  voicedShare: 0.4,                   // at least this share of the clip must be speaking, not silence
  frameMs: 50,
});

const fail = (code, extra = {}) => ({ok: false, code, ...extra});

/** The audio of a WAV file as mono floats, or {ok: false, code}. Plain PCM, WAVE_FORMAT_EXTENSIBLE PCM and 32-bit float are read. */
export function decodeWav(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44) return fail('clip-format');
  if (bytes.length > CLIP.maxUploadBytes) return fail('clip-big');
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return fail('clip-format');
  let format = null, data = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), start = offset + 8, tag = bytes.toString('ascii', offset, offset + 4);
    // A recorder that stopped early leaves a data chunk that claims more than the file holds: what is there is used.
    const end = Math.min(start + size, bytes.length);
    if (tag === 'fmt ' && size >= 16 && start + 16 <= bytes.length) {
      let codec = bytes.readUInt16LE(start);
      if (codec === 0xFFFE && size >= 26 && start + 26 <= bytes.length) codec = bytes.readUInt16LE(start + 24);   // the sub-format's first two bytes
      format = {codec, channels: bytes.readUInt16LE(start + 2), rate: bytes.readUInt32LE(start + 4), align: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14)};
    } else if (tag === 'data') data = bytes.subarray(start, end);
    offset = start + size + (size % 2);
  }
  if (!format || !data) return fail('clip-format');
  const {codec, channels, rate, bits} = format;
  if (![1, 3].includes(codec) || ![1, 2].includes(channels) || ![16, 24, 32].includes(bits) || (codec === 3 && bits !== 32)
      || format.align !== channels * bits / 8) return fail('clip-format');
  if (rate < CLIP.minRate) return fail('clip-rate', {min: CLIP.minRate});
  if (rate > CLIP.maxRate) return fail('clip-format');
  const frames = Math.floor(data.length / format.align);
  if (frames < 1) return fail('clip-format');
  const out = new Float32Array(frames), width = bits / 8;
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      const at = frame * format.align + channel * width;
      sum += codec === 3 ? data.readFloatLE(at)
        : bits === 16 ? data.readInt16LE(at) / 32768
          : bits === 24 ? data.readIntLE(at, 3) / 8388608
            : data.readInt32LE(at) / 2147483648;
    }
    const sample = sum / channels;
    out[frame] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
  }
  return {ok: true, samples: out, rate, seconds: frames / rate, channels, bits, codec};
}

/** A 16-bit mono PCM WAV with a plain header. */
export function encodeWav(samples, rate) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0, 'ascii'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8, 'ascii');
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
    bytes.writeInt16LE(value, 44 + i * 2);
  }
  return bytes;
}

const db = value => value > 0 ? 20 * Math.log10(value) : -120;

/** Is this clip speech somebody could copy? {ok: true} or {ok: false, code, ...}. */
export function checkSpeech(samples, rate) {
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) >= 0.999) clipped++;
  if (clipped / samples.length > CLIP.clipped) return fail('clip-clipped');
  const size = Math.max(1, Math.round(rate * CLIP.frameMs / 1000)), levels = [];
  for (let at = 0; at + size <= samples.length; at += size) {
    let sum = 0;
    for (let i = at; i < at + size; i++) sum += samples[i] * samples[i];
    levels.push(db(Math.sqrt(sum / size)));
  }
  if (!levels.length) return fail('clip-short');
  const sorted = [...levels].sort((a, b) => a - b), loud = sorted[Math.floor(sorted.length * 0.95)];
  // The speaking parts: within 30 dB of the loudest stretches (a pause is not speech). A clip whose loudest stretches are far below normal speech
  // is then too quiet, not "silent": the average of its speaking parts says so.
  const floor = Math.max(-70, loud - 30), voiced = levels.filter(level => level >= floor);
  if (voiced.length / levels.length < CLIP.voicedShare) return fail('clip-silent');
  const average = db(Math.sqrt(voiced.reduce((sum, level) => sum + 10 ** (level / 10), 0) / voiced.length));
  if (average < CLIP.quietDb) return fail('clip-quiet');
  return {ok: true, average: Math.round(average * 10) / 10, voicedShare: Math.round(voiced.length / levels.length * 100) / 100};
}

/** The words said in the clip, tidied: one paragraph of plain text. */
export function cleanTranscript(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
}
export function checkTranscript(value) {
  const text = cleanTranscript(value), length = Array.from(text).length;
  if (length < CLIP.transcriptMin) return fail('voice-text-short', {min: CLIP.transcriptMin});
  if (length > CLIP.transcript) return fail('voice-text-long', {max: CLIP.transcript});
  return {ok: true, text};
}

/**
 * Checks an uploaded clip and makes the copy that is kept.
 * {ok: true, wav (the canonical Buffer), sha256, seconds, rate, notes: ['short' | 'long'], average} or {ok: false, code, ...}.
 */
export function prepareClip(bytes) {
  const decoded = decodeWav(bytes);
  if (!decoded.ok) return decoded;
  if (decoded.seconds < CLIP.minSeconds) return fail('clip-short', {min: CLIP.minSeconds});
  if (decoded.seconds > CLIP.maxSeconds) return fail('clip-long', {max: CLIP.maxSeconds});
  const speech = checkSpeech(decoded.samples, decoded.rate);
  if (!speech.ok) return speech;
  const wav = encodeWav(decoded.samples, decoded.rate);
  if (wav.length > CLIP.maxStoredBytes) return fail('clip-big');
  const notes = decoded.seconds < CLIP.goodMin ? ['short'] : decoded.seconds > CLIP.goodMax ? ['long'] : [];
  return {ok: true, wav, sha256: createHash('sha256').update(wav).digest('hex'), seconds: Math.round(decoded.seconds * 10) / 10,
    rate: decoded.rate, notes, average: speech.average};
}
