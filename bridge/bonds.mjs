// Character bonds (docs/RELATIONSHIPS_AND_QUESTS.md): Settings > Gameplay > Character bonds, off by default.
//
// Every named character has a bond with V, level 1 to 10. It is two parts added together:
//   the STORY part, worked out on every turn from what the turn already carries (the character's own quests finished, from the journal inventory;
//     a romance the save confirms, from the turn's admitted relationship selection; V's money record, from the Eddies ledger row while that setting
//     is on). It is never stored, so it follows the save.
//   the SHARED part, what V and the character said to each other: points per exchange heard to the end, capped per game day and per real day, and
//     points lost for threats and insults (bridge/threat-screen.mjs reads V's words). Warmth never decays; hurt fades with a half-life of 10 game days.
//     It is kept per MEMORY key in <state>/bonds.json, so it follows the character's memory (not the save) and Forget clears it with the memory.
// The model decides nothing: what the character says never moves the bond.
//
// What a turn gets: one world-tier line (it changes only when a level does, so prefix caches keep working) on a private turn of a named character,
// on every provider. What the game gets: runtime/bonds-status.json, the levels and the last few level changes, for the one notice per change
// (mod/bonds.lua). Ordinary talk pays a Map lookup and one string; the record is made after the reply is published, never in front of it.
import {readFile} from 'node:fs/promises';
import {atomicFile} from './guarded-file.mjs';
import {screenMessage} from './threat-screen.mjs';
import {MEMORY_KEY, scopeOf} from './memory-scope.mjs';
import {MIC_PLACEHOLDER} from './call-meet.mjs';
import {BOND_ARCS} from './bond-arcs.mjs';

export const MAX_POINTS = 1000;
/** The ten levels: the least points, the title, and how a character at that level treats V (the prompt line). */
export const LEVELS = Object.freeze([
  {level: 1, from: 0, title: 'Acquaintance', line: 'you barely know V yet. Be polite but guarded, and keep personal matters to yourself.'},
  {level: 2, from: 30, title: 'Familiar face', line: 'V is a familiar face: friendly enough, but you are still careful about what you share.'},
  {level: 3, from: 80, title: 'Friendly', line: 'you like V. Talk comes easily, and small personal details are fine.'},
  {level: 4, from: 150, title: 'Friend', line: 'V is a friend: you joke, you share opinions, and you would do V a small favour or ask one.'},
  {level: 5, from: 240, title: 'Good friend', line: 'V is a good friend. You talk with V about things that matter to you, and you would ask V for help with something real.'},
  {level: 6, from: 350, title: 'Close friend', line: 'V is a close friend. You trust V with private worries, and you would go out of your way for V.'},
  {level: 7, from: 480, title: 'Trusted', line: 'you trust V deeply: you would ask V for a serious favour, and help V without asking why.'},
  {level: 8, from: 630, title: 'Confidant', line: 'V is your confidant: you tell V things you tell almost nobody.'},
  {level: 9, from: 800, title: 'Family', line: 'V is family to you, and you would take real risks for V.'},
  {level: 10, from: 950, title: 'Ride or die', line: 'V is your ride or die: there is nothing you would not share with V or do for V.'},
].map(Object.freeze));

/** Points per exchange heard to the end, by how V and the character talked. */
export const TALK_POINTS = Object.freeze({own: 4, holocall: 3, phone: 3, story: 2});
/** Points a threat or an insult at the character costs (and that exchange gains nothing). */
export const HURT_POINTS = Object.freeze({kill: 25, hurt: 15, insult: 8});
/** Talk caps per character: the first FULL exchanges of a game day count in full, the next HALF count half (at least 1), then nothing; at most REAL a real day. */
export const DAY_CAPS = Object.freeze({full: 6, half: 12, real: 120});
/** Hurt fades: half of it is gone after this many game days. */
export const HURT_HALF_LIFE_DAYS = 10;
/** The shared part's own bounds: hostility can take a story-close character down, never below zero in all. */
export const SHARED_RANGE = Object.freeze({min: -300, max: MAX_POINTS});
/** The story part's sources (docs 3.2). */
export const ROMANCE_POINTS = Object.freeze({partner: 150, casual: 40});
export const MONEY_POINTS = Object.freeze({repaid: 30, giftPer: 200, giftMax: 60, owes: -15});
/** Hurt still left above this many points is told to the character. */
export const HURT_NOTE_FROM = 20;

