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
