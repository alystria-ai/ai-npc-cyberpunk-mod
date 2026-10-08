import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {resolve as absolutePath} from 'node:path';
import {VoiceSelection} from './voice-selection.mjs';
import {createVoiceProfileRegistry, VOICE_PROFILE_LIMITS} from './voice-profile-registry.mjs';
import {baseProfileOf, isVariantKey, pickVoiceKey, variantKeys, variantSeed, withoutVariants} from './voice-variants.mjs';

const BASE = 'npc-maelstrom-male';
const ALL = [BASE, `${BASE}-v2`, `${BASE}-v3`, `${BASE}-v4`];

test('variant keys: the base key first, then the existing -v2..-v4 keys in order', () => {
  assert.deepEqual(variantKeys(BASE, new Set([...ALL, 'npc-maelstrom-female', 'npc-maelstrom-female-v2'])), ALL);
  assert.deepEqual(variantKeys(BASE, [`${BASE}-v4`, BASE, `${BASE}-v2`]), [BASE, `${BASE}-v2`, `${BASE}-v4`]);
  assert.deepEqual(variantKeys(BASE, [BASE]), [BASE]);
  assert.deepEqual(variantKeys(BASE, [`${BASE}-v3`]), [`${BASE}-v3`], 'a missing base is not invented');
  assert.deepEqual(variantKeys(BASE, [`${BASE}-v5`, `${BASE}-v1`, `${BASE}-v22`, 'x']), []);
  assert.deepEqual(variantKeys(BASE, undefined), []);
  assert.deepEqual(variantKeys(`${BASE}-v2`, ALL), [], 'a variant key has no variants of its own');
});

test('variant keys are recognised by name and map back to their profile', () => {
  assert.equal(isVariantKey(`${BASE}-v2`), true); assert.equal(isVariantKey(`${BASE}-v4`), true);
  for (const key of [BASE, `${BASE}-v1`, `${BASE}-v5`, `${BASE}-v22`, `${BASE}-vx`, 'judy-alvarez', '', undefined, null, 4]) {
    assert.equal(isVariantKey(key), false, String(key));
  }
  assert.equal(baseProfileOf(`${BASE}-v3`), BASE); assert.equal(baseProfileOf(BASE), BASE);
  assert.deepEqual(withoutVariants(new Set([...ALL, 'judy-alvarez'])), [BASE, 'judy-alvarez']);
});

test('the seed is the vendor shop record when present, else the actor entity', () => {
  assert.equal(variantSeed({entity: '123456ULL'}), '123456ULL');
  assert.equal(variantSeed({entity: '123456ULL', archetype: {base: 'x'}}), '123456ULL');
  assert.equal(variantSeed({entity: '123456ULL', archetype: {memoryKey: 'wat_kab_ripperdoc_01'}}), 'wat_kab_ripperdoc_01');
  assert.equal(variantSeed({entity: '1ULL', archetype: {memoryKey: ''}}), '1ULL');
  assert.equal(variantSeed({}), null); assert.equal(variantSeed(undefined), null); assert.equal(variantSeed({entity: ''}), null);
});

test('the pick hashes profile|seed with SHA-256 modulo the available variants, the same on every call', () => {
  const choose = (seed, keys = ALL) => keys[Number(createHash('sha256').update(`${BASE}|${seed}`).digest().readBigUInt64BE(0) % BigInt(keys.length))];
  for (const seed of ['1ULL', '77ULL', 'wat_kab_ripperdoc_01', 'x']) {
    const first = pickVoiceKey(BASE, seed, new Set(ALL));
    assert.equal(first, choose(seed)); assert.equal(pickVoiceKey(BASE, seed, new Set(ALL)), first);
    assert.equal(pickVoiceKey(BASE, seed, [...ALL].reverse()), first, 'the order the registry lists keys in does not matter');
  }
  assert.equal(pickVoiceKey(BASE, '1ULL', ALL), 'npc-maelstrom-male-v4', 'pinned: a restart or refactor must not move an NPC to another voice');
});

