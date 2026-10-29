// Starts the OmniVoice server (docs/REMOTE_OMNIVOICE.md): `node omni-server-main.mjs [options]`, normally through "Start OmniVoice server.cmd" of the
// server folder. It finds the pack's Python, model and voice adapter next to itself, starts the same resident worker the game's own route runs
// (bridge/resident-voice.mjs) and puts bridge/omni-server.mjs in front of it.
//
// Options (every one has a default; the .cmd file lists them in plain words):
//   --listen <address>    127.0.0.1 (this PC only, the default) | 0.0.0.0 (every network of this PC: the other PC of the home network can use it) | one IP of this PC
//   --port <number>       8765
//   --gpu <number>        the graphics card to use, 0 for the first (Task Manager > Performance lists them in this order); several cards: pick one
//   --quality 16|32       the voice steps a request that names none is rendered with (the game sends its own Quality setting with every phrase)
//   --root <folder>       the server folder (default: two folders above this file: <root>/app/bridge/omni-server-main.mjs)
//   --data <folder>       where the server keeps its cache, uploaded clips and log (default <root>/server-data)
//   --list-gpus           print the NVIDIA cards with their numbers and stop
//
// Layout it expects (the mod's own, so a copy of the installed Runtime and OmniVoice pack works as it is):
//   <root>/app/bridge/ ...                   the Runtime's bridge folder (this file and the worker)
//   <root>/app/omni/{python,model,voicestudio/backend,defaults}   the OmniVoice pack
//   <root>/app/defaults/local-voices.autobest-long.json           the voice list (else the pack's own copy)
//   <root>/voices/                           the voice clips (optional: a clip the server does not have is sent by the game)
import {mkdirSync, appendFileSync, readFileSync, statSync, existsSync, writeFileSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {networkInterfaces} from 'node:os';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {installSafeStreams} from './safe-streams.mjs';
import {ResidentVoice} from './resident-voice.mjs';
import {OmniServer} from './omni-server.mjs';
import {DEFAULT_LISTEN, DEFAULT_PORT} from './omni-remote.mjs';
import {OMNI_SOURCE_VARIABLE, OWN_PYTHON_VARIABLE, resolveOwnPython, ownPythonLine} from './omni-own-python.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** The options as {listen, port, gpu, quality, root, data, listGpus} or {error}. Pure. */
export function parseOptions(argv, defaultRoot = resolve(here, '..', '..')) {
  const options = {listen: DEFAULT_LISTEN, port: DEFAULT_PORT, gpu: 0, quality: 16, root: defaultRoot, data: null, listGpus: false};
  const wants = new Map([['--listen', 'listen'], ['--port', 'port'], ['--gpu', 'gpu'], ['--quality', 'quality'], ['--root', 'root'], ['--data', 'data']]);
  for (let at = 0; at < argv.length; at++) {
    const name = argv[at];
    if (name === '--list-gpus') { options.listGpus = true; continue; }
    if (!wants.has(name)) return {error: `Unknown option ${String(name).slice(0, 40)}`};
    const value = argv[++at];
    if (value === undefined || value === '') return {error: `${name} needs a value`};
    options[wants.get(name)] = value;
  }
  options.port = Number(options.port);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) return {error: 'The port must be a number from 1 to 65535'};
  options.gpu = /^\d{1,2}$/.test(String(options.gpu)) ? Number(options.gpu) : NaN;
  if (!Number.isInteger(options.gpu)) return {error: 'The graphics card must be a number: 0 for the first card, 1 for the second'};
  options.quality = Number(options.quality);
  if (![16, 32].includes(options.quality)) return {error: 'The quality must be 16 (fast) or 32 (best)'};
  if (!/^(?:\d{1,3}(?:\.\d{1,3}){3}|localhost|[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]|::1?|::)$/.test(String(options.listen))) return {error: 'The listen address is not an address'};
  options.listen = String(options.listen).replace(/^\[|\]$/g, '');
  options.root = resolve(options.root);
  options.data = resolve(options.data ?? resolve(options.root, 'server-data'));
  return options;
}

