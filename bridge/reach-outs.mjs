// Characters reach out first (docs/BOND_QUESTS.md section 15, docs/QUEST_PRIMITIVES.md section 10.7): a character texts, calls or (Johnny) speaks up in V's head at a prepared
// moment, with a fixed line. This file is the bridge's part: the data format and its validator, the state (cooldowns, once-only triggers, the hour and day caps) and
// `eligible`, which gives the play file's `reach` block, the triggers that may fire now. The game checks the moments (a district change, a fight end, a 60 s tick) and delivers;
// it tells the bridge with the event `reach:<id>` (pack "reach"), which starts the cooldown (`noteFired`).
//
// Data: characters/reach-outs/<character>.json
//   {format: 1, character, requires?: <gate fields as a pack's>, triggers: [{
//      id, via: "text" | "call" | "voice", text, image?,
//      after?: [conditions the bridge knows]:  {kind: "quest", path} | {kind: "bond", level} | {kind: "bond", levels: [..]} (once per level) | {kind: "pack", id} |
//                                              {kind: "pack", ids: [..]} (once per finished pack) | {kind: "idle-days", days}
//      when?: one condition the game checks:   {kind: "weather", is} | {kind: "hours", from, to, idle?} | {kind: "district", is, minutes?} |
//                                              {kind: "fight-end", healthBelow?, heatAtLeast?, district?} | {kind: "heat", atLeast} | {kind: "song", contains?}
//      minBond?, cooldownDays? (default 1 unless once), once?, relationship?: "partner" | "not-partner" (the romance the save confirmed), note?, offer?: <hangout pack id> }]}
// `note` is what the character knows when V answers: the runner adds it to the next three private turns of that character.
// Pure and offline: no I/O except reading the shipped folder when asked.
import {readFileSync, readdirSync} from 'node:fs';
import {checkRequires, journalGate, JOURNAL_PATH} from './bond-packs.mjs';
import {finished, questState, inventoryComplete} from './bonds.mjs';
import {wantedFacts} from './quest-facts.mjs';

export const REACH_FORMAT = 1;
export const REACH_LIMITS = Object.freeze({triggers: 12, text: 240, note: 300, after: 4, levels: 10, ids: 8, cooldownDays: [0.1, 365]});
export const VIAS = Object.freeze(['text', 'call', 'voice']);
/** One per game hour and three per game day across all characters (the game enforces the same caps; the bridge hides the list while they are used up). */
export const REACH_CAPS = Object.freeze({perHour: 1, perDay: 3});
const HOUR = 3600, DAY = 86400, SLACK = 120;
const TRIGGER_ID = /^[a-z][a-z0-9-]{1,31}$/;
const PROFILE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PACK_ID = /^[a-z][a-z0-9-]{2,47}$/;
const KEY = /^[a-z][a-z0-9-]{1,31}$/;
const DISTRICT = /^[A-Za-z][A-Za-z0-9_ ]{1,40}$/;
const ENGLISH = /^[\x20-\x7E‘’“”…]+$/;
const DASH = /[–—]|--| - /;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const num = (value, low, high) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;

/** Whether a string is fit for a player to read: English, no semicolon, no dash used as punctuation. Returns a problem or null. */
export function textProblem(value, max) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) return `must be 1 to ${max} characters`;
  if (value.includes(';')) return 'has a semicolon, use a comma or a full stop';
  if (DASH.test(value)) return 'uses a dash as punctuation, use a comma, a colon or a full stop';
  if (!ENGLISH.test(value)) return 'must be English (plain letters and punctuation)';
  return null;
}

