// Time since V last talked to a character (Settings > Dynamic info > Time since last talk; docs/DYNAMIC_INFO.md).
//
// A character knows how long it has been since V last talked to it: the gap in the game ("since last night") and in real days ("it's been days", for the
// player who comes back after a week with hardly any game time passed). The game side sends the game clock with the turn-context snapshot
// (mod/turn-context.lua, whole game seconds since the game's epoch), this module keeps one entry per MEMORY KEY, {gameSeconds, realMs}, words the gap
// and then records this talk as the new last one.
//
// Per memory key, not per profile key: a content pack with a separate memory keeps its own characters (`judy-alvarez@medieval`, bridge/memory-scope.mjs),
// and the two Judys never share a "last talked". Forget clears the entries the same way it clears the memory (convai-bridge.mjs quiescePlayerMemory).
//
// What stops the model repeating it: a turn's context is built several times (the prepared reply, the look-ahead, the turn, the log line), so the sentence
// is decided ONCE per turn id (the first build reads the previous entry, words the gap, records "now" and remembers the sentence; later builds of the same
// turn get the same sentence). Every turn then moves the entry to now, so the next turn of the same conversation sees a gap of minutes and says nothing.
// It is only said when the gap is meaningful (about 3 game hours or 30 real minutes, and real days when V was away), as a short Background line that
// ends by telling the character not to dwell on it (the scenery lesson of docs/DYNAMIC_CONTEXT_AUDIT.md: a fact that arrives fresh on every turn gets
// reacted to on every turn).
//
// Only a manual turn with a named character counts (and a housemate's 'house' reaction, the welcome): an automatic reaction (a battle, loot, a head remark, a speak-up line) is not V talking, an ordinary
// NPC (resident, archetype) is a stranger with no memory of V, and an add-on speaker is not one of the mod's characters. Phone chat, holocalls, group
// rounds (each addressed speaker) and Johnny in V's head all count, under the character's own key.
//
// Cost on the turn path: a Map lookup, a few divisions and a string; the entry is saved to a small file by a debounced, atomic, asynchronous write that
// no turn waits for (and flushed at shutdown). A missing or damaged file starts empty.
import {readFile} from 'node:fs/promises';
import {atomicFile} from './guarded-file.mjs';
import {dayPart} from './turn-context.mjs';
import {MEMORY_KEY, scopeOf} from './memory-scope.mjs';
import {dynamicInfo} from './dynamic-info.mjs';

