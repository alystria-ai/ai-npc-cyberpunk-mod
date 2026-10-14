// Local speech-to-text for providers that have none of their own (the Mistral text provider).
//
// Engine: Moonshine Tiny (English, MIT, 27 M parameters, int8) run by sherpa-onnx in a small Python worker
// (bridge/local-stt-worker.py) on the CPU, one thread at below-normal priority. A 3-8 s utterance decodes in about
// 0.3-0.5 s, and in about 0 s when a live-words decode already covered it. The worker exists only from the moment a recording starts until `idleMs` after the last one.
// Nothing here runs while no recording is open. API and integration notes: docs/LOCAL_STT.md.
//
//   const stt = new LocalStt({project, pythonExecutable});
//   stt.availability()           -> {available, reason}      reason: python-missing | worker-missing | model-missing | engine-missing
//   stt.available()              -> boolean
//   await stt.start(requestId)   begin a recording (spawns the worker if needed; audio is held until it is ready)
//   stt.pushAudio(chunk)         Buffer / Uint8Array / Int16Array of 16 kHz mono Int16 samples
//   stt.on('partial', ({requestId, text}) => ...)   the words heard so far, about once a second while recording
//   stt.on('failure', error => ...)                 the worker died or could not start during a recording
//   stt.heard(requestId)         the latest partial text ('' when none)
//   await stt.finish(requestId)  -> {text, seconds, ms, speech}   text is '' when nothing was said
//   await stt.cancel(requestId)
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {setPriority, constants as osConstants} from 'node:os';
import {SpeechActivity} from './stt-activity.mjs';

export const LOCAL_STT_ENGINE = 'moonshine-tiny-en-int8';
export const MODEL_FILES = Object.freeze(['preprocess.onnx', 'encode.int8.onnx', 'uncached_decode.int8.onnx',
  'cached_decode.int8.onnx', 'tokens.txt']);
export const SAMPLE_RATE = 16000;
export const LOCAL_STT_LIMITS = Object.freeze({
  threads: 1, maxThreads: 4,   // one thread: onnxruntime's pools spin-wait, so 2 threads decode only ~30% faster for ~3x the CPU
  partialIntervalMs: 1200,       // minimum gap between live-word decodes
  partialDutyFactor: 6,          // and at least this many times the last decode's own duration (about 15% of one worker core)
  minPartialAudioMs: 500,        // new audio needed before the next partial is worth decoding
  idleMs: 90_000,                // the worker exits this long after the last recording
  startupMs: 30_000,             // time allowed for the model to load
  finishMs: 20_000,              // time allowed for the final decode
  maxSeconds: 45,                // audio beyond this is ignored (the game finishes a recording at 30 s)
  pauseMs: 300,                  // quiet this long after speech asks for a live-words decode at once (the pause decode), not at the next tick
  pauseDecodes: 6,               // at most this many pause decodes in one recording
  partialWindowSeconds: 8,       // the worker decodes the newest 8 s for a live-words decode (PARTIAL_WINDOW in the worker)
  settleMs: 150,                 // a live decode stands in for the transcript only when it also heard this much quiet after the speech
});

const HEARD_LIMIT = 100;
// The words of a transcript, for comparing two of them: lower case, letters and digits only (an apostrophe stays inside a word).
export const wordsOf = text => String(text ?? '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}']+/gu, ' ').replace(/(^|\s)'+|'+(?=\s|$)/g, ' ').trim().split(/\s+/).filter(Boolean);
export const sameWords = (a, b) => { const x = wordsOf(a), y = wordsOf(b); return x.length === y.length && x.every((word, at) => word === y[at]); };
// Moonshine's usual mishearings of this game's names. Applied to the final transcript only, whole-phrase and
// case-insensitive; deliberately short. Callers can pass their own list (fixups option).
export const DEFAULT_FIXUPS = Object.freeze([
  [/\bpan\s*(?:am|m|em|um|ham)\b/gi, 'Panam'],
  [/\bafter\s+life\b/gi, 'Afterlife'],
  [/\b(?:ares\s*acha|ere\s*zochet|ara\s*saka|arasaka|erezaka|ares\s*aka)\b/gi, 'Arasaka'],
  [/\bsilver\s*hand\b/gi, 'Silverhand'],
]);

