// Two checks on top of score.mjs (run it first): paired bootstrap intervals for the differences against the mod's embedder, and how well a
// top-1 cosine threshold (the mod uses 0.40) separates small talk from real questions.
//   node scripts/eval-retrieval/analyze.mjs [--tag main]
import {join} from 'node:path';
import {localDir, readJson, here, metrics} from './lib.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const tag = arg('tag', 'main');
const queries = readJson(join(here, 'data/queries.json'));
const rankings = readJson(join(localDir, `rankings-${tag}.json`));
const {gold} = readJson(join(localDir, `scores-${tag}.json`));
const withGold = queries.filter(q => q.category !== 'smalltalk' && gold[q.id].length);

let state = 99;
const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
const per = (system, key) => withGold.map(q => metrics(rankings[system][q.id], new Set(gold[q.id]), 5)[key]);
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
function diff(system, base, key) {
  const a = per(system, key), b = per(base, key), d = a.map((value, i) => value - b[i]);
  const boots = [];
  for (let r = 0; r < 2000; r++) { let sum = 0; for (let i = 0; i < d.length; i++) sum += d[Math.floor(random() * d.length)]; boots.push(sum / d.length); }
  boots.sort((x, y) => x - y);
  return {mean: mean(d), lo: boots[50], hi: boots[1949]};
}
console.log('Paired difference to granite (the mod today), 95% bootstrap interval over the 44 non-small-talk queries');
console.log('| system | recall@5 diff | MRR diff | hit@1 diff |\n|---|---|---|---|');
for (const system of Object.keys(rankings)) {
  if (system === 'granite') continue;
  const cell = key => { const r = diff(system, 'granite', key); return `${r.mean >= 0 ? '+' : ''}${r.mean.toFixed(3)} (${r.lo.toFixed(3)} to ${r.hi.toFixed(3)})`; };
  console.log(`| ${system} | ${cell('recall')} | ${cell('rr')} | ${cell('hit1')} |`);
}

// Threshold check, cosine systems only: top-1 score of small talk against top-1 score of questions that do have a fitting item.
console.log('\nTop-1 score of small talk (8) against questions with a fitting item (44), and how the mod\'s 0.40 cut-off behaves');
console.log('| system | small talk median | question median | small talk above 0.40 | questions above 0.40 | best cut-off accuracy |\n|---|---|---|---|---|---|');
const talk = queries.filter(q => q.category === 'smalltalk'), asks = queries.filter(q => q.category !== 'smalltalk');
const med = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const system of ['granite', 'embgemma', 'cohere-pro', 'cohere-fast']) {
  const t = talk.map(q => rankings[system][q.id][0].score), a = asks.map(q => rankings[system][q.id][0].score);
  const above = (values, cut) => values.filter(v => v >= cut).length;
  let best = {cut: 0, accuracy: 0};
  for (const cut of [...t, ...a]) { const accuracy = (above(a, cut) + (t.length - above(t, cut))) / (t.length + a.length); if (accuracy > best.accuracy) best = {cut, accuracy}; }
  console.log(`| ${system} | ${med(t).toFixed(3)} | ${med(a).toFixed(3)} | ${above(t, 0.4)} of ${t.length} | ${above(a, 0.4)} of ${a.length} | ${(best.accuracy * 100).toFixed(0)}% at ${best.cut.toFixed(3)} |`);
}
