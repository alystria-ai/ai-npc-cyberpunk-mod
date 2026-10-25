import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {inspectWav} from './speech-audio.mjs';
import {abortable, throwIfCancelled, cancelled} from './transport-pool.mjs';
import {createVoiceProfileRegistry, LEGACY_LOCAL_VOICE_KEYS, registryFromTable, voiceChangeBatches, voiceTable} from './voice-profile-registry.mjs';
import {absoluteRuntimeOverride, OMNI_RUNTIME_PATHS, omniRuntimeOverrides} from './runtime-paths.mjs';
import {realpathSync} from 'node:fs';
import {constants as osConstants, setPriority as osSetPriority} from 'node:os';
import {readGpuProcessMemory} from './gpu-memory.mjs';
import {markBridgeStage} from './stage-marker.mjs';
import {killProcessTree, pidAlive, recoverExit} from './worker-process.mjs';
import {describeExitCode, stderrReason} from './voice-failures.mjs';

// Historical accepted-reference fixture/packaging list. Eligibility is always
// read from the validated registry, never from this compatibility export.
export const LOCAL_VOICE_KEYS = LEGACY_LOCAL_VOICE_KEYS;
export const voiceSteps = value => value === 16 ? 16 : 32;
// Startup is progress-based. Loading OmniVoice took about 3 minutes on a CPU-throttled laptop (Windows Silent
// power mode) with nothing else running, and longer while the game itself is loading, so a fixed limit near that
// figure downgraded the session. The worker reports a state frame at each loading stage and its libraries log
// weight loading; any such output restarts the stall window, so a worker that keeps moving is never cut off.
// Only silence for `startupStallMs`, or the absolute `startupMaxMs`, ends a start. `startupCloseMs` bounds the wait
// for a worker that is still loading when its owner has already asked it to stop (nothing to preserve there).
export const VOICE_WORKER_LIMITS = Object.freeze({startupStallMs: 300_000, startupMaxMs: 900_000,
  startupCloseMs: 60_000, renderMs: 120_000, exitGraceMs: 10_000, exitConfirmationMs: 5_000, voicesMs: 30_000, recoverMs: 120_000});

// What a worker that did not confirm its paths fails with. The paths are fixed for the life of the service, so another try fails the same way
// (bridge/voice-selection.mjs does not schedule one).
export const PATH_ATTESTATION_FAILURE = 'Local voice worker did not confirm its portable asset and data paths';
export const pathAttestationFailed = reason => String(reason ?? '').includes(PATH_ATTESTATION_FAILURE);

// A worker whose PyTorch has no CUDA (an AMD or Intel card, or an NVIDIA driver that does not work) exits with this code (resident-voice-worker.py
// NO_CUDA_EXIT_CODE) and fails with this text. It is the same on every try, so bridge/voice-selection.mjs does not schedule one.
export const NO_CUDA_EXIT_CODE = 78;
export const NO_CUDA_FAILURE = 'Local voice worker needs CUDA (no NVIDIA graphics card that works)';
export const noCudaFailed = reason => String(reason ?? '').includes(NO_CUDA_FAILURE);
// A worker that ran out of its time ("Local voice startup timed out", "... preparation timed out") or out of graphics memory (a CUDA out-of-memory error).
export const timedOutFailed = reason => /^Local voice .*timed out/.test(String(reason ?? ''));
export const outOfMemoryFailed = reason => /out of memory|OutOfMemory/i.test(String(reason ?? ''));

