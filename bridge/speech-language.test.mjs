// Which language the microphone expects and which engine hears it (bridge/speech-language.mjs). Pure logic: no network, no model.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {baseLanguage, packFor, packThatHears, planRecording, SpeechLanguage, LOCAL_PACKS, MOD_LANGUAGES, VOXTRAL_LANGUAGES} from './speech-language.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('language codes reduce to the base language the engines use', () => {
  assert.equal(baseLanguage('pt-br'), 'pt');
  assert.equal(baseLanguage('ZH_CN'), 'zh');
  assert.equal(baseLanguage('zh-tw'), 'zh');
  assert.equal(baseLanguage('Russian'), 'ru');
  assert.equal(baseLanguage('ru'), 'ru');
  assert.equal(baseLanguage('cz-cz'), 'cs');
  assert.equal(baseLanguage('ua-ua'), 'uk');
  assert.equal(baseLanguage(''), null);
  assert.equal(baseLanguage(42), null);
  assert.equal(baseLanguage('x'.repeat(60)), null);
});

test('every interface language of the mod has an engine route: Voxtral, a pack, or neither (and which)', () => {
  const dictionaries = readdirSync(resolve(here, '../mod/locales')).filter(name => name.endsWith('.lua')).map(name => baseLanguage(name.replace(/\.lua$/, '')));
  for (const language of new Set(dictionaries)) assert.ok(MOD_LANGUAGES.includes(language), `${language} is a language of the mod`);
  const everything = new Set(['en', ...LOCAL_PACKS.flatMap(pack => pack.languages), ...VOXTRAL_LANGUAGES]);
  const none = MOD_LANGUAGES.filter(language => !everything.has(language));
  // Turkish is the only one of the mod's languages that neither Mistral's list nor the two packs name: Mistral is still asked, with no hint.
  assert.deepEqual(none, ['tr']);
});

test('English and unknown languages keep the English recogniser with no note', () => {
  for (const language of ['en', '', undefined, null]) {
    const plan = planRecording({language, provider: 'mistral', voxtralReady: true, installed: LOCAL_PACKS.map(pack => pack.id)});
    assert.equal(plan.mode, 'english'); assert.equal(plan.note, undefined);
  }
});

test('Mistral route, another language: Mistral transcription, the hint only from the player\'s own text or voice, packs then English as fallback', () => {
  const ready = {provider: 'mistral', voxtralReady: true, installed: ['parakeet-tdt-0.6b-v3-int8'], englishAvailable: true};
  const fromText = planRecording({...ready, language: 'ru', source: 'text'});
  assert.equal(fromText.mode, 'voxtral'); assert.equal(fromText.hint, 'ru');
  assert.deepEqual(fromText.fallback.map(next => next.mode), ['pack', 'english']);
  assert.equal(fromText.fallback[0].pack.id, 'parakeet-tdt-0.6b-v3-int8');
  assert.equal(planRecording({...ready, language: 'ru', source: 'voice'}).hint, 'ru');
  // The interface language alone can be wrong (an English speaker with a Russian game): no hint, Mistral detects the language.
  assert.equal(planRecording({...ready, language: 'ru', source: 'ui'}).hint, null);
  // Polish is not on Mistral's list: asked without a hint even from the player's text.
  const polish = planRecording({...ready, language: 'pl', source: 'text'});
  assert.equal(polish.mode, 'voxtral'); assert.equal(polish.hint, null);
  // No pack installed and no English recogniser: nothing to fall back to.
  assert.deepEqual(planRecording({...ready, language: 'ru', installed: [], englishAvailable: false}).fallback, []);
});

test('Mistral cooling down (a limit, a refused key, no plan): a pack hears it, else English with the one-time note', () => {
  const cooling = {provider: 'mistral', voxtralReady: false, language: 'de', source: 'text'};
  assert.deepEqual([planRecording({...cooling, installed: ['parakeet-tdt-0.6b-v3-int8']}).mode, planRecording({...cooling, installed: ['parakeet-tdt-0.6b-v3-int8']}).pack.id], ['pack', 'parakeet-tdt-0.6b-v3-int8']);
  const bare = planRecording({...cooling, installed: []});
  assert.equal(bare.mode, 'english'); assert.equal(bare.note, 'pack-available', 'a pack that hears German exists, it is not installed: the notice names it');
  const none = planRecording({...cooling, language: 'tr', installed: []});
  assert.equal(none.mode, 'english'); assert.equal(none.note, 'english-only', 'no pack hears Turkish');
});

