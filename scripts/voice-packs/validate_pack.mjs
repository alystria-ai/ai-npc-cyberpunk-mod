// Check a built multilingual pack with the bridge's own all-or-none loader (bridge/voice-language-packs.mjs loadPack), and that every voice has its
// Voxtral slot (prepared/<key>.json + .ogg) and no stray file.
//
//   node scripts/voice-packs/validate_pack.mjs <pack folder (.../voices/multilingual/<lang>)> <language folder name, e.g. zh-cn> [--bridge <bridge folder>]
import {readdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const args = process.argv.slice(2);
const bridgeAt = args.indexOf('--bridge');
const bridgeDirectory = bridgeAt >= 0 ? resolve(args.splice(bridgeAt, 2)[1]) : resolve(dirname(fileURLToPath(import.meta.url)), '../../bridge');
const [folder, language] = args;
if (!folder || !language) throw Error('usage: node validate_pack.mjs <pack folder> <language> [--bridge <bridge folder>]');
const {loadPack} = await import(pathToFileURL(resolve(bridgeDirectory, 'voice-language-packs.mjs')).href);
const result = await loadPack({directory: resolve(folder), language});
if (!result.pack) { console.log('PACK REJECTED:', result.problem); process.exit(1); }
const {entries} = result.pack;
const prepared = new Set(await readdir(resolve(folder, 'prepared')));
const noSlot = [...entries.keys()].filter(key => !prepared.has(`${key}.json`) || !prepared.has(`${key}.ogg`));
const known = new Set([...entries.keys()].flatMap(key => [`${key}.json`, `${key}.ogg`]));
const stray = [...prepared].filter(name => !known.has(name));
const kinds = {};
for (const entry of entries.values()) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
console.log(JSON.stringify({language: result.pack.language, tag: result.pack.tag, voices: entries.size, kinds, withoutSlot: noSlot, strayFiles: stray}));
if (noSlot.length || stray.length) process.exit(1);
