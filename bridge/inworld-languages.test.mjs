import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {INWORLD_LANGUAGES, INWORLD_TIER1_LANGUAGES, INWORLD_TIER2_LANGUAGES, inworldCode, inworldRequestLanguage, inworldSpeaks} from './inworld-languages.mjs';
import {voxtralSpeaks} from './voxtral-languages.mjs';
import {MOD_LANGUAGES} from './speech-language.mjs';
import {REPLY_LANGUAGES, LANGUAGE_NAMES} from './multilingual.mjs';

// Inworld's multilingual page (docs.inworld.ai/tts/capabilities/multilingual, 2026-10-31): 15 Tier 1 and 79 Tier 2 languages for TTS-2 and TTS-2 Flash.
test('the list is the Tier 1 and Tier 2 of the Inworld docs, without repeats', () => {
  assert.equal(INWORLD_TIER1_LANGUAGES.length, 15); assert.equal(INWORLD_TIER2_LANGUAGES.length, 79);
  assert.equal(INWORLD_LANGUAGES.length, 94); assert.equal(new Set(INWORLD_LANGUAGES).size, 94);
  assert.ok(Object.isFrozen(INWORLD_LANGUAGES));
});

test('every language of the mod (interface languages and the Reply language choices) is spoken by Inworld, with the code the docs list', () => {
  for (const language of MOD_LANGUAGES) assert.equal(inworldSpeaks(language), true, language);
  for (const language of REPLY_LANGUAGES.filter(code => code !== 'auto')) assert.equal(inworldSpeaks(language), true, language);
  for (const language of MOD_LANGUAGES.filter(code => code !== 'en')) assert.equal(inworldRequestLanguage(language), language, language);
  // Every language the reply-language detector can name is spoken too.
  for (const language of Object.keys(LANGUAGE_NAMES)) assert.equal(inworldSpeaks(language), true, language);
});

test('English and an empty language are spoken and send no language field; Norwegian is Bokmal; Tier 3 and unknown codes are not spoken', () => {
  for (const language of ['en', '', null, undefined]) { assert.equal(inworldSpeaks(language), true); assert.equal(inworldRequestLanguage(language), null); }
  assert.equal(inworldRequestLanguage('no'), 'nb'); assert.equal(inworldCode('no'), 'nb');
  assert.equal(inworldRequestLanguage('ru'), 'ru'); assert.equal(inworldRequestLanguage('zh'), 'zh'); assert.equal(inworldRequestLanguage('he'), 'he');
  for (const language of ['eo', 'la', 'haw', 'xx', 'ru-RU', 'RU', '__proto__', 7]) {
    assert.equal(inworldSpeaks(language), false, String(language)); assert.equal(inworldRequestLanguage(language), null, String(language));
  }
});

test('Inworld speaks every detector language Voxtral does not (Hebrew)', () => {
  assert.equal(voxtralSpeaks('he'), false); assert.equal(inworldSpeaks('he'), true);
  for (const language of Object.keys(LANGUAGE_NAMES).filter(code => !voxtralSpeaks(code))) assert.equal(inworldSpeaks(language), true, language);
});

test('the routing reaches the voice: the bridge picks the speaking voice by the chosen cloud, and the Inworld voice puts the language in its request', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /speaks: language => \(localVoice\.cloud === 'inworld' \? inworldVoice : voxtralVoice\)\.speaks\(language\)/);
  const voice = readFileSync(new URL('./inworld-voice.mjs', import.meta.url), 'utf8');
  assert.match(voice, /inworldRequestLanguage\(language\)/);
  assert.match(voice, /\.\.\.\(tag \? \{language: tag\} : \{\}\)/);
});
