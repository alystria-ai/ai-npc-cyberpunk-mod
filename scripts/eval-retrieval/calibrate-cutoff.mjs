// Calibrates the lasting-memory cut-off of bridge/memory-store.mjs (docs/COHERE_RETRIEVAL_EVAL_2026-10-30.md, "Follow-up: the cut-off").
//   node scripts/eval-retrieval/calibrate-cutoff.mjs [granite|embgemma] [--grid] [--sizes] [--rule '{"floor":0.7,"margin":0.1,"gate":true}']
// Embeds the lines of data/cutoff-lines.json (small talk of three kinds, plus written questions about the synthetic memories) and the
// eval's own queries with the chosen local embedder (cached in local/cache/), then replays the rules against the memory pools:
// the synthetic ones (data/memories.json, cached vectors) and, for granite, the owner's real saved memories. The real memories are
// read in place from the data folder (their stored vectors), only counts are printed, never their text, and nothing is copied.
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {readJson, cached, localEmbedder, cacheDir, here, unit, dot, LOCAL_MODELS} from './lib.mjs';
import {retrievalRuleFor, cutoffFor, isPureSmallTalk} from '../../bridge/memory-store.mjs';

const args = process.argv.slice(2);
const model = args[0] && !args[0].startsWith('--') ? args[0] : 'granite';
const REAL_DIR = process.env.REAL_MEMORY_DIR || '//localhost/C$/Users/akshi/AppData/Local/AiNpcCyberpunkMod/data/local-memory/player';
const lines = readJson(join(here, 'data/cutoff-lines.json'));
const memories = readJson(join(here, 'data/memories.json'));
const queries = readJson(join(here, 'data/queries.json'));
const wrapQuery = model === 'embgemma' ? text => 'task: search result | query: ' + text : x => x;
const SPEAKERS = {panam: 'panam-palmer', judy: 'judy-alvarez', johnny: 'johnny-silverhand', viktor: 'viktor-vektor'};
const CHATTER = ['greeting', 'smalltalk', 'smalltalk-eval', 'action'];

// ---- vectors ---------------------------------------------------------------------------------------------------------------------
const allLines = [
  ...lines.greeting.map(text => ({text, cls: 'greeting'})), ...lines.smalltalk.map(text => ({text, cls: 'smalltalk'})),
  ...lines.action.map(text => ({text, cls: 'action'})),
  ...queries.filter(q => q.category === 'smalltalk').map(q => ({text: q.text, cls: 'smalltalk-eval'})),
  ...lines.memoryQueries.map(q => ({text: q.text, cls: 'memory-new', gold: q.gold, speaker: SPEAKERS[q.gold.split('-')[1]]})),
  ...queries.filter(q => q.category === 'memory').map(q => ({text: q.text, cls: 'memory-eval', gold: q.gold[0], speaker: q.speaker})),
  ...queries.filter(q => ['fact', 'story', 'quest', 'place'].includes(q.category)).map(q => ({text: q.text, cls: 'world-' + q.category, speaker: q.speaker})),
];
const lineVectors = await cached(`cutoff-lines-${model}.json`, async () => {
  const embedder = await localEmbedder(model);
  const out = {};
  const vecs = await embedder.embed(allLines.map(line => wrapQuery(line.text)));
  allLines.forEach((line, i) => { out[line.text] = Array.from(vecs[i]); });
  await embedder.close();
  return out;
});
const docCache = readJson(join(cacheDir, `emb-main-${model}.json`)).docs;
const pools = {};   // name -> [{id, vec, importance}]
for (const speaker of new Set(memories.map(m => m.speaker))) {
  pools['syn:' + speaker] = memories.filter(m => m.speaker === speaker).map(m => ({id: m.id, vec: unit(Float32Array.from(docCache[m.text])), importance: m.importance ?? 0.5}));
}
if (model === 'granite') {
  for (const file of readdirSync(REAL_DIR)) {
    if (!file.endsWith('.json')) continue;
    const row = JSON.parse(readFileSync(join(REAL_DIR, file), 'utf8'));
    if (!Array.isArray(row.records) || row.embedder?.id !== LOCAL_MODELS.granite.id) continue;
    const records = row.records.filter(r => typeof r.v === 'string').map(r => ({id: r.id, vec: new Float32Array(new Uint8Array(Buffer.from(r.v, 'base64')).buffer), importance: r.importance ?? 0.5}));
    if (records.length >= 3) pools['real:' + file.replace(/\.json$/, '')] = records;
  }
}
const merged = Object.entries(pools).filter(([name]) => name.startsWith('syn:')).flatMap(([, pool]) => pool);

