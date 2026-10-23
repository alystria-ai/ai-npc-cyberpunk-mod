import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assessLanguage} from './reply-language.mjs';
import {MultilingualConversations, REPLY_LANGUAGES, planTurnVoice, replyLanguageFrom, replyVoice} from './multilingual.mjs';
import {LANGUAGE_PACKS} from './voice-language-packs.mjs';
import {POCKET_LANGUAGES} from './pocket-language-models.mjs';
import {MOD_LANGUAGES} from './speech-language.mjs';

// The live bug (2026-10-23): "hows biz" typed to Alex (Convai, Pocket, automatic language) was detected as Turkish, the turn went to the
// multilingual twin, Pocket could not voice it and the reply was text only. Automatic is now careful: a short line in Latin letters never moves
// the conversation, and a language changes only on a long solid line or the second solid line in a row.

// English and Night City slang, short: none of these may ever make a conversation leave English (or the language it is in).
const SHORT_ENGLISH = [
  'hows biz', 'wassup', 'yo choom', 'nova', 'preem', 'whats the word choom', 'eddies please', 'gonk', 'got any gigs', 'nice chrome',
  'flatline that', 'delta out', 'cya choom', 'hey V', 'so what now', 'lets roll', 'ok boss', 'hows life', 'nah im good', 'got eddies',
  'any news', 'where to', 'need a ride', 'you good?', 'spare some eddies', 'watch my back', 'drinks on me', 'this place is dead',
  'break a leg', 'sup choom', 'hows the biz', 'nova ride', 'biz is good', 'yo V', 'choom', 'Afterlife tonight?',
];

// Real lines of other languages. LONG ones switch at once; MEDIUM ones (a letter English does not write, or a few more words) are the first
// of two in a row.
const LONG_FOREIGN = [
  ['fr', 'Je ne sais pas ce que tu veux dire, mais nous pouvons essayer ce soir.'],
  ['es', 'No entiendo nada de lo que dices, ¿puedes repetirlo más despacio por favor?'],
  ['de', 'Ich habe keine Ahnung, was du meinst, aber wir können es versuchen.'],
  ['ja', 'こんにちは、ジュディ。今夜はどこへ行くの？'],
  ['tr', 'Bu akşam ne yapıyorsun, benimle gelmek ister misin?'],
];
const MEDIUM_FOREIGN = [
  ['fr', 'Où est-ce qu\'on va ?'], ['es', '¿Cuánto falta?'], ['de', 'Ich bin müde'], ['tr', 'Ne kadar kaldı?'], ['tr', 'Teşekkürler dostum'],
  ['fr', 'Salut, ça va ?'], ['es', 'Hola, ¿cómo estás?'],
];

test('short English and Night City slang is never solid evidence for another language, whatever the detector guessed', () => {
  assert.ok(SHORT_ENGLISH.length >= 30);
  for (const text of SHORT_ENGLISH) {
    const found = assessLanguage(text);
    assert.ok(!found.language || found.language === 'en' || found.solid === false, `${text}: ${found.language} must not be solid`);
  }
  // The finding itself: the word lists call it Turkish, the guard does not trust a short line without a letter English does not write.
  const biz = assessLanguage('hows biz');
  assert.equal(biz.language, 'tr');
  assert.equal(biz.short, true);
  assert.equal(biz.solid, false);
});

test('short English lines keep a conversation where it is: English, the remembered language, or the game\'s language, even said twice', () => {
  for (const start of [null, 'en', 'fr', 'tr', 'ja']) {
    for (const text of SHORT_ENGLISH) {
      const value = new MultilingualConversations();
      value.lastLanguage = start;
      for (let turn = 0; turn < 3; turn++) {
        assert.equal(value.wantsTwin({text}), !!start && start !== 'en', `${text} (${start})`);
        value.observe(text);
        assert.equal(value.lastLanguage, start, `${text} moved ${start}`);
      }
      assert.equal(value.expected(text), start ?? 'en', text);
    }
  }
  // With the game's own language as the prior (a Turkish menu) the lexicon call still needs a letter English does not write.
  const turkishGame = new MultilingualConversations();
  turkishGame.setPrior('tr');
  turkishGame.observe('hows biz'); turkishGame.observe('hows biz');
  assert.equal(turkishGame.lastLanguage, null);
  assert.equal(turkishGame.wantsTwin({text: 'hows biz'}), false);
});

