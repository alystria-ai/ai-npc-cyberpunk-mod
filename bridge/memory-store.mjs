// Shared conversation memory for the local and cloud-LLM routes (docs/LOCAL_OPTION_DESIGN.md, "Embeddings and vector memory").
// It is a superset of MistralMemory (same methods, same limits and semantics) that also keeps, per character:
//   - extracted lasting records (facts, events, preferences, relationships, promises), each with an embedding vector;
//   - the exchanges still waiting for extraction.
// One file per player and character: <dir>/<playerId>/<profileKey>.json. Saves are atomic, debounced and per changed character.
// Nothing here runs per frame or blocks a reply: retrieval is one embed call with a hard timeout plus a flat scan, and extraction and
// re-embedding run in the background, one job at a time, only while the gate allows (no combat, nothing in flight or speaking).
// Timers exist only while there is something to do (a debounced save, a pending job) and are unref'd.
import {readFile, readdir as readDirectory, rename as renameFile, rm, mkdir} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {atomicFile} from './guarded-file.mjs';
import {MEMORY_LIMITS} from './mistral-memory.mjs';

export const STORE_LIMITS = Object.freeze({
  ...MEMORY_LIMITS,
  records: 600,                 // records per character; the oldest unpinned, least important ones are folded away beyond this
  pending: 24,                  // exchanges waiting for extraction; the oldest are dropped beyond this
  extractBatch: 12,             // exchanges handed to one extraction
  known: 12,                    // existing records shown to the extractor
  fact: 220,                    // characters of a record's text
  facts: 3,                     // records accepted from one extraction
  characterBytes: 3 * 1024 * 1024,
});
export const RECORD_KINDS = Object.freeze(['fact', 'event', 'preference', 'relationship', 'promise']);

const CHANNELS = ['private', 'phone', 'group'];
const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const FILE = /^([a-z0-9][a-z0-9-]{0,79})\.json$/;
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');
const SAVE_MS = 800;
const EXTRACT_COUNT = 6;          // exchanges that trigger an extraction at once
const IDLE_MS = 20000;            // quiet time after the last exchange that triggers an extraction
const GATE_MS = 10000;            // re-check interval while the gate is closed or a job was interrupted
const BACKOFF_FIRST_MS = 60000;
const BACKOFF_MAX_MS = 15 * 60000;
const EMBED_BATCH = 8;
const EMBED_GAP_MS = 500;
const DUPLICATE = 0.90;           // cosine at or above which a new fact updates an existing record
const RECENCY_MS = 30 * 24 * 3600 * 1000;

const clean = (value, limit) => {
  const points = Array.from(String(value ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim());
  return points.length <= limit ? points.join('') : points.slice(0, limit - 1).join('').trimEnd() + '…';
};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unit = value => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
const safePlayer = value => {
  const key = String(value ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 80).replace(/-+$/, '');
  return KEY.test(key) ? key : 'player';
};
const emptyRow = () => ({
  summary: '', overflow: [], channels: {private: [], phone: [], group: []}, updated: 0,
  records: [], pending: [], embedder: null, index: {matrix: new Float32Array(0), recs: [], dim: 0}, unembedded: 0, folding: false,
  sched: {extractAt: 0, extractBackoff: 0, embedAt: 0, embedBackoff: 0},
});

function readTurns(value, limit, lineLimit) {
  if (!Array.isArray(value)) return [];
  return value.map(turn => plain(turn) ? {v: clean(turn.v, lineLimit), r: clean(turn.r, lineLimit), at: Number.isFinite(turn.at) ? turn.at : 0} : null)
    .filter(turn => turn && turn.v && turn.r).slice(-limit);
}
const encodeVector = vec => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64');
function decodeVector(text, dim) {
  if (typeof text !== 'string' || !text || !(dim > 0)) return null;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== dim * 4) return null;
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) vec[i] = bytes.readFloatLE(i * 4);
  return vec.every(Number.isFinite) ? vec : null;
}
const dot = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i] * b[i]; return sum; };

const defaultIo = {
  read: file => readFile(file, 'utf8'),
  write: async (file, text) => { await mkdir(dirname(file), {recursive: true}); return atomicFile(file, text); },
  readdir: dir => readDirectory(dir),
  rename: (from, to) => renameFile(from, to),
  remove: file => rm(file, {force: true}),
};

