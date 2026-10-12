// What does our own audio path do to a Voxtral answer? Offline: nothing is played (docs/CLOUD_VOICE_VOXTRAL.md, "Why it can sound muffled").
//
//   node scripts/Measure-VoxtralPipeline.mjs <raw-float32-24k.wav> <outDir> [--makeup 6] [--distance 20]
//
// <raw> is a Voxtral answer saved untouched by scripts/Measure-VoxtralClarity.mjs (32-bit float, 24 kHz). It is run through the bridge's
// real code, in the real order:
//   1. 100 ms Float32 packets exactly as VoxtralVoice cuts them (2,400 samples),
//   2. ownedLocalPcmPacket (bridge/local-pcm-host.mjs): float32 -> Math.round(clamp * 32767) -> int16, base64,
//   3. ContinuousPcmCore (bridge/continuous-pcm-core.mjs): the int16 ring, read in 128-frame quanta as int16 / 32768,
//   -> <name>-core.wav     (32-bit float: what the AudioWorklet outputs; the only lossy step so far is the int16 rounding)
// then the Web Audio graph of bridge/continuous-pcm-player.mjs (connectGraph / applyGain), rendered OFFLINE in headless Edge (an
// OfflineAudioContext at the source rate: no audio device, nothing audible):
//   -> <name>-edge-off.wav      dialogue-level makeup off: panner (centre, -3 dB, undone here) -> air low-pass at Nyquist -> gain 1
//   -> <name>-edge-on-near.wav  makeup on (--makeup, default 6 dB) at 3 m: the same plus the limiter, the low-pass still open
//   -> <name>-edge-on-far.wav   makeup on at --distance (default 20 m): the air low-pass at airCutoff(distance)
// The graph is rebuilt from the player's own constants (LIMITER, airCutoff); the real player needs a live AudioContext. The browser's
// resampling to the sound card's rate is NOT in these files (not measurable offline). Compare with scripts/Measure-VoxtralClarity.py.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {basename, join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {ownedLocalPcmPacket} from '../bridge/local-pcm-host.mjs';
import {ContinuousPcmCore} from '../bridge/continuous-pcm-core.mjs';
import {LIMITER, airCutoff} from '../bridge/continuous-pcm-player.mjs';
import {chromium} from 'playwright';

const args = process.argv.slice(2);
const [rawPath, outDir] = args.filter((arg, at) => !arg.startsWith('--') && !(args[at - 1] ?? '').startsWith('--'));
if (!rawPath || !outDir) { console.error('usage: node scripts/Measure-VoxtralPipeline.mjs <raw.wav> <outDir> [--makeup 6] [--distance 20]'); process.exit(2); }
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? Number(args[at + 1]) : fallback; };
const MAKEUP = option('--makeup', 6), FAR = option('--distance', 20);
mkdirSync(outDir, {recursive: true});
const name = basename(rawPath).replace(/\.wav$/i, '');

