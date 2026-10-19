// Characters a player makes for themselves (docs/CHARACTER_EDITOR.md, "Your own characters"): a name, a rule that says which in-game
// character they are (a record name such as Character.X or NCA.X, a display name, or both), a gender, a bio, a speaking style, a few
// example lines and a few memories. A voice clip for one of them is kept with the clips of story characters (bridge/player-voices.mjs).
//
// Where it lives (player data, never shipped, never touched by an update of the mod):
//   <state>/custom-characters.json      every character, one file, written atomically; a damaged file is kept as .corrupt before the
//                                       first write over it (the same care as bridge/character-overrides.mjs)
// What the game reads: runtime/custom-characters.json (the exchange folder of the mod, replaced in place, shipped empty): only what the
// Lua side needs to recognise a character, {key, name, gender, records, names}. It is read when the player talks to somebody, never per frame.
//
// A character's key is `custom-<slug>-<4 letters>`. The prefix is reserved: no roster key starts with it. It is a hyphen and not a colon
// because every profile key in this bridge and in both voice workers is checked against [a-z0-9-] before it names a memory file, a voice
// or a route, and a key the checks refuse would not work anywhere.
//
// The text providers (Mistral and the Local AI) read a character through PersonaBook.persona(), a plain map lookup. Convai has no
// character for a profile like this: with Convai the game never resolves one (mod/custom-characters.lua), so it is never asked.
import {readFile, readdir, rename, rm, mkdir} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {atomicFile} from './guarded-file.mjs';
import {EDIT_LIMITS, cleanBlock, cleanLine, personaSize} from './character-overrides.mjs';

export const CUSTOM_PREFIX = 'custom-';
export const CUSTOM_KEY = /^custom-[a-z0-9][a-z0-9-]{0,66}$/;
export const isCustomKey = key => typeof key === 'string' && CUSTOM_KEY.test(key);
export const CUSTOM_FILE = 'custom-characters.json';
export const CUSTOM_LIMITS = Object.freeze({
  characters: 40, name: 60,
  records: 6, record: 120, names: 6, displayName: 60,
  bio: EDIT_LIMITS.bio, bioMin: EDIT_LIMITS.bioMin, style: EDIT_LIMITS.style,
  examples: EDIT_LIMITS.examples, example: EDIT_LIMITS.example, exampleTotal: EDIT_LIMITS.exampleTotal,
  memories: EDIT_LIMITS.memories, memory: EDIT_LIMITS.memory, total: EDIT_LIMITS.total,
});
// The record names a record-cloning mod makes of a character ("NCA.Character.Judy", mod/character-catalog.lua CLONE_PREFIXES): a record
// "Character.X" also matches under each prefix, so a player never has to list the clone. Kept in step with the Lua list by a test.
export const CLONE_PREFIXES = Object.freeze(['NCA.']);
const RECORD = /^[A-Za-z0-9_][A-Za-z0-9_.-]{2,119}$/;
const count = text => Array.from(text).length;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const GENDERS = ['female', 'male'];

/** A name the way the game side compares it (mod/character-catalog.lua `normalized`): ASCII lower case, one space between words. */
export const normalizeName = value => String(value ?? '').replace(/[A-Z]/g, letter => letter.toLowerCase()).replace(/\s+/g, ' ').trim();
/** The record names a character answers to: its own, and the same under each clone prefix when it is a "Character." record. */
export const recordVariants = record => [record, ...(/^Character\./.test(record) ? CLONE_PREFIXES.map(prefix => prefix + record) : [])];

/**
 * The names and records the shipped roster already answers to (named characters only), so a custom character cannot be made for
 * somebody who has a profile (the roster always wins in the game, so such a character would never be used).
 */
export function rosterIndex(rows = []) {
  const names = new Map(), records = new Map();
  for (const row of rows) {
    if (!plain(row) || row.kind !== 'named') continue;
    for (const name of [row.name, ...(Array.isArray(row.aliases) ? row.aliases : [])]) {
      const key = normalizeName(name);
      if (key && !names.has(key)) names.set(key, String(row.name));
    }
    for (const record of Array.isArray(row.records) ? row.records : []) {
      if (typeof record !== 'string') continue;
      for (const variant of recordVariants(record)) if (!records.has(variant)) records.set(variant, String(row.name));
    }
  }
  return {name: value => names.get(normalizeName(value)) ?? null, record: value => records.get(value) ?? null};
}

