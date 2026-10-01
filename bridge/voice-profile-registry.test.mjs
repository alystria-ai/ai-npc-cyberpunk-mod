import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceProfileRegistry, LEGACY_LOCAL_VOICE_KEYS, VOICE_PROFILE_LIMITS} from './voice-profile-registry.mjs';

const reference = key => ({reference: `runtime/voice-references/${key}.wav`,
  sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.'});
const config = keys => ({version: 2, provider: 'hybrid', engine: 'omnivoice',
  voices: Object.fromEntries(keys.map(key => [key, reference(key)]))});

test('legacy verified references preserve exact hashes/transcripts and eager three-profile preparation', () => {
  const original = {...config(LEGACY_LOCAL_VOICE_KEYS), version: 1}, registry = createVoiceProfileRegistry(original);
  assert.equal(registry.preparation.mode, 'eager');
  assert.deepEqual(registry.keys, [...LEGACY_LOCAL_VOICE_KEYS].sort());
  assert.deepEqual([...registry.preparation.startupProfiles].sort(), [...registry.keys]);
  for (const key of LEGACY_LOCAL_VOICE_KEYS) {
    assert.equal(registry.has(key), true);
    assert.equal(registry.profiles[key].sha256, original.voices[key].sha256);
    assert.equal(registry.profiles[key].transcript, original.voices[key].transcript);
  }
  original.voices['judy-alvarez'].transcript = 'Changed after selection';
  assert.equal(registry.profiles['judy-alvarez'].transcript, 'Ready when you are, V.');
  assert.throws(() => { registry.keys.push('alex'); }, TypeError);
});

test('wider cast uses configured identity and bounded startup, without warming every reference', () => {
  const input = config([...LEGACY_LOCAL_VOICE_KEYS, ...Array.from({length: 76}, (_, i) => `cast-${i}`)]);
  input.voices.unavailable = {status: 'unavailable'};
  input.voices.unprepared = {status: 'unprepared'};
  const registry = createVoiceProfileRegistry(input);
  assert.equal(registry.keys.length, 79);
  assert.equal(registry.preparation.mode, 'lazy');
  assert.deepEqual(registry.preparation.startupProfiles, LEGACY_LOCAL_VOICE_KEYS);
  assert.equal(registry.preparation.maxCachedProfiles, 8);
  assert.equal(registry.has('cast-0'), true);
  assert.equal(registry.has('unavailable'), false);
  assert.equal(registry.status('unavailable'), 'unavailable');
  assert.equal(registry.status('unprepared'), 'unprepared');
  assert.equal(registry.status('missing'), 'missing');
  assert.equal(registry.has('toString'), false);
});

test('empty/unprepared installation is explicitly remote and never borrows a legacy voice', () => {
  assert.equal(createVoiceProfileRegistry().keys.length, 0);
  const registry = createVoiceProfileRegistry({version: 2, provider: 'hybrid', engine: 'omnivoice',
    voices: {alex: {status: 'unprepared'}, 'blue-moon': {status: 'unavailable'}}});
  assert.equal(registry.keys.length, 0);
  assert.equal(registry.has('judy-alvarez'), false);
  assert.equal(registry.has('alex'), false);
});

test('unsafe paths, incorrect hashes and malformed speaker/transcript mappings cannot select local speech', () => {
  for (const invalid of [null, [], {status: 'unknown'}, {reference: 'missing'},
    {...reference('alex'), reference: '../alex.wav'},
    {...reference('alex'), reference: 'runtime/voice-references/../alex.wav'},
    {...reference('alex'), reference: 'runtime\\voice-references\\alex.wav'},
    {...reference('alex'), reference: 'runtime/voice-references/x:y.wav'},
    {...reference('alex'), reference: 'runtime/voice-references/./alex.wav'},
    {...reference('alex'), reference: 'runtime/voice-references//alex.wav'},
    {...reference('alex'), sha256: 'A'.repeat(64)},
    {...reference('alex'), sha256: 'a'.repeat(63)},
    {...reference('alex'), transcript: '   '},
    {...reference('alex'), transcript: 'Hi\0V'},
    {...reference('alex'), transcript: 'x'.repeat(VOICE_PROFILE_LIMITS.transcript + 1)}]) {
    assert.throws(() => createVoiceProfileRegistry({version: 2, provider: 'hybrid', engine: 'omnivoice', voices: {alex: invalid}}), /Invalid/);
  }
  for (const key of ['constructor', '../alex', 'Alex', 'x'.repeat(81)]) {
    assert.throws(() => createVoiceProfileRegistry(config([key])), /Invalid/);
  }
});

test('warmup policies are explicit, bounded, refer to configured profiles and cannot exceed the prompt cache', () => {
  const input = config([...LEGACY_LOCAL_VOICE_KEYS, 'alex']);
  for (const preparation of [null, {mode: 'eager'}, {mode: 'unknown'},
    {mode: 'lazy', startupProfiles: ['not-configured']},
    {mode: 'lazy', startupProfiles: ['alex', 'alex']},
    {mode: 'lazy', startupProfiles: [...LEGACY_LOCAL_VOICE_KEYS, 'alex']},
    {mode: 'lazy', maxCachedProfiles: 9}, {mode: 'lazy', maxCachedProfiles: 0},
    {mode: 'lazy', startupProfiles: LEGACY_LOCAL_VOICE_KEYS, maxCachedProfiles: 2}]) {
    assert.throws(() => createVoiceProfileRegistry({...input, preparation}), /Invalid/);
  }
  const registry = createVoiceProfileRegistry({...input,
    preparation: {mode: 'lazy', startupProfiles: ['alex'], maxCachedProfiles: 3}});
  assert.deepEqual(registry.preparation, {mode: 'lazy', startupProfiles: ['alex'], maxCachedProfiles: 3});
});

test('new cast uses explicit version 2 and wider registries stay lazy even when only baseline references are ready', () => {
  for (const keys of [['alex'], [...LEGACY_LOCAL_VOICE_KEYS, 'alex'], ['judy-alvarez']]) {
    for (const version of [undefined, 1]) {
      assert.throws(() => createVoiceProfileRegistry({...config(keys), version}), /require configuration version 2/);
    }
  }
  const input = {...config(LEGACY_LOCAL_VOICE_KEYS), voices: {...config(LEGACY_LOCAL_VOICE_KEYS).voices,
    alex: {status: 'unprepared'}}};
  const registry = createVoiceProfileRegistry(input);
  assert.equal(registry.preparation.mode, 'lazy');
  assert.deepEqual(registry.preparation.startupProfiles, LEGACY_LOCAL_VOICE_KEYS);
});
