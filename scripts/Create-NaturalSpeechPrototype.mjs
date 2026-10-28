// Creates ONE prototype "Natural speech" clone of a character's ordinary Convai profile, for measuring a
// character-level approach against the per-turn dynamic block (docs/NATURAL_SPEECH_CLONES.md). Phase 1 only:
// nothing in the bridge routes to it; scripts/Probe-NaturalSpeech.mjs --natural-clone talks to it directly.
//
// The clone is the original with these differences, all from characters/natural-speech/<key>.json:
//   - name "<name> Natural speech prototype";
//   - ownership marker "[CyberpunkConvai profile v2:<key>:natural-prototype]" in place of the original's marker;
//   - optional backstoryInsert {before, text}: one paragraph on how the character talks, inserted before the line
//     `before`; every other backstory line stays the original's (checked);
//   - the speaking style description gets styleReplace and the sample dialogues are the rewritten ones (same lines, a
//     share of them with a vocal device). Each rewritten sample must equal an original sample once the devices are
//     removed, so the content cannot drift.
// Same voice (the original Kokoro voice), model, memory, state of mind and verbosity; any other compared field that
// differs is listed under notCloned. The original is only read (list/get), never written.
//
//   node scripts/Create-NaturalSpeechPrototype.mjs [--key judy-alvarez]           plan only, no remote calls
//   node scripts/Create-NaturalSpeechPrototype.mjs [--key judy-alvarez] --apply   create (or adopt) and verify
//
// Mapping: runtime/natural-speech-profiles.json (ignored by Git, no secrets). A re-run adopts the mapped clone, or one
// found by exact name plus exact marker, and re-verifies it. The API key is read from runtime/convai-key.txt and never
// printed. Deleting the clone is left to the user (the doc gives the command).
import {readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {apiCharacterName} from './character-payload.mjs';
import {assertPlainSampleDialogues} from './character-samples.mjs';
import {originalMarker, settingUpdates, notCloned} from './Create-MultilingualProfiles.mjs';
import {devicesUsed} from '../bridge/natural-speech.mjs';

export const prototypeMarker = key => `[CyberpunkConvai profile v2:${key}:natural-prototype]`;
export const PROTOTYPE_SUFFIX = ' Natural speech prototype';

// A sample with its vocal devices removed, for comparing content with the original line.
export const withoutDevices = text => text
  .replace(/\[[a-z]+(?:-[a-z]+)*\]/giu, ' ')
  .replace(/(^|[\s.,;:!?—-])(?:uh|um|hm+|i mean|well)(?=$|[\s.,;:!?—…-])/giu, '$1 ')
  .toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function prototypePayload({key, source, model, spec}) {
  const marker = originalMarker(key);
  const lines = source.backstory.split(/\r?\n/u);
  if (lines.filter(line => line === marker).length !== 1) throw Error('Original ownership marker is missing or repeated: ' + key);
  if (typeof model !== 'string' || !model) throw Error('Original model is unknown: ' + key);
  const description = source.speaking_style?.description ?? '';
  const {from, to} = spec.styleReplace ?? {};
  if (!from || !to || description.split(from).length !== 2) throw Error('styleReplace.from must occur exactly once in the original style: ' + key);
  const originals = (source.speaking_style?.sample_dialogues ?? '').split(/\n\s*\n/u).map(line => line.trim()).filter(Boolean);
  const plain = new Set(originals.map(withoutDevices));
  for (const sample of spec.samples) if (!plain.has(withoutDevices(sample))) throw Error('A rewritten sample changes the content of the original lines: ' + sample);
  const samples = spec.samples.join('\n\n');
  assertPlainSampleDialogues(samples, {key, name: source.character_name});
  const eol = source.backstory.includes('\r\n') ? '\r\n' : '\n';
  const swapped = lines.map(line => line === marker ? prototypeMarker(key) : line);
  let backstory = swapped.join(eol);
  if (spec.backstoryInsert) {
    const {before, text} = spec.backstoryInsert;
    if (!before || !text?.trim() || swapped.filter(line => line === before).length !== 1) throw Error('backstoryInsert.before must be exactly one backstory line: ' + key);
    const at = swapped.indexOf(before);
    const added = [...text.trim().split(/\r?\n/u), ''];
    backstory = [...swapped.slice(0, at), ...added, ...swapped.slice(at)].join(eol);
    // The story stays the original's: removing the inserted paragraph gives it back exactly.
    const back = backstory.split(eol);
    back.splice(at, added.length);
    if (back.join(eol) !== swapped.join(eol)) throw Error('backstoryInsert changed other backstory content: ' + key);
  }
  return {
    charName: apiCharacterName({name: source.character_name.trim() + PROTOTYPE_SUFFIX}),
    voiceType: source.voice_type,
    backstory,
    speaking_style_description: description.replace(from, to),
    speaking_style_sample_dialogues: samples,
    model_group_name: model,
  };
}

export function verifyPrototype({id, source, actual, payload, model}) {
  const problems = [];
  if (actual?.character_id !== id) problems.push('id');
  if (actual?.character_name !== payload.charName) problems.push('name');
  if (actual?.voice_type !== payload.voiceType) problems.push('voice');
  if (actual?.backstory !== payload.backstory) problems.push('backstory');
  if (actual?.speaking_style?.description !== payload.speaking_style_description) problems.push('speaking_style.description');
  if (actual?.speaking_style?.sample_dialogues !== payload.speaking_style_sample_dialogues) problems.push('speaking_style.sample_dialogues');
  if ((actual?.memory_settings?.enabled === true) !== (source.memory_settings?.enabled === true)) problems.push('memory_settings.enabled');
  for (const field of ['state_of_mind_enabled', 'verbosity']) if (actual?.[field] !== source[field]) problems.push(field);
  if (JSON.stringify(actual?.language_codes) !== JSON.stringify(source.language_codes)) problems.push('language_codes');
  if (model !== payload.model_group_name) problems.push('model');
  if (problems.length) throw Error('Prototype readback mismatch: ' + problems.join(', '));
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), runtime = resolve(root, 'runtime');
  const args = process.argv.slice(2), apply = args.includes('--apply');
  const keyAt = args.indexOf('--key'), key = keyAt < 0 ? 'judy-alvarez' : args[keyAt + 1];
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(key ?? '')) throw Error('Bad --key.');
  const read = async (path, fallback) => {
    try { return JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/u, '')); }
    catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
  };
  const ids = await read(resolve(runtime, 'characters.json'));
  const spec = await read(resolve(root, 'characters/natural-speech', key + '.json'));
  const originalId = ids[key];
  if (!originalId || spec.key !== key || !Array.isArray(spec.samples) || !spec.samples.length) throw Error('No profile or prototype spec for ' + key);
  const target = resolve(runtime, 'natural-speech-profiles.json');
  const mapping = await read(target, {version: 1, characters: {}});
  const entry = mapping.characters[key] ??= {};
  if (!apply) {
    console.log(JSON.stringify({mode: 'plan', writes: 'none', key, originalId, mapped: entry.prototypeCharacterId ?? null,
      samples: spec.samples.length, withDevice: spec.samples.filter(line => devicesUsed(line).length).length,
      kinds: [...new Set(spec.samples.flatMap(devicesUsed))], specVersion: spec.version}, null, 2));
    return;
  }
  const keyText = (await readFile(resolve(runtime, 'convai-key.txt'), 'utf8')).trim();
  const apiKey = /^api-key\s*=\s*(\S+)\s*$/iu.exec(keyText)?.[1];
  if (!apiKey) throw Error('Expected the project-local api-key file.');
  const atomic = async value => {
    const tmp = target + '.' + randomUUID() + '.tmp';
    try { await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'}); await rename(tmp, target); }
    finally { await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  };
  let requests = 0;
  const api = async (endpoint, body) => {
    requests++;
    const response = await fetch('https://api.convai.com' + endpoint, {method: 'POST',
      headers: {'CONVAI-API-KEY': apiKey, 'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(45000)});
    let value = await response.json();
    if (typeof value === 'string') value = JSON.parse(value);
    const rejection = ['ERROR', 'API_ERROR', 'INTERNAL_ERROR'].find(field => value?.[field]);
    if (!response.ok || rejection) throw Error(`Rejected ${endpoint} (HTTP ${response.status}${rejection ? ': ' + String(value[rejection]).slice(0, 160) : ''})`);
    return value;
  };
  const listed = await api('/character/list', {});
  const modelOf = id => listed.characters?.find(row => row.character_id === id)?.personalised_prompt_config?.MODEL;
  const source = await api('/character/get', {charID: originalId});
  if (source?.character_id !== originalId) throw Error('Original profile is not in this account: ' + key);
  const payload = prototypePayload({key, source, model: modelOf(originalId), spec});
  let id = entry.prototypeCharacterId, actual, created = false;
  if (id) {
    actual = await api('/character/get', {charID: id});
    if (!actual?.backstory?.split(/\r?\n/u).includes(prototypeMarker(key))) throw Error('Prototype ownership marker mismatch: ' + key);
  } else {
    for (const row of listed.characters.filter(row => row.character_name === payload.charName)) {
      const detail = await api('/character/get', {charID: row.character_id});
      if (detail?.backstory?.split(/\r?\n/u).includes(prototypeMarker(key))) { if (id) throw Error('Two prototypes carry the marker.'); id = row.character_id; actual = detail; }
    }
    if (!id) {
      if (entry.phase === 'creating') throw Error('An earlier create has an unknown outcome; inspect the account before retrying.');
      Object.assign(entry, {phase: 'creating', key, originalCharacterId: originalId, startedAt: new Date().toISOString()});
      await atomic(mapping);
      const result = await api('/character/create', payload);
      if (typeof result?.charID !== 'string' || !result.charID) throw Error('Create returned no character ID.');
      id = result.charID; created = true;
      Object.assign(entry, {phase: 'created', prototypeCharacterId: id, name: payload.charName});
      await atomic(mapping);
      actual = await api('/character/get', {charID: id});
    }
  }
  const updates = {...settingUpdates(source, actual)};
  if (JSON.stringify(actual.language_codes) !== JSON.stringify(source.language_codes)) updates.languageCodes = source.language_codes;
  if (actual.voice_type !== payload.voiceType) updates.voiceType = payload.voiceType;
  if (actual.backstory !== payload.backstory) updates.backstory = payload.backstory;
  if (actual.speaking_style?.description !== payload.speaking_style_description
      || actual.speaking_style?.sample_dialogues !== payload.speaking_style_sample_dialogues) {
    updates.speaking_style_description = payload.speaking_style_description;
    updates.speaking_style_sample_dialogues = payload.speaking_style_sample_dialogues;
  }
  if (Object.keys(updates).length) {
    const response = await api('/character/update', {charID: id, ...updates});
    if (response?.STATUS !== 'SUCCESS') throw Error('Update was not confirmed.');
    actual = await api('/character/get', {charID: id});
  }
  const final = await api('/character/list', {});
  const model = final.characters?.find(row => row.character_id === id)?.personalised_prompt_config?.MODEL;
  verifyPrototype({id, source, actual, payload, model});
  Object.assign(entry, {phase: 'verified', verified: true, verifiedAt: new Date().toISOString(), key, name: payload.charName,
    originalCharacterId: originalId, prototypeCharacterId: id, voiceType: payload.voiceType, model, specVersion: spec.version, notCloned: notCloned(source, actual)});
  await atomic(mapping);
  console.log(JSON.stringify({key, id, name: payload.charName, created, updated: Object.keys(updates), notCloned: entry.notCloned, convaiRequests: requests}, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
