// Speech latency of one reference set (single clip, proposed multi-clip, or a
// capped multi-clip) through the bridge's own backends: ResidentVoice (Omni,
// GPU, phrase-scheduled with the CUDA-graph worker) or PocketVoice (CPU,
// streaming). Each run spawns its own worker process, like the bridge does.
//
//   node scripts/Measure-MultirefLatency.mjs --engine omni --steps 32 --refs single --label omni-s32-single
//   node scripts/Measure-MultirefLatency.mjs --engine pocket --refs multi --label pocket-multi
//
// --refs single | multi | cap<seconds>
//     single = the live configs' reference; multi = the proposed *.multiref.json; cap<N> trims the multi-clip
//     audio at a quiet point just under N seconds (written to runtime/voice-references/multiref-latency-cap/,
//     which is gitignored and safe to delete). Latency probe only: the trimmed audio is not a quality candidate.
// --voices a,b,c   --runs 3   --steps 16|32 (Omni)
// --graph 0|1                 Omni CUDA-graph worker on/off (the bridge default is on)
// --graph-max-tokens N        Omni experiment: raise the bridge's 640-token graph ceiling
// --restart-pass              Omni: restart the worker on the same disk cache and re-time prepare
// Live configs are only read. The worker lock, prompt cache and Pocket work directory are redirected to
// --work, so a running bridge is not disturbed. Output: <work>/results/<label>.json
import {spawn, execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {cpus} from 'node:os';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ResidentVoice} from '../bridge/resident-voice.mjs';
import {PocketVoice} from '../bridge/pocket-voice.mjs';
import {splitSpeechText} from '../bridge/speech-phrases.mjs';
import {readPcmWav} from '../bridge/speech-audio.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, at, all) => {
  if (token.startsWith('--')) pairs.push([token.slice(2), all[at + 1]?.startsWith('--') || all[at + 1] === undefined ? true : all[at + 1]]);
  return pairs;
}, []));
const engine = args.engine, refs = args.refs ?? 'single', steps = Number(args.steps ?? 32), runs = Number(args.runs ?? 3);
const work = resolve(args.work ?? 'E:/CyberpunkConvai-offload/work/multiref-latency');
const label = args.label ?? `${engine}-${refs}${engine === 'omni' ? '-s' + steps : ''}`;
const voices = (args.voices ?? 'johnny-silverhand,judy-alvarez,panam-palmer,jackie-welles,evelyn-parker,viktor-vektor,mama-welles,placide').split(',');
if (!['omni', 'pocket'].includes(engine) || !/^(single|multi|cap\d+)$/.test(refs) || ![16, 32].includes(steps)) {
  throw Error('Usage: --engine omni|pocket --refs single|multi|cap<N> [--steps 16|32] [--label x]');
}
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

// Sample GPU and whole-machine CPU load for the whole measurement.
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
  stop() { clearInterval(this.timer); return {cpuPercent: stats(this.cpu),
    gpuUsedMiB: stats(this.gpu.map(x => x.usedMiB)), gpuUtil: stats(this.gpu.map(x => x.util)),
    gpuTemp: stats(this.gpu.map(x => x.temp)), gpuClockMHz: stats(this.gpu.map(x => x.clockMHz))}; }
}

// ---- reference sets -------------------------------------------------------------------------------
async function referenceSet() {
  const sources = engine === 'omni'
    ? {single: 'runtime/local-voices.json', multi: 'runtime/local-voices.multiref.json'}
    : {single: 'runtime/pocket-voices.json', multi: 'runtime/pocket-voices.multiref.json'};
  const config = JSON.parse(await readFile(resolve(project, sources[refs === 'single' ? 'single' : 'multi']), 'utf8'));
  const chosen = {};
  for (const key of voices) {
    const descriptor = config.voices[key];
    if (!descriptor?.reference) throw Error(`No reference for ${key}`);
    chosen[key] = {reference: descriptor.reference, sha256: descriptor.sha256, transcript: descriptor.transcript};
  }
  const cap = /^cap(\d+)$/.exec(refs);
  if (cap) {
    const seconds = Number(cap[1]), directory = `runtime/voice-references/multiref-latency-cap/${seconds}s`;
    await mkdir(resolve(project, directory), {recursive: true});
    for (const key of voices) {
      const trimmed = trim(await readFile(resolve(project, chosen[key].reference)), chosen[key].transcript, seconds);
      const relative = `${directory}/${key}.wav`;
      await writeFile(resolve(project, relative), trimmed.bytes);
      chosen[key] = {reference: relative, sha256: createHash('sha256').update(trimmed.bytes).digest('hex'), transcript: trimmed.transcript};
    }
  }
  const seconds = {};
  for (const key of voices) seconds[key] = readPcmWav(await readFile(resolve(project, chosen[key].reference))).duration;
  return {config, chosen, seconds};
}

