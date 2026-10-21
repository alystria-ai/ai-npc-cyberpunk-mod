// Is the optional Local AI pack installed?
//
// The fully local conversation option (docs/LOCAL_OPTION_DESIGN.md) needs a llama.cpp `llama-server` build, one or two
// chat model files (standard and lite tiers) and, optionally, an embedding model for memory search. This only looks at
// the files (stat and one small JSON read); it never spawns anything and never copies a model.
//
// Real pack: <root>/manifest.json, or one fragment per downloadable pack, manifest.standard.json and manifest.lite.json
// (the two optional packs, "Local AI standard" and "Local AI lite", unpack into the same folder; each ships the server and the
// embedding model, so the second only overwrites identical files). Fragments are merged: the first file that names a piece wins.
//   {version: 1, server: 'llama/llama-server.exe',
//    standard: {file: 'models/x.gguf', name: 'Qwen3.5-4B'}, lite: {file, name},
//    embed: {file: 'models/e.gguf', dim: 384, id: 'granite-embedding-107m-multilingual-q8_0'}}
//   Paths are relative to the root; absolute paths and `..` are rejected. Another model is only another manifest.
//
// The optional Mature packs (bridge/mature-pack.mjs) carry the same server and embedding files, so each works alone. Their markers
// (manifest.mature-lite.json, manifest.mature-standard.json) may also name `server` and `embed` (same shape as above); this module reads
// only those two fields from them, never their model entries (a Mature `lite` is not the Local AI lite model), and only when no Local AI
// manifest names the piece. A marker without `server` (an older Mature pack) adds nothing, so an older Mature pack beside a Local AI
// pack behaves as before. A Mature-only install counts as installed when a marker names a server and its model file is on disk
// (`tiers` stays empty); that model is then the only one, and the model choice (bridge/local-model-choice.mjs) lets it run
// only while Mature content is on.
//
// Under Mod Organizer 2 (docs/PACKAGING.md, "Mod Organizer 2: packs as separate mods") each pack is usually its own MO2 mod and USVFS merges
// them into one virtual local-ai folder. The service then hands this module that VIRTUAL folder (CYBERPUNK_CONVAI_LOCAL_AI), so every marker
// and manifest is found whichever mod holds it, and each file a manifest names is mapped on its own to the place it really is (`realPath`,
// only when CYBERPUNK_CONVAI_USVFS=1: realpathSync.native of the opened file), because llama-server reads real files. A server folder is
// taken whole from one real place: the exe and the DLLs it loads must be neighbours there (chooseServer). Outside usvfs nothing is mapped.
//
// The engine (llama-server, its DLLs and llama-fit-params) ships in the Runtime, in app/llama-cpp/ (docs/LOCAL_AI.md, "The engine is in the Runtime"), so an engine
// fix reaches players through the Runtime update zip. It is looked for first: when it is complete (the server and the libraries it loads, ENGINE_FILES) every pack
// uses it, whatever `server` its manifest names. A pack that ships its own copy (llama/ inside the pack, every pack up to 0.2.7) is the fall-back: an older Runtime
// has no app/llama-cpp, and a Runtime whose engine lost a file (an antivirus tool quarantined a DLL) runs the pack's. A pack without a `server` entry (later packs carry
// models only) needs the Runtime's engine. Without any pack the engine is simply there and nothing is installed: an own-server player needs no engine and is told nothing.
// The folder is next to the bridge (<project>/llama-cpp), or CYBERPUNK_CONVAI_LOCAL_ENGINE (the service sets it). The developer layout below never looks for it.
//
// Developer layout (a folder shaped like E:\CyberpunkConvai-offload\work\local-llm\), used when the real pack has no
// manifest: llama-vulkan/llama-server.exe and the single .gguf in dl-gemma4-e4b/, else dl-qwen35-4b/ (standard), dl-bonsai2-4b/ (lite; the earlier lite model's dl-qwen35-2b/ is still read) and
// dl-granite-emb/ (embed). Each file can be overridden by an environment variable.
import {readFileSync, readdirSync, realpathSync, statSync} from 'node:fs';
import {basename, dirname, isAbsolute, relative, resolve} from 'node:path';

