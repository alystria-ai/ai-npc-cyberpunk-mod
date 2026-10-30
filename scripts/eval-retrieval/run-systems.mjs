// Runs every retrieval system of the eval over every query and writes local/rankings.json (top 20 per query and system) and
// local/latency.json (round trip per query and system, ms). Embeddings and rerank answers are cached in local/cache, so a re-run
// costs no Cohere calls.
//   node scripts/eval-retrieval/run-systems.mjs [--queries data/queries.json] [--items data/items.json] [--out local] [--skip-cohere]
//
// Systems
//   granite       the mod's embedder (bridge/local-embed.mjs, granite-embedding-107m-multilingual Q8, CPU, one thread), cosine
//   embgemma      EmbeddingGemma-300M Q8 on the CPU (the pack's earlier candidate), cosine, with its query and document prefixes
//   cohere-pro    embed-v5.0-pro, 2048 dimensions, cosine
//   cohere-pro512 the same vectors cut to 512 dimensions (Matryoshka) and normalised again, cosine
//   cohere-fast   embed-v5.0-fast, 2048 dimensions, cosine
//   bm25          plain BM25 over the speaker's pool (no model)
//   granite+bm25  reciprocal rank fusion of the two
//   granite>rerank   granite top 50, reranked by rerank-v5.0-pro
//   cohere>rerank    cohere-pro top 50, reranked by rerank-v5.0-pro
//   coherefast>rerankfast   cohere-fast top 50, reranked by rerank-v5.0-fast
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {cached, cacheDir, cohereCall, localDir, localEmbedder, readJson, writeJson, here, sleep, unit, rankByVector, bm25, rrf} from './lib.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const itemsPath = resolve(arg('items', join(here, 'data/items.json')));
const queriesPath = resolve(arg('queries', join(here, 'data/queries.json')));
const outDir = resolve(arg('out', localDir));
const tag = arg('tag', 'main');
const skipCohere = process.argv.includes('--skip-cohere');
const RERANK_GAP_MS = 6500;   // the trial key allows 10 rerank calls a minute
const TOP = 50;

const items = readJson(itemsPath), queries = readJson(queriesPath);
const byId = new Map(items.map(item => [item.id, item]));
const pool = speaker => items.filter(item => item.speaker === speaker);
const uniqueTexts = [...new Set(items.map(item => item.text))];
console.log(`items ${items.length} (${uniqueTexts.length} unique texts), queries ${queries.length}`);

const latency = {};
const note = (system, qid, ms) => { (latency[system] ??= {})[qid] = ms; };
const vectors = {};   // system -> {texts: Map text->vec, queries: Map qid->vec}

// ---- local embedders ------------------------------------------------------------------------------------------------------------
async function localSystem(name, wrapQuery = x => x, wrapDoc = x => x) {
  const file = `emb-${tag}-${name}.json`;
  const data = await cached(file, async () => {
    const embedder = await localEmbedder(name);
    const started = performance.now();
    await embedder.embed(['warm up']);
    const coldStartMs = performance.now() - started;
    const docs = {};
    const docStarted = performance.now();
    const vecs = await embedder.embed(uniqueTexts.map(wrapDoc));
    const docMs = performance.now() - docStarted;
    uniqueTexts.forEach((text, i) => { docs[text] = Array.from(vecs[i]); });
    const qvec = {}, ms = {};
    for (const q of queries) {   // one query at a time, warm server: what a turn pays
      const t0 = performance.now();
      const [vec] = await embedder.embed([wrapQuery(q.text)]);
      ms[q.id] = performance.now() - t0;
      qvec[q.id] = Array.from(vec);
    }
    await embedder.close();
    return {docs, qvec, ms, coldStartMs, docMs, docCount: uniqueTexts.length};
  });
  vectors[name] = {docs: new Map(Object.entries(data.docs).map(([t, v]) => [t, Float32Array.from(v)])), q: new Map(Object.entries(data.qvec).map(([k, v]) => [k, Float32Array.from(v)]))};
  for (const [qid, ms] of Object.entries(data.ms)) note(name, qid, ms);
  latency[`${name}:meta`] = {coldStartMs: data.coldStartMs, docMs: data.docMs, docCount: data.docCount};
  console.log(name, 'ready, cold start', Math.round(data.coldStartMs), 'ms, docs', Math.round(data.docMs), 'ms');
}

