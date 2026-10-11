// Turns Convai memory OFF on the generic `resident-male` profile and clears the memories it stored for the player.
// The old ambient path switched its memory on (see the TODO log); ambient profiles are meant to be session-only.
//
//   node scripts/Clear-ResidentMaleMemory.mjs           read-only: shows memory on/off and the stored memory count
//   node scripts/Clear-ResidentMaleMemory.mjs --apply   memory off, then delete-all for the player (permanent)
//
// Reads the project key from runtime/convai-key.txt (never printed) and the player id from runtime/player-memory.json.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const API = 'https://api.convai.com';
const APPLY = process.argv.includes('--apply');
const characters = JSON.parse(readFileSync(`${repo}/packaging/release-data/characters.json`, 'utf8'));
const charID = JSON.stringify(characters).match(/"resident-male":"([0-9a-f-]{36})"/)?.[1];
const key = /^api-key\s*=\s*(\S+)\s*$/im.exec(readFileSync(`${repo}/runtime/convai-key.txt`, 'utf8'))?.[1];
const endUserId = JSON.parse(readFileSync(`${repo}/runtime/player-memory.json`, 'utf8')).endUserId;
if (!charID || !key || !endUserId) { console.log('missing character id, key or player id; nothing done'); process.exit(1); }

async function post(path, body) {
  const response = await fetch(API + path, {method: 'POST', headers: {'Content-Type': 'application/json', 'CONVAI-API-KEY': key},
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000)});
  const text = (await response.text()).split(key).join('***');
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!response.ok) throw Error(`${path} HTTP ${response.status} ${text.slice(0, 200)}`);
  return json;
}
const state = async () => {
  const detail = await post('/character/get', {charID});
  const list = await post('/memory/list', {character_id: charID, end_user_id: endUserId, page: 1, page_size: 1});
  return {name: detail.character_name, memoryOn: detail.memory_settings?.enabled, stored: list.total_count};
};

const before = await state();
console.log(`resident-male (${before.name}): memory ${before.memoryOn ? 'ON' : 'off'}, ${before.stored} stored for the player`);
if (!APPLY) { console.log('read-only; add --apply to turn memory off and clear them'); process.exit(0); }
if (before.memoryOn) await post('/character/update', {charID, memorySettings: {enabled: false}});
if (before.stored > 0) await post('/memory/delete-all', {character_id: charID, end_user_id: endUserId});
const after = await state();
console.log(`after: memory ${after.memoryOn ? 'ON' : 'off'}, ${after.stored} stored`);
console.log(after.memoryOn === false && after.stored === 0 ? 'done' : 'NOT fully cleared; check the lines above');
