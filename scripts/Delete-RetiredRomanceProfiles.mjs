// Deletes the retired romance Convai characters (docs/ROMANCE_DYNAMIC_CONTEXT.md): for each of the five characters (Judy, Panam,
// River, Kerry, Meredith) the old affectionate profile and its Multilingual twin, ten Convai characters in all. Every character
// keeps its ordinary profile (and ordinary twin); nothing here touches those.
//
//   node scripts/Delete-RetiredRomanceProfiles.mjs             plan only: names the characters, makes no request
//   node scripts/Delete-RetiredRomanceProfiles.mjs --verify    read-only: asks Convai for each character and checks its ownership marker
//   node scripts/Delete-RetiredRomanceProfiles.mjs --apply     verifies EVERY character first, then deletes them one by one
//
// The IDs come from runtime/relationship-profiles.json (the alternate profiles) and from the "<key>-romantic" rows of
// runtime/multilingual-profiles.json (their twins). A character is deleted only if Convai returns it with the exact mod ownership
// marker line "[CyberpunkConvai profile v2:<key>-romantic]" (twin: "...:<key>-romantic:multilingual]") in its biography and its ID is
// not one of the ordinary profiles' IDs; if any character fails that check (other than "already gone"), nothing is deleted.
// Deleting a Convai character also deletes its long-term memories of every user, so the conversations the player had with a romantic
// profile are lost for good: the plan lists which of them the player's memory registry shows as contacted.
// After a complete deletion, --apply moves runtime/relationship-profiles.json to relationship-profiles.json.retired and removes
// the "<key>-romantic" rows from runtime/multilingual-profiles.json (a backup copy is kept next to it). The bridge ignores both
// anyway. Requests are spaced 1.1 s apart; the key is read from runtime/convai-key.txt and never printed.
import {readFile, writeFile, rename, copyFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), runtime = resolve(root, 'runtime');
const args = process.argv.slice(2), apply = args.includes('--apply'), verify = apply || args.includes('--verify');
export const BASE_KEYS = Object.freeze(['judy-alvarez', 'panam-palmer', 'river-ward', 'kerry-eurodyne', 'meredith-stout']);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const marker = key => `[CyberpunkConvai profile v2:${key}]`;

const read = async (path, fallback) => {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/u, '')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
};
const writeJson = async (path, value) => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'}); await rename(temporary, path);
};

/** The retired characters: [{key, role, id, marker}] from the two registries; throws on anything inconsistent. */
export function retiredCharacters({relationships, multilingual, ordinaryIds}) {
  const rows = [], protectedIds = new Set(Object.values(ordinaryIds));
  for (const [key, row] of Object.entries(multilingual?.characters ?? {})) {
    if (!/-romantic$/.test(key)) protectedIds.add(row?.multilingualCharacterId); // the current twins
  }
  for (const base of BASE_KEYS) {
    const row = relationships?.characters?.[base];
    if (row?.romanticCharacterId === undefined) continue; // an install that never had it
    const key = base + '-romantic';
    if (!idPattern.test(row.romanticCharacterId)) throw Error('Malformed romantic ID for ' + base);
    rows.push({key, role: 'profile', id: row.romanticCharacterId, marker: marker(key)});
    const twin = multilingual?.characters?.[key];
    if (twin?.multilingualCharacterId !== undefined) {
      if (!idPattern.test(twin.multilingualCharacterId) || twin.originalCharacterId !== row.romanticCharacterId) throw Error('Romantic twin of ' + base + ' does not clone the romantic profile');
      rows.push({key, role: 'twin', id: twin.multilingualCharacterId, marker: marker(key + ':multilingual')});
    }
  }
  const ids = rows.map(row => row.id);
  if (new Set(ids).size !== ids.length) throw Error('A retired ID appears twice.');
  for (const row of rows) if (protectedIds.has(row.id)) throw Error(`Refusing: ${row.key} ${row.role} has the ID of a current profile.`);
  return rows;
}

