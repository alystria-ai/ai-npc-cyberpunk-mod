// Bounded disposable-character experiment; default is an offline plan.
// --preflight launches and closes only an owned headless browser.
// --run creates at most nine disposable profiles, one at a time, and sends at
// normally 36 text turns. --cleanup-only recovers the durable ownership receipt.
// --resume-after-id-change is the one explicitly authorized continuation after
// the synthetic-identity policy changed: max 37 dispatches, 36 measured replies.
import {readFile, mkdir, open, rename, unlink, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID, randomBytes, randomInt, createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {build} from 'esbuild';
import {buildProfiles} from '../scripts/build_research.mjs';
import {characterPayload, verifyCharacter} from '../../../scripts/character-payload.mjs';
import {conditionProfile, conditions, model} from './conditions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const privateDir = resolve(here, '.private');
const receiptPath = resolve(privateDir, 'receipt.json');
const lockPath = resolve(privateDir, 'run.lock');
const args = new Set(process.argv.slice(2));
if ([...args].some(x => !['--run', '--preflight', '--cleanup-only', '--resume-after-id-change'].includes(x)) || args.size > 1)
  throw Error('Use no argument, --preflight, --run, --cleanup-only or --resume-after-id-change.');
const resumingIdentityChange = args.has('--resume-after-id-change');
const dispatchLimit = resumingIdentityChange ? 37 : 36;
const json = text => JSON.parse(text.replace(/^\uFEFF/, ''));
const readJson = async path => json(await readFile(path, 'utf8'));
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const fail = (code, status) => Object.assign(new Error(code), {code, status});
const safeError = error => ({code: /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'LOCAL_OPERATION_FAILED',
  ...(Number.isInteger(error?.status) ? {status: error.status} : {})});
const validId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(x);
const delay = ms => new Promise(done => setTimeout(done, ms));
const exchangeComplete = x => !x.abandoned && x.turns.length === 2 && x.turns.every(t => t.result?.textComplete === true);
async function stopIfRequested() {
  try { await readFile(resolve(privateDir, 'STOP')); throw fail('OPERATOR_STOP_REQUESTED'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const shuffle = rows => { const result = [...rows]; for (let i = result.length - 1; i > 0; --i) {
  const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]];
} return result; };
const keys = ['johnny-silverhand', 'judy-alvarez', 'panam-palmer'];
const scenarioFile = await readJson(resolve(here, 'scenarios.json'));
const roster = await readJson(resolve(root, 'characters/roster.json'));
const selected = roster.filter(row => keys.includes(row.key));
const dossiers = await Promise.all(keys.map(key => readJson(resolve(here, '../dossiers', key + '.json'))));
const baseProfiles = buildProfiles(selected, dossiers);
if (baseProfiles.length !== 3 || baseProfiles.some(row => row.model !== model)) throw fail('MODEL_PREFLIGHT_MISMATCH');
const references = new Map();
for (const key of keys) {
  const short = key.split('-')[0];
  const refs = await readJson(resolve(here, 'references', short + '.json'));
  const held = await readJson(resolve(here, 'held-out', short + '.json'));
  const scene = row => row.provenance.scene?.depotPath ?? row.provenance.depotPath;
  const heldIds = new Set(held.references.map(row => row.provenance.locstringId));
  const heldScenes = new Set(held.references.map(scene));
  if (refs.characterKey !== key || refs.references.length !== 5
    || refs.references.some(row => heldIds.has(row.provenance.locstringId) || heldScenes.has(scene(row))))
    throw fail('REFERENCE_PARTITION_INVALID');
  references.set(key, refs.references);
}
if (scenarioFile.exchanges.length !== 6 || keys.some(key => scenarioFile.exchanges.filter(x => x.characterKey === key).length !== 2)
  || scenarioFile.exchanges.some(x => x.turns.length !== 2)) throw fail('SCENARIO_LIMIT_INVALID');
const plans = baseProfiles.flatMap(base => conditions.map(variant => ({key: base.key, variant,
  profile: conditionProfile(base, variant, references.get(base.key))})));
for (const plan of plans) characterPayload(plan.profile);
const planHash = sha({model, scenarios: scenarioFile, plans: plans.map(x => ({key: x.key, variant: x.variant,
  backstory: x.profile.backstory, style: x.profile.speakingStyleDescription, examples: x.profile.speakingStyleSampleDialogues}))});

let browser, page, server, key, receipt, lock, lastRequest = 0;
const save = async () => {
  const temp = receiptPath + '.tmp-' + randomUUID();
  const file = await open(temp, 'wx');
  try { await file.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temp, receiptPath);
};
async function startBrowser() {
  const bundled = await build({entryPoints: [resolve(here, 'browser-client.mjs')], bundle: true,
    write: false, format: 'iife', platform: 'browser', logLevel: 'silent'});
  const source = bundled.outputFiles[0].text;
  server = createServer((request, response) => {
    if (request.headers.host !== `127.0.0.1:${server.address()?.port}`) { response.writeHead(403).end(); return; }
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/client.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(source); }
    else if (request.url === '/') { response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><script src="/client.js"></script>'); }
    else response.writeHead(404).end();
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  browser = await chromium.launch({channel: 'msedge', headless: true, args: ['--disable-gpu']});
  page = await browser.newPage();
  // Browser console/network payloads are deliberately not forwarded: SDK logs
  // can contain tokens. No microphone, camera or audio playback is initialized.
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.dialogueStyleProbe?.version === 1);
}
async function closeBrowser() {
  if (page && !page.isClosed()) await page.evaluate(() => window.dialogueStyleProbe.close()).catch(() => {});
  await browser?.close().catch(() => {});
  await new Promise(done => server ? server.close(done) : done());
}
async function core(endpoint, body) {
  if (!['/character/create', '/character/get', '/character/update', '/character/list', '/character/delete'].includes(endpoint))
    throw fail('CORE_ENDPOINT_FORBIDDEN');
  if (endpoint !== '/character/list' && endpoint !== '/character/create'
    && !receipt?.profiles.some(p => p.characterId === body.charID)) throw fail('CORE_UNOWNED_ID');
  await delay(Math.max(0, 1100 - (Date.now() - lastRequest))); lastRequest = Date.now();
  let response;
  try { response = await fetch('https://api.convai.com' + endpoint, {method: 'POST',
    headers: {'Content-Type': 'application/json', 'CONVAI-API-KEY': key},
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000)}); }
  catch { throw fail('CORE_TRANSPORT_UNCERTAIN'); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw fail('CORE_HTTP_ERROR', response.status); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try { for (;;) { const {done, value} = await reader.read(); if (done) break;
    size += value.length; if (size > 4 * 1024 * 1024) { void reader.cancel().catch(() => {}); throw fail('CORE_RESPONSE_TOO_LARGE'); }
    chunks.push(value); } }
  finally { reader.releaseLock(); }
  let result;
  try { result = json(Buffer.concat(chunks, size).toString('utf8')); if (typeof result === 'string') result = json(result); }
  catch { throw fail('CORE_INVALID_JSON'); }
  if (!result || typeof result !== 'object' || ['ERROR', 'API_ERROR', 'INTERNAL_ERROR'].some(k => result[k])) throw fail('CORE_API_REJECTED');
  return result;
}
async function owned(profile) {
  if (!validId(profile.characterId)) throw fail('OWNED_ID_MISSING');
  const actual = await core('/character/get', {charID: profile.characterId});
  if (actual.character_id !== profile.characterId || actual.character_name !== profile.payload.charName
    || !actual.backstory?.includes(profile.marker)) throw fail('PROFILE_OWNERSHIP_MISMATCH');
  return actual;
}
async function listProfiles() {
  const result = await core('/character/list', {});
  if (!Array.isArray(result.characters)) throw fail('CORE_INVALID_LIST');
  return result.characters;
}
async function recoverCreate(profile) {
  const candidates = (await listProfiles()).filter(x => x.character_name === profile.payload.charName);
  const found = [];
  for (const candidate of candidates) {
    if (!validId(candidate.character_id)) throw fail('DISCOVERY_INVALID_ID');
    // Temporarily record the exact-name candidate so the allowlist can read it;
    // deletion still requires a fresh marker ownership verification below.
    profile.characterId = candidate.character_id; await save();
    const actual = await core('/character/get', {charID: candidate.character_id});
    if (actual.character_name === profile.payload.charName && actual.backstory?.includes(profile.marker)) found.push(candidate.character_id);
  }
  delete profile.characterId;
  if (found.length !== 1) { await save(); throw fail(found.length ? 'CREATE_AMBIGUOUS_NO_RETRY' : 'CREATE_UNRESOLVED_NO_RETRY'); }
  profile.characterId = found[0]; profile.createRecovered = true; await save();
}
async function cleanup(profile) {
  if (profile.cleanup?.profileAbsent) return;
  if (!profile.characterId && profile.createDispatched) await recoverCreate(profile);
  if (!profile.characterId) return;
  profile.cleanup ??= {};
  const before = await listProfiles();
  if (!before.some(x => x.character_id === profile.characterId)) {
    profile.cleanup.profileAbsent = true; await save(); return;
  }
  await owned(profile);
  if (profile.cleanup.deleteDispatched) throw fail('DELETE_UNCERTAIN_NO_RETRY');
  profile.cleanup.deleteDispatched = true; await save();
  await core('/character/delete', {charID: profile.characterId});
  profile.cleanup.profileAbsent = !(await listProfiles()).some(x => x.character_id === profile.characterId);
  await save();
  if (!profile.cleanup.profileAbsent) throw fail('DELETE_NOT_VERIFIED');
}
async function publishBlind() {
  if (!receipt.completed || !receipt.profiles.every(p => p.cleanup?.profileAbsent)) return;
  if (!receipt.blindGroupOrder) {
    // An already-issued packet must retain its order and hashes when a later
    // cleanup command checks the completed receipt.
    let previous;
    try { previous = await readJson(resolve(here, 'blind-samples.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    receipt.blindGroupOrder = previous?.groups?.map(x => x.scenarioId)
      ?? shuffle(scenarioFile.exchanges).map(x => x.id);
    await save();
  }
  if (receipt.blindGroupOrder.length !== 6 || new Set(receipt.blindGroupOrder).size !== 6
    || receipt.blindGroupOrder.some(id => !scenarioFile.exchanges.some(x => x.id === id))) throw fail('BLIND_GROUP_ORDER_INVALID');
  const groups = receipt.blindGroupOrder.map(id => scenarioFile.exchanges.find(x => x.id === id)).map(scenario => {
    const matching = receipt.exchanges.filter(x => x.scenarioId === scenario.id && exchangeComplete(x));
    if (matching.length !== 3 || matching.some(x => x.turns.length !== 2)) throw fail('BLIND_COUNT_INVALID');
    return {scenarioId: scenario.id, character: baseProfiles.find(x => x.key === scenario.characterKey).name,
      kind: scenario.kind, variants: matching.sort((a, b) => a.blindLabel.localeCompare(b.blindLabel)).map(x => ({
        label: x.blindLabel, exchangeId: x.blindId,
        turns: x.turns.map((turn, i) => ({responseId: turn.blindId, user: scenario.turns[i], response: turn.result.text})),
      }))};
  });
  const clean = {version: 1, context: scenarioFile.context,
    blinding: 'A/B/C are independently shuffled within each character/scenario group. The same letter does not identify one prompt across groups.', groups};
  await writeFile(resolve(here, 'blind-samples.json'), JSON.stringify(clean, null, 2) + '\n');
  let markdown = '# Blind dialogue samples\n\n' + clean.blinding + '\n\n' + scenarioFile.context + '\n';
  for (const group of groups) {
    markdown += `\n## ${group.character} — ${group.kind}\n\nScenario: ${group.scenarioId}\n`;
    for (const variant of group.variants) {
      markdown += `\n### ${variant.label} — ${variant.exchangeId}\n`;
      for (const turn of variant.turns) markdown += `\n**V:** ${turn.user}\n\n**${group.character} (${turn.responseId}):** ${turn.response}\n`;
    }
  }
  await writeFile(resolve(here, 'BLIND_SAMPLES.md'), markdown);
  const timing = receipt.exchanges.filter(exchangeComplete).flatMap(x => x.turns.map((turn, i) => ({responseId: turn.blindId,
    exchangeId: x.blindId, characterKey: x.characterKey, scenarioId: x.scenarioId, turn: i + 1,
    connectionMs: i === 0 ? x.connection.connectionMs : null,
    firstTextMs: turn.result.firstTextMs, completeMs: turn.result.completeMs,
    words: turn.result.text.trim().split(/\s+/).length})));
  await writeFile(resolve(here, 'timings.json'), JSON.stringify({model, tts: false,
    meaning: 'Client-observed SDK latency; no audio generation or playback. Connection is separate from each text turn.', records: timing}, null, 2) + '\n');
  await writeFile(resolve(here, 'CLEANUP.md'), '# Disposable-profile cleanup\n\n'
    + `Run receipt hash: ${sha(receipt.runId).slice(0, 16)}.\n\n`
    + `All ${receipt.profiles.length} disposable profiles were removed, with fresh list verification after each deletion. `
    + `At most one was alive at a time. ${receipt.dispatchedTurns} text turns were dispatched; 36 completed replies are included in the comparison.\n\n`
    + (receipt.identityPolicyChange ? 'The first eight responses were complete when the operator changed the synthetic-user reuse policy. '
      + 'One in-flight send was abandoned with no recorded response; it was excluded without inspecting or selecting its output. '
      + 'The operator explicitly authorized one replacement send (37 total cap) in a fresh two-turn session. '
      + 'No ambiguous Core create/update/delete was retried. Five synthetic end-user IDs had been allocated before the stop; '
      + 'all remaining exchanges reused the first durable synthetic ID. All three pre-stop disposable profiles were verified absent before continuing.\n\n' : '')
    + 'All profiles had memory_settings.enabled read back as false before any conversation. Each two-turn exchange used a fresh session. '
    + 'No production profile, real end-user ID, game state, microphone, local voice model or installed bridge was changed. '
    + 'Provider-side temporary analytics/end-user records may remain; no verified account-deletion endpoint was invoked. '
    + 'Recovery receipts and raw remote IDs are kept only in ignored .private storage.\n');
}

console.log(JSON.stringify({mode: args.has('--run') || resumingIdentityChange ? 'bounded-run' : args.has('--cleanup-only') ? 'cleanup-only' : 'offline-plan',
  model, characters: 3, conditions: 3, exchanges: 18, measuredReplies: 36, maxTextDispatches: dispatchLimit, maxSimultaneousProfiles: 1,
  tts: false, localGpu: false, memoryEnabled: false, productionWrites: 0, planHash}));
if (!args.size) process.exit(0);
if (args.has('--preflight')) {
  try { await startBrowser(); console.log('Offline browser/SDK preflight passed. No credentials read or remote requests sent.'); }
  finally { await closeBrowser(); }
  process.exit(0);
}
await mkdir(privateDir, {recursive: true});
try { receipt = await readJson(receiptPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (receipt?.completed && receipt.profiles.every(p => p.cleanup?.profileAbsent)) {
  await publishBlind(); console.log('Prior completed run is clean. No new requests sent.'); process.exit(0);
}
if (args.has('--cleanup-only') && !receipt) { console.log('No receipt exists; nothing to clean.'); process.exit(0); }
try { lock = await open(lockPath, 'wx'); } catch { throw fail('RUN_LOCK_EXISTS'); }
await lock.writeFile(String(process.pid)); await lock.sync();
try {
  const raw = (await readFile(resolve(root, 'runtime/convai-key.txt'), 'utf8')).trim();
  key = /^api-key\s*=\s*(\S+)\s*$/i.exec(raw)?.[1]; if (!key) throw fail('KEY_FILE_FORMAT');
  if (!args.has('--cleanup-only')) {
    // Run local prerequisites before creating any cloud object.
    await startBrowser();
    if (receipt && !resumingIdentityChange) throw fail('INCOMPLETE_RUN_CLEANUP_ONLY');
    if (resumingIdentityChange) {
      if (!receipt || receipt.identityPolicyChange || receipt.planHash !== planHash || receipt.dispatchedTurns !== 9
        || receipt.profiles.length !== 3 || !receipt.profiles.every(p => p.cleanup?.profileAbsent)
        || receipt.exchanges.filter(exchangeComplete).length !== 4) throw fail('IDENTITY_RESUME_PRECONDITION_FAILED');
      const unfinished = receipt.exchanges.filter(x => !exchangeComplete(x));
      if (unfinished.length !== 1 || unfinished[0].turns.length !== 1 || unfinished[0].turns[0].result)
        throw fail('IDENTITY_RESUME_AMBIGUOUS_CELL');
      unfinished[0].abandoned = {reason: 'operator changed synthetic-user reuse policy during in-flight reply',
        measured: false, replacementExplicitlyAuthorized: true};
      receipt.benchmarkEndUserId = receipt.exchanges[0].endUserId;
      receipt.identityPolicyChange = {at: new Date().toISOString(), previouslyAllocatedIds: 5,
        policy: 'reuse first durable synthetic end-user ID; fresh session per pair', dispatchLimit: 37,
        preStopOwnedProfilesVerifiedAbsent: 3, abandonedDispatches: 1};
      delete receipt.failure;
    } else {
      receipt = {version: 1, runId: randomUUID(), benchmarkEndUserId: randomUUID(), startedAt: new Date().toISOString(), model,
        planHash, dispatchedTurns: 0, profiles: [], exchanges: [], completed: false};
    }
    await save();
    const labels = new Map(scenarioFile.exchanges.map(x => {
      const existing = Object.fromEntries(receipt.exchanges.filter(row => row.scenarioId === x.id).map(row => [row.variant, row.blindLabel]));
      const available = shuffle(['A', 'B', 'C'].filter(label => !Object.values(existing).includes(label)));
      for (const condition of conditions.filter(c => !existing[c])) existing[condition] = available.shift();
      if (new Set(Object.values(existing)).size !== 3) throw fail('BLIND_LABEL_COLLISION');
      return [x.id, existing];
    }));
    receipt.blindLabels = Object.fromEntries(labels); await save();
    // Balanced character-specific rotation avoids giving every baseline the
    // first time slot while keeping only one disposable profile alive.
    const jobs = keys.flatMap((char, index) => conditions.map((_, i) => plans.find(p => p.key === char && p.variant === conditions[(i + index) % 3])));
    for (const job of jobs) {
      if (scenarioFile.exchanges.filter(s => s.characterKey === job.key).every(s => receipt.exchanges.some(x =>
        x.characterKey === job.key && x.variant === job.variant && x.scenarioId === s.id && exchangeComplete(x)))) continue;
      await stopIfRequested();
      if (receipt.profiles.some(p => !p.cleanup?.profileAbsent)) throw fail('PREVIOUS_PROFILE_NOT_CLEAN');
      const marker = '[CyberpunkConvai disposable dialogue style:' + randomUUID() + ']';
      const profile = {...job.profile,
        name: job.profile.name + ' StyleProbe ' + randomBytes(6).toString('hex'),
        backstory: `Your conversational name is ${job.profile.name}; the administrative StyleProbe suffix is not your in-world name.\n\n`
          + job.profile.backstory + '\n\nAdministrative ownership metadata, never spoken: ' + marker};
      const ownedProfile = {key: job.key, variant: job.variant, marker, payload: characterPayload(profile),
        sourceProfileHash: sha(characterPayload(job.profile)), createDispatched: true};
      receipt.profiles.push(ownedProfile); await save();
      try {
        const created = await core('/character/create', ownedProfile.payload);
        if (!validId(created.charID)) throw fail('CREATE_ID_MISSING');
        ownedProfile.characterId = created.charID; await save();
        let actual = await owned(ownedProfile);
        verifyCharacter(ownedProfile.characterId, actual, ownedProfile.payload, 'owned-disposable');
        if (actual.memory_settings?.enabled !== false) {
          ownedProfile.disableMemoryDispatched = true; await save();
          await core('/character/update', {charID: ownedProfile.characterId, memorySettings: {enabled: false}});
          actual = await owned(ownedProfile);
        }
        if (actual.memory_settings?.enabled !== false) throw fail('MEMORY_DISABLED_NOT_CONFIRMED');
        verifyCharacter(ownedProfile.characterId, actual, ownedProfile.payload, 'owned-disposable');
        const modelRow = (await listProfiles()).find(x => x.character_id === ownedProfile.characterId);
        if (modelRow?.personalised_prompt_config?.MODEL !== model) throw fail('MODEL_READBACK_MISMATCH');
        ownedProfile.verified = {memoryEnabled: false, model, separateFields: true}; await save();
        for (const scenario of scenarioFile.exchanges.filter(x => x.characterKey === job.key)) {
          if (receipt.exchanges.some(x => x.characterKey === job.key && x.variant === job.variant && x.scenarioId === scenario.id && exchangeComplete(x))) continue;
          const exchange = {characterKey: job.key, variant: job.variant, scenarioId: scenario.id,
            blindId: 'E-' + randomBytes(4).toString('hex'), blindLabel: labels.get(scenario.id)[job.variant],
            endUserId: receipt.benchmarkEndUserId, turns: []};
          receipt.exchanges.push(exchange); await save();
          exchange.connectionDispatched = true; await save();
          exchange.connection = await page.evaluate(config => window.dialogueStyleProbe.connect(config),
            {key, characterId: ownedProfile.characterId, endUserId: exchange.endUserId, context: scenarioFile.context});
          await save();
          if (exchange.connection.error) throw fail(exchange.connection.error);
          if (!exchange.connection.identityVerified || exchange.connection.microphoneTracks !== 0) throw fail('SDK_ISOLATION_INVALID');
          for (const prompt of scenario.turns) {
            await stopIfRequested();
            if (receipt.dispatchedTurns >= dispatchLimit) throw fail('GENERATION_LIMIT_REACHED');
            const turn = {blindId: 'R-' + randomBytes(4).toString('hex'), prompt, dispatched: true};
            exchange.turns.push(turn); ++receipt.dispatchedTurns; await save();
            turn.result = await page.evaluate(text => window.dialogueStyleProbe.reply(text), prompt); await save();
            if (turn.result.error) throw fail(turn.result.error);
            if (!turn.result.textComplete || !turn.result.text?.trim()) throw fail('REPLY_INCOMPLETE');
            console.log(JSON.stringify({completedTextReplies: receipt.exchanges.reduce((n, x) => n + x.turns.filter(t => t.result?.textComplete).length, 0),
              firstTextMs: Math.round(turn.result.firstTextMs), completeMs: Math.round(turn.result.completeMs)}));
          }
          await page.evaluate(() => window.dialogueStyleProbe.close());
          exchange.closed = true; await save();
        }
      } finally {
        if (page && !page.isClosed()) await page.evaluate(() => window.dialogueStyleProbe.close()).catch(() => {});
        await cleanup(ownedProfile);
      }
    }
    if (receipt.exchanges.filter(exchangeComplete).length !== 18 || receipt.dispatchedTurns > dispatchLimit)
      throw fail('FINAL_REPLY_COUNT_INVALID');
    receipt.completed = true; receipt.finishedAt = new Date().toISOString(); await save();
  }
} catch (error) {
  if (receipt) { receipt.failure = safeError(error); await save(); }
  console.error('Experiment stopped: ' + safeError(error).code + (error.status ? ` (HTTP ${error.status})` : ''));
  process.exitCode = 1;
} finally {
  await closeBrowser();
  if (receipt && key) {
    for (const profile of receipt.profiles) {
      try { await cleanup(profile); }
      catch (error) { profile.cleanupFailure = safeError(error); await save(); process.exitCode = 1;
        console.error('Cleanup needs receipt recovery: ' + safeError(error).code); }
    }
    await publishBlind();
  }
  await lock.close(); await unlink(lockPath);
}
console.log(JSON.stringify({completed: receipt?.completed === true, textTurnsDispatched: receipt?.dispatchedTurns ?? 0,
  disposableProfilesRemoved: receipt?.profiles.filter(p => p.cleanup?.profileAbsent).length ?? 0,
  disposableProfilesCreated: receipt?.profiles.length ?? 0}));