function checkAfter(item, where, fail, packIds) {
  if (!plain(item)) { fail(`${where} must be an object`); return; }
  const only = allowed => { for (const key of Object.keys(item)) if (key !== 'kind' && !allowed.includes(key)) fail(`${where}: no field ${JSON.stringify(key).slice(0, 30)}`); };
  switch (item.kind) {
    case 'quest':
      only(['path']);
      if (typeof item.path !== 'string' || !JOURNAL_PATH.test(item.path)) fail(`${where}: path must be a journal quest path`);
      break;
    case 'bond': {
      only(['level', 'levels']);
      const one = item.level !== undefined, many = item.levels !== undefined;
      if (one === many) fail(`${where}: a bond condition needs level or levels`);
      else if (one && !(Number.isInteger(item.level) && item.level >= 1 && item.level <= 10)) fail(`${where}: level must be from 1 to 10`);
      else if (many && (!Array.isArray(item.levels) || item.levels.length < 2 || item.levels.length > REACH_LIMITS.levels || new Set(item.levels).size !== item.levels.length
        || item.levels.some(level => !(Number.isInteger(level) && level >= 1 && level <= 10)))) fail(`${where}: levels must be 2 to 10 different levels from 1 to 10`);
      break;
    }
    case 'pack': {
      only(['id', 'ids']);
      const one = item.id !== undefined, many = item.ids !== undefined;
      const known = id => typeof id === 'string' && PACK_ID.test(id) && (!packIds || packIds.has(id));
      if (one === many) fail(`${where}: a pack condition needs id or ids`);
      else if (one && !known(item.id)) fail(`${where}: id must be a pack id of the mod`);
      else if (many && (!Array.isArray(item.ids) || item.ids.length < 2 || item.ids.length > REACH_LIMITS.ids || !item.ids.every(known))) fail(`${where}: ids must be 2 to ${REACH_LIMITS.ids} pack ids of the mod`);
      break;
    }
    case 'idle-days':
      only(['days']);
      if (!(Number.isInteger(item.days) && item.days >= 2 && item.days <= 60)) fail(`${where}: days must be from 2 to 60`);
      break;
    default: fail(`${where}: kind must be quest, bond, pack or idle-days`);
  }
}

function checkWhen(item, where, fail) {
  if (!plain(item)) { fail(`${where} must be an object`); return; }
  const only = allowed => { for (const key of Object.keys(item)) if (key !== 'kind' && !allowed.includes(key)) fail(`${where}: no field ${JSON.stringify(key).slice(0, 30)}`); };
  switch (item.kind) {
    case 'weather':
      only(['is']);
      if (typeof item.is !== 'string' || !KEY.test(item.is)) fail(`${where}: is must be a weather name`);
      break;
    case 'hours':
      only(['from', 'to', 'idle']);
      if (!num(item.from, 0, 24) || !num(item.to, 0, 24) || item.from === item.to) fail(`${where}: from and to must be different hours from 0 to 24`);
      if (item.idle !== undefined && !(item.idle === true || num(item.idle, 1, 120))) fail(`${where}: idle must be true or a number of game minutes from 1 to 120`);
      break;
    case 'district':
      only(['is', 'minutes']);
      if (typeof item.is !== 'string' || !DISTRICT.test(item.is)) fail(`${where}: is must be a district name`);
      if (item.minutes !== undefined && !num(item.minutes, 1, 120)) fail(`${where}: minutes must be from 1 to 120`);
      break;
    case 'fight-end':
      only(['healthBelow', 'heatAtLeast', 'district']);
      if (item.healthBelow !== undefined && !num(item.healthBelow, 5, 95)) fail(`${where}: healthBelow must be a percent from 5 to 95`);
      if (item.heatAtLeast !== undefined && !(Number.isInteger(item.heatAtLeast) && item.heatAtLeast >= 1 && item.heatAtLeast <= 5)) fail(`${where}: heatAtLeast must be from 1 to 5`);
      if (item.district !== undefined && !(typeof item.district === 'string' && DISTRICT.test(item.district))) fail(`${where}: district must be a district name`);
      break;
    case 'heat':
      only(['atLeast']);
      if (!(Number.isInteger(item.atLeast) && item.atLeast >= 1 && item.atLeast <= 5)) fail(`${where}: atLeast must be from 1 to 5`);
      break;
    case 'song':
      only(['contains']);
      if (item.contains !== undefined && !(typeof item.contains === 'string' && item.contains.length >= 1 && item.contains.length <= 40 && ENGLISH.test(item.contains))) fail(`${where}: contains must be 1 to 40 characters`);
      break;
    default: fail(`${where}: kind must be weather, hours, district, fight-end, heat or song`);
  }
}

/**
 * Checks one reach-out file. `characters`: the roster keys (a Set) or null; `packIds`: the ids of the packs of the mod (a Set) or null (an `offer` or a `pack` condition
 * then only has to look like a pack id). Returns {ok, errors}: every problem, each a short English sentence with the place.
 */
