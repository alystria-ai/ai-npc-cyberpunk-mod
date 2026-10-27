// node scripts/fresh-facts-eval/tabulate.mjs prepare <results.json> <items.json>   writes {id, kind, said, reply} for the judge
// node scripts/fresh-facts-eval/tabulate.mjs table <results.json> <labels.json>     prints the rate of each label per variant ("wrong" = the reply contradicts the fact)
import {readFileSync, writeFileSync} from 'node:fs';
const [mode, resultsPath, other] = process.argv.slice(2);
const {results, model, profile} = JSON.parse(readFileSync(resultsPath, 'utf8'));
if (mode === 'prepare') {
  writeFileSync(other, JSON.stringify(results.map((row, id) => ({id, kind: row.kind, said: row.text.replace(' (later)', ''), reply: row.reply})), null, 1));
  console.log(`${results.length} items`);
} else if (mode === 'table') {
  const labels = JSON.parse(readFileSync(other, 'utf8'));
  const get = id => labels[id] ?? labels[String(id)];
  const groups = new Map();
  results.forEach((row, id) => {
    const key = `${row.kind}|${row.variant}`, g = groups.get(key) ?? {n: 0, wrong: 0, acknowledges: 0, neutral: 0, unlabelled: 0, ms: 0, tok: row.promptTokens};
    const label = String(get(id) ?? '').toLowerCase();
    g.n++; g.ms += row.ms;
    if (label === 'wrong') g.wrong++; else if (label === 'acknowledges') g.acknowledges++; else if (label === 'neutral') g.neutral++; else g.unlabelled++;
    groups.set(key, g);
  });
  console.log(`${model.split(/[\/]/).pop()} (${profile})`);
  for (const [key, g] of groups) console.log(`${key.padEnd(30)} n=${g.n} wrong ${g.wrong} (${Math.round(100 * g.wrong / g.n)}%)  acknowledges ${g.acknowledges} (${Math.round(100 * g.acknowledges / g.n)}%)  neutral ${g.neutral}  ?${g.unlabelled}  avg ${Math.round(g.ms / g.n)} ms`);
}
