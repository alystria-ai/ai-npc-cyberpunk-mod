// Shared helpers of the retrieval eval (docs/COHERE_RETRIEVAL_EVAL_2026-10-30.md). No key is stored here: keys are read from the
// developer's keys file at run time, only inside these functions, and never printed or logged.
import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '..', '..');
export const localDir = join(here, 'local');          // git-ignored: caches, real-memory data, judge files
export const cacheDir = join(localDir, 'cache');
mkdirSync(cacheDir, {recursive: true});

const KEYS_FILE = process.env.KEYS_FILE || 'C:/Users/akshi/Desktop/Code Palace/Commonly used Keys.txt';
export function readKey(name) {
  const line = readFileSync(KEYS_FILE, 'utf8').split(/\r?\n/).find(row => row.startsWith(name + '='));
  const value = line?.slice(name.length + 1).trim();
  if (!value) throw new Error(`no ${name}= line in the keys file`);
  return value;
}

export const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));   // judge files may carry a BOM
export const writeJson = (path, value) => { mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, JSON.stringify(value)); };
export const cached = (name, make) => {
  const path = join(cacheDir, name);
  if (existsSync(path)) return readJson(path);
  return Promise.resolve(make()).then(value => { writeJson(path, value); return value; });
};
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
export const median = values => percentile(values, 0.5);

// ---- Cohere ----------------------------------------------------------------------------------------------------------------------
const COUNTER = join(localDir, 'cohere-calls.json');
export function countCall(kind, keyName) {
  const state = existsSync(COUNTER) ? readJson(COUNTER) : {};
  const bucket = state[keyName] ??= {};
  bucket[kind] = (bucket[kind] || 0) + 1;
  writeJson(COUNTER, state);
}

/** One Cohere call. Returns {json, ms, headers: {rate-limit style headers only}}. Retries 429 a few times, honouring Retry-After. */
export async function cohereCall(path, body, {keyName = 'cohere', base = 'https://api.cohere.com', retries = 4, kind = path} = {}) {
  const key = readKey(keyName);
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    const response = await fetch(base + path, {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer ' + key}, body: JSON.stringify(body)});
    const ms = performance.now() - started;
    countCall(kind, keyName);
    const text = await response.text();
    const headers = {};
    for (const [name, value] of response.headers) if (/limit|remaining|retry|trial|billed/i.test(name)) headers[name] = value;
    if (response.status === 429 && attempt < retries) {
      const wait = Math.max(Number(response.headers.get('retry-after')) * 1000 || 0, 7000 * (attempt + 1));
      await sleep(wait);
      continue;
    }
    if (!response.ok) { const error = new Error(`Cohere ${path} HTTP ${response.status}: ${text.slice(0, 300)}`); error.status = response.status; error.body = text; throw error; }
    return {json: JSON.parse(text), ms, headers};
  }
}

// ---- Local embedders (the mod's own class, bridge/local-embed.mjs) ----------------------------------------------------------------
export const LOCAL_AI = process.env.LOCAL_AI_DIR || 'C:/Users/akshi/Desktop/Code Palace/Cyberpunk Mod/local-ai';
export const LOCAL_MODELS = {
  granite: {file: join(LOCAL_AI, 'dl-granite-emb/granite-embedding-107m-multilingual-Q8_0.gguf'), dim: 384, id: 'granite-embedding-107m-multilingual-q8_0'},
  embgemma: {file: join(LOCAL_AI, 'dl-embgemma/embeddinggemma-300M-Q8_0.gguf'), dim: 768, id: 'embeddinggemma-300m-q8_0'},
};
export async function localEmbedder(name, {threads = 1} = {}) {
  const {LlamaEmbedder} = await import(pathToFileURL(join(root, 'bridge/local-embed.mjs')));
  const model = LOCAL_MODELS[name];
  const pack = {server: join(LOCAL_AI, 'llama-cpu/llama-server.exe'), embed: model};
  return new LlamaEmbedder({pack, threads, idleMs: 0, startupMs: 120_000, log: () => {}});
}

// ---- Retrieval maths -------------------------------------------------------------------------------------------------------------
export const dot = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i] * b[i]; return sum; };
export function unit(vector) {
  const out = Float32Array.from(vector);
  let sum = 0; for (const value of out) sum += value * value;
  const length = Math.sqrt(sum) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= length;
  return out;
}
/** Ranked ids by cosine. `docs` is {id: vector}. */
export function rankByVector(queryVec, ids, vectors) {
  return ids.map(id => ({id, score: dot(queryVec, vectors[id])})).sort((a, b) => b.score - a.score);
}

// BM25 over the pool of one speaker (the words the mod already ranks facts by, but weighted by rarity).
const STOP = new Set('the and you your are was were what when where who with that this have has had did not for but can his her she him they them its out our all one just like about from into then than there their been being also some more very still ever never really'.split(' '));
export const tokens = text => (String(text).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter(word => !STOP.has(word));
export function bm25(queryText, docs, {k1 = 1.2, b = 0.75} = {}) {
  const rows = docs.map(doc => ({id: doc.id, words: tokens(doc.text)}));
  const average = rows.reduce((sum, row) => sum + row.words.length, 0) / (rows.length || 1);
  const df = new Map();
  for (const row of rows) for (const word of new Set(row.words)) df.set(word, (df.get(word) || 0) + 1);
  const query = [...new Set(tokens(queryText))];
  return rows.map(row => {
    const tf = new Map();
    for (const word of row.words) tf.set(word, (tf.get(word) || 0) + 1);
    let score = 0;
    for (const word of query) {
      const f = tf.get(word); if (!f) continue;
      const idf = Math.log(1 + (rows.length - df.get(word) + 0.5) / (df.get(word) + 0.5));
      score += idf * f * (k1 + 1) / (f + k1 * (1 - b + b * row.words.length / average));
    }
    return {id: row.id, score};
  }).sort((a, b) => b.score - a.score);
}
/** Reciprocal rank fusion of ranked id lists. */
export function rrf(lists, k = 60) {
  const score = new Map();
  for (const list of lists) list.forEach((row, index) => score.set(row.id, (score.get(row.id) || 0) + 1 / (k + index + 1)));
  return [...score].map(([id, value]) => ({id, score: value})).sort((a, b) => b.score - a.score);
}

// ---- Metrics ---------------------------------------------------------------------------------------------------------------------
/** ranked: [{id}], gold: Set of ids. recall@k is the share of the gold items (at most k of them) found in the top k. */
export function metrics(ranked, gold, k = 5) {
  const ids = ranked.map(row => row.id);
  const top = ids.slice(0, k);
  const found = top.filter(id => gold.has(id)).length;
  const first = ids.findIndex(id => gold.has(id));
  return {
    recall: found / Math.min(gold.size, k),
    hit: found > 0 ? 1 : 0,
    rr: first < 0 ? 0 : 1 / (first + 1),
    hit1: ids[0] !== undefined && gold.has(ids[0]) ? 1 : 0,
  };
}
