// OmniVoice: what the bridge does between "the first phrase has been rendered" and "the game can start the sound", before (Audioware
// slot, written for the game to play) and after (PCM packets into the renderer, docs/OMNIVOICE_PCM.md), measured back to back in this one
// process, alternating, so the machine's power mode and load are the same for both. Real code on both sides: the real facial model
// worker (bridge/jali-face.mjs), the real slot write, the real continuous-speech admission, the real local PCM host with an offline renderer.
// The renderer is a stand-in that plays at once (its first sample comes about 135 to 140 ms after the game's first lease, docs/CONVAI_AUDIO_STREAMING.md);
// the game's own half (reading reply.json and starting Audioware / the lease round trip) is not measured here.
//
//   node scripts/Measure-OmniFirstSound.mjs --old "C:/path/to/the/checkout/before" --runs 15 --note Silent
//
// --old   a checkout of the code BEFORE the change (its bridge/ folder is imported for the old path); default: the repository this one was made from.
// --wav   the phrase to start with (default deliverables/AI-NPC-Lucy-Clips/lucy-1-lesson-number-one.wav of the main checkout; 5.2 s, mono 24 kHz).
// --text  the words of that phrase (the face model aligns them).
import {readFile, mkdtemp, rm, writeFile, rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, at, all) => {
  if (token.startsWith('--')) pairs.push([token.slice(2), all[at + 1]?.startsWith('--') || all[at + 1] === undefined ? true : all[at + 1]]);
  return pairs;
}, []));
const oldRoot = resolve(args.old ?? resolve(here, '../../../..')), runs = Number(args.runs ?? 15), note = String(args.note ?? '');
const wavPath = resolve(args.wav ?? resolve(oldRoot, 'deliverables/AI-NPC-Lucy-Clips/lucy-1-lesson-number-one.wav'));
const text = String(args.text ?? 'Listen up. Lesson number one. Less judgment, more awareness.');
const modelDirectory = resolve(args.model ?? resolve(oldRoot, 'runtime/lipsync-model'));
const load = (root, name) => import(pathToFileURL(resolve(root, 'bridge', name)).href);
const NEW = resolve(here, '..');

const [oldAudio, oldStream, oldTimeline] = await Promise.all([load(oldRoot, 'speech-audio.mjs'), load(oldRoot, 'speech-stream.mjs'), load(oldRoot, 'facial-timeline.mjs')]);
const [newOmni, newDeliver, localClientModule, hostModule, continuousModule, facialModule, jaliModule, encoder] = await Promise.all([
  load(NEW, 'omni-pcm.mjs'), load(NEW, 'pocket-speech.mjs'), load(NEW, 'local-pcm-client.mjs'), load(NEW, 'local-pcm-host.mjs'),
  load(NEW, 'convai-continuous-speech.mjs'), load(NEW, 'pocket-facial-stream.mjs'), load(NEW, 'jali-face.mjs'), load(NEW, 'convai-audio-stream.mjs')]);

const wavBytes = await readFile(wavPath);
const audio = wavBytes.toString('base64');
const info = oldAudio.inspectWav(wavBytes);
const jali = await jaliModule.JaliFace.load(modelDirectory);
if (!jali) throw Error(`No facial model in ${modelDirectory}`);
const work = await mkdtemp(resolve(tmpdir(), 'omni-first-sound-'));
const depot = resolve(work, 'r6/audioware/CyberpunkConvai');
await oldAudio.initializeAudioDepot(work);

const input = {requestId: 'measure', entity: '17ULL', generation: 1, profileKey: 'lucy', source: 'typed'};
const profile = {key: 'lucy'};
const ms = (a, b) => b - a;

// ---- before: the first phrase's path to reply.json (bridge/convai-bridge.mjs synthesizeOmniPhrase + publishResult, as it was) ----
async function runOld(index) {
  const slots = new oldStream.SpeechSlots({depot, readState: async () => ({})});
  const current = async () => true;
  const t0 = performance.now();
  const analysing = jali.analyseWav(audio, {text});
  analysing.catch(() => {});
  const prepared = oldAudio.prepareSpeech(audio, depot);
  const facial = await analysing; const tAnalysis = performance.now();
  const generated = {audio, wav: info, faces: [], captions: [], timing: {}};
  const result = {...generated, ...facial, text};
  const id = `run-${index}`;
  await slots.begin(id, current);
  const stored = await slots.write(id, 1, audio, current, prepared); const tStored = performance.now();
  const face = oldTimeline.buildFacialTimeline(result, input); const tFace = performance.now();
  const file = resolve(work, 'reply.json');
  await writeFile(file + '.tmp', JSON.stringify({requestId: input.requestId, text, audio: stored, face, updated: Date.now()}));
  await rename(file + '.tmp', file);
  const tPublished = performance.now();
  return {publishMs: ms(t0, tPublished), analysisMs: ms(t0, tAnalysis), storeMs: ms(tAnalysis, tStored), faceMs: ms(tStored, tFace), writeMs: ms(tFace, tPublished)};
}