test('real lines in French, Spanish, German, Japanese and Turkish still switch: at once when long, on the second in a row when medium', () => {
  for (const [language, text] of LONG_FOREIGN) {
    const value = new MultilingualConversations();
    assert.equal(value.wantsTwin({text}), true, text);
    assert.equal(value.expected(text), language, text);
    assert.equal(value.observe(text), true, text);
    assert.equal(value.lastLanguage, language, text);
    // And back to English with a long English line.
    assert.equal(value.observe('Hey V, meet me at the Afterlife tonight and we will talk it over.'), true);
    assert.equal(value.lastLanguage, 'en');
  }
  for (const [language, text] of MEDIUM_FOREIGN) {
    const value = new MultilingualConversations();
    assert.equal(value.wantsTwin({text}), false, `${text}: the first medium line is only noted`);
    assert.equal(value.observe(text), false);
    assert.equal(value.wantsTwin({text}), true, `${text}: the second in a row switches`);
    assert.equal(value.observe(text), true);
    assert.equal(value.lastLanguage, language, text);
  }
});

test('hysteresis: a different solid language, or a line in between that agrees with the conversation, restarts the count', () => {
  const value = new MultilingualConversations();
  value.observe('Où est-ce qu\'on va ?');
  value.observe('Ich bin müde');
  assert.equal(value.lastLanguage, null, 'French then German: two different languages are not two in a row');
  value.observe('Ich bin müde');
  assert.equal(value.lastLanguage, 'de');
  // Inside a German conversation, one solid French line does not move it, and a German line in between resets the French count.
  value.observe('Où est-ce qu\'on va ?');
  value.observe('Ich bin müde');
  value.observe('Où est-ce qu\'on va ?');
  assert.equal(value.lastLanguage, 'de');
  // A long solid line in another language moves it at once.
  assert.equal(value.observe('Je ne sais pas ce que tu veux dire, mais nous pouvons essayer ce soir.'), true);
  assert.equal(value.lastLanguage, 'fr');
});

test('the prior: a language the player was heard in before (or the game\'s own) lets a short line in that language through at once', () => {
  const text = 'Bonjour mon ami';
  const none = new MultilingualConversations();
  assert.equal(none.wantsTwin({text}), false, 'no letter English does not write, no prior: nothing happens');
  assert.equal(none.wantsTwin({text, hint: 'fr'}), true, 'a recording or an earlier launch said French');
  const game = new MultilingualConversations();
  game.setPrior('fr');
  assert.equal(game.wantsTwin({text}), true, 'the game is in French');
  game.observe(text);
  assert.equal(game.lastLanguage, 'fr');
  // The prior never rescues a guess of the character model, or an English line.
  assert.equal(game.wantsTwin({text: 'hows biz'}), true, 'the conversation is French now and a short line does not move it');
  const english = new MultilingualConversations();
  english.setPrior('fr');
  english.observe('what a great day to be alive in night city');
  assert.equal(english.lastLanguage, 'en');
});

test('a reply cannot be the second detection of the player\'s own line, but a recording takes its language from the reply', () => {
  const value = new MultilingualConversations();
  assert.equal(value.observeTurn('Où est-ce qu\'on va ?', 'On va au bar de Lizzie, c\'est tout près d\'ici.'), false);
  assert.equal(value.lastLanguage, null);
  assert.equal(value.observeTurn('Où est-ce qu\'on va ?', 'On va au bar de Lizzie, c\'est tout près d\'ici.'), true);
  assert.equal(value.lastLanguage, 'fr');
  const recording = new MultilingualConversations();
  assert.equal(recording.observeTurn('[Microphone]', 'Claro que sí, nos vemos en el bar de Lizzie esta noche, hermano.'), true);
  assert.equal(recording.lastLanguage, 'es');
});

