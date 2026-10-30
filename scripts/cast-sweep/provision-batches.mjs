// Convai originals and twins for the side characters (the minor roster rows of docs/CAST_SWEEP.md that can be invited), in batches.
//   node scripts/cast-sweep/provision-batches.mjs [--apply] [--size 40] [--limit N]
// Without --apply it prints the plan (how many keys still need an original and a twin) and calls nothing.
// With --apply it runs, per batch of --size keys, scripts/Provision-Characters.mjs --apply --only <keys> and then
// scripts/Create-MultilingualProfiles.mjs --apply --roster named --only <keys>. Both scripts adopt what exists, so an interrupted run is
// resumed by running this again: a key whose original id is in runtime/characters.json and whose twin is in runtime/multilingual-profiles.json
// is skipped, and a half-done batch finishes. It stops at the first failed batch (exit code 1). The key file is read by those scripts only
// (runtime/convai-key.txt, or CYBERPUNK_CONVAI_KEY_FILE); nothing here reads or prints it.
import {readFile, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const valueOf = (flag, fallback) => { const at = args.indexOf(flag); return at < 0 ? fallback : Number(args[at + 1]); };
const size = valueOf('--size', 40), limit = valueOf('--limit', Infinity);
const read = async (path, fallback) => {
  try { return JSON.parse((await readFile(resolve(root, path), 'utf8')).replace(/^﻿/u, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};
const roster = (await read('characters/roster.json')).filter(row => row.minor === true && row.invite !== false);
const state = async () => {
  const ids = await read('runtime/characters.json', {});
  const twins = (await read('runtime/multilingual-profiles.json', {characters: {}})).characters ?? {};
  return {
    needsOriginal: roster.filter(row => !ids[row.key]).map(row => row.key),
    needsTwin: roster.filter(row => !twins[row.key]?.multilingualCharacterId).map(row => row.key),
  };
};
const before = await state();
const todo = roster.map(row => row.key).filter(key => before.needsOriginal.includes(key) || before.needsTwin.includes(key)).slice(0, limit);
console.log(JSON.stringify({sideCharacters: roster.length, needOriginal: before.needsOriginal.length, needTwin: before.needsTwin.length, batches: Math.ceil(todo.length / size)}));
if (!apply) process.exit(0);
const run = (script, extra) => spawnSync(process.execPath, [resolve(root, 'scripts', script), '--apply', ...extra], {cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
for (let at = 0; at < todo.length; at += size) {
  const keys = todo.slice(at, at + size), started = Date.now();
  const now = await state();
  const originals = keys.filter(key => now.needsOriginal.includes(key));
  if (originals.length) {
    const result = run('Provision-Characters.mjs', ['--only', originals.join(',')]);
    if (result.status !== 0) { console.error(`Originals failed in the batch from ${keys[0]}: ${(result.stderr || result.stdout).split('\n').slice(-6).join(' | ')}`); process.exit(1); }
  }
  const after = await state();
  const twins = keys.filter(key => after.needsTwin.includes(key));
  if (twins.length) {
    const result = run('Create-MultilingualProfiles.mjs', ['--roster', 'named', '--only', twins.join(',')]);
    if (result.status !== 0) {
      // The full output (it holds no key) is kept for reading, the console gets the failures only.
      await writeFile(resolve(root, 'runtime/side-provision-last-twin-run.txt'), `${result.stdout}\n${result.stderr}`);
      const failures = /"failures": (\[[\s\S]*?\n {2}\])/u.exec(result.stdout)?.[1] ?? (result.stderr || result.stdout).split('\n').slice(-6).join(' | ');
      console.error(`Twins failed in the batch from ${keys[0]}: ${failures}`); process.exit(1);
    }
  }
  const done = await state();
  console.log(`Batch ${at / size + 1}: ${keys.length} keys (${keys[0]} to ${keys.at(-1)}), ${Math.round((Date.now() - started) / 1000)} s; still without an original ${done.needsOriginal.length}, without a twin ${done.needsTwin.length}`);
}
const final = await state();
console.log(JSON.stringify({finished: true, needOriginal: final.needsOriginal.length, needTwin: final.needsTwin.length}));
