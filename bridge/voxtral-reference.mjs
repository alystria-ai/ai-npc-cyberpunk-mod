// A smaller Voxtral reference clip (docs/LATENCY_2026-10-12.md, docs/CLOUD_VOICE_VOXTRAL.md).
//
// Voxtral clones a voice from a reference clip that is sent with EVERY request (saved voices need a paid plan). The clips the mod
// keeps are 8 to 18 s of 24 kHz 16-bit WAV: 560 to 650 KB, 750 to 860 KB as base64 in the request. On a slow uplink that upload is
// most of the first-audio wait: the Mistral server answered after 1.37 s with the 857 KB body and after 0.57 s with an 89 KB one,
// the same text and the same voice (measured 2026-10-12, six real calls, scripts/Test-VoxtralReferenceSize.mjs).
//
// This module makes the reference small without a tool the player may not have:
//   prepareReference         mono, 24 kHz, cut to about 8.5 s in a pause (pure JavaScript): 408 KB as a WAV
//   encodeMp3                mono MP3 at 40 kbit/s with ffmpeg, when the machine has it: about 43 KB (the API takes MP3 references)
//   createReferencePreparer  the two above behind a cache on disk, keyed by the source clip's hash, so the work is done once
//
// THE CLONE REPRODUCES THE REFERENCE'S BANDWIDTH (measured 2026-10-13, 25 real calls, scripts/Measure-VoxtralClarity.mjs): Voxtral
// itself speaks up to its 12 kHz Nyquist, but what it says has only the frequencies its reference had. The first versions of this
// file (versions 1 and 2) sent 16 kHz audio (nothing above 8 kHz), as a 32 kbit/s MP3 whose encoder low-pass sits at 7.3 kHz: every
// answer then had nothing above 7.5 kHz (the 8 to 12 kHz bands were 55 dB under the 0 to 4 kHz level, against 22 to 24 dB for the
// original clip's answers), which is what sounded muffled.
// A 24 kHz MP3 keeps the bands (40 kbit/s: to 10.5 kHz, 43 KB; 48 kbit/s: to 11.3 kHz, 51 KB) for about 9 KB more upload (version 3).
// The sample rate matters more than the bitrate: 16 kHz at 64 kbit/s or as a WAV is just as dull.
//
// Clone similarity (ECAPA speaker embedding against the original reference's) was the same within the call-to-call spread of
// Voxtral itself (0.50 and 0.65 for the full clip, 0.58 and 0.57 for the cut 16 kHz clip, 0.58 and 0.51 for the cut MP3).
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export const REFERENCE_PREPARATION = Object.freeze({
  version: 3,            // 3: 24 kHz (not 16) and 40 kbit/s (not 32): the clone had nothing above 7.5 kHz (2026-10-13). 2: 32 kbit/s, not 64 (first audio about 0.4 s sooner, same clone)
  maxSeconds: 8.5,       // the clip is cut at the quietest moment inside its last 2.5 s before this
  targetRate: 24000,     // the rate of the stored clips and of Voxtral's own output; a source at another rate is resampled to it
  searchSeconds: 2.5,
  mp3Bitrate: '40k',     // MPEG-2 layer III at 24 kHz: its encoder low-pass is 8.4 kHz at 32k, 10.5 kHz at 40k, 11.3 kHz at 48k and above
});

// ---- WAV decoding / encoding -------------------------------------------------------------------------------------------------

