// Why does the Mistral cloud voice (Voxtral) sound muffled? Real-API A/B of the REFERENCE clip (docs/CLOUD_VOICE_VOXTRAL.md).
//
//   node scripts/Measure-VoxtralClarity.mjs <outDir> [--profile judy-alvarez] [--rounds 4] [--gap 3500] [--plan "A,C2;A,B;..."] [--nonstream] [--ref NAME=file]...
//
// Voxtral clones the recording it is given, including how far up its spectrum reaches, so the reference's bandwidth matters. Each variant
// is one real `POST /v1/audio/speech` with the SAME line and the bridge's own body (`response_format: 'pcm'`, `stream: true`); the raw
// float32 24 kHz answer is saved untouched as a 32-bit float WAV (<outDir>/<variant>-<n>.wav). Timings use performance.now() from the
// send: headers, first audio chunk, first 100 ms frame, end (as the bridge logs them). Variants are interleaved round by round.
// --nonstream makes two extra calls (response_format 'wav' and 'mp3', stream false) to compare with the streamed PCM.
// References (what is sent as ref_audio): A 16 kHz MP3 32k (what versions 1 and 2 of bridge/voxtral-reference.mjs made), B 16 kHz MP3 64k,
// C1 24 kHz WAV, C2 24 kHz MP3 48k, C3 24 kHz MP3 96k, C4 24 kHz MP3 40k (what version 3 made), V4 24 kHz Ogg Vorbis q2 (what version 4 makes), D the original clip whole, E the 16 kHz WAV.
// Nothing is played. Measure the files with scripts/Measure-VoxtralClarity.py. The key is read in memory exactly as
// scripts/Measure-VoxtralLatency.mjs reads it, goes only in the Authorization header and is never printed or written.
// Request budget: the plan has 16 calls by default (four rounds of four), plus 2 with --nonstream. Keep it small: the free key allows 12,000
// input characters a minute.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve, join, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareReference, encodeMp3, encodeVorbis, REFERENCE_PREPARATION} from '../bridge/voxtral-reference.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outDir = args.find((arg, at) => !arg.startsWith('--') && !(args[at - 1] ?? '').startsWith('--'));
if (!outDir) { console.error('usage: node scripts/Measure-VoxtralClarity.mjs <outDir> [options]'); process.exit(2); }
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const PROFILE = option('--profile', 'judy-alvarez'), ROUNDS = Number(option('--rounds', 4)), GAP = Number(option('--gap', 3500));
const TEXT = option('--text', 'Hey, V. You look like you haven’t slept in days. Come on, sit down, I made some tea, and you can tell me what happened out there.');
mkdirSync(outDir, {recursive: true});

const text = readFileSync(resolve(root, 'runtime/player-mistral-key.txt'), 'utf8');
const KEY = (text.match(/[A-Za-z0-9_\-]{20,}/g) ?? []).pop();
if (!KEY) throw Error('no Mistral key in runtime/player-mistral-key.txt');
const redact = value => String(value ?? '').split(KEY).join('[key]');

