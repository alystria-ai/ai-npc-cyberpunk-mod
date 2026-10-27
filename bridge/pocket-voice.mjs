// Pocket has a shared CPU student and a real incremental decoder. It submits
// the complete reply once and never enters Omni's text/phrase WAV queue.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {absoluteRuntimeOverride} from './runtime-paths.mjs';
import {createVoiceProfileRegistry, registryFromTable, voiceChangeBatches, voiceTable} from './voice-profile-registry.mjs';
import {pocketSpokenText} from './pocket-language-models.mjs';
import {abortable, cancelled, throwIfCancelled} from './transport-pool.mjs';
import {killProcessTree, pidAlive, recoverExit} from './worker-process.mjs';
import {describeExitCode, stderrReason} from './voice-failures.mjs';
import {DEFAULT_PRIORITY, priorityEnvironment, priorityLevel, setProcessPriority} from './process-priority.mjs';

export const POCKET_SOURCE_REVISION = '41cbc84af539ea78a804ffca5f9c6edc1a22ce44';
export const POCKET_SOURCE_SHA256 = 'b86f98955b6c4776bb24a748b321408aba89d3b66f6b911f415ef4f4191a7666';
// stallMs: a starting worker that makes no progress this long is stuck. Progress is a new phase, a mark after a heavy import, the worker's
// own CPU time growing (progressCpuMs since the last progress), the bytes it has read or written growing (progressIoBytes) or more Python
// modules loaded (its heartbeat reports all three every 2 s while starting). CPU time alone judged a worker that waits for a virus scan or a
// cold disk (wall time, no CPU) as stuck and killed it in the middle of its imports ("startup stalled": 18 kills and 10 give-ups in the 0.2.3
// reports, 8 cold torch imports in the worst case). A worker that is merely slow keeps moving and is never stopped for it; one that has shown
// nothing for stallMs gets stallGraceMs more (the reading of an import held by a scanner stands still for a while), and only one that still
// shows nothing is stopped and started once more; a second stall gives up (the failure is the same as a startup timeout). startupMs is the hard
// bound for the whole start, progress or not; a restarted worker gets what is left of it but never less than restartMinMs, so the second
// attempt is not set up to fail by the time the first one used. Importing the runtime has been measured at 2 to 36 s on healthy machines
// and over 45 s on a busy one, so it gets a longer window; loading the student and warming voices are given longer ones.
// cancelMs: how long a cancelled request may keep the worker busy before the bridge says so in its log and goes on waiting up to
// cancelHardMs more (the worker stops decoding its backlog the moment it is cancelled, but on a computer starved of CPU even finishing the
// step in hand takes seconds, and the next request waits for the worker either way: stopping it only costs the reload). A first-time
// preparation of a voice (1.4 to 4.5 s, far longer on a computer starved of CPU) cannot be interrupted, and neither can the worker reading
// a reply's text before its first sound, so a cancelled one of those gets prepareCancelMs first: the worker finishes it, answers
// 'cancelled', and goes on.
// sinkFirstMs / sinkMs: how long the audio consumer may take to accept a packet (the first one can wait for a cold hidden renderer, up to
// 25 s). The worker waits longer than both for an acknowledgement (ACK_WAIT_SECONDS in the worker), so the bridge's limit is always the
// one that applies, and neither ends the worker. closeGraceMs: how long a closing worker gets to leave by itself (its input closed) before
// it is stopped; exitMs: how long the stop gets to be confirmed (the process tree is stopped again at killRetryMs).
export const POCKET_LIMITS = Object.freeze({startupMs: 240_000, prepareMs: 60_000,
  // renderMs: how long a request may take to its first sound (preparing the voice, reading the text); renderIdleMs: then, how long it may go without a new
  // chunk of audio. A reply is cut when it stops making progress, never for its length: a slow computer that is still producing finishes the line (the old
  // limit was 120 s of wall time for the whole reply).
  renderMs: 120_000, renderIdleMs: 60_000, sinkMs: 10_000, sinkFirstMs: 30_000, cancelMs: 15_000, cancelHardMs: 15_000, prepareCancelMs: 30_000,
  closeGraceMs: 2000, exitMs: 15_000, killRetryMs: 6000, recoverMs: 120_000, maxFrames: 24000 * 120,
  stallMs: Object.freeze({default: 45_000, 'importing-dependencies': 60_000, 'loading-student': 90_000, 'student-loaded': 60_000, warming: 60_000}),
  stallGraceMs: Object.freeze({default: 60_000, 'importing-dependencies': 120_000}), restartMinMs: 200_000,
  progressCpuMs: 100, progressIoBytes: 65_536, progressLogMs: 30_000, startAttempts: 2, voicesMs: 30_000,
  // A language model swap: verify three files (about 240 MB), release the resident model, read the new one (0.7 to 1.6 s measured on a loaded laptop).
  languageMs: 90_000});