/** Decodes a PCM (8/16/24/32-bit) or IEEE-float (32/64-bit) WAV into {rate, channels, samples: Float32Array[] per channel}. */
export function decodeWav(bytes) {
  if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') throw Error('not a WAV file');
  let at = 12, fmt = null, data = null;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('latin1', at, at + 4), length = bytes.readUInt32LE(at + 4), body = at + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      let tag = bytes.readUInt16LE(body);
      if (tag === 0xFFFE && length >= 26) tag = bytes.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE: the sub-format's first two bytes
      fmt = {tag, channels: bytes.readUInt16LE(body + 2), rate: bytes.readUInt32LE(body + 4), bits: bytes.readUInt16LE(body + 14)};
    } else if (id === 'data') {
      // A streamed file can claim 0 or 0xFFFFFFFF bytes: take what is there.
      const end = length === 0 || length === 0xFFFFFFFF ? bytes.length : Math.min(bytes.length, body + length);
      data = bytes.subarray(body, end);
      break;
    }
    at = body + length + (length & 1);
  }
  if (!fmt || !data) throw Error('WAV has no fmt or data chunk');
  const {tag, channels, rate, bits} = fmt;
  if (!channels || !rate) throw Error('bad WAV format');
  const width = bits / 8;
  if (!((tag === 1 && [8, 16, 24, 32].includes(bits)) || (tag === 3 && [32, 64].includes(bits)))) throw Error(`unsupported WAV format ${tag}/${bits}`);
  const frames = Math.floor(data.length / (width * channels));
  const out = Array.from({length: channels}, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const offset = (frame * channels + channel) * width;
      let value;
      if (tag === 3) value = bits === 32 ? data.readFloatLE(offset) : data.readDoubleLE(offset);
      else if (bits === 8) value = (data[offset] - 128) / 128;
      else if (bits === 16) value = data.readInt16LE(offset) / 32768;
      else if (bits === 24) value = data.readIntLE(offset, 3) / 8388608;
      else value = data.readInt32LE(offset) / 2147483648;
      out[channel][frame] = Number.isFinite(value) ? value : 0;
    }
  }
  return {rate, channels, samples: out};
}

