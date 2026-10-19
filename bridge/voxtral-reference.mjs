// A smaller Voxtral reference clip (docs/LATENCY_2026-10-12.md, docs/CLOUD_VOICE_VOXTRAL.md).
//
// Voxtral clones a voice from a reference clip that is sent with EVERY request (saved voices need a paid plan). The clips the mod
// keeps are 8 to 18 s of 24 kHz 16-bit WAV: 560 to 650 KB, 750 to 860 KB as base64 in the request. On a slow uplink that upload is
// most of the first-audio wait: the Mistral server answered after 1.37 s with the 857 KB body and after 0.57 s with an 89 KB one,
// the same text and the same voice (measured 2026-10-12, six real calls, scripts/Test-VoxtralReferenceSize.mjs).
//
// This module makes the reference small without a tool the player may not have:
//   prepareReference         mono, 24 kHz, cut to about 8.5 s in a pause (pure JavaScript): 408 KB as a WAV
//   encodeVorbis             mono Ogg Vorbis (quality 2) with ffmpeg, when the machine has it: about 38 KB; the API takes it
//   encodeMp3                mono MP3 with ffmpeg: the second choice (64 kbit/s, about 68 KB)
//   createReferencePreparer  the above behind a cache on disk, keyed by the source clip's hash, so the work is done once
// The result is reproducible: the same clip, the same ffmpeg and the same settings give the same bytes (bit-exact encoders, no clock
// or random serial in the file), and `prepare.signature` names the settings, so the release builder (packaging/build-release.mjs) makes
// the shipped copies with this same code (createReferencePreparer) and a player without ffmpeg reads them from the cache.
//
// THE CLONE REPRODUCES THE REFERENCE'S BANDWIDTH (measured 2026-10-13, scripts/Measure-VoxtralClarity.mjs): Voxtral itself speaks up
// to its 12 kHz Nyquist, but what it says has only the frequencies its reference had. Versions 1 and 2 of this file sent 16 kHz audio
// (nothing above 8 kHz) as a 32 kbit/s MP3 whose encoder low-pass sits at 7.3 kHz: every answer then had nothing above 7.5 kHz (the 8
// to 12 kHz bands were 55 dB under the 0 to 4 kHz level, against 22 to 24 dB for the original clip's answers), which is what sounded
// muffled. Version 3 (24 kHz MP3, 40 kbit/s) reached 10.5 kHz and still sounded dull to the user: MP3 encoders low-pass at 10.5 kHz
// (40k) to 11.3 kHz (48k and up, whatever `-cutoff` says) and the 10 to 12 kHz band was 10 dB under the original's.
// Version 4 sends Ogg Vorbis (quality 2): full band to 12 kHz, 8 to 12 kHz bands within about 1 dB of the whole clip's answers, 38 KB.
// The API's error text says "valid mp3 or wav", but it also decodes Ogg (Vorbis and Opus) and FLAC; it refuses M4A/AAC. Should it ever
// refuse the Ogg reference too, the voice notes it and the references are prepared as MP3 from then on (VoxtralVoice, `safeFormat`).
// The sample rate matters more than the bitrate: 16 kHz at 64 kbit/s or as a WAV is just as dull.
//
// Clone similarity (ECAPA speaker embedding against the original reference's) was the same within the call-to-call spread of
// Voxtral itself (0.50 and 0.65 for the full clip, 0.58 and 0.57 for the cut 16 kHz clip, 0.58 and 0.51 for the cut MP3).
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// The folders of <references> that hold prepared slots. The bridge keeps its own cache in PREPARED_FOLDER and the OmniVoice pack ships its
// slots there (the clips it adds). The Runtime ships its slots (the Pocket clips) in RUNTIME_PREPARED_FOLDER, which only the Runtime writes
// and the bridge never does: a pack's slot for the same voice would otherwise be a different file at the same path, and Windows would ask
// whether to replace it (docs/PACKAGING.md, "Packs reused unchanged"). A slot is found by its signature, so the answer is the same
// whichever folder holds it.
export const PREPARED_FOLDER = 'prepared';
export const RUNTIME_PREPARED_FOLDER = 'prepared-runtime';

