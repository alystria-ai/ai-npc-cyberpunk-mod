// Benchmark of the local speech-to-text path (bridge/local-stt.mjs + bridge/local-stt-worker.py).
//
//   node scripts/Bench-LocalStt.mjs --synth                    render six game-style lines with Windows' own voices and run them
//   node scripts/Bench-LocalStt.mjs --dir <folder>             run every 16-bit PCM .wav in a folder; a .txt next to a clip is its reference text
//   options: --threads N (default 1)   --live (pace the audio in real time, with live words; default sends it at once)
//            --no-partials   --priority normal|below|idle (default below)   --python <exe>   --repeat N   --json
//
// It reports, per clip and overall: the final decode latency (from the last audio chunk to the transcript), the
// word error rate when a reference exists, the live-word updates, and the worker's CPU time per audio second.
// Nobody is recorded: input is audio files. On a laptop in Silent power mode expect slower numbers.
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LocalStt} from '../bridge/local-stt.mjs';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const flag = name => argv.includes('--' + name);
const option = (name, fallback) => { const at = argv.indexOf('--' + name); return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback; };

const SYNTH_LINES = [
  'Hey Judy, do you want to grab a drink at the Afterlife tonight?',
  'Panam, can you cover me while I hack the terminal?',
  'Johnny, tell me what you remember about Arasaka Tower.',
  "Let's drive to Watson and look for Jackie's old friends.",
  'What do you think about Kerry Eddies and the Samurai reunion?',
  'I just need a minute, then we head to Pacifica.',
];

