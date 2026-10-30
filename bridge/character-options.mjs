// What a player chooses for a character besides its words (docs/CHARACTER_EDITOR.md, "Look and moves"): the clothes, which gestures and idle
// moves the character may use, whether it sits down, whether it comments on fights and loot, and how long its replies are.
//
// One small file in the service's data folder, <state>/character-options.json: {version: 1, updated, characters: {<key>: {...}}}. A row holds only the
// choices that differ from today's behaviour, so a character with no row (every character before this feature) behaves exactly as before, and a row
// with nothing in it is removed. Writes are atomic and one at a time; the in-memory set changes only when the file did.
//
// The game reads a copy of the same choices from runtime/character-options.json (the exchange folder of the mod, replaced in place; mod/character-options.lua
// reads it when the mod loads and, for two hours after the editor was opened, every few seconds). Only the choices the game acts on go there; the reply
// length stays in the service. Nothing here runs per turn except `talkWords`, a map lookup the prompt builder uses.
import {readFile, rename, rm, mkdir} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {atomicFile} from './guarded-file.mjs';

export const OPTIONS_FILE = 'character-options.json';
export const OPTION_LIMITS = Object.freeze({characters: 400, people: 200});
/** A game record name of an ordinary person the player switched off (the same shape the editor accepts for a character's records). */
const RECORD = /^[A-Za-z0-9_][A-Za-z0-9_.\-]{0,119}$/;
const PERSON_NAME_MAX = 80;
const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const OUTFIT = /^[a-z0-9][a-z0-9_]{0,119}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The choices, each with the values a row may hold. A value that is not listed (or a missing one) means today's behaviour, and is never stored.
 *   talk    how the character moves its hands while it speaks a longer reply: calm (smaller, fewer), lively (more, bigger), none (hands stay at rest)
 *   nods    false: it does not nod while V talks to it
 *   idle    its idle moves while it stands settled: plain (no props such as a cup or a cigarette), none (it keeps the stance it has)
 *   sit     false: it never takes a seat or a place of the flat; it stays beside V
 *   react   false: it says nothing about fights and loot
 *   length  the longest reply, in words: short (25), brief (12). Text providers only (Mistral, Local AI, Custom)
 *   outfit  the name of one of the character's looks (bridge/outfit-choices.mjs)
 *   off     true: the player does not want to talk to this character. It is never a talk target or a group listener (the game side: manager.profileEnabled)
 */
export const OPTION_VALUES = Object.freeze({
  talk: Object.freeze(['calm', 'lively', 'none']),
  nods: Object.freeze([false]),
  idle: Object.freeze(['plain', 'none']),
  sit: Object.freeze([false]),
  react: Object.freeze([false]),
  length: Object.freeze(['short', 'brief']),
  off: Object.freeze([true]),
});
export const OPTION_FIELDS = Object.freeze(['outfit', ...Object.keys(OPTION_VALUES)]);
/** The reply length in words that each `length` choice sets (persona.talkWords; the prompt builder accepts 8 to 60). */
export const REPLY_WORDS = Object.freeze({short: 25, brief: 12});
/** The fields the game side reads. */
const GAME_FIELDS = OPTION_FIELDS.filter(field => field !== 'length');

/** A row as it may be stored: only known fields with allowed values. */
export function readOptions(value) {
  const out = {};
  if (!plain(value)) return out;
  if (typeof value.outfit === 'string' && OUTFIT.test(value.outfit)) out.outfit = value.outfit;
  for (const [field, allowed] of Object.entries(OPTION_VALUES)) if (allowed.includes(value[field])) out[field] = value[field];
  return out;
}

/**
 * Checks what the page sent. `patch` holds any of the fields; null (or the value of today's behaviour) puts a field back to the default. `current` is the stored
 * row. `outfitOk(name)` says whether the name is one of the character's own looks (a character without looks has none to choose). Returns {ok: true, value} with the
 * row to store, or {ok: false, errors: [{field, code}]}.
 */
export function validateOptions(patch, current = {}, {outfitOk = () => false} = {}) {
  const errors = [], next = {...current};
  if (!plain(patch)) return {ok: false, errors: [{field: '', code: 'bad-request'}]};
  for (const field of Object.keys(patch)) if (!OPTION_FIELDS.includes(field)) errors.push({field, code: 'unknown-field'});
  for (const field of OPTION_FIELDS) {
    if (!(field in patch)) continue;
    const given = patch[field];
    if (given === null) { delete next[field]; continue; }
    if (field === 'outfit') {
      if (typeof given !== 'string' || !OUTFIT.test(given) || !outfitOk(given)) { errors.push({field, code: 'outfit-bad'}); continue; }
      next.outfit = given;
    } else if (OPTION_VALUES[field].includes(given)) next[field] = given;
    else errors.push({field, code: 'option-bad'});
  }
  return errors.length ? {ok: false, errors} : {ok: true, value: next};
}

