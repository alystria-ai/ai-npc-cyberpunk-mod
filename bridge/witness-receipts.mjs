// Witness receipts (docs/QUEST_DECISIONS.md section 4.3, step C2). OFF unless the game's settings.witnessReceipts is on: only then does
// mod/witness-receipts.lua write runtime/witness-receipts.json. Each row says "this quest fact or journal entry newly changed at game second
// t, and these spawned companions stood within 15 m of V when the world scan noticed". resolveKnowledge (bridge/world-knowledge.mjs) uses
// the rows to let a companion who stood beside V hear a rule whose perspective is `witnessed`, which it is not a declared speaker of.
// No file, a file of another world, a malformed file or a throwing reader all mean "no receipts": the declared audience stays the floor.

const MAX_ROWS = 256, MAX_NEAR = 6;
export const RECEIPT_LIMITS = Object.freeze({rows: MAX_ROWS, near: MAX_NEAR});
const TOKEN = /^[A-Za-z0-9_:-][A-Za-z0-9._:/@+#-]{0,159}$/;
const KEY = /^[a-z0-9-]{1,80}$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const generic = key => key.startsWith('resident-');
const identifier = value => typeof value === 'string' && TOKEN.test(value) && !FORBIDDEN.has(value);
const profile = value => typeof value === 'string' && KEY.test(value) && !generic(value);
// CET encodes an empty Lua sequence as an empty JSON object.
function sequence(value, limit) {
  if (Array.isArray(value)) return value.length <= limit ? value : null;
  return value && typeof value === 'object' && Object.keys(value).length === 0 ? [] : null;
}

const PARSED = new WeakSet(), INDEXES = new WeakMap();

/** A receipts document, validated and bounded; undefined when it is not a well-formed version 1 file. Fails closed: one bad row rejects all. */
export function parseWitnessReceipts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !identifier(value.worldToken)
      || !Number.isSafeInteger(value.gameTimeSeconds) || value.gameTimeSeconds < 0) return undefined;
  const rows = sequence(value.edges, MAX_ROWS);
  if (!rows) return undefined;
  const edges = [], seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || (row.type !== 'fact' && row.type !== 'journal') || !identifier(row.key)
        || !Number.isSafeInteger(row.t) || row.t < 0 || row.t > value.gameTimeSeconds) return undefined;
    const id = `${row.type}:${row.key}`;
    if (seen.has(id)) return undefined;
    seen.add(id);
    const near = row.near === undefined ? [] : sequence(row.near, MAX_NEAR);
    if (!near || !near.every(profile) || new Set(near).size !== near.length) return undefined;
    edges.push(Object.freeze({type: row.type, key: row.key, t: row.t, near: Object.freeze([...near])}));
  }
  const parsed = Object.freeze({worldToken: value.worldToken, gameTimeSeconds: value.gameTimeSeconds, edges: Object.freeze(edges)});
  PARSED.add(parsed);
  return parsed;
}

const indexOf = parsed => {
  let index = INDEXES.get(parsed);
  if (!index) { index = new Map(parsed.edges.map(row => [`${row.type}:${row.key}`, row])); INDEXES.set(parsed, index); }
  return index;
};

/**
 * Who stood beside V when a rule became true, as far as the receipts can tell, or null (no widening).
 *
 * `evidence` is the true-leaf evidence of one matched rule (items {type: 'fact'|'journal', key, ...}). Of the items that have a receipt
 * in this world and no later than the game clock, the rule became true at the one with the greatest `t`, so the answer is the
 * intersection of the `near` sets of the receipts that share that greatest `t`. An item without a receipt is treated as having been true
 * since before receipts began (a baseline value, an old save) and does not block; if no item has a receipt there is nothing to say.
 *
 * This is an approximation, on purpose: the file records when a scan saw a value change, not when the rule first held, and who stood
 * near at the scan (up to about 30 s after the event), not who stood in the scene. A later change of a value that already satisfied the
 * rule can move the answer. Used only for `witnessed` rules, whose sentence is written for a witness, and only ever to hear more than the
 * declared audience, never less.
 */
export function receiptWitnesses({receipts, worldToken, gameTimeSeconds, evidence} = {}) {
  const parsed = PARSED.has(receipts) ? receipts : parseWitnessReceipts(receipts);
  if (!parsed || parsed.worldToken !== worldToken || !Array.isArray(evidence)) return null;
  const clock = Number.isSafeInteger(gameTimeSeconds) ? gameTimeSeconds : parsed.gameTimeSeconds;
  const index = indexOf(parsed), found = [];
  for (const item of evidence) {
    if (!item || (item.type !== 'fact' && item.type !== 'journal') || typeof item.key !== 'string') continue;
    const row = index.get(`${item.type}:${item.key}`);
    if (row && row.t <= clock) found.push(row);
  }
  if (!found.length) return null;
  const latest = Math.max(...found.map(row => row.t));
  let near = null;
  for (const row of found) {
    if (row.t !== latest) continue;
    near = near === null ? new Set(row.near) : new Set([...near].filter(key => row.near.includes(key)));
  }
  return {near, t: latest};
}

/** A reader for runtime/witness-receipts.json that re-reads only when the file changed (one stat per call). Never throws. */
export function witnessReceiptsReader(path, {readFile, statFile} = {}) {
  let stamp, cached;
  return () => {
    try {
      const info = statFile(path);
      const next = `${info.mtimeMs}:${info.size}`;
      if (next !== stamp) { stamp = next; cached = parseWitnessReceipts(JSON.parse(readFile(path))); }
      return cached;
    } catch { stamp = undefined; cached = undefined; return undefined; }
  };
}
