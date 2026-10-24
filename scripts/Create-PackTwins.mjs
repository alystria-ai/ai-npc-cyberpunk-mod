// Creates a Convai twin of every character a content pack rewrites (docs/ADDON_API.md, "Content packs", content.convai).
//
//   node scripts/Create-PackTwins.mjs --pack <folder> [--only key,key] [--limit N] [--dry-run | --apply]
//
// The pack folder holds convai-addon.json whose content.characters is an object (or a path of a JSON file in the folder) of
// {profileKey: {name, backstory, speakingStyleDescription, speakingStyleSampleDialogues}}. Every backstory ends with the
// ownership marker line `[CyberpunkConvai profile v2:<key>:<pack id>]`.
//
// For each key that has a Convai original in runtime/characters.json a NEW character is created with the pack's name and the pack's three
// texts, and the original's voice, model_group_name, memory and generation settings (read with /character/get and /character/list), en-US.
// The original and the multilingual twin are only ever read, never written. Nothing else is changed.
//
// Progress is written after each step: runtime/pack-twins-<id>.json is the map {profileKey: characterId} (the shape of content.convai)
// and runtime/pack-twins-<id>.state.json holds the phases. A re-run never duplicates: a mapped twin is adopted and re-verified, and a twin whose
// create receipt was lost is found again by its marker line (searched among characters of the same name). Without --apply (or with --dry-run)
// only reads are made (the character list and the originals) and every payload is checked; nothing is created.
// The key is read from runtime/convai-key.txt (or CYBERPUNK_CONVAI_KEY_FILE) and is never printed.
import {readFile, writeFile, rename, mkdir, open, unlink} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {apiCharacterName, characterPayload} from './character-payload.mjs';
import {settingUpdates, languageUpdates, notCloned, withoutCostEstimates, LANGUAGE_CODES} from './Create-MultilingualProfiles.mjs';

export const packMarker = (key, packId) => `[CyberpunkConvai profile v2:${key}:${packId}]`;
// The limits of the character editor (docs/ADDON_API.md, "What content can hold").
export const LIMITS = Object.freeze({backstoryMin: 40, backstory: 9000, style: 1800, sampleLines: 20, sampleLine: 600, samples: 6000, total: 12500});

/** The problems of one pack row (empty when it is fine). */
export function rowProblems(key, row, packId) {
  const problems = [];
  for (const field of ['name', 'backstory', 'speakingStyleDescription', 'speakingStyleSampleDialogues']) {
    if (typeof row?.[field] !== 'string' || !row[field].trim()) problems.push(`${field} is missing`);
  }
  if (problems.length) return problems;
  const marker = packMarker(key, packId);
  if (row.backstory.split(/\r?\n/u).filter(line => line === marker).length !== 1) problems.push('ownership marker is missing or repeated');
  if (row.backstory.length < LIMITS.backstoryMin || row.backstory.length > LIMITS.backstory) problems.push('backstory length');
  if (row.speakingStyleDescription.length > LIMITS.style) problems.push('style length');
  const lines = row.speakingStyleSampleDialogues.split(/\n\s*\n/u);
  if (lines.length > LIMITS.sampleLines || lines.some(line => line.length > LIMITS.sampleLine) || row.speakingStyleSampleDialogues.length > LIMITS.samples) problems.push('sample dialogue limits');
  if (row.backstory.length + row.speakingStyleDescription.length + row.speakingStyleSampleDialogues.length > LIMITS.total) problems.push('total length');
  if (!apiCharacterName({name: row.name})) problems.push('name has no letters');
  return problems;
}

