import {abortable, cancelled, throwIfCancelled} from './transport-pool.mjs';
import {markStage} from './turn-clock.mjs';

const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const SHA = /^[a-f0-9]{64}$/;
const OWNER = /^[a-f0-9]{32}$/;
const JSON_LIMIT = 32 * 1024 * 1024;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const textValue = (value, limit) => typeof value === 'string' && value.length <= limit
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const packetIdentity = value => JSON.stringify([value.owner, value.id, value.profile, value.modelSha256]);

function jsonCopy(value, label) {
  let raw;
  try { raw = JSON.stringify(value); } catch { throw Error(`Invalid ${label}`); }
  if (typeof raw !== 'string' || raw.length > JSON_LIMIT || Buffer.byteLength(raw, 'utf8') > JSON_LIMIT)
    throw Error(`Invalid ${label} size`);
  return JSON.parse(raw);
}

/**
 * The owned copy of a facial prefix. A producer that builds a new face object on every poll but keeps the very same row arrays until its timeline changes (a poll that
 * only moved the audible cursor; bridge/pocket-facial-stream.mjs) says so with `rows`, a key that changes with the rows. Rows under one key are copied once and the
 * copy is reused, and only the small rest of the face (its fields, its coverage) is copied on each poll. A face with no `rows` is copied whole every time, as it
 * always was. Nothing downstream changes a face (it is read, validated, spread into a new object, written), so a shared copy of rows that did not change is never
 * seen to move. `rows` is the producer's note, not part of the face: the copy has none. `cache` ({rows, copy}) is the caller's, one per turn.
 */
export function ownedFaceCopy(face, cache) {
  const rows = typeof face?.rows === 'string' ? face.rows : null;
  if (rows !== null && Array.isArray(face.frames) && cache.copy && cache.rows === rows) {
    const {frames: _frames, modelExpressions, rows: _rows, ...rest} = face;
    const light = jsonCopy({...rest, ...(modelExpressions ? {modelExpressions: {...modelExpressions, frames: []}} : {})}, 'local PCM facial prefix');
    return {...light, frames: cache.copy.frames, ...(modelExpressions ? {modelExpressions: {...light.modelExpressions, frames: cache.copy.modelExpressions.frames}} : {})};
  }
  const copy = jsonCopy(face, 'local PCM facial prefix');
  if (rows !== null && Array.isArray(face.frames)) { cache.rows = rows; cache.copy = copy; }
  delete copy.rows;
  return copy;
}

// Match encodePcmWav's established PCM16 device conversion. No normalization,
// trimming, fades, resampling or packet-level sound objects enter this path.
export function ownedLocalPcmPacket(packet, {token, frames, index, identity} = {}) {
  if (!packet || packet.version !== 1 || packet.engine !== 'pocket-tts'
      || packet.sampleRate !== 24000 || packet.channels !== 1 || packet.format !== 'f32le'
      || typeof packet.owner !== 'string' || !OWNER.test(packet.owner) || !Number.isSafeInteger(packet.id) || packet.id < 1
      || !textValue(packet.profile, 128) || !packet.profile || typeof packet.modelSha256 !== 'string' || !SHA.test(packet.modelSha256)
      || !integer(packet.index) || packet.index !== index + 1
      || !integer(packet.offsetFrames) || packet.offsetFrames !== frames
      || !integer(packet.frames) || packet.frames < 1 || packet.frames > 96000
      || !(packet.pcm instanceof Float32Array) || packet.pcm.length !== packet.frames
      || frames + packet.frames > 24000 * 120) throw Error('Local PCM packet is malformed or out of order');
  const nextIdentity = packetIdentity(packet);
  if (identity && identity !== nextIdentity) throw Error('Local PCM producer changed');
  // Own both the source samples and immutable routing fields before any await.
  const pcm = packet.pcm.slice(), bytes = Buffer.allocUnsafe(pcm.length * 2);
  for (let at = 0; at < pcm.length; at++) {
    if (!Number.isFinite(pcm[at])) throw Error('Local PCM contains non-finite samples');
    bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[at])) * 32767), at * 2);
  }
  return {identity: nextIdentity, packet: {version: 1, engine: 'pocket-tts', token,
    owner: packet.owner, id: packet.id, profile: packet.profile, modelSha256: packet.modelSha256,
    sampleRate: 24000, channels: 1, format: 's16le', index: packet.index,
    offsetFrames: packet.offsetFrames, frames: packet.frames, pcm: bytes.toString('base64')}};
}

