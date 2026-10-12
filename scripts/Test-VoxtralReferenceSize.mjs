// Does a smaller Voxtral reference clip keep the clone quality, and how much first-audio time does a smaller upload save?
//
//   node scripts/Test-VoxtralReferenceSize.mjs selftest <outDir>          offline: prepareReference vs ffmpeg (no API call)
//   node scripts/Test-VoxtralReferenceSize.mjs prep <reference.wav> <outDir> [cutSeconds]
//                                                                         writes the reference variants with ffmpeg
//   node scripts/Test-VoxtralReferenceSize.mjs call <variant> <outDir> <character>
//                                                                         ONE real Voxtral call with ref-<variant> from outDir
//
// `prepareReference` is the part meant for the shipped bridge: it needs no ffmpeg. The key is read in memory from one line of the
// keys file and only ever goes in the Authorization header; it is not printed, logged or written anywhere.
import {readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';

import {decodeWav, encodeWav16, resample, prepareReference} from '../bridge/voxtral-reference.mjs';
export {decodeWav, encodeWav16, resample, prepareReference};

// ---- helpers -----------------------------------------------------------------------------------------------------------------

const FFMPEG = 'C:\\ffmpeg\\bin\\ffmpeg.exe', FFPROBE = 'C:\\ffmpeg\\bin\\ffprobe.exe';
const ffmpeg = args => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', ...args], {stdio: 'pipe'});
export const TEST_SENTENCE = 'Hey choom, you look wrecked. Come on, I know a quiet place with decent noodles.';
const rms = a => { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / Math.max(1, a.length)); };

function probe(path) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_sample,duration', '-of', 'json', path]).toString();
  return JSON.parse(out).streams[0];
}

// ---- selftest: prepareReference against ffmpeg -------------------------------------------------------------------------------

function selftest(outDir) {
  mkdirSync(outDir, {recursive: true});
  const source = resolve(outDir, 'ref-A-original.wav');
  const bytes = readFileSync(source);
  const rows = [];
  for (const [maxSeconds, targetRate] of [[8.3, 16000], [8.3, 24000], [60, 16000]]) {
    const t0 = performance.now();
    const made = prepareReference(bytes, {maxSeconds, targetRate});
    const ms = performance.now() - t0;
    const duration = made.cutSeconds ?? made.samples / targetRate;
    const reference = resolve(outDir, `selftest-ffmpeg-${maxSeconds}s-${targetRate}.wav`);
    // ffmpeg: the same cut point, same rate, mono, 16-bit.
    ffmpeg(['-i', source, ...(made.cutSeconds === null ? [] : ['-t', String(duration)]), '-ac', '1', '-ar', String(targetRate), '-c:a', 'pcm_s16le', reference]);
    writeFileSync(resolve(outDir, `selftest-prepare-${maxSeconds}s-${targetRate}.wav`), made.wav);
    const a = decodeWav(made.wav).samples[0], b = decodeWav(readFileSync(reference)).samples[0];
    const n = Math.min(a.length, b.length), trim = Math.round(targetRate * 0.01); // ignore the 10 ms at both ends (resampler edges, fade)
    let diff = 0, count = 0;
    for (let i = trim; i < n - trim; i++) { const d = a[i] - b[i]; diff += d * d; count++; }
    const diffRms = Math.sqrt(diff / count);
    rows.push({maxSeconds, targetRate, cutSeconds: made.cutSeconds, ours: a.length, ffmpeg: b.length, rmsOurs: +rms(a).toFixed(5), rmsFfmpeg: +rms(b).toFixed(5),
      diffRms: +diffRms.toFixed(6), diffDbRelative: +(20 * Math.log10(diffRms / rms(b))).toFixed(1), bytes: made.wav.length, prepareMs: Math.round(ms)});
  }
  // A 32-bit float, stereo, 48 kHz input must come out as the same mono clip.
  const decoded = decodeWav(bytes);
  const frames = Math.round(decoded.samples[0].length * 2);
  const up = resample(decoded.samples[0], 24000, 48000);
  const floatWav = Buffer.alloc(44 + up.length * 8);
  floatWav.write('RIFF', 0, 'latin1'); floatWav.writeUInt32LE(36 + up.length * 8, 4); floatWav.write('WAVEfmt ', 8, 'latin1');
  floatWav.writeUInt32LE(16, 16); floatWav.writeUInt16LE(3, 20); floatWav.writeUInt16LE(2, 22); floatWav.writeUInt32LE(48000, 24);
  floatWav.writeUInt32LE(48000 * 8, 28); floatWav.writeUInt16LE(8, 32); floatWav.writeUInt16LE(32, 34); floatWav.write('data', 36, 'latin1'); floatWav.writeUInt32LE(up.length * 8, 40);
  for (let i = 0; i < up.length; i++) { floatWav.writeFloatLE(up[i], 44 + i * 8); floatWav.writeFloatLE(up[i], 48 + i * 8); }
  const viaFloat = prepareReference(floatWav, {maxSeconds: 8.3, targetRate: 16000}), direct = prepareReference(bytes, {maxSeconds: 8.3, targetRate: 16000});
  const x = decodeWav(viaFloat.wav).samples[0], y = decodeWav(direct.wav).samples[0];
  let d2 = 0; const m = Math.min(x.length, y.length);
  for (let i = 160; i < m - 160; i++) d2 += (x[i] - y[i]) ** 2;
  rows.push({case: 'float32 stereo 48 kHz input vs 16-bit 24 kHz input (both to 16 kHz, 8.3 s)', lengths: [x.length, y.length], cutSeconds: [viaFloat.cutSeconds, direct.cutSeconds],
    diffDbRelative: +(20 * Math.log10(Math.sqrt(d2 / (m - 320)) / rms(y))).toFixed(1)});
  void frames;
  console.log(JSON.stringify(rows, null, 1));
  writeFileSync(resolve(outDir, 'selftest-results.json'), JSON.stringify(rows, null, 1));
}