/** A canonical 44-byte-header 16-bit mono PCM WAV from float samples (clamped). */
export function encodeWav16(samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const scaled = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
    data.writeInt16LE(scaled, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36, 'latin1'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ---- resampling --------------------------------------------------------------------------------------------------------------

/**
 * Windowed-sinc resampling (Kaiser window, 16 zero crossings each side, cutoff at 0.96 of the lower Nyquist, the kernel stretched by the rate ratio when going down so nothing folds
 * back when going down). Equal rates return the input unchanged.
 */
export function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = toRate / fromRate, cutoff = 0.96, half = 16;
  const scale = Math.max(1, 1 / ratio);             // the kernel stretches when downsampling
  const support = Math.ceil(half * scale);
  const beta = 8.6;                                  // Kaiser beta, about -90 dB sidelobes
  const bessel = x => { let sum = 1, term = 1; for (let k = 1; k < 30; k++) { term *= (x / (2 * k)) ** 2; sum += term; } return sum; };
  const norm = bessel(beta);
  const outLength = Math.floor(input.length * ratio);
  const out = new Float32Array(outLength);
  for (let n = 0; n < outLength; n++) {
    const center = n / ratio, first = Math.ceil(center - support), last = Math.floor(center + support);
    let sum = 0, weight = 0;
    for (let m = first; m <= last; m++) {
      const offset = (m - center) / scale;           // in output-rate zero crossings
      const r = offset / half;
      if (r <= -1 || r >= 1) continue;
      const x = offset * cutoff * Math.PI;
      const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(x) / x;
      const w = sinc * (bessel(beta * Math.sqrt(1 - r * r)) / norm);
      weight += w;
      if (m >= 0 && m < input.length) sum += w * input[m];
    }
    out[n] = weight ? sum / weight : 0;               // unity gain at DC, also at the clip's edges
  }
  return out;
}

// ---- prepareReference --------------------------------------------------------------------------------------------------------

/**
 * A smaller reference clip from a WAV (16/24/32-bit PCM or 32/64-bit float, any channel count and rate): mono, `targetRate`, cut to at
 * most `maxSeconds` at the quietest 20 ms window inside the last `searchSeconds` (so the cut falls in a pause, not in a word),
 * with a 5 ms fade-out, written as a canonical 44-byte-header 16-bit WAV. A clip already short enough is not cut. Pure: no files, no ffmpeg.
 * Returns {wav, seconds, sampleRate, samples, cutSeconds|null}.
 */
export function prepareReference(wavBuffer, {maxSeconds = 10, targetRate = 16000, searchSeconds = 2.5} = {}) {
  const {rate, channels, samples} = decodeWav(wavBuffer);
  const frames = samples[0].length;
  const mono = new Float32Array(frames);
  for (let channel = 0; channel < channels; channel++) for (let i = 0; i < frames; i++) mono[i] += samples[channel][i] / channels;
  let cutSeconds = null, end = frames;
  if (frames / rate > maxSeconds) {
    const window = Math.max(1, Math.round(rate * 0.02)), hi = Math.floor(maxSeconds * rate), lo = Math.max(0, hi - Math.round(searchSeconds * rate));
    // 20 ms windows every 10 ms, latest first. The cut goes at the LATEST window that is quiet (within 5 dB of the quietest one in
    // reach, or 25 dB under the clip's mean power), so the clip keeps as much speech as possible and still ends in a pause.
    const step = Math.max(1, window >> 1), energies = [];
    let total = 0;
    for (let i = 0; i < mono.length; i++) total += mono[i] * mono[i];
    for (let start = hi - window; start >= lo; start -= step) {
      let energy = 0;
      for (let i = start; i < start + window; i++) energy += mono[i] * mono[i];
      energies.push([start, energy]);
    }
    const quietest = Math.min(...energies.map(entry => entry[1]));
    const limit = Math.max(quietest * 3.2, (total / mono.length) * window * 0.003);
    const quiet = energies.find(entry => entry[1] <= limit) ?? [hi - window, 0];
    const best = quiet[0] + (window >> 1);
    end = Math.min(best, hi);
    cutSeconds = end / rate;
  }
  let out = resample(mono.subarray(0, end), rate, targetRate);
  if (cutSeconds !== null) {
    const fade = Math.min(out.length, Math.round(targetRate * 0.005));
    out = Float32Array.from(out);
    for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
  }
  return {wav: encodeWav16(out, targetRate), seconds: out.length / targetRate, sampleRate: targetRate, samples: out.length, cutSeconds};
}


// ---- MP3 (needs ffmpeg) ---------------------------------------------------------------------------------------------------------

let ffmpegProbe;
/** The ffmpeg command, or null: CYBERPUNK_CONVAI_FFMPEG, else "ffmpeg" when it runs. Found once per process. */
export function findFfmpeg({env = process.env, run = execFile} = {}) {
  ffmpegProbe ??= new Promise(resolve => {
    const command = env.CYBERPUNK_CONVAI_FFMPEG || 'ffmpeg';
    try {
      const child = run(command, ['-version'], {windowsHide: true, timeout: 5000}, error => resolve(error ? null : command));
      child?.on?.('error', () => resolve(null));
    } catch { resolve(null); }
  });
  return ffmpegProbe;
}
export function forgetFfmpeg() { ffmpegProbe = undefined; }

/** WAV bytes to mono MP3 bytes with ffmpeg (through a pipe, no temporary file), or null when ffmpeg is missing or fails. */
export function encodeMp3(wav, {ffmpeg, bitrate = REFERENCE_PREPARATION.mp3Bitrate, run = execFile, timeoutMs = 20000} = {}) {
  if (!ffmpeg) return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      const child = run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', bitrate, '-f', 'mp3', 'pipe:1'],
        {encoding: 'buffer', windowsHide: true, timeout: timeoutMs, maxBuffer: 8_000_000}, (error, stdout) => resolve(error || !stdout?.length ? null : Buffer.from(stdout)));
      child?.on?.('error', () => resolve(null));
      child?.stdin?.on?.('error', () => {});
      child?.stdin?.end(wav);
    } catch { resolve(null); }
  });
}