const GAME_DAY = 86400, REAL_DAY_MS = 86_400_000;
const AMBIENT = /^(?:resident-male|resident-female|npc-[a-z0-9-]+)$/;   // isAmbientProfile (bridge/protocol.mjs)
const COPIES = new Set(['party', 'visitor', 'housemate']);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const gameSecondsOf = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** The level of a point total, 1 to 10. */
export function levelOf(points) {
  const value = Number.isFinite(points) ? points : 0;
  let found = LEVELS[0];
  for (const row of LEVELS) if (value >= row.from) found = row;
  return found;
}

// ---- the game's block ------------------------------------------------------------------------------------------------------------------------

/**
 * The `bonds` block of a request (mod/bonds.lua attach): {version: 1, on: true, copy?}, sent only while the setting is on, for a private turn V sends.
 * `copy`: 'party' | 'visitor' | 'housemate' when the character is one of V's own copies. Phase 2 adds three flags, each present only when true:
 * `packs` (Settings > Gameplay > Story packs is on), `invitations` (Immersive invitations is on), `eddies` (Eddies with characters is on) and `busy` (a scene, a dialogue choice, combat, a game
 * call or a chase: no pack starts or moves now). Round 2 adds `reach` (Settings > Gameplay > Characters text first is on: the characters' reach-outs, default on in the game).
 * Returns {on: true, copy, packs?, invitations?, eddies?, busy?, reach?} or null.
 */
export function parseBonds(value) {
  if (!plain(value) || value.version !== 1 || value.on !== true) return null;
  return {on: true, copy: COPIES.has(value.copy) ? value.copy : null, ...(value.packs === true ? {packs: true} : {}),
    ...(value.invitations === true ? {invitations: true} : {}), ...(value.eddies === true ? {eddies: true} : {}), ...(value.busy === true ? {busy: true} : {}),
    ...(value.reach === true ? {reach: true} : {})};
}

/** Who gets a bond: a named character (not an ordinary NPC, an add-on voice or a model-only copy). */
export const bondable = profileKey => typeof profileKey === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(profileKey)
  && !AMBIENT.test(profileKey) && !profileKey.startsWith('addon-');

/** How V and the character talk this turn: 'holocall', 'phone' (Phone Chat), 'own' (one of V's own copies in person) or 'story' (a character the game placed). */
export function channelOf(input) {
  if (input?.holocall) return 'holocall';
  if (input?.channel === 'phone') return 'phone';
  return input?.bonds?.copy ? 'own' : 'story';
}

// ---- the story part --------------------------------------------------------------------------------------------------------------------------

/** The arcs data (bridge/bond-arcs.mjs), frozen once. */
let frozenArcs = null;
export function shippedBondArcs() {
  if (!frozenArcs) frozenArcs = deepFreeze(structuredClone(BOND_ARCS));
  return frozenArcs;
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item); }
  return value;
}

/** A parsed journal inventory (bridge/journal-history.mjs) that can be trusted for "finished": ready, and both lanes complete. */
export function inventoryComplete(history) {
  return history?.status === 'ready' && history.coverage?.history?.status === 'complete' && history.coverage?.active?.status === 'complete'
    && Array.isArray(history.quests);
}

// The quests of an inventory by path, worked out once per parsed inventory (they are frozen and shared between turns).
const questIndex = new WeakMap();
/**
 * Whether an active quest has not really begun: every objective still open is in its `00_hook` stage (the game's own wait for a call or a text, like Phantom Liberty's
 * `q307_before_tomorrow` waiting for V to call Reed, which a finished save can leave open for good). A quest with no open objective row is not idle.
 */
function hookOnly(quest) {
  const open = (Array.isArray(quest?.objectives) ? quest.objectives : []).filter(objective => objective?.state === 'active');
  return open.length > 0 && open.every(objective => objective.questRelativePath?.[1] === '00_hook');
}
/**
 * {byPath, byId, paths, idle} of an inventory: {path -> state} (a row without `nativePath` is known by its id as the last part of a path) and `idle`, the paths of the
 * active quests that still sit at their hook (hookOnly).
 */