// ---- the references ----------------------------------------------------------------------------------------------------------------
const configs = JSON.parse(readFileSync(resolve(root, 'runtime/voice-configs.json'), 'utf8'));
const longSet = JSON.parse(readFileSync(resolve(root, 'runtime', configs.omni.long), 'utf8'));
const original = readFileSync(resolve(root, longSet.voices[PROFILE].reference));          // the OmniVoice long-set clip, as stored
const cut16 = prepareReference(original, {...REFERENCE_PREPARATION, targetRate: 16000});   // what versions 1 and 2 of the preparer made (16 kHz)
const cut24 = prepareReference(original, {...REFERENCE_PREPARATION, targetRate: 24000});   // the same cut, no 16 kHz step
const mp3 = (wav, bitrate) => encodeMp3(wav, {ffmpeg: process.env.CYBERPUNK_CONVAI_FFMPEG || 'ffmpeg', bitrate});
const REFERENCES = {
  A:  {label: '16k-mp3-32k (v2)',    format: 'mp3', bytes: await mp3(cut16.wav, '32k')},
  B:  {label: '16k-mp3-64k',         format: 'mp3', bytes: await mp3(cut16.wav, '64k')},
  C1: {label: '24k-wav',             format: 'wav', bytes: cut24.wav},
  C2: {label: '24k-mp3-48k',         format: 'mp3', bytes: await mp3(cut24.wav, '48k')},
  C3: {label: '24k-mp3-96k',         format: 'mp3', bytes: await mp3(cut24.wav, '96k')},
  C4: {label: '24k-mp3-40k',         format: 'mp3', bytes: await mp3(cut24.wav, '40k')},
  E:  {label: '16k-wav',             format: 'wav', bytes: cut16.wav},          // what a player without ffmpeg sends
  D:  {label: 'original-wav',        format: 'wav', bytes: original},
  V4: {label: '24k-vorbis-q2 (v4)',  format: 'ogg', bytes: await encodeVorbis(cut24.wav, {ffmpeg: process.env.CYBERPUNK_CONVAI_FFMPEG || 'ffmpeg'})},   // what version 4 makes
};
// --ref NAME=path (repeatable): any other reference file, sent as it is (the server recognises the format itself). Used for the format
// search of 2026-10-13: FLAC, Opus, Vorbis, AAC, MP3 variants (docs/CLOUD_VOICE_VOXTRAL.md).
for (let at = 0; at < args.length; at++) {
  if (args[at] !== '--ref') continue;
  const [name, path] = [args[at + 1].slice(0, args[at + 1].indexOf('=')), args[at + 1].slice(args[at + 1].indexOf('=') + 1)];
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  REFERENCES[name] = {label: basename(path).replace(/\.[^.]+$/, ''), format: extension, bytes: readFileSync(path)};
}
for (const [name, ref] of Object.entries(REFERENCES)) writeFileSync(join(outDir, `ref-${name}-${ref.label}.${ref.format}`), ref.bytes);