// ---- the preparer with its disk cache --------------------------------------------------------------------------------------------

const MP3_MAGIC = bytes => bytes.length > 3 && ((bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) || bytes.toString('latin1', 0, 3) === 'ID3');

/**
 * Returns async (bytes, {key, sha256}) => {bytes, format: 'mp3'|'wav', seconds, cached} for a reference clip, or null when the clip
 * cannot be decoded (the caller then sends it as it is). The result is kept in `cacheDirectory` as <key>.<format> next to a
 * <key>.json that names the source clip's hash and the settings; a changed clip or setting is prepared again. A cache that cannot
 * be read or written is ignored. `mp3`: encode with ffmpeg when it is there (default true). Concurrent calls for one key share one job.
 */
export function createReferencePreparer({cacheDirectory, settings = REFERENCE_PREPARATION, mp3 = true, ffmpeg = findFfmpeg, encode = encodeMp3,
  read = readFile, write = writeFile, makeDirectory = mkdir, move = rename, onLog = () => {}} = {}) {
  const jobs = new Map();
  const safe = key => typeof key === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(key);
  const signature = sha256 => createHash('sha256').update(JSON.stringify([sha256, settings.version, settings.maxSeconds, settings.targetRate, mp3 ? settings.mp3Bitrate : null])).digest('hex').slice(0, 24);
  async function fromCache(key, sig) {
    if (!cacheDirectory || !safe(key)) return null;
    try {
      const meta = JSON.parse(await read(join(cacheDirectory, key + '.json'), 'utf8'));
      if (meta?.signature !== sig || (meta.format !== 'mp3' && meta.format !== 'wav')) return null;
      const bytes = await read(join(cacheDirectory, key + '.' + meta.format));
      if (bytes.length !== meta.bytes || (meta.format === 'mp3' ? !MP3_MAGIC(bytes) : bytes.toString('latin1', 0, 4) !== 'RIFF')) return null;
      return {bytes, format: meta.format, seconds: meta.seconds, cached: true};
    } catch { return null; }
  }
  async function toCache(key, sig, made) {
    if (!cacheDirectory || !safe(key)) return;
    try {
      await makeDirectory(cacheDirectory, {recursive: true});
      const file = join(cacheDirectory, key + '.' + made.format), meta = join(cacheDirectory, key + '.json');
      await write(file + '.tmp', made.bytes); await move(file + '.tmp', file);
      await write(meta + '.tmp', JSON.stringify({signature: sig, format: made.format, bytes: made.bytes.length, seconds: made.seconds, written: new Date().toISOString()}));
      await move(meta + '.tmp', meta);
    } catch (error) { onLog(`reference cache not written (${error?.code ?? error?.message})`); }
  }
  async function build(bytes, key, sha256) {
    const sig = signature(sha256);
    const hit = await fromCache(key, sig);
    if (hit) return hit;
    let prepared;
    try { prepared = prepareReference(bytes, settings); } catch { return null; }
    let made = {bytes: prepared.wav, format: 'wav', seconds: prepared.seconds, cached: false};
    if (mp3) {
      const command = await ffmpeg();
      const encoded = command ? await encode(prepared.wav, {ffmpeg: command, bitrate: settings.mp3Bitrate}) : null;
      if (encoded && MP3_MAGIC(encoded) && encoded.length < prepared.wav.length) made = {bytes: encoded, format: 'mp3', seconds: prepared.seconds, cached: false};
    }
    await toCache(key, sig, made);
    return made;
  }
  return (bytes, {key, sha256 = createHash('sha256').update(bytes).digest('hex')} = {}) => {
    const id = key + ':' + sha256;
    if (!jobs.has(id)) jobs.set(id, build(bytes, key, sha256).finally(() => jobs.delete(id)));
    return jobs.get(id);
  };
}
