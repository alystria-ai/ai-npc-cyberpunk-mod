// What the character editor does, apart from how it is served (docs/CHARACTER_EDITOR.md): the list of characters, one character's shipped
// and edited text, saving with validation, going back to the shipped text, the memories the text providers keep, and the characters
// the player makes for themselves (bridge/custom-characters.mjs).
//
// The shipped profile (the Convai-derived roster row) is never written: the player's edits go to bridge/character-overrides.mjs, which
// the prompt builder reads (PersonaBook). Memories written by hand are part of those edits (they are always in the prompt); the
// memories the character picked up in talks, and the short summary of older talks, live in the memory store and are edited there.
import {EDIT_LIMITS, FIELDS, cleanBlock, cleanLine, validateOverride} from './character-overrides.mjs';
import {STORE_LIMITS} from './memory-store.mjs';
import {CUSTOM_LIMITS, isCustomKey} from './custom-characters.mjs';
import {CLIP} from './custom-voice-clip.mjs';

export class EditorError extends Error {
  constructor(status, code, errors = []) { super(code); this.status = status; this.code = code; this.errors = errors; }
}
const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const GROUP_ORDER = {custom: 0, story: 1, everyday: 2};

export class CharacterEditor {
  /**
   *   personas   PersonaBook (the shipped rows and the overrides it merges)
   *   overrides  CharacterOverrides
   *   memory     MemoryStore (optional: without it the memory part is empty)
   *   route      () => 'convai' | 'mistral' | 'local': who answers conversations now
   *   custom     CustomCharacters (optional: without it the editor has no "New character")
   */
  constructor({personas, overrides, memory = null, route = () => 'convai', limits = EDIT_LIMITS, custom = null} = {}) {
    Object.assign(this, {personas, overrides, memory, route, limits, custom});
  }
  get limitsForPage() { return {...this.limits, record: STORE_LIMITS.fact, summary: STORE_LIMITS.summary}; }
  /** What the page needs to build the "New character" form. Null without a store. */
  get customForPage() {
    if (!this.custom) return null;
    const {characters, name, records, record, names, displayName, bioMin, bio, style, examples, example, exampleTotal, memories, memory, total} = this.custom.limits ?? CUSTOM_LIMITS;
    return {limits: {characters, name, records, record, names, displayName, bioMin, bio, style, examples, example, exampleTotal, memories, memory, total},
      clip: {minSeconds: CLIP.minSeconds, maxSeconds: CLIP.maxSeconds, goodMin: CLIP.goodMin, goodMax: CLIP.goodMax, transcript: CLIP.transcript, maxUploadBytes: CLIP.maxUploadBytes},
      count: this.custom.size};
  }

