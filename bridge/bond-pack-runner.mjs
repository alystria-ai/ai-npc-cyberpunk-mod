// Story packs, running (docs/RELATIONSHIPS_AND_QUESTS.md section 7.3): Settings > Gameplay > Story packs, off by default, on top of Character bonds.
//
// A pack is a short arc of one character (bridge/bond-packs.mjs holds the format and the plot-safety gate). This file plays it:
//   START   on a private turn of V's (in person with one of V's own copies, Phone Chat, a holocall), when the gate is open and the dice say so: that turn's
//           volatile note carries the pack's `bringUp` and the first stage's `know` and `wants`. Nothing starts from a timer, so no turn is spent that V did not start.
//   NOTES   every later turn on a channel the pack allows carries the current stage (`know`, `wants`, the meeting it hopes for, the money it needs).
//   CHOICES a stage ends by V's own words (bridge/bond-intent.mjs, read after the reply is published: no model call, no tag in a reply), by an Eddies transfer
//           with the pack as its story (the ledger row of the next turn says it was done), by the outcome of a meeting (appointment events), or by its timer.
//   TIMERS  checked when a turn's context is built, never by a tick.
//   ENDING  a bond reward (or penalty) and a note the character keeps for 3 game days.
// The state follows the SAVE: every step carries the game clock, and a turn whose clock is earlier than a step rewinds the pack to where that clock had it.
// What the game is asked to do (runtime/bond-effects.json) is computed from the state: a car that is not offered, one-shot items, an outfit for a stage.
// Nothing runs per frame; the work is a pass over a few stages while a context is built and one small write when a stage changes.
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve as resolvePath, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomicFile} from './guarded-file.mjs';
import {packGate, explainGate, validatePack, shippedPacks, blockingQuest, trackedPathOf, KNOWN_STAGE_TYPES, CHANNELS, HANGOUT_DEFAULTS} from './bond-packs.mjs';
import {intentKind} from './bond-intent.mjs';
import {debts} from './eddies.mjs';
import {channelOf} from './bonds.mjs';
import {questStates, questState, finished, inventoryComplete} from './bonds.mjs';
import {placesOf, referencesOf} from './quest-format.mjs';
import {ReachOuts} from './reach-outs.mjs';
import {wantedFacts} from './quest-facts.mjs';
import {resolveGive, likesFor, giftBond, TIERS} from './gift-tables.mjs';
import {screenGift, giftWords} from './gift-intent.mjs';
import {payNote, readPay, payData} from './quest-pay.mjs';

const DAY = 86400, HOUR = 3600;
/** Game seconds of slack before an entry counts as later than the loaded save (the clock read and the stamp are a moment apart). */
export const ROLLBACK_SLACK = 120;
export const MAX_ACTIVE = 2;
export const COOLDOWN_DAYS = 7;
export const ENDING_NOTE_DAYS = 3;
/** Lasting lines of shared history kept per character, and how many of them a turn's note carries. */
export const HISTORY_KEEP = 8, HISTORY_NOTE = 3;
/** How long an ended quest's closing rows stay in the play file (real milliseconds), and how many commands the file keeps. */
export const CLOSING_MS = 300000, COMMANDS_KEEP = 16;
/** A reach-out's note rides on V's answer and the next two private turns; an offered pack waits a game day; the cached bond levels for the reach-outs live this long (real ms). */
export const REACH_NOTE_TURNS = 3, OFFER_HOURS = 24, LEVELS_CACHE_MS = 30000;
const SHIPPED_PACK_FOLDER = fileURLToPath(new URL('../characters/bond-packs/', import.meta.url));
const MAX_FILE_CHARS = 1_000_000;
const MAX_STEPS = 8;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;

/** The packs shipped with the mod, or none when the folder is not there (a Runtime without them). */
function shippedOrNone() { try { return shippedPacks().map(row => row.pack); } catch { return []; } }
/** A turn's id: a talk turn's request id, a Phone Chat message's id. */
const turnId = input => typeof input?.requestId === 'string' && input.requestId ? input.requestId : typeof input?.id === 'string' && input.id ? input.id : null;
const WHERE = {here: 'where V is', home: 'at V\'s place, where you live now', waypoint: 'at the spot V marks on the map'};

// ---- hangout variations: swapping place ids (docs/QUEST_PRIMITIVES.md 10.8) -----------------------------------------------------------------------------
const PLACE_FIELDS = ['at', 'to', 'deadZone', 'from'], PLACE_LISTS = ['checkpoints', 'route', 'reroute'];
/** An event name with its place ids swapped by `map` (place:<id>:..., ride:checkpoint:<id>). */
function remapName(name, map) {
  if (typeof name !== 'string') return name;
  return name.replace(/^place:([a-z][a-z0-9-]*):/, (all, id) => `place:${map[id] ?? id}:`).replace(/^ride:checkpoint:([a-z][a-z0-9-]*)$/, (all, id) => `ride:checkpoint:${map[id] ?? id}`);
}
/** One `do` entry with its place fields swapped. */
function remapSpec(spec, map) {
  if (!plain(spec)) return spec;
  const out = {...spec};
  for (const key of PLACE_FIELDS) if (typeof out[key] === 'string' && Object.hasOwn(map, out[key])) out[key] = map[out[key]];
  for (const key of PLACE_LISTS) if (Array.isArray(out[key])) out[key] = out[key].map(id => (typeof id === 'string' && Object.hasOwn(map, id) ? map[id] : id));
  return out;
}
/** One script row with the place events it waits on or raises swapped. */
function remapRow(row, map) {
  if (!plain(row)) return row;
  return {...row, ...(typeof row.when === 'string' ? {when: remapName(row.when, map)} : {}), ...(typeof row.event === 'string' ? {event: remapName(row.event, map)} : {})};
}
/** A stage's music or sfx list with start / stop events and `place:` sources swapped. */
function remapSounds(list, map) {
  return list.map(item => plain(item) ? {...item, ...(typeof item.start === 'string' ? {start: remapName(item.start, map)} : {}), ...(typeof item.stop === 'string' ? {stop: remapName(item.stop, map)} : {}),
    ...(typeof item.at === 'string' && item.at.startsWith('place:') ? {at: `place:${map[item.at.slice(6)] ?? item.at.slice(6)}`} : {})} : item);
}