const HEARTBEAT_STEPS = Object.freeze(['numpy', 'torch', 'yaml', 'pocket_tts']);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const modelFields = ['sha256', 'configSha256', 'tokenizerSha256', 'receiptSha256', 'inputIdentity'];
const pathFields = ['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'];
// Where a voice's prepared state came from: memory, a saved setup on disk, or freshly encoded.
const preparationSource = frame => ['memory', 'disk', 'computed'].includes(frame.preparationSource) ? frame.preparationSource : undefined;
// Compare real locations: Windows can name one folder by its short 8.3 form (RUNNER~1) on one
// side and its long form on the other, and links can point the same way.
const canonicalPath = path => { try { return realpathSync.native(path); } catch { return resolve(path); } };
const samePath = (a, b) => {
  const left = canonicalPath(a), right = canonicalPath(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};

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
    setTimer = setTimeout, clearTimer = clearTimeout, keepPreparedVoices = false, stallMs, isAlive, workerPriority = DEFAULT_PRIORITY, setPriority} = {}) {
    this.config = validatePocketConfig(config); this.registry = this.config.registry;
    // The voices the worker holds. It starts with the configuration's (`baseRegistry`, which its start is checked against); a voice the
    // player changed while it runs is sent to it (setVoices) and `registry` follows what it confirms. A worker that starts again holds the
    // configuration's voices again, and the changes are sent again once it is ready.
    this.baseRegistry = this.registry; this.workerDir = config.runtime?.playerVoiceDirectory ?? null; this.baseDir = this.workerDir; this.wanted = null;
    this.project = absoluteRuntimeOverride(project, 'Pocket application directory');
    this.configPath = absoluteRuntimeOverride(configPath, 'Pocket configuration path');
    this.pythonExecutable = absoluteRuntimeOverride(pythonExecutable, 'Pocket Python executable');
    if (!this.project || !this.configPath || !this.pythonExecutable) throw Error('Pocket runtime paths cannot fall back to a development environment');
    Object.assign(this, {spawnImpl, onState, onLog, now, setTimer, clearTimer});
    // The level a reply being voiced runs at (bridge/process-priority.mjs, docs/PROCESS_PRIORITY.md): 'high' by default, the player's priority.txt can say 'normal'. The worker
    // starts at it (the child is set here, the worker sets itself) and keeps it while a reply is voiced; a voice prepared ahead of time stays below normal (pocket-voice-worker.py).
    this.priorityLevel = priorityLevel(workerPriority) ?? DEFAULT_PRIORITY;
    // A test's stand-in child has no process: its pid must never reach the real system call.
    this.setPriority = setPriority ?? (spawnImpl === spawn ? undefined : () => { /* a stand-in child: nothing to set */ });
    // Is a process still running (exit recovery)? A test's stand-in child has no process: it is alive until it says it closed.
    this.isAlive = typeof isAlive === 'function' ? isAlive : spawnImpl === spawn ? pidAlive : () => true;
    // One number replaces the per-phase stall limits (tests, tuning).
    this.stallMs = Number.isFinite(stallMs) && stallMs > 0 ? stallMs : null;
    this.attempt = 0; this.restarting = false;
    this.owner = randomUUID().replaceAll('-', ''); this.sequence = 0;
    this.pending = new Map(); this.available = new Set(this.registry.keys); this.prepared = new Set();
    // "Keep prepared voices": the worker saves each voice's prepared state to disk and reloads it later.
    this.keepPrepared = keepPreparedVoices === true;
    this.tail = Promise.resolve(); this.receiving = Promise.resolve(); this.state = 'stopped'; this.loaded = false;
    // The language model resident in the worker (docs/POCKET_LANGUAGE_MODELS.md): null is the English student. The last language used stays resident (no idle timer); the model
    // is swapped only when a reply comes in a different language, English included, and the process exits when Pocket is not needed at all. `languageView` is what the worker holds for it:
    // {tag, table (the voices it was given), registry, available, prepared, model}. The English `registry`, `available` and `prepared` stay as they are meanwhile
    // (the worker keeps the English voices it prepared), so nothing about the English path changes while a language is resident.
    this.language = null; this.languageView = null;
  }
  setKeepPrepared(value) { this.keepPrepared = value === true; }
  /**
   * The voices this worker should hold from now on (`voices`: the configuration's `voices` object; `playerVoiceDirectory`: the folder a player's clip
   * is in). Nothing is reloaded: the worker is sent the difference (a voice replaced or removed leaves its prepared state; the others keep theirs),
   * in line behind whatever it is doing, so a reply in flight finishes with the voice it started with and the next one uses the new one. A worker
   * that is not running yet gets them when it is ready. Resolves to true when the worker confirmed a change, false when there was nothing to send.
   */
  setVoices(voices, {playerVoiceDirectory = null} = {}) {
    if (this.closing || this.failure) return Promise.resolve(false);
    try { this.wanted = {table: voiceTable(registryFromTable(voices, this.config)), playerVoiceDirectory: playerVoiceDirectory ?? null}; }
    catch (error) { return Promise.reject(error); }
    return this.queueVoices();
  }
  // Does the worker hold other voices than it should (or not know the player folder yet)?
  voicesDiffer() {
    const wanted = this.wanted;
    if (!wanted) return false;
    return (!!wanted.playerVoiceDirectory && wanted.playerVoiceDirectory !== this.workerDir) || voiceChangeBatches(voiceTable(this.registry), wanted.table).length > 0;
  }
  queueVoices() {
    if (!this.loaded) return Promise.resolve(false);
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
    if (this.closing || this.failure) return Promise.reject(this.failure || cancelled());
    const id = ++this.sequence, started = this.now();
    return new Promise((resolveFrame, reject) => {
      const request = {id, kind: 'voices', profile: undefined, next, payload, queued: started, started, frames: 0, chunks: 0, lastReadyMs: 0,
        controller: new AbortController(), resolve: resolveFrame, reject};
      this.pending.set(id, request);
      request.timer = this.timer(() => this.fail(Error('Pocket voice change timed out')), POCKET_LIMITS.voicesMs);
      try { this.send({op: 'voices', id, ...payload}); } catch (error) { this.fail(error); }
    });
  }
  get enabled() { return this.registry.keys.length > 0 && !this.closing; }
  get profileKeys() { return this.registry.keys.filter(key => this.available.has(key)); }
  hasProfile(key) { return this.registry.has(key) && this.available.has(key); }
  usesProfile(key) { return this.enabled && this.hasProfile(key); }
  // A voice prepared in the resident language's view is as ready as one prepared in the English student's (the reply that needs the other model swaps it itself).
  profileReady(key) { return this.loaded && !this.failure && !this.closing && ((this.hasProfile(key) && this.prepared.has(key)) || this.languageView?.prepared.has(key) === true); }
  // The reply language ('fr') of the model that is resident, or null: the language the last turn was in, which stays loaded (no idle timer).
  get residentLanguage() { return this.languageView?.reply ?? null; }
  publish(state, extra = {}) {
    this.state = state;
    try { Promise.resolve(this.onState({version: 1, state, engine: 'pocket-tts', provider: 'pocket',
      device: 'cpu', dtype: 'torch.float32', threads: this.config.cpu.threads, gpuVramBytes: 0,
      resident: this.loaded, bridgePid: process.pid, workerPid: this.child?.pid,
      profiles: this.profileKeys, preparedProfiles: [...this.prepared],
      modelSha256: this.config.model.sha256, inputIdentity: this.config.model.inputIdentity,
      language: this.language, updated: Date.now(), ...extra})).catch(() => {}); } catch {}
  }
  // Stops the worker and everything it started (bridge/worker-process.mjs); the answer is checked there and falls back to killing the handle.
  killWorker(child) { void killProcessTree(child, {real: this.spawnImpl === spawn, setTimer: this.setTimer, clearTimer: this.clearTimer}); }
  timer(task, ms) { const handle = this.setTimer(task, ms); handle?.unref?.(); return handle; }
  send(value) {
    if (!this.child || this.child.stdin.writableEnded) throw Error('Pocket worker input is closed');
    this.child.stdin.write(JSON.stringify({owner: this.owner, ...value}) + '\n', error => { if (error) this.fail(error); });
  }
  // Each phase of a start is logged with the seconds since the start and the attempt (a hang shows where it stopped).
  startLog(message) {
    try { this.onLog(`[PocketStart] +${(((this.now() - (this.startedAt ?? this.now())) / 1000)).toFixed(1)}s attempt ${this.attempt}/${POCKET_LIMITS.startAttempts}: ${message}\n`); } catch {}
  }
  stallLimit(phase) { return this.stallMs ?? POCKET_LIMITS.stallMs[phase] ?? POCKET_LIMITS.stallMs.default; }
  armStall(phase) {
    this.clearTimer(this.stallTimer); this.stallExtended = false;
    this.stallTimer = this.timer(() => this.stalled(phase), this.stallLimit(phase));
  }
  // The worker's heartbeat while it starts (every 2 s, never while it serves): its CPU time so far, the bytes it has read and written and the number of
  // Python modules it has loaded (the last two are wall-clock evidence of life that a wait for a scanner or a disk still shows, and are optional so a worker
  // of the last version beats as before), and `step` after each heavy import. A mark, CPU time that grew by progressCpuMs, I/O that grew by progressIoBytes
  // or one more module since the last progress means the worker is moving (slowly, on a busy machine), so the stall window starts over; a worker whose
  // numbers all stand still is the one that is stuck. Nothing here runs per frame or polls.
  heartbeat(frame) {
    const cpu = frame.cpuMs, io = frame.ioBytes, modules = frame.modules;
    if (!Number.isSafeInteger(cpu) || cpu < 0 || (frame.step !== undefined && !HEARTBEAT_STEPS.includes(frame.step))
        || (io !== undefined && (!Number.isSafeInteger(io) || io < 0)) || (modules !== undefined && (!Number.isSafeInteger(modules) || modules < 0)))
      throw Error('Invalid Pocket worker heartbeat');
    // A late beat of a worker that is being stopped says nothing about its replacement.
    if (this.closing || this.failure || this.loaded || this.restarting || !this.child) return;
    const at = this.now(), cpuText = `worker CPU ${(cpu / 1000).toFixed(1)}s`;
    if (frame.step !== undefined) this.startLog(`imported ${frame.step} (${cpuText})`);
    else if (at - this.noteAt >= POCKET_LIMITS.progressLogMs) { this.noteAt = at; this.startLog(`still ${this.phase || 'starting'} (${cpuText}${modules !== undefined ? `, ${modules} modules` : ''}), not stalled`); }
    const moved = frame.step !== undefined || cpu >= this.progressCpu + POCKET_LIMITS.progressCpuMs
      || (io !== undefined && io >= this.progressIo + POCKET_LIMITS.progressIoBytes) || (modules !== undefined && modules > this.progressModules);
    if (io !== undefined && this.progressIo === 0) this.progressIo = io;
    if (modules !== undefined && this.progressModules === 0) this.progressModules = modules;
    if (moved) {
      this.progressCpu = cpu; this.cpuMs = cpu;
      if (io !== undefined) this.progressIo = io;
      if (modules !== undefined) this.progressModules = modules;
      this.armStall(this.phase);
    }
  }
  // The worker has made no progress for too long: stop it (the whole process tree) and start it once more, then give up.
  stalled(phase) {
    this.stallTimer = null;
    if (this.closing || this.failure || this.loaded || this.restarting || !this.child) return;
    const cpuText = this.cpuMs === undefined ? '' : `, worker CPU ${(this.cpuMs / 1000).toFixed(1)}s`;
    // Nothing moved for the window: one bounded extra wait before the worker is stopped (a scan or a cold disk shows no CPU and can still be working).
    if (!this.stallExtended) {
      this.stallExtended = true;
      const extra = this.stallMs ?? POCKET_LIMITS.stallGraceMs[phase] ?? POCKET_LIMITS.stallGraceMs.default;
      this.startLog(`nothing moved at ${phase || 'start'} for ${Math.round(this.stallLimit(phase) / 1000)}s${cpuText}; waiting ${Math.round(extra / 1000)}s more before stopping the worker`);
      this.stallTimer = this.timer(() => this.stalled(phase), extra);
      return;
    }
    if (this.attempt >= POCKET_LIMITS.startAttempts) {
      this.startLog(`stalled at ${phase || 'start'} again; giving up`);
      this.fail(Error('Pocket student startup stalled')); return;
    }
    this.startLog(`stalled at ${phase || 'start'} for ${Math.round(this.stallLimit(phase) / 1000)}s without progress${cpuText}; stopping the worker to start it once more`);
    this.restarting = true;
    this.clearTimer(this.startTimer); this.startTimer = null;
    const child = this.child;
    try { if (!child.stdin.writableEnded) child.stdin.end(); } catch {}
    this.killWorker(child);
    // The close event starts the new attempt; a worker that cannot be stopped is a failure.
    this.restartTimer = this.timer(() => { if (this.restarting && this.child === child) this.fail(Error('Pocket worker did not stop for its restart')); },
      POCKET_LIMITS.exitMs);
  }
  start() {
    if (this.closing) return Promise.reject(cancelled('Pocket speech is stopping'));
    if (this.failure) return Promise.reject(this.failure);
    if (!this.enabled) { this.publish('disabled'); return Promise.resolve(); }
    if (this.ready) return this.ready;
    this.publish('loading');
    this.ready = new Promise((resolveReady, rejectReady) => Object.assign(this, {resolveReady, rejectReady}));
    this.ready.catch(() => {});
    this.startedAt = this.now();
    this.spawnWorker();
    return this.ready;
  }
  spawnWorker() {
    this.attempt++; this.phase = undefined; this.progressCpu = 0; this.progressIo = 0; this.progressModules = 0; this.cpuMs = undefined; this.noteAt = this.now();
    // A new worker reads the configuration's voices: what a player changed since is sent once it is ready.
    this.registry = this.baseRegistry; this.workerDir = this.baseDir;
    let child;
    try {
      const env = {...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', CUDA_VISIBLE_DEVICES: '-1',
        HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
        TOKENIZERS_PARALLELISM: 'false', OMP_NUM_THREADS: String(this.config.cpu.threads),
        MKL_NUM_THREADS: String(this.config.cpu.threads), OPENBLAS_NUM_THREADS: String(this.config.cpu.threads), ...priorityEnvironment(this.priorityLevel)};
      for (const key of ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'KAGGLE_API_TOKEN']) delete env[key];
      child = this.child = this.spawnImpl(this.pythonExecutable,
        ['-B', resolve(this.project, 'bridge/pocket-voice-worker.py'), '--config', this.configPath, '--owner', this.owner],
        {cwd: this.project, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env});
    } catch (error) { this.fail(error); return; }
    const raised = this.priorityLevel === 'high' ? setProcessPriority(child.pid, 'high', this.setPriority) : null;
    this.startLog(`worker started (pid ${child.pid ?? '?'}${raised === null ? '' : raised ? ', priority high' : ', priority could not be set to high'})`);
    let buffer = '';
    child.stdout.setEncoding('utf8');
    // Both pipes are always drained: a worker that fills an unread pipe would stop in its own write.
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
    // The last of the worker's stderr is the reason it gives when it dies (a Python exception, a Windows fatal exception from faulthandler).
    this.stderrTail = '';
    child.stderr.on('data', part => { const text = part.toString('utf8'); this.stderrTail = (this.stderrTail + text).slice(-6000); try { this.onLog(text.slice(0, 4000)); } catch {} });
    child.stdin.on('error', error => { if (!this.restarting) this.fail(error); }); child.on('error', error => this.fail(error));
    this.exited = new Promise((done, reject) => {
      this.rejectExited = reject;
      child.once('close', code => {
        this.clearTimer(this.startTimer); this.clearTimer(this.exitTimer); this.clearTimer(this.confirmTimer); this.clearTimer(this.retryKillTimer);
        this.clearTimer(this.stallTimer); this.clearTimer(this.restartTimer);
        this.startTimer = this.exitTimer = this.confirmTimer = this.retryKillTimer = this.stallTimer = this.restartTimer = null;
        this.child = null; this.loaded = false; this.prepared.clear(); this.dropLanguage();
        // A worker stopped by the stall watchdog: the same start goes on with a new worker (`ready` stays pending).
        if (this.restarting && !this.closing && !this.failure) {
          this.restarting = false; done();
          this.spawnWorker();
          return;
        }
        const error = this.failure || (this.closing ? cancelled('Pocket speech stopped') : Error(this.exitedMessage(code)));
        this.rejectReady?.(error);
        for (const request of this.pending.values()) this.finishRequest(request, error);
        if (!this.closing) this.failure ||= error;
        this.publish(this.closing ? 'stopped' : 'error'); done();
      });
    });
    this.exited.catch(() => {});
    // The hard bound is for the whole start: a restarted worker gets what is left of it, never a fresh window.
    this.startTimer = this.timer(() => this.fail(Error('Pocket student startup timed out')),
      Math.max(this.attempt > 1 ? POCKET_LIMITS.restartMinMs : 1000, POCKET_LIMITS.startupMs - Math.max(0, this.now() - (this.startedAt ?? this.now()))));
    this.armStall(undefined);
  }
  // "Pocket worker exited (1)", the exit code in words when it is a Windows fault, and the last error line of the worker's stderr.
  exitedMessage(code) {
    const words = describeExitCode(code), reason = stderrReason(this.stderrTail);
    return `Pocket worker exited (${words === String(code) ? code : words})${reason ? `: ${reason}` : ''}`;
  }
  // `view`: the language model's view (this.languageView, or the one a language command is about to install) when the frame answers a request made in it; null is the English student.
  validateProfiles(frame, view = null) {
    const registry = view ? view.registry : this.registry;
    const profiles = frame.profiles, prepared = frame.preparedProfiles;
    const valid = (value, maximum) => Array.isArray(value) && value.length <= maximum && new Set(value).size === value.length
      && value.every(key => registry.has(key));
    if (!valid(profiles, registry.keys.length) || !valid(prepared, this.config.preparation.maxCachedProfiles)
        || prepared.some(key => !profiles.includes(key))) throw Error('Invalid Pocket acoustic profile readiness');
    if (view) { view.available = new Set(profiles); view.prepared = new Set(prepared); }
    else { this.available = new Set(profiles); this.prepared = new Set(prepared); }
  }
  // The worker's answer to a voice change: the voices it now holds, checked against the descriptors that were sent (hashes included).
  receiveVoices(frame, request) {
    if (!['voices', 'error'].includes(frame.op)) throw Error('Unexpected Pocket speech response');
    if (frame.op === 'error') {
      // A refused change leaves the worker as it was.
      this.validateProfiles(frame);
      this.finishRequest(request, Error('Pocket voices could not be changed'));
      return;
    }
    const previous = this.registry;
    this.registry = request.next;
    try {
      this.validateProfiles(frame);
      if (!object(frame.referenceHashes) || Object.keys(frame.referenceHashes).length !== this.available.size
          || [...this.available].some(key => frame.referenceHashes[key] !== this.registry.profiles[key].sha256))
        throw Error('Pocket worker did not confirm the changed reference identities');
    } catch (error) { this.registry = previous; throw error; }
    this.finishRequest(request, null, {changed: Array.isArray(frame.changed) ? frame.changed.filter(key => typeof key === 'string') : []});
  }
  async receive(frame) {
    if (!object(frame) || frame.owner !== this.owner) throw Error('Pocket response owner changed');
    if (frame.op === 'fatal') {
      // The worker says why in a few words (its own check, a missing file, a library that would not load); the log and a report keep them.
      const reason = typeof frame.reason === 'string' ? frame.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300) : '';
      throw Error(`Pocket student runtime is unavailable${reason ? ` (${reason})` : ''}`);
    }
    if (frame.op === 'heartbeat') { this.heartbeat(frame); return; }
    if (frame.op === 'state') {
      if (!['loading', 'warming'].includes(frame.state) || (frame.profile !== undefined && !this.registry.has(frame.profile)))
        throw Error('Invalid Pocket worker state');
      if (frame.phase !== undefined && !['assets-verified','importing-dependencies','loading-student','student-loaded'].includes(frame.phase))
        throw Error('Invalid Pocket startup phase');
      if (!this.closing) {
        this.phase = frame.phase ?? frame.state;
        this.startLog(`phase ${frame.phase ?? frame.state}${frame.profile ? ` (${frame.profile})` : ''}`);
        if (!this.loaded) this.armStall(this.phase);
        this.publish(frame.state, {profile: frame.profile, phase:frame.phase});
      }
      return;
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
      this.clearTimer(this.stallTimer); this.stallTimer = null;
      if (this.closing) { this.confirmExit(); return; }
      this.startLog('ready');
      this.loaded = true; this.publish('ready');
      // Voices a player changed while this worker was loading (or before it started again) are sent now, ahead of any reply; the start is
      // done when they are in (it is not waited for here: this answer is read before the worker's reply to that change).
      if (!this.voicesDiffer()) { this.resolveReady(); return; }
      void this.queueVoices().catch(error => this.startLog(`voice change failed: ${String(error?.message ?? error).slice(0, 120)}`))
        .then(() => this.resolveReady());
      return;
    }
    const request = this.pending.get(frame.id);
    if (request?.kind === 'voices') { this.receiveVoices(frame, request); return; }
    if (request?.kind === 'language') { this.receiveLanguage(frame, request); return; }
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
      // Progress: the time limit starts over with every chunk (a reply is cut for standing still, not for being long).
      this.clearTimer(request.timer);
      request.timer = this.timer(() => this.cancelRequest(request, Error('Pocket speech timed out')), POCKET_LIMITS.renderIdleMs);
      const packet = {version: 1, engine: 'pocket-tts', profile: request.profile, owner: this.owner,
        id: request.id, index: frame.index, sampleRate: 24000, channels: 1, pcm, format: 'f32le',
        offsetFrames: frame.offsetFrames, frames: frame.frames, timebase: 'audio-seconds',
        startSeconds: frame.offsetFrames / 24000, modelSha256: request.view?.model.sha256 ?? this.config.model.sha256,
        timing: {voicePcmYieldMs: frame.yieldMs, voicePcmCopiedReadyMs: frame.copiedReadyMs,
          voicePcmReceivedMs: this.now() - request.started}};
      let sinkTimer;
      try {
        const deadline = new Promise((resolveSink, reject) => {
          sinkTimer = this.timer(() => reject(Error('Pocket PCM consumer timed out')), frame.index === 1 ? POCKET_LIMITS.sinkFirstMs : POCKET_LIMITS.sinkMs);
        });
        await abortable(Promise.race([Promise.resolve().then(() => request.onPcm(packet)), deadline]), request.controller.signal);
        if (!request.cancelReason && !this.failure && !this.closing) this.send({op: 'ack', id: request.id, index: frame.index});
      } catch (error) { this.cancelRequest(request, error); }
      finally { this.clearTimer(sinkTimer); }
      return;
    }
    this.validateProfiles(frame, request.view ?? null);
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
      if (request.kind !== 'prepare' || !(request.view ? request.view.prepared : this.prepared).has(request.profile) || !finite(frame.preparationMs) || frame.preparationMs < 0)
        throw Error('Invalid Pocket reference preparation');
      this.finishRequest(request, null, {provider: 'pocket', ready: request.view ? request.view.prepared.has(request.profile) : this.profileReady(request.profile), profile: request.profile,
        preparationMs: frame.preparationMs, preparationSource: preparationSource(frame)}); return;
    }
    if (request.kind !== 'stream' || frame.frames !== request.frames || frame.chunks !== request.chunks || request.frames < 1
        || frame.sampleRate !== 24000 || frame.channels !== 1 || !(request.view ? request.view.prepared : this.prepared).has(request.profile)
        || frame.firstPcmYieldMs !== request.firstYieldMs || frame.firstPcmCopiedReadyMs !== request.firstReadyMs
        || !finite(frame.preparationMs) || frame.preparationMs < 0 || !finite(frame.generationMs) || frame.generationMs < request.lastReadyMs)
      throw Error('Pocket completion does not match its streamed PCM');
    this.finishRequest(request, null, {provider: 'pocket', engine: 'pocket-tts', sampleRate: 24000, channels: 1,
      frames: request.frames, chunks: request.chunks, duration: request.frames / 24000,
      modelSha256: request.view?.model.sha256 ?? this.config.model.sha256, ...(request.view ? {language: request.view.tag} : {}),
      timing: {voiceProvider: 'pocket', voiceEngine: 'pocket-tts',
        voiceWarm: true, voiceDtype: 'torch.float32', voiceRuntime: 'pytorch', voiceDevice: 'cpu',
        voiceQueueMs: request.started - request.queued, voicePreparationMs: frame.preparationMs,
        voicePreparationSource: preparationSource(frame),
        voiceFirstPcmYieldMs: frame.firstPcmYieldMs, voiceFirstPcmCopiedReadyMs: frame.firstPcmCopiedReadyMs,
        voiceFirstPcmReceivedMs: request.firstReceivedMs, voiceGenerationMs: frame.generationMs,
        voiceRoundTripMs: this.now() - request.started}});
  }
  command(kind, profile, {signal, onPcm, text, queued = this.now(), urgent = false, view = null} = {}) {
    throwIfCancelled(signal);
    if (this.closing || this.failure) return Promise.reject(this.failure || cancelled());
    const id = ++this.sequence, started = this.now();
    return new Promise((resolveFrame, reject) => {
      const request = {id, kind, profile, onPcm, queued, started, frames: 0, chunks: 0, lastReadyMs: 0, view,
        controller: new AbortController(), resolve: resolveFrame, reject};
      this.pending.set(id, request);
      request.cancel = () => this.cancelRequest(request, cancelled());
      request.signal = signal; signal?.addEventListener('abort', request.cancel, {once: true});
      request.timer = this.timer(() => this.cancelRequest(request, Error('Pocket speech timed out')),
        kind === 'prepare' ? POCKET_LIMITS.prepareMs : POCKET_LIMITS.renderMs);
      this.publish(kind === 'prepare' ? 'warming' : 'speaking', {profile});
      // `urgent`: a reply is waiting on this preparation, so the worker runs it at the reply level (high; warming a voice ahead of time stays below normal).
      try { this.send({op: kind, id, profile, ...(text !== undefined ? {text} : {}), ...(this.keepPrepared ? {keep: true} : {}), ...(urgent ? {urgent: true} : {})}); }
      catch (error) { this.fail(error); }
      if (signal?.aborted) request.cancel();
    });
  }
  cancelRequest(request, reason) {
    if (!this.pending.has(request.id) || request.cancelReason) return;
    request.cancelReason = reason; request.controller.abort(reason);
    try { this.send({op: 'cancel', id: request.id}); } catch (error) { this.fail(error); }
    // A stream that has produced no audio yet is still preparing its voice or reading its text, and neither can be interrupted from outside
    // (0.2.4 report: a V line cancelled while the worker was starved of CPU took the worker down at the 2 s deadline, and V stayed silent).
    // It gets the long wait; one that is already generating stops within a step, so it keeps the short one.
    const uninterruptible = request.kind === 'prepare' || (request.kind === 'stream' && request.chunks === 0);
    const first = uninterruptible ? POCKET_LIMITS.prepareCancelMs : POCKET_LIMITS.cancelMs;
    // The worker has not answered yet: say so and keep waiting (the next request waits for it either way). Only then is it stopped.
    request.cancelTimer = this.timer(() => {
      this.startLog(`the worker is still stopping a cancelled ${request.kind} after ${Math.round(first / 1000)}s; waiting up to ${Math.round(POCKET_LIMITS.cancelHardMs / 1000)}s more`);
      request.cancelTimer = this.timer(() => this.fail(Error('Pocket worker did not stop its cancelled request')), POCKET_LIMITS.cancelHardMs);
    }, first);
  }
  finishRequest(request, error, result) {
    if (!this.pending.delete(request.id)) return;
    this.clearTimer(request.timer); this.clearTimer(request.cancelTimer);
    request.signal?.removeEventListener('abort', request.cancel);
    request.controller.abort(error || cancelled('Pocket request completed'));
    if (!this.closing && !this.failure) this.publish('ready');
    if (error) request.reject(error); else request.resolve(result);
  }
  // `pocketLanguage`: {tag, folder, expected, voices: {key: descriptor}} to make that language model the resident one first, or null for the English student. `folder` is the
  // model's (and the voice pack's) folder name, 'es-es', which is how the worker and this client know the language; `tag` ('es') is the reply language the text respelling follows.
  // Returns the view the request is made in (null: English). The English path pays one comparison when no language is resident.
  async ensureLanguage(pocketLanguage, signal, {urgent = false} = {}) {
    const tag = pocketLanguage?.folder ?? null;
    if (tag === null && this.language === null) return null;
    if (tag !== null) {
      const held = this.language === tag ? this.languageView.table : null;
      const wanted = Object.entries(pocketLanguage.voices ?? {});
      if (held && wanted.every(([key, descriptor]) => held[key]?.sha256 === descriptor.sha256 && held[key]?.reference === descriptor.reference)) return this.languageView;
    }
    throwIfCancelled(signal);
    if (this.closing || this.failure) throw this.failure || cancelled();
    const table = tag !== null && this.language === tag ? {...this.languageView.table, ...pocketLanguage.voices} : {...(pocketLanguage?.voices ?? {})};
    // `urgent` on either swap: a reply waits for it (the English one too), so the worker runs it at normal priority.
    await this.languageCommand(tag === null ? {language: null, ...(urgent ? {urgent: true} : {})} : {language: tag, expected: pocketLanguage.expected, voices: pocketLanguage.voices ?? {}, ...(urgent ? {urgent: true} : {})},
      tag === null ? null : {tag, reply: pocketLanguage.tag, table, model: {sha256: pocketLanguage.expected.sha256}});
    return this.languageView;
  }
  languageCommand(payload, next) {
    if (this.closing || this.failure) return Promise.reject(this.failure || cancelled());
    const id = ++this.sequence, started = this.now();
    return new Promise((resolveFrame, reject) => {
      const request = {id, kind: 'language', profile: undefined, next, payload, queued: started, started, frames: 0, chunks: 0, lastReadyMs: 0,
        controller: new AbortController(), resolve: resolveFrame, reject};
      this.pending.set(id, request);
      request.timer = this.timer(() => this.fail(Error('Pocket language change timed out')), POCKET_LIMITS.languageMs);
      this.publish('loading-language', {language: payload.language});
      try { this.send({op: 'language', id, ...payload}); } catch (error) { this.fail(error); }
    });
  }
  // The worker's answer to a language command: the language it now holds and its voices, checked against what was asked (hashes included).
  receiveLanguage(frame, request) {
    if (!['language', 'error'].includes(frame.op)) throw Error('Unexpected Pocket speech response');
    const target = request.payload.language;
    if (frame.op === 'error') {
      // A refused language leaves the worker with the English student (or the language it had, when the files were refused before anything was dropped).
      if (!['string', 'object'].includes(typeof frame.language) && frame.language !== undefined) throw Error('Invalid Pocket language answer');
      const held = frame.language ?? null;
      if (held !== this.language) {
        if (held === null) this.dropLanguage(); else throw Error('Pocket worker holds a language the bridge did not ask for');
      }
      if (held === null) this.validateProfiles(frame); else this.validateProfiles(frame, this.languageView);
      const reason = typeof frame.reason === 'string' ? frame.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '';
      this.finishRequest(request, Object.assign(Error(`PocketTTS model could not be loaded${reason ? ` (${reason})` : ''}`), {pocketLanguage: target, refused: true}));
      return;
    }
    if ((frame.language ?? null) !== target) throw Error('Pocket worker did not confirm the language');
    if (target === null) {
      this.dropLanguage();
      this.validateProfiles(frame);
      this.finishRequest(request, null, {language: null, loadMs: frame.loadMs});
      return;
    }
    const view = {...request.next, registry: registryFromTable(request.next.table, this.config), available: new Set(), prepared: new Set()};
    this.validateProfiles(frame, view);
    if (!object(frame.referenceHashes) || Object.keys(frame.referenceHashes).length !== view.available.size
        || [...view.available].some(key => frame.referenceHashes[key] !== view.registry.profiles[key].sha256))
      throw Error('Pocket worker did not confirm the language voice identities');
    this.language = target; this.languageView = view;
    this.startLog(`language ${target} resident (${Math.round(Number(frame.loadMs) || 0)} ms)`);
    this.finishRequest(request, null, {language: target, loadMs: frame.loadMs});
  }
  dropLanguage() { this.language = null; this.languageView = null; }
  async ensurePrepared(profile, signal, {urgent = false, pocketLanguage = null} = {}) {
    throwIfCancelled(signal); await abortable(this.start(), signal); throwIfCancelled(signal);
    if (this.closing || this.failure) throw this.failure || cancelled();
    const view = await this.ensureLanguage(pocketLanguage, signal, {urgent}); throwIfCancelled(signal);
    if (this.closing || this.failure) throw this.failure || cancelled();
    if (!(view ? view.registry.has(profile) && view.available.has(profile) : this.hasProfile(profile))) throw Error('This character has no available Pocket voice');
    // The worker revalidates the exact source file before a cache hit as well.
    const prepared = await this.command('prepare', profile, {signal, urgent, view}); throwIfCancelled(signal);
    return prepared;
  }
  prepareProfile(profile, {signal, required = false} = {}) {
    if (!this.usesProfile(profile)) return Promise.resolve({provider: 'text', ready: true,
      reason: this.registry.has(profile) ? 'unavailable' : this.registry.status(profile)});
    // A language is resident (the last language stays loaded): an English warm-up must not swap it out and back for every character that comes into view
    // (two model loads for a voice nobody hears). A voice already prepared (English cache or the language view) stays so; any other waits for its first reply, which
    // makes the swap itself. `required`: the caller cannot go on without this voice prepared (an invitation), so it is prepared as before.
    if (this.language && (!required || this.profileReady(profile))) return Promise.resolve({provider: 'pocket', ready: this.profileReady(profile), profile, ...(this.profileReady(profile) ? {} : {deferred: true})});
    const operation = this.tail.then(async () => { const prepared = await this.ensurePrepared(profile, signal);
      return {provider: 'pocket', ready: this.profileReady(profile), profile,
        ...(prepared?.preparationSource ? {preparationMs: prepared.preparationMs, preparationSource: prepared.preparationSource} : {})}; });
    this.tail = operation.catch(() => {}); return abortable(operation, signal);
  }
  /**
   * `pocketLanguage`: {tag, folder, expected, voices: {voiceKey: descriptor}} for a reply in a language the Pocket model of which is installed (bridge/pocket-language-models.mjs):
   * the worker makes that model the resident one (once; a reply in the same language finds it there), the voice is the language pack's clip, and the text gets the
   * respellings the model needs ("Night City"). Without it this is the English student, exactly as before.
   */
  synthesizeStream(profile, text, {signal, onPcm, pocketLanguage} = {}) {
    if (pocketLanguage ? !this.enabled : !this.usesProfile(profile)) return Promise.reject(Error('This character has no available Pocket voice'));
    if (typeof text !== 'string' || !text.trim() || text.length > 12_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
        || typeof onPcm !== 'function') return Promise.reject(Error('Pocket streaming requires valid reply text and a PCM consumer'));
    const spoken = pocketLanguage ? pocketSpokenText(pocketLanguage.tag, text) : text;
    const queued = this.now();
    const operation = this.tail.then(async () => {
      await this.ensurePrepared(profile, signal, {urgent: true, pocketLanguage: pocketLanguage ?? null}); throwIfCancelled(signal);
      return this.command('stream', profile, {text: spoken, signal, onPcm, queued, view: pocketLanguage ? this.languageView : null});
    });
    this.tail = operation.catch(() => {}); return abortable(operation, signal);
  }
  /** Swaps a language model in and prepares one voice of it, ahead of the reply (the turn's language is known before its reply is written). `urgent`: the reply waits for it. */
  prepareLanguage(profile, pocketLanguage, {signal, urgent = false} = {}) {
    if (!pocketLanguage || !this.enabled) return Promise.resolve({provider: 'text', ready: false, reason: 'no-language'});
    const operation = this.tail.then(async () => {
      await this.ensurePrepared(profile, signal, {pocketLanguage, urgent});
      return {provider: 'pocket', ready: this.languageView?.prepared.has(profile) === true, profile, language: pocketLanguage.tag};
    });
    this.tail = operation.catch(() => {}); return abortable(operation, signal);
  }
  // Closing: the worker gets closeGraceMs to leave by itself (its input is closed), then it is stopped (the whole process tree, checked, with
  // the handle as the fallback) and stopped again at killRetryMs; an exit still not seen at exitMs is unconfirmed. recoverExit looks again.
  confirmExit() {
    if (!this.child || this.exitTimer || this.confirmTimer) return;
    const child = this.child;
    this.exitTimer = this.timer(() => {
      this.exitTimer = null; if (this.child !== child) return;
      this.killWorker(child);
      this.retryKillTimer = this.timer(() => { this.retryKillTimer = null; if (this.child === child) this.killWorker(child); }, POCKET_LIMITS.killRetryMs);
      this.confirmTimer = this.timer(() => {
        this.confirmTimer = null; if (this.child !== child) return;
        const error = Error('Pocket worker exit could not be confirmed'); this.failure ||= error;
        this.publish('error'); this.rejectExited?.(error);
      }, POCKET_LIMITS.exitMs);
    }, POCKET_LIMITS.closeGraceMs);
  }
  /**
   * A close whose exit was not confirmed: asks the operating system again whether the process is gone, stopping it once more every few
   * seconds, and resolves true when it is (the replacement may then start), false when it is still running after `timeoutMs`.
   */
  recoverExit({timeoutMs = POCKET_LIMITS.recoverMs, pollMs = 1000, killMs = 10_000} = {}) {
    const child = this.child;
    return recoverExit({child, isAlive: this.isAlive, kill: () => this.killWorker(child), timeoutMs, pollMs, killMs,
      schedule: (task, ms) => this.timer(task, ms),
      onGone: () => { if (this.child === child) { this.child = null; this.loaded = false; this.startLog('the worker is gone (found on a second look)'); } }});
  }
  fail(error) {
    this.failure ||= error; this.clearTimer(this.startTimer); this.startTimer = null;
    this.clearTimer(this.stallTimer); this.stallTimer = null; this.restarting = false;
    this.startLog(`failed: ${String(error?.message ?? error).slice(0, 120)}`);
    this.rejectReady?.(this.failure);
    for (const request of this.pending.values()) this.finishRequest(request, this.failure);
    this.publish('error');
    if (this.child && !this.child.stdin.writableEnded) this.child.stdin.end();
    this.confirmExit();
  }
  close() {
    if (this.closing) return this.closing;
    this.closing = Promise.resolve(); this.rejectReady?.(cancelled('Pocket speech stopped')); this.dropLanguage();
    for (const request of this.pending.values()) this.finishRequest(request, cancelled('Pocket speech stopped'));
    if (!this.child) { this.loaded = false; this.publish('stopped'); return this.closing; }
    this.publish('stopping'); this.child.stdin.end(); this.confirmExit();
    this.closing = this.exited; return this.closing;
  }
}