export function questStates(history) {
  if (!history || typeof history !== 'object') return null;
  let index = questIndex.get(history);
  if (index) return index;
  const byPath = new Map(), byId = new Map(), idle = new Set();
  for (const quest of Array.isArray(history.quests) ? history.quests : []) {
    if (typeof quest?.nativePath === 'string') {
      byPath.set(quest.nativePath, quest.state);
      if (quest.state === 'active' && hookOnly(quest)) idle.add(quest.nativePath);
    }
    if (typeof quest?.nativeId === 'string') byId.set(quest.nativeId, quest.state);
  }
  index = {byPath, byId, paths: [...byPath.keys()], idle};
  questIndex.set(history, index);
  return index;
}
/** The state of one quest path in an inventory: 'active', 'succeeded', 'failed' or undefined (not there). */
export function questState(history, path) {
  const index = questStates(history);
  if (!index || typeof path !== 'string') return undefined;
  return index.byPath.get(path) ?? index.byId.get(path.slice(path.lastIndexOf('/') + 1));
}
export const finished = state => state === 'succeeded' || state === 'failed';

/** The arc points of a character: the weights of their quests that are finished, from a complete inventory only (else 0). */
export function arcPoints(profileKey, history, arcs = shippedBondArcs()) {
  const arc = arcs?.arcs?.[profileKey];
  if (!arc || !inventoryComplete(history)) return 0;
  let points = 0;
  for (const [path, weight] of Object.entries(arc.quests)) if (finished(questState(history, path))) points += weight;
  return points;
}

/** How many of a character's arc quests are finished, and how many the arc has: {done, total} (0, 0 without an arc; done is 0 without a complete inventory). */
export function arcCounts(profileKey, history, arcs = shippedBondArcs()) {
  const arc = arcs?.arcs?.[profileKey];
  if (!arc) return {done: 0, total: 0};
  const paths = Object.keys(arc.quests);
  if (!inventoryComplete(history)) return {done: 0, total: paths.length};
  return {done: paths.filter(path => finished(questState(history, path))).length, total: paths.length};
}

/** The money points from the Eddies ledger row of the turn (bridge/eddies.mjs parseEddies row), 0 without one. */
export function moneyPoints(row) {
  const totals = row?.totals;
  if (!plain(totals)) return 0;
  let points = 0;
  const lent = totals.loanToV ?? 0, repaid = totals.repayByV ?? 0;
  if (lent > 0 && repaid >= lent) points += MONEY_POINTS.repaid;
  points += Math.min(MONEY_POINTS.giftMax, Math.floor((totals.giftFromV ?? 0) / MONEY_POINTS.giftPer));
  if (lent - repaid > 0) points += MONEY_POINTS.owes;
  return points;
}

/** The story part of a turn: {points, arc, romance, money}. `romance`: 'partner' | 'casual' | null (bridge/eddies.mjs romanceOf). */
export function storyPart({profileKey, journalHistory, romance = null, eddiesRow = null, arcs} = {}) {
  const arc = arcPoints(profileKey, journalHistory, arcs);
  const love = romance === 'partner' ? ROMANCE_POINTS.partner : romance === 'casual' ? ROMANCE_POINTS.casual : 0;
  const money = moneyPoints(eddiesRow);
  return {points: arc + love + money, arc, romance: love, money};
}

// ---- the shared part: one exchange --------------------------------------------------------------------------------------------------------

/** What one exchange heard to the end is worth, before the caps: {talk, hurt, threat}. `words`: V's typed line or the spoken transcript. */
export function exchangeValue(channel, words) {
  const text = typeof words === 'string' && words.trim() && words.trim() !== MIC_PLACEHOLDER ? words : '';
  const threat = text ? screenMessage(text).threat : null;
  if (threat && HURT_POINTS[threat]) return {talk: 0, hurt: HURT_POINTS[threat], threat};
  return {talk: TALK_POINTS[channel] ?? TALK_POINTS.story, hurt: 0, threat: null};
}