const fileExists = path => { try { return statSync(path).isFile(); } catch { return false; } };
// A leading byte-order mark (Notepad and PowerShell can write one) is not part of the JSON.
const readUtf8 = path => readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
const listNames = path => { try { return readdirSync(path); } catch { return []; } };

export const LOCAL_AI_EMBED_DIMENSION = 384;
/** The markers of the Mature packs (the same names as bridge/mature-pack.mjs, which a test keeps equal): read here only for `server` and `embed`. */
export const MATURE_ENGINE_MARKERS = Object.freeze(['manifest.mature-lite.json', 'manifest.mature-standard.json', 'manifest.mature.json']);
/** Set (to '1') in every process the service starts when it runs inside Mod Organizer 2's virtual file system (usvfs-compat.mjs in the packaging folder's runtime scripts). */
export const USVFS_FLAG = 'CYBERPUNK_CONVAI_USVFS';
const same = (a, b) => resolve(String(a)).toLowerCase() === resolve(String(b)).toLowerCase();
/**
 * Where a file really is: the identity outside usvfs (a physical install maps nothing), and inside it realpathSync.native, which asks the
 * opened file for its real path (USVFS answers with the file of the mod that wins for that file). A path that cannot be mapped stays as it is.
 */
export function realPathFor(environment = process.env) {
  if (environment?.[USVFS_FLAG] !== '1') return path => path;
  return path => { try { return realpathSync.native(path); } catch { return path; } };
}
/** A short, path-free name for where a pack file really is, for the support report: the MO2 mod folder's name, 'elsewhere', or null when it is where it was looked for. */
export function placeLabel(real, virtual) {
  if (!real || !virtual || same(real, virtual)) return null;
  const mod = /[\\/]mods[\\/]([^\\/]+)[\\/]/i.exec(String(real));
  return mod ? mod[1].slice(0, 60) : 'elsewhere';
}

export const LOCAL_AI_ENV = Object.freeze({
  root: 'CYBERPUNK_CONVAI_LOCAL_AI', dev: 'CYBERPUNK_CONVAI_LOCAL_AI_DEV', server: 'CYBERPUNK_CONVAI_LOCAL_SERVER', engine: 'CYBERPUNK_CONVAI_LOCAL_ENGINE',
  standard: 'CYBERPUNK_CONVAI_LOCAL_MODEL', lite: 'CYBERPUNK_CONVAI_LOCAL_LITE_MODEL', embed: 'CYBERPUNK_CONVAI_LOCAL_EMBED_MODEL',
});

/** The folder of the Runtime's engine under the app folder, and the files that must all be there for it to count (the `require` list of packaging/release.config.json, which a test keeps equal). */
export const RUNTIME_ENGINE_FOLDER = 'llama-cpp';
export const ENGINE_FILES = Object.freeze(['llama-server.exe', 'llama-server-impl.dll', 'llama.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-vulkan.dll', 'ggml-cpu-x64.dll']);

/** Where the Runtime's engine folder is, or null when neither CYBERPUNK_CONVAI_LOCAL_ENGINE nor a project folder says. */
export function runtimeEngineFolder({project, environment = process.env} = {}) {
  const named = environment?.[LOCAL_AI_ENV.engine];
  if (typeof named === 'string' && named.trim()) return resolve(named);
  return project ? resolve(project, RUNTIME_ENGINE_FOLDER) : null;
}

/**
 * The Runtime's engine: null when its server is not there (an older Runtime, a developer's checkout), else {server, folder, missing}: the real path of the server,
 * its folder and the names from ENGINE_FILES that are not beside it (empty when it is whole). It is one folder of one mod, so under Mod Organizer 2 its DLLs are always neighbours.
 */
export function findRuntimeEngine({project, environment = process.env, exists = fileExists, realPath = realPathFor(environment)} = {}) {
  const folder = runtimeEngineFolder({project, environment});
  if (!folder) return null;
  const server = realPath(resolve(folder, ENGINE_FILES[0]));
  if (!exists(server)) return null;
  const beside = dirname(server);
  return {server, folder: beside, missing: ENGINE_FILES.filter(name => !exists(resolve(beside, name)))};
}

// A manifest path must stay inside the pack: relative, no drive, no `..` segment.
function packPath(root, value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (isAbsolute(value) || /^[a-z]:|^[\\/]/i.test(value)) return null;
  if (value.split(/[\\/]+/).includes('..')) return null;
  return resolve(root, value);
}

