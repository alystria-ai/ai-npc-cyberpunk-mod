import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildRelationshipProfilePayloads} from '../scripts/relationship-profile-payloads.mjs';
import {RELATIONSHIP_PROFILES} from './relationship-routing.mjs';
import {assertPlainSampleDialogues} from '../scripts/character-samples.mjs';

const roster = JSON.parse(readFileSync(new URL('../characters/roster.json', import.meta.url), 'utf8'));

test('five local variant payloads preserve separate biography, style and unlabeled samples with original model/voice', () => {
  const before = JSON.stringify(roster), variants = buildRelationshipProfilePayloads(roster);
  assert.equal(variants.length, 5);
  for (const row of variants) {
    const base = roster.find(profile => profile.key === row.profileKey), payload = row.payload;
    assert.equal(payload.voiceType, base.voice);
    assert.equal(payload.model_group_name, base.model);
    assert(payload.backstory.includes(row.ownershipMarker));
    assert(!payload.backstory.includes(`[CyberpunkConvai profile v2:${row.profileKey}]`));
    assert(payload.speaking_style_description.startsWith(base.speakingStyleDescription));
    assertPlainSampleDialogues(payload.speaking_style_sample_dialogues, base);
    assert(!payload.backstory.includes(payload.speaking_style_sample_dialogues));
    assert(!payload.backstory.includes(payload.speaking_style_description));
  }
  assert.equal(JSON.stringify(roster), before);
});

test('Meredith variant explicitly preserves casual familiarity rather than an ongoing romance', () => {
  const row = buildRelationshipProfilePayloads(roster).find(profile => profile.profileKey === 'meredith-stout');
  assert.equal(row.kind, 'casual-intimacy');
  assert.match(row.payload.speaking_style_description, /does not establish a continuing romance/);
  assert.match(row.payload.backstory, /no continuing romance, exclusivity or promise/);
});

test('variant preparation rejects missing/duplicate canonical profiles and malformed ownership markers', () => {
  assert.throws(() => buildRelationshipProfilePayloads(roster.filter(profile => profile.key !== 'judy-alvarez')), /missing from roster/);
  assert.throws(() => buildRelationshipProfilePayloads([...roster, roster[0]]), /duplicate/);
  const invalid = structuredClone(roster), row = invalid.find(profile => profile.key === 'judy-alvarez');
  row.backstory = row.backstory.replace('[CyberpunkConvai profile v2:judy-alvarez]', 'unowned');
  assert.throws(() => buildRelationshipProfilePayloads(invalid), /ownership marker/);
  assert.deepEqual(buildRelationshipProfilePayloads(roster).map(row => row.profileKey).sort(), Object.keys(RELATIONSHIP_PROFILES).sort());
});
