import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {validateResearch, buildProfiles} from '../research/cyberpunk/scripts/build_research.mjs';
import {characterPayload} from '../scripts/character-payload.mjs';
import {serializeCharacterSamples} from '../scripts/character-samples.mjs';

function fixture() {
  const source = {id: 'guide', url: 'https://example.org/quest', title: 'Quest guide',
    locator: 'Rescue outcome', notes: 'Narrative only; not native proof.'};
  const dossier = {version: 1, key: 'judy', name: 'Judy', kind: 'named', sources: [source],
    profile: {backstory: 'An established technician.', speakingStyleDescription: 'Direct and thoughtful.',
      speakingStyleSampleDialogues: Array.from({length: 6}, (_, i) => `Original delivery example ${i}.`)},
    intrinsicClaims: [{id: 'identity', text: 'A technician.', sourceIds: ['guide'], confidence: 'source-supported'}],
    relationships: [], questKeys: ['rescue'], uncertainties: [],
    knowledge: {background: ['Technique.'], private: ['A private detail.'], unknown: ['No assumed romance.'],
      conditional: [{questKey: 'rescue', decisionId: 'lane.rescue', outcomeKey: 'rescued',
        text: 'The hostage survived.', perspective: 'participant', sourceIds: ['guide']}]}};
  const map = {version: 1, lane: 'lane', sources: [source], quests: [{key: 'rescue', title: 'Rescue',
    synopsis: 'A dangerous recovery.', sourceIds: ['guide'], stages: [], characters: ['judy'],
    decisions: [{id: 'lane.rescue', topic: 'hostage-fate', description: 'Hostage fate.', sourceIds: ['guide'],
      outcomes: [{key: 'rescued', description: 'The hostage survived.', sourceIds: ['guide']},
        {key: 'lost', description: 'The hostage died.', sourceIds: ['guide']}],
      runtime: {status: 'unmapped', conditions: null, evidence: []}}]}]};
  return {roster: [{key: 'judy', name: 'Judy', voice: 'voice-existing', model: 'model-existing',
    aliases: ['Judy Alvarez'], records: ['Character.judy']}], dossiers: [dossier], maps: [map]};
}

test('a researched but unmapped branch stays explicitly unqualified', () => {
  const result = validateResearch(fixture());
  assert.deepEqual(result.errors, []);
  assert.equal(result.coverage.nativeMappingComplete, false);
  assert.equal(result.coverage.outcomesAuthored, 2);
  assert.deepEqual(result.coverage.runtimeQualification, {unmapped: 1});
});

test('conditional memories require an exact authored outcome and quest, not a generic decision link', () => {
  for (const field of ['outcomeKey', 'decisionId', 'questKey']) {
    const input = fixture(); input.dossiers[0].knowledge.conditional[0][field] = 'missing';
    assert(validateResearch(input).errors.length > 0, field);
  }
});

test('invalid native qualification and source references block profile application', () => {
  const input = fixture();
  input.maps[0].quests[0].decisions[0].runtime.status = 'source-verified';
  input.dossiers[0].intrinsicClaims[0].sourceIds = ['invented'];
  const errors = validateResearch(input).errors.join('\n');
  assert.match(errors, /native condition evidence/);
  assert.match(errors, /Unknown source invented/);
});

test('overlapping character perspectives retain all decisions and source provenance', () => {
  const input = fixture(), other = structuredClone(input.maps[0]);
  other.lane = 'other'; other.quests[0].decisions[0].id = 'other.rescue';
  other.sources[0].id = 'other-guide';
  other.quests[0].sourceIds = ['other-guide'];
  other.quests[0].decisions[0].sourceIds = ['other-guide'];
  for (const row of other.quests[0].decisions[0].outcomes) row.sourceIds = ['other-guide'];
  input.maps.push(other);
  const result = validateResearch(input), quest = result.quests.get('rescue');
  assert.deepEqual(result.errors, []);
  assert.equal(result.quests.size, 1);
  assert.equal(quest.decisions.length, 2);
  assert.deepEqual(quest.sources.map(row => row.lane), ['lane', 'other']);
});

