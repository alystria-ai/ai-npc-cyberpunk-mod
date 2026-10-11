// Cleanup of Convai LTM *test* end users created by our probes and tests.
//
//   node scripts/cleanup-test-end-users.mjs                       read-only: list candidates, counts, counter
//   node scripts/cleanup-test-end-users.mjs --count-memories      also sample memory counts (bounded, throttled)
//   node scripts/cleanup-test-end-users.mjs --apply --limit 1     delete ONE end user, verify, show the usage counter
//   node scripts/cleanup-test-end-users.mjs --apply               delete every confident test end user
//
// Endpoints used (all JSON POST to https://api.convai.com, header CONVAI-API-KEY):
//   /user/user-api-usage     usage counters incl. ltm_end_users            (read-only)
//   /user/end-users/list     {limit<=100, cursor}                          (read-only)
//   /user/end-users/get      {end_user_id}                                 (read-only)
//   /memory/list             {character_id, end_user_id, page, page_size}  (read-only, --count-memories)
//   /user/end-users/delete   {end_user_id}   --apply only. Route existence confirmed by OPTIONS; the request
//                            body shape is the natural guess and is NOT yet confirmed, so --apply stops at the
//                            first failure. Deletes the end-user record and its memories across all characters.
//
// Never calls /memory/delete-all or any bulk/all-users endpoint. Never prints the API key.
// A record is a candidate only if its id matches a known test-script pattern, or is a UUID that our own
// repo files record as a test end-user id. The real player id (runtime/player-memory.json) and anything
// else (guest:, google:, convai:, e-mails, chessbuddy-*, unrecorded UUIDs) is excluded.
import {readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {join, extname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');   // the repository root, from this file's place in scripts/
const candidatesFile = `${repo}/runtime/cleanup-candidates.json`;   // runtime/ is git-ignored
const API = 'https://api.convai.com';
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const numArg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && Number.isInteger(+args[i + 1]) ? +args[i + 1] : fallback; };
const APPLY = flag('--apply');
const LIMIT = numArg('--limit', Infinity);
const COUNT_MEMORIES = flag('--count-memories');
const SAMPLE = numArg('--sample', 3);                  // users per family when counting memories
const ALL = flag('--all');                             // every end user on the account, not just test ids
const INCLUDE_PLAYER = flag('--include-player');       // with --all: also the real player id (wipes your own companion memories)
const RECENT_MINUTES = numArg('--recent-minutes', 60); // ids active this recently are skipped (a probe may be running)
const sleep = ms => new Promise(r => setTimeout(r, ms));

const keyText = (await readFile(`${repo}/runtime/convai-key.txt`, 'utf8')).trim();
const key = /^api-key\s*=\s*(\S+)\s*$/im.exec(keyText)?.[1];
if (!key) { console.log('key file has no api-key line'); process.exit(1); }

// ---- the real player, always protected ----
const registry = JSON.parse(await readFile(`${repo}/runtime/player-memory.json`, 'utf8'));
const protectedIds = new Set([registry.endUserId]);
try { protectedIds.add(JSON.parse(await readFile(`${repo}/runtime/player-memory.json.identity`, 'utf8')).endUserId); } catch { /* optional */ }
protectedIds.delete(undefined);
if (!registry.endUserId) { console.log('no real endUserId in runtime/player-memory.json; refusing'); process.exit(1); }
const realId = registry.endUserId;

// ---- throttled, retrying POST (the API rate-limits per minute with HTTP 429) ----
let lastCall = 0;
async function post(path, body) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const wait = lastCall + 700 - Date.now(); if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const response = await fetch(API + path, {method: 'POST', headers: {'CONVAI-API-KEY': key, 'Content-Type': 'application/json'},
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000)});
    if (response.status === 429) { await sleep(15000); continue; }
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return {status: response.status, json, text};
  }
  throw Error(`rate limited too long on ${path}`);
}
const ltmUsage = async () => (await post('/user/user-api-usage', {})).json?.usage?.ltm_end_users;