/** Talk points after the caps, from the entry's day counters (mutated: the counters move on). */
export function cappedTalk(entry, talk, {gameSeconds, nowMs}) {
  if (!(talk > 0)) return 0;
  const day = gameSeconds !== undefined ? Math.floor(gameSeconds / GAME_DAY) : null;
  const realDay = Math.floor(nowMs / REAL_DAY_MS);
  // The game day: by the game clock when the turn has one, else by the real day.
  const dayKey = day !== null ? `g${day}` : `r${realDay}`;
  if (entry.day !== dayKey) { entry.day = dayKey; entry.dayCount = 0; }
  if (entry.realDay !== realDay) { entry.realDay = realDay; entry.realPoints = 0; }
  entry.dayCount += 1;
  let points = entry.dayCount <= DAY_CAPS.full ? talk : entry.dayCount <= DAY_CAPS.full + DAY_CAPS.half ? Math.max(1, Math.floor(talk / 2)) : 0;
  points = Math.max(0, Math.min(points, DAY_CAPS.real - entry.realPoints));
  entry.realPoints += points;
  return points;
}

/** The hurt left at `gameSeconds`: halves every HURT_HALF_LIFE_DAYS game days since it was last added (a clock that went back fades nothing). */
export function fadedHurt(entry, gameSeconds) {
  if (!(entry?.hurt > 0)) return 0;
  if (gameSeconds === undefined || !Number.isSafeInteger(entry.hurtAt)) return entry.hurt;
  const days = Math.max(0, (gameSeconds - entry.hurtAt) / GAME_DAY);
  return entry.hurt * Math.pow(0.5, days / HURT_HALF_LIFE_DAYS);
}

/** The shared part of an entry at `gameSeconds`, within SHARED_RANGE. */
export function sharedPart(entry, gameSeconds) {
  if (!entry) return 0;
  return clamp(Math.round((entry.warm ?? 0) - fadedHurt(entry, gameSeconds)), SHARED_RANGE.min, SHARED_RANGE.max);
}

// ---- the store ----------------------------------------------------------------------------------------------------------------------------
const MAX_FILE_CHARS = 2_000_000;
const SETTABLE = ['path', 'keyFor', 'now', 'limit', 'debounceMs', 'read', 'write', 'timers', 'log'];
const freshEntry = () => ({warm: 0, hurt: 0, hurtAt: null, day: null, dayCount: 0, realDay: null, realPoints: 0,
  profileKey: null, name: '', story: 0, arcDone: 0, arcTotal: 0, lastAt: 0, seenAt: null});

function cleanEntry(row) {
  if (!plain(row)) return null;
  const number = (value, low, high) => Number.isFinite(value) && value >= low && value <= high ? value : null;
  const entry = freshEntry();
  entry.warm = number(row.warm, 0, 1e7) ?? 0;
  entry.hurt = number(row.hurt, 0, 1e7) ?? 0;
  entry.hurtAt = gameSecondsOf(row.hurtAt) ?? null;
  entry.day = typeof row.day === 'string' && /^[gr]\d{1,12}$/.test(row.day) ? row.day : null;
  entry.dayCount = Number.isSafeInteger(row.dayCount) && row.dayCount >= 0 ? row.dayCount : 0;
  entry.realDay = Number.isSafeInteger(row.realDay) && row.realDay >= 0 ? row.realDay : null;
  entry.realPoints = number(row.realPoints, 0, 1e6) ?? 0;
  // What the Relationships page shows (phase 2): who this is, the story part and arc counts as of the last turn, and when that was.
  entry.profileKey = typeof row.profileKey === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(row.profileKey) ? row.profileKey : null;
  entry.name = typeof row.name === 'string' && !/\p{Cc}/u.test(row.name) ? row.name.slice(0, 80) : '';
  entry.story = number(row.story, 0, 1000) ?? 0;
  entry.arcDone = Number.isSafeInteger(row.arcDone) && row.arcDone >= 0 && row.arcDone <= 64 ? row.arcDone : 0;
  entry.arcTotal = Number.isSafeInteger(row.arcTotal) && row.arcTotal >= 0 && row.arcTotal <= 64 ? row.arcTotal : 0;
  entry.lastAt = number(row.lastAt, 0, 1e14) ?? 0;
  entry.seenAt = gameSecondsOf(row.seenAt) ?? null;
  return entry;
}

