// Prepared audio of a story pack: what the bytes of an audio/, music/ or sfx/ file are, whether they can be played, and how they become mono samples.
// A pack file may be a WAV, an Ogg (Opus or Vorbis), a FLAC or an MP3 (the pack validator, bridge/quest-format.mjs, names .wav, .ogg and .opus).
//
// WHAT IS AND IS NOT VERIFIED (read this before trusting an .ogg pack)
//   * WAV is decoded in plain JavaScript (bridge/omni-pcm.mjs wavToPcm) and needs nothing else. This is the only format that works on every machine.
//   * Ogg, FLAC and MP3 are decoded by an EXTERNAL decoder. There is no pure JavaScript Opus decoder in this repository and none is added. In order:
//       1. ffmpeg (CYBERPUNK_CONVAI_FFMPEG or ffmpeg on PATH: bridge/voxtral-reference.mjs findFfmpeg, bridge/custom-voice-clip.mjs convertWithFfmpeg). The Runtime does
//          not ship ffmpeg, so only a player who installed it has this route.
//       2. the Runtime's own Python (CYBERPUNK_CONVAI_PYTHON) with the soundfile and numpy packages, called with -I and the file's bytes through a pipe (never a path,
//          never from a folder with downloaded files). Whether the Runtime's Python has soundfile with Opus support has NOT been checked here: the route is written
//          and tested against a fake interpreter only.
//     So the honest status of an .ogg or .opus pack is: it plays on a machine that has ffmpeg or a Runtime Python with soundfile, otherwise the line is shown as a
//     subtitle and a pack error is logged (the missing audio path). A pack that must play everywhere ships WAV.
//   * The Ogg page headers are read in plain JavaScript (parseOgg): codec (Opus or Vorbis), channel count, sample rate and the length from the last page's granule
//     position. A file that is not Opus or Vorbis, has more than two channels or is longer than the limit is refused BEFORE any decoder runs, and the limit is checked
//     without decoding. FLAC's length is read from its STREAMINFO block the same way. An MP3 has no cheap length: its decode is cut at the limit and refused when it
//     runs past it.
//   * A decoded file is cached as 16-bit samples in the bridge's state folder, keyed by the SHA-256 of the file's bytes and the rate (small and bounded: oldest
//     evicted), so a line is converted once. A WAV is never cached (its decode is a loop over its own bytes).
//
// Nothing here runs per frame or on a timer. decodePrepared() is called when a line or a sound is asked for.
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OMNI_RATE, wavToPcm} from './omni-pcm.mjs';
import {readPcmWav} from './speech-audio.mjs';
import {convertWithFfmpeg, decodeWav, sniffAudio} from './custom-voice-clip.mjs';
import {findFfmpeg} from './voxtral-reference.mjs';
import {absoluteRuntimeOverride} from './runtime-paths.mjs';

export const PREPARED_AUDIO = Object.freeze({
  rate: OMNI_RATE,                   // a line is played at the renderer's rate
  maxSeconds: 60,                    // the longest prepared line
  maxBytes: 24000000,                // the same ceiling as readPreparedFile
  decodeMs: 20000,                   // the longest an external decoder may take
  cacheFiles: 48, cacheBytes: 96 * 1024 * 1024,
});

const fail = message => { throw Error(message); };

// ---- the container, from the bytes -------------------------------------------------------------------------------------------------------

/** The kind of audio file the bytes hold ('wav', 'ogg', 'flac', 'mp3') or null. By the first bytes, never by a name. */
export function sniffContainer(bytes) { return sniffAudio(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])); }

const OGG_MAX_PAGE = 27 + 255 + 255 * 255;

/** One Ogg page header at `at`: {at, flags, granule (BigInt), serial, sequence, headerBytes, bodyBytes, end} or null when it is not one. */
export function oggPageAt(bytes, at) {
  if (at < 0 || at + 27 > bytes.length || bytes.toString('latin1', at, at + 4) !== 'OggS' || bytes[at + 4] !== 0) return null;
  const segments = bytes[at + 26];
  if (at + 27 + segments > bytes.length) return null;
  let body = 0;
  for (let i = 0; i < segments; i++) body += bytes[at + 27 + i];
  const headerBytes = 27 + segments;
  return {at, flags: bytes[at + 5], granule: bytes.readBigInt64LE(at + 6), serial: bytes.readUInt32LE(at + 14), sequence: bytes.readUInt32LE(at + 18),
    headerBytes, bodyBytes: body, end: at + headerBytes + body};
}

