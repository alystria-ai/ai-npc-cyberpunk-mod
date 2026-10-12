// The world facts and journal inventory of a turn, rebuilt from the parts the game publishes once per revision
// (mod/knowledge-parts.lua; docs/PERFORMANCE_NATIVE_PLAN.md item 1b). A request names them instead of carrying them:
//   worldKnowledge: the snapshot header plus ref = {part: 'world', revision}; the facts, journal states, lifepath and
//     active quest keys are in runtime/knowledge-world.json.
//   journalHistory: the snapshot header plus lanes = {history|active: {revision, ids}}; each named row is in
//     runtime/knowledge-<lane>.json (data.quests, keyed by id). Rows of a lane still in its first scan stay inline in quests.
// resolveKnowledgeParts returns the request with both rebuilt into exactly the shapes mod/world-knowledge.lua capture()
// and mod/journal-history.lua capture() produce, so every parser and rule downstream is unchanged. A part that cannot
// be read, or whose revision or world binding differs, makes that snapshot unavailable for the turn (never a guess).
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const PARTS = new Set(['world', 'active', 'history']);
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP = 3;

let runtimeDir = null;
let read = path => readFileSync(path, 'utf8');
// part name -> Map(key -> data), newest last.
const store = new Map();

export function configureKnowledgeParts({runtimeDir: dir, readFile} = {}) {
  runtimeDir = typeof dir === 'string' && dir ? dir : null;
  if (typeof readFile === 'function') read = readFile;
  store.clear();
}

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// CET's JSON encoder writes an empty Lua table as {}.
const list = value => Array.isArray(value) ? value : (plain(value) && !Object.keys(value).length ? [] : null);
const keyOf = (name, revision, generation, worldToken) => `${name}:${revision}:${generation}:${worldToken ?? ''}`;

function load(name, revision, generation, worldToken) {
  if (!PARTS.has(name) || !Number.isSafeInteger(revision) || revision < 1) return null;
  const key = keyOf(name, revision, generation, worldToken);
  const kept = store.get(name)?.get(key);
  if (kept) return kept;
  if (!runtimeDir) return null;
  let value;
  try {
    const raw = read(join(runtimeDir, `knowledge-${name}.json`));
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BYTES) return null;
    value = JSON.parse(raw);
  } catch { return null; }
  if (!plain(value) || value.version !== 1 || value.part !== name || value.revision !== revision
    || value.generation !== generation || (value.worldToken ?? undefined) !== (worldToken ?? undefined) || !plain(value.data)) return null;
  const parts = store.get(name) ?? new Map(); store.set(name, parts);
  parts.set(key, value.data);
  while (parts.size > KEEP) parts.delete(parts.keys().next().value);
  return value.data;
}

const unavailable = reason => ({version: 1, status: 'unavailable', reason});

function world(snapshot) {
  if (!plain(snapshot) || !plain(snapshot.ref)) return snapshot;
  const {ref, ...header} = snapshot;
  if (ref.part !== 'world') return unavailable('knowledge-part-invalid');
  const data = load('world', ref.revision, header.generation, header.worldToken);
  if (!data) return unavailable('knowledge-part-missing');
  const result = {...header, facts: data.facts, journal: data.journal, lifepath: data.lifepath};
  if (data.activeQuestKeys !== undefined) result.activeQuestKeys = data.activeQuestKeys;
  return structuredClone(result);
}

function history(snapshot) {
  if (!plain(snapshot) || snapshot.lanes === undefined) return snapshot;
  const {lanes, ...header} = snapshot;
  const inline = list(header.quests);
  if (!plain(lanes) || !inline) return unavailable('knowledge-part-invalid');
  const quests = [...inline];
  for (const [name, lane] of Object.entries(lanes)) {
    const ids = plain(lane) ? list(lane.ids) : null;
    if ((name !== 'active' && name !== 'history') || !ids) return unavailable('knowledge-part-invalid');
    const data = load(name, lane.revision, header.generation, header.worldToken);
    if (!data || !plain(data.quests)) return unavailable('knowledge-part-missing');
    for (const id of ids) {
      const row = typeof id === 'string' ? data.quests[id] : undefined;
      if (!plain(row)) return unavailable('knowledge-part-missing');
      quests.push(row);
    }
  }
  // capture() orders rows by id (Lua's string sort, the same as JavaScript's default).
  quests.sort((a, b) => (String(a?.id) < String(b?.id) ? -1 : String(a?.id) > String(b?.id) ? 1 : 0));
  return structuredClone({...header, quests});
}

/** The request with any part references replaced by the full snapshots. Inputs without references are returned as is. */
export function resolveKnowledgeParts(value) {
  if (!plain(value)) return value;
  const hasWorld = plain(value.worldKnowledge) && value.worldKnowledge.ref !== undefined;
  const hasHistory = plain(value.journalHistory) && value.journalHistory.lanes !== undefined;
  if (!hasWorld && !hasHistory) return value;
  return {...value,
    ...(hasWorld ? {worldKnowledge: world(value.worldKnowledge)} : {}),
    ...(hasHistory ? {journalHistory: history(value.journalHistory)} : {})};
}
