// Story packs (docs/RELATIONSHIPS_AND_QUESTS.md, section 7): short arcs a character starts at a bond threshold once their own story is done.
//
// The FORMAT: the validator every pack file must pass (shipped packs in characters/bond-packs/, and later a content pack's bond-packs/ folder), and the
// plot-safety gate (section 8) as a pure function. The runner (start, notes, choices, timers, endings, the rollback-guarded state) is
// bridge/bond-pack-runner.mjs. No I/O except reading the shipped folder when asked.
import {readFileSync, readdirSync} from 'node:fs';
import {EDDIES_CAP, FLOWS} from './eddies.mjs';
import {shippedBondArcs, inventoryComplete, questState, questStates, finished} from './bonds.mjs';
import {usesFormat2, checkPackExtras, checkStagePlay, checkEndingPlay, eventProblem} from './quest-format.mjs';
import {factProblem, factMatches} from './quest-facts.mjs';
import {isAllowedGift} from './gift-tables.mjs';

export const PACK_FORMAT = 1;
/** Format 2 adds places, lines, gaps, images, the play stage type with `do` and `script`, event choices and an ending's history (bridge/quest-format.mjs, docs/QUEST_PRIMITIVES.md). */
export const PACK_FORMATS = Object.freeze([1, 2]);
export const PACK_LIMITS = Object.freeze({stages: 8, choices: 4, effects: 4, know: 600, wants: 300, bringUp: 400, memory: 300, line: 240,
  title: 80, summary: 200, description: 300, label: 80, objective: 80, alt: 200, paths: 24, bondReward: 150});
export const CHANNELS = Object.freeze(['own', 'phone', 'holocall']);
export const RELATIONSHIPS = Object.freeze(['any', 'partner', 'not-partner']);
export const EFFECTS = Object.freeze(['vehicleBlocked', 'vehicleReturned', 'outfit', 'giveItem', 'takeItem']);
/** How V answers a stage, read from V's own words (bridge/bond-intent.mjs): a tag choice names one of these as its `kind`. */
export const CHOICE_KINDS = Object.freeze(['yes', 'no', 'honest', 'flatter']);
/** The stage types the runner plays. Any other `type` is accepted by the validator (a later build adds it) and skipped by the runner, logged once. */
export const KNOWN_STAGE_TYPES = Object.freeze(['talk', 'play']);
const STAGE_TYPE = /^[a-z][a-z0-9-]{1,31}$/;
/** A stage's picture: a file shipped inside the pack, made ahead of time (nothing is generated while playing). Data only: nothing shows it yet. */
export const IMAGE_FILE = /^images\/[a-z0-9][a-z0-9_\/-]{0,80}\.(?:png|jpe?g|webp)$/;
/** A pack is a story `quest` (the default) or a repeatable free-time `hangout` (docs/QUEST_PRIMITIVES.md 10.8). */
export const PACK_KINDS = Object.freeze(['quest', 'hangout']);
/** The hangout block's defaults and bounds: repeat after N game days, at most N bond points per character per game day, the bond for being stood up, 1 to 3 variations. */
export const HANGOUT_DEFAULTS = Object.freeze({repeatDays: 3, capPerDay: 20, stoodUp: -10});
export const HANGOUT_LIMITS = Object.freeze({repeatDays: [1, 30], capPerDay: [1, 100], stoodUp: [-50, 0], variations: 3, know: 600, wants: 300});
export const MEET_PLACES = Object.freeze(['here', 'home', 'waypoint']);
/** How a choice is taken: the character's tag (checked against V's words), an Eddies transfer of a flow, or an invitation's outcome. */
export const CHOICE_ON = /^(?:tag|eddies:(?:loanToV|loanFromV|repayByV|repayToV|giftFromV|giftToV)|meet:(?:met|stood-up)|event:[A-Za-z0-9][A-Za-z0-9:_.-]{0,79})$/;
const ID = /^[a-z][a-z0-9-]{2,47}$/;
const STAGE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const PROFILE = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const JOURNAL_PATH = /^(?:ep1\/)?quests\/[a-z0-9_/]{3,160}$/;
const PATH = JOURNAL_PATH;
const LANGUAGE = /^[a-z]{2}(?:-[a-z]{2})?$/;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim() !== '' && value.length <= max && !/[\u0000-\u0008\u000b-\u001f]/.test(value);

