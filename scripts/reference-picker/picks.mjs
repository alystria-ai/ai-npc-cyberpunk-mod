// The reference picker's action log and the state derived from it.
//
// runtime/reference-picks.jsonl is the record: one JSON object per line, appended for every action. The kept
// sets, rejections, notes, candidate sets and play counts are always rebuilt by replaying it (replayPicks), so
// nothing can drift from the log. runtime/reference-picks.json is that replay written out for people and for
// quick inspection; Apply-ReferencePicks.mjs replays the log itself and does not trust the JSON.
//
// One log line:
//   {"seq":12,"ts":"2026-10-06T01:02:03.456Z","voice":"judy-alvarez","engine":"pocket","set":"pocket",
//    "action":"reroll","clips":["judy-alvarez/..","judy-alvarez/.."],"seconds":17.4,"line":0,"note":"",...}
// engine and set are "pocket", "omni-short" or "omni" (each has its own clip set; see SETS), or engine "all". Older lines that name
// removed sets (pocket-short, pocket-single, omni-single) or the old shared ids "full" / "short" replay without error: what no longer exists is ignored.
// actions: reroll | manual-set | restore | keep | unkeep | reject | unreject | note | verdict | regenerate | regenerate-done |
//          regenerate-failed | play
// verdict: "fine" (the generated audio sounds fine) | "bad" (bad, fix the references) | "" (cleared).
// play: what is "sample" (one of the user's own renders; target = its slot) or "clip" (a reference clip; target = its id).
//       (Old lines with what "research" replay as plain play counts.)
import {appendFile, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

export const ENGINES = Object.freeze(['pocket', 'omni-short', 'omni']);
// The measure of a reference is its total DURATION, not the number of clips: any number of whole clips is fine as long as they
// join (with 0.4 s gaps) within the budget. Three sets, each with its own candidate clips; the set id is the engine id:
//   pocket      one Pocket reference, up to 30 s (the bridge's own Pocket reference limit)
//   omni-short  OmniVoice short reference, up to 10 s
//   omni        OmniVoice long reference, up to 18 s
// (Older log lines used set "full" for one shared Pocket+Omni set and "short" for the short Omni set; replay maps those.)
export const SETS = Object.freeze({
  pocket: {budget: 30, label: 'Pocket reference'},
  'omni-short': {budget: 10, label: 'OmniVoice short reference'},
  omni: {budget: 18, label: 'OmniVoice long reference'},
});
export const engineSet = engine => engine;

const SET_ACTIONS = new Set(['reroll', 'manual-set', 'restore']);
const HISTORY_LIMIT = 40;

const perSet = make => Object.fromEntries(Object.keys(SETS).map(set => [set, make()]));
export const emptyVoice = () => ({candidate: perSet(() => null), history: perSet(() => []),
  kept: {}, rejected: [], note: '', verdict: null, plays: {}, updated: null});

export function parseLog(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a torn last line must not stop the replay */ }
  }
  return entries;
}

export function applyEntry(state, entry) {
  const voice = entry?.voice;
  if (typeof voice !== 'string' || !voice) return state;
  const row = state.voices[voice] ??= emptyVoice();
  row.updated = entry.ts ?? row.updated;
  if (SET_ACTIONS.has(entry.action) && Array.isArray(entry.clips) && (Object.hasOwn(SETS, entry.set) || entry.set === 'full' || entry.set === 'short')) {
    const targets = entry.set === 'full' ? ['pocket', 'omni'] : entry.set === 'short' ? ['omni-short'] : [entry.set];
    for (const target of targets) {
      row.candidate[target] = [...entry.clips];
      const key = entry.clips.join('|');
      row.history[target] = [{clips: [...entry.clips], seconds: entry.seconds ?? null, ts: entry.ts, action: entry.action},
        ...row.history[target].filter(item => item.clips.join('|') !== key)].slice(0, HISTORY_LIMIT);
    }
  } else if (entry.action === 'keep' && ENGINES.includes(entry.engine) && Array.isArray(entry.clips)) {
    row.kept[entry.engine] = {clips: [...entry.clips], seconds: entry.seconds ?? null, ts: entry.ts, note: entry.note ?? ''};
  } else if (entry.action === 'unkeep' && ENGINES.includes(entry.engine)) {
    delete row.kept[entry.engine];
  } else if (entry.action === 'reject' && Array.isArray(entry.clips)) {
    const legacy = {full: ['pocket', 'omni'], short: ['omni-short']}[entry.set];
    // A rejection of a removed set (pocket-short, ...) is dropped; one with no set stays (set null).
    for (const set of legacy ?? [entry.set ?? null]) if (set === null || Object.hasOwn(SETS, set)) row.rejected.push({set, engine: entry.engine, clips: [...entry.clips], ts: entry.ts, note: entry.note ?? ''});
  } else if (entry.action === 'unreject' && Array.isArray(entry.clips)) {
    const key = entry.clips.join('|');
    const at = row.rejected.findLastIndex(item => item.set === (entry.set ?? null) && item.clips.join('|') === key);
    if (at >= 0) row.rejected.splice(at, 1);
  } else if (entry.action === 'note') {
    row.note = entry.note ?? '';
  } else if (entry.action === 'verdict') {
    row.verdict = entry.verdict ? {value: entry.verdict, ts: entry.ts, line: entry.line ?? 0} : null;
  } else if (entry.action === 'play') {
    const key = `${entry.what ?? 'audio'}:${entry.target ?? ''}`;
    row.plays[key] = (row.plays[key] ?? 0) + 1;
  }
  return state;
}

