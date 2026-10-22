// A compact before / after table from the judges' files of a sheet set: per run the share of replies with a fault (and the 95% interval), the share per fault, the mean score,
// and the difference to the first run with a two-proportion z value (|z| above 2 is about 95%). Latency and tokens are shown when the run file has them.
//   node scripts/response-audit/compare.mjs --name m8b-r1 [--runs a,b,c] [--merge "before=run-a,run-b"]  (the first run listed is the reference)
import {readFile, readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {DIMENSIONS, FLAGS} from './rubric.mjs';
import {dataDir} from './lib.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
// --name takes one sheet set or several (comma separated): the judged items of all of them are pooled by run label.
const names = option('name', 'base').split(',').filter(Boolean);
const merge = Object.fromEntries(option('merge', '').split(';').filter(Boolean).flatMap(entry => { const [label, list] = entry.split('='); return list.split(',').map(run => [run, label]); }));
const labelOf = run => merge[run] ?? run;
const load = async prefix => {
  const rows = [];
  for (const name of names) {
  const dir = resolve(dataDir, 'sheets', name);
  const key = JSON.parse(await readFile(resolve(dir, 'key.json'), 'utf8'));
  for (const file of (await readdir(dir)).filter(f => f.startsWith(`${prefix}-`) && /^[a-z]+-[0-9]+[.]json$/.test(f))) {
    let list; try { list = JSON.parse(await readFile(resolve(dir, file), 'utf8')); } catch (e) { console.error(`${file}: unreadable (${e.message})`); continue; }
    for (const row of list) if (key[String(row.item)]) rows.push({...row, ...key[String(row.item)], run: labelOf(key[String(row.item)].run)});
  }
  }
  return rows;
};
const scores = await load('scores'), flags = await load('flags');
const wanted = option('runs', '').split(',').filter(Boolean);
const labels = [...new Set([...flags, ...scores].map(r => r.run))].filter(l => !wanted.length || wanted.includes(l));
if (wanted.length) labels.sort((a, b) => wanted.indexOf(a) - wanted.indexOf(b));
const mean = list => list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
const wilson = (k, n) => { if (!n) return [0, 0]; const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - h) / d, (c + h) / d]; };
const zTest = (k1, n1, k2, n2) => { const p = (k1 + k2) / (n1 + n2), se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2)); return se ? (k2 / n2 - k1 / n1) / se : 0; };
const any = r => FLAGS.some(f => r[f] === true);
const runInfo = async label => {
  const parts = Object.entries(merge).filter(([, merged]) => merged === label).map(([run]) => run);
  const files = await Promise.all((parts.length ? parts : [label]).map(async part => JSON.parse(await readFile(resolve(dataDir, `${part}.json`), 'utf8'))));
  const results = files.flatMap(file => file.results).filter(r => !r.error);
  const q = (list, p) => list.length ? [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(p * list.length))] : null;
  const tokens = results.map(r => r.promptTokens).filter(Number.isFinite);
  return {p50: q(results.map(r => r.ms).filter(Number.isFinite), 0.5), tok: tokens.length ? Math.round(mean(tokens)) : null, words: mean(results.map(r => r.words).filter(Number.isFinite))};
};
const out = [];
let ref = null;
for (const label of labels) {
  const rows = flags.filter(r => r.run === label), mine = scores.filter(r => r.run === label);
  const k = rows.filter(any).length, n = rows.length, [lo, hi] = wilson(k, n);
  const entry = {run: label, n, any: `${Math.round(100 * k / Math.max(1, n))}% (${Math.round(100 * lo)}-${Math.round(100 * hi)})`,
    z: ref ? +zTest(ref.k, ref.n, k, n).toFixed(1) : '-', score: mean(mine.map(s => mean(DIMENSIONS.map(d => s[d]).filter(Number.isFinite)))), ...(await runInfo(label))};
  entry.score = entry.score === null ? '-' : +entry.score.toFixed(2);
  entry.words = entry.words === null ? '-' : +entry.words.toFixed(1);
  for (const f of FLAGS) entry[f] = `${Math.round(100 * rows.filter(r => r[f] === true).length / Math.max(1, n))}%`;
  out.push(entry);
  if (!ref) ref = {k, n};
}
console.table(out);
