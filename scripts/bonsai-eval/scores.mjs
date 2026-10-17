import {readFile} from 'node:fs/promises';
const W = 'E:/CyberpunkConvai-offload/work/bonsai-eval/results/step1';
const key = JSON.parse(await readFile(`${W}/judge/key.json`, 'utf8'));
const rows = [];
for (const b of 'ABC') { const a = JSON.parse(await readFile(`${W}/judge/scores-${b}.json`, 'utf8')); console.log(b, a.length, new Set(a.map(x => x.id)).size); for (const s of a) rows.push({...s, ...key[s.id]}); }
const res = {}; for (const l of ['gemma4-e4b','q35-2b','bonsai2-9b','bonsai2-4b','bonsai2-2b']) { const d = JSON.parse(await readFile(`${W}/${l}.json`, 'utf8')); for (const r of d.results) res[`${l}|${r.layout}|${r.run}|${r.scenario}|${r.turn}`] = r; }
for (const r of rows) { const x = res[`${r.model}|stable|${r.run}|${r.scenario}|${r.turn}`]; r.kind = x.kind; r.reply = x.reply; r.flags = x.flags; }
const mean = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length) : NaN;
const f = x => Number.isNaN(x) ? '-' : x.toFixed(2);
const models = ['gemma4-e4b','q35-2b','bonsai2-9b','bonsai2-4b','bonsai2-2b'];
const crit = ['voice','context','grounded','identity','language','overall'];
console.log('\nmodel'.padEnd(16), crit.join('  '), ' n  invented-count');
for (const m of models) { const rs = rows.filter(r => r.model === m);
  console.log(m.padEnd(15), crit.map(c => f(mean(rs.map(r => r[c]).filter(v => typeof v === 'number'))).padStart(c.length)).join('  '), rs.length, rs.reduce((s, r) => s + (r.invented?.length ?? 0), 0)); }
console.log('\nrun1 vs run2 overall:'); for (const m of models) console.log(m.padEnd(15), [1,2].map(k => f(mean(rows.filter(r => r.model === m && r.run === k).map(r => r.overall)))).join('  '));
console.log('\noverall by kind:'); const kinds = ['ST','Q','M','P','E','C','ES','JA'];
console.log(''.padEnd(15), kinds.map(k => k.padStart(5)).join(' ')); for (const m of models) console.log(m.padEnd(15), kinds.map(k => f(mean(rows.filter(r => r.model === m && r.kind === k).map(r => r.overall))).padStart(5)).join(' '));
console.log('\noverall by scenario:'); const sc = ['judy','johnny','panam','jackie','resident','vendor'];
console.log(''.padEnd(15), sc.map(k => k.padStart(8)).join(' ')); for (const m of models) console.log(m.padEnd(15), sc.map(k => f(mean(rows.filter(r => r.model === m && r.scenario === k).map(r => r.overall))).padStart(8)).join(' '));
console.log('\nlanguage by ES/JA:'); for (const m of models) console.log(m.padEnd(15), ['ES','JA'].map(k => k + ' ' + f(mean(rows.filter(r => r.model === m && r.kind === k).map(r => r.language)))).join('  '));
console.log('\ngrounded<=3 count:'); for (const m of models) console.log(m.padEnd(15), rows.filter(r => r.model === m && r.grounded <= 3).length, ' identity<=2:', rows.filter(r => r.model === m && r.identity <= 2).length, ' overall<=2:', rows.filter(r => r.model === m && r.overall <= 2).length);
import('node:fs').then(fs => fs.writeFileSync(`${W}/judge/merged.json`, JSON.stringify(rows, null, 1)));
