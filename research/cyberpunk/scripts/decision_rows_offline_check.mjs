// Offline evidence for the decision rows of docs/QUEST_DECISIONS.md section 4.2, from data on disk only (no game, no bridge).
//
//   node research/cyberpunk/scripts/decision_rows_offline_check.mjs [--spec file] [--saves "<Saved Games dir>"] [--out file]
//
// For every row of the spec and every selector it reads (the condition's facts and journal entries, plus the `newJournal` paths a
// draft names) the report lists what the extracted game data and the real saves say:
//   facts   : is the name in the fact dictionary, how many assignments (writers) and comparisons (readers) the quest graphs hold,
//             whether a positive writer sits in a hash-bound scene export, how many saves hold it non-zero and with which values.
//   journal : is the path in the cooked journal and in the quest graphs, which state each real save holds.
//   row     : how many saves satisfy the whole condition, and the deterministic offline grade (below).
// This tool never decides that a branch is exclusive or that a statement is true. It checks that the names exist, that the writers
// the research notes cite exist, and what the saves actually show. Exclusivity of a branch stays a reading of the scene graph
// (the row's `notes`); only a real play-through can show that the game sets the fact on that branch.
//
// Offline grades:
//   anchored-and-seen        every selector exists, every fact has a hash-bound positive writer (or is already in the pack), and the
//                            whole condition holds in at least one real save
//   anchored-not-seen        the same, but no save satisfies the condition (the branch was never taken in these saves: live check)
//   writer-unbound           a fact is read by a quest graph but no positive writer is in a hash-bound export (export it first)
//   missing-selector         a fact has no writer anywhere (scene exports included) and is not in the pack, or a journal path is not in
//                            the cooked journal: a typo or a dead row
//   not-executable           the draft has no complete condition (the notes say so, or it needs a journal entry the pack does not read)
// A fact is known when the fact dictionary names it, a quest graph assigns it, a hash-bound scene export writes it, or the pack
// already reads it. Facts written only by scenes are not in the dictionary (it indexes quest graphs, not scenes).
//
// A row may carry `offline: {contrast: ["fact:name", "journal:path-or-pack-key"]}`: related selectors that are cross-tabulated with
// the row's own across the saves (combos), so that the exclusivity a note claims can be compared with what real saves hold.
import {readFile, writeFile, readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), research = resolve(here, '..'), root = resolve(research, '../..');
const STATE_NAMES = {1: 'inactive', 2: 'active', 3: 'succeeded', 4: 'failed'};

/** Leaves of a condition tree, depth-first. */
export function leavesOf(node, out = []) {
  if (node?.all || node?.any) for (const child of node.all || node.any) leavesOf(child, out);
  else if (node) out.push(node);
  return out;
}

/** Evaluate a spec condition against one save. `factValue(name)` is an integer (0 when absent); `journalState(key)` a state name or undefined. */
export function holds(node, {factValue, journalState}) {
  if (!node) return false;
  if (node.all) return node.all.every(child => holds(child, {factValue, journalState}));
  if (node.any) return node.any.some(child => holds(child, {factValue, journalState}));
  if (node.type === 'fact') {
    const value = factValue(node.key);
    switch (node.op) {
      case 'eq': return value === node.value;
      case 'ne': return value !== node.value;
      case 'gte': return value >= node.value;
      case 'lte': return value <= node.value;
      case 'in': return node.value.includes(value);
      default: return false;
    }
  }
  if (node.type === 'journal') {
    const state = journalState(node.key);
    if (node.op === 'eq') return state === node.value;
    if (node.op === 'in') return node.value.includes(state);
    if (node.op === 'ne') return state !== undefined && state !== node.value;
  }
  return false;
}

/** The offline grade of a row from its collected selector evidence (see the header). */
export function gradeRow(row, {facts, journals, conditionHolds}) {
  if (!row.condition || /DRAFT ONLY|this draft cannot execute/i.test(row.notes || '')) return 'not-executable';
  const known = fact => fact.inDictionary || fact.writers.assignments > 0 || fact.writers.hashBoundPositive > 0 || fact.alreadyInPack;
  if (facts.some(fact => !known(fact)) || journals.some(entry => !entry.inCookedJournal)) return 'missing-selector';
  if (facts.some(fact => !fact.writers.hashBoundPositive && !fact.alreadyInPack)) return 'writer-unbound';
  return conditionHolds > 0 ? 'anchored-and-seen' : 'anchored-not-seen';
}

/** "fact:name" or "journal:path" (a pack key is resolved to its native path) -> {type, key}. */
export function parseSelector(text) {
  const at = String(text).indexOf(':');
  if (at < 1) throw Error(`Bad selector ${text}`);
  const type = text.slice(0, at);
  if (type !== 'fact' && type !== 'journal') throw Error(`Bad selector type ${text}`);
  return {type, key: text.slice(at + 1)};
}

