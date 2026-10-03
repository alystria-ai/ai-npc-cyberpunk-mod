// Pocket has a shared CPU student and a real incremental decoder. It submits
// the complete reply once and never enters Omni's text/phrase WAV queue.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {absoluteRuntimeOverride} from './runtime-paths.mjs';
import {createVoiceProfileRegistry} from './voice-profile-registry.mjs';
import {abortable, cancelled, throwIfCancelled} from './transport-pool.mjs';

export const POCKET_SOURCE_REVISION = '41cbc84af539ea78a804ffca5f9c6edc1a22ce44';
export const POCKET_SOURCE_SHA256 = 'b86f98955b6c4776bb24a748b321408aba89d3b66f6b911f415ef4f4191a7666';
export const POCKET_LIMITS = Object.freeze({startupMs: 180_000, prepareMs: 60_000,
  renderMs: 120_000, sinkMs: 10_000, cancelMs: 2000, exitMs: 5000, maxFrames: 24000 * 120});
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const modelFields = ['sha256', 'configSha256', 'tokenizerSha256', 'receiptSha256', 'inputIdentity'];
const pathFields = ['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'];
const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

export function validatePocketConfig(config) {
  if (!object(config) || config.version !== 1 || config.engine !== 'pocket-tts' || config.provider !== 'pocket')
    throw Error('Expected a Pocket student runtime configuration');
  if (!object(config.model) || modelFields.some(key => !hash(config.model[key]))
      || !Number.isSafeInteger(config.model.selectedStep) || config.model.selectedStep < 1)
    throw Error('Pocket requires an explicitly selected and hashed student export');
  if (!object(config.runtime)) throw Error('Pocket requires explicit local runtime paths');
  const runtime = Object.fromEntries(pathFields.map(key => {
    const value = absoluteRuntimeOverride(config.runtime[key], `Pocket ${key}`);
    if (value === undefined) throw Error('Pocket requires every local runtime path');
    return [key, value];
  }));
  const threads = config.cpu?.threads ?? 2, temperature = config.sampling?.temperature ?? .3;
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 4) throw Error('Invalid Pocket CPU thread count');
  if (!finite(temperature) || temperature < .1 || temperature > 1 || (config.sampling?.decodeSteps ?? 1) !== 1)
    throw Error('Pocket student requires one sampler step and a valid temperature');
  // Reuse the established acoustic descriptor validator only. Its registry
  // contains no engine state/provider IDs, and does not select an Omni route.
  const registry = createVoiceProfileRegistry({version: 2, provider: 'hybrid', engine: 'omnivoice',
    voices: config.voices, preparation: {mode: 'lazy', startupProfiles: config.preparation?.startupProfiles ?? [],
      maxCachedProfiles: config.preparation?.maxCachedProfiles ?? 8}});
  return Object.freeze({version: 1, engine: 'pocket-tts', provider: 'pocket',
    runtime: Object.freeze(runtime), model: Object.freeze(Object.fromEntries([...modelFields, 'selectedStep'].map(key => [key, config.model[key]]))),
    cpu: Object.freeze({threads}), sampling: Object.freeze({temperature, decodeSteps: 1}),
    voices: registry.profiles, registry, preparation: registry.preparation});
}

