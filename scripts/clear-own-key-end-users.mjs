// Lists the end users (Convai memory users) on the player's OWN Convai key, and with --apply deletes them.
//
//   node scripts/clear-own-key-end-users.mjs                 list only (read-only)
//   node scripts/clear-own-key-end-users.mjs --apply         delete every listed end user (permanent)
//   node scripts/clear-own-key-end-users.mjs --apply --only "<end_user_id>"   delete just that one
//
// The key is read from the bridge state folder (player-convai-key.txt) and is never printed. Deleting an end user
// removes that user's long-term memories on the account (including Convai playground chats). The delete body
// ({end_user_id}) is untested: the script stops after the FIRST delete, lists again and only continues if the count
// dropped, so a wrong body costs nothing.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const STATE = process.env.CYBERPUNK_CONVAI_STATE || fileURLToPath(new URL('../runtime', import.meta.url));
const API = 'https://api.convai.com';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

const key = /api-key\s*=\s*(\S+)/i.exec(readFileSync(`${STATE}/player-convai-key.txt`, 'utf8'))?.[1];
if (!key) { console.error('No player key found in ' + STATE); process.exit(1); }
const tail = key.slice(-4);

async function post(path, body) {
  const response = await fetch(API + path, {method: 'POST', headers: {'Content-Type': 'application/json', 'CONVAI-API-KEY': key},
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000)});
  const text = (await response.text()).split(key).join('***');
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return {status: response.status, ok: response.ok, json, text};
}

async function list() {
  const users = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const r = await post('/user/end-users/list', cursor ? {cursor} : {});
    if (!r.ok) throw Error(`list failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
    users.push(...(r.json?.end_users ?? []));
    cursor = r.json?.has_more && r.json?.next_cursor ? r.json.next_cursor : null;
    if (!cursor) break;
  }
  return users;
}

const show = users => {
  console.log(`Key ...${tail}: ${users.length} end user(s)`);
  for (const u of users) console.log(`  ${u.end_user_id}   last active ${u.last_active_ts ?? '?'}   last memory use ${u.last_ltm_usage_ts ?? '?'}`);
};

let users = await list();
show(users);
if (!apply) { console.log('\nRead-only. Run again with --apply to delete.'); process.exit(0); }

let targets = only ? users.filter(u => u.end_user_id === only) : users;
if (!targets.length) { console.log('Nothing to delete.'); process.exit(0); }
console.log(`\nDeleting ${targets.length} end user(s)...`);
for (let i = 0; i < targets.length; i++) {
  const id = targets[i].end_user_id;
  const r = await post('/user/end-users/delete', {end_user_id: id});
  console.log(`  delete ${id}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  if (!r.ok) { console.error('Stopping: the delete was refused. Nothing else was attempted.'); process.exit(2); }
  if (i === 0) {
    const after = await list();
    if (after.some(u => u.end_user_id === id)) { console.error('Stopping: the first delete answered OK but the user is still listed.'); process.exit(3); }
    console.log('  first delete confirmed by a new listing');
  }
}
users = await list();
console.log();
show(users);
