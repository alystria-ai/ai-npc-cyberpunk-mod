// Story packs (docs/RELATIONSHIPS_AND_QUESTS.md, section 7): short arcs a character starts at a bond threshold once their own story is done.
//
// Phase 1 holds the FORMAT only: the validator every pack file must pass (shipped packs in characters/bond-packs/, and later a content pack's
// bond-packs/ folder), and the plot-safety gate (section 8) as a pure function. Nothing here runs in a turn yet: the runner (start, notes, choice
// tags, timers, endings, the rollback-guarded state) is phase 2. No I/O except reading the shipped folder when asked.
import {readFileSync, readdirSync} from 'node:fs';
import {EDDIES_CAP, FLOWS} from './eddies.mjs';
import {shippedBondArcs, inventoryComplete, questState, questStates, finished} from './bonds.mjs';

export const PACK_FORMAT = 1;
export const PACK_LIMITS = Object.freeze({stages: 8, choices: 4, effects: 4, know: 600, wants: 300, bringUp: 400, memory: 300, line: 240,
  title: 80, summary: 200, paths: 24, gameHours: 24 * 14, bondReward: 150});
export const CHANNELS = Object.freeze(['own', 'phone', 'holocall']);
export const RELATIONSHIPS = Object.freeze(['any', 'partner', 'not-partner']);
export const EFFECTS = Object.freeze(['vehicleBlocked', 'vehicleReturned', 'outfit', 'giveItem', 'takeItem']);
export const MEET_PLACES = Object.freeze(['here', 'home', 'waypoint']);
/** How a choice is taken: the character's tag (checked against V's words), an Eddies transfer of a flow, or an invitation's outcome. */
export const CHOICE_ON = /^(?:tag|eddies:(?:loanToV|loanFromV|repayByV|repayToV|giftFromV|giftToV)|meet:(?:met|stood-up))$/;
const ID = /^[a-z][a-z0-9-]{2,47}$/;
const STAGE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const PROFILE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PATH = /^(?:ep1\/)?quests\/[a-z0-9_/]{3,160}$/;
const LANGUAGE = /^[a-z]{2}(?:-[a-z]{2})?$/;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max && !/[\u0000-\u0008\u000b-\u001f]/.test(value);

/**
 * Checks one pack. `characters`: the profile keys that exist (a Set); `arcs`: the bond arcs data. Returns {ok, errors}: every error found, each a short
 * English sentence with the place ("stage ask: ...").
 */