// ---- Cohere embeddings -----------------------------------------------------------------------------------------------------------
async function cohereSystem(name, model) {
  const data = await cached(`emb-${tag}-${name}.json`, async () => {
    const docs = {}, queryVecs = {}, ms = {};
    let tokensIn = 0;
    for (let from = 0; from < uniqueTexts.length; from += 96) {
      const batch = uniqueTexts.slice(from, from + 96);
      const {json} = await cohereCall('/v2/embed', {model, input_type: 'search_document', texts: batch, embedding_types: ['float']}, {kind: 'embed-docs'});
      batch.forEach((text, i) => { docs[text] = json.embeddings.float[i]; });
      tokensIn += json.meta?.billed_units?.input_tokens || 0;
      await sleep(700);
    }
    for (const q of queries) {
      const {json, ms: took} = await cohereCall('/v2/embed', {model, input_type: 'search_query', texts: [q.text], embedding_types: ['float']}, {kind: 'embed-query'});
      queryVecs[q.id] = json.embeddings.float[0]; ms[q.id] = took;
      tokensIn += json.meta?.billed_units?.input_tokens || 0;
      await sleep(650);
    }
    return {docs, qvec: queryVecs, ms, tokensIn};
  });
  const make = cut => (cut ? v => unit(Float32Array.from(v).subarray(0, cut)) : v => unit(Float32Array.from(v)));
  const build = (system, cut) => {
    const fn = make(cut);
    vectors[system] = {docs: new Map(Object.entries(data.docs).map(([t, v]) => [t, fn(v)])), q: new Map(Object.entries(data.qvec).map(([k, v]) => [k, fn(v)]))};
    for (const [qid, ms] of Object.entries(data.ms)) note(system, qid, ms);
  };
  build(name); if (name === 'cohere-pro') build('cohere-pro512', 512);
  console.log(name, 'ready, tokens billed', data.tokensIn);
}

await localSystem('granite');
await localSystem('embgemma', text => 'task: search result | query: ' + text, text => 'title: none | text: ' + text);
if (!skipCohere) { await cohereSystem('cohere-pro', 'embed-v5.0-pro'); await cohereSystem('cohere-fast', 'embed-v5.0-fast'); }

// ---- rankings ------------------------------------------------------------------------------------------------------------------------
const rankings = {};
const put = (system, qid, ranked) => { (rankings[system] ??= {})[qid] = ranked.slice(0, TOP).map(row => ({id: row.id, score: +row.score.toFixed(5)})); };
const embedRank = (system, q) => { const ids = pool(q.speaker).map(item => item.id); const docs = Object.fromEntries(ids.map(id => [id, vectors[system].docs.get(byId.get(id).text)])); return rankByVector(vectors[system].q.get(q.id), ids, docs); };
for (const q of queries) {
  for (const system of Object.keys(vectors)) put(system, q.id, embedRank(system, q));
  const lexical = bm25(q.text, pool(q.speaker));
  put('bm25', q.id, lexical);
  put('granite+bm25', q.id, rrf([embedRank('granite', q), lexical]));
}

// ---- rerank ------------------------------------------------------------------------------------------------------------------------
async function rerankSystem(label, from, model) {
  if (skipCohere || !vectors[from]) return;
  const file = `rerank-${tag}-${label.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
  const store = (await cached(file, () => ({}))) ?? {};
  let calls = 0;
  for (const q of queries) {
    if (!store[q.id]) {
      const candidates = rankings[from][q.id].slice(0, TOP);
      const {json, ms} = await cohereCall('/v2/rerank', {model, query: q.text, documents: candidates.map(row => byId.get(row.id).text), top_n: candidates.length}, {kind: 'rerank'});
      store[q.id] = {ms, results: json.results.map(r => ({id: candidates[r.index].id, score: r.relevance_score}))};
      writeJson(join(cacheDir, file), store);
      calls++;
      await sleep(RERANK_GAP_MS);
    }
    put(label, q.id, store[q.id].results);
    note(label, q.id, (latency[from]?.[q.id] ?? 0) + store[q.id].ms);
    (latency[`${label}:rerankOnly`] ??= {})[q.id] = store[q.id].ms;
  }
  console.log(label, 'done,', calls, 'new rerank calls');
}
await rerankSystem('granite>rerank', 'granite', 'rerank-v5.0-pro');
await rerankSystem('cohere>rerank', 'cohere-pro', 'rerank-v5.0-pro');
await rerankSystem('coherefast>rerankfast', 'cohere-fast', 'rerank-v5.0-fast');

writeJson(join(outDir, `rankings-${tag}.json`), rankings);
writeJson(join(outDir, `latency-${tag}.json`), latency);
console.log('systems:', Object.keys(rankings).join(', '));