const modelName = file => basename(file).replace(/\.gguf$/i, '');
const modelId = file => modelName(file).toLowerCase();

// Returns {installed, missing: ['server'|'model'|'embed'], root, server, tiers: {standard, lite}, embed, dev}.
// `server`, each tier and `embed` are null when their file is absent or not allowed; otherwise absolute paths.
// installed = server present and at least one chat tier present, or (a Mature pack alone) a Mature marker that names the server
// with its model file present (`tiers` stays empty then; the Mature models themselves are listed by bridge/mature-pack.mjs). Without the embedding model, memory falls back
// (missing lists 'embed' but installed stays true). `list` reads a folder (dev layout only).
export function detectLocalAiPack({project, environment = process.env, exists = fileExists, readText = readUtf8, list = listNames, realPath = realPathFor(environment)} = {}) {
  const primary = environment[LOCAL_AI_ENV.root] ? resolve(environment[LOCAL_AI_ENV.root]) : resolve(project ?? '.', 'local-ai');
  const manifestPaths = ['manifest.json', 'manifest.standard.json', 'manifest.lite.json'].map(name => resolve(primary, name)).filter(path => exists(path));
  let layout = null;
  const runtimeEngine = findRuntimeEngine({project, environment, exists, realPath});
  const useRuntime = Boolean(runtimeEngine) && runtimeEngine.missing.length === 0;
  const matureLayouts = MATURE_ENGINE_MARKERS.map(name => resolve(primary, name)).filter(path => exists(path)).map(path => matureLayout(primary, path, readText, exists, realPath, useRuntime)).filter(Boolean);
  if (manifestPaths.length || matureLayouts.length) {
    layout = mergeLayouts(primary, [...manifestPaths.map(path => realLayout(primary, path, readText)), ...matureLayouts]);
  } else {
    const overridden = [LOCAL_AI_ENV.server, LOCAL_AI_ENV.standard, LOCAL_AI_ENV.lite, LOCAL_AI_ENV.embed].some(name => environment[name]);
    const devRoot = environment[LOCAL_AI_ENV.dev] ? resolve(environment[LOCAL_AI_ENV.dev]) : null;
    if (devRoot || overridden) layout = devLayout(devRoot, environment, exists, list);
  }
  if (!layout) layout = {root: primary, server: null, standard: null, lite: null, embed: null, dev: false};
  // Each file a manifest names is looked at where it really is (the identity outside usvfs); the manifests themselves were read at their virtual place.
  const places = {};
  const place = (piece, file) => { const real = realPath(file); if (!same(real, file)) places[piece] = {virtual: file, real}; return real; };
  // The Runtime's engine first (never for a developer's folder, which brings its own); else the server the pack names, taken whole from one real folder.
  const runtimeFirst = useRuntime && !layout.dev;
  const picked = runtimeFirst ? {file: runtimeEngine.server, mapped: false} : layout.server ? chooseServer(layout, {realPath, exists, list}) : null;
  if (picked?.mapped) places.server = {virtual: layout.server, real: picked.file, complete: picked.complete, missing: picked.missing};
  const server = picked ? picked.file : null;
  const matureEngine = Boolean(server) && layout.matureModel === true;
  const present = (piece, tier) => { const file = tier && place(piece, tier.file); return file && exists(file) ? {file, name: tier.name} : null; };
  const standard = present('standard', layout.standard);
  const lite = present('lite', layout.lite);
  const embedFile = layout.embed && place('embed', layout.embed.file);
  const embed = embedFile && exists(embedFile) ? {file: embedFile, dim: layout.embed.dim, id: layout.embed.id} : null;
  const missing = [];
  if (!server) missing.push('server');
  if (!standard && !lite && !matureEngine) missing.push('model');
  if (!embed) missing.push('embed');
  // Where the server came from, only when the Runtime has an engine folder (a pack-only install carries no extra field).
  const engine = runtimeEngine ? {source: runtimeFirst ? 'runtime' : (server ? 'pack' : null), ...(runtimeEngine.missing.length ? {runtimeMissing: runtimeEngine.missing.slice(0, 12)} : {})} : null;
  return {installed: Boolean(server && (standard || lite || matureEngine)), missing, root: layout.root, server, tiers: {standard, lite}, embed, dev: layout.dev,
    ...(engine ? {engine} : {}), ...(Object.keys(places).length ? {places} : {})};
}