function readFloatWav(path) {
  const bytes = readFileSync(path);
  if (bytes.toString('latin1', 8, 12) !== 'WAVE' || bytes.readUInt16LE(20) !== 3 || bytes.readUInt32LE(24) !== 24000) throw Error('expects a 24 kHz 32-bit float WAV');
  const data = bytes.subarray(44);
  return Float32Array.from({length: data.length >> 2}, (_, at) => data.readFloatLE(at * 4));
}
function wavFloat32(samples, rate = 24000) {
  const header = Buffer.alloc(44), data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(32, 34); header.write('data', 36, 'latin1'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ---- 1 to 3: the bridge's own packets, quantiser and ring ----------------------------------------------------------------------------
const peak = array => array.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const raw = readFloatWav(rawPath);
const owner = randomBytes(16).toString('hex'), modelSha256 = 'a'.repeat(64);
const core = new ContinuousPcmCore({sampleRate: 24000, channels: 1});
let frames = 0, index = 0, identity;
for (let from = 0; from < raw.length; from += 2400) {
  const pcm = raw.slice(from, Math.min(from + 2400, raw.length));
  const owned = ownedLocalPcmPacket({version: 1, engine: 'pocket-tts', profile: 'voxtral-test', owner, id: 1, index: index + 1, sampleRate: 24000, channels: 1,
    pcm, format: 'f32le', offsetFrames: frames, frames: pcm.length, modelSha256}, {token: 'test', frames, index, identity});
  identity = owned.identity;
  core.append(new Uint8Array(Buffer.from(owned.packet.pcm, 'base64')), frames);
  frames += pcm.length; index++;
}
core.end(frames);
const viaCore = new Float32Array(frames);
for (let at = 0, nowMs = 0, filled = 0; filled < frames; at++) {
  const quantum = new Float32Array(128);
  core.control({allow: true, paused: false, volume: 1, pan: 0}, nowMs);
  core.render([quantum], nowMs / 1000, nowMs);
  viaCore.set(quantum.subarray(0, Math.min(128, frames - filled)), filled); filled += 128; nowMs += 128 / 24;
  if (at > frames) throw Error('the core did not drain');
}
writeFileSync(join(outDir, `${name}-core.wav`), wavFloat32(viaCore));

// ---- the Web Audio graph, offline in Edge ---------------------------------------------------------------------------------------------
const browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--mute-audio']});
const page = await browser.newPage();
async function renderGraph({makeupDb, distance}) {
  const limited = makeupDb > 0, nyquist = 12000;
  const cutoff = limited && Number.isFinite(distance) ? airCutoff(distance, nyquist) : nyquist;
  const level = limited ? Math.pow(10, (makeupDb - LIMITER.makeupDb) / 20) : 1;
  const result = await page.evaluate(async ({input, limited, cutoff, level, limiter}) => {
    const bytes = Uint8Array.from(atob(input), c => c.charCodeAt(0)), samples = new Float32Array(bytes.buffer);
    const pad = 512, context = new OfflineAudioContext({numberOfChannels: 2, length: samples.length + pad, sampleRate: 24000});
    const buffer = context.createBuffer(1, samples.length, 24000); buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource(); source.buffer = buffer;
    const panner = context.createStereoPanner(); panner.pan.value = 0;
    const air = context.createBiquadFilter(); air.type = 'lowpass'; air.Q.value = 0.7071; air.frequency.value = cutoff;
    const gain = context.createGain(); gain.gain.value = level;
    source.connect(panner); panner.connect(air); air.connect(gain);
    if (limited) {
      const node = context.createDynamicsCompressor();
      node.threshold.value = limiter.threshold; node.knee.value = 0; node.ratio.value = limiter.ratio; node.attack.value = 0.001; node.release.value = 0.08;
      gain.connect(node); node.connect(context.destination);
    } else gain.connect(context.destination);
    source.start();
    const rendered = await context.startRendering();
    const left = rendered.getChannelData(0), right = rendered.getChannelData(1);
    const toBase64 = array => { let text = ''; const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength); for (let i = 0; i < view.length; i += 8192) text += String.fromCharCode(...view.subarray(i, i + 8192)); return btoa(text); };
    return {left: toBase64(left), right: toBase64(right)};
  }, {input: Buffer.from(viaCore.buffer).toString('base64'), limited, cutoff, level, limiter: LIMITER});
  const left = new Float32Array(Buffer.from(result.left, 'base64').buffer.slice(0));
  // Undo the centre pan's -3.01 dB and the requested makeup, trim the limiter's 6 ms look-ahead, so the file lines up with the raw one sample for sample.
  const undo = Math.SQRT2 / (limited ? Math.pow(10, makeupDb / 20) : 1);   // the compressor's automatic makeup is cancelled by the gain stage (see LIMITER)
  const delay = limited ? Math.round(LIMITER.delaySeconds * 24000) : 0, out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = left[i + delay] * undo;
  return {out, cutoff};
}
const report = {file: basename(rawPath), seconds: +(raw.length / 24000).toFixed(2), rawPeak: peak(raw)};
for (const [label, options] of [['edge-off', {makeupDb: 0}], ['edge-on-near', {makeupDb: MAKEUP, distance: 3}], ['edge-on-far', {makeupDb: MAKEUP, distance: FAR}]]) {
  const {out, cutoff} = await renderGraph(options);
  writeFileSync(join(outDir, `${name}-${label}.wav`), wavFloat32(out));
  report[label] = {makeupDb: options.makeupDb, distance: options.distance ?? null, cutoffHz: Math.round(cutoff), peak: peak(out)};
}
await browser.close();
writeFileSync(join(outDir, `${name}-pipeline.json`), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