export class BondStore {
  /**
   * path     the JSON file (none: in memory only)       keyFor   profile key -> memory key (a content pack with its own memory has bonds of its own)
   * now      the real clock in ms                         read, write, timers   file access and timers, injectable for tests
   */
  constructor({path = null, keyFor = key => key, now = Date.now, limit = 1024, debounceMs = 10_000,
    read = file => readFile(file, 'utf8'), write = (file, text) => atomicFile(file, text),
    timers = {set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle)}, log = null} = {}) {
    Object.assign(this, {path, keyFor, now, limit, debounceMs, read, write, timers, log});
    this.entries = new Map();
    this.timer = null; this.dirty = false; this.chain = Promise.resolve();
  }

  async configure(options = {}) {
    for (const name of SETTABLE) if (options[name] !== undefined) this[name] = options[name];
    return this.load();
  }

  /** Read the saved entries (a missing or damaged file starts empty; entries recorded meanwhile win). Returns how many were loaded. */
  async load() {
    if (!this.path) return 0;
    let rows;
    try {
      const text = await this.read(this.path);
      if (typeof text !== 'string' || text.length > MAX_FILE_CHARS) return 0;
      const parsed = JSON.parse(text);
      rows = parsed?.version === 1 ? parsed.entries : null;
    } catch { return 0; }
    if (!plain(rows)) return 0;
    const loaded = new Map();
    for (const [key, row] of Object.entries(rows)) {
      const entry = MEMORY_KEY.test(key) ? cleanEntry(row) : null;
      if (entry) loaded.set(key, entry);
    }
    for (const [key, entry] of this.entries) { loaded.delete(key); loaded.set(key, entry); }
    this.entries = loaded;
    this.#trim();
    return loaded.size;
  }

  /** The memory key of a profile key, or null. */
  memoryKey(profileKey) {
    let key;
    try { key = this.keyFor(profileKey); } catch { return null; }
    return typeof key === 'string' && MEMORY_KEY.test(key) ? key : null;
  }

  peek(key) { return this.entries.get(key); }
  get size() { return this.entries.size; }

  /** Add one exchange's value to a memory key: {talk (after caps), hurt}. Returns the entry. Nothing waits for the disk. */
  add(key, {talk = 0, hurt = 0} = {}, {gameSeconds, nowMs = this.now(), meta = null} = {}) {
    if (typeof key !== 'string' || !MEMORY_KEY.test(key)) return null;
    const entry = this.entries.get(key) ?? freshEntry();
    this.entries.delete(key); this.entries.set(key, entry);
    const gained = cappedTalk(entry, talk, {gameSeconds, nowMs});
    entry.warm = Math.min(1e7, entry.warm + gained);
    if (hurt > 0) {
      // The hurt left now, plus the new hurt, stamped with this turn's clock (it fades from here).
      entry.hurt = Math.min(1e7, fadedHurt(entry, gameSeconds) + hurt);
      entry.hurtAt = gameSeconds ?? entry.hurtAt;
    }
    if (meta) {
      if (meta.profileKey) entry.profileKey = meta.profileKey;
      if (meta.name) entry.name = meta.name;
      for (const field of ['story', 'arcDone', 'arcTotal']) if (Number.isFinite(meta[field])) entry[field] = meta[field];
      entry.lastAt = nowMs;
      if (gameSeconds !== undefined) entry.seenAt = gameSeconds;
    }
    this.#trim();
    this.dirty = true; this.#schedule();
    return {entry, gained};
  }

  /** A pack's reward or penalty, straight onto the shared part (no talk caps): points above 0 are warmth, below 0 are hurt that fades. Returns the entry. */
  award(key, points, {gameSeconds} = {}) {
    if (typeof key !== 'string' || !MEMORY_KEY.test(key) || !Number.isFinite(points) || points === 0) return null;
    const entry = this.entries.get(key) ?? freshEntry();
    this.entries.delete(key); this.entries.set(key, entry);
    if (points > 0) entry.warm = Math.min(1e7, entry.warm + points);
    else { entry.hurt = Math.min(1e7, fadedHurt(entry, gameSeconds) - points); entry.hurtAt = gameSeconds ?? entry.hurtAt; }
    this.#trim();
    this.dirty = true; this.#schedule();
    return entry;
  }

  /** Forget: these memory keys, or (`all`) every key of the memory `scope` ('' or null: the normal one). Returns how many were removed. */
  forget({all = false, profileKeys = [], scope = null} = {}) {
    let removed = 0;
    if (all) {
      const mine = scope || '';
      for (const key of [...this.entries.keys()]) if (scopeOf(key) === mine) { this.entries.delete(key); removed++; }
    } else {
      for (const key of profileKeys) if (this.entries.delete(key)) removed++;
    }
    if (removed) { this.dirty = true; this.#schedule(); }
    return removed;
  }

  flush() {
    if (this.timer) { this.timers.clear(this.timer); this.timer = null; }
    this.chain = this.chain.then(() => this.#persist(), () => this.#persist());
    return this.chain;
  }

  #trim() { while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value); }

  #schedule() {
    if (!this.path || this.timer) return;
    this.timer = this.timers.set(() => { this.timer = null; void this.flush().catch(() => {}); }, this.debounceMs);
    this.timer?.unref?.();
  }

  async #persist() {
    if (!this.dirty || !this.path) return;
    this.dirty = false;
    try {
      const entries = {};
      for (const [key, entry] of this.entries) entries[key] = {...entry, warm: Math.round(entry.warm * 100) / 100, hurt: Math.round(entry.hurt * 100) / 100};
      if (await this.write(this.path, JSON.stringify({version: 1, entries})) === false) this.dirty = true;
    } catch (error) {
      this.dirty = true;
      this.log?.(`could not save (${String(error?.message ?? error).slice(0, 120)})`);
    }
  }
}

