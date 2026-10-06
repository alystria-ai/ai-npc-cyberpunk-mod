// Turn the clip sets kept in the reference picker into NEW proposed voice configs. Nothing live is touched.
//
//   node scripts/Apply-ReferencePicks.mjs [--dry-run] [--no-validate] [--only voice,voice] [--picks <log>] [--index <pool-index.json>]
//
// Reads runtime/reference-picks.jsonl (the picker's action log; the kept set per voice and engine is rebuilt by
// replaying it) and, for every voice with a kept set:
//   * concatenates the kept whole clips into runtime/voice-references/picked/<engine>/<voice>.wav exactly like the
//     research agent's proposed references (24 kHz mono 16-bit, 0.4 s of silence between clips, in the kept order;
//     no EQ, denoising, trimming or gain);
//   * copies the live config and replaces only those voices' entries (reference, sha256, transcript = the clips'
//     transcripts joined with spaces, plus a "pick" note of the clip ids):
//       Pocket (up to 30 s)          kept "pocket"     -> runtime/pocket-voices.picked.json        (from runtime/pocket-voices.json)
//       OmniVoice long (up to 18 s)  kept "omni"       -> runtime/local-voices.picked.json         (from runtime/local-voices.json)
//       OmniVoice short (up to 10 s) kept "omni-short" -> runtime/local-voices.picked-short.json   (from runtime/local-voices.json)
// A reference is measured by its total duration, not by how many clips it joins.
// then dry-runs every written config through the bridge's own loaders (createVoiceProfileRegistry /
// validatePocketConfig in Node, validate_config of resident-voice-worker.py and pocket_voice_runtime.py in Python):
// no model is loaded and no worker is started. The live configs (runtime/pocket-voices.json, runtime/local-voices.json)
// are never written; switching to a picked config is a separate step.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {concatClips, encodeWav, readWav, REFERENCE_RATE} from './reference-picker/audio.mjs';
import {ensureIndex, loadIndex, Pool} from './reference-picker/pool.mjs';
import {readPicks} from './reference-picker/picks.mjs';
import {createVoiceProfileRegistry} from '../bridge/voice-profile-registry.mjs';
import {validatePocketConfig} from '../bridge/pocket-voice.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
export const OUTPUTS = Object.freeze({
  pocket: {live: 'runtime/pocket-voices.json', out: 'runtime/pocket-voices.picked.json', folder: 'pocket', maxSeconds: 30, label: 'Pocket'},
  omni: {live: 'runtime/local-voices.json', out: 'runtime/local-voices.picked.json', folder: 'omni', maxSeconds: 18, label: 'OmniVoice'},
  'omni-short': {live: 'runtime/local-voices.json', out: 'runtime/local-voices.picked-short.json', folder: 'omni-short', maxSeconds: 10, label: 'OmniVoice short'},
});
const LIVE_FILES = ['runtime/pocket-voices.json', 'runtime/local-voices.json'];

async function writeAtomic(path, bytes) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

// Build the plan and (unless dryRun) the files. Returns a report object; throws on anything invalid.
// outputs / source / picksLog let another builder (scripts/Build-AutobestConfigs.mjs) reuse this with its own output names.
export async function applyPicks({project, pick, pool, only = null, dryRun = false, validate = true, log = () => {}, now = new Date(), outputs = OUTPUTS,
  source = 'reference-picker (Apply-ReferencePicks.mjs)', picksLog = 'runtime/reference-picks.jsonl'}) {
  const live = {};
  for (const engine of Object.keys(outputs)) {
    const file = outputs[engine].live;
    live[file] ??= {text: await readFile(resolve(project, file), 'utf8')};
    live[file].json ??= JSON.parse(live[file].text.replace(/^\uFEFF/, ''));
    live[file].sha256 ??= sha256(live[file].text);
  }
  for (const {out} of Object.values(outputs)) {
    if (LIVE_FILES.some(file => resolve(project, file) === resolve(project, out))) throw Error('Refusing to write over a live config');
  }
  const report = {engines: {}, skipped: [], warnings: []};
  for (const [engine, spec] of Object.entries(outputs)) {
    const changed = [], entries = {};
    for (const [voice, row] of Object.entries(pick.voices)) {
      const kept = row.kept[engine];
      if (!kept || (only && !only.includes(voice))) continue;
      if (!pool.has(voice)) { report.skipped.push({voice, engine, reason: 'no such voice in the pool index'}); continue; }
      const ids = kept.clips;
      if (ids.length === 1 && ids[0].startsWith('live:')) { report.skipped.push({voice, engine, reason: "kept set is today's reference; nothing to change"}); continue; }
      const clips = pool.clips(voice, ids);
      const decoded = [];
      for (const clip of clips) decoded.push(await readWav(clip.path));
      const joined = concatClips(decoded), bytes = encodeWav(joined.samples, REFERENCE_RATE);
      const seconds = Math.round(joined.samples.length / REFERENCE_RATE * 100) / 100;
      if (seconds > spec.maxSeconds + 1e-6) throw Error(`${voice}: ${spec.label} reference is ${seconds} s, over its ${spec.maxSeconds} s limit`);
      const transcript = clips.map(clip => clip.t.trim()).join(' ');
      if (!transcript || transcript.length > 12_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(transcript)) throw Error(`${voice}: unusable joined transcript`);
      const reference = `runtime/voice-references/picked/${spec.folder}/${voice}.wav`;
      entries[voice] = {reference, sha256: sha256(bytes), transcript, transcriptSha256: sha256(transcript), status: 'ready',
        pick: {clips: ids, seconds, keptAt: kept.ts, note: kept.note || undefined}};
      changed.push({voice, clips: ids, seconds, reference, bytes});
    }
    if (!changed.length) { report.engines[engine] = {changed: [], output: null}; continue; }
    const base = live[spec.live].json, voices = {...base.voices};
    for (const [voice, entry] of Object.entries(entries)) {
      if (!Object.hasOwn(voices, voice)) throw Error(`${voice} is not in ${spec.live}`);
      voices[voice] = entry;
    }
    const config = {...base, voices, proposal: {status: 'PROPOSED - not active', source,
      based_on: spec.live.split('/').pop(), based_on_sha256: live[spec.live].sha256, engine: spec.label,
      picks_log: picksLog, picks_entries: pick.entries, voices_changed: changed.map(item => item.voice), generated: now.toISOString()}};
    if (!dryRun) {
      for (const item of changed) await writeAtomic(resolve(project, item.reference), item.bytes);
      await writeAtomic(resolve(project, spec.out), JSON.stringify(config, null, 2) + '\n');
    }
    report.engines[engine] = {output: spec.out, changed: changed.map(({bytes, ...rest}) => rest), config};
    log(`${spec.label}: ${changed.length} voice${changed.length === 1 ? '' : 's'} -> ${spec.out}${dryRun ? ' (dry run, nothing written)' : ''}`);
  }
  if (validate && !dryRun) report.validation = await validateOutputs({project, report, only, log, outputs});
  return report;
}

