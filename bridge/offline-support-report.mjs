import {open, readFile, readdir, realpath, stat} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import os from 'node:os';
import {readKeyFileText} from './key-codec.mjs';
import {buildReport, locateLogs, reportsDirectoryFor, tailFile} from './support-report.mjs';
import {detectModManagers} from './setup-check.mjs';

// Support report with the game closed: "Make support report.bat" in red4ext/plugins/AiNpcCyberpunkMod starts bridge/make-support-report.mjs
// with the bundled Node, which calls runOfflineReport() here. It is for players who cannot reach Companion Manager > Settings > Help
// (the mod never loads: a redscript compile failure, Mod Configuration Menu missing, a manager that will not open).
//
// It writes the same zip the in-game report writes (bridge/support-report.mjs collectReport and buildReport: the same logs, the same
// redactor, the same privacy rules, the same reports folder), made from the files on disk. No service is running and none is started.
// On top of that it adds
//   * a requirement check: which of Cyber Engine Tweaks, RED4ext, redscript, Codeware, TweakXL, Audioware, Mod Configuration Menu (and
//     ArchiveXL, when present) are installed, with the version where one can be read, and whether this mod's own three pieces (the CET
//     folder, the redscript folder and the RED4ext plugin) are where they belong;
//   * the versions in the Scripts and the Runtime release.json;
//   * one PROBLEM line for each missing piece, in the README and in summary.json.
//
// Mod Organizer 2 keeps each mod in its own folder under its mods folder and shows the game a merged view only while the game (or a tool)
// is started through it. Started outside MO2, from a Runtime that lives in MO2's mods folder, this tool looks in the game folder named in
// ModOrganizer.ini, in Overwrite (where the game's logs end up) and in every enabled mod folder. Whatever it cannot find is said plainly,
// with a hint to start it through MO2. Nothing here throws at the player: every step that fails leaves a note instead.

export const MOD_NAME = 'AiNpcCyberpunkMod';
const MOD_FOLDER = ['bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', MOD_NAME];
const PLUGIN_FOLDER = ['red4ext', 'plugins', MOD_NAME];
const REDS_FOLDER = ['r6', 'scripts', 'CyberpunkConvai'];
const GAME_EXE = ['bin', 'x64', 'Cyberpunk2077.exe'];
const CET_MODS = ['bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods'];
const DATA_HOME_NAME = 'AiNpcCyberpunkMod';
const DATA_HOME_VARIABLE = 'CYBERPUNK_CONVAI_DATA_HOME';

const show = parts => parts.join('\\');

export const MO2_HINT = 'Hint for Mod Organizer 2: it keeps mod files in its own mods folder, so a check started outside MO2 can miss them. '
  + 'In MO2, add this file under Executables, start it from there and send the new report.';

// ------------------------------------------------------------------ small helpers

const isFile = async path => stat(path).then(info => info.isFile(), () => false);
const isDir = async path => stat(path).then(info => info.isDirectory(), () => false);
const exists = (path, kind) => kind === 'dir' ? isDir(path) : isFile(path);

async function readSmall(path, maxBytes = 262144) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) return null;
    return (await readFile(path, 'utf8')).replace(/^﻿/, '');
  } catch { return null; }
}

// The first bytes of a log: RED4ext lists the plugins it loaded near the top of each session's file.
async function headOf(path, bytes = 65536) {
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(bytes);
    const {bytesRead} = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return ''; }
  finally { await handle?.close().catch(() => {}); }
}

const clip = (value, size = 60) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, size) || null : null;

// ----------------------------------------------------------------- where the data is

// The same rule as packaging/runtime/state-home.mjs (dataHomeFor), which the bridge cannot import: a test keeps the two equal.
const QUALIFIED = /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i;
const usable = value => typeof value === 'string' && value === value.trim() && value !== '' && !/[\x00-\x1f]/.test(value)
  && isAbsolute(value) && (process.platform !== 'win32' || QUALIFIED.test(value));

/** The folder that holds data/ and reports/ for this player, or null (no %LOCALAPPDATA%): the data then stays in the game folder. */
export function dataHomeRoot(env = process.env) {
  const override = env[DATA_HOME_VARIABLE];
  if (override !== undefined && override !== '' && usable(override)) return resolve(override);
  return usable(env.LOCALAPPDATA) ? resolve(env.LOCALAPPDATA, DATA_HOME_NAME) : null;
}

// ------------------------------------------------------------ Mod Organizer 2 layout