const cleanList = (value, clean) => {
  const seen = new Set(), out = [];
  for (const item of Array.isArray(value) ? value : []) {
    const line = clean(typeof item === 'string' ? item : item?.text);
    if (!line || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase()); out.push(line);
  }
  return out;
};
const cleanName = value => cleanLine(value);
const cleanRecord = value => String(value ?? '').replace(/\s+/g, '').trim();

/**
 * Checks what the editor sent. `input` holds name, gender, records, names, bio, style, examples, memories; `context` has
 * `own` (the key being edited, if any), `others` (the other characters' rows) and `roster` (rosterIndex). Returns {ok: true, value} or
 * {ok: false, errors: [{field, code, max?, index?, other?}]}. Codes are stable words the page turns into plain sentences.
 */
export function validateCustom(input, {others = [], roster = null, limits = CUSTOM_LIMITS} = {}) {
  const errors = [];
  if (!plain(input)) return {ok: false, errors: [{field: '', code: 'bad-request'}]};
  const value = {};
  const name = cleanName(input.name);
  if (!name) errors.push({field: 'name', code: 'name-empty'});
  else if (count(name) > limits.name) errors.push({field: 'name', code: 'name-long', max: limits.name});
  value.name = name;
  const gender = typeof input.gender === 'string' ? input.gender.toLowerCase() : '';
  if (!GENDERS.includes(gender)) errors.push({field: 'gender', code: 'gender-bad'});
  value.gender = gender;

  const records = cleanList(input.records, cleanRecord), names = cleanList(input.names, cleanName);
  if (records.length > limits.records) errors.push({field: 'records', code: 'records-many', max: limits.records});
  records.forEach((record, index) => { if (!RECORD.test(record)) errors.push({field: 'records', code: 'record-bad', index}); });
  if (names.length > limits.names) errors.push({field: 'names', code: 'names-many', max: limits.names});
  names.forEach((text, index) => { if (count(text) > limits.displayName) errors.push({field: 'names', code: 'names-long', max: limits.displayName, index}); });
  if (!records.length && !names.length) errors.push({field: 'records', code: 'match-empty'});
  // Nobody else may answer to the same record or name: the game would have to choose, and the player would not know which.
  records.forEach((record, index) => {
    const taken = others.find(row => row.records.some(other => recordVariants(other).includes(record) || recordVariants(record).includes(other)));
    if (taken) errors.push({field: 'records', code: 'match-taken', index, other: taken.name});
    const owner = roster?.record(record);
    if (owner) errors.push({field: 'records', code: 'match-roster', index, other: owner});
  });
  names.forEach((text, index) => {
    const taken = others.find(row => row.names.some(other => normalizeName(other) === normalizeName(text)));
    if (taken) errors.push({field: 'names', code: 'match-taken', index, other: taken.name});
    const owner = roster?.name(text);
    if (owner) errors.push({field: 'names', code: 'match-roster', index, other: owner});
  });
  value.records = records; value.names = names;

  const bio = cleanBlock(input.bio);
  if (typeof input.bio !== 'string' || count(bio) < limits.bioMin) errors.push({field: 'bio', code: 'bio-short', max: limits.bioMin});
  else if (count(bio) > limits.bio) errors.push({field: 'bio', code: 'bio-long', max: limits.bio});
  value.bio = bio;
  const style = cleanBlock(input.style ?? '');
  if (count(style) > limits.style) errors.push({field: 'style', code: 'style-long', max: limits.style});
  value.style = style;
  const examples = cleanList(input.examples, cleanLine), memories = cleanList(input.memories, cleanLine);
  if (examples.length > limits.examples) errors.push({field: 'examples', code: 'examples-many', max: limits.examples});
  examples.forEach((line, index) => { if (count(line) > limits.example) errors.push({field: 'examples', code: 'examples-long', max: limits.example, index}); });
  if (examples.reduce((sum, line) => sum + count(line), 0) > limits.exampleTotal) errors.push({field: 'examples', code: 'examples-total', max: limits.exampleTotal});
  if (memories.length > limits.memories) errors.push({field: 'memories', code: 'memories-many', max: limits.memories});
  memories.forEach((line, index) => { if (count(line) > limits.memory) errors.push({field: 'memories', code: 'memories-long', max: limits.memory, index}); });
  value.examples = examples; value.memories = memories;
  if (!errors.length && personaSize({bio, style, rules: [], examples, memories}) > limits.total) errors.push({field: '', code: 'too-big', max: limits.total});

  return errors.length ? {ok: false, errors} : {ok: true, value};
}

