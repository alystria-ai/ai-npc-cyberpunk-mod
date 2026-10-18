// Synthesizes ONE scripted line with the mod's three voice engines (Pocket TTS, the Mistral cloud voice, the Inworld cloud voice)
// and writes one 24 kHz mono 16-bit WAV per engine. It builds the engines the way bridge/convai-bridge.mjs does and reads the
// player's keys and reference clips in place (nothing is copied); no key is ever printed, logged or written.
//
//   node scripts/Synthesize-ScriptedTakes.mjs [--engines pocket,voxtral,inworld] [--out <folder>] [--state <folder>]
//        [--name jackie-welcome] [--voice jackie-welles] [--pocket-work <folder>] [--pocket-threads 2]
//
// Pocket runs a SEPARATE worker with its own work folder, so it never shares the running bridge's work-folder lock.
// Audio is never played.
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseTagged} from '../bridge/natural-speech.mjs';
import {encodeWav16, createReferencePreparer} from '../bridge/voxtral-reference.mjs';
import {VoxtralVoice} from '../bridge/voxtral-voice.mjs';
import {InworldVoice} from '../bridge/inworld-voice.mjs';
import {steerText} from '../bridge/inworld-steering.mjs';
import {createVoiceProfileRegistry} from '../bridge/voice-profile-registry.mjs';
import {PocketVoice, validatePocketConfig} from '../bridge/pocket-voice.mjs';
import {resolveVoiceConfigPaths} from '../bridge/voice-config-paths.mjs';
import {MISTRAL_KEY_FILE, parseMistralKey} from '../bridge/mistral-key.mjs';
import {INWORLD_KEY_FILE, parseInworldKey} from '../bridge/inworld-key.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argument = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 ? process.argv[at + 1] : fallback; };
const stateDirectory = resolve(argument('state', process.env.CYBERPUNK_CONVAI_STATE || 'C:\\Users\\akshi\\Desktop\\Code Palace\\Cyberpunk Mod\\runtime'));
const outDirectory = resolve(argument('out', 'C:\\Users\\akshi\\Desktop\\Code Palace\\demo-video\\takes'));
const baseName = argument('name', 'jackie-welcome');
const voiceKey = argument('voice', 'jackie-welles');
const engines = argument('engines', 'pocket,voxtral,inworld').split(',').map(value => value.trim()).filter(Boolean);
const pocketWork = resolve(argument('pocket-work', resolve(stateDirectory, '..', '..', 'demo-video', 'takes', '.pocket-work')));
const pocketThreads = Number(argument('pocket-threads', '2'));
// Where a developer's notes keep an `inworld=<key>` line when the bridge's own player-inworld-key.txt does not exist.
const inworldFallbackFile = argument('inworld-notes', '');

const TAGGED = "{joy:strong}V! Hermano, listen up. Now you can actually talk to us. Say it or type it, and we answer back in our own voice. {warm}Bring me along, I ride shotgun, I got your back, and I don't forget nothin'. {interest}And it can run right on your own rig, no eddies. {joy}Preem, right?";
const CLEAN = "V! Hermano, listen up. Now you can actually talk to us. Say it or type it, and we answer back in our own voice. Bring me along, I ride shotgun, I got your back, and I don't forget nothin'. And it can run right on your own rig, no eddies. Preem, right?";

const parsed = parseTagged(TAGGED);
if (parsed.display !== CLEAN) throw Error(`The tagged line does not parse to the clean line: ${JSON.stringify(parsed.display)}`);
const emotionMarks = parsed.marks;
console.log(`Line: ${CLEAN.length} characters, ${emotionMarks.length} emotion marks: ${emotionMarks.map(mark => `${mark.name}${mark.strength === 'strong' ? ':strong' : ''}@${mark.at}`).join(' ')}`);

// Any key-shaped run of characters is removed from whatever is printed.
const scrub = text => String(text ?? '').replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, '[key]');
const readText = async path => readFile(path, 'utf8').catch(() => null);

