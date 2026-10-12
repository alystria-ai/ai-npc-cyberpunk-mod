// One text-route turn through the real bridge pieces with simulated provider timings (docs/LATENCY_2026-10-12.md).
//
//   node scripts/Measure-TurnLatency.mjs [--runs 3] [--json out.json]
//
// What is real: TextProviderHost (prompt, SSE client, reply cleaning), ReplyStream, deliverPocketSpeech, LocalPcmHost, the headless
// Edge renderer page with its audio worklet (RealtimeHost), ConvaiContinuousSpeech (state, reply and face commits), and the TurnClock
// that records every stage. What is simulated: the language model (a local SSE server that streams a fixed reply with a given first
// token delay and speed), the voice (packets of a sine tone with a given first-audio delay and speed), and the game (a lease file that
// always allows playback; the game's own poll cadence is not part of this). No key, no network, no GPU: the numbers are the bridge's
// own cost plus the provider shapes given below, which come from the real measurements in the document.
// The renderer's browser is started muted: the PCM path runs the same and nothing reaches the player's headphones.
process.env.CYBERPUNK_CONVAI_MUTE_BROWSER = '1';
import {createServer} from 'node:http';
import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve, dirname} from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = path => import(pathToFileURL(resolve(root, path)).href);
const [{TextProviderHost, mistralRoute}, {MistralMemory}, {MistralProvider}, {GroqKey}, {PersonaBook}, {RealtimeHost}, {deliverPocketSpeech},
  {ReplyStream}, {TurnClock, withClock}, {ConvaiContinuousSpeech}, {ownedPocketFace}] = await Promise.all([
  load('bridge/text-provider-host.mjs'), load('bridge/mistral-memory.mjs'), load('bridge/mistral-key.mjs'), load('bridge/groq-key.mjs'),
  load('bridge/mistral-prompt.mjs'), load('bridge/realtime-host.mjs'), load('bridge/pocket-speech.mjs'), load('bridge/reply-stream.mjs'),
  load('bridge/turn-clock.mjs'), load('bridge/convai-continuous-speech.mjs'), load('bridge/pocket-facial-stream.mjs')]);

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const RUNS = Number(option('--runs', 3));
const roster = [...JSON.parse(await readFile(resolve(root, 'characters/roster.json'), 'utf8')),
  ...JSON.parse(await readFile(resolve(root, 'characters/archetype-roster.json'), 'utf8'))];
const book = new PersonaBook(roster);
const sleep = ms => new Promise(done => setTimeout(done, ms));

