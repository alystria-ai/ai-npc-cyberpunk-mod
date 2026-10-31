import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {SUBTITLE_LANGUAGES, SUBTITLE_SAME, SubtitleTranslations, cleanTranslation, sameReply, subtitleLanguageFrom, translationMessages,
  MAX_ENTRIES, ENTRY_TTL_MS, WRITTEN_WAIT_MS, LOCAL_WRITTEN_WAIT_MS} from './subtitle-translation.mjs';
import {OTHER_LANGUAGES, OTHER_LANGUAGE_CODES, isExtraLanguage, otherLanguageFrom, otherLanguageName, otherLanguageVoice, pocketRefusal} from './other-languages.mjs';
import {LANGUAGE_NAMES, MultilingualConversations, REPLY_LANGUAGES, fixedLanguageContext, planTurnVoice, replyLanguageFrom, replyVoice,
  textProviderLanguageContext} from './multilingual.mjs';
import {MOD_LANGUAGES, SpeechLanguage, planRecording} from './speech-language.mjs';
import {VOXTRAL_TTS3_LANGUAGES, voxtralSpeaks} from './voxtral-languages.mjs';
import {ConvaiContinuousSpeech} from './convai-continuous-speech.mjs';
import {TextProviderHost, attachTextProvider, mistralRoute} from './text-provider-host.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {PhoneChat} from './phone-chat.mjs';
import {VoxtralVoice} from './voxtral-voice.mjs';
import {createVoiceProfileRegistry} from './voice-profile-registry.mjs';
import {MistralScheduler} from './mistral-rate.mjs';
import {VoiceSelection} from './voice-selection.mjs';
import {LOCAL_VOICE_KEYS} from './resident-voice.mjs';

// ---- helpers --------------------------------------------------------------------------------------------------------------------

const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const tick = () => new Promise(done => setImmediate(done));
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const luaList = (source, name) => [...source.match(new RegExp(`local ${name} = \\{([^}]*)\\}`))[1].matchAll(/'([a-z-]+)'/g)].map(match => match[1]);

// ---- A. The settings and their lists --------------------------------------------------------------------------------------------

test('Subtitle language: Same as speech is the default, an unknown or missing value reads as the default, and a language is the target', () => {
  assert.deepEqual(subtitleLanguageFrom({}), {setting: 'same', target: null});
  assert.deepEqual(subtitleLanguageFrom(undefined), {setting: 'same', target: null});
  assert.deepEqual(subtitleLanguageFrom({subtitleLanguage: 'klingon'}), {setting: 'same', target: null});
  assert.deepEqual(subtitleLanguageFrom({subtitleLanguage: 7}), {setting: 'same', target: null});
  assert.deepEqual(subtitleLanguageFrom({subtitleLanguage: 'ru'}), {setting: 'ru', target: 'ru'});
  assert.deepEqual(subtitleLanguageFrom({subtitleLanguage: 'fi'}), {setting: 'fi', target: 'fi'});
  assert.deepEqual(subtitleLanguageFrom({subtitleLanguage: 'same'}), {setting: 'same', target: null});
  assert.equal(SUBTITLE_LANGUAGES[0], SUBTITLE_SAME);
  assert.equal(new Set(SUBTITLE_LANGUAGES).size, SUBTITLE_LANGUAGES.length);
});