/** The game clock the game side sent (whole game seconds), or undefined. */
export function parseGameTime(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// ---- the wording ------------------------------------------------------------------------------------------------------------------------------
const HOUR = 3600, DAY = 86400;
/** Under this much game time AND this much real time since the last talk, nothing is said. */
export const MIN_GAME_GAP = 3 * HOUR;
export const MIN_REAL_GAP_MS = 30 * 60_000;
/** A real gap of about a day (20 hours) or more is worded as real time. */
export const REAL_DAY_MS = 20 * 3600_000;
const NUMBER = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

// The part of the day the last talk was in (the same boundaries as the clock sentence, bridge/turn-context.mjs dayPart), said for the same day and for yesterday.
const TODAY = {'late night': 'in the small hours today', 'early morning': 'early this morning', morning: 'earlier this morning', midday: 'around midday today',
  afternoon: 'earlier this afternoon', evening: 'earlier this evening', night: 'earlier tonight'};
const YESTERDAY = {'late night': 'yesterday in the small hours', 'early morning': 'early yesterday morning', morning: 'yesterday morning', midday: 'around midday yesterday',
  afternoon: 'yesterday afternoon', evening: 'yesterday evening', night: 'last night'};

/** How long ago in the game, as a phrase, or null (under the minimum, or the clock went backwards). `days`: the calendar days between. */
function gamePhrase(before, now) {
  const gap = now - before;
  if (!(gap >= MIN_GAME_GAP)) return null;
  const days = Math.floor(now / DAY) - Math.floor(before / DAY);
  const part = dayPart(Math.floor(before / HOUR) % 24);
  let text;
  if (days <= 0) text = TODAY[part];
  else if (days === 1) text = part === dayPart(Math.floor(now / HOUR) % 24) ? 'around this time yesterday' : YESTERDAY[part];
  else if (days < 7) text = `${days === 2 ? 'a couple of' : NUMBER[days]} days ago in the game`;
  else if (days < 14) text = 'over a week ago in the game';
  else if (days < 30) text = `about ${NUMBER[Math.round(days / 7)]} weeks ago in the game`;
  else if (days < 60) text = 'over a month ago in the game';
  else if (days < 365) text = `about ${NUMBER[Math.min(12, Math.round(days / 30))]} months ago in the game`;
  else text = 'a very long time ago in the game';
  return {text, days};
}

/** How long ago in real time, as a phrase ("about a week"), or null under about a day. */
function realPhrase(ms) {
  if (!(ms >= REAL_DAY_MS)) return null;
  const days = Math.max(1, Math.round(ms / 86_400_000));
  let text;
  if (days === 1) text = 'about a day';
  else if (days === 2) text = 'a couple of days';
  else if (days < 7) text = `${NUMBER[days]} days`;
  else if (days < 14) text = 'about a week';
  else if (days < 28) text = `about ${NUMBER[Math.round(days / 7)]} weeks`;
  else if (days < 60) text = 'about a month';
  else if (days < 365) text = `about ${NUMBER[Math.min(12, Math.round(days / 30))]} months`;
  else text = 'over a year';
  return {text, days};
}

const DONT_DWELL = ' Mention it only if it fits; do not bring it up again.';

/**
 * The sentence for the gap between a character's last talk with V and this one, or ''. `previous`: {gameSeconds, realMs} (none: the first talk, nothing is said);
 * `gameSeconds`, `nowMs`: this talk. Both clocks are used: the game gap says "since last night" (derived from the day parts of the two moments), the real gap says
 * how long V was away. A game clock that went BACKWARDS (an older save was loaded) says nothing about the game and leaves the real wording.
 */
export function describeGap({previous, gameSeconds, nowMs} = {}) {
  if (!previous) return '';
  const bothClocks = Number.isSafeInteger(previous.gameSeconds) && Number.isSafeInteger(gameSeconds) && previous.gameSeconds >= 0 && gameSeconds >= 0;
  const forward = bothClocks && gameSeconds >= previous.gameSeconds;
  const game = forward ? gamePhrase(previous.gameSeconds, gameSeconds) : null;
  const gap = Number.isFinite(previous.realMs) && Number.isFinite(nowMs) ? Math.max(0, nowMs - previous.realMs) : 0;
  const real = realPhrase(gap);
  let text;
  if (game && real && (game.days < 2 || real.days >= 3)) text = `You last talked with V ${game.text}; in real time that was ${real.text} ago.`;
  else if (game) text = `You last talked with V ${game.text}.`;
  else if (real) {
    text = forward ? `You last talked with V ${real.text} ago in real time, though hardly any time has passed in the game since: V has been away from the game.`
      : `You last talked with V ${real.text} ago in real time.`;
  } else if (gap >= MIN_REAL_GAP_MS) text = 'You last talked with V a little while ago.';
  else return '';
  return text + DONT_DWELL;
}

// ---- the store --------------------------------------------------------------------------------------------------------------------------------
const AMBIENT = /^(?:resident-male|resident-female|npc-[a-z0-9-]+)$/;   // the same rule as isAmbientProfile (bridge/protocol.mjs; a test pins them together)
const MAX_FILE_CHARS = 2_000_000;
const SETTABLE = ['path', 'keyFor', 'now', 'enabled', 'limit', 'debounceMs', 'read', 'write', 'timers', 'log'];

export class LastTalk {
  /**
   * path     the JSON file the entries are kept in (none: kept in memory only)
   * keyFor   profile key -> memory key (memoryScopes(...).keyFor), so a content pack's characters have entries of their own
   * now      the real clock in ms
   * enabled  false while Dynamic info > Time since last talk is off: nothing is read, said or stored then
   * read, write, timers   the file access and timers, injectable for tests
   */
  constructor({path = null, keyFor = key => key, now = Date.now, enabled = () => true, limit = 512, debounceMs = 10_000, turns = 64,
    read = file => readFile(file, 'utf8'), write = (file, text) => atomicFile(file, text),
    timers = {set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle)}, log = null} = {}) {
    Object.assign(this, {path, keyFor, now, enabled, limit, debounceMs, turnLimit: turns, read, write, timers, log});
    this.entries = new Map();   // memory key -> {gameSeconds, realMs}, least recently talked first
    this.turns = new Map();     // `<turn id>|<profile key>` -> the sentence that turn got
    this.timer = null; this.dirty = false; this.chain = Promise.resolve();
  }

  /** Set the options (any of the constructor's) and read the saved file; resolves when the file has been read (never rejects). */
  async configure(options = {}) {
    for (const name of SETTABLE) if (options[name] !== undefined) this[name] = options[name];
    return this.load();
  }

  /** Read the saved entries (a missing or damaged file starts empty). Entries recorded meanwhile win. Returns how many were loaded. */
  async load() {
    if (!this.path) return 0;
    let rows;
    try {
      const text = await this.read(this.path);
      if (typeof text !== 'string' || text.length > MAX_FILE_CHARS) return 0;
      rows = JSON.parse(text)?.entries;
    } catch { return 0; }
    if (!Array.isArray(rows)) return 0;
    const loaded = new Map();
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const [key, gameSeconds, realMs] = row;
      if (typeof key !== 'string' || !MEMORY_KEY.test(key) || !Number.isSafeInteger(gameSeconds) || gameSeconds < 0 || !Number.isFinite(realMs) || realMs < 0) continue;
      loaded.delete(key); loaded.set(key, {gameSeconds, realMs});
    }
    for (const [key, entry] of this.entries) { loaded.delete(key); loaded.set(key, entry); }
    this.entries = loaded;
    this.#trim();
    return loaded.size;
  }

  /** The entry of a memory key, or undefined. */
  peek(key) { return this.entries.get(key); }
  get size() { return this.entries.size; }

  /** V talked to this memory key now. Nothing waits for the disk: the write is scheduled. */
  record(key, gameSeconds, realMs = this.now()) {
    if (typeof key !== 'string' || !MEMORY_KEY.test(key) || !Number.isSafeInteger(gameSeconds) || gameSeconds < 0 || !Number.isFinite(realMs)) return false;
    this.entries.delete(key); this.entries.set(key, {gameSeconds, realMs});
    this.#trim();
    this.dirty = true; this.#schedule();
    return true;
  }

  /**
   * The sentence for this turn, '' when there is nothing to say. Called on every build of a turn's context: the first call per turn id reads the previous entry,
   * words the gap and records this talk; the others return the same sentence.
   */
  sentenceFor(input) {
    // An automatic reaction is not V talking, except a housemate's ('house': the welcome when V comes home, a chat with V: bridge of the housemates feature),
    // which is a talk with V and may say "haven't seen you since last night".
    if (!input || (input.reaction && input.reaction.kind !== 'house') || !this.enabled()) return '';
    const profileKey = input.profileKey, turn = input.requestId ?? input.id;
    if (typeof profileKey !== 'string' || !profileKey || AMBIENT.test(profileKey) || profileKey.startsWith('addon-')) return '';
    if (typeof turn !== 'string' || !turn) return '';
    const seen = `${turn}|${profileKey}`, same = this.turns.get(seen);
    if (same !== undefined) return same;
    const gameSeconds = parseGameTime(input.turnContext?.gameTime);
    if (gameSeconds === undefined) return '';   // no clock this turn: nothing to compare and nothing to record
    let key;
    try { key = this.keyFor(profileKey); } catch { return ''; }
    if (typeof key !== 'string' || !MEMORY_KEY.test(key)) return '';
    const nowMs = this.now(), sentence = describeGap({previous: this.entries.get(key), gameSeconds, nowMs});
    this.record(key, gameSeconds, nowMs);
    this.turns.set(seen, sentence);
    while (this.turns.size > this.turnLimit) this.turns.delete(this.turns.keys().next().value);
    return sentence;
  }

  /** Forget: the entries of these memory keys, or (`all`) of the whole memory `scope` ('' or null: the normal one, else a content pack's), like MemoryStore.forget. */
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

  /** Write what is unsaved now (shutdown); resolves when the file is written. Writes are one at a time. */
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
      const rows = [...this.entries].map(([key, entry]) => [key, entry.gameSeconds, entry.realMs]);
      if (await this.write(this.path, JSON.stringify({version: 1, entries: rows})) === false) this.dirty = true;
    } catch (error) {
      this.dirty = true;
      this.log?.(`Last talk: could not save (${String(error?.message ?? error).slice(0, 120)})`);
    }
  }
}

/** The one store the turn's context builders ask; the bridge points it at its state file and the memory keys at startup (convai-bridge.mjs). */
export const lastTalk = new LastTalk({enabled: () => dynamicInfo.on('lastTalk')});

/** The one sentence about the gap since this character was last talked to, or ''. Built once per turn id. */
export function lastTalkSentence(input) { return lastTalk.sentenceFor(input); }
