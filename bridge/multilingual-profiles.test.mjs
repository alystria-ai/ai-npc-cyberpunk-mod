import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMultilingualProfiles, twinPayload, twinMarker, originalMarker, needsLanguageBoxOff, romanceKey, LANGUAGE_CODES, LANGUAGE_BOX_FIELD, MULTILINGUAL_VOICES, ROMANCE_BASE_KEYS, TIER1_KEYS} from '../scripts/Create-MultilingualProfiles.mjs';

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
