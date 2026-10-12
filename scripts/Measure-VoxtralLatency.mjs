// Voxtral time to first audio against the real API, text-to-speech only (docs/LATENCY_2026-10-12.md, section "2026-10-13").
//
//   node scripts/Measure-VoxtralLatency.mjs [--runs 4] [--gap 3500] [--variants base,short-text,...] [--json out.json]
//
// Every variant is one real `POST /v1/audio/speech` with `ref_audio` and `stream: true`, exactly the body the bridge sends. Nothing is
// played: the audio is counted and thrown away (no browser, no speakers). Variants are interleaved round by round so a slow minute on
// the server hits all of them alike. The key is the one the bridge uses (`runtime/player-mistral-key.txt`), read in memory, only ever
// put in the Authorization header, never printed. The reference is the character's prepared clip (`runtime/voice-references/prepared/`);
// shorter or smaller clips are cut from it with ffmpeg into a temporary folder.
//
// Columns: send to response headers, send to first audio (the number the bridge logs as "first audio"), send to the end, body bytes.
import {readFileSync, mkdtempSync, writeFileSync, mkdirSync} from 'node:fs';
import {encodeWav16} from '../bridge/voxtral-reference.mjs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import https from 'node:https';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const RUNS = Number(option('--runs', 4)), GAP = Number(option('--gap', 3500));
const FFMPEG = process.env.CYBERPUNK_CONVAI_FFMPEG || 'ffmpeg';
const PROFILE = option('--profile', 'judy-alvarez');
// --save <folder>: also write each call's audio there as a WAV (for listening and speaker-similarity checks). Nothing is played.
const SAVE = option('--save');
if (SAVE) mkdirSync(SAVE, {recursive: true});

const readKey = () => {
  const text = readFileSync(resolve(root, 'runtime/player-mistral-key.txt'), 'utf8');
  const key = (text.match(/[A-Za-z0-9_\-]{20,}/g) ?? []).pop();
  if (!key) throw Error('no Mistral key in runtime/player-mistral-key.txt');
  return key;
};
const KEY = readKey();
const redact = value => String(value ?? '').split(KEY).join('[key]');

// ---- references -------------------------------------------------------------------------------------------------------------------
const prepared = readFileSync(resolve(root, `runtime/voice-references/prepared/${PROFILE}.mp3`));
const work = mkdtempSync(join(tmpdir(), 'voxtral-latency-'));
writeFileSync(join(work, 'base.mp3'), prepared);
function cut(name, seconds, bitrate) {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(work, 'base.mp3'), '-t', String(seconds), '-ac', '1', '-c:a', 'libmp3lame', '-b:a', bitrate, join(work, name + '.mp3')]);
  return readFileSync(join(work, name + '.mp3'));
}
const REFERENCES = {base: prepared, ref4: cut('ref4', 4, '64k'), ref2p5: cut('ref2p5', 2.5, '64k'), ref4lo: cut('ref4lo', 4, '24k'),
  ref8lo: cut('ref8lo', 9, '24k'), ref8mid: cut('ref8mid', 9, '32k'), ref5: cut('ref5', 5, '48k'), re64: cut('re64', 9, '64k'), re32: cut('re32', 9, '32k')};

// ---- the texts (real replies from the 2026-10-13 live turns) ----------------------------------------------------------------------------
const TEXT = {
  long: 'No, it’s not. It’s a workshop. I just finished a few tweaks on a couple of old dolls, some Clouds leftovers, if you can believe that.',
  head: 'Work’s… work. But I mean, the kind of work that lets me decide what to leave in and what to cut out.',
  first: 'No, it’s not. It’s a workshop.',
  tiny: 'Hey. What’s up?',
};