// The server exe and the DLLs it loads must be neighbours in ONE real folder (Windows looks beside the real exe). Under usvfs each file of a
// merged llama/ folder maps by itself, so with two packs that both ship llama/ the exe could come from one mod and a DLL from the other. The
// candidates are the winning exe and, for every marker that names a server, that marker's own mod folder (the marker file is unique to its pack,
// so it maps to its pack's mod); the one with the most of the DLLs listed in the merged folder wins, the first (highest priority) on a tie.
// Returns null (no server file), {file, mapped: false} (nothing was mapped: a physical install or one real folder), or {file, mapped: true,
// complete, missing: [dll names left out]}.
function chooseServer(layout, {realPath, exists, list}) {
  const winner = realPath(layout.server);
  if (same(winner, layout.server)) return exists(layout.server) ? {file: layout.server, mapped: false} : null;
  const required = list(dirname(layout.server)).filter(name => /\.dll$/i.test(name));
  const candidates = [];
  const add = file => { if (file && !candidates.some(known => same(known, file)) && exists(file)) candidates.push(file); };
  add(winner);
  for (const {server, marker} of layout.servers ?? []) {
    add(realPath(server));
    add(resolve(dirname(realPath(marker)), relative(layout.root, server)));
  }
  let best = null;
  for (const file of candidates) {
    const have = new Set(list(dirname(file)).map(name => name.toLowerCase()));
    const missing = required.filter(name => !have.has(name.toLowerCase()));
    if (!best || missing.length < best.missing.length) best = {file, mapped: true, complete: missing.length === 0, missing};
    if (!missing.length) break;
  }
  return best;
}

function mergeLayouts(root, layouts) {
  const first = key => layouts.map(layout => layout[key]).find(Boolean) ?? null;
  return {root, dev: false, server: first('server'), standard: first('standard'), lite: first('lite'), embed: first('embed'),
    matureModel: layouts.some(layout => layout.matureModel === true),
    servers: layouts.filter(layout => layout.server && layout.marker).map(layout => ({server: layout.server, marker: layout.marker}))};
}

// A Mature marker's contribution: its `server` and `embed` only, and whether one of its model files is on disk. Null for a marker that is
// unreadable, not ours, or names no server while the Runtime has no engine (an older Mature pack: it adds nothing here).
function matureLayout(root, markerPath, readText, exists, realPath, runtimeEngine = false) {
  let marker;
  try { marker = JSON.parse(readText(markerPath)); } catch { return null; }
  if (!marker || typeof marker !== 'object' || marker.version !== 1 || marker.pack !== 'mature') return null;
  // A marker without a server (a pack that carries models only, or an older Mature pack) counts when the Runtime has the engine.
  const server = packPath(root, marker.server);
  if (!server && !runtimeEngine) return null;
  const matureModel = ['lite', 'good'].some(tier => { const file = packPath(root, marker[tier]?.file); return Boolean(file) && exists(realPath(file)); });
  return {...realLayout(root, markerPath, readText), standard: null, lite: null, server, matureModel};
}

function realLayout(root, manifestPath, readText) {
  const empty = {root, server: null, standard: null, lite: null, embed: null, dev: false};
  let manifest;
  try { manifest = JSON.parse(readText(manifestPath)); } catch { return empty; }
  if (!manifest || typeof manifest !== 'object' || manifest.version !== 1) return empty;
  const tier = entry => {
    const file = packPath(root, entry?.file);
    return file ? {file, name: typeof entry.name === 'string' && entry.name ? entry.name : modelName(file)} : null;
  };
  const embedFile = packPath(root, manifest.embed?.file);
  const dim = Number(manifest.embed?.dim);
  return {root, dev: false, marker: manifestPath, server: packPath(root, manifest.server), standard: tier(manifest.standard), lite: tier(manifest.lite),
    embed: embedFile ? {file: embedFile, dim: Number.isInteger(dim) && dim > 0 ? dim : LOCAL_AI_EMBED_DIMENSION,
      id: typeof manifest.embed.id === 'string' && manifest.embed.id ? manifest.embed.id : modelId(embedFile)} : null};
}