test('the lists in the game (mod/manager.lua) are the bridge\'s lists, in the same order', () => {
  const lua = read('../mod/manager.lua');
  assert.deepEqual(luaList(lua, 'otherLanguages'), [...OTHER_LANGUAGE_CODES]);
  const start = luaList(lua, 'subtitleLanguages');
  assert.deepEqual([...start, ...luaList(lua, 'otherLanguages')], [...SUBTITLE_LANGUAGES], 'the Lua list is the head, then the Other languages appended by the loop');
  assert.match(lua, /for _, code in ipairs\(otherLanguages\) do subtitleLanguages\[#subtitleLanguages \+ 1\] = code end/);
  assert.deepEqual(luaList(lua, 'replyLanguages'), [...REPLY_LANGUAGES]);
  const ui = read('../mod/manager-ui.lua');
  for (const code of [...SUBTITLE_LANGUAGES, ...REPLY_LANGUAGES]) assert.match(ui, new RegExp(`\\b${code} = '[A-Z][a-z]+(?: [a-z]+)*'`), `${code} has a name`);
  for (const {code, name} of OTHER_LANGUAGES) assert.match(ui, new RegExp(`\\b${code} = '${name}'`), `${code} is called ${name}`);
});

test('the Other languages: the list the Finnish player asked for, none that the Voice language row already has', () => {
  const names = OTHER_LANGUAGES.map(item => item.name);
  for (const wanted of ['Finnish', 'Swedish', 'Norwegian', 'Danish', 'Dutch', 'Greek', 'Romanian', 'Bulgarian', 'Croatian', 'Serbian', 'Slovak', 'Slovenian',
    'Estonian', 'Latvian', 'Lithuanian', 'Hindi', 'Indonesian', 'Vietnamese', 'Hebrew']) assert.ok(names.includes(wanted), wanted);
  // Czech, Hungarian and Ukrainian are on the Voice language row already.
  for (const code of OTHER_LANGUAGE_CODES) assert.ok(!MOD_LANGUAGES.includes(code), `${code} is a Voice language already`);
  assert.equal(new Set(OTHER_LANGUAGE_CODES).size, OTHER_LANGUAGE_CODES.length);
  // The prompt names every one of them.
  for (const {code, name} of OTHER_LANGUAGES) assert.equal(LANGUAGE_NAMES[code], name);
  assert.equal(otherLanguageName('fi'), 'Finnish');
  assert.equal(otherLanguageName('xx'), null);
  assert.equal(otherLanguageFrom('sv'), 'sv');
  assert.equal(otherLanguageFrom('klingon'), 'fi');
  assert.equal(otherLanguageFrom(undefined), 'fi');
  assert.equal(isExtraLanguage('fi'), true);
  assert.equal(isExtraLanguage('fr'), false);
  assert.equal(isExtraLanguage('en'), false);
});

test('every current language works exactly as it did: the Voice language row, its codes and what each makes of the settings', () => {
  assert.deepEqual(REPLY_LANGUAGES.slice(0, 2), ['en', 'auto']);
  for (const code of MOD_LANGUAGES.filter(value => value !== 'en')) assert.ok(REPLY_LANGUAGES.includes(code), code);
  assert.deepEqual(replyLanguageFrom({}), {setting: 'en', fixed: 'en'});
  assert.deepEqual(replyLanguageFrom({replyLanguage: 'auto'}), {setting: 'auto', fixed: null});
  for (const code of MOD_LANGUAGES) {
    assert.deepEqual(replyLanguageFrom({replyLanguage: code, voice: true, replyLanguageOther: 'sv'}), {setting: code, fixed: code}, code);
    assert.deepEqual(replyLanguageFrom({replyLanguage: code, voice: false}), {setting: code, fixed: null}, code);
    // A text provider or Convai makes no difference to the game's own languages.
    assert.deepEqual(replyLanguageFrom({replyLanguage: code}, {textProvider: null}), {setting: code, fixed: code}, `${code} with Convai answering`);
  }
  // Their prompt and their voice plan are the ones they always had.
  assert.match(fixedLanguageContext('fr'), /write the whole reply in French, whatever language the player's message is in/);
  assert.equal(textProviderLanguageContext({fixed: 'en'}), '');
  const pocket = {uses: true, provider: 'pocket', pocket: {speaks: () => false, packMissing: () => false}};
  assert.deepEqual(planTurnVoice({textProvider: true, fixed: true, language: 'fr', local: pocket}),
    {engine: 'pocket', language: 'fr', reason: 'english-only-voice', textProvider: true, fixed: true});
});

// ---- B. Other language: the setting, the prompt, the voice, the refusal ----------------------------------------------------------

test('Other language: the saved language is the fixed one, Finnish when none is saved; it needs a text provider and counts only with Voice playback on', () => {
  assert.deepEqual(replyLanguageFrom({replyLanguage: 'other'}), {setting: 'other', fixed: 'fi'});
  assert.deepEqual(replyLanguageFrom({replyLanguage: 'other', replyLanguageOther: 'sv'}), {setting: 'other', fixed: 'sv'});
  assert.deepEqual(replyLanguageFrom({replyLanguage: 'other', replyLanguageOther: 'klingon'}), {setting: 'other', fixed: 'fi'}, 'an unknown value reads as Finnish, never as English');
  for (const textProvider of ['mistral', 'gemini', 'custom', 'local']) {
    assert.equal(replyLanguageFrom({replyLanguage: 'other', replyLanguageOther: 'et'}, {textProvider}).fixed, 'et', textProvider);
  }
  const convai = replyLanguageFrom({replyLanguage: 'other', replyLanguageOther: 'fi'}, {textProvider: null});
  assert.deepEqual(convai, {setting: 'other', fixed: null, note: 'other-needs-text-provider'}, 'Convai cannot be told the language: not applied, and the bridge says why');
  assert.deepEqual(replyLanguageFrom({replyLanguage: 'other', replyLanguageOther: 'fi', voice: false}), {setting: 'other', fixed: null});
});

test('Other language reaches the prompt: the reply is told to be written in Finnish, by name, whatever the player writes', () => {
  const conversation = new MultilingualConversations();
  assert.equal(conversation.setFixed('fi'), true);
  for (const text of ['hows biz', '[Microphone]', 'Mitä kuuluu, Judy?', '']) {
    assert.match(conversation.contextFor(text), /Language: write the whole reply in Finnish, whatever language the player's message is in\./, text);
    assert.doesNotMatch(conversation.contextFor(text), /that language/);
    assert.equal(conversation.expected(text), 'fi', text);
  }
  assert.match(fixedLanguageContext('he'), /in Hebrew,/);
  assert.match(fixedLanguageContext('sr'), /in Serbian,/);
  // V's typed line is spoken in that language too (V's voice), and English lines stay English.
  assert.equal(conversation.lineLanguage('Hey Judy, how are you tonight'), 'en');
  // The prompt is the same one the cloud text providers get for the game's own languages: one extra line, nothing about the voice.
  assert.equal(textProviderLanguageContext({fixed: 'fi'}), fixedLanguageContext('fi'));
});

test('Other language on Voxtral: the voice plan speaks it with the cloud voice, the finished reply keeps the language, the request carries the Finnish text', async () => {
  const voxtral = {uses: true, provider: 'pocket', cloud: 'voxtral', speaks: language => voxtralSpeaks(language), pocket: {speaks: () => false, packMissing: () => false}};
  const plan = planTurnVoice({textProvider: true, fixed: true, language: 'fi', local: voxtral});
  assert.deepEqual(plan, {engine: 'pocket', language: 'fi', reason: 'voxtral', textProvider: true, fixed: true});
  // A fixed language is not re-detected from the reply (the word lists do not know Finnish): the plan stands.
  assert.deepEqual(replyVoice({plan, text: 'Hei V, mitä kuuluu tänään? Minulla on sinulle uutisia.', local: voxtral}), {engine: 'pocket', language: 'fi'});
  assert.deepEqual(replyVoice({plan, text: 'Short.', local: voxtral}), {engine: 'pocket', language: 'fi'});
  assert.deepEqual(otherLanguageVoice(voxtral, 'fi'), {ok: true, why: null});
  // The request: Mistral's API has no language field, the model speaks the text; the voice is asked with the code so the right reference clip is picked (English when no pack).
  const text = 'Hei V, mitä kuuluu tänään? Minulla on sinulle uutisia.';
  const requests = [];
  const server = await new Promise(done => {
    const instance = createServer((request, response) => {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(200, {'content-type': 'text/event-stream'});
        const pcm = Buffer.from(new Float32Array(2400).fill(0.1).buffer);
        response.write(`event: speech.audio.delta\ndata: ${JSON.stringify({type: 'speech.audio.delta', audio_data: pcm.toString('base64')})}\n\n`);
        response.end(`event: speech.audio.done\ndata: ${JSON.stringify({type: 'speech.audio.done', usage: {}})}\n\n`);
      });
    });
    instance.listen(0, '127.0.0.1', () => done(instance));
  });
  try {
    const reference = (() => { // a small 24 kHz mono WAV
      const frames = 48000, bytes = Buffer.alloc(44 + frames * 2);
      bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
      bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
      bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
      for (let at = 0; at < frames; at++) bytes.writeInt16LE((at % 200) * 10 - 1000, 44 + at * 2);
      return bytes;
    })();
    const registry = createVoiceProfileRegistry({version: 2, provider: 'hybrid', engine: 'omnivoice',
      voices: {'judy-alvarez': {reference: 'runtime/voice-references/judy-alvarez.wav', sha256: createHash('sha256').update(reference).digest('hex'), transcript: 'Ready when you are, V.'}}});
    const voice = new VoxtralVoice({getKey: () => 'k'.repeat(8) + 'Secret0123456789abcdefghijkl', referenceRoot: resolve('fixture-references'), registry,
      endpoint: `http://127.0.0.1:${server.address().port}/v1/audio/speech`, read: async () => reference, scheduler: new MistralScheduler({spacingMs: 0})});
    assert.equal(voice.speaks('fi'), true);
    for (const code of ['sv', 'no', 'da', 'nl', 'el', 'ro', 'bg', 'hr', 'sk', 'sl', 'lv', 'hi', 'id', 'vi']) assert.equal(voice.speaks(code), true, code);
    // Not on Voxtral TTS 3's list: written, never read by a voice that would garble it.
    for (const code of ['sr', 'et', 'lt', 'he']) assert.equal(voice.speaks(code), false, code);
    const packets = [];
    const result = await voice.synthesizeStream('judy-alvarez', text, {language: 'fi', onPcm: packet => { packets.push(packet); }});
    assert.ok(result.frames > 0 && packets.length > 0, 'audio came back');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].input, text, 'the Finnish text itself is what Voxtral is asked to speak');
    assert.equal(requests[0].ref_audio, reference.toString('base64'), 'no Finnish pack exists: the English reference clip clones the voice');
    assert.equal(requests[0].stream, true);
  } finally { await new Promise(done => { server.closeAllConnections?.(); server.close(done); }); }
});

