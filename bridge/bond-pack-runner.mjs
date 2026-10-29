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
import {atomicFile} from './guarded-file.mjs';
import {packGate, validatePack, shippedPacks, blockingPrefixes, KNOWN_STAGE_TYPES, CHANNELS} from './bond-packs.mjs';
import {intentKind} from './bond-intent.mjs';
import {debts} from './eddies.mjs';
import {channelOf} from './bonds.mjs';
import {questStates, inventoryComplete} from './bonds.mjs';

const DAY = 86400, HOUR = 3600;
/** Game seconds of slack before an entry counts as later than the loaded save (the clock read and the stamp are a moment apart). */
export const ROLLBACK_SLACK = 120;
export const MAX_ACTIVE = 2;
export const COOLDOWN_DAYS = 7;
export const ENDING_NOTE_DAYS = 3;
const MAX_FILE_CHARS = 1_000_000;
const MAX_STEPS = 8;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;

/** The packs shipped with the mod, or none when the folder is not there (a Runtime without them). */
function shippedOrNone() { try { return shippedPacks().map(row => row.pack); } catch { return []; } }
/** A turn's id: a talk turn's request id, a Phone Chat message's id. */
const turnId = input => typeof input?.requestId === 'string' && input.requestId ? input.requestId : typeof input?.id === 'string' && input.id ? input.id : null;
const WHERE = {here: 'where V is', home: 'at V\'s place, where you live now', waypoint: 'at the spot V marks on the map'};

