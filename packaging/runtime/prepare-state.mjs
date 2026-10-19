// Prepares the player's data folder for a packaged installation before the conversation
// service starts. Shipped as app/launcher/prepare-state.mjs; it imports nothing from the
// bridge so it can be tested on its own.
//
// Installed layout (game-relative):
//   red4ext/plugins/AiNpcCyberpunkMod/app/      the application (this file is in app/launcher/)
//   red4ext/plugins/AiNpcCyberpunkMod/voices/   voice reference clips (kept outside app/ on purpose)
//   bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod/runtime/  files the game's Lua reads and writes (CET keeps Lua inside its mod folder)
// and, outside the game folder (packaging/runtime/state-home.mjs):
//   %LOCALAPPDATA%/AiNpcCyberpunkMod/data/   player state (this prepares it); the game folder's data/ when there is no data home
//
// Three kinds of state file:
//   - generated: voice configurations whose paths depend on where the game is installed, and the
//     lip-sync model the bridge loads from data/lipsync-model. They are refreshed from the package on
//     every start, so a moved game folder or an update keeps working.
//   - managed: character profile mappings. They follow the package until the player edits one;
//     an edited file is never overwritten (package-defaults.json remembers what was written).
//   - player-owned: everything else (memories, sessions, settings, an own convai-key.txt). Never touched.
import {createHash} from 'node:crypto';
import {mkdir, readdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export const MANAGED_FILES = Object.freeze(['characters.json', 'multilingual-profiles.json']);
export const POCKET_CONFIG = 'pocket-voices.autobest.json';
export const OMNI_CONFIGS = Object.freeze({short: 'local-voices.autobest-short.json', long: 'local-voices.autobest-long.json'});
const RECORD = 'package-defaults.json';
// A key file is a plain api-key=... line (the player's own) or the packed form of the package's key (bridge/key-codec.mjs;
// this launcher imports nothing from the bridge, so the shape is checked here and the bridge decodes it).
const KEY_LINE = /^(?:api-key\s*=\s*\S+|convai-key-v1\s+[A-Za-z0-9_-]{24,1400})\s*$/i;

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readOptional = path => readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
const isFile = async path => { try { return (await stat(path)).isFile(); } catch { return false; } };

async function writeAtomic(path, bytes) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  try { await rename(temporary, path); } catch (error) { await rm(temporary, {force: true}); throw error; }
}

async function writeIfChanged(path, bytes) {
  const current = await readOptional(path);
  if (current && current.equals(bytes)) return false;
  await writeAtomic(path, bytes);
  return true;
}

// dataHome: the folder that holds data/ (state-home.mjs dataHomeFor), or null/undefined to keep data/ in the game's mod folder.
export function installLayout({appDirectory, gameRoot, dataHome = null}) {
  const app = resolve(appDirectory), plugin = resolve(app, '..');
  const mod = resolve(gameRoot, 'bin/x64/plugins/cyber_engine_tweaks/mods/AiNpcCyberpunkMod');
  const gameState = resolve(mod, 'data');
  return Object.freeze({
    app, plugin, gameRoot: resolve(gameRoot), mod, gameState, dataHome: dataHome ? resolve(dataHome) : null,
    state: dataHome ? resolve(dataHome, 'data') : gameState, runtime: resolve(mod, 'runtime'),
    voices: resolve(plugin, 'voices'), defaults: resolve(app, 'defaults'),
    node: resolve(app, 'node/node.exe'), python: resolve(app, 'python/python.exe'),
    assets: resolve(app, 'assets'),
    pocketSource: resolve(app, 'pocket-tts'), pocketModel: resolve(app, 'models/pocket'),
    faceModel: resolve(app, 'models/lipsync'),
    omni: resolve(app, 'omni'), omniPython: resolve(app, 'omni/python/python.exe'),
    omniModel: resolve(app, 'omni/model'), omniAdapter: resolve(app, 'omni/voicestudio/backend'),
    omniDefaults: resolve(app, 'omni/defaults'),
    // The optional Local AI packs unpack here (manifest.standard.json / manifest.lite.json, llama/, models/).
    localAi: resolve(app, 'local-ai'),
  });
}

// The Pocket configuration needs absolute paths (bridge/pocket-voice.mjs); fill them in for this install.
export function pocketConfigFor(template, layout) {
  const config = structuredClone(template);
  delete config.referenceRegistry; // development bookkeeping, not read at run time
  delete config.proposal;
  config.runtime = {
    sourceDirectory: layout.pocketSource,
    exportDirectory: layout.pocketModel,
    referenceDirectory: layout.voices,
    workDirectory: resolve(layout.state, 'pocket-voice-work'),
    pythonExecutable: layout.python,
  };
  return config;
}

