// Writes characters/voice-clips-words.json: the words said in each character's reference clips, per engine, for every character of the clip manifest.
//
//   node scripts/voice-extract/write_words.mjs [--runtime <folder with the voice configurations>] [--check]
//
// The voice tables name a clip together with its words. A character that has a row in the shipped configurations keeps those words when its clips are built on the
// player's PC (bridge/voice-clips.mjs descriptors), but a character with no row there (an older Runtime that predates the character) has none, so the words
// come from this file. Each set of words is taken from the configuration row whose clip hash is the manifest's hash for that engine, so the words always belong to
// the clip the builder rebuilds. Run it again after the manifest or the configurations change. --check writes nothing and exits 1 when the file would change.
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ENGINE_KINDS, readManifest} from '../../bridge/voice-clips.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const runtime = resolve(root, args.includes('--runtime') ? args[args.indexOf('--runtime') + 1] : 'runtime');
const CONFIGS = {pocket: 'pocket-voices.autobest.json', short: 'local-voices.autobest-short.json', long: 'local-voices.autobest-long.json'};

const manifest = readManifest(readFileSync(resolve(root, 'characters/voice-clips-manifest.json'), 'utf8'));
const tables = Object.fromEntries(Object.entries(CONFIGS).map(([engine, file]) => [engine, JSON.parse(readFileSync(resolve(runtime, file), 'utf8')).voices ?? {}]));
const words = {};
const missing = [];
for (const key of Object.keys(manifest).sort()) {
  const row = {};
  for (const [engine, kind] of Object.entries(ENGINE_KINDS)) {
    const own = tables[engine][key];
    if (own?.sha256 === manifest[key][kind].sha256 && typeof own.transcript === 'string' && own.transcript.trim()) row[engine] = own.transcript;
    else missing.push(`${key}/${engine}`);
  }
  if (Object.keys(row).length === 3) words[key] = row;
}
if (missing.length) console.error(`no matching words for ${missing.length} clip(s), left out: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', ...' : ''}`);
const text = JSON.stringify({version: 1, voices: words}, null, 0).replace(/\},"/g, '},\n"').replace(/^\{"version":1,"voices":\{/, '{"version":1,"voices":{\n') + '\n';
const target = resolve(root, 'characters/voice-clips-words.json');
let current = '';
try { current = readFileSync(target, 'utf8'); } catch { /* not written yet */ }
if (args.includes('--check')) { console.log(current === text ? 'voice-clips-words.json is up to date' : 'voice-clips-words.json is out of date'); process.exit(current === text ? 0 : 1); }
writeFileSync(target, text);
console.log(`wrote ${Object.keys(words).length} characters to characters/voice-clips-words.json`);