// ---- classification ----
const FAMILY_PATTERNS = [
  ['third-person-probe', /^third-person-probe-[0-9a-f]{6,}(-\d+)?$/],  // scripts/Probe-ThirdPerson.mjs
  ['emotion-tags-probe', /^emotion-tags-probe-[0-9a-f]{16}$/],        // scripts/Probe-EmotionTags.mjs
  ['emotion-probe', /^emotion-probe-[0-9a-f]{16}$/],                  // scripts/Probe-EmotionReplies.mjs
  ['follow-up-probe', /^follow-up-probe-[0-9a-f]{16}$/],              // scripts/Probe-FollowUp.mjs
  ['natural-speech-probe', /^natural-speech-probe-[0-9a-f]{16}$/],    // scripts/Probe-NaturalSpeech.mjs
  ['romance-probe', /^romance-probe-[0-9a-f]{16}$/],                  // scripts/Probe-RomanceBlock.mjs
  ['quest-recency-probe', /^quest-recency-probe-[0-9a-f]{16}$/],
  ['visual-lipsync', /^visual-lipsync-\d{10,}$/],
  ['probe-uuid', /^probe-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/],
];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const SCAN_DIRS = ['runtime', 'research', 'scripts', 'docs', '.private', 'tests', 'bridge'];
const SCAN_EXT = new Set(['.json', '.mjs', '.js', '.md', '.txt', '.log', '.py', '.ndjson']);
async function recordedTestUuids() {
  // A UUID counts as recorded only if it sits right after an end-user-ish key in one of our own files.
  const found = new Map();
  const context = /(end[_-]?user|benchmarkEndUser|test user|throwaway|probe user|users?["']?\s*[:=])/i;
  async function walk(dir, depth) {
    let entries; try { entries = await readdir(dir, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < 5) await walk(path, depth + 1); continue; }
      if (!SCAN_EXT.has(extname(entry.name).toLowerCase())) continue;
      let size; try { size = (await stat(path)).size; } catch { continue; }
      if (size > 8 * 1024 * 1024) continue;
      let text; try { text = await readFile(path, 'utf8'); } catch { continue; }
      for (const match of text.matchAll(UUID)) {
        const before = text.slice(Math.max(0, match.index - 90), match.index);
        if (context.test(before)) { if (!found.has(match[0])) found.set(match[0], path.slice(repo.length + 1)); }
      }
    }
  }
  for (const dir of SCAN_DIRS) await walk(join(repo, dir), 0);
  return found;
}

function classify(id, recorded) {
  if (protectedIds.has(id)) return {kind: 'protected', family: 'real player'};
  for (const [family, pattern] of FAMILY_PATTERNS) if (pattern.test(id)) return {kind: 'test', family};
  if (recorded.has(id)) return {kind: 'test', family: 'uuid recorded in repo files'};
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return {kind: 'excluded', family: 'unrecorded uuid'};
  return {kind: 'excluded', family: id.replace(/[:@-].*$/, '') + ' (not ours)'};
}

// ---- fetch every end user ----
async function listAll() {
  const all = []; let cursor;
  for (let page = 0; page < 500; page++) {
    const result = await post('/user/end-users/list', {limit: 100, ...(cursor ? {cursor} : {})});
    if (result.status !== 200 || !Array.isArray(result.json?.end_users)) throw Error(`list failed: HTTP ${result.status}`);
    all.push(...result.json.end_users);
    if (!result.json.has_more || !result.json.next_cursor) return {users: all, total: result.json.total_count};
    cursor = result.json.next_cursor;
  }
  throw Error('too many pages');
}

const modeText = APPLY ? `APPLY (deletes up to ${Number.isFinite(LIMIT) ? LIMIT : 'ALL'} confident test end users)` : 'READ-ONLY';
console.log(`mode: ${modeText}`);
console.log(`real player id (protected, never touched): ${realId.slice(0, 8)}...`);

const usageBefore = await ltmUsage();
console.log(`LTM end users usage counter: ${usageBefore?.usage} of ${usageBefore?.limit}`);
const recorded = await recordedTestUuids();
const {users, total} = await listAll();
console.log(`end-user records on the account: ${users.length} (server total_count ${total})`);

const rows = users.map(user => ({...user, ...classify(user.end_user_id, recorded)}));
const real = rows.find(r => r.end_user_id === realId);
console.log(`real id present in list: ${real ? 'yes, excluded' : 'no'}`);
const cutoff = new Date(Date.now() - RECENT_MINUTES * 60000).toISOString().slice(0, 19);
const candidates = ALL ? rows.filter(r => INCLUDE_PLAYER || r.end_user_id !== realId) : rows.filter(r => r.kind === 'test');
if (ALL) console.log(`--all: every end user is a candidate (${candidates.length})${INCLUDE_PLAYER ? ', INCLUDING the real player id' : ', real player id kept'}`);
const recent = candidates.filter(r => r.last_active_ts >= cutoff);
const deletable = candidates.filter(r => r.last_active_ts < cutoff);

const group = (list, pick) => { const m = new Map(); for (const r of list) m.set(pick(r), (m.get(pick(r)) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
console.log(`\nTEST end users (confident): ${candidates.length}`);
for (const [family, n] of group(candidates, r => r.family)) {
  const sub = candidates.filter(r => r.family === family);
  const withLtm = sub.filter(r => r.last_ltm_usage_ts).length;
  console.log(`  ${String(n).padStart(5)}  ${family}   (LTM ever used: ${withLtm})`);
}
console.log(`  of which active in the last ${RECENT_MINUTES} min (skipped, a probe may still be running): ${recent.length}`);
console.log(`  eligible for deletion now: ${deletable.length}`);
console.log(`\nEXCLUDED (not confidently ours): ${rows.filter(r => r.kind === 'excluded').length}`);
for (const [family, n] of group(rows.filter(r => r.kind === 'excluded'), r => r.family).slice(0, 8)) console.log(`  ${String(n).padStart(5)}  ${family}`);
const unrecorded = rows.filter(r => r.family === 'unrecorded uuid');
const cycleStart = (await post('/user/user-api-usage', {})).json?.usage?.usage_cycle?.cycle_start?.slice(0, 19);
console.log(`\ncycle start ${cycleStart}; records with LTM usage since then: ${rows.filter(r => r.last_ltm_usage_ts >= cycleStart).length} `
  + `(test ${candidates.filter(r => r.last_ltm_usage_ts >= cycleStart).length}, real 1, other ${rows.filter(r => r.kind === 'excluded' && r.last_ltm_usage_ts >= cycleStart).length})`);
console.log(`unrecorded UUID ids: ${unrecorded.length}; they may be tests (Test-Multilingual uses randomUUID) but are not provable, so they are excluded`);

await writeFile(candidatesFile, JSON.stringify({generatedAt: new Date().toISOString(),
  realIdPrefix: realId.slice(0, 8), candidates: candidates.map(r => ({id: r.end_user_id, family: r.family, lastActive: r.last_active_ts, lastLtm: r.last_ltm_usage_ts}))}, null, 1));
console.log(`candidate list written to ${candidatesFile}`);

// ---- optional bounded memory sampling ----
if (COUNT_MEMORIES) {
  const {ConvaiMemoryAdapter} = await import(pathToFileURL(`${repo}/bridge/convai-memory.mjs`).href);
  const adapter = new ConvaiMemoryAdapter({key, enabled: true, timeoutMs: 30000});
  const characters = Object.keys(registry.characters || {});
  let calls = 0, memories = 0;
  console.log(`\nmemory sample: ${SAMPLE} LTM-used users per family x ${characters.length} characters (read-only /memory/list)`);
  const totals = {};
  for (const [family] of group(candidates, r => r.family)) {
    const sample = candidates.filter(r => r.family === family && r.last_ltm_usage_ts).slice(0, SAMPLE);
    let familyMemories = 0;
    for (const r of sample) for (const characterId of characters) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const wait = lastCall + 700 - Date.now(); if (wait > 0) await sleep(wait);
        lastCall = Date.now(); calls++;
        try {
          const result = await adapter.list({characterId, endUserId: r.end_user_id, page: 1, pageSize: 1});
          familyMemories += result.total_count; break;
        } catch (cause) {
          if (cause.status === 429) { await sleep(15000); continue; }
          break; // 404 / other: no memories for this pair
        }
      }
    }
    memories += familyMemories; totals[family] = {sampled: sample.length, memories: familyMemories};
    console.log(`  ${family}: ${familyMemories} memories across ${sample.length} sampled users`);
  }
  console.log(`  sampled total: ${memories} memories in ${calls} calls (a sample, not the full count)`);
}

if (!APPLY) {
  console.log('\nread-only run complete; nothing was deleted.');
  console.log('First delete a single end user and watch the counter:  --apply --limit 1');
  process.exit(0);
}

// ---- apply ----
const targets = deletable.slice(0, LIMIT);
console.log(`\napplying: deleting ${targets.length} end-user records (each also removes that user's memories on every character)`);
let deleted = 0, failed = 0, consecutiveFailures = 0;
for (const r of targets) {
  const id = r.end_user_id;
  // Hard guards, re-checked at the moment of deletion.
  if (ALL ? (id === realId && !INCLUDE_PLAYER) : (protectedIds.has(id) || id === realId || classify(id, recorded).kind !== 'test')) { console.log(`REFUSED ${id.slice(0, 12)}... (protected or not a confident test id)`); continue; }
  const result = await post('/user/end-users/delete', {end_user_id: id});
  const ok = result.status === 200 && result.json?.deleted !== false;
  if (ok) {
    const check = await post('/user/end-users/get', {end_user_id: id});
    const gone = check.status === 404 || check.status === 400 || /not found/i.test(check.text);
    deleted++; consecutiveFailures = 0;
    if (deleted <= 3 || deleted % 100 === 0) console.log(`deleted ${id.slice(0, 24)} HTTP ${result.status} response ${result.text.slice(0, 100)} | verified gone: ${gone}`);
    if (deleted === 1 && !gone) { console.log('first delete did not verify as gone (maybe asynchronous); stopping so you can inspect'); break; }
  } else {
    failed++; consecutiveFailures++;
    console.log(`delete failed for ${id.slice(0, 24)}: HTTP ${result.status} ${result.text.slice(0, 160)}`);
    if (consecutiveFailures >= 3 || deleted === 0) { console.log('stopping after failures; the delete request shape may be wrong'); break; }
  }
}
const usageAfter = await ltmUsage();
console.log(`\ndeleted ${deleted}, failed ${failed}`);
console.log(`LTM end users usage counter: before ${usageBefore?.usage}, after ${usageAfter?.usage} (limit ${usageAfter?.limit})`);
console.log(usageAfter?.usage < usageBefore?.usage ? 'the counter dropped: deleting frees quota'
  : 'the counter did not drop (other activity may also move it; compare with a quiet account)');