// variant: reference + text (+ options)
const VARIANTS = {
  'base':          {ref: 'base',   text: 'long'},
  'text-head':     {ref: 'base',   text: 'head'},
  'text-first':    {ref: 'base',   text: 'first'},
  'text-tiny':     {ref: 'base',   text: 'tiny'},
  'ref-4s':        {ref: 'ref4',   text: 'long'},
  'ref-2.5s':      {ref: 'ref2p5', text: 'long'},
  'ref-4s-24k':    {ref: 'ref4lo', text: 'long'},
  'ref-4s-first':  {ref: 'ref4',   text: 'first'},
  'ref-8s-24k':    {ref: 'ref8lo', text: 'long'},
  'ref-8s-32k':    {ref: 'ref8mid', text: 'long'},
  'ref-5s-48k':    {ref: 'ref5',   text: 'long'},
  'reenc-8s-64k':  {ref: 're64', text: 'long'},
  'reenc-8s-32k':  {ref: 're32', text: 'long'},
  'warm-conn':     {ref: 'base',   text: 'long', warm: true},
  'keepalive':     {ref: 'base',   text: 'long', keepAlive: true},
};

const agent = new https.Agent({keepAlive: true, keepAliveMsecs: 30_000});
const sleep = ms => new Promise(done => setTimeout(done, ms));

// One request over node:https (so a connection can be kept alive across calls). Returns the timings.
function speak({text, reference, keepAlive = false, signal, saveAs}) {
  const body = JSON.stringify({model: 'voxtral-mini-tts-latest', input: text, ref_audio: reference.toString('base64'), response_format: 'pcm', stream: true});
  return new Promise(resolveCall => {
    const t0 = performance.now(), out = {bodyBytes: Buffer.byteLength(body)};
    const request = https.request('https://api.mistral.ai/v1/audio/speech', {method: 'POST', agent: keepAlive ? agent : false,
      headers: {authorization: `Bearer ${KEY}`, 'content-type': 'application/json', accept: 'text/event-stream', 'content-length': Buffer.byteLength(body)}}, response => {
      out.status = response.statusCode; out.headersMs = Math.round(performance.now() - t0);
      let buffer = '', samples = 0, carry = 0;
      const audio = [];
      const done = () => {
        if (SAVE && saveAs && audio.length) { const pcm = Buffer.concat(audio); writeFileSync(join(SAVE, saveAs + '.wav'), encodeWav16(Float32Array.from({length: pcm.length >> 2}, (_, at) => pcm.readFloatLE(at * 4)), 24000)); } out.totalMs = Math.round(performance.now() - t0); out.audioSeconds = +(samples / 24000).toFixed(2); resolveCall(out); };
      response.on('data', chunk => {
        buffer += chunk.toString('utf8');
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
          const line = block.split('\n').find(item => item.startsWith('data:'));
          if (!line) continue;
          try {
            const event = JSON.parse(line.slice(5).trim());
            if (event.type === 'speech.audio.delta' && typeof event.audio_data === 'string') {
              const chunkBytes = Buffer.from(event.audio_data, 'base64');
              if (SAVE && saveAs) audio.push(chunkBytes);
              const bytes = chunkBytes.length + carry;
              samples += Math.floor(bytes / 4); carry = bytes % 4;
              if (out.firstAudioMs === undefined && samples >= 2400) out.firstAudioMs = Math.round(performance.now() - t0);
              if (out.firstChunkMs === undefined) out.firstChunkMs = Math.round(performance.now() - t0);
            }
          } catch { /* a partial event */ }
        }
      });
      response.on('end', done);
      response.on('error', error => { out.error = redact(error.message); done(); });
      if (response.statusCode !== 200) { let text = ''; response.on('data', c => { text += c; if (text.length < 300) out.error = redact(text.slice(0, 200)); }); }
    });
    request.on('socket', socket => { socket.once('secureConnect', () => { out.connectMs = Math.round(performance.now() - t0); }); });
    request.on('finish', () => { out.sentMs = Math.round(performance.now() - t0); });
    request.on('error', error => { out.error = redact(error.message); out.totalMs = Math.round(performance.now() - t0); resolveCall(out); });
    signal?.addEventListener('abort', () => request.destroy(), {once: true});
    request.write(body); request.end();
  });
}

