// How soon the reply model is started after the voice key is pressed again, on the local-recogniser route (docs/LATENCY_2026-10-14.md section 1).
//
//   node scripts/Measure-VoiceKeyStart.mjs --synth|--clips <dir> [--gaps 0,400,1000] [--variants baseline,pause,b-only,full]
//        [--python <exe>] [--model <dir>] [--baseline-ref main] [--limit N] [--json out.json]
//   (also reachable as `node scripts/Measure-TurnLatency.mjs --voice-key-stt ...`)
//
// What is real: the recogniser (bridge/local-stt.mjs and the Python worker with the Moonshine model, one thread, real-time pacing of the
// audio in 100 ms chunks), the voice channel (createLocalSttChannel), the text host (TextProviderHost, prompt, SSE client) and ReplyStream.
// What is simulated: the language model (a local SSE server with Mistral's measured first-token delay and speed; every request is logged and a
// cancelled one is counted), the microphone (the clip's samples with a leading pause, noise and a trailing pause as the player's reaction
// time before pressing the key again, `gap`), and nothing else. No cloud call, no key, no game, no sound: clips are Windows speech synthesis
// (--synth) or 16-bit WAV files (--clips; a .txt beside a clip is its reference words).
//
// Variants (the worker file of `baseline` and `b-only` is the one in --baseline-ref, i.e. before this branch):
//   baseline   the route as it was: live words by timer only, the reply starts when the final decode is back
//   pause      the recogniser also decodes the moment the player pauses, and its worker counts a long recording whose first word is inside the window
//   b-only     option B alone: the reply starts on the newest live decode when it is stable (timer decodes only), the final words confirm it
//   full       pause + B
// Reported per variant and gap: ms after the key press until the reply request that is voiced was started ("time to text"), until the first
// sentence is ready for the voice ("time to head"), the recogniser's own final latency, how many turns started on a stable decode and how many of
// those had to start over, model requests sent and cancelled, and the worker's CPU seconds per second of audio.
process.env.CYBERPUNK_CONVAI_MUTE_BROWSER = '1';
import {createServer} from 'node:http';
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = path => import(pathToFileURL(resolve(root, path)).href);
const [{TextProviderHost, mistralRoute}, {MistralMemory}, {MistralProvider}, {GroqKey}, {PersonaBook}, {ReplyStream}, {hasEmotionTag},
  {LocalStt}, {createLocalSttChannel}] = await Promise.all([
  load('bridge/text-provider-host.mjs'), load('bridge/mistral-memory.mjs'), load('bridge/mistral-key.mjs'), load('bridge/groq-key.mjs'),
  load('bridge/mistral-prompt.mjs'), load('bridge/reply-stream.mjs'), load('bridge/emotion-tags.mjs'), load('bridge/local-stt.mjs'),
  load('bridge/local-stt-capture.mjs')]);

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 && args[at + 1] ? args[at + 1] : fallback; };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const roster = [...JSON.parse(readFileSync(resolve(root, 'characters/roster.json'), 'utf8')), ...JSON.parse(readFileSync(resolve(root, 'characters/archetype-roster.json'), 'utf8'))];
const book = new PersonaBook(roster);

const SYNTH_LINES = [
  'Hey Judy, do you want to grab a drink at the Afterlife tonight?', 'Panam, can you cover me while I hack the terminal?',
  'Johnny, tell me what you remember about Arasaka Tower.', "Let's drive to Watson and look for Jackie's old friends.",
  'What do you think about Kerry Eddies and the Samurai reunion?', 'I just need a minute, then we head to Pacifica.', 'How are you?',
  'Thanks for the help.', 'Do you trust me?', 'Where did you get that jacket, it looks great on you.',
  'I have been thinking about what happened at the Heywood clinic and I still cannot sleep.',
  'Can you tell me about the time you first met Jackie, and what it was like in those early days at the Afterlife with all the mercs and fixers.',
  'Wake up, we have to go.', 'Is it true that the Aldecaldos are leaving Night City for good?', 'Come sit with me for a while.',
  'What would you do if you had one more day?', 'Tell me a story about your family.',
  'I think we should split up here and meet at the bar later tonight when things calm down.'];

