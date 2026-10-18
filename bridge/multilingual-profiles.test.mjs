import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createMultilingualProfiles, applyTwinVoices, buildRows, ROSTER_CHOICES, settingUpdates, voiceFor, withoutCostEstimates, twinPayload, twinMarker, originalMarker, needsLanguageBoxOff, languageCodesFor, LANGUAGE_TAGS, LANGUAGE_CODES, LANGUAGE_BOX_FIELD, MULTILINGUAL_VOICES, TIER1_KEYS} from '../scripts/Create-MultilingualProfiles.mjs';

function fixture(keys = ['judy-alvarez', 'jackie-welles']) {
  const objects = new Map(), calls = [];
  const original = key => ({character_id: 'orig-' + key, character_name: key.toUpperCase(),
    voice_type: 'convai-kokoro-x', language_codes: ['en-US'], state_of_mind_enabled: true, verbosity: 2,
    backstory: `Bio line.\n${originalMarker(key)}`, speaking_style: {description: 'Style.', sample_dialogues: 'Sample.'},
    memory_settings: {enabled: true}, personalised_prompt_config: {MODEL: 'test-model'}});
  for (const key of keys) objects.set('orig-' + key, original(key));
  let serial = 0, lose;
  const api = async (endpoint, body) => {
    calls.push({endpoint, body: structuredClone(body)});
    if (endpoint === '/character/list') return {characters: [...objects.values()].map(value => structuredClone(value))};
    if (endpoint === '/character/get') return structuredClone(objects.get(body.charID));
    if (endpoint === '/character/create') {
      const id = 'twin-' + (++serial);
      objects.set(id, {character_id: id, character_name: body.charName, voice_type: body.voiceType, language_codes: ['en-US'],
        state_of_mind_enabled: true, verbosity: 2, backstory: body.backstory,
        speaking_style: {description: body.speaking_style_description, sample_dialogues: body.speaking_style_sample_dialogues},
        memory_settings: {enabled: false}, personalised_prompt_config: {MODEL: body.model_group_name}});
      if (lose) { lose = false; throw Error('lost receipt'); }
      return {charID: id};
    }
    if (endpoint === '/character/update') {
      const target = objects.get(body.charID);
      assert.ok(target.character_id.startsWith('twin-'), 'originals are never updated');
      assert.ok(!(LANGUAGE_BOX_FIELD in body) && !('languageHardeningMode' in body), 'the language box is web-session only');
      if (body.languageCodes) target.language_codes = body.languageCodes;
      if (body.memorySettings) target.memory_settings = {...target.memory_settings, ...body.memorySettings};
      if (body.voiceType) target.voice_type = body.voiceType;
      return {STATUS: 'SUCCESS'};
    }
    throw Error('unexpected ' + endpoint);
  };
  const rows = keys.map(key => ({key, originalId: 'orig-' + key, gender: key === 'jackie-welles' ? 'MALE' : 'FEMALE'}));
  return {api, calls, rows, objects, loseNext: () => { lose = true; }};
}

test('tier-1 roster has 26 unique profile keys', () => {
  assert.equal(TIER1_KEYS.length, 26);
  assert.equal(new Set(TIER1_KEYS).size, 26);
});

test('twin payload keeps the biography, swaps only the marker, and picks a gender-matched multilingual voice', () => {
  const source = {character_name: 'Judy Alvarez', backstory: `Bio\n${originalMarker('judy-alvarez')}\nMore`,
    speaking_style: {description: 'D', sample_dialogues: 'S'}};
  const payload = twinPayload({key: 'judy-alvarez', source, model: 'm', gender: 'FEMALE'});
  assert.equal(payload.charName, 'Judy Alvarez Multilingual');
  assert.equal(payload.backstory, `Bio\n${twinMarker('judy-alvarez')}\nMore`);
  assert.equal(payload.voiceType, MULTILINGUAL_VOICES.FEMALE);
  assert.equal(payload.model_group_name, 'm');
  assert.throws(() => twinPayload({key: 'judy-alvarez', source: {...source, backstory: 'No marker'}, model: 'm', gender: 'FEMALE'}), /marker/);
});

