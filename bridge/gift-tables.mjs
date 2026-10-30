// Gifts both ways (docs/BOND_QUESTS.md section 17, docs/QUEST_PRIMITIVES.md section 10.3): the tables in characters/gift-tables.json and the small rules around them.
// What a character GIVES V by tier (`resolveGive`), what a character LIKES from V (`classify`), what a counted gift is worth to the bond, and the allowlist of item records
// a community pack may name. Pure; the file is read once.
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {atomicFile} from './guarded-file.mjs';

export const TIERS = Object.freeze(['common', 'uncommon', 'rare', 'epic', 'legendary']);
export const REACTIONS = Object.freeze(['loved', 'liked', 'neutral', 'disliked']);
/** Bond points of one counted gift: loved +8, liked +4, anything else +1, disliked -4. */
export const GIFT_BOND = Object.freeze({loved: 8, liked: 4, neutral: 1, disliked: -4});
export const GIFT_FILE = new URL('../characters/gift-tables.json', import.meta.url);
const RECORD = /^Items\.[A-Za-z0-9_]{2,80}$/;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);

let loaded = null;
/** The tables, read once (a missing or broken file gives empty tables, never an error). */
export function giftTables() {
  if (loaded) return loaded;
  try { loaded = JSON.parse(readFileSync(GIFT_FILE, 'utf8')); } catch { loaded = {version: 1, characters: {}}; }
  if (!plain(loaded.characters)) loaded.characters = {};
  return loaded;
}

/** Checks a tables object. Returns the list of problems (empty when fine). */
export function validateGiftTables(tables) {
  const problems = [];
  if (!plain(tables) || tables.version !== 1 || !plain(tables.characters)) return ['the tables need version 1 and a characters object'];
  for (const [key, row] of Object.entries(tables.characters)) {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(key)) problems.push(`${key}: not a profile key`);
    if (!plain(row)) { problems.push(`${key}: must be an object`); continue; }
    for (const [tier, gift] of Object.entries(row.gives ?? {})) {
      if (!TIERS.includes(tier)) { problems.push(`${key}: ${tier} is not a tier`); continue; }
      for (const field of ['item', 'second']) {
        const value = gift?.[field];
        if (value !== undefined && value !== null && !(typeof value === 'string' && RECORD.test(value))) problems.push(`${key} ${tier}: ${field} must be an Items.* record`);
      }
      if (!gift?.item && !gift?.second) problems.push(`${key} ${tier}: needs an item or a second`);
    }
    for (const kind of ['loved', 'liked', 'disliked']) {
      const rules = row.likes?.[kind];
      if (!Array.isArray(rules)) { problems.push(`${key}: likes.${kind} must be a list`); continue; }
      for (const rule of rules) {
        const keys = plain(rule) ? Object.keys(rule) : [];
        if (keys.length !== 1 || !['id', 'prefix', 'contains'].includes(keys[0]) || typeof rule[keys[0]] !== 'string' || !/^[A-Za-z0-9_.]{3,80}$/.test(rule[keys[0]])) {
          problems.push(`${key}: a ${kind} rule is exactly one of id, prefix or contains`);
        } else if (keys[0] === 'id' && !RECORD.test(rule.id)) problems.push(`${key}: ${kind} id ${rule.id} must be an Items.* record`);
      }
    }
  }
  return problems;
}

/** Every item record the tables name (gives, seconds and `id` rules): the allowlist a community pack's gift may use. */
export function allowlist(tables = giftTables()) {
  const ids = new Set();
  for (const row of Object.values(tables.characters ?? {})) {
    for (const gift of Object.values(row.gives ?? {})) for (const value of [gift?.item, gift?.second]) if (typeof value === 'string') ids.add(value);
    for (const rules of Object.values(row.likes ?? {})) for (const rule of rules ?? []) if (typeof rule?.id === 'string') ids.add(rule.id);
  }
  return [...ids].sort();
}
let allowSet = null;
export function isAllowedGift(record) {
  if (!allowSet) allowSet = new Set(allowlist());
  return typeof record === 'string' && allowSet.has(record);
}