export function validateReachFile(file, {characters = null, packIds = null} = {}) {
  const errors = [];
  const fail = message => { errors.push(message); };
  if (!plain(file)) return {ok: false, errors: ['the file is not an object']};
  for (const key of Object.keys(file)) if (!['format', 'character', 'requires', 'triggers'].includes(key)) fail(`no field ${JSON.stringify(key).slice(0, 30)}`);
  if (file.format !== REACH_FORMAT) fail(`format must be ${REACH_FORMAT}`);
  if (typeof file.character !== 'string' || !PROFILE.test(file.character)) fail('character must be a profile key');
  else if (characters && !characters.has(file.character)) fail(`character ${file.character} is not on the roster`);
  if (file.requires !== undefined) {
    if (!plain(file.requires)) fail('requires must be an object');
    else {
      for (const key of Object.keys(file.requires)) {
        if (!['questsFinished', 'questsSucceeded', 'notActive', 'before', 'notBegun', 'facts', 'window', 'bond'].includes(key)) fail(`requires has no field ${JSON.stringify(key).slice(0, 30)}`);
      }
      checkRequires(file.requires, fail);
    }
  }
  if (!Array.isArray(file.triggers) || file.triggers.length === 0 || file.triggers.length > REACH_LIMITS.triggers) {
    fail(`triggers must be a list of 1 to ${REACH_LIMITS.triggers}`);
    return {ok: false, errors};
  }
  const ids = new Set();
  file.triggers.forEach((trigger, index) => {
    const where = `trigger ${plain(trigger) && typeof trigger.id === 'string' ? trigger.id : index + 1}`;
    if (!plain(trigger)) { fail(`${where} must be an object`); return; }
    for (const key of Object.keys(trigger)) {
      if (!['id', 'via', 'text', 'image', 'after', 'when', 'minBond', 'cooldownDays', 'once', 'relationship', 'note', 'offer'].includes(key)) fail(`${where}: no field ${JSON.stringify(key).slice(0, 30)}`);
    }
    if (typeof trigger.id !== 'string' || !TRIGGER_ID.test(trigger.id)) fail(`${where}: id must be 2 to 32 lowercase letters, digits or hyphens`);
    else if (ids.has(trigger.id)) fail(`${where}: the id is used twice`);
    else ids.add(trigger.id);
    if (!VIAS.includes(trigger.via)) fail(`${where}: via must be one of ${VIAS.join(', ')}`);
    const problem = textProblem(trigger.text, REACH_LIMITS.text);
    if (problem) fail(`${where}: text ${problem}`);
    if (trigger.image !== undefined && !(typeof trigger.image === 'string' && KEY.test(trigger.image))) fail(`${where}: image must be a picture key`);
    if (trigger.note !== undefined) { const noteProblem = textProblem(trigger.note, REACH_LIMITS.note); if (noteProblem) fail(`${where}: note ${noteProblem}`); }
    if (trigger.after !== undefined) {
      if (!Array.isArray(trigger.after) || trigger.after.length === 0 || trigger.after.length > REACH_LIMITS.after) fail(`${where}: after must be a list of 1 to ${REACH_LIMITS.after}`);
      else {
        trigger.after.forEach((item, at) => checkAfter(item, `${where} after ${at + 1}`, fail, packIds));
        const listed = trigger.after.filter(item => plain(item) && ((item.kind === 'bond' && item.levels) || (item.kind === 'pack' && item.ids)));
        if (listed.length > 1) fail(`${where}: only one condition may be a list (levels or ids)`);
        if (listed.length && trigger.once === true) fail(`${where}: a list condition is already once per item, drop once`);
      }
    }
    if (trigger.when !== undefined) checkWhen(trigger.when, `${where} when`, fail);
    if (trigger.minBond !== undefined && !(Number.isInteger(trigger.minBond) && trigger.minBond >= 1 && trigger.minBond <= 10)) fail(`${where}: minBond must be from 1 to 10`);
    if (trigger.cooldownDays !== undefined && !num(trigger.cooldownDays, ...REACH_LIMITS.cooldownDays)) fail(`${where}: cooldownDays must be from ${REACH_LIMITS.cooldownDays[0]} to ${REACH_LIMITS.cooldownDays[1]}`);
    if (trigger.once !== undefined && typeof trigger.once !== 'boolean') fail(`${where}: once must be true or false`);
    if (trigger.once === true && trigger.cooldownDays !== undefined) fail(`${where}: once and cooldownDays do not go together`);
    if (trigger.relationship !== undefined && !['partner', 'not-partner'].includes(trigger.relationship)) fail(`${where}: relationship must be partner or not-partner`);
    if (trigger.offer !== undefined && !(typeof trigger.offer === 'string' && PACK_ID.test(trigger.offer) && (!packIds || packIds.has(trigger.offer)))) fail(`${where}: offer must be a hangout pack id`);
    if (trigger.after === undefined && trigger.when === undefined && trigger.minBond === undefined) fail(`${where}: needs after, when or minBond (a trigger with no condition would fire at once)`);
  });
  return {ok: errors.length === 0, errors};
}

