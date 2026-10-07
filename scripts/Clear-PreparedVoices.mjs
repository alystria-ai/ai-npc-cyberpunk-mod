// Delete the saved voice setups ("Keep prepared voices") so they are prepared again on the next summon.
//
//   node scripts/Clear-PreparedVoices.mjs [--dry-run]
//
// The folder is runtime/pocket-voice-work/prepared-voices (the Pocket worker's work directory, from the live Pocket
// config), one small .safetensors file per voice. Nothing else lives there; the references and the model are untouched.
// Safe while the game runs: a missing file is just prepared again.
import {existsSync, readdirSync, readFileSync, rmSync, statSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveVoiceConfigPaths} from '../bridge/voice-config-paths.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const config = JSON.parse(readFileSync(resolveVoiceConfigPaths(resolve(project, 'runtime')).pocket, 'utf8').replace(/^﻿/, ''));
const folder = resolve(config.runtime.workDirectory, 'prepared-voices');
if (!existsSync(folder)) { console.log(`Nothing to clear (${folder} does not exist).`); process.exit(0); }
let files = 0, bytes = 0;
for (const name of readdirSync(folder)) {
  if (!/\.safetensors(\.tmp)?$/.test(name)) continue;
  const path = resolve(folder, name);
  bytes += statSync(path).size; files++;
  if (!dryRun) rmSync(path, {force: true});
}
console.log(`${dryRun ? 'Would clear' : 'Cleared'} ${files} prepared voice file(s), ${(bytes / 1048576).toFixed(1)} MiB, in ${folder}`);
