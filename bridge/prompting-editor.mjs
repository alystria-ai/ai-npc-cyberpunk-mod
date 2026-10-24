// The "Prompting" part of the character editor (docs/CHARACTER_EDITOR.md, "Prompting"): what the page may do with the prompt profiles of bridge/prompt-profile-store.mjs.
// It is only a thin, checked layer. The profile ids a request names are looked up in the store's own list, so no path or key is ever built from input; the patches are
// validated by the store (bridge/prompt-profiles.mjs validateOverride), and a profile can never reach the facts the character gets, the safety guards or the Mature layer
// because those are not part of a profile.
//
// What the page needs per profile (`details`): the label data, the shipped default, the effective profile (default with the player's change), the stored change and whether
// the profile is the one the next reply would use. Nothing here runs per turn: the prompt builder reads the store with a plain lookup (PromptProfiles.resolve).
import {PROFILE_LIMITS, PROFILE_FIELDS, LABEL_KEYS, VOLATILE_PLACES, mergeProfile, renderRules, renderClosing, renderExamples, renderMature, matureCapable} from './prompt-profiles.mjs';
import {EditorError} from './character-editor.mjs';

const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PREVIEW_NAME_MAX = 60;
const PREVIEW_WORDS = Object.freeze([1, 200]);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The words of the sample speaker in a preview: plain, one line, short. */
const sampleName = value => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_NAME_MAX) : '') || 'Judy';

export class PromptingEditor {
  /**
   *   profiles   PromptProfiles (bridge/prompt-profile-store.mjs)
   *   onChanged  () => void: after a change reached the store (the bridge drops a group reply prepared from the old wording)
   */
  constructor({profiles, onChanged = () => {}} = {}) {
    Object.assign(this, {profiles, onChanged});
  }
  /** What the page needs to build the Prompting section: the limits, the fields and the label keys. */
  get forPage() {
    return {limits: PROFILE_LIMITS, fields: [...PROFILE_FIELDS], labelKeys: [...LABEL_KEYS], volatilePlaces: [...VOLATILE_PLACES], previewWords: [...PREVIEW_WORDS], previewName: PREVIEW_NAME_MAX};
  }
  #changed() { try { this.onChanged(); } catch { /* the change is saved; a hook never fails it */ } }

  /** Every profile the player can edit: [{id, label, provider, models, active, changed, family?, host?}]. */
  list() { return this.profiles.list(); }

  /** The row of a profile in the store's own list. 404 for anything the list does not hold (a path is never built from the id). */
  #row(id) {
    const row = typeof id === 'string' && ID.test(id) ? this.profiles.list().find(item => item.id === id) : null;
    if (!row) throw new EditorError(404, 'not-found');
    return row;
  }
  /** Everything the page needs for one profile. */
  details(id) {
    const row = this.#row(id);
    const base = this.profiles.getDefault(id), effective = this.profiles.getEffective(id);
    if (!base || !effective) throw new EditorError(404, 'not-found');
    return {...row, default: base, effective, override: this.profiles.getOverride(id) ?? {}};
  }
  #body(patch) {
    if (!plain(patch)) throw new EditorError(400, 'bad-request');
    return patch;
  }
  /** Checks a change; nothing is stored. Resolves to {ok: true, fields: [...]} or {ok: false, errors}. */
  validate(id, patch) {
    this.#row(id);
    const result = this.profiles.validate(id, this.#body(patch));
    return result.ok ? {ok: true, fields: Object.keys(result.value)} : {ok: false, errors: result.errors};
  }
  /** Stores a change. 422 with the codes when it is not valid (nothing is stored then). Resolves to the details. */
  async set(id, patch) {
    this.#row(id);
    let result;
    try { result = await this.profiles.set(id, this.#body(patch)); } catch (error) { if (error instanceof EditorError) throw error; throw new EditorError(500, 'not-saved'); }
    if (!result.ok) throw new EditorError(422, 'invalid', result.errors);
    this.#changed();
    return this.details(id);
  }
  /** Back to the shipped default: one field, or (no field) the whole profile. */
  async reset(id, field) {
    this.#row(id);
    if (field !== undefined && field !== null && (typeof field !== 'string' || !PROFILE_FIELDS.includes(field))) throw new EditorError(400, 'bad-request');
    let result;
    try { result = await this.profiles.reset(id, field ?? undefined); } catch { throw new EditorError(500, 'not-saved'); }
    if (!result.ok) throw new EditorError(422, 'invalid', result.errors);
    this.#changed();
    return this.details(id);
  }
  /**
   * The rules, the examples and the closing line as the prompt would show them for a sample speaker {name, talkWords, mature}. With `patch` the preview is of that change laid over
   * what is stored now (what the page's unsaved edits would become); without it, of the stored profile. Resolves to {ok: true, rules, closing, examples} or {ok: false, errors}.
   */
  preview(id, sample = {}, patch = undefined) {
    this.#row(id);
    if (!plain(sample ?? {})) throw new EditorError(400, 'bad-request');
    const name = sampleName(sample?.name), mature = sample?.mature === true;
    let talkWords = 0;
    if (sample?.talkWords !== undefined && sample.talkWords !== null && sample.talkWords !== 0) {
      if (!Number.isInteger(sample.talkWords) || sample.talkWords < PREVIEW_WORDS[0] || sample.talkWords > PREVIEW_WORDS[1]) throw new EditorError(400, 'bad-request');
      talkWords = sample.talkWords;
    }
    if (patch === undefined || patch === null) return {ok: true, ...this.profiles.preview(id, {name, talkWords, mature})};
    const checked = this.profiles.validate(id, this.#body(patch));
    if (!checked.ok) return {ok: false, errors: checked.errors};
    const profile = mergeProfile(this.profiles.getDefault(id), checked.value);
    return {ok: true, rules: renderRules(profile, {name, talkWords, mature}), closing: renderClosing(profile, {name, talkWords}), examples: renderExamples(profile),
      mature: mature && matureCapable(id) ? renderMature(profile, {name, talkWords}) : null};
  }
}