/** The stored form of a row read from disk: wrong types dropped, text tidied and cut to the limits. Null when nothing usable is left. */
export function readRow(raw, limits = CUSTOM_LIMITS) {
  if (!plain(raw) || !isCustomKey(raw.key)) return null;
  const name = Array.from(cleanName(raw.name)).slice(0, limits.name).join('');
  const bio = Array.from(cleanBlock(raw.bio)).slice(0, limits.bio).join('');
  const gender = typeof raw.gender === 'string' && GENDERS.includes(raw.gender.toLowerCase()) ? raw.gender.toLowerCase() : null;
  if (!name || !gender || !bio) return null;
  const records = cleanList(raw.records, cleanRecord).filter(record => RECORD.test(record)).slice(0, limits.records);
  const names = cleanList(raw.names, cleanName).map(text => Array.from(text).slice(0, limits.displayName).join('')).slice(0, limits.names);
  if (!records.length && !names.length) return null;
  let total = 0;
  const examples = cleanList(raw.examples, cleanLine).map(line => Array.from(line).slice(0, limits.example).join('')).slice(0, limits.examples)
    .filter(line => (total += count(line)) <= limits.exampleTotal);
  const memories = cleanList(raw.memories, cleanLine).map(line => Array.from(line).slice(0, limits.memory).join('')).slice(0, limits.memories);
  const number = value => Number.isFinite(value) ? value : 0;
  return Object.freeze({key: raw.key, name, gender, records: Object.freeze(records), names: Object.freeze(names), bio,
    style: Array.from(cleanBlock(raw.style)).slice(0, limits.style).join(''), examples: Object.freeze(examples), memories: Object.freeze(memories),
    created: number(raw.created), updated: number(raw.updated)});
}

const slugOf = name => {
  const base = String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '');
  return base || 'npc';
};

const CLONED_CLIP = /^(custom-[a-z0-9-]+)\.wav$/;
const PREPARED_SETUP = /^(custom-[a-z0-9-]+)-[0-9a-f]{24}\.safetensors(?:\.tmp)?$/;
/**
 * The files a character's voice leaves outside the data folder, removed when the character goes, and swept at start for any that no character
 * owns any more: the prepared voice setups Pocket saved as <key>-<24 hex>.safetensors, and copies under <reference root>/addons/<key>.wav that
 * builds of this branch before 2026-10-19 made (clips are now read from the data folder and never copied). Only a file with exactly such a name directly in those folders is touched (never a folder,
 * a link, another add-on's voice or a voice of the shipped cast). `key` names one character; without it every character not in `keep` goes.
 * Best effort: a file in use is left and tried again at the next start. Resolves to the number of files removed.
 */
export async function releaseVoiceFiles({roots = [], preparedFolder = null, keep = new Set(), key = null, files = {readdir, rm}} = {}) {
  let removed = 0;
  const sweep = async (folder, pattern) => {
    let entries;
    try { entries = await files.readdir(folder, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      const match = pattern.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink?.()) continue;
      if (key !== null ? match[1] !== key : keep.has(match[1])) continue;
      try { await files.rm(join(folder, entry.name), {force: true}); removed++; } catch { /* in use: left for the next start */ }
    }
  };
  for (const root of new Set(roots.filter(root => typeof root === 'string' && root))) await sweep(join(root, 'addons'), CLONED_CLIP);
  if (preparedFolder) await sweep(preparedFolder, PREPARED_SETUP);
  return removed;
}

