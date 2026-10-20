// Which language the microphone expects and which engine hears it (bridge/speech-language.mjs). Pure logic: no network, no model.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {baseLanguage, packFor, packThatHears, planRecording, SpeechLanguage, LOCAL_PACKS, MOD_LANGUAGES, VOXTRAL_LANGUAGES,
  PLAYER_LANGUAGE_FILE, parsePlayerLanguage, playerLanguageText} from './speech-language.mjs';

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
  // Voxtral Mini Transcribe 3 names every language the mod has (Transcribe 2 left out Polish, Ukrainian, Czech, Hungarian and Turkish).
  assert.deepEqual(none, []);
  assert.deepEqual(MOD_LANGUAGES.filter(language => !VOXTRAL_LANGUAGES.includes(language)), []);
  assert.equal(VOXTRAL_LANGUAGES.length, 44, 'the 45 languages of the announcement\'s benchmark, without Filipino (its code is not confirmed)');
  assert.equal(new Set(VOXTRAL_LANGUAGES).size, VOXTRAL_LANGUAGES.length);
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
  // Polish is on Transcribe 3's list (it was not on Transcribe 2's): hinted from the player's text. A language Mistral does not name (Hebrew) is asked without a hint.
  const polish = planRecording({...ready, language: 'pl', source: 'text'});
  assert.equal(polish.mode, 'voxtral'); assert.equal(polish.hint, 'pl');
  const hebrew = planRecording({...ready, language: 'he', source: 'text'});
  assert.equal(hebrew.mode, 'voxtral'); assert.equal(hebrew.hint, null);
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
    // Turkish: no pack hears it, so the plain notice is right. Japanese and Korean are heard by the Asian pack, so without it the notice names the pack.
    assert.equal(planRecording({provider, language: 'tr', source: 'text', installed: ['sense-voice-int8', 'parakeet-tdt-0.6b-v3-int8']}).note, 'english-only', 'tr ' + provider);
    for (const language of ['ja', 'ko']) {
      assert.equal(planRecording({provider, language, source: 'text', installed: []}).note, 'pack-available', language + ' ' + provider);
      assert.equal(planRecording({provider, language, source: 'text', installed: ['sense-voice-int8']}).mode, 'pack', language + ' ' + provider);
    }
    assert.equal(planRecording({provider, language: 'zh', source: 'text', installed: []}).note, 'pack-available');
    const withPack = planRecording({provider, voxtralReady: true, language: 'ru', source: 'text', installed: ['parakeet-tdt-0.6b-v3-int8']});
    assert.equal(withPack.mode, 'pack', provider);
  }
});

test('each pack hears only its languages', () => {
  const both = LOCAL_PACKS.map(pack => pack.id);
  for (const language of ['ru', 'uk', 'pl', 'cs', 'hu', 'de', 'fr', 'es', 'it', 'pt']) assert.equal(packFor(language, both).id, 'parakeet-tdt-0.6b-v3-int8', language);
  assert.equal(packFor('zh', both).id, 'sense-voice-int8');
  // The original SenseVoice Small (2024-07-17 archive) reads all three; the 2025-09-09 Cantonese fine-tune read only Mandarin and is not used.
  for (const language of ['ja', 'ko']) assert.equal(packFor(language, both).id, 'sense-voice-int8', language);
  assert.equal(packThatHears('zh').id, 'sense-voice-int8'); assert.equal(packThatHears('ja').id, 'sense-voice-int8'); assert.equal(packThatHears('ru').id, 'parakeet-tdt-0.6b-v3-int8'); assert.equal(packThatHears('tr'), null);
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

// ---- The player's language between launches (player-language.json in the state folder) ---------------------------------------

test('the remembered language is the first evidence at start: a French player with an English game gets the French route from the first recording', async () => {
  const language = new SpeechLanguage({readUiFile: async () => 'en', remembered: parsePlayerLanguage(playerLanguageText('fr'))});
  assert.deepEqual(await language.current(), {language: 'fr', source: 'saved'});
  const plan = planRecording({...(await language.current()), provider: 'local', installed: ['parakeet-tdt-0.6b-v3-int8']});
  assert.equal(plan.mode, 'pack');
  assert.equal(plan.pack.id, 'parakeet-tdt-0.6b-v3-int8');
  // Without the memory the same player starts in English (the bug).
  assert.deepEqual(await new SpeechLanguage({readUiFile: async () => 'en'}).current(), {language: 'en', source: 'ui'});
  // The saved language counts as the player's own: Mistral's transcription gets it as a hint.
  assert.equal(planRecording({language: 'fr', source: 'saved', provider: 'mistral', voxtralReady: true}).hint, 'fr');
});

test('the language is written only when it changes, with no wait: the first text, a different language, English; never the same one twice', () => {
  const written = [];
  const language = new SpeechLanguage({remembered: 'fr', remember: code => written.push(code)});
  assert.equal(language.observeText("Salut, ça va? Qu'est-ce que tu fais ce soir?"), false, 'French again: nothing changed, nothing written');
  assert.equal(language.observeVoice('French'), false);
  assert.deepEqual(written, []);
  assert.equal(language.observeText('Hallo, wie geht es dir heute Abend?'), true);
  assert.equal(language.observeVoice('de'), false);
  assert.equal(language.observeText('What do you need, choom?'), true, 'English evidence overwrites it');
  assert.equal(language.observeText('Not clear: ok'), false, 'a line with no clear language changes nothing');
  assert.deepEqual(written, ['de', 'en']);
  // A writer that throws never breaks the conversation.
  const broken = new SpeechLanguage({remember: () => { throw Error('disk full'); }});
  assert.equal(broken.observeText('Hallo, wie geht es dir heute Abend?'), true);
  assert.equal(broken.evidence.language, 'de');
});

test('the saved file is read only when it is valid: anything else is ignored', async () => {
  assert.equal(parsePlayerLanguage(playerLanguageText('pt')), 'pt');
  for (const raw of ['', 'not json', '[]', 'null', '{}', '{"version":2,"language":"fr"}', '{"version":1,"language":"french"}', '{"version":1,"language":42}',
    '{"version":1,"language":"F R"}', undefined, 7, 'x'.repeat(500)]) assert.equal(parsePlayerLanguage(raw), null, String(raw).slice(0, 30));
  assert.equal(parsePlayerLanguage('﻿' + playerLanguageText('ru')), 'ru', 'a byte-order mark from a hand edit is dropped');
  // An invalid file leaves the start exactly as before: the interface language, else English.
  assert.deepEqual(await new SpeechLanguage({remembered: parsePlayerLanguage('garbage')}).current(), {language: 'en', source: 'default'});
  assert.equal(PLAYER_LANGUAGE_FILE, 'player-language.json');
});

test('the bridge reads the file once at start and writes it in the background', () => {
  const bridge = readFileSync(resolve(here, 'convai-bridge.mjs'), 'utf8');
  assert.match(bridge, /remembered: parsePlayerLanguage\(await readFile\(playerLanguageFile, 'utf8'\)\.catch\(\(\) => ''\)\)/);
  assert.match(bridge, /remember: language => \{ void atomic\(playerLanguageFile, playerLanguageText\(language\)\)\.catch\(\(\) => \{\}\); \}/);
  assert.match(bridge, /const playerLanguageFile = resolve\(stateDirectory, PLAYER_LANGUAGE_FILE\);/);
});
