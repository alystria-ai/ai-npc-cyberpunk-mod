// Content packs (docs/ADDON_API.md, "Content packs", add-on API 1.1): an add-on folder that holds only convai-addon.json and changes how the mod's characters talk.
// Its manifest has a `content` object:
//   worldRules  [text]   lines added to every character's world rules, after the player's own (and, as the player's do, to Convai's dynamic info)
//   prompting   {"*" | profile id: override}   prompt-profile changes in the shape a player's change has in the prompt-profile store (validateOverride)
// This file checks that object (the same validators and caps as a player's edit, plus an overall cap) and keeps what the prompt builders ask for:
//   layerFor(profileId)         the packs' merged override of one prompt profile (frozen, the same object until a pack is switched on or off), or null
//   worldRulesText(player)      the player's world rules and then the packs' lines: what the text providers' personas carry
//   convaiWorldRulesText(...)   the same for Convai's dynamic info, the packs' lines trimmed to a budget when they are too long together
// Precedence: the shipped profile < the packs (folder-name order, a later one wins per field) < the player's own change. A specific profile id beats "*".
// Nothing here is read per turn from disk: the merged results are made when a pack is switched on or off and kept (a plain Map lookup per turn), so the prompt
// is byte-stable within a profile and the prompt caches stay warm. A pack never touches the facts the character gets, the hard-limit guard or the Mature layer: they are
// not part of a profile or of the world rules.
import {BUILT_IN_IDS, isCustomProfileId, matureCapable, readOverride, validateOverride, deepFreeze} from './prompt-profiles.mjs';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {basename, resolve} from 'node:path';
import {insideFolder, validateCharacters, validateConvai, validateNamePools} from './addon-content-data.mjs';

export const CONTENT_LIMITS = Object.freeze({
  rules: 24, ruleText: 600, rulesTotal: 4000,      // one pack's world rules: lines, characters per line, characters in all
  profiles: 12,                                    // prompt-profile keys of one pack
  json: 40000,                                     // the whole `content` object as JSON
  combinedRules: 6000,                             // all packs' world rules together (a later pack's lines are left out when they do not fit)
  convaiRules: 4000,                               // the player's rules and the packs' lines together, in Convai's dynamic info
});
export const CONTENT_NAMES_FILE = 'content-names.json';
export const CONTENT_POOLS_FILE = 'content-name-pools.json';
const SHIPPED = Symbol('shipped roster values');   // the row's own name, aliases and text, kept while a pack's are laid over them
export const WORLD_RULE_BULLET = '- ';
export const ALL_PROFILES = '*';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = text => Array.from(text).length;
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');
const oneLine = value => String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
const FIELD_NAMES = Object.freeze(['worldRules', 'prompting', 'characters', 'namePools', 'convai', 'memory']);

const validProfileKey = key => key === ALL_PROFILES || BUILT_IN_IDS.includes(key) || isCustomProfileId(key);

/** The fields of an override as a short list for a log line or the editor: ['rules', 'sampling']. */
const fieldsOf = override => Object.keys(override ?? {});

/**
 * The validated `content` object of a manifest, or a thrown Error naming what is wrong (the add-on is then skipped as a whole, never half applied).
 * Returns {worldRules: [line], prompting: {key: override}}; either part may be empty. A `prompting` override is checked by the same validator a player's change goes
 * through (bridge/prompt-profiles.mjs validateOverride, against no defaults so a value equal to one profile's default is still kept for the others).
 */