// ---- after: the same phrase as PCM into the renderer, and the game's admission at the first audio ----
class OfflinePlayer {
  constructor() { this.frames = 0; this.state = 'awaiting-admission'; this.ended = false; this.error = null; }
  async open() {}
  append(bytes, offset) { this.frames += bytes.length / 2; return Promise.resolve(); }
  snapshot() {
    if (this.state === 'playing') { this.heard = Math.min(this.frames, (this.heard ?? 0) + 4800); if (this.sealed && this.heard >= this.frames) { this.ended = true; this.state = 'ended'; } }
    return {state: this.state, sampleRate: 24000, channels: 1, receivedFrames: this.frames, playedFrames: this.heard ?? 0, positionSeconds: (this.heard ?? 0) / 24000,
      bufferedFrames: this.frames - (this.heard ?? 0), ended: this.ended, error: this.error, underruns: 0};
  }
  control(value) { if (value.allow && this.state !== 'ended') this.state = 'playing'; }
  async end() { this.sealed = true; }
  async stop() { this.stopped = true; }
}
async function runNew(index) {
  const host = new hostModule.LocalPcmHost({pollMs: 40, timeoutMs: 20000, cleanupTimeoutMs: 5000, createPage: async () => {
    const client = new localClientModule.LocalPcmClient({createPlayer: () => new OfflinePlayer()});
    return {closed: false, window: {localPcm: client}, isClosed() { return this.closed; }, async close() { this.closed = true; },
      async evaluate(fn, payload) { return runInNewContext(`(${fn.toString()})(payload)`, {window: this.window, payload}); }};
  }});
  await host.warm();   // the page is open before the turn (standby), as in the bridge
  const current = async () => true; current.sync = () => true;
  const marks = {};
  let sequence = 0, t0;
  // The face model session the stream opens: when does it cover the first half second, and the whole phrase?
  const watched = {begin: (...rest) => {
    const session = jali.begin(...rest);
    const timer = setInterval(() => {
      const covered = session.frames.coveredSeconds();
      if (covered >= 0.5) marks.cover500 ??= performance.now();
      if (covered >= info.duration - 0.05) marks.coverAll ??= performance.now();
      if (marks.coverAll) clearInterval(timer);
    }, 1);
    return session;
  }};
  const speech = new continuousModule.ConvaiContinuousSpeech({input, profile, current, token: `measure-${index}`, faceBuilder: facialModule.ownedPocketFace,
    writeState: async () => true, writeReply: async () => { marks.published ??= performance.now(); return true; },
    readControl: async () => JSON.stringify({version: 1, id: `measure-${index}`, requestId: input.requestId, entity: input.entity, generation: input.generation,
      sequence: ++sequence, updated: Date.now(), allow: true, paused: false, volume: 1, pan: 0}),
    onGenerated: async () => {}, onAudio: () => { marks.audio ??= performance.now(); }});
  const voice = newOmni.createOmniPcmVoice({synthesize: async () => ({audio, timing: {}})});
  const counted = {synthesizeStream: (key, value, options) => voice.synthesizeStream(key, value, {...options, onPcm: async packet => { marks.packet ??= performance.now(); return options.onPcm(packet); }})};
  t0 = performance.now();
  const reply = await newDeliver.deliverPocketSpeech({input, profile, result: {text, sessionID: 's', timing: {}}, current, voice: counted, jaliFace: watched,
    host: {playLocalPcm: (...rest) => host.play(...rest)}, speech});
  await host.close();
  if (!reply.continuous) throw Error('the reply was not delivered');
  return {publishMs: ms(t0, marks.published), packetMs: ms(t0, marks.packet), audioMs: ms(t0, marks.audio), cover500Ms: marks.cover500 ? ms(t0, marks.cover500) : null,
    coverAllMs: marks.coverAll ? ms(t0, marks.coverAll) : null};
}

const median = list => { const s = list.filter(Number.isFinite).sort((a, b) => a - b), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN; };
const p90 = list => { const s = list.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(.9 * s.length) - 1)] : NaN; };
const fmt = value => Number.isFinite(value) ? value.toFixed(1) : 'n/a';

// Warm both (worker start, JIT), then alternate.
await runOld(-1); await runNew(-1);
const before = [], after = [];
for (let n = 0; n < runs; n++) {
  if (n % 2 === 0) { before.push(await runOld(n)); after.push(await runNew(n)); }
  else { after.push(await runNew(n)); before.push(await runOld(n)); }
}
const column = (rows, key) => rows.map(row => row[key]);
const line = (label, rows, key) => `  ${label.padEnd(44)} median ${fmt(median(column(rows, key))).padStart(7)} ms   p90 ${fmt(p90(column(rows, key))).padStart(7)} ms`;
console.log(`OmniVoice first phrase: ${info.duration.toFixed(2)} s of speech, ${runs} runs each, alternating. Power mode: ${note || '(not stated)'}`);
console.log('BEFORE (Audioware slot, reply.json):');
console.log(line('phrase ready -> reply published for the game', before, 'publishMs'));
console.log(line('  of it: face analysis (waited for)', before, 'analysisMs'));
console.log(line('  of it: slot store after analysis', before, 'storeMs'));
console.log(line('  of it: face timeline + reply.json', before, 'faceMs'));
console.log('AFTER (PCM into the renderer, admission at first audio):');
console.log(line('phrase ready -> reply published for the game', after, 'publishMs'));
console.log(line('  of it: first packet in the renderer', after, 'packetMs'));
console.log(line('face model covers the first 0.5 s (from phrase ready)', after, 'cover500Ms'));
console.log(line('face model covers the whole phrase', after, 'coverAllMs'));
await jali.close();
await rm(work, {recursive: true, force: true}).catch(() => {});
process.exit(0);