function synthesize(directory) {
  const script = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$voices = @($s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
$lines = ConvertFrom-Json $env:BENCH_LINES
for ($i = 0; $i -lt $lines.Count; $i++) {
  $s.SelectVoice($voices[$i % $voices.Count])
  $s.SetOutputToWaveFile((Join-Path $env:BENCH_DIR ("synth-$i.wav")), $format)
  $s.Speak($lines[$i]); $s.SetOutputToNull()
}
$s.Dispose()`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: {...process.env, BENCH_DIR: directory, BENCH_LINES: JSON.stringify(SYNTH_LINES)}, encoding: 'utf8'});
  if (run.status !== 0) throw Error('Windows speech synthesis failed: ' + (run.stderr || run.stdout));
  return SYNTH_LINES.map((text, i) => ({file: join(directory, `synth-${i}.wav`), text}));
}

// 16-bit PCM WAV -> 16 kHz mono Int16 samples (channel average, linear resampling).
function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') throw Error(path + ' is not a WAV file');
  let at = 12, format = null, data = null;
  while (at + 8 <= b.length) {
    const id = b.toString('latin1', at, at + 4), size = b.readUInt32LE(at + 4);
    if (id === 'fmt ') format = {tag: b.readUInt16LE(at + 8), channels: b.readUInt16LE(at + 10), rate: b.readUInt32LE(at + 12), bits: b.readUInt16LE(at + 22)};
    if (id === 'data') { data = b.subarray(at + 8, at + 8 + Math.min(size, b.length - at - 8)); break; }
    at += 8 + size + (size & 1);
  }
  if (!format || !data || format.bits !== 16 || ![1, 0xfffe].includes(format.tag)) throw Error(path + ': only 16-bit PCM is supported');
  const frames = Math.floor(data.length / 2 / format.channels), mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < format.channels; c++) sum += data.readInt16LE((i * format.channels + c) * 2);
    mono[i] = sum / format.channels;
  }
  if (format.rate === 16000) return Int16Array.from(mono);
  const out = new Int16Array(Math.floor(frames * 16000 / format.rate));
  for (let i = 0; i < out.length; i++) {
    const position = i * format.rate / 16000, low = Math.floor(position), high = Math.min(frames - 1, low + 1), t = position - low;
    out[i] = Math.round(mono[low] * (1 - t) + mono[high] * t);
  }
  return out;
}

const words = text => text.toLowerCase().replace(/[-’]/g, ' ').replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
function editDistance(a, b) {
  let row = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] !== b[j - 1] ? 1 : 0));
      previous = keep;
    }
  }
  return row[b.length];
}
const percentile = (values, p) => { const s = [...values].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

async function main() {
  let clips = [], temporary = null;
  const directory = option('dir');
  if (flag('synth')) { temporary = mkdtempSync(join(tmpdir(), 'bench-stt-')); clips = synthesize(temporary); }
  else if (directory) {
    clips = readdirSync(directory).filter(name => name.toLowerCase().endsWith('.wav')).sort().map(name => {
      const file = join(directory, name), reference = file.replace(/\.wav$/i, '.txt');
      return {file, text: existsSync(reference) ? readFileSync(reference, 'utf8').trim() : null};
    });
  } else { console.error('usage: node scripts/Bench-LocalStt.mjs --synth | --dir <folder> [--threads N] [--live] [--no-partials] [--repeat N] [--json]'); process.exit(2); }
  const stt = new LocalStt({project, pythonExecutable: option('python', resolve(project, 'vendor/pocket-tts-env/Scripts/python.exe')),
    threads: Number(option('threads', 1)), partials: !flag('no-partials'), priority: option('priority', 'below'),
    lowerPriority: option('priority', 'below') !== 'normal'});
  const availability = stt.availability();
  if (!availability.available) { console.error('Local speech recognition is not available: ' + availability.reason); process.exit(3); }
  const loadStarted = performance.now();
  await stt.warm();
  const loadMs = performance.now() - loadStarted;
  const rows = [], live = flag('live');
  let partialCount = 0;
  stt.on('partial', () => { partialCount++; });
  // A silent first recording gives the baseline of the worker's CPU time (start-up and model load).
  await stt.start('baseline'); stt.pushAudio(Buffer.alloc(32000), 'baseline');
  let cpuBefore = (await stt.finish('baseline')).cpuMs ?? 0;
  for (let pass = 0; pass < Number(option('repeat', 1)); pass++) for (const clip of clips) {
    const samples = readWav(clip.file), seconds = samples.length / 16000, id = basename(clip.file) + '#' + pass;
    partialCount = 0;
    await stt.start(id);
    const started = performance.now();
    for (let at = 0; at < samples.length; at += 1600) {
      stt.pushAudio(samples.subarray(at, at + 1600), id);
      if (live) await new Promise(done => setTimeout(done, 100));
    }
    const finishing = performance.now();
    const result = await stt.finish(id);
    const latency = performance.now() - finishing;
    const reference = clip.text ? words(clip.text) : null, errors = reference ? editDistance(reference, words(result.text)) : null;
    const cpu = (result.cpuMs ?? 0) - cpuBefore; cpuBefore = result.cpuMs ?? cpuBefore;
    rows.push({clip: basename(clip.file), seconds, latencyMs: Math.round(latency), decodeMs: result.ms, partials: partialCount,
      cpuPerAudioSecond: seconds ? cpu / 1000 / seconds : 0, errors, referenceWords: reference?.length ?? null, text: result.text,
      totalMs: Math.round(performance.now() - started)});
  }
  await stt.close();
  if (temporary) rmSync(temporary, {recursive: true, force: true});
  const scored = rows.filter(row => row.errors !== null);
  const summary = {engine: 'moonshine-tiny-en-int8 (sherpa-onnx)', threads: stt.threads, mode: live ? 'live (real-time pacing)' : 'burst',
    clips: rows.length, audioSeconds: +rows.reduce((sum, row) => sum + row.seconds, 0).toFixed(1), loadMs: Math.round(loadMs),
    latencyMs: {p50: percentile(rows.map(row => row.latencyMs), .5), p95: percentile(rows.map(row => row.latencyMs), .95),
      max: Math.max(...rows.map(row => row.latencyMs))},
    wer: scored.length ? +(scored.reduce((sum, row) => sum + row.errors, 0) / scored.reduce((sum, row) => sum + row.referenceWords, 0)).toFixed(3) : null,
    workerCpuSecondsPerAudioSecond: +(rows.reduce((sum, row) => sum + row.cpuPerAudioSecond * row.seconds, 0) / rows.reduce((sum, row) => sum + row.seconds, 0)).toFixed(3),
    livePartialsPerClip: +(rows.reduce((sum, row) => sum + row.partials, 0) / rows.length).toFixed(1)};
  if (flag('json')) { console.log(JSON.stringify({summary, rows}, null, 1)); return; }
  for (const row of rows) console.log(`${row.clip.padEnd(30)} ${row.seconds.toFixed(1).padStart(5)}s  final ${String(row.latencyMs).padStart(4)} ms`
    + `  partials ${row.partials}  ${row.errors === null ? '' : `err ${row.errors}/${row.referenceWords}  `}${row.text}`);
  console.log(JSON.stringify(summary, null, 1));
}
main().catch(error => { console.error(error.message); process.exit(1); });
