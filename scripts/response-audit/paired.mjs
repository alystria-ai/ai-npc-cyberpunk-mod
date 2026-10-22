// Latency of a candidate against a baseline run, paired by scenario and sample: the median of ms(candidate) / ms(base) over the scenarios both runs answered, with the 25th and 75th percentile
// of that ratio, and the same for the time of the first word and the prompt tokens. Runs made back to back in one power mode only (the machine's mode moves every number).
//   node scripts/response-audit/paired.mjs base-label=candidate-label [base2=cand2 ...]    (labels of runs in the audit data folder; several pairs are pooled when joined with +)
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {dataDir} from './lib.mjs';

const q = (list, p) => list.length ? [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(p * list.length))] : null;
const load = async label => JSON.parse(await readFile(resolve(dataDir, `${label}.json`), 'utf8')).results.filter(r => !r.error);
const rows = [];
for (const arg of process.argv.slice(2)) {
  const ratios = {ms: [], head: [], tokens: []};
  let medianBase = [], medianCandidate = [];
  for (const pair of arg.split('+')) {
    const [baseLabel, candidateLabel] = pair.split('=');
    const base = new Map((await load(baseLabel)).map(r => [`${r.id}#${r.sample}`, r])), candidate = await load(candidateLabel);
    for (const r of candidate) {
      const b = base.get(`${r.id}#${r.sample}`);
      if (!b) continue;
      if (b.ms > 0 && r.ms > 0) { ratios.ms.push(r.ms / b.ms); medianBase.push(b.ms); medianCandidate.push(r.ms); }
      if (b.headMs > 0 && r.headMs > 0) ratios.head.push(r.headMs / b.headMs);
      if (b.promptTokens > 0 && r.promptTokens > 0) ratios.tokens.push(r.promptTokens / b.promptTokens);
    }
  }
  const f = list => list.length ? `${q(list, 0.5).toFixed(2)} (${q(list, 0.25).toFixed(2)}-${q(list, 0.75).toFixed(2)})` : '-';
  rows.push({pair: arg, n: ratios.ms.length, 'p50 base ms': q(medianBase, 0.5), 'p50 candidate ms': q(medianCandidate, 0.5), 'ms ratio': f(ratios.ms), 'first word ratio': f(ratios.head), 'prompt tokens ratio': f(ratios.tokens)});
}
console.table(rows);