/**
 * What an Ogg file's headers say: {codec: 'opus' | 'vorbis', channels, sampleRate, seconds (or null when no page ends with a position)}. Opus always plays at
 * 48 kHz (the rate in its header is the original's). Throws a plain Error for an Ogg that is not Opus or Vorbis, has more than two channels or is cut short.
 */
export function parseOgg(bytes) {
  const first = oggPageAt(bytes, 0);
  if (!first || !(first.flags & 2) || first.bodyBytes < 19 || first.end > bytes.length) fail('The prepared audio file is not a complete Ogg stream');
  const body = bytes.subarray(first.headerBytes, first.end);
  let codec, channels, sampleRate, preSkip = 0;
  if (body.toString('latin1', 0, 8) === 'OpusHead') {
    codec = 'opus'; channels = body[9]; preSkip = body.readUInt16LE(10); sampleRate = 48000;
    if ((body[8] >> 4) !== 0) fail('The prepared audio file is an Opus stream of a version this build does not know');
  } else if (body[0] === 1 && body.toString('latin1', 1, 7) === 'vorbis') {
    codec = 'vorbis'; channels = body[11]; sampleRate = body.readUInt32LE(12);
    if (body.readUInt32LE(7) !== 0) fail('The prepared audio file is a Vorbis stream of a version this build does not know');
  } else fail('The prepared audio file is an Ogg stream that holds neither Opus nor Vorbis');
  if (channels < 1 || channels > 2) fail('The prepared audio file must be mono or stereo');
  if (!(sampleRate >= 8000 && sampleRate <= 192000)) fail('The prepared audio file has an unusable sample rate');
  // The length: the granule position of the last page that has one, found by looking backward from the end for the last page header.
  let seconds = null, search = bytes.length;
  for (let tries = 0; tries < 64 && search > 0; tries++) {
    const at = bytes.lastIndexOf('OggS', search - 1, 'latin1');
    if (at < 0) break;
    search = at;
    const page = oggPageAt(bytes, at);
    if (!page || page.end > bytes.length || page.bodyBytes > OGG_MAX_PAGE || page.granule < 0n || page.serial !== first.serial) continue;
    if (page.granule > 9000000000000n) fail('The prepared audio file claims an impossible length');
    const samples = Number(page.granule) - (codec === 'opus' ? preSkip : 0);
    seconds = Math.max(0, samples) / sampleRate;
    break;
  }
  return {codec, channels, sampleRate, seconds};
}

/** FLAC: {codec: 'flac', channels, sampleRate, seconds (null when the file does not say)} from the STREAMINFO block, or a plain Error. */
export function parseFlac(bytes) {
  if (bytes.length < 42 || bytes.toString('latin1', 0, 4) !== 'fLaC' || (bytes[4] & 0x7f) !== 0 || bytes.readUIntBE(5, 3) < 34) fail('The prepared audio file is not a complete FLAC stream');
  const sampleRate = (bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4), channels = ((bytes[20] >> 1) & 7) + 1;
  const total = (bytes[21] & 15) * 2 ** 32 + bytes.readUInt32BE(22);
  if (channels > 2) fail('The prepared audio file must be mono or stereo');
  if (!(sampleRate >= 8000 && sampleRate <= 192000)) fail('The prepared audio file has an unusable sample rate');
  return {codec: 'flac', channels, sampleRate, seconds: total > 0 ? total / sampleRate : null};
}

/**
 * What a prepared file is, checked without decoding it: {container, codec, channels, sampleRate, seconds (or null), route: 'wav' | 'external'}. Throws a plain Error
 * (empty, too large, not a known format, a broken or unusable header, longer than maxSeconds). The caller turns that into the subtitle path.
 */