export const REFERENCE_PREPARATION = Object.freeze({
  version: 4,            // 4: Ogg Vorbis q2 (a full-band 24 kHz clip; MP3 stops at 10.5 to 11.3 kHz and sounded dull). 3: 24 kHz MP3 40k. 2: 32 kbit/s, not 64
  maxSeconds: 8.5,       // the clip is cut at the quietest moment inside its last 2.5 s before this
  targetRate: 24000,     // the rate of the stored clips and of Voxtral's own output; a source at another rate is resampled to it
  searchSeconds: 2.5,
  codec: 'vorbis',       // the first choice with ffmpeg: 'vorbis' (Ogg), else 'mp3', else the WAV
  vorbisQuality: 2,      // libvorbis -q:a 2: 38 KB for 8.5 s at 24 kHz, bandwidth 12 kHz (q1: 33 KB, 11.9 kHz; q0 stops at 10.6 kHz)
  mp3Bitrate: '64k',     // the second choice: MPEG-2 layer III at 24 kHz, low-pass 11.3 kHz at 48k and above (40k: 10.5 kHz, 32k: 8.4 kHz)
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

function runFfmpeg(wav, ffmpeg, codecArgs, format, {run = execFile, timeoutMs = 20000} = {}) {
  if (!ffmpeg) return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      // bitexact: no encoder version tag, no random Ogg stream serial: the same input gives the same bytes.
      const child = run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-ac', '1', ...codecArgs, '-fflags', '+bitexact', '-flags:a', '+bitexact', '-f', format, 'pipe:1'],
        {encoding: 'buffer', windowsHide: true, timeout: timeoutMs, maxBuffer: 8_000_000}, (error, stdout) => resolve(error || !stdout?.length ? null : Buffer.from(stdout)));
      child?.on?.('error', () => resolve(null));
      child?.stdin?.on?.('error', () => {});
      child?.stdin?.end(wav);
    } catch { resolve(null); }
  });
}

/** WAV bytes to mono MP3 bytes with ffmpeg (through a pipe, no temporary file), or null when ffmpeg is missing or fails. */
export function encodeMp3(wav, {ffmpeg, bitrate = REFERENCE_PREPARATION.mp3Bitrate, run, timeoutMs} = {}) {
  return runFfmpeg(wav, ffmpeg, ['-codec:a', 'libmp3lame', '-b:a', bitrate], 'mp3', {run, timeoutMs});
}

/** WAV bytes to mono Ogg Vorbis bytes with ffmpeg (libvorbis, variable bitrate by quality), or null when ffmpeg or libvorbis is missing. */
export function encodeVorbis(wav, {ffmpeg, quality = REFERENCE_PREPARATION.vorbisQuality, run, timeoutMs} = {}) {
  return runFfmpeg(wav, ffmpeg, ['-codec:a', 'libvorbis', '-q:a', String(quality)], 'ogg', {run, timeoutMs});
}

/** The compressed form `codec` ('vorbis' or 'mp3') of a WAV, with the settings' quality or bitrate (`options` override them). */
export function encodeReference(wav, {codec = REFERENCE_PREPARATION.codec, ffmpeg, bitrate, quality, run, timeoutMs} = {}) {
  return codec === 'vorbis' ? encodeVorbis(wav, {ffmpeg, quality, run, timeoutMs}) : encodeMp3(wav, {ffmpeg, bitrate, run, timeoutMs});
}

// ---- the preparer with its disk cache --------------------------------------------------------------------------------------------

const MP3_MAGIC = bytes => bytes.length > 3 && ((bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) || bytes.toString('latin1', 0, 3) === 'ID3');
const MAGIC = {mp3: MP3_MAGIC, ogg: bytes => bytes.length > 4 && bytes.toString('latin1', 0, 4) === 'OggS', wav: bytes => bytes.toString('latin1', 0, 4) === 'RIFF'};
const FORMAT_OF = {vorbis: 'ogg', mp3: 'mp3'};

/**
 * Returns async (bytes, {key, sha256, safeFormat}) => {bytes, format: 'ogg'|'mp3'|'wav', seconds, cached} for a reference clip, or null
 * when the clip cannot be decoded (the caller then sends it as it is). The result is kept in `cacheDirectory` as <key>.<format> next to
 * a <key>.json that names the source clip's hash and the settings; a changed clip or setting is prepared again. A cache that cannot
 * be read or written is ignored. `shippedDirectories`: more folders slots are read from when `cacheDirectory` has none that matches, or only one in
 * a worse format (the Runtime's own, RUNTIME_PREPARED_FOLDER); nothing is ever written to them. `compress`: encode with ffmpeg when it is there (default true): the settings' codec first, then MP3,
 * then the WAV. `safeFormat` (per call): skip Ogg and use MP3 (the server refused an Ogg reference). Concurrent calls for one key
 * share one job. `.signature(sha256, {safeFormat})` is the cache signature a clip's slot carries (the release builder compares it).
 */