export function resolveLocalSttPaths({project, environment = process.env, pythonExecutable} = {}) {
  const python = environment.CYBERPUNK_CONVAI_LOCAL_STT_PYTHON || pythonExecutable || environment.CYBERPUNK_CONVAI_PYTHON || null;
  const candidates = [environment.CYBERPUNK_CONVAI_STT_MODEL,
    project && resolve(project, 'models/stt', LOCAL_STT_ENGINE),
    project && resolve(project, 'runtime/stt-model', LOCAL_STT_ENGINE)].filter(Boolean);
  const modelDirectory = candidates.find(path => MODEL_FILES.every(name => existsSync(resolve(path, name)))) ?? candidates[0] ?? null;
  return {python, modelDirectory, worker: project ? resolve(project, 'bridge/local-stt-worker.py') : null};
}

const int16 = chunk => {
  if (chunk instanceof Int16Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength - chunk.byteLength % 2);
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  throw TypeError('Audio must be 16 kHz mono Int16 samples');
};

export class LocalStt extends EventEmitter {
  // project: the application directory (bridge/ lives in it). pythonExecutable: the interpreter that has sherpa-onnx
  // (the packaged Python, or vendor/pocket-tts-env in development). Everything else is for tests.
  constructor({project, pythonExecutable, environment = process.env, threads = LOCAL_STT_LIMITS.threads,
      partials = true, partialIntervalMs = LOCAL_STT_LIMITS.partialIntervalMs, idleMs = LOCAL_STT_LIMITS.idleMs,
      startupMs = LOCAL_STT_LIMITS.startupMs, finishMs = LOCAL_STT_LIMITS.finishMs, fixups = DEFAULT_FIXUPS,
      spawnImpl = spawn, exists = existsSync, setTimer = setTimeout, clearTimer = clearTimeout,
      paths = resolveLocalSttPaths({project, environment, pythonExecutable}), lowerPriority = true,
      priority = 'below', pausePartials = true, pauseMs = LOCAL_STT_LIMITS.pauseMs, exitMs = 2000} = {}) {
    super();
    Object.assign(this, {paths, threads: Math.max(1, Math.min(LOCAL_STT_LIMITS.maxThreads, threads | 0 || 1)), partials,
      partialIntervalMs, idleMs, startupMs, finishMs, fixups, spawnImpl, exists, setTimer, clearTimer, lowerPriority,
      pausePartials, pauseMs, exitMs, priority: ['normal', 'below', 'idle'].includes(priority) ? priority : 'below'});
    this.worker = null;       // {child, ready, readyPromise, buffer}
    this.session = null;      // {id, held[], bytes, sentBytes, partialBytes, partialBusy, text, waiter}
    this.idleTimer = null; this.partialTimer = null;
    this.failure = null;
  }

  availability() {
    const {python, modelDirectory, worker} = this.paths;
    if (!python || !this.exists(python)) return {available: false, reason: 'python-missing'};
    if (!worker || !this.exists(worker)) return {available: false, reason: 'worker-missing'};
    if (!modelDirectory || !MODEL_FILES.every(name => this.exists(resolve(modelDirectory, name))))
      return {available: false, reason: 'model-missing'};
    // The interpreter's site-packages hold sherpa-onnx (embedded: <root>/Lib/site-packages; venv: <root>/Lib/site-packages).
    const roots = [dirname(python), dirname(dirname(python))];
    if (!roots.some(root => this.exists(resolve(root, 'Lib/site-packages/sherpa_onnx')))) return {available: false, reason: 'engine-missing'};
    return {available: true, reason: null};
  }
  available() { return this.availability().available; }

