// Is the optional OmniVoice pack installed?
//
// OmniVoice (GPU) is an optional download next to the Pocket voice that ships with the mod. The pack is the
// worker's Python environment, the OmniVoice model weights and the voice adapter. This is the same set the
// resident worker needs before it can start (bridge/resident-voice.mjs, bridge/resident-voice-worker.py), checked
// here without spawning anything so Settings can grey the options out and the bridge can fall back cleanly.
// A CUDA GPU is not tested here; a worker that cannot get one fails at start and the existing fallback applies.
import {statSync} from 'node:fs';
import {resolve} from 'node:path';

const fileExists = path => { try { return statSync(path).isFile(); } catch { return false; } };

// Returns {installed, missing: ['python'|'model'|'adapter'|'worker'], python, model} from the configuration the
// worker will be given. `environment` carries the portable-layout overrides the worker also reads.
export function detectOmniPack({project, config = {}, pythonExecutable, environment = process.env, exists = fileExists} = {}) {
  const missing = [];
  const python = pythonExecutable || environment.CYBERPUNK_CONVAI_PYTHON
    || resolve(project, 'vendor/reference-voicestudio/.venv/Scripts/python.exe');
  if (!exists(python)) missing.push('python');
  const modelDirectory = environment.CYBERPUNK_CONVAI_OMNI_MODEL
    || (typeof config.model === 'string' && !/^[a-z]:|^[\\/]|\.\./i.test(config.model) ? resolve(project, config.model) : null);
  if (!modelDirectory || !exists(resolve(modelDirectory, 'model.safetensors'))) missing.push('model');
  const adapterDirectory = environment.CYBERPUNK_CONVAI_OMNI_ADAPTER || resolve(project, 'vendor/reference-voicestudio/backend');
  if (!exists(resolve(adapterDirectory, 'services/tts_backend.py'))) missing.push('adapter');
  if (!exists(resolve(project, 'bridge/resident-voice-worker.py'))) missing.push('worker');
  return {installed: missing.length === 0, missing, python, model: modelDirectory};
}

export const OMNI_PACK_MISSING_MESSAGE = 'Requires the optional OmniVoice pack (GPU)';

// The reference clips an OmniVoice configuration names that are not on disk. The pack carries most of the clips (the Runtime only the few it needs for
// the Mistral voice), so a pack extraction that stopped half way, or a mod manager that cleared a folder, leaves the model and the worker in place (the
// pack counts as installed above) while a character whose clip is gone has no OmniVoice voice: the worker marks that one profile unavailable and its
// replies are written. This names them so the bridge can say so once in its log. `referenceDirectory` is the folder the worker reads clips from
// (CYBERPUNK_CONVAI_OMNI_REFERENCES); a clip is "runtime/voice-references/<path>" in the configuration. Returns {total, missing: [path, ...]}.
const REFERENCE_PREFIX = 'runtime/voice-references/';
export function missingOmniClips({config = {}, referenceDirectory, exists = fileExists} = {}) {
  const wanted = new Set();
  for (const voice of Object.values(config?.voices ?? {})) {
    const reference = voice?.reference;
    // Player clips (<state>/player-voices) and anything else outside the shipped folder are not the pack's.
    if (typeof reference === 'string' && reference.startsWith(REFERENCE_PREFIX) && !/\.\.|\|:/.test(reference)) wanted.add(reference.slice(REFERENCE_PREFIX.length));
  }
  if (!referenceDirectory) return {total: wanted.size, missing: []};
  const missing = [...wanted].filter(path => !exists(resolve(referenceDirectory, ...path.split('/')))).sort();
  return {total: wanted.size, missing};
}

/** One log line for a check result, or null when nothing is missing. */
export function missingOmniClipsLine({total, missing}, mode = '') {
  if (!missing.length) return null;
  const shown = missing.slice(0, 3).map(path => path.split('/').pop().replace(/\.wav$/i, '')).join(', ');
  return `[OmniPack] ${missing.length} of ${total} ${mode ? mode + ' ' : ''}reference clips are missing (for example ${shown}${missing.length > 3 ? ', ...' : ''}): `
    + 'those characters have no OmniVoice voice and their replies are written. Extract the OmniVoice pack again, over the game folder.';
}
