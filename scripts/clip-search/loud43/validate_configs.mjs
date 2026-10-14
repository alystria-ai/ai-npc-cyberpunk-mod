// Check the four autobest configs (after apply_loud43.py) with the bridge's own Node loaders and the Python validators.
//   node scripts/clip-search/loud43/validate_configs.mjs <state project root, default: the repository this file is in>
// Reads only; no model is loaded.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const project = resolve(process.argv[2] ?? here);
const {createVoiceProfileRegistry} = await import(pathToFileURL(resolve(here, 'bridge/voice-profile-registry.mjs')).href);
const {validatePocketConfig} = await import(pathToFileURL(resolve(here, 'bridge/pocket-voice.mjs')).href);
const read = file => JSON.parse(readFileSync(resolve(project, 'runtime', file), 'utf8').replace(/^﻿/, ''));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const sets = JSON.parse(readFileSync(resolve(here, 'scripts/clip-search/loud43/autobest-sets.loud43.json'), 'utf8'));
const voices = Object.keys(sets.voices);
let failed = 0;
for (const [engine, file] of [['pocket', 'pocket-voices.autobest.json'], ['omni', 'local-voices.autobest-short.json'],
  ['omni', 'local-voices.autobest-long.json'], ['omni', 'local-voices.autobest.json']]) {
  const config = read(file);
  const registry = engine === 'pocket' ? validatePocketConfig(config).registry : createVoiceProfileRegistry(config);
  const missing = voices.filter(voice => !registry.has(voice));
  const badHash = voices.filter(voice => sha(resolve(project, config.voices[voice].reference)) !== config.voices[voice].sha256);
  const python = engine === 'pocket' ? config.runtime.pythonExecutable : resolve(project, 'vendor/reference-voicestudio/.venv/Scripts/python.exe');
  const run = spawnSync(python, ['-B', resolve(project, 'scripts/reference-picker/validate-config.py'), engine, resolve(project, 'runtime', file)],
    {cwd: project, encoding: 'utf8', env: {...process.env, PYTHONUTF8: '1', CUDA_VISIBLE_DEVICES: '-1'}, timeout: 300_000});
  let py;
  try { py = JSON.parse(run.stdout.trim().split('\n').at(-1)); } catch { py = {ok: false, error: (run.stderr || run.stdout || 'no output').slice(-300)}; }
  const unavailable = py.ok ? voices.filter(voice => py.unavailable?.[voice] || !py.ready.includes(voice)) : voices;
  const ok = !missing.length && !badHash.length && py.ok && !unavailable.length;
  if (!ok) failed++;
  console.log(`${file}: node registry ${registry.keys.length} voices, missing ${missing.length}, hash mismatches ${badHash.length}; python ok=${py.ok} ready ${py.ready?.length} unavailable(43) ${unavailable.length} ${py.error ?? ''} -> ${ok ? 'OK' : 'FAILED'}`);
}
process.exit(failed ? 1 : 0);
