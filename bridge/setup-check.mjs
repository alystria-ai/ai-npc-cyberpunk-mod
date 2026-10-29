import {readFile, readdir as realReaddir, lstat as realLstat, stat, statfs} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {lookup as dnsLookup} from 'node:dns/promises';
import {connect as netConnect} from 'node:net';
import {join, relative, resolve} from 'node:path';
import {promisify} from 'node:util';
import {totalmem} from 'node:os';
import {atomicFile} from './guarded-file.mjs';
import {browserNameFor, systemBrowserCandidates} from './system-browser.mjs';
import {amdRoute, gpuVendors} from './gpu-vendors.mjs';
import {checkRuntimeSteps} from './runtime-steps.mjs';
import {checkRuntimePython} from './runtime-python.mjs';

// Setup check (Settings > Help): what the Node side can tell the player about their installation, as codes the game's Lua turns into
// translated text. runtime/setup-check-request.json (written by the Help page) asks, runtime/setup-check.json answers; neither is shipped
// (packaging/runtime-exchange.json) and both are only ever replaced in place, so a missing, empty or half-written file all
// mean "nothing yet" to every reader here, and nothing in this module deletes anything.
//
// Nothing runs at import time. Every detector is injectable and none of them throws: a detector that fails turns its own check into
// {state: 'unknown', code: 'unknown'} and the rest of the document is still written.
//
// Cost: the first run (the bridge's start) is "light": files and memory only, no process is started and no connection is made. A run
// that answers a request is full: the graphics cards, the browser and the mod managers are looked up once per bridge process and kept;
// the connection test to the hosts the chosen providers need is made again on every full run (a request means the player opened Help).

export const SETUP_CHECK_FILE = 'setup-check.json';
export const SETUP_REQUEST_FILE = 'setup-check-request.json';

// A drive with less free space than this (the game's, or the one the mod keeps its data on) is "almost full": the logs, the memories and the voice
// files the mod writes then fail (error report 1cbe337a5144ebbd, a C: drive with 0.8 GiB free). The check reads the numbers of two folders, no process.
// The drive letter of a Windows path, or null (the same reading as bridge/system-facts.mjs driveLetter, which is not part of the service's own files).
const driveLetter = folder => /^([A-Za-z]):[\\/]/.exec(String(folder ?? ''))?.[1]?.toUpperCase() ?? null;
export const DISK_LOW_BYTES = 2 * 1024 ** 3;
const REQUEST_MAX_BYTES = 16384, REQUEST_MAX_AGE_MS = 120000, REQUEST_FUTURE_MS = 5000;
// The language packs one folder too deep are found by their manifests (the same as LANGUAGE_PACKS in the launcher's place-packs.mjs).
const LANGUAGE_PACK_FOLDERS = [['multilingual', 'manifest.json', 'Multilingual pack'], ['multilingual-pocket', 'pocket-model.json', 'PocketTTS model']];
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MOD_NAME = 'AiNpcCyberpunkMod';

/** The host each service is reached at: Convai, Mistral (its text and the Voxtral voice). */
export const SERVICE_HOSTS = Object.freeze({convai: 'api.convai.com', mistral: 'api.mistral.ai'});

const clip = (value, size = 120) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, size) : null;
// Version order of two release strings (0.3.4 before 0.3.10): negative when a is older; non-numeric parts count as 0.
export function versionOrder(a, b) {
  const parts = value => String(value ?? '').split(/[-+]/)[0].split('.').map(part => Number.parseInt(part, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let index = 0; index < Math.max(x.length, y.length); index += 1) if ((x[index] ?? 0) !== (y[index] ?? 0)) return (x[index] ?? 0) - (y[index] ?? 0);
  return 0;
}
const exists = async (path, kind = 'dir') => {
  try { const info = await stat(path); return kind === 'dir' ? info.isDirectory() : info.isFile(); } catch { return false; }
};
const jsonOf = async path => {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
};

// ---------------------------------------------------------- graphics cards

const DISPLAY_CLASS = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
const BASIC_ADAPTER = /^Microsoft (?:Basic|Remote) Display Adapter/i;
const REG_TIMEOUT_MS = 5000;

/**
 * The values `reg query <key> /s /v <name>` printed, by key: a Map from the key's header line (HKEY_LOCAL_MACHINE\...\0000) to
 * {<value name>: {type: 'REG_SZ'|'REG_QWORD'|..., data: <text as printed>}}. Only the hive name and the REG_ type names are relied on
 * (reg.exe prints those in English on every Windows language); the "End of search" line is ignored.
 */
export function parseRegistryValues(stdout) {
  const keys = new Map();
  let current = null;
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      current = line.trim();
      if (!keys.has(current)) keys.set(current, {});
      continue;
    }
    if (!current) continue;
    const match = /^\s+(.+?)\s{2,}(REG_[A-Z_]+)(?:\s+(.*?))?\s*$/.exec(line);
    if (match) keys.get(current)[match[1]] = {type: match[2], data: match[3] ?? ''};
  }
  return keys;
}

// A REG_QWORD / REG_DWORD (0x2ff000000) or a little-endian REG_BINARY (0000004000000000) as a BigInt; null when it is neither.
function registryNumber(entry) {
  if (!entry || typeof entry.data !== 'string') return null;
  try {
    if (entry.type === 'REG_QWORD' || entry.type === 'REG_DWORD') {
      const value = BigInt(entry.data.trim());
      return value >= 0n ? value : null;
    }
    if (entry.type === 'REG_BINARY') {
      const hex = entry.data.replace(/[^0-9a-f]/gi, '');
      if (!hex || hex.length % 2 || hex.length > 16) return null;
      let value = 0n;
      for (let at = hex.length - 2; at >= 0; at -= 2) value = value * 256n + BigInt(parseInt(hex.slice(at, at + 2), 16));
      return value;
    }
  } catch { /* not a number */ }
  return null;
}

const mebibytes = bytes => {
  if (bytes === null || bytes <= 0n) return null;
  const value = Math.round(Number(bytes) / 1048576);
  return Number.isFinite(value) && value > 0 ? value : null;
};

