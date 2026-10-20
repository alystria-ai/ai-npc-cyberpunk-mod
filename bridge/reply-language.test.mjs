import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {detectLanguage, isNonEnglish} from './reply-language.mjs';
import {DEV} from './reply-language.cases.mjs';
import {VOXTRAL_TTS3_LANGUAGES} from './voxtral-languages.mjs';
import {MOD_LANGUAGES} from './speech-language.mjs';

// Short lines (two to six words) the way a player types them to a character. Three sets, all labelled by language (null: no call is fine,
// English or nothing, but never another language):
//   DEV      written with the detector, tuned on;
//   HELDOUT  written separately by another model, seen while the word lists were written (so it is a regression set, not a blind one);
//   BLIND    written separately and run once before any tuning on its misses (the honest estimate; its first run: 93% recall, 99% precision).
// scripts/Eval-LanguageDetection.mjs prints precision and recall per language for the same sets.
const load = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')).map(row => [row.text, row.lang]);
const SETS = {dev: DEV, heldout: load('./reply-language.heldout.json'), blind: load('./reply-language.blind.json')};

function score(rows) {
  const per = {};
  const row = language => per[language] ??= {lines: 0, right: 0, called: 0, calledRight: 0};
  const englishAsForeign = [];
  for (const [text, label] of rows) {
    const got = detectLanguage(text).language;
    if (label) row(label).lines++;
    if (got) row(got).called++;
    if (label && got === label) { row(label).right++; row(got).calledRight++; }
    if ((label === 'en' || label === null) && got && got !== 'en') englishAsForeign.push([text, got]);
  }
  return {per, englishAsForeign};
}
const foreign = per => Object.entries(per).filter(([language]) => language !== 'en').reduce((sum, [, row]) =>
  ({lines: sum.lines + row.lines, right: sum.right + row.right, called: sum.called + row.called, calledRight: sum.calledRight + row.calledRight}),
  {lines: 0, right: 0, called: 0, calledRight: 0});

test('the labelled sets hold what they should: at least 150 lines, about 100 non-English and at least 60 English', () => {
  const all = [...SETS.dev, ...SETS.heldout, ...SETS.blind];
  assert.ok(all.length >= 150);
  assert.ok(all.filter(([, label]) => label && label !== 'en').length >= 100);
  assert.ok(all.filter(([, label]) => label === 'en' || label === null).length >= 60);
  const slang = ['choom', 'preem', 'eddies', 'nova', 'gonk', 'Afterlife', 'Arasaka', 'Jackie', 'Misty'];
  for (const word of slang) assert.ok(all.some(([text, label]) => text.includes(word) && (label === 'en' || label === null)), word);
});

for (const [name, minRecall, minPrecision] of [['dev', 0.97, 0.99], ['heldout', 0.97, 0.99], ['blind', 0.92, 0.97]]) {
  test(`short lines, ${name} set: no English line is ever called another language; non-English recall at least ${minRecall * 100}%, precision at least ${minPrecision * 100}%`, () => {
    const {per, englishAsForeign} = score(SETS[name]);
    assert.deepEqual(englishAsForeign, [], 'English (or nothing) called another language');
    const all = foreign(per);
    assert.ok(all.right / all.lines >= minRecall, `recall ${(100 * all.right / all.lines).toFixed(1)}%`);
    assert.ok(all.calledRight / all.called >= minPrecision, `precision ${(100 * all.calledRight / all.called).toFixed(1)}%`);
  });
}

test('the five big European languages are called reliably on short lines, in every set together', () => {
  const {per} = score([...SETS.dev, ...SETS.heldout, ...SETS.blind]);
  for (const language of ['fr', 'it', 'es', 'de', 'pt']) {
    assert.ok(per[language].lines >= 30, language + ' has enough lines');
    assert.ok(per[language].right / per[language].lines >= 0.93, `${language} recall ${(100 * per[language].right / per[language].lines).toFixed(1)}%`);
    assert.ok(per[language].calledRight / per[language].called >= 0.98, `${language} precision`);
  }
});

test('every language Voxtral TTS 3 lists, and every language the mod\'s interface ships in, is detected on at least one line', () => {
  const rows = [...SETS.dev, ...SETS.heldout, ...SETS.blind];
  const detected = new Set(rows.filter(([text, label]) => label && detectLanguage(text).language === label).map(([, label]) => label));
  for (const language of [...VOXTRAL_TTS3_LANGUAGES, ...MOD_LANGUAGES]) assert.ok(detected.has(language), language);
});

