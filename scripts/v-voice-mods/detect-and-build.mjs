#!/usr/bin/env node
// Detects a V voice mod in an archive folder and builds V's reference from it (prototype, bridge/v-voice-mods.mjs).
//
//   node scripts/v-voice-mods/detect-and-build.mjs --mods <folder with .archive files> --out <folder> [--vgmstream <vgmstream-cli.exe>]
//        [--cache <file>] [--lines <v-mod-lines.json>] [--detect-only]
//
// Never executes anything from the archives; the only program run is the vgmstream-cli you name (it reads one extracted .wem at a time). Writes
// <out>/v-male.wav, <out>/v-female.wav (the gender a winner was found for) and <out>/v-voice.json in the same shape as assets/v-voice/v-voice.json,
// plus `source` (the archive's name, size and time) so a later run can tell the reference is current.
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {detectVoiceMods, parseModLines, GENDERS, linesHeld} from '../../bridge/v-voice-mods.mjs';
import {buildModReference, vgmstreamDecoder} from '../../bridge/v-voice-mod-reference.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((rows, token, index, all) => token.startsWith('--') ? [...rows, [token.slice(2), all[index + 1]?.startsWith('--') || all[index + 1] === undefined ? true : all[index + 1]]] : rows, []));
if (!args.mods) { console.error('Usage: node detect-and-build.mjs --mods <folder> --out <folder> [--vgmstream <exe>] [--cache <file>] [--detect-only]'); process.exit(2); }

const modLines = parseModLines(await readFile(resolve(args.lines || `${HERE}/../../assets/v-voice/v-mod-lines.json`), 'utf8'));
const first = await detectVoiceMods({folder: resolve(args.mods), modLines, cachePath: args.cache ? resolve(args.cache) : null, log: line => console.error('[VVoiceMods] ' + line)});
console.log(JSON.stringify({stats: first.stats, archives: first.archives.map(({relative, size, cached, error, entries, male, female}) => ({relative, size, cached, error, entries,
  male: male && {coverage: Math.round(male.probeHits / male.probeTotal * 1000) / 1000, lineHits: male.lineHits.length}, female: female && {coverage: Math.round(female.probeHits / female.probeTotal * 1000) / 1000, lineHits: female.lineHits.length}})),
  winners: Object.fromEntries(GENDERS.map(gender => [gender, first.winners[gender]?.relative ?? null]))}, null, 1));
if (args['detect-only']) process.exit(0);
if (!args.out || !args.vgmstream) { console.error('--out and --vgmstream are needed to build'); process.exit(2); }

const decode = vgmstreamDecoder(resolve(args.vgmstream));
const out = resolve(args.out);
await mkdir(out, {recursive: true});
const manifest = {version: 1, voices: {}, built: new Date().toISOString().slice(0, 10)};
for (const gender of GENDERS) {
  const winner = first.winners[gender];
  if (!winner) continue;
  const started = performance.now();
  try {
    const made = await buildModReference({archive: resolve(args.mods, winner.relative), lines: linesHeld(modLines, gender, winner), decode, file: `v-${gender}.wav`});
    await writeFile(resolve(out, `v-${gender}.wav`), made.wav);
    manifest.voices[gender] = {...made.entry, source: {archive: winner.relative, size: winner.size}};
    console.log(JSON.stringify({gender, archive: winner.relative, seconds: made.entry.seconds, clips: made.entry.clips, spreadDb: made.report.spreadDb, candidates: made.report.candidates, buildMs: Math.round(performance.now() - started)}));
  } catch (error) { console.error(`${gender}: not built (${error.code ?? 'error'}): ${error.message}`); }
}
await writeFile(resolve(out, 'v-voice.json'), JSON.stringify(manifest, null, 2) + '\n');