test('profile update preserves model and voice while separating style, samples and conditional knowledge', () => {
  const input = fixture(), [profile] = buildProfiles(input.roster, input.dossiers);
  const payload = characterPayload(profile);
  assert.equal(payload.voiceType, 'voice-existing');
  assert.equal(payload.model_group_name, 'model-existing');
  assert.match(payload.backstory, /established technician/);
  assert.doesNotMatch(payload.backstory, /Original delivery|Direct and thoughtful|hostage survived|private detail/);
  assert.match(payload.speaking_style_description, /Direct and thoughtful/);
  assert.match(payload.speaking_style_sample_dialogues, /Original delivery example 5/);
  assert.match(payload.backstory, /\[CyberpunkConvai profile v2:judy\]$/);
  assert.deepEqual(profile.records, ['Character.judy']);
  input.dossiers[0].profile.speakingStyleSampleDialogues[0] = 'V: Are you busy?\nJudy: Got a minute. Make it count.';
  const paired = buildProfiles(input.roster, input.dossiers)[0].speakingStyleSampleDialogues;
  assert.match(paired, /^Got a minute\. Make it count\./);
  assert.doesNotMatch(paired, /V:|Judy:/);
  assert.equal(input.dossiers[0].profile.speakingStyleSampleDialogues[0], 'V: Are you busy?\nJudy: Got a minute. Make it count.');
  input.dossiers[0].profile.speakingStyleSampleDialogues[0] = 'Good news: we made it.';
  assert.match(buildProfiles(input.roster, input.dossiers)[0].speakingStyleSampleDialogues, /^Good news: we made it\./);
});

test('sample serialization keeps spoken words and third-party names without importing either transcript role', () => {
  const profile = {key: 'judy-alvarez', name: 'Judy Alvarez', aliases: ['Judy Álvarez']};
  assert.equal(serializeCharacterSamples([
    'V: Is Rogue here?\nJudy: Rogue knows this place better than I do.',
    'Judy Álvarez: Good news: we made it.',
    {user: 'Know a netrunner?', character: 'Ask Nix. He might know.'},
  ], profile), 'Rogue knows this place better than I do.\n\nGood news: we made it.\n\nAsk Nix. He might know.');
  assert.throws(() => serializeCharacterSamples(['V: Hey.\nPanam: Wrong speaker.'], profile), /Unrecognized paired dialogue/);
  assert.throws(() => serializeCharacterSamples(['V: Hey.\nJudy: Hello.\nV: Another turn.'], profile), /Unrecognized paired dialogue/);
  assert.throws(() => serializeCharacterSamples(['Character: Hello.'], profile), /without speaker labels/);
  assert.throws(() => serializeCharacterSamples(['character: Hello.'], profile), /without speaker labels/);
  assert.equal(serializeCharacterSamples(['v: Hey.\njudy: Hello.', 'judy álvarez: Good to see you.'], profile), 'Hello.\n\nGood to see you.');
});

test('every checked-in profile exports only its original response while preserving research and catalog identity', async () => {
  const roster = JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8'));
  const directory = new URL('../research/cyberpunk/dossiers/', import.meta.url);
  const dossiers = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.json'))
    .map(async name => JSON.parse(await readFile(new URL(name, directory), 'utf8'))));
  const researchBefore = JSON.stringify(dossiers), byKey = new Map(dossiers.map(dossier => [dossier.key, dossier]));
  const generated = buildProfiles(roster, dossiers);
  for (const [index, profile] of generated.entries()) {
    const original = byKey.get(profile.key).profile.speakingStyleSampleDialogues;
    const expected = original.map(example => example.startsWith('V: ')
      ? example.slice(example.indexOf('\n') + 1).replace(/^[^:]+: /u, '') : example);
    assert.equal(profile.speakingStyleSampleDialogues, expected.join('\n\n'), profile.key);
    for (const field of ['key', 'name', 'voice', 'voiceName', 'model', 'aliases', 'records']) {
      assert.deepEqual(profile[field], roster[index][field], `${profile.key}/${field}`);
    }
    characterPayload(profile);
  }
  assert.equal(JSON.stringify(dossiers), researchBefore);
  const bugbear = generated.find(profile => profile.key === '8ug8ear');
  assert.doesNotMatch(bugbear.speakingStyleSampleDialogues, /8ug8ear:|^V:/mu);
});

test('malformed outcomes report validation errors rather than crash or claim full coverage', () => {
  const input = fixture(); delete input.maps[0].quests[0].decisions[0].outcomes;
  const result = validateResearch(input);
  assert(result.errors.some(row => row.includes('No researched outcomes')));
  assert.equal(result.coverage.outcomesAuthored, 0);
});