export class BondPacks {
  /**
   * packs     the packs (validated here; an invalid one is left out and logged)    characters   the roster keys (a Set) for the validator
   * path      <state>/bond-packs.json                                              effectsPath  runtime/bond-effects.json
   * bonds     the Bonds object (award points, publish the status)                  random, now, read, write, timers   injectable for tests
   * explain   () -> true while Developer mode is on: a pack that does not start says why in the log, once per pack per game day
   */
  constructor({packs = shippedOrNone(), characters = null, path = null, effectsPath = null, bonds = null, random = Math.random,
    now = Date.now, read = file => readFile(file, 'utf8'), write = (file, text) => atomicFile(file, text), log = () => {}, debounceMs = 5000,
    packFolder = SHIPPED_PACK_FOLDER, exists = file => existsSync(file), readFacts = null, reach = undefined, levelsOf = null, explain = null,
    timers = {set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle)}} = {}) {
    Object.assign(this, {path, effectsPath, bonds, random, now, read, write, log, debounceMs, timers, characters, packFolder, exists, readFacts, levelsOf, explain});
    this.explained = new Map();    // pack id (or profile key) -> the game day its reason was last logged
    this.packs = new Map();
    for (const pack of packs) {
      const result = validatePack(pack, {characters});
      if (!result.ok) { log(`pack ${pack?.id} left out: ${result.errors[0]}`); continue; }
      this.packs.set(pack.id, pack);
    }
    // The characters' reach-outs (bridge/reach-outs.mjs): their state lives in this runner's state file, like a pack's.
    this.reach = reach === undefined ? new ReachOuts({characters, log}) : reach;
    this.lastJournal = null;       // the newest journal inventory a private turn carried (the reach-outs' gate reads it)
    this.settings = {packs: false, reach: false};   // the settings the newest private turn carried (kept in the state file: the game may be played a while before the next turn)
    this.levelCache = {at: -Infinity, value: {}};
    this.entries = new Map();      // pack id -> {status, trail, ...}
    this.meta = new Map();         // profile key -> {rolled, endedAt, history, talkedAt, romance, hangoutDay, cap, gifts, reachNote, offer, hangouts}
    this.turns = new Map();        // request id -> the turn's decision
    this.loggedTypes = new Set();
    this.timer = null; this.dirty = false; this.chain = Promise.resolve();
    this.effectsText = ''; this.effectsRevision = 0; this.effectsChain = Promise.resolve();
    this.on = false;               // Story packs was on at the last turn (a meeting's outcome moves a pack only then)
    this.lastClock = undefined;
    // The quest files (docs/QUEST_PRIMITIVES.md): commands for the game (events the bridge decided), the closing rows of quests that just ended, the play file's revision.
    this.commands = []; this.commandSeq = Math.floor(now() / 1000) * 1000;
    this.closing = [];
    this.playText = ''; this.playRev = Math.floor(now() / 1000) * 1000;
  }

  /** Story packs was on at the last turn (a meeting's outcome moves a pack only then; a bridge that sees a turn with packs off sets it false). Turning it off also turns the reach-outs off. */
  get on() { return this.packsOn === true; }
  set on(value) {
    this.packsOn = value === true;
    if (this.settings.packs !== this.packsOn) { this.settings.packs = this.packsOn; this.#schedule(); }
  }

  // ---- the state ---------------------------------------------------------------------------------------------------------------------------

  async load() {
    if (!this.path) return 0;
    let value;
    try {
      const text = await this.read(this.path);
      if (typeof text !== 'string' || text.length > MAX_FILE_CHARS) return 0;
      value = JSON.parse(text);
    } catch { return 0; }
    if (value?.version !== 1 || !plain(value.entries)) return 0;
    for (const [id, row] of Object.entries(value.entries)) {
      const entry = this.#clean(id, row);
      if (entry && !this.entries.has(id)) this.entries.set(id, entry);
    }
    if (plain(value.meta)) for (const [key, row] of Object.entries(value.meta)) {
      if (plain(row) && /^[a-z0-9][a-z0-9-]{0,79}$/.test(key) && !this.meta.has(key)) this.meta.set(key, this.#cleanMeta(row));
    }
    if (plain(value.settings)) this.settings = {packs: value.settings.packs === true, reach: value.settings.reach === true};
    this.reach?.load?.(value.reach);
    this.#effects();
    return this.entries.size;
  }

  #blankMeta() {
    return {rolled: null, endedAt: null, history: [], talkedAt: null, romance: null, hangoutDay: null, cap: null, gifts: {used: [], day: null}, reachNote: null, offer: null, hangouts: {}};
  }

  /** The meta row of a character (made when it is not there yet). */
  #meta(profile) {
    let row = this.meta.get(profile);
    if (!row) { row = this.#blankMeta(); this.meta.set(profile, row); }
    return row;
  }

  #cleanMeta(row) {
    const meta = this.#blankMeta();
    meta.rolled = whole(row.rolled) ? row.rolled : null;
    meta.endedAt = whole(row.endedAt) ? row.endedAt : null;
    meta.history = this.#cleanHistory(row.history);
    meta.talkedAt = whole(row.talkedAt) ? row.talkedAt : null;
    meta.romance = row.romance === 'partner' || row.romance === 'casual' ? row.romance : null;
    meta.hangoutDay = whole(row.hangoutDay) ? row.hangoutDay : null;
    if (plain(row.cap) && whole(row.cap.day) && whole(row.cap.points)) meta.cap = {day: row.cap.day, points: row.cap.points};
    if (plain(row.gifts)) {
      meta.gifts.day = whole(row.gifts.day) ? row.gifts.day : null;
      if (Array.isArray(row.gifts.used)) meta.gifts.used = row.gifts.used.filter(item => plain(item) && TIERS.includes(item.tier) && (whole(item.at) || item.at === null)).slice(0, 5).map(item => ({tier: item.tier, at: item.at}));
    }
    if (plain(row.reachNote) && typeof row.reachNote.text === 'string' && row.reachNote.text.length <= 900 && Number.isInteger(row.reachNote.left) && row.reachNote.left >= 1 && row.reachNote.left <= REACH_NOTE_TURNS) {
      meta.reachNote = {text: row.reachNote.text, left: row.reachNote.left, at: whole(row.reachNote.at) ? row.reachNote.at : null};
    }
    if (plain(row.offer) && typeof row.offer.pack === 'string' && whole(row.offer.at)) meta.offer = {pack: row.offer.pack.slice(0, 48), at: row.offer.at};
    if (plain(row.hangouts)) for (const [id, item] of Object.entries(row.hangouts)) {
      if (plain(item) && typeof item.variation === 'string' && (whole(item.at) || item.at === null) && /^[a-z][a-z0-9-]{2,47}$/.test(id)) meta.hangouts[id] = {variation: item.variation.slice(0, 32), at: item.at};
    }
    return meta;
  }

  #cleanHistory(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.filter(row => plain(row) && typeof row.pack === 'string' && typeof row.text === 'string' && row.text.length <= 240 && (whole(row.at) || row.at === null))
      .slice(-HISTORY_KEEP).map(row => ({pack: row.pack.slice(0, 48), ending: typeof row.ending === 'string' ? row.ending.slice(0, 32) : '', text: row.text, at: row.at,
        ...(typeof row.from === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(row.from) ? {from: row.from} : {})}));
  }

  #clean(id, row) {
    const pack = this.packs.get(id);
    if (!pack || !plain(row) || !Array.isArray(row.trail) || row.trail.length === 0 || row.trail.length > 64) return null;
    const trail = [];
    for (const step of row.trail) {
      if (!plain(step) || typeof step.stage !== 'string' || !(whole(step.at) || step.at === null)) return null;
      trail.push({stage: step.stage, at: step.at, ...(typeof step.choice === 'string' ? {choice: step.choice.slice(0, 40)} : {}), ...(step.ending === true ? {ending: true} : {})});
    }
    const last = trail.at(-1), ended = last.ending === true;
    if (ended ? !(last.stage in pack.endings) : !pack.stages.some(stage => stage.id === last.stage)) return null;
    const gapId = plain(row.gap) && typeof row.gap.id === 'string' ? row.gap.id : null;
    const gap = !ended && gapId && pack.gaps?.[gapId] ? {id: gapId, openedAt: whole(row.gap.openedAt) ? row.gap.openedAt : null} : null;
    const variation = typeof row.variation === 'string' && pack.hangout?.variations?.some(item => item.id === row.variation) ? row.variation : null;
    return {status: ended ? 'done' : 'active', trail, presented: row.presented === true, beat: whole(row.beat) ? row.beat : null, gap, ...(variation ? {variation} : {}), ...(CHANNELS.includes(row.via) ? {via: row.via} : {})};
  }

  #schedule() {
    this.dirty = true;
    if (!this.path || this.timer) return;
    this.timer = this.timers.set(() => { this.timer = null; void this.flush().catch(() => {}); }, this.debounceMs);
    this.timer?.unref?.();
  }

  flush() {
    if (this.timer) { this.timers.clear(this.timer); this.timer = null; }
    this.chain = this.chain.then(() => this.#persist(), () => this.#persist());
    return this.chain;
  }

  async #persist() {
    if (!this.dirty || !this.path) return;
    this.dirty = false;
    try {
      const entries = {}, meta = {};
      for (const [id, entry] of this.entries) entries[id] = {trail: entry.trail, presented: entry.presented, beat: entry.beat, ...(entry.gap ? {gap: entry.gap} : {}), ...(entry.variation ? {variation: entry.variation} : {}), ...(entry.via ? {via: entry.via} : {})};
      for (const [key, row] of this.meta) {
        meta[key] = {rolled: row.rolled, endedAt: row.endedAt, ...(row.history?.length ? {history: row.history} : {}), ...(row.talkedAt !== null ? {talkedAt: row.talkedAt} : {}),
          ...(row.romance ? {romance: row.romance} : {}), ...(row.hangoutDay !== null ? {hangoutDay: row.hangoutDay} : {}), ...(row.cap ? {cap: row.cap} : {}),
          ...(row.gifts.used.length || row.gifts.day !== null ? {gifts: row.gifts} : {}), ...(row.reachNote ? {reachNote: row.reachNote} : {}), ...(row.offer ? {offer: row.offer} : {}),
          ...(Object.keys(row.hangouts).length ? {hangouts: row.hangouts} : {})};
      }
      if (await this.write(this.path, JSON.stringify({version: 1, entries, meta, settings: this.settings, reach: this.reach?.toJSON?.() ?? {}})) === false) this.dirty = true;
    } catch (error) {
      this.dirty = true;
      this.log(`could not save (${String(error?.message ?? error).slice(0, 120)})`);
    }
  }

  /** The state keeps the pack ids only; the stage the entry is at is the last step of its trail. */
  #stageOf(pack, entry) { const last = entry.trail.at(-1); return entry.status === 'active' ? pack.stages.find(stage => stage.id === last.stage) : null; }
  #stageAt(entry) { return entry.trail.at(-1).at; }
  #started(entry) { return entry.trail[0].at; }

  /**
   * The rollback guard: a turn whose clock is earlier than steps of a pack (a load of an earlier save) rewinds the pack to the stage the clock had it at; a pack
   * that had not started by then is forgotten. Returns whether anything changed.
   */
  rewind(gameSeconds) {
    if (!whole(gameSeconds)) return false;
    let changed = false;
    for (const [id, entry] of [...this.entries]) {
      const before = entry.trail.length;
      while (entry.trail.length && entry.trail.at(-1).at !== null && entry.trail.at(-1).at > gameSeconds + ROLLBACK_SLACK) entry.trail.pop();
      if (entry.trail.length === before) continue;
      changed = true;
      if (!entry.trail.length) { this.entries.delete(id); continue; }
      entry.status = 'active'; entry.presented = true; entry.beat = null; entry.gap = null;
    }
    const limit = gameSeconds + ROLLBACK_SLACK, limitDay = Math.floor(limit / DAY);
    for (const row of this.meta.values()) {
      if (row.history?.some(item => item.at !== null && item.at > limit)) { row.history = row.history.filter(item => item.at === null || item.at <= limit); changed = true; }
      if (row.rolled !== null && row.rolled > limitDay) { row.rolled = null; changed = true; }
      if (row.endedAt !== null && row.endedAt > limit) { row.endedAt = null; changed = true; }
      if (row.talkedAt !== null && row.talkedAt > limit) { row.talkedAt = null; changed = true; }
      if (row.hangoutDay !== null && row.hangoutDay > limitDay) { row.hangoutDay = null; changed = true; }
      if (row.cap && row.cap.day > limitDay) { row.cap = null; changed = true; }
      if (row.gifts.day !== null && row.gifts.day > limitDay) { row.gifts.day = null; changed = true; }
      if (row.gifts.used.some(item => item.at !== null && item.at > limit)) { row.gifts.used = row.gifts.used.filter(item => item.at === null || item.at <= limit); changed = true; }
      if (row.reachNote && row.reachNote.at !== null && row.reachNote.at > limit) { row.reachNote = null; changed = true; }
      if (row.offer && row.offer.at > limit) { row.offer = null; changed = true; }
      for (const [id, item] of Object.entries(row.hangouts)) if (item.at !== null && item.at > limit) { delete row.hangouts[id]; changed = true; }
    }
    if (this.reach?.rewind?.(gameSeconds)) changed = true;
    if (changed) { this.#schedule(); this.#effects(); }
    return changed;
  }

  // ---- moving through a pack ---------------------------------------------------------------------------------------------------------------

  /** A lasting line for `target` from another character's pack (memory-share, an ending's `share`): kept in the target's history like the pack's own lines. */
  #addShared(target, pack, ending, text, at) {
    if (typeof target !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(target) || typeof text !== 'string' || !text.trim()) return;
    const meta = this.#meta(target);
    meta.history = [...meta.history, {pack: pack.id, ending, text: text.trim().slice(0, 240), at: at ?? null, from: pack.character}].slice(-HISTORY_KEEP);
    this.#schedule();
  }

  /** A stage was entered: its memory-share primitives hand their note to the character they name. */
  #enter(pack, stage, gameSeconds) {
    for (const spec of Array.isArray(stage?.do) ? stage.do : []) {
      if (spec?.p === 'memory-share') this.#addShared(spec.to, pack, '', spec.note ?? pack.summary, gameSeconds);
    }
  }

  /** The bond points a hangout's ending pays: stood up (the hangout's own value when the ending names none), and the day's cap on what is gained (a loss is never capped). */
  #hangoutBond(pack, meta, ending, stoodUp, gameSeconds) {
    const block = {...HANGOUT_DEFAULTS, ...pack.hangout};
    let bond = ending.bond;
    if (bond === undefined && stoodUp) bond = block.stoodUp;
    if (!(bond > 0)) return bond ?? 0;
    const day = whole(gameSeconds) ? Math.floor(gameSeconds / DAY) : null;
    const used = day !== null && meta.cap?.day === day ? meta.cap.points : 0;
    const give = Math.max(0, Math.min(bond, block.capPerDay - used));
    if (day !== null) meta.cap = {day, points: used + give};
    return give;
  }

  #finish(pack, entry, endingId, gameSeconds, choice) {
    const ending = pack.endings[endingId];
    const previous = this.#stageOf(pack, entry);
    const stoodUp = !!previous?.choices?.some(item => item.id === choice && item.on === 'meet:stood-up');
    entry.trail.push({stage: endingId, at: gameSeconds ?? null, ...(choice ? {choice} : {}), ending: true});
    entry.status = 'done';
    const meta = this.#meta(pack.character);
    const hangout = pack.kind === 'hangout';
    // A hangout does not start the seven days of quiet a story pack leaves behind.
    if (!hangout) meta.endedAt = gameSeconds ?? null;
    if (ending.history) meta.history = [...meta.history, {pack: pack.id, ending: endingId, text: ending.history, at: gameSeconds ?? null}].slice(-HISTORY_KEEP);
    for (const share of ending.share ?? []) this.#addShared(share.to, pack, endingId, share.note ?? ending.memory, gameSeconds);
    entry.gap = null;
    // The ending's own rows (a closing line, a text) are carried to the game for a few minutes: the stage is gone from the play file by then.
    if (Array.isArray(ending.script) && ending.script.length) {
      const refs = referencesOf(ending.script);
      this.closing = this.closing.filter(item => item.pack !== pack.id);
      this.closing.push({pack: pack.id, character: pack.character, ending: endingId, serial: entry.trail.length, script: ending.script, ...this.#lineTables(pack, refs), at: this.now()});
    }
    // An ending reached because the quest it waited for was finished by the story (unfinishedWhen) pays nothing.
    const bond = choice === 'unfinished' ? 0 : hangout ? this.#hangoutBond(pack, meta, ending, stoodUp, gameSeconds) : ending.bond ?? 0;
    if (bond) this.bonds?.award(pack.character, bond, gameSeconds);
    this.log(`pack=${pack.id} ended ${endingId}${bond ? ` bond ${bond > 0 ? '+' : ''}${bond}` : ''}`);
  }

  /** Move an active entry on to `next` (a stage or an ending). Follows stages that cannot be played (an unknown type) to the one after. */
  #go(pack, entry, next, gameSeconds, choice) {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (next in pack.endings) { this.#finish(pack, entry, next, gameSeconds, choice); break; }
      const stage = pack.stages.find(item => item.id === next);
      if (!stage) { this.#finish(pack, entry, Object.keys(pack.endings)[0], gameSeconds, choice); break; }
      entry.trail.push({stage: next, at: gameSeconds ?? null, ...(choice ? {choice} : {})});
      entry.presented = false; entry.beat = null; entry.gap = null;
      this.log(`pack=${pack.id} stage=${next}${choice ? ` via ${choice}` : ''}`);
      this.#enter(pack, stage, gameSeconds);
      if (!stage.type || KNOWN_STAGE_TYPES.includes(stage.type)) break;
      // A stage type this build does not play: skipped, logged once per type, on to its skip, next, timeout or first choice.
      if (!this.loggedTypes.has(stage.type)) { this.loggedTypes.add(stage.type); this.log(`stage type ${stage.type} is not played yet: skipped (pack ${pack.id})`); }
      next = stage.skip ?? stage.next ?? stage.timeout?.next ?? stage.choices?.[0]?.next;
      choice = 'skipped';
      if (typeof next !== 'string') { this.#finish(pack, entry, Object.keys(pack.endings)[0], gameSeconds, choice); break; }
    }
    this.#schedule(); this.#effects();
  }

  /** Whatever ends the current stage by itself: its timer, a finished Eddies transfer of the pack, or a closing beat already shown. Returns whether it moved. */
  #resolve(pack, entry, {gameSeconds, eddiesRow}) {
    let moved = false;
    for (let step = 0; step < MAX_STEPS && entry.status === 'active'; step++) {
      const stage = this.#stageOf(pack, entry), at = this.#stageAt(entry);
      const tag = `${pack.id}:${stage.id}`;
      let next = null, choice = null;
      for (const item of stage.choices ?? []) {
        if (!item.on.startsWith('eddies:')) continue;
        const flow = item.on.slice(7), last = eddiesRow?.last;
        if (last?.story === tag && last.flow === flow && last.result === 'done' && (flow !== 'repayToV' || debts(eddiesRow).owesV === 0)) { next = item.next; choice = item.id; break; }
      }
      if (!next && whole(gameSeconds) && whole(at) && stage.timeout && gameSeconds >= at + stage.timeout.gameHours * HOUR) { next = stage.timeout.next; choice = 'timeout'; }
      if (!next && !stage.choices && !stage.timeout && typeof stage.next === 'string' && entry.presented) { next = stage.next; choice = 'next'; }
      if (!next) break;
      this.#go(pack, entry, next, gameSeconds, choice);
      moved = true;
    }
    return moved;
  }

  // ---- a turn ------------------------------------------------------------------------------------------------------------------------------

  #packsOf(profileKey) { return [...this.packs.values()].filter(pack => pack.character === profileKey); }
  #active() { return [...this.entries].filter(([, entry]) => entry.status === 'active'); }

  /** Whether the quests and the main story allow a pack in progress to move now (docs section 8, items 2 and 3; a window lets some lines run while untracked). */
  #quietJournal(pack, journalHistory) {
    if (!inventoryComplete(journalHistory)) return false;
    return !blockingQuest(pack, questStates(journalHistory), {tracked: trackedPathOf(journalHistory)});
  }

  /** The quest facts the game reported (bridge/quest-facts.mjs): read only when a gate asks, at most every few seconds. Never throws. */
  #facts() {
    try { return this.readFacts ? this.readFacts() : null; } catch { return null; }
  }

  /**
   * The turn's pack decision, made once per request id: {note, story, evaluate, pack, entry, start} or null (packs are not in this turn). Never throws.
   * `facts`: {level (the bond level), romance}. A context that is built twice for one turn gets the same answer.
   */
  forTurn(input, facts = {}) {
    const id = turnId(input);
    if (id && this.turns.has(id)) return this.turns.get(id);
    let decision = null;
    try { decision = this.#decide(input, facts); } catch (error) { this.log(`turn failed: ${String(error?.message ?? error).slice(0, 120)}`); }
    if (id) {
      this.turns.set(id, decision);
      while (this.turns.size > 64) this.turns.delete(this.turns.keys().next().value);
    }
    return decision;
  }

  /** What a private turn of V's tells the runner about the character and the save (for the reach-outs): the clock, the last talk, the romance, the journal. No file, no timer. */
  #observe(input, facts, gameSeconds) {
    if (input.journalHistory) this.lastJournal = input.journalHistory;
    if (!whole(gameSeconds)) return;
    const meta = this.#meta(input.profileKey);
    // Kept in memory every turn, written with the next change (a talk a game hour apart or more).
    if (meta.talkedAt === null || Math.abs(gameSeconds - meta.talkedAt) >= HOUR) this.#schedule();
    meta.talkedAt = gameSeconds;
    const romance = facts.romance === 'partner' || facts.romance === 'casual' ? facts.romance : null;
    if (facts.romance !== undefined && meta.romance !== romance) { meta.romance = romance; this.#schedule(); }
  }

  /** Developer mode only: why a pack did not start for a character on this turn, once per pack per game day ("panam-sunset-coffee waits: q307_before_tomorrow still active"). Never throws. */
  #waits(key, gameSeconds, text) {
    try {
      if (typeof this.explain !== 'function' || this.explain() !== true) return;
      const day = whole(gameSeconds) ? Math.floor(gameSeconds / DAY) : -1;
      if (this.explained.get(key) === day) return;
      this.explained.set(key, day);
      this.log(`${key} waits: ${text}`);
    } catch {}
  }

  /** "panam-palmer" -> "Panam Palmer" (a lasting line from another character says who it is from). */
  #nameOf(key) { return String(key).split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' '); }

  #decide(input, facts) {
    const bonds = input?.bonds;
    if (!bonds?.on || !bonds.packs || input.reaction || input.head || input.event) return null;
    const reachBefore = this.settings.reach;
    this.on = true;
    this.settings.reach = bonds.reach === true;
    if (reachBefore !== this.settings.reach) this.#schedule();
    const profile = input.profileKey, channel = channelOf(input);
    const mine = this.#packsOf(profile);
    const gameSeconds = Number.isSafeInteger(input.turnContext?.gameTime) && input.turnContext.gameTime >= 0 ? input.turnContext.gameTime : undefined;
    this.rewind(gameSeconds);
    if (gameSeconds !== undefined) this.lastClock = gameSeconds;
    this.#observe(input, facts, gameSeconds);
    const meta = this.meta.get(profile);
    const lines = [];
    // What the character keeps from a pack that ended in the last days (talk: any private channel, the game's own copy of the character too).
    for (const pack of mine) {
      const entry = this.entries.get(pack.id);
      if (entry?.status !== 'done' || !whole(gameSeconds)) continue;
      const last = entry.trail.at(-1);
      if (whole(last.at) && gameSeconds >= last.at && gameSeconds - last.at <= ENDING_NOTE_DAYS * DAY) lines.push(`Something you remember about V: ${pack.endings[last.stage].memory}`);
    }
    // What the two of them have been through, kept for good (a lasting line per ending that has one, the newest few), and what other characters told this one about V.
    const past = (meta?.history ?? []).filter(item => !whole(gameSeconds) || item.at === null || item.at <= gameSeconds + ROLLBACK_SLACK).slice(-HISTORY_NOTE);
    const own = past.filter(item => !item.from), told = past.filter(item => item.from);
    if (own.length) lines.push(`What you and V have been through together: ${own.map(item => item.text).join(' ')}`);
    if (told.length) lines.push(`What you have heard about V from the people around you: ${told.map(item => `${this.#nameOf(item.from)} said: ${item.text}`).join(' ')}`);
    // A reach-out of this character's that V is now answering: its note rides on this turn and the next two.
    if (meta?.reachNote) {
      lines.push(meta.reachNote.text);
      meta.reachNote.left -= 1;
      if (meta.reachNote.left <= 0) meta.reachNote = null;
      this.#schedule();
    }
    const allowed = CHANNELS.includes(channel);
    const decision = {note: '', story: null, evaluate: false, pack: null, entry: null, start: null, gameSeconds, channel, eddiesRow: input.eddies?.row ?? null, gap: null};
    if (!mine.length) {
      decision.note = lines.join('\n');
      return decision.note ? decision : null;
    }
    const activeRow = mine.map(pack => [pack, this.entries.get(pack.id)]).find(([, entry]) => entry?.status === 'active');
    if (activeRow && allowed) {
      const [pack, entry] = activeRow;
      // The story reached the quest this pack waits for to end (Jackie: The Heist): the pack ends unfinished, whatever else is going on.
      const stop = pack.unfinishedWhen;
      if (stop && inventoryComplete(input.journalHistory) && finished(questState(input.journalHistory, stop.finished))) this.#go(pack, entry, stop.ending, gameSeconds, 'unfinished');
      // Paused (no new stage, no timer) while the character has a quest of their own going, the story is at its end, or the game is busy.
      const paused = entry.status === 'active' && (bonds.busy === true || !this.#quietJournal(pack, input.journalHistory));
      if (!paused) {
        decision.evaluate = entry.presented === true;
        this.#resolve(pack, entry, {gameSeconds, eddiesRow: decision.eddiesRow});
        if (entry.status === 'active') {
          const stage = this.#stageOf(pack, entry);
          decision.pack = pack; decision.entry = entry;
          // A stage reached just now was not shown yet, so V's words this turn do not answer it.
          if (!entry.presented) decision.evaluate = false;
          lines.unshift(this.#stageNote(pack, stage, {channel, settings: {invitations: bonds.invitations === true}}, entry));
          if (entry.gap && pack.gaps?.[entry.gap.id]) decision.gap = {id: entry.gap.id, tags: pack.gaps[entry.gap.id].tags ?? []};
          decision.story = this.#storyFacts(pack, stage, entry, {channel, gameSeconds, eddies: bonds.eddies === true});
        } else {
          const last = entry.trail.at(-1);
          lines.push(`Something you remember about V: ${pack.endings[last.stage].memory}`);
        }
      }
    } else if (!activeRow && allowed && !input.group && whole(gameSeconds)) {
      const start = this.#tryStart(mine, input, {channel, gameSeconds, level: facts.level ?? 0, romance: facts.romance ?? null});
      if (start) {
        decision.start = start; decision.pack = start.pack;
        lines.unshift(`${start.pack.start.bringUp} ${this.#stageNote(start.pack, start.pack.stages[0], {channel, settings: {invitations: bonds.invitations === true}}, null, start.variation)}`);
        decision.story = this.#storyFacts(start.pack, start.pack.stages[0], null, {channel, gameSeconds, eddies: bonds.eddies === true});
      }
    } else if (!activeRow) {
      this.#waits(profile, gameSeconds, !allowed ? `${channel} never starts a pack (a pack starts on one of V's own copies, a phone chat or a holocall)` : input.group ? 'a group round never starts a pack' : 'the game clock is not known yet');
    }
    decision.note = lines.join('\n');
    return decision;
  }

  /** The id of the variation a hangout runs next: the one after the last used (never the same twice in a row), the first the first time. */
  #nextVariation(pack, meta) {
    const list = pack.hangout?.variations ?? [];
    if (!list.length) return null;
    const last = list.findIndex(item => item.id === meta.hangouts[pack.id]?.variation);
    return list[last >= 0 ? (last + 1) % list.length : 0].id;
  }

  #tryStart(mine, input, {channel, gameSeconds, level, romance}) {
    const profile = input.profileKey, meta = this.#meta(profile);
    if (this.#active().length >= MAX_ACTIVE) { this.#waits(profile, gameSeconds, `${MAX_ACTIVE} quests are already running`); return null; }
    const today = Math.floor(gameSeconds / DAY);
    // A reach-out sent a pack's offer: that pack starts on this talk without the dice and the quiet days (its gate still applies). It expires after a game day.
    const offer = meta.offer && gameSeconds >= meta.offer.at && gameSeconds - meta.offer.at <= OFFER_HOURS * HOUR ? meta.offer : null;
    if (meta.offer && !offer) { meta.offer = null; this.#schedule(); }
    const quiet = meta.endedAt !== null && gameSeconds - meta.endedAt < COOLDOWN_DAYS * DAY;
    const finishedPacks = new Set([...this.entries].filter(([id, entry]) => entry.status === 'done' && this.packs.get(id)?.character === profile).map(([id]) => id));
    const bonds = input.bonds;
    // Story packs first, then hangouts; the pack an offer names comes before both.
    const ordered = [...mine.filter(pack => pack.id === offer?.pack), ...mine.filter(pack => pack.id !== offer?.pack && pack.kind !== 'hangout'), ...mine.filter(pack => pack.id !== offer?.pack && pack.kind === 'hangout')];
    for (const pack of ordered) {
      const hangout = pack.kind === 'hangout', offered = offer?.pack === pack.id, entry = this.entries.get(pack.id);
      if (hangout) {
        // At most one a game day per character; a finished one comes back after repeatDays game days.
        if (meta.hangoutDay === today) { this.#waits(pack.id, gameSeconds, 'a hangout already ran today'); continue; }
        const repeat = (pack.hangout?.repeatDays ?? HANGOUT_DEFAULTS.repeatDays) * DAY;
        if (entry && !(entry.status === 'done' && whole(entry.trail.at(-1).at) && gameSeconds >= entry.trail.at(-1).at + repeat)) { this.#waits(pack.id, gameSeconds, 'played not long ago'); continue; }
      } else if (entry || (quiet && !offered)) { this.#waits(pack.id, gameSeconds, entry ? `already ${entry.status === 'done' ? 'played' : 'running'}` : `quiet days after the last quest (${COOLDOWN_DAYS} game days)`); continue; }
      if (!offered && meta.rolled === today) { this.#waits(pack.id, gameSeconds, 'the dice already rolled today'); continue; }
      const gate = packGate(pack, {level, journalHistory: input.journalHistory, romance, channel, finishedPacks, busy: bonds.busy === true,
        settings: {eddies: bonds.eddies === true, invitations: bonds.invitations === true}, facts: pack.requires?.facts ? this.#facts() : null});
      if (!gate.open) { this.#waits(pack.id, gameSeconds, explainGate(gate, pack, {level, channel, romance})); continue; }
      // The dice are thrown once a game day per character, only when a pack could start.
      if (!offered) {
        meta.rolled = today; this.#schedule();
        if (this.random() >= pack.start.chance) { this.#waits(pack.id, gameSeconds, `the dice said no today (chance ${pack.start.chance})`); return null; }
      }
      return {pack, offered, restart: !!entry, variation: hangout ? this.#nextVariation(pack, meta) : null};
    }
    return null;
  }

  /** The words the character is given for a stage. Second person, no pack or stage talk. A hangout's variation adds its own know and wants. */
  #stageNote(pack, stage, {channel, settings}, entry = null, variationId = entry?.variation ?? null) {
    const variation = variationId ? pack.hangout?.variations?.find(item => item.id === variationId) : null;
    const parts = [`What is going on between you and V right now (your own story with V, never call it a story, a quest or a stage): ${stage.know}${variation?.know ? ` ${variation.know}` : ''}`];
    if (stage.wants || variation?.wants) parts.push(`What you want from V: ${[stage.wants, variation?.wants].filter(Boolean).join(' ')}`);
    if (stage.meet) {
      parts.push(settings.invitations || pack.requires?.invitations !== true
        ? `You would like V to meet you ${WHERE[stage.meet.where]}, within about ${stage.meet.inGameHours} game hours. V arranges it with you in V's own words.`
        : 'You would like to meet V, but meetings cannot be arranged now: say you will sort it out yourself.');
    }
    if (stage.ask && channel !== 'own') parts.push('Eddies can only change hands when V is with you in person: if V offers money, say V should come to you.');
    const gap = entry?.gap ? pack.gaps?.[entry.gap.id] : null;
    if (gap) {
      // An open talk gap: the script has paused on a question to V. One short note, never longer than the limit.
      const note = [`You have just asked V: "${gap.asks}"`, `What you know now: ${gap.know}`, gap.secret ? `You have not told V yet, and may keep it to yourself: ${gap.secret}` : '', gap.wants ? `What you want from V: ${gap.wants}` : '']
        .filter(Boolean).join(' ');
      parts.push(note.slice(0, 700));
    }
    return parts.join(' ');
  }

  /** What Eddies is told for a stage that asks for eddies or pays them back (in person with an own copy only, where Eddies runs). */
  #storyFacts(pack, stage, entry, {channel, gameSeconds, eddies}) {
    if (channel !== 'own' || !eddies || (!stage.ask && !stage.repay)) return null;
    const due = !!stage.repay && (!entry || entry.beat === null || !whole(gameSeconds) || gameSeconds - entry.beat >= DAY);
    return {tag: `${pack.id}:${stage.id}`, ...(stage.ask ? {ask: stage.ask} : {}), ...(stage.repay ? {repay: {part: stage.repay.part, due}} : {})};
  }

  /**
   * A reply was published: start the pack the turn brought up, or read V's words against the stage's choices. `userText`: the spoken transcript when
   * there is one; `proposal`: the Eddies proposal of the turn (a stage with money waits for the ledger instead of answering by words). Never throws.
   */
  afterTurn(input, userText, proposal = null) {
    try {
      const id = turnId(input);
      const decision = id ? this.turns.get(id) : this.forTurn(input);
      if (!decision?.pack) return;
      const {pack, gameSeconds} = decision;
      if (decision.start) {
        const known = this.entries.get(pack.id);
        if (known && (!decision.start.restart || known.status === 'active')) return;
        const variation = decision.start.variation;
        const entry = {status: 'active', trail: [{stage: pack.stages[0].id, at: gameSeconds ?? null}], presented: true, beat: null, ...(variation ? {variation} : {}), ...(CHANNELS.includes(decision.channel) ? {via: decision.channel} : {})};
        this.entries.set(pack.id, entry);
        const meta = this.#meta(pack.character);
        if (pack.kind === 'hangout') {
          if (whole(gameSeconds)) meta.hangoutDay = Math.floor(gameSeconds / DAY);
          if (variation) meta.hangouts[pack.id] = {variation, at: gameSeconds ?? null};
        }
        if (decision.start.offered) meta.offer = null;
        this.#enter(pack, pack.stages[0], gameSeconds);
        this.log(`pack=${pack.id} started on ${decision.channel} (stage ${pack.stages[0].id}${variation ? `, ${variation}` : ''}${decision.start.offered ? ', offered' : ''})`);
        this.#schedule(); this.#effects();
        return;
      }
      const entry = this.entries.get(pack.id);
      if (!entry || entry !== decision.entry || entry.status !== 'active') return;
      const stage = this.#stageOf(pack, entry);
      if (!stage) return;
      const words = typeof userText === 'string' && userText.trim() ? userText : input.text;
      // V offers a gift while the stage waits for one: the game is told V's words (it matches the item V named in V's inventory).
      const give = (stage.do ?? []).find(spec => spec?.p === 'gift' && spec.dir === 'give');
      if (give && screenGift(words).offer) this.#command(pack, entry, {cmd: 'event', name: `gift:${give.id}:offer`, data: {words: giftWords(words)}});
      // An open talk gap: V's words against its tags (the same screens as a choice). A match ends the gap, tells the game and moves a stage that waits on it.
      if (decision.gap && entry.gap?.id === decision.gap.id && decision.gap.tags.length) {
        const kind = intentKind(words, decision.gap.tags.map(tag => tag.kind));
        const tag = kind ? decision.gap.tags.find(item => item.kind === kind) : null;
        if (tag) { this.#gapTag(pack, entry, decision.gap.id, tag.id, gameSeconds); return; }
      }
      if (decision.story?.repay?.due && proposal?.story === decision.story.tag) { entry.beat = gameSeconds ?? null; this.#schedule(); }
      const moneyTurn = !!proposal?.story;
      if (decision.evaluate && !moneyTurn) {
        const tags = (stage.choices ?? []).filter(choice => choice.on === 'tag');
        const kind = tags.length ? intentKind(words, tags.map(choice => choice.kind)) : null;
        const choice = kind ? tags.find(item => item.kind === kind) : null;
        if (choice) { this.#go(pack, entry, choice.next, gameSeconds, choice.id); return; }
      }
      if (!entry.presented) { entry.presented = true; this.#schedule(); }
    } catch (error) {
      this.log(`record failed: ${String(error?.message ?? error).slice(0, 120)}`);
    }
  }

  // ---- paying a cast member (docs/QUEST_PRIMITIVES.md 10.2) ---------------------------------------------------------------------------------

  /** The armed pay stage a turn's `quest` block ({pack, cast}) points at: {pack, entry, spec} or null. */
  #payStage(quest) {
    if (!quest || typeof quest.pack !== 'string' || typeof quest.cast !== 'string') return null;
    const pack = this.packs.get(quest.pack), entry = this.entries.get(quest.pack);
    if (!pack || entry?.status !== 'active') return null;
    const spec = (this.#stageOf(pack, entry)?.do ?? []).find(item => item?.p === 'pay' && item.to === quest.cast);
    return spec ? {pack, entry, spec} : null;
  }

  /** The note a turn to the cast member of an armed pay stage carries ('' for any other turn). A map lookup; no model, no file. Never throws. */
  payNote(input) {
    try { const found = this.#payStage(input?.quest); return found ? payNote(found.spec) : ''; } catch { return ''; }
  }

  /** A reply to a pay turn was published: V's words are read once (an amount, yes, no) and the offer goes to the game as a command. Never throws. */
  afterPay(input, userText) {
    try {
      const found = this.#payStage(input?.quest);
      if (!found) return false;
      const words = typeof userText === 'string' && userText.trim() ? userText : input.text;
      const data = payData(readPay(words, found.spec));
      if (!data) return false;
      this.#command(found.pack, found.entry, {cmd: 'event', name: `pay:${found.spec.id}:offer`, data});
      this.log(`pack=${found.pack.id} pay ${found.spec.id} offer ${data.declined ? 'declined' : data.amount}`);
      return true;
    } catch (error) { this.log(`pay failed: ${String(error?.message ?? error).slice(0, 120)}`); return false; }
  }

  // ---- offers and reach-outs -------------------------------------------------------------------------------------------------------------------

  /** A reach-out offers a pack (a hangout): the character's next private turn starts it without the dice and the quiet days (the gate still applies). Expires after a game day. */
  offer(packId, gameSeconds) {
    const pack = this.packs.get(packId);
    if (!pack || !whole(gameSeconds)) return false;
    this.#meta(pack.character).offer = {pack: packId, at: gameSeconds};
    this.#schedule(); this.#playChanged();
    return true;
  }

  /** The game delivered reach-out `id` at game time `at`: its cooldown starts, V's answer carries its note for this turn and the next two, an `offer` is made. */
  noteReach(id, at) {
    try {
      const found = this.reach?.noteFired?.(id, whole(at) ? at : this.lastClock);
      if (!found) return false;
      if (whole(at)) this.lastClock = Math.max(this.lastClock ?? 0, at);
      const {character, trigger} = found;
      const note = `You have just reached out to V first, with this message: "${trigger.text}" ${trigger.note ? `What is behind it: ${trigger.note} ` : ''}V's next words are the answer to it. Answer as the one who wrote it, in your own words, and do not repeat the message.`;
      this.#meta(character).reachNote = {text: note.slice(0, 850), left: REACH_NOTE_TURNS, at: whole(at) ? at : null};
      if (trigger.offer) this.offer(trigger.offer, at);
      this.log(`reach=${id} delivered`);
      this.#schedule(); this.#playChanged();
      return true;
    } catch (error) { this.log(`reach failed: ${String(error?.message ?? error).slice(0, 120)}`); return false; }
  }

  /** The bond levels by character for the reach-outs, from the Bonds object; read at most every 30 seconds. */
  #levels() {
    const at = this.now();
    if (at - this.levelCache.at < LEVELS_CACHE_MS) return this.levelCache.value;
    let value = {};
    try {
      const rows = this.levelsOf ? this.levelsOf() : (this.bonds?.characters?.() ?? []).map(row => [row.profileKey, row.level]);
      value = Array.isArray(rows) ? Object.fromEntries(rows) : rows;
    } catch { value = {}; }
    this.levelCache = {at, value};
    return value;
  }

  /** The play file's reach block: {enabled, items, perHour, perDay} (docs/QUEST_PRIMITIVES.md 10.7). */
  #reachBlock() {
    if (!this.reach?.size) return {enabled: false, items: [], perHour: 1, perDay: 3};
    const clock = this.lastClock;
    const busy = new Set();
    for (const [id, entry] of this.entries) if (entry.status === 'active') busy.add(this.packs.get(id).character);
    const talkedAt = {}, romance = {};
    for (const [key, meta] of this.meta) {
      if (meta.offer && whole(clock) && clock - meta.offer.at <= OFFER_HOURS * HOUR) busy.add(key);
      if (meta.talkedAt !== null) talkedAt[key] = meta.talkedAt;
      if (meta.romance) romance[key] = meta.romance;
    }
    const finishedPacks = new Set([...this.entries].filter(([, entry]) => entry.status === 'done').map(([id]) => id));
    const needsFacts = this.reach.requiresList().some(requires => requires.facts);
    return this.reach.eligible({enabled: this.settings.packs && this.settings.reach, gameSeconds: whole(clock) ? clock : null, journalHistory: this.lastJournal,
      facts: needsFacts ? this.#facts() : null, levels: this.#levels(), talkedAt, romance, busy, finishedPacks});
  }

  /** Whether any reach-out may fire now (the poller then reads the events file every 10 seconds). */
  reachWanted() {
    try { return this.#reachBlock().items.length > 0; } catch { return false; }
  }

  /** A meeting's outcome from the game (an appointment event or the greeting at the meeting): 'met' | 'stood-up'. Moves a stage that waits on it. */
  noteMeeting(profileKey, outcome, gameSeconds) {
    if (!this.on) return null;
    try {
      this.rewind(gameSeconds);
      for (const pack of this.#packsOf(profileKey)) {
        const entry = this.entries.get(pack.id);
        if (entry?.status !== 'active') continue;
        const stage = this.#stageOf(pack, entry);
        const choice = stage?.choices?.find(item => item.on === `meet:${outcome}`);
        this.#command(pack, entry, {cmd: 'event', name: `meet:${outcome}`});
        if (choice) { this.#go(pack, entry, choice.next, gameSeconds, choice.id); return choice.id; }
      }
    } catch (error) { this.log(`meeting failed: ${String(error?.message ?? error).slice(0, 120)}`); }
    return null;
  }

  // ---- the quest files (docs/QUEST_PRIMITIVES.md) --------------------------------------------------------------------------------------------

  #command(pack, entry, command) {
    this.commandSeq += 1;
    this.commands.push({seq: this.commandSeq, pack: pack.id, serial: entry.trail.length, ...command});
    while (this.commands.length > COMMANDS_KEEP) this.commands.shift();
    this.#playChanged();
  }

  /** V's words picked a gap's tag: the gap ends, the game is told (the tag's event, then the resume), and a stage waiting on the event moves. */
  #gapTag(pack, entry, gapId, tag, gameSeconds) {
    entry.gap = null;
    this.#command(pack, entry, {cmd: 'event', name: `gap:${gapId}:${tag}`});
    this.#command(pack, entry, {cmd: 'resume', gap: gapId});
    this.log(`pack=${pack.id} gap ${gapId} tag ${tag}`);
    this.#schedule();
    if (!this.#moveOn(pack, entry, `gap:${gapId}:${tag}`, gameSeconds)) this.#moveOn(pack, entry, `gap:${gapId}:resume`, gameSeconds);
    this.#playChanged();
  }

  /** A stage that waits on `event:<name>` moves, else a timeout that has run out may. Returns whether it moved. */
  #moveOn(pack, entry, name, gameSeconds) {
    if (entry.status !== 'active') return false;
    const stage = this.#stageOf(pack, entry);
    const choice = stage?.choices?.find(item => item.on === `event:${name}`);
    if (choice) { this.#go(pack, entry, choice.next, gameSeconds, choice.id); return true; }
    return this.#resolve(pack, entry, {gameSeconds, eddiesRow: null});
  }

  /** The variation a hangout entry runs: {id, know?, wants?, places?} or null. */
  #variationOf(pack, entry) { return entry?.variation ? pack.hangout?.variations?.find(item => item.id === entry.variation) ?? null : null; }

  /** An event name the game reported, in the pack's own place ids (a variation of a hangout may have swapped the places the game was given). */
  #unmap(pack, entry, name) {
    const places = this.#variationOf(pack, entry)?.places;
    if (!places) return name;
    const back = Object.fromEntries(Object.entries(places).map(([from, to]) => [to, from]));
    return remapName(name, back);
  }

  /** A gift event of the current stage: a tier given is used for good, and V's gift is read into the bond (one counted gift per character per game day). */
  #giftEvent(pack, entry, name, gameSeconds) {
    const match = /^gift:([a-z][a-z0-9-]*):(given|second|loved|liked|neutral|disliked)$/.exec(name);
    if (!match) return;
    const spec = (this.#stageOf(pack, entry)?.do ?? []).find(item => item?.p === 'gift' && item.id === match[1]);
    if (!spec) return;
    const meta = this.#meta(pack.character);
    if (match[2] === 'given' || match[2] === 'second') {
      if (spec.dir === 'receive' && spec.tier && !meta.gifts.used.some(item => item.tier === spec.tier)) {
        meta.gifts.used.push({tier: spec.tier, at: gameSeconds ?? null});
        this.#schedule(); this.#playChanged();
      }
      return;
    }
    if (spec.dir !== 'give') return;
    const day = whole(gameSeconds) ? Math.floor(gameSeconds / DAY) : null;
    const counted = day === null || meta.gifts.day !== day;
    if (counted && day !== null) meta.gifts.day = day;
    const points = counted ? giftBond(match[2]) : 0;
    if (points) this.bonds?.award(pack.character, points, gameSeconds);
    this.log(`pack=${pack.id} gift ${match[1]} ${match[2]}${counted ? ` bond ${points > 0 ? '+' : ''}${points}` : ' (not counted: one a game day)'}`);
    this.#schedule();
  }

  /**
   * An event the game saw ({pack, serial, name, at, data}). Opens and closes the talk gap, moves a stage that waits on it, applies a gift's bond and checks the stage's timeout
   * against the event's game clock. An event for another stage (a different serial) is dropped. A `reach` event (pack "reach") starts a reach-out's cooldown. Returns whether the
   * quest moved. Never throws.
   */
  noteEvent({pack: packId, serial, name: rawName, at, data} = {}) {
    try {
      if (packId === 'reach') {
        const match = typeof rawName === 'string' ? /^reach:([a-z][a-z0-9-]{1,31})$/.exec(rawName) : null;
        if (match) this.noteReach(match[1], whole(at) ? at : undefined);
        return false;
      }
      const pack = this.packs.get(packId), entry = this.entries.get(packId);
      if (!pack || entry?.status !== 'active' || typeof rawName !== 'string') return false;
      if (Number.isSafeInteger(serial) && serial !== entry.trail.length) return false;
      const name = this.#unmap(pack, entry, rawName);
      const gameSeconds = whole(at) ? at : undefined;
      if (gameSeconds !== undefined) this.lastClock = Math.max(this.lastClock ?? 0, gameSeconds);
      let match;
      if ((match = /^gap:([a-z][a-z0-9-]*):open$/.exec(name)) && pack.gaps?.[match[1]]) {
        entry.gap = {id: match[1], openedAt: gameSeconds ?? null};
        this.#schedule(); this.#playChanged();
      } else if ((match = /^gap:([a-z][a-z0-9-]*):resume$/.exec(name)) && entry.gap?.id === match[1]) {
        entry.gap = null;
        this.#schedule(); this.#playChanged();
      } else if (name.startsWith('gift:')) this.#giftEvent(pack, entry, name, gameSeconds);
      return this.#moveOn(pack, entry, name, gameSeconds);
    } catch (error) { this.log(`event failed: ${String(error?.message ?? error).slice(0, 120)}`); return false; }
  }

  #pruneClosing() {
    const cutoff = this.now() - CLOSING_MS;
    if (this.closing.some(item => item.at < cutoff)) this.closing = this.closing.filter(item => item.at >= cutoff);
  }

  /** Whether the game has anything to do for the bridge: a play stage, or the closing rows of an ending that just happened. */
  questActive() {
    this.#pruneClosing();
    if (this.closing.length) return true;
    for (const [id, entry] of this.entries) {
      if (entry.status !== 'active') continue;
      const stage = this.#stageOf(this.packs.get(id), entry);
      if (stage?.do || stage?.script) return true;
    }
    return false;
  }

  /** The lines (with their text, emotion, channel) and pictures a list of references names, in the shape of the play file. */
  #lineTables(pack, refs) {
    const lines = {}, images = {};
    for (const id of refs.lines) {
      const line = pack.lines?.[id];
      if (!line) continue;
      lines[id] = {emotion: line.emotion ?? 'neutral', ...(line.gesture ? {gesture: line.gesture} : {}), channel: line.channel ?? 'own', text: line.text};
    }
    for (const key of refs.images) {
      const image = pack.images?.[key];
      if (!image) continue;
      const slug = `${pack.id}_${key}`.replace(/-/g, '_');
      const name = slug.length <= 48 ? slug : key.replace(/-/g, '_');
      images[key] = {atlas: `cyberpunk_convai\\phone_images\\${name}.inkatlas`, part: name, width: image.width, height: image.height};
    }
    return {lines, images};
  }

  /** The stage's `do` as the game gets it: gifts the character gives carry the item the tables resolved, and a hangout variation's place swaps are applied. */
  #doFor(pack, entry, stage) {
    const meta = this.meta.get(pack.character);
    const used = (meta?.gifts.used ?? []).map(item => item.tier);
    const places = this.#variationOf(pack, entry)?.places;
    return (stage.do ?? []).map(spec => {
      let out = spec;
      if (spec?.p === 'gift' && spec.dir === 'receive') {
        const given = spec.tier ? resolveGive(pack.character, spec.tier, {used}) : null;
        // Kerry's legendary is a car (the garage primitive): a gift of that tier hands over its second thing instead, the item until the car's record is known.
        const item = spec.item ?? given?.item ?? given?.second ?? null;
        const second = spec.second ?? (given?.item ? given.second : null);
        // Each tier is given once per save: a used tier (or one the character has none for) is not offered, and the stage hears gift:<id>:failed from the game.
        out = {...spec, ...(item ? {item} : {unavailable: spec.tier && used.includes(spec.tier) ? 'tier-used' : 'no-item'}), ...(second && item ? {second} : {})};
      }
      return places ? remapSpec(out, places) : out;
    });
  }

  /** The play file's content (docs/QUEST_PRIMITIVES.md section 4), computed from the state. */
  playState() {
    this.#pruneClosing();
    const quests = [];
    const requiresList = [...this.packs.values()].map(pack => pack.requires);
    for (const [id, entry] of this.entries) {
      if (entry.status !== 'active') continue;
      const pack = this.packs.get(id), stage = this.#stageOf(pack, entry);
      if (!stage || (!stage.do && !stage.script)) continue;
      const last = entry.trail.at(-1);
      const places = {}, swap = this.#variationOf(pack, entry)?.places;
      const doList = this.#doFor(pack, entry, stage);
      const script = swap ? (stage.script ?? []).map(row => remapRow(row, swap)) : stage.script ?? [];
      const refs = referencesOf(script);
      // The calls the stage's call-in / call-script entries name, and the lines their steps (and the opening text) name: the game plays them from the play file.
      const calls = {};
      for (const spec of doList) {
        const call = (spec?.p === 'call-in' || spec?.p === 'call-script') ? pack.calls?.[spec.call] : null;
        if (!call) continue;
        calls[spec.call] = {caller: call.caller ?? 'self', picture: call.picture ?? 'live', ...(call.text ? {text: call.text} : {}), ...(call.onHangUp ? {onHangUp: call.onHangUp} : {}), steps: call.steps};
        if (call.text) refs.lines.add(call.text);
        for (const step of call.steps) if (typeof step.say === 'string') refs.lines.add(step.say);
        for (const step of call.steps) if (typeof step.gap === 'string') refs.gaps.add(step.gap);
      }
      const soundPlaces = (stage.sfx ?? []).filter(item => typeof item?.at === 'string' && item.at.startsWith('place:')).map(item => ({at: item.at.slice(6)}));
      for (const key of placesOf([...doList, ...soundPlaces])) {
        const place = pack.places?.[key];
        if (place) places[key] = {name: place.name, radius: place.radius ?? 25, ...(place.district ? {district: place.district} : {}),
          ...(Number.isFinite(place.x) && Number.isFinite(place.y) && Number.isFinite(place.z) ? {x: place.x, y: place.y, z: place.z} : {})};
      }
      const gaps = {};
      for (const key of refs.gaps) {
        const gap = pack.gaps?.[key];
        if (gap) gaps[key] = {...(gap.idle ? {idle: gap.idle} : {}), ...(gap.situation ? {situation: gap.situation} : {}), ...(gap.resumeAfterSeconds ? {resumeAfterSeconds: gap.resumeAfterSeconds} : {}),
          ...(gap.resumeOn ? {resumeOn: swap ? gap.resumeOn.map(name => remapName(name, swap)) : gap.resumeOn} : {})};
      }
      const timeoutAt = stage.timeout && whole(last.at) ? last.at + stage.timeout.gameHours * HOUR : undefined;
      const gifts = doList.some(spec => spec?.p === 'gift' && spec.dir === 'give') ? likesFor(pack.character) : null;
      quests.push({pack: id, character: pack.character, stage: stage.id, serial: entry.trail.length, since: last.at, places, do: doList, script,
        ...this.#lineTables(pack, refs), gaps, gap: entry.gap ?? null, ...(timeoutAt !== undefined ? {timeoutAt} : {}), ...(entry.via ? {via: entry.via} : {}),
        ...(Object.keys(calls).length ? {calls} : {}), ...(stage.music ? {music: swap ? remapSounds(stage.music, swap) : stage.music} : {}),
        ...(stage.sfx ? {sfx: swap ? remapSounds(stage.sfx, swap) : stage.sfx} : {}), ...(stage.situation ? {situation: stage.situation} : {}), ...(gifts ? {gifts} : {})});
    }
    const closing = this.closing.map(item => ({pack: item.pack, character: item.character, ending: item.ending, serial: item.serial, script: item.script, lines: item.lines, images: item.images}));
    const known = new Set(quests.map(quest => quest.pack));
    return {version: 1, revision: this.playRev, quests, closing, commands: this.commands.filter(command => known.has(command.pack)),
      factsWanted: wantedFacts([...requiresList, ...(this.reach?.requiresList?.() ?? [])]), reach: this.#reachBlock()};
  }

  /** Bumps the play file's revision when what the game should be told changed. */
  #playChanged() {
    const body = JSON.stringify({...this.playState(), revision: 0});
    if (body === this.playText) return false;
    this.playText = body; this.playRev += 1;
    this.bonds?.publish?.();
    return true;
  }

  playRevision() { this.#playChanged(); return this.playRev; }

  /**
   * A scripted line for the bridge to say ({pack, line}): its text, the path of its prepared audio (null when the file is not there), its emotion, gesture, channel and
   * speaker. Only for a quest that is running or ended in the last minutes, null for anything else. The path never leaves the pack's own folder.
   */
  lineFor(packId, lineId) {
    this.#pruneClosing();
    const pack = this.packs.get(packId);
    if (!pack || typeof lineId !== 'string') return null;
    if (this.entries.get(packId)?.status !== 'active' && !this.closing.some(item => item.pack === packId)) return null;
    const line = pack.lines?.[lineId];
    if (!line) return null;
    let audioPath = null;
    if (line.audio) {
      const root = resolvePath(this.packFolder, packId), file = resolvePath(root, line.audio);
      if (file.startsWith(root + sep) && this.exists(file)) audioPath = file;
    }
    return {text: line.text, audioPath, emotion: line.emotion ?? 'neutral', gesture: line.gesture ?? null, channel: line.channel ?? 'own', speaker: line.speaker ?? pack.character};
  }

  /** Forget (the memory reset): the lasting history lines of these characters, or of all. */
  forgetHistory({all = false, profileKeys = []} = {}) {
    let removed = 0;
    for (const [key, row] of this.meta) {
      if ((all || profileKeys.includes(key)) && row.history?.length) { removed += row.history.length; row.history = []; }
    }
    if (removed) { this.#schedule(); this.#playChanged(); }
    return removed;
  }

  // ---- what the game is told ----------------------------------------------------------------------------------------------------------------

  /** The effects the game acts on, from the state (docs 7.4): a personal car that is not offered, an outfit for the stage, one-shot items. */
  effects() {
    const blocked = [], outfits = [], items = [];
    for (const [id, entry] of this.entries) {
      const pack = this.packs.get(id);
      if (!pack) continue;
      const last = entry.trail.at(-1);
      const recent = entry.status === 'active' || (whole(last.at) && this.lastClock !== undefined && this.lastClock - last.at <= DAY);
      let block = null;
      entry.trail.forEach((step, index) => {
        if (step.ending) return;
        const stage = pack.stages.find(item => item.id === step.stage);
        for (const effect of stage?.effects ?? []) {
          if (effect.kind === 'vehicleBlocked') block = {profileKey: pack.character, pack: id, since: step.at};
          else if (effect.kind === 'vehicleReturned') block = null;
          else if ((effect.kind === 'giveItem' || effect.kind === 'takeItem') && recent) {
            items.push({id: `${id}:${step.stage}:${index}`, kind: effect.kind, profileKey: pack.character, pack: id, record: effect.record, quantity: effect.quantity ?? 1, since: step.at});
          }
        }
      });
      if (entry.status === 'active') {
        if (block) blocked.push(block);
        const stage = this.#stageOf(pack, entry);
        if (stage?.effects?.some(effect => effect.kind === 'outfit')) outfits.push({profileKey: pack.character, pack: id, since: last.at});
      }
    }
    return {version: 1, blocked, outfits, items};
  }

  #effects() {
    this.#playChanged();
    const body = this.effects();
    const text = JSON.stringify(body);
    if (text === this.effectsText) return;
    this.effectsText = text; this.effectsRevision += 1;
    if (this.effectsPath) {
      const out = JSON.stringify({...body, revision: this.effectsRevision});
      this.effectsChain = this.effectsChain.then(() => this.write(this.effectsPath, out)).catch(error => {
        this.log(`effects not written: ${String(error?.message ?? error).slice(0, 120)}`);
      });
    }
    this.bonds?.publish?.();
  }

  /** For the status file (bridge/bonds.mjs packSource): the active packs by character, the rows of a character's packs, and the effects revision. */
  source() {
    const rowsOf = profileKey => this.#packsOf(profileKey).flatMap(pack => {
      const entry = this.entries.get(pack.id);
      if (!entry) return [];
      const last = entry.trail.at(-1);
      if (entry.status === 'done') return [{id: pack.id, title: pack.title, state: 'done', label: '', ending: last.stage}];
      const stage = this.#stageOf(pack, entry);
      return [{id: pack.id, title: pack.title, state: 'active', label: stage?.label ?? pack.summary ?? '', ending: null}];
    });
    return {
      active: () => {
        const out = {};
        for (const [id, entry] of this.entries) {
          if (entry.status !== 'active') continue;
          const pack = this.packs.get(id);
          out[pack.character] = {id, title: pack.title, stage: entry.trail.at(-1).stage};
        }
        return out;
      },
      list: rowsOf,
      effectsRevision: () => this.effectsRevision,
      playRevision: () => this.playRevision(),
    };
  }
}
