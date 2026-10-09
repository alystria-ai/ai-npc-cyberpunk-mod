// Reads a runtime/third-person-probe/<label>.json (scripts/Probe-ThirdPerson.mjs) and either
//   --export out.json   writes the replies a regex pre-screen flagged (a pronoun or the character's own name) as
//                       [{id, speaker, prompt, reply}] for a judge to label (--all: every reply, for prompts where another
//                       character's NAME alone can be the tell), or
//   --labels file.json  (a map {id: "self3" | "other" | "ok"}, written by the judge; ids are "<prefix>:<row>" with --prefix P)
//                       prints the third-person rate per condition and per character ("self3": the speaker describes herself in
//                       the third person or says "she" about someone unnamed; "other": about a named third party), plus the Expressive
//                       tag, voiced-sound and Follow-up (ends in a question) rates of the same rows.
// A reply the pre-screen did not flag has no pronoun and no own name, so it is counted as "ok".
//
//   node scripts/Summarize-ThirdPerson.mjs runtime/third-person-probe/before.json --export runtime/third-person-probe/before-judge.json
//   node scripts/Summarize-ThirdPerson.mjs runtime/third-person-probe/before.json --labels runtime/third-person-probe/before-labels.json
import {readFile, writeFile} from 'node:fs/promises';

const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const probe = JSON.parse(await readFile(args[0], 'utf8'));
const rows = probe.rows.map((row, id) => ({...row, id}));
if (option('--export')) {
  const flagged = rows.filter(row => !row.error && (args.includes('--all') || row.flag)).map(row => ({id: row.id, speaker: row.name, prompt: row.prompt, reply: row.reply}));
  await writeFile(option('--export'), JSON.stringify(flagged, null, 1) + '\n');
  console.log(JSON.stringify({rows: rows.length, errors: rows.filter(row => row.error).length, flagged: flagged.length}));
  process.exit(0);
}
const labels = JSON.parse(await readFile(option('--labels'), 'utf8'));
const pct = (a, b) => b ? `${Math.round(a / b * 1000) / 10}%` : '-';
const good = rows.filter(row => !row.error);
const prefix = option('--prefix');
const label = row => labels[prefix ? `${prefix}:${row.id}` : row.id] ?? 'ok';
const self3 = row => label(row) === 'self3', other = row => label(row) === 'other';
const table = (title, groups) => {
  console.log(`\n${title}`);
  for (const [name, group] of groups) {
    const n = group.length, bad = group.filter(self3).length, third = group.filter(other).length, voiced = group.filter(row => row.voiced).length, tagged = group.filter(row => row.startsTagged).length,
      anyTag = group.filter(row => row.tagged).length, ended = group.filter(row => row.endedQ).length;
    console.log(`${name.padEnd(22)} n=${String(n).padStart(3)}  self3=${String(bad).padStart(2)} (${pct(bad, n)}) other=${String(third).padStart(2)} (${pct(third, n)})  `
      + `voiced=${pct(voiced, n)} startsWithTag=${pct(tagged, n)} anyTag=${pct(anyTag, n)} endedQuestion=${pct(ended, n)}`);
  }
};
const by = key => [...new Set(good.map(row => row[key]))].map(value => [value, good.filter(row => row[key] === value)]);
table('By condition', by('condition'));
for (const condition of [...new Set(good.map(row => row.condition))])
  table(`Condition ${condition}, by character`, [...new Set(good.map(row => row.profile))].map(p => [p, good.filter(row => row.condition === condition && row.profile === p)]));
const bad = good.filter(self3);
console.log(`\nExamples of third-person replies (${bad.length} total, first 12):`);
for (const row of bad.slice(0, 12)) console.log(`- [${row.condition}/${row.profile}] ${row.prompt} -> ${row.reply}`);
