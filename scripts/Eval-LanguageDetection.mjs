#!/usr/bin/env node
// Precision and recall of the language detector on the labelled short lines (bridge/reply-language.cases.mjs and
// bridge/reply-language.heldout.json). Usage:
//   node scripts/Eval-LanguageDetection.mjs [--detector=<module that exports detectLanguage>] [--errors] [--set=dev|heldout|all]
// A line labelled null (a bare "ok", a name, an emoji) may be called English or not called at all, but never another language.
// Recall of a language: lines of that language the detector called that language. Precision: calls of that language that were right.
import {readFile} from 'node:fs/promises';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {DEV} from '../bridge/reply-language.cases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const detectorPath = arg('detector');
const {detectLanguage} = await import(detectorPath ? pathToFileURL(resolve(detectorPath)).href : '../bridge/reply-language.mjs');
const heldout = JSON.parse(await readFile(resolve(root, 'bridge/reply-language.heldout.json'), 'utf8')).map(row => [row.text, row.lang]);
const which = arg('set') ?? 'all';
const blind = which === 'blind' || which === 'all' ? JSON.parse(await readFile(resolve(root, 'bridge/reply-language.blind.json'), 'utf8')).map(row => [row.text, row.lang]) : [];
const rows = which === 'dev' ? DEV : which === 'heldout' ? heldout : which === 'blind' ? blind : [...DEV, ...heldout, ...blind];

export function evaluate(rows, detect) {
  const stats = {}, errors = [];
  const get = language => stats[language] ??= {tp: 0, fp: 0, fn: 0, lines: 0};
  let microNs = 0n;
  for (const [text, label] of rows) {
    const start = process.hrtime.bigint();
    const got = detect(text).language;
    microNs += process.hrtime.bigint() - start;
    if (label) get(label).lines++;
    if (got) get(got);
    if (label === got) { if (label) get(label).tp++; continue; }
    if (label === null && got === 'en') continue;           // may be called English
    if (label && label !== got) { get(label).fn++; errors.push({text, label, got}); }
    if (got && got !== label) { get(got).fp++; if (!label) errors.push({text, label, got}); }
  }
  return {stats, errors, perCallUs: Number(microNs) / 1000 / rows.length};
}

const {stats, errors, perCallUs} = evaluate(rows, detectLanguage);
const pct = (a, b) => b ? (100 * a / b).toFixed(0).padStart(3) + '%' : '  - ';
console.log('lang  lines  recall  precision   (tp/fp/fn)');
let tp = 0, fp = 0, fn = 0, lines = 0;
for (const [language, s] of Object.entries(stats).sort((a, b) => b[1].lines - a[1].lines)) {
  tp += s.tp; fp += s.fp; fn += s.fn; lines += s.lines;
  console.log(`${language.padEnd(5)} ${String(s.lines).padStart(5)}  ${pct(s.tp, s.tp + s.fn)}    ${pct(s.tp, s.tp + s.fp)}      (${s.tp}/${s.fp}/${s.fn})`);
}
const nonEnglish = Object.entries(stats).filter(([language]) => language !== 'en');
const ne = nonEnglish.reduce((a, [, s]) => ({tp: a.tp + s.tp, fp: a.fp + s.fp, fn: a.fn + s.fn}), {tp: 0, fp: 0, fn: 0});
console.log(`all non-English: recall ${pct(ne.tp, ne.tp + ne.fn)} precision ${pct(ne.tp, ne.tp + ne.fp)}  (English lines called non-English: ${stats.en ? errors.filter(e => (e.label === 'en' || e.label === null) && e.got && e.got !== 'en').length : 0})`);
console.log(`lines ${rows.length}, ${perCallUs.toFixed(1)} us per call`);
if (process.argv.includes('--errors')) for (const e of errors) console.log(`  ${JSON.stringify(e.text)}  label=${e.label} got=${e.got}`);