  // Starts the worker ahead of a recording (optional; start() does it too).
  warm() { return this.ensureWorker().then(() => true, () => false); }

  ensureWorker() {
    this.clearTimer(this.idleTimer); this.idleTimer = null;
    if (this.worker) return this.worker.readyPromise;
    const availability = this.availability();
    if (!availability.available) {
      const error = Error('Local speech recognition is not available (' + availability.reason + ')');
      error.code = 'local-stt-unavailable'; error.reason = availability.reason;
      return Promise.reject(error);
    }
    const {python, modelDirectory, worker: script} = this.paths;
    const child = this.spawnImpl(python, ['-B', '-I', script, '--model', modelDirectory, '--threads', String(this.threads), '--priority', this.priority],
      {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: {...process.env, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1',
        OMP_NUM_THREADS: String(this.threads)}});
    const state = {child, ready: false, buffer: '', exited: false, info: null};
    state.readyPromise = new Promise((resolveReady, rejectReady) => {
      state.resolveReady = resolveReady; state.rejectReady = rejectReady;
    });
    state.readyPromise.catch(() => {});
    this.worker = state;
    const timer = this.setTimer(() => this.fail(state, Error('Local speech recognition took too long to start')), this.startupMs);
    state.startTimer = timer;
    try { if (this.lowerPriority && child.pid) setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => {
      state.buffer += text;
      let at;
      while ((at = state.buffer.indexOf('\n')) >= 0) {
        const line = state.buffer.slice(0, at).trim(); state.buffer = state.buffer.slice(at + 1);
        if (!line) continue;
        let message; try { message = JSON.parse(line); } catch { continue; }
        this.onMessage(state, message);
      }
    });
    child.stderr?.on('data', () => {}); // diagnostics stay out of the bridge log; a failure is reported through the 'failure' event and the rejected finish()
    state.exitPromise = new Promise(done => { child.once('exit', done); child.once('error', done); });
    child.once('error', error => this.fail(state, error));
    child.once('exit', code => { state.exited = true; this.fail(state, Error('Local speech recognition stopped (exit ' + code + ')')); });
    return state.readyPromise;
  }

  fail(state, error) {
    if (state.failed) return;
    state.failed = true;
    this.clearTimer(state.startTimer);
    if (this.worker === state) this.worker = null;
    state.rejectReady?.(error);
    try { if (!state.exited) state.child.kill(); } catch { /* already gone */ }
    const session = this.session;
    if (session?.worker === state) {
      this.stopPartials();
      const waiter = session.waiter; this.session = null;
      this.failure = error;
      waiter?.reject(error);
      this.emit('failure', error);
    }
  }

