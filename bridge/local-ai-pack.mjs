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
// Developer layout (a folder shaped like E:\CyberpunkConvai-offload\work\local-llm\), used when the real pack has no
// manifest: llama-vulkan/llama-server.exe and the single .gguf in dl-gemma4-e4b/, else dl-qwen35-4b/ (standard), dl-qwen35-2b/ (lite) and
// dl-granite-emb/ (embed). Each file can be overridden by an environment variable.
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {basename, isAbsolute, resolve} from 'node:path';

const fileExists = path => { try { return statSync(path).isFile(); } catch { return false; } };
const readUtf8 = path => readFileSync(path, 'utf8');
const listNames = path => { try { return readdirSync(path); } catch { return []; } };

export const LOCAL_AI_EMBED_DIMENSION = 384;
export const LOCAL_AI_ENV = Object.freeze({
  root: 'CYBERPUNK_CONVAI_LOCAL_AI', dev: 'CYBERPUNK_CONVAI_LOCAL_AI_DEV', server: 'CYBERPUNK_CONVAI_LOCAL_SERVER',
  standard: 'CYBERPUNK_CONVAI_LOCAL_MODEL', lite: 'CYBERPUNK_CONVAI_LOCAL_LITE_MODEL', embed: 'CYBERPUNK_CONVAI_LOCAL_EMBED_MODEL',
});

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
// installed = server present and at least one chat tier present. Without the embedding model, memory falls back
// (missing lists 'embed' but installed stays true). `list` reads a folder (dev layout only).
export function detectLocalAiPack({project, environment = process.env, exists = fileExists, readText = readUtf8, list = listNames} = {}) {
  const primary = environment[LOCAL_AI_ENV.root] ? resolve(environment[LOCAL_AI_ENV.root]) : resolve(project ?? '.', 'local-ai');
  const manifestPaths = ['manifest.json', 'manifest.standard.json', 'manifest.lite.json'].map(name => resolve(primary, name)).filter(path => exists(path));
  let layout = null;
  if (manifestPaths.length) layout = mergeLayouts(primary, manifestPaths.map(path => realLayout(primary, path, readText)));
  else {
    const overridden = [LOCAL_AI_ENV.server, LOCAL_AI_ENV.standard, LOCAL_AI_ENV.lite, LOCAL_AI_ENV.embed].some(name => environment[name]);
    const devRoot = environment[LOCAL_AI_ENV.dev] ? resolve(environment[LOCAL_AI_ENV.dev]) : null;
    if (devRoot || overridden) layout = devLayout(devRoot, environment, exists, list);
  }
  if (!layout) layout = {root: primary, server: null, standard: null, lite: null, embed: null, dev: false};
  const server = layout.server && exists(layout.server) ? layout.server : null;
  const present = tier => (tier && exists(tier.file) ? {file: tier.file, name: tier.name} : null);
  const standard = present(layout.standard);
  const lite = present(layout.lite);
  const embed = layout.embed && exists(layout.embed.file) ? {file: layout.embed.file, dim: layout.embed.dim, id: layout.embed.id} : null;
  const missing = [];
  if (!server) missing.push('server');
  if (!standard && !lite) missing.push('model');
  if (!embed) missing.push('embed');
  return {installed: Boolean(server && (standard || lite)), missing, root: layout.root, server, tiers: {standard, lite}, embed, dev: layout.dev};
}

function mergeLayouts(root, layouts) {
  const first = key => layouts.map(layout => layout[key]).find(Boolean) ?? null;
  return {root, dev: false, server: first('server'), standard: first('standard'), lite: first('lite'), embed: first('embed')};
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
  return {root, dev: false, server: packPath(root, manifest.server), standard: tier(manifest.standard), lite: tier(manifest.lite),
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
  const liteFile = pick(LOCAL_AI_ENV.lite, single('dl-qwen35-2b'));
  const embedFile = pick(LOCAL_AI_ENV.embed, single('dl-granite-emb'));
  return {root: devRoot ?? (server ? resolve(server, '..') : resolve('.')), dev: true, server,
    standard: standardFile ? {file: standardFile, name: modelName(standardFile)} : null,
    lite: liteFile ? {file: liteFile, name: modelName(liteFile)} : null,
    embed: embedFile ? {file: embedFile, dim: LOCAL_AI_EMBED_DIMENSION, id: modelId(embedFile)} : null};
}

export const LOCAL_AI_PACK_MISSING_MESSAGE = 'Requires the optional Local AI pack';