// ---- The Reply language setting -------------------------------------------------------------------------------------

test('the choices: English first (the default), Automatic, then the mod\'s other languages, including every voice pack and Pocket model language', () => {
  assert.deepEqual(REPLY_LANGUAGES.slice(0, 2), ['en', 'auto']);
  assert.deepEqual(REPLY_LANGUAGES.slice(2), MOD_LANGUAGES.filter(code => code !== 'en'));
  for (const code of Object.values(LANGUAGE_PACKS)) assert.ok(REPLY_LANGUAGES.includes(code), `voice language pack ${code}`);
  for (const {tag} of Object.values(POCKET_LANGUAGES)) assert.ok(REPLY_LANGUAGES.includes(tag), `Pocket model ${tag}`);
  assert.equal(new Set(REPLY_LANGUAGES).size, REPLY_LANGUAGES.length);
});

test('replyLanguageFrom: English when nothing is saved or the value is unknown; a voice setting, so Voice playback off leaves the detection alone', () => {
  assert.deepEqual(replyLanguageFrom({}), {setting: 'en', fixed: 'en'});
  assert.deepEqual(replyLanguageFrom(undefined), {setting: 'en', fixed: 'en'});
  assert.deepEqual(replyLanguageFrom({replyLanguage: 'klingon'}), {setting: 'en', fixed: 'en'});
  assert.deepEqual(replyLanguageFrom({replyLanguage: 'auto'}), {setting: 'auto', fixed: null});
  assert.deepEqual(replyLanguageFrom({replyLanguage: 'fr', voice: true}), {setting: 'fr', fixed: 'fr'});
  for (const replyLanguage of ['en', 'fr', 'ja']) assert.equal(replyLanguageFrom({replyLanguage, voice: false}).fixed, null, `${replyLanguage} with voices off`);
  assert.equal(replyLanguageFrom({replyLanguage: 'fr', voice: false}).setting, 'fr', 'the choice is kept while voices are off');
});