/**
 * The generic gate fields of a `requires` object (a pack's or a reach-out file's): quest paths, the bond level and the gate-plus fields.
 * Returns {done, succeeded}. Pack-only fields (relationship, eddies, invitations, after) are checked by validatePack.
 */
export function checkRequires(requires, fail) {
  const pathList = (value, name, prefixes = false) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > PACK_LIMITS.paths || value.some(path => typeof path !== 'string' || !PATH.test(path))) {
      fail(`requires.${name} must be a list of up to ${PACK_LIMITS.paths} journal ${prefixes ? 'path prefixes' : 'paths'}`);
      return [];
    }
    return value;
  };
  const done = pathList(requires.questsFinished, 'questsFinished');
  const succeeded = pathList(requires.questsSucceeded, 'questsSucceeded');
  pathList(requires.notActive, 'notActive', true);
  // Gate-plus (docs/QUEST_PRIMITIVES.md 10.9): facts the game reads, quests not yet finished or begun, and a window that lets a quest of some lines be active when it is not tracked.
  pathList(requires.before, 'before'); pathList(requires.notBegun, 'notBegun');
  if (requires.facts !== undefined) {
    if (!plain(requires.facts) || Object.keys(requires.facts).length === 0 || Object.keys(requires.facts).length > 4) fail('requires.facts must be an object of 1 to 4 facts');
    else for (const [id, expected] of Object.entries(requires.facts)) { const problem = factProblem(id, expected); if (problem) fail(`requires.facts: ${problem}`); }
  }
  if (requires.window !== undefined) {
    const window = requires.window;
    if (!plain(window) || Object.keys(window).some(key => !['allowActive', 'untracked'].includes(key))) fail('requires.window may only have allowActive and untracked');
    else {
      pathList(window.allowActive, 'window.allowActive', true);
      if (!Array.isArray(window.allowActive) || window.allowActive.length === 0) fail('requires.window.allowActive must list some journal path prefixes');
      if (window.untracked !== true) fail('requires.window.untracked must be true (a quest of those lines may be active only when V is not tracking it)');
    }
  }
  if (requires.bond !== undefined && !(Number.isInteger(requires.bond) && requires.bond >= 1 && requires.bond <= 10)) fail('requires.bond must be a level from 1 to 10');
  return {done, succeeded};
}

/**
 * Checks one pack. `characters`: the profile keys that exist (a Set); `arcs`: the bond arcs data. Returns {ok, errors}: every error found, each a short
 * English sentence with the place ("stage ask: ..."). `community`: the pack comes from a content pack, not from the mod: it may not use the trusted-only primitives
 * (garage) and its gifts may name only items of the allowlist (`giftAllowed`, bridge/gift-tables.mjs).
 */