/** One switched-off person as it may be stored: {record, name?}, or null. */
export function readPerson(value) {
  const record = typeof value === 'string' ? value : plain(value) ? value.record : null;
  if (typeof record !== 'string' || !RECORD.test(record)) return null;
  const name = plain(value) && typeof value.name === 'string' ? value.name.trim().slice(0, PERSON_NAME_MAX) : '';
  return Object.freeze(name ? {record, name} : {record});
}

const defaultIo = {
  read: file => readFile(file, 'utf8'),
  write: async (file, text) => { await mkdir(dirname(file), {recursive: true}); return atomicFile(file, text); },
  rename: (from, to) => rename(from, to),
  remove: file => rm(file, {force: true}),
  exists: async file => { try { await readFile(file); return true; } catch { return false; } },
};

export class CharacterOptions {
  /** Reads the file (a missing file is no choices). A damaged file is left as it is until the player saves again. */
  static async open(options = {}) {
    const store = new CharacterOptions(options);
    await store.#load();
    return store;
  }
  /**
   *   dir          the state folder (character-options.json lives in it)
   *   exchangePath runtime/character-options.json: what the game reads (replaced in place)
   *   onChange     () => void: after a change reached the disk and the game's copy was written
   */
  constructor({dir, exchangePath = null, now = Date.now, limits = OPTION_LIMITS, onChange = () => {}, log = () => {},
    read = defaultIo.read, write = defaultIo.write, removeFile = defaultIo.remove, rename: move = defaultIo.rename, exists = defaultIo.exists} = {}) {
    Object.assign(this, {dir, exchangePath, now, limits, onChange, log, read, write, removeFile, move, exists});
    this.rows = new Map();
    this.people = new Map();   // switched-off ordinary people: lower-case record name -> {record, name}
    this.damaged = false;
    this.chain = Promise.resolve();
    this.published = null;   // the text of the game's copy as last written (a save that changes nothing the game reads writes nothing)
  }
  get maxPeople() { return this.limits.people ?? OPTION_LIMITS.people; }
  get #file() { return join(this.dir, OPTIONS_FILE); }
  async #load() {
    if (!this.dir) return;
    let raw = null;
    try { raw = await this.read(this.#file); } catch { return; }
    if (typeof raw !== 'string' || !raw.trim()) return;
    let value = null;
    try { value = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); } catch { /* damaged */ }
    if (!plain(value) || value.version !== 1 || !plain(value.characters)) {
      this.damaged = true;
      this.log(`character choices could not be read; the file is left as it is and kept as ${OPTIONS_FILE}.corrupt if you save a choice`);
      return;
    }
    for (const [key, item] of Object.entries(value.characters)) {
      if (!KEY.test(key) || this.rows.size >= this.limits.characters) continue;
      const row = readOptions(item);
      if (Object.keys(row).length) this.rows.set(key, Object.freeze(row));
    }
    for (const item of Array.isArray(value.records) ? value.records : []) {
      const person = readPerson(item);
      if (person && this.people.size < this.maxPeople && !this.people.has(person.record.toLowerCase())) this.people.set(person.record.toLowerCase(), person);
    }
  }
  async #keepAside() {
    if (!this.damaged) return;
    try { await this.removeFile(this.#file + '.corrupt'); await this.move(this.#file, this.#file + '.corrupt'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    this.damaged = false;
    this.log(`the character choices file was damaged: kept as ${OPTIONS_FILE}.corrupt`);
  }

  // ---- reading (map lookups: safe on the prompt path)
  /** The stored choices of a character, or null. */
  get(key) { return this.rows.get(key) ?? null; }
  keys() { return [...this.rows.keys()]; }
  get size() { return this.rows.size; }
  /** The longest reply, in words, the player chose for a character, or 0 for the mod's own length. */
  talkWords(key) { return REPLY_WORDS[this.rows.get(key)?.length] ?? 0; }
  /** What the game reads: only the choices it acts on. */
  exchange() {
    const characters = {};
    for (const key of [...this.rows.keys()].sort()) {
      const row = this.rows.get(key), game = Object.fromEntries(GAME_FIELDS.filter(field => field in row).map(field => [field, row[field]]));
      if (Object.keys(game).length) characters[key] = game;
    }
    const people = [...this.people.values()].map(person => person.record).sort();
    return people.length ? {version: 1, characters, records: people} : {version: 1, characters};
  }

  // ---- writing
  #commit(change) {
    const job = this.chain.catch(() => {}).then(async () => {
      const next = new Map(this.rows), nextPeople = new Map(this.people);
      const result = change(next, nextPeople);
      if (this.dir) {
        await this.#keepAside();
        const characters = Object.fromEntries([...next.entries()].sort(([a], [b]) => a.localeCompare(b)));
        const records = [...nextPeople.values()].sort((a, b) => a.record.localeCompare(b.record));
        const file = {version: 1, updated: this.now(), characters, ...(records.length ? {records} : {})};
        if (!await this.write(this.#file, JSON.stringify(file, null, 1))) throw Error('could not save');
      }
      this.rows = next;
      this.people = nextPeople;
      await this.publish();
      try { this.onChange(); } catch (error) { this.log('character choices: change hook failed: ' + (error?.message ?? 'error')); }
      return result;
    });
    this.chain = job;
    return job;
  }
  /**
   * Writes the game's copy in place. Never throws: the game only reads it, and the next change writes it again. `quiet`: at start, a service
   * that has no choices and finds no copy of an earlier run writes nothing (a new file in the game folder is avoided when there is nothing to say).
   */
  async publish({quiet = false} = {}) {
    if (!this.exchangePath) return false;
    try {
      if (quiet && !this.rows.size && !this.people.size && !await this.exists(this.exchangePath)) return false;
      const text = JSON.stringify(this.exchange());
      if (text === this.published) return true;
      const written = !!await this.write(this.exchangePath, text);
      if (written) this.published = text;
      return written;
    } catch (error) { this.log('character choices: the game copy was not written: ' + (error?.code ?? error?.message ?? 'error')); return false; }
  }
  /** Stores the choices of a character (an empty set removes the row). Resolves to the stored row or null. */
  set(key, fields) {
    if (!KEY.test(key ?? '')) return Promise.reject(Object.assign(Error('invalid character key'), {code: 'bad-key'}));
    const row = readOptions(fields), empty = Object.keys(row).length === 0;
    return this.#commit(rows => {
      if (empty) { rows.delete(key); return null; }
      if (!rows.has(key) && rows.size >= this.limits.characters) throw Object.assign(Error('full'), {code: 'full', max: this.limits.characters});
      rows.set(key, Object.freeze(row));
      return rows.get(key);
    });
  }
  /** Back to today's behaviour for one field, or (no field) for the whole character. */
  reset(key, field) {
    if (field === undefined || field === null) return this.set(key, {});
    if (!OPTION_FIELDS.includes(field)) return Promise.reject(Object.assign(Error('unknown field'), {code: 'unknown-field'}));
    const row = {...(this.get(key) ?? {})};
    delete row[field];
    return this.set(key, row);
  }
  /** The character is gone (a player's own, deleted): its row goes. Removing none is not an error. */
  remove(key) { return this.rows.has(key) ? this.set(key, {}) : Promise.resolve(null); }
  // ---- ordinary people the player switched off (by the game record they are built from)
  /** The switched-off people, by record name. */
  offPeople() { return [...this.people.values()].sort((a, b) => a.record.localeCompare(b.record)); }
  isPersonOff(record) { return typeof record === 'string' && this.people.has(record.toLowerCase()); }
  /** Switches a person off (`off` true) or back on. Resolves to the list. Rejects with code bad-record, or full with max. */
  setPersonOff(record, name, off) {
    const person = readPerson({record, name});
    if (!person) return Promise.reject(Object.assign(Error('invalid record'), {code: 'bad-record'}));
    const id = person.record.toLowerCase();
    return this.#commit((rows, people) => {
      if (!off) people.delete(id);
      else {
        if (!people.has(id) && people.size >= this.maxPeople) throw Object.assign(Error('full'), {code: 'full', max: this.maxPeople});
        people.set(id, people.get(id)?.name && !person.name ? people.get(id) : person);
      }
      return [...people.values()];
    });
  }
  /** Drops the rows of characters that no longer exist (`keep(key)` false), once, at start. */
  async prune(keep) {
    const gone = [...this.rows.keys()].filter(key => !keep(key));
    if (!gone.length) return 0;
    await this.#commit(rows => { for (const key of gone) rows.delete(key); });
    return gone.length;
  }
}