/** The allowlist file the game reads (runtime/quest-gift-allowlist.json): {version: 1, ids: [...]}. */
export const allowlistFile = (tables = giftTables()) => ({version: 1, ids: allowlist(tables)});

/** Whether a character takes items from V at all (Johnny and Songbird never do: the reaction is to V doing it). */
export function takesItems(character, tables = giftTables()) { return tables.characters?.[character]?.takes !== false; }

/**
 * What a character gives V for a tier: {item, second, vehicle?, note?} or null (no such tier for the character, or `used` already holds it: each tier is given once per
 * save). The owned check (V already has `item`, so `second` is given instead) is the game's: it sees V's inventory.
 */
export function resolveGive(character, tier, {used = [], tables = giftTables()} = {}) {
  if (!TIERS.includes(tier) || used.includes(tier)) return null;
  const gift = tables.characters?.[character]?.gives?.[tier];
  if (!plain(gift)) return null;
  return {item: gift.item ?? null, second: gift.second ?? null, ...(gift.vehicle !== undefined ? {vehicle: gift.vehicle} : {}), ...(gift.note ? {note: gift.note} : {})};
}

/** The tier a bond level earns (docs 17.2): common at 2 to 3, uncommon at 4 to 5, rare at 6 to 7, epic at 8 to 9, legendary at 10. null under level 2. */
export function tierForLevel(level) {
  if (!Number.isInteger(level) || level < 2) return null;
  return level <= 3 ? 'common' : level <= 5 ? 'uncommon' : level <= 7 ? 'rare' : level <= 9 ? 'epic' : 'legendary';
}

const SPECIFIC = {id: 1000, prefix: 100, contains: 10};
function strength(rule, record) {
  if (rule.id !== undefined) return rule.id === record ? SPECIFIC.id : 0;
  if (rule.prefix !== undefined) return record.startsWith(rule.prefix) ? SPECIFIC.prefix + rule.prefix.length : 0;
  if (rule.contains !== undefined) return record.includes(rule.contains) ? SPECIFIC.contains + rule.contains.length : 0;
  return 0;
}

/**
 * How a character takes an item V gives: 'loved' | 'liked' | 'neutral' | 'disliked'. The most specific matching rule wins (an exact id beats a prefix, a longer prefix
 * beats a shorter one, a prefix beats a `contains`); on a tie loved beats liked beats disliked. An unknown character or record is neutral.
 */
export function classify(character, record, tables = giftTables()) {
  if (typeof record !== 'string' || !record) return 'neutral';
  const likes = tables.characters?.[character]?.likes;
  if (!plain(likes)) return 'neutral';
  let best = 0, found = 'neutral';
  for (const kind of ['loved', 'liked', 'disliked']) {
    for (const rule of likes[kind] ?? []) {
      const power = strength(rule, record);
      if (power > best) { best = power; found = kind; }
    }
  }
  return found;
}

/** The rules the play file carries for a gift stage (`gifts`): {takes, loved, liked, disliked}, or null for a character with no table. */
export function likesFor(character, tables = giftTables()) {
  const row = tables.characters?.[character];
  if (!plain(row?.likes)) return null;
  return {takes: row.takes !== false, loved: row.likes.loved ?? [], liked: row.likes.liked ?? [], disliked: row.likes.disliked ?? []};
}

/** The bond points of a counted gift (a reaction name), or 0 for anything else. */
export const giftBond = reaction => GIFT_BOND[reaction] ?? 0;

/**
 * Writes runtime/quest-gift-allowlist.json ({version: 1, ids: [...]}) when it is missing or different from the tables (the service start does this once). Returns 'written',
 * 'same' or 'failed'. `read(path)` and `write(path, text)` are injectable. Never throws.
 */
export async function syncAllowlist({path, tables = giftTables(), read = file => readFile(file, 'utf8'), write = (file, text) => atomicFile(file, text)} = {}) {
  if (!path) return 'failed';
  const wanted = JSON.stringify(allowlistFile(tables));
  try {
    let current = '';
    try { current = await read(path); } catch { current = ''; }
    try { if (JSON.stringify(JSON.parse(current)) === wanted) return 'same'; } catch { /* missing or broken: written below */ }
    await write(path, wanted);
    return 'written';
  } catch { return 'failed'; }
}