export async function localSnapshotForHost(page, token, signal) {
  const raw = await abortable(page.evaluate(token => JSON.stringify(window.localPcm.snapshot(token)), token), signal);
  if (typeof raw !== 'string' || raw.length > JSON_LIMIT || Buffer.byteLength(raw, 'utf8') > JSON_LIMIT)
    throw Error('Invalid local PCM snapshot size');
  let value;
  try { value = JSON.parse(raw); } catch { throw Error('Invalid local PCM snapshot encoding'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || value.token !== token
      || value.engine !== 'pocket-tts' || value.voiceProvider !== 'pocket'
      || value.sampleRate !== 24000 || value.channels !== 1 || !integer(value.receivedFrames)
      || value.receivedFrames > 24000 * 120 || typeof value.sourceComplete !== 'boolean'
      || typeof value.ended !== 'boolean' || !Number.isFinite(value.positionSeconds)
      || value.positionSeconds < 0 || value.positionSeconds > value.receivedFrames / 24000 + .025)
    throw Error('Invalid local PCM snapshot');
  return value;
}

// One page is independent of every Convai transport lease and session. A turn
// owns it from startup through device drain; failures retire it before reuse.
export class LocalPcmHost {
  constructor({createPage, pollMs = 40, timeoutMs = 150000, commandTimeoutMs = 5000,
    cleanupTimeoutMs = 2500, now = () => performance.now(), levelLog = null, label = 'voice'} = {}) {
    if (typeof createPage !== 'function') throw Error('Local PCM page factory is required');
    Object.assign(this, {createPage, pollMs, timeoutMs, commandTimeoutMs, cleanupTimeoutMs, now, levelLog, label});
    this.active = null; this.page = null; this.epoch = 0; this.retirements = new WeakMap();
  }

  async bounded(task, ms, message, signal) {
    let timer;
    try { return await abortable(Promise.race([Promise.resolve(task),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(Error(message)), ms); })]), signal); }
    finally { clearTimeout(timer); }
  }

  dispose(page) {
    if (!page || page.isClosed?.()) return Promise.resolve();
    if (this.retirements.has(page)) return this.retirements.get(page);
    const retirement = (async () => {
      try {
        await this.bounded(Promise.resolve().then(() => page.close({runBeforeUnload: false})),
          this.cleanupTimeoutMs, 'Local PCM page retirement timed out');
      } catch (error) {
        // browser.newPage() creates this renderer's own context. A failed page
        // close can retire that context without touching any Convai sessions.
        const context = page.context?.();
        if (!context || typeof context.close !== 'function') throw error;
        await this.bounded(Promise.resolve().then(() => context.close()),
          this.cleanupTimeoutMs, 'Local PCM context retirement timed out');
      }
    })().catch(error => { this.failure ||= error; throw error; });
    this.retirements.set(page, retirement); return retirement;
  }

  // liveText: optional () => ({text, complete}). A reply whose text is still being written (bridge/reply-stream.mjs) starts the voice on
  // its first sentence; the renderer holds only that text, so each clock snapshot carries the live text and whether it is final.
  // wake: optional () => Promise|undefined. A pending promise ends the wait between two clock polls early when it resolves (the game's lease
  // file was just replaced, docs/LATENCY_2026-10-13.md 4.2), as the Convai host's liveSpeech.wake does.
  async play(config, producer, {signal, current = () => true, onFrame, getFace, liveText, wake} = {}) {
    throwIfCancelled(signal);
    if (this.failure) throw this.failure;
    if (this.active || this.closing) throw Error('Local PCM playback is already owned');
    if (!config || typeof config.token !== 'string' || !TOKEN.test(config.token) || !textValue(config.text, 12000) || !config.text.trim()
        || (config.userText !== undefined && !textValue(config.userText, 1200))
        || typeof producer !== 'function' || typeof current !== 'function' || typeof onFrame !== 'function'
        || (getFace !== undefined && typeof getFace !== 'function') || (liveText !== undefined && typeof liveText !== 'function')
        || (wake !== undefined && typeof wake !== 'function')) throw Error('Invalid local PCM admission');
    // Take a separate immutable copy of text and provider emotion correlation.
    config = jsonCopy(config, 'local PCM admission');
    const controller = new AbortController(), epoch = this.epoch;
    const turn = {token: config.token, controller, epoch}; this.active = turn;
    const cancel = () => controller.abort(cancelled());
    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel();
    const deadline = setTimeout(() => controller.abort(Error('Local PCM playback timed out')), this.timeoutMs);
    let producerTask, pump, page, result, final, succeeded = false, frames = 0, index = 0, identity;
    const faceCopies = {};   // the last facial prefix's row arrays and their owned copy (ownedFaceCopy)
    let emitting = false, firstAcceptedMs = null, rendererReady, rendererReadyMs = null, sentMakeup, levelLogged = false;
    // Ends the clock poll's sleep the moment the renderer accepts the first audio: that snapshot is the one that publishes the reply,
    // so it should not wait out the rest of a 40 ms sleep (docs/perf, LATENCY.md: 20 to 45 ms per reply in the live records).
    let firstAudio = null, audioRepolled = false;
    const started = this.now();
    markStage('playStart');
    const check = async () => {
      if (controller.signal.aborted) throw controller.signal.reason || cancelled();
      if (this.active !== turn || this.epoch !== epoch || !await abortable(Promise.resolve().then(current), controller.signal))
        throw cancelled('Local PCM owner changed');
      if (controller.signal.aborted) throw controller.signal.reason || cancelled();
    };
    const evaluate = (fn, payload) => this.bounded(Promise.resolve().then(() => page.evaluate(fn, payload)),
      this.commandTimeoutMs, 'Local PCM renderer did not respond', controller.signal);
    const emit = async packet => {
      if (emitting) throw Error('Local PCM packets overlapped');
      // Copy before check() awaits the external game owner.
      const owned = ownedLocalPcmPacket(packet, {token: turn.token, frames, index, identity});
      emitting = true;
      try {
        // The renderer opens while synthesis starts; samples wait for it here.
        await rendererReady;
        await check();
        const ack = await evaluate(packet => window.localPcm.append(packet), owned.packet);
        await check();
        const expected = owned.packet;
        if (!ack || ack.version !== 1 || ack.token !== turn.token || ack.index !== expected.index
            || ack.offsetFrames !== frames || ack.frames !== expected.frames || ack.receivedFrames !== frames + expected.frames)
          throw Error('Local PCM renderer did not acknowledge the owned copy');
        frames += expected.frames; index = expected.index; identity = owned.identity;
        if (firstAcceptedMs === null) { firstAcceptedMs = this.now() - started; markStage('firstPcmAccepted'); firstAudio?.(); }
        return ack;
      } finally { emitting = false; }
    };
    try {
      await check();
      // Opening the page and its AudioContext/worklet (about 100 ms warm, about
      // 1 s for the first page) overlaps the producer's first-packet latency
      // instead of preceding it. Packets and the clock pump wait for it; the
      // renderer still plays nothing before the game's admission.
      rendererReady = (async () => {
        // A page being warmed is this turn's page: wait for it instead of opening a second one.
        if (!this.page && this.warming) await this.bounded(this.warming, this.commandTimeoutMs * 4, 'Local PCM page startup timed out', controller.signal).catch(() => {});
        if (this.page?.isClosed?.()) this.page = null;
        if (!this.page) {
          const creating = Promise.resolve().then(() => this.createPage());
          // A factory may finish after cancellation. It may never donate that
          // late page to another turn or leave it rendering outside its owner.
          creating.then(value => {
            if (controller.signal.aborted || this.active !== turn || this.epoch !== epoch)
              void this.dispose(value).catch(() => {});
          }, () => {});
          page = await this.bounded(creating, this.commandTimeoutMs, 'Local PCM page startup timed out', controller.signal);
          await check(); this.page = page;
        } else page = this.page;
        turn.page = page;
        await evaluate(config => window.localPcm.begin(config), config);
        await check();
        rendererReadyMs = this.now() - started; markStage('rendererReady');
      })();
      rendererReady.catch(() => {});
      pump = (async () => {
        await rendererReady;
        while (true) {
          await check();
          const snapshot = await this.bounded(localSnapshotForHost(page, turn.token, controller.signal),
            this.commandTimeoutMs, 'Local PCM renderer clock timed out', controller.signal);
          await check();
          if (snapshot.error) throw Error('Local PCM renderer failed');
          if (liveText) { const live = liveText(); snapshot.text = live.text; snapshot.textComplete = live.complete === true; }
          if (getFace) {
            const face = await abortable(Promise.resolve().then(() => getFace(snapshot)), controller.signal);
            await check();
            if (face !== undefined && face !== null) snapshot.face = ownedFaceCopy(face, faceCopies);
          }
          const control = await abortable(Promise.resolve().then(() => onFrame(snapshot)), controller.signal);
          await check(); final = snapshot;
          if (snapshot.ended) {
            if (!snapshot.sourceComplete || snapshot.receivedFrames !== frames) throw Error('Local PCM ended before its producer');
            return;
          }
          // One line per reply of what was asked for and what the renderer's graph really applied (Voice volume diagnosis).
          if (this.levelLog && !levelLogged && sentMakeup !== undefined && snapshot.level) {
            levelLogged = true;
            try { this.levelLog(`[VoiceVolume] ${this.label}: asked ${sentMakeup.toFixed(2)} dB, renderer has ${snapshot.level.makeupDb.toFixed(2)} dB, gain ${snapshot.level.gain.toFixed(3)}, limiter ${snapshot.level.limiter ? (snapshot.level.limited ? 'in the path' : 'idle') : 'MISSING'}`); } catch { /* a log never affects speech */ }
          }
          if (control !== undefined) {
            if (control.allow === true) sentMakeup = control.makeupDb ?? 0;
            const admitted = await evaluate(({token, control}) => window.localPcm.control(token, control),
              {token: turn.token, control});
            await check();
            // A renderer can finish while onFrame writes native state. Its
            // declined late control is an owned drain, never a new admission;
            // immediately publish the fresh ended clock/face snapshot.
            if (admitted === false) continue;
            if (admitted !== true) throw Error('Invalid local PCM control acknowledgement');
          }
          await abortable(new Promise(resolve => {
            const timer = setTimeout(resolve, this.pollMs);
            const early = () => { clearTimeout(timer); resolve(); };
            // No audio yet: the first accepted packet polls at once (also when it was accepted after this snapshot was taken).
            if (firstAcceptedMs === null) firstAudio = early;
            else if (!(snapshot.receivedFrames > 0) && !audioRepolled) { audioRepolled = true; early(); }
            // The lease file was just replaced: poll at once instead of finishing the sleep.
            wake?.()?.then(early, () => {});
          }), controller.signal).finally(() => { firstAudio = null; });
        }
      })();
      producerTask = (async () => {
        await check();
        result = await producer(emit, {signal: controller.signal});
        // A cancelled or failed renderer startup reports itself before any
        // judgement of the producer's output.
        await rendererReady;
        await check();
        if (!frames || emitting) throw Error('Local PCM producer did not finish its owned copies');
        await evaluate(value => window.localPcm.seal(value), {token: turn.token, totalFrames: frames});
        await check();
      })();
      await abortable(Promise.all([producerTask, pump]), controller.signal);
      await check();
      succeeded = true;
      return {...result, streamed: true, engine: 'pocket-tts', voiceProvider: 'pocket',
        sampleRate: 24000, channels: 1, frames, duration: frames / 24000,
        snapshot: final, timing: {...result?.timing, localPcmRendererReadyMs: rendererReadyMs,
          localPcmFirstAcceptedMs: firstAcceptedMs, localPcmDeviceDrainMs: this.now() - started}};
    } finally {
      controller.abort(); clearTimeout(deadline); signal?.removeEventListener('abort', cancel);
      void producerTask?.catch(() => {}); void pump?.catch(() => {});
      // Let an aborted startup settle so its page is either known here or
      // already handed to the late-page disposal above.
      await rendererReady?.catch(() => {});
      let retired = false;
      if (page && !page.isClosed?.()) {
        try {
          await this.bounded(Promise.resolve().then(() => page.evaluate(token => window.localPcm.stop(token), turn.token)),
            this.cleanupTimeoutMs, 'Local PCM renderer retirement timed out');
          retired = true;
        } catch { /* Discard a renderer that cannot confirm its stop. */ }
      }
      try {
        if (!succeeded || !retired || this.epoch !== epoch) {
          if (this.page === page) this.page = null;
          await this.dispose(page);
        }
      } finally { if (this.active === turn) this.active = null; }
    }
  }

  // Opens the renderer page ahead of the first turn (the browser, the page and its audio worklet take about a second). Never
  // interrupts a turn and never throws: a page that cannot open is simply opened again by the turn that needs it.
  async warm() {
    if (this.active || this.closing || this.failure) return false;
    if (this.page && !this.page.isClosed?.()) return true;
    const epoch = this.epoch;
    this.warming ??= (async () => {
      try {
        const page = await this.bounded(Promise.resolve().then(() => this.createPage()), this.commandTimeoutMs * 4, 'Local PCM page warm-up timed out');
        if (this.epoch !== epoch || this.closing || (this.page && !this.page.isClosed?.())) { await this.dispose(page).catch(() => {}); return false; }
        this.page = page; return true;
      } catch { return false; } finally { this.warming = null; }
    })();
    return this.warming;
  }

  // Opens the renderer page if needed and a silent output device on it (LocalPcmClient.standby), so the next turn's renderer is ready
  // the moment its voice is asked for. Called when a turn that will use this voice starts, while the model is still thinking. Never
  // interrupts a turn (a turn that owns the page has its own device) and never throws.
  async standby() {
    if (this.active || this.closing || this.failure) return false;
    if (!await this.warm()) return false;
    const page = this.page;
    if (!page || page.isClosed?.() || this.active || this.closing) return false;
    try {
      return await this.bounded(Promise.resolve().then(() => page.evaluate(() => window.localPcm.standby?.() ?? false)),
        this.commandTimeoutMs, 'Local PCM standby timed out') === true;
    } catch { return false; }
  }

  close() {
    if (this.closing) return this.closing;
    this.epoch++; const turn = this.active, page = this.page || turn?.page;
    turn?.controller.abort(cancelled('Local PCM host closed')); this.page = null;
    this.closing = this.dispose(page).finally(() => { this.closing = null; });
    return this.closing;
  }
}