// A throwaway GET on the same keep-alive agent: opens (or refreshes) the connection so the next request does not pay for it.
const warmUp = () => new Promise(resolveCall => {
  const t0 = performance.now();
  const request = https.request('https://api.mistral.ai/v1/models', {method: 'GET', agent, headers: {authorization: `Bearer ${KEY}`}}, response => {
    response.resume(); response.on('end', () => resolveCall(Math.round(performance.now() - t0)));
  });
  request.on('error', () => resolveCall(-1)); request.end();
});

// --pairs N: N rounds of two identical requests sent together (a hedge). Prints the single (first sent) against the faster of the two, and a
// hedge that is only sent after D ms without audio (D = 600, 800, 1000).
const PAIRS = Number(option('--pairs', 0));
if (PAIRS) {
  const rows = [];
  for (let round = 0; round < PAIRS; round++) {
    const pair = await Promise.all([speak({text: TEXT[option('--text', 'head')], reference: REFERENCES.base}), speak({text: TEXT[option('--text', 'head')], reference: REFERENCES.base})]);
    rows.push(pair.map(row => row.firstAudioMs ?? Infinity));
    process.stderr.write(`pair ${round + 1}/${PAIRS}: ${rows.at(-1).join(' / ')}\n`);
    await sleep(GAP);
  }
  const med = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
  const mean = values => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  const singles = rows.map(row => row[0]), both = rows.flat();
  const report = {rounds: PAIRS, single: {median: med(both), mean: mean(both), max: Math.max(...both)}, parallelPair: {median: med(rows.map(row => Math.min(...row))), mean: mean(rows.map(row => Math.min(...row))), max: Math.max(...rows.map(row => Math.min(...row)))}};
  for (const delay of [500, 700, 900, 1100]) {
    const firsts = rows.map(row => Math.min(row[0], delay + row[1]));
    report['hedgeAfter' + delay] = {median: med(firsts), mean: mean(firsts), max: Math.max(...firsts), hedgesSent: rows.filter(row => row[0] > delay).length};
  }
  void singles;
  console.log(JSON.stringify(report, null, 1));
  agent.destroy();
  process.exit(0);
}

const names = (option('--variants', '') || Object.keys(VARIANTS).join(',')).split(',').filter(name => VARIANTS[name]);
const results = Object.fromEntries(names.map(name => [name, []]));
for (let round = 0; round < RUNS; round++) {
  for (const name of names) {
    const variant = VARIANTS[name];
    let warmMs;
    if (variant.warm || variant.keepAlive) warmMs = await warmUp();
    const row = await speak({text: TEXT[variant.text], reference: REFERENCES[variant.ref], keepAlive: variant.keepAlive || variant.warm, saveAs: `${name}-${round + 1}`});
    if (warmMs !== undefined) row.warmMs = warmMs;
    results[name].push(row);
    process.stderr.write(`${round + 1}/${RUNS} ${name}: ${row.status ?? '-'} headers ${row.headersMs ?? '-'} first ${row.firstAudioMs ?? '-'} total ${row.totalMs}${row.error ? ' ' + row.error : ''}\n`);
    await sleep(GAP);
  }
}

const median = values => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
const table = names.map(name => {
  const rows = results[name], ok = rows.filter(row => row.status === 200 && row.firstAudioMs !== undefined);
  return {variant: name, ref: VARIANTS[name].ref, refKB: +(REFERENCES[VARIANTS[name].ref].length / 1024).toFixed(1), chars: TEXT[VARIANTS[name].text].length, ok: `${ok.length}/${rows.length}`,
    connect: median(ok.map(row => row.connectMs)), sent: median(ok.map(row => row.sentMs)), headers: median(ok.map(row => row.headersMs)), firstAudio: median(ok.map(row => row.firstAudioMs)), min: Math.min(...ok.map(row => row.firstAudioMs)), max: Math.max(...ok.map(row => row.firstAudioMs)),
    total: median(ok.map(row => row.totalMs)), seconds: median(ok.map(row => row.audioSeconds))};
});
console.table(table);
const json = option('--json');
if (json) writeFileSync(json, JSON.stringify({at: new Date().toISOString(), runs: RUNS, results, table}, null, 1));
agent.destroy();
