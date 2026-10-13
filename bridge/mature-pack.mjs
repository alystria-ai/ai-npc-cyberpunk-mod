// Is the optional Mature pack installed?
//
// The Mature pack is a separate, optional download (only on the project's GitHub releases) that holds the uncensored model files
// (packaging/MATURE_PACK_README.md). It does NOT gate the "Mature content" setting (bridge/mature-content.mjs), which is part of the main
// mod and works with any model; this marker only tells the setting's help text whether the uncensored models are installed. The marker sits in the Local AI folder, beside the manifest fragments of the two Local AI
// packs (manifest.standard.json, manifest.lite.json; bridge/local-ai-pack.mjs), under its own name so the Local AI detector never reads it:
//   <local-ai root>/manifest.mature.json   {version: 1, pack: 'mature', models: [{file: 'models/x.gguf', name: 'X', family: 'qwen'}]}
// Only the marker decides ("installed" = a valid marker). The model files it lists are reported (`present`) but are not required: a split
// model is joined by the first start after the download. Pure of any effect: one small read, never per frame; the bridge looks again at
// most every few seconds and publishes the answer with the provider status.
import {readFileSync, statSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {LOCAL_AI_ENV} from './local-ai-pack.mjs';

export const MATURE_MARKER = 'manifest.mature.json';

const fileExists = path => { try { return statSync(path).isFile(); } catch { return false; } };
const readUtf8 = path => readFileSync(path, 'utf8');

// A path in the marker stays inside the pack: relative, no drive, no `..` segment.
function inside(root, value) {
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value) || /^[a-z]:|^[\\/]/i.test(value)) return null;
  return value.split(/[\\/]+/).includes('..') ? null : resolve(root, value);
}

/** {installed, root, models: [{name, family, file, present}]}; `installed` is false for a missing, unreadable or foreign marker. */
export function detectMaturePack({project, environment = process.env, exists = fileExists, readText = readUtf8} = {}) {
  const root = environment[LOCAL_AI_ENV.root] ? resolve(environment[LOCAL_AI_ENV.root]) : resolve(project ?? '.', 'local-ai');
  const none = {installed: false, root, models: []};
  const path = resolve(root, MATURE_MARKER);
  if (!exists(path)) return none;
  let marker;
  try { marker = JSON.parse(readText(path)); } catch { return none; }
  if (!marker || typeof marker !== 'object' || marker.version !== 1 || marker.pack !== 'mature') return none;
  const models = (Array.isArray(marker.models) ? marker.models : []).flatMap(entry => {
    const file = inside(root, entry?.file);
    return file ? [{name: typeof entry.name === 'string' ? entry.name.slice(0, 80) : '', family: typeof entry.family === 'string' ? entry.family.slice(0, 40) : '',
      file, present: exists(file)}] : [];
  });
  return {installed: true, root, models};
}