/** The shipped files (characters/reach-outs/*.json), parsed, in file-name order: [{file, data}]. A missing folder gives none. */
export function shippedReachFiles() {
  const folder = new URL('../characters/reach-outs/', import.meta.url);
  try {
    return readdirSync(folder).filter(name => name.endsWith('.json')).sort().map(file => ({file, data: JSON.parse(readFileSync(new URL(file, folder), 'utf8'))}));
  } catch { return []; }
}

const keyList = (trigger) => {
  for (const item of trigger.after ?? []) {
    if (item.kind === 'bond' && item.levels) return {type: 'level', list: item.levels};
    if (item.kind === 'pack' && item.ids) return {type: 'pack', list: item.ids};
  }
  return null;
};

export class ReachOuts {
  /**
   * files       [{data}] or [data]: the reach-out files (validated here; an invalid one is left out and logged)
   * characters  the roster keys for the validator      packIds   the pack ids of the mod, for `pack` conditions and `offer` (null: not checked)
   */
  constructor({files = shippedReachFiles(), characters = null, packIds = null, log = () => {}} = {}) {
    this.log = log;
    this.files = new Map();       // character -> the file's data
    this.triggers = new Map();    // trigger id -> {character, trigger}
    for (const row of files) {
      const data = row?.data ?? row;
      const result = validateReachFile(data, {characters, packIds});
      if (!result.ok) { log(`reach-outs for ${data?.character} left out: ${result.errors[0]}`); continue; }
      if (this.files.has(data.character)) { log(`reach-outs for ${data.character} left out: the character has a file already`); continue; }
      if (data.triggers.some(trigger => this.triggers.has(trigger.id))) { log(`reach-outs for ${data.character} left out: a trigger id is used in another file`); continue; }
      this.files.set(data.character, data);
      for (const trigger of data.triggers) this.triggers.set(trigger.id, {character: data.character, trigger});
    }
    this.state = new Map();       // trigger id -> {lastFired, done: {key: at}}
    this.fired = [];              // the game clocks of the newest deliveries, oldest first
    this.pending = new Map();     // trigger id -> the keys the last `eligible` found (marked done when the game delivers)
  }

  get size() { return this.triggers.size; }

  /** The `requires` objects of every file (for the facts the game must read). */
  requiresList() { return [...this.files.values()].map(file => file.requires).filter(Boolean); }
  factsWanted() { return wantedFacts(this.requiresList()); }

  // ---- state ---------------------------------------------------------------------------------------------------------------------------------

  load(value) {
    if (!plain(value)) return;
    if (plain(value.triggers)) {
      for (const [id, row] of Object.entries(value.triggers)) {
        if (!this.triggers.has(id) || !plain(row)) continue;
        const done = {};
        if (plain(row.done)) for (const [key, at] of Object.entries(row.done)) if (/^[A-Za-z0-9_.:-]{0,48}$/.test(key) && (whole(at) || at === null)) done[key] = at;
        this.state.set(id, {lastFired: whole(row.lastFired) ? row.lastFired : null, done});
      }
    }
    if (Array.isArray(value.fired)) this.fired = value.fired.filter(whole).slice(-8);
  }

  toJSON() {
    const triggers = {};
    for (const [id, row] of this.state) if (row.lastFired !== null || Object.keys(row.done).length) triggers[id] = {lastFired: row.lastFired, done: row.done};
    return {triggers, fired: this.fired};
  }

  /** A load of an earlier save: whatever was stamped after the clock never happened. Returns whether anything changed. */
  rewind(gameSeconds) {
    if (!whole(gameSeconds)) return false;
    const limit = gameSeconds + SLACK;
    let changed = false;
    for (const row of this.state.values()) {
      if (row.lastFired !== null && row.lastFired > limit) { row.lastFired = null; changed = true; }
      for (const [key, at] of Object.entries(row.done)) if (at !== null && at > limit) { delete row.done[key]; changed = true; }
    }
    const kept = this.fired.filter(at => at <= limit);
    if (kept.length !== this.fired.length) { this.fired = kept; changed = true; }
    return changed;
  }

