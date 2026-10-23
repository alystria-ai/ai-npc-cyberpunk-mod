// What the talk key loses and costs, before and after "instant push-to-talk" (docs/VOICE_INPUT.md), with the real pieces and simulated time.
//
//   node scripts/Measure-VoiceKey.mjs [--prep 300,800,1500] [--open 150] [--word 250] [--speech 1500] [--json out.json]
//
// Real: MicTap (bridge/mic-tap.mjs, the pre-roll and the hand-over), TapCapture, createLocalSttChannel and MicrophoneSession (the voice channel the
// local-recogniser routes use), the voice activity detector. Simulated, with real timers and the numbers given: the microphone device (opens `--open` ms
// after it is asked, then delivers a 40 ms chunk every 40 ms of an utterance that starts `--word` ms after the key went down and lasts `--speech` ms), the
// recogniser (it takes the audio and answers at once), and the preparation the bridge does before the channel can take audio (`--prep` ms: knowledge,
// memory, the connection, the model). The player holds the key until the utterance ends (plus 100 ms).
//
// Per `--prep` it prints two flows:
//   before  the device is opened by the channel when it is ready (the old start path), the recording is finished by a second press (the player's
//           reaction time is not counted) and the session waited out its 700 ms minimum recording from the device opening
//   after   the tap opens the device at the key press; the channel is handed everything kept; the release stops the device; no minimum wait
// and for each: how much of the utterance reached the recogniser, how much speech at the start was lost, and the time from the end of the utterance
// ("release") to the moment the recogniser had every byte it will get (the point a reply can start from).
import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve, dirname} from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = path => import(pathToFileURL(resolve(root, path)).href);
const [{MicTap, TapCapture, TAP}, {MicrophoneSession}, {createLocalSttChannel}] = await Promise.all([
  load('bridge/mic-tap.mjs'), load('bridge/microphone-session.mjs'), load('bridge/local-stt-capture.mjs')]);

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf('--' + name); return at >= 0 ? args[at + 1] : fallback; };
const preps = String(option('prep', '300,800,1500')).split(',').map(Number);
const openMs = Number(option('open', 150)), wordMs = Number(option('word', 250)), speechMs = Number(option('speech', 1500));
const wait = ms => new Promise(done => setTimeout(done, ms));

// A microphone device: opens after `openMs`, then streams the utterance in 40 ms chunks, every sample marked with its position in the utterance.
function device(t0) {
  let sink = null, timer = null, opened = 0, delivered = 0;
  const chunkBytes = TAP.chunkMs * 32;
  // Every chunk whose 40 ms have passed. Chunk i covers [opened + i * 40 ms, opened + (i + 1) * 40 ms) of the time since the key press; each byte is
  // speech when its instant falls inside the utterance, so the count of speech bytes is exact whatever the timers do.
  const deliver = () => {
    while (sink && opened + (delivered + 1) * TAP.chunkMs <= performance.now() - t0) {
      const chunk = Buffer.alloc(chunkBytes);
      for (let j = 0; j < chunkBytes; j++) {
        const at = opened + delivered * TAP.chunkMs + j / 32;
        chunk[j] = at >= wordMs && at < wordMs + speechMs ? 1 : 0;
      }
      delivered++;
      sink(chunk);
    }
  };
  return {
    get openedAt() { return opened; },
    begin: async onChunk => {
      await wait(openMs);
      opened = performance.now() - t0; sink = onChunk;
      timer = setInterval(deliver, TAP.chunkMs / 2);
      return {device: 'simulated'};
    },
    end: async () => { deliver(); clearInterval(timer); sink = null; },   // a real device hands over what it has when it stops
    abort: async () => { clearInterval(timer); sink = null; },
  };
}