/** Cross-tabulate selector values over the saves. `valueOf(save, selector)` returns a short string. Rows are sorted by save count,
 *  then by values, and carry the save kinds (life path and body: CM = corporate male ...) so that one long run is not read as many. */
export function crossTab(saves, selectors, valueOf, kindOf) {
  const combos = new Map();
  for (const save of saves) {
    const values = selectors.map(selector => valueOf(save, selector)), id = values.join('\u0000');
    if (!combos.has(id)) combos.set(id, {values, saves: 0, kinds: {}});
    const entry = combos.get(id);
    entry.saves += 1;
    const kind = kindOf(save);
    entry.kinds[kind] = (entry.kinds[kind] || 0) + 1;
  }
  return [...combos.values()].sort((a, b) => b.saves - a.saves || a.values.join().localeCompare(b.values.join()));
}

const short = depot => String(depot).split('\\').slice(-2).join('/');
const unique = (list, limit) => [...new Set(list)].slice(0, limit);

async function readJson(path) { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }

/** Stream the fact index once: assignment and comparison rows for the wanted names. */
async function factUsage(indexPath, names) {
  const usage = new Map([...names].map(name => [name, {assignments: [], comparisons: []}]));
  for await (const line of createInterface({input: createReadStream(indexPath)})) {
    const hit = line.match(/"factName":"([^"]+)"/);
    if (!hit || !usage.has(hit[1])) continue;
    const row = JSON.parse(line), list = row.role === 'assignment' ? usage.get(hit[1]).assignments
      : row.role === 'comparison' ? usage.get(hit[1]).comparisons : null;
    list?.push({depot: row.source.depotPath, value: row.value, comparisonType: row.comparisonType});
  }
  return usage;
}

/** Stream the journal path index: which quest graphs reference each wanted path, and with which class. */
async function journalUsage(indexPath, paths) {
  const usage = new Map([...paths].map(path => [path, {classes: new Set(), depots: new Set()}]));
  for await (const line of createInterface({input: createReadStream(indexPath)})) {
    const hit = line.match(/"path":"([^"]+)"/);
    if (!hit || !usage.has(hit[1])) continue;
    const row = JSON.parse(line), entry = usage.get(hit[1]);
    if (row.className) entry.classes.add(row.className);
    entry.depots.add(row.source.depotPath);
  }
  return usage;
}

async function cookedJournal(indexPath, paths) {
  const found = new Map();
  for await (const line of createInterface({input: createReadStream(indexPath)})) {
    const hit = line.match(/"path":"([^"]+)"/);
    if (!hit || !paths.has(hit[1])) continue;
    const row = JSON.parse(line);
    if (row.type) found.set(hit[1], row.type);
  }
  return found;
}

