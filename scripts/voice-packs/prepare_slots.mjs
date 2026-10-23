// Build the Voxtral (Mistral voice) prepared slots of a multilingual pack with the bridge's own code: no network, no key, no Mistral call.
//
//   node scripts/voice-packs/prepare_slots.mjs <pack folder (.../voices/multilingual/<lang>)> [--bridge <bridge folder>] [--report <file>]
//
// For every voice of the pack's manifest.json this calls VoxtralVoice.buildFromPack, the call the bridge makes when a reply in the pack's
// language needs the reference (bridge/voxtral-voice.mjs): the clip is checked against the manifest's hash, an archetypes/ clip is cut to one
// clip (singleClip, like the English archetype references), the reference is cut at a pause to about 8.5 s and encoded as Ogg Vorbis q2 with
// ffmpeg, and the slot is written to <pack>/prepared/<key>.json + <key>.ogg (found by the same signature the bridge looks for).
// ffmpeg must be on PATH (or CYBERPUNK_CONVAI_FFMPEG).
// --bridge: the bridge folder to take the code from (default: this repository's). buildFromPack comes with the multilingual pack branch.
import {readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const args = process.argv.slice(2);
const bridgeAt = args.indexOf('--bridge');
const bridgeDirectory = bridgeAt >= 0 ? resolve(args.splice(bridgeAt, 2)[1]) : resolve(dirname(fileURLToPath(import.meta.url)), '../../bridge');
const reportAt = args.indexOf('--report');
const reportPath = reportAt >= 0 ? resolve(args.splice(reportAt, 2)[1]) : null;
const packDirectory = resolve(args[0] ?? '');
if (!args[0]) throw Error('usage: node prepare_slots.mjs <pack folder> [--bridge <bridge folder>]');
const load = name => import(pathToFileURL(resolve(bridgeDirectory, name)).href);
const {VoxtralVoice} = await load('voxtral-voice.mjs');
const {createReferencePreparer, findFfmpeg} = await load('voxtral-reference.mjs');
if (typeof VoxtralVoice.prototype.buildFromPack !== 'function') throw Error(`${bridgeDirectory}: VoxtralVoice has no buildFromPack (the multilingual pack bridge code is needed)`);
if (!await findFfmpeg()) throw Error('ffmpeg is needed to build the compressed references');

const manifest = JSON.parse((await readFile(resolve(packDirectory, 'manifest.json'), 'utf8')).replace(/^﻿/, ''));
const preparers = new Map();
const prepare = (bytes, options = {}) => {
  const directory = options.slots;
  if (!directory) throw Error('a pack reference must name its slot folder');
  if (!preparers.has(directory)) preparers.set(directory, createReferencePreparer({cacheDirectory: directory, onLog: message => console.log('prepare:', message)}));
  return preparers.get(directory)(bytes, options);
};
const voice = new VoxtralVoice({getKey: () => null, referenceRoot: packDirectory, registry: [], prepare, onLog: () => {}});
const preparedDirectory = resolve(packDirectory, 'prepared');
const rows = [];
let failed = 0;
for (const [key, row] of Object.entries(manifest.voices)) {
  const entry = {key, language: manifest.language, tag: manifest.languageTag, file: row.file, kind: row.file.split('/')[0], path: resolve(packDirectory, ...row.file.split('/')),
    sha256: row.sha256 ?? null, preparedDirectory};
  try {
    const made = await voice.buildFromPack(key, entry);
    if (!made || made.format !== 'ogg') { failed++; console.log(`FAILED ${key}: ${made ? 'format ' + made.format : 'no reference'}`); continue; }
    rows.push({key, format: made.format, bytes: made.bytes, originalBytes: made.originalBytes});
  } catch (error) { failed++; console.log(`FAILED ${key}: ${error?.message ?? error}`); }
}
const total = rows.reduce((sum, row) => sum + row.bytes, 0);
console.log(JSON.stringify({pack: manifest.language, slots: rows.length, failed, oggBytes: total}));
if (reportPath) await writeFile(reportPath, JSON.stringify({slots: rows, failed}, null, 1));
if (failed) process.exit(1);
