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
//   server.on('model-stepdown', ({from, model, free}) => ...)                  // turns stalled (the game took the graphics memory): `model` (its name) was loaded instead, or null when none is
//                                                                              // left (none to step to: the same model is loaded with part of its layers on the CPU, or a 'failed' event with reason 'low-memory' and detail 'too-small' follows)
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
// One exception, found on a machine whose user name is not ASCII: on Windows llama-server opens that file with a narrow call that
// cannot read a UTF-8 path, so a temporary folder under C:\Users\<a name with an accent, a Cyrillic or a Chinese letter> made every start
// exit at once ("failed to open file"). Such a path takes the key in the child's environment instead (`LLAMA_API_KEY`, which llama-server
// reads the same way; the environment is not the command line and is not logged either). The model path is not affected: it is opened
// through a wide-character call.
import {EventEmitter} from 'node:events';
import {spawn, execFile} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir, freemem, totalmem, setPriority, cpus, constants as osConstants} from 'node:os';
import {basename, join} from 'node:path';
import {contextRefusal} from './mistral-client.mjs';
import {FIT_LIMITS, describeFit, fitLadder, fitToolPath, offloadPlan, offloadRamNeedMiB, offloadThreads, probeProjectedMiB} from './local-vram-fit.mjs';
import {SPILL_LIMITS, readGpuProcessMemory, slowReply, spillVerdict} from './gpu-memory.mjs';
import {SMALL_CARD_GAME_RESERVE_MIB, SMALL_CARD_MAX_MIB, chooseLocalModel, externalModels, listLocalModels, modelNeedMiB, normalisePin, stepDownTarget, stillSatisfies} from './local-model-choice.mjs';

const REASON_TEXT = Object.freeze({
  'not-installed': 'the Local AI pack is not installed',
  'low-memory': 'not enough free graphics memory',
  'mature-off': 'only Mature models are installed and Mature content is off',
  'no-gpu': 'no discrete graphics card was found',
  'start-failed': 'the local model server did not start',
  crashed: 'the local model server stopped working',
  stopped: 'the local model server was stopped',
});

/** The `detail` of a 'low-memory' failure after the model could not be placed even with part of its layers on the CPU (too few of them would stay on the card): Local AI is down, with no cloud fallback. */
export const TOO_SMALL = 'too-small';
/** The `detail` of a 'start-failed' refusal: the part of the model that runs on the processor (and its cache) does not fit the free system memory. */
export const LOW_RAM = 'low-ram';
/** The `detail` of a 'start-failed' for a server the player runs, by what its first look found (bridge/local-llm-server.mjs #lookAtServer): it does not answer, refuses the key, or the address is not an OpenAI-style one. */
export const SERVER_DETAILS = Object.freeze({unreachable: 'server-unreachable', 'key-refused': 'server-key-refused', 'bad-address': 'server-bad-address'});
const SERVER_DETAIL_TEXT = Object.freeze({
  'server-unreachable': 'the model server you added does not answer: start it (and load its model), then the next turn tries again',
  'server-key-refused': 'the model server you added did not accept the API key (check "apiKey" in manifest.custom.json)',
  'server-bad-address': 'the model server you added answers, but not like an OpenAI-style API (the address usually ends in /v1)',
});
/** The `detail` of a 'start-failed' refusal when the computer refused to run a file of the model server (spawn UNKNOWN / EPERM / EACCES, or the words of Smart App Control or an Application Control policy). */
export const BLOCKED = 'windows-blocked';
/** The code or words of a file the system would not run. Smart App Control and a company's or school's Application Control (WDAC) policy refuse an unsigned executable at spawn: Node reports `spawn UNKNOWN`, EPERM or EACCES
 *  (error reports b6014b54 and 1aa616f1, and "An Application Control policy has blocked this file" in the same install's earlier report). */
const BLOCKED_CODE = /^(UNKNOWN|EPERM|EACCES)$/;
const BLOCKED_TEXT = /Application Control|has blocked this file|blocked by (?:a |your )?(?:group )?policy|Smart App Control|\bspawn (?:UNKNOWN|EPERM|EACCES)\b/i;
export const looksBlocked = error => BLOCKED_CODE.test(String(error?.code ?? '')) || BLOCKED_TEXT.test(String(error?.message ?? ''));

export class LocalAiUnavailable extends Error {
  // reason: 'not-installed' | 'low-memory' | 'mature-off' | 'no-gpu' | 'start-failed' | 'crashed' | 'stopped'
  constructor(reason, detail) {
    super('[local:unavailable] ' + (REASON_TEXT[reason] ?? String(reason)) + (detail ? ' (' + detail + ')' : ''));
    this.name = 'LocalAiUnavailable';
    this.code = 'local-unavailable';
    this.reason = reason;
    this.detail = detail;
  }
}

// Why Local AI cannot be used, in one plain English phrase the game shows after its own sentence (docs/NOTIFICATIONS.md, local-unavailable): short,
// printable ASCII, no path and no key. `detail` is the start's own word ('exited', 'timeout', ...), when it has one.
const PLAYER_REASON = Object.freeze({
  'not-installed': 'the Local AI pack is not installed',
  'low-memory': 'there is not enough free graphics memory',
  'mature-off': 'only Mature models are installed and Mature content is off',
  'no-gpu': 'no discrete graphics card was found',
  'start-failed': 'the model server did not start',
  crashed: 'the model server stopped working and did not start again',
});
export function unavailableDetail(reason, detail) {
  // A model that cannot stay on the card even with part of it on the CPU (TOO_SMALL): the sentence says what to do about it, locally (no cloud provider is suggested).
  if (reason === 'low-memory' && detail === TOO_SMALL) return 'this graphics card is too small for the model: choose a smaller model in Settings, or use the Custom provider';
  if (reason === 'start-failed' && detail === LOW_RAM) return 'not enough free system memory to run this model on the processor: close programs, or choose a smaller model or the Custom provider';
  if (reason === 'start-failed' && SERVER_DETAIL_TEXT[detail]) return SERVER_DETAIL_TEXT[detail];
  // The same words as the Pocket voice row (voice-selection.mjs): restarting changes nothing until the player allows the file or chooses another provider.
  if (reason === 'start-failed' && detail === BLOCKED) return 'Windows blocked a file of the model server (Smart App Control or an Application Control policy), so Local AI cannot run on this PC';
  const text = PLAYER_REASON[reason];
  if (!text) return undefined;
  const word = typeof detail === 'string' && /^[a-z][a-z-]{1,24}$/.test(detail) ? detail : null;
  return word && (reason === 'start-failed' || reason === 'crashed') ? `${text} (${word})` : text;
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
  stallStepDown: 2,            // this many stalled requests (a turn or a persona warm-up with no answer, a prompt read that stopped, a reply that went quiet) since the model was loaded, none answered between: step down
  warmupMs: 240_000,           // one warm-up request, first time included
  backgroundQuietMs: 10_000,   // work no player waits on (a summary, memory work) does not start within this long after a turn ended; the bridge's own gate holds 20 s from a turn's start
  maxRestarts: 2,
  deviceLostStepDown: 2,       // the graphics device was lost (Vulkan ErrorDeviceLost) this many times in a session: the first loss restarts llama-server, the second steps down a model size
  offloadReloads: 3,           // a model that spilled, was lost or stalled again is loaded again with part of it on the CPU at most this many times a session, then Local AI is unavailable
  deviceListRetryMs: 1500,     // the listing of the graphics devices (llama-server --list-devices) failed to run: one more try after this long, then the start fails and names the error
  deviceLostPauseMs: 2000,     // the driver needs a moment to reset the device: the server it is restarted on waits this long before it starts
  externalProbeMs: 4000,       // a server the player runs: the one look at it when its model is chosen (GET /models), and each context question
  externalContext: 8192,       // its context when neither the entry, the listing nor /props says
});

/** The words of a lost graphics device (llama.cpp's Vulkan backend: "decode() failed: vk::Queue::submit: ErrorDeviceLost"), in a failed request's text or in the server's own log. */
export const DEVICE_LOST = /ErrorDeviceLost|device lost|VK_ERROR_DEVICE_LOST/i;
/** The words of a graphics card that ran out of memory while llama-server was allocating on it ("decode() failed: vk::Device::allocateMemory: ErrorOutOfDeviceMemory", error report 0f5d6496). Like a lost
 *  device it leaves llama-server alive and answering /health while every later request fails with HTTP 500 (a card with 8 GB that the game and the model share): only a restart helps, and a restart
 *  that meets the same wall steps the model down. */
export const DEVICE_OUT_OF_MEMORY = /ErrorOutOfDeviceMemory|VK_ERROR_OUT_OF_DEVICE_MEMORY|out of device memory/i;
/** Either of them: the failures that take the restart, then the step-down (LocalLlmServer.noteDeviceLost). */
export const DEVICE_FAULT = new RegExp(DEVICE_LOST.source + '|' + DEVICE_OUT_OF_MEMORY.source, 'i');
/** What every request answers after such a fault, whatever it was ("Invalid input batch.", error report 8696ffb2: HTTP 500 within 30 to 50 ms, /health still fine). The same words also come from a request the
 *  server cannot take, so on their own they count only when they repeat on one server process (LocalLlmServer.recover), or when the server's own log shows the device fault before them. */
export const INVALID_BATCH = /Invalid input batch/i;

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

/** Is the path made only of printable ASCII? llama-server (Windows) cannot open an `--api-key-file` whose path is anything else. */
export const isAsciiPath = path => /^[\x20-\x7e]*$/.test(String(path ?? ''));

/** The arguments without `--api-key-file <path>` (the key then goes in the environment). */
export function withoutKeyFile(args) {
  const out = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--api-key-file') { index++; continue; }
    out.push(args[index]);
  }
  return out;
}