/** [{name, memoryMiB}] from the three parsed queries (names, REG_QWORD sizes, the older 32-bit size), largest card first. Pure. */
export function graphicsCardsFrom(names, qwords, dwords) {
  const lower = map => new Map([...map].map(([key, values]) => [key.toLowerCase(), values]));
  const big = lower(qwords), small = lower(dwords), cards = [];
  for (const [key, values] of names) {
    if (!/\\\d{4}$/.test(key) || values.DriverDesc?.type?.startsWith('REG_') !== true) continue;
    const name = clip(values.DriverDesc.data, 120);
    if (!name) continue;
    // The 64-bit value is the accurate one; the 32-bit one stops at 4 GiB and is only the fallback.
    const memoryMiB = mebibytes(registryNumber(big.get(key.toLowerCase())?.['HardwareInformation.qwMemorySize']))
      ?? mebibytes(registryNumber(small.get(key.toLowerCase())?.['HardwareInformation.MemorySize']));
    if (!cards.some(card => card.name === name && card.memoryMiB === memoryMiB)) cards.push({name, memoryMiB});
  }
  const real = cards.filter(card => !BASIC_ADAPTER.test(card.name));
  return (real.length ? real : cards)
    .map((card, index) => ({card, index}))
    .sort((a, b) => (b.card.memoryMiB ?? -1) - (a.card.memoryMiB ?? -1) || a.index - b.index)
    .map(item => item.card);
}

const defaultRun = (file, args, options) => promisify(execFile)(file, args, options);

/**
 * The graphics cards Windows has registered, read with reg.exe (three queries in parallel, 5 s each). Never throws: [] when reg.exe is
 * missing, times out or prints nothing usable, and off Windows. `run` is a promisified execFile (for tests).
 */
export async function detectGraphicsCards({run = defaultRun, platform = process.platform, env = process.env} = {}) {
  if (platform !== 'win32') return [];
  try {
    const reg = join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'reg.exe');
    const ask = async value => {
      try {
        const result = await run(reg, ['query', DISPLAY_CLASS, '/s', '/v', value], {timeout: REG_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 20});
        return parseRegistryValues(result?.stdout);
      } catch (error) {
        // reg.exe exits with 1 when no subkey has the value; whatever it printed before is still read.
        return parseRegistryValues(typeof error?.stdout === 'string' ? error.stdout : '');
      }
    };
    const [names, qwords, dwords] = await Promise.all(['DriverDesc', 'HardwareInformation.qwMemorySize', 'HardwareInformation.MemorySize'].map(ask));
    return graphicsCardsFrom(names, qwords, dwords);
  } catch { return []; }
}

// ------------------------------------------------------------ memory facts

const MIB = 1024 * 1024;
// RAM plus the paging files is what Windows can promise (the "commit limit"): TotalVirtualMemorySize of Win32_OperatingSystem, in KiB.
const COMMIT_QUERY = '(Get-CimInstance -ClassName Win32_OperatingSystem).TotalVirtualMemorySize';
const COMMIT_TIMEOUT_MS = 8000;

/**
 * The memory facts an error report carries so a "paging file is too small" failure (Windows error 1455) can be told from a plain one: {totalRamMiB, commitLimitMiB}.
 * The RAM is Node's own reading (no process); the commit limit is one PowerShell read (a few hundred ms, 8 s at most), made once per bridge process by
 * cachedMemoryFacts and only when a report is built, never in a turn or a frame. Never throws: a field that cannot be read is null (the commit limit off Windows).
 */
export async function detectMemoryFacts({run = defaultRun, platform = process.platform, env = process.env, ramBytes = totalmem} = {}) {
  let totalRamMiB = null, commitLimitMiB = null;
  try { const bytes = Number(typeof ramBytes === 'function' ? ramBytes() : ramBytes); if (bytes > 0) totalRamMiB = Math.round(bytes / MIB); } catch { /* unknown */ }
  if (platform === 'win32') {
    try {
      const shell = join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const result = await run(shell, ['-NoProfile', '-NonInteractive', '-Command', COMMIT_QUERY], {timeout: COMMIT_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 16});
      const kib = Number(String(result?.stdout ?? '').trim());
      if (Number.isFinite(kib) && kib > 0) commitLimitMiB = Math.round(kib / 1024);
    } catch { /* the commit limit stays unknown */ }
  }
  return {totalRamMiB, commitLimitMiB};
}

// ------------------------------------------------------------ mod managers

/**
 * {managers: ['mo2'?, 'vortex'?]}. Mod Organizer 2 injects usvfs into every process the game starts, so the bridge's own process lists
 * usvfs_x64.dll among its loaded libraries (read from the process report: no process is started). Vortex leaves vortex.deployment.json
 * (or vortex.deployment.<n>.json) in the folder it deploys to, which for Cyberpunk is the game folder. Never throws.
 */
export async function detectModManagers({game, sharedObjects, readdir = realReaddir} = {}) {
  const managers = [];
  try {
    let objects = sharedObjects;
    if (objects === undefined) {
      try { objects = process.report?.getReport?.()?.sharedObjects ?? []; } catch { objects = []; }
    }
    if (Array.isArray(objects) && objects.some(path => /^usvfs_x(?:64|86)\.dll$/i.test(String(path).split(/[\\/]/).pop()))) managers.push('mo2');
  } catch { /* not detected */ }
  try {
    if (game) {
      const names = await readdir(game);
      if (names.some(name => /^vortex\.deployment(?:\..+)?\.json$/i.test(String(name)))) managers.push('vortex');
    }
  } catch { /* the game folder cannot be listed */ }
  return {managers};
}

// -------------------------------------------------------------- nested packs

// Folders of the game itself (and of other tools) that are never searched for a wrapped pack (the same list as
// place-packs.mjs in the packaging folder; the bridge cannot import from packaging/, and a test keeps the two equal).
export const GAME_FOLDERS = Object.freeze(new Set(['archive', 'bin', 'engine', 'r6', 'red4ext', 'mods', 'tools', 'plugins', 'support',
  'localization', 'redprelauncher', 'redmod', 'app', 'voices', 'node_modules', '.git']));