// ---- replay ----------------------------------------------------------------------------------------------------------------------
/** What the store would return (ids, best first) for one line against one pool under a rule. Mirrors MemoryStore.retrieve. */
function replay(line, pool, rule, k = 4) {
  if (rule.gate && isPureSmallTalk(line.text)) return [];
  const qv = unit(Float32Array.from(lineVectors[line.text]));
  const scored = pool.map(item => { const cosine = dot(qv, item.vec); return {id: item.id, cosine, score: cosine + 0.03 * item.importance}; });
  const cut = cutoffFor(rule, scored.map(s => s.cosine));
  if (cut === null) return [];
  return scored.filter(s => s.cosine >= cut).sort((a, b) => b.score - a.score).slice(0, k).map(s => s.id);
}
const avg = list => list.length ? list.reduce((a, b) => a + b, 0) / list.length : NaN;
const pct = x => (x * 100).toFixed(0).padStart(3) + '%';
function evaluate(rule, split = null) {
  const pick = list => split === null ? list : list.filter((_, i) => i % 2 === split);
  const out = {};
  const chatter = [];
  for (const cls of CHATTER) {
    const trials = [];
    for (const line of pick(allLines.filter(l => l.cls === cls))) for (const pool of Object.values(pools)) trials.push(replay(line, pool, rule).length);
    out[cls] = avg(trials.map(n => n > 0 ? 1 : 0)); chatter.push(...trials);
  }
  out.chatterPass = avg(chatter.map(n => n > 0 ? 1 : 0)); out.chatterCount = avg(chatter);
  const recall = [], counts = [];
  for (const line of pick(allLines.filter(l => l.cls.startsWith('memory')))) {
    const ids = replay(line, pools['syn:' + line.speaker], rule);
    recall.push(ids.includes(line.gold) ? 1 : 0); counts.push(ids.length);
  }
  out.recall4 = avg(recall); out.questionCount = avg(counts);
  const world = pick(allLines.filter(l => l.cls.startsWith('world-'))).map(line => replay(line, pools['syn:' + line.speaker], rule).length);
  out.worldPass = avg(world.map(n => n > 0 ? 1 : 0)); out.worldCount = avg(world);
  return out;
}
const show = (name, rule, split) => {
  const r = evaluate(rule, split);
  console.log(name.padEnd(30), 'greet', pct(r.greeting), 'small', pct(r.smalltalk), 'evalsmall', pct(r['smalltalk-eval']), 'action', pct(r.action),
    '| small talk pass', pct(r.chatterPass), 'mem/turn', r.chatterCount.toFixed(2),
    '| question recall@4', pct(r.recall4), 'mem/turn', r.questionCount.toFixed(2), '| world question pass', pct(r.worldPass), 'mem/turn', r.worldCount.toFixed(2));
};

console.log(`model ${model}, pools: ${Object.entries(pools).map(([k, v]) => k + '=' + v.length).join(' ')}, lines ${allLines.length}`);
// Distribution of the best cosine per class: this is what a floor on the best memory is cut from.
for (const cls of [...CHATTER, 'memory-new', 'memory-eval', 'world-fact', 'world-story', 'world-quest', 'world-place']) {
  const bests = [];
  for (const line of allLines.filter(l => l.cls === cls)) {
    const qv = unit(Float32Array.from(lineVectors[line.text]));
    for (const pool of line.speaker ? [pools['syn:' + line.speaker]] : Object.values(pools)) bests.push(Math.max(...pool.map(item => dot(qv, item.vec))));
  }
  bests.sort((a, b) => a - b);
  const q = f => bests[Math.min(bests.length - 1, Math.floor(f * bests.length))].toFixed(3);
  console.log(cls.padEnd(15), 'best cosine min', q(0), 'p10', q(0.1), 'median', q(0.5), 'p90', q(0.9), 'max', q(1));
}

