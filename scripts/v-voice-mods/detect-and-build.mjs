#!/usr/bin/env node
// Detects a V voice mod in an archive folder and builds V's reference from it (prototype, bridge/v-voice-mods.mjs).
//
//   node scripts/v-voice-mods/detect-and-build.mjs --mods <folder with .archive files> [--out <folder> --vgmstream <vgmstream-cli.exe>]
//        [--cache <file>] [--lines <v-mod-lines.json>]
//
// Without --out it only detects. With --out it keeps <out>/v-voice.json and <out>/v-male.wav / v-female.wav current (the shape of assets/v-voice, plus the
// archive each came from), building only what changed. Nothing from an archive is ever executed; the only program run is the vgmstream-cli you name,
// which reads one extracted .wem at a time in a private temporary folder.
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {detectVoiceMods, ensureVoiceModReferences, parseModLines, GENDERS} from '../../bridge/v-voice-mods.mjs';
import {vgmstreamDecoder} from '../../bridge/v-voice-mod-reference.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((rows, token, index, all) => token.startsWith('--') ? [...rows, [token.slice(2), all[index + 1] === undefined || all[index + 1].startsWith('--') ? true : all[index + 1]]] : rows, []));
if (!args.mods) { console.error('Usage: node detect-and-build.mjs --mods <folder> [--out <folder> --vgmstream <exe>] [--cache <file>] [--lines <file>]'); process.exit(2); }

const modLines = parseModLines(await readFile(resolve(args.lines || `${HERE}/../../assets/v-voice/v-mod-lines.json`), 'utf8'));
const log = line => console.error('[VVoiceMods] ' + line);
const cachePath = args.cache ? resolve(args.cache) : null;
const summary = detection => ({
  stats: detection.stats,
  archives: detection.archives.map(({relative, size, cached, error, entries, male, female}) => ({relative, size, cached, error, entries,
    male: male && {coverage: Math.round(male.probeHits / male.probeTotal * 1000) / 1000, lineHits: male.lineHits.length},
    female: female && {coverage: Math.round(female.probeHits / female.probeTotal * 1000) / 1000, lineHits: female.lineHits.length}})),
  winners: Object.fromEntries(GENDERS.map(gender => [gender, detection.winners[gender]?.relative ?? null])),
});

if (!args.out) {
  console.log(JSON.stringify(summary(await detectVoiceMods({folder: resolve(args.mods), modLines, cachePath, log})), null, 1));
} else {
  const started = performance.now();
  const result = await ensureVoiceModReferences({modFolder: resolve(args.mods), outFolder: resolve(args.out), modLines, cachePath, log,
    decode: args.vgmstream ? vgmstreamDecoder(resolve(args.vgmstream)) : null});
  console.log(JSON.stringify({...summary(result.detection), references: result.voices, directory: result.directory, totalMs: Math.round(performance.now() - started)}, null, 1));
}