export function validateContent(raw, {dir = null} = {}) {
  if (!plain(raw)) throw Error('content must be an object');
  for (const key of Object.keys(raw)) {
    if (!FIELD_NAMES.includes(key)) throw Error(`content.${key} is not a known field (${FIELD_NAMES.join(', ')})`);
  }
  // The size cap is for the small parts; the characters and the name pools have limits of their own (bridge/addon-content-data.mjs).
  if (JSON.stringify({worldRules: raw.worldRules, prompting: raw.prompting, convai: raw.convai}).length > CONTENT_LIMITS.json) throw Error(`content is larger than ${CONTENT_LIMITS.json} characters`);
  // characters and namePools: inline, or the path of a .json file inside the pack folder (read later by loadContentFiles, before the pack is used).
  const files = {}, data = {};
  for (const field of ['characters', 'namePools']) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] === 'string') {
      const path = insideFolder(dir, raw[field]);
      if (!path) throw Error(`content.${field} must be a .json file path inside the add-on folder`);
      files[field] = path;
    } else if (field === 'characters') data.characters = validateCharacters(raw.characters);
    else data.namePools = validateNamePools(raw.namePools);
  }
  const convai = raw.convai === undefined ? {} : validateConvai(raw.convai);
  if (raw.memory !== undefined && raw.memory !== 'shared' && raw.memory !== 'separate') throw Error('content.memory must be "shared" or "separate"');
  const worldRules = [];
  if (raw.worldRules !== undefined) {
    if (!Array.isArray(raw.worldRules)) throw Error('content.worldRules must be a list of texts');
    let total = 0;
    raw.worldRules.forEach((item, index) => {
      if (typeof item !== 'string') throw Error(`content.worldRules[${index}] must be a text`);
      const line = oneLine(item);
      if (!line) return;
      if (count(line) > CONTENT_LIMITS.ruleText) throw Error(`content.worldRules[${index}] is longer than ${CONTENT_LIMITS.ruleText} characters`);
      total += count(line);
      worldRules.push(line);
    });
    if (worldRules.length > CONTENT_LIMITS.rules) throw Error(`content.worldRules holds more than ${CONTENT_LIMITS.rules} lines`);
    if (total > CONTENT_LIMITS.rulesTotal) throw Error(`content.worldRules is longer than ${CONTENT_LIMITS.rulesTotal} characters in all`);
  }
  const prompting = {};
  if (raw.prompting !== undefined) {
    if (!plain(raw.prompting)) throw Error('content.prompting must be an object of profile ids');
    const keys = Object.keys(raw.prompting);
    if (keys.length > CONTENT_LIMITS.profiles) throw Error(`content.prompting names more than ${CONTENT_LIMITS.profiles} profiles`);
    for (const key of keys) {
      if (!validProfileKey(key)) throw Error(`content.prompting.${key.slice(0, 40)} is not a profile id ("*", ${BUILT_IN_IDS.join(', ')} or a Custom profile)`);
      // A specific profile is checked as a player's change to it is (Mistral takes no top-K, min-P or extra fields; only the Mature and Custom options have a Mature layer). "*" is
      // checked as the widest option, and each profile it reaches keeps only the parts that profile accepts (AddonContent.layerFor).
      const options = key === ALL_PROFILES ? {mistral: false, matureOk: true} : {mistral: key === 'mistral', matureOk: matureCapable(key)};
      const checked = validateOverride(raw.prompting[key], {}, {}, options);
      if (!checked.ok) {
        const first = checked.errors[0];
        throw Error(`content.prompting.${key}: ${first.field || 'the change'}${first.key ? '.' + first.key : ''}${first.index !== undefined ? `[${first.index}]` : ''} is not valid (${first.code})`);
      }
      if (Object.keys(checked.value).length) prompting[key] = checked.value;
    }
  }
  return {worldRules, prompting, memory: raw.memory ?? 'shared', ...(Object.keys(convai).length ? {convai} : {}), ...data, ...(Object.keys(files).length ? {files} : {})};
}

// `later` laid over `earlier`, field by field: an object field merges by sub-field, a list or a value replaces (the way mergeProfile lays an override over a profile).
function layer(earlier, later) {
  const out = {...earlier};
  for (const [field, value] of Object.entries(later)) out[field] = plain(out[field]) && plain(value) ? {...out[field], ...value} : value;
  return out;
}

export class AddonContent {
  /**
   *   host   AddonHost (bridge/addons.mjs): the manifests (`content`) and the player's on/off values (`settings[id].contentEnabled`, false = off; default on)
   *   log    (text) => void
   * Registers itself on host.onContentSettings, so a switch the player flips in the game counts from the next reply with no restart.
   */
  constructor({host, log = () => {}} = {}) {
    Object.assign(this, {host, log});
    this.version = 0;               // grows each time the set of switched-on packs changes
    this.onChanged = null;          // () => void: the set changed (the bridge drops a group reply prepared from the old wording)
    this.layers = new Map();        // profile id -> frozen merged override | null
    this.packList = null;           // [{id, name, version, enabled, content, ...}] in folder-name order
    this.rulesMemo = null;          // {version, lines, trimmed}
    this.textMemo = new Map();      // player text -> combined text (cleared with the layers)
    this.logged = new Set();
    this.key = this.#enabledKey();
    if (host) host.onContentSettings = () => this.#refresh();
  }

