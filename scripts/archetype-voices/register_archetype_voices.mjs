// Register the archetype voice references (build_archetype_voices.py) in the live voice configs.
//
//   node scripts/archetype-voices/register_archetype_voices.mjs [--dry-run] [--no-python] [--replace KEY,KEY]
//
// ADDS the entries of keys that are not registered yet to
//   runtime/pocket-voices.json                     <- pocket reference
//   runtime/local-voices.json                      <- omni-long reference
//   every config listed in runtime/voice-configs.json (pocket, omni.short -> omni-short, omni.long -> omni-long)
// from runtime/voice-references/archetypes/manifest.json.  The keys are the archetypes of characters/archetypes.json, the generic residents
// (`residentVoices`: resident-male / resident-female) and their extra voices `<key>-v2` .. `-v4` that are ready in the manifest.
// Unprepared base keys get {"status":"unprepared"} (the bridge then uses the Convai cloud voice); an unbuilt variant is simply not registered.
// A key that is already registered is left exactly as it is (byte for byte, `pick.keptAt` included), except an "unprepared" entry whose
// key is now ready, and the keys named with --replace (a rebuilt reference).  Every other key is kept as it is; the file is re-serialised with the same 2-space JSON and the same line endings
// (it refuses to write if re-serialising the untouched file would not reproduce it byte for byte).  Originals are copied to
// runtime/backups/archetype-voices-<timestamp>/ first, files are replaced atomically, and the result is checked with the bridge's own
// loaders (createVoiceProfileRegistry / validatePocketConfig, plus validate_config of resident-voice-worker.py and pocket_voice_runtime.py
// through scripts/reference-picker/validate-config.py).  A failed check restores the backups.  startupProfiles are never touched.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {basename, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createVoiceProfileRegistry} from '../../bridge/voice-profile-registry.mjs';
import {validatePocketConfig} from '../../bridge/pocket-voice.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const args = new Set(argv);
const dryRun = args.has('--dry-run'), skipPython = args.has('--no-python');
const replaceAt = argv.indexOf('--replace');
const replaceKeys = new Set(replaceAt >= 0 ? (argv[replaceAt + 1] ?? '').split(',').filter(Boolean) : []);
const sha256 = value => createHash('sha256').update(value).digest('hex');

const readJson = async path => {
  const text = await readFile(path, 'utf8');
  const bom = text.charCodeAt(0) === 0xFEFF, crlf = text.includes('\r\n');
  const body = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  return {text, bom, crlf, json: JSON.parse(body)};
};
const serialise = (json, {bom, crlf}) => {
  let out = JSON.stringify(json, null, 2) + '\n';
  if (crlf) out = out.replace(/\n/g, '\r\n');
  return (bom ? '﻿' : '') + out;
};

const manifest = JSON.parse((await readFile(resolve(project, 'runtime/voice-references/archetypes/manifest.json'), 'utf8')).replace(/^﻿/, ''));
const catalogue = JSON.parse(await readFile(resolve(project, 'characters/archetypes.json'), 'utf8'));
const baseKeys = [...catalogue.archetypes, ...(catalogue.residentVoices ?? [])].map(item => item.key);
const missing = baseKeys.filter(key => !manifest.voices[key]);
if (missing.length) throw Error(`manifest.json lacks ${missing.join(', ')}`);
// extra voices: `<base>-v2` .. `-v4`, only when the base itself is ready and the variant was built
const variants = [];
for (let level = 2; level <= 4; level++) for (const base of baseKeys) {
  const key = `${base}-v${level}`;
  if (manifest.voices[base].status === 'ready' && manifest.voices[key]?.status === 'ready') variants.push(key);
}
const archetypes = [...baseKeys, ...variants];
for (const key of replaceKeys) if (!archetypes.includes(key)) throw Error(`--replace ${key}: not a registrable key`);

// engine of a config file: which reference it takes
const configs = JSON.parse(await readFile(resolve(project, 'runtime/voice-configs.json'), 'utf8').then(text => text.replace(/^﻿/, '')));
const targets = [
  {file: 'runtime/pocket-voices.json', engine: 'pocket', kind: 'pocket'},
  {file: 'runtime/local-voices.json', engine: 'omni-long', kind: 'omni'},
  {file: `runtime/${configs.pocket}`, engine: 'pocket', kind: 'pocket'},
  {file: `runtime/${configs.omni.short}`, engine: 'omni-short', kind: 'omni'},
  {file: `runtime/${configs.omni.long}`, engine: 'omni-long', kind: 'omni'},
];