test('creates twins once, never writes originals, and a re-run creates nothing', async () => {
  const f = fixture();
  let saved;
  const first = await createMultilingualProfiles({rows: f.rows, api: f.api, persist: value => { saved = value; }});
  assert.equal(f.calls.filter(call => call.endpoint === '/character/create').length, 2);
  assert.equal(f.calls.filter(call => call.endpoint === '/character/update' && call.body.charID.startsWith('orig-')).length, 0);
  assert.ok(first.results.every(row => row.created && row.languageBoxOff === false));
  assert.deepEqual(first.needsLanguageBoxOff.map(row => row.key), ['judy-alvarez', 'jackie-welles']);
  assert.equal(f.calls.filter(call => call.endpoint === '/character/update' && 'languageCodes' in call.body).length, 0, 'en-US is already the default');
  const entry = first.mapping.characters['judy-alvarez'];
  assert.equal(entry.originalCharacterId, 'orig-judy-alvarez');
  assert.equal(entry.verified, true);
  assert.deepEqual(entry.languageCodes, ['en-US']);
  assert.deepEqual([...LANGUAGE_CODES], ['en-US']);
  assert.equal(f.objects.get(entry.multilingualCharacterId).memory_settings.enabled, true);
  const createsBefore = f.calls.length;
  const second = await createMultilingualProfiles({rows: f.rows, mapping: saved, api: f.api});
  assert.equal(f.calls.slice(createsBefore).filter(call => call.endpoint === '/character/create').length, 0);
  assert.ok(second.results.every(row => !row.created));
});

test('a lost create receipt is recovered by exact name and marker instead of duplicating', async () => {
  const f = fixture(['judy-alvarez']);
  f.loseNext();
  await assert.rejects(() => createMultilingualProfiles({rows: f.rows, api: f.api}), /lost receipt/);
  const result = await createMultilingualProfiles({rows: f.rows, api: f.api});
  assert.equal(f.calls.filter(call => call.endpoint === '/character/create').length, 1);
  assert.equal(result.results[0].created, false);
  assert.equal(result.mapping.characters['judy-alvarez'].verified, true);
});

test('an interrupted create with no matching character is not blindly repeated', async () => {
  const f = fixture(['judy-alvarez']);
  const mapping = {version: 1, characters: {'judy-alvarez': {phase: 'creating'}}};
  await assert.rejects(() => createMultilingualProfiles({rows: f.rows, mapping, api: f.api}), /unknown outcome/);
  assert.equal(f.calls.filter(call => call.endpoint === '/character/create').length, 0);
});

test('a mapping marked languageBoxOff stays marked and leaves nothing to do; legacy fields are dropped', async () => {
  const f = fixture(['judy-alvarez']);
  const first = await createMultilingualProfiles({rows: f.rows, api: f.api});
  const mapping = structuredClone(first.mapping);
  Object.assign(mapping.characters['judy-alvarez'], {languageBoxOff: true, manualUntickRequired: true, replyAnyLanguageApplied: false});
  const second = await createMultilingualProfiles({rows: f.rows, mapping, api: f.api});
  const entry = second.mapping.characters['judy-alvarez'];
  assert.equal(entry.languageBoxOff, true);
  assert.equal('manualUntickRequired' in entry || 'replyAnyLanguageApplied' in entry, false);
  assert.deepEqual(second.needsLanguageBoxOff, []);
  assert.deepEqual(needsLanguageBoxOff({characters: {a: {multilingualCharacterId: 'x', name: 'A'}, b: {}}}), [{key: 'a', id: 'x', name: 'A'}]);
});

test('a twin whose language list drifted is put back to en-US only', async () => {
  const f = fixture(['judy-alvarez']);
  const first = await createMultilingualProfiles({rows: f.rows, api: f.api});
  f.objects.get(first.mapping.characters['judy-alvarez'].multilingualCharacterId).language_codes = ['en-US', 'de-DE'];
  const second = await createMultilingualProfiles({rows: f.rows, mapping: first.mapping, api: f.api});
  assert.deepEqual(second.mapping.characters['judy-alvarez'].languageCodes, ['en-US']);
});