// Latency probe only: cut at the quietest point in the last 1.5 s before the cap and keep the leading share of
// the transcript's words. Duration and token count are right; word/audio alignment is approximate.
function trim(bytes, transcript, capSeconds) {
  const wav = readPcmWav(bytes);
  if (wav.duration <= capSeconds) return {bytes, transcript};
  if (wav.bits !== 16 || wav.channels !== 1) throw Error('Cap probe expects mono 16-bit references');
  let dataAt = 12; while (bytes.toString('ascii', dataAt, dataAt + 4) !== 'data') dataAt += 8 + bytes.readUInt32LE(dataAt + 4);
  const rate = wav.sampleRate, count = bytes.readUInt32LE(dataAt + 4) / 2, samples = new Int16Array(count);
  for (let at = 0; at < count; at++) samples[at] = bytes.readInt16LE(dataAt + 8 + at * 2);
  const window = Math.round(rate * .05), from = Math.round((capSeconds - 1.5) * rate), to = Math.round(capSeconds * rate);
  let best = to, bestEnergy = Infinity;
  for (let at = from; at + window <= to; at += Math.round(window / 2)) {
    let energy = 0; for (let k = 0; k < window; k++) energy += samples[at + k] ** 2;
    if (energy < bestEnergy) { bestEnergy = energy; best = at + (window >> 1); }
  }
  const cut = samples.slice(0, best), out = Buffer.alloc(44 + cut.length * 2);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(cut.length * 2, 40);
  for (let at = 0; at < cut.length; at++) out.writeInt16LE(cut[at], 44 + at * 2);
  // Keep the same words-per-second as the full reference so the speaking-rate estimate (and the length of the
  // generated audio) is unchanged; the cut may fall mid-sentence, which is fine for a latency probe.
  const words = transcript.trim().split(/\s+/);
  return {bytes: out, transcript: words.slice(0, Math.max(1, Math.round(words.length * best / count))).join(' ')};
}

// ---- Omni -------------------------------------------------------------------------------------------
const LAUNCHER = `import contextlib, importlib.util, os, sys
from pathlib import Path
project, cache = Path(sys.argv[1]), Path(sys.argv[2])
spec = importlib.util.spec_from_file_location('resident_voice_worker', project / 'bridge/resident-voice-worker.py')
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)
# Measurement isolation only: a private prompt cache and no shared admission lock (the bridge's slot and its
# on-disk conditioning cache stay untouched). Everything else is the bridge's own worker.
worker.model_admission = lambda *a, **k: contextlib.nullcontext()
environment = worker.voice_environment
def isolated(registry):
    values = environment(registry)
    values['OMNIVOICE_DATA_DIR'] = str(cache / f'{worker.MODEL_REVISION[:12]}-{worker.ADAPTER_REVISION[:12]}')
    return values
worker.voice_environment = isolated
ceiling = os.environ.get('MULTIREF_GRAPH_MAX_TOKENS')
if ceiling:   # experiment arm only: raise the CUDA-graph sequence ceiling (bridge default 640) via a patched copy
    original = importlib.util.spec_from_file_location
    def patched(name, location, *a, **k):
        if str(location).endswith('voice-cuda-graph.py'):
            source = Path(location).read_text(encoding='utf-8').replace('max_tokens=640', f'max_tokens={int(ceiling)}')
            copy = cache / 'voice-cuda-graph-experiment.py'; copy.write_text(source, encoding='utf-8'); location = copy
        return original(name, location, *a, **k)
    importlib.util.spec_from_file_location = patched
sys.argv = ['resident-voice-worker.py'] + sys.argv[3:]
worker.main()
`;

