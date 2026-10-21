// V's reference clip from a voice mod's own lines (prototype, docs/V_VOICE_MODS.md): the lines of the shipped English recipe (assets/v-voice/
// v-mod-lines.json: the three clips of v-male.wav / v-female.wav, then spare lines) are read from the mod's archive, decoded, and cut and joined the
// way scripts/clip-search/v-voice/build_reference.py makes the English clip:
//   - the left channel only when the two channels are decorrelated, else their mean (Wwise voice-over decodes as mono, so in practice the clip as is);
//   - polyphase resampling to 24 kHz (the same filter as scipy.signal.resample_poly: Kaiser window, beta 5, 10 zero crossings per side at the lower rate);
//   - leading and trailing silence below -45 dBFS (10 ms frames) trimmed with 80 ms of margin;
//   - 0.4 s of silence between clips, 16-bit PCM, no EQ, no denoise and no gain;
//   - the clips of one set must lie within 2 dB of each other in gated loudness (the English build's rule), the whole between 8 and 20 s.
// The one decoder is vgmstream-cli (Wwise Vorbis cannot be read by ffmpeg, soundfile or PyAV): `decode(wemBytes) -> wav bytes` is injected so a test
// needs none and a player's PC only needs the 8 MB command-line tool.
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {depotHash, openArchive} from './rdar.mjs';
import {readPcmWav} from './speech-audio.mjs';
import {encodeWav16} from './voxtral-reference.mjs';

export const REFERENCE_RECIPE = Object.freeze({rate: 24000, gapSeconds: 0.4, marginSeconds: 0.08, silenceDb: -45, minSeconds: 8, targetSeconds: 11, maxSeconds: 20, maxSpreadDb: 2, maxLines: 8});

// ---- DSP ----------------------------------------------------------------------------------------------------------------------------------

const gcd = (a, b) => b ? gcd(b, a % b) : a;
const bessel0 = x => { let sum = 1, term = 1; for (let k = 1; k < 60; k++) { term *= (x / (2 * k)) ** 2; sum += term; if (term < sum * 1e-17) break; } return sum; };

/**
 * resample_poly(x, up, down) as scipy does it: a Kaiser(5) low-pass FIR of 2 * 10 * max(up, down) + 1 taps, cutoff 1 / max(up, down), gain `up`,
 * the filter delay removed, output length ceil(n * up / down).
 */
export function resamplePoly(input, fromRate, toRate) {
  if (fromRate === toRate) return Float32Array.from(input);
  const divisor = gcd(fromRate, toRate), up = toRate / divisor, down = fromRate / divisor, max = Math.max(up, down);
  const half = 10 * max, taps = 2 * half + 1, cutoff = 1 / max, beta = 5, norm = bessel0(beta);
  const h = new Float64Array(taps);
  let sum = 0;
  for (let k = 0; k < taps; k++) {
    const n = k - half, x = Math.PI * cutoff * n, sinc = n === 0 ? 1 : Math.sin(x) / x;
    const ratio = (2 * k) / (taps - 1) - 1;
    h[k] = cutoff * sinc * bessel0(beta * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / norm;
    sum += h[k];
  }
  for (let k = 0; k < taps; k++) h[k] *= up / sum;
  const outLength = Math.ceil(input.length * up / down), out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const centre = i * down + half;                    // position in the zero-stuffed signal that lines up with output sample i
    let acc = 0;
    // taps whose zero-stuffed position (centre - k) is a multiple of `up` land on an input sample
    const first = ((centre % up) + up) % up;
    for (let k = first; k < taps; k += up) {
      const at = (centre - k) / up;
      if (at >= 0 && at < input.length) acc += h[k] * input[at];
    }
    out[i] = acc;
  }
  return out;
}

/** The mono signal of a decoded WAV (the left channel when the channels are decorrelated, else the mean), floats in -1..1, and its rate. */
export function monoOf(wavBytes) {
  const wav = readPcmWav(wavBytes), {data, channels, bits, codec, align, sampleRate} = wav, frames = data.length / align;
  const sample = (frame, channel) => {
    const offset = frame * align + channel * (bits / 8);
    if (codec === 3) return data.readFloatLE(offset);
    return bits === 16 ? data.readInt16LE(offset) / 32768 : bits === 24 ? data.readIntLE(offset, 3) / 8388608 : data.readInt32LE(offset) / 2147483648;
  };
  const out = new Float32Array(frames);
  if (channels === 1) { for (let i = 0; i < frames; i++) out[i] = sample(i, 0); return {samples: out, rate: sampleRate}; }
  let left = 0, mean = 0;
  for (let i = 0; i < frames; i++) { const l = sample(i, 0), r = sample(i, 1); left += l * l; mean += ((l + r) / 2) ** 2; }
  const useMean = Math.sqrt(mean / frames) / (Math.sqrt(left / frames) || 1e-9) >= 0.9;
  for (let i = 0; i < frames; i++) out[i] = useMean ? (sample(i, 0) + sample(i, 1)) / 2 : sample(i, 0);
  return {samples: out, rate: sampleRate};
}

