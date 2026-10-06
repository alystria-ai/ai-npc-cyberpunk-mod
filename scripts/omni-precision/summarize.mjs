// Pool Measure-OmniPrecision.mjs results by variant (precision + graph/eager + steps) and print a table.
//   node scripts/omni-precision/summarize.mjs [results dir]
// Every result file is one measurement block (one worker process). Blocks of a variant are pooled; the per-block
// medians are listed too, because a shared laptop GPU drifts between blocks (other jobs, boost clocks).
import {readFileSync, readdirSync} from 'node:fs';
const dir = process.argv[2] ?? 'E:/CyberpunkConvai-offload/work/omni-precision/results';
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const p90 = a => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(.9 * s.length) - 1)]; };
const groups = {};
for (const file of readdirSync(dir).filter(x => x.endsWith('.json'))) {
  const r = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
  if (r.error && !r.runs.length) { (groups[`${r.precision} s${r.steps} ${r.graph === '0' ? 'eager' : 'graph'}`] ??= {blocks: [], errors: []}).errors.push(r.error); continue; }
  const key = `${r.precision} s${r.steps} ${r.graph === '0' ? 'eager' : 'graph'}`;
  (groups[key] ??= {blocks: [], errors: []}).blocks.push(r);
  if (r.error) groups[key].errors.push(r.error);
}
const f = (x, d = 0) => x == null || Number.isNaN(x) ? '-' : x.toFixed(d);
const rows = [];
for (const [key, g] of Object.entries(groups).sort()) {
  const runs = g.blocks.flatMap(b => b.runs), short = runs.filter(r => r.length === 'short'), long = runs.filter(r => r.length === 'long');
  const gen = runs.reduce((a, r) => a + r.totalGenMs, 0) / 1000, audio = runs.reduce((a, r) => a + r.totalAudioSec, 0);
  const graph = g.blocks.map(b => b.afterQuality?.cudaGraph ?? b.afterRuns?.cudaGraph).filter(Boolean)[0];
  const phrases = runs.flatMap(r => r.graphs ?? []).filter(Boolean);
  rows.push({key, blocks: g.blocks.length, n: runs.length,
    short: short.length ? `${f(median(short.map(r => r.firstAudioMs)))} / ${f(p90(short.map(r => r.firstAudioMs)))}` : '-',
    long: long.length ? `${f(median(long.map(r => r.firstAudioMs)))} / ${f(p90(long.map(r => r.firstAudioMs)))}` : '-',
    blockMedians: g.blocks.map(b => f(median(b.runs.map(r => r.firstAudioMs)))).join(', '),
    rtf: runs.length ? `${f(median(runs.map(r => r.rtf)), 3)} (pooled ${f(gen / audio, 3)})` : '-',
    peak: g.blocks.map(b => b.afterQuality?.cudaPeakReservedMiB ?? b.afterRuns?.cudaPeakReservedMiB).filter(Number.isFinite).map(x => f(x)).join(', '),
    graph: graph ? `${graph.mode}; replays ${phrases.reduce((a, p) => a + p.replays, 0)}, eager-fallback phrases ${phrases.filter(p => p.fallbacks > 0).length}/${phrases.length}${graph.disabledReason ? '; ' + graph.disabledReason : ''}` : 'eager',
    errors: [...new Set(g.errors)].join('; ')});
}
console.log('variant | blocks | requests | first audio short med/p90 ms | long med/p90 ms | per-block medians | RTF | peak torch reserved MiB (per block) | graph | errors');
for (const r of rows) console.log([r.key, r.blocks, r.n, r.short, r.long, r.blockMedians, r.rtf, r.peak, r.graph, r.errors].join(' | '));