test('a fixed language skips detection: turns go to that language\'s route, the context names it, the voice plan uses it', () => {
  const value = new MultilingualConversations();
  assert.equal(value.setFixed('fr'), true);
  assert.equal(value.setFixed('fr'), false);
  for (const text of ['hows biz', '[Microphone]', 'Hey V, meet me at the Afterlife tonight and we will talk it over.', '']) {
    assert.equal(value.wantsTwin({text}), true, `${text}: the French twin`);
    assert.equal(value.expected(text), 'fr', text);
    assert.match(value.contextFor(text), /write the whole reply in French, whatever language the player's message is in/);
  }
  assert.equal(value.wantsTwin({text: 'x', reaction: true}), true);
  assert.equal(value.observeTurn('Hey V, meet me at the Afterlife tonight and we will talk it over.', 'Sure thing, V.'), false);
  assert.equal(value.lastLanguage, 'fr');
  // English fixed: the ordinary character, whatever is written, and the context is the one an English conversation always had.
  value.setFixed('en');
  for (const text of ['Je ne sais pas ce que tu veux dire, mais nous pouvons essayer ce soir.', 'ja', '']) {
    assert.equal(value.wantsTwin({text}), false, text);
    assert.equal(value.expected(text), 'en', text);
    assert.equal(value.contextFor(text), '', text);
  }
  // Back to Automatic: the detection is in charge again.
  value.setFixed(null);
  assert.equal(value.fixed, null);
  assert.equal(value.wantsTwin({text: 'Je ne sais pas ce que tu veux dire, mais nous pouvons essayer ce soir.'}), true);
  value.setFixed('auto');
  assert.equal(value.fixed, null);
});

test('a fixed language picks the voice: Pocket speaks it with its model, otherwise the reply is text with the usual notice reason; the reply is not re-detected', () => {
  const noModel = {uses: true, provider: 'pocket', pocket: {speaks: () => false, packMissing: () => false}};
  const frenchModel = {uses: true, provider: 'pocket', pocket: {speaks: language => language === 'fr', packMissing: () => false}};
  const planFor = (language, local) => planTurnVoice({textProvider: true, fixed: true, language, local});
  assert.equal(planFor('fr', noModel).fixed, true);
  assert.deepEqual(planFor('fr', noModel), {engine: 'pocket', language: 'fr', reason: 'english-only-voice', textProvider: true, fixed: true});
  assert.deepEqual(replyVoice({plan: planFor('fr', noModel), text: 'hows biz', local: noModel}), {engine: 'none', language: 'fr', reason: 'english-only-voice'}, 'text, with the usual notice');
  assert.equal(planFor('fr', frenchModel).reason, 'pocket-language');
  const spoken = replyVoice({plan: planFor('fr', frenchModel), text: 'hows biz', local: frenchModel});
  assert.deepEqual(spoken, {engine: 'pocket', language: 'fr'}, 'a fixed language is not re-detected from the reply');
  // Fixed English: the reply is spoken in English by Pocket, even when it holds Spanish slang or looks like another language.
  assert.deepEqual(replyVoice({plan: planFor('en', noModel), text: 'Ay, chica, vámonos, hermano. Claro que sí.', local: noModel}), {engine: 'pocket', language: 'en'});
  // Automatic: a short English reply the detector takes for Turkish keeps the voice the turn was planned with.
  const automatic = planTurnVoice({textProvider: true, language: 'en', local: noModel});
  assert.deepEqual(replyVoice({plan: automatic, text: 'hows biz', local: noModel}), {engine: 'pocket', language: 'en'});
  const inFrench = planTurnVoice({textProvider: true, language: 'fr', local: frenchModel});
  assert.deepEqual(replyVoice({plan: inFrench, text: 'Nothing much, V. You?', local: frenchModel}), {engine: 'pocket', language: 'en'});
});

test('V\'s own typed line is voiced when it is English, whatever the reply or the conversation turns out to be', () => {
  const value = new MultilingualConversations();
  value.lastLanguage = 'tr';
  for (const text of SHORT_ENGLISH) assert.equal(value.lineLanguage(text), 'en', text);
  assert.equal(value.lineLanguage('Hey V, meet me at the Afterlife tonight and we will talk it over.'), 'en');
  assert.equal(value.lineLanguage('Je ne sais pas ce que tu veux dire, mais nous pouvons essayer ce soir.'), 'fr');
  value.setFixed('fr');
  assert.equal(value.lineLanguage('hows biz'), 'fr');
  assert.equal(value.lineLanguage('Hey V, meet me at the Afterlife tonight and we will talk it over.'), 'en', 'a solidly English line is still English');
  value.setFixed('en');
  assert.equal(value.lineLanguage('Je ne sais pas ce que tu veux dire, mais nous pouvons essayer ce soir.'), 'en');
});

test('the bridge wires it: the setting is read while Voice playback is on, V\'s line has its own language, the menu language is the prior', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /replyLanguageFrom\(settings\)/);
  assert.match(bridge, /multilingual\.setFixed\(reply\.fixed\)/);
  assert.match(bridge, /speechLanguage\.refreshUi\(\)\.then\(code => multilingual\.setPrior\(code\)\)/);
  assert.match(bridge, /planTurnVoice\(\{textProvider: true, fixed: multilingual\.fixed !== null,/);
  assert.match(bridge, /language: multilingual\.lineLanguage\(input\.text\)/);
  assert.match(bridge, /multilingual\.observeTurn\(input\.text, result\.text,/);
});
