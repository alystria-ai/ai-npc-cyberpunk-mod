// Merges the judges' scores with the run files: per run (provider/model) the mean of every dimension, the overall mean, the share of invented facts, the automatic checks,
// length and latency, and the lowest-scoring replies.
//   node scripts/response-audit/aggregate.mjs --name base [--runs a,b] [--worst 8] [--by group] [--md out.md]
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {DIMENSIONS, FLAGS} from './rubric.mjs';
import {SCENARIOS} from './scenarios.mjs';
import {dataDir} from './lib.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
const name = option('name', 'base'), worst = Number(option('worst', 8)), by = option('by', '');
const dir = resolve(dataDir, 'sheets', name);
const key = JSON.parse(await readFile(resolve(dir, 'key.json'), 'utf8'));
// --merge "before=run-a,run-b;after=run-c": runs that are one condition (a later add-on run of more scenarios) are reported as one.
const merge = Object.fromEntries(option('merge', '').split(';').filter(Boolean).flatMap(entry => { const [name, list] = entry.split('='); return list.split(',').map(run => [run, name]); }));
const labelOf = run => merge[run] ?? run;
const scores = [];
for (const file of (await readdir(dir)).filter(f => /^scores-\d+\.json$/.test(f))) {
  let list; try { list = JSON.parse(await readFile(resolve(dir, file), 'utf8')); } catch (e) { console.error(`${file}: unreadable (${e.message})`); continue; }
  for (const row of list) if (key[String(row.item)]) scores.push({...row, ...key[String(row.item)], run: labelOf(key[String(row.item)].run)});
}
const flagRows = [];
for (const file of (await readdir(dir)).filter(f => /^flags-\d+\.json$/.test(f))) {
  let list; try { list = JSON.parse(await readFile(resolve(dir, file), 'utf8')); } catch (e) { console.error(`${file}: unreadable (${e.message})`); continue; }
  for (const row of list) if (key[String(row.item)]) flagRows.push({...row, ...key[String(row.item)], run: labelOf(key[String(row.item)].run)});
}
const wanted = option('runs', '').split(',').filter(Boolean);
const labels = [...new Set(scores.map(s => s.run))].filter(l => !wanted.length || wanted.includes(l));
const cache = {};
const runOf = async label => {
  if (cache[label]) return cache[label];
  const parts = Object.entries(merge).filter(([, name]) => name === label).map(([run]) => run);
  const files = await Promise.all((parts.length ? parts : [label]).map(async part => JSON.parse(await readFile(resolve(dataDir, `${part}.json`), 'utf8'))));
  return cache[label] = {...files[0], results: files.flatMap(file => file.results), summary: {...files[0].summary, replies: files.reduce((a, file) => a + file.results.length, 0)}};
};
const mean = list => list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
const f = (v, d = 2) => v === null || v === undefined ? '-' : v.toFixed(d);

const table = [];
for (const label of labels) {
  const mine = scores.filter(s => s.run === label), run = await runOf(label);
  const rows = Object.fromEntries(run.results.map(r => [`${r.id}#${r.sample}`, r]));
  const dim = Object.fromEntries(DIMENSIONS.map(d => [d, mean(mine.map(s => s[d]).filter(v => Number.isFinite(v)))]));
  const overall = mean(mine.map(s => mean(DIMENSIONS.map(d => s[d]).filter(v => Number.isFinite(v)))));
  const problems = {};
  for (const s of mine) for (const p of rows[`${s.id}#${s.sample}`]?.problems ?? []) problems[p] = (problems[p] ?? 0) + 1;
  table.push({label, provider: run.provider, model: run.model, n: mine.length, overall, dim, invented: mine.filter(s => s.invented === true).length / Math.max(1, mine.length),
    words: mean(run.results.map(r => r.words).filter(Number.isFinite)), msP50: run.summary?.msP50, msP90: run.summary?.msP90, promptTokens: run.summary?.promptTokensMean, completionTokens: run.summary?.completionTokensMean, problems, mine, rows});
}