// ---- prep: the variants with ffmpeg ------------------------------------------------------------------------------------------

function prep(reference, outDir, cut) {
  mkdirSync(outDir, {recursive: true});
  const out = name => resolve(outDir, `ref-${name}`);
  writeFileSync(out('A-original.wav'), readFileSync(reference));
  const cutArgs = ['-t', String(cut)];
  ffmpeg(['-i', reference, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out('B-16k-mono.wav')]);
  ffmpeg(['-i', reference, ...cutArgs, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', out('D-cut-24k-mono.wav')]);
  ffmpeg(['-i', reference, ...cutArgs, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out('E-cut-16k-mono.wav')]);
  ffmpeg(['-i', reference, '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '64k', out('F-mp3-64k.mp3')]);
  ffmpeg(['-i', reference, ...cutArgs, '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '64k', out('G-cut-mp3-64k.mp3')]);
  // The in-process one, for the same job as E.
  const made = prepareReference(readFileSync(reference), {maxSeconds: cut, targetRate: 16000});
  writeFileSync(out('P-prepareReference-16k.wav'), made.wav);
  const rows = ['A-original.wav', 'B-16k-mono.wav', 'D-cut-24k-mono.wav', 'E-cut-16k-mono.wav', 'F-mp3-64k.mp3', 'G-cut-mp3-64k.mp3', 'P-prepareReference-16k.wav'].map(name => {
    const bytes = readFileSync(out(name)).length, info = probe(out(name));
    return {name, codec: info.codec_name, rate: +info.sample_rate, channels: info.channels, bits: info.bits_per_sample, seconds: +(+info.duration).toFixed(2), rawBytes: bytes, base64Bytes: Math.ceil(bytes / 3) * 4};
  });
  console.log(JSON.stringify(rows, null, 1));
  writeFileSync(resolve(outDir, 'variants.json'), JSON.stringify(rows, null, 1));
}

// ---- call: one real Voxtral request ------------------------------------------------------------------------------------------

function readMistralKey() {
  // Only line 14 is read, in memory. The key is the long alphanumeric token on it; it is never printed.
  const line = readFileSync('C:\\Users\\akshi\\Desktop\\Code Palace\\Commonly used Keys.txt', 'utf8').split(/\r?\n/)[13] ?? '';
  if (!/mistral/i.test(line)) throw Error('line 14 is not labelled mistral');
  const key = (line.match(/[A-Za-z0-9]{28,}/g) ?? [])[0];
  if (!key) throw Error('no key found on line 14');
  return key;
}

async function* sse(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, {stream: true});
    let at;
    while ((at = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, at); buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (data) yield data;
    }
  }
}

async function call(variant, outDir, character) {
  const key = readMistralKey();
  const redact = text => String(text).split(key).join('[key]').replace(/\b[A-Za-z0-9]{28,}\b/g, '[key]');
  const file = ['wav', 'mp3', 'ogg', 'opus'].map(ext => readdirNames(outDir).find(n => n === `ref-${variant}.${ext}`)).find(Boolean);
  if (!file) throw Error(`no reference file for ${variant}`);
  const bytes = readFileSync(resolve(outDir, file));
  const bodyText = JSON.stringify({model: 'voxtral-mini-tts-latest', input: TEST_SENTENCE, ref_audio: bytes.toString('base64'), response_format: 'pcm', stream: true});
  // Warm the connection (TLS) with a plain GET, so the timing is a warm request like the bridge's. Not a speech call.
  await fetch('https://api.mistral.ai/v1/models', {headers: {authorization: `Bearer ${key}`}}).then(r => r.arrayBuffer()).catch(() => {});
  const result = {variant, file, referenceBytes: bytes.length, base64Bytes: Buffer.byteLength(bytes.toString('base64')), uploadBytes: Buffer.byteLength(bodyText), sentence: TEST_SENTENCE, at: new Date().toISOString()};
  const chunks = [];
  const t0 = performance.now();
  try {
    const response = await fetch('https://api.mistral.ai/v1/audio/speech', {method: 'POST', headers: {authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream'}, body: bodyText});
    result.headersMs = Math.round(performance.now() - t0); result.status = response.status;
    if (!response.ok) { result.error = redact(await response.text().catch(() => '')).slice(0, 400); }
    else {
      for await (const raw of sse(response.body)) {
        let event; try { event = JSON.parse(raw); } catch { continue; }
        if (event.type === 'speech.audio.delta' && typeof event.audio_data === 'string') {
          result.firstAudioMs ??= Math.round(performance.now() - t0);
          chunks.push(Buffer.from(event.audio_data, 'base64'));
        } else if (event.type === 'speech.audio.done') { result.totalMs = Math.round(performance.now() - t0); break; }
      }
      result.totalMs ??= Math.round(performance.now() - t0);
    }
  } catch (error) { result.error = redact(error?.message ?? error); result.totalMs = Math.round(performance.now() - t0); }
  const pcm = Buffer.concat(chunks), floats = new Float32Array(pcm.length >> 2);
  for (let i = 0; i < floats.length; i++) floats[i] = pcm.readFloatLE(i * 4);
  result.outputSeconds = +(floats.length / 24000).toFixed(2);
  if (floats.length) {
    const name = `${character}-${variant}.wav`;
    writeFileSync(resolve(outDir, name), encodeWav16(floats, 24000));
    result.output = name; result.outputRms = +rms(floats).toFixed(4);
  }
  appendFileSync(resolve(outDir, 'calls.jsonl'), JSON.stringify(result) + '\n');
  console.log(JSON.stringify(result, null, 1));
}

import {readdirSync} from 'node:fs';
const readdirNames = dir => readdirSync(dir);

// ---- main --------------------------------------------------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, a, b, c] = process.argv.slice(2);
  if (command === 'selftest') selftest(resolve(a));
  else if (command === 'prep') prep(resolve(a), resolve(b), Number(c ?? 8.28));
  else if (command === 'call') await call(a, resolve(b), c);
  else console.log('usage: selftest <outDir> | prep <reference.wav> <outDir> [cutSeconds] | call <variantPrefix> <outDir> <character>');
}
void existsSync; void join;