function devLayout(devRoot, environment, exists, list) {
  const single = folder => {
    if (!devRoot) return null;
    const directory = resolve(devRoot, folder);
    const names = list(directory).filter(name => /\.gguf$/i.test(name) && !/mmproj/i.test(name)).sort();
    return names.length ? resolve(directory, names[0]) : null;
  };
  const pick = (variable, fallback) => (environment[variable] ? resolve(environment[variable]) : fallback);
  const server = pick(LOCAL_AI_ENV.server, devRoot ? resolve(devRoot, 'llama-vulkan/llama-server.exe') : null);
  const standardFile = pick(LOCAL_AI_ENV.standard, single('dl-gemma4-e4b') ?? single('dl-qwen35-4b'));
  const liteFile = pick(LOCAL_AI_ENV.lite, single('dl-bonsai2-4b') ?? single('dl-qwen35-2b'));
  const embedFile = pick(LOCAL_AI_ENV.embed, single('dl-granite-emb'));
  return {root: devRoot ?? (server ? resolve(server, '..') : resolve('.')), dev: true, server,
    standard: standardFile ? {file: standardFile, name: modelName(standardFile)} : null,
    lite: liteFile ? {file: liteFile, name: modelName(liteFile)} : null,
    embed: embedFile ? {file: embedFile, dim: LOCAL_AI_EMBED_DIMENSION, id: modelId(embedFile)} : null};
}

export const LOCAL_AI_PACK_MISSING_MESSAGE = 'Requires the optional Local AI pack';

const sizeMiBOf = path => { try { return Math.round(statSync(path).size / 1048576); } catch { return null; } };
const MARKER_NAMES = Object.freeze(['manifest.json', 'manifest.standard.json', 'manifest.lite.json', ...MATURE_ENGINE_MARKERS]);

/**
 * What the Local AI folder holds, for the model list's notes and the support report: every marker (manifest.*.json) with the model files it names and
 * whether each one is there, and the .gguf files of models/ with their sizes and whether a marker names them. A marker whose model file is absent is an
 * install that did not finish (a zip not fully extracted, a file moved elsewhere): the model it stands for is missing from the list, and with only Mature
 * models left and Mature content off nothing starts. Names and sizes only, never the contents of a file. Never throws; bounded (12 markers, 24 files).
 * Returns {markers: [{name, mature, declares: [{tier, name, file, present, sizeMiB}]}], files: [{file, sizeMiB, named}]}. Under Mod Organizer 2 (a file
 * that really is somewhere else than the folder it was looked for in) every marker, model, models/ file and the server and embedding model also say
 * `foundIn` (the MO2 mod folder's name, else 'elsewhere'), and `engine` lists the server (with whether its DLLs sit beside it) and the embedding model;
 * a physical install carries none of these fields.
 */
export function describePackFiles({project, environment = process.env, exists = fileExists, readText = readUtf8, list = listNames, sizeOf = sizeMiBOf,
  realPath = realPathFor(environment)} = {}) {
  const root = environment[LOCAL_AI_ENV.root] ? resolve(environment[LOCAL_AI_ENV.root]) : resolve(project ?? '.', 'local-ai');
  const markers = [], named = new Set();
  for (const name of MARKER_NAMES) {
    if (markers.length >= 12) break;
    const path = resolve(root, name);
    let marker;
    try { if (!exists(path)) continue; marker = JSON.parse(readText(path)); } catch { continue; }
    if (!marker || typeof marker !== 'object' || marker.version !== 1) continue;
    const declares = [];
    for (const tier of ['standard', 'lite', 'good']) {
      const entry = marker[tier], virtual = packPath(root, entry?.file);
      if (!virtual) continue;
      const file = realPath(virtual), present = exists(file), foundIn = present ? placeLabel(file, virtual) : null;
      named.add(basename(file).toLowerCase());
      declares.push({tier, name: typeof entry.name === 'string' && entry.name ? entry.name.slice(0, 80) : modelName(file), file: String(entry.file).slice(0, 120), present, sizeMiB: present ? sizeOf(file) : null,
        ...(foundIn ? {foundIn} : {})});
    }
    const embed = packPath(root, marker.embed?.file);
    if (embed) named.add(basename(embed).toLowerCase());
    const markerIn = placeLabel(realPath(path), path);
    markers.push({name, mature: marker.pack === 'mature', declares, ...(markerIn ? {foundIn: markerIn} : {})});
  }
  const files = list(resolve(root, 'models')).filter(name => /\.gguf$/i.test(name)).sort().slice(0, 24)
    .map(file => {
      const virtual = resolve(root, 'models', file), real = realPath(virtual), foundIn = placeLabel(real, virtual);
      return {file, sizeMiB: sizeOf(real), named: named.has(file.toLowerCase()), ...(foundIn ? {foundIn} : {})};
    });
  const engine = [];
  try {
    const {places = {}, engine: where} = detectLocalAiPack({project, environment, exists, readText, list, realPath});
    if (where) engine.push({piece: 'server', source: where.source, ...(where.runtimeMissing ? {runtimeMissing: where.runtimeMissing} : {})});
    if (places.server) engine.push({piece: 'server', foundIn: placeLabel(places.server.real, places.server.virtual), dllsBeside: places.server.complete, dllsMissing: places.server.missing.slice(0, 12)});
    if (places.embed) engine.push({piece: 'embed', foundIn: placeLabel(places.embed.real, places.embed.virtual)});
  } catch { /* the engine rows are extra */ }
  return {markers, files, ...(engine.length ? {engine} : {})};
}