// ---- the turn: the line and the record ----------------------------------------------------------------------------------------------------

// The tone of a romance (pet names, open affection, the closing note after V's words) is not added here: bridge/romance-context.mjs carries it for every character, so the partner talks the same on a bond turn, a phone turn and a reaction.

/** The prompt line of a bond (world tier). `hurt`: the hurt left now. */
export function bondLine(level, hurt = 0) {
  const row = LEVELS[clamp(level, 1, 10) - 1];
  const text = `How close you are to V (a fact for you; never say it as a level or a number): ${row.line}`;
  const line = hurt > HURT_NOTE_FROM
    ? `${text} V threatened or insulted you recently, and it still stings: let it show in how you talk to V until it fades.` : text;
  return line;
}

const CHANGE_LIMIT = 8;
const CHARACTER_LIMIT = 60;

/**
 * The bonds of the session: the line of a turn (decided once per turn id, as the context is built several times), the record of a published turn, and
 * the status file for the game. `facts(input)` gives what the bridge knows besides the input: {romance}.
 */
export class Bonds {
  constructor({store = new BondStore(), statusPath = null, write = (file, text) => atomicFile(file, text), log = () => {}, arcs = null,
    now = Date.now, turns = 64} = {}) {
    Object.assign(this, {store, statusPath, write, log, arcs, now, turnLimit: turns});
    this.turns = new Map();       // request id -> {line, view}
    this.lines = new Map();       // profile key -> the last line a turn of V's had (for the reactions that follow it)
    this.levels = new Map();      // memory key -> {profileKey, name, level, points}, the last level told to the game
    this.changes = [];            // the last level changes, newest last
    // Change ids go on from the session's start time, so an id is never reused after a bridge restart (the game shows a change whose id is newer
    // than the newest it has seen).
    this.revision = Math.floor(now() / 1000) * 1000;
    this.statusChain = Promise.resolve();
    this.clock = undefined;       // the newest game clock seen on a turn (the Relationships page fades the hurt to it)
    /** Story packs (bridge/bond-pack-runner.mjs) fill the pack lines of the status: {active() -> {profileKey: {id, title, stage}}, list(profileKey) -> rows, effectsRevision() -> n}. */
    this.packSource = null;
  }