const LOCAL_MARKER = /^manifest\.[A-Za-z0-9._-]+\.json$/;
const PACK_NAMES = Object.freeze({
  'manifest.standard.json': 'Local AI standard', 'manifest.lite.json': 'Local AI lite',
  'manifest.mature-standard.json': 'Mature standard', 'manifest.mature-lite.json': 'Mature lite',
});

/**
 * Optional pack files extracted one folder too deep, found but never moved (the launcher moves them at the game's start,
 * place-packs.mjs in the packaging folder; this only reports what is still there). Same places, same markers:
 *   - the game folder's child folders, and one level further;  - the mod folder (red4ext/... or app/... extracted into it);
 *   - the plugin folder (red4ext/... inside it, or inside one wrapper folder of it).
 * A candidate is <base>/red4ext/plugins/AiNpcCyberpunkMod/app holding local-ai/manifest.*.json, a non-empty local-ai/mature/ or
 * omni/omni-pack.json, or <base>/red4ext/plugins/AiNpcCyberpunkMod/voices/ holding a language pack (multilingual/<code>/manifest.json, a voice
 * language pack, or multilingual-pocket/<code>/pocket-model.json, a PocketTTS model). The real installation (<plugin>/app) is never a candidate. Returns [{pack, folder}] with `folder` relative to the
 * game folder. Only directory listings and a few dozen stats; never throws.
 */