const keptAt = new Date().toISOString();
function entryFor(key, engine) {
  const item = manifest.voices[key];
  if (item.status !== 'ready') return {status: 'unprepared'};
  const ref = item.references[engine];
  if (!ref) throw Error(`${key} has no ${engine} reference`);
  return {reference: ref.path, sha256: ref.sha256, transcript: ref.transcript, transcriptSha256: sha256(ref.transcript), status: 'ready',
    pick: {clips: ref.clips.map(sid => `${item.voiceset}/${sid}`), seconds: ref.seconds, keptAt,
      note: `archetype reference: ${item.voiceset}, ${ref.clips.length} clips`}};
}

const plans = [];
for (const target of targets) {
  const path = resolve(project, target.file), current = await readJson(path);
  if (serialise(current.json, current) !== current.text) throw Error(`${target.file}: re-serialising does not reproduce the file; refusing to touch it`);
  const voices = {...current.json.voices};
  const added = [], replaced = [], kept = [];
  for (const key of archetypes) {
    const existing = voices[key], entry = entryFor(key, target.engine);
    if (!existing) { voices[key] = entry; added.push(key); }
    else if (replaceKeys.has(key) || (existing.status === 'unprepared' && entry.status === 'ready')) { voices[key] = entry; replaced.push(key); }
    else kept.push(key);
  }
  const json = {...current.json, voices};
  plans.push({...target, path, text: current.text, next: serialise(json, current), json, count: Object.keys(voices).length,
    before: Object.keys(current.json.voices).length, added, replaced, kept});
}
// Node loaders on the new content before anything is written.
for (const plan of plans) {
  if (plan.kind === 'pocket') validatePocketConfig(plan.json); else createVoiceProfileRegistry(plan.json);
  const startup = plan.json.preparation?.startupProfiles ?? [];
  if (startup.some(key => archetypes.includes(key))) throw Error(`${plan.file}: archetypes must not be startup profiles`);
}
for (const plan of plans) console.log(`${plan.file}: ${plan.before} -> ${plan.count} profiles (${plan.engine}); +${plan.added.length} added, ${plan.replaced.length} replaced (${plan.replaced.join(', ') || '-'}), ${plan.kept.length} already registered, left as they are`);
if (dryRun) { console.log('dry run: nothing written'); process.exit(0); }

const stamp = keptAt.replace(/[:.]/g, '-');
const backup = resolve(project, `runtime/backups/archetype-voices-${stamp}`);
await mkdir(backup, {recursive: true});
for (const plan of plans) await copyFile(plan.path, resolve(backup, basename(plan.path)));
console.log(`backups: ${backup}`);
for (const plan of plans) {
  const temporary = `${plan.path}.${process.pid}.tmp`;
  await writeFile(temporary, plan.next);
  await rename(temporary, plan.path);
}

// The bridge's own loaders on the files as written; restore the backups on any failure.
async function verify() {
  const report = [];
  for (const plan of plans) {
    const written = await readJson(plan.path);
    const registry = plan.kind === 'pocket' ? validatePocketConfig(written.json).registry : createVoiceProfileRegistry(written.json);
    const ready = archetypes.filter(key => manifest.voices[key].status === 'ready');
    for (const key of ready) if (!registry.has(key)) throw Error(`${plan.file}: Node loader rejected ${key}`);
    const row = {file: plan.file, node: registry.keys.length};
    if (!skipPython) {
      const python = plan.kind === 'pocket' ? written.json.runtime.pythonExecutable : resolve(project, 'vendor/reference-voicestudio/.venv/Scripts/python.exe');
      const run = spawnSync(python, ['-B', resolve(project, 'scripts/reference-picker/validate-config.py'), plan.kind, plan.path],
        {cwd: project, encoding: 'utf8', env: {...process.env, PYTHONUTF8: '1', CUDA_VISIBLE_DEVICES: '-1'}, timeout: 300_000, windowsHide: true});
      let result;
      try { result = JSON.parse(run.stdout.trim().split('\n').at(-1)); } catch { result = {ok: false, error: (run.stderr || run.stdout || 'no output').slice(-400)}; }
      if (!result.ok) throw Error(`${plan.file}: Python loader rejected the config: ${result.error}`);
      const bad = ready.filter(key => !result.ready.includes(key) || result.unavailable?.[key]);
      if (bad.length) throw Error(`${plan.file}: Python loader marks ${bad.join(', ')} unavailable`);
      row.python = {ready: result.ready.length, unavailable: Object.keys(result.unavailable ?? {}).length};
    }
    report.push(row);
  }
  return report;
}
try {
  for (const row of await verify()) console.log(`validated ${row.file}: Node ${row.node} profiles${row.python ? `, Python ${row.python.ready} ready / ${row.python.unavailable} unavailable` : ''}`);
} catch (error) {
  for (const plan of plans) await copyFile(resolve(backup, basename(plan.path)), plan.path);
  console.error(`validation failed, backups restored: ${error.message}`);
  process.exit(1);
}