  onMessage(state, message) {
    if (message.type === 'ready') {
      this.clearTimer(state.startTimer);
      state.ready = true; state.info = message;
      state.resolveReady(message);
      this.flush(state);
    } else if (message.type === 'partial') {
      const session = this.session;
      if (!session || session.id !== message.id) return;
      session.partialBusy = false;
      session.nextPartialAt = Date.now() + Math.max(this.partialIntervalMs, (Number(message.ms) || 0) * LOCAL_STT_LIMITS.partialDutyFactor);
      session.pauseNotBefore = Date.now() + (Number(message.ms) || 0);   // a pause decode follows a decode after at least its own duration
      const text = typeof message.text === 'string' ? message.text : '';
      // What this decode covered: the audio that had been sent when it was asked for (the worker decodes in order).
      const asked = session.inflight; session.inflight = null;
      if (text && asked) {
        session.history.push({text: this.polish(text), coveredBytes: asked.coveredBytes, at: Date.now(), ms: Number(message.ms) || 0});
        if (session.history.length > 8) session.history.shift();
      }
      if (text && text !== session.text) {
        session.text = text;
        this.emit('partial', {requestId: session.id, text: this.shorten(text)});
      }
      this.maybePausePartial(session);
    } else if (message.type === 'final') {
      const session = this.session;
      if (!session || session.id !== message.id) return;
      this.stopPartials(); this.session = null;
      this.armIdle();
      session.waiter?.resolve({text: this.polish(message.text), seconds: message.seconds, ms: message.ms, speech: message.speech === true,
        reused: message.reused === true, cpuMs: message.cpuMs,
        // What the microphone gave (loudest sound in dBFS, ms of sound, ms of it voiced) and, when words were held back as not a person
        // speaking, why and what they were: for the log, so a wrong or dead input and a hallucinating model can be told apart.
        peakDb: Number.isFinite(message.peakDb) ? message.peakDb : null, soundMs: Number.isFinite(message.soundMs) ? message.soundMs : null,
        voicedMs: Number.isFinite(message.voicedMs) ? message.voicedMs : null,
        rejected: typeof message.rejected === 'string' ? message.rejected : null, ignored: typeof message.ignored === 'string' ? message.ignored : ''});
    } else if (message.type === 'error') {
      if (!state.ready) { this.fail(state, Error(message.message || 'Local speech recognition failed to start')); return; }
      const session = this.session;
      if (session && (message.id === undefined || session.id === message.id)) { session.partialBusy = false; session.inflight = null; }
      if (session?.waiter && message.id === session.id) {
        this.stopPartials(); this.session = null; this.armIdle();
        session.waiter.reject(Error(message.message || 'Local speech recognition failed'));
      }
    }
  }

  send(state, message) {
    try { state.child.stdin.write(JSON.stringify(message) + '\n'); return true; } catch { return false; }
  }

  // Sends everything held while the worker was loading.
  flush(state) {
    const session = this.session;
    if (!session || session.worker !== state || !state.ready) return;
    this.send(state, {op: 'begin', id: session.id});
    for (const chunk of session.held) this.send(state, {op: 'audio', id: session.id, pcm: chunk.toString('base64')});
    session.held = [];
    if (session.finishRequested) this.send(state, {op: 'finish', id: session.id});
    else this.schedulePartials();
  }

  async start(requestId) {
    if (typeof requestId !== 'string' || !requestId) throw TypeError('A recording needs a request id');
    if (this.session) await this.cancel(this.session.id);
    this.failure = null;
    const readyPromise = this.ensureWorker();   // rejects with code local-stt-unavailable when not installed
    if (!this.worker) await readyPromise;
    const state = this.worker;
    this.session = {id: requestId, worker: state, held: [], bytes: 0, partialBytes: 0, partialBusy: false, text: '',
      waiter: null, finishRequested: false, startedAt: Date.now(), activity: new SpeechActivity(), history: [], inflight: null,
      pauseAskedFor: -1, pauseDecodes: 0, pauseNotBefore: 0};
    if (state.ready) this.flush(state);
    // The model loads while the device opens: do not wait for it here, finish() does.
    readyPromise.catch(() => {});
    return true;
  }

  pushAudio(chunk, requestId) {
    const session = this.session;
    if (!session || (requestId !== undefined && session.id !== requestId) || session.finishRequested) return false;
    const bytes = int16(chunk);
    if (!bytes.length) return false;
    const limit = LOCAL_STT_LIMITS.maxSeconds * SAMPLE_RATE * 2;
    if (session.bytes >= limit) return false;
    const take = bytes.length > limit - session.bytes ? bytes.subarray(0, limit - session.bytes - (limit - session.bytes) % 2) : bytes;
    session.bytes += take.length;
    if (session.worker.ready) this.send(session.worker, {op: 'audio', id: session.id, pcm: Buffer.from(take).toString('base64')});
    else session.held.push(Buffer.from(take));
    session.activity.push(take);
    this.maybePausePartial(session);
    return true;
  }

