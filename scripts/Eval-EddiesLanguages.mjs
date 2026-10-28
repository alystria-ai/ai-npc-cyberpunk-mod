// Prints, per language, how the money grammar of bridge/eddies-languages/<code>.mjs does on bridge/eddies-languages/<code>.cases.json, with every miss.
// Usage: node scripts/Eval-EddiesLanguages.mjs [--set dev|held|blind|blind2|all] [code ...]   (default: dev, every language)
import {readFileSync, existsSync} from 'node:fs';
import {LANGUAGES, parseAmountIn, warmLanguagesNow} from '../bridge/eddies-languages.mjs';
warmLanguagesNow();
import {screenWords} from '../bridge/eddies.mjs';

const args = process.argv.slice(2);
const setIndex = args.indexOf('--set');
const which = setIndex >= 0 ? args.splice(setIndex, 2)[1] : 'dev';
const codes = args.length ? args : LANGUAGES;
let total = {asks: 0, ok: 0, near: 0, clean: 0, sums: 0, sumOk: 0};
for (const code of codes) {
  const file = new URL(`../bridge/eddies-languages/${code}.cases.json`, import.meta.url);
  if (!existsSync(file)) { console.log(`${code}: no cases file`); continue; }
  const all = JSON.parse(readFileSync(file, 'utf8'));
  for (const name of which === 'all' ? ['dev', 'held'] : [which]) {
    const extra = new URL(`../bridge/eddies-languages/${code}.${name}.json`, import.meta.url);
    const set = all[name] ?? (existsSync(extra) ? JSON.parse(readFileSync(extra, 'utf8')) : {asks: [], near: [], amounts: []});
    const out = [];
    let ok = 0, clean = 0, sumOk = 0;
    for (const [text, intent, amount] of set.asks) {
      const s = screenWords(text);
      if (s.intent === intent && (s.amount ?? null) === amount) ok++; else out.push(`  MISS  ${text}  => ${s.intent}:${s.amount ?? null}${s.refused ? ' (refused ' + s.refused + ')' : ''}  want ${intent}:${amount}`);
    }
    for (const text of set.near) {
      const s = screenWords(text);
      if (!s.intent) clean++; else out.push(`  FALSE ${text}  => ${s.intent}:${s.amount ?? null}`);
    }
    for (const [text, amount] of set.amounts) {
      const got = parseAmountIn(code, text.normalize('NFKC').toLowerCase());
      if (got === amount) sumOk++; else out.push(`  SUM   ${text}  => ${got}  want ${amount}`);
    }
    console.log(`${code} ${name}: asks ${ok}/${set.asks.length}  near-misses clean ${clean}/${set.near.length}  sums ${sumOk}/${set.amounts.length}`);
    for (const line of out) console.log(line);
    total = {asks: total.asks + set.asks.length, ok: total.ok + ok, near: total.near + set.near.length, clean: total.clean + clean, sums: total.sums + set.amounts.length, sumOk: total.sumOk + sumOk};
  }
}
console.log(`TOTAL asks ${total.ok}/${total.asks}  clean ${total.clean}/${total.near}  sums ${total.sumOk}/${total.sums}`);
