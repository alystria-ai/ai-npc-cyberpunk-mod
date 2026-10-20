#!/usr/bin/env node
// A bigger check of the language detector (bridge/reply-language.mjs) on text nobody wrote for it:
//   non-English: the mod's own translated UI strings (mod/locales/*.lua), the ones of 2 to 6 words, labelled by their file;
//   English: the English sides of those strings, and 2 to 6 word windows cut from README.md and docs/*.md.
// Prints recall per language and the English lines that were called another language. Usage:
//   node scripts/Eval-LanguageCorpus.mjs [--detector=<module>] [--show=N]
import {readFile, readdir} from 'node:fs/promises';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const detectorPath = arg('detector'), show = Number(arg('show') ?? 12);
const {detectLanguage} = await import(detectorPath ? pathToFileURL(resolve(detectorPath)).href : '../bridge/reply-language.mjs');

const clean = text => text.replace(/\{[^}]*\}|%[sd]|\\n|\\"/g, ' ').replace(/[`*_#|>\[\]()<>]/g, ' ').replace(/\s+/g, ' ').trim();
const wordCount = text => text.split(' ').filter(Boolean).length;
const inRange = text => { const n = wordCount(text); return n >= 2 && n <= 6; };
const LANGUAGE_OF_FILE = {cs: 'cs', de: 'de', es: 'es', fr: 'fr', hu: 'hu', it: 'it', pl: 'pl', 'pt-br': 'pt', tr: 'tr', ru: 'ru', uk: 'uk', ja: 'ja', ko: 'ko', 'zh-cn': 'zh', 'zh-tw': 'zh'};

const english = new Set(), foreign = [];
for (const [file, language] of Object.entries(LANGUAGE_OF_FILE)) {
  const source = await readFile(resolve(root, `mod/locales/${file}.lua`), 'utf8');
  let index = 0;
  for (const match of source.matchAll(/^\s*\["((?:[^"\\]|\\.)*)"\]\s*=\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)) {
    const key = clean(match[1]), value = clean(match[2]);
    if (match[2] !== match[1]) index++;   // the same numbering as the vocabulary builder, so --parity=even tests strings it never saw
    if (inRange(key) && /^[A-Za-z' ,.!?:-]+$/.test(key)) english.add(key);
    if (inRange(value) && value !== key) foreign.push([value, language, index]);
  }
}
// Windows of English prose.
const windows = [];
const docs = (await readdir(resolve(root, 'docs'))).filter(name => name.endsWith('.md')).map(name => `docs/${name}`);
let seed = 7; const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
for (const file of ['README.md', ...docs]) {
  const text = (await readFile(resolve(root, file), 'utf8')).replace(/```[\s\S]*?```/g, ' ');
  for (const line of text.split(/\n/)) {
    const words = clean(line).split(' ').filter(word => /^[A-Za-z',.!?;:-]+$/.test(word));
    if (words.length < 8 || random() > 0.15) continue;
    const length = 2 + Math.floor(random() * 5), start = Math.floor(random() * (words.length - length));
    windows.push(words.slice(start, start + length).join(' '));
  }
}

const parity = arg('parity');
const per = {}; const wrong = []; let calls = 0; const start = process.hrtime.bigint();
for (const [text, language, index] of foreign) {
  if (parity && (index % 2 === 0) !== (parity === 'even')) continue;
  const got = detectLanguage(text).language;
  calls++;
  const row = per[language] ??= {lines: 0, hit: 0, other: 0, fn: []};
  row.lines++;
  if (got === language) row.hit++; else if (got && got !== 'en') { row.other++; wrong.push([text, language, got]); } else if (row.fn.length < 14) row.fn.push(text);
}
const englishBad = []; let englishLines = 0, englishRight = 0;
for (const text of [...english, ...windows]) {
  const got = detectLanguage(text).language;
  calls++; englishLines++;
  if (got === 'en') englishRight++;
  if (got && got !== 'en') englishBad.push([text, got]);
}
const ms = Number(process.hrtime.bigint() - start) / 1e6;
console.log('lang   lines  recall  called-another-language');
for (const [language, row] of Object.entries(per)) console.log(`${language.padEnd(5)} ${String(row.lines).padStart(6)}  ${(100 * row.hit / row.lines).toFixed(0).padStart(4)}%  ${row.other}`);
console.log(`English lines ${englishLines} (UI keys ${english.size}, doc windows ${windows.length}): called English ${englishRight}, called another language ${englishBad.length}`);
console.log(`${calls} calls, ${(ms * 1000 / calls).toFixed(1)} us per call`);
for (const [text, got] of englishBad.slice(0, show)) console.log(`  EN->${got}: ${JSON.stringify(text)}`);
for (const language of Object.keys(per)) console.log('MISSES', language, JSON.stringify(per[language].fn));
for (const [text, language, got] of wrong.slice(0, show)) console.log(`  ${language}->${got}: ${JSON.stringify(text)}`);
