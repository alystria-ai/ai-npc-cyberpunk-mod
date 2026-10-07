// Which voice configuration files the bridge runs on.
//
// The base files (runtime/pocket-voices.json, runtime/local-voices.json) hold the model identity and each
// character's original reference. The clip search writes better references into separate files
// (runtime/pocket-voices.autobest.json, local-voices.autobest-short.json, local-voices.autobest-long.json;
// scripts/Build-AutobestConfigs.mjs). runtime/voice-configs.json says which file is live for each choice, so
// dropping regenerated files over those names is all a new search needs; nothing is copied or renamed.
//
//   {"version": 1, "pocket": "pocket-voices.autobest.json",
//    "omni": {"short": "local-voices.autobest-short.json", "long": "local-voices.autobest-long.json"}}
//
// Names are plain file names inside the state directory. A missing manifest or a missing file falls back to the
// base file, so a machine without the searched references still starts.
import {existsSync, readFileSync} from 'node:fs';
import {basename, resolve} from 'node:path';

export const VOICE_CONFIG_MANIFEST = 'voice-configs.json';
export const BASE_VOICE_CONFIGS = Object.freeze({pocket: 'pocket-voices.json', omni: 'local-voices.json'});
export const OMNI_REFERENCES = Object.freeze(['short', 'long']);
export const DEFAULT_OMNI_REFERENCE = 'long';
export const DEFAULT_VOICE_CONFIG_MANIFEST = Object.freeze({version: 1, pocket: 'pocket-voices.autobest.json',
  omni: Object.freeze({short: 'local-voices.autobest-short.json', long: 'local-voices.autobest-long.json'})});

const plainName = value => typeof value === 'string' && value === basename(value) && /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(value);

export function readVoiceConfigManifest(stateDirectory, {readFile = readFileSync} = {}) {
  try {
    const value = JSON.parse(readFile(resolve(stateDirectory, VOICE_CONFIG_MANIFEST), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

// Returns absolute paths: {pocket, omni: {short, long}, warnings: [...]}. Every entry falls back to its base file.
export function resolveVoiceConfigPaths(stateDirectory, {exists = existsSync, manifest = readVoiceConfigManifest(stateDirectory)} = {}) {
  const warnings = [];
  const choose = (named, base, label) => {
    if (named === undefined) return resolve(stateDirectory, base);
    if (!plainName(named)) { warnings.push(`${label}: "${String(named).slice(0, 80)}" is not a plain file name; using ${base}`); return resolve(stateDirectory, base); }
    const path = resolve(stateDirectory, named);
    if (!exists(path)) { warnings.push(`${label}: ${named} is missing; using ${base}`); return resolve(stateDirectory, base); }
    return path;
  };
  const omni = manifest.omni && typeof manifest.omni === 'object' ? manifest.omni : {};
  return {
    pocket: choose(manifest.pocket, BASE_VOICE_CONFIGS.pocket, 'pocket'),
    omni: Object.fromEntries(OMNI_REFERENCES.map(reference =>
      [reference, choose(omni[reference], BASE_VOICE_CONFIGS.omni, `omni ${reference}`)])),
    warnings,
  };
}
