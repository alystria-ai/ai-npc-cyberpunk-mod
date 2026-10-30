// Scores the background framing A/B runs (scripts/Eval-NaturalTalk.mjs --set ab, docs/BACKGROUND_FRAMING_AB_2026-10-30.md). Not part of the game bridge and not part of the release.
//   node scripts/Score-BackgroundFraming.mjs prep  <runs folder> [--batch 120]   writes judge/batch-N.json (blind: shuffled, no provider or variant) and judge/key.json
//   node scripts/Score-BackgroundFraming.mjs score <runs folder>                 merges judge/batch-N.result.json with the key, adds the plain word check, prints the tables (JSON to results.json)
// A run file is <provider>-<variant>-r<rep>.json (gem, std, mat; A, B, C).
import {readdir, readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';

const [mode, dirArg, ...rest] = process.argv.slice(2);
const dir = resolve(dirArg ?? '.'), judgeDir = resolve(dir, 'judge');
const batchSize = Number(rest[rest.indexOf('--batch') + 1]) || 120;

const TRUTH_FULL = 'V wears an Armored Nomad Jacket, Black Tank Top, Cargo Pants and Combat Boots; carries the pistols Overture and Lexington; has Kiroshi Optics (eyes) and a Sandevistan installed; V is rich (a lot of eddies).';
const TRUTH_SEEN = 'A stranger can see only what V wears: an Armored Nomad Jacket, Black Tank Top, Cargo Pants and Combat Boots. The speaker knows nothing of V\'s weapons, cyberware or money.';
const AMBIENT = new Set(['vendor', 'stranger']);
const askOf = kind => kind === 'ask-money' ? 'money' : kind.startsWith('ask-') ? 'gear' : 'no';

// The plain word check, the same for every reply (the judge is the better measure: these words also fit a character talking about herself).
const GEAR_WORDS = /\b(jackets?|tank top|cargo|pants|boots|overture|lexington|kiroshi|sandevistan|sandy|optics|cyberware|chrome|implants?|weapons?|guns?|pistols?|armed|holstered|wearing|outfit|clothes|dressed|armou?red?)\b/i;
const MONEY_WORDS = /\b(rich|wealthy|loaded|rolling in|eddies|eddie|money|cash|broke|afford|credits?|bank account|wallet|big spender|pockets|fat)\b/i;

async function runs() {
  const out = [];
  for (const file of (await readdir(dir)).filter(name => /^(gem|std|mat)-[ABC]-r\d+\.json$/.test(name)).sort()) {
    const [provider, variant, rep] = file.replace('.json', '').split('-');
    const data = JSON.parse(await readFile(resolve(dir, file), 'utf8'));
    for (const row of data.rows) out.push({provider, variant, rep, ...row});
  }
  return out;
}

if (mode === 'prep') {
  // --append: keep the numbering of an earlier prep (judge/key.json) and make new batches only for replies not in it yet.
  await mkdir(judgeDir, {recursive: true});
  const append = rest.includes('--append');
  const key = append ? JSON.parse(await readFile(resolve(judgeDir, 'key.json'), 'utf8')) : {};
  const known = new Set(Object.values(key));
  const start = Object.keys(key).length;
  const first = append ? (await readdir(judgeDir)).filter(name => /^batch-\d+\.json$/.test(name)).length : 0;
  const items = (await runs()).filter(row => row.reply).map(row => ({row, id: `${row.provider}-${row.variant}-${row.rep}-${row.id}`})).filter(item => !known.has(item.id));
  // Seeded shuffle so a re-prep gives the same batches.
  let seed = 20261030; const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
  const batches = [];
  items.forEach(({row, id}, i) => {
    const n = String(start + i + 1).padStart(4, '0');
    key[n] = id;
    (batches[Math.floor(i / batchSize)] ??= []).push({n, character: row.who, v_said: row.v, asked_about: askOf(row.kind), facts_true: AMBIENT.has(row.who) ? TRUTH_SEEN : TRUTH_FULL, reply: row.reply});
  });
  for (const [i, batch] of batches.entries()) await writeFile(resolve(judgeDir, `batch-${first + i + 1}.json`), JSON.stringify(batch, null, 1));
  await writeFile(resolve(judgeDir, 'key.json'), JSON.stringify(key));
  console.log(`${items.length} replies in ${batches.length} batches of up to ${batchSize}, from batch ${first + 1}`);
} else if (mode === 'score') {
  const all = await runs();
  const key = JSON.parse(await readFile(resolve(judgeDir, 'key.json'), 'utf8')), byId = new Map(all.map(row => [`${row.provider}-${row.variant}-${row.rep}-${row.id}`, row]));
  const judged = new Map();
  for (const file of (await readdir(judgeDir)).filter(name => /^batch-\d+\.result\.json$/.test(name))) {
    for (const item of JSON.parse(await readFile(resolve(judgeDir, file), 'utf8'))) judged.set(item.n, item);
  }
  // Paired: a turn counts only when every variant of that provider has a reply for it (a provider that hit its daily cap midway would otherwise favour the variant that ran first).
  const have = new Map();
  for (const row of all) if (row.reply) { const k = `${row.provider}-${row.rep}-${row.id}`; (have.get(k) ?? have.set(k, new Set()).get(k)).add(row.variant); }
  const groups = {};
  for (const [n, id] of Object.entries(key)) {
    const row = byId.get(id); if (!row) continue;
    if ((have.get(`${row.provider}-${row.rep}-${row.id}`)?.size ?? 0) < 3) continue;
    const g = (groups[`${row.provider} ${row.variant}`] ??= {provider: row.provider, variant: row.variant, quiet: [], asked: []});
    const ask = askOf(row.kind), j = judged.get(n);
    const entry = {id, ask, reply: row.reply, wordGear: GEAR_WORDS.test(row.reply), wordMoney: MONEY_WORDS.test(row.reply), words: row.reply.split(/\s+/).length, m: j?.m, c: j?.c, nat: j?.n_score};
    (ask === 'no' ? g.quiet : g.asked).push(entry);
  }
  const pct = (n, d) => d ? Math.round(100 * n / d) : null;
  const mean = list => list.length ? Math.round(10 * list.reduce((a, b) => a + b, 0) / list.length) / 10 : null;
  const table = Object.values(groups).sort((a, b) => (a.provider + a.variant).localeCompare(b.provider + b.variant)).map(g => {
    const jq = g.quiet.filter(e => e.m !== undefined), ja = g.asked.filter(e => e.c !== undefined);
    return {provider: g.provider, variant: g.variant, quietTurns: g.quiet.length, askedTurns: g.asked.length,
      judgeUnprompted: jq.filter(e => e.m === 1).length, judgeUnpromptedPct: pct(jq.filter(e => e.m === 1).length, jq.length),
      wordGear: g.quiet.filter(e => e.wordGear).length, wordMoney: g.quiet.filter(e => e.wordMoney).length, wordAny: g.quiet.filter(e => e.wordGear || e.wordMoney).length,
      answeredWhenAsked: ja.filter(e => e.c === 1).length, answeredOf: ja.length, answeredPct: pct(ja.filter(e => e.c === 1).length, ja.length),
      naturalness: mean([...g.quiet, ...g.asked].map(e => e.nat).filter(Number.isFinite)), meanWords: mean([...g.quiet, ...g.asked].map(e => e.words))};
  });
  await writeFile(resolve(dir, 'results.json'), JSON.stringify({table, groups}, null, 1));
  console.table(table);
} else { console.error('usage: prep|score <runs folder>'); process.exit(2); }