export function validatePack(pack, {characters = null, arcs = shippedBondArcs(), community = false, giftAllowed = isAllowedGift} = {}) {
  const errors = [], warnings = [];
  const fail = message => { errors.push(message); };
  if (!plain(pack)) return {ok: false, errors: ['the pack is not an object']};
  if (!PACK_FORMATS.includes(pack.format)) fail(`format must be ${PACK_FORMATS.join(' or ')}`);
  else if (pack.format === 1 && usesFormat2(pack)) fail('places, lines, gaps, images, do, script and history need format 2');
  if (typeof pack.id !== 'string' || !ID.test(pack.id)) fail('id must be 3 to 48 lowercase letters, digits or hyphens, starting with a letter');
  if (typeof pack.character !== 'string' || !PROFILE.test(pack.character)) fail('character must be a profile key');
  else if (characters && !characters.has(pack.character)) fail(`character ${pack.character} is not on the roster`);
  if (!text(pack.title, PACK_LIMITS.title)) fail(`title must be 1 to ${PACK_LIMITS.title} characters`);
  if (pack.summary !== undefined && !text(pack.summary, PACK_LIMITS.summary)) fail(`summary must be 1 to ${PACK_LIMITS.summary} characters`);
  // The quest's journal text (docs/REAL_QUESTS.md): shown in the game's journal, the summary when it is missing.
  if (pack.description !== undefined && !text(pack.description, PACK_LIMITS.description)) fail(`description must be 1 to ${PACK_LIMITS.description} characters`);

  // Format 2: the places, lines, gaps and pictures the stages refer to.
  const quest = pack.format === 2 ? checkPackExtras(pack, fail, message => warnings.push(message)) : {places: new Set(), lines: new Map(), gaps: new Map(), images: new Map()};
  quest.community = community === true;
  quest.giftAllowed = community === true ? giftAllowed : null;
  const hangout = checkKind(pack, quest, fail);

  // The gate.
  const requires = pack.requires;
  if (!plain(requires)) fail('requires must be an object');
  const {done, succeeded} = plain(requires) ? checkRequires(requires, fail) : {done: [], succeeded: []};
  if (plain(requires)) {
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
    if (stage.label !== undefined && !text(stage.label, PACK_LIMITS.label)) fail(`${where}: label must be 1 to ${PACK_LIMITS.label} characters`);
    // The line of the HUD objective tracker while the stage is current (docs/REAL_QUESTS.md), the label when it is missing.
    if (stage.objective !== undefined && !text(stage.objective, PACK_LIMITS.objective)) fail(`${where}: objective must be 1 to ${PACK_LIMITS.objective} characters`);
    if (stage.type !== undefined) {
      if (typeof stage.type !== 'string' || !STAGE_TYPE.test(stage.type)) fail(`${where}: type must be lowercase letters, digits or hyphens`);
      else if (!KNOWN_STAGE_TYPES.includes(stage.type)) warnings.push(`${where}: type ${stage.type} is not played yet and will be skipped`);
      if (stage.params !== undefined && !plain(stage.params)) fail(`${where}: params must be an object`);
    }
    if (stage.image !== undefined) {
      if (!plain(stage.image) || typeof stage.image.file !== 'string' || !IMAGE_FILE.test(stage.image.file) || (stage.image.alt !== undefined && !text(stage.image.alt, PACK_LIMITS.alt))) {
        fail(`${where}: image needs file (images/<name>.png, .jpg or .webp inside the pack) and an optional alt of up to ${PACK_LIMITS.alt} characters`);
      }
    }
    if (pack.format === 2) checkStagePlay(stage, quest, where, fail, message => warnings.push(message));
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
      // No time limits (owner decision 1 Nov 2026): a meeting has a place and no deadline. An old pack's `inGameHours` is read and ignored.
      if (!plain(meet) || !MEET_PLACES.includes(meet.where)) fail(`${where}: meet needs where (${MEET_PLACES.join(', ')})`);
      else if (meet.inGameHours !== undefined) warnings.push(`${where}: meet.inGameHours is ignored (a quest has no time limit)`);
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
        const seen = new Set(), kinds = new Set();
        for (const choice of stage.choices) {
          if (!plain(choice) || typeof choice.id !== 'string' || !STAGE_ID.test(choice.id) || seen.has(choice.id)) { fail(`${where}: every choice needs its own id`); continue; }
          seen.add(choice.id);
          if (typeof choice.on !== 'string' || !CHOICE_ON.test(choice.on)) fail(`${where}: choice ${choice.id}: on must be tag, eddies:<flow>, meet:met / meet:stood-up or event:<name>`);
          if (choice.on === 'tag' && !text(choice.means, 200)) fail(`${where}: choice ${choice.id}: a tag choice needs means (what V does, up to 200 characters)`);
          if (choice.on === 'tag' && !CHOICE_KINDS.includes(choice.kind)) fail(`${where}: choice ${choice.id}: a tag choice needs a kind (${CHOICE_KINDS.join(', ')})`);
          if (choice.on === 'tag' && CHOICE_KINDS.includes(choice.kind)) { if (kinds.has(choice.kind)) fail(`${where}: two choices have the kind ${choice.kind}`); kinds.add(choice.kind); }
          if (String(choice.on).startsWith('meet:') && !plain(stage.meet)) fail(`${where}: choice ${choice.id}: a meeting outcome needs a meet in the stage`);
          if (String(choice.on).startsWith('event:')) {
            if (pack.format !== 2) fail(`${where}: choice ${choice.id}: an event choice needs format 2`);
            else { const problem = eventProblem(choice.on.slice(6), stage, quest); if (problem) fail(`${where}: choice ${choice.id}: the event ${problem}`); }
          }
          next.push(choice.next);
        }
      }
    }
    // No time limits (owner decision 1 Nov 2026): a quest stays open until V does it, V says no, or V abandons it. A `timeout` in a pack is read and ignored, and does
    // not count as a way out of the stage.
    if (stage.timeout !== undefined) warnings.push(`${where}: timeout is ignored (a quest has no time limit)`);
    if (stage.next !== undefined) next.push(stage.next);
    if (next.length === 0) fail(`${where}: a stage must lead somewhere (choices or next)`);
    for (const id of next) if (typeof id !== 'string' || (!stageIds.has(id) && !endingIds.has(id))) fail(`${where}: next ${JSON.stringify(id)} is neither a stage nor an ending`);
    targets.set(stage.id, next.filter(id => typeof id === 'string'));
  }
  for (const [id, ending] of Object.entries(endings ?? {})) {
    if (!plain(ending) || !text(ending.memory, PACK_LIMITS.memory)) fail(`ending ${id}: memory must be 1 to ${PACK_LIMITS.memory} characters`);
    if (pack.format === 2) checkEndingPlay(ending, id, quest, `ending ${id}`, fail);
    // How the journal files the ending (docs/REAL_QUESTS.md): left out, a loss of bond or a stand-up is a failure, anything else a success.
    if (ending?.outcome !== undefined && !['succeeded', 'failed'].includes(ending.outcome)) fail(`ending ${id}: outcome must be succeeded or failed`);
    if (ending?.bond !== undefined && !(Number.isInteger(ending.bond) && Math.abs(ending.bond) <= PACK_LIMITS.bondReward)) fail(`ending ${id}: bond must be a whole number from -${PACK_LIMITS.bondReward} to ${PACK_LIMITS.bondReward}`);
  }
  if (pack.unfinishedWhen !== undefined) {
    const when = pack.unfinishedWhen;
    if (!plain(when) || Object.keys(when).some(key => !['finished', 'ending'].includes(key)) || typeof when.finished !== 'string' || !PATH.test(when.finished)) {
      fail('unfinishedWhen needs finished (a journal quest path) and ending');
    } else if (typeof when.ending !== 'string' || !endingIds.has(when.ending)) fail("unfinishedWhen.ending must be one of the pack's endings");
  }
  // Every stage is reachable from the first, every ending is reachable, and every stage can reach an ending (the arc always ends).
  if (stages?.length && plain(stages[0]) && targets.size === stageIds.size) {
    const reach = new Set([stages[0].id]), queue = [stages[0].id];
    while (queue.length) for (const id of targets.get(queue.shift()) ?? []) if (!reach.has(id)) { reach.add(id); if (targets.has(id)) queue.push(id); }
    for (const id of stageIds) if (!reach.has(id)) fail(`stage ${id} cannot be reached from the first stage`);
    for (const id of endingIds) if (!reach.has(id) && id !== pack.unfinishedWhen?.ending) fail(`ending ${id} cannot be reached`);
    const ends = new Set(endingIds);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [id, next] of targets) if (!ends.has(id) && next.some(target => ends.has(target))) { ends.add(id); grew = true; }
    }
    for (const id of stageIds) if (!ends.has(id)) fail(`stage ${id} never reaches an ending`);
  }
  if (hasMeet && requires?.invitations === false) fail('a pack with a meeting cannot say it does not need invitations');
  if (hangout && stages?.length !== 1) fail('a hangout is a one-stage pack');
  return {ok: errors.length === 0, errors, warnings};
}