test('Other language on a Voxtral list gap: Serbian, Estonian, Lithuanian and Hebrew are shown as text with the voice-language reason', () => {
  const voxtral = {uses: true, provider: 'pocket', cloud: 'voxtral', speaks: language => voxtralSpeaks(language), pocket: {speaks: () => false, packMissing: () => false}};
  for (const language of ['sr', 'et', 'lt', 'he']) {
    const plan = planTurnVoice({textProvider: true, fixed: true, language, local: voxtral});
    assert.equal(plan.reason, 'voice-language-unsupported', language);
    assert.equal(replyVoice({plan, text: 'x', local: voxtral}).engine, 'none', language);
    assert.deepEqual(otherLanguageVoice(voxtral, language), {ok: false, why: 'language'});
  }
  for (const code of VOXTRAL_TTS3_LANGUAGES.filter(code => OTHER_LANGUAGE_CODES.includes(code))) assert.equal(voxtralSpeaks(code), true);
});

test('Other language on OmniVoice: spoken, with the language told to the voice; the plan never needs a pack', () => {
  const omni = {uses: true, provider: 'omni', pocket: {speaks: () => false, packMissing: () => false}};
  for (const code of OTHER_LANGUAGE_CODES) {
    const plan = planTurnVoice({textProvider: true, fixed: true, language: code, local: omni});
    assert.deepEqual(plan, {engine: 'omni', language: code, reason: 'omni', textProvider: true, fixed: true}, code);
    assert.deepEqual(replyVoice({plan, text: 'whatever', local: omni}), {engine: 'omni', language: code}, code);
    assert.deepEqual(otherLanguageVoice(omni, code), {ok: true, why: null});
  }
});

test('Pocket refuses an Other language with a clear message: English only, the reply is shown as text, nothing is read by the English student', async () => {
  const pocket = {uses: true, provider: 'pocket', pocket: {speaks: () => false, packMissing: () => false}};
  for (const code of OTHER_LANGUAGE_CODES) {
    const plan = planTurnVoice({textProvider: true, fixed: true, language: code, local: pocket});
    assert.equal(plan.reason, 'other-language-pocket', code);
    const voice = replyVoice({plan, text: 'Hei V.', local: pocket});
    assert.deepEqual(voice, {engine: 'none', language: code, reason: 'other-language-pocket'}, code);
    assert.deepEqual(otherLanguageVoice(pocket, code), {ok: false, why: 'pocket'});
  }
  const message = pocketRefusal('fi');
  assert.match(message, /Pocket speaks English only/);
  assert.match(message, /Finnish/);
  assert.match(message, /shown as text/);
  assert.match(message, /Voxtral voice or OmniVoice/);
  // The game's own languages keep their reason and their message (Pocket is English only for them too, unless a model is installed).
  assert.equal(planTurnVoice({textProvider: true, fixed: true, language: 'ja', local: pocket}).reason, 'english-only-voice');
  // The bridge turns the reason into the reply's audioError, the routing line and the by-design silence list.
  const bridge = read('./convai-bridge.mjs');
  assert.match(bridge, /voice\.reason === 'other-language-pocket' \? pocketRefusal\(voice\.language\)/);
  assert.match(read('./voice-silence.mjs'), /'other-language-pocket'/);
  assert.match(read('./voice-routing-log.mjs'), /other-language-pocket/);
});