async function runOmni(set) {
  const cache = resolve(work, 'omni-cache', label), launcher = resolve(work, 'omni-worker-launcher.py');
  await rm(cache, {recursive: true, force: true}); await mkdir(cache, {recursive: true});
  await writeFile(launcher, LAUNCHER);
  const configPath = resolve(work, 'configs', `${label}.json`);
  await mkdir(dirname(configPath), {recursive: true});
  const {voices: _, proposal: __, ...rest} = set.config;
  const config = {...rest, steps, voices: set.chosen, preparation: {mode: 'lazy', startupProfiles: [], maxCachedProfiles: 8}};
  await writeFile(configPath, JSON.stringify(config, null, 1));
  if (args['graph-max-tokens']) process.env.MULTIREF_GRAPH_MAX_TOKENS = String(args['graph-max-tokens']);
  if (args.graph !== undefined) process.env.CYBERPUNK_CONVAI_CUDA_GRAPH = String(args.graph === true ? 1 : args.graph);
  const report = {label, engine, refs, steps, voices, referenceSeconds: set.seconds, graph: (process.env.CYBERPUNK_CONVAI_CUDA_GRAPH ?? '1') + (args['graph-max-tokens'] ? ` (max ${args['graph-max-tokens']} tokens)` : ''), runs: [], prepare: {}};
  const logs = [];
  const open = () => new ResidentVoice(config, {project, configPath,
    spawnImpl: (exe, argv, options) => spawn(exe, [launcher, project, cache, ...argv.slice(1)], options),
    onLog: text => logs.push(text.slice(0, 400)), onState: () => {}});
  const sampler = new LoadSampler(), before = await smi();
  report.gpuBefore = before; sampler.start();
  let client = open();
  const started = performance.now(); await client.start(); report.startMs = performance.now() - started;
  report.afterLoad = {...client.details, gpu: await smi()};
  for (const key of voices) {                       // cold: no disk or memory prompt for this voice yet
    const at = performance.now(); await client.prepareProfile(key); report.prepare[key] = {coldMs: performance.now() - at};
  }
  client.setSteps(steps);
  for (const text of Object.values(TEXTS)) for (let k = 0; k < 2; k++) await client.synthesize(voices[0], text);   // graph/allocator warm-up
  report.afterWarm = {...client.details, gpu: await smi()};
  const phraseCounts = Object.fromEntries(Object.entries(TEXTS).map(([name, text]) => [name, splitSpeechText(text).length]));
  report.phraseCounts = phraseCounts;
  // Graph counters are cumulative; the worker renders serially, so per-phrase deltas follow call order.
  let previous = client.details.cudaGraph ?? {captures: 0, replays: 0, fallbacks: 0, captureMs: 0};
  for (let run = 1; run <= runs; run++) for (const key of voices) for (const [name, text] of Object.entries(TEXTS)) {
    const phrases = splitSpeechText(text), t0 = performance.now(), jobs = [];
    // The bridge queues phrase 1 and 2 at submit and keeps one phrase queued ahead afterwards.
    const queue = index => { if (index < phrases.length && !jobs[index]) jobs[index] = client.synthesize(key, phrases[index], {steps}); };
    queue(0); queue(1);
    const frames = [];
    for (let at = 0; at < phrases.length; at++) {
      const frame = await jobs[at]; frames.push({...frame, doneAt: performance.now() - t0}); queue(at + 2);
    }
    const generation = frames.map(frame => frame.timing.voiceGenerationMs), audio = frames.map(frame => frame.wav.duration);
    const graphs = frames.map(frame => { const now = frame.timing.voiceGraph, delta = {captures: now.captures - previous.captures,
      replays: now.replays - previous.replays, fallbacks: now.fallbacks - previous.fallbacks, captureMs: now.captureMs - previous.captureMs};
      previous = now; return delta; });
    report.runs.push({run, voice: key, length: name, phrases: phrases.length,
      firstAudioMs: frames[0].doneAt, firstPhraseGenMs: generation[0], firstPhraseAudioSec: audio[0],
      totalWallMs: frames.at(-1).doneAt, phraseGenMs: generation, phraseAudioSec: audio,
      totalGenMs: generation.reduce((a, b) => a + b, 0), totalAudioSec: audio.reduce((a, b) => a + b, 0),
      rtf: generation.reduce((a, b) => a + b, 0) / 1000 / audio.reduce((a, b) => a + b, 0),
      graphs, shape: frames.at(-1).timing.voiceGraph?.shape});
  }
  report.afterRuns = {...client.details, gpu: await smi()};
  report.load = sampler.stop();
  await client.close();
  if (args['restart-pass']) {
    // New process, same on-disk conditioning cache: prepare then costs the warm render, not the reference encode.
    client = open(); await client.start(); report.warmDisk = {};
    for (const key of voices) { const at = performance.now(); await client.prepareProfile(key); report.warmDisk[key] = performance.now() - at; }
    await client.close();
  }
  report.logTail = logs.slice(-5);
  return report;
}

// ---- Pocket -----------------------------------------------------------------------------------------
// The renderer's player waits for 0.4 s of buffered audio before it starts, then plays in real time and
// rebuffers (an underrun) whenever the buffer empties before the next chunk arrives (continuous-pcm-core).
function simulatePlayback(chunks, startupSeconds = .4, rate = 24000) {
  let buffer = 0, last = chunks[0].t / 1000, playing = false, audibleAt = null, underruns = 0, worstGap = 0;
  chunks.forEach((chunk, at) => {
    const t = chunk.t / 1000;
    if (playing) {
      const stall = last + buffer;
      if (t > stall) { underruns++; worstGap = Math.max(worstGap, t - stall); buffer = 0; playing = false; }
      else buffer -= t - last;
    }
    last = t; buffer += chunk.frames / rate;
    if (!playing && (buffer >= startupSeconds || at === chunks.length - 1)) { playing = true; audibleAt ??= t; }
  });
  return {audibleMs: audibleAt * 1000, underruns, worstGapMs: worstGap * 1000};
}