export async function findNestedPacks({game, modRoot, plugin, app, fs = {}} = {}) {
  if (!game) return [];
  const readdir = fs.readdir ?? realReaddir, lstat = fs.lstat ?? realLstat;
  const pluginRoot = plugin ?? join(game, 'red4ext', 'plugins', MOD_NAME);
  const modFolder = modRoot ?? join(game, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', MOD_NAME);
  const realApp = resolve(app ?? join(pluginRoot, 'app')).toLowerCase();
  const kindOf = async path => {
    try { const info = await lstat(path); return info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other'; } catch { return 'none'; }
  };
  const entriesOf = async path => { try { return await readdir(path, {withFileTypes: true}); } catch { return []; } };
  const treeOf = base => join(base, 'red4ext', 'plugins', MOD_NAME, 'app');
  const skip = name => GAME_FOLDERS.has(String(name).toLowerCase());
  const found = [];
  const addStandard = async base => {
    const tree = treeOf(base), voices = join(base, 'red4ext', 'plugins', MOD_NAME, 'voices');
    if (resolve(tree).toLowerCase() === realApp || resolve(voices).toLowerCase() === resolve(realApp, '..', 'voices').toLowerCase()) return false;
    if (await kindOf(tree) !== 'dir' && await kindOf(voices) !== 'dir') return false;
    found.push({base, tree, voices});
    return true;
  };
  const top = (await entriesOf(game)).filter(entry => entry.isDirectory() && !skip(entry.name));
  await Promise.all(top.map(async entry => {
    const base = join(game, entry.name);
    if (await addStandard(base)) return;
    for (const inner of (await entriesOf(base)).filter(item => item.isDirectory() && !skip(item.name))) await addStandard(join(base, inner.name));
  }));
  await addStandard(modFolder);
  const bare = join(modFolder, 'app');
  if (resolve(bare).toLowerCase() !== realApp && await kindOf(bare) === 'dir') found.push({base: modFolder, tree: bare});
  await addStandard(pluginRoot);
  for (const entry of (await entriesOf(pluginRoot)).filter(item => item.isDirectory() && !skip(item.name))) await addStandard(join(pluginRoot, entry.name));

  const languagePacksIn = async voices => {
    const names = [];
    if (!voices) return names;
    for (const [folder, marker, label] of LANGUAGE_PACK_FOLDERS) {
      for (const entry of await entriesOf(join(voices, folder))) {
        if (entry.isDirectory() && LANGUAGE_CODE.test(entry.name) && await kindOf(join(voices, folder, entry.name, marker)) === 'file') names.push(`${label} (${entry.name})`);
      }
    }
    return names;
  };
  const packsIn = async tree => {
    const names = [];
    const local = await entriesOf(join(tree, 'local-ai'));
    for (const entry of local) {
      if (entry.isFile() && LOCAL_MARKER.test(entry.name)) names.push(PACK_NAMES[entry.name.toLowerCase()] ?? 'Local AI');
    }
    if (!names.some(name => name.startsWith('Mature'))
        && local.some(entry => entry.isDirectory() && entry.name.toLowerCase() === 'mature')
        && (await entriesOf(join(tree, 'local-ai', 'mature'))).length) names.push('Mature');
    if (await kindOf(join(tree, 'omni', 'omni-pack.json')) === 'file') names.push('OmniVoice');
    return [...new Set(names)];
  };
  const seen = new Set(), result = [];
  for (const candidate of found.sort((a, b) => a.tree.localeCompare(b.tree))) {
    const key = resolve(candidate.tree).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const folder = relative(game, candidate.base) || '.';
    for (const pack of [...await packsIn(candidate.tree), ...await languagePacksIn(candidate.voices)]) result.push({pack, folder});
  }
  return result;
}

// -------------------------------------------------------------- reachability

const NO_DNS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_NONAME', 'EAI_FAIL', 'ESERVFAIL', 'ENODATA']);
const BLOCKED = new Set(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EACCES', 'EPERM']);

function failureCode(error) {
  // net's automatic family selection reports several failed addresses as one AggregateError.
  const codes = (Array.isArray(error?.errors) && error.errors.length ? error.errors : [error]).map(item => item?.code);
  if (codes.some(code => BLOCKED.has(code))) return 'blocked';
  if (codes.some(code => NO_DNS.has(code))) return 'no-dns';
  return 'timeout';
}

/**
 * Can this machine open a connection to host:443? 'reachable', 'no-dns' (the name does not resolve), 'blocked' (refused, reset or
 * denied: a firewall, antivirus or VPN) or 'timeout' (no answer in time). The connection is closed at once and nothing is sent.
 * `lookup(host)` and `connect({host, port})` are injectable for tests. Never throws.
 */
export async function checkReachable(host, {port = 443, timeoutMs = 4000, lookup = dnsLookup, connect = netConnect} = {}) {
  try {
    const resolved = await new Promise(done => {
      const timer = setTimeout(() => done({ok: false}), timeoutMs);
      Promise.resolve().then(() => lookup(host)).then(() => { clearTimeout(timer); done({ok: true}); },
        () => { clearTimeout(timer); done({ok: false}); });
    });
    // A name that does not resolve (or a resolver that does not answer in time) is a name problem, not a connection one.
    if (!resolved.ok) return 'no-dns';
    return await new Promise(done => {
      let socket, finished = false, timer;
      const finish = code => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        try { socket?.destroy(); } catch { /* already closed */ }
        done(code);
      };
      timer = setTimeout(() => finish('timeout'), timeoutMs);
      try {
        socket = connect({host, port});
        socket.on('connect', () => finish('reachable'));
        socket.on('error', error => finish(failureCode(error)));
      } catch (error) { finish(failureCode(error)); }
    });
  } catch { return 'timeout'; }
}

// ------------------------------------------------------------------- caches

/** The first installed browser the hidden page can use (bridge/system-browser.mjs), or null. A developer's CYBERPUNK_CONVAI_BROWSER counts. */
export function detectBrowserName({env = process.env, candidates = systemBrowserCandidates} = {}) {
  if (env.CYBERPUNK_CONVAI_BROWSER) return browserNameFor(env.CYBERPUNK_CONVAI_BROWSER) ?? 'Configured browser'; // browser.txt reaches here too
  const first = candidates({env}).next();
  return first.done ? null : clip(first.value?.name, 80) ?? null;
}

// Looked up once per bridge process: the registry reads start processes, and none of these changes while the game runs.
const caches = {graphics: null, browser: undefined, managers: null, memory: null};
export function cachedGraphicsCards(options) { return caches.graphics ??= detectGraphicsCards(options); }
export function cachedBrowserName(options) { return caches.browser === undefined ? (caches.browser = detectBrowserName(options)) : caches.browser; }
export function cachedModManagers(options) { return caches.managers ??= detectModManagers(options); }
// The Runtime's Python (bridge/runtime-python.mjs): the folders are read every time (a few milliseconds); the Python itself is asked only by a full run, and an
// answer of 'ok' stands for ten minutes (the files of a started Runtime do not change by themselves). A problem is never kept: the next run asks again.
const PYTHON_OK_MS = 10 * 60 * 1000;
export async function cachedRuntimePython({project, light = false, now = Date.now, check = checkRuntimePython} = {}) {
  const key = String(project);
  const kept = caches.python?.get(key);
  if (!light && kept && now() - kept.at < PYTHON_OK_MS) return kept.value;
  const found = await check({project, import: !light});
  if (!light && found?.state === 'ok') (caches.python ??= new Map()).set(key, {at: now(), value: found});
  return found;
}
export function resetRuntimePythonCache() { caches.python = undefined; }
export function cachedMemoryFacts(options) { return caches.memory ??= detectMemoryFacts(options); }
/** For tests: forget what the caches hold. */
export function resetSetupCheckCaches() { caches.graphics = null; caches.browser = undefined; caches.managers = null; caches.memory = null; }

// ----------------------------------------------------- the pack-move report

const PLACEMENT_WINDOW_MS = 10 * 60 * 1000;

/**
 * What the launcher's pack mover reported at this start (start-service.mjs in the packaging folder writes
 * <state>/pack-placement.json before it starts the bridge): {fixed: [{pack, from}], conflicts: [...], errors: [...]}, or null when there is no such file or it is older than
 * ten minutes before this bridge process started (an earlier game start's). `startedAt` is the bridge process's start (ms).
 */
export async function readPackPlacement({stateDirectory, startedAt = Date.now(), now = Date.now, read = path => readFile(path, 'utf8')} = {}) {
  if (!stateDirectory) return null;
  let value;
  try { value = JSON.parse((await read(join(stateDirectory, 'pack-placement.json'))).replace(/^\uFEFF/, '')); } catch { return null; }
  if (!value || typeof value !== 'object' || value.version !== 1 || !Number.isFinite(value.updated)) return null;
  if (value.updated < startedAt - PLACEMENT_WINDOW_MS || value.updated > now() + REQUEST_FUTURE_MS) return null;
  const list = items => (Array.isArray(items) ? items : []).slice(0, 50);
  return {
    fixed: list(value.fixed).flatMap(row => {
      const pack = clip(row?.pack, 60), from = clip(row?.from, 260);
      return pack && from ? [{pack, from}] : [];
    }),
    conflicts: list(value.conflicts).map(item => clip(String(item), 260)).filter(Boolean),
    errors: list(value.errors).map(item => clip(String(item), 400)).filter(Boolean),
  };
}

// --------------------------------------------------------------- the document

const releaseVersion = async (path, expected) => {
  const value = await jsonOf(path);
  if (!value || typeof value !== 'object' || (typeof value.package === 'string' && value.package !== expected)) return null;
  return typeof value.version === 'string' && value.version.trim() ? clip(value.version, 40) : null;
};

// The game version a package was built for (release.json "game", packaging/build-release.mjs --game). A release.json without it is from a build made before
// there was one per game: the 2.31 build.
export const DEFAULT_BUILD_GAME = '2.31';
const releaseGame = async path => {
  const value = await jsonOf(path);
  const game = typeof value?.game === 'string' ? value.game.trim() : '';
  return /^\d{1,2}\.\d{1,2}$/.test(game) ? game : DEFAULT_BUILD_GAME;
};

const settingsOf = async source => {
  try {
    const value = typeof source === 'function' ? await source() : source;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
};

/**
 * The services the chosen conversation provider and voice need, conversation first, each once. `custom` ({hostname, host, port}: the saved endpoint of the custom
 * provider, bridge/custom-endpoint.mjs) is given only when that provider is set up; chosen but not set up, Convai answers and is the service checked.
 */
export function neededServices(settings, {custom = null} = {}) {
  const chosen = settings?.conversationProvider;
  const conversation = chosen === 'mistral' || chosen === 'local' ? chosen : chosen === 'custom' && custom ? 'custom' : 'convai';
  const services = [];
  if (conversation === 'convai') services.push('convai');
  else if (conversation === 'mistral') services.push('mistral');
  else if (conversation === 'custom') services.push('custom');
  // The Convai cloud voice is only available while Convai answers; with another provider the bridge speaks with Pocket instead.
  const voice = settings?.voiceProvider;
  if (voice === 'voxtral') services.push('mistral');
  else if (voice === 'convai' && conversation === 'convai') services.push('convai');
  return [...new Set(services)];
}

const LOCAL_REASONS = Object.freeze({'low-memory': 'no-memory', 'no-gpu': 'no-gpu', 'start-failed': 'start-failed', crashed: 'crashed', 'not-installed': 'not-installed'});

/** The local-ai check from what the bridge knows (see the options of collectSetupCheck). Pure. */
export function localAiCheck(settings, info = {}) {
  const selected = settings?.conversationProvider === 'local';
  const ownServer = info.ownServer === true;
  // A model file of the player's own runs on the Runtime's engine with no pack (2026-10-29), so it counts as installed like a server of theirs.
  const ownModel = info.ownModel === true;
  const installed = info.packInstalled === true || ownServer || ownModel;
  if (!selected) return {state: 'ok', code: 'not-used', selected: false, installed};
  let code;
  if (!installed) code = 'not-installed';
  // Only Mature models are installed and Mature content is off: nothing starts, even though no start has been tried yet.
  else if (info.reason === 'mature-off' || (info.matureOnly === true && settings.matureContent !== true && !ownServer && !ownModel)) code = 'mature-off';
  else if (info.status === 'ready' || info.status === 'warming') code = info.status;
  else if (info.status === 'no-memory') code = 'no-memory';
  else if (info.status === 'not-installed') code = 'not-installed';
  else code = LOCAL_REASONS[info.reason] ?? 'failed';
  return {state: code === 'ready' || code === 'warming' ? 'ok' : 'problem', code, selected: true, installed, ...(code === 'start-failed' && info.playerServer === true ? {playerServer: true} : {}),
    // Windows refused to run a file of the model server (Smart App Control or an Application Control policy): the Help row says so and what to do.
    ...(code === 'start-failed' && info.blocked === true ? {cause: 'blocked'} : {})};
}

const text = (value, size) => clip(value, size) ?? '';

/**
 * Builds runtime/setup-check.json's document (the schema is in docs/ and mod/setup-check.lua reads it). Options (all injectable):
 *   game, modRoot, project, stateDirectory, plugin; settings (an object, or a function returning one)
 *   localAi() -> {status, reason, packInstalled, tiers, matureOnly, ownServer, ownModel, models}   omniPack() -> {installed, missing}
 *   browser() -> name|null   graphics() -> [{name, memoryMiB}]   modManagers() -> {managers}   reach(host) -> code
 *   python({light}) -> {state, missing[], missingCount, layout} (the Runtime's Python has its files; default: bridge/runtime-python.mjs)
 *   omniPython({light}) -> null | {used, backend, reason, module, device, vramMiB, testing?} (only with omni-python.txt)
 *   nestedPacks() -> [{pack, folder}]   placement() -> {fixed, conflicts, errors}|null   voice() -> null | {engine, reason} (the Pocket voice failed to start)
 *   now, request (the id this run answers, or null), light (no process started, no connection made: the graphics card, the browser
 *   and the internet test then read 'unknown').
 */
export async function collectSetupCheck(options = {}) {
  const {game, modRoot, project, stateDirectory, now = Date.now, light = false} = options;
  const request = typeof options.request === 'string' && REQUEST_ID.test(options.request) ? options.request : null;
  const settings = await settingsOf(options.settings);
  const call = async (name, ...args) => {
    const source = options[name];
    if (typeof source !== 'function') throw Error(`${name} is not available`);
    return source(...args);
  };
  const guarded = async (id, work) => {
    try { return {id, ...await work()}; } catch { return {id, state: 'unknown', code: 'unknown'}; }
  };

  const versions = () => guarded('versions', async () => {
    const scripts = modRoot ? await releaseVersion(join(modRoot, 'release.json'), 'scripts') : null;
    let runtime = project ? await releaseVersion(join(project, 'release.json'), 'runtime') : null;
    // A development checkout has neither release.json; its package.json is the runtime's version.
    if (runtime === null && project) {
      const pack = await jsonOf(join(project, 'package.json'));
      runtime = typeof pack?.version === 'string' && pack.version.trim() ? clip(pack.version, 40) : null;
    }
    // The game each half was built for, in every answer: the game side (mod/setup-check.lua, the 'build' check) compares them with the running game.
    const scriptsGame = modRoot ? await releaseGame(join(modRoot, 'release.json')) : DEFAULT_BUILD_GAME;
    const runtimeGame = project ? await releaseGame(join(project, 'release.json')) : DEFAULT_BUILD_GAME;
    if (scripts === null || runtime === null) return {state: 'unknown', code: 'unknown', scripts, runtime, scriptsGame, runtimeGame};
    // From 0.3.4 the Scripts carry the code and the Runtime is the base (docs/PACKAGING.md, "Code in the Scripts"): the Scripts' release.json names
    // the oldest base they run on (runtimeBase), the Runtime's release.json is the base's version, and the code the Scripts installed into the
    // Runtime is listed in defaults/scripts-code.json. A base older than runtimeBase is 'base-old' (the row and the notice name the base needed).
    const required = modRoot ? clip((await jsonOf(join(modRoot, 'release.json')))?.runtimeBase, 40) : null;
    if (required) {
      const code = project ? clip((await jsonOf(join(project, 'defaults', 'scripts-code.json')))?.release, 40) : null;
      if (code !== scripts) return {state: 'problem', code: 'mismatch', scripts, runtime: code ?? runtime, scriptsGame, runtimeGame};
      if (scriptsGame !== runtimeGame) return {state: 'problem', code: 'game-mismatch', scripts, runtime, scriptsGame, runtimeGame, base: true};
      if (versionOrder(runtime, required) < 0) return {state: 'problem', code: 'base-old', scripts, runtime, required, scriptsGame, runtimeGame, base: true};
      const chain = project ? await checkRuntimeSteps({project, current: runtime}) : {code: 'none'};
      if (chain.code === 'gap') return {state: 'problem', code: 'chain-gap', scripts, runtime, scriptsGame, runtimeGame, from: clip(chain.from, 40), to: clip(chain.to, 40), base: true};
      if (chain.code === 'order') return {state: 'problem', code: 'chain-order', scripts, runtime, scriptsGame, runtimeGame, base: true};
      return {state: 'ok', code: 'match', scripts, runtime, required, scriptsGame, runtimeGame, base: true};
    }
    if (scripts !== runtime) return {state: 'problem', code: 'mismatch', scripts, runtime, scriptsGame, runtimeGame};
    // The same version, but built for different games (the 2.31 Runtime with the 2.5 Scripts, or the other way): they must be replaced together.
    if (scriptsGame !== runtimeGame) return {state: 'problem', code: 'game-mismatch', scripts, runtime, scriptsGame, runtimeGame};
    // The versions agree; the update steps on disk (bridge/runtime-steps.mjs) say whether a step in between was skipped.
    const chain = project ? await checkRuntimeSteps({project, current: runtime}) : {code: 'none'};
    if (chain.code === 'gap') return {state: 'problem', code: 'chain-gap', scripts, runtime, scriptsGame, runtimeGame, from: clip(chain.from, 40), to: clip(chain.to, 40)};
    if (chain.code === 'order') return {state: 'problem', code: 'chain-order', scripts, runtime, scriptsGame, runtimeGame};
    return {state: 'ok', code: 'match', scripts, runtime, scriptsGame, runtimeGame};
  });

  // The drive the game is on and the one the mod's data is on (the logs, the memories and the settings backups): the one with less free space is
  // named. Under 2 GiB it is a problem the game announces once per session and the Help page shows; a drive that cannot be read leaves the check unknown.
  // freeSpace(folder) -> bytes free for this player (a test seam; the real one is statfs, which starts nothing, so a light run does it too).
  const disk = () => guarded('disk', async () => {
    const free = options.freeSpace ?? (async folder => { const info = await statfs(folder); return Number(info.bavail) * Number(info.bsize); });
    let lowest = null;
    for (const folder of [game, stateDirectory]) {
      const letter = driveLetter(folder);
      if (!letter) continue;
      let bytes = null;
      try { bytes = await free(folder); } catch { bytes = null; }
      if (Number.isFinite(bytes) && bytes >= 0 && (lowest === null || bytes < lowest.bytes)) lowest = {letter, bytes};
    }
    if (!lowest) return {state: 'unknown', code: 'unknown'};
    // Rounded down to a tenth: a drive just under the line never reads "2".
    const freeGiB = Math.floor(lowest.bytes / 1024 ** 3 * 10) / 10;
    return {state: lowest.bytes < DISK_LOW_BYTES ? 'problem' : 'ok', code: lowest.bytes < DISK_LOW_BYTES ? 'low' : 'enough', drive: lowest.letter, freeGiB};
  });

  const packs = () => guarded('packs', async () => {
    const found = [];
    if (project && (await exists(join(project, 'pocket-tts')) || await exists(join(project, 'models', 'pocket')))) found.push('Pocket TTS');
    let omni = null;
    try { omni = await call('omniPack'); } catch { /* the OmniVoice entry is left out */ }
    if (omni?.installed === true) found.push('OmniVoice');
    let local = null;
    try { local = await call('localAi'); } catch { /* the Local AI entries are left out */ }
    if (local?.tiers?.standard) found.push('Local AI standard');
    if (local?.tiers?.lite) found.push('Local AI lite');
    const tiers = new Set((Array.isArray(local?.models) ? local.models : []).map(model => model?.tier));
    if (tiers.has('good')) found.push('Mature standard');
    if (tiers.has('lite')) found.push('Mature lite');
    const nestedFound = await (options.nestedPacks ? call('nestedPacks')
      : findNestedPacks({game, modRoot, plugin: options.plugin}));
    const nested = (Array.isArray(nestedFound) ? nestedFound : []).slice(0, 12)
      .map(row => ({pack: text(row?.pack, 60), folder: text(row?.folder, 260)})).filter(row => row.pack);
    let placed = null;
    try { placed = await (options.placement ? call('placement') : readPackPlacement({stateDirectory})); } catch { /* no report */ }
    const moved = (Array.isArray(placed?.fixed) ? placed.fixed : []).slice(0, 12)
      .map(row => ({pack: text(row?.pack, 60), from: text(row?.from, 260)})).filter(row => row.pack);
    const conflict = (Array.isArray(placed?.conflicts) && placed.conflicts.length > 0) || (Array.isArray(placed?.errors) && placed.errors.length > 0);
    const omniMissing = omni && omni.installed !== true && Array.isArray(omni.missing) ? omni.missing.slice(0, 8).map(name => text(name, 30)) : [];
    const code = nested.length ? 'nested' : conflict ? 'conflict' : 'ok';
    return {state: code === 'ok' ? 'ok' : 'problem', code, found, nested, moved, omniMissing};
  });

  const browser = () => guarded('browser', async () => {
    if (light) return {state: 'unknown', code: 'unknown', name: null};
    const name = await (options.browser ? call('browser') : cachedBrowserName());
    const clean = clip(name, 80);
    return clean ? {state: 'ok', code: 'found', name: clean} : {state: 'problem', code: 'missing', name: null};
  });

  const localAi = () => guarded('local-ai', async () => localAiCheck(settings, await call('localAi')));

  const internet = () => guarded('internet', async () => {
    // The custom provider's endpoint is asked for only while that provider is the chosen one (nothing is contacted otherwise).
    let custom = null;
    if (settings?.conversationProvider === 'custom') { try { custom = await call('custom'); } catch { custom = null; } }
    if (!(typeof custom?.hostname === 'string' && custom.hostname)) custom = null;
    const services = neededServices(settings, {custom});
    if (!services.length) return {state: 'ok', code: 'not-needed', service: null, host: null};
    // The name shown (host and port, never a path) and the name and port looked up.
    const shown = service => service === 'custom' ? clip(custom.host, 80) : SERVICE_HOSTS[service];
    if (light) return {state: 'unknown', code: 'unknown', service: services[0], host: shown(services[0])};
    const reach = options.reach ?? ((host, extra) => checkReachable(host, extra));
    // An IPv6 address is written in brackets in a URL ([::1], [fd00::5]); the name lookup and the connection want it without them.
    const lookedUp = service => service === 'custom' ? custom.hostname.replace(/^\[(.*)\]$/, '$1') : SERVICE_HOSTS[service];
    const results = await Promise.all(services.map(async service => {
      try { return {service, host: shown(service), code: await (service === 'custom' ? reach(lookedUp(service), {port: Number.isInteger(custom.port) ? custom.port : 443}) : reach(lookedUp(service)))}; }
      catch { return {service, host: shown(service), code: 'unknown'}; }
    }));
    const bad = results.find(row => row.code !== 'reachable');
    if (!bad) return {state: 'ok', code: 'reachable', service: results[0].service, host: results[0].host};
    return {state: ['no-dns', 'blocked', 'timeout'].includes(bad.code) ? 'problem' : 'unknown',
      code: ['no-dns', 'blocked', 'timeout'].includes(bad.code) ? bad.code : 'unknown', service: bad.service, host: bad.host};
  });

  const gpu = () => guarded('gpu', async () => {
    if (light) return {state: 'unknown', code: 'unknown', name: null, memoryMiB: null, adapters: []};
    const cards = await (options.graphics ? call('graphics') : cachedGraphicsCards());
    const adapters = (Array.isArray(cards) ? cards : []).slice(0, 8)
      .map(card => ({name: text(card?.name, 120), memoryMiB: Number.isFinite(card?.memoryMiB) && card.memoryMiB > 0 ? Math.round(card.memoryMiB) : null}))
      .filter(card => card.name);
    if (!adapters.length) return {state: 'unknown', code: 'unknown', name: null, memoryMiB: null, adapters: []};
    return {state: 'ok', code: 'found', name: adapters[0].name, memoryMiB: adapters[0].memoryMiB, adapters};
  });

  const modManager = () => guarded('mod-manager', async () => {
    const found = await (options.modManagers ? call('modManagers') : cachedModManagers({game}));
    const managers = (Array.isArray(found?.managers) ? found.managers : []).filter(name => name === 'mo2' || name === 'vortex');
    return {state: managers.length ? 'note' : 'ok', code: managers[0] ?? 'none', managers};
  });

  // redscript compiles this mod's scripts (engine/tools/scc.exe). The game side uses this only when the
  // scripts did not load: with no compiler there is no compile log to read, so it says "redscript is missing" instead of sending the player to one.
  // Only a file is looked at, so it is part of the light run too.
  const compiler = () => guarded('compiler', async () => {
    if (!game) return {state: 'unknown', code: 'unknown'};
    return await exists(join(game, 'engine', 'tools', 'scc.exe'), 'file') ? {state: 'ok', code: 'found'} : {state: 'problem', code: 'missing'};
  });

  // The Python of the voice workers (app/python: Pocket, V's voice, the local speech recognition) has every file they import (bridge/runtime-python.mjs; report
  // 0b8367fd0ebd2f2f: the folder Lib/urllib was gone, Python started, the voice never could). The light run reads the folders (no process); a full run also asks the Python itself,
  // once per bridge process while it answers well (a result that is a problem is asked again every time: the player may have reinstalled). Codes: 'ok' | 'incomplete';
  // `missing` is up to eight module names (never a folder), `missingCount` how many.
  const python = () => guarded('python', async () => {
    if (!project && typeof options.python !== 'function') return {state: 'unknown', code: 'unknown', layout: null, missing: [], missingCount: 0};
    const found = await (typeof options.python === 'function' ? call('python', {light}) : cachedRuntimePython({project, light}));
    const missing = (Array.isArray(found?.missing) ? found.missing : []).slice(0, 8).map(name => clip(name, 60)).filter(Boolean);
    const state = found?.state === 'ok' || found?.state === 'problem' ? found.state : 'unknown';
    return {state, code: state === 'problem' ? 'incomplete' : state === 'ok' ? 'ok' : 'unknown', layout: found?.layout === 'lib' || found?.layout === 'zip' ? found.layout : null,
      missing, missingCount: Number.isFinite(found?.missingCount) ? Math.max(0, Math.round(found.missingCount)) : missing.length};
  });

  // The Pocket voice (V's voice, and the companions' when Pocket is the voice they use): a problem only while a worker has failed and has not loaded
  // again. Only the bridge knows (voice() -> null | {engine, reason, cause?}); a run without it has no such row. The row gives the engine, never the reason's
  // words (they can hold a folder): the reason is in the log and the error report. `cause: 'blocked'` (Windows refused to load a file of the voice) and
  // `cause: 'virtual-memory'` (Windows ran out of memory, the paging file is too small) are the causes a row names.
  const voice = () => guarded('voice', async () => {
    const problem = await call('voice');
    if (!problem) return {state: 'ok', code: 'ok'};
    return {state: 'problem', code: 'pocket-failed', engine: clip(problem.engine, 20) ?? 'pocket', ...(['blocked', 'virtual-memory', 'missing-files'].includes(problem.cause) ? {cause: problem.cause} : {})};
  });

  // The player's own Python for OmniVoice (<data>/omni-python.txt, docs/OMNIVOICE_AMD.md): a row only when the file names one. omniPython({light}) -> null |
  // {used, backend, reason, module, device, vramMiB, testing?} (bridge/omni-own-python.mjs ownPythonSummary). 'used' names the backend (CUDA or ROCm) and the card;
  // 'refused' the reason code the game words; 'untested' or 'testing' until its self-test has run (it runs when OmniVoice is first wanted, or on the Help page's run).
  const omniPython = async () => {
    let found;
    try { found = await call('omniPython', {light}); } catch { return null; }
    if (!found || typeof found !== 'object' || found.configured === false) {
      // No omni-python.txt: on a PC with a discrete AMD Radeon card and no NVIDIA one, the row points to the experimental AMD route (docs/OMNIVOICE_AMD.md). The
      // card list is the cached one the GPU row reads; the start-up run (light) does not read it.
      if (light || found === undefined) return null;
      try {
        const cards = await (options.graphics ? call('graphics') : cachedGraphicsCards());
        const amd = (Array.isArray(cards) ? cards : []).filter(card => gpuVendors([card]).includes('amd'));
        return amdRoute(cards) ? {id: 'omni-python', state: 'note', code: 'amd-route', device: clip(amd.find(card => amdRoute([card]))?.name, 80)} : null;
      } catch { return null; }
    }
    const backend = ['cuda', 'rocm', 'none'].includes(found.backend) ? found.backend : null;
    // `managed`: the Python of Settings > Voices > OmniVoice for AMD (bridge/omni-amd-setup.mjs), not the player's own omni-python.txt.
    const managed = found.managed === true ? {managed: true} : {};
    if (found.used === true) return {id: 'omni-python', state: 'ok', code: 'used', backend, device: clip(found.device, 80),
      memoryMiB: Number.isFinite(found.vramMiB) && found.vramMiB > 0 ? Math.round(found.vramMiB) : null, ...managed};
    if (typeof found.reason === 'string' && found.reason) return {id: 'omni-python', state: 'problem', code: 'refused', reason: text(found.reason, 30),
      module: clip(found.module, 60), backend, ...managed};
    return {id: 'omni-python', state: 'unknown', code: found.testing === true ? 'testing' : 'untested'};
  };

  // The microphone in use (Settings > Voices > Microphone): a row once an input has been opened this session or one is chosen, with the input's label (never its id).
  // microphone() -> null | {chosen, device, missing} (bridge/mic-devices-control.mjs summary). 'chosen': the input the player chose is the one in use; 'missing': it was not
  // found and the Windows default is in use; 'default': the Windows default. A chosen input not opened yet is named as chosen.
  const microphone = async () => {
    let found;
    try { found = await call('microphone'); } catch { return null; }
    if (!found || typeof found !== 'object') return null;
    const chosen = clip(found.chosen, 160), device = clip(found.device, 160);
    if (found.missing === true && chosen) return {id: 'microphone', state: 'note', code: 'missing', device, chosen};
    // The input in use looks like a loopback or virtual input (Stereo Mix, CABLE Output, a mixer's Out): it may carry the PC's sound, such as the far side of a call.
    if (found.loopback === true && (device || chosen)) return {id: 'microphone', state: 'note', code: 'loopback', device: device ?? chosen, ...(chosen ? {chosen} : {})};
    if (chosen) return {id: 'microphone', state: 'ok', code: 'chosen', device: device ?? chosen, chosen};
    if (device) return {id: 'microphone', state: 'ok', code: 'default', device};
    return null;
  };

  const checks = (await Promise.all([versions(), packs(), browser(), localAi(), internet(), gpu(), modManager(), compiler(), disk(), python(),
    ...(typeof options.voice === 'function' ? [voice()] : []), ...(typeof options.omniPython === 'function' ? [omniPython()] : []),
    ...(typeof options.microphone === 'function' ? [microphone()] : [])])).filter(Boolean);
  return {version: 1, updated: now(), bridgePid: process.pid, request, checks};
}

// -------------------------------------------------------------- bridge side

/** A request is {version: 1, id, issuedAt}; anything else (including a half-written file) is null. */
export function parseSetupRequest(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > REQUEST_MAX_BYTES) return null;
  let value; try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
      || typeof value.id !== 'string' || !REQUEST_ID.test(value.id)
      || !Number.isFinite(value.issuedAt) || value.issuedAt < 0) return null;
  return {id: value.id, issuedAt: value.issuedAt};
}

/**
 * File IPC for the Help page's setup check. Only a request that appears after the bridge started, is well formed and recent is
 * answered (once per id); a request left by an earlier session is never replayed. The request file is only read, and the answer
 * replaces runtime/setup-check.json in place: nothing is deleted or renamed here.
 */
export class SetupCheckControl {
  static async open({runtime, collect, now = Date.now, requestPath, resultPath, log = () => {}}) {
    const control = new SetupCheckControl({runtime, collect, now, requestPath, resultPath, log});
    control.observed = await readFile(control.requestPath, 'utf8').catch(() => '');
    return control;
  }
  constructor({runtime, collect, now = Date.now, requestPath, resultPath, log = () => {}}) {
    Object.assign(this, {collect, now, log});
    this.requestPath = requestPath ?? join(runtime, SETUP_REQUEST_FILE);
    this.resultPath = resultPath ?? join(runtime, SETUP_CHECK_FILE);
    this.observed = ''; this.polling = false; this.closed = false; this.handled = new Set();
    this.running = null; this.queued = null;
  }

  /**
   * Builds the document and writes it. One run at a time: a run asked for while another is going runs once more after it (any number
   * of asks share that one), answering the newest request id. `light` skips what starts a process or opens a connection; a queued
   * run is light only if every ask for it was. Resolves with the document (null when it could not be built or the control is closed).
   */
  run(requestId = null, {light = false} = {}) {
    if (this.closed) return Promise.resolve(null);
    if (this.running) {
      this.queued = {id: requestId ?? this.queued?.id ?? null, light: light && (this.queued?.light ?? true)};
      return this.running;
    }
    this.running = this.#loop(requestId, light);
    return this.running;
  }

  async #loop(requestId, light) {
    try {
      let id = requestId, quick = light, document = null;
      for (;;) {
        document = await this.#once(id, quick);
        if (!this.queued || this.closed) return document;
        ({id, light: quick} = this.queued); this.queued = null;
      }
    } finally { this.running = null; }
  }

  async #once(id, light) {
    try {
      const document = await this.collect(id, {light});
      if (!document || typeof document !== 'object') return null;
      await atomicFile(this.resultPath, JSON.stringify(document));
      return document;
    } catch (error) {
      this.log(`Setup check failed: ${error?.message ?? error}`);
      return null;
    }
  }

  async poll() {
    if (this.polling || this.closed) return;
    this.polling = true;
    try {
      const raw = await readFile(this.requestPath, 'utf8').catch(() => '');
      if (raw === this.observed) return;
      this.observed = raw;
      const request = parseSetupRequest(raw);
      if (!request || this.handled.has(request.id)) return;
      const at = this.now();
      if (request.issuedAt > at + REQUEST_FUTURE_MS || at - request.issuedAt > REQUEST_MAX_AGE_MS) return;
      this.handled.add(request.id);
      await this.run(request.id);
    } finally { this.polling = false; }
  }

  close() { this.closed = true; }
}
