// Delete the saved voice setups ("Keep prepared voices") so they are prepared again on the next summon.
//
//   node scripts/Clear-PreparedVoices.mjs [--dry-run]
//
// The folder is runtime/pocket-voice-work/prepared-voices (the Pocket worker's work directory, from the live Pocket
// config), one small .safetensors file per voice. Only files with the worker's exact names are touched (bridge/prepared-voices.mjs,
// the same code as Settings > Voices > Clear prepared voices); the references and the model are untouched.
// Safe while the game runs: a missing file is just prepared again.
import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveVoiceConfigPaths} from '../bridge/voice-config-paths.mjs';
import {clearPreparedVoices, measurePreparedVoices, preparedVoicesFolder} from '../bridge/prepared-voices.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const config = JSON.parse(readFileSync(resolveVoiceConfigPaths(resolve(project, 'runtime')).pocket, 'utf8').replace(/^﻿/, ''));
const folder = preparedVoicesFolder(config);
if (!folder || !existsSync(folder)) { console.log(`Nothing to clear (${folder ?? 'no work directory in the Pocket config'} does not exist).`); process.exit(0); }
const {files, bytes} = dryRun ? await measurePreparedVoices(folder) : await clearPreparedVoices(folder);
console.log(`${dryRun ? 'Would clear' : 'Cleared'} ${files} prepared voice file(s), ${(bytes / 1048576).toFixed(1)} MiB, in ${folder}`);
