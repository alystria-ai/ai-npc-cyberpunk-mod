// One text-route turn through the real bridge pieces with simulated provider timings (docs/LATENCY_2026-10-12.md).
//
//   node scripts/Measure-TurnLatency.mjs [--runs 3] [--json out.json]
//   node scripts/Measure-TurnLatency.mjs --failures [--runs 1] [--spike-ms 9000]   a hung model request and a slow Voxtral tail,
//                                                                                   before (the 2026-10-12 limits and routing) and after
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
  {ReplyStream}, {TurnClock, withClock}, {ConvaiContinuousSpeech}, {ownedPocketFace}, {hasEmotionTag}, {NaturalSpeech}, {ExpressiveEmotions}] = await Promise.all([
  load('bridge/text-provider-host.mjs'), load('bridge/mistral-memory.mjs'), load('bridge/mistral-key.mjs'), load('bridge/groq-key.mjs'),
  load('bridge/mistral-prompt.mjs'), load('bridge/realtime-host.mjs'), load('bridge/pocket-speech.mjs'), load('bridge/reply-stream.mjs'),
  load('bridge/turn-clock.mjs'), load('bridge/convai-continuous-speech.mjs'), load('bridge/pocket-facial-stream.mjs'),
  load('bridge/emotion-tags.mjs'), load('bridge/natural-speech.mjs'), load('bridge/expressive-emotions.mjs')]);

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const RUNS = Number(option('--runs', 3));
const roster = [...JSON.parse(await readFile(resolve(root, 'characters/roster.json'), 'utf8')),
  ...JSON.parse(await readFile(resolve(root, 'characters/archetype-roster.json'), 'utf8'))];
const book = new PersonaBook(roster);
const sleep = ms => new Promise(done => setTimeout(done, ms));