// ---- one request, the bridge's body and the bridge's timing ----------------------------------------------------------------------
function wavFloat32(samples, rate) {
  const header = Buffer.alloc(44), data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(32, 34); header.write('data', 36, 'latin1'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
async function speak(reference, {responseFormat = 'pcm', stream = true, saveAs}) {
  const body = JSON.stringify({model: 'voxtral-mini-tts-latest', input: TEXT, ref_audio: reference.bytes.toString('base64'), response_format: responseFormat, ...(stream ? {stream: true} : {})});
  const out = {bodyBytes: Buffer.byteLength(body)};
  const t0 = performance.now();
  try {
    const response = await fetch('https://api.mistral.ai/v1/audio/speech', {method: 'POST',
      headers: {authorization: `Bearer ${KEY}`, 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json'}, body});
    out.status = response.status; out.headersMs = Math.round(performance.now() - t0);
    if (!response.ok) { out.error = redact(await response.text()).slice(0, 200); return out; }
    if (!stream) {
      const json = await response.json(); out.totalMs = Math.round(performance.now() - t0);
      const bytes = Buffer.from(json.audio_data ?? '', 'base64');
      writeFileSync(join(outDir, saveAs + (responseFormat === 'pcm' ? '.f32' : '.' + responseFormat)), bytes);
      out.audioBytes = bytes.length; return out;
    }
    const decoder = new TextDecoder(); let buffer = '', carry = Buffer.alloc(0), samples = 0; const parts = [];
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, {stream: true});
      let at;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, at); buffer = buffer.slice(at + 2);
        const line = block.split('\n').find(item => item.startsWith('data:'));
        if (!line) continue;
        let event; try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (event.type !== 'speech.audio.delta' || typeof event.audio_data !== 'string') continue;
        const joined = Buffer.concat([carry, Buffer.from(event.audio_data, 'base64')]), whole = joined.length - (joined.length % 4);
        carry = joined.subarray(whole); parts.push(joined.subarray(0, whole)); samples += whole / 4;
        out.firstChunkMs ??= Math.round(performance.now() - t0);
        if (out.firstFrameMs === undefined && samples >= 2400) out.firstFrameMs = Math.round(performance.now() - t0);
      }
    }
    out.totalMs = Math.round(performance.now() - t0); out.audioSeconds = +(samples / 24000).toFixed(2);
    if (samples) {
      const pcm = Buffer.concat(parts), floats = new Float32Array(pcm.length / 4);
      for (let i = 0; i < floats.length; i++) floats[i] = pcm.readFloatLE(i * 4);
      writeFileSync(join(outDir, saveAs + '.wav'), wavFloat32(floats, 24000));
    }
  } catch (error) { out.error = redact(error?.message); }
  return out;
}

// ---- the plan: interleaved rounds -------------------------------------------------------------------------------------------------
// --plan "A,C2,B,C1;A,C2,C3,D;...": one group per round (default: A and C2 every round, B, C1, C3 and D in turn; the 2026-10-13 re-run used "A,C4;A,C4;A,C4,E").
const PLAN = option('--plan', 'A,C2,B,C1;A,C2,C3,D;A,C2,B,C1;A,C2,C3,D').split(';').slice(0, ROUNDS).map(round => round.split(',').filter(name => REFERENCES[name]));
const names = [...new Set(PLAN.flat())];
const calls = [], counts = {};
const sleep = ms => new Promise(done => setTimeout(done, ms));
for (let round = 0; round < PLAN.length; round++) {
  for (const name of PLAN[round]) {
    counts[name] = (counts[name] ?? 0) + 1;
    const row = {variant: name, label: REFERENCES[name].label, n: counts[name], round: round + 1, refBytes: REFERENCES[name].bytes.length,
      ...await speak(REFERENCES[name], {saveAs: `${name}-${REFERENCES[name].label}-${counts[name]}`})};
    calls.push(row);
    console.error(`${name} #${row.n}: ${row.status ?? '-'} body ${row.bodyBytes} headers ${row.headersMs ?? '-'} first ${row.firstChunkMs ?? '-'} total ${row.totalMs ?? '-'}${row.error ? ' ' + row.error : ''}`);
    await sleep(GAP);
  }
}
if (args.includes('--nonstream')) {
  for (const responseFormat of ['wav', 'mp3']) {
    const row = {variant: 'A', label: 'nonstream-' + responseFormat, refBytes: REFERENCES.A.bytes.length, ...await speak(REFERENCES.A, {responseFormat, stream: false, saveAs: `A-nonstream-${responseFormat}`})};
    calls.push(row); console.error(`A non-stream ${responseFormat}: ${row.status ?? '-'} headers ${row.headersMs ?? '-'} total ${row.totalMs ?? '-'}${row.error ? ' ' + row.error : ''}`);
    await sleep(GAP);
  }
}
writeFileSync(join(outDir, 'calls.json'), JSON.stringify({at: new Date().toISOString(), text: TEXT, characters: TEXT.length, profile: PROFILE, calls}, null, 1));
const median = values => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
console.table(Object.keys(REFERENCES).filter(name => counts[name]).map(name => {
  const rows = calls.filter(row => row.variant === name && row.status === 200 && row.firstChunkMs !== undefined);
  return {variant: name, label: REFERENCES[name].label, n: rows.length, bodyBytes: rows[0]?.bodyBytes, headersMs: median(rows.map(row => row.headersMs)), firstAudioMs: median(rows.map(row => row.firstChunkMs)),
    min: Math.min(...rows.map(row => row.firstChunkMs)), max: Math.max(...rows.map(row => row.firstChunkMs))};
}));