// The recogniser: counts the speech bytes and silence bytes it was given and when the last byte came.
function recogniser(t0) {
  const seen = {speech: 0, silence: 0, lastAt: 0, firstSpeechAt: null};
  return {seen, availability: () => ({available: true}), start: async () => {},
    pushAudio: chunk => {
      const speech = chunk.filter(byte => byte === 1).length;
      seen.speech += speech; seen.silence += chunk.length - speech; seen.lastAt = performance.now() - t0;
      if (speech && seen.firstSpeechAt === null) seen.firstSpeechAt = seen.lastAt;
      return true;
    },
    heard: () => '', finish: async () => ({text: 'hello', seconds: 1}), cancel: async () => {}};
}

async function run(flow, prepMs) {
  const t0 = performance.now(), marks = {keyDown: 0};
  const dev = device(t0), stt = recogniser(t0);
  const releaseAt = wordMs + speechMs + 100;
  const requestId = '1-1-1ULL', input = {requestId, entity: '1ULL', generation: 1, profileKey: 'judy', text: '(microphone)'};
  let capture, tap;
  if (flow === 'after') {
    tap = new MicTap({capture: dev});
    capture = new TapCapture({tap});
    tap.hold('k1').catch(() => {});                                     // the key press opens the device at once
    tap.open(requestId, {holdId: 'k1'});                                // the start command names the owner
  } else {
    // before: the channel itself opens the device when it is ready; nothing is kept before that
    capture = {begin: async onChunk => dev.begin(onChunk), end: async () => dev.end(), abort: async () => dev.abort()};
  }
  const channel = createLocalSttChannel({stt, capture});
  const mic = new MicrophoneSession({minRecordMs: flow === 'after' ? 0 : 700, hostFactory: channel,
    onState: async () => {}, onReply: async () => { marks.replyReady = performance.now() - t0; }, onError: async () => {}});
  const preparing = (async () => {
    await wait(prepMs);                                                 // knowledge, memory, the connection and the model
    marks.channelReady = performance.now() - t0;
    await mic.start(input, {requestId});
    marks.recording = performance.now() - t0;
  })();
  await wait(releaseAt);
  if (flow === 'after') { marks.release = performance.now() - t0; tap.released('k1').catch(() => {}); }   // the key is let go
  await preparing;
  // before: the second press can only land once the recording runs ("Listening"); the player's own reaction time is not counted
  if (flow === 'before') marks.release = performance.now() - t0;
  await mic.finish(requestId);
  marks.done = performance.now() - t0;
  const total = speechMs;
  return {flow, prepMs, deviceOpenedAt: Math.round(dev.openedAt),
    speechSentMs: Math.round(stt.seen.speech / 32), speechLostMs: Math.max(0, Math.round(total - stt.seen.speech / 32)),
    silenceSentMs: Math.round(stt.seen.silence / 32),
    releaseToAudioCompleteMs: Math.round(Math.max(0, stt.seen.lastAt - marks.release)),
    releaseToReplyReadyMs: Math.round(marks.replyReady - marks.release)};
}

const rows = [];
for (const prep of preps) for (const flow of ['before', 'after']) rows.push(await run(flow, prep));
console.log(`utterance: first word ${wordMs} ms after the key press, ${speechMs} ms long; device opens in ${openMs} ms\n`);
console.log('prep ms  flow    device open  speech reached  speech lost  silence sent  release -> audio complete  release -> reply ready');
for (const r of rows) {
  console.log(String(r.prepMs).padStart(7), ' ', r.flow.padEnd(6), String(r.deviceOpenedAt).padStart(9), ' ms',
    String(r.speechSentMs).padStart(11), ' ms', String(r.speechLostMs).padStart(9), ' ms', String(r.silenceSentMs).padStart(10), ' ms',
    String(r.releaseToAudioCompleteMs).padStart(15), ' ms', String(r.releaseToReplyReadyMs).padStart(18), ' ms');
}
const out = option('json', null);
if (out) await writeFile(out, JSON.stringify({wordMs, speechMs, openMs, rows}, null, 2));
