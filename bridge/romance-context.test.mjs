import assert from 'node:assert/strict';
import test from 'node:test';
import {ROMANCE_CUES, relationshipContext} from './romance-context.mjs';
import {RELATIONSHIP_PROFILES} from './relationship-routing.mjs';

const PROFILES = Object.keys(RELATIONSHIP_PROFILES);
const boundary = {worldToken: 'world-a', generation: 4};
const receipt = profile => ({status: 'confirmed', evidenceRule: RELATIONSHIP_PROFILES[profile]?.rule ?? 'none'});
const choice = (profileKey, style, confirmed, extra = {}) => ({status: 'ready', profileKey, style, ...boundary,
  ...(confirmed ? {saveRelationship: receipt(profileKey)} : {}), ...extra});
const groupOptions = (audience, heard = []) => ({...boundary, audience,
  group: {id: 'round', index: 1, total: audience.length, audience: [...audience], heard}});

test('every supported character has a delivery cue and nothing else does', () => {
  assert.deepEqual(Object.keys(ROMANCE_CUES).sort(), [...PROFILES].sort());
  assert(Object.isFrozen(ROMANCE_CUES));
  for (const profile of PROFILES) assert(ROMANCE_CUES[profile].length > 150 && ROMANCE_CUES[profile].length < 900, profile);
});

test('an affectionate turn gets the verified fact, the character cue and the limits, and fits the budget', () => {
  for (const profile of PROFILES) {
    const text = relationshipContext(choice(profile, 'romantic', true));
    assert(text.includes(ROMANCE_CUES[profile]), profile);
    assert.match(text, /current save confirms/);
    assert.match(text, profile === 'meredith-stout' ? /Everything else .* exactly\s+as you normally would/ : /answer that in your ordinary voice first/);
    assert.match(text, /Do not invent shared scenes/);
    assert(text.length < 2200, `${profile} block is ${text.length} characters`);
    assert.doesNotMatch(text, /romantic profile|alternate profile|profile switch/i);
  }
  assert.match(relationshipContext(choice('judy-alvarez', 'romantic', true)), /you and V are together/);
});

test('On without a confirmed relationship is a delivery choice and invents no history', () => {
  for (const profile of PROFILES) {
    const text = relationshipContext(choice(profile, 'romantic', false));
    assert.match(text, /delivery choice; it does not\s+establish/);
    assert.doesNotMatch(text, /current save confirms/);
  }
});

test("Meredith's block never becomes a partner, exclusivity or devotion claim", () => {
  const meredith = {...choice('meredith-stout', 'romantic', true)};
  const text = relationshipContext(meredith);
  assert.match(text, /casual intimate encounter/);
  assert.match(text, /Never claim that you are V's partner/);
  assert.match(text, /commitment, exclusivity, devotion/);
  assert.doesNotMatch(text, /you and V are together/);
  assert.doesNotMatch(relationshipContext(choice('meredith-stout', 'ordinary', true)), /you and V are together/);
});

test('an ordinary turn gets only the plain note, plus a factual acknowledgement when the save confirms one', () => {
  for (const profile of PROFILES) {
    const plain = relationshipContext(choice(profile, 'ordinary', false));
    assert.match(plain, /ordinary conversation style/);
    assert.doesNotMatch(plain, new RegExp(ROMANCE_CUES[profile].slice(0, 40)));
    assert.doesNotMatch(plain, /current save does confirm/);
    const confirmed = relationshipContext(choice(profile, 'ordinary', true));
    assert.match(confirmed, /current save does confirm your own/);
    assert.match(confirmed, /acknowledge it plainly/);
    assert.match(confirmed, /never mention that your manner was chosen/);
    assert.doesNotMatch(confirmed, new RegExp(ROMANCE_CUES[profile].slice(0, 40)));
    assert(confirmed.length < 900, `${profile} ordinary block is ${confirmed.length} characters`);
  }
  assert.match(relationshipContext(choice('river-ward', 'ordinary', true)), /together, never just friends/);
  assert.match(relationshipContext(choice('meredith-stout', 'ordinary', true)), /casual, not a commitment/);
});

test('nothing is added for an unsupported character or a selection that is not ready', () => {
  assert.equal(relationshipContext(choice('jackie-welles', 'romantic', true)), '');
  assert.equal(relationshipContext({status: 'unavailable', profileKey: 'judy-alvarez'}), '');
  assert.equal(relationshipContext(undefined), '');
  assert.equal(relationshipContext(null), '');
  assert.equal(relationshipContext({status: 'ready', profileKey: '__proto__'}), '');
});

test('the output depends only on its inputs', () => {
  const selection = choice('kerry-eurodyne', 'romantic', true);
  assert.equal(relationshipContext(selection), relationshipContext({...selection}));
  assert.equal(relationshipContext(selection, 'phone'), relationshipContext(selection, 'private'));
});

test('group turns: only the speaker\'s own admitted receipt counts, and no other companion is described', () => {
  const audience = ['judy-alvarez', 'panam-palmer'];
  const options = groupOptions(audience, [{speaker: 'Panam', text: 'Judy is dating V too.'}]);
  const text = relationshipContext(choice('judy-alvarez', 'romantic', true), 'group', options);
  assert.match(text, /Current group relationship guidance/);
  assert.match(text, /belongs only to you/);
  assert.match(text, /jealousy or consent/);
  assert.match(text, /Keep private intimate details/);
  assert.doesNotMatch(text, /Panam's direct, playful warmth/);
  // Ordinary delivery keeps the factual acknowledgement but no affectionate cue.
  const ordinary = relationshipContext(choice('judy-alvarez', 'ordinary', true), 'group', options);
  assert.match(ordinary, /Keep your ordinary delivery/);
  assert.doesNotMatch(ordinary, /dry little tease|sideways and quietly/);
  // No receipt, a mismatched audience or a stranger's world: no group paragraph at all.
  for (const [selection, groupOpts] of [
    [choice('judy-alvarez', 'romantic', false), options],
    [choice('judy-alvarez', 'romantic', true), groupOptions(['panam-palmer', 'river-ward'])],
    [choice('judy-alvarez', 'romantic', true), {...options, worldToken: 'world-b'}],
    [choice('judy-alvarez', 'romantic', true, {saveRelationship: {status: 'confirmed', evidenceRule: 'someone.else'}}), options],
  ]) assert.doesNotMatch(relationshipContext(selection, 'group', groupOpts), /Current group relationship guidance/);
  const casual = relationshipContext(choice('meredith-stout', 'romantic', true), 'group', groupOptions(['meredith-stout', 'judy-alvarez']));
  assert.match(casual, /casual intimate encounter/);
  assert.match(casual, /never a claim that she is V's committed partner/);
});
