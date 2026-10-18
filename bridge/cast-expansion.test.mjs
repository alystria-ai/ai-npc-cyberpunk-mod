// The 2026-10-18 cast expansion (docs/CAST_EXPANSION_RECIPE.md): every character of the batch has each piece the recipe
// adds. The live voice configs and the Convai IDs are checked where their files exist (runtime/ is not in git; release
// data is).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';

const url = path => new URL('../' + path, import.meta.url);
const read = path => readFileSync(url(path), 'utf8').replace(/^﻿/u, '');
const json = path => JSON.parse(read(path));

// Keys added by the batch, in roster order.
export const CAST_EXPANSION_KEYS = Object.freeze([
  'bryce-mosley', 'dum-dum', 'royce', 'rosalind-myers', 'kurt-hansen', 'woodman', 'fingers', 'garry-the-prophet',
  'brendan', 'anthony-gilchrist', 'denny', 'henry', 'teddy', 'weyland', 'oda', 'chester-bennett', 'bree-whitney',
  'edgar-tool', 'jacob-long', 'angelica-whelan', 'voodoo-queen', 'anders-hellman', 'joshua-stephenson',
  'maiko-maeda', 'wilky-laguerre', 'aurore-cassel', 'dante-caruso', 'jago-szabo'
]);
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
    assert.equal(voiceMap.voices[voiceMap.assignments[key]?.voice]?.gender, row.gender, key + ' twin voice gender');
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

const live = ['local-voices.autobest-short.json', 'local-voices.autobest-long.json', 'pocket-voices.autobest.json'];
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