// The bridge's own loaders, both implementations, on the files just written. Picked voices must be available.
export async function validateOutputs({project, report, log = () => {}, outputs = OUTPUTS}) {
  const results = [];
  for (const [engine, spec] of Object.entries(outputs)) {
    const entry = report.engines[engine];
    if (!entry?.output) continue;
    const path = resolve(project, spec.out), config = JSON.parse(await readFile(path, 'utf8'));
    const picked = entry.changed.map(item => item.voice);
    const result = {engine, config: spec.out};
    // Node loaders (what the bridge process uses).
    if (engine.startsWith('pocket')) {
      const checked = validatePocketConfig(config);
      result.node = {voices: checked.registry.keys.length};
      for (const voice of picked) if (!checked.registry.has(voice)) throw Error(`Pocket loader rejected ${voice}`);
    } else {
      const registry = createVoiceProfileRegistry(config);
      result.node = {voices: registry.keys.length};
      for (const voice of picked) if (!registry.has(voice)) throw Error(`Omni registry rejected ${voice}`);
    }
    // Python loaders (what the worker processes use): file hash, WAV structure, 20 s Omni limit, transcript rules.
    const python = engine.startsWith('pocket') ? config.runtime.pythonExecutable : resolve(project, 'vendor/reference-voicestudio/.venv/Scripts/python.exe');
    const run = spawnSync(python, ['-B', resolve(project, 'scripts/reference-picker/validate-config.py'), engine.startsWith('pocket') ? 'pocket' : 'omni', path],
      {cwd: project, encoding: 'utf8', env: {...process.env, PYTHONUTF8: '1', CUDA_VISIBLE_DEVICES: '-1'}, timeout: 300_000});
    let python_result;
    try { python_result = JSON.parse(run.stdout.trim().split('\n').at(-1)); } catch { python_result = {ok: false, error: (run.stderr || run.stdout || 'no output').slice(-400)}; }
    if (!python_result.ok) throw Error(`The bridge's Python loader rejected ${spec.out}: ${python_result.error}`);
    const unavailable = picked.filter(voice => python_result.unavailable?.[voice] || !python_result.ready.includes(voice));
    if (unavailable.length) throw Error(`The bridge's Python loader marks ${unavailable.join(', ')} unavailable in ${spec.out}`);
    result.python = {ready: python_result.ready.length, unavailable: Object.keys(python_result.unavailable ?? {}).length,
      pickedSeconds: Object.fromEntries(picked.map(voice => [voice, python_result.referenceSeconds?.[voice] ?? null]))};
    results.push(result);
    log(`validated ${spec.out}: Node loader ${result.node.voices} voices, Python loader ${result.python.ready} ready; picked voices ok`);
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, at, all) => {
    if (token.startsWith('--')) pairs.push([token.slice(2), all[at + 1] === undefined || all[at + 1].startsWith('--') ? true : all[at + 1]]);
    return pairs;
  }, []));
  const work = resolve(args.work ?? 'E:/CyberpunkConvai-offload/work/reference-picker');
  const logPath = resolve(project, args.picks ?? 'runtime/reference-picks.jsonl');
  const pick = await readPicks(logPath);
  const kept = Object.entries(pick.voices).flatMap(([voice, row]) => Object.keys(row.kept).map(engine => `${voice}/${engine}`));
  if (!kept.length) { console.log(`Nothing is kept yet in ${logPath}. Open the picker and press "Keep" on a set first.`); process.exit(0); }
  const pool = new Pool(await loadIndex(typeof args.index === 'string' ? resolve(args.index) : ensureIndex({project, work, log: console.log})), {project});
  console.log(`${pick.entries} logged actions; kept: ${kept.join(', ')}`);
  const report = await applyPicks({project, pick, pool, only: typeof args.only === 'string' ? args.only.split(',') : null,
    dryRun: !!args['dry-run'], validate: !args['no-validate'], log: console.log});
  for (const skipped of report.skipped) console.log(`skipped ${skipped.voice} (${skipped.engine}): ${skipped.reason}`);
  const summary = {engines: Object.fromEntries(Object.entries(report.engines).map(([engine, entry]) => [engine, {output: entry.output,
    voices: entry.changed.map(item => ({voice: item.voice, seconds: item.seconds, reference: item.reference}))}])), validation: report.validation};
  console.log(JSON.stringify(summary, null, 2));
  console.log('Live configs were not changed. To try a picked config, copy it over the live file in a separate, approved step.');
}