export function validatePack(pack, {characters = null, arcs = shippedBondArcs()} = {}) {
  const errors = [];
  const fail = message => { errors.push(message); };
  if (!plain(pack)) return {ok: false, errors: ['the pack is not an object']};
  if (pack.format !== PACK_FORMAT) fail(`format must be ${PACK_FORMAT}`);
  if (typeof pack.id !== 'string' || !ID.test(pack.id)) fail('id must be 3 to 48 lowercase letters, digits or hyphens, starting with a letter');
  if (typeof pack.character !== 'string' || !PROFILE.test(pack.character)) fail('character must be a profile key');
  else if (characters && !characters.has(pack.character)) fail(`character ${pack.character} is not on the roster`);
  if (!text(pack.title, PACK_LIMITS.title)) fail(`title must be 1 to ${PACK_LIMITS.title} characters`);
  if (pack.summary !== undefined && !text(pack.summary, PACK_LIMITS.summary)) fail(`summary must be 1 to ${PACK_LIMITS.summary} characters`);

  // The gate.
  const requires = pack.requires;
  if (!plain(requires)) fail('requires must be an object');
  const pathList = (value, name, prefixes = false) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > PACK_LIMITS.paths || value.some(path => typeof path !== 'string' || !PATH.test(path))) {
      fail(`requires.${name} must be a list of up to ${PACK_LIMITS.paths} journal ${prefixes ? 'path prefixes' : 'paths'}`);
      return [];
    }
    return value;
  };
  const done = plain(requires) ? pathList(requires.questsFinished, 'questsFinished') : [];
  const succeeded = plain(requires) ? pathList(requires.questsSucceeded, 'questsSucceeded') : [];
  if (plain(requires)) {
    pathList(requires.notActive, 'notActive', true);
    if (requires.bond !== undefined && !(Number.isInteger(requires.bond) && requires.bond >= 1 && requires.bond <= 10)) fail('requires.bond must be a level from 1 to 10');
    if (requires.relationship !== undefined && !RELATIONSHIPS.includes(requires.relationship)) fail(`requires.relationship must be one of ${RELATIONSHIPS.join(', ')}`);
    if (requires.eddies !== undefined && typeof requires.eddies !== 'boolean') fail('requires.eddies must be true or false');
    if (requires.invitations !== undefined && typeof requires.invitations !== 'boolean') fail('requires.invitations must be true or false');
    if (requires.after !== undefined && (!Array.isArray(requires.after) || requires.after.some(id => typeof id !== 'string' || !ID.test(id)))) fail('requires.after must be a list of pack ids');
    // A story character's pack starts only after their story: it must name at least one finished quest.
    if (arcs?.arcs?.[pack.character] && done.length + succeeded.length === 0) fail(`requires.questsFinished must name at least one of ${pack.character}'s quests`);
  }

  // How it starts.
  const start = pack.start;
  if (!plain(start)) fail('start must be an object');
  else {
    if (!Array.isArray(start.channels) || start.channels.length === 0 || start.channels.some(channel => !CHANNELS.includes(channel))) fail(`start.channels must list some of ${CHANNELS.join(', ')}`);
    if (!(typeof start.chance === 'number' && start.chance > 0 && start.chance <= 1)) fail('start.chance must be above 0 and at most 1');
    if (!text(start.bringUp, PACK_LIMITS.bringUp)) fail(`start.bringUp must be 1 to ${PACK_LIMITS.bringUp} characters`);
  }

  // The stages and endings.
  const stages = Array.isArray(pack.stages) ? pack.stages : null;
  const endings = plain(pack.endings) ? pack.endings : null;
  if (!stages || stages.length === 0 || stages.length > PACK_LIMITS.stages) fail(`stages must be a list of 1 to ${PACK_LIMITS.stages} stages`);
  if (!endings || Object.keys(endings).length === 0) fail('endings must name at least one ending');
  const stageIds = new Set(), endingIds = new Set(Object.keys(endings ?? {}));
  for (const id of endingIds) if (!STAGE_ID.test(id)) fail(`ending ${id}: the id must be lowercase letters, digits or hyphens`);
  for (const stage of stages ?? []) {
    if (!plain(stage) || typeof stage.id !== 'string' || !STAGE_ID.test(stage.id)) { fail('every stage needs an id of lowercase letters, digits or hyphens'); continue; }
    if (stageIds.has(stage.id) || endingIds.has(stage.id)) fail(`stage ${stage.id}: the id is used twice`);
    stageIds.add(stage.id);
  }
  const hasEddiesAsk = (stages ?? []).some(stage => plain(stage?.ask) || (Array.isArray(stage?.choices) && stage.choices.some(choice => String(choice?.on).startsWith('eddies:'))));
  const hasMeet = (stages ?? []).some(stage => plain(stage?.meet) || (Array.isArray(stage?.choices) && stage.choices.some(choice => String(choice?.on).startsWith('meet:'))));
  if (hasEddiesAsk && requires?.eddies !== true) fail('a pack that asks for or waits on eddies must require eddies (requires.eddies: true)');
  const targets = new Map();   // stage id -> the ids it can lead to
  for (const stage of stages ?? []) {
    if (!plain(stage) || !STAGE_ID.test(stage?.id ?? '')) continue;
    const where = `stage ${stage.id}`, next = [];
    if (!text(stage.know, PACK_LIMITS.know)) fail(`${where}: know must be 1 to ${PACK_LIMITS.know} characters`);
    if (stage.wants !== undefined && !text(stage.wants, PACK_LIMITS.wants)) fail(`${where}: wants must be 1 to ${PACK_LIMITS.wants} characters`);
    if (stage.say !== undefined) checkLine(stage.say, `${where}: say`, fail);
    if (stage.text !== undefined) {
      if (!plain(stage.text) || stage.text.when !== 'start') fail(`${where}: text.when must be "start"`);
      else checkLine(stage.text.line, `${where}: text.line`, fail);
    }
    if (stage.ask !== undefined) {
      const ask = stage.ask;
      if (!plain(ask) || !FLOWS.includes(ask.flow) || !(Number.isSafeInteger(ask.amount) && ask.amount >= 1 && ask.amount <= EDDIES_CAP) || !text(ask.reason, 120)) {
        fail(`${where}: ask needs a known flow, a whole amount from 1 to ${EDDIES_CAP} and a reason of up to 120 characters`);
      }
    }
    if (stage.repay !== undefined && !(plain(stage.repay) && Number.isSafeInteger(stage.repay.part) && stage.repay.part >= 1 && stage.repay.part <= EDDIES_CAP)) {
      fail(`${where}: repay.part must be a whole amount from 1 to ${EDDIES_CAP}`);
    }
    if (stage.meet !== undefined) {
      const meet = stage.meet;
      if (!plain(meet) || !MEET_PLACES.includes(meet.where) || !(Number.isFinite(meet.inGameHours) && meet.inGameHours >= 0 && meet.inGameHours <= 48)) {
        fail(`${where}: meet needs where (${MEET_PLACES.join(', ')}) and inGameHours from 0 to 48`);
      }
    }
    if (stage.effects !== undefined) {
      if (!Array.isArray(stage.effects) || stage.effects.length > PACK_LIMITS.effects) fail(`${where}: effects must be a list of up to ${PACK_LIMITS.effects}`);
      else for (const effect of stage.effects) {
        if (!plain(effect) || !EFFECTS.includes(effect.kind)) { fail(`${where}: an effect must be one of ${EFFECTS.join(', ')}`); continue; }
        if ((effect.kind === 'giveItem' || effect.kind === 'takeItem') && !(typeof effect.record === 'string' && /^Items\.[A-Za-z0-9_]{2,80}$/.test(effect.record)
          && Number.isSafeInteger(effect.quantity ?? 1) && (effect.quantity ?? 1) >= 1 && (effect.quantity ?? 1) <= 10)) {
          fail(`${where}: ${effect.kind} needs an Items.* record and a quantity from 1 to 10`);
        }
      }
    }
    if (stage.choices !== undefined) {
      if (!Array.isArray(stage.choices) || stage.choices.length === 0 || stage.choices.length > PACK_LIMITS.choices) fail(`${where}: choices must be a list of 1 to ${PACK_LIMITS.choices}`);
      else {
        const seen = new Set();
        for (const choice of stage.choices) {
          if (!plain(choice) || typeof choice.id !== 'string' || !STAGE_ID.test(choice.id) || seen.has(choice.id)) { fail(`${where}: every choice needs its own id`); continue; }
          seen.add(choice.id);
          if (typeof choice.on !== 'string' || !CHOICE_ON.test(choice.on)) fail(`${where}: choice ${choice.id}: on must be tag, eddies:<flow> or meet:met / meet:stood-up`);
          if (choice.on === 'tag' && !text(choice.means, 200)) fail(`${where}: choice ${choice.id}: a tag choice needs means (what V does, up to 200 characters)`);
          if (String(choice.on).startsWith('meet:') && !plain(stage.meet)) fail(`${where}: choice ${choice.id}: a meeting outcome needs a meet in the stage`);
          next.push(choice.next);
        }
      }
    }
    if (stage.timeout !== undefined) {
      if (!plain(stage.timeout) || !(Number.isFinite(stage.timeout.gameHours) && stage.timeout.gameHours > 0 && stage.timeout.gameHours <= PACK_LIMITS.gameHours)) {
        fail(`${where}: timeout.gameHours must be above 0 and at most ${PACK_LIMITS.gameHours}`);
      }
      next.push(stage.timeout?.next);
    }
    if (stage.next !== undefined) next.push(stage.next);
    if (next.length === 0) fail(`${where}: a stage must lead somewhere (choices, a timeout or next)`);
    for (const id of next) if (typeof id !== 'string' || (!stageIds.has(id) && !endingIds.has(id))) fail(`${where}: next ${JSON.stringify(id)} is neither a stage nor an ending`);
    targets.set(stage.id, next.filter(id => typeof id === 'string'));
  }
  for (const [id, ending] of Object.entries(endings ?? {})) {
    if (!plain(ending) || !text(ending.memory, PACK_LIMITS.memory)) fail(`ending ${id}: memory must be 1 to ${PACK_LIMITS.memory} characters`);
    if (ending?.bond !== undefined && !(Number.isInteger(ending.bond) && Math.abs(ending.bond) <= PACK_LIMITS.bondReward)) fail(`ending ${id}: bond must be a whole number from -${PACK_LIMITS.bondReward} to ${PACK_LIMITS.bondReward}`);
  }
  // Every stage is reachable from the first, every ending is reachable, and every stage can reach an ending (the arc always ends).
  if (stages?.length && plain(stages[0]) && targets.size === stageIds.size) {
    const reach = new Set([stages[0].id]), queue = [stages[0].id];
    while (queue.length) for (const id of targets.get(queue.shift()) ?? []) if (!reach.has(id)) { reach.add(id); if (targets.has(id)) queue.push(id); }
    for (const id of stageIds) if (!reach.has(id)) fail(`stage ${id} cannot be reached from the first stage`);
    for (const id of endingIds) if (!reach.has(id)) fail(`ending ${id} cannot be reached`);
    const ends = new Set(endingIds);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [id, next] of targets) if (!ends.has(id) && next.some(target => ends.has(target))) { ends.add(id); grew = true; }
    }
    for (const id of stageIds) if (!ends.has(id)) fail(`stage ${id} never reaches an ending`);
  }
  if (hasMeet && requires?.invitations === false) fail('a pack with a meeting cannot say it does not need invitations');
  return {ok: errors.length === 0, errors};
}

