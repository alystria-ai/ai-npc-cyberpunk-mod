// The prompt profiles with the player's changes (docs/LOCAL_AI.md, "Prompt profiles"). The shipped defaults are in bridge/prompt-profiles.mjs; what a player changed in the character
// editor is kept apart from them, one small file per profile in <state>/prompt-overrides/<profileId>.json, so an update of the mod never touches it. A file holds only the fields
// that differ from the shipped default ("reset" removes a field or the whole file). `PromptProfiles.resolve` is a plain map lookup: the prompt builder calls it every turn, nothing
// touches the disk then, and a saved change is in effect on the next turn without a restart.
//
// The editor server calls this API (every method is documented where it is):
//   profiles.list(context?)              [{id, label, provider, models, active, changed, custom?}]  every profile the player can edit; `active`: the one the next turn would use
//   profiles.getDefault(id)              the shipped profile (frozen), or null for an unknown id
//   profiles.getEffective(id)            the default with the player's change laid over it (frozen), or null
//   profiles.getOverride(id)             the stored change (only what differs), or null
//   profiles.validate(id, patch)         {ok: true, value} | {ok: false, errors: [{field, key?, index?, code, max?}]}: nothing is stored
//   await profiles.set(id, patch)        validate, then store; resolves to {ok: true, override, profile} | {ok: false, errors}
//   await profiles.reset(id, field?)     back to the default: one field, or (no field) the whole profile (the file is deleted)
//   profiles.preview(id, sample?)        the rules, closing and examples as the prompt would show them for {name, talkWords, mature}
//   profiles.resolve(turn)               the effective profile of a turn {route, tier, mature, custom: {origin, model}} (null for Convai): what the prompt builder uses
//   PROFILE_LIMITS, PROFILE_FIELDS       the field limits the validation enforces, for the page
// A change can never reach the facts the character gets, the safety guards or the Mature layer: they are not part of a profile (bridge/prompt-profiles.mjs).
import {readFile, readdir, rename, rm, mkdir} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {atomicFile} from './guarded-file.mjs';
import {PROFILE_FIELDS, PROFILE_LIMITS, builtInRows, defaultProfile, familyOf, customProfileId, isCustomProfileId, mergeProfile, profileIdFor,
  validateOverride, readOverride, renderRules, renderClosing, renderExamples, renderMature, matureCapable} from './prompt-profiles.mjs';

export {PROFILE_LIMITS, PROFILE_FIELDS};

const FILE = /^([a-z0-9][a-z0-9-]{0,79})\.json$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hostOf = origin => { try { return new URL(String(origin)).host; } catch { return String(origin ?? '').slice(0, 80); } };

const defaultIo = {
  read: file => readFile(file, 'utf8'),
  write: async (file, text) => { await mkdir(dirname(file), {recursive: true}); return atomicFile(file, text); },
  readdir: dir => readdir(dir),
  rename: (from, to) => rename(from, to),
  remove: file => rm(file, {force: true}),
};

