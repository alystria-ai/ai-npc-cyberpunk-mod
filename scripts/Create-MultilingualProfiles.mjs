// Creates a multilingual twin of each tier-1 Convai character profile.
//
// Only NEW characters are created. The original profile is read (list/get) and
// never written. The twin is a faithful clone: same biography (with its own
// ownership marker), speaking style, sample dialogues, model, memory and
// generation settings. Three things differ on purpose:
//   - name: "<name> Multilingual"
//   - voice: Convai rejects non-English language codes on an English-only Kokoro
//     voice ("Given voice incompatible with the language code"), so the twin
//     uses a gender-matched Azure multilingual voice;
//   - languageCodes: several languages instead of en-US only.
// The playground checkbox "Only reply in the selected languages" has no
// documented or readable API field (see docs/MULTILINGUAL_PROFILES.md). It is
// applied through REPLY_ANY_LANGUAGE_FIELD only when one has been verified;
// otherwise the mapping marks every twin as needing the box unticked by hand.
//
// Default is a plan (no remote reads or writes beyond nothing). --apply performs
// the remote work. Re-runs never create duplicates: an existing mapping, or an
// existing twin found by its exact ownership marker, is adopted and re-verified.
import {readFile, writeFile, rename, mkdir, open, unlink} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {apiCharacterName} from './character-payload.mjs';

// The 23 tier-1 characters with a Convai profile (the 24th tier-1 voice, Alt
// Cunningham, has no profile in this mod). Keys are runtime/characters.json keys.
export const TIER1_KEYS = Object.freeze([
  'alex', 'claire-russell', 'evelyn-parker', 'jackie-welles', 'johnny-silverhand', 'judy-alvarez',
  'kerry-eurodyne', 'lizzy-wizzy', 'mama-welles', 'meredith-stout', 'misty-olszewski', 'mr-hands',
  'padre-ibarra', 'panam-palmer', 'pepe-najarro', 'regina-jones', 'river-ward', 'rogue-amendiares',
  'solomon-reed', 'songbird', 'takemura', 'viktor-vektor', 'wakako-okada']);

// The ten languages the mod's interface supports. The API accepts more than the
// four the playground UI offers, and a twin listing them answered in German,
// French, Korean, Chinese and Portuguese in a live check (2026-10-07).
export const LANGUAGE_CODES = Object.freeze(['en-US', 'zh-CN', 'zh-TW', 'es-ES', 'pt-BR', 'fr-FR', 'de-DE', 'ru-RU', 'ja-JP', 'ko-KR']);
// Voice values come from runtime/convai-voices.json ("Azure Voices", 71 languages).
export const MULTILINGUAL_VOICES = Object.freeze({
  FEMALE: 'AZURE-MULTILINGUAL-a0810a758f',   // Emma Female Multilingual Voice
  MALE: 'AZURE-MULTILINGUAL-3ea74315c9',     // Christopher Male Multilingual Voice
});
// Set to {field: '<request field>', value: <false or true>} once a field is
// verified to untick "Only reply in the selected languages". Null = unknown.
export const REPLY_ANY_LANGUAGE_FIELD = null;

export const originalMarker = key => `[CyberpunkConvai profile v2:${key}]`;
export const twinMarker = key => `[CyberpunkConvai profile v2:${key}:multilingual]`;

const clone = value => structuredClone(value);

// Generation settings copied by update when the new character's default differs.
// Request names verified against /character/update on 2026-10-07.
const COPIED_SETTINGS = Object.freeze([
  ['state_of_mind_enabled', 'stateOfMindEnabled'],
  ['verbosity', 'verbosity'],
]);
// Returned fields compared for equality; any difference not copied above is
// listed under notCloned instead of being silently dropped.
const COMPARED_FIELDS = Object.freeze([
  'verbosity', 'moderation_enabled', 'allowed_moderation_filters', 'state_of_mind_enabled', 'personality_enabled',
  'multimodal_kb_enabled', 'temperature', 'curiosity_level', 'guardrail_meta', 'character_traits', 'boosted_words',
  'pronunciations', 'listing', 'model_type', 'custom_guardrails_enabled', 'guardrails_text', 'uncensored_access_consent',
  'nsfw_model_size', 'character_actions', 'character_emotions', 'is_narrative_driven', 'start_narrative_section_id',
  'custom_feature', 'custom_character_feature']);

