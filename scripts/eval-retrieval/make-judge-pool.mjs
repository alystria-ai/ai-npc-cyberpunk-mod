// Pools the top results of every system per query (so no system's own ranking decides the gold alone) and writes anonymised
// judge input files for a blind relevance judge.   node scripts/eval-retrieval/make-judge-pool.mjs [--tag main] [--depth 8] [--parts 2]
//   local/judge-<tag>-<n>.json   [{qid, speaker, query, candidates: [{cid, text}]}]  shuffled, no system names, no store names
//   local/judge-<tag>-map.json   {qid: {cid: itemId}}
import {join} from 'node:path';
import {localDir, readJson, writeJson, here} from './lib.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const tag = arg('tag', 'main'), depth = Number(arg('depth', 8)), parts = Number(arg('parts', 2));
const items = new Map(readJson(arg('items', join(here, 'data/items.json'))).map(item => [item.id, item]));
const queries = readJson(arg('queries', join(here, 'data/queries.json')));
const rankings = readJson(join(localDir, `rankings-${tag}.json`));
let state = 7;
const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };

const rows = [], map = {};
for (const q of queries) {
  const ids = new Set(q.gold);
  for (const system of Object.values(rankings)) for (const row of (system[q.id] ?? []).slice(0, depth)) ids.add(row.id);
  const list = [...ids].sort(() => random() - 0.5);
  map[q.id] = {};
  const candidates = list.map((id, index) => { const cid = 'c' + (index + 1); map[q.id][cid] = id; return {cid, text: items.get(id).text}; });
  rows.push({qid: q.id, speaker: q.speaker, query: q.text, candidates});
}
const size = Math.ceil(rows.length / parts);
for (let part = 0; part < parts; part++) writeJson(join(localDir, `judge-${tag}-${part + 1}.json`), rows.slice(part * size, (part + 1) * size));
writeJson(join(localDir, `judge-${tag}-map.json`), map);
console.log(rows.length, 'queries,', rows.reduce((sum, row) => sum + row.candidates.length, 0), 'candidate pairs');