if (args.includes('--grid')) {
  console.log('\n--- absolute cut-off on every memory');
  for (let t = 0.40; t <= 0.80; t += 0.05) show('abs ' + t.toFixed(2), {min: t});
  console.log('\n--- floor on the best memory, keep those within a margin of it (no word-list gate)');
  for (const floor of [0.55, 0.60, 0.65, 0.70]) for (const margin of [0.06, 0.10]) show(`floor ${floor} margin ${margin}`, {floor, margin});
  console.log('\n--- the same with the word-list gate');
  for (const floor of [0.62, 0.64, 0.66, 0.68, 0.70, 0.72]) for (const margin of [0.06, 0.10]) show(`gate floor ${floor} margin ${margin}`, {floor, margin, gate: true});
  show('gate alone (0.40)', {min: 0.40, gate: true});
}
const passing = (rows, pool, rule) => rows.filter(line => replay(line, pool, rule).length > 0).length;
if (args.includes('--rule')) {
  const rule = JSON.parse(args[args.indexOf('--rule') + 1]);
  show('RULE all', rule); show('RULE even-index lines', rule, 0); show('RULE odd-index lines', rule, 1);
  const rows = allLines.filter(l => CHATTER.includes(l.cls));
  for (const [name, pool] of [...Object.entries(pools).filter(([k]) => k.startsWith('real:')), ['merged 360 synthetic', merged]]) {
    console.log('  ', name.padEnd(24), 'small talk lines that pass', passing(rows, pool, rule), 'of', rows.length, 'pool', pool.length);
  }
}

if (args.includes('--sizes')) {
  // How the floor must move with the number of memories: random pools of n memories from the 360 synthetic ones (a question's pool always holds its gold).
  let seed = 12345; const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const rows = allLines.filter(l => CHATTER.includes(l.cls) && !isPureSmallTalk(l.text));
  const qs = allLines.filter(l => l.cls.startsWith('memory'));
  const sample = (n, must) => {
    const rest = merged.filter(item => item.id !== must);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    const out = rest.slice(0, n - (must ? 1 : 0));
    if (must) out.push(merged.find(item => item.id === must));
    return out;
  };
  const floors = [0.60, 0.64, 0.66, 0.68, 0.70, 0.72, 0.74];
  console.log('\npool size | per floor (margin 0.10): small talk pass / question recall@4, 8 random pools each, lines the word list lets through');
  for (const n of [5, 10, 30, 90, 200, 360]) {
    const cells = floors.map(floor => {
      const rule = {floor, margin: 0.10};
      let pass = 0, total = 0, hit = 0, asked = 0;
      for (let draw = 0; draw < 8; draw++) {
        const pool = sample(n);
        for (const line of rows) { total++; if (replay(line, pool, rule).length) pass++; }
        for (const line of qs) { asked++; if (replay(line, sample(n, line.gold), rule).includes(line.gold)) hit++; }
      }
      return `${floor.toFixed(2)} ${(pass / total * 100).toFixed(0).padStart(3)}/${(hit / asked * 100).toFixed(0).padStart(3)}`;
    });
    console.log(String(n).padStart(9), '|', cells.join('  '));
  }
}

// Before: the cut-off the mod shipped (cosine 0.40, no gate). After: what bridge/memory-store.mjs does now for this model.
const before = {min: 0.40}, after = {...retrievalRuleFor(LOCAL_MODELS[model].id), gate: true};
console.log('\n--- before and after for', LOCAL_MODELS[model].id, JSON.stringify(after));
for (const [name, rule] of [['before', before], ['after', after]]) {
  show(`${name} (all lines)`, rule); show(`${name} (even-index lines)`, rule, 0); show(`${name} (odd-index lines)`, rule, 1);
}