export function twinPayload({key, source, model, gender}) {
  const marker = originalMarker(key);
  const lines = source.backstory.split(/\r?\n/u);
  if (lines.filter(line => line === marker).length !== 1) throw Error('Original ownership marker is missing or repeated: ' + key);
  const voice = MULTILINGUAL_VOICES[gender];
  if (!voice) throw Error('No multilingual voice for gender ' + gender + ': ' + key);
  if (typeof model !== 'string' || !model) throw Error('Original model is unknown: ' + key);
  return {
    charName: apiCharacterName({name: source.character_name + ' Multilingual'}),
    voiceType: voice,
    backstory: lines.map(line => line === marker ? twinMarker(key) : line).join(source.backstory.includes('\r\n') ? '\r\n' : '\n'),
    speaking_style_description: source.speaking_style?.description ?? '',
    speaking_style_sample_dialogues: source.speaking_style?.sample_dialogues ?? '',
    model_group_name: model,
  };
}

export function settingUpdates(source, actual) {
  const updates = {};
  for (const [returned, request] of COPIED_SETTINGS) {
    if (!isDeepStrictEqual(source[returned], actual[returned])) updates[request] = source[returned];
  }
  if (source.memory_settings?.enabled === true && actual.memory_settings?.enabled !== true) updates.memorySettings = {enabled: true};
  return updates;
}

export function languageUpdates(actual) {
  const updates = {};
  if (!isDeepStrictEqual(actual.language_codes, LANGUAGE_CODES)) updates.languageCodes = [...LANGUAGE_CODES];
  if (REPLY_ANY_LANGUAGE_FIELD) updates[REPLY_ANY_LANGUAGE_FIELD.field] = REPLY_ANY_LANGUAGE_FIELD.value;
  return updates;
}

export function notCloned(source, actual) {
  const copied = new Set(COPIED_SETTINGS.map(([returned]) => returned));
  return COMPARED_FIELDS.filter(field => !copied.has(field) && !isDeepStrictEqual(source[field], actual[field]));
}

export function verifyTwin({id, key, source, actual, payload, model}) {
  const problems = [];
  if (actual?.character_id !== id) problems.push('id');
  if (actual?.character_name !== payload.charName) problems.push('name');
  if (actual?.voice_type !== payload.voiceType) problems.push('voice');
  if (actual?.backstory !== payload.backstory) problems.push('backstory');
  if (actual?.speaking_style?.description !== payload.speaking_style_description) problems.push('speaking_style.description');
  if (actual?.speaking_style?.sample_dialogues !== payload.speaking_style_sample_dialogues) problems.push('speaking_style.sample_dialogues');
  if (!isDeepStrictEqual(actual?.language_codes, LANGUAGE_CODES)) problems.push('language_codes');
  if ((actual?.memory_settings?.enabled === true) !== (source.memory_settings?.enabled === true)) problems.push('memory_settings.enabled');
  for (const [returned] of COPIED_SETTINGS) if (!isDeepStrictEqual(source[returned], actual?.[returned])) problems.push(returned);
  if (model !== payload.model_group_name) problems.push('model');
  if (problems.length) throw Error(`Multilingual twin readback mismatch for ${key}: ${problems.join(', ')}`);
}

/** Core flow, separated from I/O for tests.
 * rows: [{key, originalId, gender}]. api(endpoint, body, {create}) returns parsed JSON. */