  /** The turn's view: {key, story, shared, points, level, hurt, gameSeconds} or null when bonds are not in this turn. Group rounds count (each speaker has its own line). */
  #view(input, facts = {}) {
    if (!input?.bonds?.on || input.reaction || input.head || !bondable(input.profileKey)) return null;
    const key = this.store.memoryKey(input.profileKey);
    if (!key) return null;
    const gameSeconds = gameSecondsOf(input.turnContext?.gameTime);
    const story = storyPart({profileKey: input.profileKey, journalHistory: input.journalHistory, romance: facts.romance ?? null,
      eddiesRow: input.eddies?.row ?? null, arcs: this.arcs ?? undefined});
    const entry = this.store.peek(key);
    const shared = sharedPart(entry, gameSeconds);
    const points = clamp(story.points + shared, 0, MAX_POINTS);
    return {key, story, shared, points, level: levelOf(points).level, hurt: fadedHurt(entry, gameSeconds), gameSeconds};
  }

  /** The turn's view, decided once per request id (the first build wins): the bond level and what the packs and Eddies need. null when bonds are not in the turn. */
  viewFor(input, facts = {}) {
    const id = typeof input?.requestId === 'string' && input.requestId ? input.requestId : null;
    if (id && this.turns.has(id)) return this.turns.get(id).view;
    const view = this.#view(input, facts);
    if (id && view) {
      this.turns.set(id, {view});
      while (this.turns.size > this.turnLimit) this.turns.delete(this.turns.keys().next().value);
    }
    return view;
  }

  /** The bond level of this turn's character (1 to 10), or null when bonds are not in the turn. */
  levelFor(input, facts = {}) { return this.viewFor(input, facts)?.level ?? null; }

  /** The line for this turn's context, '' when bonds are not in it. The first build of a turn decides; later builds get the same line. */
  contextFor(input, facts = {}) {
    const view = this.viewFor(input, facts);
    if (!view) return '';
    const line = bondLine(view.level, view.hurt);
    this.lines.set(input.profileKey, line);
    while (this.lines.size > CHARACTER_LIMIT) this.lines.delete(this.lines.keys().next().value);
    return line;
  }

  /**
   * The line of a turn the game sends no bond block with (a reaction: a companion speaking up, a fight line): the last line this character had on a turn of V's. The system message of a
   * text model then reads the same on a reaction as on a talk, so a model that can only continue from a saved checkpoint (the lite and Mature models) reuses the whole prompt after a
   * reaction. '' for a character that has had none. `forget()` and `dropLine()` clear it.
   */
  repeatFor(input) {
    return input?.reaction && !input.head && !input.bonds ? this.lines.get(input.profileKey) ?? '' : '';
  }

  /** A turn of V's with this character came without a bond block (the setting is off): its remembered line is not used again. */
  dropLine(input) { this.lines.delete(input?.profileKey); }

  /**
   * A reply was published (heard or shown): add the exchange to the shared part and tell the game when the level changed. `userText`: the spoken
   * transcript when there is one. Returns the change {profileKey, name, from, to, title} or null. Never throws. In a group round only the first speaker
   * records (one line of V's, one exchange).
   */
  recordTurn(input, userText, facts = {}) {
    try {
      if (input?.group && input.group.index !== 1) return null;
      const before = this.#view(input, facts);
      if (!before) return null;
      const words = typeof userText === 'string' && userText.trim() ? userText : input.text;
      const value = exchangeValue(channelOf(input), words);
      const name = typeof input.name === 'string' ? input.name.slice(0, 80) : '';
      const arc = arcCounts(input.profileKey, input.journalHistory, this.arcs ?? undefined);
      const added = this.store.add(before.key, value, {gameSeconds: before.gameSeconds, nowMs: this.now(),
        meta: {profileKey: input.profileKey, name, story: before.story.points, arcDone: arc.done, arcTotal: arc.total}});
      if (!added) return null;
      if (before.gameSeconds !== undefined) this.clock = before.gameSeconds;
      const shared = sharedPart(added.entry, before.gameSeconds);
      const points = clamp(before.story.points + shared, 0, MAX_POINTS);
      const level = levelOf(points);
      this.log(`profile=${input.profileKey} channel=${channelOf(input)} story=${before.story.points} (arc ${before.story.arc}, romance ${before.story.romance}, money ${before.story.money}) shared=${shared}`
        + ` gained=${added.gained}${value.threat ? ` hurt=${value.hurt}(${value.threat})` : ''} level=${level.level}`);
      // The level the game knows: the first turn of a character this session only sets it (no notice for a level V already had).
      const known = this.levels.get(before.key);
      const from = known ? known.level : before.level;
      this.levels.set(before.key, {profileKey: input.profileKey, name, level: level.level, points});
      let change = null;
      if (level.level !== from) {
        change = {id: ++this.revision, profileKey: input.profileKey, name, from, to: level.level, title: level.title};
        this.changes.push(change);
        while (this.changes.length > CHANGE_LIMIT) this.changes.shift();
      }
      // The Relationships page reads the status when it opens, so every recorded turn refreshes it (a small atomic write, after the reply is out).
      this.publish();
      return change;
    } catch (error) {
      this.log(`record failed: ${String(error?.message ?? error).slice(0, 120)}`);
      return null;
    }
  }

  /** A finished pack's reward (docs 7.3): points onto the shared part of this character. */
  award(profileKey, points, gameSeconds) {
    const key = this.store.memoryKey(profileKey);
    if (!key || !bondable(profileKey)) return false;
    const done = this.store.award(key, points, {gameSeconds});
    if (done) this.publish();
    return !!done;
  }

  /** Forget (the memory reset): the shared part of these characters, and their known levels. */
  forget(options = {}) {
    const removed = this.store.forget(options);
    this.lines.clear();
    if (options.all) {
      const mine = options.scope || '';
      for (const key of [...this.levels.keys()]) if (scopeOf(key) === mine) this.levels.delete(key);
    } else for (const key of options.profileKeys ?? []) this.levels.delete(key);
    if (removed) this.publish();
    return removed;
  }

  /** The characters V has interacted with, most recent first, for the Relationships page (one row per profile). */
  characters() {
    const seen = new Map();
    for (const entry of this.store.entries.values()) {
      if (!entry.profileKey || !(entry.lastAt > 0)) continue;
      const known = seen.get(entry.profileKey);
      if (!known || entry.lastAt > known.lastAt) seen.set(entry.profileKey, entry);
    }
    const rows = [...seen.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, CHARACTER_LIMIT);
    return rows.map(entry => {
      const clock = this.clock ?? entry.seenAt ?? undefined;
      const hurt = fadedHurt(entry, clock), shared = sharedPart(entry, clock);
      const points = clamp(entry.story + shared, 0, MAX_POINTS), row = levelOf(points);
      const next = LEVELS.find(item => item.level === row.level + 1);
      return {profileKey: entry.profileKey, name: entry.name || entry.profileKey, level: row.level, title: row.title, points, from: row.from, next: next ? next.from : null,
        warm: Math.round(entry.warm), hurt: Math.round(hurt), hurtDays: hurt >= 1 ? Math.ceil(HURT_HALF_LIFE_DAYS * Math.log2(hurt)) : 0,
        story: entry.story, talk: shared, arcDone: entry.arcDone, arcTotal: entry.arcTotal, lastAt: entry.lastAt,
        packs: this.packSource?.list?.(entry.profileKey) ?? []};
    });
  }

  /** The status the game reads (mod/bonds.lua): the revision, the levels known this session, the last changes, the characters V has met and the active packs. */
  status() {
    const levels = {};
    for (const row of this.levels.values()) levels[row.profileKey] = {level: row.level, title: levelOf(row.points).title};
    return {version: 1, revision: this.revision, levels, changes: this.changes.map(change => ({...change})),
      characters: this.characters(), packs: this.packSource?.active?.() ?? {}, effectsRevision: this.packSource?.effectsRevision?.() ?? 0,
      playRevision: this.packSource?.playRevision?.() ?? 0};
  }

  /** Write the status file (after a recorded turn, a level change or a pack change). Never awaited by a turn. */
  publish() {
    if (!this.statusPath) return;
    const text = JSON.stringify(this.status());
    this.statusChain = this.statusChain.then(() => this.write(this.statusPath, text)).catch(error => {
      this.log(`status not written: ${String(error?.message ?? error).slice(0, 120)}`);
    });
  }
}