test('the chosen languages follow en-US, once each, in order; "all" is every interface language; a bad one throws', () => {
  assert.deepEqual(languageCodesFor(), ['en-US']);
  assert.deepEqual(languageCodesFor([]), ['en-US']);
  assert.deepEqual(languageCodesFor(['es', 'ja', 'es', 'en']), ['en-US', 'es-ES', 'ja-JP']);
  assert.deepEqual(languageCodesFor('de, zh'), ['en-US', 'de-DE', 'zh-CN']);
  assert.deepEqual(languageCodesFor(['es-mx', 'pt-br']), ['en-US', 'es-MX', 'pt-BR']);
  assert.equal(languageCodesFor(['all']).length, Object.keys(LANGUAGE_TAGS).length, 'English is the first of them, not repeated');
  assert.equal(languageCodesFor(['all'])[0], 'en-US');
  assert.throws(() => languageCodesFor(['klingon']), /Unknown language/);
  assert.throws(() => languageCodesFor(['e1']), /Unknown language/);
  assert.deepEqual([...LANGUAGE_CODES], ['en-US'], 'the default is unchanged');
});

test('chosen languages are written to every twin, existing ones included, verified by readback, and the language box is never touched', async () => {
  const f = fixture(['judy-alvarez']);
  let saved;
  const first = await createMultilingualProfiles({rows: f.rows, api: f.api, persist: value => { saved = value; }, languages: ['es', 'ja']});
  const twin = f.objects.get(first.mapping.characters['judy-alvarez'].multilingualCharacterId);
  assert.deepEqual(twin.language_codes, ['en-US', 'es-ES', 'ja-JP']);
  assert.deepEqual(first.mapping.characters['judy-alvarez'].languageCodes, ['en-US', 'es-ES', 'ja-JP']);
  assert.equal(f.calls.filter(call => call.endpoint === '/character/update' && 'languageCodes' in call.body).length, 1);
  assert.equal(f.calls.filter(call => call.endpoint === '/character/update' && call.body.charID.startsWith('orig-')).length, 0, 'originals are never written');
  // A re-run with the same languages writes nothing; with other languages (or none) it changes the list.
  const before = f.calls.length;
  await createMultilingualProfiles({rows: f.rows, mapping: saved, api: f.api, languages: ['es', 'ja']});
  assert.equal(f.calls.slice(before).filter(call => call.endpoint === '/character/update').length, 0);
  const later = await createMultilingualProfiles({rows: f.rows, mapping: saved, api: f.api, languages: ['de']});
  assert.deepEqual(twin.language_codes, ['en-US', 'de-DE']);
  assert.deepEqual(later.mapping.characters['judy-alvarez'].languageCodes, ['en-US', 'de-DE']);
  const back = await createMultilingualProfiles({rows: f.rows, mapping: later.mapping, api: f.api});
  assert.deepEqual(twin.language_codes, ['en-US']);
  assert.deepEqual(back.mapping.characters['judy-alvarez'].languageCodes, ['en-US']);
  await assert.rejects(createMultilingualProfiles({rows: f.rows, api: f.api, languages: ['nope']}), /Unknown language/);
});

test('a twin carries its own marker, a mapping entry has no relationship fields, and a re-run adopts it', async () => {
  const key = 'judy-alvarez';
  assert.equal(originalMarker(key), '[CyberpunkConvai profile v2:judy-alvarez]');
  assert.equal(twinMarker(key), '[CyberpunkConvai profile v2:judy-alvarez:multilingual]');
  const f = fixture([key]);
  const rows = [{key, originalId: 'orig-' + key, gender: 'FEMALE'}];
  const result = await createMultilingualProfiles({rows, api: f.api});
  const twin = result.mapping.characters[key];
  assert.ok(f.objects.get(twin.multilingualCharacterId).backstory.split('\n').includes(twinMarker(key)));
  assert.equal(twin.variant, undefined);
  assert.equal(twin.baseKey, undefined);
  const before = f.calls.filter(call => call.endpoint === '/character/create').length;
  await createMultilingualProfiles({rows, mapping: result.mapping, api: f.api});
  assert.equal(f.calls.filter(call => call.endpoint === '/character/create').length, before);
});

