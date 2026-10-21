// A settings file saved while the Inworld cloud voice existed still says `voiceProvider: 'inworld'`. The voice is gone: every slot that
// read it resolves to its own default voice (Pocket for the companions and for V), with no error and no cloud voice chosen.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {VoiceSelection, canonicalVoiceProvider, cloudVoiceChoice, CLOUD_VOICES} from './voice-selection.mjs';
import {VVoice, V_ENGINES} from './v-voice.mjs';
import {neededServices} from './setup-check.mjs';

const REMOVED = 'inworld';

test('the companions\' voice selector reads the removed value as Pocket and chooses no cloud voice', () => {
  assert.equal(canonicalVoiceProvider(REMOVED), 'pocket');
  assert.equal(cloudVoiceChoice(REMOVED), null);
  assert.deepEqual([...CLOUD_VOICES], ['voxtral']);
  const voice = new VoiceSelection({}, {});
  voice.request({voiceProvider: 'convai'});
  assert.equal(voice.requestedProvider, 'convai');
  assert.doesNotThrow(() => voice.request({voiceProvider: REMOVED}));
  assert.equal(voice.requestedProvider, 'pocket', 'the default voice');
  assert.equal(voice.requestedCloud, null);
  assert.equal(voice.cloudWanted, false);
  // From a chosen Voxtral voice the cloud choice is dropped too.
  voice.request({voiceProvider: 'voxtral'});
  assert.equal(voice.requestedCloud, 'voxtral');
  voice.request({voiceProvider: REMOVED});
  assert.equal(voice.requestedCloud, null);
  assert.equal(voice.requestedProvider, 'pocket');
  // Reading it again is the same answer (nothing is stuck waiting).
  voice.request({voiceProvider: REMOVED});
  assert.equal(voice.requestedProvider, 'pocket');
  // A Settings preview of it is Pocket's.
  assert.equal(voice.setPreview({provider: REMOVED}), true);
  assert.equal(voice.preview.provider, 'pocket');
});

test('V\'s voice engine reads the removed value as Pocket', () => {
  const voice = new VVoice({voices: {male: {key: 'v-male'}}});
  assert.deepEqual(V_ENGINES, ['pocket', 'voxtral', 'omni']);
  voice.update({vVoiceEngine: 'voxtral'});
  assert.equal(voice.engine, 'voxtral');
  assert.doesNotThrow(() => voice.update({vVoiceEngine: REMOVED}));
  assert.equal(voice.engine, 'pocket');
  assert.equal(voice.update({vVoiceEngine: REMOVED}), false, 'nothing changes the second time');
});

test('the setup check names no service for the removed value', () => {
  assert.deepEqual(neededServices({voiceProvider: REMOVED}), ['convai']);
  assert.deepEqual(neededServices({conversationProvider: 'mistral', voiceProvider: REMOVED}), ['mistral']);
});
