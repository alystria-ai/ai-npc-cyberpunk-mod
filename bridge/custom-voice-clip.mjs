// The voice clip a player gives a character in the editor (docs/CHARACTER_EDITOR.md, "Voice clips"), for a character of their own or a
// story character: a recording of clean speech, about 10 to 18 seconds, that the local voices (Pocket and OmniVoice, and Voxtral on the
// cloud) copy. It is checked here the way the shipped references are checked where they are used (bridge/resident-voice-worker.py
// validate_reference, bridge/pocket_voice_runtime.py inspect_reference): a real PCM WAV, one or two channels, 16 to 96 kHz, 16-, 24- or
// 32-bit, never longer than the 20 seconds the OmniVoice worker accepts (a longer reference makes its adapter pick another passage and
// transcribe it, so the words the player typed would no longer match), a size the workers accept. On top of that the clip must be speech
// somebody could copy: loud enough, not clipped, and not mostly silence.
//
// What is kept is a canonical copy: mono, 16-bit PCM, the clip's own sample rate, a plain 44-byte header. That is a file both workers read
// without any special case (Pocket demands an exact RIFF size), and the file's SHA-256 is the identity the voice configurations carry.
// Nothing is equalised, normalised or denoised, as for every other reference.
//
// Formats: the editor page decodes a WAV, MP3, OGG or FLAC file in the browser (Web Audio, which every supported browser has) and sends a
// 24 kHz mono WAV, so no tool is needed on the player's computer. A file the browser could not decode arrives as it is: a WAV is read here
// in plain JavaScript; an MP3, OGG or FLAC is converted with ffmpeg when the computer has it (CYBERPUNK_CONVAI_FFMPEG or ffmpeg on PATH,
// bridge/voxtral-reference.mjs findFfmpeg; the Runtime does not ship it), else it is refused with a sentence that asks for a WAV. The type is
// decided by the file's first bytes, never by its name or the type the page claimed. Everything but prepareUpload is pure: no I/O.
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {findFfmpeg} from './voxtral-reference.mjs';

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
  convertRate: 24000,                 // what ffmpeg (and the page) convert to: the rate of the shipped references and of Pocket, OmniVoice and Voxtral
  convertMs: 20000,                   // the longest an ffmpeg conversion may take
});
export const CLIP_FORMATS = Object.freeze(['wav', 'mp3', 'ogg', 'flac']);

const fail = (code, extra = {}) => ({ok: false, code, ...extra});

/** The audio of a WAV file as mono floats, or {ok: false, code}. Plain PCM, WAVE_FORMAT_EXTENSIBLE PCM and 32-bit float are read. */
export function decodeWav(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44) return fail('clip-format');
  if (bytes.length > CLIP.maxUploadBytes) return fail('clip-big');
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return fail('clip-format');
  let format = null, data = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), start = offset + 8, tag = bytes.toString('ascii', offset, offset + 4);
    // A recorder that stopped early leaves a data chunk that claims more than the file holds: what is there is used. A streamed file (ffmpeg
    // writing to a pipe) claims 0xFFFFFFFF, and some writers leave 0: the data then runs to the end of the file.
    const end = tag === 'data' && (size === 0 || size === 0xFFFFFFFF) ? bytes.length : Math.min(start + size, bytes.length);
    if (tag === 'fmt ' && size >= 16 && start + 16 <= bytes.length) {
      let codec = bytes.readUInt16LE(start);
      if (codec === 0xFFFE && size >= 26 && start + 26 <= bytes.length) codec = bytes.readUInt16LE(start + 24);   // the sub-format's first two bytes
      format = {codec, channels: bytes.readUInt16LE(start + 2), rate: bytes.readUInt32LE(start + 4), align: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14)};
    } else if (tag === 'data') { data = bytes.subarray(start, end); if (end === bytes.length) break; }
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

/** The kind of audio file the bytes hold, from their first bytes: 'wav', 'flac', 'ogg', 'mp3' or null. An ID3 tag counts as MP3 (ffmpeg then
 * reads what follows it, and a FLAC file behind an ID3 tag is found too). An MPEG frame sync with the reserved layer (AAC's ADTS) is not MP3. */
export function sniffAudio(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  const head = bytes.toString('latin1', 0, 4);
  if (head === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (head === 'fLaC') return 'flac';
  if (head === 'OggS') return 'ogg';
  if (head.startsWith('ID3')) return 'mp3';
  if (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0 && ((bytes[1] >> 1) & 3) !== 0 && ((bytes[1] >> 3) & 3) !== 1) return 'mp3';
  return null;
}

/**
 * Converts an MP3, OGG or FLAC file to a 24 kHz mono 16-bit WAV with ffmpeg, through pipes (no temporary file), or resolves to null when it
 * fails. Only those four demuxers may read the input (-format_whitelist), only the first audio stream is used, and at most a second more
 * than the longest clip is decoded, so a long or odd file costs no more than a short one. `rate` and `seconds` (default 24000 and 21) let another caller
 * (bridge/prepared-audio.mjs: a quest line, a music bed) ask for its own output rate and cut-off.
 */
export function convertWithFfmpeg(bytes, ffmpeg, {run = execFile, timeoutMs = CLIP.convertMs, rate = CLIP.convertRate, seconds = CLIP.maxSeconds + 1} = {}) {
  if (!ffmpeg) return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      const child = run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-format_whitelist', 'wav,flac,ogg,mp3', '-i', 'pipe:0', '-map', '0:a:0',
        '-t', String(seconds), '-ac', '1', '-ar', String(rate), '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-flags:a', '+bitexact',
        '-f', 'wav', 'pipe:1'], {encoding: 'buffer', windowsHide: true, timeout: timeoutMs, maxBuffer: Math.max(8 * 1024 * 1024, Math.ceil(seconds * rate * 2) + 4096)},
      (error, stdout) => resolve(error || !stdout?.length ? null : Buffer.from(stdout)));
      child?.on?.('error', () => resolve(null));
      child?.stdin?.on?.('error', () => {});
      child?.stdin?.end(bytes);
    } catch { resolve(null); }
  });
}

/**
 * Checks a clip as the page sent it and makes the copy that is kept: prepareClip's result, plus `format` (what the file was). A WAV needs no
 * tool. An MP3, OGG or FLAC needs ffmpeg (`ffmpeg`: the command, or a function resolving to it or null; findFfmpeg by default); without
 * it the answer is {ok: false, code: 'clip-needs-wav', format}. Anything else is 'clip-format'.
 */
export async function prepareUpload(bytes, {ffmpeg = findFfmpeg, run, timeoutMs} = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return fail('clip-format');
  if (bytes.length > CLIP.maxUploadBytes) return fail('clip-big');
  const format = sniffAudio(bytes);
  if (!format) return fail('clip-format');
  if (format === 'wav') { const clip = prepareClip(bytes); return clip.ok ? {...clip, format} : clip; }
  let command = null;
  try { command = typeof ffmpeg === 'function' ? await ffmpeg() : ffmpeg; } catch { command = null; }
  if (!command) return fail('clip-needs-wav', {format});
  const wav = await convertWithFfmpeg(bytes, command, {run, timeoutMs});
  if (!wav) return fail('clip-format');
  const clip = prepareClip(wav);
  return clip.ok ? {...clip, format} : clip;
}
