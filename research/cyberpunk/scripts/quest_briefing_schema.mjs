// The shape and limits of research/cyberpunk/quest-briefings.json (docs/QUEST_BRIEFINGS.md). Used by the builder
// (build_quest_briefings.mjs) and the tests; the runtime (bridge/quest-briefing.mjs) clips defensively by the same limits.
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const LIMITS = Object.freeze({title: 80, overview: 220, now: 200, ahead: 280, place: 60, people: 60, tip: 150,
  places: 3, peopleCount: 3, tips: 2, stages: 14, objectivesPerStage: 24});
const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const PLAIN = /^[^\u0000-\u001f<>{}\[\]`]*$/;
const SPOILER = new Set(['none', 'light']);

let rosterKeys;
function roster() {
  if (!rosterKeys) {
    const file = resolve(dirname(fileURLToPath(import.meta.url)), '../../../characters/roster.json');
    rosterKeys = new Set(JSON.parse(readFileSync(file, 'utf8')).map(row => row.key));
  }
  return rosterKeys;
}

/**
 * @param data      the parsed source file {version, sources, quests}
 * @param questPaths  Set of known cooked journal quest paths (JOURNAL_QUEST_TYPES keys)
 * @param journal   optional Map quest path -> [{rel, optional}] from the cooked journal: objective paths are checked against it
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateBriefings(data, {questPaths, journal = null, profiles = roster()} = {}) {
  const errors = [], warnings = [];
  const fail = (path, message) => errors.push(`${path}: ${message}`);
  if (!data || typeof data !== 'object' || (data.version !== undefined && data.version !== 1) || !data.quests || typeof data.quests !== 'object') return {errors: ['source: expected {version: 1, sources: {...}, quests: {...}}'], warnings};
  const sources = data.sources && typeof data.sources === 'object' ? data.sources : {};
  for (const [id, row] of Object.entries(sources)) {
    if (!SOURCE.test(id) || typeof row?.url !== 'string' || !/^https:\/\//.test(row.url) || typeof row.title !== 'string' || !row.title) fail(`sources.${id}`, 'needs a url (https), a title and a short id');
  }
  const text = (path, value, limit, label = path) => {
    if (typeof value !== 'string' || !value.trim()) return fail(path, `${label} must be a non-empty string`);
    if (value.length > limit) fail(path, `${label} is ${value.length} characters (limit ${limit})`);
    if (!PLAIN.test(value)) fail(path, `${label} has control characters, angle brackets, braces, brackets or backticks`);
    if (/\bLocKey#/.test(value)) fail(path, `${label} has a LocKey`);
    if (value !== value.trim() || /\s{2,}/.test(value)) fail(path, `${label} has stray whitespace`);
  };
  const list = (path, value, count, limit, label) => {
    if (!Array.isArray(value) || value.length > count) return fail(path, `${label} must be an array of at most ${count}`);
    value.forEach((item, index) => text(`${path}[${index}]`, item, limit, label));
  };
  for (const [path, quest] of Object.entries(data.quests)) {
    const at = `quests.${path}`;
    if (questPaths && !questPaths.has(path)) fail(at, 'not a cooked journal quest path');
    if (!quest || typeof quest !== 'object') { fail(at, 'must be an object'); continue; }
    text(`${at}.title`, quest.title, LIMITS.title, 'title');
    text(`${at}.overview`, quest.overview, LIMITS.overview, 'overview');
    if (!SPOILER.has(quest.spoiler)) fail(`${at}.spoiler`, 'must be "none" or "light"');
    for (const name of ['givers', 'knowers']) {
      const value = quest[name];
      if (!Array.isArray(value) || value.length > 6 || (name === 'givers' && !value.length)) { fail(`${at}.${name}`, 'must be an array of profile keys (givers: at least one)'); continue; }
      for (const key of value) if (!profiles.has(key)) fail(`${at}.${name}`, `unknown profile key ${key}`);
    }
    if (Array.isArray(quest.givers) && Array.isArray(quest.knowers) && quest.knowers.some(key => quest.givers.includes(key))) fail(`${at}.knowers`, 'a giver is not also a knower');
    if (!Array.isArray(quest.sources) || !quest.sources.length) fail(`${at}.sources`, 'list at least one source id');
    else for (const id of quest.sources) if (!Object.hasOwn(sources, id)) fail(`${at}.sources`, `unknown source id ${id}`);
    if (!Array.isArray(quest.stages) || !quest.stages.length || quest.stages.length > LIMITS.stages) { fail(`${at}.stages`, `needs 1 to ${LIMITS.stages} stages in story order`); continue; }
    const known = journal?.get(path);
    if (journal && !known) fail(at, 'quest not found in the cooked journal index');
    const rels = new Map((known ?? []).map(row => [row.rel, row]));
    const claimed = new Map(), ids = new Set();
    quest.stages.forEach((stage, index) => {
      const here = `${at}.stages[${index}]`;
      if (!stage || typeof stage !== 'object') return fail(here, 'must be an object');
      if (typeof stage.id !== 'string' || !KEY.test(stage.id) || ids.has(stage.id)) fail(`${here}.id`, 'needs a unique kebab-case id');
      ids.add(stage.id);
      text(`${here}.now`, stage.now, LIMITS.now, 'now');
      text(`${here}.ahead`, stage.ahead, LIMITS.ahead, 'ahead');
      list(`${here}.places`, stage.places, LIMITS.places, LIMITS.place, 'place');
      list(`${here}.people`, stage.people, LIMITS.peopleCount, LIMITS.people, 'person');
      list(`${here}.tips`, stage.tips, LIMITS.tips, LIMITS.tip, 'tip');
      if (!Array.isArray(stage.objectives) || !stage.objectives.length || stage.objectives.length > LIMITS.objectivesPerStage) return fail(`${here}.objectives`, 'needs a list of objective paths');
      for (const rel of stage.objectives) {
        if (typeof rel !== 'string' || !/^[A-Za-z0-9_.\/-]{1,200}$/.test(rel)) { fail(`${here}.objectives`, `bad objective path ${JSON.stringify(rel)}`); continue; }
        if (claimed.has(rel)) fail(`${here}.objectives`, `${rel} is already in stage ${claimed.get(rel)}`);
        claimed.set(rel, index);
        if (journal && !rels.has(rel)) fail(`${here}.objectives`, `${rel} is not an objective of this quest in the cooked journal`);
      }
    });
    // Objectives that stay active through the whole job (a parent "save the client" objective): they say nothing about the stage.
    const persistent = quest.persistent === undefined ? [] : quest.persistent;
    if (!Array.isArray(persistent) || persistent.length > 8) fail(`${at}.persistent`, 'must be an array of at most 8 objective paths');
    else for (const rel of persistent) {
      if (typeof rel !== 'string' || claimed.has(rel)) fail(`${at}.persistent`, `${JSON.stringify(rel)} is not a path outside the stages`);
      else { claimed.set(rel, -1); if (journal && !rels.has(rel)) fail(`${at}.persistent`, `${rel} is not an objective of this quest in the cooked journal`); }
    }
    if (journal) {
      const left = [...rels.values()].filter(row => !row.optional && !claimed.has(row.rel)).map(row => row.rel);
      if (left.length) warnings.push(`${at}: ${left.length} non-optional objective(s) in no stage: ${left.slice(0, 8).join(', ')}${left.length > 8 ? ', ...' : ''}`);
    }
  }
  return {errors, warnings};
}
