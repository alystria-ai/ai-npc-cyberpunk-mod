// Cast sweep (2026-10-30): keep the generated NPC names clear of the new named characters.
//
//   node scripts/cast-sweep/name-pools.mjs
//
// Adds every roster name that is not yet in blockedFullNames (characters/npc-name-pools.json) and drops the few street handles
// that equal a roster name (Ash, Jackal, Jeff, Rhino and Vortex became named characters), in every handle list. The file keeps its
// compact one-line-per-list layout (each changed list is replaced in place). Then run `node scripts/Build-NpcNamePools.mjs` to
// rebuild mod/npc-name-pools.lua. Idempotent.
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {asciiLower, fold} from '../Build-NpcNamePools.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const poolsPath = resolve(repo, 'characters/npc-name-pools.json');
let text = readFileSync(poolsPath, 'utf8');
const crlf = text.includes('\r\n');
text = text.replace(/\r\n/g, '\n');
const pools = JSON.parse(text.replace(/^﻿/, ''));
const roster = JSON.parse(readFileSync(resolve(repo, 'characters/roster.json'), 'utf8').replace(/^﻿/, ''));
const names = roster.flatMap(row => [row.name, ...(row.aliases || [])]);
const folded = new Set(names.flatMap(name => [asciiLower(name), fold(name)]));

const swap = (oldList, newList) => {
  const from = JSON.stringify(oldList);
  if (text.split(from).length !== 2) throw Error('a list is not found exactly once: ' + from.slice(0, 60));
  text = text.replace(from, () => JSON.stringify(newList));
};
// blocked names
const blocked = new Set(pools.blockedFullNames.flatMap(name => [asciiLower(name), fold(name)]));
const extra = [];
for (const name of names) if (!blocked.has(asciiLower(name)) && !blocked.has(fold(name))) { extra.push(name); blocked.add(asciiLower(name)); blocked.add(fold(name)); }
// handle lists (cultures.<c>.handles and handleStyles.<s>)
const lists = [];
for (const entry of Object.values(pools.cultures)) if (Array.isArray(entry.handles)) lists.push(entry.handles);
for (const list of Object.values(pools.handleStyles)) lists.push(list);
let dropped = 0;
const handleSwaps = [];
for (const list of lists) {
  const keep = list.filter(handle => !folded.has(asciiLower(handle)) && !folded.has(fold(handle)));
  if (keep.length !== list.length) { dropped += list.length - keep.length; handleSwaps.push([list, keep]); }
}
for (const [oldList, newList] of handleSwaps) swap(oldList, newList);
if (extra.length) swap(pools.blockedFullNames, [...pools.blockedFullNames, ...extra]);
writeFileSync(poolsPath, crlf ? text.replace(/\n/g, '\r\n') : text);
console.log(`blockedFullNames +${extra.length}, handles dropped ${dropped}`);
