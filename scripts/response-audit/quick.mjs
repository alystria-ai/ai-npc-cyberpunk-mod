// The objective numbers of runs, no judge: echo-like openers (regex, as in the response audit), stock closing questions, replies over 45 words, automatic problems,
// mean words, median / p90 latency, prompt tokens, and replies that carry a fault of the automatic checks.
//   node scripts/response-audit/quick.mjs label [label ...]
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {dataDir} from './lib.mjs';

const W = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);
const STOP = new Set(['the', 'a', 'an', 'you', 'i', 'me', 'my', 'your', 'is', 'are', 'am', 'it', 'that', 'this', 'to', 'of', 'and', 'or', 'so', 'do', 'does', 'what', 'who', 'where', 'how', 'why', 'which', 'hey', 'hi', 'yes', 'no', 'yeah', 'oh', 'well', 'okay', 'sure', 'really', 'now', 'then']);
export function echoLike(reply, said) {
  const s = new Set(W(said));
  const m = /^(.*?[.?!…]+)(\s|$)/.exec(String(reply).trim());
  const first = m ? m[1] : reply, w = W(first);
  if (!w.length || w.length > 6) return false;
  const shared = w.filter(x => s.has(x) && !STOP.has(x));
  return shared.length > 0 && shared.length >= Math.ceil(w.filter(x => !STOP.has(x)).length * 0.6) && /[?]$/.test(String(first).trim()) || (shared.length > 0 && w.length <= 3);
}
const STOCK = /\b(what'?s on your mind|what about you|what brings you|anything else)\b[^.!?]*\?\s*$/i;
const q = (list, p) => list.length ? [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(p * list.length))] : null;
const pct = (n, d) => d ? `${Math.round(100 * n / d)}%` : '-';
if (process.argv[1].endsWith('quick.mjs')) {
  const rows = [];
  for (const label of process.argv.slice(2)) {
    const run = JSON.parse(await readFile(resolve(dataDir, `${label}.json`), 'utf8'));
    const ok = run.results.filter(r => !r.error);
    const times = ok.map(r => r.ms).filter(Number.isFinite), tokens = ok.map(r => r.promptTokens).filter(Number.isFinite);
    const bad = ok.filter(r => (r.problems ?? []).some(p => p !== 'too-long' && p !== 'dash'));
    rows.push({label, n: ok.length, failed: run.results.length - ok.length, echo: pct(ok.filter(r => echoLike(r.spoken, r.playerText)).length, ok.length), stock: ok.filter(r => STOCK.test(r.spoken)).length,
      over45: pct(ok.filter(r => r.words > 45).length, ok.length), words: +(ok.reduce((a, r) => a + (r.words ?? 0), 0) / Math.max(1, ok.length)).toFixed(1), problems: pct(bad.length, ok.length),
      p50: q(times, 0.5), p90: q(times, 0.9), promptTok: tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : '-'});
  }
  console.table(rows);
}
