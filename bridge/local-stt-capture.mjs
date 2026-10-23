// Microphone capture for local speech-to-text (docs/LOCAL_STT.md).
//
// The Convai route records inside the bridge's hidden voice browser and Convai transcribes it in the cloud. The
// Mistral text route has no Convai connection, so this module opens one small page in the SAME hidden browser, grants it
// the microphone through the same context.grantPermissions path, taps the microphone with a 16 kHz mono AudioWorklet
// and streams 100 ms Int16 chunks to the bridge, which feeds them to bridge/local-stt.mjs.
//
// createLocalSttChannel() returns a factory with the interface MicrophoneSession expects from realtime.voiceChannel()
// (beginVoice / finishVoice / heard / close), so the voice key, its states, the "Listening" notice, the 700 ms
// minimum recording, spam safety and the live words (microphone-heard.json) all run through the unchanged code.
import {randomUUID} from 'node:crypto';
import {ReplyStream} from './reply-stream.mjs';
import {TurnClock, currentClock, withClock} from './turn-clock.mjs';
import {cancelled} from './transport-pool.mjs';
import {sameWords} from './local-stt.mjs';
import {SpeechActivity} from './stt-activity.mjs';

export const NO_SPEECH_ERROR = 'No speech was heard';
// A recording whose loudest moment is below this sent no sound at all: the Windows input is muted, dead or the wrong device.
export const SILENT_PEAK_DB = -55;
export const SILENT_INPUT_CODE = 'MIC_SILENT';
export const STT_UNAVAILABLE_CODE = 'local-stt-unavailable';
// A recording in another language that no engine could recognise (Mistral's transcription failed and no local pack or English recogniser took over).
export const STT_LANGUAGE_CODE = 'STT_LANGUAGE';
const MAX_REMOTE_BYTES = 45 * 16000 * 2;   // a recording kept for Mistral's transcription ends here (the local recogniser's own 45 s cap)
const CAPTURE_PATH = '/local-stt';
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 ms

// Runs on the audio rendering thread: downmix, convert to Int16, post 100 ms blocks. Nothing else.
const WORKLET_SOURCE = `
class LocalSttCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // The chunk length comes from the page (a tap that must hand audio on quickly asks for 40 ms; the default is 100 ms).
    this.size = (options && options.processorOptions && options.processorOptions.chunkSamples) | 0 || ${CHUNK_SAMPLES};
    this.block = new Int16Array(this.size); this.used = 0;
    this.port.onmessage = event => {
      if (event.data !== 'flush' || !this.used) return;
      const tail = this.block.slice(0, this.used); this.used = 0;
      this.port.postMessage(tail.buffer, [tail.buffer]);
    };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels.length; c++) sum += channels[c][i] || 0;
      const value = Math.round(sum / channels.length * 32767);
      this.block[this.used++] = value > 32767 ? 32767 : value < -32768 ? -32768 : value;
      if (this.used === this.size) {
        const full = this.block; this.block = new Int16Array(this.size); this.used = 0;
        this.port.postMessage(full.buffer, [full.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('local-stt-capture', LocalSttCapture);
`;

