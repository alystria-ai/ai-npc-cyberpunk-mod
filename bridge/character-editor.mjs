// What the character editor does, apart from how it is served (docs/CHARACTER_EDITOR.md): the list of characters, one character's shipped
// and edited text, saving with validation, going back to the shipped text, the memories the text providers keep, the characters
// the player makes for themselves (bridge/custom-characters.mjs) and the voice clips players give story characters and their own (bridge/player-voices.mjs).
//
// The shipped profile (the Convai-derived roster row) is never written: the player's edits go to bridge/character-overrides.mjs, which
// the prompt builder reads (PersonaBook). Memories written by hand are part of those edits (they are always in the prompt); the
// memories the character picked up in talks, and the short summary of older talks, live in the memory store and are edited there.
import {EDIT_LIMITS, FIELDS, cleanBlock, cleanLine, validateOverride} from './character-overrides.mjs';
import {STORE_LIMITS} from './memory-store.mjs';
import {CUSTOM_LIMITS, isCustomKey} from './custom-characters.mjs';
import {CLIP, CLIP_FORMATS} from './custom-voice-clip.mjs';
import {WORLD_RULES_LIMIT} from './world-rules.mjs';

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
   *   voices     PlayerVoices (optional: without it the editor has no voice clips)
   *   worldRules WorldRules (optional: without it the editor has no "World rules" page): one text for the whole world (bridge/world-rules.mjs)
   *   onChanged  (key) => void: after a save, reset, memory edit or character change reached the store. Everything the prompt reads is a plain lookup per
   *              turn (PersonaBook, CharacterOverrides, CustomCharacters, MemoryStore), so the next turn already uses it; what a speculative turn
   *              (a prepared group reply, a look-ahead) wrote before the save is the one thing that does not, and the bridge drops it here.
   */
  constructor({personas, overrides, memory = null, route = () => 'convai', limits = EDIT_LIMITS, custom = null, voices = null, worldRules = null, onChanged = () => {}} = {}) {
    Object.assign(this, {personas, overrides, memory, route, limits, custom, voices, worldRules, onChanged});
  }
  /** What the page needs for the "World rules" page: the saved text and its limit. Null without a store. */
  get worldRulesForPage() { return this.worldRules ? {text: this.worldRules.get(), limit: this.worldRules.limit ?? WORLD_RULES_LIMIT} : null; }
  #changed(key) { try { this.onChanged(key); } catch { /* the change is saved; a hook never fails it */ } }
  get limitsForPage() { return {...this.limits, record: STORE_LIMITS.fact, summary: STORE_LIMITS.summary}; }
  /** What the page needs to build the "New character" form. Null without a store. */
  get customForPage() {
    if (!this.custom) return null;
    const {characters, name, records, record, names, displayName, bioMin, bio, style, examples, example, exampleTotal, memories, memory, total} = this.custom.limits ?? CUSTOM_LIMITS;
    return {limits: {characters, name, records, record, names, displayName, bioMin, bio, style, examples, example, exampleTotal, memories, memory, total},
      count: this.custom.size};
  }
  /** What the page needs to build the voice section (the clip's limits and the formats it may offer). Null without a store. */
  get voiceForPage() {
    if (!this.voices) return null;
    return {minSeconds: CLIP.minSeconds, maxSeconds: CLIP.maxSeconds, goodMin: CLIP.goodMin, goodMax: CLIP.goodMax, transcript: CLIP.transcript, transcriptMin: CLIP.transcriptMin,
      maxUploadBytes: CLIP.maxUploadBytes, formats: [...CLIP_FORMATS], convertRate: CLIP.convertRate};
  }

  #row(key) {
    const row = KEY.test(key ?? '') ? this.personas.rows.get(key) : null;
    if (!row || !['named', 'ambient', 'archetype'].includes(row.kind)) throw new EditorError(404, 'not-found');
    return row;
  }
  /** Every character the editor offers: the player's own first, then the named ones, then the everyday people, each group by name. A story or own character says whether it has a voice clip. */
  catalog() {
    const rows = [...this.personas.rows.values()].filter(row => ['named', 'ambient', 'archetype'].includes(row.kind));
    const shipped = rows.map(row => ({key: row.key, name: String(row.name || row.key), group: row.kind === 'named' ? 'story' : 'everyday', edited: !!this.overrides.get(row.key),
      ...(row.kind === 'named' ? {voice: !!this.voices?.has(row.key)} : {})}));
    const own = (this.custom?.summaries() ?? []).map(item => ({...item, voice: !!this.voices?.has(item.key)}));
    return [...shipped, ...own]
      .sort((a, b) => (GROUP_ORDER[a.group] - GROUP_ORDER[b.group]) || a.name.localeCompare(b.name, 'en', {sensitivity: 'base'}));
  }
  state() { return {provider: this.route(), characters: this.catalog(), limits: this.limitsForPage, custom: this.customForPage, voice: this.voiceForPage, worldRules: this.worldRulesForPage}; }

  // ---- the world rules: one text for every character (bridge/world-rules.mjs). Saved at once; the next turn already reads it.
  /** Stores the text ('' clears it). Throws EditorError 422 with `errors` when it is over the limit; nothing is stored then. */
  async saveWorldRules(text) {
    if (!this.worldRules) throw new EditorError(404, 'not-found');
    if (typeof text !== 'string') throw new EditorError(400, 'bad-request');
    try { await this.worldRules.set(text); }
    catch (error) { throw error?.code === 'invalid' ? new EditorError(422, 'invalid', error.errors) : new EditorError(500, 'not-saved'); }
    this.#changed('');
    return this.worldRulesForPage;
  }
  async clearWorldRules() { return this.saveWorldRules(''); }

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
      edited: Object.fromEntries(FIELDS.map(field => [field, field in stored])), memory,
      voice: row.kind === 'named' ? this.#voiceOf(key, 'shipped') : null};
  }
  // The voice part of a character's details: its clip (without the words), the words said in it, and what speaks while it has none.
  #voiceOf(key, fallback) {
    if (!this.voices) return null;
    const entry = this.voices.get(key);
    return {clip: entry ? {seconds: entry.seconds, rate: entry.rate, updated: entry.updated} : null, transcript: entry?.transcript ?? '', fallback};
  }
  /** Saves the fields in `patch`. Throws EditorError 422 with `errors` when something is over a limit; nothing is stored then. */
  async save(key, patch) {
    this.#row(key);
    const result = validateOverride(patch, this.defaults(key), this.overrides.get(key) ?? {}, this.limits);
    if (!result.ok) throw new EditorError(422, 'invalid', result.errors);
    await this.#store(key, result.value);
    this.#changed(key);
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
    this.#changed(key);
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
    return new EditorError(500, 'not-saved');
  }
  customDetails(key) {
    const row = this.#custom(key);
    return {key, name: row.name, group: 'custom',
      custom: {name: row.name, gender: row.gender, records: [...row.records], names: [...row.names], bio: row.bio, style: row.style,
        examples: [...row.examples], memories: [...row.memories]},
      memory: this.#memoryOf(key), voice: this.#voiceOf(key, 'generic')};
  }
  async createCustom(input) {
    if (!this.custom) throw new EditorError(404, 'not-found');
    try { const row = await this.custom.create(input); this.#changed(row.key); return this.customDetails(row.key); } catch (error) { throw this.#customError(error); }
  }
  async saveCustom(key, input) {
    this.#custom(key);
    try { await this.custom.update(key, input); this.#changed(key); return this.customDetails(key); } catch (error) { throw this.#customError(error); }
  }
  /** Deletes the character, its clip and what it remembered of V. Returns the list the page shows. */
  async deleteCustom(key) {
    this.#custom(key);
    try { await this.custom.delete(key); } catch (error) { throw this.#customError(error); }
    try { this.memory?.forget({profileKeys: [key]}); } catch { /* the character is gone; a memory file left behind is never read again */ }
    this.#changed(key);
    return {deleted: true, characters: this.catalog()};
  }

  // ---- voice clips (bridge/player-voices.mjs): a story character's, or one of the player's own
  /** Throws EditorError 404 unless `key` may have a clip: a story character, or a character the player made. Everyday people have none. */
  checkVoiceKey(key) {
    if (!this.voices) throw new EditorError(404, 'not-found');
    if (isCustomKey(key)) this.#custom(key);
    else if (this.#row(key).kind !== 'named') throw new EditorError(404, 'not-found');
  }
  // The store's errors as the page's: 'clip-*' and 'voice-text-*' are 422 with the field and the limit, 'clips-full' says how many it keeps.
  #voiceError(error) {
    if (error instanceof EditorError) return error;
    const code = error?.code;
    if (code === 'not-found' || code === 'bad-key') return new EditorError(404, 'not-found');
    if (code === 'clips-full') return new EditorError(422, 'invalid', [{field: 'voice', code, max: error.max}]);
    if (typeof code === 'string' && /^(?:clip|voice-text)-/.test(code)) {
      const {max, min} = error;
      return new EditorError(422, 'invalid', [{field: code.startsWith('voice-text') ? 'voiceText' : 'voice', code, ...(max !== undefined ? {max} : {}), ...(min !== undefined ? {min} : {})}]);
    }
    return new EditorError(500, 'not-saved');
  }
  /** `bytes`: the file as the page sent it; `text`: the words said in it (null keeps the words already stored). Resolves to the details plus `clip` ({seconds, rate, notes, format}). */
  async setVoice(key, bytes, text = null) {
    this.checkVoiceKey(key);
    if (text !== null && typeof text !== 'string') throw new EditorError(400, 'bad-request');
    try { const {clip} = await this.voices.set(key, bytes, text); return {...this.details(key), clip}; } catch (error) { throw this.#voiceError(error); }
  }
  /** Changes only the words said in the key's clip. */
  async setVoiceText(key, text) {
    this.checkVoiceKey(key);
    if (typeof text !== 'string') throw new EditorError(400, 'bad-request');
    try { await this.voices.setTranscript(key, text); return this.details(key); } catch (error) { throw this.#voiceError(error); }
  }
  /** Removes the key's clip (the character goes back to the shipped voice, or the generic one, from its next line). Removing none is not an error. */
  async clearVoice(key) {
    this.checkVoiceKey(key);
    try { await this.voices.clear(key); return this.details(key); } catch (error) { throw this.#voiceError(error); }
  }
  /** The saved clip as a WAV, for the page's player. 404 when the key has none. */
  async voiceAudio(key) {
    this.checkVoiceKey(key);
    let bytes = null;
    try { bytes = await this.voices.audio(key); } catch { bytes = null; }
    if (!bytes) throw new EditorError(404, 'not-found');
    return bytes;
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
    this.#changed(key);
    return this.details(key);
  }
  deleteRecord(key, id) {
    this.#named(key);
    if (!this.memory.deleteRecord(key, id)) throw new EditorError(404, 'not-found');
    this.#changed(key);
    return this.details(key);
  }
  setSummary(key, text) {
    this.#named(key);
    if (typeof text !== 'string') throw new EditorError(400, 'bad-request');
    if (this.memory.setSummary(key, text) === null) throw new EditorError(500, 'not-saved');
    this.#changed(key);
    return this.details(key);
  }
}