export async function createMultilingualProfiles({rows, mapping = {version: 1, characters: {}}, api, persist = async () => {}, log = () => {}}) {
  const next = clone(mapping);
  next.version = 1; next.characters ??= {};
  const cloud = await api('/character/list', {});
  if (!Array.isArray(cloud?.characters)) throw Error('Character listing is unavailable.');
  const listed = new Map(cloud.characters.map(row => [row.character_id, row]));
  const modelOf = id => listed.get(id)?.personalised_prompt_config?.MODEL;
  const results = [];
  for (const {key, originalId, gender} of rows) {
    const entry = next.characters[key] ??= {};
    const source = await api('/character/get', {charID: originalId});
    if (source?.character_id !== originalId || !listed.has(originalId)) throw Error('Original profile is not in this account: ' + key);
    const payload = twinPayload({key, source, model: modelOf(originalId), gender});
    let id = entry.multilingualCharacterId, found, created = false;
    if (id) {
      if (!listed.has(id)) throw Error('Mapped multilingual profile is not in the account: ' + key);
      found = await api('/character/get', {charID: id});
      if (!found?.backstory?.split(/\r?\n/u).includes(twinMarker(key))) throw Error('Multilingual ownership marker mismatch: ' + key);
    } else {
      // Recover a create whose receipt was lost: exact name and exact marker line.
      for (const candidate of cloud.characters.filter(row => row.character_id !== originalId && row.character_name === payload.charName)) {
        const detail = await api('/character/get', {charID: candidate.character_id});
        if (detail?.backstory?.split(/\r?\n/u).includes(twinMarker(key))) {
          if (id) throw Error('Several characters carry the multilingual marker: ' + key);
          id = candidate.character_id; found = detail;
        }
      }
      if (!id) {
        if (entry.phase === 'creating') throw Error('An earlier create of ' + key + ' has an unknown outcome and no matching character; inspect the account before retrying.');
        Object.assign(entry, {phase: 'creating', originalCharacterId: originalId, startedAt: new Date().toISOString()});
        await persist(clone(next));
        const result = await api('/character/create', payload, {create: true});
        if (typeof result?.charID !== 'string' || !result.charID) throw Error('Create returned no character ID: ' + key);
        id = result.charID; created = true;
        log(`Created ${payload.charName}`);
      }
    }
    Object.assign(entry, {phase: 'created', key, name: payload.charName, originalCharacterId: originalId, multilingualCharacterId: id});
    await persist(clone(next));
    let actual = found ?? await api('/character/get', {charID: id});
    // Apply voice-compatible language list, copied settings and memory. Voice is
    // part of create; it is re-sent here only if a re-run finds it different.
    const updates = {...settingUpdates(source, actual), ...languageUpdates(actual)};
    if (actual.voice_type !== payload.voiceType) updates.voiceType = payload.voiceType;
    if (actual.speaking_style?.description !== payload.speaking_style_description
        || actual.speaking_style?.sample_dialogues !== payload.speaking_style_sample_dialogues) {
      updates.speaking_style_description = payload.speaking_style_description;
      updates.speaking_style_sample_dialogues = payload.speaking_style_sample_dialogues;
    }
    if (actual.backstory !== payload.backstory) updates.backstory = payload.backstory;
    if (Object.keys(updates).length) {
      const response = await api('/character/update', {charID: id, ...updates});
      if (response?.STATUS !== 'SUCCESS') throw Error('Update was not confirmed: ' + key);
      actual = await api('/character/get', {charID: id});
    }
    const final = await api('/character/list', {});
    const model = final.characters?.find(row => row.character_id === id)?.personalised_prompt_config?.MODEL;
    verifyTwin({id, key, source, actual, payload, model});
    Object.assign(entry, {
      phase: 'verified', verified: true, verifiedAt: new Date().toISOString(), voiceType: payload.voiceType,
      languageCodes: [...actual.language_codes], model,
      replyAnyLanguageApplied: Boolean(REPLY_ANY_LANGUAGE_FIELD),
      replyAnyLanguageField: REPLY_ANY_LANGUAGE_FIELD?.field ?? null,
      manualUntickRequired: !REPLY_ANY_LANGUAGE_FIELD,
      notCloned: notCloned(source, actual),
    });
    await persist(clone(next));
    results.push({key, id, created, manualUntickRequired: entry.manualUntickRequired, notCloned: entry.notCloned});
    log(`Verified ${payload.charName} (${id})`);
  }
  return {mapping: next, results};
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), runtime = resolve(root, 'runtime');
  const args = process.argv.slice(2), apply = args.includes('--apply') && !args.includes('--dry-run');
  const onlyAt = args.indexOf('--only');
  const only = onlyAt < 0 ? null : new Set(args[onlyAt + 1].split(','));
  const read = async (path, fallback) => {
    try { return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/u, '')); }
    catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
  };
  const ids = await read(resolve(runtime, 'characters.json'));
  const roster = await read(resolve(root, 'characters/roster.json'));
  const kokoro = await read(resolve(root, 'characters/kokoro-voices.json'));
  const genderOfVoice = new Map(kokoro.voices.map(voice => [voice.voice_value, voice.gender]));
  const keys = TIER1_KEYS.filter(key => !only || only.has(key));
  if (only && keys.length !== only.size) throw Error('--only names a character outside tier 1.');
  const rows = keys.map(key => {
    const profile = roster.find(row => row.key === key);
    const gender = genderOfVoice.get(profile?.voice);
    if (!ids[key] || !gender) throw Error('Missing Convai ID or voice gender: ' + key);
    return {key, originalId: ids[key], gender, name: profile.name};
  });
  const target = resolve(runtime, 'multilingual-profiles.json');
  const mapping = await read(target, {version: 1, characters: {}});
  if (!apply) {
    console.log(JSON.stringify({mode: 'dry-run', writes: 'none', languageCodes: LANGUAGE_CODES,
      replySetting: REPLY_ANY_LANGUAGE_FIELD ?? 'no verified API field; box must be unticked by hand',
      profiles: rows.map(row => ({key: row.key, original: row.originalId, twinName: apiCharacterName({name: row.name + ' Multilingual'}),
        voice: MULTILINGUAL_VOICES[row.gender], alreadyMapped: Boolean(mapping.characters[row.key]?.multilingualCharacterId)}))}, null, 2));
    return;
  }
  const keyText = (await readFile(process.env.CYBERPUNK_CONVAI_KEY_FILE || resolve(runtime, 'convai-key.txt'), 'utf8')).trim();
  const key = /^api-key\s*=\s*(\S+)\s*$/iu.exec(keyText)?.[1];
  if (!key) throw Error('Expected the project-local api-key file.');
  let lock;
  try { lock = await open(resolve(runtime, 'character-provision.lock'), 'wx'); }
  catch { throw Error('Another character provision may be running.'); }
  const atomic = async (path, value) => {
    const tmp = path + '.' + randomUUID() + '.tmp';
    try { await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'}); await rename(tmp, path); }
    finally { await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  };
  let lastRequest = 0;
  const wait = ms => new Promise(done => setTimeout(done, ms));
  const api = async (endpoint, body, {create = false} = {}) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await wait(Math.max(0, 1600 - (Date.now() - lastRequest))); lastRequest = Date.now();
      let response;
      try { response = await fetch('https://api.convai.com' + endpoint, {method: 'POST',
        headers: {'CONVAI-API-KEY': key, 'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(45000)}); }
      catch { if (!create && attempt < 4) { await wait(2000); continue; } throw Error('Transport outcome is uncertain: ' + endpoint); }
      let value;
      try { value = await response.json(); if (typeof value === 'string') value = JSON.parse(value); }
      catch { throw Error('Invalid receipt from ' + endpoint); }
      const rejection = ['ERROR', 'API_ERROR', 'INTERNAL_ERROR'].find(field => value?.[field]);
      const limited = response.status === 429 || /(?:rate limit|request limit|too many requests)/iu.test(String(rejection && value[rejection]));
      if (limited && attempt < 4) { await wait(30000); continue; }
      if (!response.ok || rejection) {
        if (!create && response.status >= 500 && attempt < 4) continue;
        throw Error(`Rejected ${endpoint} (HTTP ${response.status}${rejection ? ': ' + String(value[rejection]).slice(0, 160) : ''})`);
      }
      return value;
    }
    throw Error('Retries exhausted: ' + endpoint);
  };
  try {
    await lock.writeFile(String(process.pid));
    await mkdir(runtime, {recursive: true});
    const result = await createMultilingualProfiles({rows, mapping, api, persist: value => atomic(target, value), log: console.log});
    await atomic(target, result.mapping);
    console.log(JSON.stringify(result.results, null, 2));
  } finally { await lock.close(); await unlink(resolve(runtime, 'character-provision.lock')); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