export function replayPicks(entries) {
  const state = {voices: {}, entries: 0, lastSeq: 0};
  for (const entry of entries) {
    applyEntry(state, entry);
    state.entries++;
    if (Number.isSafeInteger(entry?.seq)) state.lastSeq = Math.max(state.lastSeq, entry.seq);
  }
  return state;
}

export async function readPicks(logPath) {
  let text = '';
  try { text = await readFile(logPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return replayPicks(parseLog(text));
}

// The JSON written beside the log: kept sets per voice and engine first, then the working state.
export function derivedPicks(state, {source = 'runtime/reference-picks.jsonl', now = new Date()} = {}) {
  const voices = {}, columns = {};
  for (const [key, row] of Object.entries(state.voices)) {
    const plays = Object.values(row.plays).reduce((a, b) => a + b, 0);
    if (!Object.keys(row.kept).length && !row.rejected.length && !row.note && !row.verdict && !Object.values(row.candidate).some(Boolean) && !plays) continue;
    // Which of the user's own renders were played most for this voice (what:target -> count).
    const topColumns = Object.entries(row.plays).filter(([name]) => name.startsWith('sample:'))
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({column: name, plays: count}));
    for (const [name, count] of Object.entries(row.plays)) if (name.startsWith('sample:')) columns[name] = (columns[name] ?? 0) + count;
    voices[key] = {verdict: row.verdict, kept: row.kept, rejected: row.rejected, note: row.note,
      candidate: row.candidate, topColumns, plays: row.plays, updated: row.updated};
  }
  return {version: 1, updated: now.toISOString(), source, entries: state.entries, columnPlays: columns, voices};
}

async function writeAtomic(path, text) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text);
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, path); return; } catch (error) {
      // Windows can briefly refuse a rename while another process (an editor, a backup) has the target open.
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await new Promise(done => setTimeout(done, 40 * (attempt + 1)));
    }
  }
}

export class PickStore {
  constructor({logPath, jsonPath, now = () => new Date()}) {
    Object.assign(this, {logPath, jsonPath, now});
    this.state = {voices: {}, entries: 0, lastSeq: 0};
    this.tail = Promise.resolve();
  }
  async load() {
    await mkdir(dirname(this.logPath), {recursive: true});
    this.state = await readPicks(this.logPath);
    await this.writeDerived();
    return this.state;
  }
  voice(key) { return this.state.voices[key] ?? emptyVoice(); }
  // Append one action. The entry is applied to the in-memory state immediately and written in order.
  append(entry) {
    const full = {seq: ++this.state.lastSeq, ts: this.now().toISOString(), ...entry};
    applyEntry(this.state, full);
    this.state.entries++;
    const write = this.tail.then(async () => {
      await appendFile(this.logPath, JSON.stringify(full) + '\n');
      if (full.action !== 'play') await this.writeDerived();
    });
    this.tail = write.catch(() => {});
    return write.then(() => full);
  }
  writeDerived() {
    const text = JSON.stringify(derivedPicks(this.state, {now: this.now()}), null, 1) + '\n';
    return writeAtomic(this.jsonPath, text);
  }
  flush() { return this.tail; }
}