test('the voice selection itself refuses an Other language for Pocket: a request that gets past the plan is not read by the English student', async () => {
  const calls = [];
  const voices = Object.fromEntries(LOCAL_VOICE_KEYS.map(key => [key, {reference: `runtime/voice-references/${key}.wav`, sha256: 'a'.repeat(64), transcript: 'Ready when you are, V.'}]));
  const factory = (config, {onState}) => {
    let loaded = false;
    return {get loaded() { return loaded; }, hasProfile: key => Object.hasOwn(config.voices, key), profileReady: key => loaded && Object.hasOwn(config.voices, key),
      get residentLanguage() { return null; }, async prepareProfile() { return {provider: 'pocket', ready: true}; },
      async start() { loaded = true; onState({state: 'ready', resident: true}); },
      async synthesizeStream(profile, text, options) { calls.push({profile, text, options}); return {audio: 'pcm'}; },
      async close() { loaded = false; onState({state: 'stopped'}); }};
  };
  const settings = {version: 1, provider: 'pocket', engine: 'pocket-tts', voices,
    runtime: Object.fromEntries(['sourceDirectory', 'exportDirectory', 'referenceDirectory', 'workDirectory'].map(key => [key, resolve('fixture', key)])),
    model: {sha256: 'a'.repeat(64), configSha256: 'b'.repeat(64), tokenizerSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64), inputIdentity: 'e'.repeat(64), selectedStep: 1500}};
  const selection = new VoiceSelection(settings, {factory});
  selection.update({voiceProvider: 'pocket'}, null, false);
  await selection.start();
  try {
    await assert.rejects(selection.synthesizeStream(LOCAL_VOICE_KEYS[0], 'Hei V, mitä kuuluu?', {onPcm() {}, language: 'fi'}), error => {
      assert.match(error.message, /Pocket speaks English only/);
      assert.equal(error.reason, 'other-language-pocket');
      return true;
    });
    assert.equal(calls.length, 0, 'the worker was never asked');
    // English, and a language the game has (no model installed: the old behaviour), are untouched by the new guard.
    await selection.synthesizeStream(LOCAL_VOICE_KEYS[0], 'Hello.', {onPcm() {}});
    await selection.synthesizeStream(LOCAL_VOICE_KEYS[0], 'Hola.', {onPcm() {}, language: 'es'});
    assert.equal(calls.length, 2);
  } finally { await selection.close(); }
});

test('the microphone: the chosen Other language is the recording\'s language until the recogniser says otherwise', async () => {
  const speech = new SpeechLanguage();
  assert.equal(speech.setChosen('fi'), true);
  assert.equal(speech.setChosen('fi'), false);
  assert.deepEqual(await speech.current(), {language: 'fi', source: 'setting'});
  // Typed English does not move it (the word lists cannot tell Finnish, English lines say little), the recogniser's own report does.
  speech.observeText('what a great day to be alive in night city');
  assert.equal((await speech.current()).language, 'fi');
  speech.observeVoice('en');
  assert.deepEqual(await speech.current(), {language: 'en', source: 'voice'});
  // Voxtral hears it with the code as a hint.
  const plan = planRecording({language: 'fi', source: 'setting', provider: 'mistral', voxtralReady: true});
  assert.equal(plan.mode, 'voxtral');
  assert.equal(plan.hint, 'fi');
  // Cleared: back to what it was.
  const cleared = new SpeechLanguage();
  cleared.setChosen('fi'); cleared.setChosen(null);
  assert.deepEqual(await cleared.current(), {language: 'en', source: 'default'});
  assert.equal(new SpeechLanguage().setChosen('klingon!'), false);
});

// ---- C. The translation path --------------------------------------------------------------------------------------------------------

test('cleanTranslation: the answer is trusted only when it is a plain line that differs from the original', () => {
  assert.equal(cleanTranslation('  Привет, V.  ', 'Hey, V.'), 'Привет, V.');
  assert.equal(cleanTranslation('"Привет, V."', 'Hey, V.'), 'Привет, V.');
  assert.equal(cleanTranslation('Translation: Привет, V.', 'Hey, V.'), 'Привет, V.');
  assert.equal(cleanTranslation('Привет.\n\nКак дела?', 'Hey. How are you?'), 'Привет. Как дела?');
  assert.equal(cleanTranslation('Hey, V.', 'Hey, V.'), null, 'unchanged: nothing to swap');
  assert.equal(cleanTranslation('', 'Hey, V.'), null);
  assert.equal(cleanTranslation(null, 'Hey, V.'), null);
  assert.equal(cleanTranslation('x'.repeat(500), 'Hey, V.'), null, 'a rambling answer is not a subtitle');
  assert.equal(cleanTranslation('bad\u0000text', 'Hey, V.'), null);
});

test('the request holds the reply and the target language and nothing else: no persona, no history, no name of the player', () => {
  const messages = translationMessages({text: 'Hey, V. Meet me at the Afterlife.', to: 'ru', from: 'en'});
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /from English into Russian/);
  assert.match(messages[0].content, /translation only/);
  assert.deepEqual(messages[1], {role: 'user', content: 'Hey, V. Meet me at the Afterlife.'});
  assert.match(translationMessages({text: 'Moi', to: 'fi'})[0].content, /into Finnish\./);
});

test('SubtitleTranslations: nothing happens with Same as speech, the text is too short, or the reply is already in the subtitle language', () => {
  const calls = [];
  const table = new SubtitleTranslations({translate: async options => { calls.push(options); return 'Привет, V.'; }});
  assert.equal(table.active, false);
  assert.equal(table.begin('r1', 'Hey, V.'), false, 'no target set');
  table.setTarget('ru');
  assert.equal(table.active, true);
  assert.equal(table.begin('r1', ' '), false);
  assert.equal(table.begin('r1', 'x'), false, 'one letter');
  assert.equal(table.begin('r1', 'x'.repeat(2000)), false, 'too long to be a subtitle');
  assert.equal(table.begin('r1', 'Привет, V.', {speech: 'ru'}), false, 'already in the subtitle language');
  assert.equal(table.begin('', 'Hey, V.'), false, 'no turn');
  assert.equal(calls.length, 0);
  assert.equal(table.begin('r1', 'Hey, V.', {speech: 'en'}), true);
  assert.equal(calls.length, 1);
  assert.equal(table.setTarget(null), true);
  assert.equal(table.entries.size, 0, 'changing the setting drops what was in flight');
  assert.equal(table.setTarget('same'), false);
});

