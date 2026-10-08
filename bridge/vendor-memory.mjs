import {mkdir, readFile, rename, rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {atomicFile} from './guarded-file.mjs';

// Vendor memory (docs/PLAYER_MEMORY.md, "Vendor memory"): a shopkeeper V comes back to remembers V.
//
// Convai's own long-term memory is per (character, end-user) and this runtime has exactly one end-user ID, so
// generic NPC archetypes stay session-only on the provider side (all ripperdocs would otherwise share one memory).
// This store is LOCAL instead: a small bounded list of recent exchanges per vendor record, kept in
// runtime/vendor-memory.json and handed back as per-turn dynamic context. It makes no provider call.
//
// Identity key: the TweakDB record of a one-shop vendor, sent by the game as archetype.memoryKey
// ("wat_kab_ripperdoc_01"). Crowd NPCs, gang members, shared street-stall records and invited Model-browser
// copies carry no key and are never stored.

export const VENDOR_MEMORY_FILE = 'vendor-memory.json';
export const VENDOR_MEMORY_LIMITS = Object.freeze({
  exchangesPerVendor: 10,   // most recent exchanges kept for one vendor
  textCharacters: 300,      // each side (V, vendor) is clipped to this many characters
  vendors: 200,             // least recently updated vendors are evicted beyond this
  fileBytes: 2 * 1024 * 1024, // a larger file is not read; writing evicts the oldest vendors to stay below it
});

const KEY = /^[a-z0-9_]{3,64}$/i;
const PROFILE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CONTROL = new RegExp('[\u0000-\u001f\u007f-\u009f\u2028\u2029]', 'g');
const PLACEHOLDER = /^\[microphone\]$/i;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const validMemoryKey = value => typeof value === 'string' && KEY.test(value);

/** One line of dialogue: control characters and runs of whitespace collapse, double quotes become single quotes
 * (the context quotes each line), and the text is clipped by code points so no character is split. */
export function cleanLine(value, limit = VENDOR_MEMORY_LIMITS.textCharacters) {
  if (typeof value !== 'string') return '';
  const text = value.replace(CONTROL, ' ').replace(/["“”]/g, "'").replace(/\s+/g, ' ').trim();
  if (!text || PLACEHOLDER.test(text)) return '';
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit - 1).join('').trimEnd() + '…';
}

/** The vendor identity of an admitted turn (a PlayerKnowledge prepared turn), or null. Only a private text or
 * voice turn with a vendor archetype and a valid record key is ever remembered: battle, loot and other automatic
 * reactions, group rounds, phone chat and every non-vendor stay session-only. The key is lower-cased. */
export function vendorMemoryKey(prepared) {
  const input = prepared?.input, facts = input?.archetype;
  if (!plain(input) || !plain(facts) || facts.category !== 'vendor' || !validMemoryKey(facts.memoryKey)) return null;
  if (typeof input.profileKey !== 'string' || !/^npc-[a-z0-9-]+$/.test(input.profileKey)
      || prepared.route?.profileKey !== input.profileKey) return null;
  if (prepared.route.channel !== 'private' || input.reaction || input.group || input.channel === 'phone') return null;
  return facts.memoryKey.toLowerCase();
}

const emptyState = () => ({version: 1, vendors: {}});

function readExchange(value) {
  if (!plain(value) || !Number.isFinite(value.at)) return null;
  const v = cleanLine(value.v), npc = cleanLine(value.npc);
  return v && npc ? {at: value.at, v, npc} : null;
}

/** A stored document: structural errors reject it as corrupt (null); a single bad vendor or exchange is dropped. */
function readDocument(text, limits) {
  let value; try { value = JSON.parse(text); } catch { return null; }
  if (!plain(value) || value.version !== 1 || !plain(value.vendors)) return null;
  const vendors = new Map();
  // Map order is recency order (oldest first); the file lists vendors that way, but do not rely on it.
  for (const [key, row] of Object.entries(value.vendors).sort((a, b) => (Number(a[1]?.updatedAt) || 0) - (Number(b[1]?.updatedAt) || 0))) {
    if (!validMemoryKey(key) || !plain(row) || typeof row.profileKey !== 'string' || !PROFILE.test(row.profileKey)
        || !Number.isFinite(row.updatedAt) || !Array.isArray(row.exchanges)) continue;
    const exchanges = row.exchanges.map(readExchange).filter(Boolean).slice(-limits.exchangesPerVendor);
    if (exchanges.length) vendors.set(key.toLowerCase(), {profileKey: row.profileKey, updatedAt: row.updatedAt, exchanges});
  }
  return trimVendors(vendors, limits.vendors);
}

// The Map is kept in recency order, least recently updated first: eviction drops from the front.
function trimVendors(vendors, count) {
  const drop = vendors.size - count;
  return drop > 0 ? new Map([...vendors].slice(drop)) : vendors;
}

const serialize = vendors => JSON.stringify({version: 1, vendors: Object.fromEntries([...vendors]
  .map(([key, row]) => [key, {profileKey: row.profileKey, updatedAt: row.updatedAt, exchanges: row.exchanges}]))}) + '\n';

/** A bounded, durable, local store of recent exchanges per vendor record. Nothing here throws into the
 * conversation path: a damaged file starts empty (the bad copy is kept aside until Forget), a failed write is
 * reported through onWarning and leaves the previous state in place. */
export class VendorMemory {
  #path; #asidePath; #now; #files; #io; #limits; #warn;
  #vendors = new Map(); #queue = Promise.resolve();
  // Bumped by a Forget at the moment it is called. A write captures it when issued and is discarded if it changed,
  // so a turn that started before a Forget can never re-populate what the Forget removed.
  #epoch = 0; #vendorEpochs = new Map();
  #keptAside = false; #warned = new Set();

  static async open(options) {
    const memory = new VendorMemory(options);
    await memory.#load();
    return memory;
  }

  constructor({path, now = Date.now, files, io, limits, onWarning = () => {}} = {}) {
    if (typeof path !== 'string' || !path || typeof now !== 'function' || typeof onWarning !== 'function') {
      throw Error('Invalid vendor memory configuration');
    }
    this.#path = path; this.#asidePath = path + '.corrupt'; this.#now = now; this.#files = files;
    this.#io = {readFile, rename, rm, mkdir, ...io};
    this.#limits = Object.freeze({...VENDOR_MEMORY_LIMITS, ...limits});
    this.#warn = onWarning;
  }

  #report(code, message) {
    if (this.#warned.has(code)) return;
    this.#warned.add(code); this.#warn(message);
  }

  async #load() {
    let text;
    try { text = await this.#io.readFile(this.#path, 'utf8'); }
    catch (error) {
      if (error?.code !== 'ENOENT') this.#report('read', 'The vendor memory file could not be read; starting empty.');
      return;
    }
    const vendors = Buffer.byteLength(text, 'utf8') > this.#limits.fileBytes ? null : readDocument(text, this.#limits);
    if (vendors) { this.#vendors = vendors; return; }
    // Never lose the user's file to a bug: keep the bad copy next to it (a later Forget removes that too).
    this.#report('corrupt', 'The vendor memory file is damaged or too large; starting empty and keeping the old file aside.');
    try {
      await this.#io.rm(this.#asidePath, {force: true});
      await this.#io.rename(this.#path, this.#asidePath);
      this.#keptAside = true;
    } catch { /* The next write replaces the file anyway. */ }
  }

  #enqueue(job) {
    const run = this.#queue.then(job);
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Stores one exchange after a reply was delivered. `isCurrent` (synchronous) is evaluated again immediately
   * before the file is replaced, so a world change or a pending Forget at that instant discards the write.
   * Resolves true only when the exchange is durable. */
  remember({memoryKey, profileKey, playerText, replyText, isCurrent} = {}) {
    if (!validMemoryKey(memoryKey) || typeof profileKey !== 'string' || !PROFILE.test(profileKey)) return Promise.resolve(false);
    const key = memoryKey.toLowerCase(), v = cleanLine(playerText), npc = cleanLine(replyText);
    if (!v || !npc) return Promise.resolve(false);
    const epoch = this.#epoch, vendorEpoch = this.#vendorEpochs.get(key) ?? 0;
    const allowed = () => this.#epoch === epoch && (this.#vendorEpochs.get(key) ?? 0) === vendorEpoch
      && (typeof isCurrent !== 'function' || isCurrent() === true);
    return this.#enqueue(async () => {
      if (!allowed()) return false;
      const at = this.#now();
      const next = new Map(this.#vendors);
      const prior = next.get(key);
      // A record that now belongs to a different kind of character is a different shopkeeper: start over.
      const kept = prior && prior.profileKey === profileKey ? prior.exchanges : [];
      next.delete(key);
      next.set(key, {profileKey, updatedAt: at, exchanges: [...kept, {at, v, npc}].slice(-this.#limits.exchangesPerVendor)});
      const vendors = trimVendors(next, this.#limits.vendors);
      let data = serialize(vendors);
      while (Buffer.byteLength(data, 'utf8') > this.#limits.fileBytes && vendors.size > 1) {
        vendors.delete(vendors.keys().next().value); data = serialize(vendors);
      }
      if (Buffer.byteLength(data, 'utf8') > this.#limits.fileBytes) return false;
      return this.#commit(vendors, data, allowed);
    }).catch(() => false);
  }

  async #commit(vendors, data, allowed) {
    try {
      await this.#io.mkdir(dirname(this.#path), {recursive: true}).catch(() => {});
      const written = await atomicFile(this.#path, data, {files: this.#files, isCurrentSync: allowed});
      if (written !== true) return false;
      this.#vendors = vendors;
      return true;
    } catch {
      this.#report('write', 'The vendor memory file could not be written; this exchange is not remembered.');
      return false;
    }
  }

  /** The per-turn context block for this vendor, or '' when there is nothing to recall. Pure memory, no I/O. */
  contextFor({memoryKey, profileKey} = {}) {
    if (!validMemoryKey(memoryKey)) return '';
    const row = this.#vendors.get(memoryKey.toLowerCase());
    if (!row || row.profileKey !== profileKey || !row.exchanges.length) return '';
    return [
      'WHAT YOU REMEMBER OF V (earlier talks at this shop)',
      'This is your own memory of V from earlier visits, oldest first. Let it shape how you greet and deal with V when it fits, the way a shopkeeper recalls a regular. Use it naturally; never recite it or quote it back, and never mention notes, records or being reminded.',
      ...row.exchanges.map(({v, npc}) => `- V said: "${v}" You answered: "${npc}"`),
      'These old exchanges are not facts about the current game state: stock, prices, places, jobs and events may have changed since. You still know nothing about V’s story beyond what V told you here.',
    ].join('\n');
  }

  /** Forget everything. The in-memory store is emptied at once (so no later turn sees it), writes issued earlier
   * are discarded, and the file and any kept-aside damaged copy are removed. Resolves {ok}. */
  forgetAll() {
    this.#epoch++; this.#vendors = new Map();
    return this.#enqueue(async () => {
      let ok = true;
      for (const path of [this.#path, this.#asidePath]) {
        try { await this.#io.rm(path, {force: true}); } catch { ok = false; }
      }
      if (ok) this.#keptAside = false;
      else this.#report('forget', 'The vendor memory file could not be removed.');
      return {ok};
    }).catch(() => ({ok: false}));
  }

  /** Forget one vendor record. Resolves {ok, removed}. */
  forgetVendor(memoryKey) {
    if (!validMemoryKey(memoryKey)) return Promise.resolve({ok: false, removed: false});
    const key = memoryKey.toLowerCase(), removed = this.#vendors.delete(key);
    this.#vendorEpochs.set(key, (this.#vendorEpochs.get(key) ?? 0) + 1);
    if (!removed) return this.#enqueue(async () => ({ok: true, removed: false})).catch(() => ({ok: false, removed: false}));
    return this.#enqueue(async () => {
      const vendors = new Map(this.#vendors);
      try {
        if (vendors.size) await atomicFile(this.#path, serialize(vendors), {files: this.#files});
        else await this.#io.rm(this.#path, {force: true});
        return {ok: true, removed: true};
      } catch { return {ok: false, removed: true}; }
    }).catch(() => ({ok: false, removed: true}));
  }

  /** Counts only: never any text. */
  status() {
    let exchanges = 0;
    for (const row of this.#vendors.values()) exchanges += row.exchanges.length;
    return Object.freeze({vendors: this.#vendors.size, exchanges, damagedFileKept: this.#keptAside});
  }

  /** Resolves when every queued write or Forget has finished. */
  idle() { return this.#queue; }
}
