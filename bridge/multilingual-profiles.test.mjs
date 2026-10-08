import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createMultilingualProfiles, applyTwinVoices, buildRows, ROSTER_CHOICES, settingUpdates, voiceFor, withoutCostEstimates, twinPayload, twinMarker, originalMarker, needsLanguageBoxOff, romanceKey, LANGUAGE_CODES, LANGUAGE_BOX_FIELD, MULTILINGUAL_VOICES, ROMANCE_BASE_KEYS, TIER1_KEYS} from '../scripts/Create-MultilingualProfiles.mjs';

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

test('tier-1 roster has 23 unique profile keys', () => {
  assert.equal(TIER1_KEYS.length, 23);
  assert.equal(new Set(TIER1_KEYS).size, 23);
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

test('romantic twins carry their own marker, never the ordinary twin or the romantic original', async () => {
  assert.deepEqual(ROMANCE_BASE_KEYS.map(romanceKey), ['judy-alvarez-romantic', 'panam-palmer-romantic', 'river-ward-romantic', 'kerry-eurodyne-romantic', 'meredith-stout-romantic']);
  const key = romanceKey('judy-alvarez');
  assert.equal(originalMarker(key), '[CyberpunkConvai profile v2:judy-alvarez-romantic]');
  assert.equal(twinMarker(key), '[CyberpunkConvai profile v2:judy-alvarez-romantic:multilingual]');
  // The ordinary twin and the romantic twin share a display name; only the marker tells them apart.
  const f = fixture(['judy-alvarez', key]);
  for (const id of ['orig-judy-alvarez', 'orig-' + key]) f.objects.get(id).character_name = 'Judy Alvarez';
  const rows = [{key: 'judy-alvarez', originalId: 'orig-judy-alvarez', gender: 'FEMALE'},
    {key, originalId: 'orig-' + key, gender: 'FEMALE', baseKey: 'judy-alvarez'}];
  const result = await createMultilingualProfiles({rows, api: f.api});
  const [ordinary, romantic] = ['judy-alvarez', key].map(k => result.mapping.characters[k]);
  assert.notEqual(ordinary.multilingualCharacterId, romantic.multilingualCharacterId);
  assert.ok(f.objects.get(romantic.multilingualCharacterId).backstory.split('\n').includes(twinMarker(key)));
  assert.equal(f.objects.get(romantic.multilingualCharacterId).backstory.includes(twinMarker('judy-alvarez') + '\n'), false);
  assert.deepEqual({variant: romantic.variant, baseKey: romantic.baseKey}, {variant: 'romantic', baseKey: 'judy-alvarez'});
  // A re-run adopts both without creating anything.
  const before = f.calls.filter(call => call.endpoint === '/character/create').length;
  await createMultilingualProfiles({rows, mapping: result.mapping, api: f.api});
  assert.equal(f.calls.filter(call => call.endpoint === '/character/create').length, before);
  // A lost receipt for the romantic twin is recovered by name plus marker, not confused with the ordinary twin.
  const g = fixture(['judy-alvarez', key]);
  for (const id of ['orig-judy-alvarez', 'orig-' + key]) g.objects.get(id).character_name = 'Judy Alvarez';
  const mapping = (await createMultilingualProfiles({rows: rows.slice(0, 1), api: g.api})).mapping;
  g.loseNext();
  await assert.rejects(() => createMultilingualProfiles({rows, mapping, api: g.api}), /lost receipt/);
  const recovered = await createMultilingualProfiles({rows, api: g.api, mapping});
  assert.equal(recovered.results[1].created, false);
  assert.equal(g.calls.filter(call => call.endpoint === '/character/create').length, 2);
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
    assert.equal(voiceMap.voices[entry.voice].gender, row.gender, row.key);
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

test('rosters: named, archetypes or both; every archetype with an ID becomes one twin row, romance rows stay with the named roster', () => {
  assert.deepEqual(Object.keys(ROSTER_CHOICES).sort(), ['all', 'archetypes', 'named']);
  const ids = Object.fromEntries([...rosterRows, ...archetypeRows].map(row => [row.key, 'id-' + row.key]));
  const relationships = {characters: Object.fromEntries(ROMANCE_BASE_KEYS.map(key => [key, {romanticCharacterId: 'romantic-' + key}]))};
  const common = {ids, genderOfVoice: new Map(), relationships, voiceMap};
  const archetypes = buildRows({...common, rosters: [archetypeRows], withRomance: false});
  assert.equal(archetypes.rows.length, 74);
  assert.ok(archetypes.rows.every(row => row.key.startsWith('npc-') && row.originalId === 'id-' + row.key && !row.baseKey));
  assert.deepEqual(archetypes.voiceFallbacks, [], 'every archetype has a mapped voice');
  assert.equal(archetypes.genderFallbacks.length, 74, 'with no Kokoro table the roster gender is used');
  assert.equal(archetypes.rows.find(row => row.key === 'npc-ncpd-female').gender, 'FEMALE');
  const all = buildRows({...common, rosters: [rosterRows, archetypeRows]});
  assert.equal(all.rows.length, rosterRows.length + 74 + ROMANCE_BASE_KEYS.length);
  assert.deepEqual(all.rows.filter(row => row.baseKey).map(row => row.key), ROMANCE_BASE_KEYS.map(romanceKey));
  assert.deepEqual(buildRows({...common, rosters: [archetypeRows], only: new Set(['npc-homeless-male'])}).rows.map(row => row.key), ['npc-homeless-male']);
  // A profile of the other roster is refused rather than silently skipped.
  assert.throws(() => buildRows({...common, rosters: [archetypeRows], only: new Set(['judy-alvarez'])}), /--only/);
  assert.throws(() => buildRows({...common, rosters: [archetypeRows, archetypeRows]}), /two rosters/);
  // An archetype without an ID in runtime/characters.json is not twinned.
  const missing = {...ids}; delete missing['npc-homeless-male'];
  assert.equal(buildRows({...common, ids: missing, rosters: [archetypeRows], withRomance: false}).rows.length, 73);
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

test('voiceFor uses the map, lets the romantic twin follow its base, and falls back by gender', () => {
  const map = {voices: {'v-f': {gender: 'FEMALE'}, 'v-m': {gender: 'MALE'}}, assignments: {'judy-alvarez': {voice: 'v-f'}}};
  assert.deepEqual(voiceFor({key: 'judy-alvarez', gender: 'FEMALE', voiceMap: map}), {voice: 'v-f', source: 'map'});
  assert.deepEqual(voiceFor({key: 'judy-alvarez-romantic', baseKey: 'judy-alvarez', gender: 'FEMALE', voiceMap: map}), {voice: 'v-f', source: 'map'});
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