const PAGE_SOURCE = `
let stream, context, node, source, queue = Promise.resolve(), failure = null;
const toBase64 = buffer => {
  const bytes = new Uint8Array(buffer); let text = '';
  for (let i = 0; i < bytes.length; i += 0x2000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x2000));
  return btoa(text);
};
async function release() {
  try { node?.disconnect(); source?.disconnect(); } catch {}
  for (const track of stream?.getTracks() ?? []) track.stop();
  try { await context?.close(); } catch {}
  stream = context = node = source = undefined;
}
window.localStt = {
  async begin(chunkSamples) {
    await release(); queue = Promise.resolve(); failure = null;
    stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true,
      noiseSuppression: true, autoGainControl: true}});
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState !== 'live') throw Error('No live microphone track');
    context = new AudioContext({sampleRate: ${SAMPLE_RATE}, latencyHint: 'interactive'});
    const url = URL.createObjectURL(new Blob([${JSON.stringify(WORKLET_SOURCE)}], {type: 'text/javascript'}));
    try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'local-stt-capture', {numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1,
      channelCountMode: 'explicit', processorOptions: {chunkSamples: chunkSamples || 0}});
    node.port.onmessage = event => {
      const encoded = toBase64(event.data);
      queue = queue.then(() => window.__localSttChunk(encoded)).catch(error => { failure = String(error?.message || error); });
    };
    source.connect(node);
    if (context.state !== 'running') await context.resume();
    // Which input the browser chose (its default) and what else there was, for the bridge's log: a wrong device shows here.
    let inputs = [];
    try { inputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput').map(d => d.label || d.deviceId); } catch {}
    const settings = track.getSettings ? track.getSettings() : {};
    return {device: track.label, sampleRate: context.sampleRate, inputs,
      settings: {echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl, channelCount: settings.channelCount}};
  },
  // Flush the last block, wait for every chunk to reach the bridge, then release the device.
  async end() {
    node?.port.postMessage('flush');
    await new Promise(done => setTimeout(done, 60));
    await queue;
    await release();
    if (failure) throw Error(failure);
    return true;
  },
  async abort() { await release(); },
};
`;

const PAGE_HTML = `<!doctype html><meta charset="utf-8"><script>${PAGE_SOURCE.replace(/<\/script/gi, '<\\/script')}</script>`;

// The hidden voice browser of a RealtimeHost: `new LocalSttCapture({getBrowser: hostBrowser(realtime)})`.
export const hostBrowser = host => async () => { await host.start(); return host.browser; };

// One page for the life of the browser; the microphone is open only between begin() and end().
export class LocalSttCapture {
  constructor({getBrowser}) {
    this.getBrowser = getBrowser;
    this.page = null; this.opening = null; this.target = null;
  }
  async ensurePage() {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const browser = await this.getBrowser();
      if (!browser?.isConnected?.()) throw Error('The voice browser is not running');
      const page = await browser.newPage();
      try {
        // The page is served from memory: nothing else is reachable from it.
        const origin = 'http://127.0.0.1:1';
        await page.route('**/*', async route => {
          const request = route.request();
          if (request.method() === 'GET' && request.url() === origin + CAPTURE_PATH)
            await route.fulfill({status: 200, contentType: 'text/html; charset=utf-8', body: PAGE_HTML});
          else await route.abort('failed');
        });
        await page.exposeFunction('__localSttChunk', encoded => { this.target?.(encoded); });
        await page.goto(origin + CAPTURE_PATH);
        await page.waitForFunction(() => !!window.localStt, undefined, {timeout: 5000});
        this.origin = origin;
        page.once('close', () => { if (this.page === page) this.page = null; });
        this.page = page;
        return page;
      } catch (error) { await page.close({runBeforeUnload: false}).catch(() => {}); throw error; }
    })();
    try { return await this.opening; } finally { this.opening = null; }
  }
  // Opens the microphone. Chunks arrive at onChunk(Buffer of Int16 little-endian samples) until end() or abort().
  // chunkMs (default 100): how often a chunk is posted; the microphone tap (bridge/mic-tap.mjs) asks for 40 ms.
  async begin(onChunk, {chunkMs} = {}) {
    const page = await this.ensurePage();
    this.target = encoded => { try { onChunk(Buffer.from(encoded, 'base64')); } catch { /* a consumer fault never stops the capture */ } };
    await page.context().grantPermissions(['microphone'], {origin: this.origin});
    const samples = Number.isFinite(chunkMs) && chunkMs >= 10 && chunkMs <= 200 ? Math.round(chunkMs * SAMPLE_RATE / 1000) : 0;
    return page.evaluate(size => window.localStt.begin(size), samples);
  }
  async end() {
    const page = this.page;
    if (!page || page.isClosed()) throw Error('The voice browser closed during the recording');
    try { await page.evaluate(() => window.localStt.end()); }
    finally { this.target = null; await page.context().clearPermissions().catch(() => {}); }
  }
  async abort() {
    const page = this.page; this.target = null;
    if (!page || page.isClosed()) return;
    await page.evaluate(() => window.localStt.abort()).catch(() => {});
    await page.context().clearPermissions().catch(() => {});
  }
  async close() {
    const page = this.page; this.page = null; this.target = null;
    await page?.close({runBeforeUnload: false}).catch(() => {});
  }
}