// ---- keys (read in place, kept in memory only) ------------------------------------------------------------------------
const mistralKey = parseMistralKey(await readText(resolve(stateDirectory, MISTRAL_KEY_FILE)));
let inworldKey = parseInworldKey(await readText(resolve(stateDirectory, INWORLD_KEY_FILE))), inworldKeySource = INWORLD_KEY_FILE;
if (!inworldKey) {
  const notes = await readText(inworldFallbackFile);
  const line = notes?.split(/\r?\n/).map(entry => entry.trim()).find(entry => /^inworld(?:[-_ ]?(?:api[-_ ]?)?key)?\s*[=:]/i.test(entry));
  inworldKey = line ? parseInworldKey(line.replace(/^inworld(?:[-_ ]?(?:api[-_ ]?)?key)?\s*[=:]\s*/i, '')) : null;
  inworldKeySource = inworldKey ? 'developer key notes (inworld= line)' : 'none';
}
console.log(`Keys: mistral ${mistralKey ? 'found' : 'MISSING'} (${MISTRAL_KEY_FILE}); inworld ${inworldKey ? 'found' : 'MISSING'} (${inworldKeySource})`);

// ---- the voice configurations, as the bridge loads them -----------------------------------------------------------------
const paths = resolveVoiceConfigPaths(stateDirectory);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const omniLong = createVoiceProfileRegistry(await readJson(paths.omni.long));
const omniShort = createVoiceProfileRegistry(await readJson(paths.omni.short));
const pocketConfig = await readJson(paths.pocket);
const pocketRegistry = validatePocketConfig(pocketConfig).registry;
const referenceRoot = resolve(stateDirectory, 'voice-references');
console.log(`References: ${[omniLong, omniShort, pocketRegistry].map(registry => registry.has(voiceKey) ? 'yes' : 'no').join('/')} (omni long/short/pocket) for ${voiceKey}`);

// ---- running one engine ----------------------------------------------------------------------------------------------------
const stats = samples => {
  let peak = 0, sum = 0, quiet = 0;
  for (const value of samples) { const a = Math.abs(value); if (a > peak) peak = a; sum += value * value; if (a < 0.002) quiet++; }
  return {seconds: samples.length / 24000, peak, rms: Math.sqrt(sum / Math.max(1, samples.length)), quietShare: quiet / Math.max(1, samples.length)};
};
const collect = () => { const packets = []; return {packets, onPcm: packet => { packets.push(packet.pcm.slice()); }}; };
const join = packets => { const out = new Float32Array(packets.reduce((total, part) => total + part.length, 0)); let at = 0; for (const part of packets) { out.set(part, at); at += part.length; } return out; };
const save = async (engine, packets) => {
  const samples = join(packets), file = resolve(outDirectory, `${baseName}-${engine}.wav`);
  const bytes = encodeWav16(samples, 24000);
  await writeFile(file, bytes);
  const s = stats(samples);
  console.log(`[${engine}] saved ${file} - ${s.seconds.toFixed(2)} s, ${bytes.length} bytes, peak ${s.peak.toFixed(3)}, rms ${s.rms.toFixed(4)}, near-silent samples ${(s.quietShare * 100).toFixed(1)}%`);
  return {file, ...s, bytes: bytes.length};
};
const log = prefix => message => { const text = scrub(message).trimEnd(); if (text) console.log(`  ${prefix} ${text.split('\n').slice(-3).join(' | ')}`); };

async function runVoxtral() {
  const voice = new VoxtralVoice({getKey: () => mistralKey, referenceRoot,
    prepare: createReferencePreparer({cacheDirectory: resolve(referenceRoot, 'prepared'), onLog: log('[Voxtral prep]')}), onLog: log('')});
  voice.setReferences([omniLong, omniShort, pocketRegistry]);
  const sink = collect();
  const result = await voice.synthesizeStream(voiceKey, CLEAN, {onPcm: sink.onPcm, firstAudioMs: 30000});
  console.log(`  [voxtral] ${result.chunks} packets, ${result.duration?.toFixed(2)} s${result.truncated ? ' (TRUNCATED)' : ''}`);
  if (result.truncated) throw Error('voxtral stream ended early');
  return sink.packets;
}