export class MemoryStore {
  /**
   * Opens the store: loads every character file of the player, migrates the legacy mistral-memory.json (once), and arms the
   * background work if some is waiting. All file access can be replaced (tests).
   */
  static async open(options = {}) {
    const store = new MemoryStore(options);
    await store.#loadAll();
    if (options.legacyPath) await store.#migrate(options.legacyPath);
    store.#plan();
    return store;
  }
  constructor({dir, playerId = 'player', legacyPath, embedder = null, now = Date.now, read = defaultIo.read, write = defaultIo.write,
    readdir = defaultIo.readdir, rename = defaultIo.rename, remove = defaultIo.remove, limits, gate = () => true,
    setTimer = setTimeout, clearTimer = clearTimeout, log = () => {}} = {}) {
    Object.assign(this, {embedder, now, read, write, readdir, rename, remove, gate, setTimer, clearTimer, log, legacyPath});
    this.limits = {...STORE_LIMITS, ...limits};
    this.root = dir ? join(dir, safePlayer(playerId)) : null;
    this.rows = new Map(); this.ambient = new Map();
    this.generation = 0;           // bumped by every forget: summaries, extractions and retrievals that began earlier are discarded
    this.extractor = null; this.extractorCanRun = null;
    this.dirty = new Set(); this.removedKeys = new Set(); this.wipeAll = false;
    this.damaged = new Set();      // characters whose file the load could not use: kept aside (<key>.json.corrupt) before a save writes over it
    this.saving = Promise.resolve(); this.saveTimer = null;
    this.workTimer = null; this.workDue = Infinity; this.running = null;
    this.serial = 0;
  }