export function omniConfigFor(template) {
  const config = structuredClone(template);
  delete config.proposal;
  return config;
}

async function syncManaged(layout, log) {
  const recordPath = resolve(layout.state, RECORD);
  let record = {version: 1, files: {}};
  try {
    const value = JSON.parse(await readFile(recordPath, 'utf8'));
    if (value && typeof value === 'object' && value.files && typeof value.files === 'object') record = value;
  } catch {}
  let changed = false;
  for (const name of MANAGED_FILES) {
    const desired = await readOptional(resolve(layout.defaults, name));
    if (!desired) continue;
    const target = resolve(layout.state, name), current = await readOptional(target);
    const desiredHash = sha(desired);
    if (current === null || sha(current) === record.files[name]) {
      if (current === null || !current.equals(desired)) { await writeAtomic(target, desired); log(`Installed ${name}.`); }
      if (record.files[name] !== desiredHash) { record.files[name] = desiredHash; changed = true; }
    } else if (sha(current) !== desiredHash) {
      log(`Kept the edited ${name}; the packaged version was not applied.`);
    }
  }
  if (changed) await writeAtomic(recordPath, Buffer.from(JSON.stringify(record, null, 2) + '\n'));
}

// The OmniVoice list `name` to run on. The Runtime's own copy (app/defaults/, beside the Pocket list) comes first: it is released together with this
// code and names every voice the Runtime has clips for, even when the OmniVoice pack the player installed is older than the Runtime. The
// pack's copy (app/omni/defaults/) is the fallback, for a Runtime that ships none. They are different paths on purpose: a pack zip that a
// new version reuses unchanged must never share a path with the Runtime and carry other bytes, because Windows would offer to replace the
// newer file with the older one (docs/PACKAGING.md, "Packs reused unchanged").
// Nothing deletes an old version's files, so the Runtime's folder can hold a list an EARLIER Runtime left there. A list that names another
// OmniVoice model revision than the installed pack's model (omni-pack.json "model": "<repository>@<revision>") is passed over for one that
// names it, since the voice worker refuses a list for another model; a list that cannot be read as JSON is passed over too.
export async function readOmniTemplate(layout, name) {
  const revision = await omniPackRevision(layout);
  let fallback = null;
  for (const folder of [layout.defaults, layout.omniDefaults]) {
    const found = await readOptional(resolve(folder, name));
    if (!found) continue;
    let template;
    try { template = JSON.parse(found.toString('utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    if (!template || typeof template !== 'object') continue;
    if (!revision || template.revision === revision) return template;
    fallback ??= template;
  }
  if (fallback) return fallback;
  throw Object.assign(Error(`The OmniVoice list ${name} is in neither ${layout.defaults} nor ${layout.omniDefaults} (or cannot be read).`), {code: 'ENOENT'});
}

// The OmniVoice model revision the installed pack carries, or null when its omni-pack.json does not say.
export async function omniPackRevision(layout) {
  try {
    const model = JSON.parse((await readFile(resolve(layout.omni, 'omni-pack.json'), 'utf8')).replace(/^\uFEFF/, ''))?.model;
    return (typeof model === 'string' && /@([0-9a-f]{7,64})$/i.exec(model)?.[1]) || null;
  } catch { return null; }
}

export async function omniPackInstalled(layout) {
  return (await isFile(layout.omniPython)) && (await isFile(resolve(layout.omni, 'omni-pack.json')));
}

// Chooses the Convai credential: the player's own data/convai-key.txt when it is valid, otherwise
// the one the package provides, otherwise the (missing) player path so the service reports setup.
export async function chooseKeyFile(layout) {
  const own = resolve(layout.state, 'convai-key.txt');
  for (const path of [own, resolve(layout.defaults, 'service.txt')]) {
    try {
      const info = await stat(path);
      if (info.isFile() && info.size <= 4096 && KEY_LINE.test((await readFile(path, 'utf8')).trim())) return path;
    } catch {}
  }
  return own;
}

export async function prepareState(layout, {log = () => {}} = {}) {
  await mkdir(layout.state, {recursive: true});
  await mkdir(layout.runtime, {recursive: true});
  for (const name of ['pocket-voice-work', 'voice-studio-data']) await mkdir(resolve(layout.state, name), {recursive: true});
  await syncManaged(layout, log);
  // The bridge loads the lip-sync model from <data>/lipsync-model (bridge/convai-bridge.mjs).
  const faceTarget = resolve(layout.state, 'lipsync-model');
  await mkdir(faceTarget, {recursive: true});
  for (const name of (await readdir(layout.faceModel).catch(() => [])).sort()) {
    if (await writeIfChanged(resolve(faceTarget, name), await readFile(resolve(layout.faceModel, name)))) log(`Installed lipsync-model/${name}.`);
  }

  const pocket = JSON.parse(await readFile(resolve(layout.defaults, POCKET_CONFIG), 'utf8'));
  await writeIfChanged(resolve(layout.state, POCKET_CONFIG),
    Buffer.from(JSON.stringify(pocketConfigFor(pocket, layout), null, 2) + '\n'));
  const omni = await omniPackInstalled(layout);
  if (omni) {
    for (const name of Object.values(OMNI_CONFIGS)) {
      const template = await readOmniTemplate(layout, name);
      await writeIfChanged(resolve(layout.state, name), Buffer.from(JSON.stringify(omniConfigFor(template), null, 2) + '\n'));
    }
  }
  await writeIfChanged(resolve(layout.state, 'voice-configs.json'), Buffer.from(JSON.stringify({version: 1,
    pocket: POCKET_CONFIG, omni: {...OMNI_CONFIGS}}, null, 2) + '\n'));
  return {omni, keyFile: await chooseKeyFile(layout)};
}

// Environment for the supervisor and, through it, the bridge and its workers. Every
// executable and asset path is explicit; nothing is looked up on PATH. The one exception is the hidden browser: the mod does not
// ship one, so the bridge uses the system's Edge, else Chrome (bridge/system-browser.mjs). A developer's CYBERPUNK_CONVAI_BROWSER
// passes through unchanged and names the executable instead.
export function serviceEnvironment(layout, {omni, keyFile}, source = process.env) {
  const env = {...source};
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONUSERBASE',
    'CYBERPUNK_CONVAI_PYTHON', 'CYBERPUNK_CONVAI_OMNI_MODEL', 'CYBERPUNK_CONVAI_OMNI_ADAPTER',
    'CYBERPUNK_CONVAI_OMNI_REFERENCES', 'CYBERPUNK_CONVAI_OMNI_CACHE', 'CYBERPUNK_CONVAI_RHUBARB',
    'CYBERPUNK_CONVAI_LIPSYNC_WORK', 'CYBERPUNK_CONVAI_DAILY_LIMIT', 'CYBERPUNK_CONVAI_GAME_STATE',
    // A developer's Local AI folder or model files must not leak into a player's service (docs/LOCAL_AI.md).
    'CYBERPUNK_CONVAI_LOCAL_AI_DEV', 'CYBERPUNK_CONVAI_LOCAL_SERVER', 'CYBERPUNK_CONVAI_LOCAL_MODEL',
    'CYBERPUNK_CONVAI_LOCAL_LITE_MODEL', 'CYBERPUNK_CONVAI_LOCAL_EMBED_MODEL']) delete env[name];
  Object.assign(env, {
    PYTHONNOUSERSITE: '1',
    CYBERPUNK_CONVAI_GAME: layout.gameRoot,
    CYBERPUNK_CONVAI_STATE: layout.state,
    CYBERPUNK_CONVAI_KEY_FILE: keyFile,
    CYBERPUNK_CONVAI_CLIENT_ASSETS: layout.assets,
    CYBERPUNK_CONVAI_LOCAL_AI: layout.localAi,
    // The folder 'runtime/voice-references/' maps to. Besides OmniVoice, the Mistral cloud voice (Voxtral) reads its reference clips
    // and its pre-built prepared/ clips from here, so it is set with or without the OmniVoice pack.
    CYBERPUNK_CONVAI_OMNI_REFERENCES: layout.voices,
  });
  // The folder of the copies of the player's state files in runtime/ (bridge/game-state.mjs, docs/PACKAGING.md "Mod Organizer 2"): the bridge keeps
  // them current. Only with a data home outside the game folder, where Mod Organizer 2 cannot lose them; a copy inside the game folder is no safer.
  if (layout.dataHome) env.CYBERPUNK_CONVAI_GAME_STATE = resolve(layout.state, 'game-state');
  if (omni) Object.assign(env, {
    CYBERPUNK_CONVAI_PYTHON: layout.omniPython,
    CYBERPUNK_CONVAI_OMNI_MODEL: layout.omniModel,
    CYBERPUNK_CONVAI_OMNI_ADAPTER: layout.omniAdapter,
    CYBERPUNK_CONVAI_OMNI_CACHE: resolve(layout.state, 'voice-studio-data'),
  });
  return env;
}