test('Local AI, custom and add-on routes never send audio to Mistral, even with a working key', () => {
  for (const provider of ['local', 'custom', 'convai']) {
    const bare = planRecording({provider, voxtralReady: true, language: 'ru', source: 'text', installed: []});
    assert.equal(bare.mode, 'english'); assert.equal(bare.note, 'pack-available', provider);
    // Japanese and Korean: the Asian pack's model does not read them (measured), so nothing hears them and the plain notice is right.
    for (const language of ['ja', 'ko', 'tr']) assert.equal(planRecording({provider, language, source: 'text', installed: ['sense-voice-int8', 'parakeet-tdt-0.6b-v3-int8']}).note, 'english-only', language + ' ' + provider);
    assert.equal(planRecording({provider, language: 'zh', source: 'text', installed: []}).note, 'pack-available');
    const withPack = planRecording({provider, voxtralReady: true, language: 'ru', source: 'text', installed: ['parakeet-tdt-0.6b-v3-int8']});
    assert.equal(withPack.mode, 'pack', provider);
  }
});

test('each pack hears only its languages', () => {
  const both = LOCAL_PACKS.map(pack => pack.id);
  for (const language of ['ru', 'uk', 'pl', 'cs', 'hu', 'de', 'fr', 'es', 'it', 'pt']) assert.equal(packFor(language, both).id, 'parakeet-tdt-0.6b-v3-int8', language);
  assert.equal(packFor('zh', both).id, 'sense-voice-int8');
  // The sherpa-onnx 2025-09-09 SenseVoice archive is a Cantonese fine-tune: Mandarin reads well, Japanese (84% character error) and Korean (96%) do not.
  for (const language of ['ja', 'ko']) assert.equal(packFor(language, both), null, language);
  assert.equal(packThatHears('zh').id, 'sense-voice-int8'); assert.equal(packThatHears('ru').id, 'parakeet-tdt-0.6b-v3-int8'); assert.equal(packThatHears('ja'), null);
  assert.equal(packFor('tr', both), null);
  assert.equal(packFor('ru', ['sense-voice-int8']), null, 'a pack that is not installed hears nothing');
  assert.equal(packFor('ru', new Set(['parakeet-tdt-0.6b-v3-int8'])).kind, 'nemo-transducer');
});

test('the language comes from the player\'s text or voice first, then the interface setting, then the game\'s language file, then English', async () => {
  let file = 'ru\n', reads = 0, clock = 1000;
  const language = new SpeechLanguage({readUiFile: async () => { reads++; return file; }, now: () => clock});
  assert.deepEqual(await language.current(), {language: 'ru', source: 'ui'}, 'the game language written by the mod');
  clock += 1000; await language.current();
  assert.equal(reads, 1, 'the file is not read again within a few seconds');
  clock += 10_000; file = 'de'; assert.deepEqual(await language.current(), {language: 'de', source: 'ui'});
  language.update({uiLanguage: 'ja'});
  assert.deepEqual(await language.current(), {language: 'ja', source: 'ui'}, 'an explicit interface language wins over the file');
  language.update({uiLanguage: 'pt-br'});
  assert.deepEqual(await language.current(), {language: 'pt', source: 'ui'});
  language.update({uiLanguage: 'auto'});
  // Typed Russian is evidence even when the interface says German.
  assert.equal(language.observeText('Привет, как дела? Расскажи мне про Ночной город.'), true);
  assert.deepEqual(await language.current(), {language: 'ru', source: 'text'});
  // Typed English moves it back: an English speaker with a Russian game gets the English recogniser.
  assert.equal(language.observeText('Hey, what do you think about the job we did last night?'), true);
  assert.deepEqual(await language.current(), {language: 'en', source: 'text'});
  // A line that says nothing changes nothing.
  assert.equal(language.observeText('ok'), false); assert.equal(language.observeText(''), false); assert.equal(language.observeText(null), false);
  assert.deepEqual(await language.current(), {language: 'en', source: 'text'});
  // What Mistral reports for a recording is evidence too.
  assert.equal(language.observeVoice('ru'), true);
  assert.equal(language.observeVoice('ru'), false);
  assert.deepEqual(await language.current(), {language: 'ru', source: 'voice'});
  assert.equal(language.observeVoice('nonsense value that is not a code'), false);
});

test('no file, no setting, no evidence: English by default; an unreadable file is English too', async () => {
  assert.deepEqual(await new SpeechLanguage().current(), {language: 'en', source: 'default'});
  const broken = new SpeechLanguage({readUiFile: async () => { throw Error('gone'); }});
  assert.deepEqual(await broken.current(), {language: 'en', source: 'default'});
  const unsupported = new SpeechLanguage({readUiFile: async () => 'ar'});
  assert.deepEqual(await unsupported.current(), {language: 'en', source: 'ui'}, 'a game language the mod does not support is English');
});