/** The pack's `kind` and `hangout` block (docs/QUEST_PRIMITIVES.md 10.8). Returns whether the pack is a hangout. */
function checkKind(pack, quest, fail) {
  if (pack.kind !== undefined && !PACK_KINDS.includes(pack.kind)) { fail(`kind must be one of ${PACK_KINDS.join(', ')}`); return false; }
  const isHangout = pack.kind === 'hangout';
  if (!isHangout) { if (pack.hangout !== undefined) fail('hangout needs kind "hangout"'); return false; }
  if (pack.format !== 2) fail('a hangout needs format 2');
  const block = pack.hangout;
  if (!plain(block)) { fail('a hangout needs a hangout block with its variations'); return true; }
  const limits = HANGOUT_LIMITS;
  for (const key of Object.keys(block)) if (!['repeatDays', 'capPerDay', 'stoodUp', 'variations'].includes(key)) fail(`hangout has no field ${JSON.stringify(key).slice(0, 30)}`);
  for (const [key, [low, high]] of [['repeatDays', limits.repeatDays], ['capPerDay', limits.capPerDay], ['stoodUp', limits.stoodUp]]) {
    if (block[key] !== undefined && !(Number.isInteger(block[key]) && block[key] >= low && block[key] <= high)) fail(`hangout.${key} must be a whole number from ${low} to ${high}`);
  }
  const list = block.variations;
  if (!Array.isArray(list) || list.length < 1 || list.length > limits.variations) { fail(`hangout.variations must be a list of 1 to ${limits.variations}`); return true; }
  const seen = new Set();
  for (const item of list) {
    if (!plain(item) || typeof item.id !== 'string' || !STAGE_ID.test(item.id) || seen.has(item.id)) { fail('every variation needs its own id'); continue; }
    seen.add(item.id);
    const where = `variation ${item.id}`;
    for (const key of Object.keys(item)) if (!['id', 'know', 'wants', 'places'].includes(key)) fail(`${where}: no field ${JSON.stringify(key).slice(0, 30)}`);
    if (item.know !== undefined && !text(item.know, limits.know)) fail(`${where}: know must be 1 to ${limits.know} characters`);
    if (item.wants !== undefined && !text(item.wants, limits.wants)) fail(`${where}: wants must be 1 to ${limits.wants} characters`);
    if (typeof item.know === 'string' && item.know.includes(';')) fail(`${where}: know has a semicolon`);
    if (item.places !== undefined) {
      if (!plain(item.places) || Object.keys(item.places).length === 0 || Object.keys(item.places).length > 8) fail(`${where}: places must map 1 to 8 place ids to place ids`);
      else for (const [from, to] of Object.entries(item.places)) {
        if (!quest.places.has(from) || typeof to !== 'string' || !quest.places.has(to)) fail(`${where}: places ${JSON.stringify(from).slice(0, 30)} to ${JSON.stringify(String(to)).slice(0, 30)} must both be places of the pack`);
      }
    }
  }
  return true;
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
 * The path of V's tracked quest in a parsed journal inventory: a string, `null` (V tracks nothing) or `undefined` (not known: the gate treats that as a no where the
 * tracked quest matters).
 */
