// Local conversation memory for the Mistral provider (docs/MISTRAL.md). Convai keeps a character's history and long-term
// memory on its servers; with Mistral the bridge keeps a small, bounded version itself, in the state folder:
//   - a rolling short history per character and channel (the last `turns` exchanges: private, phone, group);
//   - a short summary per character of older private and phone exchanges (written by the same model, rarely: once per
//     `batch` exchanges that rolled out of the history), used as "what you remember of V";
//   - ordinary NPCs (crowd, gang members) keep only a short in-memory history for the conversation, never saved.
// A group conversation never receives the summary and its overflow is dropped, so private talk is not repeated in a group.
// "Forget" (the Memory page) clears this memory too. Nothing here calls any service.
import {readFile} from 'node:fs/promises';
import {atomicFile} from './guarded-file.mjs';

export const MEMORY_FILE = 'mistral-memory.json';
export const MEMORY_LIMITS = Object.freeze({
  turns: 8,            // exchanges kept in a channel's history
  batch: 8,            // exchanges that roll out of the history before they are folded into the summary
  overflow: 24,        // exchanges waiting to be summarised; the oldest are dropped beyond this
  line: 500,           // characters kept of each side of an exchange
  summary: 1400,       // characters of the summary
  characters: 120,     // characters remembered; the least recently talked-to are dropped beyond this
  ambient: 48,         // in-memory ordinary-NPC conversations
  fileBytes: 1024 * 1024,
});

const CHANNELS = ['private', 'phone', 'group'];
const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CONTROL = new RegExp('[\u0000-\u001f\u007f-\u009f  ]', 'g');
const clean = (value, limit) => {
  const points = Array.from(String(value ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim());
  return points.length <= limit ? points.join('') : points.slice(0, limit - 1).join('').trimEnd() + '…';
};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const emptyRow = () => ({summary: '', overflow: [], channels: {private: [], phone: [], group: []}, updated: 0});

function readTurns(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.map(turn => plain(turn) ? {v: clean(turn.v, MEMORY_LIMITS.line), r: clean(turn.r, MEMORY_LIMITS.line), at: Number.isFinite(turn.at) ? turn.at : 0} : null)
    .filter(turn => turn && turn.v && turn.r).slice(-limit);
}

export class MistralMemory {
  static async open({path, read = file => readFile(file, 'utf8'), write = (file, text) => atomicFile(file, text), now = Date.now, limits = MEMORY_LIMITS} = {}) {
    const memory = new MistralMemory({path, write, now, limits});
    if (path) {
      try {
        const raw = await read(path);
        if (Buffer.byteLength(raw) <= limits.fileBytes) memory.#load(JSON.parse(raw));
      } catch { /* no memory yet, or an unreadable file: start empty */ }
    }
    return memory;
  }
  constructor({path, write, now = Date.now, limits = MEMORY_LIMITS} = {}) {
    Object.assign(this, {path, write, now, limits});
    this.rows = new Map(); this.ambient = new Map(); this.saving = Promise.resolve(); this.timer = null; this.dirty = false;
    this.generation = 0; // bumped by every forget, so a summary requested before it is not applied after it
  }
  #load(value) {
    if (!plain(value) || value.version !== 1 || !plain(value.characters)) return;
    for (const [key, row] of Object.entries(value.characters)) {
      if (!KEY.test(key) || !plain(row)) continue;
      const channels = plain(row.channels) ? row.channels : {};
      this.rows.set(key, {summary: clean(row.summary, this.limits.summary), overflow: readTurns(row.overflow, this.limits.overflow),
        channels: Object.fromEntries(CHANNELS.map(name => [name, readTurns(channels[name], this.limits.turns)])),
        updated: Number.isFinite(row.updated) ? row.updated : 0});
    }
    this.#trim();
  }
  #row(key) {
    let row = this.rows.get(key);
    if (!row) { row = emptyRow(); this.rows.set(key, row); }
    return row;
  }
  #trim() {
    while (this.rows.size > this.limits.characters) {
      const oldest = [...this.rows].sort((a, b) => a[1].updated - b[1].updated)[0];
      this.rows.delete(oldest[0]);
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
  record({profileKey, channel = 'private', ambientKey, v, r}) {
    const turn = {v: clean(v, this.limits.line), r: clean(r, this.limits.line), at: this.now()};
    if (!turn.v || !turn.r) return false;
    if (ambientKey) {
      const turns = this.ambient.get(ambientKey) ?? [];
      turns.push(turn);
      this.ambient.delete(ambientKey); this.ambient.set(ambientKey, turns.slice(-this.limits.turns));
      while (this.ambient.size > this.limits.ambient) this.ambient.delete(this.ambient.keys().next().value);
      return true;
    }
    if (!KEY.test(profileKey ?? '') || !CHANNELS.includes(channel)) return false;
    const row = this.#row(profileKey), turns = row.channels[channel];
    turns.push(turn);
    while (turns.length > this.limits.turns) {
      const old = turns.shift();
      if (channel !== 'group') row.overflow.push(old);
    }
    while (row.overflow.length > this.limits.overflow) row.overflow.shift();
    row.updated = turn.at;
    this.#trim();
    this.#schedule();
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
    this.#schedule();
    return true;
  }
  /** A failed summary leaves the batch in the overflow for a later try. */
  failSummary(profileKey) { const row = this.rows.get(profileKey); if (row) row.folding = false; }
  /**
   * Clears memory: everything, or the given profile keys (and, for a key, its whole conversation set). Returns the number of
   * characters removed. The in-memory ordinary-NPC conversations are cleared with it.
   */
  forget({all = false, profileKeys = []} = {}) {
    this.generation++;
    let removed = 0;
    if (all) { removed = this.rows.size; this.rows.clear(); }
    else for (const key of profileKeys) if (this.rows.delete(key)) removed++;
    this.ambient.clear();
    this.#schedule(0);
    return removed;
  }
  #document() {
    return JSON.stringify({version: 1, updated: this.now(), characters: Object.fromEntries([...this.rows].map(([key, row]) => [key,
      {summary: row.summary, overflow: row.overflow, channels: row.channels, updated: row.updated}]))});
  }
  #schedule(delay = 800) {
    this.dirty = true;
    if (!this.path) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => {}); }, delay);
    this.timer.unref?.();
  }
  /** Writes pending changes now (off the speech path; also called at shutdown and by tests). */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty || !this.path) return this.saving;
    this.dirty = false;
    const text = this.#document();
    this.saving = this.saving.catch(() => {}).then(() => this.write(this.path, text));
    return this.saving;
  }
  /** Characters currently remembered (for diagnostics; no text). */
  get size() { return this.rows.size; }
}