export function createReferencePreparer({cacheDirectory, shippedDirectories = [], settings = REFERENCE_PREPARATION, compress = true, mp3, ffmpeg = findFfmpeg, encode = encodeReference,
  read = readFile, write = writeFile, makeDirectory = mkdir, move = rename, onLog = () => {}} = {}) {
  if (mp3 === false) compress = false;                    // the name of version 3's option
  const jobs = new Map();
  const safe = key => typeof key === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(key);
  // The codecs tried, in order, for this call.
  const ladder = safeFormat => !compress ? [] : settings.codec === 'vorbis' && !safeFormat ? ['vorbis', 'mp3'] : ['mp3'];
  const signature = (sha256, {safeFormat = false} = {}) => createHash('sha256').update(JSON.stringify(
    [sha256, settings.version, settings.maxSeconds, settings.targetRate, ladder(safeFormat).map(codec => codec === 'vorbis' ? ['vorbis', settings.vorbisQuality] : ['mp3', settings.mp3Bitrate])])).digest('hex').slice(0, 24);
  async function fromFolder(directory, key, sig) {
    try {
      const meta = JSON.parse(await read(join(directory, key + '.json'), 'utf8'));
      if (meta?.signature !== sig || !MAGIC[meta.format]) return null;
      const bytes = await read(join(directory, key + '.' + meta.format));
      if (bytes.length !== meta.bytes || !MAGIC[meta.format](bytes)) return null;
      return {bytes, format: meta.format, seconds: meta.seconds, cached: true};
    } catch { return null; }
  }
  // A slot that fits (the signature names the clip and the settings) is the same reference in any folder, except for its format: the cache
  // folder can hold a WAV (or an MP3) that this machine made without ffmpeg (or without libvorbis) for a clip the Runtime ships as Ogg. Until
  // 0.2.1 the Runtime's slots shared that folder, so extracting a new Runtime replaced such a slot; now they are in their own folder, read
  // second, and nothing deletes it. So the first slot in the ladder's first format wins, else the best format found: the 38 KB Ogg, not the 408 KB WAV.
  const rank = (format, safeFormat) => {
    const order = [...ladder(safeFormat).map(codec => FORMAT_OF[codec]), 'wav'], at = order.indexOf(format);
    return at < 0 ? order.length : at;
  };
  async function fromCache(key, sig, safeFormat) {
    if (!safe(key)) return null;
    let best = null;
    for (const directory of [cacheDirectory, ...shippedDirectories]) {
      if (!directory) continue;
      const hit = await fromFolder(directory, key, sig);
      if (hit && (!best || rank(hit.format, safeFormat) < rank(best.format, safeFormat))) best = hit;
      if (best && rank(best.format, safeFormat) === 0) break;
    }
    return best;
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
  async function build(bytes, key, sha256, safeFormat) {
    const sig = signature(sha256, {safeFormat});
    const hit = await fromCache(key, sig, safeFormat);
    if (hit) return hit;
    let prepared;
    try { prepared = prepareReference(bytes, settings); } catch { return null; }
    let made = {bytes: prepared.wav, format: 'wav', seconds: prepared.seconds, cached: false};
    const codecs = ladder(safeFormat);
    const command = codecs.length ? await ffmpeg() : null;
    for (const codec of command ? codecs : []) {
      const encoded = await encode(prepared.wav, {codec, ffmpeg: command, bitrate: settings.mp3Bitrate, quality: settings.vorbisQuality});
      const format = FORMAT_OF[codec];
      if (encoded && MAGIC[format](encoded) && encoded.length < prepared.wav.length) { made = {bytes: encoded, format, seconds: prepared.seconds, cached: false}; break; }
      onLog(`${codec} encoding of the reference failed or was not smaller${codecs.length > 1 && codec === codecs[0] ? '; trying ' + codecs[1] : ''}`);
    }
    await toCache(key, sig, made);
    return made;
  }
  const prepare = (bytes, {key, sha256 = createHash('sha256').update(bytes).digest('hex'), safeFormat = false} = {}) => {
    const id = key + ':' + sha256 + ':' + (safeFormat ? 's' : '');
    if (!jobs.has(id)) jobs.set(id, build(bytes, key, sha256, safeFormat).finally(() => jobs.delete(id)));
    return jobs.get(id);
  };
  prepare.signature = signature;
  return prepare;
}