export class PocketVoice {
  constructor(config, {project, configPath, pythonExecutable, spawnImpl = spawn,
    onState = () => {}, onLog = () => {}, now = () => performance.now(),
    setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
    this.config = validatePocketConfig(config); this.registry = this.config.registry;
    this.project = absoluteRuntimeOverride(project, 'Pocket application directory');
    this.configPath = absoluteRuntimeOverride(configPath, 'Pocket configuration path');
    this.pythonExecutable = absoluteRuntimeOverride(pythonExecutable, 'Pocket Python executable');
    if (!this.project || !this.configPath || !this.pythonExecutable) throw Error('Pocket runtime paths cannot fall back to a development environment');
    Object.assign(this, {spawnImpl, onState, onLog, now, setTimer, clearTimer});
    this.owner = randomUUID().replaceAll('-', ''); this.sequence = 0;
    this.pending = new Map(); this.available = new Set(this.registry.keys); this.prepared = new Set();
    this.tail = Promise.resolve(); this.receiving = Promise.resolve(); this.state = 'stopped'; this.loaded = false;
  }
  get enabled() { return this.registry.keys.length > 0 && !this.closing; }
  get profileKeys() { return this.registry.keys.filter(key => this.available.has(key)); }
  hasProfile(key) { return this.registry.has(key) && this.available.has(key); }
  usesProfile(key) { return this.enabled && this.hasProfile(key); }
  profileReady(key) { return this.loaded && !this.failure && !this.closing && this.hasProfile(key) && this.prepared.has(key); }
  publish(state, extra = {}) {
    this.state = state;
    try { Promise.resolve(this.onState({version: 1, state, engine: 'pocket-tts', provider: 'pocket',
      device: 'cpu', dtype: 'torch.float32', threads: this.config.cpu.threads, gpuVramBytes: 0,
      resident: this.loaded, bridgePid: process.pid, workerPid: this.child?.pid,
      profiles: this.profileKeys, preparedProfiles: [...this.prepared],
      modelSha256: this.config.model.sha256, inputIdentity: this.config.model.inputIdentity,
      updated: Date.now(), ...extra})).catch(() => {}); } catch {}
  }
  timer(task, ms) { const handle = this.setTimer(task, ms); handle?.unref?.(); return handle; }
  send(value) {
    if (!this.child || this.child.stdin.writableEnded) throw Error('Pocket worker input is closed');
    this.child.stdin.write(JSON.stringify({owner: this.owner, ...value}) + '\n', error => { if (error) this.fail(error); });
  }
  start() {
    if (this.closing) return Promise.reject(cancelled('Pocket speech is stopping'));
    if (this.failure) return Promise.reject(this.failure);
    if (!this.enabled) { this.publish('disabled'); return Promise.resolve(); }
    if (this.ready) return this.ready;
    this.publish('loading');
    this.ready = new Promise((resolveReady, rejectReady) => Object.assign(this, {resolveReady, rejectReady}));
    this.ready.catch(() => {});
    let child;
    try {
      const env = {...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', CUDA_VISIBLE_DEVICES: '-1',
        HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
        TOKENIZERS_PARALLELISM: 'false', OMP_NUM_THREADS: String(this.config.cpu.threads),
        MKL_NUM_THREADS: String(this.config.cpu.threads), OPENBLAS_NUM_THREADS: String(this.config.cpu.threads)};
      for (const key of ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'KAGGLE_API_TOKEN']) delete env[key];
      child = this.child = this.spawnImpl(this.pythonExecutable,
        ['-B', resolve(this.project, 'bridge/pocket-voice-worker.py'), '--config', this.configPath, '--owner', this.owner],
        {cwd: this.project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env});
    } catch (error) { this.fail(error); return this.ready; }
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', part => {
      buffer += part;
      if (buffer.length > 2_000_000) { this.fail(Error('Pocket worker response is oversized')); return; }
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        this.receiving = this.receiving.then(() => {
          if (this.failure) return;
          return this.receive(JSON.parse(line));
        }).catch(error => this.fail(error));
      }
    });
    child.stderr.on('data', part => { try { this.onLog(part.toString('utf8').slice(0, 4000)); } catch {} });
    child.stdin.on('error', error => this.fail(error)); child.on('error', error => this.fail(error));
    this.exited = new Promise((done, reject) => {
      this.rejectExited = reject;
      child.once('close', code => {
        this.clearTimer(this.startTimer); this.clearTimer(this.exitTimer); this.clearTimer(this.confirmTimer);
        this.startTimer = this.exitTimer = this.confirmTimer = null;
        this.child = null; this.loaded = false; this.prepared.clear();
        const error = this.failure || (this.closing ? cancelled('Pocket speech stopped') : Error(`Pocket worker exited (${code})`));
        this.rejectReady?.(error);
        for (const request of this.pending.values()) this.finishRequest(request, error);
        if (!this.closing) this.failure ||= error;
        this.publish(this.closing ? 'stopped' : 'error'); done();
      });
    });
    this.exited.catch(() => {});
    this.startTimer = this.timer(() => this.fail(Error('Pocket student startup timed out')), POCKET_LIMITS.startupMs);
    return this.ready;
  }
  validateProfiles(frame) {
    const profiles = frame.profiles, prepared = frame.preparedProfiles;
    const valid = (value, maximum) => Array.isArray(value) && value.length <= maximum && new Set(value).size === value.length
      && value.every(key => this.registry.has(key));
    if (!valid(profiles, this.registry.keys.length) || !valid(prepared, this.config.preparation.maxCachedProfiles)
        || prepared.some(key => !profiles.includes(key))) throw Error('Invalid Pocket acoustic profile readiness');
    this.available = new Set(profiles); this.prepared = new Set(prepared);
  }
  async receive(frame) {
    if (!object(frame) || frame.owner !== this.owner) throw Error('Pocket response owner changed');
    if (frame.op === 'fatal') throw Error('Pocket student runtime is unavailable');
    if (frame.op === 'state') {
      if (!['loading', 'warming'].includes(frame.state) || (frame.profile !== undefined && !this.registry.has(frame.profile)))
        throw Error('Invalid Pocket worker state');
      if (frame.phase !== undefined && !['assets-verified','importing-dependencies','loading-student','student-loaded'].includes(frame.phase))
        throw Error('Invalid Pocket startup phase');
      if (!this.closing) this.publish(frame.state, {profile: frame.profile, phase:frame.phase}); return;
    }
    if (frame.op === 'ready') {
      if (this.loaded || this.pending.size || frame.protocolVersion !== 1 || frame.engine !== 'pocket-tts'
          || frame.device !== 'cpu' || frame.dtype !== 'torch.float32' || frame.runtime !== 'pytorch'
          || frame.layers !== 6 || frame.decodeSteps !== 1 || frame.sampleCfg !== 1 || frame.gpuVramBytes !== 0
          || frame.threads !== this.config.cpu.threads || frame.sourceRevision !== POCKET_SOURCE_REVISION
          || frame.sourceSha256 !== POCKET_SOURCE_SHA256 || !object(frame.model)
          || [...modelFields, 'selectedStep'].some(key => frame.model[key] !== this.config.model[key])
          || !object(frame.workerPaths) || pathFields.some(key => typeof frame.workerPaths[key] !== 'string'
            || !samePath(frame.workerPaths[key], this.config.runtime[key]))) throw Error('Pocket worker did not attest the selected CPU student');
      this.validateProfiles(frame);
      if (!object(frame.referenceHashes) || Object.keys(frame.referenceHashes).length !== this.available.size
          || [...this.available].some(key => frame.referenceHashes[key] !== this.registry.profiles[key].sha256)
          || this.config.preparation.startupProfiles.some(key => this.available.has(key) && !this.prepared.has(key)))
        throw Error('Pocket worker did not confirm the configured reference identities');
      this.clearTimer(this.startTimer); this.startTimer = null;
      if (this.closing) { this.confirmExit(); return; }
      this.loaded = true; this.publish('ready'); this.resolveReady(); return;
    }
    const request = this.pending.get(frame.id);
    if (!request || !['prepared', 'pcm', 'done', 'cancelled', 'error'].includes(frame.op) || frame.profile !== request.profile)
      throw Error('Unexpected Pocket speech response');
    if (frame.op === 'pcm') {
      if (request.kind !== 'stream' || frame.index !== request.chunks + 1 || frame.offsetFrames !== request.frames
          || !Number.isSafeInteger(frame.frames) || frame.frames < 1 || frame.frames > 24000 * 4
          || frame.sampleRate !== 24000 || frame.channels !== 1 || frame.format !== 'f32le'
          || !finite(frame.yieldMs) || frame.yieldMs < 0 || !finite(frame.copiedReadyMs)
          || frame.copiedReadyMs < frame.yieldMs || frame.copiedReadyMs < request.lastReadyMs
          || request.frames + frame.frames > POCKET_LIMITS.maxFrames || typeof frame.pcm !== 'string'
          || frame.pcm.length > 512_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.pcm))
        throw Error('Pocket PCM is malformed, out of order or outside its limit');
      const bytes = Buffer.from(frame.pcm, 'base64');
      if (bytes.length !== frame.frames * 4) throw Error('Pocket PCM byte count changed');
      const pcm = new Float32Array(frame.frames);
      for (let at = 0; at < pcm.length; at++) {
        pcm[at] = bytes.readFloatLE(at * 4);
        if (!Number.isFinite(pcm[at])) throw Error('Pocket PCM contains non-finite samples');
      }
      request.frames += frame.frames; request.chunks++; request.lastReadyMs = frame.copiedReadyMs;
      request.firstYieldMs ??= frame.yieldMs; request.firstReadyMs ??= frame.copiedReadyMs;
      request.firstReceivedMs ??= this.now() - request.started;
      if (request.cancelReason) return;
      const packet = {version: 1, engine: 'pocket-tts', profile: request.profile, owner: this.owner,
        id: request.id, index: frame.index, sampleRate: 24000, channels: 1, pcm, format: 'f32le',
        offsetFrames: frame.offsetFrames, frames: frame.frames, timebase: 'audio-seconds',
        startSeconds: frame.offsetFrames / 24000, modelSha256: this.config.model.sha256,
        timing: {voicePcmYieldMs: frame.yieldMs, voicePcmCopiedReadyMs: frame.copiedReadyMs,
          voicePcmReceivedMs: this.now() - request.started}};
      let sinkTimer;
      try {
        const deadline = new Promise((resolveSink, reject) => {
          sinkTimer = this.timer(() => reject(Error('Pocket PCM consumer timed out')), POCKET_LIMITS.sinkMs);
        });
        await abortable(Promise.race([Promise.resolve().then(() => request.onPcm(packet)), deadline]), request.controller.signal);
        if (!request.cancelReason && !this.failure && !this.closing) this.send({op: 'ack', id: request.id, index: frame.index});
      } catch (error) { this.cancelRequest(request, error); }
      finally { this.clearTimer(sinkTimer); }
      return;
    }
    this.validateProfiles(frame);
    if (frame.op === 'error') {
      if (frame.terminal !== undefined && typeof frame.terminal !== 'boolean') throw Error('Invalid Pocket failure lifetime');
      if (frame.terminal) this.fail(Error('Pocket generation stopped; restart the local voice service'));
      else this.finishRequest(request, Error('Pocket voice could not prepare this reply'));
      return;
    }
    if (frame.op === 'cancelled' || request.cancelReason) {
      this.finishRequest(request, request.cancelReason || cancelled('Pocket speech cancelled')); return;
    }
    if (frame.op === 'prepared') {
      if (request.kind !== 'prepare' || !this.prepared.has(request.profile) || !finite(frame.preparationMs) || frame.preparationMs < 0)
        throw Error('Invalid Pocket reference preparation');
      this.finishRequest(request, null, {provider: 'pocket', ready: this.profileReady(request.profile), profile: request.profile}); return;
    }
    if (request.kind !== 'stream' || frame.frames !== request.frames || frame.chunks !== request.chunks || request.frames < 1
        || frame.sampleRate !== 24000 || frame.channels !== 1 || !this.prepared.has(request.profile)
        || frame.firstPcmYieldMs !== request.firstYieldMs || frame.firstPcmCopiedReadyMs !== request.firstReadyMs
        || !finite(frame.preparationMs) || frame.preparationMs < 0 || !finite(frame.generationMs) || frame.generationMs < request.lastReadyMs)
      throw Error('Pocket completion does not match its streamed PCM');
    this.finishRequest(request, null, {provider: 'pocket', engine: 'pocket-tts', sampleRate: 24000, channels: 1,
      frames: request.frames, chunks: request.chunks, duration: request.frames / 24000,
      modelSha256: this.config.model.sha256, timing: {voiceProvider: 'pocket', voiceEngine: 'pocket-tts',
        voiceWarm: true, voiceDtype: 'torch.float32', voiceRuntime: 'pytorch', voiceDevice: 'cpu',
        voiceQueueMs: request.started - request.queued, voicePreparationMs: frame.preparationMs,
        voiceFirstPcmYieldMs: frame.firstPcmYieldMs, voiceFirstPcmCopiedReadyMs: frame.firstPcmCopiedReadyMs,
        voiceFirstPcmReceivedMs: request.firstReceivedMs, voiceGenerationMs: frame.generationMs,
        voiceRoundTripMs: this.now() - request.started}});
  }
  command(kind, profile, {signal, onPcm, text, queued = this.now()} = {}) {
    throwIfCancelled(signal);
    if (this.closing || this.failure) return Promise.reject(this.failure || cancelled());
    const id = ++this.sequence, started = this.now();
    return new Promise((resolveFrame, reject) => {
      const request = {id, kind, profile, onPcm, queued, started, frames: 0, chunks: 0, lastReadyMs: 0,
        controller: new AbortController(), resolve: resolveFrame, reject};
      this.pending.set(id, request);
      request.cancel = () => this.cancelRequest(request, cancelled());
      request.signal = signal; signal?.addEventListener('abort', request.cancel, {once: true});
      request.timer = this.timer(() => this.cancelRequest(request, Error('Pocket speech timed out')),
        kind === 'prepare' ? POCKET_LIMITS.prepareMs : POCKET_LIMITS.renderMs);
      this.publish(kind === 'prepare' ? 'warming' : 'speaking', {profile});
      try { this.send({op: kind, id, profile, ...(text !== undefined ? {text} : {})}); }
      catch (error) { this.fail(error); }
      if (signal?.aborted) request.cancel();
    });
  }
  cancelRequest(request, reason) {
    if (!this.pending.has(request.id) || request.cancelReason) return;
    request.cancelReason = reason; request.controller.abort(reason);
    try { this.send({op: 'cancel', id: request.id}); } catch (error) { this.fail(error); }
    request.cancelTimer = this.timer(() => this.fail(Error('Pocket worker did not stop its cancelled request')), POCKET_LIMITS.cancelMs);
  }
  finishRequest(request, error, result) {
    if (!this.pending.delete(request.id)) return;
    this.clearTimer(request.timer); this.clearTimer(request.cancelTimer);
    request.signal?.removeEventListener('abort', request.cancel);
    request.controller.abort(error || cancelled('Pocket request completed'));
    if (!this.closing && !this.failure) this.publish('ready');
    if (error) request.reject(error); else request.resolve(result);
  }
  async ensurePrepared(profile, signal) {
    throwIfCancelled(signal); await abortable(this.start(), signal); throwIfCancelled(signal);
    if (this.closing || this.failure) throw this.failure || cancelled();
    if (!this.hasProfile(profile)) throw Error('This character has no available Pocket voice');
    // The worker revalidates the exact source file before a cache hit as well.
    await this.command('prepare', profile, {signal}); throwIfCancelled(signal);
  }
  prepareProfile(profile, {signal} = {}) {
    if (!this.usesProfile(profile)) return Promise.resolve({provider: 'convai', ready: true,
      reason: this.registry.has(profile) ? 'unavailable' : this.registry.status(profile)});
    const operation = this.tail.then(async () => { await this.ensurePrepared(profile, signal);
      return {provider: 'pocket', ready: this.profileReady(profile), profile}; });
    this.tail = operation.catch(() => {}); return abortable(operation, signal);
  }
  synthesizeStream(profile, text, {signal, onPcm} = {}) {
    if (!this.usesProfile(profile)) return Promise.reject(Error('This character has no available Pocket voice'));
    if (typeof text !== 'string' || !text.trim() || text.length > 12_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
        || typeof onPcm !== 'function') return Promise.reject(Error('Pocket streaming requires valid reply text and a PCM consumer'));
    const queued = this.now();
    const operation = this.tail.then(async () => {
      await this.ensurePrepared(profile, signal); throwIfCancelled(signal);
      return this.command('stream', profile, {text, signal, onPcm, queued});
    });
    this.tail = operation.catch(() => {}); return abortable(operation, signal);
  }
  confirmExit() {
    if (!this.child || this.exitTimer || this.confirmTimer) return;
    const child = this.child;
    this.exitTimer = this.timer(() => {
      this.exitTimer = null; if (this.child !== child) return;
      try { child.kill(); } catch {}
      this.confirmTimer = this.timer(() => {
        this.confirmTimer = null; if (this.child !== child) return;
        const error = Error('Pocket worker exit could not be confirmed'); this.failure ||= error;
        this.publish('error'); this.rejectExited?.(error);
      }, POCKET_LIMITS.exitMs);
    }, POCKET_LIMITS.cancelMs);
  }
  fail(error) {
    this.failure ||= error; this.clearTimer(this.startTimer); this.startTimer = null;
    this.rejectReady?.(this.failure);
    for (const request of this.pending.values()) this.finishRequest(request, this.failure);
    this.publish('error');
    if (this.child && !this.child.stdin.writableEnded) this.child.stdin.end();
    this.confirmExit();
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve(); this.rejectReady?.(cancelled('Pocket speech stopped'));
    for (const request of this.pending.values()) this.finishRequest(request, cancelled('Pocket speech stopped'));
    if (!this.child) { this.loaded = false; this.publish('stopped'); return this.closing; }
    this.publish('stopping'); this.child.stdin.end(); this.confirmExit();
    this.closing = this.exited; return this.closing;
  }
}