const SIMPLE_ESCAPES = Object.freeze({a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'", '?': '?'});

/**
 * One value as QSettings (IniFormat) writes it: "quoted" parts (a value holding , ; or = is quoted whole), \\ \" \t... escapes and \xHHHH
 * character codes (Qt reads every hex digit that follows, so it escapes a hex digit after one too). An escape Qt never writes is kept as it is.
 */
export function qsettingsUnescape(raw) {
  const text = String(raw ?? '');
  let out = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') continue;
    if (char !== '\\' || index + 1 === text.length) { out += char; continue; }
    const next = text[++index];
    if (Object.hasOwn(SIMPLE_ESCAPES, next)) { out += SIMPLE_ESCAPES[next]; continue; }
    const hex = next === 'x' ? /^[0-9a-f]+/i.exec(text.slice(index + 1))?.[0] : null;
    const octal = /[0-7]/.test(next) ? /^[0-7]+/.exec(text.slice(index))[0] : null;
    if (hex) { out += String.fromCharCode(Number.parseInt(hex.slice(-4), 16)); index += hex.length; continue; }
    if (octal) { out += String.fromCharCode(Number.parseInt(octal.slice(-6), 8) & 0xffff); index += octal.length - 1; continue; }
    out += `\\${next}`;
  }
  return out;
}

/**
 * A ModOrganizer.ini value. MO2 keeps gamePath and selected_profile as @ByteArray(...) of UTF-8 bytes: every backslash doubled and every byte
 * above 0x7f written as \xHH (C:\\Users\\J\xc3\xbcrgen), the whole value in quotes when it holds a comma.
 */
export function iniValue(text, name) {
  const match = new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(.*?)[ \\t]*\\r?$`, 'im').exec(String(text ?? ''));
  if (!match) return null;
  let value = qsettingsUnescape(match[1]);
  const bytes = /^@ByteArray\((.*)\)$/s.exec(value);
  if (bytes) {
    // A hand-edited file may hold the characters themselves rather than their UTF-8 bytes: those are kept as they are.
    const inner = bytes[1], decoded = /[^\x00-\xff]/.test(inner) ? inner : Buffer.from(inner, 'latin1').toString('utf8');
    value = decoded.includes('\ufffd') && !inner.includes('\ufffd') ? inner : decoded;
  } else if (value.startsWith('@@')) value = value.slice(1);
  return value || null;
}

/** The names of the enabled mods in a profile's modlist.txt ("+Name" is enabled, "-Name" disabled, "*" is a game file), listed first = wins. */
export function enabledMods(text) {
  return String(text ?? '').split(/\r?\n/).filter(line => line.startsWith('+')).map(line => line.slice(1).trim()).filter(Boolean);
}

/** An instance's folders, as MO2 works them out: base_directory (else the folder of ModOrganizer.ini), and mods, profiles and overwrite under it unless set. */
export function mo2Paths(ini, instance) {
  const base = resolve(instance, iniValue(ini, 'base_directory') ?? '.');
  const path = (key, name) => resolve(base, (iniValue(ini, key) ?? `%BASE_DIR%/${name}`).replace(/%BASE_DIR%/gi, () => base));
  return {base, mods: path('mod_directory', 'mods'), profiles: path('profiles_directory', 'profiles'), overwrite: path('overwrite_directory', 'overwrite')};
}

const samePath = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

/**
 * The Mod Organizer 2 instance whose mods folder holds this Runtime (<mods>/<this mod>/red4ext/plugins/AiNpcCyberpunkMod). A portable instance
 * keeps ModOrganizer.ini one to three levels above mods; a global one keeps it in %LOCALAPPDATA%\ModOrganizer\<instance>, wherever its base
 * directory and mods folder are (another drive, mod_directory moved). The instance whose mods folder is this one wins; else the first
 * ModOrganizer.ini above it.
 */
async function findMo2(plugin, env) {
  const modFolder = resolve(plugin, '..', '..', '..'), modsDirectory = dirname(modFolder);
  if (modFolder === modsDirectory) return null;
  const above = [];
  let directory = dirname(modsDirectory);
  for (let level = 0; level < 3 && directory !== dirname(directory); level++, directory = dirname(directory)) above.push(directory);
  const global = [];
  if (usable(env.LOCALAPPDATA)) {
    const root = join(env.LOCALAPPDATA, 'ModOrganizer');
    try { for (const entry of await readdir(root, {withFileTypes: true})) if (entry.isDirectory()) global.push(join(root, entry.name)); } catch { /* none */ }
  }
  let fallback = null;
  for (const instance of [...above, ...global]) {
    const ini = await readSmall(join(instance, 'ModOrganizer.ini'), 1048576);
    if (ini === null) continue;
    const found = {instance, ini, paths: mo2Paths(ini, instance), modsDirectory, modFolder};
    if (samePath(found.paths.mods, modsDirectory)) return found;
    if (!fallback && above.includes(instance)) fallback = found;
  }
  return fallback;
}

async function readMo2({instance, ini, paths, modsDirectory}) {
  const profile = iniValue(ini, 'selected_profile');
  const gamePath = iniValue(ini, 'gamePath');
  const overwrite = paths.overwrite;
  const list = profile ? await readSmall(join(paths.profiles, profile, 'modlist.txt'), 4 * 1048576) : null;
  // A profile's list is what the game sees, even when it enables nothing. Only without one does every mod folder count, enabled or not.
  const enabledOnly = list !== null;
  let names = enabledOnly ? enabledMods(list) : [];
  if (!enabledOnly) {
    try { names = (await readdir(modsDirectory, {withFileTypes: true})).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(); }
    catch { names = []; }
  }
  const roots = [];
  if (await isDir(overwrite)) roots.push({path: overwrite, label: 'MO2 Overwrite'});
  for (const name of names) {
    const path = join(modsDirectory, name);
    if (await isDir(path)) roots.push({path, label: `MO2 mod: ${name}`});
  }
  return {instance, profile, gamePath, overwrite: roots.some(root => root.label === 'MO2 Overwrite'), modCount: roots.filter(root => root.label !== 'MO2 Overwrite').length,
    enabledOnly, roots};
}

// ------------------------------------------------------------------------- layout

/**
 * Works out where everything is. `appDirectory` is the Runtime's app folder (red4ext/plugins/AiNpcCyberpunkMod/app); `game` is an
 * explicit game folder (--game, or CYBERPUNK_CONVAI_GAME). Returns
 *   {game, gameFound, packaged, roots: [{path, label}], mo2, modRoot, runtime, plugin, app, project, stateDirectory, dataHome, find(parts, kind)}
 * `find` looks for a game-relative path where the game finds it first: under Mod Organizer 2 in Overwrite, then in the enabled mods (first
 * in modlist.txt wins), then in the game folder; otherwise in the game folder. It gives {path, root} or null.
 */
export async function resolveOfflineLayout({appDirectory, game: asked, env = process.env} = {}) {
  const isPackaged = path => basename(path).toLowerCase() === 'app' && basename(dirname(path)).toLowerCase() === MOD_NAME.toLowerCase()
    && basename(dirname(dirname(path))).toLowerCase() === 'plugins' && basename(dirname(dirname(dirname(path)))).toLowerCase() === 'red4ext';
  let app = resolve(appDirectory);
  // Started through a short 8.3 path (C:\GAMES\CYBERP~1\red4ext\plugins\AINPCC~1\app): the long names are what the checks compare.
  if (!isPackaged(app)) { const long = await realpath(app).catch(() => null); if (long && isPackaged(long)) app = long; }
  const pluginOfApp = dirname(app);
  const packaged = isPackaged(app);
  const derived = packaged ? resolve(pluginOfApp, '..', '..', '..') : null;
  const isGame = path => isFile(join(path, ...GAME_EXE));
  const given = value => typeof value === 'string' && value.trim() ? resolve(value.trim()) : null;

  // The folder named with --game wins; then the one this install sits in; the developer's CYBERPUNK_CONVAI_GAME is only the last resort.
  const candidates = [];
  if (given(asked)) candidates.push(given(asked));
  if (derived) candidates.push(derived);
  if (given(env.CYBERPUNK_CONVAI_GAME)) candidates.push(given(env.CYBERPUNK_CONVAI_GAME));
  let game = null;
  for (const candidate of candidates) if (await isGame(candidate)) { game = candidate; break; }

  // Started from a mod folder of Mod Organizer 2 (the Runtime is not in the game folder): ModOrganizer.ini names the game.
  const inGame = derived !== null && game === derived;
  const found = packaged && !inGame ? await findMo2(pluginOfApp, env) : null;
  const mo2 = found ? await readMo2(found) : null;
  let gameFromIni = false;
  if (!game && mo2?.gamePath && await isGame(resolve(mo2.gamePath))) { game = resolve(mo2.gamePath); gameFromIni = true; }
  const gameFound = game !== null;
  game ??= candidates[0] ?? app;

  // The game started through MO2 sees Overwrite over the mods and the mods over its own folder: a leftover copy in the game folder loses.
  const roots = [...(mo2?.roots ?? []), {path: game, label: 'game folder'}];
  const find = async (parts, kind = 'file') => {
    for (const root of roots) {
      const path = join(root.path, ...parts);
      if (await exists(path, kind)) return {path, root};
    }
    return null;
  };
  // The mod's own folder is the one holding init.lua (Overwrite may hold a partial copy with only a log in it); the plugin folder, the one with the DLL.
  const initLua = await find([...MOD_FOLDER, 'init.lua'], 'file'), dll = await find([...PLUGIN_FOLDER, 'CyberpunkConvai.dll'], 'file');
  const modRoot = initLua ? dirname(initLua.path) : (await find(MOD_FOLDER, 'dir'))?.path ?? join(game, ...MOD_FOLDER);
  const plugin = dll ? dirname(dll.path) : (await find(PLUGIN_FOLDER, 'dir'))?.path ?? join(game, ...PLUGIN_FOLDER);
  const installedApp = join(plugin, 'app');
  const project = await isDir(installedApp) ? installedApp : app;
  const runtime = join(modRoot, 'runtime');

  // The data folder: %LOCALAPPDATA%\AiNpcCyberpunkMod\data, or the old one inside the mod folder (a move that was put off, or no profile).
  const dataHome = dataHomeRoot(env);
  const stateCandidates = [dataHome ? join(dataHome, 'data') : null, join(modRoot, 'data')].filter(Boolean);
  let stateDirectory = null;
  for (const path of stateCandidates) if (await isDir(path)) { stateDirectory = path; break; }
  stateDirectory ??= stateCandidates[0];

  return {game, gameFound, gameFromIni, packaged, roots, mo2, modRoot, runtime, plugin, app, project, stateDirectory, dataHome,
    stateExists: await isDir(stateDirectory), find};
}

// ---------------------------------------------------------------------- requirements

// Where each requirement's files must be (relative to the game folder). One missing file makes it "incomplete"; all of them, "missing".
export const REQUIREMENTS = Object.freeze([
  {id: 'cet', name: 'Cyber Engine Tweaks', files: [['bin', 'x64', 'plugins', 'cyber_engine_tweaks.asi']]},
  {id: 'red4ext', name: 'RED4ext', files: [['red4ext', 'RED4ext.dll'], ['bin', 'x64', 'winmm.dll']]},
  {id: 'redscript', name: 'redscript', files: [['engine', 'tools', 'scc.exe']]},
  {id: 'codeware', name: 'Codeware', files: [['red4ext', 'plugins', 'Codeware', 'Codeware.dll']]},
  {id: 'tweakxl', name: 'TweakXL', files: [['red4ext', 'plugins', 'TweakXL', 'TweakXL.dll']]},
  {id: 'audioware', name: 'Audioware', files: [['red4ext', 'plugins', 'audioware', 'audioware.dll']]},
  {id: 'mcm', name: 'Mod Configuration Menu', files: [[...CET_MODS, 'ModConfigurationMenuAPI', 'init.lua']],
    folders: [['r6', 'scripts', 'ModConfigurationMenu']]},
  {id: 'archivexl', name: 'ArchiveXL', optional: true, files: [['red4ext', 'plugins', 'ArchiveXL', 'ArchiveXL.dll']]},
]);

// RED4ext's log lists every plugin it loaded, one line each: "[RED4ext] Codeware (version: 1.20.5, author(s): psiberx) has been loaded".
export function pluginVersions(text) {
  const result = {red4ext: null, plugins: new Map()};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const own = /\[RED4ext\]\s+RED4ext \(v([^)\s]+)\)/.exec(line);
    if (own) { result.red4ext = clip(own[1], 30); continue; }
    const plugin = /\[RED4ext\]\s+(.+?)\s+\(version:\s*([^,)\s]+)/.exec(line);
    if (plugin) result.plugins.set(plugin[1].trim().toLowerCase(), clip(plugin[2], 30));
  }
  return result;
}

const cetVersionOf = lines => {
  let version = null;
  for (const line of lines) { const match = /CET version (\S+)/.exec(line); if (match) version = clip(match[1], 30); }
  return version;
};

async function readVersions(layout, logs) {
  const path = id => logs.find(entry => entry.id === id)?.path;
  const found = {};
  const red4extPath = path('red4ext');
  const fromRed4ext = red4extPath && await isFile(red4extPath) ? pluginVersions(await headOf(red4extPath)) : {red4ext: null, plugins: new Map()};
  const cetPath = path('cet');
  const cet = cetPath ? await tailFile(cetPath, {maxBytes: 4 * 1024 * 1024, maxLines: 100000}) : null;
  found.cet = {version: cetVersionOf(cet?.lines ?? []), source: 'CET log of the last game start'};
  found.red4ext = {version: fromRed4ext.red4ext, source: 'RED4ext log of the last game start'};
  for (const id of ['codeware', 'tweakxl', 'audioware', 'archivexl']) {
    found[id] = {version: fromRed4ext.plugins.get(REQUIREMENTS.find(item => item.id === id).name.toLowerCase()) ?? null, source: 'RED4ext log of the last game start'};
  }
  // MCM states its version in one line of its API module.
  const core = await layout.find([...CET_MODS, 'ModConfigurationMenuAPI', 'modules', 'core.lua'], 'file');
  const text = core ? (await headOf(core.path, 16384)) : '';
  found.mcm = {version: clip(/PUBLIC_VERSION\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ?? null, 30), source: 'Mod Configuration Menu files'};
  // redscript's compiler (scc.exe) prints no version in any file this tool may read.
  found.redscript = {version: null, source: null};
  return found;
}

/** [{id, name, optional, state, missing, foundIn, version, versionSource}]; state: present | incomplete | missing | absent (optional) | unknown. */
export async function checkRequirements(layout, logs = []) {
  const versions = await readVersions(layout, logs);
  const rows = [];
  for (const spec of REQUIREMENTS) {
    const wanted = [...(spec.files ?? []).map(parts => ({parts, kind: 'file'})), ...(spec.folders ?? []).map(parts => ({parts, kind: 'dir'}))];
    const missing = [], where = new Set();
    for (const {parts, kind} of wanted) {
      const hit = await layout.find(parts, kind);
      if (hit) where.add(hit.root.label); else missing.push(show(parts));
    }
    let state = missing.length === 0 ? 'present' : missing.length === wanted.length ? (spec.optional ? 'absent' : 'missing') : 'incomplete';
    // Without the game folder the search was not complete: say "unknown", not "missing".
    if (!layout.gameFound && state !== 'present') state = 'unknown';
    const present = state === 'present' || state === 'incomplete';
    rows.push({id: spec.id, name: spec.name, optional: spec.optional === true, state, missing, foundIn: [...where],
      version: present ? versions[spec.id]?.version ?? null : null, versionSource: present && versions[spec.id]?.version ? versions[spec.id].source : null});
  }
  return rows;
}

// ------------------------------------------------------------- this mod's own pieces

async function readRelease(path) {
  const text = await readSmall(path, 65536);
  if (text === null) return {found: false, version: null};
  try {
    const value = JSON.parse(text);
    return {found: true, version: clip(value?.version, 40), package: clip(value?.package, 20)};
  } catch { return {found: true, version: null}; }
}

export async function checkModFiles(layout) {
  const {find, modRoot, plugin} = layout;
  const result = {};
  const init = await find([...MOD_FOLDER, 'init.lua'], 'file');
  let luaFiles = 0;
  if (init) { try { luaFiles = (await readdir(dirname(init.path))).filter(name => /\.lua$/i.test(name)).length; } catch {} }
  result.scripts = {state: init ? 'present' : 'missing', path: show([...MOD_FOLDER, 'init.lua']), luaFiles, foundIn: init?.root.label ?? null,
    release: await readRelease(join(init ? dirname(init.path) : modRoot, 'release.json'))};
  const reds = await find(REDS_FOLDER, 'dir');
  let redsFiles = 0;
  if (reds) { try { redsFiles = (await readdir(reds.path)).filter(name => /\.reds$/i.test(name)).length; } catch {} }
  result.redscript = {state: redsFiles > 0 ? 'present' : reds ? 'empty' : 'missing', path: show(REDS_FOLDER), redsFiles, foundIn: reds?.root.label ?? null};
  const dll = await find([...PLUGIN_FOLDER, 'CyberpunkConvai.dll'], 'file');
  const base = dll ? dirname(dll.path) : plugin;
  const parts = {node: await isFile(join(base, 'app', 'node', 'node.exe')), bridge: await isFile(join(base, 'app', 'bridge', 'convai-bridge.mjs')),
    launcherIni: await isFile(join(base, 'launcher.ini'))};
  result.plugin = {state: dll ? 'present' : 'missing', path: show([...PLUGIN_FOLDER, 'CyberpunkConvai.dll']), foundIn: dll?.root.label ?? null, ...parts,
    release: await readRelease(join(base, 'app', 'release.json'))};
  return result;
}

// The last compile's errors: redscript starts a new log for each game start, so every [ERROR line in it is from the last start.
export async function redscriptErrors(logs) {
  const entry = logs.find(item => item.id === 'redscript');
  const tail = entry ? await tailFile(entry.path) : null;
  return (tail?.lines ?? []).filter(line => /^\[ERROR\b/.test(line)).length;
}

// ------------------------------------------------------------------------ problems

/** The PROBLEM lines: pure, from what the checks found. */
export function offlineProblems({layout, rows, files, errors = 0, managers = []}) {
  const problems = [];
  if (!layout.gameFound) {
    problems.push(`The Cyberpunk 2077 folder was not found: ${layout.game} has no ${show(GAME_EXE)}. `
      + `Run Make support report.bat from red4ext\\plugins\\${MOD_NAME} inside the game folder, or give the folder with --game.`);
  }
  // Without the game folder the checks below did not look everywhere, so they say nothing about what is missing.
  if (layout.gameFound) {
    for (const row of rows) {
      if (row.state === 'missing') problems.push(`${row.name} is missing: ${row.missing[0]} was not found. Install it.`);
      else if (row.state === 'incomplete') problems.push(`${row.name} is incomplete: ${row.missing[0]} was not found. Install it again.`);
    }
    if (files.scripts.state === 'missing') problems.push(`The mod's CET folder is missing: ${files.scripts.path} was not found. Install the Scripts package.`);
    if (files.redscript.state === 'missing') problems.push(`The mod's redscript folder is missing: ${show(REDS_FOLDER)} was not found. Install the Scripts package.`);
    else if (files.redscript.state === 'empty') problems.push(`The mod's redscript folder is empty: ${show(REDS_FOLDER)} has no .reds files. Install the Scripts package.`);
    if (files.plugin.state === 'missing') problems.push(`The mod's RED4ext plugin is missing: ${files.plugin.path} was not found. Install the Runtime package, and check that antivirus has not removed it.`);
    else {
      const absent = [files.plugin.node ? null : show([...PLUGIN_FOLDER, 'app', 'node', 'node.exe']), files.plugin.bridge ? null : show([...PLUGIN_FOLDER, 'app', 'bridge', 'convai-bridge.mjs'])].filter(Boolean);
      if (absent.length) problems.push(`The Runtime package is incomplete: ${absent[0]} was not found. Extract the whole Runtime again.`);
    }
    const scripts = files.scripts.release.version, runtime = files.plugin.release.version;
    if (scripts && runtime && scripts !== runtime) problems.push(`The Scripts package is ${scripts} but the Runtime package is ${runtime}. Install matching versions.`);
  }
  if (errors > 0) problems.push(`redscript reported ${errors} error line${errors === 1 ? '' : 's'} when it last compiled the scripts: see the redscript log in this report.`);
  // Something is missing: a Mod Organizer 2 user may only need to start this file through MO2 (a redscript error alone is not that).
  if (problems.some(line => !line.startsWith('redscript reported')) && !managers.includes('mo2')) problems.push(MO2_HINT);
  return problems;
}

