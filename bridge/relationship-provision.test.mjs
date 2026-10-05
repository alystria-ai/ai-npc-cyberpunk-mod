import {test} from 'node:test';
import assert from 'node:assert/strict';
import {provisionRelationshipProfiles} from '../scripts/Provision-RelationshipProfiles.mjs';
import {RELATIONSHIP_PROFILES} from './relationship-routing.mjs';
import {characterPayload} from '../scripts/character-payload.mjs';

function fixture() {
  const roster = Object.keys(RELATIONSHIP_PROFILES).map(key => ({key, name: key.replaceAll('-', ' '),
    model: 'test-model', voice: 'convai-kokoro-test',
    backstory: `Established biography.\n[CyberpunkConvai profile v2:${key}]`,
    speakingStyleDescription: 'Character-specific delivery.', speakingStyleSampleDialogues: 'A short original answer.'}));
  const ordinaryIds = Object.fromEntries(roster.map(row => [row.key, 'ordinary-' + row.key]));
  const objects = new Map();
  function detail(id, payload) {
    return {character_id: id, character_name: payload.charName, voice_type: payload.voiceType,
      backstory: payload.backstory, speaking_style: {description: payload.speaking_style_description,
        sample_dialogues: payload.speaking_style_sample_dialogues},
      personalised_prompt_config: {MODEL: payload.model_group_name}, memory_settings: {enabled: true}};
  }
  for (const row of roster) objects.set(ordinaryIds[row.key], detail(ordinaryIds[row.key], characterPayload(row)));
  const calls = []; let serial = 0, failCreate;
  const api = async (endpoint, body) => {
    calls.push({endpoint, body: structuredClone(body)});
    if (endpoint === '/character/list') return {characters: [...objects.values()].map(value => structuredClone(value))};
    if (endpoint === '/character/get') return structuredClone(objects.get(body.charID));
    if (endpoint === '/character/create') {
      const id = 'alternate-' + (++serial);
      if (failCreate === 'missing') throw Error('Lost response before any known receipt');
      objects.set(id, detail(id, body));
      if (failCreate === 'committed') { failCreate = undefined; throw Error('Lost response after commit'); }
      return {charID: id};
    }
    if (endpoint === '/character/update') {
      // Core updates only the supplied fields; a style-only body keeps the rest.
      objects.set(body.charID, body.charName ? detail(body.charID, body) : {...objects.get(body.charID),
        speaking_style: {description: body.speaking_style_description, sample_dialogues: body.speaking_style_sample_dialogues}});
      return {STATUS: 'SUCCESS'};
    }
    assert.fail('Unexpected provider API: ' + endpoint);
  };
  return {roster, ordinaryIds, objects, calls, api,
    fail(value) { failCreate = value; },
    createCount: () => calls.filter(call => call.endpoint === '/character/create').length};
}

test('provisions five distinct alternates without changing ordinary mappings or calling memory APIs', async () => {
  const f = fixture(), before = structuredClone(f.ordinaryIds);
  const result = await provisionRelationshipProfiles(f);
  assert.equal(result.profiles.length, 5);
  assert.deepEqual(f.ordinaryIds, before);
  assert.equal(new Set(result.profiles.map(row => row.characterId)).size, 5);
  for (const [key, ids] of Object.entries(result.registry.characters)) {
    assert.equal(ids.ordinaryCharacterId, before[key]);
    assert.notEqual(ids.romanticCharacterId, before[key]);
    assert.ok(f.objects.get(ids.romanticCharacterId).backstory.includes(`[CyberpunkConvai profile v2:${key}-romantic]`));
  }
});

test('an ambiguous but committed create is recovered by exact marker without creating a duplicate', async () => {
  const f = fixture(); f.fail('committed');
  let recovery;
  await assert.rejects(provisionRelationshipProfiles({...f, persist: async (registry, intents) => { recovery = {registry, intents}; }}), /Lost response/);
  assert.equal(recovery.intents['judy-alvarez'].phase, 'uncertain');
  const result = await provisionRelationshipProfiles({...f, ...recovery});
  assert.equal(result.profiles.length, 5);
  assert.equal(f.createCount(), 5);
});

test('an uncertain create with no owned marker cannot be blindly repeated', async () => {
  const f = fixture(); f.fail('missing'); let recovery;
  await assert.rejects(provisionRelationshipProfiles({...f, persist: async (registry, intents) => { recovery = {registry, intents}; }}));
  f.fail(undefined);
  await assert.rejects(provisionRelationshipProfiles({...f, ...recovery}), /needs reconciliation/);
  assert.equal(f.createCount(), 1);
});

test('wrong alternate ownership and missing ordinary markers fail before any remote mutation', async () => {
  const f = fixture();
  f.objects.set('foreign-character', {...f.objects.get(f.ordinaryIds['judy-alvarez']), character_id: 'foreign-character'});
  const registry = {version: 1, characters: {'judy-alvarez': {romanticCharacterId: 'foreign-character'}}};
  await assert.rejects(provisionRelationshipProfiles({...f, registry}), /marker mismatch/);
  assert.equal(f.createCount(), 0);
  f.objects.get(f.ordinaryIds['meredith-stout']).backstory = 'An unrelated character.';
  await assert.rejects(provisionRelationshipProfiles(f), /Ordinary profile ownership/);
  assert.equal(f.createCount(), 0);
  assert.equal(f.calls.filter(call => call.endpoint === '/character/update').length, 0);
});

test('style-only repair writes only the speaking-style fields of mapped alternates', async () => {
  const f = fixture();
  const {registry} = await provisionRelationshipProfiles(f);
  const changed = f.roster.map(row => ({...row, speakingStyleDescription: row.speakingStyleDescription + ' Leave room for others.'}));
  f.calls.length = 0;
  const result = await provisionRelationshipProfiles({...f, roster: changed, registry, styleOnly: true});
  assert.equal(result.profiles.length, 5);
  const updates = f.calls.filter(call => call.endpoint === '/character/update');
  assert.equal(updates.length, 5);
  for (const call of updates) assert.deepEqual(Object.keys(call.body).sort(), ['charID', 'speaking_style_description', 'speaking_style_sample_dialogues']);
  assert.equal(f.createCount(), 0, 'style-only repair never creates');
  // A biography drift is refused before any write.
  const drifted = changed.map(row => ({...row, backstory: row.backstory.replace('Established', 'Revised')}));
  f.calls.length = 0;
  await assert.rejects(provisionRelationshipProfiles({...f, roster: drifted, registry, styleOnly: true}), /biography differs/);
  assert.equal(f.calls.filter(call => call.endpoint === '/character/update').length, 0);
});