export function planPrepared(bytes, {maxSeconds = PREPARED_AUDIO.maxSeconds, maxBytes = PREPARED_AUDIO.maxBytes} = {}) {
  if (!bytes || typeof bytes.length !== 'number' || !bytes.length) fail('The prepared audio file is empty');
  if (bytes.length > maxBytes) fail('The prepared audio file is too large');
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const container = sniffContainer(data);
  if (!container) fail('The prepared audio file is not a WAV, Ogg, FLAC or MP3 file');
  let plan;
  if (container === 'wav') {
    let wav;
    try { wav = readPcmWav(data); } catch { fail('The prepared audio file is not a supported PCM WAV'); }
    plan = {container, codec: 'pcm', channels: wav.channels, sampleRate: wav.sampleRate, seconds: wav.duration, route: 'wav'};
  } else if (container === 'ogg') plan = {container, ...parseOgg(data), route: 'external'};
  else if (container === 'flac') plan = {container, ...parseFlac(data), route: 'external'};
  else plan = {container, codec: 'mp3', channels: null, sampleRate: null, seconds: null, route: 'external'};
  if (plan.seconds !== null && plan.seconds > maxSeconds) fail(`The prepared audio file is longer than ${maxSeconds} seconds`);
  return plan;
}

// ---- samples -----------------------------------------------------------------------------------------------------------------------------

/** A PCM WAV's bytes as mono Float32 at `rate` (24000 uses wavToPcm itself). Averages channels, linear interpolation for another rate. Throws what readPcmWav throws. */
export function wavToMono(bytes, rate = PREPARED_AUDIO.rate) {
  if (rate === OMNI_RATE) return wavToPcm(bytes);
  const wav = readPcmWav(bytes), frames = wav.data.length / wav.align, step = wav.bits / 8, mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < wav.channels; channel++) {
      const at = frame * wav.align + channel * step;
      const raw = wav.codec === 3 ? wav.data.readFloatLE(at) : wav.data.readIntLE(at, step) / 2 ** (wav.bits - 1);
      sum += Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
    }
    mono[frame] = sum / wav.channels;
  }
  if (wav.sampleRate === rate) return mono;
  const count = Math.max(1, Math.round(frames * rate / wav.sampleRate)), out = new Float32Array(count), ratio = wav.sampleRate / rate;
  for (let at = 0; at < count; at++) {
    const position = at * ratio, low = Math.min(frames - 1, Math.floor(position)), high = Math.min(frames - 1, low + 1), mix = position - low;
    out[at] = mono[low] * (1 - mix) + mono[high] * mix;
  }
  return out;
}

/**
 * The WAV an external decoder wrote to a pipe as mono samples at `rate`. ffmpeg streams its header with the size fields left at 0xFFFFFFFF, which readPcmWav refuses
 * and bridge/custom-voice-clip.mjs decodeWav accepts. The decoder was asked for `rate`, so nothing is resampled; another rate is converted with linear interpolation.
 */
export function pipeWavToMono(bytes, rate = PREPARED_AUDIO.rate) {
  const wav = decodeWav(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []));
  if (!wav.ok) fail('The decoder wrote audio this build cannot read');
  if (wav.rate === rate) return wav.samples;
  const count = Math.max(1, Math.round(wav.samples.length * rate / wav.rate)), out = new Float32Array(count), ratio = wav.rate / rate;
  for (let at = 0; at < count; at++) {
    const position = at * ratio, low = Math.min(wav.samples.length - 1, Math.floor(position)), high = Math.min(wav.samples.length - 1, low + 1), mix = position - low;
    out[at] = wav.samples[low] * (1 - mix) + wav.samples[high] * mix;
  }
  return out;
}

const finiteSamples = samples => { for (let i = 0; i < samples.length; i++) if (!Number.isFinite(samples[i])) samples[i] = 0; return samples; };

// ---- the cache ---------------------------------------------------------------------------------------------------------------------------

/**
 * Which cache files to remove: the oldest first until at most maxFiles remain and they hold at most maxBytes. entries: [{name, size, mtimeMs}]. Pure.
 */
export function evictionPlan(entries, {maxFiles = PREPARED_AUDIO.cacheFiles, maxBytes = PREPARED_AUDIO.cacheBytes} = {}) {
  const sorted = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : 1));
  let count = sorted.length, bytes = sorted.reduce((sum, row) => sum + row.size, 0);
  const remove = [];
  for (const row of sorted) {
    if (count <= maxFiles && bytes <= maxBytes) break;
    remove.push(row.name); count--; bytes -= row.size;
  }
  return remove;
}