async function runInworld() {
  const steered = steerText(CLEAN, emotionMarks, {sounds: []});
  console.log(`  [inworld] steering: ${steered.tags} instruction(s) applied; first words sent: ${JSON.stringify(steered.text.slice(0, 70))}`);
  if (steered.tags !== emotionMarks.length || !steered.text.startsWith('[say with delighted excitement]')) throw Error('Inworld steering was not applied as expected');
  const voice = new InworldVoice({getKey: () => inworldKey, referenceRoot, storePath: resolve(argument('inworld-store', resolve(outDirectory, '.inworld-voices.json'))),
    limits: {stallMs: 20000}, onLog: log('')});
  voice.setReferences([omniLong, omniShort, pocketRegistry]);
  // The voice id is found in the account or cloned (2 a minute at most, the adapter waits for its slot): allow the wait here.
  console.log('  [inworld] making or finding the voice (a clone can take a minute)...');
  await voice.ensureVoice(voiceKey);
  const sink = collect();
  const result = await voice.synthesizeStream(voiceKey, CLEAN, {onPcm: sink.onPcm, emotion: {marks: emotionMarks, sounds: [], from: 0}, firstAudioMs: 30000});
  console.log(`  [inworld] ${result.chunks} packets, ${result.duration?.toFixed(2)} s, emotion tags ${result.timing.voiceEmotionTags} (${result.timing.voiceEmotionSource})${result.truncated ? ' (TRUNCATED)' : ''}`);
  if (result.timing.voiceEmotionTags !== emotionMarks.length || result.timing.voiceEmotionSource !== 'tags') throw Error('Inworld did not report the written tags as applied');
  if (result.truncated) throw Error('inworld stream ended early');
  return sink.packets;
}

async function runPocket() {
  // A separate worker with its own work folder (the running bridge keeps its own lock and prepared voices).
  await mkdir(pocketWork, {recursive: true});
  const config = JSON.parse(JSON.stringify(pocketConfig));
  config.runtime.workDirectory = pocketWork;
  config.cpu = {...config.cpu, threads: pocketThreads};
  const configPath = resolve(pocketWork, 'pocket-config.scripted.json');
  await writeFile(configPath, JSON.stringify(config));
  const voice = new PocketVoice(config, {project, configPath, pythonExecutable: config.runtime.pythonExecutable, onLog: log('[pocket]')});
  try {
    const sink = collect();
    const result = await voice.synthesizeStream(voiceKey, CLEAN, {onPcm: sink.onPcm});
    console.log(`  [pocket] ${result.chunks} packets, ${result.duration.toFixed(2)} s, generation ${Math.round(result.timing.voiceGenerationMs)} ms`);
    return sink.packets;
  } finally { await voice.close().catch(() => {}); }
}

const runners = {pocket: runPocket, voxtral: runVoxtral, inworld: runInworld};
await mkdir(outDirectory, {recursive: true});
const summary = {};
for (const engine of engines) {
  if (!runners[engine]) { console.log(`Unknown engine ${engine}`); continue; }
  if ((engine === 'voxtral' && !mistralKey) || (engine === 'inworld' && !inworldKey)) { summary[engine] = {ok: false, error: 'no key'}; continue; }
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`== ${engine}, attempt ${attempt}/2`);
    try {
      const packets = await runners[engine]();
      summary[engine] = {ok: true, ...await save(engine, packets)};
      break;
    } catch (error) {
      const text = scrub(error?.message ?? error).slice(0, 300);
      console.log(`  [${engine}] failed: ${text}`);
      summary[engine] = {ok: false, error: text};
      // A refused key, a used-up plan or a missing reference will not change with a second ask.
      if (/\[(?:voxtral|inworld):(?:key|quota|no-key|no-reference|text)\]/.test(String(error?.message))) break;
    }
  }
}
console.log('SUMMARY ' + JSON.stringify(summary));
process.exit(0);
