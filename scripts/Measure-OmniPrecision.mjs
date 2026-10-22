// OmniVoice numeric-precision test through the bridge's own ResidentVoice class: first-audio latency, real-time
// factor, VRAM, CUDA-graph behaviour, plus WAVs for scoring (Score-OmniPrecision.py) and for listening.
//
//   node scripts/Measure-OmniPrecision.mjs --precision bf16 --steps 16 --graph 1 --label bf16-s16-graph
//
// --precision fp16|bf16|int8wo|int8dyn|fp8wo|fp8dyn   (see scripts/omni-precision/launcher.py; fp16 = the bridge as it is)
// --graph 0|1      CUDA-graph worker on (bridge default) or forced eager
// --seed N       sampling-seed offset (noise-floor renders)
// --steps 16|32    --runs 3   --voices a,b,c   --quality 0|1 (panel-line renders for scoring, default 1)
// --work <dir>     default E:/CyberpunkConvai-offload/work/omni-precision
// Live configs are only read. The worker lock and prompt cache are private to --work, so a running bridge is not
// disturbed. torchao lives in --torchao (default E:/CyberpunkConvai-offload/work/omni-precision/torchao-lib, pip install --target), never in the bridge's venv.
// Output: <work>/results/<label>.json, <work>/audio/<label>/<voice>__short|long.wav, <work>/quality/<label>/*.wav
import {spawn, execFile} from 'node:child_process';
import {readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {cpus} from 'node:os';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ResidentVoice} from '../bridge/resident-voice.mjs';
import {splitSpeechText} from '../bridge/speech-phrases.mjs';
import {readPcmWav} from '../bridge/speech-audio.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, at, all) => {
  if (token.startsWith('--')) pairs.push([token.slice(2), all[at + 1]?.startsWith('--') || all[at + 1] === undefined ? true : all[at + 1]]);
  return pairs;
}, []));
const precision = args.precision ?? 'fp16', steps = Number(args.steps ?? 16), runs = Number(args.runs ?? 3);
const graph = String(args.graph ?? 1), quality = String(args.quality ?? 1) !== '0';
const work = resolve(args.work ?? 'E:/CyberpunkConvai-offload/work/omni-precision');
const label = args.label ?? `${precision}-s${steps}-${graph === '0' ? 'eager' : 'graph'}`;
const voices = (args.voices ?? 'johnny-silverhand,judy-alvarez,panam-palmer,jackie-welles,evelyn-parker,viktor-vektor').split(',');
const panelPath = args.panel ?? 'E:/CyberpunkConvai-offload/work/likeness-phase1/out/panel.json';
if (!['fp16', 'bf16', 'int8wo', 'int8dyn', 'fp8wo', 'fp8dyn', 'bf16int8wo'].includes(precision) || ![16, 32].includes(steps) || !['0', '1'].includes(graph)) {
  throw Error('Usage: --precision fp16|bf16|int8wo|int8dyn|fp8wo|fp8dyn --steps 16|32 --graph 0|1');
}
// Same two lines as Measure-MultirefLatency.mjs.
const TEXTS = {
  short: 'Alright V, give me a second and I will see what I can dig up on that.',
  long: 'Listen, V, I have been thinking about what happened at the docks last night, and none of it adds up. '
    + 'The shipment was gone before we even got there, which means somebody tipped them off. '
    + 'Whoever it was knows more about us than I am comfortable with, so from now on we keep this between the two of us.',
};

const median = list => { const s = [...list].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const p90 = list => { const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(.9 * s.length) - 1)]; };
const stats = list => list.length ? {n: list.length, median: median(list), p90: p90(list), min: Math.min(...list), max: Math.max(...list),
  mean: list.reduce((a, b) => a + b, 0) / list.length} : null;
const smi = () => new Promise(done => execFile('nvidia-smi', ['--query-gpu=memory.used,utilization.gpu,temperature.gpu,power.draw,clocks.current.graphics',
  '--format=csv,noheader,nounits'], (error, out) => {
  if (error) return done(null);
  const [used, util, temp, power, clock] = out.trim().split(',').map(Number); done({usedMiB: used, util, temp, power, clockMHz: clock});
}));
const cpuTimes = () => cpus().reduce((a, c) => ({idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0)}), {idle: 0, total: 0});
class LoadSampler {
  constructor() { this.gpu = []; this.cpu = []; }
  start() {
    this.last = cpuTimes();
    this.timer = setInterval(async () => {
      const now = cpuTimes(), idle = now.idle - this.last.idle, total = now.total - this.last.total; this.last = now;
      if (total > 0) this.cpu.push(100 * (1 - idle / total));
      const gpu = await smi(); if (gpu) this.gpu.push(gpu);
    }, 1000);
  }
  stop() { clearInterval(this.timer); return {cpuPercent: stats(this.cpu), gpuUsedMiB: stats(this.gpu.map(x => x.usedMiB)),
    gpuUtil: stats(this.gpu.map(x => x.util)), gpuTemp: stats(this.gpu.map(x => x.temp)), gpuClockMHz: stats(this.gpu.map(x => x.clockMHz))}; }
}