const CACHE_FILE = /^[0-9a-f]{64}-\d{4,6}\.s16$/;

/** Samples as the cache keeps them (16-bit little endian) and back. */
export const toS16 = samples => { const out = Buffer.allocUnsafe(samples.length * 2); for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2); return out; };
export const fromS16 = bytes => { const out = new Float32Array(Math.floor(bytes.length / 2)); for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(i * 2) / 32768; return out; };

/**
 * The decoded-sample cache: a folder of <sha256 of the file>-<rate>.s16 files, bounded (oldest evicted after a write). Every failure is swallowed: a cache that
 * cannot be read or written only means the file is decoded again. `fs` is injectable for tests.
 */
export function createDecodeCache({directory, maxFiles = PREPARED_AUDIO.cacheFiles, maxBytes = PREPARED_AUDIO.cacheBytes,
  fs = {mkdir, readFile, readdir, rename, stat, unlink, utimes, writeFile}} = {}) {
  if (typeof directory !== 'string' || !directory) throw Error('A decode cache needs a folder');
  const nameOf = (sha, rate) => `${sha}-${rate}.s16`;
  return {
    directory,
    async get(sha, rate) {
      const name = nameOf(sha, rate);
      try {
        const bytes = await fs.readFile(join(directory, name));
        const now = new Date(); void fs.utimes(join(directory, name), now, now).catch(() => {});
        return bytes.length ? fromS16(bytes) : null;
      } catch { return null; }
    },
    async put(sha, rate, samples) {
      const name = nameOf(sha, rate);
      try {
        await fs.mkdir(directory, {recursive: true});
        const temporary = join(directory, `${name}.${process.pid}.tmp`);
        await fs.writeFile(temporary, toS16(samples));
        await fs.rename(temporary, join(directory, name));
        const entries = [];
        for (const file of await fs.readdir(directory)) {
          if (!CACHE_FILE.test(file)) continue;
          try { const info = await fs.stat(join(directory, file)); entries.push({name: file, size: info.size, mtimeMs: info.mtimeMs}); } catch { /* gone */ }
        }
        for (const file of evictionPlan(entries, {maxFiles, maxBytes})) await fs.unlink(join(directory, file)).catch(() => {});
        return true;
      } catch { return false; }
    },
  };
}

// ---- the external decoders ----------------------------------------------------------------------------------------------------------------

/** The Runtime's Python (CYBERPUNK_CONVAI_PYTHON, an absolute path that exists), or null. */
export function findRuntimePython({env = process.env, exists = existsSync} = {}) {
  try {
    const path = absoluteRuntimeOverride(env.CYBERPUNK_CONVAI_PYTHON || undefined, 'CYBERPUNK_CONVAI_PYTHON');
    return path && exists(path) ? path : null;
  } catch { return null; }
}

// The Python route's program: reads the file's bytes from stdin (never a path), decodes with soundfile, writes mono little-endian float32 at the wanted rate.
// Exit 3: soundfile or numpy is missing. Exit 4: the file could not be decoded.
export const PYTHON_DECODER = [
  'import sys, io',
  'try:',
  '    import numpy as np, soundfile as sf',
  'except Exception:',
  '    sys.exit(3)',
  'rate = int(sys.argv[1]); limit = int(sys.argv[2])',
  'raw = sys.stdin.buffer.read()',
  'try:',
  '    with sf.SoundFile(io.BytesIO(raw)) as f:',
  '        src = f.samplerate',
  '        data = f.read(frames=int(src * limit / rate) + 1, dtype="float32", always_2d=True)',
  'except Exception:',
  '    sys.exit(4)',
  'mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]',
  'if src != rate and len(mono):',
  '    n = max(1, int(round(len(mono) * rate / src)))',
  '    mono = np.interp(np.linspace(0, len(mono) - 1, n), np.arange(len(mono)), mono)',
  'sys.stdout.buffer.write(np.ascontiguousarray(mono[:limit], dtype="<f4").tobytes())',
].join('\n');