// ---- the simulated language model -------------------------------------------------------------------------------------------------
const REPLY = 'Hey choom, good to see you again. You look like you have not slept in days. Come on, sit down, I will make us something warm and you can tell me everything that happened out there.';
// The three replies of the 2026-10-13 live record, written the way the model writes them with Expressive emotions on: a {tag} before the
// words it applies to, so every reply opens with one (bridge/emotion-tags.mjs). The harness' own default reply has no tags, which is why
// it never showed that a tagged reply got no streamed head.
const LIVE_REPLIES = {
  'live-1 (short sentences)': '{calm}Hey. {interest}What’s up? I was just finishing up some hardware checks in the basement.',
  'live-2 (one long first part)': '{calm}Work’s… work. {surprise}But I mean, the kind of work that lets me decide what to leave in and what to cut out. {calm}That’s the difference. {interest}You ever notice how some days you just want to sit in the dark and listen to the hum of the machines? {joy}That’s my idea of a good day.',
  'live-3 (two short, one long)': '{calm}No, it’s not. It’s a workshop. {calm}I just finished a few tweaks on a couple of old dolls, some Clouds leftovers, if you can believe that.',
};
async function languageModel({firstTokenMs, msPerChar, reply = REPLY, hangFirst = false}) {
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', async () => {
      if (hangFirst && ++requests === 1) return;     // a connection the network dropped: this request never gets an answer
      response.writeHead(200, {'content-type': 'text/event-stream'});
      await sleep(firstTokenMs);
      for (const piece of reply.match(/.{1,6}/gs)) {
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
async function oneTurn({host, stream, model, voice, reply, chatDefaults}) {
  const server = await languageModel({...model, ...(reply ? {reply} : {})});
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => 'api-key=aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL\n', writeText: async () => {},
    groq: new GroqKey({keyPath: 'g.txt'})});
  await provider.load(); provider.setPreference('mistral'); provider.apply();
  const memory = await MistralMemory.open({path: null});
  const naturalSpeech = new NaturalSpeech(), expressive = new ExpressiveEmotions();
  const text = new TextProviderHost({provider, memory, personas: book, transformReply: result => expressive.process(naturalSpeech.process(result)), routes: {mistral: mistralRoute({provider, endpoint: server.endpoint, gapMs: 0, cacheScope: 'bench', ...(chatDefaults ? {chatDefaults} : {})})}, log: () => {}});
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
        const replyStream = new ReplyStream({name: 'Judy Alvarez', isTag: hasEmotionTag});
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
async function scenario({label, model, voiceModel, stream, warm, reply, chatDefaults, makeVoice, extra}) {
  const rows = [], notes = [];
  for (let run = 0; run < RUNS; run++) {
    const host = new RealtimeHost({muteBrowser: true});
    const made = makeVoice ? await makeVoice() : null;
    try {
      if (warm) await host.prewarmLocal();
      rows.push(await oneTurn({host, stream, model, voice: made ? made.voice : simulatedVoice(voiceModel), reply, chatDefaults}));
      if (made) notes.push(made.report());
    } finally { await host.close(); await made?.close(); }
  }
  const pick = name => { const values = rows.map(row => row.marks[name]).filter(Number.isFinite); return values.length ? Math.round(median(values)) : null; };
  const out = {label, stream, warm, runs: RUNS, ...(reply ? {reply: reply.slice(0, 40)} : {}), ...(extra ?? {})};
  for (const name of ['firstToken', 'firstSentence', 'fullText', 'replyReturned', 'voiceStart', 'browserReady', 'playStart', 'rendererReady', 'ttsSent', 'firstPcm', 'firstPcmAccepted', 'published', 'playbackObserved']) out[name] = pick(name);
  out.stalls = rows.flatMap(row => row.stalls ?? []).length;
  out.ok = rows.every(row => row.ok); out.spokenSeconds = Math.round(median(rows.map(row => row.spokenSeconds)) * 10) / 10;
  if (notes.length) out.voiceNotes = notes.length === 1 ? notes[0] : notes;
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

// --failures: what a hung request and a slow Voxtral tail cost, with the limits and routing of 2026-10-12 ("before") and the new ones.
//  - a model request that never answers (the 2026-10-13 live record: 30 s for one reply): firstByteMs 25 s + 2 retries before, 6 s + 1 retry after;
//  - the tail of a streamed reply that Voxtral answers only after --spike-ms on its first ask (a server-side spike, 5 to 11 s on about one call
//    in ten): before, the tail was handed to Pocket after 7 s (a different voice mid-reply); after, it is asked for again in the same voice.
//    The "before" routing is a copy of the old VoiceSelection.synthesizeStream (Voxtral, else Pocket, per call). Voxtral is the real
//    VoxtralVoice against a local server; Pocket is a tone with a different pitch, so the packets say which voice spoke.
if (args.includes('--failures')) {
  const [{VoxtralVoice}, {VoiceSelection}, {createVoiceProfileRegistry}, {LOCAL_VOICE_KEYS}, {MistralScheduler}, {createHash}] = await Promise.all([
    load('bridge/voxtral-voice.mjs'), load('bridge/voice-selection.mjs'), load('bridge/voice-profile-registry.mjs'), load('bridge/resident-voice.mjs'),
    load('bridge/mistral-rate.mjs'), import('node:crypto')]);
  const wavBytes = (() => { const frames = 48000, bytes = Buffer.alloc(44 + frames * 2); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
    bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40); return bytes; })();
  const spikeMs = Number(option('--spike-ms', 9000)), voxFirstMs = Number(option('--voice-ms', 1300));
  const t0 = () => performance.now();

  // The fake Voxtral API: SSE float32 tone at 24 kHz, first audio after voxFirstMs; the first ask for the tail is held for spikeMs.
  async function fakeVoxtral() {
    const asks = new Map();
    const server = createServer((request, response) => {
      const chunks = []; request.on('data', c => chunks.push(c));
      request.on('end', async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')), count = (asks.get(body.input) ?? 0) + 1; asks.set(body.input, count);
        // The first text asked for is the head: it answers normally. Any later text is the tail: its first ask is the one that spikes.
        const order = [...asks.keys()].indexOf(body.input);
        await sleep(voxFirstMs + (order > 0 && count === 1 ? spikeMs : 0));
        if (response.destroyed) return;
        response.writeHead(200, {'content-type': 'text/event-stream'});
        const frames = Math.round(body.input.length / CHARS_PER_SECOND * 24000);
        const pcm = Float32Array.from({length: frames}, (_, at) => .12 * Math.sin(at * .045));
        for (let at = 0; at < frames; at += 12000) {
          const part = pcm.subarray(at, Math.min(frames, at + 12000));
          response.write(`data: ${JSON.stringify({type: 'speech.audio.delta', audio_data: Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString('base64')})}\n\n`);
        }
        response.end(`data: ${JSON.stringify({type: 'speech.audio.done'})}\n\n`);
      });
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    return {endpoint: `http://127.0.0.1:${server.address().port}/v1/audio/speech`, asks,
      close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); })};
  }
  const pocketTone = () => { const base = simulatedVoice({firstAudioMs: 170, speed: 6}); return {async synthesizeStream(key, text, options) {
    return base.synthesizeStream(key, text, {...options, onPcm: packet => options.onPcm({...packet, pcm: packet.pcm.map(value => value * 0.5), owner: 'c'.repeat(32), id: packet.id + 100})}); }}; };

  const POCKET_OWNER = 'c'.repeat(32);
  const routedVoice = routing => async () => {
    const server = await fakeVoxtral(), calls = [], began = t0(), seen = new Set(), logs = [];
    const registry = createVoiceProfileRegistry({version: 2, provider: 'hybrid', engine: 'omnivoice', voices: Object.fromEntries(['judy-alvarez'].map(key => [key,
      {reference: `runtime/voice-references/${key}.wav`, sha256: createHash('sha256').update(wavBytes).digest('hex'), transcript: 'Ready when you are, V.'}]))});
    const cloud = new VoxtralVoice({getKey: () => 'k'.repeat(8) + 'Secret0123456789abcdefghijkl', referenceRoot: resolve(root, 'fixture-references'), registry,
      endpoint: server.endpoint, read: async () => wavBytes, scheduler: new MistralScheduler({spacingMs: 0}),
      onLog: line => logs.push(`@${Math.round(t0() - began)} ms ${line.trim()}`)});
    const pocket = pocketTone();
    // Every spoken piece is logged with the engine that really produced its first packet and when (ms after the turn's voice was made).
    const noting = (text, options) => ({...options, onPcm: packet => {
      if (!seen.has(text)) { seen.add(text); calls.push({chars: text.length, engine: packet.owner === POCKET_OWNER ? 'POCKET' : 'voxtral', atMs: Math.round(t0() - began)}); }
      return options.onPcm(packet); }});
    let voice, closeVoice = async () => {};
    if (routing === 'after') {
      // The real VoiceSelection routing: the head decides the engine, the tail follows it and is asked for again in the same voice.
      const voices = Object.fromEntries(LOCAL_VOICE_KEYS.map(name => [name, {reference: `runtime/voice-references/${name}.wav`, sha256: 'a'.repeat(64), transcript: 'Ready.'}]));
      const settings = {version: 1, provider: 'pocket', engine: 'pocket-tts', voices,
        runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve(root, 'fixture', key)])),
        model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64), inputIdentity: 'e'.repeat(64), selectedStep: 1500}};
      const longVoices = Object.fromEntries(LOCAL_VOICE_KEYS.map(name => [name, {reference: `runtime/voice-references/${name}.wav`, sha256: createHash('sha256').update(wavBytes).digest('hex'), transcript: 'Ready.'}]));
      const selection = new VoiceSelection(settings, {voxtral: cloud, onState: () => {}, omniConfigs: {short: {}, long: {version: 2, provider: 'hybrid', engine: 'omnivoice', voices: longVoices}},
        factory: (config, {onState}) => { let loaded = false; return {get loaded() { return loaded; }, hasProfile: name => Object.hasOwn(config.voices, name),
          profileReady: name => loaded && Object.hasOwn(config.voices, name), async prepareProfile(name) { return {provider: 'pocket', ready: true, profile: name}; },
          async start() { loaded = true; onState({state: 'ready', resident: true}); },
          synthesizeStream: (name, text, options) => pocket.synthesizeStream(name, text, options), async close() { loaded = false; onState({state: 'stopped'}); }}; }});
      selection.update({voiceProvider: 'voxtral'}, null, false); await selection.start();
      voice = {synthesizeStream: (key, text, options) => selection.synthesizeStream(key, text, noting(text, options))};
      closeVoice = () => selection.close();
    } else {
      // The routing of 2026-10-12: every call tries Voxtral (7 s to first audio, no second ask) and falls to Pocket on its own failure,
      // whatever the other piece did.
      cloud.limits = Object.freeze({...cloud.limits, tailFirstAudioMs: 7000});
      voice = {async synthesizeStream(key, text, options) {
        const {utterance, role, ...plain} = options;
        try { return await cloud.synthesizeStream(key, text, noting(text, plain)); }
        catch (error) { if (error.sink || error.name === 'AbortError') throw error; return pocket.synthesizeStream(key, text, noting(text, plain)); }
      }};
    }
    return {voice, close: async () => { await closeVoice(); await server.close(); },
      report: () => ({routing, pieces: calls.map(call => `${call.engine} ${call.chars} chars @${call.atMs} ms`).join(' | '), voiceSwitched: new Set(calls.map(call => call.engine)).size > 1, log: logs})};
  };

  const base = {model: {firstTokenMs: Number(option('--first-token-ms', 650)), msPerChar: 3.5}, stream: true, warm: true, reply: LIVE_REPLIES['live-2 (one long first part)']};
  const rows = [];
  // 1. the hung model request (--only hung / --only voxtral picks one family)
  if (!only || 'hung'.includes(only)) {
    rows.push(await scenario({...base, label: 'hung model request, 2026-10-12 limits (25 s, 2 retries)', model: {...base.model, hangFirst: true},
      voiceModel: VOICES.pocket, chatDefaults: {firstByteMs: 25000, retries: 2, backoffMs: [1200, 3500]}}));
    rows.push(await scenario({...base, label: 'hung model request, new limits (6 s, 1 retry of 8 s)', model: {...base.model, hangFirst: true}, voiceModel: VOICES.pocket}));
  }
  // 2. the slow Voxtral tail
  if (!only || 'voxtral'.includes(only)) for (const routing of ['before', 'after']) {
    rows.push(await scenario({...base, label: `Voxtral tail answers after ${spikeMs} ms on its first ask, ${routing === 'before' ? '2026-10-12 routing' : 'new routing'}`,
      voiceModel: null, makeVoice: routedVoice(routing)}));
  }
  for (const row of rows) console.log(JSON.stringify(row));
  const target = option('--json', null);
  if (target) await writeFile(target, JSON.stringify(rows, null, 1));
  process.exit(0);
}
// --live: the three replies of the live record, written with Expressive emotions' tags, through Mistral + a Voxtral whose first audio is
// the median measured on 2026-10-13 (1.3 s; docs/LATENCY_2026-10-12.md), whole reply first against the first sentence first.
if (args.includes('--live')) {
  VOICES['voxtral-live'] = {firstAudioMs: Number(option('--voice-ms', 1300)), speed: 2.5};
  for (const [name, reply] of Object.entries(LIVE_REPLIES)) {
    for (const stream of [false, true]) {
      const row = await scenario({label: `mistral + voxtral-live, ${name}`, model: {firstTokenMs: Number(option('--first-token-ms', 650)), msPerChar: 3.5}, voiceModel: VOICES['voxtral-live'], stream, warm: true, reply});
      results.push(row); console.log(JSON.stringify(row));
    }
  }
  const target = option('--json', null);
  if (target) await writeFile(target, JSON.stringify(results, null, 1));
  process.exit(0);
}
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
