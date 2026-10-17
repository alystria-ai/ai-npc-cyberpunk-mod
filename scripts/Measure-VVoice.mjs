// V's line beside the companion's reply, with simulated provider timings (docs/V_VOICE.md, "Timing, measured").
//
//   node scripts/Measure-VVoice.mjs [--runs 5] [--prep 180] [--root <checkout>] [--json out.json]
//   node scripts/Measure-VVoice.mjs --legacy --root "<main checkout at cf97b9aa>"     the contract before V's own voice engine existed
//
// What is real: VVoice and VLine (the gate, the hold, the drop rules, PcmEdges' lead-in and tail) and the TurnClock that records
// every mark. What is simulated: the game's side of the turn (the pre-reply work: knowledge, admission, the transport hand-over), the
// companion's model and voice (a text reply ready after a given time, then a voice with a given first-audio delay), V's engines
// (Pocket on a worker, the Voxtral cloud voice: each a given first-audio delay) and the renderer page (a given time from the first
// packet to being audible, then the line's own length). No key, no network, no sound, no process: the numbers are the pipeline's own
// ordering plus the provider shapes below, which come from the measurements in docs/V_VOICE.md, docs/LATENCY_2026-10-12.md and
// docs/LOCAL_VOICES.md.
//
// Each turn starts at 0 (the bridge read the request). The reply is ready at `prep + text + ttsFirst`: the voice of the companion asks
// for audio at `prep + text` (the turn's `ttsSent` mark). V's line starts at `prep` in the old order (after the knowledge, admission and
// transport steps) and at 0 in the new order. The reply starts at once when V is not audible, and when V is audible it starts when V
// has ended (its 320 ms tail included): that is VLine.holds() and the continuous speech's hold, exactly as the bridge uses them.
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(option('--root', here));
const legacy = args.includes('--legacy');
const RUNS = Number(option('--runs', 5));
const PREP = Number(option('--prep', 180));       // received -> transport: knowledge (about 1 ms), admission (5 to 35 ms), the transport hand-over (docs/LATENCY_2026-10-12.md: transport at 162 ms)
const load = path => import(pathToFileURL(resolve(root, path)).href);
const {VVoice} = await load('bridge/v-voice.mjs');
const {TurnClock} = await load('bridge/turn-clock.mjs');

const sleep = ms => new Promise(done => setTimeout(done, ms));
const now = () => performance.now();
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// ---- the simulated pieces ------------------------------------------------------------------------------------------------------
const TEXT_MS = 900;                // the companion's first sentence is ready this long after the text request is sent (docs/V_VOICE.md: 0.9 to 1.1 s)
const LINE_SECONDS = 2.0;           // "Hey Judy, how are you holding up?"
const COMPANION_FIRST_AUDIO = {pocket: 250, voxtral: 1100, omni: 1300};      // the companion's voice: Pocket audible at 0.2 to 0.26 s, Voxtral 1.0 to 1.3 s, OmniVoice 1.3 s at 16 steps
const V_FIRST_AUDIO = {pocket: 250, voxtral: 1100};
const RENDERER_MS = 40;             // first packet -> the renderer holds audio (the page is warm)

const packet = frames => ({version: 1, engine: 'pocket-tts', sampleRate: 24000, channels: 1, format: 'f32le', owner: '1'.repeat(32), id: 1,
  profile: 'v-male', modelSha256: '2'.repeat(64), index: 1, offsetFrames: 0, frames, pcm: new Float32Array(frames).fill(0.1)});

// An engine speaking V's line: the first audio after `firstMs`, the rest of the line right behind it.
const engine = firstMs => async (key, text, options) => {
  await sleep(firstMs);
  await options.onPcm(packet(Math.round(LINE_SECONDS * 24000)));
  return {};
};

// The renderer page: audible RENDERER_MS after the first packet, ended when the line (lead-in and tail included) has played.
function renderer() {
  return async (config, producer, options) => {
    let frames = 0, firstAt = 0;
    const emit = async item => { if (!firstAt) firstAt = now(); frames += item.frames; };
    let produced = false, failure;
    const producing = producer(emit, {signal: options.signal}).then(() => { produced = true; }, error => { failure = error; });
    for (;;) {
      if (failure) throw failure;
      if (options.signal.aborted || !(await options.current())) throw Error('cancelled');
      const audible = firstAt && now() - firstAt >= RENDERER_MS;
      const seconds = audible ? (now() - firstAt - RENDERER_MS) / 1000 : 0;
      options.onFrame({receivedFrames: audible ? frames : 0, ended: audible && produced && seconds >= frames / 24000, positionSeconds: seconds});
      if (audible && produced && seconds >= frames / 24000) break;
      await sleep(2);
    }
    await producing;
  };
}

const typed = {requestId: 'r1', profileKey: 'judy-alvarez', text: 'Hey Judy, how are you holding up?',
  turnContext: {version: 1, status: 'ready', gender: 'male', dialogueVolume: 0.8}};