const clip = (text, size = 160) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, size);
// One line when a recording opens: the input the browser chose (its default), the others it could have chosen, and the processing it applied.
export function describeInput(info) {
  const inputs = Array.isArray(info?.inputs) ? info.inputs : [];
  const settings = info?.settings ? ' echoCancellation=' + info.settings.echoCancellation + ' noiseSuppression=' + info.settings.noiseSuppression
    + ' autoGainControl=' + info.settings.autoGainControl : '';
  return 'input "' + clip(info?.device || 'unknown', 120) + '"' + (info?.sampleRate ? ' at ' + info.sampleRate + ' Hz' : '')
    + (inputs.length ? ', ' + inputs.length + ' available [' + inputs.map(name => clip(name, 80)).join(' | ') + ']' : '') + settings;
}
// One line when a recording ends: how long it was, how loud and how voiced the sound was, which input it came from, and what was made of it.
// A near-silent recording names the likely cause (a wrong or muted Windows input device) because the words alone cannot show it.
export function describeRecording(heard, device) {
  const text = clip(heard?.text);
  const levels = Number.isFinite(heard?.peakDb) ? 'peak ' + heard.peakDb + ' dBFS, ' + heard.soundMs + ' ms of sound, ' + heard.voicedMs + ' ms voiced' : 'levels unknown';
  const lead = 'recorded ' + (Number.isFinite(heard?.seconds) ? heard.seconds : '?') + ' s from "' + clip(device || 'unknown', 80) + '" (' + levels + '): ';
  if (heard?.rejected) return lead + 'ignored "' + clip(heard.ignored, 100) + '" as not speech (' + heard.rejected + ')';
  if (text) return lead + 'heard "' + text + '"';
  return lead + 'no words' + (Number.isFinite(heard?.peakDb) && heard.peakDb < -55 ? '; the input is almost silent, check the Windows input device' : '');
}


// Loudest sample of 16 kHz Int16 audio, in dBFS (-120 for none), for the "this input sends no sound" check of a recording kept for Mistral.
function peakDbOf(pcm) {
  let peak = 0;
  for (let at = 0; at + 1 < pcm.length; at += 2) { const value = Math.abs(pcm.readInt16LE(at)); if (value > peak) peak = value; }
  return peak ? Math.round(20 * Math.log10(peak / 32768) * 10) / 10 : -120;
}
// One line when a recording kept for Mistral ends: how long, how loud, which engine and language heard it, and the words.
export function describeRemote(heard, device) {
  const text = clip(heard?.text);
  const lead = 'recorded ' + (Number.isFinite(heard?.seconds) ? heard.seconds : '?') + ' s from "' + clip(device || 'unknown', 80) + '" (peak '
    + (Number.isFinite(heard?.peakDb) ? heard.peakDb : '?') + ' dBFS, ' + (Number.isFinite(heard?.soundMs) ? heard.soundMs : '?') + ' ms of sound) by '
    + clip(heard?.engine || 'unknown', 40) + (heard?.language ? ' [' + clip(heard.language, 12) + ']' : '') + (Number.isFinite(heard?.ms) ? ' in ' + heard.ms + ' ms' : '') + ': ';
  if (heard?.rejected) return lead + 'ignored "' + clip(heard.ignored, 100) + '" as not speech (' + heard.rejected + ')';
  return lead + (text ? 'heard "' + text + '"' : 'no words');
}