test('timing: the request starts the moment the text is complete and begin() returns at once; the voice path never waits for the answer', async () => {
  const late = defer(), started = [];
  const table = new SubtitleTranslations({translate: ({text, to, from}) => { started.push({text, to, from}); return late.promise; }});
  table.setTarget('ru');
  const returned = table.begin('r1', 'Hey, V. Meet me at the Afterlife.', {speech: 'en'});
  // Causal, not timed: the answer has not been given (the deferred is still open) and begin() has already returned a plain boolean.
  assert.equal(returned, true, 'begin returns a boolean, not a promise');
  assert.equal(started.length, 1, 'the request was sent inside the call');
  assert.deepEqual([started[0].to, started[0].from], ['ru', 'en']);
  // While the answer is on its way every poll of the voice path gets the original, synchronously (a string, never a promise).
  assert.equal(table.pending('r1'), true);
  for (let poll = 0; poll < 50; poll++) {
    const shown = table.show('r1', 'Hey, V. Meet me at the Afterlife.', true);
    assert.equal(typeof shown, 'string');
    assert.equal(shown, 'Hey, V. Meet me at the Afterlife.');
  }
  late.resolve('Эй, V. Встретимся в Афтерлайфе.');
  await tick();
  assert.equal(table.pending('r1'), false);
  assert.equal(table.show('r1', 'Hey, V. Meet me at the Afterlife.', true), 'Эй, V. Встретимся в Афтерлайфе.');
});

test('the swap: the original shows first and the translation takes its place once, for the finished text only', async () => {
  const answer = defer();
  const table = new SubtitleTranslations({translate: () => answer.promise});
  table.setTarget('ru');
  table.begin('r1', 'Hey, V.');
  assert.equal(table.show('r1', 'Hey, V.', true), 'Hey, V.');
  answer.resolve('Эй, V.');
  await tick();
  assert.equal(table.show('r1', 'Hey, V.', true), 'Эй, V.');
  assert.equal(table.show('r1', 'Hey', false), 'Hey', 'text that is still being written is shown as it is');
  assert.equal(table.show('r1', 'Something else entirely.', true), 'Something else entirely.', 'a text it was not made from is never swapped');
  assert.equal(table.show('r1', '  Hey,   V. ', true), 'Эй, V.', 'spacing does not matter');
  assert.equal(sameReply('Hey V. Meet me. And one more thing', 'Hey V. Meet me.'), true, 'a reply cut at its last whole sentence is the same reply');
  assert.equal(sameReply('Hey V.', 'Bye V.'), false);
  assert.equal(sameReply('', 'Hey V.'), false);
  assert.equal(table.show('r2', 'Hey, V.', true), 'Hey, V.', 'another turn');
  table.release('r1');
  assert.equal(table.show('r1', 'Hey, V.', true), 'Hey, V.', 'nothing is kept after the turn');
  assert.equal(table.entries.size, 0);
});

test('a failure leaves the original: no throw, one log line, and the line never carries the conversation', async () => {
  const logs = [];
  const table = new SubtitleTranslations({translate: async () => { throw Object.assign(new Error('boom: the secret reply text'), {reason: 'busy'}); }, log: line => logs.push(line)});
  table.setTarget('ru');
  table.begin('r1', 'Hey, V. Secret plan.');
  table.begin('r2', 'Hey again, V. Secret plan.');
  await tick(); await tick();
  assert.equal(table.show('r1', 'Hey, V. Secret plan.', true), 'Hey, V. Secret plan.');
  assert.equal(logs.length, 1, 'said once');
  assert.doesNotMatch(logs[0], /Secret|boom/);
  assert.match(logs[0], /stay in the speech language/);
  const empty = new SubtitleTranslations({translate: async () => null});
  empty.setTarget('ru'); empty.begin('r1', 'Hey, V.'); await tick();
  assert.equal(empty.show('r1', 'Hey, V.', true), 'Hey, V.');
  const same = new SubtitleTranslations({translate: async () => 'Hey, V.'});
  same.setTarget('ru'); same.begin('r1', 'Hey, V.'); await tick();
  assert.equal(same.show('r1', 'Hey, V.', true), 'Hey, V.');
});

test('a written reply (Phone Chat, a text-only voice) waits for the translation for a short moment and no longer', async () => {
  const timers = [];
  const setTimer = (fn, ms) => { const handle = {fn, ms, cleared: false}; timers.push(handle); return handle; };
  const clearTimer = handle => { handle.cleared = true; };
  const slow = defer();
  const table = new SubtitleTranslations({translate: () => slow.promise, setTimer, clearTimer});
  table.setTarget('ru');
  table.begin('r1', 'Hey, V.');
  const waiting = table.wait('r1', 'Hey, V.', WRITTEN_WAIT_MS);
  let done = false; waiting.then(() => { done = true; });
  await tick();
  assert.equal(done, false);
  assert.equal(timers.at(-1).ms, WRITTEN_WAIT_MS);
  timers.at(-1).fn();                       // the short moment is over
  assert.equal(await waiting, 'Hey, V.', 'the original, not an error');
  slow.resolve('Эй, V.'); await tick();
  // In time: the translation, and the timer is dropped.
  const quick = new SubtitleTranslations({translate: async () => 'Эй, V.', setTimer, clearTimer});
  quick.setTarget('ru'); quick.begin('r2', 'Hey, V.');
  assert.equal(await quick.wait('r2', 'Hey, V.', WRITTEN_WAIT_MS), 'Эй, V.');
  assert.equal(timers.at(-1).cleared, true);
  assert.equal(await quick.wait('nobody', 'Hey, V.', 10), 'Hey, V.', 'no entry: no wait');
  assert.ok(LOCAL_WRITTEN_WAIT_MS > WRITTEN_WAIT_MS, 'Local AI is given longer');
  // A translator that rejects never rejects the wait.
  const broken = new SubtitleTranslations({translate: () => Promise.reject(new Error('x')), setTimer, clearTimer});
  broken.setTarget('ru'); broken.begin('r3', 'Hey, V.');
  assert.equal(await broken.wait('r3', 'Hey, V.', 50), 'Hey, V.');
});

