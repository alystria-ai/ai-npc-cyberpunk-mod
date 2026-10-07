import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {inspectWav} from './speech-audio.mjs';
import {abortable, throwIfCancelled, cancelled} from './transport-pool.mjs';
import {createVoiceProfileRegistry, LEGACY_LOCAL_VOICE_KEYS} from './voice-profile-registry.mjs';
import {absoluteRuntimeOverride, OMNI_RUNTIME_PATHS, omniRuntimeOverrides} from './runtime-paths.mjs';

// Historical accepted-reference fixture/packaging list. Eligibility is always
// read from the validated registry, never from this compatibility export.
export const LOCAL_VOICE_KEYS = LEGACY_LOCAL_VOICE_KEYS;
export const voiceSteps = value => value === 16 ? 16 : 32;
export const VOICE_WORKER_LIMITS = Object.freeze({startupMs: 180_000, renderMs: 120_000,
  exitGraceMs: 10_000, exitConfirmationMs: 5_000});

export class ResidentVoice {
  constructor(config = {}, {project, configPath, spawnImpl = spawn, onState = () => {}, onLog = () => {},
    setTimer = setTimeout, clearTimer = clearTimeout,
    pythonExecutable = process.env.CYBERPUNK_CONVAI_PYTHON,
    modelDirectory = process.env.CYBERPUNK_CONVAI_OMNI_MODEL,
    adapterDirectory = process.env.CYBERPUNK_CONVAI_OMNI_ADAPTER,
    referenceDirectory = process.env.CYBERPUNK_CONVAI_OMNI_REFERENCES,
    cacheDirectory = process.env.CYBERPUNK_CONVAI_OMNI_CACHE} = {}) {
    this.pythonExecutable = absoluteRuntimeOverride(pythonExecutable, 'CYBERPUNK_CONVAI_PYTHON');
    this.workerEnvironment = omniRuntimeOverrides({modelDirectory, adapterDirectory, referenceDirectory, cacheDirectory});
    this.registry = createVoiceProfileRegistry(config);
    Object.assign(this, {config: Object.freeze({...config, voices: this.registry.profiles,
      preparation: this.registry.preparation}), project, configPath, spawnImpl, onState, onLog, setTimer, clearTimer});
    this.steps = voiceSteps(config.steps); this.tail = Promise.resolve();
    this.sequence = 0; this.pending = new Map(); this.state = this.enabled ? 'stopped' : 'disabled';
    this.loaded = false; this.details = {};
    this.prepared = new Set(); this.available = new Set(this.registry.keys);
    // "Keep prepared voices": the hidden warm-up render made while a companion joins uses the selected steps.
    this.keepPrepared = false;
  }
  setKeepPrepared(value) { this.keepPrepared = value === true; }
  schedule(callback, delay) {
    const timer = this.setTimer(callback, delay); timer?.unref?.(); return timer;
  }
  clearPhase() { this.clearTimer(this.phaseTimer); this.phaseTimer = null; }
  phaseDeadline(label, delay) {
    this.clearPhase();
    this.phaseTimer = this.schedule(() => {
      this.phaseTimer = null;
      this.fail(Error(`Local voice ${label} timed out`));
    }, delay);
  }
  awaitExit() {
    if (!this.child || this.exitTimer || this.exitConfirmation) return;
    const child = this.child;
    this.exitTimer = this.schedule(() => {
      this.exitTimer = null;
      if (this.child !== child) return;
      // A hung owned worker must not retain CUDA forever. No process-pattern
      // termination: this handle belongs only to the child we spawned.
      try { child.kill(); } catch { /* Exit confirmation below remains required. */ }
      if (this.child !== child) return;
      this.exitConfirmation = this.schedule(() => {
        this.exitConfirmation = null;
        if (this.child !== child) return;
        const error = Error('Local voice worker exit could not be confirmed');
        this.failure = error;
        this.publish('error', {detail: 'Local voice worker did not exit. Restart the voice service before retrying.'});
        this.rejectExited?.(error);
      }, VOICE_WORKER_LIMITS.exitConfirmationMs);
    }, VOICE_WORKER_LIMITS.exitGraceMs);
  }
  get enabled() { return this.config.provider === 'hybrid' && this.registry.keys.length > 0; }
  get profileKeys() { return this.registry.keys.filter(key => this.available.has(key)); }
  hasProfile(key) { return this.registry.has(key) && this.available.has(key); }
  usesProfile(key) { return this.enabled && this.hasProfile(key); }
  profileReady(key) { return this.loaded && this.hasProfile(key) && this.prepared.has(key); }
  setSteps(value) {
    const next = voiceSteps(value), changed = next !== this.steps;
    this.steps = next;
    if (changed) this.publish(this.state);
    return changed;
  }
  publish(state, extra = {}) {
    this.state = state;
    try {
      Promise.resolve(this.onState({version: 1, state, steps: this.steps, engine: 'omnivoice',
        provider: this.enabled ? 'hybrid' : 'convai', bridgePid: process.pid, workerPid: this.child?.pid,
        profiles: this.enabled ? this.profileKeys : [], preparedProfiles: [...this.prepared], resident: this.loaded,
        updated: Date.now(), ...this.details, ...extra})).catch(() => {});
    } catch { /* Diagnostic writes must not interrupt GPU work. */ }
  }
  start() {
    if (!this.enabled) { this.publish('disabled'); return Promise.resolve(); }
    if (this.closing) return Promise.reject(cancelled('Local speech is stopping'));
    if (this.ready) return this.ready;
    this.publish('loading');
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady; this.rejectReady = rejectReady;
    });
    // Always observe startup failure even when no conversation is waiting.
    this.ready.catch(() => {});
    let child;
    try {
      const environment = {...process.env, PYTHONUTF8: '1'};
      // Use the values captured with this owner, even if the parent environment
      // changes before warm-up. An absent layout keeps the development defaults.
      for (const name of Object.values(OMNI_RUNTIME_PATHS)) delete environment[name];
      Object.assign(environment, this.workerEnvironment);
      if (this.workerEnvironment) environment.PYTHONDONTWRITEBYTECODE = '1';
      child = this.child = this.spawnImpl(this.pythonExecutable
        || resolve(this.project, 'vendor/reference-voicestudio/.venv/Scripts/python.exe'),
        [resolve(this.project, 'bridge/resident-voice-worker.py'), '--config', this.configPath],
        {cwd: this.project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: environment});
    } catch (error) { this.fail(error); return this.ready; }
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', part => {
      buffer += part;
      if (buffer.length > 32_000_000) { this.fail(Error('Oversized local voice response')); child.stdin.end(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { this.receive(JSON.parse(line)); }
        catch (error) { this.fail(error); child.stdin.end(); return; }
      }
    });
    child.stderr.on('data', part => { try { this.onLog(part.toString('utf8')); } catch {} });
    child.stdin.on('error', error => this.fail(error));
    child.on('error', error => this.fail(error));
    this.exited = new Promise((done, reject) => {
      this.rejectExited = reject;
      child.once('close', code => {
        this.clearPhase(); this.clearTimer(this.exitTimer); this.clearTimer(this.exitConfirmation);
        this.exitTimer = this.exitConfirmation = null;
        this.child = null; this.loaded = false; this.prepared.clear();
        this.details = {...this.details, cudaAllocatedMiB: 0, cudaReservedMiB: 0};
        const error = this.failure || (this.closing ? cancelled('Local speech stopped') : Error(`Local voice worker exited (${code})`));
        this.rejectReady?.(error);
        for (const item of this.pending.values()) item.reject(error);
        this.pending.clear();
        if (!this.closing) this.fail(error); else this.publish('stopped');
        done();
      });
    });
    this.exited.catch(() => {});
    this.phaseDeadline('startup', VOICE_WORKER_LIMITS.startupMs);
    return this.ready;
  }
  receive(frame) {
    if (frame.op === 'state') {
      if (!['loading', 'warming'].includes(frame.state)
          || (frame.state === 'warming' && !this.registry.has(frame.profile))) throw Error('Invalid local voice state');
      if (!this.closing) this.publish(frame.state, {profile: frame.profile});
      return;
    }
    if (frame.op === 'ready') {
      if (this.loaded || this.pending.size) throw Error('Unexpected local voice readiness');
      if (this.workerEnvironment) {
        const paths = frame.workerPaths;
        const expected = {applicationDirectory: resolve(this.project),
          ...Object.fromEntries(Object.entries(OMNI_RUNTIME_PATHS).map(([field, name]) => [field, this.workerEnvironment[name]]))};
        const normalized = value => {
          if (typeof value !== 'string') return null;
          absoluteRuntimeOverride(value, 'Local voice worker path');
          const path = resolve(value);
          return process.platform === 'win32' ? path.toLowerCase() : path;
        };
        if (!paths || typeof paths !== 'object' || Array.isArray(paths)
            || Object.keys(paths).length !== Object.keys(expected).length
            || Object.entries(expected).some(([field, path]) => normalized(paths[field]) !== normalized(path))) {
          throw Error('Local voice worker did not confirm its portable asset and data paths');
        }
      }
      const version = frame.protocolVersion ?? 1;
      const profiles = frame.profiles;
      const prepared = version === 1 ? profiles : frame.preparedProfiles;
      if (!frame.device?.startsWith('cuda') || frame.dtype !== 'torch.float16' || frame.runtime !== 'pytorch'
          || frame.tensorrt !== false || ![1, 2].includes(version) || (this.workerEnvironment && version !== 2)
          || !this.validProfiles(profiles) || !this.validProfiles(prepared, this.registry.preparation.maxCachedProfiles)
          || prepared.some(key => !profiles.includes(key))
          || (version === 2 && (!frame.referenceHashes || typeof frame.referenceHashes !== 'object'
            || Array.isArray(frame.referenceHashes) || Object.keys(frame.referenceHashes).length !== profiles.length
            || profiles.some(key => frame.referenceHashes[key] !== this.registry.profiles[key].sha256)))
          || (version === 2 && (!frame.transcriptHashes || typeof frame.transcriptHashes !== 'object'
            || Array.isArray(frame.transcriptHashes) || Object.keys(frame.transcriptHashes).length !== profiles.length
            || profiles.some(key => frame.transcriptHashes[key] !== createHash('sha256')
              .update(this.registry.profiles[key].transcript, 'utf8').digest('hex'))))
          || (version === 1 && (this.registry.preparation.mode !== 'eager'
            || profiles.length !== this.registry.keys.length))
          || (version === 2 && this.registry.preparation.startupProfiles.some(key => profiles.includes(key) && !prepared.includes(key)))) {
        throw Error('Local voice worker did not warm all profiles on CUDA');
      }
      this.protocolVersion = version; this.available = new Set(profiles); this.prepared = new Set(prepared);
      this.loaded = true;
      this.clearPhase();
      this.details = {device: frame.device, dtype: frame.dtype, runtime: frame.runtime,
        tensorrt: frame.tensorrt, compiled: frame.compiled,
        acceleration: frame.acceleration || 'eager', cudaGraph: frame.cudaGraph,
        cudaAllocatedMiB: frame.cudaAllocatedMiB, cudaReservedMiB: frame.cudaReservedMiB,
        cudaPeakReservedMiB: frame.cudaPeakReservedMiB};
      if (!this.closing && !this.failure) this.publish('ready');
      this.resolveReady();
      if (this.closing || this.failure) this.awaitExit();
      return;
    }
    const request = this.pending.get(frame.id);
    // A timed-out physical render can finish while the worker drains EOF.
    // Its caller has already failed; the late WAV must never be published.
    if (!request && this.failure && ['audio', 'prepared', 'error'].includes(frame.op)) return;
    if (!request || !['audio', 'prepared', 'error'].includes(frame.op)
        || (frame.op !== 'error' && frame.op !== (request.kind === 'prepare' ? 'prepared' : 'audio'))) {
      throw Error('Unexpected local speech response');
    }
    if (frame.op !== 'error' && (frame.profile !== request.profile
        || (request.kind !== 'prepare' && frame.steps !== request.steps))) {
      this.pending.delete(frame.id); this.clearPhase();
      if (!this.closing) this.publish('ready');
      request.reject(Error('Local speech identity changed'));
      if (this.closing || this.failure) this.awaitExit();
      return;
    }
    if (this.protocolVersion === 2) {
      if (frame.op === 'error' && frame.preparedProfiles === undefined) {
        // A generic failure cannot attest which prompts survived. A later
        // Invite prepares again rather than trusting stale cache readiness.
        this.prepared.clear();
      } else {
        if (!this.validProfiles(frame.preparedProfiles, this.registry.preparation.maxCachedProfiles)
            || frame.preparedProfiles.some(key => !this.available.has(key))
            || (frame.op !== 'error' && !frame.preparedProfiles.includes(request.profile))) {
          throw Error('Invalid prepared local voice profiles');
        }
        this.prepared = new Set(frame.preparedProfiles);
      }
    }
    this.pending.delete(frame.id);
    this.clearPhase();
    for (const key of ['cudaAllocatedMiB', 'cudaReservedMiB', 'cudaPeakReservedMiB']) {
      if (Number.isFinite(frame[key])) this.details[key] = frame[key];
    }
    if (['eager', 'cuda-graph'].includes(frame.acceleration)) {
      this.details.acceleration = frame.acceleration;
      this.details.cudaGraph = frame.cudaGraph;
    }
    if (!this.closing) this.publish('ready');
    if (frame.op === 'error') request.reject(Error(request.kind === 'prepare'
      ? 'Local voice could not prepare this character' : 'Local voice could not generate this reply'));
    else request.resolve(frame);
    if (this.closing || this.failure) this.awaitExit();
  }
  validProfiles(value, maximum = this.registry.keys.length) {
    return Array.isArray(value) && value.length <= maximum && new Set(value).size === value.length
      && value.every(key => this.registry.has(key));
  }
  command(kind, profile, payload = {}) {
    const id = ++this.sequence;
    this.publish(kind === 'prepare' ? 'warming' : 'speaking', {profile});
    return new Promise((resolveFrame, reject) => {
      this.pending.set(id, {resolve: resolveFrame, reject, kind, profile, ...payload});
      this.phaseDeadline(kind === 'prepare' ? 'preparation' : 'generation', VOICE_WORKER_LIMITS.renderMs);
      this.child.stdin.write(JSON.stringify({op: kind === 'prepare' ? 'prepare' : 'synthesize', id, profile, ...payload}) + '\n', error => {
        if (error) this.fail(error);
      });
    });
  }
  async ensurePrepared(profile, signal) {
    throwIfCancelled(signal);
    if (this.closing || this.failure) throw this.failure || cancelled();
    await this.start();
    throwIfCancelled(signal);
    if (this.closing || this.failure) throw this.failure || cancelled();
    if (!this.hasProfile(profile)) throw Error('This character uses its Convai voice');
    if (!this.prepared.has(profile)) {
      if (this.protocolVersion !== 2) throw Error('Local voice worker cannot prepare this character');
      await this.command('prepare', profile, this.keepPrepared ? {steps: this.steps} : {});
      throwIfCancelled(signal);
      if (this.closing || this.failure) throw this.failure || cancelled();
    }
  }
  prepareProfile(profile, {signal} = {}) {
    if (!this.usesProfile(profile)) return Promise.resolve({provider: 'convai', ready: true,
      reason: this.registry.has(profile) ? 'unavailable' : this.registry.status(profile)});
    const operation = this.tail.then(async () => {
      await this.ensurePrepared(profile, signal);
      return {provider: 'omnivoice', ready: this.profileReady(profile), profile};
    });
    this.tail = operation.catch(() => {});
    return abortable(operation, signal);
  }
  fail(error) {
    this.failure ||= error;
    this.clearPhase();
    this.rejectReady?.(error);
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
    if (!this.closing) this.publish('error', {detail: 'Local voices are unavailable. Restart the conversation bridge.'});
    // EOF lets a running generation finish before releasing CUDA, including
    // when a malformed response has made this worker unusable.
    if (this.child && !this.child.stdin.writableEnded) this.child.stdin.end();
    this.awaitExit();
  }
  // `language`: the reply's ISO 639-1 code when it is not English (Multilingual conversations). OmniVoice clones
  // the English reference into that language. Absent or 'en' sends nothing, so English requests are unchanged.
  synthesize(profile, text, {signal, steps: chosenSteps, language} = {}) {
    if (!this.usesProfile(profile)) return Promise.reject(Error('This character uses its Convai voice'));
    if (typeof text !== 'string' || !text.trim() || text.length > 12_000) return Promise.reject(Error('Invalid speech text'));
    if (chosenSteps !== undefined && ![16, 32].includes(chosenSteps)) return Promise.reject(Error('Invalid voice quality'));
    if (language !== undefined && language !== null && !/^[a-z]{2,3}$/.test(language)) return Promise.reject(Error('Invalid speech language'));
    const languageField = language && language !== 'en' ? {language} : {};
    const steps = chosenSteps ?? this.steps, queued = performance.now();
    const operation = this.tail.then(async () => {
      await this.ensurePrepared(profile, signal);
      const started = performance.now();
      const frame = await this.command('synthesize', profile, {text, steps, ...languageField});
      throwIfCancelled(signal);
      if (this.closing || this.failure) throw this.failure || cancelled();
      const bytes = Buffer.from(frame.audio, 'base64'), wav = inspectWav(bytes);
      return {audio: bytes.toString('base64'), wav, faces: [], captions: [], timing: {
        voiceProvider: 'omnivoice', voiceEngine: 'omnivoice', voiceSteps: steps, voiceWarm: true,
        voiceDtype: this.details.dtype, voiceRuntime: this.details.runtime,
        voiceAcceleration: frame.acceleration || 'eager', voiceGraph: frame.cudaGraph,
        voiceQueueMs: started - queued, voiceGenerationMs: frame.generationMs,
        voiceRoundTripMs: performance.now() - started}};
    });
    // Cancellation releases the caller immediately, but the physical inference
    // retains the queue until completion. A second GPU job cannot overtake it.
    this.tail = operation.catch(() => {});
    return abortable(operation, signal);
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve();
    this.rejectReady?.(cancelled());
    if (!this.child) { this.publish('stopped'); return this.closing; }
    this.publish('stopping');
    // EOF is observed after the current inference finishes. A stuck process
    // receives the bounded owned-worker shutdown path rather than waiting forever.
    this.child.stdin.end();
    // An active render/warmup keeps its original deadline. Once it finishes,
    // only the short teardown allowance remains; idle close starts it now.
    if (!this.phaseTimer) this.awaitExit();
    this.closing = this.exited || Promise.resolve();
    return this.closing;
  }
}