export function trackedPathOf(history) {
  const tracked = history?.tracked;
  if (tracked?.status === 'untracked') return null;
  if (tracked?.status !== 'known') return undefined;
  const row = (Array.isArray(history.quests) ? history.quests : []).find(quest => quest?.id === tracked.questId);
  return typeof row?.nativePath === 'string' ? row.nativePath : undefined;
}

/**
 * The first active quest that stops the pack (or null): one under a blocking prefix (blockingPrefixes). A `requires.window` lets a quest of its `allowActive` lines be
 * active when it is not the quest V tracks (`tracked`: a path, null or undefined, see trackedPathOf; scenes are the `busy` flag's).
 */
export function blockingQuest(pack, index, {tracked, arcs = shippedBondArcs()} = {}) {
  const window = pack?.requires?.window;
  const allow = window?.untracked === true && Array.isArray(window.allowActive) ? window.allowActive : [];
  const own = [...(pack?.requires?.notActive ?? []), ...(arcs?.arcs?.[pack?.character]?.active ?? [])];
  for (const prefix of blockingPrefixes(pack, arcs)) {
    for (const [path, state] of index.byPath) {
      if (state !== 'active' || !path.startsWith(prefix)) continue;
      // The end of the story stops a pack only once V is in it: a finale quest still waiting at its hook (V never called Reed) is not the finale.
      if (index.idle?.has(path) && !own.some(item => path.startsWith(item))) continue;
      if (allow.some(allowed => path.startsWith(allowed)) && tracked !== undefined && path !== tracked) continue;
      return path;
    }
  }
  return null;
}

/**
 * The journal and fact part of a gate (shared by a pack's gate and a character's reach-outs): `requires.questsFinished / questsSucceeded / before / notBegun / facts`,
 * the quest lines that may not be active (with the window) and the complete-inventory rule. {open: true} or {open: false, why}. Missing data is always a no.
 */