export class ResidentVoice {
  constructor(config = {}, {project, configPath, spawnImpl = spawn, onState = () => {}, onLog = () => {},
    setTimer = setTimeout, clearTimer = clearTimeout,
    pythonExecutable = process.env.CYBERPUNK_CONVAI_PYTHON,
    modelDirectory = process.env.CYBERPUNK_CONVAI_OMNI_MODEL,
    adapterDirectory = process.env.CYBERPUNK_CONVAI_OMNI_ADAPTER,
    referenceDirectory = process.env.CYBERPUNK_CONVAI_OMNI_REFERENCES,
    cacheDirectory = process.env.CYBERPUNK_CONVAI_OMNI_CACHE,
    lowPriority = false, setPriority = osSetPriority, isAlive, extraEnvironment = null,
    // skipStartupWarm() -> boolean, asked once per worker start: true when every reply of this session is expected in a language with a voice pack, so the
    // worker does not spend its start warming the English startup profiles (the pack's clips are what speaks). Nothing else changes: each voice still
    // prepares when it is first asked.
    skipStartupWarm = null,
    // gpuMemory(pid) -> {dedicatedMiB, sharedMiB} | null: one reading of the worker's graphics-memory counters when a generation or a preparation runs out of time
    // (diagnostics only). A test that supplies its own spawn gets none unless it passes this.
    gpuMemory = spawnImpl === spawn ? readGpuProcessMemory : null} = {}) {
    this.pythonExecutable = absoluteRuntimeOverride(pythonExecutable, 'CYBERPUNK_CONVAI_PYTHON');
    this.workerEnvironment = omniRuntimeOverrides({modelDirectory, adapterDirectory, referenceDirectory, cacheDirectory});
    this.registry = createVoiceProfileRegistry(config);
    // The voices the worker holds: the configuration's at its start (`baseRegistry`, what its start is checked against), then what a player
    // changed while it runs (setVoices), which `registry` follows once the worker confirms it.
    this.baseRegistry = this.registry; this.baseDir = config.playerVoiceDirectory ?? null; this.workerDir = this.baseDir; this.wanted = null;
    Object.assign(this, {config: Object.freeze({...config, voices: this.registry.profiles,
      preparation: this.registry.preparation}), project, configPath, spawnImpl, onState, onLog, setTimer, clearTimer});
    this.steps = voiceSteps(config.steps); this.tail = Promise.resolve();
    this.sequence = 0; this.pending = new Map(); this.state = this.enabled ? 'stopped' : 'disabled';
    this.loaded = false; this.details = {};
    this.prepared = new Set(); this.available = new Set(this.registry.keys);
    // "Keep prepared voices": the hidden warm-up render made while a companion joins uses the selected steps.
    this.keepPrepared = false;
    this.skipStartupWarm = typeof skipStartupWarm === 'function' ? skipStartupWarm : null; this.startupProfiles = this.registry.preparation.startupProfiles;
    // A background (re)start loads below normal priority so it does not compete with the game for CPU; it is
    // raised to normal once ready, because rendering replies is latency-sensitive.
    this.lowPriority = lowPriority === true; this.setPriority = setPriority;
    this.gpuMemory = typeof gpuMemory === 'function' ? gpuMemory : null;
    // Extra variables for this worker's environment (the voice service turns the CUDA graph off for the retry after a memory fault).
    this.extraEnvironment = extraEnvironment && typeof extraEnvironment === 'object' ? {...extraEnvironment} : null;
    // Is a process still running (exit recovery)? A test's stand-in child has no process: it is alive until it says it closed.
    this.isAlive = typeof isAlive === 'function' ? isAlive : spawnImpl === spawn ? pidAlive : () => true;
  }
  setKeepPrepared(value) { this.keepPrepared = value === true; }
  /**
   * The voices this worker should hold from now on (`voices`: the configuration's `voices` object; `playerVoiceDirectory`: the folder a player's clip
   * is in). The model is not reloaded: the worker is sent the difference (a voice replaced or removed leaves the prepared list and the prompt cache;
   * the others keep theirs), in line behind the job it is doing, so a reply in flight finishes with the voice it started with and the next one uses
   * the new one. A worker that is not running yet gets them when it is ready. Resolves to true when the worker confirmed a change.
   */
  setVoices(voices, {playerVoiceDirectory = null} = {}) {
    if (this.closing || this.failure) return Promise.resolve(false);
    try { this.wanted = {table: voiceTable(registryFromTable(voices, this.config)), playerVoiceDirectory: playerVoiceDirectory ?? null}; }
    catch (error) { return Promise.reject(error); }
    return this.queueVoices();
  }
  // Does the worker hold other voices than it should (or not know the player folder yet)? A worker of the first protocol cannot be changed.
  voicesDiffer() {
    const wanted = this.wanted;
    if (!wanted || this.protocolVersion !== 2) return false;
    return (!!wanted.playerVoiceDirectory && wanted.playerVoiceDirectory !== this.workerDir) || voiceChangeBatches(voiceTable(this.registry), wanted.table).length > 0;
  }
  queueVoices() {
    if (!this.loaded || this.protocolVersion !== 2) return Promise.resolve(false);
    const operation = this.tail.then(() => this.syncVoices());
    this.tail = operation.catch(() => {});
    return operation;
  }
  async syncVoices() {
    const wanted = this.wanted;
    if (!wanted || !this.loaded || this.closing || this.failure) return false;
    const folder = wanted.playerVoiceDirectory && wanted.playerVoiceDirectory !== this.workerDir ? wanted.playerVoiceDirectory : null;
    const batches = voiceChangeBatches(voiceTable(this.registry), wanted.table);
    if (!batches.length && !folder) return false;
    if (!batches.length) batches.push({set: {}, remove: [], table: voiceTable(this.registry)});
    for (const [at, batch] of batches.entries()) {
      await this.voicesCommand({set: batch.set, remove: batch.remove, ...(folder && at === 0 ? {playerVoiceDirectory: folder} : {})},
        registryFromTable(batch.table, this.config));
      if (folder && at === 0) this.workerDir = folder;
      if (this.closing || this.failure) return false;
    }
    return true;
  }
  voicesCommand(payload, next) {
    if (this.closing || this.failure || !this.child) return Promise.reject(this.failure || cancelled());
    const id = ++this.sequence;
    return new Promise((resolveFrame, reject) => {
      this.pending.set(id, {resolve: resolveFrame, reject, kind: 'voices', profile: undefined, next});
      this.phaseDeadline('voice change', VOICE_WORKER_LIMITS.voicesMs);
      this.child.stdin.write(JSON.stringify({op: 'voices', id, ...payload}) + '\n', error => { if (error) this.fail(error); });
    });
  }
  // The worker's answer to a voice change: the voices it now holds, checked against the descriptors that were sent (both hashes).
  receiveVoices(frame, request) {
    if (!['voices', 'error'].includes(frame.op)) throw Error('Unexpected local speech response');
    this.pending.delete(frame.id); this.clearPhase();
    const limit = this.registry.preparation.maxCachedProfiles;
    if (frame.op === 'error') {
      // A refused change leaves the worker as it was.
      if (this.validProfiles(frame.profiles) && this.validProfiles(frame.preparedProfiles, limit) && frame.preparedProfiles.every(key => frame.profiles.includes(key))) {
        this.available = new Set(frame.profiles); this.prepared = new Set(frame.preparedProfiles);
      }
      if (!this.closing) this.publish('ready');
      request.reject(Error('Local voices could not be changed'));
      return;
    }
    const previous = this.registry;
    this.registry = request.next;
    try {
      const {profiles, preparedProfiles: prepared, referenceHashes: references, transcriptHashes: transcripts} = frame;
      const mapOf = value => value && typeof value === 'object' && !Array.isArray(value);
      if (!this.validProfiles(profiles) || !this.validProfiles(prepared, this.registry.preparation.maxCachedProfiles) || prepared.some(key => !profiles.includes(key))
          || !mapOf(references) || Object.keys(references).length !== profiles.length || profiles.some(key => references[key] !== this.registry.profiles[key].sha256)
          || !mapOf(transcripts) || Object.keys(transcripts).length !== profiles.length
          || profiles.some(key => transcripts[key] !== createHash('sha256').update(this.registry.profiles[key].transcript, 'utf8').digest('hex')))
        throw Error('Local voice worker did not confirm the changed voices');
      this.available = new Set(profiles); this.prepared = new Set(prepared);
    } catch (error) { this.registry = previous; request.reject(error); throw error; }
    if (!this.closing) this.publish('ready');
    request.resolve({changed: Array.isArray(frame.changed) ? frame.changed.filter(key => typeof key === 'string') : []});
    if (this.closing || this.failure) this.awaitExit();
  }
  priority(level) {
    if (!this.child?.pid) return;
    try { this.setPriority(this.child.pid, level); } catch { /* A priority is an optimisation, never a failure. */ }
  }
  schedule(callback, delay) {
    const timer = this.setTimer(callback, delay); timer?.unref?.(); return timer;
  }
  clearPhase() {
    this.clearTimer(this.phaseTimer); this.clearTimer(this.capTimer);
    this.phaseTimer = this.capTimer = this.phaseLabel = null;
  }
  phaseDeadline(label, delay) {
    this.clearTimer(this.phaseTimer);
    this.phaseLabel = label;
    this.phaseTimer = this.schedule(() => {
      this.phaseTimer = null;
      const error = Error(`Local voice ${label} timed out`), pid = this.child?.pid;
      // A render that ran out of its two minutes (about fifty times a phrase's time on a card with room) says where its graphics memory is before the worker is
      // ended: 2026-10-20 reports of OmniVoice beside Local AI and the game on 12 GB cards had no log of the failing session. One short reading, only now.
      if (label === 'startup' || !this.gpuMemory || !pid || this.closing || this.failure) { this.fail(error); return; }
      let done = false;
      const finish = memory => {
        if (done) return; done = true;
        if (memory && Number.isFinite(memory.dedicatedMiB) && Number.isFinite(memory.sharedMiB)) {
          error.gpu = {dedicatedMiB: Math.round(memory.dedicatedMiB), sharedMiB: Math.round(memory.sharedMiB)};
          try { this.onLog(`graphics memory of the voice worker after its ${label} ran out of time: ${error.gpu.dedicatedMiB} MiB on the card, ${error.gpu.sharedMiB} MiB in shared system memory
`); } catch { /* a log line never changes the failure */ }
        }
        this.fail(error);
      };
      try { Promise.resolve(this.gpuMemory(pid)).then(finish, () => finish(null)); } catch { finish(null); }
      this.schedule(() => finish(null), 4000);
    }, delay);
  }
  // Any output from a starting worker restarts the stall window (a few dozen re-arms in a whole start, none after it).
  startupProgress() {
    if (this.phaseLabel === 'startup' && !this.closing) this.phaseDeadline('startup', VOICE_WORKER_LIMITS.startupStallMs);
  }
  awaitExit() {
    if (!this.child || this.exitTimer || this.exitConfirmation) return;
    const child = this.child;
    this.exitTimer = this.schedule(() => {
      this.exitTimer = null;
      if (this.child !== child) return;
      // A hung owned worker must not retain CUDA forever. No process-pattern
      // termination: this handle belongs only to the child we spawned.
      this.killWorker(child);
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
  // "Local voice worker exited (1)", then the exit code in words when it is a Windows fault, then the last error line of its stderr.
  exitedMessage(code) {
    const words = describeExitCode(code), reason = stderrReason(this.stderrTail);
    return `Local voice worker exited (${words === String(code) ? code : words})${reason ? `: ${reason}` : ''}`;
  }
  // Stops the worker we spawned and what it started (bridge/worker-process.mjs: the process tree on Windows, the handle as the fallback).
  killWorker(child) { void killProcessTree(child, {real: this.spawnImpl === spawn, setTimer: this.setTimer, clearTimer: this.clearTimer}); }
  /** A close whose exit was not confirmed: asks again whether the process is gone, stopping it again every few seconds (true: it is gone). */
  recoverExit({timeoutMs = VOICE_WORKER_LIMITS.recoverMs, pollMs = 1000, killMs = 10_000} = {}) {
    const child = this.child;
    return recoverExit({child, isAlive: this.isAlive, kill: () => this.killWorker(child), timeoutMs, pollMs, killMs,
      schedule: (task, ms) => this.schedule(task, ms),
      onGone: () => { if (this.child === child) { this.child = null; this.loaded = false; } }});
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
    // A new worker reads the configuration's voices: what a player changed since is sent once it is ready.
    this.registry = this.baseRegistry; this.workerDir = this.baseDir;
    let skipWarm = false;
    try { skipWarm = this.skipStartupWarm?.() === true; } catch { /* the default start: warm them */ }
    this.startupProfiles = skipWarm ? [] : this.registry.preparation.startupProfiles;
    let child;
    try {
      // pydub (a dependency of the OmniVoice package) warns at import that it found no ffmpeg; the worker never converts audio with it, and the
      // warning was in 13 of the first 82 error reports (2026-10-20), taking log lines from each. Only that warning is silenced.
      const environment = {...process.env, PYTHONUTF8: '1', PYTHONWARNINGS: 'ignore::RuntimeWarning:pydub.utils'};
      // Use the values captured with this owner, even if the parent environment
      // changes before warm-up. An absent layout keeps the development defaults.
      for (const name of Object.values(OMNI_RUNTIME_PATHS)) delete environment[name];
      Object.assign(environment, this.workerEnvironment, this.extraEnvironment);
      if (this.workerEnvironment) environment.PYTHONDONTWRITEBYTECODE = '1';
      markBridgeStage('voice.worker-start');   // the supervisor's last-stage note (bridge/stage-marker.mjs)
      child = this.child = this.spawnImpl(this.pythonExecutable
        || resolve(this.project, 'vendor/reference-voicestudio/.venv/Scripts/python.exe'),
        [resolve(this.project, 'bridge/resident-voice-worker.py'), '--config', this.configPath, ...(skipWarm ? ['--skip-startup-warm'] : [])],
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
    // The last of what the worker wrote to stderr: when it dies, the last error line is the reason (an opaque "exited (1)" hid a CUDA out-of-memory
    // error and a fault with no stack, and every one was retried the same way).
    child.stderr.setEncoding('utf8'); this.stderrTail = '';
    child.stderr.on('data', part => { this.startupProgress(); this.stderrTail = (this.stderrTail + part).slice(-6000); try { this.onLog(part); } catch {} });
    child.stdin.on('error', error => this.fail(error));
    child.on('error', error => this.fail(error));
    this.exited = new Promise((done, reject) => {
      this.rejectExited = reject;
      child.once('close', code => {
        this.clearPhase(); this.clearTimer(this.exitTimer); this.clearTimer(this.exitConfirmation);
        this.exitTimer = this.exitConfirmation = null;
        this.child = null; this.loaded = false; this.prepared.clear();
        this.details = {...this.details, cudaAllocatedMiB: 0, cudaReservedMiB: 0};
        const error = this.failure || (this.closing ? cancelled('Local speech stopped') : Error(code === NO_CUDA_EXIT_CODE ? NO_CUDA_FAILURE : this.exitedMessage(code)));
        this.rejectReady?.(error);
        for (const item of this.pending.values()) item.reject(error);
        this.pending.clear();
        if (!this.closing) this.fail(error); else this.publish('stopped');
        done();
      });
    });
    this.exited.catch(() => {});
    if (this.lowPriority) this.priority(osConstants.priority.PRIORITY_BELOW_NORMAL);
    this.phaseDeadline('startup', VOICE_WORKER_LIMITS.startupStallMs);
    this.capTimer = this.schedule(() => {
      this.capTimer = null;
      this.fail(Error('Local voice startup timed out (took too long to load)'));
    }, VOICE_WORKER_LIMITS.startupMaxMs);
    return this.ready;
  }
  receive(frame) {
    if (frame.op === 'state') {
      this.startupProgress();
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
          // Real location: CI and some installs name a folder by its short 8.3 form on one side.
          let path = resolve(value);
          try { path = realpathSync.native(path); } catch {}
          return process.platform === 'win32' ? path.toLowerCase() : path;
        };
        if (!paths || typeof paths !== 'object' || Array.isArray(paths)
            || Object.keys(paths).length !== Object.keys(expected).length
            || Object.entries(expected).some(([field, path]) => normalized(paths[field]) !== normalized(path))) {
          // Which path the worker and the bridge name differently, for the log (a support report then shows it: this failure was only
          // ever seen under Mod Organizer 2, where a folder and a file resolve to different mods).
          try {
            const unequal = Object.entries(expected).filter(([field, path]) => {
              try { return normalized(paths?.[field]) !== normalized(path); } catch { return true; }
            }).map(([field, path]) => `${field}: worker ${String(paths?.[field])} | bridge ${path}`);
            this.onLog(`[OmniPaths] ${unequal.length ? unequal.join('; ') : 'the worker reported another set of path fields'}\n`);
          } catch { /* the log line is an extra */ }
          throw Error(PATH_ATTESTATION_FAILURE);
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
          || (version === 2 && this.startupProfiles.some(key => profiles.includes(key) && !prepared.includes(key)))) {
        throw Error('Local voice worker did not warm all profiles on CUDA');
      }
      this.protocolVersion = version; this.available = new Set(profiles); this.prepared = new Set(prepared);
      this.loaded = true;
      this.clearPhase();
      if (this.lowPriority) this.priority(osConstants.priority.PRIORITY_NORMAL);
      this.details = {device: frame.device, dtype: frame.dtype, runtime: frame.runtime,
        tensorrt: frame.tensorrt, compiled: frame.compiled,
        acceleration: frame.acceleration || 'eager', cudaGraph: frame.cudaGraph,
        cudaAllocatedMiB: frame.cudaAllocatedMiB, cudaReservedMiB: frame.cudaReservedMiB,
        cudaPeakReservedMiB: frame.cudaPeakReservedMiB};
      if (!this.closing && !this.failure) this.publish('ready');
      // Voices a player changed while this worker was loading are sent now, ahead of any reply; the start is done when they are in.
      if (!this.voicesDiffer()) this.resolveReady();
      else {
        void this.queueVoices().catch(error => { try { this.onLog(`[LocalVoice] voice change failed: ${String(error?.message ?? error).slice(0, 120)}\n`); } catch {} })
          .then(() => this.resolveReady());
      }
      if (this.closing || this.failure) this.awaitExit();
      return;
    }
    const request = this.pending.get(frame.id);
    if (request?.kind === 'voices') { this.receiveVoices(frame, request); return; }
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
        // A reply spoken from a language pack clip does not prepare the profile (the worker leaves its prepared list as it was).
        if (!this.validProfiles(frame.preparedProfiles, this.registry.preparation.maxCachedProfiles)
            || frame.preparedProfiles.some(key => !this.available.has(key))
            || (frame.op !== 'error' && !request.languageReference && !frame.preparedProfiles.includes(request.profile))) {
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
    if (!this.usesProfile(profile)) return Promise.resolve({provider: 'text', ready: true,
      reason: this.registry.has(profile) ? 'unavailable' : this.registry.status(profile)});
    const operation = this.tail.then(async () => {
      await this.ensurePrepared(profile, signal);
      return {provider: 'omnivoice', ready: this.profileReady(profile), profile};
    });
    this.tail = operation.catch(() => {});
    return abortable(operation, signal);
  }
  /**
   * Prepares a multilingual pack's clip for a reply that is about to be spoken from it: the worker checks the clip and builds its conditioning prompt into the
   * prompt cache (no render, the profile's own prepared state is not touched), so the first line in that language does not do it. Quiet by design: a clip
   * the worker refuses answers 'fallback' (the reply is then spoken from the English reference), and nothing here throws into a turn.
   * Resolves {provider: 'omnivoice', profile, languageReference: 'used' | 'fallback', ms}.
   */
  prepareLanguage(profile, languageReference, {signal} = {}) {
    if (!this.usesProfile(profile)) return Promise.reject(Error('This character uses its Convai voice'));
    if (!(languageReference && typeof languageReference.reference === 'string' && /^[a-f0-9]{64}$/.test(languageReference.sha256 ?? '')
        && typeof languageReference.transcript === 'string' && languageReference.transcript.trim())) return Promise.reject(Error('Invalid language reference'));
    const wanted = {languageReference: {reference: languageReference.reference, sha256: languageReference.sha256, transcript: languageReference.transcript}};
    const operation = this.tail.then(async () => {
      await this.start();
      throwIfCancelled(signal);
      if (this.closing || this.failure) throw this.failure || cancelled();
      if (!this.hasProfile(profile)) throw Error('This character uses its Convai voice');
      if (this.protocolVersion !== 2) throw Error('Local voice worker cannot prepare this clip');
      const frame = await this.command('prepare', profile, wanted);
      throwIfCancelled(signal);
      return {provider: 'omnivoice', profile, languageReference: frame.languageReference === 'used' ? 'used' : 'fallback', ms: frame.generationMs};
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
  // `languageReference` {reference, sha256, transcript}: a multilingual pack's clip of this character (docs/VOICE_LANGUAGE_PACKS.md, bridge/voice-language-packs.mjs
  // omniDescriptor) to clone from instead of the profile's English reference. The worker checks it like any reference and answers 'used', or 'fallback' when it
  // spoke from the English one (the result's timing says which: voiceLanguageReference). The profile is not prepared for it: the clip's prompt is its own.
  synthesize(profile, text, {signal, steps: chosenSteps, language, languageReference} = {}) {
    if (!this.usesProfile(profile)) return Promise.reject(Error('This character uses its Convai voice'));
    if (typeof text !== 'string' || !text.trim() || text.length > 12_000) return Promise.reject(Error('Invalid speech text'));
    if (chosenSteps !== undefined && ![16, 32].includes(chosenSteps)) return Promise.reject(Error('Invalid voice quality'));
    if (language !== undefined && language !== null && !/^[a-z]{2,3}$/.test(language)) return Promise.reject(Error('Invalid speech language'));
    const languageField = language && language !== 'en' ? {language} : {};
    // Only a non-English reply has a language reference, and only a well-formed one is sent.
    const wanted = languageField.language && languageReference && typeof languageReference.reference === 'string' && /^[a-f0-9]{64}$/.test(languageReference.sha256 ?? '')
      && typeof languageReference.transcript === 'string' && languageReference.transcript.trim()
      ? {languageReference: {reference: languageReference.reference, sha256: languageReference.sha256, transcript: languageReference.transcript}} : {};
    const steps = chosenSteps ?? this.steps, queued = performance.now();
    const operation = this.tail.then(async () => {
      if (wanted.languageReference) {
        // The English profile is not prepared for a language clip's reply (that would be a hidden render for nothing): the worker only has to be running.
        await this.start();
        throwIfCancelled(signal);
        if (this.closing || this.failure) throw this.failure || cancelled();
        if (!this.hasProfile(profile)) throw Error('This character uses its Convai voice');
      } else await this.ensurePrepared(profile, signal);
      const started = performance.now();
      const frame = await this.command('synthesize', profile, {text, steps, ...languageField, ...wanted});
      throwIfCancelled(signal);
      if (this.closing || this.failure) throw this.failure || cancelled();
      const bytes = Buffer.from(frame.audio, 'base64'), wav = inspectWav(bytes);
      return {audio: bytes.toString('base64'), wav, faces: [], captions: [], timing: {
        voiceProvider: 'omnivoice', voiceEngine: 'omnivoice', voiceSteps: steps, voiceWarm: true,
        ...(wanted.languageReference ? {voiceLanguageReference: frame.languageReference === 'used' ? 'used' : 'fallback'} : {}),
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
    // A worker that is still loading only reads EOF once loaded; nothing there is worth waiting for, so its
    // deadline shortens to a minute (progress no longer extends it, and the absolute limit is dropped).
    if (this.phaseLabel === 'startup') {
      this.clearTimer(this.capTimer); this.capTimer = null;
      this.phaseDeadline('startup', VOICE_WORKER_LIMITS.startupCloseMs);
    }
    // An active render/warmup keeps its original deadline. Once it finishes,
    // only the short teardown allowance remains; idle close starts it now.
    if (!this.phaseTimer) this.awaitExit();
    this.closing = this.exited || Promise.resolve();
    return this.closing;
  }
}