  // ---------------------------------------------------------------- loading and migration
  #path(key) { return join(this.root, key + '.json'); }
  #character(value, key, legacy) {
    const channels = plain(value.channels) ? value.channels : {};
    const row = emptyRow();
    row.summary = clean(value.summary, this.limits.summary);
    row.overflow = readTurns(value.overflow, this.limits.overflow, this.limits.line);
    row.channels = Object.fromEntries(CHANNELS.map(name => [name, readTurns(channels[name], this.limits.turns + (this.limits.slide ?? 0), this.limits.line)]));
    row.updated = Number.isFinite(value.updated) ? value.updated : 0;
    if (legacy) return row;
    row.pending = readTurns(value.pending, this.limits.pending, this.limits.line);
    const saved = plain(value.embedder) && typeof value.embedder.id === 'string' && Number.isInteger(value.embedder.dim) && value.embedder.dim > 0
      ? {id: value.embedder.id, dim: value.embedder.dim} : null;
    const seen = new Set();
    for (const item of Array.isArray(value.records) ? value.records : []) {
      if (!plain(item) || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue;
      const text = clean(item.text, this.limits.fact);
      if (!text) continue;
      seen.add(item.id);
      row.records.push({
        id: item.id.slice(0, 64), kind: RECORD_KINDS.includes(item.kind) ? item.kind : 'fact', text,
        created: Number.isFinite(item.created) ? item.created : 0, updated: Number.isFinite(item.updated) ? item.updated : 0,
        importance: unit(item.importance), pinned: item.pinned === true, source: clean(item.source, 24) || 'chat',
        vec: saved ? decodeVector(item.v, saved.dim) : null,
      });
    }
    row.embedder = saved;
    const current = this.embedder;
    if (current && row.records.length) {
      if (!saved || saved.id !== current.id || saved.dim !== current.dim) {
        for (const record of row.records) record.vec = null; // other model: keep the text, re-embed in the background
        row.embedder = {id: current.id, dim: current.dim};
        this.dirty.add(key);
      }
    } else if (!row.records.length) row.embedder = null;
    this.#capRecords(row);
    this.#reindex(row);
    return row;
  }
  async #loadAll() {
    if (!this.root) return;
    let names;
    try { names = await this.readdir(this.root); } catch { return; }
    this.names = new Set(names);
    for (const name of names) {
      const match = FILE.exec(name);
      if (!match) continue;
      let raw = null;
      try {
        raw = await this.read(join(this.root, name));
        if (Buffer.byteLength(raw) <= this.limits.characterBytes) {
          const value = JSON.parse(raw);
          if (plain(value) && value.version === 1 && value.profileKey === match[1]) { this.rows.set(match[1], this.#character(value, match[1], false)); continue; }
        }
      } catch { /* unreadable or damaged */ }
      // Skipped, and left on disk as the reader found it. A file that was read but is not usable (not a folder, a locked file or an empty one)
      // holds the player's words, so the first save of that character moves it aside instead of writing over it (#keepAside).
      const keep = typeof raw === 'string' && raw.trim() !== '';
      if (keep) this.damaged.add(match[1]);
      this.log(`character file ${name} could not be used and was skipped` + (keep ? `; a save of this character keeps it as ${name}.corrupt` : ''));
    }
    this.#trim();
    this.#saveSoon();
  }
  /** Imports the legacy single-file memory into character files (never over an existing one), then renames it. */
  async #migrate(path) {
    if (!this.root) return;
    let value;
    try {
      const raw = await this.read(path);
      if (Buffer.byteLength(raw) > this.limits.fileBytes) return;
      value = JSON.parse(raw);
    } catch { return; }
    if (!plain(value) || value.version !== 1 || !plain(value.characters)) return;
    for (const [key, item] of Object.entries(value.characters)) {
      if (!KEY.test(key) || !plain(item) || this.rows.has(key) || this.names?.has(key + '.json')) continue;
      this.rows.set(key, this.#character(item, key, true));
      this.#touch(key);
    }
    this.#trim();
    try {
      await this.flush();
      await this.rename(path, path + '.migrated');
    } catch (error) { this.log('memory migration will retry: ' + (error?.code ?? error?.message ?? 'error')); }
  }

  // ---------------------------------------------------------------- history, summary (as MistralMemory)
  #row(key) {
    let row = this.rows.get(key);
    if (!row) { row = emptyRow(); this.rows.set(key, row); }
    return row;
  }
  #trim() {
    while (this.rows.size > this.limits.characters) {
      const oldest = [...this.rows].sort((a, b) => a[1].updated - b[1].updated)[0];
      this.rows.delete(oldest[0]);
      this.dirty.delete(oldest[0]); this.removedKeys.add(oldest[0]);
    }
  }
  /** {summary, turns} for a conversation. `ambientKey` (an ordinary NPC's conversation) uses the in-memory history. */
  recall({profileKey, channel = 'private', ambientKey}) {
    if (ambientKey) return {summary: '', turns: [...(this.ambient.get(ambientKey) ?? [])]};
    const row = this.rows.get(profileKey);
    if (!row) return {summary: '', turns: []};
    return {summary: channel === 'group' ? '' : row.summary, turns: [...(row.channels[channel] ?? [])]};
  }
  /** Records one exchange. Older ones roll into the overflow (private and phone) or are dropped (group). */
  record({profileKey, channel = 'private', ambientKey, v, r, reaction = false}) {
    const turn = {v: clean(v, this.limits.line), r: clean(r, this.limits.line), at: this.now()};
    if (!turn.v || !turn.r) return false;
    if (ambientKey) {
      const turns = this.ambient.get(ambientKey) ?? [];
      turns.push(turn);
      this.ambient.delete(ambientKey); this.ambient.set(ambientKey, turns.length > this.limits.turns + (this.limits.slide ?? 0) ? turns.slice(-this.limits.turns) : turns);
      while (this.ambient.size > this.limits.ambient) this.ambient.delete(this.ambient.keys().next().value);
      return true;
    }
    if (!KEY.test(profileKey ?? '') || !CHANNELS.includes(channel)) return false;
    const row = this.#row(profileKey), turns = row.channels[channel];
    turns.push(turn);
    // Cut back to `turns` in one step once the window has grown by `slide` more, so the history's first exchange stays the same for several turns in a row
    // and the server's prompt cache keeps the whole history (bridge/mistral-memory.mjs, MEMORY_LIMITS.slide).
    if (turns.length > this.limits.turns + (this.limits.slide ?? 0)) {
      while (turns.length > this.limits.turns) {
        const old = turns.shift();
        if (channel !== 'group') row.overflow.push(old);
      }
    }
    while (row.overflow.length > this.limits.overflow) row.overflow.shift();
    row.updated = turn.at;
    if (channel !== 'group' && !reaction && this.extractor && this.#available()) {
      row.pending.push({...turn});
      while (row.pending.length > this.limits.pending) row.pending.shift();
    }
    this.#trim();
    this.#touch(profileKey);
    this.#plan();
    return true;
  }
  /** The exchanges to fold into the summary now, or null when fewer than a batch are waiting. */
  pendingSummary(profileKey) {
    const row = this.rows.get(profileKey);
    if (!row || row.overflow.length < this.limits.batch || row.folding) return null;
    return {summary: row.summary, turns: row.overflow.slice(0, this.limits.batch), generation: this.generation};
  }
  /** Marks the batch as being summarised so a second request does not start. */
  beginSummary(profileKey) { const row = this.rows.get(profileKey); if (row) row.folding = true; }
  /** The new summary for the batch taken by pendingSummary; ignored when memory was forgotten in the meantime. */
  applySummary(profileKey, text, batch) {
    const row = this.rows.get(profileKey);
    if (!row) return false;
    row.folding = false;
    if (batch.generation !== this.generation) return false;
    const summary = clean(text, this.limits.summary);
    if (!summary) return false;
    row.summary = summary;
    row.overflow.splice(0, batch.turns.length);
    row.updated = this.now();
    this.#touch(profileKey);
    return true;
  }
  /** A failed summary leaves the batch in the overflow for a later try. */
  failSummary(profileKey) { const row = this.rows.get(profileKey); if (row) row.folding = false; }

  /** Characters currently remembered (for diagnostics; no text). */
  get size() { return this.rows.size; }

  // ---------------------------------------------------------------- records (editor)
  listRecords(profileKey) {
    const row = this.rows.get(profileKey);
    if (!row) return [];
    return row.records.map(({id, kind, text, pinned, updated}) => ({id, kind, text, pinned, updated})).sort((a, b) => b.updated - a.updated);
  }
  deleteRecord(profileKey, id) {
    const row = this.rows.get(profileKey), at = row ? row.records.findIndex(record => record.id === id) : -1;
    if (at < 0) return false;
    row.records.splice(at, 1);
    this.#reindex(row); this.#touch(profileKey); this.#plan();
    return true;
  }
  /**
   * Replaces the text of a record (the editor). The record is pinned, so a later extraction never rewrites it and the record cap
   * never drops it; its vector is cleared and the background job embeds the new text. Returns the record, or null when it is missing
   * or the text is empty.
   */
  editRecord(profileKey, id, text) {
    const row = this.rows.get(profileKey), record = row?.records.find(item => item.id === id), value = clean(text, this.limits.fact);
    if (!record || !value) return null;
    Object.assign(record, {text: value, vec: null, pinned: true, updated: this.now()});
    this.#reindex(row); this.#touch(profileKey); this.#plan();
    return {id: record.id, kind: record.kind, text: value, pinned: true, updated: record.updated};
  }
  /** Replaces the short summary of older talks (the editor); an empty text clears it. Returns the stored text, or null when it could not be kept. */
  setSummary(profileKey, text) {
    if (!KEY.test(profileKey ?? '')) return null;
    const value = clean(text, this.limits.summary), row = value ? this.#row(profileKey) : this.rows.get(profileKey);
    if (!row) return '';
    row.summary = value; row.updated = this.now();
    this.#touch(profileKey);
    return value;
  }
  /** Can this store find lasting memories now (the embedding model is installed)? The editor says so next to the list. */
  get learns() { return this.#available(); }
  pinRecord(profileKey, id, pinned = true) {
    const record = this.rows.get(profileKey)?.records.find(item => item.id === id);
    if (!record) return false;
    record.pinned = !!pinned;
    this.#touch(profileKey);
    return true;
  }
  #reindex(row) {
    const dim = row.embedder?.dim ?? 0;
    const embedded = row.records.filter(record => dim && record.vec && record.vec.length === dim);
    for (const record of row.records) if (!embedded.includes(record)) record.vec = null;
    const matrix = new Float32Array(embedded.length * dim);
    embedded.forEach((record, i) => { matrix.set(record.vec, i * dim); record.vec = matrix.subarray(i * dim, (i + 1) * dim); });
    row.index = {matrix, recs: embedded, dim};
    row.unembedded = row.records.length - embedded.length;
  }
  #capRecords(row) {
    while (row.records.length > this.limits.records) {
      let pick = -1;
      row.records.forEach((record, i) => {
        if (record.pinned) return;
        const best = pick < 0 ? null : row.records[pick];
        if (!best || record.importance < best.importance || record.importance === best.importance && record.updated < best.updated) pick = i;
      });
      if (pick < 0) return; // everything left is pinned
      row.records.splice(pick, 1);
    }
  }

  // ---------------------------------------------------------------- retrieval (hot path)
  #available() { try { return !!this.embedder && this.embedder.available() === true; } catch { return false; } }
  // An embedder without ready() is taken to answer at once (the old behaviour, and the tests' fake).
  #ready() { try { return typeof this.embedder?.ready !== 'function' || this.embedder.ready() === true; } catch { return false; } }
  /** Starts the embedder ahead of the next retrieval (composer open, a cold retrieval). Never throws and never waits. */
  warm() {
    if (!this.#available() || typeof this.embedder?.warm !== 'function') return false;
    try { void Promise.resolve(this.embedder.warm()).catch(() => {}); return true; } catch { return false; }
  }
  /**
   * The records worth remembering for this line, best first: [{id, kind, text}]. Empty for ordinary NPCs, the group channel, an
   * empty query, a missing embedder, or when embedding does not finish within `timeoutMs` (the late result is discarded).
   */
  async retrieve({profileKey, query, channel = 'private', ambientKey, k = 4, budgetChars = 1200, minScore = 0.40, timeoutMs = 400, signal} = {}) {
    if (ambientKey || !CHANNELS.includes(channel) || channel === 'group' || !this.embedder) return [];
    const row = this.rows.get(profileKey), text = clean(query, 500);
    if (!row || !text || !row.index?.recs.length || signal?.aborted || !this.#available()) return [];
    const embedder = this.embedder;
    if (row.embedder?.id !== embedder.id || row.embedder.dim !== embedder.dim) return [];
    // An embedder that is not running yet (the local one starts a llama-server, 2 to 8 s, longer under the game) cannot answer
    // within the timeout: it is started for the next turn and this one does not wait. Before this, every turn on a cold or
    // failing embedder waited the whole timeout (about 410 ms in the 2026-10-13 live records) for nothing.
    // The start itself (a process spawn, about 15 ms of this thread) waits until the turn has sent its request.
    if (!this.#ready()) { this.setTimer(() => this.warm(), 0)?.unref?.(); return []; }
    const generation = this.generation;
    const vec = await this.#embedQuery(text, timeoutMs, signal);
    if (!vec || vec.length !== embedder.dim || generation !== this.generation || this.rows.get(profileKey) !== row || signal?.aborted) return [];
    const {matrix, recs, dim} = row.index, at = this.now(), scored = [];
    if (dim !== vec.length) return [];
    for (let i = 0; i < recs.length; i++) {
      let cosine = 0;
      for (let j = 0, offset = i * dim; j < dim; j++) cosine += matrix[offset + j] * vec[j];
      if (!(cosine >= minScore)) continue;
      const record = recs[i];
      const recency = Math.max(0, 1 - (at - record.updated) / RECENCY_MS);
      scored.push({record, score: cosine + 0.05 * recency + 0.03 * record.importance + (record.pinned ? 0.1 : 0)});
    }
    scored.sort((a, b) => b.score - a.score);
    const out = [];
    let length = 0;
    for (const {record} of scored) {
      if (out.length >= k) break;
      const next = length + record.text.length + (out.length ? 1 : 0);
      if (next > budgetChars) break;
      length = next;
      out.push({id: record.id, kind: record.kind, text: record.text});
    }
    return out;
  }
  async #embedQuery(text, timeoutMs, signal) {
    const control = new AbortController();
    let timer, onAbort;
    const expired = new Promise(resolve => {
      timer = this.setTimer(() => resolve(null), timeoutMs);
      timer?.unref?.();
      if (signal) { onAbort = () => resolve(null); signal.addEventListener('abort', onAbort, {once: true}); }
    });
    const work = (async () => (await this.embedder.embed([text], {signal: control.signal}))?.[0] ?? null)();
    work.catch(() => {});
    try {
      const vec = await Promise.race([work, expired]);
      if (!vec) control.abort();
      return vec ?? null;
    } catch { return null; }
    finally { this.clearTimer(timer); if (onAbort) signal.removeEventListener('abort', onAbort); }
  }

  // ---------------------------------------------------------------- background work
  /** `fn({profileKey, turns, known, signal}) -> Promise<[{text, kind, importance, replaces?}]>`, supplied by the host. */
  setExtractor(fn, canRun = null) {
    this.extractor = typeof fn === 'function' ? fn : null;
    this.extractorCanRun = typeof canRun === 'function' ? canRun : null;
    this.#plan();
  }
  /**
   * The extractor's route changed (the conversation provider was switched): look at the schedule again. While `canRun` says no (the chat is on
   * Convai, which keeps its own memory), nothing is scheduled at all: no attempt, no retry, no log line; the exchanges stay pending for a route that can.
   */
  refresh() { this.#plan(); }
  #extractorOn() { try { return !this.extractor ? false : !this.extractorCanRun || this.extractorCanRun() !== false; } catch { return false; } }
  /** Aborts the running background job (a turn started). The exchanges stay pending and are retried later. */
  interrupt() { this.running?.controller.abort(); }

  #dueTimes(row) {
    const embedder = this.embedder;
    let extract = Infinity, embed = Infinity;
    if (embedder && this.#extractorOn() && row.pending.length) {
      extract = Math.max(row.sched.extractAt, row.pending.length >= EXTRACT_COUNT ? 0 : row.pending.at(-1).at + IDLE_MS);
    }
    if (embedder && row.unembedded) embed = row.sched.embedAt;
    return {extract, embed};
  }
  #nextJob() {
    let best = null;
    for (const [key, row] of this.rows) {
      const {extract, embed} = this.#dueTimes(row);
      if (extract < (best?.due ?? Infinity)) best = {key, row, kind: 'extract', due: extract};
      if (embed < (best?.due ?? Infinity)) best = {key, row, kind: 'embed', due: embed};
    }
    return best;
  }
  #arm(delay) {
    const at = this.now() + delay;
    if (this.workTimer && this.workDue <= at) return;
    if (this.workTimer) this.clearTimer(this.workTimer);
    this.workDue = at;
    this.workTimer = this.setTimer(() => { this.workTimer = null; this.workDue = Infinity; this.#tick(); }, Math.max(0, delay));
    this.workTimer?.unref?.();
  }
  #disarm() { if (this.workTimer) this.clearTimer(this.workTimer); this.workTimer = null; this.workDue = Infinity; }
  #plan() {
    if (this.running) return; // its end plans again
    const job = this.#nextJob();
    if (!job || job.due === Infinity) { this.#disarm(); return; }
    this.#arm(Math.max(0, job.due - this.now()));
  }
  #tick() {
    if (this.running) return;
    const job = this.#nextJob();
    if (!job || job.due === Infinity) return;
    if (job.due > this.now()) { this.#plan(); return; }
    let open = false;
    try { open = this.gate() === true && this.#available(); } catch { open = false; }
    if (!open) { this.#arm(GATE_MS); return; }
    void (job.kind === 'extract' ? this.#extract(job.key, job.row) : this.#reembed(job.key, job.row));
  }
  #failed(row, kind, controller, error) {
    const sched = row.sched;
    // Interrupted by a turn, or put off by the model server (`retryLater`: a turn holds its one slot): not a failure, so no backoff; looked at again soon.
    if (controller.signal.aborted || error?.retryLater === true) { sched[kind + 'At'] = this.now() + GATE_MS; return; }
    sched[kind + 'Backoff'] = sched[kind + 'Backoff'] ? Math.min(sched[kind + 'Backoff'] * 2, BACKOFF_MAX_MS) : BACKOFF_FIRST_MS;
    sched[kind + 'At'] = this.now() + sched[kind + 'Backoff'];
    this.log(`memory ${kind} failed (${error?.code ?? error?.message ?? 'error'}); retrying in ${Math.round(sched[kind + 'Backoff'] / 1000)} s`);
  }
  #live(key, row, generation, controller) {
    return this.generation === generation && this.rows.get(key) === row && !controller.signal.aborted;
  }
  async #extract(key, row) {
    const generation = this.generation, controller = new AbortController(), {signal} = controller;
    this.running = {kind: 'extract', key, controller};
    const batch = row.pending.slice(0, this.limits.extractBatch);
    try {
      const known = await this.#known(row, batch, signal);
      if (!this.#live(key, row, generation, controller)) throw new Error('discarded');
      const raw = await this.extractor({profileKey: key, turns: batch.map(turn => ({...turn})), known, signal});
      if (!this.#live(key, row, generation, controller)) throw new Error('discarded');
      if (!Array.isArray(raw)) throw new Error('extractor returned no list');
      const facts = this.#facts(raw);
      const vectors = facts.length ? await this.embedder.embed(facts.map(fact => fact.text), {signal}) : [];
      if (!this.#live(key, row, generation, controller)) throw new Error('discarded');
      if (!Array.isArray(vectors) || vectors.length !== facts.length || vectors.some(vec => !vec || vec.length !== this.embedder.dim)) throw new Error('bad embeddings');
      this.#apply(row, facts, vectors);
      row.pending = row.pending.filter(turn => !batch.includes(turn));
      row.sched.extractBackoff = 0; row.sched.extractAt = 0;
      this.#touch(key);
    } catch (error) {
      if (this.rows.get(key) === row) this.#failed(row, 'extract', controller, error);
    } finally {
      if (this.running?.controller === controller) this.running = null;
      this.#plan();
    }
  }
  async #known(row, batch, signal) {
    if (!row.index.recs.length || !batch.length) return [];
    const embedder = this.embedder;
    if (row.embedder?.id !== embedder.id) return [];
    const vectors = await embedder.embed(batch.map(turn => clean(turn.v + ' ' + turn.r, 600)), {signal});
    const best = new Map();
    const {matrix, recs, dim} = row.index;
    for (const vec of vectors ?? []) {
      if (!vec || vec.length !== dim) continue;
      for (let i = 0; i < recs.length; i++) {
        let cosine = 0;
        for (let j = 0, offset = i * dim; j < dim; j++) cosine += matrix[offset + j] * vec[j];
        if (cosine > (best.get(recs[i]) ?? -Infinity)) best.set(recs[i], cosine);
      }
    }
    return [...best].sort((a, b) => b[1] - a[1]).slice(0, this.limits.known).map(([record]) => ({id: record.id, text: record.text}));
  }
  #facts(raw) {
    const facts = [], seen = new Set();
    for (const item of raw) {
      if (facts.length >= this.limits.facts) break;
      if (!plain(item)) continue;
      const text = clean(item.text, this.limits.fact);
      if (!text || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      facts.push({text, kind: RECORD_KINDS.includes(item.kind) ? item.kind : 'fact', importance: Number.isFinite(item.importance) ? unit(item.importance) : 0.5,
        replaces: typeof item.replaces === 'string' ? item.replaces : null});
    }
    return facts;
  }
  #id(row) {
    let id;
    do id = 'm' + this.now().toString(36) + (this.serial++).toString(36); while (row.records.some(record => record.id === id));
    return id;
  }
  #apply(row, facts, vectors) {
    const embedder = this.embedder, stamp = this.now();
    if (!row.embedder) row.embedder = {id: embedder.id, dim: embedder.dim};
    facts.forEach((fact, i) => {
      const vec = Float32Array.from(vectors[i]);
      let match = null, top = -Infinity;
      for (const record of row.records) {
        if (!record.vec) continue;
        const cosine = dot(record.vec, vec);
        if (cosine > top) { top = cosine; match = record; }
      }
      const named = fact.replaces ? row.records.find(record => record.id === fact.replaces) : null;
      // A memory the player wrote or edited (pinned) keeps its words: the new fact is dropped, not merged into it.
      if ((match && top >= DUPLICATE && match.pinned) || named?.pinned) return;
      if (match && top >= DUPLICATE) {
        Object.assign(match, {text: fact.text, vec, updated: stamp, importance: Math.max(match.importance, fact.importance)});
        if (named && named !== match) row.records.splice(row.records.indexOf(named), 1);
      } else if (named) {
        Object.assign(named, {text: fact.text, kind: fact.kind, vec, updated: stamp, importance: fact.importance});
      } else {
        row.records.push({id: this.#id(row), kind: fact.kind, text: fact.text, created: stamp, updated: stamp, importance: fact.importance,
          pinned: false, source: 'chat', vec});
      }
    });
    this.#capRecords(row);
    this.#reindex(row);
    row.updated = stamp;
  }
  async #reembed(key, row) {
    const generation = this.generation, controller = new AbortController(), {signal} = controller;
    this.running = {kind: 'embed', key, controller};
    try {
      const targets = row.records.filter(record => !record.vec).slice(0, EMBED_BATCH);
      const vectors = await this.embedder.embed(targets.map(record => record.text), {signal});
      if (!this.#live(key, row, generation, controller)) throw new Error('discarded');
      if (!Array.isArray(vectors) || vectors.length !== targets.length || vectors.some(vec => !vec || vec.length !== this.embedder.dim)) throw new Error('bad embeddings');
      row.embedder = {id: this.embedder.id, dim: this.embedder.dim};
      targets.forEach((record, i) => { if (!record.vec && row.records.includes(record)) record.vec = Float32Array.from(vectors[i]); });
      this.#reindex(row);
      row.sched.embedBackoff = 0; row.sched.embedAt = this.now() + EMBED_GAP_MS;
      this.#touch(key);
    } catch (error) {
      if (this.rows.get(key) === row) this.#failed(row, 'embed', controller, error);
    } finally {
      if (this.running?.controller === controller) this.running = null;
      this.#plan();
    }
  }

  // ---------------------------------------------------------------- forget
  /**
   * Clears memory: everything, or the given profile keys. Deletes the rows, vectors and files, cancels timers and the running job,
   * and clears the in-memory ordinary-NPC conversations. Returns the number of characters removed.
   */
  forget({all = false, profileKeys = []} = {}) {
    this.generation++;
    this.running?.controller.abort();
    this.#disarm();
    let removed = 0;
    if (all) {
      removed = this.rows.size;
      this.rows.clear(); this.dirty.clear(); this.removedKeys.clear(); this.damaged.clear(); this.wipeAll = true;
    } else {
      for (const key of profileKeys) {
        if (!KEY.test(key ?? '')) continue;
        if (this.rows.delete(key)) removed++;
        this.dirty.delete(key); this.removedKeys.add(key); this.damaged.delete(key);
      }
    }
    this.ambient.clear();
    void this.flush().catch(() => {});
    this.#plan();
    return removed;
  }

  // ---------------------------------------------------------------- saving
  #touch(key) {
    if (!this.rows.has(key)) return;
    this.dirty.add(key); this.removedKeys.delete(key);
    this.#saveSoon();
  }
  #saveSoon() {
    if (!this.root || !(this.dirty.size || this.removedKeys.size || this.wipeAll)) return;
    if (this.saveTimer) this.clearTimer(this.saveTimer);
    this.saveTimer = this.setTimer(() => { this.saveTimer = null; void this.flush().catch(() => {}); }, SAVE_MS);
    this.saveTimer?.unref?.();
  }
  #document(key, row) {
    return JSON.stringify({
      version: 1, profileKey: key, updated: row.updated, summary: row.summary, overflow: row.overflow, channels: row.channels,
      embedder: row.embedder, pending: row.pending,
      records: row.records.map(record => ({id: record.id, kind: record.kind, text: record.text, created: record.created, updated: record.updated,
        importance: record.importance, pinned: record.pinned, source: record.source, v: record.vec ? encodeVector(record.vec) : ''})),
    });
  }
  // The damaged file the load skipped is moved to <key>.json.corrupt (an older copy there is replaced, as VendorMemory does) before the first save
  // of that character writes over it. A file that is already gone is nothing to keep; any other failure stops this character's save and is retried.
  async #keepAside(key) {
    if (!this.damaged.has(key)) return;
    const path = this.#path(key);
    try { await this.remove(path + '.corrupt'); await this.rename(path, path + '.corrupt'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    this.damaged.delete(key);
    this.log(`character file ${key}.json was damaged: kept as ${key}.json.corrupt, and a new file takes its place`);
  }
  /** Writes the changed characters now (off the speech path; also at shutdown and in tests). Only changed characters are rewritten. */
  flush() {
    if (this.saveTimer) { this.clearTimer(this.saveTimer); this.saveTimer = null; }
    if (!this.root || !(this.dirty.size || this.removedKeys.size || this.wipeAll)) return this.saving;
    const wipe = this.wipeAll, removals = [...this.removedKeys];
    const writes = [...this.dirty].filter(key => this.rows.has(key)).map(key => [key, this.#document(key, this.rows.get(key))]);
    this.wipeAll = false; this.removedKeys.clear(); this.dirty.clear();
    this.saving = this.saving.catch(() => {}).then(async () => {
      try {
        if (wipe) {
          let names = [];
          try { names = await this.readdir(this.root); } catch { /* no folder yet */ }
          for (const name of names) await this.remove(join(this.root, name)).catch(() => {});
          if (this.legacyPath) for (const path of [this.legacyPath, this.legacyPath + '.migrated']) await this.remove(path).catch(() => {});
        }
        for (const key of removals) for (const path of [this.#path(key), this.#path(key) + '.corrupt']) await this.remove(path).catch(() => {});
        let failure = null;
        for (const [key, text] of writes) {
          try { await this.#keepAside(key); await this.write(this.#path(key), text); } catch (error) { failure ??= error; if (this.rows.has(key)) this.dirty.add(key); } // kept for the next save
        }
        if (failure) throw failure;
      } catch (error) { this.log('memory save failed: ' + (error?.code ?? error?.message ?? 'error')); throw error; }
    });
    return this.saving;
  }
}