async function main() {
  const ordinaryIds = await read(resolve(runtime, 'characters.json'));
  const relationshipPath = resolve(runtime, 'relationship-profiles.json'), multilingualPath = resolve(runtime, 'multilingual-profiles.json');
  const relationships = await read(relationshipPath, {version: 1, characters: {}}), multilingual = await read(multilingualPath, {version: 1, characters: {}});
  const rows = retiredCharacters({relationships, multilingual, ordinaryIds});
  const player = await read(resolve(runtime, 'player-memory.json'), {characters: {}});
  const contacted = [...new Set(Object.values(player.characters ?? {}).filter(row => row?.contacted && /-romantic(?:-multilingual)?$/.test(row.profileKey)).map(row => row.profileKey))];
  console.log(JSON.stringify({mode: apply ? 'apply' : verify ? 'verify' : 'plan', characters: rows.length,
    list: rows.map(row => ({key: row.key, role: row.role, id: row.id})),
    conversationsLostWhenDeleted: contacted.length ? contacted : 'none recorded'}, null, 2));
  if (!rows.length) { console.log('Nothing to delete.'); return; }
  if (!verify) { console.log('Plan only. Re-run with --verify to check them with Convai (read-only) or --apply to delete.'); return; }

  const keyText = (await readFile(process.env.CYBERPUNK_CONVAI_KEY_FILE || resolve(runtime, 'convai-key.txt'), 'utf8')).trim();
  const key = /^api-key\s*=\s*(\S+)\s*$/iu.exec(keyText)?.[1];
  if (!key) throw Error('Expected the project-local api-key file.');
  let last = 0;
  const wait = ms => new Promise(done => setTimeout(done, ms));
  const call = async (endpoint, body) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await wait(Math.max(0, 1100 - (Date.now() - last))); last = Date.now();
      let response;
      try {
        response = await fetch('https://api.convai.com' + endpoint, {method: 'POST', headers: {'CONVAI-API-KEY': key, 'Content-Type': 'application/json'},
          body: JSON.stringify(body), signal: AbortSignal.timeout(45000)});
      } catch { if (attempt < 3) continue; throw Error('Transport failed: ' + endpoint); }
      if (response.status === 429 && attempt < 3) { await wait(15000); continue; }
      let value; const text = await response.text();
      try { value = JSON.parse(text); if (typeof value === 'string') value = JSON.parse(value); } catch { value = text; }
      return {status: response.status, ok: response.ok, value};
    }
  };
  // 1. Verify every character before anything is deleted.
  const listing = await call('/character/list', {});
  if (!Array.isArray(listing?.value?.characters)) throw Error('Convai character listing is unavailable.');
  const listed = new Set(listing.value.characters.map(row => row.character_id));
  const state = [];
  for (const row of rows) {
    if (!listed.has(row.id)) { state.push({...row, state: 'already-gone'}); continue; }
    const got = await call('/character/get', {charID: row.id});
    const owned = got.ok && got.value?.character_id === row.id && String(got.value?.backstory ?? '').split(/\r?\n/u).includes(row.marker);
    state.push({...row, state: owned ? 'verified' : 'unverified'});
  }
  console.log(JSON.stringify(state.map(({key: k, role, state: s}) => ({key: k, role, state: s}))));
  if (state.some(row => row.state === 'unverified')) throw Error('At least one character did not show its ownership marker; nothing was deleted.');
  if (!apply) { console.log('Verified. Re-run with --apply to delete the ' + state.filter(row => row.state === 'verified').length + ' characters that still exist.'); return; }

  // 2. Delete, one by one.
  const journalPath = resolve(runtime, 'romance-retirement-journal.json');
  const journal = {started: new Date().toISOString(), results: []};
  for (const row of state.filter(row => row.state === 'verified')) {
    const result = await call('/character/delete', {charID: row.id});
    journal.results.push({key: row.key, role: row.role, id: row.id, httpStatus: result.status});
    await writeJson(journalPath, journal);
    if (!result.ok) throw Error(`Convai refused to delete ${row.key} ${row.role} (HTTP ${result.status}); see ${journalPath}. Fix and re-run: already deleted ones are skipped.`);
    console.log(`Deleted ${row.key} ${row.role}`);
  }
  // 3. Confirm they are gone.
  const after = await call('/character/list', {});
  const remaining = rows.filter(row => after.value?.characters?.some(item => item.character_id === row.id));
  if (remaining.length) throw Error('Still listed after deletion: ' + remaining.map(row => `${row.key} ${row.role}`).join(', '));
  // 4. Tidy the local registries (the bridge ignores them either way).
  await copyFile(multilingualPath, multilingualPath + '.before-romance-retirement').catch(() => {});
  const kept = {...multilingual, characters: Object.fromEntries(Object.entries(multilingual.characters ?? {}).filter(([k]) => !/-romantic$/.test(k)))};
  await writeJson(multilingualPath, kept);
  await rename(relationshipPath, relationshipPath + '.retired').catch(error => { if (error.code !== 'ENOENT') throw error; });
  console.log(`All ${rows.length} retired characters are gone. runtime/relationship-profiles.json is now relationship-profiles.json.retired and the romantic twin rows are removed from runtime/multilingual-profiles.json.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
