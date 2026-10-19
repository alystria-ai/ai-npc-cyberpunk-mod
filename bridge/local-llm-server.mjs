// Supervisor for the fully local conversation option's chat model (docs/LOCAL_OPTION_DESIGN.md).
//
// A `llama-server` child process on loopback (random port, random per-session API key), started on demand, kept
// while the player is talking and stopped after `idleMs` with nobody using it so its VRAM goes back to the game.
// While ready it does nothing at all: no polling, no health pings. Only the (unref'd) idle timer exists.
//
//   const server = new LocalLlmServer({pack: detectLocalAiPack({project}), stateFile});
//   const {endpoint, apiKey, model, tier} = await server.ensure({signal});   // starts it if needed
//   const done = server.begin();  ...stream the reply...  done();              // in-flight requests block the idle stop
//   server.status()   -> {state: 'stopped'|'starting'|'warming'|'ready'|'failed', reason?, tier, model, firstTime?}
//   server.on('failed', ({reason}) => ...)                                     // once per failure episode
//   server.on('model-fallback', ({pin, reason, model}) => ...)                 // the chosen model was missing, did not fit or did not start; `model` (its name) was used instead
//   await server.reselect()                                                    // the model choice changed: reload at an idle moment
//   server.diagnostics()                                                       // what is loaded and how the turns went (model file, family, template, timings); for the log and the support report
//   server.noteTurn({ok, trace, error, detail})                                // the host reports each local turn: kept in diagnostics(), a 'diagnostics' event on a failure and on the first turn after a start
//   await server.stop(); server.killSync();                                    // bridge shutdown / process exit
//
// A server the player already runs (an `endpoint` entry of the custom manifest, bridge/custom-models.mjs; docs/LOCAL_AI.md, "Use your own server") is
// the other kind of model: choosing it starts no llama-server of ours (one that is running is stopped when the choice changes), and ensure() only looks
// at the server once when the model is chosen (GET <endpoint>/models, 4 s at most; then the context from the entry, the listing, /props or 8192), hands out
// its address, key and model id, and then trusts it: no polling, no idle timer, no warm-up. A server that stops answering mid-session is looked at again
// by the next ensure() (externalLost); one that cannot be reached fails like a custom model that did not start (one notice, then the default model, then
// the cloud provider). The embedder (bridge/local-embed.mjs) is separate and unchanged.
//
// `LlamaProcess` (also used by the CPU embedder, bridge/local-embed.mjs) owns one child: the free port, the key
// file, the health check, the output tail and the kill. The key reaches the child through a private temporary file
// (`--api-key-file`), never the command line, and is never logged, in an error message, status() or an event.
import {EventEmitter} from 'node:events';
import {spawn, execFile} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir, freemem, totalmem, setPriority, constants as osConstants} from 'node:os';
import {basename, join} from 'node:path';
import {chooseLocalModel, externalModels, listLocalModels, normalisePin, stillSatisfies} from './local-model-choice.mjs';

const REASON_TEXT = Object.freeze({
  'not-installed': 'the Local AI pack is not installed',
  'low-memory': 'not enough free graphics memory',
  'mature-off': 'only Mature models are installed and Mature content is off',
  'no-gpu': 'no discrete graphics card was found',
  'start-failed': 'the local model server did not start',
  crashed: 'the local model server stopped working',
  stopped: 'the local model server was stopped',
});

export class LocalAiUnavailable extends Error {
  // reason: 'not-installed' | 'low-memory' | 'mature-off' | 'no-gpu' | 'start-failed' | 'crashed' | 'stopped'
  constructor(reason, detail) {
    super('[local:unavailable] ' + (REASON_TEXT[reason] ?? String(reason)) + (detail ? ' (' + detail + ')' : ''));
    this.name = 'LocalAiUnavailable';
    this.code = 'local-unavailable';
    this.reason = reason;
  }
}

export const LOCAL_LLM_LIMITS = Object.freeze({
  standardMinFreeMiB: 3500,    // used when the model file size is unknown
  liteMinFreeMiB: 2000,
  standardHeadroomMiB: 1200,   // free VRAM needed beyond the model file: KV cache, compute buffers, a little spare
  liteHeadroomMiB: 700,
  contextSize: 8192,           // the smallest context the ladder below ends in
  // The context the server is started with, largest first: the first one whose extra KV cache still fits the free VRAM. Measured on the
  // RTX 4080 Laptop (docs/LOCAL_AI.md, "Context size"): going from 8k to 16k costs 136 MiB on Gemma 4 E4B and 264 MiB on Bonsai 2 4B, the lite model (1,581 / 1,713 / 1,845 MiB at 8k / 12k / 16k; the earlier lite model, Qwen3.5-2B, cost 104; f16
  // KV cache; q8_0 saves only another 90 MiB and prefills a third slower), so the largest entry is taken wherever the tier itself fits.
  contextLadder: [16384, 12288, 8192],
  kvMiBPerKToken: {standard: 17, lite: 33},   // KV cache growth per 1,000 tokens of context, f16
  idleMs: 600_000,             // weights leave VRAM after ten idle minutes
  startupMs: 180_000,          // the first start compiles Vulkan shaders (about a minute)
  warmupMs: 240_000,           // one warm-up request, first time included
  maxRestarts: 2,
  externalProbeMs: 4000,       // a server the player runs: the one look at it when its model is chosen (GET /models), and each context question
  externalContext: 8192,       // its context when neither the entry, the listing nor /props says
});

/** The key sent to a server the player runs that needs none (streamChat wants a key of 8 characters; such a server ignores the header). */
export const NO_KEY = 'no-key-needed';

// ---------------------------------------------------------------------------------------------------------------
// What is loaded (for the log and the support report: docs/LOCAL_AI.md, "When a local turn fails")

/** The family of a model for diagnostics: the manifest's own word, else read from the name or file name; null when unknown. */
export function modelFamily({family, name, file} = {}) {
  if (typeof family === 'string' && family.trim()) return family.trim().slice(0, 40);
  const text = String(name ?? '') + ' ' + basename(String(file ?? ''));
  if (/gemma[-_ ]?4/i.test(text)) return 'gemma-4';
  if (/gemma/i.test(text)) return 'gemma';
  if (/qwen|hauhau/i.test(text)) return 'qwen';
  if (/bonsai/i.test(text)) return 'bonsai';
  if (/ministral|mistral/i.test(text)) return 'mistral';
  if (/llama/i.test(text)) return 'llama';
  return null;
}

const oneLine = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);

/** {chars, sha, head} of a chat template (the text llama-server reports in /props): its length, 8 hex digits of its SHA-256 and its first 60 characters; null when there is none. */
export function describeTemplate(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  return {chars: text.length, sha: createHash('sha256').update(text).digest('hex').slice(0, 8), head: oneLine(text, 60)};
}

// The parts of llama-server's GET /props the diagnostics keep. Never the whole template, never a path.
export function describeProps(body) {
  if (!body || typeof body !== 'object') return {};
  const token = value => (typeof value === 'string' && value ? oneLine(value, 40) : null);
  return {template: describeTemplate(body.chat_template), bos: token(body.bos_token), eos: token(body.eos_token),
    build: typeof body.build_info === 'string' ? oneLine(body.build_info, 40) : null, ftype: typeof body.model_ftype === 'string' ? oneLine(body.model_ftype, 20) : null};
}

// The llama-server command line for the chat model. Pure; the key goes in a file, never on the command line.
// `chatTemplate` (a model the player added, bridge/custom-models.mjs) is the name of a llama.cpp built-in template: `--chat-template`.
// `offload` (a Mature model that does not fully fit the free graphics memory, bridge/local-model-choice.mjs): no layer count is given and the fit
// pass is on, so llama-server keeps as many layers on the card as fit and runs the rest on the CPU (the context is given, so it stays).
export function buildServerArgs({model, port, keyFile, device, contextSize = LOCAL_LLM_LIMITS.contextSize, cacheRamMiB = 1024, host = '127.0.0.1', chatTemplate = null, offload = false}) {
  if (!model || !port || !keyFile || !device) throw TypeError('model, port, keyFile and device are required');
  return ['-m', model, ...(offload ? [] : ['-ngl', '99']), '-fa', 'on', '-c', String(contextSize), '-np', '1', '--reasoning', 'off',
    // -fit off: the layers, context and device are all given, so llama-server's fit pass (which loads the model a second time to
    // measure the devices) only costs start time (see bridge/local-embed.mjs).
    '--cache-ram', String(cacheRamMiB), '--ctx-checkpoints', '32', '-fit', offload ? 'on' : 'off', '--device', device, '--no-webui',
    ...(chatTemplate ? ['--chat-template', String(chatTemplate)] : []),
    '--host', host, '--port', String(port), '--api-key-file', keyFile];
}