test('nothing outlives its turn: release, the world reset, age and a bound all drop an entry, and an unfinished request is aborted', async () => {
  let clock = 1000;
  const signals = [];
  const table = new SubtitleTranslations({translate: ({signal}) => { signals.push(signal); return new Promise(() => {}); }, now: () => clock});
  table.setTarget('ru');
  table.begin('a', 'Hey, V.');
  assert.equal(table.entries.size, 1);
  table.release('a');
  assert.equal(table.entries.size, 0);
  assert.equal(signals[0].aborted, true, 'an unfinished request is abandoned with the turn');
  for (let index = 0; index < MAX_ENTRIES + 5; index++) table.begin(`t${index}`, 'Hey, V.');
  assert.ok(table.entries.size <= MAX_ENTRIES, `${table.entries.size} entries`);
  clock += ENTRY_TTL_MS + 1;
  table.begin('late', 'Hey, V.');
  assert.deepEqual([...table.entries.keys()], ['late'], 'old entries are swept when the next turn begins');
  table.clear();
  assert.equal(table.entries.size, 0);
  // A signal of the turn aborts its request.
  const turn = new AbortController(), seen = [];
  const bound = new SubtitleTranslations({translate: ({signal}) => { seen.push(signal); return new Promise(() => {}); }});
  bound.setTarget('ru'); bound.begin('r', 'Hey, V.', {signal: turn.signal});
  turn.abort();
  assert.equal(seen[0].aborted, true);
  // Nothing is written to disk: the module has no file access at all.
  assert.doesNotMatch(read('./subtitle-translation.mjs'), /node:fs|writeFile|appendFile|localStorage/);
});

// The continuous speech state: the document the game draws from.
const owner = {requestId: 'reply-1', entity: 'judy-copy-2', generation: 7};
function speechFixture(extra = {}) {
  const f = {now: 10000, states: [], replies: [], texts: [], timelines: [], abort: new AbortController()};
  f.stream = new ConvaiContinuousSpeech({input: owner, profile: {key: 'judy-alvarez'}, token: 'continuous-1', signal: f.abort.signal, now: () => f.now,
    current: async () => true, readControl: async () => f.raw ?? '{}',
    writeState: async value => { f.states.push(structuredClone(value)); return true; },
    writeReply: async value => { f.replies.push(structuredClone(value)); return true; },
    onText: text => f.texts.push(text), planExpression: text => { f.timelines.push(text); return undefined; }, ...extra});
  f.control = () => { f.raw = JSON.stringify({version: 1, id: 'continuous-1', ...owner, sequence: 1, updated: f.now, allow: true, paused: false, volume: .8, pan: .2}); };
  f.snapshot = changes => ({version: 1, token: 'continuous-1', sampleRate: 24000, channels: 1, receivedFrames: 12000, positionSeconds: 0, text: 'Hey V.',
    textComplete: false, sourceComplete: false, ended: false, underruns: 0, state: 'buffering', ...changes});
  return f;
}

test('the spoken reply: the state the game draws carries the translation once it is here, the cues are cut from it, and the voice and the face keep the original', async () => {
  const original = 'Hey V. Meet me at the Afterlife. We have work.';
  const russian = 'Эй, V. Встретимся в Афтерлайфе. У нас есть работа.';
  const table = new SubtitleTranslations({translate: () => answer.promise});
  const answer = defer();
  table.setTarget('ru');
  const f = speechFixture({subtitle: (text, complete) => table.show('r1', text, complete)});
  f.control();
  const first = f.snapshot({text: original, textComplete: true, sourceComplete: false});
  // The text is complete: the request starts (the bridge does this when the reply resolves) and the poll is NOT held up by it: the answer is still
  // closed (`answer` is resolved only below), so a poll that waited for it would never come back.
  table.begin('r1', original, {speech: 'en'});
  await f.stream.frame(first);
  assert.equal(f.states.at(-1).text, original, 'original first');
  assert.equal(f.replies[0].text, original);
  assert.equal(table.pending('r1'), true, 'and the translation is still on its way');
  answer.resolve(russian);
  await tick();
  await f.stream.frame({...first, receivedFrames: 24000, positionSeconds: .3});
  const swapped = f.states.at(-1);
  assert.equal(swapped.text, russian, 'swapped to the translation');
  if (swapped.captions) assert.equal(swapped.captions.cues.map(cue => cue.text).join(''), russian, 'the cues are cut from the text that is drawn');
  // The reply is announced and planned from its own text: the mouth, the emotion and the next speaker see the original.
  assert.deepEqual(f.texts, [original]);
  assert.ok(f.timelines.every(text => text === original), 'the expression plan used the original');
});

test('the spoken reply without a subtitle language is byte for byte what it was', async () => {
  const f = speechFixture();
  f.control();
  await f.stream.frame(f.snapshot({text: 'Hey V. Meet me.', textComplete: true}));
  assert.equal(f.states.at(-1).text, 'Hey V. Meet me.');
  const hooked = speechFixture({subtitle: text => text});
  hooked.control();
  await hooked.stream.frame(hooked.snapshot({text: 'Hey V. Meet me.', textComplete: true}));
  assert.deepEqual({...hooked.states.at(-1), updated: 0}, {...f.states.at(-1), updated: 0});
  // A hook that throws or answers rubbish changes nothing.
  for (const subtitle of [() => { throw new Error('x'); }, () => 5, () => '  ', () => null]) {
    const broken = speechFixture({subtitle});
    broken.control();
    await broken.stream.frame(broken.snapshot({text: 'Hey V. Meet me.', textComplete: true}));
    assert.equal(broken.states.at(-1).text, 'Hey V. Meet me.');
  }
});

