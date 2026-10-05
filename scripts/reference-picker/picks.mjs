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
// engine and set are "pocket", "pocket-short", "omni" or "omni-short" (each has its own clip set), or engine "all".
// actions: reroll | manual-set | restore | keep | unkeep | reject | unreject | note | verdict | regenerate | regenerate-done |
//          regenerate-failed | play
// verdict: "fine" (the generated audio sounds fine) | "bad" (bad, fix the references) | "" (cleared).
// play: what is "research" (a column of the research listening report; target = its condition id), "sample" (one of
//       the user's own renders; target = its slot) or "clip" (a reference clip; target = its id).
import {appendFile, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

export const ENGINES = Object.freeze(['pocket', 'pocket-short', 'omni', 'omni-short']);
// Each engine variant has its own candidate clip set: Pocket and OmniVoice, each with an 18 s and a 10 s set. The set id is the
// engine id. (Older log lines used set "full" for one shared Pocket+Omni set; replay applies those to both.)
export const SETS = Object.freeze({
  pocket: {budget: 18, label: 'Pocket 18 s set'},
  'pocket-short': {budget: 10, label: 'Pocket 10 s set'},
  omni: {budget: 18, label: 'OmniVoice 18 s set'},
  'omni-short': {budget: 10, label: 'OmniVoice 10 s set'},
});
export const engineSet = engine => engine;

const SET_ACTIONS = new Set(['reroll', 'manual-set', 'restore']);
const HISTORY_LIMIT = 40;

export const emptyVoice = () => ({candidate: {pocket: null, 'pocket-short': null, omni: null, 'omni-short': null}, history: {pocket: [], 'pocket-short': [], omni: [], 'omni-short': []},
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
  if (SET_ACTIONS.has(entry.action) && Array.isArray(entry.clips) && (SETS[entry.set] || entry.set === 'full' || entry.set === 'short')) {
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
    for (const set of legacy ?? [entry.set ?? null]) row.rejected.push({set, engine: entry.engine, clips: [...entry.clips], ts: entry.ts, note: entry.note ?? ''});
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
    // Which research columns and own renders were played most for this voice (what:target -> count).
    const topColumns = Object.entries(row.plays).filter(([name]) => name.startsWith('research:') || name.startsWith('sample:'))
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({column: name, plays: count}));
    for (const [name, count] of Object.entries(row.plays)) if (name.startsWith('research:') || name.startsWith('sample:')) columns[name] = (columns[name] ?? 0) + count;
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