test('continueOnError records a failing row and still processes the others', async () => {
  const f = fixture(['judy-alvarez', 'jackie-welles']);
  f.objects.get('orig-judy-alvarez').backstory = 'No marker here.';
  await assert.rejects(() => createMultilingualProfiles({rows: f.rows, api: f.api}), /marker/);
  const result = await createMultilingualProfiles({rows: f.rows, api: f.api, continueOnError: true});
  assert.deepEqual(result.failures.map(row => row.key), ['judy-alvarez']);
  assert.deepEqual(result.results.map(row => row.key), ['jackie-welles']);
});

const voiceMap = JSON.parse(readFileSync(new URL('../characters/multilingual-voice-map.json', import.meta.url), 'utf8'));
const rosterRows = JSON.parse(readFileSync(new URL('../characters/roster.json', import.meta.url), 'utf8'));
const archetypeRows = JSON.parse(readFileSync(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'));
const MAIN_CAST = ['judy-alvarez', 'panam-palmer', 'johnny-silverhand', 'kerry-eurodyne', 'river-ward', 'jackie-welles', 'viktor-vektor',
  'misty-olszewski', 'rogue-amendiares', 'takemura', 'mama-welles', 'meredith-stout', 'claire-russell', 'solomon-reed'];

test('voice map describes every voice it assigns, with the right gender, and covers the whole roster', () => {
  assert.equal(Object.keys(voiceMap.assignments).length, rosterRows.length + archetypeRows.length);
  const used = new Set();
  for (const row of rosterRows) {
    const entry = voiceMap.assignments[row.key];
    assert.ok(entry, 'no voice for ' + row.key);
    assert.match(entry.voice, /^AZURE-MULTILINGUAL-|^[A-Za-z]+Multilingual(V2)?Neural$/u);
    assert.equal(voiceMap.voices[entry.voice].gender, entry.voiceGender ?? row.gender, row.key);
    assert.ok(entry.reason.length > 10 && !entry.reason.includes('\n'), row.key);
    used.add(entry.voice);
  }
  assert.ok(used.size >= 40, 'voices should be spread, not two');
  assert.deepEqual(Object.keys(voiceMap.voices).sort(), [...used].sort());
  // The main cast that appears together never shares a voice.
  assert.equal(new Set(MAIN_CAST.map(key => voiceMap.assignments[key].voice)).size, MAIN_CAST.length);
});

test('every archetype has a gender-matched Azure voice that is not a main-cast voice, with a one-line reason', () => {
  assert.equal(archetypeRows.length, 74);
  const mainVoices = new Set(MAIN_CAST.map(key => voiceMap.assignments[key].voice));
  const used = new Set();
  for (const row of archetypeRows) {
    const entry = voiceMap.assignments[row.key];
    assert.ok(entry, 'no voice for ' + row.key);
    assert.match(entry.voice, /^AZURE-MULTILINGUAL-|^[A-Za-z]+Multilingual(V2)?Neural$/u, row.key);
    assert.equal(voiceMap.voices[entry.voice].gender, row.gender, row.key);
    assert.ok(!mainVoices.has(entry.voice), row.key + ' uses a main-cast voice');
    assert.ok(entry.reason.length > 10 && !entry.reason.includes('\n'), row.key);
    used.add(entry.voice);
  }
  // Voices are spread over the 16 female / 22 male non-main-cast voices on offer (reused between kinds that do not meet).
  assert.ok(used.size >= 30, 'archetype voices should be spread');
  // The gang the user singled out, the Haitian-French gang and the corporate guard.
  const voiceName = key => voiceMap.voices[voiceMap.assignments[key].voice].name;
  assert.match(voiceName('npc-maelstrom-male'), /^OnyxTurbo/u, 'harsh, gravelly: the lowest male voice');
  assert.match(voiceName('npc-voodoo-boys-male'), /^(Remy|Lucien)/u, 'French-native for the Haitian-French flavour');
  assert.match(voiceName('npc-corpo-security-male'), /^Steffan/u);
});

test('rosters: named, archetypes or both; every archetype with an ID becomes one twin row and no row is a romantic profile', () => {
  assert.deepEqual(Object.keys(ROSTER_CHOICES).sort(), ['all', 'archetypes', 'named']);
  const ids = Object.fromEntries([...rosterRows, ...archetypeRows].map(row => [row.key, 'id-' + row.key]));
  const common = {ids, genderOfVoice: new Map(), voiceMap};
  const archetypes = buildRows({...common, rosters: [archetypeRows]});
  assert.equal(archetypes.rows.length, 74);
  assert.ok(archetypes.rows.every(row => row.key.startsWith('npc-') && row.originalId === 'id-' + row.key));
  assert.deepEqual(archetypes.voiceFallbacks, [], 'every archetype has a mapped voice');
  assert.equal(archetypes.genderFallbacks.length, 74, 'with no Kokoro table the roster gender is used');
  assert.equal(archetypes.rows.find(row => row.key === 'npc-ncpd-female').gender, 'FEMALE');
  const all = buildRows({...common, rosters: [rosterRows, archetypeRows]});
  assert.equal(all.rows.length, rosterRows.length + 74);
  assert.deepEqual(all.rows.filter(row => row.key.endsWith('-romantic') || 'baseKey' in row), [], 'no romantic row exists any more');
  // A retired romantic key is rejected with a clear message, even when its base character is in the roster.
  assert.throws(() => buildRows({...common, rosters: [rosterRows], only: new Set(['judy-alvarez-romantic'])}), /retired/);
  assert.throws(() => buildRows({...common, rosters: [rosterRows, archetypeRows], only: new Set(['judy-alvarez', 'panam-palmer-romantic'])}), /romantic profiles were retired/);
  assert.deepEqual(buildRows({...common, rosters: [archetypeRows], only: new Set(['npc-homeless-male'])}).rows.map(row => row.key), ['npc-homeless-male']);
  // A profile of the other roster is refused rather than silently skipped.
  assert.throws(() => buildRows({...common, rosters: [archetypeRows], only: new Set(['judy-alvarez'])}), /--only/);
  assert.throws(() => buildRows({...common, rosters: [archetypeRows, archetypeRows]}), /two rosters/);
  // An archetype without an ID in runtime/characters.json is not twinned.
  const missing = {...ids}; delete missing['npc-homeless-male'];
  assert.equal(buildRows({...common, ids: missing, rosters: [archetypeRows]}).rows.length, 73);
});

test('an archetype twin is a faithful clone with memory off, en-US only and its own marker; readback is verified and a re-run adopts it', async () => {
  const key = 'npc-maelstrom-male';
  const f = fixture([key]);
  const original = f.objects.get('orig-' + key);
  original.memory_settings = {enabled: false};
  const voice = voiceMap.assignments[key].voice;
  const rows = [{key, originalId: 'orig-' + key, gender: 'MALE', voice}];
  const first = await createMultilingualProfiles({rows, api: f.api});
  const entry = first.mapping.characters[key], twin = f.objects.get(entry.multilingualCharacterId);
  assert.equal(entry.verified, true);
  assert.equal(twin.voice_type, voice);
  assert.deepEqual(twin.language_codes, ['en-US']);
  assert.equal(twin.memory_settings.enabled, false, 'memory stays off, as on the original');
  assert.equal(twin.backstory, original.backstory.replace(originalMarker(key), twinMarker(key)));
  assert.equal(twinMarker(key), '[CyberpunkConvai profile v2:npc-maelstrom-male:multilingual]');
  assert.deepEqual(first.needsLanguageBoxOff.map(row => row.key), [key]);
  assert.equal(f.calls.filter(call => call.endpoint === '/character/update' && call.body.charID === 'orig-' + key).length, 0);
  assert.equal(f.calls.filter(call => call.endpoint === '/character/update' && 'memorySettings' in call.body).length, 0, 'nothing to turn on or off');
  const before = f.calls.length;
  const second = await createMultilingualProfiles({rows, mapping: first.mapping, api: f.api});
  assert.equal(f.calls.slice(before).filter(call => call.endpoint === '/character/create' || call.endpoint === '/character/update').length, 0);
  assert.equal(second.results[0].created, false);
});

test('memory follows the original in both directions: a twin with memory on is turned off when the original is off, and vice versa', async () => {
  assert.deepEqual(settingUpdates({memory_settings: {enabled: false}}, {memory_settings: {enabled: true}}), {memorySettings: {enabled: false}});
  assert.deepEqual(settingUpdates({memory_settings: {enabled: true}}, {memory_settings: {enabled: false}}), {memorySettings: {enabled: true}});
  assert.deepEqual(settingUpdates({memory_settings: {enabled: false}}, {memory_settings: {enabled: false}}), {});
  assert.deepEqual(settingUpdates({memory_settings: {enabled: true}}, {memory_settings: {enabled: true}}), {});
  const key = 'npc-ncpd-female';
  const f = fixture([key]);
  f.objects.get('orig-' + key).memory_settings = {enabled: false};
  const row = {key, originalId: 'orig-' + key, gender: 'FEMALE'};
  const first = await createMultilingualProfiles({rows: [row], api: f.api});
  // A twin whose memory got switched on is put back, and the original is untouched.
  const twinId = first.mapping.characters[key].multilingualCharacterId;
  f.objects.get(twinId).memory_settings = {enabled: true};
  const original = structuredClone(f.objects.get('orig-' + key));
  await createMultilingualProfiles({rows: [row], mapping: first.mapping, api: f.api});
  assert.equal(f.objects.get(twinId).memory_settings.enabled, false);
  assert.deepEqual(f.objects.get('orig-' + key), original);
});

test('voiceFor uses the map and falls back by gender', () => {
  const map = {voices: {'v-f': {gender: 'FEMALE'}, 'v-m': {gender: 'MALE'}}, assignments: {'judy-alvarez': {voice: 'v-f'}}};
  assert.deepEqual(voiceFor({key: 'judy-alvarez', gender: 'FEMALE', voiceMap: map}), {voice: 'v-f', source: 'map'});
  assert.deepEqual(voiceFor({key: 'jackie-welles', gender: 'MALE', voiceMap: map}), {voice: MULTILINGUAL_VOICES.MALE, source: 'fallback'});
  assert.throws(() => voiceFor({key: 'judy-alvarez', gender: 'MALE', voiceMap: map}), /gender mismatch/);
  assert.throws(() => voiceFor({key: 'judy-alvarez', gender: 'FEMALE', voiceMap: {voices: {}, assignments: {'judy-alvarez': {voice: 'v-x'}}}}), /does not describe/);
});

test('a created twin gets the mapped voice', async () => {
  const f = fixture(['judy-alvarez']);
  const rows = f.rows.map(row => ({...row, voice: 'AZURE-MULTILINGUAL-test'}));
  const result = await createMultilingualProfiles({rows, api: f.api});
  assert.equal(f.objects.get(result.mapping.characters['judy-alvarez'].multilingualCharacterId).voice_type, 'AZURE-MULTILINGUAL-test');
});

test('applyTwinVoices sends only the voice, to twins only, and rejects a readback that changed anything else', async () => {
  const f = fixture(['judy-alvarez', 'jackie-welles']);
  const created = await createMultilingualProfiles({rows: f.rows, api: f.api});
  const calls = f.calls.length;
  const rows = [{key: 'judy-alvarez', voice: 'v-new'}, {key: 'jackie-welles', voice: MULTILINGUAL_VOICES.MALE}];
  const result = await applyTwinVoices({rows, mapping: created.mapping, api: f.api});
  const updates = f.calls.slice(calls).filter(call => call.endpoint === '/character/update');
  assert.deepEqual(updates.map(call => Object.keys(call.body).sort()), [['charID', 'voiceType']], 'only the changed twin, only the voice');
  assert.ok(updates.every(call => call.body.charID.startsWith('twin-')));
  assert.deepEqual(result.results.map(row => row.changed), [true, false]);
  assert.equal(result.mapping.characters['judy-alvarez'].voiceType, 'v-new');
  assert.equal(f.objects.get(created.mapping.characters['judy-alvarez'].multilingualCharacterId).voice_type, 'v-new');
  // A backend that also rewrites another field is caught.
  const g = fixture(['judy-alvarez']);
  const made = await createMultilingualProfiles({rows: g.rows, api: g.api});
  const base = g.api;
  const rewriting = async (endpoint, body) => {
    const value = await base(endpoint, body);
    if (endpoint === '/character/update') g.objects.get(body.charID).backstory += ' extra';
    return value;
  };
  await assert.rejects(() => applyTwinVoices({rows: [{key: 'judy-alvarez', voice: 'v-new'}], mapping: made.mapping, api: rewriting}), /changed other fields.*backstory/);
  // A twin without a mapping entry fails without any remote write.
  const h = fixture(['judy-alvarez']);
  await assert.rejects(() => applyTwinVoices({rows: [{key: 'judy-alvarez', voice: 'v'}], mapping: {version: 1, characters: {}}, api: h.api}), /No mapped twin/);
  assert.equal(h.calls.length, 0);
});

test('computed credit-cost estimates that flip between reads do not count as a change, real settings do', async () => {
  assert.deepEqual(withoutCostEstimates({memory_settings: {enabled: false, kb_min_credit_cost_e8: 1, ltm_min_credit_cost_e8: 2}, x: [{a_min_credit_cost_e8: 3, b: 4}]}),
    {memory_settings: {enabled: false}, x: [{b: 4}]});
  const f = fixture(['judy-alvarez']);
  const made = await createMultilingualProfiles({rows: f.rows, api: f.api});
  const flipping = async (endpoint, body) => {
    const value = await f.api(endpoint, body);
    if (endpoint === '/character/get') value.memory_settings = {...value.memory_settings, ltm_min_credit_cost_e8: Math.random()};
    return value;
  };
  const result = await applyTwinVoices({rows: [{key: 'judy-alvarez', voice: 'v-new'}], mapping: made.mapping, api: flipping});
  assert.equal(result.results[0].changed, true);
});

test('Alt Cunningham is wired as a tier-1 companion end to end (roster, twin, voice, menu, auto-connect, release data)', () => {
  const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/^﻿/, '');
  const json = path => JSON.parse(read(path));
  const key = 'alt-cunningham';
  assert.ok(TIER1_KEYS.includes(key));
  const entry = json('characters/roster.json').find(row => row.key === key);
  assert.ok(entry, 'roster row');
  assert.equal(entry.gender, 'FEMALE');
  assert.deepEqual(entry.records, ['Character.Alt']);
  assert.ok(json('research/cyberpunk/dossiers/alt-cunningham.json').profile.backstory.length > 200, 'dossier');
  assert.ok(read('characters/profile-text/alt-cunningham.txt').includes('BACKSTORY'), 'profile text');
  const voiceMap = json('characters/multilingual-voice-map.json');
  assert.equal(voiceMap.voices[voiceMap.assignments[key]?.voice]?.gender, 'FEMALE', 'twin voice assignment');
  assert.ok(json('characters/world-knowledge.json').profileKeys.includes(key), 'world knowledge audience');
  assert.ok(json('characters/manager-characters.json').some(row => row.profileKey === key && row.record === 'Character.Alt'), 'manager menu record');
  assert.ok(/'alt-cunningham'/.test(read('mod/auto-connect.lua')), 'auto-connect tier-1 list');
  assert.ok(json('assets/gestures/gestures.json').characters['Character.Alt'], 'gesture family');
  const plan = json('packaging/release-plan.json');
  assert.ok(plan.voice.localProfiles.includes(key), 'release voice list');
  const originalId = json('packaging/release-data/characters.json')[key];
  const twin = json('packaging/release-data/multilingual-profiles.json').characters[key];
  assert.match(originalId, /^[0-9a-f-]{36}$/);
  assert.match(twin.multilingualCharacterId, /^[0-9a-f-]{36}$/);
  assert.equal(twin.originalCharacterId, originalId);
});