// The llama-server command line for the chat model. Pure; the key goes in a file, never on the command line.
// `chatTemplate` (a model the player added, bridge/custom-models.mjs) is the name of a llama.cpp built-in template: `--chat-template`.
// `offload` (a model that does not fully fit the free graphics memory, bridge/local-model-choice.mjs; the caller gives it the context 8,192, the 8-bit cache, `fitTargetMiB` and `threads`
// below): no layer count is given and the fit pass is on, so llama-server keeps as many layers on the card as fit, leaves `fitTargetMiB` of it free for the game and runs the rest on
// the CPU (the context is given, so it stays).
// `kvType` ('q8_0'): the KV cache type, only when the free-memory fit (bridge/local-vram-fit.mjs) needed the smaller cache to keep the whole model on the card.
// `fitTargetMiB` / `threads` (an offloaded load only; nothing changes for a model that is wholly on the card): `-fitt`, the free memory the fit pass leaves on the card for the game
// (llama-server's own default is 1,024), and `-t`, the CPU threads (about half the physical cores, so the game's CPU is not starved by the layers that run on it).
export function buildServerArgs({model, port, keyFile, device, contextSize = LOCAL_LLM_LIMITS.contextSize, cacheRamMiB = 1024, host = '127.0.0.1', chatTemplate = null, offload = false, kvType = null,
    fitTargetMiB = null, threads = null}) {
  if (!model || !port || !keyFile || !device) throw TypeError('model, port, keyFile and device are required');
  return ['-m', model, ...(offload ? [] : ['-ngl', '99']), '-fa', 'on', '-c', String(contextSize), ...(kvType ? ['-ctk', String(kvType), '-ctv', String(kvType)] : []), '-np', '1', '--reasoning', 'off',
    // -fit off: the layers, context and device are all given, so llama-server's fit pass (which loads the model a second time to
    // measure the devices) only costs start time (see bridge/local-embed.mjs).
    '--cache-ram', String(cacheRamMiB), '--ctx-checkpoints', '32', '-fit', offload ? 'on' : 'off',
    ...(offload && fitTargetMiB ? ['-fitt', String(Math.round(fitTargetMiB))] : []), ...(offload && threads ? ['-t', String(Math.round(threads))] : []), '--device', device, '--no-webui',
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

// The failures of a local turn that mean the model is reading or writing at a crawl, as the stream showed them (stallReason in bridge/mistral-client.mjs).
// 'loading' (the first start is still compiling), 'thinking-only', an empty answer or a refused prompt are not among them.
const STALL_REASONS = new Set(['no-response', 'prefill-stalled', 'no-first-token', 'stalled']);
// A turn that ended before any request went out (its time was spent on something else, such as the model loading after the idle stop: "ran out of time before the model could be asked",
// 2026-10-21) says nothing about how the model reads or writes: its error has noAttempt, or a record with no request time at all. It is never a stall.
const noRequestMade = (error, trace) => error?.noAttempt === true || (typeof trace?.elapsedMs === 'number' && trace.elapsedMs <= 0);

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
//   proc.lower()   -> sets the child's priority class below normal (true when it is, or was); with `lowerAfter: 'ready'` the child runs at normal priority until this is called
// `lowerPriority` (default true) lowers the child below normal so the game keeps its CPU: at once (`lowerAfter: 'spawn'`, the default: the embedder and any
// CPU process) or when the owner calls lower() (`lowerAfter: 'ready'`: the chat model, which loads at normal priority because a load under a game that keeps every
// core busy starved for minutes at below normal, and is lowered once it is loaded and warm, because generation runs on the graphics card).
// `command` + `argsPrefix` let tests run `node fake-llama-server.mjs ...` instead of an .exe.
export class LlamaProcess extends EventEmitter {
  #key = null; #keyDir = null; #child = null; #port = 0; #startPromise = null;
  #exited = false; #expected = false; #healthy = false; #tail = ''; #lowered = false;
  #exitPromise; #resolveExit; #settleWait = null;

  constructor({command, argsPrefix = [], buildArgs, spawnImpl = spawn, fetchImpl = fetch, startupMs = LOCAL_LLM_LIMITS.startupMs,
      tmpDir = tmpdir(), platform = process.platform, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {}, lowerPriority = true, lowerAfter = 'spawn', setPriorityImpl = setPriority, pollMs = 200,
      healthTimeoutMs = 2000, env = {}, tailChars = 6000, findPort = freePort, label = 'llama-server'} = {}) {
    super();
    if (!command || typeof buildArgs !== 'function') throw TypeError('command and buildArgs are required');
    Object.assign(this, {command, argsPrefix, buildArgs, spawnImpl, fetchImpl, startupMs, tmpDir, platform, setTimer, clearTimer, log,
      lowerPriority, lowerAfter, setPriorityImpl, pollMs, healthTimeoutMs, env, tailChars, findPort, label});
    this.#exitPromise = new Promise(resolveExit => { this.#resolveExit = resolveExit; });
  }

  get apiKey() { return this.#key; }
  get port() { return this.#port; }
  get baseUrl() { return this.#port ? 'http://127.0.0.1:' + this.#port : null; }
  get pid() { return this.#child?.pid ?? null; }
  get alive() { return Boolean(this.#child) && !this.#exited; }
  get running() { return this.alive && this.#healthy; }
  get exited() { return this.#exited; }

  // Does the child answer /health right now (one short request)? False when it never became healthy, has exited, or does not answer: a server
  // that crashed can stay listed as running for a moment, because Windows keeps a crashed process around while it writes its crash report.
  async answers() { return this.alive && this.#port ? this.#probe(this.#port) : false; }

  // Lowers the child below normal priority (best effort: a refusal leaves it at normal). True when it is lowered.
  lower() {
    const pid = this.#child?.pid;
    if (!this.lowerPriority || !pid || this.#exited) return false;
    try { this.setPriorityImpl(pid, osConstants.priority.PRIORITY_BELOW_NORMAL); this.#lowered = true; return true; } catch { return false; }
  }

  // Back to normal priority while a turn waits on the child (a below-normal process starves for seconds when the game keeps every core busy, and
  // the game's foreground time slices are longer still). True when it was lowered and is now at normal; a refusal leaves it as it was.
  raise() {
    const pid = this.#child?.pid;
    if (!this.#lowered || !pid || this.#exited) return false;
    try { this.setPriorityImpl(pid, osConstants.priority.PRIORITY_NORMAL); this.#lowered = false; return true; } catch { return false; }
  }

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
      let args, keyEnvironment = {};
      if (this.platform !== 'win32' || isAsciiPath(this.tmpDir)) {
        this.#keyDir = mkdtempSync(join(this.tmpDir, 'convai-llama-'));
        const keyFile = join(this.#keyDir, 'api-key');
        writeFileSync(keyFile, this.#key + '\n', {mode: 0o600, flag: 'wx'});
        args = [...this.argsPrefix, ...this.buildArgs({port, keyFile})];
      } else {
        // A temporary folder llama-server could not read the key file from (see the top of this file): no file, the key in the environment.
        args = [...this.argsPrefix, ...withoutKeyFile(this.buildArgs({port, keyFile: 'unused'}))];
        keyEnvironment = {LLAMA_API_KEY: this.#key};
      }
      child = this.spawnImpl(this.command, args, {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: {...process.env, ...this.env, ...keyEnvironment}});
    } catch (error) {
      this.#removeKey();
      throw error?.code === 'stopped' ? error : startError('spawn-failed', 'could not be started (' + (error?.code || error?.message || 'error') + ')');
    }
    this.#child = child;
    if (this.lowerAfter === 'spawn') this.lower();
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

const CONTEXT_FLOOR = 2048;   // the least a server's context is stepped down to when a refusal does not say what it has
export class LocalLlmServer extends EventEmitter {
  #state = 'stopped'; #reason = null; #tier = null; #model = null; #firstTime = false;
  #proc = null; #info = null; #starting = null; #generation = 0; #inflight = 0; #idleTimer = null;
  #keyNoted = false; #warmed = new Set(); #contextSize = 0; #modelId = null; #reselectPending = false; #hints = null; #totalMiB = null; #lastFreeMiB = null; #failedPin = null; #serverWhy = null; #broken = new Map();
  #loaded = null; #lastExit = null; #lastTurn = null; #turns = {ok: 0, failed: 0, sinceStart: 0}; #prewarming = null;
  // What a start is doing right now and since when (loadProgress): one word-string per stage, set a handful of times per start, never per request or per frame.
  #phase = {name: null, at: 0}; #launchedAt = null;
  // Step-down (stalled turns, see noteStall): the ids of the models left out for the rest of this session, the stalled requests since the model was loaded,
  // the model the step started from (the next start says what it was replaced by), and whether a step is running. In memory only: the saved choice is untouched.
  #stalled = new Set(); #stalls = 0; #stepFrom = null; #stepFree = null; #stepping = false;
  // The model the next start loads with part of its layers on the CPU (a step-down with no smaller model, bridge/local-vram-fit.mjs offloadPlan), and the word that says why Local AI is
  // 'failed' beyond its reason (TOO_SMALL: the model cannot stay on the card even with part of it on the CPU).
  // `#offloadTried`: how often each model was reloaded with part of its layers on the CPU after a step (LOCAL_LLM_LIMITS.offloadReloads at most: then Local AI is unavailable, no loop of reloads).
  #forcedOffload = null; #reasonDetail = null; #offloadTried = new Map();
  // While a step runs (#beginStep .. #endStep) the model is about to change: ensure() waits on this gate instead of starting a load the step would cancel (a turn that came
  // during #spillAct's free-memory read and fit probe started the large model again, #stepDown then stopped it, and the turn failed with 'stopped': 2026-10-21 reports).
  #stepGate = null;
  // Lost graphics device (noteDeviceLost): the losses since the session began (or the last step), the process the last one was seen on (one process counts once),
  // and the pause the next start makes first, so the driver has reset the device.
  #deviceLosses = 0; #lostProc = null; #coolDownMs = 0; #batchFaults = {proc: null, count: 0};
  // Free-memory fit (bridge/local-vram-fit.mjs) and spill (bridge/gpu-memory.mjs): the device of the last start, the models already reloaded once after a spill (a second spill
  // steps down), the one-shot fit a spill reload brings to the next start, and the rate limit of the counter reads.
  #device = null; #refitted = new Set(); #refitPlan = null; #spillAt = -Infinity; #checking = false; #headerWatch = new Set();
  // The ready server runs below normal priority so the game keeps its CPU, but a request in flight (and priorityHoldMs after the last one) runs at normal:
  // the server's own thread feeds the graphics card and streams the reply, and a game that keeps every core busy starved it for seconds.
  priorityHoldMs = 5000; #raised = false; #holdTimer = null;
  // The one slot (-np 1): who is using it. `#foreground` counts the requests a player waits on (a turn, its action decision), `#yieldable` holds the stop functions of
  // the background requests in flight (a summary, memory work) so a turn can take the slot at once, `#slot` is the persona whose prompt the slot holds (a warm-up of it
  // would only cut that longer prompt down to the head), and `#queue` counts what was stopped or refused, for the support report.
  #foreground = 0; #foregroundEndedAt = -Infinity; #yieldable = new Set(); #slot = null; #queue = {stopped: 0, refused: 0, warmSkipped: 0};
  // The context a server the player runs really has, learned from a request it refused for length (learnContext), per address and model id, for the session: a server's
  // loaded context can be smaller than what it reported (LM Studio), and the prompts are fitted to the smaller one from then on.
  #contextLearned = new Map();

  // command/argsPrefix replace pack.server when spawning (tests); processOptions go to LlamaProcess (tests).
  // contextSize: a fixed context (tests, CYBERPUNK_CONVAI_LOCAL_CTX); without it each start takes the ladder's largest that fits.
  // selection: () => {pin, matureOn, matureModels}, read at each start and each reselect (the player's model choice, bridge/local-model-choice.mjs).
  // tier ('standard' | 'lite') is the older, stricter form of a pin: that tier or an error, no memory check.
  constructor({pack, tier = 'auto', selection, contextSize, spawnImpl = spawn, fetchImpl = fetch, listDevices,
      freeVramMiB = nvidiaFreeMiB, idleMs = LOCAL_LLM_LIMITS.idleMs, startupMs = LOCAL_LLM_LIMITS.startupMs, warmup = true,
      warmupMs = LOCAL_LLM_LIMITS.warmupMs, stateFile, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
      log = () => {}, maxRestarts = LOCAL_LLM_LIMITS.maxRestarts, backoffMs = 750, deviceLostPauseMs = LOCAL_LLM_LIMITS.deviceLostPauseMs, deviceListRetryMs = LOCAL_LLM_LIMITS.deviceListRetryMs, cacheRamMiB, freeMemMiB = () => freemem() / 1048576,
      beforeStart, beforeStartMs = 120_000, fileSizeMiB = defaultFileSizeMiB, environment = process.env, command, argsPrefix = [], processOptions = {},
      externalProbeMs = LOCAL_LLM_LIMITS.externalProbeMs, backgroundQuietMs = LOCAL_LLM_LIMITS.backgroundQuietMs, fitProbe, gpuMemory, cpuCount = () => cpus().length} = {}) {
    super();
    const fixedContext = Number.parseInt(contextSize ?? environment.CYBERPUNK_CONVAI_LOCAL_CTX ?? '', 10);
    Object.assign(this, {pack, tierSetting: tier, selection, contextSize: Number.isFinite(fixedContext) && fixedContext >= 2048 ? fixedContext : null, spawnImpl, fetchImpl, freeVramMiB, idleMs, startupMs, warmup,
      warmupMs, stateFile, now, setTimer, clearTimer, log, maxRestarts, backoffMs, deviceLostPauseMs, deviceListRetryMs, argsPrefix, processOptions, freeMemMiB,
      beforeStart, beforeStartMs, fileSizeMiB, externalProbeMs, backgroundQuietMs, cpuCount});
    const configured = Number.parseInt(cacheRamMiB ?? environment.CYBERPUNK_CONVAI_LOCAL_CACHE_RAM ?? '', 10);
    this.cacheRamMiB = Number.isFinite(configured) && configured >= 0 ? configured : null;   // null: chosen at each start
    // CYBERPUNK_CONVAI_LOCAL_FREE_RAM_MIB: the free system memory the supervisor sees (tests of a real bridge process: the check before a load with part on the CPU, LOW_RAM).
    const ramOverride = Number.parseInt(environment.CYBERPUNK_CONVAI_LOCAL_FREE_RAM_MIB ?? '', 10);
    if (Number.isFinite(ramOverride) && ramOverride >= 0) this.freeMemMiB = () => ramOverride;
    this.command = command ?? pack?.server;
    this.listDevices = listDevices ?? (() => run(this.command, [...this.argsPrefix, '--list-devices'], 30_000));
    // fitProbe({model, contextSize, kvType, device}) -> projected MiB or null: llama-fit-params beside our llama-server (none with a stand-in server of a test).
    // gpuMemory(pid) -> {dedicatedMiB, sharedMiB} or null: the Windows counters (a test that supplies its own command gets none unless it passes this).
    const fitExe = command ? null : fitToolPath(this.command);
    this.fitProbe = fitProbe ?? (fitExe ? args => probeProjectedMiB({exe: fitExe, ...args}) : null);
    this.gpuMemory = gpuMemory ?? (command ? null : readGpuProcessMemory);
  }

  status() {
    const status = {state: this.#state, tier: this.#tier, model: this.#model};
    if (this.#contextSize && (this.#state === 'ready' || this.#state === 'warming')) status.contextSize = this.#contextSize;
    if (this.#reason) status.reason = this.#reason;
    if (this.#reason && this.#reasonDetail) status.detail = this.#reasonDetail;
    if (this.#firstTime) status.firstTime = true;
    if (this.#info?.external && this.#state === 'ready') status.external = true;
    return status;
  }

  #mark(name) { this.#phase = {name, at: this.now()}; }

  /**
   * Where a start stands, for the log line of a turn that gave up waiting for the model (bridge/text-provider-host.mjs, 'still loading', report d8c0d2f9): the state, how long this
   * start has run, what it is waiting on and for how long. `loadMs` is null when no start is under way. Plain numbers and a fixed phrase: no path, no key.
   */
  loadProgress() {
    const now = this.now(), starting = this.#starting !== null || this.#state === 'starting' || this.#state === 'warming';
    return {state: this.#state, loadMs: starting && this.#launchedAt !== null ? Math.max(0, now - this.#launchedAt) : null,
      waitingOn: starting ? this.#phase.name : null, waitingMs: starting && this.#phase.name ? Math.max(0, now - this.#phase.at) : null,
      stepping: this.#stepping === true, model: this.#model, idleStopped: this.#state === 'stopped' && this.#starting === null};
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
    // loadedAt / offload: which load this is and whether part of the model runs on the CPU, for the route's prompt-reading speed (bridge/prompt-budget.mjs PrefillMeter):
    // a model that was loaded again, perhaps with less graphics memory free, is measured anew.
    return {endpoint: info.endpoint, apiKey: info.apiKey, model: this.#model, tier: this.#tier, contextSize: this.#learnedContext(info) ?? info.contextSize,
      loadedAt: this.#loaded?.readyAt ?? 0, offload: this.#loaded?.offload === true,
      ...(info.external ? {external: true, requestModel: info.requestModel, trustedOrigin: info.trustedOrigin} : {})};
  }

  #contextKey(info) { return info?.external ? `${info.endpoint}|${info.requestModel ?? ''}` : null; }
  #learnedContext(info) {
    const learned = this.#contextLearned.get(this.#contextKey(info));
    return Number.isFinite(learned) && learned > 0 && learned < info.contextSize ? learned : null;
  }

  /**
   * A request to the server the player runs was refused because the prompt was longer than the context it has loaded. `tokens`: the context the refusal named; without
   * one, the context assumed so far is halved (never below 2048). Remembered for the session, so every later prompt is fitted to it. Returns the context now assumed, or
   * null when nothing changed (our own llama-server reads its context from /props and is never changed this way).
   */
  learnContext(tokens) {
    const info = this.#info;
    if (!info?.external) return null;
    const current = this.#learnedContext(info) ?? info.contextSize;
    const said = Number(tokens) > 0 ? Math.floor(Number(tokens)) : null;
    const next = said ?? Math.max(CONTEXT_FLOOR, Math.floor(current / 2));
    if (!(next < current)) return null;
    this.#contextLearned.set(this.#contextKey(info), next);
    this.log('[local] the server you added has a smaller context than it reported: prompts are fitted to ' + next + ' tokens from now on (raise the context length in the server for more)');
    return next;
  }

  // Starts the server if needed; resolves when it is ready. Concurrent callers share one start.
  // A step-down or spill action under way (#stepping) is waited for first: it is about to stop the model and start another, and a start begun now would be cancelled by it.
  // A start this caller awaits that ends with 'stopped' because a newer start took its place (a step-down, a reload) is not a failure: the newer start is awaited instead, as
  // long as the caller's signal is not aborted and the server has not failed. A plain stop() (nothing started again) still ends the wait with 'stopped'.
  async ensure({signal} = {}) {
    signal?.throwIfAborted();
    await this.#settleStep(signal);
    if (this.#state === 'failed') throw new LocalAiUnavailable(this.#reason, this.#reasonDetail ?? undefined);
    if (this.#state === 'ready' && (this.#proc?.running || this.#info?.external)) { this.touch(); return this.#handle(); }
    let awaited = this.#starting ?? this.#launch(false), handle;
    for (let superseded = 0; ; superseded++) {
      try { handle = await abortable(awaited, signal); break; }
      catch (error) {
        if (!(error instanceof LocalAiUnavailable) || error.reason !== 'stopped' || superseded >= 4) throw error;
        signal?.throwIfAborted();
        await this.#settleStep(signal);
        if (this.#state === 'failed') throw new LocalAiUnavailable(this.#reason, this.#reasonDetail ?? undefined);
        if (this.#state === 'ready' && (this.#proc?.running || this.#info?.external)) { this.touch(); return this.#handle(); }
        const newer = this.#starting;
        if (!newer || newer === awaited) throw error;
        awaited = newer;
      }
    }
    this.touch();
    return handle;
  }

  // The start a step (#stepDown, #spillAct) makes after it stopped the model: no wait for the step itself (it is the step), and none when a model is up or being started.
  #kick() {
    if (this.#state === 'failed' || this.#starting || (this.#state === 'ready' && this.#proc?.running)) return;
    this.#launch(false);
  }

  #beginStep() {
    this.#stepping = true;
    if (!this.#stepGate) { let release; const promise = new Promise(resolveGate => { release = resolveGate; }); this.#stepGate = {promise, release}; }
  }
  #endStep() {
    this.#stepping = false;
    const gate = this.#stepGate; this.#stepGate = null;
    gate?.release();
  }
  async #settleStep(signal) {
    while (this.#stepGate) await abortable(this.#stepGate.promise, signal);
  }

  #launch(recovering) {
    this.#launchedAt = this.now(); this.#mark(recovering ? 'restarting after the server stopped' : 'beginning to start');
    const promise = this.#bringUp(recovering).then(
      handle => {
        if (this.#starting === promise) this.#starting = null;
        // A server that stopped by itself and is running again: the host tells the player once (bridge/convai-bridge.mjs, 'local-restarted').
        if (recovering) this.emit('restarted', this.status());
        return handle;
      },
      error => {
        if (this.#starting === promise) this.#starting = null;
        if (error instanceof LocalAiUnavailable && error.reason !== 'stopped') {
          // The start after a step-down found no room for the smaller model (the game took the card). A model that is too small a card for even with part of it on the CPU (TOO_SMALL) says so
          // through the failure itself (a local notice: smaller model or Custom provider); any other lack of room is the step-down's own event, as before.
          const tooSmall = error.detail === TOO_SMALL || error.detail === LOW_RAM;
          if (this.#stepFrom) { this.#stepFrom = null; if (!tooSmall) this.emit('model-stepdown', {from: this.#model, model: null, free: this.#stepFree ?? null}); }
          this.#fail(error.reason, tooSmall || error.detail === BLOCKED || SERVER_DETAIL_TEXT[error.detail] ? error.detail : null);
        }
        throw error;
      });
    this.#starting = promise;
    promise.catch(() => {});
    return promise;
  }

  // One failure episode: state 'failed', one 'failed' event, ensure() throws until reset().
  #fail(reason, detail = null) {
    if (this.#state === 'failed') return;
    this.#disarm();
    const proc = this.#proc; this.#proc = null; this.#info = null;
    this.#reasonDetail = detail;
    this.#setState('failed', reason);
    if (proc) proc.stop().catch(() => {});
    this.log('[local] the local model server is unavailable (' + reason + (detail ? ': ' + detail : '') + ')');
    this.emit('failed', {reason, ...(detail ? {detail} : {})});
  }

  // Clears a failure so the next ensure() tries again (the settings screen / a new session).
  reset() {
    this.#broken.clear();   // a custom model that failed to start gets another chance
    this.#serverWhy = null;
    this.#deviceLosses = 0; this.#lostProc = null;
    this.#stalled.clear(); this.#stalls = 0;   // so does a model that stalled the turns: Local AI is chosen again, the whole choice is tried
    this.#refitted.clear(); this.#refitPlan = null; this.#forcedOffload = null; this.#offloadTried.clear();   // and a model that spilled into shared memory may be fitted again
    if (this.#state !== 'failed') return;
    this.#reason = null; this.#reasonDetail = null; this.#state = 'stopped';
    this.emit('state', this.status());
  }

  async #bringUp(recovering) {
    // `remaining` counts the starts still allowed: one for a plain start, maxRestarts when recovering from a crash.
    let remaining = recovering ? this.maxRestarts : 1;
    let attempt = 0;
    if (recovering && remaining <= 0) throw new LocalAiUnavailable('crashed');
    // After a lost graphics device: a short wait before the next process asks the driver for the card (once).
    if (this.#coolDownMs > 0) {
      const pause = this.#coolDownMs, generation = this.#generation;
      this.#coolDownMs = 0;
      this.#mark('waiting for the graphics driver to reset after a lost device');
      await delay(this.setTimer, this.clearTimer, pause);
      if (generation !== this.#generation) throw new LocalAiUnavailable('stopped');
    }
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
        this.#mark('pausing before the next start attempt');
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
    this.#mark('waiting for the voice to finish loading (it loads first so the free graphics memory is read after it)');
    let timer = null;
    try {
      await Promise.race([Promise.resolve(this.beforeStart()), new Promise(resolveWait => { timer = this.setTimer(resolveWait, this.beforeStartMs); timer?.unref?.(); })]);
    } catch (error) { this.log('[local] start hook failed: ' + (error?.message || 'error')); }
    finally { if (timer) this.clearTimer(timer); }
  }

  // `llama-server --list-devices`. A run that fails is logged with its error code and message (the file name only, no folder), tried once more after deviceListRetryMs
  // (the 2026-10-21 reports failed twice in the same second on a PC where the same listing worked in the next sessions), and then ends the start. Never a cloud fallback.
  async #listDevices() {
    this.#mark('listing the graphics devices');
    const generation = this.#generation, name = basename(String(this.command ?? ''));
    for (let attempt = 1; ; attempt++) {
      try {
        const listing = await this.listDevices();
        return Array.isArray(listing) ? listing : parseDeviceList(listing);
      } catch (error) {
        const blocked = looksBlocked(error);
        const words = oneLine(String(error?.message ?? error ?? '').split(String(this.command ?? '\u0000')).join(name), 200);
        this.log(`[local] could not list the graphics devices (try ${attempt} of 2): code ${error?.code ?? 'none'}${error?.signal ? ', signal ' + error.signal : ''}${error?.killed ? ', timed out' : ''}: ${words}`
          + (blocked ? ' (looks like Windows blocking the file)' : ''));
        if (attempt >= 2) throw new LocalAiUnavailable('start-failed', blocked ? BLOCKED : 'could not list the graphics devices');
        await delay(this.setTimer, this.clearTimer, this.deviceListRetryMs);
        this.#guard(generation);
      }
    }
  }

  async #selectDevice() {
    const devices = await this.#listDevices();
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
    this.#device = {id: device.id, name: device.name};
    return {device, freeMiB};
  }

  // The model to load now: the player's choice (this.selection), else the older `tier` option, else the default (the largest that fits).
  // A chosen model that is missing or does not fit is replaced by the default, and one 'model-fallback' event names the model used.
  #choose(pack, freeMiB, selected = this.#selected(pack), realFit = {}) {
    this.#lastFreeMiB = Number.isFinite(freeMiB) ? freeMiB : null;
    const sizeOf = file => this.fileSizeMiB(file);
    if (this.tierSetting === 'standard' || this.tierSetting === 'lite') {
      const forced = selected.models.find(model => model.id === this.tierSetting);
      if (!forced) throw new LocalAiUnavailable('not-installed', 'no ' + this.tierSetting + ' model');
      return {model: forced, sizeMiB: Number(sizeOf(forced.file)) || 0, profile: forced.tier, pinned: true, fellBack: null};
    }
    const choice = chooseLocalModel({models: selected.models, pin: selected.pin, matureOn: selected.matureOn, freeMiB, totalMiB: this.#totalMiB, sizeOf, realFit});
    this.#announce(choice, selected);
    return choice;
  }

  // The free-memory fit (bridge/local-vram-fit.mjs) of one model: llama-fit-params' projections for the context ladder against `freeMiB`. Null when there is no tool or no reading.
  async #fitFor(model, freeMiB, marginMiB, device) {
    if (typeof this.fitProbe !== 'function' || !model?.file || !device?.id || !Number.isFinite(freeMiB)) return null;
    const fit = await fitLadder({freeMiB, marginMiB, probe: rung => this.fitProbe({model: model.file, contextSize: rung.contextSize, kvType: rung.kvType, device: device.id})});
    if (fit.projections.every(rung => rung.projectedMiB === null)) return null;
    this.log('[local] fit of ' + (model.loadedName ?? model.name) + ': ' + describeFit(fit, freeMiB, marginMiB));
    return {...fit, marginMiB};
  }

  // The models whose real fit is looked at before a choice, each a few seconds' worth of tool runs at most (in parallel), only when the file-size rule says they do not fit the
  // free memory: the model the player chose and, with Mature content on, the uncensored ones (a Mature model never gives way to a censored one, so it would be loaded with layers
  // on the CPU). Everything else, and every card with room, takes no probe at all and chooses as before. A one-shot plan from a spill reload (#refitPlan) is used as it is.
  async #probeFits(selected, freeMiB, device) {
    const result = {};
    const plan = this.#refitPlan; this.#refitPlan = null;
    if (plan) result[plan.id] = plan.fit;
    if (!Number.isFinite(freeMiB) || typeof this.fitProbe !== 'function' || this.tierSetting === 'standard' || this.tierSetting === 'lite') return result;
    const wanted = selected.models.filter(model => !model.external && model.file && !result[model.id] && !model.broken && !model.stalled
      && (model.id === selected.pin || (selected.matureOn && model.uncensored === true))
      && freeMiB < modelNeedMiB(model, Number(this.fileSizeMiB(model.file)) || 0));
    await Promise.all(wanted.map(async model => {
      try { const fit = await this.#fitFor(model, freeMiB, FIT_LIMITS.marginMiB, device); if (fit) result[model.id] = fit; } catch { /* the file-size rule stands */ }
    }));
    return result;
  }

  // Where a model that does not fit whole goes (bridge/local-vram-fit.mjs offloadPlan): the projection of the offload placement (context 8,192, the 8-bit cache) from the fit that was
  // already looked at, else from one llama-fit-params run (1 to 3 s, nothing allocated; none without the tool: the file size stands in), against the free memory. Never throws.
  async #placeOffload(choice, freeMiB, device, fit) {
    const {offloadContext: contextSize, offloadKvType: kvType} = FIT_LIMITS, model = choice.model;
    let projectedMiB = fit?.projections?.find(rung => rung.contextSize === contextSize && rung.kvType === kvType)?.projectedMiB ?? null;
    if (projectedMiB === null && typeof this.fitProbe === 'function' && model.file && device?.id) {
      try { projectedMiB = await this.fitProbe({model: model.file, contextSize, kvType, device: device.id}); } catch { /* the file size stands in */ }
    }
    // A file whose size is unknown stands in with the fixed need of its tier (the same figure the file-size rule falls back to), so a card with next to nothing free is still refused.
    const size = Number(choice.sizeMiB) || 0;
    return offloadPlan({projectedMiB, sizeMiB: size > 0 ? size : tierNeedMiB(choice.profile, 0) - FIT_LIMITS.offloadEstimateExtraMiB, freeMiB});
  }

  // A model that did not start is announced with the retry (#startOnce, which knows the model used instead); the other reasons here.
  #announce(choice, selected) {
    // 'too-slow' is the step-down (noteStall): it has its own event and notice, emitted when the smaller model is loaded.
    if (choice.fellBack && choice.fellBack !== 'start-failed' && choice.fellBack !== 'too-slow') {
      this.log('[local] the chosen model is not usable (' + choice.fellBack + '): ' + choice.model.name + ' was chosen instead');
      this.emit('model-fallback', {pin: selected.pin, reason: choice.fellBack, model: choice.model.name});
    }
    if (choice.gameReserve) this.log('[local] a small graphics card (' + (this.#totalMiB ?? '?') + ' MiB): room is kept for the game, so ' + choice.model.name + ' was chosen');
    if (choice.offload) this.log('[local] ' + choice.model.name + ' does not fit the free graphics memory whole: it is loaded with part of its layers on the CPU if enough of them can stay on the card'
      + (choice.model.uncensored ? ' (Mature content never uses a censored model)' : ''));
  }

  // The models to choose from now. Without an installed pack there is no llama-server of ours, so only the servers the player runs can answer.
  // A custom model that failed to start (until its file changes or reset()) is marked broken.
  #selected(pack) {
    let picked = null;
    try { picked = typeof this.selection === 'function' ? this.selection() : null; } catch { /* a broken hook means no choice */ }
    let models = listLocalModels({pack, matureModels: picked?.matureModels, customModels: picked?.customModels});
    if (!pack?.installed) models = externalModels(models);
    for (const model of models) if (model.custom && this.#broken.get(model.id) === this.#sizeKey(model)) model.broken = true;
    for (const model of models) if (this.#stalled.has(model.id)) model.stalled = true;
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
    if (model.external) this.#serverWhy = SERVER_DETAILS[why] ?? SERVER_DETAILS.unreachable;
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
    this.#stalled.clear(); this.#refitted.clear(); this.#forcedOffload = null; this.#offloadTried.clear();   // a changed choice is tried whole: nothing stays left out for slow turns
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
    // A pinned model that does not fit the memory the card would have without ours is replaced by the default, which may be the model that is loaded: a reload would only read
    // the same 5 GB again (2026-10-20). Needs a free-memory reading; without one (no NVIDIA card) the reload is done as before.
    if (await this.#reloadWouldKeep(selected)) return false;
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
      throw selected.models.some(model => model.broken) ? new LocalAiUnavailable('start-failed', this.#serverWhy ?? SERVER_DETAILS.unreachable)
        : new LocalAiUnavailable('mature-off', 'the server you added is marked uncensored: choose it in the Local AI model row, or turn Mature content on');
    }
    this.#setState('starting');
    const failedPin = this.#failedPin; this.#failedPin = null;
    if (early) { this.#announce(early, selected); return this.#startExternal(early.model, failedPin, generation); }
    await this.#waitBeforeStart();
    this.#guard(generation);
    const {device, freeMiB} = await this.#selectDevice();
    this.#guard(generation);
    this.#mark('checking which model fits the free graphics memory');
    const realFit = await this.#probeFits(selected, freeMiB, device);
    this.#guard(generation);
    let choice = this.#choose(pack, freeMiB, selected, realFit);
    // The model a step-down or a spill found no smaller model for: the same model, with part of its layers on the CPU (this start only).
    const forced = this.#forcedOffload; this.#forcedOffload = null;
    if (forced !== null && forced === choice.model.id && choice.model.external !== true && choice.offload !== true) choice = {...choice, offload: true};
    // With the card's numbers a file model turned out too large for it, and a server the player runs is the last resort: use it.
    if (choice.model.external === true) return this.#startExternal(choice.model, failedPin, generation);
    // Part of the model on the CPU: where the fit pass would put it. Any share loads, 0% included (owner decision 2026-10-21, "allow, warn once"): under FIT_LIMITS.hopelessShare the model runs mostly
    // on the processor (36 to 54 prompt tokens a second in the 2026-10-19 reports, 2 generated tokens a second at 0%), so the player is told once ('offload-slow': the game's 'local-cpu' notice, which
    // names a smaller model and the Custom provider, never a cloud provider). What stops the load is the processor's side: the part of the model and its cache that stay in system memory must fit it.
    let placement = null;
    if (choice.offload === true) {
      placement = await this.#placeOffload(choice, freeMiB, device, realFit[choice.model.id] ?? null);
      this.#guard(generation);
      const ram = offloadRamNeedMiB({share: placement.share, sizeMiB: Number(choice.sizeMiB) || 0, projectedMiB: placement.projectedMiB});
      const freeRam = Number(this.freeMemMiB());
      if (ram !== null && Number.isFinite(freeRam) && freeRam < ram) {
        this.log('[local] ' + choice.model.name + ' cannot run partly on the processor: about ' + Math.round(ram) + ' MiB of system memory are needed for its CPU part and cache, ' + Math.round(freeRam)
          + ' MiB are free: close programs, or choose a smaller model in Settings, or use the Custom provider');
        throw new LocalAiUnavailable('start-failed', LOW_RAM);
      }
      if (placement.hopeless) {
        this.log('[local] ' + choice.model.name + ' will run mostly on the processor: only about ' + Math.round(placement.share * 100) + '% of its layers fit the graphics card with ' + placement.targetMiB
          + ' MiB kept free for the game (' + (Number.isFinite(freeMiB) ? Math.round(freeMiB) : '?') + ' MiB free); replies will be slow (a smaller model or the Custom provider is faster)');
        this.emit('offload-slow', {id: choice.model.id, model: choice.model.loadedName ?? choice.model.name, share: placement.share});
      }
    }
    if (failedPin) this.emit('model-fallback', {pin: failedPin, reason: 'start-failed', model: choice.model.name});
    this.#announceStep(choice.model.id, choice.model.name);
    const tierKey = choice.profile, tier = choice.model;
    // The free-memory fit, when it was looked at (the file-size rule said no room): its context and cache type keep the whole model on the card; with no rung that fits the model is
    // loaded with layers on the CPU (the offload placement below: context 8,192, the 8-bit cache).
    const fit = realFit[tier.id] ?? null;
    const fitted = fit?.pick && !tier.contextSize && !this.contextSize && choice.offload !== true ? fit.pick : null;
    const kvType = placement ? placement.kvType : fitted?.kvType ?? null;
    const contextSize = tier.contextSize ?? this.contextSize ?? (placement ? placement.contextSize : fitted?.contextSize ?? chooseContext({tier: tierKey, freeMiB, sizeMiB: choice.sizeMiB}));
    const threads = placement ? offloadThreads(Number(this.cpuCount())) : null;
    if (placement) this.log('[local] partial offload: ' + (tier.loadedName ?? tier.name) + ', ' + (placement.share === null ? 'the share of its layers on the card is unknown' : 'about ' + Math.round(placement.share * 100) + '% of its layers on the card')
      + (placement.projectedMiB === null ? '' : ' (' + (placement.estimated ? 'estimated from the file, ' : 'projected ') + placement.projectedMiB + ' MiB at ' + placement.contextSize + ' ' + placement.kvType + ' against ' + (Number.isFinite(freeMiB) ? Math.round(freeMiB) : '?') + ' MiB free)')
      + ', context ' + contextSize + ', ' + kvType + ' cache, fit target ' + placement.targetMiB + ' MiB kept free for the game, ' + threads + ' CPU threads');
    this.#tier = tierKey; this.#model = tier.loadedName ?? tier.name; this.#modelId = tier.id; this.#contextSize = contextSize;
    this.#hints = tier.custom ? {uncensored: tier.uncensored === true, family: tier.family ?? null} : null;
    const cacheRamMiB = this.cacheRamMiB ?? defaultCacheRamMiB(Number(this.freeMemMiB()));
    const signature = this.#signature(tier.file);
    this.#loadWarmed();
    this.#firstTime = this.warmup && !this.#warmed.has(signature);
    this.#emitStatus();

    this.#loaded = {id: tier.id, name: tier.loadedName ?? tier.name, file: basename(String(tier.file)), family: modelFamily({family: tier.family, name: tier.name, file: tier.file}),
      tier: tierKey, sizeMiB: Math.round(Number(choice.sizeMiB) || 0), device: {id: device.id, name: device.name, freeMiB: Number.isFinite(freeMiB) ? Math.round(freeMiB) : null},
      contextSize, cacheRamMiB, priority: 'normal', ram: {freeMiB: Math.round(Number(this.freeMemMiB())) || null, totalMiB: Math.round(totalmem() / 1048576)}, offload: choice.offload === true, custom: tier.custom === true, templateFlag: tier.chatTemplate ? String(tier.chatTemplate) : null,
      template: null, bos: null, eos: null, build: null, ftype: null, loadMs: null, warmMs: null, firstTime: this.#firstTime, readyAt: null,
      kvType, fit: fit ? {pick: fit.pick ? {contextSize: fit.pick.contextSize, kvType: fit.pick.kvType, projectedMiB: fit.pick.projectedMiB} : null, share: fit.share ?? null, marginMiB: fit.marginMiB ?? null} : null,
      gpuShare: choice.offload === true && Number.isFinite(placement?.share) ? placement.share : null,
      forcedOffload: forced !== null && forced === choice.model.id,
      offloadPlan: placement ? {share: placement.share === null ? null : Math.round(placement.share * 100) / 100, projectedMiB: placement.projectedMiB, estimated: placement.estimated, fitTargetMiB: placement.targetMiB, threads} : null};
    this.#turns.sinceStart = 0; this.#stalls = 0;
    const began = this.now();
    const proc = new LlamaProcess({command: this.command, argsPrefix: this.argsPrefix, spawnImpl: this.spawnImpl, fetchImpl: this.fetchImpl,
      startupMs: this.startupMs, log: this.log, label: 'llama-server', lowerAfter: 'ready',
      buildArgs: ({port, keyFile}) => buildServerArgs({model: tier.file, port, keyFile, device: device.id, contextSize, cacheRamMiB, chatTemplate: tier.chatTemplate, offload: choice.offload === true, kvType,
        fitTargetMiB: placement?.targetMiB ?? null, threads}),
      ...this.processOptions});
    this.#proc = proc;
    proc.on('exit', info => this.#onExit(proc, info));
    this.#mark('loading the model into the server (waiting for it to answer)');
    try {
      await proc.start();
    } catch (error) {
      if (this.#proc === proc) this.#proc = null;
      await proc.stop();
      this.#guard(generation);
      this.log('[local] llama-server did not start: ' + (error?.code || error?.message) + ' (' + this.#loaded.file + ', context ' + contextSize + ')');
      this.#logTail(proc, 'it did not start');
      if (tier.custom && error?.code !== 'stopped') { this.#modelFailed(tier, error?.code || 'error'); return this.#startOnce(); }
      throw new LocalAiUnavailable('start-failed', looksBlocked(error) ? BLOCKED : error?.code);
    }
    this.#guard(generation);
    this.#mark('reading the server settings');
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
      this.#mark(this.#firstTime ? 'the first warm-up request (shaders compile)' : 'a warm-up request');
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
    // Loaded and warm (the shader compile of a first start and the first prompts are CPU work too): now the game gets the CPU back, and generation, which
    // runs on the graphics card, keeps its speed at the lower priority.
    this.#loaded.priority = proc.lower() ? 'below-normal' : 'normal';
    this.#raised = false;
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
    this.#turns.sinceStart = 0; this.#stalls = 0; this.#stepFrom = null;
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
    // The diagnostics (a turn's log line, the support report) name the context the prompts are fitted to, not the 0 of an entry that left it to the server.
    this.#loaded.contextSize = found.contextSize;
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
      loaded.sizeMiB ? `${loaded.sizeMiB} MiB` : null, `context ${loaded.contextSize}`, loaded.kvType ? `${loaded.kvType} cache` : null, loaded.offload ? 'part on the CPU' : null,
      loaded.fit?.pick ? `whole model on the card by the free-memory fit (${loaded.fit.pick.projectedMiB} MiB projected)` : null,
      loaded.offload && Number.isFinite(loaded.gpuShare) ? `about ${Math.round(loaded.gpuShare * 100)}% of the layers on the card` : null,
      loaded.offloadPlan ? `fit target ${loaded.offloadPlan.fitTargetMiB} MiB free for the game, ${loaded.offloadPlan.threads} CPU threads` : null,
      loaded.device ? `device ${loaded.device.id}${loaded.device.freeMiB === null ? '' : ' (' + loaded.device.freeMiB + ' MiB free before)'}` : null,
      loaded.priority === 'below-normal' ? 'process priority normal while it loaded, below normal now (the game keeps the CPU)' : null, loaded.ram?.freeMiB ? `system memory ${loaded.ram.freeMiB} of ${loaded.ram.totalMiB} MiB free` : null, `template ${template}`, loaded.template ? `"${loaded.template.head}"` : null, loaded.eos ? `eos ${loaded.eos}` : null, loaded.build ? `build ${loaded.build}` : null,
      loaded.loadMs === null ? null : `loaded in ${(loaded.loadMs / 1000).toFixed(1)} s`, loaded.warmMs === null ? null : `warm-up ${(loaded.warmMs / 1000).toFixed(1)} s${loaded.firstTime ? ' (first time)' : ''}`]
      .filter(Boolean).join(', ');
  }

  // The last lines the child printed (the key is redacted), for a start that failed or a server that stopped: why is in there (an allocation that failed, a model it cannot read).
  // One log line per output line, the newest last: the error report cuts every log line at 300 characters, so a single joined line lost the last
  // lines (the reason) and kept the start-up banner (a 0.2.7 report: "llama-server did not start: exited" and nothing after the banner).
  #logTail(proc, why) {
    let lines = [];
    try { lines = String(proc?.tail?.() ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-6).map(line => line.slice(0, 220)); } catch { /* best effort */ }
    lines.forEach((line, index) => this.log('[local] last llama-server output (' + why + ') ' + (index + 1) + '/' + lines.length + ': ' + line));
  }

  /**
   * What is loaded and how the turns went, for the log and the support report: plain data, no path (file names only), no key, no text of any reply.
   * {state, model: {id, name, file, family, tier, sizeMiB, offload, custom, external}, engine: {build, ftype, device, contextSize, cacheRamMiB, priority, ram: {freeMiB, totalMiB}}, template: {source, chars,
   * sha, head}, tokens: {bos, eos}, start: {loadMs, warmMs, firstTime, readyAt}, turns: {ok, failed}, lastTurn, lastExit}. null when nothing was loaded yet.
   */
  diagnostics() {
    const loaded = this.#loaded;
    if (!loaded) return null;
    return {state: this.#state, ...(this.#reason ? {reason: this.#reason} : {}),
      model: {id: loaded.id, name: String(loaded.name ?? '').slice(0, 80), file: loaded.file, family: loaded.family, tier: loaded.tier, sizeMiB: loaded.sizeMiB, offload: loaded.offload,
        custom: loaded.custom, ...(loaded.external ? {external: true} : {})},
      engine: {build: loaded.build, ftype: loaded.ftype, device: loaded.device ? {id: loaded.device.id, name: String(loaded.device.name ?? '').slice(0, 60), freeMiB: loaded.device.freeMiB} : null,
        contextSize: loaded.contextSize, cacheRamMiB: loaded.cacheRamMiB, priority: loaded.priority ?? null, ram: loaded.ram ?? null,
        ...(loaded.kvType ? {kvType: loaded.kvType} : {}), ...(loaded.fit ? {fit: loaded.fit} : {}), ...(loaded.offloadPlan ? {offloadPlan: loaded.offloadPlan} : {}), ...(loaded.spill ? {spill: loaded.spill} : {})},
      template: loaded.template ? {source: loaded.templateFlag ? 'flag:' + loaded.templateFlag : 'gguf', ...loaded.template} : {source: loaded.templateFlag ? 'flag:' + loaded.templateFlag : 'not reported'},
      tokens: {bos: loaded.bos, eos: loaded.eos},
      start: {loadMs: loaded.loadMs, warmMs: loaded.warmMs, firstTime: loaded.firstTime, readyAt: loaded.readyAt ? new Date(loaded.readyAt).toISOString() : null},
      turns: {ok: this.#turns.ok, failed: this.#turns.failed}, lastTurn: this.#lastTurn, lastExit: this.#lastExit,
      queue: {...this.#queue, inflight: this.#inflight},
      ...(this.#stalled.size ? {steppedDown: [...this.#stalled].slice(0, 4)} : {})};
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
          ...(t.queue ? {waitedMs: t.queue.waitMs, behind: t.queue.behind} : {}),
          ...(t.timings ? {promptTokens: t.timings.promptTokens, cachedTokens: t.timings.cachedTokens, tokensPerSecond: Number.isFinite(t.timings.tokensPerSecond) ? Math.round(t.timings.tokensPerSecond * 10) / 10 : null} : {}),
          ...(t.finishReason ? {finishReason: t.finishReason} : {})} : {})};
      if (!ok || first) this.emit('diagnostics', this.diagnostics());
      if (ok) {
        this.#stalls = 0;
        // A reply that came but was written slowly is not a stall; the counters tell whether the model sits in shared memory (a spill answers at 1 to 5 tokens a second, so it is acted on).
        if (slowReply({tokensPerSecond: t?.timings?.tokensPerSecond, pieces: t?.pieces})) void this.#checkSpill('a slow reply (' + Math.round(t.timings.tokensPerSecond * 10) / 10 + ' tokens a second)');
      } else if (error?.slow === true && STALL_REASONS.has(error?.reason) && !noRequestMade(error, t)) this.noteStall('a turn: ' + (detail ? oneLine(detail, 100) : error.reason));
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
      // A refusal's words are read: one that says the prompt is longer than the server's context teaches it (a persona warm-up is the first request that hits it).
      let words = '';
      if (!response.ok && typeof response.text === 'function') words = await response.text().catch(() => '');
      else await response.arrayBuffer?.().catch(() => {});
      if (!response.ok) {
        let body = null; try { body = JSON.parse(words); } catch { /* not JSON */ }
        const refused = contextRefusal(response.status, typeof body?.error?.message === 'string' ? body.error.message : words, body);
        throw Object.assign(Error('HTTP ' + response.status), refused ? {overflow: refused} : {});
      }
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
    this.#restartAfterLoss(proc, 'llama-server stopped unexpectedly (exit ' + (code ?? signal ?? '?') + ')', 'it stopped unexpectedly');
  }

  // Our own server is gone while the state still says ready: forget it, say why in the log, and start it again (up to maxRestarts attempts).
  // Callers of ensure() wait for that start.
  #restartAfterLoss(proc, line, why) {
    this.#proc = null; this.#info = null;
    this.#disarm(); this.#dropHold();
    this.log('[local] ' + line);
    this.#logTail(proc, why);
    this.emit('diagnostics', this.diagnostics());
    this.#setState('starting');
    this.#launch(true);
  }

  /**
   * A chat request to our own llama-server could not connect (or came back with a server fault) and the caller wants to know whether it is worth asking again.
   * Looks at the server once: when it answers /health the failure was something else and this returns null. When it does not, the server is
   * gone (a crash whose exit has not been reported yet is the usual case: Windows keeps a crashed process listed while it writes its report), so it is ended and
   * started again here, once, unless the exit handler already did. Then waits for the start (`signal` bounds the wait) and returns the new handle
   * {endpoint, apiKey, model, ...}: the old address and key died with the old process. Throws LocalAiUnavailable('crashed' ...) when it
   * cannot be started again. A server the player runs is not ours to restart: null. Never called per frame: only after a failed request.
   */
  async recover({signal, deviceLost = false, invalidBatch = false} = {}) {
    signal?.throwIfAborted();
    if (this.#info?.external) return null;
    const proc = this.#proc;
    // "Invalid input batch": the second such answer of one server process (or one after the server's log showed the fault) is the state a device fault leaves behind, not a bad request.
    if (invalidBatch && !deviceLost && proc) {
      if (this.#batchFaults.proc !== proc) this.#batchFaults = {proc, count: 0};
      if (++this.#batchFaults.count >= 2) deviceLost = true;
    }
    // A lost graphics device leaves llama-server alive and answering /health, but every request fails (2026-10-20 report: an RX 580 failed seven turns in a row): the
    // words of the failed request, or of the server's own log, send it to noteDeviceLost (restart, or a smaller model the second time) without the health check.
    if (this.#state === 'ready' && proc && (deviceLost || this.#tailSaysDeviceLost(proc)) && await this.noteDeviceLost('a failed request')) return this.ensure({signal});
    if (this.#state === 'ready' && proc) {
      if (await proc.answers()) return null;
      // The exit event may be a moment away; the process may also be alive and deaf (its listening socket closed). Either way it is no use.
      const gone = await proc.waitForExit(1500);
      if (!gone && this.#state === 'ready' && this.#proc === proc) {
        this.#lastExit = {code: null, signal: null, at: new Date(this.now()).toISOString(), state: this.#state};
        this.#restartAfterLoss(proc, 'llama-server stopped answering (no answer on /health): ending it and starting it again', 'it stopped answering');
        proc.stop().catch(() => {});
      }
    }
    // Starting, warming, stopped or restarted just now: ensure() waits for the start (or begins one) and hands out the new address and key.
    return this.ensure({signal});
  }

  #tailSaysDeviceLost(proc) {
    try { return DEVICE_FAULT.test(String(proc?.tail?.() ?? '')); } catch { return false; }
  }

  /**
   * A request failed because the graphics device was lost (Vulkan ErrorDeviceLost: a driver reset, the game taking the card). llama-server stays alive and its /health keeps
   * answering, so recover()'s health check would call it fine while every turn fails. The first loss of a session ends the server and starts it again (after
   * deviceLostPauseMs, which gives the driver time to reset); the second (deviceLostStepDown) steps down one model size as after stalled turns (#stepDown: its notice, the model
   * left out for the session, the same model with part of it on the CPU when none is smaller) and the count starts again for the model loaded then. A model the player added is only restarted, and
   * after two more losses with nowhere to step down Local AI is marked failed rather than restarted for ever. One process counts once. Returns 'restart', 'step', 'failed' or
   * null when nothing was done (a server the player runs, a start already under way). Never throws. Only after a failed request: nothing runs per frame.
   */
  async noteDeviceLost(what = 'a request') {
    try {
      const proc = this.#proc;
      if (this.#state !== 'ready' || !proc || this.#info?.external || this.#stepping || proc === this.#lostProc) return null;
      this.#lostProc = proc;
      this.#deviceLosses++;
      const needed = LOCAL_LLM_LIMITS.deviceLostStepDown;
      this.log('[local] the graphics device was lost or ran out of memory (' + what + '; ' + this.#deviceLosses + ' since the session began or the last step down)');
      const from = this.#selected(this.pack).models.find(model => model.id === this.#modelId);
      this.#coolDownMs = this.deviceLostPauseMs;
      if (this.#deviceLosses >= needed && from && from.custom !== true) {
        this.#deviceLosses = 0;
        this.#beginStep();
        try { await this.#stepDown({cause: 'lost'}); } finally { this.#endStep(); }
        return 'step';
      }
      if (this.#deviceLosses >= needed + 2) {
        this.#coolDownMs = 0;
        this.log('[local] the graphics device keeps being lost and there is no smaller model to step down to');
        this.#fail('crashed');
        return 'failed';
      }
      this.#lastExit = {code: null, signal: null, at: new Date(this.now()).toISOString(), state: this.#state};
      this.#restartAfterLoss(proc, 'llama-server lost the graphics device: ending it and starting it again', 'the graphics device was lost');
      proc.stop().catch(() => {});
      return 'restart';
    } catch { return null; }
  }

  // --- idle handling ------------------------------------------------------------------------------------------

  // A use of the server: restarts the idle countdown.
  touch() { if (this.#state === 'ready') this.#arm(); }

  // Marks a request in flight (blocks the idle stop). Returns a one-shot release function; end() is the manual form.
  // `background`: work no player is waiting on (a persona warm-up, the memory work after a reply) does not raise the child's priority.
  // `cancel` (background work only): how to stop this request; a turn calls it through preempt() so the single slot is free for the turn.
  begin({background = false, cancel = null} = {}) {
    this.#inflight++;
    this.#disarm();
    if (!background) { this.#foreground++; this.#raise(); }
    else if (typeof cancel === 'function') this.#yieldable.add(cancel);
    // The first request the model gets after a load, and a turn that has had no answer after SPILL_LIMITS.noHeadersMs, read the memory counters once (nothing per frame, nothing per turn).
    this.#lookAfterLoad(background ? 'the first persona warm-up after the load' : 'the first turn after the load');
    const watch = background ? null : this.#watchHeaders();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#unwatch(watch);
      if (!background) { this.#foreground = Math.max(0, this.#foreground - 1); this.#foregroundEndedAt = this.now(); }
      else if (typeof cancel === 'function') this.#yieldable.delete(cancel);
      this.end();
    };
  }
  /** The route calls this when a request's response headers arrive: the turn is being answered, so the wait for them (#watchHeaders) ends. */
  noteHeaders() { for (const timer of this.#headerWatch) this.clearTimer(timer); this.#headerWatch.clear(); }

  // One look at the memory counters at the first request of a load (a model that spilled at the load, or was moved while it sat idle, is found now, not 60 to 75 s into the first turn).
  #lookAfterLoad(why) {
    try {
      const loaded = this.#loaded;
      if (!loaded || loaded.looked === true || this.#state !== 'ready' || this.#info?.external || typeof this.gpuMemory !== 'function') return;
      loaded.looked = true;
      void this.#checkSpill(why, {every: 0});
    } catch { /* a look is best effort */ }
  }

  // A foreground request that has had no response headers after SPILL_LIMITS.noHeadersMs: the model may be reading at a crawl from shared memory, so the counters are read once now.
  #watchHeaders() {
    try {
      if (this.#info?.external || typeof this.gpuMemory !== 'function' || !(SPILL_LIMITS.noHeadersMs > 0)) return null;
      const timer = this.setTimer(() => {
        this.#headerWatch.delete(timer);
        void this.#checkSpill('no answer from the model server after ' + Math.round(SPILL_LIMITS.noHeadersMs / 1000) + ' s', {every: SPILL_LIMITS.earlyCheckEveryMs});
      }, SPILL_LIMITS.noHeadersMs);
      timer?.unref?.();
      this.#headerWatch.add(timer);
      return timer;
    } catch { return null; }
  }
  #unwatch(timer) { if (timer === null || timer === undefined) return; this.clearTimer(timer); this.#headerWatch.delete(timer); }

  end() {
    if (this.#inflight > 0) this.#inflight--;
    if (this.#inflight === 0) { this.#holdThenLower(); this.touch(); if (this.#reselectPending) void this.#reloadIfIdle(); }
  }
  get inflight() { return this.#inflight; }

  // A request starts: the child runs at normal priority until priorityHoldMs after the last one ends (two system calls per turn, nothing per frame).
  #raise() {
    if (this.#holdTimer) { this.clearTimer(this.#holdTimer); this.#holdTimer = null; }
    const proc = this.#proc;
    if (!this.#raised && proc?.raise()) this.#raised = true;
  }
  #holdThenLower() {
    if (!this.#raised) return;
    if (this.#holdTimer) this.clearTimer(this.#holdTimer);
    this.#holdTimer = this.setTimer(() => {
      this.#holdTimer = null;
      if (this.#inflight > 0 || !this.#raised) return;
      this.#raised = false;
      this.#proc?.lower();
    }, this.priorityHoldMs);
    this.#holdTimer?.unref?.();
  }

  #arm() {
    this.#disarm();
    if (this.#state !== 'ready' || this.#inflight > 0 || !(this.idleMs > 0) || this.#info?.external) return;   // a server the player runs holds nothing of ours
    this.#idleTimer = this.setTimer(() => this.#idleFire(), this.idleMs);
    this.#idleTimer?.unref?.();
  }
  #disarm() { if (this.#idleTimer) this.clearTimer(this.#idleTimer); this.#idleTimer = null; }
  // The hold on the child's priority belongs to the child that was raised: it goes with it (stopped, died, idle) and never reaches a later one.
  #dropHold() { if (this.#holdTimer) this.clearTimer(this.#holdTimer); this.#holdTimer = null; this.#raised = false; }

  #idleFire() {
    this.#idleTimer = null;
    if (this.#state !== 'ready' || this.#inflight > 0) return;
    this.#dropHold();
    const proc = this.#proc; this.#proc = null; this.#info = null;
    this.#setState('stopped');
    this.log('[local] idle: stopping the local model server');
    proc?.stop().catch(() => {});
  }

  // --- prompt cache -------------------------------------------------------------------------------------------

  // Best effort, never throws: leaves the static persona prefix in llama-server's prompt cache.
  // The server has ONE slot (-np 1): a request that arrives while this one is being read waits for it, and on a computer that reads a prompt at
  // 40 to 300 tokens a second (the game keeps the card busy) a 4,500-token persona takes a minute or more: the first player reports
  // (2026-10-19) had a turn wait 60 s, "no response", behind a warm-up of another character. So a warm-up never stands in a turn's way:
  // `key` says whose persona it reads (the profile), a turn for another one stops it (`preempt`), and so does a newer warm-up for another one.
  // A turn for the SAME character does not stop it: it needs that very prefix, which the warm-up is putting in the cache.
  async prewarm(messages, {key = null} = {}) {
    let release = null, mine = null;
    try {
      const info = await this.ensure();
      if (info.external && this.#info?.remote) return false;   // nothing is sent to a remote server ahead of a turn
      // A turn is being served (or waits): a warm-up now would queue behind it and then replace the prompt it leaves in the slot with the bare persona.
      if (this.#foreground > 0) { this.#queue.warmSkipped++; return false; }
      // The slot already holds this persona, under a longer prompt (the last turn's): a warm-up reads the bare persona, a prefix of that prompt, so it would only
      // cut the slot down to the head (a model with sliding-window or recurrent layers resumes only from a checkpoint, and the next turn then reads the whole
      // world block again: the 2026-10-19 reports show 2,350 of 5,400 tokens held, every turn). Opening the composer asks for a warm-up each time.
      if (key !== null && this.#slotHolds(key)) { this.#queue.warmSkipped++; return false; }
      this.preempt(key);
      if (this.#prewarming) return false;   // the same character's persona is already being read: a second request would only queue behind it
      mine = {key, controller: new AbortController()};
      this.#prewarming = mine;
      release = this.begin({background: true});
      await this.#complete(info, messages, {signal: mine.controller.signal});
      this.#stalls = 0;
      this.noteSlot(key);
      return true;
    } catch (error) {
      this.log(mine?.controller.signal.aborted ? '[local] persona prewarm stopped: another request needed the model first'
        : '[local] persona prewarm skipped: ' + (error?.message || 'error'));
      // A refusal for length is an answer, not a server that is down: the context is learned, nothing is marked lost.
      if (error?.overflow && !mine?.controller.signal.aborted) this.learnContext(error.overflow.contextTokens);
      // A warm-up that got no answer in its whole wait (#complete) is a stall like a turn's; one that was stopped for a turn, or that failed for another reason, is not.
      if (!mine?.controller.signal.aborted && /^no answer in \d+ s/.test(String(error?.message))) this.noteStall('a persona warm-up: ' + oneLine(error.message, 100));
      return false;
    } finally {
      if (this.#prewarming === mine) this.#prewarming = null;
      release?.();
    }
  }

  /**
   * A real request is about to be sent for the character `keep` (a profile key, or null for any): a warm-up in flight for another character is
   * stopped, so the single slot is free for the request, and so is every background request in flight (a summary, memory work: nobody waits for
   * those and a player waits for this request; a typed line waited behind a summary for tens of seconds). Returns whether one was. Never throws.
   */
  preempt(keep = null) {
    let stopped = false;
    for (const cancel of [...this.#yieldable]) {
      this.#yieldable.delete(cancel);
      try { cancel(); stopped = true; this.#queue.stopped++; } catch { /* already finished */ }
    }
    const warming = this.#prewarming;
    if (!warming || (keep !== null && warming.key === keep)) return stopped;
    this.#prewarming = null;
    try { warming.controller.abort(); } catch { /* already finished */ }
    this.#queue.stopped++;
    return true;
  }

  /** The persona (profile key) a request puts into the slot, or null when it is not a persona prompt (an action decision); a finished persona warm-up sets it too. */
  noteSlot(key) {
    this.#slot = typeof key === 'string' && key ? {key, readyAt: this.#loaded?.readyAt ?? 0} : null;
  }
  // Does the slot, as this load of the model left it, hold this persona's prompt?
  #slotHolds(key) { return this.#slot !== null && this.#slot.key === key && this.#slot.readyAt === (this.#loaded?.readyAt ?? 0); }

  /**
   * Why work no player is waiting on (a summary, memory work) must not start now, or null: a turn is being served, one ended a moment ago, or another such
   * request already holds the slot (one at a time, so they never pile up behind each other or behind a turn). The caller skips the work and tries again later.
   */
  backgroundRefusal() {
    let why = null;
    if (this.#foreground > 0) why = 'a turn is using the model';
    else if (this.now() - this.#foregroundEndedAt < this.backgroundQuietMs) why = 'a turn has just ended';
    else if (this.#yieldable.size > 0) why = 'other background work is running';
    if (why) this.#queue.refused++;
    return why;
  }

  // --- stalled turns: step down ---------------------------------------------------------------------------------

  /**
   * One request of the loaded model stalled (no answer, a prompt read that stopped, a reply that went quiet; the host reports a turn through noteTurn, the
   * warm-up is counted here). The game takes the graphics memory after the model was loaded, the driver moves the model into shared system memory and the
   * prompt is then read at a crawl; a second stall (stallStepDown; the first on a small card the model does not leave room on), with no answer in between, steps down: the model is left out for this session and the next
   * smaller installed model of the same family is loaded (Mature good to lite, standard to lite; never a censored model for an uncensored one), and when there is
   * none the same model is loaded with part of its layers on the CPU, or the server fails with 'low-memory' (detail 'too-small', a local notice; #stepDown). The saved choice stays. Models the player added and servers the player runs
   * never step down. One free-memory reading (nvidia-smi) goes into the log, only now. Never throws, never blocks the caller. Returns whether a step was started.
   */
  noteStall(what = 'a request') {
    try {
      if (this.#state !== 'ready' || this.#info?.external || this.#stepping || !this.#modelId) return false;
      this.#stalls++;
      // On a card of about 8 GB or less a model that leaves the game under SMALL_CARD_GAME_RESERVE_MIB (a pinned Mature good model: 2026-10-20 reports of a 4060, a
      // 3070 and a 5060 Ti, each read the prompt at 50 to 120 tokens a second and waited out 75 s twice) steps down at its first stall: the second one is another
      // 75 s turn the player waits through for a model that cannot run beside the game.
      // The same for a model loaded with so few layers on the card that the CPU does the work (the fit said under hopelessShare: 2026-10-20 report of a 5 GB model on an 8 GB card
      // with 123 to 314 MiB free, 60 s twice): the second stall is another turn lost for nothing.
      // And a model loaded after a step-down, again with layers on the CPU (the card has no room for it either, now that the game holds it): its second stall is another
      // 60 to 75 s turn for a model the game leaves no room for (2026-10-20 reports of a 3060 Ti: Gemma stepped down to Qwen "part on the CPU", and its two stalls were two more failed turns).
      const needed = this.#stallsNeeded();
      this.log('[local] ' + this.#model + ' stalled (' + this.#stalls + ' of ' + needed + '): ' + what);
      if (this.#stalls < needed) { void this.#checkSpill('a stall'); return false; }
      this.#beginStep();
      void this.#stepDown().catch(() => {}).finally(() => { this.#endStep(); });
      return true;
    } catch { return false; }
  }

  #stallsNeeded() { return this.#oversizeForCard() || this.#hopelessOffload() || this.#offloadedAfterStep() ? 1 : LOCAL_LLM_LIMITS.stallStepDown; }

  /**
   * Would one more stall step the model down, or is a step down under way? The host then keeps a reply that repeats a line instead of asking for another one (a request that would
   * only wait for the reload). A plain read of fields already held: nothing is measured, nothing runs per frame. A server the player runs never steps down.
   */
  stepDownNear() {
    try {
      if (this.#info?.external) return false;
      if (this.#stepping) return true;
      return this.#state === 'ready' && !!this.#modelId && this.#stalls > 0 && this.#stalls + 1 >= this.#stallsNeeded();
    } catch { return false; }
  }

  // Does the loaded model leave the game too little of a small card (the room the default choice keeps, bridge/local-model-choice.mjs)? Only a model of a pack:
  // one the player added, and a server the player runs, are theirs.
  #oversizeForCard() {
    try {
      const total = Number(this.#totalMiB);
      if (!(total > 0 && total <= SMALL_CARD_MAX_MIB)) return false;
      const from = this.#selected(this.pack).models.find(model => model.id === this.#modelId);
      if (!from || from.custom === true || from.external === true) return false;
      const size = Number(this.fileSizeMiB(from.file)) || 0;
      return size > 0 && modelNeedMiB(from, size) > total - SMALL_CARD_GAME_RESERVE_MIB;
    } catch { return false; }
  }

  // This session already stepped a model down, and the one loaded now has part of its layers on the CPU.
  #offloadedAfterStep() { return (this.#stalled.size > 0 || this.#loaded?.forcedOffload === true) && this.#loaded?.offload === true; }

  #hopelessOffload() {
    const loaded = this.#loaded;
    return loaded?.offload === true && Number.isFinite(loaded.gpuShare) && loaded.gpuShare < FIT_LIMITS.hopelessShare;
  }

  /**
   * Would a reload for the changed choice end on the model that is loaded? The card's free memory now holds our own model, so it is added back (the process's dedicated usage, from
   * the Windows counters), the real fit of the models in play is looked at, and the choice is made on that. True (nothing to reload) when it picks the loaded model with the same
   * placement; the notice of a chosen model that does not fit is still sent. False when anything is unknown.
   */
  async #reloadWouldKeep(selected) {
    try {
      if (!this.#loaded || this.#info?.external || !this.#proc?.pid || typeof this.gpuMemory !== 'function') return false;
      const [free, mine] = [Number(await this.freeVramMiB()), await this.gpuMemory(this.#proc.pid)];
      if (!Number.isFinite(free) || !Number.isFinite(mine?.dedicatedMiB) || mine.dedicatedMiB <= 0) return false;
      const room = free + mine.dedicatedMiB;
      const realFit = await this.#probeFits(selected, room, this.#device);
      const choice = chooseLocalModel({models: selected.models, pin: selected.pin, matureOn: selected.matureOn, freeMiB: room, totalMiB: this.#totalMiB, sizeOf: file => this.fileSizeMiB(file), realFit});
      if (choice.model.id !== this.#modelId || (choice.offload === true) !== (this.#loaded.offload === true)) return false;
      this.log('[local] the model choice changed, but ' + this.#model + ' is what the free graphics memory (' + Math.round(room) + ' MiB with ours) allows: it stays loaded');
      this.#announce(choice, selected);
      return true;
    } catch { return false; }
  }

  /**
   * The driver moved part of the loaded model into shared system memory (the game took the card): the counters of the server's process say it, from one reading. Looked at after a slow
   * reply or a stall, at most every SPILL_LIMITS.checkEveryMs (the `every` option: a shorter gap, for the two early looks of #lookAfterLoad and #watchHeaders), never otherwise. A spill is
   * acted on at once: see #spillAct. Never throws, never blocks the caller.
   */
  async #checkSpill(why, {every = SPILL_LIMITS.checkEveryMs} = {}) {
    try {
      if (this.#checking || this.#state !== 'ready' || this.#info?.external || !this.#proc?.pid || typeof this.gpuMemory !== 'function') return false;
      if (this.now() - this.#spillAt < every) return false;
      this.#checking = true; this.#spillAt = this.now();
      const generation = this.#generation, proc = this.#proc;
      const memory = await this.gpuMemory(proc.pid);
      if (!memory || generation !== this.#generation || this.#proc !== proc) return false;
      const verdict = spillVerdict(memory);
      if (this.#loaded) this.#loaded.spill = {at: new Date(this.now()).toISOString(), dedicatedMiB: memory.dedicatedMiB, sharedMiB: memory.sharedMiB, spilledMiB: verdict.spilledMiB, spilled: verdict.spilled};
      this.log('[local] graphics memory of the model server after ' + why + ': ' + memory.dedicatedMiB + ' MiB on the card, ' + memory.sharedMiB + ' MiB in shared system memory'
        + (verdict.spilled ? ' (spilled: ' + verdict.spilledMiB + ' MiB beyond the usual)' : ''));
      if (!verdict.spilled || this.#stepping) return false;
      this.#beginStep();
      try { await this.#spillAct(verdict); } finally { this.#endStep(); }
      return true;
    } catch { return false; } finally { this.#checking = false; }
  }

  /**
   * A model spilled into shared memory: it reads at a crawl (83 to 3.9 generated tokens a second measured). The card the game leaves is smaller than it was at the load, so the model is
   * unloaded (its memory goes back at once), the free memory is read, and the same model is loaded again fitted to what is free now, once per model per session: the largest context
   * of the ladder whose projection plus FIT_LIMITS.refitMarginMiB fits, with the 8-bit KV cache as the last rung (the whole model on the card: a model half on the CPU reads prompts
   * no faster). When no rung fits, or the refit spilled again, the next smaller model of its family is loaded (#stepDown), and with none the same model is loaded with part of its
   * layers on the CPU (any share loads; under FIT_LIMITS.hopelessShare the player is told once), else, after three such reloads, Local AI is unavailable ('low-memory', TOO_SMALL: no cloud provider takes the turns).
   * The saved choice is never changed. A model the player added is handled the same way (it was left alone before: a spilled one stayed at 1 to 5 tokens a second).
   */
  async #spillAct(verdict) {
    const fromId = this.#modelId, selected = this.#selected(this.pack);
    const from = selected.models.find(model => model.id === fromId);
    if (!from || from.external === true) return;
    if (this.#refitted.has(fromId)) { this.log('[local] ' + this.#model + ' spilled again after it was fitted to the free memory: stepping down'); return this.#stepDown({cause: 'spill'}); }
    this.#refitted.add(fromId);
    this.log('[local] ' + this.#model + ' has ' + verdict.spilledMiB + ' MiB in shared system memory (the game took the graphics memory): unloading it and loading it again fitted to what is free');
    await this.stop();
    let free = null;
    try { free = Number(await this.freeVramMiB()); } catch { /* unknown */ }
    const fit = Number.isFinite(free) ? await this.#fitFor(from, free, FIT_LIMITS.refitMarginMiB, this.#device).catch(() => null) : null;
    if (fit?.pick) {
      this.#refitPlan = {id: fromId, fit};
      this.#stepFrom = null;
      this.emit('diagnostics', this.diagnostics());
      this.#kick();
      return;
    }
    this.log('[local] ' + this.#model + ' does not fit whole in the ' + (Number.isFinite(free) ? Math.round(free) + ' MiB' : 'memory') + ' that is free now: stepping down');
    return this.#stepDown({free: Number.isFinite(free) ? free : null, cause: 'spill'});
  }

  /**
   * The loaded model has to leave the card (stalled turns, a lost device twice, a spill that could not be fitted). The next smaller installed model of its family is loaded when there is one.
   * With none, the same model is loaded again with part of its layers on the CPU (`-fit on`, context 8,192, the 8-bit cache, FIT_LIMITS.offloadGameRoomMiB kept free for the game; the start
   * any share loads, see #startOnce), and a model that was reloaded that way offloadReloads times already makes Local AI unavailable with the 'low-memory' reason and the TOO_SMALL detail:
   * its notice says the card is too small and points to a smaller model or the Custom provider. No cloud provider takes the turns.
   * `cause`: 'stall' (the default), 'lost' (the device was lost twice) or 'spill'; a spill lets a model the player added through (a stall never steps one of those down). `free`: the free memory already read.
   * A model that already runs part on the CPU and stalls has nothing left to give up: it stays loaded (slow, but it answers), and the player already knows ('offload-slow'). After a spill or a lost device
   * it is loaded again the same way, LOCAL_LLM_LIMITS.offloadReloads times a session at most.
   */
  async #stepDown({free: known = null, cause = 'stall'} = {}) {
    const fromId = this.#modelId, fromName = this.#model;
    const selected = this.#selected(this.pack);
    const from = selected.models.find(model => model.id === fromId);
    // Only a model of a pack (standard, lite, Mature good, Mature lite) steps down on a stall; one the player added is theirs to change (a spill is the exception: see #spillAct).
    if (!from || (from.custom === true && cause !== 'spill')) return;
    let free = Number.isFinite(known) ? known : null;
    if (free === null) {
      try { free = Number(await this.freeVramMiB()); } catch { /* the reading is for the log */ }
      if (!Number.isFinite(free)) free = null;
    }
    const next = stepDownTarget({models: selected.models, from, sizeOf: file => this.fileSizeMiB(file)});
    const freeText = free === null ? '' : ' (' + Math.round(free) + ' MiB of graphics memory free now)';
    if (next) {
      this.#stalled.add(fromId);
      this.log('[local] stepping down from ' + fromName + freeText + ': ' + next.name + ' is the next smaller model');
      this.#stepFrom = fromId; this.#stepFree = free;
      await this.stop();   // its graphics memory goes back to the game before the smaller model is chosen
      this.#kick();
      return;
    }
    this.#stepFrom = null;
    if (cause === 'stall' && this.#loaded?.id === fromId && this.#loaded.offload === true && this.#proc) {
      // Already part on the CPU and slow: nothing smaller to go to and nothing more to give up, and a slow answer is still an answer. It stays loaded; the count starts again.
      this.#stalls = 0;
      if (!this.#loaded.stayNoted) { this.#loaded.stayNoted = true; this.log('[local] ' + fromName + ' stalled' + freeText + ' and already runs with part of its layers on the CPU; no smaller model is installed, so it stays loaded (replies are slow)'); }
      return;
    }
    const tries = this.#offloadTried.get(fromId) ?? 0;
    if (tries >= LOCAL_LLM_LIMITS.offloadReloads) {
      // Loaded again with part on the CPU several times this session and it keeps being pushed off or lost: the card cannot hold it beside the game. The saved choice stays; reset() or a changed choice tries again.
      this.#stalled.add(fromId);
      this.log('[local] stepping down from ' + fromName + freeText + ': it was loaded with part of its layers on the CPU ' + tries + ' times this session and no smaller model is installed, so Local AI is unavailable (the card is too small for the model beside the game)');
      await this.stop();
      this.#fail('low-memory', TOO_SMALL);
      return;
    }
    this.log('[local] stepping down from ' + fromName + freeText + ': no smaller model is installed, so the same model is loaded again with part of its layers on the CPU');
    this.#forcedOffload = fromId; this.#offloadTried.set(fromId, tries + 1);
    await this.stop();   // its graphics memory goes back to the game before the placement is worked out
    this.#kick();
  }

  // The start that follows a step names the model it loaded instead (once): the host tells the player.
  #announceStep(modelId, modelName) {
    const from = this.#stepFrom;
    if (!from) return;
    this.#stepFrom = null;
    if (modelId === from) return;
    this.emit('model-stepdown', {from, model: modelName, free: this.#stepFree ?? null});
  }

  // --- stopping -----------------------------------------------------------------------------------------------

  // Ends the child and cancels timers. Idempotent. A later ensure() starts it again.
  async stop() {
    this.#generation++;
    this.#reselectPending = false;   // the next start reads the current choice itself
    this.#disarm(); this.#dropHold(); this.noteHeaders();
    const proc = this.#proc; this.#proc = null; this.#info = null;
    if (this.#state !== 'failed') this.#setState('stopped');
    this.#starting = null;
    await proc?.stop();
  }

  // For process exit handlers: no awaiting.
  killSync() {
    this.#generation++;
    this.#disarm(); this.#dropHold();
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