/** Build the report. `saves` is a list of {facts: Map(hash -> value), journal: Map(hash -> state int), kind}; `hashes` = {fnv1a32, murmur3}. */
export async function buildReport({spec, pack, cache, saves, hashes, writersOf}) {
  const rows = spec.rows;
  const factNames = new Set(), journalPaths = new Set();
  const pathOf = key => pack.journalAllowlist[key]?.nativePath ?? key;
  const selectorsOf = row => [...leavesOf(row.condition).map(leaf => ({type: leaf.type, key: leaf.key})),
    ...(row.offline?.contrast || []).map(parseSelector)];
  for (const row of rows) {
    for (const selector of selectorsOf(row)) (selector.type === 'fact' ? factNames : journalPaths).add(selector.type === 'fact' ? selector.key : pathOf(selector.key));
    for (const extra of row.newJournal || []) journalPaths.add(extra.nativePath);
  }
  const index = resolve(cache, 'index');
  const [dictionary, usage, journalRefs, cooked] = await Promise.all([
    readJson(resolve(index, 'facts-dictionary.json')), factUsage(resolve(index, 'facts.jsonl'), factNames),
    journalUsage(resolve(index, 'journal-paths.jsonl'), journalPaths), cookedJournal(resolve(index, 'journal.jsonl'), journalPaths)]);
  const dictionaryByName = new Map(dictionary.facts.map(fact => [fact.name, fact]));
  const writers = await writersOf(factNames);
  const factValue = (save, name) => save.facts.get(hashes.fnv1a32(name)) ?? 0;
  const journalState = (save, path) => STATE_NAMES[save.journal.get(hashes.murmur3(path))];
  const valueOf = (save, selector) => selector.type === 'fact' ? String(factValue(save, selector.key))
    : (journalState(save, pathOf(selector.key)) ?? '-').slice(0, 4);
  const factReport = name => {
    const entry = usage.get(name), seen = new Map();
    for (const save of saves) { const value = factValue(save, name); if (value) seen.set(value, (seen.get(value) || 0) + 1); }
    const collected = writers.get(name) ?? {bound: [], unbound: []};
    const positive = writer => (Number(writer.value) || 0) > 0;
    return {key: name, type: 'fact', inDictionary: dictionaryByName.has(name), roles: dictionaryByName.get(name)?.roles ?? null,
      alreadyInPack: Boolean(pack.factAllowlist[name]),
      writers: {assignments: entry.assignments.length, positive: entry.assignments.filter(positive).length,
        hashBoundPositive: collected.bound.filter(positive).length,
        sceneWriterDepots: unique(collected.bound.map(writer => short(writer.depot)), 4),
        graphWriterDepots: unique(entry.assignments.map(a => short(a.depot)), 4)},
      readers: {comparisons: entry.comparisons.length, depots: unique(entry.comparisons.map(c => short(c.depot)), 4)},
      saves: {of: saves.length, nonZero: [...seen.values()].reduce((a, b) => a + b, 0), values: Object.fromEntries(seen)}};
  };
  const journalReport = (key, path, nativeClass) => {
    const states = {};
    for (const save of saves) { const state = journalState(save, path) ?? 'absent'; states[state] = (states[state] || 0) + 1; }
    const refs = journalRefs.get(path);
    return {key, type: 'journal', nativePath: path, nativeClass: nativeClass ?? null, inCookedJournal: cooked.has(path),
      cookedType: cooked.get(path) ?? null, classesInGraphs: [...(refs?.classes ?? [])], graphFiles: refs?.depots.size ?? 0,
      saves: {of: saves.length, states}};
  };
  const report = [];
  for (const row of rows) {
    const facts = [], journals = [];
    for (const leaf of unique(leavesOf(row.condition).map(l => `${l.type}:${l.key}`), 99)) {
      const {type, key} = parseSelector(leaf);
      if (type === 'fact') facts.push(factReport(key));
      else journals.push(journalReport(key, pathOf(key), pack.journalAllowlist[key]?.nativeClass));
    }
    const extra = (row.newJournal || []).map(item => journalReport(item.nativePath, item.nativePath, item.nativeClass));
    const conditionHolds = row.condition ? saves.filter(save => holds(row.condition, {
      factValue: name => factValue(save, name), journalState: key => journalState(save, pathOf(key))})).length : 0;
    const selectors = unique(selectorsOf(row).map(s => `${s.type}:${s.key}`), 12).map(parseSelector);
    report.push({id: row.id, status: row.status, decisionId: row.decisionId, outcomeKey: row.outcomeKey,
      grade: gradeRow(row, {facts, journals: [...journals, ...extra], conditionHolds}),
      conditionHoldsInSaves: conditionHolds, facts, journals, extraJournal: extra,
      combos: {selectors: selectors.map(s => `${s.type}:${s.key}`), rows: crossTab(saves, selectors, valueOf, save => save.kind)}});
  }
  return report;
}

async function main() {
  const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
  const spec = await readJson(resolve(arg('--spec', resolve(research, 'decision-rows-b.json'))));
  const pack = await readJson(resolve(root, 'characters/world-knowledge.json'));
  const cache = resolve(research, 'cache/game');
  const {saveState: readSaveState, fnv1a32, murmur3} = await import(pathToFileURL(resolve(here, 'save_snapshot.mjs')).href);
  const {collectWriters} = await import(pathToFileURL(resolve(here, 'decision_rows.mjs')).href);
  const savesDir = arg('--saves');
  const saves = [];
  if (savesDir) for (const name of (await readdir(savesDir)).sort()) {
    try {
      const state = readSaveState(resolve(savesDir, name, 'sav.dat')), meta = state.metadata || {};
      saves.push({facts: state.facts, journal: state.journal, kind: `${String(meta.lifePath || '?')[0]}${String(meta.bodyGender || '?')[0]}`});
    } catch { /* not a save */ }
  }
  const rows = await buildReport({spec, pack, cache, saves, hashes: {fnv1a32, murmur3}, writersOf: names => collectWriters(cache, names)});
  const grades = {};
  for (const row of rows) grades[row.grade] = (grades[row.grade] || 0) + 1;
  const path = resolve(arg('--out', resolve(research, 'generated/decision-rows-offline-check.json')));
  await writeFile(path, JSON.stringify({version: 1, savesRead: saves.length, grades, rows}, null, 2) + '\n');
  console.log(JSON.stringify({savesRead: saves.length, grades, written: path}, null, 2));
  for (const row of rows) console.log(`${row.status.padEnd(10)} ${row.grade.padEnd(17)} saves=${String(row.conditionHoldsInSaves).padStart(3)} ${row.id}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
