// "Open to romance": one small trait per character (characters/romance-traits.json, docs/SIDE_ROMANCE.md), read by bridge/romance-bond.mjs.
//
//   open    true: the character can come to love V in time. false: they never would, for the reason given (their personality and story).
//   from    the bond level (5 to 9) at which an open character will say yes when V asks. Warm and quick: 5. Guarded or formal: 8 or 9.
//   reason  one plain sentence to the character ("you"): why they are open, or why they never would. A refusal is built on it.
//   style   open characters only: how their affection sounds, written for that character (the sentence a partner turn carries).
//
// A character with no row (a player's own character, a pack's) is open from level 7 and has no style line: the general partner tone covers it.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const MIN_FROM = 5, MAX_FROM = 9, DEFAULT_FROM = 7;
export const LIMITS = Object.freeze({reason: 220, style: 360});
export const TRAITS_FILE = fileURLToPath(new URL('../characters/romance-traits.json', import.meta.url));
const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
// Player-facing text rules: no dashes as punctuation, no semicolons, no control characters.
const BAD_TEXT = /[\u2013\u2014;\u0000-\u001f]|--/;
// Other mods are never named in the data (the pattern is built from parts so the names are not written out here).
const MOD_NAMES = new RegExp(`\\b(?:${['A' + 'MM', 'Night City ' + 'Allies'].join('|')})\\b`);

/** The problem with one trait row, or null when it is fine. */
export function traitProblem(row) {
  if (!plain(row)) return 'not an object';
  const allowed = row.open === true ? ['open', 'from', 'reason', 'style'] : ['open', 'reason'];
  for (const name of Object.keys(row)) if (!allowed.includes(name)) return `unexpected field ${name}`;
  if (typeof row.open !== 'boolean') return 'open must be true or false';
  if (row.open && !(Number.isInteger(row.from) && row.from >= MIN_FROM && row.from <= MAX_FROM)) return `from must be a whole number ${MIN_FROM} to ${MAX_FROM}`;
  for (const [name, limit] of [['reason', LIMITS.reason], ...(row.open ? [['style', LIMITS.style]] : [])]) {
    const text = row[name];
    if (typeof text !== 'string' || text.trim() !== text || text.length < 12 || text.length > limit) return `${name} must be a sentence of 12 to ${limit} characters`;
    if (BAD_TEXT.test(text)) return `${name} has a dash, a semicolon or a control character`;
    if (MOD_NAMES.test(text)) return `${name} names a mod`;
  }
  return null;
}

/** The problems of a whole table ({version: 1, traits: {key: row}}); `keys` (optional) is the list every key must have a row for. */
export function tableProblems(table, keys = null) {
  const problems = [];
  if (!plain(table) || table.version !== 1 || !plain(table.traits)) return ['not a {version: 1, traits} table'];
  for (const [key, row] of Object.entries(table.traits)) {
    if (!KEY.test(key)) { problems.push(`${key}: not a profile key`); continue; }
    const problem = traitProblem(row);
    if (problem) problems.push(`${key}: ${problem}`);
  }
  if (keys) for (const key of keys) if (!Object.hasOwn(table.traits, key)) problems.push(`${key}: missing`);
  return problems;
}

let shipped = null;
/** The shipped table, frozen once ({} when the file is missing or damaged: every character then has the default trait). */
export function shippedTraits() {
  if (shipped) return shipped;
  let traits = {};
  try {
    const table = JSON.parse(readFileSync(TRAITS_FILE, 'utf8'));
    if (plain(table) && table.version === 1 && plain(table.traits)) {
      for (const [key, row] of Object.entries(table.traits)) if (KEY.test(key) && !traitProblem(row)) traits[key] = Object.freeze({...row});
    }
  } catch { /* a missing file is the default trait for everyone */ }
  shipped = Object.freeze(traits);
  return shipped;
}

/** The trait of a character: {open, from, reason, style, listed}. A character with no row is open from DEFAULT_FROM with no reason and no style. */
export function traitOf(profileKey, traits = shippedTraits()) {
  const row = typeof profileKey === 'string' && Object.hasOwn(traits, profileKey) ? traits[profileKey] : null;
  if (!row) return {open: true, from: DEFAULT_FROM, reason: '', style: '', listed: false};
  return {open: row.open, from: row.open ? row.from : null, reason: row.reason, style: row.open ? row.style : '', listed: true};
}
