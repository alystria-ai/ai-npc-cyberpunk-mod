// What the character editor does, apart from how it is served (docs/CHARACTER_EDITOR.md): the list of characters, one character's shipped
// and edited text, saving with validation, going back to the shipped text, and the memories the text providers keep.
//
// The shipped profile (the Convai-derived roster row) is never written: the player's edits go to bridge/character-overrides.mjs, which
// the prompt builder reads (PersonaBook). Memories written by hand are part of those edits (they are always in the prompt); the
// memories the character picked up in talks, and the short summary of older talks, live in the memory store and are edited there.
import {EDIT_LIMITS, FIELDS, cleanBlock, cleanLine, validateOverride} from './character-overrides.mjs';
import {STORE_LIMITS} from './memory-store.mjs';

export class EditorError extends Error {
  constructor(status, code, errors = []) { super(code); this.status = status; this.code = code; this.errors = errors; }
}
const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;

export class CharacterEditor {
  /**
   *   personas   PersonaBook (the shipped rows and the overrides it merges)
   *   overrides  CharacterOverrides
   *   memory     MemoryStore (optional: without it the memory part is empty)
   *   route      () => 'convai' | 'mistral' | 'local': who answers conversations now
   */
  constructor({personas, overrides, memory = null, route = () => 'convai', limits = EDIT_LIMITS} = {}) {
    Object.assign(this, {personas, overrides, memory, route, limits});
  }
  get limitsForPage() { return {...this.limits, record: STORE_LIMITS.fact, summary: STORE_LIMITS.summary}; }

  #row(key) {
    const row = KEY.test(key ?? '') ? this.personas.rows.get(key) : null;
    if (!row || !['named', 'ambient', 'archetype'].includes(row.kind)) throw new EditorError(404, 'not-found');
    return row;
  }
  /** Every character the editor offers: the named ones first, then the everyday people, each group by name. */
  catalog() {
    const rows = [...this.personas.rows.values()].filter(row => ['named', 'ambient', 'archetype'].includes(row.kind));
    return rows.map(row => ({key: row.key, name: String(row.name || row.key), group: row.kind === 'named' ? 'story' : 'everyday', edited: !!this.overrides.get(row.key)}))
      .sort((a, b) => (a.group === b.group ? 0 : a.group === 'story' ? -1 : 1) || a.name.localeCompare(b.name, 'en', {sensitivity: 'base'}));
  }
  state() { return {provider: this.route(), characters: this.catalog(), limits: this.limitsForPage}; }

  /** The shipped text of a character in the editor's five fields. */
  defaults(key) {
    this.#row(key);
    const shipped = this.personas.defaults(key);
    return {bio: cleanBlock(shipped.backstory), style: cleanBlock(shipped.style), rules: [], examples: shipped.samples.map(cleanLine).filter(Boolean), memories: []};
  }
  /** Everything the page needs for one character. */
  details(key) {
    const row = this.#row(key), defaults = this.defaults(key), stored = this.overrides.get(key) ?? {};
    const memory = row.kind === 'named' && this.memory ? {
      available: true, learns: this.memory.learns === true, summary: this.memory.recall({profileKey: key, channel: 'private'}).summary ?? '',
      records: this.memory.listRecords(key).map(({id, kind, text, pinned, updated}) => ({id, kind, text, pinned, updated})),
    } : {available: false, learns: false, summary: '', records: []};
    return {key, name: String(row.name || key), group: row.kind === 'named' ? 'story' : 'everyday', defaults,
      values: Object.fromEntries(FIELDS.map(field => [field, field in stored ? stored[field] : defaults[field]])),
      edited: Object.fromEntries(FIELDS.map(field => [field, field in stored])), memory};
  }
  /** Saves the fields in `patch`. Throws EditorError 422 with `errors` when something is over a limit; nothing is stored then. */
  async save(key, patch) {
    this.#row(key);
    const result = validateOverride(patch, this.defaults(key), this.overrides.get(key) ?? {}, this.limits);
    if (!result.ok) throw new EditorError(422, 'invalid', result.errors);
    await this.#store(key, result.value);
    return this.details(key);
  }
  /** Back to the shipped text: the named fields, or all of them. */
  async reset(key, fields) {
    this.#row(key);
    const list = fields == null ? FIELDS : Array.isArray(fields) ? fields : null;
    if (!list || list.some(field => !FIELDS.includes(field))) throw new EditorError(400, 'bad-request');
    const stored = {...(this.overrides.get(key) ?? {})};
    for (const field of list) delete stored[field];
    await this.#store(key, stored);
    return this.details(key);
  }
  async #store(key, fields) {
    try { await this.overrides.set(key, fields); } catch { throw new EditorError(500, 'not-saved'); }
  }

  // ---- what the character picked up in talks (the memory store)
  #named(key) {
    const row = this.#row(key);
    if (row.kind !== 'named' || !this.memory) throw new EditorError(404, 'not-found');
  }
  editRecord(key, id, text) {
    this.#named(key);
    if (typeof id !== 'string' || typeof text !== 'string') throw new EditorError(400, 'bad-request');
    if (!cleanLine(text)) throw new EditorError(422, 'empty');
    if (!this.memory.editRecord(key, id, text)) throw new EditorError(404, 'not-found');
    return this.details(key);
  }
  deleteRecord(key, id) {
    this.#named(key);
    if (!this.memory.deleteRecord(key, id)) throw new EditorError(404, 'not-found');
    return this.details(key);
  }
  setSummary(key, text) {
    this.#named(key);
    if (typeof text !== 'string') throw new EditorError(400, 'bad-request');
    if (this.memory.setSummary(key, text) === null) throw new EditorError(500, 'not-saved');
    return this.details(key);
  }
}