// A voice channel with the shape of RealtimeHost.voiceChannel(): beginVoice / finishVoice / heard / close.
//
//   stt      a LocalStt (bridge/local-stt.mjs)
//   capture  a LocalSttCapture, or any object with begin(onChunk) / end() / abort()
//   route    optional async (config) => plan, the recogniser for THIS recording (bridge/speech-language.mjs planRecording, with the pack's
//            LocalStt filled in as `stt`). Without it every recording is English on `stt`, exactly as before. A plan is
//              {mode: 'english'}                        `stt` (Moonshine)
//              {mode: 'pack', stt}                      a LocalStt running a multilingual pack (no live words)
//              {mode: 'voxtral', hint, fallback: [..]}  the audio is kept and sent to `transcriber` when the key is pressed again; if that fails
//                                                       each entry of `fallback` ({mode:'pack', stt} | {mode:'english'}) is tried on the kept audio
//            and may carry `note` ('english-only': the language is not English but nothing here hears it; 'pack-available': an optional microphone
//            pack hears it but is not installed), which beginVoice returns so the game can tell the player once.
//   transcriber  a VoxtralStt (bridge/voxtral-stt.mjs); onLanguage(code) is told the language Mistral reported.
//   reply    optional async (config, options) => result, the text provider's reply function (the same call a typed turn
//            makes). It receives the turn's configuration with `text` set to the transcript, and options.signal, and returns
//            the reply the bridge publishes. Without it finishVoice returns {userText, text: '', local: true}.
//
// finishVoice rejects with Error('No speech was heard') for an empty recording, which the bridge already turns into
// the game's "No speech was heard" notice (microphone-state.json "no-speech").
export function createLocalSttChannel({stt, capture, reply, now = Date.now, speculate = () => false, log = () => {}, route = null, transcriber = null, onLanguage = () => {}, track = null}) {
  return () => {
    let requestId = null, closed = false, begun = false, device = '', ending = null;
    let plan = {mode: 'english'}, engine = stt, kept = [], keptBytes = 0, activity = null, counted = false;
    // The speech hook counts open recordings so the microphone page is released only when none is open (createLocalSpeech).
    const countOn = () => { if (!counted) { counted = true; try { track?.begin?.(); } catch { /* never breaks */ } } };
    const countOff = () => { if (counted) { counted = false; try { track?.end?.(); } catch { /* never breaks */ } } };
    const controller = new AbortController();
    const pass = chunk => {
      if (!requestId) return;
      if (plan.mode !== 'voxtral') { engine.pushAudio(chunk); return; }
      // Kept for Mistral's transcription: no work now beyond the level of each 100 ms block.
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (keptBytes >= MAX_REMOTE_BYTES) return;
      const take = bytes.length > MAX_REMOTE_BYTES - keptBytes ? bytes.subarray(0, MAX_REMOTE_BYTES - keptBytes) : bytes;
      kept.push(Buffer.from(take)); keptBytes += take.length; activity.push(take);
    };
    // The reply on a stable live-words decode, started the moment the key is pressed (stt.stable()). Returns null when the newest decode
    // cannot stand in for the transcript. The reply is written into a stream of its own and held back from the voice, the memory and the
    // game's actions until the final words are known: `adopt` hands it over when they agree, `discard` throws it away when they do not.
    const startSpeculation = (id, config, options) => {
      if (!reply || plan.mode === 'voxtral' || typeof engine.stable !== 'function') return null;
      let guess; try { guess = engine.stable(id); } catch { return null; }
      if (!guess?.text) return null;
      const own = new AbortController(), signal = AbortSignal.any([controller.signal, own.signal]);
      let open, shut; const gate = new Promise((yes, no) => { open = yes; shut = no; }); gate.catch(() => {});
      // A turn that is closed or cancelled while the reply waits for its words to be confirmed must not leave the reply hanging.
      signal.addEventListener('abort', () => shut(cancelled('The words changed')), {once: true});
      const real = options.stream, feed = real ? new ReplyStream({name: real.name, isTag: real.isTag, speak: real.speak, limits: real.limits}) : undefined;
      const clock = currentClock() ? new TurnClock({origin: currentClock().origin}) : null;
      const run = () => reply({...config, text: guess.text}, {...options, signal, ...(feed ? {stream: feed} : {}), confirmed: gate});
      const promise = Promise.resolve().then(() => clock ? withClock(clock, run) : run());
      let settled = null;
      promise.then(() => { settled = 'done'; }, () => { settled = 'failed'; });
      promise.catch(() => {});
      return {
        guess,
        matches: text => sameWords(guess.text, text),
        // The final words agree: the voice, the memory and the game see the reply from now on.
        async adopt() {
          open();
          if (feed && real) feed.mirrorTo(real);
          const turn = currentClock();
          if (clock && turn) for (const name of clock.marks.keys()) turn.mark(name, clock.at(name));
          return promise;
        },
        // The reply could not be written before the words were confirmed (it failed on its own): the turn asks again with the final words.
        failed: () => settled === 'failed',
        discard() { shut(cancelled('The words changed')); own.abort(cancelled('The words changed')); },
      };
    };
    // A recording kept for Mistral's transcription (plan.mode 'voxtral'): checked for sound here, sent when the key is pressed again, and, when
    // Mistral cannot take it (a limit, a refused key, no network), read by the fallback of the plan from the same audio.
    const recogniseKept = async id => {
      const pcm = Buffer.concat(kept); kept = []; keptBytes = 0;
      const seconds = Math.round(pcm.length / 32) / 1000;   // 16 kHz mono 16-bit: 32 bytes per ms
      const peakDb = peakDbOf(pcm);
      const soundMs = Math.round(activity.speechFramesFrom(0) * 30);
      const report = fields => ({seconds, peakDb, soundMs, ...fields});
      // Like the local recogniser: audio without speech is never sent (nothing to pay for, nothing to hallucinate on).
      if (!activity.heardSpeech) return report({text: '', engine: 'none'});
      const signal = controller.signal;
      let failure = null;
      if (transcriber) {
        try {
          const answer = await transcriber.transcribe(pcm, {language: plan.hint ?? null, signal});
          const text = /[\p{L}\p{N}]/u.test(answer.text) ? answer.text : '';
          try { if (answer.language) onLanguage(answer.language); } catch { /* an observer never breaks a recording */ }
          return report({text, engine: 'mistral-voxtral', language: answer.language, ms: answer.ms});
        } catch (error) {
          if (signal.aborted) throw error;
          failure = error;
        }
      } else failure = Error('Mistral transcription is not set up');
      for (const next of plan.fallback ?? []) {
        const recogniser = next.mode === 'pack' ? next.stt : stt;
        if (!recogniser || !recogniser.availability().available) continue;
        try { log('Mistral transcription failed (' + clip(failure?.message, 120) + '); ' + (next.mode === 'pack' ? 'local pack ' + clip(recogniser.engine?.id, 60) : 'English recogniser') + ' reads the same audio'); } catch { /* never breaks */ }
        try {
          const began = now();
          await recogniser.start(id);
          for (let at = 0; at < pcm.length; at += 64000) recogniser.pushAudio(pcm.subarray(at, Math.min(pcm.length, at + 64000)), id);
          const done = await recogniser.finish(id);
          return report({text: done.text ?? '', engine: next.mode === 'pack' ? 'pack:' + (recogniser.engine?.id ?? '?') : 'moonshine-fallback', ms: now() - began,
            rejected: done.rejected, ignored: done.ignored});
        } catch (error) {
          if (signal.aborted) throw error;
          failure = error;
        }
      }
      throw Object.assign(Error('No speech recogniser could read the recording' + (failure ? ' (' + clip(failure.message, 120) + ')' : '')), {code: STT_LANGUAGE_CODE});
    };
    return {
      async beginVoice(config) {
        if (closed) throw Error('Microphone connection is closed');
        // Which recogniser hears this recording (English: Moonshine, as always). A route that cannot decide never blocks the recording.
        plan = {mode: 'english'}; engine = stt; kept = []; keptBytes = 0; activity = null;
        if (route) { try { plan = (await route(config)) ?? plan; } catch (error) { try { log('language route failed (' + clip(error?.message, 80) + '); English recogniser'); } catch { /* never breaks */ } } }
        if (closed) throw Error('Microphone connection is closed');
        if (plan.mode === 'voxtral') {
          requestId = config?.requestId ?? randomUUID(); ending = null; activity = new SpeechActivity();
          // The connection to Mistral opens while the player speaks (an unauthenticated request, no quota): the answer finds it ready.
          try { plan.warm?.(); } catch { /* best effort */ }
          let info;
          try { info = await capture.begin(pass, {requestId}); }
          catch (error) { requestId = null; kept = []; throw error; }
          begun = true; device = info?.device || ''; countOn();
          try {
            log(describeInput(info));
            log('speech language ' + (plan.language ?? '?') + ' (' + (plan.source ?? '?') + '): kept for Mistral transcription' + (plan.hint ? ' with the language hint' : ', language detected by Mistral'));
          } catch { /* a log line never breaks a recording */ }
          if (closed) { await capture.abort(); kept = []; throw Error('Microphone startup cancelled'); }
          return {device: info?.device ?? '', sessionID: undefined, local: true, ...(plan.note ? {note: plan.note} : {})};
        }
        engine = plan.mode === 'pack' && plan.stt ? plan.stt : stt;
        const availability = engine.availability();
        if (!availability.available) {
          const error = Error('Local speech recognition is not installed (' + availability.reason + ')');
          error.code = STT_UNAVAILABLE_CODE; error.reason = availability.reason; throw error;
        }
        requestId = config?.requestId ?? randomUUID(); ending = null;
        // The model loads while the device opens; chunks are held until it is ready.
        await engine.start(requestId);
        let info;
        try { info = await capture.begin(pass, {requestId}); }
        catch (error) { await engine.cancel(requestId); requestId = null; throw error; }
        begun = true; countOn();
        device = info?.device || '';
        try {
          log(describeInput(info));
          if (plan.mode === 'pack') log('speech language ' + (plan.language ?? '?') + ' (' + (plan.source ?? '?') + '): local pack ' + clip(engine.engine?.id, 60) + ', no live words');
          else if (plan.note === 'pack-available') log('speech language ' + (plan.language ?? '?') + ' (' + (plan.source ?? '?') + '): the optional microphone pack that hears it is not installed, English recogniser used (' + plan.note + ')');
          else if (plan.note) log('speech language ' + (plan.language ?? '?') + ' (' + (plan.source ?? '?') + '): nothing here recognises it, English recogniser used (' + plan.note + ')');
        } catch { /* a log line never breaks a recording */ }
        if (closed) { await capture.abort(); await engine.cancel(requestId); throw Error('Microphone startup cancelled'); }
        return {device: info?.device ?? '', sessionID: undefined, local: true, ...(plan.note ? {note: plan.note} : {})};
      },
      async finishVoice(config, options = {}) {
        if (!begun || closed) throw Error('Microphone connection is not running');
        const id = requestId; begun = false;
        const started = now();
        // Option B (docs/LATENCY_2026-10-14.md): the newest live-words decode may stand in for the transcript while the final decode runs.
        let speculation = null;
        try { speculation = reply && speculate() ? startSpeculation(id, config, options) : null; } catch { speculation = null; }
        let text, seconds, heard;
        try {
          await (ending ?? (ending = capture.end()));
          heard = plan.mode === 'voxtral' ? await recogniseKept(id) : await engine.finish(id);
          ({text, seconds} = heard);
        } catch (error) { speculation?.discard(); countOff(); throw error; }
        countOff();
        try { log(plan.mode === 'voxtral' ? describeRemote(heard, device) : describeRecording(heard, device)); } catch { /* a log line never breaks a recording */ }
        if (closed || !text) { speculation?.discard(); }
        if (closed) throw Error('Microphone finish cancelled');
        if (!text) {
          // Nothing but silence came from the device: name it, so the game can say which input to check instead of "no speech was heard".
          if (Number.isFinite(heard?.peakDb) && heard.peakDb < SILENT_PEAK_DB) {
            throw Object.assign(Error('The microphone "' + clip(device || 'unknown', 80) + '" sends no sound'), {code: SILENT_INPUT_CODE, device: clip(device, 80)});
          }
          throw Error(NO_SPEECH_ERROR);
        }
        const base = {userText: text, local: true, timing: {sttMs: now() - started, audioSeconds: seconds, ...(plan.mode === 'voxtral' ? {sttEngine: heard.engine} : {})}};
        if (!reply) return {...base, text: ''};
        // A reply voiced while it is written (bridge/voice-key-stream.mjs) needs the transcript before the model's first sentence.
        try { options.onTranscript?.(text); } catch { /* a listener never breaks the turn */ }
        let result, speculated = null;
        if (speculation && speculation.matches(text) && !speculation.failed()) {
          speculated = 'kept';
          result = await speculation.adopt();
        } else {
          if (speculation) { speculated = speculation.failed() ? 'failed' : 'restarted'; speculation.discard(); }
          result = await reply({...config, text}, {...options, signal: controller.signal});
        }
        const turn = {...base, ...result, userText: result?.userText ?? text};
        // What the speculative start did, for the turn's record: kept (the reply began on the stable words), restarted (the final words differed).
        if (speculated) turn.timing = {...turn.timing, speculation: speculated};
        return turn;
      },
      // The stop key was pressed: the device closes and the last audio is flushed now, not after the context refresh and the minimum-length
      // wait that come before finishVoice. Nothing said after the key is recorded, and the microphone light goes off at once.
      endCapture() {
        if (!begun || closed || ending) return ending ?? Promise.resolve();
        ending = capture.end();
        ending.catch(() => {}); // finishVoice awaits the same promise and reports the failure
        return ending;
      },
      heard: async () => (requestId && begun && plan.mode !== 'voxtral' ? engine.heard(requestId) : ''),
      async close() {
        if (closed) return;
        closed = true; controller.abort();
        const id = requestId; requestId = null; begun = false;
        kept = []; keptBytes = 0; countOff();
        await capture.abort().catch(() => {});
        if (id && plan.mode !== 'voxtral') await engine.cancel(id).catch(() => {});
      },
    };
  };
}

