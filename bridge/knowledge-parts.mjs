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
import {readFile as readFileAsync} from 'node:fs/promises';
import {join} from 'node:path';
import {freezeDeep} from './parsed-snapshot.mjs';

const PARTS = new Set(['world', 'active', 'history']);
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP = 3;

let runtimeDir = null;
let read = path => readFileSync(path, 'utf8');
let readLater = path => readFileAsync(path, 'utf8');
// part name -> Map(key -> data), newest last. A part is published once per revision and never changes, so what is read from disk
// stays here, frozen, until three newer revisions of that part have been read: a turn names {part, revision}, finds the data in
// memory, and shares it (the parsers remember their work on it by object, bridge/parsed-snapshot.mjs) instead of reading the file,
// parsing 150 KB to 600 KB of JSON and cloning the result for every turn.
const store = new Map();

export function configureKnowledgeParts({runtimeDir: dir, readFile, readFileLater} = {}) {
  runtimeDir = typeof dir === 'string' && dir ? dir : null;
  if (typeof readFile === 'function') read = readFile;
  if (typeof readFileLater === 'function') readLater = readFileLater;
  store.clear();
}

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// CET's JSON encoder writes an empty Lua table as {}.
const list = value => Array.isArray(value) ? value : (plain(value) && !Object.keys(value).length ? [] : null);
const keyOf = (name, revision, generation, worldToken) => `${name}:${revision}:${generation}:${worldToken ?? ''}`;

// A part file's text as the part it is: the document when it is a well-formed part of that name, else null.
function parsePart(name, raw) {
  let value;
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BYTES) return null;
    value = JSON.parse(raw);
  } catch { return null; }
  return plain(value) && value.version === 1 && value.part === name && Number.isSafeInteger(value.revision) && value.revision >= 1 && plain(value.data) ? value : null;
}
function keep(name, key, value) {
  const parts = store.get(name) ?? new Map(); store.set(name, parts);
  parts.set(key, freezeDeep(value.data));
  while (parts.size > KEEP) parts.delete(parts.keys().next().value);
  return parts.get(key);
}

function load(name, revision, generation, worldToken) {
  if (!PARTS.has(name) || !Number.isSafeInteger(revision) || revision < 1) return null;
  const key = keyOf(name, revision, generation, worldToken);
  const kept = store.get(name)?.get(key);
  if (kept) return kept;
  if (!runtimeDir) return null;
  let raw;
  try { raw = read(join(runtimeDir, `knowledge-${name}.json`)); } catch { return null; }
  const value = parsePart(name, raw);
  if (!value || value.revision !== revision || value.generation !== generation || (value.worldToken ?? undefined) !== (worldToken ?? undefined)) return null;
  keep(name, key, value);
  return value.data;
}

/**
 * Reads, parses and freezes a part the moment the game has published it, so the first turn after a new revision finds it in memory instead of doing that work itself
 * (3 ms for a 75 KB part, about 9 ms for 300 KB, about 17 ms for the 600 KB history part, on the bridge's event loop in front of the turn: perf review 2026-10-22).
 * The file is read without blocking; only the parse is on the loop, at the time the game wrote the file and not at the turn. A part is immutable per revision, so what is
 * kept here is exactly what the turn would have read. A file that is half written, of another part, or too large is left for the turn's own read, which says so as before.
 * Resolves true when the part is in memory. Never rejects.
 */
export async function preloadKnowledgePart(name) {
  try {
    if (!PARTS.has(name) || !runtimeDir) return false;
    const value = parsePart(name, await readLater(join(runtimeDir, `knowledge-${name}.json`)));
    if (!value) return false;
    const key = keyOf(name, value.revision, value.generation, value.worldToken);
    if (store.get(name)?.has(key)) return true;
    keep(name, key, value);
    return true;
  } catch { return false; }
}

/** The files of the parts, for the bridge's file watcher: name -> handler that preloads that part. */
export const knowledgePartWatchers = () => Object.fromEntries([...PARTS].map(name => [`knowledge-${name}.json`, () => preloadKnowledgePart(name)]));

const unavailable = reason => ({version: 1, status: 'unavailable', reason});

function world(snapshot) {
  if (!plain(snapshot) || !plain(snapshot.ref)) return snapshot;
  const {ref, ...header} = snapshot;
  if (ref.part !== 'world') return unavailable('knowledge-part-invalid');
  const data = load('world', ref.revision, header.generation, header.worldToken);
  if (!data) return unavailable('knowledge-part-missing');
  const result = {...header, facts: data.facts, journal: data.journal, lifepath: data.lifepath};
  if (data.activeQuestKeys !== undefined) result.activeQuestKeys = data.activeQuestKeys;
  return result;
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
  return {...header, quests};
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
