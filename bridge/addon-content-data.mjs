// The data parts of a content pack (docs/ADDON_API.md, "Content packs"): the characters' rewritten text and names, the Convai twins, the name pools. Each is checked here with the same
// limits the shipped data and a player's own edits are held to (bridge/character-overrides.mjs EDIT_LIMITS for a character's text; the rules of scripts/Build-NpcNamePools.mjs for the
// name pools), and a pack that breaks one is skipped whole. `characters` and `namePools` may be given inline or as a path of a .json file inside the pack folder (the whole file is
// read once, at bridge start, and checked before anything is used).
import {readFile} from 'node:fs/promises';
import {isAbsolute, resolve, sep} from 'node:path';
import {EDIT_LIMITS, cleanBlock, cleanLine} from './character-overrides.mjs';

export const DATA_LIMITS = Object.freeze({
  characters: 512,                    // keys in one pack (the shipped roster has 128 named and about 80 archetype profiles)
  name: 80,                           // a character's display name
  style: EDIT_LIMITS.style, bio: EDIT_LIMITS.bio, bioMin: EDIT_LIMITS.bioMin,
  samples: 20, sample: 600, samplesTotal: 6000,
  persona: EDIT_LIMITS.total,         // backstory + style + samples of one character
  charactersFile: 3 * 1024 * 1024,    // bytes of a characters file
  namePoolsFile: 1024 * 1024,         // bytes of a name pools file
  twins: 512,
});
const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CHARACTER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = text => Array.from(text).length;
/** The fields of a character a pack may change (name, gender, records and voice stay the game's, except the display name). */
export const CHARACTER_FIELDS = Object.freeze(['name', 'backstory', 'speakingStyleDescription', 'speakingStyleSampleDialogues']);

/** A relative path of a .json file inside the folder `dir`: the absolute path, or null. Never a drive, a leading slash or a '..'. */
export function insideFolder(dir, value) {
  if (typeof dir !== 'string' || typeof value !== 'string' || !value.trim() || isAbsolute(value) || /^[a-z]:|^[\\/]/i.test(value)) return null;
  if (value.split(/[\\/]+/).some(part => part === '..' || part === '' || part === '.')) return null;
  const path = resolve(dir, value);
  return path.startsWith(resolve(dir) + sep) && /\.json$/i.test(path) ? path : null;
}

/**
 * The characters of a pack: {profileKey: {name?, backstory?, speakingStyleDescription?, speakingStyleSampleDialogues?}}. `value` is an object by key, or a list of rows with a `key`
 * (the shape of characters/roster.json). Throws an Error naming the key and the field.
 */