/** The request body for one twin: the pack's texts and name, the original's voice and model. Throws when the existing payload checks refuse it. */
export function packTwinPayload({key, row, packId, source, model, aliases = []}) {
  const problems = rowProblems(key, row, packId);
  if (problems.length) throw Error(`Pack row ${key}: ${problems.join(', ')}`);
  if (typeof source?.voice_type !== 'string' || !source.voice_type) throw Error('Original voice is unknown: ' + key);
  if (typeof model !== 'string' || !model) throw Error('Original model is unknown: ' + key);
  // Convai's name field takes letters, digits and spaces: an apostrophe is dropped ("Queen's" is "Queens"), anything else becomes a space.
  return characterPayload({
    key, name: row.name.replace(/['’]/gu, ''), aliases: [source.character_name, ...aliases].filter(Boolean), voice: source.voice_type, model,
    backstory: row.backstory, speakingStyleDescription: row.speakingStyleDescription, speakingStyleSampleDialogues: row.speakingStyleSampleDialogues});
}

/** Throws when the readback of a created twin differs from what was sent or from the original's settings. */
export function verifyPackTwin({id, key, source, actual, payload, model}) {
  const problems = [];
  if (actual?.character_id !== id) problems.push('id');
  if (id === source?.character_id) problems.push('twin id equals the original id');
  if (actual?.character_name !== payload.charName) problems.push('name');
  if (actual?.voice_type !== payload.voiceType) problems.push('voice');
  if (actual?.backstory !== payload.backstory) problems.push('backstory');
  if (actual?.speaking_style?.description !== payload.speaking_style_description) problems.push('speaking_style.description');
  if (actual?.speaking_style?.sample_dialogues !== payload.speaking_style_sample_dialogues) problems.push('speaking_style.sample_dialogues');
  if (!isDeepStrictEqual(actual?.language_codes, [...LANGUAGE_CODES])) problems.push('language_codes');
  if ((actual?.memory_settings?.enabled === true) !== (source?.memory_settings?.enabled === true)) problems.push('memory_settings.enabled');
  for (const field of ['state_of_mind_enabled', 'verbosity']) if (!isDeepStrictEqual(source?.[field], actual?.[field])) problems.push(field);
  if (model !== undefined && model !== payload.model_group_name) problems.push('model');
  if (problems.length) throw Error(`Pack twin readback mismatch for ${key}: ${problems.join(', ')}`);
}

const clone = value => structuredClone(value);
const LIMIT_WORDS = /(?:limit|quota|maximum|exceed|upgrade|too many characters|plan allows|credits?)/iu;

export class StopRun extends Error {}

/** Core flow, separated from I/O for tests.
 * rows: [{key, originalId, row, aliases}]; api(endpoint, body, {create}) returns parsed JSON.
 * state: {characters: {key: {phase, id}}} (persist is called after every step); map is derived by the caller from the state. */
export async function createPackTwins({packId, rows, state = {version: 1, characters: {}}, api, persist = async () => {}, log = () => {}, maxConsecutiveFailures = 3}) {
  const next = clone(state);
  next.version = 1; next.characters ??= {};
  const cloud = await api('/character/list', {});
  if (!Array.isArray(cloud?.characters)) throw Error('Character listing is unavailable.');
  const listed = new Map(cloud.characters.map(item => [item.character_id, item]));
  const modelOf = id => listed.get(id)?.personalised_prompt_config?.MODEL;
  const mappedIds = new Set(Object.values(next.characters).map(entry => entry.id).filter(Boolean));
  const originalIds = new Set(rows.map(item => item.originalId));
  const detailCache = new Map();
  const results = [], failures = [];
  let consecutive = 0, stopped = null;
  for (const {key, originalId, row, aliases} of rows) {
    if (stopped) break;
    try {
      const entry = next.characters[key] ??= {};
      const source = await api('/character/get', {charID: originalId});
      if (source?.character_id !== originalId || !listed.has(originalId)) throw Error('Original profile is not in this account: ' + key);
      const payload = packTwinPayload({key, row, packId, source, model: modelOf(originalId), aliases});
      const marker = packMarker(key, packId);
      let id = entry.id, found, created = false;
      if (id) {
        if (!listed.has(id)) throw Error('Mapped twin is not in the account: ' + key);
        found = await api('/character/get', {charID: id});
        if (!found?.backstory?.split(/\r?\n/u).includes(marker)) throw Error('Ownership marker mismatch: ' + key);
      } else {
        // A create whose receipt was lost, or a character another run made: same name and the exact marker line.
        for (const candidate of cloud.characters.filter(item => item.character_name === payload.charName && !originalIds.has(item.character_id) && !mappedIds.has(item.character_id))) {
          let detail = detailCache.get(candidate.character_id);
          if (!detail) { detail = await api('/character/get', {charID: candidate.character_id}); detailCache.set(candidate.character_id, detail); }
          if (detail?.backstory?.split(/\r?\n/u).includes(marker)) {
            if (id) throw Error('Several characters carry the marker: ' + key);
            id = candidate.character_id; found = detail;
          }
        }
        if (id) log(`Adopted existing ${payload.charName} (${key})`);
        else {
          if (state.characters[key]?.phase === 'creating') log(`Earlier create of ${key} left no character with its marker; creating it again`);
          Object.assign(entry, {phase: 'creating', originalId, startedAt: new Date().toISOString()});
          await persist(clone(next));
          let result;
          try { result = await api('/character/create', payload, {create: true}); }
          catch (error) {
            if (error instanceof StopRun) throw error;
            if (LIMIT_WORDS.test(error.message)) throw new StopRun(`Convai refused the create (account limit?): ${error.message}`);
            throw error;
          }
          if (typeof result?.charID !== 'string' || !result.charID) throw Error('Create returned no character ID: ' + key);
          id = result.charID; created = true;
          log(`Created ${payload.charName} (${key})`);
        }
      }
      mappedIds.add(id);
      Object.assign(entry, {phase: 'created', id, name: payload.charName, originalId});
      delete entry.startedAt;
      await persist(clone(next));
      let actual = found ?? await api('/character/get', {charID: id});
      // Voice, name and the three texts are part of create; the language list, generation settings and memory follow the original.
      const updates = {...settingUpdates(source, actual), ...languageUpdates(actual, LANGUAGE_CODES)};
      if (actual.voice_type !== payload.voiceType) updates.voiceType = payload.voiceType;
      if (actual.character_name !== payload.charName) updates.charName = payload.charName;
      if (actual.speaking_style?.description !== payload.speaking_style_description || actual.speaking_style?.sample_dialogues !== payload.speaking_style_sample_dialogues) {
        updates.speaking_style_description = payload.speaking_style_description;
        updates.speaking_style_sample_dialogues = payload.speaking_style_sample_dialogues;
      }
      if (actual.backstory !== payload.backstory) updates.backstory = payload.backstory;
      if (Object.keys(updates).length) {
        const response = await api('/character/update', {charID: id, ...updates});
        if (response?.STATUS !== 'SUCCESS') throw Error('Update was not confirmed: ' + key);
        actual = await api('/character/get', {charID: id});
      }
      verifyPackTwin({id, key, source, actual, payload});
      Object.assign(entry, {phase: 'verified', verified: true, verifiedAt: new Date().toISOString(), voiceType: payload.voiceType, notCloned: notCloned(source, actual), updated: Object.keys(updates)});
      await persist(clone(next));
      results.push({key, id, created});
      consecutive = 0;
    } catch (error) {
      if (error instanceof StopRun) { stopped = error.message; failures.push({key, error: error.message}); log(`STOP at ${key}: ${error.message}`); break; }
      failures.push({key, error: error.message});
      log(`FAILED ${key}: ${error.message}`);
      // A rejection (4xx) three times in a row means something is wrong with the account or the payload: stop and report.
      if (/Rejected .*HTTP 4\d\d/u.test(error.message) && ++consecutive >= maxConsecutiveFailures) { stopped = `stopped after ${consecutive} rejections in a row`; log(stopped); break; }
      if (!/Rejected .*HTTP 4\d\d/u.test(error.message)) consecutive = 0;
    }
  }
  // The model is only listed by the account list: check every verified twin of this run once, from a fresh list.
  const modelMismatch = [];
  if (results.length) {
    const final = await api('/character/list', {});
    for (const {key, id} of results) {
      const original = rows.find(item => item.key === key).originalId;
      const model = final.characters?.find(item => item.character_id === id)?.personalised_prompt_config?.MODEL;
      const want = final.characters?.find(item => item.character_id === original)?.personalised_prompt_config?.MODEL;
      if (!model || model !== want) modelMismatch.push({key, model, want}); else next.characters[key].model = model;
    }
    await persist(clone(next));
  }
  return {state: next, results, failures, stopped, modelMismatch};
}

/** The id map {profileKey: characterId} of every verified twin in a state. */
export const mapOf = state => Object.fromEntries(Object.entries(state.characters ?? {}).filter(([, entry]) => entry.id && entry.verified === true).map(([key, entry]) => [key, entry.id]));

const readJson = async (path, fallback) => {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/u, '')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
};

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), runtime = resolve(root, 'runtime');
  const args = process.argv.slice(2);
  const opt = name => { const at = args.indexOf('--' + name); return at < 0 ? undefined : args[at + 1]; };
  const apply = args.includes('--apply') && !args.includes('--dry-run');
  if (!opt('pack')) throw Error('Usage: node scripts/Create-PackTwins.mjs --pack <folder> [--only key,key] [--limit N] [--dry-run | --apply]');
  const packDir = resolve(opt('pack'));
  const manifest = await readJson(resolve(packDir, 'convai-addon.json'));
  const packId = manifest.id;
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(packId ?? '')) throw Error('The pack has no usable id.');
  let characters = manifest.content?.characters;
  if (typeof characters === 'string') {
    if (/^(?:[A-Za-z]:|[\\/])|\.\./u.test(characters) || !characters.endsWith('.json')) throw Error('content.characters path must stay inside the pack folder.');
    characters = await readJson(resolve(packDir, characters));
  }
  if (Array.isArray(characters)) characters = Object.fromEntries(characters.map(item => [item.key, item]));
  if (!characters || typeof characters !== 'object') throw Error('The pack has no characters.');
  const ids = await readJson(resolve(runtime, 'characters.json'));
  const roster = [...await readJson(resolve(root, 'characters/roster.json')), ...await readJson(resolve(root, 'characters/archetype-roster.json'))];
  const only = opt('only') ? new Set(opt('only').split(',').map(item => item.trim()).filter(Boolean)) : null;
  const limit = opt('limit') === undefined ? Infinity : Number(opt('limit'));
  if (!(limit >= 1)) throw Error('--limit takes a number of at least 1.');
  if (only) for (const key of only) if (!Object.hasOwn(characters, key) || !ids[key]) throw Error('--only names a key the pack or the account does not have: ' + key);

  const target = resolve(runtime, `pack-twins-${packId}.json`), statePath = resolve(runtime, `pack-twins-${packId}.state.json`);
  const state = await readJson(statePath, {version: 1, characters: {}});
  const keys = Object.keys(characters).filter(key => ids[key] && (!only || only.has(key)));
  const skipped = Object.keys(characters).filter(key => !ids[key]);
  const problems = keys.flatMap(key => rowProblems(key, characters[key], packId).map(problem => `${key}: ${problem}`));
  if (problems.length) throw Error('Pack rows with problems:\n' + problems.join('\n'));
  // Keys still to do first (not verified), up to the limit; verified ones are re-verified only when --only names them.
  const pending = keys.filter(key => state.characters[key]?.verified !== true || only);
  const todo = pending.slice(0, limit);
  const rows = todo.map(key => {
    const profile = roster.find(item => item.key === key);
    return {key, originalId: ids[key], row: characters[key], aliases: [profile?.name, ...(profile?.aliases ?? [])].filter(Boolean)};
  });
  const keyText = (await readFile(process.env.CYBERPUNK_CONVAI_KEY_FILE || resolve(runtime, 'convai-key.txt'), 'utf8')).trim();
  const apiKey = /^api-key\s*=\s*(\S+)\s*$/iu.exec(keyText)?.[1];
  if (!apiKey) throw Error('Expected the project-local api-key file.');
  const wait = ms => new Promise(done => setTimeout(done, ms));
  let lastRequest = 0;
  const api = async (endpoint, body, {create = false} = {}) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await wait(Math.max(0, 1600 - (Date.now() - lastRequest))); lastRequest = Date.now();
      let response;
      try { response = await fetch('https://api.convai.com' + endpoint, {method: 'POST', headers: {'CONVAI-API-KEY': apiKey, 'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(45000)}); }
      catch { if (!create && attempt < 4) { await wait(2000 * (attempt + 1)); continue; } throw Error('Transport outcome is uncertain: ' + endpoint); }
      let value;
      try { value = await response.json(); if (typeof value === 'string') value = JSON.parse(value); }
      catch { throw Error(`Invalid receipt from ${endpoint} (HTTP ${response.status})`); }
      const rejection = ['ERROR', 'API_ERROR', 'INTERNAL_ERROR'].find(field => value?.[field]);
      const limited = response.status === 429 || /(?:rate limit|request limit|too many requests)/iu.test(String(rejection && value[rejection]));
      if (limited && attempt < 4) { await wait(30000 * (attempt + 1)); continue; }
      if (!response.ok || rejection) {
        if (!create && response.status >= 500 && attempt < 4) { await wait(3000 * (attempt + 1)); continue; }
        throw Error(`Rejected ${endpoint} (HTTP ${response.status}${rejection ? ': ' + String(value[rejection]).replaceAll(apiKey, '[key]').slice(0, 200) : ''})`);
      }
      return value;
    }
    throw Error('Retries exhausted: ' + endpoint);
  };

  if (!apply) {
    // Reads only: the account list, the originals of the rows, and every payload checked.
    const cloud = await api('/character/list', {});
    const listed = new Map((cloud.characters ?? []).map(item => [item.character_id, item]));
    const report = [];
    for (const item of rows) {
      const source = await api('/character/get', {charID: item.originalId});
      const model = listed.get(item.originalId)?.personalised_prompt_config?.MODEL;
      const payload = packTwinPayload({key: item.key, row: item.row, packId, source, model, aliases: item.aliases});
      report.push({key: item.key, name: payload.charName, voice: payload.voiceType, model, memory: source.memory_settings?.enabled === true,
        chars: payload.backstory.length + payload.speaking_style_description.length + payload.speaking_style_sample_dialogues.length});
    }
    console.log(JSON.stringify({mode: 'dry-run', writes: 'none', pack: packId, accountCharacters: listed.size, packCharacters: Object.keys(characters).length,
      withoutConvaiOriginal: skipped, selected: rows.length, alreadyVerified: keys.filter(key => state.characters[key]?.verified === true).length, payloads: report}, null, 2));
    return;
  }

  let lock;
  try { lock = await open(resolve(runtime, 'character-provision.lock'), 'wx'); }
  catch { throw Error('Another character provision may be running.'); }
  const atomic = async (path, value) => {
    const tmp = path + '.' + randomUUID() + '.tmp';
    try { await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'}); await rename(tmp, path); }
    finally { await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  };
  try {
    await lock.writeFile(String(process.pid));
    await mkdir(runtime, {recursive: true});
    const persist = async value => { await atomic(statePath, value); await atomic(target, mapOf(value)); };
    const result = await createPackTwins({packId, rows, state, api, persist, log: message => console.log(message)});
    await persist(result.state);
    console.log(JSON.stringify({pack: packId, created: result.results.filter(item => item.created).length, verified: result.results.length, failures: result.failures,
      stopped: result.stopped, modelMismatch: result.modelMismatch, mapped: Object.keys(mapOf(result.state)).length, map: target}, null, 2));
    if (result.failures.length || result.modelMismatch.length) process.exitCode = 1;
  } finally { await lock.close(); await unlink(resolve(runtime, 'character-provision.lock')).catch(() => {}); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