// ---- the simulated language model -------------------------------------------------------------------------------------------------
const REPLY = 'Hey choom, good to see you again. You look like you have not slept in days. Come on, sit down, I will make us something warm and you can tell me everything that happened out there.';
async function languageModel({firstTokenMs, msPerChar}) {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', async () => {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      await sleep(firstTokenMs);
      for (const piece of REPLY.match(/.{1,6}/gs)) {
        response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: piece}}]})}\n\n`);
        await sleep(piece.length * msPerChar);
      }
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); })};
}

// ---- the simulated voice ----------------------------------------------------------------------------------------------------------
const OWNER = 'a'.repeat(32), SHA = 'b'.repeat(64), CHARS_PER_SECOND = 14;
function simulatedVoice({firstAudioMs, speed}) {
  let id = 0;
  return {async synthesizeStream(key, text, {signal, onPcm}) {
    const frames = Math.round(text.length / CHARS_PER_SECOND * 24000), packets = Math.ceil(frames / 2400);
    const mine = ++id;
    await sleep(firstAudioMs);
    let offset = 0;
    for (let index = 1; index <= packets; index++) {
      if (signal?.aborted) throw signal.reason ?? Error('cancelled');
      const count = Math.min(2400, frames - offset);
      const pcm = Float32Array.from({length: count}, (_, at) => .12 * Math.sin((offset + at) * .045));
      await onPcm({version: 1, engine: 'pocket-tts', owner: OWNER, id: mine, profile: key, modelSha256: SHA, sampleRate: 24000, channels: 1, format: 'f32le',
        index, offsetFrames: offset, frames: count, pcm, timebase: 'audio-seconds', startSeconds: offset / 24000});
      offset += count;
      if (index < packets) await sleep(100 / speed);
    }
    return {frames, chunks: packets, duration: frames / 24000, timing: {voiceProvider: 'pocket'}};
  }};
}

// ---- one turn ---------------------------------------------------------------------------------------------------------------------
async function oneTurn({host, stream, model, voice}) {
  const server = await languageModel(model);
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => 'api-key=aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL\n', writeText: async () => {},
    groq: new GroqKey({keyPath: 'g.txt'})});
  await provider.load(); provider.setPreference('mistral'); provider.apply();
  const memory = await MistralMemory.open({path: null});
  const text = new TextProviderHost({provider, memory, personas: book, routes: {mistral: mistralRoute({provider, endpoint: server.endpoint, gapMs: 0, cacheScope: 'bench'})}, log: () => {}});
  const input = {requestId: 'bench-turn', entity: '17ULL', generation: 1, profileKey: 'judy-alvarez'};
  const profile = {key: input.profileKey, name: 'Judy Alvarez'};
  const clock = new TurnClock({origin: performance.timeOrigin + performance.now()});
  clock.mark('received'); clock.mark('transport');
  let sequence = 0, delivered;
  const current = async () => true; current.sync = () => true;
  const speech = new ConvaiContinuousSpeech({input, profile, current, faceBuilder: ownedPocketFace,
    writeState: async () => true, writeReply: async () => true,
    readControl: async () => JSON.stringify({version: 1, id: speech.token, requestId: input.requestId, entity: input.entity, generation: input.generation,
      sequence: ++sequence, updated: Date.now(), allow: true, paused: false, volume: 1, pan: 0}),
    onPublished: async timing => { clock.mark('published', timing.publishedAt); },
    onStarted: async timing => { clock.mark('playbackObserved', timing.continuousPlaybackFirstObservedAt); }});
  const config = {text: 'Hey Judy, long time no see.', sessionId: 'bench', context: 'CURRENT PERSON\nBench.', local: {profileKey: input.profileKey, name: 'Judy Alvarez', channel: 'private'}};
  try {
    await withClock(clock, async () => {
      if (!stream) {
        const result = await text.reply(config, {});
        clock.mark('voiceStart');
        delivered = await deliverPocketSpeech({input, profile, result: {...result, transport: 'realtime'}, current, voice, host, speech});
      } else {
        const replyStream = new ReplyStream({name: 'Judy Alvarez'});
        const done = text.reply(config, {stream: replyStream}); done.catch(() => {});
        const head = await replyStream.headReady;
        const result = head ? {text: head, transport: 'realtime', timing: {}} : await done;
        clock.mark('voiceStart');
        delivered = await deliverPocketSpeech({input, profile, result, current, voice, host, speech, ...(head ? {stream: replyStream} : {})});
        const final = await done;
        if (head && replyStream.text !== final.text) delivered = {audioError: 'the stream text differs from the finished reply'};
      }
      // Sound is on once the renderer's clock has moved; give it a moment after the last mark.
      for (let at = 0; at < 100 && !clock.has('playbackObserved'); at++) await sleep(20);
    });
  } finally { clock.stop(); text.close(); await server.close(); }
  return {...clock.snapshot(), ok: delivered?.continuous === true && !delivered.audioError, spokenSeconds: speech.receivedFrames / 24000};
}

const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
async function scenario({label, model, voiceModel, stream, warm}) {
  const rows = [];
  for (let run = 0; run < RUNS; run++) {
    const host = new RealtimeHost({muteBrowser: true});
    try {
      if (warm) await host.prewarmLocal();
      rows.push(await oneTurn({host, stream, model, voice: simulatedVoice(voiceModel)}));
    } finally { await host.close(); }
  }
  const pick = name => { const values = rows.map(row => row.marks[name]).filter(Number.isFinite); return values.length ? Math.round(median(values)) : null; };
  const out = {label, stream, warm, runs: RUNS};
  for (const name of ['firstToken', 'firstSentence', 'fullText', 'replyReturned', 'voiceStart', 'browserReady', 'playStart', 'rendererReady', 'ttsSent', 'firstPcm', 'firstPcmAccepted', 'published', 'playbackObserved']) out[name] = pick(name);
  out.stalls = rows.flatMap(row => row.stalls ?? []).length;
  out.ok = rows.every(row => row.ok); out.spokenSeconds = Math.round(median(rows.map(row => row.spokenSeconds)) * 10) / 10;
  return out;
}

const MODELS = {
  // first token / ms per character, from the 2026-10-12 measurements (docs/LATENCY_2026-10-12.md)
  mistral: {firstTokenMs: 430, msPerChar: 2.6},
  groq: {firstTokenMs: 620, msPerChar: 0.45},
  local: {firstTokenMs: 900, msPerChar: 7},
};
const VOICES = {
  voxtral: {firstAudioMs: 1530, speed: 2.5},           // the whole 857 KB reference upload
  'voxtral-small': {firstAudioMs: 760, speed: 2.5},    // the 89 KB MP3 reference
  pocket: {firstAudioMs: 170, speed: 6},
};
const results = [], only = option('--only', null);
for (const [modelName, voiceName] of [['mistral', 'voxtral'], ['groq', 'voxtral'], ['local', 'voxtral'], ['local', 'pocket'], ['mistral', 'pocket']]) {
  if (only && !`${modelName} + ${voiceName}`.includes(only)) continue;
  for (const [stream, warm] of [[false, false], [false, true], [true, true]]) {
    const row = await scenario({label: `${modelName} + ${voiceName}`, model: MODELS[modelName], voiceModel: VOICES[voiceName], stream, warm});
    results.push(row);
    console.log(JSON.stringify(row));
  }
}
const target = option('--json', null);
if (target) await writeFile(target, JSON.stringify(results, null, 1));
process.exit(0);