  #all() {
    if (!this.packList) {
      this.packList = [...(this.host?.addons ?? [])].filter(addon => addon.content)
        .sort((a, b) => basename(a.dir).toLowerCase().localeCompare(basename(b.dir).toLowerCase()) || a.id.localeCompare(b.id));
    }
    return this.packList;
  }
  /** Is this pack switched on? The player's saved value (the game's Settings > Content packs); default on. */
  enabled(id) { return this.host?.settings?.[id]?.contentEnabled !== false; }
  #enabledKey() { return this.#all().map(addon => `${addon.id}:${this.enabled(addon.id) ? 1 : 0}`).join(','); }
  #refresh() {
    const key = this.#enabledKey();
    if (key === this.key) return;
    this.key = key;
    this.version++;
    this.layers.clear(); this.rulesMemo = null; this.textMemo.clear(); this.logged.clear();
    for (const addon of this.#all()) this.log(`Content pack ${addon.id} is ${this.enabled(addon.id) ? 'on' : 'off'}`);
    this.#applyRoster();
    try { this.onChanged?.(); } catch { /* the switch is saved; a hook never fails it */ }
  }

  // ---- The characters: the packs' text and names laid over the roster rows --------------------------------------------------------------
  /**
   * Hands over the bridge's roster array. The rows of the named characters and of the archetypes that a pack lists get the pack's backstory, speaking style, example lines and name
   * (a later pack wins per field), and go back to the shipped values when no pack that is on lists them. A rename keeps the shipped name as an alias, so the old name is still
   * recognised. The persona book and every other reader of the roster see the change at once (they read the rows on each turn); the player's own edits in the character editor
   * are laid over it by the persona book, so they still win. Done now and each time a pack is switched, never per turn.
   */
  bindRoster(roster) {
    this.roster = Array.isArray(roster) ? roster : null;
    this.#applyRoster();
  }
  #applyRoster() {
    const rows = this.roster;
    if (!rows) return;
    const packs = this.applied.filter(addon => addon.content.characters);
    const listed = new Set(this.#all().flatMap(addon => Object.keys(addon.content.characters ?? {})));
    let changed = 0;
    for (const row of rows) {
      if (!row || typeof row.key !== 'string' || row.kind === 'addon' || row.kind === 'custom') continue;
      if (!listed.has(row.key) && !row[SHIPPED]) continue;
      const shipped = row[SHIPPED] ??= {name: row.name, aliases: Array.isArray(row.aliases) ? [...row.aliases] : null,
        backstory: row.backstory, speakingStyleDescription: row.speakingStyleDescription, speakingStyleSampleDialogues: row.speakingStyleSampleDialogues};
      row.name = shipped.name; row.backstory = shipped.backstory;
      row.speakingStyleDescription = shipped.speakingStyleDescription; row.speakingStyleSampleDialogues = shipped.speakingStyleSampleDialogues;
      if (shipped.aliases) row.aliases = [...shipped.aliases]; else delete row.aliases;
      for (const addon of packs) {
        const mine = addon.content.characters[row.key];
        if (!mine) continue;
        for (const field of ['backstory', 'speakingStyleDescription', 'speakingStyleSampleDialogues']) if (mine[field] !== undefined) row[field] = mine[field];
        if (mine.name !== undefined && shipped.name) {
          row.name = mine.name;
          const aliases = [...(shipped.aliases ?? []), shipped.name];
          row.aliases = aliases.filter((alias, index) => alias && aliases.indexOf(alias) === index && alias !== mine.name);
        }
      }
      changed++;
    }
    if (changed || this.#named) this.host?.characterLookup?.reset?.();
    this.#named = changed > 0;
    const known = new Set(rows.map(row => row?.key));
    for (const addon of this.#all()) for (const key of Object.keys(addon.content.characters ?? {})) {
      if (!known.has(key)) this.#once(`unknown:${addon.id}:${key}`, `Content pack ${addon.id} names ${key}, which is not a character of the mod: left out`);
    }
  }
  #named = false;

  /** The pack that keeps a separate memory while it is on (the last pack on whose manifest says memory "separate"), as its id, or null: the characters' memory then lives under `<key>@<id>`. */
  memoryScope() {
    let scope = null;
    for (const addon of this.applied) if (addon.content.memory === 'separate') scope = addon.id;
    return scope;
  }
  /** The memory key of a character: the profile key, or `<key>@<pack id>` while a pack with a separate memory is on. */
  memoryKey(profileKey) {
    const scope = this.memoryScope();
    return scope && typeof profileKey === 'string' && !profileKey.includes('@') ? `${profileKey}@${scope}` : profileKey;
  }

  // ---- Convai: a twin of a character made from the pack's text -------------------------------------------------------------------------
  /**
   * The twins to register with the relationship routing: [{packId, profileKey, key, characterId}], from every installed pack (switched on or not; whether one is used is `twinFor`).
   * `key` is the provider key `<profileKey>-<pack id>` (the way a multilingual twin is `<profileKey>-multilingual`). A twin for a character the mod does not have, with an id another
   * character already uses, or with a key that does not fit is left out with one log line, so it can never stop the bridge.
   *   ids   {profileKey: ordinary Convai character id}      taken   other ids in use (the multilingual twins)
   */
  convaiTwins({ids = {}, taken = []} = {}) {
    const used = new Set([...Object.values(ids), ...taken]);
    const list = [];
    for (const addon of this.#all()) for (const [profileKey, characterId] of Object.entries(addon.content.convai ?? {})) {
      const key = `${profileKey}-${addon.id}`;
      const why = !Object.hasOwn(ids, profileKey) ? 'the mod has no Convai character for that key' : used.has(characterId) ? 'another character already uses that id'
        : !/^[a-z0-9][a-z0-9-]{0,79}$/.test(key) || Object.hasOwn(ids, key) ? 'its provider key does not fit' : '';
      if (why) { this.log(`Content pack ${addon.id}: the Convai twin of ${profileKey} is not used: ${why}`); continue; }
      used.add(characterId);
      list.push({packId: addon.id, profileKey, key, characterId});
    }
    this.twins = list;
    return list;
  }
  /** The provider key of the Convai twin a switched-on pack offers for a character (a later pack wins), or null. A plain lookup per turn. */
  twinFor(profileKey) {
    let found = null;
    for (const twin of this.twins ?? []) if (twin.profileKey === profileKey && this.enabled(twin.packId)) found = twin.key;
    return found;
  }

  // ---- Files for the game: the new names and the name pools (the game applies them with its own switches) ------------------------------
  /**
   * Writes runtime/content-names.json ({version: 1, packs: [{id, names: {profileKey: name}}]}) and runtime/content-name-pools.json ({version: 1, packs: [{id, pools}]}) for the game
   * (mod/content-names.lua). Every installed pack is listed, switched on or off: the game applies the ones its own settings have on. With nothing to say a file an earlier run
   * left is emptied, and a missing or empty one is left alone (under Mod Organizer 2 only a file that exists is written in place). Never throws.
   */
  async publish(runtime, {write = (path, data) => writeFile(path, data), read = path => readFile(path, 'utf8')} = {}) {
    const names = this.#all().map(addon => ({id: addon.id, names: Object.fromEntries(Object.entries(addon.content.characters ?? {})
      .filter(([, entry]) => entry.name).map(([key, entry]) => [key, entry.name]))})).filter(pack => Object.keys(pack.names).length);
    const pools = this.#all().filter(addon => addon.content.namePools).map(addon => ({id: addon.id, pools: addon.content.namePools}));
    const put = async (file, packs) => {
      const path = resolve(runtime, file);
      try {
        if (packs.length) { await mkdir(runtime, {recursive: true}); await write(path, JSON.stringify({version: 1, packs})); }
        else if ((await read(path).catch(() => '')) !== '') await write(path, '');
      } catch (error) { this.log(`${file} not written: ${error.message}`); }
    };
    await put(CONTENT_NAMES_FILE, names);
    await put(CONTENT_POOLS_FILE, pools);
  }

  /** True when at least one pack with content is installed (on or off). */
  get installed() { return this.#all().length > 0; }
  /** The packs that are on, in the order they are applied (folder name; a later one wins). */
  get applied() { return this.#all().filter(addon => this.enabled(addon.id)); }

  /** Every installed pack for the editor and the log: [{id, name, version, enabled, profiles, rules}]. `profiles`: the keys its `prompting` names; `rules`: its world rule lines. */
  list() {
    return this.#all().map(addon => ({id: addon.id, name: addon.name, version: addon.version, enabled: this.enabled(addon.id),
      profiles: Object.keys(addon.content.prompting), rules: [...addon.content.worldRules]}));
  }

  /**
   * The packs' merged change to one prompt profile: for each pack in order, "*" and then the profile's own key (the specific one wins); the later pack wins per field.
   * A frozen object that stays the same until a pack is switched on or off, or null when no pack changes the profile. A plain Map lookup after the first call.
   */
  layerFor(profileId) {
    if (this.layers.has(profileId)) return this.layers.get(profileId);
    let merged = null;
    for (const addon of this.applied) {
      const mine = addon.content.prompting;
      // "*" keeps for this profile only what a player's change to it could set (readOverride drops the rest, as a damaged file's invalid parts are dropped).
      if (mine[ALL_PROFILES]) merged = layer(merged ?? {}, readOverride(mine[ALL_PROFILES], {}, {mistral: profileId === 'mistral', matureOk: matureCapable(profileId)}));
      if (mine[profileId]) merged = layer(merged ?? {}, mine[profileId]);
    }
    const result = merged && Object.keys(merged).length ? deepFreeze(merged) : null;
    this.layers.set(profileId, result);
    return result;
  }
  /** The names of the packs (switched on) that change a profile, for the editor: ['Medieval AI NPCs']. */
  namesFor(profileId) {
    return this.applied.filter(addon => addon.content.prompting[ALL_PROFILES] || addon.content.prompting[profileId]).map(addon => addon.name);
  }
  /** What the packs change in a profile, as the field names the editor lists: ['rules', 'closing']. */
  fieldsFor(profileId) { return fieldsOf(this.layerFor(profileId)); }

  // The lines of every pack that is on, in order, kept whole while they fit: [{id, name, lines}], and whether a pack's lines were left out.
  #rules() {
    if (this.rulesMemo?.version === this.version) return this.rulesMemo;
    const packs = [];
    let used = 0, trimmed = false;
    for (const addon of this.applied) {
      const lines = [];
      for (const line of addon.content.worldRules) {
        if (used + count(line) > CONTENT_LIMITS.combinedRules) { trimmed = true; continue; }
        used += count(line); lines.push(line);
      }
      if (lines.length) packs.push({id: addon.id, name: addon.name, lines});
    }
    if (trimmed) this.#once('combined', 'the content packs\' world rules are longer than ' + CONTENT_LIMITS.combinedRules + ' characters together: the lines that did not fit are left out');
    this.rulesMemo = {version: this.version, packs, trimmed};
    return this.rulesMemo;
  }
  #once(key, message) {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.log(message);
  }

  /** The packs' world rules (switched on), for the editor to show read-only: [{id, name, rules}]. */
  worldRulesList() { return this.#rules().packs.map(pack => ({id: pack.id, name: pack.name, rules: [...pack.lines]})); }

  /** The player's world rules, then the packs' lines, one per line: what every text-provider persona carries. The player's text alone (the same string) while no pack adds a line. */
  worldRulesText(player = '') {
    const own = typeof player === 'string' ? player : '';
    const packs = this.#rules().packs;
    if (!packs.length) return own;
    if (this.textMemo.has(own)) return this.textMemo.get(own);
    const lines = packs.flatMap(pack => pack.lines.map(line => WORLD_RULE_BULLET + line));
    const text = [own.trim(), ...lines].filter(Boolean).join('\n');
    this.textMemo.set(own, text);
    return text;
  }
  /**
   * The same words for Convai's dynamic info (bridge/world-rules.mjs convaiWorldRulesBlocks), which has a size to keep: the player's rules stay whole, and the packs' lines are added
   * while the whole stays within CONTENT_LIMITS.convaiRules (a pack's line that does not fit is left out, with one log line per change). The player's text alone while no pack adds a line.
   */
  convaiWorldRulesText(player = '') {
    const own = typeof player === 'string' ? player : '';
    const packs = this.#rules().packs;
    if (!packs.length) return own;
    const memo = `convai\u0000${own}`;
    if (this.textMemo.has(memo)) return this.textMemo.get(memo);
    let used = count(own.trim()), skipped = 0;
    const lines = [];
    for (const pack of packs) for (const line of pack.lines) {
      const cost = count(WORLD_RULE_BULLET + line) + 1;
      if (used + cost > CONTENT_LIMITS.convaiRules) { skipped++; continue; }
      used += cost; lines.push(WORLD_RULE_BULLET + line);
    }
    if (skipped) this.#once('convai:' + own, `Convai's world rules hold ${CONTENT_LIMITS.convaiRules} characters: ${skipped} line(s) of the content packs are left out so your own rules stay whole`);
    const text = [own.trim(), ...lines].filter(Boolean).join('\n');
    this.textMemo.set(memo, text);
    return text;
  }

  /** A `WorldRules`-shaped view the persona book reads (`get()`): the player's rules with the packs' lines after them. Everything else is the player's store's. */
  worldRulesView(store) {
    return {get: () => this.worldRulesText(store.get())};
  }

  /** One line for the log at start: which packs are installed and what each changes. */
  describe() {
    return this.list().map(pack => `${pack.id} ${pack.version} ${pack.enabled ? 'on' : 'off'}: ${pack.rules.length} world rule(s), prompting for ${pack.profiles.join(', ') || 'no profile'}`).join('; ');
  }
}