/** The environment that picks one graphics card for the worker (a second card of the same PC works as well as another PC). Pure. */
export function gpuEnvironment(index) {
  return {CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: String(index), HIP_VISIBLE_DEVICES: String(index), ROCR_VISIBLE_DEVICES: String(index)};
}

/** Where everything is, from the server folder. Pure. */
export function serverLayout(root, data) {
  const app = resolve(root, 'app'), omni = resolve(app, 'omni');
  return {root, data, app, omni, python: resolve(omni, 'python', 'python.exe'), model: resolve(omni, 'model'), adapter: resolve(omni, 'voicestudio', 'backend'),
    worker: resolve(app, 'bridge', 'resident-voice-worker.py'), voices: resolve(root, 'voices'), cache: resolve(data, 'voice-studio-data'),
    players: resolve(data, 'player-voices'), config: resolve(data, 'local-voices.json'), defaults: [resolve(app, 'defaults'), resolve(omni, 'defaults')]};
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));

/** The pack's model revision from its omni-pack.json ("<repository>@<revision>"), or null. */
export function packRevision(layout) {
  try { return /@([0-9a-f]{7,64})$/i.exec(readJson(resolve(layout.omni, 'omni-pack.json'))?.model ?? '')?.[1] ?? null; } catch { return null; }
}

/** The voice list to start the worker with: the Runtime's long list (else the pack's) that names the pack's model revision. Throws a sentence when there is none. */
export function readVoiceList(layout, name = 'local-voices.autobest-long.json') {
  const revision = packRevision(layout);
  let fallback = null;
  for (const folder of layout.defaults) {
    let template;
    try { template = readJson(resolve(folder, name)); } catch { continue; }
    if (!template || typeof template !== 'object') continue;
    if (!revision || template.revision === revision) return template;
    fallback ??= template;
  }
  if (fallback) return fallback;
  throw Error(`The voice list ${name} is not in ${layout.defaults.join(' or ')}`);
}

/** What is missing from the folder, in words, or null. */
export function missingParts(layout, exists = existsSync) {
  const needs = [[layout.python, 'the OmniVoice Python (app/omni/python)'], [resolve(layout.model, 'model.safetensors'), 'the OmniVoice model (app/omni/model)'],
    [resolve(layout.adapter, 'services', 'tts_backend.py'), 'the voice adapter (app/omni/voicestudio)'], [layout.worker, 'the voice worker (app/bridge/resident-voice-worker.py)']];
  const lacks = needs.filter(([path]) => !exists(path)).map(([, words]) => words);
  return lacks.length ? lacks : null;
}

/** This PC's IPv4 addresses a listener on 0.0.0.0 can be reached at (for the line that tells the player what to type into the game). */
export function lanAddresses(interfaces = networkInterfaces()) {
  const found = [];
  for (const list of Object.values(interfaces)) {
    for (const item of list ?? []) if (item.family === 'IPv4' && !item.internal) found.push(item.address);
  }
  return found;
}