/** Runs the Python route: resolves to the mono samples, or null when Python or soundfile is missing or the file did not decode. Never throws. */
export function runPythonDecoder(python, bytes, {rate, limitFrames, run = execFile, timeoutMs = PREPARED_AUDIO.decodeMs} = {}) {
  if (!python) return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      const child = run(python, ['-I', '-c', PYTHON_DECODER, String(rate), String(limitFrames)],
        {encoding: 'buffer', windowsHide: true, timeout: timeoutMs, cwd: tmpdir(), maxBuffer: limitFrames * 4 + 4096},
        (error, stdout) => {
          if (error || !stdout?.length || stdout.length % 4) { resolve(null); return; }
          const copy = Buffer.from(stdout), samples = new Float32Array(copy.length / 4);
          for (let i = 0; i < samples.length; i++) samples[i] = copy.readFloatLE(i * 4);
          resolve(samples);
        });
      child?.on?.('error', () => resolve(null));
      child?.stdin?.on?.('error', () => {});
      child?.stdin?.end(bytes);
    } catch { resolve(null); }
  });
}

/**
 * The decoder. Options (all injectable, so a test needs no ffmpeg and no Python):
 *   ffmpeg      () => Promise<command | null>   (findFfmpeg)         convert(bytes, command, {rate, seconds}) -> Promise<WAV Buffer | null>  (convertWithFfmpeg)
 *   python      () => command | null            (findRuntimePython)  runPython(python, bytes, {rate, limitFrames}) -> Promise<Float32Array | null>  (runPythonDecoder)
 *   cache       createDecodeCache(...) or null (no cache)
 * decode(bytes, {rate, maxSeconds}) -> Promise<Float32Array> (mono at `rate`). Throws a plain Error with a sentence a pack author can act on.
 */
export function createPreparedAudio({ffmpeg = findFfmpeg, convert = convertWithFfmpeg, python = findRuntimePython, runPython = runPythonDecoder, cache = null,
  rate: defaultRate = PREPARED_AUDIO.rate, maxSeconds: defaultSeconds = PREPARED_AUDIO.maxSeconds, maxBytes = PREPARED_AUDIO.maxBytes, onLog = () => {}} = {}) {
  const note = text => { try { onLog(text); } catch { /* a log never affects playback */ } };
  return {
    cache,
    plan: (bytes, options = {}) => planPrepared(bytes, {maxSeconds: defaultSeconds, maxBytes, ...options}),
    async decode(bytes, {rate = defaultRate, maxSeconds = defaultSeconds} = {}) {
      const plan = planPrepared(bytes, {maxSeconds, maxBytes});
      const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const finish = samples => {
        if (!samples || !samples.length) fail('The prepared audio file decoded to nothing');
        if (samples.length > maxSeconds * rate) fail(`The prepared audio file is longer than ${maxSeconds} seconds`);
        return finiteSamples(samples);
      };
      if (plan.route === 'wav') {
        let wavSamples;
        try { wavSamples = wavToMono(data, rate); } catch { fail('The prepared audio file is not a supported PCM WAV'); }
        return finish(wavSamples);
      }
      const sha = createHash('sha256').update(data).digest('hex');
      const cached = cache ? await cache.get(sha, rate) : null;
      if (cached) return finish(cached);
      let samples = null, interpreter = null;
      const command = await Promise.resolve().then(() => ffmpeg()).catch(() => null);
      if (command) {
        const wav = await convert(data, command, {rate, seconds: maxSeconds + 1});
        if (wav) { try { samples = pipeWavToMono(wav, rate); } catch { samples = null; } }
        if (!samples) note(`ffmpeg could not decode the ${plan.container} file`);
      }
      if (!samples) {
        interpreter = await Promise.resolve().then(() => python()).catch(() => null);
        if (interpreter) {
          samples = await runPython(interpreter, data, {rate, limitFrames: (maxSeconds + 1) * rate});
          if (!samples) note(`the Runtime Python could not decode the ${plan.container} file (soundfile missing, or the file is broken)`);
        }
      }
      if (!samples) {
        if (!command && !interpreter) fail(`The prepared audio file is ${plan.codec === 'pcm' ? 'audio' : plan.codec} in a ${plan.container} file: playing it needs ffmpeg on this computer or the Runtime Python with the soundfile package, otherwise the pack must ship WAV`);
        fail(`The prepared audio file (${plan.container}) could not be decoded`);
      }
      const done = finish(samples);
      if (cache) void cache.put(sha, rate, done);
      return done;
    },
  };
}
