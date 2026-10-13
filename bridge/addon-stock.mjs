// Stock for add-on speakers (docs/ADDON_API.md, "Stock"): lines the model writes AHEAD of a moment, so the moment itself costs
// no model call. A fresh remark is the model (about a second) and then the voice (another half to one second); a prepared line is
// only the voice. Every line is still written by the model, from the facts of the current fight; nothing here is a fixed list.
//
// An add-on asks for a kind of line with handle:stock(speaker, key, {text, facts, maxWords, want, ttl, slots}). The game writes
// the request into runtime/addon-state.json and this class keeps `want` unused lines ready per (speaker, key). When the add-on then
// remarks that event with {stock = true}, the bridge takes one (`take`), fills its {slots} with the live numbers of that event and
// speaks it; with nothing ready the remark is written fresh, exactly as without stock.
//
// Pure bookkeeping: no network, no timers, no file. The model call is injected (`generate`), and so is the clock, so the whole
// scheduling policy (who is served next, how fast, when to back off) is tested without waiting.
import {isNearDuplicate} from './addons.mjs';

/** Pacing of the background generation. The cap is a ceiling, not a target: nothing is written without a missing line. */
export const STOCK_PACING = Object.freeze({minGapMs: 1200, backoffMs: 20_000, perMinute: 20, windowMs: 60_000, recentChecked: 8});

const SLOT_USE = /\{([^{}]*)\}/g;
const SLOT_NAME = /^[A-Za-z0-9_.]{1,48}$/;
const whole = (value, low, high, fallback) => Number.isFinite(value) ? Math.max(low, Math.min(high, Math.floor(value))) : fallback;
const tidy = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
// `now` is a clock function or a number (tests); without one the class's own clock answers.
const timeOf = (value, fallback) => typeof value === 'function' ? value() : Number.isFinite(value) ? value : fallback();

/** The slot names a line uses, in order: "{fight.kills} down" -> ['fight.kills']. */
export function slotsIn(text) {
  return [...String(text ?? '').matchAll(SLOT_USE)].map(match => match[1]);
}