  // The player stopped talking (quiet for pauseMs after speech) and no decode has covered the end of that speech yet: decode now
  // instead of at the next 1.2 s tick, so by the time the key is pressed again the newest words are already read and finish() has
  // nothing left to decode. Once per pause, never while a decode is running, never more than `pauseDecodes` times per recording.
  maybePausePartial(session) {
    if (!this.partials || !this.pausePartials || this.session !== session || session.finishRequested || !session.worker.ready
        || session.partialBusy || session.pauseDecodes >= LOCAL_STT_LIMITS.pauseDecodes || Date.now() < session.pauseNotBefore) return;
    const activity = session.activity;
    if (!activity.heardSpeech || activity.quietMs < this.pauseMs) return;
    const end = activity.speechEndBytes;
    if (session.partialBytes >= end || session.pauseAskedFor === end) return;
    session.pauseAskedFor = end; session.pauseDecodes++;
    this.requestPartial(session);
  }

  requestPartial(session) {
    session.partialBusy = true; session.partialBytes = session.bytes;
    session.inflight = {coveredBytes: session.bytes, at: Date.now()};
    this.send(session.worker, {op: 'partial', id: session.id});
  }

  /**
   * The words of the newest live-words decode when they can stand as the transcript, for a reply that is started before the final decode
   * is back (docs/LATENCY_2026-10-14.md, option B). Called when the key is pressed again. null unless ALL of these hold:
   *   - the decode has words;
   *   - the player had stopped: no speech frame came after the audio the decode covered (a decode that missed even one word is the common
   *     way a partial differs from the final: measured, 0 of 7 such partials were the final words);
   *   - the decode heard the quiet after the speech (`settleMs` of it): a decode cut at the last syllable can lose its end;
   *   - the decode read the whole speech: it looks at the newest 8 s only, so a recording longer than that is fine only when the first word
   *     is inside that window.
   * `{text, coveredBytes, quietAfterMs, decodes, agree}`; `agree` says the decode before it had the same words (punctuation and case aside).
   * The caller confirms the text against the final transcript and starts over when they differ.
   */
  stable(requestId) {
    const session = this.session;
    if (!session || (requestId !== undefined && session.id !== requestId) || !session.history.length) return null;
    const newest = session.history.at(-1), before = session.history.at(-2), activity = session.activity;
    if (!newest.text || !activity.heardSpeech || activity.speechMsAfter(newest.coveredBytes) > 0) return null;
    const quietAfterMs = (newest.coveredBytes - activity.speechEndBytes) * 1000 / (SAMPLE_RATE * 2);
    if (quietAfterMs < LOCAL_STT_LIMITS.settleMs) return null;
    const windowStart = Math.max(0, newest.coveredBytes - LOCAL_STT_LIMITS.partialWindowSeconds * SAMPLE_RATE * 2);
    if (windowStart > 0 && windowStart > activity.speechStartBytes) return null;
    return {text: newest.text, coveredBytes: newest.coveredBytes, quietAfterMs: Math.round(quietAfterMs), decodes: session.history.length,
      agree: !!before && sameWords(before.text, newest.text)};
  }

  heard(requestId) {
    const session = this.session;
    return session && (requestId === undefined || session.id === requestId) ? this.shorten(session.text) : '';
  }

  finish(requestId) {
    const session = this.session;
    if (!session || (requestId !== undefined && session.id !== requestId))
      return Promise.reject(this.failure ?? Error('No recording is open'));
    if (session.waiter) return session.waiter.promise;
    this.stopPartials();
    session.finishRequested = true;
    const waiter = session.waiter = {};
    waiter.promise = new Promise((resolveFinal, rejectFinal) => { waiter.resolve = resolveFinal; waiter.reject = rejectFinal; });
    const timer = this.setTimer(() => {
      if (this.session === session) {
        this.session = null;
        waiter.reject(Error('Local speech recognition timed out'));
        if (this.worker) this.fail(this.worker, Error('Local speech recognition timed out'));
      }
    }, this.finishMs + (session.worker.ready ? 0 : this.startupMs));
    waiter.promise.then(() => this.clearTimer(timer), () => this.clearTimer(timer));
    if (session.worker.ready) this.send(session.worker, {op: 'finish', id: session.id});
    else if (this.failure) waiter.reject(this.failure);
    return waiter.promise;
  }

