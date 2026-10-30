// The Inworld cloud voice against the real API (docs/INWORLD.md, "Measured"): clones a character once through the bridge's own adapter,
// then makes a few short requests and prints the time to first audio. The audio can be saved to WAV files for listening. Nothing is played.
//
//   node scripts/Measure-InworldVoice.mjs --key-file <file> --references <runtime folder> [--out <folder>] [--profile judy-alvarez]
//        [--latency 3] [--gap 1500] [--store <voices file>] [--test-only]
//
// --key-file     a text file that holds the key on one line (the value Inworld's portal copies, or `api-key=<key>`). It is read in memory
//                and never printed. INWORLD_API_KEY in the environment is used when no file is given.
// --references   the `runtime` folder that holds `voice-references/` and `local-voices.autobest-long.json` / `-short.json`.
// --latency N    N short requests (first audio is the number the bridge logs as "first audio").
// --test-only    only the free voice-list request that Test connection makes.
// Every request spends the free allowance (about 70 minutes of speech once): N = 3 is about 10 seconds of speech and one clone.
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {InworldVoice, redact} from '../bridge/inworld-voice.mjs';
import {parseInworldKey, validateInworldKey} from '../bridge/inworld-key.mjs';
import {createVoiceProfileRegistry} from '../bridge/voice-profile-registry.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const flag = name => args.includes(name);
const PROFILE = option('--profile', 'judy-alvarez');
const RUNS = Number(option('--latency', 0)), GAP = Number(option('--gap', 1500));
const out = option('--out');
if (out) mkdirSync(out, {recursive: true});

function readKey() {
  const file = option('--key-file');
  return parseInworldKey(file ? readFileSync(file, 'utf8') : process.env.INWORLD_API_KEY ?? '');
}
const KEY = readKey();
if (!KEY) throw Error('no usable Inworld key');
console.log(`voice list request (Test connection): ${await validateInworldKey(KEY)}`);
if (flag('--test-only')) process.exit(0);

const references = option('--references');
if (!references) throw Error('--references <runtime folder> is required');
const registry = name => createVoiceProfileRegistry(JSON.parse(readFileSync(resolve(references, name), 'utf8')));
const voice = new InworldVoice({getKey: () => KEY, referenceRoot: resolve(references, 'voice-references'),
  registry: [registry('local-voices.autobest-long.json'), registry('local-voices.autobest-short.json')],
  storePath: option('--store', join(out ?? '.', 'inworld-voices.json')),
  onLog: message => process.stdout.write(redact(message, KEY))});

function wav(frames) {
  const samples = Buffer.alloc(frames.length * 2);
  frames.forEach((value, at) => samples.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), at * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36, 'latin1');
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

async function speak(text) {
  const pcm = [];
  const started = performance.now();
  const result = await voice.synthesizeStream(PROFILE, text, {onPcm: packet => { pcm.push(packet.pcm); }});
  const all = new Float32Array(pcm.reduce((sum, part) => sum + part.length, 0));
  let at = 0; for (const part of pcm) { all.set(part, at); at += part.length; }
  let energy = 0; for (const value of all) energy += value * value;
  return {result, audio: all, seconds: all.length / 24000, rms: Math.sqrt(energy / Math.max(1, all.length)), wallMs: performance.now() - started};
}
const sleep = ms => new Promise(done => setTimeout(done, ms));

// The voice is made first (and timed), so the replies below measure speech only.
const made = performance.now();
await voice.ensureVoice(PROFILE);
console.log(`voice ready for ${PROFILE} after ${Math.round(performance.now() - made)} ms (source ${voice.entries.get(PROFILE)?.source})`);

const firsts = [];
for (let run = 0; run < RUNS; run++) {
  const reply = await speak('Hey V. What do you need?');
  firsts.push(reply.result.timing.voiceFirstPcmReceivedMs);
  console.log(`run ${run + 1}: first audio ${Math.round(reply.result.timing.voiceFirstPcmReceivedMs)} ms, total ${Math.round(reply.result.timing.voiceGenerationMs)} ms, ${reply.seconds.toFixed(2)} s of speech, rms ${reply.rms.toFixed(3)}`);
  if (out && run === 0) writeFileSync(join(out, 'inworld-short.wav'), wav(reply.audio));
  await sleep(GAP);
}
if (RUNS) {
  const sorted = [...firsts].sort((a, b) => a - b);
  console.log(`first audio over ${RUNS} runs: min ${Math.round(sorted[0])}, median ${Math.round(sorted[Math.floor(sorted.length / 2)])}, max ${Math.round(sorted.at(-1))} ms`);
}
console.log(`characters spoken: ${voice.chars}`);
process.exit(0);
