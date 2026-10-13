// A player's own edits to a character (docs/CHARACTER_EDITOR.md): the bio, the speaking style, the player's speaking rules, the example
// lines and a few memories written by hand. They are kept apart from the shipped profile, one small file per character in
// <state>/character-overrides/<key>.json, so an update of the mod never touches them, and only the text providers (Mistral, Groq and
// the Local AI) read them: the Convai profile lives on Convai's side and is not changed.
//
// A file holds only the fields that differ from the shipped profile ("reset" removes a field or the whole file). Everything is
// validated against LIMITS before it is stored, so the prompt of the 8b model stays about as long as the longest shipped profile.
// `CharacterOverrides.get` is a plain map lookup: the prompt builder calls it on every turn and nothing here touches the disk then.
import {readFile, readdir, rm, mkdir} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {atomicFile} from './guarded-file.mjs';

export const EDIT_LIMITS = Object.freeze({
  bio: 9000,            // characters; the longest shipped bio is 8,266
  bioMin: 40,           // a bio of a few words leaves the model nothing to be
  style: 1800,          // the longest shipped speaking style is 1,439
  rules: 10, rule: 160,         // the player's own rules of speech: a short list of short rules
  examples: 20, example: 240, exampleTotal: 3000,   // the longest shipped set is 18 lines of up to 146 characters
  memories: 12, memory: 200,    // things written by hand that the character always knows
  total: 14000,         // bio + style + rules + examples + memories together (the longest shipped profile is 11,295)
});
export const FIELDS = Object.freeze(['bio', 'style', 'rules', 'examples', 'memories']);
const LISTS = new Set(['rules', 'examples', 'memories']);
const ITEM = {rules: 'rule', examples: 'example', memories: 'memory'};
const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const FILE = /^([a-z0-9][a-z0-9-]{0,79})\.json$/;
const MARKER = /^\s*\[CyberpunkConvai profile[^\]]*\]\s*$/gm;
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');
const count = text => Array.from(text).length;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A bio or a style: line breaks stay (the shipped bios are sectioned), everything else is tidied. */
export function cleanBlock(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(MARKER, '').replace(CONTROL, ' ').replace(/\t/g, ' ')
    .replace(/[ ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ ]{2,}/g, ' ').trim();
}
/** One rule, example line or memory: a single line. */
export const cleanLine = value => String(value ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
const cleanList = value => {
  const seen = new Set(), out = [];
  for (const item of Array.isArray(value) ? value : []) {
    const line = cleanLine(typeof item === 'string' ? item : item?.text);
    if (!line || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase()); out.push(line);
  }
  return out;
};
const same = (a, b) => Array.isArray(a) ? Array.isArray(b) && a.length === b.length && a.every((line, i) => line === b[i]) : a === b;

/** The size of a persona's editable text, in characters: what the total limit measures. */
export const personaSize = persona => count(persona.bio ?? '') + count(persona.style ?? '')
  + [persona.rules, persona.examples, persona.memories].flat().reduce((sum, line) => sum + count(line ?? ''), 0);

/**
 * Checks what the player sent against the shipped profile. `patch` holds any of the five fields; `defaults` is
 * {bio, style, rules, examples, memories} of the shipped profile; `current` the fields stored now (to keep the ones not in the patch).
 * Returns {ok: true, value} with the fields to store (a field equal to its shipped text is dropped), or {ok: false, errors:
 * [{field, code, max?, index?}]}. Codes are stable words the page turns into plain sentences.
 */
export function validateOverride(patch, defaults, current = {}, limits = EDIT_LIMITS) {
  const errors = [], next = {...current};
  if (!plain(patch)) return {ok: false, errors: [{field: '', code: 'bad-request'}]};
  for (const field of Object.keys(patch)) if (!FIELDS.includes(field)) errors.push({field, code: 'unknown-field'});
  for (const field of FIELDS) {
    if (!(field in patch)) continue;
    const given = patch[field];
    if (given === null) { delete next[field]; continue; }               // null: back to the shipped text
    if (LISTS.has(field)) {
      if (!Array.isArray(given)) { errors.push({field, code: 'bad-type'}); continue; }
      const list = cleanList(given), max = limits[field], item = limits[ITEM[field]];
      if (list.length > max) errors.push({field, code: `${field}-many`, max});
      list.forEach((line, index) => { if (count(line) > item) errors.push({field, code: `${field}-long`, max: item, index}); });
      if (field === 'examples' && list.reduce((sum, line) => sum + count(line), 0) > limits.exampleTotal) errors.push({field, code: 'examples-total', max: limits.exampleTotal});
      next[field] = list;
    } else {
      if (typeof given !== 'string') { errors.push({field, code: 'bad-type'}); continue; }
      const text = cleanBlock(given);
      if (field === 'bio' && count(text) < limits.bioMin) errors.push({field, code: 'bio-short', max: limits.bioMin});
      if (count(text) > limits[field]) errors.push({field, code: `${field}-long`, max: limits[field]});
      next[field] = text;
    }
  }
  for (const field of FIELDS) if (field in next && same(next[field], defaults[field])) delete next[field];
  if (!errors.length) {
    const merged = Object.fromEntries(FIELDS.map(field => [field, field in next ? next[field] : defaults[field]]));
    if (personaSize(merged) > limits.total) errors.push({field: '', code: 'too-big', max: limits.total});
  }
  return errors.length ? {ok: false, errors} : {ok: true, value: next};
}

/** The stored form of a file's fields: wrong types dropped, text tidied and cut to the limits (a damaged file never grows the prompt). */
export function readOverride(value, limits = EDIT_LIMITS) {
  const out = {};
  if (!plain(value)) return out;
  if (typeof value.bio === 'string') { const text = cleanBlock(value.bio); if (count(text) >= limits.bioMin) out.bio = Array.from(text).slice(0, limits.bio).join(''); }
  if (typeof value.style === 'string') out.style = Array.from(cleanBlock(value.style)).slice(0, limits.style).join('');
  for (const field of LISTS) {
    if (!Array.isArray(value[field])) continue;
    const item = limits[ITEM[field]];
    out[field] = cleanList(value[field]).map(line => Array.from(line).slice(0, item).join('')).slice(0, limits[field]);
  }
  if (out.examples) {
    let total = 0;
    out.examples = out.examples.filter(line => (total += count(line)) <= limits.exampleTotal);
  }
  return out;
}

/** The persona as the prompt builder uses it: the player's fields in place of the shipped ones. `rules` and `memories` are new. */
export function applyOverride(persona, override) {
  if (!override) return persona;
  return {...persona, backstory: override.bio ?? persona.backstory, style: override.style ?? persona.style,
    samples: override.examples ?? persona.samples, rules: override.rules ?? [], memories: override.memories ?? []};
}

const defaultIo = {
  read: file => readFile(file, 'utf8'),
  write: async (file, text) => { await mkdir(dirname(file), {recursive: true}); return atomicFile(file, text); },
  readdir: dir => readdir(dir),
  remove: file => rm(file, {force: true}),
};

export class CharacterOverrides {
  /** Loads every file of the folder into memory (a missing folder is an empty set). Damaged files are skipped and left on disk. */
  static async open(options = {}) {
    const store = new CharacterOverrides(options);
    await store.#load();
    return store;
  }
  constructor({dir, now = Date.now, limits = EDIT_LIMITS, read = defaultIo.read, write = defaultIo.write, readdir: list = defaultIo.readdir,
    remove = defaultIo.remove, log = () => {}} = {}) {
    Object.assign(this, {dir, now, limits, read, write, listDir: list, remove, log});
    this.rows = new Map();
    this.chain = Promise.resolve();
  }
  #path(key) { return join(this.dir, key + '.json'); }
  async #load() {
    if (!this.dir) return;
    let names;
    try { names = await this.listDir(this.dir); } catch { return; }
    for (const name of names) {
      const match = FILE.exec(name);
      if (!match) continue;
      try {
        const value = JSON.parse(await this.read(join(this.dir, name)));
        if (!plain(value) || value.version !== 1 || value.key !== match[1]) continue;
        const row = readOverride(value, this.limits);
        if (Object.keys(row).length) this.rows.set(match[1], Object.freeze(row));
      } catch { this.log(`character edits of ${match[1]} could not be read; they are left as they are`); }
    }
  }
  /** The stored fields of a character, or null. A map lookup: safe on the prompt path. */
  get(key) { return this.rows.get(key) ?? null; }
  /** Keys of the characters that have edits. */
  keys() { return [...this.rows.keys()]; }
  /**
   * Stores the fields of a character (an empty set removes the file). Writes are one at a time and the in-memory copy changes only
   * when the file did, so a failed save leaves both as they were. Resolves to the stored fields (or null).
   */
  set(key, fields) {
    if (!KEY.test(key ?? '')) return Promise.reject(Object.assign(Error('invalid character key'), {code: 'bad-key'}));
    const row = readOverride(fields, this.limits), empty = Object.keys(row).length === 0;
    const job = this.chain.catch(() => {}).then(async () => {
      if (!this.dir) { if (empty) this.rows.delete(key); else this.rows.set(key, Object.freeze(row)); return empty ? null : this.rows.get(key); }
      if (empty) await this.remove(this.#path(key));
      else if (!await this.write(this.#path(key), JSON.stringify({version: 1, key, updated: this.now(), ...row}, null, 1))) throw Error('could not save');
      if (empty) this.rows.delete(key); else this.rows.set(key, Object.freeze(row));
      return empty ? null : this.rows.get(key);
    });
    this.chain = job;
    return job;
  }
  /** Back to the shipped profile: one field, or (no field) everything for this character. */
  reset(key, field) {
    const row = {...(this.get(key) ?? {})};
    if (field) { if (!FIELDS.includes(field)) return Promise.reject(Object.assign(Error('unknown field'), {code: 'unknown-field'})); delete row[field]; return this.set(key, row); }
    return this.set(key, {});
  }
}
