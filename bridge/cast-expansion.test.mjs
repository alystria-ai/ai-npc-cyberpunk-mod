// The 2026-10-18 cast expansion (docs/CAST_EXPANSION_RECIPE.md): every character of the batch has each piece the recipe
// adds. The live voice configs and the Convai IDs are checked where their files exist (runtime/ is not in git; release
// data is).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {CAST_EXPANSION_KEYS, CAST_EXPANSION_3_KEYS} from './cast-expansion-keys.mjs';

const url = path => new URL('../' + path, import.meta.url);
const read = path => readFileSync(url(path), 'utf8').replace(/^﻿/u, '');
const json = path => JSON.parse(read(path));

const live = ['local-voices.autobest-short.json', 'local-voices.autobest-long.json', 'pocket-voices.autobest.json'];

// Keys whose Convai character and twin exist (packaging/release-data); the rest are profile-only until provisioning.
const PROVISIONED = new Set(Object.keys(json('packaging/release-data/characters.json')));

test('every batch character has a roster row, dossier, first-person profile, appearance entry and twin voice', () => {
  const roster = json('characters/roster.json'), store = json('characters/first-person-profiles.json').characters;
  const appearance = json('characters/appearance.json'), voiceMap = json('characters/multilingual-voice-map.json');
  const plan = json('research/cyberpunk/generated/profile-plan.json');
  for (const key of CAST_EXPANSION_KEYS) {
    const row = roster.find(item => item.key === key);
    assert.ok(row, key + ' roster row');
    assert.match(row.backstory, /^I(?:'|’)m\b/u, key + ' first person');
    assert.ok(row.backstory.endsWith(`[CyberpunkConvai profile v2:${key}]`), key + ' ownership marker');
    assert.ok(Array.isArray(row.records) && row.records.length > 0 && row.records.every(r => /^Character\./u.test(r)), key + ' records');
    assert.ok(row.uncertainty.length > 0, key + ' uncertainties (story flags) present');
    assert.equal(json(`research/cyberpunk/dossiers/${key}.json`).key, key, key + ' dossier');
    assert.ok(read(`characters/profile-text/${key}.txt`).startsWith('BACKSTORY'), key + ' profile text');
    assert.ok(store[key]?.backstory?.text, key + ' first-person store');
    assert.ok(appearance[key], key + ' appearance entry');
    assert.equal(voiceMap.voices[voiceMap.assignments[key]?.voice]?.gender, voiceMap.assignments[key].voiceGender ?? row.gender, key + ' twin voice gender');
    assert.deepEqual(plan.find(item => item.key === key), row, key + ' profile plan matches the roster');
  }
});

test('every batch character is a knowledge audience and a prepared local voice', () => {
  const profileKeys = json('characters/world-knowledge.json').profileKeys;
  const generated = json('research/cyberpunk/generated/world-knowledge.json').profileKeys;
  const plan = json('packaging/release-plan.json');
  for (const key of CAST_EXPANSION_KEYS) {
    assert.ok(profileKeys.includes(key) && generated.includes(key), key + ' world-knowledge audience');
    assert.ok(plan.voice.localProfiles.includes(key), key + ' release voice list');
  }
});

test('the live voice configs hold a ready reference for every batch character', {skip: !live.every(name => existsSync(url('runtime/' + name))) && 'runtime configs absent'}, () => {
  for (const name of live) {
    const voices = json('runtime/' + name).voices;
    for (const key of CAST_EXPANSION_KEYS) {
      assert.equal(voices[key]?.status, 'ready', `${name}: ${key}`);
      assert.match(voices[key].reference, new RegExp(`picked/autobest/(omni-short|omni-long|pocket)/${key}\\.wav$`, 'u'), `${name}: ${key}`);
    }
  }
});

test('provisioned batch characters have an original and a twin in the release data', () => {
  const twins = json('packaging/release-data/multilingual-profiles.json').characters;
  for (const key of CAST_EXPANSION_KEYS.filter(k => PROVISIONED.has(k))) {
    const original = json('packaging/release-data/characters.json')[key];
    assert.match(original, /^[0-9a-f-]{36}$/u, key);
    assert.match(twins[key]?.multilingualCharacterId ?? '', /^[0-9a-f-]{36}$/u, key + ' twin');
    assert.equal(twins[key].originalCharacterId, original, key + ' twin points at the original');
  }
});

// The third batch (2026-10-23): everything except the game voices and the twins' language boxes.
test('the third batch has its text pieces, audience, Convai original and twin; voices and language boxes are still owed', () => {
  const roster = json('characters/roster.json'), store = json('characters/first-person-profiles.json').characters;
  const appearance = json('characters/appearance.json'), voiceMap = json('characters/multilingual-voice-map.json');
  const plan = json('research/cyberpunk/generated/profile-plan.json');
  const profileKeys = json('characters/world-knowledge.json').profileKeys;
  const originals = json('packaging/release-data/characters.json'), twins = json('packaging/release-data/multilingual-profiles.json').characters;
  for (const key of CAST_EXPANSION_3_KEYS) {
    const row = roster.find(item => item.key === key);
    assert.ok(row, key + ' roster row');
    assert.match(row.backstory, /^I(?:'|’)m\b/u, key + ' first person');
    assert.ok(row.backstory.endsWith(`[CyberpunkConvai profile v2:${key}]`), key + ' ownership marker');
    assert.ok(row.records.length > 0 && row.records.every(r => /^Character\./u.test(r)), key + ' records');
    assert.ok(row.uncertainty.length > 0, key + ' uncertainties present');
    assert.equal(json(`research/cyberpunk/dossiers/${key}.json`).key, key, key + ' dossier');
    assert.ok(read(`characters/profile-text/${key}.txt`).startsWith('BACKSTORY'), key + ' profile text');
    assert.ok(store[key]?.backstory?.text, key + ' first-person store');
    assert.ok(appearance[key], key + ' appearance entry');
    assert.equal(voiceMap.voices[voiceMap.assignments[key]?.voice]?.gender, row.gender, key + ' twin voice gender');
    assert.deepEqual(plan.find(item => item.key === key), row, key + ' profile plan matches the roster');
    assert.ok(profileKeys.includes(key), key + ' world-knowledge audience');
    assert.match(originals[key] ?? '', /^[0-9a-f-]{36}$/u, key + ' original');
    assert.equal(twins[key]?.originalCharacterId, originals[key], key + ' twin points at the original');
  }
});

test('Mr. Blue Eyes keeps heavy limits: no mapped knowledge, no plot in the row', () => {
  const dossier = json('research/cyberpunk/dossiers/mr-blue-eyes.json');
  assert.deepEqual(dossier.knowledge.conditional, [], 'no conditional knowledge');
  assert.deepEqual(dossier.relationships, [], 'no relationships');
  const text = read('characters/profile-text/mr-blue-eyes.txt');
  for (const spoiler of [/Crystal Palace/iu, /Mikoshi/iu, /Songbird/iu, /Relic/iu, /Peralez/iu, /Path of Glory/iu, /Arasaka/iu])
    assert.doesNotMatch(text, spoiler, 'profile text must not carry ' + spoiler);
});

test('the third batch voices are owed', {todo: 'game voice clips and the GPU reference steps (docs/CAST_EXPANSION_RECIPE.md); then move the keys into CAST_EXPANSION_KEYS'}, () => {
  const voices = json('runtime/local-voices.autobest-long.json').voices;
  for (const key of CAST_EXPANSION_3_KEYS) assert.equal(voices[key]?.status, 'ready', key);
});