export function validateCharacters(value, where = 'content.characters') {
  let rows;
  if (Array.isArray(value)) {
    rows = value.map((row, index) => {
      if (!plain(row) || typeof row.key !== 'string') throw Error(`${where}[${index}] must be an object with a key`);
      const {key, ...rest} = row;
      return [key, rest];
    });
  } else if (plain(value)) rows = Object.entries(value);
  else throw Error(`${where} must be an object of profile keys, or a list of rows with a key`);
  if (rows.length > DATA_LIMITS.characters) throw Error(`${where} holds more than ${DATA_LIMITS.characters} characters`);
  const out = {};
  for (const [key, given] of rows) {
    const at = `${where}.${String(key).slice(0, 40)}`;
    if (!KEY.test(key) || FORBIDDEN.has(key)) throw Error(`${at} is not a profile key`);
    if (Object.hasOwn(out, key)) throw Error(`${at} is listed twice`);
    if (!plain(given)) throw Error(`${at} must be an object`);
    const entry = {};
    for (const field of Object.keys(given)) {
      if (!CHARACTER_FIELDS.includes(field)) throw Error(`${at}.${field} cannot be changed by a pack (name, backstory, speakingStyleDescription and speakingStyleSampleDialogues can)`);
      if (typeof given[field] !== 'string') throw Error(`${at}.${field} must be a text`);
    }
    if (given.name !== undefined) {
      const name = cleanLine(given.name);
      if (!name) throw Error(`${at}.name is empty`);
      if (count(name) > DATA_LIMITS.name) throw Error(`${at}.name is longer than ${DATA_LIMITS.name} characters`);
      entry.name = name;
    }
    if (given.backstory !== undefined) {
      const text = cleanBlock(given.backstory);
      if (count(text) < DATA_LIMITS.bioMin) throw Error(`${at}.backstory is shorter than ${DATA_LIMITS.bioMin} characters`);
      if (count(text) > DATA_LIMITS.bio) throw Error(`${at}.backstory is longer than ${DATA_LIMITS.bio} characters`);
      entry.backstory = text;
    }
    if (given.speakingStyleDescription !== undefined) {
      const text = cleanBlock(given.speakingStyleDescription);
      if (!text) throw Error(`${at}.speakingStyleDescription is empty`);
      if (count(text) > DATA_LIMITS.style) throw Error(`${at}.speakingStyleDescription is longer than ${DATA_LIMITS.style} characters`);
      entry.speakingStyleDescription = text;
    }
    if (given.speakingStyleSampleDialogues !== undefined) {
      const text = cleanBlock(given.speakingStyleSampleDialogues);
      const samples = text.split(/\n\s*\n/).map(sample => sample.trim()).filter(Boolean);
      if (!samples.length) throw Error(`${at}.speakingStyleSampleDialogues is empty`);
      if (samples.length > DATA_LIMITS.samples) throw Error(`${at}.speakingStyleSampleDialogues holds more than ${DATA_LIMITS.samples} examples`);
      if (samples.some(sample => count(sample) > DATA_LIMITS.sample)) throw Error(`${at}.speakingStyleSampleDialogues has an example longer than ${DATA_LIMITS.sample} characters`);
      if (samples.reduce((sum, sample) => sum + count(sample), 0) > DATA_LIMITS.samplesTotal) throw Error(`${at}.speakingStyleSampleDialogues is longer than ${DATA_LIMITS.samplesTotal} characters in all`);
      entry.speakingStyleSampleDialogues = samples.join('\n\n');
    }
    const size = count(entry.backstory ?? '') + count(entry.speakingStyleDescription ?? '') + count(entry.speakingStyleSampleDialogues ?? '');
    if (size > DATA_LIMITS.persona) throw Error(`${at} is longer than ${DATA_LIMITS.persona} characters in all`);
    if (!Object.keys(entry).length) throw Error(`${at} changes nothing`);
    out[key] = entry;
  }
  return out;
}

/** The Convai twins of a pack: {profileKey: character id}. */
export function validateConvai(value, where = 'content.convai') {
  if (!plain(value)) throw Error(`${where} must be an object of profile keys and Convai character ids`);
  const entries = Object.entries(value);
  if (entries.length > DATA_LIMITS.twins) throw Error(`${where} holds more than ${DATA_LIMITS.twins} characters`);
  const out = {}, seen = new Set();
  for (const [key, id] of entries) {
    if (!KEY.test(key) || FORBIDDEN.has(key)) throw Error(`${where}.${key.slice(0, 40)} is not a profile key`);
    if (typeof id !== 'string' || !CHARACTER_ID.test(id)) throw Error(`${where}.${key} is not a Convai character id`);
    if (seen.has(id)) throw Error(`${where}.${key} repeats a character id of another key`);
    seen.add(id); out[key] = id;
  }
  return out;
}

// ---- Name pools: the rules of scripts/Build-NpcNamePools.mjs (the game-side copy has the same ones) ---------------------------------
export const POOL_CULTURES = Object.freeze(['african-american', 'arabic', 'chinese', 'corpo-anglo', 'filipino', 'french', 'german-nordic', 'haitian',
  'irish-working', 'japanese', 'korean', 'latino', 'nomad-american', 'slavic', 'south-asian', 'west-african']);