// facts.a.b for the name "a.b": a finite number or a non-empty string, else undefined. Own properties only.
function lookup(facts, name) {
  if (!SLOT_NAME.test(name)) return undefined;
  let value = facts;
  for (const part of name.split('.')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(Number.isInteger(value) ? value : Math.round(value * 100) / 100) : undefined;
  if (typeof value === 'string') { const body = tidy(value.replace(/[{}]/g, ' ')); return body || undefined; }
  return undefined;
}

/** The line with every {slot} replaced from `facts`, or null when one cannot be filled. */
export function fillSlots(text, facts) {
  let complete = true;
  const filled = text.replace(SLOT_USE, (_, name) => {
    const value = lookup(facts, name);
    if (value === undefined) complete = false;
    return value ?? '';
  });
  return complete ? tidy(filled) : null;
}

// What a line was written for: a changed purpose, facts, length or slot list makes every prepared line wrong, even if a stale
// `rev` came back unchanged (the game restarted its counter). `want`, `ttl` and the blocks may change without losing lines.
const fingerprint = entry => JSON.stringify([entry.text, entry.facts ?? null, entry.maxWords, entry.slots]);

function normalise(row) {
  return {...row, key: String(row.key), text: String(row.text ?? ''), maxWords: whole(row.maxWords, 3, 60, 10),
    want: whole(row.want, 1, 4, 2), ttl: whole(row.ttl, 10, 300, 90), rev: Number.isFinite(row.rev) ? row.rev : 0,
    slots: Array.isArray(row.slots) ? row.slots.filter(name => typeof name === 'string') : [],
    blocks: Array.isArray(row.blocks) ? row.blocks : []};
}

export class AddonStock {
  /**
   * now      () => epoch ms
   * recent   profileKey => the speaker's last spoken lines, oldest first (AddonHost.recentLines)
   */
  constructor({now = Date.now, recent = () => []} = {}) {
    this.now = now;
    this.recent = recent;
    this.speakers = new Map();      // profileKey -> {mode, entries: Map<key, {entry, print, lines: [{text, at, mode, rev}], served}>}
    this.backoffUntil = 0;
    this.lastStart = -Infinity;
    this.starts = [];               // when the last generations began (the per-minute cap)
    this.busyNow = false;           // one generation at a time
    this.served = 0;                // round robin: a counter stamped on the entry that was just served
    this.counts = {generated: 0, taken: 0, stale: 0, failed: 0, aborted: 0, discarded: 0,
      rejected: {empty: 0, slot: 0, duplicate: 0, surplus: 0, total: 0}};
  }

  /** How many (speaker, key) entries are wanted. Zero means nothing here needs a timer. */
  get size() {
    let count = 0;
    for (const speaker of this.speakers.values()) count += speaker.entries.size;
    return count;
  }

  #discard(slot) {
    this.counts.discarded += slot.lines.length;
    slot.lines = [];
  }

  /**
   * Replaces what is wanted for one speaker (the state file's `stock` rows for it). A line whose entry changed (`rev` or purpose),
   * whose entry is gone, or that was written for another personality mode is dropped. Returns true when anything was added,
   * removed or discarded. Safe to call every second with the same rows: nothing changes then.
   */
  configure(profileKey, entries, {mode = null} = {}) {
    const rows = Array.isArray(entries) ? entries.filter(row => row && typeof row.key === 'string') : [];
    let speaker = this.speakers.get(profileKey);
    if (!rows.length) {
      if (!speaker) return false;
      for (const slot of speaker.entries.values()) this.#discard(slot);
      this.speakers.delete(profileKey);
      return true;
    }
    let changed = false;
    if (!speaker) { speaker = {mode, entries: new Map()}; this.speakers.set(profileKey, speaker); changed = true; }
    if (speaker.mode !== mode) {
      speaker.mode = mode;
      for (const slot of speaker.entries.values()) if (slot.lines.length) { this.#discard(slot); changed = true; }
    }
    const wanted = new Set();
    for (const row of rows) {
      if (wanted.has(row.key)) continue;
      wanted.add(row.key);
      const entry = normalise(row), print = fingerprint(entry), slot = speaker.entries.get(entry.key);
      if (!slot) { speaker.entries.set(entry.key, {entry, print, lines: [], served: 0}); changed = true; continue; }
      if (slot.entry.rev !== entry.rev || slot.print !== print) {
        if (slot.lines.length) this.#discard(slot);
        slot.print = print;
        changed = true;
      }
      slot.entry = entry;
    }
    for (const [key, slot] of speaker.entries) {
      if (wanted.has(key)) continue;
      this.#discard(slot);
      speaker.entries.delete(key);
      changed = true;
    }
    return changed;
  }

  // The usable lines of an entry: stale ones (older than the entry's ttl) are dropped and counted when looked at.
  #fresh(slot, at) {
    const limit = slot.entry.ttl * 1000;
    const kept = slot.lines.filter(line => at - line.at <= limit);
    this.counts.stale += slot.lines.length - kept.length;
    slot.lines = kept;
    return kept;
  }

  /** Entries with fewer than `want` usable lines, the most-needed first; equal need goes round robin (longest unserved first). */
  deficits({now} = {}) {
    const at = timeOf(now, this.now), out = [];
    let order = 0;
    for (const [profileKey, speaker] of this.speakers) {
      for (const [key, slot] of speaker.entries) {
        const have = this.#fresh(slot, at).length, need = slot.entry.want - have;
        if (need > 0) out.push({profileKey, key, entry: slot.entry, mode: speaker.mode, have, need, served: slot.served, order: order++});
      }
    }
    return out.sort((a, b) => b.need - a.need || a.served - b.served || a.order - b.order);
  }

  /** The (profileKey, entry) to write a line for next, or null. */
  next({now} = {}) { return this.deficits({now})[0] ?? null; }

  /** True while some entry wants a line. */
  wants({now} = {}) { return this.next({now}) !== null; }

  // The unused prepared lines of a speaker, across its keys (what the model is told not to repeat).
  #unused(profileKey) {
    const speaker = this.speakers.get(profileKey);
    return speaker ? [...speaker.entries.values()].flatMap(slot => slot.lines.map(line => line.text)) : [];
  }

  /**
   * Writes ONE line for the next entry that needs one, if the pacing allows. Never throws. Resolves to
   * {status: 'stocked' | 'rejected' | 'discarded' | 'failed' | 'aborted' | 'skipped', reason?, profileKey?, key?, text?}.
   *   generate  async ({profileKey, entry, mode, avoid, route}) => the line (string, or {text}); throws when it could not
   *   route     (profileKey) => the route to write it on, or null for "not now" (that speaker is passed over); a string passes as is
   *   busy      () => true while the player or a turn needs the machine; nothing starts then
   *   now       clock function or ms
   */
  async pump({generate, now, route, busy} = {}) {
    if (typeof generate !== 'function') return {status: 'skipped', reason: 'no-generator'};
    if (this.busyNow) return {status: 'skipped', reason: 'in-flight'};
    const at = timeOf(now, this.now);
    if (!this.size) return {status: 'skipped', reason: 'idle'};
    if (busy?.()) return {status: 'skipped', reason: 'busy'};
    if (at < this.backoffUntil) return {status: 'skipped', reason: 'backoff'};
    if (at - this.lastStart < STOCK_PACING.minGapMs) return {status: 'skipped', reason: 'gap'};
    this.starts = this.starts.filter(start => at - start < STOCK_PACING.windowMs);
    if (this.starts.length >= STOCK_PACING.perMinute) return {status: 'skipped', reason: 'rate'};
    let target = null, via = null;
    for (const candidate of this.deficits({now: at})) {
      via = typeof route === 'function' ? route(candidate.profileKey) : route ?? null;
      if (typeof route === 'function' && !via) continue;
      target = candidate;
      break;
    }
    if (!target) return {status: 'skipped', reason: 'nothing-to-write'};
    const {profileKey, key, entry, mode} = target;
    const slot = this.speakers.get(profileKey).entries.get(key), rev = entry.rev, print = slot.print;
    this.busyNow = true;
    this.lastStart = at;
    this.starts.push(at);
    slot.served = ++this.served;
    let raw;
    try {
      raw = await generate({profileKey, entry, mode, avoid: this.#unused(profileKey), route: via});
    } catch (error) {
      // A turn that needed the machine cancels the line: that is not a fault and costs no back-off.
      if (error?.name === 'AbortError') { this.counts.aborted++; return {status: 'aborted', profileKey, key}; }
      this.counts.failed++;
      this.backoffUntil = timeOf(now, this.now) + STOCK_PACING.backoffMs;
      return {status: 'failed', reason: String(error?.message ?? error), profileKey, key};
    } finally {
      this.busyNow = false;
    }
    const written = timeOf(now, this.now);
    const text = tidy(typeof raw === 'string' ? raw : raw?.text);
    const reject = reason => {
      this.counts.rejected[reason]++; this.counts.rejected.total++;
      return {status: 'rejected', reason, profileKey, key, text};
    };
    // What happened while the model wrote: the entry changed or went, or the mode switched. The line is for a moment that is past.
    const speaker = this.speakers.get(profileKey), current = speaker?.entries.get(key);
    if (!current || current !== slot || current.entry.rev !== rev || current.print !== print || speaker.mode !== mode) {
      this.counts.discarded++;
      return {status: 'discarded', reason: 'entry-changed', profileKey, key, text};
    }
    if (!text) return reject('empty');
    const used = slotsIn(text);
    if (used.some(name => !current.entry.slots.includes(name)) || /[{}]/.test(text.replace(SLOT_USE, ''))) return reject('slot');
    const recent = (this.recent(profileKey) ?? []).slice(-STOCK_PACING.recentChecked);
    if ([...recent, ...this.#unused(profileKey)].some(other => isNearDuplicate(other, text))) return reject('duplicate');
    if (this.#fresh(current, written).length >= current.entry.want) return reject('surplus');
    current.lines.push({text, at: written, mode, rev});
    this.counts.generated++;
    return {status: 'stocked', profileKey, key, text};
  }

  /**
   * Pops the oldest usable line for `key` and fills its {slots} from `facts` (a dot path: fight.kills reads facts.fight.kills;
   * numbers and strings only). Null when there is none, the mode differs, or no line can be filled; a line whose slot cannot be
   * filled is thrown away (these facts will not fill it later either). A taken line is never used twice.
   */
  take(profileKey, key, {mode, facts, now} = {}) {
    const speaker = this.speakers.get(profileKey), slot = speaker?.entries.get(key);
    if (!slot) return null;
    const at = timeOf(now, this.now), current = mode === undefined ? speaker.mode : mode;
    this.#fresh(slot, at);
    for (let index = 0; index < slot.lines.length; index++) {
      const line = slot.lines[index];
      if (line.mode !== current) continue;
      slot.lines.splice(index--, 1);
      const filled = fillSlots(line.text, facts);
      if (filled === null) { this.counts.discarded++; continue; }
      this.counts.taken++;
      return filled;
    }
    return null;
  }

  /** For logs: what is ready, and what happened so far. */
  status() {
    const entries = [];
    for (const [profileKey, speaker] of this.speakers) {
      for (const [key, slot] of speaker.entries) entries.push({profileKey, key, ready: slot.lines.length, want: slot.entry.want, rev: slot.entry.rev});
    }
    return {entries, generated: this.counts.generated, taken: this.counts.taken, stale: this.counts.stale, failed: this.counts.failed,
      aborted: this.counts.aborted, discarded: this.counts.discarded, rejected: this.counts.rejected.total, rejects: {...this.counts.rejected},
      backoffUntil: this.backoffUntil};
  }
}