const dbOf = value => 20 * Math.log10(value);
/** Frame RMS in dBFS for 10 ms frames (240 samples at 24 kHz). */
function frameDb(samples, frame = 240) {
  const count = Math.floor(samples.length / frame), out = new Float64Array(count);
  for (let f = 0; f < count; f++) { let sum = 0; for (let i = f * frame; i < (f + 1) * frame; i++) sum += samples[i] * samples[i]; out[f] = dbOf(Math.sqrt(sum / frame) + 1e-9); }
  return out;
}

/** Leading and trailing silence (frames below the threshold) cut away, keeping a margin; a clip with no speech is returned as it is. */
export function trimSilence(samples, {rate = REFERENCE_RECIPE.rate, threshold = REFERENCE_RECIPE.silenceDb, margin = REFERENCE_RECIPE.marginSeconds} = {}) {
  const frame = Math.round(rate / 100), levels = frameDb(samples, frame);
  let first = -1, last = -1;
  for (let f = 0; f < levels.length; f++) if (levels[f] > threshold) { if (first < 0) first = f; last = f; }
  if (first < 0) return samples;
  const from = Math.max(0, first * frame - Math.round(margin * rate)), to = Math.min(samples.length, (last + 1) * frame + Math.round(margin * rate));
  return samples.slice(from, to);
}

/** Loudness of the speaking parts: the RMS (dBFS) of the 10 ms frames above the silence threshold. null when nothing speaks. */
export function gatedRmsDb(samples, {threshold = REFERENCE_RECIPE.silenceDb} = {}) {
  const frame = 240, loud = [];
  for (let f = 0; f < Math.floor(samples.length / frame); f++) {
    let sum = 0; for (let i = f * frame; i < (f + 1) * frame; i++) sum += samples[i] * samples[i];
    if (dbOf(Math.sqrt(sum / frame) + 1e-9) > threshold) loud.push(sum / frame);
  }
  return loud.length ? dbOf(Math.sqrt(loud.reduce((a, b) => a + b, 0) / loud.length)) : null;
}

/** One decoded line as the reference uses it: mono, 24 kHz, trimmed. */
export function prepareClip(wavBytes) {
  const {samples, rate} = monoOf(wavBytes);
  const clip = trimSilence(resamplePoly(samples, rate, REFERENCE_RECIPE.rate));
  return {samples: clip, seconds: clip.length / REFERENCE_RECIPE.rate, gatedRmsDb: gatedRmsDb(clip), peak: clip.reduce((m, v) => Math.max(m, Math.abs(v)), 0)};
}

/** Clips joined with the recipe's gap. */
export function joinClips(clips, {rate = REFERENCE_RECIPE.rate, gap = REFERENCE_RECIPE.gapSeconds} = {}) {
  const gapSamples = Math.round(gap * rate), total = clips.reduce((sum, clip) => sum + clip.length, 0) + gapSamples * Math.max(0, clips.length - 1);
  const out = new Float32Array(total);
  let at = 0;
  clips.forEach((clip, index) => { out.set(clip, at); at += clip.length + (index < clips.length - 1 ? gapSamples : 0); });
  return out;
}

/**
 * Chooses the clips of a reference from the decoded candidates (in the order of the line list: the English picks first): the loudness of the set must
 * stay within `maxSpreadDb`, the total between minSeconds and maxSeconds; clips are added in order until the target length, a clip that would break the
 * spread is skipped (a spare line takes its place). Returns the chosen candidates' indexes, or [] when no set fits.
 */
export function chooseClips(candidates, {minSeconds, targetSeconds, maxSeconds, maxSpreadDb, gap = REFERENCE_RECIPE.gapSeconds} = REFERENCE_RECIPE) {
  const chosen = [];
  let total = 0;
  const fits = index => {
    const db = candidates[index].gatedRmsDb;
    if (db === null) return false;
    return chosen.every(other => Math.abs(candidates[other].gatedRmsDb - db) <= maxSpreadDb);
  };
  for (let index = 0; index < candidates.length && total < targetSeconds; index++) {
    const add = candidates[index].seconds + (chosen.length ? gap : 0);
    if (total + add > maxSeconds || !fits(index)) continue;
    chosen.push(index); total += add;
  }
  return total >= minSeconds ? chosen : [];
}

