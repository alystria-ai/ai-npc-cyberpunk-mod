// Quest facts for the gate-plus of a pack (docs/QUEST_PRIMITIVES.md section 10.9): a few named facts the GAME reads (GetFactStr) and writes to
// runtime/quest-facts.json ({version: 1, at, facts: {id: value}}, only when a value changed). A pack names them in `requires.facts` ({"takemura-alive": true}); the gate
// reads them here. Missing data is always a no: a fact the game has not reported never matches, not even an expected `false`.
//
// The REAL game fact names are not known yet. `names` below are placeholders the game side tries (verify against a real save, docs/BOND_QUESTS.md section 24); the
// ids (what a pack says) never change when the names do.
import {statSync, readFileSync} from 'node:fs';

/** Every fact a pack may ask for: its kind ('bool' | 'enum'), the allowed values of an enum, and the candidate game fact names (placeholders, `verify: true`). */
export const FACTS = Object.freeze({
  'takemura-alive': Object.freeze({kind: 'bool', verify: true, names: Object.freeze(['takemura_alive', 'q113_takemura_alive']),
    about: 'Goro Takemura is alive in this save (he can die later in the main story).'}),
  'pisces-outcome': Object.freeze({kind: 'enum', values: Object.freeze(['spared', 'killed', 'unknown']), verify: true,
    names: Object.freeze(['sq026_04_pisces_spared', 'sq026_04_pisces_killed']), about: 'What V chose in Pisces (sq026_04_hiromi).'}),
});

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** Why `expected` is not a valid expectation for fact `id`, or null. An enum may name one value or a list of them. */
export function factProblem(id, expected) {
  const fact = Object.hasOwn(FACTS, id) ? FACTS[id] : null;
  if (!fact) return `${JSON.stringify(String(id)).slice(0, 40)} is not a known fact (${Object.keys(FACTS).join(', ')})`;
  if (fact.kind === 'bool') return typeof expected === 'boolean' ? null : `${id} must be true or false`;
  const list = Array.isArray(expected) ? expected : [expected];
  const ok = list.length >= 1 && list.length <= fact.values.length && list.every(item => fact.values.includes(item));
  return ok ? null : `${id} must be one of ${fact.values.join(', ')} (or a list of them)`;
}

/** Whether the facts the game reported satisfy one expectation. A fact that is not there is a no. */
export function factMatches(facts, id, expected) {
  if (factProblem(id, expected)) return false;
  if (!plain(facts) || !Object.hasOwn(facts, id)) return false;
  const value = facts[id];
  return Array.isArray(expected) ? expected.includes(value) : value === expected;
}

/** The fact ids a list of `requires` objects asks for, once each, in the shape of the play file's `factsWanted`: [{id, names, kind}]. */
export function wantedFacts(requiresList) {
  const ids = new Set();
  for (const requires of requiresList) if (plain(requires?.facts)) for (const id of Object.keys(requires.facts)) if (Object.hasOwn(FACTS, id)) ids.add(id);
  return [...ids].sort().map(id => ({id, names: [...FACTS[id].names], kind: FACTS[id].kind}));
}

/** The game's facts file text -> {at, facts} (known ids and valid values only), or null. */
export function parseFacts(text) {
  if (typeof text !== 'string' || text.length > 16 * 1024) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!plain(value) || value.version !== 1 || !plain(value.facts)) return null;
  const facts = {};
  for (const [id, fact] of Object.entries(value.facts)) {
    if (Object.hasOwn(FACTS, id) && !factProblem(id, fact)) facts[id] = fact;
  }
  return {at: Number.isSafeInteger(value.at) && value.at >= 0 ? value.at : null, facts};
}

/**
 * A reader of the facts file for the runner: `read()` -> the facts object (empty when there is no file). It looks at the file's modified time at most once per
 * `minIntervalMs` and reads the text only when that changed, so a gate that is checked often costs a number compare. `statFile(path) -> {mtimeMs} | null` and
 * `readText(path) -> string` are injectable; a failure is an empty answer (and a retry on the next check), never an error.
 */
export function createFactsReader({path, statFile = file => { try { return statSync(file); } catch { return null; } },
  readText = file => readFileSync(file, 'utf8'), now = Date.now, minIntervalMs = 5000} = {}) {
  let checkedAt = -Infinity, mtime = null, cached = {};
  return function read() {
    if (!path) return cached;
    const at = now();
    if (at - checkedAt < minIntervalMs) return cached;
    checkedAt = at;
    try {
      const info = statFile(path);
      if (!info) { mtime = null; cached = {}; return cached; }
      if (info.mtimeMs === mtime) return cached;
      const parsed = parseFacts(readText(path));
      if (!parsed) return cached;
      mtime = info.mtimeMs; cached = parsed.facts;
    } catch { /* an unreadable file is read again at the next check */ }
    return cached;
  };
}
