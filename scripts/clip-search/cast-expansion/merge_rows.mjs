// Put staged voice rows (staging/cast/<key>/voice-rows.json, written by build.py) into the three live voice configs that
// runtime/voice-configs.json names: pocket-voices.autobest.json, local-voices.autobest-short.json and
// local-voices.autobest-long.json (Voxtral reads the Omni long set first, then Pocket). One writer only: the lead of the cast
// expansion runs this, serially.  The three files are backed up first to runtime/backups/cast-expansion-<stamp>/.
//
// A key that already has a ready entry is refused unless it is listed in --replace (the weak-voice fixes).  Afterwards the
// bridge's own loaders validate all three files: the Node Pocket validator and Omni registry, and the Python Pocket loader.
//
//   node scripts/clip-search/cast-expansion/merge_rows.mjs --keys bryce-mosley,dum-dum [--replace life-coach] [--dry-run]
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validatePocketConfig} from '../../../bridge/pocket-voice.mjs';
import {createVoiceProfileRegistry} from '../../../bridge/voice-profile-registry.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const runtime = resolve(repo, 'runtime');
const args = process.argv.slice(2);
const list = flag => (args.includes(flag) ? args[args.indexOf(flag) + 1].split(',').filter(Boolean) : []);
const keys = list('--keys'), replace = new Set(list('--replace')), dryRun = args.includes('--dry-run');
const all = [...new Set([...keys, ...replace])];
if (!all.length) throw Error('--keys a,b,c required');
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const files = {'omni-short': 'local-voices.autobest-short.json', 'omni-long': 'local-voices.autobest-long.json', pocket: 'pocket-voices.autobest.json'};

const staged = new Map();
for (const key of all) {
  const rows = readJson(resolve(repo, 'staging/cast', key, 'voice-rows.json'));
  if (rows.key !== key) throw Error(`staged rows name ${rows.key}, not ${key}`);
  for (const [kind, row] of Object.entries(rows.rows)) {
    const wav = resolve(repo, row.reference);
    if (!existsSync(wav) || sha(wav) !== row.sha256) throw Error(`${key} ${kind}: reference missing or changed since build`);
    if (createHash('sha256').update(row.transcript, 'utf8').digest('hex') !== row.transcriptSha256) throw Error(`${key} ${kind}: transcript hash`);
  }
  if (Object.keys(rows.rows).sort().join() !== Object.keys(files).sort().join()) throw Error(`${key}: needs exactly ${Object.keys(files)}`);
  staged.set(key, rows.rows);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = resolve(runtime, 'backups', `cast-expansion-${stamp}`);
if (!dryRun) mkdirSync(backup, {recursive: true});
for (const [kind, name] of Object.entries(files)) {
  const path = resolve(runtime, name);
  const raw = readFileSync(path, 'utf8');
  const config = JSON.parse(raw.replace(/^﻿/, ''));
  for (const [key, rows] of staged) {
    const before = config.voices[key];
    if (before && before.status === 'ready' && !replace.has(key)) throw Error(`${name}: ${key} already has a ready entry (use --replace)`);
    config.voices[key] = rows[kind];
  }
  console.log(`${name}: ${staged.size} rows -> ${Object.keys(config.voices).length} voices${dryRun ? ' (dry run)' : ''}`);
  if (!dryRun) {
    writeFileSync(resolve(backup, name), raw);
    writeFileSync(path + '.part', JSON.stringify(config, null, 2) + '\n');
    renameSync(path + '.part', path);
  }
}
if (!dryRun) {
  console.log('backup:', backup);
  const pocket = readJson(resolve(runtime, files.pocket));
  validatePocketConfig(pocket);
  for (const kind of ['omni-short', 'omni-long']) {
    const registry = createVoiceProfileRegistry(readJson(resolve(runtime, files[kind])));
    console.log(`node: ${files[kind]} registry ok`, typeof registry?.size === 'number' ? registry.size : '');
  }
  const check = spawnSync(pocket.runtime.pythonExecutable, ['-B', '-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(resolve(repo, 'bridge'))})
from pocket_voice_runtime import validate_config
registry = validate_config(json.load(open(${JSON.stringify(resolve(runtime, files.pocket))}, encoding='utf-8-sig')))
print('python: Pocket config valid;', len(registry['refs']), 'voices ready,', len(registry['unavailable']), 'unavailable')`], {encoding: 'utf8'});
  process.stdout.write(check.stdout + check.stderr);
  if (check.status !== 0) process.exit(1);
}