function checkLine(value, where, fail) {
  if (!plain(value) || !text(value.en, PACK_LIMITS.line)) { fail(`${where} needs an English line of 1 to ${PACK_LIMITS.line} characters`); return; }
  for (const [code, line] of Object.entries(value)) {
    if (!LANGUAGE.test(code) || !text(line, PACK_LIMITS.line)) fail(`${where}: the ${code} line must be 1 to ${PACK_LIMITS.line} characters`);
  }
}

/** The quest-line prefixes a pack may not run during: its own notActive, the character's arc prefixes and the end of the story. */
export function blockingPrefixes(pack, arcs = shippedBondArcs()) {
  return [...new Set([...(pack?.requires?.notActive ?? []), ...(arcs?.arcs?.[pack?.character]?.active ?? []), ...(arcs?.endgame ?? [])])];
}

/**
 * The plot-safety gate of a pack (docs section 8): {open: true} or {open: false, why}. Missing data is always a no.
 *   level          the character's bond level now
 *   journalHistory the turn's parsed journal inventory (bridge/journal-history.mjs)
 *   romance        'partner' | 'casual' | null
 *   channel        'own' | 'phone' | 'holocall' | 'story' (a character the game placed never starts a pack)
 *   settings       {eddies, invitations}: whether those settings are on
 *   finishedPacks  the ids of this character's finished packs (a Set)
 *   busy           a scene, a choice, combat, a game call or a chase
 */