// ------------------------------------------------------------------------ secrets

// Values that must be scrubbed from every line, besides the ones collectReport already reads (convai-key.txt, the Hugging Face and Kaggle
// tokens, the custom model servers' keys): every other key file of the data folder (player-convai-key.txt, player-mistral-key.txt,
// player-inworld-key.txt...), the Custom (OpenAI-compatible) provider's key (the api-key line of player-custom-endpoint.txt), the sign-in
// file's secret (or CYBERPUNK_CONVAI_AUTH_SECRET) and the key packed into the Runtime (app/defaults/service.txt). They are only returned to
// the redactor; nothing here writes, logs or prints one.
export const CUSTOM_ENDPOINT_FILE = 'player-custom-endpoint.txt';
export async function offlineSecrets({stateDirectory, project, env = {}}) {
  const found = [];
  const add = value => { if (typeof value === 'string' && value.trim().length >= 6) found.push(value.trim()); };
  // Lines such as `api-key=VALUE`, `key: VALUE` or `token = Bearer VALUE` (the custom provider's file has endpoint= and model= lines too).
  const labelled = raw => {
    for (const line of raw.split(/\r\n|\r|\n/)) {
      const value = /^\s*(?:api[-_ ]?key|apikey|key|token|secret)\s*[=:]\s*(.+?)\s*$/i.exec(line)?.[1];
      if (!value) continue;
      add(value);
      add(value.replace(/^bearer\s+/i, '').replace(/^["'`<]+|["'`>]+$/g, ''));
    }
  };
  const fromKeyText = raw => {
    const parsed = readKeyFileText(raw);
    if (parsed) add(parsed.key);
    const text = raw.trim();
    add(text);
    const value = /^[A-Za-z0-9_-]+\s*=\s*(\S+)$/.exec(text)?.[1];
    if (value) add(value);
    for (const part of text.split(/\s+/)) if (part.length >= 12) add(part);
    labelled(raw);
  };
  let names = [];
  try { names = stateDirectory ? await readdir(stateDirectory) : []; } catch {}
  for (const name of names) {
    const isKey = /-key\.txt$/i.test(name), isAuth = /^convai-auth\.json$/i.test(name), isCustom = name.toLowerCase() === CUSTOM_ENDPOINT_FILE;
    if (!isKey && !isAuth && !isCustom) continue;
    const raw = await readSmall(join(stateDirectory, name), isCustom ? 16384 : 8192);
    if (raw === null) continue;
    if (isCustom) { labelled(raw); continue; }
    if (isKey) { fromKeyText(raw); continue; }
    try {
      const walk = (value, key = '', depth = 0) => {
        if (depth > 6 || value === null) return;
        if (typeof value === 'string') { if (/secret|token|key|passw|credential/i.test(key)) add(value); return; }
        if (typeof value === 'object') for (const [name2, item] of Object.entries(value)) walk(item, name2, depth + 1);
      };
      walk(JSON.parse(raw));
    } catch { /* not JSON: nothing to scrub */ }
  }
  const packed = project ? await readSmall(join(project, 'defaults', 'service.txt'), 4096) : null;
  if (packed !== null) { const parsed = readKeyFileText(packed); if (parsed) add(parsed.key); }
  add(env?.CYBERPUNK_CONVAI_AUTH_SECRET);
  return found;
}

/** The player's Windows account names, which the redactor hides in every path: %USERNAME% and the name of the profile folder. */
export function accountNames(env = process.env) {
  const names = [env.USERNAME, typeof env.USERPROFILE === 'string' && env.USERPROFILE.trim() ? basename(env.USERPROFILE.trim().replace(/[\\/]+$/, '')) : null];
  return [...new Set(names.filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()))];
}

// --------------------------------------------------------------------------- logs

/**
 * locateLogs for every folder the tool looks in: for each log, the newest copy (else where it will appear in the first folder). Under Mod
 * Organizer 2 a log the game made new lands in Overwrite while one it rewrote stays where it was, so a copy a session without MO2 left in
 * the game folder can be stale, or the current one: the time it was written decides, and on a tie the folder the game sees first.
 */
export async function locateOfflineLogs(layout) {
  const merged = new Map();
  for (const root of layout.roots) {
    // Each folder is searched as its own game folder: under Mod Organizer 2 the game wrote the mod's log into Overwrite, not into the mod folder.
    const modRoot = join(root.path, ...MOD_FOLDER);
    for (const entry of await locateLogs({game: root.path, modRoot, runtime: join(modRoot, 'runtime'), stateDirectory: layout.stateDirectory})) {
      const time = await stat(entry.path).then(info => info.isFile() ? info.mtimeMs : -1, () => -1);
      const have = merged.get(entry.id);
      if (!have || time > have.time) merged.set(entry.id, {...entry, time});
    }
  }
  return [...merged.values()].map(({time, ...entry}) => entry);
}

// ---------------------------------------------------------------------------- run

/** --game <folder>, --out <folder>, --no-open. Anything else is ignored. */
export function parseArgs(argv = []) {
  const options = {game: undefined, out: undefined, open: true};
  // A folder typed in quotes with a trailing backslash (--game "D:\Cyberpunk 2077\" --no-open) reaches Node as one argument,
  // D:\Cyberpunk 2077" --no-open: Windows reads \" as a quote character. The value ends at that quote; the rest is read as more options.
  const items = [];
  for (const raw of argv) {
    const text = String(raw), cut = text.indexOf('"');
    if (cut < 0) items.push(text);
    else items.push(text.slice(0, cut), ...text.slice(cut + 1).split(/\s+/).filter(Boolean));
  }
  argv = items;
  for (let index = 0; index < argv.length; index++) {
    const item = String(argv[index]);
    if (item === '--game' && argv[index + 1] !== undefined) options.game = String(argv[++index]);
    else if (item.startsWith('--game=')) options.game = item.slice(7);
    else if (item === '--out' && argv[index + 1] !== undefined) options.out = String(argv[++index]);
    else if (item.startsWith('--out=')) options.out = item.slice(6);
    else if (item === '--no-open') options.open = false;
  }
  return options;
}

/** Explorer, with the new file selected. Never throws. */
export function openInExplorer(path, run = spawn) {
  try {
    const child = run('explorer.exe', ['/select,', path], {detached: true, stdio: 'ignore'});
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch { return false; }
}

// Where a report goes when its usual folder cannot be used: the temporary folder, which every player has and can write to.
export const fallbackReports = (env = process.env) => join(env.TEMP || env.TMP || os.tmpdir(), 'AiNpcCyberpunkMod-reports');

const inside = (parent, child) => { const part = relative(resolve(parent), resolve(child)); return part === '' || (!part.startsWith('..') && !isAbsolute(part)); };

/**
 * Makes the report. Options (all injectable for tests): appDirectory, argv, env, now, stdout, open(path), graphics (the cards, or a function),
 * sharedObjects (for the Mod Organizer 2 check). Resolves {ok, path, problems, layout, rows, files}; never throws.
 */
export async function runOfflineReport({appDirectory, argv = [], env = process.env, now = Date.now, stdout = process.stdout, open: openFolder = openInExplorer,
  graphics, sharedObjects} = {}) {
  const say = line => { try { stdout.write(`${line}\n`); } catch { /* no console */ } };
  const args = parseArgs(argv);
  try {
    say('Making the support report. This takes a few seconds.');
    const layout = await resolveOfflineLayout({appDirectory, game: args.game, env});
    const logs = await locateOfflineLogs(layout);
    const rows = await checkRequirements(layout, logs);
    const files = await checkModFiles(layout);
    const errors = await redscriptErrors(logs);
    const {managers} = await detectModManagers({game: layout.game, sharedObjects});
    const problems = offlineProblems({layout, rows, files, errors, managers});
    const secrets = await offlineSecrets({stateDirectory: layout.stateDirectory, project: layout.project, env});

    const release = files => ({found: files.release.found, version: files.release.version});
    const scripts = release(files.scripts), runtime = release(files.plugin);
    const extraSummary = {
      offline: {
        madeBy: 'Make support report.bat, with the game closed; no conversation service was running',
        gameFolder: {path: layout.game, found: layout.gameFound, ...(layout.gameFromIni ? {namedBy: 'ModOrganizer.ini'} : {})},
        lookedIn: {folders: layout.roots.length, first: layout.roots.slice(0, 6).map(root => root.label)},
        modManagers: managers,
        mo2: layout.mo2 ? {found: true, profile: clip(layout.mo2.profile, 60), modsSearched: layout.mo2.modCount, enabledModsOnly: layout.mo2.enabledOnly,
          overwriteFound: layout.mo2.overwrite} : {found: false},
        dataFolder: {path: layout.stateDirectory, exists: layout.stateExists},
        versionsFrom: 'the CET and RED4ext logs of the last game start, and the Mod Configuration Menu files',
      },
      requirements: rows,
      modFiles: files,
      releases: {scripts, runtime, match: scripts.version && runtime.version ? scripts.version === runtime.version : null},
    };

    let reportsDirectory = args.out ? resolve(args.out) : reportsDirectoryFor({runtime: layout.runtime, stateDirectory: layout.stateDirectory, modRoot: layout.modRoot});
    // Never create the mod's folder just to put a report in it: CET would try to load a mod folder that has no init.lua.
    const fallback = fallbackReports(env);
    if (!args.out && inside(layout.modRoot, reportsDirectory) && !await isDir(layout.runtime)) reportsDirectory = fallback;
    const build = directory => buildReport({game: layout.game, modRoot: layout.modRoot, runtime: layout.runtime, stateDirectory: layout.stateDirectory,
      project: layout.project, request: null, secrets, knownIds: [], accounts: accountNames(env), bridge: {}, now, graphics, environment: env, offline: true, logs,
      extraProblems: problems, extraSummary, reportsDirectory: directory});
    let result;
    try { result = await build(reportsDirectory); }
    catch (error) {
      if (args.out || reportsDirectory === fallback) throw error;
      result = await build(fallback);
    }
    if (!layout.gameFound) for (const line of problems) say(line);
    say(`Your support report is saved at ${result.path} - please send that file.`);
    if (args.open) openFolder(result.path);
    return {ok: true, path: result.path, problems, layout, rows, files, summary: result.summary};
  } catch (error) {
    say(`The support report could not be made: ${error?.message ?? error}`);
    return {ok: false, problems: []};
  }
}