const defaultIo = {
  read: file => readFile(file, 'utf8'),
  write: async (file, text) => { await mkdir(dirname(file), {recursive: true}); return atomicFile(file, text); },
  readdir: dir => readdir(dir),
  rename: (from, to) => rename(from, to),
  remove: file => rm(file, {force: true}),
};

export class CustomCharacters {
  /** Reads the file (a missing file is an empty set). A damaged file is left as it is until the player saves again. */
  static async open(options = {}) {
    const store = new CustomCharacters(options);
    await store.#load();
    return store;
  }
  /**
   *   dir          the state folder (custom-characters.json lives in it)
   *   exchangePath runtime/custom-characters.json: what the game reads (replaced in place; never created by a normal run)
   *   roster       rosterIndex(rows): names and records a custom character may not take
   *   onChange     () => void: after every change that reached the disk (the bridge updates its roster rows and the game's list)
   *   onDeleted    (key) => void: the character was deleted (the bridge removes its voice clip, bridge/player-voices.mjs, and its prepared voice setups, releaseVoiceFiles)
   */
  constructor({dir, exchangePath = null, roster = null, now = Date.now, random = size => randomBytes(size), limits = CUSTOM_LIMITS, onChange = () => {}, onDeleted = () => {}, log = () => {},
    read = defaultIo.read, write = defaultIo.write, remove = defaultIo.remove, rename: move = defaultIo.rename} = {}) {
    Object.assign(this, {dir, exchangePath, roster, now, random, limits, onChange, onDeleted, log, read, write, remove, move});
    this.rows = new Map();
    this.damaged = false;
    this.chain = Promise.resolve();
    this.revision = 0;
  }
  get #file() { return join(this.dir, CUSTOM_FILE); }
  async #load() {
    if (!this.dir) return;
    let raw = null;
    try { raw = await this.read(this.#file); } catch { return; }
    if (typeof raw !== 'string' || !raw.trim()) return;   // nothing yet
    let value = null;
    try { value = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); } catch { /* damaged */ }
    if (!plain(value) || value.version !== 1 || !Array.isArray(value.characters)) {
      this.damaged = true;
      this.log('custom characters could not be read; the file is left as it is and kept as ' + CUSTOM_FILE + '.corrupt if you save a character');
      return;
    }
    let dropped = 0;
    for (const item of value.characters) {
      const row = readRow(item, this.limits);
      if (row && !this.rows.has(row.key) && this.rows.size < this.limits.characters) this.rows.set(row.key, row); else dropped++;
    }
    if (dropped) { this.damaged = true; this.log(`${dropped} custom character(s) in the file could not be used; they are kept in ${CUSTOM_FILE}.corrupt if you save a character`); }
  }
  // The damaged file is moved to custom-characters.json.corrupt (an older copy there is replaced) before the first write over it.
  async #keepAside() {
    if (!this.damaged) return;
    try { await this.remove(this.#file + '.corrupt'); await this.move(this.#file, this.#file + '.corrupt'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    this.damaged = false;
    this.log('the custom characters file was damaged: kept as ' + CUSTOM_FILE + '.corrupt');
  }

  // ---- reading (map lookups: safe on the prompt path)
  has(key) { return this.rows.has(key); }
  get(key) { return this.rows.get(key) ?? null; }
  get size() { return this.rows.size; }
  list() { return [...this.rows.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', {sensitivity: 'base'})); }
  /** The persona the prompt builder uses (the shape of PersonaBook.persona): the player's text as it is. */
  persona(key) {
    const row = this.rows.get(key);
    return row ? {name: row.name, ambient: false, backstory: row.bio, style: row.style, samples: [...row.examples], rules: [], memories: [...row.memories], known: true} : null;
  }
  /** The voice that speaks a character with no clip of its own: the resident voice of its gender. */
  voiceAlias(key) {
    const row = this.rows.get(key);
    return row ? (row.gender === 'female' ? 'resident-female' : 'resident-male') : null;
  }
  /** Rows for the bridge's roster array (profileFor and the other lookups by key); the persona text comes from `persona`. */
  rosterRows() {
    return this.list().map(row => ({key: row.key, name: row.name, gender: row.gender === 'female' ? 'FEMALE' : 'MALE', kind: 'custom', aliases: [...row.names], records: [...row.records],
      backstory: row.bio, speakingStyleDescription: row.style, speakingStyleSampleDialogues: row.examples.join('\n\n')}));
  }
  /** What the editor lists. */
  summaries() { return this.list().map(row => ({key: row.key, name: row.name, group: 'custom', edited: false})); }
  /** What the game reads. */
  exchange() {
    return {version: 1, revision: this.revision, characters: this.list().map(row => ({key: row.key, name: row.name, gender: row.gender, records: [...row.records], names: [...row.names]}))};
  }
  // ---- writing
  /** Replaces the file's rows with `rows`. Writes are one at a time and the in-memory set changes only when the file did. */
  #commit(change) {
    const job = this.chain.catch(() => {}).then(async () => {
      const next = new Map(this.rows);
      const result = await change(next);
      if (this.dir) {
        await this.#keepAside();
        const text = JSON.stringify({version: 1, updated: this.now(), characters: [...next.values()]}, null, 1);
        if (!await this.write(this.#file, text)) throw Error('could not save');
      }
      this.rows = next;
      await this.publish();
      try { this.onChange(); } catch (error) { this.log('custom characters: change hook failed: ' + (error?.message ?? 'error')); }
      return result;
    });
    this.chain = job;
    return job;
  }
  /** Writes the game's list in place. Never throws: the game only reads it, and the next change writes it again. */
  async publish() {
    this.revision = this.now();
    if (!this.exchangePath) return false;
    try { return !!await this.write(this.exchangePath, JSON.stringify(this.exchange())); }
    catch (error) { this.log('custom characters: the game list was not written: ' + (error?.code ?? error?.message ?? 'error')); return false; }
  }
  #newKey(taken, name) {
    const slug = slugOf(name);
    for (let attempt = 0; attempt < 50; attempt++) {
      const letters = Array.from(this.random(4), byte => 'abcdefghjkmnpqrstuvwxyz23456789'[byte % 31]).join('');
      const key = `${CUSTOM_PREFIX}${slug}-${letters}`;
      if (!taken.has(key) && CUSTOM_KEY.test(key)) return key;
    }
    throw Object.assign(Error('no free key'), {code: 'no-key'});
  }
  /** Checks `input` for the character `own` (or a new one) against the others and the roster. */
  validate(input, own = null) {
    return validateCustom(input, {others: this.list().filter(row => row.key !== own), roster: this.roster, limits: this.limits});
  }
  /** Makes a character. Resolves to its row; rejects with {code: 'invalid', errors} or {code: 'full'}. */
  create(input) {
    const checked = this.validate(input);
    if (!checked.ok) return Promise.reject(Object.assign(Error('invalid'), {code: 'invalid', errors: checked.errors}));
    return this.#commit(async rows => {
      if (rows.size >= this.limits.characters) throw Object.assign(Error('full'), {code: 'full', max: this.limits.characters});
      const key = this.#newKey(rows, checked.value.name), stamp = this.now();
      const row = readRow({...checked.value, key, created: stamp, updated: stamp}, this.limits);
      rows.set(key, row);
      return row;
    });
  }
  /** Replaces a character's text and match rule. */
  update(key, input) {
    if (!this.rows.has(key)) return Promise.reject(Object.assign(Error('not found'), {code: 'not-found'}));
    const checked = this.validate(input, key);
    if (!checked.ok) return Promise.reject(Object.assign(Error('invalid'), {code: 'invalid', errors: checked.errors}));
    return this.#commit(async rows => {
      const old = rows.get(key);
      if (!old) throw Object.assign(Error('not found'), {code: 'not-found'});
      const row = readRow({...checked.value, key, created: old.created, updated: this.now()}, this.limits);
      rows.set(key, row);
      return row;
    });
  }
  /** Deletes a character (`onDeleted` then removes its voice clip). Resolves to true when there was one. */
  delete(key) {
    if (!this.rows.has(key)) return Promise.resolve(false);
    return this.#commit(async rows => rows.delete(key))
      .then(had => { if (had) this.#deleted(key); return had; });
  }
  #deleted(key) {
    try { const done = this.onDeleted(key); if (done && typeof done.catch === 'function') done.catch(() => {}); } catch { /* the clip and files are swept at the next start */ }
  }
}