function wavBytes(parts, rate = 24000, gapSeconds = .12) {   // concatenate the phrase WAVs the bridge would play back to back
  const pcm = [];
  parts.forEach((part, at) => { if (at) pcm.push(Buffer.alloc(Math.round(gapSeconds * rate) * 2)); pcm.push(part); });
  const data = Buffer.concat(pcm), out = Buffer.alloc(44 + data.length);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(data.length, 40); data.copy(out, 44);
  return out;
}

const config = JSON.parse(await readFile(resolve(project, 'runtime/local-voices.json'), 'utf8'));
const chosen = {};
for (const key of voices) {
  const descriptor = config.voices[key];
  if (!descriptor?.reference) throw Error(`No reference for ${key}`);
  chosen[key] = {reference: descriptor.reference, sha256: descriptor.sha256, transcript: descriptor.transcript};
}
const cache = resolve(work, 'cache', label), configPath = resolve(work, 'configs', `${label}.json`);
const launcher = resolve(project, 'scripts/omni-precision/launcher.py');
await rm(cache, {recursive: true, force: true}); await mkdir(cache, {recursive: true}); await mkdir(dirname(configPath), {recursive: true});
const {voices: _, proposal: __, ...rest} = config;
const runConfig = {...rest, steps, voices: chosen, preparation: {mode: 'lazy', startupProfiles: [], maxCachedProfiles: 8}};
await writeFile(configPath, JSON.stringify(runConfig, null, 1));
process.env.CYBERPUNK_CONVAI_CUDA_GRAPH = graph;
process.env.OMNI_PRECISION = precision;
process.env.OMNI_SEED_OFFSET = String(args.seed ?? 0);   // noise floor: same model, another sampling seed
process.env.OMNI_TORCHAO = resolve(args.torchao ?? 'E:/CyberpunkConvai-offload/work/omni-precision/torchao-lib');

const report = {label, precision, steps, graph, voices, runs: [], prepare: {}, quality: []};
const logs = [];
const client = new ResidentVoice(runConfig, {project, configPath,
  spawnImpl: (exe, argv, options) => spawn(exe, [launcher, project, cache, ...argv.slice(1)], options),
  onLog: text => logs.push(text.slice(0, 2000)), onState: () => {}});
const sampler = new LoadSampler(); report.gpuBefore = await smi(); sampler.start();

// The bridge queues phrase 1 and 2 at submit and keeps one phrase queued ahead afterwards.
async function speak(key, text) {
  const phrases = splitSpeechText(text), t0 = performance.now(), jobs = [], frames = [];
  const queue = index => { if (index < phrases.length && !jobs[index]) jobs[index] = client.synthesize(key, phrases[index], {steps}); };
  queue(0); queue(1);
  for (let at = 0; at < phrases.length; at++) { const frame = await jobs[at]; frames.push({...frame, doneAt: performance.now() - t0}); queue(at + 2); }
  return frames;
}

