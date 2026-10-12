// The Inworld cloud voice against the real API (docs/CLOUD_VOICE_INWORLD.md, "Measured"): clones a character once through the
// bridge's own adapter, then makes a few requests and saves the audio for listening. Nothing is played: the audio is written to WAV files.
//
//   node scripts/Measure-InworldVoice.mjs --key-file <file> --references <runtime folder> --out <folder> [--profile judy-alvarez]
//        [--latency 6] [--samples] [--store <voices file>] [--gap 1500]
//
// --key-file     a text file with a line naming Inworld (`Inworld: <key>`); only that line is read, in memory, and it is never printed.
//                INWORLD_API_KEY in the environment is used when no file is given.
// --references   the `runtime` folder that holds `voice-references/` and `local-voices.autobest-long.json` / `-short.json`.
// --latency N    N short requests (first audio is the number the bridge logs as "first audio").
// --samples      also render the listening samples (a plain line, an angry line with and without steering, a sad one).
// --untagged     also render three short replies: two with no feeling tag (steered from their words) and one with a laugh sound.
// Every request costs free minutes (the plan has about 70): this makes about 7 replies of 3 to 7 s with --latency 6 --samples.
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {InworldVoice, redact} from '../bridge/inworld-voice.mjs';
import {createVoiceProfileRegistry} from '../bridge/voice-profile-registry.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const flag = name => args.includes(name);
const PROFILE = option('--profile', 'judy-alvarez');
const RUNS = Number(option('--latency', 0)), GAP = Number(option('--gap', 1500));
const out = option('--out');
const references = option('--references');
if (!references) throw Error('--references <runtime folder> is required');
if (out) mkdirSync(out, {recursive: true});

function readKey() {
  const file = option('--key-file');
  if (!file) return process.env.INWORLD_API_KEY || null;
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find(text => /inworld/i.test(text));
  const value = line?.replace(/^[^:=]*[:=]\s*/, '').trim();
  return value?.split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length)[0] ?? null;
}
const KEY = readKey();
if (!KEY) throw Error('no Inworld key');

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

async function speak(text, emotion) {
  const pcm = [];
  const started = performance.now();
  const result = await voice.synthesizeStream(PROFILE, text, {emotion, onPcm: packet => { pcm.push(packet.pcm); }});
  const all = new Float32Array(pcm.reduce((sum, part) => sum + part.length, 0));
  let at = 0; for (const part of pcm) { all.set(part, at); at += part.length; }
  let energy = 0; for (const value of all) energy += value * value;
  return {result, audio: all, seconds: all.length / 24000, rms: Math.sqrt(energy / Math.max(1, all.length)), wallMs: performance.now() - started};
}
const save = (name, run) => { if (out) writeFileSync(join(out, name), wav(run.audio)); };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const summary = run => `first audio ${Math.round(run.result.timing.voiceFirstPcmReceivedMs)} ms, total ${Math.round(run.result.timing.voiceGenerationMs)} ms, ${run.seconds.toFixed(2)} s of speech, rms ${run.rms.toFixed(3)}, tags ${run.result.timing.voiceEmotionTags}`;

// The voice is made first (and timed), so the replies below measure speech only.
const made = performance.now();
await voice.ensureVoice(PROFILE);
console.log(`voice ready for ${PROFILE} after ${Math.round(performance.now() - made)} ms (source ${voice.entries.get(PROFILE)?.source})`);

const results = {latency: [], samples: {}};
const SHORT = 'Hey V. What do you need?';
for (let run = 0; run < RUNS; run++) {
  const reply = await speak(SHORT);
  results.latency.push(reply.result.timing.voiceFirstPcmReceivedMs);
  console.log(`latency run ${run + 1}: ${summary(reply)}`);
  if (run === 0) save('judy-short-plain.wav', reply);
  await sleep(GAP);
}
if (RUNS) {
  const sorted = [...results.latency].sort((a, b) => a - b);
  console.log(`first audio over ${RUNS} runs: min ${Math.round(sorted[0])}, median ${Math.round(sorted[Math.floor(sorted.length / 2)])}, max ${Math.round(sorted.at(-1))} ms`);
}

if (flag('--samples')) {
  const lines = {
    plain: 'Hey V. I was just tinkering with a braindance, but it can wait. What do you need?',
    anger: 'Back off! Touch her again and I swear I will put you through that wall!',
    sadness: 'I miss him, you know. Some nights the whole city goes quiet, and all I hear is his voice.',
  };
  const plain = await speak(lines.plain);
  save('judy-1-plain.wav', plain); console.log('judy-1-plain:', summary(plain));
  const angerPlain = await speak(lines.anger);
  save('judy-2-anger-plain.wav', angerPlain); console.log('judy-2-anger-plain:', summary(angerPlain));
  const angerSteered = await speak(lines.anger, {marks: [{at: 0, name: 'anger', strength: 'strong'}]});
  save('judy-3-anger-steered.wav', angerSteered); console.log('judy-3-anger-steered:', summary(angerSteered));
  const sadness = await speak(lines.sadness, {marks: [{at: 0, name: 'sadness', strength: 'subtle'}]});
  save('judy-4-sadness-steered.wav', sadness); console.log('judy-4-sadness-steered:', summary(sadness));
  results.samples = {plain: plain.seconds, angerPlain: angerPlain.seconds, angerSteered: angerSteered.seconds, sadness: sadness.seconds};
}
if (flag('--untagged')) {
  // Replies as a provider that wrote no feeling tag would give them: the steering comes from the words alone (the fallback).
  // And one with a non-verbal sound written the way Natural speech writes it (OmniVoice's [laughter], mapped to Inworld's [laugh]).
  const sad = await speak('I am so sorry, V. I really miss him, you know. Some nights it still hurts.');
  save('judy-5-untagged-sadness-from-words.wav', sad); console.log('judy-5-untagged-sadness:', summary(sad));
  const anger = await speak('Back off! Touch her again and I swear I will end you.');
  save('judy-6-untagged-anger-from-words.wav', anger); console.log('judy-6-untagged-anger:', summary(anger));
  const text = 'I told him no, and he still showed up. Typical.';
  const laugh = await speak(text, {marks: [{at: 0, name: 'joy', strength: 'subtle'}], sounds: [{at: text.indexOf('and'), name: 'laughter'}]});
  save('judy-7-laugh-sound.wav', laugh); console.log('judy-7-laugh-sound:', summary(laugh), `sounds ${laugh.result.timing.voiceSounds}`);
}
console.log(`characters spoken: ${voice.chars}`);
if (out) {
  // Merged into what an earlier run left, so a second run (--untagged) does not erase the first one's numbers.
  const file = join(out, 'results.json');
  let before = {}; try { before = JSON.parse(readFileSync(file, 'utf8')); } catch { /* the first run */ }
  writeFileSync(file, JSON.stringify({...before, profile: PROFILE, ...(RUNS ? {latency: results.latency} : {}),
    ...(flag('--samples') ? {samples: results.samples} : {}), chars: (before.chars ?? 0) + voice.chars}, null, 2));
}