  async cancel(requestId) {
    const session = this.session;
    if (!session || (requestId !== undefined && session.id !== requestId)) return;
    this.stopPartials(); this.session = null;
    if (session.worker.ready) this.send(session.worker, {op: 'cancel', id: session.id});
    session.waiter?.reject(Object.assign(Error('Recording cancelled'), {code: 'cancelled'}));
    this.armIdle();
  }

  schedulePartials() {
    if (!this.partials || this.partialTimer) return;
    const tick = () => {
      this.partialTimer = null;
      const session = this.session;
      if (!session || session.finishRequested || !session.worker.ready) return;
      const fresh = session.bytes - session.partialBytes;
      if (!session.partialBusy && Date.now() >= (session.nextPartialAt ?? 0) && fresh >= LOCAL_STT_LIMITS.minPartialAudioMs * SAMPLE_RATE * 2 / 1000) {
        this.requestPartial(session);
      }
      this.partialTimer = this.setTimer(tick, this.partialIntervalMs);
      this.partialTimer.unref?.();
    };
    this.partialTimer = this.setTimer(tick, this.partialIntervalMs);
    this.partialTimer.unref?.();
  }
  stopPartials() { this.clearTimer(this.partialTimer); this.partialTimer = null; }

  armIdle() {
    this.clearTimer(this.idleTimer);
    if (!this.worker) return;
    // 'idle': the recogniser is gone and nothing records; the microphone page (bridge/local-stt-capture.mjs) is closed with it.
    this.idleTimer = this.setTimer(() => { if (!this.session) { void this.shutdown(); this.emit('idle'); } }, this.idleMs);
    this.idleTimer.unref?.();
  }

  // Ends the worker (memory back to the game). A later start() spawns a fresh one. Resolves when the process has exited (it is told to
  // quit and its input is closed; one that is still there after `exitMs` is killed, with its children where the platform has them),
  // or after a bounded wait when even that did not end it. The bridge's own shutdown awaits this, so no recogniser outlives it.
  shutdown() {
    this.clearTimer(this.idleTimer); this.idleTimer = null; this.stopPartials();
    const state = this.worker; this.worker = null;
    if (!state) return Promise.resolve();
    this.clearTimer(state.startTimer);
    this.send(state, {op: 'quit'});
    try { state.child.stdin.end(); } catch { /* closed */ }
    return new Promise(done => {
      const kill = this.setTimer(() => { this.killTree(state); }, this.exitMs);
      const giveUp = this.setTimer(done, this.exitMs * 2);
      state.exitPromise.then(() => { this.clearTimer(kill); this.clearTimer(giveUp); done(); });
    });
  }
  killTree(state) {
    try {
      if (process.platform === 'win32' && this.spawnImpl === spawn && state.child.pid) {
        spawn('taskkill', ['/PID', String(state.child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'}).on('error', () => {});
        return;
      }
    } catch { /* fall through to a plain kill */ }
    try { state.child.kill(); } catch { /* gone */ }
  }
  async close() {
    const session = this.session;
    if (session) await this.cancel(session.id);
    await this.shutdown();
  }

  // Live words are short single lines, newest words last (the game shows the tail).
  shorten(text) {
    const clean = String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    const points = [...clean];
    if (points.length <= HEARD_LIMIT) return clean;
    const tail = points.slice(-HEARD_LIMIT).join('');
    const space = tail.indexOf(' ');
    return '…' + (space > 0 && space < 24 ? tail.slice(space + 1) : tail);
  }
  polish(text) {
    let out = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    for (const [pattern, replacement] of this.fixups) out = out.replace(pattern, replacement);
    // Punctuation or a lone filler is what silence usually decodes to.
    if (!/[\p{L}\p{N}]/u.test(out)) return '';
    return out.slice(0, 1200);
  }
}
