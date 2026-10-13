// Turn the clip search's winners into NEW proposed voice configs (nothing live is touched).
//
//   node scripts/Build-AutobestConfigs.mjs [--dry-run] [--no-validate] [--only voice,voice] [--sets <autobest-sets.json>] [--index <pool-index.json>]
//
// Reads runtime/autobest-sets.json (schema version 2, written by scripts/clip-search/collect.py from the per-voice search results)
// and builds, exactly like scripts/Apply-ReferencePicks.mjs builds picked configs (whole clips, 0.4 s gaps, no processing; the live
// config copied with only the searched voices replaced; every output dry-run through the bridge's own loaders). A reference is
// measured by its total duration (any number of whole clips within the limit):
//   Pocket best      (pocket.best, <= 30 s) -> runtime/pocket-voices.autobest.json
//   OmniVoice best   (omni.best,   <= 18 s) -> runtime/local-voices.autobest.json
//   OmniVoice short  (omni.short,  <= 10 s) -> runtime/local-voices.autobest-short.json
//   OmniVoice long   (omni.long,   <= 18 s) -> runtime/local-voices.autobest-long.json
// (the bridge's own OmniVoice reference limit is 20 s).
// References go to runtime/voice-references/picked/autobest/<folder>/<voice>.wav.  Live configs are never written.
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyPicks} from './Apply-ReferencePicks.mjs';
import {ensureIndex, loadIndex, Pool} from './reference-picker/pool.mjs';

export const AUTOBEST_OUTPUTS = Object.freeze({
  pocket: {live: 'runtime/pocket-voices.json', out: 'runtime/pocket-voices.autobest.json', folder: 'autobest/pocket', maxSeconds: 30, label: 'Pocket auto-best'},
  omni: {live: 'runtime/local-voices.json', out: 'runtime/local-voices.autobest.json', folder: 'autobest/omni', maxSeconds: 18, label: 'OmniVoice auto-best'},
  'omni-short': {live: 'runtime/local-voices.json', out: 'runtime/local-voices.autobest-short.json', folder: 'autobest/omni-short', maxSeconds: 10, label: 'OmniVoice auto-best short (10 s)'},
  'omni-long': {live: 'runtime/local-voices.json', out: 'runtime/local-voices.autobest-long.json', folder: 'autobest/omni-long', maxSeconds: 18, label: 'OmniVoice auto-best long (18 s)'},
});
// where each searched winner goes: [engine, key in the data file's engine block, output key above]
const SOURCES = [['pocket', 'best', 'pocket'], ['omni', 'best', 'omni'], ['omni', 'short', 'omni-short'], ['omni', 'long', 'omni-long']];

// The synthetic "picks" state Apply-ReferencePicks expects: {voices: {voice: {kept: {set: {clips, ts, note}}}}, entries}.
export function picksFromAutobest(data, {only = null} = {}) {
  const voices = {};
  let entries = 0;
  for (const [voice, row] of Object.entries(data.voices ?? {})) {
    if (only && !only.includes(voice)) continue;
    for (const [engine, variant, output] of SOURCES) {
      const set = row[engine]?.[variant];
      if (!set?.ids?.length || set.ids.some(id => id.startsWith('live:'))) continue;   // today's reference won: nothing to propose
      const note = set.note ?? `auto-best ${engine} ${variant}: ${set.seconds ?? '?'} s, ECAPA ${set.ecapa}${set.ecapa_se != null ? ` +-${set.ecapa_se}` : ''}${set.pls != null ? `, PLS ${set.pls}` : ''}`;
      (voices[voice] ??= {kept: {}}).kept[output] = {clips: set.ids, seconds: set.seconds ?? null, ts: data.generated ?? null, note};
      entries++;
    }
  }
  return {voices, entries};
}

export async function buildAutobest({project, data, pool, only = null, dryRun = false, validate = true, log = () => {}}) {
  const pick = picksFromAutobest(data, {only});
  return applyPicks({project, pick, pool, only, dryRun, validate, log, outputs: AUTOBEST_OUTPUTS,
    source: 'clip search (Build-AutobestConfigs.mjs)', picksLog: 'runtime/autobest-sets.json'});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, at, all) => {
    if (token.startsWith('--')) pairs.push([token.slice(2), all[at + 1] === undefined || all[at + 1].startsWith('--') ? true : all[at + 1]]);
    return pairs;
  }, []));
  const setsPath = resolve(project, typeof args.sets === 'string' ? args.sets : 'runtime/autobest-sets.json');
  if (!existsSync(setsPath)) { console.log(`No ${setsPath} yet; run scripts/clip-search/collect.py first.`); process.exit(0); }
  const data = JSON.parse(await readFile(setsPath, 'utf8'));
  const work = resolve(args.work ?? 'E:/CyberpunkConvai-offload/work/reference-picker');
  const pool = new Pool(await loadIndex(typeof args.index === 'string' ? resolve(args.index) : ensureIndex({project, work, log: console.log})), {project});
  const report = await buildAutobest({project, data, pool, only: typeof args.only === 'string' ? args.only.split(',') : null,
    dryRun: !!args['dry-run'], validate: !args['no-validate'], log: console.log});
  for (const skipped of report.skipped) console.log(`skipped ${skipped.voice} (${skipped.engine}): ${skipped.reason}`);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(report.engines).map(([engine, entry]) => [engine,
    {output: entry.output, voices: entry.changed.map(item => ({voice: item.voice, seconds: item.seconds}))}])), null, 2));
  console.log('Live configs were not changed.');
}
