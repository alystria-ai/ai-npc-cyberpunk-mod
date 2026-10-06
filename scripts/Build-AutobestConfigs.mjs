// Turn the clip search's winners into NEW proposed voice configs (nothing live is touched).
//
//   node scripts/Build-AutobestConfigs.mjs [--dry-run] [--no-validate] [--only voice,voice] [--sets <autobest-sets.json>] [--index <pool-index.json>]
//
// Reads runtime/autobest-sets.json (written by scripts/clip-search/collect.py from the per-voice search results) and builds,
// exactly like scripts/Apply-ReferencePicks.mjs builds picked configs (whole clips, 0.4 s gaps, no processing; the live
// config copied with only the searched voices replaced; every output dry-run through the bridge's own loaders):
//   Pocket   best (1-3 clips, <= 18 s)   -> runtime/pocket-voices.autobest.json
//   Pocket   short (1-2 clips, <= 10 s)  -> runtime/pocket-voices.autobest-short.json
//   Pocket   single clip                 -> runtime/pocket-voices.autobest-single.json
//   OmniVoice best / short / single      -> runtime/local-voices.autobest.json / .autobest-short.json / .autobest-single.json
// References go to runtime/voice-references/picked/autobest/<variant>/<voice>.wav.  Live configs are never written.
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyPicks} from './Apply-ReferencePicks.mjs';
import {ensureIndex, loadIndex, Pool} from './reference-picker/pool.mjs';

export const AUTOBEST_OUTPUTS = Object.freeze({
  pocket: {live: 'runtime/pocket-voices.json', out: 'runtime/pocket-voices.autobest.json', folder: 'autobest/pocket', maxSeconds: 18, label: 'Pocket auto-best'},
  'pocket-short': {live: 'runtime/pocket-voices.json', out: 'runtime/pocket-voices.autobest-short.json', folder: 'autobest/pocket-short', maxSeconds: 10, label: 'Pocket auto-best 10 s'},
  'pocket-single': {live: 'runtime/pocket-voices.json', out: 'runtime/pocket-voices.autobest-single.json', folder: 'autobest/pocket-single', maxSeconds: 9, label: 'Pocket auto-best single clip'},
  omni: {live: 'runtime/local-voices.json', out: 'runtime/local-voices.autobest.json', folder: 'autobest/omni', maxSeconds: 18, label: 'OmniVoice auto-best'},
  'omni-short': {live: 'runtime/local-voices.json', out: 'runtime/local-voices.autobest-short.json', folder: 'autobest/omni-short', maxSeconds: 10, label: 'OmniVoice auto-best 10 s'},
  'omni-single': {live: 'runtime/local-voices.json', out: 'runtime/local-voices.autobest-single.json', folder: 'autobest/omni-single', maxSeconds: 9, label: 'OmniVoice auto-best single clip'},
});
// search variant (best / short / single) -> picker set name, per engine
const VARIANTS = {best: '', short: '-short', single: '-single'};

// The synthetic "picks" state Apply-ReferencePicks expects: {voices: {voice: {kept: {set: {clips, ts, note}}}}, entries}.
export function picksFromAutobest(data, {only = null} = {}) {
  const voices = {};
  let entries = 0;
  for (const [voice, row] of Object.entries(data.voices ?? {})) {
    if (only && !only.includes(voice)) continue;
    for (const engine of ['pocket', 'omni']) {
      for (const [variant, suffix] of Object.entries(VARIANTS)) {
        const set = row[engine]?.[variant];
        if (!set?.ids?.length || set.ids.some(id => id.startsWith('live:'))) continue;   // today's reference won: nothing to propose
        const note = `auto-best ${engine} ${variant}: ECAPA ${set.ecapa}${set.ecapa_se != null ? ` +-${set.ecapa_se}` : ''}${set.pls != null ? `, PLS ${set.pls}` : ''}`;
        (voices[voice] ??= {kept: {}}).kept[engine + suffix] = {clips: set.ids, seconds: set.seconds ?? null, ts: data.generated ?? null, note};
        entries++;
      }
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
    {output: entry.output, voices: entry.changed.map(item => ({voice: item.voice, seconds: item.seconds, clips: item.clips.length}))}])), null, 2));
  console.log('Live configs were not changed.');
}
