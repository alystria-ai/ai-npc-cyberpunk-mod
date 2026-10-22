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
import {readFile as readFileAsync, stat as statAsync} from 'node:fs/promises';
import {join} from 'node:path';
import {freezeDeep} from './parsed-snapshot.mjs';

const PARTS = new Set(['world', 'active', 'history']);
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP = 3;

let runtimeDir = null;
let read = path => readFileSync(path, 'utf8');
let readLater = path => readFileAsync(path, 'utf8');
let statLater = path => statAsync(path);
// part name -> Map(key -> data), newest last. A part is published once per revision and never changes, so what is read from disk
// stays here, frozen, until three newer revisions of that part have been read: a turn names {part, revision}, finds the data in
// memory, and shares it (the parsers remember their work on it by object, bridge/parsed-snapshot.mjs) instead of reading the file,
// parsing 150 KB to 600 KB of JSON and cloning the result for every turn.
const store = new Map();

export function configureKnowledgeParts({runtimeDir: dir, readFile, readFileLater, statFileLater} = {}) {
  runtimeDir = typeof dir === 'string' && dir ? dir : null;
  if (typeof readFile === 'function') read = readFile;
  if (typeof readFileLater === 'function') readLater = readFileLater;
  if (typeof statFileLater === 'function') statLater = statFileLater;
  inflight.clear();
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

const inflight = new Map();
// The key a part file's own header gives (revision, generation, world token), read from its first bytes without parsing the file: the game writes the header first and the
// data last. null when the head has no such header (the file is then parsed once, as a whole).
function headKey(name, head) {
  const revision = /"revision"\s*:\s*(\d+)/.exec(head)?.[1], generation = /"generation"\s*:\s*(-?\d+)/.exec(head)?.[1];
  if (revision === undefined || generation === undefined) return null;
  const token = /"worldToken"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)?.[1] ?? '';
  return keyOf(name, Number(revision), Number(generation), token);
}

/**
 * Reads, parses and freezes a part in advance, for a bridge that starts while a game session is running (the supervisor restarted it): the first turn then finds the part in
 * memory instead of reading and parsing it itself (about 1 ms for a 75 KB part, 6.5 ms for 330 KB, 20 ms for the 840 KB history part, on the bridge's event loop in front of the turn).
 * It is NOT used per revision: the game publishes a part inside the turn's own capture (mod/init.lua captureKnowledge), in the same frame as the request, so a preload at that
 * moment is the turn's work done in another callback, and a second read of a file that the turn has just parsed. The file is read without blocking and its header looked at before
 * anything is parsed: a revision already in memory is never parsed again, and calls for the same part share one read. A file older than \`maxAgeMs\` is not read (it is from an earlier
 * session and could not be this one's). A part is immutable per revision, so what is kept is exactly what the turn would have read. A half-written, foreign or oversized file is left
 * for the turn's own read. Resolves true when the part is in memory. Never rejects.
 */
export function preloadKnowledgePart(name, {maxAgeMs = Infinity} = {}) {
  if (!PARTS.has(name) || !runtimeDir) return Promise.resolve(false);
  if (inflight.has(name)) return inflight.get(name);
  const path = join(runtimeDir, `knowledge-${name}.json`);
  const run = (async () => {
    try {
      if (Number.isFinite(maxAgeMs)) {
        const {mtimeMs} = await statLater(path);
        if (!(Date.now() - mtimeMs <= maxAgeMs)) return false;
      }
      const raw = await readLater(path);
      const key = typeof raw === 'string' ? headKey(name, raw.slice(0, 600)) : null;
      if (key !== null && store.get(name)?.has(key)) return true;
      const value = parsePart(name, raw);
      if (!value) return false;
      const known = keyOf(name, value.revision, value.generation, value.worldToken);
      if (!store.get(name)?.has(known)) keep(name, known, value);
      return true;
    } catch { return false; }
  })().finally(() => inflight.delete(name));
  inflight.set(name, run);
  return run;
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
