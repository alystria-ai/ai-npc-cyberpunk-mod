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

export const NO_SPEECH_ERROR = 'No speech was heard';
// A recording whose loudest moment is below this sent no sound at all: the Windows input is muted, dead or the wrong device.
export const SILENT_PEAK_DB = -55;
export const SILENT_INPUT_CODE = 'MIC_SILENT';
export const STT_UNAVAILABLE_CODE = 'local-stt-unavailable';
const CAPTURE_PATH = '/local-stt';
const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 ms

// Runs on the audio rendering thread: downmix, convert to Int16, post 100 ms blocks. Nothing else.
const WORKLET_SOURCE = `
class LocalSttCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Int16Array(${CHUNK_SAMPLES}); this.used = 0;
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
      if (this.used === ${CHUNK_SAMPLES}) {
        const full = this.block; this.block = new Int16Array(${CHUNK_SAMPLES}); this.used = 0;
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
  async begin() {
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
      channelCountMode: 'explicit'});
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
  async begin(onChunk) {
    const page = await this.ensurePage();
    this.target = encoded => { try { onChunk(Buffer.from(encoded, 'base64')); } catch { /* a consumer fault never stops the capture */ } };
    await page.context().grantPermissions(['microphone'], {origin: this.origin});
    return page.evaluate(() => window.localStt.begin());
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

// A voice channel with the shape of RealtimeHost.voiceChannel(): beginVoice / finishVoice / heard / close.
//
//   stt      a LocalStt (bridge/local-stt.mjs)
//   capture  a LocalSttCapture, or any object with begin(onChunk) / end() / abort()
//   reply    optional async (config, options) => result, the text provider's reply function (the same call a typed turn
//            makes). It receives the turn's configuration with `text` set to the transcript, and options.signal, and returns
//            the reply the bridge publishes. Without it finishVoice returns {userText, text: '', local: true}.
//
// finishVoice rejects with Error('No speech was heard') for an empty recording, which the bridge already turns into
// the game's "No speech was heard" notice (microphone-state.json "no-speech").
export function createLocalSttChannel({stt, capture, reply, now = Date.now, speculate = () => false, log = () => {}}) {
  return () => {
    let requestId = null, closed = false, begun = false, device = '', ending = null;
    const controller = new AbortController();
    const pass = chunk => { if (requestId) stt.pushAudio(chunk); };
    // The reply on a stable live-words decode, started the moment the key is pressed (stt.stable()). Returns null when the newest decode
    // cannot stand in for the transcript. The reply is written into a stream of its own and held back from the voice, the memory and the
    // game's actions until the final words are known: `adopt` hands it over when they agree, `discard` throws it away when they do not.
    const startSpeculation = (id, config, options) => {
      if (!reply || typeof stt.stable !== 'function') return null;
      let guess; try { guess = stt.stable(id); } catch { return null; }
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
    return {
      async beginVoice(config) {
        if (closed) throw Error('Microphone connection is closed');
        const availability = stt.availability();
        if (!availability.available) {
          const error = Error('Local speech recognition is not installed (' + availability.reason + ')');
          error.code = STT_UNAVAILABLE_CODE; error.reason = availability.reason; throw error;
        }
        requestId = config?.requestId ?? randomUUID(); ending = null;
        // The model loads while the device opens; chunks are held until it is ready.
        await stt.start(requestId);
        let info;
        try { info = await capture.begin(pass); }
        catch (error) { await stt.cancel(requestId); requestId = null; throw error; }
        begun = true;
        device = info?.device || '';
        try { log(describeInput(info)); } catch { /* a log line never breaks a recording */ }
        if (closed) { await capture.abort(); await stt.cancel(requestId); throw Error('Microphone startup cancelled'); }
        return {device: info?.device ?? '', sessionID: undefined, local: true};
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
          heard = await stt.finish(id);
          ({text, seconds} = heard);
        } catch (error) { speculation?.discard(); throw error; }
        try { log(describeRecording(heard, device)); } catch { /* a log line never breaks a recording */ }
        if (closed || !text) { speculation?.discard(); }
        if (closed) throw Error('Microphone finish cancelled');
        if (!text) {
          // Nothing but silence came from the device: name it, so the game can say which input to check instead of "no speech was heard".
          if (Number.isFinite(heard?.peakDb) && heard.peakDb < SILENT_PEAK_DB) {
            throw Object.assign(Error('The microphone "' + clip(device || 'unknown', 80) + '" sends no sound'), {code: SILENT_INPUT_CODE, device: clip(device, 80)});
          }
          throw Error(NO_SPEECH_ERROR);
        }
        const base = {userText: text, local: true, timing: {sttMs: now() - started, audioSeconds: seconds}};
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
      heard: async () => (requestId && begun ? stt.heard(requestId) : ''),
      async close() {
        if (closed) return;
        closed = true; controller.abort();
        const id = requestId; requestId = null; begun = false;
        await capture.abort().catch(() => {});
        if (id) await stt.cancel(id).catch(() => {});
      },
    };
  };
}

// The hook object the text provider's host takes (`attachMistral(host, {speech})`): available() says whether recognition can
// run now; voiceChannel({reply}) returns a fresh channel for one recording.
export function createLocalSpeech({stt, capture, log}) {
  // The recogniser left after its idle time: the page that held the microphone's capture code goes with it (a page in the hidden browser
  // is a renderer process). The next recording opens it again while the recogniser loads, so it adds nothing to the start.
  stt.on?.('idle', () => { void Promise.resolve(capture.close?.()).catch(() => {}); });
  return {
    available: () => stt.availability().available,
    availability: () => stt.availability(),
    voiceChannel: ({reply, speculate} = {}) => createLocalSttChannel({stt, capture, reply, speculate, log})(),
    warm: () => stt.warm(),
    close: async () => { await capture.close?.(); await stt.close(); },
  };
}
