// Gives a roster row the appearance its invited copy is spawned with (`appearanceName`), so a chosen person comes as that person and not as
// a random look of the same record (docs/SIDE_CHARACTERS.md, "Who the copy is"). The names come from the data the repo has: the base look of
// the curated outfit table (mod/companion-outfits-data.lua), which characters/companion-outfit-evidence.json proves against the installed
// game. A record the repo has no look for keeps no field. The mod then learns the look the game gave the first copy and keeps it
// (mod/companions.lua ownLook, runtime/spawn-looks.json).
//   node scripts/cast-sweep/spawn-looks.mjs [--check]     (--check changes nothing and exits 1 when characters/roster.json differs)
//   node scripts/cast-sweep/spawn-looks.mjs --report      (the invitable rows that still have no look, counted)
// Then: node scripts/Build-GameRoster.mjs
import {readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rosterPath = resolve(root, 'characters/roster.json');
// The profile plan holds the same rows (bridge/cast-expansion.test.mjs keeps them equal for the cast expansion), so it gets the field too.
const planPath = resolve(root, 'research/cyberpunk/generated/profile-plan.json');

// Record -> base look, read from the curated table's source text (a Lua table: ['Character.X'] = {base = 'name', ...).
export function curatedBases(luaSource) {
  const bases = {};
  for (const match of luaSource.matchAll(/\['(Character\.[^']+)'\]\s*=\s*\{\s*base\s*=\s*'([^']+)'/gu)) bases[match[1]] = match[2];
  return bases;
}

// The rows with the field set (a row keeps its own name if it has one) and the order of keys kept: the field sits right after `records`.
export function applyLooks(roster, bases) {
  return roster.map(row => {
    const record = Array.isArray(row.records) ? row.records[0] : undefined;
    const name = row.appearanceName || bases[record];
    if (!name) return row;
    const out = {};
    for (const [field, value] of Object.entries(row)) {
      if (field === 'appearanceName') continue;
      out[field] = value;
      if (field === 'records') out.appearanceName = name;
    }
    return out;
  });
}

// Invitable rows (the shipped cast and the side characters whose record exists) with no look.
export function withoutLook(roster) {
  return roster.filter(row => row.invite !== false && Array.isArray(row.records) && row.records.length && !row.appearanceName);
}

// Two-space JSON with the line ends and the final line end the file already has.
export const render = (roster, text = '\n') => {
  const out = JSON.stringify(roster, null, 2) + '\n';
  return text.includes('\r\n') ? out.replace(/\n/gu, '\r\n') : out;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = await readFile(rosterPath, 'utf8');
  const roster = JSON.parse(text.replace(/^﻿/u, ''));
  const bases = curatedBases(await readFile(resolve(root, 'mod/companion-outfits-data.lua'), 'utf8'));
  const next = applyLooks(roster, bases);
  const planText = await readFile(planPath, 'utf8');
  const planNext = applyLooks(JSON.parse(planText.replace(/^\uFEFF/u, '')), bases);
  const missing = withoutLook(next);
  if (process.argv.includes('--report')) {
    console.log(JSON.stringify({rows: next.length, withLook: next.filter(row => row.appearanceName).length, invitableWithoutLook: missing.length,
      keys: missing.map(row => row.key)}));
  } else if (process.argv.includes('--check')) {
    if (render(next, text) !== text || render(planNext, planText) !== planText) { console.error('characters/roster.json differs: run node scripts/cast-sweep/spawn-looks.mjs'); process.exit(1); }
    console.log('The roster looks are current.');
  } else {
    await writeFile(rosterPath, render(next, text));
    await writeFile(planPath, render(planNext, planText));
    console.log(JSON.stringify({withLook: next.filter(row => row.appearanceName).length, invitableWithoutLook: missing.length}));
  }
}