function synthesize(directory) {
  const script = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$voices = @($s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
$lines = ConvertFrom-Json $env:BENCH_LINES
$n = 0
for ($i = 0; $i -lt $lines.Count; $i++) { for ($v = 0; $v -lt [Math]::Min(2, $voices.Count); $v++) {
  $s.SelectVoice($voices[$v]); $s.Rate = @(0, 1)[($i + $v) % 2]
  $s.SetOutputToWaveFile((Join-Path $env:BENCH_DIR ('clip-{0:00}.wav' -f $n)), $format)
  $s.Speak($lines[$i]); $s.SetOutputToNull()
  Set-Content -Path (Join-Path $env:BENCH_DIR ('clip-{0:00}.txt' -f $n)) -Value $lines[$i] -Encoding utf8
  $n++ } }
$s.Dispose()`;
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: {...process.env, BENCH_DIR: directory, BENCH_LINES: JSON.stringify(SYNTH_LINES)}, encoding: 'utf8'});
  if (run.status !== 0) throw Error('Windows speech synthesis failed: ' + (run.stderr || run.stdout));
}

// 16-bit PCM mono 16 kHz WAV -> Int16Array (what the synthesis above writes).
function readWav(path) {
  const b = readFileSync(path); let at = 12, data = null;
  while (at + 8 <= b.length) {
    const id = b.toString('latin1', at, at + 4), size = b.readUInt32LE(at + 4);
    if (id === 'data') { data = b.subarray(at + 8, at + 8 + Math.min(size, b.length - at - 8)); break; }
    at += 8 + size + (size & 1);
  }
  if (!data) throw Error(path + ': no audio');
  return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length - data.length % 2));
}
const noise = (count, seed) => { // about -72 dBFS, deterministic
  let a = seed >>> 0; const rand = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return Int16Array.from({length: count}, () => Math.round((rand() + rand() + rand() - 1.5) * 8));
};

// The model: Mistral's measured shape (docs/LATENCY_2026-10-12.md). Every request is logged; one the client closes early is counted as cancelled.
const REPLY = 'Hey choom, good to see you again. You look like you have not slept in days. Come on, sit down, I will make us something warm and you can tell me everything that happened out there.';
async function languageModel({firstTokenMs = 430, msPerChar = 2.6} = {}) {
  const log = {started: 0, finished: 0, cancelled: 0};
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', async () => {
      log.started++;
      let over = false;
      response.on('close', () => { if (!over) log.cancelled++; });
      response.writeHead(200, {'content-type': 'text/event-stream'});
      await sleep(firstTokenMs);
      for (const piece of REPLY.match(/.{1,6}/gs)) {
        if (response.destroyed) return;
        response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: piece}}]})}\n\n`);
        await sleep(piece.length * msPerChar);
      }
      over = true; log.finished++;
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {log, endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); })};
}

async function textHost(endpoint) {
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => 'api-key=aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL\n', writeText: async () => {}, groq: new GroqKey({keyPath: 'g.txt'})});
  await provider.load(); provider.setPreference('mistral'); provider.apply();
  const memory = await MistralMemory.open({path: null});
  return new TextProviderHost({provider, memory, personas: book, routes: {mistral: mistralRoute({provider, endpoint, gapMs: 0, cacheScope: 'bench'})}, log: () => {}});
}

const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const percentile = (values, p) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const round = value => value === null || value === undefined ? null : Math.round(value);

const VARIANTS = {
  baseline: {worker: 'baseline', pause: false, speculate: false},
  pause: {worker: 'new', pause: true, speculate: false},
  'b-only': {worker: 'baseline', pause: false, speculate: true},
  full: {worker: 'new', pause: true, speculate: true},
};

