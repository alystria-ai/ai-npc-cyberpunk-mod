// Story packs, running (docs/RELATIONSHIPS_AND_QUESTS.md section 7.3): Settings > Companions > Story packs, off by default, on top of Character bonds.
//
// A pack is a short arc of one character (bridge/bond-packs.mjs holds the format and the plot-safety gate). This file plays it:
//   START   on a private turn of V's (in person with one of V's own copies, Phone Chat, a holocall), when the gate is open and the dice say so: that turn's
//           volatile note carries the pack's `bringUp` and the first stage's `know` and `wants`. Nothing starts from a timer, so no turn is spent that V did not start.
//   NOTES   every later turn on a channel the pack allows carries the current stage (`know`, `wants`, the meeting it hopes for, the money it needs).
//   CHOICES a stage ends by V's own words (bridge/bond-intent.mjs, read after the reply is published: no model call, no tag in a reply), by an Eddies transfer
//           with the pack as its story (the ledger row of the next turn says it was done), by the outcome of a meeting (appointment events) or by an event the game saw.
//   NO TIME LIMIT (owner decision 1 Nov 2026) a stage has no timer and no clock: a quest stays open until V does it, says no, or abandons it (words, or the game's quest:abandon).
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
import {intentKind, screenAbandon} from './bond-intent.mjs';
import {debts} from './eddies.mjs';
import {channelOf, bondable} from './bonds.mjs';
import {QUEST_NEAR_NOTE} from './turn-context.mjs';
import {questStates, questState, finished, inventoryComplete} from './bonds.mjs';
import {placesOf, referencesOf} from './quest-format.mjs';
import {ReachOuts} from './reach-outs.mjs';
import {wantedFacts} from './quest-facts.mjs';
import {resolveGive, likesFor, giftBond, TIERS} from './gift-tables.mjs';
import {screenGift, giftWords} from './gift-intent.mjs';
import {payNote, readPay, payData} from './quest-pay.mjs';
import {inPerson, rendezvousSpecs} from './quest-rendezvous.mjs';
import {journalBlock} from './quest-journal.mjs';
import {startAllowed, WITHDRAWN_DAYS} from './quest-start.mjs';

const DAY = 86400, HOUR = 3600;
/** The event the game raises when V abandons a quest (mod/quest-play.lua abandonQuest). */
export const QUEST_ABANDON = 'quest:abandon';
/** Game seconds of slack before an entry counts as later than the loaded save (the clock read and the stamp are a moment apart). */
export const ROLLBACK_SLACK = 120;
export const MAX_ACTIVE = 2;
export const COOLDOWN_DAYS = 7;
/**
 * The dice of a pack start. They used to be thrown once per game day per character, so one lost roll silenced the character for the whole day, and a player who
 * talked to Panam for an hour with the gate open could still never be invited (live test 30 Oct). Now an eligible private turn (the gate of some pack is open)
 * rolls at the pack's `start.chance`, but only every ROLL_EVERY_TURNS eligible turns (a long talk is a few chances, not one per sentence) and at most
 * DAILY_ROLLS rolls per character per game day (never on every turn). Raised on 31 Oct 2026 by the owner from every 3rd turn and 3 rolls, which felt too rare: at a
 * chance of 0.35 a day of talk with the gate open now starts the quest about 9 times in 10, about 6 in 10 within the first three talks. Spam is held down further by the quiet days after a quest (COOLDOWN_DAYS), one hangout a game day and MAX_ACTIVE.
 */
