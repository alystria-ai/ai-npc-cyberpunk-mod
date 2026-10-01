import {readFile, writeFile, rename, mkdir, open, unlink} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {buildRelationshipProfilePayloads} from './relationship-profile-payloads.mjs';
import {characterMatches, verifyCharacter, verifyMemoryConfiguration} from './character-payload.mjs';
import {relationshipRegistry} from '../bridge/relationship-routing.mjs';

const marker = key => `[CyberpunkConvai profile v2:${key}]`;
const clone = value => structuredClone(value);

/** Only Core character definitions are touched. No end-user/memory/session API.
 * An uncertain create is reconciled by its exact ownership marker on a later
 * run; absence of a receipt never authorizes repeating that create blindly. */
export async function provisionRelationshipProfiles({roster, ordinaryIds, registry = {version: 1, characters: {}},
  intents = {}, api, persist = async () => {}, onVerified = () => {}}) {
  const rows = buildRelationshipProfilePayloads(roster), next = clone(registry), state = clone(intents);
  relationshipRegistry(ordinaryIds, next);
  const cloud = await api('/character/list', {});
  if (!Array.isArray(cloud?.characters)) throw Error('Core character listing is unavailable.');
  const owned = new Map(cloud.characters.map(row => [row.character_id, row]));
  // Validate every ordinary owner before creating or updating an alternate.
  for (const row of rows) {
    const baseId = ordinaryIds[row.profileKey];
    if (!owned.has(baseId)) throw Error('Ordinary profile is not owned: ' + row.profileKey);
    const base = await api('/character/get', {charID: baseId});
    if (base?.character_id !== baseId || !base.backstory?.split(/\r?\n/u).includes(marker(row.profileKey))) {
      throw Error('Ordinary profile ownership is unverified: ' + row.profileKey);
    }
  }
  const report = [];
  const save = () => persist(clone(next), clone(state));
  for (const row of rows) {
    let id = next.characters[row.profileKey]?.romanticCharacterId
      ?? (['mapped', 'verified'].includes(state[row.profileKey]?.phase) ? state[row.profileKey].characterId : undefined), before;
    if (id) {
      if (!owned.has(id)) throw Error('Alternate profile is not owned: ' + row.profileKey);
      before = await api('/character/get', {charID: id});
      if (before?.character_id !== id || !before.backstory?.split(/\r?\n/u).includes(row.ownershipMarker)) {
        throw Error('Alternate ownership marker mismatch: ' + row.profileKey);
      }
    } else {
      for (const candidate of cloud.characters.filter(candidate => candidate.character_id !== ordinaryIds[row.profileKey]
          && candidate.character_name === row.payload.charName)) {
        const detail = await api('/character/get', {charID: candidate.character_id});
        if (detail?.backstory?.split(/\r?\n/u).includes(row.ownershipMarker)) {
          if (id) throw Error('Multiple alternate ownership markers: ' + row.profileKey);
          id = candidate.character_id; before = detail;
        }
      }
    }
    let created = false;
    if (!id) {
      if (['creating', 'uncertain'].includes(state[row.profileKey]?.phase)) {
        throw Error('Uncertain alternate creation needs reconciliation: ' + row.profileKey);
      }
      state[row.profileKey] = {phase: 'creating', marker: row.ownershipMarker, startedAt: new Date().toISOString()};
      await save();
      try {
        const result = await api('/character/create', row.payload, {create: true});
        if (typeof result?.charID !== 'string' || !result.charID) throw Error('Create did not return a character receipt.');
        id = result.charID; created = true;
      } catch (error) {
        state[row.profileKey].phase = error.definitive === true ? 'rejected' : 'uncertain';
        await save(); throw error;
      }
    }
    next.characters[row.profileKey] = {ordinaryCharacterId: ordinaryIds[row.profileKey], romanticCharacterId: id};
    relationshipRegistry(ordinaryIds, next);
    state[row.profileKey] = {...state[row.profileKey], phase: 'mapped', characterId: id};
    await save();
    if (before && (!characterMatches(before, row.payload)
        || owned.get(id)?.personalised_prompt_config?.MODEL !== row.payload.model_group_name)) {
      const updated = await api('/character/update', {charID: id, ...row.payload});
      if (updated?.STATUS !== 'SUCCESS') throw Error('Alternate update was not confirmed: ' + row.profileKey);
    }
    const actual = await api('/character/get', {charID: id});
    verifyCharacter(id, actual, row.payload, row.providerProfileKey);
    if (before) verifyMemoryConfiguration(before, actual, row.providerProfileKey);
    state[row.profileKey].phase = 'verified'; await save();
    report.push({profileKey: row.profileKey, characterId: id, created,
      memoryEnabled: actual.memory_settings?.enabled === true});
    onVerified(row.profileKey);
  }
  const final = await api('/character/list', {});
  for (const row of rows) {
    const id = next.characters[row.profileKey].romanticCharacterId;
    const listed = final.characters?.find(candidate => candidate.character_id === id);
    if (listed?.personalised_prompt_config?.MODEL !== row.payload.model_group_name) {
      throw Error('Alternate model readback mismatch: ' + row.profileKey);
    }
  }
  return {registry: next, intents: state, profiles: report};
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), runtime = resolve(root, 'runtime');
  const read = async (path, fallback) => {
    try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')); }
    catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
  };
  const roster = await read(resolve(root, 'characters/roster.json'));
  const rows = buildRelationshipProfilePayloads(roster);
  if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({mode: 'plan', profiles: rows.map(row => ({key: row.profileKey, kind: row.kind,
      biographyChars: row.payload.backstory.length, voice: row.payload.voiceType, model: row.payload.model_group_name}))}, null, 2));
    return;
  }
  const keyText = (await readFile(process.env.CYBERPUNK_CONVAI_KEY_FILE || resolve(runtime, 'convai-key.txt'), 'utf8')).trim();
  const key = /^api-key\s*=\s*(\S+)\s*$/iu.exec(keyText)?.[1];
  if (!key) throw Error('Expected the project-local api-key file.');
  const ordinaryPath = resolve(runtime, 'characters.json'), ordinaryRaw = await readFile(ordinaryPath, 'utf8');
  const ordinaryIds = JSON.parse(ordinaryRaw.replace(/^\uFEFF/u, ''));
  const target = resolve(runtime, 'relationship-profiles.json'), intentPath = resolve(runtime, 'relationship-provision-intents.json');
  let lock;
  try { lock = await open(resolve(runtime, 'character-provision.lock'), 'wx'); }
  catch { throw Error('Another character provision may be running.'); }
  const batch = resolve(runtime, 'relationship-provision', new Date().toISOString().replace(/[:.]/gu, '-'));
  const atomic = async (path, value) => {
    const tmp = path + '.' + randomUUID() + '.tmp';
    try { await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'}); await rename(tmp, path); }
    finally { await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  };
  let lastRequest = 0;
  const wait = ms => new Promise(done => setTimeout(done, ms));
  const api = async (endpoint, body, {create = false} = {}) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await wait(Math.max(0, 1100 - (Date.now() - lastRequest))); lastRequest = Date.now();
      let response;
      try { response = await fetch('https://api.convai.com' + endpoint, {method: 'POST',
        headers: {'CONVAI-API-KEY': key, 'Content-Type': 'application/json'},
        body: JSON.stringify(body), signal: AbortSignal.timeout(45000)}); }
      catch { if (!create && attempt < 3) continue; throw Error('Core transport outcome is uncertain: ' + endpoint); }
      let value;
      try { value = await response.json(); if (typeof value === 'string') value = JSON.parse(value); }
      catch { throw Error('Core returned an invalid receipt: ' + endpoint); }
      const rejection = ['ERROR', 'API_ERROR', 'INTERNAL_ERROR'].find(field => value?.[field]);
      const rateLimited = response.status === 429
        || /(?:rate limit|request limit|too many requests)/iu.test(String(rejection && value[rejection]));
      if (rateLimited && attempt < 3) { await wait(15000); continue; }
      const rejected = Boolean(rejection);
      if (!response.ok || rejected) {
        if (!create && response.status >= 500 && attempt < 3) continue;
        throw Object.assign(Error('Core rejected ' + endpoint + ' (HTTP ' + response.status + ')'),
          {definitive: rateLimited || [400, 401, 403, 404, 422, 429].includes(response.status)});
      }
      return value;
    }
  };
  try {
    await lock.writeFile(String(process.pid));
    await mkdir(batch, {recursive: true});
    const registry = await read(target, {version: 1, characters: {}}), intents = await read(intentPath, {});
    await atomic(resolve(batch, 'registry-before.json'), registry);
    const result = await provisionRelationshipProfiles({roster, ordinaryIds, registry, intents, api,
      persist: async (next, state) => {
        await atomic(intentPath, state);
        await atomic(resolve(batch, 'registry-staged.json'), next);
      },
      onVerified: profile => console.log('Verified alternate profile: ' + profile)});
    if (await readFile(ordinaryPath, 'utf8') !== ordinaryRaw) throw Error('Ordinary mappings changed during provisioning.');
    // The runtime sees only a fully read-back-verified registry. Intermediate
    // create receipts live solely in the recovery journal/staged artifact.
    await atomic(target, result.registry);
    await atomic(resolve(batch, 'report.json'), {...result, completedAt: new Date().toISOString()});
    console.log('Verified five alternate profiles; ordinary mappings and player identity were not changed.');
  } finally { await lock.close(); await unlink(resolve(runtime, 'character-provision.lock')); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
