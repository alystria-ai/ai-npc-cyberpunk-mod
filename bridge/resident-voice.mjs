import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {inspectWav} from './speech-audio.mjs';
import {abortable, throwIfCancelled, cancelled} from './transport-pool.mjs';

export const LOCAL_VOICE_KEYS = Object.freeze(['johnny-silverhand', 'judy-alvarez', 'panam-palmer']);
export const voiceSteps = value => value === 16 ? 16 : 32;

export class ResidentVoice {
  constructor(config = {}, {project, configPath, spawnImpl = spawn, onState = () => {}, onLog = () => {}} = {}) {
    if (!['convai', 'hybrid'].includes(config.provider || 'convai')) throw Error('Unknown local speech provider');
    if (config.provider === 'hybrid' && (config.engine !== 'omnivoice'
        || LOCAL_VOICE_KEYS.some(key => !config.voices?.[key])
        || Object.keys(config.voices).some(key => !LOCAL_VOICE_KEYS.includes(key)))) {
      throw Error('Local voices must map Johnny, Judy and Panam to OmniVoice');
    }
    Object.assign(this, {config, project, configPath, spawnImpl, onState, onLog});
    this.steps = voiceSteps(config.steps); this.tail = Promise.resolve();
    this.sequence = 0; this.pending = new Map(); this.state = this.enabled ? 'stopped' : 'disabled';
    this.loaded = false; this.details = {};
  }
  get enabled() { return this.config.provider === 'hybrid'; }
  hasProfile(key) { return LOCAL_VOICE_KEYS.includes(key) && !!this.config.voices?.[key]; }
  usesProfile(key) { return this.enabled && this.hasProfile(key); }
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
        profiles: this.enabled ? [...LOCAL_VOICE_KEYS] : [], resident: this.loaded,
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
      child = this.child = this.spawnImpl(resolve(this.project, 'vendor/reference-voicestudio/.venv/Scripts/python.exe'),
        [resolve(this.project, 'bridge/resident-voice-worker.py'), '--config', this.configPath],
        {cwd: this.project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: {...process.env, PYTHONUTF8: '1'}});
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
    this.exited = new Promise(done => child.once('close', code => {
      this.child = null; this.loaded = false;
      this.details = {...this.details, cudaAllocatedMiB: 0, cudaReservedMiB: 0};
      if (!this.closing) this.fail(Error(`Local voice worker exited (${code})`));
      else this.publish('stopped');
      done();
    }));
    return this.ready;
  }
  receive(frame) {
    if (frame.op === 'state') {
      if (!['loading', 'warming'].includes(frame.state)) throw Error('Invalid local voice state');
      if (!this.closing) this.publish(frame.state, {profile: frame.profile});
      return;
    }
    if (frame.op === 'ready') {
      if (!frame.device?.startsWith('cuda') || frame.dtype !== 'torch.float16' || frame.runtime !== 'pytorch'
          || frame.tensorrt !== false || LOCAL_VOICE_KEYS.some(key => !frame.profiles?.includes(key))) {
        throw Error('Local voice worker did not warm all profiles on CUDA');
      }
      this.loaded = true;
      this.details = {device: frame.device, dtype: frame.dtype, runtime: frame.runtime,
        tensorrt: frame.tensorrt, compiled: frame.compiled,
        cudaAllocatedMiB: frame.cudaAllocatedMiB, cudaReservedMiB: frame.cudaReservedMiB,
        cudaPeakReservedMiB: frame.cudaPeakReservedMiB};
      if (!this.closing && !this.failure) this.publish('ready');
      this.resolveReady(); return;
    }
    const request = this.pending.get(frame.id);
    if (!request || !['audio', 'error'].includes(frame.op)) throw Error('Unexpected local speech response');
    this.pending.delete(frame.id);
    for (const key of ['cudaAllocatedMiB', 'cudaReservedMiB', 'cudaPeakReservedMiB']) {
      if (Number.isFinite(frame[key])) this.details[key] = frame[key];
    }
    if (!this.closing) this.publish('ready');
    if (frame.op === 'error') request.reject(Error('Local voice could not generate this reply'));
    else if (frame.profile !== request.profile || frame.steps !== request.steps) {
      request.reject(Error('Local speech identity changed'));
    } else request.resolve(frame);
  }
  fail(error) {
    this.failure = error;
    this.rejectReady?.(error);
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
    if (!this.closing) this.publish('error', {detail: 'Local voices are unavailable. Restart the conversation bridge.'});
    // EOF lets a running generation finish before releasing CUDA, including
    // when a malformed response has made this worker unusable.
    if (this.child && !this.child.stdin.writableEnded) this.child.stdin.end();
  }
  synthesize(profile, text, {signal, steps: chosenSteps} = {}) {
    if (!this.usesProfile(profile)) return Promise.reject(Error('This character uses its Convai voice'));
    if (typeof text !== 'string' || !text.trim() || text.length > 12_000) return Promise.reject(Error('Invalid speech text'));
    if (chosenSteps !== undefined && ![16, 32].includes(chosenSteps)) return Promise.reject(Error('Invalid voice quality'));
    const steps = chosenSteps ?? this.steps, queued = performance.now();
    const operation = this.tail.then(async () => {
      throwIfCancelled(signal);
      if (this.closing || this.failure) throw this.failure || cancelled();
      await this.start();
      throwIfCancelled(signal);
      if (this.closing || this.failure) throw this.failure || cancelled();
      const started = performance.now(), id = ++this.sequence;
      this.publish('speaking', {profile});
      const frame = await new Promise((resolveAudio, reject) => {
        this.pending.set(id, {resolve: resolveAudio, reject, profile, steps});
        this.child.stdin.write(JSON.stringify({op: 'synthesize', id, profile, text, steps}) + '\n', error => {
          if (error) this.fail(error);
        });
      });
      throwIfCancelled(signal);
      if (this.closing || this.failure) throw this.failure || cancelled();
      const bytes = Buffer.from(frame.audio, 'base64'), wav = inspectWav(bytes);
      return {audio: bytes.toString('base64'), wav, faces: [], captions: [], timing: {
        voiceProvider: 'omnivoice', voiceEngine: 'omnivoice', voiceSteps: steps, voiceWarm: true,
        voiceDtype: this.details.dtype, voiceRuntime: this.details.runtime,
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
    // EOF is observed after the current inference finishes; no forced CUDA
    // termination, and no orphaned HTTP service holding VRAM after shutdown.
    this.child.stdin.end();
    this.closing = this.exited || Promise.resolve();
    return this.closing;
  }
}