export function journalGate(pack, {journalHistory = null, facts = null, tracked, arcs = shippedBondArcs()} = {}) {
  const requires = pack?.requires ?? {};
  if (!inventoryComplete(journalHistory)) return {open: false, why: 'journal-unknown'};
  for (const path of requires.questsFinished ?? []) if (!finished(questState(journalHistory, path))) return {open: false, why: 'quest-not-finished', path};
  for (const path of requires.questsSucceeded ?? []) if (questState(journalHistory, path) !== 'succeeded') return {open: false, why: 'quest-not-succeeded', path};
  for (const path of requires.before ?? []) if (finished(questState(journalHistory, path))) return {open: false, why: 'before', path};
  for (const path of requires.notBegun ?? []) if (questState(journalHistory, path) !== undefined) return {open: false, why: 'begun', path};
  for (const [id, expected] of Object.entries(requires.facts ?? {})) if (!factMatches(facts, id, expected)) return {open: false, why: 'fact', path: id};
  const blocking = blockingQuest(pack, questStates(journalHistory), {tracked: tracked === undefined ? trackedPathOf(journalHistory) : tracked, arcs});
  if (blocking) return {open: false, why: 'quest-active', path: blocking};
  return {open: true};
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
 *   facts          the quest facts the game reported ({id: value}, bridge/quest-facts.mjs); a fact the pack needs and the game has not reported is a no
 *   tracked        the quest path V tracks (null: none; undefined: worked out from the journal inventory), for `requires.window`
 */
export function packGate(pack, {level = 0, journalHistory = null, romance = null, channel = 'story', settings = {}, finishedPacks = new Set(), busy = false,
  facts = null, tracked, arcs = shippedBondArcs()} = {}) {
  const requires = pack?.requires ?? {};
  if (busy) return {open: false, why: 'busy'};
  if (!CHANNELS.includes(channel) || !(pack?.start?.channels ?? []).includes(channel)) return {open: false, why: 'channel'};
  if (requires.bond !== undefined && !(level >= requires.bond)) return {open: false, why: 'bond'};
  if (requires.eddies && settings.eddies !== true) return {open: false, why: 'eddies-off'};
  if (requires.relationship === 'partner' && romance !== 'partner') return {open: false, why: 'relationship'};
  if (requires.relationship === 'not-partner' && romance === 'partner') return {open: false, why: 'relationship'};
  for (const id of requires.after ?? []) if (!finishedPacks.has(id)) return {open: false, why: 'after'};
  return journalGate(pack, {journalHistory, facts, tracked, arcs});
}

/**
 * A closed gate in words, for the Developer-mode log ("q307_before_tomorrow still active"). `gate` is packGate's {open: false, why, path?}; `level` and `channel` are the
 * turn's. The wording names a quest by the last part of its path only.
 */
export function explainGate(gate, pack, {level = 0, channel = 'story', romance = null} = {}) {
  const name = typeof gate?.path === 'string' ? gate.path.slice(gate.path.lastIndexOf('/') + 1) : 'a quest';
  switch (gate?.why) {
    case 'busy': return 'the game is busy (a scene, a choice, a fight or a call)';
    case 'channel': return `${channel} does not start it (it starts on ${(pack?.start?.channels ?? []).join(', ') || 'no channel'})`;
    case 'bond': return `bond level ${level} is under ${pack?.requires?.bond}`;
    case 'eddies-off': return 'Eddies with characters is off';
    case 'relationship': return `the relationship (${romance ?? 'none'}) does not fit`;
    case 'after': return 'an earlier pack of the character is not finished';
    case 'journal-unknown': return 'the quest journal is not complete yet';
    case 'quest-not-finished': return `${name} is not finished`;
    case 'quest-not-succeeded': return `${name} is not succeeded`;
    case 'before': return `${name} is already finished`;
    case 'begun': return `${name} was already begun`;
    case 'fact': return `the quest fact ${name} is not known or does not match`;
    case 'quest-active': return `${name} still active`;
    default: return String(gate?.why ?? 'closed');
  }
}

/** The shipped packs (characters/bond-packs/*.json), parsed, in file-name order: [{file, pack}]. */
export function shippedPacks() {
  const folder = new URL('../characters/bond-packs/', import.meta.url);
  return readdirSync(folder).filter(name => name.endsWith('.json')).sort()
    .map(file => ({file, pack: JSON.parse(readFileSync(new URL(file, folder), 'utf8'))}));
}