async function makeVariant(name, {python, model, workers}) {
  const variant = VARIANTS[name];
  const stt = new LocalStt({paths: {python, modelDirectory: model, worker: variant.worker === 'new' ? resolve(root, 'bridge/local-stt-worker.py') : workers.baseline},
    pausePartials: variant.pause, idleMs: 600_000});
  const availability = stt.availability();
  if (!availability.available) throw Error('Local speech recognition is not available: ' + availability.reason);
  await stt.warm();
  // The first recording of a worker pays for its one-off set-up; it is not measured.
  await stt.start('warm'); stt.pushAudio(Buffer.alloc(32000), 'warm'); await stt.finish('warm');
  const rows = [];
  let lastFinal = null, cpuBefore = 0;
  const realFinish = stt.finish.bind(stt);
  let finalAt = 0;
  stt.finish = async id => { const result = await realFinish(id); lastFinal = result; finalAt = performance.now(); return result; };
  { await stt.start('base'); stt.pushAudio(Buffer.alloc(32000), 'base'); await stt.finish('base'); cpuBefore = lastFinal?.cpuMs ?? 0; }
  const runTurn = async (gap, index, clip) => {
    const lead = Math.round(16000 * (0.5 + 0.1 * (index % 6))), speech = clip.samples;
    const audio = new Int16Array(lead + speech.length + Math.round(gap * 16));
    audio.set(noise(lead, index + 1)); audio.set(speech, lead); audio.set(noise(audio.length - lead - speech.length, index + 99), lead + speech.length);
    const server = await languageModel();
    const host = await textHost(server.endpoint);
    const calls = [];
    const channel = createLocalSttChannel({stt, speculate: () => variant.speculate,
      reply: (config, options) => { const call = {at: performance.now(), text: config.text, speculative: !!options.confirmed}; calls.push(call); return host.reply(config, options); },
      capture: (() => {
        let timer = null, sink = null;
        return {
          async begin(onChunk) {
            sink = onChunk; const started = performance.now(); let sent = 0;
            const tick = () => {
              const due = Math.min(audio.length, Math.floor((performance.now() - started) / 100) * 1600 + 1600);
              while (sent < due) { const end = Math.min(due, sent + 1600); sink?.(Buffer.from(audio.buffer, audio.byteOffset + sent * 2, (end - sent) * 2)); sent = end; }
              if (sent < audio.length) timer = setTimeout(tick, 100 - ((performance.now() - started) % 100));
            };
            timer = setTimeout(tick, 100);
            return {device: 'bench'};
          },
          async end() { await sleep(60); clearTimeout(timer); sink = null; },   // the capture page's flush and release
          async abort() { clearTimeout(timer); sink = null; },
        };
      })()})();
    try {
      await channel.beginVoice({requestId: `${name}-${gap}-${index}`});
      await sleep(audio.length / 16);                       // real time: the recording, up to the key press
      const stream = new ReplyStream({name: 'Judy Alvarez', isTag: hasEmotionTag});
      const config = {sessionId: 'bench', context: 'CURRENT PERSON\nBench.', local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}};
      let head = null; stream.headReady.then(text => { if (text) head = performance.now(); });
      const key = performance.now();
      const result = await channel.finishVoice(config, {stream, onTranscript: () => {}});
      const done = performance.now();
      // The reply request that was voiced: the speculative one when it was kept, else the last one made.
      const kept = result.timing?.speculation === 'kept';
      const voiced = kept ? calls.find(call => call.speculative) : calls.at(-1);
      // Let the discarded request's connection close so it is counted.
      await sleep(30);
      const cpu = (lastFinal?.cpuMs ?? cpuBefore) - cpuBefore; cpuBefore = lastFinal?.cpuMs ?? cpuBefore;
      rows.push({gap, clip: clip.name, key, audioSeconds: audio.length / 16000, text: result.userText, reference: clip.reference,
        timeToText: voiced.at - key, timeToHead: head === null ? null : head - key, total: done - key,
        speculation: result.timing?.speculation ?? 'none', requests: server.log.started, cancelled: server.log.cancelled,
        sttMs: finalAt - key, reused: lastFinal?.reused === true, calls: calls.length, cpu});
    } finally { await channel.close(); host.close(); await server.close(); }
  };
  return {name, rows, runTurn, close: () => stt.close()};
}