const lines = [];
lines.push(`| run | n | overall | ${DIMENSIONS.join(' | ')} | invented | words | p50 ms | prompt tok |`, `|---|---|---|${DIMENSIONS.map(() => '---').join('|')}|---|---|---|---|`);
for (const t of table) lines.push(`| ${t.label} (${t.model}) | ${t.n} | ${f(t.overall)} | ${DIMENSIONS.map(d => f(t.dim[d])).join(' | ')} | ${(100 * t.invented).toFixed(0)}% | ${f(t.words, 1)} | ${t.msP50 ?? '-'} | ${t.promptTokens ?? '-'} |`);
if (by) {
  lines.push('', `Overall mean by ${by}:`, '', `| ${by} | ${labels.join(' | ')} |`, `|---|${labels.map(() => '---').join('|')}|`);
  const groups = [...new Set(SCENARIOS.map(s => s[by]))];
  for (const g of groups) lines.push(`| ${g} | ${table.map(t => { const m = t.mine.filter(s => SCENARIOS.find(x => x.id === s.id)?.[by] === g); return m.length ? f(mean(m.map(s => mean(DIMENSIONS.map(d => s[d]).filter(Number.isFinite))))) : '-'; }).join(' | ')} |`);
}
if (flagRows.length) {
  const flagged = labels.map(label => ({label, rows: flagRows.filter(r => r.run === label)}));
  lines.push('', 'Fault flags (share of replies with the fault, from the yes/no judge):', '', `| run | n | any fault | ${FLAGS.join(' | ')} |`, `|---|---|---|${FLAGS.map(() => '---').join('|')}|`);
  for (const {label, rows} of flagged) lines.push(`| ${label} | ${rows.length} | ${(100 * rows.filter(r => FLAGS.some(f => r[f] === true)).length / Math.max(1, rows.length)).toFixed(0)}% | ${FLAGS.map(f => `${(100 * rows.filter(r => r[f] === true).length / Math.max(1, rows.length)).toFixed(0)}%`).join(' | ')} |`);
  const all = flagRows.filter(r => labels.includes(r.run));
  lines.push(`| all | ${all.length} | ${(100 * all.filter(r => FLAGS.some(f => r[f] === true)).length / Math.max(1, all.length)).toFixed(0)}% | ${FLAGS.map(f => `${(100 * all.filter(r => r[f] === true).length / Math.max(1, all.length)).toFixed(0)}%`).join(' | ')} |`);
  lines.push('', 'Faults per scenario (all runs, replies with any fault / replies):');
  const byScn = {};
  for (const r of all) { const e = byScn[r.id] ??= {n: 0, any: 0, f: {}}; e.n++; if (FLAGS.some(f => r[f] === true)) e.any++; for (const f of FLAGS) if (r[f] === true) e.f[f] = (e.f[f] ?? 0) + 1; }
  for (const [id, e] of Object.entries(byScn).sort((a, b) => b[1].any / b[1].n - a[1].any / a[1].n)) lines.push(`- ${id}: ${e.any}/${e.n} (${Object.entries(e.f).map(([f, c]) => `${f} ${c}`).join(', ')})`);
  table.forEach(t => { t.flags = Object.fromEntries(FLAGS.map(f => [f, flagRows.filter(r => r.run === t.label && r[f] === true).length / Math.max(1, flagRows.filter(r => r.run === t.label).length)])); });
}
lines.push('', 'Automatic checks (count of replies with the problem):');
for (const t of table) lines.push(`- ${t.label}: ${Object.entries(t.problems).map(([p, c]) => `${p} ${c}`).join(', ') || 'none'}`);
for (const t of table) {
  lines.push('', `Lowest-scoring replies of ${t.label}:`);
  const ranked = t.mine.map(s => ({s, score: mean(DIMENSIONS.map(d => s[d]).filter(Number.isFinite))})).sort((a, b) => a.score - b.score).slice(0, worst);
  for (const {s, score} of ranked) lines.push(`- ${s.id} (${f(score, 1)}): "${(t.rows[`${s.id}#${s.sample}`]?.spoken ?? '').slice(0, 160)}" | ${s.note ?? ''}`);
}
const text = lines.join('\n');
console.log(text);
if (option('md', '')) await writeFile(option('md', ''), text);
await writeFile(resolve(dir, 'aggregate.json'), JSON.stringify(table.map(({mine, rows, ...rest}) => rest), null, 1));
