#!/usr/bin/env node
// Builds characters/game-roster.json, the roster file the GAME decodes at start (shipped as conversation-characters.json).
//
//   node scripts/Build-GameRoster.mjs [--check]
//
// The bridge reads the full characters/roster.json (profile text, sources, voices). The game side only needs identity: init.lua
// drops the research fields right after decoding, and CET's json.lua turns every escaped newline of those texts into garbage
// (deliverables/perf/LUA_HEAP.md: 26.8 MB of transient garbage for the 128 first rows). The 575 minor profiles of the cast sweep
// (docs/CAST_SWEEP.md) would have made the file 3.9 MB, so their rows are cut to the fields the game side reads. The other rows are
// copied unchanged. `--check` fails when the file is stale (used by bridge/game-roster.test.mjs).
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = resolve(root, 'characters/roster.json');
export const TARGET = resolve(root, 'characters/game-roster.json');
// What the game-side Lua reads of a profile (mod/character-catalog.lua build and resolve, mod/manager.lua, mod/manager-ui.lua, the name lookups):
// key, name, aliases, records, kind, invite and minor. The summary (shown in the profile details, which fall back to the name) and the
// voice fields stay on the bridge side. An alias list that only repeats the name is dropped: the catalog maps the name already.
export const LEAN_FIELDS = Object.freeze(['key', 'name', 'aliases', 'records', 'kind', 'invite', 'minor']);

export const lean = row => {
  if (row.minor !== true) return row;
  const out = Object.fromEntries(LEAN_FIELDS.filter(field => row[field] !== undefined).map(field => [field, row[field]]));
  if (Array.isArray(out.aliases) && out.aliases.every(alias => alias === out.name)) delete out.aliases;
  return out;
};

export function render(roster) {
  return '[\n' + roster.map(row => JSON.stringify(lean(row))).join(',\n') + '\n]\n';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const roster = JSON.parse(readFileSync(SOURCE, 'utf8').replace(/^﻿/, ''));
  const text = render(roster);
  if (process.argv.includes('--check')) {
    const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current !== text) { console.error('characters/game-roster.json is stale: run node scripts/Build-GameRoster.mjs'); process.exit(1); }
    console.log('The game roster is current.');
  } else {
    writeFileSync(TARGET, text);
    console.log(`Wrote characters/game-roster.json: ${roster.length} rows, ${Buffer.byteLength(text)} bytes (full roster ${Buffer.byteLength(JSON.stringify(roster))} bytes compact).`);
  }
}