// The hook object the text provider's host takes (`attachMistral(host, {speech})`): available() says whether recognition can
// run now; voiceChannel({reply}) returns a fresh channel for one recording.
export function createLocalSpeech({stt, capture, log, route = null, transcriber = null, onLanguage, packs = [], alternatives = () => false, idleMs = 90_000,
    setTimer = setTimeout, clearTimer = clearTimeout}) {
  // The recogniser left after its idle time: the page that held the microphone's capture code goes with it (a page in the hidden browser
  // is a renderer process). The next recording opens it again while the recogniser loads, so it adds nothing to the start. With more than
  // one recogniser (the English one, the multilingual packs) and recordings kept for Mistral, the page is released only when no recording
  // is open: after a recogniser's idle exit, or `idleMs` after the last recording that used none.
  let open = 0, timer = null;
  const release = () => { clearTimer(timer); timer = null; if (open === 0) void Promise.resolve(capture.close?.()).catch(() => {}); };
  const track = {
    begin: () => { open++; clearTimer(timer); timer = null; },
    end: () => { open = Math.max(0, open - 1); if (open === 0 && !timer) { timer = setTimer(release, idleMs); timer?.unref?.(); } },
  };
  for (const recogniser of [stt, ...packs]) recogniser.on?.('idle', release);
  return {
    // The voice key works when the English recogniser can take a recording, or another engine can hear the player's language.
    available: () => stt.availability().available || alternatives() === true,
    availability: () => stt.availability(),
    voiceChannel: ({reply, speculate} = {}) => createLocalSttChannel({stt, capture, reply, speculate, log, route, transcriber, onLanguage, track})(),
    warm: () => stt.warm(),
    close: async () => { clearTimer(timer); timer = null; await capture.close?.(); await Promise.allSettled([stt.close(), ...packs.map(pack => pack.close())]); },
  };
}