// ---- decoding -----------------------------------------------------------------------------------------------------------------------------

/** The decoder of a vgmstream-cli.exe: `decode(wemBytes)` -> the WAV bytes. Files go through a private temporary folder, never next to the archive. */
export function vgmstreamDecoder(executable, {timeoutMs = 30_000, run = execFile} = {}) {
  return async wem => {
    const folder = await mkdtemp(join(tmpdir(), 'ainpc-vmod-'));
    try {
      const input = join(folder, 'line.wem'), output = join(folder, 'line.wav');
      await writeFile(input, wem);
      await new Promise((resolve, reject) => run(executable, ['-o', output, input], {timeout: timeoutMs, windowsHide: true, shell: false}, error => error ? reject(error) : resolve()));
      return await readFile(output);
    } finally { await rm(folder, {recursive: true, force: true}).catch(() => {}); }
  };
}

/**
 * Builds V's reference from one archive. `lines`: the gender's rows of v-mod-lines.json ({path, stringId, transcript}). Lines the archive does not
 * hold are skipped. Resolves to {wav (bytes), entry (the v-voice.json row: file, transcript, sha256, seconds, sampleRate, clips), report} or rejects
 * with an Error whose `code` says why ('no-lines', 'no-set', 'decoder').
 */
export async function buildModReference({archive, lines, decode, recipe = REFERENCE_RECIPE, file = 'v-voice.wav'}) {
  const opened = typeof archive === 'string' ? await openArchive(archive) : archive;
  try {
    const hashed = lines.map(line => ({line, hex: depotHash(line.path)})), held = opened.scan(hashed.map(({hex}) => hex));
    const present = hashed.filter(({hex}) => held.has(hex)).slice(0, recipe.maxLines);
    if (!present.length) throw Object.assign(Error('the archive holds none of the lines'), {code: 'no-lines'});
    const candidates = [], usable = [];
    let picked = [];
    // Lines are decoded in the recipe's order and only until the set reaches its target length (normally the three English picks: about 11 s).
    for (const {line, hex} of present) {
      let wem;
      try { wem = await opened.read(hex); } catch (error) { candidates.push({line, skipped: error.code ?? 'unreadable'}); continue; }
      let wav;
      try { wav = await decode(wem); } catch (error) { throw Object.assign(Error(`the decoder failed: ${String(error?.message ?? error).slice(0, 120)}`), {code: 'decoder'}); }
      const candidate = {line, ...prepareClip(wav)};
      candidates.push(candidate);
      if (candidate.gatedRmsDb === null) continue;
      usable.push(candidate);
      picked = chooseClips(usable, recipe);
      const total = picked.reduce((sum, index) => sum + usable[index].seconds, 0) + recipe.gapSeconds * Math.max(0, picked.length - 1);
      if (picked.length && total >= recipe.targetSeconds) break;
    }
    if (!picked.length) throw Object.assign(Error('no set of the lines in the mod fits the reference recipe'), {code: 'no-set'});
    const clips = picked.map(index => usable[index]);
    const samples = joinClips(clips.map(clip => clip.samples), {rate: recipe.rate, gap: recipe.gapSeconds});
    const wav = encodeWav16(samples, recipe.rate);
    const seconds = Math.round(samples.length / recipe.rate * 1000) / 1000;
    const levels = clips.map(clip => clip.gatedRmsDb);
    return {
      wav,
      entry: {file, transcript: clips.map(clip => clip.line.transcript).join(' '), sha256: createHash('sha256').update(wav).digest('hex'), seconds, sampleRate: recipe.rate,
        clips: clips.map(clip => ({stringId: clip.line.stringId, seconds: Math.round(clip.seconds * 1000) / 1000}))},
      report: {candidates: candidates.map(c => ({stringId: c.line.stringId, seconds: c.seconds === undefined ? null : Math.round(c.seconds * 100) / 100, gatedRmsDb: c.gatedRmsDb === undefined || c.gatedRmsDb === null ? null : Math.round(c.gatedRmsDb * 10) / 10, skipped: c.skipped ?? null})),
        spreadDb: Math.round((Math.max(...levels) - Math.min(...levels)) * 100) / 100, peak: Math.max(...clips.map(c => c.peak))},
    };
  } finally { if (typeof archive === 'string') await opened.close().catch(() => {}); }
}
