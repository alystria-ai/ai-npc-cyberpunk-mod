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
import {PromptingEditor} from './prompting-editor.mjs';
import {OPTION_FIELDS, OPTION_VALUES, REPLY_WORDS, validateOptions} from './character-options.mjs';
import {isOutfitOf, outfitsFor} from './outfit-choices.mjs';

export class EditorError extends Error {
  constructor(status, code, errors = []) { super(code); this.status = status; this.code = code; this.errors = errors; }
}
const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const GROUP_ORDER = {custom: 0, v: 1, story: 2, everyday: 3};
// What the picker calls a character (its filter chips and badges). Only the named characters have a role besides "side": the four people V can romance in the game
// (the same keys as bridge/relationship-routing.mjs where a save shows a relationship), and the hand-reviewed tier-1 characters (mod/auto-connect.lua M.TIER1), the
// companions. Tests pin both lists to those sources. Any other named character is a story character, an everyday person a side character.
export const ROMANCE_KEYS = Object.freeze(['judy-alvarez', 'kerry-eurodyne', 'panam-palmer', 'river-ward']);
export const COMPANION_KEYS = Object.freeze(['alex', 'alt-cunningham', 'claire-russell', 'evelyn-parker', 'jackie-welles', 'johnny-silverhand',
  'judy-alvarez', 'kerry-eurodyne', 'lizzy-wizzy', 'lucy-kushinada', 'mama-welles', 'meredith-stout', 'misty-olszewski',
  'mr-hands', 'padre-ibarra', 'panam-palmer', 'pepe-najarro', 'regina-jones', 'rita-wheeler', 'river-ward',
  'rogue-amendiares', 'solomon-reed', 'songbird', 'takemura', 'viktor-vektor', 'wakako-okada']);
const roleOfRow = row => row.kind !== 'named' ? 'side' : ROMANCE_KEYS.includes(row.key) ? 'romance' : COMPANION_KEYS.includes(row.key) ? 'companion' : 'story';
// V's typed lines are spoken with these two voice keys (bridge/v-voice.mjs V_VOICE_KEYS, tested to match). The editor lists them as two voice-only
// rows in the group 'v': no bio, style, rules or memories, no delete, no gender; just the clip, which every engine reads from the same key.
export const V_EDITOR_KEYS = Object.freeze(['v-male', 'v-female']);
const V_NAMES = Object.freeze({'v-male': 'V (male voice)', 'v-female': 'V (female voice)'});
const isVKey = key => V_EDITOR_KEYS.includes(key);