// ---------------------------------------------------------------------------------------------------------------
// Devices

// Parses `llama-server --list-devices`:
//   Available devices:
//     Vulkan1: NVIDIA GeForce RTX 4080 Laptop GPU (11997 MiB, 11229 MiB free)
export function parseDeviceList(text) {
  const devices = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_]*\d+):\s*(.+?)\s*\((\d+)\s*MiB(?:,\s*(\d+)\s*MiB free)?\)\s*$/.exec(line);
    if (!match) continue;
    devices.push({id: match[1], name: match[2], totalMiB: Number(match[3]), freeMiB: match[4] === undefined ? null : Number(match[4])});
  }
  return devices;
}

// Integrated or software adapters never get the model. Intel Arc cards (A380, A770, B580) are discrete; the "Arc
// Graphics" of recent Intel laptop chips has no model number and is integrated.
export function isIntegratedGpu(name) {
  const text = String(name);
  if (/\bArc\b/i.test(text) && /\b[AB]\d{3}\b/.test(text)) return false;
  return /Intel.*(Graphics|UHD|Iris)|Microsoft|llvmpipe|SwiftShader/i.test(text);
}

// AMD's integrated graphics (the Ryzen APUs) is named "AMD Radeon(TM) Graphics", "AMD Radeon(TM) 780M Graphics" or "Radeon(TM) Vega 8 Graphics": no card model
// (RX, Pro, ...) in it. It shares the computer's memory, so it reports a memory size as large as the system's and would win a "most memory" pick over the
// graphics card of a laptop (an Intel iGPU is skipped for good; this one is only the last resort, because a Ryzen computer with no card may still run a small model on it).
export function isAmdApu(name) {
  const text = String(name);
  return /\bRadeon(?:\(TM\))?\s+(?:(?:Vega\s+\d+|\d{3}M)\s+)?Graphics\b/i.test(text) || /\bRadeon(?:\(TM\))?\s+\d{3}M\b/i.test(text);
}

// The discrete device with the most memory; an AMD APU only when nothing else is there; null when there is no device to use.
export function pickDevice(devices) {
  let best = null, apu = null;
  for (const device of devices) {
    if (isIntegratedGpu(device.name)) continue;
    if (isAmdApu(device.name)) { if (!apu || device.totalMiB > apu.totalMiB) apu = device; continue; }
    if (!best || device.totalMiB > best.totalMiB) best = device;
  }
  return best ?? apu;
}

// The prompt-cache size (MiB of system RAM) from the free system RAM: 4096 from 12 GB free, 2048 from 8 GB, else 1024.
export function defaultCacheRamMiB(freeSystemMiB) {
  if (freeSystemMiB >= 12 * 1024) return 4096;
  if (freeSystemMiB >= 8 * 1024) return 2048;
  return 1024;
}

// Free VRAM a tier needs: its model file plus headroom, or the fixed fallback when the size is unknown.
export const tierNeedMiB = (tier, sizeMiB) => (sizeMiB > 0
  ? Math.ceil(sizeMiB) + (tier === 'standard' ? LOCAL_LLM_LIMITS.standardHeadroomMiB : LOCAL_LLM_LIMITS.liteHeadroomMiB)
  : (tier === 'standard' ? LOCAL_LLM_LIMITS.standardMinFreeMiB : LOCAL_LLM_LIMITS.liteMinFreeMiB));

// Which tier the free VRAM allows. freeMiB null/NaN means unknown: use the smaller model when there is one.
// standardSizeMiB / liteSizeMiB are the model file sizes when known.
export function chooseTier({tier = 'auto', standard, lite, freeMiB, standardSizeMiB, liteSizeMiB} = {}) {
  if (tier === 'standard' || tier === 'lite') {
    if (!(tier === 'standard' ? standard : lite)) throw new LocalAiUnavailable('not-installed', 'no ' + tier + ' model');
    return tier;
  }
  if (!standard && !lite) throw new LocalAiUnavailable('not-installed', 'no model');
  if (!Number.isFinite(freeMiB)) return lite ? 'lite' : 'standard';
  if (standard && freeMiB >= tierNeedMiB('standard', standardSizeMiB)) return 'standard';
  if (lite && freeMiB >= tierNeedMiB('lite', liteSizeMiB)) return 'lite';
  throw new LocalAiUnavailable('low-memory');
}

// The context to start a tier with: the largest of the ladder whose extra KV cache (beyond the 8k the tier's headroom was measured at)
// still fits in `freeMiB` on top of the tier's own need. Unknown free memory takes the largest.
export function chooseContext({tier, freeMiB, sizeMiB, ladder = LOCAL_LLM_LIMITS.contextLadder} = {}) {
  const perK = LOCAL_LLM_LIMITS.kvMiBPerKToken[tier] ?? LOCAL_LLM_LIMITS.kvMiBPerKToken.standard;
  const need = tierNeedMiB(tier, sizeMiB);
  for (const context of ladder) {
    const extra = Math.max(0, (context - LOCAL_LLM_LIMITS.contextSize) / 1024 * perK);
    if (!Number.isFinite(freeMiB) || freeMiB >= need + extra) return context;
  }
  return ladder.at(-1) ?? LOCAL_LLM_LIMITS.contextSize;
}

const defaultFileSizeMiB = file => { try { return statSync(file).size / 1048576; } catch { return 0; } };

const run = (command, args, timeout) => new Promise((resolveRun, rejectRun) => {
  execFile(command, args, {timeout, windowsHide: true, maxBuffer: 1 << 20}, (error, stdout, stderr) => {
    if (error && !stdout && !stderr) rejectRun(error); else resolveRun(String(stdout) + '\n' + String(stderr));
  });
});