function summarise(name, rows, gaps) {
  const out = [];
  for (const gap of gaps) {
    const r = rows.filter(row => row.gap === gap);
    const tt = r.map(row => row.timeToText), th = r.filter(row => row.timeToHead !== null).map(row => row.timeToHead);
    const speculated = r.filter(row => row.speculation !== 'none');
    out.push({variant: name, gap, turns: r.length,
      timeToTextMs: {median: round(median(tt)), p90: round(percentile(tt, 0.9)), mean: round(tt.reduce((a, b) => a + b, 0) / tt.length)},
      timeToHeadMs: {median: round(median(th)), p90: round(percentile(th, 0.9)), mean: round(th.reduce((a, b) => a + b, 0) / (th.length || 1))},
      recogniserFinalMs: {median: round(median(r.map(row => row.sttMs))), p90: round(percentile(r.map(row => row.sttMs), 0.9))},
      slowTurns: r.filter(row => row.sttMs > 100).length,   // the final decode was not already done when the key was pressed
      workerCpuPerAudioSecond: +(r.reduce((sum, row) => sum + row.cpu, 0) / 1000 / r.reduce((sum, row) => sum + row.audioSeconds, 0)).toFixed(3),
      speculated: speculated.length, kept: r.filter(row => row.speculation === 'kept').length,
      restarted: r.filter(row => row.speculation === 'restarted' || row.speculation === 'failed').length,
      modelRequests: r.reduce((sum, row) => sum + row.requests, 0), cancelledRequests: r.reduce((sum, row) => sum + row.cancelled, 0)});
  }
  return out;
}

async function main() {
  const gaps = option('--gaps', '0,400,1000').split(',').map(Number);
  const names = option('--variants', 'baseline,pause,b-only,full').split(',');
  for (const name of names) if (!VARIANTS[name]) throw Error('unknown variant ' + name);
  const python = option('--python', resolve(root, 'vendor/pocket-tts-env/Scripts/python.exe'));
  const model = option('--model', process.env.CYBERPUNK_CONVAI_STT_MODEL ?? resolve(root, 'runtime/stt-model/moonshine-tiny-en-int8'));
  const temporary = mkdtempSync(join(tmpdir(), 'start-bench-'));
  try {
    let directory = option('--clips', null);
    if (!directory) { if (!args.includes('--synth')) throw Error('give --synth or --clips <dir>'); directory = join(temporary, 'clips'); mkdirSync(directory); synthesize(directory); }
    let clips = readdirSync(directory).filter(name => name.toLowerCase().endsWith('.wav')).sort().map(name => {
      const reference = join(directory, name.replace(/\.wav$/i, '.txt'));
      return {name, samples: readWav(join(directory, name)), reference: existsSync(reference) ? readFileSync(reference, 'utf8').trim() : null};
    });
    const limit = Number(option('--limit', 0)); if (limit) clips = clips.slice(0, limit);
    // The worker as it was (before this branch), for the baseline and b-only variants.
    const baselineWorker = join(temporary, 'baseline-worker.py');
    const shown = spawnSync('git', ['show', `${option('--baseline-ref', 'main')}:bridge/local-stt-worker.py`], {cwd: root, encoding: 'utf8', maxBuffer: 1 << 24});
    if (shown.status !== 0) throw Error('git show failed: ' + shown.stderr);
    writeFileSync(baselineWorker, shown.stdout);
    const all = [], summary = [];
    // The variants take turns on every clip (rotating the order), so a busy machine slows each of them alike.
    const variants = [];
    for (const name of names) variants.push(await makeVariant(name, {python, model, workers: {baseline: baselineWorker}}));
    let turn = 0;
    for (const gap of gaps) for (const [index, clip] of clips.entries()) {
      for (let at = 0; at < variants.length; at++) {
        const variant = variants[(at + turn) % variants.length];
        try { await variant.runTurn(gap, index, clip); } catch (error) { console.error(`${variant.name} gap ${gap} ${clip.name}: ${error.message}`); }
      }
      turn++;
    }
    for (const variant of variants) {
      all.push(...variant.rows.map(row => ({variant: variant.name, ...row})));
      for (const line of summarise(variant.name, variant.rows, gaps)) { summary.push(line); console.log(JSON.stringify(line)); }
      await variant.close();
    }
    const target = option('--json', null);
    if (target) writeFileSync(target, JSON.stringify({summary, rows: all}, null, 1));
  } finally { rmSync(temporary, {recursive: true, force: true}); }
  process.exit(0);
}
main().catch(error => { console.error(error.stack ?? error.message); process.exit(1); });