  #row(id) {
    let row = this.state.get(id);
    if (!row) { row = {lastFired: null, done: {}}; this.state.set(id, row); }
    return row;
  }

  /**
   * The game delivered trigger `id` at game time `at`: starts its cooldown, marks the pending keys (or `once`) done and counts it for the hour and day caps.
   * Returns {character, trigger} (the runner stores the note for V's answer), or null for an id that is not known.
   */
  noteFired(id, at) {
    const found = this.triggers.get(id);
    if (!found) return null;
    const clock = whole(at) ? at : null;
    const row = this.#row(id);
    row.lastFired = clock;
    const keys = this.pending.get(id);
    if (keys?.length) for (const key of keys) row.done[key] = clock;
    else if (found.trigger.once === true) row.done[''] = clock;
    this.pending.delete(id);
    if (clock !== null) { this.fired.push(clock); this.fired.sort((a, b) => a - b); if (this.fired.length > 8) this.fired.splice(0, this.fired.length - 8); }
    return found;
  }

  // ---- what may fire now ----------------------------------------------------------------------------------------------------------------------

  /**
   * The play file's reach block: {enabled, items: [{id, character, via, text, image?, when?, offer?}], perHour, perDay}.
   *   enabled       Story packs AND Characters text first are on
   *   gameSeconds   the newest game clock the bridge knows (null: nothing is listed)
   *   journalHistory, facts, tracked   for the character gates (bridge/bond-packs.mjs journalGate)
   *   levels        {profileKey: bond level}   talkedAt   {profileKey: game clock of the last talk}   romance   {profileKey: 'partner' | 'casual'}
   *   busy          Set of characters who have a story pack open or an offer waiting (they get no reach-out: their own texts take the slot)
   *   finishedPacks Set of finished pack ids
   */
  eligible({enabled = false, gameSeconds = null, journalHistory = null, facts = null, tracked, levels = {}, talkedAt = {}, romance = {}, busy = new Set(),
    finishedPacks = new Set()} = {}) {
    const block = {enabled: enabled === true, items: [], ...REACH_CAPS};
    this.pending.clear();
    if (!block.enabled || !whole(gameSeconds) || !this.files.size) return block;
    if (this.fired.filter(at => at > gameSeconds - HOUR).length >= REACH_CAPS.perHour || this.fired.filter(at => at > gameSeconds - DAY).length >= REACH_CAPS.perDay) return block;
    if (!inventoryComplete(journalHistory)) return block;
    for (const [character, file] of this.files) {
      if (busy.has(character)) continue;
      if (!journalGate({requires: file.requires ?? {}, character}, {journalHistory, facts, tracked}).open) continue;
      const level = Number.isInteger(levels[character]) ? levels[character] : null;
      for (const trigger of file.triggers) {
        const keys = this.#ready(trigger, {gameSeconds, journalHistory, level, talkedAt: talkedAt[character], romance: romance[character] ?? null, finishedPacks, character});
        if (!keys) continue;
        if (keys.length) this.pending.set(trigger.id, keys);
        block.items.push({id: trigger.id, character, via: trigger.via, text: trigger.text, ...(trigger.image ? {image: trigger.image} : {}),
          ...(trigger.when ? {when: trigger.when} : {}), ...(trigger.offer ? {offer: trigger.offer} : {})});
      }
    }
    return block;
  }

  /** The keys a trigger would mark done if delivered now ([] for a plain trigger), or null when it may not fire. */
  #ready(trigger, {gameSeconds, journalHistory, level, talkedAt, romance, finishedPacks}) {
    const row = this.state.get(trigger.id) ?? {lastFired: null, done: {}};
    if (trigger.minBond !== undefined && !(level !== null && level >= trigger.minBond)) return null;
    if (trigger.relationship === 'partner' && romance !== 'partner') return null;
    if (trigger.relationship === 'not-partner' && romance === 'partner') return null;
    if (trigger.once === true && Object.hasOwn(row.done, '')) return null;
    if (row.lastFired !== null && gameSeconds < row.lastFired + (trigger.cooldownDays ?? 1) * DAY && trigger.once !== true) return null;
    let keys = [];
    for (const item of trigger.after ?? []) {
      if (item.kind === 'quest') { if (!finished(questState(journalHistory, item.path))) return null; }
      else if (item.kind === 'idle-days') { if (!(whole(talkedAt) && gameSeconds - talkedAt >= item.days * DAY)) return null; }
      else if (item.kind === 'bond') {
        if (level === null) return null;
        if (item.level !== undefined) { if (level < item.level) return null; }
        else keys = item.levels.filter(at => at <= level && !Object.hasOwn(row.done, String(at))).map(String);
      } else if (item.kind === 'pack') {
        if (item.id !== undefined) { if (!finishedPacks.has(item.id)) return null; }
        else keys = item.ids.filter(id => finishedPacks.has(id) && !Object.hasOwn(row.done, id));
      }
    }
    if (keyList(trigger) && keys.length === 0) return null;
    return keys;
  }
}