async function nvidiaMemoryMiB(field) {
  try {
    const text = await run('nvidia-smi', ['--query-gpu=' + field, '--format=csv,noheader,nounits'], 5000);
    const value = Number.parseInt(text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '', 10);
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}
const nvidiaFreeMiB = () => nvidiaMemoryMiB('memory.free');
/** The graphics card's total memory (MiB) from nvidia-smi, or null (no NVIDIA card, no tool). One short process; the caller asks rarely. */
export const nvidiaTotalMiB = () => nvidiaMemoryMiB('memory.total');

// ---------------------------------------------------------------------------------------------------------------
// One llama-server child

const freePort = () => new Promise((resolvePort, rejectPort) => {
  const probe = createServer();
  probe.unref();
  probe.once('error', rejectPort);
  probe.listen(0, '127.0.0.1', () => { const {port} = probe.address(); probe.close(() => resolvePort(port)); });
});

function startError(code, message) {
  return Object.assign(Error('llama-server ' + message), {code});
}

// One child process. Create a new instance for every start.
//   const proc = new LlamaProcess({command, buildArgs: ({port, keyFile}) => [...]});
//   await proc.start();   -> {port, baseUrl}; rejects with .code 'spawn-failed' | 'exited' | 'timeout' | 'stopped'
//   proc.apiKey / proc.baseUrl / proc.running / proc.pid / proc.tail()
//   proc.on('exit', ({code, signal, expected}) => ...)
//   await proc.stop();  proc.killSync();
// `command` + `argsPrefix` let tests run `node fake-llama-server.mjs ...` instead of an .exe.
export class LlamaProcess extends EventEmitter {
  #key = null; #keyDir = null; #child = null; #port = 0; #startPromise = null;
  #exited = false; #expected = false; #healthy = false; #tail = '';
  #exitPromise; #resolveExit; #settleWait = null;

  constructor({command, argsPrefix = [], buildArgs, spawnImpl = spawn, fetchImpl = fetch, startupMs = LOCAL_LLM_LIMITS.startupMs,
      tmpDir = tmpdir(), setTimer = setTimeout, clearTimer = clearTimeout, log = () => {}, lowerPriority = true, pollMs = 200,
      healthTimeoutMs = 2000, env = {}, tailChars = 6000, findPort = freePort, label = 'llama-server'} = {}) {
    super();
    if (!command || typeof buildArgs !== 'function') throw TypeError('command and buildArgs are required');
    Object.assign(this, {command, argsPrefix, buildArgs, spawnImpl, fetchImpl, startupMs, tmpDir, setTimer, clearTimer, log,
      lowerPriority, pollMs, healthTimeoutMs, env, tailChars, findPort, label});
    this.#exitPromise = new Promise(resolveExit => { this.#resolveExit = resolveExit; });
  }

  get apiKey() { return this.#key; }
  get port() { return this.#port; }
  get baseUrl() { return this.#port ? 'http://127.0.0.1:' + this.#port : null; }
  get pid() { return this.#child?.pid ?? null; }
  get alive() { return Boolean(this.#child) && !this.#exited; }
  get running() { return this.alive && this.#healthy; }
  get exited() { return this.#exited; }

  // The last few KB of the child's output, for diagnostics only. The key is redacted.
  tail() { return this.#redact(this.#tail); }

  start() { return (this.#startPromise ??= this.#start()); }

  async #start() {
    let child;
    let port;
    try {
      this.#key = randomBytes(32).toString('hex');
      port = await this.findPort();
      if (this.#expected) throw startError('stopped', 'start cancelled');
      this.#keyDir = mkdtempSync(join(this.tmpDir, 'convai-llama-'));
      const keyFile = join(this.#keyDir, 'api-key');
      writeFileSync(keyFile, this.#key + '\n', {mode: 0o600, flag: 'wx'});
      const args = [...this.argsPrefix, ...this.buildArgs({port, keyFile})];
      child = this.spawnImpl(this.command, args, {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: {...process.env, ...this.env}});
    } catch (error) {
      this.#removeKey();
      throw error?.code === 'stopped' ? error : startError('spawn-failed', 'could not be started (' + (error?.code || error?.message || 'error') + ')');
    }
    this.#child = child;
    try { if (this.lowerPriority && child.pid) setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding?.('utf8');
      stream?.on('data', text => this.#append(text));   // always drained, or a chatty child blocks
    }
    child.once('error', error => {
      // A failed spawn (missing exe) reports only this. Anything else is just logged.
      if (child.pid === undefined) this.#markExited(null, 'spawn-failed', 'could not be started (' + (error?.code || 'error') + ')');
      else this.log('[local] ' + this.label + ' process error: ' + (error?.code || 'error'));
    });
    child.once('exit', (code, signal) => this.#markExited(code, signal));

    const outcome = await new Promise(resolveWait => {
      let finished = false;
      let deadline = null;
      let pollTimer = null;
      const finish = value => {
        if (finished) return;
        finished = true; this.#settleWait = null;
        this.clearTimer(deadline); this.clearTimer(pollTimer);
        resolveWait(value);
      };
      this.#settleWait = finish;
      deadline = this.setTimer(() => finish({ok: false, code: 'timeout', message: 'did not become healthy in time'}), this.startupMs);
      const poll = async () => {
        if (finished) return;
        const ok = await this.#probe(port);
        if (ok) finish({ok: true});
        else if (!finished) { pollTimer = this.setTimer(poll, this.pollMs); pollTimer?.unref?.(); }
      };
      if (this.#exited) finish({ok: false, code: 'exited', message: 'exited before it was ready'});
      else poll();
    });
    if (!outcome.ok) {
      const cancelled = this.#expected && outcome.code === 'exited';
      await this.stop();
      throw startError(cancelled ? 'stopped' : outcome.code, outcome.message);
    }
    this.#port = port;
    this.#healthy = true;
    this.#removeKey();   // the child has read it
    return {port, baseUrl: this.baseUrl};
  }

  async #probe(port) {
    try {
      const response = await this.fetchImpl('http://127.0.0.1:' + port + '/health',
        {headers: {authorization: 'Bearer ' + this.#key}, signal: AbortSignal.timeout(this.healthTimeoutMs)});
      await response.arrayBuffer?.().catch(() => {});
      return response.status === 200;
    } catch { return false; }
  }

  #markExited(code, signal, message) {
    if (this.#exited) return;
    this.#exited = true; this.#healthy = false;
    this.#removeKey();
    this.#resolveExit(true);
    this.#settleWait?.({ok: false, code: signal === 'spawn-failed' ? 'spawn-failed' : 'exited',
      message: message || 'exited (' + (code ?? signal) + ') before it was ready'});
    this.emit('exit', {code, signal: signal === 'spawn-failed' ? null : signal, expected: this.#expected});
  }

  #append(text) {
    this.#tail = (this.#tail + text).slice(-this.tailChars);
  }
  #redact(text) { return this.#key ? text.split(this.#key).join('[redacted]') : text; }

  #removeKey() {
    const directory = this.#keyDir; this.#keyDir = null;
    if (directory) try { rmSync(directory, {recursive: true, force: true}); } catch { /* best effort */ }
  }

  // Resolves true when the child has exited (immediately if it already has), false after `ms`.
  waitForExit(ms) {
    if (this.#exited || !this.#child) return Promise.resolve(true);
    return new Promise(resolveWait => {
      const timer = this.setTimer(() => resolveWait(false), ms);
      timer?.unref?.();
      this.#exitPromise.then(() => { this.clearTimer(timer); resolveWait(true); });
    });
  }

  // Ends the child (and any start in progress). Idempotent.
  async stop() {
    this.#expected = true;
    this.#healthy = false;
    const child = this.#child;
    if (!child || this.#exited) { this.#removeKey(); this.#settleWait?.({ok: false, code: 'exited', message: 'stopped'}); return; }
    try { child.kill(); } catch { /* already gone */ }
    if (!await this.waitForExit(2000)) {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      await this.waitForExit(2000);
    }
    this.#removeKey();
  }

  // For process exit handlers: no awaiting.
  killSync() {
    this.#expected = true;
    this.#healthy = false;
    try { if (this.#child && !this.#exited) this.#child.kill(); } catch { /* gone */ }
    this.#removeKey();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Warm-up helpers

const FILLER_SENTENCE = 'The quick brown fox jumps over the lazy dog near the old river bank while night rain falls on the city. ';
// About `tokens` tokens of ordinary English (4 characters per token).
export function fillerText(tokens) {
  const length = Math.max(0, Math.round(tokens)) * 4;
  return FILLER_SENTENCE.repeat(Math.ceil(length / FILLER_SENTENCE.length) || 0).slice(0, length);
}
export const warmupMessages = tokens => [{role: 'system', content: 'You are a helpful assistant.'},
  {role: 'user', content: tokens > 0 ? fillerText(tokens) : 'Hi.'}];
export const WARMUP_TOKENS = Object.freeze([512, 2048, 0]);   // the bridge's batch shapes, then a short request

const delay = (setTimer, clearTimer, ms, signal) => new Promise((resolveDelay, rejectDelay) => {
  const timer = setTimer(resolveDelay, ms);
  signal?.addEventListener('abort', () => { clearTimer(timer); rejectDelay(signal.reason); }, {once: true});
});

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolveRace, rejectRace) => {
    const onAbort = () => rejectRace(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, {once: true});
    promise.then(value => { signal.removeEventListener('abort', onAbort); resolveRace(value); },
      error => { signal.removeEventListener('abort', onAbort); rejectRace(error); });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The supervisor

export class LocalLlmServer extends EventEmitter {
  #state = 'stopped'; #reason = null; #tier = null; #model = null; #firstTime = false;
  #proc = null; #info = null; #starting = null; #generation = 0; #inflight = 0; #idleTimer = null;
  #keyNoted = false; #warmed = new Set(); #contextSize = 0; #modelId = null; #reselectPending = false; #hints = null; #totalMiB = null; #lastFreeMiB = null; #failedPin = null; #broken = new Map();
  #loaded = null; #lastExit = null; #lastTurn = null; #turns = {ok: 0, failed: 0, sinceStart: 0};

  // command/argsPrefix replace pack.server when spawning (tests); processOptions go to LlamaProcess (tests).
  // contextSize: a fixed context (tests, CYBERPUNK_CONVAI_LOCAL_CTX); without it each start takes the ladder's largest that fits.
  // selection: () => {pin, matureOn, matureModels}, read at each start and each reselect (the player's model choice, bridge/local-model-choice.mjs).
  // tier ('standard' | 'lite') is the older, stricter form of a pin: that tier or an error, no memory check.
  constructor({pack, tier = 'auto', selection, contextSize, spawnImpl = spawn, fetchImpl = fetch, listDevices,
      freeVramMiB = nvidiaFreeMiB, idleMs = LOCAL_LLM_LIMITS.idleMs, startupMs = LOCAL_LLM_LIMITS.startupMs, warmup = true,
      warmupMs = LOCAL_LLM_LIMITS.warmupMs, stateFile, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
      log = () => {}, maxRestarts = LOCAL_LLM_LIMITS.maxRestarts, backoffMs = 750, cacheRamMiB, freeMemMiB = () => freemem() / 1048576,
      beforeStart, beforeStartMs = 120_000, fileSizeMiB = defaultFileSizeMiB, environment = process.env, command, argsPrefix = [], processOptions = {},
      externalProbeMs = LOCAL_LLM_LIMITS.externalProbeMs} = {}) {
    super();
    const fixedContext = Number.parseInt(contextSize ?? environment.CYBERPUNK_CONVAI_LOCAL_CTX ?? '', 10);
    Object.assign(this, {pack, tierSetting: tier, selection, contextSize: Number.isFinite(fixedContext) && fixedContext >= 2048 ? fixedContext : null, spawnImpl, fetchImpl, freeVramMiB, idleMs, startupMs, warmup,
      warmupMs, stateFile, now, setTimer, clearTimer, log, maxRestarts, backoffMs, argsPrefix, processOptions, freeMemMiB,
      beforeStart, beforeStartMs, fileSizeMiB, externalProbeMs});
    const configured = Number.parseInt(cacheRamMiB ?? environment.CYBERPUNK_CONVAI_LOCAL_CACHE_RAM ?? '', 10);
    this.cacheRamMiB = Number.isFinite(configured) && configured >= 0 ? configured : null;   // null: chosen at each start
    this.command = command ?? pack?.server;
    this.listDevices = listDevices ?? (() => run(this.command, [...this.argsPrefix, '--list-devices'], 30_000));
  }

  status() {
    const status = {state: this.#state, tier: this.#tier, model: this.#model};
    if (this.#contextSize && (this.#state === 'ready' || this.#state === 'warming')) status.contextSize = this.#contextSize;
    if (this.#reason) status.reason = this.#reason;
    if (this.#firstTime) status.firstTime = true;
    if (this.#info?.external && this.#state === 'ready') status.external = true;
    return status;
  }

  #setState(state, reason = null) {
    if (this.#state === state && this.#reason === reason) return;
    this.#state = state; this.#reason = reason;
    this.emit('state', this.status());
  }

  // contextSize: the server's own n_ctx per slot (read from /props once it is up), so a prompt is fitted to what is really there.
  // A server the player runs also gets `requestModel` (the id its requests ask for) and `trustedOrigin` (the only origin its key may go to).
  #handle() {
    const info = this.#info;
    return {endpoint: info.endpoint, apiKey: info.apiKey, model: this.#model, tier: this.#tier, contextSize: info.contextSize,
      ...(info.external ? {external: true, requestModel: info.requestModel, trustedOrigin: info.trustedOrigin} : {})};
  }

  // Starts the server if needed; resolves when it is ready. Concurrent callers share one start.
  async ensure({signal} = {}) {
    signal?.throwIfAborted();
    if (this.#state === 'failed') throw new LocalAiUnavailable(this.#reason);
    if (this.#state === 'ready' && (this.#proc?.running || this.#info?.external)) { this.touch(); return this.#handle(); }
    if (!this.#starting) this.#launch(false);
    const handle = await abortable(this.#starting, signal);
    this.touch();
    return handle;
  }

  #launch(recovering) {
    const promise = this.#bringUp(recovering).then(
      handle => { if (this.#starting === promise) this.#starting = null; return handle; },
      error => {
        if (this.#starting === promise) this.#starting = null;
        if (error instanceof LocalAiUnavailable && error.reason !== 'stopped') this.#fail(error.reason);
        throw error;
      });
    this.#starting = promise;
    promise.catch(() => {});
    return promise;
  }

  // One failure episode: state 'failed', one 'failed' event, ensure() throws until reset().
  #fail(reason) {
    if (this.#state === 'failed') return;
    this.#disarm();
    const proc = this.#proc; this.#proc = null; this.#info = null;
    this.#setState('failed', reason);
    if (proc) proc.stop().catch(() => {});
    this.log('[local] the local model server is unavailable (' + reason + ')');
    this.emit('failed', {reason});
  }

  // Clears a failure so the next ensure() tries again (the settings screen / a new session).
  reset() {
    this.#broken.clear();   // a custom model that failed to start gets another chance
    if (this.#state !== 'failed') return;
    this.#reason = null; this.#state = 'stopped';
    this.emit('state', this.status());
  }

  async #bringUp(recovering) {
    // `remaining` counts the starts still allowed: one for a plain start, maxRestarts when recovering from a crash.
    let remaining = recovering ? this.maxRestarts : 1;
    let attempt = 0;
    if (recovering && remaining <= 0) throw new LocalAiUnavailable('crashed');
    for (;;) {
      try {
        return await this.#startOnce();
      } catch (error) {
        const known = error instanceof LocalAiUnavailable;
        if (!known) throw new LocalAiUnavailable('start-failed', error?.message);
        if (error.reason !== 'start-failed' && error.reason !== 'crashed') throw error;
        // A start that dies while warming up is a crash: the failed attempt is not a restart.
        if (error.reason === 'crashed' && !recovering) { recovering = true; remaining = this.maxRestarts + 1; }
        remaining--; attempt++;
        if (remaining <= 0) throw recovering ? new LocalAiUnavailable('crashed') : error;
        this.log('[local] restarting the local model server (attempt ' + attempt + ')');
        const generation = this.#generation;
        await delay(this.setTimer, this.clearTimer, this.backoffMs * attempt);
        if (generation !== this.#generation) throw new LocalAiUnavailable('stopped');
      }
    }
  }

  #guard(generation) {
    if (generation !== this.#generation) throw new LocalAiUnavailable('stopped');
  }

  // The host may hold the start back (the bridge waits while OmniVoice is loading) so the free VRAM read next is what Omni leaves.
  async #waitBeforeStart() {
    if (typeof this.beforeStart !== 'function') return;
    let timer = null;
    try {
      await Promise.race([Promise.resolve(this.beforeStart()), new Promise(resolveWait => { timer = this.setTimer(resolveWait, this.beforeStartMs); timer?.unref?.(); })]);
    } catch (error) { this.log('[local] start hook failed: ' + (error?.message || 'error')); }
    finally { if (timer) this.clearTimer(timer); }
  }

  async #selectDevice() {
    let devices;
    try {
      const listing = await this.listDevices();
      devices = Array.isArray(listing) ? listing : parseDeviceList(listing);
    } catch (error) {
      throw new LocalAiUnavailable('start-failed', 'could not list the graphics devices');
    }
    const device = pickDevice(devices);
    // Which cards the computer has and which one was taken: a model that "loads but never answers" on the wrong adapter is slow, not broken.
    this.log('[local] graphics devices: ' + (devices.map(item => `${item.id} ${String(item.name).slice(0, 60)} (${item.totalMiB} MiB${isIntegratedGpu(item.name) ? ', integrated: not used' : isAmdApu(item.name) ? ', integrated AMD: last resort' : ''})`).join('; ') || 'none')
      + (device ? '; using ' + device.id : '; none usable'));
    if (!device) throw new LocalAiUnavailable('no-gpu');
    let freeMiB = Number.isFinite(device.freeMiB) ? device.freeMiB : null;
    if (/NVIDIA/i.test(device.name)) {
      let smi = null;
      try { smi = await this.freeVramMiB(); } catch { /* ignored */ }
      if (Number.isFinite(smi)) freeMiB = freeMiB === null ? smi : Math.min(freeMiB, smi);
    }
    this.#totalMiB = Number.isFinite(device.totalMiB) ? device.totalMiB : this.#totalMiB;
    return {device, freeMiB};
  }

  // The model to load now: the player's choice (this.selection), else the older `tier` option, else the default (the largest that fits).
  // A chosen model that is missing or does not fit is replaced by the default, and one 'model-fallback' event names the model used.
  #choose(pack, freeMiB, selected = this.#selected(pack)) {
    this.#lastFreeMiB = Number.isFinite(freeMiB) ? freeMiB : null;
    const sizeOf = file => this.fileSizeMiB(file);
    if (this.tierSetting === 'standard' || this.tierSetting === 'lite') {
      const forced = selected.models.find(model => model.id === this.tierSetting);
      if (!forced) throw new LocalAiUnavailable('not-installed', 'no ' + this.tierSetting + ' model');
      return {model: forced, sizeMiB: Number(sizeOf(forced.file)) || 0, profile: forced.tier, pinned: true, fellBack: null};
    }
    const choice = chooseLocalModel({models: selected.models, pin: selected.pin, matureOn: selected.matureOn, freeMiB, totalMiB: this.#totalMiB, sizeOf});
    this.#announce(choice, selected);
    return choice;
  }

  // A model that did not start is announced with the retry (#startOnce, which knows the model used instead); the other reasons here.
  #announce(choice, selected) {
    if (choice.fellBack && choice.fellBack !== 'start-failed') {
      this.log('[local] the chosen model is not usable (' + choice.fellBack + '): ' + choice.model.name + ' was chosen instead');
      this.emit('model-fallback', {pin: selected.pin, reason: choice.fellBack, model: choice.model.name});
    }
    if (choice.offload) this.log('[local] ' + choice.model.name + ' does not fit the free graphics memory: it is loaded with part of its layers on the CPU (Mature content never uses a censored model)');
  }

  // The models to choose from now. Without an installed pack there is no llama-server of ours, so only the servers the player runs can answer.
  // A custom model that failed to start (until its file changes or reset()) is marked broken.
  #selected(pack) {
    let picked = null;
    try { picked = typeof this.selection === 'function' ? this.selection() : null; } catch { /* a broken hook means no choice */ }
    let models = listLocalModels({pack, matureModels: picked?.matureModels, customModels: picked?.customModels});
    if (!pack?.installed) models = externalModels(models);
    for (const model of models) if (model.custom && this.#broken.get(model.id) === this.#sizeKey(model)) model.broken = true;
    return {models, pin: normalisePin(picked?.pin), matureOn: picked?.matureOn === true};
  }

  // Is the choice a server the player runs? Decided without the graphics card (such a server uses none of ours): a pinned server, or one
  // that is the last resort of its group. Null when a file model is chosen (the normal start decides which, with the card's numbers).
  #externalChoice(selected) {
    if (this.tierSetting === 'standard' || this.tierSetting === 'lite') return null;
    if (!externalModels(selected.models).length) return null;
    try {
      const choice = chooseLocalModel({models: selected.models, pin: selected.pin, matureOn: selected.matureOn, freeMiB: null, totalMiB: this.#totalMiB, sizeOf: file => this.fileSizeMiB(file)});
      return choice.model.external === true ? choice : null;
    } catch { return null; }
  }

  /** The id of the model that is loaded or loading (null when none): 'standard', 'lite', 'mature:...' or 'custom:...'. */
  get modelId() { return this.#modelId; }

  /** {uncensored, family} from the manifest of the loaded model when it is one the player added (bridge/custom-models.mjs), else null. */
  get modelHints() { return this.#hints; }

  /** The free graphics memory (MiB) the last choice of a model saw (before that model was loaded), or null before any start. */
  get lastFreeMiB() { return this.#lastFreeMiB; }

  /** The total memory (MiB) of the graphics card the last start used, or null before any start. */
  get totalVramMiB() { return this.#totalMiB; }

  #sizeKey(model) { return model.external ? model.endpoint + '|' + (model.requestModel ?? '') : model.file + '|' + Math.round(Number(this.fileSizeMiB(model.file)) || 0); }

  // A model the player added did not start (or died while warming up): it is left out until its file changes or reset(), the player is told
  // once (the retry's 'model-fallback', the same notice as a missing chosen model, naming the model it then uses) and the start is tried
  // again with what the default rule chooses now.
  #modelFailed(model, why) {
    this.#broken.set(model.id, this.#sizeKey(model));
    this.#failedPin = model.id;
    this.log(model.external ? '[local] the server of the model "' + model.name + '" cannot be used (' + why + '): the default model is chosen instead'
      : '[local] the custom model "' + model.name + '" did not start (' + why + '): the default model is chosen instead');
  }

  /**
   * The player's model choice changed (bridge/local-model-choice.mjs). Nothing happens unless a model is loaded or loading and it does not
   * already satisfy the new choice. Then the server is stopped (its graphics memory is freed) and started again with the new choice, at an
   * idle moment: never while a reply is in flight (the reload waits for `end()`), and never when the server is not running (the next start
   * reads the new choice itself). Returns whether a reload was done or queued.
   */
  async reselect() {
    if (this.#state !== 'ready' && this.#state !== 'warming' && this.#state !== 'starting') return false;
    if (this.tierSetting === 'standard' || this.tierSetting === 'lite') return false;
    this.#reselectPending = true;
    return this.#reloadIfIdle();
  }

  // Reloads when a reselect is pending, the loaded model no longer satisfies the choice, the server is ready and no reply is in flight. While
  // it is starting or warming up (a turn may be waiting for it, and a stop would refuse that turn) the check is repeated once it is ready.
  async #reloadIfIdle() {
    if (!this.#reselectPending || this.#inflight > 0 || this.#state !== 'ready') return false;
    const selected = this.#selected(this.pack);
    if (stillSatisfies({loadedId: this.#modelId, models: selected.models, pin: selected.pin, matureOn: selected.matureOn})) { this.#reselectPending = false; return false; }
    this.#reselectPending = false;
    this.log('[local] the model choice changed: reloading');
    await this.stop();
    void this.ensure({background: true}).catch(() => {});
    return true;
  }

  async #startOnce() {
    const generation = this.#generation;
    const pack = this.pack;
    const selected = this.#selected(pack);
    const early = this.#externalChoice(selected);
    // No pack and no server of the player's to use: not installed. A server that was tried and failed is that server's failure; one marked uncensored is
    // not the default while Mature content is off (it runs when it is chosen in the row, or once Mature content is on: clearLocalFailure('mature-off')).
    if (!early && !pack?.installed) {
      if (!selected.models.length) throw new LocalAiUnavailable('not-installed');
      throw selected.models.some(model => model.broken) ? new LocalAiUnavailable('start-failed', 'the server you added did not answer')
        : new LocalAiUnavailable('mature-off', 'the server you added is marked uncensored: choose it in the Local AI model row, or turn Mature content on');
    }
    this.#setState('starting');
    const failedPin = this.#failedPin; this.#failedPin = null;
    if (early) { this.#announce(early, selected); return this.#startExternal(early.model, failedPin, generation); }
    await this.#waitBeforeStart();
    this.#guard(generation);
    const {device, freeMiB} = await this.#selectDevice();
    this.#guard(generation);
    const choice = this.#choose(pack, freeMiB, selected);
    // With the card's numbers a file model turned out too large for it, and a server the player runs is the last resort: use it.
    if (choice.model.external === true) return this.#startExternal(choice.model, failedPin, generation);
    if (failedPin) this.emit('model-fallback', {pin: failedPin, reason: 'start-failed', model: choice.model.name});
    const tierKey = choice.profile, tier = choice.model;
    const contextSize = tier.contextSize ?? this.contextSize ?? chooseContext({tier: tierKey, freeMiB, sizeMiB: choice.sizeMiB});
    this.#tier = tierKey; this.#model = tier.loadedName ?? tier.name; this.#modelId = tier.id; this.#contextSize = contextSize;
    this.#hints = tier.custom ? {uncensored: tier.uncensored === true, family: tier.family ?? null} : null;
    const cacheRamMiB = this.cacheRamMiB ?? defaultCacheRamMiB(Number(this.freeMemMiB()));
    const signature = this.#signature(tier.file);
    this.#loadWarmed();
    this.#firstTime = this.warmup && !this.#warmed.has(signature);
    this.#emitStatus();

    this.#loaded = {id: tier.id, name: tier.loadedName ?? tier.name, file: basename(String(tier.file)), family: modelFamily({family: tier.family, name: tier.name, file: tier.file}),
      tier: tierKey, sizeMiB: Math.round(Number(choice.sizeMiB) || 0), device: {id: device.id, name: device.name, freeMiB: Number.isFinite(freeMiB) ? Math.round(freeMiB) : null},
      contextSize, cacheRamMiB, ram: {freeMiB: Math.round(Number(this.freeMemMiB())) || null, totalMiB: Math.round(totalmem() / 1048576)}, offload: choice.offload === true, custom: tier.custom === true, templateFlag: tier.chatTemplate ? String(tier.chatTemplate) : null,
      template: null, bos: null, eos: null, build: null, ftype: null, loadMs: null, warmMs: null, firstTime: this.#firstTime, readyAt: null};
    this.#turns.sinceStart = 0;
    const began = this.now();
    const proc = new LlamaProcess({command: this.command, argsPrefix: this.argsPrefix, spawnImpl: this.spawnImpl, fetchImpl: this.fetchImpl,
      startupMs: this.startupMs, log: this.log, label: 'llama-server',
      buildArgs: ({port, keyFile}) => buildServerArgs({model: tier.file, port, keyFile, device: device.id, contextSize, cacheRamMiB, chatTemplate: tier.chatTemplate, offload: choice.offload === true}),
      ...this.processOptions});
    this.#proc = proc;
    proc.on('exit', info => this.#onExit(proc, info));
    try {
      await proc.start();
    } catch (error) {
      if (this.#proc === proc) this.#proc = null;
      await proc.stop();
      this.#guard(generation);
      this.log('[local] llama-server did not start: ' + (error?.code || error?.message) + ' (' + this.#loaded.file + ', context ' + contextSize + ')');
      this.#logTail(proc, 'it did not start');
      if (tier.custom && error?.code !== 'stopped') { this.#modelFailed(tier, error?.code || 'error'); return this.#startOnce(); }
      throw new LocalAiUnavailable('start-failed', error?.code);
    }
    this.#guard(generation);
    const props = await this.#readProps(proc, contextSize);
    const serverContext = props.contextSize;
    this.#guard(generation);
    this.#info = {endpoint: proc.baseUrl + '/v1/chat/completions', base: proc.baseUrl, apiKey: proc.apiKey, contextSize: serverContext};
    this.#contextSize = serverContext;
    Object.assign(this.#loaded, {contextSize: serverContext, template: props.template ?? null, bos: props.bos ?? null, eos: props.eos ?? null, build: props.build ?? null,
      ftype: props.ftype ?? null, loadMs: this.now() - began});
    this.#setState('warming');

    if (this.warmup) {
      const warmBegan = this.now();
      const warmed = await this.#warmUp(proc, generation, this.#firstTime);
      this.#loaded.warmMs = this.now() - warmBegan;
      if (warmed && this.#firstTime) this.#saveWarmed(signature);
    }
    this.#guard(generation);
    if (!proc.running) {
      if (this.#proc === proc) this.#proc = null;
      await proc.stop();
      this.#logTail(proc, 'it stopped while warming up');
      if (tier.custom) { this.#modelFailed(tier, 'stopped while warming up'); return this.#startOnce(); }
      throw new LocalAiUnavailable('crashed');
    }
    this.#loaded.readyAt = this.now();
    this.#setState('ready');
    this.#arm();
    this.log('[local] model ready: ' + this.#describeLoaded());
    this.emit('diagnostics', this.diagnostics());
    // A choice that changed while it was loading is checked a moment later, after the turn that waited for it has marked itself in flight.
    if (this.#reselectPending) { const timer = this.setTimer(() => { void this.#reloadIfIdle(); }, 250); timer?.unref?.(); }
    return this.#handle();
  }

  // A server the player runs is the model: no process of ours. Look at it once (reachable? which model id? how big a context?), then trust it.
  async #startExternal(model, failedPin, generation) {
    if (failedPin) this.emit('model-fallback', {pin: failedPin, reason: 'start-failed', model: model.name});
    this.#tier = null; this.#model = model.loadedName ?? model.name; this.#modelId = model.id; this.#contextSize = model.contextSize ?? 0;
    this.#loaded = {id: model.id, name: model.loadedName ?? model.name, file: null, family: modelFamily({family: model.family, name: model.name}), tier: null, sizeMiB: 0, device: null,
      contextSize: model.contextSize ?? 0, cacheRamMiB: null, offload: false, custom: true, external: true, templateFlag: null, template: null, bos: null, eos: null, build: null, ftype: null,
      loadMs: null, warmMs: null, firstTime: false, readyAt: null};
    this.#turns.sinceStart = 0;
    this.#hints = {uncensored: model.uncensored === true, family: model.family ?? null};
    this.#firstTime = false;
    this.#keyNoted = false;
    this.#emitStatus();
    let found;
    try { found = await this.#lookAtServer(model); } catch (error) {
      this.#guard(generation);
      this.log('[local] the server of "' + model.name + '" did not answer: ' + (error?.message || 'error'));
      this.#modelFailed(model, error?.code || 'unreachable');
      return this.#startOnce();
    }
    this.#guard(generation);
    this.#info = {endpoint: model.endpoint + '/chat/completions', base: model.endpoint, apiKey: model.apiKey || NO_KEY, contextSize: found.contextSize,
      external: true, remote: model.remote === true, requestModel: found.requestModel, trustedOrigin: model.origin};
    this.#contextSize = found.contextSize;
    this.#setState('ready');   // no warm-up and no idle timer: nothing of ours is loaded
    if (this.#reselectPending) { const timer = this.setTimer(() => { void this.#reloadIfIdle(); }, 250); timer?.unref?.(); }
    return this.#handle();
  }

  // GET <endpoint>/models (a short timeout): the one reachability check. Resolves {requestModel, contextSize}; rejects with a plain message (no address, no key).
  async #lookAtServer(model) {
    const headers = {accept: 'application/json', ...(model.apiKey ? {authorization: 'Bearer ' + model.apiKey} : {})};
    const get = async url => {
      const response = await this.fetchImpl(url, {headers, signal: AbortSignal.timeout(this.externalProbeMs)});
      let body = null;
      try { body = response.ok ? await response.json() : (await response.arrayBuffer?.(), null); } catch { /* not JSON */ }
      return {status: response.status, ok: response.ok, body};
    };
    const fail = (code, message) => Object.assign(Error(message), {code});
    let listing;
    try { listing = await get(model.endpoint + '/models'); } catch (error) {
      throw fail('unreachable', 'could not be reached (' + String(error?.cause?.code ?? error?.name ?? 'error').slice(0, 40) + ')');
    }
    if (listing.status === 401 || listing.status === 403) throw fail('key-refused', 'the server did not accept the API key');
    if (!listing.ok) throw fail('bad-address', 'the server answered HTTP ' + listing.status + ' at /models (the address usually ends in /v1)');
    const listed = Array.isArray(listing.body?.data) ? listing.body.data.filter(item => typeof item?.id === 'string') : [];
    const requestModel = model.requestModel ?? (listed.length === 1 ? listed[0].id : 'local');
    const usable = value => { const number = Number(value); return Number.isFinite(number) && number >= 512 ? Math.floor(number) : null; };
    let contextSize = model.contextSize;
    if (!contextSize) {
      const row = listed.find(item => item.id === requestModel) ?? (listed.length === 1 ? listed[0] : null);
      contextSize = usable(row?.context_length) ?? usable(row?.max_context_length) ?? usable(row?.loaded_context_length) ?? usable(row?.n_ctx) ?? usable(row?.meta?.n_ctx) ?? null;
    }
    if (!contextSize) {
      // llama.cpp: GET /props at the server's root; KoboldCpp: GET /api/extra/true_max_context_length. Both at once, whatever fails is skipped.
      const root = model.endpoint.endsWith('/v1') ? model.endpoint.slice(0, -3) : model.origin;
      const [props, kobold] = await Promise.all([get(root + '/props').catch(() => null), get(root + '/api/extra/true_max_context_length').catch(() => null)]);
      contextSize = usable(props?.body?.default_generation_settings?.n_ctx) ?? usable(props?.body?.n_ctx) ?? usable(kobold?.body?.value) ?? null;
    }
    return {requestModel, contextSize: contextSize ?? LOCAL_LLM_LIMITS.externalContext};
  }

  /**
   * A turn on the server the player runs came back 401/403. Its first look cannot tell: KoboldCpp's --password guards the chat requests only, so
   * a wrong or missing `apiKey` passes the look at /models. Says so once in the log (no address, no key), where the docs send the player to look.
   * The server stays as it is: the turn fails (or the cloud answers it) and the next turn asks again. Returns whether it logged.
   */
  externalKeyRefused() {
    if (this.#state !== 'ready' || !this.#info?.external || this.#keyNoted) return false;
    this.#keyNoted = true;
    this.log('[local] the server of "' + this.#model + '" did not accept the API key (check "apiKey" in manifest.custom.json)');
    return true;
  }

  /**
   * A server the player runs stopped answering (a chat request to it failed to connect or time out): forget it, so the next ensure() looks at it
   * again with one short request instead of trusting a connection that is gone. Does nothing for our own llama-server (it has its exit handler).
   * Returns whether it did something.
   */
  externalLost() {
    if (this.#state !== 'ready' || !this.#info?.external) return false;
    this.#info = null;
    this.#disarm();
    this.log('[local] the server you added stopped answering: it is looked at again before the next turn');
    this.#setState('stopped');
    return true;
  }

  // What the server says about itself (GET /props, once per start): the context it really has (n_ctx per slot; the one it was asked for when it does
  // not say) and, for the diagnostics, its chat template (length, hash and first words), bos/eos tokens, build and quantisation.
  async #readProps(proc, requested) {
    const result = {contextSize: requested};
    try {
      const response = await this.fetchImpl(proc.baseUrl + '/props', {headers: {authorization: 'Bearer ' + proc.apiKey}, signal: AbortSignal.timeout(3000)});
      const body = response.ok ? await response.json() : null;
      const value = Number(body?.default_generation_settings?.n_ctx ?? body?.n_ctx);
      if (Number.isFinite(value) && value >= 512) result.contextSize = value;
      Object.assign(result, describeProps(body));
    } catch { /* an older server or a fake one: use what was asked for */ }
    return result;
  }

  // One line for the log: which file is loaded and how, in words a report reader can match to a model.
  #describeLoaded() {
    const loaded = this.#loaded;
    if (!loaded) return 'nothing';
    const template = loaded.template ? `${loaded.templateFlag ? 'flag:' + loaded.templateFlag : 'gguf'} ${loaded.template.chars} chars sha ${loaded.template.sha}` : (loaded.templateFlag ? 'flag:' + loaded.templateFlag : 'not reported');
    return [`file ${loaded.file ?? 'a server you run'}`, `name "${loaded.name}"`, `id ${loaded.id}`, `family ${loaded.family ?? 'unknown'}`,
      loaded.sizeMiB ? `${loaded.sizeMiB} MiB` : null, `context ${loaded.contextSize}`, loaded.offload ? 'part on the CPU' : null,
      loaded.device ? `device ${loaded.device.id}${loaded.device.freeMiB === null ? '' : ' (' + loaded.device.freeMiB + ' MiB free before)'}` : null,
      loaded.ram?.freeMiB ? `system memory ${loaded.ram.freeMiB} of ${loaded.ram.totalMiB} MiB free` : null, `template ${template}`, loaded.template ? `"${loaded.template.head}"` : null, loaded.eos ? `eos ${loaded.eos}` : null, loaded.build ? `build ${loaded.build}` : null,
      loaded.loadMs === null ? null : `loaded in ${(loaded.loadMs / 1000).toFixed(1)} s`, loaded.warmMs === null ? null : `warm-up ${(loaded.warmMs / 1000).toFixed(1)} s${loaded.firstTime ? ' (first time)' : ''}`]
      .filter(Boolean).join(', ');
  }

  // The last lines the child printed (the key is redacted), for a start that failed or a server that stopped: why is in there (an allocation that failed, a model it cannot read).
  #logTail(proc, why) {
    let lines = [];
    try { lines = String(proc?.tail?.() ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-10).map(line => line.slice(0, 220)); } catch { /* best effort */ }
    if (lines.length) this.log('[local] last llama-server output (' + why + '): ' + lines.join(' | ').slice(0, 1800));
  }

  /**
   * What is loaded and how the turns went, for the log and the support report: plain data, no path (file names only), no key, no text of any reply.
   * {state, model: {id, name, file, family, tier, sizeMiB, offload, custom, external}, engine: {build, ftype, device, contextSize, cacheRamMiB, ram: {freeMiB, totalMiB}}, template: {source, chars,
   * sha, head}, tokens: {bos, eos}, start: {loadMs, warmMs, firstTime, readyAt}, turns: {ok, failed}, lastTurn, lastExit}. null when nothing was loaded yet.
   */
  diagnostics() {
    const loaded = this.#loaded;
    if (!loaded) return null;
    return {state: this.#state, ...(this.#reason ? {reason: this.#reason} : {}),
      model: {id: loaded.id, name: String(loaded.name ?? '').slice(0, 80), file: loaded.file, family: loaded.family, tier: loaded.tier, sizeMiB: loaded.sizeMiB, offload: loaded.offload,
        custom: loaded.custom, ...(loaded.external ? {external: true} : {})},
      engine: {build: loaded.build, ftype: loaded.ftype, device: loaded.device ? {id: loaded.device.id, name: String(loaded.device.name ?? '').slice(0, 60), freeMiB: loaded.device.freeMiB} : null,
        contextSize: loaded.contextSize, cacheRamMiB: loaded.cacheRamMiB, ram: loaded.ram ?? null},
      template: loaded.template ? {source: loaded.templateFlag ? 'flag:' + loaded.templateFlag : 'gguf', ...loaded.template} : {source: loaded.templateFlag ? 'flag:' + loaded.templateFlag : 'not reported'},
      tokens: {bos: loaded.bos, eos: loaded.eos},
      start: {loadMs: loaded.loadMs, warmMs: loaded.warmMs, firstTime: loaded.firstTime, readyAt: loaded.readyAt ? new Date(loaded.readyAt).toISOString() : null},
      turns: {ok: this.#turns.ok, failed: this.#turns.failed}, lastTurn: this.#lastTurn, lastExit: this.#lastExit};
  }

  /**
   * The host reports how a local turn went: {ok: true, trace} or {ok: false, error, detail}. Kept for diagnostics(); a 'diagnostics' event follows a
   * failure and the first turn after each start (not every turn: the report file is written only then). Returns {first}: whether this was the first
   * turn since the model was loaded, which the host logs with its timings. Never throws.
   */
  noteTurn({ok, trace, error, detail} = {}) {
    try {
      const first = this.#turns.sinceStart === 0;
      this.#turns.sinceStart++;
      if (ok) this.#turns.ok++; else this.#turns.failed++;
      const t = trace ?? error?.trace ?? null;
      this.#lastTurn = {at: new Date(this.now()).toISOString(), ok: ok === true, ...(ok ? {} : {reason: String(error?.reason ?? error?.kind ?? 'error').slice(0, 30), detail: oneLine(detail ?? '', 160)}),
        ...(t ? {headersMs: t.headersMs, firstWordMs: t.firstTokenMs, pieces: t.pieces, thinkingPieces: t.reasoning, elapsedMs: t.elapsedMs,
          ...(t.progress ? {promptProgress: `${t.progress.processed}/${t.progress.total}`} : {}),
          ...(t.timings ? {promptTokens: t.timings.promptTokens, cachedTokens: t.timings.cachedTokens, tokensPerSecond: Number.isFinite(t.timings.tokensPerSecond) ? Math.round(t.timings.tokensPerSecond * 10) / 10 : null} : {}),
          ...(t.finishReason ? {finishReason: t.finishReason} : {})} : {})};
      if (!ok || first) this.emit('diagnostics', this.diagnostics());
      return {first};
    } catch { return {first: false}; }
  }

  /**
   * The server's own token count of a text (POST /tokenize), or null when it cannot say (stopped, an error, no answer in time). Never
   * starts the server. About 50 to 150 ms for 30,000 characters, so it is asked only when a prompt comes near the limit.
   */
  async tokenize(text, {signal, timeoutMs = 2500} = {}) {
    const info = this.#info;
    if (!info?.base || this.#state !== 'ready' || info.external) return null;   // a server the player runs: the estimate (and the refusal it learns from) stands
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await this.fetchImpl(info.base + '/tokenize', {method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {'content-type': 'application/json', authorization: 'Bearer ' + info.apiKey}, body: JSON.stringify({content: String(text ?? '')})});
      const body = response.ok ? await response.json() : null;
      return Array.isArray(body?.tokens) ? body.tokens.length : null;
    } catch { return null; }
  }

  #emitStatus() { this.emit('state', this.status()); }

  async #warmUp(proc, generation, firstTime) {
    const sizes = firstTime ? WARMUP_TOKENS : [0];
    for (const tokens of sizes) {
      if (generation !== this.#generation || !proc.alive) return false;
      try {
        await this.#complete(this.#info, warmupMessages(tokens), {timeoutMs: this.warmupMs, cachePrompt: false});
      } catch (error) {
        this.log('[local] warm-up request failed: ' + (error?.message || 'error'));
        await proc.waitForExit(300);   // a dying server fails the request before its exit event arrives
        return false;
      }
    }
    return true;
  }

  // A non-streaming one-token request. The reply is read and dropped.
  async #complete(info, messages, {signal, timeoutMs = 60_000, cachePrompt = true} = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await this.fetchImpl(info.endpoint, {method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {'content-type': 'application/json', authorization: 'Bearer ' + info.apiKey},
        body: JSON.stringify({model: info.requestModel ?? this.#model ?? 'local', messages, max_tokens: 1, stream: false, temperature: 0, cache_prompt: cachePrompt})});
      await response.arrayBuffer?.().catch(() => {});
      if (!response.ok) throw Error('HTTP ' + response.status);
    } catch (error) {
      // The platform's own text for a timeout ("The operation was aborted due to timeout") says nothing: say how long it waited.
      if (timeout.aborted && !signal?.aborted) throw Error('no answer in ' + Math.round(timeoutMs / 1000) + ' s (the server was still reading the prompt, or stuck)');
      throw error;
    }
  }

  #onExit(proc, {expected, code, signal}) {
    if (this.#proc !== proc || expected) return;
    this.#lastExit = {code: code ?? null, signal: signal ?? null, at: new Date(this.now()).toISOString(), state: this.#state};
    // While starting or warming, #startOnce sees the death itself.
    if (this.#state !== 'ready') return;
    this.#proc = null; this.#info = null;
    this.#disarm();
    this.log('[local] llama-server stopped unexpectedly (exit ' + (code ?? signal ?? '?') + ')');
    this.#logTail(proc, 'it stopped unexpectedly');
    this.emit('diagnostics', this.diagnostics());
    this.#setState('starting');
    this.#launch(true);
  }

  // --- idle handling ------------------------------------------------------------------------------------------

  // A use of the server: restarts the idle countdown.
  touch() { if (this.#state === 'ready') this.#arm(); }

  // Marks a request in flight (blocks the idle stop). Returns a one-shot release function; end() is the manual form.
  begin() {
    this.#inflight++;
    this.#disarm();
    let released = false;
    return () => { if (!released) { released = true; this.end(); } };
  }
  end() {
    if (this.#inflight > 0) this.#inflight--;
    if (this.#inflight === 0) { this.touch(); if (this.#reselectPending) void this.#reloadIfIdle(); }
  }
  get inflight() { return this.#inflight; }

  #arm() {
    this.#disarm();
    if (this.#state !== 'ready' || this.#inflight > 0 || !(this.idleMs > 0) || this.#info?.external) return;   // a server the player runs holds nothing of ours
    this.#idleTimer = this.setTimer(() => this.#idleFire(), this.idleMs);
    this.#idleTimer?.unref?.();
  }
  #disarm() { if (this.#idleTimer) this.clearTimer(this.#idleTimer); this.#idleTimer = null; }

  #idleFire() {
    this.#idleTimer = null;
    if (this.#state !== 'ready' || this.#inflight > 0) return;
    const proc = this.#proc; this.#proc = null; this.#info = null;
    this.#setState('stopped');
    this.log('[local] idle: stopping the local model server');
    proc?.stop().catch(() => {});
  }

  // --- prompt cache -------------------------------------------------------------------------------------------

  // Best effort, never throws: leaves the static persona prefix in llama-server's prompt cache.
  async prewarm(messages) {
    let release = null;
    try {
      const info = await this.ensure();
      if (info.external && this.#info?.remote) return false;   // nothing is sent to a remote server ahead of a turn
      release = this.begin();
      await this.#complete(info, messages);
      return true;
    } catch (error) {
      this.log('[local] persona prewarm skipped: ' + (error?.message || 'error'));
      return false;
    } finally { release?.(); }
  }

  // --- stopping -----------------------------------------------------------------------------------------------

  // Ends the child and cancels timers. Idempotent. A later ensure() starts it again.
  async stop() {
    this.#generation++;
    this.#reselectPending = false;   // the next start reads the current choice itself
    this.#disarm();
    const proc = this.#proc; this.#proc = null; this.#info = null;
    if (this.#state !== 'failed') this.#setState('stopped');
    this.#starting = null;
    await proc?.stop();
  }

  // For process exit handlers: no awaiting.
  killSync() {
    this.#generation++;
    this.#disarm();
    const proc = this.#proc; this.#proc = null; this.#info = null;
    if (this.#state !== 'failed') this.#state = 'stopped';
    this.#starting = null;
    proc?.killSync();
  }

  // --- first-run state ----------------------------------------------------------------------------------------

  #signature(modelFile) {
    const name = String(modelFile).split(/[\\/]/).pop();
    let size = 0; let serverMtimeMs = 0;
    try { size = statSync(modelFile).size; } catch { /* unknown */ }
    try { serverMtimeMs = Math.round(statSync(this.pack.server).mtimeMs); } catch { /* unknown */ }
    return JSON.stringify([name, size, serverMtimeMs]);
  }

  #loadWarmed() {
    if (!this.stateFile) return;
    this.#warmed = new Set();
    try {
      const data = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      for (const entry of Array.isArray(data?.warmed) ? data.warmed : [])
        this.#warmed.add(JSON.stringify([entry.model, entry.size, entry.serverMtimeMs]));
    } catch { /* missing or corrupt: first time */ }
  }

  #saveWarmed(signature) {
    this.#warmed.add(signature);
    if (!this.stateFile) return;
    try {
      const warmed = [...this.#warmed].slice(-8).map(text => {
        const [model, size, serverMtimeMs] = JSON.parse(text);
        return {model, size, serverMtimeMs};
      });
      const temporary = this.stateFile + '.' + process.pid + '.tmp';
      writeFileSync(temporary, JSON.stringify({version: 1, at: this.now(), warmed}, null, 1));
      renameSync(temporary, this.stateFile);
    } catch (error) { this.log('[local] could not save the warm-up state: ' + (error?.code || 'error')); }
  }
}