// The text provider: one request, to the player's own route.
const book = new PersonaBook([{key: 'judy-alvarez', name: 'Judy Alvarez'}]);
function textHost({route = 'local', answers = {}, fail = {}} = {}) {
  const chats = [], routes = {}, logs = [];
  for (const name of ['mistral', 'gemini', 'local', 'custom']) {
    const entry = mistralRoute({provider: {apiKey: 'test' + 'x'.repeat(28), noteSuccess() {}, noteLimit() {}, limit: null}, gapMs: 0});
    entry.name = name;
    entry.chat = async options => {
      chats.push({route: name, options});
      if (fail[name]) throw Object.assign(new Error(`${name} failed`), {kind: 'request'});
      return {text: answers[name] ?? `translated by ${name}`, model: 'm', finishReason: 'stop', usage: {}, attempts: 1, failed: [], trace: {}};
    };
    routes[name] = entry;
  }
  const provider = {route, active: true, onChange() {}};
  const host = new TextProviderHost({provider, memory: null, personas: book, routes, log: line => logs.push(line), deliverAction: async () => false});
  return {host, chats, logs, provider};
}

test('the text provider translates through the route the player talks with: Mistral on Mistral, Gemini on Gemini, Custom on Custom', async () => {
  for (const route of ['mistral', 'gemini', 'custom']) {
    const {host, chats} = textHost({route});
    const answer = await host.translate({text: 'Hey, V. Meet me at the Afterlife.', to: 'ru', from: 'en'});
    assert.equal(answer, `translated by ${route}`);
    assert.deepEqual(chats.map(chat => chat.route), [route], `${route}: one request, to that route only`);
    assert.equal(chats[0].options.messages.length, 2);
    assert.match(chats[0].options.messages[0].content, /into Russian/);
    assert.equal(chats[0].options.messages[1].content, 'Hey, V. Meet me at the Afterlife.');
  }
});

test('local stays local: with Local AI the translation runs on Local AI, never on a cloud route, even when it fails or a cloud key exists', async () => {
  const {host, chats, logs} = textHost({route: 'local'});
  assert.equal(await host.translate({text: 'Hey, V. Meet me at the Afterlife.', to: 'ru'}), 'translated by local');
  assert.deepEqual(chats.map(chat => chat.route), ['local']);
  // It fails: nothing else is asked, the answer is none and the reply keeps its original subtitle.
  const failing = textHost({route: 'local', fail: {local: true}});
  assert.equal(await failing.host.translate({text: 'Hey, V. Meet me at the Afterlife.', to: 'ru'}), null);
  assert.deepEqual(failing.chats.map(chat => chat.route), ['local'], 'a failing Local AI never hands the text to Mistral, Gemini or Custom');
  assert.match(failing.logs.join('\n'), /subtitle translation failed/);
  assert.doesNotMatch(failing.logs.join('\n'), /Afterlife/, 'the log has no dialogue');
  void logs;
  // Through the table: the same.
  const table = new SubtitleTranslations({translate: options => failing.host.translate(options)});
  table.setTarget('ru'); table.begin('r1', 'Hey, V. Meet me at the Afterlife.'); await tick(); await tick();
  assert.equal(table.show('r1', 'Hey, V. Meet me at the Afterlife.', true), 'Hey, V. Meet me at the Afterlife.');
  assert.ok(failing.chats.every(chat => chat.route === 'local'));
});

test('Convai answering: there is no text provider, so no request is made at all', async () => {
  const {host, chats, provider} = textHost({route: 'mistral'});
  provider.active = false;
  assert.equal(await host.translate({text: 'Hey, V. Meet me.', to: 'ru'}), null);
  assert.equal(chats.length, 0);
  assert.equal(await textHost().host.translate({text: '   ', to: 'ru'}), null);
  const gone = textHost();
  gone.host.close();
  assert.equal(await gone.host.translate({text: 'Hey', to: 'ru'}), null);
  assert.equal(gone.chats.length, 0);
  // A turn that is already over asks for nothing.
  const over = new AbortController(); over.abort();
  assert.equal(await textHost().host.translate({text: 'Hey, V.', to: 'ru', signal: over.signal}), null);
});

test('the reply is announced when it is complete and handed on at once: the translation starts beside the voice and the reply never waits for it', async () => {
  const slow = defer();
  const announced = [];
  const host = {reply: async config => ({text: `Reply to ${config.text}`, sessionID: 's'}), prepare: async () => ({}), warm: async () => ({}), readiness: async () => ({}),
    lateEmotion: async () => ({}), refreshIdle: async () => true, voiceChannel: () => ({})};
  const provider = {route: 'mistral', active: true};
  const table = new SubtitleTranslations({translate: () => slow.promise});
  table.setTarget('ru');
  attachTextProvider(host, {provider, mistral: {reply: async (config, options) => ({text: 'Hey, V. Meet me at the Afterlife.', sessionID: '-1', options}), prewarm() {}},
    onReplyText: (config, result) => { announced.push([config.subtitleTurn, result.text]); table.begin(config.subtitleTurn, result.text, {speech: 'en'}); }});
  const result = await host.reply({text: 'hi', subtitleTurn: 'r1', local: {profileKey: 'judy-alvarez'}}, {});
  assert.equal(result.text, 'Hey, V. Meet me at the Afterlife.', 'the reply resolved while the translation is still pending');
  assert.equal(table.pending('r1'), true);
  assert.deepEqual(announced, [['r1', 'Hey, V. Meet me at the Afterlife.']]);
  // A faulty observer never breaks a turn.
  const quiet = {reply: async () => ({}), prepare: async () => ({}), warm: async () => ({}), readiness: async () => ({}), lateEmotion: async () => ({}), refreshIdle: async () => true, voiceChannel: () => ({})};
  attachTextProvider(quiet, {provider, mistral: {reply: async () => ({text: 'Fine.'}), prewarm() {}}, onReplyText: () => { throw new Error('observer'); }});
  assert.equal((await quiet.reply({text: 'hi', local: {profileKey: 'judy-alvarez'}}, {})).text, 'Fine.');
  slow.resolve('Эй, V.');
});