export class CharacterEditor {
  /**
   *   personas   PersonaBook (the shipped rows and the overrides it merges)
   *   overrides  CharacterOverrides
   *   memory     MemoryStore (optional: without it the memory part is empty)
   *   route      () => 'convai' | 'mistral' | 'local': who answers conversations now
   *   custom     CustomCharacters (optional: without it the editor has no "New character")
   *   voices     PlayerVoices (optional: without it the editor has no voice clips)
   *   worldRules WorldRules (optional: without it the editor has no "World rules" page): one text for the whole world (bridge/world-rules.mjs)
   *   promptProfiles PromptProfiles (optional: without it the editor has no "Prompting" page): the wording of the prompt per conversation option (bridge/prompt-profile-store.mjs)
   *   addonContent AddonContent (optional): the content packs of the add-ons (bridge/addon-content.mjs); the World rules page lists their rules read-only
   *   options    CharacterOptions (optional: without it the editor has no "Look and moves" part): the clothes, gestures, idle moves, seating, reactions and reply length per character (bridge/character-options.mjs)
   *   onChanged  (key) => void: after a save, reset, memory edit or character change reached the store. Everything the prompt reads is a plain lookup per
   *              turn (PersonaBook, CharacterOverrides, CustomCharacters, MemoryStore), so the next turn already uses it; what a speculative turn
   *              (a prepared group reply, a look-ahead) wrote before the save is the one thing that does not, and the bridge drops it here.
   */
  constructor({personas, overrides, memory = null, route = () => 'convai', limits = EDIT_LIMITS, custom = null, voices = null, worldRules = null, promptProfiles = null, addonContent = null, options = null, onChanged = () => {}} = {}) {
    Object.assign(this, {personas, overrides, memory, route, limits, custom, voices, worldRules, addonContent, options, onChanged});
    // The Prompting page (bridge/prompting-editor.mjs). A saved change counts from the next turn like every other editor change.
    this.prompting = promptProfiles ? new PromptingEditor({profiles: promptProfiles, onChanged: () => this.#changed('')}) : null;
  }
  /** What the page needs for the "World rules" page: the saved text and its limit. Null without a store. */
  get worldRulesForPage() {
    if (!this.worldRules) return null;
    // `packs`: the content packs (add-ons, bridge/addon-content.mjs) that add world rules after the player's, read-only on the page. Absent without any.
    const packs = this.addonContent?.worldRulesList?.() ?? [];
    return {text: this.worldRules.get(), limit: this.worldRules.limit ?? WORLD_RULES_LIMIT, ...(packs.length ? {packs} : {})};
  }
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

  /** What the page needs for the "Look and moves" part: the values each choice may take and the reply lengths in words. Null without a store. */
  get optionsForPage() {
    if (!this.options) return null;
    return {values: Object.fromEntries(Object.entries(OPTION_VALUES).map(([field, list]) => [field, [...list]])), words: {...REPLY_WORDS}};
  }

  #row(key) {
    const row = KEY.test(key ?? '') ? this.personas.rows.get(key) : null;
    if (!row || !['named', 'ambient', 'archetype'].includes(row.kind)) throw new EditorError(404, 'not-found');
    return row;
  }
  /** Every character the editor offers: the player's own first, then V's two voices (only with a clip store), then the named ones, then the everyday people, each group by name. A story, own or V row says whether it has a voice clip. */
  catalog() {
    const rows = [...this.personas.rows.values()].filter(row => ['named', 'ambient', 'archetype'].includes(row.kind));
    const shipped = rows.map(row => ({key: row.key, name: String(row.name || row.key), group: row.kind === 'named' ? 'story' : 'everyday', role: roleOfRow(row), edited: !!this.overrides.get(row.key),
      ...(row.kind === 'named' ? {voice: !!this.voices?.has(row.key)} : {})}));
    const own = (this.custom?.summaries() ?? []).map(item => ({...item, voice: !!this.voices?.has(item.key)}));
    const v = this.voices ? V_EDITOR_KEYS.map(key => ({key, name: V_NAMES[key], group: 'v', edited: false, voiceOnly: true, voice: this.voices.has(key)})) : [];
    return [...shipped, ...own, ...v]
      .sort((a, b) => (GROUP_ORDER[a.group] - GROUP_ORDER[b.group]) || a.name.localeCompare(b.name, 'en', {sensitivity: 'base'}));
  }
  state() { return {provider: this.route(), characters: this.catalog(), limits: this.limitsForPage, custom: this.customForPage, voice: this.voiceForPage, worldRules: this.worldRulesForPage, prompting: this.prompting?.forPage ?? null, options: this.optionsForPage}; }

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
    if (isVKey(key)) return this.vDetails(key);
    const row = this.#row(key), defaults = this.defaults(key), stored = this.overrides.get(key) ?? {};
    const memory = row.kind === 'named' && this.memory ? this.#memoryOf(key) : {available: false, learns: false, summary: '', records: []};
    return {key, name: String(row.name || key), group: row.kind === 'named' ? 'story' : 'everyday', defaults,
      values: Object.fromEntries(FIELDS.map(field => [field, field in stored ? stored[field] : defaults[field]])),
      edited: Object.fromEntries(FIELDS.map(field => [field, field in stored])), memory,
      voice: row.kind === 'named' ? this.#voiceOf(key, 'shipped') : null,
      options: row.kind === 'named' ? this.#optionsOf(key, row.records) : null};
  }
  // The "Look and moves" part of a character's details: what is chosen now, and the looks the character can wear (null: it has one look in the game's files).
  #optionsOf(key, records) {
    if (!this.options) return null;
    return {values: {...(this.options.get(key) ?? {})}, outfits: outfitsFor(records)};
  }
  /** One of V's two voice rows: only the voice part (the page draws the voice section and nothing else). 404 without a clip store. */
  vDetails(key) {
    if (!this.voices || !isVKey(key)) throw new EditorError(404, 'not-found');
    return {key, name: V_NAMES[key], group: 'v', voiceOnly: true, voice: this.#voiceOf(key, 'v')};
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

  // ---- the "Look and moves" choices (bridge/character-options.mjs): clothes, gestures, idle moves, seating, reactions, reply length. Named characters and the player's own only.
  #optionsTarget(key) {
    if (!this.options) throw new EditorError(404, 'not-found');
    if (isCustomKey(key)) return this.#custom(key).records;
    const row = this.#row(key);
    if (row.kind !== 'named') throw new EditorError(404, 'not-found');
    return row.records;
  }
  /** Saves the choices in `patch` (null puts a choice back to today's behaviour). 422 with `errors` when a value is not allowed; nothing is stored then. Resolves to the details. */
  async saveOptions(key, patch) {
    const records = this.#optionsTarget(key), looks = outfitsFor(records);
    const result = validateOptions(patch, this.options.get(key) ?? {}, {outfitOk: name => !!looks && isOutfitOf(looks.record, name)});
    if (!result.ok) throw new EditorError(422, 'invalid', result.errors);
    try { await this.options.set(key, result.value); } catch (error) { throw error?.code === 'full' ? new EditorError(422, 'invalid', [{field: '', code: 'options-full', max: error.max}]) : new EditorError(500, 'not-saved'); }
    this.#changed(key);
    return this.details(key);
  }
  /** Back to today's behaviour: the named choices, or all of them. */
  async resetOptions(key, fields) {
    this.#optionsTarget(key);
    const list = fields == null ? OPTION_FIELDS : Array.isArray(fields) ? fields : null;
    if (!list || list.some(field => !OPTION_FIELDS.includes(field))) throw new EditorError(400, 'bad-request');
    const stored = {...(this.options.get(key) ?? {})};
    for (const field of list) delete stored[field];
    try { await this.options.set(key, stored); } catch { throw new EditorError(500, 'not-saved'); }
    this.#changed(key);
    return this.details(key);
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
      memory: this.#memoryOf(key), voice: this.#voiceOf(key, 'generic'), options: this.#optionsOf(key, row.records)};
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
  /** Throws EditorError 404 unless `key` may have a clip: a story character, a character the player made, or one of V's two voice keys. Everyday people have none. */
  checkVoiceKey(key) {
    if (!this.voices) throw new EditorError(404, 'not-found');
    if (isVKey(key)) return;
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
  /** Removes the key's clip (the character goes back to the shipped voice, or the generic one, V to the voice of the installed V voice mod or the shipped V voice, from its next line). Removing none is not an error. */
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