export const POOL_STYLES = Object.freeze(['maelstrom', 'animals', 'moxes', 'valentinos', 'tyger-claws', 'voodoo-boys', '6th-street', 'scavengers', 'nomad', 'street-generic']);
const ENTRY = /^[\p{L}][\p{L} '.\-]*$/u;
const asciiLower = value => value.replace(/[A-Z]/g, c => c.toLowerCase());
const fold = value => asciiLower(value.normalize('NFD').replace(/\p{M}/gu, ''));

/** The problems of a name pool document (empty when it is fine). Same rules as the shipped one: scripts/Build-NpcNamePools.mjs validate. */
export function poolProblems(data) {
  const problems = [];
  if (!plain(data)) return ['not an object'];
  const blocked = new Set((data.blockedFullNames ?? []).flatMap(name => typeof name === 'string' ? [asciiLower(name), fold(name)] : []));
  const checkList = (label, list, {minimum = 1, handle = false} = {}) => {
    if (!Array.isArray(list) || list.length < minimum) { problems.push(`${label}: needs at least ${minimum} entries`); return; }
    const seen = new Set();
    for (const entry of list) {
      if (typeof entry !== 'string' || !ENTRY.test(entry)) { problems.push(`${label}: bad entry ${JSON.stringify(entry)}`); continue; }
      const key = fold(entry);
      if (seen.has(key)) problems.push(`${label}: duplicate ${entry}`);
      seen.add(key);
      if (handle && blocked.has(key)) problems.push(`${label}: handle ${entry} is a named character`);
    }
  };
  for (const culture of POOL_CULTURES) {
    const entry = data.cultures?.[culture];
    if (!plain(entry)) { problems.push(`missing culture ${culture}`); continue; }
    checkList(`${culture}.male`, entry.male, {minimum: 100});
    checkList(`${culture}.female`, entry.female, {minimum: 100});
    checkList(`${culture}.surnames`, entry.surnames, {minimum: 100});
    checkList(`${culture}.handles`, entry.handles, {minimum: 20, handle: true});
  }
  for (const style of POOL_STYLES) checkList(`style ${style}`, data.handleStyles?.[style], {minimum: 30, handle: true});
  for (const culture of Object.keys(data.cultures ?? {})) if (!POOL_CULTURES.includes(culture)) problems.push(`unknown culture ${culture}`);
  for (const style of Object.keys(data.handleStyles ?? {})) if (!POOL_STYLES.includes(style)) problems.push(`unknown style ${style}`);
  if (!Array.isArray(data.blockedFullNames) || data.blockedFullNames.length < 50) problems.push('blockedFullNames is missing');
  return problems;
}

/** A checked name pool document, or a thrown Error listing the first problems. */
export function validateNamePools(value, where = 'content.namePools') {
  const problems = poolProblems(value);
  if (problems.length) throw Error(`${where}: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''}`);
  return {version: Number(value.version) || 1, cultures: value.cultures, handleStyles: value.handleStyles, blockedFullNames: [...value.blockedFullNames]};
}

/**
 * Reads the files a content object points to (`files.characters`, `files.namePools`, absolute paths already confined to the pack folder) and checks them. Returns the content with
 * the data in place of the paths. Throws an Error naming the file and what is wrong; the pack is then skipped whole.
 */
export async function loadContentFiles(content, {read = path => readFile(path, 'utf8')} = {}) {
  const out = {...content};
  const load = async (what, path, limit) => {
    let text;
    try { text = await read(path); } catch { throw Error(`content.${what}: the file ${path.split(/[\\/]/).pop()} cannot be read`); }
    if (Buffer.byteLength(text) > limit) throw Error(`content.${what}: the file ${path.split(/[\\/]/).pop()} is larger than ${Math.round(limit / 1024)} KB`);
    try { return JSON.parse(text.replace(/^﻿/, '')); } catch { throw Error(`content.${what}: the file ${path.split(/[\\/]/).pop()} is not valid JSON`); }
  };
  if (content.files?.characters) {
    const data = validateCharacters(await load('characters', content.files.characters, DATA_LIMITS.charactersFile), `content.characters (${content.files.characters.split(/[\\/]/).pop()})`);
    out.characters = data;
  }
  if (content.files?.namePools) out.namePools = validateNamePools(await load('namePools', content.files.namePools, DATA_LIMITS.namePoolsFile),
    `content.namePools (${content.files.namePools.split(/[\\/]/).pop()})`);
  return out;
}
