// Is an optional Mature pack installed?
//
// The Mature packs are separate, optional downloads (Hugging Face, packaging/MATURE_PACK_README.md) that hold the uncensored model files:
// "Mature lite" (one model) and "Mature standard" (one model). Each works alone (it includes the llama-server build and the embedding model) and each is a single zip. They do NOT gate the "Mature content"
// setting (bridge/mature-content.mjs), which is part of the main mod and works with any model. A marker tells the setting's help text whether
// an uncensored model is installed, and lists the models for the Local AI model choice (bridge/local-model-choice.mjs: they appear in the
// Local AI model row, and Auto prefers one when Mature content is on). Each pack carries its own marker, so either alone is detected and the
// two never overwrite each other. The markers sit in the Local AI folder beside the manifest fragments of the two Local AI packs
// (manifest.standard.json, manifest.lite.json; bridge/local-ai-pack.mjs), under their own names so detectLocalAiPack never reads them:
//   <local-ai root>/manifest.mature-lite.json   {version: 1, pack: 'mature', lite: {file: 'models/x.gguf', name: 'X', family: 'qwen'}}
//   <local-ai root>/manifest.mature-standard.json   {version: 1, pack: 'mature', good: {file, name, family}}
// Since the packs carry the llama-server build and the embedding model themselves (so a player can install a Mature pack alone), a marker also
// has `server: 'llama/llama-server.exe'` and `embed: {file, dim, id}` (same shape as the Local AI manifests). This module ignores them:
// bridge/local-ai-pack.mjs reads them (MATURE_ENGINE_MARKERS, the same marker names) so a Mature-only install counts as installed. An older marker
// without them still works beside a Local AI pack.
// A marker may name either tier (the earlier combined manifest.mature.json named both and is still read, for development folders); the first
// marker that names a tier wins. Exactly two models can come out, lite and good: no list, no third entry.
// Only the markers decide ("installed" = at least one valid marker). The model files they list are reported (`present`) but are not required:
// a model that arrived in parts (an older download) is joined by the first start after the download. Pure of any effect: a few small reads,
// never per frame; the bridge looks again at most every few seconds and publishes the answer with the provider status.
import {readFileSync, statSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {LOCAL_AI_ENV, realPathFor} from './local-ai-pack.mjs';

/** The marker of each Mature pack, by the model it carries. */
export const MATURE_MARKERS = Object.freeze({lite: 'manifest.mature-lite.json', good: 'manifest.mature-standard.json'});
/** The earlier single marker that named both models (a development folder may still have one); read after the two above. */
export const MATURE_MARKER = 'manifest.mature.json';
const MARKER_FILES = Object.freeze([MATURE_MARKERS.lite, MATURE_MARKERS.good, MATURE_MARKER]);
/** The Mature models, smallest first (the Local AI packs have standard and lite; the Mature packs have lite and good). */
export const MATURE_TIERS = Object.freeze(['lite', 'good']);

const fileExists = path => { try { return statSync(path).isFile(); } catch { return false; } };
// A leading byte-order mark (Notepad and PowerShell can write one) is not part of the JSON.
const readUtf8 = path => readFileSync(path, 'utf8').replace(/^\uFEFF/, '');

// A path in the marker stays inside the pack: relative, no drive, no `..` segment.
function inside(root, value) {
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value) || /^[a-z]:|^[\\/]/i.test(value)) return null;
  return value.split(/[\\/]+/).includes('..') ? null : resolve(root, value);
}

const parse = text => {
  try {
    const marker = JSON.parse(text);
    return marker && typeof marker === 'object' && marker.version === 1 && marker.pack === 'mature' ? marker : null;
  } catch { return null; }
};

/** {installed, root, models: [{tier: 'lite'|'good', name, family, file, present}]} (two at most, lite first); `installed` is false when no marker is present, readable and ours.
 *  Markers are read from `root` (under Mod Organizer 2 the merged folder of all the packs); `file` is where the model really is (`realPath`, usvfs only). */
export function detectMaturePack({project, environment = process.env, exists = fileExists, readText = readUtf8, realPath = realPathFor(environment)} = {}) {
  // The real pack's folder; in a development checkout without it, the developer Local AI folder (CYBERPUNK_CONVAI_LOCAL_AI_DEV) may hold the markers.
  const primary = environment[LOCAL_AI_ENV.root] ? resolve(environment[LOCAL_AI_ENV.root]) : resolve(project ?? '.', 'local-ai');
  const dev = !environment[LOCAL_AI_ENV.root] && environment[LOCAL_AI_ENV.dev] ? resolve(environment[LOCAL_AI_ENV.dev]) : null;
  const hasMarker = folder => MARKER_FILES.some(name => exists(resolve(folder, name)));
  const root = !hasMarker(primary) && dev && hasMarker(dev) ? dev : primary;
  const markers = [];
  for (const name of MARKER_FILES) {
    const path = resolve(root, name);
    if (!exists(path)) continue;
    let text;
    try { text = readText(path); } catch { continue; }
    const marker = parse(text);
    if (marker) markers.push(marker);
  }
  if (!markers.length) return {installed: false, root, models: []};
  // Two models at most, like the Local AI packs' two tiers: `lite` first, then `good` (the larger one). The first marker that names a tier
  // wins; anything else in a marker is ignored.
  const models = MATURE_TIERS.flatMap(tier => {
    for (const marker of markers) {
      // Under Mod Organizer 2 the folder is the merged virtual one and each model file is looked at where it really is (the identity otherwise).
      const entry = marker[tier], virtual = inside(root, entry?.file), file = virtual && realPath(virtual);
      if (file) {
        return [{tier, name: typeof entry.name === 'string' ? entry.name.slice(0, 80) : '', family: typeof entry.family === 'string' ? entry.family.slice(0, 40) : '',
          file, present: exists(file)}];
      }
    }
    return [];
  });
  return {installed: true, root, models};
}