test('pedestrians of one kind spread over every variant', () => {
  const counts = new Map();
  for (let id = 0; id < 400; id++) {
    const key = pickVoiceKey(BASE, `${1000 + id * 37}ULL`, ALL);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  assert.deepEqual([...counts.keys()].sort(), ALL);
  for (const count of counts.values()) assert.ok(count > 60 && count < 140, `uneven spread ${[...counts.values()]}`);
  // Another kind hashes differently: the same entity is not locked to the same slot everywhere.
  const other = Array.from({length: 40}, (_, id) => pickVoiceKey('npc-ncpd-male', `${id}ULL`, ['npc-ncpd-male', 'npc-ncpd-male-v2', 'npc-ncpd-male-v3', 'npc-ncpd-male-v4']).replace('npc-ncpd-male', ''));
  const same = Array.from({length: 40}, (_, id) => pickVoiceKey(BASE, `${id}ULL`, ALL).replace(BASE, ''));
  assert.notDeepEqual(other, same);
});

test('a vendor shop record beats the entity: the same shop keeps its voice whichever actor represents it', () => {
  const seedA = variantSeed({entity: '1ULL', archetype: {memoryKey: 'wat_kab_ripperdoc_01'}});
  const seedB = variantSeed({entity: '999ULL', archetype: {memoryKey: 'wat_kab_ripperdoc_01'}});
  assert.equal(pickVoiceKey(BASE, seedA, ALL), pickVoiceKey(BASE, seedB, ALL));
  const picks = new Set(Array.from({length: 40}, (_, id) => pickVoiceKey(BASE, variantSeed({entity: `${id}ULL`, archetype: {memoryKey: `shop_${id}`}}), ALL)));
  assert.ok(picks.size > 1);
});

test('only available variants are chosen from; the count of the available ones is the modulus', () => {
  const available = new Set([BASE, `${BASE}-v3`]);
  for (let id = 0; id < 60; id++) assert.ok([BASE, `${BASE}-v3`].includes(pickVoiceKey(BASE, `${id}ULL`, available)));
  assert.equal(pickVoiceKey(BASE, '5ULL', new Set([`${BASE}-v2`, `${BASE}-v4`, 'npc-other-male'])).startsWith(BASE + '-v'), true);
  // The base alone, no variants registered: always the base (today's behaviour).
  for (let id = 0; id < 20; id++) assert.equal(pickVoiceKey(BASE, `${id}ULL`, new Set([BASE])), BASE);
});

test('without a seed or without any usable variant the base key is used', () => {
  assert.equal(pickVoiceKey(BASE, null, ALL), BASE); assert.equal(pickVoiceKey(BASE, undefined, ALL), BASE);
  assert.equal(pickVoiceKey(BASE, '', ALL), BASE);
  assert.equal(pickVoiceKey(BASE, '1ULL', []), BASE); assert.equal(pickVoiceKey(BASE, '1ULL', new Set()), BASE);
  assert.equal(pickVoiceKey(BASE, '1ULL', new Set(['npc-other-male', 'npc-other-male-v2'])), BASE);
  assert.equal(pickVoiceKey(BASE, '1ULL', undefined), BASE);
});

// ---- Through the voice selection: the pick uses the backend's availability, the lists never show variants ------

const runtimeDirectory = key => absolutePath('fixture', key);
const reference = key => ({reference: `runtime/voice-references/${key}.wav`, sha256: 'a'.repeat(64), transcript: 'A line.'});
const pocketConfig = keys => ({version: 1, provider: 'pocket', engine: 'pocket-tts',
  runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, runtimeDirectory(key)])),
  model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64),
    inputIdentity: 'e'.repeat(64), selectedStep: 1500},
  voices: Object.fromEntries(keys.map(key => [key, reference(key)]))});
const omniConfig = keys => ({version: 2, provider: 'hybrid', engine: 'omnivoice', steps: 16,
  voices: Object.fromEntries(keys.map(key => [key, reference(key)])),
  preparation: {mode: 'lazy', startupProfiles: [], maxCachedProfiles: 8}});
const selection = (keys, options = {}) => new VoiceSelection(pocketConfig(keys), {factory() { throw Error('no worker in this test'); },
  profileKeys: SORTED, ...options});