try {
  const started = performance.now(); await client.start(); report.startMs = performance.now() - started;
  report.afterLoad = {...client.details, gpu: await smi()};
  for (const key of voices) { const at = performance.now(); await client.prepareProfile(key); report.prepare[key] = {coldMs: performance.now() - at}; }
  client.setSteps(steps);
  for (const text of Object.values(TEXTS)) for (let k = 0; k < 2; k++) await client.synthesize(voices[0], text);   // graph/allocator warm-up
  report.afterWarm = {...client.details, gpu: await smi()};
  let previous = client.details.cudaGraph ?? {captures: 0, replays: 0, fallbacks: 0, captureMs: 0};
  await mkdir(resolve(work, 'audio', label), {recursive: true});
  for (let run = 1; run <= runs; run++) for (const key of voices) for (const [name, text] of Object.entries(TEXTS)) {
    const frames = await speak(key, text);
    const generation = frames.map(frame => frame.timing.voiceGenerationMs), audio = frames.map(frame => frame.wav.duration);
    const graphs = frames.map(frame => { const now = frame.timing.voiceGraph, delta = now ? {captures: now.captures - previous.captures,
      replays: now.replays - previous.replays, fallbacks: now.fallbacks - previous.fallbacks, captureMs: now.captureMs - previous.captureMs} : null;
      if (now) previous = now; return delta; });
    report.runs.push({run, voice: key, length: name, phrases: frames.length, firstAudioMs: frames[0].doneAt, firstPhraseGenMs: generation[0],
      firstPhraseAudioSec: audio[0], totalWallMs: frames.at(-1).doneAt, phraseGenMs: generation, phraseAudioSec: audio,
      totalGenMs: generation.reduce((a, b) => a + b, 0), totalAudioSec: audio.reduce((a, b) => a + b, 0),
      rtf: generation.reduce((a, b) => a + b, 0) / 1000 / audio.reduce((a, b) => a + b, 0), graphs, shape: frames.at(-1).timing.voiceGraph?.shape});
    if (run === 1) await writeFile(resolve(work, 'audio', label, `${key}__${name}.wav`),
      wavBytes(frames.map(frame => readPcmWav(Buffer.from(frame.audio, 'base64')).data)));
  }
  report.afterRuns = {...client.details, gpu: await smi()};
  if (quality) {     // the panel's held-out real lines (two per voice), rendered like the bridge speaks them
    const panel = JSON.parse(await readFile(panelPath, 'utf8'));
    const folder = resolve(work, 'quality', label); await mkdir(folder, {recursive: true});
    for (const key of voices) for (const [line, target] of panel[key].targets.entries()) {
      const frames = await speak(key, target.transcript), file = `${key}__${line}.wav`;
      await writeFile(resolve(folder, file), wavBytes(frames.map(frame => readPcmWav(Buffer.from(frame.audio, 'base64')).data)));
      report.quality.push({speaker: key, line, text: target.transcript, file,
        genMs: frames.reduce((a, frame) => a + frame.timing.voiceGenerationMs, 0)});
    }
    await writeFile(resolve(folder, 'records.json'), JSON.stringify({condition: {name: label, precision, steps, graph}, records: report.quality}, null, 1));
  }
  report.afterQuality = {...client.details, gpu: await smi()};
} catch (error) {
  report.error = `${error?.name}: ${error?.message}`;
} finally {
  report.load = sampler.stop();
  await client.close().catch(() => {});
}
report.precisionInfo = logs.flatMap(text => text.split('\n')).filter(line => line.startsWith('PRECISION ')).map(line => JSON.parse(line.slice(10)))[0] ?? null;
report.logTail = logs.slice(-6);
const summary = {};
for (const name of Object.keys(TEXTS)) {
  const rows = report.runs.filter(row => row.length === name), pick = field => stats(rows.map(row => row[field]));
  summary[name] = {firstAudioMs: pick('firstAudioMs'), firstPhraseGenMs: pick('firstPhraseGenMs'), rtf: pick('rtf'), totalWallMs: pick('totalWallMs'),
    phrasesAllReplay: rows.flatMap(row => row.graphs).filter(g => g && g.fallbacks === 0 && g.replays > 0).length,
    phrasesWithFallback: rows.flatMap(row => row.graphs).filter(g => g && g.fallbacks > 0).length, phrases: rows.flatMap(row => row.graphs).length};
}
const all = report.runs;
summary.all = {firstAudioMs: stats(all.map(row => row.firstAudioMs)), rtf: stats(all.map(row => row.rtf)),
  rtfPooled: all.reduce((a, row) => a + row.totalGenMs, 0) / 1000 / all.reduce((a, row) => a + row.totalAudioSec, 0)};
report.summary = summary;
report.finished = new Date().toISOString();
await mkdir(resolve(work, 'results'), {recursive: true});
await writeFile(resolve(work, 'results', `${label}.json`), JSON.stringify(report, null, 1));
console.log(JSON.stringify({label, error: report.error, summary: report.summary, precision: report.precisionInfo,
  peakReservedMiB: report.afterQuality?.cudaPeakReservedMiB, graph: report.afterQuality?.cudaGraph, load: {gpuUsedMiB: report.load?.gpuUsedMiB,
  gpuUtil: report.load?.gpuUtil}}, null, 1));
