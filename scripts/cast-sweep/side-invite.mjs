// Makes the side characters (minor roster rows, docs/CAST_SWEEP.md) invitable. A row gets "invite": true when its first record, the one
// the Companion Manager spawns, exists with its entityTemplatePath in the TweakDB of game 2.5 and of game 2.31 (the result of
// scripts/cast-sweep/invite-check.py in scripts/cast-sweep/side-invite-records.json) and no record of it is a child (the game's own
// isChild flag, which the mod's talk and companion rules already refuse). A row that fails stays "invite": false and is listed.
// AGE_DOUBT: four people whose card says kid, young kid, daughter or oldest son with no flag in the game's data are left out the same way.
//   node scripts/cast-sweep/side-invite.mjs [--check]     (--check changes nothing and exits 1 when characters/roster.json differs)
// Then: node scripts/Build-GameRoster.mjs
import {readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rosterPath = resolve(root, 'characters/roster.json');
const checks = JSON.parse((await readFile(resolve(root, 'scripts/cast-sweep/side-invite-records.json'), 'utf8')).replace(/^\uFEFF/u, '')).rows;
const text = await readFile(rosterPath, 'utf8');
const roster = JSON.parse(text.replace(/^\uFEFF/u, ''));
const AGE_DOUBT = new Set(['doris-soto', 'marcus-barros', 'sofia-ramirez', 'randy-kutcher']);
const spawns = key => {
  const row = checks[key];
  return Boolean(row && row.v25 && row.v231 && row.v25Template && row.v231Template && !row.isChild && !AGE_DOUBT.has(key));
};
const left = [];
for (const row of roster) {
  if (row.minor !== true) continue;
  row.invite = spawns(row.key);
  if (!row.invite) left.push({key: row.key, record: row.records[0], why: checks[row.key]?.isChild ? 'game isChild flag' : AGE_DOUBT.has(row.key) ? 'age doubt' : 'record missing'});
}
// The roster file is two-space JSON with CRLF line ends and a final line end.
const next = JSON.stringify(roster, null, 2).replace(/\n/gu, '\r\n') + '\r\n';
const minors = roster.filter(row => row.minor === true);
console.log(JSON.stringify({sideCharacters: minors.length, invitable: minors.filter(row => row.invite).length,
  phantomLibertyOnly: minors.filter(row => row.invite && checks[row.key].v25 === 'ep1').length, left}));
if (process.argv.includes('--check')) process.exit(next === text ? 0 : 1);
if (next !== text) await writeFile(rosterPath, next);