  #row(key) {
    const row = KEY.test(key ?? '') ? this.personas.rows.get(key) : null;
    if (!row || !['named', 'ambient', 'archetype'].includes(row.kind)) throw new EditorError(404, 'not-found');
    return row;
  }
  /** Every character the editor offers: the player's own first, then the named ones, then the everyday people, each group by name. */
  catalog() {
    const rows = [...this.personas.rows.values()].filter(row => ['named', 'ambient', 'archetype'].includes(row.kind));
    const shipped = rows.map(row => ({key: row.key, name: String(row.name || row.key), group: row.kind === 'named' ? 'story' : 'everyday', edited: !!this.overrides.get(row.key)}));
    return [...shipped, ...(this.custom?.summaries() ?? [])]
      .sort((a, b) => (GROUP_ORDER[a.group] - GROUP_ORDER[b.group]) || a.name.localeCompare(b.name, 'en', {sensitivity: 'base'}));
  }
  state() { return {provider: this.route(), characters: this.catalog(), limits: this.limitsForPage, custom: this.customForPage}; }

  /** The shipped text of a character in the editor's five fields. */
  defaults(key) {
    this.#row(key);
    const shipped = this.personas.defaults(key);
    return {bio: cleanBlock(shipped.backstory), style: cleanBlock(shipped.style), rules: [], examples: shipped.samples.map(cleanLine).filter(Boolean), memories: []};
  }
  #memoryOf(key) {
    return this.memory ? {
      available: true, learns: this.memory.learns === true, summary: this.memory.recall({profileKey: key, channel: 'private'}).summary ?? '',
      records: this.memory.listRecords(key).map(({id, kind, text, pinned, updated}) => ({id, kind, text, pinned, updated})),
    } : {available: false, learns: false, summary: '', records: []};
  }
  /** Everything the page needs for one character. */
  details(key) {
    if (isCustomKey(key) && this.custom?.has(key)) return this.customDetails(key);
    const row = this.#row(key), defaults = this.defaults(key), stored = this.overrides.get(key) ?? {};
    const memory = row.kind === 'named' && this.memory ? this.#memoryOf(key) : {available: false, learns: false, summary: '', records: []};
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

  // ---- characters the player made
  #custom(key) {
    if (!this.custom || !isCustomKey(key) || !this.custom.has(key)) throw new EditorError(404, 'not-found');
    return this.custom.get(key);
  }
  // The store's own errors, as the page's: a stable code per problem and the limit it is about.
  #customError(error) {
    if (error instanceof EditorError) return error;
    if (error?.code === 'invalid') return new EditorError(422, 'invalid', error.errors);
    if (error?.code === 'not-found') return new EditorError(404, 'not-found');
    if (error?.code === 'full') return new EditorError(422, 'invalid', [{field: '', code: 'characters-full', max: error.max}]);
    if (typeof error?.code === 'string' && /^(?:clip|voice)-/.test(error.code)) {
      const {code, max, min} = error;
      return new EditorError(422, 'invalid', [{field: code.startsWith('voice-text') ? 'voiceText' : 'voice', code, ...(max !== undefined ? {max} : {}), ...(min !== undefined ? {min} : {})}]);
    }
    return new EditorError(500, 'not-saved');
  }
  customDetails(key) {
    const row = this.#custom(key);
    return {key, name: row.name, group: 'custom',
      custom: {name: row.name, gender: row.gender, records: [...row.records], names: [...row.names], bio: row.bio, style: row.style,
        examples: [...row.examples], memories: [...row.memories], voiceText: row.voiceText, voice: row.voice ? {seconds: row.voice.seconds, rate: row.voice.rate} : null},
      memory: this.#memoryOf(key)};
  }
  async createCustom(input) {
    if (!this.custom) throw new EditorError(404, 'not-found');
    try { const row = await this.custom.create(input); return this.customDetails(row.key); } catch (error) { throw this.#customError(error); }
  }
  async saveCustom(key, input) {
    this.#custom(key);
    try { await this.custom.update(key, input); return this.customDetails(key); } catch (error) { throw this.#customError(error); }
  }
  /** Deletes the character, its clip and what it remembered of V. Returns the list the page shows. */
  async deleteCustom(key) {
    this.#custom(key);
    try { await this.custom.delete(key); } catch (error) { throw this.#customError(error); }
    try { this.memory?.forget({profileKeys: [key]}); } catch { /* the character is gone; a memory file left behind is never read again */ }
    return {deleted: true, characters: this.catalog()};
  }
  /** `bytes`: the clip as the player sent it (a WAV); `voiceText`: the words said in it (when the page sends them with it). */
  async setCustomVoice(key, bytes, voiceText = null) {
    this.#custom(key);
    try { const {clip} = await this.custom.setVoice(key, bytes, voiceText); return {...this.customDetails(key), clip}; } catch (error) { throw this.#customError(error); }
  }
  async clearCustomVoice(key) {
    this.#custom(key);
    try { await this.custom.clearVoice(key); return this.customDetails(key); } catch (error) { throw this.#customError(error); }
  }

  // ---- what the character picked up in talks (the memory store)
  #named(key) {
    if (isCustomKey(key)) { this.#custom(key); if (!this.memory) throw new EditorError(404, 'not-found'); return; }
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
