// Make the searched references and the new Pocket student the live voice setup (October 7, 2026).
//
//   node scripts/Switch-VoiceConfigs.mjs [--dry-run] [--export <student export dir>]
//
// 1. Copies the previous live configs to runtime/backups/voice-configs-<date>/ (never overwritten).
// 2. Points runtime/pocket-voices.json (the base the clip search builds from) and runtime/pocket-voices.autobest.json
//    at the student + decoder v2 export (default: runtime/pocket-student-v2-s2000-ema-decv2), taking the model hashes
//    from that export's own receipt and files. Voices and references are not touched.
// 3. Writes runtime/voice-configs.json so the bridge runs on the autobest files (bridge/voice-config-paths.mjs).
// 4. Dry-runs every file the bridge will use through the Node and Python loaders.
//
// Re-running is safe: it backs up once and rewrites the same values.
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validatePocketConfig} from '../bridge/pocket-voice.mjs';
import {createVoiceProfileRegistry} from '../bridge/voice-profile-registry.mjs';
import {DEFAULT_VOICE_CONFIG_MANIFEST, VOICE_CONFIG_MANIFEST} from '../bridge/voice-config-paths.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const exportDirectory = resolve(project, args.includes('--export') ? args[args.indexOf('--export') + 1] : 'runtime/pocket-student-v2-s2000-ema-decv2');
const runtime = resolve(project, 'runtime');
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
const write = (path, value) => { if (!dryRun) writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };

const receipt = readJson(resolve(exportDirectory, 'receipt.json'));
const modelSha = sha(resolve(exportDirectory, 'model.safetensors'));
if (receipt.model_sha256 !== modelSha) throw Error('The export receipt does not describe its model.safetensors');
const model = {sha256: modelSha, configSha256: sha(resolve(exportDirectory, 'inference.yaml')),
  tokenizerSha256: sha(resolve(exportDirectory, 'tokenizer.json')), receiptSha256: sha(resolve(exportDirectory, 'receipt.json')),
  inputIdentity: receipt.input_identity, selectedStep: receipt.selected_step};
const decoder = existsSync(resolve(exportDirectory, 'decoder-receipt.json')) ? readJson(resolve(exportDirectory, 'decoder-receipt.json')) : null;
console.log(`Student: step ${model.selectedStep}, ${receipt.weights}, decoder ${decoder ? decoder.decoder_sha256.slice(0, 12) : 'pretrained'}`);

const files = ['pocket-voices.json', 'local-voices.json', 'pocket-voices.autobest.json', 'local-voices.autobest-short.json',
  'local-voices.autobest-long.json', 'local-voices.autobest.json', VOICE_CONFIG_MANIFEST];
const backup = resolve(runtime, 'backups', `voice-configs-${new Date().toISOString().slice(0, 10)}`);
if (!existsSync(backup)) {
  console.log(`Backing up to ${backup}`);
  if (!dryRun) {
    mkdirSync(backup, {recursive: true});
    for (const name of files) if (existsSync(resolve(runtime, name))) copyFileSync(resolve(runtime, name), resolve(backup, name));
  }
} else console.log(`Backup ${backup} already exists; not overwritten`);

for (const name of ['pocket-voices.json', 'pocket-voices.autobest.json']) {
  const path = resolve(runtime, name);
  const config = readJson(path);
  config.runtime = {...config.runtime, exportDirectory};
  config.model = model;
  write(path, config);
  console.log(`${name}: student export set (${Object.keys(config.voices).length} voices unchanged)`);
}
write(resolve(runtime, VOICE_CONFIG_MANIFEST), DEFAULT_VOICE_CONFIG_MANIFEST);
console.log(`${VOICE_CONFIG_MANIFEST}: ${JSON.stringify(DEFAULT_VOICE_CONFIG_MANIFEST)}`);

if (!dryRun) {
  const pocket = readJson(resolve(runtime, DEFAULT_VOICE_CONFIG_MANIFEST.pocket));
  const python = pocket.runtime.pythonExecutable;
  validatePocketConfig(pocket);
  for (const name of Object.values(DEFAULT_VOICE_CONFIG_MANIFEST.omni)) createVoiceProfileRegistry(readJson(resolve(runtime, name)));
  const check = spawnSync(python, ['-B', '-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(resolve(project, 'bridge'))})
from pocket_voice_runtime import validate_config
registry = validate_config(json.load(open(${JSON.stringify(resolve(runtime, DEFAULT_VOICE_CONFIG_MANIFEST.pocket))}, encoding='utf-8-sig')))
print('python: Pocket config valid;', len(registry['refs']), 'voices ready,', len(registry['unavailable']), 'unavailable')`], {encoding: 'utf8'});
  process.stdout.write(check.stdout + check.stderr);
  if (check.status !== 0) process.exit(1);
}