function build({vEngine, companion}) {
  const play = renderer();
  const common = {voices: {male: {key: 'v-male'}, female: {key: 'v-female'}}, play, prepare: async () => {}, warm: async () => {}, log: () => {}, report: () => {}};
  let voice;
  if (legacy) {
    // Before: V follows the companion's voice. OmniVoice companions use the Pocket helper; Voxtral companions use the cloud voice
    // (a 'pocket' plan on the cloud route, not a local worker).
    const helper = companion === 'omni' ? {speaks: () => true, ready: () => true, stream: engine(V_FIRST_AUDIO.pocket), prepare: async () => {}} : null;
    voice = new VVoice({...common, planFor: () => ({engine: companion === 'omni' ? 'omni' : 'pocket', language: 'en'}), ready: () => true,
      isLocal: () => companion !== 'voxtral', stream: engine(V_FIRST_AUDIO[companion === 'voxtral' ? 'voxtral' : 'pocket']), render: async () => { throw Error('no render'); }, helper});
    voice.update({vVoice: true});
  } else {
    const mainPocket = companion === 'pocket';
    const helper = {speaks: () => !mainPocket, ready: () => true, stream: engine(V_FIRST_AUDIO.pocket), prepare: async () => {}};
    const cloud = {problem: () => null, stream: engine(V_FIRST_AUDIO.voxtral), warm: () => {}};
    voice = new VVoice({...common, planFor: () => ({engine: vEngine, language: 'en'}), ready: () => mainPocket, isLocal: () => true,
      stream: engine(V_FIRST_AUDIO.pocket), helper, cloud});
    voice.update({vVoice: true, vVoiceEngine: vEngine});
  }
  return voice;
}

/** One turn; times are ms after the request. `startV`: 'early' (at 0), 'late' (after the pre-reply steps) or 'off'. */
async function turn({companion, vEngine, startV}) {
  const t0 = now();
  const at = () => now() - t0;
  const clock = new TurnClock();
  const controller = new AbortController();
  const voice = startV === 'off' ? null : build({vEngine, companion});
  let line = null, vAudible = null, vEnd = null;
  const startLine = () => { line = voice?.start({...typed}, {signal: controller.signal, clock}) ?? null;
    line?.whenClear(() => { vEnd = at(); });
    if (line) { const poll = setInterval(() => { if (line.state === 'playing' && vAudible === null) vAudible = at(); if (line.settled) clearInterval(poll); }, 1); } };
  if (startV === 'early') startLine();
  await sleep(PREP);                                          // knowledge, admission, the transport hand-over
  if (startV === 'late') startLine();
  await sleep(TEXT_MS);                                       // the companion's text reply
  clock.mark('ttsSent');                                      // the companion's voice is asked
  await sleep(COMPANION_FIRST_AUDIO[companion]);              // ... and its first audio exists
  const replyReady = at();
  const held = line?.holds() ?? false;                        // the continuous speech's hold, exactly as the bridge asks it
  if (held) await line.clear;
  const replyStart = at();
  const result = line ? (line.state === 'done' ? 'played' : line.state === 'dropped' ? `dropped (${line.reason})` : line.state) : '-';
  controller.abort(); await line?.finished?.catch(() => {});
  return {replyReady, replyStart, vAudible, result};
}

// ---- the scenarios ----------------------------------------------------------------------------------------------------------------
const scenarios = legacy
  ? [{label: 'Pocket companions, V on Pocket', companion: 'pocket', vEngine: 'pocket'},
     {label: 'Voxtral companions, V on Voxtral', companion: 'voxtral', vEngine: 'voxtral'},
     {label: 'OmniVoice companions, V on the Pocket helper', companion: 'omni', vEngine: 'pocket'}]
  : [{label: 'Pocket companions, V on Pocket', companion: 'pocket', vEngine: 'pocket'},
     {label: 'Pocket companions, V on Voxtral', companion: 'pocket', vEngine: 'voxtral'},
     {label: 'Voxtral companions, V on Pocket (helper)', companion: 'voxtral', vEngine: 'pocket'},
     {label: 'Voxtral companions, V on Voxtral', companion: 'voxtral', vEngine: 'voxtral'},
     {label: 'OmniVoice companions, V on Pocket (helper)', companion: 'omni', vEngine: 'pocket'},
     {label: 'OmniVoice companions, V on Voxtral', companion: 'omni', vEngine: 'voxtral'}];
const orders = legacy ? ['late'] : ['late', 'early'];

const rows = [];
for (const scenario of scenarios) {
  const off = [];
  for (let run = 0; run < RUNS; run++) off.push((await turn({...scenario, startV: 'off'})).replyStart);
  const baseline = median(off);
  for (const startV of orders) {
    const runs = [];
    for (let run = 0; run < RUNS; run++) runs.push(await turn({...scenario, startV}));
    const pick = key => median(runs.map(item => item[key]).filter(value => value !== null && value !== undefined));
    rows.push({scenario: scenario.label, order: startV === 'late' ? 'V after the pre-reply steps (old order)' : 'V at the start',
      vAudibleMs: Math.round(pick('vAudible') || 0) || null, result: runs[0].result, replyReadyMs: Math.round(pick('replyReady')),
      replyStartMs: Math.round(pick('replyStart')), replyWithoutVMs: Math.round(baseline), replyDelayMs: Math.round(pick('replyStart') - baseline)});
  }
}
console.log(`prep ${PREP} ms, text ${TEXT_MS} ms, runs ${RUNS}, ${legacy ? 'legacy contract (V follows the companion voice)' : 'V engine setting'}, root ${root}`);
console.table(rows);
const out = option('--json');
if (out) await writeFile(out, JSON.stringify({prep: PREP, runs: RUNS, legacy, rows}, null, 2));
