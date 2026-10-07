// Creates a multilingual twin of every Convai character profile the mod has (the
// full roster in characters/roster.json with an ID in runtime/characters.json) and
// of each relationship variant (today the five romantic profiles, keyed
// "<key>-romantic").
//
// Only NEW characters are created. The original profile is read (list/get) and
// never written. The twin is a faithful clone: same biography (with its own
// ownership marker), speaking style, sample dialogues, model, memory and
// generation settings. Two things differ on purpose:
//   - name: "<name> Multilingual";
//   - voice: Convai rejects non-English language codes on an English-only Kokoro
//     voice ("Given voice incompatible with the language code"), so the twin
//     uses a gender-matched Azure multilingual voice.
// Languages stay en-US only. With the playground box "Only reply in the selected
// languages" unticked, a character replies in whatever language the player uses,
// so the languages need not be listed. That box is the dashboard field
// language_hardening_mode ("default" = ticked, "off" = unticked). The Core API
// /character/update IGNORES it (camelCase and snake_case tried, readback
// unchanged), /character/get does not return it, and the Core API key gets 401 on
// the web dashboard API. Only a signed-in browser session can set it, via
// POST https://convai.com/api/character/update
//   {character_id, workspace_id, language_hardening_mode: 'off'}.
// This script therefore never sets it. It lists, as needsLanguageBoxOff, every twin
// whose mapping entry is not marked languageBoxOff: true; whoever sets the box in
// the browser session then records languageBoxOff: true in the mapping.
//
// Default is a plan (no remote reads or writes). --apply performs the remote work.
// Re-runs never create duplicates: an existing mapping, or an existing twin found
// by its exact ownership marker, is adopted and re-verified.
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

// The five characters that also have a romantic profile (runtime/relationship-profiles.json,
// provider key "<key>-romantic", marker "[CyberpunkConvai profile v2:<key>-romantic]").
export const ROMANCE_BASE_KEYS = Object.freeze(['judy-alvarez', 'panam-palmer', 'river-ward', 'kerry-eurodyne', 'meredith-stout']);
export const romanceKey = baseKey => baseKey + '-romantic';

// English only: with the language box off the character answers in any language.
export const LANGUAGE_CODES = Object.freeze(['en-US']);
// Dashboard field behind "Only reply in the selected languages" ("off" = unticked).
// Web session only; see the header. Never sent by this script.
export const LANGUAGE_BOX_FIELD = 'language_hardening_mode';
// Voice values come from runtime/convai-voices.json ("Azure Voices", 71 languages).
export const MULTILINGUAL_VOICES = Object.freeze({
  FEMALE: 'AZURE-MULTILINGUAL-a0810a758f',   // Emma Female Multilingual Voice
  MALE: 'AZURE-MULTILINGUAL-3ea74315c9',     // Christopher Male Multilingual Voice
});

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

/** Twins whose language box is not recorded as unticked: [{key, id, name}]. */
export function needsLanguageBoxOff(mapping) {
  return Object.entries(mapping.characters ?? {})
    .filter(([, entry]) => entry.multilingualCharacterId && entry.languageBoxOff !== true)
    .map(([key, entry]) => ({key, id: entry.multilingualCharacterId, name: entry.name}));
}

/** Core flow, separated from I/O for tests.
 * rows: [{key, originalId, gender, baseKey?}] (baseKey set for romantic profiles). api(endpoint, body, {create}) returns parsed JSON. */
export async function createMultilingualProfiles({rows, mapping = {version: 1, characters: {}}, api, persist = async () => {}, log = () => {}, continueOnError = false}) {
  const next = clone(mapping);
  next.version = 1; next.characters ??= {};
  const cloud = await api('/character/list', {});
  if (!Array.isArray(cloud?.characters)) throw Error('Character listing is unavailable.');
  const listed = new Map(cloud.characters.map(row => [row.character_id, row]));
  const modelOf = id => listed.get(id)?.personalised_prompt_config?.MODEL;
  const results = [], failures = [];
  for (const {key, originalId, gender, baseKey} of rows) {
    try {
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
      // Apply the language list, copied settings and memory. Voice is
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
        languageBoxField: LANGUAGE_BOX_FIELD, languageBoxOff: entry.languageBoxOff === true,
        notCloned: notCloned(source, actual),
      });
      // Fields of the retired "reply any language" approach.
      for (const legacy of ['replyAnyLanguageApplied', 'replyAnyLanguageField', 'manualUntickRequired']) delete entry[legacy];
      if (baseKey) Object.assign(entry, {variant: 'romantic', baseKey});
      await persist(clone(next));
      results.push({key, id, created, languageBoxOff: entry.languageBoxOff, notCloned: entry.notCloned});
      log(`Verified ${payload.charName} (${id})`);
    } catch (error) {
      if (!continueOnError) throw error;
      failures.push({key, error: error.message});
      log(`FAILED ${key}: ${error.message}`);
    }
  }
  return {mapping: next, results, failures, needsLanguageBoxOff: needsLanguageBoxOff(next)};
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
  const relationships = await read(resolve(runtime, 'relationship-profiles.json'));
  const profiled = roster.map(row => row.key).filter(key => ids[key]);
  const known = [...profiled, ...ROMANCE_BASE_KEYS.map(romanceKey)];
  if (only && [...only].some(key => !known.includes(key))) throw Error('--only names a profile outside the profiled roster and the romance profiles.');
  // Gender of the twin voice: the original Kokoro voice's gender, else the roster's own gender field.
  const genderFallbacks = [];
  const rows = known.filter(key => !only || only.has(key)).map(key => {
    const baseKey = key.endsWith('-romantic') ? key.slice(0, -'-romantic'.length) : null;
    const profile = roster.find(row => row.key === (baseKey ?? key));
    let gender = genderOfVoice.get(profile?.voice);
    if (!gender && ['MALE', 'FEMALE'].includes(profile?.gender)) { gender = profile.gender; genderFallbacks.push(key); }
    const originalId = baseKey ? relationships.characters?.[baseKey]?.romanticCharacterId : ids[key];
    if (!originalId || !gender) throw Error('Missing Convai ID or voice gender: ' + key);
    return {key, originalId, gender, name: profile.name, ...(baseKey && {baseKey})};
  });
  const target = resolve(runtime, 'multilingual-profiles.json');
  const mapping = await read(target, {version: 1, characters: {}});
  if (!apply) {
    console.log(JSON.stringify({mode: 'dry-run', writes: 'none', total: rows.length,
      toCreate: rows.filter(row => !mapping.characters[row.key]?.multilingualCharacterId).length,
      alreadyMapped: rows.filter(row => mapping.characters[row.key]?.multilingualCharacterId).length,
      genderFromRosterFallback: genderFallbacks, languageCodes: LANGUAGE_CODES,
      languageBox: `${LANGUAGE_BOX_FIELD} is set through the web session only; see needsLanguageBoxOff after --apply`,
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
    const result = await createMultilingualProfiles({rows, mapping, api, persist: value => atomic(target, value), log: console.log, continueOnError: true});
    await atomic(target, result.mapping);
    console.log(JSON.stringify({results: result.results, failures: result.failures, needsLanguageBoxOff: result.needsLanguageBoxOff}, null, 2));
    if (result.failures.length) process.exitCode = 1;
  } finally { await lock.close(); await unlink(resolve(runtime, 'character-provision.lock')); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