export const DAILY_ROLLS = 5, ROLL_EVERY_TURNS = 2;
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
   * explain   () -> true while Developer mode is on: every private turn logs one line that says whether a pack started and why not (gate, channel, party, cooldown, chance), and a pack
   *            that waits also says why once per pack per game day
   */
  constructor({packs = shippedOrNone(), characters = null, path = null, effectsPath = null, bonds = null, random = Math.random,
    now = Date.now, read = file => readFile(file, 'utf8'), write = (file, text) => atomicFile(file, text), log = () => {}, debounceMs = 5000,
    packFolder = SHIPPED_PACK_FOLDER, exists = file => existsSync(file), readFacts = null, reach = undefined, levelsOf = null, explain = null, fast = false,
    timers = {set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle)}} = {}) {
    Object.assign(this, {path, effectsPath, bonds, random, now, read, write, log, debounceMs, timers, characters, packFolder, exists, readFacts, levelsOf, explain});
    // Development only (bridge/story-packs-gate.mjs storyPacksFast): no quiet days, no daily rolls, a start chance of 1. Said once, here.
    this.fast = fast === true;
    if (this.fast) log('dev fast mode (story-packs-dev-fast.flag): a pack whose gate is open starts on the next eligible turn, with no quiet days, no daily rolls and a start chance of 1');
    this.explained = new Map();    // pack id (or profile key) -> the game day its reason was last logged
    this.turnNotes = null;         // while a turn is decided in Developer mode: the reasons its packs gave, for the turn's one line
    this.noted = new Set();            // turn ids whose "no pack decision" line was said
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
    this.remoteTurn = false;       // true while V's words over the phone or a holocall (she is not beside V) move a pack: a stage that needs her in person gets the means of getting her to V
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
    return {rolled: null, rolls: 0, idle: ROLL_EVERY_TURNS - 1, endedAt: null, history: [], talkedAt: null, romance: null, hangoutDay: null, cap: null, gifts: {used: [], day: null}, reachNote: null, offer: null, hangouts: {}, withdrawn: {}};
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
    meta.rolls = whole(row.rolls) ? Math.min(row.rolls, DAILY_ROLLS) : 0;
    meta.idle = whole(row.idle) ? Math.min(row.idle, ROLL_EVERY_TURNS) : ROLL_EVERY_TURNS - 1;
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
    if (plain(row.withdrawn)) for (const [id, at] of Object.entries(row.withdrawn)) if (/^[a-z][a-z0-9-]{2,47}$/.test(id) && whole(at)) meta.withdrawn[id] = at;
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
      trail.push({stage: step.stage, at: step.at, ...(typeof step.choice === 'string' ? {choice: step.choice.slice(0, 40)} : {}), ...(step.ending === true ? {ending: true} : {}), ...(step.remote === true ? {remote: true} : {})});
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
        meta[key] = {rolled: row.rolled, rolls: row.rolls, idle: row.idle, endedAt: row.endedAt, ...(row.history?.length ? {history: row.history} : {}), ...(row.talkedAt !== null ? {talkedAt: row.talkedAt} : {}),
          ...(row.romance ? {romance: row.romance} : {}), ...(row.hangoutDay !== null ? {hangoutDay: row.hangoutDay} : {}), ...(row.cap ? {cap: row.cap} : {}),
          ...(row.gifts.used.length || row.gifts.day !== null ? {gifts: row.gifts} : {}), ...(row.reachNote ? {reachNote: row.reachNote} : {}), ...(row.offer ? {offer: row.offer} : {}),
          ...(Object.keys(row.hangouts).length ? {hangouts: row.hangouts} : {}), ...(Object.keys(row.withdrawn).length ? {withdrawn: row.withdrawn} : {})};
      }
      if (await this.write(this.path, JSON.stringify({version: 1, entries, meta, settings: this.settings, reach: this.reach?.toJSON?.() ?? {}})) === false) this.dirty = true;
    } catch (error) {
      this.dirty = true;
      this.log(`could not save (${String(error?.message ?? error).slice(0, 120)})`);
    }
  }

  /** The state keeps the pack ids only; the stage the entry is at is the last step of its trail. */
  #stageOf(pack, entry) { const last = entry.trail.at(-1); return entry.status === 'active' ? pack.stages.find(stage => stage.id === last.stage) : null; }
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
      if (row.rolled !== null && row.rolled > limitDay) { row.rolled = null; row.rolls = 0; changed = true; }
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
      // A stage that needs her in person, entered by V's words over the phone with her far away: the play file adds the means of getting her to V (bridge/quest-rendezvous.mjs).
      const remote = this.remoteTurn && inPerson(pack, stage).needs;
      entry.trail.push({stage: next, at: gameSeconds ?? null, ...(choice ? {choice} : {}), ...(remote ? {remote: true} : {})});
      entry.presented = false; entry.beat = null; entry.gap = null;
      this.log(`pack=${pack.id} stage=${next}${choice ? ` via ${choice}` : ''}`);
      this.#dev(`pack=${pack.id} stage ${next}: no time limit, it stays open until V does it, says no or abandons it`);
      this.#enter(pack, stage, gameSeconds);
      if (!stage.type || KNOWN_STAGE_TYPES.includes(stage.type)) break;
      // A stage type this build does not play: skipped, logged once per type, on to its skip, next or first choice.
      if (!this.loggedTypes.has(stage.type)) { this.loggedTypes.add(stage.type); this.log(`stage type ${stage.type} is not played yet: skipped (pack ${pack.id})`); }
      next = stage.skip ?? stage.next ?? stage.choices?.[0]?.next;
      choice = 'skipped';
      if (typeof next !== 'string') { this.#finish(pack, entry, Object.keys(pack.endings)[0], gameSeconds, choice); break; }
    }
    this.#schedule(); this.#effects();
  }

  /** Developer mode only: one line of the story pack's start and why (never a clock: a quest has no time limit). Never throws. */
  #dev(line) {
    try { if (typeof this.explain === 'function' && this.explain() === true) this.log(`[dev] ${line}`); } catch {}
  }

  /**
   * V gives a quest up (by telling the character, or from the journal). There is no time limit, so this is the only way a quest closes without V doing it. It ends with no bond
   * change and no quiet days, leaves the journal (the next play file has no row for it) and is not offered again for a game day. Returns whether a quest was open.
   */
  abandon(packId, {gameSeconds, why = 'V gave it up'} = {}) {
    try {
      const pack = this.packs.get(packId), entry = this.entries.get(packId);
      if (!pack || entry?.status !== 'active') return false;
      this.entries.delete(pack.id);
      const meta = this.#meta(pack.character);
      const clock = whole(gameSeconds) ? gameSeconds : this.lastClock;
      if (whole(clock)) meta.withdrawn[pack.id] = clock;
      this.log(`pack=${pack.id} abandoned, no bond change (${why})`);
      this.#dev(`pack=${pack.id} abandoned: the journal entry, the tracker line and the map pin go with the next play file`);
      this.#schedule(); this.#effects();
      return true;
    } catch (error) { this.log(`abandon failed: ${String(error?.message ?? error).slice(0, 120)}`); return false; }
  }

  /** Whatever ends the current stage by itself: a finished Eddies transfer of the pack, or a closing beat already shown. There is no timer. Returns whether it moved. */
  #resolve(pack, entry, {gameSeconds, eddiesRow}) {
    let moved = false;
    for (let step = 0; step < MAX_STEPS && entry.status === 'active'; step++) {
      const stage = this.#stageOf(pack, entry);
      const tag = `${pack.id}:${stage.id}`;
      let next = null, choice = null;
      for (const item of stage.choices ?? []) {
        if (!item.on.startsWith('eddies:')) continue;
        const flow = item.on.slice(7), last = eddiesRow?.last;
        if (last?.story === tag && last.flow === flow && last.result === 'done' && (flow !== 'repayToV' || debts(eddiesRow).owesV === 0)) { next = item.next; choice = item.id; break; }
      }
      if (!next && !stage.choices && typeof stage.next === 'string' && entry.presented) { next = stage.next; choice = 'next'; }
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
    try {
      decision = this.#decide(input, facts);
      // She is beside V (the game's snapshot): a quest's invitation or a reach-out's note must not tell her to ask V to come over (facts.near, bridge/turn-context.mjs besideV).
      if (facts.near === true && decision?.note) decision.note = `${decision.note}\n${QUEST_NEAR_NOTE}`;
    } catch (error) { this.log(`turn failed: ${String(error?.message ?? error).slice(0, 120)}`); }
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

  /** Whether Developer mode is on (the turn lines and the reasons are logged only then). */
  #devOn() {
    try { return typeof this.explain === 'function' && this.explain() === true; } catch { return false; }
  }

  /** Developer mode only: why a pack did not start for a character on this turn. The turn's own line (turnLine) always has it, the line of its own is said once per pack per game day ("panam-sunset-coffee waits: q307_before_tomorrow still active"). Never throws. */
  #waits(key, gameSeconds, text) {
    try {
      if (!this.#devOn()) return;
      if (this.turnNotes) this.turnNotes.push(`${key} waits: ${text}`);
      const day = whole(gameSeconds) ? Math.floor(gameSeconds / DAY) : -1;
      if (this.explained.get(key) === day) return;
      this.explained.set(key, day);
      this.log(`${key} waits: ${text}`);
    } catch {}
  }

  /** Developer mode only: one more reason in the turn's own line. */
  #note(text) { if (this.turnNotes) this.turnNotes.push(text); }

  /** The words for how V and the character talk this turn, for the Developer log. */
  #howText(input) {
    const channel = channelOf(input);
    return {phone: 'a Phone Chat text', holocall: 'a holocall', own: 'talk in person with one of V\'s copies', story: 'talk with a character the game placed'}[channel] ?? channel;
  }

  /** Why a turn never reached the pack logic, in words (null when it did or the reason is not known here). */
  #noPackReason(input) {
    if (!input?.bonds) return 'the game sent no bonds block, so Character bonds is off in Settings or the block could not be made';
    if (!input.bonds.on) return 'the bonds block is off';
    if (!input.bonds.packs) return 'the bonds block has no Story packs flag, so Story packs is off in Settings or the development switch is missing';
    if (input.reaction) return 'a reaction is no turn of V\'s';
    if (input.head) return 'Johnny in V\'s head is no turn of V\'s';
    if (input.event) return 'a message the character started is no turn of V\'s';
    return null;
  }

  /**
   * Developer mode only: the one line every private turn leaves about the packs, so a text that started nothing can be read without a guess. It names how V and the character talk
   * (the channel), whether she is beside V and in V's party, the bond level, the game clock, whether the game called the turn busy and why, and then either the pack that started,
   * the pack that is running, or the reason each pack gave for waiting (the gate, the channel, the party, the quiet days, the dice and their chance). Never throws.
   */
  #turnLine(input, facts, decision, notes) {
    try {
      const clock = value => `day ${Math.floor(value / DAY)} ${String(Math.floor(value % DAY / HOUR)).padStart(2, '0')}:${String(Math.floor(value % HOUR / 60)).padStart(2, '0')}`;
      const bonds = input?.bonds ?? {};
      const time = Number.isSafeInteger(input?.turnContext?.gameTime) && input.turnContext.gameTime >= 0 ? clock(input.turnContext.gameTime) : 'no game clock yet';
      const who = [facts?.near === true ? 'she is beside V' : 'she is apart from V', bonds.copy === 'party' ? 'in V\'s party' : 'not in V\'s party', `bond level ${facts?.level ?? 0}`, time,
        bonds.busy === true ? `the game is busy (${bonds.busyWhy ?? 'no reason given'})` : 'the game is not busy'].join(', ');
      let result;
      if (decision?.start) result = `started ${decision.start.pack.id}`;
      else if (decision?.pack) result = `${decision.pack.id} is running (stage ${decision.entry?.trail?.at(-1)?.stage ?? '?'}), so no new pack starts`;
      else if (notes?.length) result = notes.join(' | ');
      else result = this.#noPackReason(input) ?? (this.#packsOf(input?.profileKey).length ? 'no pack had anything to say about this turn' : 'this character has no story pack');
      this.log(`[dev] turn ${input?.profileKey} on ${this.#howText(input)}: ${who}. ${result}`);
    } catch {}
  }

  /** Developer mode only: a private turn of V's that never reached the pack logic (no bonds block, Story packs off in the block), said once per turn. Never throws. */
  noDecision(input) {
    try {
      if (!this.#devOn() || !this.packs.size || !input || input.reaction || input.head || input.group || !bondable(input.profileKey)) return;
      const id = turnId(input);
      if (id && this.noted.has(id)) return;
      if (id) { this.noted.add(id); while (this.noted.size > 64) this.noted.delete(this.noted.values().next().value); }
      this.log(`[dev] turn ${input.profileKey} on ${this.#howText(input)}: no pack decision, ${this.#noPackReason(input) ?? 'the turn is not one the packs read'}`);
    } catch {}
  }

  /** "panam-palmer" -> "Panam Palmer" (a lasting line from another character says who it is from). */
  #nameOf(key) { return String(key).split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' '); }

  /** The turn's decision, with the turn's one Developer log line (turnLine) whatever came of it. */
  #decide(input, facts) {
    this.turnNotes = this.#devOn() ? [] : null;
    let decision = null;
    try { decision = this.#decideTurn(input, facts); }
    finally {
      const notes = this.turnNotes;
      this.turnNotes = null;
      if (notes) this.#turnLine(input, facts, decision, notes);
    }
    return decision;
  }

  #decideTurn(input, facts) {
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
    const decision = {note: '', story: null, evaluate: false, pack: null, entry: null, start: null, gameSeconds, channel, near: facts.near === true, eddiesRow: input.eddies?.row ?? null, gap: null};
    if (!mine.length) {
      decision.note = lines.join('\n');
      return decision.note ? decision : null;
    }
    const activeRow = mine.map(pack => [pack, this.entries.get(pack.id)]).find(([, entry]) => entry?.status === 'active');
    if (!allowed) this.#note(`${channel} never starts or moves a pack (a pack runs on one of V's own copies, a phone chat or a holocall)`);
    if (activeRow && allowed) {
      const [pack, entry] = activeRow;
      // The story reached the quest this pack waits for to end (Jackie: The Heist): the pack ends unfinished, whatever else is going on.
      const stop = pack.unfinishedWhen;
      if (stop && inventoryComplete(input.journalHistory) && finished(questState(input.journalHistory, stop.finished))) this.#go(pack, entry, stop.ending, gameSeconds, 'unfinished');
      // Paused (no new stage, no timer) while the character has a quest of their own going, the story is at its end, or the game is busy.
      const paused = entry.status === 'active' && (bonds.busy === true || !this.#quietJournal(pack, input.journalHistory));
      if (paused) this.#note(`${pack.id} is running but paused: ${bonds.busy === true ? `the game is busy (${bonds.busyWhy ?? 'a scene, a choice, a fight or a call'})` : 'a quest of the game or the main story holds the moment'}`);
      if (!paused) {
        decision.evaluate = entry.presented === true;
        this.#resolve(pack, entry, {gameSeconds, eddiesRow: decision.eddiesRow});
        if (entry.status === 'lapsed') {
          // It lapsed on this turn (no bond change): this turn is an ordinary talk.
          decision.evaluate = false;
        } else if (entry.status === 'active') {
          const stage = this.#stageOf(pack, entry);
          decision.pack = pack; decision.entry = entry;
          // A stage reached just now was not shown yet, so V's words this turn do not answer it.
          if (!entry.presented) decision.evaluate = false;
          lines.unshift(this.#stageNote(pack, stage, {channel, near: facts.near === true, settings: {invitations: bonds.invitations === true}}, entry));
          if (entry.gap && pack.gaps?.[entry.gap.id]) decision.gap = {id: entry.gap.id, tags: pack.gaps[entry.gap.id].tags ?? []};
          else if (decision.evaluate && channel !== 'own' && facts.near !== true) {
            // She is only a voice on the phone, so the stage's opening lines have not been said by anyone and its talk gap has not opened in the game: the question was asked
            // in the note instead, and V's words on this remote channel answer it (docs/QUEST_PRIMITIVES.md section 11).
            const found = inPerson(pack, stage);
            if (found.gapId && !found.placed) decision.gap = {id: found.gapId, tags: pack.gaps[found.gapId].tags ?? [], remote: true};
          }
          decision.story = this.#storyFacts(pack, stage, entry, {channel, gameSeconds, eddies: bonds.eddies === true});
        } else {
          const last = entry.trail.at(-1);
          lines.push(`Something you remember about V: ${pack.endings[last.stage].memory}`);
        }
      }
    } else if (!activeRow && allowed && !input.group && whole(gameSeconds)) {
      const start = this.#tryStart(mine, input, {channel, gameSeconds, level: facts.level ?? 0, romance: facts.romance ?? null, near: facts.near === true, party: input.bonds?.copy === 'party'});
      if (start) {
        decision.start = start; decision.pack = start.pack;
        lines.unshift(`${start.pack.start.bringUp} ${this.#stageNote(start.pack, start.pack.stages[0], {channel, near: facts.near === true, settings: {invitations: bonds.invitations === true}}, null, start.variation)}`);
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

  #tryStart(mine, input, {channel, gameSeconds, level, romance, near = false, party = false}) {
    const profile = input.profileKey, meta = this.#meta(profile);
    if (this.#active().length >= MAX_ACTIVE) { this.#waits(profile, gameSeconds, `${MAX_ACTIVE} quests are already running`); return null; }
    const today = Math.floor(gameSeconds / DAY);
    // A reach-out sent a pack's offer: that pack starts on this talk without the dice and the quiet days (its gate still applies). It expires after a game day.
    const offer = meta.offer && gameSeconds >= meta.offer.at && gameSeconds - meta.offer.at <= OFFER_HOURS * HOUR ? meta.offer : null;
    if (meta.offer && !offer) { meta.offer = null; this.#schedule(); }
    const quiet = !this.fast && meta.endedAt !== null && gameSeconds - meta.endedAt < COOLDOWN_DAYS * DAY;
    const finishedPacks = new Set([...this.entries].filter(([id, entry]) => entry.status === 'done' && this.packs.get(id)?.character === profile).map(([id]) => id));
    const bonds = input.bonds;
    // Story packs first, then hangouts; the pack an offer names comes before both.
    const ordered = [...mine.filter(pack => pack.id === offer?.pack), ...mine.filter(pack => pack.id !== offer?.pack && pack.kind !== 'hangout'), ...mine.filter(pack => pack.id !== offer?.pack && pack.kind === 'hangout')];
    let ticked = false;
    for (const pack of ordered) {
      const hangout = pack.kind === 'hangout', offered = offer?.pack === pack.id, entry = this.entries.get(pack.id);
      if (hangout) {
        // At most one a game day per character; a finished one comes back after repeatDays game days.
        if (meta.hangoutDay === today) { this.#waits(pack.id, gameSeconds, 'a hangout already ran today'); continue; }
        const repeat = (pack.hangout?.repeatDays ?? HANGOUT_DEFAULTS.repeatDays) * DAY;
        if (entry && !(entry.status === 'done' && whole(entry.trail.at(-1).at) && gameSeconds >= entry.trail.at(-1).at + repeat)) { this.#waits(pack.id, gameSeconds, 'played not long ago'); continue; }
      } else if (entry || (quiet && !offered)) { this.#waits(pack.id, gameSeconds, entry ? `already ${entry.status === 'done' ? 'played' : 'running'}` : `quiet days after the last quest (${COOLDOWN_DAYS} game days)`); continue; }
      const gate = packGate(pack, {level, journalHistory: input.journalHistory, romance, channel, finishedPacks, busy: bonds.busy === true,
        settings: {eddies: bonds.eddies === true, invitations: bonds.invitations === true}, facts: pack.requires?.facts ? this.#facts() : null});
      if (!gate.open) { this.#waits(pack.id, gameSeconds, explainGate(gate, pack, {level, channel, romance, busyWhy: bonds.busyWhy})); continue; }
      // Fair starts (bridge/quest-start.mjs): a pack that opens with a call does not start in person, nor with her beside V or in V's party. And a pack that lapsed unseen or
      // unaccepted is left alone for a game day. Neither takes a roll of the dice.
      const allowed = startAllowed(pack, {channel, near, party});
      if (!allowed.ok) { this.#waits(pack.id, gameSeconds, allowed.why); continue; }
      const lapsed = meta.withdrawn[pack.id];
      if (whole(lapsed) && gameSeconds >= lapsed && gameSeconds - lapsed < WITHDRAWN_DAYS * DAY) { this.#waits(pack.id, gameSeconds, 'V abandoned it less than a game day ago'); continue; }
      // The dice (DAILY_ROLLS above): only when a pack could start, every ROLL_EVERY_TURNS eligible turns, at most DAILY_ROLLS a game day per character.
      if (!offered && !this.fast) {
        if (meta.rolled !== today) { meta.rolled = today; meta.rolls = 0; meta.idle = ROLL_EVERY_TURNS - 1; }   // the first eligible turn of a game day rolls at once
        if (meta.rolls >= DAILY_ROLLS) { this.#waits(pack.id, gameSeconds, `the ${DAILY_ROLLS} rolls of today are used`); return null; }
        if (!ticked) { meta.idle += 1; ticked = true; this.#schedule(); }
        if (meta.idle < ROLL_EVERY_TURNS) { this.#waits(pack.id, gameSeconds, `the next roll comes after ${ROLL_EVERY_TURNS - meta.idle} more talk turns`); return null; }
        meta.rolls += 1; meta.idle = 0; this.#schedule();
        if (this.random() >= pack.start.chance) { this.#waits(pack.id, gameSeconds, `the dice said no (chance ${pack.start.chance}, roll ${meta.rolls} of ${DAILY_ROLLS} today)`); return null; }
      }
      return {pack, offered, restart: !!entry, variation: hangout ? this.#nextVariation(pack, meta) : null};
    }
    return null;
  }

  /** The words the character is given for a stage. Second person, no pack or stage talk. A hangout's variation adds its own know and wants. */
  #stageNote(pack, stage, {channel, settings, near = false}, entry = null, variationId = entry?.variation ?? null) {
    const variation = variationId ? pack.hangout?.variations?.find(item => item.id === variationId) : null;
    const parts = [`What is going on between you and V right now (your own story with V, never call it a story, a quest or a stage): ${stage.know}${variation?.know ? ` ${variation.know}` : ''}`];
    if (stage.wants || variation?.wants) parts.push(`What you want from V: ${[stage.wants, variation?.wants].filter(Boolean).join(' ')}`);
    if (stage.meet) {
      parts.push(settings.invitations || pack.requires?.invitations !== true
        ? near ? `You would like to go ${stage.meet.where === 'here' ? 'somewhere' : WHERE[stage.meet.where].replace(/^at /, 'to ')} together with V, whenever V can. V is beside you, so you go from here, and V arranges it with you in V's own words.`
        : `You would like V to meet you ${WHERE[stage.meet.where]}, whenever V can, there is no rush. V arranges it with you in V's own words.`
        : 'You would like to meet V, but meetings cannot be arranged now: say you will sort it out yourself.');
    }
    if (!stage.meet && channel !== 'own' && !near) {
      const found = inPerson(pack, stage);
      if (found.needs) parts.push(this.#inPersonNote(pack, found, {channel, invitations: settings.invitations === true, entry}));
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

  /**
   * The note of a stage that needs her in person (bridge/quest-rendezvous.mjs) while she is only on the phone or a holocall: she cannot do it from here, so she tells V where to
   * meet her (the stage's place by name) or offers to come over (Immersive invitations), and asks the stage's opening question in her own words, because her scripted lines will
   * only be said once she is beside V. V's answer is read against the gap's tags on the next remote turn.
   */
  #inPersonNote(pack, found, {channel, invitations, entry}) {
    const place = found.place ? pack.places?.[found.place]?.name : null;
    const how = channel === 'holocall' ? 'on this call' : 'over the phone';
    const bits = [`This needs you and V together in person, and you are only with V ${how} right now, so do not carry it on from here.`];
    // A stage that places her at the spot itself (a cast) is not one she comes over for: V goes to her.
    const offer = invitations && !found.placed;
    if (place && offer) bits.push(`Tell V to come to ${place}, or offer to come over to where V is instead, and let V arrange it in V's own words.`);
    else if (place) bits.push(`Tell V to come to ${place}.`);
    else if (offer) bits.push("Offer to come over to where V is, and let V arrange it in V's own words.");
    else bits.push('Tell V to come and find you.');
    const gap = found.gapId && !found.placed ? pack.gaps?.[found.gapId] : null;
    if (gap) {
      const asked = entry?.presented === true;
      bits.push(asked
        ? `You have just asked V: "${gap.asks}" Once V has answered, do not ask it again.`
        : `Ask V this, in your own words, before anything else: "${gap.asks}"`);
      bits.push(`What you know now: ${gap.know}${gap.wants ? ` What you want from V: ${gap.wants}` : ''}`);
    }
    return bits.join(' ');
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
      // V's words over the phone or a holocall with her far away move the pack: a stage that needs her in person is marked remote.
      this.remoteTurn = decision.channel !== 'own' && decision.near !== true;
      if (decision.start) {
        const known = this.entries.get(pack.id);
        if (known && (!decision.start.restart || known.status === 'active')) return;
        const variation = decision.start.variation;
        const remote = this.remoteTurn && inPerson(pack, pack.stages[0]).needs;
        const entry = {status: 'active', trail: [{stage: pack.stages[0].id, at: gameSeconds ?? null, ...(remote ? {remote: true} : {})}], presented: true, beat: null,
          ...(variation ? {variation} : {}), ...(CHANNELS.includes(decision.channel) ? {via: decision.channel} : {})};
        this.entries.set(pack.id, entry);
        const meta = this.#meta(pack.character);
        if (pack.kind === 'hangout') {
          if (whole(gameSeconds)) meta.hangoutDay = Math.floor(gameSeconds / DAY);
          if (variation) meta.hangouts[pack.id] = {variation, at: gameSeconds ?? null};
        }
        if (decision.start.offered) meta.offer = null;
        this.#enter(pack, pack.stages[0], gameSeconds);
        this.log(`pack=${pack.id} started on ${decision.channel} (stage ${pack.stages[0].id}${variation ? `, ${variation}` : ''}${decision.start.offered ? ', offered' : ''})`);
        this.#dev(`pack=${pack.id} start: ${decision.channel}, she is ${decision.near ? 'beside V' : 'apart from V'}${input.bonds?.copy === 'party' ? ' and in V\'s party' : ''}; the journal entry, the tracker and the map pin are made from the next play file, and the game shows a notice`);
        this.#dev(`pack=${pack.id} no time limit: it stays open until V does it, says no or abandons it`);
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
      if (decision.gap && decision.gap.tags.length && (decision.gap.remote ? decision.evaluate && !entry.gap : entry.gap?.id === decision.gap.id)) {
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
      // V tells the character the whole thing is off ("forget it", "I give up"): the one way to close a quest without doing it, besides the journal (no time limit runs it out).
      // A stage's own `no` answer was read first, so this only catches a line no choice took.
      if (!moneyTurn && screenAbandon(words)) { this.abandon(pack.id, {gameSeconds, why: 'V told her it is off'}); return; }
      if (!entry.presented) { entry.presented = true; this.#schedule(); }
    } catch (error) {
      this.log(`record failed: ${String(error?.message ?? error).slice(0, 120)}`);
    } finally {
      this.remoteTurn = false;
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
      // The line that was shown: a partner got the partnerText (bridge/reach-outs.mjs eligible), and her answer must be to those words.
      const sent = trigger.partnerText && this.meta.get(character)?.romance === 'partner' ? trigger.partnerText : trigger.text;
      const note = `You have just reached out to V first, with this message: "${sent}" ${trigger.note ? `What is behind it: ${trigger.note} ` : ''}V's next words are the answer to it. Answer as the one who wrote it, in your own words, and do not repeat the message.`;
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

  /** A stage that waits on `event:<name>` moves, else a finished Eddies transfer or a closing beat may. Returns whether it moved. */
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
   * An event the game saw ({pack, serial, name, at, data}). Opens and closes the talk gap, moves a stage that waits on it and applies a gift's bond. An event for another stage (a different serial) is dropped. A `reach` event (pack "reach") starts a reach-out's cooldown. Returns whether the
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
      const gameSeconds = whole(at) ? at : undefined;
      if (gameSeconds !== undefined) this.lastClock = Math.max(this.lastClock ?? 0, gameSeconds);
      // V abandoned the quest in the game (the journal, or the developer probe): it closes at once, with no bond change (abandon).
      if (rawName === QUEST_ABANDON) return this.abandon(packId, {gameSeconds, why: 'V abandoned it in the game'});
      const name = this.#unmap(pack, entry, rawName);
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
    // A stage that V's words over the phone brought on (it carries a travel allowance) and that needs her in person gets the means of getting her to V: a pin and a cast of her
    // at the meeting place (both only while she has no copy of V's), a party join for a ride. A stage entered in person or by the game is the pack's own business.
    const remote = entry.trail.at(-1).remote === true;
    return [...(stage.do ?? []), ...(remote ? rendezvousSpecs(pack, stage) : [])].map(spec => {
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
      const gifts = doList.some(spec => spec?.p === 'gift' && spec.dir === 'give') ? likesFor(pack.character) : null;
      quests.push({pack: id, character: pack.character, stage: stage.id, serial: entry.trail.length, since: last.at, places, do: doList, script,
        ...this.#lineTables(pack, refs), gaps, gap: entry.gap ?? null, ...(entry.via ? {via: entry.via} : {}),
        ...(Object.keys(calls).length ? {calls} : {}), ...(stage.music ? {music: swap ? remapSounds(stage.music, swap) : stage.music} : {}),
        ...(stage.sfx ? {sfx: swap ? remapSounds(stage.sfx, swap) : stage.sfx} : {}), ...(stage.situation ? {situation: stage.situation} : {}), ...(gifts ? {gifts} : {})});
    }
    const closing = this.closing.map(item => ({pack: item.pack, character: item.character, ending: item.ending, serial: item.serial, script: item.script, lines: item.lines, images: item.images}));
    const known = new Set(quests.map(quest => quest.pack));
    // The real quests (docs/REAL_QUESTS.md): every pack in progress, talk stages included, and the newest finished ones, for the journal, the tracker and the map.
    const journal = journalBlock({packs: this.packs, entries: this.entries, stageOf: (pack, entry) => this.#stageOf(pack, entry), doFor: (pack, entry, stage) => this.#doFor(pack, entry, stage)});
    return {version: 1, revision: this.playRev, quests, closing, commands: this.commands.filter(command => known.has(command.pack)),
      factsWanted: wantedFacts([...requiresList, ...(this.reach?.requiresList?.() ?? [])]), reach: this.#reachBlock(), journal};
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