export class PromptProfiles {
  /** Loads every file of the folder into memory (a missing folder is an empty set). A damaged file is skipped and left on disk; it is moved to <id>.json.corrupt before a save or a reset writes over it. */
  static async open(options = {}) {
    const store = new PromptProfiles(options);
    await store.#load();
    return store;
  }
  /**
   * dir      <state>/prompt-overrides (no dir: kept in memory only, for tests)
   * active   () => {route, tier, mature, custom: {origin, model}} the turn the next reply would be, for `list` (which profile is active now); the bridge passes it
   */
  constructor({dir, now = Date.now, active = () => null, read = defaultIo.read, write = defaultIo.write, readdir: list = defaultIo.readdir,
    rename: move = defaultIo.rename, remove = defaultIo.remove, log = () => {}} = {}) {
    Object.assign(this, {dir, now, activeTurn: active, read, write, listDir: list, move, remove, log});
    this.rows = new Map();     // profile id -> frozen override (only what differs)
    this.meta = new Map();     // custom profile id -> {host, model, family} (kept in the file so an endpoint no longer configured is still listed)
    this.damaged = new Set();
    this.cache = new Map();    // profile id -> {over, family, profile}
    this.chain = Promise.resolve();
  }
  #path(id) { return join(this.dir, id + '.json'); }
  async #load() {
    if (!this.dir) return;
    let names;
    try { names = await this.listDir(this.dir); } catch { return; }
    for (const name of names) {
      const match = FILE.exec(name);
      if (!match) continue;
      const id = match[1];
      let raw = null;
      try {
        raw = await this.read(join(this.dir, name));
        const value = JSON.parse(raw);
        if (plain(value) && value.version === 1 && value.id === id && (builtInRows().some(row => row.id === id) || isCustomProfileId(id))) {
          const family = isCustomProfileId(id) ? (typeof value.meta?.family === 'string' ? value.meta.family : 'generic') : undefined;
          const row = readOverride(value, defaultProfile(id, {family}), {mistral: id === 'mistral', matureOk: matureCapable(id)});
          if (isCustomProfileId(id)) this.meta.set(id, {host: String(value.meta?.host ?? '').slice(0, 80), model: String(value.meta?.model ?? '').slice(0, 200), family: family ?? 'generic'});
          if (Object.keys(row).length) this.rows.set(id, Object.freeze(row));
          continue;
        }
      } catch { /* damaged, or not a file */ }
      if (typeof raw === 'string' && raw.trim() !== '') this.damaged.add(id);
      this.log(`prompt profile edits of ${id} could not be read; they are left as they are` + (this.damaged.has(id) ? `, and kept as ${name}.corrupt if you save this profile again` : ''));
    }
  }
  async #keepAside(id) {
    if (!this.damaged.has(id)) return;
    const path = this.#path(id);
    try { await this.remove(path + '.corrupt'); await this.move(path, path + '.corrupt'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    this.damaged.delete(id);
    this.log(`prompt profile edits of ${id} were damaged: kept as ${id}.json.corrupt`);
  }

  // ---- What a turn uses ------------------------------------------------------------------------------------------------------------
  /** The family and label data of a Custom id: the endpoint configured now, else what its file remembers. */
  #customOf(id) {
    const turn = this.#turn();
    if (turn?.custom && customProfileId(turn.custom.origin, turn.custom.model) === id) return {host: hostOf(turn.custom.origin), model: String(turn.custom.model ?? ''), family: familyOf(turn.custom.model)};
    return this.meta.get(id) ?? null;
  }
  #turn() { try { return this.activeTurn() ?? null; } catch { return null; } }

  /** The effective profile of an id (memoized until the override changes), or null for an unknown id. */
  #effective(id, family) {
    const base = defaultProfile(id, {family});
    if (!base) return null;
    const over = this.rows.get(id) ?? null;
    const cached = this.cache.get(id);
    if (cached && cached.over === over && cached.family === family) return cached.profile;
    const profile = over ? mergeProfile(base, over) : base;
    this.cache.set(id, {over, family, profile});
    return profile;
  }

  /** The effective profile of a turn: {route, tier, mature, custom: {origin, model}}. Null for a route with no profile (Convai). A map lookup; safe on the prompt path. */
  resolve(turn) {
    const id = profileIdFor(turn);
    if (!id) return null;
    return this.#effective(id, isCustomProfileId(id) ? familyOf(turn.custom?.model) : undefined) ?? null;
  }
  /** The id of a turn's profile (for the log), or null. */
  idFor(turn) { return profileIdFor(turn); }

  // ---- The editor's API ------------------------------------------------------------------------------------------------------------
  /** The shipped default of a profile (frozen), or null for an id the editor does not know. */
  getDefault(id) {
    if (isCustomProfileId(id)) { const custom = this.#customOf(id); return custom ? defaultProfile(id, {family: custom.family}) : null; }
    return defaultProfile(id);
  }
  /** The default with the player's change laid over it, or null. */
  getEffective(id) {
    if (isCustomProfileId(id)) { const custom = this.#customOf(id); return custom ? this.#effective(id, custom.family) : null; }
    return this.#effective(id);
  }
  /** The stored change of a profile (only the fields that differ), or null. */
  getOverride(id) { return this.rows.get(id) ?? null; }

  /**
   * Every profile the player can edit: the built-in ones, the Custom profile of the endpoint and model configured now, and the Custom profiles of earlier endpoints that have a saved change.
   * `active` is true for the profile the next turn would use (`context`, else the one given at construction). `changed`: the player has edited it.
   */
  list(context) {
    const turn = context ?? this.#turn();
    const activeId = turn ? profileIdFor(turn) : null;
    const out = builtInRows().map(row => ({...row, active: row.id === activeId, changed: this.rows.has(row.id)}));
    const custom = new Map();
    if (turn?.custom?.origin && turn.custom.model) custom.set(customProfileId(turn.custom.origin, turn.custom.model), {host: hostOf(turn.custom.origin), model: String(turn.custom.model), family: familyOf(turn.custom.model)});
    for (const [id, meta] of this.meta) if (!custom.has(id)) custom.set(id, meta);
    for (const [id, meta] of custom) {
      out.push({id, label: `Custom: ${meta.model || 'model'} at ${meta.host || 'endpoint'}`, provider: 'custom', models: meta.model, family: meta.family, host: meta.host, active: id === activeId, changed: this.rows.has(id)});
    }
    return out;
  }

  /** Checks a change against the shipped default; nothing is stored. {ok: false, errors: [{field: '', code: 'unknown-profile'}]} for an id nobody knows. */
  validate(id, patch) {
    const defaults = this.getDefault(id);
    if (!defaults) return {ok: false, errors: [{field: '', code: 'unknown-profile'}]};
    return validateOverride(patch, defaults, this.rows.get(id) ?? {}, {mistral: id === 'mistral', matureOk: matureCapable(id)});
  }

  /**
   * Stores a change (an empty result removes the file). Writes are one at a time and the in-memory copy changes only when the file did, so a failed save leaves both as they were.
   * Resolves to {ok: true, override, profile} (the stored fields or null, and the effective profile) or {ok: false, errors}.
   */
  set(id, patch) {
    const checked = this.validate(id, patch);
    if (!checked.ok) return Promise.resolve(checked);
    return this.#store(id, checked.value);
  }
  /** Back to the default: one field (`field`, one of PROFILE_FIELDS), or the whole profile (the file is deleted). */
  reset(id, field) {
    if (!this.getDefault(id)) return Promise.resolve({ok: false, errors: [{field: '', code: 'unknown-profile'}]});
    if (field === undefined || field === null) return this.#store(id, {});
    if (!PROFILE_FIELDS.includes(field)) return Promise.resolve({ok: false, errors: [{field, code: 'unknown-field'}]});
    const row = {...(this.rows.get(id) ?? {})};
    delete row[field];
    return this.#store(id, row);
  }
  #store(id, value) {
    const empty = Object.keys(value).length === 0;
    const custom = isCustomProfileId(id) ? this.#customOf(id) : null;
    const job = this.chain.catch(() => {}).then(async () => {
      if (this.dir) {
        await this.#keepAside(id);
        if (empty) await this.remove(this.#path(id));
        else if (!await this.write(this.#path(id), JSON.stringify({version: 1, id, updated: this.now(), ...(custom ? {meta: custom} : {}), ...value}, null, 1))) throw Error('could not save');
      }
      if (empty) this.rows.delete(id); else this.rows.set(id, Object.freeze(value));
      if (custom) this.meta.set(id, custom);
      return {ok: true, override: empty ? null : this.rows.get(id), profile: this.getEffective(id)};
    });
    this.chain = job;
    return job;
  }

  /** The text of a profile as the prompt shows it for a sample speaker: {rules, closing, examples}. `sample`: {name, talkWords, mature}. For the editor's preview. */
  preview(id, sample = {}) {
    const profile = this.getEffective(id);
    if (!profile) return null;
    const talkWords = Number.isInteger(sample.talkWords) ? sample.talkWords : 0;
    return {rules: renderRules(profile, {name: sample.name ?? 'Judy', talkWords, mature: sample.mature === true}),
      closing: renderClosing(profile, {name: sample.name ?? 'Judy', talkWords}), examples: renderExamples(profile),
      mature: sample.mature === true && matureCapable(id) ? renderMature(profile, {name: sample.name ?? 'Judy', talkWords}) : null};
  }
}