test('VoiceSelection picks among the variants the backend can speak and keeps routing on the base profile', () => {
  const voices = selection([...ALL, 'judy-alvarez']);
  assert.equal(voices.provider, 'pocket'); assert.equal(voices.usesProfile(BASE), true);
  for (let id = 0; id < 80; id++) {
    const seed = `${id}ULL`;
    assert.equal(voices.voiceKeyFor(BASE, seed), pickVoiceKey(BASE, seed, ALL));
    assert.equal(voices.voiceKeyFor(BASE, seed), voices.voiceKeyFor(BASE, seed));
  }
  assert.equal(voices.voiceKeyFor('judy-alvarez', '7ULL'), 'judy-alvarez', 'a named character has no variants');
  assert.equal(voices.voiceKeyFor(BASE, null), BASE, 'no seed, the base voice');
  assert.equal(voices.voiceKeyFor('npc-unknown-male', '7ULL'), 'npc-unknown-male', 'not a local profile: the key is left alone');
  // A variant the worker cannot speak (reference vanished) is left out of the draw.
  voices.availabilities.pocket = new Set([BASE, `${BASE}-v4`, 'judy-alvarez']);
  for (let id = 0; id < 40; id++) assert.ok([BASE, `${BASE}-v4`].includes(voices.voiceKeyFor(BASE, `${id}ULL`)));
  voices.availabilities.pocket = new Set([`${BASE}-v2`, 'judy-alvarez']);
  assert.equal(voices.usesProfile(BASE), false);
  assert.equal(voices.voiceKeyFor(BASE, '3ULL'), BASE, 'a profile that is not spoken locally keeps its own key');
});

test('without Pocket the pick is made among the OmniVoice registry of the committed reference', () => {
  const voices = new VoiceSelection(pocketConfig(['judy-alvarez']), {factory() { throw Error('none'); },
    omniConfigs: {short: omniConfig([BASE, `${BASE}-v2`]), long: omniConfig([BASE, `${BASE}-v2`, `${BASE}-v3`])},
    omniPack: {installed: true, missing: []}, profileKeys: []});
  // The committed state after Apply, set directly so that no worker is started.
  voices.omniReference = 'long'; voices.activateOmni(); voices.provider = 'omni';
  assert.equal(voices.usesProfile(BASE), true);
  const picks = new Set(Array.from({length: 60}, (_, id) => voices.voiceKeyFor(BASE, `${id}ULL`)));
  assert.deepEqual([...picks].sort(), [BASE, `${BASE}-v2`, `${BASE}-v3`]);
});

const SORTED = ['judy-alvarez', 'npc-maelstrom-female', BASE];

test('variant keys never appear as a profile, a route key, a route change or a configured/routed profile', () => {
  const states = [];
  const voices = selection([...ALL, 'npc-maelstrom-female', `npc-maelstrom-female-v2`, 'judy-alvarez'], {onState: state => states.push(state)});
  assert.equal(voices.routeKeys.some(isVariantKey), false);
  assert.deepEqual(voices.routeKeys, SORTED);
  assert.deepEqual(voices.profileKeys, SORTED);
  voices.request({voice: false});
  assert.deepEqual(voices.consumeRouteChanges(), SORTED);
  voices.publish();
  const published = states.at(-1);
  assert.deepEqual(published.configuredProfiles, SORTED);
  assert.equal(published.routedProfiles.some(isVariantKey), false);
  assert.deepEqual(published.routedProfiles, SORTED);
  // They stay in the registry the workers load.
  assert.equal(voices.registries.pocket.has(`${BASE}-v2`), true);
  assert.equal(voices.hasProfile(`${BASE}-v2`), true);
});

test('a voice configuration may carry 1024 voices (profiles plus their variants)', () => {
  assert.equal(VOICE_PROFILE_LIMITS.profiles, 1024);
  const many = count => Object.fromEntries(Array.from({length: count}, (_, i) => [`npc-kind-${i}`, reference(`npc-kind-${i}`)]));
  const config = voices => ({version: 2, provider: 'hybrid', engine: 'omnivoice', voices,
    preparation: {mode: 'lazy', startupProfiles: [], maxCachedProfiles: 8}});
  assert.equal(createVoiceProfileRegistry(config(many(1024))).keys.length, 1024);
  assert.throws(() => createVoiceProfileRegistry(config(many(1025))), /Invalid local voice registry/);
});
