// The reference picker's action log and the state derived from it.
//
// runtime/reference-picks.jsonl is the record: one JSON object per line, appended for every action. The kept
// sets, rejections, notes, candidate sets and play counts are always rebuilt by replaying it (replayPicks), so
// nothing can drift from the log. runtime/reference-picks.json is that replay written out for people and for
// quick inspection; Apply-ReferencePicks.mjs replays the log itself and does not trust the JSON.
//
// One log line:
//   {"seq":12,"ts":"2026-10-06T01:02:03.456Z","voice":"judy-alvarez","engine":"pocket+omni","set":"full",
//    "action":"reroll","clips":["judy-alvarez/..","judy-alvarez/.."],"seconds":17.4,"line":0,"note":"",...}
// engine is "pocket", "omni", "omni-short", "pocket+omni" (the shared 18 s candidate set) or "all".
// actions: reroll | manual-set | restore | keep | unkeep | reject | note | regenerate | regenerate-done |
//          regenerate-failed | play | session-start
import {appendFile, mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

export const ENGINES = Object.freeze(['pocket', 'omni', 'omni-short']);
export const SETS = Object.freeze({
  full: {budget: 18, engines: ['pocket', 'omni'], label: '18 s set'},
  short: {budget: 10, engines: ['omni-short'], label: '10 s set'},
});
export const engineSet = engine => engine === 'omni-short' ? 'short' : 'full';
export const setEngineLabel = set => set === 'short' ? 'omni-short' : 'pocket+omni';

const SET_ACTIONS = new Set(['reroll', 'manual-set', 'restore']);
const HISTORY_LIMIT = 40;

export const emptyVoice = () => ({candidate: {full: null, short: null}, history: {full: [], short: []},
  kept: {}, rejected: [], note: '', plays: {}, updated: null});

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
  if (SET_ACTIONS.has(entry.action) && Array.isArray(entry.clips) && SETS[entry.set]) {
    row.candidate[entry.set] = [...entry.clips];
    const key = entry.clips.join('|');
    row.history[entry.set] = [{clips: [...entry.clips], seconds: entry.seconds ?? null, ts: entry.ts, action: entry.action},
      ...row.history[entry.set].filter(item => item.clips.join('|') !== key)].slice(0, HISTORY_LIMIT);
  } else if (entry.action === 'keep' && ENGINES.includes(entry.engine) && Array.isArray(entry.clips)) {
    row.kept[entry.engine] = {clips: [...entry.clips], seconds: entry.seconds ?? null, ts: entry.ts, note: entry.note ?? ''};
  } else if (entry.action === 'unkeep' && ENGINES.includes(entry.engine)) {
    delete row.kept[entry.engine];
  } else if (entry.action === 'reject' && Array.isArray(entry.clips)) {
    row.rejected.push({set: entry.set ?? null, engine: entry.engine, clips: [...entry.clips], ts: entry.ts, note: entry.note ?? ''});
  } else if (entry.action === 'note') {
    row.note = entry.note ?? '';
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
  const voices = {};
  for (const [key, row] of Object.entries(state.voices)) {
    const plays = Object.values(row.plays).reduce((a, b) => a + b, 0);
    if (!Object.keys(row.kept).length && !row.rejected.length && !row.note && !row.candidate.full && !row.candidate.short && !plays) continue;
    voices[key] = {kept: row.kept, rejected: row.rejected, note: row.note,
      candidate: {full: row.candidate.full, short: row.candidate.short}, plays: row.plays, updated: row.updated};
  }
  return {version: 1, updated: now.toISOString(), source, entries: state.entries, voices};
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