async function runPocket(set) {
  const configPath = resolve(work, 'configs', `${label}.json`), workDirectory = resolve(work, 'pocket-work', label);
  await mkdir(dirname(configPath), {recursive: true}); await mkdir(workDirectory, {recursive: true});
  const {proposal: _, voices: __, ...rest} = set.config;
  const config = {...rest, runtime: {...rest.runtime, workDirectory}, voices: set.chosen,
    preparation: {startupProfiles: [], maxCachedProfiles: 8}};
  await writeFile(configPath, JSON.stringify(config, null, 1));
  const report = {label, engine, refs, voices, referenceSeconds: set.seconds, threads: config.cpu?.threads, runs: [], prepare: {}};
  const logs = [], client = new PocketVoice(config, {project, configPath, pythonExecutable: config.runtime.pythonExecutable,
    onLog: text => logs.push(text.slice(0, 400))});
  const sampler = new LoadSampler(); report.gpuBefore = await smi(); sampler.start();
  const started = performance.now(); await client.start(); report.startMs = performance.now() - started;
  for (const key of voices) {
    const at = performance.now(); await client.prepareProfile(key); report.prepare[key] = {coldMs: performance.now() - at};
  }
  for (const text of Object.values(TEXTS)) await client.synthesizeStream(voices[0], text, {onPcm: () => {}});
  for (let run = 1; run <= runs; run++) for (const key of voices) for (const [name, text] of Object.entries(TEXTS)) {
    const chunks = [], t0 = performance.now();
    const result = await client.synthesizeStream(key, text, {onPcm: packet => chunks.push({t: performance.now() - t0, frames: packet.frames})});
    const play = simulatePlayback(chunks);
    report.runs.push({run, voice: key, length: name, firstAudioMs: chunks[0].t, firstAudibleMs: play.audibleMs,
      totalWallMs: performance.now() - t0, generationMs: result.timing.voiceGenerationMs, audioSeconds: result.duration,
      rtf: result.timing.voiceGenerationMs / 1000 / result.duration, workerFirstPcmMs: result.timing.voiceFirstPcmCopiedReadyMs,
      underruns: play.underruns, worstGapMs: play.worstGapMs, chunks: chunks.length, preparationMs: result.timing.voicePreparationMs});
  }
  report.load = sampler.stop(); await client.close(); report.logTail = logs.slice(-5);
  return report;
}

// ---- summary ----------------------------------------------------------------------------------------
function summarize(report) {
  const summary = {};
  for (const name of Object.keys(TEXTS)) {
    const rows = report.runs.filter(row => row.length === name);
    const pick = field => stats(rows.map(row => row[field]));
    summary[name] = report.engine === 'omni'
      ? {firstAudioMs: pick('firstAudioMs'), firstPhraseGenMs: pick('firstPhraseGenMs'), rtf: pick('rtf'), totalWallMs: pick('totalWallMs'),
         firstPhraseAudioSec: pick('firstPhraseAudioSec'), totalAudioSec: pick('totalAudioSec'),
         // A phrase "ran on the graph" when every denoising forward was a replay (no eager fallback).
         phrasesAllReplay: rows.flatMap(row => row.graphs).filter(g => g.fallbacks === 0 && g.replays > 0).length,
         phrasesWithFallback: rows.flatMap(row => row.graphs).filter(g => g.fallbacks > 0).length,
         phrases: rows.flatMap(row => row.graphs).length,
         captureMsPerPhrase: stats(rows.flatMap(row => row.graphs).map(g => g.captureMs))}
      : {firstAudioMs: pick('firstAudioMs'), firstAudibleMs: pick('firstAudibleMs'), rtf: pick('rtf'), totalWallMs: pick('totalWallMs'),
         audioSeconds: pick('audioSeconds'), underruns: rows.reduce((a, row) => a + row.underruns, 0), requests: rows.length,
         worstGapMs: Math.max(...rows.map(row => row.worstGapMs))};
  }
  summary.prepareColdMs = stats(Object.values(report.prepare).map(row => row.coldMs));
  summary.referenceSeconds = stats(Object.values(report.referenceSeconds));
  return summary;
}

const set = await referenceSet();
const report = engine === 'omni' ? await runOmni(set) : await runPocket(set);
report.summary = summarize(report);
report.finished = new Date().toISOString();
await mkdir(resolve(work, 'results'), {recursive: true});
await writeFile(resolve(work, 'results', `${label}.json`), JSON.stringify(report, null, 1));
console.log(JSON.stringify({label, summary: report.summary, load: report.load, afterRuns: report.afterRuns?.cudaPeakReservedMiB}, null, 1));