export function packGate(pack, {level = 0, journalHistory = null, romance = null, channel = 'story', settings = {}, finishedPacks = new Set(), busy = false,
  arcs = shippedBondArcs()} = {}) {
  const requires = pack?.requires ?? {};
  if (busy) return {open: false, why: 'busy'};
  if (!CHANNELS.includes(channel) || !(pack?.start?.channels ?? []).includes(channel)) return {open: false, why: 'channel'};
  if (requires.bond !== undefined && !(level >= requires.bond)) return {open: false, why: 'bond'};
  if (requires.eddies && settings.eddies !== true) return {open: false, why: 'eddies-off'};
  if (requires.relationship === 'partner' && romance !== 'partner') return {open: false, why: 'relationship'};
  if (requires.relationship === 'not-partner' && romance === 'partner') return {open: false, why: 'relationship'};
  for (const id of requires.after ?? []) if (!finishedPacks.has(id)) return {open: false, why: 'after'};
  if (!inventoryComplete(journalHistory)) return {open: false, why: 'journal-unknown'};
  for (const path of requires.questsFinished ?? []) if (!finished(questState(journalHistory, path))) return {open: false, why: 'quest-not-finished'};
  for (const path of requires.questsSucceeded ?? []) if (questState(journalHistory, path) !== 'succeeded') return {open: false, why: 'quest-not-succeeded'};
  const index = questStates(journalHistory);
  for (const prefix of blockingPrefixes(pack, arcs)) {
    for (const [path, state] of index.byPath) if (state === 'active' && path.startsWith(prefix)) return {open: false, why: 'quest-active'};
  }
  return {open: true};
}

/** The shipped packs (characters/bond-packs/*.json), parsed, in file-name order: [{file, pack}]. */
export function shippedPacks() {
  const folder = new URL('../characters/bond-packs/', import.meta.url);
  return readdirSync(folder).filter(name => name.endsWith('.json')).sort()
    .map(file => ({file, pack: JSON.parse(readFileSync(new URL(file, folder), 'utf8'))}));
}
