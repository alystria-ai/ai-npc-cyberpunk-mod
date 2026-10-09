import assert from 'node:assert/strict';
import test from 'node:test';
import {BASE_KEYS, retiredCharacters} from './Delete-RetiredRomanceProfiles.mjs';

const ordinaryIds = Object.fromEntries([...BASE_KEYS, 'jackie-welles'].map(key => [key, 'ord-' + key]));
const relationships = {version: 1, characters: Object.fromEntries(BASE_KEYS.map(key =>
  [key, {ordinaryCharacterId: 'ord-' + key, romanticCharacterId: 'rom-' + key}]))};
const multilingual = {version: 1, characters: {
  'jackie-welles': {multilingualCharacterId: 'twin-jackie', originalCharacterId: 'ord-jackie-welles'},
  ...Object.fromEntries(BASE_KEYS.map(key => [key, {multilingualCharacterId: 'twin-' + key, originalCharacterId: 'ord-' + key}])),
  ...Object.fromEntries(BASE_KEYS.map(key => [key + '-romantic', {multilingualCharacterId: 'rtwin-' + key, originalCharacterId: 'rom-' + key}])),
}};

test('the plan is exactly the five alternate profiles and their five twins, never an ordinary character', () => {
  const rows = retiredCharacters({relationships, multilingual, ordinaryIds});
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map(row => row.id).sort(), [...BASE_KEYS.map(key => 'rom-' + key), ...BASE_KEYS.map(key => 'rtwin-' + key)].sort());
  assert(rows.every(row => /^\[CyberpunkConvai profile v2:[a-z-]+-romantic(?::multilingual)?\]$/.test(row.marker)));
  assert.equal(rows.find(row => row.role === 'twin' && row.key === 'judy-alvarez-romantic').marker, '[CyberpunkConvai profile v2:judy-alvarez-romantic:multilingual]');
  for (const row of rows) assert(!Object.values(ordinaryIds).includes(row.id) && !row.id.startsWith('twin-'));
});

test('an install that never had the alternate profiles has nothing to delete', () => {
  assert.deepEqual(retiredCharacters({relationships: {version: 1, characters: {}}, multilingual, ordinaryIds}), []);
  assert.deepEqual(retiredCharacters({relationships: undefined, multilingual: undefined, ordinaryIds}), []);
});

test('it refuses an alternate ID that is a current profile, a repeated ID, or a twin of something else', () => {
  const same = structuredClone(relationships);
  same.characters['judy-alvarez'].romanticCharacterId = ordinaryIds['panam-palmer'];
  assert.throws(() => retiredCharacters({relationships: same, multilingual, ordinaryIds}), /current profile|does not clone/);
  const twice = structuredClone(relationships);
  twice.characters['judy-alvarez'].romanticCharacterId = 'rom-panam-palmer';
  assert.throws(() => retiredCharacters({relationships: twice, multilingual, ordinaryIds}), /twice|does not clone/);
  const stranger = structuredClone(multilingual);
  stranger.characters['judy-alvarez-romantic'].originalCharacterId = 'someone-else';
  assert.throws(() => retiredCharacters({relationships, multilingual: stranger, ordinaryIds}), /does not clone/);
  const bad = structuredClone(relationships);
  bad.characters['judy-alvarez'].romanticCharacterId = '../x';
  assert.throws(() => retiredCharacters({relationships: bad, multilingual, ordinaryIds}), /Malformed/);
});
