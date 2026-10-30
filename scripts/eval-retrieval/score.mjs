// Scores every system: recall@5, hit@5, hit@1, MRR over the queries that have gold, latency, and the small-talk false-injection rate.
//   node scripts/eval-retrieval/score.mjs [--tag main]
// Gold = the item each query was written from plus every pooled candidate the blind judge rated 2 (local/judge-<tag>-out-<n>.json:
// {qid: {cid: 0|1|2}}).   Prints a markdown table and writes local/scores-<tag>.json.
import {existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {localDir, readJson, writeJson, here, metrics, median, percentile} from './lib.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const tag = arg('tag', 'main');
const queries = readJson(arg('queries', join(here, 'data/queries.json')));
const items = new Map(readJson(arg('items', join(here, 'data/items.json'))).map(item => [item.id, item]));
const rankings = readJson(join(localDir, `rankings-${tag}.json`));
const latency = readJson(join(localDir, `latency-${tag}.json`));
const map = readJson(join(localDir, `judge-${tag}-map.json`));
const judged = {};
for (const name of readdirSync(localDir).filter(name => name.startsWith(`judge-${tag}-out-`))) Object.assign(judged, readJson(join(localDir, name)));

const grades = {};   // qid -> Map itemId -> 0|1|2
for (const q of queries) {
  grades[q.id] = new Map(q.gold.map(id => [id, 2]));
  for (const [cid, grade] of Object.entries(judged[q.id] ?? {})) {
    const id = map[q.id]?.[cid];
    if (id && !(grades[q.id].get(id) === 2)) grades[q.id].set(id, Number(grade));
  }
}
const goldOf = q => new Set([...grades[q.id]].filter(([, grade]) => grade === 2).map(([id]) => id));
// Small talk is scored apart (below): the blind judge rated 4 to 9 pooled items as relevant to a line like "how are you", which says more about the judge than about retrieval.
const withGold = queries.filter(q => q.category !== 'smalltalk' && goldOf(q).size > 0);
const smalltalk = queries.filter(q => q.category === 'smalltalk');

const ndcg = (ranked, q, k = 5) => {
  const gain = grade => (2 ** grade - 1);
  const dcg = ranked.slice(0, k).reduce((sum, row, i) => sum + gain(grades[q.id].get(row.id) ?? 0) / Math.log2(i + 2), 0);
  const ideal = [...grades[q.id].values()].sort((a, b) => b - a).slice(0, k).reduce((sum, grade, i) => sum + gain(grade) / Math.log2(i + 2), 0);
  return ideal ? dcg / ideal : 0;
};
const mean = values => values.reduce((a, b) => a + b, 0) / (values.length || 1);
const rows = {};
for (const [system, byQuery] of Object.entries(rankings)) {
  const per = withGold.map(q => ({q, m: metrics(byQuery[q.id] ?? [], goldOf(q), 5), n: ndcg(byQuery[q.id] ?? [], q)}));
  const slice = category => per.filter(row => row.q.category === category);
  const lat = Object.values(latency[system] ?? {});
  rows[system] = {
    recall5: mean(per.map(row => row.m.recall)), hit5: mean(per.map(row => row.m.hit)), hit1: mean(per.map(row => row.m.hit1)),
    mrr: mean(per.map(row => row.m.rr)), ndcg5: mean(per.map(row => row.n)),
    byCategory: Object.fromEntries(['memory', 'fact', 'story', 'quest', 'place'].map(category => [category, +mean(slice(category).map(row => row.m.recall)).toFixed(3)])),
    latencyMedianMs: lat.length ? Math.round(median(lat)) : null, latencyP90Ms: lat.length ? Math.round(percentile(lat, 0.9)) : null,
    queries: per.length,
  };
}
// Small talk: how often would the top result be injected anyway? Reported with the score of that top result, for choosing a threshold.
const talk = {};
for (const [system, byQuery] of Object.entries(rankings))
  talk[system] = smalltalk.map(q => byQuery[q.id]?.[0]?.score ?? null);
const fmt = (value, digits = 3) => value === null || value === undefined ? '-' : (+value).toFixed(digits);
console.log(`scored queries: ${withGold.length}, small talk set aside: ${smalltalk.length}, mean gold per query: ${fmt(mean(withGold.map(q => goldOf(q).size)), 2)}`);
console.log('| system | recall@5 | hit@1 | hit@5 | MRR | nDCG@5 | memory | fact | story | quest | place | median ms | p90 ms |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const [system, r] of Object.entries(rows))
  console.log(`| ${system} | ${fmt(r.recall5)} | ${fmt(r.hit1)} | ${fmt(r.hit5)} | ${fmt(r.mrr)} | ${fmt(r.ndcg5)} | ${['memory', 'fact', 'story', 'quest', 'place'].map(c => fmt(r.byCategory[c])).join(' | ')} | ${r.latencyMedianMs ?? '-'} | ${r.latencyP90Ms ?? '-'} |`);
writeJson(join(localDir, `scores-${tag}.json`), {rows, talk, gold: Object.fromEntries(queries.map(q => [q.id, [...goldOf(q)]]))});
console.log('\nsmall talk top-1 scores by system (median):', Object.fromEntries(Object.entries(talk).map(([s, v]) => [s, fmt(median(v.filter(x => x !== null)))])));