export class BondPacks {
  /**
   * packs     the packs (validated here; an invalid one is left out and logged)    characters   the roster keys (a Set) for the validator
   * path      <state>/bond-packs.json                                              effectsPath  runtime/bond-effects.json
   * bonds     the Bonds object (award points, publish the status)                  random, now, read, write, timers   injectable for tests
   */
  constructor({packs = shippedOrNone(), characters = null, path = null, effectsPath = null, bonds = null, random = Math.random,
    now = Date.now, read = file => readFile(file, 'utf8'), write = (file, text) => atomicFile(file, text), log = () => {}, debounceMs = 5000,
    timers = {set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle)}} = {}) {
    Object.assign(this, {path, effectsPath, bonds, random, now, read, write, log, debounceMs, timers, characters});
    this.packs = new Map();
    for (const pack of packs) {
      const result = validatePack(pack, {characters});
      if (!result.ok) { log(`pack ${pack?.id} left out: ${result.errors[0]}`); continue; }
      this.packs.set(pack.id, pack);
    }
    this.entries = new Map();      // pack id -> {status, trail, ...}
    this.meta = new Map();         // profile key -> {rolled, endedAt}
    this.turns = new Map();        // request id -> the turn's decision
    this.loggedTypes = new Set();
    this.timer = null; this.dirty = false; this.chain = Promise.resolve();
    this.effectsText = ''; this.effectsRevision = 0; this.effectsChain = Promise.resolve();
    this.on = false;               // Story packs was on at the last turn (a meeting's outcome moves a pack only then)
    this.lastClock = undefined;
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
      if (plain(row) && /^[a-z0-9][a-z0-9-]{0,79}$/.test(key) && !this.meta.has(key)) this.meta.set(key, {rolled: whole(row.rolled) ? row.rolled : null, endedAt: whole(row.endedAt) ? row.endedAt : null});
    }
    this.#effects();
    return this.entries.size;
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
    return {status: ended ? 'done' : 'active', trail, presented: row.presented === true, beat: whole(row.beat) ? row.beat : null};
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
      for (const [id, entry] of this.entries) entries[id] = {trail: entry.trail, presented: entry.presented, beat: entry.beat};
      for (const [key, row] of this.meta) meta[key] = row;
      if (await this.write(this.path, JSON.stringify({version: 1, entries, meta})) === false) this.dirty = true;
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
      entry.status = 'active'; entry.presented = true; entry.beat = null;
    }
    for (const row of this.meta.values()) {
      if (row.rolled !== null && row.rolled > Math.floor((gameSeconds + ROLLBACK_SLACK) / DAY)) { row.rolled = null; changed = true; }
      if (row.endedAt !== null && row.endedAt > gameSeconds + ROLLBACK_SLACK) { row.endedAt = null; changed = true; }
    }
    if (changed) { this.#schedule(); this.#effects(); }
    return changed;
  }

  // ---- moving through a pack ---------------------------------------------------------------------------------------------------------------

  #finish(pack, entry, endingId, gameSeconds, choice) {
    const ending = pack.endings[endingId];
    entry.trail.push({stage: endingId, at: gameSeconds ?? null, ...(choice ? {choice} : {}), ending: true});
    entry.status = 'done';
    const meta = this.meta.get(pack.character) ?? {rolled: null, endedAt: null};
    meta.endedAt = gameSeconds ?? null;
    this.meta.set(pack.character, meta);
    if (ending.bond) this.bonds?.award(pack.character, ending.bond, gameSeconds);
    this.log(`pack=${pack.id} ended ${endingId}${ending.bond ? ` bond ${ending.bond > 0 ? '+' : ''}${ending.bond}` : ''}`);
  }

  /** Move an active entry on to `next` (a stage or an ending). Follows stages that cannot be played (an unknown type) to the one after. */
  #go(pack, entry, next, gameSeconds, choice) {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (next in pack.endings) { this.#finish(pack, entry, next, gameSeconds, choice); break; }
      const stage = pack.stages.find(item => item.id === next);
      if (!stage) { this.#finish(pack, entry, Object.keys(pack.endings)[0], gameSeconds, choice); break; }
      entry.trail.push({stage: next, at: gameSeconds ?? null, ...(choice ? {choice} : {})});
      entry.presented = false; entry.beat = null;
      this.log(`pack=${pack.id} stage=${next}${choice ? ` via ${choice}` : ''}`);
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

  /** Whether the quests and the main story allow a pack in progress to move now (docs section 8, items 2 and 3). */
  #quietJournal(pack, journalHistory) {
    if (!inventoryComplete(journalHistory)) return false;
    const index = questStates(journalHistory);
    for (const prefix of blockingPrefixes(pack)) for (const [path, state] of index.byPath) if (state === 'active' && path.startsWith(prefix)) return false;
    return true;
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

  #decide(input, facts) {
    const bonds = input?.bonds;
    if (!bonds?.on || !bonds.packs || input.reaction || input.head || input.event || !this.packs.size) return null;
    this.on = true;
    const profile = input.profileKey, channel = channelOf(input);
    const mine = this.#packsOf(profile);
    if (!mine.length) return null;
    const gameSeconds = Number.isSafeInteger(input.turnContext?.gameTime) && input.turnContext.gameTime >= 0 ? input.turnContext.gameTime : undefined;
    this.rewind(gameSeconds);
    if (gameSeconds !== undefined) this.lastClock = gameSeconds;
    const lines = [];
    // What the character keeps from a pack that ended in the last days (talk: any private channel, the game's own copy of the character too).
    for (const pack of mine) {
      const entry = this.entries.get(pack.id);
      if (entry?.status !== 'done' || !whole(gameSeconds)) continue;
      const last = entry.trail.at(-1);
      if (whole(last.at) && gameSeconds >= last.at && gameSeconds - last.at <= ENDING_NOTE_DAYS * DAY) lines.push(`Something you remember about V: ${pack.endings[last.stage].memory}`);
    }
    const allowed = CHANNELS.includes(channel);
    const decision = {note: '', story: null, evaluate: false, pack: null, entry: null, start: null, gameSeconds, channel, eddiesRow: input.eddies?.row ?? null};
    const activeRow = mine.map(pack => [pack, this.entries.get(pack.id)]).find(([, entry]) => entry?.status === 'active');
    if (activeRow && allowed) {
      const [pack, entry] = activeRow;
      // Paused (no new stage, no timer) while the character has a quest of their own going, the story is at its end, or the game is busy.
      const paused = bonds.busy === true || !this.#quietJournal(pack, input.journalHistory);
      if (!paused) {
        decision.evaluate = entry.presented === true;
        this.#resolve(pack, entry, {gameSeconds, eddiesRow: decision.eddiesRow});
        if (entry.status === 'active') {
          const stage = this.#stageOf(pack, entry);
          decision.pack = pack; decision.entry = entry;
          // A stage reached just now was not shown yet, so V's words this turn do not answer it.
          if (!entry.presented) decision.evaluate = false;
          lines.unshift(this.#stageNote(pack, stage, {channel, settings: {invitations: bonds.invitations === true}}));
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
        lines.unshift(`${start.pack.start.bringUp} ${this.#stageNote(start.pack, start.pack.stages[0], {channel, settings: {invitations: bonds.invitations === true}})}`);
        decision.story = this.#storyFacts(start.pack, start.pack.stages[0], null, {channel, gameSeconds, eddies: bonds.eddies === true});
      }
    }
    decision.note = lines.join('\n');
    return decision;
  }

  #tryStart(mine, input, {channel, gameSeconds, level, romance}) {
    const profile = input.profileKey, meta = this.meta.get(profile) ?? {rolled: null, endedAt: null};
    if (this.#active().length >= MAX_ACTIVE) return null;
    if (meta.endedAt !== null && gameSeconds - meta.endedAt < COOLDOWN_DAYS * DAY) return null;
    const today = Math.floor(gameSeconds / DAY);
    if (meta.rolled === today) return null;
    const finishedPacks = new Set([...this.entries].filter(([id, entry]) => entry.status === 'done' && this.packs.get(id)?.character === profile).map(([id]) => id));
    const bonds = input.bonds;
    for (const pack of mine) {
      if (this.entries.has(pack.id)) continue;
      const gate = packGate(pack, {level, journalHistory: input.journalHistory, romance, channel, finishedPacks, busy: bonds.busy === true,
        settings: {eddies: bonds.eddies === true, invitations: bonds.invitations === true}});
      if (!gate.open) continue;
      // The dice are thrown once a game day per character, only when a pack could start.
      meta.rolled = today; this.meta.set(profile, meta); this.#schedule();
      if (this.random() >= pack.start.chance) return null;
      return {pack};
    }
    return null;
  }

  /** The words the character is given for a stage. Second person, no pack or stage talk. */
  #stageNote(pack, stage, {channel, settings}) {
    const parts = [`What is going on between you and V right now (your own story with V, never call it a story, a quest or a stage): ${stage.know}`];
    if (stage.wants) parts.push(`What you want from V: ${stage.wants}`);
    if (stage.meet) {
      parts.push(settings.invitations || pack.requires?.invitations !== true
        ? `You would like V to meet you ${WHERE[stage.meet.where]}, within about ${stage.meet.inGameHours} game hours. V arranges it with you in V's own words.`
        : 'You would like to meet V, but meetings cannot be arranged now: say you will sort it out yourself.');
    }
    if (stage.ask && channel !== 'own') parts.push('Eddies can only change hands when V is with you in person: if V offers money, say V should come to you.');
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
        if (this.entries.has(pack.id)) return;
        const entry = {status: 'active', trail: [{stage: pack.stages[0].id, at: gameSeconds ?? null}], presented: true, beat: null};
        this.entries.set(pack.id, entry);
        this.log(`pack=${pack.id} started on ${decision.channel} (stage ${pack.stages[0].id})`);
        this.#schedule(); this.#effects();
        return;
      }
      const entry = this.entries.get(pack.id);
      if (!entry || entry !== decision.entry || entry.status !== 'active') return;
      const stage = this.#stageOf(pack, entry);
      if (!stage) return;
      if (decision.story?.repay?.due && proposal?.story === decision.story.tag) { entry.beat = gameSeconds ?? null; this.#schedule(); }
      const moneyTurn = !!proposal?.story;
      if (decision.evaluate && !moneyTurn) {
        const tags = (stage.choices ?? []).filter(choice => choice.on === 'tag');
        const words = typeof userText === 'string' && userText.trim() ? userText : input.text;
        const kind = tags.length ? intentKind(words, tags.map(choice => choice.kind)) : null;
        const choice = kind ? tags.find(item => item.kind === kind) : null;
        if (choice) { this.#go(pack, entry, choice.next, gameSeconds, choice.id); return; }
      }
      if (!entry.presented) { entry.presented = true; this.#schedule(); }
    } catch (error) {
      this.log(`record failed: ${String(error?.message ?? error).slice(0, 120)}`);
    }
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
        if (choice) { this.#go(pack, entry, choice.next, gameSeconds, choice.id); return choice.id; }
      }
    } catch (error) { this.log(`meeting failed: ${String(error?.message ?? error).slice(0, 120)}`); }
    return null;
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
    };
  }
}