/**
 * Where each pack file really is, as log lines for the service log (full paths: the log is the player's own and the support report cuts them). Only
 * files that are somewhere else than the folder they were looked for in get a line with a path, so a complete physical install returns []. Under Mod Organizer 2
 * this is what a report needs to show a pack that is split over several mods: one line per marker, per model file, the server (with its DLLs beside it
 * or the names that are not) and the embedding model. Never throws.
 */
export function packPlaceLines({project, environment = process.env, exists = fileExists, readText = readUtf8, list = listNames, realPath = realPathFor(environment)} = {}) {
  const lines = [];
  try {
    const root = environment[LOCAL_AI_ENV.root] ? resolve(environment[LOCAL_AI_ENV.root]) : resolve(project ?? '.', 'local-ai');
    const line = (what, virtual) => {
      const real = realPath(virtual);
      if (!same(real, virtual)) lines.push(`${what}: ${exists(real) ? real : `not found (looked for ${real})`}`);
      else if (!exists(real)) lines.push(`${what}: not found`);
    };
    for (const name of MARKER_NAMES) {
      const path = resolve(root, name);
      let marker;
      try { if (!exists(path)) continue; marker = JSON.parse(readText(path)); } catch { continue; }
      if (!marker || typeof marker !== 'object' || marker.version !== 1) continue;
      line(`marker ${name}`, path);
      for (const tier of ['standard', 'lite', 'good']) {
        const file = packPath(root, marker[tier]?.file);
        if (file) line(`  ${tier} model ${basename(file)}`, file);
      }
    }
    const {places = {}, engine, server} = detectLocalAiPack({project, environment, exists, readText, list, realPath});
    if (engine?.source === 'runtime') lines.push(`server ${basename(server)}: the Runtime's engine, ${server}`);
    else if (engine?.runtimeMissing) lines.push(`the Runtime's engine is incomplete (missing: ${engine.runtimeMissing.join(', ')}); ${server ? "the pack's server is used" : 'no server to use'}`);
    if (places.server) {
      lines.push(`server ${basename(places.server.virtual)}: ${places.server.real}; its DLLs are ${places.server.complete ? 'all beside it'
        : `NOT all beside it (missing: ${places.server.missing.slice(0, 12).join(', ')})`}`);
    }
    if (places.embed) lines.push(`embedding model ${basename(places.embed.virtual)}: ${places.embed.real}`);
  } catch { /* a log aid only */ }
  return lines;
}

/** The models a marker names whose file is not there, as the notes of the model list ({name, reason: 'missing'}, the reason code of a model that cannot be used). */
export function packFileProblems(description) {
  const seen = new Set(), problems = [];
  for (const marker of Array.isArray(description?.markers) ? description.markers : []) {
    for (const item of marker.declares ?? []) {
      if (item.present !== false || seen.has(item.name)) continue;
      seen.add(item.name);
      problems.push({name: item.name, reason: 'missing'});
    }
  }
  return problems.slice(0, 8);
}