test('Phone Chat: the chat line is the translation when it arrives in time, the original when it does not, and the reply is otherwise untouched', async () => {
  const now = 100000;
  const binding = {version: 1, status: 'available', authoritative: true, confidence: 'native-live', localUserId: 'user-1', campaignId: 'a'.repeat(32), branchId: 'b'.repeat(32),
    branchEpoch: 1, ledgerSequence: 10, generation: 1, activationId: 'c'.repeat(32)};
  const state = {version: 2, world: 'world-1', updated: now, active: true, saveIdentity: binding, request: {id: 'world-1-1', contact: 'judy', text: 'Hey Judy!', saveIdentity: binding}};
  const run = async localize => {
    const output = [];
    const chat = new PhoneChat({contacts: [{contact: 'judy', key: 'judy-alvarez'}], ids: {'judy-alvarez': 'judy-id'}, now: () => now,
      reply: async () => ({text: 'Going well. Come by later.', sessionID: 'session'}), publish: async value => output.push(value), ...(localize ? {localize} : {})});
    await chat.accept(state); await chat.active?.work;
    return output.filter(row => row.state === 'reply').map(row => row.text);
  };
  assert.deepEqual(await run(null), ['Going well. Come by later.'], 'no Subtitle language: exactly what it was');
  assert.deepEqual(await run(async text => `RU: ${text}`), ['RU: Going well. Come by later.']);
  assert.deepEqual(await run(async text => text), ['Going well. Come by later.']);
  assert.deepEqual(await run(async () => { throw new Error('x'); }), ['Going well. Come by later.'], 'a failing translation shows the original');
  assert.deepEqual(await run(async () => '   '), ['Going well. Come by later.']);
});

test('the bridge wires it: settings poll, the announce hook, the continuous state hook, the written reply wait, Phone Chat, and the Convai note', () => {
  const bridge = read('./convai-bridge.mjs');
  assert.match(bridge, /subtitleLanguageFrom\(settings\)/);
  assert.match(bridge, /subtitleTranslations\.setTarget\(subtitle\.target\)/);
  assert.match(bridge, /onReplyText: beginSubtitleTranslation/);
  assert.match(bridge, /translate: options => mistralHost\.translate\(options\)/);
  assert.match(bridge, /subtitle: \(text, complete\) => subtitleTranslations\.show\(input\.requestId, text, complete\)/);
  assert.match(bridge, /await subtitleTranslations\.wait\(input\.requestId, result\.text, writtenSubtitleWait\(\)\)/);
  assert.match(bridge, /localize: async \(text, \{profileKey, signal\}\)/);
  assert.match(bridge, /subtitleTurn: input\.requestId/);
  assert.match(bridge, /replyLanguageFrom\(settings, \{textProvider: mistral\.active \? mistral\.route : null\}\)/);
  assert.match(bridge, /speechLanguage\.setChosen\(/);
  assert.match(bridge, /needs a text provider/);
  // Only the translation is started by the announce hook: it never awaits and never reaches the voice.
  const hook = bridge.slice(bridge.indexOf('function beginSubtitleTranslation'), bridge.indexOf('// How long a reply with no sound waits'));
  assert.doesNotMatch(hook, /await /);
  // The spoken path never awaits the table.
  assert.doesNotMatch(bridge, /await subtitleTranslations\.show/);
});

test('the English instruction: with a subtitle language and an English voice, the reply is told to be written in English', () => {
  const conversation = new MultilingualConversations();
  conversation.setFixed('en');
  assert.equal(conversation.contextFor('Привет, Джуди'), '', 'as it always was without a subtitle language');
  assert.equal(conversation.setPinEnglish(true), true);
  assert.equal(conversation.setPinEnglish(true), false);
  assert.match(conversation.contextFor('Привет, Джуди'), /write the whole reply in English, whatever language the player's message is in/);
  conversation.setPinEnglish(false);
  assert.equal(conversation.contextFor('Привет, Джуди'), '');
  // Another fixed language is unaffected.
  conversation.setFixed('fr'); conversation.setPinEnglish(true);
  assert.match(conversation.contextFor('hello'), /in French/);
});

test('a fake provider end to end: reply -> announce -> translate -> swap, with the voice never behind', async () => {
  // The voice polls every few milliseconds from the moment the text is complete. The provider's answer is released only after several polls have been
  // published, so every one of those polls was published without it: a poll that waited for the answer would never have come back.
  const original = 'Hey V. Meet me at the Afterlife.';
  const release = defer();
  const table = new SubtitleTranslations({translate: () => release.promise});
  table.setTarget('ru');
  const f = speechFixture({subtitle: (text, complete) => table.show('r1', text, complete)});
  f.control();
  table.begin('r1', original, {speech: 'en'});
  const drawn = [];
  for (let poll = 0; poll < 6; poll++) {
    await f.stream.frame(f.snapshot({text: original, textComplete: true, receivedFrames: 12000 + poll * 480, positionSeconds: poll * .02}));
    drawn.push(f.states.at(-1).text);
  }
  assert.deepEqual(drawn, Array(6).fill(original), 'the voice and its subtitle ran on the original while the request was out');
  release.resolve('Эй, V. Встретимся в Афтерлайфе.');
  await tick();
  await f.stream.frame(f.snapshot({text: original, textComplete: true, receivedFrames: 12000 + 6 * 480, positionSeconds: .12}));
  assert.equal(f.states.at(-1).text, 'Эй, V. Встретимся в Афтерлайфе.', 'the translation replaced it on the next poll');
  assert.equal(f.states.length, 7, 'one state per poll, none dropped or doubled');
});