test('the live finding: "Combien de temps encore ?" and the other short lines that returned no language', () => {
  for (const [text, language] of [['Combien de temps encore ?', 'fr'], ['Siamo quasi arrivati?', 'it'], ['Tu viens avec moi ?', 'fr'], ['Non capisco niente', 'it'],
    ['No entiendo nada', 'es'], ['¿Cuánto falta?', 'es'], ['Wie lange noch?', 'de'], ['Ich bin müde', 'de'], ['Quanto tempo falta agora?', 'pt'],
    ['Hoe lang nog?', 'nl'], ['Merci', 'fr'], ['Danke schön', 'de'], ['Hola', 'es'], ['Grazie mille', 'it'], ['Obrigado', 'pt']])
    assert.equal(detectLanguage(text).language, language, text);
});

test('Night City names, slang, nicknames, acronyms, numbers and emoji never make a language', () => {
  for (const text of ['choom', 'preem gig choom', 'Jackie', 'Misty', 'Arasaka', 'Afterlife tonight?', 'nova ride Delamain', 'gonk move Jackie', 'eddies', 'V',
    'CET', 'ETA?', 'LOL', 'NPC', '123', '...', '👍', '[Microphone]', '{joy}', '', '   ', 'ok', 'lol', 'hmm', 'yo', 'thx']) {
    const language = detectLanguage(text).language;
    assert.ok(language === null || language === 'en', `${JSON.stringify(text)} -> ${language}`);
  }
  for (const text of ['hey hermano what\'s up', 'thanks amigo see you', 'ok chica let\'s go', 'sayonara see you later', 'Ay chica, let\'s go',
    'gracias for the lift bro', 'hola, I\'m running late', 'oh la la that is expensive', 'Misty\'s shop is closed', 'sell me some eddies'])
    assert.notEqual(isNonEnglish(text), true, text);
  // A sentence that is Spanish stays Spanish with a Night City word in it.
  assert.equal(detectLanguage('¿Qué pasa, choom?').language, 'es');
  assert.equal(detectLanguage('Hé choom, tu viens ?').language, 'fr');
});

test('English stays English: contractions, possessives, short replies and a word it shares with French', () => {
  for (const text of ['let\'s ride', 'don\'t stop', 'I\'m heading out now', 'Misty\'s shop', 'who are you', 'no problem', 'Mature content', 'follow route',
    'the plan is on', 'a CET', 'one more minute', 'Hi Jackie'])
    assert.notEqual(isNonEnglish(text), true, text);
  assert.equal(detectLanguage('how long until we get there').language, 'en');
  assert.equal(detectLanguage('are we there yet').language, 'en');
});

test('Cyrillic tells Ukrainian from Russian by letters, then by words; Vietnamese and Romanian are found by their marks', () => {
  assert.equal(detectLanguage('Скільки ще їхати?').language, 'uk');
  assert.equal(detectLanguage('Дякую за допомогу').language, 'uk');
  assert.equal(detectLanguage('Сколько еще ехать?').language, 'ru');
  assert.equal(detectLanguage('Я не понимаю').language, 'ru');
  assert.equal(detectLanguage('Còn bao lâu nữa?').language, 'vi');
  assert.equal(detectLanguage('Cât mai e până acolo?').language, 'ro');
});

test('one call is cheap and the result is reused for the same text (the turn asks about it several times)', () => {
  const text = 'Combien de temps encore ?';
  assert.equal(detectLanguage(text), detectLanguage(text));
  const lines = SETS.blind.map(([line]) => line);
  const start = process.hrtime.bigint();
  let calls = 0;
  for (let round = 0; round < 20; round++) for (const line of lines) { detectLanguage(line + ' ' + round); calls++; }
  const microseconds = Number(process.hrtime.bigint() - start) / 1000 / calls;
  // Measured at 20 to 60 microseconds on a laptop; the bound only catches an accidental model call or a per-call rebuild of the lists.
  assert.ok(microseconds < 1000, `${microseconds.toFixed(0)} us per call`);
  // A long reply (about 1,200 characters) is a quarter of a millisecond, not a stall.
  const reply = 'Claro que sí, V. Vamos al bar de Lizzie esta noche y hablamos con calma de todo lo que pasó. '.repeat(13);
  const started = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) detectLanguage(reply + i);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 / 50 < 5);
  assert.equal(detectLanguage(reply).language, 'es');
});