function listGpus() {
  const candidates = [resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
    resolve(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe')];
  const exe = candidates.find(path => existsSync(path));
  if (!exe) { console.log('No NVIDIA graphics card was found (nvidia-smi is not installed). The server needs an NVIDIA card, or an AMD card with the ROCm route in docs/OMNIVOICE_AMD.md.'); return Promise.resolve(); }
  return new Promise(done => execFile(exe, ['-L'], {windowsHide: true, timeout: 15_000}, (error, out) => {
    console.log(error ? 'nvidia-smi could not list the cards.' : String(out).trim().replace(/ \(UUID: [^)]*\)/g, ''));
    done();
  }));
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.error) { console.error(`${options.error}.`); return 2; }
  if (options.listGpus) { await listGpus(); return 0; }
  const layout = serverLayout(options.root, options.data);
  const lacking = missingParts(layout);
  if (lacking) {
    console.error('This folder does not hold what the server needs:\n  - ' + lacking.join('\n  - ')
      + '\nCopy the mod\'s Runtime and the OmniVoice pack here (docs/REMOTE_OMNIVOICE.md, step 1).');
    return 3;
  }
  mkdirSync(layout.data, {recursive: true});
  const logPath = resolve(layout.data, 'server.log');
  try { if (statSync(logPath).size > 2_000_000) writeFileSync(logPath, ''); } catch { /* no log yet */ }
  const log = message => {
    const line = `${new Date().toISOString()} ${String(message).replace(/\s+$/, '')}`;
    console.log(line);
    try { appendFileSync(logPath, line + '\n'); } catch { /* the log is an extra */ }
  };
  await Promise.all([mkdir(layout.cache, {recursive: true}), mkdir(layout.players, {recursive: true}), mkdir(layout.voices, {recursive: true})]);

  let template;
  try { template = readVoiceList(layout); } catch (error) { console.error(error.message); return 3; }
  const config = {...template, steps: options.quality, playerVoiceDirectory: layout.players};
  delete config.proposal;
  writeFileSync(layout.config, JSON.stringify(config, null, 2) + '\n');

  // The player's own Python (a graphics card the pack's PyTorch cannot use: AMD with ROCm, docs/OMNIVOICE_AMD.md): the same omni-python.txt file, in the data folder.
  let python = layout.python, extraEnvironment = gpuEnvironment(options.gpu);
  const own = await resolveOwnPython({stateDirectory: layout.data, runtimePython: layout.python, packInstalled: true}).catch(() => ({configured: false}));
  if (own.configured) log(ownPythonLine(own));
  if (own.used) { python = own.path; extraEnvironment = {...extraEnvironment, [OWN_PYTHON_VARIABLE]: '1', [OMNI_SOURCE_VARIABLE]: own.source}; }

  let version = '0';
  try { version = readJson(resolve(layout.app, 'release.json')).version ?? version; } catch { /* a development folder has none */ }

  const server = new OmniServer({
    version, listen: options.listen, port: options.port, quality: options.quality, log, playerDirectory: layout.players,
    gpu: {index: options.gpu},
    createVoice: hooks => new ResidentVoice(config, {project: layout.app, configPath: layout.config, pythonExecutable: python,
      modelDirectory: layout.model, adapterDirectory: layout.adapter, referenceDirectory: layout.voices, cacheDirectory: layout.cache,
      extraEnvironment, onState: hooks.onState, onLog: text => { for (const line of String(text).split(/\r?\n/)) if (line.trim()) log(`[worker] ${line.slice(0, 300)}`); }}),
  });
  let listening;
  try { listening = await server.listen(); }
  catch (error) { console.error(error?.code === 'EADDRINUSE' ? `Port ${options.port} is already in use. Close the other OmniVoice server window, or pick another port.` : `Could not listen: ${error?.message ?? error}`); return 4; }

  const where = listening.address === '0.0.0.0' || listening.address === '::'
    ? lanAddresses().map(address => `${address}:${listening.port}`) : [`${listening.address}:${listening.port}`];
  log(`OmniVoice server ${version} listening on ${listening.address}:${listening.port}, graphics card ${options.gpu}, quality ${options.quality}`);
  log(where.length ? `In the game, Settings > Voices > Custom voices > Server address: ${where.join(' or ')}` : 'No network address was found for this PC.');
  if (listening.address === '127.0.0.1') log('Only this PC can use it. To use it from another PC, start it with the listen address 0.0.0.0.');
  log('Loading the voice (the first start takes a minute or more). Leave this window open; close it to stop the server.');

  let stopping = null;
  const stop = () => stopping ??= (async () => { log('Stopping the server.'); await server.close().catch(() => {}); process.exit(0); })();
  process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGBREAK', stop);
  return new Promise(() => {});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installSafeStreams();   // a full disk or a closed window never ends the server through a log line
  main().then(code => { if (code) process.exit(code); }, error => { console.error(error?.stack ?? error); process.exit(1); });
}
